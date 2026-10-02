# 图纸夹具的来源与许可

本目录的夹具用于 `packages/blender/test/drawing-input.test.ts`。**PDF 是生成的，DWG 是真文件**
（不是把 DXF 改成 `.dwg` 后缀）；每个文件都记来源、许可与 sha256，便于复核。

## DWG（真实 AutoCAD 生成的文件，不是改名产物）

| 文件 | 字节 | sha256 | 来源 | 许可 |
| --- | --- | --- | --- | --- |
| `dwg/example_2004.dwg` | 187890 | `e72d5e86d5d36d64b08822fb25a46079f592fd895a6157b1b8d9b07775e06108` | GNU LibreDWG 0.14 发布包 `test/test-data/example_2004.dwg`（上游自带样例图） | GPL-3.0-or-later |
| `dwg/tmp-line-r10.dwg` | 2421 | `0885bb097033cf1b97e645e88ddb32970591e5af411631022b062615a94f5447` | 同上 `test/test-data/r10/tmp_line.dwg` | GPL-3.0-or-later |
| `dwg/entities-r10.dwg` | 4305 | `a821c7b29a7be02a9db6db223398360b59173316d8a07c14f01e9f4f1766bb55` | 同上 `test/test-data/r10/entities.dwg` | GPL-3.0-or-later |
| `dwg/dim-r26.dwg` | 4253 | `5cb89538f3aac12ac9b730968c257d049a85206767241f0279e06908a4893c89` | 同上 `test/test-data/r2.6/dim.dwg` | GPL-3.0-or-later |

四个都是**带 DWG 版本签名的二进制 DWG**（`AC1018`=2004、`AC1006`=R10、`AC1003`=R2.6；
签名后 5 字节为 0），`file`、`xxd`、`dwgread` 均可直接验证：

- `example_2004.dwg` 是**真实工程图规模**的验收件：LibreDWG 0.14 转出 DXF 后 ezdxf 读得出来
  （66 个模型空间实体、5 个图层、13 个块定义、10 个块引用、26 条曲线、9 个标注，mm 单位），
  同时转换器吐出 ~55 条告警（MATERIAL/TABLESTYLE/MLEADERSTYLE/ACAD_TABLE/ARC_DIMENSION/DIMASSOC
  属 Unstable/Unhandled）——**转换损失是真的、可数的**，测试里就是按这个断言。
- `entities-r10.dwg` 被特意保留用来证明"转换成功但产物读不出来"这条真实路径
  （LibreDWG 0.14 转出的 DXF 会被 ezdxf 拒绝，见测试与 `docs/DRAWING_INPUT.md`）。

许可：四个文件都随 GNU LibreDWG 0.14 发布包（GPL-3.0-or-later）分发；上游发布包内没有为
`example_2004.dwg` 单独标注原始作者，本目录按发布包同一许可随附，**仅作格式测试用**，不再分发。
本机副本来源路径：`/home/s18/WS/jzxz/cad3d-studio/.tools/libredwg-src/test/test-data/`
（由 `libredwg-0.14.tar.xz` 官方发布包解出，包 sha256 见任务回执）。

## PDF（用任务目录里的 `make_fixtures.py` 生成）

