/**
 * 深度几何：把**真实相对深度产物**（本包 worker.py 的 npy + metadata）按调用方给的 K 与
 * worldFromCamera 投影成米制点/粗网格，尺度只来自**每张图自己的已知轴向深度锚点**。
 *
 * 分层与它的兄弟一样只有一条：`runDepthGeometry` 是共用 operation（Command／测试／其它工作流
 * 可直呼），`registerDepthGeometryTools` 只把同一 operation 注册成模型工具——行为只有一份。
 * 本文件不改 plugin.ts/operations.ts/types.ts：插件入口由 root 审核后接一行
 * `return registerDepthGeometryTools(ctx, config)` 即可——config 就是现有 `DepthEstimationConfig`，
 * 它的 `pythonPath` 在这里是同义字段（见 `DepthGeometryConfig.pythonPath`），不必写适配对象
 * （接线与参数详见 docs/DEPTH_GEOMETRY.md）。
 *
 * 边界（本切片不做的事）：
 *  · **逐图标定**：每张图的 scale/shift 只由该图自己的训练锚点拟合；`registration.frameId` 相同只说明
 *    世界坐标配准，不说明单目深度尺度一致。某图没有自己的锚点就只出相对预览，不借别的图的尺度；
 *  · 不做配准：多图合并要求调用方给每个条目同一个 `registration.frameId`，不一致直接拒绝；
 *  · 不产生尺度：锚点不足不做任何米制换算，也绝不用 min/max 归一化冒充米；
 *  · 不补看不到的面：只有掩码通过的采样像元成为顶点，三角面不跨遮挡跳变（像元级边检查在 Python 侧）；
 *  · 轴向深度 ≠ 射线距离：拟合与写出的 npy 都是沿相机 -z 的轴向深度，射线距离只在锚点报告里出现；
 *  · GLB 按 glTF 标准 **Y-up** 写出（产品世界 Z-up → (x,y,z)→(x,z,-y)，导入侧声明 upAxis=Y 再转回），
 *    两边约定成对，轴不会多转一次；
 *  · 相机约定沿用产品现有合同（sim-mujoco worker 的 camera calibration）：
 *    camera x 右 / y 上 / 看向 -z，`world = R * p_cam + t`，K 像素原点左上、x 右、y 下。
 *
 * 数值（拟合、掩码、反投影、GLB/PLY 写出）全在 `python/geometry.py` 里算；本层只做**运行层能真正确认的
 * 合同核对**：声明的产物真的存在/非空/落在本次产物目录内，以及 metadata/calibration 的返回语义自洽
 * （units ↔ 逐图 metric ↔ 产物类型 ↔ 是否有米制 npy、accepted 只与全部 verified 同在、掩码计数与各图像素一致）。
 * **不**重算拟合、**不**重解析 npy、**不**在运行层再写一套 GLB 结构解析器——GLB 的完整结构/数值独立检查在测试里
 * （已有 scene-kit `formats`/`glbJSON` 可复用），生产层只保证"产物在、归属对、返回合同成立"。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-commands'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveOutputRoot } from './operations.ts'

/** geometry.py 成功结果行的前缀；解析方不得硬编码字面量。 */
export const GEOMETRY_RESULT_PREFIX='LYAPUNOV_GEOMETRY_RESULT='
/** 产物 metadata/calibration 的 schema（Python 侧写死，本层只核对）。 */
export const GEOMETRY_SCHEMA='lyapunov.depth-geometry/1'
const here=dirname(fileURLToPath(import.meta.url))
/** 默认脚本落在包内 python/geometry.py；装配方可用 script 覆盖。 */
export const defaultGeometryScript=resolve(here,'../python/geometry.py')

/** 结构化失败：code 是稳定机器码，message 是给人看的原因与下一步。 */
export class DepthGeometryError extends Error{
  readonly code:string
  readonly detail:Record<string,unknown>
  constructor(code:string,message:string,detail:Record<string,unknown>={}){
    super(`${code}: ${message}`)
    this.name='DepthGeometryError'
    this.code=code
    this.detail=detail
  }
}

export interface DepthGeometryConfig{
  /** 跑 geometry.py 的解释器（需 numpy；顶点颜色另需 Pillow）。未配置时回落同名环境变量。 */
  python?:string
  /**
   * 解释器的兼容别名：深度估计插件的 config 里同一个字段就叫 `pythonPath`，
   * 装配时才能把现有 config 原样传进来（`registerDepthGeometryTools(ctx, config)`），不必写适配对象。
   */
  pythonPath?:string
  /** geometry.py 的路径覆盖；默认用包内 python/geometry.py。 */
  script?:string
  /** 相对路径的兜底基准目录；**优先用会话任务工作区的 cwd**，这里只是它缺席时的退路。 */
  workspace?:string
  /** 产物根覆盖；缺省与 depth_estimate 同一个输出根（见 operations.ts resolveOutputRoot）。 */
  dataDirectory?:string
}
export interface DepthGeometryPaths{python?:string;script:string;data:string}
/** 解释器来源写清楚：配置、本 operation 专用环境变量、还是复用深度估计那一个。 */
export type GeometryPythonSource='config'|'LYAPUNOV_DEPTH_GEOMETRY_PYTHON'|'LYAPUNOV_DEPTH_ESTIMATION_PYTHON'|'missing'

