/**
 * DEV-039 回归测试：WebGL 不可用时必须**明确说清**，不得静默留空座位。
 *
 * 完成条件（照抄台账）：
 *  - 无 WebGL 环境下打开场景 tab 有明确错误呈现
 *  - 有 WebGL 时零变化
 *  - 有回归测试
 *
 * 本文件覆盖前两条里**可在无浏览器环境验证**的部分：
 *  1. viewer 在 WebGL 上下文创建失败时抛**带 code 的类型错误**（而不是 three.js 原始异常）
 *  2. 该失败被翻译成**含可执行处置**的用户话术（处置来自 W14 环境契约的 WebGL 行）
 *  3. 非 WebGL 的渲染失败**不会**被误判成"环境缺能力"（正/负对照）
 *  4. 有 WebGL 时译文与失败判定都不介入
 *  5. **跨入口不打架**（2026-09-26 追加，验收 `VERIFY-ENV-READINESS-GPU-20260926.md` §3 的 C3）：
 *     浏览器侧不许断言"驱动坏了/该换机器"，宿主侧处置归 GPU 行 —— 旧文案里
 *     `③ …→ 更新/重装驱动` 与契约的「**不要**重装驱动」是同一个产品里互相打脸的两句话。
 *
 * 未覆盖（如实登记）：
 *  · 真实浏览器里"空座位被顶掉"的视觉结果需要真机/无头浏览器截图，本机没有可用 GL，留给 W11 的真机复测。
 *  · 契约的 `remedy.summary` 与 4 条步骤的**英文**译文（`WEBGL_REMEDY_SUMMARY_EN`/`WEBGL_REMEDY_STEPS_EN`）
 *    没有契约侧对照物（契约只有中文），本文件只钉"英文面不混中文"与"条数与中文一致"，不钉译文的语义等价。
 *  · 浏览器读不到宿主读数这件事本身（`/dev`、`/proc/driver`、`nvidia-smi`）无法在这里验证，
 *    它是浏览器的能力边界，只在本文件的边界声明里被引用。
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebGLUnavailableError } from '../../viewer/src/index.ts'
import { GPU_STATE_WORDING, classifyGpu, webglNotice, type GpuFacts, type GpuState } from '../src/environment-readiness.ts'
import {
  CARD_ACTION_STATES, DRIVER_ACTION_STATES, WEBGL_REMEDY_STEPS_EN, WEBGL_UNAVAILABLE_CODE, describeRenderFailure, isWebGLUnavailable,
} from '../src/render-failure.ts'

/** 与 workbench 的 tr 同形：中文在前、英文在后；测试里取中文便于断言。 */
const tr = (zh: string, _en: string) => zh

/** 用户真正看到的那一段（中文）。 */
const webglText = () => describeRenderFailure(new WebGLUnavailableError(new Error('no adapter')), tr)

/** 契约里某一态的**处置**正文（summary + steps）——边界声明的对照物。 */
const remedyText = (state: GpuState) => [GPU_STATE_WORDING[state].remedy.summary, ...GPU_STATE_WORDING[state].remedy.steps].join('\n')

/**
 * **合规**的写法只有两种：否定句（"不要…"）或**交接**句（把宿主侧处置交回 GPU 行，契约自己的写法）。
 * 两者都不是"叫用户去动驱动/换卡"。按句拆开，剩下的才是**正向**指令。
 */
const DEFERRED_OR_NEGATED = /不要|不得|先别|别先|见 GPU 行|GPU 行确证/
const positiveSentences = (text: string, pattern: RegExp) =>
  text.split(/[。；\n]/).filter(sentence => pattern.test(sentence) && !DEFERRED_OR_NEGATED.test(sentence))

/**
 * "动驱动"的**正向**写法：祈使/动作形态的动词紧挨着"驱动"这个宾语。
 * 三条不算（都是本产品里真实出现过的**非指令**句）：
 *  · `单独装 nvidia-smi…设备与驱动不受影响`（装的是工具，驱动只是被提到）
 *  · `宿主装了驱动但会话看不到 GPU`（`了` 是状态，不是叫你去装）
 *  · `驱动升级或换卡后：…复核`（讲的是升级**之后**做什么）
 */
const DRIVER_ACTION = /(?:装|修|升级|重装)(?![了过着完])[^，、。；：—()（）]{0,12}?驱动/
const CARD_ACTION = /加卡|用带 GPU 的机器|换机器|更换显卡/

