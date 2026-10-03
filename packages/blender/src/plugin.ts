import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { explainTextureQuery, fetchTextureSet, findTextures } from './textures.ts'
import type { TextureResolution } from './textures.ts'
import { attachResultImages, blenderEvidence, blenderSpawnFailure, finishBlenderRun, lastResultLine, noteImageDelivery, resultImagePaths } from './result.ts'
import { registerCadTools } from './cad.ts'
import { registerCameraFitTools } from './camera-fit.ts'
import { registerDrawingTools } from './drawing-input.ts'
import type { ImageReport, ImageStore } from './result.ts'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join, resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
export const name='lyapunov-blender'
/** world.py 结果行的稳定前缀；长度只在这里定义，解析方不得硬编码数字。 */
const RESULT_PREFIX='LYAPUNOV_RESULT='
/** 一次结果最多带进模型上下文的图像数；超出上限的多机位图仍以真实路径留在结果 JSON 里。 */
const MAX_RESULT_IMAGES=4
/** world.py 的三档操作；缺省 build，与 world.py 自己的 CLI 默认一致。 */
export type BlenderOperation='build'|'preview'|'export'
/**
 * 作业控制状态文件：写在**作业自己的输出目录**里的 dotfile，与 `textures.json`（本文件写）、
 * `scene.json`（world.py 写）同级——不新增目录、不新增根、不碰 workspace 布局。
 */
const JOB_STATE_FILE='.lyapunov-job-state.json'
/** 已经写进状态文件的暂停状态取值（`resumeCount`/`completedPhases` 与它一起构成本文件的读面）。 */
type JobStateFileState='pause-requested'|'paused'|'resumed'
/** pause 等待"真的停到阶段边界"的上限：超时如实回 `pause-requested`，不假装已经暂停。 */
const PAUSE_WAIT_TIMEOUT_MS=15_000
/**
 * 产品侧的暂停状态。原生 `JobStatus` 闭集是 `running|stopping|completed|killed|failed`
 * （vendored `packages/jobs/jobs/src/types.ts:17`）——**没有 `paused`**，所以这个状态只存在于本插件里；
 * 暂停期间原生 `job_list` / `job_output` 照实显示 `running`，真实状态只能由 `blender_job_control` 读。
 */
export type BlenderControlState='running'|'pause-requested'|'paused'
/**
 * 一条后台 Blender 作业的控制句柄：生产者循环与 `blender_job_control` 之间的**唯一**通道。
 * 作业记录本身（jobId/状态/输出）仍在原生 `ctx.jobs` 里，这里不放第二份作业表。
 */
export interface BlenderJobControl {
  /** 由 `ctx.jobs.start()` **返回之后**回填——id 是 jobs-local 在 `run()` 之后才铸的（`jobs-local:150-153`）。 */
  jobId:JobId
  /** 作业输出目录（状态文件、`source.blend` 都在这里）。 */
  readonly output:string
  /** 调用方输入的 sha256（argv + output + sourceBlend + material_textures）：resume 前用它比对检查点。 */
  readonly argvDigest:string
  /**
   * 本作业**在插件层**已完成阶段的闭集：`'textures'`＝输入准备/取图（真的取到清单才有），
   * `'blender'`＝world.py 的建模/导出/可选渲染在那次子进程里跑完（只在**完整跑完**时补上）。
   * 不是进度百分比：world.py 内部没有更细的检查点（那是 P1）；失败/取消时是落定前已完成的阶段。
   */
  completedPhases:string[]
  resumeCount:number
  /** 已收到暂停请求（内存事实，与状态文件同写）。 */
  requested:boolean
  /** 生产者当前真的停在阶段边界上等恢复。 */
  waiting:boolean
  pausedAt?:string
  /** 停掉当前子进程（生产者每次 spawn 后刷新这个闭包）。 */
  stopChild?:()=>void
  /** 生产者进入 `waiting` 时用来唤醒它；`job_kill` 也用它把循环放出来（否则 owner 释放会卡在 `await job.settled`）。 */
  wakeResume?:()=>void
  /** pause 请求生效（生产者真的停下）的完成通知。 */
  stopped?:{promise:Promise<void>;resolve:()=>void}
}
// `attachments` **不进 inject**：它是可选增强（把渲染图带进模型上下文），不是本工具的必需服务。
// 声明进 inject 会让"没有附件服务的装配"（例如只注册 tools/subprocess/jobs 的最小 Cordis 树）
// **整插件不激活**——实测这让 G10b 的 6 项里 5 项失败。改用 `ctx.get('attachments')` 运行时判空：
// 有附件服务就带图，没有就只回文本，两种装配都正常工作。
export const inject=['tools','subprocess','jobs']
export interface Config {
  executable?:string
  workspace?:string
  /** 贴图接口根地址（默认官方 api.polyhaven.com）；本仓离线/镜像环境与测试用它注入本地夹具。 */
  textureApiBase?:string
  /**
   * DXF 读取（`cad_inspect`）用的隔离 Python 解释器（必须装了 ezdxf）。
   * 未配置时回落到环境变量 `LYAPUNOV_CAD_PYTHON`；两者都没有时**不猜**解释器，
   * 工具报 `CAD_PYTHON_UNCONFIGURED` 并给出安装命令——源码在、依赖不在时不许说"可用"。
   */
  cadPython?:string
  /**
   * 照片相机拟合（`camera_fit`）用的隔离 Python 解释器（必须装了 opencv-python-headless + numpy）。
   * 未配置时回落到环境变量 `LYAPUNOV_CAMERA_FIT_PYTHON`；两者都没有时**不猜**解释器，
   * 工具报 `CAMERA_FIT_PYTHON_UNCONFIGURED` 并给出安装命令。
   */
  cameraFitPython?:string
  /**
   * DWG → DXF 转换器（`drawing_inspect` / `cad_convert` 读 DWG 时用），例如 LibreDWG 的 `dwg2dxf`。
   * 不给则回落 `LYAPUNOV_DWG_CONVERTER`（另有 `_KIND`/`_ARGS`），再沿 PATH 探测；都没有时
   * 工具报 `DWG_CONVERTER_UNCONFIGURED` 并给出安装指引——不假装能读 DWG。
   */
  dwgConverter?:string
}
declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { blender:'blender' } }

/** 附件服务（可选）：装配了就把图真的送进上下文，没装配就如实记进图片读数。 */
function attachmentStore(ctx:Context):ImageStore|undefined{
  return ctx.get('attachments') as ImageStore|undefined
}

/** 贴图工具的公共选项：取消信号从前台调用或后台作业来，下载因此可取消。 */
function textureOptions(config:Config, signal:AbortSignal):{apiBase?:string;signal:AbortSignal}{
  return {...config.textureApiBase?{apiBase:config.textureApiBase}:{},signal}
}

/** 分辨率档位（与 textures.ts 的 Poly Haven 档位一致）。该模块未导出档位表，这里只做入口期校验并给出可选值，真值仍由取图侧自己校验。 */
const TEXTURE_RESOLUTIONS:readonly TextureResolution[]=['1k','2k','4k','8k']

/**
 * `material_textures` 的一项：老写法是关键词字符串，新写法是明确资产选项 `{assetId,resolution}`。
 * 两种都支持，是因为"按关键词猜"与"模型看图后的明确选择"是两条真实路径，缺一都不完整。
 */
type TextureChoice={query:string|undefined;assetId?:string;resolution?:TextureResolution}
function parseTextureChoice(material:string,raw:unknown):TextureChoice|{problem:string}{
  if(typeof raw==='string'){
    return raw.trim().length>0?{query:raw}:{problem:`MATERIAL_TEXTURES_INVALID: 「${material}」的关键词是空字符串`}
  }
  if(typeof raw!=='object'||raw===null||Array.isArray(raw)){
    return {problem:`MATERIAL_TEXTURES_INVALID: 「${material}」的值需要是关键词字符串，或 {"assetId":"…","resolution":"2k"}（收到 ${JSON.stringify(raw)??'undefined'}）`}
  }
  const {assetId,resolution,query}=raw as {assetId?:unknown;resolution?:unknown;query?:unknown}
  if(assetId!==undefined&&(typeof assetId!=='string'||assetId.trim().length===0))return {problem:`MATERIAL_TEXTURES_INVALID: 「${material}」的 assetId 需要非空字符串（用 blender_texture_search 查候选）`}
  if(query!==undefined&&(typeof query!=='string'||query.trim().length===0))return {problem:`MATERIAL_TEXTURES_INVALID: 「${material}」的 query 需要非空字符串`}
  const id=typeof assetId==='string'?assetId.trim():undefined
  const terms=typeof query==='string'?query.trim():undefined
  if(id===undefined&&terms===undefined)return {problem:`MATERIAL_TEXTURES_INVALID: 「${material}」既没有 assetId 也没有关键词（先用 blender_texture_search 看候选）`}
  if(resolution!==undefined&&!TEXTURE_RESOLUTIONS.includes(resolution as TextureResolution))return {problem:`MATERIAL_TEXTURES_INVALID: 「${material}」的 resolution 只能是 ${TEXTURE_RESOLUTIONS.join('/')}，收到「${String(resolution)}」`}
  return {query:terms??id,...id!==undefined?{assetId:id}:{},...resolution!==undefined?{resolution:resolution as TextureResolution}:{}}
}

