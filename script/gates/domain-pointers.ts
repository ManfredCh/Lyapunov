/**
 * 域指针（用户口中的 "router"）行为门禁。
 *
 * **为什么需要这道门**：提示注入的正则永远"合法"、类型永远是 `RegExp`，类型检查与人工 review
 * 都看不出"这句话到底注入了哪几条"。2026-09-18 就实测出两个真实缺陷：`cad-import` 排在
 * `scene-construction` 之后导致「按这张施工图建个场景」把**读图指针挤掉**；裸 `floor` 又会在
 * `floorplan` 内部命中。所以本门禁不测实现细节，只钉**行为**：一张"用户会这么说 → 必须/不得
 * 注入哪些技能"的预期表。改词、调顺序、加域之后跑一次，谁被挤掉立刻可见。
 *
 * **2026-09-20 按主代理核对收敛**（本门禁的消费者随之更新）：
 * 1. 预期表不再把 `slice(0,2)` 当作注入语义。真实注入由产品自己的 `planDomainPointers`
 *    （`packages/lyapunov-shell/src/environment-routing.ts`）算出来：环境任务先给阶段技能，
 *    关键词表只做**有序补充**（合计不超过 3 行）。旧模型的"命中前两条"是**补充**的排序规则，
 *    不是最终注入结果——把补充模型当语义标准会让门禁和产品行为各说各话。
 * 2. `floorplan` **是**图纸写法：它是 `floor` + `plan` 的合写，不是"纯 3D 请求"。旧的
 *    "floorplan 不得命中 cad-import"预期是错的（当时为了绕开裸 `floor` 的假阳性，把结论
 *    记错了对象），现在正则显式收 `floorplan`，这里也改成**必须命中**。
 * 3. 新增主代理反例组：否定式停止不得算停止、"只给方案"优先于停止、图像附件本身不授权环境
 *    建模、"继续"必须有带领域名的原生 todo 依据、用户点名的图纸词压过未知附件名。
 *
 * 实现上**从 `plugin.ts` 源码解析出真实正则**（而不是在测试里重抄一份），再把真实消息喂给
 * 产品自己的判定函数：重抄一份就失去了门禁的意义——正则改了测试不改，两边一起漂移。
 *
 * 用法：`bun run script/gates/domain-pointers.ts`
 * 退出码：0=全过；1=有预期不符；2=无法从源码解析出指针表（源码结构变了，本门禁需同步）。
 */
import { readFileSync } from 'node:fs'

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { PRODUCT_ROOT } from '../profile.ts'
import type { Check, GateResult } from './contract.ts'
import { planDomainPointers } from '../../packages/lyapunov-shell/src/environment-routing.ts'
import type { EnvironmentStage, EnvironmentRoutingInput } from '../../packages/lyapunov-shell/src/environment-routing.ts'

const PLUGIN = `${PRODUCT_ROOT}/packages/lyapunov-shell/src/plugin.ts`

interface Pointer { skill: string; label: string; pattern: RegExp; tool: boolean }

/**
 * 从 plugin.ts 里抠出 `domainPointers` 数组。
 *
 * 只认这个数组字面量里的 `{skill:"…",label:"…",pattern:/…/i,tool:true}` 形状；
 * 解析不到任何一条就抛 2（源码改成别的写法了，本门禁必须跟着改，不能静默通过）。
 */
export function parsePointers(source: string): Pointer[] {
  const start = source.indexOf('const domainPointers')
  if (start < 0) throw new Error('DOMAIN_POINTERS_NOT_FOUND: plugin.ts 里找不到 domainPointers')
  // 数组在第一个 "]" 结束；正则里的字符类不含 "]"，插件里也没有嵌套数组。
  const end = source.indexOf('\n ]', start)
  if (end < 0) throw new Error('DOMAIN_POINTERS_UNTERMINATED: 找不到数组结尾')
  const block = source.slice(start, end)
  const pointers: Pointer[] = []
  const re = /\{skill:"([^"]+)",label:"([^"]+)",pattern:(\/.+?\/[a-z]*)(,tool:true)?\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(block)) !== null) {
    const [, skill, label, literal, tool] = match
    // 用 eval 之外的方式还原字面量：`/…/i` 里最后一个 `/` 是分隔符。
    const lastSlash = literal.lastIndexOf('/')
    const body = literal.slice(1, lastSlash)
    const flags = literal.slice(lastSlash + 1)
    pointers.push({ skill, label, pattern: new RegExp(body, flags), tool: Boolean(tool) })
  }
  if (!pointers.length) throw new Error('DOMAIN_POINTERS_EMPTY: 解析出 0 条指针')
  return pointers
}

