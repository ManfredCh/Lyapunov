import {expect,test} from 'bun:test'
import {renderToStaticMarkup} from 'react-dom/server'
import {ImportPurposeChoice} from '../src/import-purpose-choice.tsx'
import {importLocalFiles,localImportPhysicsInput,localImportUsageDefault,type LocalImportPhysicsUsage} from '../src/local-file-import.ts'
import {inAssetDomain} from '../src/asset-library-panel.tsx'
import type {AssetRecord} from '../src/workbench-api.ts'

test('用途选择默认可见、可改且三入口共用，不把已导入当物理ready',()=>{
 expect(localImportUsageDefault('scene')).toBe('environment');expect(localImportUsageDefault('environment')).toBe('environment')
 expect(localImportUsageDefault('object')).toBe('dynamic');expect(localImportUsageDefault('library')).toBe('dynamic')
 for(const value of ['environment','static','dynamic'] as const){
  const html=renderToStaticMarkup(<ImportPurposeChoice value={value} onChange={()=>{}} tr={s=>s}/>)
  expect(html).toContain('aria-label="网格导入用途"');expect(html).toContain(`value="${value}" selected=""`)
  expect(html).toContain('文件选择、本地路径和拖入');expect(html).toContain('物理是否就绪以运行状态为准')
 }
})
test('显式用途登记原源/GLB，不依文件名猜；转换和挂载只带同版本资源身份',async()=>{
 for(const usage of ['environment','static','dynamic'] as LocalImportPhysicsUsage[]){
  const calls:Array<{name:string;input:any}>=[],converted:any[]=[]
  const result=await importLocalFiles({current:()=>true,physicalizeUsage:usage,show:()=>{},progress:()=>{},async command<T>(name:string,input:any){calls.push({name,input});if(name==='scene_import'&&!input.sceneId)return {resource:{ref:{resourceId:'source',version:4}}} as T;return {snapshot:{sceneId:'s',revision:2},entityId:'e'} as T},async convert(source){converted.push(source);return {resourceId:'renderable',version:5}}},['/建筑其实是物体.FBX','/robot其实是场景.glb'],'scene','s')
  expect(result.errors).toEqual([]);expect(calls[0]!.input.physicalizeUsage).toBe(usage);expect(calls[2]!.input.physicalizeUsage).toBe(usage)
  expect(converted).toEqual([{resourceId:'source',version:4}]);expect(calls[1]).toEqual({name:'scene_mount',input:{sceneId:'s',resourceId:'renderable',version:5}})
 }
})
test('原生机器人、策略和大点云不被用途选择隐式烘焙或改本体',()=>{
 for(const path of ['/g1.urdf','/panda.xml','/panda.mjcf','/scene.ply','/world.spz','/bundle.json','/policy.pt','/sky.hdr'])expect(localImportPhysicsInput(path,'dynamic')).toEqual({})
 expect(localImportPhysicsInput('/scene.glb','static')).toEqual({physicalizeUsage:'static'})
})
test('库归属采用已登记用途，环境mesh与动态物体/native robot可分别找到',()=>{
 const base={ref:{resourceId:'r',version:1,original:{uri:'file:///a.glb',mimeType:'model/gltf-binary'}},name:'a',tags:[],folder:'',parsed:{kind:'mesh'},physicalizationRequest:{usage:'environment'}} as AssetRecord
 expect(inAssetDomain('environment',base)).toBe(true);expect(inAssetDomain('scene',base)).toBe(true);expect(inAssetDomain('object',base)).toBe(false)
 const object={...base,physicalizationRequest:{usage:'dynamic' as const}};expect(inAssetDomain('object',object)).toBe(true);expect(inAssetDomain('environment',object)).toBe(false)
 const robot={...base,parsed:{kind:'robot'}};expect(inAssetDomain('robot',robot)).toBe(true)
})
