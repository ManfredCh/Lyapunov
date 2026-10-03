import {expect,test} from 'bun:test'
import {renderToStaticMarkup} from 'react-dom/server'
import {SCENE_COORDINATES,identityTransform,type Entity,type Frame,type SceneSnapshot,type WorldHandle} from '../../lyapunov-contracts/src/types.ts'
import {physicsOwnerOf,physicsSelectionIds,physicsFacts,currentPhysicsFrame,runPhysicsMutation,type PhysicsMutationPort,type PhysicsUpdateInput,type PhysicsBindInput,type PhysicsMutationReceipt} from '../src/entity-physics.ts'
import {PhysicsControls,physicsRecoveryOptions,type PhysicsRecoveryResource} from '../src/physics-controls.tsx'
import {SceneWorldStatus,sceneWorldPhaseLabel} from '../src/scene-world-status.tsx'
import {worldLifecycleState} from '../src/scene-world-lifecycle.ts'
import {WorldPhysicsPanel} from '../src/world-physics-panel.tsx'

const entity=(id:string,components:Entity['components']={},parentId?:string):Entity=>({entityId:id,name:id,resources:[],transform:identityTransform(),components,...parentId?{parentId}:{}})
const scene=():SceneSnapshot=>({sceneId:'s',revision:3,coordinates:SCENE_COORDINATES,entities:[entity('body',{visual:{kind:'group',visible:false},collision:{shape:'box',enabled:true},rigidBody:{type:'dynamic',massKg:2,gravityEnabled:false}}),entity('middle',{visual:{kind:'group'}},'body'),entity('leaf',{visual:{kind:'mesh'}},'middle'),entity('other')]})
const world=():WorldHandle=>({worldId:'w',sceneId:'s',engineId:'mujoco',engineVersion:'fixture',worldGeneration:4,appliedSceneRevision:3,status:'paused',clock:'realtime'})
const frame=(w=world()):Frame=>({worldId:w.worldId,generation:w.worldGeneration,sceneRevision:w.appliedSceneRevision,stepIndex:12,simTime:.12,frameId:'f',entities:[{entityId:'body',transform:identityTransform(),physics:{source:'mujoco-compiled',dynamic:true,massKg:2,gravityEnabled:false,collisionEnabled:true,colliderCount:2}} as any]})
const noop=async()=>{}
const render=(s=scene(),w:WorldHandle|undefined=world(),f:Frame|undefined=frame())=>renderToStaticMarkup(<PhysicsControls scene={s} selected="leaf" world={w} frame={f} tr={cn=>cn} update={noop} bind={noop} openLibrary={()=>{}}/>)

test('恢复初始化使用同版本请求与实例冻结用途/策略/预算，环境失败不改回dynamic或auto',()=>{
 const s=scene(),owner=s.entities[0]!
 owner.components={visual:{kind:'group'}}
 owner.resources=[{resourceId:'r',version:2,original:{uri:'file:///actual.glb',mimeType:'model/gltf-binary'},representations:[],source:{units:'m',upAxis:'Z',handedness:'right'}}]
 const resource:PhysicsRecoveryResource={ref:{resourceId:'r',version:2},physicalizationRequest:{usage:'environment',strategy:'triangle_mesh',voxelSizeM:.04,maxBoxes:3456,maxFaceVisits:12345},physicalization:{status:'failed',usage:'dynamic',strategy:'convex_hull',error:'旧终态'}}
 expect(physicsRecoveryOptions(owner,resource)).toEqual({usage:'environment',strategy:'triangle_mesh',voxelSizeM:.04,maxBoxes:3456,maxFaceVisits:12345})
 const html=renderToStaticMarkup(<PhysicsControls scene={s} selected="body" resource={resource} tr={cn=>cn} update={noop} bind={noop} openLibrary={()=>{}}/>)
 expect(html).toContain('value="environment" selected');expect(html).toContain('value="triangle_mesh" selected');expect(html).toContain('value="0.04"');expect(html).toContain('value="3456"')
 owner.components.physicsBinding={resourceId:'r',version:2,status:'BIND_REQUIRED',usage:'static',strategy:'coacd',maxBoxes:2222}
 expect(physicsRecoveryOptions(owner,resource)).toMatchObject({usage:'static',strategy:'coacd',maxBoxes:2222,maxFaceVisits:12345})
 expect(renderToStaticMarkup(<PhysicsControls scene={s} selected="body" resource={resource} tr={cn=>cn} update={noop} bind={noop} openLibrary={()=>{}}/>)).toContain('value="coacd" selected')
 owner.components.physicsBinding={resourceId:'other',version:2,status:'BIND_REQUIRED',usage:'static'}
 expect(physicsRecoveryOptions(owner,{...resource,ref:{resourceId:'r',version:1}})).toEqual({usage:'dynamic',strategy:'auto'})
 expect(physicsRecoveryOptions(owner,undefined,{status:'failed',usage:'environment',strategy:'voxel_boxes'})).toEqual({usage:'environment',strategy:'voxel_boxes'})
})

