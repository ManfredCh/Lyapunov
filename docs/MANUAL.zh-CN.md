# Lyapunov 0.2.0 Alpha 1 完整操作手册

**Linux x64 · 中文 · 从安装到相机采集与结果核验**

适用于 Linux x64 的 **0.2.0-alpha.1**（预发布，不是 stable）。建议按下面的路径使用：安装并校验 → 首次启动（登录或游客）→ 新建 Scene 与机器人 → 用 Camera 配置持久机位 → 用 Capture 采集 RGB-D／标注 → 用 Recording 录制与回放 → 核对保存与导出产物。

## 0. Camera、Capture 与 Recording 的用途

| 面板 | 入口 | 负责什么 | 不负责什么 |
| --- | --- | --- | --- |
| **Camera／相机** | 右侧工具栏 `Camera`（中文“相机”） | 机器人 **body 挂载机位**：选择机器人、绑定真实连杆、进入视角、预览、持久保存到 Scene、临时试拍、RGB／相机 Depth／LiDAR 三通道比较 | 自由观察视角的拍摄、世界固定机位的多视角采集 |
| **Capture／拍摄** | 右侧工具栏 `Capture`（中文“拍摄”） | 自由观察视角的 `Capture image／采集图像`、世界固定机位、已保存视角、RGB-D 与多相机同帧采集、像素标注、训练数据集导出 | 给机器人添加持久挂载机位 |
| **Recording／录制** | 右侧工具栏 `Recording`（中文“录制”） | 以一台**已挂载机器人机位**为固定来源，录制 RGB、相机 Z 深度、LiDAR range，停止、回放、导出 | 自由相机录制、世界相机录制 |

一句话记忆：

- **Camera** 管“机位在哪里、跟着谁、怎么对准、怎么保存”。
- **Capture** 管“从自由视角或世界固定机位拍一张／同帧拍多台”。
- **Recording** 管“固定一台机器人机位，连续录一段真实传感器帧”。

三个面板都只消费当前 **Scene + world + 代次** 的真实回执。世界没同步、相机没被引擎读回、机位不可用时，按钮会禁用或显示具名原因，不能用界面上的图片代替引擎回执。

---

## 1. 安装前准备

### 1.1 系统前提

- Linux **x86_64**，Ubuntu 24.04 或更新版本，`glibc 2.39` 或更新。
- 有真实图形桌面会话（X11 或 Wayland）。远程无头 shell 不能替代桌面验收。
- 安装包约 **745,352,161 字节（约 710.8 MiB）**，解包后还要放 MuJoCo／Python 运行时和用户数据，请预留足够磁盘。
- 默认安装会准备 MuJoCo 及其独立 Python 环境；本批次含默认策略供给时，还会准备独立的 CPU 策略运行时（`policy-cpu`）。不需要预装系统 Node.js、DSH、Python、pip、Conda 或 Bun。
- Isaac Sim 是可选路线，需要有效 SDK、许可和对应 GPU／RTX 条件；本手册的默认闭环只依赖 MuJoCo。
- 游客可以完成本地工作台、场景、机器人、相机和录制操作；游客**没有默认模型**，需要 Agent 时必须在模型设置里显式配置自己的 provider。

### 1.2 默认安装

在图形桌面的普通终端中执行：

```sh
curl -fsSL https://vorynel.com/lyapunov/install.sh | sh
```

安装成功后**不会自动打开 GUI**。由使用者单独启动：

```sh
"$HOME/.local/bin/lyapunov"
```

安装器会把版本放在 `~/.local/share/lyapunov/versions/<releaseId>/`，检查通过后才切换 `current`，并保留旧版本和用户数据。默认路径：

| 内容 | 路径 |
| --- | --- |
| 应用与下载缓存 | `~/.local/share/lyapunov/` |
| 当前版本 | `~/.local/share/lyapunov/current` |
| 上一个版本 | `~/.local/share/lyapunov/previous` |
| 命令入口 | `~/.local/bin/lyapunov` |
| 桌面入口 | `${XDG_DATA_HOME:-$HOME/.local/share}/applications/lyapunov-desktop.desktop` |
| 默认策略 CPU 运行时 | `<版本目录>/.runtime/policy-python/`（本批次含默认策略供给时） |
| 策略运行时日志 | `<版本目录>/.install/policy-cpu.log`、`.install/policy-cpu.exit` |
| 安装回执 | `<版本目录>/.install/` |

**应看到：** 终端依次报告归档校验、MuJoCo 准备；本批次含默认策略供给，还会报告默认机器人策略 CPU 运行时准备，并写入 `<版本目录>/.install/policy-cpu.log` 与 `.install/policy-cpu.exit`；随后是 `doctor` 与原生 `physics-check`，最后报告安装就绪并保留启动入口。没有 “ready” 就不要启动。

### 1.3 固定安装 0.2.0-alpha.1

官网默认切换后，上面的命令会读取 `releases/latest/` 并安装 0.2.0-alpha.1。需要明确钉住本批次时：

```sh
curl -fsSL https://vorynel.com/lyapunov/install.sh -o lyapunov-install.sh
less lyapunov-install.sh
sh lyapunov-install.sh --version rcui-v11-20261022T151637Z-agraph5
```

可用选项（以 `sh lyapunov-install.sh --help` 为准）：

| 选项 | 作用 |
| --- | --- |
| `--version RELEASE_ID` | 安装一个固定发布批次 |
| `--prefix /绝对路径` | 指定应用、版本和下载缓存根目录 |
| `--bin-dir /绝对路径` | 指定 `lyapunov` 启动器目录 |
| `--no-desktop` | 不创建桌面入口，仍保留命令入口 |
| `--without-mujoco` | 跳过默认 MuJoCo 准备和物理检查 |

### 1.4 手工下载与校验

固定版本清单：

```sh
curl -fsSL https://vorynel.com/lyapunov/releases/rcui-v11-20261022T151637Z-agraph5/linux-x64.json
```

主包：

```sh
curl -fL -o lyapunov-0.2.0-alpha.1.tar.gz \
  https://vorynel.com/lyapunov/releases/rcui-v11-20261022T151637Z-agraph5/lyapunov-linux-x64-rcui-v11-20261022T151637Z-agraph5.tar.gz
sha256sum lyapunov-0.2.0-alpha.1.tar.gz
wc -c < lyapunov-0.2.0-alpha.1.tar.gz
```

本批次应核对：

- 字节数：`745352161`
- SHA-256：`bb4d5981b09fc985ae2cb1ca9ea65bd13fd65cb7c8975123593803c98419049d`
- 归档根：`lyapunov-dsh-0.2.0-alpha.1-linux-x64`
- 最低 glibc：`2.39`

手工解包后，在包根运行：

```sh
./lyapunov install-provider mujoco
./lyapunov install-provider policy-cpu
./lyapunov doctor mujoco --managed-sdk
./lyapunov physics-check --managed-sdk
./lyapunov
```

`install-provider` 在准备结束后会自行运行对应 provider 的 doctor，不需要再给 `install-provider` 传 doctor 参数；上面单独的 `./lyapunov doctor mujoco --managed-sdk` 是 CLI 的独立复核入口。`policy-cpu` 使用独立前缀 `.runtime/policy-python`，日志写入 `.install/policy-cpu.log` 与 `.install/policy-cpu.exit`。

