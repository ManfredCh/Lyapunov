# Linux 安装、升级、回滚与卸载

| 出版信息 | 标记 |
| --- | --- |
| 应用发布名称 | 0.1.0α · Linux x64 |
| 技术版本 / releaseId | `0.1.0-alpha.2` |
| 文档日期 | 2026-10-03 |
| 作者团队 | Vorynel Co., Ltd. |
| 版权 | © 2026 Vorynel Co., Ltd. |
| 项目许可 | Lyapunov Modified MIT License；根 LICENSE 为项目自定义全文，根 NOTICE 保留原 OpenCode MIT 声明。 |
| 公共源码 | [ManfredCh/Lyapunov](https://github.com/ManfredCh/Lyapunov) |
| 图片与概念来源 | 项目贡献者撰写的说明与版本标记；本手册为文字和命令说明，无概念图素材。 |

本文对应 Lyapunov 0.1.0α（技术版本及 releaseId 为 `0.1.0-alpha.2`）的 Linux x64 安装合同。当前发布说明见[0.1.0α](releases/0.1.0-alpha.2.md)。releaseId、最低 glibc、主包和 MuJoCo 伴随包的文件名、大小与校验值，以[官网安装页](https://vorynel.com/lyapunov/)及该批次版本清单为准。主包与默认 MuJoCo 使用同一个 releaseId，按清单选择对应归档。

## 默认安装

在图形桌面的普通终端运行：

```sh
curl -fsSL https://vorynel.com/lyapunov/install.sh | sh
```

只需执行上面的同一条 `curl` 命令，无须另输入 sudo 或配置命令。如果当前系统需要配置本版本的 Chromium 沙箱，且 doctor 已确认依赖就绪、安装目录支持 helper、当前进程可正规授权，安装器会自动显示一次系统授权提示。密码由控制终端交给系统 sudo，不从 `curl` 管道读取，也不由应用保存。授权完成后，安装会自动继续，重跑正常 doctor 和物理检查，全部通过才激活版本；成功安装不会自动打开 GUI。

在 Ubuntu／Debian 上，若正常 doctor 与实际 ldd 报告可明确映射的桌面共享库缺失，安装器会沿系统包管理器和标准授权准备这些依赖，再重跑正常检查；不添加第三方源或安装完整桌面。

无控制终端、受限的 `CONTEXT_ONLY`／`no_new_privs`、`nosuid`、依赖缺失或授权未完成时，安装器保留已验证版本与旧 `current`，显示具体状态和日志位置。请按提示回到普通交互终端重新运行同一安装命令；安装器不会关闭 AppArmor 或系统沙箱。

安装成功并报告就绪后，由用户单独启动：

```sh
"$HOME/.local/bin/lyapunov"
```

需要 Linux `x86_64`、glibc、图形会话、Electron 所需共享库和可用的渲染后端。安装脚本使用系统的 `curl`、`sha256sum`、`tar`、`mktemp`、`getconf` 及常规 shell 工具；应用自带 Node.js 和 Electron，默认 MuJoCo 伴随包自带 Python。无需预先安装系统 Conda、Python、Bun 或配置模型 Key。版本目录使用随包 Node、固定 DSH 及其依赖，MuJoCo 只使用该版本的独立 `.runtime/sim-python`；默认安装不改系统 Python、不依赖 PATH 中的 dsh／python，也不复用宿主开发 venv。用户会话、凭据和数据继续使用产品的稳定数据根。运行时目录与依赖的私有归属、Host 的权限与 bwrap、Chromium 的桌面沙盒各有自己的检查，目录隔离本身不代替内核沙盒验证。

macOS 版本将尽快提供；Windows 用户建议通过 WSL2 + WSLg 安装和使用 Linux 包。

默认安装落点：

| 内容 | 路径 |
| --- | --- |
| 应用与下载缓存 | `~/.local/share/lyapunov/` |
| 某个发布版本 | `~/.local/share/lyapunov/versions/<releaseId>/` |
| 当前版本 | `~/.local/share/lyapunov/current`，指向该目录内的 `versions/<releaseId>` |
| 上一个版本 | `~/.local/share/lyapunov/previous`，在更新激活时记录原 `current` |
| 命令入口 | `~/.local/bin/lyapunov` |
| 桌面入口 | `${XDG_DATA_HOME:-$HOME/.local/share}/applications/lyapunov-desktop.desktop` |
| 默认 MuJoCo SDK | `<版本目录>/.runtime/sim-python/` |
| 该版本安装回执 | `<版本目录>/.install/` |

安装器下载版本清单，校验归档字节数与 SHA-256，并核对包内 `RELEASE.json` 的版本、平台和源码提交。默认 MuJoCo 以 `conda-pack` 伴随包在最终版本路径解包并运行 relocation；随后执行托管 SDK 的 `doctor` 与原生 `physics-check`。这些检查通过后，安装器才原子切换 `current` 并创建用户命令与桌面入口。

正常系统沙箱授权会按上面的同一安装流程自动完成；其他桌面共享库或受限沙箱条件阻断时，已校验的版本目录与 SDK 会保留，原 `current` 保持不变。按短状态与日志说明处理后重跑原安装命令，已下载的正确归档可复用，中断下载保留为 `.partial`。

如果固定桌面文件已经是旧 Lyapunov 入口，安装器会核对窗口类、旧产品包身份与启动目标。身份成立时，旧文件精确保存在 `<安装根>/entry-backups/lyapunov-desktop.original`，并保留可启动的 `lyapunov-desktop.legacy.desktop`；其原 Exec、旧 wrapper 和数据路径不改。新受管入口仍使用固定 `lyapunov-desktop.desktop`，与应用桌面身份保持一致。未知 foreign 文件不会覆盖；后续生成或激活失败会恢复旧标准入口，重复安装不追加旧入口副本。

## 先查看脚本或选择版本

```sh
curl -fsSL https://vorynel.com/lyapunov/install.sh -o lyapunov-install.sh
less lyapunov-install.sh
sh lyapunov-install.sh --help
sh lyapunov-install.sh
```

安装器实际支持以下选项：

| 选项 | 行为 |
| --- | --- |
| `--version RELEASE_ID` | 安装官网已发布的固定批次；值取该批次清单的 `releaseId`。 |
| `--prefix /绝对路径` | 设置应用、版本、链接与下载缓存的根目录。默认 MuJoCo 支持普通路径与空格，不支持前缀中的单引号；会在下载前以 `CONDA_PREFIX_UNSUPPORTED` 拒绝。 |
| `--bin-dir /绝对路径` | 设置 `lyapunov` 用户启动器目录。 |
| `--no-desktop` | 不创建桌面快捷入口，仍安装用户命令入口。 |
| `--without-mujoco` | 显式略过默认 MuJoCo 准备与物理检查；桌面检查通过后才激活。 |
| `--help` | 显示当前脚本的实际参数。 |

例如自定义目录并保留默认 MuJoCo：

```sh
sh lyapunov-install.sh   --prefix "$HOME/Applications/Lyapunov"   --bin-dir "$HOME/.local/bin"
```

安装指定版本时，将 `REPLACE_WITH_PUBLISHED_RELEASE_ID` 替换为官网列出的真实值：

```sh
sh lyapunov-install.sh --version REPLACE_WITH_PUBLISHED_RELEASE_ID
```

脚本还接受对应的 `LYAPUNOV_INSTALL_ROOT`、`LYAPUNOV_INSTALL_BIN_DIR` 环境变量。若使用自定义前缀，本文后续回滚与卸载中的默认路径需要同步替换。启动目录不会自动加入 shell 的 `PATH`；可直接使用安装输出中的绝对启动器路径。

## 首次运行

欢迎页提供语言、主题、登录与 **Try as guest／游客体验**。登录在浏览器完成官网授权，验证成功后同一个应用窗口进入工作台；正式模型使用 Peiri 与中央 Credits。

Guest 使用独立本地工程与会话，不连接产品账户或计费后端，没有默认模型。文件、Scene、Viewer 与已安装的本地工具可用；需要 Agent 时在模型设置显式配置自己的 provider。Guest 不使用 Peiri、中央 Credits、产品云端生成或云资源。游客工程要带入账户时，先导出，再登录并显式导入该工程，不自动合并。

机器人按“准备 → 初始化 → 就绪 → 显式受控执行”操作。共同准备流程需要核对模型、引擎、资源、放置与碰撞几何；不同机器人保留各自控制映射。模型可见与物理就绪分别确认，不把 G1 导入称为自动起身或完整本体任务验收。

相机面板可进入固定或绑定相机，也可选择 **Saved views／已保存视角**；点击 **Return to main view／返回主视图** 或按 `Esc` 离开锁定视角。自由漫游时先点击 Viewer 画布，WASD 平移、Q/E 升降、Shift 加速、右键环顾；失焦停止移动，`Esc` 切回环绕。导航键操作视角，机器人动作由其控制面或显式 Agent 指令执行。

## 手工下载与解包

官网 JSON 清单与安装器 TSV 清单描述同一个发布对象：

- 最新：`https://vorynel.com/lyapunov/releases/latest/linux-x64.json`，同目录 `.tsv`。
- 固定版本：`https://vorynel.com/lyapunov/releases/<releaseId>/linux-x64.json`，同目录 `.tsv`。
- 主包：`https://vorynel.com/lyapunov/releases/<releaseId>/<archive.path>`。
- MuJoCo 伴随包：同一版本目录中的 `<mujoco.runtime.archive.path>`；默认运行时格式为 `conda-pack`。

JSON 中两项 `archive.path` 均为文件名；TSV 的 `archive_path` 与 `mujoco_path` 是从 `/lyapunov/` 起算的相对发布路径。使用清单内的真实文件名、字节数和 SHA-256；应用版本号与发布批次 releaseId 分开登记。

手工流程：

1. 从官网选择一个固定 releaseId，保存其清单与两个归档。先将下载文件的字节数和 `sha256sum` 输出与清单比较。
2. 将主包完整解到一个新的版本目录，保留清单规定的顶层 `archiveRoot`。该目录以 `./lyapunov` 为产品入口。
3. 在主包根创建 `.runtime/sim-python`，将 MuJoCo 伴随包解到这里。用该环境的 `bin/python bin/conda-unpack` 在最终路径运行 relocation；此后保留该路径。
4. 运行 `./lyapunov doctor mujoco --managed-sdk` 与 `./lyapunov physics-check --managed-sdk`，按真实输出补齐当前桌面的共享库或沙盒要求。检查通过后运行 `./lyapunov`。
5. 手工解包不会生成默认安装器的 `current`／`previous`／用户启动器。希望使用这些入口时，运行官方脚本安装同一 releaseId。

以下是单个归档的校验示例；文件名与摘要必须从该固定版本清单复制：

```sh
sha256sum ./YOUR_DOWNLOADED_ARCHIVE.tar.gz
wc -c < ./YOUR_DOWNLOADED_ARCHIVE.tar.gz
```

在已完整解包的主包根，MuJoCo 伴随包的解包与检查命令如下；`/absolute/path/to/mujoco-companion.tar.gz` 替换为已验证文件：

```sh
mkdir -p .runtime/sim-python
tar --no-same-owner --no-same-permissions   -xzf /absolute/path/to/mujoco-companion.tar.gz -C .runtime/sim-python
.runtime/sim-python/bin/python .runtime/sim-python/bin/conda-unpack
./lyapunov doctor mujoco --managed-sdk
./lyapunov physics-check --managed-sdk
./lyapunov
```

如果只下载了主包，也可以在该包根显式运行 `./lyapunov install-provider mujoco`，联网建立独立 SDK；这条路径会下载依赖，不等同于伴随包已经准备完成。Hugging Face 请求使用 `https://hf-mirror.com`，镜像缺少文件、revision、权限或校验失败会点名对象并阻断。

## 可选引擎与大型运行时

默认安装准备 MuJoCo 及规划、几何和传输依赖；Isaac、Newton、policy 运行时和 benchmark 套件按需选择：

```sh
"$HOME/.local/bin/lyapunov" install-provider newton
"$HOME/.local/bin/lyapunov" install-provider policy-cpu
"$HOME/.local/bin/lyapunov" install-provider benchmark-libero
"$HOME/.local/bin/lyapunov" install-provider benchmark-gymnasium
```

Isaac 需要对应硬件、驱动与 SDK，安装前阅读 [NVIDIA Omniverse 许可](https://docs.omniverse.nvidia.com/platform/latest/common/NVIDIA_Omniverse_License_Agreement.html)，同意后显式运行：

```sh
"$HOME/.local/bin/lyapunov" install-provider isaac --accept-omniverse-eula
"$HOME/.local/bin/lyapunov" doctor isaac
```

自动引擎选择仍遵循产品的统一优先级：显式选择优先；自动模式在 Isaac SDK、许可和所需加速器均可用时选择 Isaac，否则选 MuJoCo。物理引擎设置的偏好在下次启动工作台生效。检查 SDK 可用不等于世界或 RTX 成像已经成功；Newton 当前保留较小的世界与观测能力范围。

## 数据位置与升级

应用版本目录用于客户端代码、随包运行时与该版本的 SDK。用户场景、机器人与模型资产、录制、采集和凭据应放在应用目录之外。发行桌面默认使用 Electron 的平台用户数据目录；Linux 一般为 `${XDG_CONFIG_HOME:-$HOME/.config}/LyapunovDSH`。已有显式 `LYAPUNOV_DESKTOP_DATA_DIR` 则使用其指定目录。运行中的工作台数据位于该数据根内的 `runtime/`，账户与游客按自己的身份目录隔离。

升级前退出应用，导出需要保留的工程，或将实际数据根复制到应用目录之外。备份需要覆盖数据根中的场景、资源索引、会话、采集与运行记录；产品没有自动备份机制或可替代这一步的 `backup` 命令。迁移报告打印在启动输出，不作为持久化恢复日志保存，不能用事后的报告重建升级前数据。

以下仅示例默认 Linux 数据位置，实际使用了自定义环境变量时须替换：

```sh
lyapunov_data="${LYAPUNOV_DESKTOP_DATA_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/LyapunovDSH}"
lyapunov_backup="$HOME/lyapunov-backup-$(date +%Y%m%d-%H%M%S)"
cp -a -- "$lyapunov_data" "$lyapunov_backup"
```

然后重跑同一安装命令：

```sh
curl -fsSL https://vorynel.com/lyapunov/install.sh | sh
```

安装后先检查实际版本，需要时再单独启动：

```sh
"$HOME/.local/bin/lyapunov" --version
```

```sh
"$HOME/.local/bin/lyapunov"
```

安装器保留已有版本、下载缓存与用户数据；更新时将前一 `current` 保存为 `previous`。客户端的布局迁移可能移动资源目录或改写引用，所以更换应用链接只回退代码。若要回退数据布局，需要使用升级前的数据副本。

手工维护同一个解包安装时，退出应用后在同一目录替换代码与随包文件；保留包外数据根与其备份。旧版本不应与新版本同时连接同一运行根。

## 回滚到保存的版本

先退出应用。默认安装可查看上一个版本：

```sh
lyapunov_prefix="$HOME/.local/share/lyapunov"
readlink "$lyapunov_prefix/current"
readlink "$lyapunov_prefix/previous"
```

数据布局已迁移时，先把升级后的数据根移到一个新位置保留，再从升级前备份恢复实际数据根，最后切换 `current` 或换回旧客户端。旧版本只认 `scene/` 布局时，看不到已经迁移到 `catalog/` 的库；启动 `EXIT=0` 或 `doctor` 依赖 `AVAILABLE` 不代表回滚成功，需要确认恢复后的工程与资源可见。此操作使用自己的备份路径，安装器没有 `rollback` 子命令。迁移会移动目录，并可能就地改写 JSON／JSONL 中命中旧路径的引用；历史“改写引用 0”是特定数据根的读数，不能理解为所有迁移都只搬不改。

需要恢复数据布局时，先选升级前保存的实际备份，保留升级后的数据根，再恢复；下面的备份路径需替换为自己的路径：

```sh
lyapunov_data="${LYAPUNOV_DESKTOP_DATA_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/LyapunovDSH}"
lyapunov_backup=/absolute/path/to/your/pre-update-backup
test -d "$lyapunov_backup" || exit 2
mv -- "$lyapunov_data" "$lyapunov_data.after-update-$(date +%Y%m%d-%H%M%S)"
cp -a -- "$lyapunov_backup" "$lyapunov_data"
```

下面复用安装器保存的 `previous`，以临时符号链接加 GNU `mv -Tf` 原子切换；不会重新下载或删除任何版本：

```sh
lyapunov_prefix="$HOME/.local/share/lyapunov"
lyapunov_target=$(readlink "$lyapunov_prefix/previous")
case "$lyapunov_target" in versions/*) ;; *) exit 2 ;; esac
lyapunov_id=${lyapunov_target#versions/}
case "$lyapunov_id" in ''|*[!A-Za-z0-9._-]*|.|..) exit 2 ;; esac
test -x "$lyapunov_prefix/$lyapunov_target/lyapunov" || exit 2
test -f "$lyapunov_prefix/$lyapunov_target/.install/archive.sha256" || exit 2
lyapunov_pending="$lyapunov_prefix/.current.rollback.$$"
ln -s -- "$lyapunov_target" "$lyapunov_pending" &&
  mv -Tf -- "$lyapunov_pending" "$lyapunov_prefix/current"
"$HOME/.local/bin/lyapunov" --version
```



## 卸载与保留数据

先退出 Lyapunov。默认安装的两个入口有明确的安装归属标记；仅在标记与本次安装根一致时删除：

```sh
lyapunov_prefix="$HOME/.local/share/lyapunov"
lyapunov_launcher="$HOME/.local/bin/lyapunov"
lyapunov_desktop="${XDG_DATA_HOME:-$HOME/.local/share}/applications/lyapunov-desktop.desktop"
if [ -f "$lyapunov_launcher" ] &&
   grep -Fx -- "# Lyapunov managed launcher root: $lyapunov_prefix" "$lyapunov_launcher" >/dev/null; then
  rm -- "$lyapunov_launcher"
fi
if [ -f "$lyapunov_desktop" ] &&
   grep -Fx -- "X-Lyapunov-Install-Root=$lyapunov_prefix" "$lyapunov_desktop" >/dev/null; then
  rm -- "$lyapunov_desktop"
fi
```

自定义前缀／bin-dir 时，替换成安装时的实际路径。然后检查安装根内的 `versions/` 与 `downloads/`；版本的 `.install/release.tsv` 是对应回执，确认这里仅包含本次安装的应用与缓存后，可以删除这些安装文件及 `current`、`previous` 链接。卸载只处理自己选择的应用安装根；保留平台用户数据目录、显式数据根、导出的工程与外部资产目录。

希望先保留整个安装以便恢复时，可在删除入口后将默认安装根改名：

```sh
lyapunov_prefix="$HOME/.local/share/lyapunov"
mv -- "$lyapunov_prefix" "$lyapunov_prefix.uninstalled-$(date +%Y%m%d-%H%M%S)"
```

安装器没有 `uninstall` flag，也不自动清除用户工程、资产或凭据。

## 诊断与日志

| 现象 | 操作 |
| --- | --- |
| 安装在 manifest／download 阶段阻断 | 查看输出中的固定 URL、对象、字节数或摘要原因；保留 `.partial` 后重试同一版本。版本清单不可用时按具体对象报告阻断。 |
| `DESKTOP_LIBRARIES_MISSING` | 默认安装器会在支持的 Ubuntu／Debian 系统上按实际缺库结果请求正常系统授权并准备对应库，随后自动继续。其他发行版或无法授权时，按日志中的具体缺库处理。 |
| Chromium helper 未就绪 | 默认安装器在正常系统上按需请求系统授权并配置本版本 helper，随后自动继续。单独运行 `doctor` 时，按其输出给出的精确版本路径执行管理员修复；未激活版本不会从旧启动器接收这条修复。 |
| `CONTEXT_ONLY` | 当前终端安全上下文不能完成桌面检查；在该桌面的普通终端复查，不将此结果记为机器通过或失败。 |
| `PROVIDER_UNAVAILABLE` | 核对选择的引擎、环境变量／设置保存的 Python 路径与 SDK；`install-provider` 只准备托管环境，不修复外部 SDK。 |
| Guest 无法开始 Agent 回合 | 在模型设置显式配置自己的 provider；Guest 初始没有默认模型或 Peiri。 |
| 相机接口 `UNSUPPORTED` | 当前引擎未实现该接口；按能力表选择支持相应采集的引擎。 |
| 场景修改后物理未变化 | 查看应用场景修改／同步状态与目标 world；先确认最新 Scene 已应用，再执行动作。 |

常用检查：

```sh
"$HOME/.local/bin/lyapunov" --version
"$HOME/.local/bin/lyapunov" doctor mujoco
"$HOME/.local/bin/lyapunov" doctor mujoco --managed-sdk
```

安装输出可以保存到自己选择的文件；`<版本目录>/.install/release.tsv`、`archive.sha256`、MuJoCo 回执记录安装身份。physics 的详细 JSON 与错误输出保存在 `.install/physics-check.log`，终端显示简短结果和日志路径，非零退出状态原样保留。以 `install-provider` 准备 SDK 的路径还保留 `.install/provider.log` 与 `.install/provider.exit`。桌面事件在实际用户数据根的 `desktop-incidents.jsonl`；从终端启动时的 Host／Provider 日志显示具体运行错误。需要反馈问题时附版本、源码提交、失败命令与关键报错，删除模型 Key、登录会话和私有工程内容。
