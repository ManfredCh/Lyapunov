# SimReady 与原生 USD 资产

USD、USDA、USDC、USDZ 可以作为主资产进入现有 `ResourceLibrary`。`scene_import`、`scene_mount`、`scene_save` 和 `scene_open` 复用同一资源身份、Scene CAS 与便携包。入库不需要 GLB。资源事实位于 `parsed.metadata.usd`，实例覆盖位于 `Entity.components.usd`；几何预览是另行登记且关联源版本的派生 JSON 资源；刚体/关节运行后，源 shape→body 绑定消费同一 Frame 的原生 body 世界矩阵。

## 本地使用

在产品源码根准备独立 OpenUSD 环境：

```bash
./script/setup-usd-runtime.sh
```

CI 在现有 `.runtime/ci-py` 一并准备固定 `usd-core==26.5` 并显式设置 `LYAPUNOV_USD_PYTHON`；既有便携USD用例仍执行，不以跳过代替通过。

发行解包根使用 `./distribution/linux/install-usd-parser`。发行包包含安装器及 `packages/scene-kit/dist/usd_asset.py`、`usd_materials.py`，不复制开发机的解析器 venv；目标环境首次使用 USD 时，需运行安装器准备本产品默认的 `.runtime/usd-python`。源码快捷入口与发行委托同一实现。默认优先复用产品已安装的MuJoCo解释器创建独立USD环境，或用 `LYAPUNOV_USD_SETUP_PYTHON` 显式指定创建环境所用的Python；不修改那个解释器的依赖。

脚本只在当前产品根 `.runtime/usd-python` 安装固定版本 `usd-core==26.5`。`--check` 只检查已有解释器能否导入 `pxr` 并打印版本；需要确认固定版本时，在产品根运行：

```bash
./distribution/linux/install-usd-parser --check
./.runtime/usd-python/bin/python -c 'from importlib.metadata import version; from pxr import Usd; assert version("usd-core")=="26.5"; assert Usd.GetVersion()==(0,26,5); print("USD_RUNTIME_READY", version("usd-core"), Usd.GetVersion())'
```

已有包含 `pxr` 的解释器可通过 `LYAPUNOV_USD_PYTHON=/绝对路径/python` 复用。默认位置由产品模块/产品根定位，不依赖会话当前目录；构建将两个 USD worker 复制到 `packages/scene-kit/dist/`，内联消费方也使用这份规范位置。找不到解释器时给出 `USD_RUNTIME_UNAVAILABLE`，指定环境缺 `pxr` 或配套模块时给出 `USD_RUNTIME_DEPENDENCY_MISSING`，均附安装或修复动作；其它解析失败保留 `USD_INSPECTION_FAILED` 等具体原因，不把未知依赖当成空依赖。

人工 Command 与 Agent Tool 调用同一 operation。Command 输入直接使用业务对象；模型工具需要外层 `input`：

```json
{"path":"/绝对路径/asset.usda","sceneId":"scene-id","physicalize":false}
```

`scene_mount` 可重复引用同一 `resourceId/version`。通过 `scene_edit` 修改某个实体的 `transform`；通过 `scene_usd_instance` 改变该实例的根 prim 或变体：

```json
{"sceneId":"scene-id","entityId":"entity-id","expectedRevision":3,"variants":{"/Prop":{"shape":"large"}}}
```

变体在 OpenUSD 匿名 session layer 和 Scene 文档中处理，不保存到源 layer，也不改变其他实例。`scene_save` 的 `portable:true` 复制已解析的完整闭包；绝对 layer 引用仅在副本改写，沿既有派生版本规则登记。复制后重新解析副本，依赖不能逃出便携目录。含绝对依赖的源资产首次自动 CAS 会明确拒绝；可显式 `storage:"reference"` 登记后执行便携保存。

