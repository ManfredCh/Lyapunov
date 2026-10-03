/**
 * 世界生成契约（`src/world-generation-contract.ts`）的合同测试。
 *
 * 2026-09-26 恢复自 `ebe6669^:services/lyapunov-api/test/world-generation-contract.test.ts`（184 行 / 13 用例）：
 *  · 该文件随仓库边界收敛被连带删除，但 13 条里 **12 条**判的是**已移入本包的契约本身**；
 *  · 逐字保留原有断言，只改 import 出处（两处，语义等价，有字节证据）：
 *      `worldGenerationRecipe`  `../client/generation.ts` → `../src/generation.ts`（同一份客户端件）
 *      `parseWorldGenerationSelection` `../src/generation-gateway.ts` → `../src/world-generation-contract.ts`
 *        —— 前者只是后者的**再导出**（`generation-gateway.ts:9` 原文
 *           `export { worldGenerationRecipe, parseWorldGenerationSelection } from "./world-generation-contract"`），
 *           而被移入本包的那份契约与原服务端件 **sha256 逐字节相同**（`c4bdcd13c15b6765…`）。
 *  · **未恢复的 1 条**：`source tiers cannot be quoted, recovered, or stored as routable provider products`
 *    （原 `:148-174`）—— 它起真服务端（`createApi`/`startApi`/`login`/`loadConfig`/`central-stub`），
 *    对象 `services/lyapunov-api/**` 已随 `ebe6669` 移出本仓库 ⇒ **本仓无对象、无法运行**。
 *    **如实登记：该条的覆盖在本仓消失**（登记于
 *    `bugfixHistory/PURGED-CLIENT-TESTS-RESTORE-20260926.md`），未用任何替身顶替。
 */
import { describe, expect, test } from "bun:test"
import { worldGenerationRecipe, type WorldGenerationSelection } from "../src/generation.ts"
import { parseWorldGenerationSelection } from "../src/world-generation-contract.ts"

const recipe = (tier: "low" | "high") => worldGenerationRecipe(tier)