/** 本机 2026-09-26 的真实形态（驱动已注册且已挂载、PCI 上有卡、只有 /dev 里没有设备节点）。 */
function gpuFacts(overrides: Partial<GpuFacts> = {}): GpuFacts {
  const DRIVER_LINE = 'NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  595.91.07  Release Build'
  return {
    probeError: null, driverVersion: DRIVER_LINE, driverGpuEntries: ['0000:02:00.0'], deviceNodes: ['/dev/nvidia0'], deviceExtras: [],
    pciDevices: ['0000:02:00.0'], pciIds: ['0000:02:00.0 10de:2c58 class=0x030000'], driverGpuModels: ['0000:02:00.0 NVIDIA GeForce RTX 5090 Laptop GPU'],
    smi: { present: true, ok: true, output: 'NVIDIA GeForce RTX 5090 Laptop GPU, 24463, 1024', error: '' },
    capacity: { totalMiB: 24463, freeMiB: 23439 }, requiredVramMiB: null, minDriverMajor: null,
    ...overrides,
  }
}

test('viewer：WebGL 创建失败抛带 code 的类型错误，并保留原始原因', () => {
  const error = new WebGLUnavailableError(new Error('Error creating WebGL context'))
  expect(error).toBeInstanceOf(Error)
  expect(error.name).toBe('WebGLUnavailableError')
  expect(error.code).toBe(WEBGL_UNAVAILABLE_CODE)
  expect(error.message).toContain(WEBGL_UNAVAILABLE_CODE)
  // 原始原因必须留在正文里：诊断时那是唯一能区分"没卡/驱动挂了/被禁"的线索。
  expect(error.message).toContain('Error creating WebGL context')
})

test('viewer：没有 cause 时也给出可识别的 code 与说明', () => {
  const error = new WebGLUnavailableError()
  expect(error.code).toBe(WEBGL_UNAVAILABLE_CODE)
  expect(error.message).toContain(WEBGL_UNAVAILABLE_CODE)
})

test('判定：类型错误 / 裸 code / 含 WebGL 的报文都算"环境缺能力"', () => {
  expect(isWebGLUnavailable(new WebGLUnavailableError())).toBe(true)
  expect(isWebGLUnavailable({ code: WEBGL_UNAVAILABLE_CODE })).toBe(true)
  expect(isWebGLUnavailable(new Error('VIEWER_WEBGL_UNAVAILABLE: x'))).toBe(true)
  expect(isWebGLUnavailable(new Error('WebGL context lost'))).toBe(true)
})

test('负对照：非 WebGL 的失败不得被误判成环境缺能力', () => {
  expect(isWebGLUnavailable(new Error('SCENE_READ_ONLY'))).toBe(false)
  expect(isWebGLUnavailable(new Error('resource 404'))).toBe(false)
  expect(isWebGLUnavailable(undefined)).toBe(false)
  expect(isWebGLUnavailable({ code: 'SOMETHING_ELSE' })).toBe(false)
})

test('话术：WebGL 失败的处置**逐字**来自环境契约的 WebGL 行（不再自己造四条原因）', () => {
  const notice = webglNotice({ status: 'broken', reading: 'WebGL 上下文创建失败：VIEWER_WEBGL_UNAVAILABLE（no adapter）', evidence: ['no adapter'] })
  const text = webglText()
  expect(text).toContain('3D 渲染不可用')
  expect(text).toContain('WebGL')
  expect(text).toContain('no adapter')
  // 关键承诺：世界仍在跑、停止仍可用 —— 不能让用户以为整个产品挂了（这一句是工作台自己才知道的）。
  expect(text).toContain('世界仍可运行')
  // 契约的稳定码：可 grep、可进回执。
  expect(notice.code).toBe('ENVIRONMENT_WEBGL_BROKEN')
  expect(text).toContain(notice.code)
  // 处置 = 契约的 summary + 每一条 step，**逐字**（契约才是处置的唯一 owner）。
  expect(text).toContain(notice.remedy.summary)
  expect(notice.remedy.steps.length).toBeGreaterThanOrEqual(4)
  for (const step of notice.remedy.steps) expect(text).toContain(step)
  // 契约自己给的宿主侧修复顺序（它才是"宿主侧归 GPU 行"那条交接）。
  expect(text).toContain('修复顺序：GPU 行 → 宿主 GL 行 → 本行')
  // 这一段是纯文本座位（workbench 的 `<p>{renderFailure}</p>`）：不许把契约里的 markdown 强调符带出来。
  expect(text).not.toContain('**')
})

