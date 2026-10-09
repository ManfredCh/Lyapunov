/** 只验原WTW reset/step输入历史；不跑外部模型/物理，不签站稳。 */
import { describe, expect, test } from 'bun:test'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { executePolicy, wtwInferenceHistory } from '../src/execution.ts'
import { policyDirectory } from '../src/source.ts'
import { runtimeProbeStub } from './vlaRouteFixture.ts'

describe('WTW 原部署 reset／step 历史契约', () => {
  test('首 policy 输入是2100全零，不是29帧零加初始化观测；第一次step后才尾插', () => {
    const initialObservation = Array.from({ length: 70 }, (_, i) => i + 1)
    const resetHistory = wtwInferenceHistory(initialObservation, 30)
    expect(resetHistory).toHaveLength(2100)
    expect(resetHistory.every(value => value === 0)).toBe(true)
    const afterFirstStep = Array.from({ length: 70 }, (_, i) => 1000 + i)
    const next = wtwInferenceHistory(afterFirstStep, 30, resetHistory)
    expect(next.slice(0, 29 * 70).every(value => value === 0)).toBe(true)
    expect(next.slice(-70)).toEqual(afterFirstStep)
    expect(resetHistory.every(value => value === 0)).toBe(true)
  })

  test('只保留最后30个真实step观测，reset观测不混入，历史顺序由旧到新', () => {
    let history = wtwInferenceHistory(Array(70).fill(-1), 30)
    for (let step = 1; step <= 31; step++) history = wtwInferenceHistory(Array(70).fill(step), 30, history)
    expect(history).toHaveLength(2100)
    for (let frame = 0; frame < 30; frame++) expect(history.slice(frame * 70, (frame + 1) * 70)).toEqual(Array(70).fill(frame + 2))
  })
})

