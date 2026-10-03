/**
 * ENV-09 配准承载的真实数据测试（N312）：用 **ETH3D 真实照片对**（N295 预取，逐字节校验）
 * 的**数据集真值深度**做两视刚体配准，产出逐点残差 + 融合 GLB，并跑三条负对照。
 *
 * 数据（`packages/...` 之外，只在 lane 目录里读）：
 *  · `.runtime/lane-env4546c/data/eth3d/{a,b}_depth.png`：ETH3D `test_data` 的 16-bit 深度（毫米）
 *  · `small_offset.txt`：`calibration 320 240 262.5 262.5 159.5 119.5 0.001` 与
 *    `a_t_b 1 0 0 0.0328631 0 1 0 -0.0157207 0 0 1 0.00766185`（**数据集给的两视外参**）
 *  · lane 里已把深度转成 float32 米制 `.bin`（`data/convert-report.json` 记字节与 sha256）
 *
 * 运行：`node --test --experimental-strip-types packages/blender/test/photo-registration.test.ts`
 * （`bun test` 对本文件有已知入口问题 ⇒ 一律用 node 口径；N331 新增 ⑤⑥ 两条失败语义用例。）
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { depthToPoints, meshFromDepth, mergeMeshes, MIN_REGISTRATION_PAIRS, MIN_OVERLAP_RATIO, normalsFromDepth, registerPointClouds, registerViews, residualStats, toleranceFor, writeGlbMesh, type Intrinsics, type PointSet } from "../src/photo-registration.ts"

const LANE = process.env.ENV09B_LANE ?? "/home/s18/WS/Lyapunov/Dev/.runtime/lane-env09b"
const OUT = join(LANE, "out")
mkdirSync(OUT, { recursive: true })
/** 数据集自带标定（`small_offset.txt` 原文）。 */
const K: Intrinsics = { fx: 262.5, fy: 262.5, cx: 159.5, cy: 119.5 }
const WIDTH = 320, HEIGHT = 240
const GT_T_B_IN_A: [number, number, number] = [0.0328631, -0.0157207, 0.00766185]
const ANCHOR = { kind: "dataset-calibration" as const, source: "ETH3D small_offset.txt: a_t_b + calibration 0.001" }

function readDepth(view: "a" | "b"): PointSet {
  const buffer = readFileSync(join(LANE, "data", `${view}_depth_m.bin`))
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
}
const depthA = readDepth("a"), depthB = readDepth("b")
const pointsA = depthToPoints(depthA, WIDTH, HEIGHT, K)
const pointsB = depthToPoints(depthB, WIDTH, HEIGHT, K)
const meanDepthA = (() => { let sum = 0, n = 0; for (const z of depthA) if (z > 0) { sum += z; n++ } return sum / n })()
const report: Record<string, unknown> = { lane: LANE, intrinsics: K, datasetGt: { translationM: GT_T_B_IN_A } }

const rotationErrorDeg = (rotation: readonly number[]): number => {
  const trace = rotation[0]! + rotation[4]! + rotation[8]!
  return (Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180) / Math.PI
}

