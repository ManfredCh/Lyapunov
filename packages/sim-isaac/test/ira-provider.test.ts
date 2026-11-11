import { test, expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { humanIraRequest } from '../src/provider.ts'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'

const human = (ira?: Record<string, unknown>) => ({
  schema: 1, mode: 'kinematic', collision: 'detailed', source: { kind: 'procedural', license: 'Apache-2.0', sourceUpAxis: 'Z' }, heightM: 1.75, phase: 0,
  route: { pointsM: [[-1, 0, 0], [1, 0, 0]], speedMps: 1, behavior: 'walk', loop: true },
  ...(ira ? { ira } : {}),
})
const snapshot = (ira?: Record<string, unknown>) => ({
  sceneId: 's', revision: 1, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' },
  entities: [{ entityId: 'person', name: 'person', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [], components: { human: human(ira) } }],
}) as unknown as SceneSnapshot
const ira = { seed: 7, region: { min: [-1, -1, 0], max: [1, 1, 0] }, dwellS: 1 }

test('普通Scene不启用IRA、不读取资源路径', () => {
  expect(humanIraRequest(snapshot(), {} as NodeJS.ProcessEnv)).toEqual({ enabled: false })
})

test('IRA声明缺可信资源时具名拒绝，不回落普通路线', () => {
  expect(() => humanIraRequest(snapshot(ira), {} as NodeJS.ProcessEnv)).toThrow('HUMAN_IRA_ASSET_UNAVAILABLE')
  expect(() => humanIraRequest(snapshot(ira), { LYAPUNOV_ISAAC_IRA_MOTION_LIBRARY: '/missing' } as NodeJS.ProcessEnv)).toThrow('LYAPUNOV_ISAAC_IRA_CHARACTER')
})

test('IRA声明只接受profile给出的已存在本地原件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ira-provider-'))
  try {
    const motion = join(root, 'HumanMotionLibrary.usd')
    const character = join(root, 'biped.usd')
    await writeFile(motion, 'motion')
    await writeFile(character, 'character')
    expect(humanIraRequest(snapshot(ira), { LYAPUNOV_ISAAC_IRA_MOTION_LIBRARY: motion, LYAPUNOV_ISAAC_IRA_CHARACTER: character } as NodeJS.ProcessEnv)).toEqual({ enabled: true, motionLibrary: motion, character })
    await rm(character)
    expect(() => humanIraRequest(snapshot(ira), { LYAPUNOV_ISAAC_IRA_MOTION_LIBRARY: motion, LYAPUNOV_ISAAC_IRA_CHARACTER: character } as NodeJS.ProcessEnv)).toThrow('ira-character')
  } finally { await rm(root, { recursive: true, force: true }) }
})
