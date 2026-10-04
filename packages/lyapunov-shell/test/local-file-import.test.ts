import { test, expect } from "bun:test"
import { importLocalFiles, localFileKind, localDropIsImport, LOCAL_IMPORT_FILE_FILTERS, type LocalFileConvertResult, type LocalFileImportPort } from "../src/local-file-import.ts"
import {copyFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {resolveLocalImportPath} from '../../scene-kit/src/local-import-entry.ts'
import type { SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"
const snapshot=(sceneId:string)=>({sceneId,revision:1,entities:[],coordinates:{units:"m",upAxis:"Z",handedness:"right",quaternion:"xyzw"}} as SceneSnapshot)
function harness(convert?:LocalFileImportPort["convert"]){
 const calls:Array<{name:string;input:any}>=[],shown:SceneSnapshot[]=[];let active=true,registrations=0
 const port:LocalFileImportPort={current:()=>active,progress:()=>{},show:s=>shown.push(s),async command<T>(name:string,input:any){
   calls.push({name,input})
   if(name==="scene_create"||name==="scene_open"||name==="scene_package_import")return snapshot("new") as T
   // 源工程登记（不带 sceneId）回本会话资源身份；其余导入/挂载回快照。
   if(name==="scene_import"&&input&&input.sceneId===undefined){registrations+=1;return {resource:{ref:{resourceId:`res_src_${registrations}`,version:1}},snapshot:snapshot("new"),entityId:"asset"} as T}
   return {snapshot:snapshot("new"),entityId:`asset-${calls.length}`} as T
 },...(convert?{convert}:{})}
 return {port,calls,shown,leave:()=>{active=false}}
}
test("空视图一次建场景，批量路径去重，直接执行导入并挂载",async()=>{
 const h=harness();const r=await importLocalFiles(h.port,["/a.ply","/b.glb","/a.ply"],"scene")
 expect(h.calls.map(c=>c.name)).toEqual(["scene_create","scene_import","scene_import"])
 expect(h.calls[1]!.input.sceneId).toBe("new");expect(r.imported).toEqual(["a.ply","b.glb"])
 expect(r.orientation).toEqual({sceneId:"new",revision:1,rootEntityIds:["asset-2","asset-3"]})
})
test('正规bundle和支持权重先分派策略，不由scene_import吞文件或创建空场景',async()=>{
 const h=harness(),loaded:string[]=[]
 h.port.loadPolicy=async filePath=>{loaded.push(filePath);return {filePath,face:{state:{category:'weights_need_adapter',ready:false}}}}
 const result=await importLocalFiles(h.port,['/policy/bundle.json','/policy/model.pt'],'scene')
 expect(loaded).toEqual(['/policy/bundle.json','/policy/model.pt']);expect(h.calls).toHaveLength(0);expect(h.shown).toHaveLength(0)
 expect(result.policyFiles).toEqual(['bundle.json','model.pt']);expect(result.imported).toEqual([]);expect(result.orientation).toBeUndefined()
 for(const path of ['/bundle.json','/g1.bundle.json','C:\\local\\BUNDLE.JSON','/a.PT','/a.pth','/a.jit','/a.torchscript','/a.onnx','/a.safetensors'])expect(localFileKind(path)).toBe('policy')
 expect(localFileKind('/config.json')).toBeUndefined();expect(localFileKind('/scene.json')).toBe('scene')
 expect(LOCAL_IMPORT_FILE_FILTERS.some(filter=>filter.extensions.includes('pt'))).toBe(true)
})
test('登记服务缺失和许可阻断原样反馈，策略不触普通Scene命令',async()=>{
 const h=harness();const missing=await importLocalFiles(h.port,['/bundle.json'],'scene')
 expect(missing.errors[0]).toContain('POLICY_IMPORT_UNAVAILABLE');expect(h.calls).toHaveLength(0)
 h.port.loadPolicy=async filePath=>({filePath,face:{failure:{status:'BLOCKED',code:'ROBOT_DOWNLOAD_NOT_READY',message:'具体权重许可未核'}}})
 const blocked=await importLocalFiles(h.port,['/bundle.json'],'scene')
 expect(blocked.errors[0]).toContain('ROBOT_DOWNLOAD_NOT_READY');expect(blocked.policyFiles).toHaveLength(0);expect(h.calls).toHaveLength(0)
})
test('策略读取期间离开原scope，迟到回执不续派下一文件',async()=>{
 const h=harness(),loaded:string[]=[]
 h.port.loadPolicy=async filePath=>{loaded.push(filePath);h.leave();return {filePath,face:{cancelled:true}}}
 const result=await importLocalFiles(h.port,['/bundle.json','/other.pt'],'scene')
 expect(loaded).toEqual(['/bundle.json']);expect(result.policyFiles).toHaveLength(0);expect(h.calls).toHaveLength(0)
})
test("拖到素材库不建场景；源工程不生成不可见场景实体",async()=>{
 const h=harness();await importLocalFiles(h.port,["/a.ply"],"library")
 expect(h.calls[0]!.input.sceneId).toBeUndefined();expect(h.calls).toHaveLength(1)
 expect((await importLocalFiles(harness().port,["/a.ply"],"library")).orientation).toBeUndefined()
 const h2=harness();const result=await importLocalFiles(h2.port,["/a.blend","/b.usda"],"scene")
 expect(h2.calls.every(c=>c.name==="scene_import"&&!c.input.sceneId)).toBe(true);expect(result.sources).toEqual(["a.blend","b.usda"])
})
test("会话在导入期间切换，迟到回执不写新视图、后续文件不继续派发",async()=>{
 const h=harness();h.port.command=async<T>()=>{h.leave();return {snapshot:snapshot("old")} as T}
 const r=await importLocalFiles(h.port,["/a.ply","/b.glb"],"scene","old")
 expect(h.shown).toHaveLength(0);expect(r.imported).toHaveLength(0)
 expect(r.orientation).toBeUndefined()
})
test("混合批次逐项报告失败并继续有效文件；glTF 复用依赖组装入口",async()=>{
 const h=harness();const r=await importLocalFiles(h.port,["/bad.txt","/box.gltf"],"scene","old")
 expect(r.errors[0]).toContain("bad.txt");expect(r.imported).toEqual(["box.gltf"])
 expect(h.calls[0]!.name).toBe("scene_asset_acquire")
})
test("工程拖入走 scene_open；普通 JSON 不冒充工程",async()=>{
 const h=harness();await importLocalFiles(h.port,["/scene.json"],"scene")
 expect(h.calls[0]!.name).toBe("scene_open");expect(localFileKind("/config.json")).toBeUndefined()
 const mixed=harness();const result=await importLocalFiles(mixed.port,["/a.ply","/scene.json","/b.glb"],"scene")
 expect(result.orientation?.rootEntityIds).toEqual(["asset-4"])
})
test("自包含物理包走正规资源登记入口，普通场景保留打开语义",async()=>{
 const h=harness();const result=await importLocalFiles(h.port,["/物理交互.scene-package.json"],"scene","old")
 expect(localFileKind("/物理交互.scene-package.json")).toBe("scene")
 expect(h.calls.map(c=>c.name)).toEqual(["scene_package_import"])
 expect(h.shown[0]!.sceneId).toBe("new");expect(result.errors).toEqual([])
})
test(".usdz 不列为拖拽可转换源（parseAsset 不接受登记，列出来第一步就会失败）",()=>{
 expect(localFileKind("/m.usdz")).toBeUndefined()
 expect(localFileKind("/m.USDC")).toBe("source")
 expect(localFileKind("/m.usda")).toBe("source")
 expect(localFileKind("/m.blend")).toBe("source")
})
test(".blend/.usd：源件先入库保留，转换只带资源身份，再用 scene_mount 挂派生件",async()=>{
 const converted:Array<{resourceId:string;version:number}>=[]
 const h=harness(async(source)=>{converted.push(source);return{resourceId:`glb_${source.resourceId}`,version:7,cached:false,convertMs:12,name:"robot"}})
 const r=await importLocalFiles(h.port,["/models/robot.blend","/models/scene.usda"],"scene")
 // 每个源：scene_import(源，无 sceneId) → (首个文件) scene_create → scene_mount(派生资源身份)。
 expect(h.calls.map(c=>c.name)).toEqual(["scene_import","scene_create","scene_mount","scene_import","scene_mount"])
 expect(h.calls[0]!.input).toEqual({path:"/models/robot.blend",physicalizeUsage:'environment'})
 expect(h.calls[1]!.input).toEqual({})
 expect(h.calls[2]!.input).toEqual({sceneId:"new",resourceId:"glb_res_src_1",version:7})
 expect(h.calls[3]!.input).toEqual({path:"/models/scene.usda",physicalizeUsage:'environment'})
 expect(h.calls[4]!.input).toEqual({sceneId:"new",resourceId:"glb_res_src_2",version:7})
 // 转换端口收到的是资源身份，不是路径。
 expect(converted).toEqual([{resourceId:"res_src_1",version:1},{resourceId:"res_src_2",version:1}])
 expect(r.sources).toEqual(["robot.blend","scene.usda"])
 expect(r.imported).toEqual(["robot.blend","scene.usda"])
 expect(r.errors).toEqual([])
 expect(h.shown.length).toBeGreaterThan(0)
})
test("转换失败：源件保留，但不把 source 入库当显示成功（错误写明原因）",async()=>{
 const h=harness(async()=>{throw new Error("Blender 转换失败（退出码 1）：BLENDER_NO_OBJECTS")})
 const r=await importLocalFiles(h.port,["/models/empty.blend"],"scene")
 expect(r.sources).toEqual(["empty.blend"])   // 源件已入库保留
 expect(r.imported).toEqual([])               // 没有显示成功
 expect(r.errors).toHaveLength(1)
 expect(r.errors[0]).toContain("empty.blend")
 expect(r.errors[0]).toContain("没有生成可显示的 GLB")
 expect(r.errors[0]).toContain("BLENDER_NO_OBJECTS")
 // 没有 scene_create / scene_mount（没走到挂载那一步）。
 expect(h.calls.map(c=>c.name)).toEqual(["scene_import"])
})
test("登记回执缺资源身份：源件保留但不冒充转换成功",async()=>{
 const h=harness(async()=>({resourceId:"glb_x",version:1}))
 h.port.command=async<T>(name:string,input:any)=>{h.calls.push({name,input});return {} as T}
 const r=await importLocalFiles(h.port,["/models/a.blend"],"scene")
 expect(r.sources).toEqual(["a.blend"])
 expect(r.imported).toEqual([])
 expect(r.errors[0]).toContain("没有给出可转换的资源身份")
})
test("拖到素材库：可转换源工程也出 GLB 入库，但不建场景、不挂载",async()=>{
 const converted:Array<{resourceId:string;version:number}>=[]
 const h=harness(async(source)=>{converted.push(source);return{resourceId:"glb_1",version:2,cached:true}})
 const r=await importLocalFiles(h.port,["/models/a.blend"],"library")
 // 服务端在 convert-source 里登记派生 GLB：客户端只有源件登记这一步命令，没有第二次 scene_import。
 expect(h.calls.map(c=>c.name)).toEqual(["scene_import"])
 expect(h.calls[0]!.input.sceneId).toBeUndefined()
 expect(converted).toEqual([{resourceId:"res_src_1",version:1}])
 expect(r.imported).toEqual(["a.blend"])
})
test("宿主没有转换能力（没有 convert 端口）：源件照旧入库保留，但明确报告没有显示",async()=>{
 const h=harness()
 const r=await importLocalFiles(h.port,["/models/a.blend"],"scene")
 expect(r.sources).toEqual(["a.blend"])
 expect(r.imported).toEqual([])   // 没有转换能力就不算显示成功
 expect(r.errors).toHaveLength(1)
 expect(r.errors[0]).toContain("没有接上转换服务")
 // 只有登记那一次 scene_import，没有 scene_create / 挂载。
 expect(h.calls.map(c=>c.name)).toEqual(["scene_import"])
 expect(h.calls[0]!.input.sceneId).toBeUndefined()
})
test("HDR/EXR：源件入库（环境面板消费），不尝试 Blender 转换",async()=>{
 const h=harness(async()=>{throw new Error("不该被调用")})
 const r=await importLocalFiles(h.port,["/env/sky.hdr","/env/light.exr"],"library")
 expect(r.sources).toEqual(["sky.hdr","light.exr"])
 expect(r.imported).toEqual(["sky.hdr","light.exr"])
 expect(r.errors).toEqual([])
 expect(r.convertedSources).toEqual([])
 expect(h.calls.every(c=>c.name==="scene_import"&&c.input.sceneId===undefined)).toBe(true)
})
// 类型级守卫：转换端口只能收资源身份（编译期已挡路径）；这里留一个运行期形状断言，防将来被改回路径。
test("转换端口契约：只带 resourceId/version，不带客户端路径",async()=>{
 const seen:unknown[]=[]
 const h=harness(async(source)=>{seen.push(source);const result:LocalFileConvertResult={resourceId:"glb_1",version:2};return result})
 await importLocalFiles(h.port,["/models/a.blend"],"library")
 expect(seen).toEqual([{resourceId:"res_src_1",version:1}])
 expect(Object.keys(seen[0] as object).sort()).toEqual(["resourceId","version"])
})
test("OBJ/FBX从同一文件选择表进入已登记资源转换，并只挂载可显示派生身份",async()=>{
 const seen:unknown[]=[]
 const h=harness(async source=>{seen.push(source);return{resourceId:`glb_${source.resourceId}`,version:1}})
 const result=await importLocalFiles(h.port,["/model/textured.obj","/model/rig.fbx"],"scene")
 expect(LOCAL_IMPORT_FILE_FILTERS[0]!.extensions).toContain("obj")
 expect(LOCAL_IMPORT_FILE_FILTERS[0]!.extensions).toContain("fbx")
 expect(result.errors).toEqual([])
 expect(result.imported).toEqual(["textured.obj","rig.fbx"])
 expect(result.convertedSources).toEqual(["textured.obj","rig.fbx"])
 expect(h.calls.map(c=>c.name)).toEqual(["scene_import","scene_create","scene_mount","scene_import","scene_mount"])
 expect(seen).toEqual([{resourceId:"res_src_1",version:1},{resourceId:"res_src_2",version:1}])
 expect(h.calls[2]!.input.resourceId).toBe("glb_res_src_1")
 expect(h.calls[4]!.input.resourceId).toBe("glb_res_src_2")
})
test("源工程转换完成但挂载失败时如实保留GLB回执，不误报没生成",async()=>{
 const h=harness(async()=>({resourceId:"glb_fbx",version:1}))
 const original=h.port.command
 h.port.command=async<T>(name:string,input:unknown)=>{if(name==="scene_mount")throw new Error("SCENE_REVISION_CONFLICT");return original<T>(name,input)}
 const result=await importLocalFiles(h.port,["/rig.fbx"],"scene","active")
 expect(result.imported).toEqual([])
 expect(result.convertedSources).toEqual(["rig.fbx"])
 expect(result.errors[0]).toContain("GLB已生成并保留在素材库")
 expect(result.errors[0]).not.toContain("没有生成")
})

test('机器人目录唯一原生入口分派scene_import，保留原文件及相对meshes路径',async()=>{
 const directory=join(import.meta.dir,'../../scene-kit/test/fixtures/mjcf-g1')
 const resolved=await resolveLocalImportPath(directory)
 expect(resolved).toEqual({path:join(directory,'g1_29dof_with_hand.xml'),kind:'robot-directory'})
 const h=harness();h.port.resolvePath=resolveLocalImportPath
 const result=await importLocalFiles(h.port,[directory],'scene')
 expect(result.errors).toEqual([]);expect(result.imported).toEqual(['g1_29dof_with_hand.xml'])
 expect(h.calls.map(call=>call.name)).toEqual(['scene_create','scene_import'])
 expect(h.calls[1]!.input).toEqual({path:resolved.path,sceneId:'new'})
 expect(localFileKind('/robot/meshes/pelvis.STL')).toBeUndefined()
})

test('目录多入口和仅meshes均给明确选择反馈，不创建空场景',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'lya-robot-drop-'))
 try{
  const source=join(import.meta.dir,'../../scene-kit/test/fixtures/mjcf-g1/g1_29dof_with_hand.xml')
  await copyFile(source,join(directory,'one.xml'));await copyFile(source,join(directory,'two.xml'))
  const h=harness();h.port.resolvePath=resolveLocalImportPath
  const result=await importLocalFiles(h.port,[directory],'scene')
  expect(result.errors[0]).toContain('ROBOT_ENTRY_SELECTION_REQUIRED')
  expect(result.errors[0]).toContain('one.xml');expect(result.errors[0]).toContain('two.xml')
  expect(h.calls).toHaveLength(0)
  await rm(join(directory,'one.xml'));await rm(join(directory,'two.xml'));await mkdir(join(directory,'meshes'))
  await writeFile(join(directory,'meshes/pelvis.STL'),'依赖文件仅用于无入口负例')
  await expect(resolveLocalImportPath(directory)).rejects.toThrow('ROBOT_ENTRY_REQUIRED')
 }finally{await rm(directory,{recursive:true,force:true})}
})

