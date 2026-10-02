import {existsSync}from "node:fs"
import {G1_23_75_ID,G1_23_75_MODEL,G1_23_75_REVISION} from "./g1-23-75.ts"
import {adoptLocalG1Policy} from "./g1-local-policy.ts"
import {verifyRegisteredPolicyFiles} from './local-policy-source.ts'
import {requirePolicyRuntime,type PolicyRuntimeConfig} from './runtime.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asObject, hashFile, policyDirectory, policyFile, policyId, policyRevision, type PolicyManifest, type PolicySource } from './source.ts'
import { adapterDownloadFiles, checkWeights, declaredAssetEntries, IMPLEMENTED_POLICY_ADAPTERS, packModeOf, readObjectOrNull, resolveAssetEntry, resolvePackRoute, type PackIssue, type PackRoute } from './pack-contract.ts'
import { packModelId } from './pack-source.ts'

/**
 * 包的 (来源, pin, 适配器) 台账**只有一份**：`pack-contract.ts` 的 `IMPLEMENTED_POLICY_ADAPTERS`
 * （内容侧判 adapterReady、客户端判路由都用它）。这里按适配器 id 取用，不再各存一套常量对账。
 */
const adapterPin = (id: string) => {
  const entry = IMPLEMENTED_POLICY_ADAPTERS.find((row) => row.id === id)
  if (!entry) throw new Error(`POLICY_ADAPTER_UNREGISTERED: ${id}`)
  return entry
}
/**
 * 「权重不在本机」时给出的**取件计划**：来源坐标 + 适配器登记的必需件 + 那一条 `policy_download({…})` 命令。
 *
 * 命令行是构造出来的**结构化参数**（不是拼给人看的说明文案）：测试直接对 `files` 做覆盖断言——
 * 少了任何一件，命令就在真实来源清单上选不中（`POLICY_FILE_NOT_IN_SOURCE`）或取不全。
 * 不含 `files` 的老命令只能取到产品默认的 README.md/config.json，权重一件都取不回来：那样的"下一步"
 * 是不可执行的（独立验收 REVIEW_PENDING 16）。
 */
export const weightsFetchPlan = (resolution: { provider: string; modelId: string; revision: string }, adapterId: string) => {
  const entry = adapterPin(adapterId)
  if (entry.modelId !== resolution.modelId || entry.revision !== resolution.revision) throw new Error(`POLICY_ADAPTER_SOURCE_MISMATCH: ${adapterId} 登记 ${entry.modelId}@${entry.revision}，路由来源是 ${resolution.modelId}@${resolution.revision}`)
  const files = adapterDownloadFiles(entry)
  return {
    adapterId, provider: resolution.provider, modelId: resolution.modelId, revision: resolution.revision, files,
    command: `policy_download({provider:"${resolution.provider}",modelId:"${resolution.modelId}",revision:"${resolution.revision}",files:[${files.map(file => `"${file}"`).join(',')}]})`,
  }
}
/** LIBERO×SmolVLA 是 bench 链的 HF 来源（不属于任何能力包的 policy 面），其 pin 只有这一处。 */
export const LIBERO_SMOLVLA_ID = 'k1000dai/smolvla_libero_finetune'
export const LIBERO_SMOLVLA_REVISION = '492ac1c5f1b7808c444fae37b75a84fdeb15e70d'
const here = dirname(fileURLToPath(import.meta.url))
export const pythonPath = (configured?: string, adapterId?:string) => configured ?? process.env.LYAPUNOV_POLICY_PYTHON ?? (adapterId===G1_23_75_ID&&existsSync(resolve(here,'../../../.runtime/policy-python/bin/python'))?resolve(here,'../../../.runtime/policy-python/bin/python'):process.env.LYAPUNOV_MUJOCO_PYTHON ?? resolve(here, '../../../.runtime/sim-python/bin/python'))
export interface PolicyIdentity { modelId: string; revision?: string; provider?: PolicySource }
export interface PolicyPrepareInput extends PolicyIdentity { robotModelPath?: string; weightsPath?: string }
export interface PreparedAdapter {
  adapter: string; robot: string; engine: string; modelPath: string; modelSourcePath: string; weightsPath: string
  config: Record<string, any>; jointNames: string[]; unit: string; controlMode: string; frequencyHz: number
  /** observations 基础契约（prepare_go2/unitree/wtw 共同形状）之外，WTW 两段式（`inference:'torchscript-adaptation'`）
   *  声明自定义观测契约字段——execution.ts twoStage 通路逐字段解引用（见 validatePreparedAdapter 的缺字段行为）。 */
  observations: {
    type: string; shape: number[]; order: string[]; quaternion: string; phasePeriodS?: number
    inference?: 'torchscript-adaptation'; frameDimension?: number; historyFrames?: number; previousActions?: number; clockInputs?: number
    commandDimension?: number; gaitCommandScale?: number[]; gait?: Record<string, number>; adaptationWeightsPath?: string
  }
  inferenceFormat?: 'torchscript' | 'onnx'; supportedEngines?: string[]; modelJointNames?: string[]; modelActuatorNames?: string[]; rootBody?: string
  /** adaptation_module 权重（WTW；与 observations.adaptationWeightsPath 同源，两处都保留以兼容既有读法） */
  adaptationWeightsPath?: string
  modelSha256: string; sourceRevision: string; sourceModelId: string; sourceProvider: PolicySource
  physicsPreserved: string[]; gravityCompensation: boolean
}
/** SmolVLA×LIBERO 的 VLA 适配契约：只描述 bench 链的动作/观测语义与派生权重，不进 Go1/WTW 的 execution.ts。 */
export interface LiberoVlaAdapter {
  adapter: string; policyType: string; weightsFile: string
  modelPath: string; weightsPath: string; modelSourcePath: string
  tensorCount: number; actionDim: number; controlMode: string
  controlSemantics: Record<string, unknown>; frequencyHz: number
  task: Record<string, unknown>
  observations: { keys: string[]; images: Record<string, Record<string, unknown>>; state: Record<string, unknown>; normalization: Record<string, any> }
  inferenceFormat: Record<string, unknown>
  modelSha256: string; sourceRevision: string; sourceModelId: string; sourceProvider: PolicySource
}
/** prepare_* 脚本 stdout 消费时打的身份戳（与 manifest 对齐，matchPolicy 按此核对来源）。 */
export interface AdapterIdentity { resolvedRevision: string; modelId: string; provider: PolicySource }
const adapterContractError = (paths: string[]) => new Error('ADAPTER_CONTRACT_MISMATCH: ' + paths.join(', '))
const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const parseAdapterStdout = (stdout: string) => { try { return JSON.parse(stdout) } catch { throw new Error('ADAPTER_STDOUT_NOT_JSON: prepare_* 脚本 stdout 必须是单个 JSON 对象') } }
/** PreparedAdapter stdout 契约校验（缺字段/错型 ⇒ `ADAPTER_CONTRACT_MISMATCH` 逐路径点名，不再落到
 *  hashFile(undefined) 之类的晚期崩溃）。必填＝接口必填字段 + 执行链（execution.ts/match.ts）实际解引用的字段；
 *  可选字段缺省保持原行为。WTW 两段式自定义契约（`observations.inference==='torchscript-adaptation'`）逐字段核对。 */
