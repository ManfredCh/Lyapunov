# Lyapunov 开发标准与流程

本文面向维护 `Dev` 源码的开发者，覆盖目录职责、接口合同、日常开发、检查与发布，以及当前实现中已经确认的接口缺口和重复代码。架构取舍见 [开发原则](DEVELOPMENT_PRINCIPLES.md)，使用说明见 [README](../README.md)。

实际推进使用 [开发问题 TODO](DEVELOPMENT_TODO.md)；关闭问题和追溯历史回执使用 [已解决问题与回执归档](RESOLVED_ISSUES.md)。本页第 8 节保留代码核对依据，不另建一份相互竞争的活动清单。

## 1. 当前源码范围与事实入口

原核对日期为 2026-09-19；基准提交为 `d562e421a7c4da6792441713ee71566b4c03ebbf`，包含当时的未提交修改。**当前状态以 [开发状态](../development/STATUS.md) 为准**；本文保留仍可执行的流程、接口合同与核对依据，个别历史读数（如“8 条 TS 错误”）已按现行为更正。

本次对 `Dev` 做目录和文件盘点，对产品源码建立符号、注册接口、错误分支与重复函数索引，再逐项核对启动装配、合同和关键调用链。范围包含全部产品包、`script`、`distribution`、`bin`、配置和 CI（当时的 `services/lyapunov-api` 已于 2026-09-26 移出本仓，见下文服务边界）；材料、研究记录、历史证据、上游检出和依赖单独分类。

产品代码候选共 363 个文件、74,703 行，其中 `packages/desktop/renderer/account.js` 是 8,129 行的生成文件；扣除该文件后为 362 个文件、66,574 行。统计包含 TS/TSX/MTS、JS/MJS、Python 与启动脚本，排除 `node_modules`、`dist`、补丁、静态解码器及缓存。全树索引不等于逐行人工审查或全功能运行测试。

| 目录 | 职责 | 修改和检查入口 |
| --- | --- | --- |
| `packages/` | 产品插件、合同、界面及 Provider | 对应 `src`／`python`，装配看 `script/runtime-patch.ts` |
| `script/` | bootstrap、Profile、Host、构建、打包、迁移 | 根 `package.json` 与实际参数解析 |
| `script/gates/` | 功能验收及驱动 | 独立入口、`script/tsconfig.gates.json` |
| `distribution/` | Linux 发行启动器、安装器、运行检查 | `linux/lyapunov`、`linux/install-provider` |
| `config/` | 公开配置示例 | 真实凭据保存在忽略文件或仓库外 |
| `materials/` | 内置物料、机器人模型和来源信息 | `materials/library.json`、各来源许可 |
| `docs/` | 可公开的开发与使用说明 | 命令与功能边界随实现更新 |
| `bugfixHistory/`、`goals/`、`research/` | 开发证据、任务合同、研究材料 | 可定位历史，不能替代当前源码事实 |
| `.upstream/` | 固定 DSH 检出 | `UPSTREAM_LOCK.json` 与 `script/upstream-patches.mjs` |
| `.runtime/`、`workspace` | 本机运行环境与活动工作区映射 | 不作为源码提交，不从目录存在推断可用 |

### 1.1 产品包职责表

| 包目录 | 当前职责 |
| --- | --- |
| `lyapunov-contracts` | Scene、Resource、Frame、ActionReceipt 等值合同与工作台槽位 |
| `scene-kit` | 场景提交、历史、资源库、格式解析、公开资产导入 |
| `sim-contract` | `SimService`、动作合同、Python 进程传输、渲染后端取值 |
| `sim-mujoco` | MuJoCo 世界、动作、碰撞、相机与观测 |
| `sim-isaac` | Isaac 世界适配、缓存、设备与渲染配置 |
| `sim-newton` | Newton 基础世界、同步、观测与明确的未支持能力表 |
| `viewer` | Three.js／Spark 共享 Viewer、图形显示与拾取 |
| `robot-tools` | Scene／Sim 的模型 Tool 和人工 Command 适配 |
| `robot-workflows` | 抓放、车队、货物转运、录制及导出 |
| `motion-mink`、`motion-ompl` | 分别提供 `motion_plan`、`motion_path` |
| `grasp-analytic`、`grasp-anygrasp`、`grasp-graspgenx` | 同名 `grasp_propose` 的互斥候选 Provider |
| `asset-bake` | 碰撞派生、烘焙与物理化 |
| `blender` | Blender 批处理建模、导出、预览及纹理；附带领域技能 |
| `generate-marble`、`generate-hunyuan`、`generate-tripo` | 对应生成 Provider、任务状态和产物下载 |
| `segment-sam3` | 二维分割 Provider 与结果产物 |
| `fastgs-external`（非插件，包外工具） | 官方 FastGS 的下载/安装/检查/训练转发；算法与环境不随包 |
| `policy-registry` | 策略来源、下载、校验、适配、匹配、执行与停止 |
| `benchmark-contract` | 官方评测任务与结果合同 |
| `benchmark-libero`、`benchmark-gymnasium` | 官方环境适配、评测工具与只读场景投影 |
| `lyapunov-shell` | 原生 DSH 工作台装配、场景面板、用户偏好和界面桥接 |
| `lyapunov-workspace` | 文件、搜索、模型预览、Git Review、终端 |
| `lyapunov-terminal` | 独立终端客户端及连接、输入和会话适配 |
| `lyapunov-session-undo` | 原生会话历史检出、工作树历史与草稿恢复 |
| `lyapunov-mcp-extras` | MCP 资源、提示词及 OAuth 补充接口 |
| `lyapunov-share` | 私有预览、分享服务客户端、发布与撤销 |
| `lyapunov-product-bundle` | 产品 bundle、账户、运行路径、GitHub／CLI 集成 |
| `lyaup-migrations` | 旧数据和用户偏好迁移；目录名仍保留旧前缀 |
| `desktop` | Electron 主进程、preload、账户页、Host 生命周期 |

