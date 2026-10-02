import { describe, expect, test } from "bun:test"
import * as THREE from "three"
import { PackedSplats, SparkRenderer, SplatMesh } from "@sparkjsdev/spark"
import { SceneViewer } from "../src/index.ts"
import { objectWorldBounds } from "../src/framing.ts"
import { FrameProjection } from "../src/projection.ts"
import { retainedSplats, retainedSplatBytes, retainedSplatFootprint,retainSplatData, restoreSplatData, SplatRetentionCache, splatRetentionBudget } from "../src/splat-retention.ts"
import { centralSplatBounds } from "../src/first-person.ts"
import { assessSplatDecoded } from "../src/splat-support.ts"
import { appendFrameSample, cachedSplatCenterBounds, frameSampleSummary, scanSplatCenterBounds, splatDataSource, splatPointCount,splatInitializationLod, SPLAT_INTERACTIVE_BUDGET, viewerWebglFacts,interactiveSplatBudget, type SplatPointSource } from "../src/splat-runtime.ts"
import type { ResourceRef } from "../../lyapunov-contracts/src/types.ts"

function points(count: number, read = (index: number) => [index, index * 2, -index] as const): SplatPointSource {
  const center = new THREE.Vector3()
  return { numSplats: count, getSplat(index) { return { center: center.set(...read(index)), opacity: 1 } } }
}

