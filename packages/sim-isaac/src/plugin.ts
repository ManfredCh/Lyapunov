import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { SessionSimFactory } from '../../sim-contract/src/session-provider.ts'
import { createSimSessionLauncher, resolveSessionPrivateRoot } from '../../sim-contract/src/session-launch.ts'
import { sessionNamespace } from '../../lyapunov-contracts/src/session-scope.ts'
import type {} from '../../sim-contract/src/index.ts'
import { IsaacProvider, type IsaacConfig } from './provider.ts'
// W21：设备不可见时的解释链与稳定码只有一份（环境契约），这里只消费、不重判。
// C1（2026-09-26 验收）：**"什么算设备可见"也只有一份**——装配点曾经用 provider 的
// `nvidiaDeviceNodes()`（字符设备**或非空目录**），而契约只算字符设备；于是"只暴露了
// `/dev/nvidia-caps`、没有 `nvidia0`"的容器里，这里不触发守卫、把 caps 当设备交下去，
// 而同一台机器在面板里仍显示"会话看不见设备"。现在判据与暴露清单都来自契约这一份。
import { gpuRefusal, probeGpuDeviceVisibility, probeGpuFacts } from '../../lyapunov-shell/src/environment-readiness.ts'
export const name = 'lyapunov-sim-isaac'
export const inject: string[] = []
/**
 * 本适配层**能如实执行**的引擎取值：与入口解析 `isaacRuntimeOptions()` 同一集合（`script/runtime-patch.ts`）。
 *
 * 为什么不在这里再判一次"该选哪个引擎"：选择归 `script/engine-preference.ts` 的唯一 owner，这里只拿结果。
 * 这两个取值判的**不是选择**，而是"这份已被选中的配置我能不能照它装配"——Profile/插件配置在运行时是
 * 无类型的（YAML/JSON 进来的字符串没有编译期约束），而这两个值既要原样交给 worker
 * （`LYAPUNOV_ISAAC_DEVICE`/`LYAPUNOV_ISAAC_RENDERING`），又要在这里决定"要不要给这只 worker 暴露
 * GPU 设备节点"。以前用 `===` 直接比：`RTX`／`cuda:1` 这类写错的值只会让判断变成"不需要 GPU"，
 * 未知值照样交给 worker —— 于是选了 GPU/RTX 的配置可能真的按 CPU/none 起起来，读回还显示成功。
 * 装配期拒绝是唯一不撒谎的选项；集合本身是**跨侧耦合**（入口那边放宽取值时这里必须同步）。
 */
export const ISAAC_PHYSICS_DEVICES = ['cpu', 'cuda:0'] as const
export const ISAAC_RENDERINGS = ['none', 'rtx'] as const
/**
 * 把（可能来自无类型 Profile 的）引擎配置解析成**这次装配真的要用的值**。
 *
 * 默认值与 provider 的默认是同一份语义（`?? 'cpu'`／`?? 'none'`），但在这里显式钉住并回填进
 * Provider 配置：装配用什么值 == Provider 拿到的值 == 交给 worker 的值，三处不再各自默认一遍。
 * @param config - 已选中的 Isaac 引擎配置（选择本身由入口 owner 决定）。
 * @returns 生效的设备/渲染模式，以及本装配是否需要 GPU 设备节点。
 * @throws 取值不在 {@link ISAAC_PHYSICS_DEVICES}／{@link ISAAC_RENDERINGS} 时**拒绝装配**（不静默降级）。
 */
