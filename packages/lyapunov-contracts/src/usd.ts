import type { Matrix4Elements } from './types.ts'
/** USD原件事实归ResourceLibrary；这些快照只供显示，不能替代原生物理。 */
export interface UsdPreviewShape {
  primPath: string
  kind: 'Mesh' | 'Cube' | 'Sphere' | 'Cylinder' | 'Cone' | 'Capsule'
  matrix: Matrix4Elements
  color: [number, number, number]
  material?: UsdPreviewMaterial
  uvs?:number[][]
  uvInterpolation?:string
  normals?:number[][]
  normalInterpolation?:string
  orientation?:'rightHanded'|'leftHanded'
  bodyPrimPath?:string
  bodyFromShape?:Matrix4Elements
  points?: number[][]
  counts?: number[]
  indices?: number[]
  size?: number
  radius?: number
  height?: number
  axis?: string
}
export interface UsdPreview {
  source: 'openusd-default-time'
  status: 'AVAILABLE' | 'UNAVAILABLE'
  reason?: string
  shapes: UsdPreviewShape[]
  textures?:UsdPreviewTexture[]
  losses: string[]
}
export interface UsdInstanceOverrides {
  /** 精确源prim路径；省略使用源defaultPrim，源未声明时拒绝原生装配。 */
  primPath?: string
  /** 源prim路径 → variantSet → selection；只写场景或session layer，不改原件。 */
  variants?: Record<string, Record<string, string>>
}
export interface UsdAssetFacts {
  format: 'usd' | 'usda' | 'usdc' | 'usdz'
  parserVersion: string
  defaultPrim?: string
  metersPerUnit: number
  upAxis: 'Y' | 'Z'
  simreadyMetadata?: Record<string,unknown>
  layers: string[]
  variants: Array<{ primPath: string; set: string; names: string[]; selection: string }>
  physics: { rigidBodies: string[]; collisions: string[]; joints: string[]; articulations: string[] }
  preview: UsdPreview
  standardLibraries?:UsdStandardLibraryDependency[]
}

/** 独立标准模块资源身份；不并入HF源文件清单，不属于实例覆写。 */
export interface UsdStandardLibraryDependency {resourceId:string;version:number;manifestPath:string;manifestSha256:string;assetIdentifier:string;subIdentifier:string}

/** 原生USD观测将源prim与运行stage路径分别标明，不以leaf名称替代对象身份。 */
export interface UsdNativePrimIdentity {
  runtimePrimPath?: string
  sourcePrimPath?: string
  sourceBodyPrimPath?: string
}

/** 同一Frame.sensors.usdBodyWorldPoses中的实测刚体矩阵；世界米制Z-up，按Three列主序读取。 */
export interface UsdBodyWorldPose {
  sourcePrimPath: string
  runtimePrimPath: string
  worldMatrixM: Matrix4Elements
}

export interface UsdPreviewTexture {id:string;file:string;mimeType:string;size?:number;assetPath?:string;uri?:string}
export interface UsdTextureBinding {textureId:string;channel:'rgb'|'r'|'g'|'b'|'a';colorSpace:'sRGB'|'raw';wrapS:'repeat'|'clamp'|'mirror'|'black';wrapT:'repeat'|'clamp'|'mirror'|'black';scale:[number,number,number,number];bias:[number,number,number,number];/** UsdTransform2d组合，列主序，作用于(st.x,st.y,1)。 */uvTransform?:[number,number,number,number,number,number,number,number,number]}
export interface UsdPreviewMaterial {sourcePrimPath:string;shader:'UsdPreviewSurface'|'OmniPBR';sourceModule?:{resourceId:string;version:number;moduleSha256:string;subIdentifier:string;derivation:'pinned-omnipbr-subset'};baseColor:[number,number,number];roughness:number;metallic:number;opacity:number;baseColorTexture?:UsdTextureBinding;roughnessTexture?:UsdTextureBinding;metallicTexture?:UsdTextureBinding;normalTexture?:UsdTextureBinding}

/** 来自已登记USD版本/当前实例变体的只读源声明；不等于引擎已加载或物理就绪。 */
export interface UsdSourceFacts {
  resourceId:string;version:number;purpose:'object'|'scene'|'robot'
  physics:{rigidBodies:number;collisions:number;joints:number;articulations:number}
}
export function isNativeUsdEntity(entity:import('./types.ts').Entity):boolean {
 return entity.components.visual?.kind==='usd'&&entity.resources.some(ref=>ref.original.mimeType==='model/vnd.usd')
}
export function usdSourceFacts(entity:import('./types.ts').Entity):UsdSourceFacts|undefined {
 if(!isNativeUsdEntity(entity))return
 const facts=(entity.components.usd as {sourceFacts?:UsdSourceFacts}|undefined)?.sourceFacts
 if(!facts||!facts.physics||![facts.physics.rigidBodies,facts.physics.collisions,facts.physics.joints,facts.physics.articulations].every(count=>Number.isSafeInteger(count)&&count>=0)||!['object','scene','robot'].includes(facts.purpose)||!entity.resources.some(ref=>ref.original.mimeType==='model/vnd.usd'&&ref.resourceId===facts.resourceId&&ref.version===facts.version))return
 return facts
}
export function usdSourceHasPhysics(entity:import('./types.ts').Entity):boolean {
 const physics=usdSourceFacts(entity)?.physics
 return !!physics&&[physics.rigidBodies,physics.collisions,physics.joints,physics.articulations].some(count=>Number.isSafeInteger(count)&&count>0)
}
/** 原有显式组件仍是声明；仅对一等USD排除“isaac来源指针即物理意图”的误判。 */
export function entityHasDeclaredPhysics(entity:import('./types.ts').Entity,includeBinding=false):boolean {
 const c=entity.components
 if(c.collision||c.rigidBody||c.articulation||c.mujoco||c.newton||includeBinding&&c.physicsBinding)return true
 return isNativeUsdEntity(entity)?usdSourceHasPhysics(entity):Boolean(c.isaac)
}
