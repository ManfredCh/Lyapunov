# 人群合批与性能回执（2026-10-28）

记录时间：2026-10-28 23:02（新加坡时间）。本轮状态为**部分完成**。MuJoCo程序化运动学人体已在唯一物理tick中合批采样和写入原生mocap/site；20人详细碰撞的原生执行明显加快。真实Provider→Frame流→共享Viewer也已连通。最终20人+Panda、面板两点闭合loop、6s/3000tick、默认停障及完整观测的Provider最新RTF为**0.22245**（477帧、closed=true），整体仍为**PARTIAL**；0.3195仅是中间实测，不能用原生或组件RTF代替产品实时率。

## 保留的物理语义

- `timestepS=0.002`，没有改变碰撞几何、body/site数量、contype/conaffinity或传感器来源。详细模式仍14段/人，粗模式仍1段/人，用户显式选择。
- 编译时共享同一资源定义的rig/clip/映射校验；每人先在小型MjSpec中装配，再原生attach到同一个模型。原生名字与双精度参数保留，不经MuJoCo默认六位精度的XML导出。
- 程序化、运动学、无clip/平面导航/互让的成员共享NumPy采样计算；路径、相位、控制窗口仍属现有World动作。外部clip、ragdoll、复杂导航/互让走原有标量路径。混合batch里机器人照常执行。
- 默认停障仍使用原生ray。仅当当前原生geom_aabb/xpos/xmat投影证明本步保守前探范围不相交时跳过查询；非水平plane/flex继续原查询。人体本身和同类在ray交点中排除，默认RGB-D可见组不变。
- 同步batch共享动作接纳步的原生起点快照；每成员接触历史独立。同一步全部成员共享一次真实contact遍历和mj_contactForce读数，不跨步缓存。暂停、选择停止、generation重建仍清控制，短成员不会被长成员延长。

## 原生测点

固定候选的完整命令、退出码和JSON位于本工作树 `.runtime/human-performance-continue/final/commands.json`；日志与同名JSON在同目录。各档默认粗碰撞、均匀1.5m间隔、无机器人/互让、500测量步+50预热、dt=.002，Frame输出配置1Hz，包含动作完成回执开销。不是密集交互人群容量承诺。

| 人数 | 实际步数 | 原生RTF | 编译秒 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 1 | 550 | 9.3605 | 0.012 | exit 0 |
| 20 | 550 | 3.1074 | 0.039 | exit 0 |
| 100 | 550 | 0.8654 | 0.272 | exit 0，低于实时 |
| 300 | 550 | 0.2210 | 1.529 | exit 0，低于实时 |
| 1000 | 未完成550步 | 不报通过RTF | 未完成本档 | 50s门exit 124 |

另外保留1000人的短压力测点 `.runtime/human-performance-continue/attach1000.json`：编译28.453s、实际15步、RTF0.01344、1001个可碰撞geom、2001 body、约226MiB峰值RSS，exit 0。它只证明有界短窗口真实执行，不能替代上表失败的较长档位。此前直接全局add_site的1000编译超时、faulthandler堆栈和独立小MjSpec探针均保留在同目录。

20人详细模式（281个可碰撞geom，无机器人、默认停障、30Hz真实JSON编码）早期同机固定基线29d028c4为RTF0.1767，优化测点为1.8948；两者mask SHA均为`0df5e2111e26b32ce7fb99e1d40e2f96befa8035b71e46234ddedfeb34e6447a`。原生输出按现有墙钟节流，较慢基线会编码更多帧，因此JSON消息数也记录在回执；不把这个比值全部归给骨骼采样。最终同配置复跑的`before20-detail/after20-detail`为0.2235→1.6047，`before20-panda/after20-panda`为0.1907→0.9519；后者有真实Panda和相同碰撞mask，距离稳定实时仍缺余量，不能只引用早期更快样本。两组回执和消息数单独保留。

## 真实Provider与Viewer

`performance-live.ts`创建20个详细碰撞人物和真实Panda资产，沿同一个有界batch执行6s人体路径及Panda关节动作；由MuJoCoProvider真实Frame经本地WebSocket传给产品共享SceneViewer，调用setWorld/pushFrame，未使用离线回放或AnimationMixer。所有资源仅服务本案例已登记的GLB与Panda依赖闭包。

本线 `.runtime/human-performance-live4-20261028/` 保存Scene、322个真实Frame、Frame#3000截图、原生动作回执与Viewer细分耗时。实际6s/3000tick，首人默认停障至x=-0.7056m、blockedS=5.382，其他人物行走且Panda运动，Viewer零帧拒收、零报错，Provider已关闭。

该场景整链RTF为0.3633，标为PARTIAL。保存时Viewer滚动样本的applyFrame均值约5.84ms、renderer.render均值约52.3ms；WebGL实测为Intel Mesa硬件，画布1874×826，约138570三角形。样本包含运行及结束后静态展示，不能当严格六秒窗口的FPS。机器另有非本线长时SwiftShader进程占CPU，未终止；此事实也不把未达标结果改成通过。Panda-only与1/20人相同相机/质量的渲染对照继续补充，以区分基础机器人渲染和新增人群开销。

在仓库根复跑：

```bash
# 先生成合法共享资源与Scene，不启动物理/浏览器。
bun run packages/human-crowd/scripts/performance-live.ts \
  --prepare-only --out /全新绝对目录/performance-fixture

# 原生有界测点；可加--panda --avoid-obstacles --frame-hz 30 --serialize-output。
timeout --signal=TERM 50s /已有解释器/sim-python/bin/python \
  packages/human-crowd/scripts/native-performance.py \
  /全新绝对目录/performance-fixture/scene.json \
  --count 20 --collision detailed --steps 500 --warmup-steps 50 \
  --avoid-obstacles --frame-hz 30 --serialize-output \
  --output /绝对输出目录/performance.json

# 真实流：打开输出的localhost地址，等待“已就绪”，点“运行6秒实测”，结束后保存证据。
LYAPUNOV_MUJOCO_PYTHON=/已有解释器/sim-python/bin/python \
  bun run packages/human-crowd/scripts/performance-live.ts \
  --out /全新绝对目录/live --port 16492
```

