/**
 * 97 收口：派生收尾清理的**所有权**（真实 provider，不 mock）。
 *
 * 背景：`pruneUnreferencedParts` 曾经 readdir 整个 outputDirectory、再按文件名（`part-*.obj`）与
 * 扩展名（材质/贴图）认定归属——而 `asset_bake` 允许调用方自选 outputDirectory，通用 physicalize
 * 出口这么删就会动到调用方原有的文件（评审探针：临时目录里预存 reference.png 与 part-99.obj，
 * 真实派生后两个都被删）。现在的口径只有一条：**本次写出的文件 = provider 逐次返回的 parts[].path
 * + 本次自己写出的 target**，且必须落在本次 outputDirectory 里；不按名字/扩展名推断，不清已有文件。
 *
 * 本文件用真实 trimesh 子进程跑两种落法：
 *  1. voxel_boxes：原始扫描件被体素盒组替换 → 本次自己的 part-0-0.obj 是纯临时物，清掉；
 *     调用方预存的 reference.png / part-99.obj 一字不动。
 *  2. triangle_mesh：扫描件就是产物 → 什么都不清。
 * 需要 LYAPUNOV_ALGORITHM_PYTHON 指向带 trimesh 的解释器；没有就整组跳过（跳过不等于通过）。
 */
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { physicalize } from "../src/physicalize.ts"
import { runProvider } from '../src/operations.ts'
import { readGeometryManifest } from '../src/geometry-data.ts'
import { box, solidGlb, split } from '../../scene-kit/test/glb-geometry-fixture.ts'

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

/** 最小真实 GLB：单节点、无索引三角面（POSITION accessor 带 min/max）。 */
function boxGLB(name: string, min: V3, max: V3): Buffer {
  const triangles = boxTriangles(min, max)
  const blob = Buffer.alloc(triangles.length * 12)
  triangles.forEach((point, vertex) => { for (let axis = 0; axis < 3; axis++) blob.writeFloatLE(point[axis]!, vertex * 12 + axis * 4) })
  const json = Buffer.from(JSON.stringify({
    asset: { version: "2.0", generator: "97-prune-ownership" }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name, mesh: 0 }], meshes: [{ name, primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
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

/** 真 u16 INDEX 的 primitive，后一件节点内偏移超过 65535；不靠巨型原件构造反例。 */
function primitiveOffsetGLB():Buffer{
 const count=65540,first=Buffer.alloc(count*12),second=Buffer.alloc(36),indices=Buffer.alloc(6)
 const triangle=[[0,0,0],[1,0,0],[0,1,0]]
 for(let i=0;i<3;i++){for(let axis=0;axis<3;axis++){first.writeFloatLE(triangle[i]![axis]!,i*12+axis*4);second.writeFloatLE(axis===2?1:triangle[i]![axis]!,i*12+axis*4)}indices.writeUInt16LE(i,i*2)}
 const padding=Buffer.alloc(2),blob=Buffer.concat([first,second,indices,padding,indices,padding])
 const firstIndex=first.length+second.length
 const json=Buffer.from(JSON.stringify({asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{name:'material-split',mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0},indices:1},{attributes:{POSITION:2},indices:3}]}],buffers:[{byteLength:blob.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:first.length},{buffer:0,byteOffset:firstIndex,byteLength:6},{buffer:0,byteOffset:first.length,byteLength:second.length},{buffer:0,byteOffset:firstIndex+8,byteLength:6}],accessors:[{bufferView:0,componentType:5126,type:'VEC3',count},{bufferView:1,componentType:5123,type:'SCALAR',count:3},{bufferView:2,componentType:5126,type:'VEC3',count:3},{bufferView:3,componentType:5123,type:'SCALAR',count:3}]}))
 const text=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]),header=Buffer.alloc(12),jh=Buffer.alloc(8),bh=Buffer.alloc(8)
 header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+text.length+blob.length,8);jh.writeUInt32LE(text.length);jh.write('JSON',4);bh.writeUInt32LE(blob.length);bh.write('BIN\0',4)
 return Buffer.concat([header,jh,text,bh,blob])
}

const SENTINELS = { "reference.png": "root-owned-test-image-sentinel", "part-99.obj": "root-owned-test-mesh-sentinel" }

