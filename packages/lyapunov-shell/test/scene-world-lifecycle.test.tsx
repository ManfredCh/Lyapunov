import {expect,test} from 'bun:test'
import {renderToStaticMarkup} from 'react-dom/server'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SceneOperations} from '../../scene-kit/src/operations.ts'
import {solidGlb,box} from '../../scene-kit/test/glb-geometry-fixture.ts'
import {SceneWorldLifecycle,sceneRequestsPhysics,sceneWorldWithoutProvider,sceneWorldPreflight,worldLifecycleState,measuredJointTargets,type SceneWorldPort,type SceneWorldState} from '../src/scene-world-lifecycle.ts'
import {SceneWorldStatus} from '../src/scene-world-status.tsx'
import {ISAAC_SDK_UNAVAILABLE_PUBLIC_MESSAGE} from '../../lyapunov-contracts/src/command-privacy.ts'
import type {SceneSnapshot,WorldHandle,Frame} from '../../lyapunov-contracts/src/types.ts'
const scene=(id='s'):SceneSnapshot=>({sceneId:id,revision:0,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[{entityId:'robot',name:'arm',resources:[],components:{mujoco:{sourcePath:'/fixture/robot.xml'}},transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]}}]})
const world=(id='w',s='s'):WorldHandle=>({worldId:id,sceneId:s,engineId:'mujoco',engineVersion:'fixture',worldGeneration:1,appliedSceneRevision:0,status:'ready',clock:'realtime'})
const frame=(w:WorldHandle):Frame=>({worldId:w.worldId,generation:w.worldGeneration,sceneRevision:w.appliedSceneRevision,frameId:'f',stepIndex:2,simTime:.004,entities:[],worldStatus:'running'})
const port=(calls:string[],w=world()):SceneWorldPort=>({list:async()=>{calls.push('list');return []},open:async()=>{calls.push('open');return w},observe:async()=>{calls.push('observe');return frame(w)},close:async()=>{calls.push('close')}})
const freeRootScene=()=>{const s=scene();s.entities[0]!.components.visual={robot:{format:'mjcf',document:{worldbody:{body:{name:'root',freejoint:''}}}}};return s}
test('自动导入真实自由根先原子准备，第0帧已暂停；显式被动启动仍实时推进',async()=>{
 const s=freeRootScene(),states:SceneWorldState[]=[],calls:string[]=[],prepared={...world(),status:'paused' as const,supportsPause:true},p=port(calls,prepared)
 p.open=async(snapshot,signal,options)=>{expect(snapshot).toEqual(s);expect(signal.aborted).toBe(false);expect(options).toEqual({startPaused:true});calls.push('open-paused');return prepared}
 p.observe=async()=>({...frame(prepared),stepIndex:0,simTime:0,worldStatus:'paused'})
 expect(await new SceneWorldLifecycle(state=>states.push(state)).ensure('a','h',s,p)).toEqual(prepared)
 expect(calls).toEqual(['list','open-paused']);expect(states.at(-1)?.phase).toBe('paused')
 const passive=port([],world());passive.open=async(_snapshot,_signal,options)=>{expect(options).toBeUndefined();return world()}
 await new SceneWorldLifecycle(state=>states.push(state)).ensure('a','h',s,passive,true)
 expect(states.at(-1)?.phase).toBe('running')
})
test('准备世界首帧已推进或暂停ACK与原生帧不一致时拒绝并关闭自有world',async()=>{
 for(const f of [{stepIndex:2,simTime:.004,worldStatus:'paused' as const},{stepIndex:0,simTime:0,worldStatus:'running' as const}]){
  const states:SceneWorldState[]=[],calls:string[]=[],w={...world(),status:'paused' as const,supportsPause:true},p=port(calls,w)
  p.observe=async()=>({...frame(w),...f})
  expect(await new SceneWorldLifecycle(state=>states.push(state)).ensure('a','h',freeRootScene(),p)).toBeUndefined()
  expect(states.at(-1)?.code).toBe('WORLD_PREPARATION_NOT_PAUSED');expect(calls).toContain('close')
 }
})
test('自动同步自由根前暂停原代次owner，同world重建后保持暂停；显式被动同步保原默认',async()=>{
 const s={...freeRootScene(),revision:1},calls:string[]=[],states:SceneWorldState[]=[],before={...world(),status:'running' as const,supportsPause:true},after={...before,status:'paused' as const,worldGeneration:2,appliedSceneRevision:1},p=port(calls)
 p.list=async()=>[before];p.setPaused=async(bound,paused,signal)=>{expect(bound).toEqual(before);expect(paused).toBe(true);expect(signal.aborted).toBe(false);calls.push('pause:g1');return {...before,status:'paused'}}
 p.sync=async(snapshot,bound)=>{expect(snapshot).toEqual(s);expect(bound.worldGeneration).toBe(1);expect(bound.status).toBe('paused');calls.push('sync');return after};p.observe=async()=>{calls.push('observe');return {...frame(after),stepIndex:0,simTime:0,worldStatus:'paused'}}
 expect(await new SceneWorldLifecycle(state=>states.push(state)).ensure('a','h',s,p)).toEqual(after)
 expect(calls).toEqual(['pause:g1','sync','observe']);expect(states.at(-1)?.phase).toBe('paused')
 calls.length=0;p.sync=async()=>{calls.push('sync');return {...after,status:'ready'}};p.observe=async()=>frame({...after,status:'ready'})
 await new SceneWorldLifecycle(state=>states.push(state)).ensure('a','h',s,p,true)
 expect(calls).toEqual(['sync']);expect(states.at(-1)?.phase).toBe('running')
})
test('自动同步暂停拒绝/代次不符/取消均不装入自由根，不关闭用户既有world',async()=>{
 for(const mode of ['unsupported','stale','cancel'] as const){
  const s={...freeRootScene(),revision:1},calls:string[]=[],states:SceneWorldState[]=[],before={...world(),supportsPause:mode!=='unsupported'},p=port(calls),lifecycle=new SceneWorldLifecycle(state=>states.push(state))
  p.list=async()=>[before];p.sync=async()=>{calls.push('sync');return before};p.setPaused=async()=>{if(mode==='cancel')lifecycle.cancel();return {...before,status:'paused',worldGeneration:mode==='stale'?2:1}}
  expect(await lifecycle.ensure('a','h',s,p)).toBeUndefined();expect(calls).not.toContain('sync');expect(calls).not.toContain('close')
  if(mode!=='cancel')expect(states.at(-1)?.code).toBe(mode==='unsupported'?'CLOCK_CONTROL_UNSUPPORTED':'WORLD_PREPARATION_PAUSE_MISMATCH')
 }
})
test('首次默认建立/首帧确认；相同轮询不重复创建，已有世界真实恢复',async()=>{
 const states:SceneWorldState[]=[],calls:string[]=[],lifecycle=new SceneWorldLifecycle(s=>states.push(s)),p=port(calls)
 expect(await lifecycle.ensure('a','host',scene(),p)).toEqual(world())
 expect(states.map(s=>s.phase)).toEqual(['initializing','running'])
 await lifecycle.ensure('a','host',scene(),p);expect(calls).toEqual(['list','open','observe'])
 const restored:string[]=[],second=new SceneWorldLifecycle(s=>states.push(s)),reuse=port(restored);reuse.list=async()=>[world()]
 await second.ensure('a','host',scene(),reuse);expect(restored).toEqual(['observe'])
})
test('两会话/重启Host拥有各自尝试，不复用旧句柄',async()=>{
 const calls:string[]=[],lifecycle=new SceneWorldLifecycle(()=>{}),p=port(calls)
 await lifecycle.ensure('a','h1',scene(),p);await lifecycle.ensure('b','h1',scene(),p);await lifecycle.ensure('b','h2',scene(),p)
 expect(calls.filter(c=>c==='open')).toHaveLength(3)
})
test('真实失败一次呈现，轮询不loop，显式重试才再执行',async()=>{
 const states:SceneWorldState[]=[],calls:string[]=[],lifecycle=new SceneWorldLifecycle(s=>states.push(s)),p=port(calls)
 p.open=async()=>{calls.push('open');throw Error('SDK_RUNTIME_MISSING: fixture')}
 await lifecycle.ensure('a','h',scene(),p);await lifecycle.ensure('a','h',scene(),p)
 expect(calls.filter(c=>c==='open')).toHaveLength(1);expect(states.at(-1)?.code).toBe('SDK_RUNTIME_MISSING')
 await lifecycle.ensure('a','h',scene(),p,true);expect(calls.filter(c=>c==='open')).toHaveLength(2)
})
test('CAS修复后的新Scene版本不把旧世界/旧物理帧标running，必须明确同步',async()=>{
 const states:SceneWorldState[]=[],calls:string[]=[],lifecycle=new SceneWorldLifecycle(s=>states.push(s)),p=port(calls),updated={...scene(),revision:1}
 p.list=async()=>[world()]
 const bound=await lifecycle.ensure('a','h',updated,p)
 expect(states.at(-1)?.phase).toBe('unsynced');expect(states.at(-1)?.code).toBe('WORLD_SCENE_UNSYNCED');expect(bound?.status).toBe('unsynced');expect(calls).not.toContain('open')
})
test('已有世界从rev21自动同步到Scene30，真实首帧确认后复用同world并恢复运行',async()=>{
 const states:SceneWorldState[]=[],calls:string[]=[],before={...world(),appliedSceneRevision:21},after={...before,worldGeneration:2,appliedSceneRevision:30},updated={...scene(),revision:30}
 const lifecycle=new SceneWorldLifecycle(s=>states.push(s)),p=port(calls)
 p.list=async()=>[before];p.sync=async(snapshot,bound,signal)=>{expect(snapshot.revision).toBe(30);expect(bound).toEqual(before);expect(signal.aborted).toBe(false);calls.push('sync');return after};p.observe=async()=>{calls.push('observe');return frame(after)}
 expect(await lifecycle.ensure('a','h',updated,p)).toEqual(after)
 expect(calls).toEqual(['sync','observe']);expect(states.map(s=>s.phase)).toEqual(['syncing','running']);expect(states.at(-1)?.sceneRevision).toBe(30)
})
test('同步在途有更新revision时取消旧回写，不关闭用户既有world或用旧代次恢复控制',async()=>{
 const states:SceneWorldState[]=[],closed:string[]=[],before={...world(),appliedSceneRevision:21},resolvers=new Map<number,(w:WorldHandle)=>void>(),signals:AbortSignal[]=[]
 const lifecycle=new SceneWorldLifecycle(s=>states.push(s)),p=port([])
 p.list=async()=>[before];p.sync=async(snapshot,_bound,signal)=>{signals.push(signal);return await new Promise<WorldHandle>(resolve=>resolvers.set(snapshot.revision,resolve))};p.observe=async()=>frame({...world(),worldGeneration:3,appliedSceneRevision:31});p.close=async id=>closed.push(id)
 const old=lifecycle.ensure('a','h',{...scene(),revision:30},p);await Bun.sleep(0)
 const fresh=lifecycle.ensure('a','h',{...scene(),revision:31},p);await Bun.sleep(0);expect(signals[0]!.aborted).toBe(true)
 resolvers.get(31)!({...world(),worldGeneration:3,appliedSceneRevision:31});expect((await fresh)?.appliedSceneRevision).toBe(31)
 resolvers.get(30)!({...world(),worldGeneration:2,appliedSceneRevision:30});expect(await old).toBeUndefined();expect(closed).toEqual([])
 expect(states.filter(s=>s.phase==='running').map(s=>s.sceneRevision)).toEqual([31])
})
test('同步失败保留现有世界并返回具体原因，不另建世界或关闭已有owner',async()=>{
 const states:SceneWorldState[]=[],calls:string[]=[],lifecycle=new SceneWorldLifecycle(s=>states.push(s)),p=port(calls)
 p.list=async()=>[{...world(),appliedSceneRevision:21}];p.sync=async()=>{throw Error('COMPILE_FAILED: fixture native model')}
 expect(await lifecycle.ensure('a','h',{...scene(),revision:30},p)).toBeUndefined();expect(calls).toEqual([])
 expect(states.at(-1)?.code).toBe('COMPILE_FAILED');expect(states.at(-1)?.detail).toContain('fixture native model')
})
test('初始化可取消，迟到自有world被关闭且不会写回当前选择',async()=>{
 const states:SceneWorldState[]=[],calls:string[]=[],lifecycle=new SceneWorldLifecycle(s=>states.push(s)),p=port(calls)
 let resolveOpen!:(value:WorldHandle)=>void;p.open=async(_s,signal)=>{calls.push('open');expect(signal.aborted).toBe(false);return await new Promise<WorldHandle>(r=>resolveOpen=r)}
 const pending=lifecycle.ensure('a','h',scene(),p);await Bun.sleep(0);lifecycle.cancel();resolveOpen(world());expect(await pending).toBeUndefined()
 expect(calls).toEqual(['list','open','close']);await lifecycle.ensure('a','h',scene(),p);expect(calls.filter(c=>c==='open')).toHaveLength(1);expect(states.at(-1)?.phase).toBe('closed')
})
test('A08 初始化中切revision等旧自有world真实关闭后才开始下一open',async()=>{
 const states:SceneWorldState[]=[],calls:string[]=[],lifecycle=new SceneWorldLifecycle(state=>states.push(state)),p=port(calls),after={...world('new'),appliedSceneRevision:1}
 let resolveOld!:(w:WorldHandle)=>void,resolveClose!:()=>void,oldSignal!:AbortSignal
 p.open=async(snapshot,signal)=>{calls.push('open:'+snapshot.revision);if(snapshot.revision===1)return after;oldSignal=signal;return await new Promise<WorldHandle>(resolve=>resolveOld=resolve)}
 p.close=async id=>{calls.push('close:'+id);await new Promise<void>(resolve=>resolveClose=resolve)};p.observe=async()=>frame(after)
 const old=lifecycle.ensure('a','h',scene(),p);await Bun.sleep(0)
 const fresh=lifecycle.ensure('a','h',{...scene(),revision:1},p);await Bun.sleep(0);expect(oldSignal.aborted).toBe(true);expect(calls.filter(s=>s.startsWith('open'))).toEqual(['open:0'])
 resolveOld(world('old'));await Bun.sleep(0);expect(calls).toContain('close:old');expect(calls).not.toContain('open:1')
 resolveClose();expect(await old).toBeUndefined();expect(await fresh).toEqual(after)
 expect(calls.indexOf('close:old')).toBeLessThan(calls.indexOf('open:1'));expect(states.filter(s=>s.phase==='running').map(s=>s.worldId)).toEqual(['new'])
})
test('A08 旧自有初始化world未确认关闭时阻止后继open，不吞收尾失败',async()=>{
 const states:SceneWorldState[]=[],calls:string[]=[],lifecycle=new SceneWorldLifecycle(state=>states.push(state)),p=port(calls)
 let resolveOld!:(w:WorldHandle)=>void
 p.open=async snapshot=>{calls.push('open:'+snapshot.revision);return await new Promise<WorldHandle>(resolve=>resolveOld=resolve)}
 p.close=async()=>{throw Error('fixture-owned-worker-still-alive')}
 const old=lifecycle.ensure('a','h',scene(),p),oldFailure=old.catch(error=>String(error));await Bun.sleep(0)
 const fresh=lifecycle.ensure('a','h',{...scene(),revision:1},p);resolveOld(world('old'))
 expect(await oldFailure).toContain('WORLD_START_CLEANUP_FAILED');expect(await fresh).toBeUndefined();expect(calls.filter(s=>s.startsWith('open'))).toEqual(['open:0'])
 expect(states.at(-1)?.code).toBe('WORLD_START_CLEANUP_FAILED')
})
test('源坐标缺项仍物理blocked，纯视觉显示保持idle、不猜碰撞或启动worker',async()=>{
 const missing=scene();missing.entities[0]!.resources=[{resourceId:'r',version:1,original:{uri:'/fixture',mimeType:'x'},representations:[]} as any]
 expect(sceneWorldPreflight(missing)?.code).toBe('SCENE_RESOURCE_SOURCE_REQUIRED')
 const visual=scene();visual.entities[0]!.components={};expect(sceneWorldPreflight(visual)?.code).toBe('SCENE_PHYSICS_REQUIRED')
 const states:SceneWorldState[]=[],calls:string[]=[],lifecycle=new SceneWorldLifecycle(s=>states.push(s));await lifecycle.ensure('a','h',visual,port(calls));expect(calls).toEqual(['list']);expect(states.at(-1)?.phase).toBe('idle')
})
test('多个世界不猜，代次错误关闭自有world；手调缺实测不生成零目标',async()=>{
 const states:SceneWorldState[]=[],calls:string[]=[],lifecycle=new SceneWorldLifecycle(s=>states.push(s)),p=port(calls)
 p.list=async()=>[world(),world('other')];await lifecycle.ensure('a','h',scene(),p);expect(states.at(-1)?.code).toBe('WORLD_SELECTION_REQUIRED')
 p.list=async()=>[];p.observe=async()=>({...frame(world()),generation:8});await lifecycle.ensure('a','h',scene(),p,true);expect(states.at(-1)?.code).toBe('STALE_WORLD_GENERATION');expect(calls).toContain('close')
 const d:any={controlledJointNames:['j']};expect(()=>measuredJointTargets(d,frame(world()),'robot')).toThrow('ROBOT_JOINT_OBSERVATION_REQUIRED')
 expect(measuredJointTargets(d,{...frame(world()),entities:[{entityId:'robot',transform:scene().entities[0]!.transform,joints:{names:['j'],positions:[.75],velocities:[0]}}]},'robot')).toEqual({j:.75})
})
test('初始化/失败状态可见且有明确取消/重试按钮，不依赖模型',()=>{
 const noop=()=>{},html=renderToStaticMarkup(<SceneWorldStatus state={{phase:'initializing'}} tr={cn=>cn} retry={noop} cancel={noop}/>)
 expect(html).toContain('取消初始化');expect(html).toContain('data-world-phase="initializing"')
 expect(renderToStaticMarkup(<SceneWorldStatus state={{phase:'failed',code:'PROVIDER_START_FAILED',detail:'fixture'}} tr={cn=>cn} retry={noop} cancel={noop}/>)).toContain('重新启动物理世界')
})
test('A08 blank/camera-only不冷起SDK；旧世界删除全部collider仍可清空装配',async()=>{
 const blank={...scene(),entities:[]},states:SceneWorldState[]=[],calls:string[]=[],lifecycle=new SceneWorldLifecycle(s=>states.push(s)),p=port(calls)
 p.reconcile=async()=>{calls.push('reconcile');throw Error('空白不应请求修复')}
 await lifecycle.ensure('blank','h',blank,p);expect(calls).toEqual(['list']);expect(states.at(-1)?.phase).toBe('idle')
 const camera={...scene('camera'),entities:[{...scene().entities[0]!,components:{camera:{fovYDeg:55}}}]}
 await lifecycle.ensure('camera','h',camera,p);expect(calls.filter(x=>x==='open')).toHaveLength(0)
 expect(calls).not.toContain('reconcile')
 const empty={...blank,revision:1},before=world(),after={...before,appliedSceneRevision:1,worldGeneration:2}
 const clear=new SceneWorldLifecycle(s=>states.push(s)),syncPort=port(calls);syncPort.list=async()=>[before];syncPort.sync=async s=>{expect(s.entities).toEqual([]);calls.push('sync-empty');return after};syncPort.observe=async()=>frame(after)
 expect(await clear.ensure('clear','h',empty,syncPort)).toEqual(after);expect(calls).toContain('sync-empty')
})
test('A08 原生状态优先，旧step计数不把ready/manual/paused都说成running',()=>{
 const ready={...world(),clock:'manual' as const},sample={...frame(ready),worldStatus:undefined}
 expect(worldLifecycleState(ready,sample).phase).toBe('ready')
 expect(worldLifecycleState({...world(),status:'paused'},sample).phase).toBe('paused')
 expect(worldLifecycleState(world(),{...frame(world()),worldStatus:'paused'}).phase).toBe('paused')
 expect(worldLifecycleState(world(),{...frame(world()),generation:999,worldStatus:'paused'}).phase).toBe('ready')
})
test('A08 Resource回收的新revision在同一生命周期采用，不以旧版创建world',async()=>{
 const states:SceneWorldState[]=[],calls:string[]=[],lifecycle=new SceneWorldLifecycle(s=>states.push(s)),prepared={...scene(),revision:2},after={...world(),appliedSceneRevision:2},p=port(calls)
 p.reconcile=async original=>{expect(original.revision).toBe(0);return {snapshot:prepared,pending:false,issues:[]}}
 p.acceptScene=accepted=>{expect(accepted.revision).toBe(2);calls.push('accept-new-revision')}
 p.open=async target=>{expect(target.revision).toBe(2);calls.push('open');return after};p.observe=async()=>frame(after)
 expect((await lifecycle.ensure('a','h',scene(),p))?.appliedSceneRevision).toBe(2)
 expect(calls.indexOf('accept-new-revision')).toBeLessThan(calls.indexOf('open'))
})
test('A08 待派生/失败来源采用CAS新文档，禁止新建与把旧碰撞sync给world',async()=>{
 for(const pending of [true,false])for(const existing of [false,true]){
  const states:SceneWorldState[]=[],calls:string[]=[],prepared={...scene(),revision:2},lifecycle=new SceneWorldLifecycle(state=>states.push(state)),p=port(calls)
  p.reconcile=async()=>({snapshot:prepared,pending,issues:pending?[]:[{entityId:'robot',resourceId:'r',version:2,reason:'派生失败，原件保持'}]})
  p.acceptScene=snapshot=>{expect(snapshot.revision).toBe(2);calls.push('accept-new-revision')}
  p.list=async()=>{calls.push('list');return existing?[world()]:[]};p.sync=async()=>{calls.push('sync');return world()}
  const result=await lifecycle.ensure('a','h',scene(),p)
  expect(calls).toEqual(['accept-new-revision','list']);expect(states.at(-1)?.phase).toBe(existing?'unsynced':'blocked')
  expect(states.at(-1)?.code).toBe(pending?'SCENE_PHYSICS_PENDING':'SCENE_PHYSICS_NOT_READY')
  expect(result?.status).toBe(existing?'unsynced':undefined);expect(states.at(-1)?.sceneRevision).toBe(2)
 }
})
test('A08 物理卡隐藏单worldselector并显示manual/paused及真实重力',async()=>{
 const {WorldPhysicsPanel}=await import('../src/world-physics-panel.tsx'),noop=()=>{},w={...world(),clock:'manual' as const,supportsPause:true},f={...frame(w),worldStatus:'ready' as const,worldPhysics:{gravityWorldMps2:[0,0,-3]as [number,number,number],gravityEnabled:true,units:'m/s^2' as const,source:'mujoco-model' as const,groundSources:[],collisionCoverage:{status:'PARTIAL' as const,physicalEntityIds:['ground'],visualOnlyEntityIds:['visual']}}}
 const props={scene:scene(),world:w,frame:f,state:worldLifecycleState(w,f),worlds:[w],disabled:false,tr:(cn:string)=>cn,start:noop,sync:noop,pause:noop,stop:noop,close:noop,prepare:noop,saveGravity:noop,selectWorld:noop,cancel:noop}
 const html=renderToStaticMarkup(<WorldPhysicsPanel {...props}/>)
 expect(html).toContain('手动时钟');expect(html).toContain('[0, 0, -3]');expect(html).toContain('部分实例还没有碰撞');expect(html).not.toContain('运行世界选择')
 expect(renderToStaticMarkup(<WorldPhysicsPanel {...props} worlds={[w,world('other')]}/>)).toContain('运行世界选择')
 expect(html.split('<details')[0]).toContain('来自物理帧 step 2 · rev 0 · g1')
 const stale=renderToStaticMarkup(<WorldPhysicsPanel {...props} world={{...w,status:'unavailable',worldPhysics:f.worldPhysics}} frame={{...f,generation:999}} state={{phase:'failed'}}/>).split('<details')[0]!
 expect(stale).toContain('上次世界重力读回（当前世界不可用）');expect(stale).toContain('来自世界句柄 rev 0 · g1');expect(stale).not.toContain('g999')
})
test('A08 compact阻断原因不需展开详情即可见，原始长详情仍独立保留',()=>{
 const html=renderToStaticMarkup(<SceneWorldStatus compact state={{phase:'blocked',code:'SCENE_PHYSICS_NOT_READY',detail:'当前原件尚未派生\n长详情'}} tr={cn=>cn} retry={()=>{}} cancel={()=>{}}/>)
 expect(html).toContain('SCENE_PHYSICS_NOT_READY');expect(html).toContain('当前原件尚未派生');expect(html).not.toContain('<pre>');expect(html).toContain('查看详情')
 // Isaac 缺 SDK：公开投影（P500 固定句）按界面语言显示——中文设置显示中文、英文设置显示英文，
 // 不堆中英混排，也不把原始解释器路径带到公共状态。
 const isaac={phase:'failed' as const,code:'P500',detail:`P500: ${ISAAC_SDK_UNAVAILABLE_PUBLIC_MESSAGE}`}
 const zh=renderToStaticMarkup(<SceneWorldStatus compact state={isaac} tr={cn=>cn} retry={()=>{}} cancel={()=>{}}/>)
 expect(zh).toContain(ISAAC_SDK_UNAVAILABLE_PUBLIC_MESSAGE)
 expect(zh).not.toContain('The selected Isaac SDK')
 const en=renderToStaticMarkup(<SceneWorldStatus compact state={isaac} tr={(_cn,en)=>en} retry={()=>{}} cancel={()=>{}}/>)
 expect(en).toContain('The selected Isaac SDK is unavailable')
 expect(en).not.toContain('当前选择的 Isaac SDK')
 expect(en).not.toContain('/home/')
})