性能脚本只有在actualSteps等于请求总步数且动作status=completed时才计算通过RTF；失败返回exit 1或外部超时124，避免把零步失败误记成极高实时率。RTF含真实World.tick及选择的JSON编码，不包含浏览器时明确给viewerFrameTimeMs=null。正式脚本会关闭World；真实流动作结束后dispose Provider，服务器保留用于读取证据，SIGTERM/SIGINT只关闭自己创建的服务/Provider。

## 回归与本地CI

- `LYAPUNOV_MUJOCO_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/sim-python/bin/python MUJOCO_GL=osmesa node --experimental-transform-types --test packages/human-crowd/test/native.test.ts`：2/2、0skip、exit 0，内部15组，日志`/tmp/human-performance-native-final.log`。新增20人合批与原标量逐tick site/geom/body/动态状态严格对照、真实推动方块、选择停止、详细20人与运动Panda同步batch默认停障/零人体机器人接触。
- `TESTCI_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/conda/envs/isaac/bin/python bun run test:ci --filter packages/human-crowd/`：所选文件通过、exit 0，`/tmp/human-performance-ci-final.log`。
- 同解释器 `bun run test:ci --filter packages/sim-mujoco/`：本次CI分类选择3文件、全部通过、exit 0，`/tmp/human-performance-mujoco-ci.log`；其他需要原生环境的分类未冒称自动通过。
- `bun x tsc --noEmit`与`bun run script/build-plugins.ts human-crowd sim-mujoco`：exit 0，`/tmp/human-batch-tsc-final.log`、`/tmp/human-performance-build.log`。新增Python依赖是`packages/sim-mujoco/python/human_batch.py`，随原有worker源码目录交付。

Isaac高级适配、外部角色通道和此前UI走查没有新代码改动，本轮不重复它们冒充性能证据。主控独立验收尚待执行。

## 固定相机对照与worker分段计时（23:25，新加坡时间）

相机使用前述20人案例的同一position/quaternion/target/up/FOV/near/far，画布仍1874×826，质量默认值不变，阴影关闭。此处是手动物理世界step0的真实静态Frame，只隔离渲染代价，未冒充运行中的物理容量。每组保存后关闭自己创建的Provider。

| 场景 | draws | triangles | renderFrame均值ms | p95 ms |
| --- | ---: | ---: | ---: | ---: |
| Panda-only | 63 | 134970 | 4.46 | 11.3 |
| Panda+1人 | 64 | 135150 | 4.89 | 10.1 |
| Panda+20人 | 83 | 138570 | 10.35 | 21.9 |

证据在`.runtime/human-render-{panda,one,twenty2}-20261028/`。相同初始展示条件下，20人新增渲染开销约6ms，原直播52.3ms不能全部归给静态人群。三组FrameInterval均约217ms；只把本线tab带到前台后，20人静态FrameInterval约70.9ms，renderFrame均值7.48ms。前后样本分别保留`viewer-performance-before-front.json`和`viewer-performance.json`，没有改系统或浏览器全局设置。只读DOM确认visible/hidden=false/hasFocus=true。仍不能把当前浏览器渲染提交耗时当作稳定前台FPS。

20人追踪了实际SkinnedMesh的包围盒/球及skeleton.update调用；未发现每帧重复计算包围盒/球，skeleton.update每调用平均约.043ms。因此没有修改包围盒缓存，也没有用不正确的包围盒、隐藏角色或降低物理碰撞取巧。

复跑渲染对照（依次用count 0/1/20与独立输出目录，浏览器打开打印地址，保存证据）：

```bash
LYAPUNOV_MUJOCO_PYTHON=/已有解释器/sim-python/bin/python \
  bun run packages/human-crowd/scripts/performance-live.ts \
  --render-only --count 20 --view /已有live案例/viewer-performance.json \
  --out /全新绝对目录/render20 --port 16498
```

另用不改行为的`profile-worker.py`包裹真实NDJSON进程。前台真实流仍实际3000tick/6s、331帧、RTF.3541，Provider关闭；完全不打开浏览器、相同Panda动作和完整Frame内容的Provider对照为3000tick/6s、325帧、RTF.3597。因此差额主要还在worker计算与协议，不能都归给Viewer。

无浏览器对照的真实分段记录（存在嵌套，不求和冒充互斥CPU份额）：World.tick CPU11.713s/wall15.040s；human_batch.advance CPU5.675s/wall6.965s；observe CPU2.397s/wall2.994s，其中人体原生读回CPU1.510s、机器人authoring CPU.484s；NDJSON.emit CPU1.303s/wall1.796s；world_physics CPU.038s；refresh_derived CPU.537s；contact_summaries CPU.050s；实际人体ray CPU.311s。没有丢弃任何骨骼、传感器或Frame来提速。`observe`中通用geom/body全扫描分支要求Entity.components.collision，正常人体仅有HumanComponent.collision，因此不命中该分支；此处不做没有剖析依据的缓存改造。

原始记录在`.runtime/human-performance-live-profile-20261028/`和`.runtime/human-performance-provider-only-20261028/`的`worker-timing.json`、`receipt.json`，前者另有实际Viewer截图与`visibility.json`。包装脚本以已有解释器的bin放入PATH，`LYAPUNOV_MUJOCO_PYTHON`指向本仓`packages/human-crowd/scripts/profile-worker.py`，`LYAPUNOV_HUMAN_PROFILE_OUT`指定本轮绝对JSON输出；在正常dispose/shutdown退出时保存。它不修改物理时钟/采样/观测或控制配置。

