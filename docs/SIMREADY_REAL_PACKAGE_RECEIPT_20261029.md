# 真实 SimReady 小包与受限 CDN 例外回执

时间：2026-10-29，新加坡时间。状态：**部分完成**。本次 NVIDIA 纸箱包的真实字节、产品导入、便携搬迁和 GPU/none 原生物理链路完成；源 SDF 碰撞在纯 CPU/none 中具名拒绝，详见末节更正。Warehouse 托盘仍有具名依赖阻断，纸箱材质仍有明确显示损失。完整工作台视觉由主控独立验收，本回执不代替该层结论。

## 固定来源与实际字节

```json
{
  "repoId": "nvidia/simready-assets",
  "revision": "653d91e182011f357cf1644013cc94ddf194d349",
  "packagePath": "box_cardboard_a01/com.nvidia.simready.packaging.json"
}
```

源 descriptor 声明 `CC-BY-4.0`，package ID 为 `simready.hf.nvidia.simready-assets.box_cardboard_a01.2026.10.08_223649139513`。实际 30/30 BOM 文件，21,502,613 字节，逐件大小及源 SHA256 全部一致；含 USD/layers、PNG、MDL 和原缩略图，不是仅登记 metadata 或生成替代模型。

descriptor 与 BOM 使用本轮开始前已存在的固定 revision 缓存，并重新核验原字节：

| 原 metadata | 字节数 | SHA256 |
|---|---:|---|
| `com.nvidia.simready.packaging.json` | 562 | `04564849ff24749775961a514a895909af6bc32113d185d359a20000d8c341d4` |
| `.metadata/com.nvidia.simready.packaging.bom.json` | 7116 | `2e84f1414884ec776cb8fa67021688b87c1ab79a3b0083ce5eba3abb3679fecc` |

旧缓存位于实施树 `.runtime/nvidia-source/box_cardboard_a01/`，两件 mtime 分别为 2026-10-28 18:12:19、18:14:53 +08。先前 `nvidia-descriptor-download.log`、`nvidia-bom-download.log` 和 `lyapunov-pull-receipt.json` 保留。主控独立交叉核验旧 revision 缓存、Git blob ETag、descriptor SHA 与 BOM pin；当前严格镜像 metadata 刷新则跳向官方 Hub resolve，已在实际请求前拒绝。**缓存核验不记为当次镜像刷新成功**，见主控 `cdn-controller/strict-source-metadata.log`。

## 本次局部网络授权

本轮依据 `receipts/20261028-simready-human/CDN_EXCEPTION_PLAN_20261029.md` 的用户明确授权，通过任务脚本向现有 `SimreadyOptions.fetchBytes` 注入获取函数。起始 URL 限固定 revision/descriptor/BOM 清单；每跳仍复用 `assertPublicHttpsURL` 和 `fetchPublicHttpsBytesWithRetry` 的公网检查、匿名请求、代理路由、超时、取消与累计计费。官方 Hub API/resolve 中间页仍禁止，未修改全局 hf 包装、产品默认白名单或 Host 配置。

实际请求域只有 `hf-mirror.com` 与镜像返回的 `cas-bridge.xethub.hf.co`，共 31 与 24 条请求记录；日志仅保留 hostname/path，不保存签名查询串，不发送账户 Authorization/Cookie。纸箱实际响应体网络字节 12,577,390；同 SHA 内容由局部已核验缓存复用，产品包仍保留全部 30 个源路径。加上托盘有限尝试 89,074 字节，本轮合计 **12,666,464 字节，小于 64 MiB**；纸箱也小于单包 32 MiB 预算。

临时例外已结束。`download-exception-closed.json` 封存计数，两个取件脚本已在任何联网前检查结束标记；之后重取需要新的明确授权。离线复核入口仍可使用，产品默认镜像纪律保持严格。

## 真实包暴露的便携缺陷与修复

基线 `bbdd1099` 上，三份不同路径的 `MuJoCo/Newton/PhysX/disabled.usda` 内容相同，归档按内容复用落点，使两条相对 layer 路径消失。保存后的既有闭包复检正确拒绝出包；主控在自己的独立导入中也复现，保留 `cdn-controller/import-r1/receipt.json`。

修复提交 **`aeca588902cb9e4e53a977043291b324d575cb53`**，只修改 `packages/scene-kit/src/portable.ts` 和既有 `usd-native.test.ts`：USD 依赖保留原相对路径，可能改写绝对引用的 USD layer 使用独立副本，避免硬链接串改；不可改写的纹理字节仍可按既有规则复用。没有把源 layer 别名重写为同一条路径，也没有更改原件或源 BOM。

新增原生回归使用同字节、不同深度的两份 layer，分别将绝对依赖改为 `../geometry.usda` 和 `../../geometry.usda`，确认副本 inode 独立、源 SHA 不变；删除原件和原资源库后，搬迁场景仍可独立重开。

## 产品与原生实测

实际 `simreadyImport` 后 `ResourceLibrary.verify.valid=true`。同资源挂载两个实例；仅 B 修改源 `PhysX` variant，A 与原件默认选择保持不变。源 `PhysX Disabled` 只移除引擎专有覆盖，中性 Physics layer 仍声明刚体/碰撞，不把该名称解释为关闭全部物理。恢复 B 后重复离线导入保持同一资源版本。

便携包搬到独立根，原导出目录改名不可用，再用独立 `SceneOperations` 重开：全部资源与 Sdf 依赖位于新根，30 件源文件仍逐 SHA 匹配 BOM，原件全部不变。提交后另一次 `verify-box.ts --out .../replay-proof` 在新目录完整离线复跑通过，目标为 `aeca5889`。

真实源默认 `metersPerUnit=1`、`kilogramsPerUnit=1`、Z-up，PhysX Enabled，1 个刚体、1 个 collider，无关节。Isaac CPU/rendering:none 实测两个同源实例独立下落、接触读回和同 Frame 的源 prim→runtime prim→Viewer 更新。实施方物理步 1→114，两个 body 高度约 1.199/1.499→0；每体 6 条接触记录，显示各更新 1 个 mesh，源 30 件 SHA 不变，关闭后 worlds=[]。该轮物理代码为 `bbdd1099`，仅 portable 窄修尚未提交；物理/Viewer实现与后续 `aeca5889` 无差异。

主控又在固定 `aeca5889` 独立通过真实导入、双实例、搬迁重开（7.21 秒）及 Isaac 原生检查（12.76 秒，closed=true），包括动态碰撞体、下落、同 Frame Viewer 与独立 source/runtime 身份。证据为 `receipts/20261028-simready-human/cdn-controller/candidate-checks/receipt.json` 和 `native-r2/receipt.json`。

## 显示与来源限制

- 源材质同时含 `UsdPreviewSurface`、`UsdTransform2d` 及 MDL。当前 Viewer 派生 1 个几何、0 个纹理，明确报告 `USD_TEXTURE_UV_NETWORK_UNSUPPORTED` 和 normal 通道未支持；原 PNG/MDL/网络全部保留。当前是受限几何/基础色显示，不能宣称原厂纹理外观还原。
- 该源实际 collider 使用 SDF；原生体/碰撞与接触读回可用，但初始精确 overlap 审计返回 `UNVERIFIED`、几何 DTO 为 `unsupported`。不把它当作精确形状重叠证明。
- 原生 USD 的 MuJoCo/Newton 物理仍明确不支持；USD 蒙皮/动画、细分、任意 shader、Transform2d 等此前边界不因本包取件改变。
- 第二对象 `nvidia/PhysicalAI-SimReady-Warehouse-01@c7fe115cb79c7ddbd0532630d7768b5736b0ecc4` 的 `Props/general/Pallet_A1/Pallet_A1_physics.usd`，实际取得并按源身份核验 2 件、89,074 字节；Sdf 发现 `Props/general/Pallet_A1/OmniPBR.mdl` 在固定文件身份表中不存在，故具名阻断，未注册资源、未猜替代路径或借 SDK shader 冒充源闭包。Robotiq 已知 metadata 缺件未重复请求。