旧场景的派生预览可以通过既有 `scene_usd_instance` 刷新：先用 `scene_inspect` 读取该 Scene 最新 revision 与实体 `components.usd`，将已有 `primPath`、完整 `variants` 原样传回，并使用该 revision。例：原纸箱实例原本选择 `/RootNode` 的 `PhysX=Enabled`，则调用 `scene_usd_instance` 时保留 `variants:{"/RootNode":{"PhysX":"Enabled"}}`。该操作重新解析原件并生成当前预览，源 resourceId/version、实例 transform 保持；不要省略仍需保留的变体字段。也可通过原 `scene_mount` 挂载同一源 resourceId 创建新实例。这里没有全局缓存迁移。

## SimReady 来源

先用 `asset_list` 检查本地，再使用 `simready_search`。默认读取 NVIDIA SimReady Central 登记的 NVIDIA 与 11 个厂商库；也可用 `repoIds` 选择已登记库。搜索读取资产级登记名称、中英别名与来源身份，原始索引最多缓存一小时；物理类型、尺度和许可证需选定候选后用 `simready_detail` 核对。缓存只是可丢弃来源索引，不是第二个资源库。网络失败返回 `BLOCKED` 或 `PARTIAL` 与具名来源，只有所有选定来源读取成功且没有匹配时才返回 `NO_MATCH`。

旧 `nvidia/PhysicalAI-SimReady-Warehouse-01` 已按独立的 `warehouse-csv-v1` 协议接入同一组工具，默认来源为 12 个 Central 包源加这个固定 CSV 源。固定 revision 为 `c7fe115cb79c7ddbd0532630d7768b5736b0ecc4`。753 是该 CSV 的目录行数，不是已下载或运行合格数；文件身份快照中 8804 是 API 返回的文件项数，不据此推导资产总量。

旧源快照位于 `packages/scene-kit/source-catalogs/warehouse-01/`，含源 CSV、原 README/CC-BY-4.0 归属、逐文件 LFS/Git 身份和校验 pin。默认返回 `PINNED_SNAPSHOT`，不冒称当次联网成功。`simready_search` 的 `refresh:true` 只对固定 CSV 发起当次镜像核验；失败保留缓存候选与 `PARTIAL`、具体刷新错误。原文 `asset_preview` 官方 URL 不传给浏览器自动请求；缩略图未受控取得时返回 `NOT_FETCHED`。

该源的 `packagePath` 是 CSV 条目的相对路径，详情会确认实际入口 USD；源目录有一条缺扩展名，只有在固定源文件身份表唯一确认后才补 `.usd`，同时保留原目录路径。分类、标签、Q code、mass 原值保留，CSV 未明确的质量单位不猜 kg。旧源没有新版 Central BOM/验证记录；导入用真实 OpenUSD/Sdf 逐 layer 枚举全部引用与 payload，每件按源 LFS-SHA256 或 Git blob 身份/大小验证，再运行完整组合闭包检查。缺源文件身份、外部依赖、模式引用或镜像跳转会具名阻断，不伪造来源验证，也不改转 GLB。

选定候选后，给 `simready_detail` 或 `simready_import` 传入其完整 `repoId`、40 位 `revision` 和 `packagePath`。导入预算默认 128 MiB，上限 512 MiB，可由 `maxBytes` 收紧。取件按 descriptor 声明读取 metadata 并校验其 SHA256，再逐 BOM 文件核对大小与 SHA256，检查 USD 的 layer/reference/payload/纹理闭包都在包内。原始 descriptor、metadata、全部 BOM 文件及来源清单共同进入导出闭包。许可证未知、NC/other、缺文件或校验失败均停止；不会重新打包并改写源许可。

所有 Hub 请求与重定向只允许 `hf-mirror.com`，官方登记文本里的 `huggingface.co` URL 只作为待解析数据，不实际请求。请求复用 `network-assets` 的公开 HTTPS 预检、原生代理路由、取消、超时与累计字节计费。镜像跳转到官方域时，在下一次请求发出前拒绝，不静默换源。只有确实没有合适候选后再考虑其它结构化库与 `web_search` / `web_fetch` 补缺；访问失败不能当成未命中。