### 1.5 实测故障：默认策略 CPU 下载超时（VM24，exit 2）

2026-10-23 在 VM24（Ubuntu 24.04）按默认命令安装本批次时，安装器已完成主包与 MuJoCo 准备，但在默认策略 CPU 阶段以 **exit 2** 结束。`.install/policy-cpu.log` 末尾为 `TimeoutError: The operation was aborted due to timeout`，安装器随后报告 `DEFAULT_POLICY_RUNTIME_FAILED`，并明确保留原 `current` 与用户数据。不能因为旧版仍能启动或安装进程还在，就判定新版安装成功。

该阶段由 `ensurePolicyCpuWheel` 下载 PyTorch CPU wheel：`torch-2.11.0+cpu-cp312-cp312-manylinux_2_28_x86_64.whl`，`190,312,281` 字节，SHA-256 `f82e2ae20c1545bb03997d1cc3143d94e14b800038669ee1aca45808a9acc338`；下载请求使用 **180 秒**超时。这是 PyTorch 下载，不是 Hugging Face 模型下载。VM26 使用同 SHA 已下载 wheel 预置缓存继续做控制测试，属于缓存复用，不代表默认公网下载已通过。

处理顺序：

1. 保留现有版本目录、`.install/` 和下载缓存，重跑原安装命令；已校验的主包与正确缓存会复用，中断下载可能保留为 `.partial`。
2. 查看 `<版本目录>/.install/policy-cpu.log`、`.install/policy-cpu.exit`。需要时同时看 `.install/provider.log` 与终端 Host 输出，按实际错误处理。
3. 只有在已有同 SHA wheel 时，才把它放到候选版本目录的 `.runtime/provider-download-cache/policy-cpu-wheels/` 后重试；不同字节或摘要会被拒绝，不要改文件名冒充。
4. 用 `readlink "$HOME/.local/share/lyapunov/current"` 确认仍指向旧版本；不要把 `current` 手工指向尚未通过检查的候选目录，也不要删除旧版。

### 1.6 失败处理

| 现象 | 先检查 |
| --- | --- |
| 下载阶段失败 | 输出里的固定 URL、对象、字节数或摘要；保留 `.partial` 后重试同一版本 |
| `DESKTOP_LIBRARIES_MISSING` | 回到图形桌面的普通终端重跑安装器，让它在正常授权下准备缺库；不要关闭 AppArmor 或系统沙箱 |
| `CONTEXT_ONLY` | 当前终端的安全上下文不足以完成桌面检查；在该桌面普通终端复查，不记为机器通过或失败 |
| `PROVIDER_UNAVAILABLE` | 检查实际引擎、托管 SDK 路径和外部 Python 路径；`install-provider` 只准备托管环境 |
| `DEFAULT_POLICY_RUNTIME_FAILED` | 默认策略 CPU 环境未通过；查看 `.install/policy-cpu.log` 与 `.exit`，保留旧 `current`，重跑原安装器。旧版可启动不等于新版安装成功 |
| 安装成功但打不开 | 先运行 `"$HOME/.local/bin/lyapunov" --version`，再运行 `doctor mujoco`；查看 `.install/provider.log`、`.install/physics-check.log` 和终端 Host 日志 |

### 1.7 升级、回滚、卸载

升级前退出应用，导出重要工程，或复制实际数据根。产品没有自动备份命令。

重跑同一条安装命令即可升级；`previous` 记录升级前的 `current`。回滚代码：

```sh
lyapunov_prefix="$HOME/.local/share/lyapunov"
lyapunov_target=$(readlink "$lyapunov_prefix/previous")
case "$lyapunov_target" in versions/*) ;; *) exit 2 ;; esac
test -x "$lyapunov_prefix/$lyapunov_target/lyapunov" || exit 2
lyapunov_pending="$lyapunov_prefix/.current.rollback.$$"
ln -s -- "$lyapunov_target" "$lyapunov_pending" &&
  mv -Tf -- "$lyapunov_pending" "$lyapunov_prefix/current"
"$HOME/.local/bin/lyapunov" --version
```

如果新版本已经迁移数据布局，代码回退不够；要用升级前的数据副本恢复运行根，再切换客户端。卸载只删除有 Lyapunov 归属标记的入口和安装目录，保留用户工程、资产和凭据。

---

## 2. 首次启动：登录或游客

### 2.1 欢迎页

启动后应看到 Lyapunov 欢迎页，包含语言、主题、登录和游客入口。中文文案为：

- `使用 Lyapunov 账户登录`（英文 `Continue with Lyapunov`）
- `以游客身份继续`（英文 `Continue as guest`）
- 游客提示：`本地体验，可在工作台配置自己的模型。`（英文 `Explore locally. Bring your own model provider.`）

### 2.2 登录路线

1. 点 `使用 Lyapunov 账户登录`。
2. 在浏览器完成官网授权，再回到同一个应用窗口。
3. 看到 “正在进入工作台…” 后进入工作台。

登录账号使用官网账号服务与中央 Credits。需要官网模型服务时，先注册账号并充值；账号页会显示实际连接和可用点数。

### 2.3 游客路线

1. 点 `以游客身份继续`。
2. 进入独立的本地工作台，标题显示 `游客 · 自有模型可配置`（英文 `Guest · Configure your own provider`）。
3. 游客不连接产品账户、计费后端或中央 Credits；文件、Scene、Viewer 和已安装本地工具可用。
4. 游客没有默认模型。需要 Agent 时，在模型设置里显式配置自己的 provider；只做手动工作台和相机操作时不需要模型。

**应看到：** 工作台出现左侧工作区／会话区、中间 3D 画布、右侧工具轨。没有出现欢迎页后的工作台，先看 2.5。

### 2.4 Agent 执行闭环（可选）

手动路线不要求 Agent。只有完成模型与账户条件后才走本节；游客也可以显式配置自己的 provider。

1. **完成条件**：登录账号有可用模型与积分，或游客已配置自己的 provider；没有模型时只用工作台控件。
2. **说明目标、对象与预算**：给出目标实体／Scene、期望动作，以及允许的调用次数、仿真步数或时间上限。
3. **先检查当前场景**：读取当前 Scene、引擎、world 与代次，确认机器人、相机和可用工具，不靠猜。
4. **调用原生工具**：使用场景、机器人、Camera／Capture／Recording 等原生产品工具；不要用 CUA 点击代替这些工具。
5. **读取相机与数值反馈**：核对采集 ID、RGB／深度、K、关节与位姿回执，以及失败原因码；按实际读数修正。
6. **核对完成条件与保存产物**：用任务判定与真实回执确认完成，再检查保存的 Scene、采集、录制和导出路径；没有回执不要宣告完成。

来源：0.2.0-alpha.1 的 Agent Graph 与原生工具合同（`docs/releases/0.2.0-alpha.1.md`）。本节是操作顺序，不是 Agent 实测记录；本轮未发起付费模型调用。

### 2.5 失败处理

