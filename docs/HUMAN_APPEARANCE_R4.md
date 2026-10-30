# Rocketbox 多角色外观接入记录

## 2026-10-29：离线转换检查点

固定来源为 `microsoft/Microsoft-Rocketbox@0943055db6ec570bcef9f2c8b41c9e5467c808f9`。该版本的 `LICENSE.md` 明确提供 MIT 授权，SHA-256 为 `17474e386e0b9e1a700cc3d06b2b0882a2c376d9c6b49c7f8274409b8f8d2352`。角色、全部必要原材质与贴图、六条对应动作分别校验大小、Git blob SHA-1 与实际 SHA-256；不下载整库。

本检查点只修改离线脚本，未修改物理、GPU、Viewer 或默认模板。旧 Male_Adult_04 默认参数和已有最终资产保留。新角色显式选择 `--avatar`、`--motion-prefix` 和 `--retarget-rest-lengths`，以对应动画族的中性 avatar FBX 作 `--reference-avatar`。动作 FBX 的 data 骨矩阵可能是第一帧姿态，不能冒充中性 bind。每条动作按 `motion * inverse(reference bind) * target bind` 映射旋转，沿目标自身 rest 骨长放置非根骨，面部保持中性；根位移按目标/参考腿长比例缩放。转换报告保存参考 SHA、轴差、原动作骨长差与实际逐帧残差。

新 `--specular-maps` 路径保留原 diffuse/alpha/normal 和 specular 颜色，派生为 Three/glTF PBR（`KHR_materials_specular`）。粗糙度为明确常量近似，不执行原 3ds Max shader、皱纹混合或任意 shader。原文件完整保留，派生不冒称原厂渲染。

在仓库根运行首名已实测命令：

```bash
CUDA_VISIBLE_DEVICES='' /snap/bin/blender --factory-startup --background --threads 2 \
  --python-exit-code 1 --python packages/human-crowd/scripts/rocketbox-convert.py -- \
  --source .runtime/human-appearance-r4/source-4/files \
  --out .runtime/human-appearance-r4/converted/Female_Adult_01/base-r3 \
  --avatar Female_Adult_01 --motion-prefix f --specular-maps --retarget-rest-lengths \
  --reference-avatar .runtime/human-appearance-r4/source-4/files/Assets/Avatars/Adults/Female_Adult_01/Export/Female_Adult_01.fbx

python3 packages/human-crowd/scripts/rocketbox-png-lossless.py \
  --input .runtime/human-appearance-r4/converted/Female_Adult_01/base-r3/Female_Adult_01.glb \
  --output .runtime/human-appearance-r4/converted/Female_Adult_01/checkpoint-lossless/Female_Adult_01.glb
```

Blender 为本机 `5.2.2 LTS`、构建 `d13f752e3b9c`。F01 保留 4,734 顶点、80 原 skin 骨、三材质、六动作和七张嵌入 PNG。参考与目标 rest 旋转差为零，各动作非根骨长残差最大 `9.89e-7 m`。原导出为 33,785,828 字节、SHA-256 `e3fc4fb9e8ad914fbe7fd660ecf6b1b0550e9f1dbb287ab3623394e89e8e9678`。一轮 IDAT 重压后为 29,801,512 字节、SHA-256 `6c6a4eec0a910b08cea73e1498f1a20dbebaa2cd8e16ca046e4e4ae81a57895b`，现有 `readRiggedGlb` 实际解析出 81 个含祖先的 rig 节点和六动作。重压脚本验证 PNG CRC、全部非 IDAT chunk、解压 scanline、每个非图像 bufferView 以及全部其它 JSON 字段；不缩图、不减骨、不删动作。

