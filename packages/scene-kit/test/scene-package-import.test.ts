import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SceneOperations } from '../src/operations.ts'
import type { Transform } from '../../lyapunov-contracts/src/types.ts'
let root: string, pack: string, ops: SceneOperations
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'scene-package-')); pack = join(root, 'package'); await mkdir(pack); ops = new SceneOperations(join(root, 'owner')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
async function document() {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'box' }] }))
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]), header = Buffer.alloc(20)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + padded.length, 8); header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16)
  await writeFile(join(pack, 'box.glb'), Buffer.concat([header, padded]))
  const entities = [.04, .06].map((size, i) => ({ entityId: `box${i}`, name: `方块${i}`, transform: { position: [i, 0, size / 2], quaternion: [0, 0, 0, 1], scale: [size, size, size] }, resources: [{ resourceId: 'unregistered-template-id', version: 1, original: { uri: 'box.glb', mimeType: 'model/gltf-binary' }, representations: [] }], components: { visual: { kind: 'mesh' }, collision: { shape: 'box', halfExtents: [.5, .5, .5] }, rigidBody: { dynamic: true, mass: .08 } } }))
  const snapshot = { sceneId: 'template', revision: 6, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities }
  await writeFile(join(pack, 'test.scene-package.json'), JSON.stringify(snapshot))
  return snapshot
}
test('正规导入产生真实CAS身份/source，保留实例尺寸，搬走原包后仍可验证', async () => {
  const original = await document(), scene = await ops.open(join(pack, 'test.scene-package.json'))
  expect(scene.sceneId).not.toBe('template'); expect(scene.revision).toBe(0); expect(scene.entities).toHaveLength(2)
  expect(scene.entities.map(e => e.transform)).toEqual(original.entities.map(e => e.transform as Transform))
  const ref = scene.entities[0]!.resources[0]!
  expect(ref.resourceId).not.toBe('unregistered-template-id'); expect(ref.source).toEqual({ units: 'm', upAxis: 'Y', handedness: 'right', metersPerUnit: 1 })
  expect(scene.entities[1]!.resources[0]).toEqual(ref); expect((await ops.resources.list())).toHaveLength(1)
  expect((await ops.resources.list())[0]!.storage).toBe('cas')
  await rename(pack, join(root, 'moved-package'))
  expect((await ops.resources.verify(ref.resourceId, ref.version)).valid).toBe(true)
  expect((await ops.versions(scene.sceneId)).map(v => v.revision)).toEqual([0])
})
test('完整缺件一次预检，未创建场景或半套资源记录', async () => {
  const value = await document(); value.entities[0]!.resources[0]!.original.uri = 'missing-a.glb'; value.entities[1]!.resources[0]!.original.uri = 'missing-b.glb'
  await writeFile(join(pack, 'test.scene-package.json'), JSON.stringify(value))
  try { await ops.importPackage(join(pack, 'test.scene-package.json')); throw new Error('不应成功') } catch (error) { expect(String(error)).toContain('SCENE_PACKAGE_ASSETS_INVALID'); expect(String(error)).toContain('方块0'); expect(String(error)).toContain('方块1') }
  expect(await ops.list()).toEqual([]); expect(await ops.resources.list()).toEqual([])
})
test('显式既有sceneId不会覆盖用户场景', async () => {
  await document(); const old = await ops.create({ sceneId: 'owned' })
  await expect(ops.importPackage(join(pack, 'test.scene-package.json'), { sceneId: 'owned' })).rejects.toThrow('SCENE_ALREADY_EXISTS')
  expect(await ops.scene.snapshot('owned')).toEqual(old); expect(await ops.resources.list()).toEqual([])
})
