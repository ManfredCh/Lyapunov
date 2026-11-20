/** 通过既有 DSH Jobs 复验离线 Playground 策略。 */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Commands from '@deepseek-ai/dsh-commands'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { applyOfflineSceneWorkflows } from '../../packages/robot-workflows/src/offline-scene-plugin.ts'

const [directory, interpreter, mode = 'policy'] = process.argv.slice(2)
assert(directory && interpreter, '用法：run-policy.ts 测试工作区 Playground解释器')
const workspace = resolve(directory)
assert(mode === 'policy' || mode === 'yam')
const training = mode === 'policy' ? JSON.parse(await readFile(join(workspace, 'train/result.json'), 'utf8')) : undefined
const ctx = new Context()
try {
  await ctx.plugin(Timer)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Commands)
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(JobsLocal)
  await ctx.plugin(ToolJobs, { completionDelivery: 'quiet' })
  applyOfflineSceneWorkflows(ctx, { playgroundPython: resolve(interpreter), roboticsLabPython: resolve(interpreter), roboticsLabRenderBackend: 'egl' })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('agy-heldout-policy'), {}, { cwd: workspace })
  async function call<T>(name: string, arguments_: Record<string, unknown>): Promise<T> {
    const result = await ctx.tools.execute({ name, arguments: arguments_, callId: ToolCallId('agy-heldout-' + name),
      signal: AbortSignal.timeout(300000), agent })
    if (result.isError) throw new Error(result.error.message)
    return result.value as T
  }
  const exercised = mode === 'yam' ? 'robotics_lab' : 'playground_eval_so101'
  const input = mode === 'yam' ? { operation: 'yam-ibvs', sourcePath: 'model/yam_linear_4310.xml' }
    : { sourcePath: 'model/so101.xml', checkpointPath: 'train/' + training.summary.checkpoint,
        trainingReceiptPath: 'train/result.json', episodes: 6, steps: 120, seed: 7100 }
  const started = await call<{ jobId: string; outputDir: string }>(exercised, { input })
  const job = await ctx.jobs.wait(JobId(started.jobId), 300000, agent.id)
  const output = await call<{ text: string }>('job_output', { job_id: started.jobId })
  const result = { ...started, status: job.status, jobOutput: output.text }
  await writeFile(join(workspace, 'native-eval-job.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
  assert.equal(job.status, 'completed')
} finally {
  await ctx.fiber.dispose()
}