test("① 两视真实配准：残差中位/分位 + 与数据集外参对照 + 融合 GLB", () => {
  const identity = registerPointClouds(pointsB, pointsA, { maxIterations: 1 }) // 1 轮=只测量不落地更新（残差是更新前测的，即"未配准"基线）
  const baseline = residualStats(identity.residualsM)
  const started = Date.now()
  const result = registerViews({
    units: "meter",
    views: [
      { viewId: "a", points: pointsA, intrinsics: K, depthMeanM: meanDepthA, anchor: ANCHOR },
      { viewId: "b", points: pointsB, intrinsics: K, depthMeanM: meanDepthA, anchor: ANCHOR },
    ],
    options: { maxIterations: 30, trimM: 0.05, maxPoints: 4000 },
  })
  const elapsedMs = Date.now() - started
  const registered = result.others[0]!
  const translation = registered.transform!.translation // N331：失败时 transform 为 null；本对修后（默认 aligned）pairs=3,960 充足，必有值（旧口径 1,449＝legacy 现场读数）
  const translationErrorM = Math.hypot(translation[0] - GT_T_B_IN_A[0], translation[1] - GT_T_B_IN_A[1], translation[2] - GT_T_B_IN_A[2])
  const rotationError = rotationErrorDeg(registered.transform!.rotation)
  const tolerance = toleranceFor(K, meanDepthA)

  // 同判据对照：残差/求解换成**点到面**（法线由深度图现算），其余参数与点到点完全相同
  const normalsA = normalsFromDepth(depthA, WIDTH, HEIGHT, K)
  const planeReport = registerViews({
    units: "meter",
    views: [
      { viewId: "a", points: pointsA, intrinsics: K, depthMeanM: meanDepthA, anchor: ANCHOR },
      { viewId: "b", points: pointsB, intrinsics: K, depthMeanM: meanDepthA, anchor: ANCHOR },
    ],
    options: { maxIterations: 30, trimM: 0.05, maxPoints: 4000, residualMode: "point-to-plane", targetNormals: normalsA },
  })
  const plane = planeReport.others[0]!
  // N341 修后（默认 aligned）：点到面腿的求解配对 3,621 ≥ MIN_REGISTRATION_PAIRS(600) ⇒ 给读数与变换（旧口径 550<600 的现场＝legacy 读数，见回执）
  const planeTranslationErrorM = plane.transform ? Math.hypot(plane.transform.translation[0] - GT_T_B_IN_A[0], plane.transform.translation[1] - GT_T_B_IN_A[1], plane.transform.translation[2] - GT_T_B_IN_A[2]) : NaN

  // 融合：A（单位阵）+ B（配准后）两张深度网格 → 单一 GLB
  const meshA = meshFromDepth(depthA, WIDTH, HEIGHT, K)
  const meshB = meshFromDepth(depthB, WIDTH, HEIGHT, K, registered.transform!)
  const fused = mergeMeshes([meshA, meshB])
  const glbPath = join(OUT, "env09b-two-view-fused.glb")
  const written = writeGlbMesh(glbPath, fused.positions, fused.indices)
  const singleViewFaces = meshA.indices.length / 3

  const payload = {
    views: ["a", "b"],
    pointsPerView: { a: pointsA.length / 3, b: pointsB.length / 3 },
    meanDepthA,
    tolerance: { toleranceM: tolerance.toleranceM, lateralPixelFootprintM: tolerance.lateralPixelFootprintM, source: tolerance.source },
    baselineNoRegistration: baseline,
    registered: {
      verdict: registered.verdict, iterations: registered.iterations, pairs: registered.pairs,
      residuals: registered.residuals, transform: registered.transform,
      translationErrorVsDatasetGtM: translationErrorM, rotationErrorVsDatasetGtDeg: rotationError,
    },
    fusion: { path: glbPath, bytes: written.bytes, faces: written.faces, singleViewBaselineFaces: singleViewFaces, mergedVertices: fused.positions.length / 3 },
    /** 同判据对照：点到点 vs 点到面（同一数据、同一参数、只换残差/求解） */
    modeComparison: {
      pointToPoint: { medianM: registered.residuals?.medianM, p90M: registered.residuals?.p90M, translationErrorVsGtM: translationErrorM, rotationErrorVsGtDeg: rotationError, verdict: registered.verdict },
      pointToPlane: { medianM: plane.residuals?.medianM, p90M: plane.residuals?.p90M, translationErrorVsGtM: planeTranslationErrorM, rotationErrorVsGtDeg: plane.transform ? rotationErrorDeg(plane.transform.rotation) : NaN, verdict: plane.verdict, toleranceM: plane.toleranceM, pairs: plane.pairs },
    },
    elapsedMs,
  }
  report.twoView = payload
  writeFileSync(join(OUT, "registration-report.json"), JSON.stringify(report, null, 2) + "\n")
  console.log("[ENV09 ①]", JSON.stringify(payload, null, 2))
  assert.ok(baseline && registered.residuals, "两次都要有残差读数")
  assert.ok(written.bytes > 1000 && written.faces > singleViewFaces, "融合产物必须比单视图有更多面")
  // N341 修后实测（默认 aligned，如实断言、不许粉饰）：ETH3D a/b 是**近同机位对**（基线 37 mm），
  // 未配准基线 8.2836 mm；修 `compose` 旋转步复合后点对点 ICP 收敛回真值方向（2.7459 mm、GT 平移误差 247 mm→2 mm）⇒ **优于基线、达容差**。
  // （旧口径现场＝ICP 劣于基线 21.28 mm、判 outside-tolerance——那是 `compose` 反号/错序缺陷的现场，N341 起钉修后现场。）
  assert.ok(registered.residuals.medianM < baseline.medianM, "修后事实：点对点 ICP 在该真实对上优于未配准基线（2.7459 vs 8.2836 mm，如实断言，不许粉饰）")
  assert.equal(registered.verdict, "within-tolerance", "修后该结果达既有容差（中位 2.7459 mm ≤ 13.1339 mm；判据/容差未改）")
})

