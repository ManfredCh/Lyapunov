# Isaac 安装与选择

[English](isaac-setup.en.md)

Lyapunov 当前适配 Isaac Sim 6.0.1 / 6.0.1.0，Python 3.12。MuJoCo 随默认安装准备；Isaac 是可选安装，不要求为了普通场景重新下载完整 Isaac 图形工作站。

## 使用已有安装

在「设置 → 物理引擎」中打开 Isaac 的「发现本地安装」。检查范围包括本产品旧版本的 Isaac、常见独立安装目录和用户 Conda 环境；不会搜索整台电脑，也不会自动改选。

自己下载的安装可以输入以下任一入口，再点「检查此路径」：

- 官方 standalone 安装目录或其中的 `python.sh`。
- 已安装对应 Isaac SDK 的 Conda / venv 目录或其中的 `bin/python`。

检查通过后选择「使用此安装（下次启动）」，保存并重新启动工作台。检查版本与模块不会启动 Kit，也不会修改、复制或更新外置 SDK。版本或 Python 不兼容时保留当前选择，可以换一条路径继续检查。

## 由产品安装

没有已有安装时，在同页阅读并确认 NVIDIA 许可，再选择安装。产品在自己的独立环境安装固定版本及实际需要的官方组件与扩展缓存，不修改系统 Python。

只有本次安装检查成功后，才保存该 SDK 路径供后续产品版本读取。半安装、下载失败或保存失败会明确报告；已有的显式环境变量覆盖或已保存安装不被覆盖。

## 实际使用哪一套

选择顺序是显式 `LYAPUNOV_ISAAC_PYTHON`、已保存的本地安装、本版本产品托管默认路径。设置页显示下次启动的路径与来源；保存 SDK 不改变正在运行的物理世界。

更新 Lyapunov 不会复制整套 SDK。正在使用旧版本 SDK 时，请保留那个 SDK 目录；移动或删除后需重新检查并登记有效入口。失效的显式选择不会悄悄换成另一套环境。

## SDK 检查与物理启动

「SDK 已发现」表示模块、版本与解释器检查通过；物理世界是否可用由实际启动、观察与引擎状态确认。RTX 相机还需要单独验证 GPU 与渲染。

Isaac 完整运行环境的官方支持列表为 Ubuntu 22.04 / 24.04 与 Windows 11，要求兼容 RTX GPU 与驱动。虚拟机需要实际获得所需设备访问；宿主机有 GPU 不能证明来宾可用。参见 [NVIDIA 系统要求](https://docs.isaacsim.omniverse.nvidia.com/6.0.1/installation/requirements.html)和[官方 Python 安装说明](https://docs.isaacsim.omniverse.nvidia.com/6.0.1/installation/install_python.html)。

遇到问题请保留版本、安装来源和已去隐私的错误截图，联系 [voryneltech@gmail.com](mailto:voryneltech@gmail.com)。
