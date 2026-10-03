# Lyapunov路线图

杭州奇异宇宙人工智能有限公司出品。本表只记录未来TODO，不代表Linux x64 Alpha已实现或已验收；当前入口与范围见[README](../README.zh-CN.md)。

| 方向 | 状态 | 实施前要明确的接口与验收 |
| --- | --- | --- |
| 原生macOS：Apple Silicon与x64 | TODO | 各架构SDK/Node/Electron载荷、签名/权限、冷安装、身份与资源恢复。 |
| 微信小程序手机控制 | TODO | 远程链接与已认证身份、任务/相机/停止权限、会话与数据归属、断连取消、不可把手机操作变为无主后台动作。 |
| [Genesis](https://github.com/Genesis-Embodied-AI/genesis-world) | TODO | 独立engine adapter、模型/控制/相机合同、时钟/停止/碰撞与依赖许可；目前未集成。 |
| VR/XR输入与视角 | TODO | 设备输入、坐标/单位、视角与实体控制分离、失焦/断连、按设备实际验收。 |
| DSH伴随升级 | TODO | 固定上游版本、产品patch兼容、会话/插件迁移、可恢复回滚与同版本回执。 |
| Windows经WSL2+WSLg | TODO/未验 | Linux x64包路径评估，不是原生exe；实际GPU/窗口/沙盒与文件系统逐项核对。 |

## Windows Linux-GUI评估前置

按[微软WSL GUI文档](https://learn.microsoft.com/en-us/windows/wsl/tutorials/gui-apps)，前置为Windows 10 build19044+或Windows11、WSL2/WSLg和适用GPU驱动。可在管理员PowerShell使用wsl --install、wsl --update，再在Ubuntu/Linux里使用README中的Linux安装命令。推荐安装/数据放Linux文件系统。本次未完成Windows/WSLg实机验收，不承诺所有GPU或完整Windows桌面兼容。

路线图不改变现有发行支持、收费方式、产品身份或许可证。各方向需要自己的接口与运行证据后才进入发布说明。
