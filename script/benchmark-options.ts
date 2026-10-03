/** Benchmark 工作台入口的薄选项层：解析参数，并派生与 runtime-patch 装配完全一致的隔离落点。 */
import { join } from 'node:path'
import { parseArgs } from 'node:util'

export type BenchmarkProvider = 'libero' | 'gymnasium'
export type BenchmarkMode = 'formal' | 'developer'

export interface BenchmarkOptions {
  help: boolean
  provider: BenchmarkProvider
  /** 普通入口默认正式模式；显式 --mode developer 才进入调用方 Key 的开发约束。 */
  mode: BenchmarkMode
  check: boolean
  /** 未给时交给操作系统选择端口；URL 由 Host 就绪行给出。 */
  port?: number
  /** 未给时沿用 benchmark 引擎的默认运行根 <PRODUCT_ROOT>/.runtime/product-benchmark。 */
  hostId?: string
}

/**
 * 与 script/runtime-patch.ts 的 benchmark 装配同一落点。
 * 该文件归生产装配所有，本入口只读取同一契约，不复制第二套路径规则；
 * install-provider 的 benchmark 安装分支必须落到这里列出的前缀。
 */
export const BENCHMARK_PACKAGE_PATHS = {
  libero: { python: '.runtime/bench/libero-env/bin/python', isolatedRoot: '.runtime/bench' },
  gymnasium: { python: '.runtime/bench/gymnasium-env/bin/python', isolatedRoot: '.runtime/bench/gymnasium' },
} as const

/** 官方套件准备能力所需的解释器与隔离根；两者都以产品根为基准。 */
export function benchmarkPaths(root: string, provider: BenchmarkProvider) {
  const entry = BENCHMARK_PACKAGE_PATHS[provider]
  return { pythonPath: join(root, entry.python), isolatedRoot: join(root, entry.isolatedRoot) }
}

export function parseBenchmarkOptions(args: string[]): BenchmarkOptions {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: {
      provider: { type: 'string', default: 'libero' },
      mode: { type: 'string', default: 'formal' },
      check: { type: 'boolean' },
      port: { type: 'string' },
      'host-id': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) return { help: true, provider: 'libero', mode: 'formal', check: false }
  if (positionals.length) throw new Error('benchmark 不接受位置参数：' + positionals.join(' '))
  const provider = values.provider
  if (provider !== 'libero' && provider !== 'gymnasium') throw new Error('--provider 只接受 libero 或 gymnasium。')
  const mode = values.mode
  if (mode !== 'formal' && mode !== 'developer') throw new Error('--mode 只接受 formal 或 developer。')
  if (values['host-id'] !== undefined && !values['host-id'].trim()) throw new Error('--host-id 不能为空。')
  let port: number | undefined
  if (values.port !== undefined) {
    port = Number(values.port)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port 必须在 0 到 65535 之间。')
  }
  return {
    help: false, provider, mode, check: Boolean(values.check),
    ...(port === undefined ? {} : { port }),
    ...(values['host-id'] === undefined ? {} : { hostId: values['host-id'].trim() }),
  }
}
