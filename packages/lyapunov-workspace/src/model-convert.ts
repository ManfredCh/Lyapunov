/**
 * 模型预览宿主端：把浏览器渲不了的模型原件转成"浏览器能渲的数据"。
 *
 * 三类在客户端渲不了，必须由 Host 出数据（客户端只做消费，见 model-preview.tsx）：
 *  1. `.blend` / `.usd` / `.usda` / `.usdc`（以及模型预览面的二进制 `.usdz`）：交给真实 Blender 无头导出 GLB（内容寻址缓存）；
 *  2. `.xml` / `.mjcf` / `.urdf`：交给 scene-kit 的 `robotVisual()` 出机器人可视化数据；
 *  3. 其余：如实返回 unsupported 与人类可读原因，不留白屏。
 * 另外这里出"字节通路"（GET 路由的纯函数实现）：`fileByteResponse()` 按 Range 流式读原件/产物，
 * `decoderAssetResponse()` 出 three 自带的 DRACO/KTX2 解码器静态资源。
 *
 * 这里刻意不依赖 cordis 上下文：转换/取数/发字节都是纯函数，Host 只负责注入 spawn 缝与缓存根，
 * 于是同一段代码可以直接 `bun -e` 真跑（见 bugfixHistory 回执）。
 * 路径安全与 RPC 侧 `target()` 同款：先 realpath 再判包含，软链逃逸与越界一律拒绝。
 */
import {createHash} from "node:crypto"
import {createReadStream,existsSync} from "node:fs"
import {mkdtemp,mkdir,readdir,readFile,realpath,rename,rm,stat,writeFile} from "node:fs/promises"
import {Readable} from "node:stream"
import {tmpdir} from "node:os"
import {dirname,isAbsolute,join,relative,resolve,sep} from "node:path"
import {parseAsset,robotVisual} from "../../scene-kit/src/formats.ts"
// 扩展名分类只有一份真相（`model-source.ts` 是**纯**模块，浏览器拖拽侧也 import 它）；这里取用并原样再导出，
// 既有调用方（`plugin.ts` 等）继续从本文件取 `convertSourceOf`，API 不变。
import {convertSourceOf,type ModelConvertSource} from "./model-source.ts"
export {convertSourceOf,convertSourceLabel,type ModelConvertSource} from "./model-source.ts"

/** 单次 Blender 转换的默认超时（毫秒）。冷启动本身就要数秒，120s 只挡真挂死。 */
export const DEFAULT_CONVERT_TIMEOUT_MS=120000
/** 单次转换产物（GLB）的默认上限：24 MiB。超限不上缓存、不进响应，如实报真实字节数。 */
export const DEFAULT_MAX_OUTPUT_BYTES=24*1024*1024
/** 完整源件导入保留全部几何/纹理；真实534MiB FBX导出约460MiB，不能套轻量预览额度。 */
export const DEFAULT_IMPORT_CONVERT_TIMEOUT_MS=10*60*1000
export const DEFAULT_MAX_IMPORT_OUTPUT_BYTES=512*1024*1024
/** 能走 `robotVisual()` 的机器人描述格式。 */
const ROBOT_EXTENSIONS=[".xml",".mjcf",".urdf"]
/**
 * 默认 Blender 可执行文件。
 *
 * 优先用 snap 的**真实可执行文件** `/snap/blender/current/blender`：`/snap/bin/blender` 只是
 * snap 包装器（会先做一次沙箱/环境准备），从无头子进程直接调它多一层包装、失败面更大；
 * 真实文件存在时直接调它。两者都没有才回落 PATH 上的 `blender`（调用方仍可用
 * `BLENDER_EXECUTABLE` 或配置显式覆盖）。
 */
export function defaultBlenderExecutable():string {
  const snap="/snap/blender/current/blender"
  return existsSync(snap)?snap:"blender"
}

/** 调用方注入的子进程缝：与 `ctx.subprocess.spawn` 同形（只取这里真正用到的那部分）。 */
export interface BlenderProcessHandle {
  readonly collected: {stdout?: {readFrom(offset:number):{text:string}}|undefined;stderr?: {readFrom(offset:number):{text:string}}|undefined}
  readonly done: Promise<{exitCode:number|null;signal:NodeJS.Signals|null}>
  terminate():void
}
export type SpawnBlender=(argv:string[],options:{cwd:string;signal:AbortSignal})=>BlenderProcessHandle
/** 转换与机器人取数的可选输入；`spawn` 不给即视为"这台 Host 没有子进程能力"。 */
export interface ModelConvertOptions {
  cacheRoot:string
  spawn?:SpawnBlender
  blenderExecutable?:string
  timeoutMs?:number
  maxOutputBytes?:number
  /** 唯一转换实现内区分轻量预览与已登记资源的完整导入，不改变授权或导出质量。 */
  purpose?:"preview"|"import"
  /** 相对路径的解析基准；默认产品根（含会话工作区，见 runtimePaths.workspaceRoot）。 */
  base?:string
  signal?:AbortSignal
}
export interface ConvertedGlb {bytes:Buffer;cachedPath:string;convertMs:number;source:ModelConvertSource;/** true＝直接命中已有缓存（没有调用 Blender）。 */cached:boolean;/** 缓存身份的人类可读依据（依赖是否核验、来自哪个资源版本）。 */cacheBasis?:string}
/**
 * 一次转换的缓存身份：**由会话资源版本 + 已核验依赖**生成，而不是"主文件没变"。
 *
 * 为什么不能只用主文件哈希：`.blend` 的外部纹理/链接库、`.usda` 的外部引用都**不在主文件字节里**，
 * 主文件没变不等于依赖没变。`key` 参与缓存键，`reusable=false` 时本次**不读旧缓存**（依赖无法核验就
 * 不复用不可靠产物），但产物仍写进缓存域供资源登记读取，且键带上 `unverified` 标记，不会被可信路径复用。
 */
