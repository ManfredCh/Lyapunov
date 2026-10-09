# 原生 ComputerUseLinux 供给

默认使用官方稳定版 0.7.13；原生 MCP、权限与目标窗口保护保持原实现。

本地修补版 0.7.13+local.atsbus.1 作为明确的可恢复选项保留：显式设置 `LYAPUNOV_COMPUTER_USE_LINUX_VARIANT=local`；必要时明确 `AT_SPI_BUS_ADDRESS`。需核对目标真实状态，不自动改用其他总线，不跨总线派发动作。

默认选择只影响缺失服务的原生装配，已有用户 namespace、参数、环境和停用配置优先保留。原官方与本地二进制、MIT 许可证和本地完整补丁均随供给保存；`computerUseLinuxPaths()` 的未指定路径仍指向内部本地件，写入方不能把它当作默认选择。

Official stable version 0.7.13 is the default. Select the retained local variant explicitly with `LYAPUNOV_COMPUTER_USE_LINUX_VARIANT=local`; both binaries, the original patch and MIT license are preserved. Existing namespaces, arguments, environments and disabled settings take precedence.

`computerUseLinuxPaths()` without a variant remains an internal local-asset path for safe writes; runtime selection uses `computerUseLinuxVariant()`. Verify the actual target state; no automatic cross-bus action dispatch is introduced.
