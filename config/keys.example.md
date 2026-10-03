# LyapunovDev 配置 key 位置

真实值不上传。服务器 key 只进入 Secret Manager 或包外 `.env`。

## 收录边界（这份文件收什么、不收什么）

**它不是环境变量的全集，而是「读者要动手配的键」的登记面**：凭据、端点与模型档位、Provider/引擎/工具覆盖，加 SPEC §5 点名的凭据族。
产品自己会填的内部变量（例如启动入口注入的 `LYAPUNOV_NODE_BIN`）不在这里逐条登记。

**收**：

- 产品进程（桌面端、开发模式 Host、打包链）**会读**的键：凭据、端点与档位、Provider/引擎/工具覆盖（解释器、模型目录、转换器路径）；
- **凭据族按族登记**：`LYAPUNOV_IDENTITY_*`、`LYAPUNOV_BILLING_*`、`LYAPUNOV_RELAY_PEIRI_*` —— 即使真值只在服务端、客户端一个读取点都没有，
  也在这里写明"有这些名字、谁配、配在哪"。

**不收**（逐个点名，免得读者以为它们不存在；按名单去对应文件找）：

- **服务端进程自己的部署参数与自签密钥** —— 登记面是 `config/server.env.example`（逐条带默认值与注释，部署时整份照抄）：
  `LYAPUNOV_API_HOST`、`LYAPUNOV_API_PORT`、`LYAPUNOV_API_DATABASE`、
  `LYAPUNOV_MODEL_CATALOG_FILE` **或** `LYAPUNOV_MODEL_CATALOG_JSON`（模型目录二选一，两个都登记在同一处）、
  `LYAPUNOV_PUBLIC_ORIGIN`、`LYAPUNOV_ALLOWED_ORIGINS`、`LYAPUNOV_SESSION_PEPPER`、`LYAPUNOV_PAYMENT_WEBHOOK_SECRET`，
  以及那份模板里注释掉的可选三项 `LYAPUNOV_ADMIN_SECRET` / `LYAPUNOV_ALIPAY_CHECKOUT_URL_TEMPLATE` / `LYAPUNOV_WECHAT_CHECKOUT_URL_TEMPLATE`。
  这 8 个**位置**在客户端**没有一个读取点**（`distribution/macos/env.example` 里那行 `ALLOWED_ORIGINS` 是模板注释，不是读取）
  ⇒ 收进来会让读者以为客户端要配。（模型目录那一个位置有两个互斥入口：给 `_JSON` 或给 `_FILE`，都算登记在
  `config/server.env.example`。）
- **已退役的键**：`OPENROUTER_API_KEY`（随 Jev 每步路由退役，产品不再供给；只留在 `script/host.ts` 的脱敏清单里作防御）。
  登记进本文件会被重新读成"可用入口"。
- **macOS 桌面客户端的启动/打包参数与代理** —— 登记面是 `config/macos.env.example`（发行包内是同一份
  `distribution/macos/env.example`）：`LYAPUNOV_API_URL`、`LYAPUNOV_DESKTOP_DATA_DIR`、`LYAPUNOV_UPDATE_URL`、
  `LYAPUNOV_ACCOUNT_TOKEN`、`LYAPUNOV_ELECTRON_BINARY`、`BLENDER_EXECUTABLE` / `BLENDER_HOST` / `BLENDER_PORT`、
  `HTTP_PROXY` / `HTTPS_PROXY`、`MUJOCO_GL`、`RUNTIME_ENV`。与本文件重叠的键（如 `LYAPUNOV_MUJOCO_PYTHON`、
  `LYAPUNOV_DEVELOPER_AUTH_FILE`）两处都查得到：本文件给语义，模板给注释示例。

## DeepSeek 开发模式

- `DEEPSEEK_API_KEY`：当前开发进程环境。
- `LYAPUNOV_DEVELOPER_AUTH_FILE`：包外 `model-auth.json`，格式 `{ "deepseek": { "type": "api", "key": "..." } }`。

## 公司官网身份

- `LYAPUNOV_IDENTITY_BASE_URL`
- `LYAPUNOV_IDENTITY_CLIENT_ID`
- `LYAPUNOV_IDENTITY_CLIENT_SECRET`
- `LYAPUNOV_IDENTITY_REDIRECT_URI`

这些只写入服务端 `.env`（服务端源码归 LyapunovOM：`backend/dev-server/services/lyapunov-api/`）或云 Secret Manager。

