/**
 * ENV-20 源坐标轴向怀疑判别的定向测试：判据只看"声明的 upAxis + **逐个网格**的三轴尺寸"，判不了就不报。
 *
 * 真实读数（`.runtime/lane-env20` 的 Kenney 素材，自己用 GLB 解析器量的）：
 *  · `prop_11_construction-cone.glb`：0.075 × 0.075 × 0.094（高度沿 Z，却按 glTF 默认 Y-up 登记）⇒ 必须报；
 *  · `kenney_props_yup.glb` 的每个道具：高度沿 Y（如 0.6 高、0.238 进深）⇒ 不得报；
 *  · 15 个道具**整棵树**的占地是 29.94 × 7.86 × 68.73 —— 整棵树判会误报，所以判据按逐网格走。
 */
import { describe, expect, test } from "bun:test"
import { axisSuspect, axisSuspectForGltf } from "../src/source-axis.ts"

describe("轴向怀疑判别（逐网格）", () => {
  test("声明 Y-up + 网格确实沿 Y 站着 ⇒ 不报", () => {
    expect(axisSuspect("Y", [{ x: 0.025, y: 0.6, z: 0.238 }])).toBeNull()
    expect(axisSuspect("Y", [{ x: 1, y: 2, z: 1 }])).toBeNull()
  })

  test("真实缺陷：Z-up 的单件锥桶按 Y-up 登记 ⇒ 报 VIEWER_SOURCE_AXIS_SUSPECT（带实测值与比例）", () => {
    const suspect = axisSuspect("Y", [{ x: 0.075, y: 0.075, z: 0.094 }])
    expect(suspect?.code).toBe("VIEWER_SOURCE_AXIS_SUSPECT")
    expect(suspect?.detail).toContain("upAxis=Y")
    expect(suspect?.detail).toContain("0.094")
    expect(suspect?.detail).toContain("1/1")
    expect(suspect?.detail).toContain("sourceTransform")
    expect(suspect?.offenders).toBe(1)
    expect(suspect?.checked).toBe(1)
  })

  test("15 个道具摊在街上的整棵树占地**不得**触发（逐网格判的依据）", () => {
    // 整棵树：29.94 × 7.86 × 68.73（z 远大于 y）——若按整棵树判就会误报；逐网格判只看每个道具自己：
    const props = Array.from({ length: 15 }, () => ({ x: 0.05, y: 0.6, z: 0.238 }))
    expect(axisSuspect("Y", props)).toBeNull()
  })

  test("混合素材：只报躺着的那些，并按 offenders/checked 给出比例", () => {
    const suspect = axisSuspect("Y", [{ x: 0.05, y: 0.6, z: 0.238 }, { x: 0.075, y: 0.075, z: 0.094 }, { x: 0.05, y: 0.5, z: 0.2 }])
    expect(suspect?.offenders).toBe(1)
    expect(suspect?.checked).toBe(3)
    expect(suspect?.detail).toContain("1/3")
  })

  test("声明 Z-up + 网格高度沿 Y ⇒ 对称判定也报", () => {
    expect(axisSuspect("Z", [{ x: 0.025, y: 0.6, z: 0.238 }])?.code).toBe("VIEWER_SOURCE_AXIS_SUSPECT")
  })

  test("判不了就不猜：轴向未知、尺寸退化或非有限 ⇒ null", () => {
    expect(axisSuspect(undefined, [{ x: 1, y: 1, z: 2 }])).toBeNull()
    expect(axisSuspect("", [{ x: 1, y: 1, z: 2 }])).toBeNull()
    expect(axisSuspect("X", [{ x: 1, y: 1, z: 2 }])).toBeNull()
    expect(axisSuspect("Y", [{ x: 0, y: 0, z: 0 }])).toBeNull()
    expect(axisSuspect("Y", [{ x: Number.NaN, y: 1, z: 2 }])).toBeNull()
    expect(axisSuspect("Y", [])).toBeNull()
  })

  test("阈值边界：1.1 倍以内不报（避免把扁平误差当侧倒），略超则报", () => {
    expect(axisSuspect("Y", [{ x: 1, y: 1, z: 1.1 }])).toBeNull()
    expect(axisSuspect("Y", [{ x: 1, y: 1, z: 1.11 }])?.code).toBe("VIEWER_SOURCE_AXIS_SUSPECT")
  })

  test("横向长条（z 大但 x 更大）不该被当成侧倒", () => {
    expect(axisSuspect("Y", [{ x: 100, y: 5, z: 20 }])).toBeNull()
  })
})

test("实际工作间GLB装配零件：脚垫/搁板不代表整件躺倒；展开单子实体仍按完整资源scope",()=>{
  // workstation.glb: Khronos glTF Blender I/O v5.2.40，255 mesh；accessor原始尺寸。
  // 完整源bounds 6.07×3.38×5.0m，Y范围[-.18,3.2]；Viewer实图地面水平、墙与桌架直立。
  const feet=[{x:.13,y:.08,z:.13}],shelf=[{x:.7,y:.025,z:.74}]
  expect(axisSuspect('Y',feet)?.code).toBe('VIEWER_SOURCE_AXIS_SUSPECT')
  expect(axisSuspect('Y',shelf)?.code).toBe('VIEWER_SOURCE_AXIS_SUSPECT')
  expect(axisSuspectForGltf('Y',feet,255)).toBeNull()
  expect(axisSuspectForGltf('Y',shelf,255)).toBeNull()
  expect(axisSuspectForGltf('Y',[...feet,...shelf],255)).toBeNull()
  expect(axisSuspectForGltf('Y',[{x:.075,y:.075,z:.094}],1)?.code).toBe('VIEWER_SOURCE_AXIS_SUSPECT')
})
