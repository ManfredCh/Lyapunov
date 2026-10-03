import {mkdir,readFile,rename,writeFile} from "node:fs/promises"
import {join} from "node:path"
import {hashFile,policyDirectory,type PolicyManifest} from "./source.ts"
import {G1_23_75_BYTES,G1_23_75_MODEL,G1_23_75_REVISION,G1_23_75_SHA256} from "./g1-23-75.ts"

/** 显式复用用户已下载的确定来源权重；源只读，落到既有policy缓存布局后按同一manifest验证。 */
export async function adoptLocalG1Policy(directory:string,weightsPath:string):Promise<void>{
 const actual=await hashFile(weightsPath)
 if(actual.bytes!==G1_23_75_BYTES||actual.sha256!==G1_23_75_SHA256)throw new Error("POLICY_ADAPTER_SOURCE_MISMATCH: 本地75/23权重字节与固定来源不符")
 const root=policyDirectory(directory,"github",G1_23_75_MODEL,G1_23_75_REVISION),path="deployment/policy.pt"
 const target=join(root,path)
 let previous:PolicyManifest|undefined
 try{previous=JSON.parse(await readFile(join(root,"manifest.json"),"utf8"))}catch{}
 if(previous){
  if(previous.provider!=="github"||previous.modelId!==G1_23_75_MODEL||previous.revision!==G1_23_75_REVISION||previous.resolvedRevision!==G1_23_75_REVISION)throw new Error("POLICY_LOCAL_REUSE_IDENTITY_CONFLICT")
  try{const cached=await hashFile(target);if(previous.status==="DOWNLOADED"&&cached.bytes===actual.bytes&&cached.sha256===actual.sha256&&previous.files.some(file=>file.path===path&&file.sha256===actual.sha256&&file.bytes===actual.bytes&&!file.gitBlob)&&previous.sourceFiles.some(file=>file.path===path&&file.url===`https://media.githubusercontent.com/media/${G1_23_75_MODEL}/${G1_23_75_REVISION}/${path}`))return}catch{}
 }
 await mkdir(join(root,"deployment"),{recursive:true})
 const temporary=target+".adopt-"+crypto.randomUUID()
 await writeFile(temporary,await readFile(weightsPath));await rename(temporary,target)
 const source={path,bytes:actual.bytes,sha256:actual.sha256,gitBlob:undefined,revision:G1_23_75_REVISION,url:`https://media.githubusercontent.com/media/${G1_23_75_MODEL}/${G1_23_75_REVISION}/${path}`,gitLfsPointerUrl:`https://raw.githubusercontent.com/${G1_23_75_MODEL}/${G1_23_75_REVISION}/${path}`}
 const mergeFiles=(prior:PolicyManifest["sourceFiles"]|undefined)=>[...(prior??[]).filter(file=>file.path!==path),{...(prior??[]).find(file=>file.path===path),...source}]
 const manifest:PolicyManifest={...previous,status:"DOWNLOADED",provider:"github",modelId:G1_23_75_MODEL,revision:G1_23_75_REVISION,resolvedRevision:G1_23_75_REVISION,metadata:{robot:"unitree-g1-23dof",simulator:"mujoco",...previous?.metadata,localReuse:true},sourceFiles:mergeFiles(previous?.sourceFiles),files:mergeFiles(previous?.files) as PolicyManifest["files"],transfers:[...(previous?.transfers??[]),{kind:"local-reuse",verified:true,bytes:actual.bytes}],execution:previous?.execution??{status:"BLOCKED",reason:"需policy_prepare与真实world匹配"},updatedAt:new Date().toISOString()}
 await writeFile(join(root,"manifest.json"),JSON.stringify(manifest,null,2)+"\n")
}
