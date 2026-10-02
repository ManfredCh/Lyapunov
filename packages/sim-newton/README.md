# @lyapunov/sim-newton

把 [Newton](https://github.com/newton-physics/newton)（GPU 物理引擎，1.6.0 + Warp 1.17.0）作为可装配的
模拟 Provider 接进产品。**第一切片（minimal-1）**：只做「真的 open / 真的 step / 真的读状态」，
其余合同特性一律**明确报不支持**，绝不静默成功或返回假数据。

## 支持 / 不支持

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| `open` / `sync` / `close` / `list_worlds` | ✅ | Scene → Newton 模型，真编译；`sync` 用物理签名判断是否需要重建 |
| `observe`（时间 + qpos/qvel + 实体位姿） | ✅ | `stepIndex`、`simTime`、`entities[].transform`、`entities[].joints`、`sensors.bodyLinearVelocityMps/bodyAngularVelocityRadps` |
| `describe` | ✅ | 关节名/类型/单位/限位 + 引擎侧 PD 增益回读；`capabilities` 按合同 `RobotCapability.kind` 的**封闭 6 元组**（joint/thrust/vehicle/gripper/lift/control）逐项给 `available=false` + 原因，原因前缀就是 `execute` 实际返回的码 `ACTION_UNSUPPORTED`（判定与拒绝同源）；`controlMetadata` 如实说明 `controlledJointNames` 为何恒为空（本 Provider 没有动作/控制通道，不是"关节都被动"） |
| realtime 时钟真步进 | ✅ | `options.timestepS`（默认 1/500 s）与 `options.realtimeFactor` 生效，按 `frameRateHz` 发 `frame` 事件；**冷缓存下首个 tick 会阻塞十几秒（负载高时二十几秒）**（首个内核的 JIT，不是卡死 —— 用户会以为卡住的就是这一格，见「Warp 内核缓存」） |
| MJCF / URDF 原生源 | ✅ | 复用 `components.mujoco.sourcePath/xml` 与 mjcf/urdf resource（与 sim-mujoco 同一解析口径） |
| 地面 | ✅ | `options.ground !== false` ⇒ 铺 `__ground` 平面（与 sim-mujoco 同语义） |
| 无原生源的实体 | ⚠️ 跳过 + 结构化告警 | `handle.warnings[].code = ENTITY_SKIPPED_NO_NATIVE_SOURCE`；帧里仍给出 Scene 位姿，不假装被模拟 |
| 含 mesh 资产的 MJCF/URDF | ✅（依赖缺失时明确报错） | 本机独立环境**已装** Newton 的 `importers` extra（实测 `trimesh 5.1.0`），带 `<mesh>` 的模型**真的能导入**：`materials/robots/franka_panda/franka_emika_panda/panda_nohand.xml` 实测 `open` → `status="ready"`、`warnings=[]`、`describe` 给出 7 关节 / 60 形状；只有依赖**真的缺失**时才返回 `PROVIDER_DEPENDENCY_MISSING` 并给出安装方式，不降级成「场景非法」 |
| `execute`（trajectory/joint/vehicle/lift/gripper/gait/control/thrust/tendon/batch） | ❌ | 返回 `ACTION_UNSUPPORTED`（动作通道未接线） |
| `observe(contacts/penetrations)` | ❌ | 返回 `UNSUPPORTED_CAPABILITY`：Newton 1.6.0 的 CollisionPipeline 不暴露逐接触有符号距离，无法按合同字段如实给出 |
| `capture` / `capture_multi` / `camera_*`（渲染） | ❌ | 返回 `UNSUPPORTED_CAPABILITY` |
| `assist`（附着/辅助写回） | ❌ | 返回 `UNSUPPORTED_CAPABILITY` |
| `collisionPatches`（splat 场景碰撞编译） | ❌ | 传入即 `UNSUPPORTED_CAPABILITY`；本包**不含** sim-mujoco 的 splat 碰撞编译器 |
| manual 时钟 | ❌（如实冻结） | 没有动作通道就没有任何东西能驱动 tick；世界保持冻结，不假装推进。要真步进请用 `realtime` |
| `stop` | ⚪️ 空真值 | 从未接受过任何动作 ⇒ `receipts: []`、`affectedEntityIds: []`，不伪造回执（`ProcessSimProvider.close` 需要它成功） |
| `receipt` | ❌ | 恒 `ACTION_NOT_FOUND`（本切片没有任何动作回执） |

完整能力表由 worker 的 `ready` 事件与 `capabilities` 方法原样交出（`supported` / `unsupported` / `notes`），
并随 `WorldHandle.capabilities` 到达调用方。两条自报路径给同一份表、同一份设备事实；`capabilities` 还带
`kernelCacheDir` 与 `kernelCacheNote`（**实际生效**目录 + 配置基目录及其来源；两者同名不同义，见下）。

**入口不等于能力**：`--engine newton`（开发 YAML 的 `engine: newton`、桌面/建筑入口、`ui_engine_switch`、
SDK 解释器解析）说明的是"这个引擎能被装配"，**不是**"装配后动作/相机/接触/assist 可用"。装配由
`script/runtime-patch.ts` 的 `sim-newton` 分支完成（`cacheRoot=<sceneRoot>/provider-cache/newton`），
装配后能做什么只有上面这份自报说了算；入口侧面向人的措辞归各入口自己的文件，本包不复制第二份。

## 设备选择与降级

`auto`（默认）→ 有 CUDA 设备用 `cuda:0`，**没有则自动降级 `cpu`**（`handle.deviceDegraded=true` + `handle.deviceNote` 说明原因）。
显式指定 `cpu` / `cuda:N` 时**不静默顶替**：设备不可用即 `UNSUPPORTED_CAPABILITY`。

本机（无 NVIDIA 驱动、`wp.get_cuda_devices()` 为空）实测原文：

| 入口 | 读数 |
| --- | --- |
| `auto`（`ready` / `capabilities` / `open`） | `device="cpu"`、`deviceKind="cpu"`、`deviceDegraded=true`、`deviceNote="auto：没有可用 CUDA 设备（wp.get_cuda_devices() 为空），已降级到 cpu"`；世界照常 `status="ready"`（降级 ≠ 环境坏了） |
| `open {device:"cpu"}` | `deviceDegraded=false`、`deviceNote="显式选择 cpu"`（显式选择不是降级） |
| `open {device:"cuda:0"}` | 拒绝：`UNSUPPORTED_CAPABILITY: 显式指定的设备不可用: cuda:0（可见 CUDA 设备: 无）`，世界不会被半建出来 |
| `LYAPUNOV_NEWTON_DEVICE=cuda:0` | worker 结构化 `fatal`：`PROVIDER_UNAVAILABLE: Newton/Warp 设备初始化失败: 显式指定的设备不可用: cuda:0（可见 CUDA 设备: 无）`，退出码 2 |

```bash
# 默认 auto（本机 cuda:0）
.runtime/newton-env/bin/python packages/sim-newton/python/worker.py
# 强制 CPU（等价于没有 GPU 的机器）
CUDA_VISIBLE_DEVICES="" .runtime/newton-env/bin/python packages/sim-newton/python/worker.py
```

覆盖方式：`LYAPUNOV_NEWTON_DEVICE`（环境变量）、`NewtonProvider` 的 `config.device`、
`open` 的 `options.device`。`handle.device/deviceKind/deviceDegraded/deviceNote/solver` 如实回读。

## Warp 内核缓存

Warp 首次使用某个内核时会在缓存目录里编译它（缓存目录 = `<wp.config.kernel_cache_dir>/<warp 版本>`）。
`NewtonProvider` 的 `config.cacheRoot`（产品传 `<cacheRoot>/provider-cache/newton`）经
`LYAPUNOV_NEWTON_CACHE_ROOT` 传给 worker，在 `warp.init()` 之前生效，让编译产物落在产品运行根内；
目录不可写时**不硬失败、也不回落 Warp 默认缓存**（`~/.cache/warp/<版本>` 在会话沙箱里可能就是只读的）：
按 `LYAPUNOV_SIM_RUNTIME_ROOT/cache/warp` → `XDG_CACHE_HOME/warp` → `TMPDIR/lyapunov-warp-<warp 版本>` →
`<工作目录>/.warp-cache` 的顺序改用第一个**真实可写**的候选（建目录 + 落探针文件验证，不靠权限位猜），
告警与 `kernelCacheNote` 里带出原文；**一个可写候选都没有时当场结构化 fatal
`PROVIDER_DEPENDENCY_MISSING`**（报文原文：`找不到可写的 Warp 内核缓存目录（试过：…）`）+ 退出码 2，
而不是在只读的默认目录上等到第一次 JIT 才静默死亡。
`ready`/`capabilities` 的 `kernelCacheDir` 是**实际生效**目录（= `<配置基目录>/<warp 版本>`，warp 自己补版本子目录）；
`WorldHandle.kernelCacheDir` 给的是**配置的基目录**（`warp.init()` 之前设进去的那个值，没有版本子目录）——
两者同名不同义，问"缓存落在哪"看 `ready`/`capabilities`。
`kernelCacheNote` 的 token 是 **`configured_cache_root=`**（装的就是这个配置基目录，不是生效目录）+ 来源说明：
名字与值必须指同一件事，所以它**不叫** `kernel_cache_dir=` —— 那个名字与 Warp init 之后回读的
`wp.config.kernel_cache_dir` 同名，会被读成生效目录。

本机实测（drop-box 场景，dt=2 ms，400 步）：

| 缓存 | open（含编译） | 400 步 | 说明 |
| --- | --- | --- | --- |
| 全新空目录 | 3.0 s | 12.1 s | 27 个内核在首次使用时就地 JIT |
| 同一目录第二次 | 0.8 s | 0.42 s | 命中缓存 |

所以首次运行（冷缓存）要留出 ≥180 s 超时余量。

**冷缓存不只拖慢 `open`：`clock:"realtime"` 世界的第一个 tick 会实打实阻塞十几秒**（本机冷跑实测
**11.8–23.1 s**，机器负载高时更长 —— 上面那次冷跑就是 23.09 s）。
那一格全花在首个内核的 JIT 上，worker 主循环被占住 ⇒ 这期间发进去的 `observe` 要等它做完才回执
（冷跑读数：`open` 3.995 / 5.142 s，**首个 tick 17.52 / 23.09 s** 后才第一次看到 `stepIndex=1`；
另有 11.76 / 12.43 / 12.53 / 12.98 / 15.18 s 几次）。
**这是冷缓存，不是卡死**：紧接着 +1 s 挂钟就推进了 524 / 423 步（`stepIndex` 1 → 525 / 424），同一目录第二次远快于此。
留超时余量时请把**首个 tick** 也算进去，别把它当成世界挂了或引擎没起来。

## 单独跑 worker

```bash
# 握手 + 能力表
printf '%s\n' '{"id":1,"method":"capabilities","args":{}}' '{"id":2,"method":"shutdown","args":{}}' \
  | .runtime/newton-env/bin/python packages/sim-newton/python/worker.py
```

协议是 NDJSON（与 `packages/sim-mujoco/python/worker.py` 同形）：
请求 `{"id":<int>,"method":<str>,"args":{...}}`；响应 `{"id":<int>,"result":{...}}` 或
`{"id":<int>,"error":{"code":...,"message":...}}`；事件 `ready` / `frame` / `fatal` / `world-error`。
**stdout 只承载 NDJSON**：Warp 的初始化横幅与内核装载日志被改道到 stderr。

依赖缺失（没有 newton/warp）时按 sim-mujoco 的写法输出
`{"event":"fatal","error":{"code":"PROVIDER_UNAVAILABLE",...}}` 并退出码 2。

## 为什么是独立 Python 环境

Newton 1.6.0 的 MJCF 导入链 pin 了 `mujoco==3.12.0`（`mujoco-warp==3.12.0` 同版），
而产品的 MuJoCo Provider 跑在 `mujoco==3.13.0`（`.runtime/sim-python`）。
两个版本不能在同一个解释器里共存，因此 Newton 走独立环境
**`.runtime/newton-env/bin/python`**（CPython 3.12.14 + newton 1.6.0 + mujoco 3.12.0 +
mujoco-warp 3.12.0 + warp-lang 1.17.0 + numpy 2.5.3），默认路径由 `NewtonProvider` 解析，
可用 `config.pythonPath` 或 `LYAPUNOV_NEWTON_PYTHON` 覆盖。

## 语义与约定（诚实边界）

- **关节名是 Newton 自己的 label**（形如 `three-joint-arm/worldbody/base/link1/j1`），不是 MuJoCo 的局部名：
  它是 Newton 模型内的稳定唯一标识，直接来自 `Model.joint_label/body_label/shape_label`。
- **关节位置/速度用 `newton.eval_ik` 从 body 状态反解**：Newton 的刚体求解器只积分 `state.body_q/body_qd`，
  `state.joint_q` 不会随步进更新，因此每个观测点在读取前做一次 IK 回读。
- **自由根速度是 Newton 自身约定** `(v_com_world, omega_world)`，字段名刻意取
  `linearVelocityComWorldMps` / `angularVelocityWorldRadps`，与 MuJoCo 自由关节的
  `linearVelocityWorldMps`（body 原点、世界系）/ `angularVelocityLocalRadps`（本地系）**不同名**，避免混用。
  `sensors.bodyLinearVelocityMps/bodyAngularVelocityRadps` 与 MuJoCo `cvel` 口径一致，可直接对照。
- **求解器默认 `SolverXPBD(iterations=4)`**：实测 `SolverSemiImplicit` 在 `packages/sim-mujoco/fixtures/arm.xml`
  上会发散成 NaN；需要时用 `LYAPUNOV_NEWTON_SOLVER=semi` 显式启用，`handle.solver` 如实回读。
- **不驱动任何执行器**：导入的 MJCF 执行器目标保持模型初值（与 MuJoCo 里 `ctrl=0` 的语义一致）。
- **MJCF 根的摆放**：实体 MJCF 用 `xform = Scene 世界位姿` 导入，与 MJCF 自身内部姿态**复合**
  （`add_mjcf` 的默认语义，与 sim-mujoco 的 `spec.attach` 一致）；实体 `scale != [1,1,1]` 明确拒绝。
- **两处地面**：默认铺的 `__ground` 与 MJCF 自带 `floor` 会共面重合（物理无害）；要单一地面传 `ground:false`。
- **mesh 资产需要 Newton 的 importers extra**：Newton 1.6.0 把 `trimesh>=4.6.8`（以及 `scipy`/`meshio`/`coacd`/`usd-core`…）
  列为 `importers` 可选依赖，最小环境（只有 `newton`+`warp-lang`）装不了带 `<mesh>` 的 MJCF。
  **本机 `.runtime/newton-env` 已装（实测 `trimesh 5.1.0`）⇒ 带 `<mesh>` 的 MJCF/URDF 真的能导入**
  （`panda_nohand.xml` → `ready`/`warnings=[]`；`unitree_go1/xml/go1.urdf`（含 STL）→ 12 关节），
  上面那条"依赖缺失即报错"只在**别的**环境真的缺包时才触发；
  缺失时本 Provider 明确报 `PROVIDER_DEPENDENCY_MISSING`（附实体名、缺失包名与安装命令），
  绝不把它降级成「场景非法」。要跑 mesh 机器人请在独立环境执行：
  `uv pip install --python .runtime/newton-env/bin/python "newton[importers]"`（或最小集 `"trimesh>=4.6.8"`）。
- **性能**：Warp 首次编译内核较慢（冷缓存实测 3.0 s open + 12.1 s/400 步，见上表；给 ≥180 s 超时）；
  热缓存后本机实测 cuda:0 上 400 步（dt=2 ms，XPBD）约 0.4 s 挂钟。**冷缓存的首个 realtime tick 同样要
  十几秒（负载高时二十几秒）**（实测 17.52 / 23.09 s 才看到 `stepIndex=1`），这期间 `observe` 不回执 ——
  是 JIT，不是卡死。

## 文件

- `src/provider.ts` — `NewtonProvider extends ProcessSimProvider`（pythonPath/workerPath/engineName/device）
- `src/plugin.ts` — cordis 插件：`provide('sim', provider)` + `ctx.effect` 清理 + 同 realm 单 Provider 检查
- `python/worker.py` — NDJSON worker（Newton 世界的唯一所有者）
- `requirements.txt` / `cordis.patch.yml`