## 常用闭合路线与当前步观测优化（23:50，新加坡时间）

后续窄切片覆盖面板默认`pointsM=[[3,0,0],[-3,0,0]], loop=true`的通用折线，不只优化单目标benchmark。缓存只属于当前有界动作的不可变折线/累计长度数组，按当前elapsed和逐成员进度批量选段、转向及处理loop/dwell。复杂导航、互让和外部clip保留标量路径。浮点端点附近继续用原标量段判定，选择停止使成员集合改变时重建该动作的派生数组，不跨world/generation保留。

新增20人默认两点loop、3000tick严格标量对照，含零长段、站立/空路径、端点停留、暂停、选择停止；保留`1e-9`门。首次在第2208步发现段方向旋转差1.819e-9（`/tmp/human-path-loop-native.log`），没有放宽阈值。更正：使用MuJoCo相同的atan2轴角构造，并按相同世界端点次序生成段姿态，避免原`1+unit.z`在近反向Z的消减误差；修复后原门通过（`/tmp/human-path-loop-native2.log`）。

固定85f5216f源码、相同20人+Panda、UI两点闭合loop、6s/3000tick、默认停障、完整Frame的Provider无浏览器对照：RTF .2240→.3195；线程CPU的human_batch.advance 9.064→6.657s、World.tick 19.728→13.701s。基线因较慢而按墙钟输出479帧，候选357帧，这个差异单独记录，不能把整体RTF比值都归于路径算术。证据为`.runtime/human-loop-before-85-20261028/`、`.runtime/human-loop-after-20261028/`及`.runtime/human-performance-continue/loop-provider-comparison.json`；两者均功能通过并关闭Provider，性能仍PARTIAL。

下一处观测成本优化只在bind时保留真实model/data数组视图及编译索引；每Frame仍按当前步批量读取所有骨骼/分段的位置、原生矩阵/四元数及实际geom_size，仍用原生mju_mat2Quat转换。没有缓存上一步姿态，也没有删除Frame/骨骼/分段/传感器字段。原生回归增加按实际名字重新查原生site/body/geom，与同Frame读数交叉核对到`1e-12`，覆盖运动、ragdoll、停止和重建。

该候选本地原生回归`/tmp/human-path-observe-native.log`为2/2、0skip、exit0，内部16组，约43s；包含原先暂停/停止/窗口/真实接触/默认RGB-D/保存重开门以及新增闭合loop。其余受影响CI与真实Provider结果随固定提交回收，主控独立验收仍单列。


## 最终固定候选回执（2026-10-29 00:02，新加坡时间）

最终不再新增性能切片。数组视图候选的最新完整Provider记录为RTF **0.2224528211**、26.972s墙钟、6s/3000tick、477个完整Frame、默认停障功能通过、closed=true，仍低于实时；此前.3195仅是中间实测。未改的原生mj_step线程CPU同时从.884增至1.114s，根路径等计算也存在当前整机吞吐变化。这里保留原始测量，不把差异掩去或改判通过。

为单独判断观测代码，在同一个真实World、同一物理步交替A/B顺序各500次读取20人的全部HumanPose，和固定85f5216f旧标量observe的每个字段严格相等。基线线程CPU1.37517s、缓存视图候选1.16834s，约15%削减；这是组件收益，不能替代上面的最终整链不足。实际脚本与原始记录分别是本线`.runtime/human-final-slice-receipt-20261028/observe-ab.py`、`observe-ab.json`，两组源码SHA已记录。

必要短证据已归入本线`.runtime/human-final-slice-receipt-20261028/`，不依赖`/tmp`唯一副本：`receipt.json`、各原生/类型/构建日志、两个CI所选结果摘要、基线/中间/最终三组完整Provider短回执与分段计时、同相机0/1/20人渲染图和数据。原始Frame流继续保存在各案例目录，不把大量帧/图像提交Git。

最终受影响检查均为exit 0：

| 命令/检查 | 本轮结果 |
| --- | --- |
| `LYAPUNOV_MUJOCO_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/sim-python/bin/python MUJOCO_GL=osmesa node --experimental-transform-types --test packages/human-crowd/test/native.test.ts` | 2/2、0skip，内部16组，严格默认loop/停止/窗口/接触/当前步读回通过 |
| `LYAPUNOV_ISAAC_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/conda/envs/isaac/bin/python LYAPUNOV_USD_PYTHON=/home/s18/WS/Lyapunov/.worktrees/simready-usd-20261028/.runtime/usd-python/bin/python node --experimental-transform-types --test packages/human-crowd/test/isaac-native.test.ts` | 1/1、0skip，同世界11组通过、closed=true |
| `TESTCI_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/conda/envs/isaac/bin/python bun run test:ci --filter packages/human-crowd/` | CI所选1文件通过 |
| 同环境 `bun run test:ci --filter packages/sim-mujoco/` | CI所选3文件通过 |
| `bun x tsc --noEmit` | 根配置覆盖的产品源码/测试通过；不冒称实验脚本全部单独类型检查 |
| `bun run script/build-plugins.ts human-crowd sim-mujoco` | 两插件构建通过 |

最终实际benchmark启动命令（从本工作树根执行；独立复跑时将out/计时JSON改为全新目录，端口改为空闲值）：

