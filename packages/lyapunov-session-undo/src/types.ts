import type { SnapshotRef } from './worktree.ts'

export interface WorktreeCheckpoint {
  readonly version: 1
  readonly phase: 'before' | 'after'
  readonly turn: number
  readonly step: number
  readonly snapshot: SnapshotRef | null
  readonly messageIds: readonly string[]
  readonly beforeSeq?: number
  readonly paths?: readonly string[]
}
export interface WorktreeCaptureNotice {
  readonly version: 1
  readonly phase: 'preparing' | 'ready'
  /** 需要整树读取的基线快照；增量捕捉不发通知。 */
  readonly full: boolean
  readonly files?: number
  readonly hashed?: number
  readonly bytesRead?: number
  readonly elapsedMs?: number
}
export interface RedoPoint {
  readonly throughSeq: number
  readonly userSeq: number
  readonly snapshot: SnapshotRef | null
  readonly paths: readonly string[]
}
export interface HistoryOperationMetadata {
  readonly version: 1
  readonly operationId: string
  readonly action: 'undo' | 'redo'
  readonly throughSeq: number
  readonly restoreUserSeq: number | null
  readonly nextRedo: readonly RedoPoint[]
  readonly files: { readonly mode: 'git' | 'not-git' | 'disabled'; readonly paths: readonly string[] }
}
export interface HistoryOperationResult {
  readonly schema: 'lyapunov-history-v1'
  readonly action: 'undo' | 'redo' | 'status'
  readonly changed: boolean
  readonly sessionId: string
  readonly checkoutSeq?: number
  readonly throughSeq?: number
  readonly operationId?: string
  readonly restoreUserSeq?: number | null
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly files: { readonly mode: 'git' | 'not-git' | 'disabled'; readonly paths: readonly string[] }
  readonly pendingInputs: number
  readonly recoveryRequired?: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 文件快照引用；省略只影响后续文件撤销可用性，不改变模型历史。 */
    'worktree/checkpoint': WorktreeCheckpoint
    /** 控制器状态，仅当同operationId的required checkout存在时才生效。 */
    'worktree/history-operation': HistoryOperationMetadata
    /** 整树基线快照的准备/完成提示；省略只少一条可见反馈，不影响任何历史与文件语义。 */
    'worktree/capture': WorktreeCaptureNotice
  }
}
