/**
 * 3D 模型预览标签体：把工作区里的模型交给产品自带渲染器（`packages/viewer`）。
 *
 * 分三条渲染路径，全部复用 viewer 的同一台相机/网格/gizmo：
 * 1. **场景快照**（`.spz`/`.splat`/高斯 `.ply`/机器人）：喂 `setScene`，
 *    与工作台里的世界同一套坐标声明（Y-up 源 → viewer 做 +90°X 适配，机器人自带 Z-up 文档坐标）；
 *    泼溅件的字节由宿主 `GET /api/lyapunov/model-preview`（支持 `Range`）直出，不再经 `readAll` 中转。
 * 2. **直接对象**（`.glb`/`.gltf`/`.stl`/`.obj`/`.fbx`/`.dae`/`.3mf`/`.usdz`/`.vtk`/网格 `.ply`/Blender 转换出的 GLB）：
 *    喂 `setPreviewObject`，这些格式在文件里没有可投影成场景实体的描述。
 *    `.glb`/`.gltf` 由本文件里**带解码器**的 `GLTFLoader` 解析（DRACO/KTX2/meshopt，解码器脚本由宿主静态路由提供），
 *    这样带 `KHR_draco_mesh_compression`/`KHR_texture_basisu`/`EXT_meshopt_compression` 的模型才渲染得出来。
 * 3. **宿主 RPC**（`.xml`/`.mjcf`/`.urdf` 机器人、`.blend`/`.usd*` 与 `PK\x03\x04` 二进制 `.usdz` 转换）：
 *    `POST /api/lyapunov/workspace` `{action:'model-preview',input:{path}}` → `{kind:'robot'|'converted-glb'|'unsupported'}`；
 *    接口不存在/报错/超限都落到可见红字，不留白屏。
 *
 * 字节读取沿用上游客户端既有的 `remote.workspaceFiles.readAll`（文本预览同一接口）：
 * 相对引用（`.gltf` 的 `.bin`/贴图、`.obj` 的 `.mtl` 及其贴图）按同级路径逐个读成 blob URL 再改写；
 * `.fbx` 的外部贴图先列同级文件再**只按 basename** 改写（FBX 里常是反斜杠/绝对路径），未命中的进缺失依赖清单；
 * 机器人网格的 `file://` URI 取 pathname 直接读（该接口允许工作区外的路径）；
 * 读不到的依赖逐条列在界面上（缺哪个文件、什么原因）。
 */
