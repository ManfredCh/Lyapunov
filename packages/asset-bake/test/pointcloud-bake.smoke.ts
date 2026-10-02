/** 真实 trimesh/资源队列/MuJoCo 验收。显式 SDK 前提，缺解释器即失败；不把跳过当通过。
 * 夹具都是合法 XYZ 点云，不是网格；不代表用户约 2 GB 原件已通过。 */
import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, link, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { Quaternion, Vector3 } from 'three'
import { physicalize, type PhysicalizeInput } from '../src/physicalize.ts'
import { runProvider } from '../src/operations.ts'
import { SceneOperations } from '../../scene-kit/src/operations.ts'
import { MuJoCoProvider } from '../../sim-mujoco/src/provider.ts'
import { identityTransform } from '../../lyapunov-contracts/src/types.ts'

const python = process.env.LYAPUNOV_ALGORITHM_PYTHON
if (!python) throw new Error('本真实烟测必须明确提供 LYAPUNOV_ALGORITHM_PYTHON；不会跳过冒充成功')
const simPython = process.env.LYAPUNOV_MUJOCO_PYTHON ?? python
const worker = resolve(import.meta.dir, '../../sim-mujoco/python/worker.py')
type V3 = [number, number, number]
type Box = { center: V3; halfExtents: V3 }
const gap: V3[] = [[.01, .01, .01], [.11, .01, .01], [.21, .01, .01], [.81, .01, .01], [.91, .01, .01], [1.01, .01, .01]]
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const fullTiling={coverage:'full' as const,tileSizeCells:64,maxTotalOccupiedVoxels:2000000,maxTotalBoxes:10000,maxTiles:16384,maxDiskBytes:2147483648}
const surfaceRequest=(input:PhysicalizeInput):PhysicalizeInput=>({...input,strategy:'triangle_mesh',pointCloudTiling:fullTiling,maxOccupiedVoxels:1000000,maxBoxes:10000})

async function verifyCellBoundary(paths:string[],cells:V3[],pitch:number){
 const key=(cell:number[])=>cell.join(',');const occupied=new Set(cells.map(key));const expected=new Set<string>(),actual=new Set<string>()
 for(const cell of cells)for(let axis=0;axis<3;axis++)for(const sign of [-1,1]){const neighbour=[...cell];neighbour[axis]!+=sign;if(!occupied.has(key(neighbour)))expected.add(`${key(cell)}|${axis}|${sign}`)}
 for(const path of paths){
  const vertices:number[][]=[],faces:number[][]=[]
  for(const line of (await readFile(path,'utf8')).split('\n')){const [kind,...values]=line.trim().split(/\s+/);if(kind==='v')vertices.push(values.map(value=>Math.round(Number(value)/pitch)));else if(kind==='f')faces.push(values.map(value=>Number(value)-1))}
  expect(faces.length%2).toBe(0)
  for(let index=0;index<faces.length;index+=2){
   const [a,b,c]=faces[index]!.map(v=>vertices[v]!),u=b!.map((v,k)=>v-a![k]!),v=c!.map((value,k)=>value-a![k]!)
   const n=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!],axis=n.findIndex(value=>value!==0),sign=Math.sign(n[axis]!)
   expect(n.filter(value=>value!==0)).toHaveLength(1);expect(Math.abs(n[axis]!)).toBe(1)
   const corners=[...new Set([...faces[index]!,...faces[index+1]!])].map(vertex=>vertices[vertex]!)
   expect(corners).toHaveLength(4)
   const minimum=[0,1,2].map(k=>Math.min(...corners.map(corner=>corner[k]!))),maximum=[0,1,2].map(k=>Math.max(...corners.map(corner=>corner[k]!)))
   expect(maximum.map((value,k)=>value-minimum[k]!)).toEqual([0,1,2].map(k=>k===axis?0:1))
   const owner=[...minimum];if(sign>0)owner[axis]=owner[axis]!-1
   const neighbour=[...owner];neighbour[axis]!+=sign
   expect(occupied.has(key(owner))).toBe(true);expect(occupied.has(key(neighbour))).toBe(false)
   const faceKey=`${key(owner)}|${axis}|${sign}`;expect(actual.has(faceKey)).toBe(false);actual.add(faceKey)
  }
 }
 expect([...actual].sort()).toEqual([...expected].sort())
 const ordered=[...cells].sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]),bytes=Buffer.alloc(ordered.length*24)
 ordered.forEach((cell,index)=>cell.forEach((value,axis)=>bytes.writeBigInt64LE(BigInt(value),index*24+axis*8)))
 return digest(bytes)
}

