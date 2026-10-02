# DEV-039 回执：WebGL 不可用时不再静默留空座位

日期：2026-09-26
工作面：W11（task-11），Lead 直接实现
条目：DEV-039（W11 内其余三条 DEV-034/035/036 **未开始**，见文末）

## 问题

3D 渲染（WebGL）创建失败时，场景 tab 的 slot 渲染抛错被框架接住，**用户看到一个空座位**：没有错误、没有解释、没有建议。

根因定位：`packages/lyapunov-shell/src/workbench.tsx` 的 `boot()` 里

```js
instance=createViewer({...})     // ← 裸调，没有 try
```

`createViewer` 内部 `new THREE.WebGLRenderer(...)` 在无 WebGL 时抛异常 → 异常穿透 effect → 被 slot 渲染边界接住 → 标签页留白。而 `boot()` 里已经有一条 `onError:value=>setError(String(value))` 的通路，但**创建期**失败根本走不到它。

## 改动（3 个文件 + 1 个新模块 + 1 个新测试）

### 1. `packages/viewer/src/index.ts` — 把失败变成可分辨的类型

新增 `WebGLUnavailableError`（带 `code = "VIEWER_WEBGL_UNAVAILABLE"`），并把 renderer 创建包进 try：

```ts
try {
  this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true })
} catch (error) {
  throw new WebGLUnavailableError(error)
}
```

为什么必须有类型而不是让 three.js 原始异常冒出去：上层要**分辨**"这台机器画不出 3D"（环境缺能力）和"这个场景坏了"。靠匹配 three.js 的异常字符串既脆弱又说不清。原始原因保留在 message 里 —— 那是区分"没卡／驱动挂了／被禁"的唯一线索。

`packages/viewer/src/client.tsx` 同步导出该类型。

### 2. `packages/lyapunov-shell/src/render-failure.ts`（新）

环境失败话术的**唯一 owner**，单独成模块以便测试（不必把整个 workbench 组件树拉进测试）：

- `isWebGLUnavailable(value)` —— 认类型、认裸 `code`、认报文里的 `WebGL`；非 WebGL 失败一律 false
- `describeRenderFailure(value, tr)` —— 分两支：WebGL 失败给**四条可执行处置**（① 硬件加速被禁 ② 远程/容器无 GL ③ 驱动过旧或升级后异常 ④ 无卡或被占用）＋ 诊断原文；其它渲染失败给通用文案 ＋ 原文

文案里明确写了「**世界仍可运行、停止按钮始终可用**」—— 不能让用户以为整个产品挂了。

### 3. `packages/lyapunov-shell/src/workbench.tsx`

- 新增 `renderFailure` 状态（与 `error` **分开**：`error` 是"这一轮操作失败了"，会随下次操作清掉；`renderFailure` 是"这台机器上 3D 画不出来"，在环境修好前一直成立）
- `boot()` 整段包进 try/catch，失败时 `setRenderFailure(describeRenderFailure(value, tr))` 并清掉 `viewer.current`；**不再让异常穿透 effect**
- 新增 `renderRetry` 计数，放进创建 effect 的依赖，使"重试"能真正重建 viewer
- 渲染侧：`viewerVisible` 且 `renderFailure` 时**用错误面板顶掉画布位置**（复用既有 `lya-empty` 版式），带 `role="alert"` 与 `data-testid="viewer-render-failure"`

### 4. `packages/lyapunov-shell/test/render-failure.test.ts`（新，6 用例 / 26 断言）

覆盖：类型错误的 code 与原因保留、无 cause 时不崩、三类"环境缺能力"判定、**非 WebGL 负对照**（不得被误判）、WebGL 话术含四条处置与原文、非 WebGL 走通用分支。

## 验证读数

```
bun --no-env-file test packages/lyapunov-shell/test/render-failure.test.ts
  → 6 pass / 0 fail / 26 assertions

tsc --noEmit -p tsconfig.json  （本次改动的文件）
  → 零错误
```

**未验证（如实登记）**：真实浏览器里"空座位被顶掉"的视觉结果需要真机/无头浏览器截图。本机没有可用 GL，无法就地取证。已完成的是**行为层**证据（类型、判定、话术、负对照）与**接线**证据（try 覆盖创建段、渲染分支存在），**不是**"在无 WebGL 的浏览器里看到了那句话"的证据。这一条留给真机复测，不得据此标 DEV-039 已验收。

## 边界与依赖

- 本模块当前**自己判 `code`**。W14（`env-readiness`）正在做环境契约 D1–D4；契约落地后这里应改为消费那份统一契约，接口已按同形设计（`describeRenderFailure(value, tr)`），替换成本低。
- `WEBGL_UNAVAILABLE_CODE` 在工作区里定义了一次，viewer 侧 `WebGLUnavailableError.code` 与之同值 —— 两处必须一起改，已在注释里写明。

## 本任务内未开始的部分

task-11 还包含 DEV-034（官方场景外观与 Viewer 投影／初始机位）、DEV-035（展示台词与后台调试信息边界）、DEV-036（桌面图形诊断与会话布局恢复）—— **三条均未开始**。task-11 保持 `in_progress`，不标完成。
