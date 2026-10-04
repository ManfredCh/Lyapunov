/**
 * 122 收口：环境派生里"**显式** `strategy:'auto'`"必须与"**省略**策略"走同一条逐节点默认路线。
 *
 * 背景（评审探针 `root-97-explicit-auto-probe.ts`）：`physicalize({strategy:'auto',usage:'environment'})`
 * 在进默认逻辑之前就被策略白名单拒了——`environmentDefault` 判的是 `requested==='auto'`，可白名单只列了
 * `triangle_mesh/voxel_boxes/coacd`，auto 还没走到那一步就抛错。scene-kit 内部把 auto 折算成"省略"，
 * 所以那条路径一直能跑，掩盖了**公开的 asset_bake/physicalize 自己声明 auto 可用**这件事没兑现。
 *
 * 本文件用真实 trimesh 子进程证明三件事（都用同一间"连通凹"房间夹具）：
 *  1. 显式 auto 与省略策略：逐节点选型/改派原因/件数一致，产物文件名一致；
 *  2. 显式 auto 不会被环境默认路线悄悄改写成别的请求策略，也不会走环境的 SDF 兜底
 *     （用 `sdfAutoParts:1` 把阈值压到必然触发，环境里仍必须是未填充表面盒）；
 *  3. `convex_hull`/`sdf` 这类环境明确禁用的策略，照旧被拒绝。
 * 需要 LYAPUNOV_ALGORITHM_PYTHON 指向带 trimesh 的解释器；没有就整组跳过（跳过不等于通过）。
 */
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { physicalize, type PhysicalizeInput } from "../src/physicalize.ts"

const provider = process.env.LYAPUNOV_ALGORITHM_PYTHON
const withProvider = provider ? describe : describe.skip

type V3 = [number, number, number]

/** 一块 AABB 的 12 个外向绕序三角面。 */
function boxTriangles(min: V3, max: V3): V3[] {
  const [x0, y0, z0] = min, [x1, y1, z1] = max
  const v: V3[] = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
  const out: V3[] = []
  for (const [a, b, c, d] of quads) out.push(v[a!]!, v[b!]!, v[c!]!, v[a!]!, v[c!]!, v[d!]!)
  return out
}

/** 房间（**连通凹实体**）：外墙盒 + 内腔盒（内腔绕序反向 → 同一张封闭曲面里挖出一个空腔）。
 *  凸包会把整间房补成实心 —— 正是"环境默认不能让引擎按凸包消费"的那种形状；
 *  两块盒面彼此不相交、也不共用顶点（内腔严格在外墙内），所以曲面水密、缠绕一致。 */
function roomTriangles(): V3[] {
  const flip = (triangles: V3[]): V3[] => {
    const reversed: V3[] = []
    for (let index = 0; index < triangles.length; index += 3) reversed.push(triangles[index]!, triangles[index + 2]!, triangles[index + 1]!)
    return reversed
  }
  return [...boxTriangles([-2, -2, 0], [2, 2, 3]), ...flip(boxTriangles([-1.5, -1.5, 0.2], [1.5, 1.5, 2.8]))]
}

function meshGLB(name: string, triangles: V3[]): Buffer {
  const blob = Buffer.alloc(triangles.length * 12)
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity]
  triangles.forEach((point, vertex) => {
    for (let axis = 0; axis < 3; axis++) {
      blob.writeFloatLE(point[axis]!, vertex * 12 + axis * 4)
      min[axis] = Math.min(min[axis]!, point[axis]!)
      max[axis] = Math.max(max[axis]!, point[axis]!)
    }
  })
  const json = Buffer.from(JSON.stringify({
    asset: { version: "2.0", generator: "122-environment-auto" }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name, mesh: 0 }], meshes: [{ name: "portal", primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: triangles.length, type: "VEC3", min, max }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: blob.length }], buffers: [{ byteLength: blob.length }],
  }), "utf8")
  const pad = (buffer: Buffer, filler: number) => buffer.length % 4 ? Buffer.concat([buffer, Buffer.alloc(4 - buffer.length % 4, filler)]) : buffer
  const jsonPadded = pad(json, 0x20), binPadded = pad(blob, 0)
  const header = Buffer.alloc(12)
  header.write("glTF", 0, "ascii"); header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binPadded.length, 8)
  const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(jsonPadded.length, 0); jsonHeader.write("JSON", 4, "ascii")
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binPadded.length, 0); binHeader.write("BIN\0", 4, "ascii")
  return Buffer.concat([header, jsonHeader, jsonPadded, binHeader, binPadded])
}