export interface ConvertCacheIdentity {key:string;reusable:boolean;basis:string}
/** 缓存身份输入：资源身份 + 该版本的依赖文件戳 + 是否已完整核验（外部引用不算"无依赖"）。 */
export interface ConvertCacheIdentityInput {
  resourceId:string
  version:number
  dependencies:ReadonlyArray<{path:string;size:number;sha256:string}>
  /** true＝依赖闭包已由资源解析器核验（`.blend` 需 Blender 确认真实外部文件）；false＝无法核验。 */
  dependenciesVerified:boolean
  /** false 时给出人类可读原因（进回执）。 */
  unverifiedReason?:string
  /** 转换器版本/参数：导出脚本或参数变化必须改变缓存身份；缺省用 `CONVERT_CACHE_VERSION`。 */
  converterVersion?:string
  /** 用户显式partial模式只核所存可用子集，损失清单/模式独立入key，不能冒称完整依赖。 */
  textureSnapshot?:{mode:'strict'|'available';losses:unknown[];subsetVerified:boolean}
}
/** 转换器（注入脚本 + 导出参数）版本；改动导出方式时必须同步改这个值。 */
export const CONVERT_CACHE_VERSION="blender-glb-v3-texture-snapshot"
/** 由资源版本 + 依赖清单生成缓存身份（纯函数，便于直接验证"换依赖必换键"）。 */
export function convertCacheIdentity(input:ConvertCacheIdentityInput):ConvertCacheIdentity {
  const dependencies=[...input.dependencies].map(dependency=>({path:dependency.path,size:dependency.size,sha256:dependency.sha256})).sort((left,right)=>left.path.localeCompare(right.path))
  const key=JSON.stringify({converter:input.converterVersion??CONVERT_CACHE_VERSION,resourceId:input.resourceId,version:input.version,dependenciesVerified:input.dependenciesVerified,dependencies,...input.textureSnapshot?{textureSnapshot:input.textureSnapshot}:{}})
  const partialReusable=input.textureSnapshot?.mode==='available'&&input.textureSnapshot.subsetVerified
  const basis=input.dependenciesVerified
    ? `${input.resourceId}@${input.version} 的 ${dependencies.length} 个依赖文件已核验（主件 + 外部引用）`
    : partialReusable?`${input.resourceId}@${input.version} 的现有材质子集 ${dependencies.length} 文件已核验；${input.textureSnapshot!.losses.length} 条损失声明保留，非完整纹理闭包`:`${input.resourceId}@${input.version} 的依赖无法核验（${input.unverifiedReason??"未提供依赖清单"}）：本次不复用旧缓存`
  return {key,reusable:input.dependenciesVerified||partialReusable,basis}
}
/**
 * 依赖核验：把资源记录里登记的每个依赖文件**按当前磁盘字节重算** sha256，与记录逐项比对。
 *
 * 为什么不能只看主文件：`.blend` 的外部纹理、`.usda` 的外部引用都不在主文件字节里，主文件没变不等于
 * 依赖没变。这里不新增任何格式解析器（依赖清单仍来自 `parseAsset`），只做"记录身份 vs 当前字节"的核对；
 * 缺失/大小或内容不同都返回 `verified:false`，让调用方把本次转换标记为不可复用缓存。
 */
export async function verifyDependencies(dependencies:ReadonlyArray<{path:string;size:number;sha256:string}>):Promise<{verified:boolean;reason?:string}> {
  for(const dependency of dependencies){
    try {
      const info=await stat(dependency.path)
      if(!info.isFile())return {verified:false,reason:`依赖不是一个文件：${dependency.path}`}
      if(info.size!==dependency.size)return {verified:false,reason:`依赖大小已变（记录 ${dependency.size}，当前 ${info.size}）：${dependency.path}`}
      if(await sha256File(dependency.path)!==dependency.sha256)return {verified:false,reason:`依赖内容已变（sha256 与记录不符）：${dependency.path}`}
    }catch(error){return {verified:false,reason:`依赖不可读（${(error as Error).message}）：${dependency.path}`}}
  }
  return {verified:true}
}
/** 从**本会话资源 owner**解析出的源工程：路径绝不再来自客户端字符串，边界由资源登记保证。 */
export interface RegisteredConvertSource {path:string;cacheIdentity:ConvertCacheIdentity;assetRemap?:Record<string,string>;texturePolicy?:'strict'|'available'}
export interface RobotPreview {robot:Record<string,unknown>;sourcePath:string}

/** 预览层可判定的失败：原因人类可读，由 RPC 侧翻成 `{kind:"unsupported",reason}`。 */
export class ModelPreviewUnsupported extends Error {
  constructor(reason:string){super(reason);this.name="ModelPreviewUnsupported"}
}
/** 宿主装配缺子进程能力：这是 Host 配置问题，不是"这个文件不支持"，按 RPC 级错误抛出。 */
export class ModelPreviewUnavailable extends Error {
  constructor(reason:string){super(reason);this.name="ModelPreviewUnavailable"}
}

