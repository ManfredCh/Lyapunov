import {expect,test} from 'bun:test'
import {isValidElement,type ReactElement,type ReactNode} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {cp,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import * as THREE from 'three'
import {TransformControls} from 'three/addons/controls/TransformControls.js'
import {AssetPlacementBar,assetPlacementInput,assetPlacementOf,DomainAssetList,AssetPhysicsStatus,type AssetDomain,type AssetPlacement} from '../src/asset-library-panel.tsx'
import {workbenchAPI,type AssetRecord} from '../src/workbench-api.ts'
import {identityTransform,SCENE_COORDINATES,type SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'
import {SceneOperations} from '../../scene-kit/src/operations.ts'
import {localPath} from '../../scene-kit/src/formats.ts'
import {SceneViewer} from '../../viewer/src/index.ts'
import {FrameProjection} from '../../viewer/src/projection.ts'
import {assetSceneInstances,entityEffectivelyVisible,removeSceneNodeCommit,visibilityCommit} from '../src/scene-node-controls.tsx'
const noop=()=>{}

test('Objects 选择页搜索名称、标签、格式与内置项；过滤保留真实选择且不提前放置',async()=>{
 const sdkRequire=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url))
 const {JSDOM}=sdkRequire('jsdom'),dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.invalid'})
 const previous=new Map<string,PropertyDescriptor|undefined>()
 for(const key of ['window','document','navigator','HTMLElement','Event','MouseEvent','Node','IS_REACT_ACT_ENVIRONMENT']){
  previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[key],configurable:true,writable:true})
 }
 const React=await import('react'),{createRoot}=await import('react-dom/client'),{Simulate}=await import('react-dom/test-utils')
 const asset:AssetRecord={ref:{resourceId:'cube',version:4,original:{uri:'file:///cube.glb',mimeType:'model/gltf-binary'}},name:'Cube plain',tags:['Furniture'],folder:'',parsed:{kind:'mesh'}}
 const bench:AssetRecord={...asset,ref:{...asset.ref,resourceId:'bench',original:{uri:'file:///bench.obj',mimeType:'model/obj'}},name:'Workbench',tags:['Table']}
 const assets=[asset,bench,{...asset,ref:{...asset.ref,resourceId:'trashed'},name:'Deleted cube',deletedAt:'2026-10-19'}, {...asset,ref:{...asset.ref,resourceId:'robot'},name:'Robot cube',parsed:{kind:'robot'}}]
 const before=structuredClone(assets),selected:AssetRecord[]=[],mounted:AssetRecord[]=[],imported:string[]=[]
 const builtin:Parameters<typeof DomainAssetList>[0]['builtin']=[{resourceId:'builtin-box',assetId:'builtin-box',displayName:'Builtin box',category:'object',kind:'mesh',path:'/local/box.glb'},{resourceId:'builtin-robot',assetId:'builtin-robot',displayName:'Builtin robot',category:'robot',kind:'robot',path:'/local/robot.xml'}]
 let canMount=true,domain:AssetDomain='object'
 function Harness(){
  const [selectedKey,setSelectedKey]=React.useState<string>()
  return <DomainAssetList domain={domain} assets={assets} builtin={builtin} busy={false} available canMount={canMount} tr={(_cn,en)=>en} importBuiltin={item=>imported.push(item.assetId)} mount={item=>mounted.push(item)} selectionMode selectedKey={selectedKey} onSelect={item=>{selected.push(item);setSelectedKey(`${item.ref.resourceId}:${item.ref.version}`)}}/>
 }
 const host=document.getElementById('root')!,root=createRoot(host),draw=()=>root.render(<Harness/>),search=()=>host.querySelector<HTMLInputElement>('[aria-label="Search assets"]')!
 const change=async(value:string)=>{await React.act(async()=>Simulate.change(search(),{target:{value}} as any))}
 const rows=()=>[...host.querySelectorAll<HTMLButtonElement>('.lya-object-asset-row')]
 try{
  await React.act(async()=>draw())
  expect(search().type).toBe('search');expect(rows().map(row=>row.textContent)).toEqual(['Cube plainSelect','WorkbenchSelect'])
  expect(host.textContent).not.toContain('Deleted cube');expect(host.textContent).not.toContain('Robot cube');expect(host.textContent).not.toContain('Builtin robot')
  await change('  FURNITURE ');expect(rows()).toHaveLength(1)
  await React.act(async()=>rows()[0]!.click())
  expect(selected).toEqual([asset]);expect(rows()[0]!.getAttribute('aria-pressed')).toBe('true');expect(mounted).toHaveLength(0)
  await change('bench');expect(rows().map(row=>row.getAttribute('aria-label'))).toEqual(['Select asset Workbench'])
  await change('missing');expect(rows()).toHaveLength(0);expect(host.querySelector('[role="status"]')?.textContent).toBe('No matching assets')
  await change('GLB');expect(rows()).toHaveLength(1);expect(rows()[0]!.getAttribute('aria-pressed')).toBe('true')
  await change('Builtin box');expect(rows()).toHaveLength(0)
  await React.act(async()=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(row=>row.textContent==='Import')!.click())
  expect(imported).toEqual(['builtin-box']);expect(mounted).toHaveLength(0)
  await change('');expect(rows()).toHaveLength(2);expect(rows()[0]!.getAttribute('aria-pressed')).toBe('true')
  expect(host.querySelectorAll('details[open]')).toHaveLength(0);expect(assets).toEqual(before)
  canMount=false;await React.act(async()=>draw());expect(rows().every(row=>row.disabled)).toBe(true)
  domain='environment';await React.act(async()=>draw());expect(search()).toBeNull()
 }finally{
  await React.act(async()=>root.unmount());dom.window.close()
  for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}
 }
})

