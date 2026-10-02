# macOS 最小配置（说明与模板）

本目录是 macOS 正式发布所需的**最小配置与说明**，不是发行包，也不代表任何东西已经被构建、签名或公证。

> **当前状态（请勿误读）**
>
> - 本仓库**没有任何 macOS 构建产物**：没有 `.app`、`.dmg`、`.zip`，没有 universal 二进制，没有 `Info.plist`。
> - 本仓库**没有 macOS 打包器**：`script/package-linux.ts:16` 显式拒绝非 Linux 平台，`distribution/linux/` 只属于 Linux 便携包。
> - 本仓库**没有任何 Apple 签名材料**：没有 Developer ID 证书、Team ID、公证用的 App 专用密码或 `notarytool` keychain profile，也不应该把这些放进仓库。
> - `docs/macos-adaptation-plan.md` 首行自述 "plan only"，其中的 SwiftUI + `WKWebView` 原生客户端、Sparkle appcast、App Sandbox 都**未实现**；当前真实的客户端是 Electron 43.5.1 + Chromium 渲染本地页面，见 §3。
> - 本仓库的验证记录全部来自 Linux。以下所有命令都在本机（Linux 开发机）**未执行**，标注为模板的地方不会被包装成"已验证"。

---

## 1. 现状：macOS 上唯一能跑起来的入口

macOS 上今天只有一条真实路径：**源码树 + Electron 直接运行**。

```sh
# 前置：Node.js >= 24（package.json engines）、Bun 1.3.13（packageManager）、Xcode Command Line Tools
node script/bootstrap.mjs          # 或 bun install，安装 node_modules（含 packages/desktop 的 electron 43.5.1）
bun run build:plugins              # 重建 packages/*/dist/plugin.js
bun run build:desktop              # 生成 packages/desktop/dist/main.js、preload.cjs、renderer/account.js
bun run dev:desktop                # = node script/desktop.ts --mode formal
```

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
| 计划要求 | `docs/macos-adaptation-plan.md` §5：v1 发布 universal 二进制（arm64 + x86_64），在 Apple Silicon 上构建并交叉编译 Intel 切片，或在真 Intel 硬件上至少验证一次 |
| 实际产物 | **不存在**。没有打包器，也就没有 `lipo` 合并步骤、没有 `ARCHS`/`ONLY_ACTIVE_ARCH` 设置 |
| 源码树运行 | Electron 由 `packages/desktop` 的 npm 依赖安装，架构跟随当前机器：Apple Silicon 装 arm64，Intel 装 x64。两者各自只跑本机架构的切片 |
| Rosetta 2 | 只有在 Apple Silicon 上运行 x64 切片时才会用到；本项目没有 x64 切片可供测试，也没有跨架构验证记录 |
| 未来打包 | 需要先引入打包器（例如 electron-builder / `@electron/universal`），在**签名之前**完成合并；本仓库没有这一步，也没有做过 |

未来打包器的最小骨架（**模板，未执行**，且依赖尚未加入 `package.json`）：

```sh
# bun add -d electron-builder        # 本仓库当前没有这个依赖，属于新增决策，不在本目录范围内
# bunx electron-builder --mac --universal --arm64 --x64 --publish never
```

纯 JS 依赖（electron-store / electron-window-state / electron-updater）不含原生模块，universal 合并的主要风险来自嵌套的 Electron Helper 与框架二进制；`@electron/universal` 默认处理这些，但**合并结果必须真机验证**，不能只看命令退出码。

## 3. 窗口技术栈：不是 WKWebView

`docs/macos-adaptation-plan.md` §1 规划的是 SwiftUI `WindowGroup` + `WKWebView`。当前实现**完全是另一条技术栈**：

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

macOS 现在没有发行包，所以这里没有 Linux 便携包那套 `tar` 原地替换。但**产生回退边界的那段代码与平台无关**，macOS 走的是同一条，所以同一句边界必须写在这里（Linux 侧同口径见 `distribution/linux/README.md` 的「升级与回退」）：