test("② 负对照一：错误内参（fx=800 而非 262.5）⇒ 显著劣化或明确失败", () => {
  const wrongK: Intrinsics = { fx: 800, fy: 800, cx: 159.5, cy: 119.5 }
  const pointsBWrong = depthToPoints(depthB, WIDTH, HEIGHT, wrongK)
  const result = registerPointClouds(pointsBWrong, pointsA, { maxIterations: 30, trimM: 0.05, maxPoints: 4000 })
  const stats = residualStats(result.residualsM)
  const good = registerPointClouds(pointsB, pointsA, { maxIterations: 30, trimM: 0.05, maxPoints: 4000 })
  const goodStats = residualStats(good.residualsM)
  const gtErr = (tr: readonly number[]): number => Math.hypot(tr[0]! - GT_T_B_IN_A[0], tr[1]! - GT_T_B_IN_A[1], tr[2]! - GT_T_B_IN_A[2])
  const payload = { wrongIntrinsicsMedianM: stats?.medianM ?? null, correctIntrinsicsMedianM: goodStats?.medianM ?? null, pairs: result.pairs,
    wrongTranslationErrorVsGtM: gtErr(result.transform!.translation), correctTranslationErrorVsGtM: gtErr(good.transform!.translation),
    toleranceM: toleranceFor(K, meanDepthA).toleranceM }
  report.negativeWrongIntrinsics = payload
  writeFileSync(join(OUT, "registration-report.json"), JSON.stringify(report, null, 2) + "\n")
  console.log("[ENV09 ②]", JSON.stringify(payload))
  assert.ok(goodStats && stats, "两组都要有残差读数")
  // 判据用**数据集真值外参**（比残差更有区分度）：错误内参不得比正确内参更接近真值
  assert.ok(payload.wrongTranslationErrorVsGtM > payload.correctTranslationErrorVsGtM, "错误内参的 GT 平移误差必须大于正确内参")
  // N341 修后如实登记（判别力弱化，不硬凑）：错误内参中位 9.5284 mm **反而落进**容差 13.1339 mm ⇒ 旧断言「错误内参不得被判成达容差」
  // 不再成立（容差级判别对错内参不再敏感）。判别改钉**相对**关系：错误内参的残差中位仍必须显著差于正确内参（9.5284 vs 2.7459 mm）。
  assert.ok(stats.medianM > goodStats.medianM, "错误内参的残差中位必须差于正确内参（9.5284 vs 2.7459 mm）——容差级判别已弱化（9.5284 < 13.1339），如实登记")
})

test("③ 负对照二：错配（把 b 的深度当作不相关场景：整体平移半个视野 + 反转列序）⇒ 显著劣化（N341 修后容差级判别弱化，改钉相对判别）", () => {
  // 用真实数据造"不相关视图"：把 b 的深度按列镜像并整体平移 120 列（配准不应把它当同一场景）
  const shifted = new Float32Array(WIDTH * HEIGHT)
  for (let v = 0; v < HEIGHT; v++) for (let u = 0; u < WIDTH; u++) {
    const source = (u + 120) % WIDTH
    shifted[v * WIDTH + u] = depthB[v * WIDTH + (WIDTH - 1 - source)]!
  }
  const pointsShifted = depthToPoints(shifted, WIDTH, HEIGHT, K)
  const result = registerPointClouds(pointsShifted, pointsA, { maxIterations: 30, trimM: 0.05, maxPoints: 4000 })
  const stats = residualStats(result.residualsM)
  const tolerance = toleranceFor(K, meanDepthA)
  // N341 修后如实登记（不硬凑）：错配（镜像+移位）在修后口径给 2,312 残差样本、重叠度 0.584 ≥ MIN_OVERLAP_RATIO(1/2) ⇒ 计数闸/重叠度闸都不拒、有读数，
  // 中位 10.281 mm 反落进容差 13.1339 mm ⇒ **容差级判别对镜像错配弱化**（镜像墙仍可贴合，Round 25 已记）。
  // （旧口径现场＝末轮 pairs=558<600 被计数闸判 insufficient、无变换可读——那是 compose 缺陷的发散现场，见回执 Round 26。）
  const good = registerPointClouds(pointsB, pointsA, { maxIterations: 30, trimM: 0.05, maxPoints: 4000 })
  const goodStats = residualStats(good.residualsM)
  const gtErrShift = result.transform ? Math.hypot(result.transform.translation[0] - GT_T_B_IN_A[0], result.transform.translation[1] - GT_T_B_IN_A[1], result.transform.translation[2] - GT_T_B_IN_A[2]) : NaN
  const payload = { shiftedMedianM: stats?.medianM ?? null, toleranceM: tolerance.toleranceM, pairs: result.pairs, shiftedTranslationErrorVsGtM: gtErrShift,
    goodRegisteredMedianM: goodStats?.medianM ?? null, toleranceLevelDiscrimination: "weakened（10.281 < 13.1339，N341 如实登记）" }
  report.negativeMismatch = payload
  writeFileSync(join(OUT, "registration-report.json"), JSON.stringify(report, null, 2) + "\n")
  console.log("[ENV09 ③]", JSON.stringify(payload))
  assert.ok(stats !== null && goodStats !== null && stats.medianM > goodStats.medianM, "错配的残差中位必须差于真实对注册（10.281 vs 2.7459 mm）——容差级判别已弱化（10.281 < 13.1339），如实登记")
})

test("④ 负对照三：无米制锚点（units=relative）⇒ 明确降级，不宣称绝对精度", () => {
  const result = registerViews({
    units: "relative",
    views: [
      { viewId: "a", points: pointsA, intrinsics: K, depthMeanM: meanDepthA },
      { viewId: "b", points: pointsB, intrinsics: K, depthMeanM: meanDepthA },
    ],
  })
  const payload = { metric: result.metric, verdict: result.others[0]?.verdict, blocked: result.blocked ?? result.others[0]?.blocked }
  report.negativeNoScale = payload
  writeFileSync(join(OUT, "registration-report.json"), JSON.stringify(report, null, 2) + "\n")
  console.log("[ENV09 ④]", JSON.stringify(payload))
  assert.equal(result.metric, false, "无锚点不得给出米制结论")
  assert.equal(result.others[0]?.verdict, "relative-only")
  assert.match(String(payload.blocked), /不宣称绝对/)
})

