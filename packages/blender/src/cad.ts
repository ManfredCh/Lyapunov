/**
 * DXF 输入：用**可配置的隔离 Python**（装了 ezdxf）真实读取图纸，返回单位、图层、
 * 块定义与引用（含变换）、曲线真实几何参数、尺寸标注，以及未知/不支持实体的事实。
 *
 * 边界（本切片**不做**的事）：
 *  · 不是 CAD 内核：不做布尔运算、不做实体建模、不写回 DXF，也不从图片生成 CAD 数据；
 *    曲线只给参数（端点/顶点与 bulge/圆心半径/角度），不做离散、求交、偏移；
 *  · DWG 不是 DXF：签名是 DWG 时明确要求外部转换器，不"顺手当成坏 DXF"解析；
 *    ASCII 与 Binary DXF 都真实支持（ezdxf 两种都能读，二进制夹具是真转出来并逐项对照过的）；
 *  · 单位不猜：文件没声明就报未知（`units.known=false`、`metresPerUnit=null`），
 *    只有调用方**显式**给单位时才换算，并在结果里标注 `units.source="caller"`；
 *  · 未知实体不丢也不假装：计入 `unsupported` 并声明它们没有参与 bounds（bounds 真的按建模子集过滤过）。
 *
 * 分层：`inspectDxf` 是共用 operation（可被 Command／其它工作流直接调用），
 * `registerCadTools` 只是把同一 operation 注册成模型工具——行为只有一份。
 * 输出分两面，两面都是**有界的**：`report` 是不经摘要二次压缩的结构化值（供建模/工作流读取），
 * `result` 默认只给有界摘要（每类明细 12 条、每条曲线 32 个点）。`report` 本身仍受解析器的
 * `max_items` 与单条曲线点数上限（128）约束——**真正不受任何截断的只有计数**
 * （`counts` / 各 `*Count`，以及 `truncated.lists` 里明示被截断的列表）；要未经摘要压缩的全文
 * 得显式 `detail="full"`，但不默认把整张图灌进模型。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { fileURLToPath } from 'node:url'
import { open } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

/** cad_inspect.py 成功时的结果前缀；解析方不得硬编码字面量。 */
export const CAD_RESULT_PREFIX='LYAPUNOV_CAD_RESULT='
/** cad_inspect.py 可预期失败时的错误前缀（退出码 3）。 */
export const CAD_ERROR_PREFIX='LYAPUNOV_CAD_ERROR='
/** 解析器子进程路径：随包走，不依赖安装位置。 */
export const CAD_SCRIPT_URL=new URL('../python/cad_inspect.py',import.meta.url)
/** 调用方可以显式指定的单位（与 cad_inspect.py 的 CALLER_UNITS 保持一致）。 */
export const CAD_UNITS=['m','mm','cm','dm','km','in','ft','yd','mi','um','nm','mil'] as const
export type CadUnit=(typeof CAD_UNITS)[number]
/** result 的呈现粒度：summary（默认，有界摘要）| full（报告 JSON 原文，未经摘要压缩但仍受 max_items/点数上限约束）。 */
export const CAD_DETAILS=['summary','full'] as const
export type CadDetail=(typeof CAD_DETAILS)[number]
/** 摘要里每类明细最多列几条（计数不受此限，完整明细在 report 里）。 */
export const CAD_SUMMARY_ITEMS=12
/** 摘要里每条曲线最多列出多少个点（完整点列在 report.geometry.curves 里）。 */
export const CAD_SUMMARY_POINTS=32

/** 结构化失败。code 是稳定机器码，message 是给人看的原因与下一步。 */
export class CadError extends Error{
  readonly code:string
  readonly detail:Record<string,unknown>
  constructor(code:string,message:string,detail:Record<string,unknown>={}){
    super(`${code}: ${message}`)
    this.name='CadError'
    this.code=code
    this.detail=detail
  }
}

export interface CadConfig{
  /** 运行 cad_inspect.py 的解释器。必须已装 ezdxf；未配置时回落 LYAPUNOV_CAD_PYTHON。 */
  python?:string
  /** 相对路径的兜底基准目录；**优先用会话任务工作区的 cwd**，这里只是它缺席时的退路。 */
  workspace?:string
  /** cad_inspect.py 的路径覆盖；默认用包内 python/cad_inspect.py。 */
  script?:string
  /** 子进程墙钟上限（毫秒），超时即终止并报 CAD_INSPECT_TIMEOUT。 */
  timeoutMs?:number
}

