import {guestModelRows,guestProductServiceUrls} from "../packages/lyapunov-product-bundle/src/guest-runtime.ts"
import {policyRuntimeCandidates} from "../packages/lyapunov-product-bundle/src/policy-runtime.mjs"
import {writeFile} from "node:fs/promises"
import {existsSync,realpathSync} from "node:fs"
import {dirname,join} from "node:path"
import {userInfo} from "node:os"
import {fullyQualified} from "@deepseek-ai/dsh-host-directory-picker-browse"
import {PRODUCT_ROOT,UPSTREAM,reconcileAndReportProductLinks} from "./profile.ts"
import {formalModelRows} from "../packages/lyapunov-product-bundle/src/account/formal.ts"
import type {VerifiedAdministrator} from '../packages/lyapunov-product-bundle/src/account/administrator.ts'
import {readRuntimeEnv} from '../packages/lyapunov-product-bundle/src/runtime-paths.ts'
import {resolveSdkPython} from '../packages/lyapunov-product-bundle/src/sdk-python.mjs'
import {isMuJoCoGlBackend} from '../packages/sim-contract/src/mujoco-gl.ts'
import {developerAgentDefaultModel, developerDefaultCatalog} from './developer-model.ts'
import {ensurePluginModule} from './ensure-plugin.ts'
import {UNITY_SERVER_NAME,unityMcpPluginEntry} from './unity-mcp.ts'

/** Public chooser location is captured in the parent before HOME is isolated; it grants no workspace access. */
export function publicChooserHome(env:NodeJS.ProcessEnv=process.env,platform:NodeJS.Platform=process.platform,systemHome?:string):string{
  const chosen=(platform==='win32'?env.USERPROFILE:env.HOME)?.trim()
  if(chosen&&fullyQualified(chosen,platform))return chosen
  const fallback=systemHome??userInfo().homedir
  if(!fullyQualified(fallback,platform))throw new TypeError('Public chooser home must be a fully qualified path')
  return fallback
}

/**
 * Resolve the optional SAM3 checkpoint without putting a machine-specific
 * absolute path in a profile. An explicit path always wins; otherwise an
 * already verified project-local ModelScope cache is preferred, with the
 * historical gated-HF location retained as a fail-closed fallback.
 */
export function resolveSam3Checkpoint(){
  const explicit=readRuntimeEnv(process.env,"sam3Checkpoint")?.trim()
  if(explicit)return explicit
  const modelscope=join(PRODUCT_ROOT,'.runtime','sam3-models-modelscope','sam3.pt')
  if(existsSync(modelscope))return modelscope
  return join(PRODUCT_ROOT,'.runtime','sam3-models','sam3.pt')
}

export type RuntimeSimEngine = "none" | "mujoco" | "isaac" | "newton" | "benchmark"

/** snap 版 Blender 的载荷二进制：与启动器是**同一份安装**，但不需要 snapd/DBus 就能跑。 */
const SNAP_BLENDER_PAYLOAD = "/snap/blender/current/blender"

/** PATH 上第一个同名可执行文件（纯路径拼装，不起进程）。 */
function firstOnPath(name:string,pathValue:string|undefined,exists:(path:string)=>boolean=existsSync):string|undefined{
  for(const dir of (pathValue??"").split(":").filter(Boolean)){
    const candidate=join(dir,name)
    if(exists(candidate))return candidate
  }
  return undefined
}

/**
 * 该路径是不是 snap **启动器**：`/snap/bin/*` 下的入口，或指向 `/usr/bin/snap` 的链接。
 * 两者都是"先让 snapd 建 transient scope 再进载荷"的包装器；在没有 session DBus 的宿主里
 * 必然失败（实测退出码 46：`cannot create transient scope: DBus error`），载荷二进制则正常。
 */
function isSnapLauncher(path:string):boolean{
  if(path.startsWith("/snap/bin/"))return true
  try{return realpathSync(path)==="/usr/bin/snap"}catch{return false}
}

/**
 * Blender 可执行文件解析（ENV 链路阻断点 A）。
 *
 * 事实（2026-09-22 本机实测）：`blender` → `/snap/bin/blender` → `/usr/bin/snap`，直接跑退出码 **46**
 * （`cannot create transient scope: DBus error`）；`/snap/blender/current/blender --version` → `Blender 5.2.2 LTS`（退出 0）。
 *
 * 口径（与 `resolveSam3Checkpoint` 同一形状：显式 > 已验证可用 > 回退）：
 *  · `BLENDER_EXECUTABLE` 显式给值 → 原样使用，**不探测、不替换**（操作者的选择；跑不起来由插件按真实
 *    报错与退出码明确失败，不静默换成别的路径）；
 *  · 否则：只有 PATH 上第一个 `blender` 确实是 snap 启动器、且同一份安装的载荷二进制在场时才改用载荷；
 *    其余情况（没有 blender／非 snap 安装／载荷不在）保持 `blender` 不变 —— 不猜、不改非 snap 环境的行为。
 * `probe` 只用于测试注入（默认读真实文件系统）。
 */
