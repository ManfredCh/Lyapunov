/**
 * GAIT 语义对齐（task：三处各说各话）—— 把「合同 kind 元组 / 工具文案 / 几何开环通道」钉成同一句话。
 *
 * 改前的事实（`bugfixHistory/VERIFY-ISAAC-GAIT-DRONE-20260926.md` §5 乙类）：
 *   ① 合同 `RobotCapability.kind` 是封闭 6 元组，**不含 `gait`/`tendon`** ⇒ `gait.available` 的语义没有合同承载；
 *   ② 工具文案（`tool-schema.ts`）把 gait 讲成**策略**（`robot_walk`＝"只运行资产已有且适用的步态策略"）；
 *   ③ 通道实跑 `packages/sim-mujoco/python/gait.py` 的**几何开环**相位目标，且该动作不保证净位移方向。
 * 本文件钉的就是这三处不许再各说各话：
 *   · 合同 kind 元组**必须等于 provider 实际投递的 kind 集合**（锚点取自 Isaac worker 源码，不是抄常量）；
 *   · gait 的"不保证稳定行走/不携带位移方向"必须是**合同里有名字的字段**，且该字段名有真实生产者；
 *   · 工具文案必须与几何开环一致（"策略"字样清掉，两条路线分开写）；
 *   · "几何开环"必须在 `gait.py` 的依赖面与载荷项上可核（不许只改文案）。
 *
 * 证据边界（不冒充引擎实测）：本文件**不跑 worker、不跑 Isaac/MuJoCo 引擎**。
 *   · 合同侧：声明面证据（读源码文本 + tsc 判定；运行时常量 `ROBOT_CAPABILITY_KINDS` 是唯一的运行时可核面）；
 *   · 通道侧：只核**源码结构**（依赖面、载荷项、两个 worker 是否 import 同一份实现）；
 *   · "±forward 一个周期内目标集合相同""forward=+0.6 净位移 x=−0.0868m"是**回执里的读数**
 *     （本机用 `.runtime/sim-python` 的 mujoco 复算过，但不进本测试矩阵——那会让用例依赖某台开发机的运行时根）。
 *   · **本文件不覆盖**：Isaac worker 的 gait 能力行/回执**实际是否投递** `stableWalkingNotGuaranteed`
 *     （它目前**没投**，补丁在工作面写域之外，见回执 §未覆盖）。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gaitChannelScope, robotToolParameters } from '../src/tool-schema.ts'
import { ROBOT_CAPABILITY_KINDS } from '../../sim-contract/src/index.ts'
import type { RobotCapabilityKind } from '../../sim-contract/src/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEV = resolve(HERE, '../../..')
const read = (rel: string): string => readFileSync(join(DEV, rel), 'utf8')
/**
 * 负对照用（**不是产品开关**）：指向"改前/被污染"的 gait.py 副本，验证本文件真的会红。
 * 与 `sim-newton/test/capability-truth.test.ts` 的 `LYAPUNOV_NEWTON_WORKER_PATH` 同一形态。
 */
const GAIT_MODULE = process.env.LYAPUNOV_GAIT_MODULE_PATH ?? join(DEV, 'packages/sim-mujoco/python/gait.py')

/** 取出 schema 里全部字符串（描述、const 值…）：不依赖内部形状，避免测试跟着类型重构走。 */
const stringsOf = (value: unknown): string[] =>
  typeof value === 'string' ? [value]
    : Array.isArray(value) ? value.flatMap(stringsOf)
      : value !== null && typeof value === 'object' ? Object.values(value as Record<string, unknown>).flatMap(stringsOf)
        : []
const textOf = (tool: keyof typeof robotToolParameters): string => stringsOf(robotToolParameters[tool]).join('\n')

/**
 * 类型面断言：合同 kind **必须**真的承认这 8 个取值（`tsc` 判定，不靠运行时常量自证）；
 * 若哪个 kind 从 `RobotCapability['kind']` 掉出去，本行编译失败 ⇒ 双 tsc 门变红。
 */
const CAPABILITY_KINDS_TYPED: readonly RobotCapabilityKind[] = ['thrust', 'vehicle', 'joint', 'gripper', 'lift', 'control', 'gait', 'tendon']

