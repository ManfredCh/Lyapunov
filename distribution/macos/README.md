# macOS 运行与便携候选说明

本目录保存源码启动器及 macOS 兼容说明。便携候选复用 `script/package-linux.ts` 的原依赖收闭、插件构建、资源 stager、出处守卫和归档流程；新增的只有 Darwin 原生模块、Electron.app 布局及启动检查。历史交接日志见[归档](../../docs/receipts/MACOS_PORT_HANDOFF_20261031.md)，不作当前状态来源。

> **当前状态（请勿误读）**
>
> - 已实际构建 arm64 便携候选，在另一目录解包后通过 desktop doctor 并打开独立 Guest 工作台。包内 `runtime/electron/Lyapunov.app` 依赖同一个便携根中的插件、Node 和资源，移动时须保留整个便携目录；它不作为可单独拖走的 `.app` 分发。仅本机 ad-hoc 签名：未 Developer ID 签名、未公证（Gatekeeper `spctl` 拒绝），无 DMG／universal。
> - `bun run build:macos` 和 `build:linux` 调用**同一份**原打包器，按实际宿主选择 Darwin arm64 或 Linux x64 兼容叶；不复制第二套收闭或功能实现。`distribution/linux/` 中已有的通用 launcher、doctor、安装器及下载工具继续共用，Linux 沙箱只在 Linux 执行。
> - 本仓库**没有任何 Apple 签名材料**：没有 Developer ID 证书、Team ID、公证用的 App 专用密码或 `notarytool` keychain profile，也不应该把这些放进仓库。
> - 当前客户端是 Electron 43.5.1 + Chromium 渲染本地页面；本轮源码运行与交互证据见[历史交接日志（归档）](../../docs/receipts/MACOS_PORT_HANDOFF_20261031.md)。
> - 基于 0.2.1 的移植曾在 macOS 26.5.1 / arm64 完成源码运行与核心交互实测；本轮结果见[历史交接日志（归档）](../../docs/receipts/MACOS_PORT_HANDOFF_20261031.md)（历史记录，不作当前验收），下面保留的旧记录同样不代替当前验收。

---

## 1. 源码运行与便携候选

源码运行继续复用原 **DSH + Electron** 入口；便携候选增加了同版固定 Node、Electron 与完整插件依赖闭包。

```sh
# 前置：Node.js >= 24（package.json engines）、Bun 1.4.2（packageManager）、Xcode Command Line Tools
node script/bootstrap.mjs          # 或 bun install，安装 node_modules（含 packages/desktop 的 electron 43.5.1）
bun run build:plugins              # 重建 packages/*/dist/plugin.js
bun run build:desktop              # 生成 packages/desktop/dist/main.js、preload.cjs、renderer/account.js
bun run dev:desktop                # = node script/desktop.ts --mode formal
```

便携构建在 Apple Silicon 上执行（需要所选官方 Node 发行目录的 bin、include 和 LICENSE；不能把依赖 Homebrew dylib 的 Node 当成便携运行时）：

```sh
bun run build:macos --node /绝对路径/node-v26.3.1-darwin-arm64/bin/node \
  --release-id 0.2.1-macos-候选标识
# 模型及策略仍由原 stager 收取：
# LYAPUNOV_ROBOT_STAGING_ROOT、LYAPUNOV_ROBOT_POLICY_STAGING_ROOT
# 未提交工作树默认拒绝出包；明确本机候选可用 LYAPUNOV_PACKAGE_ALLOW_DIRTY=1，
# RELEASE.json 会如实写 sourceCommitMatchesPayload=false，不能冒充正式源码发行。
```

构建产物是 `lyapunov-darwin-arm64-<release-id>.tar.gz`。完整解包后运行 `./lyapunov doctor desktop`、`./lyapunov desktop` 或打开其内置应用。账户与 Guest 继续由原账户／Profile owner 隔离。当前签名仅为本机 ad-hoc；没有配置自动更新源，没有发布。

`script/desktop.ts` 用 `require("electron")` 找到本机已安装的 Electron 可执行文件，再以 `packages/desktop` 为应用目录启动；正式模式窗口会先要求官网登录（§5），不会伪造账户，也不会启动本地模型。

本目录的 `lyapunov` 是上述流程的启动脚本封装（含前置检查），同样**不是**签名产物：

```sh
sh distribution/macos/lyapunov          # 若已加可执行位，也可 ./distribution/macos/lyapunov
sh distribution/macos/lyapunov --help
```

未打包运行（`app.isPackaged === false`）时：

- 数据写在 **`<仓库根>/.runtime/desktop/formal`**，不写 `~/Library`（见 §4）；
- 自动更新永远不可用，`check-updates` 返回 `本机构建未配置更新源`（`main.ts:120`）；
- `--developer` 在打包构建或 `NODE_ENV=production` 下会被直接拒绝（`main.ts:18`）。

## 2. 架构：arm64 / x86_64 / universal