test('Objects 局部样式固定选择行32px、搜索/属性/放置控件28px，不依赖全局token',async()=>{
 const {libraryStyle}=await import('../src/library-style.ts')
 expect(libraryStyle).toContain('.lya-wb-panel .lya-object-asset-picker .lya-object-asset-search{height:28px;min-height:28px;font-size:12px}')
 expect(libraryStyle).toMatch(/\.lya-wb-panel \.lya-object-asset-picker \.lya-object-asset-row\{[^}]*height:32px;min-height:32px/)
 expect(libraryStyle).toContain('.lya-wb-panel .lya-property-editor .lya-values input{height:28px;min-height:28px;font-size:12px}')
 expect(libraryStyle).toContain('.lya-wb .lya-placement-bar button{min-height:28px;font-size:12px}')
})

test('素材卡片直读四种派生事实和失败原因，恢复动作传真实同版本资源并遵守编辑权限',()=>{
 const asset:AssetRecord={ref:{resourceId:'r',version:2,original:{uri:'file:///actual.glb',mimeType:'model/gltf-binary'}},name:'环境模型',tags:[],folder:'',parsed:{kind:'mesh'},physicalizationRequest:{usage:'environment'}}
 const ref={...asset.ref,representations:[],source:{units:'m',upAxis:'Z' as const,handedness:'right' as const}},scene:SceneSnapshot={sceneId:'s',revision:4,coordinates:SCENE_COORDINATES,entities:[{entityId:'model',name:'model',transform:identityTransform(),resources:[ref],components:{visual:{kind:'group'},physicsBinding:{resourceId:'r',version:2,status:'BIND_REQUIRED',reason:'PHYSICS_DERIVATION_NOT_RUNNING'}}}]}
 const called:AssetRecord[]=[],controls={scene,recoverPhysics:(value:AssetRecord)=>called.push(value)}
 const render=(record=asset,overrides={})=>AssetPhysicsStatus({asset:record,controls:{...controls,...overrides},available:true,tr:cn=>cn})
 for(const status of ['pending','failed','skipped','ok']){
  const record={...asset,physicalization:{status,usage:'environment' as const,...status==='failed'?{error:'PROVIDER_FAILED: 真实原因'}:{}}}
  const html=renderToStaticMarkup(render(record))
  expect(html).toContain(`data-physics-status="${status}"`)
  if(status==='failed')expect(html).toContain('PROVIDER_FAILED: 真实原因')
  if(status==='ok')expect(html).toContain('实例绑定与世界状态见物理面板')
  button(render(record),'打开物理面板恢复碰撞').props.onClick!()
  expect(called.at(-1)).toBe(record)
 }
 expect(button(render(asset,{sceneReadOnly:true}),'打开物理面板恢复碰撞').props.disabled).toBe(true)
 expect(renderToStaticMarkup(render({...asset,physicalizationRequest:false,physicalization:{status:'ok'}}))).toContain('data-physics-status="skipped"')
 const wrong={...asset,ref:{...asset.ref,version:3}}
 expect(buttons(render(wrong)).some(item=>text(item.props.children)==='打开物理面板恢复碰撞')).toBe(false)
 expect(renderToStaticMarkup(render(wrong))).toContain('加入当前场景后')
 const domain=renderToStaticMarkup(<DomainAssetList domain="environment" assets={[{...asset,physicalization:{status:'failed'}}]} builtin={[]} busy={false} available canMount tr={cn=>cn} importBuiltin={noop} mount={noop} instanceControls={controls}/>)
 expect(domain).toContain('碰撞派生失败');expect(domain).toContain('打开物理面板恢复碰撞')
})
test('放置条按真实kind默认原点/底面，实际命令传显式模式；取消与重新加入不继承选择和点击点',async()=>{
 const oldFetch=globalThis.fetch,sent:Array<{name:string;input:any}>=[]
 globalThis.fetch=(async(_url:unknown,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));sent.push(body);return Response.json({kind:'success',ui:{snapshot:{sceneId:body.input.sceneId,revision:1},entityId:'placed'}})}) as typeof fetch
 const api=workbenchAPI('placement-fixture')
 let placement:AssetPlacement|undefined,point:[number,number,number]|undefined
 const cancel=()=>{placement=undefined;point=undefined}
 const begin=(kind:string|undefined,uri:string)=>{placement=assetPlacementOf({ref:{resourceId:'arbitrary',version:4,original:{uri,mimeType:'fixture'}},name:'任意名称',tags:[],folder:'',...kind?{parsed:{kind}}:{}});point=undefined}
 const render=()=>AssetPlacementBar({asset:placement!,point,tr:cn=>cn,cancel,alignment:value=>{if(placement)placement={...placement,alignBottomToSurface:value}},confirm:async()=>{if(placement&&point)await api.command('scene_mount',assetPlacementInput('scene-current',placement,point))}})
 const select=(node:ReactNode):ReactElement<{onChange:(event:any)=>void}>|undefined=>{
  if(Array.isArray(node)){for(const child of node){const found=select(child);if(found)return found}return}
  if(!isValidElement<{children?:ReactNode}>(node))return
  return node.type==='select'?node as ReactElement<{onChange:(event:any)=>void}>:select(node.props.children)
 }
 try{
  for(const [kind,uri,expected] of [['robot','/native.xml',false],['robot','/native.urdf',false],['robot','/unexpected.name',false],['mesh','/ordinary.xml',true],['splat','/scene.ply',true],[undefined,'/unknown.xml',true]] as const){
   begin(kind,uri);expect(placement?.alignBottomToSurface).toBe(expected)
   expect(renderToStaticMarkup(render())).toContain(expected?'value="bottom" selected':'value="origin" selected')
   expect(buttons(render()).some(item=>text(item.props.children)==='放置物体')).toBe(false)
   point=[2,3,4];await button(render(),'放置物体').props.onClick!()
   expect(sent.at(-1)?.name).toBe('scene_mount');expect(sent.at(-1)?.input).toEqual({sceneId:'scene-current',resourceId:'arbitrary',version:4,alignBottomToSurface:expected,transform:{position:[2,3,4],quaternion:[0,0,0,1],scale:[1,1,1]}})
   select(render())!.props.onChange({target:{value:expected?'origin':'bottom'}})
   await button(render(),'放置物体').props.onClick!();expect(sent.at(-1)?.input.alignBottomToSurface).toBe(!expected)
   button(render(),'取消').props.onClick!();expect(placement).toBeUndefined();expect(point).toBeUndefined()
   begin(kind,uri);expect(placement?.alignBottomToSurface).toBe(expected);expect(point).toBeUndefined()
  }
  const before=sent.length;cancel();expect(placement).toBeUndefined();begin('mesh','/object.glb');expect(placement?.alignBottomToSurface).toBe(true);expect(point).toBeUndefined();expect(sent).toHaveLength(before)
 }finally{globalThis.fetch=oldFetch}
})
test('放置条：选点前可取消、选点后 Place/取消可达；Escape 说明不常驻但仍由画布键盘处理',async()=>{
 const placement=assetPlacementOf({ref:{resourceId:'r',version:1,original:{uri:'/a.glb',mimeType:'fixture'}},name:'任意名称',tags:[],folder:'',parsed:{kind:'mesh'}})
 const before=renderToStaticMarkup(AssetPlacementBar({asset:placement,point:undefined,tr:cn=>cn,alignment:noop,confirm:noop,cancel:noop}))
 expect(before).toContain('data-testid="asset-placement-bar"')
 expect(before).toContain('data-testid="asset-placement-cancel"')
 expect(before).not.toContain('Escape 也可取消')
 // 选点前不给提前可用的 Confirm（合理行为），但取消始终可达。
 expect(before).not.toContain('data-testid="asset-placement-confirm"')
 const after=renderToStaticMarkup(AssetPlacementBar({asset:placement,point:[1,2,3],tr:cn=>cn,alignment:noop,confirm:noop,cancel:noop}))
 expect(after).toContain('data-testid="asset-placement-confirm"')
 expect(after).toContain('data-testid="asset-placement-point"')
 // Escape 路径必须覆盖资产放置，而不只覆盖装配拾取。
 const source=await readFile(new URL('../src/workbench.tsx',import.meta.url),'utf8')
 expect(source).toMatch(/placingAsset\)return[\s\S]{0,500}exitPlacement\(\)/)
 expect(source).toContain('[attachPick,parkingPickActive,placingAsset]')
})