/**
 * provider 真正投递的 capability kind：**从 Isaac worker 源码的 `capabilities()` 方法体里取**，
 * 不是抄一份常量（抄常量就变成"合同跟自己比"，改前那个 6 元组正是这么活下来的）。
 * 锚点找不到时**抛错**而不是跳过：静默跳过等于这条判据不存在。
 */
function isaacCapabilityKinds(source: string): string[] {
  const start = source.indexOf('\n    def capabilities(self,e):')
  if (start < 0) throw new Error('提取锚点过期：packages/sim-isaac/python/worker.py 里找不到 `    def capabilities(self,e):`，必须人工重核而不是跳过')
  const rest = source.slice(start + 1)
  const next = rest.indexOf('\n    def ')
  const body = next < 0 ? rest : rest.slice(0, next)
  const kinds = [...new Set([...body.matchAll(/\{'kind':'([a-z]+)'/g)].map(match => match[1]!))].sort()
  if (kinds.length === 0) throw new Error('提取锚点过期：capabilities() 方法体里没有匹配到任何 `{\'kind\':\'…\'`')
  return kinds
}

/**
 * 取出 `export interface <name> { … }` 的方法体（花括号配平）。
 * 为什么不用 `toContain('字段名')`：那样**只**在散文里提一句字段名就能骗过测试——
 * 本文件的负对照正是因此先红了一次（见回执 §负对照 NC-3），所以这里必须钉**声明**。
 */
function interfaceBody(source: string, name: string): string {
  const at = source.indexOf(`export interface ${name} {`)
  if (at < 0) throw new Error(`提取锚点过期：合同里找不到 export interface ${name} {`)
  const open = source.indexOf('{', at)
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}') { depth--; if (depth === 0) return source.slice(open, index + 1) }
  }
  throw new Error(`花括号不配平：export interface ${name} 的方法体没闭合`)
}

describe('GAIT 语义对齐：合同 = 实际投递集合', () => {
  test('合同 kind 元组等于 Isaac worker 实际投递的 kind 集合（gait/tendon 必须在内）', () => {
    const delivered = isaacCapabilityKinds(read('packages/sim-isaac/python/worker.py'))
    // 两侧都当字符串集合比：worker 投递的是运行时字符串，合同那侧是字面量元组（`toEqual` 的形参类型
    // 是元组元素联合，不 cast 会 TS2769 —— 探针期间实测踩到过）。
    expect([...ROBOT_CAPABILITY_KINDS].sort() as string[]).toEqual(delivered)
    // 逐条点名：这两个正是改前落在合同之外、又真的会被投递的 kind。
    expect(delivered).toContain('gait')
    expect(delivered).toContain('tendon')
    expect(ROBOT_CAPABILITY_KINDS as readonly string[]).toContain('gait')
    expect(ROBOT_CAPABILITY_KINDS as readonly string[]).toContain('tendon')
    // 类型面与运行时常量必须同集（tsc 判定；这里顺带把长度钉住，防"常量加了类型没加"）。
    expect([...CAPABILITY_KINDS_TYPED].sort()).toEqual([...ROBOT_CAPABILITY_KINDS].sort())
  })

  test('每个能力 kind 都能被工具面表达成动作（合同里的语义不许没有入口）', () => {
    const all = stringsOf(robotToolParameters)
    for (const kind of ROBOT_CAPABILITY_KINDS) expect(all).toContain(kind)
  })
})

