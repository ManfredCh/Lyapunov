import type { Context } from '@deepseek-ai/cordis'
import { SessionSimFactory } from '../../sim-contract/src/session-provider.ts'
import { createSimSessionLauncher } from '../../sim-contract/src/session-launch.ts'
import { sessionNamespace } from '../../lyapunov-contracts/src/session-scope.ts'
import type {} from '../../sim-contract/src/index.ts'
import { NewtonProvider, type NewtonConfig } from './provider.ts'

export const name = 'lyapunov-sim-newton'
export const inject: string[] = []
export interface NewtonPluginConfig extends NewtonConfig {
  readOnlyRoots?: string[]
  /** 本部署的产品会话产物父根（截图/录像）；与 MuJoCo 同一条媒体中转边界，省略即不中转。 */
  productRoots?: string[]
}
export function apply(ctx: Context, config: NewtonPluginConfig = {}) {
  if (ctx.get('sim')) throw new Error('同一 realm 只能启用一个模拟 Provider；请先关闭旧 Provider')
  // 每会话一套 Provider 实例（各自的 worker 进程）：本地同名 worldId 在不同会话里各自成立，
  // 一个会话的 close/取消/进程失败不结束别的会话的世界。引擎安装、解释器与缓存等不可变依赖
  // 仍由这里共享传入，按会话复制的只有运行态。惰性：第一次为该会话取世界服务时才建实例。
  //
  // 执行接线与 MuJoCo 同一条（会话身份/会话运行根/原生有效策略 + 沙箱包裹 + 运行中策略核对）：
  // 不再有"MuJoCo 有约束、其它引擎直连 spawn"的分叉。
  const productRoots = config.productRoots ?? []
  const launchFor = createSimSessionLauncher(ctx, {
    readOnlyRoots: config.readOnlyRoots,
    engineName: 'Newton',
    productRoots: sessionKey => productRoots.map(root => sessionNamespace(root, sessionKey)),
  })
  const sim = new SessionSimFactory({ create: sessionKey => new NewtonProvider({ ...config, launch: launchFor(sessionKey) }) })
  ctx.reflect.provide('sim', sim)
  // 插件卸载（Host 关闭）才释放全部会话实例；单个会话结束用 sim.release(sessionKey)。
  ctx.effect(() => () => sim.dispose())
}
