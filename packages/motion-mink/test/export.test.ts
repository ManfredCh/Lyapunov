import { expect, test } from "bun:test"
import { motionRequest } from "../src/request.ts"
import { Context } from "@deepseek-ai/cordis"
import JobsLocal from "@deepseek-ai/dsh-jobs-local"
import Tools from "@deepseek-ai/dsh-tools"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import { ToolCallId } from "@deepseek-ai/dsh-llm"
import SubprocessRuntime from "@deepseek-ai/dsh-subprocess"
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec, SubprocessTerminalEnvironment, SubprocessTerminalHandle } from "@deepseek-ai/dsh-subprocess"
import * as Mink from "../src/plugin.ts"
import * as Ompl from "../../motion-ompl/src/plugin.ts"
import * as AnyGrasp from "../../grasp-anygrasp/src/plugin.ts"
import * as GraspGenX from "../../grasp-graspgenx/src/plugin.ts"
test("motionRequest 把 quaternionXyzw 换成 quaternion，两个入口都给则拒绝", () => {
  expect(motionRequest({ plan: { targetPose: { position: [1, 2, 3], quaternionXyzw: [0, 0, 0, 1] } } }).targetPose).toEqual({ position: [1, 2, 3], quaternion: [0, 0, 0, 1] })
  expect(() => motionRequest({})).toThrow("INVALID_ARGUMENT: plan 与 request_json 必须二选一")
})

for (const [plugin, name] of [[Mink, "motion_plan"], [Ompl, "motion_path"], [AnyGrasp, "grasp_propose"], [GraspGenX, "grasp_propose"]] as const) {
  test(`${plugin.name} 后台Job保一次result且调用Stop不取消独立进程`, async () => {
    const observed: Array<{ spec: SubprocessSpawnSpec; finish(): void }> = []
    const body = JSON.stringify({ source: "offline-native-job-fixture", candidateCount: 2 })
    class OfflineSubprocess extends SubprocessRuntime {
      async resolveExecutable(): Promise<string> { throw new Error("unused fixture lookup") }
      async terminalEnvironment(): Promise<SubprocessTerminalEnvironment> { throw new Error("unused fixture terminal") }
      async spawnTerminal(): Promise<SubprocessTerminalHandle> { throw new Error("unused fixture terminal") }
      spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
        const completion = Promise.withResolvers<SubprocessOutcome>()
        const onAbort = () => completion.resolve({ exitCode: null, signal: "SIGTERM" })
        spec.signal?.addEventListener("abort", onAbort, { once: true })
        const done = completion.promise.finally(() => spec.signal?.removeEventListener("abort", onAbort))
        observed.push({ spec, finish: () => completion.resolve({ exitCode: 0, signal: null }) })
        return {
          stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
          collected: { stdout: { readFrom: from => ({ text: body.slice(from), nextOffset: Buffer.byteLength(body), lossy: false }) } },
          done, terminate: onAbort, waitForExit: async () => { await done; return true },
        }
      }
    }
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(JobsLocal)
    await ctx.plugin(OfflineSubprocess)
    ctx.jobs.attachController("offline-provider-fixture")
    await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: scope => plugin.apply(scope, { python: "/offline-fixture/python" }) })
    const caller = new AbortController()
    let executionSignal: AbortSignal | undefined
    ctx.on('tools/pre-execute', (execution, next) => { executionSignal = execution.signal; return next() })
    try {
      const started = await ctx.tools.execute({ callId: ToolCallId("offline-provider-call"), name, arguments: { request_json: "{}", background: true }, signal: caller.signal })
      expect(started.isError).toBe(false)
      const [job] = ctx.jobs.list()
      if (!job) throw new Error("native Job registration missing")
      expect(observed[0].spec.signal).not.toBe(caller.signal)
      expect(observed[0].spec.signal).not.toBe(executionSignal)
      caller.abort(new Error("stop current request"))
      expect(observed[0].spec.signal?.aborted).toBe(false)
      expect(ctx.jobs.get(job.id).status).toBe("running")
      observed[0].finish()
      expect((await ctx.jobs.wait(job.id, 1_000)).status).toBe("completed")
      expect(ctx.jobs.read(job.id).result).toBe(body)
      expect(ctx.jobs.read(job.id).result).toBeUndefined()
    } finally {
      for (const child of observed) child.finish()
      await ctx.fiber.dispose()
    }
  })
}