```bash
PATH=/home/s18/WS/Lyapunov/Dev/.runtime/sim-python/bin:$PATH \
LYAPUNOV_MUJOCO_PYTHON=/home/s18/WS/Lyapunov/.worktrees/human-crowd-20261028/packages/human-crowd/scripts/profile-worker.py \
LYAPUNOV_HUMAN_PROFILE_OUT=/home/s18/WS/Lyapunov/.worktrees/human-crowd-20261028/.runtime/human-loop-observe-20261028/worker-timing.json \
bun run packages/human-crowd/scripts/performance-live.ts \
  --ui-loop --out .runtime/human-loop-observe-20261028 --port 16508
```

该轮没有打开浏览器，通过本地`POST http://127.0.0.1:16508/run`启动相同产品Provider动作。UI复跑直接打开所打印地址，等待就绪后点击运行；只可将本线自己的tab带到前台并记录可见性/焦点，不改浏览器/系统全局设置。`--ui-loop`保留面板默认两点闭合路径；`--render-only --count 0/1/20 --view <已保存viewer-performance.json>`是明确标注的静态渲染对照，不能拿它作物理容量结果。正常结束会dispose并写短回执；服务器保留供查看证据，退出只关闭自己的服务。

语义修复包括近反向Z段方向四元数的数值稳定性与端点选段最后一位浮点判定；性能改动包括动作内折线派生数组和本model/data原生数组视图。没有改变物理步长、碰撞mask/精度、Frame内容、世界时钟或外部clip采样，没有新控制器、训练、下载或发布。主控独立验收与最终整合UI仍由主控报告。

## 2026-10-29：真实角色20人基准入口（仅准备，容量尚未测）

原performance-live.ts新增显式--asset/--source，固定最终7d9988角色，走公共importHuman→spawnCrowd(templateEntityId)并共享1份81骨定义/原资源；移除仅作为模板来源的原人物后实际恰20人，不是21人。摆位和路径通过Scene.commit保存，不绕Scene owner。原无资产调用保留占位基准兼容。固定配置仍为20人/每人14详细段/Panda、dt.002、6秒/3000tick、30Hz请求完整Frame、默认停障和UI两点闭合loop；真实WalkGrounded速度1.402372780m/s。

后续每轮保存逐人actualTravel/net displacement/blockedS/blockedFraction/movingTimeFraction，以及连续阻挡帧姿态保持误差。该Panda混合移动/阻挡场景不能推导20人持续自由行走容量。除原ProviderRTF外，另记录从点击Run到真实末帧capture的ViewerWallS/ViewerRTF；结束自动保存当前原生图和诊断，不重定时、不补帧。初始native step0就绪后才显示模型，避免加载绑定姿态闪现。profile包装不进入普通三轮。

准备已验证20人/1定义/81骨/实例无rig或clip副本、源7d9988、Panda、WalkGrounded两点loop。实际三轮须等主控释放Cua/CPU后运行，**本条不报告性能通过**。准确入口：

```bash
LYAPUNOV_MUJOCO_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/sim-python/bin/python \
bun run packages/human-crowd/scripts/performance-live.ts --ui-loop --count 20 \
  --asset /最终派生目录/Male_Adult_04-Grounded-Calibrated.glb \
  --source /最终派生目录/source.json --out /全新20人案例 --port 16660
```

Cua等ready后点运行，保持测试页前台直到结束，核对receipt.json/viewer-performance.json、末步3000和closed。三轮用不同新目录/端口，保留全部值；不用最快一轮代替分布。

## 2026-10-29：20真实角色+Panda三轮完整基线

固定提交`a089763d`，普通Mu worker（没有profile包装），最终真实7d9988角色，20人/1份81骨定义/每人14详细段/Panda、dt=0.002、6秒/3000tick、30Hz完整Frame请求、默认原生停障、原两点闭合loop、WalkGrounded速度1.402372780m/s。主控在三轮期间停止其SDK/CI/构建/Host和Cua操作；本线测试页前台visible/hasFocus均真。

**三轮性能均失败，不能标实时人群或完整目标完成。**

| 完成案例 | Provider墙钟秒 | Provider RTF | 末帧呈现墙钟秒 | Viewer RTF | 完整Frame | JSONL约MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| real20-baseline-01 | 134.817688 | 0.044505 | 154.815900 | 0.038756 | 1624 | 661.97 |
| real20-baseline-02-retry1 | 136.162233 | 0.044065 | 155.611900 | 0.038557 | 1637 | 667.28 |
| real20-baseline-03 | 137.597307 | 0.043606 | 157.108700 | 0.038190 | 1637 | 667.28 |

全部实际3000tick、6秒、capture步3000、0拒/0错、closed=true。ProviderRTF中位0.044065，ViewerRTF中位0.038557；没有选择最快一次。Viewer墙钟包括服务器完成时写全量原始JSONL后才交done末帧的额外耗时，因此单独记录，不以Provider完成冒充屏幕完成。

20人平均实际移动时间比0.799879、阻挡比0.20005，三轮相同。每个人的实际路程/净位移/阻挡秒数和比例均保存在receipt.people；这是约80%时间移动的当前混合负载，不据此推导20人持续自由行走容量。每例全量Frame保留，单轮约0.66GB。相邻可见帧都显示blocked时仍可能跨过未输出的解除阻挡物理步，诊断中的最大姿态差约9.34mm尚需结合根是否移动进一步核，不能把这个指标直接说成严格连续冻结误差或绑定跳变。

真实显示诊断末120样本：render平均23.27/21.51/19.12ms，p95=32.9/30.1/28.9ms；frameInterval平均约64.2ms，p95=75/73.8/72.7ms。该尾部窗口包含写日志等待阶段，不能冒称全活动期稳定fps。实际渲染143调用/322410三角、60个skinned mesh，shadows=false，loadingErrors为空。03的viewer-initial.png在原生step0清楚显示20个正常着装真人和Panda；末帧人群聚到机器人附近有遮挡，没有为图片重排/隐藏人物或改变相机。