export function resolveGeometryPaths(config:DepthGeometryConfig={}):DepthGeometryPaths & {pythonSource:GeometryPythonSource}{
  const dedicated=process.env.LYAPUNOV_DEPTH_GEOMETRY_PYTHON
  const shared=process.env.LYAPUNOV_DEPTH_ESTIMATION_PYTHON
  const configured=config.python??config.pythonPath
  const python=configured??dedicated??shared
  const pythonSource:GeometryPythonSource=configured?'config':dedicated?'LYAPUNOV_DEPTH_GEOMETRY_PYTHON':shared?'LYAPUNOV_DEPTH_ESTIMATION_PYTHON':'missing'
  return {python,pythonSource,script:config.script??defaultGeometryScript,data:resolveOutputRoot(config)}
}
async function readable(path:string|undefined){if(!path)return false;try{await stat(path);return true}catch{return false}}

/** 工具执行上下文里取会话工作目录所需的最小形状（原生会话 header.cwd）。 */
export interface GeometryScope{agent?:{session?:{header?:{cwd?:string}}}|undefined}
/**
 * 相对路径的基准：**会话任务 cwd 优先**（原生会话 header cwd，与终端/工作台同一事实），
 * 插件 config.workspace 只作兜底；两者都没有就返回 undefined，让调用方对相对路径明确报错——
 * 不悄悄拿进程 cwd 当基准（那会把相对路径落到产品根）。
 */
export function geometryTaskCwd(exec:GeometryScope|undefined,config:DepthGeometryConfig={}):string|undefined{
  const fromSession=exec?.agent?.session?.header?.cwd?.trim()
  if(fromSession)return fromSession
  const configured=config.workspace?.trim()
  return configured?resolve(configured):undefined
}

/** 只读依赖核查：解释器与脚本是否可读、输出根当前是否存在（不创建目录、不起进程、不跑推理）。 */
export async function depthGeometryStatus(config:DepthGeometryConfig={}){
  const paths=resolveGeometryPaths(config)
  const missing:Array<{dependency:string;path?:string}>=[];if(!paths.python)missing.push({dependency:'python'});else if(!await readable(paths.python))missing.push({dependency:'python',path:paths.python})
  if(!await readable(paths.script))missing.push({dependency:'script',path:paths.script})
  return {provider:'depth-geometry',available:missing.length===0,missing,paths:{python:paths.python,script:paths.script,data:paths.data},pythonSource:paths.pythonSource,
    outputRoot:{path:paths.data,exists:await readable(paths.data)},
    note:'只读核查：解释器里有没有 numpy/Pillow 在真实运行时才会暴露（这里不启进程探测）'}
}

/** 产物引用：只记录运行层**真的核过**的事实（存在、非空、落在本次产物目录内）。 */
export interface DepthGeometryArtifact{type:string;path:string;uri:string;size_bytes:number;metadata?:Record<string,unknown>}
export interface DepthGeometryRun{status:'completed'|'killed'|'failed';output:string;report?:Record<string,unknown>;artifacts?:DepthGeometryArtifact[];outputDirectory?:string}

/**
 * 请求里的路径按**会话 cwd** 解析成绝对路径：geometry.py 只接受绝对路径（相对路径它直接拒绝、
 * 不猜基准），所以没有会话 cwd / config.workspace 时给相对路径会明确报 GEOMETRY_CWD_UNRESOLVED。
 */
export function resolveGeometryRequestPaths(request:Record<string,unknown>,cwd:string|undefined):Record<string,unknown>{
  const images=request.images
  if(!Array.isArray(images))throw new DepthGeometryError('INVALID_REQUEST','images 必须是至少一个图像条目的数组',{})
  const reference=(value:unknown,label:string):{path:string}|undefined=>{
    if(value===undefined||value===null)return undefined
    if(typeof value!=='object')throw new DepthGeometryError('INVALID_REQUEST',`${label} 必须是 {path}`)
    const text=(value as {path?:unknown}).path
    if(typeof text!=='string'||!text)throw new DepthGeometryError('INVALID_REQUEST',`${label} 必须给出 path`)
    if(isAbsolute(text))return {path:text}
    if(!cwd)throw new DepthGeometryError('GEOMETRY_CWD_UNRESOLVED',
      `${label} 是相对路径（${text}），但当前执行上下文没有会话工作目录、本插件也未配置 workspace；请传绝对路径`,{value:text,label})
    return {path:resolve(cwd,text)}
  }
  return {...request,images:images.map((image,index)=>{
    if(!image||typeof image!=='object')throw new DepthGeometryError('INVALID_REQUEST',`images[${index}] 必须是对象`)
    const entry=image as Record<string,unknown>
    const relativeDepth=reference(entry.relativeDepth,`images[${index}].relativeDepth`)
    const metadata=reference(entry.metadata,`images[${index}].metadata`)
    const photo=reference(entry.photo,`images[${index}].photo`)
    return {...entry,relativeDepth,metadata,...photo?{photo}:{photo:undefined}}
  })}
}

