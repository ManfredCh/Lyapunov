import {test,expect} from 'bun:test'
import {spawnSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {SceneOperations} from '../../scene-kit/src/operations.ts'
import {identityTransform,type Entity} from '../../lyapunov-contracts/src/types.ts'
import {visibilityCommit,removeSceneNodeCommit} from '../../lyapunov-shell/src/scene-node-controls.tsx'

const root=resolve(import.meta.dir,'../../..')
for(const engine of ['mujoco','newton']as const){
 const python=process.env[engine==='mujoco'?'LYAPUNOV_MUJOCO_PYTHON':'LYAPUNOV_NEWTON_PYTHON']??join(root,'.runtime',engine==='mujoco'?'sim-python':'newton-env','bin/python')
 test.skipIf(!existsSync(python))(`011：${engine}真实CPU无限地面远域落球、隐藏、删除/重开及原生地面去重${existsSync(python)?'':`（缺少解释器 ${python}）`}`,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'a09-ground-'+engine+'-'))
  try{
   const ops=new SceneOperations(directory),initial=await ops.create({sceneId:'ground-runtime',template:'physics-workspace'})
   const ball:Entity={entityId:'ball',name:'远域落球',resources:[],transform:{...identityTransform(),position:[1234,-987,1]},components:{collision:{shape:'sphere',radiusM:.1},rigidBody:{type:'dynamic',massKg:1}}}
   const baseline=await ops.scene.commit({sceneId:initial.sceneId,expectedRevision:0,patch:[{op:'add',entity:ball}],physics:{...initial.physics!,gravityWorldMps2:[0,0,-3]}})
   const hidden=await ops.scene.commit(visibilityCommit(baseline,initial.entities[0]!.entityId,false))
   const deleted=await ops.scene.commit(removeSceneNodeCommit(hidden,initial.entities[0]!.entityId))
   const payload=join(directory,'scenes.json');await writeFile(payload,JSON.stringify({default:baseline,hidden,deleted:await ops.scene.snapshot(deleted.sceneId)}))
   const result=spawnSync(python,[join(root,'packages/sim-contract/test/infinite_ground_runtime_fixture.py'),engine,root,payload],{encoding:'utf8',timeout:175_000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',LYAPUNOV_WARP_KERNEL_CACHE_DIR:process.env.LYAPUNOV_WARP_KERNEL_CACHE_DIR??join(directory,'warp-cache')}})
   if(result.status!==0)throw Error(`${engine} runtime exit=${result.status}\n${result.stdout}\n${result.stderr}`)
   const evidence=JSON.parse(result.stdout.trim())
   expect(evidence).toMatchObject({engine,device:'cpu',positionXY:[1234,-987],passed:true})
   expect(evidence.checks.hidden.contactSamples).toBeGreaterThan(0)
   expect(evidence.checks.deleted.contactSamples).toBe(0)
   expect(evidence.checks.reopenedDeleted.heightM).toBeLessThan(-4)
   expect(evidence.checks.nativeGroundNoDuplicate.planeCount).toBe(1)
   console.log(JSON.stringify(evidence))
  }finally{await rm(directory,{recursive:true,force:true})}
 },180_000)
}
