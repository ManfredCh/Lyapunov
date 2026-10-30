# SimReady 与 USD 实施回执（2026-10-28，新加坡时间）

状态：**部分完成**。原生 USD 主资产、依赖闭包、Scene 实例、便携导出、受限 Viewer 与 Isaac CPU 真实刚体/关节反馈已经执行；真实 SimReady 完整包下载被镜像的官方域跳转纪律阻断。没有把本地完整包夹具、descriptor/BOM 成功读取或自动化几何检查写成真实厂商包/完整界面验收。

本轮工作基于 `945c9879` 后的当前隔离工作树；首个提交为 `945c9879`，后续提交包含本回执。原始日志与产物均在本工作树 `.runtime/`，不提交 SDK、资产、缓存、视频或账户数据；主控仍须在独立集成树验收本提交。

## 交付与关键实现

- `scene-kit/src/formats.ts` 的 `parseAsset` 将 USD/USDA/USDC/USDZ 解析为 `kind:usd`；真实 `pxr.UsdUtils.ComputeAllDependencies` 展开非活动变体、payload、layer 与纹理。USD 的单位/轴向来自原件，冲突的外部声明拒绝。
- `scene-kit/src/usd_asset.py` 与 `usd-assets.ts` 负责只读源解析、匿名 session 变体和派生预览。Scene 只保存 ResourceRef 与实例覆盖；几何数组留在资源库的明确派生 JSON 资产。绝对 layer 引用只改便携副本，并沿既有派生版本规则登记。
- `simready-assets.ts` 提供 `simready_search/detail/import`，复用受控 HTTPS、原生代理、取消/超时/累计字节计费；默认覆盖 12 个登记库，保留固定 40 位 revision，按 descriptor/metadata/BOM 哈希和文件大小检查整包。来源失败与无匹配分开。完整包和来源清单进入原资源库的导出闭包；不建资产数据库或调度器。
- `scene_usd_instance` 与 Agent/Command 共享同一个 operation 和 Scene CAS。真实 ToolRegistry 揭示并修复了早期动态 schema 不被 DSH 接受的装配问题；当前使用 DSH 支持的 JSON 槽，实际集合由 OpenUSD 校验。
- Isaac 以父 Xform 承载 Scene 变换，保留源根变换、关节、驱动和碰撞；观测提供 source/runtime/body prim 对应关系。`sensors.usdBodyWorldPoses` 复用既有 Frame；Viewer 的同一 `applyFrame` 用真实 body 世界矩阵驱动源 body 绑定的子几何。
- Viewer 几何读取支持 mesh 与常用 USD primitive；材质仅 `displayColor`，纹理、材质网络、细分曲面、USD 动画/蒙皮未渲染。限制在放置选项和诊断中明示；原件及其依赖仍保留。MuJoCo/Newton 原生 USD 物理明确拒绝，不能把它们静默降为视觉模型。
- `distribution/linux/install-usd-parser` 是源码/发行共用的显式解析器安装实现；只在本产品 `.runtime/usd-python` 准备 `usd-core==26.5`。发行打包与 payload 合同要求携带安装器、USD worker 和原生观测模块。CI 现有唯一 Python 环境显式准备固定 OpenUSD，原有便携 USD 测试继续执行。

## 实施方自动化回执

以下退出状态均为本轮实际结果，目标为当时当前工作树；不替代主控独立验收。

| 检查 | 实际入口 | 退出状态与证据 |
| --- | --- | --- |
| OpenUSD/资源/Scene/Tool/Command/完整包夹具 | `bun run script/gates/run-usd-assets.ts --out .runtime/usd-final-package` | 0；`usd-final-package/report.json`，5 个用例通过。原生格式、缺件、双实例/变体、源 SHA、搬迁重开、绝对引用副本、只读预览无写入、陈旧 CAS、整包夹具入库导出/坏 hash/缺 payload/预算。 |
| SimReady 离线来源协议 | `bun run test:ci --filter packages/scene-kit/test/simready-assets --json .runtime/ci-simready-deliver.json` | 0；4 个用例通过。包括真实本地 HTTP 夹具经受控传输发出一次请求后拦官方跳转、允许镜像内跳转与取消。 |
| USD Viewer 矩阵行为 | `bun run test:ci --filter packages/viewer/test/usd-visual --json .runtime/ci-viewer-usd.json` | 0；同帧矩阵、父级旋转/缩放不重复叠加、源身份拒绝通过。 |
| 既有保存 Tool 回归 | `bun run test:ci --filter packages/scene-kit/test/scene-save-tool --json .runtime/ci-save-plugin.json` | 0。 |
| 既有网络回归 | `bun run test:ci --filter packages/scene-kit/test/network-assets --json .runtime/ci-network-regression.json` | 0。 |
| 既有增量保存/原生材料 | `bun run test:ci --filter packages/scene-kit/test/scene-save-changeset --json .runtime/ci-changeset-usd-fixed.json` | 0；5 个用例通过。合法 USD 夹具与派生预览资源按实际合同核对。 |
| 发行 payload 合同 | `bun run test:ci --filter distribution/linux/payload-contract --json .runtime/ci-usd-payload-fixed.json` | 0；24 个用例通过。 |
| 两个 TypeScript 门 | `./node_modules/.bin/tsc --noEmit -p tsconfig.json`；`./node_modules/.bin/tsc --noEmit -p script/tsconfig.gates.json` | 均 0；`tsc-deliver.log`、`gate-tsc-deliver.log`。 |
| 源码构建 | `bun run script/build-plugins.ts scene-kit viewer sim-isaac` | 0；`build-deliver.log`。未构建发行归档、未发布。 |
| 构建后真实 Node 工具 | `node .runtime/built-usd-tool-smoke.mjs` | 0；`built-usd-tool-smoke.log`。载入 `scene-kit/dist/plugin.js`，主动把 cwd 改为 `/tmp`，USD 经真实 ToolRegistry 入库/挂载成功，证明默认解释器和 worker 不依赖会话 cwd。 |
| 已有解析器检查 | `./distribution/linux/install-usd-parser --check` | 0；`usd-installer-check.log`，版本 `(0,26,5)`。 |

