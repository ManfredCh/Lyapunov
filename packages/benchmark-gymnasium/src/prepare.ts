import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import type { BenchmarkUnavailable } from '../../benchmark-contract/src/index.ts'
import { resolveMuJoCoGlBackend } from '../../sim-contract/src/mujoco-gl.ts'

export interface GymnasiumPrepareReady {
  status: 'READY'
  pythonPath: string
  isolatedRoot: string
  packageVersion: string
  actionShape: number
  observationShape: number
  controlFrequencyHz: number
}
export type GymnasiumPrepareResult = GymnasiumPrepareReady | (BenchmarkUnavailable & { pythonPath: string; isolatedRoot: string })

function blocked(code: string, message: string, pythonPath: string, isolatedRoot: string, details?: Record<string, unknown>): GymnasiumPrepareResult {
  return { status: 'BLOCKED', code, message, pythonPath, isolatedRoot, details }
}

/**
 * Check the optional Gymnasium SDK inside an explicit root. No import happens
 * in the product process and no package is installed by this function.
 */
export async function prepareGymnasiumSdk(input: { pythonPath: string; isolatedRoot: string }): Promise<GymnasiumPrepareResult> {
  const pythonPath = resolve(input.pythonPath)
  const isolatedRoot = resolve(input.isolatedRoot)
  mkdirSync(isolatedRoot, { recursive: true })
  if (!existsSync(pythonPath)) {
    return blocked('GYMNASIUM_SDK_UNAVAILABLE', `Gymnasium Python 不存在: ${pythonPath}`, pythonPath, isolatedRoot, {
      package: 'gymnasium[mujoco]==1.2.0',
      nextSteps: ['在独立目录安装 Gymnasium 与 MuJoCo extra', '通过 bench_prepare 再检查', '不得污染默认 Profile 或使用 HF 端点'],
    })
  }
  const script = [
    'import json',
    'import gymnasium',
    'from gymnasium.spaces import Box',
    'env = gymnasium.make("Ant-v5")',
    'assert isinstance(env.action_space, Box)',
    'assert tuple(env.action_space.shape) == (8,)',
    'assert float(env.action_space.low.min()) == -1.0 and float(env.action_space.high.max()) == 1.0',
    'obs, info = env.reset(seed=0)',
    'assert len(obs.shape) == 1',
    'assert env.unwrapped.dt > 0',
    'payload = {"packageVersion": getattr(gymnasium, "__version__", "unknown"), "actionShape": int(env.action_space.shape[0]), "observationShape": int(obs.shape[0]), "controlFrequencyHz": 1.0 / float(env.unwrapped.dt)}',
    'print("READY " + json.dumps(payload, sort_keys=True))',
    'env.close()',
  ].join('; ')
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(done => {
    const child = spawn(pythonPath, ['-u', '-c', script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', MUJOCO_GL: resolveMuJoCoGlBackend() } })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-4000) })
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000) })
    child.once('error', error => done({ code: 1, stdout, stderr: error.message }))
    child.once('close', code => done({ code, stdout, stderr }))
  })
  const line = result.stdout.split(/\r?\n/).find(line => line.startsWith('READY '))
  if (result.code !== 0 || !line) {
    return blocked('GYMNASIUM_SDK_UNAVAILABLE', `Gymnasium Ant-v5 无法非交互导入: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`, pythonPath, isolatedRoot, {
      package: 'gymnasium[mujoco]==1.2.0',
      nextSteps: ['确认 Python 环境安装 gymnasium[mujoco]', '确认 MuJoCo 后端和 EGL/GL 配置可用', '不要从缺失的镜像或网络旁路静默回退'],
    })
  }
  try {
    const parsed = JSON.parse(line.slice('READY '.length))
    return { status: 'READY', pythonPath, isolatedRoot, packageVersion: String(parsed.packageVersion), actionShape: Number(parsed.actionShape), observationShape: Number(parsed.observationShape), controlFrequencyHz: Number(parsed.controlFrequencyHz) }
  } catch {
    return blocked('GYMNASIUM_SDK_UNAVAILABLE', `Gymnasium prepare 输出无法解析: ${line}`, pythonPath, isolatedRoot)
  }
}
