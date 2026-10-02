# 机器人能力包（特攻）× JEV 归类/门控 × mimo/GPT6 通用层 —— 设计与核验回执

日期：2026-09-22（Asia/Shanghai）。会话内工作全记录：思考、实测、判读、流程示例与服务器检查。
状态口径遵循 [development-receipts.md](../docs/development-receipts.md)：`PASS` / `PARTIAL` / `BLOCKED` / `UNVERIFIED` 严格区分；凭据已脱敏。

---

## W1 主流机型调研（思考记录）— 状态：UNVERIFIED（调研判断，非实测）

问题：机器人／机器狗／无人机／机械臂／灵巧手最常用哪些，作为能力包建设优先级依据。
判断口径五条：开源模型可得性、公开策略/数据集覆盖、仿真基准内置、保有量/价格、真机闭环价值。
依据文件：`README.md`、`docs/CAPABILITY_MATRIX.md`、`docs/ASSET_ACQUISITION.md`、仓外工作区《Lyapunov-机器人支持矩阵.md》。

| 族 | T0（最常用） | T1 | 与 Dev 现状关系 |
| --- | --- | --- | --- |
| 机械臂 | Franka Panda、UR5e/UR10e | KUKA iiwa14、xArm6、LeRobot SO-101/ViperX(ALOHA) | T0/T1 多数已在库；SO-101/xArm6 为缺口 |
| 机器狗 | Unitree Go2（前代 A1/Go1） | ANYmal、Mini Cheetah、Spot、B2 | Go2 已适配；Go1 权重在库但 `POLICY_ADAPTER_UNAVAILABLE` |
| 无人机 | Crazyflie 2.x；generic quadrotor+PX4 | Tello、DJI Mavic/Matrice | Crazyflie 已验；PX4 桥与资产入库为缺口 |
| 灵巧手 | LEAP、Allegro、Shadow | XHand2/DexHand、RH56、Dex3 | LEAP 通过；Allegro 漂移 FAIL、Shadow 抓取 FAIL |
| 人形 | Unitree G1 | H1、R1、Digit、Figure 类（无资产） | G1 双引擎通过；H1 Isaac 未收口 |
| AGV/叉车 | forklift_c（已有） | MiR、Jackal/Husky | 资产不在 `library.json`，面板不可见 |

结论：Dev 已押注的型号与"最常用"重合；真正缺口是 **Allegro/Shadow 验收失败、Go1 适配阻断、无人机/叉车资产未入库**，不是选型问题。

## W2 能力包（"特攻"）设计 — 状态：PARTIAL（设计完成，未实现）

核心原则：**特攻沉淀在包里，不散在代码里；通用层只认动作合同**。凡元数据可核对的归通用层，凡人工试错的（抓取闭合力 0.030 vs 0.0384、默认站位、观测维度/步频）归包。

每型号一份包，服务器 registry 托管，固定版本 + 逐文件 sha256 + 许可台账：

```
<pack>/
  asset/         MJCF/URDF/USD + 依赖闭包（scene_import 递归解析、CAS 单份）
  profile/       关节/执行器/单位/限位/PD、capabilities（robot_describe 核对源）
  control-map/   8 条通道映射（sim-contract）
  policy/        基础 policy 权重 + 适配器（pin 快照 + sha256 + 许可；policy-registry 口径）
  vla/           图像预处理、动作归一化、末端/关节语义、步频、动作块消费（当前缺口）
  context/       默认站位/场景、提示词、典型任务、失败模式（特攻知识）
  tests/         包一致性套件 + 基准任务（G04/G07/T1–T5 风格 + libero_10）
  provenance/    来源页/许可/作者/哈希清单（scene_asset_acquire manifest 口径）
```

分发守三条：许可逐型号过再分发权重；权重不进 Git 只留锁文件（UPLOAD_POLICY 口径）；JEV 用日期快照名不用浮动别名。

