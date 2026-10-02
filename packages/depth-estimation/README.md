# 单目相对深度估计插件（Depth-Anything-V2-Small）

本包提供 Tool / Command `depth_estimate`：对一张真实图片做**单目相对深度**估计，输出原图尺寸与模型尺寸的 float32 `.npy`、可视化 PNG、以及尺寸/预处理/模型身份/数值统计 metadata；彩色预览会作为**图像**随结果返回（同步路径进同一批 content blocks，后台路径由本插件用 owner 消息投递）。人工调用与模型 Tool 共用同一个 operation，后台运行复用 DSH 原生 `ctx.jobs`。

结果语义（不得混用）：**相对深度，值越大越近，不是米制**；本包不产出置信度，也不做米制标定。天空等饱和区因为模型末尾的 ReLU 会得到精确 `0.0`。

权重目录可以指向任意本地 checkpoint，但这份"相对反深度"的语义必须由 checkpoint 自己背书：worker 加载后核对 `config.depth_estimation_type`，不是 `relative`（例如米制权重）就在推理前报 `DEPTH_TYPE_UNSUPPORTED`，不会把米制输出说成相对深度。

## 装配

[Linux CPU 安装步骤](../../docs/DEPTH_SETUP.md)给出可直接执行的独立环境安装与私有 HOME 自检命令。

`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，按最薄层约定以 `insert` 追加插件：

```yaml
- insert:
    - id: lyapunov-depth-estimation
      name: '@lyapunov/depth-estimation'
      # 产品装配（script/runtime-patch.ts）只在**显式配置**时插入这一行，并把配置写进 config：
      # config: {pythonPath: <venv>/bin/python, modelDirectory: <权重目录>, device: cpu}
```

产品装配的开关就是下面表里的两个**必需**环境变量：`LYAPUNOV_DEPTH_ESTIMATION_PYTHON` 与
`LYAPUNOV_DEPTH_ESTIMATION_MODEL_DIR` **同时**给出才插行；只给一半在装配期报“半配置”错误，都不给=不加载、不阻塞其他功能。解释器与权重目录由使用方自备（本包不装全局依赖、不动既有 GPU 服务），`device` 省略即 CPU。

产品插件声明的必需服务是 `tools`、`subprocess`、`jobs`、`commands`，正常 Lyapunov Host 已提供这些服务。仅装 `tools` 与 `subprocess` 不足以激活完整插件。独立脚本可以直接调用共用 operation，所需服务另按实际调用确定。

`attachments` 是可选增强：有它才有图片内容块；缺失或存储失败时，结果保留产物路径并在 `imageDelivery.error` 说明原因。后台作业沿用产品已装配的原生 Jobs 与 `job_output` / `job_kill`。

配置字段（全部可选，缺省回落到同名环境变量再回落默认值）：

| 字段 | 环境变量 | 说明 |
| --- | --- | --- |
| `pythonPath` | `LYAPUNOV_DEPTH_ESTIMATION_PYTHON` | **必填**：带 torch/transformers/Pillow 的解释器 |
| `workerPath` | `LYAPUNOV_DEPTH_ESTIMATION_WORKER` | 默认本包 `python/worker.py` |
| `modelDirectory` | `LYAPUNOV_DEPTH_ESTIMATION_MODEL_DIR` | **必填**：本地权重目录（含 `config.json`/`preprocessor_config.json`/`model.safetensors`） |
| `dataDirectory` | `LYAPUNOV_DEPTH_ESTIMATION_DATA_DIR` | 输出根，可选；缺省 `$TMPDIR/lyapunov-depth-estimation`。**执行时按需创建**（每次请求一个 `<requestId>-<uuid>/artifacts` 目录），只读核查不会碰它 |
| `device` | `LYAPUNOV_DEPTH_ESTIMATION_DEVICE` | `cpu`（默认）或 `cuda`；请求 `cuda` 但不可用时明确报 `DEVICE_UNAVAILABLE`，不静默回落 |

解释器/worker/权重三项**读取前置**任一缺失或不可读时，同步入口在 spawn 之前抛 `PROVIDER_UNAVAILABLE`；输出根不算读取前置（第一次用新目录不会被自己的写前置挡住）。不会合成深度、不会返回假成功。

## 权重获取（只走 HF 镜像）

```bash
node packages/depth-estimation/script/fetch-model.ts --local-dir <目标目录> [--verify-only]
```

脚本固定 `HF_ENDPOINT=https://hf-mirror.com`，对 `huggingface.co` 或非镜像 host 直接 `ENDPOINT_FORBIDDEN`/`ENDPOINT_NOT_MIRROR` 失败（**不允许静默回退官网**）；镜像缺对象时报阻断而不是换源。下载后逐文件写 `lyapunov-model-manifest.json`（modelId/revision/license/source/files+sha256）：**这是权重哈希唯一的计算时机**（下载时写、`--verify-only` 离线重核），推理期只从清单取 revision/许可/声明字节数；没有清单只能在 metadata 里记 `MODEL_REVISION_UNKNOWN` 缺口。

推理期 worker 进程强制 `HF_HUB_OFFLINE=1`，只用本地权重，不联网拉取。

## 用法

```jsonc
// Tool depth_estimate 的 request_json
{
  "requestId": "scene-42-depth",
  "image": { "path": "refs/frame.jpg" },               // 相对路径按调用会话 cwd 解析；也可给绝对路径或 "uri": "file:///..."
  "params": {
    "device": "cpu",
    "modelInputSize": 518,        // 14 的倍数，默认 518
    "previewMaxSide": 1024,
    "lowPercentile": 2, "highPercentile": 98
  },
  "source": { "sceneId": "scene-42", "sceneRevision": 3, "frameId": "frame-001" }   // 可选，可整个不给
}
```

