import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HumanClip, HumanDefinition, SceneSnapshot, Vec3 } from '../../lyapunov-contracts/src/types.ts'
import type { SceneOperations } from '../../scene-kit/src/operations.ts'
import type { SimWorlds } from '../../sim-contract/src/index.ts'
import { SOMA_MODEL_DIR_ENV, SOMA_PYTHON_ENV } from './env.ts'

const worker = fileURLToPath(new URL('../python/soma.py', import.meta.url))

interface PoseSelector {
  clip: string
  timeS: number
  positionM?: Vec3
  yawRad?: number
}

interface GenerateInput {
  sceneId: string
  expectedRevision: number
  entityId: string
  name: string
  context: PoseSelector[]
  target: PoseSelector[]
  allowedTokens?: number[]
}

interface PlayInput {
  sceneId: string
  worldId: string
  expectedGeneration: number
  entityId: string
  clip: string
}

function configuration() {
  const directory = process.env[SOMA_MODEL_DIR_ENV]
  const python = process.env[SOMA_PYTHON_ENV]
  if (!directory || !python) throw Error('SOMA_DISABLED: 请显式设置 LYAPUNOV_SOMA_MODEL_DIR 和 LYAPUNOV_SOMA_PYTHON')
  if (!isAbsolute(directory) || !isAbsolute(python)) throw Error('SOMA_CONFIG_INVALID: 两项配置均须为绝对路径')
  return { directory, python }
}

function localSoma(operation: 'status' | 'generate', signal: AbortSignal, input?: object): Promise<unknown> {
  const { directory, python } = configuration()
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = execFile(python, ['-I', '-B', worker, operation, directory], {
      env: { PATH: process.env.PATH, CUDA_VISIBLE_DEVICES: '' },
      signal, maxBuffer: 8 * 1024 * 1024, timeout: 300_000,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(signal.aborted ? signal.reason : Error(`SOMA_${operation.toUpperCase()}_FAILED: ${stderr.trim() || error.message}`))
        return
      }
      try { resolve(JSON.parse(stdout)) }
      catch { reject(Error('SOMA_OUTPUT_INVALID: 本地进程未返回 JSON')) }
    })
    child.stdin?.on('error', () => { /* 退出状态和 stderr 由回调回收。 */ })
    child.stdin?.end(input === undefined ? undefined : JSON.stringify(input))
  })
}

function findTemplate(scene: SceneSnapshot, entityId: string) {
  const actor = scene.entities.find(entity => entity.entityId === entityId)
  if (!actor) throw Error('HUMAN_ENTITY_MISSING')
  const ref = actor.components.human?.definition
  const template = ref ? scene.entities.find(entity => entity.entityId === ref.entityId) : actor
  const definition = (template?.components.humanDefinition ?? (
    !ref && actor.components.human?.rig && actor.components.human?.clips ? actor.components.human : undefined
  )) as HumanDefinition | undefined
  if (!template || !definition) throw Error('HUMAN_TEMPLATE_DEFINITION_MISSING')
  if (ref && !template.resources.some(resource => resource.resourceId === ref.resourceId && resource.version === ref.version)) {
    throw Error('HUMAN_TEMPLATE_STALE')
  }
  return { actor, template, definition }
}

export async function inspectSoma(signal: AbortSignal) {
  try { return await localSoma('status', signal) }
  catch (error) {
    signal.throwIfAborted()
    return { status: 'unavailable', reason: String(error) }
  }
}