| 文件 | 字节 | sha256 | 生成方式 | 用途 |
| --- | --- | --- | --- | --- |
| `plan-vector.pdf` | 1753 | `42d75da1c708184303419028194e4a19f964a6c9a2b04728b439fd63974730a4` | reportlab 画的矢量图（矩形/直线/贝塞尔/圆 + 文字，含 `SCALE 1:100`） | 矢量分流：真实路径算子与文字 |
| `plan-scanned.pdf` | 88646 | `734be155b6cdaebdd0ed3ea7c9b5a569653f6ae7b8198c5fa775b6889bfd52e4` | 把上面的矢量图用本机 Ghostscript（150 dpi）栅格化 → 灰度+噪声 → 以**只有图像**的 PDF 存出 | 扫描分流：原生图像导出 |
| `plan-mixed.pdf` | 89787 | `1430b97a778243ccce59fe24d45a44f9736bae7b2370d98098bf453a17698e25` | 扫描页 + 矢量叠加层（pypdf `merge_page`） | 混合分流：图像覆盖率 + 路径同时存在 |
| `plan-encrypted.pdf` | 1714 | `3a3964121da0a38bf3b0c3b7cc4489d16bd2697e7f01a2777480924f4d59cb2d` | pypdf 加密（口令 `secret`） | 加密 PDF 的明确报错 |
| `plan-inline-scan.pdf` | 899 | `f2a212065e543c65605b8b07fc4abafb173e32c95d39684da02b73697122b55c` | 手写最小 PDF：整页一张 **inline image**（`BI…ID…EI`），没有 Image XObject | inline 图也要算覆盖率、也要判成扫描页 |
| `plan-nested-form.pdf` | 1390 | `bc39a9a0ae9a8142ddbb2567b50871c57555cc9cae810940e9868269afeb37d1` | 手写最小 PDF：扫描图藏在**两层 Form XObject** 里（`/Fm1` → `/Fm2` → `/Im0`） | Form 递归必须进到内层 `/Resources` 才看得到图 |
| `plan-rotated-scan.pdf` | 1043 | `77ca0e8c936bf2b032772e22d124593274e3b85c95390e3bce9b4c061fed7151` | 手写最小 PDF：整页一张 32×24 灰度图 + 页字典 **`/Rotate 90`**（图是横的、用户看到的整页是竖的） | 页面旋转：必须按 `/Rotate` 渲染整页预览，不能把嵌入像素当整页（`docs/DRAWING_INPUT.md` §4.3） |
| `plan-cropped-scan.pdf` | 1046 | `d48a57122da7403e0d3928f99c6ebebb26fc11dbccd318abac4bb381943fbd66` | 手写最小 PDF：整页一张 32×24 灰度图 + **`/CropBox` 内缩 10%**（MediaBox 1190.55×841.89 pt → CropBox 952.44×673.51 pt） | 页面裁切：整页预览必须按 CropBox 渲染，不能把 MediaBox 全幅当用户所见 |
| `plan-two-page.pdf` | 89562 | `16805fc5a66ce1a462e3860341ea46472a34338034d1da5b23ba0b53c6590a76` | 第 1 页取 `plan-vector.pdf`、第 2 页取 `plan-scanned.pdf`（pypdf `add_page`） | 分析范围：`--max-pages 1` 时文档级分类只覆盖第 1 页，必须报 `scope` 与 `PDF_CLASSIFICATION_PARTIAL`，不把没读的第 2 页推断成同一种 |

生成命令（任务目录，需带 HF_ENDPOINT）：

```sh
HF_ENDPOINT=https://hf-mirror.com <task>/venv/bin/python make_fixtures.py <fixtures 目录>
```

- 逐字节可复现性（结论来自 2026-09-20 那次**重跑比对**：把同一脚本写进临时目录，逐个 sha256 对比，
  日志 `/…/42_cad_formats/scratch/fixtures-repro.log`）：
  - **重跑逐字节相同**：`plan-inline-scan / plan-nested-form / plan-rotated-scan / plan-cropped-scan`
    （手写对象体 + 确定性图像数据）、`plan-two-page / plan-mixed / plan-encrypted`（这两次跑下来 pypdf 输出稳定）。
  - **重跑会变**：`plan-vector.pdf`（reportlab 往文件里写创建时间）、`plan-scanned.pdf`（由上面那份
    重新栅格化而来，连带变化）。这两行的 sha256 是**入库那一份**的，重跑只能保证结构/事实一致，
    不要拿新产物的哈希去对。
- 上表 sha256 与 `plan-rotated-scan/cropped-scan/two-page` 三件都是本任务（57_drawing_review）新增/复测时
  实测出来的；`plan-inline-scan/nested-form` 的哈希与加入时一致，未变。
- 四件手写 PDF（inline / nested / rotated / cropped）的内容流都只用到标准算子
  （`q/Q/cm/Do/BI…ID…EI`），pypdf 与 Ghostscript 都能直接读，不是"只为我们的代码造的假文件"；
  旋转/裁切两件只加页字典项（`/Rotate`、`/CropBox`），没有依赖特殊编码（不需要 JBIG2 编码器）。
- `--keep` 可让脚本跳过已存在的手写件（不含两页件与 reportlab 那几件）。