| 现象 | 处理 |
| --- | --- |
| 登录后停在等待页 | 确认浏览器授权是否完成；取消后重试。不要反复启动第二个实例 |
| 游客能进但 Agent 不响应 | 游客没有默认模型；到模型设置配置自己的 provider，或先用手动工作台完成场景和相机 |
| 窗口打不开／无显示 | 从终端启动看 Host 输出；运行 `doctor mujoco`。如果是 X11／Wayland 会话问题，记录会话类型、GPU 和窗口是否 mapped，不要把进程存在当作显示成功 |
| 白屏 | 先看终端错误和 `doctor`；再检查渲染后端和桌面共享库。不要用 `--no-sandbox` 掩盖问题 |
| 游客工程找不到 | 游客工程与登录工程分开保存；在游客工作台导出工程，登录后再显式导入，不自动合并 |

---

## 3. 新建项目、场景与打开工程

### 3.1 新建会话和工作区

在左侧工作区／会话区新建一个会话（`New session／新建会话`）。每个会话有自己的工作目录、Scene 和运行记录。游客与登录账号的会话、工程彼此隔离。

### 3.2 新建 Scene

打开右侧 `Scene／场景` 工具。首次没有场景时会看到空态，两个按钮：

- `创建物理工作区`（英文 `Create physics workspace`）：创建带零厚度无限地面和重力的物理场景模板，适合本手册的相机闭环。
- `空白制作`（英文 `Blank editing scene`）：只创建编辑场景；第一次启动物理世界时才加入可管理的无限地面。

也可以点 `新建物理场景`／`New physics scene`。创建后：

**应看到：** Scene 树里出现 `无限地面／Infinite ground`（或 `Built-in world`）和场景版本 `rev 0` 左右的记录；画布出现地面和网格。没有地面时不要先放机器人，先重新创建物理场景。

### 3.3 打开已有工程

在 `Scene／场景` 的 `打开场景／Open scene` 折叠区：

- `工程文件路径／Project file path` 填入 `scene.json` 或可移植工程目录。
- `打开工程／Open project` 打开现有场景。
- `打开副本／Open copy` 在同名场景已有更改时作为新场景打开，保留原场景。
- `保存工程／Save project` 以 `portable` 方式保存工程及依赖闭包。

**失败处理：** 路径不存在、工程版本不兼容、引用文件缺失时，界面会报错并保留当前场景。不要用“另存”覆盖原工程来绕过版本错误；先复制工程目录再试。

---

## 4. 导入或选择机器人

### 4.1 从 Robot Library 选择

1. 点右侧 `Robots／机器人`。
2. 默认打开 `机器人库／Library` 页签；另一个页签是 `场景内／In scene`。
3. 在 `搜索机器人／Search robots` 输入 `franka_panda`。
4. 选中条目，点 `加入场景／Add to scene`（未登记时显示 `登记并加入场景／Register, then add`）。
5. 在 3D 画布上点击落点。
6. 底部放置条选择 `放置基准／Placement basis`：`模型原点／Model origin` 或 `底面对齐／Align bottom`。
7. 点 `放置物体／Place object`。

当前随包的 11 个 T0 条目包括 `allegro_hand`、`crazyflie_2`、`franka_panda`、`generic_quadrotor`、`leap_hand`、`shadow_hand`、`unitree_a1`、`unitree_g1`、`unitree_go1`、`unitree_go2`、`ur10e`。`unitree_a1` 与 `generic_quadrotor` 没有内置运动策略，需要外部控制器／适配器才会运动。

**应看到：** Scene 树出现机器人实例，画布出现真实几何和材质；Robots → `场景内／In scene` 能看到实例。能看见模型不等于物理已就绪，也不等于策略可执行。

### 4.2 导入自己的机器人文件

1. Robots 面板点 `导入文件／Import file`。
2. 选择真实的 MJCF／URDF 根文件，保留 `include`、mesh、纹理和执行器依赖闭包。
3. 点 `导入素材／Import asset`；导入后条目进入当前类资源列表。
4. 选中条目，点 `加入场景／Add to scene`，再按 4.1 的放置步骤落点。

**失败处理：**

- `Model not bundled`：该条目只有元数据、没有随包模型；换随包 T0，或提供自己有权使用的完整模型。
- 纹理／mesh 缺失：保留源文件目录结构，不要把 `.xml` 单独拷出来。
- 导入后只看到空实体：先检查资源是否登记成功，再重新“加入场景”，不要用空实体冒充机器人。

### 4.3 打开机器人详情

在 Robots → `场景内` 点机器人行，进入详情。这里读取真实关节、执行器、TCP 和策略状态。记录：

- 机器人实例名与实体 id。
- 实际引擎和 world 状态。
- 真实关节／DOF 和限位。
- 是否声明了控制器／策略，是否存在缺项。

这些读数后面会用于判断相机是否绑定在真实连杆上。

---

## 5. 引擎与物理世界

### 5.1 选择引擎

右侧下方 `引擎／Engine` 按钮显示当前运行引擎和已保存偏好。单击切换偏好；**引擎在启动时装配，切换在下次启动工作台后生效**，不会中途替换当前运行会话。

默认和本手册使用的是 **MuJoCo**。Isaac 需要有效 SDK、许可和 RTX 条件；Newton 当前能力范围较窄，不能把它当作 MuJoCo 的完整替代。

### 5.2 启动世界

1. 点右侧 `Physics／物理`。
2. 确认 `引擎／Engine` 显示 `mujoco`（或 `未启动／Not started`，启动后读回）。
3. 点 `启动物理／Start physics`。
4. 等待状态从初始化进入 `ready／paused／running`。
5. 展开 `读取详情／Readback details`，核对实际引擎、world id、已应用场景版本、代次和步数。

**应看到：** 状态栏显示真实引擎和 `step`／`simTime`；`世界／World` 行显示实际 world。若场景在启动后又被编辑，`应用场景修改／Apply scene changes` 会把最新 Scene 同步到 world。

### 5.3 暂停、继续、停止

- `暂停物理／Pause physics`：停止推进但保留 world。
- `继续物理／Resume physics`：从当前状态继续。
- `停止物理／Stop physics`：结束本次物理；录制也会随之不能继续采集。
- `关闭物理世界／Close physics world`：关闭当前 world。

**失败处理：**

| 现象 | 检查 |
| --- | --- |
| 启动按钮禁用 | 是否选了可编辑场景；是否已有 world；当前引擎 provider 是否可用 |
| `当前Host未装配可用物理引擎` | 检查引擎偏好和服务端依赖；`install-provider mujoco` 与 `doctor mujoco --managed-sdk` |
| 世界启动了但场景改动不生效 | 看 `已应用场景 rev` 与当前 Scene `rev` 是否一致；点 `应用场景修改` |
| 机器人可见但不动 | 这是正常的准备状态：先确认关节、碰撞、控制器和策略匹配；策略需 prepare/match 后才显式执行 |

---

## 6. 视角导航：观察视角不是相机机位

### 6.1 自由观察

