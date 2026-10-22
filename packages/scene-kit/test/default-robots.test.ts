/**
 * P5-model-catalog：Robot Library 本体/演示分离的真实本地 pack + 供给 inventory + ResourceLibrary 回归。
 *
 * 夹具是**真实本地目录**（pack.json / asset/ 本体与 demo / default-t0-supply.json），不是把
 * `robotLibraryRows` 的字段硬编码进 mock。断言覆盖：本体选择与 SHA/DOF、旧 demo 资源保留、
 * policy adapter 来源、重复初始化幂等、缺件/路径不合法/缺 inventory 拒绝、用户输入不被刷新覆盖。
 */
import {test,expect} from 'bun:test'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {SceneOperations} from '../src/operations.ts'
import {ensureDefaultRobotLibrary,robotLibraryRows} from '../src/default-robots.ts'
import {hashFile} from '../../policy-registry/src/source.ts'
import type {DefaultRobotPolicy} from '../../policy-registry/src/default-robot-policies.ts'

const BODY_JOINTS=16
const bodyModel=(joints=BODY_JOINTS)=>`<mujoco model="fixture_hand"><worldbody><body name="palm"><geom type="box" size="0.05 0.05 0.05" mass="1"/>${Array.from({length:joints},(_,i)=>`<body name="finger${i}"><joint name="j${i}"/><geom type="box" size="0.01 0.01 0.01" mass="0.01"/></body>`).join('')}</body></worldbody></mujoco>`
/** demo 场景：带世界静态 plane 与一个 free 示例物件，整份被挂入 moving 父树是已确认根因。 */
const demoModel=`<mujoco model="fixture_scene"><include file="left_hand.xml"/><worldbody><geom name="floor" type="plane" size="1 1 0.1"/><body name="example"><freejoint/><geom type="sphere" size="0.05" mass="0.1"/></body></worldbody></mujoco>`

const sha=(value:string)=>createHash('sha256').update(value).digest('hex')

/** 建真实 product root：registry/roster + pack.json + asset 本体/demo + 供给 inventory。 */
async function fixture(options:{body?:string|null;demo?:string|null;inventoryBody?:'ok'|'sha-mismatch'|'omit';model?:string;modelEntry?:string}={}){
 const root=await mkdtemp(join(tmpdir(),'default-robots-')),product=join(root,'product'),packRoot=join(product,'packs/allegro_hand'),asset=join(packRoot,'asset')
 await mkdir(asset,{recursive:true})
 const registry=JSON.parse(await readFile(new URL('../../../packs/registry.json',import.meta.url),'utf8'))
 const roster=JSON.parse(await readFile(new URL('../../../packs/t0-roster.json',import.meta.url),'utf8'))
 roster.packs=roster.packs.filter((row:any)=>row.packId==='allegro_hand');roster.conflicts=[]
 await writeFile(join(product,'packs/registry.json'),JSON.stringify(registry));await writeFile(join(product,'packs/t0-roster.json'),JSON.stringify(roster))
 const body=options.body===undefined?bodyModel():options.body
 const demo=options.demo===undefined?demoModel:options.demo
 if(body!==null)await writeFile(join(asset,'left_hand.xml'),body)
 if(demo!==null)await writeFile(join(asset,'scene_left.xml'),demo)
 const pack={packId:'allegro_hand',version:'fixture',family:'hand',asset:{model:options.model??'asset/left_hand.xml',modelEntry:options.modelEntry??'asset/scene_left.xml'},pieces:{asset:{ref:'ASSET_STAGING_MANIFEST.json#allegro_hand'}},capabilities:{channels:['joint'],directControl:'suitable'},license:{model:'BSD-2-Clause',policy:'fixture'},provenance:{source:'fixture-local-pack'}}
 await writeFile(join(packRoot,'pack.json'),JSON.stringify(pack))
 const files:Array<{path:string;bytes:number;sha256:string}>=[]
 const push=(path:string,content:string)=>{files.push({path,bytes:Buffer.byteLength(content),sha256:sha(content)})}
 if(body!==null&&options.inventoryBody!=='omit')push('left_hand.xml',body)
 if(body!==null&&options.inventoryBody==='sha-mismatch')files[files.length-1]!.sha256='0'.repeat(64)
 if(demo!==null)push('scene_left.xml',demo)
 const bytes=files.reduce((sum,file)=>sum+file.bytes,0)
 await writeFile(join(product,'packs/default-t0-supply.json'),JSON.stringify({schemaVersion:1,scope:'default-t0-model-examples',models:[{packId:'allegro_hand',modelEntry:pack.asset.modelEntry,bytes,entrySha256:demo?sha(demo):null,license:'BSD-2-Clause',origin:'fixture-local-pack',files}]}))
 return {root,product,packRoot,asset,bodySha:body?sha(body):null,demoSha:demo?sha(demo):null}
}

