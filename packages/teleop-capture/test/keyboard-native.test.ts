import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ProcessSimProvider } from '../../sim-contract/src/python-transport.ts'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import { sessionNamespace } from '../../lyapunov-contracts/src/session-scope.ts'
import { replayRecording } from '../../robot-workflows/src/recording.ts'
import { pathToFileURL } from 'node:url'

test('真实 Capture 键盘、MuJoCo 抓放、控制录制、Lab 导出与原生重执行', { timeout: 120_000 }, async () => {
 const root = resolve(import.meta.dirname, '../../..')
 const artifactRoot = process.env.LYAPUNOV_TELEOP_OUTPUT_DIR
 if (artifactRoot) await mkdir(artifactRoot, { recursive: true })
 const dir = await mkdtemp(join(artifactRoot ?? tmpdir(), 'capture-test-'))
 const mujoco = process.env.LYAPUNOV_MUJOCO_PYTHON ?? join(root, '.runtime/sim-python/bin/python')
 const sim = new ProcessSimProvider({ pythonPath: mujoco, workerPath: join(root, 'packages/sim-mujoco/python/worker.py'), engineName: 'MuJoCo' })
 const ctx = new Context()
 const transform = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] } as const
 const snapshot: SceneSnapshot = {
  sceneId: 'capture-native', revision: 1, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' },
  entities: [
   { entityId: 'cart', name: 'Cartesian gripper', transform: structuredClone(transform) as SceneSnapshot['entities'][number]['transform'], resources: [], components: {
    mujoco: { sourcePath: join(import.meta.dirname, 'fixtures/cartesian-gripper.xml') }, controller: {
     tcp: { body: 'carriage', site: 'tcp' }, gripper: { jointNames: ['left', 'right'] },
     teleopGripper: { open: { left: 0, right: 0 }, closed: { left: -.021, right: -.021 } },
    },
   } },
   { entityId: 'box', name: 'Grasp target', transform: structuredClone(transform) as SceneSnapshot['entities'][number]['transform'], resources: [], components: {
    mujoco: { xml: '<mujoco><worldbody><body name="box" pos="0 0 .017"><freejoint/><geom name="cube" type="box" size=".016 .016 .016" mass=".035" friction="2 .01 .001" condim="4"/></body></worldbody></mujoco>' },
   } },
  ],
 }
 try {
  await ctx.plugin(Timer)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Commands)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(ToolJobs, { completionDelivery: 'quiet' })
  ctx.reflect.provide('scene', { forSession: () => ({ scene: { snapshot: async () => snapshot, subscribe: () => () => {} } }) } as never)
  ctx.reflect.provide('sim', { forSession: () => sim } as never)
  const loop = await mountAgentLoopTestHarness(ctx)
  const agent = await loop.create(SessionId('capture-native-test'), {})
  const plugin = (name: string) => import(pathToFileURL(join(root, 'packages', name, 'dist/plugin.js')).href)
  await ctx.plugin(await plugin('robot-workflows'), { recordingRoot: dir, labExportPython: process.env.LYAPUNOV_LAB_EXPORT_PYTHON })
  await ctx.plugin(await plugin('motion-mink'), { python: mujoco })
  await ctx.plugin(await plugin('teleop-capture'), { python: process.env.LYAPUNOV_CAPTURE_PYTHON })
  let counter = 0
  const tool = async (name: string, input: Record<string, unknown>) => {
   const result = await ctx.tools.execute({ name, arguments: { input }, callId: ToolCallId(`capture-test:${++counter}`), agent, signal: new AbortController().signal })
   assert.equal(result.isError === true, false, JSON.stringify(result.content))
   return result.value as Record<string, any>
  }
  const command = async (name: string, input: Record<string, unknown>) => {
   const response = await ctx.commands.execute(agent, `/${name} ${JSON.stringify(input)}`, [], new AbortController().signal)
   const result = response?.result as { kind: string; text: string }
   assert.equal(result?.kind, 'success', result?.text)
   return JSON.parse(result.text)
  }
  const w = await sim.open(snapshot, { worldId: 'capture-native', ground: true, clock: 'manual', timestepS: .002 })
  const scope = { worldId: w.worldId, expectedGeneration: w.worldGeneration }
  const r = await command('recording_start', { ...scope, sceneId: snapshot.sceneId, maxDurationS: 45, controlSamples: { entityId: 'cart' } })
  const s = await command('robot_teleop_start', { ...scope, entityId: 'cart', stepCount: 150 })
  await assert.rejects(command('robot_teleop_start', { ...scope, entityId: 'cart', stepCount: 150 }), /TELEOP_WORLD_BUSY/)
  await assert.rejects(command('robot_teleop_key', { teleopId: s.teleopId, key: 'KeyW', eventTimeMs: Date.now() - 3000 }), /TELEOP_INPUT_EXPIRED/)
  const keys = ['KeyK', 'KeyQ', 'KeyQ', 'KeyQ', 'KeyQ', 'KeyW', 'KeyW', 'KeyW', 'KeyE', 'KeyE', 'KeyE', 'KeyE', 'KeyK']
  const evidence = []
  for (const [i, key] of keys.entries()) {
   const input = { teleopId: s.teleopId, key, eventTimeMs: Date.now() }
   const result = i === 0 ? await command('robot_teleop_key', input) : await tool('robot_teleop_key', input)
   const frame = await sim.observe(w.worldId, { contacts: true })
   evidence.push({ key, result, box: frame.entities.find(e => e.entityId === 'box')!.transform.position, contacts: frame.contacts ?? [] })
  }
  await command('robot_teleop_stop', { teleopId: s.teleopId })
  await command('recording_stop', { recordingId: r.recordingId })
  const exports = []
  for (const invoke of [command, tool]) {
   const result = await invoke('recording_export', { recordingId: r.recordingId, format: 'isaac-lab' })
   const job = await ctx.jobs.wait(JobId(result.jobId), 20_000, agent.id)
   assert.equal(job.status, 'completed', JSON.stringify(job))
   exports.push(job)
  }
  const recording = join(sessionNamespace(dir, agent.session.header.id), r.recordingId)
  const samples = (await readFile(join(recording, 'control-samples.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).sample)
  const frozenStep = (await sim.observe(w.worldId)).stepIndex
  const replay = await replayRecording(join(recording, 'events.jsonl'), () => {})
  assert.ok(replay.frameCount > 1)
  assert.equal((await sim.observe(w.worldId)).stepIndex, frozenStep)
  const w2 = await sim.open(snapshot, { worldId: 'capture-replay', ground: true, clock: 'manual', timestepS: .002 })
  for (const sample of samples) {
   const { actionId, entityId, jointNames, positions, requestedSteps: stepCount } = sample
   const receipt = await sim.execute(w2.worldId, { actionId, entityId, jointNames, positions, stepCount, expectedGeneration: w2.worldGeneration, kind: 'control' })
   assert.equal(receipt.status, 'completed')
  }
  const replayed = (await sim.observe(w2.worldId)).entities.find(e => e.entityId === 'box')!.transform.position
  await writeFile(join(dir, 'evidence.json'), JSON.stringify({ evidence, exports, replay, replayed, sampleCount: samples.length }, null, 2))
  console.log(`S4 artifact directory: ${dir}`)
  assert.equal(samples.length, keys.length)
  assert.ok(evidence[4]!.box[2] > .04, JSON.stringify(evidence[4]))
  assert.ok(evidence[4]!.contacts.some(c => [c.geom1, c.geom2].some(g => g.includes('box'))), '抬升时必须观测到目标接触')
  const final = evidence.at(-1)!.box
  assert.ok(final[0] > .02 && final[2] < .025, JSON.stringify(final))
  assert.deepEqual(replayed, final)
 } finally {
  await ctx.fiber.dispose()
  await sim.dispose()
  if (!artifactRoot) await rm(dir, { recursive: true, force: true })
 }
})
