---
name: desktop-automation
description: Use computer-use for local desktop applications (windows/clicks/keyboard/clipboard), or browser-use to open an isolated browser and visit web pages. Use for automate desktop app, click window, or browse web page requests; this does not operate the Lyapunov 3D scene itself.
---

# Desktop and Browser Automation Rules

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
