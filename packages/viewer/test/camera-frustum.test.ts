/**
 * DEV-038 · 相机视锥纯几何（`camera-frustum.ts`）的数值验收——方案 §8 判据 1／2／3（数学层）／5 的坏数据负对照。
 *
 * 判据不是"序列化往返一致"，而是**投影几何本身**：
 *   · 判据 1：锥角经 `projectToPixel` 与 `projectionMatrixFromIntrinsics`（两条独立解析路径）回投像素 =
 *     图像四角（≤0.01 px；`projectToPixel` 往返机器精度）。像素口径与 `camera-view.test.ts:552` 同一条：
 *     `u = (ndc.x+1)/2·W − 0.5`（像素中心，原点左上）。
 *   · 判据 2：偏心主点 K 的锥体**非对称**（锥轴与几何中心线夹角＝解析偏移角）；负对照＝"fov+aspect 对称锥"
 *     在该用例必须 FAIL（回投残差 >0.5 px）——防"看着像"糊过去。
 *   · 判据 3（数学层）：`mountLocalFrom` 是引擎公式 `worldFromCamera = bodyWorld ∘ mountLocal` 的逆，
 *     复合回去逐位还原；P2 的场景图挂载对账在此之上。
 *   · 判据 5（坏数据负对照）：缺 K 且缺 fovy ⇒ 不画不猜；坏 K ⇒ 不画；foovy-only ⇒ 派生并标 `fovy-derived`。
 *
 * 边界（不冒充已完成）：这里**没有** WebGL/three 渲染，画线、拾取、gizmo、Shell 联动不在本文件——
 * 那些在 viewer 挂树切片与 `lyapunov-shell/test/viewer-observe.ts` 夹具里验收（方案 §8 判据 3 完整版／4／6）。
 * 运行：`bun test packages/viewer/test/camera-frustum.test.ts`
 */
import { describe, expect, it } from "bun:test"
import {
  cameraAdjustFromDrag, cameraRequestFromRig, captureGateLabel, captureGateRect, frustumCorners, frustumFromReceipt, frustumGeometry, fovyFromLens, imagePixelToCanvasPixel, intrinsicsFromFovy, intrinsicsFromLens, mountLocalFrom, pixelToCameraPoint,
  DISPLAY_DEFAULT_FAR_M, DISPLAY_DEFAULT_NEAR_M,
} from "../src/camera-frustum.ts"
import {
  fovYFromIntrinsics, normalizeIntrinsics, principalPointOffsetPx, projectToPixel, projectionMatrixFromIntrinsics, quaternionAngleDeg,
  rotateByQuaternion, scaleIntrinsics,
  type ViewerCameraIntrinsics, type ViewerQuat, type ViewerVec3,
} from "../src/camera-view.ts"

/** 图像四角＝像素网格真实边缘（像素中心口径：首/末像素中心在 0 与 W−1，边缘在 ±0.5；投影矩阵 NDC ±1 落点）。 */
const CORNER_PIXELS = (k: ViewerCameraIntrinsics): Array<[number, number]> => [
  [-0.5, -0.5], [k.width - 0.5, -0.5], [k.width - 0.5, k.height - 0.5], [-0.5, k.height - 0.5],
]

/** 投影矩阵（列主序）→ 像素：口径与 camera-view.test.ts:552 同一条（像素中心、原点左上）。 */
function projectViaMatrix(te: number[], p: ViewerVec3, width: number, height: number): [number, number] {
  const w = te[3]! * p[0] + te[7]! * p[1] + te[11]! * p[2] + te[15]!
  const x = te[0]! * p[0] + te[4]! * p[1] + te[8]! * p[2] + te[12]!
  const y = te[1]! * p[0] + te[5]! * p[1] + te[9]! * p[2] + te[13]!
  return [(x / w + 1) / 2 * width - 0.5, (1 - y / w) / 2 * height - 0.5]
}

const axisAngle = (axis: ViewerVec3, rad: number): ViewerQuat => {
  const norm = Math.hypot(...axis), s = Math.sin(rad / 2) / norm
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(rad / 2)]
}
/** 四元数 → `rotationMatrix`（列 = 相机轴，与 camera-fit / worker 回执同一摆法）。 */
function rotationMatrixOf(q: ViewerQuat): number[][] {
  const axes = ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as ViewerVec3[]).map(v => rotateByQuaternion(q, v))
  return [0, 1, 2].map(i => [axes[0]![i], axes[1]![i], axes[2]![i]])
}