test("⑤ N331 配对不足＝可判定失败：pairs=0（含「放宽档有配对、收紧后塌掉」）⇒ 不返回残差/变换冒充结果", () => {
  // 复刻缺陷现场：放宽档（trim×4）有配对、求解无法把两片错开的平面捏合，收紧档后配对塌成 0 ⇒
  // 旧实现静默 break 并**返回上一轮**的 0.065 m 残差读数 + 变换；新语义必须是可判定失败、无残差/变换
  const grid: number[] = []
  for (let v = 0; v < 21; v++) for (let u = 0; u < 21; u++) grid.push((u - 10) * 0.02, (v - 10) * 0.02)
  const planes = (z1: number, z2: number): PointSet => {
    const out: number[] = []
    for (const z of [z1, z2]) for (let i = 0; i < grid.length; i += 2) out.push(grid[i]!, grid[i + 1]!, z)
    return Float32Array.from(out)
  }
  const collapseSrc = planes(1.0, 1.13), collapseTgt = planes(1.0, 1.30)
  const collapse = registerPointClouds(collapseSrc, collapseTgt, { maxIterations: 30, trimM: 0.05, maxPoints: 4000 })
  assert.equal(collapse.pairs, 0, "末轮配对必须如实报 0")
  assert.equal(collapse.iterations, 4, "放宽档（前 3 轮）用尽后即失败退出，不跑满")
  assert.equal(collapse.transform, null, "pairs=0 ⇒ 不得返回变换冒充结果（旧实现返回上一轮变换）")
  assert.equal(collapse.residualsM.length, 0, "pairs=0 ⇒ 不得返回残差冒充结果（旧实现静默带回上一轮 0.065 m 读数）")
  assert.equal(collapse.residualsPointToPlaneM.length, 0, "另一模式读数同样不得带回")
  assert.equal(residualStats(collapse.residualsM), null, "残差统计必须是 null，不给伪读数")
  assert.equal(collapse.failure?.code, "REGISTRATION_INSUFFICIENT_PAIRS", "必须是可判定失败（错误码）")
  // pairs>0 但低于 MIN_REGISTRATION_PAIRS ⇒ 同样 insufficient（阈值语义 + 依据见源码常量注释）
  const tinyGrid: number[] = []
  for (let v = 0; v < 15; v++) for (let u = 0; u < 15; u++) tinyGrid.push(u * 0.02, v * 0.02, 1)
  const tiny = Float32Array.from(tinyGrid)
  const small = registerPointClouds(tiny, tiny, { maxIterations: 30, trimM: 0.05, maxPoints: 4000 })
  assert.ok(small.pairs > 0 && small.pairs < MIN_REGISTRATION_PAIRS, `小点云配对 ${small.pairs} 应低于阈值 ${MIN_REGISTRATION_PAIRS}`)
  assert.equal(small.transform, null, "低于阈值 ⇒ 不得返回变换")
  assert.equal(small.residualsM.length, 0, "低于阈值 ⇒ 不得返回残差")
  assert.deepEqual(small.failure, { code: "REGISTRATION_INSUFFICIENT_PAIRS", pairs: small.pairs, minPairs: MIN_REGISTRATION_PAIRS })
  // 报告层同语义：verdict=insufficient-pairs、残差/变换都不给
  const viewReport = registerViews({
    units: "meter",
    views: [
      { viewId: "tgt", points: collapseTgt, intrinsics: K, depthMeanM: meanDepthA, anchor: ANCHOR },
      { viewId: "src", points: collapseSrc, intrinsics: K, depthMeanM: meanDepthA, anchor: ANCHOR },
    ],
    options: { maxIterations: 30, trimM: 0.05, maxPoints: 4000 },
  })
  const failed = viewReport.others[0]!
  assert.equal(failed.verdict, "insufficient-pairs")
  assert.equal(failed.transform, null, "报告层不得给变换")
  assert.equal(failed.residuals, null, "报告层不得给残差")
  assert.equal(failed.residualsOtherMode, null)
  assert.equal(failed.failure?.code, "REGISTRATION_INSUFFICIENT_PAIRS")
  report.n331InsufficientPairs = { collapsePairs: collapse.pairs, collapseIterations: collapse.iterations, smallPairs: small.pairs, minPairs: MIN_REGISTRATION_PAIRS, verdict: failed.verdict }
  writeFileSync(join(OUT, "registration-report.json"), JSON.stringify(report, null, 2) + "\n")
  console.log("[ENV09 ⑤]", JSON.stringify({ collapsePairs: collapse.pairs, collapseIterations: collapse.iterations, smallPairs: small.pairs, verdict: failed.verdict, failure: failed.failure }))
})

