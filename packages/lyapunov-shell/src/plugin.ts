import {validateRegisteredControlDisplay,projectControlActionRows} from "./control-gesture.ts"
import {worldFrameSelection} from "./collision-frame-request.ts"
import {CameraUIReadCache} from "./camera-ui-query.ts"
import {cameraDraftFromSample,cameraSampleBodies,type CameraAuthoringSnapshot} from './camera-authoring.ts'
import {cameraInstallationCommit,restoredCameraDraft,type CameraSceneSaveInput} from './camera-installation.ts'
import {cameraDraftFromInstallation} from './camera-installation-input.ts'
import {annotationAnchorOf} from '../../viewer/src/annotations.ts'
import {cameraMountBodies,type SceneCameraDraft} from './workbench-camera.ts'
import {nativeCameraPreset,registeredCameraPresets} from '../../robot-tools/src/presets.ts'
import {isCameraNavigationAction} from './camera-navigation-actions.ts'
import type { Context } from "@deepseek-ai/cordis"
import type {} from "@deepseek-ai/dsh-client-connection"
import type {} from "@deepseek-ai/dsh-commands"
import type {} from "@deepseek-ai/dsh-jobs"
import type {} from "@deepseek-ai/dsh-subprocess"
import type {ImageAttachmentRef} from "@deepseek-ai/dsh-attachment"
import type {} from "@deepseek-ai/dsh-api-session-controller"
import type {} from "@deepseek-ai/dsh-system-prompt"
import type {} from "@deepseek-ai/dsh-session-projection"
import type {} from "@deepseek-ai/dsh-session-query"
import type {} from "@deepseek-ai/dsh-tool-todo"
import {scopeOf,type ScopeKey} from "@deepseek-ai/dsh-scope"
import {requireWritableScene,type SceneService} from "../../scene-kit/src/plugin.ts"
import type {SceneOperations} from "../../scene-kit/src/operations.ts"
import type {SimService,SimWorlds} from "../../sim-contract/src/index.ts"
// 会话身份与命名空间的唯一规则（与 scene-kit / sim-contract / robot-tools 共用这一份，不在各处各拼一遍前缀）。
import {bindSessionId,requireSessionId,sessionNamespace,SESSION_SCOPE_UNAVAILABLE} from "../../lyapunov-contracts/src/session-scope.ts"
import { SessionId,type Session } from "@deepseek-ai/dsh-session"
import type { TodoItem } from "@deepseek-ai/dsh-tool-todo"
import { planDomainPointers, type SkillCatalogFact } from "./environment-routing.ts"
// W22：computer-use 合成输入的作用域/全局快捷键拒绝清单/桌面设置快照恢复（唯一实现；本文件只做消费点）。
import { COMPUTER_USE_INPUT_ERRORS, CUA_GLOBAL_STATE_TOOL_NAMES, CUA_INPUT_TOOL_NAMES, CUA_PRIVACY_READ_TOOL_NAMES, closeComputerUseSession, computerUseSurfaceRefusal, cuaDriverToolPassThrough, guardComputerUseInput, openComputerUseSession, type CommandRunner, type ComputerUseSession } from "./computer-use-input.ts"
// 会话历史投影（routingHistory/latestUserText）：原在 jev-context-routing.ts，Jev 退役后独立成模块，
// 因为引擎安装授权与规则路由都用它取真实输入，与"用不用 LLM 路由"无关。
import { routingHistory, latestUserText, isUserIntent } from "./conversation-history.ts"
// 产品文案的唯一 owner：命名段落常量（不再按行号取段，改一句不会静默取错）。
import { productContextText } from "./product-context.ts"
import { formalModelMessageProjection, needsFormalSystemReset } from "./product-input-projection.ts"
import { renderBriefSceneSpec, briefSceneSpec, type EnvironmentStage, type EnvironmentInputSource } from "./environment-routing.ts"
import {ENGINE_CHOICES,ENGINE_PREFERENCE_CHOICES,AUTO_ENGINE,isEnginePreferenceValue,readEnginePreference,writeEnginePreference,sdkRuntimeFacts,readEngineLicenses,recordEngineLicense,resolveEngine} from "../../../script/engine-preference.ts"
import {resolveSdkPython} from "../../lyapunov-product-bundle/src/sdk-python.mjs"
import {resolvePolicyPython,checkPolicyCpu,POLICY_CPU_WHEEL} from "../../lyapunov-product-bundle/src/policy-runtime.mjs"
import {clearSdkImportCache,gpuRuntimeDecision,probeGpuFacts} from "./environment-readiness.ts"
import {registerIsaacLocalRoutes} from "./isaac-local-discovery.ts"
import type {EngineProviderStatus} from "./engine-provider-contract.ts"
import { createProviderInstaller, ISAAC_EULA_URL } from "./provider-installer.ts"
// FastGS 官方外部可选工具的桥接（来源元数据 + 下载/安装/检查/训练转发；唯一实现在 product-bundle，
// 与 CLI `./lyapunov fastgs` 共用，本文件只做宿主路由/工具接线，不复制第二份）。
import { FASTGS_COMMIT, FASTGS_REPOSITORY, fastgsDownload, fastgsInstall, fastgsStatus, type FastGSReceipt, type FastGSStatus } from "../../lyapunov-product-bundle/src/fastgs-external.ts"
import { EngineInstallAuthorization } from "./engine-install-routing.ts"
import { execFileSync } from "node:child_process"
import { createUserMessage } from "@deepseek-ai/dsh-llm"
import type { ContentBlock } from "@deepseek-ai/dsh-llm"
import { defineTool } from "@deepseek-ai/dsh-tools"
import type { SessionStore } from "@deepseek-ai/dsh-session"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { stat,readFile,writeFile,mkdir,readdir,unlink } from "node:fs/promises"
import { join,resolve,dirname } from "node:path"
import { fileURLToPath,pathToFileURL } from "node:url"
import type { Frame,ResourceRef,SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"
import { parseAsset,localPath } from "../../scene-kit/src/formats.ts"
// DEV-PROJ-02：机器人文档资产引用 → 已授权件的媒体标记（唯一实现，见该模块头部）。
import { authorizedAssetIndex,sceneRobotDocumentAssetLocators } from "../../scene-kit/src/robot-visual-assets.ts"
import { viewpointCoverageOf, type PhotoViewpoint } from "../../scene-kit/src/reference-tools.ts"
import { assertPublicHttpsURL, defaultHostResolver, fetchPublicHttpsBytes } from "../../scene-kit/src/network-assets.ts"
import { createHash } from "node:crypto"
import { readRecording, readRecordingResource, listRecordings, recordingSummary } from "../../robot-workflows/src/recording-files.ts"
import { previewScaleOf, previewPixelMappingText, localCorrectionRecordOf, type CaptureRecord, type LocalCorrectionRecord } from "./workbench-api.ts"
import { captureFeedbackContent, capturePins, requireCaptureFeedbackOwner, type FeedbackCapture } from "./capture-content.ts"
import { currentDshHome, discoverSessions, precheckSession, restoreSession } from "./session-history.ts"
import { OrientationChecks, importedVisualTarget, orientationPrompt, type OrientationTarget, type OrientationObservation } from "./orientation-check.ts"
// 环境光照窄面的整形与措辞（唯一 owner，与 Viewer 的 `environmentCaptureFace()` 同字段）：
// 采集记录与观察回执共用同一份，不在这里另写一套环境语义。
import { environmentFaceFrom, environmentFaceNote } from "./environment-capture.ts"
// LOD 窄面的整形与措辞（同一套纪律：唯一 owner 是 Viewer 的 `lodCaptureFace()`）。
// 按相机距离用上简化件是**正常行为**——不是故障；只有"比这台相机该用的级别更粗 / 该读的没读进来"才是降级，
// 所以两种事实在措辞里分开写（见 lod-capture.ts），数据集则两者都要知道。
// `lodFaceIssue` 管的是另一件事：载荷带了这一面但读不出来时必须说清原因，不能装成"没有 LOD 读数"。
import { lodFaceFrom, lodFaceIssue, lodFaceIssueNote, lodFaceNote } from "./lod-capture.ts"
// 相机数学**只有一份**：纯函数在 `packages/viewer/src/camera-view.ts`（无 three 依赖，前端/宿主/测试共用）。
// 宿主用它做"排队前预检"与"落盘前的内参↔投影矩阵比对"，不自己再写一套投影数学。
import { assertRenderSize, normalizeCameraRequest, normalizeIntrinsics, projectionMatrixFromIntrinsics, scaleIntrinsics, type ViewerCameraIntrinsics, type ViewerCameraRequest } from "../../viewer/src/camera-view.ts"
import type {VerifiedAdministrator} from '../../lyapunov-product-bundle/src/account/administrator.ts'
import {applyPreferencesHost} from './preferences-host.ts'
import {applyExternalToolsHost} from './external-tools-host.ts'
import {applyProductFontsHost} from './product-fonts.ts'
import {applyExecutionGraph,type GraphConfig} from './execution-graph-host.ts'
// DEV-PRIV-01 发行隐私数据边界：产品侧唯一判据（纯函数）。三个消费者各留各的字段，
// **没有 `{public,result}` 兜底**——出站面从这里裁，浏览器载荷里根本没有内部原文。
import {commandRouteResponse,diagnosticsPayload,displayPath,publicCommandError,redactSecretsText,scrubAbsolutePaths,stripStack,uiCommandFields} from "../../lyapunov-contracts/src/command-privacy.ts"
// `ui_action` 的 openResource 契约（前端产出确认、宿主核对确认共用的纯判据）。
import {openExpectationFor,openReceiptVerdict,openWaiterOwnership,uiActionModelText,type OpenExpectation} from "./ui-action-open.ts"
// 规范资源地址与前端同一个 `fileAddressFor`：宿主按"发起会话 cwd + 请求 path"独立算出期望地址。
import {fileAddressFor} from "@deepseek-ai/dsh-util-workspace-path"
import {matchResourceToken,projectPathsOnly,productRelativePath,RESOURCE_TOKEN_PREFIX,resolveProductPaths,type ProductPathRoots} from "../../lyapunov-contracts/src/product-paths.ts"
import {createSessionOutboundProjection} from "../../lyapunov-contracts/src/session-event-projection.ts"
import {applyWebFetchFailureAdapter} from './web-fetch-failure.ts'

declare module "@deepseek-ai/dsh-session/types" { interface SessionEventMap { "lyapunov/last-scene": {sceneId:string} } }
declare module "@deepseek-ai/dsh-jobs" { interface JobKindMap { fastgs_external: "fastgs-external" } }

export const name="lyapunov-shell"
export const inject=["connection","commands","agents","scene","sessions","attachments","systemPrompt","sessionController","sessionQuery","tools","jobs","subprocess"]
export interface Config { captureRoot?:string; recordingRoot?:string; /** 目录索引根（<运行根>/catalog）：资源字节校验读它的 index.json。省略时退回 dataRoot/旧单根。 */ catalogRoot?:string; /** @deprecated 分治前的单根；仅旧布局兼容。 */ dataRoot?:string;administrator?:VerifiedAdministrator['admin'];modelBilling?:'own-key'; /**
 * W22：computer-use 的桌面设置后端（`gsettings`/`notify-send` 命令执行器）。省略＝真执行器。
 * 存在的唯一理由是**测试替身**：测试不能真的去读/写用户桌面的 a11y 设置、更不能真的弹通知。
 */ computerUse?:{runner?:CommandRunner}; /** 原生恢复预算与只读图裁剪，不改变领域执行者。 */ graph?:GraphConfig }

/** 固定 Host 的已认证窄通道。读世界不创建新的 world writer；人工动作走 DSH Commands。 */
/**
 * 交给浏览器的场景副本：**先给机器人文档资产发已授权件的媒体标记，再走路径投影**（`state` / `scene`
 * 两条路由共用这一份，形状只有一处）。
 *
 * 为什么必须在投影**之前**做：`projectPathsOnly` 只认识字符串形状（`uri`/`file:` → 标记、登记域内绝对路径 →
 * 域引用），看不见"这条引用是相对哪份文档写的"。而机器人视觉的资产引用是**文档内引用**
 * （`viewer/src/robot.ts` 用 `composeAssetReference(meshdir,file)` + `new URL(ref,baseUri)` 定位）：
 * `baseUri` 一旦成标记，**相对引用**在浏览器里没有基址可解（`ROBOT_VISUAL_REFERENCE_UNRESOLVED`）、
 * **域内绝对路径**会被投影成域引用（`<域>/<相对>`）——而媒体路由按"标记／绝对件"等值匹配，两者都换不回字节。
 * 这里用服务端知道的两件事实（文档所在目录 + `meshdir`/`texturedir`）把引用落到**绝对件**上，
 * 再问"这件在不在已授权候选集里"：在，就写它的标记（标记即媒体路由的准入货币）；不在，原样留着，
 * 由既有缺件通道如实上报。
 *
 * **不放宽授权**：候选集只由该实体**自己已登记的资源**与**该文档的依赖闭包**（`parseAsset`，
 * 与 `resource` 路由同一把缓存键、同一份闭包）构成；真正的闸门仍是路由的等值匹配。
 * 导出是为了让"这一层真的被两条路由用上"能被测到（`test/scene-robot-asset-locators.test.ts`）。
 */
export async function projectSceneForBrowser(scene:SceneSnapshot,sessionKey:string,roots:ProductPathRoots,dependencyCache:Map<string,Set<string>>):Promise<unknown>{
 const candidates:string[]=[]
 for(const entity of scene.entities)for(const ref of entity.resources??[])for(const representation of [ref.original,...(ref.representations??[])])if(typeof representation?.uri==="string")candidates.push(representation.uri)
 for(const entity of scene.entities){
  const native=(entity.components?.mujoco as any)?.sourcePath
  if(typeof native!=="string"||!native)continue
  candidates.push(native)
  const key=`${sessionKey}|${scene.sceneId}:${scene.revision}:${native}`
  let dependencies=dependencyCache.get(key)
  if(!dependencies){try{const parsed=await parseAsset(localPath(native));dependencies=new Set(parsed.dependencies.flatMap(item=>[item.path,pathToFileURL(item.path).href]));dependencyCache.set(key,dependencies)}catch{continue}}
  candidates.push(...dependencies)
 }
 return projectPathsOnly(sceneRobotDocumentAssetLocators(scene,authorizedAssetIndex(candidates)).scene,roots)
}
export async function apply(ctx:Context,config:Config={}){
 applyWebFetchFailureAdapter(ctx)
 // 当前短建议由本插件规则与原生 Skill 目录提供；没有 OM 分类模型或第二任务控制器。
 // 可信 profile 的**唯一**来源是 Host 进程环境（`script/profile.ts` 的 backendEnvironment 写入），
 // 由产品装配／发行态决定权限；query/localStorage 一律不参与判定，拿不到可信值即 fail-closed 按正式渲染。
 const privacyMode=process.env.LYAPUNOV_MODE==="developer"?"developer":"formal"
 if(privacyMode==="formal")ctx.effect(()=>ctx.provide("modelMessageProjection",formalModelMessageProjection),"lyapunov-shell: formal model input projection")
 // 产品路径域：出站把登记域内的绝对路径改写成 `<域>/<相对>` 引用，入站在派发前解析回来。
 // 用户文件相对路径照旧交给 scene-kit 的 `sessionPath`（按任务工作区解析），这里不碰它。
 const productPathRoots:ProductPathRoots={
  ...config.captureRoot?{captures:resolve(config.captureRoot)}:{},
  ...config.recordingRoot?{recordings:resolve(config.recordingRoot)}:{},
  ...config.catalogRoot?{catalog:resolve(config.catalogRoot)}:{},
  ...config.dataRoot?{data:resolve(config.dataRoot)}:{},
  ...(process.env.LYAPUNOV_SCENE_ROOT?{data:resolve(process.env.LYAPUNOV_SCENE_ROOT)}:{}),
  // 运行根（DSH_HOME 的父目录）兜住 cache/recordings/plugins 等子域盖不到的落盘路径；
  // 更具体的域（captures/recordings/…）按最长匹配优先，用户 home 下的文件照旧不下发绝对路径。
  ...(process.env.DSH_HOME?{runtime:dirname(resolve(process.env.DSH_HOME))}:{}),
 }
 await applyPreferencesHost(ctx)
 applyExternalToolsHost(ctx)
 applyProductFontsHost(ctx)
 // 会话事件的**浏览器出站**投影（上游补丁 dsh-session-outbound-projection 的钩子）：
 // 服务端模型真值与 session 持久化一字不改，只有 page/follow 发往浏览器的那一份按消费者裁剪。
 ctx.effect(()=>ctx.provide("sessionOutboundProjection",createSessionOutboundProjection(privacyMode,productPathRoots)),"lyapunov-shell: session outbound projection")
 ctx.systemPrompt.section({name:"lyapunov-product-agent",order:8200,text:productContextText})
 // 下列规则表即当前唯一的上下文注入来源（原为 Jev 的显式 rules 回退，现为默认且唯一）。
 // 域指针只提供当前意图的能力建议；正文未变不追加，意图换出时明确清除。
 // 原生 Session surface 替换同 owner 快照，完整原始事件仍保留；不锁后续技能选择。
 //
 // **判定不在这里**：环境任务（照片复现/CAD 重建/文字创作/已有场景修改/混合输入）的
 // 阶段与输入来源由 `environment-routing.ts` 的纯函数判定——它综合**本步消息 + 附件
 // （照片/图纸的真实内容块）+ 必要的会话上下文（原生 todo 投影 = 会话任务）+ 工作台
 // 选择 + 工具可见性**，产出阶段技能（如 environment-planning）与输入源技能，再与本表
 // 的关键词命中合并（去重、总共不超过 MAX_POINTERS 行）。所以"提示哪个技能"不再等于
 // "关键词命中了前两条"：停止/只方案/继续/局部/新建互不混淆，输入源也不会被截掉。
 //
 // 本表仍是**关键词补充**的唯一来源（门禁 `script/gates/domain-pointers.ts` 从源码解析），
 // 顺序即优先级：命中数超过剩余额度时靠前的条目活下来。因此"输入源"类指针
 // (cad-import / architectural-world)必须排在"泛 3D 构造"类
 // (scene-construction / asset-generation)之前——否则"按这张施工图建个场景"会命中
 // 场景+生成+cad 三条，cad-import 被截掉，模型可能在没读图纸的情况下直接编一个场景。
 // 这是**用顺序表达优先级**，不是新增路由层：仍然只注入提示、不锁后续。
 const domainPointers:Array<{skill:string;label:string;pattern:RegExp;tool?:boolean}>=[
  {skill:"ui_action",label:"Interface controls",pattern:/面板|切换|聚焦|选中|场景中心|视角|居中|打开.*(面板|文件|终端|画布)|打开.*panel|switch to|focus on|select.*(robot|entity|object)/i,tool:true},
  // CAD/图纸是**输入源**：命中即应读图，而不是先建场景。图片→CAD 的"转换"语义
  // （图转CAD/线稿转DXF）也归这里——"图"单字太泛，故只在"图…转/变…cad|dxf"这类
  // 转换短语上命中。`floorplan` 是 `floor`+`plan` 的合写，**就是**图纸写法，必须命中；
  // 2026-09-18 曾为躲开裸 `floor` 的假阳性写成 `floor[\s-]plan`，把 `floorplan` 一起漏掉，
  // 2026-09-20 主代理核对时纠回：漏掉的是 `floorplan` 本身，错的不是"floorplan 是图纸"这个判断。
  {skill:"cad-import",label:"CAD input",pattern:/cad|图纸|施工图|平面图|户型图|立面图|剖面图|总平|dxf|dwg|蓝图|读图|图.*(转|变|生成).{0,6}(cad|dxf|dwg|矢量)|(cad|dxf|dwg).*(转|变|成).{0,4}图|blueprint|floor[\s-]?plan|technical drawing|construction drawing/i},
  // Blender 是**建模执行面**（可编辑建筑 + MCP 交互式迭代 + 导出进 Scene/引擎）。
  // 只在真的谈到 Blender 或"可编辑建筑"时命中，不与 scene-construction 抢泛场景请求。
  // 技能内部已写明"优先用已连接的 Blender MCP、未连接时用 blender_run"，指针不必判断 MCP 是否挂载。
  {skill:"architectural-world",label:"Blender architectural modeling",pattern:/blender|blend\s*文件|mcp.*(blender|建模)|(blender|建模).*mcp|可编辑.*(建筑|模型|工程)|建筑.*(可编辑|漫游|建模)|architectural world/i},
  {skill:"action-execution",label:"Action execution",pattern:/抓|举起|拿起|放置|搬|开过去|走两步|走去|走到|货叉|升降|起飞|降落|步态|执行.*(策略|动作)|协同|规划|避障|停止.*(动作|模拟)|pick|grasp|lift|place|move\s|drive|walk|execute|policy|avoid|stop|fleet|gait|takeoff/i},
  {skill:"scene-construction",label:"Scene construction",pattern:/场景|房间|庭院|世界|环境|下载.*(环境|地图)|放个|加.*(桌子|椅子|墙|地板)|scene|room|courtyard|environment|world|build a|place a|furniture|table/i},
  // 生成入口统一由本指针路由：命中即注入 asset-generation 技能指针，由技能内部按形态选路
  // （规则/参数化几何→Blender、语义/真实外观或显式生成式→Peiri 3D、现成→下载/素材库）。
  // 界面上的"来源选择 + prompt 输入"已下线（2026-09-17，过期且与路由重复），用户不再选供应商。
  {skill:"asset-generation",label:"Asset generation",pattern:/生成|建模|做个|做一个|建个|建一个|Peiri\s*3d|文生\s*3d|图生\s*3d|物理化|烘焙|下载.*(资产|模型)|建.*模型|做个.*(箱|架|模型|工具)|generate|create.*(model|asset|3d)|make a|physicalize|bake|import.*(asset|model)/i},
  {skill:"robot-provisioning",label:"Robot preparation",pattern:/机械臂|机器人|urdf|叉车|无人机|灵巧手|机器狗|人形|策略包|robot|arm|forklift|agv|drone|quadruped|humanoid|dexterous|policy package/i},
  {skill:"benchmark-evaluation",label:"Evaluation environments",pattern:/libero|gymnasium|基准|评估.*(策略|模型)|跑分|benchmark|suite|evaluat/i},
  {skill:"desktop-automation",label:"Desktop and browser",pattern:/桌面|窗口|点击|剪贴板|应用.*(打开|操作)|浏览器|网页|desktop|window|click|clipboard|browser|web\s?page|browse/i},
 ]
 // 会话任务上下文：原生 todo 投影（`todo_write` 的整表快照）就是"这个会话现在在做什么"的
 // 唯一真值，不另建计划库。投影未注册（服务不可读）时返回 undefined，由路由如实登记，
 // 不假装"没有任务"。
 const sessionTodos=(agent:unknown):readonly TodoItem[]|null|undefined=>{
  const registry=ctx.get("sessionProjections")
  const session=(agent as {session?:Session}|undefined)?.session
  if(!registry||!session)return undefined
  return registry.stateOf(session,"todos")
 }
 // 原生技能目录：只用来核对"提示里点名的技能现在是否真的可用"（不建第二套技能注册表）。
 // 目录不可读或不完整时返回 undefined，由路由只认随包装配的技能名。
 const skillCatalog=async(agent:unknown,signal?:AbortSignal):Promise<(SkillCatalogFact & {descriptions:Record<string,string>})|undefined>=>{
  const registry=ctx.get("skills") as {snapshot?:(options?:unknown)=>Promise<{skills:readonly {name:string;description?:string;whenToUse?:string;invocation?:{modelInvocable:boolean}}[];complete:boolean}>}|undefined
  if(!registry?.snapshot)return undefined
  try{
   const snapshot=await registry.snapshot({scope:agent as unknown as ScopeKey,signal})
   const visible=snapshot.skills.filter(skill=>skill.invocation?.modelInvocable!==false)
   return {names:visible.map(skill=>skill.name),complete:snapshot.complete,descriptions:Object.fromEntries(visible.map(skill=>[skill.name,[skill.description??skill.name,skill.whenToUse].filter(Boolean).join("; ")]))}
  }catch{return undefined}
 }
 /** ENV-58/53/54：最近一次环境路由判定的**只读投影**（给工作台页面看；不新增可变状态通路）。 */
 const routeDecisions=new Map<string,{at:string;stage:string;source:string;word:string|null;evidence:readonly string[];injected:readonly string[];why:readonly string[]}>()
 const domainPointerText=(agent:unknown):string|undefined=>{
  const session=(agent as {session?:Session}|undefined)?.session
  if(typeof session?.deriveMessages!=="function")return undefined
  const message=session.deriveMessages().findLast(message=>(message.source as {kind?:string}).kind==="lyapunov-domain-pointer")
  return message?.content.flatMap(block=>block.type==="text"?[block.text]:[]).join("\n")
 }
 const engineInstallAuthorization=new EngineInstallAuthorization()
 const activeTurnSignals=new WeakMap<object,AbortSignal>()
 const orientationTakesOver=(message:Parameters<typeof isUserIntent>[0]):boolean=>{
  const kind=(message.source as {kind?:string}|undefined)?.kind
  // 已知内部插件/工具上下文可留在自动任务内；未知来源按用户输入保守处理。
  return !kind||isUserIntent(message)||!kind.startsWith("plugin:")&&!["plugin","tool","model","lyapunov-domain-pointer","lyapunov-orientation","lyapunov-blender","lyapunov-depth-estimation","lyapunov-generate-image","lyapunov-engine-install","lyapunov-recovery","runtime-context","compact-checkpoint"].includes(kind)
 }
 ctx.on("agent/pre-step",async({messages,agent,signal,turn,step},next)=>{
  activeTurnSignals.set(agent,signal)
  orientationChecks.preStep(sessionKeyOf(agent),turn,step,messages.map(message=>({id:message.id,takesOver:orientationTakesOver(message)})),signal)
  const decision=await next()
  if(decision.kind==="reject")return decision
  const engineHistory=privacyMode==="developer"&&agent.session && (agent.session as unknown as {surface?:{nodes?:unknown}}).surface?.nodes!==undefined?routingHistory(agent.session):[]
  // 开发安装工具仍有两步授权与一次 consume；正式安装只由设置面板显式动作发起。
  const engineNotice=privacyMode==="developer"?engineInstallAuthorization.observe(sessionKeyOf(agent),latestUserText({messages:decision.messages,history:engineHistory}),turn):""
  // 判定全在 environment-routing.ts（纯函数，可用真实消息/附件/todo 单独验证）；
  // 这里只喂真实输入：本步用户消息、原生会话任务、当前选择、工具可见性、技能目录。
  // 技能目录照旧读：关键词表的"技能是否真存在"由目录核对（目录不可读时退回随包清单），
  // 建议不授予权限或固定模型角色，真实上下文仍归原生 Session。
  const plan=planDomainPointers({pointers:domainPointers,messages,todos:sessionTodos(agent),selection:selectionIdentity(agent),hasTool:name=>Boolean(ctx.tools.get(name,agent as unknown as ScopeKey)),visibleMcpTools:ctx.tools.schemas(agent as unknown as ScopeKey).map(tool=>({name:tool.name,description:tool.description})).filter(tool=>tool.name.startsWith('mcp__')),skillCatalog:await skillCatalog(agent,signal)})
  const previous=domainPointerText(agent)
  const cleared="Current capability guidance: none. The previous domain pointers are no longer current; choose the next step from this user goal and the visible tools."
  // 工具结果/Job通知不代表用户换了意图；只有新用户输入才清除上一任务的建议。
  const pointerText=plan?.text??(messages.some(isUserIntent)&&previous!==undefined?cleared:undefined)
  const additions=[]
  if(pointerText!==undefined&&pointerText!==previous)additions.push(createUserMessage({content:[{type:"text",text:pointerText}],source:{kind:"lyapunov-domain-pointer",form:"snapshot"} as never}))
  if(plan)routeDecisions.set(sessionKeyOf(agent),{at:new Date().toISOString(),stage:plan.decision.stage,source:plan.decision.inputSource,word:plan.decision.intent.word??null,evidence:plan.decision.evidence,injected:plan.injected,why:plan.decision.hints.map(hint=>hint.why)})
  // 仅开发安装路径的合成 notice；正式模式保留用户原始授权而不产生自动提醒。
  if(engineNotice)additions.push(createUserMessage({content:[{type:"text",text:engineNotice}],source:{kind:"lyapunov-engine-install",form:"notice",summary:"引擎安装授权状态"}}))
  const legacySystem=privacyMode==="formal"&&typeof agent.session?.deriveMessages==="function"&&needsFormalSystemReset(agent.session.deriveMessages())
  return additions.length||legacySystem?{...decision,messages:[...decision.messages,...additions],...legacySystem?{startsRequestSeries:true as const}:{}}:decision
 })
 // DEV-006：computer-use 的输入类工具驱动的是**同一块物理桌面上唯一的指针/活动窗口**，而上游没有跨会话互斥
 // （`computer-use-cua-driver-native/lib/index.js:102-114` 的 `pending` 只为卸载等待，不是队列）。
 // 这里复用既有的 `tools/execute` 漏斗做**宿主级串行**：只串行化 cua 输入类工具，其余工具原样放行。
 // ⚠️ W22-R3（全表审计）之后"其余工具"有了**唯一 owner**：`cuaDriverToolPassThrough` 按那张 59 个工具的
 // 全表（`CUA_DRIVER_TOOL_CATALOG`）判"能不能原样交回驱动"，**不在册的名字不放行**。下面三个集合仍是
 // 三张**拦截表**（input / 全局状态 / 隐私通道），它们的成员一个都没少、只是各自多了审计出来的成员。
 const cuaInputTools=new Set(CUA_INPUT_TOOL_NAMES.map(tool=>`cua_driver_native__${tool}`))
 // W22-R：`clipboard_write` **不是**合成输入（不产生键鼠事件、契约里也没有 target/scope），
 // 但它改的是**用户的系统剪贴板**——一条跨应用、且本模块的 gsettings 快照抓不到也恢复不了的全局状态。
 // 它与输入类一样进这条漏斗，由 `planComputerUseInput` 的 `clipboard-not-restorable` 分支**无条件拒**
 // （下面的第一判就会拒，所以既不开会话、也不动桌面、更不会走到驱动）。
 // 清单仍从模块取（唯一 owner），不在这里重抄——重抄正是它会变旧的根因。
 // W22-R3 起这张表还有 11 个同类成员（`replay_trajectory` / `kill_app` / `launch_app` / `page` …），
 // 逐条的"没有可恢复路径"依据在模块里（表上方注释 + `CUA_DRIVER_TOOL_REFUSALS`）。
 const cuaGlobalStateTools=new Set(CUA_GLOBAL_STATE_TOOL_NAMES.map(tool=>`cua_driver_native__${tool}`))
 // W22-R2：`clipboard_read` 是**隐私通道**（读用户剪贴板进 agent 上下文），与上面两张表都不同类，
 // 但它**必须进同一条漏斗**：`guardComputerUseInput` 对它的结论（`clipboard-read-not-disclosable`）
 // 只有在漏斗**拦得住这个名字**时才生效。改前这个名字不在任何一张表里 ⇒ 这里 `return next()` ⇒
 // 工具体照跑、用户剪贴板的内容原样回到模型上下文（守卫那条 `TOOL_UNKNOWN` 结论在产品路径上不可达）。
 // 清单仍从模块取（唯一 owner），不在这里重抄。
 const cuaPrivacyReadTools=new Set(CUA_PRIVACY_READ_TOOL_NAMES.map(tool=>`cua_driver_native__${tool}`))
 let cuaInputTail:Promise<unknown>=Promise.resolve()
 /** 还在排队等自己那一轮的输入动作数（只用于日志里的占用事实，不参与调度判定）。 */
 let cuaInputQueued=0
 /**
  * W22：computer-use 会话与状态（快照/可见指示/同意/拒绝记录）。
  *
  * 用户投诉的原始问题：「你每次都会打开辅助屏幕阅览器…你打算让其他客户端的用户也听你的声音吗?」
  * 本块是**消费点**：拒绝清单、作用域判定、快照与恢复的唯一实现都在 `computer-use-input.ts`，
  * 这里只做三件事——被拒的**一个字节都不发**、允许的先快照再发、会话结束**无条件恢复**（含异常路径）。
  */
 let cuaConsent={consent:false,reason:null as string|null}
 let cuaSession:ComputerUseSession|undefined
 let cuaOpening:Promise<ComputerUseSession|undefined>|undefined
 let cuaIdleTimer:ReturnType<typeof setTimeout>|undefined
 let cuaLastReport:{at:string;reason:string;note:string;restored:readonly string[];failed:readonly string[]}|null=null
 const cuaRefusals:Array<{at:string;tool:string;code:string;rule:string;combos:readonly string[]}>=[]
 /** 空闲这么久没有输入就认为 computer-use 会话结束：**无条件恢复**快照，别把用户留在被改过的环境里。 */
 const COMPUTER_USE_IDLE_MS=120_000
 const computerUseFacts=()=>({active:Boolean(cuaSession),since:cuaSession?.openedAt??null,consent:cuaConsent.consent,consentReason:cuaConsent.reason,
  indicator:cuaSession?.indicator??null,
  snapshot:cuaSession?{at:cuaSession.snapshot.at,display:cuaSession.snapshot.display,readableCount:cuaSession.snapshot.readableCount,keys:cuaSession.snapshot.entries.map(entry=>({id:entry.id,value:entry.value,readable:entry.readable})),note:cuaSession.snapshot.note}:null,
  lastReport:cuaLastReport,refusals:cuaRefusals.slice(-5)})
 const closeComputerUseSessionNow=async(reason:string)=>{
  if(cuaIdleTimer!==undefined){clearTimeout(cuaIdleTimer);cuaIdleTimer=undefined}
  const session=cuaSession
  if(!session)return undefined
  cuaSession=undefined
  try{
   const report=await closeComputerUseSession(session,{...config.computerUse?.runner?{run:config.computerUse.runner}:{}})
   cuaLastReport={at:report.at,reason,note:report.note,restored:report.restored,failed:report.failed}
   if(report.failed.length)ctx.logger.warn(`lyapunov computer-use a11y restore failed: ${report.failed.join(",")}`)
   return report
  }catch(error){
   // 恢复失败绝不能吞：用户被留在被改过的环境里，必须留下明确记录（下次会话/诊断导出看得到）。
   cuaLastReport={at:new Date().toISOString(),reason,note:`${COMPUTER_USE_INPUT_ERRORS.RESTORE_FAILED}: ${error instanceof Error?error.message:String(error)}`,restored:[],failed:session.snapshot.entries.map(entry=>entry.id)}
   ctx.logger.warn(`lyapunov computer-use restore threw: ${error instanceof Error?error.message:String(error)}`)
   return undefined
  }
 }
 /** 首次真正要发输入时才开会话：先快照（含"检查过这些键"的记录），再点亮可见指示。 */
 const openComputerUseSessionOnce=async()=>{
  if(cuaSession)return cuaSession
  cuaOpening??=openComputerUseSession({consent:cuaConsent.consent,consentReason:cuaConsent.reason,projection:false,...config.computerUse?.runner?{run:config.computerUse.runner}:{}})
   .then(session=>{cuaSession=session;return session})
   .catch(error=>{ctx.logger.warn(`lyapunov computer-use snapshot unavailable: ${error instanceof Error?error.message:String(error)}`);return undefined})
   .finally(()=>{cuaOpening=undefined})
  return await cuaOpening
 }
 const armComputerUseIdle=()=>{
  if(cuaIdleTimer!==undefined)clearTimeout(cuaIdleTimer)
  cuaIdleTimer=setTimeout(()=>{void closeComputerUseSessionNow("idle")},COMPUTER_USE_IDLE_MS)
 }
 // 宿主卸载/异常退出：会话没关也要把桌面设置写回去（这就是"含异常退出路径"的那一条）。
 ctx.effect(()=>async()=>{await closeComputerUseSessionNow("host-unload")},"lyapunov-shell: computer-use a11y restore")
 ctx.on("tools/execute",async(exec,next)=>{
  // W22-R3：漏斗的第一个问题**不再**是"这个名字在不在三张表里"，而是"这个名字能不能原样交回驱动"。
  // 判据的唯一 owner 是 computer-use-input.ts 的 `cuaDriverToolPassThrough`（依据是那张**全表**
  // `CUA_DRIVER_TOOL_CATALOG`：59 个驱动工具逐个分类，每类都有"能碰到什么用户对象"的读数）：
  //   · 不是 `cua_driver_native__*` ⇒ 放行（本模块不管别的域的工具体）；
  //   · 在册的观测/会话类（`pass`）⇒ 放行（每一条的放行理由写在表里，不再靠"没被点名"）；
  //   · 其余（三张表里的 + **不在全表里的**）⇒ 进本漏斗，由 `guardComputerUseInput` 判。
  // 改前这里只认三张表 ⇒ **表外的一切第一行就 `return next()`**：而驱动是 `listToolsJson()` 列什么就
  // 注册什么，所以"驱动升级新增一个工具名"与"本来就没被点名的工具"（`clipboard_read` 就是这么漏的）
  // 都会**连判定都不做**地交给驱动。现在"表外"只剩"在册的观测类"这一种含义；不在册的名字不放行。
  const cuaInEnforcedTable=cuaInputTools.has(exec.name)||cuaGlobalStateTools.has(exec.name)||cuaPrivacyReadTools.has(exec.name)
  const scope=()=>({consent:cuaConsent.consent,indicatorVisible:Boolean(cuaSession?.indicator.visible),sessionOpen:Boolean(cuaSession)})
  const refuse=(plan:{code:string;rule:string;reason:string;advice:string;combos:readonly string[]}):never=>{
   cuaRefusals.push({at:new Date().toISOString(),tool:exec.name,code:plan.code,rule:plan.rule,combos:plan.combos})
   if(cuaRefusals.length>32)cuaRefusals.splice(0,cuaRefusals.length-32)
   console.log(`[computer-use-input] 拒绝 ${exec.name}：${plan.code}（${plan.rule}${plan.combos.length?`；${plan.combos.join(" ")}`:""}）`)
   throw new Error(`${plan.code}: ${plan.reason}${plan.advice?` 怎么办：${plan.advice}`:""}`)
  }
  const surfaceRefusal=computerUseSurfaceRefusal(exec.name,exec.arguments)
  if(surfaceRefusal)refuse(surfaceRefusal)
  if(!cuaInEnforcedTable&&cuaDriverToolPassThrough(exec.name))return next()
  // 第一判：拒绝清单 + 工具分类 + 作用域。这三类结论与"开不开会话"无关，
  // **先判完再决定动不动桌面**——旧实现把 `global-needs-consent`/`global-needs-indicator` 也算作
  // "要开会话"，于是**一个注定被拒的输入**仍然动了用户的桌面（9 次 `gsettings get` 快照 +
  // 一条 notify-send「Lyapunov 正在控制输入」），而且 `armComputerUseIdle()` 在它后面
  // ⇒ 那个会话**没有空闲计时器**，只能等显式结束或 Host 卸载。
  // 最坏的一面是可见指示在说假话：用户收到"正在控制输入"的通知，而这次**一个字节都没发**
  // （W22 验收 §3.3）。现在被拒就是被拒：不开会话、不动桌面、也不留一个不会被自动结束的会话。
  const first=guardComputerUseInput({tool:exec.name,arguments:exec.arguments,scope:scope()})
  // 唯一的例外：`first.provisional`（VERIFY2 §5.2 的"先有鸡先有蛋"，本单残留口子④）。
  // 全局层要**可见指示**，而可见指示是**会话的产物**（`openComputerUseSession` 里才跑
  // `enforceVisibleIndicator`），会话又只在首个输入被放行之后才开 ⇒ 会话还没开时那条
  // `global-needs-indicator` 的含义是"还没有会话去点亮它"，把它当终局就是：要指示 → 没会话 →
  // 没有指示 → 拒 → 会话永远开不出来 → **全局输入永久全哑**（安全但功能死掉）。
  // 见到这个标记就先开会话（那正是点亮指示的动作），下面第二判拿会话里**真实的**指示状态再判一次；
  // 那次仍拒才是终局。判据一条都没放宽：第二判用的还是同一个 `planComputerUseInput`，
  // `indicatorVisible` 换成会话里实测的值。
  if(!first.deliver&&!first.provisional)refuse(first)
  // 任何**允许**的输入（窗口作用域也算）都先开会话：合成按键即使指名窗口也会经过桌面/WM 的全局通道，
  // 输入法/键盘布局/a11y 都可能被碰到——所以先快照（含"检查过这些键"的记录）再发，会话结束无条件恢复。
  if(!cuaSession)await openComputerUseSessionOnce()
  const session=cuaSession
  // 会话开出来了：**同意与可见指示此刻才可能存在**（可见指示本身就是会议的产物）。只有"用户同意 +
  // 会话里确实有可见指示"的全局输入会走到这里；没有指示就当场拒（fail-closed，与第一判同一口径）。
  // 会话开不出来（快照不可用）⇒ 没有"会话结束恢复"的依据 ⇒ 连允许的输入也不发。
  if(!session){
   refuse({code:COMPUTER_USE_INPUT_ERRORS.SESSION_UNAVAILABLE,rule:"session-unavailable",reason:"computer-use 会话开不出来（桌面设置快照不可用）⇒ 这次输入没有可恢复的依据，因此不发。",advice:"先解决快照不可用的原因（例如 `gsettings`/dconf 不可读）再重试；没有快照就不发输入。",combos:first.combos})
   throw new Error(`${COMPUTER_USE_INPUT_ERRORS.SESSION_UNAVAILABLE}: unreachable`)
  }
  // 空闲计时器**在会话一开出来就武装**（原先挂在第二判之后）：这样"会话开出来了、但第二判仍然拒"
  // 那条路径也不会留下一个不会被自动结束、也就不会被自动恢复的会话 —— 那正是 §5 修掉的那个毛病，
  // 只是换了个入口。对放行的输入行为不变（下面原来那次 `armComputerUseIdle()` 只是重置同一条计时器）。
  armComputerUseIdle()
  const plan=guardComputerUseInput({tool:exec.name,arguments:exec.arguments,scope:{consent:cuaConsent.consent,indicatorVisible:Boolean(session.indicator.visible),sessionOpen:true}})
  if(!plan.deliver)refuse(plan)
  const queuedAt=Date.now()
  cuaInputQueued+=1
  // 等待时长必须在**真的轮到自己执行的那一刻**取，且与本次占用时长分开记。
  // 修前 `waited` 在整条链跑完之后才算，于是第一个动作的**执行耗时**被记成"串行等待"——
  // 一个独占桌面 500ms 的首个输入动作会写成"串行等待 500ms 后执行"，这一行读不出"谁在等、谁在占用"。
  let waitMs=0
  const markReached=()=>{waitMs=Date.now()-queuedAt;return next()}
  const run=cuaInputTail.then(markReached,markReached)
  cuaInputTail=run.then(()=>undefined,()=>undefined)
  const settled=()=>{cuaInputQueued-=1;return Date.now()-queuedAt-waitMs}
  return run.then(
   result=>{const heldMs=settled();if(waitMs>50)console.log(`[computer-use-single-flight] ${exec.name} 串行等待 ${waitMs}ms 后执行（本次占用 ${heldMs}ms，释放后仍有 ${cuaInputQueued} 个输入动作在等）`);return result},
   error=>{settled();throw error})
 })
 if(config.administrator&&config.modelBilling==="own-key")ctx.systemPrompt.context({name:"lyapunov-administrator",order:8400,text:()=>"Vorynel AdminService has verified this workbench operator as a super administrator. The model uses the existing own Key through the native Provider directly, without Lyapunov Credits reservation or settlement. This administrator identity does not create another consumer wallet; usage is metered by the Key provider.\n"+JSON.stringify(config.administrator)})
 const hostInstanceId=randomUUID(),dependencyCache=new Map<string,Set<string>>(),segmentationFiles=new Map<string,Set<string>>()
 let executionSnapshot:ReturnType<typeof applyExecutionGraph>|undefined
 ctx.inject(["sessionProjections"],child=>{
  const read=applyExecutionGraph(child,hostInstanceId,config.graph);executionSnapshot=read
  child.effect(()=>()=>{if(executionSnapshot===read)executionSnapshot=undefined},"执行图读口卸载")
 })
 /** 分割产物准入清单的键：**会话 + 场景**。同一个 sceneId 在别的会话里是另一份场景，清单不能互相放行。 */
 const segmentationKey=(sessionKey:string,sceneId:string)=>`${sessionKey}|${sceneId}`
 /**
  * 选择事实**按窗口**保存（clientId → {sequence, facts, at}），同一个会话仍只有这一张表：
  * 两个窗口各选各的实体时互不覆盖；`sequence` 的单调边界仍只对**同一个** clientId 生效。
  * 模型侧只认"活动窗口"＝最近一次写入事实的那个窗口（`activeSelection`），不把别的窗口的选择写进上下文。
  */
 type WindowSelection={sequence:number;facts:Record<string,unknown>;at:number}
 const selections=new WeakMap<ScopeKey,Map<string,WindowSelection>>()
 /** 活动顺序用一个进程内单调计数：同一毫秒内的两次选择也能判出先后（墙钟会打平）。 */
 let selectionClock=0
 const selectionSlots=(scope:ScopeKey):Map<string,WindowSelection>=>{
  const existing=selections.get(scope)
  if(existing)return existing
  const created=new Map<string,WindowSelection>();selections.set(scope,created);return created
 }
 /** 活动窗口的选择：最近写入的那一份。窗口身份随事实一起给出，供命令归属与 UI 动作目标使用。 */
 const activeSelection=(scope:ScopeKey|undefined):{clientId:string;sequence:number;facts:Record<string,unknown>}|undefined=>{
  const slots=scope?selections.get(scope):undefined
  if(!slots)return undefined
  let picked:{clientId:string;sequence:number;facts:Record<string,unknown>;at:number}|undefined
  for(const [clientId,slot] of slots)if(!picked||slot.at>picked.at)picked={clientId,...slot}
  return picked
 }
 const lastSceneOf=(events:readonly any[]|undefined):string|undefined=>events?.findLast(event=>event.type==="lyapunov/last-scene")?.data.sceneId
 // 自我控制:agent 经 ui_action 把界面动作(打开面板/文件/终端/画布、选中、聚焦)排入按会话键控的队列,
 // 前端轮询 state 时取走执行并用 ui_action_ack 确认;队列只留最近 20 条,host 重启即空。
 type UiAction={id:string;action:string;args:Record<string,unknown>;enqueuedAt:string}
  const uiActionQueue=new Map<string,UiAction[]>()
 /** 一条界面动作的**目标窗口**：`args.clientId` 是唯一约定（采集/相机/UI 动作共用它）。 */
 const uiActionTargetOf=(entry:UiAction):string|undefined=>typeof entry.args.clientId==="string"&&entry.args.clientId?entry.args.clientId:undefined
 /**
  * 这次 state 轮询该不该看见这条动作。
  * 采集/相机对会话内每个窗口可见：非目标要能看见它还在队列里，但自己不执行、不确认。
  * 其余带目标窗口的界面动作只投给那个窗口，非目标连条目都拿不到。
  * 没有目标、或这次轮询没带 clientId 时，整份队列照旧交给调用方。
  */
 const uiActionVisibleTo=(entry:UiAction,clientId:string|undefined):boolean=>{
  const target=uiActionTargetOf(entry)
  if(!target||!clientId)return true
  if(entry.action==="captureViewer"||entry.action==="applyCameraViewer"||entry.action==="renderCameraViewer"||entry.action==="sampleCameraViewer")return true
  return target===clientId
 }
 const sessionKeyOf=(agent:unknown):string=>requireSessionId(agent,"3D 工作台")
 /**
  * 会话服务面：场景与模拟都从**各自 Host 级 facade** 取本会话的那一份（`forSession`，惰性、按会话 memo），
  * 与 scene-kit 的 `sceneOperationsFor` / sim-contract 的 `simWorldsFor` 是同一套取法（同一份会话键规则）。
  * 取不到会话就明确失败——**没有"默认实例"可落**：修前所有会话共用同一份 SceneOperations 与同一个
  * Provider，于是 A 会话加载环境会覆盖 B 会话的 3D 场景。
  */
 const sceneFor=(sessionKey:string):SceneOperations=>{
  const scene=ctx.get("scene") as SceneService|undefined
  if(!scene?.forSession)throw new Error("SCENE_SERVICE_UNAVAILABLE: 当前 Profile 未启用场景服务")
  return scene.forSession(sessionKey)
 }
 const simFor=(sessionKey:string):SimWorlds|undefined=>{
  const sim=ctx.get("sim") as SimService|undefined
  return sim?.forSession?sim.forSession(sessionKey):undefined
 }
 /**
  * 只读路径取世界服务：**该会话已经有实例才取**（`has` 不隐式创建），不为了读一次状态就替它起一套 Provider。
  * 写路径（工具/命令）用 `simFor`——那里的取用本身就是要用这个世界。
  */
 const existingSimFor=(sessionKey:string):SimWorlds|undefined=>{
  const sim=ctx.get("sim") as SimService|undefined
  if(!sim?.forSession||!sim.has?.(sessionKey))return undefined
  return sim.forSession(sessionKey)
 }
 const requireSimFor=(sessionKey:string):SimWorlds=>{
  const sim=simFor(sessionKey)
  if(!sim)throw new Error("PROVIDER_UNAVAILABLE: 当前 Profile 未启用模拟 Provider")
  return sim
 }
 const uiActionNames=["openTool","openFiles","openTerminal","openResource","showCanvas","selectEntity","focus","enterSceneCenter","selectScene","exitCameraView","aimCameraView","locateTcp","locateBase"] as const
 /**
  * 主动观察：`viewer_observe` 让"当前会话里那个真实 3D 窗口现在拍一张"。
  *
  * 它复用同一条 ui_action 队列与同一个 `viewer_capture` 落盘/来源校验路径，只额外登记两件事实：
  *   · 哪个窗口在场（presence）——由前端既有的 state 轮询顺带携带，不新增通道；
  *   · 谁在等这张图（waiter）——按 observeId 登记，超时/取消/结束都在同一处撤销。
  * 于是"图像来自哪个窗口、哪个场景、哪个 rev"有据可查：回来后三样都对上才认这张图。
  */
 type ObserveClient={at:number;sceneId?:string;revision?:number}
 /** 观察结果只有两种：真实采集（含原生附件引用）或带原因的失败。 */
 type ObserveSettlement={ok:true;capture:CaptureRecord;attachment:ImageAttachmentRef}|{ok:false;error:string}
 /**
  * 另一类等待：**相机应用**（`viewer_camera_apply`）。它没有图，结果是"应用后当场量到的相机读数"。
  *
  * 为什么和观察共用一张等待表：两者的归属判据完全一样（会话 + 目标窗口 + 场景 + 版本），
  * 差别只在"交付物是图还是读数"。分成两张表就会有两套超时/取消/归属核对，迟早漂移。
  */
 type CameraApplySettlement={ok:true;value:Record<string,unknown>}|{ok:false;error:string}
 /** 前端在场有效期：静态页面的 state 轮询间隔是 250ms，这里按数量级留余量，只用来判断"窗口还在不在"。 */
 const OBSERVE_PRESENCE_TTL_MS=3000
 /** 观察等待上限：够一次轮询 + 一次 toDataURL + 一次 POST；超过就是没有窗口在服务这次请求。 */
 const OBSERVE_TIMEOUT_MS=15000
 const observeClients=new Map<string,Map<string,ObserveClient>>()
 /**
  * 等待者的**种类**：`capture` 等一张图（交付物是采集记录 + 原生附件），`camera` 等一次相机应用
  * （交付物是应用后当场量到的读数）。两者共用同一份归属判据与同一套超时/取消/落队逻辑，
  * 所以是同一张表上的两种 kind，而不是两张各自演化的表。
  */
 type WaiterBase={sessionKey:string;clientId:string;sceneId:string;expectedRevision:number;timer:ReturnType<typeof setTimeout>}
 type CaptureWaiter=WaiterBase&{
  kind:"capture"
  /**
   * 这次等待要求的采集来源（`capture.source`）。`viewer_render_camera` 要求 `native-viewer-camera`：
   * 前端万一回了张"当前画布截图"，这里就把它判成失败，绝不让模型拿它当"按照片相机出的图"去比对。
   */
  expectSource?:string
  settle:(value:ObserveSettlement)=>void
 }
 type CameraWaiter=WaiterBase&{kind:"camera";settle:(value:CameraApplySettlement)=>void}
 /**
  * 资源打开等待（`ui_action` 的 `openResource`）：没有场景/版本可以对版，归属只有**会话 + 目标窗口**。
  * 交付物是前端**真实**的打开确认（`opened` 且 `visible`），且必须与被请求的规范资源地址与打开 kind
  * 对得上（`expectation`）；不是"已排队"，也不是把请求参数抄回来。
  */
 type OpenSettlement={ok:true;value:Record<string,unknown>}|{ok:false;error:string}
 type OpenWaiter={kind:"open";sessionKey:string;clientId:string;expectation:OpenExpectation;timer:ReturnType<typeof setTimeout>;settle:(value:OpenSettlement)=>void}
 type ObservationWaiter=CaptureWaiter|CameraWaiter|OpenWaiter
 const observeWaiters=new Map<string,ObservationWaiter>()
 const liveObserveClients=(sessionKey:string):Array<[string,ObserveClient]>=>{
  const now=Date.now(),rows=[...(observeClients.get(sessionKey)??new Map<string,ObserveClient>())].filter(([,client])=>now-client.at<=OBSERVE_PRESENCE_TTL_MS)
  if(!rows.length)observeClients.delete(sessionKey)
  return rows
 }
 /** 记一次窗口在场事实。revision 是**该窗口正在显示的**版本，不是宿主当前版本。 */
 const noteObserveClient=(sessionKey:string,clientId:string|undefined,sceneId?:string,revision?:number)=>{
  if(!clientId)return
  const clients=observeClients.get(sessionKey)??new Map<string,ObserveClient>()
  clients.set(clientId,{at:Date.now(),...(sceneId?{sceneId}:{}),...(Number.isInteger(revision)?{revision}:{})})
  observeClients.set(sessionKey,clients)
 }
 /**
  * 目标窗口判定：显式 clientId 优先；省略时要求该会话的活动窗口唯一，或恰好只有一个窗口显示着目标版本。
  * 两个窗口都在场又都不明确时**拒绝**而不是随便挑一个——抢错窗口会把别人屏幕上的画面当成模型自己的观察。
  */
 const observeTargetClient=(sessionKey:string,request:{sceneId:string;expectedRevision:number;clientId?:string}):string=>{
  const live=liveObserveClients(sessionKey)
  if(request.clientId){
   if(!live.some(([clientId])=>clientId===request.clientId))throw new Error(`VIEWER_OBSERVE_CLIENT_NOT_LIVE: 该会话当前没有活动窗口 ${request.clientId}（活动窗口：${live.map(([clientId])=>clientId).join("、")||"无"}）；窗口可能已关闭或不是这个会话。`)
   return request.clientId
  }
  if(!live.length)throw new Error("VIEWER_OBSERVE_NO_VIEWER: 该会话没有前端窗口在工作台里轮询。观察需要用户打开着这个会话的 3D 工作台页面；没有窗口时不采集，也不会拿别的渲染（例如 Blender 预览图）冒充。")
  if(live.length===1)return live[0][0]
  const matching=live.filter(([,client])=>client.sceneId===request.sceneId&&client.revision===request.expectedRevision)
  if(matching.length===1)return matching[0][0]
  const rows=live.map(([clientId,client])=>`${clientId.slice(0,8)}（${client.sceneId??"无场景"}${client.revision===undefined?"":" rev "+String(client.revision)}）`).join("、")
  throw new Error(`VIEWER_OBSERVE_TARGET_AMBIGUOUS: 该会话有 ${String(live.length)} 个活动窗口，且没有唯一一个显示着 ${request.sceneId} rev ${String(request.expectedRevision)}；请带 clientId 指定目标窗口：${rows}`)
 }
 const uiActionTarget=(sessionKey:string,scope:ScopeKey|undefined,request:{clientId?:string;sceneId?:string}):string|undefined=>{
  const live=liveObserveClients(sessionKey)
  if(request.clientId){
   if(!live.some(([clientId])=>clientId===request.clientId))throw new Error(`UI_ACTION_CLIENT_NOT_LIVE: 该会话当前没有活动窗口 ${request.clientId}（活动窗口：${live.map(([clientId])=>clientId).join("、")||"无"}）；窗口可能已关闭或不是这个会话。`)
   return request.clientId
  }
  const active=activeSelection(scope)
  if(active&&live.some(([clientId])=>clientId===active.clientId))return active.clientId
  if(live.length===1)return live[0][0]
  if(request.sceneId){const matching=live.filter(([,client])=>client.sceneId===request.sceneId);if(matching.length===1)return matching[0][0]}
  return undefined
 }
 /**
  * 结束一次等待：删除登记、停表、把结果交给等待者。返回是否确有等待者在等
  * （顺手清掉队列里那次未消费的动作，超时/取消后迟到的截图不会落进面板）。
  */
 const takeWaiter=<K extends ObservationWaiter["kind"]>(observeId:string,kind:K):Extract<ObservationWaiter,{kind:K}>|undefined=>{
  const waiter=observeWaiters.get(observeId)
  // 种类不符时**不**取走：同一个 id 上的另一种等待仍在被别人等着，误取会把它静默掐死。
  if(!waiter||waiter.kind!==kind)return undefined
  observeWaiters.delete(observeId);clearTimeout(waiter.timer)
  return waiter as Extract<ObservationWaiter,{kind:K}>
 }
 /** 与种类无关的失败收尾（超时/取消/前端报错）：谁在等就把原因给谁。 */
 const failObservation=(observeId:string,error:string):boolean=>{
  const waiter=observeWaiters.get(observeId)
  if(!waiter)return false
  observeWaiters.delete(observeId);clearTimeout(waiter.timer);waiter.settle({ok:false,error})
  return true
 }
 const dropObservation=(observeId:string,sessionKey:string,error?:string)=>{
  if(error)failObservation(observeId,error)
  const queue=uiActionQueue.get(sessionKey)
  if(queue?.some(entry=>entry.id===observeId))uiActionQueue.set(sessionKey,queue.filter(entry=>entry.id!==observeId))
 }
 /**
  * 真实采集回来后交付：**会话 + 目标窗口 + 场景 + 版本**必须同时对上。
  *
  * 会话身份取自本次调用**已解析的 agent**（`invocation.agent`），不是请求体里的 sessionId：
  * 否则另一个会话的窗口可以拿别人的 observeId 替这次观察下结论（成功或失败都算）。
  * 归属不符时**不结束等待**（返回 settled:false + 原因），真正的目标窗口仍在轮询、仍会自己送图；
  * 归属相符但图不对版才把这次观察判失败——宁可让模型知道"这次观察没成立"，也不给它一张别的窗口/别的版本的图。
  */
 /**
  * 归属判据**只有这一份**：会话 + 目标窗口 + 场景 + 版本必须同时对上。
  *
  * 落盘前（`viewer_capture` 的核对，P2-2）与交付时（`settleObservedCapture`）都调它——两处各写一遍必然漂移，
  * 而漂移出来的核对只证明它自己。两类不符的处理不同，所以这里带上分类：
  *   · `foreign`：不属于本会话/本窗口的回传，**什么都不做**（真正的目标窗口还在等它自己的图）；
  *   · `version`：归属对但图不对版，这次观察按失败结束（不给模型一张别版本的图）。
  */
 const observeAgainst=(waiter:{sessionKey:string;clientId:string;sceneId:string;expectedRevision:number},image:{sessionKey:string;clientId?:unknown;sceneId?:unknown;sceneRevision?:unknown}):{kind:"foreign"|"version";reason:string}|undefined=>{
  if(waiter.sessionKey!==image.sessionKey)return {kind:"foreign",reason:"VIEWER_OBSERVE_FOREIGN_SESSION: 这次观察不属于本次调用所在的会话，已忽略该回填"}
  if(waiter.clientId!==image.clientId)return {kind:"foreign",reason:`VIEWER_OBSERVE_CLIENT_MISMATCH: 这张图来自窗口 ${image.clientId===undefined?"（未标注）":String(image.clientId)}，不是被请求的 ${waiter.clientId}；这次观察继续等目标窗口自己的图`}
  if(image.sceneId!==waiter.sceneId)return {kind:"version",reason:`VIEWER_OBSERVE_SCENE_MISMATCH: 这张图属于场景 ${image.sceneId}，不是被请求的 ${waiter.sceneId}`}
  if(image.sceneRevision!==waiter.expectedRevision)return {kind:"version",reason:`VIEWER_OBSERVE_STALE_REVISION: 这张图属于 rev ${String(image.sceneRevision)}，被请求的是 rev ${String(waiter.expectedRevision)}`}
  return undefined
 }
 const settleObservedCapture=(observeId:string,caller:{sessionKey:string;clientId?:unknown;capture:CaptureRecord;attachment:ImageAttachmentRef}):{settled:boolean;matched:boolean;refused?:string}=>{
  const peeked=observeWaiters.get(observeId)
  if(!peeked||peeked.kind!=="capture")return {settled:false,matched:false}
  const mismatch=observeAgainst(peeked,{sessionKey:caller.sessionKey,clientId:caller.clientId,sceneId:caller.capture.sceneId,sceneRevision:caller.capture.sceneRevision})
  // 归属不符（别会话/别窗口）：不结束等待，真正的目标窗口仍在轮询、仍会自己送图。
  if(mismatch?.kind==="foreign")return {settled:false,matched:false,refused:mismatch.reason}
  const waiter=takeWaiter(observeId,"capture")
  if(!waiter)return {settled:false,matched:false}
  // 归属对、图不对版：这次观察判失败（matched 保持 false——它不是这次观察的结论，只是把它结束了）。
  if(mismatch){waiter.settle({ok:false,error:mismatch.reason});return {settled:true,matched:false,refused:mismatch.reason}}
  // 来源要求不符（`viewer_render_camera` 要的是"按指定相机出的图"）：同样判失败，
  // 让模型知道它要的那种图没到手，而不是拿一张当前画布截图去当"同机位参考图"。
  const actualSource=(caller.capture as CaptureRecord&CaptureCameraExtras).source
  if(waiter.expectSource&&actualSource!==waiter.expectSource){
   const refused=`VIEWER_RENDER_CAMERA_SOURCE_MISMATCH: 这次采到的是 ${actualSource??"（未标来源）"} 来源的图，请求要的是 ${waiter.expectSource}（按指定相机用同一个原生 Viewer 出的图）；没有把它当成要的那张图。`
   waiter.settle({ok:false,error:refused})
   return {settled:true,matched:false,refused}
  }
  waiter.settle({ok:true,capture:caller.capture,attachment:caller.attachment})
  return {settled:true,matched:true}
 }
 /**
  * 相机应用回来了：归属判据与采集**同一份**（会话 + 目标窗口 + 场景 + 版本），只是没有图要对版。
  * 场景/版本对不上说明前端应用的那台相机不是在等的那一个，按失败结束——宁可让模型知道"这次没成立"，
  * 也不把它记成"相机已经摆好了"。
  */
 const settleCameraApply=(observeId:string,caller:{sessionKey:string;clientId?:unknown;sceneId?:unknown;sceneRevision?:unknown;value:unknown}):{settled:boolean;matched:boolean;refused?:string}=>{
  const peeked=observeWaiters.get(observeId)
  if(!peeked||peeked.kind!=="camera")return {settled:false,matched:false}
  const mismatch=observeAgainst(peeked,{sessionKey:caller.sessionKey,clientId:caller.clientId,sceneId:caller.sceneId,sceneRevision:caller.sceneRevision})
  if(mismatch?.kind==="foreign")return {settled:false,matched:false,refused:mismatch.reason}
  const waiter=takeWaiter(observeId,"camera")
  if(!waiter)return {settled:false,matched:false}
  if(mismatch){waiter.settle({ok:false,error:mismatch.reason});return {settled:true,matched:false,refused:mismatch.reason}}
  const value=caller.value
  // 回执形状不对就是"没有应用"：宁可判失败，也不把一个没有读数、没有状态的半份回执记成成功。
  if(!value||typeof value!=="object"||Array.isArray(value)||typeof (value as {camera?:unknown}).camera!=="object"||typeof (value as {state?:unknown}).state!=="object"){
   const reason="VIEWER_CAMERA_RECEIPT_INVALID: 窗口回执里没有应用后测量的相机与可恢复状态（camera/state），这次应用不能算成立"
   waiter.settle({ok:false,error:reason})
   return {settled:true,matched:false,refused:reason}
  }
  waiter.settle({ok:true,value:value as Record<string,unknown>})
  return {settled:true,matched:true}
 }
 /**
  * 资源打开回来了：归属判据只有**会话 + 目标窗口**（打开动作没有场景/版本可对版）。
  * 回执必须是前端**真实**的打开事实（`opened=true` 且 `visible=true`，且带真实激活标签的
  * `address`/`kind`），并与等待时的期望（规范资源地址 + 点名打开 kind）逐项对上：只回一句"已排队"、
  * 标签开了但列没展开、打开的是另一个文件、或用了错误的打开方式，都不算成立。
  */
 const settleOpenAction=(openId:string,caller:{sessionKey:string;clientId?:unknown;value:unknown}):{settled:boolean;matched:boolean;refused?:string}=>{
  const peeked=observeWaiters.get(openId)
  if(!peeked||peeked.kind!=="open")return {settled:false,matched:false}
  // 归属判据（会话 + 目标窗口）与回执判据（地址/kind/可见）各有唯一一份纯实现：
  // 前端产出确认、宿主核对确认都用同一套，不会两边漂移出假成功。
  const ownership=openWaiterOwnership(peeked,caller)
  if(ownership)return {settled:false,matched:false,refused:ownership.reason}
  const waiter=takeWaiter(openId,"open")
  if(!waiter)return {settled:false,matched:false}
  const verdict=openReceiptVerdict(caller.value,waiter.expectation)
  if(!verdict.ok){waiter.settle({ok:false,error:verdict.reason});return {settled:true,matched:false,refused:verdict.reason}}
  waiter.settle({ok:true,value:verdict.value})
  return {settled:true,matched:true}
 }
 /**
  * 排队一条"要看图"的界面动作并等它的结果：`viewer_observe`（当前画布截屏）与
  * `viewer_render_camera`（按指定相机出图）共用。超时/取消/落队三件事只在这里做一次，
  * 两条路径的差别只有动作名、附加参数（相机请求、图片尺寸）与要核对的来源。
  */
 const queueCaptureRequest=async(input:{sessionKey:string;clientId:string;sceneId:string;expectedRevision:number;action:string;args?:Record<string,unknown>;expectSource?:string;timeoutError:string;abortError:string;signal:AbortSignal}):Promise<ObserveSettlement>=>{
  const observeId=randomUUID()
  const settled=new Promise<ObserveSettlement>(resolve=>{
   const timer=setTimeout(()=>{dropObservation(observeId,input.sessionKey,input.timeoutError)},OBSERVE_TIMEOUT_MS)
   observeWaiters.set(observeId,{kind:"capture",sessionKey:input.sessionKey,clientId:input.clientId,sceneId:input.sceneId,expectedRevision:input.expectedRevision,timer,settle:resolve,...input.expectSource?{expectSource:input.expectSource}:{}})
  })
  uiActionQueue.set(input.sessionKey,[...uiActionQueue.get(input.sessionKey)??[],{id:observeId,action:input.action,args:{clientId:input.clientId,sceneId:input.sceneId,expectedRevision:input.expectedRevision,...input.args??{}},enqueuedAt:new Date().toISOString()}].slice(-20))
  const abort=()=>dropObservation(observeId,input.sessionKey,input.abortError)
  input.signal.addEventListener("abort",abort,{once:true})
  try{return await settled}finally{input.signal.removeEventListener("abort",abort);dropObservation(observeId,input.sessionKey)}
 }
 // 导入后的图像方向检查只存本次会话/窗口/版本关联；Scene 与截图真值仍归原生 owner。
 const orientationControllers=new Map<string,AbortController>()
 const orientationChecks=new OrientationChecks((sessionKey,messageId)=>{
  ctx.agents.get(SessionId(sessionKey))?.inbox.remove(messageId as never)
 })
 const cancelOrientation=(agent:unknown,sessionKey:string,checkId:string,reason?:string)=>{
  const cancelled=orientationChecks.cancel(sessionKey,checkId,reason)
  orientationControllers.get(checkId)?.abort(new Error("ORIENTATION_CHECK_CANCELLED"))
  orientationControllers.delete(checkId)
  if(cancelled.messageId)(agent as {inbox?:{remove?:(id:never)=>boolean}}).inbox?.remove?.(cancelled.messageId as never)
  return cancelled.face
 }
 const stopOrientationTurn=(agent:unknown,sessionKey:string,checkId:string)=>{
  const before=orientationChecks.get(sessionKey,checkId)
  const owner=agent as {status?:string;session?:Session;cancel?:(cause:{kind:"user"},options:{keepInbox:true})=>void}
  const turn=orientationChecks.dedicatedTurn(sessionKey,checkId,activeTurnSignals.get(agent as object))
  const boundary=owner.session?.snapshotEvents().findLast(event=>event.type==="turn/start"||event.type==="turn/end")
  const ownsActiveTurn=before?.status==="checking"&&turn!==undefined&&owner.status==="running"&&boundary?.type==="turn/start"&&boundary.data.turn===turn&&typeof owner.cancel==="function"
  cancelOrientation(agent,sessionKey,checkId)
  if(ownsActiveTurn){
   orientationChecks.markTurnStop(sessionKey,checkId,"requested")
   // 身份核对与原生取消同一同步段完成；保留其它用户 Inbox，等待匹配 turn/end 确认。
   owner.cancel!({kind:"user"},{keepInbox:true})
  }else if(before?.status==="checking")orientationChecks.markTurnStop(sessionKey,checkId,"shared")
  return orientationChecks.get(sessionKey,checkId)
 }
 ctx.on("agent/status",({agent,status})=>{
  if(status!=="idle")return
  const sessionKey=sessionKeyOf(agent),latest=orientationChecks.get(sessionKey)
  // 正常结束的模型回合若未领取图像，队列里的旧检查也不可留给未来的用户回合。
  if(latest?.status==="queued"&&orientationChecks.pendingMessageId(sessionKey,latest.checkId))cancelOrientation(agent,sessionKey,latest.checkId,"图像消息未进入本次模型步骤")
  else orientationChecks.idle(sessionKey)
  activeTurnSignals.delete(agent)
 })
 ctx.on("session/event",(session,event)=>{
  if(event.type==="turn/end")orientationChecks.endTurn(requireSessionId(session,"方向检查回合结束"),event.data.turn,event.data.reason)
 })
 const requireOrientationWindow=(sessionKey:string,face:{clientId?:string;sceneId:string;sceneRevision:number}):string=>{
  const live=liveObserveClients(sessionKey).find(([id])=>id===face.clientId)
  if(!face.clientId||!live||live[1].sceneId!==face.sceneId||live[1].revision!==face.sceneRevision)throw new Error("ORIENTATION_WINDOW_STALE: 目标窗口已离开本次场景版本，不使用旧图改场景")
  return face.clientId
 }
 const orientationClient=async(target:OrientationTarget,signal:AbortSignal):Promise<string>=>{
  for(let waited=0;waited<=12000;waited+=100){
   signal.throwIfAborted()
   const matching=liveObserveClients(target.sessionKey).filter(([id,row])=>(!target.clientId||id===target.clientId)&&row.sceneId===target.sceneId&&row.revision===target.revision)
   if(matching.length===1)return matching[0]![0]
   if(matching.length>1)throw new Error("ORIENTATION_WINDOW_AMBIGUOUS: 多个窗口正在显示目标版本，不能猜目标窗口")
   if(waited<12000)await new Promise(resolve=>setTimeout(resolve,100))
  }
  throw new Error("ORIENTATION_VIEWER_NOT_READY: 指定窗口未在限定时间内显示本次导入的场景版本")
 }
 const beginOrientationCheck=async(agent:unknown,target:OrientationTarget,signal:AbortSignal)=>{
  const existing=orientationChecks.existing(target)
  if(existing)return existing
  const previous=orientationChecks.get(target.sessionKey)
  if(previous&&(previous.status==="queued"||previous.status==="checking"))cancelOrientation(agent,target.sessionKey,previous.checkId,"较新的导入已替代这次方向检查")
  const {face,created}=orientationChecks.begin(target)
  if(!created)return face
  const controller=new AbortController()
  orientationControllers.set(face.checkId,controller)
  const checkSignal=AbortSignal.any([signal,controller.signal])
  try{
   const clientId=await orientationClient(target,checkSignal)
   const current=await sceneFor(target.sessionKey).scene.snapshot(target.sceneId)
   checkSignal.throwIfAborted()
   if(current.revision!==target.revision||target.rootEntityIds.some(id=>!current.entities.some(entity=>entity.entityId===id)))throw new Error("ORIENTATION_SCENE_STALE: 导入目标或场景版本已变化")
   const outcome=await queueCaptureRequest({sessionKey:target.sessionKey,clientId,sceneId:target.sceneId,expectedRevision:target.revision,action:"captureViewer",expectSource:"native-viewer",timeoutError:"ORIENTATION_CAPTURE_TIMEOUT: 本次导入的窗口没有交回原生图像",abortError:"ORIENTATION_CAPTURE_ABORTED: 方向检查已取消",signal:checkSignal})
   if(!outcome.ok)throw new Error(outcome.error)
   const fresh=await sceneFor(target.sessionKey).scene.snapshot(target.sceneId)
   checkSignal.throwIfAborted()
   if(fresh.revision!==target.revision||outcome.capture.sceneId!==target.sceneId||outcome.capture.sceneRevision!==target.revision)throw new Error("ORIENTATION_IMAGE_STALE: 图像与当前导入身份不符")
   const checked=orientationChecks.initial(target.sessionKey,face.checkId,{sceneId:target.sceneId,sceneRevision:target.revision,clientId,captureId:outcome.capture.captureId,camera:outcome.capture.camera})
   const note=orientationPrompt(checked,outcome.capture.captureId,outcome.capture.camera)+((outcome.capture.visualWarnings??[]).length?` This Frame has ${outcome.capture.visualWarnings!.length} visual missing-content warnings; report uncertain if the image is incomplete.`:"")
   const message=createUserMessage({content:[{type:"text",text:note},{type:"image",attachment:outcome.attachment as never}] as ContentBlock[],source:{kind:"lyapunov-orientation",form:"notice",summary:"导入方向检查"}})
   const sender=agent as {send?:(message:unknown,kind:"next-step"|"next-turn",wake:boolean)=>unknown;status?:string}
   if(typeof sender.send!=="function")throw new Error("ORIENTATION_AGENT_SEND_UNAVAILABLE")
   // 采集是异步的：Stop 之后的迟到图绝不借 send(wakeup=true) 被自动改投 next-turn 复活任务。
   checkSignal.throwIfAborted()
   if(orientationChecks.get(target.sessionKey,face.checkId)?.status!=="queued")throw new Error("ORIENTATION_CHECK_SUPERSEDED")
   orientationChecks.queued(target.sessionKey,face.checkId,message.id)
   // 自然语言导入仍在同一回合时接下一 step；拖拽本来没有模型回合，才显式唤醒下一 turn。
   const inboxTarget=target.origin==="tool"&&sender.status==="running"?"next-step":"next-turn"
   sender.send(message as never,inboxTarget,true)
   return orientationChecks.get(target.sessionKey,face.checkId)??checked
  }catch(error){
   const message=error instanceof Error?error.message:String(error)
   return orientationChecks.unchecked(target.sessionKey,face.checkId,message.replace(/\/(?:home|tmp)\/[^\s]*/g,"<本机路径>"))
  }finally{orientationControllers.delete(face.checkId)}
 }
 ctx.on("agent/inbox/claimed",({agent,message,turn})=>{
  const source=message.source as {kind?:string;plugin?:string}
  try{
   const sessionKey=sessionKeyOf(agent)
   if(source.kind==="lyapunov-orientation"||source.kind==="plugin:lyapunov-orientation")orientationChecks.claimed(sessionKey,message.id,turn)
   else orientationChecks.claimedOther(sessionKey,turn,message.id,orientationTakesOver(message))
  }catch{/* 会话刚退出时的旧消息不改当前检查 */}
 })
 ctx.on("tools/result",(exec,result)=>{
  const agent=exec.agent
  if(!agent||result.isError)return
  let sessionKey:string
  try{sessionKey=sessionKeyOf(agent)}catch{return}
  if(exec.name==="viewer_observe"){
   const value=result.value as {sceneId?:unknown;sceneRevision?:unknown;clientId?:unknown;captureId?:unknown}
   if(result.content.some(block=>block.type==="image")&&typeof value.sceneId==="string"&&Number.isInteger(value.sceneRevision)&&typeof value.clientId==="string"&&typeof value.captureId==="string")orientationChecks.observed(sessionKey,{sceneId:value.sceneId,sceneRevision:value.sceneRevision as number,clientId:value.clientId,captureId:value.captureId})
   return
  }
  const target=importedVisualTarget(exec.name,result.value)
  if(!target)return
  void beginOrientationCheck(agent,{...target,sessionKey,origin:"tool"},exec.signal).catch(error=>ctx.logger.warn(`orientation check failed: ${error instanceof Error?error.message:String(error)}`))
 })
 /**
  * 排队一次相机应用并等读数（交付物是"应用后当场量到的相机"，不是图）。
  *
  * 相机请求**整块**放在 `args.camera` 里（各来源先在 `cameraRequestOf` 收成一个请求对象）：前端那侧
  * `cameraArgsOf(item)` 读的就是 `item.args.camera`，与 `viewer_observe` 带相机时是同一个键。
  * 曾经把请求字段平铺进 `args`，于是"扁平给 position/quaternion"这条路径到了前端就成了"没给相机"
  * （`VIEWER_CAMERA_REQUEST_REQUIRED`）——定向测试的闭环把它抓了出来；这里不再留第二种传输形状。
  */
 const queueCameraApply=async(input:{sessionKey:string;clientId:string;sceneId:string;expectedRevision:number;args:Record<string,unknown>;signal:AbortSignal;action?:'applyCameraViewer'|'sampleCameraViewer'}):Promise<CameraApplySettlement>=>{
  const observeId=randomUUID()
  const settled=new Promise<CameraApplySettlement>(resolve=>{
   const timer=setTimeout(()=>{dropObservation(observeId,input.sessionKey,`VIEWER_CAMERA_TIMEOUT: 等了 ${String(Math.round(OBSERVE_TIMEOUT_MS/1000))} 秒没有等到窗口 ${input.clientId} 的相机回执（该窗口在轮询、但这次应用没有完成：可能标签页在后台、场景正在加载、或窗口里的 Viewer 不支持相机接口）。没有重试；可稍后重试。`)},OBSERVE_TIMEOUT_MS)
   observeWaiters.set(observeId,{kind:"camera",sessionKey:input.sessionKey,clientId:input.clientId,sceneId:input.sceneId,expectedRevision:input.expectedRevision,timer,settle:resolve})
  })
  uiActionQueue.set(input.sessionKey,[...uiActionQueue.get(input.sessionKey)??[],{id:observeId,action:input.action??"applyCameraViewer",args:{clientId:input.clientId,sceneId:input.sceneId,expectedRevision:input.expectedRevision,...input.args},enqueuedAt:new Date().toISOString()}].slice(-20))
  const abort=()=>dropObservation(observeId,input.sessionKey,"VIEWER_CAMERA_ABORTED: 应用相机已取消（调用方中止）")
  input.signal.addEventListener("abort",abort,{once:true})
  try{return await settled}finally{input.signal.removeEventListener("abort",abort);dropObservation(observeId,input.sessionKey)}
 }
 /**
  * 排队一次**指定资源打开**（`ui_action` 的 `openResource`）并等前端的真实打开确认。
  *
  * 与采集/相机共用同一张等待表：同一套超时（`OBSERVE_TIMEOUT_MS`）、取消、落队与"被指定窗口
  * 才能下结论"的归属判据。差别只有交付物——这里没有图/相机读数，等的是
  * `{opened:true, visible:true, address, kind, target, path}` 这份**前端实际打开**的回执。
  * 打开与 `openFiles`/`openTerminal` 同级：改页面级工作面，后台窗口 defer、不确认，等它到前台再执行。
  */
 const queueResourceOpen=async(input:{sessionKey:string;clientId:string;path:string;target:"preview"|"source";expectation:OpenExpectation;signal:AbortSignal}):Promise<OpenSettlement>=>{
  const openId=randomUUID()
  const settled=new Promise<OpenSettlement>(resolve=>{
   const timer=setTimeout(()=>{dropObservation(openId,input.sessionKey,`UI_ACTION_OPEN_TIMEOUT: 等了 ${String(Math.round(OBSERVE_TIMEOUT_MS/1000))} 秒没有等到窗口 ${input.clientId} 的打开确认（该窗口在轮询、但这次打开没有完成：可能标签页在后台、目标窗口不是前台、或资源地址打不开）。没有重试；可稍后重试。`)},OBSERVE_TIMEOUT_MS)
   observeWaiters.set(openId,{kind:"open",sessionKey:input.sessionKey,clientId:input.clientId,expectation:input.expectation,timer,settle:resolve})
  })
  uiActionQueue.set(input.sessionKey,[...uiActionQueue.get(input.sessionKey)??[],{id:openId,action:"openResource",args:{clientId:input.clientId,path:input.path,target:input.target},enqueuedAt:new Date().toISOString()}].slice(-20))
  const abort=()=>dropObservation(openId,input.sessionKey,"UI_ACTION_OPEN_ABORTED: 打开资源已取消（调用方中止）")
  input.signal.addEventListener("abort",abort,{once:true})
  try{return await settled}finally{input.signal.removeEventListener("abort",abort);dropObservation(openId,input.sessionKey)}
 }
 /**
  * 模型侧读取入口：用户在工作台里落的那批批注（图 + 逐条编号/文字/锚点）就是从这里回到模型的。
  *
  * 为什么按场景取、而不是让模型自己猜 captureId：用户点完批注后通常只会说"看第 2 条"，
  * 模型没有别的办法把"第 2 条"对上；这里按当前选择（或指定场景）取回最近一次带批注的采集，
  * 编号、文字与截图里的圈点**同源**（编号由客户端一次生成，三处共用）。
  * 图以真实附件提交，模型看得见圈点在哪；文字与锚点同时给全，便于它继续用 scene/sim 域工具精确操作。
  */
 /**
  * 把一批批注的**结构化说明直接送进当前会话**（用户点"截图并发给模型"时由界面发起）。
  *
  * 为什么直接插进对话而不是只等模型来读：Codex 那类标注的用法是"标注完就把 xy 在哪、什么问题一起给模型"，
  * 用户不需要再打一句"看一下我刚标的图"。这里把同一份说明作为一条用户消息投递（source.kind 标成界面来源，
  * 会话里能看出它不是人打的字），模型下一轮自然带上它；同时它也是可见的，用户能核对到底送了什么。
  */
 const feedbackWindow=(sessionKey:string,sceneId:string,revision:number,clientId?:unknown):string=>{
  if(clientId!==undefined&&(typeof clientId!=="string"||!clientId))throw new Error("CAPTURE_FEEDBACK_CLIENT_INVALID")
  const target=observeTargetClient(sessionKey,{sceneId,expectedRevision:revision,...clientId?{clientId:clientId as string}:{}})
  const live=liveObserveClients(sessionKey).find(([id])=>id===target)?.[1]
  if(live?.sceneId!==sceneId||live.revision!==revision)throw new Error("CAPTURE_FEEDBACK_WINDOW_STALE")
  return target
 }
 const feedbackMessage=async(capture:FeedbackCapture,sessionKey:string,clientId:string,signal:AbortSignal)=>{
  const snapshot=await sceneSnapshot(sessionKey,capture.sceneId)
  requireCaptureFeedbackOwner(capture,{sessionKey,clientId,sceneId:snapshot.sceneId,revision:snapshot.revision})
  // Resolve the saved object, never a browser-provided path or replacement image.
  await ctx.attachments.readImage(capture.attachment as ImageAttachmentRef)
  signal.throwIfAborted()
  const freshSnapshot=await sceneSnapshot(sessionKey,capture.sceneId)
  requireCaptureFeedbackOwner(capture,{sessionKey,clientId,sceneId:freshSnapshot.sceneId,revision:freshSnapshot.revision})
  feedbackWindow(sessionKey,capture.sceneId,capture.sceneRevision,clientId)
  return createUserMessage({content:captureFeedbackContent(capture),source:{kind:"lyapunov-annotation"} as never})
 }
 ctx.commands.register({name:"viewer_annotation_send_ui",description:"Send the real image, annotations, coordinates, camera, and scene version from a saved capture to its original session. Specify captureId and the original window clientId.",input:{hint:'{sessionId, captureId, clientId, prompt?}'},recordInput:false,handler:async invocation=>{
  const input=JSON.parse(invocation.rawInput||"{}") as {sessionId?:string;captureId?:string;clientId?:string;prompt?:string}
  if(typeof input.sessionId!=="string"||!input.sessionId)throw new Error("ANNOTATION_SESSION_REQUIRED")
  const sessionKey=sessionKeyOf(invocation.agent)
  const target=await bindSessionId(ctx,input.sessionId,"批注投递")
  if(target!==sessionKey)throw new Error(`ANNOTATION_SESSION_MISMATCH: 投递目标 ${target} 不是本次调用所在的会话 ${sessionKey}`)
  if(typeof input.captureId!=="string"||!input.captureId)throw new Error("ANNOTATION_CAPTURE_REQUIRED: 需要已保存的 captureId；不把纯文字冒充图像反馈")
  if(typeof input.clientId!=="string"||!input.clientId)throw new Error("ANNOTATION_CLIENT_REQUIRED")
  const capture=await readCapture(sessionKey,input.captureId) as FeedbackCapture
  if(input.prompt!==undefined&&input.prompt!==capture.prompt)throw new Error("ANNOTATION_PROMPT_MISMATCH: 说明必须与已保存采集一致")
  const message=await feedbackMessage(capture,sessionKey,input.clientId,invocation.signal)
  invocation.agent.send(message as never,"next-turn",true)
  return {kind:"success",text:JSON.stringify({injected:true,messageId:message.id,captureId:capture.captureId,targetSession:sessionKey})}
 }})
 ctx.tools.register(defineTool({
  name:"viewer_annotation_read",
  description:"Read the user's 3D viewport annotations, numbered image, annotationId/captureId, text, entity-local and world coordinates, surface normal, and Scene/world/generation/frame provenance. A robot anchor includes bodyName/body-local point and normal only when an actual hit and same-frame native FK established them. Use that body with camera_scene_save mode=install; never infer a link, center or TCP from a model name. By default read the latest annotated capture for the selected scene. If absent return found=false.",
  parameters:{input:{type:"object",required:true,additionalProperties:false,description:"Annotation read request.",properties:{sceneId:{type:"string",description:"Optional scene; defaults to the scene in the current selection."}}}},
  output:{schema:{type:"json"},render:(_args,value)=>{
   const {__annotationImage,...visible}=(value??{}) as Record<string,unknown>
   const blocks:ContentBlock[]=[{type:"text",text:JSON.stringify(visible)}]
   if(__annotationImage)blocks.push({type:"image",attachment:__annotationImage as never})
   return blocks
  }},
  execute:async(args,exec)=>{
   const input=(args.input??args) as {sceneId?:string}
   const selection=selectionIdentity((exec as {agent?:unknown}).agent)
   const sceneId=input.sceneId??selection?.sceneId
   if(!sceneId)throw new Error("ANNOTATION_SCENE_REQUIRED: 指定 sceneId，或先在工作台里选中一个场景")
   // 批注只从**本会话**的采集命名空间读：别的会话落在同名场景上的批注不属于这次调用。
   const captures=(await listCaptures(sessionKeyOf((exec as {agent?:unknown}).agent),sceneId)).filter(capture=>Array.isArray(capture.annotations)&&capture.annotations.length>0)
   const latest=captures[0]
   if(!latest)return {found:false,sceneId,hint:"This scene has no annotated capture. Ask the user to open the annotations panel, start annotating, select a point on an object surface in the 3D viewport, enter a note, and send the captured image to the model."}
   const image=await readFile(latest.imagePath).catch(()=>undefined)
   const attachment=image?await ctx.attachments.saveImage({data:image,mediaType:"image/png",name:"场景批注.png"}).catch(()=>undefined):undefined
   // 说明是给模型看的正本（含每条 xy/归一化/实体/局部坐标 + 相机位姿）：有它就原样回传，
   // 没有（旧采集）就由锚点现拼一份，模型不必自己从像素里猜。
   const prompt=typeof (latest as {prompt?:unknown}).prompt==="string"&&(latest as {prompt:string}).prompt.trim()
     ? (latest as {prompt:string}).prompt
     : ["【3D 视口批注】", ...(latest.annotations??[]).map(row=>`第 ${String(row.index)} 条：${row.text.trim()||"（未填写说明）"}；位置=${row.entity??row.entityId}（entityId ${row.entityId}）；实体局部坐标=(${row.anchor.local.map(value=>value.toFixed(3)).join(", ")}) m`)].join("\n")
   return {found:true,sceneId,sceneRevision:latest.sceneRevision,captureId:latest.captureId,capturedAt:latest.capturedAt,prompt,imagePath:latest.imagePath,pose:derivedPose(latest),...originalFrameNote(latest),...latest.worldId?{worldId:latest.worldId,generation:latest.generation,frameId:latest.frameId,stepIndex:latest.stepIndex}:{},image:{attached:Boolean(attachment),...(attachment?captureImageFace(attachment,latest):{path:latest.imagePath,reason:"The image is unavailable; annotation coordinates and notes are still returned."})},annotations:latest.annotations!.map(row=>({index:row.index,annotationId:row.annotationId,entity:row.entity??row.entityId,entityId:row.entityId,text:row.text,anchorLocalM:row.anchor.local,anchorWorldM:row.anchor.world,normalWorld:row.anchor.normal,sceneId:row.anchor.sceneId,sceneRevision:row.anchor.sceneRevision,body:row.anchor.body})),note:"Numbers match the image marks. body.localM and body.normalLocal are fixed in the identified native body; a missing body anchor requires a new same-frame surface annotation or explicit body-local position.",...attachment?{__annotationImage:attachment}:{}} as any
  },
 }))
ctx.tools.register(defineTool({
  name:"ui_action",
  description:"Control the Lyapunov workbench interface. openTool opens a panel; openFiles/openTerminal/showCanvas switch the working surface. openResource takes path and target=preview|source and returns after a window in the current session actually displays that file. selectEntity selects an object. focus frames it from outside; enterSceneCenter moves the camera to a robust center of the subject. Neither moves the model or requires traversing the raw 3DGS bbox. selectScene switches to an existing scene. aimCameraView enters the actual cameraId (or Scene camera entityId) at its locked installation origin for orientation/FOV editing while retaining body FK. exitCameraView discards a pending installation draft and restores the main view. locateTcp/locateBase open the robot panel and show current native markers; if readback is missing, provide the real configuration entry. Change model position with the complete transform in scene_edit. Except for openResource, acknowledgement only establishes that an action was queued; verify the displayed result with viewer_observe.",
  parameters:{input:{type:"object",required:true,additionalProperties:false,description:"Interface action.",properties:{action:{type:"string",enum:[...uiActionNames],description:"Action name."},tool:{type:"string",enum:["scene","environment","robot","object","camera","asset","annotation"],description:"Target panel for openTool."},cameraId:{type:"string",description:"Exact current camera_list cameraName or Scene rig key for aimCameraView; never infer a camera name."},entityId:{type:"string",description:"Target entity for selectEntity/focus/enterSceneCenter/locateTcp/locateBase/aimCameraView. Without one, focus frames the whole scene and enterSceneCenter uses the current scene subject center."},sceneId:{type:"string",description:"Target scene ID for selectScene; it must exist in the scene list."},path:{type:"string",description:"File path for openResource, relative to the current session workspace or an absolute path inside that workspace."},target:{type:"string",enum:["preview","source"],description:"openResource mode: preview displays a page/model (default); source opens the source editor, including explicit source editing for HTML."},clientId:{type:"string",description:"Optional target window to disambiguate multiple windows. Otherwise use the active, most recently operated window; resolve automatically only when one window is present or only one displays this scene."}}}},
  output:{schema:{type:"json"},render:(_args,value)=>[{type:"text",text:uiActionModelText(value)}]},
  execute:async(args,exec)=>{
   const input=(args.input??args) as {action?:string;tool?:string;entityId?:string;sceneId?:string;clientId?:string;path?:string;target?:string;cameraId?:string}
   if(!input.action||!(uiActionNames as readonly string[]).includes(input.action))throw new Error("UI_ACTION_INVALID")
   if(input.action==="openTool"&&!input.tool)throw new Error("UI_ACTION_TOOL_REQUIRED")
   if(['selectEntity','locateTcp','locateBase'].includes(input.action)&&!input.entityId)throw new Error("UI_ACTION_ENTITY_REQUIRED")
   if(input.action==='aimCameraView'&&!input.entityId&&!input.cameraId)throw new Error('UI_ACTION_CAMERA_REQUIRED')
   if(input.clientId!==undefined&&(typeof input.clientId!=="string"||!input.clientId))throw new Error("UI_ACTION_CLIENT_INVALID: clientId 应为非空字符串")
   const key=sessionKeyOf((exec as {agent?:unknown}).agent)
   if(input.action==="selectScene"){
    if(!input.sceneId)throw new Error("UI_ACTION_SCENE_REQUIRED")
    // 场景清单与用户下拉框、`state/scenes` 路由同一份来源（本会话的 `scene.list()`），不另建状态接口；
    // 清单是**本会话**的：别的会话有同名场景不代表这里有。
    const known=await sceneFor(key).list()
    if(!known.some(item=>item.sceneId===input.sceneId)&&!await officialSceneFor(key,input.sceneId))throw new Error(`UI_ACTION_SCENE_UNKNOWN: 场景清单里没有 ${input.sceneId}（现有：${known.map(item=>item.sceneId).join("、")||"无"}）。先看场景清单，或先用 scene_open/scene_create 把它建出来。`)
   }
   // 目标窗口在**排队时**定下来：显式 clientId > 活动窗口 > 唯一在场窗口/唯一显示该场景的窗口。
   // 采集/相机对每个窗口可见（非目标看得见但不执行）；其余定向动作只投给目标窗口。
   const scope=scopeOf((exec as {agent?:{ctx?:unknown}}).agent?.ctx as Parameters<typeof scopeOf>[0])
   const target=uiActionTarget(key,scope,{...input.clientId?{clientId:input.clientId}:{},...input.sceneId?{sceneId:input.sceneId}:{}})
   if(isCameraNavigationAction(input.action)&&!target)throw new Error('UI_ACTION_CAMERA_WINDOW_REQUIRED: 相机退出/标记定位需要本会话唯一或明确指定的现存窗口；不能排入无归属窗口')
   if(input.action==="openResource"){
    // 指定资源打开是**等待型**动作：回执来自前端窗口真实的 opened/visible **与真实激活标签的
    // address/kind**（不是"已排队"，也不是把请求参数抄回来）。目标窗口歧义/无窗口一律拒绝
    // （与 viewer_observe 同一口径），不随便挑一个窗口打开。
    if(typeof input.path!=="string"||!input.path.trim())throw new Error("UI_ACTION_PATH_REQUIRED: openResource 需要 path（当前任务工作区里的文件路径）")
    if(input.target!==undefined&&input.target!=="preview"&&input.target!=="source")throw new Error("UI_ACTION_TARGET_INVALID: target 只能是 preview 或 source")
    const openTarget:"preview"|"source"=input.target==="source"?"source":"preview"
    const openPath=input.path.trim()
    if(!target)throw new Error(`UI_ACTION_OPEN_TARGET_AMBIGUOUS: 无法确定由哪个窗口打开（该会话没有活动窗口，或有多个活动窗口且没有唯一活动选择）；请带 clientId 指定目标窗口：${liveObserveClients(key).map(([clientId])=>clientId.slice(0,8)).join("、")||"无"}`)
    if(exec.signal.aborted)throw new Error("UI_ACTION_OPEN_ABORTED: 打开请求在排队前已被取消")
    // 宿主独立算出期望的规范资源地址（与前端同一个 fileAddressFor、同一个会话 cwd）：前端回的 address
    // 必须与它一致才算"打开的是被请求的文件"；kind 由打开方式决定（source 点名，preview 排除源码编辑器）。
    const cwd=(exec as {agent?:{session?:{header?:{cwd?:string}}}}).agent?.session?.header?.cwd
    const expectation=openExpectationFor({path:openPath,target:openTarget,address:fileAddressFor(key,cwd,openPath)})
    const outcome=await queueResourceOpen({sessionKey:key,clientId:target,path:openPath,target:openTarget,expectation,signal:exec.signal})
    if(!outcome.ok)throw new Error(outcome.error)
    return {opened:true,action:"openResource",path:openPath,target:openTarget,expectation:{address:expectation.address,kind:expectation.expectedKind??null,...(expectation.forbiddenKind?{forbiddenKind:expectation.forbiddenKind}:{})},...outcome.value}
   }
   const entry:UiAction={id:randomUUID(),action:input.action,args:{...target?{clientId:target}:{},...input.tool?{tool:input.tool}:{},...input.entityId?{entityId:input.entityId}:{},...input.cameraId?{cameraId:input.cameraId}:{},...input.sceneId?{sceneId:input.sceneId}:{}},enqueuedAt:new Date().toISOString()}
   uiActionQueue.set(key,[...uiActionQueue.get(key)??[],entry].slice(-20))
   return {queued:entry.id,action:entry.action,...target?{target}:{},...input.action==="selectScene"?{note:"这条回执只表示动作已排进本会话的界面动作队列,不代表任何窗口已经切换或已经显示该场景;窗口真的切过去、资源也加载完成的证据,用 viewer_observe(sceneId + expectedRevision)按原生采集核对。"}:{}}
  },
 }))
 /**
  * 主动观察（模型侧入口）：**不是让模型传图，而是让它正在看的那个窗口现在拍一张**。
  *
  * 与 `ui_action` 共用同一条按会话键控的队列、同一套前端轮询取走/确认流程，以及同一个
  * `viewer_capture` 落盘与来源校验实现；本工具只做三件事：核对宿主里这个 revision 真实存在、
  * 选定目标窗口（歧义就拒绝）、等到那张图并核对它确实来自该窗口的该版本。
  * 失败一律是明确的错误码：无窗口 / 目标不唯一 / 窗口没关着这场景 / 版本过期 / 超时 / 取消。
  */
 ctx.tools.register(defineTool({
  name:"viewer_observe",
  description:"Request a real capture from a running native 3D workbench window in this session, using its current view, and return it as a native image attachment with camera pose and scene revision. sceneId and expectedRevision are required; the target window must already display that exact scene version. A capture from another revision fails. clientId is optional only when the active window is unambiguous or exactly one window displays the target version. Missing windows, an unloaded scene, timeout, and cancellation have explicit errors; Blender previews and old images are not native Viewer captures. Optionally apply a specified camera (a camera_fit camera block, or position/quaternion/target/up/fovYDeg/intrinsics) or a camera name saved by that window before capturing the current canvas. The result remains the displayed frame with source=native-viewer and includes the measured camera after application. Use viewer_render_camera to render from a specified camera at a specified pixel size.",
  parameters:{input:{type:"object",required:true,additionalProperties:false,description:"Observation request.",properties:{sceneId:{type:"string",description:"Target scene ID."},expectedRevision:{type:"integer",description:"Target scene document revision, a nonnegative integer; the window must already have this version loaded."},clientId:{type:"string",description:"Optional target window for disambiguation."},camera:{type:"object",additionalProperties:true,description:"Optional camera to apply before capture. Accepts the camera_fit camera block unchanged (worldFromCamera + viewer), or {position,quaternion,target,up,cameraUp,fovYDeg,near,far,intrinsics}. Omit to capture the current view."},name:{type:"string",description:"Optional named camera saved by this window for this scene; mutually exclusive with camera."}}}},
  output:{schema:{type:"json"},render:(_args,value)=>{
   const {__observeImage,...visible}=(value??{}) as Record<string,unknown>
   const blocks:ContentBlock[]=[{type:"text",text:JSON.stringify(visible)}]
   if(__observeImage)blocks.push({type:"image",attachment:__observeImage as never})
   return blocks
  }},
  execute:async(args,exec)=>{
   const input=(args.input??args) as {sceneId?:string;expectedRevision?:number;clientId?:string;camera?:unknown;name?:unknown}
   if(typeof input.sceneId!=="string"||!input.sceneId)throw new Error("VIEWER_OBSERVE_SCENE_REQUIRED: 指定 sceneId")
   if(!Number.isInteger(input.expectedRevision)||(input.expectedRevision as number)<0)throw new Error("VIEWER_OBSERVE_REVISION_REQUIRED: 指定 expectedRevision（场景文档版本）")
   if(input.clientId!==undefined&&(typeof input.clientId!=="string"||!input.clientId))throw new Error("VIEWER_OBSERVE_CLIENT_INVALID: clientId 应为非空字符串")
   const sceneId=input.sceneId,expectedRevision=input.expectedRevision as number
   const sessionKey=sessionKeyOf((exec as {agent?:unknown}).agent)
   if(exec.signal.aborted)throw new Error("VIEWER_OBSERVE_ABORTED: 观察在排队前已被取消")
   // 先与**本会话**宿主里的当前场景对齐：不存在的 revision 当场失败，不必白等一轮前端。
   const snapshot=await sceneSnapshot(sessionKey,sceneId)
   // 这一等之后必须再核对一次：取消可能就发生在等快照期间，而下面的 abort 监听还没登记——那一次 abort 事件
   // 已经过去了，没人接，于是排队、登记等待者，一路白等满 15 秒才回一个"窗口没服务"的超时（P2-1）。
   if(exec.signal.aborted)throw new Error("VIEWER_OBSERVE_ABORTED: 观察在等场景快照期间已被取消")
   if(expectedRevision>snapshot.revision)throw new Error(`VIEWER_OBSERVE_REVISION_UNKNOWN: 场景 ${sceneId} 当前是 rev ${String(snapshot.revision)}，没有 rev ${String(expectedRevision)}`)
   const clientId=observeTargetClient(sessionKey,{sceneId,expectedRevision,...input.clientId?{clientId:input.clientId}:{}})
   // 带相机的那条：先摆相机再拍**当前画布**（拍法一字未改，只是相机换了）。
   // 请求形状先按 Viewer 侧同一份纯函数预检——矛盾/不可能摆的请求在这里就返回，不必白等一轮前端。
   const namedCamera=nameOf(input.name,"name")
   const cameraArgs:Record<string,unknown>={...(input.camera===undefined?{}:{camera:input.camera}),...(namedCamera?{name:namedCamera}:{})}
   if(input.camera!==undefined)requireCameraRequest({camera:input.camera})
   const outcome=await queueCaptureRequest({sessionKey,clientId,sceneId,expectedRevision,action:"captureViewer",
    ...Object.keys(cameraArgs).length?{args:cameraArgs}:{},
    timeoutError:`VIEWER_OBSERVE_TIMEOUT: 等了 ${String(Math.round(OBSERVE_TIMEOUT_MS/1000))} 秒没有等到窗口 ${clientId} 的截图（该窗口在轮询、但这次采集没有完成：可能标签页在后台、场景正在加载、或截图/回传失败）。未发起第二次采集；可稍后重试。`,
    abortError:"VIEWER_OBSERVE_ABORTED: 观察已取消（调用方中止）",signal:exec.signal})
   if(!outcome.ok)throw new Error(outcome.error)
   const capture=outcome.capture,image=outcome.attachment
   // 相机位姿整键省掉而不是置 undefined：工具返回值必须是无损 JSON，一个 undefined 值会让**整次观察**
   // 变成"invalid output"（图也拿不到）。原生 capture() 总是带 camera；这里兼容不带相机的最小载荷。
   const camera=capture.camera??derivedPose(capture)
   // 画面**可用但缺件**（机器人缺网格/关节缺 link 这类）：图照给，但必须显式说清"不完整、少了什么"，
   // 不能默默冒充完整场景——也不能反过来拒拍（那是有缺件的机器人场景永远拍不到的原因，P1-1）。
   // 警告与这张图同一版本：它随采集载荷一路带过来，读的就是采集那一刻该窗口的物体表（rev 已在采集时核对）。
   const visualWarnings=capture.visualWarnings??[]
   // 带 camera 请求的那次观察：拍之前应用的那台相机（应用后量到的读数）随结果回传——
   // 于是"这张画布截图是哪台相机拍的"有据可查，来源仍然是 native-viewer（**没有**变成相机渲染图）。
   const appliedCamera=(capture as CaptureRecord&CaptureCameraExtras).cameraApply
   // 这一帧的**环境光照事实**（随采集载荷一路带过来的窄面，见 environment-capture.ts）：请求的 HDRI 没装上时，
   // 回执要如实说明"IBL 是内置光/另一份 HDRI"，不能让一张缺环境光的图看起来像完整配置。
   // 这一帧的 **LOD 级别事实**（随采集载荷一路带过来的窄面，见 lod-capture.ts）：正常按距离用上的简化件
   // 不是故障，但回执必须说清"这张图用的是哪一级、哪份资源版本"；只有比该用的更粗/没读进来才写成降级。
   const lod=capture.lod
   const lodNote=lodFaceNote(lod)
   const environment=capture.environment
   const environmentNote=environmentFaceNote(environment)
   const baseNote="这张图来自目标窗口的原生 Viewer（Three/Spark 画布），不是 Blender 或其它渲染；sceneRevision 就是采集时该窗口加载的文档版本。"
   return {source:captureSourceOf(capture as CaptureRecord&CaptureCameraExtras),sceneId:capture.sceneId,sceneRevision:capture.sceneRevision,expectedRevision,clientId,captureId:capture.captureId,capturedAt:capture.capturedAt,imagePath:capture.imagePath,image:captureImageFace(image,capture),...originalFrameNote(capture),...camera?{camera}:{},...appliedCamera?{appliedCamera}:{},...appliedCamera?{cameraNote:"这次观察在拍之前先把请求的相机摆到了这个窗口上；拍到的仍是**当前画布**（source=native-viewer，不是按相机渲染出的图），appliedCamera 是应用后当场量到的读数。"}:{},...(capture.worldId?{worldId:capture.worldId,generation:capture.generation,worldSceneRevision:capture.worldSceneRevision,frameSceneRevision:capture.frameSceneRevision,frameId:capture.frameId,stepIndex:capture.stepIndex,simTime:capture.simTime}:{}),...(environment?{environment}:{}),...(lod?{lod}:{}),...visualWarnings.length?{partial:true,visualWarnings,note:`${baseNote}注意：画面**可用但不完整**——有 ${String(visualWarnings.length)} 处部件没加载出来（见 visualWarnings，涉及实体 ${[...new Set(visualWarnings.map(row=>row.entityId))].join("、")}），这些部件不在画面里；这不是加载失败，剩下的场景是真实渲染出来的，但别把这张图当成完整场景。${environmentNote??""}${lodNote??""}`}:{note:`${baseNote}${environmentNote??""}${lodNote??""}`},__observeImage:image} as any
  },
 }))
 /** 拖拽等无模型回合的入口：只提交本会话已挂载的视觉实体身份，真正截图和下一轮图像消息由上方共用入口完成。 */
 ctx.commands.register({name:"viewer_orientation_check_ui",description:"Start one native image orientation check after this window imports a visual resource, limited to the target Scene and imported entity in this session.",input:{hint:'{sessionId,clientId,sceneId,revision,rootEntityIds}'},recordInput:false,handler:async invocation=>{
  const input=JSON.parse(invocation.rawInput||"{}") as {sessionId?:unknown;clientId?:unknown;sceneId?:unknown;revision?:unknown;rootEntityIds?:unknown}
  if(typeof input.sessionId!=="string"||typeof input.clientId!=="string"||!input.clientId||typeof input.sceneId!=="string"||!Number.isInteger(input.revision)||!Array.isArray(input.rootEntityIds)||!input.rootEntityIds.length||input.rootEntityIds.some(id=>typeof id!=="string"||!id))throw new Error("ORIENTATION_UI_INPUT_INVALID")
  const sessionKey=sessionKeyOf(invocation.agent),bound=await bindSessionId(ctx,input.sessionId,"方向检查投递")
  if(bound!==sessionKey)throw new Error("ORIENTATION_SESSION_MISMATCH")
  const snapshot=await sceneFor(sessionKey).scene.snapshot(input.sceneId)
  if(snapshot.revision!==input.revision)throw new Error("ORIENTATION_SCENE_STALE: 导入后场景版本已变化")
  const roots=input.rootEntityIds as string[]
  if(roots.some(id=>{const entity=snapshot.entities.find(row=>row.entityId===id);return !entity||!["mesh","splat","group"].includes(String(entity.components.visual?.kind))}))throw new Error("ORIENTATION_TARGET_NOT_VISUAL_IMPORT")
  const owner=invocation.agent as {status?:string;runMaintenance?:<T>(job:(signal:AbortSignal)=>Promise<T>)=>Promise<T>}
  const target:OrientationTarget={sessionKey,sceneId:input.sceneId,revision:input.revision as number,clientId:input.clientId,rootEntityIds:roots,origin:"ui"}
  const duplicate=orientationChecks.existing(target)
  if(duplicate)return {kind:"success",text:JSON.stringify(duplicate)}
  // HTTP 请求的 signal 不是 Agent Stop。空闲 Agent 用原生 maintenance 承接，让用户 Stop 能取消待图；
  // 若已有活动回合，只使用该回合 pre-step 的真实 abort signal，不脱离原任务另排一个自动回合。
 const face=owner.status==="running"
   ?await (async()=>{const active=activeTurnSignals.get(invocation.agent as object);if(!active)throw new Error("ORIENTATION_ACTIVE_SIGNAL_UNAVAILABLE");return beginOrientationCheck(invocation.agent,target,AbortSignal.any([active,invocation.signal]))})()
   :await (async()=>{if(typeof owner.runMaintenance!=="function")throw new Error("ORIENTATION_MAINTENANCE_UNAVAILABLE");return owner.runMaintenance(signal=>beginOrientationCheck(invocation.agent,target,AbortSignal.any([signal,invocation.signal])))})()
  return {kind:"success",text:JSON.stringify(face)}
 }})
 /** 工作台等待原生截图时也能停止；只撤本次检查和它自己的 Inbox 图片，不取消其它会话任务。 */
 ctx.commands.register({name:"viewer_orientation_stop_ui",description:"Stop this window's automatic orientation check for this import.",input:{hint:'{sessionId,sceneId,revision,checkId?}'},recordInput:false,handler:async invocation=>{
  const input=JSON.parse(invocation.rawInput||"{}") as {sessionId?:unknown;sceneId?:unknown;revision?:unknown;checkId?:unknown}
  if(typeof input.sessionId!=="string"||typeof input.sceneId!=="string"||!Number.isInteger(input.revision)||input.checkId!==undefined&&typeof input.checkId!=="string")throw new Error("ORIENTATION_STOP_INPUT_INVALID")
  const sessionKey=sessionKeyOf(invocation.agent),bound=await bindSessionId(ctx,input.sessionId,"停止方向检查")
  if(bound!==sessionKey)throw new Error("ORIENTATION_SESSION_MISMATCH")
  const face=orientationChecks.get(sessionKey,input.checkId as string|undefined)
  if(!face||face.sceneId!==input.sceneId||input.checkId===undefined&&face.sceneRevision!==input.revision)throw new Error("ORIENTATION_CHECK_STALE")
  return {kind:"success",text:JSON.stringify(stopOrientationTurn(invocation.agent,sessionKey,face.checkId))}
 }})
 /** 模型看过真图后只允许改这次导入根或本窗口相机；一次修正算一次尝试。 */
 ctx.tools.register(defineTool({
  name:"viewer_orientation_adjust",
  description:"Correct orientation only when a real image from the automatic check provides clear evidence. kind=asset sets a new absolute xyzw quaternion for the single imported root entity; first read the current value with scene_inspect and preserve position/scale. kind=camera uses native camera application in the target window. At most two corrections are allowed. Read a new image with viewer_observe before reporting the result.",
  parameters:{input:{type:"object",required:true,additionalProperties:false,description:"Orientation correction.",properties:{checkId:{type:"string"},kind:{oneOf:[{type:"string",const:"asset"},{type:"string",const:"camera"}]},expectedRevision:{type:"integer"},quaternion:{type:"array",items:{type:"number"}},camera:{type:"object",additionalProperties:true}}}},
  output:{schema:{type:"json"},render:(_args,value)=>[{type:"text",text:JSON.stringify(value)}]},
  execute:async(args,exec)=>{
   const input=(args.input??args) as {checkId?:unknown;kind?:unknown;expectedRevision?:unknown;quaternion?:unknown;camera?:unknown}
   const sessionKey=sessionKeyOf(exec.agent)
   if(typeof input.checkId!=="string"||(input.kind!=="asset"&&input.kind!=="camera")||!Number.isInteger(input.expectedRevision))throw new Error("ORIENTATION_ADJUST_INPUT_INVALID")
   const face=orientationChecks.get(sessionKey,input.checkId)
   if(!face||face.status!=="checking"||face.sceneRevision!==input.expectedRevision)throw new Error("ORIENTATION_CHECK_STALE")
   if(input.kind==="asset"){
    requireWritableScene(ctx,exec.agent,"方向检查修正")
    if(face.rootEntityIds.length!==1)throw new Error("ORIENTATION_TARGET_AMBIGUOUS: 多个独立根不能逐个猜方向")
    const q=input.quaternion
    if(!Array.isArray(q)||q.length!==4||!q.every(value=>typeof value==="number"&&Number.isFinite(value))||Math.abs(Math.hypot(...q)-1)>0.01)throw new Error("ORIENTATION_QUATERNION_INVALID: 需要单位 xyzw 四元数")
    const snapshot=await sceneFor(sessionKey).scene.snapshot(face.sceneId)
    if(snapshot.revision!==face.sceneRevision)throw new Error("ORIENTATION_SCENE_STALE")
    const root=snapshot.entities.find(entity=>entity.entityId===face.rootEntityIds[0])
    if(!root||!["mesh","splat","group"].includes(String(root.components.visual?.kind)))throw new Error("ORIENTATION_TARGET_NOT_VISUAL_IMPORT")
    if(q.every((value,index)=>Math.abs(value-root.transform.quaternion[index]!)<1e-6))throw new Error("ORIENTATION_NO_CHANGE: 根姿态未变化；若图像已正立请报 correct")
    requireOrientationWindow(sessionKey,face)
    orientationChecks.reserveAdjustment(sessionKey,input.checkId,"asset")
    exec.signal.throwIfAborted()
    const next=await sceneFor(sessionKey).scene.commit({sceneId:face.sceneId,expectedRevision:face.sceneRevision,patch:[{op:"update",entityId:root.entityId,changes:{transform:{...root.transform,quaternion:q as [number,number,number,number]}}}]})
    orientationChecks.applied(sessionKey,input.checkId,"asset",next.revision)
    return {checkId:input.checkId,kind:"asset",sceneId:face.sceneId,sceneRevision:next.revision,entityId:root.entityId,status:"checking"} as any
   }
   if(!input.camera||typeof input.camera!=="object")throw new Error("ORIENTATION_CAMERA_REQUEST_INVALID")
   const clientId=requireOrientationWindow(sessionKey,face)
   requireCameraRequest({camera:input.camera})
   orientationChecks.reserveAdjustment(sessionKey,input.checkId,"camera")
   const outcome=await queueCameraApply({sessionKey,clientId,sceneId:face.sceneId,expectedRevision:face.sceneRevision,args:{camera:input.camera as Record<string,unknown>},signal:exec.signal})
   if(!outcome.ok)throw new Error(outcome.error)
   orientationChecks.applied(sessionKey,input.checkId,"camera",face.sceneRevision)
   return {checkId:input.checkId,kind:"camera",sceneId:face.sceneId,sceneRevision:face.sceneRevision,status:"checking",camera:outcome.value} as any
  },
 }))
 ctx.tools.register(defineTool({
  name:"viewer_orientation_finish",
  description:"Terminal orientation result: correct means the initial image was upright; corrected means a new viewer_observe image from the same window has been inspected and is upright; uncertain means evidence is insufficient and no further edit is made. corrected without a real new image receipt is rejected.",
  parameters:{input:{type:"object",required:true,additionalProperties:false,description:"Orientation check conclusion.",properties:{checkId:{type:"string"},decision:{oneOf:[{type:"string",const:"correct"},{type:"string",const:"corrected"},{type:"string",const:"uncertain"}]},captureId:{type:"string"}}}},
  output:{schema:{type:"json"},render:(_args,value)=>[{type:"text",text:JSON.stringify(value)}]},
  execute:async(args,exec)=>{
   const input=(args.input??args) as {checkId?:unknown;decision?:unknown;captureId?:unknown}
   if(typeof input.checkId!=="string"||!(["correct","corrected","uncertain"] as unknown[]).includes(input.decision)||input.captureId!==undefined&&typeof input.captureId!=="string")throw new Error("ORIENTATION_FINISH_INPUT_INVALID")
   const sessionKey=sessionKeyOf(exec.agent),face=orientationChecks.get(sessionKey,input.checkId)
   if(!face)throw new Error("ORIENTATION_CHECK_NOT_IN_SESSION")
   const snapshot=await sceneFor(sessionKey).scene.snapshot(face.sceneId)
   if(snapshot.revision!==face.sceneRevision)throw new Error("ORIENTATION_SCENE_STALE: 检查目标已被后续编辑替代")
   requireOrientationWindow(sessionKey,face)
   return orientationChecks.finish(sessionKey,input.checkId,input.decision as "correct"|"corrected"|"uncertain",input.captureId as string|undefined) as any
  },
 }))
 // ── 相机：应用指定相机 / 按指定相机出图 ───────────────────────────────────────
 /** 采集来源的两种值：`native-viewer` = 窗口里那一帧（屏幕画面），`native-viewer-camera` = 用指定相机在同一台原生 Viewer 上渲出来的图。 */
 const CAPTURE_SOURCES=["native-viewer","native-viewer-camera"] as const
 type CaptureSource=(typeof CAPTURE_SOURCES)[number]
 /**
  * 采集记录的相机扩展字段（本地扩展，不动共享的 `CaptureRecord` 形状）：
  *   · `source`：这张图是"当前画布"还是"按指定相机出的图"；
  *   · `cameraImage`：出图时**已核对过**的像素尺寸/内参/投影矩阵（与图、与附件三者一致才会落盘；附件库缩过图时另带 `preview`，把缩图与原图的尺寸/内参/像素换算写清楚）；
  *   · `cameraApply`：拍之前应用的那台相机（应用后当场量到的读数 + 命名相机名）。
  */
 type CaptureCameraExtras={source?:CaptureSource;cameraImage?:Record<string,unknown>;cameraApply?:Record<string,unknown>}
 const captureSourceOf=(record:{source?:unknown}):string=>typeof record.source==="string"?record.source:"native-viewer"
 /**
  * 回执里 `image` 描述对象的自洽：path 与 attachmentId/mediaType/bytes/宽高必须属于**同一个真实文件**。
  * 附件库缩过大图时，交到模型手上的那份是**预览**（attachment），顶层 `imagePath`/`originalImage` 才是原帧；
  * 两者的 path 不能混——机器消费者会照着 path 去解码，拿到另一个尺寸的文件就用错了内参。没缩图时两者本来就是同一个文件。
  */
 const captureImageFace=(image:ImageAttachmentRef,record:{imagePath:string;originalImage?:unknown}):Record<string,unknown>=>({path:(record.originalImage?ctx.attachments.imageHostPath(image):undefined)??record.imagePath,attachmentId:image.attachmentId,mediaType:image.mediaType,bytes:image.bytes,width:image.width,height:image.height})
 /** 相机请求可以从入参的多个键收出来（扁平姿势与 camera 块都接受）；没给的键不出现——不把 undefined 混进 JSON。 */
 const CAMERA_REQUEST_KEYS=["camera","intrinsics","worldFromCamera","position","positionInputUnits","metersPerInputUnit","quaternion","target","up","cameraUp","rotationMatrix","fovYDeg","near","far","targetDistanceM"] as const
 const cameraRequestOf=(input:Record<string,unknown>):Record<string,unknown>=>{
  const request:Record<string,unknown>={}
  for(const key of CAMERA_REQUEST_KEYS)if(input[key]!==undefined)request[key]=input[key]
  return request
 }
 const cameraRequestIsEmpty=(request:Record<string,unknown>):boolean=>Object.keys(request).length===0
 /**
  * 排队前的**决定性预检**：调的是 Viewer 侧同一份纯函数 `normalizeCameraRequest`（不碰相机、只做数学与矛盾判定），
  * 所以"位姿多来源互相矛盾 / target 不在视线上 / fov 与内参不一致"这类错误当场返回给模型，不必白等一轮前端。
  * 真正的应用与"应用后当场测量"在前端，回执以那份测量为准——这里只负责"这个请求根本不可能成立"。
  */
 const requireCameraRequest=(request:Record<string,unknown>):void=>{
  // `current` 只是"窗口里总有一台相机"的占位（真实值在前端，应用时由 `cameraCurrent()` 给）：
  //   · 部分更新（只给 fovYDeg/near 这类字段）靠它才有位置可沿用——不然预检会把这类请求当成
  //     "没有相机位置"当场拒掉，而它其实完全成立（前端会沿用当前姿态，含 roll）；
  //   · 它不参与请求自身的判定：矛盾（多来源不一致、target 不在视线上、尺度未定）照样在这里就拒。
  try{normalizeCameraRequest(request as ViewerCameraRequest,{position:[0,0,0],quaternion:[0,0,0,1],cameraUp:[0,0,1],target:[0,0,1],targetDistanceM:1,fovYDeg:50,near:0.1,far:1000})}
  catch(error){throw new Error(`VIEWER_CAMERA_REQUEST_INVALID: ${error instanceof Error?error.message:String(error)}`)}
 }
 /** 命名相机名（与前端 `workbench-camera.ts` 同一个上限）：非空字符串，否则明确拒绝。 */
 const nameOf=(value:unknown,label:string):string|undefined=>{
  if(value===undefined)return undefined
  if(typeof value!=="string"||!value.trim())throw new Error(`VIEWER_CAMERA_NAME_INVALID: ${label} 应为非空字符串`)
  return value.trim().slice(0,60)
 }
 /**
  * 相机请求的公共脚手架（三个入口共用）：入参形状 → 宿主里这个版本真实存在 → 选目标窗口。
  * 判据与 `viewer_observe` 同一份（`observeTargetClient`），错误码按 prefix 区分是谁的请求。
  */
 const prepareCameraCall=async(input:{agent:unknown;sceneId?:unknown;expectedRevision?:unknown;clientId?:unknown;signal:AbortSignal;prefix:string}):Promise<{sceneId:string;expectedRevision:number;sessionKey:string;clientId:string}>=>{
  if(typeof input.sceneId!=="string"||!input.sceneId)throw new Error(`${input.prefix}_SCENE_REQUIRED: 指定 sceneId`)
  if(!Number.isInteger(input.expectedRevision)||(input.expectedRevision as number)<0)throw new Error(`${input.prefix}_REVISION_REQUIRED: 指定 expectedRevision（场景文档版本）`)
  if(input.clientId!==undefined&&(typeof input.clientId!=="string"||!input.clientId))throw new Error(`${input.prefix}_CLIENT_INVALID: clientId 应为非空字符串`)
  const sceneId=input.sceneId,expectedRevision=input.expectedRevision as number
  const sessionKey=sessionKeyOf(input.agent)
  if(input.signal.aborted)throw new Error(`${input.prefix}_ABORTED: 请求在排队前已被取消`)
  const snapshot=await sceneSnapshot(sessionKey,sceneId)
  // 等快照之后必须再核一次：取消可能就发生在这一段（下面的 abort 监听还没登记，那次事件已经过去了）。
  if(input.signal.aborted)throw new Error(`${input.prefix}_ABORTED: 请求在等场景快照期间已被取消`)
  if(expectedRevision>snapshot.revision)throw new Error(`${input.prefix}_REVISION_UNKNOWN: 场景 ${sceneId} 当前是 rev ${String(snapshot.revision)}，没有 rev ${String(expectedRevision)}`)
  return {sceneId,expectedRevision,sessionKey,clientId:observeTargetClient(sessionKey,{sceneId,expectedRevision,...input.clientId?{clientId:input.clientId as string}:{}})}
 }
 ctx.tools.register(defineTool({
  name:"viewer_camera_apply",
  description:"Apply a specified camera to the native 3D window in this session for comparison from the same pose and intrinsics. Accept the camera_fit camera block unchanged: worldFromCamera {positionM,rotationMatrix,quaternionXyzw} and viewer {position,quaternion,up,sceneUp,target,focusDistance,fov_y_deg,intrinsics}; pass its intrinsics {fx,fy,cx,cy,width,height}. Direct position/quaternion/target/up/cameraUp/rotationMatrix/worldFromCamera/fovYDeg/near/far are also supported. Return the camera measured immediately after application, including roll, intrinsics, projection matrix, worldFromCamera, and recoverable state. Roll, target/up, and FOV do not overwrite one another. Conflicting quaternion/matrix, target off the view line, or inconsistent FOV/intrinsics are rejected rather than silently choosing a source. When camera.metric=false/worldUnit=unknown, positionInputUnits is not in meters: provide metersPerInputUnit to convert position and same-scale target/focusDistance, or supply metric position/positionM. Otherwise reject with VIEWER_CAMERA_SCALE_UNKNOWN without substituting the current camera position. Partial updates preserve unnamed pose, roll, and projection fields and identify this in the receipt. Window resize scales intrinsics, and a new revision of the same scene preserves camera settings. name reads a camera saved in the Scene document; saveAs stores the applied camera in entity.components.viewerCamera through scene_edit + CAS. A write failure fails the whole operation. Act only when the target window displays sceneId at expectedRevision. Missing windows, a different displayed version, timeout, and cancellation have explicit errors.",
  parameters:{input:{type:"object",required:true,additionalProperties:false,description:"Apply a camera.",properties:{
   sceneId:{type:"string",description:"Target scene ID."},
   expectedRevision:{type:"integer",description:"Nonnegative scene document revision already loaded by the target window."},
   clientId:{type:"string",description:"Optional target window for disambiguation."},
   name:{type:"string",description:"Optional camera name saved in the Scene document; mutually exclusive with camera fields."},
   saveAs:{type:"string",description:"Optional name to save the applied camera after success. This is Scene content; the same name is replaced, and a failed write fails the whole operation."},
   camera:{type:"object",additionalProperties:true,description:"camera_fit camera block (worldFromCamera + viewer), or {position,quaternion,target,up,cameraUp,fovYDeg,near,far,worldFromCamera,intrinsics}."},
   intrinsics:{type:"object",additionalProperties:true,description:"Camera intrinsics fx/fy/cx/cy/width/height; accepts camera_fit intrinsics unchanged."},
   worldFromCamera:{type:"object",additionalProperties:true,description:"Pose: positionM and rotationMatrix and/or quaternionXyzw, following camera_fit (world=R*p_cam+t). Unknown scale uses positionInputUnits, not meters, and requires metersPerInputUnit."},
   metersPerInputUnit:{type:"number",description:"Optional meters per input unit. Required for camera.metric=false; otherwise reject with VIEWER_CAMERA_SCALE_UNKNOWN."},
   positionInputUnits:{type:"array",items:{type:"number"},description:"Position [x,y,z] in input units, not meters, when scale is unknown. Accepts camera_fit positionInputUnits unchanged and requires metersPerInputUnit."},
   position:{type:"array",items:{type:"number"},description:"World position [x,y,z] in meters, Z-up."},
   quaternion:{type:"array",items:{type:"number"},description:"World-to-camera orientation quaternion [x,y,z,w], including roll."},
   target:{type:"array",items:{type:"number"},description:"View target/pivot; it must lie on the view line or the request is rejected."},
   up:{type:"array",items:{type:"number"},description:"World up hint, default [0,0,1]."},
   cameraUp:{type:"array",items:{type:"number"},description:"Camera-local up axis; provide it to retain photo roll."},
   rotationMatrix:{type:"array",items:{type:"array",items:{type:"number"}},description:"World-to-camera 3x3 rotation matrix; rows are camera-axis directions in world coordinates."},
   fovYDeg:{type:"number",description:"Vertical field of view in degrees."},
   near:{type:"number",description:"Near clipping plane."},
   far:{type:"number",description:"Far clipping plane."}}}},
  output:{schema:{type:"json"},render:(_args,value)=>[{type:"text",text:JSON.stringify(value)}]},
  execute:async(args,exec)=>{
   const input=(args.input??args) as Record<string,unknown>
   const prepared=await prepareCameraCall({agent:(exec as {agent?:unknown}).agent,sceneId:input.sceneId,expectedRevision:input.expectedRevision,clientId:input.clientId,signal:exec.signal,prefix:"VIEWER_CAMERA"})
   const request=cameraRequestOf(input)
   const namedCamera=nameOf(input.name,"name"),saveAs=nameOf(input.saveAs,"saveAs")
   if(cameraRequestIsEmpty(request)&&namedCamera===undefined)throw new Error("VIEWER_CAMERA_REQUEST_REQUIRED: 既没有给相机（position/quaternion/target/up/camera/rotationMatrix/worldFromCamera/fovYDeg/intrinsics），也没有给命名相机（name）")
   if(!cameraRequestIsEmpty(request))requireCameraRequest(request)
   // 请求整块放进 `args.camera`（前端 `cameraArgsOf(item)` 读的就是这个键，与 viewer_observe 带相机时一致）。
   const outcome=await queueCameraApply({...prepared,args:{camera:request,...namedCamera?{name:namedCamera}:{},...saveAs?{saveAs}:{}},signal:exec.signal})
   if(!outcome.ok)throw new Error(outcome.error)
   const receipt=outcome.value
   return {applied:true,sceneId:prepared.sceneId,expectedRevision:prepared.expectedRevision,clientId:prepared.clientId,
    camera:receipt.camera,state:receipt.state,
    ...receipt.usedName!==undefined?{usedName:receipt.usedName}:{},
    ...receipt.savedAs!==undefined?{savedAs:receipt.savedAs}:{},
    ...receipt.savedNames!==undefined?{savedNames:receipt.savedNames}:{},
    note:`这台相机已经真正应用到窗口 ${prepared.clientId} 上，用户在界面里直接可见；camera 是**应用后当场测量**的读数（不是请求）。窗口 resize 时内参按比例缩放、同场景新 revision 也不会丢；要出图请用 viewer_render_camera，要拍当前画布请用 viewer_observe（带 camera）。`} as any
  },
 }))
 ctx.tools.register(defineTool({
  name:"viewer_render_camera",
  description:"Render an image from a specified camera using the native Viewer's same scene, lights, tone mapping, and materials in this session, at the requested pixel size, and return a native image attachment. This is not the current-screen capture: source=native-viewer-camera differs from viewer_observe source=native-viewer. Camera parameters follow viewer_camera_apply; camera_fit camera/intrinsics are accepted unchanged. If width/height are omitted, use the intrinsics dimensions, then the current canvas size. To compare from a photo K, supply matching intrinsics and dimensions. Return the image, attachment, and that image's measured camera, including roll, intrinsics, projection matrix, and worldFromCamera. Verify intrinsics, image size, and projection matrix before saving; mismatches return no image or capture record. Missing windows, a different displayed version, timeout, and cancellation have explicit errors.",
  parameters:{input:{type:"object",required:true,additionalProperties:false,description:"Render from a specified camera.",properties:{
   sceneId:{type:"string",description:"Target scene ID."},
   expectedRevision:{type:"integer",description:"Nonnegative scene document revision already loaded by the target window."},
   clientId:{type:"string",description:"Optional target window for disambiguation."},
   width:{type:"integer",description:"Optional output width in pixels; provide with height."},
   height:{type:"integer",description:"Optional output height in pixels; provide with width."},
   camera:{type:"object",additionalProperties:true,description:"camera_fit camera block (worldFromCamera + viewer), or {position,quaternion,target,up,cameraUp,fovYDeg,near,far,intrinsics}."},
   intrinsics:{type:"object",additionalProperties:true,description:"Camera intrinsics fx/fy/cx/cy/width/height; match the photo K for comparison from the same camera."},
   worldFromCamera:{type:"object",additionalProperties:true,description:"Pose: positionM and rotationMatrix and/or quaternionXyzw."},
   position:{type:"array",items:{type:"number"},description:"World position [x,y,z] in meters."},
   quaternion:{type:"array",items:{type:"number"},description:"World-to-camera orientation quaternion [x,y,z,w]."},
   target:{type:"array",items:{type:"number"},description:"View target/pivot; it must lie on the view line."},
   up:{type:"array",items:{type:"number"},description:"World up hint, default [0,0,1]."},
   cameraUp:{type:"array",items:{type:"number"},description:"Camera-local up axis."},
   rotationMatrix:{type:"array",items:{type:"array",items:{type:"number"}},description:"World-to-camera 3x3 rotation matrix."},
   fovYDeg:{type:"number",description:"Vertical field of view in degrees."},
   near:{type:"number",description:"Near clipping plane."},
   far:{type:"number",description:"Far clipping plane."}}}},
  output:{schema:{type:"json"},render:(_args,value)=>{
   const {__cameraImage,...visible}=(value??{}) as Record<string,unknown>
   const blocks:ContentBlock[]=[{type:"text",text:JSON.stringify(visible)}]
   if(__cameraImage)blocks.push({type:"image",attachment:__cameraImage as never})
   return blocks
  }},
  execute:async(args,exec)=>{
   const input=(args.input??args) as Record<string,unknown>
   const prepared=await prepareCameraCall({agent:(exec as {agent?:unknown}).agent,sceneId:input.sceneId,expectedRevision:input.expectedRevision,clientId:input.clientId,signal:exec.signal,prefix:"VIEWER_RENDER_CAMERA"})
   const request=cameraRequestOf(input)
   if(cameraRequestIsEmpty(request))throw new Error("VIEWER_RENDER_CAMERA_REQUEST_REQUIRED: 没有给相机（position/quaternion/target/up/camera/rotationMatrix/worldFromCamera/fovYDeg/intrinsics）——出图必须指定一台相机")
   requireCameraRequest(request)
   // 尺寸两个一起给或都不给：只给一个会让"按 K 的 fx 缩放"与"另一轴的显式尺寸"混在一起，出的图不再是那台相机。
   const hasWidth=input.width!==undefined,hasHeight=input.height!==undefined
   if(hasWidth!==hasHeight)throw new Error("VIEWER_RENDER_CAMERA_SIZE_INCOMPLETE: width 与 height 要一起给（或都不给：都不给时按 intrinsics 的像素尺寸，再没有就用当前画布尺寸）")
   if(hasWidth)assertRenderSize(input.width as number,input.height as number)
   const size:Record<string,unknown>=hasWidth?{width:input.width,height:input.height}:{}
   // 同 viewer_camera_apply：请求整块放在 `args.camera`，尺寸另放（前端按 `item.args.camera` / `item.args.width` 读）。
   const outcome=await queueCaptureRequest({...prepared,action:"renderCameraViewer",args:{camera:request,...size},expectSource:"native-viewer-camera",
    timeoutError:`VIEWER_RENDER_CAMERA_TIMEOUT: 等了 ${String(Math.round(OBSERVE_TIMEOUT_MS/1000))} 秒没有等到窗口 ${prepared.clientId} 的相机出图（该窗口在轮询、但这次出图没有完成：可能标签页在后台、场景正在加载、或窗口里的 Viewer 不支持相机接口）。没有重试；可稍后重试。`,
    abortError:"VIEWER_RENDER_CAMERA_ABORTED: 出图已取消（调用方中止）",signal:exec.signal})
   if(!outcome.ok)throw new Error(outcome.error)
   const capture=outcome.capture,image=outcome.attachment
   // 落盘前已经在 `viewer_capture` 里核对过（内参↔投影矩阵、图片宽高↔内参↔附件）；这里把可核对的那份原样交给模型，
   // 于是"内参/图片宽高与输出投影一致"在结果里是可复查的读数，不是一句声明。
   const extras=capture as CaptureRecord&CaptureCameraExtras
   if(captureSourceOf(extras)!=="native-viewer-camera")throw new Error(`VIEWER_RENDER_CAMERA_SOURCE_MISMATCH: 采到的图来源是 ${captureSourceOf(extras)}，不是 native-viewer-camera`)
   // 按相机出的图同样要如实报环境光照（与 `viewer_observe` 那句同一份 owner/措辞）：换的是相机，不是灯光。
   const environmentNote=extras.environment?environmentFaceNote(extras.environment):undefined
   // 按相机出的图同样要如实报 LOD（与 `viewer_observe` 那句同一份 owner/措辞）：换的是相机，不是几何。
   const lod=extras.lod
   const lodNote=lodFaceNote(lod)??lodFaceIssueNote(extras.lodIssue)
   return {source:"native-viewer-camera",sceneId:capture.sceneId,sceneRevision:capture.sceneRevision,expectedRevision:prepared.expectedRevision,clientId:prepared.clientId,captureId:capture.captureId,capturedAt:capture.capturedAt,
    imagePath:capture.imagePath,image:captureImageFace(image,capture),
    ...originalFrameNote(capture),
    camera:capture.camera,...extras.cameraImage?{cameraImage:extras.cameraImage}:{},...extras.cameraApply?{appliedCamera:extras.cameraApply}:{},
    ...extras.environment?{environment:extras.environment}:{},
    ...lod?{lod}:{},
    ...capture.worldId?{worldId:capture.worldId,generation:capture.generation,worldSceneRevision:capture.worldSceneRevision,frameSceneRevision:capture.frameSceneRevision,frameId:capture.frameId,stepIndex:capture.stepIndex,simTime:capture.simTime}:{},
    note:`这张图是**用指定相机在同一个原生 Viewer scene 上渲染**出来的（不是当前屏幕截图）：source=native-viewer-camera。camera 是这张图自己的相机读数；cameraImage 里的内参/像素尺寸/投影矩阵与附件像素尺寸在落盘前逐项核对过。与照片做同机位比对时用它，别拿 viewer_observe 的当前画布截图当参考图。${environmentNote??""}${lodNote??""}`,
    ...outcome.attachment?{__cameraImage:image}:{}} as any
  },
 }))
 type SelectionIdentity={sceneId:string;worldId?:string;clientId?:string}
 // 服务端此刻记录的选择身份：**活动窗口**（最近一次写入选择事实的那个）的 Scene 与选中的 world。
 const selectionIdentity=(agent:unknown):SelectionIdentity|undefined=>{
  const scope=scopeOf((agent as {ctx?:unknown})?.ctx as Parameters<typeof scopeOf>[0])
  if(!scope)return undefined
  const current=activeSelection(scope)
  if(!current||typeof current.facts.sceneId!=="string")return undefined
  return {sceneId:current.facts.sceneId,worldId:typeof current.facts.worldId==="string"?current.facts.worldId:undefined,clientId:current.clientId}
 }
 // 客户端内部请求携带的“命令发出时”的选择身份。只接受明确形状：sceneId 必须是字符串，
 // worldId 允许缺省（表示当时没有选任何 world）。clientId 是**发出这条命令的窗口**（前端注入），
 // 用来把 world 生命周期结果写回那个窗口自己的选择槽；形状不对就没有身份可用，退回活动窗口。
 const dispatchedIdentity=(value:unknown):SelectionIdentity|undefined=>{
  if(!value||typeof value!=="object")return undefined
  const sceneId=(value as {sceneId?:unknown}).sceneId
  if(typeof sceneId!=="string")return undefined
  const worldId=(value as {worldId?:unknown}).worldId
  const clientId=(value as {clientId?:unknown}).clientId
  return {sceneId,worldId:typeof worldId==="string"?worldId:undefined,...typeof clientId==="string"&&clientId?{clientId}:{}}
 }
 // 世界生命周期结果的归属规则（判据必须锚在命令发出时，见 dispatchedIdentity）：
 // 1) 结果只能写进仍指向同一 Scene 的选择（迟到的 sim_open/sim_sync 不能落到另一 Scene）；
 // 2) 落地前核对锚定身份与完成时的选择一致：请求期间用户改到了别的 Scene/world 就不落地；
 // 3) 只允许把选择指向“刷新当前 world”（sim_sync 的既有语义）或“本次 sim_open 新建/打开的
 //    world”（正常同 Scene 新建 world 仍可采用）；没有选择元数据的旧/非 UI 调用不得被推断成
 //    想改选另一个已存在的 world。
 // sim_close 不带 world 结果，只按被关闭的那个 worldId 与当前选择是否一致来清除。
 const updateSelectionWorld=(agent:unknown,command:string,world:Record<string,unknown>|undefined,closedWorldId?:string,anchor?:SelectionIdentity)=>{
  const scope=scopeOf((agent as {ctx?:unknown})?.ctx as Parameters<typeof scopeOf>[0])
  if(!scope)return
  const slots=selections.get(scope);if(!slots)return
  // 归属：这次命令来自哪个窗口（前端在命令体的 `selection` 里带了 clientId）；拿不到就退回活动窗口（修前行为）。
  const target=anchor?.clientId&&slots.has(anchor.clientId)?anchor.clientId:activeSelection(scope)?.clientId
  if(!target)return
  const current=slots.get(target);if(!current)return
  // 显式清除后记录只剩单调序号（序号边界不能丢，否则迟到的旧选择会写回）。
  // 没有 sceneId 就不该被 world 生命周期重新填成半份事实。
  if(typeof current.facts.sceneId!=="string")return
  const currentWorldId=typeof current.facts.worldId==="string"?current.facts.worldId:undefined
  if(world){
   if(typeof world.worldId!=="string"||world.sceneId!==current.facts.sceneId)return
   if(!anchor||anchor.sceneId!==current.facts.sceneId||anchor.worldId!==currentWorldId)return
   if(world.worldId!==currentWorldId&&command!=="sim_open")return
  }else if(typeof closedWorldId!=="string"||currentWorldId!==closedWorldId)return
  const facts={...current.facts}
  for(const key of ["worldId","engineId","worldStatus","expectedGeneration","appliedSceneRevision"])delete facts[key]
  if(world){
   Object.assign(facts,{worldId:world.worldId,engineId:world.engineId,worldStatus:world.status,expectedGeneration:world.worldGeneration,appliedSceneRevision:world.appliedSceneRevision})
  }
  slots.set(target,{...current,facts})
 }
 const sceneSelectionText=(scope:ScopeKey|undefined)=>{
  const value=scope?activeSelection(scope):undefined
  if(!value)return ""
  // 当前事实由原生 Session surface 替换同 owner 快照，raw事件仍在；清除也须明确宣告。
  if(Object.keys(value.facts).length===0)return "The 3D workbench has no valid selection. Earlier scene/object/world selections (sceneId, entityId, world) are no longer current and cannot resolve the current reference. Determine the target from an explicit user selection or existing query tools."
  return "Current 3D workbench facts; the selected object is the entityId below:\n"+JSON.stringify(value.facts)
 }
 /** 可选产品契约的"什么时候需要"（Jev 用它决定本步要不要生成这段正文；正文仍是 product-context.ts 的命名常量）。 */
 const optionalContextNeed=(key:"ui-action"|"camera"|"desktop-delivery"):string=>({
  "ui-action":"需要操作工作台面板、文件、画布、终端，或选中实体、聚焦相机、切换场景",
  camera:"需要把指定相机摆进窗口、按指定相机出图做同机位比对，或做 Viewer 采集",
  "desktop-delivery":"需要 computer-use 点击/按键/输入，或排查「回执成功但界面没变化」",
 }[key])
 /** ENV-02 简短场景规格的正文：由既有生成器按**本步用户原话 + 当前选择**合成（Jev 只决定要不要）。 */
 const sceneSpecText=(text:string,stage:EnvironmentStage,source:EnvironmentInputSource,sceneId?:string):string=>{
  // 规格只在环境阶段有意义；非环境/停止档不硬造一份假规格。
  if(stage==="none"||stage==="stop")return ""
  return renderBriefSceneSpec(briefSceneSpec({text,stage,source,sceneId}))
 }
 ctx.systemPrompt.context({name:"lyapunov-scene-selection",order:8500,text:({scope})=>sceneSelectionText(scope)})
 const root=config.captureRoot??(process.env.LYAPUNOV_SCENE_ROOT?join(process.env.LYAPUNOV_SCENE_ROOT,"captures"):undefined)
 const captureRoot=()=>{if(!root)throw new Error("CAPTURE_DATA_ROOT_REQUIRED");return resolve(root)}
 // 采集产物按会话分命名空间：`<captureRoot>/sessions/<会话键>`。同一个 captureId 在两个会话里各自成立，
 // 采集列表/媒体读取只读**本会话**那一份，不靠调用方自己拼前缀（拼法只有 sessionNamespace 这一处）。
 const captureDirectory=(sessionKey:string)=>{if(!sessionKey)throw new Error(`${SESSION_SCOPE_UNAVAILABLE}: 采集目录必须按会话取（拒绝落到全局共享目录）`);return sessionNamespace(captureRoot(),sessionKey)}
 const capturePath=(sessionKey:string,id:string)=>{if(!/^[a-zA-Z0-9_-]+$/.test(id))throw new Error("INVALID_CAPTURE_ID");return join(captureDirectory(sessionKey),id+".json")}
 const readCapture=async(sessionKey:string,id:string):Promise<CaptureRecord>=>JSON.parse(await readFile(capturePath(sessionKey,id),"utf8"))
 /**
  * 最近动作回执：服务端按**完整** session 事件推导（模型真值不动），出站前裁成机器面
  * （`uiCommandFields("sim_execute_batch",…)` 同一份白名单）；失败只发公开码 + 人话，
  * 完整原始错误留在 Host 日志。面板的 `ActionCards` 据此渲染，不再整份 JSON 上屏。
  */
 const projectActionRows=(events:readonly any[]|undefined)=>projectControlActionRows(events??[],(receipt,name)=>uiCommandFields(name??"sim_execute_batch",receipt,productPathRoots),publicCommandError)

  /** 本会话的采集记录（可选按场景过滤；不给 sceneId = 本会话全部场景，供诊断导出用）。 */
 const listCaptures=async(sessionKey:string|undefined,sceneId?:string)=>{
  if(!root||!sessionKey)return []
  const directory=captureDirectory(sessionKey)
  let files:string[];try{files=await readdir(directory)}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw error}
  const rows:CaptureRecord[]=[]
  for(const file of files.filter(file=>file.endsWith(".json")&&!file.endsWith(".camera.json"))){const capture=JSON.parse(await readFile(join(directory,file),"utf8")) as CaptureRecord;if(sceneId===undefined||capture.sceneId===sceneId)rows.push(capture)}
  return rows.sort((a,b)=>b.capturedAt.localeCompare(a.capturedAt))
 }
 /** 产品安装根：界面要拿它解析解释器/安装脚本路径（发行布局=解包根，开发检出=仓库根）。 */
/**
 * 批注读取端的"这张图什么视角"：**由记录里已有的 `camera` + `attachment` 尺寸派生**。
 *
 * 为什么不再单独持久化 `pose`：`capture.camera` 已带 position/quaternion/target/up/fov_y/near/far，
 * 图像宽高又已在 `attachment` 里；再存一份等于把同一事实编码两遍，迟早漂移。
 * 对外键名沿用 pose 的口径（fovDeg 与 imageWidth/imageHeight/aspect），读取端契约不变。
 */
/** 有限数（自带错误码），只服务下面的出图载荷自检。 */
function captureFinite(value:unknown,label:string):number{
 if(typeof value!=="number"||!Number.isFinite(value))throw new Error(`VIEWER_RENDER_CAMERA_PROVENANCE_INVALID: ${label} 必须是有限数（收到 ${JSON.stringify(value)??"undefined"}）`)
 return value
}
/**
 * "按指定相机出图"载荷的自检：**内参、图片像素尺寸、投影矩阵、附件尺寸**必须互相一致，才允许落盘——
 * 模型拿这张图做同机位比对，靠的就是"图里的像素 ↔ 那台相机的投影"一一对应，一项对不上它就不再是那台相机的像。
 * 附件库把图整体缩小入库时（缩过才带 `originalDimensions`）只接受"缩的就是这张图"（缩小前尺寸 == 出图尺寸），
 * 并把预览口径记进 `preview`；内参与坐标始终按原图，原分辨率帧由 capture 路径逐字节另存。
 * 逐轴比例不要求相等：整体缩放的取整本来就会让两轴比例略有出入（高长宽比图上尤其明显），
 * 而换算用的是两轴各自的实际比例，本来就能正确表达像素 K。
 * 用到的都是 `packages/viewer/src/camera-view.ts` 里的纯函数：前端、宿主、测试共用一份投影数学。
 */
function cameraImageProvenance(input:{source?:unknown;imageWidth?:unknown;imageHeight?:unknown;camera?:unknown;sourceIntrinsics?:unknown;attachment?:{width?:number;height?:number;bytes?:number;originalDimensions?:{width:number;height:number}}}):Record<string,unknown>{
 const camera=input.camera&&typeof input.camera==="object"&&!Array.isArray(input.camera)?input.camera as Record<string,unknown>:undefined
 if(!camera)throw new Error("VIEWER_RENDER_CAMERA_PROVENANCE_REQUIRED: source=native-viewer-camera 的载荷必须带出图相机当时的读数（camera：intrinsics / projectionMatrix / near / far）")
 const intrinsics=normalizeIntrinsics(camera.intrinsics,"camera.intrinsics")
 const imageWidth=captureFinite(input.imageWidth,"imageWidth"),imageHeight=captureFinite(input.imageHeight,"imageHeight")
 assertRenderSize(imageWidth,imageHeight)
 if(intrinsics.width!==imageWidth||intrinsics.height!==imageHeight)throw new Error(`VIEWER_RENDER_CAMERA_PROVENANCE_INVALID: 出图尺寸与内参不一致：图是 ${String(imageWidth)}×${String(imageHeight)}，内参说的是 ${String(intrinsics.width)}×${String(intrinsics.height)}`)
 const near=captureFinite(camera.near,"camera.near"),far=captureFinite(camera.far,"camera.far")
 const matrix=camera.projectionMatrix
 if(!Array.isArray(matrix)||matrix.length!==16||matrix.some(item=>typeof item!=="number"||!Number.isFinite(item)))throw new Error("VIEWER_RENDER_CAMERA_PROVENANCE_INVALID: camera.projectionMatrix 必须是 16 个有限数（three 的列主序）")
 const expected=projectionMatrixFromIntrinsics(intrinsics,near,far)
 const worst=Math.max(...expected.map((value,index)=>Math.abs(value-(matrix[index] as number))))
 if(!(worst<=1e-9))throw new Error(`VIEWER_RENDER_CAMERA_PROJECTION_MISMATCH: 投影矩阵与内参不自洽：按报告的内参/near/far 解析复算，与相机自报的矩阵逐元素最大差 ${worst.toExponential(2)}`)
 // 请求的 K 与**实测** K 的核对：按图片像素尺寸缩放后必须一致（差得多说明相机没按那台照片相机摆）。
 const requested=input.sourceIntrinsics===undefined?undefined:normalizeIntrinsics(input.sourceIntrinsics,"sourceIntrinsics")
 let scaled:ViewerCameraIntrinsics|undefined,worstPx=0
 if(requested){
  scaled=scaleIntrinsics(requested,imageWidth,imageHeight)
  worstPx=Math.max(Math.abs(scaled.fx-intrinsics.fx),Math.abs(scaled.fy-intrinsics.fy),Math.abs(scaled.cx-intrinsics.cx),Math.abs(scaled.cy-intrinsics.cy))
  const tolerance=Math.max(1e-6,Math.max(intrinsics.fx,intrinsics.fy,1)*1e-9)
  if(!(worstPx<=tolerance))throw new Error(`VIEWER_RENDER_CAMERA_INTRINSICS_MISMATCH: 这张图不是按请求的 K 画的：请求内参按 ${String(imageWidth)}×${String(imageHeight)} 缩放后与实测最多差 ${worstPx.toExponential(2)} 像素（fx ${scaled.fx.toFixed(6)} vs ${intrinsics.fx.toFixed(6)}、cx ${scaled.cx.toFixed(6)} vs ${intrinsics.cx.toFixed(6)}）`)
 }
 // 附件尺寸核对：**原图口径**是基准。附件库按自己的成像策略把图整体缩小后入库是允许的
 // （`originalDimensions` 只在这种时候出现），但必须能证明它缩的就是**这张图**：缩小前尺寸要正好等于这次出图尺寸。
 // 逐轴比例**不设等比例守卫**：可信来源的 `saveImage` 只是整体缩放，两轴各自的实际比例已经把像素 K 表达清楚了，
 // 而"取整后两轴比例略有差别"是任何缩放的正常结果（比如 876×5875 → 791×5302，两轴比例差 2.9 像素的量级，
 // 按等比守卫会错拒）；拿它当裁切证据就是把合法取整说成图被裁。满足才收下，并把"缩图 ↔ 原图"的尺寸/比例/内参/
 // 像素换算显式记进 `preview`；对不上的照旧按"别的图冒充这台相机的像"拒——尺寸对不上就是不能证明它还是那台相机的像。
 const attachment=input.attachment
 let preview:Record<string,unknown>|undefined
 if(attachment){
  const width=attachment.width as number,height=attachment.height as number
  if(width!==imageWidth||height!==imageHeight){
   const original=attachment.originalDimensions
   const sameFrame=Boolean(original&&original.width===imageWidth&&original.height===imageHeight)
   const scale=previewScaleOf({width:imageWidth,height:imageHeight},{width,height})
   if(!sameFrame)throw new Error(`VIEWER_RENDER_CAMERA_IMAGE_SIZE_MISMATCH: 附件实际像素是 ${String(width)}×${String(height)}，相机读数说的是 ${String(imageWidth)}×${String(imageHeight)}${original?`（附件记的缩小前尺寸是 ${String(original.width)}×${String(original.height)}）`:""}`)
   preview={width,height,...typeof attachment.bytes==="number"?{bytes:attachment.bytes}:{},...scale,intrinsics:scaleIntrinsics(intrinsics,width,height),pixelMapping:previewPixelMappingText(scale),note:"这份缩图是附件库按自己的成像策略缩的，只作**预览/模型输入**；本记录的 imageWidth/imageHeight 与 intrinsics 一律是**原图**口径，量缩图上的像素前先按 pixelMapping 换算回原图像素，别把原图的 K 用在缩图上。"}
  }
 }
 return {source:"native-viewer-camera",imageWidth,imageHeight,intrinsics,projectionMatrix:matrix.map(item=>item as number),near,far,...requested?{sourceIntrinsics:requested,sourceIntrinsicsScaledDeltaPx:worstPx}:{},...preview?{preview}:{},verified:true}
}
/**
 * 采集回执里"交到你手上的是预览、正本是原分辨率帧"那句话（只有 `originalImage` 存在时才说——它只在附件库缩过图时出现）。
 * 换算用 `workbench-api.ts` 那份共用映射写进句子本身：普通 `viewer_observe` 没有 `cameraImage.preview`，指过去就是让人读空气。
 */
function originalFrameNote(record:{originalImage?:{path:string;bytes:number;width:number;height:number};attachment?:{width:number;height:number}}):Record<string,unknown>{
 const frame=record.originalImage
 if(!frame)return {}
 const preview=record.attachment
 const scale=preview?previewScaleOf(frame,preview):undefined
 return {originalImage:frame,imagePreviewNote:`注意：这张图落盘时被附件库按成像策略**缩小**过——交到你手上的图片附件是**预览**${preview?`（${String(preview.width)}×${String(preview.height)}）`:""}，内参/图像尺寸一律按**原帧** ${String(frame.width)}×${String(frame.height)} 记（原分辨率 PNG 在 ${frame.path}，${String(frame.bytes)} B）。${scale?`要在预览上量像素，先按同一份换算换回原帧：${previewPixelMappingText(scale)}；`:""}别把原帧的 K 用在预览上。`}
}
function derivedPose(record:{camera?:unknown;attachment?:{width?:number;height?:number};originalImage?:{width?:number;height?:number}}):Record<string,unknown>|undefined{
 const camera=record.camera
 if(!camera||typeof camera!=="object")return undefined
 const fov=(camera as {fov_y?:unknown}).fov_y
 // "这张图多大"取原帧：批注/框选坐标都按原图像素给，附件库缩过图时 `attachment` 是预览尺寸。
 const width=record.originalImage?.width??record.attachment?.width,height=record.originalImage?.height??record.attachment?.height
 return {...(camera as Record<string,unknown>),
  ...(typeof fov==="number"?{fovDeg:fov}:{}),
  ...(typeof width==="number"&&typeof height==="number"?{imageWidth:width,imageHeight:height,aspect:height?width/height:undefined}:{})}
}
const PRODUCT_ROOT_FOR_ENGINE=resolve(dirname(fileURLToPath(import.meta.url)),"../../..")
const register=(path:string,methods:readonly ("GET"|"POST")[],handler:(request:Request)=>Promise<Response>)=>ctx.effect(()=>ctx.connection.fetch.register({
  path:"/api/lyapunov/"+path,methods,requestBody:"buffered",
  fetch:async request=>{try{return await handler(request)}catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:400})}},
 }))
 register("execution-graph",["GET"],async request=>{
  const sessionId=new URL(request.url).searchParams.get("sessionId")??""
  const agent=ctx.agents.get(SessionId(sessionId))
  if(!agent)throw Error("SESSION_NOT_LIVE: 执行图只读当前已打开的原生会话，不自动恢复或启动执行")
  if(!executionSnapshot)throw Error("SESSION_PROJECTION_REQUIRED: 当前Host未装配原生执行图投影")
  return Response.json(executionSnapshot(agent),{headers:{"cache-control":"private, no-store"}})
 })
 const OFFICIAL_ENGINE_ID="official-suite"
 /**
  * 活动官方世界的只读 Scene 投影。派生 Scene 归该世界自己所有：这里只按 worldId 读，
  * 不注册进 SceneStore，也不产生第二个持久 owner；世界一关闭它就随之消失。
  */
 const officialSceneFor=async(sessionKey:string,sceneId?:string):Promise<SceneSnapshot|undefined>=>{
  if(!sceneId)return undefined
  const sim=existingSimFor(sessionKey)
  if(!sim?.scene)return undefined
  const world=(await sim.listWorlds()).find(item=>item.engineId===OFFICIAL_ENGINE_ID&&item.status!=="closed"&&item.sceneId===sceneId)
  if(!world)return undefined
  const snapshot=await sim.scene(world.worldId)
  // 投影必须来自同一个活动世界、覆盖同一个 revision，否则宁可失败也不给半成品 Scene。
  if(snapshot.sceneId!==world.sceneId)throw new Error(`OFFICIAL_SCENE_WORLD_MISMATCH ${snapshot.sceneId} != ${world.sceneId}`)
  if(snapshot.revision!==world.appliedSceneRevision)throw new Error(`OFFICIAL_SCENE_REVISION_MISMATCH scene=${snapshot.revision} world=${world.appliedSceneRevision}`)
  return snapshot
 }
 /**
  * 普通 Scene 仍由 SceneStore 拥有；只有活动官方 world 的 sceneId 走只读投影。
  * 两条路径都按**同一个会话键**取（scene 与 sim 的会话取得路径一致）：同一本 sceneId 在两个会话里各自成立，
  * 不会出现"A 的 sceneId 读到 B 的场景文档"（修前两边都是 Host 级单例，天然串台）。
  */
 const sceneSnapshot=async(sessionKey:string,sceneId:string):Promise<SceneSnapshot>=>await officialSceneFor(sessionKey,sceneId)??await sceneFor(sessionKey).repairResourceSources(sceneId)
 /** 把本插件作用域里的路径域与依赖缓存绑到共用的出站组合上（实现见模块级 `projectSceneForBrowser`）。 */
 const projectSceneOutbound=async(scene:SceneSnapshot,sessionKey:string):Promise<unknown>=>projectSceneForBrowser(await sceneFor(sessionKey).completeResourceSources(scene),sessionKey,productPathRoots,dependencyCache)
 /**
  * 官方 Frame 自带的 agentview 媒体描述。只认帧里的 sensor 路径，
  * 不猜文件位置，也不读任何跨世界共享的预览文件。
  */
 const agentviewSensor=(frame?:Frame):Record<string,unknown>|undefined=>{
  const rows=(frame?.entities??[]).flatMap(entity=>Object.entries(entity.sensors??{}))
  const pick=rows.find(([name,value])=>name==="agentview_image"&&typeof (value as {path?:unknown})?.path==="string")??rows.find(([,value])=>typeof (value as {path?:unknown})?.path==="string")
  return pick?.[1] as Record<string,unknown>|undefined
 }
 // `engine` 一并暴露：界面上的引擎切换按钮要显示"当前跑的是哪个引擎"，
 // 而**运行中的引擎只由 Host 启动参数决定**（读进程环境），不是客户端能算出来的值。
 // 设置界面的「物理引擎」节：状态读取 + 安装启动 + 安装日志尾 + 偏好写入。
 // 全部复用上面同一份实现（命令与界面走同一逻辑，不产生第二套选择/安装状态）。
 register("route-decision",["GET"],async request=>{const sessionKey=await bindSessionId(ctx,new URL(request.url).searchParams.get("sessionId"),"环境路由判定");return Response.json(routeDecisions.get(sessionKey)??null,{headers:{"cache-control":"private, no-store"}})})
 register("orientation-status",["GET"],async request=>{
  const url=new URL(request.url),sessionKey=await bindSessionId(ctx,url.searchParams.get("sessionId"),"方向检查状态")
  const face=orientationChecks.get(sessionKey,url.searchParams.get("checkId")??undefined)
  return Response.json(face?{checkId:face.checkId,status:face.status,sceneId:face.sceneId,sceneRevision:face.sceneRevision,attempts:face.attempts,...face.turnStop?{turnStop:face.turnStop}:{}}:null,{headers:{"cache-control":"private, no-store"}})
 })
 register("engine-providers",["GET"],async()=>Response.json({licenses:readEngineLicenses(),runningEngine:(process.env.LYAPUNOV_SIM_ENGINE??"").trim()||null,preference:readEnginePreference()??null,choices:ENGINE_CHOICES,engineDecision:engineDecision(),providers:providerRows(),installs:[...PROVIDER_ROWS.map(row=>installer.state(row.id)),installer.state('policy-cpu')]},{headers:{"cache-control":"private, no-store"}}))
 // 记录/撤销第三方许可的接受（Isaac 的 NVIDIA Omniverse）：用户显式动作 + 留痕，安装器侧仍会硬拦。
 register("engine-license",["POST"],async request=>{const body=await request.json() as {engine?:unknown;accepted?:unknown;eulaUrl?:unknown};if(body.engine!=="isaac")throw new Error(`ENGINE_LICENSE_UNSUPPORTED: ${String(body.engine)}`);if(body.accepted===true&&body.eulaUrl!==undefined&&body.eulaUrl!==ISAAC_EULA_URL)throw new Error("ENGINE_LICENSE_URL_INVALID");const file=recordEngineLicense("isaac",body.accepted===true,ISAAC_EULA_URL)
  // 先写再读：响应必须反映**记录之后**的状态，否则界面按响应刷新会看到旧值。
  return Response.json({licenses:readEngineLicenses(),file})})
 register("engine-preference",["POST"],async request=>Response.json(applyEnginePreference((await request.json() as {engine?:unknown}).engine)))
 register("provider-install",["POST"],async request=>{const body=await request.json() as {provider?:unknown;acceptEula?:unknown;dryRun?:unknown;cancelAttemptId?:unknown};if(typeof body.provider!=="string")throw new Error("PROVIDER_REQUIRED");const acceptEula=body.acceptEula===true
  // dryRun：只回报"将会执行什么"，不 spawn。支持转述/排障，也让"许可参数是否真的带上"可被验证。
  if(body.dryRun===true)return Response.json(installer.dryRun(body.provider,acceptEula))
  if(typeof body.cancelAttemptId==="string")return Response.json(installer.cancel(body.provider,body.cancelAttemptId))
  return Response.json(installer.start(body.provider,acceptEula))})
 register("runtime-info",["GET"],async()=>Response.json({
  mode:['developer','formal'].includes(process.env.LYAPUNOV_MODE??'')?process.env.LYAPUNOV_MODE:null,
  engine:(process.env.LYAPUNOV_SIM_ENGINE??"").trim()||null,
  enginePreference:readEnginePreference()??null,
  engineDecision:engineDecision(),
  providers:providerRows(),
  ...config.administrator?{administrator:config.administrator,modelBilling:config.modelBilling}:{},
 },{headers:{'cache-control':'private, no-store'}}))
 /**
  * Provider 状态与安装（设置里的「物理引擎」节用）。
  *
  * 为什么放在宿主：判定"某个引擎是否真的能用"要看**磁盘上的解释器与包**（`isaacsim` 装没装、
  * mujoco 能不能 import），这些只有宿主进程知道；安装本身是跑发行包自带的
  * `distribution/linux/install-provider`（它已带前缀冲突保护与 EULA 拦截，只输出 JSON）。
  * 这里**不复制**那份安装逻辑，只负责解析路径、起进程、把 JSON/日志原样回给界面。
  */
 // kind 是**语义分类**，不是安装器的分类：`engine` 能在启动时装配（切换列表里会出现），
  // `benchmark` 是评测负载（跑法 `./lyapunov benchmark --provider …`，切换不到它），
  // `experimental` 有独立环境但**尚未接入为引擎**（没有 provider）。安装器的 provider 口径与它无关。
  // 形状来自共用声明（`engine-provider-contract.ts`，与界面 engine-settings.tsx 同一份）。
  // 基准测试是评测负载、不是引擎，因此不在这份清单里。
  const PROVIDER_ROWS=[{id:"mujoco",label:"MuJoCo",kind:"engine",choice:"mujoco"},
  {id:"isaac",label:"Isaac Sim",kind:"engine",choice:"isaac"},
  {id:"newton",label:"Newton（Warp）",kind:"engine",choice:"newton"}] as const
 let providerCache:{at:number;rows:EngineProviderStatus[]}|undefined
 registerIsaacLocalRoutes(register,{productRoot:PRODUCT_ROOT_FOR_ENGINE,onChanged:()=>{providerCache=undefined;clearSdkImportCache()}})
 /**
  * Newton 第一切片的**能力范围**（面板措辞）。唯一权威是 Provider 自己的能力表
  * （`packages/sim-newton/python/worker.py` 的 `CAPABILITIES`，模型侧通过 `describe`/`capabilities`
  * 读真值）；这段只是把同一份事实写进面板——W5/DEV-008 报的正是"面板说的与实际做的范围不一致"，
  * 所以它有一条回归用例（`test/engine-panel-decision.test.ts`）**直接读 worker.py 核对**：
  * Python 侧能力表一变，这里的措辞就会红，逼作者一起改。
  *
  * `supported` 必须**逐个列出** worker `CAPABILITIES.supported` 的**全部**键（不是"只列方法"）：
  * 少列一个已支持的键就是【能用却说不能用】的反向假声明（DEV-008 复查实测：`list_worlds`
  * 真能用——`[]` → `open` → `[{worldId:"w-lw",status:"ready"}]`、退出码 0——而面板那句
  * "仅 …" 把它排除在能力范围之外）。判据是**集合相等**且**双向**：
  *   · worker 少一个键（或把某个键从 supported 挪走）⇒ 面板仍写着它 ⇒ 红；
  *   · 面板少列一个 worker 已支持的键（含 worker 新加键）⇒ 也红。
  * 用例是**解析** worker.py 得到键集合再比对，不手抄这份清单：这里的**顺序可以变、名字不能少**。
  * 措辞骨架被用例按 `第一切片能力范围：仅 <键>/<键>/…；<不可用说明>不可用` 解析；
  * 改骨架（分隔符、"仅"、"；"）会让用例红，这是有意的——保证这段文本始终可被机器核对。
  */
 const NEWTON_SLICE={supported:["open","sync","observe","describe","close","list_worlds","mjcf","urdf","groundPlane","realtimeClock","freeBodies","articulatedJoints","sceneCollisionCompilation"] as const,unsupported:["动作（execute 全部 ACTION_UNSUPPORTED）","相机（capture/camera_*）","接触（observe.contacts/penetrations）","assist"] as const}
 const newtonSliceNote=()=>`第一切片能力范围：仅 ${NEWTON_SLICE.supported.join("/")}；${NEWTON_SLICE.unsupported.join("、")}不可用`
 /**
  * 引擎选择的**唯一判定**在上游（`script/engine-preference.ts` 的 `resolveEngine`），面板不在这里
  * 重新排优先级、也不自己编回退原因：只把上游这次给的原话与事实读出来（W2 的四条件真值表）。
  *
  * 两次调用问的是两个不同问题，都是上游回答的：
  *   · `runtime`：本进程环境里的实际装配值（Host 的 `LYAPUNOV_SIM_ENGINE` 由启动器写入）；
  *   · `next`：**如果没有本次启动参数**（清掉该变量）按现在的偏好/默认会选谁——这正是
  *     "我明明设了 Isaac 怎么在跑 MuJoCo" 要回答的那一档（条件 C/D）。
  * `reason` 一律是上游原话（条件 D 的回退理由里含 Isaac 解释器落点、缺的判据与"条件补齐且仍为自动时下次启动才优先 isaac"）。
  */
 const engineDecision=()=>{
  const running=(process.env.LYAPUNOV_SIM_ENGINE??"").trim()||null,preference=readEnginePreference()??null
  try{
   // GPU 只探一次：同一份读数同时服务**自动判定**（是否首选 Isaac）与面板的 isaac 行读数，
   // 避免两处各探一遍而在面板上给出两句不同的话（探测本身会触碰 /dev，见 environment-readiness）。
   const gpu=gpuRuntimeDecision(probeGpuFacts())
   const summarize=(selection:ReturnType<typeof resolveEngine>)=>({engine:selection.engine,source:selection.source,reason:selection.reason,...(selection.auto?{candidates:selection.auto.candidates}:{})})
   const runtime=resolveEngine({productRoot:PRODUCT_ROOT_FOR_ENGINE,auto:{gpu}})
   const next=resolveEngine({productRoot:PRODUCT_ROOT_FOR_ENGINE,env:{...process.env,LYAPUNOV_SIM_ENGINE:undefined},auto:{gpu}})
   return {running,preference,
    runtime:summarize(runtime),
    next:summarize(next),
    gpu:{accelerator:gpu.accelerator,state:gpu.state,headline:gpu.headline},
    restartRequired:Boolean(running&&running!==next.engine)}
  }catch(error){
   // 偏好文件里是非法值时上游明确报错：面板如实显示"判定不可用"的原因，不假装有结论（也不 500）。
   return {running,preference,runtime:null as null,next:null as null,gpu:null as null,restartRequired:false,error:error instanceof Error?error.message:String(error)}
  }
 }
 /**
  * 面板上"当前跑的是哪个引擎、为什么是它、怎么改回"的唯一一份措辞（挂在那个引擎那一行的 detail 上——
  * 面板已经渲染 `row.detail`，不新增展示通道）。判据全部来自 `engineDecision()` 的上游原话：
  * "当前运行"与"已保存偏好"仍是两个不同的读数列（`runningEngine`/`preference`），不在这里合并。
  */
 const enginePanelNote=(choice:string|null,decision:ReturnType<typeof engineDecision>):string|undefined=>{
  if(!choice)return undefined
  if(!decision.next)return `· 引擎判定不可用：${decision.error??"UNKNOWN"}`
  const {running,next}=decision
  if(running&&running===choice&&next.engine===running)return `· 当前运行：为什么是它 = ${next.reason}`
  if(running&&running===choice&&next.engine!==running)return `· 当前运行（由本次启动参数决定）。按现在的偏好/环境解析应是 ${next.engine}：${next.reason}；重启后生效。`
  if(!running&&next.engine===choice)return `· 本次启动未装配引擎；按现在的偏好/环境解析会采用它：${next.reason}`
  if(running&&next.engine===choice)return `· 已按现在的偏好/环境指向它，但本次运行的是 ${running}；重启后生效（${next.reason}）。`
  return undefined
 }
 const packageVersion=(python:string,name:string):string|null=>{
  try{return execFileSync(python,["-c",`import importlib.metadata as m;print(m.version(${JSON.stringify(name)}))`],{timeout:8000,encoding:"utf8"}).trim()||null}catch{return null}
 }
 const providerRows=(force=false):EngineProviderStatus[]=>{
  if(!force&&providerCache&&Date.now()-providerCache.at<60_000)return providerCache.rows
  const decision=engineDecision()
  // isaac 行的**安装/GPU 候选事实**读数列（复核点 1/5）：只报"许可留痕 + 本次探测到的 GPU 事实 +
  // 检测范围"。**不写"尚未打开过世界"**——用户可能早已打开过、也可能做过旧版 RTX 验收，
  // 安装器无权据此推断"从未打开"；真实运行情况由当前 world 回执决定，不在设置页常驻负向诊断。
  const isaacCandidateNote=()=>{
   const license=readEngineLicenses().isaac
   const gpu=decision.gpu
   return `许可${license?`已接受（${license.acceptedAt}）`:"未接受（NVIDIA Omniverse EULA）"} · GPU 候选：${gpu?gpu.headline:"未探测"}（检测范围：设备/驱动/CUDA 加速器；未核 Isaac RTX 兼容）`
  }
  // 显式 SDK 覆盖只决定**本次运行时解释器**；install-provider 始终管理产品根下的默认前缀。
  // 两条事实必须分别读，不能拿外置解释器当安装目标，或拿空的托管前缀否定可用的外置 SDK。
  const rows:EngineProviderStatus[]=PROVIDER_ROWS.map(row=>{
   const selected=resolveSdkPython(PRODUCT_ROOT_FOR_ENGINE,row.id)
   const runtime=sdkRuntimeFacts(PRODUCT_ROOT_FOR_ENGINE,row.id)
   const managed=sdkRuntimeFacts(PRODUCT_ROOT_FOR_ENGINE,row.id,undefined,{managed:true})
   const prefix=dirname(dirname(managed.python))
   const managedStatus:EngineProviderStatus["managedStatus"]=!existsSync(prefix)?"missing":managed.available?"ready":"partial"
   const base={id:row.id,label:row.label,kind:row.kind,prefix,runtimePython:selected.python,runtimeSource:selected.source,managedStatus,installed:runtime.available,engineChoice:row.choice,installable:true}
   const panel=(detail:string)=>[detail,enginePanelNote(base.engineChoice,decision)].filter(Boolean).join(" ")
   const python=runtime.python
   const version=runtime.available?packageVersion(python,row.id==="isaac"?"isaacsim":row.id):null
   // 这里只核 SDK 安装候选与解释器的模块发现，不把它说成已打开物理世界或 RTX 已验收。
   if(row.id==="newton")return {...base,version,detail:panel(`${runtime.available?`SDK 可发现（newton ${version??"版本未读到"} · Warp）`:runtime.importProbe.detail} · ${newtonSliceNote()}`)}
   if(row.id==="isaac"){
    const sdkNote=runtime.available
     ? `SDK 安装候选命中且解释器可发现 isaacsim（${version??"版本未读到"}）`
     : runtime.installCandidate
      ? `安装候选命中，但解释器核对未通过：${runtime.importProbe.detail}`
      : runtime.importProbe.detail
    return {...base,version,detail:panel(`${sdkNote} · ${isaacCandidateNote()}`)}
   }
   return {...base,version,detail:panel(runtime.available?`当前解释器可发现 mujoco（${version??"版本未读到"}）`:runtime.importProbe.detail)}
  })
  const policyPython=resolvePolicyPython(PRODUCT_ROOT_FOR_ENGINE,process.env,{managed:true}),policy=checkPolicyCpu(PRODUCT_ROOT_FOR_ENGINE,process.env,{managed:true}),prefix=dirname(dirname(policyPython.python)),ready=policy.status==='AVAILABLE'
  rows.push({id:'policy-cpu',label:'策略 CPU 独立环境',kind:'runtime',prefix,runtimePython:policyPython.python,runtimeSource:'package-default',managedStatus:!existsSync(prefix)?'missing':ready?'ready':'partial',installed:ready,version:ready?String((policy.versions as Record<string,unknown>|undefined)?.torch??''):null,engineChoice:null,installable:true,detail:`独立 CPU 前缀${ready?'已核模块/版本':'未就绪'}；策略加载也可按来源依赖复用已登记 SDK，不启动 Kit。单个 Torch CPU wheel ${(POLICY_CPU_WHEEL.bytes/1024/1024).toFixed(1)} MiB，另需 Python/依赖与安装空间。此行不切换物理引擎。`})
  providerCache={at:Date.now(),rows}
  return rows
 }
 const micromambaPath=()=>[join(PRODUCT_ROOT_FOR_ENGINE,".runtime/bin/micromamba"),join(PRODUCT_ROOT_FOR_ENGINE,"runtime/micromamba/micromamba")].find(existsSync)??join(PRODUCT_ROOT_FOR_ENGINE,"runtime/micromamba/micromamba")
 const installScriptPath=()=>join(PRODUCT_ROOT_FOR_ENGINE,"distribution/linux/install-provider")
 const installer=createProviderInstaller({root:join(PRODUCT_ROOT_FOR_ENGINE,".runtime/provider-attempts"),cwd:PRODUCT_ROOT_FOR_ENGINE,scriptPath:installScriptPath(),env:{LYAPUNOV_MICROMAMBA:micromambaPath(),LYAPUNOV_NODE_BIN:process.execPath},jobs:ctx.jobs,subprocess:ctx.subprocess,readLicense:()=>readEngineLicenses().isaac,onSettled:()=>{providerCache=undefined;clearSdkImportCache()}})
 installer.recover()
 if(privacyMode==="developer")ctx.tools.register(defineTool({
  name:"engine_install",
  description:"Install MuJoCo, Isaac Sim, or Newton through the existing native Provider installer after the user explicitly confirms the installation intent in this session. Accept only a confirmed provider from the closed set. Do not accept or generate EULA parameters, install an unknown engine, or duplicate process/Jobs lifecycle logic.",
  parameters:{input:{type:"object",required:true,additionalProperties:false,properties:{provider:{type:"string",enum:["mujoco","isaac","newton"],description:"Engine already confirmed in the current session."}}}},
  output:{schema:{type:"json"},render:(_args,value)=>[{type:"text",text:JSON.stringify(value)}]},
  execute:async(args,exec)=>{
   const input=(args.input??args) as {provider?:unknown}
   if(typeof input.provider!=="string"||!( ["mujoco","isaac","newton"] as string[]).includes(input.provider))throw new Error("ENGINE_INSTALL_PROVIDER_INVALID")
   const key=sessionKeyOf((exec as {agent?:unknown}).agent)
   if(!engineInstallAuthorization.consume(key,input.provider))throw new Error("ENGINE_INSTALL_CONFIRMATION_REQUIRED")
   return JSON.parse(JSON.stringify(installer.start(input.provider,false))) as never
  },
 }))
 ctx.effect(()=>async()=>{await installer.dispose()},"lyapunov-shell: provider installer cleanup")
 ctx.effect(()=>ctx.jobs.attachController("lyapunov-shell: provider installer API"),"lyapunov-shell: provider installer API controller")
 /**
  * FastGS 外部可选工具（用户决定：算法/CUDA/权重/数据都不随包分发）。
  *
  * 与物理引擎**分节、分 kind**：它不出现在 `--engine` 选择里，只是设置里的「外部工具」。
  * 界面与 CLI 走同一份桥接实现（`packages/lyapunov-product-bundle/src/fastgs-external.ts`）；
  * 下载/安装是长任务走原生 Jobs；doctor 的判据是真跑解释器 import torch，不是看目录。
  */
 let fastgsJob:{action:"download"|"install";startedAt:number;running:boolean;log:string[];result:FastGSReceipt|{status:string;message:string}|null}|undefined
 let fastgsStatusCache:{at:number;value:FastGSStatus}|undefined
 const fastgsLog=(line:string)=>{if(!fastgsJob?.running)return;fastgsJob.log.push(line);if(fastgsJob.log.length>500)fastgsJob.log.splice(0,fastgsJob.log.length-500)}
 const fastgsStatusCached=async():Promise<FastGSStatus>=>{
  if(fastgsStatusCache&&Date.now()-fastgsStatusCache.at<5000)return fastgsStatusCache.value
  const value=await fastgsStatus({productRoot:PRODUCT_ROOT_FOR_ENGINE},{log:fastgsLog})
  fastgsStatusCache={at:Date.now(),value}
  return value
 }
 const fastgsRun=(action:"download"|"install")=>{
  if(fastgsJob?.running)return fastgsJob
  const state:{action:"download"|"install";startedAt:number;running:boolean;log:string[];result:FastGSReceipt|{status:string;message:string}|null}={action,startedAt:Date.now(),running:true,log:[],result:null}
  fastgsJob=state
  ctx.jobs.start({kind:"fastgs-external",label:`FastGS ${action}`,outputLimitBytes:8000,run:job=>{
   // 真实取消：AbortController 的 signal 进 helper，取消时停本任务的子进程/子树；不波及其它进程。
   const controller=new AbortController()
   const log=(line:string)=>{fastgsLog(line);job.append(line.endsWith("\n")?line:line+"\n")}
   const done=(async()=>{
    try{
     const receipt=action==="download"?await fastgsDownload({productRoot:PRODUCT_ROOT_FOR_ENGINE},{log,signal:controller.signal}):await fastgsInstall({productRoot:PRODUCT_ROOT_FOR_ENGINE},{log,signal:controller.signal})
     state.result=receipt
     // 回执 BLOCKED/FAILED 也按真实结果终结，不能一律 Job completed。
     return {status:(receipt.status==="OK"?"completed":"failed") as "completed"|"failed",result:JSON.stringify(receipt)}
    }catch(error){
     state.result={status:"FAILED",message:error instanceof Error?error.message:String(error)}
     return {status:(controller.signal.aborted?"killed":"failed") as "killed"|"failed",result:JSON.stringify(state.result)}
    }finally{state.running=false;fastgsStatusCache=undefined}
   })()
   return {cancel:()=>controller.abort(),done}
  }})
  return state
 }
 // 设置「外部工具」读同一份状态；download/install 走 Jobs，doctor 直接读真实依赖。
 register("fastgs-tool",["GET","POST"],async request=>{
  if(request.method==="POST"){
   const body=await request.json() as {action?:unknown}
   const action=typeof body.action==="string"?body.action:""
   if(action!=="download"&&action!=="install"&&action!=="doctor")throw new Error(`FASTGS_ACTION_INVALID: ${action}`)
   if(action==="doctor")return Response.json({tool:await fastgsStatus({productRoot:PRODUCT_ROOT_FOR_ENGINE})})
   if(fastgsJob?.running)return Response.json({tool:await fastgsStatusCached(),install:fastgsJob,code:"FASTGS_ALREADY_RUNNING"})
   return Response.json({tool:await fastgsStatusCached(),install:fastgsRun(action)})
  }
  return Response.json({tool:await fastgsStatusCached(),install:fastgsJob??null})
 })
 ctx.tools.register(defineTool({
  name:"fastgs_external",
  description:`Acquire/install/check the official FastGS (${FASTGS_REPOSITORY} @ ${FASTGS_COMMIT}) external tool on demand. Source, CUDA environment, weights, and data remain in the local runtime directory under the product root (default .runtime/fastgs-external), are not bundled, and do not automatically start training. action: download fetches official source and checks the actual checkout and required entries; install builds the isolated official environment.yml environment or reuses LYAPUNOV_FASTGS_PYTHON; doctor checks torch and the three required official CUDA extensions (diff_gaussian_rasterization_fastgs, simple_knn._C, fused_ssim). An unavailable CUDA runtime is not trainable.`,
  parameters:{input:{type:"object",required:true,additionalProperties:false,properties:{action:{type:"string",enum:["download","install","doctor"],description:"Action."}}}},
  output:{schema:{type:"json"},render:(_args,value)=>[{type:"text",text:JSON.stringify(value)}]},
  execute:async(args)=>{
   const input=(args.input??args) as {action?:unknown}
   if(input.action==="doctor")return JSON.parse(JSON.stringify(await fastgsStatus({productRoot:PRODUCT_ROOT_FOR_ENGINE}))) as never
   if(input.action!=="download"&&input.action!=="install")throw new Error(`FASTGS_ACTION_INVALID: ${String(input.action)}`)
   const state=fastgsRun(input.action)
   return JSON.parse(JSON.stringify({action:input.action,startedAt:state.startedAt,running:state.running,cli:`./lyapunov fastgs ${input.action}`})) as never
  },
 }))
 ctx.commands.register({name:"fastgs_external",description:"Use the same FastGS download/install/doctor operation as the external-tools settings (download|install|doctor). This does not implement training. Only when the user explicitly supplies dataset/output does the CLI forward training to the official train.py.",input:{hint:'{"action":"download|install|doctor"}'},recordInput:false,handler:async invocation=>{
  const input=JSON.parse(invocation.rawInput||"{}") as {action?:unknown}
  if(input.action==="doctor")return {kind:"success",text:JSON.stringify(await fastgsStatus({productRoot:PRODUCT_ROOT_FOR_ENGINE}))}
  if(input.action!=="download"&&input.action!=="install")throw new Error(`FASTGS_ACTION_INVALID: ${String(input.action)}`)
  const state=fastgsRun(input.action)
  return {kind:"success",text:JSON.stringify({action:input.action,startedAt:state.startedAt,running:state.running,cli:`./lyapunov fastgs ${input.action}`})}
 }})
 /**
  * 写引擎偏好：**命令与设置界面共用这一份**（唯一 owner 仍是 `script/engine-preference.ts`）。
  * 只写偏好文件——引擎在 Host 启动时装配 Provider，运行中换不了；界面明示"下次启动生效"。
  *
  * 复核点 3：`"auto"` 是**偏好层**的显式"回到自动"取值（清除 `engine` 键，落回缺省/自动判定）。
  * 它不新增配置 owner：仍走同一偏好文件、同一个 endpoint；CLI/环境变量的显式引擎依旧优先。
  */
 const applyEnginePreference=(requested?:unknown)=>{
  if(requested!==undefined&&(typeof requested!=="string"||!isEnginePreferenceValue(requested)))throw new Error(`ENGINE_CHOICE_INVALID: ${String(requested)}（可选 ${AUTO_ENGINE}/${ENGINE_CHOICES.join("/")}）`)
  if(requested!==undefined){writeEnginePreference(requested);providerCache=undefined}
  const clearing=requested===AUTO_ENGINE
  const decision=engineDecision()
  return {runningEngine:decision.running,preference:decision.preference,choices:ENGINE_CHOICES,
   // 下次启动会采用谁、为什么（上游原话）：界面据此说清"偏好已存，重启后生效"，不在这里另编解释。
   nextEngine:decision.next?.engine??null,nextSource:decision.next?.source??null,nextReason:decision.next?.reason??null,
   restartRequired:requested!==undefined,
   restartHint:clearing
    ?"已回到自动（Isaac GPU 优先）：显式偏好已清除。引擎在 Host 启动时装配，下次启动生效；运行中的会话、动作与当前世界不受影响。"
    :"偏好已保存。引擎在 Host 启动时装配，请用 `--engine <引擎>`（或清空该参数以采用偏好）重启工作台后生效；运行中的会话与动作不会被打断。"}
 }
 // 物理引擎切换：**只写用户偏好，不重启 Host**。
 // 引擎在 Host 启动时装配（Provider 独占 world 的 model/data/clock，合同 §0.2/§2.8），
 // 运行中换引擎等于换 Provider，必须重启；在 UI 里偷偷重启会打断活动会话与运行中的动作。
 // 所以这条命令干两件事：把偏好写进唯一 owner（`script/engine-preference.ts`），
 // 并把"当前/下次启动生效的引擎 + 需要用户执行的重启命令"原样回给界面，让用户自己决定何时重启。
 ctx.commands.register({name:"ui_engine_switch",description:`Read/write the physics engine preference (${ENGINE_PREFERENCE_CHOICES.join("|")}). Only the preference file changes; the Host is not restarted. Apply the change by restarting with the command in the receipt.`,input:{hint:`{"engine":"${ENGINE_PREFERENCE_CHOICES.join('"|"')}"}; ${AUTO_ENGINE} clears the explicit preference and returns to automatic selection; omitting engine is read-only.`},recordInput:false,handler:async invocation=>{
  const input=JSON.parse(invocation.rawInput||"{}") as {engine?:unknown}
  return {kind:"success",text:JSON.stringify(applyEnginePreference(input.engine))}
 }})
 /**
  * W22：computer-use 的**用户同意**与**会话结束**（两条都是用户动作，不由模型自称）。
  *
  * 为什么同意要单独一条命令：没有窗口目标的合成输入只能进用户的活动桌面会话（全局层），
  * 那正是用户投诉的那条路径。所以"必要时走全局层"必须是用户显式点出来的许可，
  * 而不是模型一句"我需要"就成立。撤销同样显式：同意可以随时收回，收回即刻生效。
  */
 ctx.commands.register({name:"ui_computer_use_consent",description:"Let the user explicitly grant/revoke permission for global computer-use input. Input without a window target enters the user's active desktop session and may be captured by global desktop/WM shortcuts. Consent lasts only for this Host run; actual global input also requires a visible notification/accessibility status indicator.",input:{hint:'{consent:true|false, reason?}'},recordInput:false,handler:async invocation=>{
  const input=JSON.parse(invocation.rawInput||"{}") as {consent?:unknown;reason?:unknown}
  if(typeof input.consent!=="boolean")throw new Error("COMPUTER_USE_CONSENT_REQUIRED: input.consent 必须是 true/false（同意与否是用户动作，不能省略）")
  cuaConsent={consent:input.consent,reason:typeof input.reason==="string"&&input.reason.trim()?input.reason.trim().slice(0,200):null}
  if(!input.consent)await closeComputerUseSessionNow("consent-revoked")
  return {kind:"success",text:JSON.stringify({consent:cuaConsent.consent,consentReason:cuaConsent.reason,computerUse:computerUseFacts(),note:cuaConsent.consent?"已记录用户同意：仅在可见指示生效时才会发全局输入。":"已收回同意：没有窗口目标的输入一律拒绝。"})}
 }})
 ctx.commands.register({name:"ui_computer_use_end",description:"End the computer-use session and unconditionally restore potentially affected desktop settings (a11y/input method/keyboard layout/accessibility status icon) from the pre-session snapshot, then extinguish the visible indicator. This also runs after 120 seconds idle and on Host unload.",input:{hint:"{} No arguments."},recordInput:false,handler:async invocation=>{
  const report=await closeComputerUseSessionNow(`explicit:${sessionKeyOf(invocation.agent)}`)
  return {kind:"success",text:JSON.stringify({ended:report!==undefined,report:report?{at:report.at,restored:report.restored,failed:report.failed,note:report.note,indicator:report.indicator}:null,computerUse:computerUseFacts()})}
 }})
 /**
  * 客户端批注 → 可落盘、可交给模型的行。锚点已在客户端换算成**实体局部坐标**（换视角/移动实体不走位的
  * 唯一依据），这里只做形状与归属校验：实体必须真在当前 Scene 快照里，sceneId 必须与本次采集一致。
  * 任何不合规的一条直接拒绝整次采集——批注与截图必须同源同帧，缺一条就可能让模型按错误的图说话。
  */
 const annotationRowsOf=(value:unknown,sceneId:string|undefined,entityIds:Set<string>)=>{
  if(value===undefined)return []
  if(!Array.isArray(value)||value.length===0||value.length>200)throw new Error("ANNOTATION_ROWS_INVALID")
  return value.map((row,index)=>{
   const item=(row??{}) as {index?:unknown;annotationId?:unknown;entityId?:unknown;entity?:unknown;text?:unknown;anchor?:unknown}
   const anchor=annotationAnchorOf(item.anchor)
   if(typeof item.annotationId!=="string"||!item.annotationId)throw new Error(`ANNOTATION_ID_REQUIRED:${index}`)
   if(typeof item.entityId!=="string"||!entityIds.has(item.entityId))throw new Error(`ANNOTATION_ENTITY_NOT_IN_SCENE:${String(item.entityId)}`)
   if(!anchor||anchor.entityId!==item.entityId)throw new Error(`ANNOTATION_ANCHOR_INVALID:${item.annotationId}`)
   if(typeof item.text!=="string"||item.text.length>2000)throw new Error(`ANNOTATION_TEXT_INVALID:${item.annotationId}`)
   return {index:index+1,annotationId:item.annotationId,sceneId,entityId:item.entityId,...typeof item.entity==="string"?{entity:item.entity}:{},text:item.text,anchor}
  })
 }
 ctx.commands.register({name:"viewer_capture",description:"Save the client's current Three/Spark image as a native DSH attachment and record camera and scene/world/frame provenance.",input:{hint:"Image and camera parameters as JSON."},recordInput:false,handler:async invocation=>{
  const input=JSON.parse(invocation.rawInput)
  const sessionKey=sessionKeyOf(invocation.agent)
  const observeId=typeof input.observeId==="string"&&input.observeId?input.observeId:undefined
  /**
   * 带 `observeId` 的回传先核对"这次观察还在不在、这图是不是它的"，**再决定要不要落盘**（P2-2）。
   *
   * 从前是"先附件化 + 写盘，再核对归属"：于是超时/取消之后迟到的图、别的窗口/别的版本的图，全都留在了
   * 场景的采集列表里（`state` 把它交给工作台"图像"面板），成了与任何观察无关的条目。
   * 核对用的是与交付时**同一份**判据（`observeAgainst`）：不符就返回 `saved:false` 的回执，不写附件、不写记录。
   * 两类不符仍然分开处理：别会话/别窗口不结束等待（目标窗口还会自己送图）；归属对但图不对版才把这次观察判失败。
   * 没有 `observeId` 的普通采集（用户点"采集图像"）走原路，一点没变。
   */
  const observeRefusal=():{matched:boolean;settled:boolean;refused:string}|undefined=>{
   if(!observeId)return undefined
   const waiter=observeWaiters.get(observeId)
   if(!waiter)return {matched:false,settled:false,refused:"VIEWER_OBSERVE_NOT_ACTIVE: 这次观察已经结束（超时/取消/已交付），迟到的回传不落盘，也不算这次观察的结果"}
   // 等"相机应用"的 id 不属于采集回传：不落盘、也不替它下结论（它等的是读数，不是图）。
   if(waiter.kind!=="capture")return {matched:false,settled:false,refused:"VIEWER_OBSERVE_NOT_ACTIVE: 这个 id 上等的是相机应用（不是采集），这次回传不落盘"}
   const mismatch=observeAgainst(waiter,{sessionKey,clientId:input.clientId,sceneId:input.sceneId,sceneRevision:input.sceneRevision})
   if(!mismatch)return undefined
   return {matched:false,settled:mismatch.kind==="version"?failObservation(observeId,mismatch.reason):false,refused:mismatch.reason}
  }
  /**
   * 撤销本次采集**新建的**产物：`captureId` 的记录文件与位姿文件（只删本次自己生成的那两个 UUID 命名文件）。
   * **不删原生附件对象**——它在 `ctx.attachments` 的库里，可能还有别的引用，引用计数与清理由那一层负责；
   * 跨层删共享对象会把别人还在用的附件一起弄没。能保证的是：过期的回传不会在场景采集列表
   * （`captures/*.json`，`state` 把它交给工作台"图像"面板）里新增条目，位姿文件也不留孤本。
   */
  const discardCaptureArtifacts=async(capture:CaptureRecord)=>{
   try{await unlink(capturePath(sessionKey,capture.captureId))}catch{/* 没写成就不存在，忽略 */}
   if(capture.posePath)try{await unlink(capture.posePath)}catch{/* 同理 */}
  }
  const earlyRefusal=observeRefusal()
  if(earlyRefusal)return {kind:"success",text:JSON.stringify({saved:false,observe:{requestId:observeId,...earlyRefusal}})}
  const snapshot=await sceneSnapshot(sessionKey,input.sceneId)
  if(!Number.isInteger(input.sceneRevision)||input.sceneRevision<0||input.sceneRevision>snapshot.revision)throw new Error("CAPTURE_SCENE_REVISION_INVALID")
  let feedbackClientId:string|undefined,feedbackError:string|undefined
  try{feedbackClientId=feedbackWindow(sessionKey,input.sceneId,input.sceneRevision,input.clientId)}
  catch(error){feedbackError=error instanceof Error?error.message:String(error)}
  if(typeof input.dataURL!=="string"||!input.dataURL.startsWith("data:image/png;base64,"))throw new Error("CAPTURE_PNG_REQUIRED")
  /**
   * 采集来源：前端没标就是 `native-viewer`（窗口里那一帧）；标了就必须是已知来源。
   * `native-viewer-camera`（按指定相机在同一台原生 Viewer 上出的图）另走一套载荷自检——
   * 这类图的全部用处就是"图里的像素与那台相机的投影一一对应"，所以内参/图片尺寸/投影矩阵必须先自洽；
   * 自检不过就**不落盘**（附件化之前就拒一次，省得白解码一张派不上用场的图）。
   */
  const declaredSource=typeof input.source==="string"?input.source:undefined
  if(declaredSource!==undefined&&!(CAPTURE_SOURCES as readonly string[]).includes(declaredSource))throw new Error(`CAPTURE_SOURCE_UNKNOWN: 未知的采集来源 ${declaredSource}（可选 ${CAPTURE_SOURCES.join("/")}）`)
  const captureSource:CaptureSource=declaredSource==="native-viewer-camera"?"native-viewer-camera":"native-viewer"
  // 反方向也要挡住：载荷带的是"按指定相机出图"的读数（出图尺寸/请求内参），来源却标成当前画布截图
  // ——那是把相机渲染图记成屏幕画面，比丢一个字段更糟（记录会指着这份像素说"这就是窗口里那一帧"）。
  // 画布截图（`capture()`）没有这几个字段，所以这里不会误伤正常采集。
  if(captureSource!=="native-viewer-camera"){
   const renderShaped=["imageWidth","imageHeight","sourceIntrinsics"].filter(key=>input[key]!==undefined)
   if(renderShaped.length)throw new Error(`VIEWER_RENDER_CAMERA_PROVENANCE_INVALID: 载荷带着按指定相机出图的读数（${renderShaped.join("、")}），来源却是 ${captureSource}；这张图不能当成当前画布截图（viewer_observe 的 native-viewer）收下。按相机出的图请把 source 标成 native-viewer-camera 并带齐 camera 读数。`)
  }
  if(captureSource==="native-viewer-camera")cameraImageProvenance(input)
  // 拍之前应用的那台相机（前端在拍之前当场量到的读数）：形状对就原样落盘，于是"这张图是哪台相机拍的"有据可查。
  const cameraApply=input.appliedCamera&&typeof input.appliedCamera==="object"&&!Array.isArray(input.appliedCamera)?input.appliedCamera as Record<string,unknown>:undefined
  const annotationRows=annotationRowsOf(input.annotations,input.sceneId,new Set(snapshot.entities.map(entity=>entity.entityId)))
  // 位姿与"喂给模型的说明"都随采集落盘：说明是给模型看的正本，位姿是重建"这张图什么视角"的依据。
  if(input.prompt!==undefined&&(typeof input.prompt!=="string"||input.prompt.length>20000))throw new Error("ANNOTATION_PROMPT_INVALID: 说明必须是最多 20000 字符的文字")
  const promptRow=typeof input.prompt==="string"&&input.prompt.trim()?input.prompt.trim():undefined
  let resolvedWorldSceneRevision: number|undefined, resolvedFrameSceneRevision: number|undefined
  if(input.worldId){
   // 世界按**本次调用的会话**取：同名 worldId 在别的会话里是另一个世界（本会话没有这个实例就当没有这个 world）。
   const sim=existingSimFor(sessionKey);if(!sim)throw new Error("PROVIDER_UNAVAILABLE")
   const world=(await sim.listWorlds()).find(world=>world.worldId===input.worldId)
   if(!world||world.sceneId!==input.sceneId||world.worldGeneration!==input.generation)throw new Error("STALE_CAPTURE_GENERATION")
   const current=await sim.observe(input.worldId)
   if(!Number.isInteger(input.stepIndex)||input.stepIndex>current.stepIndex)throw new Error("INVALID_CAPTURE_STEP")
   // 只有 Scene 文档、world 已应用版本和生成该图像的帧版本一致时，
   // 才能把截图标为当前观察。旧持久帧可能没有 sceneRevision，保持 unknown。
   let frameRevision=Number.isInteger(input.frameSceneRevision)?input.frameSceneRevision:undefined
   const worldRevision=Number.isInteger(input.worldSceneRevision)?input.worldSceneRevision:world.appliedSceneRevision
   const observedRevision=Number.isInteger(current.sceneRevision)?current.sceneRevision:undefined
   // 老客户端若省略 frameSceneRevision，只能在 frameId 与当前实时帧
   // 完全一致时解析；否则保持 unknown 并拒绝，不能把历史帧冒充当前版本。
   if(frameRevision===undefined&&typeof input.frameId==='string'&&input.frameId===current.frameId&&observedRevision!==undefined)frameRevision=observedRevision
   resolvedWorldSceneRevision=worldRevision
   resolvedFrameSceneRevision=frameRevision
   if(worldRevision!==world.appliedSceneRevision||observedRevision!==world.appliedSceneRevision||input.sceneRevision!==world.appliedSceneRevision||frameRevision!==world.appliedSceneRevision){
    throw new Error(`STALE_CAPTURE_SCENE_REVISION scene=${String(input.sceneRevision)} world=${String(world.appliedSceneRevision)} frame=${frameRevision===undefined?"unknown":String(frameRevision)}`)
   }
  }
  // 等快照（以及上面的世界/版本核对）之后再看一次：取消或超时可能就发生在这段在途时间里；
  // 这时**什么都不写**，回执里的 settled 只能是 false——请求已经过期，不能报告这次等待被它结束了。
  const expired=observeRefusal()
  if(expired)return {kind:"success",text:JSON.stringify({saved:false,observe:{requestId:observeId,...expired}})}
  const captureBytes=Buffer.from(input.dataURL.slice("data:image/png;base64,".length),"base64")
  const captureName=annotationRows.length?"场景批注.png":"场景采集.png"
  const attachment=await ctx.attachments.saveImage({data:captureBytes,mediaType:"image/png",name:captureName})
  // **原分辨率保留**：附件库会把超出它成像策略的图整体缩小后入库（缩过才带 `originalDimensions`），那份缩图是预览；
  // 出图的 K、批注坐标、下游取像素说的都是原图。最小正确办法：用同一附件库的 verbatim 文件通道 `saveFile`（逐字节、不缩放）
  // 把送来的原始 PNG 再存一份，`imagePath` 指向它，缩图留在 `attachment` 里，换算见 `cameraImage.preview` / `originalFrameNote`。
  const reducedFrame=attachment.originalDimensions
  const originalFile=reducedFrame?await ctx.attachments.saveFile({data:captureBytes,name:captureName}):undefined
  const originalPath=originalFile?ctx.attachments.fileHostPath(originalFile):undefined
  if(reducedFrame&&!originalPath)throw new Error(`CAPTURE_ORIGINAL_FRAME_UNSTORABLE: 附件库把这张图缩小入库（${String(reducedFrame.width)}×${String(reducedFrame.height)} → ${String(attachment.width)}×${String(attachment.height)}），但这个部署没有 verbatim 文件通道，原分辨率帧存不下来；不能拿缩图冒充原图落盘。`)
  const originalImage=reducedFrame&&originalPath&&originalFile?{path:originalPath,bytes:originalFile.bytes,width:reducedFrame.width,height:reducedFrame.height,mediaType:"image/png",storage:"verbatim" as const,attachmentId:String(originalFile.attachmentId)}:undefined
  // **附件化之后再核一次观察**（2026-09-20 审查报的在途窗口）：`saveImage` 要真的解码/压缩这张图，
  // 这段时间足够一次超时/取消发生。这时**记录一分都不写**；附件对象本身不在这里删（见 `discardCaptureArtifacts`：
  // 它属于原生附件库，可能已编码入库，清理由那一层负责）。回执只能是 saved:false + settled:false。
  const expiredAfterAttachment=observeRefusal()
  if(expiredAfterAttachment)return {kind:"success",text:JSON.stringify({saved:false,observe:{requestId:observeId,...expiredAfterAttachment}})}
  // 相机出图路径的最后一道核对：附件像素必须与相机读数对得上（附件化之后才有真实尺寸可比，判据仍是同一份
  // `cameraImageProvenance`）；对不上就不落盘、不返回图。缩过图时按上面的 `preview` 判据放行（缩的就是这张图才行）。
  const verifiedCameraImage=captureSource==="native-viewer-camera"?cameraImageProvenance({...input,attachment}):undefined
  // `imagePath` = 这张图的落盘正本：缩过图时是上面那份原分辨率逐字节副本，没缩时就是附件对象本身。
  const imagePath=originalImage?.path??ctx.attachments.imageHostPath(attachment);if(!imagePath)throw new Error("CAPTURE_FILE_BACKEND_REQUIRED")
  // 采集时的**缺件警告**（`viewer_observe` 的载荷带过来的）：随记录一起落盘，观察结果才能如实说出"少了哪一部分"。
  // 只做最小整形（字符串、限长限量）——它是我们自己前端送来的事实，不在这里造第二套语义。普通用户采集不带它。
  const visualWarnings:Array<{entityId:string;warning:string}>=(Array.isArray(input.visualWarnings)?input.visualWarnings:[]).flatMap((row:any)=>row&&typeof row==="object"&&typeof row.entityId==="string"&&typeof row.warning==="string"?[{entityId:row.entityId,warning:row.warning.slice(0,500)}]:[]).slice(0,50)
  // 采集时的**环境光照事实**（Viewer 的 `capture()` / `renderCameraImage()` 带过来的窄面，与缺件警告一起走同一条载荷）：
  // 落盘后观察回执才能如实说出"请求的 HDRI 没装上、IBL 是内置光"。整形只认白名单字段（见 environment-capture.ts）。
  // 同一份 LOD 窄面（整形 = 只认白名单字段，不猜不造）：没有这一面就不写空壳。按距离正常简化时必须随图带上，
  // 否则数据集会把一份简化几何当成基础件。
  const lod=lodFaceFrom(input.lod)
  // 带了这一面但读不出来：把**原因**记进记录。`undefined` = 载荷里根本没有这一面（旧前端），两件事不能混。
  const lodIssue=lodFaceIssue(input.lod)
  const environment=environmentFaceFrom(input.environment)
  const capture:FeedbackCapture&CaptureCameraExtras={captureId:randomUUID(),sessionKey,...feedbackClientId?{clientId:feedbackClientId}:{},sceneId:input.sceneId,sceneRevision:input.sceneRevision,capturedAt:input.capturedAt??new Date().toISOString(),attachment,imagePath,...originalImage?{originalImage}:{},camera:input.camera,source:captureSource,...verifiedCameraImage?{cameraImage:verifiedCameraImage}:{},...cameraApply?{cameraApply}:{},...(annotationRows.length?{annotations:annotationRows}:{}),...(promptRow?{prompt:promptRow}:{}),...(visualWarnings.length?{visualWarnings}:{}),...(environment?{environment}:{}),...(lod?{lod}:{}),...(lodIssue?{lodIssue}:{}),...input.worldId?{worldId:input.worldId,generation:input.generation,frameId:input.frameId,stepIndex:input.stepIndex,simTime:input.simTime}:{}}
  capture.pins=capturePins(input.pins,capture)
  if(input.worldId){
   // Validation above may fill the world revision from the live world when an
   // older client omits it. Persist the resolved provenance rather than the
   // incomplete request, otherwise an accepted capture loses its source.
   capture.worldSceneRevision=resolvedWorldSceneRevision
   capture.frameSceneRevision=resolvedFrameSceneRevision
  }
  await mkdir(captureDirectory(sessionKey),{recursive:true,mode:0o700})
  if(input.camera?.quaternion?.length===4){
   const q=input.camera.quaternion,pose={...input.camera,rotation_quaternion:[q[3],q[0],q[1],q[2]],coordinate_system:"right-handed-z-up",fov_y_unit:"degree"}
   capture.posePath=join(captureDirectory(sessionKey),capture.captureId+".camera.json");await writeFile(capture.posePath,JSON.stringify(pose,null,2),{mode:0o600})
  }
  await writeFile(capturePath(sessionKey,capture.captureId),JSON.stringify(capture,null,2),{mode:0o600})
  // 建目录/写位姿/写记录这几段 await 里观察仍可能结束（超时/取消）：这时**不把这张图算成这次观察的结果**——
  // 撤掉本次新建的记录与位姿文件，如实回 saved:false + settled:false，绝不注入一个不匹配的结果。
  const expiredAfterWrite=observeRefusal()
  if(expiredAfterWrite){await discardCaptureArtifacts(capture);return {kind:"success",text:JSON.stringify({saved:false,observe:{requestId:observeId,...expiredAfterWrite}})}}
  // 主动观察的图走的**就是**上面这条落盘与来源校验：归属核对已经发生在写盘**之前**（上面的 `observeRefusal`），
  // 这里把结果交给等待者——用的是同一份判据、同一份会话身份（本次调用已解析的 agent，不取请求体里的 sessionId）。
  // 走到这一行说明入口、附件化前后及写盘后的核对都通过了；从最后一次核对到下面交付之间没有 await。
  // 即便如此，交付仍走共用的 `settleObservedCapture`——它找不到等待者时同样只回 settled:false，永远不谎报"这次等待被它结束了"。
  const observed=observeId?settleObservedCapture(observeId,{sessionKey,clientId:input.clientId,capture,attachment}):undefined
  // 图与说明在同一条原生 Inbox 消息内；保存成功与投递成功分别回执。
  let injected:{messageId:string;targetSession:string}|undefined
  if(input.inject===true){
   try{
    // 投递目标**只能是本次调用所在的会话**：请求体里的 sessionId 只算候选，先经核实链绑定（HTTP 里"带了
    // sessionId"不等于这条请求天然属于该会话），与调用方会话不一致就拒绝——否则 B 会话的窗口可以借一次采集
    // 往 A 会话里投一条自己拼的说明。
    const target=await bindSessionId(ctx,input.sessionId,"批注说明投递")
    if(target!==sessionKey)throw new Error(`CAPTURE_INJECT_SESSION_MISMATCH: 投递目标 ${target} 不是本次调用所在的会话 ${sessionKey}；说明不会投给别的会话`)
    if(feedbackError||!feedbackClientId)throw new Error(feedbackError??"CAPTURE_FEEDBACK_CLIENT_REQUIRED")
    const message=await feedbackMessage(capture,sessionKey,feedbackClientId,invocation.signal)
    // 同 viewer_annotation_send_ui：显式投到下一个 turn 边界并唤醒，避免 followup 那种"调用成功但消息不见"。
    invocation.agent.send(message as never,"next-turn",true)
    injected={messageId:message.id,targetSession:sessionKey}
   }catch(error){
    capture.injectionError=error instanceof Error?error.message:String(error)
    await writeFile(capturePath(sessionKey,capture.captureId),JSON.stringify(capture,null,2),{mode:0o600})
   }
  }
  // observe 回执把三件事分开：matched=这张图被认成了这次观察的结果；settled=这次等待被本次调用结束（可能是失败）；
  // refused=归属不符、什么都没做（这次观察继续等目标窗口）。
  return {kind:"success",text:JSON.stringify({...capture,...observeId?{observe:{requestId:observeId,matched:Boolean(observed?.matched),settled:Boolean(observed?.settled),...observed?.refused?{refused:observed.refused}:{}}}:{},...injected?{injectedMessageId:injected.messageId,injectedSession:injected.targetSession}:{}})}
 }})
 // Workbench 的一级“图像”面板不能要求用户手写 outputDir。这个窄命令
 // 仍然调用同一个真实 Sim Provider，只把输出目录收敛到当前账号的
 // captureRoot，并返回原生 RGB-D 与 named-camera 标定回执。
 ctx.commands.register({name:"sensor_capture_ui",description:"Capture RGB-D from the current simulation world; a named camera returns real pinhole intrinsics and world pose calibration.",input:{hint:"Simulation world and camera parameters as JSON."},recordInput:false,handler:async invocation=>{
  const input=JSON.parse(invocation.rawInput||"{}") as {sceneId?:string;sceneRevision?:number;worldId?:string;expectedGeneration?:number;cameraName?:string;width?:number;height?:number}
  if(typeof input.worldId!=="string"||typeof input.sceneId!=="string")throw new Error("SENSOR_CAPTURE_SCENE_WORLD_REQUIRED")
  if(!Number.isInteger(input.expectedGeneration))throw new Error("SENSOR_CAPTURE_GENERATION_REQUIRED")
  const sessionKey=sessionKeyOf(invocation.agent)
  const sim=existingSimFor(sessionKey)
  if(!sim)throw new Error("PROVIDER_UNAVAILABLE")
  const world=(await sim.listWorlds()).find(item=>item.worldId===input.worldId&&item.sceneId===input.sceneId&&item.status!=="closed")
  if(!world)throw new Error("SENSOR_CAPTURE_WORLD_NOT_FOUND")
  if(input.expectedGeneration!==world.worldGeneration)throw new Error("SENSOR_CAPTURE_GENERATION_MISMATCH")
  const snapshot=await sceneSnapshot(sessionKey,input.sceneId)
  if(snapshot.revision!==world.appliedSceneRevision||(input.sceneRevision!==undefined&&input.sceneRevision!==snapshot.revision))throw new Error("SENSOR_CAPTURE_SCENE_REVISION_MISMATCH")
  invocation.signal.throwIfAborted()
  const captureId=randomUUID(),outputDir=join(captureDirectory(sessionKey),"sensor",captureId)
  await mkdir(outputDir,{recursive:true,mode:0o700})
  const result=await sim.capture(world.worldId,{outputDir,...input.cameraName!==undefined?{cameraName:input.cameraName}:{},...input.width!==undefined?{width:input.width}:{},...input.height!==undefined?{height:input.height}:{}})
  if(result.worldId!==world.worldId||result.generation!==world.worldGeneration||result.sceneRevision!==snapshot.revision)throw new Error("SENSOR_CAPTURE_SOURCE_MISMATCH")
  // Provider 内部也会生成 captureId，但媒体目录已经按 Shell 的 captureId 建立；Shell
  // 的稳定 ID 必须覆盖 Provider ID，保证回执、URL 和磁盘目录指向同一份产物。
  const receipt={sceneId:input.sceneId,worldId:world.worldId,generation:world.worldGeneration,outputDir,...result,providerCaptureId:result.captureId,captureId}
  await writeFile(join(outputDir,"capture.json"),JSON.stringify(receipt,null,2),{mode:0o600})
  return {kind:"success",text:JSON.stringify(receipt)}
 }})
 // 多视角相机族的 UI 入口：只把输出目录收敛到当前账号 captureRoot、核对 world/Scene/代次归属，
 // 再转发给同一个 Sim Provider。真实渲染、标定、override 与标注点全部由 Provider 产生，
 // Viewer/Shell 不缓存任何相机物理状态，也不写源 MJCF/Scene 文档。
 const cameraDirectory=(sessionKey:string,id:string)=>{if(!/^[a-zA-Z0-9_-]+$/.test(id))throw new Error("INVALID_CAPTURE_ID");return join(captureDirectory(sessionKey),"camera",id)}
 const liveCameraWorld=async(sessionKey:string,worldId:string,sceneId:string,expectedGeneration?:number)=>{
  const sim=existingSimFor(sessionKey)
  if(!sim)throw new Error("PROVIDER_UNAVAILABLE")
  if(typeof worldId!=="string"||typeof sceneId!=="string")throw new Error("CAMERA_WORLD_REQUIRED")
  const world=(await sim.listWorlds()).find(item=>item.worldId===worldId&&item.sceneId===sceneId&&item.status!=="closed")
  if(!world)throw new Error("CAMERA_WORLD_NOT_FOUND")
  if(expectedGeneration!==undefined&&expectedGeneration!==world.worldGeneration)throw new Error("CAMERA_GENERATION_MISMATCH")
  const snapshot=await sceneSnapshot(sessionKey,sceneId)
  if(snapshot.revision!==world.appliedSceneRevision)throw new Error("CAMERA_SCENE_REVISION_MISMATCH")
  return {sim,world,snapshot}
 }
 const cameraListCache=new CameraUIReadCache<Record<string,unknown>>()
 /** 侧栏与模型共用一条持久安装操作。当前画面由指定Viewer只读采样；保存不进入pilot、不创建World。 */
 const saveSceneCamera=async(agent:unknown,input:CameraSceneSaveInput,signal:AbortSignal)=>{
  requireWritableScene(ctx,agent,'camera_scene_save')
  if(!input||typeof input.sceneId!=='string'||!Number.isInteger(input.expectedRevision)||input.expectedRevision<0||!['current-view','draft','install','native-preset','restore'].includes(input.mode))throw new Error('CAMERA_SAVE_INPUT_REQUIRED: 指定sceneId/expectedRevision/mode')
  signal.throwIfAborted()
  const sessionKey=sessionKeyOf(agent)
  if(await officialSceneFor(sessionKey,input.sceneId))throw new Error('CAMERA_SAVE_OFFICIAL_READ_ONLY')
  if(input.mode==='native-preset'&&(!Number.isInteger(input.expectedGeneration)||(input.expectedGeneration??0)<1))throw new Error('CAMERA_PRESET_GENERATION_REQUIRED')
  const snapshot=await sceneSnapshot(sessionKey,input.sceneId)
  if(snapshot.revision!==input.expectedRevision)throw new Error('CAMERA_SAVE_REVISION_STALE: 场景已变化，未保存相机')
  if(input.entityId!==undefined&&(typeof input.entityId!=='string'||!input.entityId))throw new Error('CAMERA_SAVE_ENTITY_INVALID')
  const entityId=input.entityId??randomUUID(),existing=snapshot.entities.find(entity=>entity.entityId===entityId)
  if(existing&&!existing.components.camera)throw new Error('CAMERA_SAVE_ENTITY_NOT_CAMERA: 不覆盖其他实体')
  let draft:SceneCameraDraft,source:import('../../lyapunov-contracts/src/types.ts').SceneCameraInstallation['source']='manual',sourceCameraName:string|undefined,bodies:ReturnType<typeof cameraMountBodies>=[]
  let sampled:CameraAuthoringSnapshot|undefined
  let installationSample:{sceneId:string;sceneRevision:number;worldId?:string;generation?:number;frameId?:string;stepIndex?:number}|undefined
  const installationWorld=async()=>{
   if(!Number.isInteger(input.expectedGeneration)||(input.expectedGeneration??0)<1)throw new Error('CAMERA_SAVE_GENERATION_REQUIRED')
   const scope=await liveCameraWorld(sessionKey,input.worldId!,input.sceneId,input.expectedGeneration)
   if(!['ready','running','paused'].includes(scope.world.status)||scope.snapshot.revision!==input.expectedRevision)throw new Error('CAMERA_SAVE_WORLD_STALE: 安装需要当前可用物理世界')
   return scope
  }
  if(input.mode==='current-view'){
   const prepared=await prepareCameraCall({agent,sceneId:input.sceneId,expectedRevision:input.expectedRevision,clientId:input.clientId,signal,prefix:'CAMERA_SAVE'})
   const outcome=await queueCameraApply({...prepared,args:{},signal,action:'sampleCameraViewer'})
   if(!outcome.ok)throw new Error(outcome.error)
   sampled={...outcome.value,view:outcome.value.state} as unknown as CameraAuthoringSnapshot
   const world=input.mount?(await installationWorld()).world:undefined
   if(input.mount&&!Number.isInteger(input.expectedGeneration))throw new Error('CAMERA_SAVE_GENERATION_REQUIRED')
   draft=cameraDraftFromSample(snapshot,sampled,{name:input.name??existing?.name,world,mount:input.mount})
   if(input.mount)bodies=cameraSampleBodies(snapshot,world,sampled)
   source='current-view'
  }else if(input.mode==='install'){
   if(!input.installation)throw new Error('CAMERA_INSTALL_INPUT_REQUIRED')
   const mount=input.mount??(existing?.components.camera as import('../../lyapunov-contracts/src/types.ts').SceneCameraComponent|undefined)?.mount
   const scope=mount?await installationWorld():undefined,receipt=scope?await scope.sim.listCameras(scope.world.worldId):undefined
   if(scope&&(!receipt||receipt.worldId!==scope.world.worldId||receipt.generation!==scope.world.worldGeneration||receipt.sceneRevision!==snapshot.revision||typeof receipt.frameId!=='string'||!Number.isInteger(receipt.stepIndex)))throw new Error('CAMERA_INSTALL_BODY_SOURCE_STALE')
   if(receipt)bodies=cameraMountBodies(receipt,snapshot.entities)
   let annotation:import('./camera-installation-input.ts').CameraInstallationAnnotation|undefined
   if(input.installation.annotationId!==undefined){
    if(typeof input.installation.annotationId!=='string'||!input.installation.annotationId||typeof input.installation.captureId!=='string'||!input.installation.captureId)throw new Error('CAMERA_INSTALL_ANNOTATION_ID_REQUIRED: use the annotationId and captureId returned by viewer_annotation_read')
    const capture=await readCapture(sessionKey,input.installation.captureId) as FeedbackCapture
    if(capture.sessionKey!==sessionKey||capture.sceneId!==snapshot.sceneId||capture.sceneRevision!==snapshot.revision)throw new Error('CAMERA_INSTALL_ANNOTATION_CAPTURE_STALE')
    const row=capture.annotations?.find(a=>a.annotationId===input.installation!.annotationId)
    if(!row)throw new Error('CAMERA_INSTALL_ANNOTATION_NOT_FOUND')
    annotation={...row,sceneId:capture.sceneId,sceneRevision:capture.sceneRevision}
   }
   draft=cameraDraftFromInstallation(snapshot,input.installation,{existing,name:input.name,mount,bodies,worldId:scope?.world.worldId,generation:scope?.world.worldGeneration,frameId:receipt?.frameId as string|undefined,stepIndex:receipt?.stepIndex as number|undefined,annotation})
   installationSample={sceneId:snapshot.sceneId,sceneRevision:snapshot.revision,...receipt?{worldId:receipt.worldId as string,generation:receipt.generation as number,frameId:receipt.frameId as string,stepIndex:receipt.stepIndex as number}:{}}
  }else{
   if(input.mode==='restore'){
    if(!existing)throw new Error('CAMERA_BASELINE_ENTITY_REQUIRED')
    draft=restoredCameraDraft(existing);source='scene-baseline'
   }else if(input.mode==='draft'){
    if(!input.draft||typeof input.draft!=='object'||['name','position','quaternion','fovYDeg','width','height','near','far','parentEntityId','bodyName'].some(field=>typeof (input.draft as unknown as Record<string,unknown>)[field]!=='string'))throw new Error('CAMERA_SAVE_DRAFT_REQUIRED: 提供完整人工安装字符串表单与可选intrinsics')
    draft={...input.draft,...input.name?{name:input.name}:{}}
   }else{
    if(!input.presetId)throw new Error('CAMERA_PRESET_ID_REQUIRED')
    const registered=snapshot.entities.flatMap(entity=>registeredCameraPresets(snapshot,entity.entityId)).find(preset=>preset.id===input.presetId)
    const scope=await installationWorld(),receipt=await scope.sim.listCameras(scope.world.worldId)
    if(receipt.worldId!==scope.world.worldId||receipt.generation!==scope.world.worldGeneration||receipt.sceneRevision!==snapshot.revision)throw new Error('CAMERA_PRESET_SOURCE_STALE')
    const preset=registered??nativeCameraPreset((Array.isArray(receipt.cameras)?receipt.cameras:[]).find((row:any)=>row.cameraName===input.presetId),receipt,snapshot.entities)
    draft={name:input.name??preset.name,position:preset.pose.positionM.join(' '),quaternion:preset.pose.quaternionXyzw.join(' '),parentEntityId:preset.mount?.entityId??'',bodyName:preset.mount?.bodyName??'',fovYDeg:String(preset.fovYDeg),width:String(preset.width),height:String(preset.height),near:String(preset.near),far:String(preset.far),intrinsics:preset.intrinsics}
    source=preset.source;sourceCameraName=preset.sourceCameraName
   }
   if(draft.parentEntityId){
    if(!Number.isInteger(input.expectedGeneration))throw new Error('CAMERA_SAVE_GENERATION_REQUIRED')
    const scope=await installationWorld(),receipt=await scope.sim.listCameras(scope.world.worldId)
    if(receipt.worldId!==scope.world.worldId||receipt.generation!==scope.world.worldGeneration||receipt.sceneRevision!==snapshot.revision)throw new Error('CAMERA_SAVE_BODY_SOURCE_STALE')
    bodies=cameraMountBodies(receipt,snapshot.entities)
   }
  }
  signal.throwIfAborted()
  if(draft.parentEntityId)await installationWorld()
  const saved=await sceneFor(sessionKey).scene.commit(cameraInstallationCommit(snapshot,draft,bodies,entityId,source,sourceCameraName))
  return {status:'SAVED',snapshot:saved,entityId,source,worldNeedsSync:Boolean(draft.parentEntityId||existingSimFor(sessionKey)),...(sampled?{sample:{sceneId:sampled.sceneId!,sceneRevision:sampled.sceneRevision!,...sampled.worldId!==undefined?{worldId:sampled.worldId}:{},...sampled.generation!==undefined?{generation:sampled.generation}:{},...sampled.frameId!==undefined?{frameId:sampled.frameId}:{},...sampled.stepIndex!==undefined?{stepIndex:sampled.stepIndex}:{}}}:installationSample?{sample:installationSample}:{}),note:'Installation saved in Scene. The existing World owner handles synchronization and native frame readback. Saving does not enter camera view.'}
 }
 ctx.tools.register(defineTool({name:'camera_scene_save',description:"Persist a camera using the sidebar's Scene CAS. install accepts typed installation: positionM in explicit referenceFrame=world|parent (parent is the selected real body origin, meters), normal as the viewing direction (-Z optical axis), optional up to define roll, or quaternionXyzw; fovYDeg is vertical degrees. Direction without up preserves the prior roll by shortest rotation. Use annotationId/captureId from viewer_annotation_read with the exact bodyName and optional body-local offsetM to install at its surface point/normal. A mount requires worldId/expectedGeneration and same-frame camera_list FK. Read real bodies or robot_presets; never guess a link/TCP/center from robot names. If a requested center is undefined, ask for a declared frame/offset or surface annotation. current-view samples complete K/resolution/clipping/pose from the specified window. draft uses the full human form. native-preset loads actual registered/native calibration; URDF has no implicit cameras, use declared sensor calibration. restore retains the original installation baseline. Editing never moves the robot. A temporary camera_adjust is not a persistent save.",parameters:{input:{type:'object',required:true,additionalProperties:false,properties:{sceneId:{type:'string',required:true},expectedRevision:{type:'integer',required:true},mode:{type:'string',enum:['current-view','draft','install','native-preset','restore'],required:true},entityId:{type:'string'},name:{type:'string'},clientId:{type:'string'},worldId:{type:'string'},expectedGeneration:{type:'integer'},presetId:{type:'string'},mount:{type:'object',additionalProperties:false,properties:{entityId:{type:'string',required:true},bodyName:{type:'string',required:true}}},installation:{type:'object',additionalProperties:false,properties:{referenceFrame:{type:'string',enum:['world','parent']},positionM:{type:'array',items:{type:'number'},description:'Exactly three finite components [x,y,z] in meters; invalid lengths are rejected before saving.'},annotationId:{type:'string'},captureId:{type:'string'},offsetM:{type:'array',items:{type:'number'},description:'Exactly three finite body-local offset components in meters; requires a real annotation.'},normal:{type:'array',items:{type:'number'},description:'Exactly three finite viewing-normal components; zero vectors are rejected.'},up:{type:'array',items:{type:'number'},description:'Exactly three finite up-vector components; zero or collinear vectors are rejected.'},quaternionXyzw:{type:'array',items:{type:'number'},description:'Exactly four finite quaternion components [x,y,z,w]; zero quaternions are rejected.'},fovYDeg:{type:'number'},width:{type:'integer'},height:{type:'integer'},near:{type:'number'},far:{type:'number'},intrinsics:{type:'object',additionalProperties:false,properties:{fx:{type:'number',required:true},fy:{type:'number',required:true},cx:{type:'number',required:true},cy:{type:'number',required:true},width:{type:'integer',required:true},height:{type:'integer',required:true}}}}},draft:{type:'object',additionalProperties:true,description:"Human installation form: name/position/quaternion/fovYDeg/width/height/near/far/parentEntityId/bodyName are strings; intrinsics contains fx/fy/cx/cy/width/height."}}}},output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async(args,exec)=>await saveSceneCamera((exec as {agent?:unknown}).agent,(args.input??args) as unknown as CameraSceneSaveInput,exec.signal) as any}))
 ctx.commands.register({name:'camera_scene_save',description:"Use the same persistent Scene camera save/install/mount/preset/restore operation as the natural-language Tool.",input:{hint:'{sceneId,expectedRevision,mode,entityId?,name?,clientId?,worldId?,expectedGeneration?,mount?,installation?,draft?,presetId?}'},recordInput:false,handler:async invocation=>({kind:'success',text:JSON.stringify(await saveSceneCamera(invocation.agent,JSON.parse(invocation.rawInput||'{}'),invocation.signal??new AbortController().signal))})})
 ctx.effect(()=>()=>cameraListCache.dispose(),"lyapunov-shell: UI camera query cache")
 // 自动轮询只读 UI 路由，不激活 Agent、不写 commandResult/Session 消息。
 register("camera-list",["GET"],async request=>{
  const query=new URL(request.url).searchParams,sessionKey=await bindSessionId(ctx,query.get("sessionId"),"相机清单")
  const generation=Number(query.get("expectedGeneration")),revision=Number(query.get("sceneRevision"))
  if(!query.has("expectedGeneration")||!Number.isInteger(generation)||!query.has("sceneRevision")||!Number.isInteger(revision))throw new Error("CAMERA_QUERY_IDENTITY_REQUIRED")
  request.signal.throwIfAborted()
  const {sim,world,snapshot}=await liveCameraWorld(sessionKey,query.get("worldId")??"",query.get("sceneId")??"",generation)
  if(snapshot.revision!==revision)throw new Error("CAMERA_SCENE_REVISION_MISMATCH")
  const key=JSON.stringify([sessionKey,snapshot.sceneId,snapshot.revision,world.worldId,world.worldGeneration])
  const value=await cameraListCache.read(key,async()=>{
   const result=await sim.listCameras(world.worldId)
   if(result.worldId!==world.worldId||result.generation!==world.worldGeneration||result.sceneRevision!==snapshot.revision)throw new Error("CAMERA_LIST_SOURCE_MISMATCH")
   return {sceneId:snapshot.sceneId,sceneRevision:snapshot.revision,worldId:world.worldId,generation:world.worldGeneration,...result}
  },query.get("force")==="1")
  const current=await liveCameraWorld(sessionKey,world.worldId,snapshot.sceneId,generation)
  if(current.snapshot.revision!==revision)throw new Error("CAMERA_SCENE_REVISION_MISMATCH")
  request.signal.throwIfAborted()
  return Response.json(uiCommandFields("camera_list_ui",value,productPathRoots,privacyMode==="developer"),{headers:{"cache-control":"private, no-store"}})
 })
 ctx.commands.register({name:"camera_list_ui",description:"Read real poses and vertical FOV of named cameras in the current world without modifying the model.",input:{hint:'{sceneId, worldId, expectedGeneration?}'},recordInput:false,handler:async invocation=>{
  const input=JSON.parse(invocation.rawInput||"{}") as {sceneId?:string;worldId?:string;expectedGeneration?:number}
  const {sim,world,snapshot}=await liveCameraWorld(sessionKeyOf(invocation.agent),input.worldId!,input.sceneId!,input.expectedGeneration)
  const result=await sim.listCameras(world.worldId)
  return {kind:"success",text:JSON.stringify({sceneId:input.sceneId,sceneRevision:snapshot.revision,worldId:world.worldId,generation:world.worldGeneration,...result})}
 }})
 const captureCameraViews=async(sessionKey:string,input:{sceneId?:string;sceneRevision?:number;worldId?:string;expectedGeneration?:number;cameraNames?:string[];width?:number;height?:number;geomGroups?:number[]},signal:AbortSignal)=>{
  if(!Array.isArray(input.cameraNames)||input.cameraNames.length===0)throw new Error("CAMERA_NAMES_REQUIRED")
  const {sim,world,snapshot}=await liveCameraWorld(sessionKey,input.worldId!,input.sceneId!,input.expectedGeneration)
  if(input.sceneRevision!==undefined&&input.sceneRevision!==snapshot.revision)throw new Error("CAMERA_SCENE_REVISION_MISMATCH")
  signal.throwIfAborted()
  const captureId=randomUUID(),directory=cameraDirectory(sessionKey,captureId)
  await mkdir(directory,{recursive:true,mode:0o700})
  const result=await sim.captureMulti(world.worldId,{outputDir:directory,cameraNames:input.cameraNames,...input.width===undefined?{}:{width:input.width},...input.height===undefined?{}:{height:input.height},...input.geomGroups===undefined?{}:{geomGroups:input.geomGroups}})
  // 同上：多视角媒体目录使用 Shell captureId；不能让 Provider 的内部 ID 覆盖它。
  const cameras=(result.cameras??result.captures) as any[]
  const first=cameras?.[0]
  const receipt={sceneId:input.sceneId,sceneRevision:snapshot.revision,worldId:world.worldId,worldGeneration:world.worldGeneration,outputDir:directory,...result,cameras,width:result.width??first?.width??first?.calibration?.intrinsics?.width,height:result.height??first?.height??first?.calibration?.intrinsics?.height,providerCaptureId:result.captureId,captureId}
  if(result.worldId!==world.worldId||result.generation!==world.worldGeneration||result.sceneRevision!==snapshot.revision)throw new Error("CAMERA_CAPTURE_SOURCE_MISMATCH")
  await writeFile(join(directory,"capture.json"),JSON.stringify(receipt,null,2),{mode:0o600})
  signal.throwIfAborted()
  return receipt
 }
 ctx.commands.register({name:"camera_capture_multi_ui",description:"Capture RGB-D and pinhole calibration from all named cameras in one call at one physics step. Artifacts remain under the configured captureRoot.",input:{hint:'{sceneId, worldId, expectedGeneration, cameraNames, width, height}'},recordInput:false,handler:async invocation=>{
  const input=JSON.parse(invocation.rawInput||"{}") as Parameters<typeof captureCameraViews>[1]
  return {kind:"success",text:JSON.stringify(await captureCameraViews(sessionKeyOf(invocation.agent),input,invocation.signal))}
 }})
 // 周期预览与工具采集使用同一 native operation；预览只回 UI，不注入 Session/AgentLoop。
 register("camera-preview",["POST"],async request=>{
  const sessionKey=await bindSessionId(ctx,new URL(request.url).searchParams.get("sessionId"),"相机预览"),input=await request.json() as Parameters<typeof captureCameraViews>[1]
  if(input.cameraNames?.length!==1)throw new Error("CAMERA_PREVIEW_SINGLE_CAMERA_REQUIRED")
  if(!Number.isInteger(input.expectedGeneration)||!Number.isInteger(input.sceneRevision))throw new Error("CAMERA_QUERY_IDENTITY_REQUIRED")
  const key=JSON.stringify(["preview",sessionKey,input.sceneId,input.sceneRevision,input.worldId,input.expectedGeneration,input.cameraNames,input.width,input.height])
  request.signal.throwIfAborted()
  const value=await cameraListCache.read(key,()=>captureCameraViews(sessionKey,input,request.signal))
  const current=await liveCameraWorld(sessionKey,input.worldId!,input.sceneId!,input.expectedGeneration)
  if(current.snapshot.revision!==input.sceneRevision)throw new Error("CAMERA_SCENE_REVISION_MISMATCH")
  request.signal.throwIfAborted()
  return Response.json(uiCommandFields("camera_capture_multi_ui",value,productPathRoots,privacyMode==="developer"),{headers:{"cache-control":"private, no-store"}})
 })
 ctx.commands.register({name:"camera_adjust_ui",description:"Set/clear temporary pose and FOV overrides for named cameras in the current world. Interpret positionM/quaternionXyzw by referenceFrame=world|parent; parent is the body-local installation pose updated from parent-body FK every frame. Only future capture/calibration receipts change; the source document does not.",input:{hint:'{sceneId, worldId, cameraName, expectedGeneration, referenceFrame, positionM, quaternionXyzw, fovyDeg, clear}'},recordInput:false,handler:async invocation=>{
  const input=JSON.parse(invocation.rawInput||"{}") as {sceneId?:string;worldId?:string;cameraName?:string;expectedGeneration?:number;referenceFrame?:string;positionM?:number[];quaternionXyzw?:number[];fovyDeg?:number;clear?:boolean}
  if(typeof input.cameraName!=="string"||!input.cameraName.trim())throw new Error("CAMERA_NAME_REQUIRED")
  if(!Number.isInteger(input.expectedGeneration))throw new Error("CAMERA_GENERATION_REQUIRED")
  if(input.referenceFrame!==undefined&&input.referenceFrame!=="world"&&input.referenceFrame!=="parent")throw new Error("CAMERA_REFERENCE_FRAME_INVALID")
  const {sim,world,snapshot}=await liveCameraWorld(sessionKeyOf(invocation.agent),input.worldId!,input.sceneId!,input.expectedGeneration)
  const result=await sim.adjustCamera(world.worldId,{cameraName:input.cameraName.trim(),expectedGeneration:world.worldGeneration,...input.referenceFrame===undefined?{}:{referenceFrame:input.referenceFrame as "world"|"parent"},...input.positionM===undefined?{}:{positionM:input.positionM as [number,number,number]},...input.quaternionXyzw===undefined?{}:{quaternionXyzw:input.quaternionXyzw as [number,number,number,number]},...input.fovyDeg===undefined?{}:{fovyDeg:input.fovyDeg},...input.clear===undefined?{}:{clear:input.clear}})
  return {kind:"success",text:JSON.stringify({sceneId:input.sceneId,sceneRevision:snapshot.revision,...result})}
 }})
 ctx.commands.register({name:"camera_annotation_ui",description:"Use pixels and metric depth from a real multiview capture to create camera/world-coordinate annotations and save their JSON under the configured captureRoot.",input:{hint:'{sceneId, worldId, cameraName, pixel, captureId?, depthM?}'},recordInput:false,handler:async invocation=>{
  const input=JSON.parse(invocation.rawInput||"{}") as {sceneId?:string;worldId?:string;cameraName?:string;pixel?:number[];captureId?:string;depthM?:number;width?:number;height?:number;geomGroups?:number[]}
  if(typeof input.cameraName!=="string"||!input.cameraName.trim())throw new Error("CAMERA_NAME_REQUIRED")
  if(!Array.isArray(input.pixel)||input.pixel.length!==2)throw new Error("CAMERA_PIXEL_REQUIRED")
  const sessionKey=sessionKeyOf(invocation.agent)
  const {sim,world,snapshot}=await liveCameraWorld(sessionKey,input.worldId!,input.sceneId!)
  let providerCaptureId=input.captureId,width=input.width,height=input.height
  if(providerCaptureId!==undefined){
   // UI 多视角回执的稳定 ID用于媒体目录，Provider注册表保留内部 ID；读取同一份
   // capture.json 做显式转换，避免把路径身份误当成物理采集身份。
   try{
    const stored=JSON.parse(await readFile(join(cameraDirectory(sessionKey,providerCaptureId),"capture.json"),"utf8")) as {captureId?:string;providerCaptureId?:string;cameras?:any[];captures?:any[]}
    providerCaptureId=stored.providerCaptureId??stored.captureId??providerCaptureId
    const camera=(stored.cameras??stored.captures??[]).find(row=>row.cameraName===input.cameraName||row.resolvedCameraName===input.cameraName)
    width??=camera?.width??camera?.calibration?.intrinsics?.width
    height??=camera?.height??camera?.calibration?.intrinsics?.height
   }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error}
  }
  const result=await sim.projectAnnotation(world.worldId,{cameraName:input.cameraName.trim(),pixel:input.pixel as [number,number],...providerCaptureId===undefined?{}:{captureId:providerCaptureId},...input.depthM===undefined?{}:{depthM:input.depthM},...width===undefined?{}:{width},...height===undefined?{}:{height},...input.geomGroups===undefined?{}:{geomGroups:input.geomGroups}})
  const annotationId=String((result as {annotationId?:unknown}).annotationId??randomUUID())
  const directory=join(captureDirectory(sessionKey),"annotations");await mkdir(directory,{recursive:true,mode:0o700})
  const annotationPath=join(directory,annotationId+".json")
  await writeFile(annotationPath,JSON.stringify({sceneId:input.sceneId,sceneRevision:snapshot.revision,worldId:world.worldId,worldGeneration:world.worldGeneration,...result},null,2),{mode:0o600})
  return {kind:"success",text:JSON.stringify({...result,sceneId:input.sceneId,sceneRevision:snapshot.revision,annotationId,annotationPath})}
 }})
 ctx.commands.register({name:"camera_dataset_export_ui",description:"Export real multiview captures from the camera panel as training data. Explicitly convert Shell captureId to the Provider registry ID at the boundary and restrict output to the configured captureRoot.",input:{hint:'{sceneId, worldId, expectedGeneration, captureIds}'},recordInput:false,handler:async invocation=>{
  const input=JSON.parse(invocation.rawInput||"{}") as {sceneId?:string;worldId?:string;expectedGeneration?:number;captureIds?:string[]}
  if(!Array.isArray(input.captureIds)||input.captureIds.length===0)throw new Error("CAMERA_CAPTURE_IDS_REQUIRED")
  const sessionKey=sessionKeyOf(invocation.agent)
  const {sim,world,snapshot}=await liveCameraWorld(sessionKey,input.worldId!,input.sceneId!,input.expectedGeneration)
  const providerCaptureIds:string[]=[]
  for(const shellCaptureId of input.captureIds){
   if(typeof shellCaptureId!=="string"||!shellCaptureId.trim())throw new Error("CAMERA_CAPTURE_ID_REQUIRED")
   const stored=JSON.parse(await readFile(join(cameraDirectory(sessionKey,shellCaptureId.trim()),"capture.json"),"utf8")) as {captureId?:string;providerCaptureId?:string}
   providerCaptureIds.push(stored.providerCaptureId??stored.captureId??shellCaptureId.trim())
  }
  const datasetId=randomUUID(),outputDir=join(captureDirectory(sessionKey),"datasets",datasetId);await mkdir(outputDir,{recursive:true,mode:0o700})
  const result=await sim.exportCameraDataset(world.worldId,{worldId:world.worldId,outputDir,captureIds:providerCaptureIds} as any)
  return {kind:"success",text:JSON.stringify({sceneId:input.sceneId,sceneRevision:snapshot.revision,worldId:world.worldId,worldGeneration:world.worldGeneration,datasetId,outputDir,shellCaptureIds:input.captureIds,providerCaptureIds,...result})}
 }})
 /**
  * `ui_action_ack` 的 id 列表：`ids` 优先；`results:[{id,ok,error,clientId?}]` 是"这条动作被这个窗口消费了"的
  * 带结果等价形式（失败也要确认出队，否则同一张没拍成的图会被反复重试）。返回 undefined = 形状不合格。
  * 出队与 settle 都只认这里的 id；`results` 行里的 `clientId` 用来核对"是哪个窗口报的"。
  */
 const ackedIds=(input:unknown):string[]|undefined=>{
  const value=input as {ids?:unknown;results?:unknown}|undefined
  if(Array.isArray(value?.ids))return value.ids.every(id=>typeof id==="string")?value.ids as string[]:undefined
  if(Array.isArray(value?.results))return value.results.map(row=>(row as {id?:unknown}|undefined)?.id).filter((id):id is string=>typeof id==="string")
  return undefined
 }
 /**
  * 定向动作（`args.clientId` 指定了唯一目标窗口）：只有那个窗口自己的确认能把它们出队、下结论。
  * 采集与相机（应用/出图）与模型排的界面动作走的是同一套归属，所以它们共用这一张表，
  * 而不是三处各写一遍判断。
  */
 /** 回执载荷（成功行里的 `value`）体积上限：正常相机读数几 KB；异常大的直接拒绝，不让它落进会话投影与日志。 */
 const MAX_ACK_VALUE_BYTES=200_000
 /**
  * 本次 ack 自报的窗口身份：顶层 `clientId` 优先；没有就看这一条 id 对应的结果行里的 `clientId`
  * （前端报"这次采集失败"时本来就带它）。两者都没有 = 无法证明是谁确认的。
  */
 const ackClientId=(input:unknown,id?:string):string|undefined=>{
  const value=input as {clientId?:unknown;results?:unknown}|undefined
  if(typeof value?.clientId==="string"&&value.clientId)return value.clientId
  if(id===undefined||!Array.isArray(value?.results))return undefined
  const row=value.results.find(candidate=>(candidate as {id?:unknown}|undefined)?.id===id) as {clientId?:unknown}|undefined
  return typeof row?.clientId==="string"&&row.clientId?row.clientId:undefined
 }
 /**
  * 一条被确认的动作能不能就此出队。
  *
  * 普通界面动作照旧：谁的会话队列 + id 对上就出队（本次调用所在会话已由队列键保证，与既有行为一致）。
  * `captureViewer` / `applyCameraViewer` / `renderCameraViewer` 是**定向**请求——`args.clientId` 指定了唯一目标窗口，
  * 所以只有那个窗口自己的 ack 能把它出队：否则别的窗口拿同一个 id 一确认，目标窗口下一轮轮询就再也看不到这条请求
  * （它既没拍成/没应用成，也收不到，只能一路等到 15s 超时）。不属于本次请求的确认不回填、也不结束等待，
  * 更不该提前把请求取走。未消费的条目不会因此滞留：等待结束（成功/失败/超时/取消）时 `dropObservation` 会同键清掉它。
  */
 const dequeuedByCaller=(entry:UiAction,ackClient:string|undefined):boolean=>{
  const target=uiActionTargetOf(entry)
  if(!target)return true
  return ackClient===target
 }
 /** ENV-10：本会话的局部修正记录（四要素）。按会话隔离——别的会话的修正不属于这次调用。 */
 const localCorrections=new Map<string,LocalCorrectionRecord[]>()
 ctx.tools.register(defineTool({
  name:"local_correction_record",
  description:"Record a photo-driven local correction with a structured receipt: entity; reason identifying the photo/ground-truth depth; action describing the edit; reviewCamera using the viewer_camera_apply camera contract; before/after values; and optional evidence. Missing any of the four required elements or before/after fails without default values. Read saved records through ui_action_ack with input.readLocalCorrections:true.",
  parameters:{input:{type:"object",required:true,additionalProperties:false,description:"Local correction record.",properties:{
   sceneId:{type:"string",description:"Optional scene to which the correction belongs."},
   entity:{type:"string",required:true,description:"Required element 1: corrected entity ID or name."},
   reason:{type:"string",required:true,description:"Required element 2: reason for the edit, grounded in a photo, ground-truth depth, or observation."},
   action:{type:"string",required:true,description:"Required element 3: actual size, position, material, or other edit."},
   reviewCamera:{type:"object",additionalProperties:true,required:true,description:"Required element 4: review camera, using viewer_camera_apply camera fields worldFromCamera/position/quaternion/intrinsics."},
   before:{type:"json",required:true,description:"Structured values before the edit."},
   after:{type:"json",required:true,description:"Structured values after the edit."},
   evidence:{type:"json",description:"Optional evidence such as photo, ground-truth depth, or receipt reference."}}}},
  output:{schema:{type:"json"},render:(_args,value)=>[{type:"text",text:JSON.stringify(value)}]},
  execute:async(args,exec)=>{
   const input=(args.input??args) as Record<string,unknown>
   const record=localCorrectionRecordOf(input,new Date().toISOString())
   const key=sessionKeyOf((exec as {agent?:unknown}).agent)
   const rows=localCorrections.get(key)??[]
   rows.push(record);localCorrections.set(key,rows)
   // 回执按工具契约过 JSON 边界：记录本身是结构化数据（before/after/evidence 都是 JSON），
   // 这里显式转一次，避免把接口类型直接塞进 `JsonValue` 通道（形状不变，键序不变）。
   return {recorded:true,index:rows.length,sessionRecords:rows.length,record:JSON.parse(JSON.stringify(record)) as never}
  },
 }))
 // 同一份记录也走**命令**通道：宿主的外部调用只认领域前缀（`scene_/ui_/…`，见 POST 路由的 UNKNOWN_DOMAIN_COMMAND 闸门），
 // 工具名 `local_correction_record` 不在前缀表里 ⇒ 由 API 驱动时用 `ui_local_correction_record`（同校验、同存储、同回读）。
 ctx.commands.register({name:"ui_local_correction_record",description:"Record a photo-driven local correction with entity/reason/action/review camera and before/after. Uses the same validation and session storage as local_correction_record for Host API calls. Missing required elements fails without persisting a record.",input:{hint:'{sceneId?,entity,reason,action,reviewCamera,before,after,evidence?}'},recordInput:false,handler:async invocation=>{
  const input=JSON.parse(invocation.rawInput||"{}") as Record<string,unknown>
  const record=localCorrectionRecordOf(input,new Date().toISOString())
  const key=sessionKeyOf(invocation.agent)
  const rows=localCorrections.get(key)??[]
  rows.push(record);localCorrections.set(key,rows)
  return {kind:"success",text:JSON.stringify({recorded:true,index:rows.length,sessionRecords:rows.length,record})}
 }})
 /** ENV-06：照片视角覆盖表 + 缺失视角检索（同一份处理函数，工具给 agent、命令给宿主 API／前端）。 */
 async function photoViewpointCoverage(input:unknown){
  const raw=(input??{}) as {photos?:unknown;requestedViewpoints?:unknown;object?:unknown;search?:{sourceUrl?:unknown}}
  if(!Array.isArray(raw.photos)||!raw.photos.length)throw new Error("PHOTO_VIEWPOINT_PHOTOS_REQUIRED: 至少给一张照片/视角记录（object + 视角名或机位 positionM）才谈得上覆盖表")
  const photos=raw.photos as PhotoViewpoint[]
  // 直接把请求项交给 `viewpointCoverageOf` 规范化：这里**不再** `String(v)`——那会把对象变成 `"[object Object]"`
  // 塞进 `missing`（回执/页面完全不可读）；对象由规范化函数取字段拼成 `objectId@viewpoint`，取不出字段就明确报错。
  const requested=Array.isArray(raw.requestedViewpoints)?raw.requestedViewpoints:[]
  const coverage=viewpointCoverageOf(photos,requested)
  if(coverage.insufficient)throw new Error(coverage.insufficient)
  const object=typeof raw.object==="string"&&raw.object.trim()?raw.object.trim():undefined
  const rows=object?coverage.objects.filter(row=>row.object===object):coverage.objects
  const missing=[...new Set(rows.flatMap(row=>row.missing))]
  const sourceUrl=typeof raw.search?.sourceUrl==="string"&&raw.search.sourceUrl.trim()?raw.search.sourceUrl.trim():undefined
  const searched:Array<Record<string,unknown>>=[]
  for(const viewpoint of missing){
   if(!sourceUrl){searched.push({viewpoint,searched:false,reason:"没有配置检索源（search.sourceUrl）：本工具不编造候选"});continue}
   try{
    const url=await assertPublicHttpsURL(sourceUrl)
    const fetched=await fetchPublicHttpsBytes(url,defaultHostResolver,4*1024*1024)
    searched.push({viewpoint,searched:true,url:url.href,bytes:fetched.bytes.byteLength,contentType:fetched.contentType,sha256:createHash("sha256").update(fetched.bytes).digest("hex")})
   }catch(error){searched.push({viewpoint,searched:false,url:sourceUrl,error:String((error as Error)?.message??error)})}
  }
  return {objects:rows,photos:object?coverage.photos.filter(face=>face.object===object):coverage.photos,missing,searched,unattributed:coverage.unattributed,note:"覆盖表只由真实照片的机位/视角名推导（同一方位桶去重）；没有 object 的记录落在 `unattributed` 里如实计数（不混进某个对象、也不静默消失）；遮挡由标注或**真实深度跳变**如实推导、裁切按标注/真实尺寸校验，推不出来就写 derived:false（不编造）；缺失视角的检索走既有公开网守卫，取不到候选就如实记 blocked，不用假数据冒充。"}
 }
 ctx.tools.register(defineTool({
  name:"photo_viewpoint_coverage",
  description:"ENV-06: Given real photo/view records (object and view name or worldFromCamera.positionM), return a per-object coverage table with covered and missing requested views, derived azimuth/elevation, and unavailable records. Attempt one search for missing views and report unavailable sources or guard rejection. No photos or no usable camera poses fail explicitly rather than returning an empty table as complete coverage.",
  parameters:{input:{type:"object",required:true,additionalProperties:false,description:"Coverage table request.",properties:{
   photos:{type:"array",required:true,description:"Real photo/view records.",items:{type:"object",additionalProperties:true}},
   requestedViewpoints:{type:"array",description:"Requested view names used to identify missing coverage.",items:{type:"string"}},
   object:{type:"string",description:"Only this object's coverage; omission includes all objects."},
   search:{type:"object",additionalProperties:true,description:"Optional search source {sourceUrl}."}}}},
  output:{schema:{type:"json"},render:(_args,value)=>[{type:"text",text:JSON.stringify(value)}]},
  execute:async(args,exec)=>(await photoViewpointCoverage((args as {input?:unknown}).input??args)) as never,
 }))
 ctx.commands.register({name:"ui_photo_viewpoint_coverage",description:"ENV-06 photo viewpoint coverage and missing-view search, using the same handler as photo_viewpoint_coverage. The ui_ prefix is for Host API/frontend calls.",input:{hint:'{photos:[…],requestedViewpoints?,object?,search?}'},recordInput:false,handler:async invocation=>({kind:"success",text:JSON.stringify(await photoViewpointCoverage(JSON.parse(invocation.rawInput||"{}")))})})
 ctx.commands.register({name:"ui_action_ack",description:"Frontend acknowledgement after an interface action, for product frontend use only. results:[{id,ok,error,clientId,value?}] reports actual success or explicit failure for capture/camera operations. A successful value carries results unavailable through another channel, such as camera readback {camera,state,sceneId,sceneRevision}; image capture still uses viewer_capture. Directed captureViewer/applyCameraViewer/renderCameraViewer acknowledgements require this window's clientId at the top level or in the result row. Only the designated window can dequeue the request; another window's acknowledgement neither dequeues it nor ends the wait.",input:{hint:'{ids, results?, clientId?}'},recordInput:false,handler:async invocation=>{
  const input=JSON.parse(invocation.rawInput||"{}") as {ids?:unknown;results?:Array<{id?:unknown;ok?:unknown;error?:unknown;clientId?:unknown;value?:unknown}>;readLocalCorrections?:unknown}
  const ids=ackedIds(input)
  if(!ids)throw new Error("UI_ACTION_ACK_IDS_REQUIRED")
  // ENV-10 回读：带 readLocalCorrections:true 时一并返回**本会话**的局部修正记录（四要素 + 改前/改后）。
  const readLocalCorrections=input.readLocalCorrections===true
  const records=readLocalCorrections?(localCorrections.get(sessionKeyOf(invocation.agent))??[]):undefined
  return {kind:"success",text:JSON.stringify({acked:ids.length,...(records?{localCorrections:records,localCorrectionsCount:records.length}:{})})}
 }})
 register("command",["POST"],async request=>{
  const body=await request.json() as {sessionId:string;name:string;input:unknown;selection?:unknown;display?:unknown}
  const {sessionId,name,selection}=body
  // 入站：产品域引用（`captures/…` 等）在这里解析回绝对路径；用户自己写下的相对路径原样交给业务解析器。
  const input=resolveProductPaths(body.input,productPathRoots)
  const resolved=await ctx.sessionController.resolveAgent(SessionId(sessionId));if('error' in resolved)throw resolved.error
  const agent=resolved.agent
  if(!/^(scene_|asset_|policy_|sim_|robot_|joint_|vehicle_|viewer_|sensor_|camera_|segment_|recording_|fastgs_|ui_)/.test(name))throw new Error("UNKNOWN_DOMAIN_COMMAND")
  // 归属核对基准 = 命令发出时（客户端内部请求携带）的选择身份；只有拿不到元数据的旧/非 UI 调用
  // 才退回服务端此刻的记录。不能用请求到达后才采到的新选择去解释一条更早发出的命令。
  const atStart=dispatchedIdentity(selection)??selectionIdentity(agent)
  let display:ReturnType<typeof validateRegisteredControlDisplay>
  if(body.display!==undefined){
   const claimedClient=(selection as {clientId?:string}|undefined)?.clientId,selectionScope=scopeOf(agent.ctx)
   const registered=claimedClient&&selectionScope?selections.get(selectionScope)?.get(claimedClient):undefined
   const owner=registered&&claimedClient?{clientId:claimedClient,facts:registered.facts,live:liveObserveClients(sessionKeyOf(agent)).some(([id])=>id===claimedClient)}:undefined
   const recorded=(body.display as {phase?:unknown}|null)?.phase==='stop'?agent.session.snapshotEvents():[]
   display=validateRegisteredControlDisplay(body.display,name,input,selection,owner,recorded)
  }
  const line=`/${name} ${JSON.stringify(input??{})}`
  const result=display?await ctx.commands.executeDisplayed(agent,line,[],display,request.signal):await ctx.commands.execute(agent,line,[],request.signal)
  if(!result)throw new Error("COMMAND_UNAVAILABLE: "+name)
  if(name==="ui_action_ack"&&result.result.kind==="success"){
   // 队列键用**本次调用已解析的 agent** 推出来的会话：请求体里的 sessionId 只在上面 resolveAgent 时用过一次，
   // 之后一律以解析结果为准（否则填一个别人的 sessionId 就能替别人出队、替别人结束等待）。
   const key=sessionKeyOf(agent),ackIds=ackedIds(input)
   if(ackIds){const queue=uiActionQueue.get(key);if(queue)uiActionQueue.set(key,queue.filter(entry=>!(ackIds.includes(entry.id)&&dequeuedByCaller(entry,ackClientId(input,entry.id))))) }
   // 前端明确报告失败的动作（例如目标窗口没在显示请求的版本）：把失败交给正在等这次观察的工具，
   // 而不是让它一直等到超时——模型要的是"为什么没观察到"，不是"没反应"。
   // 但只有**发起这次观察的会话里、且正是被指定的那个窗口**能宣告它失败：否则别的窗口拿同一个
   // requestId 也能让等待者失败（归属不符就忽略这条回执；目标窗口仍在轮询，仍会自己送图）。
   const results=(input as {results?:unknown}|undefined)?.results
   if(Array.isArray(results))for(const row of results){
    const entry=(row??{}) as {id?:unknown;ok?:unknown;error?:unknown;clientId?:unknown;value?:unknown}
    if(typeof entry.id!=="string")continue
    const waiter=observeWaiters.get(entry.id)
    if(!waiter||waiter.sessionKey!==key)continue
    if(typeof entry.clientId!=="string"||entry.clientId!==waiter.clientId)continue
    if(entry.ok===true){
     // 成功行可以带结构化结果——**相机应用**就是这一类：它没有图，交付物是"应用后当场量到的相机读数"。
     // 归属还是同一份（会话 + 窗口 + 场景 + 版本，场景/版本从 `value` 里读），形状不对由 `settleCameraApply`
     // 判为失败：绝不把一个半份回执记成"相机已经摆好了"。图片类的成功回执走 `viewer_capture` 那条路（有附件要落盘），
     // 这里只认"没有别的通道可交付"的读数型结果。
     if(entry.value!==undefined){
      let size:number
      try{size=JSON.stringify(entry.value)?.length??0}catch{size=MAX_ACK_VALUE_BYTES+1}
      if(size>MAX_ACK_VALUE_BYTES){failObservation(entry.id,`VIEWER_CAMERA_RECEIPT_TOO_LARGE: 回执载荷 ${String(size)} 字节超过上限 ${String(MAX_ACK_VALUE_BYTES)}，不采用这份结果`);continue}
      const value=entry.value as Record<string,unknown>
      // 资源打开与相机应用是两类"读数型"结果，共用同一张等待表但 settle 判据不同：
      // 打开核对的是 opened/visible 的真实前端事实（`settleOpenAction`），相机核对的是应用后量到的读数。
      if(waiter.kind==="open")settleOpenAction(entry.id,{sessionKey:key,clientId:entry.clientId,value:entry.value})
      else settleCameraApply(entry.id,{sessionKey:key,clientId:entry.clientId,sceneId:value.sceneId,sceneRevision:value.sceneRevision,value:entry.value})
     }else if(waiter.kind==="open"){
      // "成功"却不带 opened/visible 事实：当场判失败，不让等待者空等到超时。
      failObservation(entry.id,"UI_ACTION_OPEN_RECEIPT_REQUIRED: 窗口报告打开成功但没有给出 opened/visible 的真实打开事实，这次打开不能算成立")
     }
     continue
    }
    failObservation(entry.id,typeof entry.error==="string"&&entry.error?entry.error:(waiter.kind==="camera"?"VIEWER_CAMERA_CLIENT_FAILED: 目标窗口没有完成这次相机应用":waiter.kind==="open"?"UI_ACTION_OPEN_CLIENT_FAILED: 目标窗口没有完成这次打开":"VIEWER_OBSERVE_CLIENT_FAILED: 目标窗口没有完成这次采集"))
   }
  }
  if(name.startsWith("segment_")&&result.result.kind==="success"){
   let output=JSON.parse(result.result.text??"null");if(typeof output?.result==="string")output=JSON.parse(output.result)
   const sceneId=output?.source?.sceneId
   // 准入清单按**会话 + 场景**记：同一个 sceneId 在别的会话里是另一份场景，分割产物不能互相放行。
   if(sceneId){const key=segmentationKey(sessionKeyOf(agent),sceneId);await sceneFor(sessionKeyOf(agent)).scene.snapshot(sceneId);const allowed=segmentationFiles.get(key)??new Set<string>();for(const item of [output.image,output.overlay,...output.masks??[]])if(typeof item?.uri==="string")allowed.add(item.uri);segmentationFiles.set(key,allowed)}
  }
  if(result.result.kind==="success"&&(name==="sim_open"||name==="sim_sync"||name==="sim_close")){
   let output:unknown
   try{output=JSON.parse(result.result.text??"null")}catch{output=undefined}
   if(output&&typeof output==="object"&&"result" in output&&typeof (output as {result?:unknown}).result==="string")try{output=JSON.parse((output as {result:string}).result)}catch{output=undefined}
   // sim_close 的结果只有 {closed:true}：被关闭的 world 只能从命令入参取，用于按归属清除。
   const closedWorldId=name==="sim_close"&&input&&typeof input==="object"&&typeof (input as {worldId?:unknown}).worldId==="string"?(input as {worldId:string}).worldId:undefined
   updateSelectionWorld(agent,name,name==="sim_close"?undefined:output&&typeof output==="object"?output as Record<string,unknown>:undefined,closedWorldId,atStart)
  }
  await (ctx.sessions as unknown as SessionStore).flush(agent.session)
  // 出站只发两个消费者各自的合法面：`text` = 人类公共面（卡片/截图/回放/诊断导出共用），
  // `ui` = 逐命令白名单的业务字段（面板续链）。**没有 `.result` 兜底**：未登记的字段一律不下发。
  // 服务端模型真值仍在 session 日志（command/done 与 tool/result 原样落盘，模型上下文由日志重建）。
  const outcome=result.result
  // 完整原始错误只进 Host 日志（诊断导出读它）；浏览器卡片只拿稳定公开码 + 人话。
  if(outcome.kind==="error")ctx.logger.warn(`lyapunov-command ${name} failed: ${publicCommandError(outcome.text).code} ← ${redactSecretsText(String(outcome.text??"")).slice(0,800)}`)
  const response=commandRouteResponse(name,outcome,privacyMode,productPathRoots)
  // `viewer_capture` 的拒绝要原样回到窗口：窗口把它写进 `ui_action_ack`，模型看到的就是这句
  // （尺寸/镜头/来源不符）。人类面的公开码会把这些码收成 P422/P500，模型就分不清为什么没收下这张图。
  // 路径与凭据仍脱掉；码本身是产品合同，不是内部目录。
  if(name==="viewer_capture"&&outcome.kind==="error"&&typeof outcome.text==="string")response.text=scrubAbsolutePaths(redactSecretsText(stripStack(outcome.text)))
  return Response.json(response,{headers:{"cache-control":"private, no-store"}})
 })
 register("view-selection",["POST"],async request=>{
  const input=await request.json() as {sessionId:string;sceneId?:string;entityId?:string;worldId?:string;clientId:string;sequence:number}
  const resolved=await ctx.sessionController.resolveAgent(SessionId(input.sessionId));if('error' in resolved)throw resolved.error
  const agent=resolved.agent
  const sessionKey=sessionKeyOf(agent)
  const scope=scopeOf(agent.ctx);if(!scope)throw new Error("SESSION_SCOPE_UNAVAILABLE")
  // 选择事实按窗口存：本窗口只读写**自己**那一槽，别的窗口的选择不会被这次调用覆盖或清掉。
  // clientId 缺省（旧调用/回放）时落在一个稳定的匿名槽，行为与修前一致。
  const clientId=typeof input.clientId==="string"&&input.clientId?input.clientId:"(no-client)"
  const slots=selectionSlots(scope),previous=slots.get(clientId)
  if(previous&&previous.sequence>input.sequence)return Response.json({updated:false})
  // 显式清除：UI 已经没有场景（关闭、取消选择或旧客户端先发出来的空选择）。
  // 记录必须保留 clientId 与序号，同一客户端的迟到旧选择会被上面的单调边界挡掉；
  // 删除记录等于抹掉边界，旧请求就能把旧 scene/world/entity 写回来。
  if(input.sceneId===undefined){
   if(input.entityId!==undefined||input.worldId!==undefined)throw new Error("CLEAR_SELECTION_CONFLICT")
   slots.set(clientId,{sequence:input.sequence,facts:{},at:++selectionClock})
   return Response.json({updated:true,facts:{}})
  }
  const snapshot=await sceneSnapshot(sessionKey,input.sceneId),entity=input.entityId?snapshot.entities.find(entity=>entity.entityId===input.entityId):undefined
  if(input.entityId&&!entity)throw new Error("ENTITY_NOT_FOUND")
  // A selected world is part of the model-facing language context. Do not
  // silently drop it after a host restart/provider change: that would leave
  // the model with a plausible Scene selection but an invalid world handle.
  let world:any
  if(input.worldId){
   // worldId 只在**本会话**里寻址：别的会话的同名 world 不是这个选择指向的世界。
   const sim=existingSimFor(sessionKey)
   world=sim?(await sim.listWorlds()).find(candidate=>candidate.worldId===input.worldId&&candidate.sceneId===input.sceneId&&candidate.status!=="closed"):undefined
   if(!world)throw new Error("STALE_SELECTION_WORLD")
  }
  const facts={sceneId:snapshot.sceneId,sceneRevision:snapshot.revision,...entity?{entityId:entity.entityId,name:entity.name}:{},...world?{worldId:world.worldId,engineId:world.engineId,worldStatus:world.status,expectedGeneration:world.worldGeneration,appliedSceneRevision:world.appliedSceneRevision}:{}}
  const latest=slots.get(clientId)
  if(latest&&latest.sequence>input.sequence)return Response.json({updated:false})
  slots.set(clientId,{sequence:input.sequence,facts,at:++selectionClock})
  // 仅记录最后打开的Scene书签到原生会话日志；不持久化易失world句柄，也不写进模型对话。
  if(lastSceneOf(agent.session.snapshotEvents())!==snapshot.sceneId){
   agent.session.append("lyapunov/last-scene",{sceneId:snapshot.sceneId},{ignorable:true})
   await (ctx.sessions as unknown as SessionStore).flush(agent.session)
  }
  return Response.json({updated:true,facts})
 })
 /** 缺省/空串/非整数一律当作"没上报"，不能用 Number("")=0 把缺省伪造成 rev 0。 */
 const integerQuery=(value:string|null):number|undefined=>{const parsed=value===null||value.trim()===""?Number.NaN:Number(value);return Number.isInteger(parsed)?parsed:undefined}
 register("state",["GET"],async request=>{
  const query=new URL(request.url).searchParams,sceneId=query.get("sceneId")??undefined
  // 会话先经核实链绑定，再取**本会话**的场景/世界/采集：请求里"带了 sessionId"不等于这条请求属于该会话，
  // 缺会话一律明确失败（不落回全局共享状态——修前这里读的是 Host 级唯一实例，A/B 会话看同一份 world 列表）。
  const sessionKey=await bindSessionId(ctx,query.get("sessionId"),"工作台状态")
  const sim=existingSimFor(sessionKey)
  const scene=sceneId?await sceneSnapshot(sessionKey,sceneId):undefined,worlds=sim?await sim.listWorlds():[]
  const agent=ctx.agents.get(SessionId(sessionKey))
  // 前端在场事实随**既有的** state 轮询上报：clientId + 该窗口当前显示的场景/版本。
  // 不新增通道；`viewer_observe` 的"目标窗口唯一性"与"这张图属于哪个版本"都以此为准。
  const clientId=query.get("clientId")??undefined,displayRevision=integerQuery(query.get("displayRevision"))
  if(agent&&clientId)noteObserveClient(sessionKey,clientId,query.get("displaySceneId")??undefined,displayRevision)
  // 本窗口**自己**的选择事实（按 clientId 读自己那一槽）：多窗口下另一个窗口的选择不回灌给这个窗口。
  const selectionScope=agent?scopeOf((agent as {ctx?:unknown}).ctx as Parameters<typeof scopeOf>[0]):undefined
  const ownSelection=clientId&&selectionScope?selections.get(selectionScope)?.get(clientId):undefined
  // 采集/相机留给每个窗口看见（非目标不执行、不确认）；其余定向动作只出现在目标窗口的轮询里。
  const deliveredUiActions=(uiActionQueue.get(sessionKey)??[]).filter(entry=>uiActionVisibleTo(entry,clientId))
  let events=agent?.session.snapshotEvents() as readonly any[]|undefined
  if(!events){
   using observation=await ctx.sessionQuery.observeSession(SessionId(sessionKey),{projectionMode:"none"})
   events=observation.events
  }
  const lastSceneId=lastSceneOf(events)
  const recentActions=projectActionRows(events)
  // state 是机器面轮询：采集行同样只发白名单字段（图片仍由 captureId 的媒体路由按授权取），
  // 路径改产品引用（面板回传给 segment_*/scene_import 时由命令路由解析回绝对路径）。
  const captures=await Promise.all((await listCaptures(sessionKey,sceneId)).map(async capture=>{
   const face=capture.annotations?.length?{...capture,annotations:undefined,annotationCount:capture.annotations.length,annotationDigest:capture.annotations.map(row=>({index:row.index,entity:row.entity??row.entityId,text:row.text}))}:capture
   return uiCommandFields("viewer_capture",face,productPathRoots)??face
  }))
  return Response.json({hostInstanceId,...lastSceneId?{lastSceneId}:{},...config.administrator?{administrator:config.administrator,modelBilling:config.modelBilling}:{},...scene?{scene:await projectSceneOutbound(scene,sessionKey)}:{},worlds,providerAvailable:Boolean(ctx.get("sim")),captures,recentActions,...ownSelection?{selection:{clientId,facts:ownSelection.facts}}:{},uiActions:deliveredUiActions,computerUse:computerUseFacts()})
 })
 // 场景清单归 scene-kit 所有：布局改造后场景文档在 <worlds>/scenes，shell 不再自己猜目录
 // （旧实现读 config.dataRoot/单根，迁移后恒返回空列表，3D 视口因此永远停在空态）。
 // 清单按会话取：用户在 A 会话里看到的场景就是 A 会话的场景，B 会话的场景不在这里出现。
 register("scenes",["GET"],async request=>Response.json(await sceneFor(await bindSessionId(ctx,new URL(request.url).searchParams.get("sessionId"),"场景清单")).list(),{headers:{"cache-control":"private, no-cache"}}))
 register("scene",["GET"],async request=>{const query=new URL(request.url).searchParams
 // 出站只改定位符（`uri`/`file:` → 资源标记、登记域内绝对路径 → 域引用），几何与组件原样（Viewer 要整份）。
 // 机器人文档资产的引用先按**已授权件**换成标记（`projectSceneForBrowser`）：相对引用在标记基址上无法解析。
 const sessionKey=await bindSessionId(ctx,query.get("sessionId"),"场景快照")
 return Response.json(await projectSceneOutbound(await sceneSnapshot(sessionKey,query.get("sceneId")??""),sessionKey),{headers:{"cache-control":"private, no-cache"}})})
 // DEV-031：历史会话的跨运行根发现（只读）与显式恢复。原生 SessionStore／界面只认当前 DSH_HOME
 // （见 script/profile.ts:74 与 session-history.ts 的说明）；恢复只把会话目录**复制**进当前根，
 // 不合并 storages、不改写 cwd、不删除原始记录。
 register("diagnostics-export",["POST"],async request=>{
  // PRIV-06：排障走**诊断导出**，不开原始回执。载荷＝同一份人类公共面投影（无令牌、无用户名、无绝对路径）；
  // 完整原始错误只在 Host 日志（工单用日志，不靠用户截图轨迹）。落盘 0600，按会话归属，不放宽任何授权。
  const body=await request.json() as {sessionId?:unknown;reason?:unknown}
  const sessionKey=await bindSessionId(ctx,typeof body.sessionId==="string"?body.sessionId:null,"诊断导出")
  const captures=await listCaptures(sessionKey,undefined)
  // 只读冷读（不激活 Agent、不写日志）：与 state 路由同一份事件源，推导用服务端全量事件。
  using observation=await ctx.sessionQuery.observeSession(SessionId(sessionKey),{projectionMode:"none"})
  const actionRows=projectActionRows(observation.events as readonly any[])
  const payload=diagnosticsPayload({
   exportedAt:new Date().toISOString(),mode:privacyMode,reason:typeof body.reason==="string"?body.reason.slice(0,200):"",
   hostInstanceId,captures:captures.map(capture=>({captureId:capture.captureId,sceneId:capture.sceneId,sceneRevision:capture.sceneRevision,capturedAt:capture.capturedAt,imagePath:capture.imagePath,posePath:capture.posePath,attachment:capture.attachment,originalImage:capture.originalImage,visualWarnings:capture.visualWarnings,lodIssue:capture.lodIssue})),
   recentActions:actionRows.map((row:Record<string,unknown>)=>({id:row.id,label:row.label,waiting:row.waiting,receipt:row.receipt,error:row.error})),
  },productPathRoots)
  const file=join(captureRoot()&&sessionKey?captureDirectory(sessionKey):captureRoot(),"diagnostics-"+new Date().toISOString().replace(/[:.]/g,"-")+".json")
  await mkdir(dirname(file),{recursive:true,mode:0o700});await writeFile(file,JSON.stringify(payload,null,2)+"\n",{mode:0o600})
  return Response.json({path:displayPath(file),ref:productRelativePath(file,productPathRoots)??displayPath(file),bytes:JSON.stringify(payload).length},{headers:{"cache-control":"private, no-store"}})
 })
 register("session-history",["GET"],async request=>{
  const discovered=discoverSessions()
  const logFile=new URL(request.url).searchParams.get("logFile")
  if(logFile){
   const entry=discovered.entries.find(item=>item.logFile===logFile)
   if(!entry)throw new Error("HISTORY_ENTRY_NOT_FOUND")
   return Response.json({...precheckSession(entry),roots:discovered.roots},{headers:{"cache-control":"private, no-store"}})
  }
  return Response.json(discovered,{headers:{"cache-control":"private, no-store"}})
 })
 register("session-history-restore",["POST"],async request=>{
  const body=await request.json() as {logFile?:unknown;confirm?:unknown}
  if(typeof body.logFile!=="string"||body.confirm!==true)throw new Error("HISTORY_RESTORE_CONFIRM_REQUIRED")
  const entry=discoverSessions().entries.find(item=>item.logFile===body.logFile)
  if(!entry)throw new Error("HISTORY_ENTRY_NOT_FOUND")
  const home=currentDshHome()
  if(!home)throw new Error("HISTORY_CURRENT_ROOT_UNAVAILABLE")
  return Response.json(restoreSession(entry,home),{headers:{"cache-control":"private, no-store"}})
 })
 register("frame",["GET"],async request=>{
  const query=new URL(request.url).searchParams,sim=existingSimFor(await bindSessionId(ctx,query.get("sessionId"),"世界帧"))
  if(!sim)return Response.json({error:"PROVIDER_UNAVAILABLE"},{status:503})
  return Response.json(await sim.observe(query.get("worldId")??"",worldFrameSelection(query)))
 })
 register("official-view",["GET"],async request=>{
  const query=new URL(request.url).searchParams,sim=existingSimFor(await bindSessionId(ctx,query.get("sessionId"),"官方视角"))
  if(!sim)return Response.json({error:"PROVIDER_UNAVAILABLE"},{status:503})
  const worldId=query.get("worldId")??""
  const world=(await sim.listWorlds()).find(item=>item.worldId===worldId&&item.engineId===OFFICIAL_ENGINE_ID&&item.status!=="closed")
  if(!world)return Response.json({error:"NO_OFFICIAL_AGENTVIEW"},{status:404})
  // 图像就是当前 Frame 自己的 agentview 传感器：内容按 world/generation 归属校验，
  // 拒绝任何旧任务或跨世界共享的预览文件。
  const sensor=agentviewSensor(await sim.observe(world.worldId)),path=typeof sensor?.path==="string"?sensor.path:""
  if(!path||sensor?.worldId!==world.worldId||sensor?.generation!==world.worldGeneration||!existsSync(path))return Response.json({error:"NO_OFFICIAL_AGENTVIEW"},{status:404})
  return new Response(await readFile(path),{headers:{"content-type":typeof sensor.mimeType==="string"?sensor.mimeType:"image/png","cache-control":"private, no-store"}})
 })
 register("robot-description",["GET"],async request=>{
  const query=new URL(request.url).searchParams,sim=existingSimFor(await bindSessionId(ctx,query.get("sessionId"),"机器人描述"))
  if(!sim)return Response.json({error:"PROVIDER_UNAVAILABLE"},{status:503})
  return Response.json(await sim.describe(query.get("worldId")??"",query.get("entityId")??""),{headers:{"cache-control":"private, no-cache"}})
 })
 register("capture",["GET"],async request=>{
  const query=new URL(request.url).searchParams,id=query.get("captureId")??"",sensor=query.get("sensor"),cameraName=query.get("camera")
  // 采集媒体按**本会话**的命名空间读：同一个 captureId 在别的会话里是另一份产物（会话先核实再取）。
  const sessionKey=await bindSessionId(ctx,query.get("sessionId"),"采集媒体")
  if(sensor!==null){
   if(sensor!=="rgb"&&sensor!=="depth")throw new Error("INVALID_SENSOR_MEDIA")
   // camera=<name> 只服务多视角采集里那台真实相机的产物；逐相机条目来自同一次 Provider 调用，
   // 这里不做任何拼接，也只允许读该 capture 目录内的文件。
   if(cameraName!==null){
    const directory=cameraDirectory(sessionKey,id),capture=JSON.parse(await readFile(join(directory,"capture.json"),"utf8"))
    if(capture.captureId!==id)throw new Error("CAMERA_CAPTURE_ID_MISMATCH")
    const entry=(capture.cameras??[]).find((item:{cameraName?:string})=>item.cameraName===cameraName)
    if(!entry)throw new Error("CAMERA_NOT_IN_CAPTURE")
    const path=resolve(localPath(entry[sensor].uri))
    if(dirname(path)!==directory)throw new Error("SENSOR_MEDIA_OUTSIDE_CAPTURE")
    return new Response(await readFile(path),{headers:{"content-type":sensor==="rgb"?"image/png":"application/x-npy","cache-control":"private, no-cache",...sensor==="depth"?{"content-disposition":`attachment; filename="${id}-${cameraName}-depth.npy"`}:{}}})
   }
   // 旧 sensor_capture 路径仍使用 captures/<id>.json；多视角路径已在上方按 camera/<id>/capture.json 校验。
   capturePath(sessionKey,id)
   const directory=join(captureDirectory(sessionKey),"sensor",id),capture=JSON.parse(await readFile(join(directory,"capture.json"),"utf8")),path=resolve(localPath(capture[sensor].uri))
   if(dirname(path)!==directory)throw new Error("SENSOR_MEDIA_OUTSIDE_CAPTURE")
   return new Response(await readFile(path),{headers:{"content-type":sensor==="rgb"?"image/png":"application/x-npy","cache-control":"private, no-cache",...sensor==="depth"?{"content-disposition":`attachment; filename="${id}-depth.npy"`}:{}}})
  }
  const capture=await readCapture(sessionKey,id),image=await ctx.attachments.readImage(capture.attachment as any)
  return new Response(image.data,{headers:{"content-type":capture.attachment.mediaType,"cache-control":"private, no-cache"}})
 })
 // 媒体寻址用资源标记（`res:<指纹>`）：浏览器不持有绝对路径，标记只在**已授权候选集**里等值匹配。
 // 候选集本身就是授权判据（分割产物准入清单 / 场景资源表），所以解析只认集合内成员，越界即失败。
 const admitResourceToken=async(candidate:string|undefined,candidates:()=>Promise<string[]>|string[]):Promise<string|undefined>=>{
  if(!candidate)return undefined
  if(!candidate.startsWith(RESOURCE_TOKEN_PREFIX))return candidate
  return matchResourceToken(candidate,await candidates())
 }
 register("segmentation-resource",["GET"],async request=>{
  const query=new URL(request.url).searchParams,sessionKey=await bindSessionId(ctx,query.get("sessionId"),"分割产物"),sceneId=query.get("sceneId")??""
  const admitted=await admitResourceToken(query.get("uri")??"",()=>[...segmentationFiles.get(segmentationKey(sessionKey,sceneId))??[]])
  if(!admitted||!segmentationFiles.get(segmentationKey(sessionKey,sceneId))?.has(admitted))throw new Error("SEGMENTATION_RESOURCE_NOT_ADMITTED")
  return new Response(await readFile(localPath(admitted)),{headers:{"content-type":"image/png","cache-control":"private, no-cache"}})
 })
 const recordingRoot=()=>{const value=config.recordingRoot??(process.env.LYAPUNOV_SCENE_ROOT?join(process.env.LYAPUNOV_SCENE_ROOT,"recordings"):undefined);if(!value)throw new Error("RECORDING_ROOT_REQUIRED");return resolve(value)}
 /** 录制产物与采集同规则：`<recordingRoot>/sessions/<会话键>`（写侧见 robot-workflows 的 recording-plugin，同一份 sessionNamespace）。 */
 const recordingDirectory=(sessionKey:string)=>{if(!sessionKey)throw new Error(`${SESSION_SCOPE_UNAVAILABLE}: 录制目录必须按会话取（拒绝落到全局共享目录）`);return sessionNamespace(recordingRoot(),sessionKey)}
 register("recordings",["GET"],async request=>{const query=new URL(request.url).searchParams;const sessionKey=await bindSessionId(ctx,query.get("sessionId"),"录制清单");return Response.json((await listRecordings(recordingDirectory(sessionKey),query.get("sceneId")??undefined)).map(manifest=>recordingSummary(manifest,sessionKey)),{headers:{"cache-control":"private, no-cache"}})})
 register("recording",["GET"],async request=>{const query=new URL(request.url).searchParams;return Response.json(await readRecording(recordingDirectory(await bindSessionId(ctx,query.get("sessionId"),"录制读取")),query.get("recordingId")??""),{headers:{"cache-control":"private, no-cache"}})})
 register("recording-resource",["GET"],async request=>{const query=new URL(request.url).searchParams,value=await readRecordingResource(recordingDirectory(await bindSessionId(ctx,query.get("sessionId"),"录制媒体")),query.get("recordingId")??"",query.get("uri")??"");return new Response(value.data as BodyInit,{headers:{"content-type":value.mimeType,"cache-control":"private, no-cache"}})})
 register("resource",["GET"],async request=>{
  // 官方派生 Scene 与普通 Scene 走同一条授权：只能读该 Scene 引用过的原始件/表示或其依赖。
  // 浏览器持有的是**资源标记**（`res:<指纹>`），真实 URI 只在这里对着已授权候选集等值匹配后展开。
  const query=new URL(request.url).searchParams
  const sessionKey=await bindSessionId(ctx,query.get("sessionId"),"场景资源")
  const scene=await sceneSnapshot(sessionKey,query.get("sceneId")??"")
  const refs:ResourceRef[]=scene.entities.flatMap(entity=>entity.resources)
  const listed=refs.flatMap(ref=>[ref.original,...ref.representations])
  const candidates:string[]=[...listed.map(rep=>rep.uri)]
  for(const entity of scene.entities){const native=(entity.components.mujoco as any)?.sourcePath;if(typeof native==="string")candidates.push(native)}
  for(const source of [...candidates]){const key=`${sessionKey}|${scene.sceneId}:${scene.revision}:${source}`;let dependencies=dependencyCache.get(key)
   if(!dependencies){try{const parsed=await parseAsset(localPath(source));dependencies=new Set(parsed.dependencies.flatMap(item=>[item.path,pathToFileURL(item.path).href]));dependencyCache.set(key,dependencies)}catch{continue}}
   candidates.push(...dependencies)
  }
  // 用户导入的机器人（MJCF/URDF）在文档里写的是**相对引用**（`<mesh file="pelvis.STL">` + `<compiler meshdir="meshes">`），
  // 基址是"机器人文档所在目录"。出站投影把 `visual.robot.baseUri` 换成了不可逆标记（`res:<指纹>`），
  // 浏览器里 `new URL(相对引用, 标记)` 抛错 ⇒ 相对引用被**原样**送到这里。候选集里本来就有它解析后的
  // 绝对件（`parseAsset` 的依赖闭包按同一份 meshdir 规则算出来的），缺的只是"按基址目录解析"这一步。
  //
  // 口径（**不新增任何授权**）：基址只取**该 Scene 自己的机器人文档**（`mujoco.sourcePath` 或带 MJCF/URDF
  // mimeType 的已授权资源）。同一件资源在候选集里同时有绝对路径与 `file:` URI 两种写法，所以按**件**去重
  // （先归一成规范串再判归属），解析结果仍要**逐字**落进上面那份候选集才放行；多份文档解析出不同的已授权件
  // ＝**判据不足**，明确失败，不猜。越界（`..`）与无法解析的引用一律不解析。
  const listedUris=new Set(listed.map(row=>row.uri))
  const nativeSourcePaths=new Set(scene.entities.map(entity=>(entity.components.mujoco as any)?.sourcePath).filter((value:unknown):value is string=>typeof value==="string"&&Boolean(value)))
  const dependencyUris=new Set<string>()
  for(const source of listedUris)for(const item of dependencyCache.get(`${sessionKey}|${scene.sceneId}:${scene.revision}:${source}`)??[])dependencyUris.add(item)
  /** 一件已授权资源：候选集的三种成员判据与上面**逐字同一份**（`listed` / `native.sourcePath` / 依赖闭包）。 */
  const isAuthorizedResource=(candidate:string):boolean=>listedUris.has(candidate)||nativeSourcePaths.has(candidate)||dependencyUris.has(candidate)
  /** 绝对路径与 `file:` URI 是**同一件**：按件归一，供去重与歧义判定。 */
  const sameResource=(value:string):string=>{try{return localPath(value)}catch{return value}}
  /** 机器人文档基准（**不含** meshdir）：依赖闭包与显示侧的相对解析都从文档所在目录起算。 */
  const robotBases=(scene:SceneSnapshot):string[]=>{
   const bases:string[]=[]
   const note=(value:unknown):void=>{if(typeof value!=="string"||!value)return;let path:string;try{path=localPath(value)}catch{return};const directory=dirname(path);if(directory&&!bases.includes(directory))bases.push(directory)}
   for(const entity of scene.entities){
    note((entity.components.mujoco as any)?.sourcePath)
    for(const ref of entity.resources){
     for(const representation of [ref.original,...ref.representations]){
      if(["application/x-mjcf+xml","application/x-urdf+xml"].includes(representation.mimeType))note(representation.uri)
     }
    }
   }
   return bases
  }
  /** 相对引用 → 该 Scene 的机器人文档目录下的已授权件。判据不足（0 个已知的／多份文档给出不同件）时返回 undefined。 */
  const resolveRelativeReference=(reference:string,scene:SceneSnapshot):string|undefined=>{
   const normalized=reference.replace(/\\/g,"/").replace(/^\.\//,"")
   if(!normalized)return undefined
   let decoded=normalized
   try{decoded=decodeURIComponent(normalized)}catch{/* 百分号写法坏了就按原样解析 */}
   if(!decoded.startsWith("/")&&!/^[A-Za-z]:[\\/]/.test(decoded)){
    const parts=decoded.split("/")
    if(parts.includes("..")||parts.includes("."))return undefined
    const hits=new Map<string,string>()
    for(const directory of robotBases(scene)){
     const absolute=resolve(directory,decoded),uri=pathToFileURL(absolute).href
     // 两种写法都可能落进候选集；命中的是**同一件**，交给 `readVerifiedResource` 的仍是候选集里的那一份。
     if(isAuthorizedResource(absolute))hits.set(sameResource(absolute),absolute)
     else if(isAuthorizedResource(uri))hits.set(sameResource(uri),uri)
    }
    if(hits.size===1)return [...hits.values()][0]
    if(hits.size>1)throw new Error(`RESOURCE_REFERENCE_AMBIGUOUS: 相对引用「${reference}」在该 Scene 的多份机器人文档下解析出 ${String(hits.size)} 份已授权件，拒绝猜`)
    return undefined
   }
   // 自带 scheme / 绝对路径：只在候选集里**逐字**找同一件（找不到就是未授权，不改判据）。
   if(listedUris.has(reference))return reference
   return candidates.includes(reference)?reference:undefined
  }
  const requested=query.get("uri")??""
  const resolved=requested&&!requested.startsWith(RESOURCE_TOKEN_PREFIX)&&!listedUris.has(requested)
   ?resolveRelativeReference(requested,scene)
   :undefined
  const uri=await admitResourceToken(resolved??requested,()=>candidates)
  if(!uri)throw new Error("RESOURCE_NOT_REFERENCED_BY_SCENE")
  const rep=listed.find(row=>row.uri===uri)
  let allowed=Boolean(rep)
  if(!allowed){
   for(const entity of scene.entities){const native=(entity.components.mujoco as any)?.sourcePath;if(typeof native==="string"&&native===uri){allowed=true;break}}
   if(!allowed){
    for(const source of [...new Set(listed.map(row=>row.uri))]){const key=`${sessionKey}|${scene.sceneId}:${scene.revision}:${source}`;const dependencies=dependencyCache.get(key)
     if(dependencies?.has(uri)){allowed=true;break}}
   }
  }
  if(!allowed)throw new Error("RESOURCE_NOT_REFERENCED_BY_SCENE")
 // 资源字节由**该会话自己的**资源库读：它带着本会话的 catalog/派生/下载目录（内容寻址的 CAS 才是跨会话
 // 共享的不可变字节）。不再用 Host 级单例资源根——那会让 B 会话的字节按 A 会话的索引做 sha256 核对。
  if((await stat(localPath(uri))).size>64*1024*1024){
   const stream=await sceneFor(sessionKey).resources.streamVerifiedResource(scene,uri,request.signal)
   return new Response(stream.body,{headers:{"content-type":rep?.mimeType??"application/octet-stream","content-length":String(stream.size),"cache-control":"private, no-cache"}})
  }
  const bytes=await sceneFor(sessionKey).resources.readVerifiedResource(scene,uri)
  return new Response(bytes as BodyInit,{headers:{"content-type":rep?.mimeType??"application/octet-stream","cache-control":"private, no-cache"}})
 })
}
