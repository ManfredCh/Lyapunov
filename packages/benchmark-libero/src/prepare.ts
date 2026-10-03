import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { delimiter, join, resolve } from 'node:path'
import type { BenchmarkUnavailable } from '../../benchmark-contract/src/index.ts'
import { resolveMuJoCoGlBackend } from '../../sim-contract/src/mujoco-gl.ts'

export interface PrepareReady {
  status: 'READY'
  pythonPath: string
  isolatedRoot: string
  configDir: string
}

export type PrepareResult = PrepareReady | (BenchmarkUnavailable & { pythonPath: string; isolatedRoot: string })

export function isolatedConfigDir(isolatedRoot: string) {
  return resolve(isolatedRoot, 'libero-config')
}

export function isolatedSourceRoot(isolatedRoot: string) {
  return resolve(isolatedRoot, 'libero-source/libero/libero')
}

/** 官方键名；写到隔离目录，避免 ~/.libero 首次导入走 input()。 */
export function writeIsolatedLiberoConfig(isolatedRoot: string) {
  const root = resolve(isolatedRoot)
  const source = isolatedSourceRoot(root)
  const configDir = isolatedConfigDir(root)
  const datasets = resolve(root, 'libero-datasets')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(datasets, { recursive: true })
  const config = {
    benchmark_root: source,
    bddl_files: join(source, 'bddl_files'),
    init_states: join(source, 'init_files'),
    datasets,
    assets: join(source, 'assets'),
  }
  const yaml = Object.entries(config).map(([key, value]) => `${key}: ${value}`).join('\n') + '\n'
  writeFileSync(join(configDir, 'config.yaml'), yaml)
  return { configDir, configFile: join(configDir, 'config.yaml'), config }
}

export function sdkProcessEnv(isolatedRoot: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  // 空/空白的 `CUDA_VISIBLE_DEVICES` 会让官方 SDK 在解析设备时抛
  // `invalid literal for int() with base 10: ''`，一路上来被笼统报成 `BENCHMARK_SDK_UNAVAILABLE`
  // （nextSteps 还误导成"重装隔离 Python"），排障很费时。空值在 CUDA 语义里是"看不到任何设备"，
  // 与"未设置"不同 ⇒ 不替用户静默删掉或改成 -1，而是前置成点名变量的可读错误。
  // 真机复现（D1）：`CUDA_VISIBLE_DEVICES=` + load ⇒ BLOCKED；去掉该变量 ⇒ 同一调用就绪。
  const cuda = env.CUDA_VISIBLE_DEVICES
  if (cuda !== undefined && cuda.trim() === '') {
    throw new Error('BENCHMARK_CUDA_VISIBLE_DEVICES_EMPTY: CUDA_VISIBLE_DEVICES 是空字符串，官方 LIBERO SDK 无法解析（int("")）。要么删除该环境变量，要么给出设备列表（如 "0"）；CUDA 约定 "-1" 表示不使用 GPU。')
  }
  const configDir = isolatedConfigDir(isolatedRoot)
  return {
    LIBERO_CONFIG_PATH: configDir,
    // 隔离源码是当前运行根的权威入口；editable 安装的 egg-link 可能仍指向迁移前目录。
    // 只修正本次子进程的查找路径，不改共享 Python 环境或用户全局配置。
    PYTHONPATH: [resolve(isolatedRoot, 'libero-source'), process.env.PYTHONPATH].filter(Boolean).join(delimiter),
    PYTHONUNBUFFERED: '1',
    MUJOCO_GL: resolveMuJoCoGlBackend(),
  }
}

function blocked(code: string, message: string, pythonPath: string, isolatedRoot: string, details?: Record<string, unknown>): PrepareResult {
  return { status: 'BLOCKED', code, message, pythonPath, isolatedRoot, details }
}

/** 写入隔离 config 后检查官方包能否非交互导入。缺环境时失败关闭。 */
export async function prepareIsolatedSdk(input: { pythonPath: string; isolatedRoot: string }): Promise<PrepareResult> {
  const pythonPath = resolve(input.pythonPath)
  const isolatedRoot = resolve(input.isolatedRoot)
  if (!existsSync(pythonPath)) {
    return blocked('BENCHMARK_SDK_UNAVAILABLE', `官方套件 Python 不存在: ${pythonPath}`, pythonPath, isolatedRoot, {
      nextSteps: ['在项目隔离目录安装官方 Python 与套件 SDK', '通过 Lyapunov 的 bench_prepare 再检查', '不要把套件打进默认安装包'],
    })
  }
  const written = writeIsolatedLiberoConfig(isolatedRoot)
  const check = [
    'import os',
    'assert os.environ.get("LIBERO_CONFIG_PATH"), "LIBERO_CONFIG_PATH missing"',
    'from libero.libero import get_libero_path',
    'from libero.libero.envs.env_wrapper import ControlEnv',
    'print("READY", get_libero_path("bddl_files"), get_libero_path("assets"))',
  ].join('; ')
  const output = await new Promise<{ code: number | null; stderr: string; stdout: string }>(done => {
    const child = spawn(pythonPath, ['-c', check], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...sdkProcessEnv(isolatedRoot) },
    })
    let stderr = ''
    let stdout = ''
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000) })
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-4000) })
    child.once('error', error => done({ code: 1, stderr: error.message, stdout }))
    child.once('close', code => done({ code, stderr, stdout }))
  })
  if (output.code !== 0 || !output.stdout.includes('READY')) {
    return blocked('BENCHMARK_SDK_UNAVAILABLE', `官方套件未能非交互导入: ${output.stderr.trim() || output.stdout.trim() || `exit ${output.code}`}`, pythonPath, isolatedRoot, {
      nextSteps: ['确认隔离 Python 已按官方锁定版本安装', '确认 LIBERO_CONFIG_PATH 指向隔离 config.yaml', '不要在 ~/.libero 上交互初始化'],
    })
  }
  return { status: 'READY', pythonPath, isolatedRoot, configDir: written.configDir }
}