/** 每次调用用独立目录（避免上一次的产物混进本次读数），并且不删调用方任何东西。 */
async function derive(input: Omit<PhysicalizeInput, "sourcePath" | "outputDirectory">): Promise<{ result: Awaited<ReturnType<typeof physicalize>>; files: string[]; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "physicalize-env-auto-"))
  try {
    const sourcePath = join(directory, "portal.glb")
    await writeFile(sourcePath, meshGLB("room", roomTriangles()))
    const result = await physicalize({ sourcePath, outputDirectory: directory, sourceUpAxis: "Z", metersPerUnit: 1, ...input }, { python: provider })
    return { result, files: (await readdir(directory)).sort(), directory }
  } finally { /* 目录留给断言读；用毕由调用方 rm */ }
}

withProvider("环境派生的显式 auto 与省略策略", () => {
  test('默认密集静态表面改用真实原三角；明确精度/预算仍执行体素硬限',async()=>{
    const triangles:V3[]=[]
    // 分散的微表面不能合成大盒；中心孔与两侧表面给真实拓扑的正负对照。
    for(let y=0;y<46;y++)for(let x=0;x<46;x++){
      const px=2+x*.1,py=2+y*.1
      triangles.push([px,py,0],[px+.004,py,0],[px,py+.004,0])
    }
    triangles.push([-.9,-.1,0],[-.7,-.1,0],[-.8,.1,0],[.7,-.1,0],[.9,-.1,0],[.8,.1,0])
    // 精确退化面计数必须留账，而非伪称导出了原件中所有 face。
    triangles.push([8,8,0],[8,8,0],[8,8,0])
    const directory=await mkdtemp(join(tmpdir(),'physicalize-native-static-'))
    try{
      const sourcePath=join(directory,'surfaces.glb');await writeFile(sourcePath,meshGLB('dense-surfaces',triangles))
      const input={sourcePath,outputDirectory:join(directory,'auto'),sourceUpAxis:'Z' as const,usage:'environment' as const,strategy:'auto' as const}
      const result=await physicalize(input,{python:provider}),item=result.objects[0]!
      expect(item.selected).toBe('triangle_surface');expect(item.consumerNotice).toBeUndefined()
      expect(item.staticTriangleSurface).toMatchObject({schema:'lyapunov.static-triangle-surface.v1',sourceTriangles:2119,triangles:2118,removedDegenerateTriangles:1,voxelAttempt:{status:'failed',reason:'BOX_BUDGET'}})
      expect(result.geometryTransport.compute.failedVoxelSamples).toBeGreaterThan(0)
      expect(result.geometryTransport.compute.totalVoxelSamples).toBe(result.geometryTransport.compute.failedVoxelSamples)
      expect(result.geometryTransport.compute.totalVoxelTiles).toBe(result.geometryTransport.compute.failedVoxelTiles)
      expect(item.parts).toHaveLength(1);expect(item.boxes).toBeUndefined()
      const obj=await readFile(item.parts[0]!,'utf8'),source=await readFile(sourcePath)
      expect(obj.split('\n').filter(line=>line.startsWith('f '))).toHaveLength(2118)
      expect(obj).toContain('v -0.');expect(result.geometryTransport.verified).toBe(true)
      await expect(physicalize({...input,outputDirectory:join(directory,'fixed'),voxelSizeM:.03},{python:provider})).rejects.toThrow('VOXEL_BOX_BUDGET')
      await expect(physicalize({...input,outputDirectory:join(directory,'limited'),maxBoxes:2048},{python:provider})).rejects.toThrow('VOXEL_BOX_BUDGET')
      expect(await readFile(sourcePath)).toEqual(source)
      expect((await readdir(join(directory,'auto'))).some(name=>name.startsWith('part-'))).toBe(false)
    }finally{await rm(directory,{recursive:true,force:true})}
  },120000)
  test('A08 无体积的平面环仍有孔：缺省实际表面体素保孔，显式三角面如实报告凸化',async()=>{
    const triangles:V3[]=[]
    const quad=(x0:number,y0:number,x1:number,y1:number)=>{const a:V3=[x0,y0,0],b:V3=[x1,y0,0],c:V3=[x1,y1,0],d:V3=[x0,y1,0];triangles.push(a,b,c,a,c,d)}
    quad(-1,-1,1,-.4);quad(-1,.4,1,1);quad(-1,-.4,-.4,.4);quad(.4,-.4,1,.4)
    const directory=await mkdtemp(join(tmpdir(),'physicalize-planar-ring-'))
    try{
      const sourcePath=join(directory,'ring.glb');await writeFile(sourcePath,meshGLB('flat-ring',triangles))
      const result=await physicalize({sourcePath,outputDirectory:directory,sourceUpAxis:'Z',usage:'environment',voxelSizeM:.1,maxBoxes:128},{python:provider})
      const item=result.objects[0]!,boxes=item.boxes as Array<{center:V3;halfExtents:V3}>
      const contains=(point:V3)=>boxes.some(box=>point.every((v,i)=>Math.abs(v-box.center[i]!)<=box.halfExtents[i]!+1e-7))
      expect(item.hullSafe).toBe(false);expect(item.selected).toBe('voxel_boxes')
      expect(contains([0,0,0])).toBe(false);expect(contains([.75,0,0])).toBe(true);expect(item.decomposition!.voxelSizeM).toBe(.1)
      const explicit=await physicalize({sourcePath,outputDirectory:directory,sourceUpAxis:'Z',usage:'environment',strategy:'triangle_mesh'},{python:provider})
      expect(explicit.objects[0]!.hullSafe).toBe(false);expect(explicit.objects[0]!.consumerNotice).toContain('CONSUMER_CONVEXIFIES')
    }finally{await rm(directory,{recursive:true,force:true})}
  })
  test("显式 auto 与省略策略：同一条逐节点默认路线，选型/改派/件数/产物名一致", async () => {
    const explicit = await derive({ strategy: "auto", usage: "environment" })
    const omitted = await derive({ usage: "environment" })
    try {
      // 请求侧回执各自真实：显式 auto 说 auto（asset-bake 自己的执行口径字段），省略则不声明策略。
      expect(explicit.result.strategy).toBe("auto")
      expect(omitted.result.strategy).toBe("triangle_mesh")
      for (const { result } of [explicit, omitted]) {
        // 对真实闭房间检查内部空点与源墙面正点，不只比策略名。
        expect(result.objects).toHaveLength(1)
        const item=result.objects[0]!,boxes=item.boxes as Array<{center:V3;halfExtents:V3}>
        expect(item.selected).toBe("voxel_boxes")
        expect(item.routeReason).toContain("CONCAVE")
        expect(item.decomposition!.fillInterior).toBe(false)
        expect(item.decomposition!.sourceTriangles).toBe(24)
        expect(boxes.some(box=>[0,0,1.5].every((value,axis)=>Math.abs(value-box.center[axis]!)<=box.halfExtents[axis]!))).toBe(false)
        expect(boxes.some(box=>[2,0,1.5].every((value,axis)=>Math.abs(value-box.center[axis]!)<=box.halfExtents[axis]!+1e-8))).toBe(true)
      }
      // 产物落位一致（同一套文件名、同一批盒/件计数），即"走的是同一条路线"的磁盘证据。
      expect(explicit.files).toEqual(omitted.files)
      expect(explicit.result.objects[0]!.parts.length).toBe(omitted.result.objects[0]!.parts.length)
      expect(explicit.result.objects[0]!.selected).toBe(omitted.result.objects[0]!.selected)
    } finally {
      for (const { directory } of [explicit, omitted]) await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

  test("显式 auto 在环境里不走 SDF 兜底（把阈值压到必然触发也不走）", async () => {
    const environment = await derive({ strategy: "auto", usage: "environment", sdfAutoParts: 1 })
    const dynamic = await derive({ strategy: "auto", sdfAutoParts: 1 })
    try {
      // 阈值=1 时 dynamic 的深腔路由会接管（证明这条兜底真的存在）……
      expect(dynamic.result.objects[0]!.selected).toBe("sdf")
      // 环境未标定 SDF；默认直接复用真实未填充表面盒消费链。
      expect(environment.result.objects[0]!.selected).toBe("voxel_boxes")
      expect(environment.result.objects[0]!.decomposition!.fillInterior).toBe(false)
    } finally {
      for (const { directory } of [environment, dynamic]) await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

  test('B1 静态与环境默认同样保留闭房间空区，固定精度不因closed壳填充',async()=>{
    const environment=await derive({usage:'environment',strategy:'auto',voxelSizeM:.1,maxBoxes:256})
    const fixed=await derive({usage:'static',strategy:'auto',voxelSizeM:.1,maxBoxes:256})
    try{
      const env=environment.result.objects[0]!,stat=fixed.result.objects[0]!
      expect(stat.selected).toBe('voxel_boxes');expect(stat.boxes).toEqual(env.boxes)
      expect(stat.decomposition!.voxelSizeM).toBe(.1);expect(stat.decomposition!.fillInterior).toBe(false)
      expect(stat.decomposition!.sourceTriangles).toBe(24)
      const boxes=stat.boxes as Array<{center:V3;halfExtents:V3}>
      expect(boxes.some(box=>[0,0,1.5].every((v,a)=>Math.abs(v-box.center[a]!)<=box.halfExtents[a]!))).toBe(false)
    }finally{for(const item of [environment,fixed])await rm(item.directory,{recursive:true,force:true})}
  })

  test('B1 非凸closed外壳与反向触顶closed内壳：全部源面表面化，空点不依凸半空间包含猜测',async()=>{
    const outline:Array<[number,number]>=[[-1,-1],[1,-1],[1,0],[0,0],[0,1],[-1,1]],triangles:V3[]=[]
    const v=(i:number,z:number):V3=>[...outline[i]!,z]
    for(const [a,b,c]of [[0,1,2],[0,2,3],[0,3,5],[3,4,5]])triangles.push(v(a!,0),v(c!,0),v(b!,0),v(a!,2),v(b!,2),v(c!,2))
    for(let i=0;i<outline.length;i++){const j=(i+1)%outline.length;triangles.push(v(i,0),v(j,0),v(j,2),v(i,0),v(j,2),v(i,2))}
    const inner=boxTriangles([-.8,-.8,.2],[-.2,.8,2])
    for(let i=0;i<inner.length;i+=3)triangles.push(inner[i]!,inner[i+2]!,inner[i+1]!)
    const directory=await mkdtemp(join(tmpdir(),'physicalize-b1-touch-nonconvex-'))
    try{
      const sourcePath=join(directory,'touch.glb');await writeFile(sourcePath,meshGLB('touch-reversed-closed',triangles))
      const result=await physicalize({sourcePath,outputDirectory:directory,sourceUpAxis:'Z',usage:'environment',strategy:'auto',voxelSizeM:.05,maxBoxes:512},{python:provider})
      const item=result.objects[0]!,boxes=item.boxes as Array<{center:V3;halfExtents:V3}>
      const contains=(point:V3)=>boxes.some(box=>point.every((v,a)=>Math.abs(v-box.center[a]!)<=box.halfExtents[a]!+1e-8))
      expect(item.watertight).toBe(true);expect(item.hullSafe).toBe(false);expect(item.selected).toBe('voxel_boxes')
      expect(item.decomposition!.sourceTriangles).toBe(triangles.length/3);expect(item.decomposition!.fillInterior).toBe(false);expect(item.decomposition!.voxelSizeM).toBe(.05)
      expect(contains([-.5,0,1])).toBe(false);expect(contains([.5,.5,1])).toBe(false)
      expect(contains([-1,.2,1])).toBe(true);expect(contains([-.2,0,1])).toBe(true)
    }finally{await rm(directory,{recursive:true,force:true})}
  })

  test("环境明确禁用的策略照旧拒绝（convex_hull / sdf），报错里列出 auto 可用", async () => {
    const directory = await mkdtemp(join(tmpdir(), "physicalize-env-auto-"))
    try {
      const sourcePath = join(directory, "portal.glb")
      await writeFile(sourcePath, meshGLB("room", roomTriangles()))
      for (const strategy of ["convex_hull", "sdf"] as const) {
        const error = await physicalize({ sourcePath, outputDirectory: directory, sourceUpAxis: "Z", metersPerUnit: 1, strategy, usage: "environment" }, { python: provider }).then(() => undefined, (thrown: unknown) => String(thrown))
        expect(error).toBeDefined()
        expect(error).toContain("环境按独立表面/保空腔表示导出")
        expect(error).toContain("auto/triangle_mesh/voxel_boxes/coacd")
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