`source` 整体可选（网络照片/素材库导出的单图没有 scene/world/frame）；给了就逐字段校验类型，`worldId` 必须带 `worldGeneration`。未实现的 params 字段会被 `UNSUPPORTED_CAPABILITY` 明确拒绝（例如 `depth_output`），不会静默忽略。

- 同步：结果 JSON 是 Tool 的文本块，彩色预览作为**第二个内容块**（图像附件）返回；取不到附件服务或附件化失败时只回文本、不伪造图片。
- `background: true` 时返回 `{jobId, provider, requestId, source}`，用原生 `job_output` 读结果（字符串形式的同款 JSON）、`job_kill` 取消；作业完成时本插件把同一张预览图连同说明（原图路径、相对语义）作为一条 Agent 消息投给 owner，不新开回合、不新建任务表。
- **交付读数**：结果 JSON 里带 `imageDelivery:{mode:'tool-result'|'job-notice'|'none', attached:0|1, error?}`——图有没有真的进模型上下文是结果里读得到的；缺图一定带原因，不会让人以为看到了图。
- **Command `/depth_estimate` 只回文本**：同一 operation 但不附件化（结果里 `imageDelivery.error` 写明），因此不会留下没人取用的附件缓存。
- 取消一律真实终止 worker 进程；**附件化之后还会再核对一次取消**——被取消（含附件化期间被取消）或非零退出的运行不交付 completed 结果与产物、不投图。

## 运行协议（最薄）

`python/worker.py` 与仓库其它包同构，没有私有握手/事件流：

- stdin：一个 JSON 请求对象（requestId、image、params、model、outputDirectory、source）。
- stdout：最后一行 `LYAPUNOV_RESULT=<json>`，成功是结果对象，失败是 `{"error":{code,message,detail}}`。
- 退出码：`0` 成功、非 `0` 失败；取消由父进程终止子进程实现，不做协作式取消。
- 运行层最多落一份 `worker-stderr.log`（有 stderr 时），不再写第二份结果/事件文件。

## 产物

| artifact 类型 | 内容 |
| --- | --- |
| `depth.image.npy` | 原图尺寸 float32 相对深度（bicubic 上采样，未归一化） |
| `depth.model.npy` | 模型输出尺寸原始值（未插值，ReLU 后严格 ≥ 0） |
| `depth.preview.png` / `depth.preview.color.png` | 灰度/彩色可视化（分位点裁剪，仅影响显示） |
| `depth.metadata.json` | 尺寸、预处理、模型身份、数值统计、空间诊断 |

全尺寸数组经 bicubic 放大可出现极轻微负值过冲（本仓实测照片 0.37% 像素，最小 -0.33），模型原生输出不含负值。

数值正确性（npy 的 dtype/形状/字节数/有限性/统计）归**本包 Python worker**（写文件的就是算它的那份代码，它把 `statistics.constant=true` 的常量预测也当有效输出）；运行层只核对**现实性与归属**：五类产物齐全、文件真的存在且非空、落在本次产物目录内、metadata 自述 `relative:true, metric:false` 且尺寸齐备。既然运行时不再扫 npy，**写任何产物之前**由 worker 用 numpy 显式检查模型原生输出与插值后的数组都是**二维、非空、全 finite**：含**部分** NaN/Inf 的输出整幅拒绝（`DEPTH_VALUES_INVALID`），不把非有限值过滤掉继续算分位点/插值。推理期不重算产物哈希，**也不重算权重哈希**（`fetch-model.ts` 下载时写清单哈希，`--verify-only` 显式离线复核）。不设“必须有方差”的产品门槛，也不伪造置信度。

## 测试

`test/depth-estimate.test.ts` 是真实行为测试：真实 venv 解释器 + 真实权重 + 真实照片 + 原生服务装配，无模型替身。

```bash
LYAPUNOV_DEPTH_TEST_PYTHON=<venv>/bin/python \
LYAPUNOV_DEPTH_TEST_MODEL_DIR=<权重目录> \
LYAPUNOV_DEPTH_TEST_IMAGE=<真实照片> \
LYAPUNOV_DEPTH_TEST_DATA_DIR=<产物目录> \
node packages/depth-estimation/test/depth-estimate.test.ts
```

缺任一前置退出 2（不伪装通过）；全绿退出 0。图像附件用例需要附件存储可用（`@deepseek-ai/dsh-attachment-local` 依赖 `sharp`；本仓 `node_modules` 未装时用 `NODE_PATH` 指向本机已有安装，测试会先探测并明确退出 2，而不是含糊失败）。取消落在附件化期间的用例用"附件存储可控延迟"（真实存储外面套一层测试闸门）把窗口变确定，不造大产物、不靠计时赌博。详见 `docs/DEPTH_ESTIMATION.md`。

## 未完成 / 边界

- 米制深度与置信度**未实现**：不做标定，也不猜测尺度。`source` 里的字段（含相机元数据）会原样写入 metadata 供上层保存，但本包不解析相机参数、不做尺度反演，因此不能据此声称米制结果。
- 预览图只有一张（彩色）。灰度 PNG 仍在产物目录里，但不进模型上下文。
- GPU 路径已实现但本轮实测使用 CPU（显存被其它服务占用，不抢占、不停服）。
- 仅为 Small 基座相对深度；不下载 Base/Large。
