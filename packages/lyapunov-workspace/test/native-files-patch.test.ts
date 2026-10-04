import {expect,test} from 'bun:test'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {applySignedFilesPatch} from '../../../script/native-files-patch.mjs'
import {upstreamPatches,legacyUpstreamPatches} from '../../../script/upstream-patches.mjs'
import {legacySDKFixture} from '../../../script/legacy-sdk-fixture.mjs'
import {SDK_BASE_COMMIT,LEGACY_SDK_BASE_COMMIT,RC2_PRODUCT_PATCH} from '../../../script/sdk-source-integrity.mjs'
const root=resolve(import.meta.dirname,'../../..'),upstream=legacySDKFixture(root)
const patch={file:join(root,'packages/lyapunov-workspace/patches/dsh-native-files-operations.patch'),package:'@deepseek-ai/dsh-client-ui-sidebar-files'}
const manifest=JSON.parse(readFileSync(patch.file+'.json','utf8')) as {patchSha256:string;files:Array<{path:string;beforeSha256:string|null;afterSha256:string}>}
const digest=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex')
function fixture(){
 const scratch=mkdtempSync(join(tmpdir(),'a08-files-patch-'))
 const init=spawnSync('git',['init','--quiet',scratch]);expect(init.status).toBe(0)
 for(const row of manifest.files){if(row.beforeSha256===null)continue
  const prior=spawnSync('git',['-C',upstream,'show',LEGACY_SDK_BASE_COMMIT+':'+row.path]);expect(prior.status).toBe(0)
  const target=join(scratch,row.path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,prior.stdout)
  expect(digest(target)).toBe(row.beforeSha256)
 }
 return scratch
}
test('签定文件补丁正向重放、消费登记和第二次精确幂等',()=>{
 const scratch=fixture()
 try{
  expect(legacyUpstreamPatches(root).some(row=>row.file===patch.file)).toBe(true)
  const lock=JSON.parse(readFileSync(join(root,'UPSTREAM_LOCK.json'),'utf8'))
  if(lock.commit===SDK_BASE_COMMIT)expect(upstreamPatches(root)).toEqual([{file:join(root,RC2_PRODUCT_PATCH),package:'@deepseek-ai/dsh-root'}])
  expect(digest(patch.file)).toBe(manifest.patchSha256)
  expect(applySignedFilesPatch(root,scratch,patch).status).toBe('applied')
  for(const row of manifest.files)expect(digest(join(scratch,row.path))).toBe(row.afterSha256)
  expect(applySignedFilesPatch(root,scratch,patch).status).toBe('already-applied')
 }finally{rmSync(scratch,{recursive:true,force:true})}
})
test('未知SDK字节不能借reverse-check跳过，仍保留未知修改',()=>{
 const scratch=fixture()
 try{
  applySignedFilesPatch(root,scratch,patch)
  const path=join(scratch,manifest.files[0]!.path),changed=readFileSync(path,'utf8')+'\n// unknown change\n'
  writeFileSync(path,changed)
  expect(()=>applySignedFilesPatch(root,scratch,patch)).toThrow('pre/postimage')
  expect(readFileSync(path,'utf8')).toBe(changed)
 }finally{rmSync(scratch,{recursive:true,force:true})}
})
test('patch本体改字时，消费在写SDK前拒绝',()=>{
 const scratch=fixture()
 try{
  const bad=join(scratch,'tampered.patch');writeFileSync(bad,readFileSync(patch.file,'utf8')+'\n# unknown patch text\n');writeFileSync(bad+'.json',JSON.stringify(manifest))
  expect(()=>applySignedFilesPatch(root,scratch,{file:bad,package:patch.package})).toThrow('签名')
  expect(digest(join(scratch,manifest.files.find(row=>row.beforeSha256!==null)!.path))).toBe(manifest.files.find(row=>row.beforeSha256!==null)!.beforeSha256!)
 }finally{rmSync(scratch,{recursive:true,force:true})}
})
