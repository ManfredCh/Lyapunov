# 20 真人与 Panda 可复跑验收

该入口只消费既有 `SceneOperations`、`importHuman`、`spawnCrowd` 和 `MuJoCoProvider`。`World`、物理时钟、动作所有权和原生 Frame 继续属于产品 Provider。脚本不建立 Viewer，不把 Provider 门冒充完整工作台或 RTX 渲染验收。

当前脚本位于 `script/gates/human-realtime-acceptance.ts`；需要目录功能提交 `8705a8db292451463379abb9729778b1073ccb00`、默认分散路径提交 `6cc125a8dc2ad3a05ed303338c052014f048e04a`，以及 Human 线固定 GPU World 提交 `703f0b8af06e09a31d69ad7fe0a1713b1c6ef173`。`b901d0de` 只有 CUDA 数学模块，不能通过本入口的实际 World kernel 门。

## 固定输入

首4 r3 manifest 为 `/home/s18/WS/Lyapunov/.worktrees/simready-usd-20261028/.runtime/human-appearance-r4/first4-r3-frozen.json`，SHA-256 为 `a4df115e44f6a7ad4804fc8045d1464478cdd5e1301505c9e5311b0c1948541c`。脚本先核 manifest 原始字节，再核每个 `source.json` 的原始字节、GLB 字节数和 SHA、81 骨、7 clip 和左右脚独立校准。只准备前四个正式外观，每个5人，保留各自 `WalkGrounded` 与实测步速。完整12外观发行包由对应角色线独立验收。

默认 `--layout circles` 在半径 3、5、7、9 米的四条圆环上各放5人，每圈64个世界路径点，Panda 位于中心。位置、朝向和路线作为普通 Scene 文档提交；保留默认停障、detailed碰撞和各角色自己的 clip/步速。该场景用于避免2米往返中频繁180°急转造成横滑；实际自然步行画质仍须人工看产品窗口。

`--layout lanes` 沿用产品默认20人网格：每格沿 X 正向2米再返回起点，角色各5人、相邻路线分散。该输入可证明默认布局与往返功能；约1.2秒的默认180°转向会影响视觉自然度，必须如实报告。

`--scene /绝对路径/portable/scene.json` 通过 `SceneOperations.open` 在独立库重建引用，保持输入路线与摆放；`--legacy --scene ...` 允许原7d单外观场景，固定6秒manual，避免以更轻的正常场景替代旧基准。

## 准备场景（不启动SDK）

在目标候选源码根运行：

```bash
/home/s18/.bun/bin/bun run script/gates/human-realtime-acceptance.ts \
  --manifest /home/s18/WS/Lyapunov/.worktrees/simready-usd-20261028/.runtime/human-appearance-r4/first4-r3-frozen.json \
  --manifest-sha256 a4df115e44f6a7ad4804fc8045d1464478cdd5e1301505c9e5311b0c1948541c \
  --layout circles --prepare-only \
  --out /绝对路径/独立证据根/prepare
```

产出 `identity.json`、`prepared.json`、`scene.json` 和 `portable/scene.json`。`identity.json` 记录当前 HEAD、工作区状态、实际命令及 QA/worker/human/GPU 文件 SHA。场景是可审产物，不能据此推导已运行物理或GPU。

## 物理与计算实跑

先由 Root 协调正式性能独占窗口。使用安装准备线已经验过的 Mu3.13+Warp1.13 解释器，不混 Isaac SDK。仅进程局部设置 CUDA 后端和独立缓存，保持 `clock:manual|realtime`、`.002`、`frameRateHz:30`、`realtimeFactor:1`。

```bash
LYAPUNOV_MUJOCO_PYTHON=/绝对路径/已验Mu313+Warp解释器 \
LYAPUNOV_HUMAN_COMPUTE_DEVICE=cuda:0 \
LYAPUNOV_HUMAN_GPU_CACHE_ROOT=/绝对路径/独立证据根/cuda-cache \
/home/s18/.bun/bin/bun run script/gates/human-realtime-acceptance.ts \
  --manifest /home/s18/WS/Lyapunov/.worktrees/simready-usd-20261028/.runtime/human-appearance-r4/first4-r3-frozen.json \
  --manifest-sha256 a4df115e44f6a7ad4804fc8045d1464478cdd5e1301505c9e5311b0c1948541c \
  --layout circles --clock both --rounds 3 \
  --expected-uuid GPU-b0fb1abf-cbc1-c006-55fe-11273e0627b2 \
  --out /绝对路径/独立证据根/正式三轮
```

