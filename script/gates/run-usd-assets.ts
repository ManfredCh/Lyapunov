/** 原生USD验收：显式纳入envgate，用既有test:ci执行；不访问网络或启动GPU。 */
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve,join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..')
const args=process.argv.slice(2),value=(flag:string)=>args[args.indexOf(flag)+1]
const out=resolve(args.includes('--out')?value('--out'):join(root,'.runtime/usd-acceptance'))
await mkdir(out,{recursive:true})
const manifest=JSON.parse(await readFile(join(root,'script/test-ci.manifest.json'),'utf8'))
const entry=manifest.entries.find((row:{path:string})=>row.path==='packages/scene-kit/test/usd-native.test.ts')
if(!entry)throw Error('USD_NATIVE_TEST_NOT_REGISTERED')
entry.decision='include';entry.reason='本轮显式原生USD验收；需要usd-core；不改变默认离线清单'
const path=join(out,'native-manifest.json');await writeFile(path,JSON.stringify(manifest,null,2)+'\n')
const command=[process.execPath,'run','script/test-ci.ts','--manifest',path,'--filter','packages/scene-kit/test/usd-native','--json',join(out,'report.json')]
console.log(JSON.stringify({root,command,environment:{LYAPUNOV_USD_PYTHON:process.env.LYAPUNOV_USD_PYTHON??'产品根.runtime/usd-python/bin/python'}},null,2))
const child=Bun.spawn(command,{cwd:root,stdout:'inherit',stderr:'inherit',env:process.env})
const code=await child.exited
await writeFile(join(out,'exit.json'),JSON.stringify({command,exitCode:code,at:new Date().toISOString()},null,2))
process.exitCode=code