function ply(points: V3[], format = 'binary_little_endian', attributes = 3): Buffer {
  const extras = Array.from({ length: attributes }, (_, i) => i === 0 ? 'opacity' : `f_rest_${i}`)
  const header = Buffer.from(`ply\nformat ${format} 1.0\nelement vertex ${points.length}\nproperty float x\nproperty float y\nproperty float z\n${extras.map(n => `property float ${n}\n`).join('')}end_header\n`)
  if (format === 'ascii') return Buffer.concat([header, Buffer.from(points.map(p => [...p, ...extras.map(() => 1)].join(' ')).join('\n') + '\n')])
  const binary = Buffer.alloc(points.length * (3 + attributes) * 4)
  points.forEach((p, i) => [...p, ...extras.map(() => NaN)].forEach((v, k) => {
    const offset = (i * (3 + attributes) + k) * 4
    if (format === 'binary_big_endian') binary.writeFloatBE(v, offset)
    else binary.writeFloatLE(v, offset)
  }))
  return Buffer.concat([header, binary])
}
async function fixture<T>(bytes: Buffer, body: (input: PhysicalizeInput, directory: string) => Promise<T>) {
  const evidence = process.env.LYAPUNOV_POINTCLOUD_EVIDENCE
  if (evidence) await mkdir(evidence, { recursive: true })
  const directory = await mkdtemp(join(evidence ?? tmpdir(), 'lya-pointcloud-'))
  const sourcePath = join(directory, '实际 点云.ply')
  await writeFile(sourcePath, bytes)
  try { return await body({ sourcePath, outputDirectory: join(directory, 'out'), usage: 'environment', strategy: 'auto', sourceUpAxis: 'Z', metersPerUnit: 1, voxelSizeM: .1 }, directory) }
  finally { if (!evidence) await rm(directory, { recursive: true, force: true }) }
}
function contains(boxes: Box[], point: V3) { return boxes.some(b => point.every((v, a) => Math.abs(v - b.center[a]!) <= b.halfExtents[a]! + 1e-7)) }

test('二进制 Gaussian 附加属性不参与几何：真实 XYZ→体素，空隙与原件保留', async () => {
  await fixture(ply(gap), async (input) => {
    const before = digest(await readFile(input.sourcePath))
    const result = await physicalize(input, { python })
    const object = result.objects[0]!
    expect(object.selected).toBe('voxel_boxes'); expect(object.sourceKind).toBe('point_cloud')
    expect(object.pointCloud?.sourcePoints).toBe(gap.length); expect(object.pointCloud?.skippedNonfinitePoints).toBe(0)
    expect(object.pointCloud?.streamedXYZ).toBe(true)
    const boxes = object.boxes as Box[]
    expect(boxes.length).toBe(2); expect(contains(boxes, [.55, .01, .01])).toBe(false)
    expect(gap.every(p => contains(boxes, p))).toBe(true)
    expect(object.massKg).toBeNull(); expect(object.volumeM3).toBeNull(); expect(object).not.toHaveProperty('surfaceAreaM2')
    expect(digest(await readFile(input.sourcePath))).toBe(before)
    const metadata = JSON.parse(await readFile(join(input.outputDirectory, 'geometry.json'), 'utf8'))
    expect(metadata.schema).toBe('lyapunov.geometry.v2');expect(metadata.nodes[0].kind).toBe('point_cloud')
    expect(metadata.nodes[0]).not.toHaveProperty('vertices');expect(metadata.nodes[0]).not.toHaveProperty('faces')
    expect(object.pointCloud?.sourceReadBytes).toBe(gap.length*(3+3)*4*2)
    expect(object.pointCloud?.observedMaxReadBytes).toBeLessThanOrEqual(8*1024*1024)
    expect(JSON.parse(await readFile(object.parts[0]!, 'utf8')).fillInterior).toBe(false)
  })
})

