import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { SceneViewer } from '../src/index.ts'
import { staticAnimationReference } from '../src/animation-reference.ts'
import type { Entity, ResourceRef, SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'

const ref:ResourceRef={resourceId:'building',version:3,original:{uri:'scene.glb',mimeType:'model/gltf-binary'},representations:[],source:{units:'m',upAxis:'Y',handedness:'right',metersPerUnit:.1}}
const sourceFrame={pose:'reference',sourceUpAxis:'Y',metersPerUnit:.1,derivedUnits:'m',derivedUpAxis:'Z',animation:{clips:1,evaluated:false,skinApplied:false}}
function entity(physical=true):Entity{return {entityId:'building-a',name:'Building',transform:{position:[100,200,300],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[structuredClone(ref)],components:{visual:{kind:'mesh'},...physical?{collision:{source:'asset-bake-surface',shape:'mesh',parts:['own-collider.obj']},rigidBody:{type:'static'},physicsBinding:{resourceId:'building',version:3,status:'BOUND',usage:'environment',sourceFrame:structuredClone(sourceFrame)}}:{}}}}

async function harness(physical=true,initialPlaying?:boolean){
  const viewer:any=Object.create(SceneViewer.prototype),row=entity(physical)
  const source=new THREE.Group(),root=new THREE.Group(),wall=new THREE.Mesh(new THREE.BoxGeometry(2,3,4),new THREE.MeshStandardMaterial())
  root.name='FileRoot';root.position.set(0,8,1);wall.name='Wall';wall.position.set(2,3,4);wall.quaternion.setFromAxisAngle(new THREE.Vector3(0,0,1),.4);root.add(wall);source.add(root)
  const clip=new THREE.AnimationClip('移动墙',1,[new THREE.VectorKeyframeTrack('Wall.position',[0,1],[20,30,40,25,35,45])])
  viewer.snapshot={sceneId:'scene',revision:1,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[row]} satisfies SceneSnapshot
  viewer.disposed=false;viewer.scene=new THREE.Scene();viewer.objects=new Map();viewer.mixers=new Map();viewer.gltfs=new Map([['resolved.glb',Promise.resolve({scene:source,animations:[clip]})]]);viewer.gltfStats=new Map();viewer.visualWarnings=new Map();viewer.options={resolveResource:async()=> 'resolved.glb'}
  const loaded:any={group:new THREE.Group(),signature:'source-v3',lodWarnings:[]};loaded.group.position.fromArray(row.transform.position);viewer.objects.set(row.entityId,loaded);viewer.scene.add(loaded.group)
  if(initialPlaying!==undefined)viewer.setAnimationsPlaying(initialPlaying)
  const visual=await viewer.loadVisual(row,loaded);loaded.group.add(visual);viewer.trackAnimation(row.entityId,loaded)
  const displayedWall=visual.getObjectByName('Wall') as THREE.Mesh
  const advance=()=>{viewer.animationClock=performance.now()-50;viewer.advanceAnimations();displayedWall.updateWorldMatrix(true,false)}
  return {viewer,row,loaded,wall:displayedWall,sourceWall:wall,advance}
}

describe('静态物理reference显示与明确视觉动画',()=>{
  test('加载不评价clip t=0，原TRS/源轴米制/实例偏置与同源参考世界点一致',async()=>{
    const {viewer,loaded,wall,sourceWall,advance}=await harness()
    const before=wall.getWorldPosition(new THREE.Vector3()),reference=sourceWall.getWorldPosition(new THREE.Vector3())
    const expected=reference.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI/2)).multiplyScalar(.1).add(new THREE.Vector3(100,200,300))
    expect(before.distanceTo(expected)).toBeLessThan(1e-9);expect(wall.position.toArray()).toEqual([2,3,4])
    for(let i=0;i<10;i++)advance()
    expect(wall.getWorldPosition(new THREE.Vector3()).distanceTo(before)).toBeLessThan(1e-9);expect(wall.position.toArray()).toEqual([2,3,4])
    expect(viewer.animationSummary().staticReferences).toEqual([{entityId:'building-a',ownerEntityId:'building-a',verified:true,visualPreview:false,physicsSynchronized:false}])
    expect(loaded.lodWarnings.join('\n')).toContain('ANIMATION_STATIC_REFERENCE:')
    loaded.lodWarnings.push('LOD_LEVEL_FAILED: 其它显示警告');viewer.refreshVisualWarnings('building-a',loaded)
    expect(viewer.animationSummary().visualWarnings).toEqual([{entityId:'building-a',warning:loaded.lodWarnings.find((warning:string)=>warning.startsWith('ANIMATION_STATIC_REFERENCE:'))}])
  })
  test('默认播放初始化/effect不越过reference；明确视觉试播才改姿态并告警，暂停回源TRS',async()=>{
    const {viewer,wall,advance}=await harness()
    viewer.setAnimationsPlaying(true);advance();expect(wall.position.toArray()).toEqual([2,3,4])
    viewer.setAnimationsPlaying(true,{allowStaticReferencePreview:true});advance();expect(wall.position.x).toBeGreaterThan(20)
    expect(viewer.animationSummary().staticReferences[0]).toMatchObject({visualPreview:true,physicsSynchronized:false})
    expect(viewer.visualWarnings.get('building-a').join('\n')).toContain('静态碰撞未随动画更新')
    expect(viewer.animationSummary().visualWarnings[0].warning).toContain('ANIMATION_VISUAL_PREVIEW:')
    viewer.setAnimationsPlaying(true);advance();expect(viewer.animationSummary().staticReferences[0].visualPreview).toBe(true)
    viewer.setAnimationsPlaying(false);expect(wall.position.toArray()).toEqual([2,3,4]);expect(viewer.animationSummary().staticReferences[0].visualPreview).toBe(false)
  })
  test('显式试播后Scene重入回reference，旧UI默认true不能自动重播',async()=>{
    const {viewer,loaded,wall,advance}=await harness();viewer.setAnimationsPlaying(true,{allowStaticReferencePreview:true});advance();expect(wall.position.x).toBeGreaterThan(20)
    viewer.snapshot=structuredClone({...viewer.snapshot,revision:2});viewer.trackAnimation('building-a',loaded);viewer.setAnimationsPlaying(true);advance()
    expect(wall.position.toArray()).toEqual([2,3,4]);expect(viewer.animationSummary().staticReferences[0].visualPreview).toBe(false)
  })
  test('world/generation变化后重新登记回reference，不继承旧作用域的视觉试播',async()=>{
    const {viewer,loaded,wall,advance}=await harness();viewer.world={worldId:'a',worldGeneration:1,appliedSceneRevision:1,status:'ready'};viewer.trackAnimation('building-a',loaded)
    viewer.setAnimationsPlaying(true,{allowStaticReferencePreview:true});advance();expect(wall.position.x).toBeGreaterThan(20)
    viewer.world={...viewer.world,worldGeneration:2};viewer.trackAnimation('building-a',loaded);advance();expect(wall.position.toArray()).toEqual([2,3,4]);expect(viewer.animationSummary().staticReferences[0].visualPreview).toBe(false)
  })
  test('一般视觉动画保自动播放/暂停当前帧；之后真实静态绑定恢复源reference',async()=>{
    const {viewer,loaded,wall,advance}=await harness(false);advance();expect(wall.position.x).toBeGreaterThan(20);expect(viewer.animationSummary().staticReferences).toEqual([])
    viewer.setAnimationsPlaying(false);const paused=wall.position.clone();advance();expect(wall.position.distanceTo(paused)).toBeLessThan(1e-9)
    viewer.snapshot={...viewer.snapshot,revision:2,entities:[entity()]};viewer.trackAnimation('building-a',loaded);advance();expect(wall.position.toArray()).toEqual([2,3,4]);expect(viewer.animationSummary().staticReferences[0].verified).toBe(true)
  })
  test('播放偏好在模型尚未读完时设false，异步登记不能丢弃暂停；重复登记也不重播',async()=>{
    const {viewer,loaded,wall,advance}=await harness(false,false);viewer.trackAnimation('building-a',loaded);advance();expect(wall.position.toArray()).toEqual([2,3,4]);expect(viewer.mixers.get('building-a').paused).toBe(true)
    viewer.setAnimationsPlaying(true);advance();expect(wall.position.x).toBeGreaterThan(20)
  })
  test('旧缺reference/错轴单位/错资源版本只报告未验证，不读取latest或假称碰撞同步',async()=>{
    for(const changed of ['missing','axis','units','version'] as const){
      const {viewer,loaded,wall,advance}=await harness();const row=structuredClone(entity()),binding=row.components.physicsBinding as any
      if(changed==='missing')delete binding.sourceFrame
      if(changed==='axis')binding.sourceFrame.sourceUpAxis='Z'
      if(changed==='units')binding.sourceFrame.metersPerUnit=1
      if(changed==='version')binding.version=4
      viewer.snapshot={...viewer.snapshot,revision:2,entities:[row]};viewer.trackAnimation('building-a',loaded);advance()
      expect(wall.position.toArray()).toEqual([2,3,4]);expect(viewer.animationSummary().staticReferences[0].verified).toBe(false);expect(loaded.lodWarnings.join('\n')).toContain('ANIMATION_STATIC_REFERENCE_UNVERIFIED:')
    }
  })
})

