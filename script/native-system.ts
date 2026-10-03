import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { nativeSystemRuntimeViolations } from '../distribution/linux/payload-contract.ts'

/** 发行 Node 与其原生构建的实际命令；固定 SDK 的源码不在此修改。 */
export interface NativeSystemPreparation {
  executable: string
  version: string
  command: string[]
}

/** 用所选发行 Node 执行固定 SDK 的 host-addon-only 构建，并核验 Linux x64 glibc 产物。 */
export function prepareLinuxNativeSystem(upstream: string, node: string): NativeSystemPreparation {
  const probe = spawnSync(node, ['-p', 'JSON.stringify({executable:process.execPath,version:process.version,platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime})'], { encoding: 'utf8' })
  if (probe.error) throw probe.error
  if (probe.status !== 0) throw new Error('找不到可用的 Node 24 运行时：' + probe.stderr)
  const runtime = JSON.parse(probe.stdout) as { executable: string; version: string; platform: string; arch: string; glibc?: string }
  if (Number(runtime.version.slice(1).split('.')[0]) < 24) throw new Error('发行包要求 Node >= 24')
  if (runtime.platform !== 'linux' || runtime.arch !== 'x64' || !runtime.glibc)
    throw new Error('原生构建要求所选发行 Node 运行在 Linux x64 glibc 上')
  const manifest = join(upstream, 'package.json')
  const script = JSON.parse(readFileSync(manifest, 'utf8')).scripts?.['build:native-system']
  if (script !== 'tsx native/system/scripts/build.ts --host-addon-only')
    throw new Error('固定 SDK 的 build:native-system 命令发生变化，停止原生构建：' + String(script))
  // 展开已核实的上游脚本，绕过 pnpm 的旧安装缓存处理；tsx 与 C 源码仍取自同一固定 SDK。
  const require = createRequire(manifest)
  const command = [runtime.executable, require.resolve('tsx/cli'), join(upstream, 'native/system/scripts/build.ts'), '--host-addon-only']
  const build = spawnSync(command[0]!, command.slice(1), { cwd: upstream, stdio: 'inherit', env: { ...process.env, HF_ENDPOINT: 'https://hf-mirror.com' } })
  if (build.error) throw build.error
  if (build.status !== 0) throw new Error(`Linux x64 glibc 原生构建失败（退出 ${build.status}），停止打包`)
  const problems = nativeSystemRuntimeViolations(upstream, '')
  if (problems.length) throw new Error(problems.join('；'))
  return { executable: runtime.executable, version: runtime.version, command }
}