import {useEffect,useMemo,useRef,useState} from 'react'
import {
 THREE, GLTFLoader, DRACOLoader, KTX2Loader, MeshoptDecoder, STLLoader, OBJLoader, MTLLoader,
 FBXLoader, ColladaLoader, ThreeMFLoader, USDLoader, VTKLoader, PLYLoader,
} from '@lyapunov/viewer/client'
import type {PropsLocale,PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import {parseFileAddress} from '@deepseek-ai/dsh-util-workspace-path/src/file-address.ts'
import {pathPartsOf} from '@deepseek-ai/dsh-util-workspace-path'
import {createViewer,type SceneViewer} from '@lyapunov/viewer/client'
import {SCENE_COORDINATES,identityTransform,type Entity,type ResourceRef,type SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'

/** 模型标签认得的渲染管线（`canOpen` 与标签体共用，扩展名知识只有这一份）。 */
export type ModelFormat='glb'|'gltf'|'splat'|'ply'|'stl'|'obj'|'fbx'|'dae'|'3mf'|'usdz'|'vtk'|'robot'|'convert'
/**
 * 扩展名 → 渲染管线。`.ply` 归属待定（读文件头才知道是泼溅件还是网格），所以单独一类；
 * `.xml` 按 MJCF 处理（MJCF 没有专用后缀），非 MJCF/URDF 的 XML 由宿主给出可读的 unsupported 原因。
 */
const FORMAT_PATTERNS:ReadonlyArray<readonly[RegExp,ModelFormat]>=[
 [/\.glb$/i,'glb'],[/\.gltf$/i,'gltf'],[/\.spz$/i,'splat'],[/\.splat$/i,'splat'],[/\.ply$/i,'ply'],
 [/\.stl$/i,'stl'],[/\.obj$/i,'obj'],[/\.fbx$/i,'fbx'],[/\.dae$/i,'dae'],[/\.3mf$/i,'3mf'],
 [/\.usdz$/i,'usdz'],[/\.vtk$/i,'vtk'],[/\.(?:xml|mjcf|urdf)$/i,'robot'],[/\.(?:blend|usd|usda|usdc)$/i,'convert'],
]
/** 界面上报"认哪些格式"用的一行清单（错误分支给用户看的）。 */
const SUPPORTED_TEXT='.glb/.gltf/.spz/.splat/.ply/.stl/.obj/.fbx/.dae/.3mf/.usdz/.vtk/.xml/.mjcf/.urdf/.blend/.usd/.usda/.usdc'
/** 高斯泼溅 PLY 的文件头特征属性（3DGS 训练输出必带其中之一，普通网格不会）。 */
const SPLAT_PLY_MARKERS=['f_dc_0','scale_0','rot_0'] as const
/** MTL 里要改写成 blob URL 的贴图扩展名。 */
const IMAGE_EXTENSION=/\.(?:png|jpe?g|webp|bmp|gif|tga|dds|ktx2?)$/i
/** DRACO 解码器脚本目录（宿主静态路由；不内联进客户端包）。 */
const DRACO_DECODER_PATH='/api/lyapunov/model-preview/asset/draco/'
/** KTX2（basis）转码器脚本目录（宿主静态路由；不内联进客户端包）。 */
const KTX2_TRANSCODER_PATH='/api/lyapunov/model-preview/asset/basis/'
/** 宿主模型预览字节路由（支持 `Range`）：泼溅件直连，避免把大文件读成全量 blob。 */
const BYTES_ROUTE='/api/lyapunov/model-preview'
/** 泼溅 PLY 的嗅探窗口（只看文件头，不读全量）。 */
const SPLAT_SNIFF_BYTES=4096
/** 一次模型读取：session + 工作区路径 → 完整字节；失败必须抛出人类可读原因。 */
export type ReadModelBytes=(sessionId:string,path:string,signal:AbortSignal)=>Promise<Uint8Array>
type Props=PropsRuntime<'sidebar.right.pane.tab'>&PropsLocale<'lyapunovWorkspace'>&{readBytes:ReadModelBytes}
/** 一次加载的产物：场景快照（glTF/泼溅/机器人）或一个可直接显示的 three 对象。 */
type Preview=
 |{via:'scene';snapshot:SceneSnapshot;resolveResource:(uri:string)=>string|Promise<string>;detail:string}
 |{via:'object';object:THREE.Object3D;detail:string;upAxis:'Y'|'Z';flippable:boolean;note?:string}
/** 一次加载的上下文：文件定位、字节读取、生命周期与待报告的缺失依赖。 */
interface LoadContext{
 sessionId:string
 path:string
 format:ModelFormat
 signal:AbortSignal
 readBytes:ReadModelBytes
 /** 本次加载创建的全部 blob URL，换文件或卸载时统一撤销。 */
 urls:string[]
 /** 读不到的依赖（相对引用）与原因，加载结束后原样显示。 */
 missing:string[]
 /** 新增一条缺失依赖时的通知：FBX 贴图是异步加载的，清单要能晚到一步刷新界面（否则命中不了的那张永远不显示）。 */
 onMissing?:()=>void
}

/** 扩展名 → 渲染管线；返回 undefined 表示这个标签不认这个格式。 */
export function modelKindOf(path:string):ModelFormat|undefined{
 for(const [pattern,format] of FORMAT_PATTERNS)if(pattern.test(path))return format
 return undefined
}
/** 人类可读的字节数，只用于工具行。 */
function sizeText(bytes:number){return bytes>=1048576?`${(bytes/1048576).toFixed(1)} MB`:`${Math.max(1,Math.round(bytes/1024))} KB`}
/** 空值安全的错误文案。 */
function messageOf(reason:unknown){return String((reason as Error)?.message??reason)}
/** UTF-8 解码（`.gltf`/`.obj`/`.dae` 都是文本格式）。 */
function decodeText(bytes:Uint8Array){return new TextDecoder().decode(bytes)}
/** 精确切片成 ArrayBuffer：二进制 loader 只吃 ArrayBuffer，且不能带上别的视图偏移。 */
function toArrayBuffer(bytes:Uint8Array):ArrayBuffer{return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer}
/** 与工作区路径同构的 POSIX 目录名（地址里的路径永远是 `/` 分隔）。 */
function dirOf(path:string){const at=path.lastIndexOf('/');return at<0?'':path.slice(0,at)}
/** 与工作区路径同构的 POSIX 文件名。 */
function nameOf(path:string){return path.split('/').pop()??path}
/** 引用里的文件名：FBX 的贴图引用可能是反斜杠或绝对路径，只认最后一段。 */
function basenameOf(reference:string){return reference.split(/[\\/]/).pop()??reference}
/** 把相对引用挂到基准目录上，处理 `./` 与 `../`。 */
function joinPath(dir:string,relative:string):string{
 const parts=dir?dir.split('/'):[]
 for(const part of relative.split('/')){
  if(!part||part==='.')continue
  if(part==='..'){parts.pop();continue}
  parts.push(part)
 }
 return parts.join('/')
}
/** 相对引用（同级文件）判定：带协议（data:/blob:/http:/file:/package:）或绝对路径的都不是。 */
function isRelativeUri(uri:string){return !/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(uri)}
/** 按扩展名给 blob MIME（贴图要给对，GLTFLoader 才按图片解码）。 */
function mimeOf(path:string):string{
 const extension=(path.toLowerCase().split('.').pop()??'')
 return ({bin:'application/octet-stream',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',bmp:'image/bmp',gif:'image/gif',tga:'image/x-tga',dds:'image/vnd-ms.dds',ktx2:'image/ktx2',gltf:'model/gltf+json',glb:'model/gltf-binary',mtl:'text/plain',obj:'text/plain',stl:'model/stl'})[extension]??'application/octet-stream'
}
/** 单实体合成场景（泼溅件）：一个资源、一份视觉声明。 */
function splatScene(name:string):SceneSnapshot{
 const representation={uri:name,mimeType:'application/octet-stream',role:'visual'}
 const resource:ResourceRef={resourceId:'lyapunov-model-preview',version:1,original:representation,representations:[representation],source:{units:'m',upAxis:'Y',handedness:'right',metersPerUnit:1}}
 const entity:Entity={entityId:'lyapunov-model-preview',name,transform:identityTransform(),resources:[resource],components:{visual:{kind:'splat',sourceTransformApplied:false}}}
 return{sceneId:'lyapunov-model-preview',revision:1,coordinates:SCENE_COORDINATES,entities:[entity]}
}
/** 机器人合成场景：与工作台里的 MJCF/URDF 实体同形，viewer 走既有的机器人装配路径。 */
function robotScene(robot:Record<string,unknown>,name:string):SceneSnapshot{
 const representation={uri:name,mimeType:'model/mjcf',role:'visual'}
 const resource:ResourceRef={resourceId:'lyapunov-model-preview',version:1,original:representation,representations:[representation],source:{units:'m',upAxis:'Z',handedness:'right',metersPerUnit:1}}
 const entity:Entity={entityId:'lyapunov-model-preview',name,transform:identityTransform(),resources:[resource],components:{visual:{kind:'robot',robot}}}
 return{sceneId:'lyapunov-model-preview',revision:1,coordinates:SCENE_COORDINATES,entities:[entity]}
}
/** 无材质的几何（STL/PLY/VTK 只给几何）包一层标准材质；带顶点色的用顶点色。 */
function meshOf(geometry:THREE.BufferGeometry,name:string):THREE.Mesh{
 const material=geometry.getAttribute('color')
  ?new THREE.MeshStandardMaterial({vertexColors:true,roughness:0.75,metalness:0.05})
  :new THREE.MeshStandardMaterial({color:0xb8c4d4,roughness:0.6,metalness:0.15,side:THREE.DoubleSide})
 const mesh=new THREE.Mesh(geometry,material)
 mesh.name=name
 return mesh
}
/** 网格规模文案（顶点/三角面）；同一个数字也是"真的解析出几何"的证据。 */
function geometryText(geometry:THREE.BufferGeometry):string{
 const vertices=geometry.getAttribute('position')?.count??0
 const triangles=geometry.index?geometry.index.count/3:vertices/3
 return `${vertices} 顶点 · ${Math.round(triangles)} 三角面`
}
/** 对象里的网格数量（0 表示只解析出空场景图，要给出可读说明而不是一片空白）。 */
function meshCount(object:THREE.Object3D):number{
 let count=0
 object.traverse(child=>{if(child instanceof THREE.Mesh)count+=1})
 return count
}
/** 多网格对象的规模文案（OBJ/FBX/DAE/3MF/USDZ 解析结果多是 Group）。 */
function objectText(object:THREE.Object3D):string{
 let meshes=0,vertices=0,triangles=0
 object.traverse(child=>{
  if(!(child instanceof THREE.Mesh))return
  meshes+=1
  const count=child.geometry.getAttribute('position')?.count??0
  vertices+=count
  triangles+=child.geometry.index?child.geometry.index.count/3:count/3
 })
 if(!meshes)return `无网格 · ${object.children.length} 个子节点`
 return `${meshes} 网格 · ${vertices} 顶点 · ${Math.round(triangles)} 三角面`
}
/**
 * 给直接对象套一层"上轴"包装：文件里没有上轴声明的格式（STL/OBJ/PLY/VTK）默认按 Z-up 世界直接放，
 * 需要时旋转 +90°X 当作 Y-up 源；viewer 的相机/网格本身是 Z-up，所以包装只做这一件事。
 * 重新包装会把对象从旧包装里摘出来（three 的 add 自带 reparent），旧包装随后被 viewer 释放，不会连带释放几何。
 */
function wrapUpAxis(object:THREE.Object3D,upAxis:'Y'|'Z'):THREE.Group{
 const wrapper=new THREE.Group()
 if(upAxis==='Y')wrapper.rotateX(Math.PI/2)
 wrapper.add(object)
 return wrapper
}
/** 预览对象统一收尾：缺法线的几何补一份——否则标准材质在灯光下渲染成全黑（DAE/VTK/PLY 都可能省法线）。 */
function ensureNormals(object:THREE.Object3D):void{
 object.traverse(child=>{
  if(!(child instanceof THREE.Mesh))return
  const geometry=child.geometry
  if(!geometry.getAttribute('normal')&&geometry.getAttribute('position'))geometry.computeVertexNormals()
 })
}
/** 宿主 RPC 的 base64 载荷 → 字节。 */
function base64ToBytes(data:string):Uint8Array{
 const binary=atob(data),bytes=new Uint8Array(binary.length)
 for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index)
 return bytes
}
/** 读主文件字节。 */
function readPath(ctx:LoadContext,path:string):Promise<Uint8Array>{return ctx.readBytes(ctx.sessionId,path,ctx.signal)}
/** 读同级依赖（相对主文件目录）。 */
function readSibling(ctx:LoadContext,relative:string):Promise<Uint8Array>{return readPath(ctx,joinPath(dirOf(ctx.path),relative))}
/** 字节 → blob URL，并登记到本次加载的撤销清单。 */
function blobUrl(ctx:LoadContext,bytes:Uint8Array,mimeType:string):string{
 const url=URL.createObjectURL(new Blob([toArrayBuffer(bytes)],{type:mimeType}))
 ctx.urls.push(url)
 return url
}
/** 登记一次缺失依赖（去重），返回给调用方复用的文案。 */
function noteMissing(ctx:LoadContext,reference:string,reason:unknown):string{
 const message=`${reference}：${messageOf(reason)}`
 if(!ctx.missing.includes(message)){ctx.missing.push(message);ctx.onMissing?.()}
 return message
}
/**
 * 宿主模型预览字节路由（支持 `Range`）：泼溅件直连，避免把大文件读成全量 blob。
 */
function bytesRoute(ctx:LoadContext){return `${BYTES_ROUTE}?sessionId=${encodeURIComponent(ctx.sessionId)}&path=${encodeURIComponent(ctx.path)}`}
/**
 * 试读宿主 Range 路由的首段：通过 ⇒ 返回 URL 与首段（后续字节由 Spark 自己按需取）；
 * 失败 ⇒ 登记一行可见原因并返回 undefined，调用方回落到工作区读接口（`readAll`）——路由没挂上也不让预览失败。
 */
async function rangeHead(ctx:LoadContext,length:number):Promise<{url:string;head:Uint8Array}|undefined>{
 const url=bytesRoute(ctx)
 try{
  const response=await fetch(url,{headers:{Range:`bytes=0-${Math.max(0,length-1)}`},signal:ctx.signal})
  if(!response.ok)throw Error(`HTTP ${response.status} ${response.statusText}`)
  return{url,head:new Uint8Array(await response.arrayBuffer())}
 }catch(reason){
  noteMissing(ctx,`宿主 Range 路由 ${BYTES_ROUTE} 不可用，已回落工作区读接口`,reason)
  return undefined
 }
}
/** 泼溅件快照：资源地址既可能是宿主 Range 路由，也可能是回落时的 blob URL。 */
function splatPreview(ctx:LoadContext,uri:string,detail:string):Preview{
 return{via:'scene',snapshot:splatScene(nameOf(ctx.path)),resolveResource:()=>uri,detail}
}
/** 深度收集 glTF 里所有字符串型 `uri` 字段（`buffers[].uri` 与 `images[].uri` 都在其中）。 */
function collectUris(value:unknown,found=new Set<string>()):Set<string>{
 if(Array.isArray(value)){for(const item of value)collectUris(item,found)}
 else if(value&&typeof value==='object'){
  for(const [key,item] of Object.entries(value as Record<string,unknown>)){
   if(key==='uri'&&typeof item==='string')found.add(item)
   else collectUris(item,found)
  }
 }
 return found
}
/** 深度改写 `uri` 字段；没读到的依赖保留原值（失败信息里能看出缺的是哪个引用）。 */
function rewriteUris(value:unknown,urls:ReadonlyMap<string,string>):unknown{
 if(Array.isArray(value))return value.map(item=>rewriteUris(item,urls))
 if(value&&typeof value==='object'){
  const target:Record<string,unknown>={}
  for(const [key,item] of Object.entries(value as Record<string,unknown>))target[key]=key==='uri'&&typeof item==='string'?(urls.get(item)??item):rewriteUris(item,urls)
  return target
 }
 return value
}
/**
 * 预览期间的"同级依赖"映射与缺失登记口。
 *
 * 为什么需要：`.glb` 的外部依赖（例如 `tex.ktx2`）由 GLTFLoader 以**文档根**为基准解析，
 * 而文档是内存里的 ArrayBuffer，于是相对 URI 会 404；旧实现还因为 GLTFLoader 内部
 * `.catch(()=>null)` 把贴图失败吞掉，预览停在 "ready"、缺失清单为空（用户只看到没贴图的模型）。
 * 这里用一个共享 LoadingManager：相对 URI 按 **basename** 映射到预取出来的 blob URL，
 * 加载失败则记进当前加载的 `missing`。
 */
const previewDependencyUrls=new Map<string,string>()
/**
 * 当前预览的"缺失依赖"登记口。**故意不在 parse 结束时清掉**：GLTFLoader 的贴图/依赖是异步加载的，
 * 失败（404/解码错）常常在 `parseAsync` 之后才到；旧写法在 finally 里清空回调，于是错误落进了空气——
 * 界面停在 "ready" 却没贴图、也没有任何解释（实测：把同名 `.ktx2` 移走后彩色像素 0、缺失清单为空）。
 */
let activeDependencySink:((reference:string)=>void)|undefined
const previewLoadManager=new THREE.LoadingManager()
previewLoadManager.setURLModifier(url=>previewDependencyUrls.get(basenameOf(url))??url)
previewLoadManager.onError=url=>activeDependencySink?.(basenameOf(url))
let decoderGltfLoader:GLTFLoader|undefined
/**
 * 带压缩扩展解码器的 `GLTFLoader` 单例（同一实例复用解码器与 worker）。
 * 解码器脚本/wasm 由宿主静态路由提供（`DRACO_DECODER_PATH`/`KTX2_TRANSCODER_PATH`，不内联进客户端包）；
 * KTX2 必须先 `detectSupport(renderer)` 才知道该转码成哪种压缩纹理，而预览的渲染器要等加载完成才建，
 * 所以这里借一个临时 WebGL 上下文探一次就释放（只探能力，不进场景）。
 */
function gltfLoaderWithDecoders():GLTFLoader{
 if(decoderGltfLoader)return decoderGltfLoader
 const ktx2=new KTX2Loader(previewLoadManager).setTranscoderPath(KTX2_TRANSCODER_PATH)
 try{
  const probe=new THREE.WebGLRenderer({antialias:false})
  try{ktx2.detectSupport(probe)}finally{probe.forceContextLoss();probe.dispose()}
 }catch{/* 探测不出上下文时不挡别的格式：真用到 KTX2 贴图时 KTX2Loader 会给出自己的可读错误 */}
 // 解码器实例也必须带上同一个 manager：KTX2Loader/DRACOLoader 是各自 new 的，
// 它们加载 `.ktx2`/`.bin` 时用的是**自己的** manager——只挂 GLTFLoader 的 manager
// 会让外部 `.ktx2` 绕过 URL 改写，仍然按文档根 404（实测：正例与"删掉依赖"的负对照画布完全一致）。
 decoderGltfLoader=new GLTFLoader(previewLoadManager).setDRACOLoader(new DRACOLoader(previewLoadManager).setDecoderPath(DRACO_DECODER_PATH)).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder)
 return decoderGltfLoader
}
/** glTF/GLB 解析：把解码器路由写进错误里，这样 404 时看到的是"宿主没挂解码器"而不是一句 loader 内部报错。 */
async function parseGltf(input:ArrayBuffer|string,path:string):Promise<THREE.Object3D>{
 try{return(await gltfLoaderWithDecoders().parseAsync(input,path)).scene}
 catch(reason){throw Error(`glTF 解析失败：${messageOf(reason)}（DRACO/KTX2 解码器与 meshopt 由宿主路由 ${DRACO_DECODER_PATH} 与 ${KTX2_TRANSCODER_PATH} 提供，404 即宿主未挂载解码器）`)}
}
/**
 * 二进制 GLB 的容器魔数（前 4 字节 ASCII `glTF`）。扩展名与内容不一致时用内容说话：
 * `.ply` 读文件头判别泼溅/网格、`.usdz` 判 `PK\x03\x04` 决定走宿主转换，`.gltf` 同理。
 */
export function isBinaryGltf(bytes:Uint8Array):boolean{return bytes[0]===0x67&&bytes[1]===0x6c&&bytes[2]===0x54&&bytes[3]===0x46}
/** glTF：外部 `.bin`/贴图逐个读成 blob URL 后改写 JSON，再交给带解码器的 GLTFLoader。 */
async function loadGltf(ctx:LoadContext,bytes:Uint8Array):Promise<Preview>{
 // 内容是二进制 GLB 的 `.gltf`（真实素材出现过：下载器把 `.glb` 存成 `.gltf`）不能走文本 JSON 分支，
 // 否则只会得到 `SyntaxError: JSON parse error: Unexpected identifier "glTF"`。与 `.glb` 分支同行为（含同级依赖预取）。
 if(isBinaryGltf(bytes)){
  await prefetchSiblingAssets(ctx)
  return{via:'object',object:await parseGltf(toArrayBuffer(bytes),''),detail:`网格 · ${sizeText(bytes.byteLength)} · 内容为 GLB`,upAxis:'Y',flippable:false}
 }
 let json:unknown
 try{json=JSON.parse(decodeText(bytes))}
 catch(reason){throw Error(`glTF JSON 解析失败：${messageOf(reason)}`)}
 const urls=new Map<string,string>()
 for(const uri of collectUris(json)){
  if(!isRelativeUri(uri))continue
  try{urls.set(uri,blobUrl(ctx,await readSibling(ctx,uri),mimeOf(uri)))}
  catch(reason){noteMissing(ctx,uri,reason)}
 }
 const object=await parseGltf(JSON.stringify(rewriteUris(json,urls)),'')
 return{via:'object',object,detail:`网格 · ${sizeText(bytes.byteLength)}${urls.size?` · 内联依赖 ${urls.size}`:''}`,upAxis:'Y',flippable:false}
}
/** `.spz`/`.splat`：一律先走宿主 Range 路由（大文件不再 readAll 成全量 blob）；路由不可用时回落读取全量字节。 */
async function loadSplat(ctx:LoadContext):Promise<Preview>{
 const route=await rangeHead(ctx,1)
 if(route)return splatPreview(ctx,route.url,'泼溅件 · 宿主 Range 路由')
 const bytes=await readPath(ctx,ctx.path)
 return splatPreview(ctx,blobUrl(ctx,bytes,'application/octet-stream'),`泼溅件 · ${sizeText(bytes.byteLength)}`)
}
/** PLY 两态：文件头含 3DGS 属性 ⇒ 泼溅件（直连宿主 Range 路由），否则按普通网格解析（仍按现状读全量字节）。 */
async function loadPly(ctx:LoadContext):Promise<Preview>{
 const route=await rangeHead(ctx,SPLAT_SNIFF_BYTES)
 const head=route?route.head:await readPath(ctx,ctx.path)
 const marker=SPLAT_PLY_MARKERS.find(key=>decodeText(head.subarray(0,SPLAT_SNIFF_BYTES)).includes(key))
 if(marker)return splatPreview(ctx,route?route.url:blobUrl(ctx,head,'application/octet-stream'),`泼溅件 · 文件头含 ${marker}${route?' · 宿主 Range 路由':` · ${sizeText(head.byteLength)}`}`)
 const bytes=route?await readPath(ctx,ctx.path):head
 const geometry=new PLYLoader().parse(toArrayBuffer(bytes))
 return{via:'object',object:meshOf(geometry,nameOf(ctx.path)),detail:`网格 · ${geometryText(geometry)}`,upAxis:'Z',flippable:true}
}
/** STL：只有三角面，没有材质/坐标声明（默认 Z-up，界面可切）。 */
function loadStl(ctx:LoadContext,bytes:Uint8Array):Preview{
 const geometry=new STLLoader().parse(toArrayBuffer(bytes))
 return{via:'object',object:meshOf(geometry,nameOf(ctx.path)),detail:`网格 · ${geometryText(geometry)}`,upAxis:'Z',flippable:true}
}
/** 把 MTL 里的贴图引用改写成 blob URL（贴图同样按同级相对路径读；读不到只报告，不挡材质）。 */
async function rewriteMtlImages(ctx:LoadContext,text:string):Promise<string>{
 const lines=text.split('\n')
 for(let index=0;index<lines.length;index+=1){
  const line=lines[index]!
  if(!/^\s*(?:map_\w+|bump|disp|decal|refl|norm)\s/i.test(line))continue
  const reference=/(\S+)\s*$/.exec(line.trim())?.[1]
  if(!reference||!isRelativeUri(reference)||!IMAGE_EXTENSION.test(reference))continue
  try{lines[index]=line.replace(reference,blobUrl(ctx,await readSibling(ctx,reference),mimeOf(reference)))}
  catch(reason){noteMissing(ctx,reference,reason)}
 }
 return lines.join('\n')
}
/** OBJ：同名/`mtllib` 声明的 `.mtl` 存在就一起加载（不存在只报告，几何照常显示）。 */
async function loadObj(ctx:LoadContext,bytes:Uint8Array):Promise<Preview>{
 const text=decodeText(bytes),name=nameOf(ctx.path),loader=new OBJLoader()
 const declared=/^\s*mtllib\s+(.+)$/im.exec(text)?.[1]?.trim().split(/\s+/)[0]
 const materialFile=declared||name.replace(/\.obj$/i,'.mtl')
 try{
  const materials=new MTLLoader().parse(await rewriteMtlImages(ctx,decodeText(await readSibling(ctx,materialFile))),'')
  materials.preload()
  loader.setMaterials(materials)
 }catch(reason){noteMissing(ctx,materialFile,reason)}
 const object=loader.parse(text)
 return{via:'object',object,detail:objectText(object),upAxis:'Z',flippable:true}
}
/**
 * FBX 所在目录的同级文件清单（工作区 `action:'list'`，只取文件名）。
 * 清单读不到不挡预览：登记原因后返回空清单，几何照常显示。
 */
/** 同级依赖的扩展名白名单（贴图/几何/二进制）：`.glb` 与 FBX 共用，只按 basename 匹配。 */
const SIBLING_ASSET_EXTENSIONS=/\.(ktx2|bin|png|jpe?g|webp|tga|dds|basis)$/i
/**
 * 把同目录里像"外部依赖"的文件预取成 blob URL（basename → URL），供 LoadingManager 同步改写。
 * 预取失败（目录列不出、文件读不到）不抛错：交给 onError 记缺失，预览本体仍可尝试加载。
 */
async function prefetchSiblingAssets(ctx:LoadContext):Promise<void>{
 previewDependencyUrls.clear()
 let names:readonly string[]
 try{names=await listSiblings(ctx)}catch(reason){noteMissing(ctx,`${dirOf(ctx.path)||'.'}（同级依赖目录）`,reason);return}
 const self=basenameOf(ctx.path)
 for(const name of names){
  if(name===self||!SIBLING_ASSET_EXTENSIONS.test(name))continue
  try{previewDependencyUrls.set(name,blobUrl(ctx,await readSibling(ctx,name),mimeOf(name)))}catch(reason){noteMissing(ctx,name,reason)}
 }
}
async function listSiblings(ctx:LoadContext):Promise<readonly string[]>{
 const response=await fetch('/api/lyapunov/workspace',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:ctx.sessionId,action:'list',input:{path:dirOf(ctx.path)||'.'}}),signal:ctx.signal})
 const text=await response.text()
 let payload:{entries?:Array<{name?:unknown;type?:unknown}>;error?:unknown}|undefined
 try{payload=text?JSON.parse(text) as typeof payload:undefined}catch{payload=undefined}
 if(!response.ok)throw Error(`HTTP ${response.status}：${messageOf(payload?.error??(text.slice(0,120)||response.statusText))}`)
 if(!payload?.entries)throw Error(`响应里没有 entries：${text.slice(0,120)||'空响应'}`)
 return payload.entries.filter(entry=>entry.type!=='directory'&&typeof entry.name==='string').map(entry=>String(entry.name))
}
/**
 * FBX（二进制/ASCII 由 FBXLoader 判定；规范默认 Y-up）。
 * FBX 里的贴图引用常是反斜杠或绝对路径，浏览器直接取必然 404（表现成没有任何贴图的模型），
 * 因此先把同级目录里的图片读成 blob URL，再用 LoadingManager 的 URL 改写**只按 basename** 命中；
 * 未命中的引用由 LoadingManager 的 onError 落进缺失依赖清单，不静默变成无贴图。
 */
