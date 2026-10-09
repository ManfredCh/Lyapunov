import * as THREE from "three"
import { isGaussianCameraFrame } from "../../lyapunov-contracts/src/gaussian-frame.ts"

/** 大源的交互预览使用固定 Spark 的 tiny-LOD，仍保留完整输入；小/未知源沿质量路径。 */
export function splatInitializationLod(sourcePoints:number|null):true|"quality"{
 return sourcePoints!==null&&Number.isFinite(sourcePoints)&&sourcePoints>=1_000_000?true:"quality"
}

/**
 * 已识别"高精场景"的判据（只用于 auto 画质的默认预算，不改用户显式画质）：
 *  · 新标准 High（`first_camera_opengl_v3`）总是按高精场景对待；
 *  · 旧合格 High（`first_camera_c2w_v2`）只在**大型**（源点数≥100 万，与 tiny-LOD 同一阈值）时对待。
 * 普通/未知资产没有标记，返回 false，原 auto 预算不变。
 */
export function recognizedHighSplatVisual(visual:Record<string,unknown>|undefined):boolean{
  const frame=visual?.gaussianCameraFrame
  if(!isGaussianCameraFrame(frame))return false
  if(frame==="first-camera-opengl-v3")return true
  const count=visual?.sourcePointCount
  return typeof count==="number"&&Number.isSafeInteger(count)&&count>=1_000_000
}

/** 交互安全初值；实际硬件签收前不能把这些参数当成帧率保证。全量源和 LOD 树仍保留。 */
export const SPLAT_INTERACTIVE_BUDGET = Object.freeze({
  lodSplatCount: 500_000,
  lodRenderScale: 2,
  minSortIntervalMs: 50,
  maxPixelRatio: 1,
})
export type SplatQuality = 'auto' | 'fast' | 'balanced' | 'quality'
export interface SplatInteractiveBudget {lodSplatCount:number;lodRenderScale:number;minSortIntervalMs:number;maxPixelRatio:number}
/**
 * 只改变当前绘制LOD；原始点和解码数据保持。未知设备先取较小预算，可由用户调画质。
 *
 * `options.recognizedHighScene` 只在 `quality==='auto'` 且**非软件渲染**时把上限提到既有的 500k：
 * 数百万高斯的已识别场景此前在非 NVIDIA 设备上只画 100k/250k，默认画面"一团糊"；软件渲染保持
 * 既有低预算。用户显式 fast/balanced/quality 永远优先于这条默认。
 */
export function interactiveSplatBudget(vendorFamily:string,quality:SplatQuality='auto',options:{recognizedHighScene?:boolean}={}):SplatInteractiveBudget {
 const count=quality==='fast'?100_000:quality==='balanced'?250_000:quality==='quality'?500_000
  :options.recognizedHighScene===true&&vendorFamily!=='software'?500_000
  :vendorFamily==='nvidia'?500_000:vendorFamily==='amd'?250_000:vendorFamily==='software'?50_000:100_000
 return {...SPLAT_INTERACTIVE_BUDGET,lodSplatCount:count}
}

export interface SplatPointSource {
  numSplats: number
  getSplat(index: number): { center: THREE.Vector3; opacity: number }
}

type SplatSourceContainer = SplatPointSource & { lodSplats?: SplatPointSource }
export function splatDataSource(mesh: { packedSplats?: SplatSourceContainer; extSplats?: SplatSourceContainer }): SplatPointSource | undefined {
  return [mesh.packedSplats?.lodSplats, mesh.extSplats?.lodSplats, mesh.packedSplats, mesh.extSplats]
    .find(source => source && Number.isSafeInteger(source.numSplats) && source.numSplats > 0)
}

export function splatPointCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
}

/** 挂载时的缓存是源坐标中心 AABB；变换交给既有源坐标 wrapper，只应用一次。 */
export function cachedSplatCenterBounds(value: unknown): THREE.Box3 | undefined {
  if (!value || typeof value !== "object") return
  const { min, max } = value as { min?: unknown; max?: unknown }
  if (!Array.isArray(min) || !Array.isArray(max) || min.length !== 3 || max.length !== 3) return
  if (![...min, ...max].every(item => typeof item === "number" && Number.isFinite(item))) return
  if (min.some((item, axis) => item > max[axis])) return
  return new THREE.Box3(new THREE.Vector3(min[0], min[1], min[2]), new THREE.Vector3(max[0], max[1], max[2]))
}

