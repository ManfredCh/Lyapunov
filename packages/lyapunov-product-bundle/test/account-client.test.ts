import { expect, test } from "bun:test"
import { createAccountClient, summarizeAccountUsage, type AccountLedgerEntry } from "../src/account/client.ts"

test("account usage keeps available and reserved separate and defers used without a period", () => {
  const entries = [
    {
      id: "reserve-1",
      type: "reserve",
      availableDelta: -120,
      reservedDelta: 120,
      createdAt: "2026-09-25T00:00:00.000Z",
    },
    {
      id: "settle-1",
      type: "settle",
      availableDelta: -80,
      reservedDelta: -120,
      createdAt: "2026-09-25T00:01:00.000Z",
    },
  ] satisfies AccountLedgerEntry[]

  expect(summarizeAccountUsage({ combo: 900, opus: 100, points: 1_000, reservedPoints: 40 }, entries)).toEqual({
    available: 1_000,
    reserved: 40,
    usedStatus: "unavailable",
  })
})

test("ledger requests preserve the caller abort signal", async () => {
  let receivedSignal: AbortSignal | undefined
  const client = createAccountClient({
    baseUrl: "https://account.example.invalid",
    fetcher: async (_input, init) => {
      receivedSignal = init?.signal as AbortSignal | undefined
      return Response.json({ entries: [] })
    },
  })
  const abort = new AbortController()
  await client.ledger("token", abort.signal)
  expect(receivedSignal).toBe(abort.signal)
})
