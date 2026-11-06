# macOS 0.2.3 重建回执（2026-11-03，新加坡时间）

状态：**macOS 侧完成，待 Linux 侧验收与正式发布。** 本回执取代 [2026-11-02 回执](MACOS_0.2.3_RELEASE_20261102.md) 中的 Mac 候选 `0.2.3-macos-f34936ab0a70`，那个包早于 Linux 侧的 WSL2 与 strip-types 提交。原始日志、截图与帧采样保存在 Mac 本机 `.runtime/macos-rebuild-acceptance-20261103T090327/`（不入库）。

## 源码与登记

- 拉取 main `8e7aa707`（Linux 侧 19 个提交，`cbae184..8e7aa707`，CI 41544557824 success）。
- 首次 macOS 完整门 RED，判据 3 条：
  - floor-drift 6 条：Darwin 覆盖仍冻结在旧值，实测已与 Linux 下限相同。
  - `linux-user-installer`：新增的 WSL 用例在 macOS 按平台跳过，skip 38→39 未登记。
  - `scene-adapter-transform`：无 Isaac，跳过未登记豁免。
- `e17f03f2`（`fix(gate)`）按本机实测登记：
  - `DARWIN_CASE_FLOORS` 只保留三条平台差异：安装器 9/57/skip 39、`runtime-patch` 33/skip 1、`scene-adapter-transform` 0/0/skip 1（macOS 不提供 Isaac，Linux 冻结 7 不变）。
  - 其余 11 条覆盖删除，随 Linux 冻结值，均为上调或持平。
  - Darwin 基线 digest `b29dfe5bcbcf → 1af40f28095a`；Linux 覆盖与 digest 不变。
- `e17f03f2` 的 GitHub Actions 41559404329 success，已快进 main。

## 实测（macOS 26.5.1，Apple Silicon，Node 26.8.1，Bun 1.4.2）

- **完整发布门**：在干净的 `e17f03f2` 上 `VERDICT GREEN criteria=19 green=19`，91 条用例，dirty=0。离线 CI 425/425，skip 41 条全部已登记。
- **原生用例**：Node 26 `--experimental-strip-types`，Mac 上去掉 `MUJOCO_GL=osmesa`，用平台默认后端。
  - `human-crowd/native` 6/0/0。
  - `usd-native` 10/0/1，用系统默认 TMPDIR；跳过项需显式材质 SDK 模块。
  - sim-mujoco 的 frame-text、lidar-scan、camera-intrinsics、mirrored-collision、native-worldbody-only、scene-camera、action-window、collision-affine-frames 全部通过，无跳过。
- **源码实例人群资源**：仓库内 `packages/human-crowd/assets/rocketbox` 不存在，只设 `LYAPUNOV_HUMAN_AVATAR_ROOT`。guest 桌面列出 12 款 Rocketbox 角色，20 人创建成功，`639c42d` 的 Host 白名单在 macOS 生效。

## 发布资产

`releases/0.2.3-macos-e17f03f259e9/` 下三个文件：

- `darwin-arm64.tsv`（SHA256 `4d7ddaaf6d51f1f37e282d9d18aa47b2a3bf38ea72d29db04512b4f2f60927ee`）
- `darwin-arm64.json`（SHA256 `3a9687b9ce26874e9673db2c816cc97e4ad4d3e87df0121dd236728eb0935edc`）
- `lyapunov-darwin-arm64-0.2.3-macos-e17f03f259e9.tar.gz`：1,013,944,434 字节，SHA256 `a9915fe07da1a89e70c945ea0bcf5fff8bba691533aae3c5d08722fe9d6800ee`

`build:macos` 未设 `LYAPUNOV_PACKAGE_ALLOW_DIRTY`。RELEASE.json 记录：

- `version 0.2.3`、`platform darwin-arm64`、`minimumMacOS 15.0`
- `sourceCommit e17f03f259e96a08ce7aeee5f25f756f0f579c5f`，`sourceCommitMatchesPayload:true`
- 签名 ad-hoc，未公证，`spctl` 拒绝。

另外两点：