test('ASCII 毫米/Y-up 只转换一次，file URI 与真实路径一致', async () => {
  await fixture(ply([[1000, 2000, 3000], [1100, 2000, 3000]], 'ascii'), async (input) => {
    const result = await physicalize({ ...input, sourcePath: pathToFileURL(input.sourcePath).href, sourceUpAxis: 'Y', metersPerUnit: .001 }, { python })
    expect(result.sourcePath).toBe(input.sourcePath)
    const obj = result.objects[0]!
    expect(obj.pointCloud?.sourceBoundsM).toEqual({ min: [1, -3, 2], max: [1.1, -3, 2] })
    expect(contains(obj.boxes as Box[], [1, -3, 2])).toBe(true)
    expect(contains(obj.boxes as Box[], [1, -2, -3])).toBe(false)
  })
})

test('大端/多属性/超过一个块的点云仍用真实点数，输出不膨胀成顶点 JSON', async () => {
  const points = Array.from({ length: 32771 }, (_, i) => gap[i % gap.length]!)
  await fixture(ply(points, 'binary_big_endian', 59), async (input) => {
    const result = await physicalize(input, { python }); const obj = result.objects[0]!
    expect(obj.pointCloud?.sourcePoints).toBe(points.length); expect(obj.pointCloud?.vertexStrideBytes).toBe(248)
    expect(obj.pointCloud?.chunkPoints).toBe(32768); expect(obj.boxes).toHaveLength(2)
    expect((await readFile(join(input.outputDirectory, 'geometry.json'))).length).toBeLessThan(5000)
  })
})

test('固定精度下盒数/占据预算超限真实拒绝，不退回 bbox、不粗化', async () => {
  await fixture(ply(gap), async input => {
    await expect(physicalize({ ...input, maxBoxes: 1 }, { python })).rejects.toThrow('POINT_CLOUD_BOX_BUDGET_EXCEEDED')
    await expect(physicalize({ ...input, maxOccupiedVoxels: 1 }, { python })).rejects.toThrow('POINT_CLOUD_VOXEL_BUDGET_EXCEEDED')
  })
})

test('未固定精度才允许有限自动晶格；实际粗化步数与覆盖限制可读', async () => {
  await fixture(ply(gap), async input => {
    const obj = (await physicalize({ ...input, voxelSizeM: undefined, maxBoxes: 6 }, { python })).objects[0]!
    expect(obj.pointCloud?.explicitVoxelSize).toBe(false)
    expect(Number(obj.pointCloud?.autoCoarseningSteps)).toBeLessThanOrEqual(2)
    expect(obj.pointCloud?.coverage).toBe('measured-sample-voxels')
    expect(Number(obj.pointCloud?.occupiedVoxels)).toBeLessThanOrEqual(Number(obj.pointCloud?.maxOccupiedVoxels))
    expect(obj.decomposition!.voxelSizeM).toBeGreaterThan(0)
  })
})