## 真实 Isaac 物理与 Viewer 消费

复跑入口：

```bash
bun run script/gates/run-usd-isaac.ts --isaac-python /已有Isaac解释器的绝对路径/python --out .runtime/新的独立输出目录
```

本轮实际使用已有 Isaac SDK，CPU、`rendering:none`，没有修改 EULA 或系统配置。证据位于 `.runtime/native-isaac-viewer/receipt.json`，配套 `initial-frame.json`、`final-frame.json` 和 `portable/scene.json`；日志为 `native-isaac-viewer.log`。进程已释放。

实测 8 项通过：

1. 静态 USD 与关节 USD 均为 `native-source`，collisionCoverage=`COMPLETE`。
2. 源根 `z=.5` 加实例 `z=.1` 的 collider 实测 `z=.6`。
3. 同一 USD 两实例的 small/large variant 分别产生半尺寸 `.5` 与 `1`，源资产身份保持不变。
4. source prim `/Prop/Cube` 对应不同实例的不同 runtime prim；关节资产中的重复 leaf `Cube` 保留 `/Robot/Base/Cube` 与 `/Robot/Link/Cube` 完整身份。
5. `Hinge`、关节限位和 drive 的刚度、阻尼、力限由原生引擎读取。
6. 推进 500 个真实物理步，目标 `.3 rad`，最终 `.3177264035 rad`，测试容差 `.03 rad`；这是该 fixture 的控制响应，不推导抓取/操控任务成功。
7. 同一 Viewer 更新函数将 `/Robot/Link/Cube` 从 `[1,0,1]` 更新为 `[0.9749742150,0.1562038064,1]`；与同 Frame 原生 collider 读回逐坐标相等，2 个绑定 shape 更新、无未匹配 body。
8. 源 USD SHA-256 前后相同；Provider 已正常关闭。

这些是原生物理与 Three 对象消费证据。没有 RTX 成像、完整工作台人工视觉、交互可达性或性能容量验收；它们不能被本门的绿色状态代替。

## 真实 SimReady 来源阻断

- `nvidia/simready-assets@653d91e182011f357cf1644013cc94ddf194d349` 的 `box_cardboard_a01/com.nvidia.simready.packaging.json` 与 BOM 已取得并核对 metadata SHA。BOM 共 30 个文件、21,502,613 字节。
- 整包与逐文件请求都只走 `hf-mirror.com`；首件 `simready_usd/sm_box_cardboard_a01_01.usd` 被镜像重定向到官方 `*.hf.co` 的 `/xet-bridge-us/...`，现有 HF 请求守卫在实际请求前拒绝。完整包 0/30 文件通过；未声称可用包。具体日志：`.runtime/pull-bom-package.log`、`.runtime/nvidia-package-download.log`。
- `Robotiq-Official/simready-assets@7bb7b202d9e5f9749f3cee91d1c7f585ba70a5db` 的 `Robotiq_Hand_E` descriptor 声明的 `com.nvidia.simready.root_usds.json` 和 `Package-Candidate` metadata 在本轮镜像对象清单中不在场，根 metadata 的精确请求返回缺件；保留 descriptor/BOM，不重建或猜测缺文件。日志：`.runtime/robotiq-root-download.log`。

因此本轮不能满足“至少一个真实 SimReady 完整包”的验收项。继续需要镜像具备相应对象且不跳转受禁域，或由用户明确授权其它来源；不得静默切换官方端点。本地合法完整包夹具只验证产品协议/闭包/保存路径，不替代这个外部条件。
