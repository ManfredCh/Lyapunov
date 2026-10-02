/**
 * N43 / task-76（DEV-009）：相机族描述必须等于**真实**的按 Provider 能力范围。
 *
 * 为什么值得钉：2026-09-22 真机复核发现 `cameraFamilyScope` 曾写"相机族当前只由 MuJoCo provider 真实实现；
 * Isaac provider 返回 UNSUPPORTED"——而 Isaac provider 早已真实接线 `camera_list`／`camera_adjust`
 * （`packages/sim-isaac/src/provider.ts`；真机 rendering:none 下 `camera_list` 回
 * `status:"AVAILABLE"`、`camera_adjust` 回真实 override 回执）。描述低估能力同样违反"自报 = 真实范围"。
 *
 * 2026-09-26（DEV-009 剩下的 2/5 缺口）：`camera_project_annotation`／`camera_dataset_export` 的
 * Isaac 侧实现与 provider 转发已落盘（`packages/sim-isaac/python/worker.py` 的 `project_annotation`／
 * `export_camera_dataset`），所以这两个入口也从"只由 MuJoCo provider 真实实现"改挂**共享范围**
 * （`cameraAnalysisScope`）。本用例现在钉：五个入口**都**挂共享范围，且旧口径常量名不再留在导出面上
 * （留着就说明还有入口在用旧口径）。
 *
 * 这份测试钉的是**描述面与范围常量的同源关系**（五个入口各自挂哪一条），不冒充引擎实测；
 * 引擎侧读数在 `bugfixHistory/DEV009-ISAAC-INTERFACES-20260926.md`：本机没有 `/dev/nvidia*`，
 * 算术/文件层已用真实数值复算，RTX 成像面如实登记为未覆盖（需一次设备可见会话）。
 */
import { describe, expect, test } from "bun:test"
import * as schema from "../src/tool-schema.ts"
import { cameraAnalysisScope, cameraFamilyScope, robotToolParameters } from "../src/tool-schema.ts"

const textOf = (tool: keyof typeof robotToolParameters): string => JSON.stringify(robotToolParameters[tool])
const SHARED = "MuJoCo and Isaac implement"
const MUJOCO_ONLY = /(?:Only MuJoCo(?: provider)?|MuJoCo(?: provider)? alone) implements/i

describe("相机族按 Provider 的真实范围（描述面）", () => {
  test("五个入口全部挂共享范围：Isaac 侧五个都已实现，不再有 MuJoCo-only 入口", () => {
    for (const tool of ["camera_list", "camera_capture_multi", "camera_adjust", "camera_project_annotation", "camera_dataset_export"] as const) {
      const text = textOf(tool)
      expect(text).toContain(SHARED)
      expect(text).not.toMatch(MUJOCO_ONLY)
    }
  })

  test("负对照：旧口径常量名不再导出（留着就说明有入口还在用旧口径）", () => {
    expect(Object.keys(schema)).not.toContain("mujocoOnlyCameraScope")
  })

  test("共享范围写明 Isaac 的 RTX 前置与阶段化拒绝，且不再声称 Isaac 整族 UNSUPPORTED", () => {
    expect(cameraFamilyScope).toContain("rendering:rtx")
    expect(cameraFamilyScope).toContain("SENSOR_UNAVAILABLE")
    expect(cameraFamilyScope).toContain("UNSUPPORTED_CAPABILITY")   // Newton 的拒绝码
    expect(cameraFamilyScope).not.toMatch(/Isaac(?: provider)?(?: explicitly)? returns UNSUPPORTED(?:_CAPABILITY)?\b/)
  })

  test("标注/导出的共享范围写明真实深度来源与结构化拒绝，不再引用 Isaac 的 UNSUPPORTED 原文", () => {
    expect(cameraAnalysisScope).toContain(SHARED)
    expect(cameraAnalysisScope).not.toMatch(/Isaac(?: provider)?(?: explicitly)? returns UNSUPPORTED(?:_CAPABILITY)?\b/)
    // 与 worker 侧逐条同源：真实深度两种来源 + 阶段化拒绝/结构化错误码 + Newton 无通道
    expect(cameraAnalysisScope).toContain("capture")
    expect(cameraAnalysisScope).toContain("SENSOR_UNAVAILABLE")
    expect(cameraAnalysisScope).toContain("stale-generation")
    expect(cameraAnalysisScope).toContain("UNSUPPORTED_CAPABILITY")
    expect(cameraAnalysisScope).toContain("Newton")
  })
})
