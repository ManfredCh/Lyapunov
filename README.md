# Lyapunov

[English](README.md) | [简体中文](README.zh-CN.md)

**Linux x64 Alpha** · **Lyapunov Modified MIT**

| Publication metadata | Value |
| --- | --- |
| Application version | 0.1.0 · A08 Alpha |
| Documentation edition | 2026-10-02 |
| Author team | Lyapunov contributors |
| Copyright | © 2026 Lyapunov contributors |
| Project license | [Lyapunov Modified MIT License](LICENSE) · [Retained notices](NOTICE) |
| Source repository | [ManfredCh/Lyapunov](https://github.com/ManfredCh/Lyapunov) |
| Visual and concept sources | Contributor-written documentation and release metadata; this README contains no concept-image assets. |

Lyapunov is an agent workspace for building 3D scenes, preparing robots, running controlled simulation, and collecting camera data. Chat, code, files, the 3D viewer, and physics share one desktop workspace.

**Release channel:** Linux x64 Alpha. The [installation page](https://vorynel.com/lyapunov/) and its release manifest are the authority for release identifiers, downloads, and system requirements. This repository contains the product source; the [release notes](docs/releases/2026-10-linux-a08.md) describe this Alpha's changes and known limits.

[Install](#install-on-linux) · [First run](#first-run) · [Robots and cameras](#robots-and-cameras) · [Installation guide / 安装手册](https://vorynel.com/lyapunov/guide.html) · [Release notes / 发布说明](docs/releases/2026-10-linux-a08.md)

## Install on Linux

From a regular terminal in your graphical desktop session:

```sh
curl -fsSL https://vorynel.com/lyapunov/install.sh | sh
"$HOME/.local/bin/lyapunov"
```

The default installation prepares **MuJoCo and its Python runtime**, verifies native physics, and creates a per-user launcher and desktop entry. Node.js, Electron, and the pinned DSH runtime are included in the main archive; the default installation downloads MuJoCo and Python into a dedicated environment inside that version. The default installer and packaged launcher do not depend on Node, DSH, or Python from PATH, or on a developer’s source checkout. User sessions and credentials use the product data directory across upgrades. You do not need a system Node.js, DSH, Python, pip, Conda, Bun, or a model key to install it.

The installer requires `sh`, `curl`, `tar`, `sha256sum`, and standard Linux utilities such as `mktemp` and `getconf`. The packaged target is **Linux x86_64 with glibc**. A graphical desktop, Electron's shared libraries, and a working rendering backend are required. The release manifest specifies the minimum glibc version for both the application and MuJoCo companion. Physics can run on CPU; camera rendering and large 3D scenes need the corresponding graphics capabilities and memory. Intel, AMD, and NVIDIA configurations are checked individually; this Alpha does not claim coverage of every GPU or Linux distribution. macOS and Windows packages are outside this release. This Alpha does not promise offline installation.

The installer keeps versions under `~/.local/share/lyapunov/versions/`, switches the `current` link only after its checks pass, and leaves older versions and user data in place. If `~/.local/bin` is on your `PATH`, you can launch with `lyapunov`; otherwise use the absolute command above. See the [installation page](https://vorynel.com/lyapunov/) for download sizes and published release identifiers.

To read the script first, or choose a published version:

```sh
curl -fsSL https://vorynel.com/lyapunov/install.sh -o lyapunov-install.sh
less lyapunov-install.sh
sh lyapunov-install.sh --help
sh lyapunov-install.sh
```

`--version RELEASE_ID` selects a published release. `--prefix /absolute/install/path` and `--bin-dir /absolute/bin/path` customize its location. Spaces in the install prefix are supported; a prefix containing a single quote (`'`) is rejected for the default MuJoCo runtime. Manual archives, checksums, updates, rollback, and removal are covered in the [installation guide](https://vorynel.com/lyapunov/guide.html).

## First run

1. Open Lyapunov. The welcome page lets you choose a language and theme.
2. Choose **Sign in**, complete website authorization in your browser, and return to the same application window. The workspace opens after the account is verified. Signed-in model calls use **Peiri** and the account's central Credits.
3. To work locally, choose **Try as guest**. Guest opens an independent local workspace without connecting to product servers, including the product account or billing backend. Files, scene editing, the viewer, and locally installed tools remain available. Guest starts with **no default model**; configure your own provider explicitly in model settings to use an agent. Guest does not use Peiri or central Credits.
4. Create or open a project, then add assets from your files or the local resource library. Guest projects remain separate from signed-in projects; export a guest project and explicitly import it after sign-in when you want to move it.

The account page and settings expose the actual connection, model, and engine state. Provider credentials belong to the provider you configure; the application does not supply credentials for external services.

## Work in one place

| Task | Workspace tools |
| --- | --- |
| Build a scene | Import supported GLB/glTF, Gaussian Splat, MJCF, and URDF assets; select, transform, save, and reopen scene entities. |
| Work with code | Browse and edit files, search, inspect Git changes, and use the terminal alongside the agent. |
| Prepare simulation | Review the selected engine, robot controls, model dependencies, placement, and collision geometry before initialization. |
| Control a robot | Execute supported joint, gripper, vehicle, lift, gait, or body-wrench controls; stop execution and inspect actual world feedback. |
| Observe and collect | Use scene cameras, named engine cameras, RGB-D capture, calibration, annotations, recording, and dataset export where the selected engine supports them. |
| Add external tools | Configure Blender, optional physics engines, policy runtimes, reconstruction, or generation tools as needed. Their own software, models, licenses, and service access still apply. |

Source discovery begins with official project and registry roots. Service-provided source URLs and metadata guide the agent; browser, web-fetch, and terminal work is performed by the client. A source link becomes a usable local resource after the client obtains and checks the required files. It is not an automatic promise that every model or policy will run.

## Robots and cameras

Use the same preparation sequence across robot families: **prepare → initialize → ready → explicitly execute**. Select the robot and engine, inspect the available controls and dependencies, place the robot and environment, initialize physics, then run a bounded action and inspect the result. A model can be visible before its physics world is ready. Humanoids, quadrupeds, arms, vehicles, hands, and drones use different control mappings; importing G1 does not automatically stand it up or establish every whole-body behavior.

Prepare the world while it is paused, then explicitly start an action. A pretrained policy requires preparation and matching to the robot before explicit execution. A geometric gait command is separate from getting up and does not establish stable walking.

A visual asset and its collision geometry have separate roles. Add or prepare collision geometry appropriate to the scene before expecting physical contact. For a reconstructed room, use geometry aligned with the room rather than treating the entire room as a solid box. Check the actual world response after scene edits are applied.

In the camera panel, use **Enter camera** or **Enter and follow camera** for a scene camera. **Saved views** enter an existing named view. **Return to main view** restores the main view; `Esc` also leaves a locked camera view. These viewer views and the engine's sensor captures have separate controls.

For free navigation, choose the viewer's first-person mode and click the canvas: `W`/`A`/`S`/`D` move horizontally, `Q`/`E` move down/up, `Shift` increases speed, and the right mouse button looks around. When the canvas loses focus, movement stops; `Esc` returns to orbit mode. These keys navigate the camera. Robot execution uses the robot controls or explicit agent actions.

The [capability matrix](docs/CAPABILITY_MATRIX.md) and [camera guide](docs/SCENE_CAMERA_PIPELINE.md) describe engine-specific support and its recorded evidence.

## Physics engines and optional runtimes

The standard installation prepares MuJoCo. Engine selection is visible in settings: explicit choices take priority; automatic selection may choose Isaac when its SDK, accepted license, and required accelerator are available, otherwise it selects MuJoCo. Changes take effect at the next workspace start.

Isaac Sim, Newton, policy runtimes, and official benchmark suites are separate downloads:

```sh
"$HOME/.local/bin/lyapunov" doctor mujoco
"$HOME/.local/bin/lyapunov" install-provider newton
"$HOME/.local/bin/lyapunov" install-provider policy-cpu
```

For Isaac, read the [NVIDIA Omniverse license](https://docs.omniverse.nvidia.com/platform/latest/common/NVIDIA_Omniverse_License_Agreement.html) before explicitly accepting it:

```sh
"$HOME/.local/bin/lyapunov" install-provider isaac --accept-omniverse-eula
```

An installed SDK, a ready physics world, and a successful robot task are different results. Newton currently provides a smaller set of world and observation functions; it does not have every MuJoCo or Isaac action, contact, or camera interface. Optional models and policy weights are fetched only when selected. Hugging Face Hub access uses `https://hf-mirror.com`; missing mirrored files, revisions, or permissions are reported as blocked.

## Update and troubleshoot

Quit Lyapunov and rerun the same installer to update. Each published release has its own directory; `previous` records the former `current` version. User data lives outside the installation directory, in Electron's platform user-data directory by default, or at the explicitly configured `LYAPUNOV_DESKTOP_DATA_DIR`. Export important projects or copy that data directory while the application is closed before changing versions. Switching application versions does not restore a previous data layout; rollback details and uninstall commands are in the [installation guide](https://vorynel.com/lyapunov/guide.html).

Start with the actual diagnostic output:

```sh
"$HOME/.local/bin/lyapunov" --version
"$HOME/.local/bin/lyapunov" doctor mujoco
```

If installation stops at a desktop/sandbox check, it prints the exact installed version path and remedy. The verified files are retained without activating that version. When the output requests it, run `sudo /the/reported/version/path/lyapunov setup-sandbox`, then rerun the installer. `CONTEXT_ONLY` means that the current terminal's security context could not establish desktop readiness; repeat the check in a regular desktop terminal. `PROVIDER_UNAVAILABLE` names a missing or incompatible SDK; inspect the selected engine and any saved external Python path. The [installation guide](https://vorynel.com/lyapunov/guide.html) includes log locations and further recovery steps.

## Develop and contribute

This source repository builds the product on a pinned DSH revision. Development requires Git, Node.js 24+, Bun 1.3.13, and pnpm 11.7.0; the packaged installation above supplies its own runtime.

```sh
git clone https://github.com/ManfredCh/Lyapunov.git
cd Lyapunov
export HF_ENDPOINT=https://hf-mirror.com
node script/bootstrap.mjs
```

See the [development guide](development/README.md) and [standards and checks](docs/DEVELOPMENT_STANDARDS.md) for developer account setup, model configuration, source startup, builds, and validation. The [release notes](docs/releases/2026-10-linux-a08.md) describe this Alpha’s feature scope. Account and deployment services are maintained separately from this client repository.

The top-level Lyapunov project uses the [Lyapunov Modified MIT License](LICENSE), copyright © 2026 Lyapunov contributors. This custom license retains the MIT permission terms. A commercial product or service using the software or a derivative work must prominently credit “Lyapunov” when it reaches 10,000 monthly active users or CNY 1,000,000 in monthly operating revenue (or currency equivalent). Without a UI, attribution belongs in its official documentation or website. These thresholds apply to that product or service; attribution does not require a license fee. The existing OpenCode MIT copyright and permission notice is retained in [NOTICE](NOTICE). Individual packages, bundled DSH/Node/MuJoCo components, robot assets, model weights, and external services retain their respective licenses.

## 中文快速说明

Lyapunov 将 Agent、文件与代码、三维场景、机器人仿真和相机采集放在同一桌面工作台。当前发行通道为 Linux x64 Alpha；版本标识、下载内容和运行要求以[官网安装页](https://vorynel.com/lyapunov/)为准。

默认安装命令为 `curl -fsSL https://vorynel.com/lyapunov/install.sh | sh`，包含 MuJoCo 运行环境的准备与验证。首次启动可通过官网授权登录并使用 Peiri／中央 Credits，也可显式进入 Guest，使用本地功能并自行配置 provider；游客不连接产品账户或计费后端，没有默认模型。机器人按“准备 → 初始化 → 就绪 → 显式执行”操作；相机可从绑定或保存视角返回主视图，WASD 只用于自由视角导航。

完整中文步骤见[安装、升级、回滚与卸载手册](https://vorynel.com/lyapunov/guide.html)，各引擎与机器人差异见[能力总表](docs/CAPABILITY_MATRIX.md)。
