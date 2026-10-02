import type { Frame, SceneSnapshot, WorldHandle } from './types.ts'

/** 当前物理读回的共同身份门；closed/unavailable 的旧缓存不称为当前。 */
export function currentRobotFrame(scene: SceneSnapshot | undefined, world: WorldHandle | undefined, frame: Frame | undefined): Frame | undefined {
  if (!scene || !world || !frame || !['ready', 'running', 'paused'].includes(world.status)) return undefined
  if (world.sceneId !== scene.sceneId || world.appliedSceneRevision !== scene.revision || frame.worldId !== world.worldId || frame.generation !== world.worldGeneration || frame.sceneRevision !== scene.revision) return undefined
  return frame
}
