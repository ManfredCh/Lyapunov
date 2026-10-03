import { open,readFile,readdir,realpath,rm,stat,writeFile } from 'node:fs/promises'
import { basename,dirname,join,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProvider } from './operations.ts'
import { type HullMesh,type ShapeMeasure } from './geometry/convex-hull.ts'
import { type PrimitiveFit } from './geometry/fit-primitive.ts'
import { decomposeConcaveToBoxes,VOXEL_DECOMPOSE_DEFAULTS } from './geometry/voxel-decompose.ts'
import { materialProperties,massFromVolume,DEFAULT_MATERIAL } from './materials.ts'
import { readGeometryManifest } from './geometry-data.ts'
import { GeometryComputeSession,type GeometryProgress } from './geometry-compute.ts'
export interface PhysicalizeInput { sourcePath:string;outputDirectory:string;sourceUpAxis?:'Y'|'Z';metersPerUnit?:number;material?:string;strategy?:'auto'|'triangle_mesh'|'convex_hull'|'voxel_boxes'|'coacd'|'sdf';usage?:'dynamic'|'static'|'environment';
 /** 表面体素边长（绑定值）。环境给此值即可固定门洞/多层表面的通行精度：晶格超预算时按同一晶格分块，不再静默粗化体素。 */
 voxelSizeM?:number;
 /** 整个结果的盒数硬上限（分块按总数累加）；环境默认 2048。超过即 VOXEL_DECOMPOSITION_FAILED，不退回凸包、不粗化体素。 */
 maxBoxes?:number;
 /** 点云占据单元硬上限（默认 250000，最高 1000000）；PLY 只分块读取 XYZ，不把百万顶点转 JSON。 */
 maxOccupiedVoxels?:number;
 /** CoACD 阈值（米）：设置后以 real-metric 模式分解；缺省保持归一化 0.05 阈值，行为不变。 */
 coacdThresholdM?:number;
 /** 深腔容器自动路由阈值（仅 auto）：水密且 CoACD 分件数 ≥ 此值的节点改派 SDF；缺省 16，随资产库标定。 */
 sdfAutoParts?:number;maxTiles?:number;maxSamples?:number;maxFaceVisits?:number;maxWorkingBytes?:number;maxWorkingBoxes?:number;
 pointCloudTiling?:{coverage:'full';tileSizeCells:number;maxTotalOccupiedVoxels:number;maxTotalBoxes:number;maxTiles:number;maxDiskBytes:number} }
async function writeOBJ(path:string,vertices:Float64Array,faces:Uint32Array){
 const file=await open(path,'w');let block=''
 const line=async(text:string)=>{block+=text;if(block.length>=1024*1024){await file.write(block);block=''}}
 try{for(let i=0;i<vertices.length;i+=3)await line(`v ${vertices[i]} ${vertices[i+1]} ${vertices[i+2]}\n`);for(let i=0;i<faces.length;i+=3)await line(`f ${faces[i]+1} ${faces[i+1]+1} ${faces[i+2]+1}\n`);if(block)await file.write(block)}finally{await file.close()}
}
/** 同一文件判定：path.resolve 只做词法归一；realpath 覆盖符号链接，dev+ino 覆盖硬链接。 */
async function sameFile(left:string,right:string){
 if(resolve(left)===resolve(right))return true
 try{if(await realpath(left)===await realpath(right))return true}catch{}
 try{const [a,b]=await Promise.all([stat(left),stat(right)]);return a.dev===b.dev&&a.ino===b.ino}catch{return false}
}
/** 三角表面总面积（m²）。表面模式用它区分合法 2D 表面与空/共线退化网格。 */
function surfaceAreaM2(vertices:Float64Array,faces:Uint32Array){
 let area=0
 for(let i=0;i+2<faces.length;i+=3){
  const a=faces[i]*3,b=faces[i+1]*3,c=faces[i+2]*3
  const ux=vertices[b]-vertices[a],uy=vertices[b+1]-vertices[a+1],uz=vertices[b+2]-vertices[a+2]
  const vx=vertices[c]-vertices[a],vy=vertices[c+1]-vertices[a+1],vz=vertices[c+2]-vertices[a+2]
  area+=Math.hypot(uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx)/2
 }
 return area
}
/** 本次运行产出的件文件里，只有被最终 representations 引用的才是产物。被逐节点重派替换掉的原始扫描件
 *  （凸分解/体素/原生形状走的是别的产物）是纯临时文件：留在目录里会让"哪份文件才是这次的产物"含混。
 *
 *  所有权只用**明确声明**：本次写出的文件 = provider 逐次返回的 parts[].path + 本次自己写出的 target
 *  （hull-<n>.obj / voxel-<n>.json），且必须落在本次 outputDirectory 里。**不**按文件名或扩展名推断归属——调用方
 *  （asset_bake 允许指定 outputDirectory）目录里原有的 reference.png / part-99.obj 之类一律不碰：
 *  它们不在本次声明里，就不属于本次。源文件与不属于本管线的文件同样一概不动（不做全库清理）。
 *  bake.json 是本次扫描的原始记录，清完后按存活件重写，免得记录指向已删文件。 */