const REQUIRED_ARTIFACTS=['geometry.calibration.json','geometry.metadata.json'] as const
const MASK_ARTIFACT=/^depth\.mask\.npy-i(\d+)$/
const METRIC_ARTIFACT=/^depth\.metric\.npy-i(\d+)$/
const PREVIEW_ARTIFACT=/^geometry\.relative\.preview\.(glb|ply)-i(\d+)$/
/** 合同核对失败：统一抛带稳定 code 的结构化错误（函数声明形式才让 TS 的 never 收窄生效）。 */
function fail(code:string,message:string):never{throw new DepthGeometryError(code,message,{})}

/**
 * 产物合同核对（只核对运行层能真正确认的事实，不重算数值、不重解析几何文件）：
 *  · 声明的产物全部存在、非空、落在本次产物目录内（不逃逸）；
 *  · caliberation/metadata 结构齐备且**返回语义自洽**：逐图 metric ↔ units ↔ 产物类型 ↔ 米制 npy 一一对应，
 *    米制 GLB 只含"自己有标定"的图，没有尺度的图只出现在相对预览里；accepted 只在全部图 verdict=verified 时成立；
 *    锚点独立性字段只允许"未参与拟合 + 与 train 不同像元"这一种声明；掩码计数与各图像素之和对得上；
 *    逐图 K/尺寸/相机自洽，产物声明的字节数与磁盘一致。
 * 数值本身（拟合、掩码、反投影、GLB 字节结构）由写它的 Python 负责，完整独立检查在测试里，本层不重复实现。
 * 导出是给测试当同一份判据用（与 operations.ts 导出 collectArtifacts 同理），不是第三个入口。
 */