02首次服务在ready后点击时无帧，随后核到Bun session退出0、端口不可达；仅有准备Scene/source/portable，缺receipt/frames，原因未取得额外信号日志，不归因SDK或性能。该失败另存在real20-baseline-02/attempt-receipt.json，不计入三条完成值；同配置02-retry1完成。若再出现同类失败，先加最小退出路径诊断，不盲目凑成功轮次。

完整证据根为本线`.runtime/human-r3/`，汇总`real20-baseline-summary.json`；各完成目录保留receipt.json、viewer-performance.json、viewer-canvas.png、scene/portable、frames.jsonl、源元数据。每轮结束在确认末步/closed/图已落盘后，按精确PID+完整cmdline+cwd只关闭本轮Bun服务，server-cleanup.json可追溯；无宽字符串kill、无其它任务或SwiftShader操作。重诊断/优化随后进行，profile数值不作为最终RTF。

## 2026-10-29：真实20人分段CPU与首个FK小切片

一次有界后端诊断使用首轮已保存的完全相同Scene、6秒/3000tick/30Hz完整MuJoCoProvider NDJSON；省略WebGL仅为分开后端CPU，不作整链RTF。1856完整Frame/756.5MB、closed，Node callback全字段JSON encode共10.60秒。`real20-backend-profile2/worker-timings.json`、`worker.prof`、`provider-profile.json`保留原始数据。

分段wall有嵌套，不能直接相加：human_batch.advance86.19秒，其中pose37.44、原生目标提交16.31、constrain_root18.06（native ray9.95）；当前步observe38.09（人体observe29.71、矩阵转quat11.56）；JSON encode28.89，真实print/管道写3.18秒（CPU0.65）；mj_step仅1.49秒。包装time.thread_time自身9.60秒、wrapper自身3.81秒，cProfile总167秒；**这些是有instrumentation的定位数值，不能把移除包裹计为产品收益**。首次诊断入口把env放入MuJoCoConfig，实际不支持该选项，导致worker找不到模块、0帧；已具体改为仅该诊断CLI进程环境，原失败目录real20-backend-profile保留。

冻结a089原文30个Python/kit文件于`.runtime/human-r3/reference-a089/`，manifest.json逐项SHA，不含未跟踪C helper；human.py SHA为`7d1537fac7a0aae78144246d4eda0141178c74bdc8c00179e76998a914fff435`。参考调用冻结模块自身pose/rotate/mul，不调用候选FK primitive，reference与candidate各自编译独立cfg runtime。

首切片仅把FK循环的rotate+NumPy加法+quat乘三个Python边界合成已有`mju_mulPose`一调用。当前Mu环境3.13.0与Isaac环境的Mu3.8.0均真实提供此API，无新库/SDK/C helper、无时钟/观测变化。原型7clip、3相位、3合法根姿态和边界3969样本，最大差1.11e-15，门槛仍1e-12。正式冻结参考入口两解释器各3843样本，最大差9.99e-16。没有放宽数值门槛。

3000次WalkGrounded采样局部CPU三对：旧1.368691/1.412980/1.418201秒，新1.181451/1.178565/1.189182秒，约16%局部改善。该测点无Viewer/协议，**不是容量RTF，不推断已达0.9**。新旧CPU与数值原始回执`checks/mulpose-probe.json`，正式对照`mulpose-frozen-equivalence.json`和`mulpose-frozen-isaac.json`。

准确冻结参考命令：

```bash
/已有Mu或Isaac解释器/bin/python packages/human-crowd/scripts/clip-sampling-verify.py \
  --definition /最终7d派生目录/definition.json \
  --reference-human /本线/.runtime/human-r3/reference-a089/packages/sim-mujoco/python/human.py \
  --output /全新数值回执.json
```

Mu完整native5/5/0skip（原16、3000tick1e-9、当前步1e-12保留）、Isaac native2/2/0skip（原11+8生命周期）、正式人体CI、根tsc、plugins构建全部退出0；日志checks/mulpose-native.log、mulpose-isaac-native.log、mulpose-ci.log、mulpose-tsc.log、mulpose-build.log。后续依据已测的观测/提交/编码开销继续，当前20人目标仍部分完成。

## 2026-10-29 10:12（新加坡时间）：外部原始clip精确合批

本切片只改既有`human.py`/`human_batch.py`中的同tick数值工作，不增加依赖、World、控制时钟或协议。81骨的原始LINEAR/STEP/SLERP与拓扑层FK用NumPy按同定义批量计算，再一次提交当前MuJoCo根、骨site及14段mocap，包括显式校准的两足。没有重采样/量化原clip，也没有删Frame字段、碰撞或传感器。定义完整rig/mapping/全部clip的SHA，以及source轴/单位/heading等完整源描述、height/collision/foot schema，在编译/安装时缓存为分组签名；不同clip另分组，phase仍逐人计算，不在每tick重新序列化全clip。少于4人的组保留标量，导航/互让/动态成员存在时外部动作保留原标量顺序。

路径仍只推进一次。原`advance`的后半段提成`complete_pose`，停止、阻挡与终点共用原hold出口，不能在`defer_pose`已经更新distance/elapsed后再调用完整advance。每人保留独立末姿态副本，动作成员改变或model重绑时重建派生索引；Isaac继续走既有标量采样/提交。

冻结参考为完整a089 Python模块，reference与candidate在独立进程内导入各自worker；纯数值对照也各自编译cfg，参考不调用候选批量primitive。实际结果：