test('A08 单远点不能把自动碰撞变成28米体素；显式精度仍保所有点与实际空隙',async()=>{
 const points:V3[]=[...gap,[1347,0,0]]
 await fixture(ply(points),async input=>{
  await expect(physicalize({...input,voxelSizeM:undefined},{python})).rejects.toThrow('POINT_CLOUD_PRECISION_REQUIRED')
  const result=await physicalize({...input,voxelSizeM:.1},{python}),object=result.objects[0]!,boxes=object.boxes as Box[]
  expect(object.pointCloud?.sourcePoints).toBe(points.length);expect(object.pointCloud?.finitePoints).toBe(points.length)
  expect(object.decomposition!.voxelSizeM).toBe(.1);expect(contains(boxes,[1347,0,0])).toBe(true)
  expect(contains(boxes,[.55,.01,.01])).toBe(false);expect(object.pointCloud?.maxAutoVoxelSizeM).toBe(.03)
 })
})

test('F1 full tiled同全source占据，跨tile邻cell内面被消掉；三角表面明确sampled/Isaac-only',async()=>{
 // 负f32 -.2/-.1实际落-3/-2cell，仍相邻；不把浮点源悄悄snap到另一晶格。
 const points:V3[]=[[-.2,0,0],[-.1,0,0],[6.3,0,0],[6.4,0,0],[6.5,0,0],[100,0,0]]
 await fixture(ply(points),async input=>{
  const full={coverage:'full' as const,tileSizeCells:64,maxTotalOccupiedVoxels:2000000,maxTotalBoxes:10000,maxTiles:16384,maxDiskBytes:2147483648}
  const result=await physicalize({...input,strategy:'triangle_mesh',pointCloudTiling:full,maxOccupiedVoxels:1000000,maxBoxes:10000},{python})
  expect(result.objects.length).toBeGreaterThan(0)
  const info=result.objects[0]!.pointCloud!
  expect(info.sourcePoints).toBe(6);expect(info.finitePoints).toBe(6);expect(info.sourceOccupiedVoxels).toBe(6)
  // 六cell36面扣三个相邻pair的六个内面，含跨64cell边界。
  expect(info.exteriorQuads).toBe(30);expect(info.triangles).toBe(60);expect(info.processing).toBe('full-spatial-voxel-surface')
  expect(info.consumerSupport).toEqual({isaac:'explicit-static-triangle-mesh-none',mujoco:'UNSUPPORTED_VOXEL_SURFACE'})
  expect(result.objects[0]!.sourceKind).toBe('point_cloud');expect(result.objects[0]!.selected).toBe('triangle_mesh');expect(result.objects[0]!.massKg).toBeNull()
  expect(result.geometryTransport.verified).toBe(true)
  const faces=await Promise.all(result.objects.flatMap(object=>object.parts).map(async path=>(await readFile(path,'utf8')).split('\n').filter(line=>line.startsWith('f ')).length));expect(faces.reduce((a,b)=>a+b,0)).toBe(60)
 })
})
test('F1 full request总预算不得复用旧whole/按tile重领总盒额度',async()=>{
 await fixture(ply(gap),async input=>{
  const full={coverage:'full' as const,tileSizeCells:64,maxTotalOccupiedVoxels:2,maxTotalBoxes:10000,maxTiles:16384,maxDiskBytes:2147483648}
  await expect(physicalize({...input,strategy:'voxel_boxes',pointCloudTiling:full,maxOccupiedVoxels:1000000,maxBoxes:10000},{python})).rejects.toThrow('POINT_CLOUD_TOTAL_OCCUPIED_BUDGET')
  await expect(physicalize({...input,strategy:'voxel_boxes',pointCloudTiling:{...full,maxTotalOccupiedVoxels:2000000,maxTotalBoxes:1},maxOccupiedVoxels:1000000,maxBoxes:10000},{python})).rejects.toThrow('POINT_CLOUD_TOTAL_BOX_BUDGET')
 })
})
test('F1 测得体素环孔保持，跨tile每一个外面与全源同cell/同hash/外向法线相等',async()=>{
 const cells:V3[]=[];for(let x=0;x<3;x++)for(let y=0;y<3;y++)if(x!==1||y!==1)cells.push([x,y,0])
 await fixture(ply(cells.map(([x,y,z]):V3=>[x+.25,y+.25,z+.25])),async input=>{
  const progress:Record<string,unknown>[]=[]
  const request={...surfaceRequest(input),voxelSizeM:1,pointCloudTiling:{...fullTiling,tileSizeCells:2}}
  const result=await physicalize(request,{python,onProgress:message=>progress.push(message.facts)})
  const paths=result.objects.flatMap(object=>object.parts),hash=await verifyCellBoundary(paths,cells,1),info=result.objects[0]!.pointCloud!
  expect(info.occupiedCellSha256).toBe(hash);expect(info.occupiedCellHashEncoding).toBe('sorted-xyz-i64le')
  expect(info.boundaryValidation).toEqual({rule:'six-neighbour-occupied-union',expectedQuadsByDirection:[4,4,4,4,8,8],emittedQuadsByDirection:[4,4,4,4,8,8]})
  expect(info.tiles).toBe(4);expect(info.exteriorQuads).toBe(32);expect(result.objects.every(object=>object.massKg===null&&object.volumeM3===null)).toBe(true)
  expect(result.objects[0]!).not.toHaveProperty('surfaceAreaM2');expect(result.objects.reduce((sum,object)=>sum+(object as any).sampledSurfaceAreaM2,0)).toBe(32)
  expect(progress.some(facts=>facts.stage==='full-tiled-read'&&facts.processedSamples===8)).toBe(true)
  expect(progress.some(facts=>facts.stage==='full-surface-verified'&&facts.triangles===64)).toBe(true)
  const disk=(await Promise.all((await readdir(input.outputDirectory)).map(async name=>(await stat(join(input.outputDirectory,name))).size))).reduce((a,b)=>a+b,0)
  expect((result.geometryTransport as any).outputDiskBytes).toBe(disk)
 })
})
test('F1 full tile/disk/转换预算错误带具体details、不发布部分清单、不改源文件别名',async()=>{
 await fixture(ply(gap),async(input,directory)=>{
  const original=digest(await readFile(input.sourcePath))
  try{await physicalize({...surfaceRequest(input),pointCloudTiling:{...fullTiling,maxDiskBytes:8192}},{python});throw new Error('预算应该拒绝')}
  catch(error){expect(String(error)).toContain('POINT_CLOUD_');expect((error as any).cause.stage).toBeTruthy();expect((error as any).cause.coverageComplete).toBe(false)}
  expect(await readdir(input.outputDirectory)).not.toContain('geometry.json')
  await expect(physicalize({...surfaceRequest(input),outputDirectory:join(directory,'tile-limit'),pointCloudTiling:{...fullTiling,tileSizeCells:1,maxTiles:1}},{python})).rejects.toThrow('POINT_CLOUD_TILE_BUDGET')
  const alias=join(directory,'alias');await mkdir(alias);await link(input.sourcePath,join(alias,'point-cloud-full.sqlite'))
  await expect(physicalize({...surfaceRequest(input),outputDirectory:alias},{python})).rejects.toThrow('SOURCE_OVERWRITE_REJECTED')
  expect(digest(await readFile(input.sourcePath))).toBe(original)
 })
})
test('F1 最终清单同属disk硬限，另一请求的预算/精度不能复用旧full产物',async()=>{
 await fixture(ply(gap),async(input,directory)=>{
  const request=surfaceRequest(input),raw=await runProvider({...request,method:'triangle_mesh',pointCloudStrategy:'triangle_mesh'},{python})
  await expect(physicalize({...request,voxelSizeM:.2},{python,execute:async()=>raw})).rejects.toThrow('本次请求不符')
  await expect(physicalize({...request,pointCloudTiling:{...fullTiling,maxTotalOccupiedVoxels:1999999}},{python,execute:async()=>raw})).rejects.toThrow('本次请求不符')
  const names=(await readdir(input.outputDirectory)).filter(name=>name!=='geometry.json'&&name!=='bake.json')
  const geometryOnly=(await Promise.all(names.map(async name=>(await stat(join(input.outputDirectory,name))).size))).reduce((a,b)=>a+b,0)
  const limited={...request,outputDirectory:join(directory,'manifest-limit'),pointCloudTiling:{...fullTiling,maxDiskBytes:geometryOnly+1}}
  try{await physicalize(limited,{python});throw new Error('清单必须被总预算拒绝')}
  catch(error){expect((error as any).cause.stage).toBe('full-tiled-manifest');expect((error as any).cause.requiredDiskBytes).toBeGreaterThan(geometryOnly+1)}
  expect(await readdir(limited.outputDirectory)).not.toContain('geometry.json');expect(await readdir(limited.outputDirectory)).not.toContain('bake.json')
 })
})
test('F1 Python全域阶段真实进度可取消，父事件循环heartbeat继续、终止前不发布成功清单',async()=>{
 const points=Array.from({length:32771},(_,index):V3=>[index*.2+.01,.01,.01])
 await fixture(ply(points),async input=>{
  const original=digest(await readFile(input.sourcePath)),controller=new AbortController();let beats=0,sawSurface=false,sourceRead=0
  const timer=setInterval(()=>beats++,2),started=Date.now()
  try{await expect(physicalize(surfaceRequest(input),{python,signal:controller.signal,onProgress:message=>{
   if(message.facts.stage==='full-tiled-read')sourceRead=Math.max(sourceRead,Number(message.facts.processedSamples??0))
   if(message.facts.stage==='full-surface-index'){sawSurface=true;controller.abort()}
  }})).rejects.toThrow()}
  finally{clearInterval(timer)}
  expect(sawSurface).toBe(true);expect(sourceRead).toBe(points.length);expect(beats).toBeGreaterThan(10);expect(Date.now()-started).toBeLessThan(3500)
  const files=await readdir(input.outputDirectory);expect(files).not.toContain('geometry.json');expect(files).not.toContain('physicalization.json')
  expect(digest(await readFile(input.sourcePath))).toBe(original)
 })
},10000)