test('四个域展示同Scene的真实实例根，包含旧版本、当前选择和显隐；未放置资源区分',()=>{
 for(const [domain,kind] of [['robot','robot'],['object','mesh'],['environment','splat'],['scene','source']] as Array<[AssetDomain,string]>){
  const asset:AssetRecord={ref:{resourceId:'r',version:3,original:{uri:'file:///fixture',mimeType:'test'}},name:'可加入资源',tags:[],folder:'',parsed:{kind}}
  const ref={...asset.ref,representations:[],source:{units:'m',upAxis:'Z' as const,handedness:'right' as const}}
  const scene:SceneSnapshot={sceneId:'s',revision:1,coordinates:SCENE_COORDINATES,entities:[{entityId:'one',name:'已加入一',transform:identityTransform(),components:{visual:{visible:false}},resources:[{...ref,version:1}]},{entityId:'child',name:'内部节点',parentId:'one',transform:identityTransform(),components:{},resources:[ref]},{entityId:'two',name:'已加入二',transform:identityTransform(),components:{},resources:[ref]}]}
  const html=renderToStaticMarkup(<DomainAssetList domain={domain} assets={[asset,{...asset,ref:{...asset.ref,resourceId:'other'},name:'库存但未放置'}]} builtin={[]} busy={false} available canMount tr={cn=>cn} importBuiltin={noop} mount={noop} instanceControls={{scene,selectedInstanceId:'two',selectInstance:noop,focusInstance:noop,setInstanceVisible:noop,removeInstance:noop}}/>)
  expect(html).toContain('已放置 2 个实例');expect(html).toContain('尚未放入当前场景')
  expect(html).toContain('库版本 3')
  expect(html).toContain('已加入一');expect(html).toContain('已加入二');expect(html).not.toContain('内部节点')
  expect(html).toContain('aria-pressed="true"');expect(html).toContain('v1');expect(html).toContain('显示节点 已加入一');expect(html).toContain('从场景移除')
 }
})

