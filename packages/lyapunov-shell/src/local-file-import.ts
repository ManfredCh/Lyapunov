import type { SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"
// 可转换源格式的纯分类表（无 node 依赖，浏览器侧与服务端共用同一份真相）；
// 这里**不** import `model-convert.ts`：它带 node:crypto/node:fs，会把服务端代码拖进客户端包。
// 用 `registrableConvertSourceOf` 而不是 `convertSourceOf`：拖拽要先 `scene_import` 登记原件，
// 必须只认 `parseAsset` 真正接受的扩展名（`.usdz` 不在其列，列进来第一步就会失败）。
import { registrableConvertSourceOf, REGISTRABLE_SOURCE_EXTENSIONS } from "../../lyapunov-workspace/src/model-source.ts"
import {LOCAL_POLICY_WEIGHT_EXTENSIONS,localPolicyFileKind} from '../../policy-registry/src/local-policy-file-contract.ts'
import type {LocalPolicyImportReceipt} from './local-policy-import.ts'
import type {LocalImportPathResolution} from '../../scene-kit/src/local-import-entry.ts'

/** 用户打开模型默认保留几何与现有材质；工具/API 自身的 strict 缺省不由此改变。 */
export const DEFAULT_LOCAL_SOURCE_TEXTURE_POLICY = 'available' as const
export type LocalImportPhysicsUsage='environment'|'static'|'dynamic'
export const localImportUsageDefault=(entry:'scene'|'environment'|'object'|'library'):LocalImportPhysicsUsage=>entry==='object'||entry==='library'?'dynamic':'environment'
/** 仅网格及可转换几何带用途；本体按原生文档，点云保视觉导入，不能拖入时隐式烘焙2GB。 */
export function localImportPhysicsInput(path:string,usage:LocalImportPhysicsUsage):{physicalizeUsage:LocalImportPhysicsUsage}|Record<string,never>{
 return /\.(?:glb|gltf|obj|fbx|blend|usd|usda|usdc)$/i.test(path)?{physicalizeUsage:usage}:{}
}

const VISUAL_EXTENSIONS=["glb","gltf","ply","spz","splat","ksplat","sog","rad","urdf","mjcf","xml"] as const
/** 文件选择与拖入共用支持表；普通 JSON 仍在 localFileKind 中按工程命名校验。 */
export const LOCAL_IMPORT_FILE_FILTERS=[
  {name:"模型、场景与机器人策略",extensions:[...VISUAL_EXTENSIONS,...REGISTRABLE_SOURCE_EXTENSIONS.map(ext=>ext.slice(1)),...LOCAL_POLICY_WEIGHT_EXTENSIONS,"hdr","exr","json"]},
  {name:"机器人策略与bundle",extensions:[...LOCAL_POLICY_WEIGHT_EXTENSIONS,"json"]},
  {name:"所有文件",extensions:["*"]},
]

/** 桌面入口的分派表；显示能力由现有 scene_import / Viewer 实现负责。 */
export function localFileKind(path: string): "visual" | "source" | "scene" | "policy" | undefined {
  if(localPolicyFileKind(path))return 'policy'
  if (/(?:^|[\\/])(?:scene|[^\\/]+\.scene|[^\\/]+\.scene-package)\.json$/i.test(path)) return "scene"
  const ext = path.split(".").pop()?.toLowerCase()
  if ((VISUAL_EXTENSIONS as readonly string[]).includes(ext ?? "")) return "visual"
  // `source` = 先入库保留原件；其中 .blend/.usd/.usda/.usdc/.obj/.fbx 由转换服务出可显示 GLB（`.usdz` 因
  // `parseAsset` 不接受登记而**不**列为已支持），.hdr/.exr 没有直接可视表示（环境面板消费）；
  // 两者都不把"入库"当成"已显示"。
  if (registrableConvertSourceOf(path) || ["hdr", "exr"].includes(ext ?? "")) return "source"
  return undefined
}

/** 文件夹有明确的浏览器目录标记；普通对话图片/文档继续作为原生附件。 */
export function localDropIsImport(files:readonly Pick<File,'name'>[],items:readonly Pick<DataTransferItem,'webkitGetAsEntry'>[],modelTarget:boolean):boolean{
  return modelTarget||files.some(file=>localFileKind(file.name)!==undefined)||items.some(item=>item.webkitGetAsEntry?.()?.isDirectory===true)
}

/** 正式UI只回入口文件名；继续使用用户本次明确选择的原路径，不依赖绝对路径回显。 */
export function localImportPathFromReceipt(requestedPath:string,receipt:{kind?:unknown;entryName?:unknown;reason?:unknown}):LocalImportPathResolution{
  if(receipt.kind==='blocked')throw Error(typeof receipt.reason==='string'?receipt.reason:'LOCAL_IMPORT_ENTRY_REQUIRED: 请直接选择原生入口文件')
  if(receipt.kind==='file')return {path:requestedPath,kind:'file'}
  if(receipt.kind!=='robot-directory'&&receipt.kind!=='policy-directory')throw Error('LOCAL_IMPORT_RESOLUTION_INVALID: 宿主没有给出有效目录入口')
  const entry=receipt.entryName
  if(typeof entry!=='string'||!entry||entry==='.'||entry==='..'||/[\\/]/.test(entry))throw Error('LOCAL_IMPORT_ENTRY_INVALID: 宿主没有给出有效入口文件名')
  return {path:`${requestedPath.replace(/[\\/]+$/,'')}/${requestedPath.startsWith('file:')?encodeURIComponent(entry):entry}`,kind:receipt.kind,entryName:entry}
}

/** 转换请求：只带**本会话已登记源资源**的身份，不带路径。 */
export interface LocalFileConvertRequest {
  resourceId: string
  version: number
}
/** 转换结果：服务端已复用 scene_import 登记派生 GLB，前端只拿资源身份去 scene_mount。 */
export interface LocalFileConvertResult {
  resourceId: string
  version: number
  /** 派生件资源名（源文件名去扩展名），仅供回执显示。 */
  name?: string
  cached?: boolean
  convertMs?: number
  textureLoss?:{policy:'strict'|'available';partial:boolean;missingDependencies:unknown[];emptyDeclarations:unknown[];packedImageCount:number}
}

export interface LocalFileImportPort {
  /** 宿主只读解析明确选择的目录入口；客户端不枚举或改写原件及 meshes。 */
  resolvePath?(path:string):Promise<LocalImportPathResolution>
  /** 用户打开 OBJ/FBX 默认保留几何与现有材质；高级 strict 选择不在失败后自动降级。 */
  sourceTexturePolicy?:'strict'|'available'
  /** 从可见的人类入口选择冻结，工具/API未指定用途的兼容缺省不由此改写。 */
  physicalizeUsage?:LocalImportPhysicsUsage
  current(): boolean
  command<T>(name: string, input: unknown): Promise<T>
  show(snapshot: SceneSnapshot, entityId?: string): void
  progress(message: string): void
  loadPolicy?(path:string):Promise<LocalPolicyImportReceipt>
  /**
   * 把本会话已登记的源工程（.blend / .usd* / .obj / .fbx）转成可显示 GLB 并由服务端登记。
   * 输入只有 `scene_import` 回执里的 `resourceId/version`——服务端从该会话资源 owner 解析源路径，
   * 客户端既不能给路径也不能给"放开工作区"的开关。返回值是可交给 `scene_mount` 的资源身份。
   * 不给＝这台宿主没有转换能力：源文件照旧入库保留，但拖拽面板必须如实说明"没有显示"。
   */
  convert?(source: LocalFileConvertRequest): Promise<LocalFileConvertResult>
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
/** `scene_import` 回执里我们真正要用的那一点：本会话资源身份（缺了就不能转换）。 */
type SourceRegistration = { resource?: { ref?: { resourceId?: string; version?: number } } }

/** 一批拖入始终属于发起时的会话和场景；切换后停止后续文件，不把迟到结果写到新视图。 */
export async function importLocalFiles(port: LocalFileImportPort, paths: string[], target: "scene" | "library", sceneId?: string) {
  const imported: string[] = [], sources: string[] = [], convertedSources: string[] = [], errors: string[] = [],textureWarnings:string[]=[],textureWarningDetails:string[]=[],policyFiles:string[]=[]
  const orientationEntityIds: string[] = []
  let orientationRevision: number | undefined
  const usage=port.physicalizeUsage??localImportUsageDefault(target)
  for (const requestedPath of [...new Set(paths)]) {
    if (!port.current()) break
    let path=requestedPath
    if(port.resolvePath){
      try{path=(await port.resolvePath(requestedPath)).path;if(!port.current())break}
      catch(error){errors.push(`${requestedPath.split(/[\\/]/).pop()??requestedPath}：${messageOf(error)}`);continue}
    }
    const name = path.split(/[\\/]/).pop() ?? path, kind = localFileKind(path)
    if (!kind) { errors.push(/\.max$/i.test(path)?`${name}：MAX需要在3ds Max导出FBX（含材质/纹理）或GLB后导入，不能改后缀冒充支持`:`${name}：尚不支持此格式的直接导入`); continue }
    port.progress(`正在导入 ${name}（${imported.length + errors.length + 1}/${new Set(paths).size}）…`)
    try {
      if(kind==='policy'){
        if(!port.loadPolicy)throw Error('POLICY_IMPORT_UNAVAILABLE: 当前入口没有接上策略登记服务')
        const receipt=await port.loadPolicy(path)
        if(!port.current()||receipt.face.cancelled)break
        if(receipt.entry||!receipt.face.failure)policyFiles.push(name)
        if(receipt.face.failure)errors.push(`${name}：${receipt.entry?'策略已登记；当前实例兼容检查未完成 · ':''}${receipt.face.failure.code??'POLICY_LOAD_BLOCKED'} · ${receipt.face.failure.message??'文件加载被阻断'}`)
        continue
      }
      if (kind === "scene") {
        if (target === "library") throw new Error("场景工程请拖到视图区打开")
        const snapshot = await port.command<SceneSnapshot>(/\.scene-package\.json$/i.test(path) ? "scene_package_import" : "scene_open", { path })
        if (!port.current()) break
        port.show(snapshot); sceneId = snapshot.sceneId
        orientationEntityIds.length = 0; orientationRevision = undefined
        imported.push(name)
        continue
      }
      if (kind === "source") {
        // 源工程先入库保留原件（不带 sceneId = 只登记资源，不生成不可见实体），并拿回本会话资源身份。
        const registration = await port.command<SourceRegistration>("scene_import", { path,...localImportPhysicsInput(path,usage),.../\.(obj|fbx)$/i.test(path)?{sourceTexturePolicy:port.sourceTexturePolicy??DEFAULT_LOCAL_SOURCE_TEXTURE_POLICY}:{} })
        if (!port.current()) break
        sources.push(name)
        // 可转换的源工程再出 GLB：服务端从**该资源身份**解析源路径、转换、并复用 scene_import 登记派生件；
        // 前端只拿回可挂载的 resourceId/version，再由既有 scene_mount 挂到场景（浏览器不接触宿主私有路径）。
        // 转换失败/没有转换能力**都不算显示成功**：源文件保留（sources 里已有），错误里写明原因。
        if(registrableConvertSourceOf(path)){
          if(!port.convert){
            errors.push(`${name}：源文件已入库保留，但这台宿主没有接上转换服务，无法生成可显示的 GLB`)
            continue
          }
          const ref = registration?.resource?.ref
          if (!ref || typeof ref.resourceId !== "string" || !Number.isInteger(ref.version)) {
            errors.push(`${name}：源文件已入库保留，但登记回执没有给出可转换的资源身份（resourceId/version）`)
            continue
          }
          let phase:"convert"|"mount"="convert"
          try {
            port.progress(`正在用 Blender 转换 ${name}…`)
            const converted = await port.convert({ resourceId: ref.resourceId, version: ref.version as number })
            if (!port.current()) break
            convertedSources.push(name)
            phase="mount"
            const mount = target === "scene"
            if (mount && !sceneId) {
              const created = await port.command<SceneSnapshot>("scene_create", {})
              if (!port.current()) break
              port.show(created); sceneId = created.sceneId
            }
            if (mount) {
              const result = await port.command<{ snapshot?: SceneSnapshot; entityId?: string }>("scene_mount", { sceneId, resourceId: converted.resourceId, version: converted.version })
              if (!port.current()) break
              if (result.snapshot) {
                port.show(result.snapshot, result.entityId)
                if (result.entityId) { orientationEntityIds.push(result.entityId); orientationRevision = result.snapshot.revision }
              }
            }
            const loss=converted.textureLoss
            if(loss?.partial&&(loss.missingDependencies.length||loss.emptyDeclarations.length)){
              const counts=[loss.missingDependencies.length?`${loss.missingDependencies.length} 项材质依赖缺失`:"",loss.emptyDeclarations.length?`${loss.emptyDeclarations.length} 项纹理声明无路径`:""].filter(Boolean).join("、")
              textureWarnings.push(`${name}：已导入几何与现有材质；${counts}。`)
              textureWarningDetails.push(`${name}：缺失材质依赖 ${loss.missingDependencies.length} 个，空纹理声明 ${loss.emptyDeclarations.length} 个；保留 ${loss.packedImageCount} 个原内嵌图声明。`)
              for(const item of loss.missingDependencies){
                const dependency=item&&typeof item==='object'?item as {kind?:unknown;declared?:unknown}:undefined
                const declared=typeof dependency?.declared==='string'?dependency.declared.split(/[\\/]/).pop():undefined
                if(declared)textureWarningDetails.push(`${name} · ${dependency?.kind==='material-library'?'缺失材质库':'缺失图片'}：${declared}`)
              }
              textureWarningDetails.push(`${name}：缺失纹理仍未补齐；补齐后请重新导入新版本。`)
            }
          } catch (error) {
            errors.push(phase==="convert"?`${name}：源文件已入库保留，但没有生成可显示的 GLB（${messageOf(error)}）`:`${name}：GLB已生成并保留在素材库，但没有加入场景（${messageOf(error)}）`)
            continue
          }
        }
        imported.push(name)
        continue
      }
      // kind === "visual"：可显示格式，直接走既有导入/挂载。
      const mount = target === "scene"
      if (mount && !sceneId) {
        const created = await port.command<SceneSnapshot>("scene_create", {})
        if (!port.current()) break
        port.show(created); sceneId = created.sceneId
      }
      const result = await port.command<{ snapshot?: SceneSnapshot; entityId?: string }>(/\.gltf$/i.test(path) ? "scene_asset_acquire" : "scene_import", { path,...localImportPhysicsInput(path,usage), ...(/\.gltf$/i.test(path) ? { name: name.replace(/\.gltf$/i, "") } : {}), ...(mount ? { sceneId } : {}) })
      if (!port.current()) break
      if (result.snapshot) {
        port.show(result.snapshot, result.entityId)
        if (result.entityId) { orientationEntityIds.push(result.entityId); orientationRevision = result.snapshot.revision }
      }
      imported.push(name)
    } catch (error) { errors.push(`${name}：${messageOf(error)}`) }
  }
  return { imported, sources, convertedSources, errors,textureWarnings,textureWarningDetails,policyFiles,
    ...(target === "scene" && sceneId && orientationRevision !== undefined && orientationEntityIds.length
      ? { orientation: { sceneId, revision: orientationRevision, rootEntityIds: orientationEntityIds } } : {}),
  }
}