test('无面点云的显式网格/CoACD 策略与非法单位拒绝，诊断给出真实可用路径', async () => {
  await fixture(ply(gap), async input => {
    for (const strategy of ['triangle_mesh', 'coacd'] as const) await expect(physicalize({ ...input, strategy }, { python })).rejects.toThrow('POINT_CLOUD_REQUIRES_VOXELS')
    await expect(runProvider({ ...input, strategy: undefined, method: 'triangle_mesh' }, { python })).rejects.toThrow('POINT_CLOUD_REQUIRES_VOXELS')
    await expect(physicalize({ ...input, metersPerUnit: 0 }, { python })).rejects.toThrow('INVALID_METERS_PER_UNIT')
  })
})

test('截断/缺 XYZ/非有限点如实处理，不能假报空产物成功', async () => {
  await fixture(ply([...gap, [NaN, 0, 0]]), async input => {
    const obj = (await physicalize(input, { python })).objects[0]!
    expect(obj.pointCloud?.sourcePoints).toBe(7); expect(obj.pointCloud?.finitePoints).toBe(6); expect(obj.pointCloud?.skippedNonfinitePoints).toBe(1)
    const bytes = await readFile(input.sourcePath)
    await writeFile(input.sourcePath, bytes.subarray(0, bytes.length - 1))
    await expect(physicalize(input, { python })).rejects.toThrow('TRUNCATED_POINT_CLOUD')
    await writeFile(input.sourcePath, Buffer.from('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nend_header\n1 2\n'))
    await expect(physicalize(input, { python })).rejects.toThrow('POINT_CLOUD_XYZ_REQUIRED')
  })
})