async function loadFbx(ctx:LoadContext,bytes:Uint8Array):Promise<Preview>{
 const table=new Map<string,string>()
 try{
  for(const name of await listSiblings(ctx)){
   if(!IMAGE_EXTENSION.test(name))continue
   try{table.set(name.toLowerCase(),blobUrl(ctx,await readSibling(ctx,name),mimeOf(name)))}
   catch(reason){noteMissing(ctx,name,reason)}
  }
 }catch(reason){noteMissing(ctx,'FBX 同级文件清单（工作区 action:list）',reason)}
 const manager=new THREE.LoadingManager()
 manager.setURLModifier(url=>table.get(basenameOf(url).toLowerCase())??url)
 manager.onError=url=>{noteMissing(ctx,basenameOf(url),'FBX 贴图没能加载：同级目录里没有这个文件名，或该图片格式浏览器解不了（只按文件名匹配）')}
 const object=new FBXLoader(manager).parse(toArrayBuffer(bytes),'')
 return{via:'object',object,detail:objectText(object),upAxis:'Y',flippable:false,...(table.size?{note:`FBX 外部贴图：同级目录命中 ${table.size} 张（只按文件名匹配）`}:{})}
}
/** DAE（Collada）：自带场景图与材质，规范坐标 Y-up。 */
function loadDae(ctx:LoadContext,bytes:Uint8Array):Preview{
 const collada=new ColladaLoader().parse(decodeText(bytes),'')
 return{via:'object',object:collada.scene,detail:objectText(collada.scene),upAxis:'Y',flippable:false}
}
/** 3MF：规范坐标 Z-up。 */
function loadThreeMf(ctx:LoadContext,bytes:Uint8Array):Preview{
 const object=new ThreeMFLoader().parse(toArrayBuffer(bytes))
 return{via:'object',object,detail:objectText(object),upAxis:'Z',flippable:false}
}
/**
 * USDZ：`PK\x03\x04` 开头是 zip 包（二进制 USDZ，内部多为 usdc），three 的 USDLoader 只认 ASCII usda、
 * 解析出来是 0 网格 ⇒ 交给宿主的 Blender 转换分支（复用 `converted-glb`）；ASCII `#usda` 仍走内联解析（Y-up）。
 */