export function resolveBlenderExecutable(env:NodeJS.ProcessEnv=process.env,probe:{exists?:(path:string)=>boolean;isSnapLauncher?:(path:string)=>boolean}={}):string{
  const explicit=env.BLENDER_EXECUTABLE?.trim()
  if(explicit)return explicit
  const exists=probe.exists??existsSync,launcher=probe.isSnapLauncher??isSnapLauncher
  const first=firstOnPath("blender",env.PATH,exists)
  if(!first||!launcher(first))return "blender"
  return exists(SNAP_BLENDER_PAYLOAD)?SNAP_BLENDER_PAYLOAD:"blender"
}

export function isaacRuntimeOptions(input:{physicsDevice?:string;rendering?:string;startupBudgetMs?:number}={},env:NodeJS.ProcessEnv=process.env){
  // 自动选中 Isaac 已要求 CUDA 加速器可用；显式 input/env 指定 cpu 仍优先，RTX 渲染保持显式开启。
  const physicsDevice=input.physicsDevice??env.LYAPUNOV_ISAAC_DEVICE??'cuda:0'
  const rendering=input.rendering??env.LYAPUNOV_ISAAC_RENDERING??'none'
  if(physicsDevice!=='cpu'&&physicsDevice!=='cuda:0')throw new Error('Isaac物理设备必须是cpu或cuda:0')
  if(rendering!=='none'&&rendering!=='rtx')throw new Error('Isaac渲染模式必须是none或rtx')
  // 显式启动预算原样带出，**不给默认值也不读环境**：Isaac RTX 冷缓存启动实测约 270s，凭空一个默认上限会杀掉
  // 有效启动，而未接线的 Host 进程环境本身会被隔离过滤，靠 env 会造成"只在单测里有效"的假象。合法性（正的有限
  // 毫秒数）由 ProcessSimProvider 构造函数这唯一一处校验，入口不重复解析。未给值时不带该键 = 一直等到 ready。
  return {physicsDevice,rendering,...(input.startupBudgetMs===undefined?{}:{startupBudgetMs:input.startupBudgetMs})}
}
export type IsaacRuntimeOptions=ReturnType<typeof isaacRuntimeOptions>
export type RuntimePluginInsert = {id:string;name:string;config?:Record<string,unknown>}
export type RuntimeDomains = {worldsRoot:string;assetsRoot:string;robotsRoot:string;cacheRoot:string;catalogRoot:string}
export type RuntimePatchInput = {dir?:string;mode:"developer"|"formal"|"local"|"guest";surface:string;sceneRoot:string;domains?:RuntimeDomains;benchmarkOutputRoot?:string;engine?:RuntimeSimEngine;isaac?:IsaacRuntimeOptions;sdkEnvironment?:NodeJS.ProcessEnv;grasp?:"none"|"analytic"|"graspgenx"|"anygrasp";accountApiUrl?:string;accountId?:string;administrator?:VerifiedAdministrator['admin'];modelBilling?:'own-key'}

