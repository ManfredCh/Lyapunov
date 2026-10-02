/**
 * Voxel hollow decomposition — turn a concave mesh into a set of axis-aligned convex boxes that
 * respect its hollows.
 *
 * MuJoCo collides a single mesh geom as its convex hull, so a hull-collider cup is a solid blob:
 * its mouth is sealed and nothing can be placed inside. This produces the opposite — several
 * convex boxes forming the walls + bottom, the interior left as the gap between them — so a
 * smaller object dropped in rests inside, exactly like the shipped 16-part CoACD bowl.
 *
 * Pure typed-array math, no dependency. Method: voxelize the surface, morphologically close
 * pinholes, flood the exterior, keep everything the exterior cannot reach as "solid" (surface +
 * any sealed interior — an OPEN cavity like a cup's bowl stays open because it connects to the
 * outside through the mouth), then greedily merge the solid cells into maximal boxes.
 *
 * It is deliberately simpler than the scene-collision voxel providers (no ROI, seed capsule,
 * surface-role classification or coverage audit): a generated object is small and self-contained,
 * so the exterior flood needs no seed and the grid needs no region of interest.
 *
 * ## 分辨率合同（环境表面路径）
 *
 * `voxelSizeM` 是绑定值：显式给出时按原样使用，不再被夹到 3cm，也不再被格点预算静默粗化。
 * 表面模式（`fillInterior:false`，即环境碰撞派生）在晶格超过 `maxGridCells` 时把**同一晶格**
 * 切成对齐的块分别分解，而不是放大体素 —— 门洞宽度与多层表面之间的空气间隙因此保持调用方
 * 要求的精度，房间也不会被单个封闭凸包替代。分块只在表面模式可用：内部填充依赖整格外部泛洪，
 * 切块会改变其语义，因此该模式仍会粗化，并在结果里如实报告实际使用的 `voxelSizeM`。
 * `maxBoxes` 始终是**整个结果**的硬上限：分块跑法逐块累加总盒数，超出即返回 `undefined`，
 * 由调用方显式提高预算（或自己决定粗化体素）——参数语义不因分块而改变，也不会静默牺牲精度。
 *
 * 自动体素（不给 `voxelSizeM`）保持既往行为：先按 `targetResolution` 取最长边的目标分辨率、
 * 夹到 `[minVoxelSizeM, maxVoxelSizeM]`，再按 `maxGridCells` 粗化到预算内。这是物体路径的
 * 成熟取舍；环境若要固定通行精度必须显式给 `voxelSizeM`。
 */

export interface DecomposeBox {
  /** Box centre, in the same frame as the input vertices (metres). */
  readonly center: [number, number, number]
  /** Box half-extents (metres). */
  readonly halfExtents: [number, number, number]
}

export interface VoxelDecomposeResult {
  readonly boxes: DecomposeBox[]
  readonly voxelSizeM: number
  readonly gridDims: [number, number, number]
  readonly fillInterior: boolean
  /** 表面晶格分块数；未分块（含所有填充模式）为 1。分块时 `gridDims` 是整格的尺寸。 */
  readonly tiles: number
  readonly diagnostics?: VoxelDiagnostics
}

export interface VoxelDecomposeOptions {
  /** 环境只保留网格表面，不能把闭合房间内部填成实心；物体默认保留原填充行为。 */
  fillInterior?: boolean
  /** Voxel edge length (m). 显式给出即绑定：原样使用，必要时按同一晶格分块（表面模式）。
   *  Omitted → picked so the longest side spans ~`targetResolution` cells, then coarsened to fit
   *  `maxGridCells`. */
  voxelSizeM?: number
  /** Approx. cells across the longest side when `voxelSizeM` is auto-picked. */
  targetResolution?: number
  /** Grid is coarsened until nx*ny*nz ≤ this; 表面模式改为按此预算分块。 */
  maxGridCells?: number
  /** Soft budget: coarsen the voxel grid until the box count drops to ~this (keeps a curved
   *  wall from fragmenting into hundreds of tiny staircase boxes). Ignored when `voxelSizeM` is
   *  given explicitly. */
  targetBoxes?: number
  /** 整个结果的盒数硬上限：超出即返回 `undefined`（调用方显式提高该值，而不是静默粗化体素）。
   *  分块跑法也按所有块的总盒数判定，因此同一参数在单格/分块下含义一致。 */
  maxBoxes?: number
  maxTiles?:number
  maxSamples?:number
  maxFaceVisits?:number
  maxWorkingBytes?:number
  maxWorkingBoxes?:number
}

