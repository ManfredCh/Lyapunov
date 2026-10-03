/** 真实官方 Crazyflie + 原生 worker；外部模型/Python 前提明确，不自动下载、无 GUI/硬件签收。 */
import assert from 'node:assert/strict'
import { mkdir,readFile,writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve,join } from 'node:path'
import { MuJoCoProvider } from '../../sim-mujoco/src/provider.ts'
import { identityTransform,SCENE_COORDINATES,type SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import { runFlight,stopFlight,isFlightRunning } from '../src/flight-run.ts'
import { CRAZYFLIE_SOURCE_SHA256 } from '../src/flight-controller.ts'
const output=resolve(process.argv[2]??'.runtime/flight-native-fixture'),model=process.argv[3],python=process.argv[4]
assert(model&&python,'必须显式提供已核完整模型与 SDK Python，缺前提不能 skip')
await mkdir(output,{recursive:true})
const hash=()=>readFile(model).then(b=>createHash('sha256').update(b).digest('hex'))
assert.equal(await hash(),CRAZYFLIE_SOURCE_SHA256)
const scene:SceneSnapshot={sceneId:'isolated-crazyflie',revision:1,coordinates:SCENE_COORDINATES,entities:[{entityId:'quad',name:'Crazyflie2',transform:identityTransform(),resources:[],components:{mujoco:{sourcePath:resolve(model)},controller:{type:'drone',thrustActuator:'body_thrust',torqueActuators:{x:'x_moment',y:'y_moment',z:'z_moment'}}}}]}
const provider=new MuJoCoProvider({pythonPath:python,workerPath:resolve(import.meta.dirname,'../../sim-mujoco/python/worker.py')})
try{
 const world=await provider.open(scene,{clock:'manual',timestepS:.002,ground:true})
 await writeFile(join(output,'compiled-description.json'),JSON.stringify(await provider.describe(world.worldId,'quad'),null,2))
 const identity={worldId:world.worldId,entityId:'quad',expectedGeneration:world.worldGeneration,expectedSceneRevision:scene.revision}
 let n=0
 const sample=(s:unknown)=>{if(++n%150===0)console.log(JSON.stringify({phase:'native-control',sample:n,state:s}))}
 const hover=await runFlight(provider,{...identity,operation:'hover',positionM:[0,0,.35],maxDurationS:10},undefined,{paceManual:false,sample})
 await writeFile(join(output,'hover.json'),JSON.stringify(hover,null,2));assert.equal(hover.taskAchieved,true,hover.reason);assert(hover.maxTiltRad<=.25)
 const goto=await runFlight(provider,{...identity,operation:'goto',positionM:[.25,0,.35],yawRad:.25,maxDurationS:20},undefined,{paceManual:false,sample})
 await writeFile(join(output,'goto.json'),JSON.stringify(goto,null,2));assert.equal(goto.taskAchieved,true,goto.reason)
 const position=goto.after.entities.find(e=>e.entityId==='quad')!.transform.position
 assert(position[0]>.10,'必须是实际正向位移，不能只读成功码')
 const land=await runFlight(provider,{...identity,operation:'land',landingSurfaceZ:0,maxDurationS:20},undefined,{paceManual:false,sample})
 await writeFile(join(output,'land.json'),JSON.stringify(land,null,2));assert.equal(land.taskAchieved,true,land.reason)
 const reset=await provider.sync(world.worldId,scene,{forceRebuild:true})
 const resetFrame=await provider.observe(world.worldId,{sensors:true,contacts:true})
 assert(reset.worldGeneration>world.worldGeneration);assert.equal(resetFrame.stepIndex,0)
 const next={...identity,expectedGeneration:reset.worldGeneration}
 let entered=false
 const inflight=runFlight(provider,{...next,operation:'hover',positionM:[0,0,.4],maxDurationS:30},undefined,{sample:()=>{entered=true}})
 while(!entered)await new Promise(done=>setTimeout(done,10))
 assert(isFlightRunning(provider,world.worldId,'quad'))
 const stop=await stopFlight(provider,world.worldId,'quad',reset.worldGeneration)
 const stopped=await inflight
 await writeFile(join(output,'stop-reset.json'),JSON.stringify({reset,resetFrame,stop,stopped},null,2))
 assert.equal(stop.stopped,true);assert.equal(stopped.status,'cancelled');assert(stopped.actions>0)
 // 普通 sim_stop 位于两个短窗口之间也须取消控制器，不能在停止后继续发推力。
 let between=false
 const loop=runFlight(provider,{...next,operation:'hover',positionM:[0,0,.4],maxDurationS:30},undefined,{sample:()=>{between=true}})
 while(!between)await new Promise(done=>setTimeout(done,5))
 const globalStop=await provider.stop(world.worldId,{entityIds:['quad'],expectedGeneration:reset.worldGeneration})
 const globallyStopped=await loop
 assert.equal(globalStop.stopped,true);assert.equal(globallyStopped.status,'cancelled')
 const holdStep=(await provider.observe(world.worldId)).stepIndex
 await new Promise(done=>setTimeout(done,60));assert.equal((await provider.observe(world.worldId)).stepIndex,holdStep)
 await writeFile(join(output,'global-stop.json'),JSON.stringify({globalStop,globallyStopped,holdStep},null,2))
 // 实时钟的 running 原生窗口：先确认已驱动物理步，再请求停止；不是只等已完成动作。
 const liveWorld=await provider.open({...scene,sceneId:'isolated-crazyflie-realtime'},{clock:'realtime',timestepS:.002,ground:true})
 let actionId:string|undefined
 const liveIdentity={...identity,worldId:liveWorld.worldId,expectedGeneration:liveWorld.worldGeneration}
 const live=runFlight(provider,{...liveIdentity,operation:'hover',positionM:[0,0,.35],maxDurationS:10},undefined,{onAction:id=>{actionId=id}})
 let driving:any,drivingFrame:any
 const until=Date.now()+2000
 while(Date.now()<until){
  if(actionId){try{const r=await provider.receipt(liveWorld.worldId,actionId);const f=await provider.observe(liveWorld.worldId,{sensors:true});if(r.status==='running'&&f.stepIndex>(r.startStep??Infinity)){driving=r;drivingFrame=f;break}}catch{/* 本次动作尚未被原生队列接收，下一次按实际 receipt 重读 */}}
  await new Promise(done=>setTimeout(done,1))
 }
 assert(driving&&drivingFrame,'实时 native action 必须在 actual running 且已经驱动物理步时停止')
 const liveStop=await stopFlight(provider,liveWorld.worldId,'quad',liveWorld.worldGeneration)
 const liveStopped=await live
 assert.equal(liveStop.stopped,true);assert.equal(liveStopped.status,'cancelled')
 await writeFile(join(output,'realtime-stop.json'),JSON.stringify({liveWorld,driving,drivingFrame,liveStop,liveStopped},null,2))
 const liveReset=await provider.sync(liveWorld.worldId,{...scene,sceneId:'isolated-crazyflie-realtime'},{forceRebuild:true})
 const liveNext={...liveIdentity,expectedGeneration:liveReset.worldGeneration}
 const liveHover=await runFlight(provider,{...liveNext,operation:'hover',positionM:[0,0,.35],maxDurationS:8},undefined,{sample})
 await writeFile(join(output,'realtime-hover.json'),JSON.stringify(liveHover,null,2));assert.equal(liveHover.taskAchieved,true,liveHover.reason)
 const liveMove=await runFlight(provider,{...liveNext,operation:'goto',positionM:[.2,.1,.35],yawRad:.2,maxDurationS:20},undefined,{sample})
 await writeFile(join(output,'realtime-goto.json'),JSON.stringify(liveMove,null,2));assert.equal(liveMove.taskAchieved,true,liveMove.reason)
 const liveLand=await runFlight(provider,{...liveNext,operation:'land',landingSurfaceZ:0,maxDurationS:20},undefined,{sample})
 await writeFile(join(output,'realtime-land.json'),JSON.stringify(liveLand,null,2));assert.equal(liveLand.taskAchieved,true,liveLand.reason)
 await provider.close(liveWorld.worldId)
 assert.equal(await hash(),CRAZYFLIE_SOURCE_SHA256)
 await writeFile(join(output,'summary.json'),JSON.stringify({status:'passed',sourceSha256:await hash(),clock:'manual+realtime',hover: {position:hover.after.entities[0]?.transform.position,maxTiltRad:hover.maxTiltRad,actions:hover.actions},goto:{position,yaw:goto.samples.at(-1)?.yawRad,errorM:goto.samples.at(-1)?.errorM},land:{position:land.after.entities[0]?.transform.position,contacts:land.samples.at(-1)?.contacts},stop:{status:stopped.status,actions:stopped.actions,confirmed:stop.stopped},globalStop:{status:globallyStopped.status,heldStep:holdStep},realtime:{hover:liveHover.after.entities[0]?.transform.position,goto:liveMove.after.entities[0]?.transform.position,yaw:liveMove.samples.at(-1)?.yawRad,land:liveLand.after.entities[0]?.transform.position,landContacts:liveLand.samples.at(-1)?.contacts},realtimeStop:{priorNativeStatus:driving.status,priorStep:drivingFrame.stepIndex,status:liveStopped.status,confirmed:liveStop.stopped},resetGeneration:reset.worldGeneration},null,2))
 console.log(JSON.stringify({status:'passed',output}))
}finally{await provider.dispose()}
