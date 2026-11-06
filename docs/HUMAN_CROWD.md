# 人体创建与运动

人体能力由 `human-crowd` 插件提供，人工入口位于原有物件清单的「创建或导入人体」，单人或群组选择后在属性内使用「人体动作」。模型 Tool 与人工 Command 共用相同 operation。

支持 `human_catalog`、`human_catalog_spawn`、`crowd_spawn`、`human_import`、`crowd_configure`、`crowd_start`、`crowd_stop`、`crowd_inspect`。

`crowd_configure` 的 `preset` 与显式 `route` 互斥（同给报 `HUMAN_ROUTE_PRESET_CONFLICT`）：`back-and-forth` 从每人当前位置沿其朝向往返 `distanceM` 米（默认 2，0.5–20）；`square-loop` 以当前位置为角、沿朝向与左侧走 `distanceM` 边长的方块；`idle` 原地站立（定义含 `Idle` 动作时启用该 clip）。三类都在一次 Scene commit 内为范围内每个人分别生成路线；`speedMps`/`clip` 沿用该人现有 route，没有 route 时用其定义所属随包内置角色的 `walkSpeedMps`/`walkClip`，取不到具名拒绝（`HUMAN_PRESET_DEFAULTS_MISSING`），其余 route 字段沿用现值。**不提供跑步预设**：Run clip 未经接地/步幅校准，不能保证不滑步。创建或配置提交 Scene 后，必须同步物理世界；不逐帧改写 Scene。人体在当前 Provider 的唯一物理 tick 内采样，Frame 携带实际 body/site/geom 读回、物理步号和时间。Viewer 的蒙皮骨骼只消费这些读数，关闭人体的墙钟 AnimationMixer。

每个群组把不可变骨架、动作和碰撞映射保存在一份带 `resourceId/version` 的 Scene 资源投影中，实例保存该定义的引用、独立相位、模式及路径。原始自包含 GLB 和许可登记在现有 ResourceLibrary；没有第二套资产索引。

运动学模式支持站立、行走、跑步、限角速转向、闭合路径循环、终点停留、按显式优先级让行，以及基于原生几何射线的保守停障。显式启用navigation可在固定Z平面自动绕行；未启用时保守停障，人物不会自然受力跌倒。关闭 `avoidObstacles` 可以检验不让行接触，但运动学体与固定基座相互顶压可能产生极大非物理接触力，不能作为人体接触质量合格结论。

`mode=ragdoll` 是自由根加球关节的原生动力学人偶，只接受有界外力和自由运动；它不具备平衡行走或跌倒恢复控制器。后两项仍缺经许可和型号匹配的控制器/权重，本轮未训练、未下载外部模型。Isaac CPU/rendering:none 已适配基础运动学路径、原生 PhysX 停障与停止；平面A*、ragdoll、RTX/CUDA分别返回 `HUMAN_ISAAC_NAVIGATION_UNSUPPORTED`、`HUMAN_ISAAC_RAGDOLL_UNSUPPORTED`、`HUMAN_ISAAC_DEVICE_UNSUPPORTED`，不静默回退或删除配置。

角色导入要求：自包含 GLB、1 至 8 个共享骨架的 skin、米制骨架、显式使用许可、语义骨映射，最多128个骨节点和32MiB。支持LINEAR/STEP旋转和平移clip，可分解父矩阵/正均匀尺度、显式源单位和前向校准；保留髋部起伏与横摆，仅分离净水平根漂移。尺度浮点噪声显式归一化并报告，真实伸缩、CUBICSPLINE和压缩扩展仍拒绝。由 `pelvis/spine/chest/neck/head` 和左右 `Hip/Knee/Ankle/Toe/Shoulder/Elbow/Wrist` 映射到原骨名。源 Y-up 在导入时转换为 Z-up。原创样例是低多边形蒙皮人偶，不称为逼真扫描人体。程序化步态有足滑和离散停步，不声称动作捕捉质量。

在仓库根复跑：

```bash
bun run test:ci --filter packages/human-crowd/
LYAPUNOV_MUJOCO_PYTHON=/绝对路径/sim-python/bin/python \
MUJOCO_GL=osmesa bun run packages/human-crowd/scripts/native-scene.ts /绝对输出目录
```

原生脚本输出 `scene.json`、`world.json`、`samples.json`、`frames.jsonl`、30组引擎 RGB PNG 与米制 depth NPY、`summary.json`。RGB-D 来自 MuJoCo 胶囊分段碰撞外观；Viewer 使用 GLB 蒙皮，两者外观来源分开。需要连续视频时可使用已安装的 ffmpeg 从各采样 PNG 编码，保留同帧 JSON。该脚本不启动现有用户 Host，不写入共享运行目录。