export async function generateSoma(ops: SceneOperations, input: GenerateInput, signal: AbortSignal) {
  configuration()
  const scene = await ops.scene.snapshot(input.sceneId)
  if (scene.revision !== input.expectedRevision) throw Error('SCENE_REVISION_MISMATCH')
  const { template, definition } = findTemplate(scene, input.entityId)
  if (definition.mode !== 'kinematic' || definition.ira) throw Error('SOMA_HUMAN_MODE_UNSUPPORTED')
  const name = input.name?.trim()
  if (!name || name.length > 96 || definition.clips.some(clip => clip.name === name)) throw Error('SOMA_CLIP_NAME_INVALID')
  if (!Array.isArray(input.context) || input.context.length !== 4 || !Array.isArray(input.target) ||
      input.target.length < 1 || input.target.length > 4) throw Error('SOMA_POSE_COUNT_INVALID')
  for (const selector of [...input.context, ...input.target]) {
    const clip = definition.clips.find(clip => clip.name === selector?.clip)
    if (!clip || !Number.isFinite(selector.timeS) || selector.timeS < 0 || selector.timeS > clip.durationS + 1e-7) {
      throw Error('SOMA_POSE_SOURCE_INVALID: 选择已导入片段及有效秒数')
    }
    if (selector.positionM !== undefined && (!Array.isArray(selector.positionM) || selector.positionM.length !== 3 ||
        !selector.positionM.every(Number.isFinite)) || selector.yawRad !== undefined && !Number.isFinite(selector.yawRad)) {
      throw Error('SOMA_POSE_PLACEMENT_INVALID')
    }
  }
  const allowedTokens = input.allowedTokens ?? Array.from({ length: 11 }, (_, i) => i + 6)
  if (!Array.isArray(allowedTokens) || !allowedTokens.length || allowedTokens.length > 11 ||
      new Set(allowedTokens).size !== allowedTokens.length || allowedTokens.some(n => !Number.isInteger(n) || n < 6 || n > 16)) {
    throw Error('SOMA_TOKENS_INVALID')
  }
  const clip = await localSoma('generate', signal, {
    name, context: input.context, target: input.target, allowedTokens,
    definition: { rig: definition.rig, boneMapping: definition.boneMapping, clips: definition.clips.filter(
      clip => [...input.context, ...input.target].some(selector => selector.clip === clip.name)) },
  }) as HumanClip
  if (clip.name !== name || clip.generation?.provider !== 'soma-local' || !Number.isFinite(clip.durationS) ||
      clip.durationS <= 0 || clip.tracks.length !== definition.rig.length) throw Error('SOMA_OUTPUT_INVALID')
  signal.throwIfAborted()
  const key = template.components.humanDefinition ? 'humanDefinition' : 'human'
  const snapshot = await ops.scene.commit({ sceneId: scene.sceneId, expectedRevision: scene.revision, patch: [
    { op: 'update', entityId: template.entityId, changes: { components: {
      ...template.components, [key]: { ...definition, clips: [...definition.clips, clip] },
    } } },
  ] })
  return { status: 'generated', sceneId: scene.sceneId, revision: snapshot.revision, sceneRevision: snapshot.revision,
    definitionEntityId: template.entityId, clip: clip.name, durationS: clip.durationS,
    generation: clip.generation, worldNeedsSync: true }
}

export async function playHumanClip(ops: SceneOperations, sim: SimWorlds, input: PlayInput, signal: AbortSignal) {
  const scene = await ops.scene.snapshot(input.sceneId)
  const { actor, definition } = findTemplate(scene, input.entityId)
  if (actor.components.human?.mode !== 'kinematic' || actor.components.human.ira) throw Error('HUMAN_CLIP_MODE_UNSUPPORTED')
  const clip = definition.clips.find(clip => clip.name === input.clip)
  if (!clip) throw Error('HUMAN_CLIP_MISSING')
  const world = (await sim.listWorlds()).find(world => world.worldId === input.worldId)
  if (!world || world.sceneId !== scene.sceneId) throw Error('HUMAN_WORLD_SCENE_MISMATCH')
  if (world.engineId !== 'mujoco') throw Error('HUMAN_CLIP_PROVIDER_UNSUPPORTED: 一次性片段当前由 MuJoCo 执行')
  if (world.appliedSceneRevision !== scene.revision) throw Error('HUMAN_WORLD_UNSYNCED')
  if (world.worldGeneration !== input.expectedGeneration) throw Error('STALE_GENERATION')
  signal.throwIfAborted()
  const receipt = await sim.execute(input.worldId, { kind: 'human', actionId: randomUUID(), expectedGeneration: input.expectedGeneration,
    entityId: input.entityId, durationS: clip.durationS, onceClip: clip.name }, signal)
  // MuJoCo 的 startStep 与 endStep 都是实际动作步号，区间包含两端。
  if (receipt.startStep === undefined || receipt.endStep === undefined) return receipt
  return { ...receipt, simSteps: Math.max(0, receipt.endStep - receipt.startStep + 1) }
}
