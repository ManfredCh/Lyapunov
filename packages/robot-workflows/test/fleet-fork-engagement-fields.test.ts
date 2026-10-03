/**
 * D5（`bugfixHistory/ZERO-CONSUMER-FIELD-AUDIT-20260926.md` D5）：`measureForkPocketEngagement`
 * 逐叉孔行里那个"带符号侧向误差"字段 —— 审计给的两个选项（**删** 或 **接诊断导出**）里，本单裁定 **删**，
 * 判据（Lead 逐字）：**改完那个字段要么有消费点、要么不存在**。
 *
 * 为什么是删（理由与复算在 `bugfixHistory/STATUS-WORDING-AND-VISIBILITY-20260927.md` §③）：
 *  · 全仓产品 src **0 个读取点**（写点只有 `fleet-load-interface.ts` 自己那一处）；
 *  · 它**不是数据出口**：唯一带它出去的路径是 `cargo-transfer.ts` 的 `mark('engaged', { measurements })`，
 *    而那些 `detail` 在**工具出口**被 `cargo-transfer-plugin.ts` 的 render 裁成 `{phase,frameId,stepIndex}`
 *    ⇒ 用户与模型都看不到它（"留着将来有人看"不成立：今天没有任何一条面能到人眼前）；
 *  · 幅值已被 `transverse_error_m = hypot(侧向, 垂直)` 覆盖，剩下丢的只是**符号**；
 *  · "接诊断导出"要先**新增一条交付面**（渲染/回执面）—— 那是另一件带可见性义务的活，不是 D5 的清理。
 *
 * 三条判据（缺一不可）：
 *  ① **不存在**：逐叉孔行只有三个键，且**全仓产品 src 0 命中**那个名字（不是"改名藏起来"）；
 *  ② **剩下的三个各自有消费点**（删的是那一格，不是把整行删了）：
 *     `axial_depth_m`／`transverse_error_m` 走 `admitForkPocketEngagement`（**行为级**断言），
 *     `vertical_error_m` 走 `cargo-transfer.ts` 的两次 `liftTo` 门槛（**源码守卫级** —— 真机插入路径不在本机可跑）；
 *  ③ **几何一个字没动**：`transverse_error_m === hypot(侧向, 垂直)`、`axial_depth_m` 仍是**投影**。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { admitForkPocketEngagement, measureForkPocketEngagement } from '../src/fleet/fleet-load-interface.ts'

/** 插入轴取 +X（世界系），于是：轴向 = Δx、侧向 = Δy、垂直 = Δz —— 三个读数都能手算核对。 */
const engagement = (tips: readonly (readonly [number, number, number])[], pockets: readonly (readonly [number, number, number])[]) =>
  measureForkPocketEngagement({ insertionAxisWorldXY: [1, 0], pocketCentersWorldM: pockets, tineTipPositionsM: tips })