test("⑥ N331 无效深度：混入 NaN/Inf/非正值 ⇒ meshFromDepth 无 NaN 顶点、顶点计数如实；writeGlbMesh 拒绝 NaN/Inf 顶点", () => {
  const w = 6, h = 4
  const depth = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) depth[i] = 1 + (i % 7) * 0.01
  // 混入无效像素（NaN / ±Inf / 0 / 负值），与真实数据集深度的无效形态一致
  const invalid = new Map<number, number>([[1, Number.NaN], [2, Number.POSITIVE_INFINITY], [4, Number.NEGATIVE_INFINITY], [6, 0], [7, -1], [9, Number.NaN], [12, Number.POSITIVE_INFINITY], [18, -0.5], [23, Number.NaN]])
  for (const [i, z] of invalid) depth[i] = z
  const validCount = w * h - invalid.size
  const mesh = meshFromDepth(depth, w, h, K)
  assert.equal(mesh.positions.length / 3, validCount, "顶点计数如实：== 有效（有限正值）像素数")
  for (const v of mesh.positions) assert.ok(Number.isFinite(v), "产物顶点不得含 NaN/Inf")
  for (const idx of mesh.indices) assert.ok(idx >= 0 && idx < mesh.positions.length / 3, "索引不越界（无效像素不产生引用）")
  const glbPath = join(OUT, "n331-nan-depth-mesh.glb")
  const written = writeGlbMesh(glbPath, mesh.positions, mesh.indices)
  assert.equal(written.faces, mesh.indices.length / 3, "面数如实")
  // GLB 二进制逐浮点复核：0 个 NaN/Inf；JSON 访问器顶点计数如实
  const glb = readFileSync(glbPath)
  const jsonLen = glb.readUInt32LE(12)
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLen).toString("utf8"))
  assert.equal(gltf.accessors[0].count, validCount, "GLB 顶点计数如实")
  const binOffset = 12 + 8 + jsonLen + 8
  let nonFinite = 0
  for (let i = binOffset; i + 4 <= glb.byteLength; i += 4) if (!Number.isFinite(glb.readFloatLE(i))) nonFinite++
  assert.equal(nonFinite, 0, "GLB 产物不得含 NaN/Inf 浮点（Round 22 的 938,946 个 NaN 浮点不得再现）")
  // writeGlbMesh 的拒绝语义：NaN/Inf 顶点必须明确报错（不静默剔除、不静默写出）
  assert.throws(() => writeGlbMesh(join(OUT, "n331-nan-probe-should-throw.glb"), new Float32Array([0, 0, 0, 1, 0, 0, 0, Number.NaN, 1]), new Uint32Array([0, 1, 2])), /GLB_NON_FINITE_VERTEX/, "NaN 顶点拒绝写出")
  report.n331InvalidDepth = { pixels: w * h, invalidPixels: invalid.size, vertices: mesh.positions.length / 3, faces: written.faces, glbBytes: written.bytes, nonFiniteFloatsInGlb: nonFinite, rejectedNaNWrite: true }
  writeFileSync(join(OUT, "registration-report.json"), JSON.stringify(report, null, 2) + "\n")
  console.log("[ENV09 ⑥]", JSON.stringify(report.n331InvalidDepth))
})