describe("泼溅 LOD 数据源与真实中心边界（无 GUI/GPU）", () => {
  test("固定 Spark 的 lod-only 原始容器 0 点，实际 LOD 数据仍有有限且正常的边界", async () => {
    const lod = new PackedSplats()
    for (const center of [new THREE.Vector3(-2, -4, 0), new THREE.Vector3(5, 7, 9)])
      lod.pushSplat(center, new THREE.Vector3(.01, .01, .01), new THREE.Quaternion(), 1, new THREE.Color(1, 1, 1))
    const base = new PackedSplats({ lodSplats: lod })
    const mesh = new SplatMesh({ packedSplats: base, enableLod: true })
    await mesh.initialized
    try {
      expect(mesh.numSplats).toBe(0)
      expect(mesh.getBoundingBox(false).isEmpty()).toBe(true)
      const source = splatDataSource(mesh)!
      expect(source).toBe(lod)
      const bounds = (await scanSplatCenterBounds(source))!
      expect(bounds.min.toArray()).toEqual([-2, -4, 0])
      expect(bounds.max.toArray()).toEqual([5, 7, 9])
      expect(centralSplatBounds(source.numSplats, index => source.getSplat(index))?.isEmpty()).toBe(false)
      expect(assessSplatDecoded({ numSplats: source.numSplats, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() } }).cause).toBe("ok")
    } finally { mesh.dispose() }
  })

  test("兼容扩展 LOD 与无 LOD 基础源，不把空原始容器优先于有效 LOD", () => {
    const lod = points(3), base = points(2)
    expect(splatDataSource({ packedSplats: { ...points(0), lodSplats: lod } })).toBe(lod)
    expect(splatDataSource({ extSplats: { ...base, lodSplats: lod } })).toBe(lod)
    expect(splatDataSource({ packedSplats: base })).toBe(base)
    expect(splatDataSource({ packedSplats: points(0) })).toBeUndefined()
    expect(splatPointCount(undefined)).toBeNull()
    expect(splatPointCount(9_993_739)).toBe(9_993_739)
  })

  test("缓存只接受有限有序三轴数值；单点中心边界也保留", () => {
    expect(cachedSplatCenterBounds({ min: [1, 2, 3], max: [1, 2, 3] })?.getCenter(new THREE.Vector3()).toArray()).toEqual([1, 2, 3])
    for (const value of [{ min: [0, 0, NaN], max: [1, 1, 1] }, { min: [2, 0, 0], max: [1, 1, 1] }, { min: [0, 0], max: [1, 1, 1] }])
      expect(cachedSplatCenterBounds(value)).toBeUndefined()
  })

  test("缓存是源坐标，既有 wrapper 的 Y-up 与单位缩放只应用一次", () => {
    const viewer = Object.create(SceneViewer.prototype) as any
    const ref: ResourceRef = { resourceId: "bounds", version: 1, original: { uri: "fixture.ply", mimeType: "application/x-ply" }, representations: [], source: { units: "m", upAxis: "Y", handedness: "right", metersPerUnit: 2 } }
    const cloud = new THREE.Object3D(), group = new THREE.Group()
    group.position.set(3, 0, 0)
    group.add(viewer.wrapSourceCoordinates(ref, { kind: "splat", sourceTransformApplied: false }, cloud))
    const bounds = cachedSplatCenterBounds({ min: [-2, -4, 0], max: [5, 7, 9] })!
    const cache = new WeakMap<THREE.Object3D, THREE.Box3>([[cloud, bounds]])
    const actual = objectWorldBounds(group, cache)
    expect(actual.min.x).toBeCloseTo(-1); expect(actual.min.y).toBeCloseTo(-18); expect(actual.min.z).toBeCloseTo(-8)
    expect(actual.max.x).toBeCloseTo(13); expect(actual.max.y).toBeCloseTo(0); expect(actual.max.z).toBeCloseTo(14)
    expect(bounds.min.toArray()).toEqual([-2, -4, 0])
    expect(viewer.wrapSourceCoordinates(ref, { sourceTransformApplied: true }, cloud)).toBe(cloud)
  })

  test("完整扫描覆盖每点，按点数块真正让出事件循环", async () => {
    let reads = 0, timerRan = false
    const source = points(25), get = source.getSplat
    source.getSplat = index => { reads++; return get(index) }
    const slices: number[] = []
    setTimeout(() => { timerRan = true }, 0)
    const bounds = await scanSplatCenterBounds(source, { maxPointsPerSlice: 4, now: () => 0, yieldToUi: async () => { slices.push(reads); await new Promise<void>(resolve => setTimeout(resolve, 0)) } })
    expect(timerRan).toBe(true)
    expect(reads).toBe(25); expect(slices).toEqual([4, 8, 12, 16, 20, 24])
    expect(bounds?.min.toArray()).toEqual([0, 0, -24]); expect(bounds?.max.toArray()).toEqual([24, 48, -0])
  })

  test("耗时预算也能提前让出，不必等固定点数块跑满", async () => {
    let clock = 0, reads = 0, previous = 0
    const perSlice: number[] = [], source = points(9), get = source.getSplat
    source.getSplat = index => { clock += 2; reads++; return get(index) }
    await scanSplatCenterBounds(source, { maxPointsPerSlice: 4096, maxSliceMs: 4, now: () => clock, yieldToUi: async () => { perSlice.push(reads - previous); previous = reads } })
    expect(perSlice).toEqual([2, 2, 2, 2]); expect(reads).toBe(9)
  })

  test("取消或资源归属失效后停止扫描，不继续读后续点", async () => {
    for (const bySignal of [true, false]) {
      const controller = new AbortController(); let owned = true, reads = 0
      const source = points(25), get = source.getSplat
      source.getSplat = index => { reads++; return get(index) }
      const pending = scanSplatCenterBounds(source, { signal: controller.signal, current: () => owned, maxPointsPerSlice: 4, now: () => 0, yieldToUi: async () => { if (bySignal) controller.abort(); else owned = false } })
      await expect(pending).rejects.toMatchObject({ name: "AbortError" })
      expect(reads).toBe(4)
    }
  })

  test("释放 Loaded 时即时撤销本地后处理归属，清除旧运行读数", () => {
    const viewer = Object.create(SceneViewer.prototype) as any
    const group = new THREE.Group(); group.userData.entityId = "pending"
    const scene = new THREE.Scene(); scene.add(group)
    const controller = new AbortController()
    viewer.visualWarnings = new Map(); viewer.splatRuntime = new Map([["pending", { phase: "initializing" }]])
    viewer.geometryRevision = 0; viewer.updateAnnotationMarkers = () => {}
    viewer.release({ group, pendingSplat: { controller, cancel: () => controller.abort() } })
    expect(controller.signal.aborted).toBe(true)
    expect(group.parent).toBeNull(); expect(viewer.splatRuntime.size).toBe(0)
  })

  test("切到同 entityId 的另一场景取消旧 pending，迟到结果释放且不能重挂", async () => {
    const viewer = Object.create(SceneViewer.prototype) as any
    const controller = new AbortController(), group = new THREE.Group(); group.userData.entityId = "same-id"
    const loaded = { group, signature: "old", lodWarnings: [] as string[] }
    let resolveOld!: (object: THREE.Object3D) => void
    const oldRead = new Promise<THREE.Object3D>(resolve => { resolveOld = resolve })
    viewer.options = { onError: (error: Error) => { throw error } }; viewer.scene = new THREE.Scene(); viewer.scene.add(group)
    // Object.create不运行构造字段；setScene继续执行真实相机投影。
    viewer.cameraRigs = new Map(); viewer.cameraRigRoot = new THREE.Group(); viewer.scene.add(viewer.cameraRigRoot)
    viewer.objects = new Map([["same-id", loaded]]); viewer.mixers = new Map(); viewer.splatRuntime = new Map()
    viewer.visualWarnings = new Map(); viewer.loadingErrors = new Map(); viewer.projection = new FrameProjection()
    viewer.sun = new THREE.DirectionalLight()
    viewer.generation = 0; viewer.geometryRevision = 0; viewer.snapshot = { sceneId: "old-scene" }
    for (const method of ["setSceneEnvironment", "trackAnimation", "applyDisplay", "updateAnnotationMarkers", "syncEnvironmentMap"]) viewer[method] = () => {}
    const freshVisual = new THREE.Group()
    viewer.loadVisual = async (_entity: unknown, current: typeof loaded & { pendingSplat?: unknown }) => {
      if (current === loaded) { current.pendingSplat = { controller, cancel: () => controller.abort() }; return oldRead }
      return freshVisual
    }
    const entity = { entityId: "same-id", name: "fixture", transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [], components: { visual: { kind: "splat" } } }
    const oldLoad = viewer.startLoad(entity, loaded)
    await viewer.setScene({ sceneId: "new-scene", revision: 0, coordinates: { units: "m", upAxis: "Z", handedness: "right" }, entities: [entity] })
    expect(controller.signal.aborted).toBe(true)
    expect(viewer.objects.get("same-id")).not.toBe(loaded)
    const geometry = new THREE.BoxGeometry(), late = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
    let disposals = 0; geometry.dispose = () => { disposals++ }
    resolveOld(late); await oldLoad
    expect(disposals).toBe(1); expect(late.parent).toBeNull()
    expect(viewer.objects.get("same-id").group.children).toContain(freshVisual)
    expect(viewer.snapshot.sceneId).toBe("new-scene")
  })
})