/** 旧登记资源的精确中心边界：常数内存，每片同时受点数与耗时约束。 */
export async function scanSplatCenterBounds(source: SplatPointSource, options: {
  signal?: AbortSignal
  current?: () => boolean
  maxPointsPerSlice?: number
  maxSliceMs?: number
  yieldToUi?: () => Promise<void>
  now?: () => number
} = {}): Promise<THREE.Box3 | undefined> {
  const check = () => {
    options.signal?.throwIfAborted()
    if (options.current && !options.current()) throw new DOMException("泼溅加载已不属于当前场景", "AbortError")
  }
  const count = splatPointCount(source.numSplats)
  check()
  if (count === null) return
  const limit = Math.max(1, Math.floor(options.maxPointsPerSlice ?? 4096))
  const sliceMs = Math.max(1, options.maxSliceMs ?? 4)
  const now = options.now ?? (() => performance.now())
  const yieldToUi = options.yieldToUi ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)))
  const bounds = new THREE.Box3()
  let index = 0
  while (index < count) {
    check()
    const started = now()
    let sliceCount = 0
    do {
      const { center } = source.getSplat(index++)
      if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(center.z)) throw new Error("VIEWER_SPLAT_BOUNDS_NOT_FINITE: 解码后的中心含非有限值")
      bounds.expandByPoint(center)
    } while (index < count && ++sliceCount < limit && now() - started < sliceMs)
    if (index < count) await yieldToUi()
  }
  check()
  return bounds
}

export function frameSampleSummary(samples: readonly number[] | undefined) {
  const values = samples ?? []
  const sorted = [...values].sort((a, b) => a - b)
  return {
    samples: values.length,
    average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    p95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))]! : null,
  }
}

export function appendFrameSample(samples: number[], value: number): void {
  if (!Number.isFinite(value) || value < 0) return
  samples.push(value)
  if (samples.length > 120) samples.shift()
}

/** 读取正在使用的上下文，不新建 canvas。扩展不可得时保留未知，不借用宿主 GLX。 */
export function viewerWebglFacts(renderer: Pick<THREE.WebGLRenderer, "getContext" | "domElement">) {
  let vendor: string | null = null, rendererName: string | null = null, version: string | null = null
  let contextLost: boolean | null = null, unmasked = false
  let bufferWidth: number | null = null, bufferHeight: number | null = null
  let antialias: boolean | null = null, preserveDrawingBuffer: boolean | null = null, samples: number | null = null
  try {
    const gl = renderer.getContext()
    contextLost = gl.isContextLost()
    bufferWidth = gl.drawingBufferWidth; bufferHeight = gl.drawingBufferHeight
    const attributes = gl.getContextAttributes?.()
    antialias = typeof attributes?.antialias === "boolean" ? attributes.antialias : null
    preserveDrawingBuffer = typeof attributes?.preserveDrawingBuffer === "boolean" ? attributes.preserveDrawingBuffer : null
    const actualSamples: unknown = gl.SAMPLES === undefined ? null : gl.getParameter(gl.SAMPLES)
    samples = typeof actualSamples === "number" && Number.isSafeInteger(actualSamples) && actualSamples >= 0 ? actualSamples : null
    const extension = gl.getExtension("WEBGL_debug_renderer_info")
    const text = (parameter: number): string | null => {
      const value: unknown = gl.getParameter(parameter)
      return typeof value === "string" ? value : null
    }
    vendor = text(extension?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR)
    rendererName = text(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)
    version = text(gl.VERSION)
    unmasked = extension !== null
  } catch { /* 读数不可得时保持 null，不能推断为软件或硬件。 */ }
  const family = `${vendor ?? ""} ${rendererName ?? ""}`.toLowerCase()
  const software = /(llvmpipe|softpipe|swiftshader|software rasterizer)/.test(family)
  const vendorFamily = software ? "software" : !unmasked ? "unknown"
    : /(nvidia|geforce|quadro)/.test(family) ? "nvidia"
    : /(amd|radeon|radeonsi|ati)/.test(family) ? "amd"
    : /(intel|iris|uhd|arc)/.test(family) ? "intel" : "unknown"
  return { vendor, renderer: rendererName, version, unmasked, vendorFamily, softwareRendering: software ? true : vendorFamily === "unknown" ? null : false, contextLost, drawingBuffer: { width: bufferWidth, height: bufferHeight }, contextAttributes: { antialias, preserveDrawingBuffer }, samples }
}