/** 调用方自选目录 + 预存文件：派生只许动本次写出的东西。 */
async function withCallerDirectory<T>(fixture: Buffer, body: (directory: string, sourcePath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "physicalize-ownership-"))
  try {
    for (const [name, content] of Object.entries(SENTINELS)) await writeFile(join(directory, name), content)
    const sourcePath = join(directory, "source_box.glb")
    await writeFile(sourcePath, fixture)
    return await body(directory, sourcePath)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

const readOrNull = async (path: string) => { try { return await readFile(path, "utf8") } catch { return null } }

withProvider("派生收尾清理的所有权", () => {
  test('A08 maxBoxes 是所有节点总预算，不能每节点重新领取完整额度',async()=>{
    const plane={positions:[[0,0,0],[.2,0,0],[.2,.2,0],[0,.2,0]] as V3[],triangles:[[0,1,2],[0,2,3]] as V3[]}
    const fixture=solidGlb({generator:'A08-global-box-budget',nodes:[{name:'one',mesh:plane},{name:'two',mesh:plane,translation:[1,0,0]}]})
    await withCallerDirectory(fixture,async(directory,sourcePath)=>{
      const input={sourcePath,outputDirectory:directory,sourceUpAxis:'Z' as const,usage:'environment' as const,strategy:'voxel_boxes' as const,voxelSizeM:.1}
      await expect(physicalize({...input,maxBoxes:1},{python:provider})).rejects.toThrow('VOXEL_GLOBAL_BOX_BUDGET_EXCEEDED')
      const result=await physicalize({...input,maxBoxes:2},{python:provider})
      expect(result.objects).toHaveLength(2);expect(result.objects.reduce((n,item)=>n+(item.boxes as unknown[]).length,0)).toBe(2)
    })
  })
  test('A08 实际 worker 另一份有效源回执不能冒成本次请求的派生',async()=>{
    await withCallerDirectory(boxGLB('source-a',[-.5,-.5,0],[.5,.5,1]),async(directory,sourcePath)=>{
      const raw=await runProvider({sourcePath,outputDirectory:directory,sourceUpAxis:'Z',method:'triangle_mesh'},{python:provider})
      const another=join(directory,'source-b.glb');await writeFile(another,boxGLB('source-b',[0,0,0],[2,2,2]))
      await expect(physicalize({sourcePath:another,outputDirectory:directory,sourceUpAxis:'Z',strategy:'triangle_mesh'},{execute:async()=>raw})).rejects.toThrow('worker 源文件与本次请求不符')
    })
  })
  test('A08 实际 u16 INDEX 在跨材质偏移超过 65535 后仍是两个独立真实三角面',async()=>{
    await withCallerDirectory(primitiveOffsetGLB(),async(directory,sourcePath)=>{
      const raw=await runProvider({sourcePath,outputDirectory:directory,sourceUpAxis:'Z',method:'triangle_mesh'},{python:provider})
      const geometry=await readGeometryManifest(raw.geometryDataPath,{outputDirectory:directory,sourcePath,sourceUpAxis:'Z'})
      const {vertices,faces}=await geometry.load(geometry.nodes[0]!)
      expect(faces.length).toBe(6)
      expect([0,3].map(start=>[...faces.slice(start,start+3)].map(i=>vertices[i*3+2]))).toEqual([[0,0,0],[1,1,1]])
      expect(raw.diagnostics.sourceReads.observedMaxReadBytes).toBeLessThanOrEqual(8*1024*1024)
    })
  })
  test('A08 实际 GLB 多 primitive、完整父变换、负尺度、轴和单位通过二进制交接',async()=>{
    const fixture=solidGlb({generator:'A08-binary-reference',nodes:[{name:'parent',translation:[1,2,3],scale:[2,3,4],children:[1]},{name:'shape',mesh:split(box(),3),scale:[-1,1,1]}],roots:[0]})
    await withCallerDirectory(fixture,async(directory,sourcePath)=>{
      const raw=await runProvider({sourcePath,outputDirectory:directory,sourceUpAxis:'Y',metersPerUnit:.5,method:'triangle_mesh'},{python:provider})
      const geometry=await readGeometryManifest(raw.geometryDataPath,{outputDirectory:directory,sourcePath,sourceUpAxis:'Y',metersPerUnit:.5})
      const node=geometry.nodes[0]!,loaded=await geometry.load(node)
      expect(node.sourceNodeIndex).toBe(1);expect(node.sourceMeshIndex).toBe(0);expect(node.sourceWorldMatrix).toHaveLength(16)
      expect(loaded.vertices.length/3).toBe(8);expect(loaded.faces.length/3).toBe(12);expect(node.watertight).toBe(true)
      const bounds=[0,1,2].map(axis=>{const values=[...loaded.vertices].filter((_,i)=>i%3===axis);return[Math.min(...values),Math.max(...values)]})
      expect(bounds[0]![0]).toBeCloseTo(-.5,10);expect(bounds[0]![1]).toBeCloseTo(.5,10)
      expect(bounds[1]![0]).toBeCloseTo(-3.5,10);expect(bounds[1]![1]).toBeCloseTo(-1.5,10)
      expect(bounds[2]![0]).toBeCloseTo(1,10);expect(bounds[2]![1]).toBeCloseTo(2.5,10)
      expect(geometry.transport.verified).toBe(true)
    })
  })

  test('A08 sparse POSITION 的实际顶点被应用，截断原件报告真实失败',async()=>{
    const fixture=solidGlb({generator:'A08-sparse-reference',nodes:[{name:'shape',mesh:box(),sparse:{vertex:0,offset:[-.25,0,0]}}]})
    await withCallerDirectory(fixture,async(directory,sourcePath)=>{
      const result=await physicalize({sourcePath,outputDirectory:directory,sourceUpAxis:'Z',strategy:'triangle_mesh'},{python:provider})
      expect(result.objects[0]!.bounds!.min[0]).toBeCloseTo(-.25,10)
      expect(result.geometryTransport).toMatchObject({schema:'lyapunov.geometry.v2',verified:true,nodeCount:1})
      await writeFile(sourcePath,fixture.subarray(0,fixture.length-8))
      await expect(runProvider({sourcePath,outputDirectory:directory,sourceUpAxis:'Z',method:'triangle_mesh'},{python:provider})).rejects.toThrow('INVALID_GLB_HEADER')
    })
  })

  test("voxel_boxes：只清本次自己的无引用扫描件，调用方预存的 reference.png/part-99.obj 原样保留", async () => {
    const fixture = boxGLB("prune_box", [-0.5, -0.5, 0], [0.5, 0.5, 1])
    await withCallerDirectory(fixture, async (directory, sourcePath) => {
      const result = await physicalize({
        sourcePath, outputDirectory: directory, sourceUpAxis: "Z", metersPerUnit: 1,
        strategy: "voxel_boxes", usage: "environment", voxelSizeM: 0.5,
      }, { python: provider })
      // 本次自己的原始扫描件被体素盒组替换 → 无引用者 → 清掉（这是真实生命周期记录）。
      expect(result.prunedParts).toEqual(["part-0-0.obj"])
      expect(existsSync(join(directory, "part-0-0.obj"))).toBe(false)
      expect(existsSync(join(directory, "voxel-0.json"))).toBe(true)
      // 调用方原有文件：既不“被拥有”也不“被删除”。
      for (const [name, content] of Object.entries(SENTINELS)) {
        expect(result.prunedParts).not.toContain(name)
        expect(await readOrNull(join(directory, name))).toBe(content)
      }
      // 目录里没有 extension/名字推断留下的残渣：本次只是没动它们。
      expect((result.objects[0] as { parts: string[] }).parts.every(part => existsSync(part))).toBe(true)
    })
  })

  test("triangle_mesh：扫描件就是产物，什么都不清，预存文件同样原样保留", async () => {
    const fixture = boxGLB("keep_box", [-0.5, -0.5, 0], [0.5, 0.5, 1])
    await withCallerDirectory(fixture, async (directory, sourcePath) => {
      const result = await physicalize({
        sourcePath, outputDirectory: directory, sourceUpAxis: "Z", metersPerUnit: 1,
        strategy: "triangle_mesh", usage: "environment",
      }, { python: provider })
      expect(result.prunedParts).toEqual([])
      expect(existsSync(join(directory, "part-0-0.obj"))).toBe(true)
      for (const [name, content] of Object.entries(SENTINELS)) expect(await readOrNull(join(directory, name))).toBe(content)
    })
  })
})
