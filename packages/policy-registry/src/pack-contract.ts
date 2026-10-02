/**
 * 能力包契约（packs 内容侧 ↔ 客户端装配侧的唯一判据）。
 *
 * 背景（2026-09-23 复核）：`script/verify-packs.ts` 原先只要「每目录有文件」就判齐全，于是
 * ① 声明了权重而权重文件根本不存在的包（Go2/G1 的 `weights.file`）照过；
 * ② 同一包内两份归一化统计哈希互相矛盾（Wx250s）照过。
 * 本模块给出**可机器复算**的三级状态与**执行路由**，供 verify-packs（内容侧）与 policy-registry
 * （客户端装配侧）共用同一份判据，避免两处各写一套而漂移：
 *
 * - `contentReady`  ：四件套文件齐 + policy manifest 可解析 + 权重声明与磁盘逐字节一致
 *                     （声明 bundled 就必须有且 sha256/bytes 对得上；不 bundled 就必须不带伪哈希）。
 * - `adapterReady`  ：在 contentReady 之上，**有可执行的装配/执行路由**——
 *                     直控包给直控路由（不需要权重），基础策略包必须有已实现的适配器 + 可得权重，
 *                     VLA/服务端推理包必须有 `inference.implemented === true`。
 * - `behaviorVerified`：有显式登记且**在磁盘上真实存在**的行为级证据指针；缺省 false，
 *                     下载通过 / JSON 存在 / 编译通过一律不算。
 *
 * 词汇与 `packs/README.md` 的 `ready|blocked:<原因>|PARTIAL:<原因>` 并存：manifest.status 是作者声明，
 * 三级状态是**复算结果**，两者不一致即报 issue（不静默改判）。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative, resolve } from 'node:path'
// 依赖闭包与格式校验复用 scene-kit 的既有资产解析（本仓既有做法，见 lyapunov-workspace/src/model-convert.ts）：
// pack-contract 只做能力包契约，不另造 XML 解析器。
import { parseAsset } from '../../scene-kit/src/formats.ts'
import { validateBehaviorEvidence } from './behavior-evidence.ts'

export type PackMode = 'base-policy' | 'direct-control' | 'vla-base' | 'external-controller'
export const PACK_MODES: PackMode[] = ['base-policy', 'direct-control', 'vla-base', 'external-controller']
/** mode 取值归一：非法/缺失一律 null（调用方按未解析处理，不猜）。 */
export const packModeOf = (value: unknown): PackMode | null => (PACK_MODES as readonly unknown[]).includes(value) ? value as PackMode : null
/** 读 JSON 对象；缺文件/坏 JSON 一律 null（不抛）。内容侧与客户端装配侧共用。 */
export const readObjectOrNull = async (path: string): Promise<Record<string, any> | null> => {
  try { const value = JSON.parse(await readFile(path, 'utf8')); return isRecord(value) ? value : null } catch { return null }
}
/** 已实现的客户端适配器（有真实动作/观测语义、进 execution.ts 或直控链）；其余一律 adapterReady=false。 */
export const IMPLEMENTED_ADAPTERS = ['onnx', 'torchscript', 'none'] as const
/**
 * 装配某来源所必需的源件：精确路径 `files` + 目录前缀 `prefixes`（该目录下**全部** blob）。
 * 前缀用于 XML 声明式资产：G1 的 meshes 名写在 `g1_12dof.xml` 里，取到 XML 之前无法枚举。
 * **同一份**台账既供 `adapter.ts` 装配前校验，也供 `POLICY_WEIGHTS_NOT_CACHED` 的取件命令
 * （`adapterDownloadFiles`），所以提示里的文件列表天然覆盖适配器真正要的件，不会随改动漂移。
 */
export interface AdapterRequires { files: string[]; prefixes?: string[]; integrity?: Record<string,{bytes:number;sha256:string;gitBlob?:string}>; runtimeModules?:string[] }
/**
 * 客户端已实现的 policy 适配器登记表。**判据来源是代码，不是内容侧自述**——对应 `src/adapter.ts`
 * `preparePolicy` 的三个已实现分支与其 python 脚本（均有实跑回执）。内容侧只能声明「本包属于哪一类
 * 来源」，不能自称已实现；未登记的 (来源, 包) 组合一律 adapterReady=false（Go1 教训：不得借用同族包的适配器）。
 * 与 `src/adapter.ts` 的 pin 常量由测试逐项对账，防止两处漂移。
 */