/** 产品根：优先装配方显式传入，未传时从本文件向上找 UPSTREAM_LOCK.json（与 scene-kit/plugin.ts、script/profile.ts 同一约定）。 */
export function productRoot(configured?:string):string {
  if(configured)return resolve(configured)
  let directory=resolve(import.meta.dirname)
  while(!existsSync(join(directory,"UPSTREAM_LOCK.json"))){
    const parent=dirname(directory)
    if(parent===directory)throw new Error("找不到LyapunovDSH安装根目录")
    directory=parent
  }
  return directory
}
/**
 * 与 RPC 侧 `ctx.fs.contains` 同款的包含判定：先把候选路径 realpath 成规范路径，再做相对路径检查。
 * 软链指向根外时真实路径已经越界，因此这里的拒绝发生在把路径喂给 Blender 之前。
 */
function contains(root:string,candidate:string):boolean {
  const path=relative(root,candidate)
  return path===""||(path!==".."&&!path.startsWith(`..${sep}`)&&!isAbsolute(path))
}
/**
 * 解析并校验一个输入路径：绝对路径直接用，相对路径按 `base` 解析；
 * 必须落在 `base`（通常是会话 cwd）或产品根内，否则拒绝。返回规范绝对路径。
 */
export async function resolveModelPath(path:string,base:string):Promise<string> {
  if(typeof path!=="string"||!path.trim())throw new ModelPreviewUnsupported("模型路径为空")
  if(path.includes("\0"))throw new ModelPreviewUnsupported("模型路径含非法字符（NUL）")
  const root=await realpath(base)
  let target:string
  try{target=await realpath(isAbsolute(path)?path:resolve(root,path))}
  catch(error){
    if((error as NodeJS.ErrnoException).code==="ENOENT")throw new ModelPreviewUnsupported(`文件不存在或不是有效路径：${isAbsolute(path)?path:resolve(root,path)}`)
    throw new ModelPreviewUnsupported(`无法解析模型路径（${(error as NodeJS.ErrnoException).code??"未知错误"}）：${path}`)
  }
  if(!contains(root,target)&&!contains(productRoot(),target))throw new ModelPreviewUnsupported(`路径越界：${target} 既不在会话工作区 ${root} 内，也不在产品根 ${productRoot()} 内`)
  return target
}
/** 是否是机器人描述格式（`.xml` 由内容判定，见 robotPreview）。 */
export function isRobotPath(path:string):boolean {
  const lower=path.toLowerCase()
  return ROBOT_EXTENSIONS.some(extension=>lower.endsWith(extension))
}
/** 人类可读字节数，只用于失败原因。 */
function sizeText(bytes:number):string {
  return bytes>=1048576?`${(bytes/1048576).toFixed(1)} MiB`:`${Math.ceil(bytes/1024)} KiB`
}
/** 源文件内容哈希：缓存键。按流算，避免把大件整块读进内存。 */
async function sha256File(path:string):Promise<string> {
  const hash=createHash("sha256")
  const {createReadStream}=await import("node:fs")
  for await(const chunk of createReadStream(path))hash.update(chunk as Buffer)
  return hash.digest("hex")
}
/** 缓存根缺失时的兜底：临时目录。调用方应在回执里说明走了兜底。 */
export function fallbackCacheRoot():string {
  return join(tmpdir(),"lyapunov-model-preview")
}
/**
 * 推断本运行根的 cache 域，供 Host 装配时调用（纯函数，便于直接跑）。
 *
 * 运行根的判据是真实的磁盘形状，而不是猜路径字符串：
 *  - 候选目录本身叫 `cache`、或它下面有 `cache/`，就是运行根；
 *  - 候选是运行根下的一级目录（产品把 `review-comments`、`recordings` 这类放在运行根下），
 *    则父目录是运行根；
 * 都判不出来就回落 `os.tmpdir()`，并让调用方知道走了兜底（回执里必须写明）。
 */
export function resolveCacheRoot(candidates:Array<string|undefined>):{cacheRoot:string;fallback?:boolean;basis?:string} {
  for(const candidate of candidates){
    if(!candidate||!candidate.trim())continue
    const start=resolve(candidate)
    if(start.endsWith(`${sep}cache`))return {cacheRoot:start,basis:start}
    if(existsSync(join(start,"cache")))return {cacheRoot:join(start,"cache"),basis:start}
    const parent=dirname(start)
    if(parent!==start&&existsSync(join(parent,"cache")))return {cacheRoot:join(parent,"cache"),basis:start}
  }
  return {cacheRoot:fallbackCacheRoot(),fallback:true}
}
function cacheDirectory(cacheRoot:string):string {
  return join(resolve(cacheRoot),"model-preview")
}
function cachePaths(cacheRoot:string,sha256:string){
  const directory=cacheDirectory(cacheRoot)
  return {directory,glb:join(directory,`${sha256}.glb`),meta:join(directory,`${sha256}.json`)}
}
/**
 * 缓存命中判据：`.glb` 与 `.json` 都在，且记录的字节数与真实文件大小一致。
 * 半截写入（崩溃/断电）不会命中：先写临时名再 rename，且以 size 复核。
 */