/** 工具执行上下文里取会话工作目录所需的最小形状（原生会话 header.cwd）。 */
export interface CadScope{
  agent?:{session?:{header?:{cwd?:string}}|undefined}|undefined
}

export interface CadUnits{
  /** 文件里 $INSUNITS 的**原值**；文件没有这个头变量时为 null。 */
  insunits:number|null
  /** 原值是否真的来自文件（false = 文件没声明，不是"默认成某个单位"）。 */
  presentInFile:boolean
  name:string|null
  metresPerUnit:number|null
  known:boolean
  source:'header'|'caller'|'unknown'
  callerSupplied:{requested:string;name:string;metresPerUnit:number}|null
  conflict:boolean
  note:string
}

export interface CadBounds{
  mode:'exact'|'fast'
  drawingUnits:{min:number[];max:number[]}|null
  sizeDrawingUnits:number[]|null
  /** 只有单位已知（或调用方显式给）时才有米制边界；否则 null，不给假数。 */
  metres:{min:number[];max:number[]}|null
  sizeMetres:number[]|null
  headerDeclared:{min:number[];max:number[]}|null
  /** 实际参与边界计算的实体类型（= 建模子集），与 unsupported 的声明一致。 */
  entityTypes:string[]
  entitiesConsidered:number
  excludedEntityCount:number
  excludedEntityTypes:Record<string,number>
  note:string
}

export interface CadBlockReference{
  block:string
  /** 引用**所在**的空间：模型空间或某个块定义内部（块内引用即嵌套引用）。 */
  space:'modelspace'|'block'
  /** 宿主块名；模型空间的引用为 null。沿它把块内几何逐级变换回世界坐标。 */
  parentBlock:string|null
  layer:string
  handle:string|null
  insert:number[]|null
  rotationDeg:number|null
  scale:number[]
  /** 三轴**两两**相等才为 true（x=y≠z 的 z 轴拉伸不算等比）。 */
  uniformScale:boolean
  columns:number
  rows:number
  columnSpacing:number|null
  rowSpacing:number|null
  attributes:string[]
  /** 4x4 行主序变换矩阵，平移在最后一行（ezdxf Matrix44 约定）；按 v' = v·M 右乘（v=(x,y,z,1)）。 */
  transform:number[][]|null
}

export interface CadBlockDefinition{
  name:string
  kind:'user'|'anonymous'|'xref'
  basePoint:number[]|null
  entityCount:number
  entityTypes:Record<string,number>
  /** 全部引用（模型空间 + 嵌套引用）——先数完再投影，与定义顺序无关。 */
  referenceCount:number
  nestedReferenceCount:number
}

/** 曲线的最小真实几何：只给参数，不做离散。coordinates 说明坐标空间，units 说明长度单位。 */
export interface CadCurve{
  space:'modelspace'|'block'
  block:string|null
  type:string
  layer:string
  handle:string|null
  coordinates:'wcs'|'ocs'
  units:'drawing-unit'
  closed:boolean|null
  extrusion?:number[]
  start?:number[]|null
  end?:number[]|null
  center?:number[]|null
  radius?:number|null
  startAngle?:number|null
  endAngle?:number|null
  majorAxis?:number[]|null
  majorAxisLength?:number|null
  ratio?:number|null
  startParam?:number|null
  endParam?:number|null
  paramsInRadians?:boolean
  degree?:number
  vertexCount?:number
  verticesListed?:number
  vertices?:Array<{x:number;y:number;z?:number;bulge?:number;startWidth?:number;endWidth?:number}>
  elevation?:number|null
  controlPointCount?:number
  controlPoints?:number[][]
  fitPointCount?:number
  fitPoints?:number[][]
  /** SPLINE：节点向量/权重的**全量计数**与数值列（列超过单条曲线上限时截断并在 warnings 里声明）。 */
  knotCount?:number
  knots?:number[]
  /** 为 0 表示文件里确实没有权重（非有理样条，权重均为 1），不是没读。 */
  weightCount?:number
  weights?:number[]
  polylineType?:string
  [key:string]:unknown
}

export interface CadDimension{
  layer:string
  handle:string|null
  dimtype:number
  dimTypeName:string
  /** DXF 组码 70 的位：32=块引用(R13+ 恒置位)、64=ordinate 的 X/Y 型、128=文字在用户位置。 */
  flags:{blockReference:boolean;ordinateAxis:'x'|'y'|null;textUserPositioned:boolean}
  measurement:number|null
  /** ordinate（类型 6）的"测量值"是一个点（特征位置），与长度分开报。 */
  measurementPoint:number[]|null
  measurementUnit:'drawing-unit'|'degree'|null
  text:string|null
  textOverride:string|null
  defPoint:number[]|null
  textMidpoint:number[]|null
  dimstyle:string|null
}

