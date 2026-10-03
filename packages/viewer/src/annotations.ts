/**
 * 3D 视口批注的**世界锚定**标记层。
 *
 * 为什么单独一个模块：批注的价值全在"换视角不走位"，而这件事只由一条判据决定——
 * 标记不是贴在屏幕上，而是挂在**实体 group 的局部坐标**上，每帧用实体当前世界矩阵重算世界点。
 * 相机绕行、平移、缩放都不改实体矩阵，所以标记原地不动；实体被移动/被运行帧带走时，标记跟着走。
 * 这条判据只在这里实现一次，viewer 只负责喂锚点、喂相机、喂可见性。
 *
 * 与既有"放置素材"标记（SceneViewer.showPlaceMarker）的区别：那个是一次性、固定世界点、用完即弃；
 * 批注是常驻、带编号与文字、可选中编辑，并且锚在实体上。
 *
 * 没有采用社区现成件（That Open Marker / ViewLeader / vikcraft-3d-annotator / Potree Annotation）：
 * 它们要么自带引擎与 WASM（That Open 需要 OBC.World + web-ifc），要么要求接管 renderer 与主循环
 * （vikcraft/ThreePresenter），要么还是 0.0.1-beta（ViewLeader），而本例需要的核心（world→local 重算、
 * 编号标签、可拾取）用 three 自带能力约百行即可，且能直接复用本包既有的拾取与可见性判据。
 */
import * as THREE from "three"
import type { Frame } from '../../lyapunov-contracts/src/types.ts'
import { rigidPoseOf } from './camera-frustum.ts'

/**
 * 一条批注的真实锚点。
 *
 * `local` 是相对所属实体 group 的局部坐标（`worldToLocal` 的结果），`world` 只是下单时刻的世界坐标，
 * 供回执/落盘做人类可读的核对；渲染与"是否走位"一律以 `local` 重算的结果为准，
 * 绝不拿 `world` 当渲染输入——那正是换视角/移动实体后走位的根因。
 */
export interface ViewerAnnotationAnchor {
  entityId: string
  /** 相对实体 group 的局部坐标（米）。 */
  local: [number, number, number]
  /** 下单时刻的世界坐标（米），仅作核对与跨工具对齐，不参与渲染。 */
  world: [number, number, number]
  /** 命中面的世界法线（可选）；用于把标记抬离表面，避免与自身网格 z-fighting。 */
  normal?: [number, number, number]
  sceneId?: string
  sceneRevision?: number
  /** 真实命中节点与同帧 native body FK 求出的局部锚点；不能由 mesh 名猜连杆。 */
  body?: {
    bodyName: string; localM: [number,number,number]; surfaceLocalM?: [number,number,number]; normalLocal?: [number,number,number]
    worldId: string; generation: number; frameId: string; stepIndex: number
  }
}
export interface ViewerAnnotation {
  annotationId: string
  /** 1 起的显示编号；面板、标记与截图里的序号必须同源，避免三处各算一套。 */
  index: number
  text: string
  anchor: ViewerAnnotationAnchor
  createdAt?: string
}
/** 载体：能在世界点落标记的 three 对象（实体 group）。 */
export interface AnnotationCarrier { group: THREE.Object3D; robot?: {bodyNode(bodyName:string):THREE.Object3D|undefined} }