type ButtonProps={children?:ReactNode;onClick?:()=>unknown;'aria-label'?:string;'aria-pressed'?:boolean;title?:string;disabled?:boolean}
/** 直接执行产品纯函数组件及其按钮回调；没有 DOM/GPU，不以静态文本冒充 handler。 */
function buttons(node:ReactNode):ReactElement<ButtonProps>[] {
 if(Array.isArray(node))return node.flatMap(buttons)
 if(!isValidElement<{children?:ReactNode}>(node))return []
 if(typeof node.type==='function')return buttons((node.type as (props:unknown)=>ReactNode)(node.props))
 const children=buttons(node.props.children)
 return node.type==='button'?[node as ReactElement<ButtonProps>,...children]:children
}
function text(node:ReactNode):string {
 if(typeof node==='string'||typeof node==='number')return String(node)
 if(Array.isArray(node))return node.map(text).join('')
 return isValidElement<{children?:ReactNode}>(node)?text(node.props.children):''
}
function button(node:ReactNode,label:string):ReactElement<ButtonProps> {
 const found=buttons(node).find(item=>item.props['aria-label']===label||text(item.props.children)===label)
 if(!found)throw new Error(`BUTTON_NOT_FOUND: ${label}`)
 return found
}
function fixtureGLB(version:number):Buffer {
 const data=Buffer.from(JSON.stringify({asset:{version:'2.0',generator:`layers-v${version}`},scene:0,scenes:[{nodes:[0]}],nodes:[{name:'内部叶'}],meshes:[]}))
 const json=Buffer.concat([data,Buffer.alloc((4-data.length%4)%4,0x20)]),header=Buffer.alloc(20)
 header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(20+json.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16)
 return Buffer.concat([header,json])
}
/** 同既有 entity-visibility 用例：真正 SceneViewer.setScene/Three 层级，只有资源加载替身。 */
function sceneViewerFixture(){
 const viewer=Object.create(SceneViewer.prototype) as any
 viewer.options={onError:(error:Error)=>{throw error}};viewer.scene=new THREE.Scene();viewer.objects=new Map();viewer.mixers=new Map();viewer.splatRuntime=new Map();viewer.visualWarnings=new Map();viewer.loadingErrors=new Map();viewer.projection=new FrameProjection()
 // Object.create不运行构造字段；保留真实setScene/setCameraRigs路径。
 viewer.cameraRigs=new Map();viewer.cameraRigRoot=new THREE.Group();viewer.scene.add(viewer.cameraRigRoot)
 viewer.camera=new THREE.PerspectiveCamera();viewer.transformControls=new TransformControls(viewer.camera)
 viewer.sun=new THREE.DirectionalLight();viewer.generation=0;viewer.geometryRevision=0;viewer.sceneLightsVisible=true
 for(const method of ['setSceneEnvironment','trackAnimation','applyDisplay','updateAnnotationMarkers','syncEnvironmentMap'])viewer[method]=()=>{}
 let loads=0
 viewer.loadVisual=async()=>{loads++;return new THREE.Group()}
 return {viewer,loads:()=>loads}
}
function effectivelyVisible(object:THREE.Object3D):boolean {for(let node:THREE.Object3D|null=object;node;node=node.parent)if(!node.visible)return false;return true}