describe('GAIT 语义对齐：显式字段有名字、有生产者', () => {
  const contract = read('packages/sim-contract/src/index.ts')

  test('"不保证稳定行走/不携带位移方向"是合同里声明过的字段，不是只写在散文里', () => {
    // 声明面：字段必须真的在 `RobotCapability` 方法体里（不是只在注释里被提一句）。
    expect(interfaceBody(contract, 'RobotCapability')).toMatch(/stableWalkingNotGuaranteed\?:\s*true/)
    // 规范化：kind 由导出的元组派生（单一来源），gait 是其中一员。
    expect(interfaceBody(contract, 'RobotCapability')).toMatch(/kind:\s*RobotCapabilityKind/)
    expect(contract).toMatch(/ROBOT_CAPABILITY_KINDS = \[[^\]]*'gait'[^\]]*\]/)
    // 规范文字：available=true 的 gait 是什么、不是什么。
    expect(contract).toContain('几何开环')
    expect(contract).toContain('不是“会走”')
    expect(contract).toContain('缺键不等于保证')
  })

  test('gait 行承载"参考由谁产生"的字段也在合同里（controller/geometrySource/相位参数）', () => {
    const body = interfaceBody(contract, 'RobotCapability')
    for (const field of ['controller?:', 'geometrySource?:', 'frequencyHz?:', 'strideM?:', 'liftM?:'])
      expect(body).toContain(field)
  })

  test('该字段名不是新造词汇：MuJoCo worker 的真实回执里就有它', () => {
    const mujoco = read('packages/sim-mujoco/python/worker.py')
    expect(mujoco).toContain("'stableWalkingNotGuaranteed':True")
    // 同一处还报了控制器身份（几何相位控制器，不是策略）——两条都指"参考由谁产生"。
    expect(mujoco).toContain("'controller':'planar-diagonal-trot'")
  })

  test('gait 动作类型在合同里有语义（改前 `GaitMotion` 一行零注释）', () => {
    expect(contract).toContain("export interface GaitMotion")
    const at = contract.indexOf('export interface GaitMotion')
    const doc = contract.slice(Math.max(0, at - 1400), at)
    expect(doc).toContain('几何开环')
    expect(doc).toContain('不保证净位移方向')
    expect(doc).toContain("executePolicy → sim.execute(kind:'control')")
  })
})

describe('GAIT 语义对齐：工具文案与几何开环一致', () => {
  test('robot_walk 不再说"策略"，写明几何开环 / 不携带位移方向 / available≠会走', () => {
    const walk = textOf('robot_walk')
    expect(walk).toContain('geometric open-loop')
    expect(walk).toContain('neither a speed target nor a displacement-direction command')
    expect(walk).toContain('not that the robot walks')
    expect(walk).not.toContain('gait policy')
    expect(walk).not.toContain('already supported quadruped policies')
  })

  test('两条真实路线分开写：不给 policy/packId ⇒ 透传几何开环；给了 ⇒ 策略链路', () => {
    const walk = textOf('robot_walk')
    expect(walk).toContain('Without policy/packId, pass through')
    expect(walk).toContain('executePolicy')
    expect(walk).toContain('With policy or packId')
  })

  test('gait 参数文案同步（forward 不是速度目标），且 robot_move 指向同一口径', () => {
    const walkStrings = stringsOf(robotToolParameters.robot_walk)
    const forward = walkStrings.find(text => text.startsWith('Quadruped forward intent'))
    expect(forward).toBeDefined()
    expect(forward!).toContain('not target speed or displacement direction')
    expect(forward!).not.toContain('policy')
    expect(textOf('robot_move')).toContain('geometric open-loop')
  })

  test('范围文案是**单一口径**：robot_walk 与导出常量逐字同源', () => {
    expect(textOf('robot_walk')).toContain(gaitChannelScope)
    expect(gaitChannelScope).toContain('packages/sim-mujoco/python/gait.py')
    expect(gaitChannelScope).toContain('no policy weights, state estimation, stabilizer, or feedback')
  })
})

describe('GAIT 语义对齐：开环不是文案里的形容词（源码可核）', () => {
  const source = readFileSync(GAIT_MODULE, 'utf8')

  test('gait.py 的依赖面里没有策略/权重/学习运行时', () => {
    const imports = [...source.matchAll(/^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/gm)].map(match => match[1]!.split('.')[0]!)
    expect([...new Set(imports)].sort()).toEqual(['math', 'mujoco', 'numpy'])
    for (const banned of ['torch', 'onnx', 'tensorflow', 'jax', 'policy', 'weights', 'checkpoint', 'nn.'])
      expect(source.toLowerCase()).not.toContain(banned)
  })

  test('两个 worker 直接 import 同一份实现（不是各写一套），且只做几何标定/相位目标', () => {
    expect(source).toMatch(/def calibrate\(/)
    expect(source).toMatch(/def targets\(/)
    // 载荷项：方向只经由 speed 进 -cos(phase) —— 它的符号翻转等价于相位平移半周期，
    // 所以目标集合里**没有方向量**（"不携带位移方向"这句话就架在这一项上）。
    expect(source).toContain('-math.cos(phase)*speed')
    expect(read('packages/sim-isaac/python/worker.py')).toContain('import gait')
    expect(read('packages/sim-isaac/python/worker.py')).toContain('gait.targets(legs,time_s,forward,turn,frequency,stride,lift)')
    expect(read('packages/sim-mujoco/python/worker.py')).toContain('gait.targets(')
  })
})