## W3 JEV（TypeSafe Decisions API）核验 — 状态：PASS（真实 API 调用）

用户于会话中提供 OPENROUTER_API_KEY；**仅内存使用、未写入任何文件**；脱敏记录为 `[REDACTED]`；因曾在会话明文出现，**建议用户轮换**。

实测方法：POST `https://openrouter.ai/api/alpha/decisions`，state 为烟测任务，questions 为 gate choice。读数：

| 请求用名 | 返回实际模型 | 结果 |
| --- | --- | --- |
| `typesafe/jev-1.13`（jev_client.py DEFAULT） | `typesafe/jev-1.13-20260917` | PASS：answers.gate=execute，probabilities 齐全，usage 计量正常 |
| `~typesafe/jev-latest`（jev_client.py ALT） | `typesafe/jev-1.13-20260917` | PASS：同快照 |

结论：**jev latest = `typesafe/jev-1.13-20260917`**（2026-09-17 快照）；两个别名等价解析到同一快照。`jev_client.py` 名字无误；实验协议应 pin 日期快照名以保可复现。另注：JEV 不在 OpenRouter chat models 列表（444 个模型无匹配），仅存在于 alpha Decisions 端点。

JEV 双岗位 schema（设计稿，调用形状与 `jev_client.gate_robot_action` 一致）：

1. **归类**（mention → pack）：`choice`（候选=库内 pack）+ `noul`（可否自动装配）+ `score`（置信）；低置信交回用户消歧。
2. **门控**（chunk 前把关）：`noul`(proceed) + `choice`(execute/wait/replan/abort) + `score`(confidence)；state 含阶段/子目标进度、EE↔目标 6D 差、接触、夹爪内是否有物、残差、watchdog。

硬规矩（来自 W4 判读）：JEV 盲（只吃结构化 state），视觉事实由 mimo/GPT6 产出后写入 state；**wait = 零动作/保持位姿**，禁止重放旧 delta。

## W4 libero-long-compare（A_llm vs B_llm_jev）判读 — 状态：PARTIAL（静态判读日志；视觉重跑另行）

输入物：用户附件 `libero-long-compare-2026-09-22.tar.gz`（sha256:f7ec668b…），解包至工作区 `.analysis/libero-long-compare/`（仓外，不上传）。

读数：26 个 episode（batch1 12 + overnight 14）**成功 0/26，subgoals_advanced 全 0**（无任何 BDDL 谓词点亮）。B 相对 A 的全部收益为早停省资源：wall −28%（209.5 vs 292.1s）、steps −39%（318 vs 520）、stuck_timeouts 4→0；Jev wait/replan/abort 计数 batch1=5/0/6、overnight=5/0/5。Jev 延迟 ~262ms/次 vs LLM ~3.5–4s/次。

五个缺陷（逐条有证据）：

1. **未喂视觉**（用户所述属实，代码实证）：`run_long_horizon.py` `propose()` 仅发送文本 state（"Look at predicate_status and dist_ee_to_objects"），128×128 相机渲染后从未发 API；README 自认 "no image-to-API"。盲人开环 delta，0% 是地板。
2. **wait 语义 bug**：wait 分支 `held_action = last_action_list` 且 `chunk_left = K/3`——"等待"实为重放上一 delta 继续运动。证据：`batch1_t0_B_llm_jev_ep0.json` step20 `proposed=[-0.1,-0.2,-0.3…]` 而 `applied=[0.02,-0.06,-0.05…]`（step0 旧动作）。污染"减少无效运动"度量。
3. **brain 中途漂移**：fallback 循环静默换模型，同一 episode 内 `deepseek-v4-flash` → `deepseek-chat-v3.1` 混用，A/B 非单变量对比。
4. **runner v1 环境泄漏**：`runner_broken_v1.log` 大量 "ERROR: executing action in terminated episode"，前 4 ep 中 3 个 `steps=0`；v2 已修，`results_broken_v1.json` 不得与正式数据混用。
5. **JEV 亦盲判**：gate 的 state 只有残差/stuck/子目标计数，无空抓/对歪感知事实，故只可靠做止损（abort 几乎全发在真卡死 ep）。

