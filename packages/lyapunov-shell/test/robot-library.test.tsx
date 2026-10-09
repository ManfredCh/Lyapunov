import {expect,test} from 'bun:test'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {SceneOperations} from '../../scene-kit/src/operations.ts'
import {ensureDefaultRobotLibrary,robotLibraryRows} from '../src/robot-library.ts'
import {stageDefaultT0Robots} from '../../../script/default-t0-robots.ts'
import {hashFile} from '../../policy-registry/src/source.ts'

test('原资源库登记许可明确的供给、重开去重，T0不产生控制资格；未知许可不进默认包',async()=>{
 const root=await mkdtemp(join(tmpdir(),'robot-library-')),product=join(root,'product'),source=join(root,'source'),stage=join(root,'stage')
 try{
  for(const dir of [product,source])await mkdir(join(dir,'packs/franka_panda/asset'),{recursive:true})
  const registry=JSON.parse(await readFile(new URL('../../../packs/registry.json',import.meta.url),'utf8')),roster=JSON.parse(await readFile(new URL('../../../packs/t0-roster.json',import.meta.url),'utf8'))
  // 最小真实原件闭包夹具；不是实际机型或UI验收。
  roster.packs=roster.packs.filter((r:any)=>r.packId==='franka_panda');roster.conflicts=[]
  await writeFile(join(product,'packs/registry.json'),JSON.stringify(registry));await writeFile(join(product,'packs/t0-roster.json'),JSON.stringify(roster))
  const pack={packId:'franka_panda',version:'test',family:'arm',asset:{modelEntry:'asset/robot.xml'},pieces:{asset:{ref:'ASSET_STAGING_MANIFEST.json#franka_panda'}},license:{model:'unverified'},provenance:{source:'fixture'},capabilities:{channels:[],directControl:'none'}}
  await writeFile(join(product,'packs/franka_panda/pack.json'),JSON.stringify(pack));const path=join(source,'packs/franka_panda/asset/robot.xml')
  await writeFile(path,'<mujoco><worldbody><body><joint name="axis"/><geom type="sphere" size="0.1" mass="1"/></body></worldbody></mujoco>')
  const file={path:'robot.xml',...await hashFile(path)},manifest={franka_panda:{license:'UNVERIFIED',origin:'fixture',files:[file]}}
  await writeFile(join(source,'packs/ASSET_STAGING_MANIFEST.json'),JSON.stringify(manifest))
  expect((await stageDefaultT0Robots(product,stage,source)).models).toHaveLength(0)
  manifest.franka_panda.license='MIT';await writeFile(join(source,'packs/ASSET_STAGING_MANIFEST.json'),JSON.stringify(manifest))
  expect((await stageDefaultT0Robots(product,stage,source)).models).toHaveLength(1)
  const directory=join(root,'scene'),scene=new SceneOperations(directory,stage),first=await ensureDefaultRobotLibrary(stage,scene)
  expect(first.registered).toEqual(['franka_panda']);expect(first.blocked).toEqual([])
  const reopened=new SceneOperations(directory,stage),second=await ensureDefaultRobotLibrary(stage,reopened)
  expect(second.registered).toEqual([]);expect(await reopened.resources.list()).toHaveLength(1)
  expect((await reopened.resources.list())[0]?.license?.id).toBe('MIT')
  expect((await robotLibraryRows(stage,reopened))[0]).toMatchObject({tier:'T0',installed:true,sourceDof:1,adapterReady:false,behaviorVerified:false})
  expect(await reopened.list()).toEqual([])
 }finally{await rm(root,{recursive:true,force:true})}
})

test('默认策略复用原缓存：同名不符原件保留并明确阻断，不进入prepare或覆盖用户数据',async()=>{
 const {prepareDefaultRobotPolicies}=await import('../../policy-registry/src/default-robot-policies.ts')
 const {IMPLEMENTED_POLICY_ADAPTERS}=await import('../../policy-registry/src/pack-contract.ts')
 const {policyDirectory}=await import('../../policy-registry/src/source.ts')
 const root=await mkdtemp(join(tmpdir(),'robot-policy-conflict-')),product=join(root,'product'),cache=join(root,'cache'),pin=IMPLEMENTED_POLICY_ADAPTERS.find(r=>r.id==='wtw-go1-torchscript-v1')!
 try{
  await mkdir(join(product,'packs'),{recursive:true})
  const native=policyDirectory(cache,'github',pin.modelId,pin.revision);await mkdir(native,{recursive:true});await writeFile(join(native,'body.jit'),'用户已存在的文件')
  await writeFile(join(product,'packs/default-policy-supply.json'),JSON.stringify({entries:[{packId:'unitree_go1',adapterId:pin.id,modelId:pin.modelId,revision:pin.revision,modelVariant:'menagerie-go1',files:[{path:'body.jit',bytes:1,sha256:'0'.repeat(64)}]}]}))
  const rows=await prepareDefaultRobotPolicies(product,cache)
  expect(rows[0]?.status).toBe('BLOCKED');expect(rows[0]?.detail).toContain('DEFAULT_POLICY_CACHE_CONFLICT')
  expect(await readFile(join(native,'body.jit'),'utf8')).toBe('用户已存在的文件')
 }finally{await rm(root,{recursive:true,force:true})}
})

test('机器人库新增状态按当前语言投影，未知技术值和原始许可不猜译或改名',async()=>{
 const {robotLibraryText}=await import('../src/robot-library-text.ts'),en=(_zh:string,en:string)=>en,zh=(zh:string)=>zh
 for(const value of ['EXTERNAL_CONTROLLER_NOT_INTEGRATED','DEFAULT_POLICY_NOT_SUPPLIED','MODEL_NOT_BUNDLED','LICENSE_UNVERIFIED','CONTROL_UNDECLARED','外部控制器尚未集成','本版本未提供可用的默认策略缓存','模型未随此版本提供，可按需导入','未核对','未声明'])expect(robotLibraryText(value,en)).not.toMatch(/[\u4e00-\u9fff]/)
 expect(robotLibraryText('requiresExternalController',en)).toBe('Requires an external controller')
 expect(robotLibraryText('DEFAULT_POLICY_LICENSE_MISSING',zh)).toContain('许可证')
 expect(robotLibraryText('POLICY_RUNTIME_UNAVAILABLE: {"detail":"原始诊断"}',en)).toBe('The motion runtime is unavailable; install policy-cpu and refresh.')
 for(const value of ['MIT · Improbable-AI/walk-these-ways','GPL-3.0-or-later','GPT6 policy author credit','SOME_NEW_ADAPTER_CODE'])expect(robotLibraryText(value,en)).toBe(value)
})
