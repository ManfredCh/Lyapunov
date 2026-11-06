# Mac 端完整执行合同：0.2.3 构建、人群与退出恢复验收

> 交给真 Mac 上的开发助手直接执行。用户已要求一次走完这份合同，保留现有修改；常规同步、依赖准备、构建、测试及范围内修复不再逐步询问。只有真实缺少凭据、系统授权、必需输入或超出下述范围时，才集中报告最小阻断。

## 1. 目标、环境与完成条件

使用现有目录 `/Users/apple/WS/LyapunovDev` 和远端 `https://github.com/ManfredCh/LyapunovDev.git`。用户提供的快照为 `main...origin/main`、工作树干净；执行时重新核对。继续使用这个目录，不默认新建工作树，不维护或推送准备归档的 `LyapunovMac` 仓库，暂不操作 `LyapunovWin`。

产品功能基线是 `593053769d39b82453101b86d4ba7c1b9bbb23f7`，包含 `4b66913a` 的三个 CI 测试修复和 `59305376` 的四文件退出修复。本文本身会是该功能基线之后的文档提交；拉取主线后记录实际 HEAD，并确认上述功能基线是其祖先。

已有的远程证据：[Dev main CI](https://github.com/ManfredCh/LyapunovDev/actions/runs/41324466522) 与 [归档前 Mac 仓库同版 CI](https://github.com/ManfredCh/LyapunovMac/actions/runs/41325930086) 均成功。它们是通用 Linux runner 的结果，不能代替本次真 Mac 验收。

本次完成必须同时具备：

1. 真 Darwin arm64 上同步、依赖准备、构建、类型检查、完整默认离线 CI 和资产布局门的实际回执。
2. 固定 12 款 Rocketbox 资源完整且通过身份校验；界面能创建并同步 20 人。
3. 20 人实际行走、停止、保存、整应用退出、冷启动恢复、再次行走和停止通过。
4. `Cmd+Q`、菜单退出、启动器收到 `SIGTERM` / `SIGINT` 的保存、停止和进程清理通过。
5. 从验收版本生成 Mac 便携候选，在另一目录解包后重新验证运行与恢复，并交付报告。

Developer ID、公证、官网发布、自动更新和 Intel 移植不属于本轮完成条件。无签名材料时可以完成如实标为本机 ad-hoc、未公证的候选；不能称为正式签名发行。

## 2. 执行边界与必读资料

依次完整阅读 [仓库入口](../AGENTS.md)、[原则入口](../principles/README.md)、[产品原则](../principles/PRODUCT.md)、[开发原则](../principles/DEVELOPMENT.md)、[美学原则](../principles/AESTHETICS.md)、[交互原则](../principles/INTERACTION.md)，再读 [开发标准](DEVELOPMENT_STANDARDS.md)、[Mac 说明](../distribution/macos/README.md)、[0.2.3 说明](releases/0.2.3.md)。历史回执保留当时身份，不作为本轮通过证明。

- 允许：在本项目内安装固定开发依赖，准备独立运行环境和资源缓存，构建与验收；修复本次实际发现的 Darwin 启动、资源路径、人群、退出恢复及相关测试问题。
- 保留：所有既有修改、工程、账户、场景、SDK 选择及运行目录。不使用 `reset --hard`、`git clean`、无授权的 stash、强推或整目录覆盖。不自动关闭已有用户工作实例；验收启动的实例由执行者负责退出。
- 原始日志、截图、视频、帧流、资源与 SDK 放 `.runtime` 或项目外；**人群资源、`.runtime`、依赖目录、账户数据均不进提交**。只提交本轮必要的源码、测试与简明文档，使用明确文件白名单。
- Hugging Face 相关调用只使用 `HF_ENDPOINT=https://hf-mirror.com`。镜像缺件、revision、权限或校验失败时具名阻断，不回退官方 Hub，不擅自替换模型或素材。
- 不改变物理参数、减少人数、放宽行为断言或添加 skip 来制造通过；记录实际 FPS / RTF，不把“功能可用”改称“20 人实时性能合格”。
- 本文件供 Mac 端主控直接执行，不要求另开对话或额外代理。确实使用外部执行器时，遵守当前用户的完整 plan、回执和主控独立 CI 合同，先检查该机器实际安装入口与帮助。

## 3. 在现有目录同步并冻结本轮输入

```sh
cd /Users/apple/WS/LyapunovDev
git status --short --branch
git remote -v
git rev-parse HEAD
git fetch origin main
git merge --ff-only origin/main
git merge-base --is-ancestor 593053769d39b82453101b86d4ba7c1b9bbb23f7 HEAD
```

发现未提交修改时先记录文件与 diff，保留不相关工作。快进会覆盖修改、分支分叉或远端来源不同，则停止同步并报告准确路径、分支和提交；不能用强制覆盖解决。新增的其他主线改动要阅读后纳入验收，不无声切回旧代码。

建立本轮证据目录，例如 `.runtime/macos-native-acceptance-YYYYMMDDTHHMMSS`，后文以绝对路径变量 `MAC_ACCEPT_OUT` 表示。记录新加坡时间、HEAD、分支、初始状态、版本与 `UPSTREAM_LOCK.json`。所有命令保存 argv、cwd、退出码和日志；需要 tee 时正确捕获原命令退出码。

```sh
uname -m
sw_vers -productVersion
node --version
bun --version
pnpm --version
xcode-select -p
```

按实际源码读取 pin：当前为 Node >=24、Bun 1.4.2、pnpm 11.7.0。现有打包入口只支持 Darwin arm64；若机器是 Intel，明确列为本轮打包阻断，不擅自扩项做 Intel / universal。缺少 Xcode Command Line Tools、系统授权或交互登录时只请求该项必要操作。

## 4. 依赖与 Mac 原生引擎

优先复用符合 pin 的本机环境，不复制 Linux `.runtime` / `node_modules`。按当前源码执行：

```sh
export HF_ENDPOINT=https://hf-mirror.com
export DSH_TELEMETRY_DISABLED=1
node script/bootstrap.mjs
bun run build:plugins
bun run build:desktop
```

上游必须等于 `UPSTREAM_LOCK.json` 的 commit；现有上游不符或依赖链接指向别的可变工作树时，保全原目录，按 bootstrap 的具名诊断处理，不删除用户数据或换底座。Blender、Unity 等基本供给按已有脚本准备，失败如实记录；不安装与本次无关的引擎。

本次物理验收以 MuJoCo CPU 为必需路径。读取当前 SDK 配置与 `LYAPUNOV_MUJOCO_PYTHON`，实际执行解释器核对版本、架构和 `import mujoco`，固定为本仓要求的 MuJoCo 3.13.0。保留用户显式 SDK 选择；需要补齐时复用原安装入口：

```sh
sh distribution/macos/lyapunov install-provider mujoco
```

该入口复用 `distribution/linux/install-provider`，开发检出需要 `.runtime/bin/micromamba` 或显式 `LYAPUNOV_MICROMAMBA`。缺件时按启动器给出的 osx-arm64 安装方式准备本项目工具；不要改系统 Python 或无关 Conda 环境。

检查 PROJ 五个 CLI（`proj`、`projinfo`、`cct`、`cs2cs`、`geod`）和 GNU `gfind`；缺少时可用已有 Homebrew 正常安装 `proj`、`findutils`，记录实际版本。CI Python 至少具备 PyYAML、NumPy、Pillow、MuJoCo 3.13.0、OpenUSD 26.5 所需模块；按现有 SDK 和 `.github/workflows/ci.yml` 准备独立解释器并导出 `TESTCI_PYTHON`、`LYAPUNOV_MUJOCO_PYTHON`、`LYAPUNOV_USD_PYTHON` 的准确路径。

Mac 生产端默认后端由 `packages/sim-contract/src/mujoco-gl.ts` 选择 `cgl`；使用原生默认或用户明确设置的有效后端。验收子进程不要继承 Linux 的 `MUJOCO_GL=osmesa` / `egl` 或 `PYOPENGL_PLATFORM=osmesa`，也不要把这些值写入用户全局配置。

**已知需现场核对的测试问题：**功能基线的 `packages/human-crowd/test/native.test.ts` 首项子进程写死了 `MUJOCO_GL:'osmesa'`。如果它在 Darwin 失败，允许窄修为复用现有跨平台解析或正确继承，不改变断言、不跳过这项；重跑相关回归和完整默认 CI。`script/computer-use-linux.ts` 本身只支持 Linux x64，不在 Mac 上照抄该安装步骤；Darwin 使用已有原生 CUA 路线，不伪装平台。

## 5. 人群资源：先校验，缺少时独立取得

Git 拉取不会带上 GLB。先检查本机已有资源、已下载发行包和项目缓存；不要重复下载正确字节，也不要覆盖身份不同的用户资产。运行时可用 `LYAPUNOV_HUMAN_AVATAR_ROOT` 指向 `.runtime` 内的完整 `rocketbox` 目录，避免把生成资源放进源码提交范围。

本轮 Linux 已验证的资源身份：

| 对象 | 固定身份 |
| --- | --- |
| 来源 | `microsoft/Microsoft-Rocketbox@0943055db6ec570bcef9f2c8b41c9e5467c808f9`，MIT |
| 角色集合 | `packages/human-crowd/src/rocketbox-sample.ts` 的固定 12 款 |
| `catalog.json` SHA-256 | `4ab91eda9cfdc91256e204609b99eef93be883499183109f384837934d23d393` |
| 12 个最终 GLB 总字节数 | `314704604`；另有预览、许可和校准元数据 |
| 许可 SHA-256 | `17474e386e0b9e1a700cc3d06b2b0882a2c376d9c6b49c7f8274409b8f8d2352` |

逐项调用 `loadRocketboxCatalog` / `verifiedRocketboxAvatar`，并校验预览 PNG 的 size、SHA-256、Git blob、校准与来源记录。不能用程序人、单款角色或无许可素材替代“12 款资源已齐”。

### 缺少本地资源时的固定发行包路线

以下官网元数据已于 2026-11-02 核对；本合同编写时没有重新下载这份大归档。**Mac 执行者必须实际下载或复用缓存并核验整包后，才能使用其中资源。**

- [固定版本清单](https://vorynel.com/lyapunov/releases/0.2.2-20261030/linux-x64.tsv)
- [固定版本归档](https://vorynel.com/lyapunov/releases/0.2.2-20261030/lyapunov-linux-x64-0.2.2-20261030.tar.gz)
- 归档大小：`1052456167` 字节。
- 归档 SHA-256：`545c3b584c7c75416762a4c6f383a14910927da4cdd8482c2fd447e2ded5f4cd`。
- 归档根：`lyapunov-dsh-0.2.2-linux-x64`；来源提交：`690a844bae5576f839dae6e74f6301814d1182d5`。

在本轮缓存目录下载，显示进度并支持同一文件续传，例如：

```sh
curl --fail --location --retry 3 --continue-at - --progress-bar \
  --output "$MAC_ACCEPT_OUT/reference-0.2.2.tar.gz.part" \
  https://vorynel.com/lyapunov/releases/0.2.2-20261030/lyapunov-linux-x64-0.2.2-20261030.tar.gz
```

实际断言大小和 SHA 一致后再将 `.part` 改名为已验证归档，保存清单。只提取 `lyapunov-dsh-0.2.2-linux-x64/packages/human-crowd/assets/rocketbox` 和有需要的 `packs` 数据供给到本轮缓存，不运行其中 Linux Node、Electron、SDK 或安装器。然后核对上表 catalog 身份。任何来源、大小、SHA 或成员缺失，点名对象阻断，不无声改版本或改造人物。0.2.2 只提供已经冻结的平台无关资源，运行的产品源码仍是 Dev 0.2.3。

### 将已验证的运行资源转换为打包供给视图

`script/human-avatar-resources.ts` 的输入是带 `manifest.json` 和官方预览 gallery 的冻结供给，不能把仅有 catalog 的目录直接当它的输入。下面的准备片段不改 GLB；在项目 `.runtime` 创建独立供给视图。先设置 `LYAPUNOV_HUMAN_AVATAR_ROOT` 为上一步已经校验的资源目录，再在项目根执行。若目标已存在，先交给现有 stager 验证并复用；该片段只用于首次创建，不覆盖已有目录。

```python
import hashlib, json, os, shutil
from pathlib import Path

root = Path(os.environ['LYAPUNOV_HUMAN_AVATAR_ROOT']).resolve()
catalog_bytes = (root / 'catalog.json').read_bytes()
assert hashlib.sha256(catalog_bytes).hexdigest() == '4ab91eda9cfdc91256e204609b99eef93be883499183109f384837934d23d393'
catalog = json.loads(catalog_bytes)
assert len(catalog['avatars']) == 12
out = Path.cwd() / '.runtime' / 'mac-human-avatar-supply'
out.mkdir(parents=True, exist_ok=False)
gallery = out / 'gallery'
gallery.mkdir()
characters, avatars = [], []
for row in catalog['avatars']:
    avatar_id = row['avatarId']
    target = out / avatar_id
    target.mkdir()
    for name in ['character.glb', 'preview.png', 'LICENSE-character.txt',
                 'source.json', 'verified-sources.json', 'foot-calibration.json']:
        source = root / avatar_id / name
        try:
            os.link(source, target / name)
        except OSError:
            shutil.copy2(source, target / name)
    preview = row['preview']
    shutil.copy2(root / preview['path'], gallery / (avatar_id + '.png'))
    characters.append({'id': avatar_id, 'preview': avatar_id + '.png',
                       'previewBytes': preview['bytes'], 'previewSha256': preview['sha256'],
                       'previewGitBlob': preview['gitBlob']})
    avatars.append({'avatarId': avatar_id, 'directory': avatar_id})
first = catalog['avatars'][0]
shutil.copy2(root / first['licenseFile'], gallery / 'LICENSE.md')
(gallery / 'candidates.json').write_text(json.dumps({
    'repository': first['repository'], 'revision': first['revision'],
    'license': 'MIT', 'characters': characters}, ensure_ascii=False))
(out / 'manifest.json').write_text(json.dumps({
    'schema': 1, 'gallery': 'gallery', 'avatars': avatars}, ensure_ascii=False))
print(out)
```

供给视图中的硬链接只读使用，不能原地改写人物字节。随后实际调用原 stager，并记录 12 款、catalog SHA、源 SHA、许可、预览、clip 和足段校准检查结果：

```sh
export LYAPUNOV_HUMAN_AVATAR_STAGING_ROOT="$PWD/.runtime/mac-human-avatar-supply"
bun --no-env-file script/human-avatar-resources.ts \
  "$LYAPUNOV_HUMAN_AVATAR_STAGING_ROOT" "$MAC_ACCEPT_OUT/human-stage-check"
```

正式候选还使用已有 `LYAPUNOV_ROBOT_STAGING_ROOT` 和 `LYAPUNOV_ROBOT_POLICY_STAGING_ROOT`。优先复用本机正确供给。若从已验证参考包重建，按 `script/default-t0-robots.ts` / `script/default-robot-policies.ts` 的原合同处理：资源清单从包内已校验 inventory 原样映射，保留每文件 size/SHA/许可；Go1 仍用 `script/prepare-viewer-test-assets.manifest.json` 的独立闭包；策略缓存保留包内 manifest 与原件。只在 `.runtime` 生成供给视图，禁止编造来源、修改权重或换模型；由原 stager 再验一遍。确实缺少原件时列明 pack / policy / 文件，其他已可执行阶段继续完成。

## 6. 自动化检查：在真 Mac 上实际执行

先按现有入口准备固定 Go1 测试资产与 Unity bridge，已有正确缓存直接复用：

```sh
bun --no-env-file script/prepare-viewer-test-assets.ts
bun --no-env-file script/unity-mcp-supply.ts --product
./node_modules/.bin/tsc --noEmit -p tsconfig.json
./node_modules/.bin/tsc --noEmit -p script/tsconfig.gates.json
bun --no-env-file script/test-ci.ts --json "$MAC_ACCEPT_OUT/offline-ci.json"
bun --no-env-file script/verify-asset-layout.ts --ci
git diff --check
```

完整默认 CI 使用原清单，不用无筛选的裸 `bun test` 代替，不另外跑会重复调用完整 CI 的 `release-gate` 来制造无意义等待。逐项报告 include、ran、pass、fail、missing、exclude 和内部 skip；本轮人数与 Mac 原生验收所需的检查不能因 Python 路径错误而跳过。完整 CI 自带用例里发生的 skip 也要说明原因，不能计为执行通过。

默认集合不能替代真实 12 款资源及 UI 任务。对 `packages/human-crowd/test/native.test.ts` 等实际纳入/排除与 SDK 状态逐项核对；必要的原生相关项使用当前 harness 的 `--filter` 精确运行并另存报告。测试问题按第 4 节窄修；失败保存首次日志，再复跑相关项，最后对交付版本重新完成默认集合。没有源码变化、失败或未解决问题时不重复扩大测试。

## 7. 真实桌面与 20 人验收

优先用现有本机 UI 自动化执行界面操作与截图。无法自行完成的系统权限弹窗、钥匙串或官网登录，集中请求用户做最小动作；不要因此省掉可继续执行的任务。无需供应商模型才能完成的人群操作，直接使用已有界面与原生工具。

先检查当前活实例与数据目录，保留用户工作。以本轮独立 `LYAPUNOV_DESKTOP_DATA_DIR` 保存验收工程，所有重开保持同一数据目录。可显式进入 Guest，避免调用用户账户和计费服务；Guest 没有默认模型，不伪造登录。使用现有启动器，例如：

```sh
LYAPUNOV_DESKTOP_DATA_DIR="$MAC_ACCEPT_OUT/desktop-data" \
  node script/desktop.ts --mode formal --engine mujoco -- --guest
```

最后的 `-- --guest` 是启动器的参数分隔：`--guest` 进入 Electron 应用，不能误写成启动器不支持的选项。保留启动器进程会话、PID、日志及其 Electron / Host / worker 子进程归属。运行环境继承本轮已验证的资源路径与 SDK，界面显示的实际引擎也必须是 MuJoCo。

| 步骤 | 必须取得的证据与通过标准 |
| --- | --- |
| 创建 | UI 创建 20 人；记录 sceneId、20 个 entityId、4 个默认人物模板及资源 SHA。不能把程序人夹具截图当 Rocketbox 外观通过。 |
| 同步 | 执行真实同步，记录 scene revision / applied revision、worldId / generation、人体数量和骨架观测，确认旧 World 未串入。 |
| 行走 | 20 人均实际执行有限路线；记录每人根位置变化、动作归属、步序和仿真时间；保存同次正面与侧面画面。以位移和观测证明运动，不能只看按钮或图标。 |
| 停止 | 对 20 人执行停止，停止确认后连续两个观察窗口根位置漂移 <=1e-6 m，动作 owner 清空；记录实际数值，失败不调整阈值。 |
| 保存 | 通过原保存流程完成，记录工程入口、资源身份、revision、人数、路线和保存确认。不能只落临时 JSON 就称 UI 保存通过。 |
| 普通退出 | 有运行或待保存内容时测试 `Cmd+Q`、菜单退出与原生确认；确认后完成 flush、stop、Host close，读回正常退出码和本轮所有子进程清理结果。关闭窗口另测，不能把 macOS 关闭窗口当整应用退出。 |
| 冷启动 | 前一实例确实结束，再用同一数据目录启动；取得新的 Host / World 身份，重开原工程恢复 20 人、模板、路线与资源引用；暂停态不自动重发旧动作。 |
| 再次执行 | 恢复后 20 人再次行走，再停止并确认无持续漂移，保存后退出。 |
| 信号退出 | 另两次对本轮启动器的确切 PID 分别发 `SIGTERM`、`SIGINT`，至少一次在 20 人正在走时执行；核对不滞留普通确认框、正常保存停止退出、无本轮孤儿进程；再重开保存工程。 |

仅向本轮拥有且已核对身份的 PID 发信号，不使用全局 `pkill`。保留进程会话获取真实退出码；普通退出确认框等待用户选择不算超时。确认后的清理按既有协调器预算判断，超过合理总窗口保留现场与阶段错误，不先用 `SIGKILL` 抹掉问题。

## 8. 修复、候选与解包验收

实际失败直接在现有模块做必要修复，保留首次证据。修复独立于用户修改，按文件白名单提交到 Dev 的任务分支，推送后回收对应 SHA 的 GitHub Actions 真实结论；全绿后按正常快进/合并流程纳入 Dev 主线，不强推、不推旧 Mac 仓库。交付版本变化后重跑受影响项和本轮必需自动化检查；修复方自己的“已通过”不能替代 Mac 端主控独立验收。

源码和运行流程通过后生成本机候选。先核对包来源守卫、资源/策略供给、便携 Node 与 micromamba：

```sh
bun --no-env-file script/package-linux.ts --check-source
bun run build:macos --node "$MAC_PACKAGE_NODE" \
  --release-id "0.2.3-macos-$(git rev-parse --short=12 HEAD)"
```

`MAC_PACKAGE_NODE` 必须是本机已核验的官方 Darwin arm64 Node 发行目录中的 `bin/node`，版本满足源码要求，带同目录 `include` 和 `LICENSE`；不能把依赖 Homebrew dylib 的 Node 直接当便携运行时。复用正确本机缓存，缺少时从官方固定版本正常下载并记录来源与校验；不借用 Linux Node。打包器另需 `.runtime/bin/micromamba` 或其实际支持的显式参数，先读当前 `script/package-linux.ts` 的参数。

`build:macos` 当前调用共同的 `script/package-linux.ts`；不要复活旧 Alpha8 的独立 `package-macos.ts`、electron-builder 或 universal 路线。保留 dirty 现场，不能为了出包删除资源或用户改动；不能用 `LYAPUNOV_PACKAGE_ALLOW_DIRTY=1` 将工作树包冒充与提交一致的标准候选。必要修复先规范提交；无关修改仍保留。

检查 `.runtime/releases/` 内实际产物与 `RELEASE.json`：sourceCommit、`sourceCommitMatchesPayload:true`、Darwin arm64、12 款资源、许可、原生依赖、归档大小和 SHA。完整便携根是分发单位，内含 `.app` 依赖同根资源，不能单独拖走 `.app`。记录实际签名/公证/Gatekeeper 状态，缺证书如实为 ad-hoc / 未公证。

在不同目录完整解包，用包内入口运行 `./lyapunov doctor desktop` 与 `./lyapunov desktop`。按原 `install-provider` 在目标机准备需要的 Mac SDK，不复用打包机绝对路径。至少在解包版本重复创建/导入 20 人、同步、行走、停止、保存、整应用退出、冷启动恢复和再次行走停止。优先用工程导出/导入验证保存场景跨入口恢复；不复制账户凭据，也不把源码实例冒充包实例。

包实例使用本轮独立数据目录。在该实例的进程环境中，清除指向源码检出的资源、产品根、Node、Electron 和 Python 覆盖，变量名以 `packages/lyapunov-product-bundle/src/runtime-paths.ts` 为准；尤其不能继续继承源码验收用的 `LYAPUNOV_HUMAN_AVATAR_ROOT`。确认包内资源目录实际被加载，SDK 由包内原入口在目标目录准备。记录包实例与源码实例各自的 PID、产品根和资源根，防止“包能运行”实际仍依赖源码缓存。

## 9. 回执、停止条件与交付

证据统一留在本轮 `MAC_ACCEPT_OUT`，完成时写 `FINAL_RECEIPT.json` 和简明中文 `FINAL_RECEIPT.md`，列出：

- 状态：完成 / 部分完成 / 阻断；准确源码 SHA、dirty 范围、硬件、系统、工具与 SDK 版本。
- 每条实际命令、退出码、测试统计、失败首次日志、修复清单、关键 diff、对应 CI URL / SHA / attempt / 结论。
- 资源来源、归档与 catalog 摘要、12 款身份、20 人 scene / entity / World 身份、位移与停止漂移、保存重开及每种退出结果。
- 本轮实际截图/视频/观测文件和进程生命周期；产物路径、大小、SHA、`RELEASE.json`、签名等级与解包运行结果。
- 未运行项与原因、当前精确阻断、用户数据与原有修改保留情况、残留进程及下一步。

本轮所有必需项通过才能写“完成”。有资源或 SDK 缺件时，已可执行的检查继续完成后集中报告具体对象；Apple 正式签名材料缺少只限制正式分发，不妨碍如实交付本机候选。不要因可选 Newton、Isaac、CUDA、Intel、厂商模型或额外性能目标扩大本轮。

不得为了“自己走完”虚构通过：编译成功、CI 成功、窗口出现、截图存在、进程退出、原生任务完成、用户流程通过及可正式分发是不同证据层级。最终只向用户回收必要摘要、关键证据和真实阻断，不重复搬运完整聊天或海量帧流。