test('四域选中内部叶时只高亮所属实例根，重复名称不会高亮另一实例',()=>{
 for(const [domain,kind] of [['robot','robot'],['object','mesh'],['environment','splat'],['scene','source']] as Array<[AssetDomain,string]>){
  const asset:AssetRecord={ref:{resourceId:'r',version:2,original:{uri:'file:///fixture',mimeType:'test'}},name:'库资源',tags:[],folder:'',parsed:{kind}}
  const ref={...asset.ref,representations:[],source:{units:'m',upAxis:'Z' as const,handedness:'right' as const}}
  const scene:SceneSnapshot={sceneId:'s',revision:3,coordinates:SCENE_COORDINATES,entities:[{entityId:'one',name:'同名实例',transform:identityTransform(),components:{},resources:[{...ref,version:1}]},{entityId:'source',name:'源坐标转换',parentId:'one',transform:identityTransform(),components:{},resources:[]},{entityId:'leaf',name:'内部叶',parentId:'source',transform:identityTransform(),components:{},resources:[ref]},{entityId:'two',name:'同名实例',transform:identityTransform(),components:{},resources:[ref]}]}
  const rows=buttons(DomainAssetList({domain,assets:[asset],builtin:[],busy:false,available:true,canMount:true,tr:cn=>cn,importBuiltin:noop,mount:noop,instanceControls:{scene,selectedInstanceId:'leaf',selectInstance:noop}})).filter(item=>item.props['aria-label']==='选择场景实例 同名实例')
  expect(rows.map(item=>[item.props.title,item.props['aria-pressed']])).toEqual([['one',true],['two',false]])
 }
})