| 项 | 现状 |
| --- | --- |
| 计划要求 | 原 macOS 适配计划（未随本仓库提供）§5：v1 发布 universal 二进制（arm64 + x86_64），在 Apple Silicon 上构建并交叉编译 Intel 切片，或在真 Intel 硬件上至少验证一次 |
| 实际产物 | arm64 便携候选已构建并搬移运行；没有 `lipo` 合并或 Intel 真机验证 |
| 源码树运行 | Electron 由 `packages/desktop` 的 npm 依赖安装，架构跟随当前机器：Apple Silicon 装 arm64，Intel 装 x64。两者各自只跑本机架构的切片 |
| Rosetta 2 | 只有在 Apple Silicon 上运行 x64 切片时才会用到；本项目没有 x64 切片可供测试，也没有跨架构验证记录 |
| universal | 当前未实现；现有单架构候选不声明跨架构验证 |

旧 universal 计划的工具示意（未执行；当前单架构候选复用原打包器，不需要增加该依赖）：

```sh
# bun add -d electron-builder        # 本仓库当前没有这个依赖，属于新增决策，不在本目录范围内
# bunx electron-builder --mac --universal --arm64 --x64 --publish never
```

纯 JS 依赖（electron-store / electron-window-state / electron-updater）不含原生模块，universal 合并的主要风险来自嵌套的 Electron Helper 与框架二进制；`@electron/universal` 默认处理这些，但**合并结果必须真机验证**，不能只看命令退出码。

## 3. 窗口技术栈：不是 WKWebView

原 macOS 适配计划（未随本仓库提供）§1 规划的是 SwiftUI `WindowGroup` + `WKWebView`。当前实现**完全是另一条技术栈**：

- 所有窗口都是 Electron `BrowserWindow`（Chromium），渲染 `packages/desktop/renderer/index.html`（`main.ts:30-32`）。
- 账户窗口带 `contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`，并使用独立 `partition: "persist:account-bootstrap"`；工作台窗口按 `persist:<mode>-<identity>` 隔离（`main.ts:54,62`）。
- 外链一律交给系统浏览器：`openExternal` 只允许 `https:`（以及 localhost 的 `http:`），其它协议抛错（`main.ts:34`）。
- **没有** `WKWebsiteDataStore`，因此计划 §2 里"会话 cookie 由 web 视图持有"的描述在现状下不适用：会话由 §4 的 Keychain 加密存储持有。

结论：写 macOS 文档时不要引用 WKWebView 的行为；本仓库核对过，没有一行 WKWebView/`ASWebAuthenticationSession`/`CFBundleURLTypes` 代码。

## 4. 数据目录与 Keychain

### 目录

| 运行方式 | 数据根 |
| --- | --- |
| 打包运行（`app.isPackaged`） | Electron `userData`，即 `~/Library/Application Support/<app 名>`（`main.ts:19-24` 先 `app.setName("LyapunovDSH")`；实际目录名以 `app.getPath("userData")` 为准） |
| 源码树运行 | `<仓库根>/.runtime/desktop/formal` |

两者都可以用 `LYAPUNOV_DESKTOP_DATA_DIR` 显式覆盖。**该变量为空字符串时必须回落平台默认**：`resolve("")` 会把数据根变成当前工作目录（Finder 启动的 app 工作目录是 `/`），这正是本次修复的一个明确问题（§9 第 8 行）。

数据根下的文件：

| 文件 | 内容 |
| --- | --- |
| `lyapunov.account.json` | 账户会话密文（electron-store，键 `encrypted-session-v1`，值为 safeStorage 密文的 base64） |
| `lyaup.account.json` | 旧存储，仅在迁移时被**读取**一次；`migrateLegacyAccountSession` 不写入、不删除旧存储，迁移标记 `legacy-session-migration-v1` 防止登出后被旧数据回填 |
| `window-state.json` | 窗口位置与大小（electron-window-state） |
| `runtime/` | Host 运行根（场景、插件、录制等），正式账户按 `sha256("lyaup-account-workspace-v1\0<accountId>")` 前 32 位分目录（`runtime-paths.ts:63-66`） |

### Keychain

- 会话 token **只以密文落盘**：`safeStorage.encryptStringAsync` / `decryptStringAsync`（`account-session-store.ts:106-144`）。macOS 上 safeStorage 的加密密钥由**系统钥匙串（Keychain）**保管，明文 token 不写文件、不写日志。
- Keychain 不可用时**失败关闭**：`isAsyncEncryptionAvailable()` 为假则抛 `AccountSessionStorageUnavailableError`，界面提示既定文案"登录有效，但系统安全存储不可用；本次退出后需要重新登录。"，**不会**降级为明文或 plist。
- 重加密：解密返回 `shouldReEncrypt` 时用 `replaceIfCurrent` 原子替换，避免并发写覆盖新会话。
- 登出：`delete()` 删除密文条目；随后的工作台停止由 `RuntimeOwner` 串行切换。
- **未签名/反复重建的开发构建**：Keychain 条目的访问控制与代码签名绑定，重建后的二进制可能再次弹授权框或直接读不到密钥——这走上面既有的"安全存储不可用"分支，不需要新增代码，也不要为了绕开它改成明文存储。
- **换服务地址即失效**：`account-controller.ts:39-40` 校验已存会话里的 `apiUrl`，与当前配置不一致时报"保存的账号属于另一服务地址；请重新登录"。所以改 `LYAPUNOV_API_URL` 之前要知道用户需要重新登录一次。

