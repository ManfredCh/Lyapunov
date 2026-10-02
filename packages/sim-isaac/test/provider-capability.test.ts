/**
 * ISAAC-04/05：Isaac Provider 的**能力声明必须与真实实现一致**（DEVELOPMENT_PRINCIPLES §3.1 / §7）。
 *
 * 钉住的事实（不启动 Isaac Kit/PhysX，也不依赖 Isaac SDK；被验证的是 provider 与 schema 的代码路径本身）：
 *  1. `geomGroups` 只在 MuJoCo 的 RGB/深度渲染里被真实消费（sim-mujoco/python/worker.py 的 display_groups，
 *     capture/capture_multi/project_annotation 三处调用；见 3241/3282/3373 行）。Isaac 的 worker.capture
 *     只读 width/height/outputDir/cameraName，从不读该字段——修前 IsaacProvider.capture 原样转发就是
 *     **静默忽略**。现在显式给出时必须返回结构化 UNSUPPORTED，且不能先被"世界不存在"之类的下游错误掩盖。
 *  2. 负对照：未给 geomGroups 时不在能力检查处过度拒绝（仍按真实世界状态报 WORLD_NOT_FOUND），
 *     证明拒绝的是"Isaac 不消费的能力"，不是"capture 一律拒绝"。
 *  3. 五个命名相机接口**全部**已真实实现（listCameras/captureMulti/adjustCamera/projectAnnotation/
 *     exportCameraDataset），**没有**再抛 UNSUPPORTED 的空壳：未打开世界时一律按真实语义拒绝
 *     （WORLD_NOT_FOUND），证明它们确实被转发到了 worker。DEV-009 剩的 2/5（像素标注/数据集导出）
 *     由 2026-09-26 的实现补齐，见 bugfixHistory/DEV009-ISAAC-INTERFACES-20260926.md。
 *
 * tool-schema 侧同样断言：`geomGroups` 与命名相机族的公开描述写明只有 MuJoCo 生效、其他 Provider 明确拒绝，
 * 且四处入口共用同一份描述（修前 sensor_capture 另抄了一份，改一处不会同步）。
 */
import { describe, expect, test } from 'bun:test'
import { IsaacProvider } from '../src/provider.ts'
import { createRobotOperations } from '../../robot-tools/src/operations.ts'
import { robotToolParameters } from '../../robot-tools/src/tool-schema.ts'
import { SimError, type SimWorlds } from '../../sim-contract/src/index.ts'

/** 把一次期望失败的调用读成结构化拒绝：只接受 SimError，不用字符串匹配冒充错误码。 */
async function rejection(run: () => Promise<unknown>): Promise<SimError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof SimError) return error
    throw new Error(`期望结构化 SimError，实际抛出 ${String(error)}`)
  }
  throw new Error('期望结构化拒绝，实际调用成功')
}

/** 按数据读 schema 某一层的 description（schema 本身就是数据，不依赖类型收窄）。 */
function descriptionOf(tool: keyof typeof robotToolParameters, ...path: string[]): string {
  let node: unknown = robotToolParameters[tool]
  for (const key of path) {
    if (typeof node !== 'object' || node === null) throw new Error(`${String(tool)}.${path.join('.')} 不存在`)
    node = (node as Record<string, unknown>)[key]
  }
  const description = typeof node === 'object' && node !== null ? (node as { description?: unknown }).description : undefined
  if (typeof description !== 'string') throw new Error(`${String(tool)}:${path.join('.')} 没有 description`)
  return description
}

describe('Isaac geomGroups：显式给出即结构化拒绝，不静默忽略', () => {
  const outputDir = '/tmp/lyapunov-isaac-provider-capability'

  test('显式显示组 → UNSUPPORTED_CAPABILITY（能力检查先于世界查询）', async () => {
    const error = await rejection(() => new IsaacProvider().capture('world-not-open', { outputDir, geomGroups: [3] }))
    expect(error.code).toBe('UNSUPPORTED_CAPABILITY')
    expect(error.message).toContain('未消费显示组过滤')
    expect(error.message).toContain('geomGroups')
  })

  test('空数组也是显式给出（与"未给"不同），同样拒绝', async () => {
    const error = await rejection(() => new IsaacProvider().capture('world-not-open', { outputDir, geomGroups: [] }))
    expect(error.code).toBe('UNSUPPORTED_CAPABILITY')
  })

  test('负对照：未给 geomGroups 时不在能力检查处过度拒绝', async () => {
    const error = await rejection(() => new IsaacProvider().capture('world-not-open', { outputDir }))
    expect(error.code).toBe('WORLD_NOT_FOUND')
  })

  test('入口整条链路：sensor_capture operation 转发到 Isaac 后也是 UNSUPPORTED_CAPABILITY（schema 声明的路径）', async () => {
    const scene = { snapshot: () => { throw new Error('本用例不进入 scene') }, commit: () => { throw new Error('本用例不进入 scene') } }
    const operations = createRobotOperations(new IsaacProvider(), scene)
    const error = await rejection(() => operations.sensor_capture({ worldId: 'world-not-open', outputDir, geomGroups: [3] }))
    expect(error.code).toBe('UNSUPPORTED_CAPABILITY')
    expect(error.message).toContain('geomGroups')
  })
})

