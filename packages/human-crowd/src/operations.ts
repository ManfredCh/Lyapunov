import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Quaternion, Vector3 } from 'three'
import { randomUUID, createHash } from 'node:crypto'
import type { Entity, HumanComponent, HumanDefinition, HumanRoute, SceneSnapshot, Transform, Vec3 } from '../../lyapunov-contracts/src/types.ts'
import type { SimWorlds } from '../../sim-contract/src/index.ts'
import type { SceneOperations } from '../../scene-kit/src/operations.ts'
import { IDENTITY, proceduralHuman, randomSource } from './rig.ts'
import { proceduralGlb, readRiggedGlb, HUMAN_GLB_MAX_BYTES } from './glb.ts'
import { loadRocketboxCatalog, verifiedRocketboxAvatar, rocketboxCatalogRoot } from './rocketbox-catalog.ts'
import { ROCKETBOX_DEFAULT_MIX, rocketboxLaneRegion, type RocketboxAvatarId } from './rocketbox-sample.ts'
export interface CrowdSpawnInput {sceneId:string;expectedRevision:number;templateEntityId?:string;templateEntityIds?:string[];templateRoutes?:Record<string,HumanRoute>;count:number;seed:number;groupId?:string;region:{min:Vec3;max:Vec3};heightM?:number;collision?:HumanComponent['collision'];mode?:HumanComponent['mode'];route?:HumanRoute;speedRangeMps?:[number,number];runFraction?:number;standFraction?:number}
export interface HumanImportInput {sceneId:string;expectedRevision:number;path:string;entityId?:string;positionM?:Vec3;boneMapping:Record<string,string>;license:string;attribution?:string;sourceUpAxis:'Y'|'Z';metersPerUnit?:number;headingOffsetRad?:number;name?:string;templateOnly?:boolean}
export interface CrowdScope {sceneId:string;entityIds?:string[];groupId?:string}
function vector(value:unknown,label:string):asserts value is Vec3 {if(!Array.isArray(value)||value.length!==3||!value.every(v=>typeof v==='number'&&Number.isFinite(v)))throw Error('HUMAN_VECTOR_INVALID: '+label)}
function revision(scene:SceneSnapshot,expected:number){if(scene.revision!==expected)throw Error(`SCENE_REVISION_MISMATCH: expected=${expected}, actual=${scene.revision}`)}
function ids(scene:SceneSnapshot,input:CrowdScope):Entity[]{if(input.entityIds?.length&&input.groupId)throw Error('HUMAN_SCOPE_AMBIGUOUS');if(!input.entityIds?.length&&!input.groupId)throw Error('HUMAN_SCOPE_REQUIRED: 显式选择entityIds或groupId');const rows=scene.entities.filter(e=>e.components.human&&(input.entityIds?.includes(e.entityId)||input.groupId&&(e.components.humanGroup as {groupId?:string})?.groupId===input.groupId));if(!rows.length||input.entityIds?.some(id=>!rows.some(e=>e.entityId===id)))throw Error('HUMAN_ENTITY_MISSING');return rows}
function validateCrowdSpawn(input:CrowdSpawnInput){
 if(input.templateEntityIds!==undefined&&(!Array.isArray(input.templateEntityIds)||!input.templateEntityIds.length))throw Error('HUMAN_TEMPLATE_SELECTION_INVALID')
 if(input.mode!==undefined&&!['kinematic','ragdoll'].includes(input.mode)||input.collision!==undefined&&!['detailed','coarse'].includes(input.collision))throw Error('HUMAN_MODE_INVALID')
 if(input.mode==='ragdoll'&&input.collision==='coarse')throw Error('HUMAN_DYNAMIC_DETAILED_REQUIRED')
 if(!Number.isInteger(input.count)||input.count<1||input.count>1000||!Number.isInteger(input.seed))throw Error('HUMAN_SPAWN_INVALID: count须1-1000、seed须整数')
 vector(input.region?.min,'region.min');vector(input.region?.max,'region.max');if(input.region.min.some((v,i)=>v>input.region.max[i]!))throw Error('HUMAN_REGION_INVALID')
 for(const value of[input.runFraction??0,input.standFraction??0])if(!Number.isFinite(value)||value<0||value>1)throw Error('HUMAN_BEHAVIOR_FRACTION_INVALID')
 if((input.runFraction??0)+(input.standFraction??0)>1)throw Error('HUMAN_BEHAVIOR_FRACTION_INVALID')
 if(input.speedRangeMps&&(!input.speedRangeMps.every(v=>Number.isFinite(v)&&v>=0&&v<=6)||input.speedRangeMps[0]>input.speedRangeMps[1]))throw Error('HUMAN_SPEED_INVALID')
}
interface SpawnDefaults {defaultLanes?:boolean}
function laneStarts(input:CrowdSpawnInput):Vec3[]{
 const required=rocketboxLaneRegion(input.count),columns=Math.ceil(Math.sqrt(input.count)),rows=Math.ceil(input.count/columns),width=input.region.max[0]-input.region.min[0],depth=input.region.max[1]-input.region.min[1]
 if(width<required.max[0]-required.min[0]||depth<required.max[1]-required.min[1]||input.region.min[2]!==input.region.max[2])throw Error(`HUMAN_CATALOG_REGION_TOO_SMALL: 分散往返需要至少${columns*4}×${rows*2}米的固定Z平面；减少人数或扩大region，显式route使用原世界路径。`)
 const cellWidth=width/columns,cellDepth=depth/rows
 return Array.from({length:input.count},(_,i)=>[input.region.min[0]+i%columns*cellWidth+(cellWidth-2)/2,input.region.min[1]+(Math.floor(i/columns)+.5)*cellDepth,input.region.min[2]])
}
export async function spawnCrowd(ops:SceneOperations,input:CrowdSpawnInput,defaults:SpawnDefaults={}){
 const scene=await ops.scene.snapshot(input.sceneId);revision(scene,input.expectedRevision)
 validateCrowdSpawn(input)
 if(input.templateEntityId&&input.templateEntityIds?.length)throw Error('HUMAN_TEMPLATE_AMBIGUOUS')
 if(input.templateEntityId||input.templateEntityIds?.length)return spawnFromTemplate(ops,scene,input,defaults)
 const human=proceduralHuman(input.heightM);human.collision=input.collision??'detailed';human.mode=input.mode??'kinematic';if(!['detailed','coarse'].includes(human.collision)||!['kinematic','ragdoll'].includes(human.mode))throw Error('HUMAN_MODE_INVALID');if(human.mode==='ragdoll'&&human.collision==='coarse')throw Error('HUMAN_DYNAMIC_DETAILED_REQUIRED')
 const bytes=proceduralGlb(human),sha=createHash('sha256').update(bytes).digest('hex');const dir=join(ops.layout.cache,'human-crowd','original');await mkdir(dir,{recursive:true});const path=join(dir,sha+'.glb');await writeFile(path,bytes)
 const resource=await ops.resources.import({path,name:'原创程序化人体',resourceId:'human-procedural-'+sha.slice(0,16),source:{units:'m',upAxis:'Z',handedness:'right'},license:{id:'Apache-2.0',attribution:human.source.attribution,source:'declared'},physicalizationRequest:false,components:{humanDefinition:human},tags:['human','original','rigged']})
 const random=randomSource(input.seed),groupId=input.groupId??'crowd_'+randomUUID();const definitionEntityId=groupId+'_asset';const shared={...structuredClone(human)};const {rig,boneMapping,clips,...instance}=human;const entities:Entity[]=[{entityId:definitionEntityId,name:'人体群组',transform:structuredClone(IDENTITY),resources:[resource.ref],components:{visual:{kind:'group'},humanDefinition:shared,humanGroup:{groupId,seed:input.seed}}}]
 for(let i=0;i<input.count;i++){const position=input.region.min.map((v,k)=>v+random()*(input.region.max[k]!-v))as Vec3;const phase=random(),choice=random();const route=input.route?structuredClone(input.route):undefined;if(route){if(choice<(input.standFraction??0))route.behavior='stand';else if(choice<(input.standFraction??0)+(input.runFraction??0))route.behavior='run';if(input.speedRangeMps)route.speedMps=input.speedRangeMps[0]+random()*(input.speedRangeMps[1]-input.speedRangeMps[0])}entities.push({entityId:groupId+'_'+i.toString().padStart(4,'0'),name:`行人 ${i+1}`,transform:{...structuredClone(IDENTITY),position},resources:[resource.ref],components:{visual:{kind:'mesh'},human:{...structuredClone(instance),definition:{entityId:definitionEntityId,resourceId:resource.ref.resourceId,version:resource.ref.version},phase,source:{...human.source,sha256:sha},...route?{route}:{}},humanGroup:{groupId,seed:input.seed,index:i}}})}
 const snapshot=await ops.scene.commit({sceneId:input.sceneId,expectedRevision:input.expectedRevision,patch:entities.map(entity=>({op:'add' as const,entity}))});return{status:'completed',snapshot,groupId,entityIds:entities.filter(e=>e.components.human).map(e=>e.entityId),resource:resource.ref,worldNeedsSync:true}
}
/** 当前Scene内复用已导入定义/资源，不新建模板库，也不把rig/动作复制到每个人。 */
async function spawnFromTemplate(ops:SceneOperations,scene:SceneSnapshot,input:CrowdSpawnInput,defaults:SpawnDefaults){
 const positions=defaults.defaultLanes?laneStarts(input):undefined
 const templateIds=input.templateEntityIds??[input.templateEntityId!]
 if(new Set(templateIds).size!==templateIds.length||templateIds.length>12)throw Error('HUMAN_TEMPLATE_SELECTION_INVALID')
 const templates=[]
 for(const templateId of templateIds){
 const selected=scene.entities.find(e=>e.entityId===templateId);if(!selected)throw Error('HUMAN_TEMPLATE_MISSING: 当前Scene没有指定人体模板')
 const selectedHuman=selected.components.human,definitionId=selectedHuman?.definition?.entityId??selected.entityId,asset=scene.entities.find(e=>e.entityId===definitionId),human=asset?.components.humanDefinition as HumanDefinition|undefined
 if(!asset||!human)throw Error('HUMAN_TEMPLATE_DEFINITION_MISSING: 指定模板的共享人体定义已删除')
 const reference=selectedHuman?.definition,ref=asset.resources.find(r=>!reference||r.resourceId===reference.resourceId&&r.version===reference.version)
 if(!ref)throw Error('HUMAN_TEMPLATE_STALE: 模板的资源身份与共享定义不一致')
 await ops.resources.get(ref.resourceId,ref.version)
 if(input.heightM!==undefined&&Math.abs(input.heightM-human.heightM)>1e-9)throw Error('HUMAN_TEMPLATE_RESCALE_UNSUPPORTED: 已导入角色的骨架/蒙皮须保持校准身高')
 const mode=input.mode??selectedHuman?.mode??human.mode,collision=input.collision??selectedHuman?.collision??human.collision
 if(!['kinematic','ragdoll'].includes(mode)||!['detailed','coarse'].includes(collision))throw Error('HUMAN_MODE_INVALID')
 if(mode==='ragdoll'&&collision!=='detailed')throw Error('HUMAN_DYNAMIC_DETAILED_REQUIRED')
 const exemplar=selectedHuman?selected:scene.entities.find(e=>e.components.human?.definition?.entityId===asset.entityId),source=human.source
 const visual=exemplar?.components.visual??{kind:'mesh',sourceTransform:{position:[0,0,0],quaternion:new Quaternion().setFromAxisAngle(new Vector3(0,0,1),source.headingOffsetRad??0).multiply(new Quaternion().setFromAxisAngle(new Vector3(1,0,0),source.sourceUpAxis==='Y'?Math.PI/2:0)).toArray(),scale:Array(3).fill(source.metersPerUnit??1)}}
 const{rig,boneMapping,clips,definition,footCollision,...instance}=selectedHuman??human
 templates.push({selected,asset,ref,mode,collision,visual,instance,baseRoute:input.templateRoutes?.[templateId]??input.route??exemplar?.components.human?.route})
 }
 const groupId=input.groupId??'crowd_'+randomUUID(),random=randomSource(input.seed),entities:Entity[]=[{entityId:groupId+'_group',name:templates.length>1?'混合角色人群':templates[0]!.selected.name+'群组',transform:structuredClone(IDENTITY),resources:[],components:{visual:{kind:'group'},humanGroup:{groupId,seed:input.seed}}}]
 for(let i=0;i<input.count;i++){
  const {selected,asset,ref,mode,collision,visual,instance,baseRoute}=templates[i%templates.length]!
  const position=positions?.[i]??input.region.min.map((v,k)=>v+random()*(input.region.max[k]!-v))as Vec3,phase=random(),choice=random(),route=baseRoute?structuredClone(baseRoute):undefined
  if(defaults.defaultLanes&&route)route.pointsM=[[position[0]+2,position[1],position[2]],[...position]]
  if(route){if(choice<(input.standFraction??0))route.behavior='stand';else if(choice<(input.standFraction??0)+(input.runFraction??0))route.behavior='run';if(input.speedRangeMps)route.speedMps=input.speedRangeMps[0]+random()*(input.speedRangeMps[1]-input.speedRangeMps[0])}
  entities.push({entityId:groupId+'_'+i.toString().padStart(4,'0'),name:selected.name+' '+(i+1),transform:{...structuredClone(IDENTITY),position},resources:[structuredClone(ref)],components:{visual:structuredClone(visual),human:{...structuredClone(instance),mode,collision,definition:{entityId:asset.entityId,resourceId:ref.resourceId,version:ref.version},phase,...route?{route}:{}},humanGroup:{groupId,seed:input.seed,index:i}}})
 }
 const snapshot=await ops.scene.commit({sceneId:scene.sceneId,expectedRevision:input.expectedRevision,patch:entities.map(entity=>({op:'add'as const,entity}))});return{status:'completed',snapshot,groupId,entityIds:entities.filter(e=>e.components.human).map(e=>e.entityId),resource:templates[0]!.ref,resources:templates.map(row=>row.ref),worldNeedsSync:true}
}
export async function importHuman(ops:SceneOperations,input:HumanImportInput){
 const scene=await ops.scene.snapshot(input.sceneId);revision(scene,input.expectedRevision);if(!['Y','Z'].includes(input.sourceUpAxis))throw Error('HUMAN_SOURCE_AXIS_REQUIRED');if((await stat(input.path)).size>HUMAN_GLB_MAX_BYTES)throw Error('HUMAN_GLB_LIMIT');const human=readRiggedGlb(await readFile(input.path),input);if(input.positionM)vector(input.positionM,'positionM')
 const resource=await ops.resources.import({path:input.path,name:input.name??'导入人体角色',source:{units:(input.metersPerUnit??1)===1?'m':'source-unit',upAxis:input.sourceUpAxis,handedness:'right',metersPerUnit:input.metersPerUnit??1},license:{id:input.license,attribution:input.attribution,source:'declared'},physicalizationRequest:false,components:{humanDefinition:human},tags:['human','rigged']});const entityId=input.entityId??'human_'+randomUUID();const definitionEntityId=entityId+'_asset';const{rig,boneMapping,clips,footCollision,...instance}=human;const asset:Entity={entityId:definitionEntityId,name:(input.name??'人体角色')+'资产',transform:structuredClone(IDENTITY),resources:[resource.ref],components:{visual:{kind:'group'},humanDefinition:human}};const entity:Entity={entityId,name:resource.name,transform:{...structuredClone(IDENTITY),position:input.positionM??[0,0,0]},resources:[resource.ref],components:{visual:{kind:'mesh',sourceTransform:{position:[0,0,0],quaternion:new Quaternion().setFromAxisAngle(new Vector3(0,0,1),input.headingOffsetRad??0).multiply(new Quaternion().setFromAxisAngle(new Vector3(1,0,0),input.sourceUpAxis==='Y'?Math.PI/2:0)).toArray(),scale:Array(3).fill(input.metersPerUnit??1)}},human:{...instance,definition:{entityId:definitionEntityId,resourceId:resource.ref.resourceId,version:resource.ref.version}}}};const snapshot=await ops.scene.commit({sceneId:input.sceneId,expectedRevision:input.expectedRevision,patch:[{op:'add',entity:asset},...input.templateOnly?[]:[{op:'add' as const,entity}]]});return{status:'completed',snapshot,entityId:input.templateOnly?definitionEntityId:entity.entityId,definitionEntityId,resource:resource.ref,clips:human.clips.map(c=>({name:c.name,durationS:c.durationS})),worldNeedsSync:true}
}
/** 按人预设路线：与显式route互斥；仍是一次Scene commit，Tool/Command共用。 */
export interface CrowdRoutePreset {kind:'back-and-forth'|'square-loop'|'idle';distanceM?:number;speedMps?:number}
/** 实体transform的Z-up水平朝向（quaternion xyzw → yaw，前向+X）。 */
function headingYaw(transform:Transform):number{const[x,y,z,w]=transform.quaternion;return Math.atan2(2*(w*z+x*y),1-2*(y*y+z*z))}
/** 既有route优先；没有route时取该人定义所属随包内置角色的walkSpeedMps/walkClip；取不到具名拒绝，不猜。 */
function walkDefaults(scene:SceneSnapshot,human:HumanComponent,catalog:Map<string,{walkClip:string;walkSpeedMps:number}>|undefined):{speedMps:number;clip?:string}{
 if(human.route?.speedMps)return{speedMps:human.route.speedMps,clip:human.route.clip}
 const avatar=catalogAvatar(scene,human,catalog)
 if(avatar)return{speedMps:avatar.walkSpeedMps,clip:avatar.walkClip}
 throw Error(`HUMAN_PRESET_DEFAULTS_MISSING: ${human.definition?.entityId??'（无定义引用）'} 没有既有route，且定义来源不是随包内置角色；请显式给route或speedMps/clip`)
}
function catalogAvatar(scene:SceneSnapshot,human:HumanComponent,catalog:Map<string,{walkClip:string;walkSpeedMps:number}>|undefined){
 const definition=human.definition?scene.entities.find(e=>e.entityId===human.definition!.entityId):undefined
 const sha=((definition?.components.humanDefinition as HumanDefinition|undefined)?.source.sha256)??human.source.sha256
 return sha?catalog?.get(sha):undefined
}
function presetRoute(scene:SceneSnapshot,e:Entity,preset:CrowdRoutePreset,catalog:Map<string,{walkClip:string;walkSpeedMps:number}>|undefined):HumanRoute{
 const human=e.components.human!
 const start=e.transform.position.map(v=>v)as Vec3
 const speedMps=preset.speedMps??human.route?.speedMps??walkDefaults(scene,human,catalog).speedMps
 const yaw=headingYaw(e.transform),hx=Math.cos(yaw),hy=Math.sin(yaw),lx=-hy,ly=hx,d=preset.distanceM??2
 const at=(dx:number,dy:number):Vec3=>[start[0]+dx*hx+dy*lx,start[1]+dx*hy+dy*ly,start[2]]
 const inherited=human.route?((({pointsM,speedMps:_s,behavior:_b,loop:_l,clip:_c,...rest})=>rest)(human.route)):{}
 if(preset.kind==='idle'){
  const definition=human.definition?scene.entities.find(row=>row.entityId===human.definition!.entityId):undefined
  const clips=(definition?.components.humanDefinition as HumanDefinition|undefined)?.clips??human.clips??[]
  return{...inherited,pointsM:[start],speedMps,behavior:'stand',loop:false,...clips.some(c=>c.name==='Idle')?{clip:'Idle'}:{}}
 }
 const pointsM=preset.kind==='square-loop'?[start,at(d,0),at(d,d),at(0,d)]:[at(d,0),start]
 const clip=human.route?.clip??catalogAvatar(scene,human,catalog)?.walkClip
 if(!clip)throw Error(`HUMAN_PRESET_DEFAULTS_MISSING: ${human.definition?.entityId??'（无定义引用）'} 没有clip可沿用，且定义来源不是随包内置角色；请显式给route`)
 return{...inherited,pointsM,speedMps,behavior:'walk',loop:true,clip}
}
/**
 * IRA 只接受本实现真实消费的配置：显式循环 walk 路线、米制点/速度，加显式区域与停留。
 * 不支持的行为/可选能力在写入 Scene 前具名拒绝，避免“保存了但运行时不生效”。
 */