export interface CadUnsupportedEntity{
  type:string
  kind:'recognized-not-modeled'|'unknown'
  reason:string
  count:number
  layers:string[]
  spaces:string[]
}

export interface CadReport{
  ok:true
  scriptVersion:string
  source:{engine:string;engineVersion:string;interpreter:string;interpreterVersion:string}
  file:{path:string;name:string;bytes:number;sha256:string}
  format:{kind:'dxf';aciVersion:string;release:string;encoding:string;binary:boolean}
  units:CadUnits
  bounds:CadBounds
  layers:Array<{name:string;color:number|null;trueColor:number[]|null;linetype:string|null;lineweight:number|null;off:boolean;frozen:boolean;locked:boolean;visible:boolean;entityCount:number}>
  blocks:{
    definitions:CadBlockDefinition[]
    layoutBlocks:string[]
    references:CadBlockReference[]
    definitionCount:number
    definitionsListed:number
    referenceCount:number
    modelspaceReferenceCount:number
    nestedReferenceCount:number
    anonymousDefinitionCount:number
    transformOrder:string
    note:string
  }
  geometry:{
    entityCounts:Record<string,number>
    layers:Array<{layer:string;entityCount:number}>
    curves:CadCurve[]
    /** 模型空间的曲线条数（全量，不受 max_items 截断）。 */
    curveCount:number
    curvesBySpace:Record<string,number>
    openCurveCount:number
    note:string
  }
  dimensions:CadDimension[]
  unsupported:CadUnsupportedEntity[]
  unsupportedEntityCount:number
  /** 全量计数（layers/dimensions/curves/blockReferences…）：**不受** max_items 与点数上限影响。 */
  counts:Record<string,number>
  warnings:string[]
  /** 哪些列表被 --max-items 截断（`lists`）、单条曲线的点数上限（`maxPointsPerCurve`）。 */
  truncated:{maxItems:number;maxPointsPerCurve:number;lists:Record<string,boolean>}
}

/** 解析器失败时 Python 侧给出的结构（退出码 3）。 */
interface CadErrorEnvelope{ok:false;scriptVersion?:string;error:{code:string;message:string}&Record<string,unknown>}

export interface CadInspectRequest{
  /** DXF 文件（相对路径必须配 cwd/会话工作区；不给基准就报 CAD_CWD_UNRESOLVED）。 */
  file:string
  /** 调用方显式给的单位：文件未声明时使用，或覆盖文件声明（会标注 source="caller"）。 */
  unit?:string
  /** 每个明细列表的上限；计数不受限。 */
  maxItems?:number
  /** 用精确 bbox（慢）。 */
  exactBounds?:boolean
}

export interface CadInspectOptions extends CadInspectRequest{
  subprocess:SubprocessRuntime
  /** 解释器绝对路径（必须已装 ezdxf）。 */
  python:string
  /** cad_inspect.py 路径。 */
  script:string
  /** file/script 相对路径的基准目录；相对路径没有它直接报错，不落进程 cwd。 */
  cwd?:string
  timeoutMs?:number
  signal?:AbortSignal
}

const DEFAULT_TIMEOUT_MS=120_000

/**
 * 解释器解析：显式配置 > 环境变量（供装配层注入）> 未配置。
 * **没有**静默默认解释器：装 ezdxf 的解释器是环境事实，不能由代码猜一个（猜错就变成"看起来能读、
 * 实际没装依赖"）。未配置时工具报 CAD_PYTHON_UNCONFIGURED 并给出补依赖的确切命令。
 */
export function resolveCadPython(config:CadConfig={},env:NodeJS.ProcessEnv=process.env):string|undefined{
  const configured=config.python?.trim()
  if(configured)return configured
  const fromEnv=env.LYAPUNOV_CAD_PYTHON?.trim()
  return fromEnv?fromEnv:undefined
}

/**
 * 任务工作区解析：**会话任务 cwd 优先**（原生会话 header cwd，与终端/工作台同一事实），
 * 插件 config.workspace 只作兜底；两者都没有就返回 undefined，让调用方明确报错。
 * 不悄悄拿进程 cwd 当基准——那会把相对路径落到产品根（Blender 侧修过的同一个坑）。
 */