/** 产品 Profile 实际插入的插件表。默认引擎不含官方套件适配器，也不启动其 worker。 */
export function runtimePluginInsert(input:RuntimePatchInput):RuntimePluginInsert[]{
  const plugins:RuntimePluginInsert[]=[]
  // 引擎选择、解释器路径与 Isaac 设备配置读取同一份父环境；不把整个环境写进 Profile。
  const sdkEnvironment=input.sdkEnvironment??process.env
  const add=(name:string,config?:Record<string,unknown>)=>plugins.push({id:"lyapunov-"+name,name:join(PRODUCT_ROOT,"packages",name,"dist/plugin.js"),config})
  // MuJoCo/规划 SDK：install-provider mujoco 同装 mujoco/mink/ompl/daqp/传输依赖。
  // Mink/OMPL/非 AnyGrasp 抓取仍共用这一前缀；几何烘焙在 Isaac 模式下复用
  // install-provider isaac 已安装的 requirements-isaac，不要求额外安装 MuJoCo。
  const mujocoPython=resolveSdkPython(PRODUCT_ROOT,"mujoco",sdkEnvironment).python
  // 一次读取同一 SDK 选择，几何派生与 Isaac worker 使用完全相同的解释器。
  const isaacPython=resolveSdkPython(PRODUCT_ROOT,"isaac",sdkEnvironment).python
  const algorithmPython=input.engine==="isaac"?isaacPython:mujocoPython
  const runtimeReadRoots=(python:string)=>[join(PRODUCT_ROOT,"packages"),python.endsWith("/python.sh")?dirname(python):dirname(dirname(python))]
  // 分域布局（worlds/assets/robots/cache/catalog）：给了 domains 就按三类分治落盘 + 新导入按类别
  // 落进对应域目录（materialized）；未给时回落旧单根与旧存储行为，保证老运行根逐路径不变。
  const d=input.domains
  // algorithmPython：碰撞派生（asset-bake 的 bake.py）由 scene-kit 的派生队列发起，隔离/管理员 Host
  // （终端入口就是 isolated）里 LYAPUNOV_ALGORITHM_PYTHON 不进环境，所以在这里与 sim/motion provider
  // 同一处解析后作为**显式非秘密配置**传进去——不放宽任何隔离白名单，解释器路径就是配置值。
  // mapTool:true —— 正式装配启用 `map_geojson_to_local`（数值全在系统 PROJ 里：projinfo 选运算、cct 执行它自报的管线）。
  // 它不影响 SceneKit 的其它能力：缺 PROJ 时只是这一个工具在调用时报 MAP_PROJ_UNAVAILABLE（装配时记一条 warn）。
  // Unity 交换的注册开关：**只在 Unity MCP 被显式配置**时把 unity 传给 scene-kit（未配置=不注册三个交换工具，
  // 不猜测、不自己连）。解析与校验唯一归 `script/unity-mcp.ts`（与下面那条 MCP 实例是同一份配置：
  // 同一份 unityMcp 既决定接哪条连接，也决定要不要注册 unity_scene_status/read/write）。
  const unityMcp=unityMcpPluginEntry()
  // 显式工程根（可选）：只有装配方显式给了才传。工程根本来由编辑器自报（mcpforunity://project/info）并经回执核对，
  // 但那条路要求 MCP 资源口在当前 agent 作用域可用；显式值只是"先绑定"，后续仍被编辑器自报值与回执核对校验（不符即报错）。
  const unityProjectPath=process.env.LYAPUNOV_UNITY_MCP_PROJECT_PATH?.trim()
  // 运行根：分治后由 domains 给出（catalogRoot 的父目录）；省略 domains（旧调用）时保持旧路径逐字不变。
  // 会话媒体产物根（截图/录像）与 sim-mujoco 的媒体中转边界都取自这里，装配方与插件用的是同一份值。
  const runtimeRoot=d?dirname(d.catalogRoot):undefined
  const captureRoot=runtimeRoot?join(runtimeRoot,"captures"):join(input.sceneRoot,"captures")
  // 录制是用户产物（不属于三类可调用资产，也不进可整删的 cache），留在运行根下的 recordings/。
  const recordingRoot=join(d?.cacheRoot??input.sceneRoot,"..","recordings")
  add("scene-kit",{dataRoot:d?.catalogRoot??input.sceneRoot,productRoot:PRODUCT_ROOT,algorithmPython,mapTool:true,...(unityMcp?{unity:{serverName:UNITY_SERVER_NAME,...(unityProjectPath?{projectPath:unityProjectPath}:{})}}:{}),...(d?{layout:{worlds:d.worldsRoot,assets:d.assetsRoot,robots:d.robotsRoot,cache:d.cacheRoot,catalog:d.catalogRoot},defaultStorage:"materialized"}:{})})
  const policyRuntimes=policyRuntimeCandidates(PRODUCT_ROOT,sdkEnvironment)
  add("policy-registry",{dataDirectory:d?.cacheRoot??input.sceneRoot,endpoint:process.env.MODELSCOPE_ENDPOINT??"https://modelscope.cn",...(input.mode==="guest"?{guest:true}:{}),...(policyRuntimes[0]?.provider==='policy-configured'?{pythonPath:policyRuntimes[0].python}:{pythonRuntimes:policyRuntimes})})
  add("lyapunov-mcp-extras",input.mode==="guest"?{guest:true}:undefined)
  // 正式账号只读身份/报价/原请求恢复保留；额外中央搜索不作为默认能力装配。
  if(input.mode==="formal")add("lyapunov-api-client",{apiUrl:input.accountApiUrl,search:false})
  // viewer 只提供浏览器代码（宿主半边是空实现），但 DSH 的客户端模块表只扫描"宿主 Loader 里的条目"，
  // 所以必须作为插件挂进 profile，shell 与 workspace 才能按 @lyapunov/viewer/client 共享同一份 three+spark。
  add("viewer")
  if (process.env.LYAPUNOV_SESSION_UNDO !== '0') add('lyapunov-session-undo', { dataRoot: join(input.sceneRoot, '..', 'worktree-history') })
  if(input.engine&&input.engine!=="none"){
    if(input.engine==="mujoco"){
      const renderBackend=process.env.LYAPUNOV_MUJOCO_RENDER_BACKEND
      // 校验用 MuJoCo 文档化的后端全集：Linux egl/osmesa/glfw、macOS cgl、Windows wgl。
      // 平台是否真的支持由 MuJoCo 自己判定；这里只拒绝未登记的值。
      if(renderBackend&&!isMuJoCoGlBackend(renderBackend))throw new Error('未知 MuJoCo 渲染后端：'+renderBackend)
      // productRoots：Shell 与 robot-workflows 按 `<根>/sessions/<会话键>` 写截图与录像的父根
      // （唯一规则是 lyapunov-contracts 的 sessionNamespace）。会话内部的采集/录制目录落在原生
      // 工作区授权根之外，所以这两处是 sim-mujoco 媒体中转的唯一边界，必须与实际写盘用的根逐字相同。
      add("sim-mujoco",{pythonPath:mujocoPython,workerPath:join(PRODUCT_ROOT,"packages/sim-mujoco/python/worker.py"),readOnlyRoots:runtimeReadRoots(mujocoPython),productRoots:[captureRoot,recordingRoot],...(renderBackend?{renderBackend}:{})})
    }
    // Newton：独立环境（自带 mujoco~=3.12.0 pin，与产品 mujoco 3.13.0 冲突），provider 走 Warp；
    // 无 NVIDIA GPU 的机器由 provider 内部退回 cpu（见 packages/sim-newton/README.md）。
    // productRoots 与 sim-mujoco 逐字同一份（captureRoot/recordingRoot）：三个引擎共用同一条
    // 媒体中转边界与同一份会话命名空间规则，只有落在本会话命名空间里的产物才由宿主代落盘；
    // 不登记就没有任何中转（越界写入如实失败），不会因为换了引擎就多出一条更宽的写路径。
    else if(input.engine==="newton"){
      const newtonPython=resolveSdkPython(PRODUCT_ROOT,"newton",sdkEnvironment).python
      add("sim-newton",{pythonPath:newtonPython,workerPath:join(PRODUCT_ROOT,"packages/sim-newton/python/worker.py"),readOnlyRoots:runtimeReadRoots(newtonPython),cacheRoot:join(d?.cacheRoot??input.sceneRoot,"provider-cache/newton"),productRoots:[captureRoot,recordingRoot]})
    }
    else if(input.engine==="isaac"){
      add("sim-isaac",{pythonPath:isaacPython,workerPath:join(PRODUCT_ROOT,"packages/sim-isaac/python/worker.py"),readOnlyRoots:runtimeReadRoots(isaacPython),cacheRoot:join(d?.cacheRoot??input.sceneRoot,"provider-cache/isaac"),productRoots:[captureRoot,recordingRoot],...isaacRuntimeOptions(input.isaac,sdkEnvironment)})
    }
    else if(input.engine==="benchmark"){
      const benchmarkProvider=(process.env.LYAPUNOV_BENCHMARK_PROVIDER??process.env.LYAUP_BENCHMARK_PROVIDER)?.trim().toLowerCase()||"libero"
      if(benchmarkProvider==="gymnasium") add("benchmark-gymnasium",{pythonPath:join(PRODUCT_ROOT,".runtime/bench/gymnasium-env/bin/python"),workerPath:join(PRODUCT_ROOT,"packages/benchmark-gymnasium/python/worker.py"),isolatedRoot:join(PRODUCT_ROOT,".runtime/bench/gymnasium"),...(input.benchmarkOutputRoot?{outputRoot:input.benchmarkOutputRoot}:{})})
      else add("benchmark-libero",{sceneDataRoot:d?.worldsRoot??input.sceneRoot,pythonPath:join(PRODUCT_ROOT,".runtime/bench/libero-env/bin/python"),workerPath:join(PRODUCT_ROOT,"packages/benchmark-libero/python/worker.py"),isolatedRoot:join(PRODUCT_ROOT,".runtime/bench"),agentStepBudget:Number(process.env.LYAPUNOV_BENCHMARK_AGENT_STEP_BUDGET??300),...(input.benchmarkOutputRoot?{outputRoot:input.benchmarkOutputRoot}:{})})
    }
    add("robot-tools")
  }
  add("robot-workflows",{recordingRoot})
  // 分享预览是可再生的中间产物，归 cache。
  if(input.mode!=="guest")add("lyapunov-share",{mode:input.mode,privateRoot:join(d?.cacheRoot??input.sceneRoot,"share-previews"),accountId:input.accountId,accountApiUrl:input.accountApiUrl,serviceUrl:process.env.LYAPUNOV_SHARE_SERVICE_URL,previewOrigin:process.env.LYAPUNOV_SHARE_PREVIEW_ORIGIN})
  if(input.grasp&&input.grasp!=="none")add("grasp-"+input.grasp,{python:input.grasp==="anygrasp"?join(PRODUCT_ROOT,".runtime/conda/envs/anygrasp/bin/python"):mujocoPython})
  // CAD/DXF 读取用的隔离解释器随 blender 插件配置显式传入：后台/隔离环境里开发 shell 的
  // LYAPUNOV_CAD_PYTHON 不保证存在，不显式传就会变成"工具在、依赖不在"。**未设置时不造值**：
  // 不给 cadPython 键，由 cad.ts 自己回落环境变量并报 CAD_PYTHON_UNCONFIGURED（不猜解释器）。
  const cadPython=process.env.LYAPUNOV_CAD_PYTHON?.trim()
  // 同一理由传相机拟合解释器（装 OpenCV 的隔离 venv）与 DWG 转换器（LibreDWG dwg2dxf）：
  // 未设置就不给这两个键，由 camera-fit.ts / drawing-input.ts 自己回落同名环境变量与 PATH，
  // 并在缺依赖时明确报未配置——不在这里替它们猜一个解释器或转换器。
  // 两个键的形状都是**字符串路径**（与 cadPython 一致）：插件 Config 自己包成
  // `{path}` 交给候选的 DwgConverterSetting，这里再包一层就会变成 `{path:{path}}`（实测工具报
  // `configured?.path?.trim is not a function`）。
  const cameraFitPython=process.env.LYAPUNOV_CAMERA_FIT_PYTHON?.trim()
  const dwgConverter=process.env.LYAPUNOV_DWG_CONVERTER?.trim()
  // Blender 可执行文件：显式 `BLENDER_EXECUTABLE` 优先；否则见 `resolveBlenderExecutable`——
  // 本机 `blender` 是 snap 启动器（退出码 46，DBus transient scope），只有"PATH 上第一个就是 snap 启动器、
  // 且载荷二进制在场"时才改用载荷；解析不出来时仍是 `blender`，由插件按真实报错明确失败（不静默换路径）。
  add("blender",{executable:resolveBlenderExecutable(),workspace:PRODUCT_ROOT,...cadPython?{cadPython}:{},...cameraFitPython?{cameraFitPython}:{},...dwgConverter?{dwgConverter}:{}})
  const blenderMcpCommand=process.env.LYAPUNOV_BLENDER_MCP_COMMAND?.trim()
  // Blender 连接目标必须由启动方显式指定（architecture 探测端口后写入 BLENDER_PORT）。
  // 只有命令没有端口时不注入 9876 默认值，避免 dev Host 连上其他实例的 Blender。
  const blenderMcpPort=process.env.BLENDER_PORT?.trim()
  if(blenderMcpCommand&&blenderMcpPort)plugins.push({id:"lyapunov-blender-mcp",name:"@deepseek-ai/dsh-mcp-client",config:{transport:"stdio",serverName:"blender",command:blenderMcpCommand,args:[],cwd:PRODUCT_ROOT,env:{BLENDER_HOST:process.env.BLENDER_HOST??"127.0.0.1",BLENDER_PORT:blenderMcpPort,DISABLE_TELEMETRY:"1"},toolCallTimeoutMs:180000,failOnStartupError:true}})
  // Unity：编辑器由用户持有，所以只有**显式**给出命令或 URL 才接入同一个上游 MCP 客户端；未配置时返回 undefined
  // ——不加载、不阻塞其他功能。解析与校验（含冲突与半配置）唯一归 `script/unity-mcp.ts`（unityMcp 已在上面解析，
  // 同一份配置同时决定"接哪条连接"与"要不要注册 unity_scene_* 三个工具"）。
  if(unityMcp)plugins.push(unityMcp)
  // 深度估计（ENV-44）：同样只在**显式配置**时接入——解释器与权重目录必须同时给出（半配置直接报错，
  // 不静默挑一个）；未配置=不加载、不阻塞其他功能。解释器/权重由使用方自备（本包不装全局依赖、
  // 不动既有 GPU 服务），device 省略即 cpu；推理进程内固定 HF 镜像 + 离线，只用本地权重。
  const depthPython=process.env.LYAPUNOV_DEPTH_ESTIMATION_PYTHON?.trim()
  const depthModel=process.env.LYAPUNOV_DEPTH_ESTIMATION_MODEL_DIR?.trim()
  if(depthPython&&depthModel){
    const depthDevice=process.env.LYAPUNOV_DEPTH_ESTIMATION_DEVICE?.trim()
    if(depthDevice&&depthDevice!=="cpu"&&depthDevice!=="cuda")throw new Error("LYAPUNOV_DEPTH_ESTIMATION_DEVICE 只能是 cpu 或 cuda，收到："+depthDevice)
    const depthData=process.env.LYAPUNOV_DEPTH_ESTIMATION_DATA_DIR?.trim()
    add("depth-estimation",{pythonPath:depthPython,modelDirectory:depthModel,...(depthData?{dataDirectory:depthData}:{}),...(depthDevice?{device:depthDevice}:{})})
  }else if(depthPython||depthModel)throw new Error("深度估计半配置：LYAPUNOV_DEPTH_ESTIMATION_PYTHON 与 LYAPUNOV_DEPTH_ESTIMATION_MODEL_DIR 必须同时给出（缺一不加载）")
  plugins.push({id:"lyapunov-architecture-skills",name:"@deepseek-ai/dsh-skill-filesystem",config:{providerName:"lyapunov-architecture",includeDefaultRoots:false,customSkillDirs:[join(PRODUCT_ROOT,"packages/blender/skills")]}})
  plugins.push({id:"lyapunov-domain-skills",name:"@deepseek-ai/dsh-skill-filesystem",config:{providerName:"lyapunov-domain",includeDefaultRoots:false,customSkillDirs:[join(PRODUCT_ROOT,"packages/lyapunov-shell/skills")]}})
  add("motion-mink",{python:mujocoPython})
  add("motion-ompl",{python:mujocoPython})
  add("asset-bake",{python:algorithmPython})
  // 生成/分割任务的来源数据属"可整删可重建"，归 cache 域；旧写法 join(sceneRoot,"provider-jobs")
  // 会在迁移后重新造出 <根>/scene/，把分治结果又拆散。（runtimeRoot/outsideRoot 见上方统一定义。）
  const outsideRoot=(name:string)=>runtimeRoot?join(runtimeRoot,name):join(input.sceneRoot,name)
  const providerData=join(d?.cacheRoot??input.sceneRoot,"provider-jobs")
  // image（百炼千问图像）与三家生成插件同一处装配：dataDirectory 给插件自己的记录/落图目录，
  // 允许付费提交与否仍由这里统一为 false（真提交要过原生授权问答才会放行）。
  if(input.mode!=="guest")for(const provider of ["marble","hunyuan","tripo","image"])add("generate-"+provider,{dataDirectory:join(providerData,provider),allowPaidSubmission:false})
  // FastGS 不再是随包算法插件：官方 fastgs/FastGS 改为包外可选工具，由 `./lyapunov fastgs`
  // 与设置里的「外部工具」按需下载/安装（见 packages/lyapunov-product-bundle/src/fastgs-external.ts）。
  add("segment-sam3",{pythonPath:join(PRODUCT_ROOT,".runtime/conda/envs/sam3/bin/python"),checkpointPath:resolveSam3Checkpoint(),dataDirectory:join(providerData,"sam3")})
  if(input.surface==="web")plugins.push(
    {id:"lyapunov-desktop-lifecycle",name:join(PRODUCT_ROOT,"packages/desktop/dist/plugin.js")},
    {id:"lyapunov-shell",name:"@lyapunov/shell",config:{recordingRoot,captureRoot,...(d?{catalogRoot:d.catalogRoot}:{}),...input.administrator?{administrator:input.administrator,modelBilling:input.modelBilling}:{}}},
    {id:"lyapunov-workspace",name:"@lyapunov/workspace",config:{dataDirectory:outsideRoot("review-comments")}},
    {id:"lyapunov-pty",name:"@deepseek-ai/dsh-terminal"},
    {id:"lyapunov-terminal",name:"@deepseek-ai/dsh-terminal-bash",config:{shellDialect:process.platform==="win32"?"pwsh":"bash"}},
    {id:"lyapunov-tool-terminal",name:join(UPSTREAM,"packages/terminal/tool-terminal/lib/index.js")},
    {id:"lyapunov-directory-browse",name:"@deepseek-ai/dsh-host-directory-picker-browse",config:{homeDirectory:publicChooserHome(input.sdkEnvironment??process.env)}},
    {id:"lyapunov-directory-browse-ui",name:"@deepseek-ai/dsh-client-ui-directory-picker-browse"},
  )
  // 原生 computer-use 会访问宿主桌面，只有显式 LYAPUNOV_COMPUTER_USE=1 才挂载；普通启动不取得桌面能力。
  if(input.surface==="web"&&process.env.LYAPUNOV_COMPUTER_USE==="1"&&process.platform==="linux"&&Boolean(process.env.DISPLAY||process.env.WAYLAND_DISPLAY))plugins.push(
    {id:"lyapunov-computer-use",name:join(UPSTREAM,"packages/computer-use/computer-use/lib/index.js")},
    {id:"lyapunov-computer-use-cua-native",name:join(UPSTREAM,"packages/experimental/computer-use-cua-driver-native/lib/index.js")},
  )
  // browser-use:launch 模式每个会话独立隔离 Chromium,不占用 9222/9223 等既有调试通道;有显示环境时可见窗口便于观察。
  if(input.surface==="web"&&process.env.LYAPUNOV_BROWSER_USE!=="0"&&process.platform==="linux"&&Boolean(process.env.DISPLAY||process.env.WAYLAND_DISPLAY))plugins.push(
    {id:"lyapunov-browser-use",name:join(UPSTREAM,"packages/browser-use/browser-use/lib/index.js")},
    {id:"lyapunov-browser-use-chrome-devtools-mcp",name:join(UPSTREAM,"packages/experimental/browser-use-chrome-devtools-mcp/lib/index.js"),config:{mode:"launch",headless:false}},
  )
  if(input.mode==="developer"){
    if(input.surface!=="web")plugins.push({id:"lyapunov-cordis-host-runner",name:"@deepseek-ai/dsh-cordis-host-runner"})
    plugins.push({id:"lyapunov-tool-cordis",name:"@deepseek-ai/dsh-tool-cordis"})
    plugins.push({id:"lyapunov-cordis-skills",name:"@deepseek-ai/dsh-skill-filesystem",config:{providerName:"lyapunov-cordis",includeDefaultRoots:false,customSkillDirs:[join(UPSTREAM,"packages/preset/agent-presets/presets/cordis/skills")]}})
  }
  return plugins
}

