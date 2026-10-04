import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, cpSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {test} from 'node:test'
import ts from 'typescript'
import {createHash} from 'node:crypto'
import {verifiedComposedPatch} from './upstream-patches.mjs'
import {applyUpstreamPatches,upstreamPatches,applyLegacyUpstreamPatches,legacyUpstreamPatches,preflightUpstreamPatches} from './upstream-patches.mjs'
import {applyPublicModelDiagnosticsPatch} from './public-model-patch.mjs'
import {verifySDKSourceIntegrity,sdkFileBytes,SDK_BASE_COMMIT,LEGACY_SDK_BASE_COMMIT,RC2_PRODUCT_PATCH,RC2_INTEGRITY_MANIFEST} from './sdk-source-integrity.mjs'
import {legacySDKFixture} from './legacy-sdk-fixture.mjs'
import {generateRC2SdkPatch} from './generate-rc2-sdk-patch.mjs'
import {applySignedFilesPatch} from './native-files-patch.mjs'

const root = resolve(import.meta.dirname, '..')
const upstream = legacySDKFixture(root)
const rc2Upstream = join(root,JSON.parse(readFileSync(join(root,'UPSTREAM_LOCK.json'),'utf8')).directory)
const native = 'packages/api/session-controller/src'
const isolatedTestTimeoutMs = 120_000

test('原生提交ACK补丁只消费完整pre/post，草稿事务未知改动与缺件均拒绝保留',()=>{
 const file=join(root,'packages/lyapunov-shell/patches/dsh-native-admission-ack.patch')
 const patch={file,package:'@deepseek-ai/dsh-client-ui-conversation'}
 const manifest=JSON.parse(readFileSync(file+'.json','utf8'))
 const scratch=mkdtempSync(join(root,'.tmp-admission-ack-'))
 try{
  run('git',['init','--quiet',scratch])
  for(const row of manifest.files){const target=join(scratch,row.path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(join(upstream,row.path)))}
  assert.equal(applySignedFilesPatch(root,scratch,patch).status,'already-applied')
  run('git',['apply','--reverse',file],{cwd:scratch})
  assert.equal(applySignedFilesPatch(root,scratch,patch).status,'applied')
  const changed=join(scratch,manifest.files[0].path),bytes=readFileSync(changed)
  writeFileSync(changed,Buffer.concat([bytes,Buffer.from('\n/* unknown admission mutation */\n')]))
  const mutated=readFileSync(changed)
  assert.throws(()=>applySignedFilesPatch(root,scratch,patch),/pre\/postimage/)
  assert.deepEqual(readFileSync(changed),mutated)
  writeFileSync(changed,bytes)
  const missing=join(scratch,manifest.files.at(-1).path);rmSync(missing)
  assert.throws(()=>applySignedFilesPatch(root,scratch,patch),/pre\/postimage/)
  assert.equal(existsSync(missing),false)
 }finally{rmSync(scratch,{recursive:true,force:true})}
})

test('电脑目录flow精确补丁真实消费、幂等及未知或缺件保留',()=>{
 const file=join(root,'packages/lyapunov-shell/patches/dsh-files-directory-flow.patch')
 const patch={file,package:'@deepseek-ai/dsh-client-ui-directory-picker-browse'}
 const manifest=JSON.parse(readFileSync(file+'.json','utf8'))
 const scratch=mkdtempSync(join(root,'.tmp-directory-flow-'))
 try{
  run('git',['init','--quiet',scratch])
  for(const row of manifest.files){const target=join(scratch,row.path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(join(upstream,row.path)))}
  run('git',['apply','--reverse',file],{cwd:scratch})
  assert.equal(applySignedFilesPatch(root,scratch,patch).status,'applied')
  assert.equal(applySignedFilesPatch(root,scratch,patch).status,'already-applied')
  const changed=join(scratch,manifest.files[0].path),original=readFileSync(changed)
  writeFileSync(changed,Buffer.concat([original,Buffer.from('\n/* unknown */\n')]))
  const changedBytes=readFileSync(changed)
  assert.throws(()=>applySignedFilesPatch(root,scratch,patch),/pre\/postimage/)
  assert.deepEqual(readFileSync(changed),changedBytes)
  writeFileSync(changed,original)
  const missing=join(scratch,manifest.files.at(-1).path)
  rmSync(missing)
  assert.throws(()=>applySignedFilesPatch(root,scratch,patch),/pre\/postimage/)
  assert.equal(existsSync(missing),false)
  assert.deepEqual(readFileSync(changed),original)
 }finally{rmSync(scratch,{recursive:true,force:true})}
})

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {cwd: root, encoding: 'utf8', timeout: isolatedTestTimeoutMs, ...options})
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