async function loadUsdz(ctx:LoadContext,bytes:Uint8Array):Promise<Preview>{
 if(bytes[0]===0x50&&bytes[1]===0x4B&&bytes[2]===0x03&&bytes[3]===0x04)return await loadConverted(ctx,'宿主转换 GLB（二进制 USDZ）')
 const object=new USDLoader().parse(toArrayBuffer(bytes))
 const meshes=meshCount(object)
 return{via:'object',object,detail:objectText(object),upAxis:'Y',flippable:false,...(meshes?{}:{note:'three 的 USDLoader 只支持 ASCII usda：这个 USDZ 里是二进制 usdc（Blender 默认导出即如此），因此没有解析出几何。'})}
}
/** VTK：只支持 POLYDATA；缺法线时补一份，再当网格显示。 */
function loadVtk(ctx:LoadContext,bytes:Uint8Array):Preview{
 const geometry=new VTKLoader().parse(toArrayBuffer(bytes),'')
 return{via:'object',object:meshOf(geometry,nameOf(ctx.path)),detail:`网格 · ${geometryText(geometry)}`,upAxis:'Z',flippable:true}
}
/** 宿主模型预览 RPC 的响应（契约见文件头）。 */
interface HostPreview{kind?:string;reason?:string;robot?:Record<string,unknown>;bytesBase64?:string;bytesLength?:number;cachedPath?:string;error?:string}
/** 宿主模型预览 RPC（`action:'model-preview'`）；非 2xx 直接抛后端给的 `error`，无 JSON 也给出可读原因。 */
async function hostPreview(ctx:LoadContext):Promise<HostPreview>{
 let response:Response
 try{
  response=await fetch('/api/lyapunov/workspace',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:ctx.sessionId,action:'model-preview',input:{path:ctx.path}}),signal:ctx.signal})
 }catch(reason){
  throw Error(`模型转换接口调用失败（宿主可能还没有实现 model-preview）：${messageOf(reason)}`)
 }
 const text=await response.text()
 let payload:HostPreview|undefined
 try{payload=text?JSON.parse(text) as HostPreview:undefined}catch{payload=undefined}
 if(!payload)throw Error(`模型转换接口返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0,200)||'空响应'}`)
 if(!response.ok)throw Error(`模型转换接口失败（HTTP ${response.status}）：${String(payload.error??response.statusText)}`)
 return payload
}
/**
 * 机器人网格解析器：viewer 传进来的 `uri` 是 `new URL(文件引用, baseUri)` 的绝对形式。
 * `file://` 取 pathname 直接读（读接口允许工作区外路径）；`package://` 与裸相对引用按
 * "机器人文件目录 + 引用路径" 与 "机器人文件目录 + 包名 + 引用路径" 两种候选依次尝试。
 * 全失败就登记缺失并抛出可读原因，viewer 会把它显示成红字。
 */