## 中央积分

- `LYAPUNOV_BILLING_SERVICE_URL`
- `LYAPUNOV_BILLING_PUBLIC_URL`
- `LYAPUNOV_BILLING_APP_ID`
- `LYAPUNOV_BILLING_APP_SECRET`

`LYAPUNOV_BILLING_APP_ID` 必须与公司官网 WebBff 相同；`APP_SECRET` 必须来自中央 BillingService。

## Marble/Hunyuan 服务端

- `LYAPUNOV_MARBLE_API_BASE_URL` / `LYAPUNOV_MARBLE_API_KEY` / `LYAPUNOV_MARBLE_POINTS`
- `LYAPUNOV_HUNYUAN_API_BASE_URL` / `LYAPUNOV_HUNYUAN_API_KEY` / `LYAPUNOV_HUNYUAN_POINTS`

这些 key 只进入公司服务器，浏览器和桌面开发包不保存。开发模式直连 Hunyuan 的 `OBJECT_GENERATOR_API_KEY` 也只允许当前本地进程使用。

## Tripo（阿里云百炼）开发模式

- `TRIPO_API_KEY`：百炼北京地域 API Key；未设置时回落官方约定的 `DASHSCOPE_API_KEY`。
- `TRIPO_WORKSPACE_ID`：百炼业务空间 ID，用于拼出 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com`；也可用 `TRIPO_API_BASE_URL` 显式覆盖完整入口。都未设置时使用百炼经典域名 `https://dashscope.aliyuncs.com`。
- 可选：`TRIPO_MODEL`（默认 `Tripo/Tripo-P1.0`）、`TRIPO_TEXTURE_QUALITY`、`TRIPO_GEOMETRY_QUALITY`、`TRIPO_PBR` / `TRIPO_TEXTURE`、`TRIPO_POLL_ATTEMPTS` / `TRIPO_POLL_INTERVAL_MS`、`TRIPO_REFERENCE_IMAGE_HOSTS`。

Tripo 目前只有开发模式直连，key 只允许当前本地进程使用；中央服务端没有 `LYAPUNOV_TRIPO_*` 配置，正式路由未开通。

## 千问图像（阿里云百炼）开发模式

- `IMAGE_API_KEY`：百炼北京地域 API Key；未设置时回落官方约定的 `DASHSCOPE_API_KEY`。
- `IMAGE_API_BASE_URL`：显式覆盖完整入口（必须 https，除本机回环外）；未设置时用 `IMAGE_WORKSPACE_ID` 拼
  `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com`，再回落 `TRIPO_WORKSPACE_ID`，都未设置用百炼经典域名
  `https://dashscope.aliyuncs.com`。官方要求模型/入口/Key 同一地域，所以业务空间域名固定北京后缀。
- `IMAGE_MODEL`：模型档位（默认 `qwen-image-3.0`）。档位决定计费，所以**只能来自可信配置**；
  模型 JSON 里的 `model` / `apiKey` / `baseURL` / `endpoint` 一律被工具拒绝（`GENERATION_CREDENTIAL_REDIRECT_REJECTED`）。
- 可选：`IMAGE_POLL_ATTEMPTS`（默认 200）、`IMAGE_POLL_INTERVAL_MS`（默认 3000，范围 500–60000）。

开发模式直连百炼官方**异步**接口，key 只允许当前本地进程使用。

**配置怎么进到 Host**（只有这一条路，别的地方写 `IMAGE_*` 不生效）：这些键由 `provider.ts` 在调用时从
**Host 进程的环境**读，而 Host 的环境由启动入口装配：

- `node script/developer.ts`（读 `config/developer.yaml` 的 mode/surface/engine/route）与
  `script/launch.ts` 的非隔离实例：本来就把启动进程的环境整份交给 Host，`IMAGE_*` 照常生效；
- 隔离启动的入口——终端 `node script/terminal.ts` 与管理员 Web Host——会把父进程环境清成一个小白名单，
  因此 `script/profile.ts` 的 `backendEnvironment` 会按 `packages/generate-image/src/provider.ts`
  里**声明过**的那份清单（上面这几个 `IMAGE_*` 加回落键 `DASHSCOPE_API_KEY` / `TRIPO_WORKSPACE_ID`）
  把这些值逐个搬进 Host；清单外的任何变量（HOME/XDG、其它凭据）仍然被隔离，key **不写进**任何
  Profile 补丁 YAML（那是普通可读文件）；
