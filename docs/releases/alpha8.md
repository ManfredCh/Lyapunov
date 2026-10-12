# Lyapunov Alpha8

Alpha8 将现有三种引擎的原生状态、材料参数与桌面工作流继续接通，并修复世界关闭失败后的重试问题。版本为0.1.0-alpha.8，属于预发布版本；SDK仍固定为现有RC2底座。

## 本版变更

- 修复 Issue #1 描述的 WORLD_CLOSING 故障：关闭尝试失败后可正常重试，成功后清理世界与附加缓存，并发关闭继续共享同一在途请求。
- Newton 增加已核验源位置PD驱动的受限关节／轨迹／手动控制、实际停止和接触读回；新建世界可在首步前暂停，并沿原入口继续／暂停。原生命名相机从同一物理状态采集RGB-D，不推进物理时间。
- MuJoCo 接通原生flex弹性体与实体cable的材料参数、动态形变及接触；保留MJCF源文件、原生插件和便携工程。普通tendon不视作实体缆线。
- Isaac 接通现有USD可变形体与PBD粒子液体的原生参数和同帧节点／粒子读回；Newton water MPM沿原生求解与静态容器工作，不以刚体动画代替液体。
- 桌面“原生物理参数”与已有代理工具共用局部材料修改路径，保全完整组件、原生文档与资源。修改后同步并读回实际参数，再保存重开；声明保存不冒引擎已应用。
- 自动检查点限定所选工程目录，准备过程支持原生取消，保留原有恢复数据和版本冲突处理。

## 安装与使用

Linux x64安装器继续使用版本化安装、正常默认MuJoCo CPU runtime和原有回滚入口。其它引擎按选择加载，Isaac仍需要有效的本机SDK与GPU，不要求三个引擎同时启动。

选择实际对象后，在原生参数面板保存并等待同步，核对当前帧实值。自然语言材料任务沿scene_physics_update的native入参分支修改完整实体，再经sim_sync与robot_state读回。保存工程保留源文件和参数，重开从源初值开始。

## 已验范围与边界

本次实现证据覆盖MuJoCo原生flex／cable、Newton受限源位置控制／静态容器water MPM／原生相机，以及Isaac两块8节点软硬体和64个PBD粒子的限定GPU案例。本机X11正式工作流已完成实际材料40000 Pa、同步读回、另存重开、设置布局和正常退出；Ubuntu26.04安装层、精确发行CI与下载读回由该版本发布回执分别记录。

water MPM的Young／Poisson用于原生压缩响应，不表示液体具有弹性固体本构。动态机器人与MPM耦合、逐粒子碰撞力、任意外部USD依赖、磁场／磁流体及更广引擎API留待后续。界面视觉设计与RC工作继续按后续阶段推进。

## English

Alpha8 connects more of the three existing engines' native state and material parameters to the desktop workflow and fixes retries after a world-close failure. The version is 0.1.0-alpha.8, a prerelease; the existing RC2 SDK remains pinned.

### Changes in this release

- Fix the WORLD_CLOSING failure described in Issue #1: a failed close attempt can be retried; successful closure removes the world and related caches. Concurrent closes still share one in-flight request.
- Newton adds restricted joint, trajectory and manual control for verified source position-PD drives, actual stop acknowledgement and contact readback. A new world can pause before its first step and resume or pause through the existing controls. Native named cameras capture RGB-D from the same physical state without advancing simulation time.
- MuJoCo connects native flex and physical cable materials, dynamic deformation and contacts while retaining MJCF sources, native plugins and portable projects. An ordinary tendon is not treated as a physical cable.
- Isaac connects native parameters and same-frame node or particle observations for existing USD deformables and PBD particle liquids. Newton water MPM uses its native solver and static container rather than rigid-body animation.
- The desktop native-physics panel and existing agent tools share a local material-edit path that preserves complete components, native documents and resources. Synchronize and read actual values before saving and reopening; saving a declaration does not prove engine application.
- Automatic checkpoints are scoped to the selected project directory. Preparation supports native cancellation while retaining existing recovery data and revision-conflict handling.

### Installation and use

The Linux x64 installer retains versioned installation, the normal default MuJoCo CPU runtime and the existing rollback path. Other engines load when selected. Isaac still requires a valid local SDK and GPU; all three engines do not need to start together.

Select the actual entity, save its native parameters, wait for synchronization and check current-frame values. Natural-language material edits use the native input branch of scene_physics_update, followed by sim_sync and robot_state. Project saving preserves sources and parameters; reopening starts from the source initial state.

### Verified scope and boundaries

Implementation evidence covers native MuJoCo flex and cable, restricted Newton source-position control, static-container water MPM and native cameras, plus the limited Isaac GPU case with two eight-node soft/stiff bodies and 64 PBD particles. The normal local X11 workflow has completed actual 40000 Pa material application, synchronization and readback, Save As and reopen, settings layout and clean exit. Ubuntu 26.04 installation, exact release CI and download readback are recorded separately in this version's release receipts.

Young's modulus and Poisson's ratio in water MPM control native compression response; they do not give the liquid an elastic-solid constitutive model. Dynamic robot/MPM coupling, per-particle collision forces, arbitrary external USD dependencies, magnetic fields or magnetohydrodynamics and broader engine APIs remain future work. Visual-design and RC work continue in their next phase.