export async function collectGeometryArtifacts(worker:{artifacts?:Array<{type?:string;path?:string;bytes?:number;note?:string}>;report?:Record<string,any>},outputDirectory:string){
  const declared=new Map<string,{type:string;path:string;note?:string}>()
  for(const item of worker?.artifacts??[]){
    if(!item||typeof item.type!=='string'||typeof item.path!=='string')fail('INVALID_ARTIFACT_DECLARATION','产物声明必须带 type 与 path')
    if(declared.has(item.type))fail('INVALID_ARTIFACT_DECLARATION','产物 type 重复: '+item.type)
    declared.set(item.type,{type:item.type,path:item.path,...item.note?{note:item.note}:{}})
  }
  for(const required of REQUIRED_ARTIFACTS)if(!declared.has(required))fail('GEOMETRY_ARTIFACT_MISSING','缺少必需产物: '+required)
  const base=await realpath(outputDirectory),artifacts:DepthGeometryArtifact[]=[]
  for(const item of declared.values()){
    const file=await realpath(isAbsolute(item.path)?item.path:join(base,item.path)).catch(()=>null)
    if(!file)fail('GEOMETRY_ARTIFACT_MISSING',`${item.type} 声明的文件不存在: ${item.path}`)
    const rel=relative(base,file)
    if(rel.startsWith('..')||isAbsolute(rel))fail('ARTIFACT_OUTSIDE_OUTPUT',`${item.type} 落在本次产物目录之外: ${item.path}`)
    const info=await stat(file)
    if(!info.isFile()||info.size===0)fail('EMPTY_ARTIFACT',`${item.type} 不是非空文件: ${item.path}`)
    artifacts.push({type:item.type,path:file,uri:pathToFileURL(file).href,size_bytes:info.size,...item.note?{metadata:{note:item.note}}:{}})
  }
  const byType=new Map(artifacts.map(item=>[item.type,item]))
  const metadata=JSON.parse(await readFile(byType.get('geometry.metadata.json')!.path,'utf8')) as Record<string,any>
  const calibration=JSON.parse(await readFile(byType.get('geometry.calibration.json')!.path,'utf8')) as Record<string,any>
  for(const [label,value] of [['metadata',metadata],['calibration',calibration]] as const)
    if(value?.schema!==GEOMETRY_SCHEMA)fail('INVALID_GEOMETRY_METADATA',`${label}.schema 不是 ${GEOMETRY_SCHEMA}`)
  const images=metadata?.images
  if(!Array.isArray(images)||!images.length)fail('INVALID_GEOMETRY_METADATA','metadata.images 必须非空')
  const perImage=calibration?.images
  if(calibration?.perImage!==true||!Array.isArray(perImage)||perImage.length!==images.length)
    fail('INVALID_GEOMETRY_METADATA','calibration 必须是逐图报告（perImage=true，images 与 metadata.images 一一对应）')
  const metricIndexes=perImage.flatMap((entry:any,index:number)=>entry?.metric===true?[index]:[])
  const relativeIndexes=perImage.flatMap((entry:any,index:number)=>entry?.metric===false?[index]:[])
  const allVerified=perImage.every((entry:any)=>entry?.verdict==='verified')
  if(metricIndexes.length+relativeIndexes.length!==images.length)fail('INVALID_GEOMETRY_METADATA','每张图必须明确 metric=true/false')
  const units=metadata?.geometry?.units??metadata?.depth?.units
  const expectedUnits=metricIndexes.length===images.length?'meters':metricIndexes.length?'mixed':'relative'
  if(units!==expectedUnits)fail('INVALID_GEOMETRY_METADATA',`geometry.units 应为 ${expectedUnits}（逐图 metric 推出），收到 ${String(units)}`)
  if(metadata?.depth?.units!==units)fail('INVALID_GEOMETRY_METADATA','depth.units 与 geometry.units 不一致')
  if(calibration?.accepted!==allVerified||calibration?.verdict!==calibration?.summary?.verdict)
    fail('INVALID_GEOMETRY_METADATA','accepted/verdict 必须由逐图判定汇总（accepted 只在全部图 verified 时成立）')
  if(calibration.accepted&&perImage.some((entry:any)=>entry?.verdict!=='verified'))fail('INVALID_GEOMETRY_METADATA','有图未 verified 却 accepted=true')
  const summaryMetric=calibration?.summary?.metricImageIndexes
  if(!Array.isArray(summaryMetric)||summaryMetric.join(',')!==metricIndexes.join(','))
    fail('INVALID_GEOMETRY_METADATA','summary.metricImageIndexes 与逐图 metric 不一致')
  let pixels=0
  for(const [index,image] of images.entries()){
    const entry=perImage[index],size=image?.metadata?.sizes,shape=image?.depthNpy?.shape
    if(image?.index!==index)fail('INVALID_GEOMETRY_METADATA',`images[${index}].index 必须是 ${index}`)
    if(entry?.imageIndex!==index)fail('INVALID_GEOMETRY_METADATA',`calibration.images[${index}].imageIndex 必须是 ${index}`)
    if(typeof entry?.verdict!=='string'||typeof entry?.accepted!=='boolean')fail('INVALID_GEOMETRY_METADATA',`calibration.images[${index}] 缺 verdict/accepted`)
    if(entry.accepted!==(entry.verdict==='verified'))fail('INVALID_GEOMETRY_METADATA',`calibration.images[${index}] 的 accepted 只与 verdict=verified 同在`)
    if(entry.metric!==(image?.metric===true))fail('INVALID_GEOMETRY_METADATA',`calibration.images[${index}].metric 与 metadata.images[${index}].metric 不一致`)
    if(entry.metric){
      if(!Number.isFinite(entry.scale)||!Number.isFinite(entry.shift))fail('INVALID_GEOMETRY_METADATA',`calibration.images[${index}] 米制必须有 scale/shift`)
      if(entry.scale<=0)fail('INVALID_GEOMETRY_METADATA',`calibration.images[${index}].scale 必须为正（越大越近的语义）`)
      if(!Array.isArray(entry.train?.items)||!Array.isArray(entry.check?.items))fail('INVALID_GEOMETRY_METADATA',`calibration.images[${index}] 必须逐项报告训练与 check 锚点`)
      if(!Number.isInteger(entry.train?.count)||!Number.isInteger(entry.check?.count)||entry.train.count<2)fail('INVALID_GEOMETRY_METADATA',`calibration.images[${index}] 锚点计数不成立（训练至少 2 个）`)
      if(entry.check.count>0&&entry.check.maxRelativeError>calibration?.toleranceRelativeError&&entry.verdict==='verified')
        fail('INVALID_GEOMETRY_METADATA',`calibration.images[${index}] check 超容差却判 verified`)
      if(entry.verdict==='verified'&&entry.check.count===0)fail('INVALID_GEOMETRY_METADATA',`calibration.images[${index}] 没有 check 锚点却判 verified`)
    }else if(entry.scale!==null||entry.shift!==null)fail('INVALID_GEOMETRY_METADATA',`calibration.images[${index}] 无尺度不得给 scale/shift`)
    // 锚点独立性只允许这一种声明：check 未参与拟合、且与 train 不是同一图同一像元。
    if(entry.checkAnchorsUsedForFit!==false||entry.checkAnchorsDisjointFromTrain!==true)
      fail('INVALID_GEOMETRY_METADATA',`calibration.images[${index}] 的 check 锚点必须是未参与拟合且与 train 不同像元；本工具不声明测量来源统计独立`)
    if(!Number.isInteger(size?.width)||!Number.isInteger(size?.height)||size.width<=0||size.height<=0)fail('INVALID_GEOMETRY_METADATA',`images[${index}] 缺有效尺寸`)
    if(!Array.isArray(shape)||shape[0]!==size.height||shape[1]!==size.width)fail('INVALID_GEOMETRY_METADATA',`images[${index}] 的 depthNpy.shape 与 metadata 尺寸不一致`)
    if(image?.intrinsics?.width!==size.width||image?.intrinsics?.height!==size.height)fail('INVALID_GEOMETRY_METADATA',`images[${index}] 的 K 尺寸与深度尺寸不一致`)
    if(!Array.isArray(image?.worldFromCamera?.positionM)||!Array.isArray(image?.worldFromCamera?.rotationMatrix))fail('INVALID_GEOMETRY_METADATA',`images[${index}] 缺 worldFromCamera`)
    pixels+=size.width*size.height
  }
  const counts=metadata?.mask?.counts??{}
  const countTotal=Object.values(counts).reduce<number>((sum,value)=>sum+Number(value),0)
  if(!Number.isInteger(metadata?.mask?.totalPixels)||metadata.mask.totalPixels<=0||countTotal!==metadata.mask.totalPixels||pixels!==metadata.mask.totalPixels)
    fail('INVALID_GEOMETRY_METADATA','mask.counts 之和 / totalPixels / 各图像素之和必须一致')
  if(metadata?.mask?.codes?.['0']!=='ok')fail('INVALID_GEOMETRY_METADATA','mask.codes 必须给出 0=ok 的口径')
  // 产物类型 ↔ 逐图 metric ↔ units 一一对应：米制世界只收自己有标定的图，无尺度图只出现在相对预览里。
  const combined=metadata?.geometry?.combined??null
  const previews=metadata?.geometry?.relativePreviews
  if(!Array.isArray(previews))fail('INVALID_GEOMETRY_METADATA','geometry.relativePreviews 必须是数组')
  if(metricIndexes.length){
    if(!combined||combined.units!=='meters')fail('INVALID_GEOMETRY_METADATA','有米制图时必须给出米制 combined（units=meters）')
    if(!Array.isArray(combined.images)||combined.images.join(',')!==metricIndexes.join(','))
      fail('INVALID_GEOMETRY_METADATA','米制 GLB 只允许包含自己有标定的图（combined.images 必须等于逐图 metric 下标）')
    if(!declared.has('geometry.meters.glb'))fail('GEOMETRY_ARTIFACT_MISSING','缺少米制几何产物: geometry.meters.glb')
    if(combined.glb?.bytes!==byType.get('geometry.meters.glb')!.size_bytes)fail('INVALID_GEOMETRY_METADATA','combined.glb.bytes 与实际文件大小不一致')
  }else if(combined!==null)fail('INVALID_GEOMETRY_METADATA','没有任何米制标定却给出米制 combined')
  if(previews.map((item:any)=>item?.imageIndex).join(',')!==relativeIndexes.join(','))
    fail('INVALID_GEOMETRY_METADATA','相对预览必须逐张覆盖"没有自己尺度"的图，且不包含米制图')
  for(const preview of previews){
    if(preview?.units!=='relative'||preview?.assumed!==true)fail('INVALID_GEOMETRY_METADATA','相对预览必须标 units=relative 且 assumed=true')
    if(preview?.assumption?.translationApplied!==false)fail('INVALID_GEOMETRY_METADATA','相对预览不得加米制平移（positionM）')
    const type=`geometry.relative.preview.glb-i${preview.imageIndex}`
    if(!declared.has(type))fail('GEOMETRY_ARTIFACT_MISSING','缺少相对预览产物: '+type)
    if(preview.glb?.bytes!==byType.get(type)!.size_bytes)fail('INVALID_GEOMETRY_METADATA',`${type} 的字节数与 metadata 自述不一致`)
  }
  for(const [index] of images.entries()){
    if(!declared.has(`depth.mask.npy-i${index}`))fail('GEOMETRY_ARTIFACT_MISSING',`缺少 images[${index}] 的掩码产物: depth.mask.npy-i${index}`)
  }
  for(const type of declared.keys()){
    const mask=MASK_ARTIFACT.exec(type),metricFile=METRIC_ARTIFACT.exec(type),preview=PREVIEW_ARTIFACT.exec(type)
    if(mask&&Number(mask[1])>=images.length)fail('INVALID_GEOMETRY_METADATA',`${type} 的 imageIndex 越界`)
    if(metricFile){
      const index=Number(metricFile[1])
      if(!perImage[index]?.metric)fail('INVALID_GEOMETRY_METADATA',`未标定的图 ${index} 不得有米制 npy: ${type}`)
    }
    if(preview&&!relativeIndexes.includes(Number(preview[2])))fail('INVALID_GEOMETRY_METADATA',`${type} 只能对应"没有自己尺度"的图`)
    if(type.startsWith('geometry.')&&type.endsWith('.glb')&&type!=='geometry.meters.glb')
      if(!preview)fail('INVALID_GEOMETRY_METADATA','意外的 GLB 产物类型: '+type)
  }
  for(const index of metricIndexes)if(!declared.has(`depth.metric.npy-i${index}`))fail('GEOMETRY_ARTIFACT_MISSING',`缺少 images[${index}] 的米制深度产物: depth.metric.npy-i${index}`)
  const primitives=metadata?.geometry?.primitives
  if(!Array.isArray(primitives))fail('INVALID_GEOMETRY_METADATA','geometry.primitives 必须是数组')
  for(const [index,item] of primitives.entries()){
    if(!Number.isInteger(item?.imageIndex)||item.imageIndex<0||item.imageIndex>=images.length)fail('INVALID_GEOMETRY_METADATA',`primitives[${index}].imageIndex 越界`)
    const expected=perImage[item.imageIndex]?.metric===true?'meters':'relative'
    if(item?.units!==expected)fail('INVALID_GEOMETRY_METADATA',`primitives[${index}].units 与逐图 metric 不一致`)
  }
  return {artifacts,metadata,calibration,geometry:{units,metricImageIndexes:metricIndexes,relativeImageIndexes:relativeIndexes,combined,relativePreviews:previews}}
}