test('已签preview+headline组合仅精确postimage可认幂等，原补丁/真实效果/未知修改均受保护', () => {
  const scratch = mkdtempSync(join(root, '.tmp-hero-composition-'))
  const name = 'packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx'
  const patch = {file: join(root, 'packages/lyapunov-shell/patches/dsh-hero-preview-badge.patch')}
  try {
    run('git', ['init', '--quiet', scratch])
    for (const file of [name,'packages/client/ui-conversation/src/client/contract/slots.ts','packages/client/ui-conversation/src/client/apply.ts']) {
      const target=join(scratch,file);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(join(upstream,file)))
    }
    assert.equal(verifiedComposedPatch(root,scratch,patch),true)
    const target=join(scratch,name),composed=readFileSync(target,'utf8')
    assert.equal(composed.includes("renderSlot('conversation.hero.headline'"),true)
    assert.equal(composed.includes('css.previewBadge'),false)
    // 补丁仍存在且对固定原始HEAD真实应用，不用组合认定绕过未执行的移除。
    const pinned=run('git',['show',`${LEGACY_SDK_BASE_COMMIT}:${name}`],{cwd:upstream});writeFileSync(target,pinned)
    assert.equal(verifiedComposedPatch(root,scratch,patch),false)
    run('git',['apply','--check',patch.file],{cwd:scratch});run('git',['apply',patch.file],{cwd:scratch})
    assert.equal(readFileSync(target,'utf8').includes('css.previewBadge'),false)
    run('git',['apply','--reverse','--check',patch.file],{cwd:scratch})
    // 真实badge回退、headline缺失或任意未知源码变化，必须拒绝该受签组合。
    writeFileSync(target,composed+"\n<span className={css.previewBadge}>{t('hero.preview')}</span>\n")
    assert.equal(verifiedComposedPatch(root,scratch,patch),false)
    writeFileSync(target,composed.replace('conversation.hero.headline','conversation.hero.unregistered'))
    assert.equal(verifiedComposedPatch(root,scratch,patch),false)
    writeFileSync(target,composed+'\n// unknown edit\n')
    assert.equal(verifiedComposedPatch(root,scratch,patch),false)
    writeFileSync(target,composed)
    const declaration=join(scratch,'packages/client/ui-conversation/src/client/contract/slots.ts')
    writeFileSync(declaration,readFileSync(declaration,'utf8').replace('conversation.hero.headline','conversation.hero.unregistered'))
    assert.equal(verifiedComposedPatch(root,scratch,patch),false)
  } finally { rmSync(scratch,{recursive:true,force:true}) }
})

test('模型budget组合要求完整精确postimage，空/少/额外字段与未知源码修改不能认幂等', () => {
  const scratch=mkdtempSync(join(root,'.tmp-model-composition-'))
  const proofRoot=join(scratch,'product'),proofSdk=join(scratch,'sdk')
  const lock=JSON.parse(readFileSync(join(root,'UPSTREAM_LOCK.json'),'utf8'))
  const names=['packages/lyapunov-shell/patches/dsh-model-request-phase-budget.patch',lock.a08PublicModelDiagnosticsPatch.file]
  try {
    for(const name of names){const target=join(proofRoot,name);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(join(root,name)))}
    const formal=lock.a08PublicModelDiagnosticsPatch.composition.formalModelInput
    const matches=hashes=>Object.entries(hashes).every(([name,sha])=>createHash('sha256').update(readFileSync(join(upstream,name))).digest('hex')===sha)
    const legacy=matches(lock.a08PublicModelDiagnosticsPatch.composition.postHashes)
    const selected=legacy?lock.a08PublicModelDiagnosticsPatch.composition:formal
    const signed=structuredClone(selected?.postHashes)
    assert.ok(signed,'当前SDK必须属于明确已签的旧或formal组合')
    if(!legacy){
      assert.equal(matches(formal.postHashes),true)
      const target=join(proofRoot,formal.file);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(join(root,formal.file)))
    }
    assert.deepEqual(Object.keys(signed).sort(),['packages/core/agent-loop/src/agent.ts','packages/llm/llm/src/retry-policy.ts','packages/llm/llm/tests/retry-policy.spec.ts'])
    for(const name of Object.keys(signed)){const target=join(proofSdk,name);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(join(upstream,name)))}
    const writeLock=()=>writeFileSync(join(proofRoot,'UPSTREAM_LOCK.json'),JSON.stringify(lock))
    writeLock();const patch={file:join(proofRoot,names[0])}
    assert.equal(verifiedComposedPatch(proofRoot,proofSdk,patch),true)
    for(const hashes of [{},Object.fromEntries(Object.entries(signed).slice(1)),{...signed,'unexpected/file.ts':'a'.repeat(64)}]){
      selected.postHashes=hashes;writeLock();assert.equal(verifiedComposedPatch(proofRoot,proofSdk,patch),false)
    }
    selected.postHashes=signed;writeLock()
    const source=join(proofSdk,'packages/core/agent-loop/src/agent.ts'),before=readFileSync(source)
    writeFileSync(source,Buffer.concat([before,Buffer.from('\n// unknown mutation\n')]));assert.equal(verifiedComposedPatch(proofRoot,proofSdk,patch),false);writeFileSync(source,before)
    const followup=join(proofRoot,names[1]);writeFileSync(followup,readFileSync(followup,'utf8')+'\n# unknown patch mutation\n')
    assert.equal(verifiedComposedPatch(proofRoot,proofSdk,patch),false)
  } finally {rmSync(scratch,{recursive:true,force:true})}
})