const K_SETS: Array<{ name: string; k: ViewerCameraIntrinsics }> = [
  { name: "fx≠fy 非方形像素", k: normalizeIntrinsics({ fx: 700, fy: 520, cx: 319.5, cy: 239.5, width: 640, height: 480 }) },
  { name: "偏心主点", k: normalizeIntrinsics({ fx: 600, fy: 610, cx: 360, cy: 200, width: 640, height: 480 }) },
  { name: "竖幅（W<H）", k: normalizeIntrinsics({ fx: 430, fy: 450, cx: 236, cy: 318, width: 480, height: 640 }) },
]

describe("判据 1：锥角↔K 往返（三条独立解析路径）", () => {
  for (const { name, k } of K_SETS) {
    it(`${name}：frustumCorners 经 projectToPixel / 投影矩阵回投＝图像四角`, () => {
      const depth = 1.7
      const corners = frustumCorners(k, depth)
      const expected = CORNER_PIXELS(k)
      // 路径 A：解析投影（projectToPixel 是生产函数，测试不重写）。
      corners.forEach((corner, i) => {
        const pixel = projectToPixel(k, corner)
        expect(pixel).toBeDefined()
        expect(Math.abs(pixel![0] - expected[i]![0])).toBeLessThan(1e-9)
        expect(Math.abs(pixel![1] - expected[i]![1])).toBeLessThan(1e-9)
      })
      // 路径 B：完整投影矩阵（near/far 参与的第二条独立路径）。
      const te = projectionMatrixFromIntrinsics(k, 0.05, 10)
      corners.forEach((corner, i) => {
        const pixel = projectViaMatrix(te, corner, k.width, k.height)
        expect(Math.abs(pixel[0] - expected[i]![0])).toBeLessThan(0.01)
        expect(Math.abs(pixel[1] - expected[i]![1])).toBeLessThan(0.01)
      })
    })
  }
  it("像素→相机系→像素 自反（pixelToCameraPoint 是 projectToPixel 的逆）", () => {
    const k = K_SETS[1]!.k
    for (const [u, v] of [[61.2, 400.5], [0, 0], [640, 480], [320, 17]] as Array<[number, number]>) {
      const pixel = projectToPixel(k, pixelToCameraPoint(k, u, v, 2.3))!
      expect(Math.abs(pixel[0] - u)).toBeLessThan(1e-9)
      expect(Math.abs(pixel[1] - v)).toBeLessThan(1e-9)
    }
  })
})

describe("判据 2：非对称如实（负对照：fov+aspect 对称锥必须 FAIL）", () => {
  const depth = 2
  /** 解析偏移角：边缘口径矩形中心（＝主点 (cx,cy) 的对称中心 ((W−1)/2,(H−1)/2)）的视线与光轴夹角。
   *  lateral 直接由 `principalPointOffsetPx` 算（判据原文"锥轴与几何中心线夹角＝偏移角"），不复用被测函数。 */
  const expectedSkewDeg = (k: ViewerCameraIntrinsics): number => {
    const offset = principalPointOffsetPx(k)
    return Math.atan2(Math.hypot(-offset.x / k.fx, offset.y / k.fy), 1) / (Math.PI / 180)
  }
  const skewDegOf = (k: ViewerCameraIntrinsics, corners: ViewerVec3[]): number => {
    const center: ViewerVec3 = [0, 1, 2].map(i => corners.reduce((sum, c) => sum + c[i]!, 0) / 4) as ViewerVec3
    const norm = Math.hypot(...center)
    return Math.acos(Math.max(-1, Math.min(1, -center[2] / norm))) / (Math.PI / 180)
  }
  it("偏心主点：锥体非对称，夹角＝解析偏移角（≤0.01°）且 ≥1°", () => {
    const k = K_SETS[1]!.k
    const skew = skewDegOf(k, frustumCorners(k, depth))
    expect(Math.abs(skew - expectedSkewDeg(k))).toBeLessThan(0.01)
    expect(skew).toBeGreaterThan(1)
  })
  it("居中主点（principalPointCentred）：锥体严格对称（夹角≈0，不掺半像素口径差）", () => {
    const k = K_SETS[0]!.k
    expect(skewDegOf(k, frustumCorners(k, depth))).toBeLessThan(0.001)
  })
  it("负对照：fov+aspect 的对称锥在偏心主点用例必须 FAIL（回投残差 >0.5 px），frustumCorners 必须 PASS", () => {
    const k = K_SETS[1]!.k
    // “看着像”的做法：fov+aspect 对称锥——丢掉主点偏移、掰平 fx≠fy（three 居中视锥就是这一支）。
    const halfH = (k.height / (2 * k.fy)) * depth, halfW = halfH * (k.width / k.height)
    const naive: ViewerVec3[] = [[-halfW, halfH, -depth], [halfW, halfH, -depth], [halfW, -halfH, -depth], [-halfW, -halfH, -depth]]
    const expected = CORNER_PIXELS(k)
    const naiveError = Math.max(...naive.map((corner, i) => {
      const pixel = projectToPixel(k, corner)!
      return Math.max(Math.abs(pixel[0] - expected[i]![0]), Math.abs(pixel[1] - expected[i]![1]))
    }))
    const oursError = Math.max(...frustumCorners(k, depth).map((corner, i) => {
      const pixel = projectToPixel(k, corner)!
      return Math.max(Math.abs(pixel[0] - expected[i]![0]), Math.abs(pixel[1] - expected[i]![1]))
    }))
    expect(naiveError).toBeGreaterThan(0.5)   // 判据 1 的门槛是 0.01 px：对称锥明确不过。
    expect(oursError).toBeLessThan(1e-9)
  })
})