export function validateIra(ira:HumanComponent['ira'],route:HumanRoute|undefined,label='human'){
 if(!ira||typeof ira!=='object'||Array.isArray(ira))throw Error('HUMAN_IRA_INVALID: '+label+' ira 必须是对象')
 if(!Number.isInteger(ira.seed)||ira.seed<0||ira.seed>2147483647)throw Error('HUMAN_IRA_SEED_INVALID: '+label+' ira.seed 必须是0–2147483647的整数')
 vector(ira.region?.min,'ira.region.min');vector(ira.region?.max,'ira.region.max')
 if(ira.region.min.some((v,i)=>v>ira.region.max[i]!))throw Error('HUMAN_IRA_REGION_INVALID: '+label+' ira.region.min 不得大于 max')
 if(!(ira.region.max[0]>ira.region.min[0])||!(ira.region.max[1]>ira.region.min[1]))throw Error('HUMAN_IRA_REGION_INVALID: '+label+' ira.region 的 X/Y 必须是正范围（区域停留需要可进入的平面）')
 if(!Number.isFinite(ira.dwellS)||ira.dwellS<=0||ira.dwellS>300)throw Error('HUMAN_IRA_DWELL_INVALID: '+label+' ira.dwellS 必须>0且≤300秒')
 if(!route)throw Error('HUMAN_IRA_ROUTE_REQUIRED: '+label+' IRA 需要现有显式循环walk路线')
 if(route.behavior!=='walk')throw Error('HUMAN_IRA_ROUTE_UNSUPPORTED: '+label+' IRA 只执行 walk；run/stand 不冒充官方巡逻')
 if(route.loop!==true)throw Error('HUMAN_IRA_ROUTE_UNSUPPORTED: '+label+' IRA 需要 loop:true 的循环路线')
 if(!Array.isArray(route.pointsM)||route.pointsM.length<2||route.pointsM.length>256)throw Error('HUMAN_IRA_ROUTE_UNSUPPORTED: '+label+' IRA 需要2–256个米制 pointsM')
 for(const [index,point]of route.pointsM.entries())vector(point,'ira.route.pointsM['+index+']')
 if(!Number.isFinite(route.speedMps)||route.speedMps<=0||route.speedMps>6)throw Error('HUMAN_IRA_ROUTE_UNSUPPORTED: '+label+' IRA speedMps 须>0且≤6')
 for(const [key,value]of Object.entries({navigation:route.navigation,dwellS:route.dwellS,yieldToHumans:route.yieldToHumans,avoidanceRadiusM:route.avoidanceRadiusM,avoidObstacles:route.avoidObstacles,turnRateRadps:route.turnRateRadps,clip:route.clip}))if(value!==undefined)throw Error(`HUMAN_IRA_ROUTE_UNSUPPORTED: ${label} IRA 不消费 ${key}`)
}
export async function configureCrowd(ops:SceneOperations,input:CrowdScope&{expectedRevision:number;route?:HumanRoute;preset?:CrowdRoutePreset;collision?:HumanComponent['collision'];ira?:HumanComponent['ira']|null},catalogRoot=rocketboxCatalogRoot()){
 const scene=await ops.scene.snapshot(input.sceneId);revision(scene,input.expectedRevision);const rows=ids(scene,input)
 if(input.route&&input.preset)throw Error('HUMAN_ROUTE_PRESET_CONFLICT: preset与显式route只能给一个')
 if(input.preset){
  if(!['back-and-forth','square-loop','idle'].includes(input.preset.kind))throw Error('HUMAN_PRESET_KIND_INVALID')
  if(input.preset.distanceM!==undefined&&(!Number.isFinite(input.preset.distanceM)||input.preset.distanceM<.5||input.preset.distanceM>20))throw Error('HUMAN_PRESET_DISTANCE_INVALID: distanceM须0.5–20米')
  if(input.preset.speedMps!==undefined&&(!Number.isFinite(input.preset.speedMps)||input.preset.speedMps<=0||input.preset.speedMps>3))throw Error('HUMAN_PRESET_SPEED_INVALID: speedMps须>0且≤3')
 }
 if(input.collision&&!['detailed','coarse'].includes(input.collision))throw Error('HUMAN_COLLISION_INVALID')
 let catalog:Map<string,{walkClip:string;walkSpeedMps:number}>|undefined
 const patch=[]
 for(const e of rows){
  const changes:Record<string,unknown>={}
  if(input.route)changes.route=structuredClone(input.route)
  else if(input.preset){
   if(!catalog){try{const loaded=await loadRocketboxCatalog(catalogRoot);catalog=new Map(loaded.avatars.map(a=>[a.sha256,{walkClip:a.walkClip,walkSpeedMps:a.walkSpeedMps}]))}catch{catalog=new Map()}}
   changes.route=presetRoute(scene,e,input.preset,catalog)
  }
  if(input.collision)changes.collision=input.collision
  const nextHuman={...e.components.human!,...changes}
  if(input.ira===null)delete nextHuman.ira
  else if(input.ira!==undefined){if(nextHuman.mode!=='kinematic')throw Error('HUMAN_IRA_MODE_UNSUPPORTED: IRA 需要运动学人物');validateIra(input.ira,nextHuman.route,e.entityId);nextHuman.ira=structuredClone(input.ira)}
  else if(nextHuman.ira)validateIra(nextHuman.ira,nextHuman.route,e.entityId)
  patch.push({op:'update' as const,entityId:e.entityId,changes:{components:{...e.components,human:nextHuman}}})
 }
 const snapshot=await ops.scene.commit({sceneId:scene.sceneId,expectedRevision:input.expectedRevision,patch});return{status:'completed',snapshot,entityIds:rows.map(e=>e.entityId),worldNeedsSync:true}}