/** 现有批注 wire/storage 的共同窄面校验，旧锚点仍可读取，坏 body provenance 不降级为 root。 */
export function annotationAnchorOf(value:unknown):ViewerAnnotationAnchor|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined
  const row=value as Record<string,any>
  const vec=(v:unknown):v is [number,number,number]=>Array.isArray(v)&&v.length===3&&v.every(n=>typeof n==='number'&&Number.isFinite(n))
  if(typeof row.entityId!=='string'||!row.entityId||!vec(row.local)||!vec(row.world)||row.normal!==undefined&&!vec(row.normal))return undefined
  if(row.sceneId!==undefined&&(typeof row.sceneId!=='string'||!row.sceneId)||row.sceneRevision!==undefined&&(!Number.isInteger(row.sceneRevision)||row.sceneRevision<0))return undefined
  if(row.body!==undefined){const b=row.body;if(!b||typeof b.bodyName!=='string'||!b.bodyName||!vec(b.localM)||b.surfaceLocalM!==undefined&&!vec(b.surfaceLocalM)||b.normalLocal!==undefined&&!vec(b.normalLocal)||typeof b.worldId!=='string'||!b.worldId||!Number.isInteger(b.generation)||b.generation<1||typeof b.frameId!=='string'||!b.frameId||!Number.isInteger(b.stepIndex)||b.stepIndex<0||!row.sceneId||!Number.isInteger(row.sceneRevision))return undefined}
  return {entityId:row.entityId,local:[...row.local],world:[...row.world],...row.normal?{normal:[...row.normal] as [number,number,number]}:{},...row.sceneId?{sceneId:row.sceneId}:{},...row.sceneRevision!==undefined?{sceneRevision:row.sceneRevision}:{},...row.body?{body:{bodyName:row.body.bodyName,localM:[...row.body.localM] as [number,number,number],...row.body.surfaceLocalM?{surfaceLocalM:[...row.body.surfaceLocalM] as [number,number,number]}:{},...row.body.normalLocal?{normalLocal:[...row.body.normalLocal] as [number,number,number]}:{},worldId:row.body.worldId,generation:row.body.generation,frameId:row.body.frameId,stepIndex:row.body.stepIndex}}:{}}
}

/** 在真实表面命中时取同帧 FK；选择最深的真实 body 祖先，不根据名字或整机器人根推测。 */
export function annotationAnchorAtHit(entityId:string,carrier:AnnotationCarrier,hitObject:THREE.Object3D,point:THREE.Vector3,normal:THREE.Vector3|undefined,scene:{sceneId:string;revision:number},frame?:Frame):ViewerAnnotationAnchor {
  const local=liftAnchor(carrier,point,normal),world=carrier.group.localToWorld(new THREE.Vector3(...local))
  const anchor:ViewerAnnotationAnchor={entityId,local,world:world.toArray(),...normal?{normal:normal.toArray()}: {},sceneId:scene.sceneId,sceneRevision:scene.revision}
  const poses=frame?.entities.find(e=>e.entityId===entityId)?.sensors?.bodyWorldPoses
  if(!frame||frame.sceneRevision!==scene.revision||!poses||!carrier.robot)return anchor
  const nodes=new Map<THREE.Object3D,Array<{name:string;pose:NonNullable<ReturnType<typeof rigidPoseOf>>}>>()
  for(const [name,value] of Object.entries(poses)){const pose=rigidPoseOf(value),node=carrier.robot.bodyNode(name);if(pose&&node)nodes.set(node,[...(nodes.get(node)??[]),{name,pose}])}
  for(let node:THREE.Object3D|null=hitObject;node;node=node.parent){
    const matches=nodes.get(node)
    if(!matches)continue
    if(matches.length!==1)return anchor
    const {name,pose}=matches[0]!,q=new THREE.Quaternion(...pose.quaternionXyzw).invert()
    anchor.body={bodyName:name,localM:world.clone().sub(new THREE.Vector3(...pose.positionM)).applyQuaternion(q).toArray(),surfaceLocalM:point.clone().sub(new THREE.Vector3(...pose.positionM)).applyQuaternion(q).toArray(),...normal?{normalLocal:normal.clone().applyQuaternion(q).normalize().toArray()}: {},worldId:frame.worldId,generation:frame.generation,frameId:frame.frameId,stepIndex:frame.stepIndex}
    return anchor
  }
  return anchor
}

/** 截图行与像素 pin 同时采当前锚点；不能把落点时的 world 字段拼到关节运动后的图上。 */
export function annotationAtCapture(annotation:ViewerAnnotation,carrier:AnnotationCarrier,world:THREE.Vector3,scene:{sceneId:string;revision:number},frame?:Frame):ViewerAnnotation {
  const anchor=structuredClone(annotation.anchor)
  anchor.world=world.toArray();anchor.local=carrier.group.worldToLocal(world.clone()).toArray()
  if(anchor.body){
    const body=anchor.body,poses=frame?.entities.find(e=>e.entityId===anchor.entityId)?.sensors?.bodyWorldPoses as Record<string,unknown>|undefined,pose=rigidPoseOf(poses?.[body.bodyName])
    if(!frame||!pose||frame.sceneRevision!==scene.revision||anchor.sceneId!==scene.sceneId||anchor.sceneRevision!==scene.revision||frame.worldId!==body.worldId||frame.generation!==body.generation)throw Error('CAMERA_ANNOTATION_FRAME_REQUIRED: a robot annotation capture needs the current same-generation native body frame')
    if(body.normalLocal)anchor.normal=new THREE.Vector3(...body.normalLocal).applyQuaternion(new THREE.Quaternion(...pose.quaternionXyzw)).normalize().toArray()
    anchor.body={...body,frameId:frame.frameId,stepIndex:frame.stepIndex}
  }
  return {...annotation,anchor}
}