describe("判据 3（数学层）：mountLocalFrom 是引擎装配公式的逆", () => {
  const bodyQ = axisAngle([0.2, 1, 0.3], 0.7), camQ = axisAngle([1, -0.4, 0.5], -1.1)
  const bodyWorld = { positionM: [0.3, -0.2, 0.8] as ViewerVec3, quaternionXyzw: bodyQ }
  const camWorld = { positionM: [1.4, 0.6, 0.25] as ViewerVec3, quaternionXyzw: camQ }
  it("复合 body∘local 逐位还原 worldFromCamera（位置与旋转）", () => {
    const local = mountLocalFrom(camWorld, bodyWorld)
    const composedPosition = rotateByQuaternion(bodyQ, local.positionM).map((v, i) => v + bodyWorld.positionM[i]!) as ViewerVec3
    composedPosition.forEach((v, i) => expect(Math.abs(v - camWorld.positionM[i]!)).toBeLessThan(1e-9))
    // 旋转等价：对基向量逐个比（不依赖测试侧自写四元数乘法）。
    for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.3, -0.7, 0.2]] as ViewerVec3[]) {
      const viaLocal = rotateByQuaternion(bodyQ, rotateByQuaternion(local.quaternionXyzw, v))
      const direct = rotateByQuaternion(camQ, v)
      viaLocal.forEach((x, i) => expect(Math.abs(x - direct[i]!)).toBeLessThan(1e-9))
    }
  })
  it("rotationMatrix 输入与 quaternionXyzw 输入同解；复合结果与 camQ 只差符号", () => {
    const fromMatrix = mountLocalFrom({ positionM: camWorld.positionM, rotationMatrix: rotationMatrixOf(camQ) }, bodyWorld)
    const fromQuat = mountLocalFrom(camWorld, bodyWorld)
    fromMatrix.positionM.forEach((v, i) => expect(Math.abs(v - fromQuat.positionM[i]!)).toBeLessThan(1e-9))
    // 矩阵↔四元数往返的浮点精度在 1e-6 deg 量级（实测 2.4e-6 deg）：门槛 1e-4 deg，仍远小于任何可观察偏移。
    expect(quaternionAngleDeg(fromMatrix.quaternionXyzw, fromQuat.quaternionXyzw)).toBeLessThan(1e-4)
  })
  it("坏输入明确拒（ViewerCameraError），不猜位姿", () => {
    expect(() => mountLocalFrom({ positionM: [0, 0, 0] }, bodyWorld)).toThrow(/CAMERA_FRUSTUM_INVALID/)
    expect(() => mountLocalFrom(camWorld, { positionM: [0, 0, 0], quaternionXyzw: [0, 0, 0, 0] })).toThrow(/CAMERA_FRUSTUM_INVALID/)
  })
})

