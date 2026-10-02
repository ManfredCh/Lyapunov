# 运行模式与账户隔离

开发者通道由 `bin/lyapunov-dev-linux` 或 `bun run dev:developer` 启动，先验证包外开发者账号密码，再读取 `config/developer.yaml`。YAML 可显式选择模型 `route.provider`/`route.model`/`route.reasoning_effort` 以及 `engine`/`grasp`；低层 `script/launch.ts --mode developer` 仅用于不带账号门的内部调试。Linux 入口也可用 `--config <文件>` 指定另一份不含密钥的 YAML。没有网页内切换开关；`NODE_ENV=production` 时拒绝开发模式。引擎选择走唯一实现 `resolveEngine()`（显式 ＞ 环境变量 ＞ 用户偏好 ＞ 默认 Isaac 优先／回退 MuJoCo）；开发数据默认在 `.runtime/developer`（YAML `runtime_root`，多实例并行时自动加后缀）。

正式模式必须先向真实Lyaup账户API验证当前会话，再使用返回的稳定账号ID建立私有Host。账号目录沿用旧版账号ID派生算法；每个账号分别持有 DSH_HOME、Scene、插件目录、Workspace与模型会话。正式Host不读取开发者的上游模型Key，模型仍通过中央账户服务中转。

账户切换严格等待旧Host与模拟world/订阅释放，再启动新账号Host；登录失败不会创建假账号、积分、订单或钱包。退出或切换的原始用户资产保留，旧动作不会被自动重发。

正式CLI启动已访问 `/v1/me` 验证身份，并通过DSH原生PiAi注册中央服务的基础/高级模型。正式Host只继承必要系统环境和本账号会话，不继承开发Key或旧OpenCode配置。Electron正式窗口通过网站登录回执再次验证/v1/me；开发窗口不构造或读取正式账号安全存储。账户UI提供套餐、订单、刷新和退出，只有用户在UI选择付款时才创建订单；本次没有提交真实订单。完整支付状态验收仍在实施。API服务的隔离测试通过仅代表本地计费/身份逻辑，不替代真实登录、真实流式用量或已授权外部交易验收。

开发凭据优先来自后端环境；也可用 `LYAPUNOV_DEVELOPER_AUTH_FILE` 指向本应用的模型凭据，旧 `LYAUP_*` 仅作兼容输入。开发者账号文件只保存 scrypt 摘要，默认位于 `~/.config/lyapunov/developer-account.json`，不复制进源码、网页或模型子进程。DSH自己的浏览器启动 token 由本机 Profile 生成，不等于 Lyapunov 正式账号。

## 桌面进程边界

- 源码运行数据：`.runtime/desktop/formal`、`.runtime/desktop/developer`；正式账号Host在formal/runtime/accounts/<稳定账号键>下。`LYAUP_DESKTOP_DATA_DIR`可指定独立验收根。
- `dev:desktop`仅正式入口；`dev:desktop:developer`为专用开发入口。packaged或NODE_ENV=production拒绝developer；正式窗口不显示开发工具菜单，也不加载上游Key编辑/开发者首次引导。
- workspace窗口使用按模式和账号分离的Electron partition。IPC只接受自有主frame，contextIsolation与sandbox开启，nodeIntegration关闭。
- 退出/切换会等待DSH进程停止后再启动后续Host。SIGINT/SIGTERM也通过Electron正常退出清理；实际进程和端口释放已验证。意外Host退出显示恢复入口，不重发机器人动作。
- 系统安全存储不可用时显示仅本次登录有效，不退回明文存储。中文/English及浅色/深色/系统主题偏好保存在该桌面模式的界面存储内。