/**
 * 真实运行：spawn python geometry.py（stdin 一个 JSON 请求 → stdout 一条 LYAPUNOV_GEOMETRY_RESULT= 结果行）。
 * 缺解释器/脚本在**任何写操作之前**阻断（PROVIDER_UNAVAILABLE）；退出码/终止信号/取消信号三者共同决定终态，
 * 非零退出或取消绝不交 completed。
 */
export async function runDepthGeometry(subprocess:SubprocessRuntime,config:DepthGeometryConfig,request:Record<string,unknown>,signal:AbortSignal,cwd?:string):Promise<DepthGeometryRun>{
  signal.throwIfAborted()
  const paths=resolveGeometryPaths(config)
  const missing:Array<{dependency:string;path?:string}>=[];if(!paths.python)missing.push({dependency:'python'});else if(!await readable(paths.python))missing.push({dependency:'python',path:paths.python})
  if(!await readable(paths.script))missing.push({dependency:'script',path:paths.script})
  if(missing.length)throw new DepthGeometryError('PROVIDER_UNAVAILABLE','深度几何 '+JSON.stringify(missing),{paths:{python:paths.python,script:paths.script},pythonSource:paths.pythonSource})
  const requestId=String((request as {requestId?:unknown}).requestId??'')
  if(!/^[A-Za-z0-9_-]+$/.test(requestId))throw new DepthGeometryError('INVALID_REQUEST_ID','requestId 只接受 [A-Za-z0-9_-]+',{requestId})
  const payload=resolveGeometryRequestPaths(request,cwd??config.workspace??undefined)
  const runDirectory=join(paths.data,requestId+'-'+randomUUID()),artifactsDirectory=join(runDirectory,'artifacts')
  await mkdir(artifactsDirectory,{recursive:true})
  signal.throwIfAborted()
  const child=subprocess.spawn({argv:[paths.python!,paths.script],cwd:runDirectory,
    stdio:{stdin:{data:JSON.stringify({...payload,outputDirectory:artifactsDirectory})},stdout:{maxBytes:16_000_000},stderr:{maxBytes:200_000}},
    graceMs:5000,signal,
    env:{HF_ENDPOINT:'https://hf-mirror.com',HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_XET:'1',PYTHONUNBUFFERED:'1',PYTHONDONTWRITEBYTECODE:'1'}})
  const outcome=await child.done
  const stdout=child.collected.stdout?.readFrom(0).text??''
  const stderr=child.collected.stderr?.readFrom(0).text??''
  // stderr（含未预期失败的 Python 回溯）落盘留诊断，但不把原文灌进结果/错误文本。
  if(stderr.trim())await writeFile(join(runDirectory,'geometry-stderr.log'),stderr,{mode:0o600})
  const prefixed=stdout.trim().split('\n').reverse().find(line=>line.startsWith(GEOMETRY_RESULT_PREFIX))
  const cancelled=signal.aborted||outcome.signal!==null
  const fail=(code:string,message:string,extra:Record<string,unknown>={}):DepthGeometryRun=>({
    status:cancelled?'killed':'failed',
    output:JSON.stringify({error:{code,message,exitCode:outcome.exitCode,signal:outcome.signal,stderrLog:stderr.trim()?join(runDirectory,'geometry-stderr.log'):null,...extra}})})
  // 取消优先：被终止的进程本来就不会有结果行，"没有结果行"是取消的后果而不是根因。
  if(!prefixed)return cancelled
    ?fail('CANCELLED','运行在给出结果行之前被终止；产物不交付')
    :fail('GEOMETRY_RESULT_MISSING','geometry.py 没有输出结果行（异常细节见 stderrLog）')
  let parsed:Record<string,any>
  try{parsed=JSON.parse(prefixed.slice(GEOMETRY_RESULT_PREFIX.length)) as Record<string,any>}
  catch{return fail('INVALID_GEOMETRY_RESULT','geometry.py 的结果行不是合法 JSON')}
  if(parsed?.error)return fail(String(parsed.error.code??'GEOMETRY_FAILED'),String(parsed.error.message??'geometry.py 报错'),{detail:parsed.error.detail??null})
  if(outcome.exitCode!==0)return fail('GEOMETRY_EXIT_NONZERO','geometry.py 退出码非零却给了成功形状的结果')
  if(cancelled)return fail('CANCELLED','运行被取消；产物不交付')
  const checked=await collectGeometryArtifacts(parsed as never,artifactsDirectory)
  if(signal.aborted)return fail('CANCELLED','产物核对期间被取消；产物不交付')
  const report={...checked.metadata,
    runtime:{...(checked.metadata.runtime??{}),python:paths.python,script:paths.script,pythonSource:paths.pythonSource},
    artifacts:checked.artifacts.map(item=>({type:item.type,path:item.path,bytes:item.size_bytes,...item.metadata?{note:(item.metadata as {note?:string}).note}:{}})),
    geometrySummary:checked.geometry,outputDirectory:runDirectory,
    stderrLog:stderr.trim()?join(runDirectory,'geometry-stderr.log'):null,
    artifactContract:'本层核对：文件存在/非空/不逃逸；逐图 metric ↔ units ↔ 产物类型 ↔ 米制 npy 一一对应；米制 GLB 只含有标定的图；accepted 只在全部图 verified；mask 计数与各图像素一致'}
  return {status:'completed',output:JSON.stringify({requestId,output:report}),report,artifacts:checked.artifacts,outputDirectory:runDirectory}
}

