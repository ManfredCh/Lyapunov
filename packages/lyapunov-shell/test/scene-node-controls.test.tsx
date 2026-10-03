import {afterEach,beforeEach,describe,expect,test} from "bun:test"
import {mkdtemp,mkdir,readFile,rm,writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {Context} from "@deepseek-ai/cordis"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import Tools from "@deepseek-ai/dsh-tools"
import Sessions,{SessionId} from "@deepseek-ai/dsh-session"
import Commands from "@deepseek-ai/dsh-commands"
import type {Agent} from "@deepseek-ai/dsh-agent"
import * as scenePlugin from "../../scene-kit/src/plugin.ts"
import {SCENE_COORDINATES,identityTransform,type Entity,type SceneSnapshot} from "../../lyapunov-contracts/src/types.ts"
import {uiCommandFields} from "../../lyapunov-contracts/src/command-privacy.ts"
import {assetSceneInstances,entityEffectivelyVisible,removeSceneNodeCommit,sceneSubtreeIds,visibilityCommit} from "../src/scene-node-controls.tsx"
import {sceneEditTarget,sceneNodeRole} from '../../lyapunov-contracts/src/scene-edit-target.ts'
import {modelSceneView} from '../../scene-kit/src/model-view.ts'

test('共用资源的不同物体保持独立编辑；物理叶/机器人/动画装配按真实父子归到各自owner',()=>{
 const ref={resourceId:'shared',version:1,original:{uri:'/fixture/box.glb',mimeType:'model/gltf-binary'},representations:[],source:{units:'m',upAxis:'Y' as const,handedness:'right' as const}}
 const floor:Entity={entityId:'floor',name:'同名',transform:identityTransform(),resources:[ref],components:{collision:{shape:'box'},visual:{kind:'group'}}},table:Entity={...structuredClone(floor),entityId:'table'}
 const leaf:Entity={entityId:'table-leaf',parentId:'table',name:'mesh',transform:identityTransform(),resources:[ref],components:{visual:{kind:'mesh'}}}
 const robot:Entity={...structuredClone(floor),entityId:'arm',components:{mujoco:{sourcePath:'/fixture/arm.xml'}}},link:Entity={...leaf,entityId:'link',parentId:'arm'},animated:Entity={...leaf,entityId:'animation',parentId:undefined,components:{visual:{kind:'mesh',animatedAssembly:true}}}
 const snapshot:SceneSnapshot={sceneId:'s',revision:30,coordinates:SCENE_COORDINATES,entities:[floor,table,leaf,robot,link,animated]}
 expect(sceneEditTarget(snapshot,'floor')?.entityId).toBe('floor');expect(sceneEditTarget(snapshot,'table-leaf')?.entityId).toBe('table');expect(sceneEditTarget(snapshot,'link')?.entityId).toBe('arm');expect(sceneEditTarget(snapshot,'animation')?.entityId).toBe('animation')
 expect(snapshot.entities.map(e=>e.parentId)).toEqual([undefined,undefined,'table',undefined,'arm',undefined]);expect(sceneNodeRole(table)).toBe('physics');expect(sceneNodeRole(link)).toBe('child')
})

let root:string,ctx:Context
let a:Agent,b:Agent
const abort=new AbortController().signal
const node=(id:string,parentId?:string):Entity=>({entityId:id,name:"重复名称",...(parentId?{parentId}:{}),transform:identityTransform(),resources:[],components:{visual:{kind:"group"},collision:{shape:"box"},controller:{keep:true}}})
function glb():Buffer{
 const bytes=Buffer.from(JSON.stringify({asset:{version:"2.0"},scene:0,scenes:[{nodes:[0]}],nodes:[{name:"导入环境"}],meshes:[]}))
 const json=Buffer.concat([bytes,Buffer.alloc((4-bytes.length%4)%4,0x20)]),header=Buffer.alloc(20)
 header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(20+json.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16)
 return Buffer.concat([header,json])
}
async function command<T>(agent:Agent,name:string,input:unknown):Promise<T>{
 const call=await ctx.commands.execute(agent,`/${name} ${JSON.stringify(input)}`,[],abort)
 if(!call)throw new Error("COMMAND_NOT_RESOLVED")
 const result=call.result as {kind:string;text?:string}
 if(result.kind!=="success")throw new Error(result.text??"COMMAND_FAILED")
 return JSON.parse(result.text??"null") as T
}
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),"scene-node-controls-"));ctx=new Context()
 await ctx.plugin(SystemPrompt);await ctx.plugin(Tools);await ctx.plugin(Sessions);await ctx.plugin(Commands);await ctx.plugin(scenePlugin,{dataRoot:join(root,"data"),defaultStorage:"cas"})
 const create=(id:string)=>{const session=ctx.sessions.create(SessionId(id),{meta:{cwd:root}});return {id:session.id,session} as Agent}
 a=create("scene-control-a");b=create("scene-control-b")
})
afterEach(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
async function fixture(agent:Agent){
 await command(agent,"scene_create",{sceneId:"same-scene",template:"blank"})
 const file=join(root,"source.glb");await writeFile(file,glb())
 const imported=await command<{resource:{ref:{resourceId:string;version:number}}}>(agent,"scene_import",{path:file,resourceId:"same-resource",physicalize:false})
 const mounted=await command<{snapshot:SceneSnapshot;entityId:string}>(agent,"scene_mount",{sceneId:"same-scene",resourceId:imported.resource.ref.resourceId,entityId:"environment"})
 const rootNode=mounted.snapshot.entities.find(entity=>entity.entityId==="environment")!
 const first={...node("part-1","environment"),resources:structuredClone(rootNode.resources)},second={...node("part-2","part-1"),resources:structuredClone(rootNode.resources)}
 return await command<SceneSnapshot>(agent,"scene_edit",{sceneId:"same-scene",expectedRevision:mounted.snapshot.revision,patch:[{op:"add",entity:first},{op:"add",entity:second},{op:"add",entity:node("unrelated")} ]})
}

describe("场景节点删除/显隐的真实原生命令与持久读回",()=>{
 test('011：用户命令默认创建无限地面；模型投影可读到锁定与删除选择',async()=>{
  const scene=await command<SceneSnapshot>(a,'scene_create',{sceneId:'default-ground'}),ground=scene.entities[0]!
  expect(ground).toMatchObject({locked:true,components:{collision:{shape:'plane',infinite:true}}})
  const projection=modelSceneView(scene)as {entities:Array<{locked?:boolean}>}
  expect(projection.entities[0]!.locked).toBe(true)
  const removed=await command<SceneSnapshot>(a,'scene_edit',removeSceneNodeCommit(scene,ground.entityId))
  expect(removed.physics?.groundState).toBe('removed')
  expect(await command<SceneSnapshot>(a,'scene_prepare_world',{sceneId:scene.sceneId,expectedRevision:removed.revision})).toEqual(removed)
 })
 test("修前不带cascade删除导入根被拒；正确子树删除保留重复名兄弟、素材、源文件及另一会话",async()=>{
  const before=await fixture(a),other=await fixture(b),ops=ctx.scene.forSession(a.id)
  await expect(command(a,"scene_edit",{sceneId:before.sceneId,expectedRevision:before.revision,patch:[{op:"remove",entityId:"environment"}]})).rejects.toThrow("PARENT_NOT_FOUND")
  expect((await ops.scene.snapshot(before.sceneId)).revision).toBe(before.revision)
  const next=await command<SceneSnapshot>(a,"scene_edit",removeSceneNodeCommit(before,"environment"))
  expect(next.entities.map(entity=>entity.entityId)).toEqual(["unrelated"])
  expect(next.revision).toBe(before.revision+1)
  expect((await ops.resources.list({})).length).toBe(1)
  expect((await readFile(join(root,"source.glb"))).equals(glb())).toBe(true)
  expect(await ctx.scene.forSession(b.id).scene.snapshot(other.sceneId)).toEqual(other)
 })

 test("删除选中子节点只移除其子树，当前revision来自文档，CAS冲突不写成功",async()=>{
  const before=await fixture(a),ops=ctx.scene.forSession(a.id)
  const stale=removeSceneNodeCommit(before,"part-1")
  const current=await command<SceneSnapshot>(a,"scene_edit",visibilityCommit(before,"environment",false))
  await expect(command(a,"scene_edit",stale)).rejects.toThrow(`请求基于 ${before.revision}`)
  expect(await ops.scene.snapshot(before.sceneId)).toEqual(current)
  const next=await command<SceneSnapshot>(a,"scene_edit",removeSceneNodeCommit(current,"part-1"))
  expect(next.entities.map(entity=>entity.entityId)).toEqual(current.entities.filter(entity=>!["part-1","part-2"].includes(entity.entityId)).map(entity=>entity.entityId))
 })

 test("隐藏/重新显示只改visual.visible，保存、重开、历史恢复保持状态与资源版本",async()=>{
  const before=await fixture(a),other=await fixture(b),entity=before.entities.find(value=>value.entityId==="environment")!
  const hidden=await command<SceneSnapshot>(a,"scene_edit",visibilityCommit(before,"environment",false))
  const changed=hidden.entities.find(value=>value.entityId==="environment")!
  expect(changed.components.visual?.visible).toBe(false)
  expect(changed.resources).toEqual(entity.resources);expect(changed.transform).toEqual(entity.transform)
  expect(changed.components.collision).toEqual(entity.components.collision)
  expect(entityEffectivelyVisible(hidden,hidden.entities.find(value=>value.entityId==="part-2")!)).toBe(false)
  const projected=uiCommandFields("scene_edit",hidden)?.entities as Entity[]
  expect(projected.find(value=>value.entityId==="environment")?.components).toEqual(changed.components)
  expect(projected.find(value=>value.entityId==="environment")?.resources.map(ref=>[ref.resourceId,ref.version])).toEqual(changed.resources.map(ref=>[ref.resourceId,ref.version]))
  const path=join(root,"saved/scene.json");await mkdir(join(root,"saved"),{recursive:true})
  await command(a,"scene_save",{sceneId:hidden.sceneId,path})
  const stored=JSON.parse(await readFile(path,"utf8")) as SceneSnapshot
  expect(stored.entities.find(value=>value.entityId==="environment")?.components.visual?.visible).toBe(false)
  await command(a,"scene_open",{path,sceneId:"reopened"})
  expect((await ctx.scene.forSession(a.id).scene.snapshot("reopened")).entities.find(value=>value.entityId==="environment")?.components.visual?.visible).toBe(false)
  const shown=await command<SceneSnapshot>(a,"scene_edit",visibilityCommit(hidden,"environment",true))
  expect(entityEffectivelyVisible(shown,shown.entities.find(value=>value.entityId==="part-2")!)).toBe(true)
  await ctx.scene.forSession(a.id).scene.restore({sceneId:shown.sceneId,revision:hidden.revision,expectedRevision:shown.revision})
  expect((await ctx.scene.forSession(a.id).scene.snapshot(shown.sceneId)).entities.find(value=>value.entityId==="environment")?.components.visual?.visible).toBe(false)
  expect(await ctx.scene.forSession(b.id).scene.snapshot(other.sceneId)).toEqual(other)
 })

 test("资产回收/恢复实际生效且有CAS；同资源另一会话与已放置实例不串，不删除原件",async()=>{
  const before=await fixture(a),other=await fixture(b),ops=ctx.scene.forSession(a.id)
  const authority=await command<{registryRevision:string;records:unknown[]}>(a,"asset_authority_snapshot",{})
  expect(uiCommandFields("asset_authority_snapshot",authority)).toEqual({registryRevision:authority.registryRevision})
  const result=await command<{deletedAt?:string}>(a,"asset_edit",{resourceId:"same-resource",deleted:true,expectedRegistryRevision:authority.registryRevision})
  expect(result.deletedAt).toBeString();expect(await ops.resources.list({})).toEqual([])
  expect((await ops.resources.list({includeDeleted:true})).length).toBe(1)
  expect(await ops.scene.snapshot(before.sceneId)).toEqual(before)
  expect((await ctx.scene.forSession(b.id).resources.list({})).length).toBe(1)
  expect(await ctx.scene.forSession(b.id).scene.snapshot(other.sceneId)).toEqual(other)
  await expect(command(a,"asset_edit",{resourceId:"same-resource",deleted:false,expectedRegistryRevision:authority.registryRevision})).rejects.toThrow("RESOURCE_REGISTRY_CAS_MISMATCH")
  const latest=await command<{registryRevision:string}>(a,"asset_authority_snapshot",{})
  await command(a,"asset_edit",{resourceId:"same-resource",deleted:false,expectedRegistryRevision:latest.registryRevision})
  expect((await ops.resources.list({}))[0]!.deletedAt).toBeUndefined()
  expect((await readFile(join(root,"source.glb"))).equals(glb())).toBe(true)
 })

 test("素材实例按resourceId与实际层级定位，重复名称与旧版本引用不会误选或改写",()=>{
  const ref={resourceId:"asset",version:1,original:{uri:"file:///fixture.glb",mimeType:"model/gltf-binary"},representations:[],source:{units:"m",upAxis:"Z" as const,handedness:"right" as const}}
  const old={...node("first"),resources:[ref]},child={...node("child","first"),resources:[{...ref,version:2}]},second={...node("second"),resources:[{...ref,version:3}]},unrelated={...node("other"),resources:[{...ref,resourceId:"other-asset"}]}
  const scene:SceneSnapshot={sceneId:"fixture",revision:4,coordinates:SCENE_COORDINATES,entities:[old,child,second,unrelated]}
  expect(assetSceneInstances(scene,"asset").map(value=>value.entityId)).toEqual(["first","second"])
  expect(sceneSubtreeIds(scene,"first")).toEqual(["first","child"])
  const commit=visibilityCommit(scene,"first",false)
  expect(commit.expectedRevision).toBe(4)
  expect(commit.patch[0]).toMatchObject({op:"update",entityId:"first",changes:{components:{visual:{kind:"group",visible:false},collision:{shape:"box"},controller:{keep:true}}}})
  expect(old.resources[0]!.version).toBe(1)
 })
})
