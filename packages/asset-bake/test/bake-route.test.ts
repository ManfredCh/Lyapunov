/**
 * 126 收口：`asset_bake` 的公开分流（低层 bake.py / 高层 physicalize）唯一判定。
 *
 * 背景：plugin.ts 原来是 `request.strategy?physicalize(...):execute(...)`——只给 `usage:'environment'`、
 * 不给 strategy/method 的正常默认请求直接走低层基础几何导出：不逐节点改派、没有回执字段，水密凹实体会被
 * 引擎按凸包消费（门洞/房间在消费后消失），而工具描述当时已经写着"usage=environment 时缺省与显式auto同义"——
 * 公开契约没闭合。现在这条默认请求补上 `strategy:'auto'` 后与显式 auto 走**完全同一条**高层路线。
 *
 * 真实工具入口（ToolRegistry + 公开的 asset_bake，真实 portal GLB + 真实算法）三种请求的读数见
 * `126_asset_bake_default_route/acceptance/out/tool-default-route-acceptance.json`
 * （脚本 `moved/tool-default-route-acceptance.mjs`）；这里只钉判定表本身。
 */
import { describe, expect, test } from "bun:test"
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import { resolveBakeRoute, runProvider } from "../src/operations.ts"
import { readGeometryManifest, GEOMETRY_LIMITS } from '../src/geometry-data.ts'
import { createHash } from 'node:crypto'
import { decomposeConcaveToBoxesDetailed,mergeLatticeBoxes } from '../src/geometry/voxel-decompose.ts'
import { GeometryComputeSession } from '../src/geometry-compute.ts'
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'

describe("asset_bake 分流判定", () => {
  test("显式 strategy（含 auto）走高层 physicalize，不补写任何字段", () => {
    expect(resolveBakeRoute({ strategy: "auto", usage: "environment" })).toEqual({ physicalize: true })
    expect(resolveBakeRoute({ strategy: "coacd" })).toEqual({ physicalize: true })
    expect(resolveBakeRoute({ strategy: "voxel_boxes", usage: "environment" })).toEqual({ physicalize: true })
  })

  test("只给 usage=environment（没有 method/strategy）→ 高层默认路线，补 strategy:'auto'", () => {
    expect(resolveBakeRoute({ usage: "environment" })).toEqual({ physicalize: true, injectStrategy: "auto" })
    expect(resolveBakeRoute({ usage: "environment", sourcePath: "/tmp/a.glb", outputDirectory: "/tmp/out" })).toEqual({ physicalize: true, injectStrategy: "auto" })
  })

  test("显式 method → 低层基础几何导出，按该 method 原样（不补策略、不升级成自动分解）", () => {
    expect(resolveBakeRoute({ method: "triangle_mesh", usage: "environment" })).toEqual({ physicalize: false })
    expect(resolveBakeRoute({ method: "coacd", usage: "environment" })).toEqual({ physicalize: false })
    expect(resolveBakeRoute({ method: "triangle_mesh" })).toEqual({ physicalize: false })
  })

  test("method 与 strategy 同时给 → strategy 优先（既有优先级不变）", () => {
    expect(resolveBakeRoute({ method: "triangle_mesh", strategy: "voxel_boxes", usage: "environment" })).toEqual({ physicalize: true })
  })

  test("没有用途、没有 strategy/method → 低层默认（既有基础几何导出行为不变）", () => {
    expect(resolveBakeRoute({ sourcePath: "/tmp/a.glb", outputDirectory: "/tmp/out" })).toEqual({ physicalize: false })
    expect(resolveBakeRoute({ usage: "dynamic" })).toEqual({ physicalize: false })
    expect(resolveBakeRoute({ usage: "static", method: "convex_hull" })).toEqual({ physicalize: false })
  })
})