足锁三个脚本增加 `--avatar` 文件名参数，Grounded 按各角色真实 Walk 时长采样（不再固定 32 帧）。原有 IK、最大 pelvis 下沉、逐鞋皮肤顶点 PCA 足 capsule 与原六动作/原 BIN 前缀保持断言不放宽。此检查点尚未完成新角色足锁、World 步行、碰撞、portable 搬迁或 GPU 性能验收；不能凭基础导出报告认定这些能力通过。其它批处理应先生成基础资产，再等逐角色足锁验证结果，不复用 F01 的鞋底校准。

首轮共享 Viewer 静态预览因无头浏览器虚拟时间提前退出而得到空画面，回执明确记为 `TIMED_OUT`，未计可见外观通过。后续必须取得真实图和材质装载结果。官方候选图只证明上游角色外观，不是本项目 World/GPU 验收。

## 2026-10-29 18:38（新加坡）：F01 可见外观与完整离线派生

`preview-f01-r2` 已在现有 `importHuman`、ResourceLibrary 和共享 `createViewer` 上取得正面、侧面、近景真实截图。实际显示粉色衬衫、牛仔裤、棕鞋与脸发细节；body/head 为 `MeshPhysicalMaterial`，base/normal/specularColorMap 均已装载，opacity 材质贴图也已装载，错误和材质警告均为空。渲染器原文为 SwiftShader CPU 软件实现，没有启动 Provider、World、SDK 或 GPU。这更正首轮空画面的失败，不把静态外观当行走/硬件验收。

新增 `prepare-rocketbox-avatar.ts` 为其他批处理提供同一离线入口。它先校验固定仓库/revision、MIT/README、当前 avatar 全部登记源文件和对应六动作的长度、SHA-256/Git blob，以及显式中性参考 FBX 的固定身份；不执行网络。其 manifest 输入沿用 `sourceFiles`/`motionFiles` 的上游相对路径、`bytes`、`sha256`、`gitBlob`。每阶段独立日志与 120 秒超时，失败写 `FAILED` 回执，成功仍明确要求 native/visual 复核。

```bash
bun packages/human-crowd/scripts/prepare-rocketbox-avatar.ts \
  --source .runtime/human-appearance-r4/source-4/files \
  --manifest .runtime/human-appearance-r4/source-4/manifest.json \
  --out .runtime/human-appearance-r4/prepared/Female_Adult_01 \
  --avatar Female_Adult_01 --blender /snap/bin/blender \
  --python /home/s18/WS/Lyapunov/Dev/.runtime/sim-python/bin/python \
  --reference-avatar .runtime/human-appearance-r4/source-4/files/Assets/Avatars/Adults/Female_Adult_01/Export/Female_Adult_01.fbx \
  --base .runtime/human-appearance-r4/converted/Female_Adult_01/base-r3/Female_Adult_01.glb \
  --conversion-report .runtime/human-appearance-r4/converted/Female_Adult_01/base-r3/conversion.json
```

`--base` 与 `--conversion-report` 仅用于复用已校验的当前角色原始基础导出；省略二者会自行执行转换。女性参考固定 F01 中性 FBX，男性参考固定 M04 中性 FBX，分别校验原件 SHA；不能把男性动作直接套到女性参考。每名角色独立计算 heading、Walk 实际时长/位移与速度，再执行 Grounded、恢复原 bind 的仅追加动作、鞋底标定。默认输出 `<out>/final` 含最终 GLB、相对 `glb` 路径的 `source.json`、`definition.json`、MIT 原文、`verified-sources.json`、`grounded-retarget.json` 和 `foot-calibration.json`。

F01 该命令实际退出 0，最终 `Female_Adult_01-Grounded-Calibrated.glb` 为 29,932,016 字节，SHA-256 `8845cc6d86fcf3af35ca8d212bcb5e5f68efeb77399ae5b53fdaa581e4e6859e`。81 rig 节点、七动作，Walk 与 WalkGrounded 均为 `1.2333333492279053 s`，独立速度 `1.2945611899993104 m/s`。Grounded IK 最大残差 `7.479e-8 m`、pelvis 最大下沉 0，38 个采样时刻；原六动作对象、原 BIN 前缀、网格/材质/skin/node 对象保持断言均通过，两足分别完成原皮肤顶点 PCA 内接 capsule。足标定报告保留原姿态及 Grounded 的毫米级鞋底/代理差异；尚未依据这些数字宣称真实 World 地面/步行通过。