export interface VoxelDiagnostics {
  stage:string;reason?:string;requestedVoxelSizeM?:number;effectiveVoxelSizeM?:number
  gridDims?:[number,number,number];gridCells?:number;maxGridCells:number;tiles:number;totalTiles?:number;maxTiles:number
  faces:number;facesVisited:number;facesRasterized:number;samplesProcessed:number;maxSamples:number;maxFaceVisits:number
  boxesBeforeMerge:number;boxesAfterMerge:number;maxBoxes:number;maxWorkingBoxes:number;workingBytesEstimate:number;maxWorkingBytes:number
  requiredBoxesAtLeast?:number;requiredSamplesAtLeast?:number;requiredFaceVisitsAtLeast?:number
}
export interface LatticeBox { min:[number,number,number];max:[number,number,number] }
export class VoxelDecomposeError extends Error {
 constructor(readonly reason:string,readonly diagnostics:VoxelDiagnostics){super(`VOXEL_${reason}: ${JSON.stringify(diagnostics)}`)}
}
const WORK_DEFAULTS={maxTiles:4096,maxSamples:128_000_000,maxFaceVisits:100_000_000,maxWorkingBytes:256*1024*1024,maxWorkingBoxes:40000} as const
class VoxelWork {
 readonly facts:VoxelDiagnostics
 boxCollector?: (box:LatticeBox)=>void
 constructor(vertices:Float64Array,faces:Uint32Array,options:VoxelDecomposeOptions,private progress?:(facts:VoxelDiagnostics)=>void){
  const cap=(name:keyof typeof WORK_DEFAULTS,upper:number)=>{
   const value=options[name]??WORK_DEFAULTS[name]
   if(!Number.isSafeInteger(value)||value<1||value>upper)throw new Error(`INVALID_VOXEL_WORK_BUDGET: ${name} 必须是1..${upper}整数`)
   return value
  }
  this.facts={stage:'prepare',requestedVoxelSizeM:options.voxelSizeM,maxGridCells:options.maxGridCells??VOXEL_DECOMPOSE_DEFAULTS.maxGridCells,tiles:0,
   maxTiles:cap('maxTiles',16384),faces:faces.length/3,facesVisited:0,facesRasterized:0,samplesProcessed:0,maxSamples:cap('maxSamples',1_000_000_000),
   maxFaceVisits:cap('maxFaceVisits',1_000_000_000),boxesBeforeMerge:0,boxesAfterMerge:0,maxBoxes:options.maxBoxes??VOXEL_DECOMPOSE_DEFAULTS.maxBoxes,
   maxWorkingBoxes:cap('maxWorkingBoxes',100000),workingBytesEstimate:vertices.byteLength+faces.byteLength,maxWorkingBytes:cap('maxWorkingBytes',512*1024*1024)}
  if(!Number.isSafeInteger(this.facts.maxGridCells)||this.facts.maxGridCells<8||this.facts.maxGridCells>4_000_000)throw new Error('INVALID_VOXEL_WORK_BUDGET: maxGridCells 必须是8..4000000整数')
  if(!Number.isSafeInteger(this.facts.maxBoxes)||this.facts.maxBoxes<1||this.facts.maxBoxes>10000)throw new Error('INVALID_VOXEL_BOX_BUDGET: maxBoxes必须是1..10000整数')
  this.memory(this.facts.workingBytesEstimate);this.emit('prepare')
 }
 fail(reason:string,extra:Partial<VoxelDiagnostics>={}):never{throw new VoxelDecomposeError(reason,{...this.facts,...extra,reason})}
 memory(bytes:number){this.facts.workingBytesEstimate=Math.max(this.facts.workingBytesEstimate,bytes);if(bytes>this.facts.maxWorkingBytes)this.fail('WORKING_MEMORY_BUDGET')}
 emit(stage:string){this.facts.stage=stage;this.progress?.({...this.facts})}
}

/** 半开整数晶格：只合面贴面、其余两轴区间完全相同的盒，逐单元并集保持。 */
export function mergeLatticeBoxes(input:readonly LatticeBox[]):LatticeBox[]{
 let boxes=input.map(box=>({min:[...box.min] as [number,number,number],max:[...box.max] as [number,number,number]}))
 for(const box of boxes)for(let a=0;a<3;a++)if(!Number.isSafeInteger(box.min[a])||!Number.isSafeInteger(box.max[a])||box.max[a]<=box.min[a])throw new Error('INVALID_VOXEL_LATTICE_BOX')
 for(let pass=0;pass<32;pass++){
  const before=boxes.length
  for(let axis=0;axis<3;axis++){
   const other=[0,1,2].filter(a=>a!==axis),buckets=new Map<string,LatticeBox[]>()
   for(const box of boxes){const key=other.map(a=>`${box.min[a]}:${box.max[a]}`).join('|');const bucket=buckets.get(key)??[];bucket.push(box);buckets.set(key,bucket)}
   const merged:LatticeBox[]=[]
   for(const bucket of buckets.values()){
    bucket.sort((a,b)=>a.min[axis]-b.min[axis]);let current: LatticeBox|undefined
    for(const box of bucket){if(current&&current.max[axis]===box.min[axis])current.max[axis]=box.max[axis];else{if(current)merged.push(current);current=box}}
    if(current)merged.push(current)
   }
   boxes=merged
  }
  if(boxes.length===before)return boxes
 }
 throw new Error('VOXEL_MERGE_WORK_BUDGET: 精确合并超过32轮，未改变占据并集但未发布未完成结果')
}

export const VOXEL_DECOMPOSE_DEFAULTS = {
  targetResolution: 44,
  maxGridCells: 220_000,
  // ~128 keeps a cup's collider fine enough (≈5 mm voxels) to preserve a handle's hole and grasp
  // surfaces, without fragmenting a curved wall into hundreds of tiny boxes. A coarser budget
  // (≈8 mm) blurred handles into un-graspable blobs.
  targetBoxes: 128,
  maxBoxes: 512,
  minVoxelSizeM: 0.0015,
  maxVoxelSizeM: 0.03,
} as const