test('PublicDiagnostics全26完整post保护，尾字节/缺件/改patch不能靠reverse-check认已应用',()=>{
  const scratch=mkdtempSync(join(root,'.tmp-public-model-'))
  const fixtureRoot=join(scratch,'product'),fixtureSdk=join(scratch,'sdk'),lock=JSON.parse(readFileSync(join(root,'UPSTREAM_LOCK.json'),'utf8'))
  const record=lock.a08PublicModelDiagnosticsPatch
  const proof=verifySDKSourceIntegrity(root,upstream,legacyUpstreamPatches(root),false,LEGACY_SDK_BASE_COMMIT)
  const copy=(from,to)=>{mkdirSync(dirname(to),{recursive:true});writeFileSync(to,readFileSync(from))}
  try{
    mkdirSync(fixtureRoot,{recursive:true});writeFileSync(join(fixtureRoot,'UPSTREAM_LOCK.json'),JSON.stringify(lock))
    for(const path of [record.file,'packages/lyapunov-shell/patches/dsh-model-request-phase-budget.patch',record.composition.formalModelInput.file])if(existsSync(join(root,path)))copy(join(root,path),join(fixtureRoot,path))
    for(const row of record.files)copy(join(upstream,row.path),join(fixtureSdk,row.path))
    for(const path of Object.keys(record.composition.postHashes))copy(join(upstream,path),join(fixtureSdk,path))
    const patch={file:join(fixtureRoot,record.file),package:'@deepseek-ai/dsh-llm'}
    assert.equal(applyPublicModelDiagnosticsPatch(fixtureRoot,fixtureSdk,patch,proof).status,'already-applied')
    for(const row of record.files){const path=join(fixtureSdk,row.path),before=readFileSync(path);writeFileSync(path,Buffer.concat([before,Buffer.from('\n// unknown bytes\n')]))
      assert.throws(()=>applyPublicModelDiagnosticsPatch(fixtureRoot,fixtureSdk,patch,proof),/SOURCE_MISMATCH/)
      assert.equal(readFileSync(path).subarray(before.length).toString(),'\n// unknown bytes\n');writeFileSync(path,before)
    }
    const added=join(fixtureSdk,'packages/llm/llm-pi-ai/src/diagnostic-fetch.ts'),before=readFileSync(added);rmSync(added)
    assert.throws(()=>applyPublicModelDiagnosticsPatch(fixtureRoot,fixtureSdk,patch,proof),/SOURCE_MISMATCH/);assert.equal(existsSync(added),false);writeFileSync(added,before)
    const body=readFileSync(patch.file);writeFileSync(patch.file,Buffer.concat([body,Buffer.from('\n# modified patch\n')]))
    assert.throws(()=>applyPublicModelDiagnosticsPatch(fixtureRoot,fixtureSdk,patch),/SIGNATURE_INVALID/)
  }finally{rmSync(scratch,{recursive:true,force:true})}
})

