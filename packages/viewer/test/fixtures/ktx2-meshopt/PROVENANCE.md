# `ktx2-meshopt/` 夹具来源（真件，不是手写占位）

本目录的 6 个 `.glb` 是**真编码器/真压缩**的产物，供
`packages/viewer/test/gltf-ktx2-meshopt-decoders.test.ts` 做"解码器真的接上了"的判据。
两份"最小真件"各带一个压缩扩展，另有两份对照。

| 文件 | 字节 | sha256 | 用了哪个扩展 |
| --- | --- | --- | --- |
| `cube-plain.glb` | 972 | `5d9f1f7b1fcdd46db07371b134f5d3ded2322d1c0b09ef417d4004c79b650749` | **无**（对照件：无贴图、无材质、未压缩几何） |
| `cube-meshopt.glb` | 1,268 | `ee6159cede7466284da91ebb39ed3921f8310beb8c5e81110e55353a23d194c3` | `EXT_meshopt_compression`（used + **required**） |
| `cube-gltfpack.glb` | 2,664 | `f3abc1e58eeaf21b63ec4168252be258a8037ed931cea58985ea7036e372da60` | 同上（**gltfpack 1.2 官方 CLI** 的输出，做交叉核对） |
| `cube-ktx2-etc1s.glb` | 2,676 | `a2113d1561d8e06138502c26338308b5b59e16c1944d117b69db48d3d8de7b87` | `KHR_texture_basisu`（used + **required**，KTX2/BasisLZ 超压缩 = 1） |
| `cube-ktx2-uastc.glb` | 2,628 | `3a37c37541e3a8dc2463718b6b625547426367a55c862b2367f7262f19c7e84e` | 同上（UASTC，supercompressionScheme = 2） |
| `cube-png.glb` | 2,208 | `281cfe9820067af8abf710a64efce5c44264771fefb27f988c19aa9984225407` | **无**（PNG 贴图 + 未压缩几何；它是两份 KTX2 的**编码源**，本身不做加载判据 —— 见下） |

五个件都是**同一个 24 顶点 / 12 三角形的立方体**（位置单位立方体、中心在原点），所以读数直接可比：
解出来必须是 24 顶点 / 12 三角形。

> `cube-png.glb` 只当 KTX2 的编码源，**不**进加载判据：它的贴图走 three 的 `ImageLoader`（要真 DOM），
> 而别的测试文件会往 `globalThis` 上装 `document` 替身 ⇒ 整包跑测试时那次贴图加载可能永远不 settle
> （实测：同一条用例单跑 3 ms、整包跑 5 s 超时）。"第二方向"（不加压缩的件照旧能加载）改用无贴图的
> `cube-plain.glb`，判据就不依赖别的文件有没有装 DOM 替身。

## 怎么生成（可复跑）

工具链装在一个临时目录（**没有**往仓库的 `package.json` / lockfile 写任何东西；`.runtime/` 与
`node_modules/` 都在 `.gitignore` 里）：

```bash
mkdir -p .runtime/lane-ktx2meshopt-20260927/toolchain && cd $_
printf '{"name":"ktx2meshopt-toolchain","private":true,"version":"0.0.0"}\n' > package.json
env -u all_proxy -u ALL_PROXY -u http_proxy -u https_proxy \
  npm install --no-save gltfpack@1.2 @gltf-transform/cli@4.5.0 ktx2tools@1.1.0
# 版本核对：gltfpack 1.2 / gltf-transform 4.5.0 / ktx (KTX-Software) v4.4.0
```

> 注意：本机 `/tmp` **跨命令不保留**（每次 bash 调用都是新 `/tmp`），所以工具链不能装到 `/tmp`。

```bash
# 1) 立方体（对照件）+ 手写 PNG（node:zlib 的 deflateSync）+ meshoptimizer 0.22 官方 JS 编码器真压缩
bun .runtime/lane-ktx2meshopt-20260927/tools/make-fixtures.ts
#    → fixtures/cube-plain.glb、fixtures/cube-png.glb、fixtures/cube-meshopt.glb

# 2) KTX2（ETC1S / UASTC）：gltf-transform 编码，后端是 KTX-Software 4.4.0 的 `ktx`
export PATH="$PWD/.runtime/lane-ktx2meshopt-20260927/toolchain/node_modules/.bin:$PATH"
cd .runtime/lane-ktx2meshopt-20260927/fixtures
gltf-transform etc1s cube-png.glb cube-ktx2-etc1s.glb --quality 128
gltf-transform uastc cube-png.glb cube-ktx2-uastc.glb --level 2

# 3) 交叉核对：同一份源交给 meshoptimizer 官方 CLI（gltfpack），容器形状应与手拼的那份一致
gltfpack -i cube-png.glb -o cube-gltfpack.glb -c -v
#    → input/output 都是 12 triangles, 24 vertices

# 4) 复核（扩展声明 + 真让 three 解码）
bun .runtime/lane-ktx2meshopt-20260927/tools/inspect-fixtures.ts
```

生成脚本与复核脚本都在 `.runtime/lane-ktx2meshopt-20260927/tools/`（gitignored，scratch）；
本目录的 `.glb` 是它们的**产物拷贝**，生成后逐字节未改。

## 为什么用这些工具而不是手写一个"假扩展"

`EXT_meshopt_compression` 的字节由 **meshoptimizer 0.22.0 官方 JS 编码器**（`MeshoptEncoder.encodeGltfBuffer`）
真编码；KTX2 的字节由 **KTX-Software 4.4.0** 真编码（`supercompressionScheme=1` BasisLZ / `2` UASTC，
`vkFormat=0` = Basis Universal 超压缩容器）。这样判据读到的是"解码器解开了真压缩数据"，
不是"解析器认出了一个自己写死的标记"。