test('点云输出硬链接别名不能覆盖源文件（含 file URI）', async () => {
  await fixture(ply(gap), async input => {
    await mkdir(input.outputDirectory); await link(input.sourcePath, join(input.outputDirectory, 'voxel-0.json'))
    const before = digest(await readFile(input.sourcePath))
    await expect(physicalize({ ...input, sourcePath: pathToFileURL(input.sourcePath).href }, { python })).rejects.toThrow('SOURCE_OVERWRITE_REJECTED')
    expect(digest(await readFile(input.sourcePath))).toBe(before)
  })
})

test('PLY 有面网格仍走真实 Trimesh，不误分派为点云', async () => {
  const mesh = Buffer.from('ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n')
  await fixture(mesh, async input => {
    const result = await physicalize({ ...input, strategy: 'triangle_mesh' }, { python })
    expect(result.objects[0]!.selected).toBe('triangle_mesh'); expect(result.objects[0]!.sourceKind).toBeUndefined()
    expect(await readFile(result.objects[0]!.parts[0]!, 'utf8')).toContain('f ')
  })
})

async function awaitRecord(operations: SceneOperations, resourceId: string, attempts = 1) {
  const until = Date.now() + 15000
  for (;;) {
    const record = await operations.resources.get(resourceId)
    if (record.physicalization && (record.physicalization.attempts ?? 0) >= attempts && record.physicalization.status !== 'pending') return record
    if (Date.now() > until) throw new Error('真实资源派生超时')
    await new Promise(done => setTimeout(done, 40))
  }
}

