---
name: desktop-automation
description: Use computer-use for local desktop applications (windows/clicks/keyboard/clipboard), or browser-use to open an isolated browser and visit web pages. Use for automate desktop app, click window, or browse web page requests; this does not operate the Lyapunov 3D scene itself.
---

# Desktop and Browser Automation Rules

## computer-use (`cua_driver_native__*` tools)

- Discover with `list_apps`/`list_windows`, then get a **fresh** target-window snapshot through get_window_state, including element_token/screenshot. Act using that snapshot's token or screenshot coordinates. A new snapshot invalidates old tokens; refresh before acting.
- Choose target or legacy pid/window_id fields; do not mix them.
- Prefer background delivery without taking focus. A rejection does not authorize a foreground retry.
- Verify every action using fresh state. If uncertain, take another snapshot instead of claiming UI state from memory.
- Read-only listing/snapshots always precede clicks/input. Tell the user before operating on another person's window content.

## browser-use (`mcp__chrome-devtools-mcp__*` tools)

- Each session has an isolated Chromium instance, leaving the user's existing browser/debug channels untouched.
- After opening a page, inspect actual DOM/snapshot content before answering. A load-event timeout does not establish an unloaded page; inspect the DOM.
- Manage only tabs opened by this session. Do not terminate browser processes or operate on other user windows.
- Screenshots require image-input support; prefer text/DOM paths.

## File Boundary (ENV-04)

- Use bash/read/write and other file tools for task-workspace scripts, references, intermediate outputs, and exports.
- Product state must use domain tools (`scene_*`/`asset_*`/`sim_*`/`robot_*`, etc.). **Do not change product state by editing files on disk**, and do not modify product source. Capabilities come from skill contracts and actual product-tool results.