test('实际registry在接受前拒固定base未覆本体与unknown新增source，标准ignored构建物按Git保留', {timeout: isolatedTestTimeoutMs}, ()=>{
  const scratch=mkdtempSync(join(root,'.tmp-sdk-integrity-'))
  try{
    run('git',['clone','--shared','--quiet',upstream,scratch]);run('git',['checkout','--quiet','--detach','7c3f05885033aa3aed74904d59a94692d12a47f7'],{cwd:scratch})
    applyLegacyUpstreamPatches(root,scratch);assert.equal(applyLegacyUpstreamPatches(root,scratch).filter(row=>row.status==='applied').length,0)
    const baseFile=join(scratch,'packages/core/agent/src/index.ts'),bytes=readFileSync(baseFile);writeFileSync(baseFile,Buffer.concat([bytes,Buffer.from('\n// unknown base bytes\n')]))
    assert.throws(()=>applyLegacyUpstreamPatches(root,scratch),/BASE_BYTES_MISMATCH/);assert.equal(readFileSync(baseFile).subarray(bytes.length).toString(),'\n// unknown base bytes\n');writeFileSync(baseFile,bytes)
    const unknown=join(scratch,'packages/core/agent/src/unknown-new-source.ts');writeFileSync(unknown,'export const unknown = true\n')
    assert.throws(()=>applyLegacyUpstreamPatches(root,scratch),/UNKNOWN_ADDITION/);assert.equal(readFileSync(unknown,'utf8'),'export const unknown = true\n');rmSync(unknown)
    const changed=join(scratch,'packages/llm/llm-pi-ai/src/adapter.ts'),original=readFileSync(changed);writeFileSync(changed,Buffer.concat([original,Buffer.from('\n// S03 unknown\n')]))
    assert.throws(()=>applyLegacyUpstreamPatches(root,scratch),/AFFECTED_STAGE_MISMATCH/);writeFileSync(changed,original)
    const ignored=join(scratch,'packages/core/agent/lib/fixture-build-output.js');mkdirSync(dirname(ignored),{recursive:true});writeFileSync(ignored,'generated fixture\n')
    run('git',['check-ignore',ignored],{cwd:scratch});assert.equal(applyLegacyUpstreamPatches(root,scratch).filter(row=>row.status==='applied').length,0);assert.equal(readFileSync(ignored,'utf8'),'generated fixture\n')
  }finally{rmSync(scratch,{recursive:true,force:true})}
})

test('当前RC2真实outbound源码按当前声明编译，原page/follow/live/reconnect守卫不退役', {timeout: isolatedTestTimeoutMs}, () => {
  const scratch=mkdtempSync(join(root,'.tmp-current-outbound-'))
  try{
    assert.equal(run('git',['rev-parse','HEAD'],{cwd:rc2Upstream}).trim(),SDK_BASE_COMMIT)
    const hostConfig='packages/api/session-controller/tsconfig.host.json'
    const source=join(rc2Upstream,native,'outbound-projection.ts')
    assert.equal(existsSync(source),true,'SDK_OUTBOUND_HOOK_MISSING: 当前RC2必须有实际消费product provider的seam')
    cpSync(join(rc2Upstream,native),join(scratch,native),{recursive:true})
    const hostFiles=JSON.parse(readFileSync(join(rc2Upstream,hostConfig),'utf8')).files
    assert.equal(hostFiles.includes('src/outbound-projection.ts'),true,'当前Host编译程序不能遗漏真实hook')
    assert.equal(readFileSync(join(scratch,native,'history.ts'),'utf8').includes('@ts-ignore TS6307'),false)
    symlinkSync(join(root,'node_modules'),join(scratch,'node_modules'),'dir')
    const base=ts.readConfigFile(join(rc2Upstream,'tsconfig.base.json'),ts.sys.readFile)
    assert.equal(base.error,undefined)
    const pathsToDeclarations=Object.fromEntries(Object.entries(base.config.compilerOptions.paths).map(([key,values])=>[
      key,values.map(value=>resolve(rc2Upstream,value.replace(/\/src(?=\/|$)/,'/lib/types').replace(/\.ts$/,'.d.ts'))),
    ]))
    const outDir=join(scratch,'compiled')
    const config={compilerOptions:{
      target:'ES2023',module:'ESNext',moduleResolution:'bundler',strict:true,
      noUncheckedIndexedAccess:true,exactOptionalPropertyTypes:true,noUnusedLocals:true,noUnusedParameters:true,
      skipLibCheck:true,rewriteRelativeImportExtensions:true,noEmitOnError:true,
      rootDir:join(scratch,native),outDir,types:['node'],paths:pathsToDeclarations,
    },files:[join(scratch,native,'history.ts')]}
    writeFileSync(join(scratch,'tsconfig.compile.json'),JSON.stringify(config))
    run(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'-p',join(scratch,'tsconfig.compile.json'),'--pretty','false'])
    for(const name of ['history.js','outbound-projection.js','assistant-stream.js'])assert.equal(existsSync(join(outDir,name)),true,'missing current compiler output '+name)
    const bun=process.env.BUN_BIN??(process.versions.bun?process.execPath:'bun')
    const output=run(bun,['test','--no-env-file','--tsconfig-override='+join(root,'tsconfig.json'),join(root,'script/outbound-projection.test.ts')],{
      env:{...process.env,LYAPUNOV_OUTBOUND_COMPILED:outDir},
    })
    if(output.trim())console.log(output.trim())
  }finally{rmSync(scratch,{recursive:true,force:true})}
})

