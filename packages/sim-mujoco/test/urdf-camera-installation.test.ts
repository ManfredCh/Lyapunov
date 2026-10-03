/** 010：真实MuJoCo URDF sensor→同帧camera_list→RGB-D，需现有LYAPUNOV_MUJOCO_PYTHON与离屏GL。无环境时明确失败。 */
import {expect,test} from 'bun:test'
import {readFile,mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {inflateSync} from 'node:zlib'
import {resolve,join} from 'node:path'
import {tmpdir} from 'node:os'
import {MuJoCoProvider} from '../src/provider.ts'
import type {SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'
import {cameraDraftFromInstallation} from '../../lyapunov-shell/src/camera-installation-input.ts'
import {cameraInstallationCommit} from '../../lyapunov-shell/src/camera-installation.ts'
import {cameraMountBodies} from '../../lyapunov-shell/src/workbench-camera.ts'
import {nativeCameraPreset} from '../../robot-tools/src/presets.ts'

const python=process.env.LYAPUNOV_MUJOCO_PYTHON
const fixture=resolve(import.meta.dir,'../fixtures/calibrated-camera.urdf')
const K={fx:344.5,fy:355.7,cx:173,cy:132,width:384,height:256}
const sourceScene=(path:string):SceneSnapshot=>({sceneId:'010-native',revision:1,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[
 {entityId:'robot',name:'actual URDF',transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{mujoco:{sourcePath:path}}},
 {entityId:'target',name:'colored target',transform:{position:[2,0,.63],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{mujoco:{xml:'<mujoco><worldbody><body name="marker"><geom type="sphere" size=".2" rgba="1 .05 .02 1"/></body></worldbody></mujoco>'}}}
]})
const close=(actual:number[],expected:number[])=>actual.forEach((n,i)=>expect(n).toBeCloseTo(expected[i]!,7))
const closeK=(actual:number[],expected:number[])=>actual.forEach((n,i)=>expect(n).toBeCloseTo(expected[i]!,4))
function imageStats(png:Buffer){
 const chunks:Buffer[]=[],width=png.readUInt32BE(16),height=png.readUInt32BE(20)
 expect(png[24]).toBe(8);expect(png[25]).toBe(2)
 for(let offset=8;offset<png.length;){const length=png.readUInt32BE(offset),type=png.toString('ascii',offset+4,offset+8);if(type==='IDAT')chunks.push(png.subarray(offset+8,offset+8+length));offset+=length+12}
 const raw=inflateSync(Buffer.concat(chunks)),colors=new Set<number>();let redPixels=0
 expect(raw.length).toBe(height*(width*3+1))
 for(let y=0;y<height;y++){const row=y*(width*3+1);expect(raw[row]).toBe(0);for(let x=0;x<width;x++){const i=row+1+x*3,r=raw[i]!,g=raw[i+1]!,b=raw[i+2]!;colors.add((r<<16)|(g<<8)|b);if(r>10&&r>g*2&&r>b*2)redPixels++}}
 return {distinctColors:colors.size,redPixels}
}
test('010 URDF明确标定保K/原件，Scene新增body相机与原生相机共存，RGB-D及FOV恢复来自真引擎',async()=>{
 if(!python)throw Error('LYAPUNOV_MUJOCO_PYTHON_REQUIRED: provide an existing MuJoCo environment; this test never skips')
 const root=await mkdtemp(join(tmpdir(),'010-camera-native-')),provider=new MuJoCoProvider({pythonPath:python}),original=await readFile(fixture),path=join(root,'model.urdf')
 await writeFile(path,original)
 const scene=sourceScene(path)
 try{
  const world=await provider.open(scene,{worldId:'010-native-world',ground:false}),receipt=await provider.listCameras(world.worldId) as any
  const row=receipt.cameras.find((c:any)=>c.cameraName==='robot/calibrated_eye')
  expect(row?.available).toBe(true);expect(row.cameraSource).toBe('urdf');expect(row.parentBodyName).toBe('robot/sensor_link');expect(row.declaredIntrinsicsPx).toEqual(K)
  close(row.worldFromCamera.positionM,[.06,.02,.63]);close(row.worldFromCamera.rotationMatrix.map((r:number[])=>-r[2]!),[1,0,0])
  expect(row.frameId).toBe(receipt.frameId);expect(row.generation).toBe(world.worldGeneration)
  const preset=nativeCameraPreset(row,receipt,scene.entities);expect(preset.source).toBe('urdf');expect(preset.intrinsics).toEqual(K);close(preset.pose.positionM,[.06,.02,.13])
  const displayed=await provider.observe(world.worldId,{cameraAuthoring:true,sensors:true})
  const nativeBody=(displayed.entities.find(e=>e.entityId==='robot')?.sensors?.bodyWorldPoses as any)?.sensor_link
  expect(nativeBody).toBeDefined();close(nativeBody.positionM,[0,0,.5]);expect(displayed.cameras?.find(c=>c.cameraName==='robot/calibrated_eye')?.frameId).toBe(displayed.frameId)
  const bodies=cameraMountBodies(receipt,scene.entities),draft=cameraDraftFromInstallation(scene,{referenceFrame:'parent',positionM:[.09,0,.11],normal:[1,0,0],up:[0,0,1],intrinsics:K},{mount:{entityId:'robot',bodyName:'sensor_link'},bodies,worldId:world.worldId,generation:world.worldGeneration,frameId:receipt.frameId,stepIndex:receipt.stepIndex,name:'added_eye'})
  const patch=cameraInstallationCommit(scene,draft,bodies,'camera','manual').patch[0]!
  if(patch.op!=='add')throw Error('expected add')
  const current={...scene,revision:2,entities:[...scene.entities,patch.entity]}
  const synced=await provider.sync(world.worldId,current),currentList=await provider.listCameras(world.worldId) as any
  expect(currentList.cameras.map((c:any)=>c.cameraName).sort()).toEqual(['camera/added_eye','robot/calibrated_eye']);expect(synced.worldGeneration).toBeGreaterThan(world.worldGeneration)
  for(const name of ['robot/calibrated_eye','camera/added_eye']){
   const capture=await provider.capture(world.worldId,{cameraName:name,width:384,height:256,outputDir:join(root,name.replaceAll('/','-'))}) as any
   closeK(['fx','fy','cx','cy'].map(k=>capture.calibration.intrinsics[k]),[K.fx,K.fy,K.cx,K.cy]);expect(capture.calibration.frameId).toBe(capture.frameId)
   const png=await readFile(new URL(capture.rgb.uri));expect(png.readUInt32BE(16)).toBe(384);expect(png.readUInt32BE(20)).toBe(256);expect(png.length).toBeGreaterThan(1000)
   const depth=await readFile(new URL(capture.depth.uri));expect(depth.length).toBeGreaterThan(384*256*4);expect(capture.calibration.parentBodyName).toBe('robot/sensor_link')
   const stats=imageStats(png);expect(stats.distinctColors).toBeGreaterThan(10);expect(stats.redPixels).toBeGreaterThan(50)
   const headerLength=depth.readUInt16LE(8),dataOffset=10+headerLength
   expect(depth.readFloatLE(dataOffset+(132*384+173)*4)).toBeGreaterThan(1);expect(depth.readFloatLE(dataOffset+(132*384+173)*4)).toBeLessThan(2)
   const artifactRoot=process.env.LYAPUNOV_CAMERA_RECEIPT_DIR
   if(artifactRoot){await mkdir(artifactRoot,{recursive:true});const key=name.replaceAll('/','-');await writeFile(join(artifactRoot,key+'.png'),png);await writeFile(join(artifactRoot,key+'.json'),JSON.stringify({sceneId:current.sceneId,sceneRevision:current.revision,worldId:world.worldId,generation:capture.generation,frameId:capture.frameId,stepIndex:capture.stepIndex,cameraName:name,calibration:capture.calibration,image:stats},null,2))}
  }
  await provider.adjustCamera(world.worldId,{cameraName:'robot/calibrated_eye',expectedGeneration:synced.worldGeneration,fovyDeg:75})
  const changed=await provider.capture(world.worldId,{cameraName:'robot/calibrated_eye',width:384,height:256,outputDir:join(root,'fov-adjusted')}) as any,changedK=changed.calibration.intrinsics
  expect(changedK.fovyDeg).toBeCloseTo(75,6);expect(changedK.fx/changedK.fy).toBeCloseTo(K.fx/K.fy,7);expect(changedK.cx).toBeCloseTo(K.cx,6)
  await provider.adjustCamera(world.worldId,{cameraName:'robot/calibrated_eye',expectedGeneration:synced.worldGeneration,clear:true})
  const restored=await provider.capture(world.worldId,{cameraName:'robot/calibrated_eye',width:384,height:256,outputDir:join(root,'restored')}) as any
  closeK(['fx','fy','cx','cy'].map(k=>restored.calibration.intrinsics[k]),[K.fx,K.fy,K.cx,K.cy])
  expect(await readFile(path)).toEqual(original)
 }finally{await provider.close('010-native-world').catch(()=>{});await provider.dispose();await rm(root,{recursive:true,force:true})}
},60000)

test('010不可表达的URDF标定点名拒绝，无相机名称或外部frame猜测',async()=>{
 if(!python)throw Error('LYAPUNOV_MUJOCO_PYTHON_REQUIRED')
 const root=await mkdtemp(join(tmpdir(),'010-camera-refusal-')),provider=new MuJoCoProvider({pythonPath:python}),path=join(root,'model.urdf')
 const text=(await readFile(fixture,'utf8')).replace('<s>0</s>','<s>3</s>')
 await writeFile(path,text)
 try{
  const world=await provider.open(sourceScene(path),{worldId:'010-refusal-world',ground:false}),list=await provider.listCameras(world.worldId) as any
  const row=list.cameras.find((c:any)=>c.cameraName==='robot/calibrated_eye')
  expect(row.available).toBe(false);expect(row.reason).toBe('URDF_CAMERA_UNSUPPORTED');expect(row.message).toContain('skew')
  expect(()=>nativeCameraPreset(row,list,sourceScene(path).entities)).toThrow('UNAVAILABLE')
 }finally{await provider.close('010-refusal-world').catch(()=>{});await provider.dispose();await rm(root,{recursive:true,force:true})}
},60000)