实际证据根为本实施树 `.runtime/human-appearance-r4/`：`preview-f01-r2/{front,side,close}.png` 与 `receipt.json`；`prepared/Female_Adult_01/{receipt,stages,verified-sources}.json`、各阶段日志与 `final/`。五个 Python 脚本 `py_compile`、新增 wrapper 的独立严格 TypeScript 检查、`git diff --check` 均退出 0。源码提交 hook 提示本机 PATH 找不到 lefthook，未将其计为已执行 CI。原生动作、portable 重开和其它三名角色仍继续验证。

## 2026-10-29 18:58（新加坡）：更正接地结论与首四件 r3 冻结

F01 第一版最终资产 `8845…` 的 MuJoCo 导入、portable 搬迁删测试源重开、3000 tick/6 秒动作、同 Frame 81 骨和独立速度通过，但实际原 skin 鞋底最低为左 -7.183 mm、右 -9.013 mm；该版本不能作为接地合格资产。完整失败与旧资源不删除。相同 38 时刻的 baked→恢复原 bind 皮肤鞋底误差仅 0.417 µm，错误来自旧足锁过渡/未锁定帧，不是 bind 恢复。

F12 原足锁另有实际失败：两脚全局最低点由右鞋 -17.035 mm 决定，左鞋自身最低为 -4.494 mm，其最低 15% 分位比旧阈值高 0.574 mm，整周期左 mask 均 false。新角色显式启用 `--per-foot-contact-floor`，以各足自身周期最低点判定同样的 15 mm 接触带和 15% 顶点比例。新增 `--vertical-foot-clearance` 仅对低鞋底的帧用既有两骨 IK 补垂直余量，水平仍按原 stance 权重；不抬实体 root、不修改原网格、权重、六动作或物理时钟。新 wrapper 显式使用 `--sole-clearance-m 0.003`。1 mm 离散目标在旋转插值后仍实测最低 -1.223 mm；3 mm 明确余量的原生返回帧对 Z=0 地板为正。原 12 mm pelvis、1e-5 m IK 拒绝保留。旧 M04 不启新选项，默认基础转换实际复跑仍精确得到原 22,703,644 字节、`65ca07f23511a38bc2eb6945884fba7256c0b1ee8c1d5c84e02eac766b4402c0`。

首四件新目录为 `.runtime/human-appearance-r4/prepared/<ID>-r3/final`，统一只读清单 `first4-r3-frozen.json`；旧目录保持不变。

| ID | 最终字节 | 最终 SHA-256 | 独立速度 m/s | 6秒原生返回帧最低鞋底 / 最低足代理 |
| --- | ---: | --- | ---: | --- |
| Female_Adult_01 | 29932016 | `783291c6be95621883e3bb9bec8501648c5e07383965ce8f120ddafdddf749c8` | 1.29456119 | +0.706 / +2.013 mm |
| Female_Adult_12 | 29562916 | `869f23f57a9e9c8121c9c39aa9d2072b694226836949dfba39fcb2587f61c471` | 1.29456119 | +0.687 / +0.996 mm |
| Male_Adult_01 | 27723268 | `fb2064169620abeae8729dd9dcede6080bf5bfe3bb8a5395e8a32048509e82b4` | 1.40237278 | +1.043 / +5.356 mm |
| Male_Adult_10 | 22899508 | `b863a75ef8ec5d2719e94291bb4f7f8f465300d058f31ff4708a37cd093f14b8` | 1.40237278 | +0.723 / +5.659 mm |