export const IMPLEMENTED_POLICY_ADAPTERS: Array<{ id: string; adapter: string; modelId: string; revision: string; entry: string; packs: string[]; requires: AdapterRequires; behavior?:{status:"candidate-evidence-scoped";defaultDurationS:number;defaultAbsCommand:number;longDistanceVerified:false;testedModelSha256?:string} }> = [
  { id: 'inria-go2-onnx-v1', adapter: 'onnx', modelId: 'inria-paris-robotics-lab/go2_onnx_controller', revision: 'c1729e1a4aa2e7e1091ccff42be68d42bd054764', entry: 'python/prepare_go2.py', packs: ['unitree_go2'], requires: { files: ['onnx_inference/data/model.onnx', 'onnx_controller/include/onnx_controller/controller.hpp', 'onnx_controller/src/controller.cpp'],runtimeModules:['mujoco','numpy','onnxruntime'],integrity:{'onnx_inference/data/model.onnx':{bytes:189915,sha256:'9bdcb0f47be89417dbf3f7fb46522ecb3ec42ca65458a905f191aff933a18eae',gitBlob:'6611b46113934a028152cde428184e0e5e2c4c7e'},'onnx_controller/include/onnx_controller/controller.hpp':{bytes:6468,sha256:'37693a3670a3e20256323741374ec2679c1c211605c4e035bce2856f553e67e6',gitBlob:'083b0adfdeea1861e88e0ec6e2c8bbba924daa0b'},'onnx_controller/src/controller.cpp':{bytes:7836,sha256:'02b97d1889bc4b5e1f929c80a64c91cc3bc187322296d097a26c8c5e979fd12d',gitBlob:'ac9a7af77fc0a42494fbd3d18fff60eee3edde58'}} } },
  { id: 'unitree-g1-12dof-v1', adapter: 'torchscript', modelId: 'unitreerobotics/unitree_rl_gym', revision: '276801e46c5d433564f24658bac64f254b7d2d4b', entry: 'python/prepare_unitree.py', packs: ['unitree_g1'], requires: { files: ['deploy/pre_train/g1/motion.pt', 'deploy/deploy_mujoco/configs/g1.yaml', 'deploy/deploy_mujoco/deploy_mujoco.py', 'resources/robots/g1_description/g1_12dof.xml'], prefixes: ['resources/robots/g1_description/meshes'],runtimeModules:['mujoco','numpy','torch','yaml'],integrity:{'deploy/pre_train/g1/motion.pt':{bytes:145745,sha256:'cf668f75b90d1abf73d2b87612a6e76bccc61ff7e083b63582d3f6aaa3c1759d'},'deploy/deploy_mujoco/configs/g1.yaml':{bytes:737,sha256:'73044e7d355c61915695c16d6e09eb3efef46eec1e3d708fd3eb9157dfe3bbbb'},'deploy/deploy_mujoco/deploy_mujoco.py':{bytes:4862,sha256:'48e9f7a6b8ba701e68dfa48f2e89944c9f2aac1ec39c0a9915d6fe14ec71a4da'},'resources/robots/g1_description/g1_12dof.xml':{bytes:15579,sha256:'747ede40aa726b7352bae8353e95d0d0f908cec2257a27cbd78bc6e5a2d5a314'}} } },
  { id: 'jlog-g1-23-75-torchscript-v1', adapter: 'torchscript', modelId: 'jloganolson/g1_23dof_locomotion_isaac', revision: 'fbfa38706b817e2d4b19e444db95ae7fb2537b46', entry: 'python/prepare_g1_23_75.py', packs: ['unitree_g1'], requires: { files: ['deployment/policy.pt'],runtimeModules:['mujoco','numpy','torch'],integrity:{'deployment/policy.pt':{bytes:299424,sha256:'1123d5348c5f7638363f7af24e5c243adedd8dcdfd2838127d388410f7b7ad47'}} }, behavior:{status:"candidate-evidence-scoped",defaultDurationS:3,defaultAbsCommand:.3,longDistanceVerified:false,testedModelSha256:"8ca62fcccdca91a431ca04f1a42f9c2fda241fdd5e13411168dc82de00f978de"} },
  { id: 'wtw-go1-torchscript-v1', adapter: 'torchscript', modelId: 'Improbable-AI/walk-these-ways', revision: '0e7236bdc81ce855cbe3d70345a7899452bdeb1c', entry: 'python/prepare_wtw.py', packs: ['unitree_go1'], requires: { files: ['runs/gait-conditioned-agility/pretrain-v0/train/025417.456545/checkpoints/body_latest.jit', 'runs/gait-conditioned-agility/pretrain-v0/train/025417.456545/checkpoints/adaptation_module_latest.jit', 'runs/gait-conditioned-agility/pretrain-v0/train/025417.456545/parameters.pkl'],runtimeModules:['mujoco','numpy','torch'],integrity:{'runs/gait-conditioned-agility/pretrain-v0/train/025417.456545/checkpoints/body_latest.jit':{bytes:4980904,sha256:'6c14b59ca28550a012de3bf5d21fc7d6aa6b6d38eab4dc31e172519f12a19ece',gitBlob:'952e3fb470c61e9df240ab542e037f4d6f9ce1af'},'runs/gait-conditioned-agility/pretrain-v0/train/025417.456545/checkpoints/adaptation_module_latest.jit':{bytes:2293501,sha256:'f0adb113954058a37d2596282f041a3bb128365558ecf64405bbc1353d5dc1b0',gitBlob:'4513d87792c8f9b00a48911bfc494c17b201326b'},'runs/gait-conditioned-agility/pretrain-v0/train/025417.456545/parameters.pkl':{bytes:484076,sha256:'eeb132fe125fb4a2169315ae4e3f2d1b1c0a7857fdcb48824d6d375a26268e11',gitBlob:'aa0d7b918d3712fffa76900764b85d09fffa69f8'}} } },
]
/**
 * 取件命令的 `files` 参数：精确件 + 目录前缀（`前缀/`，选择语义见 source.ts 的 `selectSourceFiles`）。
 * 取件提示与装配校验读**同一份** `requires`，两处不再各写一份文件清单。
 */
export const adapterDownloadFiles = (entry: { requires: AdapterRequires }) => [...entry.requires.files, ...(entry.requires.prefixes ?? []).map(prefix => prefix + '/')]
/** 按 (包, 来源, 适配器) 判定「客户端是否真能装配并执行」；找不到登记项即未实现。 */
export const implementedFor = (packId: string, adapter: string | null, resolution: WeightResolution | null) =>
  resolution ? IMPLEMENTED_POLICY_ADAPTERS.find((entry) => entry.packs.includes(packId) && entry.adapter === adapter && entry.modelId === resolution.modelId && entry.revision === resolution.revision) ?? null : null
/**
 * 服务端推理适配器登记表（同样以**代码/回执**为判据，不以内容自述为判据）。
 * 当前为空：`openpi-server-side`（π0.5，jax 栈）与 `g05-pytorch-server-side`（G0.5，pytorch 栈）都只有
 * 字符串声明与本地权重台账，客户端侧无任何已见推理实现 ⇒ 所有 vla-base 包的 policy 面如实 blocked。
 */
export const IMPLEMENTED_SERVER_SIDE_INFERENCE: Array<{ adapter: string; packs: string[]; evidence: string }> = []
/** 权重可得性：随包 / 可从**已登记来源**取 / 本包拿不到 / 只在服务端。 */
export type WeightAvailability = 'bundled' | 'resolvable' | 'unavailable' | 'server-side'

export interface PackIssue { path: string; code: string; detail?: string }
export interface WeightResolution { provider: string; modelId: string; revision: string }
/**
 * 模型取件声明（`weights.download`）：**下载侧**事实，与执行侧（适配器）各自独立。
 *
 * 为什么与 `weights.resolution` 分开：`resolution` 是"来源坐标"，`download` 是"客户端按这份清单
 * 能不能取到字节"。两者可以并存于一个 `availability: 'unavailable'` 的包上（G05：来源坐标真实、
 * 固定 revision 已复核，但 HF restricted + 镜像对 gated 仓掩码 LFS sha256 ⇒ 客户端取不到也校验不了）。
 * `files` 必须是**该来源真实清单上的选择项**——精确路径，或 `前缀/` 形式的目录前缀（与 source.ts 的
 * `policyFileSelector` 同一份语义；客户端 `policy_download` 直接拿它取件，选不中即 `POLICY_FILE_NOT_IN_SOURCE`）；
 * `blocked` 一旦声明，客户端就不给下载入口——许可/门禁/身份阻断是**内容侧**的事实，不由客户端猜。
 * `requiresAuth` 是**非阻断**的取件前提：来源协议本身可取，但要本机凭据（如受控 HF 仓需本机 HF 授权）——
 * 声明它不会关掉下载入口，只让面板/决策如实说出"点之前要知道什么"。
 */