describe("Dev 4090 HY-World generation recipe contract", () => {
  test("maps product low to task3 and product high to task1", () => {
    expect(recipe("low")).toMatchObject({
      tier: "low",
      recipeId: "task3",
      recipeVersion: "hy2-task3-production-v1",
      model: "HY-World 2.0",
      hardware: "RTX 4090D 24GB",
      status: "source-only",
    })
    expect(recipe("high")).toMatchObject({
      tier: "high",
      recipeId: "task1",
      recipeVersion: "hy2-task1-production-v1",
      model: "HY-World 2.0",
      hardware: "RTX 4090D 24GB",
      status: "source-only",
    })
  })

  test("pins task1's documented production recipe with no trajectory truncation", () => {
    // TIERS.md:27-40 and timings.tsv:1; cap=0 means all trajectories, not zero.
    expect(recipe("high").parameters).toEqual({
      trajectory: {
        applyNavTrajectory: true, applyUpRoute: true, reconstructionTopK: 3, wonderTopK: 2,
        framesPerTrajectory: 21, maxTrajectories: 0, observedGeneratedTrajectories: 9,
      },
      video: { maxReference: 6 },
      gaussianSplat: {
        dataInterval: 2, trainingSteps: 4000, noAerial: true, saveNormal: true, splitSky: true,
        evalSteps: 999999, stage5TimeoutSeconds: 1500,
      },
      execution: { quantization: "fp8", cpuOffload: true, sageAttention: true, processesPerStage: 1 },
    })
  })

  test("pins task3 low rather than the faster historical task4 recipe", () => {
    // TIERS.md:47-57 and timings.tsv:32/43. task4's cap5/refs2/1500steps/480s
    // must not leak into the production low recipe.
    expect(recipe("low").parameters).toEqual({
      trajectory: {
        applyNavTrajectory: true, applyUpRoute: false, reconstructionTopK: 2, wonderTopK: 1,
        framesPerTrajectory: 21, maxTrajectories: 6, observedGeneratedTrajectories: 6,
      },
      video: { maxReference: 4 },
      gaussianSplat: {
        dataInterval: 3, trainingSteps: 2500, noAerial: true, saveNormal: true, splitSky: true,
        evalSteps: 999999, stage5TimeoutSeconds: 1500,
      },
      execution: { quantization: "fp8", cpuOffload: true, sageAttention: true, processesPerStage: 1 },
    })
  })

  test("pins evidence references separately for each recipe", () => {
    for (const [tier, task, first, last] of [["high", "task1", 1, 17], ["low", "task3", 32, 43]] as const) {
      const references = recipe(tier).sourceReferences
      expect(references).toContainEqual({ path: "hyworld2_results/results/timings.tsv", fromLine: first, toLine: last })
      expect(references).toContainEqual({ path: "hy2/patches/config_knobs.txt", fromLine: 4, toLine: 8 })
      expect(references).toContainEqual({
        path: `hyworld2_results/results/${task}/ply/position_meta_info.json`, fromLine: 1, toLine: 1,
      })
      expect(references.every((reference) => !reference.path.includes("task4"))).toBe(true)
    }
  })

  test("describes prepared scene input and visual output without inventing native geometry or units", () => {
    for (const tier of ["low", "high"] as const) {
      expect(recipe(tier).input).toEqual({
        kind: "prepared-worldgen-scene-directory", runnerSourcePattern: "examples/worldgen/<scene>",
        panoramaGeneration: "excluded", arbitraryPromptOrUploadIngestion: "unverified",
      })
      const manifest = recipe(tier).artifacts
      expect(manifest.primary).toEqual({ kind: "splat", encoding: "gaussian-ply", pathPattern: "ply/point_cloud_*.ply" })
      expect(manifest.positionMetadata).toEqual({
        path: "ply/position_meta_info.json",
        orientationFields: ["up_direction", "facing_direction"],
        placementFields: ["center_point", "scale", "human_scale"],
        upAxis: "per-artifact-up-direction", handedness: "unverified", physicalUnit: "unverified",
        sourceToNativeTransform: "unverified",
      })
      expect(manifest.unverifiedCapabilities).toEqual(["mesh", "collision", "navigation", "native-viewer-import", "physical-scale"])
      expect(manifest.auxiliaryTypes).toContain("trajectory-mp4")
      expect(manifest.auxiliaryTypes).toContain("optional-validation-png")
      expect(manifest.primary).not.toHaveProperty("downloadUrl")
    }
  })

  test("callers cannot mutate nested recipes or shared output metadata", () => {
    const high = recipe("high")
    const low = recipe("low")
    expect(Reflect.set(low.parameters.trajectory, "maxTrajectories", 5)).toBe(false)
    expect(Reflect.set(low.parameters.gaussianSplat, "trainingSteps", 1500)).toBe(false)
    expect(Reflect.set(high, "recipeVersion", "changed")).toBe(false)
    expect(Reflect.set(low.artifacts.positionMetadata, "physicalUnit", "m")).toBe(false)
    expect(Reflect.set(low.artifacts.positionMetadata.orientationFields, "0", "Y")).toBe(false)
    expect(Reflect.set(low.sourceReferences[0]!, "path", "changed")).toBe(false)
    expect(Reflect.set(low.sourceReferences, "0", {})).toBe(false)
    expect(recipe("low").parameters.trajectory.maxTrajectories).toBe(6)
    expect(recipe("high").artifacts.positionMetadata.physicalUnit).toBe("unverified")
  })

  test("selection parser does not promote supplied parameters or output claims into pinned metadata", () => {
    expect(parseWorldGenerationSelection({
      tier: "low", recipeId: "task3", parameters: { maxTrajectories: 5 },
      artifacts: { physicalUnit: "m", kind: "mesh" }, price: 1, endpoint: "invented",
    })).toEqual({ tier: "low", recipeId: "task3" })
    expect(recipe("low").parameters.trajectory.maxTrajectories).toBe(6)
    expect(recipe("low").artifacts.primary.kind).toBe("splat")
  })

  test("accepts only the tier and recipe pair defined by the contract", () => {
    const low: WorldGenerationSelection = parseWorldGenerationSelection({ tier: "low", recipeId: "task3" })
    const high: WorldGenerationSelection = parseWorldGenerationSelection({ tier: "high", recipeId: "task1" })
    expect(low).toEqual({ tier: "low", recipeId: "task3" })
    expect(high).toEqual({ tier: "high", recipeId: "task1" })
  })

  test("rejects historical task4 instead of accepting it as low", () => {
    expect(() => parseWorldGenerationSelection({ tier: "low", recipeId: "task4" })).toThrow(
      "world generation low requires task3; received task4",
    )
    expect(() => parseWorldGenerationSelection({ tier: "high", recipeId: "task4" })).toThrow(
      "world generation high requires task1; received task4",
    )
  })

  test("rejects cross-tier recipes and other historical/experimental task ids", () => {
    for (const recipeId of ["task1", "task2", "task5"])
      expect(() => parseWorldGenerationSelection({ tier: "low", recipeId })).toThrow("requires task3")
    expect(() => parseWorldGenerationSelection({ tier: "high", recipeId: "task3" })).toThrow("requires task1")
  })

  test("rejects unknown tiers and malformed selections", () => {
    expect(() => worldGenerationRecipe("task4")).toThrow("expected low or high")
    expect(() => parseWorldGenerationSelection({ tier: "low" })).toThrow("requires task3")
    expect(() => parseWorldGenerationSelection({ tier: "task3", recipeId: "task3" })).toThrow("expected low or high")
    expect(() => parseWorldGenerationSelection(null)).toThrow("must be an object")
  })

  test("recipe metadata remains source-only and contains no route or price contract", () => {
    const metadata = recipe("low") as Record<string, unknown>
    expect(metadata.status).toBe("source-only")
    expect(metadata).not.toHaveProperty("endpoint")
    expect(metadata).not.toHaveProperty("baseUrl")
    expect(metadata).not.toHaveProperty("points")
    expect(metadata).not.toHaveProperty("price")
  })
})