test('多层视觉叶投影同一物理owner，显隐不决定刚体/重力/碰撞声明',()=>{
 const s=scene();expect(physicsOwnerOf(s,'leaf')?.entityId).toBe('body');expect(physicsSelectionIds(s,'leaf')).toEqual(['body','middle','leaf'])
 const facts=physicsFacts(s,'leaf',world(),frame());expect(facts).toMatchObject({type:'dynamic',massKg:2,gravityEnabled:false,collisionEnabled:true,current:true})
 expect(facts.measured?.colliderCount).toBe(2)
 s.entities[0]!.components.visual={visible:true};expect(physicsFacts(s,'leaf',world(),frame()).measured).toEqual(facts.measured)
 expect(physicsSelectionIds(s,'other')).toEqual(['other'])
})
test('只有同Scene/world/gen/revision原生属性可读，拒绝缺revision/跨引擎/stale帧',()=>{
 const s=scene(),w=world(),f=frame()
 expect(currentPhysicsFrame(s,w,f)).toBe(true)
 for(const wrong of [{...f,worldId:'other'},{...f,generation:9},{...f,sceneRevision:2},{...f,sceneRevision:undefined}])expect(physicsFacts(s,'leaf',w,wrong).measured).toBeUndefined()
 expect(physicsFacts(s,'leaf',{...w,status:'unavailable'},f).measured).toBeUndefined()
 expect(physicsFacts(s,'leaf',{...w,engineId:'isaac'},f).measured).toBeUndefined()
 const old=render(s,w,{...f,sceneRevision:2});expect(old).toContain('等待同版本世界与物理帧');expect(old).not.toContain('2 个真实形状')
})
test('物理控件显示配置和同版本实测，固定保留质量，缺质量不创造1kg解除固定',()=>{
 const html=render();expect(html).toContain('所选节点属于物理实例');expect(html).toContain('固定物体');expect(html).toContain('启用物体重力');expect(html).toContain('启用物体碰撞');expect(html).toContain('当前引擎：');expect(html).toContain('step 12')
 const fixed=scene();fixed.entities[0]!.components.rigidBody={type:'static',massKg:2,gravityEnabled:false}
 expect(render(fixed)).toContain('固定时保留动态质量和重力配置')
 fixed.entities[0]!.components.rigidBody={type:'static'}
 const missing=render(fixed);expect(missing).toContain('data-physics-action="fixed" disabled=""');expect(missing).not.toContain('value="1"')
})
test('无world/无碰撞时已有实例直接提供用途与生成绑定入口，不等待模型或隐藏checkbox',()=>{
 const s=scene();s.entities[0]!.components={visual:{kind:'group'}};s.entities[0]!.resources=[{resourceId:'r',version:1,original:{uri:'fixture.glb',mimeType:'model/gltf-binary'},representations:[],source:{units:'m',upAxis:'Z',handedness:'right'}}]
 const html=renderToStaticMarkup(<PhysicsControls scene={s} selected="body" tr={cn=>cn} update={noop} bind={noop} openLibrary={()=>{}}/>)
 expect(html).toContain('碰撞绑定用途');expect(html).toContain('动态物体 · 受重力');expect(html).toContain('环境 · 静态表面');expect(html).toContain('生成并绑定真实碰撞');expect(html).toContain('尚未绑定物理')
})
test('原生机器人约束只读，不通过通用固定/质量控件重写本体',()=>{
 const s=scene();s.entities[0]!.components={visual:{kind:'robot'},mujoco:{sourcePath:'/fixture/model.xml'}}
 s.entities[2]!.components={visual:{kind:'mesh'},collision:{shape:'mesh'},rigidBody:{type:'dynamic',massKg:.3}}
 expect(physicsOwnerOf(s,'leaf')?.entityId).toBe('body')
 const html=render(s);expect(html).toContain('本体约束由原生模型定义');expect(html).not.toContain('data-physics-action="fixed"');expect(html).not.toContain('提交质量并同步')
})
test('初始化重叠以同版本引擎报告呈现，CLEAR不宣称后续永不穿模，旧版本不误显示',()=>{
 const f={...frame(),initialOverlap:{source:'mujoco-compiled',checkedAtStep:0,sceneRevision:3,status:'OVERLAP',pairs:[{geom1:'body/collider',geom2:'floor',depthM:.015}]}} as any
 expect(render(scene(),world(),f)).toContain('世界初始化检出 1 对实际重叠');expect(render(scene(),world(),f)).toContain('0.01500 m')
 f.initialOverlap.status='CLEAR';f.initialOverlap.pairs=[];expect(render(scene(),world(),f)).toContain('这次世界初始化检查未检出实际重叠')
 f.initialOverlap.sceneRevision=1;expect(render(scene(),world(),f)).not.toContain('physics-initial-overlap')
})
test('PhysX scene-query真实相交的null/UNKNOWN深度显示未知，不转换成0米测量',()=>{
 const w={...world(),engineId:'isaac'},f:Frame={...frame(w),initialOverlap:{source:'isaac-scene-query',checkedAtStep:0,sceneRevision:3,status:'OVERLAP',pairs:[{geom1:'body/collider',geom2:'other/collider',depthM:null,depthStatus:'UNKNOWN'}]}}
 const html=render(scene(),w,f)
 expect(html).toContain('世界初始化检出 1 对实际重叠');expect(html).toContain('深度未知');expect(html).toContain('role="alert"')
 expect(html).not.toContain('0.00000 m');expect(html).not.toContain('最大穿入');expect(html).not.toContain('NaN')
 f.initialOverlap!.pairs[0]!.depthM=0
 expect(render(scene(),w,f)).toContain('深度未知');expect(render(scene(),w,f)).not.toContain('0.00000 m')
})
test('混合已测与未知深度只报告已测对最大值，未知对不加入聚合',()=>{
 const w={...world(),engineId:'isaac'},f:Frame={...frame(w),initialOverlap:{source:'isaac-scene-query',checkedAtStep:0,sceneRevision:3,status:'OVERLAP',pairs:[{geom1:'body/a',geom2:'other/a',depthM:null,depthStatus:'UNKNOWN'},{geom1:'body/b',geom2:'other/b',depthM:.012}]}}
 const html=render(scene(),w,f)
 expect(html).toContain('2 对实际重叠');expect(html).toContain('已测对的最大穿入 0.01200 m');expect(html).toContain('其余 1 对深度未知')
})
test('scene-query的UNVERIFIED和CLEAR原样保留，不根据空pairs编零深度或提高状态',()=>{
 const w={...world(),engineId:'isaac'},f:Frame={...frame(w),initialOverlap:{source:'isaac-scene-query',checkedAtStep:0,sceneRevision:3,status:'UNVERIFIED',pairs:[],reason:'查询未确认自身collider'}}
 const unknown=render(scene(),w,f)
 expect(unknown).toContain('重叠状态尚未验证');expect(unknown).toContain('查询未确认自身collider');expect(unknown).not.toContain('未检出实际重叠');expect(unknown).not.toContain('0.00000 m')
 f.initialOverlap!.status='CLEAR';f.initialOverlap!.reason=undefined
 const clear=render(scene(),w,f)
 expect(clear).toContain('这次世界初始化检查未检出实际重叠');expect(clear).not.toContain('重叠状态尚未验证');expect(clear).not.toContain('0.00000 m')
})
test('scene-query仍要求同引擎和同world/gen/revision，旧Isaac contact来源兼容',()=>{
 const w={...world(),engineId:'isaac'},f:Frame={...frame(w),initialOverlap:{source:'isaac-scene-query',checkedAtStep:0,sceneRevision:3,status:'UNVERIFIED',pairs:[]}}
 expect(physicsFacts(scene(),'leaf',w,f).overlap?.source).toBe('isaac-scene-query')
 expect(render(scene(),world(),f)).not.toContain('physics-initial-overlap')
 expect(render(scene(),w,{...f,generation:5})).not.toContain('physics-initial-overlap')
 expect(render(scene(),w,{...f,initialOverlap:{...f.initialOverlap!,sceneRevision:2}})).not.toContain('physics-initial-overlap')
 f.initialOverlap!.source='isaac-contact-report'
 expect(physicsFacts(scene(),'leaf',w,f).overlap?.source).toBe('isaac-contact-report')
})
test('paused/ready/manual状态不因可操作或历史step号宣称running',()=>{
 const w=world();expect(worldLifecycleState(w,frame()).phase).toBe('paused')
 expect(worldLifecycleState({...w,status:'ready',clock:'manual'},frame()).phase).toBe('ready')
 expect(sceneWorldPhaseLabel('ready',cn=>cn)).toBe('物理世界就绪')
 const html=renderToStaticMarkup(<SceneWorldStatus state={worldLifecycleState(w,frame())} tr={cn=>cn} retry={()=>{}} cancel={()=>{}}/>);expect(html).toContain('物理世界已暂停');expect(html).not.toContain('运行中')
})
test('自由根准备说明只随当前暂停世界显示，明确被动继续和reset，不宣称站稳/自起身',()=>{
 const s=scene();s.entities[0]!.components={mujoco:{sourcePath:'/fixture/free.xml'},visual:{robot:{format:'mjcf',document:{worldbody:{body:{name:'pelvis',freejoint:''}}}}}}
 const w={...world(),supportsPause:true}
 const renderPanel=(bound:WorldHandle)=>renderToStaticMarkup(<WorldPhysicsPanel scene={s} world={bound} frame={frame(bound)} state={worldLifecycleState(bound)} worlds={[bound]} disabled={false} tr={cn=>cn} start={()=>{}} sync={()=>{}} pause={()=>{}} stop={()=>{}} close={()=>{}} prepare={()=>{}} saveGravity={()=>{}} selectWorld={()=>{}} cancel={()=>{}}/>)
 const html=renderPanel(w);expect(html).toContain('world-controller-preparation');expect(html).toContain('先完成配套初态与控制器准备');expect(html).toContain('再显式执行策略动作，才受控推进');expect(html).toContain('继续物理');expect(html).toContain('按真实重力运动');expect(html).toContain('倒地后先复位再初始化');expect(html).toContain('行走策略不等于自起身')
 expect(renderPanel({...w,status:'running'})).not.toContain('world-controller-preparation')
 expect(renderPanel({...w,appliedSceneRevision:2})).not.toContain('world-controller-preparation')
})