- 鼠标左键拖动：环绕。
- 滚轮：缩放。
- 右键拖动：环顾／调整方向。
- 进入第一人称漫游后点击画布：`W／A／S／D` 水平移动，`Q／E` 升降，`Shift` 加速，右键环顾。
- 画布失焦后移动停止；`Esc` 返回环绕模式。

Capture 面板的 `场景中心／Scene center`、`全景／Fit`、`聚焦选中／Focus selected` 只移动观察相机，不改变模型位置，也不保存为机位。

### 6.2 已保存视角

Capture → `Saved views／已保存视角` 可以保存和恢复观察视角。它属于 Scene 文档里的命名视角，和引擎传感器相机是两套东西：

- 保存视角只保存 Viewer 的观察状态。
- 进入已保存视角不等于进入机器人机位。
- Viewer 截图也不自动等于引擎标定帧。

### 6.3 相机视角

在 Camera 面板选中已保存或原生机位后：

- `进入相机视角／Enter camera`
- `进入并跟随相机视角／Enter and follow camera`
- `返回主视图／Return to main view`，`Esc` 也可退出锁定视角。

挂载机位带“跟随”语义；世界固定机位不会随机器人关节运动。

---

## 7. 机器人持久机位（Camera 面板）

> 当前界面里，右侧 `Camera／相机` 面板的 scope 是 **mounted**：它管理机器人 body 上的机位。世界固定机位在 `Capture／拍摄 → 拍摄设置 → 世界固定机位` 里。

### 7.1 选择机器人并添加机位

1. 确认 Scene 里已有机器人，且 world 已同步到当前 Scene 版本。
2. 打开 `Camera／相机`。
3. 在机器人选择行点当前机器人实例。
4. 点 `给这个机器人添加相机／Add camera to this robot`。
5. 面板进入 `新建相机／New camera`。

**应看到：** 表单依次出现 `相机名称／Camera name`、`机器人／Robot`、`挂载位置／Mount location`。如果物理世界还没同步，`挂载位置` 会提示“物理世界同步后读取真实连杆，才能保存机器人机位”。

### 7.2 绑定真实连杆

1. `挂载位置／Mount location` 下拉选择真实连杆。
2. 推荐按钮来自真实 body 名称与当前唯一读回，例如 `头部（推荐）／Head (suggested)`、`手腕／wrist`、`手部 / 夹爪／hand / gripper`、`末端工具／End tool`、`基座 / 底盘／Base / chassis`。
3. 不要手写不存在的 body 名；下拉里标 `（不可用）／(unavailable)` 的条目不能保存。
4. 若列表为空，先点 `读取真实连杆（需物理）／Read native links (needs physics)` 或 `刷新连杆／Refresh links`。

**坐标口径：**

- 挂载机位的位姿在**所选连杆的局部坐标系（parent／body-local）**中，单位米，四元数顺序 `xyzw`。
- 机器人运动时，机位按该连杆的真实 FK 跟随，不是世界固定。
- 新机位默认从当前画面采样，所以初始位置／四元数来自同一显示帧，不会凭空吸到 body 原点。

### 7.3 设置位置与方向

首屏的 `位置与方向怎么填／How to set position and direction` 里有三个动作：

- `使用当前画面／Use current view`：把当前 Viewer 姿态复制进草稿，并换算到所选连杆局部系。
- `移动位置／Move position`：展开 `局部姿态／Local pose` 的 XYZ 字段。
- `旋转方向／Rotate direction`：展开 `视线法向 XYZ／Viewing normal XYZ` 与可选 `向上方向 XYZ／Up direction XYZ`。

高级折叠 `局部姿态／Local pose · 连杆局部／body-local` 中可精确输入：

| 字段 | 含义 | 默认／范围 |
| --- | --- | --- |
| `相机位置 XYZ 米／Camera position XYZ m` | 连杆局部位置，米 | 新机位由当前画面换算；世界相机默认 `0 0 1` |
| `相机旋转 xyzw／Camera rotation xyzw` | 连杆局部四元数 | 默认 `0 0 0 1`（未采样时） |
| `视线法向 XYZ／Viewing normal XYZ` | 相机 −Z 前向的世界方向 | 可选；由法向换算四元数 |
| `向上方向 XYZ（可选）／Up direction XYZ (optional)` | 相机 +Y 上方向 | 可选 |
| `按法向调朝向／Aim along normal` | 用 normal/up 重算朝向 | 需要非空 normal |
| `用当前机位标定／Calibrate from current view` | 用当前画面重新采样 | 需要当前场景和可编辑权限 |

相机轴约定：**+X 右 / +Y 上 / −Z 前**。世界相机使用右手 Z-up 世界系；挂载相机使用连杆局部系。两者不要混填。

### 7.4 镜头参数

展开 `镜头／Lens`：

| 字段 | 默认 | 有效范围 | 说明 |
| --- | --- | --- | --- |
| `竖直 FOV 度／Vertical FOV deg` | `50` | 保存校验 `0 < FOV < 180`；Aim 输入框 `0.01–179.99` | 竖直视场角 |
| `相机宽度像素／Camera width px` | `640` | 整数 `16–4096` | 像素宽 |
| `相机高度像素／Camera height px` | `480` | 整数 `16–4096` | 像素高 |
| `near 裁剪声明米／Declared near clip m` | `0.01` | `0 < near < far` | 米 |
| `far 裁剪声明米／Declared far clip m` | `100` | `> near` | 米 |

K（fx／fy／cx／cy）显示在镜头折叠内。相机名称不能为空、不能包含 `/`，长度有限制。

**应看到：** 摘要行 `镜头／Lens` 显示 `640 × 480` 等值；`局部位置／Local pose` 显示三位小数米值。

### 7.5 保存持久机位

两种保存方式：

- `保存相机／Save camera`：保存当前草稿（名称、连杆、局部位姿、镜头）到 Scene。按钮 title 会根据目标显示 `保存连杆安装／Save body installation`、`保存挂载相机／Save mounted camera` 或 `保存固定相机／Save world camera`。
- `保存当前画面安装／Save current-view installation`：重新采当前完整画面，作为这次安装。

保存成功后：

**应看到：** 面板回到机位详情，`‹ 机器人机位／‹ Robot cameras` 可返回列表；Scene 树出现相机节点；该机位以 `挂载／Mount <body>` 出现在机位列表。保存只写 Scene，不自动把新相机读回引擎；需要时重新同步 world。

**失败处理：**

| 提示 | 处理 |
| --- | --- |
| 物理世界同步后读取真实连杆，才能保存机器人机位 | 先在 Physics 启动物理并同步，再读取连杆 |
| 选择一个当前机器人真实连杆后才能保存 | 选择唯一、可用、真实存在的 body |
| 挂载 body 名不唯一 | 换一个唯一 body，或刷新读回 |
| 目标 body 尚无当前原生读回 | 重新同步 world，等待回读 |
| 相机位姿须提供 3 个／4 个有限数值 | 检查 XYZ／xyzw 是否缺项或含非数字 |
| `CAMERA_PARENT_NONRIGID` | 当前父级缩放不能表示该世界机位；改用世界相机或修正父级变换 |

### 7.6 进入、预览和跟随

保存后选中机位，`位置、方向与操作／Position, direction and actions` 中有：

