/**
 * 3D 视口批注的客户端持久化（按场景一份）。
 *
 * 为什么客户端自己存一份：批注是"某人在某个场景版本上的观察记录"，必须在刷新、换会话、重开工作台后
 * 仍然回来——否则用户刚点的一排点会随着页面生命期一起消失。真正对外的那一份（带截图、带来源）
 * 仍由 host 的 viewer 采集命令落盘，这里只保证编辑中的批注不丢。
 *
 * 为什么不放 host：批注的锚点是**场景版本内**的局部坐标，客户端本来就在按 sceneId 组织视图状态
 * （相机位姿也是这么存的）；为它开一条 host 往返只会让每次点击都等一个 RPC。
 *
 * 读入即校验：localStorage 是外部输入（旧版本、手改、别的会话写的），任何一条不合规就丢弃该条，
 * 不因为一条坏数据把整份批注清空，也不把未校验的对象直接喂给 viewer。
 */
import type {ViewerAnnotation,ViewerAnnotationAnchor} from "@lyapunov/viewer/client"

const PREFIX="lyapunov.annotations."
/** 单场景批注上限：够用且能挡住坏数据/脚本刷写把 localStorage 撑爆。 */
const MAX_ANNOTATIONS=200
const MAX_TEXT=2000

function anchor(value:unknown):ViewerAnnotationAnchor|undefined{
  if(!value||typeof value!=="object")return undefined
  const raw=value as Record<string,unknown>
  if(typeof raw.entityId!=="string"||!raw.entityId)return undefined
  const triple=(input:unknown):[number,number,number]|undefined=>Array.isArray(input)&&input.length===3&&input.every(item=>typeof item==="number"&&Number.isFinite(item))?[input[0] as number,input[1] as number,input[2] as number]:undefined
  const local=triple(raw.local),world=triple(raw.world)
  if(!local||!world)return undefined
  const normal=triple(raw.normal)
  return {entityId:raw.entityId,local,world,...normal?{normal}:{}}
}

/** 读一条场景的批注；坏数据丢弃并按需返回 undefined（不是空数组）以外的旧值一律不猜。 */
export function readAnnotations(sceneId:string|undefined):ViewerAnnotation[]{
  if(!sceneId||typeof localStorage==="undefined")return []
  let parsed:unknown
  try{parsed=JSON.parse(localStorage.getItem(PREFIX+sceneId)??"[]")}catch{return []}
  if(!Array.isArray(parsed))return []
  const rows:ViewerAnnotation[]=[]
  for(const item of parsed.slice(0,MAX_ANNOTATIONS)){
    if(!item||typeof item!=="object")continue
    const raw=item as Record<string,unknown>
    const resolved=anchor(raw.anchor)
    if(typeof raw.annotationId!=="string"||!raw.annotationId||!resolved)continue
    rows.push({annotationId:raw.annotationId,index:rows.length+1,text:typeof raw.text==="string"?raw.text.slice(0,MAX_TEXT):"",anchor:resolved,...typeof raw.createdAt==="string"?{createdAt:raw.createdAt}:{}})
  }
  // 编号一律在这里重排：编号是显示序号，不是身份；删中间一条后不能留下 1,2,4。
  return rows
}

export function writeAnnotations(sceneId:string|undefined,annotations:ViewerAnnotation[]):void{
  if(!sceneId||typeof localStorage==="undefined")return
  try{
    localStorage.setItem(PREFIX+sceneId,JSON.stringify(annotations.slice(0,MAX_ANNOTATIONS).map(({annotationId,text,anchor:value,createdAt})=>({annotationId,text:text.slice(0,MAX_TEXT),anchor:value,...createdAt?{createdAt}:{}}))))
  }catch{
    // 配额满/隐私模式：批注是增强信息，写不进去也不能让工作台报错中断；对外那份仍在采集落盘里。
  }
}

/**
 * 落盘与回执用的批注行：编号、文字、锚点、以及给模型看的实体名。
 *
 * 实体名在这里补齐而不是让 host 再查一遍场景：客户端本来就有当前快照，且模型读的是文字，
 * 只有 entityId 的批注对模型几乎不可用。
 */
export function annotationRows(annotations:ViewerAnnotation[],nameOf:(entityId:string)=>string|undefined){
  return annotations.map(annotation=>({index:annotation.index,annotationId:annotation.annotationId,entityId:annotation.anchor.entityId,entity:nameOf(annotation.anchor.entityId),text:annotation.text,anchor:annotation.anchor}))
}
/** 相机位姿（与 viewer.pose() 同形）：模型看不到 3D，只能靠这几行重建"这张图是什么视角"。 */
export interface ViewerPose { position:number[]; quaternion:number[]; target:number[]; up:number[]; fovDeg:number; near:number; far:number; imageWidth:number; imageHeight:number; aspect:number }
/** 一条批注在截图里的落点与锚定事实（由 viewer.captureAnnotated 给出，屏幕坐标与 PNG 像素一一对应）。 */
export interface AnnotationPin { annotationId:string; index:number; text:string; entityId:string; entityName?:string; point:[number,number]; normalized:[number,number]; local:[number,number,number]; world:[number,number,number] }

