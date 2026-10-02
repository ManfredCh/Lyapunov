import { test, expect } from "bun:test"
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { parseAsset } from "../src/formats.ts"
import { SceneOperations } from "../src/operations.ts"

const header=(n:number)=>Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${n}\nproperty uchar red\nproperty float x\nproperty double y\nproperty float z\nproperty float f_dc_0\nproperty float scale_0\nend_header\n`)
test("PLY 跨分块边界按真实属性偏移读取包围盒，保留高斯属性",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ply-test-"))
 try{
  const count=50000,body=Buffer.alloc(count*25)
  for(let i=0;i<count;i++){body.writeFloatLE(i,i*25+1);body.writeDoubleLE(-i,i*25+5);body.writeFloatLE(3,i*25+13)}
  const path=join(root,"test.ply");await writeFile(path,Buffer.concat([header(count),body]))
  const parsed=await parseAsset(path)
  expect(parsed.metadata.vertexCount).toBe(count);expect(parsed.metadata.gaussianProperties).toBe(true)
  expect(parsed.metadata.aabb).toEqual({min:[0,-49999,3],max:[49999,-0,3]})
  const ops=new SceneOperations(join(root,"data"),{productRoot:root}),scene=await ops.create()
  const imported=await ops.import({path,sceneId:scene.sceneId})
  const visual=imported.snapshot!.entities[0]!.components.visual!
  expect(visual.sourcePointCount).toBe(count)
  // 挂载事实保留文件源坐标；Y-up→Z-up 由原来的 sourceTransform 一次完成。
  // Scene 的既有 JSON 规范化把数值等价的 -0 写成 0。
  expect(visual.sourceBounds).toEqual({min:[0,-49999,3],max:[49999,0,3]})
  expect(visual.sourceTransformApplied).toBe(false)
  const transform=visual.sourceTransform as {position:number[];quaternion:number[];scale:number[]}
  expect(transform.position).toEqual([0,0,0]);expect(transform.scale).toEqual([1,1,1])
  expect(transform.quaternion[0]).toBeCloseTo(Math.SQRT1_2);expect(transform.quaternion[3]).toBeCloseTo(Math.SQRT1_2)
 }finally{await rm(root,{recursive:true,force:true})}
})
test("资源流核验的是发送的同一份字节；源文件改动必须拒绝",async()=>{
 const root=await mkdtemp(join(tmpdir(),"resource-stream-test-"))
 try{
  const path=join(root,"test.ply"),body=Buffer.alloc(25);body.writeFloatLE(1,1);body.writeDoubleLE(2,5);body.writeFloatLE(3,13)
  await writeFile(path,Buffer.concat([header(1),body]))
  const ops=new SceneOperations(join(root,"data")),scene=await ops.create(),loaded=await ops.import({path,sceneId:scene.sceneId})
  const uri=loaded.resource.ref.original.uri,original=await readFile(fileURLToPath(uri))
  const result=await ops.resources.streamVerifiedResource(loaded.snapshot!,uri)
  await writeFile(fileURLToPath(uri),Buffer.alloc(original.length,1))
  expect(Buffer.from(await new Response(result.body).arrayBuffer())).toEqual(original)
  await expect(ops.resources.streamVerifiedResource(loaded.snapshot!,uri)).rejects.toThrow("RESOURCE_VERSION_MISMATCH")
  const controller=new AbortController();controller.abort()
  await expect(ops.resources.streamVerifiedResource(loaded.snapshot!,uri,controller.signal)).rejects.toThrow()
 }finally{await rm(root,{recursive:true,force:true})}
})
