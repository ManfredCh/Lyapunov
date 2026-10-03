# Lyapunov

[English](README.md) | [简体中文](README.zh-CN.md)

<p align="center">
  <img src="packages/desktop/icons/lyapunov.png" width="72" height="72" alt="Lyapunov 应用图标" />
</p>

<p align="center">
  <img src="docs/assets/badge-alpha.svg" alt="Alpha" />
  <img src="docs/assets/badge-linux-x64.svg" alt="Linux x64" />
  <a href="LICENSE"><img src="docs/assets/badge-lyapunov-license.svg" alt="许可证：Lyapunov Modified MIT" /></a>
</p>

<p align="center">
  纸上得来终觉浅，绝知此事要躬行。<br />
  ——陆游《冬夜读书示子聿》
</p>

**Linux x64 · 0.1.0α** · **Lyapunov Modified MIT**

| 出版信息 | 内容 |
| --- | --- |
| 技术版本 / releaseId | `0.1.0-alpha.1` |
| 文档版本日期 | 2026-10-03 |
| 作者团队 | Mingjun Cheng; Zongjian Ding; Yudong Gao; Yi Yang; Lidong Chen; Jiale Liu; Xinling Yu |
| 出品方 | 杭州奇异宇宙人工智能有限公司 |
| 版权 | © 2026 Vorynel Co., Ltd. |
| 项目许可 | [Lyapunov Modified MIT License](LICENSE) · [保留的版权与许可声明](NOTICE) |
| 源码仓库 | [ManfredCh/Lyapunov](https://github.com/ManfredCh/Lyapunov) |

**杭州奇异宇宙人工智能有限公司出品。** Lyapunov 是 **LLM优先、3D原生的机器人与Agent桌面框架**，面向机器人开发者、仿真/研究团队与三维创作者，在同一工作台对话、建场景、准备机器人、执行受控仿真并采集相机数据。

Lyapunov 基于 [DSH](https://github.com/deepseek-ai/deepseek-harness) 的“万物皆插件”架构，采用 Cordis 的组合机制整合工具与能力。感谢 DSH 与 Cordis 的作者和贡献者；Cordis 的设计见论文 [A Programming Paradigm for Spatiotemporal Composability](https://arxiv.org/abs/2608.25512)。

**发行通道：** Linux x64 Alpha。版本标识、下载内容和系统要求以[官网安装页](https://vorynel.com/lyapunov/)及其版本清单为准。本仓库包含产品源码；[发布说明](docs/releases/0.1.0-alpha.1.md)记录本 Alpha 的变化与已知范围。

[安装](#在-linux-上安装) · [首次运行](#首次运行) · [机器人与相机](#机器人与相机) · [完整安装手册](https://vorynel.com/lyapunov/guide.html) · [发布说明](docs/releases/0.1.0-alpha.1.md)

<!-- 工作台截图待替换：获得正确图片后在此位置补入。 -->

**推荐工作流：** 让Agent使用原生产品工具，或使用工作台控件；本Alpha暂不建议用CUA自动点击替代场景、机器人与仿真工具。

## 在 Linux 上安装

在图形桌面会话的普通终端中运行：

```sh
curl -fsSL https://vorynel.com/lyapunov/install.sh | sh
```

安装成功并报告就绪后，由使用者单独启动 Lyapunov：

```sh
"$HOME/.local/bin/lyapunov"
```

默认安装准备 **MuJoCo 及其 Python 运行环境**，验证原生物理，并创建当前用户的启动器和桌面入口。其他物理引擎可按需选择安装 **Isaac Sim 或 Newton**，它们不会随默认安装自动准备，见[物理引擎与可选运行环境](#物理引擎与可选运行环境)。**Node.js、Electron 和固定版本的 DSH 随主归档提供**；默认安装将 MuJoCo／Python 下载到该版本目录内的专用环境。默认安装器与发行启动器不依赖 PATH 中的 Node、DSH、Python，也不依赖开发者的源码检出目录。用户会话与凭据使用产品的数据目录，升级时继续保留。消费者不需要预装系统 Node.js、DSH、Python、pip、Conda、Bun，也不需要模型 Key 才能安装。

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
2. 点击 **Sign in／登录**，在浏览器完成官网授权后返回同一个应用窗口；账号验证成功后进入工作台。使用官网模型服务需先注册账号并充值 Credits；登录用户的模型调用使用 **Peiri** 和该账号的中央 Credits。
3. 希望在本地使用时，点击 **Try as guest／游客体验**。Guest 打开独立本地工作台，不连接产品服务器，包括产品账号和计费后端。文件、场景编辑、视口及已安装本地工具可用。游客初始**没有默认模型**；需要 Agent 时在模型设置显式配置自己的 provider。游客不使用 Peiri、产品计费或中央 Credits。
4. 创建或打开工程，从自己的文件或本地资源库添加资产。游客工程与登录工程分开保存；需要迁移时，先导出游客工程，再登录并显式导入。

账号页与设置显示实际连接、模型和引擎状态。Provider 凭据由使用者自行配置；应用不提供外部服务的凭据，外部服务保留自己的使用与计费条件。

## 在同一个工作台完成任务

| 工作内容 | 工作台工具 |
| --- | --- |
| 创建场景 | 导入GLB、支持的Gaussian表示与原生机器人文档，其他输入按下表走转换/预览；选择、变换、保存并重开Scene实体。 |
| 编辑代码 | 浏览与编辑文件、搜索、查看 Git 变更，并在 Agent 旁使用终端。 |
| 准备仿真 | 初始化前核对引擎、机器人控制、模型依赖、放置和碰撞几何。 |
| 控制机器人 | 按当前能力执行关节、夹爪、车辆、升降、步态或 body-wrench 控制；停止执行并查看真实世界反馈。 |
| 观察与采集 | 在引擎支持范围内使用场景相机、命名引擎相机、RGB-D、标定、标注、录制和数据集导出。 |
| 添加外部工具 | 按需配置 Blender、可选引擎、policy 运行环境、重建或生成工具；它们的软件、模型、许可及服务访问要求分别保留。 |

## 机器人与相机

各机器人族遵循共同流程：**准备 → 初始化 → 就绪 → 显式受控执行**。选择机器人与引擎，检查可用控制和依赖，放置机器人与环境，初始化物理后再执行有界动作并观察结果。模型可以先可见、物理世界尚未就绪。人形、四足、机械臂、车辆、灵巧手和无人机有不同控制映射；导入 G1 不等于自动起身或所有本体行为已经成立。

在暂停状态下准备世界，再显式开始动作。预训练 policy 需要准备并与当前机器人匹配后才显式执行。几何步态命令与起身是不同能力，也不证明机器人已经稳定行走。

可视资产与碰撞几何分别承担显示和物理接触的作用。需要真实接触前，应添加或准备符合场景的碰撞几何。重建房间使用与房间配准的几何，避免把整个房间作为实心盒子。应用场景修改后，核对实际世界响应。

相机面板中的 **Enter camera／进入相机视角** 或 **Enter and follow camera／进入并跟随相机视角** 可用于场景相机。**Saved views／已保存视角** 进入已有命名视角。**Return to main view／返回主视图** 恢复主机位，`Esc` 也可离开锁定相机视角。Viewer 视角与引擎传感器采集有各自的控制。

自由导航时，选择第一人称漫游并点击 Viewer 画布：`W`／`A`／`S`／`D` 水平移动，`Q`／`E` 升降，`Shift` 加速，右键环顾。画布失焦后移动停止，`Esc` 返回环绕模式。这些键操作相机；机器人执行使用机器人控制面或显式 Agent 动作。

各引擎的支持范围和已有证据见[能力总表](docs/CAPABILITY_MATRIX.md)与[相机说明](docs/SCENE_CAMERA_PIPELINE.md)。

## 环境与物体建模

### 环境方法

- **世界场景生成**：可以用一句话向 Agent 请求世界场景生成，使用世界模型建立 3DGS 环境，并配合准备与其配准的 GLB 碰撞几何。当前服务器算力有限，供给时段与生成量有限；后续将根据需求评估提升速度与容量。
- **几何与程序化脚本**：用Blender或参数化脚本建立尺寸明确的地面、墙、门洞与装配；保留可编辑源件和派生件。
- **已有环境与Gaussian表示**：检查比例、轴、方向和依赖；Gaussian负责视觉，真实接触需要另行配准的物理几何。
- **照片、多视角与图纸重建**：可选外部方法路线，依赖各自工具、数据与输出检查。本Alpha说明不签署外部服务连接或重建结果成功。
- **编辑与物理派生**：编辑进入Scene版本，为static/environment派生碰撞并应用到当前world；有限表面厚度和预算会影响窄孔与通道。

### 物体方法

使用Blender控制几何、材质并导出GLB，使用参数化脚本建立可重复的几何，或复用源资产。服务辅助建模是可选方法，先确认实际连接、许可和结果；不将某个生成模型或供应商列为默认建模依赖，也不以接口存在代签成功。

## 输入类型与处理入口

按入口选择输入，而不是只看后缀。视觉登记、预览、转换、原生引擎导入和兼容策略执行分别确认。

| 入口类别 | 输入 | 实际处理/边界 |
| --- | --- | --- |
| 直接场景可用 | .glb | scene_import登记mesh；完整外部buffer/texture闭包；视觉可见后另核碰撞/物理。 |
| 需获取组装为GLB | .gltf / glTF+bin/textures | 本地UI走scene_asset_acquire(path)，读取.bin/图片组装asset.glb后import/mount；workspace亦可预览；不是parseAsset直导。 |
| 直接机器人文档 | .xml / .mjcf | 必须是真实mujoco/robot根，解析include/mesh/texture闭包；导入后按实际引擎、关节、控制映射准备，不等于已运动。 |
| 直接机器人文档 | .urdf | 登记URDF及依赖；视觉/引擎消费与控制兼容分别核查，未知mesh不伪装原生支持。 |
| 直接场景泼溅入口 | .ply（高斯属性） | 按PLY头与f_dc_/scale_/rot_/opacity事实判断；视觉Gaussian splat不自动变碰撞。 |
| 按内容预览/显式转换或派生 | .ply（普通网格/XYZ） | workspace按头分流；parseAsset把PLY登记为splat且记录gaussianProperties，不能宣称所有PLY通用点云直接可用；XYZ碰撞仅显式解码/派生路径。 |
| 直接场景泼溅入口（解码有条件） | .spz / .splat / .sog / .rad / .ksplat | parseAsset登记splat；SPZ/SPLAT有内容校验，其他格式仍依对应解码器；物理几何需独立来源/绑定。 |
| 需Blender转换 | .obj / .mtl/贴图 | scene source登记依赖与纹理事实；转换GLB后挂场景。workspace独立OBJ预览不等于Scene物理兼容。 |
| 需Blender转换 | .fbx | 真实FBX头校验，保源文件/材质闭包，转换GLB；缺纹理如实报告。 |
| 原工程+Blender转换 | .blend | 原件source入库，外部纹理/linked-library须Blender检查；可编辑/导出GLB，不默认闭包完整。 |
| 原始source/转换；原生引擎有条件 | .usd / .usda / .usdc | parseAsset仅source；Blender可转换GLB预览/挂场景。Isaac原生USD路径另需对应SDK/SBL等实际依赖和组件，不把USD后缀当全引擎支持。 |
| 文件预览/Blender转换 | .usdz | workspace支持USDZ预览，二进制ZIP由宿主转换；不在parseAsset直接Scene扩展集合。 |
| 只文件预览/转换后再场景用 | .stl / .dae / .3mf / .vtk | workspace对象预览；STL还可作机器人文档mesh依赖，不能因此宣称所有上述独立文件Scene直导。 |
| 需3ds Max导出后再用 | .max | 明确MAX_CONVERSION_REQUIRED；从3ds Max导出带材质FBX或GLB，不能改后缀。 |
| 环境光照source | .hdr / .exr | 登记真实头/尺寸，应用到Viewer环境；不是机器人或普通碰撞体。 |
| 参考图/附件，不直接3D资产 | PNG/JPEG等图片 | 作为照片/图纸参考交给模型或drawing_inspect；从图中推断尺寸与背面须区别已知事实。 |
| 图纸检查/外部转换 | .dxf / .dwg / .pdf | DXF解析，DWG需显式转换器→DXF；矢量PDF读取路径/文本，扫描PDF导出图片；无比例尺不能称米制模型。 |
| 策略取件后需准备/匹配 | .pt / .pth / .jit / .torchscript / .onnx / .safetensors / bundle.json | 本地loader仅按真实文件/bundle闭包和已登记来源/adapter处理。未知文件只格式预检(graphVerified:false)，匹配joint/order/obs/rate与引擎后再显式执行；不宣称任意权重可运行。 |
| 工程打开/完整包导入导出 | scene.json / .scene-package.json / portable project directory | scene_open读scene.json；scene_package_import导入自包含测试项目；scene_save portable:true复制原件和闭包，保存完整快照，迁移完整目录；不声称任意ZIP都可作为工程打开。 |

## 机器人来源、兼容与有界控制

在支持范围内优先使用原生MJCF/URDF，保留include、mesh、纹理与actuator闭包；匹配轴、单位、关节顺序/限位、执行器映射、dt/控制频率、观测语义和实际引擎。下载、PREPARED、MATCHED是准备事实；就绪后显式执行用户要求的有界动作，再检查状态与停止确认。

多机器人可以共享同Scene/world，并提交有界batch动作。读取同world/generation下每个机器人的结果；共同时间或一个batch不证明任意异构协作或车队任务已完成。

## 相机、标注与可编辑反馈

**world固定相机**使用世界位姿；**body/parent挂载相机**使用局部安装位姿并跟随真实父体。显式“保存当前画面安装”保留当前相机安装，可“恢复安装基线”。“进入相机视角／进入并跟随相机视角”和“返回主视图”控制观察；保存Viewer视角不替代native calibration。

MuJoCo与Isaac有命名相机list/adjust路线；传感器采集需真实渲染后端，Isaac RGB-D需要实际RTX。Newton当前相机接口不支持。RGB-D检查相机名、分辨率、K、worldFromCamera、米制深度、captureId及frame/Scene/world来源。相机看得到环境不证明碰撞几何配准完成。

在实体/当前视图或已登记采集上添加标注，修改位置和文字，保存并重开检查。像素投到三维只用真实深度与标定。可将带标注观察作为参考交给Agent，明确的几何修改经原生Scene编辑与revision核对完成；标注编辑本身不自动改几何或物理。导出实际采集、标注和数据集及其引用。

## 四个入门工作流

下列内容是操作与验收方法，不代表最终包已逐项演示通过。自然语言请求需登录或在Guest显式配置自有provider；手动工作台功能仍可用。

| 工作流 | 输入 | 完成前检查 |
| --- | --- | --- |
| MuJoCo地面与箱子 | 静态地面、动态箱子、就绪托管SDK | 实际engine/world/revision、有界步进与真实位姿/contact。 |
| Panda关节/TCP | 原生模型及完整依赖 | 可控关节/限位/状态、停止确认与真实TCP；IK计划和执行分开。 |
| 相机与标注采集 | 同步Scene、支持的相机及renderer | 同帧RGB-D/K/深度身份、保存后可编辑标注与真实导出引用。 |
| 室内碰撞配准 | 室内视觉件及配准静态几何 | 墙正对照/空区负对照、voxel pitch/预算和场景净空。 |

输入、操作顺序、自然语言例子和输出检查见[完整入门教程](docs/QUICKSTART.zh-CN.md)（[English](docs/QUICKSTART.md)）。

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

## TODO

- [ ] 原生 macOS（Apple Silicon/x64）。
- [ ] 微信小程序／手机：已认证的远程任务、相机与停止控制。
- [ ] Genesis。
- [ ] VR/XR 输入与坐标。
- [ ] DSH 伴随升级（固定上游版本）。

## Windows 评估路线

Windows计划评估的是 **WSL2 + WSLg下的Linux包**，不是原生Windows exe。[微软GUI应用前置条件](https://learn.microsoft.com/en-us/windows/wsl/tutorials/gui-apps)要求Windows 10 build 19044+或Windows 11、WSL2/WSLg与适用GPU驱动。在管理员PowerShell中：

```powershell
wsl --install
wsl --update
```

完成发行版设置后，在Ubuntu/Linux终端使用：

```sh
curl -fsSL https://vorynel.com/lyapunov/install.sh | sh
```

安装成功并报告就绪后，由使用者单独启动 Lyapunov：

```sh
"$HOME/.local/bin/lyapunov"
```

安装和数据推荐放在Linux文件系统。本次未做Windows/WSLg与全GPU验收；按Linux包实际doctor和sandbox结果处理。

## 基于上游生态的产品整合

Lyapunov负责LLM/3D优先的产品工作台与场景、工具、仿真、观察流程整合。感谢 [DSH](https://github.com/deepseek-ai/deepseek-harness)与Cordis、[MuJoCo](https://github.com/google-deepmind/mujoco)、NVIDIA [Isaac Sim](https://developer.nvidia.com/isaac/sim)与[IsaacLab](https://github.com/isaac-sim/IsaacLab)、Three.js、Electron、Node.js、React、Blender，以及机器人厂商、官方模型库与贡献者。底层仿真、渲染和控制模型成果归各自作者与许可。

## 一起完善Lyapunov

欢迎在 [Discussions](https://github.com/ManfredCh/Lyapunov/discussions)讨论方向，在 [Issues](https://github.com/ManfredCh/Lyapunov/issues)报告可复现问题，通过 [Pull requests](https://github.com/ManfredCh/Lyapunov/pulls)贡献。附版本、最小操作和已去隐私的诊断/截图，不提交Key、会话或客户私有内容；具体流程见[贡献说明](CONTRIBUTING.md)。

## 从源码开发与贡献

源码仓库使用固定 DSH 版本构建产品。开发需要 Git、Node.js 24+、Bun 1.3.13 和 pnpm 11.7.0；上面的消费端发行安装使用随包运行时。

```sh
git clone https://github.com/ManfredCh/Lyapunov.git
cd Lyapunov
export HF_ENDPOINT=https://hf-mirror.com
node script/bootstrap.mjs
```

开发账号、模型配置、源码启动、构建与检查见[开发说明](development/README.md)和[开发标准](docs/DEVELOPMENT_STANDARDS.md)。[发布说明](docs/releases/0.1.0-alpha.1.md)记录本 Alpha 的功能范围。账号和部署服务在独立仓库维护。

## 许可与版权

Lyapunov 项目主许可为 [Lyapunov Modified MIT License](LICENSE)，版权 **© 2026 Vorynel Co., Ltd.**。自定义许可保留 MIT 通用授权：使用本软件或衍生作品的商业产品／服务，月活达到 **10,000**，或月营业收入达到 **人民币 1,000,000 元（或其他货币等值）**，任一条件满足须显著署名“Lyapunov”。没有 UI 时，在该产品或服务的官方文档／网站署名。门槛针对该产品或服务，署名不要求支付许可费。

原 OpenCode MIT 版权与授权通知完整保留在 [NOTICE](NOTICE)。各独立包、随附 DSH／Node／MuJoCo 组件、机器人资产、模型权重和外部服务保留自己的许可。
