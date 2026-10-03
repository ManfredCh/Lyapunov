# GraspGenX Provider

本目录提供独立的 GraspGenX worker 构建上下文。Lyapunov 主程序通过 ZMQ 连接 worker；未选择 GraspGenX 时不会安装、启动或下载它。

## 运行方式

worker 可以运行在宿主隔离 Python 环境、远程机器或本目录的 Docker/Compose 环境。配置 `GRASPGENX_ENDPOINT` 指向 worker 的 ZMQ 地址；容器方案使用本目录的 `provider.sh`。

```sh
./provider.sh check
./provider.sh build
./provider.sh assets
./provider.sh start
```

Provider 不会自动安装 Docker、NVIDIA 驱动、CUDA、模型权重或许可证。启用资产下载前，必须在部署环境中完成对应模型和夹爪许可确认；真实权重放在包外卷中，worker 以只读方式使用。

## 资产与镜像

所有 Hub 操作都必须使用项目规定的镜像端点，并固定源码、模型和夹爪 revision。镜像失败、文件缺失、权限不足或校验失败时应停止，不回退到其他端点。构建上下文只包含当前 provider 目录。

固定来源及许可证文本见 `licenses/`。这些来源标识用于复现和审计，不代表本仓库包含模型权重或运行回执。

## 边界

- GraspGenX 是可选 Provider，不是 Lyapunov 核心依赖；
- worker 只负责候选抓取推理，Scene、Sim、Jobs 和 Viewer 仍由主程序所有者管理；
- 本目录不包含用户资产、真实凭据、GPU 运行日志或开发验收记录；
- 运行成功必须由部署环境中的 health、metadata 和实际推理回执分别确认。