## 独立标准模块依赖

旧 Warehouse 托盘的 `OmniPBR.mdl` 是源 USD 声明的外部 MDL 模块，固定源文件表没有这件文件。可将已安装 NVIDIA SDK 的 Core Materials 标准库作为独立的现有 `ResourceLibrary` 资源登记，不修改 SDK 或原 HF USD，不把标准模块加入 HF 源文件清单。登记入口只读明确指定的 SDK 目录，不联网：

```bash
bun run script/gates/register-usd-standard-library.ts \
  --core-root /绝对路径/isaacsim/kit/mdl/core \
  --resource-root /当前Host使用的SceneOperations数据根 \
  --out .runtime/usd-standard-library-registration.json
```

`--resource-root` 必须与后续 `simready_import` 使用的资源库一致。登记记录 SDK distribution/version 与 METADATA SHA256、Core Materials 版本、MDL 语言版本、BSD-3-Clause 许可原文、模块导出参数与每件文件大小/SHA256。已核对的 Isaac 6.0.1.0 / Core Materials 2.1.0 的 OmniPBR 闭包含六件 MDL、VERSION 和许可；`nvidia::aux_definitions` 等 `using/import` 传递依赖也在其中。编译器内置模块单列为 `runtimeModules`，不冒称普通源文件。

Warehouse 导入遇到固定源表不存在的 MDL 时，只从已登记标准库中匹配实际 `assetIdentifier`、`subIdentifier` 和 USD 使用的参数名/类型；不兼容、未登记或候选歧义均拒绝。原 HF 逐文件身份与独立 `standardLibraries` 身份分别记录在来源 sidecar，解析使用局部 `Ar.DefaultResolverContext`，不设置全局搜索路径。挂载顺序保持 USD 主资源、派生预览、标准库引用；标准库不产生可视或物理实体。便携保存复制模块 JSON、所有相对依赖与许可，搬迁后重新核验并恢复该标准库的 BSD 许可；原件保持原 SHA，需要改路径的副本仍按既有派生规则登记。

模块依赖闭合不等于执行 MDL 材质。Viewer 对上述固定 Core Materials 2.1.0 的 OmniPBR 六模块 SHA 全部匹配时，可将常见 Albedo、ORM、normal 和常量输入派生到同一 Three PBR 材质；源 shader 标记为 `OmniPBR`，派生结果带标准库 resourceId/version/模块 SHA 和 `pinned-omnipbr-subset`，不伪装成源 PreviewSurface。Albedo 纹理替代 diffuse 常量后乘 tint，roughness/metallic 为 ORM g/b 与各自常量按 influence 的线性混合；normal 为 raw，一次解码并按源默认 DX `flip_tangent_v=true` 翻转 Y，支持 bump_factor 对 XY 的强度。源 AO 默认权重为0，不猜接未启用的 AO。

该子集当前只支持 UV0/identity 和明确常量/资产输入；连接节点、其它投影/非 identity UV、额外输入、未知模块版本/同名文件均明确拒绝或警告。颜色空间按已支持的输入元数据/图片 auto 规则派生，ORM/normal 保留 raw；具体不支持的颜色空间会拒绝该贴图。任意 MDL 执行仍未实现。缺原纹理时完整来源闭包仍阻断，不以标准库登记成功冒充完整场景通过。

## 显示与物理边界