/** 批注标记在场景里的父节点；单独一层，不与实体 group 混，实体重建时不连带删除。 */
export const ANNOTATION_ROOT_NAME = "lyapunov-annotations"
/**
 * 标记尺寸按**屏幕像素**定，不按米。
 *
 * 为什么：按米定的标记在近距离占满半个屏幕、远距离缩成一个点，字号更是不可读（实测反馈："字体不是自适应
 * 屏幕的，太小了"）。这里每帧按相机距离反算世界尺寸，让徽标在各种距离下都保持同一屏幕大小。
 */
const BADGE_SCREEN_PX = 30
const BADGE_CANVAS_PX = 96
const BADGE_MAX_DPR = 2
/** 抬离表面的距离按米：贴面偏移是几何量（防 z-fighting），不该随屏幕大小变。 */
const SURFACE_LIFT_M = 0.012
const PICK_RADIUS_M = 0.045

interface MarkerEntry {
  marker: THREE.Group
  /** 屏幕尺寸恒定的编号徽标（一个圆点 + 编号，压住锚点）。 */
  badge: THREE.Sprite
  /** 圆点本体：sprite 底部的小实心点，让"落点"与"编号"在视觉上分开。 */
  badgeTexture: THREE.CanvasTexture
  badgeCanvas: HTMLCanvasElement
  badgeKey?: string
  pick: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
}

/** 实体 group → 世界点：marker 挂在**实体 group 下**，位置由局部坐标直接给出，父链变换自动生效。 */
export function resolveAnnotationWorld(annotation: ViewerAnnotation, carriers: ReadonlyMap<string, AnnotationCarrier>): THREE.Vector3 | undefined {
  const carrier = carriers.get(annotation.anchor.entityId)
  if (!carrier) return undefined
  if(annotation.anchor.body){const node=carrier.robot?.bodyNode(annotation.anchor.body.bodyName);if(!node)return undefined;node.updateWorldMatrix(true,false);return node.localToWorld(new THREE.Vector3(...annotation.anchor.body.localM))}
  return carrier.group.localToWorld(new THREE.Vector3(...annotation.anchor.local))
}

/** 与 resolveAnnotationWorld 互逆：世界命中点 → 该实体的局部锚点。 */
export function toLocalAnchor(carrier: AnnotationCarrier, worldPoint: THREE.Vector3): [number, number, number] {
  return carrier.group.worldToLocal(worldPoint.clone()).toArray()
}

/** 把锚点在世界系里沿法线抬离表面（法线缺失时用世界 Z），再换回局部坐标。 */
export function liftAnchor(carrier: AnnotationCarrier, worldPoint: THREE.Vector3, worldNormal: THREE.Vector3 | undefined): [number, number, number] {
  const offset = (worldNormal && worldNormal.lengthSq() > 0 ? worldNormal.clone().normalize() : new THREE.Vector3(0, 0, 1)).multiplyScalar(SURFACE_LIFT_M)
  return toLocalAnchor(carrier, worldPoint.clone().add(offset))
}

/**
 * 画"编号圆点"徽标（复刻 Codex 那类图上标注的样子：一个实心点 + 编号，不要外圈和文字块）。
 *
 * 文字不上标记：3D 视图里挂标签会互相压叠、越远越小；文字留在右侧面板（可编辑、可复制），
 * 标记只负责"这是第几个点"，这样画面干净且始终可读。
 * dpr 上限 2：再高只增加贴图内存，屏幕上已经看不出差别。
 */
