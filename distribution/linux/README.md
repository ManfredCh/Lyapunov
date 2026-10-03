# Lyapunov for Linux

This directory defines the Linux x64 Alpha package. For the per-user installation with the default MuJoCo runtime, use the [website installer](https://vorynel.com/lyapunov/):

```sh
curl -fsSL https://vorynel.com/lyapunov/install.sh | sh
"$HOME/.local/bin/lyapunov"
```

The installation page and release manifest are the authority for this Alpha's release identity and system requirements. The installer uses one versioned manifest for the application and MuJoCo companion, checks their sizes and SHA-256 values, relocates the Python runtime at its final path, and verifies it before switching `current`. Older versions and user data are retained. Spaces in the install prefix are supported; a prefix containing a single quote (`'`) is rejected for the default MuJoCo runtime.

## Start an extracted package

The archive supplies Node.js, Electron, pinned DSH, product plugins, and runtime dependencies. Extract the complete archive, enter its top-level directory, and use its single product entry:

```sh
./lyapunov --help
./lyapunov --version
./lyapunov
```

The desktop requires Linux x86_64 with a graphical session, glibc at the release manifest's minimum version, Electron's shared libraries, and a usable rendering backend. An application archive by itself does not contain the separate MuJoCo companion. Use the default installer to prepare both, or follow the [published manifest and manual download links](https://vorynel.com/lyapunov/) for the published release.

The welcome page offers **Sign in** and **Try as guest**. Sign-in authorizes through the website in your browser and continues in the same application window. Signed-in model calls use Peiri and central Credits. Guest starts an independent local workspace without a product account, billing connection, or default model. Local tools remain available; configure your own provider explicitly in model settings for agent use.

## Check and prepare runtimes

```sh
./lyapunov doctor mujoco
./lyapunov physics-check
./lyapunov install-provider mujoco
./lyapunov install-provider newton
./lyapunov install-provider policy-cpu
```

The default website installation already prepares and tests MuJoCo. `install-provider mujoco` repairs or creates the package's managed SDK when needed; a saved or environment-selected external SDK is a separate choice. `doctor` checks dependencies, and `physics-check` runs a native falling-body test. These do not establish every robot, camera, or collision task.

SDK selection uses an explicit `LYAPUNOV_*_PYTHON` path first, then a path explicitly saved in physics settings, then the package's managed environment. MuJoCo uses `.runtime/sim-python/bin/python`; Isaac uses `.runtime/conda/envs/isaac/bin/python`; Newton uses `.runtime/newton-env/bin/python`. The managed SDK check is available as `./lyapunov doctor mujoco --managed-sdk`.

Isaac is an optional download. Read the [NVIDIA Omniverse license](https://docs.omniverse.nvidia.com/platform/latest/common/NVIDIA_Omniverse_License_Agreement.html), then explicitly accept it when installing:

```sh
./lyapunov install-provider isaac --accept-omniverse-eula
./lyapunov doctor isaac
```

Hardware, driver, rendering, and engine-specific capability requirements still apply. Newton offers a limited world/observation path. Policy and benchmark runtimes, Blender, external tools, and model weights remain separate selections. Hugging Face Hub operations use `https://hf-mirror.com` and report missing files, revisions, permissions, or failed checks as blocked.

## Sandbox and diagnostics

```sh
./lyapunov doctor mujoco
```

Follow the diagnosis for this exact installation. If it requests the packaged Chromium helper setup, use:

```sh
sudo ./lyapunov setup-sandbox
./lyapunov doctor mujoco
./lyapunov
```

This sets the helper inside this installation; it does not disable Chromium's sandbox or replace system drivers. A `CONTEXT_ONLY` result needs a check from a regular terminal in the desktop session. Installer checks that fail preserve the verified version directory and leave the existing `current` version active; fix the reported cause and rerun the same install command.

## Updates and rollback

Keep projects, recordings, credentials, and user data outside the application directory. The packaged desktop uses Electron's platform user-data directory, or an explicit `LYAPUNOV_DESKTOP_DATA_DIR`. Quit the app and make a read-only snapshot of that actual data root outside the installation **before updating or first starting the new version**. The product has no automatic backup mechanism and no `backup` subcommand. Migration reports are printed at startup and are not persisted as a recovery journal.

```sh
lyapunov_data="${LYAPUNOV_DESKTOP_DATA_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/LyapunovDSH}"
lyapunov_backup="$HOME/lyapunov-backup-$(date +%Y%m%d-%H%M%S)"
cp -a -- "$lyapunov_data" "$lyapunov_backup"
```

After the snapshot, update with the same installer. Old version directories and the `previous` link are retained:

```sh
curl -fsSL https://vorynel.com/lyapunov/install.sh | sh
"$HOME/.local/bin/lyapunov" --version
```

**Rollback boundary:** `previous` selects the saved client version; it does not restore data. If that target reads only the old `scene/` layout, it cannot see the library migrated to `catalog/`. Restore the pre-update snapshot before switching to that target. A successful launch (`EXIT=0`) or an `AVAILABLE` dependency report from `doctor` is not rollback success; confirm that the restored project and resource library are visible.

Migration moves directories with `rename` and may rewrite absolute references in JSON/JSONL in place with `rewriteJsonReferences()` and `writeFile`. A historical report of zero rewritten references is not a migration guarantee: it applies only when that data root has no matching old-path references. Switching application versions does not undo those data changes.

For a layout rollback, quit the app, choose the pre-update snapshot you saved above, and keep the migrated data root before restoring it:

```sh
lyapunov_data="${LYAPUNOV_DESKTOP_DATA_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/LyapunovDSH}"
lyapunov_backup=/absolute/path/to/your/pre-update-backup
test -d "$lyapunov_backup" || exit 2
mv -- "$lyapunov_data" "$lyapunov_data.after-update-$(date +%Y%m%d-%H%M%S)"
cp -a -- "$lyapunov_backup" "$lyapunov_data"
```

Then switch the default installation to its saved client version. Replace the prefix if you chose a custom installation directory:

```sh
lyapunov_prefix="$HOME/.local/share/lyapunov"
lyapunov_target=$(readlink "$lyapunov_prefix/previous")
case "$lyapunov_target" in versions/*) ;; *) exit 2 ;; esac
lyapunov_id=${lyapunov_target#versions/}
case "$lyapunov_id" in ''|*[!A-Za-z0-9._-]*|.|..) exit 2 ;; esac
test -x "$lyapunov_prefix/$lyapunov_target/lyapunov" || exit 2
lyapunov_pending="$lyapunov_prefix/.current.rollback.$$"
ln -s -- "$lyapunov_target" "$lyapunov_pending" &&
  mv -Tf -- "$lyapunov_pending" "$lyapunov_prefix/current"
"$HOME/.local/bin/lyapunov" --version
```

Do not run both versions against the same data root. For a manual installation, restore the snapshot before replacing the client files with the saved version. See the [installation guide](https://vorynel.com/lyapunov/guide.html) for data locations and removal.

## Other entry points

`./lyapunov --help` lists the explicit `terminal`, `administrator`, `architecture`, `benchmark`, `github`, and `fastgs` entries. Use the corresponding subcommand help before supplying credentials or choosing a runtime. Optional SDKs, service access, models, and licenses are prepared for the selected task.

## 中文快速说明

Linux x64 Alpha 的版本与运行要求以[官网](https://vorynel.com/lyapunov/)版本清单为准，使用 curl 安装入口获取对应版本，默认准备并验证 MuJoCo，按版本保存应用，验证成功后才切换 `current`。手工解包后以包根 `./lyapunov` 为唯一产品入口。首次启动可官网授权登录，或进入独立游客工作台并显式配置自己的 provider。

用户场景、模型、采集和凭据应保存在应用目录外。诊断失败时按 `doctor` 的真实输出处理，保留旧版本与用户数据；Alpha 的硬件、相机与机器人组合按实际支持范围使用。安装、升级、回滚、卸载与日志说明见[官网安装手册](https://vorynel.com/lyapunov/guide.html)。