### 升级与回退（运行根布局迁移的回退边界）

便携候选走同一份 `distribution/linux/install.sh`（Darwin 分支见 `install.sh:114,160,429,449,526` 等）与 `install-entry.mjs`（darwin 入口，`install-entry.mjs:10-20`），复用同一 `versions/`、`current`/`previous` 安装状态机——**不是**"没有发行包、没有那套 tar 流程"。且**产生回退边界的那段代码与平台无关**，macOS 走的是同一条，所以同一句边界必须写在这里（Linux 侧同口径见 `distribution/linux/README.md` 的「升级与回退」）：

- **迁移是移动语义。** Host 每次启动都会走 `script/host.ts:45` → `script/profile.ts:248` → `script/migrate-workspace-layout.ts`，把旧单根 `scene/{scenes,assets,resources}` 用 `rename` 搬进 `worlds/`、`cache/`、`catalog/`（`migrate-workspace-layout.ts:87,108`）：不复制、不留原件，`scene/` 清空后连空目录一起删掉。这条链没有任何 `process.platform` 判定，macOS 的 `node script/desktop.ts --mode formal`（§1）与 Linux 便携包同源；桌面传入的运行根就在数据根之下（`packages/desktop/src/main.ts:77`），即源码树运行的 `<仓库根>/.runtime/desktop/<mode>/runtime`。
- **回退到只认旧 `scene/` 路径的版本前，应先用升级前的只读备份恢复运行根。** 这不是理论风险，而且**出厂上一版就是这种版本**：旧构建里 `ResourceLibrary` 把索引写死成 `<运行根>/scene/resources/index.json`（`scene-kit` 打包件），读不到就返回空库、不报错——本机直接读旧归档 `lyapunov-dsh-0.1.0-linux-x64.tar.gz.bak-20260917` 核对过，它的 `runtime-paths` 里根本没有 `catalog`。同一判据在当前源码是 `packages/scene-kit/src/resources.ts:537-542`。所以旧版本会**正常启动、退出码 0**，只是资产库是空的——升级后的索引在 `catalog/`，它不会去那里找。**产品自己不生成任何备份，也没有 `backup` 子命令**，升级前的只读副本是唯一能回到旧布局的东西——**而且时机只有"第一次用新版本启动之前"这一次**：迁移就发生在启动里，报告只打印在启动输出、不落盘，事后补做不了。所以换检出（将来是换 `.app`）之前，先把运行根整份复制到**仓库之外**（源码树运行即 `<仓库根>/.runtime/desktop/<mode>/runtime`，§4；例如 `cp -a <运行根> ~/lyaup-backup-<日期>`），回退时先用这份副本恢复运行根、再换客户端代码。Linux 侧同一条边界的可执行流程见 `distribution/linux/README.md` 的「升级与回退」。
- **迁移只搬不改的说法要限定范围。** 2026-09-26 候选的本机 Linux 读数确实是"移动 2、合并 0、冲突 0、改写引用 0"（`bugfixHistory/RELEASE-UPGRADE-20260926.md` §5），但迁移代码里保留了「改写 JSON 中指向旧路径的绝对字符串引用」这一步（`rewriteJsonReferences`）：引用命中的运行根**会在原地被改写字节**，且本仓库没有任何 macOS 上的迁移读数。所以更不该指望事后把旧布局拼回来。
- **回退客户端代码不会回退数据。** 运行根挂在数据根下（§4），而数据根两种形态都不是"跟着客户端一起回退"的东西：源码树运行是 `<仓库根>/.runtime/desktop/<mode>/runtime`——`git checkout` 回旧提交不会动它（`.runtime/` 是忽略目录），但 `git clean -xdf` 会连它一起删；打包后是 `~/Library/Application Support/…/runtime`，换掉 `.app` 更不会碰它。两种情况都要先按上一条恢复运行根。
- **同一机器只保留一个安装目录。** 源码树运行时运行根随检出走（两个检出＝两个运行根），这一条现在不适用；将来真的有了 `.app`，同一台机器上的所有副本共用 `~/Library/Application Support/LyapunovDSH` 这一个数据根（§4），届时 Linux「同一机器只保留一个安装目录」那条规则同样适用。
- **本节所述运行根布局迁移与回退尚未在 macOS 上演练**（§13 对应项仍未勾选），它们是待验收项，不是读数。便携候选的安装／升级／回滚曾在本机隔离目录实际执行，见[历史交接日志（归档）](../../docs/receipts/MACOS_PORT_HANDOFF_20261031.md)；该记录是历史记录，不作当前证据。