/**
 * 后台作业完成时，用**原生 Agent 消息**把同一批渲染图投给 owner。
 *
 * 为什么是 `owner.inject` 而不是 `followup`：`inject` 把消息排进 owner 的下一步（durable，
 * 见 AgentLoop 的 inbox splice），**不唤醒**驱动——这样原生的作业完成通知（tool-jobs 的
 * onJobDone 投递）仍然只唤醒一次，不会因为带图就多开一轮模型请求，也不会另起 Agent。
 * 投递本身失败（owner 已释放等）时把原因写回图片读数，结果文本里明说没送到。
 */
function deliverImagesToOwner(owner:unknown, jobId:string|undefined, report:ImageReport, refs:readonly unknown[]):void{
  const target=owner as {inject?:(message:unknown)=>void}|undefined
  if(typeof target?.inject!=='function'){
    report.delivery='none'
    report.deliveryError='执行上下文没有可投递的 owner agent（inject 不可用）：图只能按结果里的路径自行读取'
    return
  }
  const where=jobId===undefined?'' : `（作业 ${jobId}）`
  const text=`Blender 后台渲染完成${where}：随本条消息附上 ${refs.length} 张渲染图`
    +`（结果里共 ${report.requested} 张路径${report.skipped.length?`，本次只带 ${MAX_RESULT_IMAGES} 张`:'，全部带到'}）。`
    +'这些图来自本次作业的结果行；要重新取用请调用 blender_job_images。'
  const content:ContentBlock[]=[{type:'text',text},...refs.map(ref=>({type:'image',attachment:ref} as ContentBlock))]
  try{
    target.inject(createUserMessage({content,source:{kind:'plugin',plugin:name,form:'notice',summary:`Blender 渲染图 ${refs.length} 张${where}`}}))
    report.delivery='job-notice'
  }catch(error){
    report.delivery='none'
    report.deliveryError=`投递失败：${String(error instanceof Error?error.message:String(error))}`
  }
}


/**
 * 多参照尺度互校：每个参照物给 px 与 m，算出 px/m，报告它们的不一致程度。
 *
 * **只**用"输入参照彼此是否自洽"这一条判据——不需要真值，所以在真实照片上同样有效；
 * 但它的结论范围就只有这么宽：**参照彼此一致不等于实际尺寸正确**（所有参照可能出自同一个
 * 错误假设，例如把 1.6 m 的门当成 2 m），实际尺寸仍要独立核对（现场测量、已知层高/门高、
 * 图上标注等）。因此这里只报"输入自洽度"这个读数，不设阈值判通过/失败、也不加门禁：
 * 从照片标定是估计，接受与否由模型/用户决定（合同 §7 不做假保证）。
 *
 * 每个参照必须**同时**给出正的 pixels 与 metres；缺一或非正数的进 `skipped`（不参与统计）。
 */
function checkScaleAnchors(anchors: unknown): Record<string, unknown> {
  if (!Array.isArray(anchors) || anchors.length === 0) return { error: 'SCALE_ANCHORS_EMPTY: 需要至少一个 {name,pixels,metres}' }
  const rows: Array<{ name: string; pxPerM: number }> = []
  const skipped: string[] = []
  for (const raw of anchors) {
    const item = raw as { name?: unknown; pixels?: unknown; metres?: unknown }
    const name = typeof item?.name === 'string' ? item.name : `anchor${rows.length + 1}`
    const pixels = typeof item?.pixels === 'number' ? item.pixels : Number.NaN
    const metres = typeof item?.metres === 'number' ? item.metres : Number.NaN
    if (!Number.isFinite(pixels) || !Number.isFinite(metres) || pixels <= 0 || metres <= 0) { skipped.push(name); continue }
    rows.push({ name, pxPerM: pixels / metres })
  }
  if (!rows.length) return { error: 'SCALE_ANCHORS_INVALID: 没有任何参照同时给出正的 pixels 与 metres', skipped }
  const values = rows.map(row => row.pxPerM)
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const spread = Math.max(...values) - Math.min(...values)
  const disagreementPercent = mean === 0 ? 0 : (spread / mean) * 100
  return {
    anchors: rows.map(row => ({ ...row, deviationPercent: Number((((row.pxPerM - mean) / mean) * 100).toFixed(3)) })),
    meanPxPerM: Number(mean.toFixed(4)),
    disagreementPercent: Number(disagreementPercent.toFixed(3)),
    ...(skipped.length ? { skipped } : {}),
    reading: rows.length < 2
      ? '只有一个参照：无法互校，输入自洽度未知。再加一个已知尺寸（门高/层高/比例尺）'
      : disagreementPercent <= 10
        ? `输入参照彼此自洽（不一致 ${disagreementPercent.toFixed(1)}%）：这只说明你给的这几个数内部一致，**实际尺寸仍待独立核对**（用现场测量/已知层高/图上标注对一次），本读数不构成几何验证`
        : `输入参照互不一致 ${disagreementPercent.toFixed(1)}%：某个参照测错了，或它们不在同一深度；重测后再建模`,
  }
}

/** argv 的输入：路径都已解析成绝对路径（相对路径的基准见 execute 里的任务工作区）。 */
export interface BlenderArgvInput {
  /** Blender 可执行文件；缺省取 BLENDER_EXECUTABLE，再缺省取 PATH 上的 blender。 */
  executable?:string
  /** world.py 的绝对路径。 */
  worldScript:string
  /** 输出目录（绝对路径）。 */
  output:string
  /** 打开的源 blend（绝对路径）；缺省用 --factory-startup 起空工程。 */
  sourceBlend?:string
  /** 在 world.py 之前执行的用户脚本（绝对路径）。 */
  pythonScript?:string
  /** build=建模+导出（默认）；preview=只渲染预览，不全量导出；export=只导出。 */
  operation?:BlenderOperation
  /** 要渲染的相机对象名；透传为 --cameras 的 JSON 数组。 */
  cameraNames?:readonly string[]
  /** 渲染分辨率 [宽,高]；透传为 --resolution 的 JSON。 */
  resolution?:readonly number[]
  /** 渲染采样数；透传为 --samples。 */
  samples?:number
  /** 显式材质色；由实际Principled插槽写入，并进入原有恢复摘要身份。 */
  materialColors?:string
  fixture?:boolean
  architecture?:boolean
  render?:boolean
}

/**
 * blender_run 的子进程 argv。纯函数：参数到 CLI 的映射逐项可核对，不在这里起进程。
 *
 * 两个顺序/存在性约定不是随手写的：
 *  · `--python-exit-code 1` 必须在**任何** `--python` 之前，Blender 才会在脚本抛异常时用非零退出码收场；
 *    否则"用户脚本挂了、world.py 照旧打完结果行"会被当成成功。
 *  · `--operation` 只在调用方显式给出时透传：world.py 的 CLI 默认就是 build（同一份合同），
 *    缺省不塞多余参数；显式给出（含 build）时按调用方要求逐字传递。
 */
export function blenderArgv(input:BlenderArgvInput):string[]{
  return [
    input.executable??process.env.BLENDER_EXECUTABLE??'blender',
    '--background',
    ...input.sourceBlend?[input.sourceBlend]:['--factory-startup'],
    '--python-exit-code','1',
    ...input.pythonScript?['--python',input.pythonScript]:[],
    '--python',input.worldScript,
    '--',
    '--output',input.output,
    ...input.operation?['--operation',input.operation]:[],
    ...input.cameraNames?['--cameras',JSON.stringify(input.cameraNames)]:[],
    ...input.resolution?['--resolution',JSON.stringify(input.resolution)]:[],
    ...input.samples!==undefined?['--samples',String(input.samples)]:[],
    ...input.materialColors!==undefined?['--material-colors',input.materialColors]:[],
    ...input.fixture?['--fixture']:[],
    ...input.architecture?['--architecture']:[],
    ...input.render?['--render']:[],
  ]
}