describe('D5 · 叉孔对位测量：零消费的那一格已删，剩下的三格各自有消费点', () => {
  test('① 逐叉孔行**只有三个键**；侧向那格**不存在**（不是改名）', () => {
    const rows = engagement([[0.05, 0.004, 0.002]], [[0, 0, 0]])
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(Object.keys(row).sort()).toEqual(['axial_depth_m', 'transverse_error_m', 'vertical_error_m'])
    // 名字不许以任何别名回来：`Object.values` 只有三个数
    expect(Object.values(row)).toHaveLength(3)
    expect(rows.every(value => value === null || !Object.hasOwn(value, 'lateral_error_m'))).toBe(true)
  })

  test('③ 几何没被动过：轴仍是投影、`transverse` 仍是 `hypot(侧向, 垂直)`', () => {
    const tips = [[0.052, 0.0041, 0.0022], [0.03, -0.011, -0.004], [0.08, 0, 0.006]] as const
    const pockets = [[0, 0, 0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]] as const
    const rows = engagement(tips, pockets)
    for (const [index, row] of rows.entries()) {
      const [dx, dy, dz] = [tips[index]![0], tips[index]![1], tips[index]![2]]
      expect(row!.axial_depth_m).toBeCloseTo(dx, 12)                               // 轴 = +X ⇒ 投影就是 Δx
      expect(row!.vertical_error_m).toBeCloseTo(dz, 12)
      expect(row!.transverse_error_m).toBeCloseTo(Math.hypot(dy, dz), 12)          // 侧向 Δy 仍被它覆盖
    }
    // 反向（判据不许空过）：侧向非零时 `transverse` 必须**大于** |垂直|，否则上面那条等式是"两边都恒 0"
    const sideways = engagement([[0, 0.01, 0]], [[0, 0, 0]])[0]!
    expect(sideways.transverse_error_m).toBeCloseTo(0.01, 12)
    expect(sideways.transverse_error_m).toBeGreaterThan(Math.abs(sideways.vertical_error_m))
  })

  test('② `axial_depth_m`／`transverse_error_m` 真有消费点：`admitForkPocketEngagement` 按它们判入位', () => {
    const deep = engagement([[0.06, 0.0, 0.0], [0.06, 0.0, 0.0]], [[0, 0, 0], [0, 0, 0]])
    expect(admitForkPocketEngagement(deep, { minimumAxialDepthM: 0.045 })).toMatchObject({ admitted: true, validTineCount: 2 })
    const tooShallow = engagement([[0.01, 0.0, 0.0], [0.06, 0.0, 0.0]], [[0, 0, 0], [0, 0, 0]])
    expect(admitForkPocketEngagement(tooShallow, { minimumAxialDepthM: 0.045 }).admitted).toBe(false)
    const offToTheSide = engagement([[0.06, 0.2, 0.0], [0.06, 0.0, 0.0]], [[0, 0, 0], [0, 0, 0]])
    expect(admitForkPocketEngagement(offToTheSide, { maximumTransverseErrorM: 0.035 }).admitted).toBe(false)
    // 删掉的那一格**不在**判据里：同一批读数，入位结论只由剩下两格决定（把侧向塞进 transverse 也只是幅值）
    expect(admitForkPocketEngagement(offToTheSide, { maximumTransverseErrorM: 0.3 }).admitted).toBe(true)
  })

  test('② `vertical_error_m` 真有消费点：`cargo-transfer.ts` 的两次 `liftTo` 门槛在读它（源码守卫）', () => {
    const source = readFileSync(join(import.meta.dirname, '../src/cargo-transfer.ts'), 'utf8')
    const reads = source.split('\n').filter(line => /Math\.abs\(m\.vertical_error_m\)/.test(line))
    expect(reads.length).toBe(2)                                    // pocket-height 与 clear-fork-height 两处
    expect(source).toContain('admitForkPocketEngagement(m, { minimumAxialDepthM: .045 })')
    expect(source).toContain('now.measurements.some(m => m && m.axial_depth_m > -.15)')
  })

  test('① 全仓产品 src **0 命中**那个名字（删干净了，不是只剩注释/别名）', () => {
    const root = join(import.meta.dirname, '../../..')              // <repo>/Dev
    const offenders: string[] = []
    const scan = (dir: string, keep: (rel: string, name: string) => boolean) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') scan(path, keep); continue }
        const relative = path.slice(root.length + 1)
        if (!/\.(ts|tsx)$/.test(entry.name) || !keep(relative, entry.name)) continue
        if (readFileSync(path, 'utf8').includes('lateral_error_m')) offenders.push(relative)
      }
    }
    // 产品源码树：`packages/**/src/**`（含嵌套包）—— **测试文件与文档不算**（它们本来就该能点这个名字）；
    // 另加 `script/` 的非测试实现文件（同样是产品侧可消费点）。
    scan(join(root, 'packages'), relative => relative.includes('/src/'))
    scan(join(root, 'script'), (_relative, name) => !name.endsWith('.test.ts'))
    expect(offenders).toEqual([])
  })
})