describe("判据 5（坏数据负对照）：frustumFromReceipt 不画不猜", () => {
  const pose = { positionM: [1, 2, 3], rotationMatrix: rotationMatrixOf(axisAngle([0, 0, 1], 0.5)) }
  it("缺 K 且缺 fovy ⇒ {ok:false}，不用默认 FOV 顶替", () => {
    const result = frustumFromReceipt({ cameraName: "wrist", worldFromCamera: pose })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.unavailable).toMatch(/不画锥/)
  })
  it("坏 K（fx≤0）⇒ {ok:false}；零四元数位姿 ⇒ {ok:false}（不抛异常、不猜）", () => {
    expect(frustumFromReceipt({ cameraName: "cam", worldFromCamera: pose, intrinsics: { fx: -1, fy: 600, width: 640, height: 480 } }).ok).toBe(false)
    expect(frustumFromReceipt({ cameraName: "cam", worldFromCamera: { positionM: [0, 0, 0], quaternionXyzw: [0, 0, 0, 0] }, fovyDeg: 45 }).ok).toBe(false)
  })
  it("foovy-only ⇒ 派生 K 并标 fovy-derived（与 worker 同式）", () => {
    const result = frustumFromReceipt({ cameraName: "head", worldFromCamera: pose, fovyDeg: 30 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.spec.intrinsicsSource).toBe("fovy-derived")
      const f = 480 / (2 * Math.tan(15 * Math.PI / 180))
      expect(Math.abs(result.spec.intrinsics.fy - f)).toBeLessThan(1e-9)
      expect(Math.abs(result.spec.intrinsics.fx - result.spec.intrinsics.fy)).toBeLessThan(1e-12)
      expect(fovYFromIntrinsics(result.spec.intrinsics)).toBeCloseTo(30, 9)
    }
  })
  it("有 K 的行：来源/挂载/override/数据时刻原样带上；无 near/far 落显示默认并注明", () => {
    const result = frustumFromReceipt({
      cameraName: "probe_rig/wrist", worldFromCamera: pose, intrinsics: { fx: 600, fy: 610, cx: 360, cy: 200, width: 640, height: 480 },
      intrinsicsSource: "engine-intrinsics", parentBodyName: "probe_rig/link6", referenceFrame: "parent", override: true, stepIndex: 344, simTime: 0.688,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const spec = result.spec
      expect(spec.key).toBe("probe_rig/wrist")
      expect(spec.intrinsicsSource).toBe("engine-intrinsics")
      expect(spec.parentBodyName).toBe("probe_rig/link6")
      expect(spec.referenceFrame).toBe("parent")
      expect(spec.override).toBe(true)
      expect(spec.measured).toEqual({ stepIndex: 344, simTime: 0.688 })
      expect(spec.nearM).toBe(DISPLAY_DEFAULT_NEAR_M)
      expect(spec.farM).toBe(DISPLAY_DEFAULT_FAR_M)
      expect(spec.nearFarSource).toBe("display-default")
      expect(spec.notes.join(" ")).toMatch(/仅显示参数/)
    }
  })
  it("声明 near/far ⇒ nearFarSource=declared；缺 cameraName ⇒ {ok:false}", () => {
    const declared = frustumFromReceipt({ cameraName: "cam", worldFromCamera: pose, fovyDeg: 45, nearM: 0.1, farM: 40 })
    expect(declared.ok && declared.spec.nearFarSource).toBe("declared")
    expect(declared.ok && declared.spec.farM).toBe(40)
    expect(frustumFromReceipt({ worldFromCamera: pose, fovyDeg: 45 }).ok).toBe(false)
  })
})