视觉重跑协议修订（待执行）：多模态 brain（`deepseek-v4-flash-vision-exp`，与 config/developer.yaml 路由一致）每 chunk 附 agentview+wrist（≥256）；K 降 8–10 且每 chunk 重观测；brain 出 EEF 目标位姿 + 本地残差伺服（非盲推 delta）；修 wait=零动作；pin brain 单模型 + `typesafe/jev-1.13-20260917`；fallback 触发的 ep 标记出局；实验分 A(盲)/A-vision/B-vision 三臂分离视觉收益与门控收益。

## W5 流程示例（worked example）— 状态：设计稿（接口均取自现有工具名）

场景："让机械臂把红色方块放进蓝碗。"

| 步 | 层 | 动作 | 关键载荷 |
| --- | --- | --- | --- |
| 1 | JEV 归类 | `decisions(state={utterance:"把红色方块放进蓝碗", candidates:[franka_panda(caps: joint/gripper/pick), ur10e, …]}, questions={pack:choice, autostart:noul, confidence:score})` | → pack=`franka_panda`，proceed 0.83；若 <0.55 交用户消歧 |
| 2 | 特攻包装配 | `scene_import`(pack asset) → `scene_mount` → `robot_describe` | 真实 7 关节/限位/PD；默认站位来自 `context/` |
| 3 | 策略匹配 | 无外部 policy 的臂走 mimo 直控；Go2 类则 `policy_match`（关节顺序/频率/观测语义），不匹配即停 | 严禁借用别家适配器 |
| 4 | System-2 | mimo/GPT6 看 agentview+wrist 图 + state → `{stage_plan, stage, eef_target_pose, gripper}` | 视觉事实（如 gripper_empty）同步写入 Jev state |
| 5 | JEV 门 | `gate_robot_action(state={stage:"grasp", ee_to_target_m:0.14, gripper_empty:true, contact:false, residual:0.11,…})` | → execute，proceed 0.71（<0.55 则 wait=零动作；replan 回 System-2） |
| 6 | 执行 | 本地残差伺服 → `robot_pick`/`robot_gripper`(closeWidthM=**0.030**←特攻知识) | 回执 `attachedObjectIds`/`contacts`/位移，不设成功阈值 |
| 7 | 失败分支 | 关闭后 `gripper_empty=true` → JEV 门 → **replan** → System-2 换策略（重抓/换角度） | 失败不报成功 |
| 8 | 完成 | place → 回执 → `camera_dataset_export`/`recording_export` 留证 | 评测走 `benchmark-libero` 官方 `check_success` |

别名归类示例：`机器狗/狗/Go2`→`unitree_go2`；`Panda/机械臂(未指定)`→`franka_panda`（按库内成熟度默认，明示选择）；`会飞的/无人机`→`crazyflie`；`叉车`→`forklift_c`；`灵巧手`→按任务消歧（LEAP 默认）。

## W6 服务器与承载环境检查 — 逐项状态

探测时间 2026-09-22 晚；命令见文末，可复现。