- Viewer 显示 OpenUSD 默认时刻的派生几何和源 prim 身份；支持常见 `UsdPreviewSurface` 的基础色、粗糙度、金属度、切线法线与常量透明度，以及 mesh 上 `UsdUVTexture` + `primvars:st`、有界 `UsdTransform2d` 链的 PNG/JPEG/WebP 纹理。支持 indexed、faceVarying/vertex/varying/uniform/constant UV、RGB/r/g/b/a 输出、scale/bias、sRGB/raw/auto 与 repeat/clamp/mirror/black 包裹。UV 先缩放、再旋转、最后平移，组合后供同一 Three 标准材质使用；normal 按 USD scale/bias 解码一次，再进入现有切线基。作者法线及左右手面方向保留，无材质绑定时使用 `displayColor`。
- 纹理是现有派生预览资源的 `usd-texture:<SHA256>` 表示，仍经受控资源媒体解析和哈希核验；派生 JSON 无绝对纹理路径。便携保存保留相对纹理名，内容相同时以硬链接复用包内字节。USDZ 内纹理在确认挂载后通过 OpenUSD 读取并提取；只读临时预览不写缓存，内嵌纹理需在放置后显示。
- 任意 MDL、任意 shader/NodeGraph、specular workflow、材质分面子集、primitive 自定义 UV、UDIM、位移贴图、蒙皮/动画和细分曲面仍未实现；不会因此改写源网络。固定 OmniPBR 仅按前述验证模块的子集派生；PreviewSurface 则按源实际连接通道限定，例如 ORM 的 g/b 接 roughness/metallic 时仅使用这两路，不根据文件名猜接未声明的 AO。具体不支持的连接在诊断中明示。
- Transform2d 的 scale/rotation/translation 当前支持未连接的常量参数；参数若连接其它接口/节点，明确记录 `USD_TEXTURE_UV_PARAMETER_CONNECTION_UNSUPPORTED` 并拒绝该纹理网络，不把未求值的连接悄悄当作本地/default 值。
- USD 的格式与用途分开。`isaac.sourcePath` 只是原生来源指针；新实例/变体记录绑定资源版本的用途和源碰撞/刚体/关节声明。纯视觉 USD 不因此变成机器人或自动请求物理，缺源事实的旧一等 USD 文档保留未知；已有明确物理模板与非 USD 默认行为不变。属性中可查看源声明，运行就绪仍以原生世界观察为准。
- Scene 文档只携带资源引用和实例覆盖，不携带网格数组。只读放置预览是有界临时 DTO，超过 256 KiB 会说明临时预览不可用，仍可直接放置。
- Isaac 每帧在现有 `Frame.entities[].sensors.usdBodyWorldPoses` 中读回源 body prim 对应的真实世界矩阵，Viewer 的 `applyFrame` 用该矩阵和源 body→shape 局部矩阵更新每个子几何；关节运动与刚体下落不保持默认时刻静态形状。这个通道只覆盖刚体，不把USD动画或蒙皮宣称为已支持。
- Isaac 原生加载引用 USD。Scene 变换放在父 Xform，保留源根变换、关节、驱动和碰撞；实例变体写运行 stage。当前要求原生物理源为米、千克、Z-up；不符合时明确拒绝物理启动，入库与派生显示仍可用。
- 初始重叠中，当前静态 `convexHull` 对无限 `Plane` 可读取官方 cooked 完整顶点并计算平面最小有符号间距，另用原生正反面 ray 确认 Plane 身份/pose/方向。仅数值保护带外的分离/穿透有明确结论，穿透给实际 `depthM`；相切或保护带内微小正负值保持 `UNVERIFIED`，不将闭集 overlap 命中当作穿地，也不刷成严格 `CLEAR`。动态体、非convex/SDF和未覆盖场景继续未知。这不等于 SDF 精确初始审计已经支持。
- MuJoCo 与 Newton 当前没有接通原生 USD 物理；明确返回 `UNSUPPORTED_CAPABILITY`，不会把 USD 静默降为没有碰撞的视觉实体。资源格式、机器人用途和具体 Provider 能力分别记录。

## 自动化验收与当前范围