/** 关键词表单独命中哪些条目（**诊断信息**：真正注入什么由 `planDomainPointers` 决定）。 */
export function hitSkills(pointers: Pointer[], text: string): string[] {
  return pointers.filter(item => item.pattern.test(text)).map(item => item.skill)
}

/** 预期表的一条：`text` 是用户真实说法，`hit`/`exact`/`notHit` 都是**注入结果**上的断言。 */
interface Expectation {
  text: string
  /** 附件：只放真实字段（图片给名字与像素，文件给名字与字节数）。 */
  image?: { name: string; width?: number; height?: number; mediaType?: string }
  file?: { name: string; bytes?: number }
  /** 会话原生 todo（未完成项）的字面内容。 */
  todos?: string[]
  /** 工作台已选场景。 */
  selection?: boolean
  /** 必须判成这个阶段（缺省则不作阶段断言）。 */
  stage?: EnvironmentStage
  /** 必须判成这个输入来源。 */
  source?: string
  /** 这些条目必须出现在注入结果里。 */
  hit?: string[]
  /** 注入结果必须**恰好**是这些（顺序敏感）。 */
  exact?: string[]
  /** 这些条目必须完全不出现。 */
  notHit?: string[]
  /** 顺序断言：`[前, 后]` 表示前者的注入位置必须早于后者。 */
  before?: [string, string][]
  why: string
}

