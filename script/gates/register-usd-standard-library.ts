/** 从已安装SDK登记独立标准模块资源；不联网、不写SDK，不创建Scene实体。 */
import {mkdir,writeFile} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {SceneOperations} from '../../packages/scene-kit/src/operations.ts'
import {readUsdStandardLibrary,registerNvidiaUsdStandardLibrary} from '../../packages/scene-kit/src/usd-standard-libraries.ts'

const args=process.argv.slice(2)
function required(flag:string){const index=args.indexOf(flag),value=args[index+1];if(index<0||!value||value.startsWith('--'))throw Error('用法：bun run script/gates/register-usd-standard-library.ts --core-root <SDK的kit/mdl/core> --resource-root <现有SceneOperations数据根> --out <回执JSON>');return resolve(value)}
const coreRoot=required('--core-root'),resourceRoot=required('--resource-root'),out=required('--out')
const operations=new SceneOperations(resourceRoot),record=await registerNvidiaUsdStandardLibrary(operations.resources,coreRoot),library=await readUsdStandardLibrary(fileURLToPath(record.ref.original.uri)),verification=await operations.resources.verify(record.ref.resourceId,record.ref.version)
if(!verification.valid)throw Error('USD_STANDARD_LIBRARY_VERSION_UNAVAILABLE')
await mkdir(dirname(out),{recursive:true})
const receipt={status:'REGISTERED',resourceRoot,resource:record.ref,license:record.license,manifest:library.manifest,manifestSha256:library.sha256,verification,networkRequests:0,sceneEntitiesCreated:0}
await writeFile(out,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({status:receipt.status,resourceId:record.ref.resourceId,version:record.ref.version,manifestSha256:library.sha256,out},null,2))