/**
 * **A5：恢复时的输入源。** 恢复**不用** `--factory-startup` 重开空工程，而是用本作业已经写出的
 * `output/source.blend`（存在时）。
 *
 * 为什么这一条是"参考资产保持同一对象"的机器判据：world.py 的
 * `namespace = bpy.context.scene.get('lyapunov_resource_namespace') or str(uuid.uuid4())`（`world.py:495`）
 * 把资源身份前缀存在**工程属性**里。从空工程重开 ⇒ 新铸 namespace ⇒ 所有 `resourceId` 变化，
 * "同一对象"在资源身份层面就不成立；打开本作业自己的工程才能把 namespace 原样带回来。
 * （`sceneId` 由 world.py `:656` 从上一份 `scene.json` 继承，与走哪条输入路径无关；
 *  `revision` 每次都单调 +1，天然会前进。）
 *
 * 工程文件不存在时**不假装**：如实回落到原 argv（空工程/原 source_blend），由调用方从
 * `blender_job_control(action:'status')` 的 `resumedWith` 读到这次到底用了哪个输入。
 */
export function resumeArgv(input:BlenderArgvInput,exists:(path:string)=>boolean):string[]{
  const source=join(input.output,'source.blend')
  return exists(source)?blenderArgv({...input,sourceBlend:source}):blenderArgv(input)
}

/** 参数边界校验：坏形状在起进程之前就说清楚，不把非法 JSON 递给 world.py。 */
function checkRunArguments(input:{cameraNames?:readonly string[];resolution?:readonly number[];samples?:number}):void{
  if(input.resolution&&(input.resolution.length!==2||!input.resolution.every(v=>Number.isInteger(v)&&v>0)))throw new Error(`BLENDER_ARGUMENT_INVALID: resolution 需要 [宽,高] 两个正整数，收到 ${JSON.stringify(input.resolution)}`)
  if(input.samples!==undefined&&(!Number.isInteger(input.samples)||input.samples<=0))throw new Error(`BLENDER_ARGUMENT_INVALID: samples 需要正整数，收到 ${JSON.stringify(input.samples)}`)
  if(input.cameraNames?.some(name=>typeof name!=='string'||name.trim().length===0))throw new Error(`BLENDER_ARGUMENT_INVALID: camera_names 需要非空字符串数组（Blender 相机对象名），收到 ${JSON.stringify(input.cameraNames)}`)
}