function drawBadge(canvas: HTMLCanvasElement, index: number, selected: boolean, devicePixelRatio: number): void {
  const dpr = Math.max(1, Math.min(devicePixelRatio || 1, BADGE_MAX_DPR))
  canvas.width = BADGE_CANVAS_PX * dpr
  canvas.height = BADGE_CANVAS_PX * dpr
  const context = canvas.getContext("2d")
  if (!context) return
  const size = BADGE_CANVAS_PX * 1
  const center = size / 2
  context.clearRect(0, 0, size, size)
  context.save()
  context.scale(dpr, dpr)
  const dotRadius = size * 0.095
  const badgeRadius = size * 0.30
  // 落点：底部一个小实心点，带描边（深色底、浅色面上都看得见）。
  context.beginPath(); context.arc(center, size - dotRadius - size * 0.06, dotRadius, 0, Math.PI * 2)
  context.fillStyle = "#ffffff"; context.fill()
  context.lineWidth = size * 0.035; context.strokeStyle = "rgba(12,18,26,0.9)"; context.stroke()
  // 编号：一个圆，压着锚点上方，避免盖住落点本身。
  const badgeY = center - size * 0.06
  context.beginPath(); context.arc(center, badgeY, badgeRadius, 0, Math.PI * 2)
  context.fillStyle = selected ? "#4fb3ff" : "#ffd34d"; context.fill()
  context.lineWidth = size * 0.045; context.strokeStyle = "rgba(12,18,26,0.9)"; context.stroke()
  context.fillStyle = "#10161f"
  context.font = `700 ${Math.round(size * 0.30)}px system-ui, sans-serif`
  context.textAlign = "center"; context.textBaseline = "middle"
  context.fillText(String(index), center, badgeY + size * 0.012)
  context.restore()
}

/** 按相机距离算"一个屏幕像素对应多少世界单位"，让徽标在各种距离下保持同一屏幕大小。 */
export function annotationScreenScale(distance: number, camera: THREE.PerspectiveCamera, heightPx: number): number {
  const height = Math.max(heightPx, 1)
  const halfHeight = Math.tan(camera.fov * Math.PI / 360) * Math.max(distance, 0.001)
  // 贴图里圆点只占画布约 60% 高，这里按画布整体高度换算，留出边距不被拉扁。
  return (BADGE_SCREEN_PX * 1.6 / height) * 2 * halfHeight
}

/** 建一个批注标记：屏幕尺寸恒定的编号徽标 + 不可见的拾取球。 */
export function buildAnnotationMarker(annotation: ViewerAnnotation): MarkerEntry {
  const marker = new THREE.Group()
  marker.name = `annotation-${annotation.annotationId}`
  marker.userData.annotationId = annotation.annotationId
  const badgeCanvas = document.createElement("canvas")
  const badgeTexture = new THREE.CanvasTexture(badgeCanvas)
  badgeTexture.colorSpace = THREE.SRGBColorSpace
  badgeTexture.minFilter = THREE.LinearFilter
  badgeTexture.magFilter = THREE.LinearFilter
  badgeTexture.generateMipmaps = false
  const badge = new THREE.Sprite(new THREE.SpriteMaterial({ map: badgeTexture, transparent: true, depthTest: true, depthWrite: false }))
  badge.renderOrder = 900
  // 拾取球：可见性交给材质透明度，`visible` 保持 true——Raycaster 会跳过 visible=false 的对象，
  // 关掉批注模式时改用 `pick.raycast` 置空来禁用拾取，而不是把对象隐藏。
  const pick = new THREE.Mesh(new THREE.SphereGeometry(PICK_RADIUS_M, 12, 8), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
  pick.userData.annotationId = annotation.annotationId
  marker.add(badge, pick)
  const entry: MarkerEntry = { marker, badge, badgeTexture, badgeCanvas, pick }
  refreshAnnotationMarker(entry, annotation.index, false)
  return entry
}

/** 编号/选中态变了才重画贴图：文字是逐键推下来的，无脑重画会让每敲一个字都重绘一遍。 */
export function refreshAnnotationMarker(entry: MarkerEntry, index: number, selected: boolean): void {
  const key = `${String(index)}|${selected ? "1" : "0"}`
  if (entry.badgeKey === key) return
  entry.badgeKey = key
  drawBadge(entry.badgeCanvas, index, selected, typeof window === "undefined" ? 1 : window.devicePixelRatio)
  entry.badgeTexture.needsUpdate = true
}

/** 选中态：徽标换成冷色，判据只有"是不是当前选中"，不引入第二套状态。 */
export function applyAnnotationSelection(entry: MarkerEntry, selected: boolean): void {
  const index = Number((entry.badgeKey ?? "1|0").split("|")[0]) || 1
  refreshAnnotationMarker(entry, index, selected)
}

/**
 * 每帧把标记摆到实体当前世界点，并按相机距离维持恒定屏幕大小。
 *
 * 这是"批注附着在 3D 上"的唯一执行点：实体被运行帧或编辑移动后，标记在同一帧就跟着走；
 * 相机绕行只改投影与缩放，不改锚点。
 */
export function updateAnnotationMarker(entry: MarkerEntry, world: THREE.Vector3, camera: THREE.PerspectiveCamera, viewportHeightPx: number, pickable: boolean): void {
  entry.marker.position.copy(world)
  entry.pick.raycast = pickable ? THREE.Mesh.prototype.raycast : () => undefined
  const distance = camera.position.distanceTo(world)
  const scale = annotationScreenScale(distance, camera, viewportHeightPx)
  entry.badge.scale.set(scale, scale, 1)
}

/** 释放一个标记的几何/材质/贴图（Sprite 不在 disposeObject 的 Mesh 判据里，必须单独处理）。 */
export function disposeAnnotationMarker(entry: MarkerEntry): void {
  entry.marker.removeFromParent()
  entry.pick.geometry.dispose(); entry.pick.material.dispose()
  entry.badgeTexture.dispose(); entry.badge.material.dispose()
}

/** 世界点 → 截图像素坐标（device 像素）。**必须与 capture() 同一约定**：canvas.width 是着色缓冲尺寸。 */
export function projectToCapture(world: THREE.Vector3, camera: THREE.PerspectiveCamera, size: { width: number; height: number }): [number, number] | undefined {
  const ndc = world.clone().project(camera)
  if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y) || ndc.z < -1 || ndc.z > 1) return undefined
  return [Math.round((ndc.x * 0.5 + 0.5) * size.width), Math.round((1 - (ndc.y * 0.5 + 0.5)) * size.height)]
}

