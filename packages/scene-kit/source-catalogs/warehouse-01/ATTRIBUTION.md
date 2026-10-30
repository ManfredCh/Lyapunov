# 固定 Warehouse 源元数据

来源：NVIDIA Corporation 的 `nvidia/PhysicalAI-SimReady-Warehouse-01`，固定 revision `c7fe115cb79c7ddbd0532630d7768b5736b0ecc4`，源 README 明确声明 CC-BY-4.0。原始 README 保存在 `README.upstream.md`，包含原许可说明。

- `catalog.csv`：源 CSV 原字节，753 是此版本的目录行数，不是已导入或运行合格资产数。
- `files.json.gz`：同 revision 的 HF `files_metadata` 返回字段整理后压缩，只含文件路径、大小、Git blob/LFS 内容身份。返回了 8804 项文件元数据，不据此推导库内资产总量；导入只信其中逐项已核对的依赖。
- `pins.json`：固定 revision、CSV/README 的 SHA256 与源 Git blob 身份、文件身份索引校验和、归属与读取方式。

取得入口为 `https://hf-mirror.com`。CSV/README 从该固定 revision 的镜像 CLI 缓存读取并核对源 Git blob；这不代表当次重新联网成功。文件身份索引来自同 revision 的镜像 `files_metadata` API 调用。缓存状态和显式刷新失败会单独返回。

原 CSV 的 `asset_preview` 含官方站点 URL，仅保留在原始源文件中。适配器不会把它作为浏览器自动图片地址；缩略图未受控取得时明确缺省，不跟随官方/CDN跳转。