/** 人类/模型可读摘要：结论在前，缺口与限制写清楚；细节都在 report 里。 */
function fmt(value:unknown){return typeof value==='number'&&Number.isFinite(value)?value.toPrecision(4):String(value??'?')}
export function summarizeGeometryReport(report:Record<string,any>):string{
  const calibration=report.calibration??{},geometry=report.geometry??{},mask=report.mask??{},depth=report.depth??{}
  const perImage:any[]=Array.isArray(calibration.images)?calibration.images:[]
  const units=String(geometry.units??depth.units??'?'),lines:string[]=[]
  const verdictText:Record<string,string>={
    'train-inconsistent':'⚠ 训练锚点自身不自洽（拟合后仍有超容差残差）：锚点互相矛盾，不接受为标定通过',
    'insufficient-anchors':'⚠ 该图没有自己的尺度：只出相对预览（1/relative 的显示用假定 + 只旋转不平移），不是米',
    'check-failed':'⚠ 独立 check 锚点未通过：本次米制结果不得当标定通过（accepted=false）',
    'unverified':'⚠ 没有独立 check 锚点：米制换算未被独立核对（accepted=false）',
  }
  for(const entry of perImage)if(verdictText[entry?.verdict])lines.push(`图${entry.imageIndex}：${verdictText[entry.verdict]}`)
  const unitsText=units==='meters'?'全部图轴向米制（沿相机轴的深度；不是射线/欧氏距离）'
    :units==='relative'?'全部图相对单位（未标定：1/relative 显示用假定，不得按米导入）'
    :'米制与相对预览并存：米制 GLB 只含自己有标定的图，无尺度图各自一份相对预览，两者不混在一个文件/一个世界'
  lines.push(`${unitsText}｜逐图判定 ${perImage.map(entry=>`图${entry.imageIndex}=${entry.verdict}`).join('、')||'?'}｜accepted=${String(calibration.accepted)}`)
  for(const entry of perImage){
    if(entry?.metric===true)lines.push(`图${entry.imageIndex} 标定（${String(calibration.model??calibration.mapping??'inverse')}）：scale=${fmt(entry.scale)} shift=${fmt(entry.shift)}（${String(entry.scaleUnit)}）｜有效深度范围 ${fmt(entry.validDepthRangeM?.min)}..${fmt(entry.validDepthRangeM?.max)} m｜`
      +`训练锚点 ${entry.train?.count}（最大相对误差 ${fmt(entry.train?.maxRelativeError)}，RMSE ${fmt(entry.train?.rmseM)} m）｜check 锚点 ${entry.check?.count}（最大相对误差 ${fmt(entry.check?.maxRelativeError)}，容差 ${fmt(calibration.toleranceRelativeError)}）`)
    else lines.push(`图${entry.imageIndex} 无标定：${String(entry?.reason??'没有该图自己的训练锚点')}`)
  }
  const counts=mask.counts??{}
  lines.push(`掩码：有效像元 ${counts.ok??0}/${mask.totalPixels??0}（无效占比 ${fmt(mask.invalidFraction)}；口径见 metadata.mask.codes）`)
  const primitives=(geometry.primitives??[]).map((item:any)=>`图${item.imageIndex}:${item.vertices}点/${item.triangles}面(${item.units})`).join('，')
  lines.push(`几何：${primitives||'（无）'}｜采样步长 ${String(geometry.recipe?.sampleStep??'?')}｜跳变规则 米制 ${String(geometry.recipe?.jumpRuleMeters??'?')}`)
  lines.push('限制：只覆盖观测到的采样像元，不补看不到的背面；原照片 RGB 只作顶点颜色；这不是完整几何重建；GLB 按 glTF 标准 Y-up 写出。')
  for(const warning of report.warnings??[])lines.push('警告：'+String(warning))
  for(const gap of report.gaps??[])lines.push('缺口：'+String(gap))
  const files=(report.artifacts??[]).map((item:any)=>`${item.type}=${item.path}（${item.bytes??item.size_bytes} B）`)
  if(files.length)lines.push('产物：'+files.join('、'))
  return lines.join('\n')
}

