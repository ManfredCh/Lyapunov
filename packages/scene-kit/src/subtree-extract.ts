/**
 * RC v4 R-013／§2.10：MJCF/URDF **内部子树真实拆分**的源格式派生层。
 *
 * 只读预检 → 原生拆分（已安装 MuJoCo 3.13 MjSpec，经 `python/mjcf_subtree.py`）→ 两份派生件各自
 * 带完整资产闭包 → 在既有 `ResourceLibrary` 里登记为**具名派生**（remaining 是源资源 id 的新版本，
 * part 是新资源），不新建资源数据库、不搬动旧版本、不改源文件。
 *
 * 边界（明确不做的事）：
 *  · 不按 mesh 名或图上 link 名猜身份：结构事实全部来自原生枚举；
 *  · 不把"内存里 compile 通过"当成交付证据：两份派生件都是从**派生目录**重载核对过的；
 *  · 跨切口依赖（tendon/equality/actuator/sensor/contact-exclude/mimic/transmission）任一不能严格保全
 *    就整体拒绝，具体对象写进错误 details，Scene 与资源零提交。
 */
import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { ResourceRef } from '../../lyapunov-contracts/src/types.ts'
import type { RobotAnchorPose, RobotSubtreeDerivationRecord, RobotSubtreeNameMap, RobotSubtreePrecheckResult } from '../../lyapunov-contracts/src/robot-authoring.ts'
import { robotVisual } from './formats.ts'
import type { ResourceDerivation, ResourceLibrary, ResourceRecord } from './resources.ts'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

/**
 * 原生拆分 helper（`python/mjcf_subtree.py`）的定位口径，唯一一处。
 *
 * `subtree-extract.ts` 会被消费方**内联**进各自的 bundle：scene-kit 的调用点在
 * `packages/scene-kit/dist/plugin.js`，robot-tools 的 `robot_assembly_extract_precheck/extract/reassemble`
 * 注册也在自己的 `packages/robot-tools/dist/plugin.js`（Bun.build 把整条链打进消费方 dist）。
 * helper 始终归 scene-kit 所有、不复制第二份；内联后 `import.meta.url` 指向**消费方的 dist**，
 * 所以按**相对包布局**逐个候选位置确认存在，绝不写死本机绝对路径，产物整体搬目录后仍成立：
 *   1) `../python`：源模块（scene-kit/src）与 scene-kit 自身 bundle（scene-kit/dist）；
 *   2) `../../scene-kit/python`：robot-tools bundle（packages/robot-tools/dist）与同构发行载荷；
 *   3) `../scene-kit/python`：消费方与 scene-kit 同处一个 `dist/` 根的扁平发行布局；
 *   4) `../../../packages/scene-kit/python`：bundle 落在更深的嵌套目录时回到仓库/载荷根的 packages。
 * 缺件时回退到候选 1，由 `runSubtreeHelper` 的 SUBTREE_HELPER_MISSING 点名真实查找路径。
 */
function subtreeHelperCandidates(root: string): string[] {
  return [
    resolve(root, '../python/mjcf_subtree.py'),
    resolve(root, '../../scene-kit/python/mjcf_subtree.py'),
    resolve(root, '../scene-kit/python/mjcf_subtree.py'),
    resolve(root, '../../../packages/scene-kit/python/mjcf_subtree.py'),
  ]
}
function locateSubtreeHelper(root: string): string {
  const candidates = subtreeHelperCandidates(root)
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]!
}
export const SUBTREE_HELPER = locateSubtreeHelper(here)

/** 原生 MJCF/URDF 解释器：显式配置 > `LYAPUNOV_MUJOCO_PYTHON` > 仓内 `.runtime/sim-python`。 */
export function resolveSubtreePython(explicit?: string): string {
  return explicit ?? process.env.LYAPUNOV_MUJOCO_PYTHON ?? resolve(here, '../../..', '.runtime/sim-python/bin/python')
}

