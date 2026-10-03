/**
 * 引擎选择入口的局部测试：`node script/engine-preference.test.ts`（也可 `bun run`）。
 * 退出码 0=全部通过，1=有失败。不起 Host、不联网；只有被 spawn 的子进程本身是被测对象。
 *
 * 测的是**真实差异**，不是复述源码：
 *  · `resolveEngine()` 的解析链：显式 > `LYAPUNOV_SIM_ENGINE`（含旧名）> 偏好文件 > `defaultEngine()`；
 *    偏好文件用**真实 owner** `writeEnginePreference` 写在临时路径（`LYAPUNOV_ENGINE_PREFERENCE_FILE`
 *    覆盖），绝不读用户 `~/.config/lyapunov/engine.json`；
 *  · **缺省/自动模式的三项条件**（本轮回执修订）：Isaac 只有在 SDK（安装候选命中**且**选定解释器
 *    能发现 `isaacsim`）、许可（留痕）与 GPU 加速器（`gpuRuntimeDecision`）**同时**具备时才被首选；
 *    缺任何一项都回退 MuJoCo 并给出逐条理由。SDK 用可控的假解释器目录 + 可执行桩模拟（空壳 venv、
 *    孤立 dist-info 都不算就绪），许可用真实 `recordEngineLicense` 写，GPU 用**合成事实**（不碰本机
 *    nvidia-smi）——这里只验证分支与理由，**不等于**真实 Isaac 能打开世界；
 *  · **显式 auto**：`writeEnginePreference('auto')` 清除偏好文件里的 `engine` 键（同一 owner），
 *    读回为"无显式偏好"→ 落回缺省判定；这是设置页从手动偏好回自动的持久化路径；
 *  · 显式 CLI/env/偏好**绝不被自动逻辑覆盖**（自动只发生在三层都没配置时），偏好在运行中变化也
 *    不改变已运行引擎的解析结果（换引擎必须重启 Host）;
 *  · 开发 YAML：省略 `engine` 不再填 `mujoco`、显式值仍是用户覆盖、Newton 现在可选、非法值仍被拒；
 *  · 进程级：`launch.ts`／`desktop.ts`／`architecture.ts` 在起任何 Host 之前就拒绝非法 `--engine`，
 *    `developer.ts --help` 列出的可选引擎与唯一 owner 一致。
 *
 * 边界：真实 Provider 装配（runtimePatch）与 WorldHandle.engineId 的读回在隔离运行里另验。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENGINE_CHOICES, defaultEngine, enginePreferenceFile, isaacRuntimeFacts, pinEnginePreferenceFile, readEnginePreference, recordEngineLicense, resolveEngine, writeEnginePreference } from './engine-preference.ts'
import { clearSdkImportCache, gpuRuntimeDecision, probeSdkImport, sdkInstalled, sitePackagesCandidates, type GpuFacts } from '../packages/lyapunov-shell/src/environment-readiness.ts'
import { loadDeveloperConfig } from './developer-config.ts'

const HERE = import.meta.dirname
const checks: Array<{ name: string; ok: boolean; detail: string }> = []
const check = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }) }
const throws = (run: () => unknown): string => { try { run(); return '' } catch (error) { return error instanceof Error ? error.message : String(error) } }
/** 异步版：`loadDeveloperConfig` 返回 Promise，同步 try/catch 抓不到它的拒绝。 */
const rejects = async (run: () => Promise<unknown>): Promise<string> => { try { await run(); return '' } catch (error) { return error instanceof Error ? error.message : String(error) } }

const directory = mkdtempSync(join(tmpdir(), 'engine-resolve-'))
const preferenceFile = join(directory, 'engine.json')
const productRoot = join(directory, 'product')
const EULA = 'https://example.invalid/nvidia-omniverse-eula'
/**
 * 每个用例都用这份环境：偏好文件钉到临时路径，Isaac/Newton/MuJoCo 解释器钉到临时目录，
 * 不读用户主目录、不看本机真实 SDK。传 `undefined` 表示**显式清空**该键。
 */
