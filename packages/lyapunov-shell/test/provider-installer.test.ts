import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { PassThrough } from "node:stream"
import { Context } from "@deepseek-ai/cordis"
import JobsLocal from "@deepseek-ai/dsh-jobs-local"
import { JobId } from "@deepseek-ai/dsh-jobs"
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess"
import type { EngineLicenseAcceptance } from "../src/engine-provider-contract.ts"
import { createProviderInstaller, installerResult, ISAAC_EULA_URL, type InstallReceipt } from "../src/provider-installer.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** No OS process is created: command exit and whole-range exit are independent. */
function fakeProcess() {
  const exit = deferred<SubprocessOutcome>()
  const range = deferred<boolean>()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let terminations = 0
  let waits = 0
  let terminationError: Error | undefined
  const handle: SubprocessHandle = {
    stdin: undefined, stdout, stderr, control: undefined, collected: {}, done: exit.promise,
    terminate() { if (terminationError) throw terminationError; terminations++ },
    waitForExit() { waits++; return range.promise },
  }
  return {
    handle, exit, range, stdout, stderr,
    get terminations() { return terminations },
    get waits() { return waits },
    setTerminationError(error: Error | undefined) { terminationError = error },
    finish(exitCode: number | null = 0, signal: NodeJS.Signals | null = null) {
      stdout.end(); stderr.end(); exit.resolve({ exitCode, signal }); range.resolve(true)
    },
  }
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

async function harness(controller = true) {
  const directory = mkdtempSync(join(tmpdir(), "lyapunov-installer-test-"))
  const root = join(directory, "attempts")
  const scriptPath = join(directory, "installer fixture.sh")
  // This is only an existence fixture; executing it is never part of these tests.
  writeFileSync(scriptPath, "# Offline test fixture. Never execute.\n")
  const ctx = new Context()
  const jobsFiber = await ctx.plugin(JobsLocal)
  const detach = controller ? ctx.jobs.attachController("installer-tests") : () => undefined
  const processes: ReturnType<typeof fakeProcess>[] = []
  const spawns: SubprocessSpawnSpec[] = []
  let acceptance: EngineLicenseAcceptance | undefined
  let spawnError: Error | undefined
  let settled = 0
  const options = {
    root, cwd: directory, scriptPath, env: { LYAPUNOV_TEST_ONLY: "1" }, jobs: ctx.jobs,
    subprocess: { spawn(spec: SubprocessSpawnSpec) {
      spawns.push(spec)
      if (spawnError) throw spawnError
      const process = fakeProcess()
      processes.push(process)
      return process.handle
    } },
    readLicense: () => acceptance,
    onSettled: () => { settled++ },
  }
  const installer = createProviderInstaller(options)
  cleanup.push(async () => {
    for (const process of processes) { process.setTerminationError(undefined); process.finish(null, "SIGTERM") }
    await installer.dispose()
    detach()
    await jobsFiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    ctx, directory, root, scriptPath, installer, options, spawns, processes, detach,
    get settled() { return settled },
    setLicense(value: EngineLicenseAcceptance | undefined) { acceptance = value },
    setSpawnError(error: Error) { spawnError = error },
    accept() { acceptance = { acceptedAt: "2026-09-24T09:00:00.000Z", eulaUrl: ISAAC_EULA_URL } },
    async wait(id: string | null) {
      expect(id).not.toBeNull()
      return ctx.jobs.wait(JobId(id!), 1000)
    },
  }
}

describe("provider installer with native Jobs and offline fake subprocesses", () => {
  test("策略CPU准备复用同一个安装器/Jobs，只传封闭provider，不切物理引擎或冒领EULA", async () => {
    const h=await harness(),plan=h.installer.dryRun('policy-cpu',false)
    expect(plan.argv).toEqual(['/bin/sh',h.scriptPath,'policy-cpu'])
    const started=h.installer.start('policy-cpu',false);expect(started.running).toBe(true);await flush()
    expect(h.spawns[0].argv).toEqual(['/bin/sh',h.scriptPath,'policy-cpu']);expect(h.spawns[0].argv).not.toContain('--accept-omniverse-eula')
    const receipt=JSON.parse(readFileSync(started.receiptPath!,'utf8'))as InstallReceipt;expect(receipt.provider).toBe('policy-cpu');expect(receipt.eula.acceptance).toBeNull()
    h.processes[0].finish();await h.wait(started.jobId);expect(h.installer.state('policy-cpu').status).toBe('completed')
  })
  test("persists job identity and commits clean completion only after range teardown", async () => {
    const h = await harness()
    const notifications: string[] = []
    h.ctx.jobs.events.subscribe({ owners: "all" }, event => {
      if (event.type === "settled") notifications.push(event.job.status)
    })
    const started = h.installer.start("mujoco", false)
    expect(started.running).toBe(true)
    expect(started.jobId).toBe("provider-install-1")
    const initial = JSON.parse(readFileSync(started.receiptPath!, "utf8")) as InstallReceipt
    expect(initial.jobId).toBe(started.jobId!)
    expect(initial.eula.acceptance).toBeNull()
    expect(statSync(started.receiptPath!).mode & 0o777).toBe(0o600)
    await flush()
    expect(h.spawns[0].argv).toEqual(["/bin/sh", h.scriptPath, "mujoco"])
    expect(h.spawns[0].env).toEqual({ LYAPUNOV_TEST_ONLY: "1" })
    const process = h.processes[0]
    process.stdout.write('download progress\n{\n  "provider": "mujoco",\n  "status": "OK"\n}\n')
    process.stderr.write("diagnostic\n")
    const before = h.ctx.jobs.readAt(JobId(started.jobId!), 0)
    expect(before.chunks.map(chunk => chunk.text).join("")).toContain("download progress")
    expect(before.chunks.some(chunk => chunk.channel === "stderr" && chunk.text.includes("diagnostic"))).toBe(true)
    process.exit.resolve({ exitCode: 0, signal: null })
    await flush()
    expect(process.terminations).toBe(1)
    expect(process.waits).toBe(1)
    expect(h.ctx.jobs.get(JobId(started.jobId!)).status).toBe("running")
    expect(h.installer.state("mujoco").running).toBe(true)
    process.range.resolve(true)
    expect((await h.wait(started.jobId)).status).toBe("completed")
    expect(notifications).toEqual(["completed"])
    const completed = h.installer.state("mujoco")
    expect(completed.status).toBe("completed")
    expect(completed.result?.status).toBe("OK")
    expect(completed.tail).toContain("diagnostic")
    expect(h.settled).toBe(1)
    const collected = h.ctx.jobs.read(JobId(started.jobId!))
    expect(collected.chunks.map(chunk => chunk.text).join("")).toContain("download progress")
    expect(JSON.parse(collected.result!).exitCode).toBe(0)
    expect(h.ctx.jobs.read(JobId(started.jobId!)).result).toBeUndefined()
    const reloaded = createProviderInstaller(h.options)
    reloaded.recover()
    expect(reloaded.state("mujoco").attemptId).toBe(started.attemptId)
    expect(reloaded.state("mujoco").status).toBe("completed")
    expect(readdirSync(h.root).some(name => name.endsWith(".tmp") || name.endsWith(".lock"))).toBe(false)
  })

  for (const [label, exitCode, signal] of [
    ["nonzero exit", 9, null], ["external signal", null, "SIGTERM"], ["signal with zero code", 0, "SIGKILL"], ["no exit facts", null, null],
  ] as const) {
    test(`${label} never reports success even after OK output`, async () => {
      const h = await harness()
      const start = h.installer.start("newton", false)
      await flush()
      h.processes[0].stdout.write('{"status":"OK"}\n')
      h.processes[0].finish(exitCode, signal)
      expect((await h.wait(start.jobId)).status).toBe("failed")
      const receipt = h.installer.receipts()[0]
      expect(receipt.status).toBe("failed")
      expect(receipt.exitCode).toBe(exitCode)
      expect(receipt.signal).toBe(signal)
      expect(receipt.result?.status).toBe("FAILED")
      expect(h.installer.state("newton").running).toBe(false)
    })
  }

  test("a cache invalidation exception cannot change a completed Job or receipt", async () => {
    const h = await harness()
    h.options.onSettled = () => { throw new Error("cache invalidation failed") }
    const start = h.installer.start("mujoco", false)
    await flush()
    h.processes[0].finish()
    expect((await h.wait(start.jobId)).status).toBe("completed")
    expect(h.installer.state("mujoco").status).toBe("completed")
    expect(JSON.parse((h.ctx.jobs.read(JobId(start.jobId!)).result ?? '')).status).toBe("completed")
  })

  test("a log write failure terminates the process and cannot become success", async () => {
    const h = await harness()
    const start = h.installer.start("mujoco", false)
    await flush()
    // A directory at the log path produces a deterministic offline write failure.
    mkdirSync(start.logPath)
    h.processes[0].stdout.write("progress that cannot be persisted\n")
    expect(h.processes[0].terminations).toBe(1)
    h.processes[0].finish()
    expect((await h.wait(start.jobId)).status).toBe("failed")
    const receipt = h.installer.receipts()[0]
    expect(receipt.status).toBe("failed")
    expect(receipt.result?.code).toBe("INSTALL_EXECUTION_FAILED")
    expect(receipt.exitCode).toBe(0)
    expect(h.processes[0].terminations).toBe(1)
  })

  test("a blocking JSON result overrides a zero exit", async () => {
    const h = await harness()
    const start = h.installer.start("mujoco", false)
    await flush()
    h.processes[0].stdout.write('{"status":"BLOCKED","code":"PREFIX_CONFLICT"}\n')
    h.processes[0].finish()
    expect((await h.wait(start.jobId)).status).toBe("failed")
    expect(h.installer.state("mujoco").result?.code).toBe("PREFIX_CONFLICT")
  })

  test("synchronous spawn failure settles Jobs and receipt without rejecting hooks", async () => {
    const h = await harness()
    h.setSpawnError(new Error("EACCES fake spawn"))
    const start = h.installer.start("mujoco", false)
    const snapshot = await h.wait(start.jobId)
    expect(snapshot.status).toBe("failed")
    expect(snapshot.detail).toContain("EACCES fake spawn")
    expect(h.installer.receipts()[0].status).toBe("failed")
    expect(h.processes).toHaveLength(0)
  })

  test("asynchronous spawn error waits for range cleanup before failure", async () => {
    const h = await harness()
    const start = h.installer.start("mujoco", false)
    await flush()
    h.processes[0].exit.reject(new Error("ENOENT fake spawn"))
    await flush()
    expect(h.ctx.jobs.get(JobId(start.jobId!)).status).toBe("running")
    expect(h.processes[0].terminations).toBe(1)
    h.processes[0].range.resolve(true)
    expect((await h.wait(start.jobId)).status).toBe("failed")
    expect(h.installer.state("mujoco").detail).toContain("ENOENT fake spawn")
  })

  test("cancellation is idempotent and joins the whole range before killed", async () => {
    const h = await harness()
    const start = h.installer.start("mujoco", false)
    await flush()
    const process = h.processes[0]
    expect(h.installer.cancel("mujoco", start.attemptId!).status).toBe("stopping")
    h.installer.cancel("mujoco", start.attemptId!)
    expect(process.terminations).toBe(1)
    expect(h.ctx.jobs.get(JobId(start.jobId!)).status).toBe("stopping")
    process.exit.resolve({ exitCode: 0, signal: null })
    await flush()
    expect(h.installer.state("mujoco").status).toBe("stopping")
    process.range.resolve(true)
    expect((await h.wait(start.jobId)).status).toBe("killed")
    expect(h.installer.cancel("mujoco", start.attemptId!).status).toBe("killed")
    expect(process.terminations).toBe(1)
    expect(h.installer.state("mujoco").result?.status).toBe("FAILED")
  })

  for (const rangeSettled of [true, false]) {
    test(`cancelled provider rejection ${rangeSettled ? "preserves killed after teardown" : "requires reconciliation without teardown"}`, async () => {
      const h = await harness()
      const start = h.installer.start("mujoco", false)
      await flush()
      const process = h.processes[0]
      h.installer.cancel("mujoco", start.attemptId!)
      process.exit.reject(new Error("provider failed during cancellation"))
      await flush()
      expect(h.ctx.jobs.get(JobId(start.jobId!)).status).toBe("stopping")
      process.range.resolve(rangeSettled)
      expect((await h.wait(start.jobId)).status).toBe(rangeSettled ? "killed" : "failed")
      const receipt = h.installer.receipts()[0]
      expect(receipt.status).toBe(rangeSettled ? "killed" : "interrupted")
      expect(receipt.result?.code).toBe(rangeSettled ? "INSTALL_CANCELLED" : "INSTALL_EXECUTION_FAILED")
      expect(receipt.detail).toContain("provider failed during cancellation")
      expect(process.terminations).toBe(1)
      if (!rangeSettled) expect(h.installer.dryRun("mujoco", false).code).toBe("INSTALL_RECONCILIATION_REQUIRED")
    })
  }

  test("cancellation before launch creates a killed receipt and no process", async () => {
    const h = await harness()
    const start = h.installer.start("newton", false)
    h.installer.cancel("newton", start.attemptId!)
    expect((await h.wait(start.jobId)).status).toBe("killed")
    expect(h.spawns).toHaveLength(0)
    expect(h.installer.receipts()[0].status).toBe("killed")
  })

  test("termination error does not latch cancellation and can be retried", async () => {
    const h = await harness()
    const start = h.installer.start("mujoco", false)
    await flush()
    h.processes[0].setTerminationError(new Error("cannot signal range"))
    expect(() => h.installer.cancel("mujoco", start.attemptId!)).toThrow("cannot signal range")
    expect(h.ctx.jobs.get(JobId(start.jobId!)).status).toBe("running")
    h.processes[0].setTerminationError(undefined)
    h.installer.cancel("mujoco", start.attemptId!)
    h.processes[0].finish(null, "SIGTERM")
    expect((await h.wait(start.jobId)).status).toBe("killed")
  })

  test("an unobservable process range becomes interrupted and blocks retry", async () => {
    const h = await harness()
    const start = h.installer.start("mujoco", false)
    await flush()
    h.processes[0].exit.resolve({ exitCode: 0, signal: null })
    h.processes[0].range.reject(new Error("range unavailable"))
    expect((await h.wait(start.jobId)).status).toBe("failed")
    expect(h.installer.state("mujoco").status).toBe("interrupted")
    expect(h.installer.start("mujoco", false).attemptId).toBe(start.attemptId)
    expect(h.spawns).toHaveLength(1)
  })

  test("dispose cancels jobs and does not resolve before range exit", async () => {
    const h = await harness()
    const start = h.installer.start("mujoco", false)
    await flush()
    let disposed = false
    const disposal = h.installer.dispose().then(() => { disposed = true })
    await flush()
    expect(disposed).toBe(false)
    expect(h.installer.state("mujoco").status).toBe("stopping")
    h.processes[0].finish(null, "SIGTERM")
    await disposal
    expect((await h.wait(start.jobId)).status).toBe("killed")
  })

  test("native Jobs rejects missing controller before any process launches", async () => {
    const h = await harness(false)
    const start = h.installer.start("mujoco", false)
    expect(start.status).toBe("failed")
    expect(start.result?.code).toBe("INSTALL_JOB_UNAVAILABLE")
    expect(start.detail).toContain("no job controller")
    expect(h.ctx.jobs.list()).toHaveLength(0)
    expect(h.spawns).toHaveLength(0)
  })

  test("concurrent start returns the active attempt and later retry gets new receipt and log", async () => {
    const h = await harness()
    const first = h.installer.start("mujoco", false)
    const duplicate = h.installer.start("mujoco", false)
    expect(duplicate.attemptId).toBe(first.attemptId)
    expect(h.ctx.jobs.list()).toHaveLength(1)
    await flush()
    h.processes[0].stdout.write('{"status":"OK"}\n')
    h.processes[0].finish()
    await h.wait(first.jobId)
    const second = h.installer.start("mujoco", false)
    expect(second.attemptId).not.toBe(first.attemptId)
    expect(second.logPath).not.toBe(first.logPath)
    expect(second.result).toBeNull()
    await flush()
    h.processes[1].finish(3)
    await h.wait(second.jobId)
    expect(h.installer.receipts()).toHaveLength(2)
    expect(h.installer.state("mujoco").attemptId).toBe(second.attemptId)
    expect(h.installer.state("mujoco").result?.status).toBe("FAILED")
  })

  test("restart recovers an unfinished receipt without attaching or cancelling a reused job id", async () => {
    const h = await harness()
    const attemptId = randomUUID()
    const stale: InstallReceipt = {
      version: 1, provider: "mujoco", attemptId, startedAt: Date.now() - 1000, sequence: 1,
      status: "running", jobId: "provider-install-1", eula: { requested: false, acceptance: null },
    }
    mkdirSync(h.root)
    writeFileSync(join(h.root, `${attemptId}.json`), JSON.stringify(stale))
    writeFileSync(join(h.root, `${attemptId}.log`), '{"status":"OK"}\n')
    const unrelated = h.installer.start("newton", false)
    expect(unrelated.jobId).toBe(stale.jobId!)
    h.installer.recover()
    expect(h.installer.state("mujoco").status).toBe("interrupted")
    expect(h.installer.state("mujoco").result?.code).toBe("INSTALLER_HOST_RESTARTED")
    expect(h.installer.start("mujoco", false).attemptId).toBe(attemptId)
    expect(h.installer.dryRun("mujoco", false).code).toBe("INSTALL_RECONCILIATION_REQUIRED")
    expect(() => h.installer.cancel("mujoco", attemptId)).toThrow("INSTALL_JOB_NOT_LIVE")
    expect(h.ctx.jobs.get(JobId(unrelated.jobId!)).status).toBe("running")
    await flush()
    expect(h.spawns).toHaveLength(1)
    h.processes[0].finish()
    await h.wait(unrelated.jobId)
  })

  test("malformed receipt fails closed instead of hiding restart history", async () => {
    const h = await harness()
    mkdirSync(h.root)
    writeFileSync(join(h.root, "corrupt.json"), "not-json")
    expect(() => h.installer.recover()).toThrow()
    expect(() => h.installer.start("mujoco", false)).toThrow()
    expect(h.spawns).toHaveLength(0)
  })

  test("stale start lock blocks without deleting it, and dry-run reports the same", async () => {
    const h = await harness()
    mkdirSync(h.root)
    const lock = join(h.root, "mujoco.lock")
    writeFileSync(lock, "operator must reconcile")
    expect(h.installer.dryRun("mujoco", false).code).toBe("INSTALL_START_LOCKED")
    expect(() => h.installer.start("mujoco", false)).toThrow()
    expect(readFileSync(lock, "utf8")).toBe("operator must reconcile")
    expect(h.spawns).toHaveLength(0)
  })

  test("dry-run neither creates receipts nor grants an EULA from client input", async () => {
    const h = await harness()
    const dry = h.installer.dryRun("isaac", true)
    expect(dry.status).toBe("dry-run")
    expect(dry.code).toBe("LICENSE_CONFIRMATION_REQUIRED")
    expect(dry.acceptedForAttempt).toBe(false)
    expect(dry.wouldAcceptEula).toBe(false)
    expect(dry.argv).not.toContain("--accept-omniverse-eula")
    expect(dry.attemptId).toBeNull()
    expect(dry.logPath).toBeNull()
    expect(existsSync(h.root)).toBe(false)
    expect(h.ctx.jobs.list()).toHaveLength(0)
    expect(h.spawns).toHaveLength(0)
    h.accept()
    const accepted = h.installer.dryRun("isaac", true)
    expect(accepted.wouldStart).toBe(true)
    expect(accepted.serverEulaAccepted).toBe(true)
    expect(accepted.acceptedForAttempt).toBe(false)
    expect(accepted.argv).toContain("--accept-omniverse-eula")
    const unrequested = h.installer.dryRun("isaac", false)
    expect(unrequested.serverEulaAccepted).toBe(true)
    expect(unrequested.wouldAcceptEula).toBe(false)
    expect(existsSync(h.root)).toBe(false)
  })

  test("Isaac requires fresh explicit request plus canonical server acceptance per attempt", async () => {
    const h = await harness()
    const clientOnly = h.installer.start("isaac", true)
    expect(clientOnly.status).toBe("blocked")
    expect(clientOnly.result?.code).toBe("LICENSE_CONFIRMATION_REQUIRED")
    h.accept()
    expect(h.installer.start("isaac", false).status).toBe("blocked")
    h.setLicense({ acceptedAt: "2026-09-24T09:00:00Z", eulaUrl: "https://unrelated.invalid/license" })
    expect(h.installer.start("isaac", true).status).toBe("blocked")
    h.setLicense({ acceptedAt: "not a date", eulaUrl: ISAAC_EULA_URL })
    expect(h.installer.start("isaac", true).status).toBe("blocked")
    expect(h.ctx.jobs.list()).toHaveLength(0)
    expect(h.spawns).toHaveLength(0)
    h.accept()
    const accepted = h.installer.start("isaac", true)
    const binding = h.installer.receipts().find(row => row.attemptId === accepted.attemptId)!.eula.acceptance
    expect(binding?.attemptId).toBe(accepted.attemptId!)
    expect(binding?.acceptedAt).toBe("2026-09-24T09:00:00.000Z")
    expect(binding?.eulaUrl).toBe(ISAAC_EULA_URL)
    await flush()
    expect(h.spawns[0].argv).toContain("--accept-omniverse-eula")
    h.processes[0].finish()
    await h.wait(accepted.jobId)
    h.setLicense(undefined)
    const revoked = h.installer.start("isaac", true)
    expect(revoked.status).toBe("blocked")
    expect(revoked.attemptId).not.toBe(accepted.attemptId)
    expect(h.spawns).toHaveLength(1)
  })

  test("license revocation in the Jobs start-to-launch gap blocks the process", async () => {
    const h = await harness()
    h.accept()
    const start = h.installer.start("isaac", true)
    h.setLicense(undefined)
    expect((await h.wait(start.jobId)).status).toBe("failed")
    expect(h.installer.state("isaac").status).toBe("blocked")
    expect(h.spawns).toHaveLength(0)
  })

  test("missing installer records failure; unknown provider never writes", async () => {
    const h = await harness()
    expect(() => h.installer.start("../escape", false)).toThrow("PROVIDER_UNKNOWN")
    expect(existsSync(h.root)).toBe(false)
    rmSync(h.scriptPath)
    expect(h.installer.dryRun("mujoco", false).code).toBe("PROVIDER_INSTALLER_MISSING")
    const start = h.installer.start("mujoco", false)
    expect(start.status).toBe("failed")
    expect(start.result?.code).toBe("PROVIDER_INSTALLER_MISSING")
    expect(h.spawns).toHaveLength(0)
  })
})

test("installer JSON parser supports pretty output, braces in diagnostics, and the final result", () => {
  expect(installerResult('junk\n{\n  "status": "BLOCKED",\n  "code": "PREFIX_CONFLICT"\n}\n')).toEqual({ status: "BLOCKED", code: "PREFIX_CONFLICT" })
  expect(installerResult('{"status":"OK"}\n{bad\n{"status":"FAILED"}\ntrailing diagnostic')).toEqual({ status: "FAILED" })
  expect(installerResult("no JSON\n")).toBeUndefined()
})