/* ---------------------------------------------------------------------------------------------------
 * 托管链接切换的播报与归属普查：实现**搬到了 `script/profile.ts`**（本文件以外还有两个调用点
 * ——`prepareProfile()` 的预切换槽位与 `github` 入口——它们都必须走同一份口径，且都不能为本文件
 * 拖进整条 `runtimePatch` 依赖图）。这里只做**再导出**，`script/*` 与既有用例的导入路径不变。
 *
 * 归因口径（2026-09-27，验收队 `VERIFY-RUNTIME-PATCH-LINKS-20260926.md` §4/§5）：本函数只播报
 * **它自己改的** `{updated,removed}`；**不归本函数**的那部分（上游 DSH 的 profile fallback linker
 * 维护的 `$DSH_HOME/profiles/node_modules` 依赖镜像）只报范围与当前归属，**不声称谁在什么时候改的**。
 * ------------------------------------------------------------------------------------------------- */
export {
  INSTALLATION_MIRROR_AUDIT,
  PRODUCT_LINK_SWITCH_AUDIT,
  censusModuleLinkScope,
  installRootOfLinkTarget,
  linkProductBundleSlot,
  migrateLegacyProfileAndReport,
  productLinkSwitchNotice,
  reconcileAndReportInstallationMirror,
  reconcileAndReportProductLinks,
} from "./profile.ts"
export type {
  InstallationMirrorReport,
  ModuleLinkScopeCensus,
  ProductLinkSwitchNotice,
  ProductLinkSwitchReport,
  ProductLinkSwitchScope,
} from "./profile.ts"