test('普通点云不自动烘焙；显式同资源派生落库、重复复用、挂载与真实 compiled collider 一致', async () => {
  // 把同一实测 Z-up 间隙夹具编码成毫米/Y-up 原件；真实视觉 wrapper 与碰撞各应转换一次。
  await fixture(ply(gap.map(([x, y, z]): V3 => [x * 1000, z * 1000, -y * 1000])), async (input, directory) => {
    const operations = new SceneOperations(join(directory, 'resource-runtime'), { algorithmPython: python })
    const source = { units: 'mm', upAxis: 'Y', handedness: 'right', metersPerUnit: .001 } as const
    const { resource } = await operations.import({ path: input.sourcePath, resourceId: 'pointcloud', source })
    expect(resource.physicalization).toBeUndefined()
    await operations.import({ path: input.sourcePath, resourceId: 'pointcloud', source, physicalize: true, physicalizeVoxelSizeM: .1 })
    const record = await awaitRecord(operations, 'pointcloud')
    expect(record.physicalization?.status).toBe('ok'); expect(record.physicalization?.usage).toBe('environment')
    expect(record.physicalization?.boxes).toBe(2); expect(record.physicalization?.passageVerified).toBe(false)
    expect(record.componentDefaults?.rigidBody).toEqual({ type: 'static' })
    await operations.import({ path: input.sourcePath, resourceId: 'pointcloud', source, physicalize: true, physicalizeVoxelSizeM: .1 })
    await new Promise(done => setTimeout(done, 100))
    expect((await operations.resources.get('pointcloud')).physicalization?.attempts).toBe(1)
    const scene = await operations.create({ sceneId: 'pointcloud-native' })
    const pose = { ...identityTransform(), position: [.3, -.2, .4] as V3, quaternion: [0, 0, Math.SQRT1_2, Math.SQRT1_2] as [number,number,number,number], scale: [2, 1, 1] as V3 }
    const { snapshot } = await operations.mount({ sceneId: scene.sceneId, resourceId: 'pointcloud', entityId: 'samples', transform: pose, alignBottomToSurface: false })
    const shapes = record.componentDefaults!.collision!.shapes as Box[]
    const provider = new MuJoCoProvider({ pythonPath: simPython, workerPath: worker })
    try {
      const handle = await provider.open(snapshot, { clock: 'manual', ground: false })
      const frame = await provider.observe(handle.worldId, { collisionTopology: { entityIds: ['samples'], includeGeometry: true } })
      const geoms = frame.collisionTopology!.geoms.filter(g => g.entityId === 'samples')
      expect(geoms.length).toBe(shapes.length)
      for (let i = 0; i < geoms.length; i++) {
        const geom = geoms[i]!, shape = shapes[i]!
        expect(geom.geometry!.kind).toBe('box')
        const expected = new Vector3(...shape.center).multiply(new Vector3(...pose.scale)).applyQuaternion(new Quaternion(...pose.quaternion)).add(new Vector3(...pose.position)).toArray()
        for (let a = 0; a < 3; a++) {
          expect(geom.positionM[a]!).toBeCloseTo(expected[a]!, 7)
          expect(geom.geometry!.sizeM![a]!).toBeCloseTo(shape.halfExtents[a]! * pose.scale[a]!, 7)
        }
      }
      await writeFile(join(directory, 'compiled-frame.json'), JSON.stringify({ snapshot, record, frame }, null, 2))
      await provider.close(handle.worldId)
    } finally { await provider.dispose() }
  })
}, 20000)