export interface SubtreePrecheckFacts {
  source: string
  sourceSha256: string
  format: 'mjcf' | 'urdf'
  modelName?: string
  selectedBody: string
  selectedBodyParent: string
  supported: boolean
  subtree: { bodies: string[]; joints: string[]; cutJoints: string[]; actuators: string[]; tendons: string[]; equalities: string[]; sensors: string[]; meshes: number; textures: number }
  remaining: { bodies: string[]; joints: string[]; actuators: string[]; tendons: string[]; equalities: string[]; sensors: string[] }
  tendons: Array<Record<string, unknown>>
  equalities: Array<Record<string, unknown>>
  actuators: Array<Record<string, unknown>>
  sensors: Array<Record<string, unknown>>
  excludes: Array<Record<string, unknown>>
  mimics?: Array<Record<string, unknown>>
  transmissions?: Array<Record<string, unknown>>
  closure: { meshFiles: string[]; textureFiles: string[]; copiedBytes: number; files: Array<Record<string, unknown>> }
  crossEdges: Array<{ kind: string; name: string; reason: string; references?: Array<{ kind: string; name: string }> }>
  warnings: Array<Record<string, unknown>>
  reason: string | null
}

export interface SubtreeSideReport {
  model: string
  nbody: number; nq: number; nv: number; nu: number; ntendon: number; neq: number; nkey: number
  joints: string[]; actuators: string[]; integrator: number
  /** 重载后真实 body/site 名（旧报告缺省时省略，不伪造）。 */
  bodies?: string[]; sites?: string[]
  files: Array<{ kind: string; declared: string; bytes: number; sha256: string }>
  copiedBytes: number
}

export interface SubtreeSplitReport {
  ok: true
  outDir: string
  source: string
  sourceSha256: string
  sourceStable: boolean
  selectedBody: string
  cutJoint?: { name: string; parent: string; type: string }
  /** 原生重载核对过的 source→derived 名映射；旧 helper 缺省时省略。 */
  nameMap?: { part: RobotSubtreeNameMap; remaining: RobotSubtreeNameMap }
  crossEdges: unknown[]
  warnings: Array<Record<string, unknown>>
  sides: { remaining: SubtreeSideReport; part: SubtreeSideReport }
}

export interface RobotSubtreeDerivationResult {
  operationId: string
  format: 'mjcf' | 'urdf'
  sourceResourceId: string
  sourceVersion: number
  sourceSha256: string
  cutBody: string
  cutBodyParent: string
  cutJoint?: { name: string; parent: string; type: string }
  remaining: { ref: ResourceRef; record: ResourceRecord; report: SubtreeSideReport }
  part: { ref: ResourceRef; record: ResourceRecord; report: SubtreeSideReport }
  precheck: SubtreePrecheckFacts
  stagingDirectory: string
  /** 契约形状的具名派生记录（含真实 DOF/驱动数与切口映射），供 Scene 标记与局部 Undo 核对。 */
  derivation: RobotSubtreeDerivationRecord
  /** 契约形状的只读预检回执（场景/实体版本由调用方填充）。 */
  contractPrecheck: RobotSubtreePrecheckResult
  remainingModelPath: string
  partModelPath: string
  /** 两侧资源原件的真实可视描述（与 scene_mount 同一口径，不另做展示转换）。 */
  remainingVisual: Record<string, unknown>
  partVisual: Record<string, unknown>
}

function helperError(error: unknown): { code?: string; message: string; details?: unknown } {
  const stderr = (error as { stderr?: string })?.stderr
  const stdout = (error as { stdout?: string })?.stdout
  const text = (stdout && stdout.trim()) || (stderr && stderr.trim()) || (error instanceof Error ? error.message : String(error))
  try {
    const parsed = JSON.parse(text) as { code?: string; message?: string; details?: unknown }
    if (parsed && typeof parsed === 'object' && typeof parsed.code === 'string') return { code: parsed.code, message: parsed.message ?? text, details: parsed.details }
  } catch { /* 非 JSON：按原始文本抛出 */ }
  return { message: text }
}