const EXPECTATIONS: Expectation[] = [
  // —— 主代理反例（2026-09-20 独立行为检查）：否定/只方案/裸附件/软件待办/CAD 压过附件名 ——
  {
    text: '不要停止，继续搭建这个庭院',
    todos: ['搭建庭院'],
    stage: 'continue',
    hit: ['environment-planning'],
    notHit: ['sim_stop', 'robot_stop', 'job_kill'],
    why: '否定式停止不算停止：有原生环境任务 + 「继续」时应判继续，而不是用关键词越权停止',
  },
  {
    text: '这张照片拍的是谁',
    image: { name: 'photo.png', mediaType: 'image/png' },
    stage: 'none',
    exact: [],
    why: '图像附件本身不授权环境建模：没有领域名词/动词时不得注入任何东西',
  },
  {
    text: '只给方案，先不要做场景',
    stage: 'plan-only',
    hit: ['environment-planning'],
    notHit: ['sim_stop', 'robot_stop', 'job_kill'],
    why: '"只给方案"是明确意图，必须优先于"先不要做"这类否定停止短语',
  },
  {
    text: '继续',
    todos: ['build web server'],
    stage: 'none',
    exact: [],
    why: '普通 build/create 待办不是环境任务：todo 依据只看领域名词（场景/图纸…），否则软件任务会被误判',
  },
  {
    text: '按照这张平面图生成房间',
    image: { name: 'photo.png', mediaType: 'image/png' },
    stage: 'new',
    source: 'cad',
    hit: ['environment-planning', 'cad-import'],
    why: '用户点名的图纸词压过附件名：名字无线索的图片不硬说成照片，读图契约要给到',
  },

  // —— 2026-09-20 真实回合复盘（root-agent-plan.log）：规划档的检索与资产路线 ——
  {
    text: '我要按照片复现一个带树木和石狮的庭院。现在只给前期计划，不要开始制作。',
    stage: 'plan-only',
    hit: ['environment-planning', 'photo-reconstruction', 'environment-research', 'asset-generation'],
    notHit: ['scene-construction'],
    why: '真实回合的坑：只查了一个目录（PolyHaven）没命中石狮就写"不可下载"，全程没读 environment-research/asset-generation。现实复现+多资产的任务，规划档必须给这两张卡，且泛 scene 关键词不得占用它们的名额（阶段提示有独立预算）',
  },
  {
    text: '先给方案，别动手，把房间怎么建说清楚',
    stage: 'plan-only',
    hit: ['environment-planning', 'scene-construction'],
    notHit: ['environment-research', 'asset-generation'],
    why: '不是现实复现、也没有资产线索的方案请求：不额外给检索/资产卡（避免每次环境档都刷满四行）',
  },

  // —— CAD 是"输入源"：必须活过补充截断 ——
  { text: '把这张户型图转成 CAD', hit: ['cad-import'], why: '图片→CAD 是最基本入口' },
  { text: '图片转cad', hit: ['cad-import'], why: '转换短语「图…转…cad」也要命中（无领域动词 → 走关键词补充）' },
  {
    text: '按这张施工图建个场景',
    stage: 'new',
    hit: ['environment-planning', 'cad-import'],
    why: '2026-09-18 修复的回归点：读图指针绝不能被场景/生成类挤掉，模型必须先读图再建场景',
  },
  { text: '把这张平面图转成 CAD 再进 Blender 建模', hit: ['cad-import', 'architectural-world'], why: 'CAD→Blender 全链的入口必须是读图' },
  { text: '这个 CAD 图纸的墙厚不对', stage: 'local', hit: ['cad-import'], why: '针对已导入图纸的追问也要带读图契约' },
  {
    text: '图纸导入后简单建个模型',
    hit: ['cad-import'],
    before: [['cad-import', 'asset-generation']],
    why: '图纸+建模：读图必须排在生成之前',
  },

  // —— Blender 是"建模执行面"：原先完全不可发现 ——
  { text: 'CAD 转 blender', hit: ['cad-import', 'architectural-world'], why: 'CAD→Blender 应同时给出输入源与执行面两张卡' },
  { text: '把 dxf 导入 Blender', hit: ['cad-import', 'architectural-world'], why: 'DXF 进 Blender 同上' },
  { text: 'blender MCP 连上了吗', hit: ['architectural-world'], why: '2026-09-18 前 Blender/MCP 无任何指针，完全不可发现' },
  { text: 'use blender mcp to build', hit: ['architectural-world'], why: '英文说法同样要能发现' },
  { text: '用 blender 按平面图建模', hit: ['cad-import', 'architectural-world'], why: 'Blender + 图纸' },

  // —— 图纸写法：floorplan 就是 floor plan 的合写（2026-09-20 修正旧预期）——
  { text: 'floorplan 转 3D', hit: ['cad-import'], why: 'floorplan 是图纸写法，必须被认作读图入口（旧的"纯 3D 反例"记错了对象）' },
  { text: 'floor plan 转 3D', hit: ['cad-import'], why: '带空格的 floor plan 同样是图纸' },
  {
    text: '把这张图做成 3D 模型',
    notHit: ['cad-import'],
    exact: [],
    why: '「图→3D」不是「图→CAD」：CAD 指针不得命中。此处所有指针都不命中是**已知边界**（「做成」不在生成域词表里），不是回归',
  },

  // —— 机器人/资产等既有域不得被环境路由抢走 ——
  { text: '生成一个箱子', stage: 'none', hit: ['asset-generation'], why: '资产生成域回归：裸"模型/模型件"不属环境域' },
  { text: '让机器人把箱子搬到桌子上', stage: 'none', hit: ['action-execution'], why: '动作任务回归：家具名词不构成环境证据' },
  { text: '建个房间', stage: 'new', hit: ['environment-planning', 'scene-construction'], why: '场景构造域回归：环境档先规划，再给构造技能' },
  { text: '打开素材面板', stage: 'none', hit: ['ui_action'], why: '界面自我控制域回归' },
  { text: '跑 libero 基准', stage: 'none', hit: ['benchmark-evaluation'], why: '评估环境域回归' },
  { text: '下载一个机器人', stage: 'none', hit: ['robot-provisioning'], why: '机器人准备域回归' },
  { text: '抓起来放到桌上', stage: 'none', hit: ['action-execution'], why: '动作执行域回归' },
  { text: '打开浏览器访问一个网页', stage: 'none', hit: ['desktop-automation'], why: '桌面与浏览器域回归' },
]

let cachedPointers: Pointer[] | undefined

/** 用**产品自己的判定函数**算真实注入结果（门禁与产品行为同源，不另抄一份模型）。 */
function plan(pointers: Pointer[], item: Expectation) {
  const content: unknown[] = [{ type: 'text', text: item.text }]
  if (item.image) content.push({ type: 'image', attachment: { attachmentId: 'att-gate', mediaType: item.image.mediaType ?? 'image/png', bytes: 100_000, width: item.image.width ?? 1024, height: item.image.height ?? 768, name: item.image.name } })
  if (item.file) content.push({ type: 'file', attachment: { attachmentId: 'att-gate', name: item.file.name, bytes: item.file.bytes ?? 1_000_000 } })
  const input: EnvironmentRoutingInput & { pointers: Pointer[] } = {
    pointers,
    messages: [createUserMessage({ content: content as never, source: { kind: 'user' } })],
    todos: item.todos ? item.todos.map(content => ({ content, status: 'in_progress' as const })) : [],
    ...(item.selection ? { selection: { sceneId: 'scene-gate' } } : {}),
    hasTool: () => true,
  }
  const planned = planDomainPointers(input)
  return {
    stage: planned?.decision.stage ?? 'none',
    source: planned?.decision.inputSource ?? 'none',
    injected: planned?.injected ?? [],
  }
}