test('当前正式RC2签定bundle真实干净重放、完整final/幂等与原件拒绝保护', {timeout: isolatedTestTimeoutMs},()=>{
  const dir=mkdtempSync(join(tmpdir(),'lyapunov-current-signed-bundle-')),sdk=join(dir,'sdk')
  try{
    preflightUpstreamPatches(root)
    run('git',['clone','--shared','--no-checkout','--quiet',rc2Upstream,sdk])
    run('git',['checkout','--quiet','--detach',SDK_BASE_COMMIT],{cwd:sdk})
    assert.deepEqual(applyUpstreamPatches(root,sdk).map(row=>row.status),['applied'])
    const patches=upstreamPatches(root),proof=verifySDKSourceIntegrity(root,sdk,patches,true)
    assert.equal(proof.baseCommit,SDK_BASE_COMMIT)
    const lock=JSON.parse(readFileSync(join(root,'UPSTREAM_LOCK.json'),'utf8'))
    const manifest=JSON.parse(readFileSync(join(root,lock.sdkSourceIntegrity.file),'utf8'))
    const entry=manifest.registries[proof.registrySignature]
    const snapshot=()=>entry.affectedPaths.map(path=>{const bytes=sdkFileBytes(sdk,path);return[path,bytes===null?null:createHash('sha256').update(bytes).digest('hex')]})
    const before=snapshot()
    assert.deepEqual(applyUpstreamPatches(root,sdk).map(row=>row.status),['already-applied']);assert.deepEqual(snapshot(),before)
    const changed=entry.affectedPaths.find(path=>entry.finalPostimages[path]!==null),target=join(sdk,changed),bytes=readFileSync(target)
    writeFileSync(target,Buffer.concat([bytes,Buffer.from('\n// unsigned current bundle tail\n')]))
    const modified=snapshot()
    assert.throws(()=>applyUpstreamPatches(root,sdk),/SDK_SOURCE_AFFECTED_STAGE_MISMATCH/);assert.deepEqual(snapshot(),modified)
    writeFileSync(target,bytes);rmSync(target);const missing=snapshot()
    assert.throws(()=>applyUpstreamPatches(root,sdk),/SDK_SOURCE_AFFECTED_STAGE_MISMATCH/);assert.deepEqual(snapshot(),missing)
    writeFileSync(target,bytes)
    const unknown=join(sdk,'packages/core/agent/src/unknown-current-bundle-source.ts')
    writeFileSync(unknown,'export const unsigned = true\n')
    assert.throws(()=>applyUpstreamPatches(root,sdk),/SDK_SOURCE_UNKNOWN_ADDITION/);assert.deepEqual(snapshot(),before)
    assert.equal(readFileSync(unknown,'utf8'),'export const unsigned = true\n')
  }finally{rmSync(dir,{recursive:true,force:true})}
})

