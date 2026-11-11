import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { X_OK } from 'node:constants'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-subprocess'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { requireSessionId, sessionNamespace } from '../../lyapunov-contracts/src/session-scope.ts'
import { isForeignSessionTarget, pathWithin } from '../../lyapunov-contracts/src/writable-boundary.ts'
import { requireWritableTarget } from '../../scene-kit/src/plugin.ts'

const labRevision = 'e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4'
const foundryRevision = '9e34ebefcd020583fbb755a8b57268dce78eca26'
const mimicGenerate = 'scripts/imitation_learning/isaaclab_mimic/generate_dataset.py'
const poseStage = 'scripts/pipeline/A_reconstruction/stages/8_match_object_poses.py'
const pythonDir = fileURLToPath(new URL('../python/', import.meta.url))

declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { lyapunov_offline_scene: 'lyapunov-offline-scene' } }

export interface OfflineSceneConfig {
  offlineUsdPython?: string
  nurecPython?: string
  labMimicPython?: string
  labSourceRoot?: string
  simfoundryPython?: string
  simfoundryRoot?: string
}

type Arguments = Record<string, unknown>
type ProcessSpec = { script: string; args: string[]; env?: Record<string, string> }
type Workflow = {
  description: string
  properties: ParameterSchemaSpec
  python?: string
  prepare(input: Arguments, file: (value: unknown, kind?: 'directory') => Promise<string>): Promise<(output: string) => ProcessSpec>
}

const text = (description: string) => ({ type: 'string' as const, required: true as const, description })
const number = (description: string) => ({ type: 'number' as const, description })
const integer = (description: string) => ({ type: 'integer' as const, description })
const choice = (description: string, values: string[]) => ({ ...text(description), enum: values })

function checkedText(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`OFFLINE_INPUT_INVALID: ${label}`)
  return value
}

function checkedNumber(value: unknown, label: string, min: number, max: number, whole = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || whole && !Number.isInteger(value)) {
    throw new Error(`OFFLINE_INPUT_INVALID: ${label} 必须在 ${min}–${max} 范围内${whole ? '且为整数' : ''}`)
  }
  return String(value)
}

async function pinnedScript(root: string | undefined, path: string, sha256: string, revision: string) {
  if (!root || !isAbsolute(root)) throw new Error(`OFFLINE_SOURCE_UNAVAILABLE: 请配置固定上游工作树 ${revision}`)
  const script = join(root, path)
  const bytes = await readFile(script).catch(() => { throw new Error(`OFFLINE_SOURCE_UNAVAILABLE: ${path}`) })
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(`OFFLINE_SOURCE_MISMATCH: ${path}（预期 ${revision}）`)
  return script
}