export async function startCrowd(ops:SceneOperations,sim:SimWorlds,input:CrowdScope&{worldId:string;expectedGeneration:number;durationS:number;actionId?:string;forceN?:Vec3},signal?:AbortSignal){const scene=await ops.scene.snapshot(input.sceneId),rows=ids(scene,input);const world=(await sim.listWorlds()).find(w=>w.worldId===input.worldId);if(!world||world.sceneId!==scene.sceneId)throw Error('HUMAN_WORLD_SCENE_MISMATCH');if(world.appliedSceneRevision!==scene.revision)throw Error('HUMAN_WORLD_UNSYNCED');if(world.worldGeneration!==input.expectedGeneration)throw Error('STALE_GENERATION');if(!['mujoco','isaac'].includes(world.engineId))throw Error('HUMAN_PROVIDER_UNSUPPORTED: 当前Provider未实现人体物理tick与原生姿态读回');const iraRows=rows.filter(e=>e.components.human!.ira);if(iraRows.length&&world.engineId!=='isaac')throw Error('HUMAN_IRA_ISAAC_ONLY: IRA 巡逻/区域停留只在 Isaac 已加载官方 SDK/资产的 world 执行；不会在 MuJoCo 上静默走普通路线');if(iraRows.length){const supported=(world.capabilities as {supported?:Record<string,unknown>}|undefined)?.supported;if(supported?.humanIra!==true)throw Error('HUMAN_IRA_REOPEN_REQUIRED: 当前 Isaac world 未启用 IRA SDK/资产（开放世界时快照没有 ira 声明或 Kit 未加载官方扩展）；请 sim_close 后按当前 Scene 重新 open')}return sim.execute(input.worldId,{actionId:input.actionId??'human_'+randomUUID(),expectedGeneration:input.expectedGeneration,kind:'batch',motions:rows.map(e=>({kind:'human' as const,entityId:e.entityId,durationS:input.durationS,...e.components.human!.route?{route:e.components.human!.route}:{},...input.forceN?{forceN:input.forceN}:{}}))},signal)}
export async function stopCrowd(ops:SceneOperations,sim:SimWorlds,input:CrowdScope&{worldId:string;expectedGeneration:number}){const scene=await ops.scene.snapshot(input.sceneId),rows=ids(scene,input);const world=(await sim.listWorlds()).find(w=>w.worldId===input.worldId);if(!world||world.sceneId!==scene.sceneId)throw Error('HUMAN_WORLD_SCENE_MISMATCH');const requestedEntityIds=rows.map(e=>e.entityId),receipt=await sim.stop(input.worldId,{expectedGeneration:input.expectedGeneration,entityIds:requestedEntityIds}),affected=new Set(receipt.affectedEntityIds??[]);return{...receipt,requestedEntityIds,alreadyIdleEntityIds:requestedEntityIds.filter(id=>!affected.has(id))}}
export async function inspectCrowd(ops:SceneOperations,sim:SimWorlds|undefined,input:CrowdScope&{worldId?:string}){const scene=await ops.scene.snapshot(input.sceneId),rows=ids(scene,input);if(input.worldId){const world=sim&&(await sim.listWorlds()).find(w=>w.worldId===input.worldId);if(!world||world.sceneId!==scene.sceneId)throw Error('HUMAN_WORLD_SCENE_MISMATCH')}const frame=input.worldId&&sim?await sim.observe(input.worldId,{entityIds:rows.map(e=>e.entityId),contacts:true}):undefined;if(frame&&frame.sceneRevision!==scene.revision)throw Error('HUMAN_WORLD_UNSYNCED');return{sceneId:scene.sceneId,revision:scene.revision,entities:rows.map(e=>({entityId:e.entityId,group:e.components.humanGroup,human:e.components.human,resources:e.resources})),frame,limitations:{kinematic:'不会自然受力失衡；显式navigation可在固定Z平面自动绕障，未启用时保守停止',ragdoll:'真实自由动力学受力/跌倒；无稳定行走及恢复控制器',appearance:'未选模板时为占位预览；Scene已导入角色可共享模板批量创建，其许可由导入者显式声明'}}}

