import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { validateIsaacAsset } from '../src/asset-validation.ts'

test('Isaac 官方规则检查独立 stage 并定位缺失的碰撞与质量声明', { timeout: 120_000 }, async () => {
 const dir = await mkdtemp(join(tmpdir(), 'lyapunov-isaac-rules-'))
 const ctx = new Context()
 const subprocess = await ctx.plugin(LocalSubprocess)
 const root = resolve(import.meta.dirname, '../../..')
 const config = { python: process.env.LYAPUNOV_ISAAC_PYTHON ?? join(root, '.runtime/conda/envs/isaac/bin/python'), cacheRoot: join(dir, 'kit') }
 try {
  const reports = []
  for (const valid of [true, false]) {
   const apis = valid ? '"PhysicsRigidBodyAPI", "PhysicsMassAPI", "PhysicsCollisionAPI"' : '"PhysicsRigidBodyAPI"'
   const bytes = `#usda 1.0\n( defaultPrim = "Root" )\ndef Cube "Root" ( prepend apiSchemas = [${apis}] ) {\n double size = 0.2\n float physics:mass = 1\n float3 physics:diagonalInertia = (0.01, 0.01, 0.01)\n}\n`
   const path = join(dir, valid ? 'valid.usda' : 'missing.usda')
   await writeFile(path, bytes)
   const report = await validateIsaacAsset(ctx.subprocess, config, { path, profile: 'explicit-mass', simulate: valid })
   reports.push(report)
   assert.equal(await readFile(path, 'utf8'), bytes)
   assert.equal(report.status, 'CHECKED')
   assert.equal(report.sdkVersion, '6.0.1.0')
   assert.ok(report.sourceSha256)
   if (valid) {
    assert.deepEqual(report.static.issues, [])
    assert.deepEqual(report.simulation.rules, ['NonAdjacentCollisionMeshesDoNotClash'])
   } else {
    assert.deepEqual(new Set(report.static.issues.map((i: { rule: string }) => i.rule)), new Set(['RigidBodyHasCollider', 'RigidBodyHasMassAPI']))
    assert.equal(report.simulation, null)
   }
  }
  const robot = await validateIsaacAsset(ctx.subprocess, config, { path: join(dir, 'missing.usda'), profile: 'robot' })
  assert.ok(robot.static.rules.includes('RobotSchema'))
  assert.ok(robot.static.rules.includes('CheckRobotRelationships'))
  assert.ok(robot.static.issues.some((issue: { rule: string }) => issue.rule === 'RobotSchema' || issue.rule === 'HasArticulationRoot'))
  reports.push(robot)
  const artifacts = process.env.LYAPUNOV_VALIDATION_OUTPUT_DIR
  if (artifacts) {
   await mkdir(artifacts, { recursive: true })
   await writeFile(join(artifacts, 'reports.json'), JSON.stringify(reports, null, 2))
  }
 } finally { await subprocess.dispose(); await rm(dir, { recursive: true, force: true }) }
})
