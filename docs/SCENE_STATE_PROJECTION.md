# 工作台 Scene 条件投影

工作台沿既有 `GET /api/lyapunov/state` 轮询读取状态，并携带 `sessionId`、`clientId`、请求目标 `sceneId` 与窗口当前显示的 `displaySceneId`／`displayRevision`。显示标记继续只说明该窗口正在显示什么；`viewer_observe` 仍按原会话、窗口、场景和版本核对真实采集。

普通 Scene 首次向一个会话窗口发送时，仍完整读取、校验、修复必要的旧资源来源并执行既有浏览器出站投影。完整响应成功构造后，宿主在原窗口 presence 表记录这次读取的派生文件身份。后续请求同时满足下列条件时，`state` 省略可选的 `scene` 字段，其余状态照常返回：

- 宿主已向同一会话、同一窗口完整发送过该 Scene。
- 本次窗口显示的 Scene ID 和 revision 与该读取一致。
- SceneStore 核对的设备号、inode、字节数及纳秒级 mtime／ctime 均未变化。

SceneStore 只把完整校验后且读取前后身份一致的 snapshot 关联到一条小型读取标记，不缓存第二份 Scene 内容。`snapshot()`、提交、历史和 CAS 继续走原完整校验路径；该标记不是新版本权威。读取期间文件发生变化时，该次 snapshot 不产生可用于省读的标记。

新窗口、新会话、Host 重启、缺显示标记、切场景、未来或过期 revision，以及同 revision 的文件改写，均走完整读取与投影。坏 JSON、非法文档和缺失文件按实际错误返回，不用旧内容覆盖错误。官方评测 Scene 仍归活动 world 所有，继续原实时只读投影路径。

工作台收到省略 Scene 的轻响应时，保留当前 Scene、Viewer 与重开缓存。普通 Scene 的完整响应会实际交给 Viewer，包括 revision 未变的外部文件更正；现有请求归属、旧 revision 拒绝及官方 world 投影代次核对仍保留。人体 rig、clip、Scene 定义、Frame 字段和物理时钟均未裁剪。

自动回归位于 [SceneStore 文件身份与错误测试](../packages/scene-kit/test/store-scene-not-found.test.ts)、[真实 HTTP 与会话窗口测试](../packages/lyapunov-shell/test/resource-route-base-token.test.ts) 和 [工作台 DOM 测试](../packages/lyapunov-shell/test/workbench-import-surface.test.tsx)。通过现有入口运行：

```bash
bun run script/test-ci.ts --filter store-scene-not-found
bun run script/test-ci.ts --filter resource-route-base-token
bun run script/test-ci.ts --filter workbench-import-surface
bun run script/test-ci.ts --filter viewer-observe
```

上述行为检查不代表 RTX 渲染或实时物理性能验收。轮询的 250ms 是带 busy 门的尝试间隔，不构成 4Hz 吞吐承诺；真实产品的状态成本、Frame 速率和 RTF 分别取证。