export interface CatalogCrowdInput extends Omit<CrowdSpawnInput,'templateEntityId'|'templateEntityIds'|'templateRoutes'|'heightM'> {avatarIds?:RocketboxAvatarId[]}
/** 内置来源只读；导入及实例身份统一留在当前会话 ResourceLibrary/Scene。 */
export async function spawnCatalogCrowd(ops:SceneOperations,input:CatalogCrowdInput,catalogRoot=rocketboxCatalogRoot()){
 let snapshot=await ops.scene.snapshot(input.sceneId);revision(snapshot,input.expectedRevision);validateCrowdSpawn(input);if(!input.route)laneStarts(input)
 const catalog=await loadRocketboxCatalog(catalogRoot),avatarIds=input.avatarIds??[...ROCKETBOX_DEFAULT_MIX]
 if(!avatarIds.length||avatarIds.length>12||new Set(avatarIds).size!==avatarIds.length)throw Error('HUMAN_CATALOG_SELECTION_INVALID')
 const selected=avatarIds.map(id=>{const entry=catalog.avatars.find(row=>row.avatarId===id);if(!entry)throw Error('HUMAN_CATALOG_AVATAR_MISSING: '+id);return entry})
 // 写Scene前先核完所选全部字节/许可，避免缺件留下半个混合人群。
 const paths=[];for(const avatar of selected)paths.push(await verifiedRocketboxAvatar(avatar,catalogRoot))
 const templateEntityIds:string[]=[],templateRoutes:Record<string,HumanRoute>={},imported:string[]=[]
 try{for(const [index,avatar]of selected.entries()){
  let template=snapshot.entities.find(e=>{
   const definition=e.components.humanDefinition as HumanDefinition|undefined,source=definition?.source
   // 同一GLB可被用户以不同轴向/前向/单位导入；内置预设不能偷复用其自定义校准。
   return source?.sha256===avatar.sha256&&source.license===avatar.license&&source.sourceUpAxis===avatar.sourceUpAxis&&source.metersPerUnit===avatar.metersPerUnit&&source.headingOffsetRad===avatar.headingOffsetRad&&Object.keys(definition!.boneMapping).length===Object.keys(avatar.boneMapping).length&&Object.entries(avatar.boneMapping).every(([role,bone])=>definition!.boneMapping[role]===bone)
  })
  if(!template){const result=await importHuman(ops,{sceneId:input.sceneId,expectedRevision:snapshot.revision,path:paths[index]!,name:avatar.label,license:avatar.license,attribution:avatar.attribution,boneMapping:avatar.boneMapping,sourceUpAxis:avatar.sourceUpAxis,metersPerUnit:avatar.metersPerUnit,headingOffsetRad:avatar.headingOffsetRad,templateOnly:true});snapshot=result.snapshot;template=snapshot.entities.find(e=>e.entityId===result.definitionEntityId)!;imported.push(template.entityId)}
  const definition=template.components.humanDefinition as HumanDefinition
  if(!definition.clips.some(clip=>clip.name===avatar.walkClip))throw Error('HUMAN_CATALOG_CLIP_MISSING: '+avatar.avatarId+'/'+avatar.walkClip)
  templateEntityIds.push(template.entityId)
  templateRoutes[template.entityId]=input.route?structuredClone(input.route):{pointsM:[[3,0,0],[-3,0,0]],behavior:'walk',loop:true,speedMps:avatar.walkSpeedMps,clip:avatar.walkClip}
 }
 const result=await spawnCrowd(ops,{...input,expectedRevision:snapshot.revision,templateEntityIds,templateRoutes},{defaultLanes:!input.route})
 return{...result,avatarIds,importedTemplateEntityIds:imported,...!input.route?{layout:{kind:'separate-return',distanceM:2}}:{}}
 }catch(error){if(!imported.length)throw error;snapshot=await ops.scene.snapshot(input.sceneId);return{status:'partial',snapshot,avatarIds,importedTemplateEntityIds:imported,entityIds:[],error:String(error),worldNeedsSync:true}}
}
export async function inspectHumanCatalog(catalogRoot=rocketboxCatalogRoot()){
 const catalog=await loadRocketboxCatalog(catalogRoot)
 return{schema:1,avatars:catalog.avatars.map(({avatarId,label,license,walkClip,walkSpeedMps,sha256})=>({avatarId,label,license,walkClip,walkSpeedMps,sha256})),defaultAvatarIds:ROCKETBOX_DEFAULT_MIX,defaultExample:{count:20,region:rocketboxLaneRegion(20),layout:'separate-return',distanceM:2}}
}