describe('命名相机接口：能力声明与真实实现一致（不补空壳）', () => {
  // ISAAC-04（N18）：`listCameras` 已**真实实现**（枚举导入层核验过的原生相机，见 camera-list.test.ts
  // 与回执 ISAAC04-CAMERA-FAMILY-20260922.md），不再属于“明确拒绝”的一组；未打开世界时按真实语义拒绝。
  // ISAAC-04 第 2 项（N19）：`captureMulti` 已**真实实现**（同一物理步复用单相机 RTX 通路，
  // 见 camera-capture-multi.test.ts 与回执 ISAAC04-CAPTURE-MULTI-20260922.md），不再属于“明确拒绝”的一组。
  test('captureMulti 已实现：未知世界按真实语义拒绝（WORLD_NOT_FOUND），不再是 UNSUPPORTED 空壳', async () => {
    const error = await rejection(() => new IsaacProvider().captureMulti('world-not-open', { outputDir: '/tmp/lyapunov-isaac-provider-capability', cameraNames: ['wrist'] }))
    expect(error.code).toBe('WORLD_NOT_FOUND')
  })
  test('listCameras 已实现：未知世界按真实语义拒绝（WORLD_NOT_FOUND），不再是 UNSUPPORTED 空壳', async () => {
    const error = await rejection(() => new IsaacProvider().listCameras('world-not-open'))
    expect(error.code).toBe('WORLD_NOT_FOUND')
  })
  // ISAAC-04 第 3 项（N22）：`adjustCamera` 已**真实实现**（写 live USD 相机 prim 的临时位姿/视场 override，
  // 见 camera-adjust.test.ts 与回执 ISAAC04-CAMERA-ADJUST-20260922.md），同样不再属于“明确拒绝”的一组。
  test('adjustCamera 已实现：未知世界按真实语义拒绝（WORLD_NOT_FOUND），不再是 UNSUPPORTED 空壳', async () => {
    const error = await rejection(() => new IsaacProvider().adjustCamera('world-not-open', { cameraName: 'wrist', expectedGeneration: 1 }))
    expect(error.code).toBe('WORLD_NOT_FOUND')
  })

  // DEV-009 的 2/5 缺口（2026-09-26 补齐）：`projectAnnotation`／`exportCameraDataset` 的 Isaac 侧实现
  // （worker.project_annotation／worker.export_camera_dataset）与 provider 转发已落盘，所以它们同样
  // **不再**对合同调用面抛 UNSUPPORTED：未知世界按真实语义拒绝（WORLD_NOT_FOUND），
  // 证明请求真的被转发到 worker（真实的能力/参数/代次拒绝在 worker 侧，见
  // bugfixHistory/DEV009-ISAAC-INTERFACES-20260926.md）。
  const calls: Array<[string, (sim: SimWorlds) => Promise<unknown>]> = [
    ['projectAnnotation', sim => sim.projectAnnotation('world-not-open', { cameraName: 'wrist', pixel: [1, 1] })],
    ['exportCameraDataset', sim => sim.exportCameraDataset('world-not-open', { outputDir: '/tmp/lyapunov-isaac-provider-capability', captureIds: ['capture-1'] })],
  ]

  for (const [name, call] of calls) {
    test(`${name} 已实现：未知世界按真实语义拒绝（WORLD_NOT_FOUND），不再是 UNSUPPORTED 空壳`, async () => {
      const sim: SimWorlds = new IsaacProvider()
      const error = await rejection(() => call(sim))
      expect(error.code).toBe('WORLD_NOT_FOUND')
    })
  }
})

describe('tool-schema 描述与真实 Provider 行为一致', () => {
  test('geomGroups 三个入口共用同一份"仅 MuJoCo 生效"描述（不再各写一份）', () => {
    const sites: Array<[keyof typeof robotToolParameters, string[]]> = [
      ['sensor_capture', ['input', 'properties', 'geomGroups']],
      ['camera_capture_multi', ['input', 'properties', 'geomGroups']],
      ['camera_project_annotation', ['input', 'properties', 'geomGroups']],
    ]
    const descriptions = sites.map(([tool, path]) => descriptionOf(tool, ...path))
    for (const description of descriptions) {
      expect(description).toContain('This is implemented only by MuJoCo.')
      expect(description).toContain('UNSUPPORTED')
      expect(description).toContain('rather than silently ignoring the field')
    }
    expect(new Set(descriptions).size).toBe(1)
  })

  test('命名相机族五个入口都写成 MuJoCo+Isaac（Isaac 侧五个都已实现，没有 MuJoCo-only 入口）', () => {
    // 与 packages/robot-tools/src/tool-schema.ts 同源：camera_list／camera_capture_multi／camera_adjust／
    // camera_project_annotation／camera_dataset_export 五个都属 MuJoCo+Isaac
    // （N18 接线 camera_list、N22 接线 camera_adjust，真机 rendering:none 下可用；camera_capture_multi 与
    // camera_project_annotation 在 Isaac 需 rendering:rtx，未启动时按 SENSOR_UNAVAILABLE 阶段化拒绝；
    // camera_dataset_export 消费已记录的真实采集；DEV-009 剩的 2/5 由 2026-09-26 的实现补齐）。
    const scope = descriptionOf('camera_list', 'input')
    for (const tool of ['camera_list', 'camera_capture_multi', 'camera_adjust', 'camera_project_annotation', 'camera_dataset_export'] as const) {
      expect(descriptionOf(tool, 'input')).not.toMatch(/(?:Only MuJoCo(?: provider)?|MuJoCo(?: provider)? alone) implements/i)
      expect(descriptionOf(tool, 'input')).toContain('MuJoCo and Isaac implement')
    }
    // Newton 的拒绝对五处都照旧说明（同一条共享口径，不逐条复制文案）。
    expect(scope).toContain('UNSUPPORTED_CAPABILITY')
  })
})
