import { expect, test } from "bun:test"
import { DesktopAccountController, type AccountControllerOptions } from "../src/account-controller.ts"

function sessionStore() {
  return {
    get: async () => JSON.stringify({ apiUrl: "https://account.example.invalid", token: "session-token" }),
    set: async () => undefined,
    delete: () => undefined,
  }
}

function fixedStore(value: string | null) {
  return {
    get: async () => value,
    set: async () => undefined,
    delete: () => undefined,
  }
}

function options(fetcher: AccountControllerOptions["fetcher"], changed: AccountControllerOptions["changed"]): AccountControllerOptions {
  return {
    apiUrl: "https://account.example.invalid",
    store: sessionStore(),
    openExternal: async () => undefined,
    startHost: async () => undefined,
    stopHost: async () => undefined,
    changed,
    fetcher,
  }
}

function meResponse() {
  return Response.json({
    user: { id: "alice", email: "alice@example.test" },
    balances: { combo: 960, opus: 40, points: 1_000, reservedPoints: 25 },
  })
}

async function tick() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

test("controller keeps user identity while ledger usage is unavailable", async () => {
  const states: Array<ReturnType<DesktopAccountController["view"]>> = []
  const controller = new DesktopAccountController(
    options(async (input) => {
      const pathname = new URL(input.toString()).pathname
      if (pathname === "/v1/me") return meResponse()
      if (pathname === "/v1/ledger") throw new Error("ledger offline")
      throw new Error(`unexpected route: ${pathname}`)
    }, (state) => states.push(state)),
  )

  await controller.restore()
  expect(controller.view()).toMatchObject({
    status: "ready",
    user: { id: "alice" },
    balances: { points: 1_000, reservedPoints: 25 },
    usageStatus: "error",
  })
  expect(controller.view().usage?.usedStatus).toBe("unavailable")
  expect(states.some((state) => state.status === "ready" && state.usageStatus === "error")).toBe(true)
})

test("controller ignores a ledger response after logout", async () => {
  let resolveLedger!: (response: Response) => void
  let ledgerSignal: AbortSignal | undefined
  const ledger = new Promise<Response>((resolve) => {
    resolveLedger = resolve
  })
  const controller = new DesktopAccountController(
    options(async (input, init) => {
      const pathname = new URL(input.toString()).pathname
      if (pathname === "/v1/me") return meResponse()
      if (pathname === "/v1/ledger") {
        ledgerSignal = init?.signal as AbortSignal | undefined
        return ledger
      }
      if (pathname === "/v1/auth/logout") return Response.json({ ok: true })
      throw new Error(`unexpected route: ${pathname}`)
    }, () => undefined),
  )

  await controller.restore()
  expect(ledgerSignal).toBeDefined()
  await controller.logout()
  resolveLedger(Response.json({ entries: [] }))
  await tick()
  expect(ledgerSignal?.aborted).toBe(true)
  expect(controller.view()).toMatchObject({ status: "signed-out" })
  expect(controller.view().usageStatus).toBeUndefined()
})

test("controller refuses saved credentials for the previous API without any network request", async () => {
  let requests = 0
  const controller = new DesktopAccountController({
    ...options(async () => {
      requests += 1
      throw new Error("旧服务的保存凭据不得发往统一入口")
    }, () => undefined),
    apiUrl: "https://vorynel.com/lyaup-unified",
    store: {
      get: async () => JSON.stringify({ apiUrl: "https://vorynel.com/lyaup-api", token: "legacy-session-token" }),
      set: async () => undefined,
      delete: () => undefined,
    },
  })

  await controller.restore()
  expect(requests).toBe(0)
  expect(controller.view()).toMatchObject({ status: "error" })
  expect(controller.view().message).toContain("另一服务地址")
})

test("登录先行：没有保存会话时 restore 不启动任何 Host", async () => {
  let starts = 0
  const controller = new DesktopAccountController({
    ...options(async () => {
      throw new Error("没有会话时不得发起账户网络请求")
    }, () => undefined),
    store: fixedStore(null),
    startHost: async () => {
      starts += 1
    },
  })

  await controller.restore()
  expect(starts).toBe(0)
  expect(controller.view()).toMatchObject({ status: "signed-out" })
})

test("登录先行：保存会话属于另一 API 时拒绝，且未验证不启动 Host", async () => {
  let starts = 0
  let requests = 0
  const controller = new DesktopAccountController({
    ...options(async () => {
      requests += 1
      throw new Error("旧服务的保存凭据不得发往统一入口")
    }, () => undefined),
    apiUrl: "https://vorynel.com/lyaup-unified",
    store: fixedStore(JSON.stringify({ apiUrl: "https://vorynel.com/lyaup-api", token: "legacy-session-token" })),
    startHost: async () => {
      starts += 1
    },
  })

  await controller.restore()
  expect(requests).toBe(0)
  expect(starts).toBe(0)
  expect(controller.view()).toMatchObject({ status: "error" })
})

