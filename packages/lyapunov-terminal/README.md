# Lyapunov 原生交互终端

终端复用 DSH 原生 Session、Commands、Jobs、审批和权限。它不建立第二套 Agent、会话或历史数据库。

## 启动

源码开发入口：

```sh
bun run script/terminal.ts --help
```

便携包入口：

```sh
./lyapunov terminal --help
```

默认数据根由启动参数或 `LYAUP_TERMINAL_RUNTIME_ROOT` 指定，建议放在包外的私有运行目录。模型凭据、账号 token 和会话数据不随源码发布。

`--engine <isaac|newton|mujoco|none|benchmark>` 决定本次 Host 装配哪个仿真 Provider，
优先级与 `launch.ts` 相同（显式参数 > `LYAPUNOV_SIM_ENGINE` > 用户偏好 > 代码默认），
但**默认值是 `none`**：没有显式配置过引擎的机器上，开终端不会启动仿真或占 GPU。
引擎在 Host 启动时装配，运行中换不了；`--attach` 连的是远端 Host，因此不接受本地 `--engine`。

## 输入与会话

终端支持文本输入、文件引用、会话恢复、审批、取消、历史分页、剪贴板和外部编辑器。每个会话属于当前 DSH Host；切换账号或 Host 时先等待旧进程、订阅和模拟世界释放。

全屏入口使用固定区域布局，并通过原生 Workspace owner 管理会话、工作区、终端和 Review 面板。客户端不保存第二份 Workspace 状态，也不直接访问远端磁盘。

## 远端连接

`--attach` 入口连接远端 Host 的原生会话与 Workspace 命名空间。远端网络、身份和凭据由部署环境提供；本包不内置服务器地址、AccessKey 或模型 key。

## 运行边界

- 正式模式使用官网账户服务验证身份；
- 开发模式和正式模式使用隔离的数据根与 Electron partition；
- 没有有效会话或权限时，终端拒绝发送命令；
- 终端本身不负责消费者积分、订单或中央账单；
- 运行回执和开发验收材料保留在开发/运维仓库，不随发布源码提交。
