import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {sdkPublicPostimageMatches} from './sdk-source-integrity.mjs'

const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
const pathHashes=(upstream,paths)=>Object.fromEntries(paths.map(path=>{
  try{return [path,digest(join(upstream,path))]}catch(error){if(error?.code==='ENOENT')return [path,null];throw error}
}))

/** PublicDiagnostics整份pre/post认定；逆check/提交主题都不能授权未知完整本体。 */
export function applyPublicModelDiagnosticsPatch(root,upstream,patch,sourceProof){
  const record=JSON.parse(readFileSync(join(root,'UPSTREAM_LOCK.json'),'utf8')).a08PublicModelDiagnosticsPatch
  if(!record||record.file!=='packages/lyapunov-shell/patches/dsh-public-model-diagnostics.patch'||patch.file!==join(root,record.file)||record.sha256!==digest(patch.file))throw Error('PUBLIC_MODEL_PATCH_SIGNATURE_INVALID')
  const expected=[...new Set([...readFileSync(patch.file,'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)].map(row=>row[1]))].sort()
  if(!Array.isArray(record.files)||expected.length===0||JSON.stringify(record.files.map(row=>row.path).sort())!==JSON.stringify(expected))throw Error('PUBLIC_MODEL_PATCH_FILES_INVALID')
  for(const row of record.files){
    if(!/^(packages|docs|\.agents)\//.test(row.path)||row.path.split('/').includes('..')||!(row.preSha256===null||typeof row.preSha256==='string'&&/^[a-f0-9]{64}$/.test(row.preSha256))||typeof row.postSha256!=='string'||!/^[a-f0-9]{64}$/.test(row.postSha256))throw Error('PUBLIC_MODEL_PATCH_FILES_INVALID')
  }
  const current=pathHashes(upstream,expected),same=field=>record.files.every(row=>current[row.path]===row[field])
  // actualregistry先核完整base和签定全序stage；合法后继仍逐26完整post核，不能只保三个hunk。
  const successor=sourceProof!==undefined&&sdkPublicPostimageMatches(sourceProof,current,expected)
  let formal=false
  const composition=record.composition,variant=composition?.formalModelInput
  if(variant&&variant.file==='packages/lyapunov-shell/patches/dsh-formal-model-input.patch'&&variant.publicModelSha256===record.sha256&&variant.requestBudgetSha256===composition.prerequisiteSha256){
    const budget=join(root,'packages/lyapunov-shell/patches/dsh-model-request-phase-budget.patch')
    const required=[...new Set([...readFileSync(budget,'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)].map(row=>row[1]))].sort()
    if(JSON.stringify(Object.keys(variant.postHashes??{}).sort())===JSON.stringify(required)){
      let formalSha=null
      try{formalSha=digest(join(root,variant.file))}catch(error){if(error?.code!=='ENOENT')throw error}
      if(formalSha===variant.sha256&&digest(budget)===variant.requestBudgetSha256){
        const full=pathHashes(upstream,required)
        formal=required.every(path=>typeof variant.postHashes[path]==='string'&&/^[a-f0-9]{64}$/.test(variant.postHashes[path])&&full[path]===variant.postHashes[path])
          &&record.files.every(row=>current[row.path]===(row.path==='packages/core/agent-loop/src/agent.ts'?variant.postHashes[row.path]:row.postSha256))
      }
    }
  }
  if(same('postSha256')||formal||successor)return {...patch,status:'already-applied',verifiedComposition:successor?'public-model-signed-registry-full-postimages':formal?'public-model-formal-exact-postimages':'public-model-exact-postimages'}
  if(!same('preSha256'))throw Error('PUBLIC_MODEL_PATCH_SOURCE_MISMATCH: '+record.files.filter(row=>current[row.path]!==row.preSha256&&current[row.path]!==row.postSha256).map(row=>row.path).join(', '))
  const run=args=>{
    const result=spawnSync('git',['apply',...args,patch.file],{cwd:upstream,encoding:'utf8'})
    if(result.status!==0)throw Error('PUBLIC_MODEL_PATCH_APPLY_FAILED: '+result.stderr)
  }
  run(['--check']);run([])
  const applied=pathHashes(upstream,expected)
  if(!record.files.every(row=>applied[row.path]===row.postSha256))throw Error('PUBLIC_MODEL_PATCH_POSTIMAGE_MISMATCH')
  return {...patch,status:'applied',verifiedComposition:'public-model-exact-pre-to-postimages'}
}