/**
 * 把编号点烧进 PNG：标签是 DOM/Sprite 之外的展示件，模型要"看见"编号就只能落在像素上。
 *
 * 为什么在浏览器里做：投影矩阵与 canvas 尺寸只在客户端存在，host 侧再算一遍要复制整套相机参数与
 * 像素比约定，任何一处不一致都会让圈点与画面错位。这里用与 capture() 完全相同的投影输入，只做一次。
 */
export function drawAnnotationPins(base: string, pins: Array<{ index: number; point: [number, number]; text?: string }>, pixelRatio: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement("canvas")
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      const context = canvas.getContext("2d")
      if (!context) { reject(new Error("ANNOTATION_OVERLAY_CONTEXT_UNAVAILABLE")); return }
      context.drawImage(image, 0, 0)
      const unit = Math.max(canvas.width / 640, 1) * Math.max(pixelRatio, 1)
      const radius = 16 * unit
      for (const pin of pins) {
        const [x, y] = pin.point
        if (x < -radius || y < -radius || x > canvas.width + radius || y > canvas.height + radius) continue
        context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2)
        context.fillStyle = "#ffd34d"; context.fill()
        context.lineWidth = 2.5 * unit; context.strokeStyle = "#121a24"; context.stroke()
        context.fillStyle = "#121a24"; context.font = `bold ${16 * unit}px sans-serif`
        context.textAlign = "center"; context.textBaseline = "middle"
        context.fillText(String(pin.index), x, y + unit)
        const caption = (pin.text ?? "").trim()
        if (!caption) continue
        context.font = `${14 * unit}px sans-serif`; context.textAlign = "left"; context.textBaseline = "middle"
        const label = caption.length > 24 ? caption.slice(0, 24) + "…" : caption
        const padding = 6 * unit, width = context.measureText(label).width + padding * 2
        context.fillStyle = "rgba(18,26,36,0.85)"
        context.fillRect(x + radius + 4 * unit, y - 11 * unit, width, 22 * unit)
        context.fillStyle = "#e7efff"
        context.fillText(label, x + radius + 4 * unit + padding, y)
      }
      resolve(canvas.toDataURL("image/png"))
    }
    image.onerror = () => reject(new Error("ANNOTATION_CAPTURE_DECODE_FAILED"))
    image.src = base
  })
}