## 2. 环境与启动标准

### 2.1 安装与版本来源

根项目声明 Node.js `>=24`、Bun `1.3.13`；上游 pnpm 版本在 `UPSTREAM_LOCK.json` 中为 `11.7.0`。Git 用于固定上游与工作树操作。

从仓库根目录初始化：

```bash
export HF_ENDPOINT=https://hf-mirror.com
node script/bootstrap.mjs
```

bootstrap 会检查固定上游提交、应用登记补丁、安装并构建上游、安装产品依赖、链接产品包并构建插件，最后尝试准备 Blender MCP。MCP 准备失败只发出提示，不能据此推断建筑工作台已经可用。

不直接编辑 `.upstream/**/lib`、`packages/*/dist`、桌面生成的 `renderer/account.js`。上游修复必须进入登记补丁或固定 fork 提交；产品修复进入源码。

### 2.2 选择正确入口

| 场景 | 入口 | 重要行为 |
| --- | --- | --- |
| 常规开发 Web | `bun run dev:developer` | 本机账号认证；读取 `config/developer.yaml` |
| 使用本机配置 | `bin/lyapunov-dev-linux --config config/developer.local.yaml` | 配置文件可覆盖端口、模型、引擎和运行根 |
| 正式桌面 | `bun run dev:desktop` | 正式登录后启动账户 Host |
| 开发桌面 | `bun run dev:desktop:developer` | 独立开发模式；发行构建拒绝此模式 |
| 底层 Web／SDK／headless／ACP | `node script/launch.ts --mode developer --surface web` | 内部入口，不经过 `developer.ts` 的本机密码门 |
| 建筑工作台 | `bun run dev:architecture` | 独立 Blender addon、MCP 和 Web Host |
| 终端 | `node script/terminal.ts --help` | 本地或 `--attach` 远端 Host；本地引擎默认 `none`，`--engine` 显式装配；仍属开发原型 |
| 官方评测 | `node script/benchmark.ts --help` | LIBERO／Gymnasium；默认正式模式 |

端口用于连接，运行根用于数据身份，二者不能互相替代。并行开发使用专门入口的自动让位或显式 `--runtime-root`／`--host-id`。

终端的引擎与 `launch.ts` 共用同一个 owner（`script/engine-preference.ts`）和同一条优先级：
`--engine` > `LYAPUNOV_SIM_ENGINE` > 界面选过的用户偏好 > 代码默认；**只有代码默认不同**——
`launch.ts` 用 `defaultEngine()`（Isaac 默认、MuJoCo 回退），终端保持 `none`，
即从没配过引擎的机器上开终端不会顺手拉起仿真 provider。引擎在 Host 启动时装配，
所以 `--attach` 不接受本地 `--engine`（远端 Host 的引擎归远端），本地参数里给了会被明确拒绝。

### 2.3 新机器的物理运行时

bootstrap 不安装完整物理 SDK。开发树直接调用安装器时，需要提供已安装的 micromamba：

```bash
LYAPUNOV_MICROMAMBA="$(command -v micromamba)" \
  ./distribution/linux/install-provider mujoco
```

该命令要求 `micromamba` 已在 PATH；也可给 `LYAPUNOV_MICROMAMBA` 一个有效的绝对路径。安装器为空前缀建环境，对已有前缀先核对身份。

发行包使用包根的 `./lyapunov install-provider ...`。`distribution/linux/lyapunov` 在源码目录中不具备相同的包根布局，不能作为开发树的常规启动命令。

### 2.4 配置分层

- 普通开发 YAML：只放模式、路由、端口、运行根等非秘密值；解析器只支持当前两层标量配置。
- 开发账号：`node script/developer-account.ts init --username developer`，默认保存至 `~/.config/lyapunov/developer-account.json`。
- 开发模型凭据：后端环境变量 `DEEPSEEK_API_KEY`，或 `LYAPUNOV_DEVELOPER_AUTH_FILE` 指定的应用凭据文件。
- 正式账户：使用验证后的 token 和账户 API；不复用开发 Key。
- 引擎偏好：默认 `~/.config/lyapunov/engine.json`，测试可用 `LYAPUNOV_ENGINE_PREFERENCE_FILE` 隔离。

通用启动器的引擎优先级为显式参数 → 环境变量 → 用户偏好 → 代码默认。常规开发入口会把 YAML 的 `engine` 作为显式参数传入，所以“修改设置后重启”不保证覆盖 YAML。

产品要求的代码默认是 **Isaac 优先、未就绪时回退 MuJoCo**。当前 `config/developer.yaml` 已不再写 `engine` 行（2026-09-27 源码核对），省略即跟随共享解析；需要固定引擎时才显式写一行，作为显式覆盖压过环境变量。本次文档工作未修改配置。

该优先级由 `script/engine-preference.ts` 的 `resolveEngine()` 唯一实现，`launch.ts`、`developer.ts`、`architecture.ts` 与桌面经 `host.ts` 的 `startWebHost` 共用。旧 09-19 记录的“桌面缺省 `none`、建筑入口缺省 `mujoco`、仅 `launch.ts` 消费偏好”是当时状态，按 09-27 源码已不成立；设置面板写入的是下次启动偏好，不热切换当前世界。