## 5. 登录：OAuth callback 与"不引入第二套登录"

账户窗口**没有任何邮箱/密码输入框**（`packages/desktop/src/account-view.tsx` 只有一个"登录"按钮）。唯一的正式登录路径是官网 Vorynel OAuth/PKCE，服务端始终是身份与计费的唯一权威。

实现流程（服务端源码已于 2026-09-26 移出本仓库，归 LyapunovOM `backend/dev-server/services/lyapunov-api/src/{app,identity}.ts`）：

1. 桌面 `POST /v1/auth/website/start` → `{flowId, authorizeUrl, expiresAt}`；服务端为本次流程生成 PKCE verifier（48 字节 base64url）并写入 `identity_login_flows`，**5 分钟后过期**，同时清理过期/已消费的流程（`identity.ts:30-41`）。
2. 桌面用系统浏览器打开 `authorizeUrl`（`shell.openExternal`，仅 https/localhost）。
3. 用户在官网完成授权，浏览器回跳 `redirect_uri`，服务端 `GET /v1/auth/website/callback?state=<flowId>&code=<code>` 只把 `authorization_code` 记入该流程（`acceptCallback`），**不建会话、不下发 cookie**。
4. 桌面每 2 秒 `POST /v1/auth/website/complete {flowId}`；未就绪返回 `202 {status:"pending"}`，就绪后服务端用流程内的 verifier 与服务端 `client_secret` 完成交换并返回会话 token（`app.ts:222-227`）。
5. 桌面拿到 token 后立刻调 `/v1/me` 验证身份（`verifyFormalAccount`），验证通过才启动工作台。

### flowId 绑定强度（现状）

- `state` 就是服务端签发的 `flowId`，只在内存中保存、单次使用；
- PKCE verifier 只存在于服务端；一次性消费由 `consumed_at` 保证；5 分钟过期；
- 交换走服务端到服务端（`/api/internal/lyapunov/exchange` + `x-lyapunov-client-secret`）。

**与计划文档不一致，必须知道**：原 macOS 适配计划（未随本仓库提供）§9 描述 `/start` 会下发 httpOnly `SameSite=Lax` 的 flow cookie，且 `/callback`、`/complete`、`/exchange` 都要求携带该 cookie。**代码里没有这套 cookie**，绑定靠上面四条。正式发布前需要做一个明确决定（以代码为准并把计划文档改掉，或补齐 cookie 并做真实验收），**不要在文档或验收材料里假装 cookie 存在**。

### redirect_uri（macOS 上最容易配错的一项）

- 默认值是占位符 `lya://auth/callback`（服务端 `config.ts`，归 LyapunovOM），通过 `LYAPUNOV_IDENTITY_REDIRECT_URI` 覆盖。
- macOS 的自定义 scheme 需要在 `.app` 的 `Info.plist` 里注册 `CFBundleURLTypes`——源码树运行没有 `.app`；便携候选的 `runtime/electron/Lyapunov.app` 有打包器写入产品身份键（`CFBundleIdentifier` 等，`script/package-linux.ts` 约 312–316 行）的 `Info.plist`，但**没有注册 `CFBundleURLTypes`**，所以 `lya://` 仍无法被系统路由到应用。
- 现状下唯一可行的 macOS 路径：把 `redirect_uri` 配成**服务端 HTTPS 回调**（例如已部署的 `https://vorynel.tech/v1/auth/website/callback`，见 `deployment/README.md`），浏览器跳回服务端、服务端记录 code，桌面只轮询 `/complete`。这条路不依赖任何客户端 scheme。
- 若将来真的用自定义 scheme，计划 §9 的强制防御（回调本身不足以登录、state 绑定在途流程、陌生回调直接丢弃、state/code 不落盘/不进日志）必须逐条实现并验收；现在**没有**这些客户端侧实现，因为客户端根本不接收回调。

### 不引入第二套登录（核对结果）

- 桌面正式窗口只读 `LYAPUNOV_API_URL`、`LYAPUNOV_DESKTOP_DATA_DIR`、`LYAPUNOV_SIM_ENGINE`、`LYAPUNOV_GRASP_PROVIDER`、`LYAPUNOV_UPDATE_URL`，**不读 `LYAPUNOV_ACCOUNT_TOKEN`**（`main.ts` 全文核对）。
- `LYAPUNOV_ACCOUNT_TOKEN` 只被 Host 侧入口读取（`script/launch.ts`、`script/benchmark.ts`、`script/terminal.ts`），用于这些非 GUI 入口的既有会话校验，不是桌面登录方式。
- 本目录的 `env.example` 因此把 `LYAPUNOV_ACCOUNT_TOKEN` 明确注释掉，并说明它不属于桌面正式发布配置。

## 6. API URL 规则

