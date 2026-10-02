import {test,expect} from 'bun:test'
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {resolveLocalPolicySource} from '../src/local-policy-source.ts'
test('未知裸文件不读取附近恶意或无效bundle，不上溯目录',async()=>{
 const root=await mkdtemp(join(tmpdir(),'unknown-policy-source-'));try{
  const file=join(root,'custom.pt');await writeFile(file,Buffer.alloc(64));await writeFile(join(root,'bundle.json'),'invalid json should not be read')
  expect((await resolveLocalPolicySource(file)).source).toMatchObject({status:'unidentified',sourceBytesVerified:false,prepareFrom:'unsupported'})
 }finally{await rm(root,{recursive:true,force:true})}
})
test('登记包根只按完整relative path派生，伪造自声明SHA不能冒充固定75来源',async()=>{
 const root=await mkdtemp(join(tmpdir(),'registered-policy-source-'));try{
  await mkdir(join(root,'deployment'));const file=join(root,'deployment/policy.pt'),bytes=Buffer.from('not the fixed 75 source');await writeFile(file,bytes)
  await writeFile(join(root,'bundle.json'),JSON.stringify({schema:'robot-download/v1',serverSideInference:false,downloadReady:false,source:{provider:'github',modelId:'jloganolson/g1_23dof_locomotion_isaac',resolvedRevision:'fbfa38706b817e2d4b19e444db95ae7fb2537b46'},adapter:{id:'jlog-g1-23-75-torchscript-v1'},files:[{path:'deployment/policy.pt',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]}))
  await expect(resolveLocalPolicySource(file)).rejects.toThrow('POLICY_LOCAL_PACKAGE_SOURCE_MISMATCH')
 }finally{await rm(root,{recursive:true,force:true})}
})
