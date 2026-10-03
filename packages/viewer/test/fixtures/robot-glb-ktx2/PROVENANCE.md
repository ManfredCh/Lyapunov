# `robot-glb-ktx2/` 夹具来源（真件 + 一份**有据可查的派生件**）

本目录供 `packages/viewer/test/robot-glb-ktx2-texture.test.ts` 做
「机器人文档 + 带 KTX2 贴图的 `.glb`」这一族的判据（ROBOT-GLB-KTX2-TEXTURE-20260927）。

| 文件 | 字节 | sha256 | 是什么 |
| --- | --- | --- | --- |
| `robot-ktx2.xml` | 1,015 | `e7d5bd6f24441122e051722b8fa639d524952aa65362be9b6e2bd3bc88bb2a15` | **手写的最小真 MJCF 机器人文档**：`<mesh file="cube-ktx2-etc1s.glb"/>` + 一个 hinge 关节 + 一个网格图元 + 一个碰撞盒。网格图元**不声明** `material`（这样 glTF 自带的材质/贴图不被 MJCF 调制色替换，"贴图有没有挂上"才是可读的） |
| `robot-ktx2-material.xml` | 926 | `be742e4c0115031932792bf80789a77376803593fa16ac568a9f509016ab3ce5` | 同上，但图元**声明了** `material="shell_paint"`（该材质没有贴图）：量的是"调制语义替换掉 `.glb` 自带贴图"那一种"无贴图" |
| `robot-ktx2-external.xml` | 977 | `2fc62f5e2920702d5a1c5aa3e5c91fb521f18644732e22d1d2747b505723391b` | 同上，引用**贴图是外部文件**的那份 `.glb`（闭包边界那一件） |
| `cube-ktx2-etc1s.glb` | 2,676 | `a2113d1561d8e06138502c26338308b5b59e16c1944d117b69db48d3d8de7b87` | **真编码器产物**：逐字节拷贝自 `packages/viewer/test/fixtures/ktx2-meshopt/cube-ktx2-etc1s.glb`（那份的来源见它自己的 `PROVENANCE.md`：`gltf-transform etc1s`，后端 KTX-Software 4.4.0） |
| `cube-ktx2-etc1s-external-image.glb` | 2,680 | `5347c2a17ad457afe89213bd5e7bca46e838d2ff2f72f4d5a5f93d75140f0831` | **派生件**（见下）：同一份立方体，但 `images[0]` 改成外部 `uri` |
| `checker8.ktx2` | 477 | `871904d7a51f557d9c3eb2d9b5ddc256881c38071272685d83a88855c2b180d6` | 上面那份 `.glb` 的**外部贴图**：字节就是 `cube-ktx2-etc1s.glb` 里 `images[0]` 那段（逐字节相同） |

## 那份 `.glb` 的容器事实（自己读出来的，不采信别人的登记）

```
magic="glTF" version=2  bytes=2676
extensionsUsed     = ["KHR_texture_basisu"]
extensionsRequired = ["KHR_texture_basisu"]        ← 必需扩展：没接转码器就整件被拒
meshes=1 primitives=1 materials=1("P0Checker") textures=1 images=1("checker8", image/ktx2, bufferView 0)
accessors: POSITION 24 / indices 36（12 三角形）
buffers: [{byteLength:1320}]（内嵌 BIN chunk）
```

## 派生件怎么来的（可复跑，脚本在 `.runtime/lane-robotglb-ktx2/tools/split-ktx2-external.ts`）

把 `images[0]` 从"指向内嵌 bufferView"改成"指向同目录的外部文件 `checker8.ktx2`"：
那段字节**原样**取出写成文件（sha256 与源件里那段逐字节相同，测试里有一条断言直接对照），
JSON chunk 重排、内嵌 BIN chunk（几何）原封不动 ⇒ 仍是合法 GLB、仍是 `KHR_texture_basisu` 件。
**这不是"手写一个假件"**：几何、材质、sampler、KTX2 字节全部来自真编码器产物；
被改的只有 image 的**指向**（这是 glTF 规范允许的形态，也是本单第 2 件要量的形状）。

```bash
bun .runtime/lane-robotglb-ktx2/tools/split-ktx2-external.ts \
    packages/viewer/test/fixtures/ktx2-meshopt/cube-ktx2-etc1s.glb \
    .runtime/lane-robotglb-ktx2/derived
cp .runtime/lane-robotglb-ktx2/derived/{cube-ktx2-etc1s-external-image.glb,checker8.ktx2} packages/viewer/test/fixtures/robot-glb-ktx2/
```

## 复核命令（sha256 以实时值为准）

```bash
sha256sum packages/viewer/test/fixtures/robot-glb-ktx2/*
bun test packages/viewer/test/robot-glb-ktx2-texture.test.ts
```