describe('物理实例祖先、资源边界与机器人例外',()=>{
  test('GLTF叶取同资源实例祖先reference，另一资源同名节点不能冒充已验证',()=>{
    const root={...entity(),entityId:'root'},leaf={...entity(false),entityId:'leaf',parentId:'root'}
    let result=staticAnimationReference(leaf,new Map([[root.entityId,root],[leaf.entityId,leaf]]));expect(result).toMatchObject({ownerEntityId:'root',verified:true})
    leaf.resources[0]!.version=4;result=staticAnimationReference(leaf,new Map([[root.entityId,root],[leaf.entityId,leaf]]));expect(result?.verified).toBe(false)
  })
  test('RobotVisual/原生关节本体/普通动态动画不被全局关闭',()=>{
    for(const kind of ['robot','articulation','mujoco','isaac','newton','dynamic'] as const){
      const row=entity()
      if(kind==='robot')row.components.visual={kind:'robot'}
      else if(kind==='dynamic')row.components.rigidBody={type:'dynamic'}
      else row.components[kind]={}
      expect(staticAnimationReference(row,new Map([[row.entityId,row]]))).toBeUndefined()
    }
  })
  test('显式视觉修正偏置不能沿用源reference的等价声明，暴露准确未验证原因',()=>{
    const row=entity();row.components.visual!.sourceTransform={position:[3,4,5],quaternion:[0,0,0,1],scale:[1,1,1]}
    const result=staticAnimationReference(row,new Map([[row.entityId,row]]));expect(result?.verified).toBe(false);expect(result?.reason).toContain('显式视觉sourceTransform')
  })
})
