import { afterEach, expect, test } from 'bun:test'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { fileDocument, documentExitParticipant, registerDocumentExitParticipant } from '../src/native-documents.ts'
const oldFetch=globalThis.fetch
let counter=0
afterEach(()=>{globalThis.fetch=oldFetch})
function doc(){ return fileDocument(fileAddressFor('s-exit-'+(++counter),'/work','notes.txt'),true) }
test('退出参与者读取唯一草稿并保存实际版本',async()=>{
 const d=doc();d.edit('中文草稿'); let writes=0
 globalThis.fetch=(async(_url:RequestInfo|URL,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));expect(body.action).toBe('write');expect(body.input.content).toBe('中文草稿');writes++;return Response.json({version:'v2'})}) as unknown as typeof fetch
 const participant=documentExitParticipant();expect(participant.summary().dirtyDrafts).toBe(1)
 await participant.flush();expect(writes).toBe(1);expect(d.snapshot().base?.version).toBe('v2');expect(participant.summary().dirtyDrafts).toBe(0)
})
test('保存冲突抛错并保留真实草稿，不宣称保存成功',async()=>{
 const d=doc();d.edit('不得丢失')
 globalThis.fetch=(async()=>Response.json({error:'FILE_STALE_VERSION'},{status:409})) as unknown as typeof fetch
 await expect(documentExitParticipant().flush()).rejects.toThrow('FILE_STALE_VERSION')
 expect(d.snapshot().draft).toBe('不得丢失');expect(d.snapshot().notice).not.toBe('文件已保存')
 // 清除此测试自己创建的草稿，后续不误把前一失败当新草稿。
 globalThis.fetch=(async()=>Response.json({version:'v3'})) as unknown as typeof fetch
 await documentExitParticipant().flush()
})
test('flush 等待在途保存后检查最终事实，注销只沿桥返回函数',async()=>{
 const d=doc();d.edit('在途')
 let settle:(r:Response)=>void=()=>{};globalThis.fetch=(()=>new Promise<Response>(r=>{settle=r})) as unknown as typeof fetch
 const saving=d.save();const flushing=documentExitParticipant().flush()
 expect(d.snapshot().saving).toBe(true);settle(Response.json({version:'v4'}));await saving;await flushing
 let id='';let removed=false
 const dispose=registerDocumentExitParticipant({registerExitParticipant:(key,p)=>{id=key;expect(p.summary().runningActions).toBe(0);return()=>{removed=true}}})
 expect(id).toBe('lyapunov-workspace:documents');dispose();expect(removed).toBe(true)
})