export interface PackDownloadDeclaration {
  files: string[]
  bytes: number | null
  blocked: { code: string; detail?: string } | null
  requiresAuth: string | null
}
/** 已登记的取件凭据种类（未登记的一律报 issue，避免拼错一个词就静默降级成"不需要凭据"）。 */
export const DOWNLOAD_CREDENTIAL_KINDS = ['huggingface-token'] as const
export interface PackWeights {
  bundled: boolean
  file: string | null
  bytes: number | null
  sha256: string | null
  providedBy?: string
  pin?: string | null
  availability: WeightAvailability
  resolution?: WeightResolution | null
  download?: PackDownloadDeclaration | null
}
/**
 * 模型面的**唯一形状**（服务端 policyFace / 客户端面板共用）：让用户看到"模型/来源/下载入口"，
 * 并让「能不能下载」与「能不能执行」两个状态**分开**说。
 *
 * - `downloadable` 只讲字节：来源协议已实现、坐标与文件清单齐备、内容侧未声明门禁阻断；
 *   **下载成功不等于可执行**——执行侧由 route.adapterReady / route.execution 说（本模块不混为一谈）。
 * - `code` 空 ⇒ 可取件；非空 ⇒ 阻断原因，值来自内容侧声明的 `download.blocked.code`，或本函数
 *   在声明不全时**派生**的 `MODEL_SOURCE_UNDECLARED` / `MODEL_FILES_UNDECLARED`（派生码与声明码不同名，
 *   不把"没声明"说成"被限制"）。
 */
export interface PackModelFace {
  source: WeightResolution | null
  /** 用户可见的来源说明（pin/providedBy 原文照抄，不编造 URL）。 */
  provenance: string
  /** 客户端取件要用的文件选择项（来源真实清单上的精确路径或 `前缀/`；未声明为空数组）。 */
  files: string[]
  bytes: number | null
  /** 非阻断的取件前提：`huggingface-token` ⇒ 需要本机 HF 授权（面板/决策据此提前说明，不改可取件性）。 */
  requiresAuth: string | null
  downloadable: boolean
  status: 'fetchable' | 'blocked'
  code: string | null
  detail: string | null
}
/**
 * 模型路由条目：模型面 + 包身份 + **本机缓存事实**（包面板与取件命令共用的唯一形状）。
 *
 * `cache` 是**客户端**读出来的（服务端不知道本机缓存）：决策必须在"已缓存"时不重复下载，
 * 面板要能显示缓存状态。类型放在这里而不是各写一份：服务端策略面（`policy.model`）与客户端
 * 路由条目共用同一个 `PackModelFace`，两处不会漂移。
 */
export interface PackModelRoute {
  packId: string
  /** 与 `policy_download` 的 modelId 同口径（`packs/<packId>`）。 */
  modelId: string
  /** 该包登记的说法（别名表原文）："用户是否点名了这个模型"的判定用它，不另造词表。 */
  aliases: string[]
  model: PackModelFace
  cache: { status: string; files: number; bytes: number; updatedAt: string | null } | null
}
/** 已实现取件协议的来源（与 source.ts 的 policy_source 同一份枚举）；其余协议（如 gs://）客户端无通道。 */
export const FETCHABLE_PROVIDERS: readonly string[] = ['modelscope', 'github', 'huggingface', 'packs']
/**
 * 模型面判据（唯一一份，服务端与客户端**不各写一套**）：只读声明，不打来源、不下字节。
 * `provenance` 取 `pin ?? providedBy`（内容侧如实写的来源说明），两者都缺时留空串——不编造。
 *
 * `files` 是**代码侧**的取件清单回落（基础策略包用 `adapterDownloadFiles(已登记适配器)`）：内容侧没写
 * `weights.download` 不等于取不到——客户端已经有能装配该包的适配器时，它需要的文件是**代码事实**
 * （`requires.files/prefixes`，装配校验与取件提示读同一份）。缺了这条回落，Go2/G1/Go1 这类
 * 「来源已登记 + 适配器已实现」的包会被误报成 `MODEL_FILES_UNDECLARED`，面板/决策就不给下载入口。
 * 只补清单，不放宽判定：来源协议未实现、坐标缺失、内容侧显式 `blocked` 一律照旧阻断。
 */
export function resolveModelFace(args: { weights: PackWeights | null; adapter?: string | null; files?: string[] }): PackModelFace | null {
  const weights = args.weights
  if (!weights) return null
  const declared = weights.download ?? null
  const source = weights.resolution ?? null
  const files = declared?.files?.length ? declared.files : (args.files ?? [])
  const provenance = String(weights.pin ?? weights.providedBy ?? '')
  const face: PackModelFace = {
    source, provenance, files,
    bytes: declared?.bytes ?? null,
    // 取件前提（如需本机 HF 授权）**不参与**可取件判定：它说的是"点之前要知道什么"，不是"取不到"。
    requiresAuth: declared?.requiresAuth ?? null,
    downloadable: false, status: 'blocked', code: null, detail: null,
  }
  // 内容侧显式声明的门禁（许可/受控访问/协议不支持…）优先于任何派生判断：声明是事实，派生只是补漏。
  if (declared?.blocked) return { ...face, status: 'blocked', code: declared.blocked.code, detail: declared.blocked.detail ?? null }
  if (!source || !FETCHABLE_PROVIDERS.includes(source.provider)) return { ...face, status: 'blocked', code: 'MODEL_SOURCE_UNDECLARED', detail: source ? `来源协议 ${source.provider} 不在已实现取件来源（${FETCHABLE_PROVIDERS.join('|')}）内` : '未声明可校验的取件来源（provider/modelId/revision）' }
  if (!files.length) return { ...face, status: 'blocked', code: 'MODEL_FILES_UNDECLARED', detail: '未声明取件文件清单（weights.download.files）：客户端无法在不虚构路径的前提下取件' }
  return { ...face, downloadable: true, status: 'fetchable', code: null, detail: null }
}
/** 装配/执行路由：客户端拿到它就能知道「模型入口 / 依赖 / 观测与动作语义 / 下一步」。 */
export type PackRoute =
  | { kind: 'direct-control'; controlPath: string; modelEntry: string | null; deps: string[]; channels: string[]; observations: Record<string, unknown>; actions: Record<string, unknown>; nextSteps: string[] }
  /** `model` 是**下载侧**事实，与执行侧同在一行但互不冒充：能否取件 ≠ 能否执行（下载成功也仍要 policy_match）。 */
  | { kind: 'policy-source'; /** 代码侧已登记的适配器 id（装配/执行按它路由） */ adapterId: string; modelEntry: string | null; adapter: string; source: WeightResolution; weightsAvailability: WeightAvailability; model: PackModelFace | null; deps: string[]; observations: Record<string, unknown>; actions: Record<string, unknown>; nextSteps: string[] }
  | { kind: 'server-side-inference'; adapter: string; stack: string | null; observations: Record<string, unknown>; actions: Record<string, unknown>; nextSteps: string[] }
  /** `model` 是**下载侧**事实（可为空）：执行不可用与模型能否取件是两件事，同一行都要能说清。 */
  | { kind: 'unavailable'; code: string; detail: string; nextSteps: string[]; model?: PackModelFace | null }

export interface PackContract {
  packId: string
  version: string | null
  mode: PackMode | null
  adapter: string | null
  declaredStatus: string | null
  contentReady: boolean
  adapterReady: boolean
  behaviorVerified: boolean
  route: PackRoute
  issues: PackIssue[]
  modelEntry: string | null
  weights: PackWeights | null
}