function mutationFixture(){
 let s=scene(),w:WorldHandle|undefined=world(),selected='leaf'
 const calls:Array<{name:string;input:any;selection?:any}>=[]
 const port:PhysicsMutationPort={scene:()=>s,world:()=>w,selected:()=>selected,
  command:async(name,input,selection)=>{calls.push({name,input,selection});return {status:'UPDATED',entityId:'body',worldNeedsSync:true,snapshot:{...s,revision:s.revision+1,entities:s.entities.map(e=>e.entityId==='body'?{...e,components:{...e.components,rigidBody:{...e.components.rigidBody,...'type' in input?{type:input.type}:{}}}}:e)}}},
  applyScene:value=>{s=value;calls.push({name:'apply',input:s.revision});return 'applied'},
  sync:async()=>{calls.push({name:'sync',input:s.revision});w={...w!,worldGeneration:w!.worldGeneration+1,appliedSceneRevision:s.revision};return w},
  start:async()=>{calls.push({name:'start',input:s.revision});return undefined},
  observe:async()=>frame(w),applyFrame:value=>{calls.push({name:'frame',input:{generation:value.generation,revision:value.sceneRevision}})}}
 const input:PhysicsUpdateInput={sceneId:'s',entityId:'body',expectedRevision:3,type:'static'}
 return {port,input,calls,setSelected:(value:string)=>{selected=value},setScene:(value:SceneSnapshot)=>{s=value},setWorld:(value:WorldHandle|undefined)=>{w=value}}
}
test('按钮走一次精确CAS命令，采用新Scene后同步最新rev并核首帧；不发scene_edit或visual.visible',async()=>{
 const x=mutationFixture(),result=await runPhysicsMutation('scene_physics_update',x.input,x.port)
 expect(result).toMatchObject({synced:true,stale:false});expect(x.calls.map(c=>c.name)).toEqual(['scene_physics_update','apply','sync','frame'])
 expect(x.calls[0]).toEqual({name:'scene_physics_update',input:x.input,selection:{sceneId:'s',worldId:'w'}});expect(x.calls[2]?.input).toBe(4);expect(x.calls[3]?.input).toEqual({generation:5,revision:4})
})
test('过期质量草稿与操作期间切选择均不能向当前新世界续发同步',async()=>{
 const old=mutationFixture();old.setScene({...scene(),revision:5});await expect(runPhysicsMutation('scene_physics_update',old.input,old.port)).rejects.toThrow('SCENE_REVISION_MISMATCH');expect(old.calls).toEqual([])
 const moved=mutationFixture(),command=moved.port.command;moved.port.command=async(...args)=>{const receipt=await command(...args);moved.setSelected('other');return receipt}
 expect(await runPhysicsMutation('scene_physics_update',moved.input,moved.port)).toMatchObject({synced:false,stale:true});expect(moved.calls.map(c=>c.name)).toEqual(['scene_physics_update'])
})
test('同步后的错误代次/版本不显示成功；无world未启动则明确保存但未同步',async()=>{
 const wrong=mutationFixture();wrong.port.observe=async()=>({...frame(),sceneRevision:3});await expect(runPhysicsMutation('scene_physics_update',wrong.input,wrong.port)).rejects.toThrow('PHYSICS_FRAME_UNSYNCED');expect(wrong.calls.some(c=>c.name==='frame')).toBe(false)
 const missing=mutationFixture();missing.setWorld(undefined);expect(await runPhysicsMutation('scene_physics_update',missing.input,missing.port)).toMatchObject({synced:false,stale:false});expect(missing.calls.map(c=>c.name)).toEqual(['scene_physics_update','apply','start'])
})
test('CAS回执被更高Scene版本取代时不恢复旧快照，不把本次物理修改标同步',async()=>{
 const x=mutationFixture();x.port.applyScene=()=>{x.calls.push({name:'superseded',input:undefined});return 'superseded'}
 expect(await runPhysicsMutation('scene_physics_update',x.input,x.port)).toMatchObject({synced:false,stale:true});expect(x.calls.map(c=>c.name)).toEqual(['scene_physics_update','superseded'])
})
test('视觉实例绑定用途按原请求发送，首帧前换world不把配置投到新world',async()=>{
 const x=mutationFixture();const input:PhysicsBindInput={sceneId:'s',entityId:'body',expectedRevision:3,usage:'environment'}
 await runPhysicsMutation('scene_bind_physics',input,x.port);expect(x.calls[0]?.input).toEqual(input)
 const changed=mutationFixture(),observe=changed.port.observe;changed.port.observe=async id=>{const value=await observe(id);changed.setWorld({...world(),worldId:'other'});return value}
 expect(await runPhysicsMutation('scene_physics_update',changed.input,changed.port)).toMatchObject({synced:false,stale:true});expect(changed.calls.some(c=>c.name==='frame')).toBe(false)
})
