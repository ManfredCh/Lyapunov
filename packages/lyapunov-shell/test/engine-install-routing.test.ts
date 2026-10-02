import { expect, test } from 'bun:test'
import { EngineInstallAuthorization, planEngineInstallIntent } from '../src/engine-install-routing.ts'

test('explicit engine install requests require confirmation and use closed identities', () => {
  expect(planEngineInstallIntent('install MuJoCo')).toEqual({ kind: 'confirm', provider: 'mujoco', reason: 'EXPLICIT_INSTALL' })
  expect(planEngineInstallIntent('请安装 Isaac Sim')).toEqual({ kind: 'confirm', provider: 'isaac', reason: 'EXPLICIT_INSTALL' })
  expect(planEngineInstallIntent('set up Newton')).toEqual({ kind: 'confirm', provider: 'newton', reason: 'EXPLICIT_INSTALL' })
})

test('questions, status, negation and uninstall never dispatch', () => {
  expect(planEngineInstallIntent('Can you install Isaac?')).toMatchObject({ kind: 'none', reason: 'QUESTION' })
  expect(planEngineInstallIntent('MuJoCo status')).toMatchObject({ kind: 'none', reason: 'STATUS' })
  expect(planEngineInstallIntent('不要安装 Newton')).toMatchObject({ kind: 'none', reason: 'NEGATED' })
  expect(planEngineInstallIntent('uninstall Isaac')).toMatchObject({ kind: 'none', reason: 'UNINSTALL' })
})

test('unknown and multiple engines require an explicit choice', () => {
  expect(planEngineInstallIntent('install the physics engine')).toMatchObject({ kind: 'choose', reason: 'ENGINE_REQUIRED' })
  expect(planEngineInstallIntent('install MuJoCo and Newton')).toMatchObject({ kind: 'choose', reason: 'ENGINE_AMBIGUOUS', providers: ['mujoco', 'newton'] })
})

test('Isaac intent never implies license acceptance', () => {
  const decision = planEngineInstallIntent('install Isaac Sim')
  expect(decision).toMatchObject({ kind: 'confirm', provider: 'isaac' })
  expect('acceptEula' in decision).toBe(false)
})

test('authorization requires the next-turn confirmation and is consumed once', () => {
  const auth = new EngineInstallAuthorization()
  expect(auth.observe('session-a', 'install MuJoCo', 4, 1000)).toContain('explicitly confirm')
  expect(auth.consume('session-a', 'mujoco', 1001)).toBe(false)
  expect(auth.observe('session-a', '确认', 5, 1004)).toContain('Installation of mujoco is confirmed')
  expect(auth.consume('session-a', 'isaac', 1005)).toBe(false)
  expect(auth.consume('session-a', 'mujoco', 1006)).toBe(true)
  expect(auth.consume('session-a', 'mujoco', 1007)).toBe(false)
})