interface Grid {
  readonly nx: number
  readonly ny: number
  readonly nz: number
  /** World-space corner of cell (0,0,0). */
  readonly origin: [number, number, number]
  readonly voxelSizeM: number
  /** 分块时使用的整格原点：单元下标一律按它计算（再减 `indexOffset`），这样同一采样点
   *  在单格与分块两种跑法里落到同一个单元，边界上的浮点差异不会让接缝丢单元或多单元。 */
  readonly indexOrigin?: [number, number, number]
  /** 本块首单元在整格里的下标（`indexOrigin` 的配套偏移）。 */
  readonly indexOffset?: [number, number, number]
}

function meshBounds(vertices: Float64Array): { min: [number, number, number]; max: [number, number, number] } | undefined {
  if (vertices.length < 3) return undefined
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < vertices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = vertices[i + k]
      if (!Number.isFinite(v)) continue
      if (v < min[k]) min[k] = v
      if (v > max[k]) max[k] = v
    }
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) return undefined
  if (max[0] - min[0] <= 0 && max[1] - min[1] <= 0 && max[2] - min[2] <= 0) return undefined
  return { min, max }
}

/** Grid dims with origin at (min − voxel): the min face lands at index 1 and the max face at
 *  index n−2, i.e. exactly one EMPTY cell of margin on every side. That margin matters: the
 *  exterior flood seeds the boundary shell, and the closing's erosion treats out-of-bounds
 *  neighbours as empty, so a face sitting on the boundary would get eroded open. Never let a face
 *  touch it. */
function gridDimsFor(min: [number, number, number], max: [number, number, number], voxelSizeM: number): [number, number, number] {
  return [0, 1, 2].map((k) => Math.floor((max[k] - min[k] + voxelSizeM) / voxelSizeM) + 2) as unknown as [
    number,
    number,
    number,
  ]
}

/** Grid with origin at (min − voxel) and the given cell dims. */
function makeGridAt(min: [number, number, number], voxelSizeM: number, dims: [number, number, number]): Grid {
  return {
    nx: dims[0],
    ny: dims[1],
    nz: dims[2],
    origin: [min[0] - voxelSizeM, min[1] - voxelSizeM, min[2] - voxelSizeM],
    voxelSizeM,
  }
}

/** 自动体素：目标分辨率起点夹进 [minVoxelSizeM, maxVoxelSizeM]，再按格点预算粗化。 */
function autoVoxelSize(
  min: [number, number, number],
  max: [number, number, number],
  targetResolution: number,
  maxGridCells: number,
  maxVoxelSizeM: number = VOXEL_DECOMPOSE_DEFAULTS.maxVoxelSizeM,
): number {
  const extent = [Math.max(max[0] - min[0], 0), Math.max(max[1] - min[1], 0), Math.max(max[2] - min[2], 0)]
  const longest = Math.max(extent[0], extent[1], extent[2], 1e-6)
  let voxelSizeM = Math.min(
    Math.max(longest / targetResolution, VOXEL_DECOMPOSE_DEFAULTS.minVoxelSizeM),
    maxVoxelSizeM,
  )
  // Coarsen until the grid fits the cell budget.
  let dims = gridDimsFor(min, max, voxelSizeM)
  while (dims[0] * dims[1] * dims[2] > maxGridCells) {
    voxelSizeM *= 1.25
    dims = gridDimsFor(min, max, voxelSizeM)
  }
  return voxelSizeM
}

const idxOf = (g: Grid, x: number, y: number, z: number) => x + g.nx * (y + g.ny * z)

/** 只裁剪“枚举范围”，采样点仍是原三角面的同一个整数barycentric晶格。
 * 扩一cell抵消浮点边界舍入，最终mark的整数cell严格判定；不会新增/漏掉占据单元。 */
function clippedSampleRanges(a:number[],e1:number[],e2:number[],n:number,g:Grid):{i0:number;i1:number;range:(i:number)=>[number,number]}{
 const min=g.origin.map(v=>v-g.voxelSizeM),max=[g.origin[0]+g.nx*g.voxelSizeM,g.origin[1]+g.ny*g.voxelSizeM,g.origin[2]+g.nz*g.voxelSizeM].map(v=>v+g.voxelSizeM)
 let polygon:number[][]=[[0,0],[1,0],[0,1]]
 for(let axis=0;axis<3;axis++)for(const side of[0,1]){
  const value=(p:number[])=>side===0?a[axis]+p[0]*e1[axis]+p[1]*e2[axis]-min[axis]:max[axis]-a[axis]-p[0]*e1[axis]-p[1]*e2[axis]
  const out:number[][]=[]
  for(let k=0;k<polygon.length;k++){
   const p=polygon[k],q=polygon[(k+1)%polygon.length],pv=value(p),qv=value(q)
   if(pv>=0)out.push(p)
   if((pv>=0)!==(qv>=0)){const t=pv/(pv-qv);out.push([p[0]+t*(q[0]-p[0]),p[1]+t*(q[1]-p[1])])}
  }
  polygon=out
 }
 if(!polygon.length)return{i0:1,i1:0,range:()=>[1,0]}
 const i0=Math.max(0,Math.floor(Math.min(...polygon.map(p=>p[0]))*n)-1),i1=Math.min(n,Math.ceil(Math.max(...polygon.map(p=>p[0]))*n)+1)
 const range=(i:number):[number,number]=>{
  let low=0,high=n-i
  for(let axis=0;axis<3;axis++){
   const base=a[axis]+i/n*e1[axis],s=e2[axis]/n
   if(s===0){if(base<min[axis]||base>max[axis])return[1,0];continue}
   const x=(min[axis]-base)/s,y=(max[axis]-base)/s
   low=Math.max(low,Math.ceil(Math.min(x,y))-1);high=Math.min(high,Math.floor(Math.max(x,y))+1)
  }
  return[low,high]
 }
 return{i0,i1,range}
}