```bash
bun run test:ci --filter packages/scene-kit/test/simready-assets
bun run script/gates/run-usd-assets.ts
# 已有且许可就绪的Isaac；显式路径可复用现有SDK，输出根必须是新的独立目录
bun run script/gates/run-usd-isaac.ts --isaac-python /绝对路径/python --out .runtime/usd-isaac-check
./node_modules/.bin/tsc --noEmit -p tsconfig.json
bun run script/build-plugins.ts scene-kit viewer
```

默认离线测试覆盖固定 revision、镜像拒绝、未命中与失败区分、metadata 哈希、多厂商别名和缓存。原生门通过既有清单入口显式执行 `usd-native.test.ts`，覆盖原生格式、静态/关节事实、缺依赖、多实例独立变体与变换、原件哈希不变、prim 映射、整包搬迁重开和绝对引用副本改写。原生Isaac门检查同源两实例变体碰撞、源根叠加变换、source/runtime/body prim身份、500个物理步关节控制、真实body帧驱动同一个Viewer更新函数，以及原件SHA不变，并输出初始/最终Frame和便携Scene。OpenUSD/Three 几何检查不等于真实完整界面、人工视觉质量或引擎物理验收；这些需要本轮独立回执。

材质复跑与可见案例：

```bash
bun run script/gates/run-usd-materials.ts --out .runtime/新的材质案例目录 --screenshot
# 已有本地真实USD：原材质与许可仍由资源库核验，不联网取件；输出目录应为新的目录
bun run script/gates/run-usd-materials.ts --source /绝对路径/原生资产.usd --out .runtime/新的真实材质案例目录 --screenshot
# 含已登记标准库的便携Scene，保留完整资源引用再走同一共享Viewer
bun run script/gates/run-usd-materials.ts --scene /绝对路径/便携包/scene.json --out .runtime/新的便携材质案例目录 --screenshot
# 只消费既有固定5件Pallet原字节，不联网；生成原cm与显式静态m包装两个独立便携Scene
bun run script/gates/run-warehouse-pallet.ts --verified-source /绝对路径/含Props目录的源包根 --core-root /绝对路径/SDK/kit/mdl/core --out .runtime/新的托盘闭包目录
# 已有SDK和许可就绪时附加 --isaac-python /绝对路径/python，另验原cm拒绝与m包装的静态碰撞落体
```

该命令生成合法自有 USD/纹理、可直接 `scene_open` 的便携 Scene、工作台打开说明，以及真实共享 Viewer 的 Edge 无头 WebGL 截图和材质回执。默认不加 `--screenshot` 时只生成案例；截图使用独立浏览器资料目录与 127.0.0.1 服务，结束后停止。它是共享 Viewer 显示证据，完整工作台交互与人工质量仍独立验收。PreviewSurface 通道语义参考 [OpenUSD 官方规范](https://openusd.org/release/spec_usdpreviewsurface.html)。

原生门额外的固定 OmniPBR 正/负对照需要显式 `LYAPUNOV_USD_CORE_MATERIALS=/绝对路径/SDK/kit/mdl/core`；未提供时该项明确 skip，不能计为已通过 SDK 模块验收。该项使用自有 USD/PNG 和真实已安装模块，检查 ORM 定量混合、法线 DX 翻转、原件 SHA、连接/UV/未验证同名模块负例。真实托盘门不增加原源没有的刚体；原 cm 源仍受原生米/千克/Z-up 限制，工具生成的独立 m 包装只在父层 scale0.01，保留原 HF sourceRef、derivation 和源碰撞几何。

USD 原生门现在有已登记入口：`bun run gate:usd-assets`、`bun run gate:usd-isaac`、`bun run gate:usd-materials`。`dist-inventory` 的既有完整检查需先运行项目正常全插件构建与 `bun run build:desktop`；缺桌面产物应补构建，不修改盘点判据。Guest/local/隔离 Host 保留明确的 `LYAPUNOV_USD_PYTHON` 非秘密配置；缺解释器或 pxr 会给出解析器安装/修复动作，不建议用软链掩盖 Host 配置丢失。