test('A07 几何依赖终态保留阶段与结构化原因，不混成 SDK/PhysX 请求错误',async()=>{
  const root=mkdtempSync(join(tmpdir(),'bake-dependency-receipt-')),worker=join(root,'bake.py')
  // 独立协议进程替身：只发既有 stdout 错误回执，不加载 SDK、几何或原件。
  writeFileSync(worker,`import json,sys\nprint(json.dumps({'error':'ASSET_BAKE_DEPENDENCY_UNAVAILABLE','message':'缺少 trimesh','details':{'stage':'geometry-dependencies','missing':['trimesh']}}))\nsys.exit(2)\n`)
  try{
    const error=await runProvider({}, {python:'/usr/bin/python3',workerPath:worker}).catch((failure:Error)=>failure)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('ASSET_BAKE_DEPENDENCY_UNAVAILABLE:')
    expect(error.message).toContain('geometry-dependencies')
    expect(error.cause).toEqual({stage:'geometry-dependencies',missing:['trimesh']})
  }finally{rmSync(root,{recursive:true,force:true})}
})

async function withBinaryGeometry(body:(root:string,path:string,manifest:any)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'geometry-transport-'))
 try{
  const sourcePath=join(root,'source.glb');await writeFile(sourcePath,'独立来源夹具')
  const bytes=[Buffer.from(new Float64Array([0,0,0,1,0,0,0,1,0]).buffer),Buffer.from(new Uint32Array([0,1,2]).buffer)]
  const arrays=[]
  for(const [i,value] of bytes.entries()){
   const path=join(root,`array-${i}.bin`);await writeFile(path,value)
   arrays.push({path,dtype:i?'u32le':'f64le',count:value.length/(i?4:8),bytes:value.length,sha256:createHash('sha256').update(value).digest('hex')})
  }
  const manifest={schema:'lyapunov.geometry.v2',version:2,sourcePath,sourceFrame:{pose:'reference',sourceUpAxis:'Y',metersPerUnit:1,derivedUnits:'m',derivedUpAxis:'Z',animation:{clips:3,evaluated:false,skinApplied:false}},limits:GEOMETRY_LIMITS,nodes:[{node:'单面',kind:'mesh',watertight:false,position:arrays[0],index:arrays[1]}]}
  const path=join(root,'geometry.json');await writeFile(path,JSON.stringify(manifest));await body(root,path,manifest)
 }finally{await rm(root,{recursive:true,force:true})}
}

test('A08 二进制几何实际内容读回；未校完不声明 verified，读字节数来自文件',async()=>{
 await withBinaryGeometry(async(root,path,manifest)=>{
  const geometry=await readGeometryManifest(path,{outputDirectory:root,sourcePath:manifest.sourcePath})
  expect(geometry.transport.verified).toBe(false)
  const {vertices,faces}=await geometry.load(geometry.nodes[0]!)
  expect([...vertices]).toEqual([0,0,0,1,0,0,0,1,0]);expect([...faces]).toEqual([0,1,2])
  expect(geometry.transport).toMatchObject({verified:true,nodeCount:1,readBytes:84,sourceFrame:{animation:{clips:3,evaluated:false}}})
  expect((await readFile(path,'utf8')).includes('"vertices"')).toBe(false)
 })
})

test('A08 二进制内容被换、字节被截断与真实索引越界，均拒绝继续物理化',async()=>{
 await withBinaryGeometry(async(root,path,manifest)=>{
  const spec=manifest.nodes[0].index
  await writeFile(spec.path,Buffer.from(new Uint32Array([0,1,999]).buffer))
  let geometry=await readGeometryManifest(path,{outputDirectory:root,sourcePath:manifest.sourcePath})
  await expect(geometry.load(geometry.nodes[0]!)).rejects.toThrow('hash 不符')
  spec.sha256=createHash('sha256').update(await readFile(spec.path)).digest('hex');await writeFile(path,JSON.stringify(manifest))
  geometry=await readGeometryManifest(path,{outputDirectory:root,sourcePath:manifest.sourcePath})
  await expect(geometry.load(geometry.nodes[0]!)).rejects.toThrow('索引超过')
  await truncate(spec.path,4)
  await expect(geometry.load(geometry.nodes[0]!)).rejects.toThrow('实际字节数不符')
 })
})