describe("交互预算与真实读数语义（图形上下文为显式替身）", () => {
  test("已登记大源选择固定SDK的快速tiny-LOD，小源/未知沿质量路径",()=>{
    expect(splatInitializationLod(9_993_739)).toBe(true)
    expect(splatInitializationLod(1_000_000)).toBe(true)
    expect(splatInitializationLod(90_000)).toBe("quality")
    expect(splatInitializationLod(null)).toBe("quality")
    expect(splatInitializationLod(Number.NaN)).toBe("quality")
  })
  test("固定 Spark 接受保守活动点数/像素/排序预算，保留 LOD", () => {
    const spark = new SparkRenderer({ renderer: {} as THREE.WebGLRenderer, lodSplatCount: SPLAT_INTERACTIVE_BUDGET.lodSplatCount, lodRenderScale: SPLAT_INTERACTIVE_BUDGET.lodRenderScale, minSortIntervalMs: SPLAT_INTERACTIVE_BUDGET.minSortIntervalMs })
    expect(spark.enableLod).toBe(true); expect(spark.lodSplatCount).toBe(500_000)
    expect(spark.lodRenderScale).toBe(2); expect(spark.minSortIntervalMs).toBe(50)
    expect(SPLAT_INTERACTIVE_BUDGET.maxPixelRatio).toBe(1)
    // 没创建 WebGL；本例只证明 pinned 参数合同，不证明性能或实际设备。
  })

  test('实际显卡预算与用户画质分别生效，缓存跨过长任务等待仍有界',()=>{
    expect(interactiveSplatBudget('intel').lodSplatCount).toBe(100000)
    expect(interactiveSplatBudget('nvidia').lodSplatCount).toBe(500000)
    expect(interactiveSplatBudget('amd').lodSplatCount).toBe(250000)
    expect(interactiveSplatBudget('unknown').lodSplatCount).toBe(100000)
    expect(interactiveSplatBudget('intel','quality').lodSplatCount).toBe(500000)
    expect(interactiveSplatBudget('nvidia','fast').lodSplatCount).toBe(100000)
    expect(new SplatRetentionCache().ttlMs).toBe(3600000)
    expect(new SplatRetentionCache().maxEntries).toBe(2)
  })
  test("实际帧间隔样本保留长帧；空集合给未知，不冒充零延迟", () => {
    const samples: number[] = []
    expect(frameSampleSummary(samples)).toEqual({ samples: 0, average: null, p95: null })
    for (const ms of [16, 17, 240]) appendFrameSample(samples, ms)
    expect(frameSampleSummary(samples).p95).toBe(240)
    for (let index = 0; index < 125; index++) appendFrameSample(samples, 16)
    expect(samples.length).toBe(120)
  })

  test("只读取给定 Viewer 上下文，保留真实 renderer/buffer 与软件/未知结果", () => {
    for (const [rendererName, extensionAvailable, expected] of [["ANGLE (Intel, Mesa Intel Graphics)", true, "intel"], ["ANGLE (SwiftShader Device)", true, "software"], ["WebKit WebGL", false, "unknown"]] as const) {
      let calls = 0
      const gl = { VENDOR: 1, RENDERER: 2, VERSION: 3, SAMPLES: 6, drawingBufferWidth: 1440, drawingBufferHeight: 960, isContextLost: () => false, getContextAttributes: () => ({ antialias: false, preserveDrawingBuffer: true }), getExtension: () => extensionAvailable ? { UNMASKED_VENDOR_WEBGL: 4, UNMASKED_RENDERER_WEBGL: 5 } : null, getParameter: (parameter: number) => parameter === 6 ? 0 : parameter === 2 || parameter === 5 ? rendererName : parameter === 3 ? "WebGL 2.0" : "Google Inc." }
      const facts = viewerWebglFacts({ getContext: () => { calls++; return gl }, domElement: {} } as unknown as THREE.WebGLRenderer)
      expect(calls).toBe(1); expect(facts.renderer).toBe(rendererName); expect(facts.vendorFamily).toBe(expected)
      expect(facts.drawingBuffer).toEqual({ width: 1440, height: 960 })
      expect(facts.contextAttributes).toEqual({ antialias: false, preserveDrawingBuffer: true }); expect(facts.samples).toBe(0)
      expect(facts.softwareRendering).toBe(expected === "unknown" ? null : expected === "software")
    }
    const unavailable = viewerWebglFacts({ getContext: () => { throw new Error("unavailable") } } as unknown as THREE.WebGLRenderer)
    expect(unavailable.vendorFamily).toBe("unknown"); expect(unavailable.samples).toBeNull()
    expect(unavailable.contextAttributes).toEqual({ antialias: null, preserveDrawingBuffer: null })
  })
})

