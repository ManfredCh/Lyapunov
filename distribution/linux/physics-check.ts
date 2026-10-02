import {MuJoCoProvider} from '../../packages/sim-mujoco/src/provider.ts'
import {SCENE_COORDINATES,identityTransform,type SceneSnapshot} from '../../packages/lyapunov-contracts/src/types.ts'
import {readRuntimeEnv} from '../../packages/lyapunov-product-bundle/src/runtime-paths.ts'
import {resolveSdkPython} from '../../packages/lyapunov-product-bundle/src/sdk-python.mjs'
import {existsSync} from 'node:fs'
import {resolve,join} from 'node:path'
const configuredRoot=readRuntimeEnv(process.env,"productRoot")
const root=resolve(configuredRoot??resolve(import.meta.dirname,'../..'))
const managed=process.argv[2]==='--managed-sdk'
const sdk=resolveSdkPython(root,'mujoco',process.env,{managed}),workerPath=join(root,'packages/sim-mujoco/python/worker.py')
if(process.argv.length>3||process.argv[2]&&!managed){console.error('用法：./lyapunov physics-check [--managed-sdk]');process.exit(2)}
const scene:SceneSnapshot={sceneId:'portable-physics-check',revision:1,coordinates:SCENE_COORDINATES,entities:[{entityId:'falling-cube',name:'发行包物理检查方块',transform:{...identityTransform(),position:[0,0,1]},resources:[],components:{collision:{shape:'box',halfExtents:[.02,.02,.02]},rigidBody:{type:'dynamic',massKg:.05}}}]}
let result:Record<string,unknown>
if(!existsSync(sdk.python)){
  result={status:'BLOCKED',error:{code:'PROVIDER_UNAVAILABLE',message:`MuJoCo Python 不存在：${sdk.python}`,install:'./lyapunov install-provider mujoco',python:sdk.python,pythonSource:sdk.source}}
  process.exitCode=2
}else if(!existsSync(workerPath)){
  result={status:'BLOCKED',error:{code:'RELEASE_PAYLOAD_MISSING',message:`MuJoCo worker 不存在：${workerPath}；请重新完整解包。`,python:sdk.python,pythonSource:sdk.source}}
  process.exitCode=2
}else{
  const sim=new MuJoCoProvider({pythonPath:sdk.python,workerPath}),openedWorldId:{value?:string}={}
  let closed=false
  try{
    const world=await sim.open(scene,{realtimeFactor:1});openedWorldId.value=world.worldId
    const before=await sim.observe(world.worldId)
    await new Promise(resolve=>setTimeout(resolve,300))
    const after=await sim.observe(world.worldId),z0=before.entities[0]!.transform.position[2],z1=after.entities[0]!.transform.position[2]
    if(!(after.stepIndex>before.stepIndex&&z0-z1>.05))throw new Error('真实物理步进未达到 5cm 重力位移')
    const stopped=await sim.stop(world.worldId);await sim.close(world.worldId);closed=true
    result={status:'PASS',engine:'MuJoCo',scope:'从便携安装目录运行真实 MuJoCo worker；无 Viewer、无 Key、无模型权重',before,after,displacementM:z0-z1,stopped,python:sdk.python,pythonSource:sdk.source,worldsAfterClose:await sim.listWorlds()}
  }catch(error){const e=error as Error&{code?:string};result={status:e.code==='PROVIDER_UNAVAILABLE'?'BLOCKED':'FAIL',error:{code:e.code??'PHYSICS_CHECK_FAILED',message:e.message??String(error)},python:sdk.python,pythonSource:sdk.source};process.exitCode=result.status==='BLOCKED'?2:1}
  finally{
    if(openedWorldId.value&&!closed){try{await sim.stop(openedWorldId.value)}catch{}try{await sim.close(openedWorldId.value)}catch{}}
    await sim.dispose()
  }
}
console.log(JSON.stringify(result,null,2))