const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isHex64 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const sha256File = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')
/** manifest 里的占位符（TBD/待定/留空对账）一律视为**未就绪**，不许当成真哈希放行。 */
const isPlaceholder = (value: unknown): boolean => typeof value === 'string' && /(^|\W)(TBD|TODO|xxx+|待定|待补|留字段|不凭空填值)/i.test(value)
const readJSON = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'))
const exists = async (path: string) => stat(path).then(() => true, () => false)

/**
 * 包内模型入口：**内容侧显式登记**（`pack.json` 的 `asset.modelEntry`，包相对路径），不再靠扫描/排序猜。
 *
 * 本库是 32 个已知包，入口属于内容数据：写在包里、由 `parseAsset` 复核，而不是由客户端用文件名字典
 * 或候选打分推断（那既会猜错，也把「包内有什么」这一事实挪到了消费方）。需要**分开**给出「产品导入的
 * 场景」与「适配器要的机器人本体」两个文件的包（如 menagerie 布局的 `scene.xml` 与 `go2.xml`）再登记
 * `asset.model`；只登记 `modelEntry` 时两者同义。
 */
export interface PackAssetEntries {
  /** 产品导入入口（scene_import）：包相对路径 */
  modelEntry: string
  /** 已登记适配器要的机器人本体文件；缺省与 modelEntry 同值 */
  model: string
}

/** 读 `pack.json` 的显式登记；未登记一律 null（调用方如实报 `MODEL_ENTRY_UNDECLARED`，不回落猜测）。 */
export const declaredAssetEntries = (pack: Record<string, any> | null): PackAssetEntries | null => {
  const asset = isRecord(pack?.asset) ? pack!.asset : null
  if (!asset || !isNonEmptyString(asset.modelEntry)) return null
  const modelEntry = String(asset.modelEntry)
  return { modelEntry, model: isNonEmptyString(asset.model) ? String(asset.model) : modelEntry }
}

export interface ResolvedAssetEntry { path: string; kind: 'mjcf' | 'urdf' | 'other' }

/**
 * 把登记的包相对入口解析到**调用方给定的根**（内容侧=包根；客户端=本次已校验的缓存根）下的绝对路径，
 * 并用既有 `scene-kit.parseAsset` 真解析：XML 合法性、根元素种类、**完整依赖闭包**（include/mesh/
 * texture/URDF filename，含 meshdir/assetdir 口径）都由它给出——本模块不再自带第二个 XML 解析器。
 * 解析失败**照实抛出**（`EMPTY_OR_NON_FILE`/`INVALID_ROBOT_XML`/`UNSUPPORTED_ROBOT_XML_ROOT`/ENOENT…）。
 */
export async function resolveAssetEntry(packRoot: string, relativeEntry: string): Promise<ResolvedAssetEntry> {
  const path = resolve(packRoot, relativeEntry)
  const parsed = await parseAsset(path)
  return { path, kind: parsed.mimeType === 'application/x-mjcf+xml' ? 'mjcf' : parsed.mimeType === 'application/x-urdf+xml' ? 'urdf' : 'other' }
}

/** 取件/包根相对的展示口径（与 manifest 声明、open 清单里的路径同口径）。 */
export const packRelative = (packRoot: string, file: string) => relative(resolve(packRoot), resolve(file)).split('\\').join('/')

/** 只读声明的权重（**不碰磁盘**）：给服务端 discovery / 客户端路由用（那里逐包哈希太贵）。 */
export function declaredWeights(raw: unknown): PackWeights | null {
  if (!isRecord(raw) || typeof raw.bundled !== 'boolean') return null
  const weights: PackWeights = {
    bundled: raw.bundled,
    file: isNonEmptyString(raw.file) ? raw.file : null,
    bytes: Number.isSafeInteger(raw.bytes) ? raw.bytes : null,
    sha256: isHex64(raw.sha256) ? raw.sha256 : null,
    availability: (['bundled', 'resolvable', 'unavailable', 'server-side'] as string[]).includes(raw.availability) ? raw.availability as WeightAvailability : 'unavailable',
  }
  for (const key of ['providedBy', 'pin'] as const) if (isNonEmptyString(raw[key])) (weights as any)[key] = raw[key]
  const r = raw.resolution
  if (isRecord(r) && isNonEmptyString(r.provider) && isNonEmptyString(r.modelId) && isNonEmptyString(r.revision)) weights.resolution = { provider: r.provider, modelId: r.modelId, revision: r.revision }
  const download = raw.download
  if (isRecord(download)) {
    const blocked = isRecord(download.blocked) && isNonEmptyString(download.blocked.code) ? { code: String(download.blocked.code), ...(isNonEmptyString(download.blocked.detail) ? { detail: String(download.blocked.detail) } : {}) } : null
    weights.download = {
      files: Array.isArray(download.files) ? download.files.filter(isNonEmptyString).map(String) : [],
      bytes: Number.isSafeInteger(download.bytes) && download.bytes >= 0 ? download.bytes : null,
      blocked,
      requiresAuth: isNonEmptyString(download.requiresAuth) ? String(download.requiresAuth) : null,
    }
  }
  return weights
}