async function readCached(cacheRoot:string,sha256:string,maxOutputBytes:number,fullImport:boolean):Promise<ConvertedGlb|undefined> {
  const paths=cachePaths(cacheRoot,sha256)
  try {
    const meta=JSON.parse(await readFile(paths.meta,"utf8")) as {bytes?:number;convertMs?:number;source?:ModelConvertSource;cacheBasis?:string}
    const info=await stat(paths.glb)
    if(!info.isFile()||info.size<=0)return undefined
    if(typeof meta.bytes!=="number"||meta.bytes!==info.size)return undefined
    if(meta.source!=='blend'&&meta.source!=='usd'&&meta.source!=='obj'&&meta.source!=='fbx')return undefined
    if(info.size>maxOutputBytes)throw new ModelPreviewUnsupported(`${fullImport?'SOURCE_IMPORT_OUTPUT_TOO_LARGE':'MODEL_PREVIEW_OUTPUT_TOO_LARGE'}: 已缓存产物 ${info.size} 字节超过上限 ${maxOutputBytes} 字节（${fullImport?'完整导入':'轻量预览'}），未读取大Buffer`)
    return {bytes:await readFile(paths.glb),cachedPath:paths.glb,convertMs:typeof meta.convertMs==="number"&&Number.isFinite(meta.convertMs)?meta.convertMs:0,source:meta.source,cached:true,...(typeof meta.cacheBasis==="string"?{cacheBasis:meta.cacheBasis}:{})}
  }catch(error){if(error instanceof ModelPreviewUnsupported)throw error;return undefined}
}
/** GLB 自洽校验：前 4 字节魔法、版本 2、头部长度等于真实文件长度、分块总长闭合；不合法就当没有产物。 */
export function verifyGlb(bytes:Buffer):{ok:true;jsonLength:number}|{ok:false;reason:string} {
  if(bytes.length<20)return {ok:false,reason:`产物只有 ${bytes.length} 字节，连 GLB 头都不够`}
  if(bytes.readUInt32LE(0)!==0x46546c67)return {ok:false,reason:`产物前 4 字节不是 glTF 魔法（实际 ${JSON.stringify(bytes.subarray(0,4).toString("latin1"))}）`}
  if(bytes.readUInt32LE(4)!==2)return {ok:false,reason:`GLB 版本不是 2（实际 ${bytes.readUInt32LE(4)}）`}
  if(bytes.readUInt32LE(8)!==bytes.length)return {ok:false,reason:`GLB 头部声明长度 ${bytes.readUInt32LE(8)} 与实际 ${bytes.length} 不一致`}
  const jsonLength=bytes.readUInt32LE(12)
  if(bytes.readUInt32LE(16)!==0x4e4f534a)return {ok:false,reason:"GLB 第一个分块不是 JSON 块"}
  if(jsonLength+20>bytes.length)return {ok:false,reason:`GLB JSON 块声明 ${jsonLength} 字节，超出文件长度`}
  let offset=12
  while(offset<bytes.length){
    if(offset+8>bytes.length)return {ok:false,reason:"GLB 分块头被截断"}
    offset+=8+bytes.readUInt32LE(offset)
  }
  if(offset!==bytes.length)return {ok:false,reason:`GLB 分块总长 ${offset} 与文件长度 ${bytes.length} 不闭合`}
  try {
    const json=JSON.parse(bytes.subarray(20,20+jsonLength).toString("utf8")) as {asset?:{version?:string}}
    if(!json.asset?.version?.startsWith("2."))return {ok:false,reason:`glTF 资产版本不是 2.x（实际 ${String(json.asset?.version)}）`}
  }catch(error){return {ok:false,reason:`GLB JSON 块解析失败：${(error as Error).message}`}}
  return {ok:true,jsonLength}
}
/** 注入 Blender 的导出脚本：单一来源，宿主机上先落临时文件再 `--python` 执行，避免任何 shell 引号拼接。 */
export const BLENDER_EXPORT_SCRIPT=`import bpy, sys, json, os

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
source, kind, output = argv[0], argv[1], argv[2]
asset_remap = json.loads(argv[3]) if len(argv)>3 else {}
texture_policy = argv[4] if len(argv)>4 else 'strict'

# .usd* 由 Blender 自带 USD 支持导入（Blender 4.x 起内置；.usdz 这种 zip 包也走同一条 usd_import）。
# 命令行不能把 .usda 当工程文件传：
# Blender 会按 .blend 解析直接报"文件格式不支持"（实测 5.2.2），所以 USD 一律走 --factory-startup
# + 这里的 usd_import。导入前清空默认场景，否则默认立方体会被一起导进产物。
if kind in ("usd","obj","fbx"):
    for item in list(bpy.data.objects):
        bpy.data.objects.remove(item, do_unlink=True)
    if kind=="usd": bpy.ops.wm.usd_import(filepath=source)
    elif kind=="obj": bpy.ops.wm.obj_import(filepath=source)
    else: bpy.ops.import_scene.fbx(filepath=source)

# 已登记的原件依赖走该资源版本的副本；不借仍存在的原路径纹理冒充闭包/缓存。
for image in bpy.data.images:
    if image.packed_file or not image.filepath: continue
    original=os.path.normpath(bpy.path.abspath(image.filepath))
    target=asset_remap.get(original)
    if target and target!=original:
        image.filepath=target
        image.reload()

# partial只消费登记快照的可用文件与原FBX内嵌图；后补图不能绕资源重导入偷偷改变旧缓存。
if texture_policy == 'available':
    allowed={os.path.realpath(path) for path in asset_remap.values()}
    for image in list(bpy.data.images):
        if image.packed_file or image.source!='FILE': continue
        resolved=os.path.realpath(bpy.path.abspath(image.filepath))
        if resolved not in allowed:
            bpy.data.images.remove(image)

objects = [item for item in bpy.data.objects]
if not objects:
    raise RuntimeError("BLENDER_NO_OBJECTS: 场景里没有任何可导出对象")
sys.stderr.write("LYAPUNOV_BLENDER_OBJECTS=%d\\n" % len(objects))

# export_yup 与 glTF 规范的 Y-up 一致；缓存键含源文件内容哈希（或已登记资源的版本+依赖身份），导出参数变化必须同步进缓存版本。
bpy.ops.export_scene.gltf(filepath=output, export_format="GLB", export_yup=True, export_extras=True)
sys.stderr.write("LYAPUNOV_BLENDER_EXPORTED=%s\\n" % output)
`
/** 从 Blender stderr/stdout 里挑出人类需要看的关键几行：错误行优先，其次尾部。 */
export function blenderDiagnostic(stdout:string,stderr:string,limit=8):string {
  const lines=[...`${stderr}\n${stdout}`.split("\n")].map(line=>line.trim()).filter(Boolean)
  const important=lines.filter(line=>/error|错误|traceback|exception|failed|cannot|unable|unsupported|no such|不存在|不支持/i.test(line))
  const picked=(important.length?important:lines).slice(-limit)
  return picked.length?picked.join(" | "):"（Blender 没有输出任何诊断）"
}
/**
 * 用 Blender 把 `.blend`/`.usd*` 转成 GLB 字节。
 *
 * 缓存按**缓存身份**寻址落在 `<cacheRoot>/model-preview/<hash>.glb`：`convertToGlb`（工作区预览）
 * 用源文件内容哈希，`convertRegisteredSource`（已登记源资源）用"资源版本 + 已核验依赖"的身份。
 * 命中即跳过 Blender，不重复冷启动。超时与产物上限都有，且失败原因里写真实数字；产物先临时落盘
 * 再 rename，崩溃不会留下半截缓存。blend/usd 的分支唯一差别是注入脚本里的导入方式。
 *
 * `reusable=false`（依赖无法核验）时**跳过缓存读取**：宁可重转一次，也不把旧 GLB 静默当成新结果。
 */
