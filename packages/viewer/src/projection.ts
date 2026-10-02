import type { Frame, SceneSnapshot, WorldHandle } from "../../lyapunov-contracts/src/types.ts"

/** 每个 Viewer 只保留一份最新运行帧；模型重建必须先收到新的 WorldHandle。 */
export class FrameProjection {
  private world?: WorldHandle
  private scene?: Pick<SceneSnapshot, 'sceneId' | 'revision'>
  private latest?: Frame
  private consumedFrame?: string
  droppedFrames = 0
  clear(): void { this.latest = undefined; this.consumedFrame = undefined }
  /** 编辑提交后立即收紧投影版本；旧world句柄不能授权旧帧覆盖新文档。 */
  setScene(scene: Pick<SceneSnapshot, 'sceneId' | 'revision'> | undefined): void {
    if (this.scene?.sceneId !== scene?.sceneId || this.scene?.revision !== scene?.revision) this.clear()
    this.scene = scene ? { sceneId: scene.sceneId, revision: scene.revision } : undefined
  }
  setWorld(world: WorldHandle | undefined): void {
    if (this.world?.worldId !== world?.worldId || this.world?.worldGeneration !== world?.worldGeneration || this.world?.appliedSceneRevision !== world?.appliedSceneRevision) {
      this.clear()
    }
    this.world = world ? structuredClone(world) : undefined
  }
  push(frame: Frame): boolean {
    if (!this.acceptsBinding(frame) || (this.latest && frame.stepIndex <= this.latest.stepIndex)) {
      this.droppedFrames++
      return false
    }
    if (this.latest && this.consumedFrame !== this.latest.frameId) this.droppedFrames++
    this.latest = structuredClone(frame)
    return true
  }
  /** 同一步的碰撞几何仍可交付；此处只核身份，步号去重由push负责。 */
  acceptsBinding(frame: Frame): boolean {
    return Boolean(this.world && frame.worldId === this.world.worldId && frame.generation === this.world.worldGeneration && (frame.sceneRevision === undefined || frame.sceneRevision === this.world.appliedSceneRevision) && this.world.status !== 'closed' && (!this.scene || this.scene.sceneId === this.world.sceneId && this.scene.revision === this.world.appliedSceneRevision && frame.sceneRevision === this.scene.revision))
  }
  current(): Frame | undefined { return this.latest ? structuredClone(this.latest) : undefined }
  consume(): Frame | undefined {
    if (!this.latest || this.latest.frameId === this.consumedFrame) return undefined
    this.consumedFrame = this.latest.frameId
    return this.latest
  }
}