test('实际域按钮 handler 加入新版、显隐旧版、删除和历史恢复沿 SceneOperations/CAS 与 Viewer 子树一致',async()=>{
 const root=await mkdtemp(join(tmpdir(),'domain-instance-handlers-'))
 try{
  const ops=new SceneOperations(join(root,'data'),{defaultStorage:'cas'}),other=new SceneOperations(join(root,'other'),{defaultStorage:'cas'})
  await ops.create({sceneId:'layers'});await other.create({sceneId:'layers'})
  const file=join(root,'asset.glb'),original=fixtureGLB(1),newBytes=fixtureGLB(2)
  await writeFile(file,original)
  const old=await ops.import({path:file,sceneId:'layers',resourceId:'same-asset',entityId:'old',name:'旧实例',physicalize:false,components:{collision:{shape:'box',halfExtents:[1,1,1]},rigidBody:{type:'dynamic',massKg:1},controller:{keep:true}}})
  await other.import({path:file,sceneId:'layers',resourceId:'same-asset',entityId:'old',name:'其他会话实例',physicalize:false})
  const otherBefore=await other.scene.snapshot('layers')
  expect((await stat(file)).ino).not.toBe((await stat(localPath(old.resource.ref.original.uri))).ino)
  await writeFile(file,newBytes)
  expect((await ops.resources.verify('same-asset',1)).valid).toBe(true)
  const latest=await ops.import({path:file,resourceId:'same-asset',name:'新实例',physicalize:false})
  expect([old.resource.ref.version,latest.resource.ref.version]).toEqual([1,2])
  const asset:AssetRecord={ref:latest.resource.ref,name:latest.resource.name,tags:latest.resource.tags,folder:latest.resource.folder,parsed:latest.resource.parsed}
  let scene=old.snapshot!,selected='old:node:0',focused:string|undefined
  const {viewer,loads}=sceneViewerFixture()
  const apply=async(next:SceneSnapshot)=>{scene=next;await viewer.setScene(next)}
  await apply(scene)
  const render=()=>DomainAssetList({domain:'object',assets:[asset],builtin:[],busy:false,available:true,canMount:true,tr:cn=>cn,importBuiltin:noop,
   mount:async record=>{const value=await ops.mount({sceneId:scene.sceneId,resourceId:record.ref.resourceId,version:record.ref.version,entityId:'new'});await apply(value.snapshot)},
   instanceControls:{scene,selectedInstanceId:selected,selectInstance:id=>{selected=id},focusInstance:id=>{focused=id},
    setInstanceVisible:async(id,visible)=>{await apply(await ops.scene.commit(visibilityCommit(scene,id,visible)))},
    removeInstance:async id=>{await apply(await ops.scene.commit(removeSceneNodeCommit(scene,id)))}}})
  expect(button(render(),'选择场景实例 旧实例').props['aria-pressed']).toBe(true)
  await button(render(),'定位场景实例 旧实例').props.onClick!();expect(focused).toBe('old')
  await button(render(),'选择场景实例 旧实例').props.onClick!();expect(selected).toBe('old')
  await button(render(),'加入场景').props.onClick!()
  expect(assetSceneInstances(scene,'same-asset').map(entity=>[entity.entityId,entity.resources[0]!.version])).toEqual([['old',1],['new',2]])
  const before=scene,oldRoot=before.entities.find(entity=>entity.entityId==='old')!,loaded=viewer.objects.get('old'),loadCount=loads()
  await button(render(),'隐藏节点 旧实例').props.onClick!()
  const hidden=scene,hiddenRoot=hidden.entities.find(entity=>entity.entityId==='old')!
  expect(hidden.revision).toBe(before.revision+1);expect(hiddenRoot.components.visual?.visible).toBe(false)
  expect(hiddenRoot.resources).toEqual(oldRoot.resources);expect(hiddenRoot.transform).toEqual(oldRoot.transform)
  for(const key of ['collision','rigidBody','controller'])expect(hiddenRoot.components[key]).toEqual(oldRoot.components[key])
  expect(entityEffectivelyVisible(hidden,hidden.entities.find(entity=>entity.entityId==='old:node:0')!)).toBe(false)
  expect(viewer.objects.get('old')).toBe(loaded);expect(loads()).toBe(loadCount)
  expect(effectivelyVisible(viewer.objects.get('old:node:0').group)).toBe(false);expect(effectivelyVisible(viewer.objects.get('new:node:0').group)).toBe(true)
  const path=join(root,'saved.json');await ops.save(scene.sceneId,path)
  const reopened=await ops.open(path,{sceneId:'reopened'})
  expect(assetSceneInstances(reopened,'same-asset').map(entity=>entity.resources[0]!.version)).toEqual([1,2])
  expect(reopened.entities.find(entity=>entity.entityId==='old')?.components.visual?.visible).toBe(false)
  await button(render(),'显示节点 旧实例').props.onClick!()
  expect(effectivelyVisible(viewer.objects.get('old:node:0').group)).toBe(true);expect(loads()).toBe(loadCount)
  await button(render(),'从场景移除实例 旧实例').props.onClick!()
  expect(assetSceneInstances(scene,'same-asset').map(entity=>entity.entityId)).toEqual(['new'])
  expect(scene.entities.some(entity=>entity.entityId==='old'||entity.entityId.startsWith('old:'))).toBe(false)
  expect([...viewer.objects.keys()].some((id:string)=>id==='old'||id.startsWith('old:'))).toBe(false)
  expect(effectivelyVisible(viewer.objects.get('new:node:0').group)).toBe(true)
  expect((await ops.resources.list({allVersions:true})).map(record=>record.ref.version)).toEqual([1,2])
  expect(await other.scene.snapshot('layers')).toEqual(otherBefore)
  expect((await readFile(localPath(old.resource.ref.original.uri))).equals(original)).toBe(true)
  expect((await readFile(file)).equals(newBytes)).toBe(true)
  await apply(await ops.restore({sceneId:'layers',revision:hidden.revision,expectedRevision:scene.revision}))
  expect(scene.revision).toBeGreaterThan(hidden.revision)
  expect(assetSceneInstances(scene,'same-asset').map(entity=>[entity.entityId,entity.resources[0]!.version])).toEqual([['old',1],['new',2]])
  expect(effectivelyVisible(viewer.objects.get('old:node:0').group)).toBe(false)
  expect(viewer.objects.get('new').group.visible).toBe(true)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('机器人多文件 CAS 闭包与外部原件/网格 inode 独立，内部入口锚点仍复用硬链',async()=>{
 const root=await mkdtemp(join(tmpdir(),'domain-instance-cas-closure-'))
 try{
  const source=join(root,'source')
  await cp(join(import.meta.dir,'../../scene-kit/test/fixtures/mjcf-duplicate-sections'),source,{recursive:true})
  const ops=new SceneOperations(join(root,'data'),{defaultStorage:'cas'})
  const imported=await ops.import({path:join(source,'scene.xml'),resourceId:'robot',physicalize:false}),record=imported.resource
  const entry=localPath(record.ref.original.uri),anchor=entry.replace(/_deps\/.*$/,''),mesh=record.parsed.dependencies.find(stamp=>stamp.path.endsWith('/meshes/a.stl'))!
  expect(entry).toContain('_deps/');expect(record.parsed.dependencies).toHaveLength(5)
  expect((await stat(entry)).ino).not.toBe((await stat(join(source,'scene.xml'))).ino)
  expect((await stat(entry)).ino).toBe((await stat(anchor)).ino)
  const sourceMesh=join(source,'meshes/a.stl'),original=await readFile(sourceMesh)
  expect((await stat(mesh.path)).ino).not.toBe((await stat(sourceMesh)).ino)
  await writeFile(sourceMesh,Buffer.concat([original,Buffer.from('\n')]))
  expect((await readFile(mesh.path)).equals(original)).toBe(true)
  expect((await ops.resources.verify('robot',record.ref.version)).valid).toBe(true)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('V10 放置条：预览状态短条；确认复用预览同一份 transform，避免二次换算错位',async()=>{
 const placement=assetPlacementOf({ref:{resourceId:'r',version:2,original:{uri:'/a.glb',mimeType:'fixture'}},name:'任意名称',tags:[],folder:'',parsed:{kind:'mesh'}})
 const resolved={position:[1,2,3] as [number,number,number],quaternion:[0,0,0,1] as [number,number,number,number],scale:[1,1,1] as [number,number,number]}
 expect(assetPlacementInput('scene-current',placement,[9,9,9],resolved)).toEqual({sceneId:'scene-current',resourceId:'r',version:2,alignBottomToSurface:false,transform:resolved})
 const ready=renderToStaticMarkup(AssetPlacementBar({asset:placement,point:[1,2,3],status:'ready',tr:cn=>cn,alignment:noop,confirm:noop,cancel:noop}))
 expect(ready).toContain('data-preview-status="ready"')
 expect(ready).toContain('预览就绪')
 expect(ready).toContain('data-testid="asset-placement-confirm"')
 const unavailable=renderToStaticMarkup(AssetPlacementBar({asset:placement,point:[1,2,3],status:'unavailable',reason:'ASSET_PREVIEW_SPLAT_UNSUPPORTED',tr:cn=>cn,alignment:noop,confirm:noop,cancel:noop}))
 expect(unavailable).toContain('预览不可用')
 expect(unavailable).toContain('ASSET_PREVIEW_SPLAT_UNSUPPORTED')
 expect(unavailable).not.toContain('Escape 也可取消')
})