async function callHelper<T>(args: string[], pythonPath?: string): Promise<T> {
  if (!existsSync(SUBTREE_HELPER)) throw new Error(`SUBTREE_HELPER_MISSING: ${SUBTREE_HELPER}`)
  try {
    const { stdout } = await run(resolveSubtreePython(pythonPath), [SUBTREE_HELPER, ...args], { maxBuffer: 64 * 1024 * 1024 })
    return JSON.parse(stdout) as T
  } catch (error) {
    const parsed = helperError(error)
    const failure = new Error(parsed.code ? `${parsed.code}: ${parsed.message}` : parsed.message)
    ;(failure as { details?: unknown }).details = parsed.details
    throw failure
  }
}

/** 只读预检：列两侧 body/joint/actuator/tendon/equality/sensor/mesh/闭包与跨切口引用，零 Scene/资源写入。 */
export async function precheckRobotSubtree(input: { sourcePath: string; bodyName: string; pythonPath?: string }): Promise<SubtreePrecheckFacts> {
  return callHelper<SubtreePrecheckFacts>(['precheck', '--source', resolve(input.sourcePath), '--body', input.bodyName], input.pythonPath)
}

export interface SubtreeResourceInspection {
  resourceId: string
  version: number
  path: string
  sha256: string
  format: string
  supported: boolean
  facts?: SubtreePrecheckFacts
  /** 具名不支持原因（格式/资源类型），带零 Scene/资源写入语义。 */
  unsupported?: { code: string; message: string }
}

/**
 * 对**已登记资源**做只读预检：先核资源类型/格式，再交给原生 helper。USD（`kind=source`）等
 * 尚无结构编辑能力的格式在这里给具名 unsupported，绝不按扩展名开放按钮、也不用 MJCF 转换件冒充保真。
 */
export async function inspectRobotSubtreeResource(options: {
  resources: ResourceLibrary
  sourceResourceId: string
  sourceVersion: number
  bodyName: string
  pythonPath?: string
}): Promise<SubtreeResourceInspection> {
  const record = await options.resources.get(options.sourceResourceId, options.sourceVersion)
  const path = record.ref.original.uri.startsWith('file:') ? fileURLToPath(record.ref.original.uri) : record.ref.original.uri
  const sha = entrySha(record) ?? ''
  const format = String(record.parsed.metadata.format ?? record.parsed.kind)
  if (record.deletedAt) return { resourceId: options.sourceResourceId, version: options.sourceVersion, path, sha256: sha, format, supported: false, unsupported: { code: 'SUBTREE_SOURCE_TRASHED', message: `${options.sourceResourceId}@${options.sourceVersion} 已被回收，不能作为拆分源` } }
  if (record.parsed.kind !== 'robot' || (format !== 'mjcf' && format !== 'urdf')) {
    return {
      resourceId: options.sourceResourceId, version: options.sourceVersion, path, sha256: sha, format, supported: false,
      unsupported: {
        code: 'SUBTREE_FORMAT_UNSUPPORTED',
        message: `当前真实内部拆分只覆盖有结构 body/link 投影的 MJCF/URDF；${format} 只有收件入口（kind=${record.parsed.kind}），没有结构编辑链，拒绝按扩展名开放提取按钮，也不把转换件冒充原格式保真。`,
      },
    }
  }
  const facts = await precheckRobotSubtree({ sourcePath: path, bodyName: options.bodyName, pythonPath: options.pythonPath })
  return { resourceId: options.sourceResourceId, version: options.sourceVersion, path, sha256: sha, format, supported: facts.supported, facts }
}

/** 真实拆分到 `stagingDirectory`，两份派生件各自复制资产闭包并离开原目录重载核对。 */
export async function splitRobotSubtree(input: { sourcePath: string; bodyName: string; stagingDirectory: string; sourceSha256?: string; pythonPath?: string }): Promise<SubtreeSplitReport> {
  const args = ['split', '--source', resolve(input.sourcePath), '--body', input.bodyName, '--out', resolve(input.stagingDirectory)]
  if (input.sourceSha256) args.push('--source-sha', input.sourceSha256)
  return callHelper<SubtreeSplitReport>(args, input.pythonPath)
}

function entrySha(record: ResourceRecord): string | undefined {
  const entry = resolve(record.ref.original.uri.startsWith('file:') ? fileURLToPath(record.ref.original.uri) : record.ref.original.uri)
  return record.parsed.dependencies.find(stamp => resolve(stamp.path) === entry)?.sha256 ?? record.parsed.dependencies[0]?.sha256
}