/** 每个面的包围盒（6 个数：minX minY minZ maxX maxY maxZ），供分块标记跳过与块无关的面。 */
function faceBounds(vertices: Float64Array, faces: Uint32Array): Float32Array {
  const out = new Float32Array((faces.length / 3) * 6)
  for (let f = 0; f + 2 < faces.length; f += 3) {
    const box = (f / 3) * 6
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let k = 0; k < 3; k++) {
      const i = faces[f + k] * 3
      const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2]
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (z < minZ) minZ = z
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (z > maxZ) maxZ = z
    }
    out[box] = minX
    out[box + 1] = minY
    out[box + 2] = minZ
    out[box + 3] = maxX
    out[box + 4] = maxY
    out[box + 5] = maxZ
  }
  return out
}

/** Mark every cell the surface passes through, by dense barycentric sampling at < voxelSize
 *  spacing (so no crossed cell is skipped). `strict` skips samples outside this grid instead of
 *  clamping them onto the boundary —分块时必须用严格模式，否则块外的采样会被夹到块边界上，
 *  在接缝处凭空多出表面单元。给了 `bounds` 时跳过与网格不相交的面；采样点都在面的包围盒内，
 *  跳过的面不可能在本网格里留下单元，因此只省时间、不改结果。分块网格带 `indexOrigin`/`indexOffset`
 *  时，单元下标一律按整格原点算：采样点正好落在单元边界（轴对齐场景很常见）时，分块与单格会给出
 *  同一个下标，接缝既不丢单元也不多单元。 */
function voxelizeSurface(
  vertices: Float64Array,
  faces: Uint32Array,
  g: Grid,
  strict = false,
  bounds?: Float32Array,
  work?:VoxelWork,
): Uint8Array {
  const occ = new Uint8Array(g.nx * g.ny * g.nz)
  const { origin, voxelSizeM } = g
  const gridMax: [number, number, number] = [
    origin[0] + g.nx * voxelSizeM,
    origin[1] + g.ny * voxelSizeM,
    origin[2] + g.nz * voxelSizeM,
  ]
  // 分块时按整格原点算下标，保证与单格跑法逐位一致；未分块时 indexOrigin 就是 origin。
  const originX = g.indexOrigin ? g.indexOrigin[0] : origin[0]
  const originY = g.indexOrigin ? g.indexOrigin[1] : origin[1]
  const originZ = g.indexOrigin ? g.indexOrigin[2] : origin[2]
  const offsetX = g.indexOffset ? g.indexOffset[0] : 0
  const offsetY = g.indexOffset ? g.indexOffset[1] : 0
  const offsetZ = g.indexOffset ? g.indexOffset[2] : 0
  const mark = (px: number, py: number, pz: number) => {
    const ix = Math.floor((px - originX) / voxelSizeM) - offsetX
    const iy = Math.floor((py - originY) / voxelSizeM) - offsetY
    const iz = Math.floor((pz - originZ) / voxelSizeM) - offsetZ
    if (strict) {
      if (ix < 0 || iy < 0 || iz < 0 || ix >= g.nx || iy >= g.ny || iz >= g.nz) return
      occ[idxOf(g, ix, iy, iz)] = 1
      return
    }
    occ[idxOf(g, Math.min(g.nx - 1, Math.max(0, ix)), Math.min(g.ny - 1, Math.max(0, iy)), Math.min(g.nz - 1, Math.max(0, iz)))] = 1
  }
  const step = voxelSizeM * 0.5
  // 面包围盒存成 float32：与网格边界“恰好相切”的面（分块边界正好落在场景坐标平面上时很常见）
  // 会被舍入误差误判为不相交，从而在接缝处丢单元。放宽一个体素——只可能多算，不可能漏面。
  const margin = bounds ? voxelSizeM : 0
  for (let f = 0; f + 2 < faces.length; f += 3) {
    if(work){work.facts.facesVisited++;if(work.facts.facesVisited>work.facts.maxFaceVisits)work.fail('FACE_WORK_BUDGET',{requiredFaceVisitsAtLeast:work.facts.facesVisited})}
    if (bounds) {
      const box = (f / 3) * 6
      if (
        bounds[box + 3] + margin < origin[0] || bounds[box] - margin > gridMax[0] ||
        bounds[box + 4] + margin < origin[1] || bounds[box + 1] - margin > gridMax[1] ||
        bounds[box + 5] + margin < origin[2] || bounds[box + 2] - margin > gridMax[2]
      ) continue
    }
    const ia = faces[f] * 3
    const ib = faces[f + 1] * 3
    const ic = faces[f + 2] * 3
    const ax = vertices[ia], ay = vertices[ia + 1], az = vertices[ia + 2]
    const bx = vertices[ib], by = vertices[ib + 1], bz = vertices[ib + 2]
    const cx = vertices[ic], cy = vertices[ic + 1], cz = vertices[ic + 2]
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az
    const len1 = Math.hypot(e1x, e1y, e1z)
    const len2 = Math.hypot(e2x, e2y, e2z)
    const len3 = Math.hypot(cx - bx, cy - by, cz - bz)
    const n = Math.max(1, Math.ceil(Math.max(len1, len2, len3) / step))
    const ranges=strict?clippedSampleRanges([ax,ay,az],[e1x,e1y,e1z],[e2x,e2y,e2z],n,g):{i0:0,i1:n,range:(i:number):[number,number]=>[0,n-i]}
    let samples=0
    for(let i=ranges.i0;i<=ranges.i1;i++){const[lo,hi]=ranges.range(i);samples+=Math.max(0,hi-lo+1);if(work&&samples+work.facts.samplesProcessed>work.facts.maxSamples)work.fail('SAMPLE_WORK_BUDGET',{requiredSamplesAtLeast:samples+work.facts.samplesProcessed})}
    if(work){
      if(!Number.isSafeInteger(samples)||work.facts.samplesProcessed+samples>work.facts.maxSamples)work.fail('SAMPLE_WORK_BUDGET',{requiredSamplesAtLeast:work.facts.samplesProcessed+samples})
      if(work.facts.facesRasterized%4096===0)work.emit('raster-face')
    }
    for (let i = ranges.i0; i <= ranges.i1; i++) {
      const[j0,j1]=ranges.range(i)
      for (let j = j0; j <= j1; j++) {
        const u = i / n
        const v = j / n
        mark(ax + u * e1x + v * e2x, ay + u * e1y + v * e2y, az + u * e1z + v * e2z)
      }
    }
    if(work){work.facts.samplesProcessed+=samples;work.facts.facesRasterized++}
  }
  return occ
}