- **正式模式一个都不搬**：那条路由经中央账户网关，供应商 key 只在服务端。

## 千问图像（阿里云百炼）正式模式

客户端（插件）不需要供应商 key：请求经中央账户网关转发，密钥只在服务端。服务端四件套**必须同时配置**，
半配置会在启动时直接报错（不猜端点、不换模型），另加一次计费的积分：

- `LYAPUNOV_IMAGE_API_BASE_URL` / `LYAPUNOV_IMAGE_API_KEY` / `LYAPUNOV_IMAGE_MODEL` / `LYAPUNOV_IMAGE_SUBMIT_PATH`
  （提交路径按官方文档给出，例如 `/api/v1/services/aigc/image-generation/generation`）；
- `LYAPUNOV_IMAGE_POINTS`：每请求固定积分（四件套配置后必填）。

图像插件与 `generate-marble` / `generate-hunyuan` / `generate-tripo` 在 `script/runtime-patch.ts`
的同一处装配（同一 `dataDirectory` 分域、`allowPaidSubmission:false`），不另起启动器。
缺 key 时插件照常加载，调用时如实报 `IMAGE_API_KEY is required for image generation`，不伪造出图。

## Peiri（对外唯一模型）的服务端上游

客户端（插件/桌面端）**不持有上游 key**：请求经中央账户网关转发，上游地址、上游模型与上游 key 只在服务端装配。
三个 `LYAPUNOV_RELAY_PEIRI_*` 是 SPEC §5 点名的凭据族，**实际登记在 `config/server.env.example:36-38`**
（本文件按族登记名字与边界，不另抄那份模板）：

- `LYAPUNOV_RELAY_PEIRI_BASE_URL` / `LYAPUNOV_RELAY_PEIRI_MODEL` / `LYAPUNOV_RELAY_PEIRI_API_KEY`：
  服务端转发用的上游入口 / 上游模型 id / 上游 key。**名字不写死在代码里**：服务端按模型目录
  （`LYAPUNOV_MODEL_CATALOG_JSON` 给的 JSON 文本，或 `LYAPUNOV_MODEL_CATALOG_FILE` 指向的那份 JSON；二选一）
  里的 `upstreamBaseUrlEnv` / `upstreamModelEnv` / `upstreamApiKeyEnv`
  三个字段去环境里取同名变量；**缺 key 时服务端装配即报 `required upstream key is missing: <变量名>`**（不猜、不回落）。
  入口必须 HTTPS（`127.0.0.1` / `localhost` 除外）。同一块映射还有 `systemPromptEnv` = `LYAPUNOV_PEIRI_SYSTEM_PROMPT`
  （Peiri 身份提示词，与三键同一处登记：`config/server.env.example:39`）。
- 客户端侧只有公共模型 id `peiri`（模型列表的公开面）；本仓（客户端）**没有任何一个 `LYAPUNOV_RELAY_PEIRI_*` 读取点**。

## Provider/运行覆盖

- `LYAPUNOV_CAD_PYTHON`：DXF 读取（工具 `cad_inspect`）用的**隔离** Python 解释器，必须装了 `ezdxf`；
  与 Blender/Isaac/MuJoCo 的解释器互不相干（每个引擎的依赖被自己的运行时约束，不往里面塞第三方包）。
  未设置时工具**不猜**解释器，直接报 `CAD_PYTHON_UNCONFIGURED` 并提示配置解释器
  （见 `docs/CAD_INPUT.md`）。开发模式由 `script/runtime-patch.ts` 把该值显式传给 blender 插件的
  `cadPython`；未设置就不传，不造假路径。
- `LYAPUNOV_CAMERA_FIT_PYTHON`：照片相机拟合（工具 `camera_fit`）用的**隔离** Python 解释器，必须装了
  `opencv-python-headless` 与 `numpy`；同样与其它引擎的解释器互不相干。未设置时工具报
  `CAMERA_FIT_PYTHON_UNCONFIGURED` 并给出安装提示（**不猜**解释器）；开发模式由 `script/runtime-patch.ts`
  把该值显式传给 blender 插件的 `cameraFitPython`（字符串路径）。