export function applyOfflineSceneWorkflows(ctx: Context, config: OfflineSceneConfig) {
  let subprocess: Context['subprocess'] | undefined
  ctx.inject(['subprocess'], owner => {
    subprocess = owner.subprocess
    owner.effect(() => () => { subprocess = undefined })
  })
  const workflows: Record<string, Workflow> = {
    asset_prepare_usd: {
      description: 'Prepare a portable native USD prop from a local textured mesh with the pinned SimFoundry converter. Supply known source up axis, scale to meters and mass in kg. Returns a Job. Read job_output, then use scene_import with the returned USD and physicalize:false, followed by asset_verify. The Job alone does not add an entity or prove physics.',
      python: config.offlineUsdPython,
      properties: { sourcePath: text('Self-contained GLB in the task workspace.'), upAxis: choice('Source up axis.', ['y', 'z']), scale: { ...number('Positive uniform scale to metres.'), required: true }, massKg: { ...number('Known mass in kilograms.'), required: true }, collision: choice('Convex hull for a solid object; decomposition for concave geometry.', ['convexHull', 'convexDecomposition']) },
      async prepare(input, file) {
        const source = await file(input.sourcePath)
        const up = checkedText(input.upAxis, 'upAxis')
        const collision = checkedText(input.collision, 'collision')
        if (!['y', 'z'].includes(up) || !['convexHull', 'convexDecomposition'].includes(collision)) throw new Error('OFFLINE_INPUT_INVALID: upAxis/collision')
        const scale = checkedNumber(input.scale, 'scale', Number.MIN_VALUE, 1000)
        const mass = checkedNumber(input.massKg, 'massKg', 0.01, 50)
        return output => ({ script: join(pythonDir, 'prepare_simfoundry_usd.py'), args: ['--source', source, '--output', output, '--up-axis', up, '--scale', scale, '--mass', mass, '--collision', collision] })
      },
    },
    nurec_evaluate: {
      description: 'Render a local NuRec USD with a separate Isaac RTX process and compare matched reference frames. Use a reference directory containing <camera>/<timestamp_ns>.png or .jpg. Returns a Job. Read job_output for paired frame count, PSNR and SSIM. The current world is not stepped.',
      python: config.nurecPython,
      properties: { stagePath: text('Local NuRec USD in the task workspace.'), referenceDir: text('Local reference frame directory.'), camera: text('Exact USD/reference camera name.'), samples: integer('Frames to sample, default 10, at most 50.'), width: integer('Default 960 pixels.'), height: integer('Default 600 pixels.'), warmupSteps: integer('RTX warmup ticks per frame, default 48.') },
      async prepare(input, file) {
        const stage = await file(input.stagePath)
        const refs = await file(input.referenceDir, 'directory')
        const camera = checkedText(input.camera, 'camera')
        if (!/^[\w.-]+$/.test(camera) || camera === '.' || camera === '..') throw new Error('OFFLINE_INPUT_INVALID: camera')
        const samples = checkedNumber(input.samples ?? 10, 'samples', 1, 50, true)
        const width = checkedNumber(input.width ?? 960, 'width', 16, 4096, true)
        const height = checkedNumber(input.height ?? 600, 'height', 16, 4096, true)
        const warmup = checkedNumber(input.warmupSteps ?? 48, 'warmupSteps', 1, 512, true)
        return output => ({ script: join(pythonDir, 'evaluate_nurec_scene.py'), args: ['--stage', stage, '--references', refs, '--output', output, '--camera', camera, '--samples', samples, '--resolution', width, height, '--warmup-steps', warmup, '--shader-cache', join(dirname(output), 'nurec-shader-cache')] })
      },
    },
    lab_mimic_run: {
      description: 'Replay or augment annotated demonstrations for the fixed Lyapunov Cartesian gripper task with Isaac Lab Newton CPU. Requires the prepared cart USD and annotated HDF5; plain recording_export is an earlier input. Returns a Job. Use job_output for actual success/failure counts and resulting datasets.',
      python: config.labMimicPython,
      properties: { mode: choice('Replay annotated source demos or generate variants.', ['replay', 'augment']), datasetPath: text('Annotated HDF5 in the task workspace.'), assetUsd: text('Prepared Cartesian gripper USD in the task workspace.'), trials: integer('Augmentation attempts, default 10, maximum 100.') },
      async prepare(input, file) {
        const mode = checkedText(input.mode, 'mode')
        if (!['replay', 'augment'].includes(mode) || mode === 'replay' && input.trials !== undefined) throw new Error('OFFLINE_INPUT_INVALID: mode/trials')
        const dataset = await file(input.datasetPath)
        const asset = await file(input.assetUsd)
        const trials = checkedNumber(input.trials ?? 10, 'trials', 1, 100, true)
        const upstream = mode === 'augment' ? await pinnedScript(config.labSourceRoot, mimicGenerate, 'b309e3be781c3c8af43151932938578203f3f066320e955ff38a97e6c70bcb24', labRevision) : undefined
        return output => ({ script: join(pythonDir, 'run_lab_mimic.py'), args: [mode, '--dataset', dataset, '--output', output, ...(upstream ? ['--generate-script', upstream, '--trials', trials] : [])], env: { LYAPUNOV_LAB_CART_ASSET: asset } })
      },
    },
    simfoundry_match_poses: {
      description: 'Run the pinned SimFoundry stage 8 CPD pose matching on existing local stage 2–7 outputs from a captured tabletop. Requires prepared scene data, not a raw video. Runs one selected object without the optional VLM or FoundationPose stages. Returns a Job and a pose candidate report, not a Scene edit.',
      python: config.simfoundryPython,
      properties: { preparedSceneDir: text('Task-workspace directory containing the prepared SimFoundry s2_da, s3_ground, s4_frame, s5_scene and s7_mesh outputs.'), objectIndex: { ...integer('One upstream object index.'), required: true }, meshBackend: choice('Backend that produced s7_mesh/textured_mesh.', ['hunyuan', 'trellis', 'trellis2', 'pixal3d', 'direct3d']) },
      async prepare(input, file) {
        const scene = await file(input.preparedSceneDir, 'directory')
        const index = checkedNumber(input.objectIndex, 'objectIndex', 0, 1_000_000, true)
        const backend = checkedText(input.meshBackend, 'meshBackend')
        if (!['hunyuan', 'trellis', 'trellis2', 'pixal3d', 'direct3d'].includes(backend)) throw new Error('OFFLINE_INPUT_INVALID: meshBackend')
        for (const relative of ['s2_da/da/exports/npz/results.npz', 's3_ground', 's4_frame', 's5_scene/source_padded_resized.png', `s7_mesh/textured_mesh/${backend}`]) {
          await file(join(scene, relative), /\.(png|npz)$/.test(relative) ? undefined : 'directory')
        }
        const upstream = await pinnedScript(config.simfoundryRoot, poseStage, '59ca74539a6aeec270652725cc7ba7c6a09ddaface1c6750cfd2a7ed7d61e42b', foundryRevision)
        return output => ({ script: join(pythonDir, 'match_simfoundry_pose.py'), args: ['--source', scene, '--output', output, '--stage-script', upstream, '--object-index', index, '--mesh-backend', backend] })
      },
    },
  }

  const capabilityDescription = 'List scene and Isaac workflows visible in this session and the local dependencies configured for each. Use when users ask what this workbench can do. A configured interpreter does not establish that the input or GPU will pass a real job.'
  const capabilities = async () => ({ workflows: await Promise.all(Object.entries(workflows).map(async ([tool, workflow]) => {
    const python = workflow.python
    const interpreter = !!python && isAbsolute(python) && await access(python, X_OK).then(() => true, () => false)
    const upstream = tool === 'lab_mimic_run' ? config.labSourceRoot : tool === 'simfoundry_match_poses' ? config.simfoundryRoot : undefined
    const sourcePath = tool === 'lab_mimic_run' ? mimicGenerate : poseStage
    const sourceConfigured = !!upstream && isAbsolute(upstream) && await access(join(upstream, sourcePath)).then(() => true, () => false)
    return { tool, interpreter, ...(tool === 'lab_mimic_run' || tool === 'simfoundry_match_poses' ? { sourceConfigured } : {}) }
  })), registered: ['recording_export', 'asset_verify', 'robot_teleop_start', 'crowd_configure'].filter(tool => ctx.tools.get(tool) !== undefined) })
  ctx.tools.register(defineTool({ name: 'scene_workflow_capabilities', description: capabilityDescription, parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: capabilities }))
  ctx.commands.register({ name: 'scene_workflow_capabilities', description: capabilityDescription, async handler() {
    return { kind: 'success', text: JSON.stringify(await capabilities()) }
  } })

  for (const [name, workflow] of Object.entries(workflows)) {
    const run = async (input: Arguments, agent: Agent | undefined, signal: AbortSignal) => {
      const spawn = subprocess
      if (!spawn || !workflow.python || !isAbsolute(workflow.python)) throw new Error(`OFFLINE_RUNTIME_UNAVAILABLE: ${name} 的独立 Python 未配置`)
      const python = workflow.python
      await access(python, X_OK).catch(() => { throw new Error(`OFFLINE_RUNTIME_UNAVAILABLE: ${name} 的 Python 无法执行`) })
      const sessionId = requireSessionId(agent, name)
      const rawWorkspace = agent?.session.header.cwd
      if (!agent || !rawWorkspace || !isAbsolute(rawWorkspace)) throw new Error('OFFLINE_WORKSPACE_REQUIRED')
      const workspace = await realpath(rawWorkspace)
      const file = async (value: unknown, kind?: 'directory') => {
        const raw = checkedText(value, '输入路径')
        const path = await realpath(resolve(workspace, raw)).catch(() => { throw new Error(`OFFLINE_INPUT_MISSING: ${raw}`) })
        if (!pathWithin(workspace, path) || isForeignSessionTarget(path, workspace, sessionId)) throw new Error(`OFFLINE_INPUT_OUTSIDE_WORKSPACE: ${raw}`)
        const info = await stat(path)
        if (kind === 'directory' ? !info.isDirectory() : !info.isFile()) throw new Error(`OFFLINE_INPUT_INVALID: ${raw}`)
        return path
      }
      const prepare = await workflow.prepare(input, file)
      const parent = join(sessionNamespace(join(workspace, '.lyapunov'), sessionId), 'offline-scene')
      requireWritableTarget(ctx, agent, parent, name)
      await mkdir(parent, { recursive: true, mode: 0o700 })
      if (name === 'nurec_evaluate') requireWritableTarget(ctx, agent, join(parent, 'nurec-shader-cache'), name)
      const canonical = await realpath(parent)
      if (canonical !== parent) throw new Error('OFFLINE_OUTPUT_OUTSIDE_SESSION')
      signal.throwIfAborted()
      const outputDir = join(parent, `${name}-${randomUUID()}`)
      const jobId = ctx.jobs.start({ kind: 'lyapunov-offline-scene', label: name, owner: agent.id, outputLimitBytes: 32_768, run: () => {
        const controller = new AbortController()
        const done = (async () => {
          await mkdir(outputDir, { mode: 0o700 })
          controller.signal.throwIfAborted()
          const spec = prepare(outputDir)
          const child = spawn.spawn({ argv: [python, spec.script, ...spec.args], cwd: outputDir, signal: controller.signal, graceMs: 2000,
            stdio: { stdin: { data: '' }, stdout: { maxBytes: 64_000 }, stderr: { maxBytes: 64_000 } },
            env: { HF_ENDPOINT: 'https://hf-mirror.com', HF_HUB_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1', ...spec.env } })
          const outcome = await child.done
          controller.signal.throwIfAborted()
          if (outcome.exitCode !== 0) {
            const detail = child.collected.stderr?.readFrom(0).text || child.collected.stdout?.readFrom(0).text || String(outcome.exitCode)
            throw new Error(`OFFLINE_WORKFLOW_FAILED: ${name}\n${detail.slice(-7000)}`)
          }
          const report = JSON.parse(await readFile(join(outputDir, 'result.json'), 'utf8'))
          if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('OFFLINE_REPORT_INVALID')
          return { status: 'completed' as const, result: JSON.stringify({ workflow: name, outputDir, reportPath: join(outputDir, 'result.json'), summary: report.summary ?? report.metrics?.overall,
            ...(name === 'asset_prepare_usd' && typeof report.rootUsd === 'string' ? { usdPath: join(outputDir, report.rootUsd) } : {}) }) }
        })().catch(error => ({ status: controller.signal.aborted ? 'killed' as const : 'failed' as const, result: String(error) }))
        return { cancel: () => controller.abort(), done }
      } })
      return { jobId, outputDir }
    }
    const parameters: ParameterSchemaSpec = { input: { type: 'object', required: true, additionalProperties: false, properties: workflow.properties } }
    ctx.tools.register(defineTool({ name, description: workflow.description, parameters, output: { schema: { type: 'json' }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
      execute: (args, exec) => run(args.input as Arguments, exec.agent, exec.signal) }))
    ctx.commands.register({ name, description: workflow.description, input: { hint: 'JSON' }, async handler(invocation) {
      try { return { kind: 'success', text: JSON.stringify(await run(JSON.parse(invocation.rawInput), invocation.agent, invocation.signal)) } }
      catch (error) { return { kind: 'error', text: String(error) } }
    } })
  }
}
