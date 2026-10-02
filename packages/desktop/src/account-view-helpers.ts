import type {AccountOrder,CreditPlan,PaymentProvider} from "../../lyapunov-product-bundle/src/account/client.ts"

export type CommerceSnapshot = {
  plans: CreditPlan[]
  orders: AccountOrder[]
  paymentMethods: Array<{ id: PaymentProvider; available: boolean }>
}

export type CommerceState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: CommerceSnapshot }
  | { kind: "error"; message: string }

export function accountIdentity(state: { status: string; user?: { id: string } }) {
  return state.status === "ready" && state.user ? state.user.id : undefined
}

export function availablePaymentMethods(methods: Array<{ id: PaymentProvider; available: boolean }>) {
  return methods.filter((method) => method.available)
}

export function stablePaymentProvider(
  current: PaymentProvider | undefined,
  methods: Array<{ id: PaymentProvider; available: boolean }>,
): PaymentProvider | undefined {
  const available = availablePaymentMethods(methods)
  if (current && available.some((method) => method.id === current)) return current
  return available[0]?.id
}

export function commerceResultIsCurrent(input: {
  requestIdentity: string
  currentIdentity: string | undefined
  requestEpoch: number
  currentEpoch: number
}) {
  return input.requestIdentity === input.currentIdentity && input.requestEpoch === input.currentEpoch
}

export function commerceErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  return typeof error === "string" && error ? error : fallback
}