async function pruneUnreferencedParts(outputDirectory:string,items:Array<{node:string;selected:string;target?:string}>,...sources:Array<{parts?:Array<{path:string}>}>):Promise<string[]>{
 const directory=resolve(outputDirectory)
 const referenced=new Set<string>()
 const written=new Set<string>()
 for(const item of items)if(item.target){referenced.add(resolve(item.target));written.add(resolve(item.target))}
 for(const item of items)if(item.selected==='coacd'||item.selected==='triangle_mesh'||item.selected==='sdf'){
  const source=item.selected==='coacd'?sources[sources.length-1]:sources[0]
  for(const part of source?.parts??[])if(part.path)referenced.add(resolve(part.path))
 }
 for(const source of sources)for(const part of source?.parts??[])if(part.path)written.add(resolve(part.path))
 const pruned:string[]=[];const prunedPaths=new Set<string>()
 for(const path of [...written].sort()){
  if(dirname(path)!==directory)continue
  if(referenced.has(path))continue
  try{await rm(path);pruned.push(basename(path));prunedPaths.add(path)}catch{}
 }
 if(pruned.length)try{
  const bakePath=join(directory,'bake.json')
  const record=JSON.parse(await readFile(bakePath,'utf8')) as {parts?:Array<{path:string}>}
  record.parts=(record.parts??[]).filter(part=>!prunedPaths.has(resolve(part.path)))
  await writeFile(bakePath,JSON.stringify({...record,prunedUnreferencedParts:pruned},null,2))
 }catch{}
 return pruned
}