function rc2Fixture(){
 const dir=mkdtempSync(join(tmpdir(),'lyapunov-rc2-patch-fixture-')),product=join(dir,'product'),sdk=join(dir,'candidate')
 const lock=JSON.parse(readFileSync(join(root,'UPSTREAM_LOCK.json'),'utf8'))
 const put=(path,bytes)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes)}
 put(join(product,'UPSTREAM_LOCK.json'),JSON.stringify(lock,null,2)+'\n')
 run('git',['clone','--shared','--no-checkout','--quiet',rc2Upstream,sdk])
 run('git',['checkout','--quiet','--detach',SDK_BASE_COMMIT],{cwd:sdk})
 const modified=['packages/core/agent/src/index.ts','packages/core/agent/src/types.ts']
 for(const path of modified)writeFileSync(join(sdk,path),readFileSync(join(sdk,path),'utf8')+'\n// 独立完整RC2生成回归fixture\n')
 const added='packages/core/agent/src/rc2-bootstrap-fixture.ts',deleted='docs/glossary.i18n.yaml'
 put(join(sdk,added),'export const fixtureSource = true\n');rmSync(join(sdk,deleted))
 const before=readFileSync(join(product,'UPSTREAM_LOCK.json'))
 const first=generateRC2SdkPatch({root:product,sdk})
 const second=generateRC2SdkPatch({root:product,sdk})
 assert.deepEqual(first.patch,second.patch);assert.deepEqual(first.manifestBytes,second.manifestBytes);assert.deepEqual(first.lockBytes,second.lockBytes)
 assert.deepEqual(readFileSync(join(product,'UPSTREAM_LOCK.json')),before)
 assert.equal(existsSync(join(product,RC2_PRODUCT_PATCH)),false)
 assert.equal(existsSync(join(product,RC2_INTEGRITY_MANIFEST)),false)
 generateRC2SdkPatch({root:product,sdk,publish:true})
 assert.deepEqual(preflightUpstreamPatches(product),upstreamPatches(product))
 const next=JSON.parse(readFileSync(join(product,'UPSTREAM_LOCK.json'),'utf8'))
 for(const [key,value] of Object.entries(lock))if(key!=='sdkSourceIntegrity'&&key!=='sdkProductPatch')assert.deepEqual(next[key],value)
 const replay=join(dir,'replay')
 run('git',['clone','--shared','--no-checkout','--quiet',rc2Upstream,replay])
 run('git',['checkout','--quiet','--detach',SDK_BASE_COMMIT],{cwd:replay})
 const paths=[...modified,added,deleted].sort()
 const snapshot=()=>paths.map(path=>{const bytes=sdkFileBytes(replay,path);return [path,bytes?.toString('hex')??null]})
 return {dir,product,sdk,replay,paths,snapshot,added,deleted,close:()=>rmSync(dir,{recursive:true,force:true})}
}

test('RC2当前registry只选固定单补丁，旧53项只留明确legacy入口',()=>{
 const current=upstreamPatches(root)
 assert.deepEqual(current,[{file:join(root,RC2_PRODUCT_PATCH),package:'@deepseek-ai/dsh-root'}])
 assert.equal(legacyUpstreamPatches(root).length,53)
 const dir=mkdtempSync(join(tmpdir(),'lyapunov-rc2-lock-refusal-'))
 try{
  writeFileSync(join(dir,'UPSTREAM_LOCK.json'),JSON.stringify({commit:SDK_BASE_COMMIT}))
  assert.throws(()=>preflightUpstreamPatches(dir),/SDK_RC2_PATCH_REQUIRED/)
  assert.throws(()=>applyUpstreamPatches(dir,rc2Upstream),/SDK_RC2_PATCH_REQUIRED/)
  writeFileSync(join(dir,'UPSTREAM_LOCK.json'),JSON.stringify({commit:LEGACY_SDK_BASE_COMMIT}))
  assert.equal(upstreamPatches(dir).length,53)
  writeFileSync(join(dir,'UPSTREAM_LOCK.json'),JSON.stringify({commit:'0'.repeat(40)}))
  assert.throws(()=>upstreamPatches(dir),/SDK_SOURCE_BASE_UNSUPPORTED/)
 }finally{rmSync(dir,{recursive:true,force:true})}
})

test('RC2完整干净base到精确final、字节确定性与重复幂等，锁其他字段保留',{timeout:isolatedTestTimeoutMs},()=>{
 const f=rc2Fixture()
 try{
  assert.deepEqual(applyUpstreamPatches(f.product,f.replay).map(row=>row.status),['applied'])
  const patches=upstreamPatches(f.product),proof=verifySDKSourceIntegrity(f.product,f.replay,patches,true)
  assert.equal(proof.baseCommit,SDK_BASE_COMMIT);assert.ok(proof.baselineFiles>5000);assert.equal(proof.affectedFiles,4)
  for(const path of f.paths)assert.deepEqual(sdkFileBytes(f.replay,path),sdkFileBytes(f.sdk,path))
  assert.equal(existsSync(join(f.replay,f.deleted)),false)
  const before=f.snapshot();assert.deepEqual(applyUpstreamPatches(f.product,f.replay).map(row=>row.status),['already-applied']);assert.deepEqual(f.snapshot(),before)
 }finally{f.close()}
})

