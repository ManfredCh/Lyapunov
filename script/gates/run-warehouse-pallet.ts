/** 真托盘：只消费已封存字节，独立库/便携删源重开，显式静态米制包装。 */
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir,rm,rename} from 'node:fs/promises'
import {join,resolve,dirname,relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import {SceneOperations} from '../../packages/scene-kit/src/operations.ts'
import {warehouseImport} from '../../packages/scene-kit/src/warehouse-assets.ts'
import {loadWarehouseCatalog,verifyWarehouseFile,sha256,WAREHOUSE_REPO,WAREHOUSE_REVISION} from '../../packages/scene-kit/src/warehouse-catalog.ts'
import {registerNvidiaUsdStandardLibrary} from '../../packages/scene-kit/src/usd-standard-libraries.ts'
import {inspectUsd,usdPython} from '../../packages/scene-kit/src/usd-assets.ts'
const args=process.argv.slice(2),arg=(name:string)=>{const i=args.indexOf(name);if(i<0||!args[i+1]||args[i+1]!.startsWith('--'))throw Error('用法：--verified-source <含固定Props路径的源包根> --core-root <已安装SDK的kit/mdl/core> --out <新输出目录>');return resolve(args[i+1]!)}
const root=resolve(import.meta.dirname,'../..'),out=arg('--out'),verifiedSource=arg('--verified-source'),coreRoot=arg('--core-root'),data=join(out,'source-root'),ops=new SceneOperations(data),catalog=await loadWarehouseCatalog(),selection={repoId:WAREHOUSE_REPO,revision:WAREHOUSE_REVISION,packagePath:'Props/general/Pallet_A1/Pallet_A1_physics.usd'}
await mkdir(out,{recursive:true});assert(!(await readFile(join(out,'receipt.json')).then(()=>true,()=>false)),'请使用全新输出目录')
const lib=await registerNvidiaUsdStandardLibrary(ops.resources,coreRoot)
const offline=async(url:string)=>{const prefix=`/datasets/${WAREHOUSE_REPO}/resolve/${WAREHOUSE_REVISION}/`,u=new URL(url);assert.equal(u.origin,'https://hf-mirror.com');assert(u.pathname.startsWith(prefix));const path=decodeURIComponent(u.pathname.slice(prefix.length)),file=catalog.files.get(path);assert(file);const bytes=await readFile(join(verifiedSource,path));verifyWarehouseFile(bytes,file);return bytes}
await ops.create({sceneId:'pallet-original'})
const original=await warehouseImport(ops,{...selection,resourceId:'warehouse-pallet-r3-source',sceneId:'pallet-original',entityId:'pallet-source'},{catalog,fetchBytes:offline})
const source=fileURLToPath(original.resource.ref.original.uri),facts=await inspectUsd(source);assert.equal(facts.usd.physics.rigidBodies.length,0);assert.equal(facts.usd.physics.collisions.length,1);assert.equal(facts.usd.preview.textures?.length,3)
await ops.save('pallet-original',join(out,'original-portable/scene.json'),{portable:true})
const wrapperDir=join(data,'explicit-wrapper');await mkdir(wrapperDir,{recursive:true});const wrapper=join(wrapperDir,'pallet-meters.usda'),sourceSha=sha256(await readFile(source)),declaration={kind:'usd-unit-wrapper',sourceResource:original.resource.ref,sourceSha256:sourceSha,sourcePrimPath:'/RootNode',scale:.01,sourceMetersPerUnit:facts.usd.metersPerUnit,rigidBodiesAdded:0,sourceGeometryEdited:false}
await writeFile(join(wrapperDir,'derivation.json'),JSON.stringify(declaration,null,2))
execFileSync(usdPython(),['-c',`from pxr import Usd,UsdGeom,UsdPhysics\nimport sys\ns=Usd.Stage.CreateNew(sys.argv[1]);UsdGeom.SetStageMetersPerUnit(s,1);UsdPhysics.SetStageKilogramsPerUnit(s,1);UsdGeom.SetStageUpAxis(s,'Z');r=UsdGeom.Xform.Define(s,'/PalletMeters');s.SetDefaultPrim(r.GetPrim());scale=UsdGeom.Xform.Define(s,'/PalletMeters/UnitScale');scale.AddScaleOp().Set((.01,.01,.01));child=UsdGeom.Xform.Define(s,'/PalletMeters/UnitScale/Source');child.GetPrim().GetReferences().AddReference(sys.argv[2],'/RootNode');s.GetRootLayer().Save()`,wrapper,source])
await writeFile(join(wrapperDir,'lyapunov-source.json'),JSON.stringify({schema:'lyapunov.simready-source.v1',sourceProtocol:'derived-usd-unit-wrapper-v1',rootUsd:'pallet-meters.usda',packageFiles:['pallet-meters.usda','derivation.json'],derivation:declaration,standardLibraries:facts.usd.standardLibraries!.map(library=>({...library,manifestPath:relative(wrapperDir,library.manifestPath)}))},null,2))
await ops.create({sceneId:'pallet-meters'})
const normalized={resource:await ops.resources.import({resourceId:'warehouse-pallet-r3-meters-explicit',path:wrapper,physicalizationRequest:false,storage:'reference',license:original.resource.license,legacySource:{resourceId:original.resource.ref.resourceId,assetRevision:String(original.resource.ref.version),sourceRef:original.resource.ref.original.uri,conversion:'显式静态USD米制包装；引用原/RootNode，父scale0.01，不增加刚体/不改网格'}})}
await ops.mount({sceneId:'pallet-meters',entityId:'pallet-meters',resourceId:normalized.resource.ref.resourceId,alignBottomToSurface:false})
const normalizedFacts=await inspectUsd(wrapper);assert.equal(normalizedFacts.usd.metersPerUnit,1);assert.equal(normalizedFacts.usd.physics.rigidBodies.length,0);assert.equal(normalizedFacts.usd.physics.collisions.length,1);assert.equal(normalizedFacts.usd.preview.textures?.length,3)
let scene=await ops.scene.snapshot('pallet-meters');await ops.scene.commit({sceneId:scene.sceneId,expectedRevision:scene.revision,patch:[{op:'update',entityId:'pallet-meters',changes:{resources:[...scene.entities[0]!.resources,original.resource.ref]}}]})
await ops.save('pallet-meters',join(out,'portable/scene.json'),{portable:true});await rename(join(out,'portable'),join(out,'portable-moved'));await rm(data,{recursive:true});assert(!(await readFile(source).then(()=>true,()=>false)))
const reopened=new SceneOperations(join(out,'reopened-root'));const moved=await reopened.open(join(out,'portable-moved/scene.json'),{sceneId:'pallet-moved'}),raw=await reopened.open(join(out,'original-portable/scene.json'),{sceneId:'pallet-original-moved'})
const verify=[];for(const item of [...moved.entities,...raw.entities])for(const ref of item.resources){const value=await reopened.resources.verifyReference(ref);assert(value.valid);verify.push({resourceId:ref.resourceId,version:ref.version,...value})}
const movedSource=fileURLToPath(moved.entities[0]!.resources[0]!.original.uri),movedFacts=await inspectUsd(movedSource);assert(movedFacts.files.every(path=>path.startsWith(join(out,'portable-moved')+'/')));assert.equal(movedFacts.usd.preview.textures?.length,3)
const rawMoved=fileURLToPath(raw.entities[0]!.resources[0]!.original.uri);assert.equal(sha256(await readFile(rawMoved)),sourceSha)
const std=moved.entities[0]!.resources.find(ref=>ref.resourceId===lib.ref.resourceId)!;assert.equal((await reopened.resources.get(std.resourceId,std.version)).license?.id,'BSD-3-Clause')
await writeFile(join(out,'scene-native-meters.json'),JSON.stringify(moved,null,2));await writeFile(join(out,'scene-native-original.json'),JSON.stringify(raw,null,2))
await writeFile(join(out,'OPEN_IN_WORKBENCH.md'),'# 真实Warehouse托盘\n\n原厘米源：`'+join(out,'original-portable/scene.json')+'`；显式静态米制包装：`'+join(out,'portable-moved/scene.json')+'`。通过既有scene_open打开；包装只引用原RootNode并在父层scale0.01，不增加刚体或改网格。OmniPBR为固定标准模块的贴图子集派生，不执行任意MDL。\n')
const receipt={status:'PORTABLE_REOPENED',selection,original:{resource:original.resource.ref,sourceSha,metersPerUnit:facts.usd.metersPerUnit,physics:facts.usd.physics},derivation:declaration,normalized:{resource:normalized.resource.ref,physics:movedFacts.usd.physics,metersPerUnit:movedFacts.usd.metersPerUnit},sourceRootRemoved:true,portable:join(out,'portable-moved/scene.json'),originalPortable:join(out,'original-portable/scene.json'),verification:verify,files:movedFacts.files,preview:{shapes:movedFacts.usd.preview.shapes.length,textures:movedFacts.usd.preview.textures,material:movedFacts.usd.preview.shapes[0]!.material,losses:movedFacts.usd.preview.losses},networkRequests:0}
if(args.includes('--isaac-python')){
 const {IsaacProvider}=await import('../../packages/sim-isaac/src/provider.ts'),nativeOut=join(out,'native'),native:any={status:'PARTIAL'};await mkdir(nativeOut,{recursive:true});let provider:InstanceType<typeof IsaacProvider>|undefined
 try{
  const python=arg('--isaac-python'),config={pythonPath:python,workerPath:join(root,'packages/sim-isaac/python/worker.py'),physicsDevice:'cpu' as const,rendering:'none' as const,startupBudgetMs:90000}
  provider=new IsaacProvider({...config,cacheRoot:join(nativeOut,'cache-original')})
  try{await provider.open(raw,{worldId:'pallet-original-cm-negative',clock:'manual',ground:false});throw Error('原cm错误通过米制门')}
  catch(error){assert(String(error).includes('米/千克/Z-up'));native.originalCm={status:'REJECTED_AS_EXPECTED',error:String(error)}}
  await provider.dispose();native.originalCm.closed=true;provider=undefined
  const clockSource=join(out,'clock-fixture');execFileSync(usdPython(),[join(root,'packages/scene-kit/test/fixtures/usd/make_fixture.py'),clockSource])
  const scene=structuredClone(moved),bounds=movedFacts.aabb!,top=bounds.max[2]!,centre=[(bounds.min[0]!+bounds.max[0]!)/2,(bounds.min[1]!+bounds.max[1]!)/2],owner=scene.entities[0]!.entityId
  scene.entities.push({entityId:'pallet-drop-probe',name:'原生落体正对照',transform:{position:[centre[0]!,centre[1]!,top+.7],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{collision:{shape:'box',halfExtents:[.05,.05,.05]},rigidBody:{type:'dynamic',massKg:1}}})
  scene.entities.push({entityId:'tick-hinge',name:'有界时钟动作',transform:{position:[5,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{isaac:{sourcePath:join(clockSource,'joint.usda')}}})
  await writeFile(join(nativeOut,'scene.json'),JSON.stringify(scene,null,2));provider=new IsaacProvider({...config,cacheRoot:join(nativeOut,'cache-meters')})
  const world=await provider.open(scene,{worldId:'pallet-meters-native',clock:'manual',ground:false,timestepS:.002}),before=await provider.observe(world.worldId,{contacts:true,sensors:true,collisionTopology:{entityIds:[owner],includeGeometry:true}})
  const action=await provider.execute(world.worldId,{actionId:'pallet-drop-clock',expectedGeneration:world.worldGeneration,kind:'control',entityId:'tick-hinge',jointNames:['Hinge'],positions:[.2],stepCount:600}),after=await provider.observe(world.worldId,{contacts:true,sensors:true,collisionTopology:{entityIds:[owner],includeGeometry:true}})
  const drop=after.entities.find(entity=>entity.entityId==='pallet-drop-probe')!,initial=before.entities.find(entity=>entity.entityId==='pallet-drop-probe')!,contacts=(after.contacts??[]).filter(contact=>[contact.geom1,contact.geom2].some(geom=>geom.startsWith(owner+'/'))&&[contact.geom1,contact.geom2].some(geom=>geom.startsWith('pallet-drop-probe/')))
  native.meters={world,before,after,action,contacts,verticalSupportForceN:contacts.reduce((sum,contact)=>sum+(contact.forceN?.[2]??0),0)}
  assert.equal(action.status,'completed');assert(contacts.length>0);assert(drop.transform.position[2]<initial.transform.position[2]-.2);assert(drop.transform.position[2]>top-.1);assert(Math.abs(native.meters.verticalSupportForceN-9.81)<.2);assert.equal(after.collisionTopology?.geoms.filter(geom=>geom.entityId===owner).length,1)
  native.status='PASSED'
 }catch(error){native.status='FAILED';native.error=String(error);process.exitCode=1}
 finally{if(provider){await provider.dispose();native.closed=true}await writeFile(join(nativeOut,'receipt.json'),JSON.stringify(native,null,2));Object.assign(receipt,{native})}
}
await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({status:receipt.status,portable:receipt.portable,previewTextures:receipt.preview.textures?.length,sourceRootRemoved:true}))