手动示例命令（Command 输入直接为业务 JSON）：

```json
{"sceneId":"当前场景ID","expectedRevision":0,"count":1,"seed":42,"region":{"min":[-2,0,0],"max":[-2,0,0]},"route":{"pointsM":[[2,0,0]],"speedMps":1.2,"behavior":"walk","avoidObstacles":true}}
```

先用 `crowd_spawn` 返回的实体或群组 ID，然后 `sim_sync`，再执行 `crowd_start`，传入当前 `worldId`、`expectedGeneration`、`sceneId`、`entityIds` 或 `groupId`、`durationS`。`crowd_stop` 只撤销选中人物控制，保留最后实际姿态；世界、其他人物和录制不受影响。

逐tick原生回归和有界性能脚本：

```bash
LYAPUNOV_MUJOCO_PYTHON=/绝对路径/sim-python/bin/python \
MUJOCO_GL=osmesa node --experimental-strip-types --test packages/human-crowd/test/native.test.ts
/绝对路径/sim-python/bin/python packages/human-crowd/scripts/native-performance.py \
  /绝对路径/scene.json --count 20 --collision coarse --steps 10 --output /绝对输出路径/performance.json
```

初版粗碰撞300人触发原生碰撞栈内存失败；无碰撞骨骼标记收敛为原生site后粗模式降到2body/人。本轮继续合批编译、采样、停障粗筛与接触观测，20人详细模式原生执行已明显加快，100/300人仍低于实时；1000短窗口可执行，较长压力档仍超时。真实20人+Panda+Viewer帧流仍低于实时，详见[性能配置、实测与复跑](HUMAN_PERFORMANCE.md)。创建上限不是引擎运行容量保证；人物按物理重要性显式选择 `detailed/coarse`，不依据用户相机距离自动降低碰撞。

原创程序化步态共享128相位采样表并线性插值（缓存上限16种定义/速度/动作组合）；根路径仍按精确物理步推进，外部导入clip保持原始track采样。骨骼标记读自原生site_xpos/site_xmat，真实分段碰撞读自geom_xpos/geom_xmat；ragdoll关节仍读原生body。