/**
 * 薄注册：把 `depth_geometry` 交给原生 tools 注册表，并在有 `commands` 服务时挂同一 operation 的同步命令。
 * 调用方在 `apply` 里调用并自行声明 inject 含 `tools` 与 `subprocess`——本函数不新建插件、不持有状态、不注册后台作业。
 * @returns 注销函数（插件卸载时调用）。
 */
export function registerDepthGeometryTools(ctx:Context,config:DepthGeometryConfig={}){
  const subprocess=ctx.get('subprocess') as SubprocessRuntime|undefined
  const operate=async(args:{request_json:string},signal:AbortSignal,agent:GeometryScope|undefined)=>{
    if(!subprocess)throw new DepthGeometryError('GEOMETRY_SUBPROCESS_UNAVAILABLE','缺少 subprocess 服务：调用方插件 inject 需要包含 subprocess',{})
    let request:Record<string,unknown>
    try{request=JSON.parse(args.request_json) as Record<string,unknown>}
    catch{throw new DepthGeometryError('INVALID_REQUEST_JSON','request_json 不是合法 JSON',{})}
    const run=await runDepthGeometry(subprocess,config,request,signal,geometryTaskCwd(agent,config))
    if(run.status!=='completed'){
      // operation 的失败形状原样转成带稳定 code 的错误；不把整段结果文本塞进错误消息。
      let envelope:{error?:{code?:string;message?:string;detail?:unknown}}={}
      try{envelope=JSON.parse(run.output) as typeof envelope}catch{/* 保持空信封：下方给通用码 */}
      throw new DepthGeometryError(envelope.error?.code??'GEOMETRY_FAILED',envelope.error?.message??'深度几何运行未完成',
        {status:run.status,...envelope.error?.detail?{detail:envelope.error.detail}:{}})
    }
    return {report:run.report as unknown as JsonValue,result:summarizeGeometryReport(run.report!)}
  }
  const disposers=[ctx.tools.register(defineTool({
    name:'depth_geometry',
    description:'Calibrate **actual relative-depth outputs** from depth_estimate (depth.image.npy and metadata) to metric depth and coarse geometry. Supply K and worldFromCamera using the existing camera contract: camera x right/y up/looking along -z; world = R*p_cam + t; K uses a top-left pixel origin with x right/y down. '
      +'Also supply pixels with **known axial-depth anchors**: depthM is metric depth along the camera axis, not ray distance. '
      +'**Calibrate each image independently** using only that image\'s train anchors to fit scale/shift through inverse depth 1/d = scale*relative + shift. Report train and independent check residuals separately for each image. '
      +'An image without its own scale produces only a relative preview: 1/relative is a display assumption, rotation only without translation, marked assumed. **Do not borrow anchors from another image or present min/max normalization as metres**, and do not combine relative and metric images in one file. '
      +'Inconsistent train anchors (train-inconsistent) or independent checks beyond tolerance (check-failed) yield accepted=false and must not be accepted as calibrated. '
      +'Outputs: per-pixel mask npy; per-image metric axial-depth npy only for successful calibration; metric coarse-mesh GLB containing only images with their own calibration; separate relative-preview GLBs for unscaled images; optional PLY; and per-image calibration/source metadata. '
      +'Use only observed sampled pixels. Triangles do not cross occlusion jumps; do not invent unseen backsides. Original photo RGB supplies vertex colour only. Export GLB in standard glTF Y-up for scene_import. '
      +'Combining images requires the same registration.frameId on every entry. This tool neither registers images nor verifies that declaration; matching frameId does not establish matching depth scales.',
    parameters:{
      request_json:{type:'string',required:true,description:'JSON: requestId; images[]: {relativeDepth:{path} (relative-depth npy from depth_estimate), metadata:{path} (metadata from that same depth_estimate run), photo:{path}? (original photo for vertex colours), '
        +'intrinsics:{fx,fy,cx,cy,width,height,distortion?} (nonzero distortion is rejected; undistort first), worldFromCamera:{positionM:[3],rotationMatrix:[[3],[3],[3]]} (orthogonal, det=+1), registration:{frameId}? (required and identical for multiple images)}; '
        +'anchors:{train:[{pixel:[u,v],depthM,imageIndex?,note?}...],check:[...]} (at least 2 train anchors, with imageIndex, default 0; **each image uses only its own anchors**; check pixels must differ from train pixels, and residuals are reported separately); '
        +'params:{mapping?="inverse",minDepthM?,maxDepthM?,jumpRatio?,jumpThresholdM?,sampleStep?,vertexColor?="photo"|"none",checkToleranceRatio?,writePly?}; optional source? labels for scene/frame provenance. Relative paths resolve against the current session task workspace.'},
    },
    output:{
      schema:{type:'object',additionalProperties:false,properties:{result:{type:'string',required:true},report:{type:'json',required:true}}},
      render:(_args,value):ContentBlock[]=>[{type:'text',text:value.result}],
    },
    execute:(args,exec)=>operate(args,exec.signal,exec as GeometryScope),
  }))]
  if(ctx.get('commands')){
    disposers.push(ctx.commands.register({
      name:'depth_geometry',
      description:'Execute the same depth-geometry operation synchronously without an LLM. Return a text summary; complete structured readings remain in the Tool report.',
      input:{hint:'JSON for the request_json parameter.'},
      async handler(invocation){
        try{return {kind:'success',text:(await operate(JSON.parse(invocation.rawInput||'{}'),invocation.signal,invocation as GeometryScope)).result}}
        catch(error){return {kind:'error',text:error instanceof Error?error.message:String(error)}}
      },
    }))
    disposers.push(ctx.commands.register({
      name:'depth_geometry_status',
      description:'Read-only inspection of depth-geometry interpreter/script and output root, without creating directories, starting processes, or runtime side effects.',
      input:{hint:'No parameters.'},
      async handler(){
        try{return {kind:'success',text:JSON.stringify(await depthGeometryStatus(config),null,2)}}
        catch(error){return {kind:'error',text:error instanceof Error?error.message:String(error)}}
      },
    }))
  }
  return ()=>{for(const dispose of disposers)dispose()}
}
