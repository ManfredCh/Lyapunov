/**
 * DEV-028 副产物：空 `CUDA_VISIBLE_DEVICES` 的前置报错。
 *
 * 真机复现（见 `bugfixHistory/DEV028-VLA-TERMINAL-20260926.md` D1）：
 * 带 `CUDA_VISIBLE_DEVICES=`（空字符串）时 `BenchmarkAdapter.load` 返回
 * `BENCHMARK_SDK_UNAVAILABLE: invalid literal for int() with base 10: ''`，
 * 去掉该变量后同一调用就绪。空值在 CUDA 语义里是"看不到任何设备"，与"未设置"不同，
 * 所以这里前置成点名变量的错误，而不是静默删掉/改写用户的环境。
 */
import { describe, expect, test } from 'bun:test'
import { sdkProcessEnv } from '../src/prepare.ts'

describe('官方套件 SDK 子进程环境的前置校验', () => {
  test('空/空白 CUDA_VISIBLE_DEVICES ⇒ 点名变量的可读错误（不进入 SDK）', () => {
    for (const value of ['', '   ']) {
      expect(() => sdkProcessEnv('/tmp/isolated', { CUDA_VISIBLE_DEVICES: value })).toThrow('BENCHMARK_CUDA_VISIBLE_DEVICES_EMPTY')
    }
  })

  test('未设置 ⇒ 正常返回（不因为"没配"而失败）', () => {
    const env = sdkProcessEnv('/tmp/isolated', {})
    expect(env.LIBERO_CONFIG_PATH).toContain('isolated')
    expect(env.PYTHONUNBUFFERED).toBe('1')
  })

  test('合法取值（含 CUDA 约定的 -1）⇒ 原样放行，不做设备可见性改写', () => {
    for (const value of ['0', '-1', '0,1']) {
      const env = sdkProcessEnv('/tmp/isolated', { CUDA_VISIBLE_DEVICES: value })
      // 返回值里不含该键：它由调用方从 process.env 继承，产品不替用户改写设备可见性。
      expect(Object.keys(env)).not.toContain('CUDA_VISIBLE_DEVICES')
      expect(() => sdkProcessEnv('/tmp/isolated', { CUDA_VISIBLE_DEVICES: value })).not.toThrow()
    }
  })
})