function robotResolver(ctx:LoadContext,robot:Record<string,unknown>):(uri:string)=>Promise<string>{
 const baseUri=typeof robot.baseUri==='string'?robot.baseUri:undefined
 const dir=dirOf(ctx.path)
 return async uri=>{
  const candidates:string[]=[]
  if(/^file:/i.test(uri)){
   try{candidates.push(decodeURIComponent(new URL(uri).pathname))}catch{/* 非法 file: URL 落到相对候选 */}
  }
  if(!candidates.length){
   if(/^[a-z][a-z\d+.-]*:\/\//i.test(uri)){
    const parsed=new URL(uri)
    candidates.push(joinPath(dir,parsed.pathname),joinPath(dir,`${parsed.hostname}${parsed.pathname}`))
   }else candidates.push(joinPath(dir,uri))
   if(baseUri){
    try{candidates.push(decodeURIComponent(new URL(uri,baseUri).pathname))}catch{/* baseUri 不可用时只剩相对候选 */}
   }
  }
  let last:unknown
  for(const candidate of candidates){
   try{return blobUrl(ctx,await readPath(ctx,candidate),mimeOf(candidate))}
   catch(reason){last=reason}
  }
  throw Error(noteMissing(ctx,uri,last??'没有可用的候选路径'))
 }
}
/** 机器人：宿主给 MJCF/URDF 文档（含 baseUri），viewer 装配视觉网格。 */
async function loadRobot(ctx:LoadContext):Promise<Preview>{
 const payload=await hostPreview(ctx)
 if(payload.kind==='unsupported')throw Error(`宿主没有给出机器人预览：${payload.reason??'未说明原因'}`)
 if(payload.kind!=='robot'||!payload.robot)throw Error(`宿主返回的预览类型不是机器人：${payload.kind??'未知'}`)
 const format=payload.robot.format==='urdf'?'URDF':'MJCF'
 return{via:'scene',snapshot:robotScene(payload.robot,nameOf(ctx.path)),resolveResource:robotResolver(ctx,payload.robot),detail:`机器人 · ${format}`}
}
/** `.blend`/`.usd*`/二进制 USDZ：宿主用 Blender 转成 GLB（base64）后走网格渲染。 */
async function loadConverted(ctx:LoadContext,label='Blender 转换 GLB'):Promise<Preview>{
 const payload=await hostPreview(ctx)
 if(payload.kind==='unsupported')throw Error(`宿主无法转换这个文件：${payload.reason??'未说明原因'}`)
 if(payload.kind!=='converted-glb'||typeof payload.bytesBase64!=='string')throw Error(`宿主返回的预览类型不是转换后的 GLB：${payload.kind??'未知'}`)
 const bytes=base64ToBytes(payload.bytesBase64)
 if(typeof payload.bytesLength==='number'&&payload.bytesLength!==bytes.byteLength)ctx.missing.push(`转换结果长度与声明不符：声明 ${payload.bytesLength} 字节，解出 ${bytes.byteLength} 字节`)
 const object=await parseGltf(toArrayBuffer(bytes),'')
 return{via:'object',object,detail:`${label} · ${sizeText(bytes.byteLength)}`,upAxis:'Y',flippable:false}
}
/** 按格式分派；每条分支的产物都是同一个 `Preview`。 */
async function loadPreview(ctx:LoadContext):Promise<Preview>{
 // 每次加载都重新绑定到本次的 ctx：晚到的依赖错误也记进它，并由 onMissing 触发界面刷新。
 activeDependencySink=reference=>noteMissing(ctx,reference,Error('依赖加载失败（缺失或解码失败，详见控制台）'))
 switch(ctx.format){
  case'glb':{
   const bytes=await readPath(ctx,ctx.path)
   // 外部依赖（如 .ktx2/.bin/贴图）先预取成 blob URL，再靠 LoadingManager 按 basename 改写；
   // 同时把加载失败记进缺失清单，避免"ready 但没贴图、界面无解释"。
   await prefetchSiblingAssets(ctx)
   const object=await parseGltf(toArrayBuffer(bytes),'')
   return{via:'object',object,detail:`网格 · ${sizeText(bytes.byteLength)}${previewDependencyUrls.size?` · 同级依赖 ${previewDependencyUrls.size}`:''}`,upAxis:'Y',flippable:false}
  }
  case'gltf':return await loadGltf(ctx,await readPath(ctx,ctx.path))
  case'splat':return await loadSplat(ctx)
  case'ply':return await loadPly(ctx)
  case'stl':return loadStl(ctx,await readPath(ctx,ctx.path))
  case'obj':return await loadObj(ctx,await readPath(ctx,ctx.path))
  case'fbx':return await loadFbx(ctx,await readPath(ctx,ctx.path))
  case'dae':return loadDae(ctx,await readPath(ctx,ctx.path))
  case'3mf':return loadThreeMf(ctx,await readPath(ctx,ctx.path))
  case'usdz':return await loadUsdz(ctx,await readPath(ctx,ctx.path))
  case'vtk':return loadVtk(ctx,await readPath(ctx,ctx.path))
  case'robot':return await loadRobot(ctx)
  case'convert':return await loadConverted(ctx)
  default:throw Error(`MODEL_PREVIEW_FORMAT_UNSUPPORTED: ${String(ctx.format)}`)
 }
}
const modelPreviewStyle=`
.lya-model-preview{--lya-bg:var(--dsw-alias-bg-base);--lya-text:var(--dsw-alias-label-primary);--lya-muted:var(--dsw-alias-label-secondary);--lya-line:color-mix(in srgb,var(--lya-text) 10%,transparent);--lya-accent:var(--dsw-alias-link);height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;font:13px/1.6 system-ui;color:var(--lya-text);background:var(--lya-bg)}
.lya-model-preview *{box-sizing:border-box}
.lya-model-preview .code-toolbar{padding:10px 14px;border-bottom:1px solid var(--lya-line);flex-shrink:0;gap:6px;display:flex;align-items:center}
.lya-model-preview .code-toolbar>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-weight:550}
.lya-model-preview .code-toolbar>small{color:var(--lya-muted);margin-right:8px}
.lya-model-preview :is(p,form){padding:7px 14px;flex-shrink:0;margin:0}
.lya-model-preview .code-error{color:var(--dsw-alias-state-error-primary)}
.lya-model-preview .code-note{color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--lya-line)}
.lya-model-preview .code-missing{padding:7px 14px;flex-shrink:0;margin:0;max-height:26%;overflow:auto;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--lya-line)}
.lya-model-preview .code-missing ul{margin:3px 0 0;padding-left:18px}
.lya-model-preview .code-missing li{overflow-wrap:anywhere}
.lya-model-preview .lya-model-stage{position:relative;flex:1;min-height:0;background:#121a24}
.lya-model-preview .lya-model-stage>canvas{display:block;width:100%;height:100%}
.lya-model-preview .lya-model-stage[data-status=failed]>canvas{display:none}
.lya-model-preview .lya-model-hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--lya-muted);pointer-events:none;text-align:center;padding:0 16px}
.lya-model-preview .lya-model-hint[data-status=ready]{display:none}
`
/**
 * 模型预览标签体：地址变化或组件卸载时释放画布、缓存与对象 URL。
 * @param props - 标签运行面（`useTabInfo` 给地址与生命周期信号）、本包文案、以及字节读取器。
 * @returns 工具行 + 画布；加载中/转换中/失败时在同一位置给出可见文案。
 */