async function exportGlb(target:string,source:ModelConvertSource,options:ModelConvertOptions,identity?:ConvertCacheIdentity,assetRemap:Record<string,string>={},texturePolicy:'strict'|'available'='strict'):Promise<ConvertedGlb> {
  const info=await stat(target)
  if(!info.isFile())throw new ModelPreviewUnsupported(`不是一个文件：${target}`)
  const fullImport=options.purpose==='import'
  const timeoutMs=options.timeoutMs??(fullImport?DEFAULT_IMPORT_CONVERT_TIMEOUT_MS:DEFAULT_CONVERT_TIMEOUT_MS)
  const maxOutputBytes=options.maxOutputBytes??(fullImport?DEFAULT_MAX_IMPORT_OUTPUT_BYTES:DEFAULT_MAX_OUTPUT_BYTES)

  // 可信路径（无 identity）沿用源文件内容哈希；已登记资源用资源版本 + 依赖身份（主文件不变但依赖变了也会换键）。
  const cacheKey=createHash("sha256").update(identity?identity.key:`file\u0000${await sha256File(target)}`).digest("hex")
  const reusable=identity?identity.reusable:true
  if(reusable){
    const cached=await readCached(options.cacheRoot,cacheKey,maxOutputBytes,fullImport)
    if(cached)return {...cached,...(identity?{cacheBasis:identity.basis}:{})}
  }

  const spawn=options.spawn
  if(!spawn)throw new ModelPreviewUnavailable("宿主没有可用的子进程能力，无法调用 Blender 转换")
  const executable=options.blenderExecutable??process.env.BLENDER_EXECUTABLE??defaultBlenderExecutable()
  const scripts=await mkdtemp(join(tmpdir(),"lyapunov-blender-"))
  const scriptPath=join(scripts,"export_glb.py"),outputPath=join(scripts,"export.glb")
  const measured=Date.now()
  let exitCode:number|null=null,stdout="",stderr=""
  const abort=new AbortController()
  const forward=()=>abort.abort()
  if(options.signal?.aborted)abort.abort();else options.signal?.addEventListener("abort",forward,{once:true})
  let timedOut=false
  try {
    await writeFile(scriptPath,BLENDER_EXPORT_SCRIPT,"utf8")
    // `.blend` 由 Blender 直接打开；`.usd*` 不能走这条（Blender 会按 .blend 解析并报格式不支持），
    // 改由空工厂场景启动 + 注入脚本里的 usd_import 导入。
    const child=spawn([executable,"--background",...(source==="blend"?[target]:["--factory-startup"]),"--python-exit-code","1","--python",scriptPath,"--",target,source,outputPath,JSON.stringify(assetRemap),texturePolicy],{cwd:dirname(target),signal:abort.signal})
    const timer=setTimeout(()=>{timedOut=true;child.terminate()},timeoutMs)
    try {
      const outcome=await child.done
      exitCode=outcome.exitCode
    }finally{clearTimeout(timer)}
    stdout=child.collected.stdout?.readFrom(0).text??""
    stderr=child.collected.stderr?.readFrom(0).text??""
    if(options.signal?.aborted)throw new ModelPreviewUnsupported(`${fullImport?'源模型导入转换':'模型预览'}已取消（${Date.now()-measured} ms 后中止 Blender）`)
    if(timedOut)throw new ModelPreviewUnsupported(`${fullImport?'SOURCE_IMPORT_TIMEOUT':'MODEL_PREVIEW_TIMEOUT'}: Blender 转换超过 ${timeoutMs} ms（实测 ${Date.now()-measured} ms 时仍未结束，已终止进程）`)
    if(exitCode!==0)throw new ModelPreviewUnsupported(`Blender 转换失败（退出码 ${String(exitCode)}）：${blenderDiagnostic(stdout,stderr)}`)
    let bytes:Buffer
    try{
      const output=await stat(outputPath)
      if(output.size>maxOutputBytes)throw new ModelPreviewUnsupported(`${fullImport?'SOURCE_IMPORT_OUTPUT_TOO_LARGE':'MODEL_PREVIEW_OUTPUT_TOO_LARGE'}: 转换产物 ${output.size} 字节（${sizeText(output.size)}）超过上限 ${maxOutputBytes} 字节（${sizeText(maxOutputBytes)}，${fullImport?'完整导入':'轻量预览'}），未读取大Buffer或写入缓存`)
      bytes=await readFile(outputPath)
    }
    catch(error){if(error instanceof ModelPreviewUnsupported)throw error;throw new ModelPreviewUnsupported(`Blender 报告成功但没有写出 GLB 产物：${blenderDiagnostic(stdout,stderr)}`)}
    const verified=verifyGlb(bytes)
    if(!verified.ok)throw new ModelPreviewUnsupported(`Blender 产物不是合法 GLB：${verified.reason}；${blenderDiagnostic(stdout,stderr)}`)
    const paths=cachePaths(options.cacheRoot,cacheKey)
    await mkdir(paths.directory,{recursive:true})
    const convertMs=Date.now()-measured
    // 先写临时名再 rename：并发或崩溃只会留下可整删的临时文件，不会留下半截正式缓存。
    const staged=`${paths.glb}.${process.pid}.tmp`
    await writeFile(staged,bytes)
    await rename(staged,paths.glb)
    await writeFile(paths.meta,JSON.stringify({sha256:cacheKey,source,bytes:bytes.length,convertMs,blenderExecutable:executable,sourcePath:target,convertedAt:new Date().toISOString(),...(identity?{cacheBasis:identity.basis,dependenciesVerified:identity.reusable,resourceKey:identity.key}:{})},null,2))
    return {bytes,cachedPath:paths.glb,convertMs,source,cached:false,...(identity?{cacheBasis:identity.basis}:{})}
  }catch(error){
    if(error instanceof ModelPreviewUnsupported)throw error
    throw new ModelPreviewUnsupported(`Blender 转换失败：${(error as Error).message}`)
  }finally{
    options.signal?.removeEventListener("abort",forward)
    await rm(scripts,{recursive:true,force:true}).catch(()=>{})
  }
}
/**
 * 工作区预览入口：路径先过 `resolveModelPath`（会话工作区 ∪ 产品根），边界与 `model-preview`/`html-plan`
 * 一字未动。这是 `model-preview` action 的转换口，**不接受**工作区外路径。
 */
