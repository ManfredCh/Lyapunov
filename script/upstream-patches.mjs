import {applySignedFilesPatch} from './native-files-patch.mjs'
import {applySignedGuestOwnProviderPatch,verifiedGuestOwnProviderComposition} from './guest-own-provider-patch.mjs'
import {applySignedGuestPatch} from './guest-model-patch.mjs'
import {spawnSync} from 'node:child_process'
import {join,basename} from 'node:path'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {applyPublicModelDiagnosticsPatch} from './public-model-patch.mjs'
import {verifySDKSourceIntegrity,sdkSourceIsFinal} from './sdk-source-integrity.mjs'
import {applyFormalEnglishUpgrade} from './formal-english-upgrade.mjs'


/** E27 只认固定三补丁和所有原/新增源码的精确组合；未知 postimage 仍失败。 */
export function verifiedBrowserRootComposition(root,upstream,patch){
  if(!['dsh-browser-use-recovery.patch','dsh-browser-use-runtime-diagnostics.patch'].includes(basename(patch.file)))return false
  const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
  try{
    const manifestPath=join(root,'packages/lyapunov-shell/patches/dsh-browser-root-owner.postimage.json')
    if(digest(manifestPath)!=='3974ccc8f39ff3aa1d97284c1c57e0f0ddb28dd15a5722df3edf9b9257cd3026')return false
    const signed=JSON.parse(readFileSync(manifestPath,'utf8'))
    if(digest(join(root,'packages/lyapunov-shell/patches/dsh-browser-root-owner.patch'))!=='095979700cccdc87966a96fa06fd8bab8bb694a3f10f88ed2b314f0d694a259a')return false
    return Object.entries(signed.patches).every(([file,sha])=>digest(join(root,'packages/lyapunov-shell/patches',file))===sha)
      &&signed.postimages.every(({path,sha256})=>digest(join(upstream,path))===sha256)
  }catch{return false}
}