describe("视锥线框几何（12 段；截断如实标注）", () => {
  const k = K_SETS[1]!.k
  it("lineVertices＝78 个数（含 roll 顶角）；棱线止于像平面（用户反馈：不延伸如无限远）", () => {
    const geometry = frustumGeometry(k, { nearM: 0.05, farM: 10, imagePlaneM: 1 })
    expect(geometry.lineVertices).toHaveLength(78)
    geometry.imageCorners.forEach((corner, i) => {
      corner.forEach((v, j) => expect(Math.abs(v - frustumCorners(k, 1)[i]![j]!)).toBeLessThan(1e-12))
    })
    // 棱线段（floats 48..71）＝顶点(0,0,0)→像平面四角：远端绝不落到 far/截断处。
    geometry.imageCorners.forEach((corner, i) => {
      const edge = geometry.lineVertices.slice(48 + i * 6, 48 + i * 6 + 6)
      expect(Math.abs(edge[0]!)).toBeLessThan(1e-12)
      expect(Math.abs(edge[1]!)).toBeLessThan(1e-12)
      expect(Math.abs(edge[2]!)).toBeLessThan(1e-12)
      corner.forEach((v, j) => expect(Math.abs(edge[3 + j]! - v)).toBeLessThan(1e-12))
    })
    // roll 顶角＝最后一段：near 上边中点沿相机 +Y 伸一小截（roll 一转它就看得出来）。
    const tick = geometry.lineVertices.slice(72)
    const nearTopMidX = (geometry.nearCorners[0]![0] + geometry.nearCorners[1]![0]) / 2
    const nearTopMidY = (geometry.nearCorners[0]![1] + geometry.nearCorners[1]![1]) / 2
    expect(Math.abs(tick[0]! - nearTopMidX)).toBeLessThan(1e-12)
    expect(Math.abs(tick[1]! - nearTopMidY)).toBeLessThan(1e-12)
    expect(tick[3]!).toBeCloseTo(tick[0]!, 12)          // x 不动
    expect(tick[5]!).toBeCloseTo(tick[2]!, 12)          // z 不动
    expect(tick[4]!).toBeGreaterThan(tick[1]!)          // 沿 +Y 伸出
    expect(geometry.truncated).toBe(false)
    expect(geometry.endM).toBe(10)
  })
  it("extendToFar 显式补画延伸线（默认不画）；far 数据仍保留在 endCorners", () => {
    const plain = frustumGeometry(k, { nearM: 0.05, farM: 20, truncationM: 5 })
    expect(plain.lineVertices).toHaveLength(78)          // 截断只影响数据，不画延伸线
    expect(plain.endM).toBe(5)
    expect(plain.truncated).toBe(true)
    const extended = frustumGeometry(k, { nearM: 0.05, farM: 20, truncationM: 5, extendToFar: true })
    expect(extended.lineVertices).toHaveLength(78 + 24)  // 像平面→截断处 4 段（排在 roll 顶角之前）
    extended.endCorners.forEach((corner, i) => {
      const seg = extended.lineVertices.slice(72 + i * 6, 72 + i * 6 + 6)
      extended.imageCorners[i]!.forEach((v, j) => expect(Math.abs(seg[j]! - v)).toBeLessThan(1e-12))
      corner.forEach((v, j) => expect(Math.abs(seg[3 + j]! - v)).toBeLessThan(1e-12))
    })
  })
  it("far 超过 truncationM ⇒ endM=truncationM 且 truncated=true（显示截断不是标定截断）", () => {
    const geometry = frustumGeometry(k, { nearM: 0.05, farM: 100, truncationM: 5 })
    expect(geometry.endM).toBe(5)
    expect(geometry.truncated).toBe(true)
  })
  it("非法 near/far 明确拒", () => {
    expect(() => frustumGeometry(k, { nearM: 1, farM: 1 })).toThrow(/CAMERA_FRUSTUM_INVALID/)
    expect(() => frustumGeometry(k, { nearM: -1, farM: 10 })).toThrow(/CAMERA_FRUSTUM_INVALID/)
  })
})