/** 保留质量/材质、凸包、体素空腔与可选CoACD能力；不再使用 Panda 尺寸约束。 */
export async function physicalize(input:PhysicalizeInput,options:{python?:string;workerPath?:string;signal?:AbortSignal;onProgress?:(message:GeometryProgress)=>void;execute?:(request:Record<string,unknown>)=>Promise<any>}={}){
 const requested=input.strategy
 const strategy=requested??(input.usage==='environment'?'triangle_mesh':'auto')
 // 环境缺省/auto：调用方没有钉死碰撞表示，逐节点按实测选"在把 mesh geom 当凸包消费的引擎里仍是同一形状"
 // 的那一种（非凸/开放表面→不填内部的体素表面）；**显式**给策略时按请求导出，改由回执如实报告
 // 该表示在目标引擎里会失去什么（consumerNotice / interiorPreserved=false），不静默替换请求的表示。
 // auto 与"省略策略"在这里同义（都没有钉死表示），所以白名单也按这个语义放行：auto 走的是下面这条
 // 逐节点默认路线，不是被替换成某个具体策略；调用方显式给的具体策略照旧逐个判定（见 environmentDefault）。
 const environmentDefault=input.usage==='environment'&&(requested===undefined||requested==='auto')
 const staticSurfaceDefault=(input.usage==='environment'||input.usage==='static')&&(requested===undefined||requested==='auto')
 if(input.usage==='environment'&&!environmentDefault&&!['triangle_mesh','voxel_boxes','coacd'].includes(strategy))throw new Error('环境按独立表面/保空腔表示导出；凸包会把房间或通道封死（可用 auto/triangle_mesh/voxel_boxes/coacd）。SDF 不在环境可用集里：消费方是**已接**的（sim-mujoco worker 把 shape=sdf 装配成 mjGEOM_SDF，packages/sim-mujoco/python/worker.py:1021），缺的是环境的多表面/静态体口径按 SDF 夹具的标定——拒绝理由是"环境未标定"，不是"消费方通道未接"；对象用途可以显式用 sdf。')
 // 表面模式只导出碰撞表面：地板/墙面就是合法的 2D 三角面，没有封闭体积。
 // 需要体积的路径保持原意（convex_hull、auto 的凹腔判定、动态体素的填实）：平面仍按 EMPTY_GEOMETRY 失败。
 const surfaceMode=strategy==='triangle_mesh'||staticSurfaceDefault||(input.usage==='environment'&&strategy!=='convex_hull')
 const coacdParams=input.coacdThresholdM?{threshold:input.coacdThresholdM,realMetric:true}:{}
 const run=(request:Record<string,unknown>)=>options.execute?options.execute(request):runProvider(request,options)
 const raw=await run({...input,method:strategy==='coacd'?'coacd':'triangle_mesh',pointCloudStrategy:staticSurfaceDefault?'auto':strategy,...coacdParams})
 type PointDecomposition=ReturnType<typeof decomposeConcaveToBoxes>&{pointCloud?:Record<string,unknown>}
 // 清单必须绑定调用方的源；不能拿 worker 自报的另一源路径作为校验期望。
 const expectedSourcePath=input.sourcePath.startsWith('file:')?fileURLToPath(input.sourcePath):input.sourcePath
 if(raw.sourcePath&&!await sameFile(raw.sourcePath,expectedSourcePath))throw new Error('INVALID_GEOMETRY_TRANSPORT: worker 源文件与本次请求不符')
 const geometry=await readGeometryManifest(raw.geometryDataPath,{...input,sourcePath:expectedSourcePath,signal:options.signal})
 const geometries=geometry.nodes
 const pointSurfaces=geometries.filter(node=>node.sourceKind==='point_cloud'&&node.pointCloud?.processing==='full-spatial-voxel-surface')
 if(pointSurfaces.length){
  const info=pointSurfaces[0]!.pointCloud!
  const countKeys=['sourcePoints','finitePoints','sourceOccupiedVoxels','exteriorQuads','triangles','meshParts','occupiedCellSha256']
  if(pointSurfaces.length!==geometries.length||info.meshParts!==pointSurfaces.length||pointSurfaces.reduce((count,node)=>count+(node.index?.count??0)/3,0)!==info.triangles||pointSurfaces.some(node=>countKeys.some(key=>node.pointCloud?.[key]!==info[key])))throw new Error('INVALID_GEOMETRY_TRANSPORT: full point-cloud surface 分件/源计数不完整或不一致')
 }
 const material=input.material??DEFAULT_MATERIAL;const properties=materialProperties(material);const outputs=[]
 const globalVoxelBudget=input.maxBoxes??2048
 if(!Number.isSafeInteger(globalVoxelBudget)||globalVoxelBudget<1||globalVoxelBudget>10000)throw new Error('INVALID_VOXEL_BOX_BUDGET: maxBoxes 必须是 1..10000 的整数，应用于全部节点总盒数')
 let globalVoxelBoxes=0
 let totalVoxelTiles=0,totalVoxelSamples=0
 const addBoxes=(count:number,node:string)=>{globalVoxelBoxes+=count;if(globalVoxelBoxes>globalVoxelBudget)throw new Error(`VOXEL_GLOBAL_BOX_BUDGET_EXCEEDED: ${node} 累计 ${globalVoxelBoxes} 盒超过整个结果 maxBoxes=${globalVoxelBudget}；未截断、未退回凸包`)}
 type Prepared={g:(typeof geometries)[number];measured:ShapeMeasure|undefined;surfaceAreaM2:number;selected:string;target?:string;result?:PointDecomposition;primitive?:PrimitiveFit;colliderHull?:HullMesh;hullSafe:boolean;solid:boolean;routeReason?:string}
 /** 凸包即自身（concavity ≤ 此值）才算"按凸包消费不改变几何"。真凸网格的 concavity 是浮点噪声级 0。 */
 const CONVEX_TOLERANCE=1e-3
 const prepared:Prepared[]=[]
 let compute:GeometryComputeSession|undefined
 const worker=()=>compute??=new GeometryComputeSession({signal:options.signal,onProgress:options.onProgress})
 const voxelOptions={fillInterior:input.usage!=='environment'&&input.usage!=='static',voxelSizeM:input.voxelSizeM,maxTiles:input.maxTiles,maxSamples:input.maxSamples,maxFaceVisits:input.maxFaceVisits,maxWorkingBytes:input.maxWorkingBytes,maxWorkingBoxes:input.maxWorkingBoxes}
 const voxel=async(vertices:Float64Array,faces:Uint32Array,maxBoxes:number|undefined,node:string)=>{
  const detail=await worker().voxel(vertices,faces,{...voxelOptions,maxBoxes},node)
  if(detail.status==='failed')throw new Error(`VOXEL_${detail.reason}: ${JSON.stringify({node,...detail.diagnostics,globalBoxesUsed:globalVoxelBoxes,globalMaxBoxes:globalVoxelBudget})}`,{cause:detail.diagnostics})
  totalVoxelTiles+=detail.result.tiles;totalVoxelSamples+=detail.diagnostics.samplesProcessed
  if(totalVoxelTiles>(input.maxTiles??4096)||totalVoxelSamples>1_000_000_000)throw new Error(`VOXEL_GLOBAL_WORK_BUDGET: ${JSON.stringify({node,totalVoxelTiles,maxTotalTiles:input.maxTiles??4096,totalVoxelSamples,maxTotalSamples:1_000_000_000})}`)
  return detail.result
 }
 try{
 for(const [index,g] of geometries.entries()){
  // 只在这个调用帧内持有当前节点；Prepared 保留小描述、实测摘要和有界碰撞表示。
  const prepare=async():Promise<Prepared>=>{
  const {vertices,faces}=await geometry.load(g)
  if(g.sourceKind==='point_cloud'&&g.pointCloud?.processing==='full-spatial-voxel-surface'){
   if(strategy!=='triangle_mesh'||!input.pointCloudTiling||!['environment','static'].includes(input.usage??''))throw new Error('POINT_CLOUD_VOXEL_SURFACE_REQUIRES_EXPLICIT_STATIC_TRIANGLE_MESH')
   const info=g.pointCloud
   if(info.voxelSizeM!==input.voxelSizeM||info.coverageComplete!==true||info.representation!=='voxel_surface'||Object.entries(input.pointCloudTiling).some(([key,value])=>info.fullTiling?.[key]!==value))throw new Error('INVALID_GEOMETRY_TRANSPORT: full point-cloud surface 参数/完整覆盖与本次请求不符')
   return{g,measured:undefined,surfaceAreaM2:faces.length/6*Number(info.voxelSizeM)**2,selected:'triangle_mesh',hullSafe:false,solid:false,routeReason:'VOXEL_SURFACE:全部实际XYZ占据晶格的外边界，仅明确Isaac-static-none适用；Mu普通mesh不支持凹体素表面'}
  }
  if(g.kind==='point_cloud'){
   if(!g.decomposition?.boxes.length)throw new Error('EMPTY_POINT_CLOUD: '+g.node)
   return {g,measured:undefined,surfaceAreaM2:0,selected:'voxel_boxes',target:join(input.outputDirectory,`voxel-${index}.json`),result:g.decomposition,hullSafe:false,solid:false,routeReason:'POINT_CLOUD:只有 XYZ 采样，无三角面；使用实际样本的占据体素盒，不填内部、不生成伪网格'}
  }
  const {measured,surfaceAreaM2:surfaceArea}=await worker().measure(vertices,faces,g.node)
  // 表面模式接受非零面积的平面；空/共线退化网格（面积 0）与需要体积的策略一样失败。
  if(!measured&&!(surfaceMode&&surfaceArea>0))throw new Error('EMPTY_GEOMETRY: '+g.node)
  let selected=staticSurfaceDefault?'triangle_mesh':strategy==='auto'?(measured!.concavity>.25?'coacd':'convex_hull'):strategy
  // 逐节点判定"这份几何在按凸包消费的引擎（MuJoCo/Isaac 把每个 mesh geom 当凸包碰撞）里还是不是
  // 同一个形状"。判据取实测几何，不取调用方给的参数：
  //   · 水密且体积为正的实体：凸包体积多出来的部分就是被补实的凹腔 → concavity ≤ 容差才算凸包即自身；
  //   · 其余（开放壳、缠绕不一致、退化平面）：测不出可信体积，但凸包会给开放壳补上封闭面并得到正体积
  //     （平面网格的凸包体积为 0，即没有补上实体，surfaceMode 照旧按表面导出）。
  const solid=Boolean(measured)&&g.watertight&&measured!.meshVolumeM3>0
  // 无体积不能证明凸包就是源表面：平面环/U 形仍会被凸包补孔。只有水密实体且实测凸包等同
  // 才能声明安全；无体积的表面走不填内部的表面体素，显式三角面仍如实报告消费限制。
  // 非水密但有体积的开放壳，凸包会给它补上封闭面并多出
  // 一块实体（实测可见），同样不是同一形状——它走体素表面，不走被凸化的逐面网格。
  const hullSafe=Boolean(measured)&&solid&&measured!.concavity<=CONVEX_TOLERANCE
  // 环境：源 GLB 的"独立表面"不等于"凸包即自身"。凹节点必须换不会凸化的表示，否则引擎会把门洞/房间
  // 封死，而回执还写着保空腔——回执要报告消费后的实际限制，就不能拿请求参数当证据。
  // static/environment 缺省/auto 对全部非等价源面采用未填充表面盒：闭壳/反向壳/接触壳都不需要
  // 猜材料包含关系，也不经可能填腔的 CoACD。全部源三角面参与同一晶格，固定精度与硬预算不变。
  // 显式策略不动——请求什么就导出什么，由回执说清楚引擎会怎么消费它。
  let routeReason:string|undefined
  if(staticSurfaceDefault&&selected==='triangle_mesh'&&!hullSafe){
   selected='voxel_boxes'
   routeReason=solid?'CONCAVE: Rasterize all source triangles into unfilled surface voxel boxes without inferring solid/void from shell orientation. voxelSizeM reports actual pitch; finite surface thickness can narrow or close small openings.':'OPEN_SURFACE: Rasterize all source triangles into unfilled surface voxel boxes without adding closed caps or filling interiors. voxelSizeM reports actual pitch; finite surface thickness can narrow or close small openings.'
  }
  if(selected==='convex_hull'){
   // 近原生形状（盒/球/z 轴圆柱）直接用引擎原生 geom：零误差、零烘焙，避免外凸包过冲。
   const {primitive,exact}=await worker().collider(vertices,faces,measured!.meshVolumeM3,g.node)
   // 多节点只有盒组有现成组合契约；球/圆柱不能退成各自AABB，保真实凸包件。
   if(primitive&&(geometries.length===1||primitive.shape==='box'))return {g,measured,surfaceAreaM2:surfaceArea,selected:'primitive',primitive,hullSafe,solid,routeReason}
   // 精确凸包面数在预算内就用精确凸包（零过冲）；超出才退回面数有界的外凸包。
   let colliderHull=measured!.hull
   if(exact)colliderHull=exact
   return {g,measured,surfaceAreaM2:surfaceArea,selected,target:join(input.outputDirectory,`hull-${index}.obj`),colliderHull,hullSafe,solid,routeReason}
  }
  if(selected==='voxel_boxes'){
   const nodeBudget=input.maxBoxes??(input.usage==='environment'?2048:undefined)
   const result=await voxel(vertices,faces,nodeBudget,g.node)
   return {g,measured,surfaceAreaM2:surfaceArea,selected,target:join(input.outputDirectory,`voxel-${index}.json`),result,hullSafe,solid,routeReason}
  }
  return {g,measured,surfaceAreaM2:surfaceArea,selected,hullSafe,solid,routeReason}
  }
  const item=await prepare();if(item.result)addBoxes(item.result.boxes.length,g.node);prepared.push(item)
 }
 // auto 判凹的节点追加第二轮 CoACD 通道（显式 strategy='coacd' 时首轮已是分解结果，不重复跑）；
 // CoACD 不可用或崩溃时凹节点退回 voxel_boxes（旧行为兜底），不新增失败面。
 let coacdRaw=raw
 let coacdGeometry:Awaited<ReturnType<typeof readGeometryManifest>>|undefined
 if(strategy!=='coacd'&&prepared.some(item=>item.selected==='coacd')){
  try{
   const sourceNodes=prepared.filter(item=>item.selected==='coacd').map(item=>item.g.node)
   coacdRaw=await run({...input,method:'coacd',sourceNodes,...coacdParams})
   coacdGeometry=await readGeometryManifest(coacdRaw.geometryDataPath,{...input,sourcePath:expectedSourcePath,signal:options.signal})
   if(coacdGeometry.nodes.length!==sourceNodes.length||coacdGeometry.nodes.some(node=>!sourceNodes.includes(node.node)))throw new Error('INVALID_GEOMETRY_TRANSPORT: CoACD 返回的节点与实际改派请求不符')
   for(const node of coacdGeometry.nodes)await coacdGeometry.load(node)
  }
  catch(error){options.signal?.throwIfAborted();if(coacdRaw!==raw||error instanceof Error&&error.message.includes('COACD_REAL_METRIC_UNSUPPORTED'))throw error;for(const item of prepared)if(item.selected==='coacd'){
   const {vertices,faces}=await geometry.load(item.g)
   const result=await voxel(vertices,faces,input.maxBoxes??(input.usage!=='environment'?2048:undefined),item.g.node)
   addBoxes(result.boxes.length,item.g.node);item.selected='voxel_boxes';item.target=join(input.outputDirectory,`voxel-${prepared.indexOf(item)}.json`);item.result=result
  }}
 }
 // 深腔容器标定路由（仅 auto，且非环境默认路线）：水密且 CoACD 分件数超阈值的节点是薄壳深腔（分解质量差、
 // 件数爆炸，实测碗=33 件），改派 SDF——不凸化、不封腔；非水密保持 coacd（SDF 符号对
 // 开放壳不可靠，实测穿底）。阈值经 sdfAutoParts 可调，缺省 16（随资产库标定）。
 // 环境（缺省或显式 auto）不在此列：环境的表示由上面逐节点判定（凹实体→凸分解）决定，SDF 的消费方
 // 请求 sdf 也被守卫拒绝（SDF 不在环境可用集）——所以这里的 auto 路由不能把环境用例带进 SDF。
  // 注意：**不是**"消费方通道未接"——对象用途的 sdf 消费方已接（sim-mujoco worker 的 mjGEOM_SDF）。
 const sdfAutoParts=input.sdfAutoParts??16
 if(strategy==='auto'&&!staticSurfaceDefault)for(const item of prepared)if(item.selected==='coacd'&&item.g.watertight){
  if(coacdRaw.parts.filter((part:any)=>part.sourceNode===item.g.node).length>=sdfAutoParts)item.selected='sdf'
 }
 // 源文件保护：先算出本次将写出的全部路径（hull-*/voxel-*/physicalization.json）并在任何写之前核对。
 // 返工已派生产物是普通场景（源可能就是上一次的 hull-0.obj），固定输出名会直接覆盖源；同一文件的
 // 符号链接/硬链接别名也算同一原件（realpath 或 dev+ino 相同），一并拒绝。
 const planned=prepared.map(item=>item.target).filter((target):target is string=>target!==undefined);planned.push(join(input.outputDirectory,'physicalization.json'))
 for(const target of planned)if(await sameFile(target,raw.sourcePath??input.sourcePath))throw new Error('SOURCE_OVERWRITE_REJECTED: 源文件与本次输出路径相同，已拒绝覆盖：'+(raw.sourcePath??input.sourcePath))
 for(const item of prepared){
  const {g,measured,selected}=item
  const rawParts=(selected==='coacd'?coacdRaw:raw).parts.filter((part:any)=>part.sourceNode===g.node)
  let parts=rawParts.map((part:any)=>part.path);let boxes:unknown;let decomposition:{voxelSizeM:number;gridDims:[number,number,number];tiles:number;fillInterior:boolean;sourceTriangles?:number}|undefined
  if(selected==='primitive')parts=[] // 原生形状由契约直接表达，提取件不入 representations
  else if(selected==='convex_hull'){
   const target=item.target!;await writeOBJ(target,item.colliderHull!.vertices,item.colliderHull!.faces);parts=[target]
  }else if(selected==='voxel_boxes'){
   const result=item.result!;boxes=result.boxes;decomposition={voxelSizeM:result.voxelSizeM,gridDims:result.gridDims,tiles:result.tiles,fillInterior:result.fillInterior,...g.kind!=='point_cloud'?{sourceTriangles:(g.index?.count??g.faces!.length)/3}:{}};const target=item.target!;await writeFile(target,JSON.stringify(result,null,2));parts=[target]
  }
  // 碰撞产物包围盒（实体局部帧、Z-up 米）：落地对齐的物理基准。primitive 直接由定义给出；
  // hull 取实际写出的碰撞网格顶点（含外凸包过冲）；voxel 取盒组并集；coacd/sdf 取 part 文件并集。
  let bounds:{min:[number,number,number];max:[number,number,number]}|undefined
  const grow=(lo:[number,number,number],hi:[number,number,number])=>{bounds=bounds?{min:bounds.min.map((v,i)=>Math.min(v,lo[i]!)) as [number,number,number],max:bounds.max.map((v,i)=>Math.max(v,hi[i]!)) as [number,number,number]}:{min:[...lo],max:[...hi]}}
  if(item.primitive){const {center,halfExtents:h}=item.primitive;grow(center.map((v,i)=>v-h[i]!) as [number,number,number],center.map((v,i)=>v+h[i]!) as [number,number,number])}
  else if(selected==='convex_hull'){const vs=item.colliderHull!.vertices;const lo:[number,number,number]=[Infinity,Infinity,Infinity],hi:[number,number,number]=[-Infinity,-Infinity,-Infinity];for(let a=0;a<3;a++)for(let i=a;i<vs.length;i+=3){if(vs[i]!<lo[a]!)lo[a]=vs[i]!;if(vs[i]!>hi[a]!)hi[a]=vs[i]!}grow(lo,hi)}
  else if(selected==='voxel_boxes'){for(const b of item.result!.boxes)grow(b.center.map((v,i)=>v-b.halfExtents[i]!) as [number,number,number],b.center.map((v,i)=>v+b.halfExtents[i]!) as [number,number,number])}
  else for(const part of rawParts){const b=(part as {bounds?:[[number,number,number],[number,number,number]]|null}).bounds;if(b)grow(b[0],b[1])}
  // 体积只有测得出时才有值：表面模式的平面/开放网格给 null 与原因，不伪造封闭体积，也不据此算质量。
  const volume=measured?{volumeM3:measured.meshVolumeM3,convexVolumeM3:measured.convexVolumeM3,concavity:measured.concavity}:{volumeM3:null,convexVolumeM3:null,concavity:null,volumeUnmeasurableReason:g.kind==='point_cloud'||g.sourceKind==='point_cloud'?'点云只有测得采样；体素边界不是原始封闭表面，不能计算实际材料体积':'无封闭体积的表面（平面或开放网格）：按三角表面积导出'}
  const mass=measured&&g.watertight?massFromVolume(measured.meshVolumeM3,material):undefined
  // 显式策略仍可能落在"引擎消费时会失去空腔"的表示上：逐面网格会被按凸包消费（凹腔/门洞补实），
  // 凸分解件本身是凸的（开放壳被补成实心）。这不是失败，但必须如实随产物报出去——回执不能拿
  // usage/strategy 当"空间已保留"的证据。
 const consumerNotice=selected==='triangle_mesh'&&!item.hullSafe?'CONSUMER_CONVEXIFIES:MuJoCo普通mesh按凸包碰撞，凹腔/门洞/开放面可能被补实；Isaac仅明确static/environment绑定strategy=triangle_mesh的native none适用原三角拓扑，仍须该provider实际接触验收；未选engine或auto不能据parts数量签保腔':selected==='coacd'&&!item.solid?'CONSUMER_CONVEXIFIES:凸分解件是凸的，开放壳在消费后会变成实心（要保开口用 voxel_boxes）':undefined
  // 近似误差：凸分解用"分件体积和 / 源网格体积"衡量（1.0 = 既没多吃也没少吃材料，只是用凸件拼出了凹形）。
  // 体素的误差是分辨率（decomposition 里的 voxelSizeM/gridDims/tiles + boxes 件数），表面导出无近似。
  const partsVolume=rawParts.reduce((sum:number,part:any)=>sum+(typeof part.volumeM3==='number'&&Number.isFinite(part.volumeM3)?Math.abs(part.volumeM3):0),0)
  const volumeRatio=selected==='coacd'&&measured&&measured.meshVolumeM3>0?Number((partsVolume/measured.meshVolumeM3).toFixed(4)):undefined
  const pointMetadata:{sourceKind?:'point_cloud';pointCloud?:Record<string,unknown>;sampledSurfaceAreaM2?:number}=g.kind==='point_cloud'?{sourceKind:'point_cloud',pointCloud:item.result!.pointCloud}:g.sourceKind==='point_cloud'?{sourceKind:'point_cloud',pointCloud:g.pointCloud,sampledSurfaceAreaM2:item.surfaceAreaM2}:{}
  outputs.push({node:g.node,selected,hullSafe:item.hullSafe,...pointMetadata,...item.routeReason?{routeReason:item.routeReason}:{},...volumeRatio!==undefined?{volumeRatio}:{},...consumerNotice?{consumerNotice}:{},...item.primitive?{primitive:item.primitive}:{},...bounds?{bounds}:{},parts,...boxes?{boxes}:{},...decomposition?{decomposition}:{},material,materialProperties:properties,...volume,...surfaceMode&&g.kind!=='point_cloud'&&g.sourceKind!=='point_cloud'?{surfaceAreaM2:item.surfaceAreaM2}:{},watertight:g.watertight,...mass??{massKg:null,massReason:g.kind==='point_cloud'||g.sourceKind==='point_cloud'?'点云只有测得采样位置，不能据此计算实际质量':measured?'源网格不封闭，不能把有向三角体积当成实际质量':'表面几何无封闭体积，不能据此计算质量'}})
 }
 const prunedParts=await pruneUnreferencedParts(input.outputDirectory,prepared.map(item=>({node:item.g.node,selected:item.selected,target:item.target})),raw,coacdRaw)
 options.signal?.throwIfAborted()
 const geometryTransport={...geometry.transport,readBytes:geometry.transport.readBytes+(coacdGeometry?.transport.readBytes??0),verified:geometry.transport.verified&&(!coacdGeometry||coacdGeometry.transport.verified),compute:{totalVoxelTiles,totalVoxelSamples,totalVoxelBoxes:globalVoxelBoxes,maxTotalTiles:input.maxTiles??4096,maxTotalSamples:1_000_000_000}}
 const result={sourcePath:raw.sourcePath??input.sourcePath,sourcePreserved:raw.sourcePreserved,units:'m',upAxis:'Z',strategy,objects:outputs,prunedParts,geometryTransport}
 const target=join(input.outputDirectory,'physicalization.json')
 let text=JSON.stringify(result,null,2)
 if(input.pointCloudTiling){
  let existing=0;for(const name of await readdir(input.outputDirectory)){const path=join(input.outputDirectory,name);const item=await stat(path);if(item.isFile()&&path!==target)existing+=item.size}
  for(let attempt=0;attempt<3;attempt++){
   const bytes=existing+Buffer.byteLength(text)
   if(bytes>input.pointCloudTiling.maxDiskBytes)throw new Error(`POINT_CLOUD_SURFACE_DISK_BUDGET: 最终physicalization清单使总产物${bytes}B超过maxDiskBytes=${input.pointCloudTiling.maxDiskBytes}`,{cause:{stage:'physicalization-manifest',requiredDiskBytes:bytes,maxDiskBytes:input.pointCloudTiling.maxDiskBytes,coverageComplete:false}})
   Object.assign(geometryTransport,{outputDiskBytes:bytes});text=JSON.stringify(result,null,2)
  }
 }
 await writeFile(target,text);return result
 }finally{await compute?.close()}
}