- **迁移是移动语义。** Host 每次启动都会走 `script/host.ts:45` → `script/profile.ts:248` → `script/migrate-workspace-layout.ts`，把旧单根 `scene/{scenes,assets,resources}` 用 `rename` 搬进 `worlds/`、`cache/`、`catalog/`（`migrate-workspace-layout.ts:87,108`）：不复制、不留原件，`scene/` 清空后连空目录一起删掉。这条链没有任何 `process.platform` 判定，macOS 的 `node script/desktop.ts --mode formal`（§1）与 Linux 便携包同源；桌面传入的运行根就在数据根之下（`packages/desktop/src/main.ts:77`），即源码树运行的 `<仓库根>/.runtime/desktop/<mode>/runtime`。
- **回退到只认旧 `scene/` 路径的版本前，应先用升级前的只读备份恢复运行根。** 这不是理论风险，而且**出厂上一版就是这种版本**：旧构建里 `ResourceLibrary` 把索引写死成 `<运行根>/scene/resources/index.json`（`scene-kit` 打包件），读不到就返回空库、不报错——本机直接读旧归档 `lyapunov-dsh-0.1.0-linux-x64.tar.gz.bak-20260917` 核对过，它的 `runtime-paths` 里根本没有 `catalog`。同一判据在当前源码是 `packages/scene-kit/src/resources.ts:537-542`。所以旧版本会**正常启动、退出码 0**，只是资产库是空的——升级后的索引在 `catalog/`，它不会去那里找。**产品自己不生成任何备份，也没有 `backup` 子命令**，升级前的只读副本是唯一能回到旧布局的东西——**而且时机只有"第一次用新版本启动之前"这一次**：迁移就发生在启动里，报告只打印在启动输出、不落盘，事后补做不了。所以换检出（将来是换 `.app`）之前，先把运行根整份复制到**仓库之外**（源码树运行即 `<仓库根>/.runtime/desktop/<mode>/runtime`，§4；例如 `cp -a <运行根> ~/lyaup-backup-<日期>`），回退时先用这份副本恢复运行根、再换客户端代码。Linux 侧同一条边界的可执行流程见 `distribution/linux/README.md` 的「升级与回退」。
- **迁移只搬不改的说法要限定范围。** 2026-09-26 候选的本机 Linux 读数确实是"移动 2、合并 0、冲突 0、改写引用 0"（`bugfixHistory/RELEASE-UPGRADE-20260926.md` §5），但迁移代码里保留了「改写 JSON 中指向旧路径的绝对字符串引用」这一步（`rewriteJsonReferences`）：引用命中的运行根**会在原地被改写字节**，且本仓库没有任何 macOS 上的迁移读数。所以更不该指望事后把旧布局拼回来。
- **回退客户端代码不会回退数据。** 运行根挂在数据根下（§4），而数据根两种形态都不是"跟着客户端一起回退"的东西：源码树运行是 `<仓库根>/.runtime/desktop/<mode>/runtime`——`git checkout` 回旧提交不会动它（`.runtime/` 是忽略目录），但 `git clean -xdf` 会连它一起删；打包后是 `~/Library/Application Support/…/runtime`，换掉 `.app` 更不会碰它。两种情况都要先按上一条恢复运行根。
- **同一机器只保留一个安装目录。** 源码树运行时运行根随检出走（两个检出＝两个运行根），这一条现在不适用；将来真的有了 `.app`，同一台机器上的所有副本共用 `~/Library/Application Support/LyapunovDSH` 这一个数据根（§4），届时 Linux「同一机器只保留一个安装目录」那条规则同样适用。
- **本机是 Linux，以上 macOS 行为一律未执行、未验证**（§13），它们是待验收项，不是读数。

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

**与计划文档不一致，必须知道**：`docs/macos-adaptation-plan.md` §9 描述 `/start` 会下发 httpOnly `SameSite=Lax` 的 flow cookie，且 `/callback`、`/complete`、`/exchange` 都要求携带该 cookie。**代码里没有这套 cookie**，绑定靠上面四条。正式发布前需要做一个明确决定（以代码为准并把计划文档改掉，或补齐 cookie 并做真实验收），**不要在文档或验收材料里假装 cookie 存在**。

