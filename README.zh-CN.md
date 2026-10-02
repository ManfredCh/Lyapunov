# Lyapunov

[English](README.md) | [简体中文](README.zh-CN.md)

**Linux x64 Alpha** · **Lyapunov Modified MIT**

| 出版信息 | 内容 |
| --- | --- |
| 应用版本 | 0.1.0 · A08 Alpha |
| 文档版本日期 | 2026-10-02 |
| 作者团队 | Lyapunov contributors |
| 版权 | © 2026 Lyapunov contributors |
| 项目许可 | [Lyapunov Modified MIT License](LICENSE) · [保留的版权与许可声明](NOTICE) |
| 源码仓库 | [ManfredCh/Lyapunov](https://github.com/ManfredCh/Lyapunov) |
| 图片与概念来源 | 项目贡献者撰写的说明和版本标记；本 README 不含概念图素材。 |

Lyapunov 将 Agent 对话、代码、文件、三维视口和物理仿真放在同一桌面工作台。你可以创建三维场景、准备机器人、执行受控仿真，并采集相机数据。

**发行通道：** Linux x64 Alpha。版本标识、下载内容和系统要求以[官网安装页](https://vorynel.com/lyapunov/)及其版本清单为准。本仓库包含产品源码；[发布说明](docs/releases/2026-10-linux-a08.md)记录本 Alpha 的变化与已知范围。

[安装](#在-linux-上安装) · [首次运行](#首次运行) · [机器人与相机](#机器人与相机) · [完整安装手册](https://vorynel.com/lyapunov/guide.html) · [发布说明](docs/releases/2026-10-linux-a08.md)

## 在 Linux 上安装

在图形桌面会话的普通终端中运行：

```sh
curl -fsSL https://vorynel.com/lyapunov/install.sh | sh
"$HOME/.local/bin/lyapunov"
```

默认安装准备 **MuJoCo 及其 Python 运行环境**，验证原生物理，并创建当前用户的启动器和桌面入口。**Node.js、Electron 和固定版本的 DSH 随主归档提供**；默认安装将 MuJoCo／Python 下载到该版本目录内的专用环境。默认安装器与发行启动器不依赖 PATH 中的 Node、DSH、Python，也不依赖开发者的源码检出目录。用户会话与凭据使用产品的数据目录，升级时继续保留。消费者不需要预装系统 Node.js、DSH、Python、pip、Conda、Bun，也不需要模型 Key 才能安装。

安装器要求 `sh`、`curl`、`tar`、`sha256sum`，以及 `mktemp`、`getconf` 等常规 Linux 工具。当前打包目标为 **使用 glibc 的 Linux x86_64**，需要图形桌面、Electron 所需共享库和可用的渲染后端。版本清单分别声明主包和 MuJoCo 伴随包的最低 glibc。CPU 可以执行物理仿真；相机渲染和较大三维场景仍需要相应图形能力与内存。Intel、AMD、NVIDIA 配置分别验收，本 Alpha 没有覆盖所有 GPU 或 Linux 发行版。本次发行范围不包括 macOS／Windows，也不承诺离线安装。

安装器将不同版本保存在 `~/.local/share/lyapunov/versions/`，检查通过后才切换 `current` 链接，并保留旧版本及用户数据。如果 `~/.local/bin` 已在 PATH 中，可以用 `lyapunov` 启动；否则使用上面的用户启动器路径。下载大小和实际发布批次标识见[官网安装页](https://vorynel.com/lyapunov/)。

希望先阅读脚本或选择已发布版本时：

```sh
curl -fsSL https://vorynel.com/lyapunov/install.sh -o lyapunov-install.sh
less lyapunov-install.sh
sh lyapunov-install.sh --help
sh lyapunov-install.sh
```

`--version RELEASE_ID` 选择一个实际发布批次。`--prefix /absolute/install/path` 和 `--bin-dir /absolute/bin/path` 用于指定安装位置。安装前缀支持空格；默认 MuJoCo 环境不接受前缀中的单引号（`'`）。手工归档、校验值、升级、回滚和卸载见[完整安装手册](https://vorynel.com/lyapunov/guide.html)。

## 首次运行

1. 打开 Lyapunov，在欢迎页选择语言与主题。
2. 点击 **Sign in／登录**，在浏览器完成官网授权后返回同一个应用窗口；账号验证成功后进入工作台。登录用户的模型调用使用 **Peiri** 和该账号的中央 Credits。
3. 希望在本地使用时，点击 **Try as guest／游客体验**。Guest 打开独立本地工作台，不连接产品服务器，包括产品账号和计费后端。文件、场景编辑、视口及已安装本地工具可用。游客初始**没有默认模型**；需要 Agent 时在模型设置显式配置自己的 provider。游客不使用 Peiri、产品计费或中央 Credits。
4. 创建或打开工程，从自己的文件或本地资源库添加资产。游客工程与登录工程分开保存；需要迁移时，先导出游客工程，再登录并显式导入。

账号页与设置显示实际连接、模型和引擎状态。Provider 凭据由使用者自行配置；应用不提供外部服务的凭据，外部服务保留自己的使用与计费条件。

## 在同一个工作台完成任务

| 工作内容 | 工作台工具 |
| --- | --- |
| 创建场景 | 导入支持的 GLB／glTF、Gaussian Splat、MJCF、URDF；选择、变换、保存并重新打开场景实体。 |
| 编辑代码 | 浏览与编辑文件、搜索、查看 Git 变更，并在 Agent 旁使用终端。 |
| 准备仿真 | 初始化前核对引擎、机器人控制、模型依赖、放置和碰撞几何。 |
| 控制机器人 | 按当前能力执行关节、夹爪、车辆、升降、步态或 body-wrench 控制；停止执行并查看真实世界反馈。 |
| 观察与采集 | 在引擎支持范围内使用场景相机、命名引擎相机、RGB-D、标定、标注、录制和数据集导出。 |
| 添加外部工具 | 按需配置 Blender、可选引擎、policy 运行环境、重建或生成工具；它们的软件、模型、许可及服务访问要求分别保留。 |

来源发现从官方项目和注册表根开始。服务提供的来源地址与 metadata 为 Agent 提供上下文；浏览器访问、网页获取和终端操作由客户端执行。客户端取得并检查具体文件后，来源链接才成为可用的本地资源。来源入口不自动代表所有模型或 policy 都能运行。

## 机器人与相机

各机器人族遵循共同流程：**准备 → 初始化 → 就绪 → 显式受控执行**。选择机器人与引擎，检查可用控制和依赖，放置机器人与环境，初始化物理后再执行有界动作并观察结果。模型可以先可见、物理世界尚未就绪。人形、四足、机械臂、车辆、灵巧手和无人机有不同控制映射；导入 G1 不等于自动起身或所有本体行为已经成立。

在暂停状态下准备世界，再显式开始动作。预训练 policy 需要准备并与当前机器人匹配后才显式执行。几何步态命令与起身是不同能力，也不证明机器人已经稳定行走。

可视资产与碰撞几何分别承担显示和物理接触的作用。需要真实接触前，应添加或准备符合场景的碰撞几何。重建房间使用与房间配准的几何，避免把整个房间作为实心盒子。应用场景修改后，核对实际世界响应。

相机面板中的 **Enter camera／进入相机视角** 或 **Enter and follow camera／进入并跟随相机视角** 可用于场景相机。**Saved views／已保存视角** 进入已有命名视角。**Return to main view／返回主视图** 恢复主机位，`Esc` 也可离开锁定相机视角。Viewer 视角与引擎传感器采集有各自的控制。

自由导航时，选择第一人称漫游并点击 Viewer 画布：`W`／`A`／`S`／`D` 水平移动，`Q`／`E` 升降，`Shift` 加速，右键环顾。画布失焦后移动停止，`Esc` 返回环绕模式。这些键操作相机；机器人执行使用机器人控制面或显式 Agent 动作。

各引擎的支持范围和已有证据见[能力总表](docs/CAPABILITY_MATRIX.md)与[相机说明](docs/SCENE_CAMERA_PIPELINE.md)。

## 物理引擎与可选运行环境

标准安装准备 MuJoCo。设置中显示实际引擎选择：显式选择优先；自动模式在 Isaac 的 SDK、许可和所需加速器可用时可以选择 Isaac，否则选择 MuJoCo。偏好变化在下次启动工作台生效。

Isaac Sim、Newton、policy 环境和官方 benchmark 套件分别下载：

```sh
"$HOME/.local/bin/lyapunov" doctor mujoco
"$HOME/.local/bin/lyapunov" install-provider newton
"$HOME/.local/bin/lyapunov" install-provider policy-cpu
```

安装 Isaac 前阅读 [NVIDIA Omniverse 许可](https://docs.omniverse.nvidia.com/platform/latest/common/NVIDIA_Omniverse_License_Agreement.html)，同意后显式运行：

```sh
"$HOME/.local/bin/lyapunov" install-provider isaac --accept-omniverse-eula
```

SDK 已安装、世界就绪与机器人任务成功分别确认。Newton 当前提供较小的世界和观测能力范围，并未具备 MuJoCo／Isaac 的全部动作、接触和相机接口。可选模型与 policy 权重在使用者选择后才获取。Hugging Face Hub 使用 `https://hf-mirror.com`；镜像缺文件、revision、权限或校验失败时会明确阻断。

## 升级与故障检查

退出 Lyapunov 后重跑同一个安装器升级。每个实际发布批次有独立目录，`previous` 记录前一个 `current`。用户数据保存在安装目录外，默认使用 Electron 的平台用户数据目录，或显式配置的 `LYAPUNOV_DESKTOP_DATA_DIR`。更换版本前，在关闭应用的状态下导出重要工程或复制实际数据根。切换应用版本不恢复旧数据布局；回滚与卸载步骤见[完整安装手册](https://vorynel.com/lyapunov/guide.html)。

先查看真实诊断：

```sh
"$HOME/.local/bin/lyapunov" --version
"$HOME/.local/bin/lyapunov" doctor mujoco
```

安装在桌面／沙盒检查处停止时，会打印实际版本路径和处理方式。已校验文件保留，该版本不会被激活。输出要求时才运行 `sudo /the/reported/version/path/lyapunov setup-sandbox`，然后重跑安装器。`CONTEXT_ONLY` 表示当前终端的安全上下文未能确认桌面就绪，应在图形桌面的普通终端复查。`PROVIDER_UNAVAILABLE` 会点名缺失或不兼容的 SDK；核对选定引擎和已保存的外部 Python 路径。日志位置与恢复步骤见[安装手册](https://vorynel.com/lyapunov/guide.html)。

## 从源码开发与贡献

源码仓库使用固定 DSH 版本构建产品。开发需要 Git、Node.js 24+、Bun 1.3.13 和 pnpm 11.7.0；上面的消费端发行安装使用随包运行时。

```sh
git clone https://github.com/ManfredCh/Lyapunov.git
cd Lyapunov
export HF_ENDPOINT=https://hf-mirror.com
node script/bootstrap.mjs
```

开发账号、模型配置、源码启动、构建与检查见[开发说明](development/README.md)和[开发标准](docs/DEVELOPMENT_STANDARDS.md)。[发布说明](docs/releases/2026-10-linux-a08.md)记录本 Alpha 的功能范围。账号和部署服务在独立仓库维护。

## 许可与版权

Lyapunov 项目主许可为 [Lyapunov Modified MIT License](LICENSE)，版权 **© 2026 Lyapunov contributors**。自定义许可保留 MIT 通用授权：使用本软件或衍生作品的商业产品／服务，月活达到 **10,000**，或月营业收入达到 **人民币 1,000,000 元（或其他货币等值）**，任一条件满足须显著署名“Lyapunov”。没有 UI 时，在该产品或服务的官方文档／网站署名。门槛针对该产品或服务，署名不要求支付许可费。

原 OpenCode MIT 版权与授权通知完整保留在 [NOTICE](NOTICE)。各独立包、随附 DSH／Node／MuJoCo 组件、机器人资产、模型权重和外部服务保留自己的许可。