export function effectiveIsaacEngineConfig(config: Pick<IsaacConfig, 'physicsDevice' | 'rendering'> = {}): { physicsDevice: 'cpu' | 'cuda:0'; rendering: 'none' | 'rtx'; requiresGpu: boolean } {
  const physicsDevice = config.physicsDevice ?? 'cpu'
  const rendering = config.rendering ?? 'none'
  if (!(ISAAC_PHYSICS_DEVICES as readonly string[]).includes(physicsDevice)) {
    throw new Error(`ISAAC_ENGINE_CONFIG_UNSUPPORTED: physicsDevice=${String(physicsDevice)} 不是本适配层支持的取值（${ISAAC_PHYSICS_DEVICES.join('/')}）：拒绝装配一只会把未知设备名原样交给 worker、又按"不需要 GPU"组装的 Provider（这样配置了 GPU 却按 CPU 跑起来还会报成功）`)
  }
  if (!(ISAAC_RENDERINGS as readonly string[]).includes(rendering)) {
    throw new Error(`ISAAC_ENGINE_CONFIG_UNSUPPORTED: rendering=${String(rendering)} 不是本适配层支持的取值（${ISAAC_RENDERINGS.join('/')}）：拒绝装配一只会把未知渲染模式原样交给 worker、又按 rendering:none 组装的 Provider（这样选了 RTX 却按无渲染跑起来还会报成功）`)
  }
  return { physicsDevice, rendering, requiresGpu: physicsDevice === 'cuda:0' || rendering === 'rtx' }
}
export interface IsaacPluginConfig extends IsaacConfig {
  readOnlyRoots?: string[]
  /**
   * 本部署的产品会话产物父根（截图与录像存储）。与 MuJoCo 同一条媒体中转边界：只有落在**本会话**
   * 命名空间里的产物才由宿主代落盘；省略时没有任何中转，越界写入一律如实失败。
   */
  productRoots?: string[]
}
export function apply(ctx: Context, config: IsaacPluginConfig = {}) {
  if (ctx.get('sim')) throw new Error('同一 realm 只能启用一个模拟 Provider；请先关闭旧 Provider')
  // 每会话一套 Provider 实例（各自的 worker 进程）：本地同名 worldId 在不同会话里各自成立，
  // 一个会话的 close/取消/进程失败不结束别的会话的世界。引擎安装、解释器与缓存等不可变依赖
  // 仍由这里共享传入，按会话复制的只有运行态。惰性：第一次为该会话取世界服务时才建实例。
  //
  // 执行接线与 MuJoCo 同一条：每次启动该会话的 worker 时解析**它自己的**会话身份/运行根/有效策略，
  // 并按原生沙箱包裹；运行中模式被改变时，写类操作前会重新核对（见 SimWorkerPolicyCheck）。
  // 接线只在这里装配一次，不再为每个引擎各写一套沙箱逻辑。
  const productRoots = config.productRoots ?? []
  // 每个会话各有一份引擎缓存：越界写入不存在，代价是跨会话不再复用热缓存（真要用跨会话共享缓存，
  // 得让原生策略显式授权那个共享根，不在本接线里偷偷放开）。落点只在这里定义一次——启动接线与
  // provider 的 cacheRootFor 用同一个函数取值，两边不会漂移。
  const engineCacheOf = (privateRoot: string) => join(privateRoot, 'engine-cache', 'isaac')
  // Kit/Python 的临时文件同样要落在**本会话自己的**内部运行目录里：只读会话没有可写的平台 /tmp，
  // `tempfile` 找不到候选目录时连已有场景都打不开（实测 No usable temporary directory found）。
  const engineTempOf = (privateRoot: string) => join(privateRoot, 'engine-tmp')
  // GPU 物理/RTX：原生封装的 `--dev /dev` 给的是空挂载点，宿主 `/dev/nvidia*` 不在里面，引擎在只读
  // 沙箱里初始化 GPU 当场失败（实测 NVML_ERROR_DRIVER_NOT_LOADED → 无物理设备）。这里**按引擎配置**
  // 声明要暴露的设备（模型/HTTP 不能指定），拿不到就抛错不启动——配置了 GPU 却静默按 CPU 跑起来
  // 比启动失败更坏。用户文件效果不受影响：多出来的只有设备访问（见 sim-contract 的 engineDevices）。
  // 生效值在装配期一次解析：未知取值当场拒绝（见 effectiveIsaacEngineConfig），不回落到另一套默认。
  const engine = effectiveIsaacEngineConfig(config)
  const requiresGpu = engine.requiresGpu
  const engineDevices = requiresGpu
    ? () => {
        // C1：**判据**问契约这一份（`visible` 只认字符设备），与面板/doctor-env 的"看不看得见"是同一个答案。
        // `exposable` 是另一件事：要把哪些路径暴露进沙箱（字符设备 + 非空目录，如 `/dev/nvidia-caps`——
        // 新驱动的 mempool 要它）。"判据"与"暴露清单"分开，正是不再分叉的原因。
        // 2026-09-27 收口：本调用点**不需要**改一个字 —— `probeGpuDeviceVisibility` 现在与 `probeGpuFacts`
        // 走同一份 `settledDeviceScan`（先跑完 `nvidia-smi` 这一步、再把它自己造出来的条目收回去），
        // 所以这里的读数只跟**这台机器**有关，与"这个进程里探测跑过几次、谁先跑过"无关。
        // 原先它不是：冷启动下装配点先读、面板后读，同一台机器会给出两句不同的 `deviceExtras`
        // （`bugfixHistory/ORDER-DEPENDENCY-RECHECK-20260926.md` §6.2 的残留①）。守卫见
        // `packages/lyapunov-shell/test/gpu-misdiagnosis-guard.test.ts` 的 B3 两条。
        const visibility = probeGpuDeviceVisibility()
        if (!visibility.visible) {
          // W21：这里**不许**说成"没有任何 NVIDIA 设备节点"——那会把"设备对本会话不可见"说成"没有设备"，
          // 而两者的处置完全不同（用户会去重装驱动/换卡，其实只需要让这个会话看见设备）。
          // 判定问同一份契约（`gpuRuntimeDecision`：卡 → 驱动 → 设备 → 结论 → 处置），不在这里另探一次。
          const refusal = gpuRefusal(`Isaac 配置要求 GPU（physicsDevice=${engine.physicsDevice}，rendering=${engine.rendering}）`, probeGpuFacts())
          // 保留既有稳定码 `ISAAC_GPU_DEVICE_UNAVAILABLE`（下游与既有用例按它匹配），
          // 同时把环境契约的稳定码与解释链带上——**加**信息，不改既有标识符。
          throw new Error(refusal === null
            ? `ISAAC_GPU_DEVICE_UNAVAILABLE: 配置要求 GPU，但本会话可暴露的 NVIDIA 设备节点：0 个`
            : `ISAAC_GPU_DEVICE_UNAVAILABLE (${refusal.code}): 本会话可暴露的 NVIDIA 设备节点：0 个｜${refusal.message}`)
        }
        return [...visibility.exposable]
      }
    : undefined
  const launchFor = createSimSessionLauncher(ctx, {
    readOnlyRoots: config.readOnlyRoots,
    engineName: 'Isaac Sim',
    productRoots: sessionKey => productRoots.map(root => sessionNamespace(root, sessionKey)),
    // Kit 启动前就要建自己的 portable root 并写 MJCF/URDF 导入缓存，所以这个目录在**只读会话**里也必须是
    // 本次执行真的写得进去的地方：接线把它按会话解析出来、在原生封装里单独挂回可写。用户模式仍是 read-only
    // （用户工程、场景资产、其他会话目录照旧只读；用户的截图/数据集落盘另按策略拒绝，见 python-transport）。
    internalWritableRoots: ({ privateRoot }) => [engineCacheOf(privateRoot)],
    internalTempDir: ({ privateRoot }) => engineTempOf(privateRoot),
    ...(engineDevices === undefined ? {} : { engineDevices }),
  })
  const sim = new SessionSimFactory({
    create: sessionKey => new IsaacProvider({
      ...config,
      // 装配生效值显式回填：Provider/worker 拿到的是这里核过的同一份，不再各自默认一次。
      physicsDevice: engine.physicsDevice,
      rendering: engine.rendering,
      launch: launchFor(sessionKey),
      // 缓存根按会话解析：workspace-write 下它在挂回可写的会话私有目录里；read-only 下由上面的
      // internalWritableRoots 把同一目录单独挂回可写——provider 与启动接线取的是同一个落点。
      cacheRootFor: async () => engineCacheOf(await resolveSessionPrivateRoot(ctx, sessionKey, 'Isaac Sim')),
    }),
  })
  ctx.reflect.provide('sim', sim)
  // 插件卸载（Host 关闭）才释放全部会话实例；单个会话结束用 sim.release(sessionKey)。
  ctx.effect(() => () => sim.dispose())
}