/** BFS the exterior through empty cells from the grid's boundary shell. Returns `reached`. */
function floodExterior(occ: Uint8Array, g: Grid): Uint8Array {
  const reached = new Uint8Array(occ.length)
  const queue: number[] = []
  const push = (x: number, y: number, z: number) => {
    const i = idxOf(g, x, y, z)
    if (!occ[i] && !reached[i]) {
      reached[i] = 1
      queue.push(x, y, z)
    }
  }
  for (let y = 0; y < g.ny; y++)
    for (let x = 0; x < g.nx; x++) {
      push(x, y, 0)
      push(x, y, g.nz - 1)
    }
  for (let z = 0; z < g.nz; z++)
    for (let x = 0; x < g.nx; x++) {
      push(x, 0, z)
      push(x, g.ny - 1, z)
    }
  for (let z = 0; z < g.nz; z++)
    for (let y = 0; y < g.ny; y++) {
      push(0, y, z)
      push(g.nx - 1, y, z)
    }
  let head = 0
  while (head < queue.length) {
    const x = queue[head++]
    const y = queue[head++]
    const z = queue[head++]
    if (x > 0) push(x - 1, y, z)
    if (x + 1 < g.nx) push(x + 1, y, z)
    if (y > 0) push(x, y - 1, z)
    if (y + 1 < g.ny) push(x, y + 1, z)
    if (z > 0) push(x, y, z - 1)
    if (z + 1 < g.nz) push(x, y, z + 1)
  }
  return reached
}

/** Greedy maximal-box merge over the solid cells (solid = not reached by the exterior). Grows
 *  each seed along +X, then +Y, then +Z while the whole slab stays solid and unconsumed. */
function greedyBoxes(solid: Uint8Array, g: Grid, maxBoxes: number,work?:VoxelWork): DecomposeBox[] | undefined {
  const consumed = new Uint8Array(solid.length)
  const free = (x: number, y: number, z: number) => {
    const i = idxOf(g, x, y, z)
    return solid[i] === 1 && consumed[i] === 0
  }
  const boxes: DecomposeBox[] = []
  const { origin, voxelSizeM } = g
  for (let z = 0; z < g.nz; z++)
    for (let y = 0; y < g.ny; y++)
      for (let x = 0; x < g.nx; x++) {
        if (!free(x, y, z)) continue
        // grow +X
        let x2 = x
        while (x2 + 1 < g.nx && free(x2 + 1, y, z)) x2++
        // grow +Y (whole x-row must be free)
        let y2 = y
        grow_y: while (y2 + 1 < g.ny) {
          for (let xx = x; xx <= x2; xx++) if (!free(xx, y2 + 1, z)) break grow_y
          y2++
        }
        // grow +Z (whole xy-slab must be free)
        let z2 = z
        grow_z: while (z2 + 1 < g.nz) {
          for (let yy = y; yy <= y2; yy++) for (let xx = x; xx <= x2; xx++) if (!free(xx, yy, z2 + 1)) break grow_z
          z2++
        }
        for (let zz = z; zz <= z2; zz++)
          for (let yy = y; yy <= y2; yy++) for (let xx = x; xx <= x2; xx++) consumed[idxOf(g, xx, yy, zz)] = 1
        const minW = [origin[0] + x * voxelSizeM, origin[1] + y * voxelSizeM, origin[2] + z * voxelSizeM]
        const maxW = [
          origin[0] + (x2 + 1) * voxelSizeM,
          origin[1] + (y2 + 1) * voxelSizeM,
          origin[2] + (z2 + 1) * voxelSizeM,
        ]
        boxes.push({
          center: [(minW[0] + maxW[0]) / 2, (minW[1] + maxW[1]) / 2, (minW[2] + maxW[2]) / 2],
          halfExtents: [(maxW[0] - minW[0]) / 2, (maxW[1] - minW[1]) / 2, (maxW[2] - minW[2]) / 2],
        })
        work?.boxCollector?.({min:[x+(g.indexOffset?.[0]??0),y+(g.indexOffset?.[1]??0),z+(g.indexOffset?.[2]??0)],max:[x2+1+(g.indexOffset?.[0]??0),y2+1+(g.indexOffset?.[1]??0),z2+1+(g.indexOffset?.[2]??0)]})
        if (boxes.length > maxBoxes){if(work)work.fail('WORKING_BOX_BUDGET',{requiredBoxesAtLeast:boxes.length});return undefined}
      }
  return boxes.length > 0 ? boxes : undefined
}