export function runDomainPointerGate(source?: string): GateResult {
  const text = source ?? readFileSync(PLUGIN, 'utf8')
  const pointers = parsePointers(text)
  cachedPointers = pointers
  const checks: Check[] = []

  checks.push({
    name: '指针表可解析',
    ok: true,
    detail: `从 plugin.ts 解析出 ${pointers.length} 条域指针：${pointers.map(item => item.skill).join(' → ')}`,
  })

  // 顺序契约：输入源类必须在泛 3D 构造类之前，否则补充截断时会先丢输入源。
  // 判据是"**没有**泛 3D 构造类排在它后面"（若排在后面，说明输入源在前，顺序错）。
  const order = pointers.map(item => item.skill)
  const inputs = ['cad-import']
  const generic = ['scene-construction', 'asset-generation']
  for (const source of inputs) {
    const i = order.indexOf(source)
    const after = generic.filter(name => order.indexOf(name) >= 0 && order.indexOf(name) > i)
    checks.push({
      name: `顺序：${source} 先于泛 3D 构造`,
      ok: i >= 0 && after.length === generic.length,
      detail:
        i < 0
          ? `${source} 不在指针表里`
          : after.length === generic.length
            ? `${source} 排第 ${i + 1} 位，先于 ${generic.map(name => `${name}@${order.indexOf(name) + 1}`).join(', ')}`
            : `只有 [${after.join('/') || '（无）'}] 排在 ${source}（第 ${i + 1} 位）之后：${generic
                .filter(name => !after.includes(name))
                .join('/')} 排在它前面——补充截断时会先丢掉 ${source} 这个输入源`,
    })
  }

  for (const item of EXPECTATIONS) {
    const result = plan(pointers, item)
    const injected = result.injected
    const missing = (item.hit ?? []).filter(skill => !injected.includes(skill))
    const unexpected = (item.notHit ?? []).filter(skill => injected.includes(skill))
    const exactMismatch = item.exact && JSON.stringify(item.exact) !== JSON.stringify(injected) ? `注入应为 [${item.exact.join(', ') || '（无）'}]` : undefined
    const stageMismatch = item.stage && result.stage !== item.stage ? `阶段应为 ${item.stage}（实际 ${result.stage}）` : undefined
    const sourceMismatch = item.source && result.source !== item.source ? `输入来源应为 ${item.source}（实际 ${result.source}）` : undefined
    const orderViolation = (item.before ?? []).filter(([first, second]) => {
      const a = injected.indexOf(first)
      const b = injected.indexOf(second)
      return a >= 0 && b >= 0 && a > b
    }).map(([first, second]) => `${first} 应排在 ${second} 之前`)
    const problems = [stageMismatch, sourceMismatch, missing.length ? `缺少 ${missing.join('/')}` : undefined, unexpected.length ? `误注入 ${unexpected.join('/')}` : undefined, exactMismatch, ...orderViolation].filter(Boolean)
    const ok = problems.length === 0
    const keywords = hitSkills(pointers, item.text)
    checks.push({
      name: `「${item.text}」`,
      ok,
      detail: ok
        ? `阶段=${result.stage} 来源=${result.source} 注入 [${injected.join(', ') || '（无）'}]${keywords.length ? `（关键词命中 ${keywords.join('/')}）` : ''} — ${item.why}`
        : `${problems.join('；')}｜实际阶段=${result.stage} 来源=${result.source} 注入 [${injected.join(', ') || '（无）'}] — ${item.why}`,
    })
  }

  const failed = checks.filter(check => !check.ok)
  return {
    gate: 'domain-pointers',
    checks,
    blocked: failed.length ? `${failed.length}/${checks.length} 项不符：${failed.map(check => check.name).join('、')}` : null,
  }
}

/** 已解析的指针表（供同一进程内的其它消费者复用，避免重复解析源码）。 */
export function currentPointers(): Pointer[] {
  if (!cachedPointers) cachedPointers = parsePointers(readFileSync(PLUGIN, 'utf8'))
  return cachedPointers
}

/** 直接执行时打印结果并给退出码；被 import 时只导出（薄入口/replay 复用）。 */
if (import.meta.main) {
  let result: GateResult
  try {
    result = runDomainPointerGate()
  } catch (error) {
    console.error(`BLOCKED: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
  for (const check of result.checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}\n      ${check.detail}`)
  if (result.blocked) {
    console.error(`\n门禁未通过：${result.blocked}`)
    process.exit(1)
  }
  console.log(`\n全部 ${result.checks.length} 项通过（域指针 ${result.gate}）。`)
}