export async function convertToGlb(path:string,options:ModelConvertOptions):Promise<ConvertedGlb> {
  const target=await resolveModelPath(path,options.base??productRoot())
  const source=convertSourceOf(target)
  if(!source)throw new ModelPreviewUnsupported(`模型预览不支持用 Blender 转换该格式：${target.slice(target.lastIndexOf("."))||"（无扩展名）"}`)
  return exportGlb(target,source,options)
}
/**
 * 已登记源资源入口：源路径由**服务端从本会话资源 owner**解析（见 workspace 插件的 `convert-source`），
 * 因此这里不做"客户端路径 → 是否允许读工作区外"的判定；边界由 `scene_import` 的登记语义保证。
 * 缓存身份必须由调用方按资源版本 + 已核验依赖算好；依赖无法核验时 `reusable=false`，本次不复用旧缓存。
 */
export async function convertRegisteredSource(input:RegisteredConvertSource,options:ModelConvertOptions):Promise<ConvertedGlb> {
  const path=input?.path
  if(typeof path!=="string"||!path.trim())throw new ModelPreviewUnsupported("源资源没有给出可读路径")
  if(path.includes("\0"))throw new ModelPreviewUnsupported("源资源路径含非法字符（NUL）")
  let target:string
  try{target=await realpath(path)}
  catch(error){
    if((error as NodeJS.ErrnoException).code==="ENOENT")throw new ModelPreviewUnsupported(`源资源原件不存在或不可读：${path}`)
    throw new ModelPreviewUnsupported(`无法解析源资源路径（${(error as NodeJS.ErrnoException).code??"未知错误"}）：${path}`)
  }
  const source=convertSourceOf(target)
  if(!source)throw new ModelPreviewUnsupported(`该资源不是可转换的源工程（.blend/.usd/.usda/.usdc）：${target}`)
  return exportGlb(target,source,{...options,purpose:'import'},input.cacheIdentity,input.assetRemap,input.texturePolicy)
}
/**
 * 机器人可视化数据：先 `parseAsset` 做格式与依赖校验（能顺手挡掉坏 XML 与 package:// 这类
 * 当前引擎解不了的引用），再用 `robotVisual` 出 include 合并后的文档与依赖基准 URI。
 * 只有 `.xml` 的根节点是 `<mujoco>`/`<robot>` 才算机器人；否则如实说不支持。
 */