/** 权重声明校验：bundled 就必须与磁盘逐字节一致；不 bundled 就必须**不带**伪 sha256/bytes（含 TBD 占位）。 */
export async function checkWeights(packRoot: string, raw: unknown, issues: PackIssue[]): Promise<PackWeights | null> {
  if (raw === null || raw === undefined) return null
  if (!isRecord(raw)) { issues.push({ path: 'policy.weights', code: 'WEIGHTS_NOT_OBJECT' }); return null }
  if (typeof raw.bundled !== 'boolean') {
    issues.push({ path: 'policy.weights.bundled', code: 'WEIGHTS_BUNDLED_FLAG_MISSING', detail: '必须显式声明字节是否随包（旧式“声明 file 但文件不存在”正是本字段要挡住的缺陷）' })
    return null
  }
  const weights = declaredWeights(raw)!
  const bundled = weights.bundled, availability = weights.availability
  const declaredAvailability: WeightAvailability[] = ['bundled', 'resolvable', 'unavailable', 'server-side']
  if (!declaredAvailability.includes(raw.availability as WeightAvailability)) issues.push({ path: 'policy.weights.availability', code: 'WEIGHTS_AVAILABILITY_INVALID', detail: String(raw.availability) })
  for (const key of ['providedBy', 'pin'] as const) if (isNonEmptyString(raw[key])) (weights as any)[key] = raw[key]
  for (const key of ['sha256', 'bytes', 'expectedSha256', 'expectedBytes', 'file']) if (isPlaceholder(raw[key])) issues.push({ path: `policy.weights.${key}`, code: 'WEIGHTS_DECLARATION_PLACEHOLDER', detail: '占位符不是身份：要么给真实 file/bytes/sha256，要么声明 bundled=false' })
  if (bundled) {
    if (!weights.file) issues.push({ path: 'policy.weights.file', code: 'WEIGHTS_FILE_MISSING' })
    if (weights.bytes === null || !weights.sha256) issues.push({ path: 'policy.weights', code: 'WEIGHTS_IDENTITY_MISSING', detail: 'bundled=true 必须有具体 bytes 与 sha256' })
    if (weights.file) {
      const target = join(packRoot, weights.file)
      if (!(await exists(target))) issues.push({ path: `policy.weights.file`, code: 'WEIGHTS_FILE_NOT_ON_DISK', detail: `${weights.file} 声明随包但磁盘不存在` })
      else {
        const actual = await sha256File(target)
        const size = (await stat(target)).size
        if (weights.sha256 && actual !== weights.sha256) issues.push({ path: 'policy.weights.sha256', code: 'WEIGHTS_SHA256_MISMATCH', detail: `声明 ${weights.sha256.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…` })
        if (weights.bytes !== null && size !== weights.bytes) issues.push({ path: 'policy.weights.bytes', code: 'WEIGHTS_BYTES_MISMATCH', detail: `声明 ${weights.bytes} 实际 ${size}` })
      }
    }
  } else {
    // 不随包的权重不得留下“看起来像身份”的字段——这正是 Go2/G1 旧声明的病灶。
    for (const key of ['sha256', 'bytes'] as const) if (raw[key] !== null && raw[key] !== undefined) issues.push({ path: `policy.weights.${key}`, code: 'WEIGHTS_NOT_BUNDLED_BUT_HAS_IDENTITY', detail: 'bundled=false 时不得声明内容哈希/字节数' })
    if (!isNonEmptyString(raw.providedBy)) issues.push({ path: 'policy.weights.providedBy', code: 'WEIGHTS_PROVENANCE_MISSING' })
    if (availability === 'bundled') issues.push({ path: 'policy.weights.availability', code: 'WEIGHTS_AVAILABILITY_CONTRADICTS_BUNDLED' })
  }
  if (raw.resolution !== undefined && raw.resolution !== null) {
    const r = raw.resolution
    if (!isRecord(r) || !isNonEmptyString(r.provider) || !isNonEmptyString(r.modelId) || !isNonEmptyString(r.revision)) issues.push({ path: 'policy.weights.resolution', code: 'WEIGHTS_RESOLUTION_INCOMPLETE', detail: '须给 provider/modelId/revision 三项' })
    else if (!['github', 'huggingface', 'modelscope', 'packs'].includes(r.provider)) issues.push({ path: 'policy.weights.resolution.provider', code: 'WEIGHTS_RESOLUTION_PROVIDER_UNSUPPORTED', detail: String(r.provider) })
    else weights.resolution = { provider: r.provider, modelId: r.modelId, revision: r.revision }
  }
  if (availability === 'resolvable' && !weights.resolution) issues.push({ path: 'policy.weights.resolution', code: 'WEIGHTS_RESOLVABLE_WITHOUT_SOURCE', detail: 'availability=resolvable 必须给出 resolution（客户端据此走已实现的取件来源）' })
  // 模型取件声明（下载侧）：形状必须可机器复算——坏路径/占位符/空清单不得当"随时能取"放行。
  if (raw.download !== undefined && raw.download !== null) {
    if (!isRecord(raw.download)) issues.push({ path: 'policy.weights.download', code: 'WEIGHTS_DOWNLOAD_NOT_OBJECT' })
    else {
      const declared = raw.download
      if (declared.files !== undefined && (!Array.isArray(declared.files) || declared.files.some((file: unknown) => !isNonEmptyString(file) || !isSafeSelector(String(file))))) issues.push({ path: 'policy.weights.download.files', code: 'WEIGHTS_DOWNLOAD_FILES_INVALID', detail: 'files 必须是非空字符串数组，逐项为不含前导 / 与 .. 的来源相对路径，或以 / 结尾的目录前缀（取件按它在来源真实清单上选择）' })
      if (declared.bytes !== undefined && declared.bytes !== null && !(Number.isSafeInteger(declared.bytes) && declared.bytes >= 0)) issues.push({ path: 'policy.weights.download.bytes', code: 'WEIGHTS_DOWNLOAD_BYTES_INVALID', detail: String(declared.bytes) })
      // 取件凭据前提：只认登记在册的种类——拼错一个词就静默变成"不需要凭据"是最坏的那种降级。
      if (declared.requiresAuth !== undefined && declared.requiresAuth !== null && !(isNonEmptyString(declared.requiresAuth) && (DOWNLOAD_CREDENTIAL_KINDS as readonly string[]).includes(declared.requiresAuth)))
        issues.push({ path: 'policy.weights.download.requiresAuth', code: 'WEIGHTS_DOWNLOAD_AUTH_UNKNOWN', detail: `未登记的凭据种类 ${String(declared.requiresAuth)}（已登记：${DOWNLOAD_CREDENTIAL_KINDS.join('|')}）` })
      if (declared.blocked !== undefined && declared.blocked !== null) {
        if (!isRecord(declared.blocked) || !isNonEmptyString(declared.blocked.code)) issues.push({ path: 'policy.weights.download.blocked', code: 'WEIGHTS_DOWNLOAD_BLOCK_INVALID', detail: 'blocked 必须给非空 code（客户端据此不给下载入口），detail 可选' })
        else if (isPlaceholder(declared.blocked.code)) issues.push({ path: 'policy.weights.download.blocked.code', code: 'WEIGHTS_DOWNLOAD_BLOCK_PLACEHOLDER', detail: '门禁码是给用户的原因，不是占位符' })
      }
      // 声明了取件清单却没有可校验来源坐标 ⇒ 客户端无法判断"从哪取"，如实报（不当可下载）。
      if (Array.isArray(declared.files) && declared.files.length > 0 && !weights.resolution) issues.push({ path: 'policy.weights.resolution', code: 'WEIGHTS_DOWNLOAD_WITHOUT_SOURCE', detail: '给了取件清单却未给 resolution：客户端无处取件' })
    }
  }
  return weights
}
/** 来源相对路径（与 source.ts 的 policyFile 同口径的**只读**子集）：不含前导 /、反斜杠或 .. 段。 */
const isSafeRelativePath = (value: string): boolean => Boolean(value) && !value.startsWith('/') && !value.includes('\\') && value.split('/').every((part) => part && part !== '.' && part !== '..')
/** 来源选择项（与 source.ts 的 `policyFileSelector` 同口径）：精确路径，或 `前缀/` 形式的目录前缀。 */
const isSafeSelector = (value: string): boolean => value.endsWith('/') ? isSafeRelativePath(value.slice(0, -1)) : isSafeRelativePath(value)

