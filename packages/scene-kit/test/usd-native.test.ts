/** envgate：需要本地usd-core；不联网，不启动物理引擎。按清单显式纳入后运行。 */
import {test,expect} from 'bun:test'
import {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import Commands from '@deepseek-ai/dsh-commands'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import Sessions,{SessionId} from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as scenePlugin from '../src/plugin.ts'
import {execFileSync} from 'node:child_process'
import {mkdtemp,readFile,writeFile,rename,rm,mkdir,stat} from 'node:fs/promises'
import {join,dirname,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {simreadyImport,type SimreadyFetch} from '../src/simready-assets.ts'
import {projectPathsOnly,matchResourceToken} from '../../lyapunov-contracts/src/product-paths.ts'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {SceneOperations} from '../src/operations.ts'
import {parseAsset,fileStamp} from '../src/formats.ts'
import {inspectUsd,setUsdInstance,usdPython} from '../src/usd-assets.ts'
import {buildUsdVisual} from '../../viewer/src/usd-visual.ts'
import * as THREE from 'three'
import {registerNvidiaUsdStandardLibrary,USD_STANDARD_LIBRARY_MIME} from '../src/usd-standard-libraries.ts'

test.skipIf(!process.env.LYAPUNOV_USD_CORE_MATERIALS)('固定真实SDK OmniPBR子集：ORM lerp、DX法线和源身份；未知模块/连接/UV拒绝（需显式SDK模块）',async()=>{
 const root=await mkdtemp(join(tmpdir(),'omnipbr-native-'))
 try{
  const ops=new SceneOperations(join(root,'data')),library=await registerNvidiaUsdStandardLibrary(ops.resources,process.env.LYAPUNOV_USD_CORE_MATERIALS!)
  const manifest=fileURLToPath(library.ref.original.uri),sha=(await fileStamp(manifest)).sha256
  const source=join(root,'source');execFileSync(usdPython(),[join(import.meta.dir,'fixtures/usd/make_omnipbr_fixture.py'),source])
  const declaration={resourceId:library.ref.resourceId,version:library.ref.version,manifestPath:manifest,manifestSha256:sha,assetIdentifier:'OmniPBR.mdl',subIdentifier:'OmniPBR'}
  await writeFile(join(source,'lyapunov-source.json'),JSON.stringify({schema:'lyapunov.simready-source.v1',rootUsd:'uv-normal.usda',standardLibraries:[declaration]}))
  const entry=join(source,'uv-normal.usda'),before=(await fileStamp(entry)).sha256,facts=await inspectUsd(entry),material=facts.usd.preview.shapes[0]!.material!
  expect(material.shader).toBe('OmniPBR');expect(material.sourceModule?.derivation).toBe('pinned-omnipbr-subset');expect(facts.usd.preview.textures).toHaveLength(3)
  expect(material.roughnessTexture?.channel).toBe('g');expect(material.roughnessTexture?.scale[1]).toBeCloseTo(.25);expect(material.roughnessTexture?.bias[1]).toBeCloseTo(.6)
  expect(material.metallicTexture?.channel).toBe('b');expect(material.metallicTexture?.scale[2]).toBeCloseTo(.75);expect(material.metallicTexture?.bias[2]).toBeCloseTo(.1)
  expect(material.baseColorTexture?.colorSpace).toBe('sRGB');expect(material.normalTexture?.colorSpace).toBe('raw');expect(material.normalTexture?.scale).toEqual([1,-1,2,1]);expect(material.normalTexture?.bias).toEqual([-.5,.5,-1,0])
  expect(.25*89/255+.6).toBeCloseTo(material.roughnessTexture!.scale[1]*89/255+material.roughnessTexture!.bias[1],6)
  expect(facts.usd.preview.losses.some(value=>value.includes('USD_OMNIPBR_SUBSET_DERIVED'))).toBe(true);expect((await fileStamp(entry)).sha256).toBe(before)
  for(const flag of ['--connected','--nonidentity-uv']){
   execFileSync(usdPython(),[join(import.meta.dir,'fixtures/usd/make_omnipbr_fixture.py'),source,flag]);const denied=await inspectUsd(entry)
   expect(denied.usd.preview.shapes[0]!.material).toBeUndefined();expect(denied.usd.preview.textures).toHaveLength(0);expect(denied.usd.preview.losses.some(value=>value.includes(flag==='--connected'?'USD_OMNIPBR_CONNECTION_UNSUPPORTED':'USD_OMNIPBR_UV_UNSUPPORTED'))).toBe(true)
  }
  execFileSync(usdPython(),[join(import.meta.dir,'fixtures/usd/make_omnipbr_fixture.py'),source]);await writeFile(join(source,'lyapunov-source.json'),JSON.stringify({schema:'lyapunov.simready-source.v1',rootUsd:'uv-normal.usda'}))
  // 同名OmniPBR可由source邻接文件解析，但没有验证标准库身份时不能猜映射。
  await writeFile(join(source,'OmniPBR.mdl'),'mdl 1.7; export material OmniPBR()=material();')
  const unverified=await inspectUsd(entry);expect(unverified.usd.preview.shapes[0]!.material).toBeUndefined();expect(unverified.usd.preview.losses.some(value=>value.includes('USD_OMNIPBR_MODULE_UNVERIFIED'))).toBe(true)
 }finally{await rm(root,{recursive:true,force:true})}
},120000)

test('标准MDL模块是独立有许可资源，旧Warehouse只解析明确兼容导出；源HF与标准库身份分开并可独立搬迁',async()=>{
 const root=await mkdtemp(join(tmpdir(),'warehouse-standard-native-'))
 try{
  const site=join(root,'sdk/site'),core=join(site,'isaacsim/kit/mdl/core'),put=async(path:string,text:string)=>{await mkdir(dirname(path),{recursive:true});await writeFile(path,text)}
  await put(join(site,'isaacsim_kernel-6.0.1.0.dist-info/METADATA'),'Name: isaacsim-kernel\nVersion: 6.0.1.0\n')
  await put(join(core,'VERSION.md'),'2.1.0\n');await put(join(core,'PACKAGE-LICENSES/omni-core-materials-LICENSE.md'),'BSD-3-Clause 自有测试标准模块\n')
  await put(join(core,'Base/OmniPBR.mdl'),'// SPDX-License-Identifier: BSD-3-Clause\nmdl 1.7;\nexport material OmniPBR(uniform texture_2d diffuse_texture=texture_2d())=material();\n')
  const ops=new SceneOperations(join(root,'data')),library=await registerNvidiaUsdStandardLibrary(ops.resources,core)
  const {loadWarehouseCatalog,gitBlob,WAREHOUSE_REPO,WAREHOUSE_REVISION}=await import('../src/warehouse-catalog.ts'),{warehouseImport}=await import('../src/warehouse-assets.ts')
  const catalog=await loadWarehouseCatalog(),row={...catalog.rows[0]!,name:'SELF_OWNED_STANDARD_MODULE_TEST',catalogPath:'Props/test/prop.usda'},raw=Buffer.from('#usda 1.0\n(\n defaultPrim="Prop"\n metersPerUnit=1\n upAxis="Z"\n)\ndef Xform "Prop" {\n def Cube "Cube" {\n double size=1\n }\n def Material "M" {\n token outputs:mdl:surface.connect=</Prop/M/Shader.outputs:out>\n def Shader "Shader" {\n uniform token info:implementationSource="sourceAsset"\n uniform asset info:mdl:sourceAsset=@OmniPBR.mdl@\n uniform token info:mdl:sourceAsset:subIdentifier="OmniPBR"\n token outputs:out\n }\n }\n}\n')
  const selected={repoId:WAREHOUSE_REPO,revision:WAREHOUSE_REVISION,packagePath:row.catalogPath},fixtureCatalog={...catalog,rows:[row],files:new Map([[row.catalogPath,{path:row.catalogPath,size:raw.length,gitBlob:gitBlob(raw)}]])},fetchBytes:SimreadyFetch=async()=>raw
  await ops.create({sceneId:'standard'})
  const imported=await warehouseImport(ops,{...selected,resourceId:'test-standard-prop',sceneId:'standard',entityId:'prop'},{catalog:fixtureCatalog,fetchBytes})
  expect(imported.verification.valid).toBe(true);expect(imported.source.files).toHaveLength(1);expect(imported.source.standardLibraries).toHaveLength(1);expect(imported.source.files.some(file=>file.relative_path.endsWith('.mdl'))).toBe(false)
  expect((await readFile(join(imported.packageDirectory,row.catalogPath))).equals(raw)).toBe(true)
  const entity=imported.snapshot!.entities[0]!;expect(entity.resources[0]!.original.mimeType).toBe('model/vnd.usd');expect(entity.resources.filter(ref=>ref.original.mimeType===USD_STANDARD_LIBRARY_MIME)).toHaveLength(1)
  expect((await inspectUsd(join(imported.packageDirectory,row.catalogPath))).files.some(path=>path.endsWith('Base/OmniPBR.mdl'))).toBe(true)
  const again=await warehouseImport(ops,{...selected,resourceId:'test-standard-prop'},{catalog:fixtureCatalog,fetchBytes});expect(again.resource.ref.version).toBe(imported.resource.ref.version)
  await ops.save('standard',join(root,'portable/scene.json'),{portable:true});await rename(join(root,'portable'),join(root,'moved'));await rm(join(root,'sdk'),{recursive:true});await rm(join(root,'data'),{recursive:true})
  const reopened=new SceneOperations(join(root,'reopened')),scene=await reopened.open(join(root,'moved/scene.json'),{sceneId:'moved-standard'}),std=scene.entities[0]!.resources.find(ref=>ref.original.mimeType===USD_STANDARD_LIBRARY_MIME)!
  expect(std.resourceId).toBe(library.ref.resourceId);expect((await reopened.resources.get(std.resourceId,std.version)).license?.id).toBe('BSD-3-Clause')
  for(const ref of scene.entities[0]!.resources)expect((await reopened.resources.verifyReference(ref)).valid).toBe(true)
  await reopened.mount({sceneId:scene.sceneId,resourceId:imported.resource.ref.resourceId,entityId:'again'})
  expect((await reopened.scene.snapshot(scene.sceneId)).entities[1]!.resources.some(ref=>ref.resourceId===library.ref.resourceId)).toBe(true)
 }finally{await rm(root,{recursive:true,force:true})}
},120000)

test('Transform2d按SRT组合；packed通道/normal解码与作者法线、indexed非uniform UV保真',async()=>{
 const root=await mkdtemp(join(tmpdir(),'usd-uv-normal-'))
 try{
  execFileSync(usdPython(),[join(import.meta.dir,'fixtures/usd/make_uv_normal_fixture.py'),root])
  const parsed=await inspectUsd(join(root,'uv-normal.usda')),shape=parsed.usd.preview.shapes[0]!,material=shape.material!
  expect(parsed.usd.preview.textures).toHaveLength(3);expect(parsed.usd.preview.losses.some(value=>value.includes('UV_NETWORK_UNSUPPORTED')||value.includes(':normal'))).toBe(false)
  expect(material.baseColorTexture?.colorSpace).toBe('sRGB');expect(material.roughnessTexture?.channel).toBe('g');expect(material.metallicTexture?.channel).toBe('b');expect(material.normalTexture?.colorSpace).toBe('raw');expect(material.normalTexture?.scale).toEqual([2,2,2,2]);expect(material.normalTexture?.bias).toEqual([-1,-1,-1,-1])
  const transform=new THREE.Matrix3().fromArray(material.baseColorTexture!.uvTransform!)
  const step=(point:number[],scale:number[],angle:number,translation:number[])=>{const x=point[0]!*scale[0]!,y=point[1]!*scale[1]!,a=angle*Math.PI/180;return [x*Math.cos(a)-y*Math.sin(a)+translation[0]!,x*Math.sin(a)+y*Math.cos(a)+translation[1]!]}
  for(const uv of [[0,0],[1,0],[0,1],[2,-1]]){const expected=step(step(uv,[2,3],90,[.25,-.5]),[.5,-1],-30,[-.1,.2]),actual=new THREE.Vector3(uv[0],uv[1],1).applyMatrix3(transform);expect(actual.x).toBeCloseTo(expected[0]!,6);expect(actual.y).toBeCloseTo(expected[1]!,6)}
  expect(shape.uvInterpolation).toBe('faceVarying');expect(shape.uvs).toHaveLength(8);expect(shape.uvs![4]).toEqual([3,1]);expect(shape.orientation).toBe('leftHanded');expect(shape.normalInterpolation).toBe('uniform')
  const visual=buildUsdVisual(parsed.usd.preview),mesh=visual.children[0]as THREE.Mesh<THREE.BufferGeometry>,normal=mesh.geometry.getAttribute('normal'),uv=mesh.geometry.getAttribute('uv')
  expect(normal.count).toBe(12);expect(uv.count).toBe(12)
  for(let i=0;i<normal.count;i++){expect(normal.getZ(i)).toBeCloseTo(-Math.SQRT1_2,6);expect(normal.getX(i)+normal.getY(i)).toBeCloseTo(Math.SQRT1_2,6)}
  const position=mesh.geometry.getAttribute('position'),a=new THREE.Vector3().fromBufferAttribute(position,0),b=new THREE.Vector3().fromBufferAttribute(position,1),c=new THREE.Vector3().fromBufferAttribute(position,2);expect(b.sub(a).cross(c.sub(a)).z).toBeLessThan(0)
  // 几何本在XY平面；保留作者45度倾斜法线，不能被重算成(0,0,±1)。
  expect(Array.from({length:normal.count},(_,i)=>normal.getX(i))).toContain(Math.fround(Math.SQRT1_2));expect(Array.from({length:normal.count},(_,i)=>normal.getY(i))).toContain(Math.fround(Math.SQRT1_2))
  // 参数本地fallback=-30°，但接口连接值=45°；不支持该连接时必须拒绝纹理网络，不能静默按fallback画。
  execFileSync(usdPython(),[join(import.meta.dir,'fixtures/usd/make_uv_normal_fixture.py'),join(root,'connected'),'--connected-rotation'])
  const connected=await inspectUsd(join(root,'connected/uv-normal.usda'))
  expect(connected.usd.preview.textures).toHaveLength(0);expect(connected.usd.preview.shapes[0]!.material?.baseColorTexture).toBeUndefined()
  expect(connected.usd.preview.losses.some(value=>value.includes('USD_TEXTURE_UV_PARAMETER_CONNECTION_UNSUPPORTED')&&value.endsWith(':rotation'))).toBe(true)
 }finally{await rm(root,{recursive:true,force:true})}
},120000)

test('USD、USDC、USDZ原件为主资产；静态/关节事实来自pxr，缺件拒绝',async()=>{
 const root=await mkdtemp(join(tmpdir(),'usd-native-'))
 try{
  execFileSync(usdPython(),[join(import.meta.dir,'fixtures/usd/make_fixture.py'),root])
  for(const file of ['prop.usda','joint.usdc','prop.usdz'])expect((await parseAsset(join(root,file))).kind).toBe('usd')
  const joint=await inspectUsd(join(root,'joint.usdc'));expect(joint.usd.physics.joints).toContain('/Robot/Hinge');expect(joint.usd.physics.rigidBodies.length).toBe(2)
  await writeFile(join(root,'missing.usda'),'#usda 1.0\n(\n subLayers=[@missing-layer.usda@]\n)\n')
  await expect(parseAsset(join(root,'missing.usda'))).rejects.toThrow('USD_DEPENDENCY_MISSING')
 }finally{await rm(root,{recursive:true,force:true})}
},120000)

test('同USD两实例独立变体与变换；原件sha不变，派生预览有prim映射；移包重开与完整导出',async()=>{
 const root=await mkdtemp(join(tmpdir(),'usd-lifecycle-'))
 try{
  execFileSync(usdPython(),[join(import.meta.dir,'fixtures/usd/make_fixture.py'),join(root,'fixtures')])
  const path=join(root,'fixtures/prop.usda'),sha=(await fileStamp(path)).sha256
  const ops=new SceneOperations(join(root,'data'));await ops.create({sceneId:'demo'})
  const imported=await ops.import({path,sceneId:'demo',entityId:'a',physicalize:false})
  const original=imported.resource.ref
  expect(original.original.mimeType).toBe('model/vnd.usd');expect(original.representations.every(rep=>rep.mimeType!=='model/gltf-binary')).toBe(true)
  await ops.mount({sceneId:'demo',resourceId:original.resourceId,entityId:'b',transform:{position:[3,0,0],quaternion:[0,0,0,1],scale:[1,1,1]}})
  let scene=await ops.scene.snapshot('demo')
  scene=await setUsdInstance(ops,{sceneId:'demo',entityId:'b',expectedRevision:scene.revision,variants:{'/Prop':{shape:'large'}}})
  expect(scene.entities[1]!.transform.position).toEqual([3,0,0])
  const sizes:number[]=[]
  for(const entity of scene.entities){
   expect(JSON.stringify(entity).length).toBeLessThan(6000)
   const preview=entity.resources.find(ref=>ref.original.mimeType==='application/vnd.lyapunov.usd-preview+json')!
   const payload=JSON.parse(await readFile(fileURLToPath(preview.original.uri),'utf8'))
   const view=buildUsdVisual(payload.preview);expect(view.children.length).toBe(1);expect(view.children[0]!.userData.usdPrimPath).toBe('/Prop/Cube');sizes.push(payload.preview.shapes[0].size)
  }
  expect(sizes).toEqual([1,2]);expect((await fileStamp(path)).sha256).toBe(sha)
  await ops.save('demo',join(root,'export/scene.json'),{portable:true});await rename(join(root,'export'),join(root,'moved'))
  await rm(join(root,'fixtures'),{recursive:true});await rm(join(root,'data'),{recursive:true})
  const reopened=new SceneOperations(join(root,'reopened')),loaded=await reopened.open(join(root,'moved/scene.json'),{sceneId:'restored'})
  expect(loaded.entities.length).toBe(2);expect((loaded.entities[1]!.components.usd as any).variants['/Prop'].shape).toBe('large')
  expect((await reopened.resources.verify(loaded.entities[0]!.resources[0]!.resourceId,loaded.entities[0]!.resources[0]!.version)).valid).toBe(true)
 }finally{await rm(root,{recursive:true,force:true})}
},120000)

test('USD完整闭包包含非活动variant payload、纹理与绝对引用；便携副本改写不动原件',async()=>{
 const root=await mkdtemp(join(tmpdir(),'usd-closure-'))
 try{
  execFileSync(usdPython(),[join(import.meta.dir,'fixtures/usd/make_fixture.py'),join(root,'source')])
  const layer=join(root,'source','prop.usda')
  const absolute=join(root,'source','absolute.usda')
  await writeFile(absolute,`#usda 1.0\n(\n defaultPrim="Wrapper"\n metersPerUnit=1\n upAxis="Z"\n)\ndef Xform "Wrapper" (\n references=@${layer}@</Prop>\n) {}\n`)
  const dependencyNames=(await parseAsset(layer)).dependencies.map(row=>row.path.split('/').at(-1));expect(dependencyNames).toContain('extra.usda');expect(dependencyNames).toContain('texture.png')
  const before=(await fileStamp(absolute)).sha256,ops=new SceneOperations(join(root,'data'))
  await ops.create({sceneId:'absolute'});await ops.import({path:absolute,storage:'reference',sceneId:'absolute',physicalize:false})
  const saved=await ops.save('absolute',join(root,'export/scene.json'),{portable:true})
  expect((await fileStamp(absolute)).sha256).toBe(before)
  await rm(join(root,'source'),{recursive:true})
  const opened=await new SceneOperations(join(root,'reopen')).open(join(root,'export/scene.json'),{sceneId:'after'})
  expect(opened.entities.length).toBe(1)
 }finally{await rm(root,{recursive:true,force:true})}
},120000)

test('同字节不同相对路径的USD layers均随包；绝对引用副本独立改写且搬迁脱离原件',async()=>{
 const root=await mkdtemp(join(tmpdir(),'usd-layer-alias-')),source=join(root,'source')
 try{
  await mkdir(join(source,'a'),{recursive:true});await mkdir(join(source,'b/deep'),{recursive:true})
  const geometry=join(source,'geometry.usda'),entry=join(source,'scene.usda')
  await writeFile(geometry,'#usda 1.0\nover "Root" {\n def Cube "Box" {\n double size = 0.2\n }\n}\n')
  const same=`#usda 1.0\n(\n subLayers = [@${geometry}@]\n)\n`
  await writeFile(join(source,'a/empty.usda'),same);await writeFile(join(source,'b/deep/empty.usda'),same)
  await writeFile(entry,'#usda 1.0\n(\n defaultPrim = "Root"\n metersPerUnit = 1\n upAxis = "Z"\n subLayers = [@a/empty.usda@, @b/deep/empty.usda@]\n)\ndef Xform "Root" {}\n')
  const before=await Promise.all(['scene.usda','geometry.usda','a/empty.usda','b/deep/empty.usda'].map(async file=>(await fileStamp(join(source,file))).sha256))
  const ops=new SceneOperations(join(root,'catalog'));await ops.create({sceneId:'layers'});await ops.import({path:entry,storage:'reference',sceneId:'layers',physicalize:false})
  await ops.save('layers',join(root,'export/scene.json'),{portable:true})
  const document=JSON.parse(await readFile(join(root,'export/scene.json'),'utf8')),ref=document.entities[0].resources.find((row:any)=>row.original.mimeType==='model/vnd.usd')
  const copiedRoot=dirname(resolve(root,'export',ref.original.uri)),a=join(copiedRoot,'a/empty.usda'),b=join(copiedRoot,'b/deep/empty.usda')
  expect((await readFile(a,'utf8'))).toContain('@../geometry.usda@');expect((await readFile(b,'utf8'))).toContain('@../../geometry.usda@')
  expect((await stat(a)).ino).not.toBe((await stat(b)).ino)
  expect(await Promise.all(['scene.usda','geometry.usda','a/empty.usda','b/deep/empty.usda'].map(async file=>(await fileStamp(join(source,file))).sha256))).toEqual(before)
  await rename(join(root,'export'),join(root,'moved'));await rm(source,{recursive:true});await rm(join(root,'catalog'),{recursive:true})
  const reopened=new SceneOperations(join(root,'reopened')),scene=await reopened.open(join(root,'moved/scene.json'),{sceneId:'moved-layers'})
  const usd=scene.entities[0]!.resources.find(row=>row.original.mimeType==='model/vnd.usd')!,inspection=await inspectUsd(fileURLToPath(usd.original.uri))
  expect(inspection.files).toHaveLength(4);expect(inspection.files.every(path=>path.startsWith(join(root,'moved')+'/'))).toBe(true)
  expect((await reopened.resources.verifyReference(usd)).valid).toBe(true)
 }finally{await rm(root,{recursive:true,force:true})}
},120000)

test('真实ToolRegistry与CommandRegistry的USD入口同路；只读预览不写库，陈旧CAS不产派生',async()=>{
 const root=await mkdtemp(join(tmpdir(),'usd-tool-')),ctx=new Context(),signal=new AbortController().signal
 try{
  execFileSync(usdPython(),[join(import.meta.dir,'fixtures/usd/make_fixture.py'),join(root,'source')])
  await ctx.plugin(SystemPrompt);await ctx.plugin(Tools);await ctx.plugin(Sessions);await ctx.plugin(Commands);await ctx.plugin(scenePlugin,{dataRoot:join(root,'catalog'),productRoot:join(root,'no-builtin')})
  const session=ctx.sessions.create(SessionId('usd-test'));const agent={id:session.id,session} as Agent;let n=0
  const call=async(name:string,input:unknown)=>{const result=await ctx.tools.execute({callId:ToolCallId('usd-'+(++n)),name,arguments:{input},signal,agent});if(result.isError)throw Error(result.error.message);return result.value as any}
  await call('scene_create',{sceneId:'scene'})
  const imported=await call('scene_import',{path:join(root,'source/prop.usda'),sceneId:'scene',entityId:'prop',physicalize:false})
  const listed=await call('asset_list',{}),count=listed.length
  const preview=await call('asset_placement_preview',{sceneId:'scene',resourceId:imported.resource.ref.resourceId,version:imported.resource.ref.version,token:'preview'})
  expect(preview.status).toBe('PREVIEW');expect((await call('asset_list',{})).length).toBe(count)
  const scene=await call('scene_inspect',{sceneId:'scene'})
  const command=await ctx.commands.execute(agent,'/scene_usd_instance '+JSON.stringify({sceneId:'scene',entityId:'prop',expectedRevision:scene.revision,variants:{'/Prop':{shape:'large'}}}),[],signal)
  expect(command?.result.kind).toBe('success')
  const changed=await call('scene_inspect',{sceneId:'scene'});expect(changed.entities.find((row:any)=>row.entityId==='prop').components.usd.variants['/Prop'].shape).toBe('large')
  const before=(await call('asset_list',{})).length
  const stale=await ctx.tools.execute({callId:ToolCallId('stale'),name:'scene_usd_instance',arguments:{input:{sceneId:'scene',entityId:'prop',expectedRevision:scene.revision,variants:{'/Prop':{shape:'small'}}}},signal,agent})
  expect(stale.isError).toBe(true);expect((await call('asset_list',{})).length).toBe(before)
 }finally{await rm(root,{recursive:true,force:true})}
},120000)

test('SimReady完整包经真实ResourceLibrary/Scene入口入库导出；坏hash、缺payload与预算分别阻断',async()=>{
 const root=await mkdtemp(join(tmpdir(),'simready-native-'))
 try{
  const source=join(root,'fixture');execFileSync(usdPython(),[join(import.meta.dir,'fixtures/usd/make_fixture.py'),source])
  const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex'),bytes=(value:unknown)=>Buffer.from(JSON.stringify(value))
  const content=new Map<string,Uint8Array>()
  for(const file of ['prop.usda','extra.usda','texture.png'])content.set('simready_usd/'+file,await readFile(join(source,file)))
  const selection={repoId:'nvidia/simready-assets',revision:'a'.repeat(40),packagePath:'fixture/com.nvidia.simready.packaging.json'}
  const fetcher=(badHash=false,missing=false):SimreadyFetch=>{
   const files=[...content].filter(([path])=>!missing||!path.endsWith('extra.usda')).map(([relative_path,body])=>({relative_path,size:body.length,hash:{sha256:sha(body)}}))
   const bom=bytes({format_version:'1.0',items:files}),roots=bytes({root_usds:['simready_usd/prop.usda']}),metadata=[{name:'com.nvidia.simready.packaging.bom.json',hash:{sha256:sha(bom)}},{name:'com.nvidia.simready.root_usds.json',hash:{sha256:sha(roots)}}]
   const descriptor=bytes({format_version:'1.0',package_id:'simready.fixture.prop.1',license:'CC-BY-4.0',metadata})
   return async url=>{const path=decodeURIComponent(new URL(url).pathname.split('/resolve/'+selection.revision+'/')[1]!).replace(/^fixture\//,'');if(path==='com.nvidia.simready.packaging.json')return descriptor;if(path.endsWith('packaging.bom.json'))return bom;if(path.endsWith('root_usds.json'))return roots;const value=content.get(path);if(!value)throw Error('fixture file missing: '+path);return badHash&&path.endsWith('prop.usda')?Buffer.from('corrupt'):value}
  }
  const ops=new SceneOperations(join(root,'data'));await ops.create({sceneId:'scene'})
  const imported=await simreadyImport(ops,{...selection,sceneId:'scene',maxBytes:100000},{fetchBytes:fetcher()})
  expect(imported.verification.valid).toBe(true);expect(imported.resource.ref.original.mimeType).toBe('model/vnd.usd');expect(imported.resource.license?.id).toBe('CC-BY-4.0')
  const replayed=await simreadyImport(ops,{...selection,maxBytes:100000},{fetchBytes:fetcher()});expect(replayed.resource.ref).toEqual(imported.resource.ref);expect(replayed.verification.valid).toBe(true)
  expect(imported.resource.parsed.dependencies.some(row=>row.path.endsWith('com.nvidia.simready.packaging.json'))).toBe(true)
  expect(imported.resource.parsed.dependencies.some(row=>row.path.endsWith('com.nvidia.simready.packaging.bom.json'))).toBe(true)
  await ops.save('scene',join(root,'portable/scene.json'),{portable:true})
  const bad=new SceneOperations(join(root,'bad'));await expect(simreadyImport(bad,{...selection,maxBytes:100000},{fetchBytes:fetcher(true)})).rejects.toThrow('SIMREADY_HASH_MISMATCH');expect((await bad.resources.list()).length).toBe(0)
  const missing=new SceneOperations(join(root,'missing'));await expect(simreadyImport(missing,{...selection,maxBytes:100000},{fetchBytes:fetcher(false,true)})).rejects.toThrow('USD_DEPENDENCY_MISSING');expect((await missing.resources.list()).length).toBe(0)
  await expect(simreadyImport(new SceneOperations(join(root,'budget')),{...selection,maxBytes:100},{fetchBytes:fetcher()})).rejects.toThrow('SIMREADY_BYTE_BUDGET_EXCEEDED')
 }finally{await rm(root,{recursive:true,force:true})}
},120000)

test('真实UsdPreviewSurface/纹理和UV进入可搬迁派生资源；实例变体不改源属性，USDZ内纹理也可提取',async()=>{
 const root=await mkdtemp(join(tmpdir(),'usd-material-'))
 try{
  const source=join(root,'source');execFileSync(usdPython(),[join(import.meta.dir,'fixtures/usd/make_material_fixture.py'),source])
  const path=join(source,'material.usda'),original=(await fileStamp(path)).sha256,inspection=await inspectUsd(path)
  const textured=inspection.usd.preview.shapes.find(row=>row.primPath==='/MaterialDemo/Textured')!
  expect(textured.material?.baseColorTexture?.colorSpace).toBe('sRGB');expect(textured.material?.roughness).toBeCloseTo(.37);expect(textured.material?.metallic).toBeCloseTo(.2);expect(textured.uvInterpolation).toBe('faceVarying');expect(textured.uvs).toHaveLength(8)
  const unsupported=join(source,'unsupported.usda');await writeFile(unsupported,(await readFile(path,'utf8')).replaceAll('"UsdPreviewSurface"','"ArbitraryMdlLikeShader"'))
  const unsupportedFacts=await inspectUsd(unsupported);expect(unsupportedFacts.usd.preview.losses.some(row=>row.includes('USD_MATERIAL_SHADER_UNSUPPORTED'))).toBe(true)
  const ops=new SceneOperations(join(root,'data'));await ops.create({sceneId:'material'})
  const imported=await ops.import({path,sceneId:'material',entityId:'warm',physicalize:false})
  const preview=await ops.previewMount({sceneId:'material',resourceId:imported.resource.ref.resourceId,version:imported.resource.ref.version})
  const projected=projectPathsOnly(preview) as any,token=projected.entities[0].components.visual.usdTransientPreview.textures[0].uri
  const candidates=imported.resource.parsed.dependencies.flatMap(row=>[row.path,pathToFileURL(row.path).href])
  expect(matchResourceToken(token,candidates)?.endsWith('checker.png')).toBe(true)
  const sourceFacts=(imported.snapshot!.entities.find(row=>row.entityId==='warm')!.components.usd as any).sourceFacts;expect(sourceFacts.purpose).toBe('object');expect(sourceFacts.physics).toEqual({collisions:0,rigidBodies:0,joints:0,articulations:0});expect(sourceFacts.resourceId).toBe(imported.resource.ref.resourceId)
  await ops.mount({sceneId:'material',resourceId:imported.resource.ref.resourceId,entityId:'cool'})
  let scene=await ops.scene.snapshot('material');scene=await setUsdInstance(ops,{sceneId:'material',entityId:'cool',expectedRevision:scene.revision,variants:{'/MaterialDemo':{finish:'cool'}}})
  for(const [index,entity]of scene.entities.entries()){
   const ref=entity.resources.find(row=>row.original.mimeType==='application/vnd.lyapunov.usd-preview+json')!,record=await ops.resources.get(ref.resourceId,ref.version)
   const payload=JSON.parse(await readFile(fileURLToPath(ref.original.uri),'utf8')),solid=payload.preview.shapes.find((row:any)=>row.primPath==='/MaterialDemo/Solid')
   expect(solid.material.baseColor[index===0?0:2]).toBeCloseTo(.8);expect(JSON.stringify(payload)).not.toContain(source)
   const texture=payload.preview.textures[0];expect(ref.representations.some(row=>row.role==='usd-texture:'+texture.id&&row.mimeType==='image/png')).toBe(true);expect(record.parsed.dependencies).toHaveLength(2)
  }
  expect((await fileStamp(path)).sha256).toBe(original)
  await ops.save('material',join(root,'portable/scene.json'),{portable:true});await rename(join(root,'portable'),join(root,'moved'));await rm(source,{recursive:true});await rm(join(root,'data'),{recursive:true})
  const reopened=new SceneOperations(join(root,'reopened')),loaded=await reopened.open(join(root,'moved/scene.json'),{sceneId:'again'})
  for(const entity of loaded.entities){const preview=entity.resources.find(row=>row.original.mimeType==='application/vnd.lyapunov.usd-preview+json')!;const texture=preview.representations.find(row=>row.role?.startsWith('usd-texture:'))!;expect((await readFile(fileURLToPath(texture.uri))).subarray(1,4).toString()).toBe('PNG');expect((await reopened.resources.verify(preview.resourceId,preview.version)).valid).toBe(true)}
  const archive=join(root,'archive');execFileSync(usdPython(),[join(import.meta.dir,'fixtures/usd/make_material_fixture.py'),archive])
  const zipped=await reopened.import({path:join(archive,'material.usdz'),physicalize:false});expect(zipped.resource.parsed.kind).toBe('usd')
  await reopened.create({sceneId:'zip'});const mounted=await reopened.mount({sceneId:'zip',resourceId:zipped.resource.ref.resourceId,entityId:'zip'})
  expect(mounted.snapshot.entities[0]!.resources.some(ref=>ref.representations.some(row=>row.role?.startsWith('usd-texture:')))).toBe(true)
 }finally{await rm(root,{recursive:true,force:true})}
},120000)

test('旧Warehouse本地合法fixture按逐layer闭包和源文件身份入库；重复缓存不改版本，缺身份/坏hash阻断',async()=>{
 const {loadWarehouseCatalog,gitBlob,sha256,WAREHOUSE_REPO,WAREHOUSE_REVISION}=await import('../src/warehouse-catalog.ts'),{warehouseImport}=await import('../src/warehouse-assets.ts')
 const root=await mkdtemp(join(tmpdir(),'warehouse-native-'))
 try{
  const fixture=join(root,'fixture');execFileSync(usdPython(),[join(import.meta.dir,'fixtures/usd/make_material_fixture.py'),fixture])
  const catalog=await loadWarehouseCatalog(),row=catalog.rows.find(row=>row.label==='book'&&row.catalogPath.endsWith('.usd'))!,imagePath=row.catalogPath.slice(0,row.catalogPath.lastIndexOf('/')+1)+'checker.png'
  const body=await readFile(join(fixture,'material.usda')),image=await readFile(join(fixture,'checker.png'))
  const files=new Map([[row.catalogPath,{path:row.catalogPath,size:body.length,gitBlob:gitBlob(body)}],[imagePath,{path:imagePath,size:image.length,gitBlob:'1'.repeat(40),lfsSha256:sha256(image)}]])
  const selected={repoId:WAREHOUSE_REPO,revision:WAREHOUSE_REVISION,packagePath:row.catalogPath},calls:string[]=[]
  const fetchBytes:import('../src/simready-assets.ts').SimreadyFetch=async url=>{expect(new URL(url).hostname).toBe('hf-mirror.com');const path=decodeURIComponent(new URL(url).pathname.split('/resolve/'+WAREHOUSE_REVISION+'/')[1]!);calls.push(path);if(path===row.catalogPath)return body;if(path===imagePath)return image;throw Error('fixture unexpected source '+path)}
  const ops=new SceneOperations(join(root,'ok')),options={fetchBytes,catalog:{...catalog,files}}
  const imported=await warehouseImport(ops,{...selected,maxBytes:100000},options)
  expect(imported.verification.valid).toBe(true);expect(imported.source.sourceProtocol).toBe('warehouse-csv-v1');expect(imported.source.sourceValidation).toBe('NOT_PROVIDED_BY_LEGACY_CSV');expect(imported.source).not.toHaveProperty('packageId');expect(calls).toHaveLength(2)
  const again=await warehouseImport(ops,{...selected,maxBytes:100000},options);expect(again.resource.ref).toEqual(imported.resource.ref);expect(calls).toHaveLength(2)
  const missingFiles=new Map(files);missingFiles.delete(imagePath)
  await expect(warehouseImport(new SceneOperations(join(root,'missing')),{...selected,maxBytes:100000},{...options,catalog:{...catalog,files:missingFiles}})).rejects.toThrow('WAREHOUSE_DEPENDENCY_IDENTITY_UNAVAILABLE')
  await expect(warehouseImport(new SceneOperations(join(root,'corrupt')),{...selected,maxBytes:100000},{...options,fetchBytes:async()=>Buffer.from('corrupt')})).rejects.toThrow('WAREHOUSE_FILE_IDENTITY_MISMATCH')
 }finally{await rm(root,{recursive:true,force:true})}
},120000)