- 正式默认：`https://vorynel.com/lyaup-unified`（`packages/lyapunov-product-bundle/src/account/url.ts:2`）。
- 覆盖：`LYAPUNOV_API_URL`（旧名 `LYAUP_API_URL` 仅作显式兼容读取）；空值会被 trim 后回落到默认值。
- 除 localhost/127.0.0.1 外**必须 https**，否则 `normalizeAccountApiUrl` 抛错（`account/client.ts:162-166`）。
- 会话与地址绑定：见 §4 最后一条，改地址要重新登录。
- 正式 Profile 的模型行也由该地址派生（`baseURL = <apiUrl>/v1`，`formal.ts:21-23`）；客户端不保存上游模型名、URL 或 API key。

## 7. 可选依赖：MuJoCo 与 Isaac

桌面不显式指定引擎时，选择链是 显式参数 > `LYAPUNOV_SIM_ENGINE`（空值视为未配置）> 用户偏好 > `defaultEngine()`（`script/engine-preference.ts:259,306`，桌面经 `script/host.ts` 的 `resolveEngine` 进入同一条链）。macOS 上 Isaac 条件不齐 ⇒ 缺省回退 `mujoco`（解释器不存在时仍选 `mujoco`、界面照常启动，打开世界时按真实依赖报错），**不是** `none`。启用非默认引擎是可选的，且都要求使用者自备解释器或经 `install-provider` 安装。

### MuJoCo（可选，macOS 可运行，前提是自备 Python 环境）

- 解释器解析只有两条规则（`packages/lyapunov-product-bundle/src/sdk-python.mjs`）：`LYAPUNOV_MUJOCO_PYTHON` 非空则直接使用；否则用包内落点 `<产品根>/.runtime/sim-python/bin/python`。
- macOS 的安装入口是本目录启动器：`sh distribution/macos/lyapunov install-provider <mujoco|newton|policy-cpu|benchmark-gymnasium|benchmark-libero>`，它复用 `distribution/linux/install-provider`（脚本本身是便携 sh），前置是 `.runtime/bin/micromamba`（osx-arm64；或 `LYAPUNOV_MICROMAMBA` 指向自备 micromamba）。也可以自行准备含 `mujoco` 的环境并用 `LYAPUNOV_MUJOCO_PYTHON` 指向它。
- 渲染后端（本次修复的核心项）：`MUJOCO_GL` 现在按平台解析——显式配置（`LYAPUNOV_MUJOCO_RENDER_BACKEND`）> 继承的 `MUJOCO_GL` > 平台默认（**macOS `cgl`**、Windows `wgl`、其它 `egl`）。MuJoCo 文档化的取值全集是 `egl/osmesa/glfw/cgl/wgl`，校验实现在 `packages/sim-contract/src/mujoco-gl.ts`。macOS 用户显式设置 `MUJOCO_GL=cgl`（或 `glfw`）不会再被覆盖。
- 抓取：默认 `analytic`（纯 MuJoCo，无需学习模型）；`graspgenx`/`anygrasp` 需要各自环境，包内约定路径是 Linux 便携包的 `.runtime/conda/envs/...`，macOS 上没有对应安装器。

### Isaac（macOS 不适用）

- Isaac 适配器的加载器注入（`LD_LIBRARY_PATH`、`LD_PRELOAD=libstdc++.so.6`、`VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/nvidia_icd.json`、`__NV_PRIME_RENDER_OFFLOAD`）**全部是 Linux 专用概念**；本次已改为只在 `process.platform === 'linux'` 时注入（`packages/sim-isaac/src/provider.ts:15-24`），macOS/Windows 上不再把 Linux 路径写进子进程环境。
- NVIDIA 不提供 macOS 版本的 Isaac Sim（macOS 也没有可用的 RTX 驱动栈），本仓库同样没有 macOS 的安装或适配路径，`LYAPUNOV_ISAAC_PYTHON` 的包内默认落点也是 Linux 便携包布局。
- 结论：**macOS 上不要配置 `--engine isaac`**；Isaac 的发布范围是 Linux（Windows 亦未在本仓库适配）。这不是"待办"，是本仓库有意不承诺的能力边界。
- 其它可选 Provider：SAM3、AnyGrasp、GraspGenX 在 macOS 上仍**没有**安装器；`benchmark-gymnasium` 与 `benchmark-libero` 有安装入口（启动器 `install-provider`；LIBERO 在 Darwin 用同版官方 CPU wheels 并原源码构建 tokenizers，`distribution/linux/install-provider` 约 196–206 行）。

## 8. 应用签名完整性与正式公证

现有打包器在暂存目录生成普通的 `Contents/Resources/app` 引导文件，加载同一产品根的原桌面实现；不再把签名资源链接到 `.app` 外。它清理暂存应用扩展属性，完成本机 ad-hoc 签名后执行 `codesign --verify --strict --deep`；归档不携带 macOS 扩展属性。这些检查保证应用资源完整性，不能代替 Developer ID 签名和 Apple 公证。

正式发布仍需发布环境提供 Developer ID Application 证书与公证 Keychain profile。证书私钥与凭据不写入源码或应用。发布环境应先对嵌套 Framework、Helper、应用及随产品分发的 Node／原生模块按顺序执行硬化运行时签名，再提交完整发行容器公证。下面是公证与装订顺序；`<产品目录>`、`<待公证ZIP>`、`<profile>` 由现有发布环境提供。

