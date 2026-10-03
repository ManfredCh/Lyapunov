import { expect, test } from "bun:test"
import { runProvider } from "../src/operations.ts"
test("runProvider 在没有算法解释器时明确拒绝", async () => {
  const keys = ["LYAPUNOV_ALGORITHM_PYTHON", "LYAUP_ALGORITHM_PYTHON"] as const
  const saved = keys.map(key => process.env[key])
  try {
    for (const key of keys) delete process.env[key]
    await expect(runProvider({})).rejects.toThrow("PROVIDER_UNAVAILABLE: 设置 LYAPUNOV_ALGORITHM_PYTHON")
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key]
      else process.env[key] = saved[index]
    })
  }
})