export async function robotPreview(path:string,base=productRoot()):Promise<RobotPreview> {
  const sourcePath=await resolveModelPath(path,base)
  if(!isRobotPath(sourcePath))throw new ModelPreviewUnsupported(`模型预览只把 .xml/.mjcf/.urdf 当机器人描述：${sourcePath}`)
  let parsed
  try{parsed=await parseAsset(sourcePath)}
  catch(error){throw new ModelPreviewUnsupported(`机器人描述解析失败：${(error as Error).message}`)}
  if(parsed.kind!=="robot")throw new ModelPreviewUnsupported(`该 XML 的根节点既不是 <mujoco>（MJCF）也不是 <robot>（URDF），不是机器人描述文件：${sourcePath}`)
  try {
    const robot=await robotVisual(sourcePath)
    return {robot,sourcePath}
  }catch(error){throw new ModelPreviewUnsupported(`机器人可视化数据构建失败：${(error as Error).message}`)}
}
/* ─────────────── 浏览器直取字节：模型预览 GET 路由 + 解码器静态资源（纯函数） ───────────────
 * 客户端渲染前要拿到字节，宿主这边有两条通路，都归本文件（便于 `bun -e` 直接真跑）：
 *  1. `fileByteResponse()`：把一个真实文件按 Range 语义包成响应——大文件只按区间流式读，
 *     不整份读进内存；宿主 `GET /api/lyapunov/model-preview` 直接返回它的结果。
 *  2. `decoderAssetResponse()`：three 自带的 DRACO/KTX2 解码器，只允许
 *     `<产品根>/node_modules/three/examples/jsm/libs/{draco,basis}/` 下的单段文件名。
 */
/** 预览字节路由的 content-type：只按扩展名映射（客户端据此决定交给哪个 loader），未列出的按二进制流。 */
const MODEL_CONTENT_TYPES:Record<string,string>={".glb":"model/gltf-binary",".gltf":"model/gltf+json",".spz":"application/x-spz",".splat":"application/x-splat",".ply":"application/x-ply",".stl":"model/stl",".obj":"text/plain",".fbx":"application/octet-stream"}
/** 解码器静态资源的 content-type：契约里只有 `.js` 与 `.wasm` 两种，其余按二进制流。 */
const DECODER_CONTENT_TYPES:Record<string,string>={".js":"text/javascript",".wasm":"application/wasm"}
function extensionOf(path:string):string{const lower=path.toLowerCase(),dot=lower.lastIndexOf(".");return dot<0?"":lower.slice(dot)}
/** 扩展名 → content-type（模型原件与转换产物共用；未列出的一律 `application/octet-stream`）。 */
export function modelContentType(path:string):string{return MODEL_CONTENT_TYPES[extensionOf(path)]??"application/octet-stream"}
/** 扩展名 → content-type（解码器静态资源）。 */
export function decoderContentType(path:string):string{return DECODER_CONTENT_TYPES[extensionOf(path)]??"application/octet-stream"}
/** `parseByteRange` 的三态：`full`=没有 Range/按整份 200；`partial`=206；`unsatisfiable`=416。 */
export type ByteRangeResult={kind:"full"}|{kind:"partial";start:number;end:number}|{kind:"unsatisfiable";reason:string}
/**
 * 解析单段 `Range: bytes=…`（RFC 7233）。三种写法都支持：`a-b`、`a-`、`-n`。
 * 判据写成返回值而不是抛错，宿主原样翻成 416 + `{error}`：
 *  - `a>=size`、`b<a`、`-0`、空文件上的任何区间 → `unsatisfiable`（416）；
 *  - 非 `bytes` 单位、多段 `a-b,c-d` → 忽略 Range 按整份 200（RFC 允许服务器忽略，本实现不做多段）。
 */
export function parseByteRange(header:string|null|undefined,size:number):ByteRangeResult {
  const raw=header?.trim()
  if(!raw)return {kind:"full"}
  const matched=/^bytes=(.*)$/i.exec(raw)
  if(!matched)return {kind:"full"}
  const spec=matched[1].trim()
  if(spec.includes(","))return {kind:"full"}
  const single=/^(\d*)-(\d*)$/.exec(spec)
  if(!single)return {kind:"unsatisfiable",reason:`Range 语法非法（只支持单段 bytes=a-b / bytes=a- / bytes=-n）：${JSON.stringify(raw)}`}
  const [,firstText,lastText]=single
  if(firstText===""&&lastText==="")return {kind:"unsatisfiable",reason:`Range 两端都为空：${JSON.stringify(raw)}`}
  if(size<=0)return {kind:"unsatisfiable",reason:`文件为空（0 字节），任何区间都不可满足：${JSON.stringify(raw)}`}
  if(firstText===""){
    const suffix=Number(lastText)
    if(suffix<=0)return {kind:"unsatisfiable",reason:`后缀区间长度必须为正数：${JSON.stringify(raw)}`}
    return {kind:"partial",start:Math.max(0,size-suffix),end:size-1}
  }
  const start=Number(firstText)
  if(start>=size)return {kind:"unsatisfiable",reason:`区间起点 ${start} 超出文件长度 ${size}：${JSON.stringify(raw)}`}
  if(lastText==="")return {kind:"partial",start,end:size-1}
  const last=Number(lastText)
  if(last<start)return {kind:"unsatisfiable",reason:`区间终点 ${last} 小于起点 ${start}：${JSON.stringify(raw)}`}
  return {kind:"partial",start,end:Math.min(last,size-1)}
}
/** 只读 `[start,end]` 的字节流：走 `node:fs` 的区间读，不整份进内存。 */
function byteStream(path:string,start:number,end:number):ReadableStream<Uint8Array> {
  // `Readable.toWeb` 的返回类型是 `ReadableStream<any>`（node:stream/web 的声明面），运行时就是字节流。
  return Readable.toWeb(createReadStream(path,{start,end})) as unknown as ReadableStream<Uint8Array>
}
/**
 * 把一个真实文件包成 HTTP 响应：
 *  - 无 Range → 200 + `content-length`；合法单段 → 206 + `content-range: bytes a-b/size`；
 *  - 越界/非法 Range → 416（带 `content-range: bytes *\/size`）；不存在 → 404、不是文件 → 400，都用 `{error}`；
 *  - 一律 `accept-ranges: bytes` 与 `cache-control: private, no-cache`（内容随会话/版本变，不做长缓存）。
 */