test('实际采样地面派生后真实落球接触，空隙球继续落下（无内建 ground）', async () => {
  const floor: V3[] = []
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) floor.push([x * .1 + .01, y * .1 + .01, -.05])
  await fixture(ply(floor), async (input, directory) => {
    const operations = new SceneOperations(join(directory, 'contact-runtime'), { algorithmPython: python })
    await operations.import({ path: input.sourcePath, resourceId: 'sample-floor', source: { units: 'm', upAxis: 'Z', handedness: 'right', metersPerUnit: 1 }, physicalize: true, physicalizeVoxelSizeM: .1 })
    const record = await awaitRecord(operations, 'sample-floor'); expect(record.physicalization?.status).toBe('ok')
    const scene = await operations.create({ sceneId: 'pointcloud-contact' })
    const mounted = await operations.mount({ sceneId: scene.sceneId, resourceId: 'sample-floor', entityId: 'floor' })
    const sphere = (entityId: string, x: number) => ({ entityId, name: entityId, resources: [], transform: { ...identityTransform(), position: [x, .15, .5] as V3 }, components: { collision: { shape: 'sphere', halfExtents: [.03, .03, .03] }, rigidBody: { type: 'dynamic', massKg: .1 } } })
    const snapshot = await operations.scene.commit({ sceneId: scene.sceneId, expectedRevision: mounted.snapshot.revision, patch: [{ op: 'add', entity: sphere('contact-probe', .15) }, { op: 'add', entity: sphere('empty-probe', .65) }] })
    const provider = new MuJoCoProvider({ pythonPath: simPython, workerPath: worker })
    try {
      const handle = await provider.open(snapshot, { clock: 'realtime', timestepS: .002, ground: false })
      await new Promise(done => setTimeout(done, 1200))
      const frame = await provider.observe(handle.worldId, { contacts: true, collisionTopology: { entityIds: ['floor', 'contact-probe'], includeGeometry: true } })
      const resting = frame.entities.find(e => e.entityId === 'contact-probe')!
      const falling = frame.entities.find(e => e.entityId === 'empty-probe')!
      expect(frame.stepIndex).toBeGreaterThan(100)
      expect(resting.transform.position[2]).toBeCloseTo(.03, 3)
      expect(falling.transform.position[2]).toBeLessThan(-.5)
      expect(frame.contacts!.some(c => (c.geom1.startsWith('floor/') || c.geom2.startsWith('floor/')) && c.forceN?.some(f => Math.abs(f) > .01))).toBe(true)
      expect(frame.collisionTopology!.geoms.some(g => g.name === '__ground')).toBe(false)
      await writeFile(join(directory, 'contact-frame.json'), JSON.stringify({ snapshot, record, frame }, null, 2))
      await provider.close(handle.worldId)
    } finally { await provider.dispose() }
  })
}, 20000)