| 项 | 读数 | 状态 |
| --- | --- | --- |
| `https://vorynel.tech/health`（LYAPUNOV_PUBLIC_ORIGIN，API 公网入口） | DNS 无解析（curl 6），两次探测一致 | **BLOCKED**：域名未配置或未部署；当前"挂服务器"的 API 公网面不通 |
| `https://vorynel.com/`（身份权威） | 200，0.54s；解析 8.136.205.134（阿里云） | **PASS** |
| `https://vorynel.com/billing`（中央账单） | 根路径 301；`/billing/health` 404 | **UNVERIFIED**：服务在但健康端点路径不符 deployment README 的 `/health` 约定，需按真实路由确认 |
| `https://openrouter.ai`（JEV/LLM） | 200，Decisions 调用成功 | **PASS** |
| `https://hf-mirror.com`（资产/策略下载镜像） | 首次超时，复测 200 但 19.3s | **PARTIAL**：可用但极慢，大资产下载需重试预算（asset-acquisition 既有有界重试可用） |
| 本机资源（承载候选） | 磁盘 752G 可用；内存 188G（可用 83G）；24 核 | **PASS** |
| Docker | 29.7.2，daemon 应答（lyapunov-api compose 可跑） | **PASS** |
| 运行时 | Node 24.20、bun 在 `~/.bun/bin/bun`（不在默认 PATH）、Python 3.10.12、git | **PARTIAL**：bun 需入 PATH |
| micromamba（install-provider 前置） | 未安装 | **BLOCKED**：装 MuJoCo/Isaac Provider 前需先备 |
| GPU/驱动 | `nvidia-smi` 无法通信 | **BLOCKED**：本机无可见 NVIDIA 驱动 → **Isaac 本机不可用**；MuJoCo CPU 可用 |
| 监听端口 | 仅 127.0.0.1:4280（DSH GUI）；4180/8787 未监听 | **UNVERIFIED**：dev 工作台与 lyapunov-api 当前未运行 |

## 后续动作（按序）

1. 部署方确认 `vorynel.tech` DNS/部署状态（BLOCKED 项），`/billing` 健康端点真实路径；
2. 视觉重跑 W4 协议修订（A/A-vision/B-vision 三臂 + wait 修复 + pin 模型）；结果回填本回执；
3. 能力包合同落地（W2）：先格式化 Panda/Go2/G1/Crazyflie/LEAP/forklift_c（forklift 先入 `library.json`）；
4. 三个试金石修复：Go1 适配器、Allegro 漂移、Shadow 抓取保持；
5. JEV 归类 schema 联调（W3）+ 别名词表；
6. 本机补齐：bun 入 PATH、micromamba、（如需 Isaac）GPU 驱动或换承载机。

## 验证命令（脱敏可复现）

```bash
# JEV 快照解析（KEY 环境变量注入，不落盘）
curl -sS -X POST https://openrouter.ai/api/alpha/decisions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"~typesafe/jev-latest","state":{"task":"smoke"},"questions":{"gate":{"type":"choice","instructions":"gate","criteria":{"execute":"run","wait":"hold","replan":"redo","abort":"stop"}}}}'
# 预期返回 "model": "typesafe/jev-1.13-20260917"

# 服务器探测
getent hosts vorynel.tech vorynel.com
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 12 https://vorynel.tech/health
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 https://vorynel.com/
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 30 https://hf-mirror.com/

# bakeoff 缺陷定位（解包自用户附件）
grep -n "held_action = " run_long_horizon.py   # wait 分支重放 last_action_list
grep -n "image\|vision" run_long_horizon.py    # propose() 无图像载荷
grep -n "executing action in terminated episode" artifacts/batch1/runner_broken_v1.log
```

---

## 追记（同日晚，W7–W11）——含对 W6 两条读数的更正

### W7 提示词规模与分类确定性 — 状态：PARTIAL（设计完成）

问题：包内提示词会非常多，分类是否确定？
结论：**分类集合封闭且收敛为确定性映射**。三级机制：
1. `pack id` 是 registry 台账上的有限枚举（choice 的 criteria 就是这份清单，不会"发明"新类）；
2. 确定性优先：别名表精确匹配（覆盖高频说法，100% 可复现）→ JEV choice（**pin 快照** `typesafe/jev-1.13-20260917`）兜底模糊说法，并带**归类缓存**（key = utterance 归一化 + 目录哈希；同输入同结果）；
3. 低置信（proceed<0.55）交用户确认，确认结果**回写别名表**——越用越确定。