四件正式 wrapper 均退出 0；四个自有 MuJoCo CPU 世界分别导入、portable 搬迁、删除本次输入与旧 CAS、重开逐 hash，再执行 3000 tick/6 秒，9 项身份/动作/owner/速度检查均通过、均 closed=true。逐件 native 与原 skin 同 Frame 鞋底重建命令/退出码在 `first4-native-r3-supervisor.json`，摘要 `first4-native-r3-summary.json`；实际帧为 328/348/329/361，不声称连续时间数学穿透证明或自然动力学平衡。低位鞋顶点横速中位数仍为左约 0.004–0.007 m/s、右约 0.017–0.039 m/s，转脚过渡 p95 可较大，完整值保留。原轨迹脚本的 `floorWorldZM` 是轨迹最低鞋顶点，不能把它当物理地面高度或据此降低地板。

探针首轮误传 MuJoCo 不支持的 `MUJOCO_GL=none`，导入失败、closed=true 的回执保留。后续使用已安装支持的 `osmesa`，没有创建 renderer 或启动 GPU/Isaac。正式工作台和 GPU/20 人实时验收归其它代理与主控，不能由本节 CPU 回执替代。

wrapper 支持复用已压缩基础资产：`--packed-base <GLB> --conversion-report <原conversion.json> --png-report <png-lossless.json>`，同时核对 avatar、动画族、中性参考 SHA、原导出 SHA→PNG 输入 SHA→最终输出 SHA 链。32 MiB 内的 baked 直接逐字节复制并记录 `copy-within-import-budget`，不重复一分钟的 PNG 重压；超过预算才调用一次无损重压。stdout/stderr 各独立日志文件，避免两个描述符覆盖同一文件。严格局部 TypeScript 与 Python 编译检查通过。

## 2026-10-29：F16 显式鞋拓扑选择检查点

F16 的原作者网格含独立鞋组件：每足 219 个 foot/toe 权重超过 0.8 的候选中，132 点属于身体/衣摆组件，只有 87 点属于真正独立鞋。直接把 219 点全作为鞋会污染接触比例与 PCA。新增离线 `rocketbox_shoe_selection.py`，由 Grounded 与 fit-feet 的显式 `--shoe-selection lowest-component` 共用；默认仍为旧 `weighted`。wrapper 将同一选项同时传给接触检测和足胶囊拟合，防止两者选择不同几何。

选择只使用候选内的原三角连通关系与位置量化缝合（1e-6 网格本地单位）来保留 GLB 的 UV/法线重复点，再按中性实际世界 Z 选择最低完整连通分量；不按高度裁掉鞋面点，不修改原网格、skin、权重、骨、clip 或其它人体分段。输出所有组件的原顶点清单、世界 Z 范围、选中清单 SHA。最低点相同的多个独立分量明确拒绝，不能猜哪个是鞋。该选项需要对应角色实际来源审查，不能称为任意衣着鞋识别器。

真实原 F16 FBX 为 373,120 字节，SHA-256 `3ae6bd8afd6492636476e621ee51ec9e8490f64a00dcd3d2ac8975deb1e9b401`。自有 CPU Blender 源拓扑探针实际选出左/右各 87 点，15 mm 最低带内各 18 点（20.69%），保留原 15% 接触比例判据。回执 `.runtime/human-appearance-r4/f16-shoe-selection-proof.json` 含源 SHA、所有候选分量与选中顶点清单 SHA；日志同名 `.log`。此时三张纹理仍由资产线有界取得，未读取 `.part`、未把无贴图诊断当 F16 完整外观/World 通过。完整 GLB 导出后的 UV 分量与原生足底仍需资产线和主控核对。