test('RC2改patch或签名manifest在任何SDK写入前拒绝且保留原件',{timeout:isolatedTestTimeoutMs},()=>{
 const f=rc2Fixture()
 try{
  const before=f.snapshot(),patch=join(f.product,RC2_PRODUCT_PATCH),bytes=readFileSync(patch)
  writeFileSync(patch,Buffer.concat([bytes,Buffer.from('\n# unknown patch byte\n')]))
  assert.throws(()=>preflightUpstreamPatches(f.product),/SDK_RC2_PATCH_SIGNATURE_INVALID/);assert.throws(()=>applyUpstreamPatches(f.product,f.replay),/SDK_RC2_PATCH_SIGNATURE_INVALID/);assert.deepEqual(f.snapshot(),before);writeFileSync(patch,bytes)
  const manifest=join(f.product,RC2_INTEGRITY_MANIFEST),body=readFileSync(manifest)
  writeFileSync(manifest,Buffer.concat([body,Buffer.from(' ')]))
  assert.throws(()=>preflightUpstreamPatches(f.product),/SDK_SOURCE_INTEGRITY_SIGNATURE_INVALID/);assert.throws(()=>applyUpstreamPatches(f.product,f.replay),/SDK_SOURCE_INTEGRITY_SIGNATURE_INVALID/);assert.deepEqual(f.snapshot(),before)
 }finally{f.close()}
})

test('RC2改base未覆文件或未知新增source在写前拒绝，private ignore不能藏来源',{timeout:isolatedTestTimeoutMs},()=>{
 const f=rc2Fixture()
 try{
  const path=join(f.replay,'packages/core/agent/src/runtime-types.ts'),bytes=readFileSync(path),before=f.snapshot()
  writeFileSync(path,Buffer.concat([bytes,Buffer.from('\n// unknown baseline byte\n')]))
  const changed=readFileSync(path)
  assert.throws(()=>applyUpstreamPatches(f.product,f.replay),/SDK_SOURCE_BASE_BYTES_MISMATCH/);assert.deepEqual(readFileSync(path),changed);assert.deepEqual(f.snapshot(),before)
  writeFileSync(path,bytes)
  const unknown='packages/core/agent/src/unknown-new-source.ts'
  writeFileSync(join(f.replay,unknown),'export const unsigned = true\n')
  writeFileSync(join(f.replay,'.git/info/exclude'),unknown+'\n')
  assert.throws(()=>applyUpstreamPatches(f.product,f.replay),/SDK_SOURCE_UNKNOWN_ADDITION/)
  assert.equal(readFileSync(join(f.replay,unknown),'utf8'),'export const unsigned = true\n');assert.deepEqual(f.snapshot(),before)
 }finally{f.close()}
})

test('RC2改final、缺件与部分合法hunk都不能靠reverse-check认幂等',{timeout:isolatedTestTimeoutMs},()=>{
 const f=rc2Fixture()
 try{
  const path=f.paths.find(path=>path.endsWith('/index.ts')),target=join(f.replay,path)
  writeFileSync(target,sdkFileBytes(f.sdk,path))
  const mixed=f.snapshot();assert.throws(()=>applyUpstreamPatches(f.product,f.replay),/SDK_SOURCE_AFFECTED_STAGE_MISMATCH/);assert.deepEqual(f.snapshot(),mixed)
  run('git',['checkout','--quiet',SDK_BASE_COMMIT,'--',path],{cwd:f.replay});applyUpstreamPatches(f.product,f.replay)
  const bytes=readFileSync(target);writeFileSync(target,Buffer.concat([bytes,Buffer.from('\n// unknown final tail\n')]))
  const changed=f.snapshot();assert.throws(()=>applyUpstreamPatches(f.product,f.replay),/SDK_SOURCE_AFFECTED_STAGE_MISMATCH/);assert.deepEqual(f.snapshot(),changed)
  writeFileSync(target,bytes);rmSync(join(f.replay,f.added));const missing=f.snapshot()
  assert.throws(()=>applyUpstreamPatches(f.product,f.replay),/SDK_SOURCE_AFFECTED_STAGE_MISMATCH/);assert.deepEqual(f.snapshot(),missing);assert.equal(existsSync(join(f.replay,f.added)),false)
 }finally{f.close()}
})