test("登录先行：会话被服务端拒绝(401)时撤销本地会话，且不启动 Host", async () => {
  let starts = 0
  let deletes = 0
  const controller = new DesktopAccountController({
    ...options(async (input) => {
      const pathname = new URL(input.toString()).pathname
      if (pathname === "/v1/me") {
        return new Response(JSON.stringify({ message: "expired" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
      }
      if (pathname === "/v1/auth/logout") return Response.json({ ok: true })
      throw new Error(`unexpected route: ${pathname}`)
    }, () => undefined),
    store: {
      get: async () => JSON.stringify({ apiUrl: "https://account.example.invalid", token: "expired-session-token" }),
      set: async () => undefined,
      delete: () => {
        deletes += 1
      },
    },
    startHost: async () => {
      starts += 1
    },
  })

  await controller.restore()
  expect(starts).toBe(0)
  expect(deletes).toBe(1)
  expect(controller.view()).toMatchObject({ status: "signed-out" })
})

test("登录先行：有效会话验证通过后才启动 Host，且只启动一次", async () => {
  const verified: string[] = []
  const controller = new DesktopAccountController({
    ...options(async (input) => {
      const pathname = new URL(input.toString()).pathname
      if (pathname === "/v1/me") return meResponse()
      if (pathname === "/v1/ledger") return Response.json({ entries: [] })
      throw new Error(`unexpected route: ${pathname}`)
    }, () => undefined),
    startHost: async (account) => {
      verified.push(account.me.user.id)
    },
  })

  await controller.restore()
  expect(verified).toEqual(["alice"])
  expect(controller.view()).toMatchObject({ status: "ready", user: { id: "alice" } })
})

test("登录先行：取消浏览器授权不启动 Host，且可以再次登录", async () => {
  let starts = 0
  let completeCalls = 0
  let sessionIssued = false
  let markComplete!: () => void
  const completeSeen = new Promise<void>((resolve) => {
    markComplete = resolve
  })
  const fetcher: AccountControllerOptions["fetcher"] = async (input) => {
    const pathname = new URL(input.toString()).pathname
    if (pathname === "/v1/auth/website/start") {
      return Response.json({
        flowId: "flow-1",
        authorizeUrl: "https://account.example.invalid/authorize?flow=flow-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    }
    if (pathname === "/v1/auth/website/complete") {
      completeCalls += 1
      markComplete()
      if (!sessionIssued) return Response.json({ status: "pending" })
      return Response.json({
        user: { id: "alice", email: "alice@example.test" },
        session: { token: "session-token", expiresAt: new Date(Date.now() + 60_000).toISOString() },
      })
    }
    if (pathname === "/v1/me") return meResponse()
    if (pathname === "/v1/ledger") return Response.json({ entries: [] })
    throw new Error(`unexpected route: ${pathname}`)
  }
  const controller = new DesktopAccountController({
    ...options(fetcher, () => undefined),
    startHost: async () => {
      starts += 1
    },
  })

  const first = controller.login()
  await completeSeen
  controller.cancelLogin()
  await first
  expect(starts).toBe(0)
  expect(controller.view()).toMatchObject({ status: "signed-out" })

  sessionIssued = true
  await controller.login()
  expect(completeCalls).toBeGreaterThanOrEqual(2)
  expect(starts).toBe(1)
  expect(controller.view()).toMatchObject({ status: "ready", user: { id: "alice" } })
})

test("登录先行：退出登录停止 Host、清除本地会话并回到未登录", async () => {
  let stops = 0
  let deletes = 0
  const controller = new DesktopAccountController({
    ...options(async (input) => {
      const pathname = new URL(input.toString()).pathname
      if (pathname === "/v1/me") return meResponse()
      if (pathname === "/v1/ledger") return Response.json({ entries: [] })
      if (pathname === "/v1/auth/logout") return Response.json({ ok: true })
      throw new Error(`unexpected route: ${pathname}`)
    }, () => undefined),
    store: {
      get: async () => JSON.stringify({ apiUrl: "https://account.example.invalid", token: "session-token" }),
      set: async () => undefined,
      delete: () => {
        deletes += 1
      },
    },
    startHost: async () => undefined,
    stopHost: async () => {
      stops += 1
    },
  })

  await controller.restore()
  expect(controller.view().status).toBe("ready")
  await controller.logout()
  expect(stops).toBe(1)
  expect(deletes).toBe(1)
  expect(controller.view()).toMatchObject({ status: "signed-out" })
})