export function cadTaskCwd(exec:CadScope|undefined,config:CadConfig={}):string|undefined{
  const fromSession=exec?.agent?.session?.header?.cwd?.trim()
  if(fromSession)return fromSession
  const configured=config.workspace?.trim()
  return configured?resolve(configured):undefined
}

/** 相对路径 → 绝对路径；没有会话 cwd/config.workspace 时报 CAD_CWD_UNRESOLVED。 */
export function resolveCadPath(exec:CadScope|undefined,config:CadConfig,value:string,label='file',cwd?:string):string{
  if(isAbsolute(value))return value
  const base=cwd??cadTaskCwd(exec,config)
  if(!base)
    throw new CadError('CAD_CWD_UNRESOLVED',
      `${label} 是相对路径（${value}），但当前执行上下文没有会话工作目录、本插件也未配置 workspace；请传绝对路径`,
      {value,label})
  return resolve(base,value)
}

/**
 * DWG 版本签名表（逐条取自 LibreDWG 0.14 的 `dwg_versions` 表 `src/common.c`）。
 * R1.x/R2.0 的上古签名只有 5 字节（`MC0.0`/`AC1.2`/`AC1.3`/`AC1.40`/`AC1.50`），按前缀匹配。
 */
export const DWG_SIGNATURES:Record<string,string>={
  'MC0.0':'MicroCAD Release 1.1', 'AC1.2':'AutoCAD Release 1.2', 'AC1.3':'AutoCAD Release 1.3',
  'AC1.40':'AutoCAD Release 1.4', 'AC1.50':'AutoCAD Release 2.0',
  'AC2.10':'AutoCAD Release 2.10','AC2.21':'AutoCAD Release 2.21','AC2.22':'AutoCAD Release 2.22',
  AC1001:'AutoCAD Release 2.4',AC1002:'AutoCAD Release 2.5',AC1003:'AutoCAD Release 2.6',
  AC1004:'AutoCAD Release 9',AC1005:'AutoCAD Release 9c1',AC1006:'AutoCAD Release 10',
  AC1007:'AutoCAD 11 beta 1',AC1008:'AutoCAD 11 beta 2',AC1009:'AutoCAD Release 11/12',
  AC1010:'AutoCAD pre-R13 a',AC1011:'AutoCAD pre-R13 b',AC1012:'AutoCAD Release 13',
  AC1013:'AutoCAD Release 13c3',AC1014:'AutoCAD Release 14',AC1500:'AutoCAD 2000 beta',
  AC1015:'AutoCAD Release 2000',AC1016:'AutoCAD Release 2000i',AC1017:'AutoCAD Release 2002',
  AC1018:'AutoCAD Release 2004',AC1021:'AutoCAD Release 2007',AC1024:'AutoCAD Release 2010',
  AC1027:'AutoCAD Release 2013',AC1032:'AutoCAD Release 2018',
}

/**
 * DWG 文件头判定（唯一的实现）：版本签名 + **紧接签名的 5 字节全为 0**（6 字节签名看 [6,11)，
 * 5 字节的上古签名看 [5,10)）。
 * 只认签名不够——DXF 的 `$ACADVER` 也是同样的版本串（`AC1015`…），会把它误判成 DWG；
 * 本机 146 个真实 DWG（LibreDWG 0.14 发布包的 `test/test-data` + 本仓两组夹具）全部满足这条规则，
 * 78 个 DXF 一个都不满足（复核脚本 `check-dwg-signature.mjs`，数字见 `docs/DRAWING_INPUT.md` §7）。
 * @returns 命中的版本串（如 `AC1015`），不是 DWG 时返回 null。
 */
export function dwgSignature(head:Uint8Array):string|null{
  if(head.length<11)return null
  const latin=Buffer.from(head.subarray(0,8)).toString('latin1')
  for(const signature of Object.keys(DWG_SIGNATURES)){
    if(!latin.startsWith(signature))continue
    let zeros=true
    for(let index=signature.length;index<signature.length+5;index+=1)
      if(head[index]!==0){ zeros=false; break }
    if(zeros)return signature
  }
  return null
}

/**
 * PDF 文件头判定：在手头这段字节里找 `%PDF-x.y`（有些 PDF 前面会带一点垃圾/BOM，PDF 规范允许
 * 文件头出现在前 1024 字节内）。给的字节越多，判定越宽松——调用方按自己读的窗口决定。
 */
export function pdfHeader(ascii:string):string|null{
  const at=ascii.indexOf('%PDF-')
  if(at<0)return null
  const header=ascii.slice(at,at+8)
  return /^%PDF-\d\.\d/.test(header)?header:null
}