/** 每个 realm 只装配所选模拟与候选 Provider；其余依赖不启动。 */
export async function runtimePatch(input:RuntimePatchInput&{dir:string}){
  if(input.mode==="formal"&&(!input.accountApiUrl||!input.accountId))throw new Error("正式Profile缺少已验证账户的身份或API地址")
  if (process.env.LYAPUNOV_SESSION_UNDO !== '0') await ensurePluginModule('lyapunov-session-undo')
  if(input.engine==="benchmark"){
    const benchmarkProvider=(process.env.LYAPUNOV_BENCHMARK_PROVIDER??process.env.LYAUP_BENCHMARK_PROVIDER)?.trim().toLowerCase()||"libero"
    await ensurePluginModule(benchmarkProvider==="gymnasium"?"benchmark-gymnasium":"benchmark-libero")
  }
  const plugins=runtimePluginInsert(input)
  let patch="- insert: "+JSON.stringify(plugins)+"\n"
  // 模型仍由登录/开发者后台装配；原生 Models 设置页沿用上游启用状态，Agent 预设选择保持关闭。
  patch+="- id: ui-agent-preset\n  disabled: true\n"
  // 去掉原生base的固定付费搜索默认值；客户端fetch保留，显式自有provider仍按Native规则选择。
  if(input.mode!=="developer")patch+="- id: web-search-deepseek\n  disabled: true\n- id: web\n  config:\n    searchProvider: !!js undefined\n    fetchProvider: http\n"
  if(input.mode==="guest"){
    for(const row of guestModelRows(join(input.dir,"..",".."),guestProductServiceUrls()))patch+="- "+JSON.stringify(row)+"\n"
  }
  if(input.mode==="formal"||input.mode==="local"){
    if(!input.accountApiUrl)throw new Error("正式Profile缺少已验证账户的API地址")
    for(const row of formalModelRows({apiUrl:input.accountApiUrl}))patch+="- "+JSON.stringify(row)+"\n"
  }
  if(input.surface==="web")patch+="- id: directory-picker\n  disabled: true\n- id: workspace-controller\n  config:\n    autoInitializeDefault: false\n"
  // 正式/离线产品/guest 共用一处短角色与界面事实；权限、cwd、WebRuntime 与 HMR 仍由原生 owner 提供。
  if(input.mode!=="developer"){
    patch+="- id: system-prompt\n  config:\n    includeHarnessIdentity: false\n    includeRuntimeContext: true\n    personaPrefix: ''\n    personaSuffix: Your working directory is {{cwd}}.\n"
    if(input.surface==="web")patch+="- id: web-runtime\n  config:\n    openBrowser: !!js ctx.webStartup.openBrowser\n    printUrl: true\n    surfaceContext: true\n    surfacePresentation: product\n    trustedHosts: !!js ctx.webStartup.trustedHosts\n"
  }
  // ACP 面必须用**本部署声明的模型路由**，不能用上游 acp-app bundle 里硬编码的那一对。
  // 上游 `packages/bundle/acp-app/cordis.patch.yml` 写死 `provider: deepseek-official / model: deepseek-v4-flash`，
  // 而 `deepseek-v4-flash` 在目录里**不含 image 模态**，于是 `supportsAcpImagePrompts()`
  // （packages/acp/acp/src/content.ts:89，读 `llm.resolveModelInfo(provider, model)` 的 inputModalities）
  // 必然返回 false，`initialize` 就永远声明 `promptCapabilities.image=false`——
  // 实证：即使会话里用 ACP 原生配置项把模型改成视觉模型，图像仍被拒
  // （`inline image prompts were not advertised by this connection`），因为该标志在 initialize 时一次性定死。
  // 这是**路由装配不一致**，不是模型能力问题：同一部署的 agent-default-model 已是视觉模型。
  if(input.surface==="acp"){
    const agent=developerAgentDefaultModel()
    patch+=`- id: acp
  config:
    provider: ${JSON.stringify(agent.provider)}
    model: ${JSON.stringify(agent.model)}
`
  }
  if(input.mode==="developer"){
    const agent=developerAgentDefaultModel()
    patch+=`- id: agent-default-model
  config:
    provider: ${JSON.stringify(agent.provider)}
    model: ${JSON.stringify(agent.model)}
    reasoningEffort: ${JSON.stringify(agent.reasoningEffort)}
- id: llm-deepseek
  config:
    thinking: enabled
    reasoningEffort: max
    models: ${JSON.stringify(developerDefaultCatalog())}
`
  }
  const path=join(input.dir,"lyapunov-runtime.patch.yml");await writeFile(path,patch)
  // 这个调用点是全树唯一一处托管链接切换：返回值**必须被消费**（见 `reconcileAndReportProductLinks`）。
  // 以前这里写成裸 `await reconcileProductPackageLinks({…})`，`{updated,removed}` 被丢掉 ⇒
  // 旧安装对同一运行根启动时静默改指 317 条链接仍 exit 0。归属判定与切换动作**一个字没改**。
  await reconcileAndReportProductLinks({profileDirectory:input.dir,productRoot:PRODUCT_ROOT,installAnchor:join(UPSTREAM,"apps/cli/package.json"),overlayPaths:[path]})
  return path
}