test('① 负对照（C3）：与契约打脸的两句必须消失，且"重装驱动"只许以否定/条件句出现', () => {
  const text = webglText()
  // 旧文案里被验收点名的两句，按**原文**钉死：一句与「**不要**重装驱动」打脸，
  // 一句把"设备被会话隐藏"说成"换机器"（注意：新文案里"换卡/换机器"只出现在**否定句**里，
  // 所以这里钉的是旧句的原文与"有没有正向指令"，不是"这两个词出现过没有"）。
  expect(text).not.toContain('更新/重装驱动')
  expect(text).not.toContain('显卡不存在或被占用')
  expect(text).not.toContain('→ 换机器')
  // 边界声明必须在（**不是**一刀切把驱动整段删掉：宿主侧那三态仍要动驱动）。
  const mentions = text.split(/[；。]/).filter(sentence => sentence.includes('重装驱动'))
  expect(mentions.length).toBeGreaterThan(0)
  for (const sentence of mentions) expect(sentence).toMatch(/不要把|不要/)
  // 正向指令一条都不许有（"装/修/升级/重装…驱动"）。
  expect(positiveSentences(text, DRIVER_ACTION)).toEqual([])
  expect(positiveSentences(text, CARD_ACTION)).toEqual([])
})

test('跨入口不打架：边界声明点名的态 = 契约里**真的**允许动驱动/换卡的那些态', () => {
  const states = Object.keys(GPU_STATE_WORDING) as GpuState[]
  // 机械对照（不靠人记）：契约的处置正文里"正向允许动驱动"的态，必须正好是我们点名的那三个。
  const driverStates = states.filter(state => positiveSentences(remedyText(state), DRIVER_ACTION).length > 0).sort()
  expect(driverStates).toEqual([...DRIVER_ACTION_STATES].sort())
  // 同理："正向允许加卡/换机器"的态只有确实没有卡那一态。
  const cardStates = states.filter(state => positiveSentences(remedyText(state), CARD_ACTION).length > 0)
  expect(cardStates).toEqual([...CARD_ACTION_STATES])
  const text = webglText()
  expect(text).toContain(DRIVER_ACTION_STATES.join(' / '))
  expect(text).toContain(CARD_ACTION_STATES.join(' / '))
  // 契约里那句被 C3 引用的原文还在（本层的边界声明就是冲着它写的）。
  const hidden = gpuFacts({ deviceNodes: [], deviceExtras: [], smi: { present: true, ok: false, output: '', error: 'x' } })
  expect(classifyGpu(hidden).state).toBe('device-hidden')
  expect(classifyGpu(hidden).explanation.join('\n')).toContain('**不要**重装驱动、**不要**换卡')
})

test('② 接线守卫：render-failure 真的消费契约的 webglNotice（不是把文案抄一份）', () => {
  const source = readFileSync(join(import.meta.dirname, '../src/render-failure.ts'), 'utf8')
  expect(source).toMatch(/import \{[^}]*\bwebglNotice\b[^}]*\} from "\.\/environment-readiness\.ts"/)
  expect(source).toContain('webglNotice({ status: "broken"')
  // 英文译文与契约步骤**条数**一致：契约加一步而这里没补译文 ⇒ 红（语义等价无法机器判定，见文件头"未覆盖"）。
  expect(WEBGL_REMEDY_STEPS_EN.length).toBe(webglNotice({ status: 'broken', reading: 'x' }).remedy.steps.length)
})

test('英文面不许混中文：契约只有中文话术，英文座位必须自带译文', () => {
  // 这条是**实测过会犯**的错：`remedy.summary` 直接拼进英文句子 ⇒ 英文界面里露出中文。
  // 诊断原文（`Diagnostic text:` 之后）不在此列：那是引擎原样吐出来的字符串，中英都合法。
  const text = describeRenderFailure(new WebGLUnavailableError(new Error('no adapter')), (_zh, en) => en)
  const composed = text.slice(0, text.indexOf('Diagnostic text:'))
  expect(composed.length).toBeGreaterThan(0)
  expect(composed).not.toMatch(/[\u4e00-\u9fff]/)
  // 而中文面必须仍是逐字契约（英文面的存在不许把中文面挤掉）。
  const zh = describeRenderFailure(new WebGLUnavailableError(new Error('no adapter')), zh => zh)
  expect(zh).toContain(webglNotice({ status: 'broken', reading: 'x' }).remedy.summary)
})

test('话术：非 WebGL 失败走通用分支，不冒充环境缺能力', () => {
  const text = describeRenderFailure(new Error('SCENE_READ_ONLY'), tr)
  expect(text).toContain('3D 渲染初始化失败')
  expect(text).toContain('SCENE_READ_ONLY')
  expect(text).not.toContain('硬件加速')
})
