# Viewer Go1 测试依赖准备（`prepare-viewer-test-assets`）

## 这是什么

`packages/viewer/test/robot-glb-mesh.test.ts` 与 `packages/viewer/test/robot-glb-ktx2-texture.test.ts`
是两条**离线**回归，但它们要**真实的 Unitree Go1 资产**：

- `materials/robots/unitree_go1/menagerie/go1.xml`（1 个 MJCF 文档）
- `materials/robots/unitree_go1/menagerie/assets/{calf,hip,thigh,thigh_mirror,trunk}.stl`（5 个唯一 STL）

`.gitignore` 明确忽略 `materials/robots/unitree_go1/` ⇒ **干净 checkout 里没有这些字节**，
不准备就会在普通 CI runner 上红。本入口在行为测试之前把它们取到磁盘。

## 来源（固定版本，不漂移）

| 项 | 值 |
| --- | --- |
| 仓库 | `google-deepmind/mujoco_menagerie`（公开） |
| commit | `c96a32d28fb5da84da38c1da4d749e7a13212855` |
| 上游路径 | `unitree_go1/` |
| 取件端点 | `https://raw.githubusercontent.com/<repo>/<commit>/unitree_go1/<path>`（公开内容，**不带任何凭据**） |
| 许可证 | `unitree_go1/LICENSE`：**BSD-3-Clause**，`Copyright (c) 2016-2022 HangZhou YuShu TECHNOLOGY CO.,LTD. ("Unitree Robotics")` |

`unitree_go1/go1.xml` 与本机既有件逐字节相同（10,875 B，
`sha256=d5a7466784c8e72fd174cc7fa5a92754a1a0a6d458a1dec79e7ca0abc9525c4a`，见
`.runtime/release-candidate-20260927T165222/go1-source-verification.json`）。

**只取清单里的 6 件 + `LICENSE`**：不拉整个模型仓库、不复制额外 URDF / 重复 meshes、不下载策略权重。
逐文件 size/sha256 钉在 [`prepare-viewer-test-assets.manifest.json`](prepare-viewer-test-assets.manifest.json)。

## 用法

```bash
# 默认落到仓库根：<repo>/materials/robots/unitree_go1/
bun --no-env-file script/prepare-viewer-test-assets.ts

# 指定根（验收/冷缓存）：文件落到 <目录>/materials/robots/unitree_go1/
bun --no-env-file script/prepare-viewer-test-assets.ts --root /tmp/some-empty-dir

# 已备项目缓存的离线复制：仍按同一清单校验全部缺件
bun --no-env-file script/prepare-viewer-test-assets.ts --root /tmp/some-empty-dir --cache-root /path/to/prepared-checkout
```

行为：

1. **缓存复用**：目标文件已存在且 size/sha256 与固定版本一致 ⇒ 不重新下载。
2. **原子落盘**：不存在才下载，先写同目录临时文件、核对 size/sha256 通过再 `rename`。
3. **不覆盖坏件**：已存在但与固定版本不符 ⇒ 明确报错、非 0 退出、**不覆盖**（可能是用户自己的模型）。
4. **不改 source/revision**：下载内容与清单不符或取件失败 ⇒ 点名对象并非 0 退出，不换 commit/URL 兜底。
5. **显式离线缓存**：`--cache-root` 是已备项目根，读取其同一 `materials/robots/unitree_go1/`。先核全部目标缺件的 size/sha256，再复制；缓存缺件或坏件直接失败、没有网络回退，来源只读。回执分别记录 `reuse/copy/download`。

## 边界

- 这是**测试依赖准备**：模型字节继续不入 Git、不进软件发行包。
- 不改 `packs/ASSET_STAGING_MANIFEST.json` 里 Go1 的整体 license/readiness（只这 6 件已核，URDF 不在本次范围）。
- CI 入口：`.github/workflows/ci.yml` 的 `Prepare Go1 viewer test assets` 步骤，在 `Behavior tests` **之前**执行。