/** 原生预检事实 → 回执形状（只读；`supported=false` 时零 Scene/资源写入）。 */
export function presentSubtreePrecheck(input: { facts: SubtreePrecheckFacts; sceneId: string; entityId: string; revision: number; format: string }): RobotSubtreePrecheckResult {
  const facts = input.facts
  return {
    sceneId: input.sceneId,
    entityId: input.entityId,
    revision: input.revision,
    source: { resourceId: '', version: 0, sha256: facts.sourceSha256, format: input.format, path: facts.source },
    selectedBody: facts.selectedBody,
    selectedBodyParent: facts.selectedBodyParent,
    supported: facts.supported,
    subtree: facts.subtree,
    remaining: facts.remaining,
    closure: { meshFiles: facts.closure.meshFiles, textureFiles: facts.closure.textureFiles, copiedBytes: facts.closure.copiedBytes },
    crossEdges: facts.crossEdges,
    warnings: facts.warnings,
    ...(facts.reason ? { reason: facts.reason } : {}),
  }
}

/**
 * 完整派生：只读预检 → 原生拆分 → 两份派生资源登记 + 两侧可视描述。
 *
 * 登记复用既有 `ResourceLibrary.import` 的 CAS/依赖闭包/版本分配：remaining 成为源资源 id 的新版本，
 * part 成为新资源；两侧都带 `derivedFrom` 具名派生记录。旧版本与源文件一步不动。
 */