- `unitree_go2` 默认策略因许可缺失，打包时按设计拦下（`DEFAULT_POLICY_LICENSE_MISSING`）。
- 三个文件已作为 GitHub 预发布 `v0.2.3-macos-e17f03f259e9`（target `e17f03f2`）的资产提供给 Linux 侧。官网 `releases/latest/darwin-arm64.tsv` 目前仍指 `0.2.3-macos-f34936ab0a70`，需上传后替换。

## curl 隔离安装

用本机 HTTP 镜像执行 `curl … /install.sh | sh -s -- --version 0.2.3-macos-e17f03f259e9`，HOME 指向隔离目录。

- **前两次 exit 2**：`policy-cpu` 从 files.pythonhosted.org 分段下载 80,606,338 字节的 torch wheel，两次分别在约 1.5 MB 和 2.7 MB 处 `SEGMENT_FAILED`（timeout），报 `DEFAULT_POLICY_RUNTIME_FAILED`，旧版本保留。原因是本机到 PyPI CDN 的网络慢，不是本轮改动引入。
- **第三次 exit 0，用时 53 s**：先把同一 URL 的 wheel 放进版本目录的 `provider-download-cache`，安装器按固定字节数与 SHA256 校验后复用。
  - 安装器输出 `READY: 0.2.3-macos-e17f03f259e9`，physics-check 通过。
  - `doctor desktop` exit 0。
  - 安装出的应用只有 `com.apple.provenance`，没有隔离属性。
  - 默认位置的官网安装和 `~/.config/lyapunov` 前后未变。

## 包实例（隔离安装的启动器，独立数据目录）

- **人群**：20 人（4 种模板，revision 5），同步 MuJoCo 后 20/20 行走，每人位移 0.334–1.537 m；停止后两个观察窗口漂移 0/0。
- **退出方式**，每种退出码 0、无残留进程：
  - 行走中 Cmd+Q：确认框显示「有1项运行中的任务或动作」。
  - 菜单退出：正常确认框。
  - 对启动器发 SIGTERM：无确认框。
  - 对启动器发 SIGINT：无确认框。
- **冷启动恢复**：
  - 20 人工程经 `scene_save` 保存，48,897,902 字节。
  - 同步后 20/20 行走，位移 0.475–1.484 m；行走中对启动器发 SIGTERM：无确认框，exit 0，约 2 s 退完，无残留。
  - 冷启动后 `scene_open` 恢复为同一 sceneId、20 人、4 种模板、revision 5；同步后绑定新 World，实体处于停止态，两个观察窗口漂移 0/0。
  - 菜单退出 exit 0，无残留。
- **USD**：`install-usd-parser` 后 `USD_RUNTIME_READY (0,26,5)`；从 `/tmp`（软链）下的两层 USD 导入成功，闭包含 root 与 child。

## 未运行与交给 Linux 侧

1. 本轮保存与打开走的是 `scene_save`/`scene_open` 命令通道，也就是「打开与保存工程」按钮调用的同一命令。界面按钮本轮没有重新点过：自动化停在人群面板，没有展开场景面板里的「打开场景」。界面代码自 `f34936ab` 起未改。
2. 默认策略 CPU 运行时从 PyPI CDN 下载 torch，网络慢时首次安装会以 `DEFAULT_POLICY_RUNTIME_FAILED` 失败，需要重跑续传。这一行为不是本轮改动引入，是否需要调整超时或提供镜像由 Linux 侧决定。
3. 关于同一提交构建：
   - Mac 包源码是 `e17f03f2`，本回执所在的文档提交在其后。
   - Linux 侧如无代码改动，应从 `e17f03f2` 构建 Linux 包，两个包的 `sourceCommit` 才会一致。
   - 如有代码改动，需在 Mac 上从最终提交重建。
4. Linux 侧的带 Isaac 发布门、`build:linux`、安装与 doctor，以及正式 `v0.2.3` release 与官网 latest 更新，由 Linux 侧完成。
5. 正式分发需要 Developer ID 签名与公证；Intel/universal 不在本版范围。