test('真实 pack：Robot Library 选本体 asset.model 而非 demo，SHA/DOF 与供给 inventory 一致',async()=>{
 const fx=await fixture()
 try{
  const rows=await robotLibraryRows(fx.product),row=rows.find(item=>item.packId==='allegro_hand')!
  expect(row.modelPath).toBe(join(fx.asset,'left_hand.xml'))
  expect(row.modelSha256).toBe(fx.bodySha)
  expect(row.modelSha256).not.toBe(fx.demoSha)
  expect(row.sourceDof).toBe(BODY_JOINTS)
  expect(row.gaps).not.toContain('MODEL_NOT_BUNDLED')
  // modelBytes 是整包体积，不是本体 XML 字节。
  const inventory=JSON.parse(await readFile(join(fx.product,'packs/default-t0-supply.json'),'utf8'))
  expect(row.modelBytes).toBe(inventory.models[0].bytes)
 }finally{await rm(fx.root,{recursive:true,force:true})}
})

// P16 单例预算：本条是真实原生集成（ResourceLibrary 连续多次落盘 import + 本体 SHA/DOF 复算 +
// 重开幂等），在装有真实物理 Python 的环境下实测单用例 3.8~5.0s（前次签收 4156.98ms；主控精确环境
// 复现 5006.03ms），Bun 默认 5000ms/用例预算会把它截断。仅为这条原生用例显式声明 20_000ms；
// 文件级 120_000ms 上限与全部期望/身份/SHA/旧资源保留/幂等判据一律不动。
test('真实 ResourceLibrary：登记本体、旧 demo 资源保留、重复初始化幂等且不覆盖用户输入',async()=>{
 const fx=await fixture()
 try{
  const directory=join(fx.root,'data')
  // 用户已登记的旧 demo 资源：刷新必须保留它，同时补登记本体，不静默替换。
  const first=new SceneOperations(directory,fx.product)
  const demo=await first.resources.import({path:join(fx.asset,'scene_left.xml'),name:'allegro_hand',folder:'T0 机器人示例',tags:['T0','pack:allegro_hand','产品示例'],license:{id:'BSD-2-Clause',source:'file'}})
  expect(demo.ref.original.uri.endsWith('scene_left.xml')).toBe(true)
  const initialized=await ensureDefaultRobotLibrary(fx.product,first)
  expect(initialized.registered).toEqual(['allegro_hand'])
  const after=await first.resources.list()
  expect(after).toHaveLength(2)
  const bodyResource=after.find(record=>record.ref.original.uri.endsWith('left_hand.xml'))!
  const demoResource=after.find(record=>record.ref.original.uri.endsWith('scene_left.xml'))!
  expect(bodyResource).toBeDefined();expect(demoResource).toBeDefined()
  expect(demoResource.name).toBe('allegro_hand');expect(demoResource.tags).toContain('pack:allegro_hand')
  const rows=await robotLibraryRows(fx.product,first),row=rows.find(item=>item.packId==='allegro_hand')!
  expect(row.installed).toBe(true)
  expect(row.resourceId).toBe(bodyResource.ref.resourceId)
  expect(row.resourceId).not.toBe(demoResource.ref.resourceId)
  expect(row.sourceDof).toBe(BODY_JOINTS)
  // 重开 + 重复初始化：不再登记，资源数不变，旧 demo 仍在。
  const reopened=new SceneOperations(directory,fx.product)
  expect((await ensureDefaultRobotLibrary(fx.product,reopened)).registered).toEqual([])
  expect(await reopened.resources.list()).toHaveLength(2)
 }finally{await rm(fx.root,{recursive:true,force:true})}
},20000)