export function ModelPreviewBody({t,useTabInfo,readBytes}:Props){
 const {tab}=useTabInfo()
 const address=tab.navigation.address
 const tr=(zh:string,en:string)=>t('open')==='Files & terminal'?en:zh
 const translateRef=useRef(tr);translateRef.current=tr
 const stage=useRef<HTMLDivElement|null>(null)
 const viewer=useRef<SceneViewer|null>(null)
 const preview=useRef<{object:THREE.Object3D;upAxis:'Y'|'Z'}|null>(null)
 const [status,setStatus]=useState<'loading'|'working'|'ready'|'failed'>('loading')
 const [hint,setHint]=useState('')
 const [error,setError]=useState('')
 const [detail,setDetail]=useState('')
 const [missing,setMissing]=useState<readonly string[]>([])
 const [note,setNote]=useState('')
 const [upAxis,setUpAxis]=useState<'Y'|'Z'|undefined>(undefined)
 const file=useMemo(()=>parseFileAddress(address),[address])
 const name=file?pathPartsOf(file.path).name:tr('模型','Model')
 useEffect(()=>{
  const node=stage.current
  const format=file?.scope==='session'?modelKindOf(file.path):undefined
  viewer.current=null;preview.current=null
  setStatus('loading');setHint('');setError('');setDetail('');setMissing([]);setNote('');setUpAxis(undefined)
  if(!file||file.scope!=='session'||!format){setStatus('failed');setError(tr(`模型预览只认工作区会话里的 3D 文件（${SUPPORTED_TEXT}）。`,`Model preview only opens 3D files from a workspace session (${SUPPORTED_TEXT}).`));return}
  if(!node)return
  let disposed=false
  const abort=new AbortController(),forward=()=>abort.abort()
  if(tab.signal.aborted)abort.abort();else tab.signal.addEventListener('abort',forward)
  const context:LoadContext={sessionId:file.sessionId,path:file.path,format,signal:abort.signal,readBytes,urls:[],missing:[],onMissing:()=>{if(!disposed&&!abort.signal.aborted)setMissing([...context.missing])}}
  const fail=(reason:unknown)=>{if(!disposed){setError(messageOf(reason));setStatus('failed')}}
  const start=async()=>{
   // 转换/机器人是宿主重活（Blender 冷启动），先给出与"读字节"不同的可见状态。
   if(format==='convert'||format==='robot'){
    setStatus('working')
    setHint(format==='convert'?tr('正在用 Blender 转换…','Converting with Blender…'):tr('正在解析机器人文件…','Parsing the robot file…'))
   }
   const loaded=await loadPreview(context)
   if(disposed||abort.signal.aborted)return
   const instance=createViewer({container:node,translate:(zh,en)=>translateRef.current(zh,en),resolveResource:uri=>loaded.via==='scene'?loaded.resolveResource(uri):'',onError:reason=>fail(reason)})
   viewer.current=instance
   if(loaded.via==='scene'){
    await instance.setScene(loaded.snapshot)
    if(disposed)return
    // 取景只做一次；之后相机归用户，重开同一地址不会打断观察视角。
    instance.openDefaultView()
   }else{
    ensureNormals(loaded.object)
    preview.current={object:loaded.object,upAxis:loaded.upAxis}
    // 取景要求包围盒有限；上游 loader 对某些文件会解析出 NaN 几何（如 Blender 导出的 usda 四边形），
    // 这时对象已经进场景、只是不自动取景，必须给出可读说明而不是让 VIEWER_BOUNDS_NOT_FINITE 裸奔。
    try{instance.setPreviewObject(wrapUpAxis(loaded.object,loaded.upAxis))}
    catch(reason){setNote(tr(`几何里有非法数值（NaN/Inf），已显示但无法自动取景：${messageOf(reason)}`,`The geometry contains non-finite values; it is shown but cannot be framed: ${messageOf(reason)}`))}
    if(loaded.note)setNote(loaded.note)
   }
   if(disposed)return
   setDetail(loaded.detail)
   setMissing([...context.missing])
   setUpAxis(loaded.via==='object'&&loaded.flippable?loaded.upAxis:undefined)
   // setScene 内部的加载失败会先经 onError 落到 failed：这里不能把失败覆盖成 ready。
   setStatus(current=>current==='failed'?current:'ready')
  }
  void start().catch(reason=>{fail(reason)})
  return()=>{
   disposed=true;tab.signal.removeEventListener('abort',forward);abort.abort()
   viewer.current?.dispose();viewer.current=null;preview.current=null
   for(const url of context.urls)URL.revokeObjectURL(url)
   context.urls.length=0
  }
 },[address,readBytes,tab.signal])
 /** 重新取景：不动相机以外的任何状态。 */
 const retry=()=>{const instance=viewer.current;if(instance)instance.frameAll()}
 /** 上轴切换：只重建包装层，不重新解析几何。 */
 const flip=()=>{
  const current=preview.current,instance=viewer.current
  if(!current||!instance)return
  const next=current.upAxis==='Z'?'Y':'Z'
  try{instance.setPreviewObject(wrapUpAxis(current.object,next));current.upAxis=next;setUpAxis(next)}
  catch(reason){setError(messageOf(reason));setStatus('failed')}
 }
 return <section className='lya-model-preview' aria-label={tr('模型预览','Model preview')}>
  <style>{modelPreviewStyle}</style>
  <div className='code-toolbar'><span title={file?.path??address}>{name}</span>{detail&&<small>{detail}</small>}
   {upAxis&&<button type='button' onClick={flip} title={tr('STL/OBJ/PLY/VTK 文件本身不声明上轴：在 Z 轴向上与 Y 轴向上之间切换','STL/OBJ/PLY/VTK declare no up axis: toggle between Z-up and Y-up')}>{tr('上轴','Up axis')} {upAxis}</button>}
   <button type='button' disabled={status!=='ready'} onClick={retry}>{tr('重新取景','Frame all')}</button></div>
  {error&&<p role='alert' className='code-error'>{error}</p>}
  {note&&<p role='status' className='code-note'>{note}</p>}
  {missing.length>0&&<div role='status' className='code-missing'>{tr('读不到的依赖：','Missing dependencies:')}<ul>{missing.map(item=><li key={item}>{item}</li>)}</ul></div>}
  <div ref={stage} className='lya-model-stage' data-status={status}>
   {status!=='ready'&&<p role='status' className='lya-model-hint' data-status={status}>{status==='failed'?tr('模型没有渲染出来，原因见上方提示。','The model is not rendered; the reason is above.'):status==='working'?hint:tr('正在读取并解析模型…','Reading and parsing the model…')}</p>}
  </div>
 </section>
}