export async function deriveRobotSubtree(options: {
  resources: ResourceLibrary
  stagingRoot: string
  sourceResourceId: string
  sourceVersion: number
  bodyName: string
  operationId?: string
  partResourceId?: string
  pythonPath?: string
  sceneId?: string
  entityId?: string
  partEntityId?: string
  cutPoseInSourceRoot?: RobotAnchorPose
}): Promise<RobotSubtreeDerivationResult> {
  const sourceRecord = await options.resources.get(options.sourceResourceId, options.sourceVersion)
  if (sourceRecord.deletedAt) throw new Error(`SUBTREE_SOURCE_TRASHED: ${options.sourceResourceId}@${options.sourceVersion}`)
  if (sourceRecord.parsed.kind !== 'robot') throw new Error(`SUBTREE_SOURCE_NOT_ROBOT: ${options.sourceResourceId}@${options.sourceVersion}`)
  const format: 'mjcf' | 'urdf' = (() => {
    const raw = String(sourceRecord.parsed.metadata.format)
    if (raw !== 'mjcf' && raw !== 'urdf') throw new Error(`SUBTREE_FORMAT_UNSUPPORTED: ${raw}（当前真实拆分只覆盖 MJCF/URDF 的已核闭合子树）`)
    return raw
  })()
  const sourcePath = sourceRecord.ref.original.uri.startsWith('file:') ? fileURLToPath(sourceRecord.ref.original.uri) : sourceRecord.ref.original.uri
  const beforeSha = entrySha(sourceRecord)
  const operationId = options.operationId ?? `subtree-${randomUUID()}`
  const precheck = await precheckRobotSubtree({ sourcePath, bodyName: options.bodyName, pythonPath: options.pythonPath })
  if (!precheck.supported) {
    const failure = new Error(`SUBTREE_CROSS_EDGE_DEPENDENCY: ${precheck.crossEdges.map(edge => `${edge.kind}:${edge.name}`).join(', ') || '预检不支持'}`)
    ;(failure as { details?: unknown }).details = { crossEdges: precheck.crossEdges, subtree: precheck.subtree, remaining: precheck.remaining }
    throw failure
  }
  const stagingDirectory = join(resolve(options.stagingRoot), operationId)
  await mkdir(stagingDirectory, { recursive: true })
  const report = await splitRobotSubtree({ sourcePath, bodyName: options.bodyName, stagingDirectory, ...(beforeSha ? { sourceSha256: beforeSha } : {}), pythonPath: options.pythonPath })
  if (!report.sourceStable || report.sourceSha256 !== precheck.sourceSha256) throw new Error('SUBTREE_SOURCE_CHANGED: 拆分期间源文件字节发生变化，作废本次派生')
  // 拆分后再核对源资源版本仍可验证，且入口字节未变：不允许据不可验证的旧资源发布新版本。
  const verified = await options.resources.verify(options.sourceResourceId, options.sourceVersion)
  if (!verified.valid) throw new Error(`SUBTREE_SOURCE_VERIFY_FAILED: ${options.sourceResourceId}@${options.sourceVersion}`)

  const baseDerivation = {
    kind: 'subtree-extract' as const,
    from: options.sourceVersion,
    sourceResourceId: options.sourceResourceId,
    sourceVersion: options.sourceVersion,
    operationId,
    format,
    cutBody: options.bodyName,
    cutBodyParent: precheck.selectedBodyParent,
    ...(report.cutJoint ? { cutJoint: report.cutJoint } : {}),
    sourceSha256: beforeSha ?? precheck.sourceSha256,
    at: new Date().toISOString(),
  }
  const remaining = await options.resources.import({
    path: report.sides.remaining.model,
    resourceId: options.sourceResourceId,
    name: sourceRecord.name,
    tags: sourceRecord.tags,
    folder: sourceRecord.folder,
    category: sourceRecord.category ?? 'robot',
    derivedFrom: { ...baseDerivation, role: 'remaining' } satisfies ResourceDerivation,
    storage: 'cas',
  })
  const part = await options.resources.import({
    path: report.sides.part.model,
    ...(options.partResourceId ? { resourceId: options.partResourceId } : {}),
    name: `${sourceRecord.name} · part(${options.bodyName})`,
    tags: sourceRecord.tags,
    folder: sourceRecord.folder,
    category: 'robot',
    derivedFrom: { ...baseDerivation, role: 'part' } satisfies ResourceDerivation,
    storage: 'cas',
  })
  if (entrySha(part) === beforeSha) throw new Error('SUBTREE_PART_BYTES_UNCHANGED: part 派生件与源入口逐字节相同，拆分没有产生真实派生')
  const partEntityId = options.partEntityId ?? `entity_${randomUUID()}`
  const derivation: RobotSubtreeDerivationRecord = {
    ...baseDerivation,
    remaining: { resourceId: remaining.ref.resourceId, version: remaining.ref.version, nq: report.sides.remaining.nq, nu: report.sides.remaining.nu, ntendon: report.sides.remaining.ntendon, neq: report.sides.remaining.neq },
    part: { resourceId: part.ref.resourceId, version: part.ref.version, entityId: partEntityId, nq: report.sides.part.nq, nu: report.sides.part.nu, ntendon: report.sides.part.ntendon, neq: report.sides.part.neq },
    ...(options.cutPoseInSourceRoot ? { cutPoseInSourceRoot: options.cutPoseInSourceRoot } : {}),
    ...(report.nameMap ? { nameMap: report.nameMap } : {}),
    jointMap: {
      partJoints: precheck.subtree.joints,
      remainingJoints: precheck.remaining.joints,
      cutJoints: precheck.subtree.cutJoints,
    },
  }
  const remainingModelPath = report.sides.remaining.model
  const partModelPath = report.sides.part.model
  return {
    operationId,
    format,
    sourceResourceId: options.sourceResourceId,
    sourceVersion: options.sourceVersion,
    sourceSha256: beforeSha ?? precheck.sourceSha256,
    cutBody: options.bodyName,
    cutBodyParent: precheck.selectedBodyParent,
    ...(report.cutJoint ? { cutJoint: report.cutJoint } : {}),
    remaining: { ref: remaining.ref, record: remaining, report: report.sides.remaining },
    part: { ref: part.ref, record: part, report: report.sides.part },
    precheck,
    stagingDirectory,
    derivation,
    contractPrecheck: presentSubtreePrecheck({ facts: precheck, sceneId: options.sceneId ?? '', entityId: options.entityId ?? '', revision: -1, format }),
    remainingModelPath,
    partModelPath,
    remainingVisual: await robotVisual(remainingModelPath),
    partVisual: await robotVisual(partModelPath),
  }
}

/** 仅供测试/清理：删除本次暂存目录（不改已登记资源版本）。 */
export async function cleanupSubtreeStaging(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true })
}
