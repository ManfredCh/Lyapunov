# MCP 资源与提示词薄扩展

复用固定 DSH 的单一 MCP Client，通过版本化的 `patches/dsh-mcp-content-bridge.patch` 与 `patches/dsh-mcp-oauth-bridge.patch` 接入原生连接生命周期，不建立第二 Client、Agent 或 Session。

提供 `list_mcp_servers`、`list_mcp_resources`、`read_mcp_resource`、`list_mcp_resource_templates`、`list_mcp_prompts`、`get_mcp_prompt` 的 Tool 与同名人工 Command。提示内容仅按需获取，不自行执行；图片/PDF 二进制资源使用原生附件存储，保留 URI 与文件引用。

实例按 DSH scope 解析最近服务器配置，兄弟 scope 不共享本地覆盖；连接失效时明确报错，不能隐式回退到另一服务器。运行回执保留在开发仓库，不随发布源码提交。根 bootstrap 在固定上游 commit 上依次应用两个补丁，再构建受影响包；当前本地 checkout 已应用，HEAD 未改变。

## MCP 浏览器授权

OAuth 使用原生 MCP transport 的 SDK `OAuthClientProvider`，令牌、客户端动态注册信息和发现缓存通过当前 owner 的 `ctx.credentials` 保存。记录同时绑定服务器 URL 和原生 scope；修改 URL 不复用原授权，子会话的同名配置不读取父配置的授权。

在原有 MCP 插件配置上启用 `oauth`：

```yaml
- name: '@lyapunov/mcp-extras'
- name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: documents
    transport: streamable-http
    url: https://your-mcp-server.example/mcp
    oauth:
      scope: read
```

也可用 `oauth: true` 采用服务器提供的授权范围。支持动态客户端注册的服务器会接收本机随机回调端口；预注册客户端使用以下明确配置，并将同一回调 URI 登记在授权服务器：

```yaml
oauth:
  clientId: your-registered-client
  clientSecretEnv: YOUR_MCP_CLIENT_SECRET
  redirectUri: http://127.0.0.1:19876/mcp/oauth/callback
  scope: read
```

`clientSecretEnv` 可省略；存在时通过原生 credentials 引用解析，不将秘密值写进 MCP 配置。当前回调只监听本机 HTTP loopback，适用于浏览器与 Host 在同一台机器的授权流程。

以下同名 Tool 与 Command 都接收 `{"serverName":"documents"}`：

| 入口 | 行为 |
| --- | --- |
| `mcp_login` | 返回可点击的浏览器授权 URL；用户完成授权后恢复原生 MCP 连接。等待授权时不重新生成 PKCE 请求。 |
| `mcp_auth_status` | 返回授权状态、有效期和待完成授权链接，不返回令牌或客户端秘密。 |
| `mcp_refresh_auth` | 使用 SDK 的刷新令牌流程，再恢复同一原生 MCP owner 的工具。过期访问令牌收到服务器 401 时也由 SDK 自动刷新。 |
| `mcp_logout` | 断开该 scope 的 MCP 连接、移除它的工具并删除本地 OAuth 凭据；不影响其他 scope。 |

授权回调校验一次性 state，SDK 与服务器执行 PKCE 授权码交换。默认回调状态在十分钟后失效；Host/插件退出会清理监听器和待处理 state。退出清除的是本地授权，不声称已在外部服务撤销授权。

本地实际协议验证使用当前已安装的官方 MCP SDK OAuth/MCP HTTP 服务，驱动本生产实现完成动态注册、明确同意、授权码／PKCE、MCP工具和资源、自动及手动刷新、scope/URL隔离、凭据重开和退出。入口为 `node packages/lyapunov-mcp-extras/test/oauth-evidence.mjs`；真实外部 OAuth 服务的配置、账户授权和调用另行验收，不以本地协议结果代替。

## 旧 SSE 与 ACP 兼容

旧 SSE 服务器通过原生 MCP 配置 `transport: sse` 连接，OAuth 配置仍使用同一字段和同一凭据 owner。协议由用户显式选择；不会因为认证失败或任意服务端 500 就自动换协议。实际 SSE 授权、GET 事件流、POST 消息、工具／资源和退出验证入口为 `node packages/lyapunov-mcp-extras/test/oauth-evidence.mjs --sse`。

`patches/dsh-acp-compatibility.patch` 在现有 DSH ACP Server 中补回 `session/load`、`session/fork`、嵌入 resource 和 ACP 声明的 SSE MCP。

- `session/load` 恢复已关闭的原生 Session，并按顺序回放真实用户、助手与工具消息；系统提示和内部上下文不会重放为用户消息。
- `session/fork` 从最近一个已结束回合的完整前缀创建原生分支。父子 Session、追加内容和持久化分别独立；分支可再 list/load/resume。
- 嵌入 text 进入原生文本内容；blob 经严格 base64 检查后进入原生附件。原 URI／mimeType 保留为来源文本，二进制字节保持原样；回放使用原生附件 URI。
- 音频仍按已有 ACP 能力返回不支持。图片沿原有路由与附件能力动态声明，不强制宣称所有模型支持。

实际协议入口为 `node script/acceptance/r110-acp-compat.ts`：官方 ACP 客户端通过 stdio 驱动生产 Server，验证 SSE 挂载、资源入库、重启 load、fork／再次重启后的独立性，并复用既有真实 CLI 日志验证助手与工具历史。新输入在落入原生 Session 后由测试 hook 取消，因此该测试验证协议和持久化能力，不生成模型替身或宣称新模型推理成功。