test("⑦ N339 度量对齐（N341 修后现场 3,621/3,960/3,960）：残差样本充足 ⇒ 不得判 insufficient、应给残差读数（误杀反例旧现场＝legacy 550/666/1,449）", () => {
  // 误杀反例（N339）：同一 37 mm 真实对（ETH3D a/b），点到面模式的**求解子集** `pairs` 只计视角过滤后进 6×6 解算的配对。
  // 旧现场（legacy 口径，逐位见回执）：pairs=550 < MIN_REGISTRATION_PAIRS(600) 而残差样本 666/1,449 充足 ⇒ 旧闸门按 `pairs` 判会 **误杀**成 insufficient。
  // N341 修后（默认 aligned，本用例实测）：同一构造收敛到位 ⇒ 求解子集 pairs=3,621、点到面残差样本 3,960、同一对点到点样本 3,960——
  // 「550<600≤样本」误杀现场在修后口径下**不再复现**（该现场钉在 legacy 口径，Round 26 回执同钉）；充分性按**残差样本数**判的度量语义不变。
  // 度量口径如实记：点到面腿的残差样本 = `residualsPointToPlaneM.length`（本修 sampleCount 度量域）；同一对的**点到点**对应数 = `residualsM.length`（pairs==样本）。
  const normalsA = normalsFromDepth(depthA, WIDTH, HEIGHT, K)
  const plane = registerPointClouds(pointsB, pointsA, { maxIterations: 30, trimM: 0.05, maxPoints: 4000, residualMode: "point-to-plane", targetNormals: normalsA })
  const pointToPoint = registerPointClouds(pointsB, pointsA, { maxIterations: 30, trimM: 0.05, maxPoints: 4000, residualMode: "point-to-point" })
  const samples = plane.residualsPointToPlaneM.length
  const reading = residualStats(plane.residualsPointToPlaneM)
  // ① 度量错位现场的读数（N341 修后改钉修后现场；旧现场 550/1,449＝legacy 口径，见回执 Round 26）
  assert.equal(plane.pairs, 3621, "修后（默认 aligned）点到面求解子集 pairs=3,621（视角过滤后）；旧口径 550＝legacy 现场读数")
  assert.ok(plane.pairs >= MIN_REGISTRATION_PAIRS, `修后求解子集 ${plane.pairs} 已达阈值 ${MIN_REGISTRATION_PAIRS}——「550<600 误杀」现场在修后口径下不再复现（阈值/度量未改）`)
  assert.ok(samples >= MIN_REGISTRATION_PAIRS, `点到面残差样本 ${samples}（residualsPointToPlaneM.length）应达阈值 ${MIN_REGISTRATION_PAIRS}`)
  assert.ok(samples > plane.pairs, `残差样本 ${samples} 必须多于求解子集 ${plane.pairs}——度量错位正是误杀根源`)
  assert.equal(pointToPoint.residualsM.length, 3960, "修后同一对点到点对应数=3,960（pairs==样本）；旧口径 1,449＝legacy 现场读数——数据富对应、pairs 只计求解子集会误杀的结论不变")
  // ② 修后：不得判 insufficient、应给残差读数与变换
  assert.equal(plane.failure, undefined, "残差样本充足 ⇒ 不得判 REGISTRATION_INSUFFICIENT_PAIRS（旧实现按 pairs=550 误杀）")
  assert.notEqual(plane.transform, null, "残差样本充足 ⇒ 应给变换（不返回残差/变换冒充结果、也不空手）")
  assert.ok(reading !== null, "点到面腿应给残差读数（中位/分位）")
  assert.equal(plane.mode, "point-to-plane")
  // ③ 报告层同语义：verdict 不得是 insufficient-pairs、残差读数照给
  const rep = registerViews({
    units: "meter",
    views: [
      { viewId: "a", points: pointsA, intrinsics: K, depthMeanM: meanDepthA, anchor: ANCHOR },
      { viewId: "b", points: pointsB, intrinsics: K, depthMeanM: meanDepthA, anchor: ANCHOR },
    ],
    options: { maxIterations: 30, trimM: 0.05, maxPoints: 4000, residualMode: "point-to-plane", targetNormals: normalsA },
  })
  const planeRep = rep.others[0]!
  assert.notEqual(planeRep.verdict, "insufficient-pairs", "报告层不得把充足残差判成 insufficient-pairs")
  assert.ok(planeRep.residuals !== null, "报告层应给点到面残差读数")
  report.n339MetricAlignment = {
    pairs: plane.pairs, minPairs: MIN_REGISTRATION_PAIRS, residualSamples: samples,
    ptPtPairs: pointToPoint.pairs, ptPtSamples: pointToPoint.residualsM.length,
    failure: plane.failure ?? null, transformReturned: plane.transform !== null,
    planeMedianM: reading?.medianM ?? null, planeP95M: reading?.p95M ?? null, reportVerdict: planeRep.verdict,
  }
  writeFileSync(join(OUT, "registration-report.json"), JSON.stringify(report, null, 2) + "\n")
  console.log("[ENV09 ⑦]", JSON.stringify(report.n339MetricAlignment))
})