- `编辑／Edit`
- `预览／Preview`（进入该机位视角）
- `调朝向／Aim direction`

详情摘要还提供 `进入并跟随相机视角／Enter and follow camera`、`在安装原点调朝向／Aim from installation origin`、`返回主视图／Return to main view`、`刷新画面／Refresh image`、`实时预览／Live preview`。

`调朝向／Aim direction` 时：

- 安装原点锁定，移动键不改变位置。
- 右键拖动调整视线。
- 运动时相机仍跟随真实连杆。
- `保存并结束编辑／Save and finish editing` 保存；`放弃草稿／Discard draft` 或 `Esc` 放弃并返回。

**应看到：** 进入后画面来自该机位的真实位姿与 K，而不是自由观察相机；退出后回到主视图。若只看到灰色／加载失败，先检查 `此相机暂不可用／Camera unavailable` 的原因。

### 7.7 恢复安装基线

`恢复安装基线／Restore installation baseline` 把机位恢复到第一次保存的 baseline。它只对已有 `installation.baseline` 的相机有效；没有基线会报 `CAMERA_BASELINE_MISSING`。

### 7.8 删除机位

`删除场景相机／Delete scene camera` 删除 Scene 中的相机实体。它不改机器人模型，也不删除采集产物。

---

## 8. 世界固定相机（Capture 面板）

世界相机不随任何机器人关节运动，适合固定观察工位、传送带或场景入口。

1. 点右侧 `Capture／拍摄`。
2. 展开 `拍摄设置／Capture settings`。
3. 展开 `世界固定机位／World-fixed cameras`。
4. 点 `新建世界固定相机／New world camera` 或 `从当前视角新建世界相机／New world camera from current view`。
5. 表单的 `机器人／Robot` 选择 `世界固定相机／World camera`（空值）。
6. 输入 `相机名称／Camera name`；需要时编辑 `局部姿态／Local pose · 世界／world`。
7. 位置单位米，世界系右手 Z-up；四元数 `xyzw`；相机轴 +X 右 / +Y 上 / −Z 前。
8. 点 `保存相机／Save camera`。

**应看到：** Scene 树出现相机节点，`Lens` 显示默认 640×480，`局部姿态` 摘要显示世界系位置。保存后可从 3D 视锥或相机详情进入视角。

**注意：** 世界相机没有“跟随”语义；机器人运动时它不动。挂载相机不要在“世界固定相机”里保存，否则会丢失 body 跟随关系。

---

## 9. 预览与 RGB-D 采集（Capture 面板）

### 9.1 自由视角拍一张

Capture → `拍摄设置／Capture settings`：

1. 点 `采集图像／Capture image`。
2. 看到当前观察视角的采集缩略图和 `rev ... · step ...` 读数。
3. 点缩略图选中，可进入 `SAM3 · 图像分割`，输入对象描述后点 `用 SAM3 分割图像／Segment image with SAM3`。SAM3 需要实际模型权重；缺权重时界面应报阻断，不能用 2D mask 或截图冒充分割成功。

**边界：** 这是自由观察视角的截图，不是引擎命名相机标定帧。它可以用来记录画面，但不能冒充 RGB-D 或传感器标定数据。

### 9.2 命名相机 RGB-D／标定

Capture → `RGB-D 采集与多视角／RGB-D capture and multi-view` → `相机 RGB-D / 标定／Camera RGB-D / calibration`：

1. `原生相机名（可选）／Named camera (optional)` 填一台真实命名相机；留空则用自由相机。
2. `宽度／Width` 默认 `320`，`高度／Height` 默认 `240`，范围 `16–4096` 整数。
3. 点 `采集 RGB-D 并读取标定／Capture RGB-D and read calibration`。

**应看到：**

- 一张真实 RGB 图（`当前模拟相机 RGB 采集`）。
- `下载深度 NPY（米）／Download depth NPY (meters)` 链接。
- `pinhole · 宽×高 · fx · fy` 标定读数。
- 展开 `RGB-D 与标定来源／RGB-D and calibration provenance` 可看回执字段。

**重要区别：**

- **RGB**：相机原生 PNG，8-bit 颜色。
- **相机 Depth**：沿光轴 **Z 轴**的米制深度 NPY，不是沿射线距离。
- **LiDAR range**：沿射线欧氏距离的米制 NPY，语义与相机 Z 深度不同，不能互相冒充。

如果 `原生相机名` 留空，自由相机通常没有稳定标定，界面会提示“请填写原生相机名”。这不是失败，而是不能把自由视角当作标定相机。

### 9.3 多台相机同帧采集

同一折叠区下面：

1. 点 `读取命名相机位姿与视场／List named camera poses and FOV`。
2. 回执列出每台相机的 `fovy`、`挂载／mount`、`位姿来源／pose source`；不可用条目会标原因。
3. 勾选要采集的相机（首次读取时默认勾选全部可用相机）。
4. 设置 `多视角宽度／Multi-view width`、`多视角高度／Multi-view height`（默认 320×240，16–4096）。
5. 点 `同一物理步采集全部所选相机／Capture all selected cameras in one step`。

**应看到：** `同帧 N 台相机 · W×H · step ...`；每台相机一张 RGB、一个深度 NPY 链接、`fovy／fx／cx／cy`。如果某台相机带 `临时 override`，回执会明确标出。

**点击标注：** 在多视角 RGB 图上点击像素，会用该次真实采集的米制深度和标定生成世界点，界面显示：

- `世界点 [x, y, z] m`
- `深度 ... m`
- `标注已保存：<annotationPath>`

无效深度（背景／无返回）会阻断三维点，不编造坐标。

### 9.4 导出训练数据集

点 `导出当前多视角训练数据集／Export current multi-view training dataset`。成功后面板显示：

```text
训练数据已导出：<outputDir>
```

导出只使用真实采集；2D mask 不会自动修改 3D 资产。数据集目录和采集文件都按当前会话隔离。

### 9.5 相机预览与三通道比较（Camera 面板）

在 `Camera／相机` 选中一台可用机位后，详情里可看到：

- `预览／Preview` 或 `刷新画面／Refresh image`。
- `RGB`、`深度／Depth`、`LiDAR` 标签。
- `比较通道／Compare channels`：打开 `RGB / 相机Depth / LiDAR 对照`。
- `扫描 LiDAR／Scan LiDAR`。
- `下载原始 PNG`、`下载原始深度 NPY`、`下载原始 range NPY`、`有效掩码／valid mask`、`命中几何／hit geom`、`原生预览 PNG`。

LiDAR 扫描参数默认：

| 参数 | 默认 | 范围 |
| --- | --- | --- |
| `波束数／Beams` | `16` | `1–512` |
| `每圈方位采样／Azimuth samples` | `360` | `1–4096` |
| `量程米／Range m` | `20` | `≥ 0.001`，步长 0.1 |
| `竖直视场 下 上／Vertical FOV low high` | `-15 15` | 两个有限数，下界 < 上界（度） |

比较面板会显示 `同帧／Same frame` 或 `非同帧／Different frames`，并给出 camera step、LiDAR step、Δstep、Δt。只有真实同帧才显示“同帧”；身份不完整时不声称同帧。

