/**
 * 源格式支持矩阵（interpreter-free）：真实资源库 + 只读预检。
 *
 * 钉住 R-013 的边界：USD（当前 `formats.ts` 只收件为 `kind=source`，没有结构 body/link 投影）
 * 必须给**具名 unsupported**，绝不按扩展名开放提取按钮，也不用 MJCF 转换件冒充原格式保真；
 * 拒绝路径零 Scene 写入、零资源版本增长。真实 MJCF/URDF 的闭合提取与拒绝由
 * `subtree-native.test.ts`（envgate）覆盖。
 */
import { test, expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SceneOperations } from '../../scene-kit/src/operations.ts'
import { inspectRobotSubtreeResource } from '../../scene-kit/src/subtree-extract.ts'

test('USD（kind=source）给具名 SUBTREE_FORMAT_UNSUPPORTED，且不新增任何资源版本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-subtree-usd-'))
  try {
    const usdPath = join(root, 'scene.usda')
    await writeFile(usdPath, '#usda 1.0\n(\n    defaultPrim = "World"\n)\n')
    const ops = new SceneOperations(join(root, 'data'))
    const imported = await ops.resources.import({ path: usdPath, category: 'scene', name: 'usd-scene' })
    expect(imported.parsed.kind).toBe('source')
    const before = (await ops.resources.list({ allVersions: true })).length
    const inspection = await inspectRobotSubtreeResource({ resources: ops.resources, sourceResourceId: imported.ref.resourceId, sourceVersion: imported.ref.version, bodyName: 'link7' })
    expect(inspection.supported).toBe(false)
    expect(inspection.unsupported?.code).toBe('SUBTREE_FORMAT_UNSUPPORTED')
    expect(inspection.format).not.toBe('mjcf')
    const after = (await ops.resources.list({ allVersions: true })).length
    expect(after).toBe(before)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('URDF mimic 横跨切口：具名 SUBTREE_CROSS_EDGE_DEPENDENCY，零派生版本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-subtree-mimic-'))
  try {
    const ops = new SceneOperations(join(root, 'data'))
    const imported = await ops.resources.import({ path: join(import.meta.dir, 'fixtures/p9-subtree/mimic-cross.urdf'), category: 'robot', name: 'mimic-cross' })
    const before = (await ops.resources.list({ allVersions: true })).length
    const inspection = await inspectRobotSubtreeResource({ resources: ops.resources, sourceResourceId: imported.ref.resourceId, sourceVersion: imported.ref.version, bodyName: 'hand_link' })
    expect(inspection.supported).toBe(false)
    expect(inspection.facts?.crossEdges.some(edge => edge.kind === 'mimic')).toBe(true)
    expect((await ops.resources.list({ allVersions: true })).length).toBe(before)
  } finally { await rm(root, { recursive: true, force: true }) }
})