/** 单格分解：表面单元，或（fillInterior）外部泛洪够不到的单元。 */
function decomposeOnGrid(
  vertices: Float64Array,
  faces: Uint32Array,
  grid: Grid,
  fillInterior: boolean,
  maxBoxes: number,
): DecomposeBox[] | undefined {
  const surface = voxelizeSurface(vertices, faces, grid)
  let solid = surface
  if (fillInterior) {
    const reached = floodExterior(surface, grid)
    solid = new Uint8Array(surface.length)
    for (let i = 0; i < solid.length; i++) solid[i] = reached[i] ? 0 : 1
  }
  return greedyBoxes(solid, grid, maxBoxes)
}

/** 每块的最大尺寸：反复对半切当前最大的轴，直到块的单元数落在预算内。 */
function tileChunkSize(dims: [number, number, number], maxCells: number): [number, number, number] | undefined {
  if (!(maxCells >= 8)) return undefined
  const size: [number, number, number] = [dims[0], dims[1], dims[2]]
  while (size[0] * size[1] * size[2] > maxCells) {
    if (size[0] === 1 && size[1] === 1 && size[2] === 1) break
    const axis = size[0] >= size[1] && size[0] >= size[2] ? 0 : size[1] >= size[2] ? 1 : 2
    size[axis] = Math.max(1, Math.ceil(size[axis] / 2))
  }
  return size[0] * size[1] * size[2] <= maxCells ? size : undefined
}

/** 把 n 个单元均分成每段 ≤ chunk 的区间（均衡切分，避免留下 1 格的尾巴）。 */
function axisRanges(n: number, chunk: number): Array<[number, number]> {
  const count = Math.max(1, Math.ceil(n / chunk))
  const ranges: Array<[number, number]> = []
  for (let i = 0; i < count; i++) ranges.push([Math.floor((i * n) / count), Math.floor(((i + 1) * n) / count)])
  return ranges
}

/**
 * 表面模式的分块分解：同一晶格、同一体素，只是把单元空间切成块分别做表面标记与贪心合并。
 * 单元严格分区（块之间既不重叠也不留缝），因此覆盖与单格结果逐单元一致；块边界只影响贪心
 * 合并能跨多远，多出的盒在接缝处面贴面相邻，对碰撞没有影响。
 * `maxBoxes` 是**整个结果**的硬上限：逐块累加，超出即返回 `undefined`，由调用方显式提高预算，
 * 绝不通过放大体素来“压”盒数。
 */
function decomposeSurfaceTiles(
  vertices: Float64Array,
  faces: Uint32Array,
  min: [number, number, number],
  voxelSizeM: number,
  dims: [number, number, number],
  maxGridCells: number,
  maxBoxes: number,
): { boxes: DecomposeBox[]; tiles: number } | undefined {
  const chunk = tileChunkSize(dims, maxGridCells)
  if (!chunk) return undefined
  const xs = axisRanges(dims[0], chunk[0])
  const ys = axisRanges(dims[1], chunk[1])
  const zs = axisRanges(dims[2], chunk[2])
  const bounds = faceBounds(vertices, faces)
  const boxes: DecomposeBox[] = []
  let tiles = 0
  for (const [x0, x1] of xs)
    for (const [y0, y1] of ys)
      for (const [z0, z1] of zs) {
        const grid: Grid = {
          nx: x1 - x0,
          ny: y1 - y0,
          nz: z1 - z0,
          origin: [
            min[0] - voxelSizeM + x0 * voxelSizeM,
            min[1] - voxelSizeM + y0 * voxelSizeM,
            min[2] - voxelSizeM + z0 * voxelSizeM,
          ],
          voxelSizeM,
          indexOrigin: [min[0] - voxelSizeM, min[1] - voxelSizeM, min[2] - voxelSizeM],
          indexOffset: [x0, y0, z0],
        }
        const surface = voxelizeSurface(vertices, faces, grid, true, bounds)
        // 单块也按总预算判：块内超预算时不必等累加就能失败。
        const tileBoxes = greedyBoxes(surface, grid, maxBoxes)
        if (tileBoxes) {
          // 总盒数是整个结果的硬上限：跨块累加后再判，超出即失败（不粗化体素、不截断）。
          if (boxes.length + tileBoxes.length > maxBoxes) return undefined
          boxes.push(...tileBoxes)
        } else if (surface.some((cell) => cell === 1)) return undefined // 空块（晶格角落没有表面）合法
        tiles += 1
      }
  return boxes.length > 0 ? { boxes, tiles } : undefined
}

