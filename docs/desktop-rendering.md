# Linux 桌面 NVIDIA 渲染

从源码根启动完整桌面工作台：

```bash
bun run dev:desktop --nvidia-rendering
```

从 Linux 便携发行包根启动：

```bash
./lyapunov desktop --nvidia-rendering
```

该显式选项在当前 Electron 进程内设置 NVIDIA PRIME offload，并选择 ANGLE Vulkan。它不修改系统显卡、驱动、显示服务或用户全局环境。共享 Viewer 保留原有上下文参数，使用该实例实际选择的硬件后端；不以高性能偏好冒充设备证明。桌面在启动时核对当前页面真实已初始化上下文的 renderer 和 WebGL 状态，无法获得 NVIDIA 时报告 `NVIDIA_RENDERING_UNAVAILABLE`，保留显式选择而不暗换软件渲染。此选项与 `--software-rendering` 互斥。

原有网页 Renderer 的 `sandbox=true`、`contextIsolation=true`、`nodeIntegration=false` 保留；启动参数不关闭沙箱、不忽略 GPU blocklist。Chromium 在 Linux Vulkan 路径可能报告 GPU 进程自身未启用 GPU sandbox；这与网页 Renderer 沙箱是两项事实，不能据网页配置宣称所有进程都受沙箱保护。

源码验收可附加 `-- --acceptance-output=/绝对/私有目录`，目录中的 `shell.json` 包含实际请求后端、Electron GPUInfo、功能状态、网页安全配置与可见/焦点状态；`shell.png` 是该实例页面截图。发行构建不开放此本机诊断入口。设备枚举、构建、窗口截图、真实动作与实时帧率分别验收，NVIDIA 后端可用不推导任意场景容量已达标。