test('纯视觉GLB显式跳过物理化后选择显示，不reconcile/prepare/open也不提升真实Scene版本',async()=>{
 const root=await mkdtemp(join(tmpdir(),'visual-scene-no-world-'))
 try{
  const operations=new SceneOperations(join(root,'data')),initial=await operations.create({sceneId:'visual',template:'blank'}),path=join(root,'visual.glb')
  await writeFile(path,solidGlb({generator:'visual-only-fixture',nodes:[{name:'visible-box',mesh:box()}]}))
  const imported=await operations.import({path,sceneId:initial.sceneId,physicalizationRequest:false}),displayed=imported.snapshot!
  expect(imported.resource.physicalizationRequest).toBe(false);expect(displayed.entities.length).toBeGreaterThan(0)
  const states:SceneWorldState[]=[],calls:string[]=[],lifecycle=new SceneWorldLifecycle(state=>states.push(state)),p=port(calls)
  p.reconcile=async(snapshot,signal)=>{calls.push('reconcile');return operations.reconcilePhysics({sceneId:snapshot.sceneId,expectedRevision:snapshot.revision,waitForPending:true},signal)}
  p.prepareWorld=async(snapshot)=>{calls.push('prepare');return operations.prepareWorld({sceneId:snapshot.sceneId,expectedRevision:snapshot.revision})}
  p.open=async(snapshot)=>{calls.push('open');return {...world('visual-world',snapshot.sceneId),appliedSceneRevision:snapshot.revision}}
  p.observe=async()=>{calls.push('observe');return frame({...world('visual-world',displayed.sceneId),appliedSceneRevision:(await operations.scene.snapshot(displayed.sceneId)).revision})}
  expect(await lifecycle.ensure('owner','host',displayed,p)).toBeUndefined()
  expect(calls).toEqual(['list']);expect(states.at(-1)).toMatchObject({phase:'idle',sceneId:displayed.sceneId,sceneRevision:displayed.revision})
  expect(await operations.scene.snapshot(displayed.sceneId)).toEqual(displayed)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('无template的legacy视觉资源与相机仅显示；不向修复/世界准备端口发送请求',async()=>{
 const states:SceneWorldState[]=[],calls:string[]=[],lifecycle=new SceneWorldLifecycle(state=>states.push(state)),s=scene('legacy-visual'),p=port(calls)
 s.entities[0]!.components={visual:{kind:'mesh'}}
 s.entities[0]!.resources=[{resourceId:'visual',version:1,original:{uri:'file:///fixture/visual.glb',mimeType:'model/gltf-binary'},representations:[],source:{units:'m',upAxis:'Z',handedness:'right'}}]
 p.reconcile=async()=>{calls.push('reconcile');throw Error('VISUAL_RECONCILE_UNEXPECTED')};p.prepareWorld=async()=>{calls.push('prepare');throw Error('VISUAL_PREPARE_UNEXPECTED')}
 expect(await lifecycle.ensure('owner','host',s,p)).toBeUndefined();expect(calls).toEqual(['list']);expect(states.at(-1)?.phase).toBe('idle')
})

test('用户明确Start才将纯视觉blank准备为物理工作区并以实际CAS版本创建world',async()=>{
 const root=await mkdtemp(join(tmpdir(),'visual-scene-explicit-start-'))
 try{
  const operations=new SceneOperations(join(root,'data')),s=await operations.create({sceneId:'visual',template:'blank'}),path=join(root,'visual.glb')
  await writeFile(path,solidGlb({generator:'explicit-start-fixture',nodes:[{name:'visible-box',mesh:box()}]}))
  const displayed=(await operations.import({path,sceneId:s.sceneId,physicalizationRequest:false})).snapshot!,calls:string[]=[],states:SceneWorldState[]=[],p=port(calls)
  let opened:WorldHandle|undefined
  p.reconcile=async(snapshot,signal)=>{calls.push('reconcile');return operations.reconcilePhysics({sceneId:snapshot.sceneId,expectedRevision:snapshot.revision,waitForPending:true},signal)}
  p.prepareWorld=async(snapshot)=>{calls.push('prepare');return operations.prepareWorld({sceneId:snapshot.sceneId,expectedRevision:snapshot.revision})}
  p.acceptScene=snapshot=>{calls.push('accept');expect(snapshot.physics?.template).toBe('physics-workspace-v2')}
  p.open=async(snapshot)=>{calls.push('open');opened={...world('visual-world',snapshot.sceneId),appliedSceneRevision:snapshot.revision};return opened}
  p.observe=async()=>{calls.push('observe');return frame(opened!)}
  const result=await new SceneWorldLifecycle(state=>states.push(state)).ensure('owner','host',displayed,p,true)
  expect(calls).toEqual(['reconcile','list','prepare','accept','open','observe']);expect(result?.appliedSceneRevision).toBe(displayed.revision+1)
  const saved=await operations.scene.snapshot(s.sceneId);expect(saved.physics?.template).toBe('physics-workspace-v2');expect(saved.entities.some(entity=>entity.components.collision?.shape==='plane')).toBe(true)
  expect(states.at(-1)?.phase).toBe('running')
 }finally{await rm(root,{recursive:true,force:true})}
})

test('既有运行world仍恢复与同步；视觉意图门不关闭/暂停/另建用户owner',async()=>{
 const s={...scene(),revision:1},before={...world(),status:'running' as const},after={...before,worldGeneration:2,appliedSceneRevision:1},states:SceneWorldState[]=[],calls:string[]=[],p=port(calls)
 s.entities[0]!.components={visual:{kind:'mesh'}}
 p.list=async()=>{calls.push('list');return [before]};p.reconcile=async(snapshot)=>{calls.push('reconcile');return {snapshot,pending:false,issues:[]}}
 p.sync=async(snapshot,bound)=>{calls.push('sync');expect(snapshot).toEqual(s);expect(bound).toEqual(before);return after};p.observe=async()=>{calls.push('observe');return frame(after)}
 const result=await new SceneWorldLifecycle(state=>states.push(state)).ensure('owner','host',s,p)
 expect(result).toEqual(after);expect(calls).toEqual(['list','reconcile','list','sync','observe']);expect(states.at(-1)?.phase).toBe('running')
 expect(calls).not.toContain('open');expect(calls).not.toContain('close');expect(calls).not.toContain('pause')
})


test('原持久物理声明保自动路径；默认重力和纯视觉不暗示物理意图',async()=>{
 const blank={...scene(),physics:{gravityWorldMps2:[0,0,-9.81] as [number,number,number],template:'blank' as const}}
 blank.entities[0]!.components={visual:{kind:'mesh'}}
 expect(sceneRequestsPhysics(blank)).toBe(false);expect(sceneRequestsPhysics({...blank,physics:{gravityWorldMps2:[0,0,-9.81]}})).toBe(false)
 for(const template of ['physics-workspace-v1','physics-workspace-v2'] as const){
  const s={...blank,physics:{...blank.physics,template}},calls:string[]=[],states:SceneWorldState[]=[],p=port(calls),prepared={...world(),appliedSceneRevision:1}
  expect(sceneRequestsPhysics(s)).toBe(true)
  p.reconcile=async(snapshot)=>{calls.push('reconcile');return {snapshot,pending:false,issues:[]}}
  p.prepareWorld=async(snapshot)=>{calls.push('prepare');return {...snapshot,revision:1,entities:[{...scene().entities[0]!,components:{collision:{shape:'plane'},rigidBody:{type:'static'}}}]}}
  p.open=async(snapshot)=>{expect(snapshot.revision).toBe(1);calls.push('open');return prepared};p.observe=async()=>{calls.push('observe');return frame(prepared)}
  expect(await new SceneWorldLifecycle(state=>states.push(state)).ensure('owner','host',s,p)).toEqual(prepared)
  expect(calls).toEqual(['reconcile','list','prepare','open','observe']);expect(states.at(-1)?.phase).toBe('running')
 }
 for(const key of ['collision','rigidBody','articulation','mujoco','isaac','newton'] as const){const s=scene();s.entities[0]!.components={[key]:{sourcePath:'/fixture/native'}};expect(sceneRequestsPhysics(s)).toBe(true)}
 const requested={...blank},pending={...blank,revision:1};requested.entities=[{...blank.entities[0]!,components:{visual:{kind:'mesh'},physicsBinding:{resourceId:'r',version:1,status:'PENDING'}}}]
 const calls:string[]=[],states:SceneWorldState[]=[],p=port(calls)
 expect(sceneRequestsPhysics(requested)).toBe(true)
 p.reconcile=async()=>{calls.push('reconcile');return {snapshot:pending,pending:true,issues:[]}}
 expect(await new SceneWorldLifecycle(state=>states.push(state)).ensure('owner','host',requested,p)).toBeUndefined()
 expect(calls).toEqual(['reconcile','list']);expect(states.at(-1)?.code).toBe('SCENE_PHYSICS_PENDING')
})


test('无物理Provider时纯视觉仍显示idle；物理声明与同Scene既有world准确blocked',()=>{
 const visual=scene('visual');visual.entities[0]!.components={visual:{kind:'mesh'}}
 expect(sceneWorldWithoutProvider(visual,undefined,'原错误')).toEqual({phase:'idle',sceneId:visual.sceneId,sceneRevision:visual.revision})
 expect(sceneWorldWithoutProvider(visual,world('other','other'),'原错误').phase).toBe('idle')
 expect(sceneWorldWithoutProvider(visual,world('own',visual.sceneId),'原错误')).toMatchObject({phase:'blocked',code:'PROVIDER_UNAVAILABLE',detail:'原错误'})
 expect(sceneWorldWithoutProvider(scene(),undefined,'Original error')).toMatchObject({phase:'blocked',code:'PROVIDER_UNAVAILABLE',detail:'Original error'})
})


test('视觉Scene已有world在只读恢复期间被其owner关闭，不自动补地面或重开',async()=>{
 const s=scene(),states:SceneWorldState[]=[],calls:string[]=[],p=port(calls);s.entities[0]!.components={visual:{kind:'mesh'}}
 let lists=0;p.list=async()=>{calls.push('list');return ++lists===1?[world()]:[]}
 p.reconcile=async(snapshot)=>{calls.push('reconcile');return {snapshot,pending:false,issues:[]}}
 p.prepareWorld=async()=>{calls.push('prepare');throw Error('UNEXPECTED_VISUAL_PREPARE')}
 expect(await new SceneWorldLifecycle(state=>states.push(state)).ensure('owner','host',s,p)).toBeUndefined()
 expect(calls).toEqual(['list','reconcile','list']);expect(states.at(-1)?.phase).toBe('idle')
})


test('纯视觉idle状态经原formatter按界面语言显示，中英文compact与详情均一致',()=>{
 const state:SceneWorldState={phase:'idle',sceneId:'visual',sceneRevision:1,detail:'场景可显示和编辑；未请求创建物理世界。'},noop=()=>{}
 for(const compact of [false,true]){
  const zh=renderToStaticMarkup(<SceneWorldStatus compact={compact} state={state} tr={cn=>cn} retry={noop} cancel={noop}/>),en=renderToStaticMarkup(<SceneWorldStatus compact={compact} state={state} tr={(_cn,en)=>en} retry={noop} cancel={noop}/>)
  expect(zh).toContain('场景可显示和编辑；未请求创建物理世界。');expect(zh).not.toContain('The scene can be viewed and edited')
  expect(en).toContain('The scene can be viewed and edited; no physics world was requested.');expect(en).not.toContain('场景可显示和编辑')
  expect(en).toContain('Not initialized');expect(zh).toContain('尚未初始化')
 }
 const unknown=renderToStaticMarkup(<SceneWorldStatus state={{phase:'idle',detail:'ORIGINAL_UNMAPPED_DETAIL'}} tr={(_cn,en)=>en} retry={noop} cancel={noop}/>)
 expect(unknown).toContain('ORIGINAL_UNMAPPED_DETAIL')
})