test('含bundle与本体的目录只登记策略；纯权重目录缺bundle具体反馈',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'lya-policy-directory-drop-'))
 try{
  await writeFile(join(directory,'model.pt'),'目录分派负例')
  await expect(resolveLocalImportPath(directory)).rejects.toThrow('POLICY_BUNDLE_REQUIRED')
  await writeFile(join(directory,'bundle.json'),'{}')
  await copyFile(join(import.meta.dir,'../../scene-kit/test/fixtures/mjcf-g1/g1_29dof_with_hand.xml'),join(directory,'robot.xml'))
  const h=harness(),loaded:string[]=[];h.port.resolvePath=resolveLocalImportPath
  h.port.loadPolicy=async filePath=>{loaded.push(filePath);return {filePath,face:{state:{category:'weights_need_adapter',ready:false}}}}
  const result=await importLocalFiles(h.port,[directory],'scene')
  expect(loaded).toEqual([join(directory,'bundle.json')]);expect(result.policyFiles).toEqual(['bundle.json'])
  expect(h.calls).toHaveLength(0);expect(result.imported).toHaveLength(0)
 }finally{await rm(directory,{recursive:true,force:true})}
})

test('目录拖入聊天区域由工作台接管，普通图片/文档保留原生附件',()=>{
 const directory={webkitGetAsEntry:()=>({isDirectory:true})} as Pick<DataTransferItem,'webkitGetAsEntry'>
 expect(localDropIsImport([{name:'robot'}],[directory],false)).toBe(true)
 expect(localDropIsImport([{name:'model.xml'}],[],false)).toBe(true)
 expect(localDropIsImport([{name:'参考.png'},{name:'说明.pdf'}],[],false)).toBe(false)
 expect(localDropIsImport([{name:'unknown.bin'}],[],true)).toBe(true)
})

test('宿主路径解析离开当前scope后不续派，解析失败仍继续下一个有效文件',async()=>{
 const h=harness();h.port.resolvePath=async path=>{if(path==='/missing')throw Error('ENOENT');return {path,kind:'file'}}
 const result=await importLocalFiles(h.port,['/missing','/robot.xml'],'library')
 expect(result.errors[0]).toContain('ENOENT');expect(result.imported).toEqual(['robot.xml'])
 const leaving=harness();leaving.port.resolvePath=async path=>{leaving.leave();return {path,kind:'file'}}
 await importLocalFiles(leaving.port,['/robot.xml','/other.xml'],'scene')
 expect(leaving.calls).toHaveLength(0)
})