```sh
# 前提：完整产品中的可执行代码已使用真实 Developer ID 签名。
ditto -c -k --sequesterRsrc --keepParent "<产品目录>" "<待公证ZIP>"
xcrun notarytool submit "<待公证ZIP>" --keychain-profile "<profile>" --wait
# ZIP 不能装订票据；对其中的原 .app 装订，再重新归档产品。
xcrun stapler staple "<产品目录>/runtime/electron/Lyapunov.app"
xcrun stapler validate "<产品目录>/runtime/electron/Lyapunov.app"
codesign --verify --strict --deep --verbose=2 "<产品目录>/runtime/electron/Lyapunov.app"
spctl --assess --type execute -vv "<产品目录>/runtime/electron/Lyapunov.app"
# 装订后重新生成最终归档与 SHA／长度清单，不能沿用装订前的文件摘要。
```

要点：

- 公证要求真实签名与硬化运行时；最终以公证结果、票据校验和 Gatekeeper 检查共同确认发布状态。
- 计划 §4 写着"v1 避免 `allow-jit`"，那是针对纯 `WKWebView` 客户端。现有客户端是 Electron，内嵌 V8 需要 JIT；因此本目录的 `entitlements.plist` 模板包含 `com.apple.security.cs.allow-jit`，并注明原因。若将来真的改成 WKWebView 原生客户端，应按计划 §4 重新收紧授权表。
- 计划 §4 建议的 App Sandbox 与 `com.apple.security.files.user-selected.read-write` 都**尚未启用**：源码树运行没有沙箱，导出路径也不经过保存面板。正式发布前需要单独决策并真实验收。

## 9. 更新（现状）

- 发行桌面在用户检查或安装更新时，才按 `LYAPUNOV_UPDATE_URL` 初始化 `electron-updater` 的 generic feed。四段产品版本（如 `0.2.4.1`）可以启动桌面，检查更新时会显示更新器的 SemVer 错误。源码树和未配置更新源的发行包会显示「本机构建未配置更新源」。
- 计划 §7 的 Sparkle + EdDSA 签名 appcast **未实现**，也没有 appcast 文件。
- Squirrel.Mac 要求更新包与当前 app 由同一团队签名，未签名构建下自动更新会失败；因此"自动更新可用"必须在签名流程落地后**真机验证**，目前没有任何验证记录。

## 10. 环境变量

完整清单与注释见 `distribution/macos/env.example`。要点：

- 文件里的**空值**（`LYAPUNOV_DESKTOP_DATA_DIR=` 这类）会被当作未设置并回落到平台默认（本次修复），但显式覆盖时请填真实值，不要留空占位。
- Finder/Dock 启动的 app **不继承 shell 环境**：`env.example` 里的变量对源码树运行有效（从终端启动），对打包的 `.app` 同样需要另有配置载体（计划 §7 的 `Info.plist`/`UserDefaults` 环境键尚未实现——打包器只写身份键，不写环境变量）。不要把"终端里能读到"当成"app 内能读到"。
- 变量名以 `packages/lyapunov-product-bundle/src/runtime-paths.ts` 的 `RUNTIME_ENV` 表为准；旧 `LYAUP_*` 只作显式兼容读取，SDK 解释器覆盖变量**没有**旧名。

## 11. 本次在代码层修复的 Linux 路径误用（审计结果）

| # | 位置 | 问题（macOS 下的后果） | 修复 |
| --- | --- | --- | --- |
| 1 | `packages/sim-mujoco/src/provider.ts` | `MUJOCO_GL: config.renderBackend ?? 'egl'` 把 Linux 后端写成默认值，且覆盖用户显式设置的 `MUJOCO_GL`（macOS 上 import mujoco 直接报不支持的 GL） | 改用 `resolveMuJoCoGlBackend()`：显式 > 继承 > 平台默认（darwin=cgl） |
| 2 | `packages/benchmark-libero/src/prepare.ts` | 同上（`process.env.MUJOCO_GL ?? 'egl'`） | 改用 `resolveMuJoCoGlBackend()` |
| 3 | `packages/benchmark-gymnasium/src/prepare.ts`、`src/adapter.ts` | 同上 | 改用 `resolveMuJoCoGlBackend()` |
| 4 | `packages/sim-contract/src/mujoco-gl.ts`（新增） | 平台默认值与后端校验没有单一实现 | 新增唯一实现：`MUJOCO_GL_BACKENDS`、`isMuJoCoGlBackend`、`resolveMuJoCoGlBackend` |
| 5 | `script/runtime-patch.ts` | `LYAPUNOV_MUJOCO_RENDER_BACKEND` 不做校验直接透传，拼错的后端只在 worker 里以难懂的报错出现 | 用 `isMuJoCoGlBackend` 校验并中文报错，注释写明各平台取值 |
| 6 | `packages/sim-isaac/src/provider.ts` | 无条件注入 Linux 的 `LD_LIBRARY_PATH`/`LD_PRELOAD`/`VK_ICD_FILENAMES`/`__NV_PRIME_RENDER_OFFLOAD`（macOS 用 dyld，且无该 ICD 路径） | 抽出 `isaacLoaderEnvironment()`，仅在 `platform === 'linux'` 时注入 |
| 7 | `script/architecture.ts` | `--software-rendering` 无条件注入 Mesa/X11 专用变量（`LIBGL_ALWAYS_SOFTWARE`、`GALLIUM_DRIVER`、`__GLX_VENDOR_LIBRARY_NAME`），macOS 上无效且误导排障 | 三个变量仅在 Linux 注入；`LYAPUNOV_MUJOCO_RENDER_BACKEND=glfw` 保留（Linux/macOS 都合法） |
| 8 | `packages/desktop/src/main.ts` | `resolve(readRuntimeEnv("desktopDataDir"))`：环境文件里的空值会让数据根变成当前工作目录（Finder 启动时是 `/`）；`simEngine`/`graspProvider` 同类空值也会传入 Host | 三处都 trim 后回落默认值（平台默认数据目录 / `none` / `analytic`）。现行代码：`desktopDataDir` 与 `graspProvider` 仍 trim 后回落默认；`main.ts` 已不读取 `simEngine`，引擎由 Host 侧 `resolveEngine()` 解析（见 §7） |