| 对照 | 实际覆盖 | 最大绝对差/结果 |
| --- | --- | --- |
| 纯数值 | 20人、7clip、不同phase、任意合法3D根姿态、周期边界、交替符号四元数，9240个人体样本 | 2.22e-15，小于1e-12 |
| 完整World | 同20真实角色+Panda、3000tick、默认停障、两点loop、选择停 | site/geom位置3.55e-15，geom矩阵6.36e-13，qpos5.11e-15/qvel4.84e-14；3428接触采样与冻结参考一致 |
| 混定义/重绑 | 原尺寸16人＋显式0.5单位4人、不同heading/phase/clip、0.12s短窗口、4mm终点、warm后sync至generation2 | 2个定义签名；geom矩阵3.30e-13，其余更小 |
| 导航/互让回退 | 200tick混合导航与yield队列 | 批采样调用0，geom矩阵3.62e-14 |
| 阻挡解除 | 4人/500tick；只把真实非人体mocap障碍在step200后移开 | geom矩阵1.24e-13；暂停累计0.224s，step202恢复clipElapsed0.180s，phase记录和接触数逐项同参考 |

所有当前步native骨读回误差0，小于1e-12；owner最终为空，World已关闭。World数值脚本为避免无关大JSON写出将测试frameRateHz显式设为0.001，这只是独立数值对照，**不是性能测量或产品输出口径**。参考/候选线程CPU49.55/24.68s仅是该数值脚本的局部数据；此前纯采样原型约3.2–4.0倍局部收益也不能当整链RTF。尚未用普通worker重测本切片，20人整链目标仍未达0.9，上一节135–138秒失败基线继续有效。

新增默认原生回归使用合法原创GLB经公共import→template spawn创建实际20个外部clip实例，与原Mju标量逐tick比较，同时真实推动动态box，覆盖选择停、mask与owner。它验证外部clip代码路径，不把这个原创低模夹具当真实角色容量证明。完整Mu原生6/6、0skip（保留原16组/3000tick/1e-9/当前步1e-12）；Isaac原生2/2、0skip（原11+8生命周期）；正式human1/Mu3/Isaac18、root/gates类型、3插件构建及diff均exit0。准确命令与退出码在`.runtime/human-r3/checks/batch-gates.json`，同名前缀log保留输出；汇总`.runtime/human-r3/batch-slice-receipt.json`。

阻挡解除脚本首次因空qpos/qvel的np.max失败，第二次修脚本时多写右括号，两个失败日志保留为`batch-candidate-resume.log`/`batch-candidate-resume2.log`。最终源码入口明确把空数组差定义为0，所有非空native数组仍以1e-9验证，未放宽门槛。最终`batch-source-resume-final/compare.json`及`checks/batch-source-resume-final.log`通过。

以下入口均从工作树根执行，输出目录应使用新路径。冻结参考可用`git archive a089763d53b8492bd82a87f11ca1fa03e3eb01de packages/sim-mujoco/python packages/sim-contract/python packages/sim-isaac/python | tar -x -C /新建参考目录`提取；已有reference-a089/manifest.json保留实际30文件逐项SHA。最终7d角色/definition与已保存Scene使用上文的缓存，不联网下载。

```bash
/已有Mu解释器/bin/python packages/human-crowd/scripts/clip-batch-sampling-verify.py \
  --definition /最终7d派生目录/definition.json \
  --reference-human /冻结参考/packages/sim-mujoco/python/human.py \
  --output /新建结果/pose.json

/已有Mu解释器/bin/python packages/human-crowd/scripts/clip-batch-world-verify.py \
  --worker-root /冻结参考/packages/sim-mujoco/python \
  --scene /已保存20人Scene/scene.json --steps 3000 --out /新建结果/ref

/已有Mu解释器/bin/python packages/human-crowd/scripts/clip-batch-world-verify.py \
  --worker-root packages/sim-mujoco/python \
  --scene /同一Scene/scene.json --steps 3000 --reference /新建结果/ref --out /新建结果/candidate
```

混定义Scene位于`.runtime/human-r3/mixed-batch-input/scene.json`；参考与候选均加`--mixed --rebind --steps 300`，回退case加`--mixed --fallback --steps 200`。解除阻挡case使用原20人Scene，双方加`--resume --steps 500`；此时测试脚本明确生成4人＋mocap障碍，不能把它作为20人容量值。各原始结果为`batch-ref-base`/`batch-candidate-base`、`batch-ref-mixed`/`batch-candidate-mixed2`、`batch-ref-fallback`/`batch-candidate-fallback`、`batch-ref-resume`/`batch-source-resume-final`。主控独立验收与后续普通worker整链收益另行记录。

## 2026-10-29 13:18（新加坡时间）：精确clip合批后普通worker单次整链

主控已对固定`f5034b046eb2991319d1e5dd6065823cb225cdfc`独立完成冻结采样、完整World/contacts、Mu/Isaac原生与正式检查后释放独占窗口。本线在同配置20真实7d角色+Panda上运行一次普通worker，没有profile包装，也还没有下述observe新实现。原步长、人数、81骨/14段、默认停障、6s/3000tick、原两点loop与墙钟30Hz完整输出口径不变。通过Cua自己的Edge标签激活后实际点击开始，前后`visibilityState=visible/hasFocus=true`。

结果仍为**性能失败/功能通过**：Provider墙钟86.816070893秒，RTF **0.0691116280**；相比旧三轮中位约1.57倍，仍远低于0.9。1026完整Frame，JSONL418,421,476B。Viewer实际末帧3000呈现墙钟99.999秒，RTF0.0600006000，包含完整日志保存的额外耗时；不能拿Provider先完成当屏幕完成。完整字段输出加快后依原墙钟规则自然少于旧1624–1637帧，未删字段或改成模拟时间30Hz。

