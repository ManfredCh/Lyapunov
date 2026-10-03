import type { ActionReceipt } from "../../lyapunov-contracts/src/types.ts"

/** UI-owned action row; the sim remains the authority for the receipt. */
export interface WorkbenchActionState {
  id: string
  label: string
  waiting?: boolean
  receipt?: ActionReceipt
  error?: string
}

/**
 * Apply the receipts returned by an immediate sim stop to visible action rows.
 * A stop may cancel actions that were started by another surface, so unknown
 * receipt IDs are deliberately ignored; the next state refresh will discover
 * those rows from the session event log.
 */
export function settleStoppedActions<T extends WorkbenchActionState>(
  actions: readonly T[],
  receipts: readonly ActionReceipt[],
): T[] {
  if (receipts.length === 0) return [...actions]
  const byId = new Map(receipts.map(receipt => [receipt.actionId, receipt]))
  return actions.map(action => {
    const receipt = byId.get(action.id)
    return receipt === undefined
      ? action
      : { ...action, waiting: false, receipt, error: undefined }
  })
}
