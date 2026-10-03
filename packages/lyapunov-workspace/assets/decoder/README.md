# 预览用解码器资源（随产品走，不依赖 node_modules）

这里放的是 three 自带的 glTF 扩展解码器副本，供**模型预览**在运行时按 URL 取用：

- `draco/`：`KHR_draco_mesh_compression`（`DRACOLoader` 默认 wasm 模式取 `draco_wasm_wrapper.js` + `draco_decoder.wasm`；JS 回退取 `draco_decoder.js`）
- `basis/`：`KHR_texture_basisu`（`KTX2Loader.setTranscoderPath()` 取 `basis_transcoder.js` + `basis_transcoder.wasm`）

**为什么要复制一份**：宿主路由原先只从 `<产品根>/node_modules/three/examples/jsm/libs/**` 取文件。
在那个路径不存在（安装形态不同、依赖被裁剪、或换机器只带产品包）时预览的压缩 glTF 会 404。
现在路由**优先**从这里取、`node_modules` 只作兜底，所以"装了产品就能看压缩 glTF"。
复制来源：three@0.180.0（`examples/jsm/libs/{draco,basis}`），未做任何修改。

升级 three 时请同步更新这里的副本（版本号见产品依赖 `three`）。