export function validatePreparedAdapter(raw: unknown): PreparedAdapter {
  const a = asObject(raw), bad: string[] = []
  for (const key of ['adapter', 'robot', 'engine', 'modelPath', 'modelSourcePath', 'weightsPath', 'unit', 'controlMode']) if (!isNonEmptyString(a[key])) bad.push(key)
  if (!isFiniteNumber(a.frequencyHz) || a.frequencyHz <= 0) bad.push('frequencyHz')
  if (!Array.isArray(a.physicsPreserved) || !a.physicsPreserved.every(isNonEmptyString)) bad.push('physicsPreserved')
  if (typeof a.gravityCompensation !== 'boolean') bad.push('gravityCompensation')
  const joints = Array.isArray(a.jointNames) && a.jointNames.every(isNonEmptyString) ? a.jointNames as string[] : undefined
  if (!joints?.length) bad.push('jointNames')
  const c = asObject(a.config)
  if (!isFiniteNumber(c.simulation_dt) || c.simulation_dt <= 0) bad.push('config.simulation_dt')
  if (!Number.isInteger(c.control_decimation) || c.control_decimation <= 0) bad.push('config.control_decimation')
  if (!Number.isInteger(c.num_obs) || c.num_obs <= 0) bad.push('config.num_obs')
  if (!Number.isInteger(c.num_actions) || c.num_actions <= 0) bad.push('config.num_actions')
  if (!Array.isArray(c.default_angles) || !c.default_angles.every(isFiniteNumber)) bad.push('config.default_angles')
  else if (joints && c.default_angles.length !== joints.length) bad.push('config.default_angles[长度≠jointNames]')
  const o = asObject(a.observations)
  if (!isNonEmptyString(o.type)) bad.push('observations.type')
  if (!Array.isArray(o.shape) || !o.shape.every(isFiniteNumber)) bad.push('observations.shape')
  if (!Array.isArray(o.order) || !o.order.every(isNonEmptyString)) bad.push('observations.order')
  if (!isNonEmptyString(o.quaternion)) bad.push('observations.quaternion')
  if (o.inference !== undefined) {
    if (o.inference !== 'torchscript-adaptation') bad.push('observations.inference')
    if (!Number.isInteger(o.frameDimension) || o.frameDimension <= 0) bad.push('observations.frameDimension')
    if (!Number.isInteger(o.historyFrames) || o.historyFrames <= 0) bad.push('observations.historyFrames')
    if (!Number.isInteger(o.commandDimension) || o.commandDimension <= 0) bad.push('observations.commandDimension')
    if (!Array.isArray(o.gaitCommandScale) || o.gaitCommandScale.length !== o.commandDimension || !o.gaitCommandScale.every(isFiniteNumber)) bad.push('observations.gaitCommandScale')
    if (!isNonEmptyString(o.adaptationWeightsPath)) bad.push('observations.adaptationWeightsPath')
    const gait = asObject(o.gait)
    // execution.ts wtwObservationFrame 逐个解引用的 12 个步态命令槽（deploy get_command() 语义）
    for (const key of ['bodyHeightOffsetM', 'frequencyHz', 'phase', 'offset', 'bound', 'durationS', 'footswingHeightM', 'bodyPitchRad', 'bodyRollRad', 'stanceWidthM', 'stanceLengthM', 'auxRewardCoef']) if (!isFiniteNumber(gait[key])) bad.push('observations.gait.' + key)
  }
  if (bad.length) throw adapterContractError(bad)
  return a as unknown as PreparedAdapter
}
/** LiberoVlaAdapter stdout 契约校验（prepare_libero_vla.py 的 7 维 OSC delta 契约形状）。 */
export function validateLiberoVlaAdapter(raw: unknown): LiberoVlaAdapter {
  const a = asObject(raw), bad: string[] = []
  for (const key of ['adapter', 'policyType', 'weightsFile', 'modelPath', 'weightsPath', 'modelSourcePath', 'controlMode']) if (!isNonEmptyString(a[key])) bad.push(key)
  if (!Number.isInteger(a.tensorCount) || a.tensorCount < 0) bad.push('tensorCount')
  if (!Number.isInteger(a.actionDim) || a.actionDim <= 0) bad.push('actionDim')
  if (!isFiniteNumber(a.frequencyHz) || a.frequencyHz <= 0) bad.push('frequencyHz')
  if (!isRecord(a.controlSemantics)) bad.push('controlSemantics')
  if (!isRecord(a.task)) bad.push('task')
  if (!isRecord(a.inferenceFormat)) bad.push('inferenceFormat')
  const o = asObject(a.observations)
  if (!Array.isArray(o.keys) || !o.keys.every(isNonEmptyString)) bad.push('observations.keys')
  for (const key of ['images', 'state', 'normalization']) if (!isRecord(o[key])) bad.push('observations.' + key)
  if (bad.length) throw adapterContractError(bad)
  return a as unknown as LiberoVlaAdapter
}
/** 消费 PreparedAdapter stdout（prepare_go2/prepare_unitree/prepare_wtw 共用）：契约校验→身份戳→modelSha256。 */
export async function consumePreparedAdapter(stdout: string, source: AdapterIdentity): Promise<PreparedAdapter> {
  const adapter = validatePreparedAdapter(parseAdapterStdout(stdout))
  adapter.sourceRevision = source.resolvedRevision; adapter.sourceModelId = source.modelId; adapter.sourceProvider = source.provider
  adapter.modelSha256 = (await hashFile(adapter.modelPath)).sha256
  return adapter
}
/** 消费 SmolVLA×LIBERO stdout（prepare_libero_vla.py）：契约校验→身份戳→modelSha256（派生权重哈希）。 */
export async function consumeLiberoVlaAdapter(stdout: string, source: AdapterIdentity): Promise<LiberoVlaAdapter> {
  const adapter = validateLiberoVlaAdapter(parseAdapterStdout(stdout))
  adapter.sourceRevision = source.resolvedRevision; adapter.sourceModelId = source.modelId; adapter.sourceProvider = source.provider
  adapter.modelSha256 = (await hashFile(adapter.modelPath)).sha256
  return adapter
}
/** derived/adapter.json 有两种形状：PreparedAdapter（关节级执行适配）与 LiberoVlaAdapter（bench 链 VLA 契约）；
 *  消费方必须判别后再解引用（缺字段不再以 TypeError 形式爆出）。 */
