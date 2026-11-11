import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { isaacLoaderEnvironment } from './provider.ts'

export interface IsaacValidationConfig { python: string; cacheRoot: string; workerPath?: string }
export interface IsaacAssetValidationOptions { path: string; profile: 'physics' | 'explicit-mass' | 'robot'; simulate?: boolean }

export async function validateIsaacAsset(subprocess: Context['subprocess'] | undefined, config: IsaacValidationConfig, input: IsaacAssetValidationOptions, signal?: AbortSignal) {
 if (!subprocess || !existsSync(config.python)) throw new Error('ISAAC_VALIDATOR_UNAVAILABLE: 请配置 Isaac Sim 6.0.1')
 const cache = config.cacheRoot
 await mkdir(cache, { recursive: true })
 const request = { id: 1, method: 'validate_asset', args: input }
 const child = subprocess.spawn({
  argv: [config.python, config.workerPath ?? fileURLToPath(new URL('../python/worker.py', import.meta.url))],
  cwd: cache, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
  graceMs: 3000,
  env: { ...isaacLoaderEnvironment(config.python), LYAPUNOV_ISAAC_CACHE: cache,
   LYAPUNOV_ISAAC_DEVICE: 'cpu', LYAPUNOV_ISAAC_RENDERING: 'none', XDG_CACHE_HOME: join(cache, 'xdg-cache'), XDG_CONFIG_HOME: join(cache, 'xdg-config'), XDG_DATA_HOME: join(cache, 'xdg-data') },
  stdio: { stdin: { data: JSON.stringify(request) + '\n' }, stdout: { maxBytes: 4_000_000 }, stderr: { maxBytes: 200_000 } },
 })
 const outcome = await child.done
 signal?.throwIfAborted()
 const out = child.collected.stdout?.readFrom(0).text ?? ''
 for (const line of out.split('\n')) {
  if (!line.startsWith('{')) continue
  let message
  try { message = JSON.parse(line) } catch { continue }
  if (message.event === 'fatal' || message.id === request.id && message.error) {
   throw new Error(`${message.error.code}: ${message.error.message}`)
  }
  if (message.id === request.id && outcome.exitCode === 0 && message.result?.status === 'CHECKED') return message.result
 }
 throw new Error(`ISAAC_VALIDATOR_FAILED: ${outcome.exitCode ?? outcome.signal} ${child.collected.stderr?.readFrom(0).text.slice(-2000) ?? ''}`)
}