export type VoxelDetailedResult={status:'ok';result:VoxelDecomposeResult;diagnostics:VoxelDiagnostics}|{status:'failed';reason:string;diagnostics:VoxelDiagnostics}
/** 固定精度的表面路径：格点内存只决定分块，不改变pitch；精确减碎片后再判最终盒预算。 */
export function decomposeConcaveToBoxesDetailed(vertices:Float64Array,faces:Uint32Array,options:VoxelDecomposeOptions={},progress?:(facts:VoxelDiagnostics)=>void):VoxelDetailedResult{
 let work:VoxelWork
 try{
  work=new VoxelWork(vertices,faces,options,progress)
  if(faces.length<3)work.fail('EMPTY_INPUT')
  const bounds=meshBounds(vertices);if(!bounds)work.fail('EMPTY_GEOMETRY')
  if(options.fillInterior!==false){
   const result=decomposeLegacy(vertices,faces,options)
   if(!result)work.fail('LEGACY_DECOMPOSITION_UNAVAILABLE')
   work.facts.effectiveVoxelSizeM=result.voxelSizeM;work.facts.gridDims=result.gridDims;work.facts.tiles=result.tiles;work.facts.boxesAfterMerge=result.boxes.length;work.emit('complete')
   return{status:'ok',result:{...result,diagnostics:{...work.facts}},diagnostics:{...work.facts}}
  }
  const pitch=options.voxelSizeM??Math.min(VOXEL_DECOMPOSE_DEFAULTS.maxVoxelSizeM,Math.max(Math.max(...bounds.max.map((v,i)=>v-bounds.min[i]))/(options.targetResolution??VOXEL_DECOMPOSE_DEFAULTS.targetResolution),VOXEL_DECOMPOSE_DEFAULTS.minVoxelSizeM))
  if(!Number.isFinite(pitch)||pitch<=0)throw new Error('INVALID_VOXEL_SIZE: voxelSizeM必须是有限正数（米）')
  const dims=gridDimsFor(bounds.min,bounds.max,pitch),cells=dims[0]*dims[1]*dims[2]
  if(dims.some(n=>!Number.isSafeInteger(n)||n<1)||!Number.isSafeInteger(cells))work.fail('GRID_RANGE')
  work.facts.effectiveVoxelSizeM=pitch;work.facts.gridDims=dims;work.facts.gridCells=cells
  const chunk=tileChunkSize(dims,work.facts.maxGridCells);if(!chunk)work.fail('GRID_WORK_BUDGET')
  const ranges=dims.map((n,i)=>axisRanges(n,chunk[i]!))
  const totalTiles=ranges.reduce((n,r)=>n*r.length,1);work.facts.totalTiles=totalTiles
  if(totalTiles>work.facts.maxTiles)work.fail('TILE_WORK_BUDGET')
  const initialBytes=vertices.byteLength+faces.byteLength
  work.memory(initialBytes+faces.length/3*24+Math.min(cells,work.facts.maxGridCells)*2+work.facts.maxWorkingBoxes*128)
  const faceBoxes=totalTiles>1?faceBounds(vertices,faces):undefined
  const origin:[number,number,number]=bounds.min.map(v=>v-pitch) as [number,number,number]
  let lattice:LatticeBox[]=[]
  for(const [x0,x1]of ranges[0])for(const[y0,y1]of ranges[1])for(const[z0,z1]of ranges[2]){
   const grid:Grid={nx:x1-x0,ny:y1-y0,nz:z1-z0,origin:[origin[0]+x0*pitch,origin[1]+y0*pitch,origin[2]+z0*pitch],voxelSizeM:pitch,indexOrigin:origin,indexOffset:[x0,y0,z0]}
   work.emit('tile-start')
   const surface=voxelizeSurface(vertices,faces,grid,totalTiles>1,faceBoxes,work)
   const tile:LatticeBox[]=[];work.boxCollector=box=>tile.push(box)
   greedyBoxes(surface,grid,work.facts.maxWorkingBoxes,work);work.boxCollector=undefined
   work.facts.boxesBeforeMerge+=tile.length
   // 临时描述有硬限；先在本块和已有集合各自精确合并，不以总bbox压掉空气。
   const mergedTile=mergeLatticeBoxes(tile)
   if(lattice.length+mergedTile.length>work.facts.maxWorkingBoxes){lattice=mergeLatticeBoxes(lattice);if(lattice.length+mergedTile.length>work.facts.maxWorkingBoxes)work.fail('WORKING_BOX_BUDGET',{requiredBoxesAtLeast:lattice.length+mergedTile.length})}
   lattice=mergeLatticeBoxes([...lattice,...mergedTile]);work.facts.tiles++;work.facts.boxesAfterMerge=lattice.length;work.emit('tile-complete')
  }
  if(!lattice.length)work.fail('EMPTY_SURFACE')
  if(lattice.length>work.facts.maxBoxes)work.fail('BOX_BUDGET',{requiredBoxesAtLeast:lattice.length})
  const boxes=lattice.map(box=>({center:box.min.map((v,a)=>origin[a]+(v+box.max[a])*pitch/2) as [number,number,number],halfExtents:box.min.map((v,a)=>(box.max[a]-v)*pitch/2) as [number,number,number]}))
  work.emit('complete');const diagnostics={...work.facts}
  return{status:'ok',result:{boxes,voxelSizeM:pitch,gridDims:dims,fillInterior:false,tiles:totalTiles,diagnostics},diagnostics}
 }catch(error){if(error instanceof VoxelDecomposeError)return{status:'failed',reason:error.reason,diagnostics:error.diagnostics};throw error}
}

/**
 * Decompose a (concave) triangle mesh into axis-aligned convex boxes that respect its hollows.
 * Returns `undefined` when the mesh has no volume, or when the result would exceed `maxBoxes`
 * — the hard limit on the **total** box count, applied the same way in the single-grid and tiled
 * runs (the caller should then fall back to a single convex hull — except for environments, where
 * a hull is forbidden and the caller must raise `maxBoxes` or coarsen `voxelSizeM` explicitly).
 */
