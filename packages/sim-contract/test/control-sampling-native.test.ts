import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { SimulationRecording } from '../../robot-workflows/src/recording.ts'
import { ProcessSimProvider } from '../src/python-transport.ts'
import { validControlSample, type ControlSample } from '../src/control-samples.ts'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import { IsaacProvider } from '../../sim-isaac/src/provider.ts'

test('真实原生控制：窗口对应前后状态，重试不重复采样，观察不推进', { timeout: 120000 }, async () => {
 const root = resolve(import.meta.dirname, '../../..')
 const provider = process.env.LYAPUNOV_TEST_ENGINE === 'isaac'
  ? new IsaacProvider({ pythonPath: process.env.LYAPUNOV_ISAAC_PYTHON ?? resolve(root, '.runtime/conda/envs/isaac/bin/python'), cacheRoot: resolve(root, '.runtime/isaac-adoption-20261110/isaac-cache'), physicsDevice: 'cpu', rendering: 'none' })
  : new ProcessSimProvider({ pythonPath: process.env.LYAPUNOV_MUJOCO_PYTHON ?? resolve(root, '.runtime/sim-python/bin/python'), workerPath: resolve(root, 'packages/sim-mujoco/python/worker.py'), engineName: 'MuJoCo' })
 const samples: ControlSample[] = []
 const output = process.env.LYAPUNOV_SAMPLING_OUTPUT_DIR ?? mkdtempSync(resolve(tmpdir(), 'lyapunov-sampling-'))
 const recording = new SimulationRecording(output, 'sampling-test-session')
 const scene: SceneSnapshot = { sceneId: 'sample-scene', revision: 1, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities: [{ entityId: 'arm', name: 'arm', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [], components: { mujoco: { xml: readFileSync(resolve(root, 'packages/sim-mujoco/fixtures/arm.xml'), 'utf8') } } }] }
 try {
  const w = await provider.open(scene, { worldId: 'control-sampling', clock: 'manual', ground: false, timestepS: .002 })
  const description = await provider.describe(w.worldId, 'arm')
  const names = description.controlledJointNames!
  assert.equal(names.length, 3)
  const off = provider.subscribeControlSamples(w.worldId, s => samples.push(s))
  await recording.start(provider, w.worldId, undefined, undefined, undefined, { enabled: true, expectedGeneration: w.worldGeneration, entityId: 'arm', episodeId: 'episode-1' })
  for (const [i, target] of [.12, -.08, .2].entries()) {
   const action = { actionId: 'sample-'+i, expectedGeneration: w.worldGeneration, kind: 'control' as const, entityId: 'arm', jointNames: names, positions: [target, .1, -.1], stepCount: 10 }
   const receipt = await provider.execute(w.worldId, action)
   assert.equal(receipt.status, 'completed')
   await provider.execute(w.worldId, action)
   assert.equal(samples.length, i+1)
   const s = samples[i]!
   assert.ok(validControlSample(s))
   assert.equal(s.controlCycleIndex, i); assert.equal(s.physicsStepStart, i*10); assert.equal(s.physicsStepEnd, (i+1)*10)
   assert.equal(s.complete, true); assert.deepEqual(s.positions, action.positions)
   if (i) { assert.deepEqual(s.before.entities[0]!.joints, samples[i-1]!.after!.entities[0]!.joints); assert.deepEqual(s.before.entities[0]!.transform, samples[i-1]!.after!.entities[0]!.transform) }
  }
  const a = await provider.observe(w.worldId); const b = await provider.observe(w.worldId)
  assert.equal(a.stepIndex, b.stepIndex)
  await assert.rejects(provider.configureControlSampling(w.worldId, { enabled: false, expectedGeneration: w.worldGeneration, entityId: 'arm', episodeId: 'other' }), (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === 'CONTROL_SAMPLING_OWNER_MISMATCH')
  const summary = await recording.stop()
  assert.equal(summary.controlSamples?.completeCount, 3)
  const rows = readFileSync(resolve(output, 'control-samples.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(rows.map(row => row.sample), samples)
  assert.ok(rows.every(row => row.sessionRef === 'sampling-test-session'))
  const interrupted = { enabled: true, expectedGeneration: w.worldGeneration, entityId: 'arm', episodeId: 'interrupted' }
  await provider.configureControlSampling(w.worldId, interrupted)
  const action = provider.execute(w.worldId, { actionId: 'interruptible', expectedGeneration: w.worldGeneration, kind: 'control', entityId: 'arm', jointNames: names, positions: [.1, .1, -.1], stepCount: 1000 })
  while ((await provider.observe(w.worldId)).stepIndex === b.stepIndex) await new Promise(resolve => setTimeout(resolve, 2))
  await provider.stop(w.worldId, { actionId: 'interruptible', expectedGeneration: w.worldGeneration })
  assert.equal((await action).status, 'cancelled')
  assert.equal(samples[3]?.complete, false)
  assert.equal(samples[3]?.status, 'cancelled')
  assert.ok(samples[3]!.appliedSteps > 0 && samples[3]!.appliedSteps < 1000)
  await provider.configureControlSampling(w.worldId, { ...interrupted, enabled: false })
  const next = await provider.sync(w.worldId, { ...scene, revision: 2 }, { forceRebuild: true })
  assert.notEqual(next.worldGeneration, w.worldGeneration)
  await assert.rejects(provider.configureControlSampling(w.worldId, { enabled: true, expectedGeneration: w.worldGeneration, entityId: 'arm', episodeId: 'stale' }), { code: 'STALE_GENERATION' })
  off()
 } finally {
  await provider.dispose()
  if (!process.env.LYAPUNOV_SAMPLING_OUTPUT_DIR) rmSync(output, { recursive: true, force: true })
 }
})
