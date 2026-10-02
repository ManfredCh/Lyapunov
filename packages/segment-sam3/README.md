# SAM3 独立二维分割 Provider

本包使用 Meta 官方 SAM3 图像模型，提供文本提示与正/负框选提示分割。图像预处理、提示输入、模型推理均调用官方 SDK。Node/DSH 只启动本包自己的 Conda Python 进程并管理取消和输出；不运行 SAM 自带 Agent，不增加新的 LLM 循环。

当前 SDK 已安装并实际导入，模型权重下载因 `hf-mirror.com` TLS EOF **BLOCKED**。没有完成模型推理，不能把源码、SDK import 或缺权重错误测试记为真实分割通过。详细回执保留在开发仓库，不随发布源码提交。

## 配置与调用

插件入口 `src/plugin.ts`，Tool 与人工 Command 均为 `segment_sam3`，人工命令直接使用同一个执行函数，不经过语言模型或伪造 Tool 事件。

配置字段：

- `pythonPath`：`.runtime/conda/envs/sam3/bin/python`。
- `checkpointPath`：经镜像取得并校验的 `facebook/sam3/sam3.pt` 本地路径。
- `dataDirectory`：当前账号的私有分割产物目录。
- `device`：`cuda` 或 `cpu`，默认 `cuda`；CPU 路径尚未实测模型推理。

Tool/Command 输入是 `{request_json, background?}`。例如 `request_json` 的内容：

```json
{
  "requestId": "camera-frame-1-table",
  "imagePath": "/当前账号目录/captures/frame.png",
  "textPrompt": "table",
  "boxPrompts": [{"boxXYXY": [100, 120, 500, 460], "positive": true}],
  "source": {
    "sceneId": "scene-1",
    "sceneRevision": 8,
    "worldId": "world-1",
    "worldGeneration": 2,
    "stepIndex": 2100,
    "frameId": "world-1:2:2100"
  }
}
```

框坐标基于原图像素，适配器只在调用官方 `add_geometric_prompt` 时转换为归一化 `[cx,cy,w,h]`。负框使用 `positive:false`。只提供文本或只提供框也可以；是否实际成功必须由真实模型输出验证。

输出包含原图 PNG、每个 mask PNG、像素 `boxXYXY`、score、pixelCount、叠加图、source 与模型版本信息。`emptyResult:true` 明确表示真实调用没有有效掩码。二维 mask 不直接改写三维场景；用户明确保存/导入时由 Scene 工作台负责处理。每次调用写入独立目录，不覆盖先前分割产物。

## 安装与镜像约束

`script/dependencies/sam3-install.sh` 建立 Conda 环境并安装固定官方源码。模型下载与源码安装分离：

```bash
HF_ENDPOINT=https://hf-mirror.com \
  .runtime/conda/envs/sam3/bin/python script/dependencies/sam3-download.py \
  --output .runtime/sam3-models
```

下载脚本只允许 `hf-mirror.com` 请求，固定实际仓库 revision，按返回元数据检查文件大小/LFS SHA256。镜像失败、文件缺失、gated 权限不足或校验不符均退出 2，不回退官方或第三方权重。运行时使用明确的本地 checkpoint、`load_from_HF=False` 和 `HF_HUB_OFFLINE=1`。
