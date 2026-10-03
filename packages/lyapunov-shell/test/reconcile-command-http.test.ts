/** 真Scene/Resource、原生Session/Scope/CommandRegistry和产品registered HTTP路由；辅助无关服务最薄装配，无Host/GPU。 */
import {expect,test} from 'bun:test'
import {Context} from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import Sessions,{SessionId} from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import {createScope} from '@deepseek-ai/dsh-scope'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {createServer} from 'node:http'
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import * as scenePlugin from '../../scene-kit/src/plugin.ts'
import {SceneOperations} from '../../scene-kit/src/operations.ts'
import {identityTransform} from '../../lyapunov-contracts/src/types.ts'
import {solidGlb,box} from '../../scene-kit/test/glb-geometry-fixture.ts'
import {isolateProviderInstaller} from './fixtures/isolated-provider-installer.ts'

test('registered HTTP command回机器Scene/CAS结果；原生Scope隔离和未知命令无ui泄漏',async()=>{
 const root=await mkdtemp(join(tmpdir(),'a08-reconcile-http-')),ctx=new Context(),routes=new Map<string,(req:Request)=>Promise<Response>>()
 const namespaces=new Set<string>(),agents=new Map<string,Agent>()
 ctx.provide('connection',{fetch:{register:(entry:{path:string;fetch:(req:Request)=>Promise<Response>})=>{routes.set(entry.path,entry.fetch);return()=>routes.delete(entry.path)}}} as never)
 ctx.provide('settings',{register:(key:string)=>{namespaces.add(key);return()=>namespaces.delete(key)},describe:()=>[...namespaces].map(ns=>({ns,value:{},revision:1})),mutate:async()=>undefined,replace:async()=>undefined} as never)
 ctx.provide('agents',{get:(id:unknown)=>agents.get(String(id))} as never)
 ctx.provide('sessionController',{resolveAgent:async(id:unknown)=>agents.has(String(id))?{agent:agents.get(String(id))}:{error:Error('SESSION_NOT_FOUND')}} as never)
 ctx.provide('sessionQuery',{observeSession:async()=>undefined} as never)
 ctx.provide('attachments',{saveImage:async()=>({}),readImage:async()=>({data:new Uint8Array()})} as never)
 ctx.provide('subprocess',{} as never)
 await ctx.plugin(SystemPrompt);await ctx.plugin(Tools);await ctx.plugin(Sessions);await ctx.plugin(Commands);await ctx.plugin(JobsLocal)
 for(const id of ['owned','other']){const workspace=join(root,id);await mkdir(workspace);const session=ctx.sessions.create(SessionId(id),{meta:{cwd:workspace}});agents.set(id,{id:session.id,session,ctx:createScope(ctx,{session:id}).ctx,send:()=>{},steer:()=>{},inject:()=>{}} as unknown as Agent)}
 await ctx.plugin(scenePlugin,{dataRoot:join(root,'data')})
 const operations=(ctx.get('scene') as scenePlugin.SceneService).forSession('owned')
 const initial=await operations.create({sceneId:'s'})
 const secret='PRIVATE_MARKER_'+Math.random().toString(36).slice(2)
 await operations.scene.commit({sceneId:'s',expectedRevision:initial.revision,patch:[{op:'add',entity:{entityId:'e',name:'私有元数据测试',transform:identityTransform(),resources:[],components:{visual:{kind:'mesh'},annotation:{note:'合法用户注释',API_KEY:secret}}}}]})
 const installer=isolateProviderInstaller(root)
 const {apply}=await import('../src/plugin.ts')
 try{await apply(ctx,{dataRoot:join(root,'data'),captureRoot:join(root,'capture'),recordingRoot:join(root,'recording')});installer.assertCalled()}finally{installer.restore()}
 const actualRoute=routes.get('/api/lyapunov/command');expect(actualRoute).toBeDefined()
 const server=createServer(async(req,res)=>{try{const path=new URL(req.url??'/', 'http://localhost').pathname,handler=routes.get(path);if(!handler){res.writeHead(404);res.end();return}const buffers:Buffer[]=[];for await(const part of req)buffers.push(Buffer.from(part));const reply=await handler(new Request('http://localhost'+req.url,{method:req.method,headers:{'content-type':'application/json'},body:Buffer.concat(buffers)}));res.writeHead(reply.status,Object.fromEntries(reply.headers));res.end(Buffer.from(await reply.arrayBuffer()))}catch(error){res.writeHead(500);res.end(String(error))}})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('LOCAL_SERVER_BIND_FAILED')
 const command=async(sessionId:string,name:string,input:unknown)=>{const response=await fetch(`http://127.0.0.1:${address.port}/api/lyapunov/command`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId,name,input})});return {status:response.status,body:await response.json() as any}}
 try{
  const ok=await command('owned','scene_reconcile_physics',{sceneId:'s',expectedRevision:1})
  expect(ok.status).toBe(200);expect(ok.body.kind).toBe('success');expect(ok.body.ui).toMatchObject({changed:false,pending:false,worldNeedsSync:false,issues:[]})
  expect(ok.body.ui.snapshot).toMatchObject({sceneId:'s',revision:1});expect(ok.body.ui.snapshot.entities[0].entityId).toBe('e')
  expect(JSON.stringify(ok.body)).not.toContain(secret);expect(ok.body.ui.snapshot.entities[0].components.annotation.note).toBe('合法用户注释')
  const foreign=await command('other','scene_reconcile_physics',{sceneId:'s'});expect(foreign.body.ui??null).toBeNull();expect(foreign.body.kind??'error').not.toBe('success')
  const unknown=await command('owned','scene_reconcile_unknown',{sceneId:'s'});expect(unknown.body.ui??null).toBeNull();expect(unknown.body.kind??'error').not.toBe('success')
  const missing=await command('missing','scene_reconcile_physics',{sceneId:'s'});expect(missing.status).not.toBe(200)
  // 真实registered GET投影按原生Session绑定，只公开阶段/计数；未知/secret/路径字段不泄漏。
  const asset=join(root,'owned','progress.glb');await writeFile(asset,solidGlb({generator:'http-progress',nodes:[{name:'box',mesh:box()}]}))
  await operations.resources.import({path:asset,resourceId:'progress',physicalizationRequest:false})
  await operations.resources.attachPhysicalization('progress',1,{status:'pending',usage:'environment',strategy:'voxel_boxes',maxBoxes:100})
  await operations.resources.notePhysicalizationProgress('progress',1,{usage:'environment',strategy:'voxel_boxes',maxBoxes:100},{mode:'voxel',node:'box',at:'2026-10-01T00:00:00Z',facts:{stage:'prepare',boxesBeforeMerge:25,manifestPath:'/private/manifest.json',API_KEY:secret,unknownInternalSecret:secret}})
  const projection=routes.get('/api/lyapunov/resource-physics')!;expect(projection).toBeDefined()
  const projected=await projection(new Request('http://localhost/api/lyapunov/resource-physics?sessionId=owned&resourceId=progress&version=1'))
  const body=await projected.json() as any;expect(projected.status).toBe(200);expect(body.physicalization).toMatchObject({status:'pending',maxBoxes:100,progress:{facts:{stage:'prepare',boxesBeforeMerge:25}}})
  expect(JSON.stringify(body)).not.toContain(secret);expect(JSON.stringify(body)).not.toContain('/private/');expect(body.physicalization.progress.facts.manifestPath).toBeUndefined()
  expect((await projection(new Request('http://localhost/api/lyapunov/resource-physics?sessionId=other&resourceId=progress&version=1'))).status).toBe(400)
  expect((await projection(new Request('http://localhost/api/lyapunov/resource-physics?sessionId=missing&resourceId=progress&version=1'))).status).toBe(400)
  expect((await projection(new Request('http://localhost/api/lyapunov/resource-physics?sessionId=owned&resourceId=progress'))).status).toBe(400)
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})}
},15000)