修复只改平台相关的**默认值与校验**，不改任何物理语义、不新增能力、不涉及登录与计费。

## 12. 已知缺口（记录）

- 体检：打包产物分发与 Linux 同一份 `distribution/linux/doctor.mjs` 与 `physics-check.js`（`script/package-linux.ts:384,404`）；`doctor.mjs` 有 Darwin 分支（默认检查 `mujoco`/`newton`、核 darwin arm64 Electron 与 Electron 版本，`doctor.mjs:21,48-56`），`install.sh` 的 Darwin 激活门也跑同一份 doctor（`install.sh:449`）。源码树侧只有启动器自带的 `lyapunov doctor`（前置检查）。
- 便携候选有 `.app` 与 `Info.plist`（打包器写身份键）；产品**未注册 `CFBundleURLTypes`**、未写 `LSMinimumSystemVersion`（最低系统由发布清单 `minimumMacOS: '15.0'` 约束，`script/package-linux.ts` 约 492 行）、无 appcast URL。
- 无 App Sandbox、无 Sparkle、无崩溃/日志目录策略（计划 §2/§7 未实现）。
- 无 macOS CI；有真机验证记录（见 §14），但打包链路（签名/公证/装订）未验证。
- 引擎缺口按平台属性分：Isaac（要 NVIDIA 驱动，macOS 无路径）如实报缺；LIBERO 基准环境在 Darwin 有安装路径（同版 CPU wheels，见 §7/§14）。

## 13. 发布验收计划与历史清单

下面保留原计划；源码运行、设置、导入、关节运动、相机、采集、录制、回放、导出与表面批注的本轮已执行结果见[历史交接日志（归档）](../../docs/receipts/MACOS_PORT_HANDOFF_20261031.md)（历史记录，不作当前验收）。当前已有 ad-hoc 本机便携候选；Developer ID、公证和正式发布仍未执行。

- [x] 本机源码树可启动；原 OAuth 会话恢复、工作台打开与重启保持已验证（新登录的历史实测见 §12）
- [ ] 删除数据根后重启：无残留账户/余额，可重新登录（对应计划 §8 的新档验收）
- [ ] 钥匙串不可用（或重建签名不匹配）时，界面显示"系统安全存储不可用"且**没有**明文会话落盘
- [ ] 切换 `LYAPUNOV_API_URL` 后旧会话被拒绝并要求重新登录
- [x] `MUJOCO_GL` 未设置时 macOS 默认 `cgl`；显式设置不被覆盖（当前代码与实际 MuJoCo 回归已验证）
- [ ] 签名 + 公证 + 装订 + `spctl` 通过（需要在有证书的机器上做）
- [ ] universal 二进制在真 Intel 与 Apple Silicon 上各跑一次（计划 §5）
- [ ] 自动更新在签名构建上真实验证（计划 §7）
- [ ] 在真 macOS 上演练一次运行根布局迁移与回退：先做升级前的只读备份，升级后确认 `scene/` 已搬进 `worlds/`/`cache/`/`catalog/`，再回退到只认旧 `scene/` 路径的检出并确认"不恢复运行根就看不到库"（§4「升级与回退」）

相关文档：[历史交接日志（归档）](../../docs/receipts/MACOS_PORT_HANDOFF_20261031.md)、[中文 README](../../README.zh-CN.md)、[运行模式](../../RUN_MODES.md)、[Linux 便携交付](../linux/README.md)。

## 14. 真 macOS 移植记录（macOS 26.5.1 arm64，Apple Silicon）