/**
 * 文件级前置检查（不启进程）：缺文件/DWG/PDF/空文件立刻给出稳定错误码。
 * 与 cad_inspect.py 的同类检查是同一条规则的**两处落点**：这里让模型不必为"这文件根本不是 DXF"
 * 付一次进程启动，Python 侧则保证直接调用脚本时也拒绝得一样。两条都有测试。
 * ⚠ Python 侧的 DWG 判定目前更窄（只认 `AC1\d{3}`，也没有 PDF 分支）——TS 工具路径已统一走
 * {@link dwgSignature}/{@link pdfHeader}，直呼脚本的路径待同步（见任务 NEEDS_ROOT.md）。
 * ASCII 与 Binary DXF 都放行（二进制事实由 format.binary 报出）。
 */
export async function preflightCadFile(file:string):Promise<{path:string;bytes:number;head:Uint8Array;binary:boolean}>{
  let handle
  try{ handle=await open(file,'r') }
  catch(error){
    const code=(error as NodeJS.ErrnoException).code
    if(code==='ENOENT')throw new CadError('CAD_FILE_MISSING',`文件不存在：${file}`,{path:file})
    throw new CadError('CAD_FILE_UNREADABLE',`文件不可读：${String(error)}`,{path:file})
  }
  try{
    const stat=await handle.stat()
    if(!stat.isFile())throw new CadError('CAD_FILE_NOT_A_FILE',`不是普通文件：${file}`,{path:file})
    if(stat.size===0)throw new CadError('CAD_FILE_EMPTY',`文件是空的：${file}`,{path:file})
    const buffer=new Uint8Array(64)
    const {bytesRead}=await handle.read(buffer,0,buffer.length,0)
    const head=buffer.subarray(0,bytesRead)
    const ascii=Buffer.from(head).toString('latin1')
    const binary=ascii.startsWith('AutoCAD Binary DXF')
    const dwg=dwgSignature(head)
    if(!binary&&dwg)throw new CadError('DWG_REQUIRES_CONVERTER',`文件头是 DWG 签名（${dwg}），DWG 需要外部转换器（ODA File Converter／LibreDWG dwg2dxf）先转成 DXF；本工具不把 DWG 当 DXF 解析`,{path:file,detected:'dwg',signature:dwg})
    const pdf=pdfHeader(ascii)
    if(pdf)throw new CadError('PDF_REQUIRES_DRAWING_INSPECT',`这是 PDF（${pdf}），不是 DXF：本工具只读 DXF。PDF 图纸请用 drawing_inspect——矢量页给出真实路径/文字/页面单位，扫描页把原生图像作为图像送进上下文`,{path:file,detected:'pdf',header:pdf})
    return {path:file,bytes:stat.size,head,binary}
  }finally{ await handle.close() }
}

/**
 * 共用 operation：调用隔离 Python 真实读取 DXF，返回结构化报告。
 * 成功即返回报告；任何可预期失败抛 {@link CadError}（含稳定 code），不返回半份结果。
 */
