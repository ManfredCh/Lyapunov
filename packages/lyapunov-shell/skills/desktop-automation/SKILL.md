---
name: desktop-automation
description: Use computer-use for local desktop applications (windows/clicks/keyboard/clipboard), or browser-use to open an isolated browser and visit web pages. Use for automate desktop app, click window, or browse web page requests; this does not operate the Lyapunov 3D scene itself.
---

# 桌面与浏览器自动化

## 原生 Cua Driver（macOS 与已装配的其它平台）

- 使用当前注册的 `cua_driver_native__*` 工具及其真实 schema，先核对应用与窗口，再读取新快照。macOS 不依赖 X11、DISPLAY 或 ComputerUseLinux。
- 后续操作沿用该快照的 `element_token` 或截图坐标；新快照会使旧 token 失效。使用 `target` 时不要同时提交旧式 pid/window_id 参数。
- Electron 等嵌入式网页的 AX 文本可能只回显而没有进入页面；不能仅凭 AX 值确认输入。可在目标窗口可见且截图有效时，按最新窗口截图的像素坐标向同一 `type_text` 传 `x`、`y`（不同时传 element token/index），让原驱动在控件上聚焦并输入；操作后用新截图及页面实际结果核对。尚未展开的控件先用原 AX 操作打开，再取新截图。
- 优先后台投递；焦点或权限拒绝不授权前台重试。操作后读回真实结果，不能把输入已投递当成任务完成。
- 权限检查默认 `prompt:false`；缺少屏幕录制或辅助功能权限时说明实际缺项，沿系统正常授权流程处理。取消不会撤销已经投递的输入。
- macOS 光标叠层可能明确返回 facility_unavailable；截图、状态读取及输入能力分别核验。

## 原生 ComputerUseLinux（使用当前发现的 `mcp__computer-use-linux__*` 工具）

- 先用 `get_app_state` 按实际 `pid`、`window_id` 或应用名读取新状态；用 `list_windows`／`focused_window` 核对目标。仅操作用户已授权的目标，优先最新 `element_index` 或唯一 `name`／`role` 语义选择器。
- `click`、`set_value`、`press_key` 后读取新状态和应用实际结果；返回 `ok:true` 本身不证明点击、输入或提交生效。要求 Enter 时需实际按键／提交读回，`perform_action` 的语义 activate 只是另一种操作。
- 用 `screenshot` 或带截图的 `get_app_state` 看真实目标。截图坐标先除以返回的 `scale`；窗口相对点击使用 `relative:true` 并带同一目标，勿把逻辑控件坐标当桌面像素。
- 焦点拒绝时先核对当前窗口；可用原 `activate_window`／`screenshot` 正常恢复目标前台，再读 exact focus。系统 portal 需正常授权，首次提示及时处理；授权等待失败后读新状态再重试，勿绕权限或盲目重复输入，也勿仅凭 fallback 的 ydotool 错误猜测缺驱动。

## browser-use (`mcp__chrome-devtools-mcp__*` tools)

- Each session has an isolated Chromium instance, leaving the user's existing browser/debug channels untouched.
- After opening a page, inspect actual DOM/snapshot content before answering. A load-event timeout does not establish an unloaded page; inspect the DOM.
- Manage only tabs opened by this session. Do not terminate browser processes or operate on other user windows.
- Screenshots require image-input support; prefer text/DOM paths.

## File Boundary (ENV-04)

- Use bash/read/write and other file tools for task-workspace scripts, references, intermediate outputs, and exports.
- Product state must use domain tools (`scene_*`/`asset_*`/`sim_*`/`robot_*`, etc.). **Do not change product state by editing files on disk**, and do not modify product source. Capabilities come from skill contracts and actual product-tool results.
