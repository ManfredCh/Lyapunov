/**
 * HY-World 2.0 on RTX 4090D: source-level recipe identity only.
 * Product low is task3; high is task1. task4 remains historical evidence.
 * The versioned presets follow TIERS.md's production instructions, including
 * its timeout/eval remedy; they do not reproduce task1's historical eval hang.
 * No worker transport, availability, price, or native import is established here.
 */
export type WorldGenerationTier = "low" | "high"
export type WorldGenerationRecipeId = "task3" | "task1"
export type HistoricalWorldGenerationRecipeId = "task4"

export type WorldGenerationSelection =
  | Readonly<{ tier: "low"; recipeId: "task3" }>
  | Readonly<{ tier: "high"; recipeId: "task1" }>

export type WorldGenerationSourceReference = Readonly<{
  /** Relative to the Lyapunov workspace, not to Dev or the deployed service. */
  path: string
  fromLine: number
  toLine: number
}>

export type WorldGenerationParameters = Readonly<{
  trajectory: Readonly<{
    applyNavTrajectory: true
    applyUpRoute: boolean
    reconstructionTopK: number
    wonderTopK: number
    framesPerTrajectory: 21
    /** Runner knob: 0 means no truncation, not zero generated trajectories. */
    maxTrajectories: number
    observedGeneratedTrajectories: number
  }>
  video: Readonly<{ maxReference: number }>
  gaussianSplat: Readonly<{
    dataInterval: number
    trainingSteps: number
    noAerial: true
    saveNormal: true
    splitSky: true
    /** Shared runner default suppresses the optional single-GPU eval path. */
    evalSteps: 999999
    stage5TimeoutSeconds: 1500
  }>
  execution: Readonly<{
    quantization: "fp8"
    cpuOffload: true
    /** Current production env; original task1 timing used Sage disabled. */
    sageAttention: true
    processesPerStage: 1
  }>
}>

function source(path: string, fromLine: number, toLine: number): WorldGenerationSourceReference {
  return Object.freeze({ path, fromLine, toLine })
}

const sharedExecution = Object.freeze({
  quantization: "fp8", cpuOffload: true, sageAttention: true, processesPerStage: 1,
} as const)

const input = Object.freeze({
  kind: "prepared-worldgen-scene-directory",
  runnerSourcePattern: "examples/worldgen/<scene>",
  panoramaGeneration: "excluded",
  arbitraryPromptOrUploadIngestion: "unverified",
} as const)

/** Describes recorded output types, not a worker response or import guarantee. */
const artifacts = Object.freeze({
  primary: Object.freeze({
    kind: "splat", encoding: "gaussian-ply", pathPattern: "ply/point_cloud_*.ply",
  } as const),
  positionMetadata: Object.freeze({
    path: "ply/position_meta_info.json",
    orientationFields: Object.freeze(["up_direction", "facing_direction"] as const),
    placementFields: Object.freeze(["center_point", "scale", "human_scale"] as const),
    // Both archived samples have up_direction approximately +Z, but not exactly
    // axis-aligned. Preserve each result's vector instead of assuming Y-up/Z-up.
    upAxis: "per-artifact-up-direction",
    handedness: "unverified",
    // scale=1 and human_scale=1 do not prove metres or any other physical unit.
    physicalUnit: "unverified",
    sourceToNativeTransform: "unverified",
  } as const),
  // These are recorded auxiliary types, not required success artifacts. In
  // particular, task1/task3 MP4s were overwritten by subsequent scene reruns.
  auxiliaryTypes: Object.freeze(["trajectory-mp4", "training-checkpoint", "training-config-stats", "optional-validation-png"] as const),
  unverifiedCapabilities: Object.freeze(["mesh", "collision", "navigation", "native-viewer-import", "physical-scale"] as const),
} as const)

export type WorldGenerationRecipe = WorldGenerationSelection & Readonly<{
  recipeVersion: "hy2-task1-production-v1" | "hy2-task3-production-v1"
  model: "HY-World 2.0"
  hardware: "RTX 4090D 24GB"
  status: "source-only"
  parameters: WorldGenerationParameters
  input: typeof input
  artifacts: typeof artifacts
  sourceReferences: readonly WorldGenerationSourceReference[]
}>