## 3. 代码和插件标准

### 3.1 分层与类型

使用 ESM；根 TS 配置为 `strict`、`noEmit`、bundler 模块解析。共享 DTO 放入已有合同包，Provider 内部对象留在 Provider 内。

新增公共输入应有明确的类型和 schema。可扩展 `components`、原始第三方响应等边界允许宽类型，但必须在消费前校验。已有 `any` 或泛化 JSON 不构成继续扩散它们的理由。

改动遵守相邻文件风格；当前仓库没有根级 lint／format 脚本，不以统一格式为由改写无关文件。注释说明单位、状态来源和非显然的约束；失效注释随代码一起修正。

### 3.2 新增工具的最小闭环

1. 找到状态所属包，在 operation 中实现行为。
2. 定义参数 schema、返回值和可识别错误。
3. 在 `plugin.ts` 的 `apply` 中注册；必需服务写入 `inject`，可选服务用 `ctx.get`。
4. 人工 Command 调用同一 operation，解析 `rawInput` 并传递 `invocation.signal`。
5. 如果需要 UI 调用，再检查工作台代理的命令前缀白名单与客户端接口。
6. 如需后台运行，注册 DSH Job 并连接取消、结束状态和产物。
7. 在 `runtime-patch.ts` 检查装配条件；只存在 `package.json` 不代表已启用。
8. 更新接口示例和对应的行为验证。

`script/build-plugins.ts` 负责宿主插件构建，以及 Viewer、Shell、Workspace、Session Undo 四组客户端模块。浏览器端通过 DSH `__ModuleLoader__` 加载；共享 Viewer 的模块边界不能随意改成每个界面各打包一份 Three.js／Spark。

### 3.3 Python worker 与长任务

仿真进程复用 `ProcessSimProvider` 的 NDJSON 请求／响应、`ready`、`frame`、`receipt`、`fatal` 事件。stdout 用于协议，诊断写 stderr；关闭与插件释放等待子进程结束。

耗时的工具沿 `exec.signal`／`invocation.signal` 传播取消，使用现有 Jobs。取消请求、控制撤销、停止回执和世界关闭是不同事件，返回值应保留这种区别。

### 3.4 新增物理 Provider

需要同时完成：`SimService` 适配、worker、插件注入、能力声明、运行装配、各入口参数、偏好选择、解释器解析、独立安装环境、构建打包和对应真实验收。

检查入口至少包含 `engine-preference.ts`、`runtime-patch.ts`、`launch.ts`、`developer-config.ts`、相关桌面／建筑入口以及 Linux 安装器和帮助文本。2026-09-27 源码核对：`ENGINE_CHOICES` 含 `newton`，`developer-config.ts`、`architecture.ts` 均按该枚举校验，`ui_engine_switch` 描述取自 `ENGINE_CHOICES`，Linux 顶层 help 的 `doctor`／`install-provider` 已列出 `newton`；仅建筑入口示例行仍写 `none|mujoco|isaac`，属帮助文本维护项。见第 8 节。

### 3.5 机器人、policy／VLA 与碰撞接入流程

1. 在 [能力总表](CAPABILITY_MATRIX.md) 登记具体型号、模型来源、版本、关节／执行器、控制模式及目标引擎；六族机器人都适用，Go1／Go2／G1 与三种灵巧手分别建行。
2. 先尝试现有大模型工具控制；需要高频控制或已有学习策略时复用 `policy_*`，固定权重来源并下载校验。VLA 另写清图像预处理、语言输入、状态排列、动作反归一化、末端／关节语义、action chunk 与执行步频。
3. 经 `robot_describe` 与 `policy_match` 核对当前 world／generation、控制量单位、限位与观测来源。模型维度相同不足以认定匹配。先准备失败就记录该层阻断，不启动虚假的执行。
4. 场景导入检查尺度与轴向；3DGS＋GLB 记录来源配对、配准状态和碰撞角色。复用已有 `scene-collision`／`asset-bake`，按实际引擎核对 box、shapes、mesh、parts、binding 的消费语义。
5. 做一个限定任务：初态 → 动作 → 实际状态／接触 → 停止／终态。行走验收位移与稳定停止；灵巧手验收抓取、抬升、保持与释放；无人机验收起飞、悬停和航点。室内碰撞还须证明门洞可通行，不能仅证明碰撞体存在。
6. 保存工具回执和真实图像／视频，说明模型是否参与决策、是否使用结构化状态、是否按仿真时间播放。同步 README、总表、TODO、已解决账本。现有完整 Demo 可以交付，未实现型号或引擎保持独立卡点。

本轮参考：[LIBERO 成功与 policy 尝试](../bugfixHistory/DEMO-CAPABILITIES-20260919.md)。引擎之间复用合同和资产，不照抄成功标签；新增适配仍遵守最薄层要求。

## 4. 接口标准与速查

### 4.1 四类接口不能混用

| 调用面 | 例子 | 参数与返回 |
| --- | --- | --- |
| 模型 Tool | `scene_create` | 按 `defineTool` schema；常见外层为 `input` |
| 人工 Command | `/scene_create {"sceneId":"demo"}` | `rawInput` 是业务对象 JSON，不再次包 `input` |
| 工作台 HTTP | `POST /api/lyapunov/command` | `{sessionId,name,input,selection?}`；返回 DSH Command 执行结果 |
| 账户 REST API | `GET /v1/me` | 独立 API 服务与账户认证，不能发到场景 Host 代替 |

