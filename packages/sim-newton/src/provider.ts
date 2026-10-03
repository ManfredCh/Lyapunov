import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProcessSimProvider, type SimWorkerLaunchHook } from '../../sim-contract/src/python-transport.ts'
import { SimError, type WorldOptions } from '../../sim-contract/src/index.ts'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
export interface NewtonConfig {
  pythonPath?: string
  workerPath?: string
  /**
   * 按会话的执行接线（与 MuJoCo 同一条 `createSimSessionLauncher`）：worker 收到的会话身份、
   * 会话运行根与原生有效权限策略都由它给出；会话模式在运行中被改变时，写类操作前会重新核对
   * （见 `SimWorkerPolicyCheck`）。不注入 = 保持历史直连 spawn（没有会话沙箱接线）。
   */
  launch?: SimWorkerLaunchHook
  /**
   * Warp 编译内核的缓存目录（产品传 <cacheRoot>/provider-cache/newton）。
   * 必须在 worker 进程里于 warp 初始化前生效，故经环境变量 LYAPUNOV_NEWTON_CACHE_ROOT 传入；
   * 目录不可用时 worker 只告警并回落 Warp 默认缓存，不因此变成不可用。
   */
  cacheRoot?: string
  /**
   * Warp 设备。'auto'（默认）有 CUDA 用 cuda:0，没有则 cpu；'cpu' 强制 CPU；
   * 显式指定不可用的 'cuda:N' 由 worker 明确拒绝（不静默顶替）。经环境变量
   * LYAPUNOV_NEWTON_DEVICE 传给 worker，与 Python 侧同名变量一致。
   */
  device?: string
}
/**
 * Newton（GPU 物理引擎）Provider。第一切片只做真实 open/sync/step/observe：
 * 场景实体的 MJCF/URDF 原生源 + 地面被 Newton 真实导入并步进；动作/接触/相机/附着
 * 等未实现的合同特性由 worker 返回结构化错误（ACTION_UNSUPPORTED / UNSUPPORTED_CAPABILITY），
 * 不静默成功。Newton 的 pin（mujoco==3.12.0，Newton 1.6.0 的 MJCF 导入依赖）与产品的
 * MuJoCo 3.13.0 冲突，因此走独立解释器 .runtime/newton-env。
 */
export class NewtonProvider extends ProcessSimProvider {
  override async open(snapshot: SceneSnapshot, options: WorldOptions = {}, signal?: AbortSignal) {
    if (options.startPaused === true) throw new SimError('CLOCK_CONTROL_UNSUPPORTED', 'Newton 当前切片没有暂停/继续物理钟接口，不能自动进入控制器准备；可明确选择被动仿真')
    return super.open(snapshot, options, signal)
  }
  constructor(config: NewtonConfig = {}) {
    const here = dirname(fileURLToPath(import.meta.url))
    super({
      pythonPath: config.pythonPath ?? process.env.LYAPUNOV_NEWTON_PYTHON ?? resolve(here, '../../../.runtime/newton-env/bin/python'),
      workerPath: config.workerPath ?? resolve(here, '../python/worker.py'),
      engineName: 'Newton',
      env: {
        ...(config.cacheRoot === undefined ? {} : { LYAPUNOV_NEWTON_CACHE_ROOT: config.cacheRoot }),
        ...(config.device === undefined ? {} : { LYAPUNOV_NEWTON_DEVICE: config.device }),
      },
      ...(config.launch === undefined ? {} : { launch: config.launch }),
    })
  }
}