// 已签R-019组合：headline替换了旧补丁的上下文，但保留移除preview的实际效果。
// 只认两份精确补丁与三个完整postimage；改一字或丢一个效果仍回原冲突路径。
export function verifiedComposedPatch(root,upstream,patch){
  if(verifiedBrowserRootComposition(root,upstream,patch))return true
  if(basename(patch.file)==='dsh-managed-provider-discovery.patch'&&spawnSync('git',['-C',upstream,'apply','--check',patch.file]).status!==0)return Boolean(verifiedGuestOwnProviderComposition(root,upstream))
  const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
  if(basename(patch.file)==='dsh-model-request-phase-budget.patch'){
    const record=JSON.parse(readFileSync(join(root,'UPSTREAM_LOCK.json'),'utf8')).a08PublicModelDiagnosticsPatch
    if(!record||record.file!=='packages/lyapunov-shell/patches/dsh-public-model-diagnostics.patch'||record.composition?.prerequisite!=='dsh-model-request-phase-budget.patch'||record.composition.prerequisiteSha256!==digest(patch.file)||record.sha256!==digest(join(root,record.file)))return false
    const expected=[...new Set([...readFileSync(patch.file,'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match=>match[1]))].sort()
    const matches=hashes=>{
      if(!hashes||typeof hashes!=='object'||Array.isArray(hashes)||expected.length===0||JSON.stringify(Object.keys(hashes).sort())!==JSON.stringify(expected))return false
      return expected.every(file=>typeof hashes[file]==='string'&&/^[a-f0-9]{64}$/.test(hashes[file])&&digest(join(upstream,file))===hashes[file])
    }
    if(matches(record.composition.postHashes))return true
    // formal纯输入投影与public诊断修改同一agent文件；仅认三个固定补丁与完整组合。
    const formal=record.composition.formalModelInput
    if(!formal||formal.file!=='packages/lyapunov-shell/patches/dsh-formal-model-input.patch'||formal.publicModelSha256!==record.sha256||formal.requestBudgetSha256!==record.composition.prerequisiteSha256)return false
    let formalSha
    try{formalSha=digest(join(root,formal.file))}catch(error){if(error?.code==='ENOENT')return false;throw error}
    if(formalSha!==formal.sha256)return false
    return matches(formal.postHashes)
  }
  // A07 覆盖 A06 的两个浏览器源码 hunk；旧补丁反向检查会因已签组合失配。
  // 只认两份精确补丁与所有原补丁文件的完整 postimage，不接受未知 SDK 修改。
  if(basename(patch.file)==='dsh-browser-use-recovery.patch'){
    try{
      if(digest(patch.file)!=='0636c005d87dca92510ef063e2de2937487f7736de91aef70553d4d2fc4917bb')return false
      if(digest(join(root,'packages/lyapunov-shell/patches/dsh-browser-use-runtime-diagnostics.patch'))!=='ee245e9a111a5cb54648e2f8f9c5e5a1fe8f5e31a25e4bcbf00aff760e1766f9')return false
      return [
        ["packages/experimental/browser-use-runtime/src/index.ts", "c7ba92b89f38d28bfa2714ff348a51411b3ac34c25999e437625675ec239a646"],
        ["packages/experimental/browser-use-runtime/src/mcp.ts", "b5542e5331c6855d65669f30939751ae477dbb2d3dbfb1a26b937be6f08bbf82"],
        ["packages/experimental/browser-use-runtime/tests/mcp-fixture.mjs", "2ce8950083ac72041c8032d16b633b4c68e1465c45c4cb723c510e889d0e9815"],
        ["packages/experimental/browser-use-runtime/tests/mcp.spec.ts", "4ddc5d39aec6e0b2d434ed5904d45d45ecf5c278db2bd04e2a592d33c68d20ae"],
        ["packages/experimental/browser-use-runtime/tests/resources.spec.ts", "9cd987327745661a9c5228e9d31a4dcb96ef50cd1ee28f1b197f6a2b254d7228"],
        ["packages/mcp/mcp-client/src/connection.ts", "682248b61371953d40fccee236ba16c1de02cd6ad4ea90e41275332957397d6c"],
        ["packages/mcp/mcp-client/src/index.ts", "bff7afbabf4f9d6487fde0670b4de8ebfd1325da909bdc29ded8df2834059871"],
        ["packages/mcp/mcp-client/tests/reconnect.spec.ts", "4d1f954bff3f1c4413b88e2ecfb86301509a2b87dca71245c0c622b24d33fb51"],
      ].every(([name,sha])=>digest(join(upstream,name))===sha)
    }catch{return false}
  }
  if(basename(patch.file)!=='dsh-hero-preview-badge.patch')return false
  try{
    if(digest(patch.file)!=='0bf410d3888ef375957a4207c4f672cd68f2a3206909da67402f7cf4613187c8')return false
    if(digest(join(root,'packages/lyapunov-shell/patches/dsh-hero-headline-slot.patch'))!=='508fb9af773f637896c04ac8eb4e257e7cdac05946b460a99c710bf78962e0ba')return false
    return [
      ['packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx','7a3cc83fd5e928867418cf535d506cb3e0faf613cbf28c875b0f62a8325a0d32'],
      ['packages/client/ui-conversation/src/client/contract/slots.ts','934195f24b3c8b0d1493ec9a07be246e71251dbefe6c9786a92cbc880d5bffed'],
      ['packages/client/ui-conversation/src/client/apply.ts','16e058ab9a6db0145ecf4dfb7f6cbd19c8a2e03430f8dfaa78da720db566c061'],
    ].every(([name,sha])=>digest(join(upstream,name))===sha)
  }catch{return false}
}

/** 固定上游commit上的少量可审阅补丁；重复运行不覆盖用户的其他修改。 */
export function upstreamPatches(root){
  return [
    {file:join(root,'packages/lyaup-migrations/patches/dsh-v2-queued-surface.patch'),package:'@deepseek-ai/dsh-session-format-v2-to-v3'},
    {file:join(root,'packages/lyapunov-mcp-extras/patches/dsh-mcp-content-bridge.patch'),package:'@deepseek-ai/dsh-mcp-client'},
    {file:join(root,'packages/lyapunov-mcp-extras/patches/dsh-mcp-oauth-bridge.patch'),package:'@deepseek-ai/dsh-mcp-client'},
    {file:join(root,'packages/lyapunov-mcp-extras/patches/dsh-acp-compatibility.patch'),package:'@deepseek-ai/dsh-acp'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-settings-open-shortcut.patch'),package:'@deepseek-ai/dsh-client-ui-settings-general'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-input-focus-shortcut.patch'),package:'@deepseek-ai/dsh-client-ui-conversation'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-hero-preview-badge.patch'),package:'@deepseek-ai/dsh-client-ui-conversation'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-hero-headline-slot.patch'),package:'@deepseek-ai/dsh-client-ui-conversation'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-message-navigation-shortcut.patch'),package:'@deepseek-ai/dsh-client-ui-chat'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-command-history-visibility.patch'),package:'@deepseek-ai/dsh-client-ui-chat'},
    {file:join(root,'packages/lyapunov-terminal/patches/dsh-app-interrupt.patch'),package:'@deepseek-ai/dsh-cmdline'},
    {file:join(root,'packages/lyapunov-terminal/patches/remote-node-transport.patch'),package:'@deepseek-ai/dsh-api-gateway'},
    {file:join(root,'packages/lyapunov-terminal/patches/dsh-session-prompt-cancellation.patch'),package:'@deepseek-ai/dsh-api-session-controller'},
    {file:join(root,'packages/lyapunov-session-undo/patches/dsh-history-consumers.patch'),package:'@deepseek-ai/dsh-client-ui-conversation'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-main-surface-seat.patch'),package:'@deepseek-ai/dsh-client-ui-layout'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-native-workspace-tabs.patch'),package:'@deepseek-ai/dsh-client-ui-sidebar-right'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-rightbar-files-toggle.patch'),package:'@deepseek-ai/dsh-client-ui-sidebar-right'},
    {file:join(root,'packages/lyapunov-workspace/patches/dsh-native-files-operations.patch'),package:'@deepseek-ai/dsh-client-ui-sidebar-files'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-preset-skill-roots.patch'),package:'@deepseek-ai/dsh-agent-presets'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-window-scoped-session-selection.patch'),package:'@deepseek-ai/dsh-api-session-controller'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-window-scoped-draft-reuse.patch'),package:'@deepseek-ai/dsh-client-ui-workspace'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-managed-provider-discovery.patch'),package:'@deepseek-ai/dsh-llm-pi-ai'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-peiri-upstream-phase.patch'),package:'@deepseek-ai/dsh-llm-pi-ai'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-provider-balance-header.patch'),package:'@deepseek-ai/dsh-client-ui-settings-models'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-browser-use-recovery.patch'),package:'@deepseek-ai/dsh-experimental-browser-use-runtime'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-browser-use-runtime-diagnostics.patch'),package:'@deepseek-ai/dsh-experimental-browser-use-runtime'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-browser-root-owner.patch'),package:'@deepseek-ai/dsh-experimental-browser-use-runtime'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-browser-recovery-english.patch'),package:'@deepseek-ai/dsh-experimental-browser-use-runtime'},
    {file:join(root,'packages/desktop/patches/dsh-guest-empty-model.patch'),package:'@deepseek-ai/dsh-agent-default-model'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-current-context-snapshot.patch'),package:'@deepseek-ai/dsh-agent-loop'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-skill-content-reuse.patch'),package:'@deepseek-ai/dsh-tool-skill'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-skill-reuse-english.patch'),package:'@deepseek-ai/dsh-tool-skill'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-model-request-phase-budget.patch'),package:'@deepseek-ai/dsh-llm'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-model-request-phase-budget.patch'),package:'@deepseek-ai/dsh-agent-loop'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-current-context-tests.patch'),package:'@deepseek-ai/dsh-agent-loop'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-jobs-observation-identity.patch'),package:'@deepseek-ai/dsh-jobs'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-jobs-observation-identity.patch'),package:'@deepseek-ai/dsh-jobs-local'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-jobs-observation-identity.patch'),package:'@deepseek-ai/dsh-tool-jobs'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-jobs-observation-identity.patch'),package:'@deepseek-ai/dsh-tool-bash'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-jobs-observation-identity.patch'),package:'@deepseek-ai/dsh-api-session-controller'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-public-model-diagnostics.patch'),package:'@deepseek-ai/dsh-llm'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-public-model-diagnostics.patch'),package:'@deepseek-ai/dsh-llm-pi-ai'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-public-model-diagnostics.patch'),package:'@deepseek-ai/dsh-llm-retry'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-public-model-diagnostics.patch'),package:'@deepseek-ai/dsh-agent-loop'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-manual-gesture-display.patch'),package:'@deepseek-ai/dsh-commands'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-formal-model-input.patch'),package:'@deepseek-ai/dsh-system-prompt'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-formal-model-input.patch'),package:'@deepseek-ai/dsh-agent-loop'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-formal-model-input.patch'),package:'@deepseek-ai/dsh-compaction-basic'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-formal-model-input.patch'),package:'@deepseek-ai/dsh-web-app'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-formal-model-input.patch'),package:'@deepseek-ai/dsh-session-title-llm'},
    {file:join(root,'packages/desktop/patches/dsh-guest-own-provider.patch'),package:'@deepseek-ai/dsh-llm-pi-ai'},
    {file:join(root,'packages/lyapunov-shell/patches/dsh-files-directory-flow.patch'),package:'@deepseek-ai/dsh-client-ui-directory-picker-browse'},
  ]
}