- `LYAPUNOV_DWG_CONVERTER`：DWG → DXF 转换器（工具 `drawing_inspect` / `cad_convert` 读 DWG 时用），例如
  GNU LibreDWG 的 `dwg2dxf`；可选 `LYAPUNOV_DWG_CONVERTER_KIND`（`libredwg` / `command`）与
  `LYAPUNOV_DWG_CONVERTER_ARGS`（JSON 数组或空白分隔，用于 `command` 类）。未设置时沿 `PATH` 找 `dwg2dxf`；
  一个都没有就报 `DWG_CONVERTER_UNCONFIGURED`（不假装能读 DWG）。**按目录调用的 ODA File Converter
  不在支持范围**（本实现没有实测过该分支），配它会被 `DWG_CONVERTER_UNSUPPORTED` 明确拒绝；
  开发模式由 `script/runtime-patch.ts` 传给 blender 插件的 `dwgConverter`（同样是字符串路径）。
- `LYAPUNOV_DEPTH_ESTIMATION_PYTHON` 与 `LYAPUNOV_DEPTH_ESTIMATION_MODEL_DIR`：同时配置后加载可选深度插件，分别指向独立解释器和本地相对深度权重；默认 CPU。
- `LYAPUNOV_DEPTH_ESTIMATION_DATA_DIR`、`LYAPUNOV_DEPTH_ESTIMATION_DEVICE`：可选产物目录与 `cpu` / `cuda`。权重只通过 `HF_ENDPOINT=https://hf-mirror.com` 获取，推理离线；见 `docs/DEPTH_ESTIMATION.md`。
- `LYAPUNOV_MUJOCO_PYTHON`、`LYAPUNOV_ISAAC_PYTHON`
- `LYAPUNOV_ISAAC_DEVICE`、`LYAPUNOV_ISAAC_RENDERING`
- `LYAPUNOV_SAM3_CHECKPOINT`
- `LYAPUNOV_BLENDER_MCP_COMMAND`
- `LYAPUNOV_MICROMAMBA`：Provider 安装前置的 micromamba 可执行文件路径。发行布局用自带的
  `runtime/micromamba/micromamba`，**开发检出必须指向本机那个**（例如 `LYAPUNOV_MICROMAMBA="$(command -v micromamba)"`，
  见根 `README.md` 的 `install-provider` 示例）。指向的不是可执行文件时 `install-provider` 直接报
  `PROVIDER_ENV_TOOL_MISSING`（不回落 PATH 里的另一个）；环境面板与 `doctor-env` §1d 用同一判据。

模型权重、session token、数据库和浏览器 profile 都放在包外私有目录。

## 打包 / 取件期的覆盖变量

两个键同属「**显式覆盖、命中即用、读不到就是没有**」这一形状，不新增配置文件格式；登记口径与边界见
`docs/ENVIRONMENT_SPEC.md` §5.1。

- `LYAPUNOV_MAMBA_LICENSE`：打包期**许可证身份的操作者覆盖**出口，指向一份 micromamba 许可证副本。
  相对路径按**仓库根**解析，命中即用、不联网。**设置了但文件不存在或内容为空 ⇒ 立刻中止打包**
  （显式覆盖被静默忽略比失败更危险）。用它时身份**不可核验但仍采用**，并**响亮报告**：
  日志 `micromamba-license-identity-unverified` + `RELEASE.json.pinProblem`。
  **正规流程是入库 + 补 `meta.json`**（见 `distribution/licenses/README.md`）——未登记的 micromamba
  版本即使能出网也中止打包，网络兜底与缓存都救不了它。
- `LYAPUNOV_GITHUB_TOKEN`：GitHub REST 凭据，**只发给 `api.github.com`**（内容字节走的 raw 端点
  一个字节都不带）。取值顺序 `LYAPUNOV_GITHUB_TOKEN` → `GITHUB_TOKEN` → `GH_TOKEN`。
  都没有 ⇒ 匿名 core **60 次/小时**（按出口 IP），一次取件固定 3 个请求 ⇒ 约 **20 次取件/小时**；
  带凭据 ⇒ 5000 次/小时。报错只报**命中的变量名**，值绝不进 URL／日志／manifest／回执。


## 原生桌面访问

- `LYAPUNOV_COMPUTER_USE`：默认不启用原生桌面 computer-use。仅显式设置 `1` 时加载驱动；`0` 或未设置时不挂载。已有快捷键与窗口范围守卫仍执行，窗口编号本身不证明任务授权，详见 `bugfixHistory/COMPUTER-USE-BOUNDARY-20260927.md`。浏览器专用能力继续使用独立进程。