describe("取景框 captureGateRect/captureGateLabel（实际可拍范围与线框同一口径）", () => {
  /**
   * 口径判据（这组用例的核心）：取景框与"透过该相机看"的投影必须给出同一个可拍范围。
   * 投影落的是 `applyViewToCamera` 那份映射（`scaleIntrinsics` 各向异性缩放），所以这里用
   * `imagePixelToCanvasPixel` 把**图像四条边缘**投到画布，逐点与投影矩阵算出的 NDC±1 对账：
   * 图像边缘落在画布边缘 ⇒ 整块视口就是整幅照片 ⇒ 取景框必须是整块画布。
   */
  const edgePixelsOf = (k: ViewerCameraIntrinsics) =>
    [[-0.5, -0.5], [k.width - 0.5, -0.5], [k.width - 0.5, k.height - 0.5], [-0.5, k.height - 0.5]] as Array<[number, number]>
  /** 投影矩阵（列主序）把相机系一点投到画布像素——与 `projectToPixel(scaleIntrinsics(...))` 同源，独立算一遍。 */
  const projectViaMatrix = (k: ViewerCameraIntrinsics, canvasW: number, canvasH: number, point: ViewerVec3): [number, number] => {
    const elements = projectionMatrixFromIntrinsics(scaleIntrinsics(k, canvasW, canvasH), 0.1, 100)
    const depth = -point[2]
    const ndcX = elements[0]! * point[0] / depth - elements[8]!
    const ndcY = elements[5]! * point[1] / depth - elements[9]!
    return [(ndcX + 1) / 2 * canvasW - 0.5, (1 - ndcY) / 2 * canvasH - 0.5]
  }
  const expectImageEdgesOnCanvasEdges = (k: ViewerCameraIntrinsics, canvasW: number, canvasH: number): void => {
    for (const [u, v] of edgePixelsOf(k)) {
      const mapped = imagePixelToCanvasPixel(k, u, v, canvasW, canvasH)
      const projected = projectViaMatrix(k, canvasW, canvasH, pixelToCameraPoint(k, u, v, 1))
      const imageEdgeX = u === -0.5 ? -0.5 : canvasW - 0.5
      const imageEdgeY = v === -0.5 ? -0.5 : canvasH - 0.5
      expect(Math.abs(mapped[0] - imageEdgeX)).toBeLessThan(1e-9)   // 映射：图像边缘 → 画布边缘
      expect(Math.abs(mapped[1] - imageEdgeY)).toBeLessThan(1e-9)
      expect(Math.abs(projected[0] - mapped[0])).toBeLessThan(1e-6)  // 同一份口径：真实投影矩阵也是这个映射
      expect(Math.abs(projected[1] - mapped[1])).toBeLessThan(1e-6)
    }
  }
  it("4:3 相机进 2:1 宽屏画布＝整块画布（内接矩形口径已作废：线外仍是这台相机的投影）", () => {
    const k = intrinsicsFromFovy(60, 640, 480)
    const gate = captureGateRect(k, 1600, 800)
    expect(gate.left).toBeCloseTo(0, 9)
    expect(gate.top).toBeCloseTo(0, 9)
    expect(gate.width).toBeCloseTo(1600, 9)
    expect(gate.height).toBeCloseTo(800, 9)
    // 负对照：旧的"按 WxH 宽高比居中内接"会给 left≈266.67 / width≈1066.67——那种线框之外的像素仍在取景里。
    expect(Math.abs(gate.left - (1600 - 800 * 640 / 480) / 2)).toBeGreaterThan(1)
    expectImageEdgesOnCanvasEdges(k, 1600, 800)
  })
  it("非 4:3、fx≠fy、偏心主点都一样：图像边缘落在画布边缘（取景框＝整块画布）", () => {
    const cases: Array<[ViewerCameraIntrinsics, number, number]> = [
      [normalizeIntrinsics({ fx: 600, fy: 620, cx: 319.5, cy: 239.5, width: 640, height: 480 }), 1280, 960],  // 同宽高比
      [normalizeIntrinsics({ fx: 800, fy: 900, cx: 320, cy: 240, width: 640, height: 480 }), 1600, 800],    // 偏心 + fx≠fy
      [normalizeIntrinsics({ fx: 700, fy: 700, cx: 300, cy: 300, width: 480, height: 640 }), 1024, 768],    // 竖幅进横幅
      [intrinsicsFromFovy(45, 1920, 1080), 800, 1200],                                                      // 16:9 进竖屏
    ]
    for (const [k, canvasW, canvasH] of cases) {
      const gate = captureGateRect(k, canvasW, canvasH)
      expect(gate.left).toBeCloseTo(0, 9)
      expect(gate.top).toBeCloseTo(0, 9)
      expect(gate.width).toBeCloseTo(canvasW, 9)
      expect(gate.height).toBeCloseTo(canvasH, 9)
      expectImageEdgesOnCanvasEdges(k, canvasW, canvasH)
    }
  })
  it("label：分辨率＋真实垂直 FOV＋这一层的实际口径；宽高比不同时如实标注像素拉伸", () => {
    const k = intrinsicsFromFovy(60, 640, 480)
    expect(captureGateLabel(k)).toBe("640×480 · 垂直FOV 60.0° · 视口即整幅照片")
    expect(captureGateLabel(k, { width: 1280, height: 960 })).toBe("640×480 · 垂直FOV 60.0° · 视口即整幅照片")
    expect(captureGateLabel(k, { width: 1600, height: 800 })).toContain("画布宽高比≠照片：像素被各向异性拉伸")
    expect(captureGateLabel(k, { width: 1600, height: 800 })).not.toContain("线外拍不进")
    expect(() => captureGateRect(k, 0, 800)).toThrow(/CAMERA_FRUSTUM_INVALID/)
  })
})