export async function inspectDxf(options:CadInspectOptions):Promise<CadReport>{
  if(!isAbsolute(options.file)&&!options.cwd)
    throw new CadError('CAD_CWD_UNRESOLVED',`file 是相对路径（${options.file}）但没有给 cwd；相对路径必须有明确基准，不落进程 cwd`,{value:options.file,label:'file'})
  if(!isAbsolute(options.script)&&!options.cwd)
    throw new CadError('CAD_CWD_UNRESOLVED',`script 是相对路径（${options.script}）但没有给 cwd`,{value:options.script,label:'script'})
  const cwd=options.cwd?resolve(options.cwd):undefined
  const script=cwd?resolve(cwd,options.script):options.script
  const file=cwd?resolve(cwd,options.file):options.file
  await preflightCadFile(file)
  const argv=[options.python,script,'--input',file]
  if(options.unit)argv.push('--unit',options.unit)
  if(options.maxItems!==undefined)argv.push('--max-items',String(options.maxItems))
  if(options.exactBounds)argv.push('--exact-bounds')
  const timeoutMs=options.timeoutMs??DEFAULT_TIMEOUT_MS
  const timeoutSignal=AbortSignal.timeout(timeoutMs)
  const signal=options.signal?AbortSignal.any([options.signal,timeoutSignal]):timeoutSignal
  let child
  try{
    child=options.subprocess.spawn({
      // 子进程工作目录：明确基准优先；绝对路径时用文件所在目录，不落产品根。
      argv,cwd:cwd??dirname(file),
      stdio:{stdin:'ignore',stdout:{maxBytes:8_000_000},stderr:{maxBytes:64_000}},
      signal,graceMs:3000,
      // HF 镜像约束随子进程显式传递（本工具无 Hub 需求，只是不引入官方端点）；
      // PYTHONDONTWRITEBYTECODE：别在源码目录里落 __pycache__。
      env:{HF_ENDPOINT:'https://hf-mirror.com',PYTHONDONTWRITEBYTECODE:'1'},
    })
  }catch(error){
    throw new CadError('CAD_PYTHON_UNAVAILABLE',`无法启动 CAD 解释器 ${options.python}：${String(error)}`,{interpreter:options.python})
  }
  const outcome=await child.done
  const stdout=child.collected.stdout?.readFrom(0).text??''
  const stderr=child.collected.stderr?.readFrom(0).text??''
  if(options.signal?.aborted)throw new CadError('CAD_INSPECT_CANCELLED','调用方已取消 CAD 读取',{path:file})
  if(timeoutSignal.aborted)throw new CadError('CAD_INSPECT_TIMEOUT',`读取 DXF 超过 ${timeoutMs} ms 被终止：${file}`,{path:file,timeoutMs})
  const lines=stdout.split('\n')
  const errorLine=lines.slice().reverse().find(line=>line.startsWith(CAD_ERROR_PREFIX))
  const resultLine=lines.slice().reverse().find(line=>line.startsWith(CAD_RESULT_PREFIX))
  if(outcome.exitCode!==0){
    if(errorLine)throw cadErrorFromEnvelope(errorLine.slice(CAD_ERROR_PREFIX.length),file)
    throw new CadError('CAD_INSPECT_FAILED',`解释器退出码 ${outcome.exitCode}（signal=${outcome.signal??'none'}）：${(stderr||stdout).slice(-800)}`,{path:file,exitCode:outcome.exitCode,signal:outcome.signal,interpreter:options.python})
  }
  // 退出码 0 但没有结果行 = 调用约定被破坏，不能拿"退出成功"当读完图纸。
  if(!resultLine)throw new CadError('CAD_OUTPUT_MISSING',`解释器成功退出但没有结果行：${(stdout||stderr).slice(-800)}`,{path:file,interpreter:options.python})
  let parsed:unknown
  try{ parsed=JSON.parse(resultLine.slice(CAD_RESULT_PREFIX.length)) }
  catch(error){ throw new CadError('CAD_OUTPUT_UNREADABLE',`结果行不是合法 JSON：${String(error)}`,{path:file}) }
  return assertCadReport(parsed,file)
}

function cadErrorFromEnvelope(payload:string,file:string):CadError{
  try{
    const envelope=JSON.parse(payload) as CadErrorEnvelope
    const error=envelope?.error
    if(error&&typeof error.code==='string')return new CadError(error.code,String(error.message??''),{path:file,...error})
  }catch{/* 载荷不可读时退到通用失败，不编造 code */}
  return new CadError('CAD_INSPECT_FAILED',`解析器报错但错误载荷不可读：${payload.slice(0,300)}`,{path:file})
}

/** 结果契约校验：只认结构成立的报告，缺字段/类型不符一律当失败，不把半份报告交下游建模。 */
export function assertCadReport(value:unknown,file:string):CadReport{
  const report=value as Partial<CadReport>|null
  const units=report?.units
  if(!report||typeof report!=='object'||report.ok!==true||typeof units!=='object'||units===null
    ||typeof units.known!=='boolean'||!(units.metresPerUnit===null||typeof units.metresPerUnit==='number')
    ||typeof units.presentInFile!=='boolean')
    throw new CadError('CAD_OUTPUT_INVALID','解析器返回的报告结构不符合约定（缺 units.known/metresPerUnit/presentInFile 或 ok≠true）',{path:file})
  const bounds=report.bounds
  if(typeof bounds!=='object'||bounds===null||!('drawingUnits'in bounds))
    throw new CadError('CAD_OUTPUT_INVALID','解析器返回的报告缺少 bounds',{path:file})
  for(const key of ['layers','dimensions','unsupported'] as const)
    if(!Array.isArray(report[key]))
      throw new CadError('CAD_OUTPUT_INVALID',`解析器返回的报告缺少数组字段 ${key}`,{path:file})
  // 摘要里的总数取自 counts（全量、不受 max_items 截断）：缺少它就只能拿截断后的明细长度冒充总数，
  // 那是**错的数**而不是缺字段——所以这里直接判失败，不给"看起来有总数"的机会。
  for(const key of ['layers','dimensions'] as const)
    if(typeof report.counts?.[key]!=='number')
      throw new CadError('CAD_OUTPUT_INVALID',`解析器返回的报告缺少全量计数 counts.${key}（摘要的 *Total 取自这里）`,{path:file})
  if(!Array.isArray(report.geometry?.curves))
    throw new CadError('CAD_OUTPUT_INVALID','解析器返回的报告缺少 geometry.curves',{path:file})
  return report as CadReport
}