20人平均移动时间比0.7998793968、阻挡比0.20005，与旧三轮相同；各人81骨/14段均保留，末帧0拒/0错、closed。末120渲染样本平均20.874ms/p9532.5ms，frameInterval平均67.143ms/p9576.5ms（含保存等待）；活动帧流1025个相邻间隔平均84.487ms，不把尾窗当全程稳定fps。WebGL为`ANGLE(Intel, Mesa Intel(R) Graphics(ARL), OpenGL4.6)`、softwareRendering=false、contextLost=false；这是本次Edge设备事实，不推定正式Electron使用同设备。

证据为`.runtime/human-r3/real20-batch-f503-01/`：`small-summary.json`约11KB，另有完整receipt、frames.jsonl、viewer-performance.json、viewer-canvas.png、初始viewer-initial.png、portable Scene。末图人物按原路线聚在Panda附近且互相遮挡，未重排人物或更换相机。仅按核过的PID/cmdline/cwd，关闭本次自有wrapper1349413→服务1349426，生命周期记录明确收到SIGTERM及实际exit0；Provider已closed，自有Tab562213970已关，独占窗口已释放。

本轮命令由`.runtime/human-r3/run-real20-f503.py`原文及`server-lifecycle.json`保存；wrapper只记录自己的子进程/信号/退出，不修改worker或自动重试。实际命令为上文公共`performance-live.ts --ui-loop --count 20 --asset <最终7d GLB> --source <最终source.json> --out <本轮目录> --port 16680`，解释器仍`Dev/.runtime/sim-python/bin/python`。

GPU只读核查另存`.runtime/human-r3/gpu-route-readonly.json`：当前`mj.mj_step`、动作采样/FK、观测构建与标准JSON都在CPU；Viewer的蒙皮网格绘制走上述Intel GPU，不能说没有使用任何GPU。现有MUJOCO_GL选择只控制离屏渲染，不把物理搬GPU。该Mu解释器未装jax/mujoco.mjx/warp/torch，仓库没有直接承接当前Scene、ray、contacts和完整当步骨姿的MJX Provider。Isaac已有cuda/rtx配置入口，但人体adapter仍明确拒绝非CPU/rendering:none，需实际GPU targets/视图、原生ray/contacts及同步读回适配验证；删guard不等于接通。旧profile物理积分仅1.49秒，GPU迁移不会自动移走其余Python热点，未测GPU迁移加速比。本次未改系统GPU/浏览器/驱动、安装SDK或启动GPU任务。

## 2026-10-29 13:26（新加坡时间）：当前步完整人体观测合批

根据已保存profile的human.observe/矩阵转换热点，`worker.observe`仅增加当前selection的人体收集和一次`human.observe_many`接线。每个调用现读实际`site_xpos/site_xmat/geom_xpos/geom_xmat/geom_size`，ragdoll关节继续读原生`xpos/xquat`。只缓存model与成员身份对应的索引/切片，不缓存pose结果，即使同一step显式改原生数组，再次observe也立即反映。小数组继续原Mju；大数组矩阵转quat保留trace优先、严格对角分支、符号与归一化，仍完整构建每个骨/段及target/motion字段。

初始独立数值原型使用最大四元数分量分支，出现符号差1.73，已作为失败留在`checks/matrix-batch-probe-first.json`；改正分支后随机/边界10008例最大4.44e-16，才进入产品。小批14矩阵原型反而更慢，因此没有逐人盲换，而按当前World选择汇总；1900矩阵原型有约3.5倍局部收益，不当RTF。

正式专项`observe-batch-verify.py`使用最终7d Scene，增加独立ragdoll，10084个单位/随机/精确pi/近pi/trace边界矩阵最大4.44e-16；759个人体完整字段对独立a089参考与实际原生名字重新查找读回，最大8.88e-16，小于1e-12。覆盖运动/末步、混ragdoll、selection子集/重排/空及恢复全部、同step显式改原生位置/矩阵/尺寸和负符号ragdoll xquat、sync至generation2换model/实体重排。源脚本明确这些native写入仅是独立验证刺激，不在产品控制路径内；World已关闭。新增默认原生夹具也复用该专项入口，对保留的原Mju标量观察验证，不需要在线资源或Git历史。

同一真实20+Panda World、同step30、完整World.observe交替A/B三对各100次：旧1.474041/1.578301/1.502318 CPU秒，新1.207659/1.199670/1.079229秒，约23%局部削减；全Frame最大差6.66e-16，closed。第一次探索AB与本线新增单项短时重叠，已独立保留为`observe-current-ab-concurrent-exploratory.*`，这里使用随后无其它测试负载的串行AB。局部CPU不是普通worker/Viewer RTF，不能据此把当前0.0691失败改成通过。

准确专项复跑命令：

```bash
/已有Mu解释器/bin/python packages/human-crowd/scripts/observe-batch-verify.py \
  --scene /最终7d的20人Scene/scene.json \
  --reference-human /冻结a089/packages/sim-mujoco/python/human.py \
  --out /新建结果/observe.json
```

专项日志为`checks/observe-batch-native.log/json`，局部AB入口和回执为`.runtime/human-r3/observe-current-ab.py`、`checks/observe-current-ab.json`。完整受影响门和独立验收随稳定提交回收，普通worker收益另测，不将profile或组件CPU当最终容量。

稳定前完整受影响检查均已exit0：Mu native6/6、0skip（51.68s，含原16/3000tick/当前步与新增观察专项）；Isaac native2/2、0skip（33.52s）；正式human1/Mu3/Isaac18；root/gates类型、human-crowd/sim-mujoco/sim-isaac插件构建和diff。实际逐命令/退出码/日志名为`checks/observe-gates.json`，环境仍用上文已有三个解释器，离线Python用Isaac环境，不安装任何新依赖。汇总为`.runtime/human-r3/observe-slice-receipt.json`。固定提交交主控独立验收，之后才普通worker单次复测。