**不要混用：**

- `RGB` 是颜色图，不是深度。
- `相机 Z 深度` 是沿光轴的轴向 Z。
- `LiDAR range` 是沿射线的欧氏距离；无返回有独立颜色。
- 相机能看到环境，不等于碰撞几何已配准。
- Viewer 截图不等于传感器标定帧。

---

## 10. 持久机位与临时 override

### 10.1 持久机位

持久机位写入 Scene 文档：

- Camera 面板的 `保存相机／Save camera`。
- `保存当前画面安装／Save current-view installation`。
- 世界相机在 Capture → 世界固定机位里的 `保存相机`。
- `恢复安装基线／Restore installation baseline` 读取 `installation.baseline`。

持久机位会随工程保存、重开和版本历史恢复；挂载机位还保留 `mount.entityId + mount.bodyName` 与连杆局部外参。

### 10.2 临时 override

临时 override 是 Provider 侧的试拍调整，**不改源文档**：

Capture → `临时位姿 / 视场调整（高级）／Temporary pose / FOV overrides (advanced)`：

1. `被调整的相机名／Camera to adjust` 填真实相机名。
2. `位姿参考系／Pose reference frame` 选择：
   - `parent（body 局部）／parent (body local)`：相对相机所属 body 的局部安装位姿，推荐腕部／头部挂载；每帧随父 body FK 更新。
   - `world（世界）／world`：世界位姿，不随关节运动改变。
3. `位置 x y z（米，按所选参考系，留空不改）`。
4. `四元数 x y z w（留空不改）`。
5. `竖直视场角／Vertical FOV`，范围 `1–179` 度；只改 FOV 不会冻结挂载相机位姿。
6. 点 `应用临时调整（不改源文档）／Apply temporary override (source untouched)`。
7. 回执显示 `override=true／false`、`代次`、`clearOn`、`参考系`、`所属body`、`最终世界位置`。
8. 点 `清除临时调整／Clear override` 撤销。

Camera 面板里的原生相机拖动／Aim 调整也走临时试拍；界面会提示 `Temporary preview installation applied; save the current-view installation to Scene to keep it.`。要持久化，必须回 Camera 保存到 Scene。

**边界：** 临时 override 在 world 换代／关闭等 `clearOn` 条件发生时清除；不要把它当作已保存机位，也不要在回执 `override=false` 时声称已持久化。

---

## 11. 录制（Recording 面板）

### 11.1 前提

Recording 只录**机器人 body 上的真实挂载机位**：

- Scene 里有机器人。
- 机位已保存到 Scene，并被当前 world 读回原生相机。
- 世界状态为 `ready／running／paused`。
- 机位在 `camera_list` 回执里 `available !== false`。

### 11.2 开始录制

1. 点右侧 `Recording／录制`。
2. 在 `机位／Camera source` 选择一台真实机位，例如 `Franka · panda_link7 · wrist`。
3. 看到 `通道／Channels`、`时长／Duration`、`分辨率／Resolution`。
4. 勾选通道。默认勾选 `RGB` + `深度／Depth`；`LiDAR` 默认不勾：
   - `RGB`（PNG，8-bit）
   - `深度／Depth`（相机 Z 深度，米）
   - `LiDAR`（沿射线欧氏 range，米）
5. `录制秒数／Recording duration` 默认 `30`，有效 `0.1–300` 秒。
6. `分辨率／Resolution` 默认继承来源声明的宽高；点 `设置／Edit` 可输入 `16–4096` 整数。
7. 点 `开始录制／Start recording`。

**应看到：** `录制中／Recording` 卡片显示 `累计仿真秒 / 配置上限`、`帧／frames`、固定来源、通道状态；每个通道只有真实采到帧才显示 ✓，失败保留 `不可用／unavailable` 原因。

### 11.3 停止、回放、导出

- `停止录制／Stop recording` 只结束录制，不停止模拟。
- `最近录制／Recent` 列表显示每条的 `status`、`elapsedS / maxDurationS`、帧数、缺件数。
- `观看回放／Watch replay`：进入 `录制回放／Recorded replay`，可 `播放录制／Play recording`、`暂停回放／Pause replay`、拖动 `录制回放时间线／Recorded replay timeline`、`返回实时视图／Return to live view`。
- `帧来源／Frame provenance` 显示 scene、world、generation、scene rev、frame rev。
- `导出／Export`：把真实帧 JSONL、原生事件、Scene 版本、资源依赖和数据集 manifest 交给原生 Jobs，返回输出目录引用。
- `录制详情／Recording details` 显示 recordingId、status、stopReason、最后帧 generation／step。
- `缺件 N 项／N missing`：悬停看缺失 uri 与原因，最多列前 20 条，但计数是总数。

**结束状态不要误读：**

- `已完成／Completed`：达到时长目标。
- `已停止／Stopped`：用户主动停止。
- `提前结束／Ended early`：墙钟安全时限、帧数上限或实际时长短于目标，会给出原因。
- `导出已开始` 不等于导出成功；以实际输出目录和 manifest 为准。

**失败处理：**

| 现象 | 处理 |
| --- | --- |
| `这台机器人还没有可用机位` | 先在 Camera 添加并保存真实挂载机位 |
| `该机位暂不可用：CAMERA_NOT_READ_BACK` | 物理世界还没读回该挂载机位；在 Camera 确认后重新同步 |
| `该机位暂不可用：CAMERA_UNAVAILABLE` | 引擎报告不可用；打开 Camera 看原因 |
| 开始按钮禁用 | 检查来源、通道、时长 `0.1–300`、宽高 `16–4096` |
| 录制中途结束 | 看 `stopReason` 与缺件；不要把 `completed` 当任务成功 |

---

## 12. 保存、导出与结果核验

### 12.1 保存工程

Scene → `打开与保存工程／Open & save project`：

- `工程文件路径／Project file path`
- `保存工程／Save project`：`portable:true`，复制原件和依赖闭包，保存完整快照。
- 移动工程时保留整个目录，不要只拷 `scene.json`。

### 12.2 场景版本

`场景版本／Scene versions` 显示 `rev N · 实体数`，可恢复历史版本。恢复前确认当前修订，避免覆盖别人刚提交的改动。

### 12.3 结果核验清单

一次相机闭环至少核对：

- **版本**：`lyapunov --version` 显示 0.2.0-alpha.1；安装回执 `.install/release.tsv`。
- **场景**：Scene `rev`、实体数、相机节点存在；挂载机位的 `mount.bodyName` 是真实 body。
- **世界**：实际引擎、world id、`appliedSceneRevision` 与当前 Scene `rev` 一致、`generation`、`step`、`simTime`。
- **相机**：`camera_list` 里该机位 `available`、`parentBodyName`、`poseSource`；K 的 `fx/fy/cx/cy` 和分辨率。
- **采集**：`captureId`、`cameraName`、`frameId`、`stepIndex`、`generation`、`sceneRevision` 是同一帧。
- **深度语义**：相机 Depth 是轴向 Z（米）；LiDAR range 是沿射线欧氏（米）；两者不能互换。
- **标注**：像素、世界点、深度和 `annotationPath` 对得上；无效深度没有编造三维点。
- **数据集**：`outputDir` 存在，manifest 引用实际采集。
- **录制**：`recordingId`、`status`、`stopReason`、`elapsedS`、帧数、通道统计、缺件数。
- **导出**：输出目录真实存在，文件非空，manifest 能读回。