describe("会话短期冷解码保留（实际数组与固定Spark，无WebGL）", () => {
  test("初始化中切走，成功晚到的实际 Spark 数组进入原会话缓存但不会重挂；换 Host 拒绝旧结果", async () => {
    // 只替换网络/Worker 的交付时刻；constructor、initialized、Viewer 取消/释放和 PackedSplats 均为真代码。
    const prototype = SplatMesh.prototype as any, initialize = prototype.asyncInitialize
    try {
      for (const changedHost of [false, true]) {
        const scope = { hostInstanceId: "late-host", sessionId: "original-session" }
        retainedSplats.activateHost(scope.hostInstanceId)
        retainedSplats.clear()
        let deliver!: () => void
        let requested!:()=>void
        const initializationRequested=new Promise<void>(resolve=>{requested=resolve})
        prototype.asyncInitialize = function (this: SplatMesh) {
          return new Promise<void>(resolve => { deliver = () => {
            const lod = new PackedSplats()
            lod.pushSplat(new THREE.Vector3(2, 3, 4), new THREE.Vector3(.01, .01, .01), new THREE.Quaternion(), 1, new THREE.Color(1, 1, 1))
            this.packedSplats = new PackedSplats({ lodSplats: lod }); this.splats = this.packedSplats
            resolve()
          };requested() })
        }
        const ref: ResourceRef = { resourceId: "late-resource", version: 7, original: { uri: "fixture.ply", mimeType: "application/x-ply" }, representations: [], source: { units: "m", upAxis: "Z", handedness: "right", metersPerUnit: 1 } }
        const entity = { entityId: "late", resources: [ref], components: { visual: { kind: "splat", sourcePointCount: 1_000_000 } } }
        const group = new THREE.Group(), loaded: any = { group, signature: "requested-version", lodWarnings: [] }
        const viewer: any = Object.create(SceneViewer.prototype)
        Object.assign(viewer, { options: { splatRetentionScope: scope, resolveResource: async () => "fixture.ply" }, renderer: {}, scene: new THREE.Scene(), snapshot: { sceneId: "original-scene" }, objects: new Map([[entity.entityId, loaded]]), splatBudget: SPLAT_INTERACTIVE_BUDGET, splatRuntime: new Map() })
        const result = viewer.loadVisual(entity, loaded).catch((error: unknown) => error)
        // pending控制器在等缓存/URL之前就存在；只在真实SDK请求已开始后控制其交付时刻。
        await initializationRequested
        expect(loaded.pendingSplat).toBeDefined()
        const mesh: SplatMesh = loaded.pendingSplat.mesh
        expect(mesh).toBeInstanceOf(SplatMesh)
        loaded.pendingSplat.cancel(); viewer.snapshot = { sceneId: "other-scene" }
        if (changedHost) retainedSplats.activateHost("new-account-host")
        deliver()
        expect(await result).toMatchObject({ name: "AbortError" })
        await Promise.resolve()
        expect(mesh.packedSplats).toBeUndefined(); expect(mesh.parent).toBeNull(); expect(loaded.splat).toBeUndefined()
        const key = JSON.stringify([ref.resourceId, ref.version, ref.original.uri, ref.original.mimeType, true])
        expect(retainedSplats.take({ ...scope, sessionId: "other-session" }, key)).toBeUndefined()
        expect(retainedSplats.take(scope, JSON.stringify([ref.resourceId, 8, ref.original.uri, ref.original.mimeType, true]))).toBeUndefined()
        const data = retainedSplats.take(scope, key)
        if (changedHost) { expect(data).toBeUndefined(); expect(retainedSplats.report.entries).toBe(0) }
        else {
          expect(data).toBeDefined()
          const restored = new SplatMesh({ packedSplats: restoreSplatData(data!), enableLod: true })
          await restored.initialized
          expect(splatDataSource(restored)?.getSplat(0).center.toArray()).toEqual([2, 3, 4])
          restored.dispose()
        }
      }
    } finally { prototype.asyncInitialize = initialize; retainedSplats.clear() }
  })

  test("dispose清掉旧GPU/容器引用后保存数组仍可恢复，取出移交且不能重复共享", async () => {
    const lod = new PackedSplats()
    lod.pushSplat(new THREE.Vector3(2, 3, 4), new THREE.Vector3(.01, .01, .01), new THREE.Quaternion(), 1, new THREE.Color(1, 1, 1))
    lod.extra.lodTree = new Uint32Array([1, 2, 3])
    lod.extra.gpuObject = new THREE.Texture()
    const original = new SplatMesh({ packedSplats: new PackedSplats({ lodSplats: lod }), enableLod: true })
    await original.initialized
    const data = retainSplatData(original)!, bytes = retainedSplatBytes(data)
    expect(data.lod?.extra.gpuObject).toBeUndefined()
    const cache = new SplatRetentionCache(bytes, 180000)
    const scope = { hostInstanceId: "account-host-a", sessionId: "session-a" }
    cache.activateHost(scope.hostInstanceId)
    expect(cache.put(scope, "resource@1", data)).toBe(true)
    original.dispose()
    expect(original.packedSplats).toBeUndefined()
    const taken = cache.take(scope, "resource@1")!
    expect(cache.take(scope, "resource@1")).toBeUndefined()
    const restored = new SplatMesh({ packedSplats: restoreSplatData(taken), enableLod: true })
    await restored.initialized
    expect(splatDataSource(restored)?.getSplat(0).center.toArray()).toEqual([2, 3, 4])
    expect(restored.packedSplats?.lodSplats?.extra.lodTree).toBe(data.lod?.extra.lodTree)
    expect(cache.report.retainedBytes).toBe(0)
    restored.dispose(); cache.clear()
  })

  test("实际buffer去重计字节，预算/条数/TTL限制生效并隔离Host、会话和资源版本", () => {
    const buffer = new ArrayBuffer(128), packedArray = new Uint32Array(buffer)
    const data = { base: { numSplats: 1, packedArray, extra: { sameBuffer: packedArray.subarray(0, 4) }, splatEncoding: undefined } }
    expect(retainedSplatBytes(data)).toBe(128)
    let now = 1000
    const cache = new SplatRetentionCache(256, 10, 2, () => now)
    const a = { hostInstanceId: "account-host-a", sessionId: "session-a" }, b = { ...a, sessionId: "session-b" }
    cache.activateHost(a.hostInstanceId)
    expect(cache.put(a, "resource@1", data)).toBe(true)
    expect(cache.take(b, "resource@1")).toBeUndefined()
    expect(cache.take(a, "resource@2")).toBeUndefined()
    expect(cache.put(a, "resource@2", data)).toBe(true)
    expect(cache.put(a, "resource@3", data)).toBe(true)
    expect(cache.report.entries).toBe(2); expect(cache.report.retainedBytes).toBe(256)
    expect(cache.take(a, "resource@1")).toBeUndefined()
    now = 1011; expect(cache.report.entries).toBe(0)
    expect(cache.put(a, "resource@1", data)).toBe(true)
    cache.activateHost("account-host-b")
    expect(cache.report.entries).toBe(0)
    expect(cache.put(a, "resource@1", data)).toBe(false)
    cache.clear()
    const tiny = new SplatRetentionCache(127)
    tiny.activateHost(a.hostInstanceId)
    expect(tiny.put(a, "resource@1", data)).toBe(false)
    expect(tiny.report.oversized).toBe(1); tiny.clear()
    expect(splatRetentionBudget()).toBe(1024 ** 3)
    expect(splatRetentionBudget(4)).toBe(512 * 1024 ** 2)
    expect(splatRetentionBudget(64)).toBe(4*1024 ** 3)
    expect(splatRetentionBudget(32)).toBe(4*1024 ** 3)
    expect(splatRetentionBudget(8)).toBe(1024 ** 3)
  })

  test("实际定时过期删除保存数组的持有条目，不依赖下一次查询才清理", async () => {
    const cache = new SplatRetentionCache(128, 5)
    const scope = { hostInstanceId: "account-host-a", sessionId: "session-a" }
    cache.activateHost(scope.hostInstanceId)
    cache.put(scope, "resource@1", { base: { numSplats: 1, packedArray: new Uint32Array(32), extra: {}, splatEncoding: undefined } })
    const entries = (cache as unknown as { entries: Map<string, unknown> }).entries
    expect(entries.size).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 25))
    // 在 report/take（它们也会过期清理）之前检查原持有Map。
    expect(entries.size).toBe(0)
    expect(new SplatRetentionCache().ttlMs).toBe(3600000)
    cache.clear()
  })

  test("拒绝缓存报告实际底层容量及超额，不能按短view或活动点数低报内存",()=>{
    const buffer=new ArrayBuffer(160),packedArray=new Uint32Array(buffer,16,8)
    const data={base:{numSplats:1,packedArray,extra:{same:packedArray},splatEncoding:undefined}}
    expect(retainedSplatFootprint(data)).toEqual({bufferBytes:160,payloadBytes:32,buffers:1,views:1})
    const cache=new SplatRetentionCache(128),scope={hostInstanceId:"a",sessionId:"s"}
    cache.activateHost(scope.hostInstanceId)
    expect(cache.put(scope,"r@1",data)).toBe(false)
    expect(cache.report.lastRejected).toEqual({bufferBytes:160,payloadBytes:32,overBudgetBytes:32})
    expect(cache.report.retainedBytes).toBe(0)
    cache.clear()
  })
})

