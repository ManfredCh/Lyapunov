/** 通过产品 Cordis + 原生技能、Jobs 和 Campaign 运行隔离实验。 */
import assert from 'node:assert/strict'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Commands from '@deepseek-ai/dsh-commands'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import Skills from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as graph from '../../packages/agent-graph/src/plugin.ts'
import * as blender from '../../packages/blender/src/plugin.ts'
import { applyOfflineSceneWorkflows } from '../../packages/robot-workflows/src/offline-scene-plugin.ts'

const [outArgument, pythonArgument, blenderExecutable, playgroundPython] = process.argv.slice(2)
assert(outArgument && pythonArgument, '用法：run-native.ts 工作目录 Python解释器')
const workspace = resolve(outArgument)
const python = resolve(pythonArgument)
const ctx = new Context()
const evidence: Record<string, unknown> = {}
const dump = () => writeFile(join(workspace, 'native-jobs.json'), JSON.stringify(evidence, null, 2) + '\n')
const campaignId = 'agy-robotics-acceptance'
try {
  await ctx.plugin(Timer)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Commands)
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(JobsLocal)
  await ctx.plugin(ToolJobs, { completionDelivery: 'quiet' })
  await ctx.plugin(Skills)
  await ctx.plugin(SkillFilesystem, { providerName: 'lyapunov-domain', includeDefaultRoots: false, customSkillDirs: [resolve(import.meta.dirname, '../../packages/lyapunov-shell/skills')], watch: false })
  await ctx.plugin(ToolSkill)
  await ctx.plugin(graph)
  applyOfflineSceneWorkflows(ctx, { roboticsLabPython: python, roboticsLabRenderBackend: 'egl', playgroundPython })
  if (blenderExecutable) await ctx.plugin(blender, { executable: blenderExecutable, workspace })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('agy-lab-acceptance'), {}, { cwd: workspace })
  let sequence = 0
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await ctx.tools.execute({ name, arguments: args, agent, callId: ToolCallId('acceptance-' + ++sequence), signal: AbortSignal.timeout(120000) })
    if (result.isError) throw new Error(`${name}: ${result.error.message}`)
    return result.value as T
  }
  const runJob = async (id: string, input: Record<string, unknown>, tool = 'robotics_lab') => {
    const start = await call<{ jobId: string; outputDir: string }>(tool, { input })
    const job = await ctx.jobs.wait(JobId(start.jobId), 120000, agent.id)
    const output = await call<{ text: string }>('job_output', { job_id: start.jobId })
    let result: unknown
    try { result = JSON.parse(output.text) }
    catch { result = output.text }
    evidence[id] = { input, ...start, status: job.status, output: result }
    console.log(JSON.stringify({ id, status: job.status, output: result }))
    return job.status
  }
  const catalog = await ctx.skills.snapshot({ cwd: workspace, scope: agent })
  evidence.skills = catalog.skills.filter(skill => skill.provider === 'lyapunov-domain').map(skill => skill.name)
  const skill = await call<{ name: string }>('skill', { name: 'robotics-composition' })
  assert.equal(skill.name, 'robotics-composition')
  evidence.capabilities = await call('scene_workflow_capabilities', {})
  await call('campaign_init', { input: { campaignId, tasks: [{ taskId: 'robotics-job-chain', sceneId: 'offline-fixture', partition: 'dev', goal: { kind: 'settled' } }], budget: { maxToolCalls: 100, maxSimSteps: 10000, maxWallSeconds: 3600 } } })
  const run = await call<{ runId: string }>('campaign_transition', { input: { campaignId, taskId: 'robotics-job-chain', to: 'exploring', role: 'worker' } })
  const cases: Record<string, Record<string, unknown>> = {
    probe: { operation: 'probe' },
    audit: { operation: 'mjcf-audit', sourcePath: 'asset.xml' },
    showcase: { operation: 'showcase', sourcePath: 'asset.xml', requestPath: 'showcase.json' },
    rgb: { operation: 'rgb-localize', requestPath: 'rgb.json' },
    plane: { operation: 'rgb-localize', requestPath: 'plane.json', sourcePath: 'mask-0.png' },
    playgroundCamera: { operation: 'playground-camera', requestPath: 'camera-request.json', sourcePath: 'rgb-scene.xml' },
    exactPlan: { operation: 'object-plan', requestPath: 'exact-plan.json' },
    visionPlan: { operation: 'vision-transfer-plan', requestPath: 'vision-plan.json' },
    armPlan: { operation: 'arm-plan', requestPath: 'so101-plan.json', sourcePath: 'so101/so101.xml' },
    ibvs: { operation: 'ibvs-step', requestPath: 'ibvs.json' },
    calibration: { operation: 'handeye-fit', requestPath: 'calibration.json' },
    yam: { operation: 'yam-ik', requestPath: 'yam-ik.json', sourcePath: 'yam/yam_linear_4310.xml' },
    fr3: { operation: 'fr3-duo-check', requestPath: 'fr3-check.json', sourcePath: 'fr3-duo/fr3_duo.xml' },
    schedule: { operation: 'gauntlet-schedule', requestPath: 'schedule.json' },
    rl: { operation: 'rl-audit', sourcePath: 'rl-task.py' },
    hardware: { operation: 'hardware-inventory' },
    ...(playgroundPython ? { ppo: { sourcePath: 'playground-so101/so101.xml', iterations: 1, worlds: 2, steps: 8, seed: 42 } } : {}),
  }
  // The host runs each copy in an isolated Job directory. Record every failure.
  const entries = Object.entries(cases)
  let pass = true
  for (let start = 0; start < entries.length; start += 5) {
    const group = entries.slice(start, start + 5)
    const outcomes = await Promise.allSettled(group.map(([key, input]) => runJob(key, input, key === 'ppo' ? 'playground_train_so101' : 'robotics_lab')))
    pass = pass && outcomes.every(result => result.status === 'fulfilled' && result.value === 'completed')
    for (const [idx, result] of outcomes.entries()) if (result.status === 'rejected') evidence[group[idx]![0]] = { status: 'failed', error: String(result.reason) }
  }
  if (blenderExecutable) {
    try {
      const result = await call<{ result: string }>('blender_run', { output_directory: 'blender-prop', python_script: 'make-prop.py', operation: 'build' })
      evidence.blender = { status: 'completed', output: JSON.parse(result.result) }
    } catch (error) {
      evidence.blender = { status: 'failed', error: String(error) }
      pass = false
    }
  }
  await call('campaign_record_run', { input: { campaignId, taskId: 'robotics-job-chain', role: 'worker', summary: { outcome: pass ? 'success' : 'failed', notes: '独立 Job 管道验收。真实物理配对另有运行。' } } })
  const calls = join(workspace, '.lyapunov', 'campaigns', campaignId, 'runs', run.runId, 'calls.jsonl')
  await copyFile(calls, join(workspace, 'exported-calls.jsonl'))
  evidence.campaignCalls = (await readFile(calls, 'utf8')).trimEnd().split('\n').length
  evidence.campaignRunId = run.runId
  const archiveStatus = await runJob('mcap', { operation: 'mcap-export', sourcePath: 'exported-calls.jsonl' })
  await dump()
  assert(pass && archiveStatus === 'completed', '一个或多个 Job 失败。见 native-jobs.json。')
} finally {
  await dump()
  await ctx.fiber.dispose()
}