### redirect_uri（macOS 上最容易配错的一项）

- 默认值是占位符 `lya://auth/callback`（服务端 `config.ts`，归 LyapunovOM），通过 `LYAPUNOV_IDENTITY_REDIRECT_URI` 覆盖。
- macOS 的自定义 scheme 需要在 `.app` 的 `Info.plist` 里注册 `CFBundleURLTypes`——**本仓库没有 `.app`、没有 `Info.plist`**，因此源码树运行时 `lya://` 无法被系统路由到应用。
- 现状下唯一可行的 macOS 路径：把 `redirect_uri` 配成**服务端 HTTPS 回调**（例如已部署的 `https://vorynel.tech/v1/auth/website/callback`，见 `deployment/README.md`），浏览器跳回服务端、服务端记录 code，桌面只轮询 `/complete`。这条路不依赖任何客户端 scheme。
- 若将来真的用自定义 scheme，计划 §9 的强制防御（回调本身不足以登录、state 绑定在途流程、陌生回调直接丢弃、state/code 不落盘/不进日志）必须逐条实现并验收；现在**没有**这些客户端侧实现，因为客户端根本不接收回调。

### 不引入第二套登录（核对结果）

- 桌面正式窗口只读 `LYAPUNOV_API_URL`、`LYAPUNOV_DESKTOP_DATA_DIR`、`LYAPUNOV_SIM_ENGINE`、`LYAPUNOV_GRASP_PROVIDER`、`LYAPUNOV_UPDATE_URL`，**不读 `LYAPUNOV_ACCOUNT_TOKEN`**（`main.ts` 全文核对）。
- `LYAPUNOV_ACCOUNT_TOKEN` 只被 Host 侧入口读取（`script/launch.ts`、`script/benchmark.ts`、`script/terminal.ts`），用于这些非 GUI 入口的既有会话校验，不是桌面登录方式。
- 本目录的 `env.example` 因此把 `LYAPUNOV_ACCOUNT_TOKEN` 明确注释掉，并说明它不属于桌面正式发布配置。

## 6. API URL 规则

- 正式默认：`https://vorynel.com/lyaup-api`（`packages/lyapunov-product-bundle/src/account/url.ts:2`）。
- 覆盖：`LYAPUNOV_API_URL`（旧名 `LYAUP_API_URL` 仅作显式兼容读取）；空值会被 trim 后回落到默认值。
- 除 localhost/127.0.0.1 外**必须 https**，否则 `normalizeAccountApiUrl` 抛错（`account/client.ts:162-166`）。
- 会话与地址绑定：见 §4 最后一条，改地址要重新登录。
- 正式 Profile 的模型行也由该地址派生（`baseURL = <apiUrl>/v1`，`formal.ts:21-23`）；客户端不保存上游模型名、URL 或 API key。

## 7. 可选依赖：MuJoCo 与 Isaac

桌面默认 `LYAPUNOV_SIM_ENGINE` 为空 → 引擎 `none`，不启动任何仿真 worker。启用是可选的，且都要求使用者自备解释器。

### MuJoCo（可选，macOS 可运行，前提是自备 Python 环境）

- 解释器解析只有两条规则（`packages/lyapunov-product-bundle/src/sdk-python.mjs`）：`LYAPUNOV_MUJOCO_PYTHON` 非空则直接使用；否则用包内落点 `<产品根>/.runtime/sim-python/bin/python`。
- macOS 上**没有包内安装器**：`distribution/linux/install-provider` 属于 Linux 便携包，依赖包内 `runtime/micromamba/micromamba`（源码树里不存在），不要当成 macOS 安装入口。请自行准备含 `mujoco` 的环境并用 `LYAPUNOV_MUJOCO_PYTHON` 指向它。
- 渲染后端（本次修复的核心项）：`MUJOCO_GL` 现在按平台解析——显式配置（`LYAPUNOV_MUJOCO_RENDER_BACKEND`）> 继承的 `MUJOCO_GL` > 平台默认（**macOS `cgl`**、Windows `wgl`、其它 `egl`）。MuJoCo 文档化的取值全集是 `egl/osmesa/glfw/cgl/wgl`，校验实现在 `packages/sim-contract/src/mujoco-gl.ts`。macOS 用户显式设置 `MUJOCO_GL=cgl`（或 `glfw`）不会再被覆盖。
- 抓取：默认 `analytic`（纯 MuJoCo，无需学习模型）；`graspgenx`/`anygrasp` 需要各自环境，包内约定路径是 Linux 便携包的 `.runtime/conda/envs/...`，macOS 上没有对应安装器。

