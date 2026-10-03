import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {test} from 'node:test'
import ts from 'typescript'
import {createHash} from 'node:crypto'
import {verifiedComposedPatch} from './upstream-patches.mjs'
import {applyUpstreamPatches,upstreamPatches} from './upstream-patches.mjs'
import {applyPublicModelDiagnosticsPatch} from './public-model-patch.mjs'
import {verifySDKSourceIntegrity} from './sdk-source-integrity.mjs'
import {applySignedFilesPatch} from './native-files-patch.mjs'

const root = resolve(import.meta.dirname, '..')
const candidate = join(root, 'packages/lyapunov-shell/patches/dsh-session-outbound-projection.patch')
const upstream = join(root, '.upstream/deepseek-harness-20260911-candidate')
const native = 'packages/api/session-controller/src'
const isolatedTestTimeoutMs = 120_000

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
    const pinned=run('git',['show',`HEAD:${name}`],{cwd:upstream});writeFileSync(target,pinned)
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
  const proof=verifySDKSourceIntegrity(root,upstream,upstreamPatches(root))
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
    applyUpstreamPatches(root,scratch);assert.equal(applyUpstreamPatches(root,scratch).filter(row=>row.status==='applied').length,0)
    const baseFile=join(scratch,'packages/core/agent/src/index.ts'),bytes=readFileSync(baseFile);writeFileSync(baseFile,Buffer.concat([bytes,Buffer.from('\n// unknown base bytes\n')]))
    assert.throws(()=>applyUpstreamPatches(root,scratch),/BASE_BYTES_MISMATCH/);assert.equal(readFileSync(baseFile).subarray(bytes.length).toString(),'\n// unknown base bytes\n');writeFileSync(baseFile,bytes)
    const unknown=join(scratch,'packages/core/agent/src/unknown-new-source.ts');writeFileSync(unknown,'export const unknown = true\n')
    assert.throws(()=>applyUpstreamPatches(root,scratch),/UNKNOWN_ADDITION/);assert.equal(readFileSync(unknown,'utf8'),'export const unknown = true\n');rmSync(unknown)
    const changed=join(scratch,'packages/llm/llm-pi-ai/src/adapter.ts'),original=readFileSync(changed);writeFileSync(changed,Buffer.concat([original,Buffer.from('\n// S03 unknown\n')]))
    assert.throws(()=>applyUpstreamPatches(root,scratch),/AFFECTED_STAGE_MISMATCH/);writeFileSync(changed,original)
    const ignored=join(scratch,'packages/core/agent/lib/fixture-build-output.js');mkdirSync(dirname(ignored),{recursive:true});writeFileSync(ignored,'generated fixture\n')
    run('git',['check-ignore',ignored],{cwd:scratch});assert.equal(applyUpstreamPatches(root,scratch).filter(row=>row.status==='applied').length,0);assert.equal(readFileSync(ignored,'utf8'),'generated fixture\n')
  }finally{rmSync(scratch,{recursive:true,force:true})}
})

// Registry ownership belongs to Lead; these tests neither require nor add an entry.
test('candidate compiles and executes native outbound behavior in an isolated copy', {timeout: isolatedTestTimeoutMs}, () => {
  const scratch = mkdtempSync(join(root, '.tmp-outbound-projection-'))
  try {
    const paths = run('git', ['apply', '--numstat', candidate]).trim().split('\n').map(line => line.split('\t')[2])
    const hostConfig = 'packages/api/session-controller/tsconfig.host.json'
    assert.deepEqual(paths, [`${native}/history.ts`, `${native}/outbound-projection.ts`, hostConfig])
    // Read the pinned commit, not a potentially patched working-tree file.
    for (const path of ['history.ts', 'assistant-stream.ts', 'types.ts'].map(name => `${native}/${name}`).concat(hostConfig)) {
      const target = join(scratch, path)
      mkdirSync(dirname(target), {recursive: true})
      writeFileSync(target, run('git', ['show', `HEAD:${path}`], {cwd: upstream}))
    }
    // Make git operate on this copy, rather than discovering the enclosing product repo.
    run('git', ['init', '--quiet', scratch])
    run('git', ['apply', '--check', candidate], {cwd: scratch})
    run('git', ['apply', candidate], {cwd: scratch})
    const hostFiles = JSON.parse(readFileSync(join(scratch, hostConfig), 'utf8')).files
    assert.equal(hostFiles.includes('src/outbound-projection.ts'), true, 'Host compiler must include the new source')
    assert.equal(readFileSync(join(scratch, native, 'history.ts'), 'utf8').includes('@ts-ignore TS6307'), false)
    symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')

    // Compile the patched source against the pinned package declarations, without
    // rebuilding or modifying any upstream source or artifact. Missing built
    // dependencies fail this test, rather than silently skipping type checking.
    const base = ts.readConfigFile(join(upstream, 'tsconfig.base.json'), ts.sys.readFile)
    assert.equal(base.error, undefined)
    const pathsToDeclarations = Object.fromEntries(Object.entries(base.config.compilerOptions.paths).map(([key, values]) => [
      key, values.map(value => resolve(upstream, value.replace(/\/src(?=\/|$)/, '/lib/types').replace(/\.ts$/, '.d.ts'))),
    ]))
    const outDir = join(scratch, 'compiled')
    const config = {
      compilerOptions: {
        target: 'ES2023', module: 'ESNext', moduleResolution: 'bundler',
        strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
        noUnusedLocals: true, noUnusedParameters: true, skipLibCheck: true,
        rewriteRelativeImportExtensions: true, noEmitOnError: true,
        rootDir: join(scratch, native), outDir, types: ['node'],
        paths: pathsToDeclarations,
      },
      files: [join(scratch, native, 'history.ts')],
    }
    writeFileSync(join(scratch, 'tsconfig.compile.json'), JSON.stringify(config))
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(scratch, 'tsconfig.compile.json'), '--pretty', 'false'])
    for (const name of ['history.js', 'outbound-projection.js', 'assistant-stream.js']) {
      assert.equal(existsSync(join(outDir, name)), true, `missing compiler output ${name}`)
    }
    const bun = process.env.BUN_BIN ?? (process.versions.bun ? process.execPath : 'bun')
    const output = run(bun, ['--no-env-file', 'test', join(root, 'script/outbound-projection.test.ts')], {
      env: {...process.env, LYAPUNOV_OUTBOUND_COMPILED: outDir},
    })
    if (output.trim()) console.log(output.trim())
  } finally {
    rmSync(scratch, {recursive: true, force: true})
  }
})