/** 摘要里的曲线：参数照给，点列按 CAD_SUMMARY_POINTS 截断（完整点列在 report 里）。 */
function summaryCurve(curve:CadCurve,index:number):Record<string,unknown>{
  const capped:Record<string,unknown>={index,...curve}
  // 顶点/控制点/拟合点以及 SPLINE 的 knots、weights 都是"点列"：摘要侧一视同仁地截断并标记。
  for(const key of ['vertices','controlPoints','fitPoints','knots','weights'] as const){
    const points=(curve as Record<string,unknown>)[key]
    if(Array.isArray(points)&&points.length>CAD_SUMMARY_POINTS){
      capped[key]=points.slice(0,CAD_SUMMARY_POINTS)
      capped.pointsCapped=true
    }
  }
  return capped
}

/**
 * 有界摘要：模型默认看到的就是它。**每条事实都来自 report**，只是条数与点数有上限，
 * 并给出总数与"完整数据在哪"的说明；不新增任何 report 里没有的结论。
 */
export function summarizeCadReport(report:CadReport,limit:number=CAD_SUMMARY_ITEMS):Record<string,unknown>{
  const lists=report.truncated?.lists??{}
  return {
    ok:true,
    file:report.file,
    format:report.format,
    units:report.units,
    bounds:{
      mode:report.bounds.mode,
      sizeDrawingUnits:report.bounds.sizeDrawingUnits,
      sizeMetres:report.bounds.sizeMetres,
      headerDeclared:report.bounds.headerDeclared,
      entityTypes:report.bounds.entityTypes,
      excludedEntityTypes:report.bounds.excludedEntityTypes,
    },
    counts:report.counts,
    layers:report.layers.slice(0,limit).map(layer=>layer.name),
    // 总数一律取 counts 里的**全量计数**：明细数组在 max_items 截断后长度不是总数（拿它当 Total 会少报）。
    layersTotal:report.counts.layers,
    blocks:{
      definitionCount:report.blocks.definitionCount,
      referenceCount:report.blocks.referenceCount,
      modelspaceReferenceCount:report.blocks.modelspaceReferenceCount,
      nestedReferenceCount:report.blocks.nestedReferenceCount,
      definitions:report.blocks.definitions.slice(0,limit).map(item=>({
        name:item.name,kind:item.kind,entityCount:item.entityCount,referenceCount:item.referenceCount,
      })),
      references:report.blocks.references.slice(0,limit).map(item=>({
        block:item.block,space:item.space,parentBlock:item.parentBlock,handle:item.handle,
        insert:item.insert,rotationDeg:item.rotationDeg,scale:item.scale,transform:item.transform,
      })),
    },
    curves:report.geometry.curves.slice(0,limit).map(summaryCurve),
    curveCount:report.geometry.curveCount,
    curvesBySpace:report.geometry.curvesBySpace,
    dimensions:report.dimensions.slice(0,limit).map(item=>({
      dimTypeName:item.dimTypeName,flags:item.flags,measurement:item.measurement,
      measurementPoint:item.measurementPoint,measurementUnit:item.measurementUnit,
      text:item.text,textOverride:item.textOverride,handle:item.handle,
    })),
    dimensionsTotal:report.counts.dimensions,
    unsupported:report.unsupported,
    unsupportedEntityCount:report.unsupportedEntityCount,
    warnings:report.warnings,
    truncated:report.truncated,
    summary:{
      itemsPerList:limit,pointsPerCurve:CAD_SUMMARY_POINTS,
      listsTruncated:Object.entries(lists).filter(([,value])=>value===true).map(([key])=>key),
      note:'这是有界摘要：每类明细最多 '+limit+' 条、每条曲线最多 '+CAD_SUMMARY_POINTS+
        ' 个点，其余在本次调用的 report 字段（结构化值，供建模/工作流读取；不再受本摘要的条数/点数压缩，'+
        '但仍受 max_items 与单条曲线点数上限约束）。只有计数是全量：各类总数看 counts 与各 *Count。'+
        '需要未经摘要压缩的全文放进上下文时显式传 detail="full"。',
    },
  }
}