describe("S3（判据 4 数学层）：cameraAdjustFromDrag 的参考系判定（方案 §9-D2）", () => {
  const worldPose = { positionM: [9, 8, 7] as ViewerVec3, quaternionXyzw: axisAngle([1, 0, 0], 0.3) as ViewerQuat }
  const localPose = { positionM: [0.01, 0.02, 0.03] as ViewerVec3, quaternionXyzw: axisAngle([0, 0, 1], -0.2) as ViewerQuat }
  it("挂载相机（parentBodyName 在场）⇒ parent＋局部安装位姿；自由相机 ⇒ world＋世界位姿", () => {
    const mounted = cameraAdjustFromDrag("wrist", "robot/link6", { worldPose, localPose })
    expect(mounted.referenceFrame).toBe("parent")
    expect(mounted.positionM).toBe(localPose.positionM)
    expect(mounted.quaternionXyzw).toBe(localPose.quaternionXyzw)
    expect(mounted.cameraName).toBe("wrist")
    const free = cameraAdjustFromDrag("overview", undefined, { worldPose, localPose })
    expect(free.referenceFrame).toBe("world")
    expect(free.positionM).toBe(worldPose.positionM)
    expect(free.quaternionXyzw).toBe(worldPose.quaternionXyzw)
  })
  it("原生相机锁位调姿的镜头沿同一命令提交；缺少镜头的旧拖拽不新增 FOV", () => {
    const intrinsics = { fx: 411, fy: 300, cx: 173, cy: 132, width: 384, height: 256 }
    const aimed = cameraAdjustFromDrag("robot/calibrated_eye", "robot/sensor_link", { worldPose, localPose, intrinsics })
    expect(aimed.fovyDeg).toBeCloseTo(2 * Math.atan(256 / 600) * 180 / Math.PI, 10)
    expect(aimed.positionM).toBe(localPose.positionM)
    expect(aimed.referenceFrame).toBe("parent")
    expect(cameraAdjustFromDrag("wrist", "robot/link6", { worldPose, localPose }).fovyDeg).toBeUndefined()
    expect(intrinsics).toEqual({ fx: 411, fy: 300, cx: 173, cy: 132, width: 384, height: 256 })
    expect(() => cameraAdjustFromDrag("wrist", "robot/link6", { worldPose, localPose, intrinsics: { ...intrinsics, fy: 0 } })).toThrow()
  })
})

describe("S2.5 Pilot：cameraRequestFromRig（透过该相机看／对齐机位）", () => {
  const spec = { key: "wrist", source: "engine" as const, positionM: [1, 2, 3] as ViewerVec3, quaternionXyzw: axisAngle([0, 1, 0], 0.6) as ViewerQuat, intrinsics: K_SETS[1]!.k, intrinsicsSource: "engine-intrinsics", nearM: 0.05, farM: 10, nearFarSource: "display-default" as const, notes: [] }
  it("转心落在视线上、距离＝focusDistanceM；lens 决定带不带 K", () => {
    const withLens = cameraRequestFromRig(spec, 2.5, { lens: true })
    expect(withLens.intrinsics).toBe(spec.intrinsics)
    expect(withLens.target).toHaveLength(3)
    // target − position 与视线方向 cameraForward(quaternion) 同向、模长 2.5（转心不歪）。
    const delta = withLens.target.map((v, i) => v - spec.positionM[i]!) as ViewerVec3
    expect(Math.abs(Math.hypot(...delta) - 2.5)).toBeLessThan(1e-12)
    const forward = withLens.target.map((_, i) => delta[i]! / 2.5) as ViewerVec3
    rotateByQuaternion(spec.quaternionXyzw, [0, 0, -1]).forEach((v, i) => expect(Math.abs(v - forward[i]!)).toBeLessThan(1e-12))
    expect(cameraRequestFromRig(spec, 2.5, { lens: false }).intrinsics).toBeUndefined()
  })
  it("非法 focusDistanceM 落 1 m 默认（纯转心参数，不改变成像）", () => {
    const request = cameraRequestFromRig(spec, Number.NaN)
    expect(Math.abs(Math.hypot(...request.target.map((v, i) => v - spec.positionM[i]!)) - 1)).toBeLessThan(1e-12)
  })
})