test("完整合法离群边界不控制取景；相机居中幂等且模型平移只应用一次", () => {
  const count = 1000, source = points(count, index => index >= 990 ? [1e6, -1e6, 1e6] : [index % 10, Math.floor(index / 10) % 10, index % 3])
  const full = cachedSplatCenterBounds({ min: [0, -1e6, 0], max: [1e6, 9, 1e6] })!
  const core = centralSplatBounds(source.numSplats, index => source.getSplat(index))!
  expect(core.getSize(new THREE.Vector3()).length()).toBeLessThan(20)
  const view: any = Object.create(SceneViewer.prototype), cloud = new THREE.Object3D(), group = new THREE.Group()
  group.add(cloud); group.position.set(100, 200, 300)
  view.camera = new THREE.PerspectiveCamera(60, 1, .01, 1000); view.camera.up.set(0, 0, 1)
  const heldKeys = new Set(["KeyW"])
  let canvasFocused = 0
  view.controls = { target: new THREE.Vector3(), enabled: false, update() {} }
  view.firstPerson = { speed: 1, active: true, setActive(active: boolean) { this.active = active; heldKeys.clear() }, clearInput() { heldKeys.clear() } }
  view.navigationPreference = "first-person"
  view.renderer = { domElement: { focus() { canvasFocused++ } } }
  view.select = () => {}; view.objects = new Map([["asset", { group }]])
  view.snapshot = { entities: [{ entityId: "asset", components: { visual: { kind: "splat" } } }] }
  view.splatBounds = new WeakMap([[cloud, full]]); view.splatViewBounds = new WeakMap([[cloud, core]])
  view.focus("asset"); expect(view.lastFraming.distance).toBeLessThan(30)
  view.frameAll(); expect(view.lastFraming.distance).toBeLessThan(30)
  view.enterSceneCenter("asset")
  const position = view.camera.position.clone(), target = view.controls.target.clone()
  view.enterSceneCenter("asset")
  expect(view.camera.position.toArray()).toEqual(position.toArray()); expect(view.controls.target.toArray()).toEqual(target.toArray())
  expect(group.position.toArray()).toEqual([100, 200, 300])
  group.position.set(110, 180, 305); view.enterSceneCenter("asset")
  expect(view.camera.position.clone().sub(position).toArray()).toEqual([10, -20, 5])
  expect(full.max.x).toBe(1e6)
  expect(view.firstPerson.active).toBe(true); expect(view.controls.enabled).toBe(false)
  expect(heldKeys.size).toBe(0); expect(canvasFocused).toBeGreaterThan(0)
})