const sharedSources = Object.freeze([
  source("hy2/docs/TIERS.md", 3, 17),
  source("hy2/patches/config_knobs.txt", 4, 8),
  source("hy2/scripts/run_task.sh", 28, 64),
  source("hy2/scripts/env.sh", 5, 10),
  source("hy2/README.md", 1, 4),
  source("hyworld2_results/README.md", 19, 43),
])

const recipes = Object.freeze({
  low: Object.freeze({
    tier: "low", recipeId: "task3", recipeVersion: "hy2-task3-production-v1",
    model: "HY-World 2.0", hardware: "RTX 4090D 24GB", status: "source-only",
    parameters: Object.freeze({
      trajectory: Object.freeze({
        applyNavTrajectory: true, applyUpRoute: false, reconstructionTopK: 2, wonderTopK: 1,
        framesPerTrajectory: 21, maxTrajectories: 6, observedGeneratedTrajectories: 6,
      } as const),
      video: Object.freeze({ maxReference: 4 }),
      gaussianSplat: Object.freeze({
        dataInterval: 3, trainingSteps: 2500, noAerial: true, saveNormal: true, splitSky: true,
        evalSteps: 999999, stage5TimeoutSeconds: 1500,
      } as const),
      execution: sharedExecution,
    }),
    input, artifacts,
    sourceReferences: Object.freeze([
      ...sharedSources,
      source("hy2/docs/TIERS.md", 44, 65),
      source("hyworld2_results/results/timings.tsv", 32, 43),
      source("hyworld2_results/results/task3/ply/position_meta_info.json", 1, 1),
    ]),
  } as const),
  high: Object.freeze({
    tier: "high", recipeId: "task1", recipeVersion: "hy2-task1-production-v1",
    model: "HY-World 2.0", hardware: "RTX 4090D 24GB", status: "source-only",
    parameters: Object.freeze({
      trajectory: Object.freeze({
        applyNavTrajectory: true, applyUpRoute: true, reconstructionTopK: 3, wonderTopK: 2,
        framesPerTrajectory: 21, maxTrajectories: 0, observedGeneratedTrajectories: 9,
      } as const),
      video: Object.freeze({ maxReference: 6 }),
      gaussianSplat: Object.freeze({
        dataInterval: 2, trainingSteps: 4000, noAerial: true, saveNormal: true, splitSky: true,
        evalSteps: 999999, stage5TimeoutSeconds: 1500,
      } as const),
      execution: sharedExecution,
    }),
    input, artifacts,
    sourceReferences: Object.freeze([
      ...sharedSources,
      source("hy2/docs/TIERS.md", 24, 42),
      source("hyworld2_results/results/timings.tsv", 1, 17),
      source("hyworld2_results/results/task1/ply/position_meta_info.json", 1, 1),
    ]),
  } as const),
}) satisfies Readonly<Record<WorldGenerationTier, WorldGenerationRecipe>>

/** Resolve only product tier names: experimental task names are not tier aliases. */
export function worldGenerationRecipe(tier: unknown): WorldGenerationRecipe {
  if (tier !== "low" && tier !== "high") throw new Error("invalid world generation tier: expected low or high")
  return recipes[tier]
}

/**
 * Validate identity only, not a worker input or a serialized recipe snapshot.
 * A mismatched/legacy recipe must be rejected, never silently relabelled low.
 * Returned metadata contains only the allowlisted pair; callers obtain pinned
 * parameters from worldGenerationRecipe, never from client-supplied extras.
 */
export function parseWorldGenerationSelection(value: unknown): WorldGenerationSelection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("world generation selection must be an object")
  const selection = value as Record<string, unknown>
  const recipe = worldGenerationRecipe(selection.tier)
  if (selection.recipeId !== recipe.recipeId)
    throw new Error(`world generation ${recipe.tier} requires ${recipe.recipeId}; received ${String(selection.recipeId)}`)
  return { tier: recipe.tier, recipeId: recipe.recipeId } as WorldGenerationSelection
}
