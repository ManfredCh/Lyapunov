import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { SessionSimFactory } from '../../sim-contract/src/session-provider.ts'
import { createSimSessionLauncher } from '../../sim-contract/src/session-launch.ts'
import { sessionNamespace } from '../../lyapunov-contracts/src/session-scope.ts'
import type {} from '../../sim-contract/src/index.ts'
import { MuJoCoProvider, type MuJoCoConfig } from './provider.ts'

export const name = 'lyapunov-sim-mujoco'
export const inject: string[] = []
export interface MuJoCoPluginConfig extends MuJoCoConfig {
  readOnlyRoots?: string[]
  /**
   * 本部署的产品会话产物父根（截图与录像存储，例如 captureRoot/recordingRoot）。只为**媒体中转**
   * 给出边界：会话内部的采集/录制目录一般落在原生授权根之外，worker 在会话运行根里的中转目录先落盘、
   * 宿主再按原路径代落盘；不在这两个根下（或越出本会话命名空间）的目标一律不中转，
   * 让 worker 侧真实的拒绝原样上报。省略时没有任何中转——越界写入一律如实失败。
   */
  productRoots?: string[]
}
export function apply(ctx: Context, config: MuJoCoPluginConfig = {}) {
  if (ctx.get('sim')) throw new Error('同一 realm 只能启用一个模拟 Provider；请先关闭旧 Provider')
  // 每会话一套 Provider 实例（各自的 worker 进程）：本地同名 worldId 在不同会话里各自成立，
  // 一个会话的 close/取消/进程失败不结束别的会话的世界。引擎安装、解释器与缓存等不可变依赖
  // 仍由这里共享传入，按会话复制的只有运行态。惰性：第一次为该会话取世界服务时才建实例。
  //
  // 执行接线（会话身份/会话运行根/原生有效权限策略/原生沙箱）在**每次启动**时按该会话重新解析：
  // 会话模式被显式改变后，下一次启动就是新模式。产品会话产物根按会话键展开成会话自己的目录，
  // 是媒体中转的唯一边界。
  const productRoots = config.productRoots ?? []
  const launchFor = createSimSessionLauncher(ctx, {
    readOnlyRoots: config.readOnlyRoots,
    engineName: 'MuJoCo',
    productRoots: sessionKey => productRoots.map(root => sessionNamespace(root, sessionKey)),
    // .mjcf 的解码别名/相对依赖镜像属于引擎内部计算；只给本会话 scratch/temp 可写位，
    // read-only 仍禁止用户截图/导出，不把原件目录或整个会话运行根挂成可写。
    internalWritableRoots: ({ privateRoot }) => [join(privateRoot, 'sim', 'scratch')],
    internalTempDir: ({ privateRoot }) => join(privateRoot, 'sim', 'tmp'),
  })
  const sim = new SessionSimFactory({ create: sessionKey => new MuJoCoProvider({ ...config, launch: launchFor(sessionKey) }) })
  ctx.reflect.provide('sim', sim)
  // 插件卸载（Host 关闭）才释放全部会话实例；单个会话结束用 sim.release(sessionKey)。
  ctx.effect(() => () => sim.dispose())
}