test('A08 输出别名越界和源帧单位不符不能成为同版本几何',async()=>{
 await withBinaryGeometry(async(root,path,manifest)=>{
  const outer=join(root,'..',`outside-${process.pid}-${Date.now()}.bin`)
  try{
   await writeFile(outer,await readFile(manifest.nodes[0].index.path));manifest.nodes[0].index.path=outer;await writeFile(path,JSON.stringify(manifest))
   const geometry=await readGeometryManifest(path,{outputDirectory:root,sourcePath:manifest.sourcePath})
   await expect(geometry.load(geometry.nodes[0]!)).rejects.toThrow('outputDirectory 内')
   manifest.sourceFrame.metersPerUnit=1000;await writeFile(path,JSON.stringify(manifest))
   await expect(readGeometryManifest(path,{outputDirectory:root,sourcePath:manifest.sourcePath})).rejects.toThrow('单位/轴/动画身份不符')
  }finally{await rm(outer,{force:true})}
 })
})

test('A08 巨型旧 JSON 与超节点二进制预算在读取/分配前明确拒绝',async()=>{
 await withBinaryGeometry(async(root,path,manifest)=>{
  manifest.nodes[0].position.bytes=GEOMETRY_LIMITS.maxNodeBytes;manifest.nodes[0].position.count=GEOMETRY_LIMITS.maxNodeBytes/8
  await writeFile(path,JSON.stringify(manifest))
  const geometry=await readGeometryManifest(path,{outputDirectory:root,sourcePath:manifest.sourcePath})
  await expect(geometry.load(geometry.nodes[0]!)).rejects.toThrow('GEOMETRY_NODE_BUDGET_EXCEEDED')
  await truncate(path,GEOMETRY_LIMITS.maxManifestBytes+1)
  await expect(readGeometryManifest(path,{outputDirectory:root,sourcePath:manifest.sourcePath})).rejects.toThrow('GEOMETRY_MANIFEST_BUDGET_EXCEEDED')
 })
})

test('A08 旧粗点云清单不能绕过默认精度守卫，显式精度必须与真实产物匹配',async()=>{
 await withBinaryGeometry(async(root,path,manifest)=>{
  manifest.nodes=[{node:'point-cloud',kind:'point_cloud',watertight:false,decomposition:{boxes:[{center:[0,0,0],halfExtents:[14,14,14]}],voxelSizeM:28,pointCloud:{explicitVoxelSize:false}}}]
  await writeFile(path,JSON.stringify(manifest))
  let geometry=await readGeometryManifest(path,{outputDirectory:root,sourcePath:manifest.sourcePath})
  await expect(geometry.load(geometry.nodes[0]!)).rejects.toThrow('POINT_CLOUD_PRECISION_REQUIRED')
  geometry=await readGeometryManifest(path,{outputDirectory:root,sourcePath:manifest.sourcePath,voxelSizeM:.1})
  await expect(geometry.load(geometry.nodes[0]!)).rejects.toThrow('本次显式 voxelSizeM 不符')
  expect(geometry.transport.verified).toBe(false)
 })
})

test('A08 取消已开始的真实 worker；超额结果输出明确失败不累计无界字符串',async()=>{
 const root=mkdtempSync(join(tmpdir(),'bake-bounded-worker-')),worker=join(root,'worker.py')
 try{
  writeFileSync(worker,'import time\ntime.sleep(30)\n')
  const controller=new AbortController();const promise=runProvider({}, {python:'/usr/bin/python3',workerPath:worker,signal:controller.signal});const timer=setTimeout(()=>controller.abort(),50)
  try{await expect(promise).rejects.toThrow('abort')}finally{clearTimeout(timer)}
  writeFileSync(worker,"import sys\nfor _ in range(20):\n sys.stdout.write('x'*1024*1024);sys.stdout.flush()\n")
  await expect(runProvider({}, {python:'/usr/bin/python3',workerPath:worker})).rejects.toThrow('GEOMETRY_RESULT_BUDGET_EXCEEDED')
 }finally{rmSync(root,{recursive:true,force:true})}
})