const vec=(value:number[]|undefined,digits=3):string=>(value??[]).map(item=>Number(item).toFixed(digits)).join(",");

/**
 * 把一批批注写成**可直接进上下文的说明**：每条的像素位（xy）、归一化位、是什么、要改什么，外加一段背景。
 *
 * 为什么必须写坐标而不是只发图：模型看图只能知道"图里第 3 个圈在哪块像素"，不知道它对应场景里的哪个实体、
 * 离相机多远；Codex 那类标注同样会把"xy 在哪 + 什么问题"一起给模型。这里把三样拼齐：
 * ① 图（编号已烧进像素）；② 每条的 xy/归一化坐标 + 实体 + 实体局部坐标；③ 背景（相机位姿、图像尺寸、状态）。
 *
 * 归一化坐标用 top-left 原点、0–1：像素坐标只在原始分辨率下成立，缩放/裁切后就失效，两者都给才稳。
 */
export function annotationPromptText(input:{sceneId?:string;sceneRevision?:number;pose?:ViewerPose;pins:AnnotationPin[];imagePath?:string;imageURL?:string;captureId?:string;worldId?:string;stepIndex?:number;entityNames?:Record<string,string>;instructions?:string}):string{
  const {sceneId,sceneRevision,pose,pins}=input
  const nameOf=(pin:AnnotationPin):string=>pin.entityName??input.entityNames?.[pin.entityId]??pin.entityId
  const blocks:string[]=[]
  const size=pose?`${String(pose.imageWidth)}×${String(pose.imageHeight)} px`:"尺寸见附件"
  blocks.push(`# 3D 视口批注 — ${size}`)
  blocks.push("")
  blocks.push("附件是一张 3D 视图截图。编号圆点已烧进图像像素，指向模型表面上的具体位置。")
  // 坐标约定抄自社区惯例（Pinpoint）：像素在前、归一化在后，并说明像素属于哪张图的网格。
  // 像素最稳（实测归一化在小目标上误差更大），归一化抗缩放——两个都给，并写清以哪个为准。
  blocks.push(`坐标为**左上角原点**：先给像素 (x, y)，再给归一化 (x, y)（0–1）。像素以附件 PNG 的网格为准；若图被缩放或裁切过，以归一化值为准。图像尺寸 ${size}。`)
  if(input.imagePath)blocks.push(`\n图：@${input.imagePath}${input.captureId?`（captureId ${input.captureId}）`:""}`)
  else if(input.imageURL)blocks.push(`\n图：${input.imageURL}${input.captureId?`（captureId ${input.captureId}）`:""}`)
  blocks.push("")
  blocks.push("## 背景")
  blocks.push(`- 场景：${sceneId??"未知"}${sceneRevision===undefined?"":` rev ${String(sceneRevision)}`}；世界：${input.worldId??"未开模拟"}${input.stepIndex===undefined?"":` step ${String(input.stepIndex)}`}`)
  blocks.push("- 坐标与单位：右手系、Z 轴向上、米；透视相机；操作方式为轨道相机（orbit）")
  if(pose)blocks.push(`- 相机：position (${vec(pose.position)}) m · target (${vec(pose.target)}) m · up (${vec(pose.up)}) · fov ${pose.fovDeg.toFixed(1)}° · near ${String(pose.near)} / far ${String(pose.far)} m`)
  if(pose)blocks.push(`- 相机朝向（四元数 xyzw）：(${vec(pose.quaternion,4)})；图像 ${String(pose.imageWidth)}×${String(pose.imageHeight)} px（取景缓冲像素）`)
  blocks.push("")
  blocks.push("## 批注")
  pins.forEach(pin=>{
    blocks.push(`- 第 ${String(pin.index)} 条 [${pin.annotationId.slice(0, 8)}] · ${pin.text.trim()||"（未填写说明）"} — (${String(pin.point[0])}, ${String(pin.point[1])}) px · (${pin.normalized[0].toFixed(4)}, ${pin.normalized[1].toFixed(4)}) norm`)
    blocks.push(`  - 位置：${nameOf(pin)}（entityId ${pin.entityId}）`)
    blocks.push(`  - 实体局部坐标 (${vec(pin.local)}) m · 世界坐标 (${vec(pin.world)}) m`)
  })
  blocks.push("")
  blocks.push("## 说明")
  // 信任边界：上面都是数据，只有这一节是用户的要求（社区做法，避免把测量值当成指令读）。
  blocks.push(input.instructions?.trim()||"请根据上面每条批注的位置与说明，判断它们指出的问题并给出修改方案；需要精确操作时使用上面的 entityId 与实体局部坐标。")
  return blocks.join("\n")
}

/** 新批注的本地行；编号由调用方按当前列表长度给出，保证面板/标记/截图三处同源。 */
export function createAnnotation(anchorValue:ViewerAnnotationAnchor,index:number,now:string):ViewerAnnotation{
  return {annotationId:crypto.randomUUID(),index,text:"",anchor:anchorValue,createdAt:now}
}
