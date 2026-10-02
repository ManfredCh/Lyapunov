import {expect,test} from 'bun:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {inspectLocalPolicyFile} from '../src/local-policy-file.ts'
test('坏权重与截断ZIP一次拒绝，未知pickle不执行',async()=>{const dir=await mkdtemp(join(tmpdir(),'policy-format-'));try{
 for(const [name,data] of [['bad.pt',Buffer.from('not-a-model-file-header')],['truncated.pt',Buffer.from('PK\x03\x04'+'x'.repeat(100))],['bad.onnx',Buffer.from('not-onnx-model-header')]] as const){const p=join(dir,name);await writeFile(p,data);const result=await inspectLocalPolicyFile(p);expect(result.valid).toBe(false);expect(result.code).toBe('POLICY_FILE_FORMAT_INVALID')}
 expect((await inspectLocalPolicyFile(join(dir,'absent.pt'))).code).toBe('POLICY_FILE_MISSING')
 }finally{await rm(dir,{recursive:true,force:true})}})
test('选错配置/账号JSON不读取内容，也不把它标权重',async()=>{const result=await inspectLocalPolicyFile('/not-read/lyapunov.account.json');expect(result.valid).toBe(false);expect(result.code).toBe('POLICY_FILE_FORMAT_UNSUPPORTED')})