## 2026-10-29 13:40（新加坡时间）：观察合批后普通worker单次整链

主控已对`b142e55532b901c889bb221c3b0f1ac7122a49d7`独立复跑实际7d/20人+Panda+ragdoll冻结观察专项、Mu6/Isaac2（均0skip/exit0）、正式CI与全插件/desktop构建后释放窗口。本线只在固定产品b142上跑一次同配置普通worker，共享Viewer前台真实点击，不含新JSON依赖或profile包装。

**功能通过，性能仍失败。** 6秒/3000tick耗77.526203077秒，Provider RTF **0.0773931879**；相对f503单次约1.12倍，仍远低于0.9。1006完整Frame，JSONL410,262,713B；Viewer实际末帧3000呈现90.7093秒，RTF0.0661453677，包含完整帧保存开销。20人平均移动0.7998793968、阻挡0.20005与旧值相同，各81骨14段，默认停障、dt、原两点loop和原墙钟30Hz输出触发规则未变。未以少字段或多数站立替代负载。

0拒/0错/closed，前后visible/focus真。末120渲染样本平均23.153ms/p9532.4ms，间隔平均65.443ms/p9576.5ms（含日志等待）；真实流相邻1005间隔平均76.834ms。WebGL仍Intel ARL而非软件，无contextLost，不把Intel渲染设备变化当此次CPU提速原因。

完整证据`.runtime/human-r3/real20-observe-b142-01/`，小件`small-summary.json`保逐人比例/字段/媒体路径，`server-lifecycle.json`保原命令、固定SHA与实际退出。核精确PID/cwd/cmd后，wrapper1403617仅转SIGTERM给自有服务1403640，exit0；Provider已closed，自有Tab562213974已关，窗口已明确释放。没有本次启动/运行失败，不重试挑最好值，也未开始三轮达标验收。

下一步只读标准编码定位：保存的真实b142完整Provider Frame，标准库compact/allow_nan=False编码100次三对CPU1.032134/1.021614/1.059243秒，单帧405764B。回执`checks/json-stdlib-current.json`，这只是重新编码组件成本，不是新worker RTF。新小依赖的候选/严格NaN拒绝、binary64精确往返、类型兼容与发行闭包方案在`.runtime/human-r3/JSON_SLICE_PLAN.md`，仅查官方元数据，尚未下载wheel或安装；任何新依赖/共享写域先交主控审阅。标准编码单项仍不足以从77秒推断达到6秒，控制侧热点也将按实际profile继续收窄，不先新增C/SDK/世界/时钟。

## 2026-10-29：控制侧重新定位与批运算分量视图

新的控制侧独立3000tick诊断明确设frameRateHz=.001、丢弃emit且不启Viewer，只为隔离控制计算，不作完整Provider或容量结果。首个cProfile虽然真实推进3000步并closed，却把World.tick记成175调用/cum0，constrain_root自身时间反大于累计时间；已在`control-profile-b142/receipt.json`标记`INVALID_ACCOUNTING`，原prof/top/日志保留，不据该累计结果推出优化收益。

随后只在少数既有边界显式计数/线程计时，`control-stages-b142/receipt.json`实际3000tick、owner空、closed、exit0。World.tick/advance/path/write/sample各3000调用，包装总CPU25.415秒；advance22.602秒，其中write_clip_group12.575（sample7.712），path_states8.444（constrain7.558，logical obstacle_distance81450次/6.890）；rotate_batch54000次/2.844，multiply_batch42000次/2.212；mj_step3000次/1.044秒。累计含子调用和包装开销，不求和、不用它报RTF。这说明编码之外的控制侧仍有实质成本。

本次仅把`multiply_batch/rotate_batch`各自的通用`np.moveaxis`分量提取替换为同一最后轴的直接分量视图。浮点乘加、顺序、广播和stack均未改，不增加C/依赖或数据owner。独立原型8种函数/shape各2000次逐元素差0，局部CPU下降约15–36%，不外推整链；原型证据`checks/batch-axis-probe.json`。产品候选随后对冻结b142完整human.py（SHA6748f40a...）验证逐元素差0，固定参考复跑入口为`.runtime/human-r3/batch-axis-probe.py`，`batch-axis-frozen-probe.json`。该后一数值复核与原生门短时重叠，因此只采用其差0结论，不用重叠时CPU声称提升。a089独立7clip/9240样本仍最大2.22e-15<1e-12。

Mu原生6/6、Isaac原生2/2均0skip/exit0，原16组/3000tick/完整观察/停止窗口等门保留。首次完整检查外层exec在正式Mu进行中返回143，已取得的原生/正式human退出回执保留；未把不完整formalMu或未运行项记通过，也不无证据归因SDK/主控。进程快照与日志为`checks/axis-driver-143.json`。补齐时仅运行未取得退出回执的formalMu、types、build/diff，改用本线独立session并逐PID记录signal/exit，详见`axis-resume-gates.json`；没有重跑已通过原生门或再次跑完整20人性能。

补齐最终PASSED，formalMu3文件、root/gates类型、3插件build与diff均逐项exit0，独立驱动signals=[]且退出。本切片已有Mu6、Isaac2、正式human1退出0；Isaac标量路径不调用这两个batch函数，因此未重复其18文件离线集，保留上一b142正式18通过证据，当前仍实际运行了Isaac原生2项。原始和补齐命令分别在`checks/axis-gates.json`、`checks/axis-resume-gates.json`，汇总`axis-slice-receipt.json`。完整普通worker最新仍是b142的0.07739失败值，没有为此两行小改再跑三轮或宣称实时。新JSON依赖继续等待主控审阅，未下载或安装。