## DXF（ENV-14 开口反例：从真实图 `cad-fixtures/plan-l-shape.dxf` 派生）

| 文件 | 字节 | sha256 | 生成方式 | 用途 |
| --- | --- | --- | --- | --- |
| `env14-review-doors-base.dxf` | 15638 | `f67b83cfc14dd3002cbf5c381b6fe7c2e0bebc7af16fa176d429cd2191f7e84b` | 真实图 `cad-fixtures/plan-l-shape.dxf`（mm 单位）只读复制 + 自建三图层：`MY-DOORS`（两条 LINE，开口 1100 mm 与 2700 mm）、`MY-DOORS-EMPTY`（0 实体）、`MY-DOORS-ZERO`（一条零长度 LINE） | 开口反例：空图层必须给忽略理由、零跨度层不得写成 `spanM:0` 开口、同层两处不得合并成一条 |
| `env14-review-doors-wider.dxf` | 15638 | `c2dd4b494cd020dc7bd24d254f2589b2c62cb7cd66286cc2f531bbe8ff29142c` | 同上，仅把 `MY-DOORS` 的第一条 LINE 从 1100 mm 加宽到 1700 mm（1.1 m → 1.7 m）；该层包围盒仍为 x∈[500,3200]、全局包围盒不变 | 层内加宽反例：层包围盒没变也必须点名该开口（旧行为 `unchanged:true`） |
| `env14-review-doors-moved.dxf` | 15638 | `cf10f50151c0d296df7044747b52f6d6895d5e4719fcf7f46b2d61548e79bbc1` | 同上，仅把 `MY-DOORS` 的第一条 LINE **平移 +400 mm**（x 500→900 起、1600→2000 止）：跨度仍是 1.1 m，层包围盒与全局包围盒都不变 | 层内平移反例：尺寸没变、只在层内挪位置，也必须点名（靠条目里的 `originM`） |

生成脚本：`.runtime/lane-env14b/analysis/make-review-counters.py`（ezdxf；两件字节数相同是因为只改了一个端点坐标，
`doc.saveas` 输出稳定）。派生自**真实图**（基底图层/尺寸/单位/标注都来自原件），不是手搓的假 DXF。

## DXF（ENV-14 截断盲区回归：本 lane 自建，`mk-truncation-fixtures.py`）

| 文件 | 字节 | sha256 | 生成方式 | 用途 |
| --- | --- | --- | --- | --- |
| `env14-trunc-doors512-declared.dxf` | 102186 | `9a5ae6547ec0457071040acd2d9a8a08621ed7b270cf9f48ca8f4b514bb7624a` | ezdxf 自建小图（`$INSUNITS=4` 毫米）：`MY-WALLS` 一条 6×4 m 矩形 + `MY-DOORS-TRUNC` 层 **512** 条 600 mm 开口线 | 边界下侧：512 条**不**截断（`sizesTruncated:false`、`factsComplete:true`） |
| `env14-trunc-doors513-declared.dxf` | 102316 | `f4f9fa4ee9e6f57d8ad75f3ba8457e1287dbe434893e397cbf2b94104ec72e93` | 同上，**513** 条 | 截断：明细只列前 512 条 ⇒ `OPENING_LAYER_SIZES_TRUNCATED` + `factsComplete:false` |
| `env14-trunc-doors513-lastwide.dxf` | 102316 | `139aae933275424d3d0d1bdad43cc9110bb3725aa7fa1a64882a7d258bb2c501` | 同上，只把**第 513 条** 600 → 3000 mm（窗口外） | 盲区本体：摘要逐字相同，旧实现漏报；现在必须 `factsComplete:false` 且不判"未变" |
| `env14-trunc-doors513-idx512wide.dxf` | 102316 | `051ad826d085982a58b41b4f2bd82d08683e203fbcde982ceff745b4f6576d46` | 同上，只把**第 512 条** 600 → 3000 mm（窗口内） | 边界对照：窗口内改动仍被点名（`spanM 0.6 → 3`） |

生成脚本：`.runtime/lane-env14b/analysis/mk-truncation-fixtures.py`（确定性输出；四件只差一个端点坐标/条数）。