export function applyUpstreamPatches(root,upstream){
  const patches=upstreamPatches(root)
  const sourceProof=verifySDKSourceIntegrity(root,upstream,patches)
  const results=[]
  // fork 分支把补丁逐个成 commit("patch: <name> [<pkg>]"),浅克隆下用提交主题判定已在分支内;
  // git apply 的正/反 check 在 rebase 三路合并后会因上下文漂移双败,不能只靠它们。
  const log=spawnSync('git',['log','--format=%s','-n','100'],{cwd:upstream,encoding:'utf8'})
  const subjects=log.status===0?new Set(log.stdout.split('\n').map(line=>line.trim())):new Set()
  const patchName=file=>basename(file).replace(/\.patch$/,'')
  for(const patch of patches){
    if(['dsh-native-files-operations.patch','dsh-files-directory-flow.patch'].includes(basename(patch.file))){results.push(applySignedFilesPatch(root,upstream,patch));continue}
    if(basename(patch.file)==='dsh-guest-own-provider.patch'){results.push(applySignedGuestOwnProviderPatch(root,upstream,patch));continue}
    if(basename(patch.file)==='dsh-guest-empty-model.patch'){results.push(applySignedGuestPatch(root,upstream,patch));continue}
    if(basename(patch.file)==='dsh-public-model-diagnostics.patch'){results.push(applyPublicModelDiagnosticsPatch(root,upstream,patch,sourceProof));continue}
    if(sdkSourceIsFinal(sourceProof)){results.push({...patch,status:'already-applied',verifiedComposition:'sdk-complete-signed-final-source'});continue}
    if(basename(patch.file)==='dsh-formal-model-input.patch'){const upgraded=applyFormalEnglishUpgrade(root,upstream,patch);if(upgraded){results.push(upgraded);continue}}
    const invoke=args=>spawnSync('git',['apply',...args,patch.file],{cwd:upstream,encoding:'utf8'})
    const reverse=invoke(['--reverse','--check'])
    if(reverse.status===0){results.push({...patch,status:'already-applied'});continue}
    if(verifiedComposedPatch(root,upstream,patch)){results.push({...patch,status:'already-applied',verifiedComposition:verifiedBrowserRootComposition(root,upstream,patch)?'browser-root-owner':basename(patch.file)==='dsh-model-request-phase-budget.patch'?'a08-public-model-diagnostics':basename(patch.file)==='dsh-browser-use-recovery.patch'?'browser-runtime-diagnostics':'dsh-hero-headline-slot'});continue}
    if(subjects.has(`patch: ${patchName(patch.file)} [${patch.package}]`)){results.push({...patch,status:'already-in-branch'});continue}
    const checked=invoke(['--check'])
    if(checked.status!==0)throw new Error('固定上游补丁存在冲突，已保留现状：'+patch.file+'\n'+checked.stderr)
    const applied=invoke([])
    if(applied.status!==0)throw new Error('应用上游补丁失败：'+patch.file+'\n'+applied.stderr)
    results.push({...patch,status:'applied'})
  }
  verifySDKSourceIntegrity(root,upstream,patches,true)
  return results
}
