import {expect,test} from 'bun:test'
import {mkdtemp,writeFile,readFile,mkdir,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {inspectLocalPolicyFile} from '../src/local-policy-file.ts'
import {listLocalPolicyEntries,registerLocalPolicyWeights,resolveLocalPolicyPath,resolveLocalPolicyEntry} from '../src/local-policy-library.ts'
test('坏权重与截断ZIP一次拒绝，未知pickle不执行',async()=>{const dir=await mkdtemp(join(tmpdir(),'policy-format-'));try{
 for(const [name,data] of [['bad.pt',Buffer.from('not-a-model-file-header')],['truncated.pt',Buffer.from('PK\x03\x04'+'x'.repeat(100))],['bad.onnx',Buffer.from('not-onnx-model-header')]] as const){const p=join(dir,name);await writeFile(p,data);const result=await inspectLocalPolicyFile(p);expect(result.valid).toBe(false);expect(result.code).toBe('POLICY_FILE_FORMAT_INVALID')}
 expect((await inspectLocalPolicyFile(join(dir,'absent.pt'))).code).toBe('POLICY_FILE_MISSING')
 }finally{await rm(dir,{recursive:true,force:true})}})
test('选错配置/账号JSON不读取内容，也不把它标权重',async()=>{const result=await inspectLocalPolicyFile('/not-read/lyapunov.account.json');expect(result.valid).toBe(false);expect(result.code).toBe('POLICY_FILE_FORMAT_UNSUPPORTED')})
const safetensorsFixture=()=>{const header=Buffer.from(JSON.stringify({value:{dtype:'F32',shape:[1],data_offsets:[0,4]}})),size=Buffer.alloc(8);size.writeBigUInt64LE(BigInt(header.length));return Buffer.concat([size,header,Buffer.alloc(4)])}
test('无本体登记未知权重保原件于既有manifest；重开读回，坏文件保持原库',async()=>{
 const root=await mkdtemp(join(tmpdir(),'policy-local-register-'));try{
  const file=join(root,'自己的策略.safetensors'),bytes=safetensorsFixture();await writeFile(file,bytes)
  const entry=await registerLocalPolicyWeights(root,file,new AbortController().signal)
  expect(entry.identity).toBeUndefined();expect(entry.sourceBytesVerified).toBe(false);expect(await readFile(file)).toEqual(bytes)
  const reopened=await listLocalPolicyEntries(root);expect(reopened).toEqual([entry]);expect(await readFile(entry.filePath)).toEqual(bytes)
  const manifest=JSON.parse(await readFile(join(entry.filePath,'..','manifest.json'),'utf8'));expect(manifest.modelId).toBeUndefined();expect(manifest.provider).toBe('local');expect(manifest.execution.status).toBe('BLOCKED')
  await writeFile(file,'bad weights');await expect(registerLocalPolicyWeights(root,file,new AbortController().signal)).rejects.toThrow('POLICY_FILE_FORMAT_INVALID')
  expect(await listLocalPolicyEntries(root)).toEqual(reopened);expect(await readFile(entry.filePath)).toEqual(bytes)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('完整目录只解析根bundle，不递归猜策略；无bundle给精确入口',async()=>{
 const root=await mkdtemp(join(tmpdir(),'policy-local-directory-'));try{
  await mkdir(join(root,'nested'));await writeFile(join(root,'nested','bundle.json'),'{}')
  await expect(resolveLocalPolicyPath(root)).rejects.toThrow('POLICY_BUNDLE_REQUIRED')
  await writeFile(join(root,'bundle.json'),'{}');expect(await resolveLocalPolicyPath(root)).toBe(join(root,'bundle.json'))
  await expect(resolveLocalPolicyPath(join(root,'nested','config.json'))).rejects.toThrow('POLICY_FILE_MISSING')
 }finally{await rm(root,{recursive:true,force:true})}
})
test('entryId仅解析本账户既有缓存；缺id与越界符号链接不授文件访问',async()=>{
 const root=await mkdtemp(join(tmpdir(),'policy-entry-capability-'));try{
  const original=join(root,'own.safetensors');await writeFile(original,safetensorsFixture())
  const entry=await registerLocalPolicyWeights(root,original,new AbortController().signal)
  expect((await resolveLocalPolicyEntry(root,entry.id)).filePath).toBe(entry.filePath)
  await expect(resolveLocalPolicyEntry(join(root,'another-account'),entry.id)).rejects.toThrow('POLICY_LOCAL_ENTRY_NOT_FOUND')
  await expect(resolveLocalPolicyEntry(root,'../../outside.pt')).rejects.toThrow('POLICY_LOCAL_ENTRY_NOT_FOUND')
  await rm(entry.filePath);await symlink(original,entry.filePath)
  await expect(resolveLocalPolicyEntry(root,entry.id)).rejects.toThrow('POLICY_LOCAL_ENTRY_OUTSIDE_CACHE')
 }finally{await rm(root,{recursive:true,force:true})}
})