/** 归一化统计一致性：同一文件在 manifest 两处出现（normalization.sha256 与 weights.normStatsFile）必须同源同值。 */
async function checkNormalization(packRoot: string, manifest: Record<string, any>, issues: PackIssue[]) {
  const norm = manifest.normalization
  const statFile = isRecord(manifest.weights) && isRecord(manifest.weights.normStatsFile) ? manifest.weights.normStatsFile : null
  const relative = isRecord(norm) && isNonEmptyString(norm.stats) ? norm.stats : statFile && isNonEmptyString(statFile.file) ? statFile.file : null
  if (isRecord(norm) && norm.stats !== undefined && !isNonEmptyString(norm.stats)) issues.push({ path: 'policy.normalization.stats', code: 'NORM_STATS_PATH_INVALID' })
  if (!relative) {
    if (norm || statFile) issues.push({ path: 'policy.normalization', code: 'NORM_STATS_PATH_MISSING', detail: '有归一化声明却没有可核对的 stats 路径' })
    return
  }
  const target = join(packRoot, relative)
  if (!(await exists(target))) { issues.push({ path: relative, code: 'NORM_STATS_FILE_NOT_ON_DISK' }); return }
  const actual = await sha256File(target), size = (await stat(target)).size
  const declared = [isRecord(norm) && isHex64(norm.sha256) ? { path: 'policy.normalization.sha256', value: norm.sha256 as string } : null, statFile && isHex64(statFile.sha256) ? { path: 'policy.weights.normStatsFile.sha256', value: statFile.sha256 as string } : null].filter(Boolean) as Array<{ path: string; value: string }>
  if (!declared.length) issues.push({ path: 'policy.normalization.sha256', code: 'NORM_STATS_HASH_MISSING', detail: '统计文件入包必须入哈希台账' })
  for (const entry of declared) if (entry.value !== actual) issues.push({ path: entry.path, code: 'NORM_STATS_SHA256_MISMATCH', detail: `声明 ${entry.value.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…（同一文件两处声明必须同源同值）` })
  if (declared.length === 2 && declared[0]!.value !== declared[1]!.value) issues.push({ path: 'policy.normalization.sha256', code: 'NORM_STATS_SELF_INCONSISTENT', detail: 'normalization.sha256 与 weights.normStatsFile.sha256 互相矛盾' })
  if (statFile && Number.isSafeInteger(statFile.bytes) && statFile.bytes !== size) issues.push({ path: 'policy.weights.normStatsFile.bytes', code: 'NORM_STATS_BYTES_MISMATCH', detail: `声明 ${statFile.bytes} 实际 ${size}` })
  for (const key of ['bytes', 'sha256'] as const) if (statFile && isPlaceholder(statFile[key])) issues.push({ path: `policy.weights.normStatsFile.${key}`, code: 'NORM_STATS_PLACEHOLDER' })
  // 维度契约：数组实际宽度 + 有效维 + 补零位必须为 0（π0.5 检查点补零到 32，有效维才是语义维）。
  // 只有 π0.5 形（含 norm_stats）才适用；G05 的 dataset_stats 是逐动作步分组的异构 schema，留给该族的专门核对。
  const width = isRecord(norm) && Number.isInteger(norm.arrayWidth) ? norm.arrayWidth : null
  const effective = isRecord(norm) && Number.isInteger(norm.effectiveDim) ? norm.effectiveDim : null
  const parsed = await readObjectOrNull(target)
  if (!isRecord(parsed?.norm_stats)) return
  if (width === null || effective === null) issues.push({ path: 'policy.normalization', code: 'NORM_DIMS_UNDECLARED', detail: '须声明 arrayWidth（文件内数组宽度）与 effectiveDim（语义维），否则归一化统计无法核对' })
  else {
    const stats = parsed.norm_stats as Record<string, any>
    for (const group of ['actions', 'state']) {
      const entry = isRecord(stats[group]) ? stats[group] : null
      if (!entry) { issues.push({ path: `${relative}#norm_stats.${group}`, code: 'NORM_STATS_GROUP_MISSING' }); continue }
      for (const key of ['mean', 'std', 'q01', 'q99']) {
        const row = entry[key]
        if (!Array.isArray(row) || !row.every((x: unknown) => typeof x === 'number')) { issues.push({ path: `${relative}#${group}.${key}`, code: 'NORM_STATS_ROW_INVALID' }); continue }
        if (row.length !== width) issues.push({ path: `${relative}#${group}.${key}`, code: 'NORM_ARRAY_WIDTH_MISMATCH', detail: `声明 arrayWidth=${width} 实际 ${row.length}` })
        else if (row.slice(effective).some((x: number) => x !== 0)) issues.push({ path: `${relative}#${group}.${key}`, code: 'NORM_PADDING_NOT_ZERO', detail: `第 ${effective} 维之后必须为补零` })
      }
    }
  }
}

/**
 * 路由判据的唯一实现（内容侧 inspectPack 与客户端 preparePolicy 共用同一份，避免两处各写一套而漂移）。
 * 输入是**已取到的声明事实**（mode/adapter/weights/观测动作/deps/模型入口），输出是可执行的下一步。
 * 关键纪律：
 *  - `mode=direct-control` 绝不进任何需要权重的分支（直控包的 channels 来自自身声明）；
 *  - 服务端推理按**适配器种类**判（`*-server-side`），不看作者写的 mode，也不看字符串 declaration；
 *  - base-policy 必须有**代码侧登记**的 (包, 适配器, 来源) 三元组才算可装配（Go1 教训：不借同族适配器）。
 */
export interface PackRouteInput {
  packId: string
  mode: PackMode | null
  adapter: string | null
  weights: PackWeights | null
  /** 包声明的能力（catalog 条目 / pack.json 的 capabilities）；直控路由的 channels 首选它，缺省回落 action.channelsUsed */
  capabilities?: { channels?: unknown } | null
  deps?: unknown
  inference?: { stack?: unknown; implemented?: unknown } | null
  observations?: Record<string, unknown>
  actions?: Record<string, unknown>
  /** 模型入口：内容侧给**包相对**路径；客户端给**本次已校验缓存根下的绝对路径**（两侧同一字段不同口径，见 adapter.ts）。 */
  modelEntry?: string | null
  /** 控制路径说明（direct-control 包的执行语义来自 policy manifest notes 或 vla/adapter.json 的 controlPath） */
  controlPath?: string | null
}

