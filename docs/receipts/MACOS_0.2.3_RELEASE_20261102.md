# macOS 0.2.3 发布回执（2026-11-02，新加坡时间）

状态：**已被 [2026-11-03 重建回执](MACOS_0.2.3_REBUILD_20261103.md) 取代**；当前 Mac 候选为 `0.2.3-macos-e17f03f259e9`。本回执的内容保留为历史记录：macOS 侧完成，已上传官网镜像并经真实 curl 安装复核。 本回执只描述下列提交与产物；原始日志、截图与帧采样保存在 Mac 本机 `.runtime/macos-native-acceptance-20261102T010731/`（不入库）。

## 源码与提交

执行合同：[Mac 0.2.3 原生验收执行合同](../MACOS_NATIVE_ACCEPTANCE_0.2.3.md)。起始 `1e755e37`，发布源码 `f34936ab0a7086b24a8870941e666c55c877f702`（main 已快进），本轮三个修复提交：

- `c14c23d2`：便携保存闭包按真实路径比较（软链别名回归用例）；ExitCoordinator 可擦除构造，测试子进程改用 strip-types（Node 26 已删除 `--experimental-transform-types`）；`package-linux.test` 的 `--human-cuda` 在 Darwin 断言按设计拒绝；人群原生测试在 Darwin 用平台默认 `MUJOCO_GL`。
- `01d72fde`：在途 `crowd_start` 计入退出确认的运行动作数。
- `f34936ab`：`inspectUsd` 把 USD 解析器回报的真实路径换算回调用方路径形式（修复 macOS `/var`、`/tmp` 等软链下 warehouse、SimReady、CAS 闭包与 USD 重写的误报）；macOS 便携入口经 `distribution/linux/desktop-launcher.mjs` 启动，SIGTERM/SIGINT 经父子 IPC 交给退出协调器。

GitHub Actions 均为 attempt 1 success：41334635149、41336353369、41339034429、41340360536、41359507911（f34936ab 分支）。

## 实测（macOS 26.5.1，Apple Silicon）

- 完整默认离线 CI 424/424；两套 tsc 0 错误；资产布局 53/53。`usd-native` 在系统默认 TMPDIR 与真实目录下均为 10 pass / 1 skip / 0 fail（跳过项需显式 OmniPBR SDK 模块）。
- 人群资源：0.2.2 固定发行包取得，catalog SHA256 `4ab91eda9cfdc91256e204609b99eef93be883499183109f384837934d23d393`，12 款身份全部校验通过。
- 源码实例：20 人创建、同步、行走（每人位移 ≥0.2 m）、停止（两个观察窗口漂移 0 m）、保存、冷启动恢复、再次行走；Cmd+Q、菜单退出、SIGTERM、SIGINT 退出码均为 0，无残留进程。20 人实时率约 0.43，Viewer 约 60 FPS。

## 发布资产与 curl 安装

`releases/0.2.3-macos-f34936ab0a70/`：`darwin-arm64.tsv`、`darwin-arm64.json`、`lyapunov-darwin-arm64-0.2.3-macos-f34936ab0a70.tar.gz`（1,013,948,949 字节，SHA256 `9606a47400d88512dad9fa6ba6f1bd6bd1d832641c7a7b65552949f1ff21497d`）。RELEASE.json 记录 `sourceCommitMatchesPayload:true`；签名为 ad-hoc，未公证，`spctl` 拒绝。

安装验证用本机 HTTP 镜像（安装器允许 localhost HTTP）执行 `curl -fsSL <镜像>/install.sh | sh -s -- --version 0.2.3-macos-f34936ab0a70`，安装到隔离前缀：退出码 0，用时 284 s，MuJoCo 原生物理检查通过；安装出的应用无 `com.apple.quarantine`，启动时无 Gatekeeper 拦截；用户真实安装位置与 `~/.config/lyapunov/` 前后未变。装好后：

- 20 人行走与停止、工程保存通过；行走中向启动器发 SIGTERM，无确认框，退出码 0，无残留。
- 冷启动恢复工程；`install-usd-parser` 后，`/tmp`（软链）下两 layer USD 经 `scene_import` 导入成功，闭包含两个文件；原生「打开」对话框可正常弹出并返回所选路径。界面「导入」按钮到导入完成的一次连续点击未单独走查。

## 官网安装复核

三个文件同时作为 GitHub 预发布 `v0.2.3-macos-f34936ab0a70`（指向 `f34936ab`）的资产供 Linux 侧取用。官网上传后核对：`install.sh` 与仓库版本字节一致；`releases/latest/darwin-arm64.tsv` 与版本清单一致；归档经 CDN 提供，长度 1,013,948,949 字节。

在原先没有任何 Lyapunov 安装的 Mac 上执行 `curl -fsSL https://vorynel.com/lyapunov/install.sh | sh`：退出码 0，用时 927 s，`latest` 解析为 `0.2.3-macos-f34936ab0a70`，归档 SHA 校验与 MuJoCo 物理检查通过。新建 `~/.local/share/lyapunov/`、`~/.local/bin/lyapunov`、`~/Applications/Lyapunov.app`，未写 `~/.config/lyapunov/engine.json`；无隔离属性，启动无 Gatekeeper 拦截。用安装出的启动器（验收数据目录单独指定）：doctor 通过；20 人行走与停止通过；行走中 SIGTERM 无确认框，退出码 0，无残留；Cmd+Q 退出码 0，无残留。

## 未完成与交给 Linux 侧

1. Linux 便携入口仍直接 exec Electron，收到 SIGTERM 时是否同样弹确认框未在 Linux 验证。
2. Linux 侧带 Isaac 的发布门、`build:linux`、安装与 doctor；发布门里 macOS 平台的冻结下限与豁免按本机读数另行登记。
3. 正式分发需要 Developer ID 签名与公证；Intel/universal 不在本版范围。
4. 正式/Guest 模式下 `LYAPUNOV_HUMAN_AVATAR_ROOT` 不传入 Host（`script/profile.ts` 白名单），源码桌面实例需把资源放在默认路径；便携包随包带资源不受影响。
5. Node 26 上无法运行 manifest 里以 `node --experimental-transform-types --test` 声明的 envgate 原生命令，本轮改用 Node 22 执行。