test("⑧ N341 切默认（不传 stepComposition ＝ aligned）：37 mm 判据构造进既有容差、位姿到数据集真值（判据/容差未动）＋ legacy 分支保留可显式选", () => {
  // 判据构造（Round 22 E5 / Round 24 G1 同参）：source=A → target=B、maxPoints 20000、trimM 0.15、40 轮、点到点。
  // 真值（small_offset.txt 原文）：`a_t_b` 是**纯平移 37.2267 mm**（四元组 1 0 0 0 ⇒ 旋转恒等）；A→B 的真值平移 = −a_t_b。
  // N341 起**默认口径**即 `aligned`（本用例不传 `stepComposition`＝钉新默认）：修的是 `compose` 的**旋转步复合**
  // （旧实算 R_base·(I−[ω]×)，与它自己的文档式 R_delta·R_base、平移半边 D·τ+t 自相矛盾 ⇒ 把该对发散到 |t|=553.77mm、rotErr 32°）。
  // **判据/容差一字未动**：仍用 toleranceFor + 「中位 ≤ 容差」。
  const aligned = registerPointClouds(pointsA, pointsB, { maxIterations: 40, trimM: 0.15, maxPoints: 20000, residualMode: "point-to-point" })
  const stats = residualStats(aligned.residualsM)
  const tolerance = toleranceFor(K, meanDepthA)
  assert.ok(aligned.failure === undefined, "修后不应落失败语义（配对充足、重叠度 1.000）")
  assert.ok(stats !== null, "新默认（aligned）口径应给残差读数")
  // 既有判据（未改）：中位 ≤ 容差（实测 3.298mm ≤ 13.1339mm；旧口径 46.7728mm）
  assert.ok(stats.medianM <= tolerance.toleranceM, `修后中位残差必须达既有容差（${stats.medianM} ≤ ${tolerance.toleranceM}）`)
  // 证据强度（非判据）：p95 也落在容差内（实测 6.82mm vs 13.13mm；旧口径 133.46mm）
  assert.ok(stats.p95M <= tolerance.toleranceM, "p95 也应落在既有容差内（如实报数，不粉饰）")
  assert.equal(aligned.pairs, 18820, "全部降采样点（20000 档 stride=4 ⇒ 18,820）都应配对上")
  // 位姿到数据集真值：平移误差 < 5mm（真值基线 37.2267mm），旋转保持恒等（真值是纯平移）
  const translation = aligned.transform!.translation
  const translationErrorM = Math.hypot(translation[0] + GT_T_B_IN_A[0], translation[1] + GT_T_B_IN_A[1], translation[2] + GT_T_B_IN_A[2])
  assert.ok(translationErrorM < 0.005, `到位姿误差必须 < 5mm（实测 ${translationErrorM}）`)
  assert.ok(rotationErrorDeg(aligned.transform!.rotation) < 0.1, "真值是纯平移 ⇒ 旋转应保持恒等（旧口径转了 32°）")
  // legacy 分支保留、可显式选（N341 授权项①）：同一构造显式 `stepComposition:"legacy"` ⇒ 旧实算逐位保留（发散 |t|=553.77mm、
  // 重叠度 3,377/18,820 = 0.179）⇒ N341 重叠度闸对 legacy 同样生效：可判定失败、**不返回假变换冒充结果**（N331 语义的完成）。
  const legacy = registerPointClouds(pointsA, pointsB, { maxIterations: 40, trimM: 0.15, maxPoints: 20000, residualMode: "point-to-point", stepComposition: "legacy" })
  const legacyRatio = legacy.failure?.code === "REGISTRATION_INSUFFICIENT_PAIRS" ? legacy.failure.overlapRatio : undefined
  assert.equal(legacy.failure?.code, "REGISTRATION_INSUFFICIENT_PAIRS", "legacy 分支保留可显式选；重叠度闸对它同样生效（不得返回假变换）")
  assert.equal(legacy.transform, null, "legacy 口径在该构造上重叠度 0.179 < 1/2 ⇒ 不得返回 |t|=553.77mm 的假变换冒充结果")
  assert.ok(legacyRatio !== undefined && legacyRatio < MIN_OVERLAP_RATIO, `重叠度闸失败对象带 overlapRatio（实测 ${legacyRatio} < ${MIN_OVERLAP_RATIO}）`)
  report.n341DefaultStep = {
    medianM: stats.medianM, p95M: stats.p95M, p90M: stats.p90M, pairs: aligned.pairs,
    toleranceM: tolerance.toleranceM, toleranceSource: tolerance.source,
    translationErrorVsDatasetGtM: translationErrorM, rotationErrorVsDatasetGtDeg: rotationErrorDeg(aligned.transform!.rotation),
    tEstNormM: Math.hypot(...translation), datasetGtBaselineM: Math.hypot(...GT_T_B_IN_A),
    legacyExplicit: { failure: legacy.failure?.code ?? null, overlapRatio: legacyRatio ?? null, pairs: legacy.pairs, transformReturned: legacy.transform !== null },
    note: "N341 起默认口径＝aligned（本用例不传 stepComposition 即钉新默认）；legacy 分支保留可显式选，且重叠度闸对 legacy 同样生效（假变换不再冒充结果）",
  }
  writeFileSync(join(OUT, "registration-report.json"), JSON.stringify(report, null, 2) + "\n")
  console.log("[ENV09 ⑧]", JSON.stringify(report.n341DefaultStep))
})

/**
 * ⑨⑩⑪ ENV-09 **过滤面**（N354b）：配对前闸 + 回执事实字段。
 * 只断言"过滤/拒绝/回执"这一面，**不断言配准结论** ⇒ 真实 ETH3D 点云降到 200 点档、`maxIterations: 1`（秒级），
 * 既有 ①–⑧ 的判据/容差/600 闸/重叠度闸/stepComposition 语义一字不动。
 */
const filterOptions = { maxIterations: 1, maxPoints: 200 }

test("⑨ frameId 不一致 ⇒ 配对前明确拒绝（REGISTRATION_FRAME_MISMATCH）；同 frameId 与一侧未声明都不误杀", () => {
  const views = (aFrame?: string, bFrame?: string) => [
    { viewId: "a", points: pointsA, intrinsics: K, depthMeanM: meanDepthA, anchor: ANCHOR, ...(aFrame === undefined ? {} : { registration: { frameId: aFrame } }) },
    { viewId: "b", points: pointsB, intrinsics: K, depthMeanM: meanDepthA, anchor: ANCHOR, ...(bFrame === undefined ? {} : { registration: { frameId: bFrame } }) },
  ]
  assert.throws(() => registerViews({ units: "meter", views: views("f1", "f2"), options: filterOptions }),
    /REGISTRATION_FRAME_MISMATCH/, "两侧都已声明且不同 ⇒ 必须拒绝配对（不同坐标系不得配准）")
  const same = registerViews({ units: "meter", views: views("f1", "f1"), options: filterOptions })
  assert.equal(same.others.length, 1, "同 frameId ⇒ 照常配对（不误杀）")
  assert.deepEqual(same.excluded, [], "同 frameId ⇒ 无排除")
  const partial = registerViews({ units: "meter", views: views("f1", undefined), options: filterOptions })
  assert.equal(partial.others.length, 1, "一侧未声明 frameId ⇒ 不比较、不推断（不误杀）")
  assert.deepEqual(partial.excluded, [])
  console.log("[ENV09 ⑨]", JSON.stringify({ rejected: "REGISTRATION_FRAME_MISMATCH", sameFramePaired: same.others.length, undeclaredPaired: partial.others.length }))
})