test('真实executePolicy接轻量协议/Sim夹具：先infer后step，trace动作就是本步消费，不签真实物理', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wtw-execution-order-'))
  try {
    const identity = { provider: 'github' as const, modelId: 'Improbable-AI/walk-these-ways', revision: '0e7236bdc81ce855cbe3d70345a7899452bdeb1c', sceneId: 'wtw-fixture-scene', entityId: 'wtw-fixture-robot', worldId: 'wtw-fixture-world', expectedGeneration: 1 }
    const directory = policyDirectory(scratch, identity.provider, identity.modelId, identity.revision)
    mkdirSync(join(directory, 'derived'), { recursive: true })
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const modelPath = join(scratch, 'model.xml'), model = '<mujoco model="unit-only"><worldbody/></mujoco>'
    writeFileSync(modelPath, model)
    const weightsPath = join(directory, 'body.jit'), adaptationPath = join(directory, 'adaptation.jit')
    const sourceFiles = [{ path: 'body.jit', text: 'unit-only-body' }, { path: 'adaptation.jit', text: 'unit-only-adaptation' }]
    for (const file of sourceFiles) writeFileSync(join(directory, file.path), file.text)
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ status: 'DOWNLOADED', provider: identity.provider, modelId: identity.modelId, revision: identity.revision, resolvedRevision: identity.revision, files: sourceFiles.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.text), sha256: sha(file.text) })) }))
    const names = ['FL', 'FR', 'RL', 'RR'].flatMap(leg => ['hip', 'thigh', 'calf'].map(part => `${leg}_${part}_joint`))
    const defaults = [0.1, 0.8, -1.5, -0.1, 0.8, -1.5, 0.1, 1, -1.5, -0.1, 1, -1.5]
    const observations = { type: 'STATE', shape: [70], order: ['source-contract'], quaternion: 'xyzw', inference: 'torchscript-adaptation', frameDimension: 70, historyFrames: 30, commandDimension: 15, gaitCommandScale: [2, 2, .25, 2, 1, 1, 1, 1, 1, .15, .3, .3, 1, 1, 1], adaptationWeightsPath: adaptationPath, gait: { bodyHeightOffsetM: 0, frequencyHz: 3, phase: .5, offset: 0, bound: 0, durationS: .5, footswingHeightM: .08, bodyPitchRad: 0, bodyRollRad: 0, stanceWidthM: .33, stanceLengthM: .4, auxRewardCoef: 0 } }
    const adapter = { adapter: 'wtw-go1-torchscript-v1', robot: 'unitree-go1-12dof', engine: 'mujoco', modelPath, modelSourcePath: modelPath, weightsPath, unit: 'rad', controlMode: 'position', frequencyHz: 50, config: { simulation_dt: .005, control_decimation: 4, num_obs: 70, num_actions: 12, default_angles: defaults, action_scale: .25, hip_scale_reduction: .5, hip_action_indices: [0, 3, 6, 9], clip_actions: 10, dof_pos_scale: 1, dof_vel_scale: .05 }, jointNames: names, observations, modelSha256: sha(model), sourceRevision: identity.revision, sourceModelId: identity.modelId, sourceProvider: identity.provider, physicsPreserved: ['unit-only-no-physics'], gravityCompensation: false }
    writeFileSync(join(directory, 'derived/adapter.json'), JSON.stringify(adapter))
    const eventFile = join(scratch, 'events.jsonl'), engine = join(scratch, 'protocol-fixture.cjs')
    writeFileSync(engine, `#!/usr/bin/env node
${runtimeProbeStub}const fs=require('node:fs'),readline=require('node:readline');let count=0;
readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);let result;
if(request.method==='load'){fs.appendFileSync(${JSON.stringify(eventFile)},JSON.stringify({kind:'load'})+'\\n');result={device:'cpu',fixture:true};}
else{count++;result=Array.from({length:12},(_,i)=>count+i/100);fs.appendFileSync(${JSON.stringify(eventFile)},JSON.stringify({kind:'infer',observation:request.observation,action:result})+'\\n');}
console.log(JSON.stringify({id:request.id,result}));});
`)
    chmodSync(engine, 0o755)
    const controller = { robot: adapter.robot, frequencyHz: 50, controlMode: 'position', gravityCompensation: false }
    const scene: any = { sceneId: identity.sceneId, revision: 1, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities: [{ entityId: identity.entityId, name: 'unit fixture', transform: { position: [0, 0, .34], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [], components: { controller, sensor: { policyObservations: observations }, mujoco: { sourcePath: modelPath } } }] }
    const world: any = { worldId: identity.worldId, sceneId: identity.sceneId, engineId: 'mujoco', worldGeneration: 1, appliedSceneRevision: 1, clock: 'manual', timestepS: .005 }
    let stepIndex = 0, positions = [...defaults]
    const frame = () => ({ worldId: identity.worldId, generation: 1, sceneRevision: 1, stepIndex, simTime: stepIndex * .005, frameId: `unit-frame-${stepIndex}`, entities: [{ entityId: identity.entityId, transform: { position: [0, 0, .34], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, joints: { names, positions: [...positions], velocities: Array(12).fill(0) }, sensors: { freeBase: { quaternionXyzw: [0, 0, 0, 1], angularVelocityLocalRadps: [0, 0, 0] } } }], contacts: [] })
    const received: any[] = []
    const sim: any = {
      listWorlds: async () => [world], describe: async () => ({ expectedGeneration: 1, controlledJointNames: names, controller, joints: names.map(name => ({ name, unit: 'rad', controlMode: 'position' })) }), observe: async () => frame(),
      execute: async (_worldId: string, action: any) => { appendFileSync(eventFile, JSON.stringify({ kind: 'step', startStep: stepIndex, targets: action.positions }) + '\n'); received.push(structuredClone(action)); const startStep = stepIndex; stepIndex += action.stepCount; positions = [...action.positions]; return { actionId: action.actionId, status: 'completed', startStep, endStep: stepIndex, finalState: frame() } },
      stop: async () => ({ stopped: true, stepIndex, receipts: [] }),
    }
    const result = await executePolicy({ dataDirectory: scratch, pythonPath: engine }, { ...identity, runId: 'unit-wtw-order', durationS: .04, command: [0, 0, 0] }, { inspect: () => scene }, sim, new AbortController().signal)
    expect({ status: result.status, controls: result.controls, inferences: result.inferences, steps: result.physicsSteps }).toEqual({ status: 'COMPLETED', controls: 2, inferences: 2, steps: 8 })
    const events = readFileSync(eventFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(events.map(event => event.kind)).toEqual(['load', 'infer', 'step', 'infer', 'step'])
    const inferred = events.filter(event => event.kind === 'infer')
    expect(inferred[0].observation).toHaveLength(2100)
    expect(inferred[0].observation.every((value: number) => value === 0)).toBe(true)
    expect(inferred[1].observation.slice(-70, -67)).toEqual([0, 0, -1])
    expect(inferred[1].observation.slice(-28, -16)).toEqual(inferred[0].action)
    const rows = readFileSync(join(scratch, 'policy-runs/unit-wtw-order/trace.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rows[0].inferenceFrame).toMatchObject({ stepIndex: 0, simTime: 0, historyReset: true })
    expect(rows[1].inferenceFrame).toMatchObject({ stepIndex: 4, simTime: .02, historyReset: false })
    for (let i = 0; i < 2; i++) { expect(rows[i].action).toEqual(inferred[i].action); expect(rows[i].targets).toEqual(received[i].positions); expect(rows[i].receipt.startStep).toBe(i * 4); expect(rows[i].stepIndex).toBe((i + 1) * 4) }
    expect(received[0].positions).not.toEqual(defaults)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}, 30_000)