新增离线回归覆盖低鞋/高权重衣摆区分、UV 重复点保持与同高歧义拒绝。第一次正式 CI 因新文件未登记而 `UNCLASSIFIED` 拒绝，第二次夹具错误地把两个同位置部件当独立歧义而失败；修正为不同 XY、同 Z 的独立部件后，既有 `bun run test:ci --filter packages/human-crowd/test/shoe-selection.test.ts --json .runtime/human-appearance-r4/ci-shoe-selection-r3.json` 真实运行 1 文件/1 用例退出 0。原 `packages/human-crowd/` 正式离线入口此前运行 1 文件通过，需再随此新增文件整组复跑。未修改旧门阈值或把初次 ran=0 计成功。

## 2026-10-29 19:24（新加坡）：F16 完整 GLB 的 Blender 辅助网格更正

资产线取得完整纹理后的 F16 基础 GLB 为 14,315,224 字节、SHA-256 `87074a69f842fde8ca80f2c2f31156d5ccbcab45c5df29c73d67ac3273fdbc5a`。原 glTF 只有一个 mesh/skin、80 骨；Blender 导入会生成不属于源 glTF 的 42 顶点骨显示 Icosphere，无 skin 权重。早期扫描 `bpy.data.objects` 会把辅助网格当角色处理，真实报 `SHOE_WEIGHTED_CANDIDATES_EMPTY`，失败保留。首次只换为 scene 集合仍不足，辅助对象也可在该集合中，严格断言继续失败并保留。

窄修仅处理当前 scene 中 ARMATURE modifier 实际指向本角色 arm 的网格，并与输入 glTF 序列化 mesh 节点数逐一核对；不能静默漏掉源 mesh。源有未蒙皮 mesh 时明确不支持该离线工具路径。实际 F16 重新烘焙通过：322/足 UV 候选中选出178/足鞋部点（对应原87点的 UV 分裂，完整映射由资产线核验），全部组件与索引 SHA 写入 `shoeSelection`；processedSkinMeshes 仅原 `f204_hipoly_64_bones`，sourceMeshNodes=1。IK 残差 `8.462e-8 m`、pelvis 下沉0、目标余量3mm，未降低15%判据。证据 `.runtime/human-appearance-r4/f16-grounded-component-probe-r2/{grounded-conversion.json,Female_Adult_16-Grounded.glb}` 与同名日志；后续完整原 bind 恢复/PCA/native 仍交资产线实测。

## 2026-10-29 19:25（新加坡）：可复用的共享 Viewer 与原生验证入口

以下均为离线证据工具，不新增产品 Tool/渲染器。`--assets` 指向符合目录契约、含 `source.json`/最终自包含GLB/MIT原文的冻结 final 目录；每次使用新的自有 `--out`，不覆盖已封存证据。

```bash
bun packages/human-crowd/scripts/rocketbox-appearance-preview.ts \
  --assets .runtime/human-appearance-r4/prepared/Female_Adult_12-r3/final \
  --out .runtime/human-appearance-r4/preview-final/Female_Adult_12

bun packages/human-crowd/scripts/rocketbox-avatar-native.ts \
  --assets .runtime/human-appearance-r4/prepared/Female_Adult_01-r3/final \
  --out .runtime/human-appearance-r4/native-tool-f01 \
  --python /home/s18/WS/Lyapunov/Dev/.runtime/sim-python/bin/python

bun packages/human-crowd/scripts/rocketbox-trajectory.ts \
  --case .runtime/human-appearance-r4/native-tool-f01 \
  --asset .runtime/human-appearance-r4/prepared/Female_Adult_01-r3/final/Female_Adult_01-Grounded-Calibrated.glb
```

截图入口逐 bytes/SHA 验最终GLB，经现有 `importHuman`/ResourceLibrary、共享 `createViewer` 取得 front/side/close PNG 和真实 Three 材质状态。它仅创建独立 Edge headless profile、强制 SwiftShader CPU 软件 WebGL，真实等待 setScene ready 后 capture，60秒具名超时，结束只关闭自己的浏览器进程。首四件最终版本均实际三视图退出0，原色/法线/specular贴图装载、errors为空；输出 `.runtime/human-appearance-r4/preview-final/<ID>`，监督回执 `first4-preview-supervisor.json`（F12先单独成功，其余三件入监督记录）。这些是本项目实际静态显示，仍不是原生动态或GPU性能结论。