提示词库大 ≠ 注入大：`context/prompts/` 按 `技能.阶段.md` 命名（如 `pick.grasp.md`）+ `index.json`（tag/触发条件/适用 stage/失败模式卡）；运行时只注入当前 stage 的 2–4 张卡，其余按需检索。不整包塞 system prompt。

### W8 无 policy 特攻包能否 mimo+jev 直控 — 状态：PASS（有实证）

可以。实证链：Panda/LIBERO 全程无学习策略（bakeoff A/B 都是）；此前 `libero_object` task0 官方 `check_success=true`（17 次调用/123 步）同为直控。包只需 `asset/ + profile/ + control-map/`，`policy/` 可选。
适用面按形态分（写入包 `capabilities.directControl`）：

| 形态 | mimo+jev 直控 | 说明 |
| --- | --- | --- |
| 机械臂/灵巧手/夹爪（任务级） | suitable | EEF setpoint + 本地残差伺服 |
| 机器狗/人形（行走） | requiresPolicy | 50Hz 12-DoF 反应控制超出 LLM 节拍，必须 gait policy 或外部控制器 |
| 无人机 | requiresExternalController | 产品不内置飞控（能力矩阵口径不变） |

无 policy 包的测试集按直控判据（libero_10 三臂类），不套 policy 行为判据。

### W9 华北服务器 + vorynel.com 子域名 — 状态：PASS（已实测存活；配置收尾待做）

实测更正：**`api.vorynel.com` 已解析 39.106.2.91（阿里云北京=华北），`/health` 返回 200（0.16s）**，OAuth 回调路由 `/v1/auth/website/callback` 返回 400（缺参数，路由存在）。方案已进行时，收尾清单见 [ENVIRONMENT_SPEC.md](../docs/ENVIRONMENT_SPEC.md) §4：`server.env.example` 域名更正（**退役 vorynel.tech**）、身份服务登记/确认回调、cookie `__Host-`/SameSite 收紧、ICP 主体一致性确认、包 registry 路由（`api.vorynel.com/packs*` 或 `registry.vorynel.com`，后者需加 DNS）。

**对 W6 的更正**：W6 中 `vorynel.tech` BLOCKED 的判定保留，但结论修正——正式 API 入口是 `api.vorynel.com`（PASS），vorynel.tech 属应退役占位，不是"服务器没部署"。

### W10 GPU 复查 — 状态：PASS（更正 W6 的 BLOCKED）

用户指出本机有 GPU 与驱动，复查属实。证据：`lspci` 见 NVIDIA PCI `2c58`（+音频 22e9）；`/proc/driver/nvidia/version` = NVRM **595.91.07**（open kernel module，2026-07-29 构建），GPU `0000:02:00.0` 已注册；`/usr/bin/nvidia-smi`、`/usr/local/cuda/bin/nvcc` 均在。
**对 W6 的更正**："GPU/驱动 BLOCKED"作废——nvidia-smi 失败原因是**本会话沙箱 `/dev` 被过滤（仅 14 个节点，无 `/dev/nvidia*`）**，设备节点不可见，非缺卡缺驱动。Isaac 在宿主终端应可用；沙箱/容器内跑 GPU 任务须挂载 `/dev/nvidia*`。

### W11 环境一致性方案 — 状态：PARTIAL（文档已写，doctor 脚本待实现）

已写 [ENVIRONMENT_SPEC.md](../docs/ENVIRONMENT_SPEC.md)：硬件/驱动基线、运行时 pin（含 bun PATH、micromamba 缺口）、网络端点预期读数表、域名拓扑与退役声明、凭据占位（指向 keys.example.md）、7 条安装自检（doctor 对表）与**差异申报规则**（不符即记 `差异：项/实测/原因/影响范围`，沙箱须注明 /dev 可见性）。
待实现：`doctor env` 子命令（与 `./lyapunov doctor mujoco` 同族）输出对表 JSON，安装回执直接附其输出。