## 场景与复跑入口

实施树任务根：`/home/s18/WS/Lyapunov/.worktrees/simready-usd-20261028/.runtime/cdn-exception-20261029`。

- 真实包根：`catalog/resources/network/simready/nvidia--simready-assets/653d91e182011f357cf1644013cc94ddf194d349/box_cardboard_a01/`。
- 实施方便携入口：`handoff/nvidia-box/scene.json`；`verified-bom-files.json` 为逐件清单，`handoff/evidence/` 汇总原生 Frame、来源核验与网络证据，`handoff-manifest.json` 给交接文件 SHA。
- 主控独立便携入口：`/home/s18/WS/Lyapunov/receipts/20261028-simready-human/cdn-controller/import-r2/portable-moved/scene.json`，可通过正式 `scene_open` 使用新 sceneId 打开。
- 任务局部取件脚本：`acquire-box.ts`、`acquire-pallet.ts`；域与累计字节摘要：`network-domain-summary.json`；逐跳日志：`network-ledger.json`、`pallet-acquire-receipt.json`。

离线复跑使用新的输出目录，不再申请网络：

```bash
cd /home/s18/WS/Lyapunov/.worktrees/simready-usd-20261028
HF_ENDPOINT=https://hf-mirror.com \
LYAPUNOV_PRODUCT_ROOT="$PWD" \
LYAPUNOV_USD_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/usd-python/bin/python \
node --experimental-strip-types .runtime/cdn-exception-20261029/verify-box.ts \
  --out .runtime/cdn-exception-20261029/新的离线复跑目录
```

这是复核工具脚本的位置，不是产品运行依赖。发行/主仓运行默认解析器仍位于各自产品根 `.runtime/usd-python`，不永久依赖此工作树。

## 自动检查与未测范围

| 实施方实际入口 | 退出与结果 | 任务根内报告 |
|---|---|---|
| `node --experimental-strip-types .../acquire-box.ts` | 最终 0；真实产品导入、30/30 | `acquire-box.log`、`acquire-receipt.json` |
| `node --experimental-strip-types .../verify-box.ts --out .../replay-proof` | 0；独立新目录完整离线复跑 | `replay-proof.log`、`replay-proof/verify-receipt.json` |
| `node --experimental-strip-types .../isaac-box.ts` | 最终 0；真实双体物理与共享 Viewer 函数 | `isaac-box.log`、`isaac-native/receipt.json` |
| `bun run script/gates/run-usd-assets.ts --out .../native-alias-gate` | 0；8 个用例 | `native-alias-gate/report.json` |
| `bun run test:ci --filter packages/scene-kit/test/simready-assets.test.ts` | 0；5 个用例 | `ci-simready.json` |
| `bun run test:ci --filter packages/scene-kit/test/warehouse-catalog.test.ts` | 0；6 个用例 | `ci-warehouse.json` |
| `bun run test:ci --filter packages/scene-kit/test/portable-` | 0；本线默认清单实际执行 relocation 文件的 3 个用例 | `ci-portable.json` |
| 根 `tsc --noEmit -p tsconfig.json`、`bun run script/build-plugins.ts scene-kit`、`git diff --check` | 均 0 | `tsc.log`、`build-scene-kit.log` |
| `node --experimental-strip-types .../acquire-pallet.ts` | 2；缺源身份的 MDL 依赖，停止 | `pallet-acquire-receipt.json` |

初次任务脚本的过严镜像 resolve-cache 路径判断、对 PhysX Disabled 的错误物理假设、真实便携缺件反例及原生回执脚本字段修正，均保留在本轮日志；最终通过不抹去先前失败。主控已对 `aeca5889` 独立运行上述相关门、根类型检查与全插件构建，全部退出 0；完整命令和时长见其 `candidate-checks/receipt.json`。未为本次数据/窄修再跑全仓 CI，既有 marketplace 5 秒基线超时结论未更改。未运行 RTX、性能容量或生产发布；最终完整工作台外观仍由主控独立记录。

## 2026-10-29 01:29 +08：更正纯 CPU 物理结论与 SDF 启动预检

**更正**：前述 `physicsDevice=cpu, rendering=none` 直接 Provider 通过，发生在 GPU 设备可见的宿主；它没有建立“无 CUDA 设备的 CPU 隔离通过”。真实工作台 CPU sandbox 将 GPU 节点隐藏后，主控观察到 `sim_open` 持续初始化。Kit 日志先在约 5.02 秒完成 SDK/扩展/PhysX bootstrap 并发出 ready；随后 Warp 仅见 CPU、CUDA driver 不可用，禁用 Fabric 后 `omni.physx.cooking` 报 `Cannot create PxCudaContextManager` 和 `bad_function_call`。日志为 `cdn-controller/import-r2/portable-moved/.lyapunov/sessions/session-f1a737d0-5cd1-4510-bd00-777147ec4af8/engine-cache/isaac/kit/2/logs/Kit/physics-cpu/0.1/kit_20261029_010552.log`。

实际源 collider 的 `UsdPhysics.MeshCollisionAPI` approximation 为 `sdf`。已安装 SDK 的 `omni.physxtests/tests/PhysxTriangleMeshCollisionAPI.py` 明确以该值触发 SDF cooking。后续相同 CPU 隔离的正反实测进一步确认：当前所选 SDF 烘焙需要 CUDA，不能把此失败归为所有 CPU Kit 均不可启动。主控已从正式 UI 取消旧初始化并确认旧 worker/Host 退出，另用显式 GPU/none 的完整 Host 隔离路径加载成功、显示原生碰撞并观察两纸箱下落；源 SDF 未改变。

本次窄修在 `scene_adapter.py` 的 `require_native_usd_sdf_device`：转换完成、创建实际 runtime stage 之前，以匿名 session layer 组成当前选中 prim 与实例 variants，遍历 instance proxies；仅当前实际启用、`collisionEnabled` 非 false 的 SDF mesh 在 CPU/none 路径抛出 `ISAAC_SDF_COOKING_REQUIRES_CUDA`，消息标记 `usd-sdf-preflight`。未选中 variant、普通网格/几何、人体和显式 GPU 路由保持原处理。固定公开说明告知选择 GPU 物理，不回显内部源路径；不开放设备、不改源碰撞、不自动切换 variant，也不改 Fabric/调度框架。Isaac 人体仍限定 CPU/none，不因此扩成 GPU 人体支持。

实施方自有 bwrap 实测（不是正式 Host 会话策略验收）：宿主只读、仅本报告根可写、无网络；每条 worker 实际 `/dev/nvidia*=[]`、`/dev/dri/*=[]`、`cuInit=100`（CUDA_ERROR_NO_DEVICE）。