const env = (values: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const merged: NodeJS.ProcessEnv = {
    ...values,
    LYAPUNOV_ENGINE_PREFERENCE_FILE: values.LYAPUNOV_ENGINE_PREFERENCE_FILE ?? preferenceFile,
    LYAPUNOV_ISAAC_PYTHON: values.LYAPUNOV_ISAAC_PYTHON ?? join(directory, 'isaac-missing/bin/python'),
    LYAPUNOV_NEWTON_PYTHON: values.LYAPUNOV_NEWTON_PYTHON ?? join(directory, 'newton-missing/bin/python'),
    LYAPUNOV_MUJOCO_PYTHON: values.LYAPUNOV_MUJOCO_PYTHON ?? join(directory, 'mujoco-missing/bin/python'),
  }
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key]
  return merged
}
/** 可执行的假解释器：`probeSdkImport` 会调用它，桩原样报告"能发现模块"。 */
const stubPython = (path: string): void => {
  writeFileSync(path, '#!/bin/sh\necho SDK_PROBE_FOUND\nexit 0\n', { mode: 0o755 })
  chmodSync(path, 0o755)
}
/** 装到 `site-packages/<包名>` 的假解释器：安装候选看的是这个目录（不是解释器本身），
 * 解释器发现核对走可执行桩（`importlib.util.find_spec` 的替身）。 */
const fakeRuntime = (name: string, marker: string): string => {
  const root = join(directory, name)
  mkdirSync(join(root, 'bin'), { recursive: true })
  mkdirSync(join(root, 'lib/python3.12/site-packages', marker), { recursive: true })
  stubPython(join(root, 'bin/python'))
  return join(root, 'bin/python')
}
/** 只留一个孤立 `*.dist-info` 的前缀（包目录被清理过）：安装候选判据必须拒绝它。 */
const orphanDistInfo = (name: string, marker: string): string => {
  const root = join(directory, name)
  mkdirSync(join(root, 'bin'), { recursive: true })
  mkdirSync(join(root, 'lib/python3.12/site-packages', `${marker}-6.0.1.0.dist-info`), { recursive: true })
  stubPython(join(root, 'bin/python'))
  return join(root, 'bin/python')
}
const readyIsaac = fakeRuntime('isaac-ready', 'isaacsim')
const orphanIsaac = orphanDistInfo('isaac-orphan-dist-info', 'isaacsim')
const shellOnlyIsaac = join(directory, 'isaac-shell-only')
mkdirSync(join(shellOnlyIsaac, 'bin'), { recursive: true })
writeFileSync(join(shellOnlyIsaac, 'bin/python'), '')
const readyMujoco = fakeRuntime('mujoco-ready', 'mujoco')
/** 合成 GPU 事实：这里测的是判定与理由，不碰本机 nvidia-smi（真实读数另走验收）。 */
const SMI_OK = 'NVIDIA GeForce RTX 5090 Laptop GPU, 24463, 1024'
const SMI_FAIL = 'NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.'
const gpuFacts = (overrides: Partial<GpuFacts> = {}): GpuFacts => ({
  probeError: null,
  driverVersion: 'NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  595.91.07  Release Build',
  driverGpuEntries: ['0000:02:00.0'], deviceNodes: ['/dev/nvidia0'], deviceExtras: [],
  pciDevices: ['0000:02:00.0'], pciIds: ['0000:02:00.0 10de:2c58 class=0x030000'], driverGpuModels: [],
  smi: { present: true, ok: true, output: SMI_OK, error: '' },
  capacity: { totalMiB: 24463, freeMiB: 23439 }, requiredVramMiB: null, minDriverMajor: null,
  ...overrides,
})
const GPU_READY = gpuRuntimeDecision(gpuFacts())
/** 本机真实形态：卡与驱动都好，只是本会话看不见设备——不能算"GPU 条件具备"。 */
const GPU_HIDDEN = gpuRuntimeDecision(gpuFacts({ deviceNodes: [], capacity: null, smi: { present: true, ok: false, output: SMI_FAIL, error: '' } }))
const GPU_UNKNOWN = gpuRuntimeDecision(gpuFacts({ probeError: 'readdirSync /proc/driver: EACCES' }))
/** 三项条件都具备时的自动事实（测试注入；产品路径不传）。 */
const isaacAllReady = { isaacRuntime: true, isaacLicense: true, gpu: GPU_READY }