export function apply(ctx:Context, config:Config={}) {
  /**
   * 相对路径的基准是**任务工作区**（原生会话 header cwd，与终端/工作台同一事实），
   * 不再固定落产品根；没有会话 cwd 时才退回插件显式配置的 workspace，两者都没有就明确报错，
   * 不另造 cwd 字段、也不悄悄拿进程 cwd 当基准。三个工具共用这一条解析。
   */
  const absolute=(exec:{agent?:{session?:{header?:{cwd?:string}}}|undefined},value:string,label:string):string=>{
    if(isAbsolute(value))return value
    const cwd=exec.agent?.session?.header?.cwd??(config.workspace?resolve(config.workspace):undefined)
    if(!cwd)throw new Error(`BLENDER_CWD_UNRESOLVED: ${label} 是相对路径（${value}），但当前执行上下文没有会话工作目录、本插件也未配置 workspace；请传绝对路径`)
    return resolve(cwd,value)
  }
  /**
   * 结果文本 → 本次要带进模型上下文的图像附件。
   * `output.render` 必须**同步**返回 ContentBlock[]，而附件化是异步的，所以图像在 `execute`
   * 里就附件化好，这里只做同步取用；取用后即删，避免长会话里按结果文本无限增长。
   */
  const attachmentsByResult=new Map<string,unknown[]>()
  /**
   * 后台作业的控制表（A1）。**不复制**作业记录：jobId/状态/输出仍在原生 `ctx.jobs`；
   * 这里只放"生产者控制面"（暂停请求、恢复信号、检查点读数）。
   * 为什么不放在 jobs 面：原生 `JobHooks` 只有 `cancel`/`done`/`readOutput`（类型定义 `types.ts:72-91`），
   * 没有 pause/resume；而 `done` 不落定 ⇒ 记录恒为 running ⇒ **jobId 逐字不变**——这是本项的因果链。
   */
  const jobControls=new Map<JobId,BlenderJobControl>()
  /** 调用方输入的摘要（不是派生 argv 的摘要，见用法处注释）。 */
  const digestOf=(value:unknown):string=>`sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
  const jobStatePath=(directory:string):string=>join(directory,JOB_STATE_FILE)
  const readJobState=async(directory:string):Promise<Record<string,unknown>|undefined>=>{
    try{ return JSON.parse(await readFile(jobStatePath(directory),'utf8')) as Record<string,unknown> }
    catch{ return undefined }
  }
  const writeJobState=async(control:BlenderJobControl,state:JobStateFileState):Promise<void>=>{
    await mkdir(control.output,{recursive:true})
    const body={version:1,jobId:control.jobId,argvDigest:control.argvDigest,state,
      completedPhases:control.completedPhases,resumeCount:control.resumeCount,
      ...control.pausedAt?{pausedAt:control.pausedAt}:{},
      ...state==='resumed'?{resumedAt:new Date().toISOString()}:{}}
    await writeFile(jobStatePath(control.output),JSON.stringify(body,null,2)+'\n')
  }
  const controlState=(control:BlenderJobControl):BlenderControlState=>control.waiting?'paused':control.requested?'pause-requested':'running'
  const deferred=():{promise:Promise<void>;resolve:()=>void}=>{
    let resolve:()=>void=()=>undefined
    const promise=new Promise<void>(settle=>{resolve=settle})
    return {promise,resolve}
  }
  /** 有界等待：`true`=等到了，`false`=超时（超时不是失败，是"暂停请求已受理但本阶段还没停下"）。 */
  const withTimeout=async(promise:Promise<void>,ms:number):Promise<boolean>=>{
    let timer:ReturnType<typeof setTimeout>|undefined
    try{ return await Promise.race([promise.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),ms)})]) }
    finally{ if(timer!==undefined)clearTimeout(timer) }
  }
  ctx.tools.register(defineTool({name:'blender_run',description:'Run actual Blender to open a project and execute a Python modelling script. Use operation to build, preview, or export: scene hierarchy, separate GLBs, original blend, and optional physics representations.',parameters:{output_directory:{type:'string',required:true,description:'World-project output directory. Relative paths resolve against the current session task workspace, never the product root.'},source_blend:{type:'string',description:'Optional original blend project path.'},python_script:{type:'string',description:'Path to a Python file executed inside Blender. Set actual Principled BSDF Base Color using node.type/Socket.identifier rather than localized display names; changing only diffuse_color exports grey/white in Blender5.2. Alternatively declare material_colors explicitly. Example: ground_asset/create_ground.py. Supply a file path, not code text; save multiline scripts with write first. Relative paths resolve against the task workspace. Script exceptions still fail with a nonzero exit code.'},operation:{type:'string',enum:['build','preview','export'],default:'build',description:'build (default) models and fully exports, with optional render; preview opens the project and renders a local preview without a full export; export only exports, without implicit rendering.'},camera_names:{type:'array',items:{type:'string'},description:'Optional array of camera object names, passed unchanged as world.py --cameras JSON. Use with preview/build for multiple viewpoints.'},resolution:{type:'array',items:{type:'integer'},description:'Optional render resolution [width,height], both positive integers, passed as --resolution JSON.'},samples:{type:'integer',description:'Optional positive integer render sample count, passed as --samples.'},fixture:{type:'boolean',description:'Generate a verification project with a room, table, block, and moving door.'},architecture:{type:'boolean',description:'Generate an editable U-shaped courtyard building, cameras, lights, and physics representations for multiple engines.'},render:{type:'boolean',description:'Also produce preview renders. The script/project must already contain a valid camera. Use false when only GLB/collision outputs are needed; without a camera, preview success cannot be claimed.'},texture_query:{type:'string',description:'Optional: fetch one PBR texture set from Poly Haven (CC0) into this output directory and return per-image local paths and a manifest for actual building/object materials.'},material_colors:{type:'string',description:'Optional JSON object mapping material names to RGBA, for example {"Banana_Yellow":[1,0.7,0.02,1]}. Set actual Principled Base Color before export and return the actual receipt; do not infer colour from names. Unknown materials, nonfinite values, values outside 0..1, or existing colour-texture links are rejected.'},material_textures:{type:'string',description:'Optional: **connect fetched CC0 textures to material nodes**. Each JSON value can be a keyword string ({"material-name":"plaster concrete"}) or an explicit asset choice ({"material-name":{"assetId":"plaster_concrete_wall","resolution":"2k"}}; use blender_texture_search first to inspect candidates and available resolutions). Fetch textures, write textures.json, and require Blender to connect them to the corresponding Principled BSDF before export: Diffuse to Base Color, Rough to Roughness, nor_gl to Normal, and AO multiplied into base colour. textureRequest reports materials actually fetched or not fetched with per-item reasons; materialTextures reports actual connected materials/images and explicitly lists failed connections.'},scale_anchors:{type:'string',description:'Optional scale-reference consistency check; reports only and does not block. Supply a JSON array of {"name":"scale-reference","pixels":500,"metres":5,"kind":"length"}. Every reference must provide positive pixels and metres; missing or nonpositive references are skipped and named in skipped. Compute px/m for each reference, mutual inconsistency percentages, and maximum deviation to show whether these inputs are internally consistent. **This does not verify actual dimensions**; references may share the same wrong assumption. Independently check dimensions with site measurements, known floor heights, or drawing annotations. The model/user decides whether to accept them.'},background:{type:'boolean',description:'Run in DSH Jobs in the background and immediately return jobId. After completion, job_output reads **the same result line**, including preview/extraRenders paths. When the job actually completes, a completion notification with render-image attachments is delivered directly to this session without polling. blender_job_images(job_id) can also return the images to context. Cancelled/failed jobs deliver no images. Use blender_job_control to pause/resume with **the same jobId**; resume reruns the same job and recomputes completed phases, rather than resuming from a computation checkpoint. Native job_list still shows running while paused.'}},output:{schema:{type:'object',additionalProperties:false,properties:{result:{type:'string',required:true}}},render:(_args,value)=>{const refs=attachmentsByResult.get(value.result);attachmentsByResult.delete(value.result);const blocks:ContentBlock[]=[{type:'text',text:value.result}];for(const ref of refs??[])blocks.push({type:'image',attachment:ref as never});return blocks}},async execute(args,exec){
    const taskCwd=exec.agent?.session.header.cwd??(config.workspace?resolve(config.workspace):undefined)
    // python_script 是文件路径；模型内联代码不能作为 --python 的文件名交给操作系统。
    if(args.python_script&&/[\r\n]/.test(args.python_script))throw new Error('BLENDER_SCRIPT_PATH_EXPECTED: python_script 只接受Python文件路径，不能填多行代码；请先用write保存脚本，再传该路径')
    const output=absolute(exec,args.output_directory,'output_directory')
    const operation:BlenderOperation=args.operation??'build'
    checkRunArguments({cameraNames:args.camera_names,resolution:args.resolution,samples:args.samples})
    // 透传的是**调用方显式给出的** operation：缺省时 build 由 world.py 的 CLI 默认承担
    // （同一份合同），插件不替它加参数——否则会朝尚未支持该选项的旧脚本塞未知参数。
    const argvInput:BlenderArgvInput={executable:config.executable,worldScript:fileURLToPath(new URL('./world.py',import.meta.url)),output,operation:args.operation,...args.source_blend?{sourceBlend:absolute(exec,args.source_blend,'source_blend')}:{},...args.python_script?{pythonScript:absolute(exec,args.python_script,'python_script')}:{},...args.camera_names?{cameraNames:args.camera_names}:{},...args.resolution?{resolution:args.resolution}:{},...args.samples!==undefined?{samples:args.samples}:{},...args.material_colors!==undefined?{materialColors:args.material_colors}:{},...args.fixture?{fixture:true}:{},...args.architecture?{architecture:true}:{},...args.render?{render:true}:{}}
    const argv=blenderArgv(argvInput)
    // 贴图：先取图并落 textures.json，**再**跑 Blender——因为接线发生在 Blender 进程内（world.py），
    // 它读的就是这个文件。此前我把写清单放在 Blender 跑完之后，导致"接线永远看不到清单"，
    // 实测结果是 materialTextures 为空、GLB 里 0 张贴图。顺序错了，能力就等于没有。
    //
    // 取图放在这个函数里、由调用方在**作业内**（后台）或调用期（前台）执行，取消信号随之传入，
    // 于是下载和渲染一样可被 job_kill 打断。material_textures 的每一项既接受老写法的关键词字符串，
    // 也接受明确资产选项 {"assetId":…,"resolution":…}（先用 blender_texture_search 看候选）。
    const prepareTextures=async(signal:AbortSignal):Promise<Record<string,unknown>|undefined>=>{
      if(!args.material_textures)return undefined
      try{
        const wanted=JSON.parse(args.material_textures) as Record<string,unknown>
        const sets:Record<string,unknown>={}
        const failures:Record<string,string>={}
        for(const [material,raw] of Object.entries(wanted)){
          const choice=parseTextureChoice(material,raw)
          if('problem' in choice){failures[material]=choice.problem;continue}
          try{
            sets[material]=await fetchTextureSet(choice.query,join(output,'textures'),{...textureOptions(config,signal),...choice.assetId?{assetId:choice.assetId}:{},...choice.resolution?{resolution:choice.resolution}:{}})
          }catch(error){ failures[material]=String(error instanceof Error?error.message:String(error)) }
        }
        // 取图途中被取消：**不写清单**——这次 Blender 根本不会跑，留下一个空清单会像"一次可用的取图"。
        if(signal.aborted)return {materials:Object.keys(wanted),fetched:Object.keys(sets),failures}
        await mkdir(join(output,'textures'),{recursive:true})
        await writeFile(join(output,'textures.json'),JSON.stringify({sets},null,2)+'\n')
        return {materials:Object.keys(wanted),fetched:Object.keys(sets),failures}
      }catch(error){
        return {error:`MATERIAL_TEXTURES_UNREADABLE: ${String(error instanceof Error?error.message:String(error))}`}
      }
    }
    const spawn=(signal:AbortSignal,argvNow:readonly string[])=>ctx.subprocess.spawn({argv:argvNow,cwd:taskCwd??process.cwd(),stdio:{stdin:'ignore',stdout:{maxBytes:1000000},stderr:{maxBytes:200000}},signal,graceMs:3000,env:{HF_ENDPOINT:'https://hf-mirror.com'}})
    /**
     * 起进程，但"信号已经触发"不算 spawn 失败：provider 会拒绝在已取消的信号上起进程
     * （取图阶段被取消就会走到这里），那是取消，不是环境坏了。收尾判据统一在 settle 里给。
     */
    const spawnWhenLive=(signal:AbortSignal,argvNow:readonly string[]):SubprocessHandle|undefined=>{
      try{ return spawn(signal,argvNow) }
      catch(error){ if(signal.aborted)return undefined; throw error }
    }
    const collected=(child:SubprocessHandle)=>({stdout:child.collected.stdout?.readFrom(0).text??'',stderr:child.collected.stderr?.readFrom(0).text??''})
    /** 收尾：进程事实 → 共用判定。spawn 失败也收敛成同一形状，前台/后台不各写一套判据。 */
    const settle=async(signal:AbortSignal,child:SubprocessHandle|undefined)=>{
      if(child===undefined)return finishBlenderRun({exitCode:null,signal:null,stdout:'',stderr:'',cancelled:true},RESULT_PREFIX)
      try{
        const outcome=await child.done,io=collected(child)
        return finishBlenderRun({...io,exitCode:outcome.exitCode,signal:outcome.signal,cancelled:signal.aborted},RESULT_PREFIX)
      }catch(error){
        const io=collected(child)
        // 信号已触发时等待/收尾失败同样是取消；真·spawn 故障才报 BLENDER_SPAWN_FAILED。
        if(signal.aborted)return finishBlenderRun({...io,exitCode:null,signal:null,cancelled:true},RESULT_PREFIX)
        return blenderSpawnFailure(error,io.stdout,io.stderr)
      }
    }
    /**
     * 结果 JSON 上的**异步**读数（贴图清单 / 尺度自检）：只在有请求时改写，否则结果行原样返回。
     *
     * 单独拆出来的原因：它是收尾阶段唯一会等网络的一步。后台作业必须把这一步走完再检查取消、
     * 再决定投不投图——顺序反了就会出现"作业已被 job_kill 杀掉，图却已经投进会话"。
     * 取图途中被取消时**抛取消**，不把它吞成 `textures.error`（那样取消会被当成一次普通失败）。
     */
    const applyReadings=async(value:Record<string,unknown>,raw:string,signal:AbortSignal,textureRequest?:Record<string,unknown>):Promise<string>=>{
      let changed=false
      if(textureRequest){value.textureRequest=textureRequest;changed=true}
      else if(args.texture_query){
        // 只取图、不接节点（老用法保留）：用于"我只想要贴图文件"的场景。
        try{ value.textures=await fetchTextureSet(args.texture_query, join(output,'textures'), textureOptions(config,signal)) }
        catch(error){
          const reason=String(error instanceof Error?error.message:String(error))
          if(signal.aborted)throw new Error(`BLENDER_CANCELLED: 取贴图阶段被取消（${reason}）`)
          value.textures={error:reason}
        }
        changed=true
      }
      // 尺度标定自检（只报告、不阻断）：多个独立参照各算 px/m，给出彼此不一致度。
      // 为什么需要它：从照片推米数依赖参照物，单靠一次心算无法发现自己错了；
      // 有了互校读数，模型能看到"我这两个参照差了 30%"而回头重测，而不是照着错的比例建。
      // 注意它的结论范围：只说明输入自洽，不等于实际尺寸被验证过。
      if(args.scale_anchors){
        try{ value.scaleCheck=checkScaleAnchors(JSON.parse(args.scale_anchors)) }
        catch(error){ value.scaleCheck={error:`SCALE_ANCHORS_UNREADABLE: ${String(error instanceof Error?error.message:String(error))}`} }
        changed=true
      }
      return changed?JSON.stringify(value):raw
    }
    /**
     * 图片附件化读数（**同步**附加）：`render: true` 跑完不等于模型看见了图，只有 attached 才是
     * 真的进了上下文；失败原因写成文本，模型能据此判断。同步是刻意的——后台投递之后不能再有
     * 异步步骤，否则"投递结果"与"作业结局"会互相矛盾。
     */
    const withImages=(value:Record<string,unknown>,report:ImageReport):string=>JSON.stringify({...value,images:report})
    // `render: true` 是显式请求渲染；`operation: 'preview'` 本身就只渲染（world.py 的合同），
    // 两者都算"请求了渲染"——只有这样才该在"一张图都没附上"时给明确失败读数。
    const renderRequested=args.render===true||operation==='preview'
    if(args.background){
      // 后台作业的存活期**不绑定**本次工具调用：调用早就返回了，作业还要继续跑，
      // 所以取消信号来自 job 自己的 cancel（job_kill / owner 释放），它不是 exec.signal。
      // 但**启动前**要尊重已取消的调用：调用方已经撤销了，就不该再起一个作业。
      if(exec.signal.aborted)throw new Error('BLENDER_CANCELLED: 调用已被取消（后台作业尚未启动）')
      // 同输出目录互斥：同一 output 已有**未终态**的 blender 作业时明确拒绝，不启动第二个。
      // 否则两个作业的工程文档会 last-writer-wins，落成"混合态"（N106 实测：blender-7 rev1 被 blender-6 rev2 覆盖）。
      // 判据复用既有快照与既有 label 约定——`JobSnapshot` 里没有 output 字段（dsh-jobs/src/types.ts:100-114），
      // 而 label 就是本插件自己写的 `Blender ${operation} ${output}`；不新增调度器/锁文件/配置。
      const busy=ctx.jobs.list(exec.agent).find(job=>job.kind==='blender'&&job.status!=='completed'&&job.status!=='killed'&&job.status!=='failed'&&job.label===`Blender ${operation} ${String(output)}`)
      if(busy)throw new Error(`BLENDER_OUTPUT_BUSY: 输出目录 ${output} 已有未完成作业 ${busy.id}（${busy.status}）`)
      const controller=new AbortController()
      /**
       * 控制句柄在 `start()` **之前**建好、`jobId` 在 `start()` 返回后回填（A3）：id 由 jobs-local
       * 在 `spec.run()` 之后才铸（`jobs-local:150-153`），而 `run()` 内部的 `done` IIFE 是同步启动的，
       * 先建对象才能让闭包在任何时刻都拿到同一个句柄，不出现"还没赋值就被读到"的窗口。
       */
      const control:BlenderJobControl={
        jobId:'' as JobId,output,
        // 摘要只用**调用方输入**（argv/output/source_blend/material_textures），不含 A5 派生出来的
        // 恢复 argv——否则恢复时换了输入源，检查点会把自己判成"输入不符"。
        argvDigest:digestOf({argv,output,sourceBlend:argvInput.sourceBlend??null,materialTextures:args.material_textures??null,materialColors:args.material_colors??null}),
        completedPhases:[],resumeCount:0,requested:false,waiting:false,
      }
      const started=ctx.jobs.start({kind:'blender',label:`Blender ${operation} ${output}`,owner:exec.agent,run:()=>{
        // 子进程在**取完贴图之后**才起：world.py 读的就是 textures.json，先跑进程会让本次接线看不到清单。
        // 取图在作业内、用作业自己的信号，所以这一步也能被 job_kill 取消（下载中和渲染中都能停）。
        let child:SubprocessHandle|undefined
        /** 暂停要停的是"当前这一次尝试"的子进程；每次 spawn 后这个闭包自动指向新的那个。 */
        control.stopChild=()=>child?.terminate()
        /** 收尾阶段的取消：作业已落 killed，图**不投递**（结果文本里说明走到哪一步被取消的）。 */
        const killedAt=(stage:string):JobOutcome=>{
          const io=child?collected(child):{stdout:'',stderr:''}
          return {status:'killed' as const,output:blenderEvidence(`BLENDER_CANCELLED: 作业在${stage}被取消（Blender 进程已完成，结果不作为本次产出投递）`,io.stdout,io.stderr),detail:`operation=${operation}`}
        }
        /**
         * 暂停生效：写状态文件（`pausedAt` 只有到这一步才写）、通知 pause 调用方、等恢复信号。
         * 返回 `undefined` = 已恢复，调用方 `continue` 重跑同一作业；返回 `JobOutcome` = 暂停期间被
         * `job_kill`（取消必须落定，见 `cancel` 里的第 ③ 条）。
         */
        const park=async():Promise<JobOutcome|undefined>=>{
          control.pausedAt=new Date().toISOString()
          control.waiting=true
          await writeJobState(control,'paused')
          control.stopped?.resolve()
          await new Promise<void>(resolve=>{control.wakeResume=resolve})
          control.wakeResume=undefined
          if(controller.signal.aborted)return killedAt('暂停期间')
          control.waiting=false
          control.requested=false
          control.resumeCount+=1
          child=undefined
          await writeJobState(control,'resumed')
          return undefined
        }
        /**
         * 生产者循环。**这是本项"保持同一 jobId"的全部机制**：
         *
         * 原生记录的终态只由 `hooks.done` 落定（`jobs-local:178-190` 把 `hooks.done.then(...)` 接到 `settle`，
         * `settle` 对终态 first-wins，`:416-418`）。暂停时这个 IIFE **不 return**（也就永远不落定），
         * 记录因此恒为 `running` ⇒ 上游不会另铸 id，**jobId 逐字不变**。
         * 恢复＝同一 argv 再 spawn 一次（A5：存在 `output/source.blend` 时改用它），
         * 不是"断点续算"——本次尝试里 world.py 已做的阶段会重算（world.py 内部没有检查点，那是 P1）。
         */
        const done=(async():Promise<JobOutcome>=>{
          for(let attempt=0;;attempt++){
            // 唤醒/进入新一轮前先看作业级信号：暂停期间被 job_kill 时，取消要在**这里**落定，
            // 而不是再起一次子进程（否则 job_kill 会被"恢复"抵消掉，作业永远不结束）。
            if(controller.signal.aborted)return killedAt('暂停等待阶段')
            const textureRequest=await prepareTextures(controller.signal)
            if(controller.signal.aborted)return {status:'killed' as const,output:'BLENDER_CANCELLED: 作业在取贴图阶段被取消（Blender 进程尚未启动）',detail:`operation=${operation}`}
            // 输入准备阶段完成（贴图清单已落盘；没有请求贴图时这一步是空转，不记成"完成了什么"）。
            if(attempt===0&&textureRequest!==undefined&&!('error' in textureRequest)&&args.material_textures)control.completedPhases=['textures']
            // 暂停请求若在起进程**之前**就到了（典型：取图阶段收到请求），这一轮干脆不起进程：
            // P0 的"阶段边界"就是这个位置，少起一个马上要被杀掉的进程。
            if(control.requested&&!controller.signal.aborted){
              const parked=await park()
              if(parked)return parked
              continue
            }
            // 第一次尝试走调用方的 argv（逐字不变）；恢复走 A5：本作业已写出的 source.blend（存在时）。
            const argvNow=attempt===0?argv:resumeArgv(argvInput,existsSync)
            child=spawnWhenLive(controller.signal,argvNow)
            const finish=await settle(controller.signal,child)
            // 暂停判定**先于**结果判定：暂停也是用既有的 terminate() 停的进程，finish 的形状与失败/取消
            // 一样，差别只在这条介入请求是我们自己发的（且作业级信号没被打掉）。
            if(control.requested&&!controller.signal.aborted){
              const parked=await park()
              if(parked)return parked
              continue
            }
            // 取消/失败**不发旧图**：只有本次真的 completed 才去碰结果里的图片路径
            // （磁盘上可能还留着上一轮的 preview.png，凭路径发图就会把旧图当新结果）。
            if(finish.status!=='completed')return {status:finish.status,output:finish.error,detail:`operation=${operation}`}
            // 收尾读数（等网络的贴图那一步）走完再检查取消：这一步可能被 job_kill 打断。
            const decorated=await applyReadings(finish.value,finish.result,controller.signal,textureRequest)
            if(controller.signal.aborted)return killedAt('结果读数阶段')
            // 后台图的去向不是"路径文本"，而是**原生 Agent 消息**（image ContentBlock，带 jobId）：
            // 用 owner.inject 排进 owner 的下一步——它不唤醒驱动，所以原生作业完成通知的那一次唤醒不会被复制。
            // 顺序是刻意的：**附件化 → 检查取消 → 投递 → 同步拼结果文本**。投递之后不再有异步步骤，
            // 否则"作业被取消"与"完成通知带图发出去了"会同时成立。
            const {refs,report}=await attachResultImages(attachmentStore(ctx),resultImagePaths(finish.value),MAX_RESULT_IMAGES,'job-notice')
            if(controller.signal.aborted){
              report.delivery='none'
              report.deliveryError='作业在附件化阶段被取消：本次不投递图片（取消的作业不作为本次产出发给模型）'
              return killedAt(`附件化阶段（已附件化 ${report.attached} 张，全部不投递）`)
            }
            if(refs.length>0)deliverImagesToOwner(exec.agent,started,report,refs)
            else noteImageDelivery(report,{lane:'job-notice',renderRequested})
            // 终态归位（缺陷 2）：在此之前 `completedPhases` 只在 attempt 0 的输入准备阶段写过一次（`['textures']`），
            // resume 完整跑完也照旧 ⇒ 终态回执读起来像"恢复后只完成了取图"。完整跑完 = 输入准备阶段（取过图才有
            // 'textures'）+ Blender 子进程里的建模/导出/可选渲染（world.py 一次进程内完成，记 'blender'）。
            // 不新增字段、不改键名：只把既有字段在终态时写成**真的完成了什么**。
            control.completedPhases=[...control.completedPhases,'blender']
            return {status:'completed' as const,output:withImages(finish.value,report),detail:`operation=${operation}`}
          }
        })().catch(error=>{
          const message=String(error instanceof Error?error.message:String(error))
          // 取消不是失败：收尾步骤被 job_kill 打断时同样落 killed，不能混进 failed。
          return controller.signal.aborted
            ?{status:'killed' as const,output:blenderEvidence(message.startsWith('BLENDER_CANCELLED')?message:`BLENDER_CANCELLED: 作业在收尾阶段被取消（${message}）`,child?collected(child).stdout:'',child?collected(child).stderr:''),detail:`operation=${operation}`}
            :{status:'failed' as const,output:message,detail:`operation=${operation}`}
        })
        /**
         * 取消（`job_kill` / owner 释放 / 服务卸载）。三件事缺一不可：
         *  ① 打掉作业信号（取图阶段就此停住）；② 子进程起了就终止；
         *  ③ **把暂停等待中的循环放出来**——少了这一条，暂停中的作业被 kill 后
         *     `await job.settled` 永远不会 resolve，owner 释放会卡死
         *     （vendored `jobs-local:467-476` 的 `disposeOwned`，`cancelForTeardown` 的注释 `:501-506` 明写 stall）。
         * 这一段**同步**完成（`JobHooks.cancel` 的契约就是同步、幂等），不 await 生产者。
         */
        return {cancel:()=>{controller.abort();control.requested=false;child?.terminate();control.wakeResume?.()},done:done as Promise<JobOutcome>}
      }})
      // A3：id 只有 `start()` 返回后才有（`jobs-local:150-153`），此刻回填并把句柄挂进控制表。
      control.jobId=started
      jobControls.set(started,control)
      // 图已作为原生消息投给 owner，这里只回作业句柄（读取仍走原生 job_output / blender_job_images）。
      return {result:JSON.stringify({jobId:started,outputDirectory:output,...taskCwd?{cwd:taskCwd}:{}})}
    }
    const textureRequest=await prepareTextures(exec.signal)
    const finish=await settle(exec.signal,spawnWhenLive(exec.signal,argv))
    if(finish.status!=='completed')throw new Error(finish.error)
    // 结果读数（贴图/尺度）先走完，再做附件化：取消发生在任何一步都还能把整个调用判为取消。
    const decorated=await applyReadings(finish.value,finish.result,exec.signal,textureRequest)
    if(exec.signal.aborted)throw new Error('BLENDER_CANCELLED: 调用在结果读数阶段被取消')
    // 渲染图带进模型上下文：模型看到自己的产出才能判断"哪里还空/不对"并再调一次工具。
    // 自迭代由模型驱动，产品不加循环、不加门禁、不新增会话。多机位结果（preview + extraRenders）
    // 按真实路径逐张附件化，超过上限的部分仍留在结果 JSON 里（并在 images.skipped 里点名）。
    const {refs,report}=await attachResultImages(attachmentStore(ctx),resultImagePaths(finish.value),MAX_RESULT_IMAGES,'tool-result')
    noteImageDelivery(report,{lane:'tool-result',renderRequested})
    if(exec.signal.aborted)throw new Error('BLENDER_CANCELLED: 调用在附件化阶段被取消（本次不返回结果）')
    const finalResult=withImages(finish.value,report)
    if(refs.length>0)attachmentsByResult.set(finalResult,refs)
    return {result:finalResult}
  }}))

  /**
   * 材料检索：让模型**先看见候选**再决定用哪套贴图（assetId + resolution），
   * 而不是只能把一句关键词塞进 `material_textures` 碰运气。
   * 缩略图只在显式给了 `thumbnail_directory` 时才落盘并作为图像返回；不给就纯文本候选，
   * 不悄悄往用户目录里写文件。
   */
  ctx.tools.register(defineTool({name:'blender_texture_search',description:'Search Poly Haven (CC0) texture candidates by keywords. Return assetId, name, author, license/payment requirement, category tags, matched terms, score, available resolutions, and thumbnail links for selection and blender_run material_textures (for example {"material-name":{"assetId":"...","resolution":"2k"}}). With thumbnail_directory, download candidate thumbnails there and return them as images for visual selection.',parameters:{query:{type:'string',required:true,description:'Search terms, for example "plaster wall" or "wood planks". Chinese terms are supported through a built-in common-material vocabulary; unmapped Chinese terms are explicitly listed in explanation.unmapped.'},limit:{type:'integer',default:8,description:'Optional maximum number of candidates; defaults to 8.'},thumbnail_directory:{type:'string',description:'Optional directory for downloading candidate thumbnails and returning them as images. Relative paths resolve against the task workspace. Without it, write no files and return text candidates only.'}},output:{schema:{type:'object',additionalProperties:false,properties:{result:{type:'string',required:true}}},render:(_args,value)=>{const refs=attachmentsByResult.get(value.result);attachmentsByResult.delete(value.result);const blocks:ContentBlock[]=[{type:'text',text:value.result}];for(const ref of refs??[])blocks.push({type:'image',attachment:ref as never});return blocks}},async execute(args,exec){
    const dir=args.thumbnail_directory===undefined?undefined:absolute(exec,args.thumbnail_directory,'thumbnail_directory')
    const candidates=await findTextures(args.query,{...textureOptions(config,exec.signal),...args.limit!==undefined?{limit:args.limit}:{},...dir!==undefined?{thumbnails:true,thumbnailDirectory:dir}:{}})
    const paths=candidates.map(candidate=>candidate.thumbnailPath).filter((path):path is string=>typeof path==='string')
    const {refs,report}=await attachResultImages(attachmentStore(ctx),paths,MAX_RESULT_IMAGES,'tool-result')
    // 与 blender_run 同一套读数的对齐：缩略图一张都没附上时 `delivery` 是 `none`（不是 `tool-result`），
    // 否则这个字段会与自己的定义（"图片最终怎么到模型面前"）矛盾。缩略图不算"请求了渲染"，
    // 所以这里不写 deliveryError——逐条失败原因已经在本报告的 failures 里。
    noteImageDelivery(report,{lane:'tool-result',renderRequested:false})
    const text=JSON.stringify({query:args.query,explanation:explainTextureQuery(args.query),candidates,images:report})
    if(refs.length>0)attachmentsByResult.set(text,refs)
    return {result:text}
  }}))

  /**
   * 后台作业的图**再取用**入口：读的是**同一个原生作业**的输出（`ctx.jobs.read`，owner 判权由 Jobs 自己拦），
   * 不新建任务缓存、不维护私有 Job 表。作业不在本会话名下时由原生 `assertAccess` 明确拒绝；
   * 没完成（running/killed/failed）时拒绝发图——磁盘上可能还留着上一轮的 preview.png，
   * 凭路径发图就会把旧图当成本次结果。
   */
  ctx.tools.register(defineTool({name:'blender_job_images',description:`Read render images from the current output of a **completed** Blender background job in this session (blender_run background:true), and return them as images. Cancelled/failed jobs deliver no images, so leftover images from an earlier run cannot be mistaken for this result. Images beyond ${MAX_RESULT_IMAGES} remain as actual paths in result JSON and are named in images.skipped.`,parameters:{job_id:{type:'string',required:true,description:'jobId returned by blender_run background:true, for example blender-1.'},limit:{type:'integer',description:`Optional maximum number of images added to context. The default and upper limit are both ${MAX_RESULT_IMAGES} (at most ${MAX_RESULT_IMAGES} images per result; larger requested values are capped at ${MAX_RESULT_IMAGES}, and remaining images are listed in images.skipped).`}},output:{schema:{type:'object',additionalProperties:false,properties:{result:{type:'string',required:true}}},render:(_args,value)=>{const refs=attachmentsByResult.get(value.result);attachmentsByResult.delete(value.result);const blocks:ContentBlock[]=[{type:'text',text:value.result}];for(const ref of refs??[])blocks.push({type:'image',attachment:ref as never});return blocks}},async execute(args,exec){
    // owner 判权、未知作业都走原生实现；本工具不复制 job 表、不缓存结果。
    // 工具参数里 job id 就是字符串，原生实现负责校验它是否真的存在、是否属于本会话。
    if(args.limit!==undefined&&(!Number.isInteger(args.limit)||args.limit<1))throw new Error(`BLENDER_ARGUMENT_INVALID: limit 需要正整数，收到 ${JSON.stringify(args.limit)}`)
    const limit=Math.min(args.limit??MAX_RESULT_IMAGES,MAX_RESULT_IMAGES)
    const read=ctx.jobs.read(args.job_id as JobId,exec.agent)
    const {snapshot}=read
    // 会话里还有别的后台作业（原生 Jobs 不只有本插件用）：按 kind 认生产者，别的 kind 的作业
    // 即使属于本会话也不能当 Blender 结果解析（它的输出不是本插件的结果行形状）。
    if(snapshot.kind!=='blender')throw new Error(`BLENDER_JOB_IMAGES_UNAVAILABLE: 作业 ${snapshot.id} 的 kind=${snapshot.kind}，不是 Blender 生产者（本插件只认 kind=blender 的作业）。要读它的输出用原生 job_output。`)
    if(snapshot.status!=='completed')throw new Error(`BLENDER_JOB_IMAGES_UNAVAILABLE: 作业 ${snapshot.id} 当前状态是 ${snapshot.status}${snapshot.detail?`（detail=${snapshot.detail}）`:''}：只有 completed 的作业才发图，取消/失败不发图（磁盘上可能还留着上一轮的图）。要读文本用 job_output。`)
    // 作业输出就是**同一条结果 JSON**（本插件写进 JobOutcome.output 的就是它，不是带前缀的 stdout）；
    // 仍兼容"输出里带 LYAPUNOV_RESULT= 前缀行"的形态，两种都认。
    const output=read.text.trim()
    const line=lastResultLine(output,RESULT_PREFIX)
    const json=line!==undefined?line.slice(RESULT_PREFIX.length):output
    let value:unknown
    try{ value=JSON.parse(json) }
    catch(error){ throw new Error(`BLENDER_JOB_IMAGES_UNAVAILABLE: 作业 ${snapshot.id} 的输出不是可解析的结果 JSON（${String(error instanceof Error?error.message:String(error))}）：${json.slice(0,300)}`) }
    const {refs,report}=await attachResultImages(attachmentStore(ctx),resultImagePaths(value),limit,'tool-result')
    // 这次作业有没有请求渲染，从**它自己的结果**读（world.py 渲染时才给 renderMode/preview）：
    // 渲染过的作业却一张图都取不回来要明确报失败；没渲染的作业 requested=0 是正常，不报错。
    const record=typeof value==='object'&&value!==null?value as {renderMode?:unknown;preview?:unknown}:{}
    noteImageDelivery(report,{lane:'tool-result',renderRequested:record.renderMode!==undefined||record.preview!==undefined})
    // result 字段 = 该作业自己的结果 JSON 文本（与 job_output 同源），图片路径仍在里面。
    const text=JSON.stringify({jobId:snapshot.id,status:snapshot.status,result:json,images:report})
    if(refs.length>0)attachmentsByResult.set(text,refs)
    return {result:text}
  }}))

  /**
   * 作业控制（A4）：`pause` / `resume` / `status`。
   *
   * **如实边界（文案与判据同一份事实）**：
   *  · `pause` = 在这个作业自己的输出目录写暂停请求标记（`.lyapunov-job-state.json`）＋用既有的
   *    `terminate()` 停掉当前 Blender 进程，**不落定作业**。原生 `JobStatus` 闭集里没有 `paused`
   *    （vendored `jobs/src/types.ts:17`），所以暂停期间原生 `job_list` / `job_output` **照实显示 `running`**；
   *    真实状态只能看本工具的 `state`。
   *  · `resume` = **同一作业重跑（同 jobId）**：不新铸 id、不新起作业记录；已完成阶段会**重算**
   *    （world.py 内部没有阶段检查点，那是 P1），**不是断点续算**。
   *  · 暂停**不跨宿主重启**：作业记录活在宿主进程内存（`jobs-local:102`），重启/会话销毁后记录已被
   *    owner 释放取消，此后 `resume` ⇒ `BLENDER_JOB_RESUME_ALREADY_FINISHED`。
   *  · 未知 jobId / 他人会话的 jobId **不包装**：直接用原生 `unknown job <id>` /
   *    `job <id> belongs to another session`（判权在 `ctx.jobs.read`，本工具不另造栅栏）。
   *  · `job_kill` 对暂停中的作业**必须能落定**：取消路径会同时把暂停等待的循环放出来。
   */
  ctx.tools.register(defineTool({name:'blender_job_control',description:`Control Blender jobs started by blender_run background:true in this session. action:"pause" requests a pause and stops the current Blender process without settling the job; jobId remains unchanged and state is written to .lyapunov-job-state.json in the output directory. action:"resume" continues with **the same jobId** by rerunning the same job and recomputing completed phases, **not resuming a computation checkpoint**; it prefers this job's saved output/source.blend as input to preserve resource identities. action:"status" reads actual product-side state. completedPhases records phases actually completed at plugin level; "blender" appears only after full completion, is not a progress percentage, and does not depend on UI language. During a pause, native job_list/job_output **still show running** because upstream JobStatus has no paused value; inspect this tool's state. Pauses do not survive Host restart/session disposal: released records cause resume to return BLENDER_JOB_RESUME_ALREADY_FINISHED.`,parameters:{job_id:{type:'string',required:true,description:'jobId returned by blender_run background:true, for example blender-1.'},action:{type:'string',enum:['pause','resume','status'],required:true,description:'pause requests a pause; resume reruns the same jobId to completion and recomputes completed phases; status reads state without changing anything.'}},output:{schema:{type:'object',additionalProperties:false,properties:{result:{type:'string',required:true}}},render:(_args,value)=>[{type:'text',text:value.result} as ContentBlock]},async execute(args,exec){
    // 未知 / 他人会话都交给原生：这里不 try/catch、不换文案，原生抛什么就是什么。
    const read=ctx.jobs.read(args.job_id as JobId,exec.agent)
    const {snapshot}=read
    if(snapshot.kind!=='blender')throw new Error(`BLENDER_JOB_CONTROL_NOT_BLENDER: 作业 ${snapshot.id} 的 kind=${snapshot.kind}，不是 Blender 生产者（本插件只认 kind=blender 的作业）。暂停/恢复只对 blender_run background:true 起的作业有意义；别的 kind 读输出用原生 job_output。`)
    // 终态判定在控制表**之前**：一旦落定（completed/killed/failed），本插件绝不为此新铸第二个作业，
    // resume 只能明确失败。（`stopping` 不是终态：取消还在飞，控制表仍在。）
    const terminal=snapshot.status!=='running'&&snapshot.status!=='stopping'
    const control=jobControls.get(snapshot.id)
    const stateOf=():BlenderControlState=>control===undefined?'running':controlState(control)
    /** 一次控制动作的公共读数：jobId 逐字回、状态、检查点事实。 */
    const reading=(extra:Record<string,unknown>):string=>JSON.stringify({
      jobId:snapshot.id,action:args.action,state:terminal?'finished':stateOf(),nativeStatus:snapshot.status,
      ...control?{argvDigest:control.argvDigest,resumeCount:control.resumeCount,completedPhases:control.completedPhases,...control.pausedAt?{pausedAt:control.pausedAt}:{}}:{},
      ...extra,
    })
    if(terminal){
      if(args.action==='status')return {result:reading({note:`作业已终态（${snapshot.status}）：本插件不再保留暂停/恢复能力。completedPhases＝本作业**在插件层真正完成的阶段**（跑完时含 "blender"＝world.py 的建模/导出/可选渲染都在那一次进程里完成；输入准备阶段取过图才记 "textures"）；失败/取消的作业只反映落定前完成的阶段，不是失败原因清单。磁盘上的 .lyapunov-job-state.json 只在 pause/resume 边界写，不随终态刷新。`})}
      const code=args.action==='pause'?'BLENDER_JOB_PAUSE_ALREADY_FINISHED':'BLENDER_JOB_RESUME_ALREADY_FINISHED'
      throw new Error(`${code}: 作业 ${snapshot.id} 已经是 ${snapshot.status}，不能${args.action==='pause'?'暂停':'恢复'}。恢复**不会**新铸 jobId——要重跑请用 blender_run 起一个新作业（那会是一个新 jobId）；宿主重启/会话销毁后的作业记录已被释放，同样落到这一条。`)
    }
    if(control===undefined){
      // 防御分支：同一进程里能看到、但不是本插件实例启动的 blender 作业（本插件每次 apply 只建一张控制表）。
      // 没有控制句柄就没有通向生产者的通道，不假装能控制、也不冒充别的错误码。
      if(args.action==='status')return {result:reading({note:'这条作业不是本插件实例启动的（没有控制句柄）：读得到原生状态，但暂停/恢复不可用。'})}
      throw new Error(`作业 ${snapshot.id} 不是本插件实例启动的（没有控制句柄）⇒ 无法${args.action==='pause'?'请求暂停':'恢复'}。原生状态：${snapshot.status}。`)
    }
    if(args.action==='status')return {result:reading({note:'state 是产品侧真实状态；原生 job_list/job_output 在暂停期间仍显示 running（上游 JobStatus 闭集里没有 paused）。completedPhases 是**到目前为止**在插件层完成的阶段（完整跑完后才含 "blender"），不是进度百分比。'})}
    if(args.action==='pause'){
      // 幂等：已请求/已暂停都如实回同一个事实，不重复写状态文件、不重复停进程、不动 jobId。
      if(control.requested||control.waiting)return {result:reading({alreadyRequested:true,...control.waiting?{alreadyPaused:true}:{},note:control.waiting?'作业已暂停（幂等：没有第二次暂停、没有新作业记录）':'暂停请求已在处理中（幂等：没有第二次请求）'})}
      // 状态文件的 'paused' 由**生产者**在真的停到边界时写；这里先落 'pause-requested'——
      // 这就是"暂停请求标记"，也是磁盘上可被外部核对的暂停事实（不只有内存里的一份）。
      const stopped=deferred()
      control.stopped=stopped
      control.requested=true
      await writeJobState(control,'pause-requested')
      control.stopChild?.()
      const reached=await withTimeout(stopped.promise,PAUSE_WAIT_TIMEOUT_MS)
      return {result:reading(reached?{note:'已暂停：作业**没有落定**（原生 status 仍是 running），jobId 不变；要接着跑用 action:"resume"。'}
        :{state:'pause-requested',note:`暂停请求已受理，但当前阶段还没停下（等待超过 ${PAUSE_WAIT_TIMEOUT_MS} ms，例如取图/渲染还在进行中）。作业**没有落定**，jobId 不变；可以稍后再用 action:"status" 看 state，或直接 action:"resume" 取消这次暂停意图。`})}
    }
    // resume
    if(!control.waiting)throw new Error(`BLENDER_JOB_RESUME_NOT_PAUSED: 作业 ${snapshot.id} 当前不在暂停中（state=${stateOf()}）${control.requested?'：暂停请求已受理但本阶段还没停下，现在恢复不了':'——它一直在跑，从未暂停过'}。要停它用 job_kill，要看状态用 action:"status"。`)
    // 检查点比对（resume 前的机器判据）：状态文件必须存在，且 jobId 与 argvDigest 与本次作业的输入一致。
    // 不一致就是"输入源与检查点不符"——绝不静默恢复，也绝不新起一条作业来掩盖。
    const checkpoint=await readJobState(control.output)
    if(checkpoint===undefined)throw new Error(`BLENDER_JOB_RESUME_INPUT_MISMATCH: 作业 ${snapshot.id} 的检查点文件不存在（${jobStatePath(control.output)}）⇒ 无法确认这次恢复用的还是同一份输入，拒绝恢复。`)
    if(checkpoint.jobId!==snapshot.id||checkpoint.argvDigest!==control.argvDigest)throw new Error(`BLENDER_JOB_RESUME_INPUT_MISMATCH: 检查点与本次作业对不上（检查点 jobId=${String(checkpoint.jobId)} argvDigest=${String(checkpoint.argvDigest)}；本次 jobId=${snapshot.id} argvDigest=${control.argvDigest}）⇒ 输出目录里的暂停状态不是这条作业/这套输入写的，拒绝恢复。`)
    const useSource=existsSync(join(control.output,'source.blend'))
    control.wakeResume?.()
    // `state:'running'` 是**显式覆盖**：唤醒生产者是微任务，这一刻 `control.waiting` 还是 true；
    // resume 已被受理，产品侧状态就是 running（生产者紧接着会把 waiting/requested 落掉、resumeCount+1、
    // 并写状态文件）。不在这里改生产者那份记账，避免两个写者。
    return {result:reading({state:'running',resumedWith:useSource?join(control.output,'source.blend'):'原 argv（本作业还没有 source.blend）',resumeCount:control.resumeCount+1,note:'已恢复：**同一 jobId** 的同一作业重新开跑（已完成阶段会重算，不是断点续算）；进度请用原生 job_output{wait:true} 或 blender_job_control{action:"status"} 观察。'})}
  }}))

  // DXF 输入：`cad_inspect` 由 cad.ts 自己的注册函数挂上（同一份共用 operation，不在这里重写解析逻辑）。
  // 相对路径同样按**会话任务工作区**解析（cad.ts 的 cadTaskCwd 与上面的 absolute() 是同一规则）；
  // 解释器显式配置优先，未配置时 cad.ts 回落到 LYAPUNOV_CAD_PYTHON 并明确报未配置。
  registerCadTools(ctx,{python:config.cadPython,workspace:config.workspace})
  // 照片相机拟合：`camera_fit` 同样只注册一个工具，求解走隔离 Python（camera-fit.ts 的共用 operation）。
  // 解释器显式配置优先，未配置时回落 LYAPUNOV_CAMERA_FIT_PYTHON 并明确报未配置（不猜默认解释器）。
  registerCameraFitTools(ctx,{python:config.cameraFitPython,workspace:config.workspace})
  // 图纸读取：`drawing_inspect` 按文件头分流（DXF/DWG/PDF），`cad_convert` 只做 DWG→DXF；
  // 两者与 `cad_inspect` 共用同一个解释器（drawing-input.ts 的 python 字段与 cad.ts 同义）。
  // 转换器显式配置优先，未配置时 drawing-input.ts 回落 LYAPUNOV_DWG_CONVERTER 并沿 PATH 探测，
  // 一个都没有就明确报未配置——不在这里替它猜一个转换器。
  registerDrawingTools(ctx,{python:config.cadPython,workspace:config.workspace,
    ...(config.dwgConverter?{dwgConverter:{path:config.dwgConverter}}:{})})
}