### 12.4 输出路径

界面会在以下位置显示真实路径：

- 多视角数据集：`训练数据已导出：<outputDir>`。
- 采集：`captureId`、`capturePath` 所在会话的 capture 目录。
- 录制：`<recordingRoot>/sessions/<会话键>/`。
- 导出：原生 Jobs 返回的输出目录引用。

默认发行数据根下，按会话分命名空间：

```text
<运行根>/scene/captures/sessions/<会话键>/
<运行根>/scene/recordings/sessions/<会话键>/
```

其中 `<运行根>` 在默认发行版下位于产品数据目录的 `runtime/` 内；游客与登录账号按身份目录隔离。**以界面回执中的路径为准**，不要凭这条示例去猜另一个账号的路径。

---

## 13. 从空项目开始的完整实例：Franka 工位相机

下面这条路线从空项目开始，只用手动工作台也能完成；不需要游客配置模型。预期读数是“应该看到什么”，不是已由本机端到端实测签署的结果。

### 步骤 1：新建物理场景

- 操作：左侧新建会话 → `Scene／场景` → `创建物理工作区／Create physics workspace`。
- 应看到：Scene 树有 `无限地面`，画布有地面和网格，`rev` 很小。
- 失败：如果只有空场景，重新创建物理场景，不要在空场景里先放机器人。

### 步骤 2：启动 MuJoCo

- 操作：`Physics／物理` → 确认引擎 `mujoco` → `启动物理／Start physics`。
- 应看到：状态进入 ready／paused／running；`读取详情` 有真实引擎、world id、重力、地面来源。
- 失败：按钮禁用或 provider 不可用，按第 5.3 节处理。

### 步骤 3：加入 Franka Panda

- 操作：`Robots／机器人` → `机器人库／Library` → 搜索 `franka_panda` → `加入场景／Add to scene` → 画布点选落点 → `放置物体／Place object`。
- 应看到：Scene 树出现机器人实例，画布显示真实几何和材质。
- 失败：`Model not bundled` 或资源缺失，按第 4.2 节处理。

### 步骤 4：同步世界

- 操作：如果放置后 Scene `rev` 变了，回 `Physics` 点 `应用场景修改／Apply scene changes`。
- 应看到：`已应用场景 rev` 与当前 `rev` 一致。
- 失败：不一致时不要急着加相机；先同步。

### 步骤 5：进 Camera 添加机位

- 操作：`Camera／相机` → 选中 Franka 实例 → `给这个机器人添加相机／Add camera to this robot`。
- 应看到：`新建相机` 表单，`机器人` 显示 Franka，`挂载位置` 可下拉。
- 失败：`物理世界同步后读取真实连杆`，回第 5 节重新同步。

### 步骤 6：绑定腕部或末端连杆

- 操作：`挂载位置` 选 `手腕／wrist` 或 `末端工具／End tool` 对应的真实 body。
- 应看到：推荐按钮高亮，摘要 `挂载／Mount` 显示真实 body 名。
- 失败：列表为空时点 `读取真实连杆（需物理）`。

### 步骤 7：用当前画面定机位

- 操作：点 `使用当前画面／Use current view`；需要微调时展开 `局部姿态` 输入 XYZ。
- 应看到：`局部位置／Local pose` 显示三位小数米值；摘要 `镜头／Lens` 显示 640×480。
- 失败：`没有可用的当前画面采样` 时，先让 Viewer 显示当前 Scene 的真实 frame。

### 步骤 8：保存持久机位

- 操作：点 `保存相机／Save camera`。
- 应看到：返回机位详情；Scene 树出现相机节点；机位列表显示 `挂载／Mount <body>`。
- 失败：按 7.5 的提示处理，不要反复点保存。

### 步骤 9：进入相机预览

- 操作：点 `预览／Preview` 或 `进入并跟随相机视角／Enter and follow camera`。
- 应看到：画面来自机位真实位姿和 K；标题/摘要显示该机位；`返回主视图／Return to main view` 可退出。
- 失败：`此相机暂不可用` 时看原因；没有 world 同步就先同步。

### 步骤 10：采集 RGB-D

- 操作：`Capture／拍摄` → `RGB-D 采集与多视角` → `原生相机名` 填该机位名 → 宽高保持 320×240 → `采集 RGB-D 并读取标定`。
- 应看到：RGB 图、深度 NPY 下载、`pinhole · 320×240 · fx · fy`。
- 失败：自由相机无稳定标定；必须填真实命名相机。

### 步骤 11：多相机同帧采集

- 操作：`读取命名相机位姿与视场` → 勾选可用相机 → `同一物理步采集全部所选相机`。
- 应看到：`同帧 N 台相机 · 320×240 · step ...`；每台相机一行 K 和深度链接。
- 失败：不可用相机不能勾选；先修机位。

### 步骤 12：点击像素标注

- 操作：在多视角 RGB 图上点箱子或机器人上的有效像素。
- 应看到：`世界点 [x, y, z] m`、`深度 ... m`、`标注已保存：<path>`。
- 失败：点到背景／无效深度会阻断；换有效像素。

### 步骤 13：三通道比较

- 操作：回 `Camera` 详情 → `比较通道／Compare channels` → `扫描 LiDAR／Scan LiDAR`。
- 应看到：RGB、相机 Z 深度、LiDAR range 三格；`同帧` 或 `非同帧` 判定；下载链接。
- 失败：非同帧时看 step／Δt；不要把它当同帧数据训练。

### 步骤 14：录制

- 操作：`Recording／录制` → 选该机位 → 勾选 RGB、Depth → 时长 `5` 秒 → `开始录制`。
- 应看到：录制中卡片、帧数增长、累计仿真秒；到 5 秒或手动停止后结束。
- 失败：来源不可用、world 关闭、通道不支持时按第 11.3 节处理。

### 步骤 15：回放

- 操作：`观看回放／Watch replay` → `播放录制`。
- 应看到：真实录制帧回放、时间线、`帧来源` 的 scene/world/generation/rev/step。
- 失败：回放只读；回放期间不能采集，先 `返回实时视图`。

### 步骤 16：导出

- 操作：`导出／Export`；Capture 里如有多视角采集，点 `导出当前多视角训练数据集`。
- 应看到：`导出已开始` 或 `训练数据已导出：<outputDir>`，随后在 Job／产物中看到真实文件。
- 失败：不要以“导出已开始”当作成功；检查输出目录、manifest 和文件字节数。

### 步骤 17：核验结果

- 操作：按第 12.3 节逐项核对版本、Scene rev、world 身份、相机可用性、K、captureId、标注路径、录制状态和导出目录。
- 应看到：同一帧的 `captureId/frameId/stepIndex/generation` 一致；深度单位是米；LiDAR 与相机 Depth 语义分开；录制 `elapsedS` 与目标一致。
- 失败：任何一项不一致都保留回执并报告，不要用截图或进程存在替代。