模型 Tool 示例：

```json
{"input":{"sceneId":"demo"}}
```

工作台等价请求体：

```json
{"sessionId":"当前会话ID","name":"scene_create","input":{"sceneId":"demo"}}
```

这些对象分别用于同名 Tool 和工作台 Command 代理，不是可互换的统一 REST 格式。`sim_world_list` 等无参工具按自己的空 schema 调用。

`motion_plan` 推荐使用结构化顶层 `plan`，兼容顶层 `request_json`，两者必须二选一，可选 `background`。`motion_path`、抓取候选、生成和分割中的多种工具使用 `request_json` 字符串与可选 `background`；`blender_run` 使用 `output_directory`、`python_script` 等顶层参数。以各 `plugin.ts` 和 `tool-schema.ts` 为准。

### 4.2 领域工具清单

| 能力 | 当前注册的主要名字 | 实现位置 |
| --- | --- | --- |
| 场景生命周期 | `scene_create`、`scene_list`、`scene_inspect`、`scene_edit`、`scene_history`、`scene_restore`、`scene_open`、`scene_save` | `scene-kit/src/plugin.ts` |
| 资源进入场景 | `scene_import`、`scene_mount`、`scene_align`、`scene_import_url`、`scene_environment_search/detail/import` | `scene-kit/src/plugin.ts` |
| 资源管理 | `asset_list/edit/move/trash/restore/unlink/verify`、`asset_authority_snapshot/recover`、`asset_missing`、`asset_missing_rescan` | `scene-kit/src/plugin.ts` |
| 运行世界 | `sim_open`、`sim_world_list`、`sim_sync`、`sim_close`、`sim_stop`、`sim_execute_batch`、`sim_assist`、`sim_action_receipt` | `robot-tools/src/operations.ts` |
| 机器人动作 | `robot_load/describe/state/move/walk/gripper/stop`、`vehicle_drive`、`joint_move` | `robot-tools/src/operations.ts` |
| 相机 | `sensor_capture`、`camera_list`、`camera_capture_multi`、`camera_adjust`、`camera_project_annotation`、`camera_dataset_export` | `robot-tools`、`sim-contract` 与具体 Provider |
| 计划与候选 | `motion_plan`、`motion_path`、`grasp_propose` | `motion-*`、所选 `grasp-*` |
| 组合任务 | `robot_pick`、`robot_place`、`robot_cargo_transfer`、`robot_fleet_route`、`robot_fleet_run` | `robot-workflows/src/*plugin.ts` |
| 录制 | `recording_start/stop/list/inspect/export` | `robot-workflows/src/recording-plugin.ts` |
| 资产生产 | `asset_bake`、`blender_run`、`generate_marble`、`generate_hunyuan`、`generate_tripo`、`segment_sam3` | 对应 Provider 的 `plugin.ts` |
| 策略 | `policy_search/metadata/files/download/verify/prepare/match/execute/stop` | `policy-registry/src/plugin.ts` |
| 官方评测 | `bench_prepare/catalog/load/step/result/close/run_suite` | `benchmark-libero`／`benchmark-gymnasium` |
| MCP 补充 | `list_mcp_servers/resources/resource_templates/prompts`、`read_mcp_resource`、`get_mcp_prompt` | `lyapunov-mcp-extras` |
| 分享 | `share_preview/publish/list/revoke` | `lyapunov-share/src/plugin.ts` |
| 界面桥接 | `ui_action`、`viewer_annotation_read`；截图和相机 UI Commands 另行注册 | `lyapunov-shell/src/plugin.ts` |

表中使用斜杠合并公共前缀，例如 `robot_load/describe` 表示 `robot_load`、`robot_describe`。这是按源码整理的产品接口族，不包含 DSH 上游的完整工具表。工具是否出现还取决于 Profile、注入服务和 Provider。

Shell 另注册 `viewer_annotation_send_ui`、`viewer_capture`、`sensor_capture_ui`、`camera_list_ui`、`camera_capture_multi_ui`、`camera_adjust_ui`、`camera_annotation_ui`、`camera_dataset_export_ui`、`ui_engine_switch`、`ui_action_ack`。它们是界面桥接 Commands，不能把 `camera_annotation_ui` 改写为不存在的模型工具 `camera_annotation`；模型端对应的三维标注工具是 `camera_project_annotation`。

### 4.3 Scene 与 Sim 的关键合同

`ctx.scene` 当前提供 `snapshot`、`commit`、`subscribe`、`list`。创建、导入、保存和资源管理由 `SceneOperations` 提供，不要把这些方法假定为 `ctx.scene` 的成员。

`SimService` 提供世界发现、打开、同步、描述、观测、执行、回执查询、停止、帧订阅、关闭、辅助、相机操作与释放；可选 `scene(worldId)` 用于官方环境的只读投影。它没有通用的公开 `step()` 方法，manual 控制通过 Provider 支持的动作／评测接口推进。

典型模型动作参数：

```json
{
  "input": {
    "worldId": "从 sim_open 获取",
    "action": {
      "actionId": "本次动作唯一ID",
      "expectedGeneration": 1,
      "kind": "joint",
      "entityId": "从场景获取",
      "jointNames": ["从 robot_describe 获取"],
      "positions": [0.2],
      "durationS": 1
    }
  }
}
```