export function decomposeConcaveToBoxes(
  vertices: Float64Array,
  faces: Uint32Array,
  options: VoxelDecomposeOptions = {},
): VoxelDecomposeResult | undefined {
 if(options.fillInterior===false){const detail=decomposeConcaveToBoxesDetailed(vertices,faces,options);return detail.status==='ok'?detail.result:undefined}
 return decomposeLegacy(vertices,faces,options)
}
function decomposeLegacy(vertices:Float64Array,faces:Uint32Array,options:VoxelDecomposeOptions):VoxelDecomposeResult|undefined{
  if (faces.length < 3) return undefined
  const bounds = meshBounds(vertices)
  if (!bounds) return undefined

  const fillInterior = options.fillInterior !== false
  const targetResolution = options.targetResolution ?? VOXEL_DECOMPOSE_DEFAULTS.targetResolution
  const maxGridCells = options.maxGridCells ?? VOXEL_DECOMPOSE_DEFAULTS.maxGridCells
  const maxBoxes = options.maxBoxes ?? VOXEL_DECOMPOSE_DEFAULTS.maxBoxes
  const targetBoxes = options.targetBoxes ?? VOXEL_DECOMPOSE_DEFAULTS.targetBoxes
  const explicitVoxel = options.voxelSizeM
  // 显式体素必须是有限正数：0 会让 gridDimsFor 返回 Infinity 维，随后填充模式的粗化 while
  // （0×1.25 恒为 0）与表面分块的 tileChunkSize（Infinity 对半仍是 Infinity）都不收敛——是同步
  // 无限循环，会卡死宿主主线程，AbortSignal 也到不了这里。physicalize 把 request_json 的
  // voxelSizeM 原样传入且 Tool 面不校验数值，所以在公共入口显式失败；合法毫米精度与分块合同不变。
  if (explicitVoxel !== undefined && !(typeof explicitVoxel === 'number' && Number.isFinite(explicitVoxel) && explicitVoxel > 0)) {
    throw new Error(`INVALID_VOXEL_SIZE: voxelSizeM 必须是有限正数（米），收到 ${String(explicitVoxel)}`)
  }

  // 显式体素是绑定值：原样使用。表面模式用同一晶格分块换取内存；填充模式不能分块，只能粗化，
  // 并在结果里报告实际体素，调用方能据 voxelSizeM 发现偏差。
  if (explicitVoxel !== undefined) {
    let voxelSizeM = explicitVoxel
    let dims = gridDimsFor(bounds.min, bounds.max, voxelSizeM)
    if (dims[0] * dims[1] * dims[2] > maxGridCells && fillInterior) {
      while (dims[0] * dims[1] * dims[2] > maxGridCells) {
        voxelSizeM *= 1.25
        dims = gridDimsFor(bounds.min, bounds.max, voxelSizeM)
      }
    }
    if (dims[0] * dims[1] * dims[2] > maxGridCells) {
      const tiled = decomposeSurfaceTiles(vertices, faces, bounds.min, voxelSizeM, dims, maxGridCells, maxBoxes)
      if (!tiled) return undefined
      return { boxes: tiled.boxes, voxelSizeM, gridDims: dims, fillInterior, tiles: tiled.tiles }
    }
    const grid = makeGridAt(bounds.min, voxelSizeM, dims)
    const boxes = decomposeOnGrid(vertices, faces, grid, fillInterior, maxBoxes)
    if (!boxes) return undefined
    return { boxes, voxelSizeM, gridDims: dims, fillInterior, tiles: 1 }
  }

  // 自动体素：按目标分辨率取起点的既有物体路径。表面预算不够时会粗化体素（见模块注释），
  // 需要固定通行精度的环境必须显式给 voxelSizeM。
  let voxelSizeM: number | undefined
  let best: { boxes: DecomposeBox[]; grid: Grid } | undefined
  for (let attempt = 0; attempt < 8; attempt++) {
    const grid = makeGridAuto(bounds.min, bounds.max, { targetResolution, maxGridCells, voxelSizeM })
    const boxes = decomposeOnGrid(vertices, faces, grid, fillInterior, maxBoxes)
    if (boxes) {
      best = { boxes, grid }
      if (boxes.length <= targetBoxes) break
    }
    const nextVoxel = (best?.grid.voxelSizeM ?? grid.voxelSizeM) * 1.3
    if (nextVoxel > VOXEL_DECOMPOSE_DEFAULTS.maxVoxelSizeM) break
    voxelSizeM = nextVoxel
  }
  if (!best || best.boxes.length > maxBoxes) return undefined
  return {
    boxes: best.boxes,
    voxelSizeM: best.grid.voxelSizeM,
    gridDims: [best.grid.nx, best.grid.ny, best.grid.nz],
    fillInterior,
    tiles: 1,
  }
}

/** 自动体素的网格：起点由 `voxelSizeM`（重试时）或目标分辨率给出，再粗化到格点预算内。 */
function makeGridAuto(
  min: [number, number, number],
  max: [number, number, number],
  opts: { targetResolution: number; maxGridCells: number; voxelSizeM?: number },
): Grid {
  const voxelSizeM = opts.voxelSizeM ?? autoVoxelSize(min, max, opts.targetResolution, opts.maxGridCells)
  const dims = gridDimsFor(min, max, voxelSizeM)
  return makeGridAt(min, voxelSizeM, dims)
}
