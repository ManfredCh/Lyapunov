# USD 基础材质增量回执（2026-10-28，新加坡时间）

状态：**完成**（本次有界增量的实施与本地实测）；主控独立验收仍以集成版本为准。总体 SimReady 项目仍有真实厂商包镜像阻断与旧 Warehouse CSV 适配剩余项，不因本增量改写为全部完成。

本轮基于 `c11bcd08` 后的隔离工作树；路由兼容修复独立提交为 `91f2bc9b`，材质代码与本回执另行提交。源码未写主仓，未推送或发布；截图、案例和依赖留在本工作树 `.runtime/`。

## 实现与来源

- 通过真实 UsdShade 材质绑定读取常见 `UsdPreviewSurface` 的基础色、粗糙度、金属度和常量透明度；`UsdUVTexture` 经 `UsdPrimvarReader_float2` 读取 `primvars:st`。indexed、faceVarying/vertex/varying/uniform/constant UV 进入派生几何；faceVarying 按面角展开，保留共享点的 UV 接缝。
- RGB/r/g/b/a 输出通道、scale/bias、sRGB/raw/auto 及 repeat/clamp/mirror/black 按 [OpenUSD PreviewSurface 规范](https://openusd.org/release/spec_usdpreviewsurface.html) 接入 Three 标准材质现有采样段；没有新建 renderer。PNG 的 auto 色彩空间与 useMetadata/black 默认根据文件信息处理，不按“颜色槽/数据槽”随意猜测。
- 纹理经 OpenUSD Ar 读取，原件和 USDZ 内容不改写。纹理按内容 SHA 进入既有派生预览资源闭包，并声明为 `usd-texture:<SHA>` 表示；浏览器走现有受控媒体 resolver 和资源库校验，派生 JSON 不含绝对纹理路径。便携包保留相对纹理名，并通过包内硬链接复用相同字节；移动后可重开。
- 修复真实异步 Viewer 入口的资源身份：USD 的 `primaryResource` 明确选原始 USD，不让 `role:visual` 的派生 JSON 抢占主源，避免 `USD_PREVIEW_SOURCE_MISMATCH`。实例材质覆盖保留源材质和贴图，并在克隆时保留标准材质的 USD 通道采样适配。
- MDL/任意 shader 或 NodeGraph、specular workflow、分面材质子集、primitive 自定义 UV、Transform2d/UDIM、法线/位移贴图、细分、蒙皮/动画仍明确不支持；源网络仍保存。源原点放置说明恢复，并与新的基础材质支持口径一致。

## 实测与退出状态

| 实际命令 | 结果 | 证据 |
| --- | --- | --- |
| `bun run test:ci --filter packages/lyapunov-shell/test/environment-routing.test.ts --json .runtime/ci-routing-material.json` | 0；96 个用例通过 | 保留已有库复用语义，新增本地→SimReady→其它库/web顺序和失败不能当未命中的断言。 |
| `bun run test:ci --filter packages/lyapunov-shell/test/workbench-import-surface.test.tsx --json .runtime/ci-import-surface-material.json` | 0；7 个用例通过 | DOM 保留源原点默认选择，断言 PreviewSurface/st 支持与 MDL/任意 shader 限制。 |
| `bun run test:ci --filter packages/viewer/test/usd-visual --json .runtime/ci-usd-material-viewer-final.json` | 0；2 个用例通过 | 实际 Three 材质/纹理属性、UV 接缝、通道 shader、覆盖克隆不改源、USD 主资源身份。 |
| `bun run script/gates/run-usd-assets.ts --out .runtime/usd-material-projection` | 0；6 个用例通过 | 真 OpenUSD/PBR/UV、材质变体源 SHA 不变、派生纹理表示、完整搬迁重开、USDZ 内纹理提取、任意 shader 具名限制、临时放置纹理经出站投影后仍匹配授权候选；保留此前全部原生用例。 |
| `bun run test:ci --filter packages/scene-kit/test/portable-relocation --json .runtime/ci-material-portable-relocation.json` | 0；3 个用例通过 | 既有便携搬迁回归。 |
| `bun run test:ci --filter distribution/linux/payload-contract --json .runtime/ci-material-payload.json` | 0；24 个用例通过 | 载荷新增 `scene-kit/dist/usd_materials.py` 必需件。 |
| 两个 tsc | 均 0 | `.runtime/tsc-material-deliver.log`、`.runtime/gate-tsc-material-deliver.log`。 |
| `bun run script/build-plugins.ts scene-kit viewer lyapunov-shell` | 0 | `.runtime/build-material-final.log`，未打发行包。 |
| `node .runtime/built-usd-tool-smoke.mjs` | 0 | `.runtime/built-usd-material.log`；构建插件真实 Node ToolRegistry 在 cwd=/tmp 导入/挂载材质 USD，读出 1 个纹理事实与 1 个受控纹理表示。 |

## 可见案例

```bash
bun run script/gates/run-usd-materials.ts --out .runtime/新的独立材质案例目录 --screenshot
```

本轮实际输出为 `.runtime/usd-material-final/`：

- `portable/scene.json` 与 `OPEN_IN_WORKBENCH.md`：可直接在工作台以 `scene_open` 打开，无需启动物理。
- `viewer-canvas.png` / `viewer-page.png`：使用真实共享 `createViewer` / `setScene` / 受控资源读取和 Edge 独立无头 WebGL 的截图。两排同源实例显示棋盘 RGB 纹理、红/蓝材质变体及 r/b 数据通道平面；实施方已看图核对可见结果。
- `receipt.json`：`PASSED`，`viewer.errors=[]`；两个实例均 `loaded=true`，各有 2 个实际带纹理的 Three 材质；浏览器退出 0，本地服务已结束。

截图是共享 Viewer 的运行证据，不冒充完整工作台人工交互验收。主控将另用 Cua 在真实工作台复核。未重跑 RTX 或物理容量测试，也未因本增量扩大那些结论。

## 来源边界与剩余项

当前 `simready_search` 的 12 个来源是新版 Central descriptor/BOM 协议库。**旧 `nvidia/PhysicalAI-SimReady-Warehouse-01` CSV 适配未实现**；此前 753 是其目录实读条数，不是本轮接入、导入或运行合格数。旧 CSV 的相对 USD 路径、许可、版本与包依赖闭包需要独立适配，不能用新版库暗中替代。

真实厂商完整包的镜像阻断继续保留；本轮没有尝试绕过守卫，也没有为了材质功能访问官方 Hub。合法自有 USD/PNG 夹具与真实厂商包分别标记。