每种时钟三轮均执行、全部保留。manual 为6秒/3000驱动tick容量成绩；realtime 为30秒/15000驱动tick正常一倍成绩。可用 `--clock manual` 或 `--clock realtime` 分开取证。短 `--duration-s` 只能作为功能诊断，不能称30秒正式成绩。

每轮冷准备、活动段、关闭/保存尾窗分别记录。活动墙钟自公开动作提交前到真实末回执返回；模拟时长按动作 `startStep/endStep` 的实际整数驱动窗口计算，避免把末尾额外世界tick算成驱动时间。Frame完整原字段保存到 `frames.jsonl`，到达时间保存在 `frame-arrivals.jsonl`；没有减骨、删段、降字段或帧插值。落盘队列峰值单列，保存尾窗不计活动RTF。

Panda 经公开 `SceneOperations.import(category:robot)` 登记原MJCF与依赖，portable引用保留资源身份；先 `describe`，按真实 `controlledJointNames` 生成完整轨迹向量；从当前 `observe.joints` 取基线，仅对首个可安全移动的真实hinge作0.2弧度以内周期变化，其余受控关节保持实测基线。门同时要求实测 qpos范围大于0.02、qvel绝对峰大于0.005，不接受静态模型或仅下发成功。该入口仅仿真 Provider，无实物 endpoint。

各人报告累计 travel、blockedS、活动时间比和理论步速对应的位移比。正常场景至少16人同时达到活动比≥0.5、有效位移≥各自步速×时长×0.5。不能将多数人因停障站住后的吞吐称自由行走容量。默认停障保持；正例原生接触与更细的错误/owner生命周期沿 Human 线冻结原生回归和 Root 独验另列。

每帧检查 world/generation/sceneRevision、单调step、`.002`、人体 pose 与外层同一步同一时刻、实际 `mujoco-site/body` 来源、81骨14段与有限值。`--self-check` 验证 QA 自身拒收错误world/generation/revision/步长及缺人体的负例，不能推导产品Viewer已拒收。

计算门从 `sim.describe(worldId, humanId).controller.humanCompute` 取真实事实，要求 CUDA FP64 backend、dtype、kernelCalls相比活动前增长及指定UUID。缺事实或设备不匹配失败，不转为skip通过。活动结束后在暂停的同World单列队列取消/AbortSignal、无额外tick、close后世界从列表消失、Provider dispose；这些窗口不进入活动成绩。

## 完整产品窗口与最终门

本入口的 `viewer.status` 永远为“未验证”。Root须用同一固定输入在完整产品工作台、实际RTX5090窗口跑三轮，分别采活动 `rAF`/Frame到达与应用/render/末呈现，报告真实renderer与设备进程证据。平均活动FPS≥30、p95间隔≤50毫秒；冷准备、末屏、保存尾窗单列。miniViewer、浏览器局部组件或静态截图不能代替完整产品工作台。

物理正常30秒RTF≥0.9、目标≥1；realtime实测须落在0.9–1.05之间才记`normalClockApproximatelyOne=true`（低于0.9是未达实时，高于1.05是快进），不能只核上界。Root独立审查实际代码并至少复跑同入口一轮，取真实原生pose/contact读回和完整UI。最终报告分别给代码CI、CUDA数学、World当前帧、物理、产品RTX/FPS、人工视觉证据，缺哪层就留哪层未验证。

## 自动化校验

```bash
/home/s18/.bun/bin/bun run script/gates/human-realtime-acceptance.ts --self-check
./node_modules/.bin/tsc --noEmit -p script/tsconfig.gates.json
git diff --check
```

新QA未改产品运行行为，重型SDK与全产品CI只在对应候选整合后由Root按实际变更执行。代码CI不替代真实设备和活动段性能。
