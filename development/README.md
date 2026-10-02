# LyapunovDev 开发说明

本说明用于 Lyapunov 客户端源码开发。开发模式使用仓库自身的 `script/` 和 `packages/`；当前 Alpha 的功能与已知范围见[发布说明](../docs/releases/2026-10-linux-a08.md)。开发、候选测试与公开发布分别由 Dev、Issue 和 Lyapunov 主仓管理。

公开源码保留构建、测试及其必要输入。服务器管理资料、认证信息、用户运行数据和内部过程回执分别维护，不随公开客户端源码分发。

开发入口：`bin/lyapunov-dev-linux`，默认读取 `config/developer.yaml`。完整 key 名称见 `config/keys.example.md`，真实值只能由当前进程环境或包外 Secret Manager 注入。详细说明见 `docs/developer-mode.md` 和 `docs/development-receipts.md`。
