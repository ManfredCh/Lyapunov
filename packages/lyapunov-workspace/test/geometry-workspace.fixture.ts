/** 外部夹具：真实登记命令/Tool、Workspace HTTP、Blender、副本闭包与场景保存恢复；不安装依赖。 */
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import Sessions,{SessionId} from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {createServer} from 'node:http'
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {deflateSync} from 'node:zlib'
import * as scenePlugin from '../../scene-kit/src/plugin.ts'
import * as workspacePlugin from '../src/plugin.ts'
import {blenderExecutable} from '../../scene-kit/src/blend-deps.ts'
import type {ResourceRecord} from '../../scene-kit/src/resources.ts'
import type {SceneService} from '../../scene-kit/src/plugin.ts'
const output=resolve(process.argv[2]??'.runtime/geometry-workspace-fixture'),fixtures=process.argv[3]
assert(fixtures,'须提供已有合法 OBJ/FBX/纹理夹具目录')
const original=join(output,'original');await mkdir(original,{recursive:true})
for(const name of ['rig-textured.fbx','checker.png'])await writeFile(join(original,name),await readFile(join(fixtures,name)))
await writeFile(join(original,'textured.obj'),'mtllib material.mtl\no Checker\nv 0 0 0\nv .1 0 0\nv .1 .1 0\nv 0 .1 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nusemtl Checker\nf 1/1 2/2 3/3 4/4\n')
await writeFile(join(original,'material.mtl'),'newmtl Checker\nKd 1 1 1\nmap_Kd checker.png\n')
const routes=new Map<string,(request:Request)=>Promise<Response>>(),ctx=new Context()
ctx.provide('connection',{fetch:{register:(entry:{path:string;fetch:(request:Request)=>Promise<Response>})=>{routes.set(entry.path,entry.fetch);return()=>routes.delete(entry.path)}}} as never)
const namespaces=new Set<string>()
ctx.provide('settings',{register:(ns:string)=>{namespaces.add(ns);return()=>namespaces.delete(ns)},describe:()=>[...namespaces].map(ns=>({ns,user:{},revision:1,value:{}})),replace:async()=>undefined} as never)
ctx.provide('terminals',{list:()=>[]} as never)
ctx.provide('workspaceRegistry',{} as never)
let readOnly=false
ctx.provide('sandboxPolicy',{resolve:()=>({mode:readOnly?'read-only':'workspace-write',workspaceRoot:output,writableRoots:[output]})} as never)
await ctx.plugin(SystemPrompt);await ctx.plugin(Tools);await ctx.plugin(Sessions);await ctx.plugin(Commands)
await ctx.plugin(FsLocal,{cwd:output});await ctx.plugin(SubprocessLocal)
const session=ctx.sessions.create(SessionId('geometry-workspace'),{meta:{cwd:original}})
const agent={id:session.id,session} as Agent
const outsider=ctx.sessions.create(SessionId('geometry-workspace-outside'),{meta:{cwd:output}})
const other={id:outsider.id,session:outsider} as Agent
const agents=new Map([[String(agent.id),agent],[String(other.id),other]])
ctx.provide('agents',{get:(id:unknown)=>agents.get(String(id))} as never)
ctx.provide('sessionController',{resolveAgent:async(id:unknown)=>{const agent=agents.get(String(id));return agent?{agent}:{error:new Error('SESSION_NOT_FOUND')}}} as never)
await ctx.plugin(scenePlugin,{dataRoot:join(output,'data')})
await ctx.plugin(workspacePlugin,{dataDirectory:join(output,'workspace-data'),cacheRoot:join(output,'cache'),blenderExecutable:blenderExecutable()})
const server=createServer(async(req,res)=>{try{const route=routes.get(new URL(req.url??'/', 'http://localhost').pathname);if(!route){res.writeHead(404);res.end();return}const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const response=await route(new Request(`http://localhost${req.url}`,{method:req.method,headers:{'content-type':'application/json'},...req.method==='POST'?{body:Buffer.concat(chunks)}:{}}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()))}catch(error){res.writeHead(500);res.end(String(error))}})
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const addr=server.address();assert(addr&&typeof addr==='object');const origin=`http://127.0.0.1:${addr.port}`
const signal=new AbortController().signal
let calls=0
const command=async(name:string,input:unknown,owner=agent)=>{const result=await ctx.commands.execute(owner,`/${name} ${JSON.stringify(input)}`,[],signal);assert(result);assert.equal(result.result.kind,'success',result.result.text);return JSON.parse(result.result.text!)}
const tool=async(name:string,input:unknown)=>{const result=await ctx.tools.execute({callId:ToolCallId('geometry-'+(++calls)),name,arguments:{input},agent,signal});if(result.isError)throw new Error(result.error.message);return result.value as any}
const request=async(input:unknown,sessionId=String(agent.id))=>{const response=await fetch(origin+'/api/lyapunov/workspace',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId,action:'convert-source',input})});return{status:response.status,result:await response.json() as any}}
try{
 const importedObj=await tool('scene_import',{path:'textured.obj',physicalize:false,components:{rigidBody:{type:'static'}}})
 const importedFbx=await command('scene_import',{path:'rig-textured.fbx',physicalize:false})
 const records=[importedObj.resource,importedFbx.resource] as ResourceRecord[]
 const sourceHashes=records.map(record=>({resourceId:record.ref.resourceId,sha256:record.parsed.dependencies.map(d=>d.sha256)}))
 // 只移走本夹具副本，登记副本与源件不是同路径；请求不依赖客户端绝对路径。
 await rename(original,join(output,'original-saved'));await mkdir(original)
 const scene=await command('scene_create',{sceneId:'workspace-geometry-scene'})
 const outputs=[]
 for(const source of records){
  const input={resourceId:source.ref.resourceId,version:source.ref.version,path:'/不允许的客户端路径.fbx'}
  const cold=await request(input);assert.equal(cold.status,200);assert.equal(cold.result.kind,'converted-glb',cold.result.reason)
  const operations=(ctx.get('scene') as SceneService).forSession(String(agent.id))
  const glb=await operations.resources.get(cold.result.glb.resourceId,cold.result.glb.version)
  assert.equal(source.physicalizationRequest,false,'正式源登记必须保留用户physicalize:false')
  assert.equal(glb.physicalizationRequest,false,'转换不能把用户纯视觉请求改成自动碰撞')
  const bytes=await readFile(new URL(glb.ref.original.uri)),json=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString())
  assert((json.textures??[]).length>0);assert(json.meshes.some((mesh:any)=>mesh.primitives.some((p:any)=>p.attributes.TEXCOORD_0!==undefined)))
  if(source.parsed.metadata.format==='fbx'){assert((json.skins??[]).length>0);assert((json.animations??[]).length>0);assert.equal(glb.parsed.metadata.animatedAssembly,true)}
  const mounted=await command('scene_mount',{sceneId:scene.sceneId,resourceId:glb.ref.resourceId,version:glb.ref.version})
  if(source.parsed.metadata.format==='fbx')assert.equal(mounted.snapshot.entities.filter((e:any)=>e.entityId===mounted.entityId||e.entityId.startsWith(mounted.entityId+':')).length,1,'skin/动画应保完整装配实例')
  const spawn=ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn=()=>{throw new Error('缓存命中不可重启 Blender')}
  let warm
  try{warm=await request(input)}finally{ctx.subprocess.spawn=spawn}
  assert.equal(warm.status,200);assert.equal(warm.result.cached,true,warm.result.reason);assert.equal(warm.result.glb.resourceId,glb.ref.resourceId)
  const sourceAfter=await operations.resources.get(source.ref.resourceId,source.ref.version)
  assert.deepEqual(sourceAfter.parsed.dependencies.map(d=>d.sha256),source.parsed.dependencies.map(d=>d.sha256))
  outputs.push({sourceKind:source.parsed.metadata.format,source:source.ref.resourceId,derived:glb.ref.resourceId,sha256:createHash('sha256').update(bytes).digest('hex'),textures:json.textures.length,skins:json.skins?.length??0,animations:json.animations?.length??0,warm:true,sourceUnchanged:true})
 }
 // 同一个资源版本显式改用途由资源 owner 记账；几何转换复用同缓存，转换不能把环境又改成dynamic。
 const environmentIntent={usage:'environment',strategy:'voxel_boxes',voxelSizeM:0.025,maxBoxes:100,maxOccupiedVoxels:10000,maxTiles:4096,maxSamples:128000000,maxFaceVisits:100000000,maxWorkingBytes:268435456,maxWorkingBoxes:40000} as const
 const operations=(ctx.get('scene') as SceneService).forSession(String(agent.id))
 const mountedBeforeRequest=await operations.scene.snapshot(scene.sceneId)
 const environmental=await tool('scene_import',{path:join(output,'original-saved/textured.obj'),resourceId:records[0]!.ref.resourceId,physicalizationRequest:environmentIntent})
 assert.equal(environmental.resource.ref.version,records[0]!.ref.version,'几何/依赖均相同的显式用途更新必须复用原版本')
 assert.deepEqual(environmental.resource.physicalizationRequest,environmentIntent)
 const environmentalConverted=await request({resourceId:environmental.resource.ref.resourceId,version:environmental.resource.ref.version})
 assert.equal(environmentalConverted.result.kind,'converted-glb',environmentalConverted.result.reason)
 const environmentalGlb=await operations.resources.get(environmentalConverted.result.glb.resourceId,environmentalConverted.result.glb.version)
 assert.deepEqual(environmentalGlb.physicalizationRequest,environmentIntent)
 const deadline=Date.now()+15000
 let completed=environmentalGlb
 while(Date.now()<deadline){completed=await operations.resources.get(environmentalGlb.ref.resourceId,environmentalGlb.ref.version);if(completed.physicalization?.status==='ok'||completed.physicalization?.status==='failed')break;await new Promise(done=>setTimeout(done,50))}
 assert.equal(completed.physicalization?.status,'ok',completed.physicalization?.error)
 assert.equal(completed.physicalization?.usage,environmentIntent.usage)
 assert.equal(completed.physicalization?.strategy,environmentIntent.strategy)
 assert.equal(completed.physicalization?.voxelSizeM,environmentIntent.voxelSizeM)
 assert.deepEqual(await operations.scene.snapshot(scene.sceneId),mountedBeforeRequest,'资源显式改派不能悄悄修改旧挂载实例、碰撞与Scene revision')
 // 真实纹理副本换字节而OBJ不变：全依赖闭包应进入新version，旧CAS字节仍保持原hash。
 const chunk=(type:string,data:Buffer)=>{const kind=Buffer.from(type),content=Buffer.concat([kind,data]);let crc=0xffffffff;for(const byte of content){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}const size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);checksum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([size,content,checksum])}
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6
 const newPng=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0,255]))),chunk('IEND',Buffer.alloc(0))])
 await writeFile(join(output,'original-saved/checker.png'),newPng)
 const oldSource=await operations.resources.get(records[0]!.ref.resourceId,records[0]!.ref.version)
 for(const dependency of oldSource.parsed.dependencies)assert.equal(createHash('sha256').update(await readFile(dependency.path)).digest('hex'),dependency.sha256)
 console.log(JSON.stringify({immutableOldClosureVerifiedAfterInPlaceWrite:true}))
 const textureChanged=await tool('scene_import',{path:join(output,'original-saved/textured.obj'),resourceId:records[0]!.ref.resourceId,physicalize:false})
 assert.equal(textureChanged.resource.ref.version,records[0]!.ref.version+1,'只改MTL/PNG也必须产生新完整闭包版本')
 assert.equal(textureChanged.resource.parsed.dependencies[0].sha256,records[0]!.parsed.dependencies[0]!.sha256)
 assert.notEqual(textureChanged.resource.parsed.dependencies.at(-1).sha256,records[0]!.parsed.dependencies.at(-1)!.sha256)
 for(const dependency of oldSource.parsed.dependencies)assert.equal(createHash('sha256').update(await readFile(dependency.path)).digest('hex'),dependency.sha256)
 const denied=await request({resourceId:records[0]!.ref.resourceId,version:records[0]!.ref.version},String(other.id));assert.equal(denied.result.kind,'unsupported');assert.match(denied.result.reason,/本会话资源库/)
 readOnly=true;const readonlyResult=await request({resourceId:records[0]!.ref.resourceId,version:records[0]!.ref.version});assert.equal(readonlyResult.status,400);assert.match(readonlyResult.result.error,/SCENE_POLICY_READ_ONLY/);readOnly=false
 const saved=await command('scene_save',{sceneId:scene.sceneId,path:join(output,'scene.json')});const reopened=await tool('scene_open',{path:saved.path})
 assert.equal(reopened.entities.filter((e:any)=>e.components.visual?.animatedAssembly).length,1)
 await writeFile(join(output,'summary.json'),JSON.stringify({status:'passed',realRegisteredToolsAndCommands:true,realWorkspaceHTTP:true,realBlender:true,originalMovedOnlyInIsolatedFixture:true,sourceHashes,outputs,physicalizeFalsePreserved:true,environmentIntentPreserved:true,completeDependencyVersionPreserved:true,sessionIsolation:true,readOnlyRejected:true,saveAndReopen:true},null,2))
 console.log(JSON.stringify({status:'passed',outputs,physicalizeFalsePreserved:true,environmentIntentPreserved:true,completeDependencyVersionPreserved:true,sessionIsolation:true,readOnlyRejected:true,saveAndReopen:true}))
}finally{await new Promise<void>(done=>server.close(()=>done()));await ctx.fiber.dispose()}