| 实际场景 | 结果 | 耗时与收尾 |
|---|---|---|
| 原纸箱默认 PhysX Enabled、原 SDF | 具名 `ISAAC_SDF_COOKING_REQUIRES_CUDA`，未进入 runtime stage/cooking 等待 | 7.62 秒，closed=true |
| 同原件显式选择 PhysX Disabled | CPU/none 实际加载成功；中性刚体/碰撞仍保留，这是另一个明确变体，不作为默认替代 | 9.18 秒，closed=true |
| 简单原生 USD 与人体同世界 | CPU/none 实际加载、人体原生 0.2 秒行走成功 | 10.07 秒，closed=true |

脚本和实测位于实施树 `.runtime/usd-sdf-cpu-20261029/isolated-native.ts`、`native/receipt.json` 及每个 case 的 `sandbox-device-proof.json`。源 30 件 BOM 文件在新检查后仍逐 SHA 一致。该检查证明无 GPU 的设备边界与原生结果，正式工作台/沙箱仍由主控独立复验。

本轮以 `1024c1e6` 加本次窄修工作树实测，命令/退出码：

- `TESTCI_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/conda/envs/isaac/bin/python LYAPUNOV_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/conda/envs/isaac/bin/python bun run test:ci --filter packages/sim-isaac/ --json .runtime/usd-sdf-cpu-20261029/ci-sim-isaac-ready-env.json`：0，18 文件、116 用例通过，无失败或跳过。未启动 Kit 的 AST/stub 单测覆盖实际函数分支、variant/collisionEnabled 与调用早于 runtime stage；不把这些 mock 断言当作隔离物理证据。
- `bun run test:ci --filter packages/lyapunov-contracts/test/command-privacy-error-code.test.ts --json .runtime/usd-sdf-cpu-20261029/ci-public-error.json`：0，18 用例通过。
- 既有 `script/gates/run-usd-isaac.ts`，显式使用已有 Isaac 与 USD 解释器：0，简单 USD 八项真实门通过，closed=true；报告 `simple-usd-gate/receipt.json`。
- 既有 `packages/human-crowd/scripts/isaac-human-usd.ts`，显式使用同一已有解释器：0，人体十一项真实门通过，closed=true；报告 `human-isaac-gate/receipt.json`。
- 根类型检查、`bun run script/build-plugins.ts sim-isaac lyapunov-shell`、`git diff --check`：均 0，日志 `tsc.log`、`build.log`。

首轮正式 Isaac 过滤 CI 使用默认 Python，三项因缺 NumPy 失败；第二轮既有 sim-python 仍缺 Pillow，一项失败。两份失败报告保留为 `ci-sim-isaac.json`、`ci-sim-isaac-with-numpy.json`，没有安装依赖、修改测试或降低门槛；最终使用既有完整 NumPy/Pillow 环境复跑通过。本轮没有任何网络取件、源资产改写或生产操作。最终新版本正式 Host 的快速具名拒绝由主控继续复验。

## 第三轮材质切片：原厂 PreviewSurface 三纹理与法线方向

依据第三轮 `receipts/20261029-simready-human-r3/SIMREADY_PLAN.md`，以 `6c43b2cc` 加本切片工作树实测。此节更正前文“1 mesh/0 纹理”的旧显示状态；SDF 精确重叠和托盘标准库依赖继续实施，不因材质切片通过而宣称第三轮全部完成。