describe("S4：fovyFromLens（摄影口径 → fovy 提交）", () => {
  it("精确往返：f=fx/W·hAp 时 fovyFromLens(K)===fovYFromIntrinsics(K)；换焦距＝只改整体尺度", () => {
    const k = normalizeIntrinsics({ fx: 700, fy: 700, cx: 319.5, cy: 239.5, width: 640, height: 480 })
    const focalForSame = 700 / 640 * 36
    expect(fovyFromLens(k, focalForSame, 36)).toBeCloseTo(fovYFromIntrinsics(k), 12)
    // 焦距加倍 ⇒ fy′＝2·fy（fx=focal/hAp·W 的线性），视场变窄：按 fy′＝H/(2·tan(fovy′/2)) 反解核对。
    const halfFovY = fovyFromLens(k, focalForSame * 2, 36) / 2 * (Math.PI / 180)
    expect(Math.abs(k.height / (2 * Math.tan(halfFovY)) - 2 * k.fy)).toBeLessThan(1e-9)
  })
  it("非方形像素：fx/fy 比在换算后仍由同一公式给出（不被掰成方形）", () => {
    const k = normalizeIntrinsics({ fx: 700, fy: 520, cx: 319.5, cy: 239.5, width: 640, height: 480 })
    const lens = intrinsicsFromLens({ focalLength: 24, horizontalAperture: 36, verticalAperture: 36 * (k.height / k.fy) / (k.width / k.fx), width: 640, height: 480 })
    expect(Math.abs(lens.fx / lens.fy - k.fx / k.fy)).toBeLessThan(1e-12)
  })
})

describe("S4：intrinsicsFromLens（USD/Isaac 摄影口径 ↔ 像素 K，与 worker.py:1039 同式）", () => {
  it("fx=focal/hAp·W、cx=(W−1)/2−hOffset/hAp·W（USD offset 符号与 CV 相反）；零偏移主点在中心", () => {
    const k = intrinsicsFromLens({ focalLength: 24, horizontalAperture: 20.955, verticalAperture: 15.29, horizontalApertureOffset: 0.3, verticalApertureOffset: -0.2, width: 640, height: 480 })
    expect(k.fx).toBeCloseTo(24 / 20.955 * 640, 12)
    expect(k.fy).toBeCloseTo(24 / 15.29 * 480, 12)
    expect(k.cx).toBeCloseTo(639 / 2 - 0.3 / 20.955 * 640, 12)
    expect(k.cy).toBeCloseTo(479 / 2 + (-0.2) / 15.29 * 480, 12)
    const centred = intrinsicsFromLens({ focalLength: 35, horizontalAperture: 36, verticalAperture: 24, width: 1920, height: 1080 })
    expect(centred.cx).toBe(959.5)
    expect(centred.cy).toBe(539.5)
  })
  it("非正焦距/光圈明确拒", () => {
    expect(() => intrinsicsFromLens({ focalLength: 0, horizontalAperture: 36, verticalAperture: 24, width: 640, height: 480 })).toThrow(/CAMERA_FRUSTUM_INVALID/)
    expect(() => intrinsicsFromLens({ focalLength: 35, horizontalAperture: -36, verticalAperture: 24, width: 640, height: 480 })).toThrow(/CAMERA_FRUSTUM_INVALID/)
  })
})

describe("intrinsicsFromFovy 与 fovy 往返（fovy 路径与 worker 同式）", () => {
  it("fovy→K→fovy 往返；fx=fy 且主点在 ((W−1)/2,(H−1)/2)", () => {
    const k = intrinsicsFromFovy(30, 640, 480)
    expect(fovYFromIntrinsics(k)).toBeCloseTo(30, 12)
    expect(Math.abs(k.fx - k.fy)).toBeLessThan(1e-12)
    expect(k.cx).toBe(319.5)
    expect(k.cy).toBe(239.5)
  })
  it("fovyDeg 越界明确拒", () => {
    expect(() => intrinsicsFromFovy(0)).toThrow(/CAMERA_FRUSTUM_INVALID/)
    expect(() => intrinsicsFromFovy(180)).toThrow(/CAMERA_FRUSTUM_INVALID/)
    expect(() => intrinsicsFromFovy("45")).toThrow(/CAMERA_FRUSTUM_INVALID/)
  })
})