export function resolvePackRoute(args: PackRouteInput): { route: PackRoute; issues: PackIssue[] } {
  const issues: PackIssue[] = []
  const { packId, mode, adapter, weights } = args
  const observations = args.observations ?? {}
  const actions = args.actions ?? {}
  const deps = Array.isArray(args.deps) ? args.deps.filter(isNonEmptyString) : []
  const declaredChannels = args.capabilities && Array.isArray((args.capabilities as any).channels) ? ((args.capabilities as any).channels as unknown[]).filter(isNonEmptyString) : []
  const usedChannels = Array.isArray(actions.channelsUsed) ? (actions.channelsUsed as unknown[]).filter(isNonEmptyString) : []
  const serverSide = adapter !== null && /server-side/.test(adapter)
  if (serverSide && mode !== 'direct-control') {
    const served = IMPLEMENTED_SERVER_SIDE_INFERENCE.some((entry) => entry.adapter === adapter && entry.packs.includes(packId))
    issues.push({ path: 'policy.manifest.inference.implemented', code: 'SERVER_SIDE_INFERENCE_NOT_IMPLEMENTED', detail: `adapter=${adapter} 只有字符串声明（manifest.inference.implemented=${String(args.inference?.implemented)}），客户端侧无已见推理实现` })
    // 执行侧与下载侧**各自出事实**：本服务不推理，也不承诺承载权重字节；模型字节能取与否由内容侧声明
    // （weights.resolution/download）复算，客户端据此决定要不要给出下载入口。
    const model = resolveModelFace({ weights, adapter })
    return { issues, route: served
      ? { kind: 'server-side-inference', adapter: adapter!, stack: isNonEmptyString(args.inference?.stack) ? String(args.inference!.stack) : null, observations, actions, nextSteps: ['经服务端推理接口取动作块'] }
      // 解锁路径只有**客户端**适配器这一条：本服务按合同不推理、不承载权重字节，所以不许把
      // "部署服务端推理"写成可选项（那样会把服务端悄悄变回推理托管方）。
      : { kind: 'unavailable', code: 'POLICY_ADAPTER_UNAVAILABLE', model, detail: `客户端无 ${adapter} 的推理实现（执行侧阻断；模型能否取件看 model 面，两者独立）`, nextSteps: ['补齐客户端推理适配器并留实跑回执后，本包 policy 面才可从 blocked 改判（本服务不提供推理，不存在"部署服务端推理"这条解锁路径）', ...(model && !model.downloadable ? [`模型取件当前不可用：${model.code}${model.detail ? '（' + model.detail + '）' : ''}`] : [])] } }
  }
  if (mode === 'direct-control') {
    if (adapter !== 'none') issues.push({ path: 'policy.manifest.adapter', code: 'DIRECT_CONTROL_ADAPTER_NOT_NONE', detail: `mode=direct-control 却声明 adapter=${adapter}` })
    if (!Object.keys(actions).length) issues.push({ path: 'policy.manifest.action', code: 'DIRECT_CONTROL_ACTION_SEMANTICS_MISSING' })
    if (args.deps !== undefined && !Array.isArray(args.deps)) issues.push({ path: 'policy.manifest.deps', code: 'POLICY_DEPS_INVALID' })
    const channels = declaredChannels.length ? declaredChannels : usedChannels
    return { issues, route: { kind: 'direct-control', controlPath: (isNonEmptyString(args.controlPath) ? String(args.controlPath) : '').slice(0, 200) || 'System-2 直控（任务级 setpoint + 本地伺服）', modelEntry: args.modelEntry ?? null, deps, channels, observations, actions, nextSteps: ['scene_import 导入 route.modelEntry（包内 asset 模型入口）→ sim_open → robot_load → robot_describe 核对关节/限位/通道 → 用 channels 里的直控通道下发动作 → robot_stop 停止并核对保持'] } }
  }
  if (mode === 'base-policy') {
    const source = weights?.resolution ?? null
    const implemented = implementedFor(packId, adapter, source)
    if (adapter !== null && !(IMPLEMENTED_ADAPTERS as readonly string[]).includes(adapter)) issues.push({ path: 'policy.manifest.adapter', code: 'POLICY_ADAPTER_KIND_UNKNOWN', detail: String(adapter) })
    if (!weights) issues.push({ path: 'policy.manifest.weights', code: 'POLICY_WEIGHTS_UNDECLARED', detail: 'base-policy 必须显式声明权重可得性（bundled/resolvable/unavailable）' })
    else if (!['bundled', 'resolvable'].includes(weights.availability) || (!weights.bundled && !source)) issues.push({ path: 'policy.weights.availability', code: 'POLICY_WEIGHTS_NOT_OBTAINABLE', detail: 'base-policy 需要权重字节：随包（bundled）或登记已实现来源（resolvable+resolution）' })
    if (!implemented) issues.push({ path: 'policy.manifest.adapter', code: 'POLICY_ADAPTER_UNIMPLEMENTED', detail: `客户端未登记 (packId=${packId}, adapter=${adapter}, source=${source ? `${source.modelId}@${source.revision.slice(0, 12)}…` : 'none'}) 的执行适配器` })
    // 取件清单回落：内容侧没写 weights.download 时，用已登记适配器的 requires（代码事实）——装配校验与取件
    // 提示读同一份，不另写一份文件清单，也不因为"内容侧没重复登记"就误判成取不到。
    const model = resolveModelFace({ weights, adapter, files: implemented ? adapterDownloadFiles(implemented) : [] })
    return { issues, route: implemented
      ? { kind: 'policy-source', adapterId: implemented.id, modelEntry: args.modelEntry ?? null, adapter: adapter!, source: source!, weightsAvailability: weights!.availability, model, deps, observations, actions, nextSteps: [weights?.bundled ? `weights.bundled=true ⇒ 用包内权重（policy_prepare 走 ${implemented.id} 适配器）` : `policy_download({provider:"${source!.provider}",modelId:"${source!.modelId}",revision:"${source!.revision}",files:[${adapterDownloadFiles(implemented).map(file => `"${file}"`).join(',')}]}) 取权重 → policy_prepare（适配器 ${implemented.id}）→ policy_match → policy_execute`] }
      : { kind: 'unavailable', code: 'POLICY_ADAPTER_UNAVAILABLE', model, detail: `客户端无 (${packId}, ${adapter ?? 'none'}) 的执行适配器登记`, nextSteps: ['按 issue 补齐适配器或权重来源；不得借用同族其它包的适配器（Go1 教训）'] } }
  }
  if (mode === 'vla-base') return { issues, route: { kind: 'unavailable', code: 'POLICY_ADAPTER_UNAVAILABLE', model: resolveModelFace({ weights, adapter }), detail: `vla-base 包声明 adapter=${String(adapter)}，客户端无对应 VLA 执行适配器`, nextSteps: ['VLA 执行走各自 bench 链路，不进 policy_execute；不得按维度硬配机器人'] } }
  if (mode === 'external-controller') return { issues, route: { kind: 'unavailable', code: 'EXTERNAL_CONTROLLER_NOT_INTEGRATED', detail: '外部控制器桥未集成', nextSteps: ['接入外部控制器桥后重新装配'] } }
  return { issues, route: { kind: 'unavailable', code: 'PACK_CONTRACT_UNRESOLVED', detail: 'pack.json / policy manifest 不可解析', nextSteps: ['先修内容四件套'] } }
}

/**
 * 单个能力包的复算：给定包根目录（`packs/<packId>`），返回三级状态 + 装配/执行路由 + 逐条 issue。
 * 只读，不改任何文件；调用方（verify-packs / policy_prepare）用同一份结果说话。
 */