`usd_materials.py` 现在解析有界 `UsdTransform2d` 链，按官方 [UsdPreviewSurface 规范](https://openusd.org/release/spec_usdpreviewsurface.html)先缩放、再旋转、最后平移；组合为列主序 3×3 `UsdTextureBinding.uvTransform`。`normalTexture` 保留源 RGB、raw、scale/bias，在共享 Three 标准材质的切线基中解码一次；没有叠加第二次 `*2-1` 或手动翻转绿通道。`usd_asset.py` 同时保留作者法线、插值和左右手面方向，几何数据仍在派生资源内，不写入 Scene 网格数组。

真实纸箱现在为 **1 mesh / 3 个原 PNG 纹理**：Albedo 为 sRGB，ORM 的 g/b 分别接 roughness/metallic，normal 为 raw，源 scale=2、bias=-1。只消费原 PreviewSurface 实际连接，不根据 ORM 文件名猜接未声明 AO；原 MDL 和完整材质网络继续保留，不宣称执行了 MDL。30/30 源文件在新检查后仍逐 SHA 匹配原 BOM。

定量检查覆盖两级非交换 SRT、indexed 非均匀 faceVarying UV、作者 uniform 法线与 leftHanded winding。作者法线故意偏离几何重算法线 45 度，展开后的实际 Three normal 数值保持作者方向。另用共享 `loadUsdVisual` 生成的真实 Three 材质做浏览器像素实验：同一 +Y/+Z 光照下，flat normal 灰值 183、+Y tangent normal 255、仅镜像 V 后为 0，证明 UV 反射的切线基方向生效；这项是材质单元实验，不冒充完整工作台验收。

本切片的实际自动入口均退出 0：

- `bun run script/gates/run-usd-assets.ts --out .runtime/simready-r3-20261029/material-native-gate`：9 个真实 OpenUSD 用例通过，包含新增定量夹具；报告 `material-native-gate/report.json`。
- `bun run test:ci --filter packages/viewer/test/usd-visual.test.ts --json .runtime/simready-r3-20261029/ci-viewer.json`：2 个用例通过，实际 Three 材质/纹理/矩阵、shader normal 解码与旧字段兼容保持。
- 根 tsc、门 tsc、`bun run script/build-plugins.ts scene-kit viewer`、`git diff --check`：均通过。日志位于本树 `.runtime/simready-r3-20261029/`。
- `bun run .runtime/simready-r3-20261029/normal-quant.ts`：真实 WebGL 像素实验通过，浏览器退出 0；报告 `normal-quant/receipt.json`。
- 现有材质门新增可选 `--source`，默认自有案例不变。对原厂 USD 执行 `bun run script/gates/run-usd-materials.ts --source <原纸箱USD绝对路径> --out .runtime/simready-r3-20261029/real-materials --screenshot`：真实共享 Viewer 与浏览器退出 0，两个实例 `hasTextures=true`、`hasNormalMap=true`、Viewer errors=[]；源资源 verify.valid=true。截图已查看，纸板纹理和胶带可见。

实际入口：

- 场景：`/home/s18/WS/Lyapunov/.worktrees/simready-usd-20261028/.runtime/simready-r3-20261029/real-materials/portable/scene.json`。
- 截图：同目录上一级 `viewer-canvas.png` 与 `viewer-page.png`；`receipt.json`、`OPEN_IN_WORKBENCH.md` 可直接复核。
- 实读源 shader/纹理事实：本轮根 `box-material-facts.json`；没有重复下载原纸箱包或开启旧 CDN 例外。

图像是共享 Viewer 产物，主控仍在固定提交上独立做 Cua 工作台验收。位移、任意 shader、MDL 执行、UDIM 等范围未在此切片扩项。

## 2026-10-29 05:25（新加坡）：独立标准模块闭包切片

状态：**标准模块接入完成；真实托盘完整资产仍因三件原 PNG 阻断；SDF 精确审计继续研究。** 材质 `27168dad`、`c65b06e7` 已由主控独立通过原生门、类型、构建和真实工作台 GPU 运行显示，截图位于 `/home/s18/WS/Lyapunov/receipts/20261029-simready-human-r3/material-acceptance/ui/final.jpg`。以下模块切片仍待主控在固定提交独立验收，不复用材质验收冒充该切片通过。

真实托盘选择为 `nvidia/PhysicalAI-SimReady-Warehouse-01@c7fe115cb79c7ddbd0532630d7768b5736b0ecc4`，入口 `Props/general/Pallet_A1/Pallet_A1_physics.usd`。两件源 USD 已核验且原字节未改。实际 `/RootNode/Materials/Pallet/Shader` 声明 `OmniPBR.mdl` / `OmniPBR`，使用六个输入：`diffuse_texture:asset`、`enable_ORM_texture:bool`、`metallic_texture_influence:float`、`normalmap_texture:asset`、`ORM_texture:asset`、`reflection_roughness_texture_influence:float`。这六项与已安装 SDK 的标准模块导出名称和类型逐项兼容；不是仅看同名文件。

独立来源为本机 Isaac `isaacsim-kernel==6.0.1.0` 中的 NVIDIA Omniverse Core Materials **2.1.0**，要求 MDL **1.8**；SDK METADATA SHA256 为 `9aba28cc55e18f635fe9eeff574a78864cef4f70f4f01063ecbfb66d8f1c2234`。真实 `import/using` 闭包含 `Base/OmniPBR.mdl`、`Base/OmniPBRBase.mdl`、`Base/OmniPBR_ClearCoat.mdl`、`mdl/nvidia/core_definitions.mdl`、`support_definitions.mdl`、`aux_definitions.mdl` 六件模块，另含原 VERSION 与 `PACKAGE-LICENSES/omni-core-materials-LICENSE.md`。六件模块均含 BSD-3-Clause SPDX；许可全文、版本、逐件 SHA/大小、编译器内置模块要求写入独立 manifest，不掺入 HF 原文件表。

关键代码：`usd-standard-libraries.ts` 创建/核验/登记有界独立资源，并按实际声明匹配唯一兼容库；`warehouse-assets.ts` 将原 HF 与独立标准模块身份分开，组合来源不覆写旧库版本位置；`usd_materials.py::standard_library_context` 在每次解析中重验 manifest 和所有文件，仅绑定局部 Ar context。挂载资源顺序为主 USD、派生预览、标准库，无额外实体。`portable.ts` 保留标准库内部相对布局；`resources.ts` 仅为已解析验证的该类资源从 manifest 恢复 BSD 许可。没有新 Python sidecar，没有新增 Tool 或全局 resolver。

实际产物根均为 `/home/s18/WS/Lyapunov/.worktrees/simready-usd-20261028/.runtime/simready-r3-20261029/`：

- `standard-library/registered-entrypoint.json`：真实 SDK 经正式本地登记脚本形成的独立资源，ID `usd_std_bcdf2b11814d0f6596607165`，manifest SHA256 `bcdf2b11814d0f65966071659add7b67938df32e397f776892b5e9f31b68ce14`，含完整八件文件及 manifest 自身闭包。
- `standard-library/real-diagnostic/receipt.json`：实际两原 USD 的声明兼容、局部 Ar 将 `OmniPBR.mdl` 解析到上述独立资源的证据；其 `unresolved` 仅为三张原 PNG。明确 `assetRegistered:false`、`diagnosticOnly:true`、`complete:false`，不是完整托盘场景。
- `stdlib-checks/`：本切片正式 CI、类型、构建日志；原生门的自有合法 fixture 做实际 OpenUSD 解析，标准库与 HF 身份分开，便携搬迁后删除旧 SDK/资源根，再重开/挂载/核验并恢复许可。Warehouse 测试另做跨库相同 LICENSE 字节的内容去重对照，确认各库 JSON、模块和许可的相对路径完整。

实际命令及退出码（工作目录为上述自有工作树，`HF_ENDPOINT=https://hf-mirror.com`；USD 解释器为主仓独立 26.5；Python CI 只读使用既有 Isaac 解释器）：

| 命令 | 实测 | 日志/报告，相对上述产物根 |
| --- | --- | --- |
| `bun run script/gates/register-usd-standard-library.ts --core-root /home/s18/WS/Lyapunov/Dev/.runtime/conda/envs/isaac/lib/python3.12/site-packages/isaacsim/kit/mdl/core --resource-root .runtime/simready-r3-20261029/standard-library/catalog --out .runtime/simready-r3-20261029/standard-library/registered-entrypoint.json` | 0；不联网，不写 SDK，不建实体 | `standard-library/register-entrypoint.log` |
| `bun run test:ci --filter packages/scene-kit/test/simready-assets --json .runtime/simready-r3-20261029/stdlib-checks/simready.json` | 0；5 pass | `stdlib-checks/simready.json` |
| `bun run test:ci --filter packages/scene-kit/test/warehouse-catalog --json .runtime/simready-r3-20261029/stdlib-checks/warehouse.json` | 0；7 pass | `stdlib-checks/warehouse.json` |
| `bun run test:ci --filter packages/scene-kit/test/portable --json .runtime/simready-r3-20261029/stdlib-checks/portable.json` | 0；3 pass | `stdlib-checks/portable.json` |
| `bun run script/gates/run-usd-assets.ts --out .runtime/simready-r3-20261029/stdlib-checks/native` | 0；10 pass | `stdlib-checks/native/report.json` |
| `./node_modules/.bin/tsc --noEmit -p tsconfig.json`、`-p script/tsconfig.gates.json` | 均 0 | `stdlib-checks/types.log`、`gate-types.log` |
| `bun run script/build-plugins.ts scene-kit viewer`、`git diff --check` | 均 0 | `stdlib-checks/build.log`，diff 无输出 |

本轮网络边界：旧 CDN 例外已关闭。新托盘 ledger 仅用于同一固定 revision 的必要文件，64 MiB 上限；首张 Albedo 的镜像 GET、`?download=true`、HEAD 均跳转官方文件 resolve，中转尚未获授权，全部在下一请求前拒绝；实际取件 body 为 0，未请求官方端点。Normal/ORM 尚未发请求，不能把首件跳转推断当成三件都已实测失败。三件固定身份为：

| 固定目录 `Props/general/Pallet_A1/materials/textures/` 下文件 | 字节 | SHA256 |
| --- | ---: | --- |
| `T_Pallet_A1_Albedo.png` | 5915406 | `7ea41b5b405ec6a115ae68d61c1911c50c507cff1d0c500797850f5b0eeeecec` |
| `T_Pallet_A1_Normal.png` | 3815179 | `6f4baf3f88bc82cdceb09ef648366a2901039fbfb6c95c48f6889d25137da7d7` |
| `T_Pallet_A1_ORM.png` | 3156209 | `b5fee96c46b1f2d9e2d7459690ae7e6da643225a8b0c656d52206b10ce3a5a17` |

授权/网络证据在 `pallet-fetch/{local-acquisition-contract.json,ledger.json,needed-exact-targets.json,receipt.json}`。没有用其它图片替换源纹理，没有把 SDK 模块伪装为 HF BOM。标准模块读取与测试通过不代表 MDL 在 Three 执行；完整真实托盘导入、便携搬迁和原生世界仍待三张原 PNG 到位后继续，不宣称已完成。

材质审查后续窄修：Transform2d 的 scale/rotation/translation 若带连接，当前明确拒绝该纹理网络并给出 `USD_TEXTURE_UV_PARAMETER_CONNECTION_UNSUPPORTED`。负对照中 rotation 本地 fallback=-30°、接口连接值=45°，实际不再把 fallback 当已求值结果；常量参数的原厂纸箱不受影响。正式原生门 `material-connected-gate/report.json` 仍为 9 用例、退出 0。截图页 external 分支标题改为“真实USD双实例 / 原厂PreviewSurface”。

旧资产刷新也已实际复跑：从上一轮 0 纹理的纸箱便携场景打开，通过原 `setUsdInstance`（同 `scene_usd_instance`）逐实例保留原 prim/variants 并刷新，两个旧实例均变为 3 纹理和 normal；源 resourceId/version、transform、实例 variants 逐项不变。脚本 `.runtime/simready-r3-20261029/refresh-old.ts` 退出 0，报告 `refresh-old/receipt.json`，可打开的新场景 `refresh-old/portable/scene.json`。操作说明已补入 `SIMREADY_USD.md`，没有实施全局缓存迁移。

最终补验：新增 manifest 来源字段/预算核验后，`warehouse-final.json` 7 pass、`native-final/report.json` 10 pass 与 `gate-types-final.log` 均退出 0；主来源字节及资源身份未改。该切片不修改 Isaac 产品物理代码，SDF 探针结果另行回执。

## 2026-10-29 05:35（新加坡）：SDF 同世界查询与反馈兼容边界

状态：**部分完成诊断，精确初始 SDF 重叠仍阻断。** 这里没有将实验 GPU 数据模式接入产品，没有把有限点样本或重叠 bbox 改标为 CLEAR/OVERLAP，也没有重建第二 World 或推进后回滚。现有 `initial_overlap.py` 对 SDF 保留 UNVERIFIED，既有 CPU-SDF 拒绝、GPU 物理支持与原 geom contact/Frame 所有权保持。

新增显式诊断入口 `script/gates/probe-usd-sdf-native.py`。它读当前产品 World 的真实初始化代码，默认完全不替换产品初始化；只有传 `--experimental-gpu-tensors` 才在探针的内存源码中显式切换初始化设置，锚点必须唯一。该实验不修改产品文件或源 USD，不属于发行运行时 helper，不新增 payload 必需项。每个进程只有一个执行 World。先记录 step0 查询快照，再另行执行明确的 Hinge 有界动作检验反馈；`--feedback-steps 0` 可只运行无 tick 查询。结束先 `world.close()`，记录 `worldClosed:true`，再关闭自己的 Kit，两个正式探针进程均实际退出 0。

复跑使用合法本地真实纸箱 Scene 和既有自有 Hinge fixture：

```bash
cd /home/s18/WS/Lyapunov/.worktrees/simready-usd-20261028
export HF_ENDPOINT=https://hf-mirror.com
export LYAPUNOV_PRODUCT_ROOT="$PWD"
export LYAPUNOV_ISAAC_DEVICE=cuda:0
export LYAPUNOV_ISAAC_RENDERING=none
export LYAPUNOV_ISAAC_CACHE="$PWD/.runtime/simready-r3-20261029/sdf-query-probe/cache"
export LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libstdc++.so.6
export LD_LIBRARY_PATH=/home/s18/WS/Lyapunov/Dev/.runtime/conda/envs/isaac/lib
/home/s18/WS/Lyapunov/Dev/.runtime/conda/envs/isaac/bin/python \
  script/gates/probe-usd-sdf-native.py \
  --scene .runtime/simready-r3-20261029/refresh-old/canonical-scene.json \
  --joint-source .runtime/usd-sdf-cpu-20261029/simple-usd-gate/source/joint.usda \
  --out .runtime/新的独立SDF兼容诊断目录
# 另一个独立进程/新目录，仅用来证明GPU数据模式的损失：同一命令加
# --experimental-gpu-tensors --keep-gpu-data-mode
```

实测 SDK 为 Isaac 6.0.1.0，`omni.physics.tensors` / `omni.physx.tensors` 为 `110.1.13+110.1.2.lx64.r.cp312.u7f4`。最终同源对照位于本树 `.runtime/simready-r3-20261029/sdf-final-baseline-r3{.log,/receipt.json}` 与 `sdf-final-gpu-r1{.log,/receipt.json}`：

| 检查 | 原兼容模式 | 仅探针 GPU 数据模式 |
| --- | --- | --- |
| 实际物理场景 | gpuDynamics=true、broadphase=GPU | 同左 |
| 原 SM legacy / Warp view | NumPy/cpu、Warp/cpu | Warp/cuda:0、Warp/cuda:0 |
| 查询阶段原 SM 两个 view 对象身份 | 保持 | 保持本实验初始化后的对象 |
| 同 stage 的独立 `create_simulation_view('warp', stage_id=...)` | 原 suppressReadback=false 时仍 cpu、SDF backend=None；额外无 tick 临时 true 后再建也仍 cpu，finally 恢复 false | 初始化前显式 GPU 数据模式才得到 SdfShapeView count=1、exact 源 collider 路径、valid=true |
| 查询前后时钟/控制/pose | 全相同 | 全相同 |
| 查询快照的 World / SDK 时钟 | stepIndex 0、simTime 0；SDK time 0.004 / steps 2 前后不变 | 同左 |
| 随后显式 400 步 Hinge 动作的 CPU 原生接触 | 最大4对、累计678对；native contact points 2292 | 0 |
| GPU body-pattern ContactView | 未替换原 contacts | 最多20点、最大738.637N；具 point/normal/separation/force，身份为 body |
| 六个原生 rigid/link 矩阵对同 Frame | 6/6 一致，含普通动态方块和 Hinge Link | 5/6；Hinge Link stale |
| 暂停、stop 后 manual 时钟/pose/控制 | 保持 | 保持 |
| 原生入口文件 SHA / closed | 前后同 SHA、closed=true | 前后同 SHA、closed=true |

SDK 初始化自身已有两次物理 warmup；此处如实记录 SDK 的 2 steps，不声称整个初始化从未积分。审计查询本身没有增加 World 或 SDK 步数、时间，也没有推进后恢复。

原兼容模式 exact instance-proxy collider、非 instanceable SDF 校准 mesh、通配 pattern 均失败；日志原文为 `CpuSimulationView::createSdfShapeView is not implemented yet`。因此不是只凭 backend=None 猜“没有 shape”。GPU 模式同一原路径立即 count=1，且源碰撞参数/文件未改。当前 Python `create_simulation_view(frontend_name, stage_id, backend)` 没有单独选择 GPU 数据设备的参数；追加一个 Warp frontend 不能把已初始化的 CPU 数据 backend 改成 GPU。没有调用 tensor reset、重新初始化物理或另造执行世界。

GPU 数据模式的两个实际损失不能接受：

- 接触：collider-pattern 试验 count/path 虽存在，SDK 明确报 `GPU contact info/filter for collider ... is not supported`，读数为 0；body-pattern 才有详细读数。`get_raw_contact_data` 的另一方身份只有 `other_actor_ids`，未暴露 shape/collider IDs，不能在多 collider body 下恢复现有 `geom1/geom2`。已有 `policy-registry/src/execution.ts` 按精确 foot geom 名与力阈值产生接触观测；`robot-workflows` 的 flight/pick-place/move-tcp 和 task predicates 也消费 geom，不能拿 body 名替代或清空旧 contacts。
- 位姿：Hinge 实际角最终为 0.205985 rad（目标0.2），GPU 原生 Link 为 position `[5.989429,0.102266,1]`、qz约0.10281；同 Frame 的 `usdBodyWorldPoses` 仍为 `[6,0,1]` 与 identity。`usd_observation.py` 经 `_native_world_matrix` 读该 Link，none 模式非根 Link 依赖 USD 写回；GPU 数据模式未写回，使 `viewer/src/index.ts::applyFrame` 消费的 `applyUsdBodyWorldPoses` 使用 stale 矩阵。正常兼容模式同场景完整矩阵一致。这个损失不能以 action completed 代替验证。

SDF 点 API 的实际布局还与部分注释不符：本机官方 `test_sdf_shape_view.py` 使用最后分量为距离、前三分量为梯度，与实测一致，即 **gradient.xyz / distance.w**。自有32分辨率稀疏 SDF 立方体中心返回 -0.40625（解析几何为 -0.5），近表面两个外点返回约0.100586、0.099854，符号/近表面定量对照通过，但不能因此把整个稀疏/量化场当作严格欧氏距离并假定 L=1。官方[PhysX 几何说明](https://nvidia-omniverse.github.io/PhysX/physx/5.6.1/docs/Geometry.html)说明稀疏 SDF 离表面更稀且可量化；当前 API 未给出 cooked 网格间距/全部子格、量化误差或保守覆盖界。有限点未命中仍不能证明 CLEAR。

最小后续路线：保留现有兼容数据模式，先要求与当前 Kit/PhysX ABI 匹配的原生只读查询入口，能够对当前 stage 的真实 collider pair 取得 cooked geometry/SDF，并明确支持 SDF-SDF/plane pair 及不支持返回；或暴露完整 cooked SDF、缩放与插值/量化界以实现有界覆盖证明。官方[PxTriangleMesh](https://nvidia-omniverse.github.io/PhysX/physx/5.6.1/_api_build/classPxTriangleMesh.html)有 C++ `getSDF/getSDFDimensions`，几何文档给出 `immediate::PxGenerateContacts` 线索，但这些并未由当前已装 Python 绑定暴露，当前也没有已核对匹配 ABI 的开发头文件；没有拉其它版本强接。`PxGenerateContacts` 对本 Kit 的 SDF pair、距离阈值及零结果含义仍须原生正反验证，不能先承诺它已解决精确 CLEAR。真正保守的原生 bounds 可作为安全广义相排除，不能把重叠 bounds 当实际相交；此轮未以该部分排除替代完整审计。

检查：`bun run test:ci --filter packages/sim-isaac/ --json .runtime/simready-r3-20261029/sdf-ci-sim-isaac.json` 退出0；这是现有离线/fixture 回归，不代表 SDF 精确原生能力通过。`69c1cccf` 的最终 `scene-kit/viewer` 构建另复跑退出0，日志 `stdlib-checks/build-final.log`。本段不改产品物理实现、通用调度器、权限、CPU/GPU规则或CI阈值。尚未完成 SDF 分离/相交/凹腔/地面完整精确审计门，不宣称本轮第三项目标全完成。

05:33 实测补充与版本更正：原兼容模式同一 World 增加 `--feedback-steps 0 --export-repx`，实际 `IPhysx.save_scene_to_repx()` 返回 true；导出前后 World/SDK 时钟、pose、控制与两个 SM view 身份仍完全相同，进程退出0、closed=true。产物 `.runtime/simready-r3-20261029/sdf-repx-probe/{compiled.repx,receipt.json}`。60,595 字节 XML 明确写 **PhysXCollection version="5.9.0"**，含实际 PxBVH34TriangleMesh 的 Points/Triangles、shape 和 pose；全文没有 SDF、distance、subgrid 数据。因此该已编译 mesh 出口仍不能恢复当前 cooked SDF 或量化覆盖界。前述5.6.1官方文档只是 API 线索，不是本机匹配 ABI；最小扩展需要与本机 **PhysX5.9.0 / omni.physx110.1.13+110.1.2** 匹配的开发接口/头文件，不能用5.6头文件硬接。现有 SDK Python 的 RepX 导出、convex representation、scene overlap 和 CPU tensor 路线均已具名实测或核对，尚无可保持原 readback/geometry 身份的 cooked-SDF/pair-query 入口。

## 2026-10-29 05:59（新加坡）：真实 Pallet 完整闭包、固定 OmniPBR 派生和显式静态米制案例

状态：**本线完整原字节、便携闭包、受支持材质可见与静态源碰撞验收通过；主控完整工作台独立验收待当前提交。SDF 精确初始审计依然未完成，不合并计为已解决。** `69c1cccf` 标准库切片已由主控独立通过 USD10、Warehouse7、SimReady5、portable3、root/gate types、全插件构建及真实SDK登记，并合入 Dev；报告 `/home/s18/WS/Lyapunov/receipts/20261029-simready-human-r3/stdlib-acceptance/receipt.json`。

用户随后明确授权“允许仅这三张固定原图的文件中转”。新合同只允许上述固定 revision/三个精确路径，从镜像实际 Location 匿名进入同文件官方 resolve 或公开文件 CDN，仍禁 `/api/`、登录、其它对象/版本；不重开旧例外、不修改产品默认网络规则。真实取回 **3/3 原 PNG，12,886,794B**，每件大小/SHA 与固定源表一致，随后封存。第一轮 Bun 在获授权的官方文件中转 TLS 验证失败，0 body；保留 `attempt-1-receipt.json`，未关闭 TLS 校验。改用 Node24.20.0 加本机已有 `/etc/ssl/certs/ca-certificates.crt`，实际成功三件均为 `hf-mirror.com` → `cas-bridge.xethub.hf.co`，官方 API/登录请求均0。完整新合同、逐hop ledger、三件校验、网络域摘要与 closed 位于自有 `.runtime/simready-r3-20261029/pallet-fetch-authorized/`；旧 closed SHA 仍为 `cc03ce1565d5bf09742b6e743b988520f5a2cd0eecbc6f1207f79a2b08795bb8`。

原托盘五件 HF 文件（两 USD + 三 PNG）完整核验后，经正式 `warehouseImport` → ResourceLibrary → Scene 导入。缺的 OmniPBR 继续作为独立 BSD 标准模块资源，未混入 HF 文件身份。源实际为厘米、Z-up、0 rigid body/1 collision/0 joint，碰撞近似声明为 convexHull；未改网格、碰撞近似、源 MDL 网络、源单位或补造源刚体。原厘米 USD 的 Isaac 启动如实触发米/千克/Z-up 拒绝。

按主控明确许可，本次静态案例另生成独立 m 包装 USD：在父 Xform 上 scale0.01，再引用原 `/RootNode`，源根的原变换继续保留。独立资源的既有 `legacySource`、随包 `derivation.json` 和来源 sidecar 记录原 resourceId/version/ref、原 SHA、原 prim 与比例；sidecar 的 `sourceProtocol` 明确为 `derived-usd-unit-wrapper-v1`，没有伪造 HF wrapper/BOM。包装 Scene 同时保留原 HF 资源引用和标准库引用，不自动替换其它 USD，不修改质量/惯量/关节，也没有给托盘添加刚体。

`usd_materials.py` 现在仅在标准库六件固定模块 SHA 与 Core2.1.0 全部匹配时，将 OmniPBR 常见输入派生到现有 PBR binding；源 shader 保持 `OmniPBR`，派生带模块 resource/version/SHA 与 `pinned-omnipbr-subset`。依据实际 SDK 源码：Albedo 替代 diffuse 常量后乘 tint；roughness/metallic 为 ORM g/b 与常量按 influence 线性混合；normal 为 raw，解码一次后按默认 DX 的 flip_tangent_v 翻转Y，bump_factor 作用于XY；AO默认权重0未误接。当前支持UV0/identity，未知模块、连接、非identity UV/投影或额外输入明确拒绝/警告，不运行任意 MDL、不伪造 PreviewSurface。

实际最终案例根为 `/home/s18/WS/Lyapunov/.worktrees/simready-usd-20261028/.runtime/simready-r3-20261029/`：

- `pallet-final-native-gate/original-portable/scene.json`：原厘米源 Scene，可显示原材质受支持子集；原生米制限制保留。
- `pallet-final-native-gate/portable-moved/scene.json`：显式米制静态包装，可在工作台 `scene_open`。生成后已删除自有 `source-root`，用另一全新资源库重开；全部资源版本、原图、标准模块、许可和 Sdf 闭包核验通过；原 HF USD SHA 不变。
- `pallet-final-native-gate/{receipt.json,native/receipt.json}`：SDK Provider CPU/none 实测，原cm具名拒绝并closed；m包装真实1个静态 collider。独立1kg方块由z约0.90865落到0.25844，托盘top约0.20865；同World显式Hinge600步后4个准确 geom 接触点，支撑力竖直和 **9.80622N**，closed=true。它是宿主 Provider 证据，未冒称 CPU 设备隔离/bwrap 或完整工作台物理验收。
- `pallet-viewer-final/{viewer-page.png,viewer-canvas.png,receipt.json}`：实际共享Viewer/Edge无头 WebGL，状态PASSED、browserExit0、errors=[]，1个材质有原 Albedo/ORM/normal；已查看图像，原木纹、印字/SAFETY与木块端面细节可见。浏览器/本机服务均结束。此项不是完整工作台 Cua 验收。

更正首次落体断言：`pallet-native/receipt-r1.json`、`receipt-r2.json` 失败是自有脚本只从未请求 contacts 的订阅 Frame 判断，未使用显式 `observe({contacts:true})`；完整测量已保存。修正取数后 `pallet-native/receipt.json` 和独立稳定门的 `native/receipt.json` 均通过，未修改产品接触代码或放宽物理判据。

稳定复跑入口，不联网取件，`--verified-source` 必须包含上述固定五件原文件的 `Props/...` 路径（每件按既有目录身份再验）：

```bash
HF_ENDPOINT=https://hf-mirror.com \
LYAPUNOV_USD_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/usd-python/bin/python \
LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libstdc++.so.6 \
LD_LIBRARY_PATH=/home/s18/WS/Lyapunov/Dev/.runtime/conda/envs/isaac/lib \
bun run script/gates/run-warehouse-pallet.ts \
  --verified-source /绝对路径/含固定Props目录的源包根 \
  --core-root /home/s18/WS/Lyapunov/Dev/.runtime/conda/envs/isaac/lib/python3.12/site-packages/isaacsim/kit/mdl/core \
  --out .runtime/新的独立托盘验收目录 \
  --isaac-python /home/s18/WS/Lyapunov/Dev/.runtime/conda/envs/isaac/bin/python
# 不传--isaac-python时只做资源/派生/便携删源重开，不把未跑原生计为通过
bun run script/gates/run-usd-materials.ts \
  --scene .runtime/新的独立托盘验收目录/portable-moved/scene.json \
  --out .runtime/新的共享Viewer截图目录 --screenshot
```

本切片实际命令退出码：上述稳定托盘门0（native PASSED，4 contacts/9.80622N/closed）；共享Viewer托盘门0；默认自有材质门回归0（`materials-default-regression/receipt.json`）；`LYAPUNOV_USD_CORE_MATERIALS=<真实SDK/core> bun run script/gates/run-usd-assets.ts --out .runtime/simready-r3-20261029/omnipbr-native-final` 为0、11 pass（含真实SDK模块/ORM定量混合/DX normal/原SHA/连接/UV/未验证同名模块对照）；`bun run test:ci --filter packages/viewer/test/usd-visual --json .runtime/simready-r3-20261029/omnipbr-viewer.json` 为0、2 pass；root tsc、门 tsc及scene-kit/viewer构建均0，日志分别为 `omnipbr-types.log`、`pallet-gate-types-native.log`、`omnipbr-build-final.log`；`git diff --check` 无输出。门初稿两项入参类型错误已修为现有ResourceLibrary.import + Scene.mount，失败日志 `pallet-gate-types.log` 保留，未改产品类型判据。未重新声称默认全量CI已全绿；本轮完整工作台、隔离CPU/GPU验收由主控在固定提交独立执行。

## 2026-10-29 06:06（新加坡）：更正 RepX 兼容判断与探针真实退出状态

主控独立复跑原兼容模式、不导出 RepX 的400步：真实接触最大4对，6/6 native rigid/link 矩阵与同 Frame 一致，pause/stop/closed通过；主控 GPU 数据模式独立复现SDF点/20个body级接触、Hinge Link stale和5/6矩阵。这确认了已有核心边界，仍不代表精确SDF初始审计完成。

**更正前文 RepX 的“只读兼容”推断：** 主控 `--export-repx` 与随后400步动作组合出现 `Failed to get DOF positions from backend`；`receipt.json` 为 PARTIAL/error/closed，但旧探针进程却退出0。subset时钟/pose/两个Python对象身份不变，不能证明已有articulation backend继续有效。主控另一次RepX0tick在Kit初始化阶段超过120秒，核对自有PID后终止，真实-15/158.999秒保留。证据 `/home/s18/WS/Lyapunov/receipts/20261029-simready-human-r3/sdf-acceptance/`，原导出XML确无SDF网格这一文件事实仍成立；导出完整兼容性不得标为通过。没有再重复GPU初始化或RepX组合。

探针现已窄修，不改产品物理或SDK：默认120秒截止（`--timeout-s`只允许1至120）；由普通Python父进程启动本次独立Kit子进程组，以唯一UUID匹配本次回执，再结合 status/error/worldClosed 与真实子进程退出状态决定CLI退出码。超时先只向本组TERM，最多5秒宽限再KILL，返回124；Kit退出0但回执有error/非MEASURED/未closed返回1；缺失或旧invocation的回执不能冒用。当前none入口实际为 `AppFramework.close()`，不支持旧 `exit_code=` 参数（该TypeError也可能被Kit零退出掩盖）；已按真实接口关闭，最终状态由父进程负责。查询快照另加入真实Hinge关节读回，不能仅看SDF形状pose。

本树 `.runtime/simready-r3-20261029/` 中实际检查：

- `sdf-launcher-negative-final{.log,/receipt.json}`：用不存在Scene触发真实SDK加载后的 FileNotFoundError，Kit child退出0，外层CLI实际退出 **1**，PARTIAL/error、invocation匹配；World未创建，未宣称closed。
- `sdf-launcher-timeout{.log,/receipt.json}`：显式 `--timeout-s 1 --feedback-steps 0` 检查截止路径，CLI实际退出 **124**。收到TERM的Kit随后自行结束0也不算按时通过；记录 timedOut=true，未强杀、未碰其它进程。默认正式截止仍为120，不提高既有门槛。
- `sdf-launcher-compatible-final{.log,/receipt.json}`：默认120秒、不导出RepX、400显式有界Hinge动作，CLI **0** / Kit0 / MEASURED无error / closed=true；query前后时钟/pose/关节/控制相同，6/6完整矩阵一致，native contact points2292，pause/stop均真。
- `python -m py_compile script/gates/probe-usd-sdf-native.py`、`git diff --check` 均0。此提交只有诊断脚本与本更正日志，不将SDF声明改为已支持，也不更改产品/CI超时。

## 2026-10-29 06:51（新加坡）：Pallet 与无限地面的相切取证及静态凸包窄修

主控完整工作台实际显示原木纹/SAFETY并启动CPU/none后，原初始报告将Pallet static convexHull与新增无限Plane列为OVERLAP、depthM:null，同时还有Plane自身命中未确认的reason。旧告警截图保留于 `/home/s18/WS/Lyapunov/receipts/20261029-simready-human-r3/pallet-acceptance/ui/overlap-warning.jpg`，95,737B、SHA256 `45029b1e4a034f64c178d87e90dcd19251f690bd7c2951ed4fd0db1780c9c621`，未覆盖或删除。主控本轮Omni/Pallet的11原生、原图/搬迁和4contacts/9.80622N已独立通过；此处仅修新发现的静态convex-plane诊断，不把SDF计为完成。

先只读复现原告警：读取主控 `pallet-acceptance/gate/portable-moved/scene.json`，只在自有资源库prepare同一标准ground，未抬Pallet、关ground或改源。主控输入Scene SHA256 `040f63086adf22eace562ab83d8ecca229b6292891fd55e78c396e6ac68b4c0b`；m包装文件SHA `887f035015a8d0505c31c47852429daf82e7c68177312f691ad8052f2b115829`；原HF physics USD仍为 `d66db18b995209f586435cf6964a625b0dc0f31cc3b7e1cdb3639ca65366b064`。完整绝对路径/大小/SHA在本树 `.runtime/simready-r3-20261029/pallet-plane-diagnostic/source-evidence.json`。

同World官方 `request_convex_collision_representation` 返回result0、1part、34个完整cooked顶点；按当前完整静态变换后minZ=0、maxZ=0.20864566336619106。Plane的实际正面ray命中同一原生path、distance1、positionz0、法向约+Z；反面ray不命中该Plane，确认其半空间方向。全部凸包顶点对作者Plane法向的最小signed support为0；native ray法向有float32量级偏差，按native法向/点计算为 **−7.13449926e−8 m**，落在明确的 **±6.11e−6 m数值保护带**。这是相切/数值边界，不能从旧闭集overlap命中宣称实际穿地。静态无rigid源的propertyQuery返回result5，未将其中零bounds当证据。探针前后World step0/simTime0、SDK time0.004/steps2、pose/actions/owners完全相同，closed/exit0。原告警复现留在 `pallet-plane-diagnostic/receipt-r1.json`；窄修后相同实例/地面结果在 `receipt.json` 为 **UNVERIFIED/pairs[]**，reason明示signed min、保护带与接触边界，没有刷成严格CLEAR。

主控批准的产品改动仅 `sim-isaac/python/initial_overlap.py`：

- 仅处理当前World实际静态convexHull与无限Plane；复用现有官方cooked凸碰撞读回的完整顶点，按无剪切、正缩放的当前TRS变换，用平面线性支持函数取最小signed gap。没有使用视觉bbox、源顶点代替cooked数据或稀疏采样未命中。
- 原生正/反面ray只验证该无限Plane的身份、pose与法向，不作通用无相交或凸包覆盖证明。cooked支持结论还与同一原生convex query命中/未命中对照；不一致保持未知。
- 保护带外正gap才报告该对分离，负gap才输出实测正depthM；已知depth省略depthStatus，未知仍只用既有UNKNOWN。带内相切/微小正负值均UNVERIFIED、无penetration pair，保留可见原因。64个float32舍入单位的保护带是数值保守策略，不冒称SDK认证几何误差定理或数学严格边界证明。
- 动态体、非convex/SDF、剪切/反射/无效缩放、接口/pose未确认、未覆盖形状对或预算不足保留未知；不改Frame类型、status/source枚举、UI、源USD、实例或ground，不添加全新审计框架。真正SDF精确审计仍单独blocked。

现有 `script/gates/run-usd-isaac.ts` 扩展真实原生验收。旧USD/变体/关节/同Frame Viewer矩阵与500步控制保留；另加独立1kg落体作为contacts正对照，原源夹具仍静态，不修改源USD。之后关闭该Provider，再用单个当前World逐代显式sync合法自有fixture；每次审计自身不tick、不重建影子World、不推进回滚。12例涵盖分离、相切、±5e−8边界、0.1mm/5cm穿透、倾斜Plane、旋转及非uniform正缩放、反向法向正负、凹triangle不适用，以及有未消耗动作/owner时不改变其状态。报告实际读取SDK时钟和完整collider矩阵，不只看steps completed。

实测：

| 对照 | 结果 |
| --- | --- |
| 明确正间隙、倾斜/旋转/非uniform正缩放、反向Plane分离 | CLEAR，pairs为空，原生query与支持函数一致 |
| 相切、±5e−8保护带内 | UNVERIFIED，pairs为空，有接触边界说明 |
| 0.1mm / 5cm穿透 | OVERLAP，depthM分别0.00010005960463765825 / 0.050000059604637305 |
| 倾斜穿透 / 反向Plane穿透 | OVERLAP，depthM分别0.015000006727425935 / 0.010000042191189816 |
| 凹triangle非convex / 未覆盖动态控制体 | UNVERIFIED，没有用凸包替代源形状 |
| 12例审计前后World/SDK时钟、pose、actions、owners | 全相同；源文件SHA不变；closed=true |

准确命令（工作目录为自有树）：

```bash
HF_ENDPOINT=https://hf-mirror.com \
LYAPUNOV_USD_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/usd-python/bin/python \
bun run script/gates/run-usd-isaac.ts \
  --isaac-python /home/s18/WS/Lyapunov/Dev/.runtime/conda/envs/isaac/bin/python \
  --out .runtime/simready-r3-20261029/convex-plane-native-r3
```

该命令退出0，10项外层原生检查及12例正负均通过，`convex-plane-native-r3/{receipt.json,convex-plane/receipt.json}`、同名.log留证。`bun run test:ci --filter packages/sim-isaac/ --json .runtime/simready-r3-20261029/pallet-plane-diagnostic/sim-isaac-ci.json` 退出0、18/18文件；root/gate tsc、sim-isaac构建、py_compile及diff检查均0，日志在 `pallet-plane-diagnostic/`。这些是宿主原生SDK证据，主控仍须在固定提交和新的自有worker完整工作台复验；旧worker已缓存旧Python模块，单纯重画Viewer不会替换它。

早期门失败保留：r1新增contacts断言错误地假设原prop夹具动态会落地，实际原源是静态；改为显式独立落体。r2生成的测试Python前缀换行切分转义错误，进入协议等待并被120秒门终止；已改成chr(10)的明确分隔，未提高超时、删断言或改生产物理。r3才计为通过。源/原告警图只读，所有探针与测试均只写自有树，未操作主控Host42417或其worker。