test('RC2签名stage/final结构与旧7c3记录不能冒充当前来源',{timeout:isolatedTestTimeoutMs},()=>{
 const f=rc2Fixture()
 try{
  const manifestFile=join(f.product,RC2_INTEGRITY_MANIFEST),original=readFileSync(manifestFile),lockFile=join(f.product,'UPSTREAM_LOCK.json'),lockBytes=readFileSync(lockFile),before=f.snapshot()
  for(const field of ['stageHashes','finalHash']){
   const manifest=JSON.parse(original),entry=Object.values(manifest.registries)[0],lock=JSON.parse(lockBytes)
   entry[field]=field==='stageHashes'?[]:'0'.repeat(64)
   const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');writeFileSync(manifestFile,bytes);lock.sdkSourceIntegrity.sha256=createHash('sha256').update(bytes).digest('hex');writeFileSync(lockFile,JSON.stringify(lock))
   assert.throws(()=>applyUpstreamPatches(f.product,f.replay),field==='stageHashes'?/SDK_SOURCE_STAGES_INVALID/:/SDK_SOURCE_FINAL_IMAGES_INVALID/);assert.deepEqual(f.snapshot(),before)
  }
  writeFileSync(manifestFile,original)
  const lock=JSON.parse(lockBytes);lock.sdkSourceIntegrity={...lock.sdkSourceIntegrity,baseCommit:LEGACY_SDK_BASE_COMMIT,file:'script/sdk-source-integrity.json'};writeFileSync(lockFile,JSON.stringify(lock))
  assert.throws(()=>applyUpstreamPatches(f.product,f.replay),/SDK_SOURCE_INTEGRITY_REQUIRED/);assert.deepEqual(f.snapshot(),before)
 }finally{f.close()}
})

test('RC2生成器拒错HEAD及unmerged，不发布patch/manifest或改锁',{timeout:isolatedTestTimeoutMs},()=>{
 const f=rc2Fixture()
 try{
  const lock=join(f.product,'UPSTREAM_LOCK.json'),before=readFileSync(lock),patch=readFileSync(join(f.product,RC2_PRODUCT_PATCH)),manifest=readFileSync(join(f.product,RC2_INTEGRITY_MANIFEST))
  const own=JSON.parse(before);own.commit=LEGACY_SDK_BASE_COMMIT;writeFileSync(lock,JSON.stringify(own))
  assert.throws(()=>generateRC2SdkPatch({root:f.product,sdk:f.sdk,publish:true}),/SDK_SOURCE_BASE_COMMIT_MISMATCH/)
  assert.deepEqual(readFileSync(join(f.product,RC2_PRODUCT_PATCH)),patch);writeFileSync(lock,before)
  run('git',['update-ref','HEAD',LEGACY_SDK_BASE_COMMIT],{cwd:f.sdk})
  assert.throws(()=>generateRC2SdkPatch({root:f.product,sdk:f.sdk,publish:true}),/SDK_SOURCE_BASE_COMMIT_MISMATCH/)
  assert.deepEqual(readFileSync(lock),before);assert.deepEqual(readFileSync(join(f.product,RC2_PRODUCT_PATCH)),patch)
  run('git',['update-ref','HEAD',SDK_BASE_COMMIT],{cwd:f.sdk})
  const path='packages/core/agent/src/index.ts',blob=run('git',['rev-parse',SDK_BASE_COMMIT+':'+path],{cwd:f.sdk}).trim()
  run('git',['update-index','--index-info'],{cwd:f.sdk,input:'0 '+ '0'.repeat(40)+'\t'+path+'\n100644 '+blob+' 1\t'+path+'\n100644 '+blob+' 2\t'+path+'\n100644 '+blob+' 3\t'+path+'\n'})
  assert.throws(()=>generateRC2SdkPatch({root:f.product,sdk:f.sdk,publish:true}),/SDK_RC2_GENERATION_UNMERGED/)
  assert.deepEqual(readFileSync(lock),before);assert.deepEqual(readFileSync(join(f.product,RC2_PRODUCT_PATCH)),patch);assert.deepEqual(readFileSync(join(f.product,RC2_INTEGRITY_MANIFEST)),manifest)
 }finally{f.close()}
})