示例的代次、关节名和目标值必须由真实世界替换；目标单位由关节类型决定。`ActionReceipt.status=completed` 表示动作结束，业务达成还要看 `taskAchieved`、`effect` 和实际观测。

`trajectory` 默认必须**精确覆盖该机器人的全部受控关节**（`robot_describe.controlledJointNames`），只给一部分关节一律以 `INCOMPLETE_JOINT_VECTOR` 拒绝。确需只驱动一部分关节时用**显式 opt-in** `partialJointVector: true`（当前只在 MuJoCo provider 落地，见 `packages/sim-mujoco/python/worker.py` 的 trajectory 校验；Isaac/Newton 尚未支持）：语义是**未列出的关节保持上一次写入的 ctrl**——不是"不动"、也不是"归零"。因此"手臂轨迹 + 保持夹爪夹持力"必须走这个字段：把夹爪关节塞进手臂轨迹会让 provider 每个 tick 用位置目标覆盖夹爪 ctrl，夹持力被清零。

### 4.4 工作台 HTTP 入口

以下属于 DSH Host 连接上的产品路由；使用 DSH 当前连接与会话身份，不把它们当成无认证的独立公网服务。

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/api/lyapunov/command` | POST | 会话内执行白名单领域 Command |
| `/api/lyapunov/view-selection` | POST | 更新该会话的界面选择身份与序列 |
| `/api/lyapunov/state`、`scenes`、`scene`、`frame`、`robot-description` | GET | 工作台只读投影；表内短名沿用相同前缀 |
| `/api/lyapunov/assets`、`builtin-assets`、`scene-history`、`missing-assets` | GET | Scene 插件提供的只读资源／历史接口 |
| `/api/lyapunov/runtime-info`、`engine-providers` | GET | 运行与安装状态 |
| `/api/lyapunov/engine-preference`、`engine-license`、`provider-install` | POST | 偏好、许可记录、依赖安装请求 |
| `/api/lyapunov/recordings`、`recording`、`recording-resource` | GET | 录制和资源读取 |
| `/api/lyapunov/capture`、`resource`、`segmentation-resource`、`official-view` | GET | 已准入的媒体、资源及官方视图 |
| `/api/lyapunov/workspace` | POST | `{sessionId,action,input}` 文件、搜索、Git、终端等操作 |
| `/api/lyapunov/workspace/xterm-output` | GET | PTY 输出事件流 |
| `/api/lyapunov/model-preview` | GET | 预览文件字节；另有解码器资源路由 |
| `/api/lyapunov/history-draft` | POST | 会话历史草稿恢复接口；详见对应插件 |

`command` 只允许 `scene_`、`asset_`、`policy_`、`sim_`、`robot_`、`joint_`、`vehicle_`、`viewer_`、`sensor_`、`camera_`、`segment_`、`recording_`、`ui_` 前缀。不能把 `generate_*`、`motion_*`、`bench_*` 或 `share_*` 直接塞进这个代理。

### 4.5 账户 API

账户 API 源码已移出本仓（归 LyapunovOM `backend/dev-server/`）；下表是**客户端仍依赖的公开 HTTP 合同**，权威实现与部署对应该独立运维仓库。

| 方法与路径 | 用途与条件 |
| --- | --- |
| `GET /health` | 进程健康 |
| `POST /v1/auth/website/start` | 发起官网授权 |
| `GET /v1/auth/website/callback` | 接收官网回调 |
| `POST /v1/auth/website/complete` | 完成授权；等待时返回 202 |
| `POST /v1/auth/website/exchange` | 交换官网身份 |
| `POST /v1/auth/logout` | 撤销当前会话 |
| `POST /v1/auth/register`、`/v1/auth/login` | 受配置约束的本地邮箱开发路径 |
| `GET /v1/me`、`/v1/plans`、`/v1/payment-methods` | 身份、余额、套餐和支付渠道 |
| `GET /v1/orders`、`/v1/orders/{id}`、`/v1/ledger` | 当前账户订单和流水 |
| `POST /v1/orders` | 按套餐和渠道创建订单 |
| `GET /v1/models`、`POST /v1/chat/completions` | 模型目录与账户模型网关 |
| `POST /v1/marble/v1/media-assets:prepare_upload`、`/v1/marble/v1/worlds:generate` | Marble 上传准备和生成 |
| `GET /v1/marble/v1/operations/{id}` | Marble 状态查询 |
| `POST /v1/ai3d/submit`、`/v1/ai3d/query` | 混元生成与查询 |
| `GET /v1/generation-quotes/{product}` | 接受 `marble`／`hunyuan`／`tripo`／`image`（v8 迁移后的产品域；未配置的产品返回 503） |
| `GET /v1/generation-requests/{product}/{requestId}` | 上述四类 product 的恢复查询 |
| `POST /v1/webhooks/payment` | 本地开发账单回调；中央账单模式拒绝本地处理 |
| `POST /internal/credits` | 管理密钥保护的开发积分入口；中央账单模式拒绝 |
| `POST /internal/reconciliation/{requestId}` | 管理密钥保护的网关对账 |

正式客户端使用 `Authorization: Bearer ...`；生成入口另兼容其协议所需的认证头。外部网站身份启用时配置要求中央账单服务，不能将本地 SQLite 钱包写成正式消费者钱包。

## 5. 日常开发流程

### 5.1 开始前

先读 `git status --short`，确认已有修改；定位实际调用入口、状态 owner、数据目录和受影响 Provider。旧文档与代码不一致时沿代码和实际行为核对，不把旧门编号或旧仓库路径直接复制过来。

实现前写清四件事：用户触发方式、当前行为、修改后行为、验收方式。涉及已知缺口时明确本次范围，不附带清理无关包和历史数据。

### 5.2 实现与接口联动

按合同 → operation／Provider → Tool／Command → UI／HTTP → 文档和验证的顺序调整。字段、默认值和支持枚举变动时，搜索所有入口、客户端、schema、安装器、帮助文本和测试驱动。

保持原有取消、幂等、版本冲突和来源字段的含义。更新一侧 schema 后，至少检查另一侧真实读取的字段与结果形状。

### 5.3 检查与构建

只运行与改动有关的检查，下面的命令不是每次都要全量执行。

```bash
# 产品源码类型检查（根配置，含 packages/lyapunov-api-client；账户 API 已移出本仓）
./node_modules/.bin/tsc --noEmit -p tsconfig.json