### Isaac（macOS 不适用）

- Isaac 适配器的加载器注入（`LD_LIBRARY_PATH`、`LD_PRELOAD=libstdc++.so.6`、`VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/nvidia_icd.json`、`__NV_PRIME_RENDER_OFFLOAD`）**全部是 Linux 专用概念**；本次已改为只在 `process.platform === 'linux'` 时注入（`packages/sim-isaac/src/provider.ts:15-24`），macOS/Windows 上不再把 Linux 路径写进子进程环境。
- NVIDIA 不提供 macOS 版本的 Isaac Sim（macOS 也没有可用的 RTX 驱动栈），本仓库同样没有 macOS 的安装或适配路径，`LYAPUNOV_ISAAC_PYTHON` 的包内默认落点也是 Linux 便携包布局。
- 结论：**macOS 上不要配置 `--engine isaac`**；Isaac 的发布范围是 Linux（Windows 亦未在本仓库适配）。这不是"待办"，是本仓库有意不承诺的能力边界。
- 其它可选 Provider（SAM3、benchmark-libero/gymnasium、AnyGrasp、GraspGenX）同理：包内落点与环境安装在 macOS 上均不存在安装器。

## 8. 签名与公证命令模板（**全部未执行**）

以下命令是未来打包流水线的最小骨架。**本仓库从未执行过其中任何一条**，占位符 `<团队名>`、`<TEAMID>`、`<profile>` 必须由发布负责人从 CI 钥匙串/环境提供，**绝不写入仓库或应用包**。

```sh
# 0) 前置（人工）：Apple Developer Program 会员 + Developer ID Application 证书；
#    公证凭据存 CI keychain profile（xcrun notarytool store-credentials），不进仓库。
# 1) 先构建并（如做 universal）合并 arm64+x86_64 —— 合并必须在签名之前完成。
#    本仓库没有打包器，这一步是缺口，不是"已在跑"的流程。
# 2) 硬化运行时签名：从内到外（Electron Framework → Helpers → 主可执行文件），
#    不要用已废弃的 --deep 做签名；允许 JIT 的说明见 entitlements.plist。
codesign --force --options runtime --timestamp \
  --entitlements distribution/macos/entitlements.plist \
  --sign "Developer ID Application: <团队名> (<TEAMID>)" \
  "dist/mac-universal/LyapunovDSH.app/Contents/MacOS/LyapunovDSH"
# 3) 打容器（dmg/zip）后，容器本身要再签一次；zip 用 ditto 保持签名完好：
#    ditto -c -k --sequesterRsrc --keepParent LyapunovDSH.app LyapunovDSH.zip
# 4) 公证（--wait 会阻塞到出结果；失败时用 notarytool log <id> --keychain-profile <profile> 取日志）
xcrun notarytool submit LyapunovDSH.zip --keychain-profile "<profile>" --wait
# 5) 装订与验证
xcrun stapler staple LyapunovDSH.zip
xcrun stapler validate LyapunovDSH.zip
codesign --verify --strict --deep --verbose=2 LyapunovDSH.app   # 验证可用 --deep；签名不要用
spctl --assess --type execute -vv LyapunovDSH.app
```

要点：

- 公证**要求**硬化运行时；`spctl` 在装订成功后才会返回 `accepted`。
- 计划 §4 写着"v1 避免 `allow-jit`"，那是针对纯 `WKWebView` 客户端。现有客户端是 Electron，内嵌 V8 需要 JIT；因此本目录的 `entitlements.plist` 模板包含 `com.apple.security.cs.allow-jit`，并注明原因。若将来真的改成 WKWebView 原生客户端，应按计划 §4 重新收紧授权表。
- 计划 §4 建议的 App Sandbox 与 `com.apple.security.files.user-selected.read-write` 都**尚未启用**：源码树运行没有沙箱，导出路径也不经过保存面板。正式发布前需要单独决策并真实验收。