export async function inspectPack(packRoot: string): Promise<PackContract> {
  const issues: PackIssue[] = []
  const pack = await readObjectOrNull(join(packRoot, 'pack.json'))
  if (!pack) issues.push({ path: 'pack.json', code: 'PACK_MANIFEST_UNREADABLE' })
  const packId = String(pack?.packId ?? '')
  const pieces = isRecord(pack?.pieces) ? pack!.pieces : {}
  const pieceFiles: Record<string, number> = {}
  for (const piece of ['asset', 'context', 'policy', 'vla'] as const) {
    const dir = join(packRoot, piece)
    const declared = pieces[piece]
    const declaredStatus = typeof declared === 'string' ? declared : String(declared?.status ?? '')
    const blocked = declaredStatus.startsWith('blocked')
    const count = await exists(dir) ? (await readdir(dir)).length : 0
    pieceFiles[piece] = count
    if (count === 0 && !blocked) issues.push({ path: `${piece}/`, code: 'PIECE_MISSING_UNDECLARED' })
  }
  const manifest = await readObjectOrNull(join(packRoot, 'policy', 'manifest.json'))
  if (!manifest) issues.push({ path: 'policy/manifest.json', code: 'POLICY_MANIFEST_UNREADABLE' })
  const mode = PACK_MODES.includes(manifest?.mode) ? manifest!.mode as PackMode : null
  if (manifest && !mode) issues.push({ path: 'policy.manifest.mode', code: 'POLICY_MODE_INVALID', detail: String(manifest.mode) })
  if (manifest && !isNonEmptyString(manifest.status)) issues.push({ path: 'policy.manifest.status', code: 'POLICY_STATUS_MISSING' })
  const adapter = isNonEmptyString(manifest?.adapter) ? manifest!.adapter as string : null
  const weights = manifest ? await checkWeights(packRoot, manifest.weights, issues) : null
  if (manifest) await checkNormalization(packRoot, manifest, issues)
  let behaviorVerified = false
  if (manifest) {
    const verified = isRecord(manifest.verified) ? manifest.verified : null
    const behavior = verified && isRecord(verified.behavior) ? verified.behavior : null
    if (behavior?.status === 'PASS') {
      const result = await validateBehaviorEvidence(packRoot, behavior.evidence)
      issues.push(...result.issues)
      behaviorVerified = result.valid
    } else if (behavior && behavior.status !== undefined && !['UNVERIFIED', 'PARTIAL', 'BLOCKED'].includes(String(behavior.status))) {
      issues.push({ path: 'policy.verified.behavior.status', code: 'BEHAVIOR_STATUS_INVALID', detail: String(behavior.status) })
    }
  }
  // 模型入口：**按包内显式登记**解析并用既有 parseAsset 复核（XML 合法性 + 依赖闭包）。
  // 没登记不猜、不回落文件名扫描（旧实现靠候选打分，实测猜错并静默给 null）。
  const assets = declaredAssetEntries(pack)
  if (!assets) issues.push({ path: 'pack.json#asset.modelEntry', code: 'MODEL_ENTRY_UNDECLARED', detail: '包内未登记 asset.modelEntry（包相对路径，如 asset/scene.xml）；需要区分导入场景与机器人本体时再登记 asset.model' })
  else for (const entry of [...new Set([assets.modelEntry, assets.model])]) {
    try { await resolveAssetEntry(packRoot, entry) }
    catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT' ? String((error as NodeJS.ErrnoException).path ?? '') : ''
      // 依赖件缺失（include/mesh/…）只挡装配：入口文件本身在、字节完好，缺的是它引用的件。
      if (missing && resolve(missing) !== resolve(packRoot, entry)) issues.push({ path: packRelative(packRoot, missing), code: 'MODEL_ENTRY_DEPENDENCY_MISSING', detail: `${entry} 引用的依赖件不在包内` })
      else issues.push({ path: entry, code: 'MODEL_ENTRY_INVALID', detail: (error as Error).message })
    }
  }
  const modelEntry = assets?.modelEntry ?? null
  const vla = await readObjectOrNull(join(packRoot, 'vla', 'adapter.json'))
  if (pieceFiles.vla !== 0 && !vla) issues.push({ path: 'vla/adapter.json', code: 'VLA_ADAPTER_UNREADABLE' })

  const observations = isRecord(vla?.observation) ? vla!.observation : isRecord(manifest?.observation) ? manifest!.observation : {}
  const actions = isRecord(vla?.action) ? vla!.action : isRecord(manifest?.action) ? manifest!.action : {}
  const contentReady = issues.every((issue) => !['PIECE_MISSING_UNDECLARED', 'PACK_MANIFEST_UNREADABLE', 'POLICY_MANIFEST_UNREADABLE', 'POLICY_MODE_INVALID', 'POLICY_STATUS_MISSING', 'WEIGHTS_BUNDLED_FLAG_MISSING', 'WEIGHTS_FILE_MISSING', 'WEIGHTS_FILE_NOT_ON_DISK', 'WEIGHTS_IDENTITY_MISSING', 'WEIGHTS_SHA256_MISMATCH', 'WEIGHTS_BYTES_MISMATCH', 'WEIGHTS_NOT_BUNDLED_BUT_HAS_IDENTITY', 'WEIGHTS_PROVENANCE_MISSING', 'WEIGHTS_DECLARATION_PLACEHOLDER', 'NORM_STATS_FILE_NOT_ON_DISK', 'NORM_STATS_SHA256_MISMATCH', 'NORM_STATS_SELF_INCONSISTENT', 'NORM_STATS_BYTES_MISMATCH', 'NORM_STATS_HASH_MISSING', 'NORM_STATS_PLACEHOLDER', 'NORM_STATS_UNREADABLE', 'NORM_ARRAY_WIDTH_MISMATCH', 'NORM_PADDING_NOT_ZERO', 'MODEL_ENTRY_UNDECLARED', 'MODEL_ENTRY_INVALID', 'VLA_ADAPTER_UNREADABLE'].includes(issue.code))
  // 依赖件缺失只挡装配（字节可能完好，但 scene_import/robot_load 会因缺网格失败），不改变"内容齐"的判定。
  const assemblyBlocked = issues.some((issue) => issue.code === 'MODEL_ENTRY_DEPENDENCY_MISSING')

  // ---- 执行路由：与客户端 preparePolicy 共用 resolvePackRoute（一份判据，两处调用） ----
  const resolved = resolvePackRoute({
    packId, mode, adapter, weights,
    capabilities: isRecord(pack?.capabilities) ? pack!.capabilities : null,
    deps: manifest?.deps,
    inference: isRecord(manifest?.inference) ? manifest!.inference : null,
    observations, actions, modelEntry,
    controlPath: isNonEmptyString(vla?.controlPath) ? String(vla!.controlPath) : isNonEmptyString(manifest?.notes) ? String(manifest!.notes) : null,
  })
  issues.push(...resolved.issues)
  const route = resolved.route
  const adapterReady = contentReady && !assemblyBlocked && route.kind !== 'unavailable'
  return { packId: packId || 'unknown', version: isNonEmptyString(pack?.version) ? pack!.version : null, mode, adapter, declaredStatus: isNonEmptyString(manifest?.status) ? manifest!.status : null, contentReady, adapterReady, behaviorVerified, route, issues, modelEntry, weights }
}