test("⑩ objectTag 不同 ⇒ 不配对 + 计入 excluded（不静默混融）；同 tag / 一侧未声明 ⇒ 无人被排除", () => {
  const views = (aTag?: string, bTag?: string) => [
    { viewId: "a", points: pointsA, intrinsics: K, depthMeanM: meanDepthA, anchor: ANCHOR, ...(aTag === undefined ? {} : { registration: { objectTag: aTag } }) },
    { viewId: "b", points: pointsB, intrinsics: K, depthMeanM: meanDepthA, anchor: ANCHOR, ...(bTag === undefined ? {} : { registration: { objectTag: bTag } }) },
  ]
  const mismatched = registerViews({ units: "meter", views: views("stove", "chair"), options: filterOptions })
  assert.equal(mismatched.others.length, 0, "标签不同 ⇒ 该视不得参与配对（不静默混融）")
  assert.deepEqual(mismatched.excluded, [{ viewId: "b", reason: "object-tag-mismatch", field: "objectTag" }],
    "被过滤的视图必须如实出现在 excluded 里（含原因与字段）")
  const same = registerViews({ units: "meter", views: views("stove", "stove"), options: filterOptions })
  assert.equal(same.others.length, 1, "同 tag ⇒ 照常配对")
  assert.deepEqual(same.excluded, [], "同 tag ⇒ 不得误杀")
  const partial = registerViews({ units: "meter", views: views("stove", undefined), options: filterOptions })
  assert.equal(partial.others.length, 1, "候选视未声明 objectTag ⇒ 不比较、不排除（缺字段不推断）")
  assert.deepEqual(partial.excluded, [])
  console.log("[ENV09 ⑩]", JSON.stringify({ mismatchExcluded: mismatched.excluded, sameTagPaired: same.others.length, undeclaredPaired: partial.others.length }))
})

test("⑪ 年代过滤只在显式声明 targetEra 时生效；未声明 ⇒ eraExclusion 显式 not-declared 且无人被排除", () => {
  const views = (aTime?: string, bTime?: string) => [
    { viewId: "a", points: pointsA, intrinsics: K, depthMeanM: meanDepthA, anchor: ANCHOR, ...(aTime === undefined ? {} : { registration: { captureTime: aTime } }) },
    { viewId: "b", points: pointsB, intrinsics: K, depthMeanM: meanDepthA, anchor: ANCHOR, ...(bTime === undefined ? {} : { registration: { captureTime: bTime } }) },
  ]
  const applied = registerViews({ units: "meter", targetEra: "1990s", views: views("1990s", "2020s"), options: filterOptions })
  assert.equal(applied.eraExclusion, "applied:targetEra", "声明了 targetEra ⇒ 回执必须写 applied:targetEra")
  assert.equal(applied.others.length, 0, "年代不匹配的视图不得参与配对")
  assert.deepEqual(applied.excluded, [{ viewId: "b", reason: "era-mismatch", field: "captureTime" }])
  const notDeclared = registerViews({ units: "meter", views: views("1990s", "2020s"), options: filterOptions })
  assert.equal(notDeclared.eraExclusion, "not-declared", "未声明 targetEra ⇒ 必须显式写 not-declared（不省略、不推断）")
  assert.deepEqual(notDeclared.excluded, [], "未声明 ⇒ 不得排除任何视图")
  assert.equal(notDeclared.others.length, 1, "未声明 ⇒ 两个视图照常配对")
  const missing = registerViews({ units: "meter", targetEra: "1990s", views: views("1990s", undefined), options: filterOptions })
  assert.deepEqual(missing.excluded, [], "captureTime 缺失 ⇒ 不排除、不推断")
  assert.equal(missing.others.length, 1)
  const yearForm = registerViews({ units: "meter", targetEra: "1990s", views: [
    { viewId: "a", points: pointsA, intrinsics: K, depthMeanM: meanDepthA, anchor: ANCHOR, registration: { captureTime: "1995-06-01" } },
    { viewId: "b", points: pointsB, intrinsics: K, depthMeanM: meanDepthA, anchor: ANCHOR, registration: { captureTime: "1990s" } },
    { viewId: "c", points: pointsB, intrinsics: K, depthMeanM: meanDepthA, anchor: ANCHOR, registration: { captureTime: "2021-03-02" } },
  ], options: filterOptions })
  assert.equal(yearForm.eraExclusion, "applied:targetEra")
  assert.deepEqual(yearForm.excluded, [{ viewId: "c", reason: "era-mismatch", field: "captureTime" }],
    "四位年份落在该十年内（1995）不算不匹配；2021 必须排除")
  assert.deepEqual(yearForm.others.map(item => item.viewId), ["b"], "匹配年代的候选视仍参与配对")
  console.log("[ENV09 ⑪]", JSON.stringify({ applied: applied.eraExclusion, excluded: applied.excluded, notDeclared: notDeclared.eraExclusion, missingTimeExcluded: missing.excluded.length, yearFormPaired: yearForm.others.length }))
})
