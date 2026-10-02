import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join,basename} from 'node:path'
import {spawnSync} from 'node:child_process'

const OLD='030960391eac91eb298b5018b96bc1a4fc8a5995de55c421cf097150c918b384'
const ENGLISH='16b94f78a102d7820163decdf3204b853afbc63833c1745b21ff9ee36a1d70c2'
const BASE='packages/lyapunov-shell/patches/dsh-formal-model-input'
const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
const paths=body=>[...new Set([...body.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(row=>row[1]))].sort()
const current=(sdk,path)=>{try{return digest(join(sdk,path))}catch(error){if(error?.code==='ENOENT')return null;throw error}}

/** 旧正式完整post仅升级两个English字面量；不逆装整个正式patch、不接受混合或未知本体。 */
export function applyFormalEnglishUpgrade(root,sdk,patch){
  if(basename(patch.file)!=='dsh-formal-model-input.patch')return null
  const record=JSON.parse(readFileSync(join(root,'UPSTREAM_LOCK.json'),'utf8')).sdkFormalEnglishUpgrade
  if(!record)return null
  if(record.file!==BASE+'.english-upgrade.json'||record.patch!==BASE+'.english-upgrade.patch'||digest(patch.file)!==ENGLISH||digest(join(root,record.file))!==record.sha256||digest(join(root,record.patch))!==record.patchSha256)throw Error('SDK_FORMAL_ENGLISH_SIGNATURE_INVALID')
  const signed=JSON.parse(readFileSync(join(root,record.file),'utf8')),expected=paths(readFileSync(patch.file,'utf8'))
  if(signed.version!==1||signed.oldArtifactSha256!==OLD||signed.englishArtifactSha256!==ENGLISH||JSON.stringify(Object.keys(signed.beforeHashes??{}).sort())!==JSON.stringify(expected)||JSON.stringify(Object.keys(signed.afterHashes??{}).sort())!==JSON.stringify(expected)||expected.some(path=>!/^([a-f0-9]{64})$/.test(signed.beforeHashes[path])||!/^([a-f0-9]{64})$/.test(signed.afterHashes[path])))throw Error('SDK_FORMAL_ENGLISH_IMAGES_INVALID')
  const changed=expected.filter(path=>signed.beforeHashes[path]!==signed.afterHashes[path])
  if(JSON.stringify(changed)!==JSON.stringify(['packages/bundle/web-app/src/index.ts','packages/bundle/web-app/tests/web-app.spec.ts'])||JSON.stringify(paths(readFileSync(join(root,record.patch),'utf8')))!==JSON.stringify(changed))throw Error('SDK_FORMAL_ENGLISH_DELTA_INVALID')
  const actual=Object.fromEntries(expected.map(path=>[path,current(sdk,path)])),same=hashes=>expected.every(path=>actual[path]===hashes[path])
  if(same(signed.afterHashes))return {...patch,status:'already-applied',verifiedComposition:'formal-english-exact-complete-postimages'}
  if(!same(signed.beforeHashes))return null // 原fresh固定base仍经主消费器check→apply；未知state由完整来源门先拒。
  const invoke=args=>{const result=spawnSync('git',['apply',...args,join(root,record.patch)],{cwd:sdk,encoding:'utf8'});if(result.status!==0)throw Error('SDK_FORMAL_ENGLISH_UPGRADE_FAILED: '+result.stderr)}
  invoke(['--check']);invoke([])
  if(!expected.every(path=>current(sdk,path)===signed.afterHashes[path]))throw Error('SDK_FORMAL_ENGLISH_POSTIMAGE_MISMATCH')
  return {...patch,status:'applied',verifiedComposition:'formal-english-exact-two-file-upgrade'}
}