function ringGeometry(){
 const v:number[]=[],f:number[]=[]
 const quad=(x0:number,y0:number,x1:number,y1:number)=>{const offset=v.length/3;v.push(x0,y0,0,x1,y0,0,x1,y1,0,x0,y1,0);f.push(offset,offset+1,offset+2,offset,offset+2,offset+3)}
 quad(0,0,3,1);quad(0,2,3,3);quad(0,1,1,2);quad(2,1,3,2)
 return{vertices:new Float64Array(v),faces:new Uint32Array(f)}
}
test('F1 固定晶格分块/整数合并真实880cells等价，环孔保留且自动精度不因内存粗化',()=>{
 const {vertices,faces}=ringGeometry(),single=decomposeConcaveToBoxesDetailed(vertices,faces,{fillInterior:false,voxelSizeM:.1,maxBoxes:2048}),tiled=decomposeConcaveToBoxesDetailed(vertices,faces,{fillInterior:false,voxelSizeM:.1,maxGridCells:256,maxBoxes:2048})
 expect(single.status).toBe('ok');expect(tiled.status).toBe('ok');if(single.status!=='ok'||tiled.status!=='ok')return
 const cells=(result:typeof single.result)=>{const out=new Set<string>();for(const box of result.boxes){const lo=box.center.map((v,i)=>Math.round((v-box.halfExtents[i]+.1)/.1)),hi=box.center.map((v,i)=>Math.round((v+box.halfExtents[i]+.1)/.1));for(let x=lo[0];x<hi[0];x++)for(let y=lo[1];y<hi[1];y++)for(let z=lo[2];z<hi[2];z++)out.add(`${x},${y},${z}`)}return out}
 const a=cells(single.result),b=cells(tiled.result);expect(a.size).toBe(880);expect(b.size).toBe(880);expect([...a].every(key=>b.has(key))).toBe(true)
 expect(tiled.diagnostics.boxesBeforeMerge).toBe(20);expect(tiled.diagnostics.boxesAfterMerge).toBe(7);expect(tiled.result.boxes.some(box=>[1.5,1.5,0].every((v,i)=>Math.abs(v-box.center[i])<=box.halfExtents[i]))).toBe(false)
 const auto=decomposeConcaveToBoxesDetailed(vertices,faces,{fillInterior:false,maxGridCells:20000,maxBoxes:2048});expect(auto.status).toBe('ok');expect(auto.diagnostics.effectiveVoxelSizeM).toBe(.03)
 const noAir=mergeLatticeBoxes([{min:[0,0,0],max:[1,1,1]},{min:[2,0,0],max:[3,1,1]},{min:[3,0,0],max:[4,2,1]}]);expect(noAir).toHaveLength(3)
})
test('F1 公开分解reason区分最终box、tile、sample、working memory预算',()=>{
 const {vertices,faces}=ringGeometry()
 const box=decomposeConcaveToBoxesDetailed(vertices,faces,{fillInterior:false,voxelSizeM:.1,maxGridCells:256,maxBoxes:6});expect(box.status).toBe('failed');if(box.status==='failed'){expect(box.reason).toBe('BOX_BUDGET');expect(box.diagnostics.requiredBoxesAtLeast).toBe(7)}
 for(const [options,reason]of [[{maxTiles:1},'TILE_WORK_BUDGET'],[{maxSamples:1},'SAMPLE_WORK_BUDGET'],[{maxWorkingBytes:1},'WORKING_MEMORY_BUDGET']] as const){
  const detail=decomposeConcaveToBoxesDetailed(vertices,faces,{fillInterior:false,voxelSizeM:.1,maxGridCells:256,...options});expect(detail.status).toBe('failed');if(detail.status==='failed')expect(detail.reason).toBe(reason)
 }
})
test('F1 真实计算线程工作时父心跳/进度可运行，abort结束计算且输入数组不被夺走',async()=>{
 const vertices=new Float64Array([0,0,0,100,0,0,0,100,0]),faces=new Uint32Array([0,1,2]),controller=new AbortController();let ticks=0,sawProgress=false,timer:ReturnType<typeof setTimeout>|undefined
 const heartbeat=setInterval(()=>ticks++,5)
 const session=new GeometryComputeSession({signal:controller.signal,onProgress:message=>{if(message.facts.stage==='raster-face'&&!sawProgress){sawProgress=true;timer=setTimeout(()=>controller.abort(),40)}}})
 try{await expect(session.voxel(vertices,faces,{fillInterior:false,voxelSizeM:.03,maxGridCells:220000,maxSamples:100000000},'实际大三角面')).rejects.toThrow('取消');expect(sawProgress).toBe(true);expect(ticks).toBeGreaterThan(1);expect(vertices.length).toBe(9);expect(faces.length).toBe(3)}finally{clearInterval(heartbeat);if(timer)clearTimeout(timer);await session.close()}
},10000)
