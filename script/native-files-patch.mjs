import {spawnSync} from 'node:child_process'
import {readFileSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
/** 只认签定的完整原生文件 pre/postimage；未知源码不因补丁逆向可应用而被跳过。 */
export function applySignedFilesPatch(_root,upstream,patch){
 const manifest=JSON.parse(readFileSync(patch.file+'.json','utf8'))
 if(manifest.version!==1||manifest.patchSha256!==digest(patch.file)||!Array.isArray(manifest.files)||manifest.files.length===0)throw Error('原生文件补丁签名/清单不匹配')
 for(const row of manifest.files)if(!/^packages\//.test(row.path)||row.path.includes('..'))throw Error('原生文件补丁路径非法')
 const current=row=>existsSync(join(upstream,row.path))?digest(join(upstream,row.path)):null
 const match=field=>manifest.files.every(row=>current(row)===row[field])
 const run=args=>{const result=spawnSync('git',['-C',upstream,'apply',...args,patch.file],{encoding:'utf8'});if(result.status!==0)throw Error('原生文件补丁消费失败：'+result.stderr)}
 if(match('afterSha256')){run(['--reverse','--check']);return{...patch,status:'already-applied',verifiedComposition:'native-files-exact-postimage'}}
 if(!match('beforeSha256'))throw Error('原生文件SDK内容不匹配签定pre/postimage，保留未知修改')
 run(['--check']);run([])
 if(!match('afterSha256'))throw Error('原生文件SDK消费后hash不匹配')
 return{...patch,status:'applied'}
}