try {
  // ── 1. 缺省/自动模式：SDK + 许可 + GPU 三项同时具备 → isaac；缺任何一项 → mujoco + 明确理由 ──────
  recordEngineLicense('isaac', true, EULA, env())                 // 许可留痕（真实 owner）
  const licenseFile = readFileSync(preferenceFile, 'utf8')
  check('许可留痕写进同偏好文件（单一 owner）', JSON.parse(licenseFile).licenses?.isaac?.eulaUrl === EULA, licenseFile)

  // 这里 **不注入 isaacRuntime**：让 SDK 就绪判据走真实文件探测（`site-packages/isaacsim`）。
  const allReady = resolveEngine({ productRoot, env: env({ LYAPUNOV_ISAAC_PYTHON: readyIsaac, LYAPUNOV_MUJOCO_PYTHON: readyMujoco }), auto: { isaacLicense: true, gpu: GPU_READY } })
  check('SDK+许可+GPU 都具备时默认选 isaac', allReady.engine === 'isaac' && allReady.source === 'default', JSON.stringify(allReady))
  check('isaac 的理由里点名三项事实', allReady.reason.includes('运行时就位') && allReady.reason.includes('许可已接受') && allReady.reason.includes('GPU'), allReady.reason)

  // SDK 缺失（解释器在但 isaacsim 没装入 = 空壳 venv，单独一条）。
  const sdkShellOnly = resolveEngine({ productRoot, env: env({ LYAPUNOV_ISAAC_PYTHON: shellOnlyIsaac, LYAPUNOV_MUJOCO_PYTHON: readyMujoco }), auto: { ...isaacAllReady, isaacRuntime: false } })
  check('Isaac 只有空壳 venv 时回退 mujoco', sdkShellOnly.engine === 'mujoco' && sdkShellOnly.source === 'default', JSON.stringify(sdkShellOnly))
  check('真判据（不是靠注入）：空壳 venv 的 isaacRuntimeAvailable=false', defaultEngine(productRoot, env({ LYAPUNOV_ISAAC_PYTHON: shellOnlyIsaac, LYAPUNOV_MUJOCO_PYTHON: readyMujoco }), { isaacLicense: true, gpu: GPU_READY }).engine === 'mujoco', 'shell-only 被误判成就绪')
  const missing = resolveEngine({ productRoot, env: env({ LYAPUNOV_MUJOCO_PYTHON: readyMujoco }), auto: { ...isaacAllReady, isaacRuntime: false } })
  check('Isaac 解释器不存在时同样回退 mujoco', missing.engine === 'mujoco' && missing.source === 'default', JSON.stringify(missing))
  check('回退理由写进 reason（可直接打印，不静默换引擎）', missing.reason.includes('回退 mujoco') && missing.reason.includes('Isaac 运行时未就绪'), missing.reason)

  // GPU 缺失：设备被本会话隐藏 / 读数未知，都不算"GPU 条件具备"。
  const gpuHidden = resolveEngine({ productRoot, env: env({ LYAPUNOV_ISAAC_PYTHON: readyIsaac, LYAPUNOV_MUJOCO_PYTHON: readyMujoco }), auto: { isaacRuntime: true, isaacLicense: true, gpu: GPU_HIDDEN } })
  check('GPU 被会话隐藏时回退 mujoco 且理由点名 GPU', gpuHidden.engine === 'mujoco' && gpuHidden.reason.includes('GPU 未确认可用'), JSON.stringify(gpuHidden.engine) + ' ' + gpuHidden.reason)
  const gpuUnknown = resolveEngine({ productRoot, env: env({ LYAPUNOV_ISAAC_PYTHON: readyIsaac, LYAPUNOV_MUJOCO_PYTHON: readyMujoco }), auto: { isaacRuntime: true, isaacLicense: true, gpu: GPU_UNKNOWN } })
  check('GPU 读数未知 ≠ 可用（不猜就绪）', gpuUnknown.engine === 'mujoco' && gpuUnknown.reason.includes('GPU 未确认可用'), JSON.stringify(gpuUnknown.engine))

  // 许可缺失：即使 SDK 与 GPU 都好，也回退并说明怎么补。
  const noLicense = resolveEngine({ productRoot, env: env({ LYAPUNOV_ISAAC_PYTHON: readyIsaac, LYAPUNOV_MUJOCO_PYTHON: readyMujoco }), auto: { isaacRuntime: true, isaacLicense: false, gpu: GPU_READY } })
  check('许可未接受时回退 mujoco 且理由给出补法', noLicense.engine === 'mujoco' && noLicense.reason.includes('许可未接受') && noLicense.reason.includes('accept-omniverse-eula'), noLicense.reason)

  // MuJoCo 可用 / 也缺失：两条都回退 mujoco，但理由必须如实区分。
  const mujocoReady = resolveEngine({ productRoot, env: env({ LYAPUNOV_ISAAC_PYTHON: shellOnlyIsaac, LYAPUNOV_MUJOCO_PYTHON: readyMujoco }), auto: { ...isaacAllReady, isaacRuntime: false } })
  check('MuJoCo 就绪时回退理由说 MuJoCo 就绪', mujocoReady.engine === 'mujoco' && mujocoReady.reason.includes('MuJoCo 就绪'), mujocoReady.reason)
  const mujocoMissing = resolveEngine({ productRoot, env: env({ LYAPUNOV_ISAAC_PYTHON: shellOnlyIsaac }), auto: { ...isaacAllReady, isaacRuntime: false } })
  check('MuJoCo 也缺失时如实说"也未就绪"（仍选 mujoco，界面可启动）', mujocoMissing.engine === 'mujoco' && mujocoMissing.reason.includes('MuJoCo 也未就绪'), mujocoMissing.reason)

  // 候选清单：自动判定必须把两格候选的逐条判据给出来，面板据此显示"为什么不是 Isaac"。
  const candidates = defaultEngine(productRoot, env({ LYAPUNOV_ISAAC_PYTHON: shellOnlyIsaac, LYAPUNOV_MUJOCO_PYTHON: readyMujoco }), { isaacLicense: true, gpu: GPU_HIDDEN })
  const isaacCandidate = candidates.candidates.find(row => row.engine === 'isaac')!
  const mujocoCandidate = candidates.candidates.find(row => row.engine === 'mujoco')!
  check('候选清单形状：isaac 未就绪 + mujoco 就绪', isaacCandidate.ready === false && isaacCandidate.blockers.length >= 1 && mujocoCandidate.ready === true, JSON.stringify(candidates.candidates))
  // 复核点 5：候选 ready 必须带**检测范围**，不能把 accelerator=available 说成完整 RTX 就绪。
  check('isaac 候选带检测范围（不冒充 RTX/世界验收）', typeof isaacCandidate.scope === 'string' && isaacCandidate.scope.includes('RTX') && isaacCandidate.scope.includes('检测范围'), String(isaacCandidate.scope))

  // ── 1b. 复核点 4：安装候选与解释器发现核对分开，孤立 dist-info 不算，探测有缓存 ──────────────
  const orphanFacts = isaacRuntimeFacts(productRoot, env({ LYAPUNOV_ISAAC_PYTHON: orphanIsaac }))
  check('孤立 dist-info 不算安装候选（更不算就绪）', orphanFacts.installCandidate === false && orphanFacts.available === false, JSON.stringify(orphanFacts))
  check('sdkInstalled 直接拒绝孤立 dist-info', sdkInstalled(sitePackagesCandidates(orphanIsaac), 'isaacsim') === false, String(sdkInstalled(sitePackagesCandidates(orphanIsaac), 'isaacsim')))
  const readyFacts = isaacRuntimeFacts(productRoot, env({ LYAPUNOV_ISAAC_PYTHON: readyIsaac }))
  check('安装候选命中 + 解释器发现成功 = 就绪，且两格分别可读', readyFacts.installCandidate === true && readyFacts.importProbe.state === 'importable' && readyFacts.available === true, JSON.stringify(readyFacts))
  check('空壳解释器（发现核对跑不起来）保守判不可用并带诊断', isaacRuntimeFacts(productRoot, env({ LYAPUNOV_ISAAC_PYTHON: shellOnlyIsaac })).available === false, JSON.stringify(isaacRuntimeFacts(productRoot, env({ LYAPUNOV_ISAAC_PYTHON: shellOnlyIsaac }))))
  clearSdkImportCache()
  const probeAgain = probeSdkImport(readyIsaac, 'isaacsim')
  check('轻量发现探测可重复调用且结果稳定（产品路径按缓存复用）', probeAgain.state === 'importable', JSON.stringify(probeAgain))

  // ── 1c. 复核点 3：显式"自动"清除手动偏好并可读回 ─────────────────────────────
  writeEnginePreference('mujoco', env())
  check('手动选择 mujoco 可持久化读回', readEnginePreference(env()) === 'mujoco', String(readEnginePreference(env())))
  writeEnginePreference('auto', env())
  check('选择 auto 清除显式偏好（同一 owner 文件仍保留许可等其它键）', readEnginePreference(env()) === undefined && JSON.parse(readFileSync(preferenceFile, 'utf8')).licenses?.isaac?.eulaUrl === EULA, readFileSync(preferenceFile, 'utf8'))
  const backToAuto = resolveEngine({ productRoot, env: env({ LYAPUNOV_ISAAC_PYTHON: readyIsaac, LYAPUNOV_MUJOCO_PYTHON: readyMujoco }), auto: isaacAllReady })
  check('从手动 mujoco 回到自动后按默认判定（条件满足→isaac，source=default）', backToAuto.engine === 'isaac' && backToAuto.source === 'default', JSON.stringify(backToAuto))

  // ── 2. 显式 > 环境 > 偏好：自动判定只在三层都没配置时发生 ────────────────────
  for (const choice of ENGINE_CHOICES) {
    const explicit = resolveEngine({ explicit: choice, productRoot, env: env({ LYAPUNOV_SIM_ENGINE: 'mujoco' }), auto: isaacAllReady })
    check(`显式 ${choice} 保持显式选择`, explicit.engine === choice && explicit.source === 'explicit', JSON.stringify(explicit))
  }
  // 显式 isaac 即使自动条件全不满足也不能被换成 mujoco（不偷偷换引擎）。
  const explicitIsaac = resolveEngine({ explicit: 'isaac', productRoot, env: env(), auto: { isaacRuntime: false, isaacLicense: false, gpu: GPU_HIDDEN, mujocoRuntime: true } })
  check('显式 isaac 不被自动逻辑换成 mujoco', explicitIsaac.engine === 'isaac' && explicitIsaac.source === 'explicit', JSON.stringify(explicitIsaac))

  writeEnginePreference('isaac', env())
  const fromPreference = resolveEngine({ productRoot, env: env(), auto: { isaacRuntime: false, isaacLicense: false, gpu: GPU_HIDDEN, mujocoRuntime: true } })
  check('无显式无环境时用用户偏好', fromPreference.engine === 'isaac' && fromPreference.source === 'preference', JSON.stringify(fromPreference))
  check('偏好也是用户显式选择：不因自动条件不满足被换掉', fromPreference.engine === 'isaac', JSON.stringify(fromPreference))

  const environmentWins = resolveEngine({ productRoot, env: env({ LYAPUNOV_SIM_ENGINE: 'newton' }), auto: isaacAllReady })
  check('LYAPUNOV_SIM_ENGINE 压过偏好', environmentWins.engine === 'newton' && environmentWins.source === 'environment', JSON.stringify(environmentWins))

  const legacyName = resolveEngine({ productRoot, env: env({ LYAUP_SIM_ENGINE: 'mujoco' }) })
  check('旧名 LYAUP_SIM_ENGINE 沿用既有兼容读取', legacyName.engine === 'mujoco' && legacyName.source === 'environment', JSON.stringify(legacyName))

  const explicitWins = resolveEngine({ explicit: 'none', productRoot, env: env({ LYAPUNOV_SIM_ENGINE: 'newton' }), auto: isaacAllReady })
  check('显式压过环境与偏好', explicitWins.engine === 'none' && explicitWins.source === 'explicit', JSON.stringify(explicitWins))

  // ── 3. 非法值一律拒绝，不伪装成默认选择 ────────────────────────────────────
  const badExplicit = throws(() => resolveEngine({ explicit: 'triton', productRoot, env: env() }))
  check('非法显式值被拒并列出可选值', badExplicit.includes('未知 Provider：triton') && badExplicit.includes(ENGINE_CHOICES.join('/')), badExplicit || '未抛错')
  const badEnvironment = throws(() => resolveEngine({ productRoot, env: env({ LYAPUNOV_SIM_ENGINE: 'triton' }) }))
  check('非法环境变量被拒', badEnvironment.includes('未知 Provider：triton'), badEnvironment || '未抛错')
  // 空/空白的环境变量＝没配（旧入口用 `||` 跳过它），不能反过来把启动卡在"未知 Provider"。
  const emptyEnvironment = resolveEngine({ productRoot, env: env({ LYAPUNOV_SIM_ENGINE: '' }) })
  check('空环境变量视为未配置，落到偏好', emptyEnvironment.engine === 'isaac' && emptyEnvironment.source === 'preference', JSON.stringify(emptyEnvironment))
  const blankEnvironment = resolveEngine({ productRoot, env: env({ LYAPUNOV_SIM_ENGINE: '   ' }) })
  check('空白环境变量同样视为未配置', blankEnvironment.engine === 'isaac' && blankEnvironment.source === 'preference', JSON.stringify(blankEnvironment))

  // 偏好文件坏了不猜测：回代码默认，且**不能**把它当成"用户选了某个引擎"。
  writeFileSync(preferenceFile, '{ 这不是 JSON')
  const brokenPreference = resolveEngine({ productRoot, env: env({ LYAPUNOV_ISAAC_PYTHON: readyIsaac }), auto: isaacAllReady })
  check('偏好文件非法时回默认且来源标 default', brokenPreference.engine === 'isaac' && brokenPreference.source === 'default', JSON.stringify(brokenPreference))
  rmSync(preferenceFile, { force: true })

  // ── 4. 开发者 YAML：省略＝跟随默认，显式＝用户覆盖 ────────────────────────
  const yaml = (text: string, name: string): string => { const file = join(directory, name); writeFileSync(file, text); return file }
  const omitted = await loadDeveloperConfig(yaml('mode: developer\nsurface: web\ngrasp: analytic\n', 'omitted.yaml'))
  check('YAML 省略 engine 时不再填入 mujoco', omitted.engine === undefined, `engine=${String(omitted.engine)}`)
  const explicitMujoco = await loadDeveloperConfig(yaml('mode: developer\nengine: mujoco\n', 'mujoco.yaml'))
  check('YAML 显式 engine 仍是用户覆盖', explicitMujoco.engine === 'mujoco', String(explicitMujoco.engine))
  const newton = await loadDeveloperConfig(yaml('mode: developer\nengine: newton\n', 'newton.yaml'))
  check('开发者 YAML 现在接受 Newton', newton.engine === 'newton', String(newton.engine))
  const badYaml = await rejects(() => loadDeveloperConfig(yaml('mode: developer\nengine: triton\n', 'bad.yaml')))
  check('YAML 非法 engine 被拒', badYaml.includes('engine 无效：triton'), badYaml || '未抛错')

  // ── 5. 进程级：入口在起 Host 之前就拒绝非法引擎 ────────────────────────────
  const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}): { status: number | null; stderr: string; stdout: string } => {
    // 用**跑本文件的那个解释器**（`process.execPath`）起子进程，不按名字 spawn `'node'`：
    // 这里要的只是"一个进程"，被测对象是入口脚本**在起 Host 前拒绝非法 --engine**，与解释器是谁无关。
    // 按名字起 ⇒ 这 9 条进程级用例依赖调用方 PATH（CI 镜像没有 node 时全红），而本文件 :171
    // 与 `terminal-options.test.ts:110/113/116` 用的都是 `process.execPath`。
    const result = spawnSync(process.execPath, args, { cwd: join(HERE, '..'), encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env(), ...extraEnv } })
    return { status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' }
  }
  // desktop.ts 只做参数校验后把值转成环境变量，所以它用入口自己的措辞；另两个走到共享解析。
  for (const [entry, expected] of [['script/launch.ts', '未知 Provider：triton'], ['script/desktop.ts', '--engine 只接受'], ['script/architecture.ts', '未知 Provider：triton']] as Array<[string, string]>) {
    const args = entry === 'script/launch.ts' ? [entry, '--mode', 'developer', '--engine', 'triton'] : [entry, '--engine', 'triton']
    const bad = run(args)
    check(`${entry} 拒绝非法 --engine 且不启动 Host`, bad.status === 1 && bad.stderr.includes(expected), `status=${bad.status} stderr=${bad.stderr.trim().slice(0, 200)}`)
  }
  const developerHelp = run(['script/developer.ts', '--help'])
  check('developer --help 列出与唯一 owner 一致的可选引擎', developerHelp.status === 0 && developerHelp.stdout.includes(ENGINE_CHOICES.join('|')), developerHelp.stdout.trim().slice(0, 300))

  // 偏好文件里的引擎在没有更高优先级覆盖时被启动器采用（launch 会把它解析成实际装配值）。
  writeEnginePreference('none', env())
  const preferNone = run(['script/launch.ts', '--mode', 'developer', '--engine', 'triton'])
  check('非法显式值不会被偏好悄悄兜住', preferNone.status === 1 && preferNone.stderr.includes('未知 Provider：triton'), `status=${preferNone.status}`)

  // ── 5′. 真实优先级：CLI --engine（以及 developer YAML 转发的 --engine）压过环境变量 ──────
  // 独立复核实测：真实链路是 CLI > YAML > LYAPUNOV_SIM_ENGINE > 用户偏好 > 默认（YAML 的 engine
  // 与 CLI 一样走 explicit 通道）。这里用**非法环境变量**做判别条件，避免"两边都合法所以看不出谁赢"：
  //   · 显式获胜 ⇒ 环境那一层根本没被读，报错来自后面的 grasp 校验（消息无值）；
  //   · 环境获胜 ⇒ 解析期就抛 "未知 Provider：triton"。
  const explicitBeatsEnv = run(['script/launch.ts', '--mode', 'developer', '--surface', 'web', '--engine', 'newton', '--grasp', 'bogus', '--runtime-root', join(directory, 'prio-explicit')], { LYAPUNOV_SIM_ENGINE: 'triton' })
  check('显式 --engine 压过（非法）环境变量：环境那一层不被读取', explicitBeatsEnv.status === 1 && explicitBeatsEnv.stderr.includes('未知 Provider') && !explicitBeatsEnv.stderr.includes('triton'), `status=${explicitBeatsEnv.status} stderr=${explicitBeatsEnv.stderr.trim().slice(0, 200)}`)
  const envOnly = run(['script/launch.ts', '--mode', 'developer', '--surface', 'web', '--grasp', 'bogus', '--runtime-root', join(directory, 'prio-env')], { LYAPUNOV_SIM_ENGINE: 'triton' })
  check('没有显式值时环境变量才被读取（同一个非法值此时才报错）', envOnly.status === 1 && envOnly.stderr.includes('未知 Provider：triton'), `status=${envOnly.status}`)

  // ── 6. 偏好文件钉进子进程环境：隔离 Host 换了 HOME 之后必须仍读**同一个文件** ──────
  //
  // 为什么单独测：正式/隔离 Host 的 HOME 被 `profile.ts:backendEnvironment()` 换成
  // `<运行根>/private`，而 `enginePreferenceFile()` 用 `os.homedir()` 展开 `~`。
  // 不钉 ⇒ 启动器读 A、Host（界面里的引擎切换与偏好读回）读写 B：
  //   界面里"切换引擎→重启生效"写进 B，下次启动却仍按 A 解析（真机复现见
  //   `bugfixHistory/ENGINE-ENTRY-CONSISTENCY-20260926.md` 的 F1），且读回值 B ≠ 实际采用值。
  // 这里真跑一个子进程，让它在**被换过 HOME 的**环境里解析落点：负例（不钉）必须能观察到分裂，
  // 正例（钉过）必须与启动器落点逐字相同。
  const isolatedHome = join(directory, 'private-host-home')
  mkdirSync(isolatedHome, { recursive: true })
  writeEnginePreference('mujoco', env())
  const launcherPreferenceFile = enginePreferenceFile(env())
  const launcherSelection = resolveEngine({ productRoot, env: env() })
  check('启动器侧：临时偏好文件被解析为 preference', launcherSelection.engine === 'mujoco' && launcherSelection.source === 'preference', JSON.stringify(launcherSelection))

  // 子进程：只带隔离 Host 真正会拿到的那几个键（正式模式的白名单里没有偏好文件覆盖键）。
  const hostEnv = (): NodeJS.ProcessEnv => {
    const values: NodeJS.ProcessEnv = { ...process.env, HOME: isolatedHome, XDG_CONFIG_HOME: join(isolatedHome, 'config'), LYAPUNOV_ENGINE_PREFERENCE_FILE: undefined }
    for (const [key, value] of Object.entries(values)) if (value === undefined) delete values[key]
    return values
  }
  const childFile = join(directory, 'child-resolve.ts')
  writeFileSync(childFile, `import {enginePreferenceFile,readEnginePreference} from ${JSON.stringify(join(HERE, 'engine-preference.ts'))}\nconsole.log(JSON.stringify({file:enginePreferenceFile(),value:readEnginePreference()??null}))\n`)
  const childResolve = (childEnv: NodeJS.ProcessEnv): { file: string; value: string | null } => {
    const result = spawnSync(process.execPath, [childFile], { encoding: 'utf8', env: childEnv, timeout: 30000 })
    if (result.status !== 0) return { file: `<子进程失败 status=${String(result.status)} ${(result.stderr ?? '').slice(-200)}>`, value: null }
    return JSON.parse(result.stdout.trim()) as { file: string; value: string | null }
  }

  const unpinned = childResolve(hostEnv())
  check('负例：不钉时隔离 Host 落在另一个偏好文件上（分裂可观察）', unpinned.file !== launcherPreferenceFile && unpinned.value === null, JSON.stringify({ host: unpinned, launcher: launcherPreferenceFile }))

  const pinnedEnv = hostEnv()
  const pinnedFile = pinEnginePreferenceFile(pinnedEnv, env())
  const pinned = childResolve(pinnedEnv)
  check('正例：钉过之后隔离 Host 与启动器读同一个文件', pinned.file === launcherPreferenceFile && pinnedFile === launcherPreferenceFile, JSON.stringify({ host: pinned.file, launcher: launcherPreferenceFile }))
  check('正例：隔离 Host 读回的值 == 启动器实际采用的值', pinned.value === launcherSelection.engine, JSON.stringify({ readBack: pinned.value, used: launcherSelection.engine }))

  // 调用点（launch.ts 自己造 env；host.ts 是 arch/desktop/administrator/terminal 的共享点）：
  // 只防"钉子被静默删掉"，**不替代**真机 formal Host 读数（那一步在本轮回执里另给）。
  for (const caller of ['launch.ts', 'host.ts'] as const) {
    const source = readFileSync(join(HERE, caller), 'utf8')
    check(`${caller} 仍在起 Host 前钉住偏好文件落点`, source.includes('pinEnginePreferenceFile('), `${caller} 里找不到 pinEnginePreferenceFile(`)
  }

  // ── 7. 开发者入口的 CLI --engine：CLI > YAML，取值仍交唯一 owner 校验 ─────────
  const cliYaml = yaml(['mode: developer', 'surface: web', 'grasp: analytic', 'port: 0', `runtime_root: ${JSON.stringify(join(directory, 'dev-runtime'))}`, 'auth:', '  required: false', 'engine: newton'].join('\n') + '\n', 'dev-cli.yaml')
  const developerCliHelp = run(['script/developer.ts', '--help'])
  check('developer --help 现在声明 CLI --engine', developerCliHelp.status === 0 && developerCliHelp.stdout.includes('--engine'), developerCliHelp.stdout.trim().slice(0, 300))
  // YAML 给了合法 engine: newton，CLI 给非法 triton：若 CLI 未生效就不会报错。
  const developerCliWins = run(['script/developer.ts', '--config', cliYaml, '--engine', 'triton'])
  check('developer CLI --engine 压过 YAML 且非法值仍由唯一 owner 拒绝', developerCliWins.status === 1 && developerCliWins.stderr.includes('未知 Provider：triton'), `status=${developerCliWins.status} stderr=${developerCliWins.stderr.trim().slice(0, 200)}`)

  // ── 8. 运行中的世界不因后台偏好变化被切换（换引擎必须重启 Host） ──────────────
  // 已运行的 Host 把 `LYAPUNOV_SIM_ENGINE=<实际装配值>` 写进进程环境；偏好文件是"下次启动"的输入。
  // 后台改偏好后，**本次运行**的解析结果必须逐字不变；只有清掉环境变量后才体现新偏好。
  const runningBefore = resolveEngine({ productRoot, env: env({ LYAPUNOV_SIM_ENGINE: 'mujoco' }) })
  writeEnginePreference('isaac', env())
  const runningAfter = resolveEngine({ productRoot, env: env({ LYAPUNOV_SIM_ENGINE: 'mujoco' }) })
  check('后台改偏好不改变本次运行引擎（运行中的世界不被切换）', runningAfter.engine === 'mujoco' && runningAfter.source === 'environment' && runningAfter.reason === runningBefore.reason, JSON.stringify({ before: runningBefore, after: runningAfter }))
  const nextStart = resolveEngine({ productRoot, env: env({ LYAPUNOV_ISAAC_PYTHON: readyIsaac, LYAPUNOV_MUJOCO_PYTHON: readyMujoco }), auto: isaacAllReady })
  check('新偏好在下次启动才生效（来源标 preference）', nextStart.engine === 'isaac' && nextStart.source === 'preference', JSON.stringify(nextStart))
} finally {
  rmSync(directory, { recursive: true, force: true })
}

const failed = checks.filter(item => !item.ok)
for (const item of checks) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.ok ? '' : ' — ' + item.detail}`)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length) {
  console.log('\n失败明细：')
  for (const item of failed) console.log(`· ${item.name} — ${item.detail}`)
}
process.exit(failed.length ? 1 : 0)