export async function fileByteResponse(path:string,range?:string|null,contentType?:string):Promise<Response> {
  let info
  try{info=await stat(path)}
  catch(error){return Response.json({error:`文件不存在或无法读取（${(error as NodeJS.ErrnoException).code??"未知错误"}）：${path}`},{status:404})}
  if(!info.isFile())return Response.json({error:`不是一个文件：${path}`},{status:400})
  const size=info.size,parsed=parseByteRange(range,size)
  if(parsed.kind==="unsatisfiable")return Response.json({error:parsed.reason},{status:416,headers:{"content-range":`bytes */${size}`,"accept-ranges":"bytes","cache-control":"private, no-cache"}})
  const headers:Record<string,string>={"content-type":contentType??modelContentType(path),"accept-ranges":"bytes","cache-control":"private, no-cache"}
  if(parsed.kind==="partial"){
    headers["content-range"]=`bytes ${parsed.start}-${parsed.end}/${size}`
    headers["content-length"]=String(parsed.end-parsed.start+1)
    return new Response(byteStream(path,parsed.start,parsed.end),{status:206,headers})
  }
  headers["content-length"]=String(size)
  return new Response(size>0?byteStream(path,0,size-1):null,{status:200,headers})
}
/** 解码器静态资源的两个白名单目录（客户端 DRACO/KTX2 loader 从这里取 `.js`/`.wasm`）。 */
export const DECODER_ASSET_KINDS=["draco","basis"] as const
export type DecoderAssetKind=(typeof DECODER_ASSET_KINDS)[number]
/** 相对段判据：只允许单段 `^[A-Za-z0-9._-]+$`，因此 `/`、`..`、`.`、NUL 都没有容身之处。 */
const DECODER_ASSET_SEGMENT=/^[A-Za-z0-9._-]+$/
/**
 * 解码器资源目录：**产品自带优先，node_modules 兜底**。
 *
 * 为什么要有产品自带那份：原先只从 `<产品根>/node_modules/three/examples/jsm/libs/<kind>` 取文件，
 * 而安装形态可能没有这个路径（依赖被裁剪、只带产品包、换机器只装发行包）——那时压缩 glTF 的预览
 * 会 404。产品副本随 `packages/lyapunov-workspace/assets/decoder/` 一起走（见该目录 README）。
 */
export function decoderAssetDirectory(kind:DecoderAssetKind,root=productRoot()):string {
  const owned=join(root,"packages","lyapunov-workspace","assets","decoder",kind)
  if(existsSync(owned))return owned
  return join(root,"node_modules","three","examples","jsm","libs",kind)
}
/**
 * 目录里真实存在、且相对段合法的文件名（升序）。
 * 连接的 fetch 路由是**精确匹配**（`dsh-client-connection/src/rpc-host.ts:122` 拿 pathname 查 Map，没有通配），
 * 宿主因此按这个列表逐个注册路由——可寻址集合被钉死在这两个目录里的真实文件上。目录不存在就返回空表。
 */
export async function decoderAssetFiles(kind:DecoderAssetKind,root=productRoot()):Promise<string[]> {
  const entries=await readdir(decoderAssetDirectory(kind,root),{withFileTypes:true}).catch(()=>[])
  return entries.filter(entry=>entry.isFile()&&DECODER_ASSET_SEGMENT.test(entry.name)).map(entry=>entry.name).sort()
}
/** 相对段 → 绝对路径；非法段抛 `ModelPreviewUnsupported`（子目录逃逸在拼路径之前就被拒）。 */
export function decoderAssetPath(kind:DecoderAssetKind,relative:string,root=productRoot()):string {
  if(typeof relative!=="string"||!relative)throw new ModelPreviewUnsupported("解码器资源名称为空")
  if(!DECODER_ASSET_SEGMENT.test(relative)||relative==="."||relative==="..")throw new ModelPreviewUnsupported(`解码器资源名称非法（只允许单段 [A-Za-z0-9._-]+，禁止目录分隔与 ..）：${JSON.stringify(relative)}`)
  return join(decoderAssetDirectory(kind,root),relative)
}
/**
 * 解码器静态资源响应：先过段判据，再用 realpath 复核一次包含关系（目录里若有人塞了指向别处的软链也拒），
 * 最后按扩展名给 content-type（`.js`→`text/javascript`、`.wasm`→`application/wasm`）。
 * `cache-control` 取 `private, no-cache`：URL 不随 three 版本变化（路径里没有版本段），
 * `max-age` 会让升级 three 后的浏览器继续用旧解码器字节（.wasm 与主线程 three 版本错配）。
 */
export async function decoderAssetResponse(kind:DecoderAssetKind,relative:string,range?:string|null,root=productRoot()):Promise<Response> {
  let target:string
  try{target=decoderAssetPath(kind,relative,root)}
  catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:400})}
  const directory=await realpath(decoderAssetDirectory(kind,root)).catch(()=>undefined)
  const resolved=await realpath(target).catch(()=>undefined)
  if(directory&&resolved&&!contains(directory,resolved))return Response.json({error:`解码器资源越界：${resolved} 不在 ${directory} 内`},{status:400})
  return fileByteResponse(target,range,decoderContentType(target))
}