## 9. 更新（现状）

- 更新走 `electron-updater` 的 generic feed：只有 `app.isPackaged` 且设置了 `LYAPUNOV_UPDATE_URL` 时可用（`main.ts:117-121`）；源码树运行永远返回"本机构建未配置更新源"。
- 计划 §7 的 Sparkle + EdDSA 签名 appcast **未实现**，也没有 appcast 文件。
- Squirrel.Mac 要求更新包与当前 app 由同一团队签名，未签名构建下自动更新会失败；因此"自动更新可用"必须在签名流程落地后**真机验证**，目前没有任何验证记录。

## 10. 环境变量

完整清单与注释见 `distribution/macos/env.example`。要点：

- 文件里的**空值**（`LYAPUNOV_DESKTOP_DATA_DIR=` 这类）会被当作未设置并回落到平台默认（本次修复），但显式覆盖时请填真实值，不要留空占位。
- Finder/Dock 启动的 app **不继承 shell 环境**：`env.example` 里的变量对源码树运行有效（从终端启动），对将来的 `.app` 需要另有配置载体（计划 §7 的 `Info.plist`/`UserDefaults` 尚未实现）。不要把"终端里能读到"当成"app 内能读到"。
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
| 8 | `packages/desktop/src/main.ts` | `resolve(readRuntimeEnv("desktopDataDir"))`：环境文件里的空值会让数据根变成当前工作目录（Finder 启动时是 `/`）；`simEngine`/`graspProvider` 同类空值也会传入 Host | 三处都 trim 后回落默认值（平台默认数据目录 / `none` / `analytic`） |

修复只改平台相关的**默认值与校验**，不改任何物理语义、不新增能力、不涉及登录与计费。

## 12. 已知缺口（记录，不在本次修复范围）

- 终端剪贴板：`packages/lyapunov-terminal/src/clipboard.ts` 只实现 Linux 的 `wl-paste`/`xclip`/`xsel`，macOS 无实现。
- 安装器/体检：`install-provider`、`doctor`、`physics-check` 只有 Linux 便携包版本，macOS 无对应入口。
- 无 `.app`、无 `Info.plist`（因此无 `CFBundleURLTypes`、无 `LSMinimumSystemVersion`、无 appcast URL）。
- 无 App Sandbox、无 Sparkle、无崩溃/日志目录策略（计划 §2/§7 未实现）。
- 无 macOS CI，无真机验证记录；本机为 Linux，**无法验证任何 macOS 行为**。

## 13. 验收清单（计划；全部未执行）

- [ ] 在真 macOS 上完成 §1 的源码树启动，登录走系统浏览器，工作台可打开
- [ ] 删除数据根后重启：无残留账户/余额，可重新登录（对应计划 §8 的新档验收）
- [ ] 钥匙串不可用（或重建签名不匹配）时，界面显示"系统安全存储不可用"且**没有**明文会话落盘
- [ ] 切换 `LYAPUNOV_API_URL` 后旧会话被拒绝并要求重新登录
- [ ] `MUJOCO_GL` 未设置时 macOS 默认 `cgl`；显式设置不被覆盖
- [ ] 签名 + 公证 + 装订 + `spctl` 通过（需要在有证书的机器上做）
- [ ] universal 二进制在真 Intel 与 Apple Silicon 上各跑一次（计划 §5）
- [ ] 自动更新在签名构建上真实验证（计划 §7）
- [ ] 在真 macOS 上演练一次运行根布局迁移与回退：先做升级前的只读备份，升级后确认 `scene/` 已搬进 `worlds/`/`cache/`/`catalog/`，再回退到只认旧 `scene/` 路径的检出并确认"不恢复运行根就看不到库"（§4「升级与回退」）

相关文档：`docs/macos-adaptation-plan.md`（计划）、`deployment/README.md`（服务端部署，含回调地址）、`distribution/linux/README.md`（Linux 便携交付，可对照）。