# 修改验收驱动时另行检查；根配置不覆盖 script/gates
./node_modules/.bin/tsc --noEmit -p script/tsconfig.gates.json

# 只构建改动的插件；也可省略包名全量构建
bun run script/build-plugins.ts scene-kit robot-tools

# 修改桌面时
bun run build:desktop
```

测试入口以根 `package.json` 为准：`bun run test:ci`（离线清单逐文件跑，非 0 退出码即失败）、`bun run test:ci:list`／`bun run preflight`（只列纳入与理由、不跑）、`bun run release-gate`（发布门）。**发布门不等于真实 GPU／身份／安装验收**。不要用裸 `bun test` 当标准入口（它不做清单与外部标记过滤）。

`release-gate` 自 2026-09-27（GATE-C）起会在**同一次运行里**真跑一次完整 `test-ci` 默认集（收 `--json` 报告、日志保留），据此核验"候选是否有实际执行覆盖"：`caseset-coverage` 只把**本次实跑成功**算覆盖（**旧回执提到过不算**），`manifest-gate-gap` 的"没进门"按实际执行集合衡量（有证据时可缩到 0，冻结值不上调）。为避免递归与白等，完整 CI 子进程只在**依赖它的判据**被选中时起（`--only gate-drivers` 之类不跑）；夹具模式（`--selftest --cases`）不跑真仓 CI。**门绿只覆盖本门范围（离线行为 + 静态合同），不等于真机／图形／GPU／账户／打包验收通过。**

### 5.4 行为验收

| 修改范围 | 现有入口示例 | 运行前应确认 |
| --- | --- | --- |
| Scene 导入、层级、CAS、保存 | `bun run script/refactor-verify.ts --gate G02` | 对应材料夹具存在 |
| Sim 时钟、同步、机器人加载 | `bun run script/refactor-verify.ts --gate G03`／`G04` | MuJoCo Python 与真实模型 |
| 车辆、多实体动作、抓放 | 同一入口的 `G05`／`G06`／`G07` | 对应模型、控制与规划依赖 |
| 资产分域与映射 | `bun run script/verify-asset-layout.ts` | 会执行资产布局及隔离集成检查 |
| Blender、Viewer、相机等扩展门 | `script/gates/run-g10b.mts`、`run-g18.ts`、`run-g19.mts` 等独立驱动 | 先阅读驱动对 SDK、Host、显示和模型的要求 |
| 官方 Gymnasium worker | `packages/benchmark-gymnasium/python/test_worker_protocol.py` | 指定对应 Python 环境 |
| Linux 发行 | `bun run build:linux` 后用真正驱动 `script/gates/run-g17.ts` 核对 | 独立发行环境、账户及运行依赖 |

`refactor-verify.ts` 的帮助中有 `--engine`，但内置 G02–G07 的 `harness()` 直接实例化 MuJoCo；给该入口加 `--engine isaac` 不会自动变成 Isaac 验收。跨引擎检查必须读对应驱动的真实构造路径。

`--all` 也不等于全部功能通过：该聚合仍会对需要独立驱动的门返回指路／阻断，而且不自动运行所有新增门。退出码为 `0` 通过、`1` 实际失败、`2` 阻断，聚合时失败优先于阻断。

### 5.5 提交与评审

提交说明写清触发问题、最终行为、接口／数据影响和实际验证。新增文件与修改文件分开核对，确认未带入 `.runtime`、私有配置、数据库、权重或生成构建物。没有运行的验证明确写“未运行”，不要将以前的截图和回执作为新提交的验收。

## 6. CI 与发布流程

当前 [CI](../.github/workflows/ci.yml) 包含固定上游准备、bootstrap、桌面构建、技能文件格式、**两个本仓 TypeScript 检查**（根 `tsconfig.json` 与 `script/tsconfig.gates.json`，均直接采用 tsc 退出码、**零错误门槛**）、离线行为测试（`bun run test:ci`，未审用例 fail-closed）、资产布局、上游提交一致性与产物存在检查。旧的“允许最多 8 条 TS 错误”容忍值已删除；账户 API 的独立类型检查随其源码移出本仓。

根项目 TypeScript 检查以退出码 0 完成（含 `packages/lyapunov-api-client`）。门驱动、外部供应商、GPU、账户部署和完整发行行为不由当前 CI 全部覆盖；`bun run release-gate` 也只覆盖离线行为与静态合同，**不等于真实 GPU／身份／安装验收**。

Linux 发行流程为：插件／桌面源码检查与构建 → `bun run build:linux` → 检查 `.runtime/releases/` 的归档及打包记录 → 在独立目录解包 → 运行 doctor 和相关功能 → 验证持久数据和退出行为 → 再发布。

打包器生成 `BUILT_NOT_RUNTIME_VERIFIED`，收集依赖闭包并检查包内链接、禁止文件及运行数据。安装 Provider 发生在解包后的运行环境，不代表归档自带所有仿真环境、模型和许可证。**macOS 在本仓只有源码入口与说明，`Dev` 内没有打包／签名／公证产物**；当前根脚本只有 Linux 发行打包命令，不推断 Mac 仓库状态。

## 7. 文档维护标准

- README 写用户能做什么、从哪里进入、需要什么，以及直接影响使用的限制。
- 开发原则写状态归属和稳定语义；开发标准写可执行步骤、接口与已知差异。
- 对外链接使用仓库相对路径，不写开发机 `/home/...` 绝对路径。
- 启动和安装命令注明在源码根还是发行包根执行。
- 功能状态按实际调用链描述，不用目录存在、注释、类型签名或旧回执代替。
- **同一轮同步**：行为、接口、默认值或能力变更时，在同一次改动里更新 [README](../README.md)、[能力总表](CAPABILITY_MATRIX.md) 以及受影响的 [TODO](DEVELOPMENT_TODO.md)／[开发状态](../development/STATUS.md) 条目，不能让一处更新而另一处仍写旧结论。
- **提交说明写文档影响**：说明这次改了什么文档、为什么；确无影响的用一句写明（例如“文档无影响”），不要求新建清单或工具。
- **当前检查结果集中在 [开发状态](../development/STATUS.md)**；历史回执保留其原日期与限定任务，不因今天重跑而原地改写，新结论写到状态页或新回执。
- 不新增文档自动化平台或更多规则体系；维护动作落在上述既有文件和本节的提交纪律上。

## 8. 接口与冗余核对

以下是当前源码中可以定位的事实与维护建议（**§8.2 明确标注为 2026-09-19 审查快照**）；本次只写文档，没有修改这些实现。

### 8.1 已确认的接口与功能差异

| 项目 | 当前代码事实 | 对使用／维护的影响 |
| --- | --- | --- |
| 生成产品域已扩展 | 服务端产品域经 v8 迁移含 `marble`／`hunyuan`／`tripo`／`image`（见 [生成路由](GENERATION_ROUTES.md)）；账户 API 与正式网关源码已移出本仓（归 LyapunovOM `backend/dev-server/`） | 本仓保留客户端 HTTP 合同；正式商业链路以独立运维仓库的部署与授权为准，不在本仓验证 |
| 引擎选择已统一 | `script/engine-preference.ts` 的 `resolveEngine()` 为唯一优先级：显式 `--engine` ＞ `LYAPUNOV_SIM_ENGINE` ＞ 用户偏好 ＞ 默认（Isaac 优先／未就绪回退 MuJoCo）；`launch.ts`、`developer.ts`、`architecture.ts`、桌面经 `host.ts` 共用；开发 YAML 的 `engine` 作为显式覆盖，默认不再写死 | 四个入口不再各自写默认；非法值报错、不静默回退 |
| Newton 入口已统一 | `ENGINE_CHOICES` 含 `newton`，`developer-config.ts` 与 `architecture.ts` 均按该枚举校验；Linux 顶层 help 的 `doctor [mujoco|isaac|newton]`／`install-provider ...newton...` 与 `ui_engine_switch`（描述取自 `ENGINE_CHOICES`）均已列 `newton`；建筑入口示例行仍写 `none|mujoco|isaac` 属帮助文本维护项（不改实现） | 入口支持统一；帮助文本已按 2026-09-27 源码核对，示例行遗留单独登记 |
| 相机族按 Provider 如实展示 | Isaac 五个相机接口（列表／调整／多相机采集／像素标注／数据集导出）已实现并挂共享范围（`robot-tools` 声明面同步，见 `bugfixHistory/DEV009-ISAAC-INTERFACES-20260926.md`）；真实 RTX 成像层待设备可见会话复验；Newton 相机族未实现 | 不按公共 TS 接口推断各引擎支持；Isaac 成像面以 rtx 会话读数为准 |
| 基础验收的引擎参数容易误读 | G02–G07 共用的 `harness()` 写死 MuJoCoProvider | 不能拿 `--engine isaac` 的命令文本当 Isaac 验收证据 |
| DSH 版本声明与实际链接不同 | 多个产品包 peer 仍为 `0.1.5-rc.2`；锁文件描述当前 fork 为 `0.1.6-alpha.1`，bootstrap／link-upstream 使用固定检出 | 升级时一起核对 manifest 与真实装配，不从 peer 字符串推断运行版本 |
| 工作台命令桥不是所有工具的统一入口 | `command` 有明确前缀白名单 | 新 UI 调用需要核对注册和代理；模型能调用不代表 HTTP 代理也接受 |
| CI 类型门槛已收紧 | CI 只保留两个本仓 tsc 入口（根 `tsconfig.json`、`script/tsconfig.gates.json`）并直接采用退出码；旧的“8 条 TS 错误”容忍与账户 API 独立检查（随源码移出）均已删除 | 类型检查为零错误门槛；发布门不等于真实 GPU／身份／安装验收 |

证据：[开发配置解析](../script/developer-config.ts)、[引擎解析](../script/engine-preference.ts)、[建筑入口](../script/architecture.ts)、[基础验收入口](../script/refactor-verify.ts)、[G17 驱动](../script/gates/run-g17.ts)、[Linux 帮助](../distribution/linux/lyapunov)。生成服务与账户 API 源码已移出本仓，公开合同见 [生成路由](GENERATION_ROUTES.md)。

### 8.2 已确认的重复实现与重叠路径（2026-09-19 审查快照，非当前待修清单）

以下比对是一次 **2026-09-19** 的静态索引结果：对 TS／JS 函数体做空白归一化比对，长度大于 180 字符且跨文件的相同函数体有 22 组候选；包含嵌套函数和验收代码，不能换算成“22 个缺陷”。**下表是当时的审查时点记录，不等于今天仍在的缺口**；除本节明确标注 2026-09-27 重核的那一行外，其余行**未经本轮重新核对**，不得当作当前事实或待修清单。对产品代码的确认如下。

| 位置 | 事实 | 处理标准 |
| --- | --- | --- |
| `scene-kit/src/environment-assets.ts`、`network-assets.ts` | `assertMountTarget` 函数体相同，均在下载前验证场景与父实体 | 可提取包内共同实现；保持错误码与下载前检查顺序 |
| `generate-hunyuan/marble/tripo/src/operations.ts` | `persist` 函数体相同；插件中的前台／后台执行小段也相同 | 是局部复用候选；供应商协议、恢复和计费差异仍留在各 Provider |
| `grasp-anygrasp`、`grasp-graspgenx`、`motion-mink`、`motion-ompl` 的 `src/plugin.ts` | 子进程执行闭包存在相同函数体 | 只有取消、Job 和输出语义相同时再复用，不先建立通用框架 |
| `benchmark-gymnasium/src/adapter.ts`、`benchmark-libero/src/operations.ts` | 09-19 时 `load` 函数体相同；**2026-09-27 已重核**：两者共用 `benchmark-contract/src/adapter-concurrency.ts` 的 `AdapterConcurrency` 薄层（`serialize`／`disposeOnce`／`pending`），当时的并发重复已收敛 | 已共享的只是生命周期／并发薄层；奖励、动作空间与成功语义仍各自保留 |
| `script/gates/g01-live.ts`、`g11-live.ts` 等 | NDJSON／连接／PNG 辅助函数重复 | 属于验收维护成本；不是业务重复状态源 |
| Workspace 与上游终端 | 原生 `ctx.terminals` 路径、产品 `xterm-*`／`node-pty` 路径及上游侧栏终端同时存在；产品终端组件仍有调用 | 存在职责重叠，应先核对当前槽位、会话归属、取消与退出清理，不能仅凭“已换上游终端”的旧注释删除 |
| `robot_stop`、`sim_stop` | 都委托 `sim.stop` | 是有意的多入口，未复制停止物理实现 |
| 多个 `grasp_propose` | 三个 Provider 注册相同工具名，运行装配只选择一个 | 属于互斥 Provider，不能同时加载，也不应按重名删除 |

证据：[网络导入](../packages/scene-kit/src/network-assets.ts)、[环境资产导入](../packages/scene-kit/src/environment-assets.ts)、[Workspace 宿主](../packages/lyapunov-workspace/src/plugin.ts)、[Workspace 客户端](../packages/lyapunov-workspace/src/client.tsx)、[机器人操作](../packages/robot-tools/src/operations.ts)、[运行装配](../script/runtime-patch.ts)。

### 8.3 不应误判为冗余的内容

`renderer/account.js` 由 `account-view.tsx` 构建，且已被 Git 忽略；`preferences-theme-data.ts` 是生成的主题数据。它们的大行数不等于同等规模的手写业务复杂度。上游检出、静态解码器、第三方模型和不同格式的资源表示也有各自来源与用途。

本次没有据静态检索宣布任何包“可以安全删除”。删除结论需要补上装配、动态加载、用户入口和发行依赖的引用核对。

## 9. 本次文档核对的验证记录

以下是 2026-09-19 首次核对时的读数；当前状态以 [开发状态](../development/STATUS.md) 为准。

| 检查 | 结果与范围 |
| --- | --- |
| 根 `tsc --noEmit -p tsconfig.json` | 退出码 0；当前根配置覆盖的产品源码（含 `packages/lyapunov-api-client`） |
| 账户 API `tsc -p services/lyapunov-api/tsconfig.json` | 历史读数：退出码 0；该目录已移出本仓，不再适用 |
| TS／JS 语法索引 | 326 个候选文件，无解析错误；包含生成账户 JS |
| Python AST 解析 | 29 个产品／脚本候选文件，无语法错误；未导入或启动 SDK |
| 接口与重复函数 | 完成全范围索引及本节所列关键调用链复核 |

这些记录用于解释当时的代码现状，不构成新一轮模型、GPU、物理引擎、收费生成或正式服务验收。

## 10. 机器人演示的固定流程验收

资产按设计图→生成／下载→尺寸与坐标归一化→视觉与碰撞几何核对→引擎执行→完整界面录制推进。固定动作每次复位，使用 expectedGeneration 和唯一 actionId，逐步检查 completed 与 targetReached；取实际器具状态确认目标位置，失败即停止。倒水要同时看到壶嘴、水流、液面变化和归位；机位与字幕不能遮盖异常。复用原生Jobs汇报和取消，禁止新建后台控制循环。

2026-09-20 [G1／Tripo／Isaac回执](../bugfixHistory/G1-ISAAC-POUR-20260920.md)记录了21段动作、两次完整成功、实际壶嘴偏差与连续录像。固定动作、辅助持壶和液体示意的范围在使用说明与演示说明中一致标注。