test('缺件/路径不合法/inventory SHA 不符：如实 MODEL_NOT_BUNDLED，不登记 demo 冒充本体',async()=>{
 // 本体缺失
 const missing=await fixture({body:null})
 try{
  const row=(await robotLibraryRows(missing.product)).find(item=>item.packId==='allegro_hand')!
  expect(row.modelPath).toBeNull();expect(row.gaps).toContain('MODEL_NOT_BUNDLED')
 }finally{await rm(missing.root,{recursive:true,force:true})}
 // inventory SHA 与本体实际字节不符
 const mismatch=await fixture({inventoryBody:'sha-mismatch'})
 try{
  const row=(await robotLibraryRows(mismatch.product)).find(item=>item.packId==='allegro_hand')!
  expect(row.modelPath).toBeNull();expect(row.gaps).toContain('MODEL_NOT_BUNDLED')
 }finally{await rm(mismatch.root,{recursive:true,force:true})}
 // 路径逃逸出 pack 根
 const escape=await fixture({model:'../outside.xml'})
 try{
  const row=(await robotLibraryRows(escape.product)).find(item=>item.packId==='allegro_hand')!
  expect(row.modelPath).toBeNull();expect(row.gaps).toContain('MODEL_NOT_BUNDLED')
  const scene=new SceneOperations(join(escape.root,'data'),escape.product)
  expect((await ensureDefaultRobotLibrary(escape.product,scene)).registered).toEqual([])
  expect(await scene.resources.list()).toHaveLength(0)
 }finally{await rm(escape.root,{recursive:true,force:true})}
})

// P15 单例预算：与下一条同因——真实 ResourceLibrary import + adapter 身份/SHA 复算，
// 全 CI 沙箱实测已触 5000.99ms 默认预算截断（同文件既有 20_000ms 先例的同类用例）。
// 仅为这条原生集成用例显式声明 20_000ms；模型沿用/SHA/资源选取/幂等判据全部保留。
test('已准备 policy：本体沿用 adapter 模型与 SHA，资源按 adapter 身份选取',async()=>{
 const fx=await fixture()
 try{
  const adapted=join(fx.root,'adapter-model.xml'),adapterBody=bodyModel(9)
  await writeFile(adapted,adapterBody)
  const adapterSha=(await hashFile(adapted)).sha256
  const prepared={adapter:{adapter:'fixture-adapter-v1',modelPath:adapted,modelSha256:adapterSha},components:{controller:{policyAdapter:'fixture-adapter-v1'},mujoco:{sourcePath:adapted}},variant:'fixture'} as any
  const policies=[{packId:'allegro_hand',status:'PREPARED',variant:'fixture',prepared} as unknown as DefaultRobotPolicy]
  const rows=await robotLibraryRows(fx.product,undefined,policies),row=rows.find(item=>item.packId==='allegro_hand')!
  expect(row.modelPath).toBe(adapted);expect(row.modelSha256).toBe(adapterSha);expect(row.sourceDof).toBe(9)
  const directory=join(fx.root,'data'),scene=new SceneOperations(directory,fx.product)
  const resource=await scene.resources.import({path:adapted,name:'allegro_hand · fixture',components:prepared.components,folder:'T0 机器人示例',tags:['T0','pack:allegro_hand','产品示例'],license:{id:'BSD-2-Clause',source:'file'}})
  const selected=(await robotLibraryRows(fx.product,scene,policies)).find(item=>item.packId==='allegro_hand')!
  expect(selected.installed).toBe(true);expect(selected.resourceId).toBe(resource.ref.resourceId)
  // 再次初始化按 adapter 身份幂等，不新增资源、不改 adapter 模型。
  expect((await ensureDefaultRobotLibrary(fx.product,scene,policies)).registered).toEqual([])
  expect(await scene.resources.list()).toHaveLength(1)
 }finally{await rm(fx.root,{recursive:true,force:true})}
},20000)

