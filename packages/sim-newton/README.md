# @lyapunov/sim-newton

把 [Newton](https://github.com/newton-physics/newton)（GPU 物理引擎，1.6.0 + Warp 1.17.0）作为可装配的
模拟 Provider 接进产品。**RC2 关节、接触与液体切片（joint-contact-mpm-rc2）**：真实导入、步进和状态读回，并接通可核验源位置执行器的
`joint` / `trajectory` / `control`。另有 `components.newton.mpm.kind="water"` 选择的原生隐式 MPM 水例。命名原生相机可采集同一物理步的 RGB 与轴向米制深度；未接通的动作、相机覆盖/标注/数据集导出与辅助能力继续明确拒绝。

## 支持 / 不支持

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| `open` / `sync` / `close` / `list_worlds` | ✅ | Scene → Newton 模型，真编译；`sync` 用物理签名判断是否需要重建 |
| `observe`（时间 + qpos/qvel + 实体位姿） | ✅ | `stepIndex`、`simTime`、`entities[].transform`、`entities[].joints`、`sensors.bodyLinearVelocityMps/bodyAngularVelocityRadps` |
| `describe` | ✅ | 关节、源执行器控制模式及原生 PD 增益回读；逐实体能力覆盖共享 8 种 kind，只开放已核验源位置驱动的 joint，以及 manual 下的 control；其他能力逐项给出错误码与原因 |
| realtime 时钟真步进 | ✅ | `options.timestepS`（默认 1/500 s）与 `options.realtimeFactor` 生效，按 `frameRateHz` 发 `frame` 事件；**冷缓存下首个 tick 会阻塞十几秒（负载高时二十几秒）**（首个内核的 JIT，不是卡死 —— 用户会以为卡住的就是这一格，见「Warp 内核缓存」） |
| MJCF / URDF 原生源 | ✅ | 复用 `components.mujoco.sourcePath/xml` 与 mjcf/urdf resource（与 sim-mujoco 同一解析口径） |
| 地面 | ✅ | 消费 Scene 管理的零厚度无限 plane；用户入口首次建世界先沿 Scene CAS 保存默认地面。隐藏只改变显示，删除/禁用选择重开后保留；原生同位置静态 plane 去重。仅旧无模板 Scene 的显式 `ground:true` 可请求兼容地面。 |
| Scene collision（普通 GLB 派生） | ✅（有明确边界） | 消费真实 `box/shapes`、sphere、cylinder、capsule、静态 plane 与 OBJ parts；与原生源共用 ModelBuilder、CollisionPipeline、世界与实体映射。collision、rigidBody、physicsBinding 与碰撞表示变更进入物理签名，`sync` 重建同一世界的新代次 |
| 环境与动态 OBJ | ✅（按用途消费） | 静态 OBJ 保留原始三角面与空腔；动态 OBJ 仅按明确凸件策略逐 part 装配凸件，动态 triangle_mesh/环境绑定明确拒绝。派生几何已经是 Z-up 米制，不重复应用视觉 GLB 的源坐标转换 |
| 碰撞变换与质量 | ✅（有明确边界） | OBJ 顶点消费完整父链仿射变换，镜像会修正面朝向；primitive 支持保持形状的缩放/旋转，剪切与球/胶囊非均匀缩放明确拒绝。动态体须有正 `massKg`，`massScalePolicy=density` 乘真实变换行列式；惯性和质心从实际几何计算 |
| 无原生源也无 Scene collision 的实体 | ⚠️ 跳过 + 结构化告警 | `handle.warnings[].code = ENTITY_SKIPPED_NO_NATIVE_SOURCE`；帧里仍给出 Scene 位姿，不假装被模拟。原生源与 Scene collision 同时声明时，原生碰撞优先并返回 `SCENE_COLLISION_IGNORED_NATIVE_SOURCE` |
| SDF、逐体关闭重力与补丁绑定 | ❌ | Scene SDF、动态 `gravityEnabled=false`、需要 collisionPatches 的 mesh binding 明确返回 `UNSUPPORTED_CAPABILITY`；缺尺寸不造默认盒，缺 OBJ 不用包围盒代替 |
| 含 mesh 资产的 MJCF/URDF | ✅（依赖缺失时明确报错） | 本机独立环境**已装** Newton 的 `importers` extra（实测 `trimesh 5.1.0`），带 `<mesh>` 的模型**真的能导入**：`materials/robots/franka_panda/franka_emika_panda/panda_nohand.xml` 实测 `open` → `status="ready"`、`warnings=[]`、`describe` 给出 7 关节 / 60 形状；只有依赖**真的缺失**时才返回 `PROVIDER_DEPENDENCY_MISSING` 并给出安装方式，不降级成「场景非法」 |
| 原生 MPM 水粒子 | ✅，独立模式 | 同 pin SolverImplicitMPM；静态原生容器碰撞、同帧世界坐标粒子与材料读回；不执行机器人动作，不冒充 XPBD 刚体 |
| `execute`（joint / trajectory / control） | ✅，按源能力 | 单自由度位置 PD，保留源 kp/kv 和 joint/ctrlrange。trajectory 须覆盖全部受控关节；control 仅 manual 且精确推进 stepCount 步。其他 7 种动作仍返回 ACTION_UNSUPPORTED |
| `observe(contacts/penetrations)` | ✅ | 距离与接触点来自原生 eval_rigid_contact_kinematics；负距离按 shape 对聚合。XPBD 的 forceN 来自 update_contacts，为原生冲量/dt 近似值，世界坐标下 shape1 对 shape0 的力；首帧或 semi 没有力读数 |
| `capture` / `capture_multi` / `camera_list` | ✅，显式命名源相机 | 原生 SensorTiledCamera 消费当前 Newton shapes/particles；RGB PNG 与轴向米制 float32 NPY，提供源 K、外参、frameId；多视图内部不推进物理 |
| `camera_adjust` / `camera_project_annotation` / `camera_dataset_export` | ❌ | 临时相机覆盖、标注与数据集导出继续返回 UNSUPPORTED_CAPABILITY |
| `assist`（附着/辅助写回） | ❌ | 返回 `UNSUPPORTED_CAPABILITY` |
| `collisionPatches`（splat 场景碰撞编译） | ❌ | 传入即 `UNSUPPORTED_CAPABILITY`；本包**不含** sim-mujoco 的 splat 碰撞编译器 |
| 首步前暂停 / 暂停继续 | ✅ | startPaused:true 在首步前暂停；WorldHandle.supportsPause=true，status/Frame.worldStatus 如实给 paused。set_paused 校验代次，只改变同世界暂停状态，不重建；继续后不补跑暂停期间墙钟时间 |
| manual 时钟 | ✅，按动作推进 | 继续后且有已接受动作才推进；空闲或停止后冻结。未来 startStep 会推进到排程开始，未开始动作的 appliedSteps=0 |
| `stop` | ✅ | 已开始动作取消并把参考保持在当前实测位置，不清零刚体速度；未开始动作不写控制。回执记录 appliedSteps、lastAppliedPositions、holdReference；停止不代表瞬时静止 |
| `receipt` | ✅ | accepted/running/completed/cancelled/failed 终态与真实 finalState。重建成功先取消旧动作；失败保留旧世界及动作；旧代次 stop 不触碰新模型 |

完整能力表由 worker 的 `ready` 事件与 `capabilities` 方法原样交出（`supported` / `unsupported` / `notes`），
并随 `WorldHandle.capabilities` 到达调用方。ready / capabilities 给 Provider 总能力，WorldHandle 按当前世界是否有可驱动源执行器报告 execute / manualClockAdvance；`capabilities` 还带
`kernelCacheDir` 与 `kernelCacheNote`（**实际生效**目录 + 配置基目录及其来源；两者同名不同义，见下）。

**入口不等于能力**：`--engine newton`（开发 YAML 的 `engine: newton`、桌面/建筑入口、`ui_engine_switch`、
SDK 解释器解析）说明的是"这个引擎能被装配"，**不是**"装配后动作/相机/接触/assist 可用"。装配由
`script/runtime-patch.ts` 的 `sim-newton` 分支完成（`cacheRoot=<sceneRoot>/provider-cache/newton`），
装配后能做什么只有上面这份自报说了算；入口侧面向人的措辞归各入口自己的文件，本包不复制第二份。

## 源控制与结果含义

动作必须使用 `robot_describe` 返回的原生完整关节名，不能假定源短名在导入后保持。Newton 的归一化 MJCF 执行器元数据用于判定控制模式，不从非零刚度猜执行器。当前仅接通 gear=1、无激活动态、单一关节级位置 PD。源有限 forcerange / joint effort limit、混合执行器、velocity / torque、URDF 无可核验执行器元数据等明确拒绝；不改源物理来开放能力。显式 `semi` 的位置动作也保持关闭，当前动作验收对象为 XPBD。

`joint` 和 `trajectory` 在窗口内插值原生位置参考，窗口结束即返回 completed；`targetReached` 另按实测坐标与容差判断，不把 completed 当作到位或任务成功。`control` 保持参考且仅推进请求整数步。XPBD 本身的 armature、joint friction、effort limit 等限制沿用当前 pin 的原生限制，不由适配器补造。

接触列表来自碰撞管线的原生流形候选；正距离表示间隙，负距离表示穿透。forceN 是原生 XPBD 求解器估计，不是独立力传感器；不据此宣称抓取成功。停止撤销动作后仍保留正常动力学惯性，manual 模式因没有活动动作才停止推进。

英文说明：Only verified scalar source position PD drives are enabled. Actions preserve source gains and ranges. STOP holds measured position references without zeroing physical velocity. Completion is distinct from target convergence. XPBD contact forces are solver approximations.

## 原生 MPM 水例

实体直接保存以下原生模式声明；其他实体可提供 RC2 既有的静态 Scene collision 或固定 MJCF/URDF 碰撞体；共用原装配与地面/重力合同。water 实体的 transform 决定粒子网格初始世界位姿，单位为米，scale 必须为 1。

```json
{"components":{"newton":{"mpm":{"kind":"water","dimensions":[3,3,3],"spacingM":0.03,"densityKgM3":1000,"viscosityPaS":0,"youngModulusPa":1000000000000000,"poissonRatio":0.3,"voxelSizeM":0.06}}}}
```

`dimensions` 是三个正整数，`spacingM` 是格点间距，单粒子质量为 `densityKgM3 × spacingM³`，原生半径为间距的一半。`youngModulusPa` 与 `poissonRatio` 对应原生 `model.mpm.young_modulus/poisson_ratio`；在水例里用于 MPM 压缩响应。水例沿用同 pin `example_mpm_water_dam_break.py` 的零摩擦、零偏应力屈服强度、tensile_yield_ratio=1 与粘度参数，不将 E/nu 表述为液体实体的杨氏弹性。

该切片使用原生 dense grid，原生水例的 P0 应变基、pic 碰撞基、Q1 速度基。`voxelSizeM` 控制求解网格；没有另设物理循环。`clock:"realtime"` 在明确继续后真推进；startPaused 与后续暂停使用同一原生状态，采集不推进时间。manual 模式明确告警并冻结（未接通该模式的动作推进入口）。动态自由/关节刚体作为容器时明确拒绝，不静默冻结机器人或假称双向耦合。

`Frame.entities[].dynamicGeometry` 的 particles 项直接来自当前原生 `state.particle_q`，positionsM 是扁平 xyz 世界坐标，radiusM 来自原生粒子半径，nativeName 在重建前后稳定。同一 Frame 的 world/generation/revision/step/simTime 标明数据归属。`sensors.nativePhysics` 从原生模型/求解器回读粒子数、网格、材料和初始格点质量对应的静止密度；不从请求原文回显材料假装已应用。

材料与尺寸变化进入原有 physics_signature → sim_sync 原子重建；失败保留旧世界。components 声明可随现有 Scene 保存重开。MPM 不输出刚体 Contacts 数据；未接通逐粒子碰撞力观测或动态机器人耦合。相机采集会原生渲染当前粒子，并附同一步的真实粒子 Frame；Viewer 的粒子显示与原生采集分别验收。

英文说明：Water uses the pinned native SolverImplicitMPM with dense grids and static colliders. Particle positions and material values are read from native state/model. E and nu control MPM compressive response. Robot actions and rigid Contacts observations are disabled in this mode. Realtime advances the fluid; manual mode is explicitly frozen.

## 原生命名相机

MJCF 的命名 fixed 透视相机由已装 MuJoCo parser 读取 include/default、原生局部位姿与 K；不使用 MuJoCo 求解。挂载 body 在该实体的 Newton bodyStart/bodyEnd 内按完整祖先标签精确匹配，外参随当前 `state_a.body_q` 更新。tracking/targetbody、orthographic 与不明确的 body 匹配保持不可用。

Scene 相机沿用 `components.camera` 或保存的 `components.viewerCamera.cameras[].state`。调用 camera_list 选择返回的命名相机，再请求 capture / capture_multi；不提供任意自由机位兜底。K 按整数像素中心缩放，保留非方形像素和主点。深度为沿相机 -Z 轴的米制深度，depth<=0 表示未命中，不解释为欧氏射线距离。

每次采集对同一原生 state refit 形状与粒子 BVH 后渲染，图像与 observation 的 frameId 一致，多视图调用内没有 tick。MPM observation 不请求不存在的刚体 Contacts，仍包含真实粒子与 WorldPhysics。成功重建、fault、close 释放旧管理器；失败编译保留旧模型及相机。会话媒体仍走现有 transport 暂存、授权核对、发布与 URI 回写，不绕开用户文件模式。

英文说明：Named native cameras render current Newton shapes and particles. RGB and axial metric depth share the same physical state; multi-view capture never advances the clock. Unsupported tracking, distortion, overrides, annotations, and dataset export are rejected explicitly.

## 设备选择与降级

`auto`（默认）→ 有 CUDA 设备用 `cuda:0`，**没有则自动降级 `cpu`**（`handle.deviceDegraded=true` + `handle.deviceNote` 说明原因）。
显式指定 `cpu` / `cuda:N` 时**不静默顶替**：设备不可用即 `UNSUPPORTED_CAPABILITY`。

历史无 NVIDIA 驱动环境（`wp.get_cuda_devices()` 为空）的实测原文：

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
- **受限源位置驱动**：joint / trajectory / control 只接通已核验的单自由度、gear=1、无激活动态、单一位置 PD，保留源增益与 joint/ctrlrange；其余执行器按前述边界拒绝。暂停时可受理动作，但不写目标或推进物理，继续后才执行；stop 可取消并保持实测参考。
- **MJCF 根的摆放**：实体 MJCF 用 `xform = Scene 世界位姿` 导入，与 MJCF 自身内部姿态**复合**
  （`add_mjcf` 的默认语义，与 sim-mujoco 的 `spec.attach` 一致）；实体 `scale != [1,1,1]` 明确拒绝。
- **单一地面来源**：未编辑的默认模板 Collider 让位给实测同位置的原生静态 plane；`groundSources` 记录真实来源，不叠不可管理的隐式地面。无限 plane 由 `add_shape_plane(width=0,length=0)` 表达；有限用户 plane 仍保留明确的宽/长。
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