export const isPreparedAdapter = (value: unknown): value is PreparedAdapter =>
  isRecord(value) && Array.isArray(value.jointNames) && isRecord(value.config) && isRecord(value.observations) && isFiniteNumber(value.frequencyHz)
export const isLiberoVlaAdapter = (value: unknown): value is LiberoVlaAdapter =>
  isRecord(value) && isNonEmptyString(value.policyType) && isFiniteNumber(value.actionDim) && !Array.isArray(value.jointNames)
export async function verifyPolicy(directory: string, input: PolicyIdentity) {
  const provider=input.provider ?? 'modelscope', root=policyDirectory(directory, provider, input.modelId, input.revision ?? 'master')
  let manifest: PolicyManifest
  try { manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8')) } catch(error) { return {valid:false,status:'MISSING',root,checks:[],error:String(error)} }
  const checks=[] as Array<Record<string,unknown>>
  for (const file of Array.isArray(manifest.files)?manifest.files:[]) {
    try { const path=policyFile(file.path), actual=await hashFile(join(root,path), file.gitBlob?file.bytes:undefined); checks.push({path,...actual,...(file.sha256===undefined?{}:{expected:file.sha256}),valid:actual.sha256===file.sha256 && actual.bytes===file.bytes && (!file.gitBlob || file.gitBlob===actual.gitBlob)}) }
    catch(error){checks.push({path:String(file?.path??file),valid:false,error:String(error)})}
  }
  return {valid:manifest.status==='DOWNLOADED' && manifest.provider===provider && manifest.modelId===input.modelId && manifest.revision===(input.revision??'master') && checks.length>0 && checks.every(x=>x.valid), status:manifest.status,manifest,root,checks}
}
/** packs 源的本地缓存根：`<data>/policies/packs/packs__<packId>`（downloadPack 的 policyDirectory 同族布局）。 */
const packCacheDirectory = (directory: string, modelId: string) => join(resolve(directory), 'policies', 'packs', policyId(modelId).replace('/', '__'))

/**
 * 定位本地已取到的包快照。revision 给定时只看那一次 mount；否则按 manifest.updatedAt 取**最近一次 DOWNLOADED**
 * 的 mount 快照（packs 的 revision 由服务端 open 定夺，调用方不总是知道它）。都没有 ⇒ 明确 PACK_NOT_DOWNLOADED。
 */
async function resolveDownloadedPack(directory: string, input: PolicyPrepareInput) {
  const { modelId: id, packId } = packModelId(input.modelId)
  const base = packCacheDirectory(directory, id)
  const names: string[] = []
  if (input.revision !== undefined) names.push(policyRevision(input.revision))
  else {
    let entries: string[] = []
    try { entries = await readdir(base) } catch { entries = [] }
    const stamps = await Promise.all(entries.filter((name) => /^[A-Za-z0-9_.-]{1,128}$/.test(name)).map(async (name) => {
      const manifest = await readObjectOrNull(join(base, name, 'manifest.json'))
      return { name, status: String(manifest?.status ?? ''), updatedAt: String(manifest?.updatedAt ?? '') }
    }))
    names.push(...stamps.filter((stamp) => stamp.status === 'DOWNLOADED').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((stamp) => stamp.name))
    if (!names.length) names.push(...stamps.map((stamp) => stamp.name))
    if (!names.length) names.push('master')
  }
  for (const name of names) {
    const root = join(base, name)
    const manifest = await readObjectOrNull(join(root, 'manifest.json'))
    if (manifest && manifest.status === 'DOWNLOADED') return { packId, revision: name, root, mountId: String(manifest.resolvedRevision ?? '') }
  }
  throw new Error(`PACK_NOT_DOWNLOADED: 本地无 packs/${packId} 的已下载快照（先 policy_download provider="packs" modelId="packs/${packId}"）`)
}

/**
 * 包内 asset 里给已登记适配器用的机器人模型：WTW 走 menagerie 目录（`<dir>/go1.xml`），其余走**机器人 MJCF**。
 *
 * 这里刻意不用 `findModelEntry` 的模型入口：那个入口是给 `scene_import` 的（scene 优先，带地面/光照/相机），
 * 而 `prepare_go2.py` 直接 `ET.parse` 传进来的文件并要求「本文件自带 12 个 actuator」——`scene.xml` 是
 * `<include>` 存根，喂进去必然 `GO2_MJCF_EXPECTED_12_ACTUATORS`。两者用途不同，取件根里都必须取对。
 */
async function packRobotModelPath(packRoot: string, adapterId: string, robotEntry: string | null) {
  if (adapterId === 'wtw-go1-torchscript-v1') {
    const menagerie = join(packRoot, 'asset', 'menagerie')
    try { (await readdir(menagerie)).length; return menagerie } catch { return resolve(robotEntry ?? join(packRoot, 'asset')) }
  }
  return robotEntry ? resolve(robotEntry) : undefined
}

/**
 * `provider=packs` 的装配与执行路由（defect-① 的根因修复：旧实现走到最后一行无条件抛
 * `POLICY_ADAPTER_UNAVAILABLE`，于是**所有**能力包都无法装配）。
 *
 * 三条互不混淆的路由：
 *  - `direct-control`：直控包**绝不需要权重**——返回模型入口/依赖/观测动作语义/直控通道与执行链；
 *  - `policy-source`：基础策略包委托给**代码侧已登记**的适配器（Go2 ONNX / G1 12DOF / Go1 WTW），
 *    机器人模型取**本包 asset**（派生件因此与包内 MJCF 同源），权重仍从登记来源取件并落该来源缓存；
 *  - `server-side-inference` / `unavailable`：服务端推理无已见实现、适配器未移植、外部控制器未集成时
 *    **如实抛出**（错误码与原因原样来自共用判据 resolvePackRoute，不假装 ready）。
 */
async function preparePackPolicy(directory: string, input: PolicyPrepareInput, python?: string|PolicyRuntimeConfig): Promise<Record<string, any>> {
  const picked = await resolveDownloadedPack(directory, input)
  const verified = await verifyPolicy(directory, { provider: 'packs', modelId: input.modelId, revision: picked.revision })
  if (!verified.valid || !verified.manifest) throw new Error('POLICY_FILES_NOT_VERIFIED: ' + JSON.stringify(verified.checks.filter((x) => !x.valid)))
  const packPolicy = await readObjectOrNull(join(picked.root, 'policy', 'manifest.json'))
  if (!packPolicy) throw new Error('PACK_POLICY_MANIFEST_NOT_DELIVERED: 本次取件未含 policy 件（pieces 需含 "policy"）')
  const packFile = await readObjectOrNull(join(picked.root, 'pack.json'))
  const vla = await readObjectOrNull(join(picked.root, 'vla', 'adapter.json'))
  // 模型入口按**包内显式登记**解析到**本次已校验缓存根下的绝对路径**（review 项⑪：相对路径交出去
  // 等于把"准备成功"交成不可用的东西）。解析即复核：parseAsset 走一遍 XML/依赖闭包，坏件当场抛。
  const assets = declaredAssetEntries(packFile)
  const resolveEntry = async (relativeEntry: string) => {
    try { return (await resolveAssetEntry(picked.root, relativeEntry)).path }
    catch (error) { throw new Error(`PACK_MODEL_ENTRY_INVALID: ${relativeEntry}｜${(error as Error).message}`) }
  }
  const modelEntry = assets ? await resolveEntry(assets.modelEntry) : null
  const issues: PackIssue[] = []
  const weights = await checkWeights(picked.root, packPolicy.weights, issues)
  const { route, issues: routeIssues } = resolvePackRoute({
    packId: picked.packId, mode: packModeOf(packPolicy.mode), adapter: typeof packPolicy.adapter === 'string' ? packPolicy.adapter : null,
    weights, deps: packPolicy.deps, inference: asObject(packPolicy.inference) as Record<string, unknown>,
    capabilities: asObject(packFile?.capabilities) as Record<string, unknown>,
    observations: asObject(vla?.observation) as Record<string, unknown>, actions: asObject(vla?.action ?? packPolicy.action) as Record<string, unknown>,
    modelEntry, controlPath: typeof vla?.controlPath === 'string' ? vla.controlPath : typeof packPolicy.notes === 'string' ? packPolicy.notes : null,
  })
  issues.push(...routeIssues)
  const provenance = { packId: picked.packId, modelId: input.modelId, revision: picked.revision, mountId: picked.mountId, assetModelEntry: assets?.modelEntry ?? null, modelPath: modelEntry }
  if (route.kind === 'unavailable') {
    throw new Error(`${route.code}: ${route.detail}｜${route.nextSteps.join('；')}｜已核 issue: ${issues.map((issue) => `${issue.code}@${issue.path}`).join(',') || '无'}`)
  }
  if (route.kind === 'direct-control') {
    // 直控：不构造也不读取任何权重/适配器派生件——执行走引擎直控通道。但模型入口是**必需**的：
    // 交不出可加载的绝对路径就不要说"准备成功"。
    if (!modelEntry) throw new Error(`PACK_MODEL_ENTRY_UNDECLARED: 包内未登记 asset.modelEntry，直控路由无法给出可加载的模型路径（已核 issue: ${issues.map((issue) => `${issue.code}@${issue.path}`).join(',') || '无'}）`)
    return {
      status: 'PACK_DIRECT_CONTROL', route, provenance, weightsRequired: false,
      modelEntry: route.modelEntry, deps: route.deps, channels: route.channels,
      observations: route.observations, actions: route.actions, controlPath: route.controlPath,
      components: route.modelEntry ? { mujoco: { sourcePath: route.modelEntry } } : {},
      executionRoute: { chain: ['scene_import(route.modelEntry)', 'sim_open', 'robot_load', 'robot_describe(核对关节/限位/通道)', `直控通道下发(${route.channels.join('/') || '见 actions.channelsUsed'})`, 'robot_stop(核对保持)'], channels: route.channels },
      nextSteps: route.nextSteps,
    }
  }
  if (route.kind !== 'policy-source') {
    // 服务端推理已登记实现时才会到这（当前 IMPLEMENTED_SERVER_SIDE_INFERENCE 为空 ⇒ 走不到），保持显式不静默。
    return { status: 'PACK_SERVER_SIDE_INFERENCE', route, provenance, weightsRequired: false, nextSteps: route.nextSteps }
  }
  const entry = route.source
  // 委派适配器要的是**机器人本体文件**（`asset.model`，包内显式登记；缺省与导入入口同值）——与产品
  // 导入入口（可能是含地面/光照的 scene）分开取，两者都由内容侧登记、不在客户端猜。
  const robotModelPath = await packRobotModelPath(picked.root, route.adapterId, assets ? await resolveEntry(assets.model) : null)
  /**
   * 委托已登记适配器。权重还没落到本机缓存时，抛出的 `POLICY_FILES_NOT_VERIFIED` 对用户不是可执行的
   * 说明——这里补上**来源坐标**与**完整参数的那一条取件命令**（面板/Agent 原样显示即可照做），
   * 不把泛型校验失败当成唯一解释。文件清单来自适配器自己登记的 `requires`（`pack-contract.ts` 的同一份台账），
   * 所以这条命令取回的正是装配/执行要用的件：默认 `files`（README.md/config.json）取不回任何权重。
   * 其余错误（如 ADAPTER_CONTRACT_MISMATCH）原样上抛。
   */
  let delegated: Record<string, any>
  try {
    delegated = await preparePolicy(directory, { provider: entry.provider as PolicySource, modelId: entry.modelId, revision: entry.revision, ...(robotModelPath ? { robotModelPath } : {}) }, python)
  } catch (error) {
    const message = String((error as Error)?.message ?? error)
    if (!message.startsWith('POLICY_FILES_NOT_VERIFIED')) throw error
    const plan = weightsFetchPlan(entry, route.adapterId)
    throw new Error(`POLICY_WEIGHTS_NOT_CACHED: 权重未在本机缓存，装配无法继续（来源 ${entry.provider}:${entry.modelId}@${entry.revision}）｜先执行 ${plan.command} 取回权重（适配器 ${plan.adapterId} 登记的必需件，共 ${plan.files.length} 项），再重试 policy_prepare｜${message}`)
  }
  const adapter = asObject((delegated as any).adapter) as unknown as PreparedAdapter
  const derivedPath = join(picked.root, 'derived', 'adapter.json')
  // 身份戳按**本次取件的包快照**写（matchPolicy 与 manifest.modelId/resolvedRevision 逐项对账），
  // 上游来源（github 仓 + pin）原样留在 packProvenance.upstream —— 不是丢弃来源，是不让两套身份互相冒充：
  // 旧实现把上游 sourceModelId 直接落在包派生件上，matchPolicy 永远 ADAPTER_SOURCE_MISMATCH。
  const withProvenance = {
    ...adapter,
    sourceModelId: input.modelId,
    sourceRevision: picked.mountId,
    sourceProvider: 'packs',
    packProvenance: {
      ...provenance, adapterId: route.adapterId, robotModelPath: robotModelPath ?? null,
      weightsSource: entry, weightsBytesUnpacked: !weights?.bundled,
      upstream: { modelId: adapter.sourceModelId, revision: adapter.sourceRevision, provider: adapter.sourceProvider },
    },
  }
  await mkdir(dirname(derivedPath), { recursive: true })
  await writeFile(derivedPath, JSON.stringify(withProvenance, null, 2) + '\n')
  return { ...delegated, status: 'PREPARED', route, provenance, adapter: withProvenance, path: derivedPath }
}

export async function preparePolicy(directory:string,input:PolicyPrepareInput,python?:string|PolicyRuntimeConfig):Promise<Record<string, any>> {
  if (input.provider === 'packs') return preparePackPolicy(directory, input, python)
  const isG1=input.provider==='github'&&input.modelId===G1_23_75_MODEL&&input.revision===G1_23_75_REVISION
  if(input.weightsPath){if(!isG1)throw new Error('POLICY_LOCAL_REUSE_SOURCE_UNSUPPORTED');await adoptLocalG1Policy(directory,input.weightsPath)}
  const verified=await verifyPolicy(directory,input)
  if(!verified.valid || !verified.manifest) throw new Error('POLICY_FILES_NOT_VERIFIED: '+JSON.stringify(verified.checks.filter(x=>!x.valid)))
  const m=verified.manifest
  const sourceChecks=await verifyRegisteredPolicyFiles(verified.root,{provider:m.provider,modelId:m.modelId,revision:m.resolvedRevision})
  if(sourceChecks.some(c=>!c.valid))throw new Error('POLICY_ADAPTER_SOURCE_MISMATCH: 固定来源必需件不符 '+sourceChecks.filter(c=>!c.valid).map(c=>c.path).join('、'))
  const registered=IMPLEMENTED_POLICY_ADAPTERS.find(row=>m.provider==='github'&&row.modelId===m.modelId&&row.revision===m.resolvedRevision)
  const libero=m.provider==='huggingface'&&m.modelId===LIBERO_SMOLVLA_ID&&m.resolvedRevision===LIBERO_SMOLVLA_REVISION
  if(!registered&&!libero)throw Error('POLICY_ADAPTER_UNAVAILABLE: 当前来源尚无具备动作与观测语义的执行适配器')
  const runtime=await requirePolicyRuntime(typeof python==='string'?{pythonPath:python}:python??{},registered?.id??'libero-smolvla-v1')
  if(registered?.id===G1_23_75_ID){
    if(!input.robotModelPath)throw new Error('POLICY_ROBOT_MODEL_REQUIRED: 75适配器必须指定当前23机器人MJCF；不会替换模型')
    const pin=adapterPin(G1_23_75_ID)
    for(const path of pin.requires.files)if(!m.files.some(f=>f.path===path))throw new Error('POLICY_ADAPTER_SOURCE_MISSING: '+path)
    const {stdout}=await promisify(execFile)(runtime.python,[join(here,'../python/prepare_g1_23_75.py'),verified.root,resolve(input.robotModelPath)],{env:{...process.env,CUDA_VISIBLE_DEVICES:'',PYTHONDONTWRITEBYTECODE:'1'},maxBuffer:2*1024*1024})
    const adapter=await consumePreparedAdapter(stdout,{resolvedRevision:m.resolvedRevision,modelId:m.modelId,provider:m.provider})
    const path=join(verified.root,'derived','adapter.json');await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(adapter,null,2)+'\n')
    return {status:'PREPARED',runtime,adapter,path,worldOptions:{clock:'manual',timestepS:.005,ground:adapter.config.has_own_static_plane!==true},components:{mujoco:{sourcePath:adapter.modelPath,rootBody:adapter.rootBody,initialJointPositions:Object.fromEntries(adapter.jointNames.map((name,i)=>[name,adapter.config.default_angles[i]]))},controller:{robot:adapter.robot,policyAdapter:adapter.adapter,frequencyHz:50,controlMode:'position',controlSemantics:'position_pd',nativePositionPD:{revision:G1_23_75_REVISION,weightsSha256:adapter.config.weights_sha256},jointKp:Object.fromEntries(adapter.jointNames.map((name,i)=>[name,adapter.config.kps[i]])),jointKd:Object.fromEntries(adapter.jointNames.map((name,i)=>[name,adapter.config.kds[i]])),gravityCompensation:false},sensor:{policyObservations:adapter.observations}}}
  }
  const GO2 = adapterPin('inria-go2-onnx-v1')
  if(m.provider==='github'&&m.modelId===GO2.modelId&&m.resolvedRevision===GO2.revision){
    if(!input.robotModelPath)throw new Error('POLICY_ROBOT_MODEL_REQUIRED: robotModelPath 指向已导入的 Go2 MJCF 原件')
    for(const path of GO2.requires.files)if(!m.files.some(f=>f.path===path))throw new Error('POLICY_ADAPTER_SOURCE_MISSING: '+path)
    const output=join(verified.root,'derived','inria-go2-onnx-v1')
    const {stdout}=await promisify(execFile)(runtime.python,[join(here,'../python/prepare_go2.py'),verified.root,resolve(input.robotModelPath),output],{env:{...process.env,HF_ENDPOINT:'https://hf-mirror.com',CUDA_VISIBLE_DEVICES:''},maxBuffer:2*1024*1024})
    const adapter=await consumePreparedAdapter(stdout,{resolvedRevision:m.resolvedRevision,modelId:m.modelId,provider:m.provider})
    await writeFile(join(verified.root,'derived','adapter.json'),JSON.stringify(adapter,null,2)+'\n')
    return {status:'PREPARED',runtime,adapter,path:join(verified.root,'derived','adapter.json'),worldOptions:{clock:'manual',timestepS:adapter.config.simulation_dt,ground:true},components:{mujoco:{sourcePath:adapter.modelPath,rootBody:adapter.rootBody??'base',initialJointPositions:Object.fromEntries(adapter.jointNames.map((name,i)=>[name,adapter.config.default_angles[i]])),initialActuatorControls:Object.fromEntries((adapter.modelJointNames??adapter.jointNames).map((name,i)=>[adapter.modelActuatorNames?.[i]??name,adapter.config.default_angles[adapter.jointNames.indexOf(name)]]))},isaac:{sourcePath:adapter.modelPath,keyframe:adapter.config.initialKeyframe,initialJointPositions:Object.fromEntries(adapter.jointNames.map((name,i)=>[name,adapter.config.default_angles[i]]))},controller:{robot:adapter.robot,policyAdapter:adapter.adapter,frequencyHz:adapter.frequencyHz,controlMode:adapter.controlMode,gravityCompensation:false},sensor:{policyObservations:adapter.observations}}}
  }
  const WTW = adapterPin('wtw-go1-torchscript-v1')
  if(m.provider==='github'&&m.modelId===WTW.modelId&&m.resolvedRevision===WTW.revision){
    // Walk These Ways（Go1）：策略目录只带两个 TorchScript 与 parameters.pkl；动作/观测语义全部由 pkl +
    // WTW 源码确定（见 python/prepare_wtw.py 的注释与回执 Round 4/5）。物理模型是**本机资产**
    // `materials/robots/unitree_go1/menagerie/go1.xml`（menagerie 布局；WTW 自带的 xml/go1.xml 不是
    // MuJoCo 可解析的 XML），可用 input.robotModelPath 覆盖成任意等价的 Go1 MJCF。
    // `components.isaac` 与 `components.mujoco` 指向**同一份派生模型**（同路径 ⇒ match.ts:93 的
    // `components[world.engineId].sourcePath` 哈希判据在两个引擎上都成立），与 Go2 分支（:319）同一形状。
    // 键的取舍按**谁真读它**定：`scene_adapter.py:39` 命中 `components.isaac.sourcePath` 后 cfg 就是
    // `components.isaac` 本身（:44 那条 `{...components.mujoco,**cfg}` 合并只在没有 isaac 源时才走到），
    // 而 isaac 适配层实际读取的只有 `sourcePath`（`native_source`）与 `initialJointPositions`
    // （`scene_adapter.py:246` 覆盖 `joints[].home`，`worker.py:467` 用它设 Isaac articulation 的初始
    // DOF 位置/目标）。故这里给这两个键 + 同值的 `rootBody`（isaac 侧不读，只为两个组件对同一模型的
    // 声明一致）；**不写** `keyframe`（本派生件没有 WTW 专用关键帧，isaac 侧缺省名 `'home'` 就是源自带
    // 的关键帧）、**不写** `initialActuatorControls`（那是 MuJoCo 的 ctrl 初值通道，
    // `sim-mujoco/python/worker.py:996` 读它，isaac 侧无消费方）。
    // 这份组件**不改变** isaac 侧实际生效的 cfg：改动前走的是 `scene_adapter.py:44` 的
    // `{...components.mujoco}` 合并，其中 sourcePath/rootBody/initialJointPositions 三项逐字段相同
    // （P13 实测该实体在 Isaac 的初始 DOF = default_angles：`evidence/unitree_go1-isaac-5-before.json`）。
    const required=WTW.requires.files
    for(const path of required) if(!m.files.some(f=>f.path===path))throw new Error('POLICY_ADAPTER_SOURCE_MISSING: '+path)
    const model=resolve(input.robotModelPath??join(here,'../../../materials/robots/unitree_go1/menagerie'))
    const output=join(verified.root,'derived','wtw-go1-torchscript-v1')
    const {stdout}=await promisify(execFile)(runtime.python,[join(here,'../python/prepare_wtw.py'),verified.root,model,output],{env:{...process.env,CUDA_VISIBLE_DEVICES:''},maxBuffer:2*1024*1024})
    const adapter=await consumePreparedAdapter(stdout,{resolvedRevision:m.resolvedRevision,modelId:m.modelId,provider:m.provider})
    await writeFile(join(verified.root,'derived','adapter.json'),JSON.stringify(adapter,null,2)+'\n')
    return {status:'PREPARED',runtime,adapter,path:join(verified.root,'derived','adapter.json'),worldOptions:{clock:'manual',timestepS:adapter.config.simulation_dt,ground:true},components:{mujoco:{sourcePath:adapter.modelPath,rootBody:adapter.rootBody??'trunk',initialJointPositions:Object.fromEntries(adapter.jointNames.map((name,i)=>[name,adapter.config.default_angles[i]])),initialActuatorControls:Object.fromEntries((adapter.modelJointNames??adapter.jointNames).map((name,i)=>[adapter.modelActuatorNames?.[i]??name,adapter.config.default_angles[adapter.jointNames.indexOf(name)]]))},isaac:{sourcePath:adapter.modelPath,rootBody:adapter.rootBody??'trunk',initialJointPositions:Object.fromEntries(adapter.jointNames.map((name,i)=>[name,adapter.config.default_angles[i]]))},controller:{robot:adapter.robot,policyAdapter:adapter.adapter,frequencyHz:adapter.frequencyHz,controlMode:adapter.controlMode,gravityCompensation:false},sensor:{policyObservations:adapter.observations}}}
  }
  if(m.provider==='huggingface'&&m.modelId===LIBERO_SMOLVLA_ID&&m.resolvedRevision===LIBERO_SMOLVLA_REVISION){
    // SmolVLA×LIBERO（k1000dai/smolvla_libero_finetune @ HF commit 492ac1c…）：自包含检查点
    // （model.safetensors 506 张量含 SmolVLM2 全量 + flow 动作专家 + 归一化统计缓冲），动作＝官方
    // OSC_POSE 7 维归一化 delta，观测＝agentview+腕相机+8 维 state。本分支只产 `derived/adapter.json`
    // 契约（动作/观测/归一化统计/上采样口径/inferenceFormat，见 python/prepare_libero_vla.py）；
    // 执行走 bench 链（bench_load→bench_step→bench_result），不进 Go1/WTW 的 execution.ts 通路。
    // 腕相机每步在产品面不可得的替代口径声明在 adapter.json observations.images.wrist_image.substitution。
    for(const path of ['model.safetensors','config.json','train_config.json'])if(!m.files.some(f=>f.path===path))throw new Error('POLICY_ADAPTER_SOURCE_MISSING: '+path)
    const output=join(verified.root,'derived','libero-smolvla-v1')
    const {stdout}=await promisify(execFile)(runtime.python,[join(here,'../python/prepare_libero_vla.py'),verified.root,output],{env:{...process.env,HF_ENDPOINT:'https://hf-mirror.com',CUDA_VISIBLE_DEVICES:''},maxBuffer:2*1024*1024})
    const adapter=await consumeLiberoVlaAdapter(stdout,{resolvedRevision:m.resolvedRevision,modelId:m.modelId,provider:m.provider})
    await writeFile(join(verified.root,'derived','adapter.json'),JSON.stringify(adapter,null,2)+'\n')
    return {status:'PREPARED',runtime,adapter,path:join(verified.root,'derived','adapter.json'),executionRoute:{chain:'bench_prepare→bench_catalog→bench_load→bench_step→bench_result',action:'bench_step({kind:"control",values:[7],stepCount})',judge:'bench_result.terminationReason==="check_success"',taskId:(adapter.task as any)?.taskId,actionDim:adapter.actionDim,controlMode:adapter.controlMode}}
  }
  const G1 = adapterPin('unitree-g1-12dof-v1')
  if(m.provider!=='github'||m.modelId!==G1.modelId||m.resolvedRevision!==G1.revision) throw new Error('POLICY_ADAPTER_UNAVAILABLE: 当前来源尚无具备动作与观测语义的执行适配器')
  const required=G1.requires.files
  for(const path of required) if(!m.files.some(f=>f.path===path))throw new Error('POLICY_ADAPTER_SOURCE_MISSING: '+path)
  // mesh 逐个核对（比前缀更严）：XML 里声明的每一个 mesh 都必须在缓存里，前缀只是**取件命令**的表达方式。
  const meshPrefix = (G1.requires.prefixes ?? [])[0]
  if(!meshPrefix) throw new Error('POLICY_ADAPTER_REQUIRES_INCOMPLETE: '+G1.id+' 未登记 mesh 目录前缀')
  const xml=await readFile(join(verified.root,required.find(path=>path.endsWith('.xml'))!),'utf8')
  for(const match of xml.matchAll(/<mesh[^>]*file="([^"]+)"/g)) if(!m.files.some(f=>f.path===meshPrefix+'/'+match[1]))throw new Error('POLICY_MODEL_ASSET_MISSING: '+match[1])
  const output=join(verified.root,'derived','unitree-g1-12dof-v1')
  const {stdout}=await promisify(execFile)(runtime.python,[join(here,'../python/prepare_unitree.py'),verified.root,output],{env:{...process.env,HF_ENDPOINT:'https://hf-mirror.com',CUDA_VISIBLE_DEVICES:''},maxBuffer:2*1024*1024})
  const adapter=await consumePreparedAdapter(stdout,{resolvedRevision:m.resolvedRevision,modelId:m.modelId,provider:m.provider})
  await writeFile(join(output,'adapter.json'),JSON.stringify(adapter,null,2)+'\n')
  const c=adapter.config
  // isaac 组件与 mujoco 组件指向同一份派生模型，matchPolicy 的模型哈希检查因此对两个引擎都成立。
  // 只声明 sourcePath，不注入 initialJointPositions/keyframe：Isaac world 从模型自身 qpos0 起步
  // （pelvis z=0.793、12 关节角 0），与 MuJoCo 路径的初始状态一致，不写关节状态；第一个控制窗内
  // 策略本就命令 default_angles，与 MuJoCo 侧 initialActuatorControls 的语义对齐。
  return {status:'PREPARED',runtime,adapter,path:join(output,'adapter.json'),worldOptions:{clock:'manual',timestepS:c.simulation_dt,ground:true},components:{mujoco:{sourcePath:adapter.modelPath,rootBody:'pelvis',initialActuatorControls:Object.fromEntries(adapter.jointNames.map((name,i)=>[name,c.default_angles[i]]))},isaac:{sourcePath:adapter.modelPath},controller:{robot:adapter.robot,policyAdapter:adapter.adapter,frequencyHz:adapter.frequencyHz,controlMode:adapter.controlMode,gravityCompensation:false},sensor:{policyObservations:adapter.observations}}}
}
export async function readAdapter(root:string):Promise<PreparedAdapter|LiberoVlaAdapter|undefined> {
  for(const path of ['derived/adapter.json','derived/unitree-g1-12dof-v1/adapter.json'])try{return JSON.parse(await readFile(join(root,path),'utf8'))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  return undefined
}