// P16 单例预算：与上一条同因——真实原生 ResourceLibrary 连续多次 import + adapter 身份/SHA 复算，
// 真实物理 Python 环境下实测已到 5.0s（主控精确环境复现 5001.03ms、全CI 3855.02ms），默认 5000ms
// 预算会截断。仅为这条原生集成用例显式声明 20_000ms；错字节不得复用/同 SHA 不串用/幂等判据全部保留。
test('已准备 policy：同 adapter 错字节不得复用，登记正确本体并幂等保留旧错资源；同 SHA 错 adapter 不串用',async()=>{
 const fx=await fixture()
 try{
  const adapted=join(fx.root,'adapter-model.xml'),adapterBody=bodyModel(9)
  await writeFile(adapted,adapterBody)
  const adapterSha=(await hashFile(adapted)).sha256
  const prepared={adapter:{adapter:'fixture-adapter-v1',modelPath:adapted,modelSha256:adapterSha},components:{controller:{policyAdapter:'fixture-adapter-v1'},mujoco:{sourcePath:adapted}},variant:'fixture'} as any
  const policies=[{packId:'allegro_hand',status:'PREPARED',variant:'fixture',prepared} as unknown as DefaultRobotPolicy]
  const directory=join(fx.root,'data'),scene=new SceneOperations(directory,fx.product)
  // 旧资源：同 folder/tag、同 adapter 名，但入口字节不同 ⇒ 精确身份不符，不能认定本体已登记。
  const wrongBytes=join(fx.root,'wrong-bytes.xml')
  await writeFile(wrongBytes,bodyModel(7))
  const bogus=await scene.resources.import({path:wrongBytes,name:'allegro_hand · bogus',components:prepared.components,folder:'T0 机器人示例',tags:['T0','pack:allegro_hand','产品示例'],license:{id:'BSD-2-Clause',source:'file'}})
  expect((await robotLibraryRows(fx.product,scene,policies)).find(item=>item.packId==='allegro_hand')!.installed).toBe(false)
  // 刷新登记正确本体为新资源；错字节旧资源保留。
  expect((await ensureDefaultRobotLibrary(fx.product,scene,policies)).registered).toEqual(['allegro_hand'])
  const after=await scene.resources.list()
  expect(after).toHaveLength(2)
  expect(after.some(record=>record.ref.resourceId===bogus.ref.resourceId)).toBe(true)
  const selected=(await robotLibraryRows(fx.product,scene,policies)).find(item=>item.packId==='allegro_hand')!
  expect(selected.installed).toBe(true);expect(selected.resourceId).not.toBe(bogus.ref.resourceId)
  // 再次刷新不重复导入。
  expect((await ensureDefaultRobotLibrary(fx.product,scene,policies)).registered).toEqual([])
  expect(await scene.resources.list()).toHaveLength(2)
  // 同 SHA 但 adapter 身份不同：不得串用同一份资源。
  const otherScene=new SceneOperations(join(fx.root,'data-other'),fx.product)
  await otherScene.resources.import({path:adapted,name:'allegro_hand · other-adapter',components:{controller:{policyAdapter:'other-adapter'}},folder:'T0 机器人示例',tags:['T0','pack:allegro_hand','产品示例'],license:{id:'BSD-2-Clause',source:'file'}})
  expect((await robotLibraryRows(fx.product,otherScene,policies)).find(item=>item.packId==='allegro_hand')!.installed).toBe(false)
 }finally{await rm(fx.root,{recursive:true,force:true})}
},20000)