学习控制器的边界来自上游原始说明：[MimicKit](https://github.com/xbpeng/MimicKit)公开模型需要匹配其角色XML、关节顺序和观测/控制配置；[ProtoMotions](https://github.com/NVlabs/ProtoMotions)区分Apache-2.0源码、NVIDIA模型许可和第三方资产许可。本插件原创球关节人偶尚无匹配的执行器/观测适配、平衡及恢复权重；不能直接载入这些权重声称能力已就绪。本轮未进行训练或下载模型。已安装G1权重CPU推理、原创人体实际执行器检查以及官方MimicKit具体对象/访问阻断见[高级控制核查](HUMAN_CONTROL_AUDIT.md)。

在人物属性勾选「自动绕障（固定高度平面）」后，`route.navigation` 声明显式平面边界，例如：

```json
{"pointsM":[[3,0,0]],"speedMps":1.0,"behavior":"walk","yieldToHumans":true,"navigation":{"bounds":{"min":[-1,-2],"max":[4,2]},"cellSizeM":0.25,"clearanceM":0.65}}
```

导航从同一原生物理时刻的 `geom_aabb/geom_xpos/geom_xmat` 构造保守占用网格，纳入其他人物实际根位置，以有界8邻域A*和线段检查生成绕行。最多4096节点，最小安全间隙0.65米。暂时无路时保留具名 `blocked`；阻塞持续或人物让行时每0.5模拟秒重算，不另起时钟/作业循环。动作的总时限和手动停止仍然有效。狭窄通路可能被保守AABB拒绝，斜坡、台阶和跨楼层路径明确拒绝，不宣称全地形导航或ORCA能力。

原生回归已覆盖：真实墙体绕行到达、站立人物占道时绕行、初始无路后阻塞人物通过真实物理动作移开，等待者自动重规划并到达。未显式启用navigation时继续采用保守停障，保留已有直接路径行为。

Isaac与原生USD资产的同世界复跑（仅使用已安装且已有许可确认的SDK）：

```bash
LYAPUNOV_ISAAC_PYTHON=/绝对路径/isaac/bin/python \
LYAPUNOV_USD_PYTHON=/绝对路径/usd-core/bin/python \
node --experimental-strip-types --test packages/human-crowd/test/isaac-native.test.ts

LYAPUNOV_ISAAC_PYTHON=/绝对路径/isaac/bin/python \
LYAPUNOV_USD_PYTHON=/绝对路径/usd-core/bin/python \
bun run packages/human-crowd/scripts/isaac-human-usd.ts /全新绝对输出目录
```

该脚本生成原生USD静态、关节和自由刚体资产，与同一Scene中的蒙皮人体一起运行；检查真实PhysX `RigidBodyView.set_kinematic_targets`、默认停障、原生接触、共享暂停/停止、同帧Viewer骨骼/原生USD投影以及高级能力拒绝。输出 `receipt.json`、`frames.jsonl` 和portable场景，关闭时等待自己创建的worker并记录closed。CPU/none不提供RTX RGB-D证据；Three.js蒙皮与原生PhysX分段外观来源继续分别标注。

真实外部Khronos CesiumMan的固定许可/版本、矩阵/平移/根运动兼容、两Provider实测与共享Viewer对照见 [外部角色样例](HUMAN_EXTERNAL_CHARACTER.md)。


## 随包真人角色与混合创建

「创建或导入人体」的角色选择提供用户确认的 12 个 Microsoft Rocketbox 成人角色，许可为 MIT：Female_Adult_01、Female_Adult_05、Female_Adult_07、Female_Adult_10、Female_Adult_12、Female_Adult_16、Male_Adult_01、Male_Adult_04、Male_Adult_10、Male_Adult_15、Male_Adult_20、Male_Adult_21。默认选择四种外观混合，默认数量为 20；内置角色的默认示例按人数分散为4×2米网格，每人从各自起点沿X往返2米，20人为20×8米区域；也可以选择一个内置角色、当前 Scene 的已导入模板，或显式选择原创占位预览。

人工按钮与 Agent 使用同一个 `human_catalog_spawn` operation。内置目录只提供固定来源与动作预设，导入后的身份、版本和文件仍由当前会话 ResourceLibrary 维护。模板复用同时核对 GLB SHA、许可、轴向、单位、前向与骨映射；用户以不同校准导入的同一 GLB 保留独立模板，不被内置预设偷复用。操作仅创建共享模板及指定数量的人物，不额外放置示例人物；每种模板只有一份完整骨架和动作，所有实例保留独立相位。默认混合使用 Female_Adult_01、Female_Adult_12、Male_Adult_01、Male_Adult_10，各自从经过验证的 manifest 读取 `walkSpeedMps`、`walkClip`、轴向、前向及 GLB 内两足校准。显式提供 `route` 时保留整个原世界路径对象，不补 `loop` 或 `clip`；省略可选字段时继续由原控制器解释，不将其改成各自往返；默认分散示例的region太小会在写入前具名拒绝。源缺失、SHA 不符或许可缺失会具名失败，不改用占位人偶。若导入模板后遇到 Scene 写入冲突，回执标为 `partial` 并保留已保存的模板。

Command 示例（创建后仍须 `sim_sync`，再沿现有 `crowd_start` 执行）：

```json
{"sceneId":"当前场景ID","expectedRevision":0,"count":20,"seed":42,"region":{"min":[-10,-4,0],"max":[10,4,0]}}
```

上述对象交给 `human_catalog_spawn`，省略 `avatarIds` 使用默认四角色；设置 `"avatarIds":["Male_Adult_04"]` 创建旧角色。`human_catalog` 返回随包角色的只读来源预设。已有模板也可通过 `crowd_spawn.templateEntityIds` 在同一次 Scene 提交中混合创建，单一 `templateEntityId` 保持原有行为。

发行构建从 `LYAPUNOV_HUMAN_AVATAR_STAGING_ROOT` 指定的冻结资源根收集（默认源码根 `.runtime/human-avatar-sources`），该根的 `manifest.json` 必须准确列出全部 12 件，并以相对 `gallery` 目录提供 12 张官方原 PNG、`candidates.json` 和原始 MIT 许可。`script/human-avatar-resources.ts` 在复制前逐件检查 GLB 字节/SHA、固定来源 revision、MIT 原文 SHA、实际动作、两足校准及纹理自含闭包；缺件即停止打包。载荷放在 `packages/human-crowd/assets/rocketbox/`，包含最终 GLB、12 张官方原 PNG 预览、原始 MIT 许可、来源逐件哈希及校准证据。PNG 逐件检查原字节/SHA/Git blob，catalog 的 `preview` 路径相对包内目录；上游预览不作为本项目 World 或 GPU 运行证据。原始大 FBX/TGA 不进入发行包，目录 JSON 不保留构建机绝对路径。产品从插件自身的相对目录读取这些资源，离线导入后 portable 保存会将资源闭包交给现有 Scene 保存逻辑。

代码夹具验证、真实角色导入、实际 World 动作、界面视觉及完整发行包离线启动属于不同证据层。目录与自动化检查通过不代表 RTX 实时、无脚滑或真实安装已验收；真实结果按本次发布与资产回执分别记录。