原生入口使用明确传入的已安装 MuJoCo Python、OSMesa支持后端而不创建 renderer。它复制当前输入到自有测试目录、公共导入、portable保存、复制MIT原文、移动portable后删除本次输入与旧CAS，再重开逐件hash校验，执行6秒3000tick；核对当前Frame的worldId/generation/sceneRevision以及humanPose的step/time和实际骨数。finally关闭当前Provider，失败退出非0。冻结F01复跑9项通过、335个返回帧且closed=true；不自动判定鞋底/碰撞力合格，需随后真实原skin轨迹重建并对Z=0审查。

两个工具的严格局部TypeScript检查退出0；截图工具首轮缺HumanDefinition静态类型断言的tsc失败已保留，补正确领域类型后复跑通过。相关正式 `bun run test:ci --filter packages/human-crowd/` 实跑2文件全过，报告 `ci-human-shoes.json`；根 `bunx tsc --noEmit` 和受影响 `bun run build:plugins human-crowd` 均退出0，日志 `root-tsc-r4.log`/`build-human-r4.log`。这些本线检查不能替代主控对合并后提交的独立自动化和完整工作台验收。

## 2026-10-29：截图工具默认沙箱与外置输出路径更正

共享截图工具早期误带 `--disable-gpu-sandbox`，违反共同合同；这是实施错误。旧图仅保留历史外观事实，不计沙箱合同通过。已移除该参数，不使用 no-sandbox 类参数、不改系统权限或浏览器全局设置。F12 在默认沙箱命令下实际重新取得三视图、errors为空、SwiftShader 软件渲染器事实保持，证据 `preview-default-sandbox/Female_Adult_12` 和 `preview-default-sandbox-r2/Female_Adult_12`，各自 receipt 保存完整实际 command。对进程安全标志的事后读取未取得活进程样本，不据此声称额外内核隔离验收。

男性资产线还实际发现：`--out` 位于仓库外 receipts 时，生成的 client.ts 裸导入 `three` 会从输出目录寻包，构建具名失败且未启动浏览器。工具现从自身安装树 `import.meta.resolve('three')` 解析绝对模块再生成 import，不要求输出目录额外挂 node_modules 或workspace包链接。已在默认沙箱F12重新运行，并完成严格局部TypeScript检查。原失败与资产线私有适配回执保留；后续使用此固定入口。


## 2026-10-29 19:38（新加坡）：首四件当前交付快照

默认沙箱版本 `07b78c9a` 的首四件三视图全部实际退出0，已目视合图 `.runtime/human-appearance-r4/first4-viewer-contact-sheet.jpg`；每张真实PNG与源GLB/实际命令/渲染器SHA清单在 `first4-viewer-images.json`，单件目录 `preview-default-sandbox-r2/<ID>`。这套图替代早期带关闭GPU沙箱flag的合同证据，不删除旧失败。完整本线交付索引 `DELIVERY_R4.json`，原件manifest/ledger、冻结资产/定义SHA、4个native命令/退出码与残余数值均可复跑。

本线源码和首4合法原件/逐目标派生/portable搬迁删测试源/同World运动及默认沙箱静态外观已经完成本地检查。其余角色由已分工资产线继续；20人混合GPU、完整Electron与整合后CI由Human/主控独立验收。没有把Raw六动作、neutral bind、自然平衡、连续时间严格接触或旧SDF审计阻断写成通过。F16资产线进一步报告同330原生帧全原mesh最低+0.763mm、去鞋底后的其余几何含衣摆最低+11.345mm，178 UV鞋点全映射87源鞋点；这些原证据在女性线，待主控独验。
