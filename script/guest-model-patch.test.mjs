import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve,join,dirname} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {verifiedGuestOwnProviderComposition} from './guest-own-provider-patch.mjs'
import {applySignedGuestPatch} from './guest-model-patch.mjs'
import {legacySDKFixture} from './legacy-sdk-fixture.mjs'
const root=resolve(import.meta.dirname,'..'),source=process.env.GUEST_UPGRADE_TEST_SDK??legacySDKFixture(root)
const manifestName='packages/desktop/patches/dsh-guest-presentation-227-to-d756.json'
const signed=JSON.parse(readFileSync(join(root,manifestName),'utf8'))
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
const ownManifestPath='packages/desktop/patches/dsh-guest-own-provider.json',own=JSON.parse(readFileSync(join(root,ownManifestPath),'utf8'))
const files=[manifestName,signed.oldFullPatch,signed.newFullPatch,signed.upgradePatch,ownManifestPath,own.patch,...own.dependencies.map(row=>row.file)]
const git=(cwd,file,args)=>{const result=spawnSync('git',['-C',cwd,'apply',...args,file],{encoding:'utf8'});assert.equal(result.status,0,result.stderr)}
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'lyapunov-guest-patch-test-')),product=join(dir,'product'),sdk=join(dir,'sdk')
  for(const file of files){mkdirSync(dirname(join(product,file)),{recursive:true});copyFileSync(join(root,file),join(product,file))}
  for(const row of own.files){mkdirSync(dirname(join(sdk,row.path)),{recursive:true});copyFileSync(join(source,row.path),join(sdk,row.path))}
  if(verifiedGuestOwnProviderComposition(product,sdk))git(sdk,join(product,own.patch),['--reverse'])
  const matches=field=>signed.files.every(row=>digest(join(sdk,row.path))===row[field])
  let origin
  if(matches('upgradeAfterSha256')){git(sdk,join(product,signed.upgradePatch),['--reverse']);origin='upgrade'}
  else if(matches('freshAfterSha256')){git(sdk,join(product,signed.newFullPatch),['--reverse']);origin='fresh'}
  else if(matches('upgradeBeforeSha256'))origin='upgrade'
  else if(matches('oldFullBeforeSha256'))origin='upgrade'
  else if(matches('freshBeforeSha256'))origin='fresh'
  else throw Error('测试对象不是签定guest SDK源，禁止用未知源码造绿色')
  const patch={file:join(product,signed.newFullPatch),package:'@deepseek-ai/dsh-agent-default-model'}
  const snapshot=()=>Object.fromEntries(signed.files.map(row=>[row.path,digest(join(sdk,row.path))]))
  return{dir,product,sdk,patch,origin,snapshot,close:()=>rmSync(dir,{recursive:true,force:true})}
}
test('精确已签guest版本check→apply与第二次幂等，已配置其他A08文件不重写',()=>{
  const b=fixture()
  try{
    const result=applySignedGuestPatch(b.product,b.sdk,b.patch);assert.equal(result.status,'applied')
    assert.match(result.verifiedComposition,new RegExp(b.origin))
    const after=b.snapshot();assert.equal(applySignedGuestPatch(b.product,b.sdk,b.patch).status,'already-applied');assert.deepEqual(b.snapshot(),after)
  }finally{b.close()}
})
test('未知源码改字拒绝，失败前后完整源码字节不变',()=>{
  const b=fixture()
  try{const file=join(b.sdk,'packages/api/session-controller/src/types.ts');writeFileSync(file,readFileSync(file,'utf8')+'\n// unknown fixture edit\n');const before=b.snapshot();assert.throws(()=>applySignedGuestPatch(b.product,b.sdk,b.patch),/未知或混合/);assert.deepEqual(b.snapshot(),before)}finally{b.close()}
})
test('缺少已签新文件拒绝，不能exists豁免或重建其余源码',()=>{
  const b=fixture()
  try{rmSync(join(b.sdk,'packages/client/ui-model-selection/src/client/locales.ts'));assert.throws(()=>applySignedGuestPatch(b.product,b.sdk,b.patch))}finally{b.close()}
})
for(const file of files)test('签定artifact改字拒绝并保源码：'+file,()=>{
  const b=fixture()
  try{writeFileSync(join(b.product,file),readFileSync(join(b.product,file),'utf8')+'\n');const before=b.snapshot();assert.throws(()=>applySignedGuestPatch(b.product,b.sdk,b.patch),/签名/);assert.deepEqual(b.snapshot(),before)}finally{b.close()}
})
test('混合pre/post状态拒绝，不在一般冲突时覆盖源码',()=>{
  const b=fixture(),post=fixture()
  try{applySignedGuestPatch(post.product,post.sdk,post.patch);copyFileSync(join(post.sdk,'packages/core/agent-default-model/src/index.ts'),join(b.sdk,'packages/core/agent-default-model/src/index.ts'));const before=b.snapshot();assert.throws(()=>applySignedGuestPatch(b.product,b.sdk,b.patch),/未知或混合/);assert.deepEqual(b.snapshot(),before)}finally{b.close();post.close()}
})