---

## 14. 故障排查

### 14.1 打不开、不显示、白屏

1. 终端启动看 Host／Provider 输出：`"$HOME/.local/bin/lyapunov"`。
2. 运行 `"$HOME/.local/bin/lyapunov" --version` 与 `doctor mujoco`。
3. 检查图形会话类型（X11／Wayland）、GPU／renderer、桌面共享库。
4. 查看 `<版本目录>/.install/physics-check.log`、`.install/provider.log`、用户数据根的 `desktop-incidents.jsonl`。
5. 记录窗口是否 mapped、实际 screen／截图、日志时间点；不要以进程存活、HTTP 可达或退出码 0 判成功。
6. 不要添加 `--no-sandbox`；不要把宿主桌面重启当作修复步骤。

### 14.2 资源／SDK 缺失

- `PROVIDER_UNAVAILABLE`：核对引擎偏好、托管 SDK、外部 Python 路径。
- `install-provider mujoco` 只准备托管 MuJoCo；Isaac 需另行安装并接受许可。
- 缺 mesh／texture／include 时保留源目录闭包，不要伪造解析成功。

### 14.3 相机无图

| 现象 | 检查 |
| --- | --- |
| 按钮禁用 | world 是否同版本、是否 ready、Scene 是否可编辑 |
| `Camera unavailable` | 引擎明确拒绝；看 `reason` |
| `Mount saved; awaiting physical world synchronization` | 重新同步 world，读回真实连杆 |
| `Camera is not read back by the engine yet` | 该原生相机未读回，不能录制 |
| 自由相机没有标定 | 填真实命名相机名；自由相机通常没有稳定 K |
| RGB 有但 Depth 无 | 该引擎／该次采集没有深度通道；不要用 RGB 冒充 Depth |

### 14.4 引擎未连接

- 右侧 `Engine` 显示的是运行引擎和保存偏好；切换只在下次启动生效。
- Physics 面板检查 `下一世界／Next world`、实际 world、`已应用场景 rev`。
- 服务端未装配 provider 时，界面会明确提示；不要把它写成相机故障。

### 14.5 游客没有 Agent

游客没有默认模型。到模型设置配置自己的 provider；只做本文的手动场景、相机和录制时不需要 Agent。

### 14.6 LiDAR 与深度不一致

- 确认比较面板显示 `同帧`；非同帧看 Δstep／Δt。
- 相机 Depth 是轴向 Z；LiDAR range 是沿射线欧氏距离。
- LiDAR 无返回有独立颜色和 `valid`／`no-return` 统计；不要把无返回当 0 米。

---

## 15. 版本与能力边界

- 本版是 **0.2.0-alpha.1 预发布版**，不是 stable。官网、安装器、固定版本清单和公开 README 可以直接指向本版；GitHub Release 保持 prerelease。
- GitHub 平台不允许把 prerelease 同时设为 “latest”，因此 GitHub 的 latest 字段不会自动指向本版；可控下载入口使用固定 tag／固定版本清单，不移动标签，也不把 alpha 改成 stable。
- macOS 本版没有原生包；Windows 只有 WSL2 + WSLg 评估路线，尚未完成实机验收。不要声称本版 Mac／Windows 原生可下载。
- Isaac Sim 需要有效 SDK、许可和 RTX；Newton 当前是较窄的可选切片。相机能力按实际引擎回执判断，不用“接口存在”代替采集成功。
- 游客不连接产品账户／计费；需要官网账号服务或中央 Credits 时必须登录。

---

## 附录 A：源码核对位置（审计用）

| 主题 | 源码位置 |
| --- | --- |
| 工具栏 Camera／Capture／Recording | `packages/lyapunov-shell/src/tool-rail.tsx` 约 30–45 行 |
| Camera 面板 scope=mounted | `packages/lyapunov-shell/src/workbench.tsx` 约 2850 行 |
| Capture 设置、世界相机、RGB-D 挂载 | `packages/lyapunov-shell/src/workbench.tsx` 约 2820–2850 行 |
| Recording 面板挂载 | `packages/lyapunov-shell/src/workbench.tsx` 约 2848 行 |
| 相机默认值／镜头／坐标 | `packages/lyapunov-shell/src/workbench-camera.ts` 约 34–70、90–120 行 |
| 当前画面采样与挂载 | `packages/lyapunov-shell/src/camera-authoring.ts` 约 61–90 行 |
| 持久安装／baseline | `packages/lyapunov-shell/src/camera-installation.ts` 约 25–70 行 |
| Camera 面板按钮与表单 | `packages/lyapunov-shell/src/scene-camera-panel.tsx` 约 88–431 行 |
| Capture 面板 | `packages/lyapunov-shell/src/capture-panel.tsx` 约 96–194 行 |
| Recording 面板 | `packages/lyapunov-shell/src/recording-panel.tsx` 约 102–243 行 |
| 录制来源与通道 | `packages/lyapunov-shell/src/recording-source.ts` 约 9–16、75–150 行 |
| LiDAR 比较 | `packages/lyapunov-shell/src/lidar-scan-panel.tsx` 约 199–350 行 |
| Scene 模板按钮 | `packages/lyapunov-shell/src/scene-creation.tsx` 约 30–35 行 |
| 安装合同 | `docs/install.md` 约 20–70、226–295 行 |

## 附录 B：本版发布标识

| 项 | 值 |
| --- | --- |
| 版本 | `0.2.0-alpha.1` |
| 发布批次／releaseId | `rcui-v11-20261022T151637Z-agraph5` |
| 原打包源码 | `6d07f53e23030cbda4e1ab38a8b305e285349359` |
| 平台 | Linux x64 |
| 最低 glibc | `2.39` |
| 主包字节数 | `745,352,161` |
| 主包 SHA-256 | `bb4d5981b09fc985ae2cb1ca9ea65bd13fd65cb7c8975123593803c98419049d` |
| 发布性质 | prerelease，不是 stable |
| 官网默认清单 | `/lyapunov/releases/latest/linux-x64.json`（切换后指向本批次） |

## 附录 C：审计边界（2026-10-23）

- 界面名称、按钮、默认值和坐标口径按 0.2.0-alpha.1 源码与产品文档核对，源码位置见附录 A。
- 本手册未重新完成虚拟机端到端实测；Camera／Capture／Recording 的相机、RGB-D 与录制步骤未在本轮实测。第 1.5 节只记录 VM24 默认安装在 policy-cpu 阶段失败这一实际事实，不把旧版仍可启动当作新版安装成功。
- 19/19 发布门与 20/20 桌面验收属于原候选包记录，不是本轮新实测；GitHub Release 保持 prerelease，标签不移动。

更多信息：[官网 Lyapunov 页面](https://vorynel.com/lyapunov/) · [0.2.0 Alpha 1 更新说明](https://vorynel.com/lyapunov/updates/0.2.0-alpha.1.html) · [GitHub Release](https://github.com/ManfredCh/Lyapunov/releases/tag/v0.2.0-alpha.1) · [英文发布说明](https://github.com/ManfredCh/Lyapunov/blob/main/docs/releases/0.2.0-alpha.1.md)
