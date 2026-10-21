/**
 * R-004 原子 Freeze/Restore 的前端归属与状态判定（纯函数，便于正负回归）。
 *
 * 后端回执只对发起时的 world/代次有效；Restore 的 `mismatched`/`not-frozen` 不是“已恢复”，
 * 不能据此清掉本地冻结态或把界面显示成未冻结。这里不建状态，只回答事实问题，
 * 让 workbench 的回调与测试共用同一判据。
 */
import type { FreezeReceipt } from '../../sim-contract/src/index.ts'

export interface FreezeWorldBinding { worldId: string; worldGeneration: number }

/** 回执是否属于发起时的 world/代次：回执自身与当前句柄都必须与绑定一致。 */
export function freezeReceiptMatchesWorld(
  receipt: Pick<FreezeReceipt, 'worldId' | 'generation'>,
  bound: FreezeWorldBinding,
  current: FreezeWorldBinding | undefined,
): boolean {
  return Boolean(current)
    && receipt.worldId === bound.worldId
    && receipt.generation === bound.worldGeneration
    && current!.worldId === bound.worldId
    && current!.worldGeneration === bound.worldGeneration
}

/** Freeze 回执表示确实处于原生保持（此时才可 Restore）。 */
export function freezeReceiptIsFrozen(receipt: Pick<FreezeReceipt, 'status'>): boolean {
  return receipt.status === 'frozen' || receipt.status === 'already-frozen'
}

/** Restore 回执是否真的解除了本次保持；`mismatched`/`not-frozen` 一律不是。 */
export function restoreReceiptCleared(receipt: Pick<FreezeReceipt, 'status'>): boolean {
  return receipt.status === 'restored'
}
