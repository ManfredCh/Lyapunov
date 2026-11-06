/** 实际 MuJoCo worker 与 Provider：受控 tick 故障应保留原原因，恢复后不能残留。 */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {resolve} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {MuJoCoProvider} from '../src/provider.ts'
import {identityTransform,SCENE_COORDINATES} from '../../lyapunov-contracts/src/types.ts'

const root=resolve(import.meta.dirname,'../../..'),python=process.env.LYAPUNOV_MUJOCO_PYTHON??resolve(root,'.runtime/sim-python/bin/python')
const fixture=resolve(import.meta.dirname,'fault_status_worker.py')
test('实际世界故障保留原因并在原重建成功后清除',{skip:existsSync(python)?false:'缺少真实 MuJoCo Python',timeout:30000},async()=>{
 const source=process.env.LYAPUNOV_MUJOCO_FAULT_SOURCE??resolve(root,'packages/sim-mujoco/python/worker.py')
 const scene={sceneId:'fault-status',revision:1,coordinates:SCENE_COORDINATES,entities:[{entityId:'arm',name:'arm',transform:identityTransform(),resources:[],components:{mujoco:{sourcePath:resolve(root,'packages/sim-mujoco/fixtures/arm.xml')}}}]}
 const provider=new MuJoCoProvider({pythonPath:python,workerPath:fixture})
 const previous=process.env.LYAPUNOV_MUJOCO_FAULT_SOURCE;process.env.LYAPUNOV_MUJOCO_FAULT_SOURCE=source
 try{
  const opened=await provider.open(scene,{worldId:'fault-status',clock:'realtime'})
  let handle=(await provider.listWorlds()).find(w=>w.worldId===opened.worldId)
  for(let i=0;i<30&&handle?.status!=='unavailable';i++){await delay(50);handle=(await provider.listWorlds()).find(w=>w.worldId===opened.worldId)}
  assert.equal(handle?.status,'unavailable');assert.match(handle?.statusReason??'',/故障夹具：原生步进失败/)
  await assert.rejects(()=>provider.observe(opened.worldId),/故障夹具：原生步进失败/)
  const invalid={...scene,revision:2,entities:[{...scene.entities[0],components:{mujoco:{sourcePath:resolve(root,'missing-fault-source.xml')}}}]}
  await assert.rejects(()=>provider.sync(opened.worldId,invalid,{forceRebuild:true}))
  const afterFailedRecovery=(await provider.listWorlds()).find(w=>w.worldId===opened.worldId)
  assert.equal(afterFailedRecovery?.status,'unavailable');assert.match(afterFailedRecovery?.statusReason??'',/故障夹具：原生步进失败/)
  const recovered=await provider.sync(opened.worldId,scene,{forceRebuild:true})
  assert.notEqual(recovered.status,'unavailable');assert.equal(recovered.statusReason,undefined)
  const after=(await provider.listWorlds()).find(w=>w.worldId===opened.worldId)
  assert.equal(after?.statusReason,undefined);assert.notEqual(after?.status,'unavailable')
  await assert.rejects(()=>provider.sync(opened.worldId,invalid,{forceRebuild:true}))
  const preserved=(await provider.listWorlds()).find(w=>w.worldId===opened.worldId)
  assert.notEqual(preserved?.status,'unavailable');assert.equal(preserved?.statusReason,undefined)
  await provider.close(opened.worldId)
 }finally{await provider.dispose();if(previous===undefined)delete process.env.LYAPUNOV_MUJOCO_FAULT_SOURCE;else process.env.LYAPUNOV_MUJOCO_FAULT_SOURCE=previous}
})
