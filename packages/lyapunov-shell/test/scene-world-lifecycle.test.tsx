import {expect,test} from 'bun:test'
import {renderToStaticMarkup} from 'react-dom/server'
import {SceneWorldLifecycle,sceneWorldPreflight,worldLifecycleState,measuredJointTargets,type SceneWorldPort,type SceneWorldState} from '../src/scene-world-lifecycle.ts'
import {SceneWorldStatus} from '../src/scene-world-status.tsx'
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
test('源坐标缺项和纯视觉场景准确blocked，不猜Z/碰撞、不启动worker',async()=>{
 const missing=scene();missing.entities[0]!.resources=[{resourceId:'r',version:1,original:{uri:'/fixture',mimeType:'x'},representations:[]} as any]
 expect(sceneWorldPreflight(missing)?.code).toBe('SCENE_RESOURCE_SOURCE_REQUIRED')
 const visual=scene();visual.entities[0]!.components={};expect(sceneWorldPreflight(visual)?.code).toBe('SCENE_PHYSICS_REQUIRED')
 const states:SceneWorldState[]=[],calls:string[]=[],lifecycle=new SceneWorldLifecycle(s=>states.push(s));await lifecycle.ensure('a','h',visual,port(calls));expect(calls).toEqual(['list']);expect(states.at(-1)?.phase).toBe('blocked')
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
})