/**
 * 薄注册：把 `cad_inspect` 交给原生 tools 注册表。调用方（下层插件）在 `apply` 里调用，
 * 并自行声明 inject 含 `tools` 与 `subprocess`——本函数不新建插件、不持有状态。
 * 相对路径按**会话任务工作区**解析（config.workspace 兜底），不落产品根。
 * @returns 注销函数（插件卸载时调用）。
 */
export function registerCadTools(ctx:Context,config:CadConfig={}){
  const subprocess=ctx.get('subprocess')
  return ctx.tools.register(defineTool({
    name:'cad_inspect',
    description:'Read actual DXF drawings (ASCII or Binary) using isolated Python with ezdxf. Return original units, layers, block definitions/references/transforms (including space/parentBlock for nested references), actual curve geometry (endpoints/vertices and bulge, circle centres/radii/angles, SPLINE knots/weights), dimensions, and unknown/unsupported entities. Relative paths resolve against the current session task workspace. Report declared units and whether they are unknown; never assume millimetres. DWG must first be converted to DXF and is directly rejected here. Do not model, write back, or invent CAD data from images. By default, place only a bounded summary in context; structured data remains in report. Both are bounded by max_items and per-curve point limits; only counts are complete.',
    parameters:{
      path:{type:'string',required:true,description:'DXF file path, absolute or relative to the current session task workspace. A relative path without a workspace fails explicitly.'},
      unit:{type:'string',enum:CAD_UNITS,description:'Optional explicit caller unit when the file declares no units or an override is needed; recorded as units.source="caller".'},
      max_items:{type:'integer',description:'Maximum items per detail list; defaults to 500. Counts remain complete and are not limited.'},
      exact_bounds:{type:'boolean',description:'Optional exact bbox computation for bounds; slow and not recommended for large drawings.'},
      detail:{type:'string',enum:CAD_DETAILS,description:'Presentation detail for result: summary (default) is bounded to 12 items per category and 32 points per curve. full returns raw report JSON without summary compression, but still obeys max_items and per-curve point limits; it may be very large, so do not use it by default. Only counts are complete.'},
    },
    output:{
      schema:{type:'object',additionalProperties:false,properties:{result:{type:'string',required:true},report:{type:'json',required:true}}},
      render:(_args,value)=>{const blocks:ContentBlock[]=[{type:'text',text:value.result}];return blocks},
    },
    async execute(args,exec){
      const python=resolveCadPython(config)
      if(!python)
        throw new CadError('CAD_PYTHON_UNCONFIGURED',
          '没有配置 CAD 解释器：请在插件 config 里给 python，或设置 LYAPUNOV_CAD_PYTHON 指向一个装好 ezdxf 的隔离 venv（uv venv --offline … && uv pip install --offline ezdxf==1.4.4）',
          {script:config.script??fileURLToPath(CAD_SCRIPT_URL)})
      if(!subprocess)
        throw new CadError('CAD_SUBPROCESS_UNAVAILABLE','缺少 subprocess 服务：调用方插件 inject 需要包含 subprocess',{})
      const cwd=cadTaskCwd(exec,config)
      const file=resolveCadPath(exec,config,args.path,'path')
      const script=config.script??fileURLToPath(CAD_SCRIPT_URL)
      const report=await inspectDxf({
        subprocess,python,script,...cwd?{cwd}:{},
        file,
        ...(args.unit!==undefined?{unit:args.unit}:{}),
        ...(args.max_items!==undefined?{maxItems:args.max_items}:{}),
        ...(args.exact_bounds!==undefined?{exactBounds:args.exact_bounds}:{}),
        ...(config.timeoutMs!==undefined?{timeoutMs:config.timeoutMs}:{}),
        signal:exec.signal,
      })
      // 两种消费面，同一份事实：`result` 是给模型的有界摘要（默认）或报告原文（detail="full"），
      // `report` 是结构化值（工作流/后续 Blender 建模直接读，不必再解析字符串）。
      // 两者都不"无条件全量"：明细受 max_items、单条曲线点数受 128 上限，只有计数是全量。
      const detail:CadDetail=args.detail??'summary'
      const result=detail==='full'?JSON.stringify(report):JSON.stringify(summarizeCadReport(report))
      return {result,report:report as unknown as JsonValue}
    },
  }))
}