本节是第一次真机移植的登记（此前 §11 的修复未经真机验证）。

**代码修复（产品侧）**

- 终端剪贴板：`clipboard.ts` 新增 darwin 后端——文本走 `pbpaste`，图片走 `osascript`（`«class PNGf»`/`JPEG`/`GIFf` 到媒体类型的映射，WebP 不是标准 pasteboard 类不声明）；`plugin.ts` / `remote-terminal.ts` 补 `LYAPUNOV_CLIPBOARD_PBPASTE` / `LYAPUNOV_CLIPBOARD_OSASCRIPT` 工具覆盖透传（与其余后端同口径）。真机验证：文本往返、PNG 字节往返（sha256 一致）、无图误报负分支、kind 过滤。
- `script/env-self-link-guard.ts`：类 2 环诊断改用 **GNU find**（`gfind` 优先，PATH 上 `find` 需核过 GNU findutils）：macOS 自带 BSD `find -L` 对目录环**零诊断**（恒 0 会被误读成干净）。两边都拿不到 GNU find 时如实记无读数（-1），不冒充 0。
- `script/package-linux.ts`：平台闸门只拦真正的打包路径；`--check-source`（纯 git 出处自检）在任何平台可用。

**环境差异（判据作者环境是 Debian/Ubuntu + GNU 工具链）**

- Homebrew `proj` 自带 OSTN15 格网（`proj-data` 全量入包），而判据假定它缺失：新增 `packages/scene-kit/test/proj-missing-grid.fixture.ts`，用「逐项 symlink、剔除 OSTN15」的 `PROJ_DATA` 影子目录真实复现缺失（不跳测）。
- `cs2cs +init=epsg:` 在 PROJ ≥ 8 走 init 查表不做运算选择（`PROJ_DEBUG` 无 "Using coordinate operation"）；测试改用权威语法 `epsg:27700/epsg:4326`（EPSG:4326 权威轴序 lat,lon，测试里换回 lon,lat）。
- Bun 的 `fs.promises.rm`/`unlink` 异步封装存在性先检、非原子：并发下两个调用都能"删掉"同一份文件。测试夹具的请求认领改用 `rename`（与 C# `File.Move` 同形）。
- 测试夹具的 `mkdtemp` 路径一律先 `realpath`：macOS 的 `/var` 是 `/private/var` 符号链接，产品侧规范化后的路径与未解析夹具路径对不齐。

**依赖**

- `bun`（packageManager 与本机验收统一为 bun@1.4.2）、`pnpm 11.7.0`（上游 bootstrap 必需）、`proj`（brew，PROJ 9.9）、`findutils`（brew，提供 `gfind`）、Electron 43.5.1（`build:desktop` 已解析）、Blender MCP venv（bootstrap 已备）。

**历史验证（旧清单；0.2.1 移植过程见[历史交接日志（归档）](../../docs/receipts/MACOS_PORT_HANDOFF_20261031.md)）**

- `bun run test:ci`（清单驱动的离线 CI）：`include=253 ran=253 pass=253 fail=0`，45 项外部依赖（厂商模型/网络抓取/GPU/Unity/Blender/Isaac/本机凭据）按清单不跑。
- `bun run build:desktop` 通过；`sh distribution/macos/lyapunov doctor` 可跑。
- 剪贴板真机往返验证见上（文本 + PNG）。
- 桌面真机点击验证（Electron 43.5.1，本地模式）：8 个设置页、工作区选择、新建场景（rev 0）、WebGL 网格/GLB/gizmo、素材导入→画布落位（rev 1·5 实体）、真 zsh PTY、文件树、采集图像 716×585、对话缺凭据时结构化 `MISSING_CREDENTIAL`、MJCF 无包围盒时 `PROTOTYPE_BOUNDS_UNAVAILABLE` 拒铺——失败路径全部如实。

**引擎运行时装配（`sh distribution/macos/lyapunov install-provider <name>`，复用 Linux 脚本）**

- micromamba（osx-arm64，放 `.runtime/bin/micromamba`）+ conda-forge `python=3.12` + PyPI 轮子，macOS arm64 实测：
  - `mujoco` → `.runtime/sim-python`：mujoco 3.13.0 + mink/ompl/daqp/pyzmq + asset-bake 依赖，全部导入通过；设置页显示"已就绪 · 3.13.0"。
  - `newton` → `.runtime/newton-env`：newton 1.6.0 + warp-lang 1.17.0（本轮已按 requirements 对齐）；无 GPU 自动回落 CPU（`gpuAvailable:false`）。
  - `benchmark-gymnasium` → `.runtime/bench/gymnasium-env`：gymnasium 1.2.0 + mujoco 3.17.0。
  - `isaac`：按当前目标排除。`benchmark-libero`：Python 3.8.13 与同版 CPU wheels 已装，原 `check` READY、真实边界冒烟 exit 0，`taskAchieved=false`，不声明解题成功（来源：[历史交接日志（归档）](../../docs/receipts/MACOS_PORT_HANDOFF_20261031.md)）。
