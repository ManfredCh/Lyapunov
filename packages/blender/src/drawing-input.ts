/**
 * 图纸输入分流：**先看文件到底是什么**，再走对应的真实通道。
 *
 *  · DXF         → 复用 cad.ts 的 `inspectDxf`（同一份解析，不重写第二条）
 *  · DWG         → 用**可配置、可实际运行**的外部转换器转成新 DXF（LibreDWG dwg2dxf / 任意命令
 *                  模板），只在自己的临时目录里转，**只写新文件、绝不写原件**：转换前先拒绝
 *                  输出==源及其别名，转换前后各算一次源文件 sha256，变了就报错并撤下本次产物；
 *                  转出的 DXF 再用 ezdxf 只读检验，**检验通过才原子发布到目标**（否则目标不动）
 *  · 矢量 PDF    → 隔离 Python 的 drawing_inspect.py：真实路径算子（含 CTM 变换）、文字与坐标、
 *                  页面实际尺寸；**PDF point 不是建筑米**，没有显式比例尺就没有米制换算
 *  · 扫描 PDF    → 同一脚本把页面里的**原生图像**导出成 PNG，本工具把它作为图像附件送进模型上下文
 *                  （附件服务不可用时如实说明"只能按路径自行读取"，不静默丢弃）
 *  · 位图图纸    → 明确分流：本工具不解析像素，直接作为图片交给模型读图
 *
 * 分层：`inspectDrawing` / `convertDwgToDxf` 是共用 operation（Command／工作流可直接调用），
 * `registerDrawingTools` 只是把同一 operation 注册成模型工具——行为只有一份。
 * 结果同样分两面：`result` 是有界摘要（模型读），`report` 是结构化值（建模/工作流读）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'
import { open, mkdir, readFile, rm, stat, copyFile, mkdtemp, realpath, rename, link } from 'node:fs/promises'
import { constants, existsSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve, basename, extname } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CadError, CAD_SUMMARY_ITEMS, DWG_SIGNATURES, dwgSignature, inspectDxf, pdfHeader, resolveCadPath,
  resolveCadPython, summarizeCadReport, type CadConfig, type CadReport, type CadScope,
} from './cad.ts'

/** drawing_inspect.py 成功时的结果前缀（与 cad_inspect.py 同一约定，前缀不同）。 */
export const DRAWING_RESULT_PREFIX='LYAPUNOV_DRAWING_RESULT='
/** drawing_inspect.py 可预期失败时的错误前缀（退出码 3）。 */
export const DRAWING_ERROR_PREFIX='LYAPUNOV_DRAWING_ERROR='
/** PDF 解析器脚本路径：随包走，不依赖安装位置。 */
export const DRAWING_SCRIPT_URL=new URL('../python/drawing_inspect.py',import.meta.url)
/** 分流识别出的文件种类。 */
export const DRAWING_KINDS=['dwg','dxf','pdf','image','unknown'] as const
export type DrawingKind=(typeof DRAWING_KINDS)[number]
/** result 的呈现粒度：summary（默认，有界摘要）| full（报告 JSON 原文）。 */
export const DRAWING_DETAILS=['summary','full'] as const
export type DrawingDetail=(typeof DRAWING_DETAILS)[number]
/** 摘要里最多带几张扫描图进模型上下文（超出的仍以真实路径留在结果里）。 */
export const DRAWING_MAX_IMAGES=4
/** constraints 的轴与单位取值：校验器与类型共用同一份，避免两处各写一套。 */
export const DRAWING_CONSTRAINT_AXES=['x','y','z'] as const
export const DRAWING_CONSTRAINT_UNITS=['pt','mm','m'] as const
/** 开口种类（ENV-14）：只认这三种；判定靠**图层名**里的明确词，不做几何推测。 */
export const DRAWING_OPENING_KINDS=['door','window','passage'] as const
/** 图层名 → 开口种类的判定词（大小写无关；中文词表与英文并列，避免"只认英文图层"的隐性门槛）。 */
const DRAWING_OPENING_LAYER_WORDS:Array<{kind:(typeof DRAWING_OPENING_KINDS)[number];words:string[]}>= [
  {kind:'door',words:['door','doors','门','门洞','门扇']},
  {kind:'window',words:['window','windows','win','窗','窗户','窗洞']},
  {kind:'passage',words:['passage','opening','openings','洞','开口','通道','洞口']},
]
/** 缺项假设的稳定 code（ENV-13）：单位未声明 / 无标高 / 无层高 / 无厚度。 */
export const DRAWING_ASSUMPTION_CODES=['UNIT_UNDECLARED','NO_ELEVATION','NO_STOREY_HEIGHT','NO_THICKNESS'] as const
/** constraints 最多覆盖多少张已量出尺寸的页（PDF 图纸通常 1~2 页；完整页事实仍在 report.pages 里）。 */
const DRAWING_CONSTRAINT_PAGES=8

// 一个签名可以有多个片段（parts 全部命中才算）：webp 除了开头的 RIFF，
// 还要看第 8 字节起是不是 WEBP——否则同是 RIFF 容器的 wav/avi 会被当成位图图纸。
const IMAGE_SIGNATURES:Array<{name:string;parts:Array<{at:number;bytes:number[]}>}>= [
  {name:'png',parts:[{at:0,bytes:[0x89,0x50,0x4e,0x47]}]},
  {name:'jpeg',parts:[{at:0,bytes:[0xff,0xd8,0xff]}]},
  {name:'gif',parts:[{at:0,bytes:[0x47,0x49,0x46,0x38]}]},
  {name:'bmp',parts:[{at:0,bytes:[0x42,0x4d]}]},
  {name:'tiff-le',parts:[{at:0,bytes:[0x49,0x49,0x2a,0x00]}]},
  {name:'tiff-be',parts:[{at:0,bytes:[0x4d,0x4d,0x00,0x2a]}]},
  {name:'webp',parts:[{at:0,bytes:[0x52,0x49,0x46,0x46]},{at:8,bytes:[0x57,0x45,0x42,0x50]}]},
]

export interface DrawingSniff{
  path:string
  bytes:number
  kind:DrawingKind
  /** 人类可读的一句话判定依据（进报告，便于核对"分流是不是真的看了文件头"）。 */
  evidence:string
  signature:string|null
  dwgVersion:{code:string;release:string}|null
  binaryDxf:boolean
  pdfHeader:string|null
  imageFormat:string|null
  headHex:string
}

export interface DrawingFileFacts{path:string;name:string;bytes:number;sha256:string}

export interface PdfPageFacts{
  index:number
  rotation:number
  /** 页面盒（PDF 用户空间，单位 point）。显示窗口是 cropBox，不是 mediaBox。 */
  mediaBox?:number[]|null
  cropBox?:number[]|null
  classification:string
  size:{widthPoints:number;heightPoints:number;widthMm:number;heightMm:number}|null
  content:Record<string,unknown>
  text:{chars:number;itemCount:number;sample:string|null}
  images:Array<Record<string,unknown>>
  errors:string[]
}

export interface PdfReport{
  ok:true
  scriptVersion:string
  source:{engine:string;engineVersion:string;interpreter:string;interpreterVersion:string;pillow:string|null}
  file:DrawingFileFacts
  format:{kind:'pdf';header:string|null;pageCount:number;pagesAnalyzed:number;encrypted:boolean;producer:string|null;creator:string|null}
  pages:PdfPageFacts[]
  classification:'vector'|'scanned'|'mixed'|'image-only'|'empty'
  /** 分析范围：classification 与 pages/counts 只覆盖 pagesAnalyzed 页（少于总页数时不代表整本）。 */
  scope?:{
    pagesTotal:number;pagesAnalyzed:number;unanalyzedPageCount:number
    classificationCovers:'analyzed-pages-only'|'whole-document';note:string
  }
  units:{
    pageUnit:string;pointsPerInch:number;mmPerPoint:number;userUnit:number|number[]
    metresKnown:boolean;metresSource:'caller-scale'|null;metresPerPagePoint:number|null;callerScale:string|null
    scaleStatements:Array<Record<string,unknown>>;note:string
  }
  vector:{
    pathCount:number;pathsListed:number;paths:Array<Record<string,unknown>>;byPaint:Record<string,number>
    closedPathCount:number;bboxPagePoints:number[]|null;bboxPageMm:number[]|null
    bboxMetresByCallerScale:number[]|null;note:string
  }
  text:{charCount:number;itemCount:number;itemsListed:number;items:Array<Record<string,unknown>>;pagesWithText:number[];note:string}
  counts:Record<string,number>
  images:{
    exported:Array<{
      page:number;name:string;path:string;source:'embedded'|'rasterized'
      width:number|null;height:number|null;bytes:number;sha256:string;downscaled?:boolean
      tool?:string;dpi?:number
      /** true = 按页面旋转/裁切整页渲染的预览（用户看到的样子）；false = 页面里的嵌入原样像素。 */
      asDisplayed?:boolean
      rotateDegrees?:number
      cropBox?:number[]|null
      mediaBox?:number[]|null
      reason?:string[]
      note?:string
    }>
    failures:Array<{page:number;image?:string;reason:string}>
    requestedPages:number[]
    note?:string
  }
  warnings:string[]
  truncated:Record<string,boolean|number>
}

export interface DwgConversion{
  ok:true
  source:DrawingFileFacts&{kind:'dwg';dwgVersion:{code:string;release:string}|null}
  converter:{
    kind:DwgConverterKind;bin:string;label:string;version:string|null;argv:string[]
    exitCode:number|null;signal:string|null;stderrTail:string
  }
  output:DrawingFileFacts&{format:{kind:'dxf';binary:boolean}}
  /** 转换前后源文件 sha256 一致才为 true；不一致时本次调用直接失败。 */
  sourceUnchanged:boolean
  /** 转换器自己吐出来的告警（libredwg 的 "Warning: …"），已去重并截断——转换损失就在这里。 */
  losses:string[]
  lossCategories:Record<string,number>
  verification:{ok:boolean;engine:'ezdxf'|null;error:string|null;entityCount:number|null;counts:Record<string,number>|null;units:unknown|null}|null
  /** 转出的 DXF 的完整读取报告（ezdxf 真读出来才有；检验失败时是 null）。 */
  dxf:CadReport|null
  warnings:string[]
}

/** 三维几何约束：由解析出来的**真实读数**折算，逐条带单位与来源字段/来源页，便于回查每一个数。 */
export interface DrawingConstraint{
  axis:(typeof DRAWING_CONSTRAINT_AXES)[number]
  /** 该轴上的范围长度（max-min）：图幅/纸面尺寸或几何范围，不是坐标原点值，也不是标高。 */
  value:number
  unit:(typeof DRAWING_CONSTRAINT_UNITS)[number]
  /** 读数来自报告里的哪个字段（点分路径，可逐条回查）。 */
  source:string
  /** 来源页序号：PDF 用报告里的页序号（`pdf.pages[].index`，从 1 开始）；DXF/DWG 没有页概念，固定 0。 */
  pageRef:number
}

/**
 * 开口（ENV-14）：由**真实几何 + 图层名**折算的一处开口事实（门/窗/通道）。
 * 只加字段，不新建类层次：`layerName` 指认它是从哪一层读出来的，`sourceRef` 指回报告字段可复查。
 * **粒度是"建模实体"**：开口层里每一条建模实体各成一条（同层多处开口**不合并**）——
 * 合并会掩盖层内改动（门宽 1.1→2.2 m 而层包围盒不变时就查不出来）。
 * 单位未声明时**不产出**米制开口（与 constraints 同一口径：没有"单位声明"这个事实就不给米数）。
 */
export interface DrawingOpening{
  kind:(typeof DRAWING_OPENING_KINDS)[number]
  /** 读数的来源图层名（真实图层名，不重命名、不翻译）。 */
  layerName:string
  /** 该开口跨度所在轴（取**该实体自身**包围盒较长的一边）。 */
  axis:'x'|'y'
  /** **该实体自身**包围盒较长边的米制跨度（`dxf.layerBounds[...].sizes[...]` 按 units.metresPerUnit 折算）。 */
  spanM:number
  /**
   * 该实体自身包围盒**最小角**的米制坐标（`dxf.layerBounds[...].origins[...]` 折算）。
   * 只在解析报告给了 `origins` 时产出（不给就不编造 0）：它让"尺寸不变、只在层内平移"的开口变更也能被点名。
   */
  originM?:number[]
  /** 折算成本条的建模实体数（逐实体折算 ⇒ 恒为 1；保留字段以兼容既有消费者，不表示"该层开口总数"）。 */
  count:number
  /** 读数来自报告里的哪个字段（点分路径，可逐条回查）。 */
  sourceRef:string
}

/**
 * 开口层里**读不出开口**时的显式记录（ENV-14）：空图层、0 m 退化几何、以及**逐实体明细被截断**的层
 * 都不能静默省略——报告要写清"哪一层、为什么没折算成开口"，否则下游只能当成"这一层不存在"。
 * `reason` 三种：整层没有可折算实体（EMPTY）、实体在但跨度为 0（DEGENERATE）、
 * 实体多于逐实体明细上限 ⇒ 第 N 条之后**不在事实里**（SIZES_TRUNCATED，`factsComplete:false`）。
 * 这些都不进 `openings`/`openingsDigest`/`factsDigest`（退化/截断输入不该改动"已确认事实"），只在这里留痕。
 */
export interface DrawingOpeningSkip{
  layerName:string
  reason:'OPENING_LAYER_EMPTY_IGNORED'|'OPENING_LAYER_DEGENERATE'|'OPENING_LAYER_SIZES_TRUNCATED'
  /** 该层参与折算的建模实体数（同一次解析；EMPTY 时是 0 或"有实体但一条都没有可用包围盒"）。 */
  entityCount:number
  detail:string
  /** 读数来自报告里的哪个字段（点分路径，可逐条回查）。 */
  sourceRef:string
}

/** 该报告的事实层是否**完整**：任一开口层的逐实体明细被截断 ⇒ 不完整（`compareFacts` 据此拒绝断言"未变"）。 */
export function factsCompleteOf(report:Pick<DrawingReport,'openingSkips'>):boolean{
  return !report.openingSkips.some(item=>item.reason==='OPENING_LAYER_SIZES_TRUNCATED')
}

/**
 * 事实比对的一侧：三类信息一起给。`openingSkips` 是**完整性的来源**——不传它就等于"不知道这一侧读全了没有"，
 * 此时 `compareFacts` 按**保守**处理（`factsComplete:false`，不判"未变"），避免"没给完整性信息"被静默当成"完整"。
 * 拿得到报告就传 `report.openingSkips`；确实知道该侧完整（例如调用方声明的基线）可用第三个参数显式声明。
 */
export interface DrawingFactSide{
  constraints:readonly DrawingConstraint[]
  openings:readonly DrawingOpening[]
  openingSkips?:readonly DrawingOpeningSkip[]
}

/**
 * 一侧是否完整：`openingSkips` **没给 ⇒ false**（不知道 = 不能断言）；给了就按有无截断层判。
 */
export function factsCompleteOfSide(side:DrawingFactSide):boolean{
  return Array.isArray(side.openingSkips) && !side.openingSkips.some(item=>item.reason==='OPENING_LAYER_SIZES_TRUNCATED')
}

/** 缺项假设：报告里**没有**的事实就写成假设，不拿别的字段顶替。每条都说清为什么是假设。 */
export interface DrawingAssumption{
  code:(typeof DRAWING_ASSUMPTION_CODES)[number]
  detail:string
  /** 为什么这是缺项（报告里哪个字段是 null / 不存在），以及补齐它需要什么事实。 */
  why:string
}

/** 已确认尺寸的变更前后判定（ENV-14）：逐条逐值比，**多出来的、丢掉的**都要点名，不能只看总数。 */
export interface ConstraintComparison{
  /** 逐条逐值一致且摘要相同才为 true（不是"数量一样"就算没变）。 */
  unchanged:boolean
  /** 基线（已确认尺寸）与新读数的稳定摘要；两侧相同 ⇔ 逐条逐值一致。 */
  digestBefore:string
  digestAfter:string
  equal:DrawingConstraint[]
  /** 同一条（轴/单位/来源/页）但值变了：材质/风格变更**不该**产生这一桶。 */
  changed:Array<{before:DrawingConstraint;after:DrawingConstraint}>
  /** 基线里有、这次没有 = 已确认的尺寸事实丢了（最危险的一桶）。 */
  removed:DrawingConstraint[]
  /** 基线里没有、这次多了 = 多出来的尺寸事实（也要点名，不算"未变"）。 */
  added:DrawingConstraint[]
}

/** 开口的变更前后判定（ENV-14 第二桶）：语义与 dimensions 桶一致，只是条目类型是 DrawingOpening。 */
export interface OpeningComparison{
  unchanged:boolean
  digestBefore:string
  digestAfter:string
  equal:DrawingOpening[]
  changed:Array<{before:DrawingOpening;after:DrawingOpening}>
  removed:DrawingOpening[]
  added:DrawingOpening[]
}

/**
 * 两类事实（尺寸 + 开口）的**同一份**变更判定（ENV-14）：
 * `unchanged` 要求两桶都逐条逐值一致**且**两类事实的合并摘要逐字相同——只看尺寸会漏掉"门洞被改宽"。
 * 另外要求**事实完整**（`factsComplete`）：某一侧有开口层的逐实体明细被截断时，窗口外的实体根本不在
 * 事实里，摘要再相同也**不能**断言"未变"（否则改第 513 条会漏报）。
 * `connections` 是**明文不承载**：CAD 侧没有构件拓扑，这里恒定返回 null 并给出 why，不填 0、不静默省略。
 */
export interface FactsComparison{
  unchanged:boolean
  /** 两侧的事实层是否都完整（任一开口层 `sizesTruncated` ⇒ false）。`unchanged:false` 时看它区分"变了"与"证不了没变"。 */
  factsComplete:boolean
  factsDigestBefore:string
  factsDigestAfter:string
  dimensions:ConstraintComparison
  openings:OpeningComparison
  connections:null
  connectionsWhy:string
}

export interface DrawingReport{
  ok:true
  kind:'dxf'|'dwg'|'pdf'
  file:DrawingFileFacts
  format:DrawingSniff
  dxf:CadReport|null
  conversion:DwgConversion|null
  pdf:PdfReport|null
  /** 几何约束（x/y/z）：只由真读出来的字段折算；单位未声明时没有米制条目（不把图纸单位当米）。 */
  constraints:DrawingConstraint[]
  /** 已确认尺寸的稳定摘要（`constraintsDigest(constraints)`）：可直接当"已确认"的凭据留存与比对。 */
  constraintsDigest:string
  /** 开口事实（门/窗/通道）：由真实几何 + 图层名折算；单位未声明时不产出米制开口（与 constraints 同口径）。 */
  openings:DrawingOpening[]
  /** 开口层里读不出开口的**显式理由**（空图层 / 0 m 退化几何）：不静默省略，也不写进开口事实。 */
  openingSkips:DrawingOpeningSkip[]
  /** 开口的稳定摘要（`openingsDigest(openings)`）。 */
  openingsDigest:string
  /** 尺寸 + 开口进**同一份**摘要（`factsDigest(constraints, openings)`）：ENV-14 的"已确认事实"凭据。 */
  factsDigest:string
  /** 缺项假设（单位未声明/无标高/无层高/无厚度）：逐条声明"报告里没有这个事实"。 */
  assumptions:DrawingAssumption[]
  warnings:string[]
}

export type DwgConverterKind='libredwg'|'command'

export interface DwgConverterSetting{
  kind?:DwgConverterKind
  /** 可执行文件绝对路径（或 PATH 里的名字）。 */
  path?:string
  /** command 类型的参数模板：{in}/{out} 占位；libredwg 用内置参数（`-o <out> <in>`）。 */
  args?:string[]
  label?:string
}

export interface DrawingConfig extends CadConfig{
  /** DWG → DXF 转换器；不给则回落 LYAPUNOV_DWG_CONVERTER(_KIND/_ARGS)，再沿 PATH 找 dwg2dxf。 */
  dwgConverter?:DwgConverterSetting
  /** 扫描页 PNG 的落盘目录；相对路径按会话工作区解析。默认 <工作区>/drawing-images。 */
  imageDirectory?:string
  /** 最多导出/带入几张扫描页图像（默认 4）。 */
  maxImages?:number
  /** 扫描页嵌入图取不出来时的回退栅格化工具（默认 auto：本机 gs / pdftocairo）。 */
  rasterizer?:'auto'|'gs'|'pdftocairo'|'none'
  /** 回退栅格化的 DPI（默认 150）。 */
  rasterizationDpi?:number
}

export interface ResolvedDwgConverter{
  kind:DwgConverterKind
  bin:string
  label:string
  args:string[]|null
  source:'config'|'env'|'path'
}

/** 已知转换器候选（按这个顺序探测 PATH）。只有实测跑通过的 LibreDWG；其它工具走 command 模板。 */
export const DWG_CONVERTER_CANDIDATES:Array<{kind:DwgConverterKind;bin:string;label:string}>= [
  {kind:'libredwg',bin:'dwg2dxf',label:'GNU LibreDWG dwg2dxf'},
]

const DEFAULT_TIMEOUT_MS=180_000

function inferKind(bin:string):DwgConverterKind{
  const name=basename(bin).toLowerCase()
  if(name.includes('dwg2dxf')||name.includes('libredwg'))return 'libredwg'
  return 'command'
}

/** 明确排除：ODA File Converter 是**目录语义**，本实现没有这条分支（也没实测过），不假装支持。 */
function assertNotOda(bin:string):void{
  if(basename(bin).toLowerCase().includes('odafileconverter'))
    throw new CadError('DWG_CONVERTER_UNSUPPORTED',
      `不支持 ODA File Converter（${bin}）：它按目录调用，本实现没有实测过这条路径。`+
      '请用 LibreDWG 的 dwg2dxf，或把任意**命令行**转换器配成 dwgConverter:{kind:"command",args:[…,"{in}","{out}"]}',
      {bin})
}

/**
 * 转换器解析：显式配置 > 环境变量 > PATH 探测。**没有**静默默认：
 * 一个都没找到就返回 undefined，由调用方报 `DWG_CONVERTER_UNCONFIGURED` 并给出安装指引。
 */
export function resolveDwgConverter(
  config:DrawingConfig={},
  env:NodeJS.ProcessEnv=process.env,
  probe:(name:string)=>string|undefined=(name)=>whichSync(name,env),
):ResolvedDwgConverter|undefined{
  const configured=config.dwgConverter
  if(configured?.path?.trim()){
    const bin=configured.path.trim()
    assertNotOda(bin)
    return {kind:configured.kind??inferKind(bin),bin,label:configured.label??bin,
      args:configured.args??null,source:'config'}
  }
  const pathProbe=(name:string)=>probe(name)
  const fromEnv=env.LYAPUNOV_DWG_CONVERTER?.trim()
  if(fromEnv){
    const rawArgs=env.LYAPUNOV_DWG_CONVERTER_ARGS?.trim()
    let args:string[]|null=null
    if(rawArgs){
      try{
        const parsed=JSON.parse(rawArgs)
        args=Array.isArray(parsed)?parsed.map(String):null
      }catch{
        args=rawArgs.split(/\s+/).filter(Boolean)
      }
    }
    const declared=env.LYAPUNOV_DWG_CONVERTER_KIND?.trim()
    assertNotOda(fromEnv)
    return {
      kind:(declared==='libredwg'||declared==='command')?declared:inferKind(fromEnv),
      bin:fromEnv,label:fromEnv,args,source:'env',
    }
  }
  for(const candidate of DWG_CONVERTER_CANDIDATES){
    const found=pathProbe(candidate.bin)
    if(found)return {kind:candidate.kind,bin:found,label:candidate.label,args:null,source:'path'}
  }
  return undefined
}

/** PATH 查找（不引依赖：先看绝对路径，再逐段查 PATH）。 */
function whichSync(name:string,env:NodeJS.ProcessEnv=process.env):string|undefined{
  if(name.includes('/'))return existsSync(name)?name:undefined
  const segments=(env.PATH??'').split(delimiter).filter(Boolean)
  for(const segment of segments){
    const candidate=join(segment,name)
    if(existsSync(candidate))return candidate
  }
  return undefined
}

/**
 * 文件头分流：**只认文件字节，不认扩展名**（改名不会骗过它）。
 * DWG 判定要求签名后 5 字节为 0（DXF 的 $ACADVER 也是同样的版本串，只靠 6 字节会把 DXF 误判成 DWG）。
 */
export async function sniffDrawingFile(file:string):Promise<DrawingSniff>{
  let handle
  try{ handle=await open(file,'r') }
  catch(error){
    const code=(error as NodeJS.ErrnoException).code
    if(code==='ENOENT')throw new CadError('DRAWING_FILE_MISSING',`文件不存在：${file}`,{path:file})
    throw new CadError('DRAWING_FILE_UNREADABLE',`文件不可读：${String(error)}`,{path:file})
  }
  try{
    const info=await handle.stat()
    if(!info.isFile())throw new CadError('DRAWING_FILE_NOT_A_FILE',`不是普通文件：${file}`,{path:file})
    if(info.size===0)throw new CadError('DRAWING_FILE_EMPTY',`文件是空的：${file}`,{path:file})
    const buffer=Buffer.alloc(1024)
    const {bytesRead}=await handle.read(buffer,0,buffer.length,0)
    const head=buffer.subarray(0,bytesRead)
    const headHex=head.subarray(0,12).toString('hex')
    const latin=head.toString('latin1')
    const signature=dwgSignature(head)
    if(!latin.startsWith('AutoCAD Binary DXF')&&signature)
      return {path:file,bytes:info.size,kind:'dwg',evidence:`DWG 签名 ${signature} 且其后 5 字节为 0`,
        signature,dwgVersion:{code:signature,release:DWG_SIGNATURES[signature]??signature},
        binaryDxf:false,pdfHeader:null,imageFormat:null,headHex}
    const header=pdfHeader(latin)
    if(header)
      return {path:file,bytes:info.size,kind:'pdf',evidence:`PDF 头 ${header}`,
        signature:null,dwgVersion:null,binaryDxf:false,pdfHeader:header,imageFormat:null,headHex}
    if(latin.startsWith('AutoCAD Binary DXF'))
      return {path:file,bytes:info.size,kind:'dxf',evidence:'Binary DXF 头',signature:null,dwgVersion:null,
        binaryDxf:true,pdfHeader:null,imageFormat:null,headHex}
    const trimmed=latin.replace(/^\uFEFF/,'').trimStart()
    if(/^(\d{1,3}|999)\s*\n?\s*SECTION/.test(trimmed)||/^0\r?\nSECTION/.test(trimmed))
      return {path:file,bytes:info.size,kind:'dxf',evidence:'ASCII DXF 组码 SECTION',signature:null,dwgVersion:null,
        binaryDxf:false,pdfHeader:null,imageFormat:null,headHex}
    if(latin.includes('SECTION')&&/^(0|999)[\r\n]/.test(trimmed))
      return {path:file,bytes:info.size,kind:'dxf',evidence:'ASCII DXF（含 SECTION 组）',signature:null,dwgVersion:null,
        binaryDxf:false,pdfHeader:null,imageFormat:null,headHex}
    for(const candidate of IMAGE_SIGNATURES)
      if(candidate.parts.every(part=>head.length>=part.at+part.bytes.length
        &&part.bytes.every((byte,index)=>head[part.at+index]===byte)))
        return {path:file,bytes:info.size,kind:'image',evidence:`位图签名 ${candidate.name}`,signature:null,
          dwgVersion:null,binaryDxf:false,pdfHeader:null,imageFormat:candidate.name,headHex}
    return {path:file,bytes:info.size,kind:'unknown',evidence:'文件头不匹配任何已知图纸格式',signature:null,
      dwgVersion:null,binaryDxf:false,pdfHeader:null,imageFormat:null,headHex}
  }finally{ await handle.close() }
}

async function sha256(file:string):Promise<string>{
  const digest=createHash('sha256')
  const handle=await open(file,'r')
  try{
    for await(const chunk of handle.createReadStream())digest.update(chunk as Buffer)
  }finally{ await handle.close() }
  return digest.digest('hex')
}

async function fileFacts(file:string):Promise<DrawingFileFacts>{
  const info=await stat(file)
  return {path:file,name:basename(file),bytes:info.size,sha256:await sha256(file)}
}

/** 转换器自己的告警（libredwg 往 stderr 打 "Warning: …"）：这就是转换损失的原始证据。 */
export function parseConverterLosses(stderr:string,limit=20):{losses:string[];categories:Record<string,number>}{
  const categories:Record<string,number>={}
  const unique:string[]=[]
  for(const raw of stderr.split('\n')){
    const line=raw.trim()
    if(!line)continue
    const matched=/^(Warning|Error|Unhandled|Unstable|Skip|Skipped|Ignored|Invalid)\b[:\s]*(.*)$/i.exec(line)
    if(!matched)continue
    const bucket=matched[1].toLowerCase()
    categories[bucket]=(categories[bucket]??0)+1
    const message=line.slice(0,240)
    if(!unique.includes(message)&&unique.length<limit)unique.push(message)
  }
  return {losses:unique,categories}
}

/**
 * 转换器参数。`output` 永远是**我们自己的暂存路径**（新文件），所以这里不需要覆盖开关：
 * 调用方的目标文件只在检验通过之后才被发布（覆盖与否都由调用方显式授权），转换器根本没机会碰它。
 */
function converterArgv(converter:ResolvedDwgConverter,source:string,output:string):string[]{
  if(converter.kind==='libredwg')
    return [converter.bin,'-o',output,source]
  if(converter.kind==='command'){
    const template=converter.args??['-o','{out}','{in}']
    if(!template.some(item=>item.includes('{in}'))||!template.some(item=>item.includes('{out}')))
      throw new CadError('DWG_CONVERTER_TEMPLATE_INVALID',
        `转换器参数模板必须同时含 {in} 与 {out}：${JSON.stringify(template)}`,{template})
    return [converter.bin,...template.map(item=>item.replaceAll('{in}',source).replaceAll('{out}',output))]
  }
  throw new CadError('DWG_CONVERTER_UNSUPPORTED',`不认识的转换器类型：${String(converter.kind)}`,{kind:converter.kind})
}

/**
 * 源文件与输出目标不能是同一个东西——**在转换之前**就拒，不靠事后 hash 恢复原件。
 * 三重判定：路径相同 / realpath 相同（symlink 别名）/ dev+ino 相同（硬链接别名，realpath 看不出来）。
 */
async function assertOutputDistinctFromSource(source:string,output:string):Promise<void>{
  const reject=(alias:string):never=>{
    throw new CadError('DWG_OUTPUT_IS_SOURCE',
      `输出路径和源 DWG 是同一个文件（${alias}）：转换会毁掉原件，已拒绝。`+
      `请给一个不同的 out：${output}`,{source,output,alias})
  }
  if(resolve(source)===resolve(output))reject('same-path')
  if(!existsSync(output))return
  // 探测本身可能失败（竞态/权限），但**判定结果**不在 try 里再抛，免得被 catch 吞掉
  let sameRealPath=false
  try{ sameRealPath=await realpath(output)===await realpath(source) }
  catch{ /* realpath 失败：下面的 inode 判定继续兜 */ }
  if(sameRealPath)reject('realpath/symlink')
  let sameInode=false
  try{
    const outputInfo=await stat(output)
    const sourceInfo=await stat(source)
    sameInode=outputInfo.dev===sourceInfo.dev&&outputInfo.ino===sourceInfo.ino
  }catch{ /* stat 失败：不阻塞，交给后续流程如实报错 */ }
  if(sameInode)reject('same-inode/hardlink')
}

/**
 * 发布产物：先拷进**目标目录**里的临时名（同文件系统），再顶替目标。
 * - `overwrite=true` 用 rename（POSIX 上目标存在也是原子替换，这是调用方显式授权的）；
 * - `overwrite=false` **一律不覆盖**：先用 link（目标已存在 → EEXIST；
 *   有些网络/FUSE/FAT 文件系统不支持硬链接），硬链接不可用时用 `COPYFILE_EXCL`
 *   独占创建（目标已存在同样 → EEXIST，绝不放行成 rename/覆盖）。
 * 任何一步失败都只删自己这个临时名，目标原文件（别人的文件）一个字节不动。
 * 返回值说明这次是怎么发布的（`exclusive-create` 表示硬链接不可用、走了独占创建）。
 */
async function publishAtomically(
  staged:string,target:string,overwrite:boolean,
  linkImpl:(existing:string,created:string)=>Promise<void>=link,
):Promise<'rename'|'link'|'exclusive-create'>{
  const existsError=()=>new CadError('DWG_OUTPUT_EXISTS',
    `发布前发现目标已被别人建出来，不覆盖：${target}（确实要覆盖就显式 overwrite=true）`,{path:target})
  await mkdir(dirname(target),{recursive:true})
  const scratch=join(dirname(target),`.${basename(target)}.${randomBytes(4).toString('hex')}.tmp`)
  await copyFile(staged,scratch)
  try{
    if(overwrite){
      await rename(scratch,target)
      return 'rename'
    }
    let via:'link'|'exclusive-create'='link'
    let createError:NodeJS.ErrnoException|null=null
    try{
      await linkImpl(scratch,target)
    }catch(error){
      createError=error as NodeJS.ErrnoException
    }
    if(createError&&createError.code!=='EEXIST'){
      // 硬链接不可用：换一条**同样不覆盖**的路——独占创建（O_CREAT|O_EXCL）。
      // 这里绝不能退到 rename：目标已被别人建出来时 rename 会把它顶掉。
      try{
        await copyFile(scratch,target,constants.COPYFILE_EXCL)
        createError=null
        via='exclusive-create'
      }catch(fallbackError){ createError=fallbackError as NodeJS.ErrnoException }
    }
    if(createError)
      throw createError.code==='EEXIST'?existsError()
        :new CadError('DWG_CONVERT_FAILED',
          `发布转换产物失败（${target}）：独占创建也被拒绝（${String(createError)}）；`+
          `${target} 与目标目录里已有的文件都原样未动`,{target,code:createError.code??null})
    await rm(scratch,{force:true})
    return via
  }catch(error){
    await rm(scratch,{force:true})
    if(error instanceof CadError)throw error
    throw new CadError('DWG_CONVERT_FAILED',
      `发布转换产物失败（${target}）：${String(error)}；目标目录里没有留下半成品`,{target})
  }
}

export interface DwgConvertOptions{
  subprocess:SubprocessRuntime
  /** DWG 源文件绝对路径。 */
  file:string
  /**
   * 输出 DXF 绝对路径。**只有本次转换成功且检验通过（或显式 verify:false）才被创建/替换**；
   * 失败、取消、检验不过时它（含已存在的旧文件）原样不动。
   */
  output:string
  /** 允许覆盖已存在的输出（默认 false：宁可报 DWG_OUTPUT_EXISTS 也不悄悄盖掉别人的文件）。 */
  overwrite?:boolean
  /** 版本探测/转换/检验用的解释器与脚本（检验走 cad_inspect.py）。 */
  python?:string
  script?:string
  converter:ResolvedDwgConverter
  /** 转换后是否用 ezdxf 只读检验转出的 DXF（默认 true）。 */
  verify?:boolean
  maxItems?:number
  cwd?:string
  timeoutMs?:number
  signal?:AbortSignal
  /**
   * 只在测试里注入：把"用硬链接做不覆盖创建"这一步换成别的实现，用来模拟**文件系统不支持硬链接**
   * （EPERM/EOPNOTSUPP/ENOSYS/EMLINK）。生产不传，走真实 `link`。
   */
  publishLink?:(existing:string,created:string)=>Promise<void>
}

/** 跑一个外部命令并收结果（stdout/stderr 有界）。 */
async function runProcess(options:{
  subprocess:SubprocessRuntime;argv:string[];cwd:string;timeoutMs:number;signal?:AbortSignal;label:string
}):Promise<{exitCode:number|null;signal:string|null;stdout:string;stderr:string}>{
  const timeoutSignal=AbortSignal.timeout(options.timeoutMs)
  const signal=options.signal?AbortSignal.any([options.signal,timeoutSignal]):timeoutSignal
  let child
  try{
    child=options.subprocess.spawn({
      argv:options.argv,cwd:options.cwd,
      stdio:{stdin:'ignore',stdout:{maxBytes:2_000_000},stderr:{maxBytes:1_000_000}},
      signal,graceMs:3000,
      env:{HF_ENDPOINT:'https://hf-mirror.com',PYTHONDONTWRITEBYTECODE:'1'},
    })
  }catch(error){
    throw new CadError('DWG_CONVERTER_UNRUNNABLE',
      `无法启动 ${options.label}（${options.argv[0]}）：${String(error)}`,{argv:options.argv})
  }
  const outcome=await child.done
  const stdout=child.collected.stdout?.readFrom(0).text??''
  const stderr=child.collected.stderr?.readFrom(0).text??''
  if(options.signal?.aborted)
    throw new CadError('DWG_CONVERT_CANCELLED',`调用方已取消 ${options.label}`,{argv:options.argv})
  if(timeoutSignal.aborted)
    throw new CadError('DWG_CONVERT_TIMEOUT',`${options.label} 超过 ${options.timeoutMs} ms 被终止`,{argv:options.argv,timeoutMs:options.timeoutMs})
  return {exitCode:outcome.exitCode,signal:outcome.signal,stdout,stderr}
}

async function probeVersion(subprocess:SubprocessRuntime,bin:string,signal?:AbortSignal):Promise<string|null>{
  try{
    const run=await runProcess({subprocess,argv:[bin,'--version'],cwd:dirname(bin)||'.',timeoutMs:15_000,signal,label:'版本探测'})
    const text=(run.stdout||run.stderr).trim().split('\n')[0]?.trim()
    return text?text.slice(0,120):null
  }catch{ return null }  // 版本探测失败不影响转换本身，只如实记 null
}

/**
 * 共用 operation：把 DWG 转成**新** DXF，检验通过之后才发布到 `output`。
 *
 * 原件保护三条（都不靠事后补救）：
 *  1. 转换**之前**就拒绝 `output==source` 及其文件别名（同路径 / realpath / dev+ino）；
 *  2. 转换只发生在本次自己的临时目录里，转换器根本看不到调用方的目标路径；
 *  3. 只有本次转换成功且检验通过才发布——先拷进目标目录的临时名，再顶替目标：
 *     `overwrite=true` 才用 rename（显式授权的原子替换），否则硬链接 / 独占创建，**一律不覆盖**。
 *     失败/取消/检验不过时，调用方原有的 `out` 一个字节都不动，只清理自己的暂存目录。
 * `verify:false` 是调用方显式放弃检验（照发不误）；转换损失的告警仍进 `losses`。
 */
export async function convertDwgToDxf(options:DwgConvertOptions):Promise<DwgConversion>{
  const overwrite=options.overwrite??false
  const timeoutMs=options.timeoutMs??DEFAULT_TIMEOUT_MS
  const target=resolve(options.output)
  const targetDir=dirname(target)
  // 子进程 cwd 必须是真实存在的目录；目标目录还没建时退到 tmpdir（传下去的文件都是绝对路径）
  const cwd=options.cwd?resolve(options.cwd):(existsSync(targetDir)?targetDir:tmpdir())
  const sniff=await sniffDrawingFile(options.file)
  if(sniff.kind!=='dwg')
    throw new CadError('DWG_INPUT_NOT_DWG',
      `输入不是 DWG（识别为 ${sniff.kind}：${sniff.evidence}）；转换只对 DWG 有意义，`+
      (sniff.kind==='dxf'?'DXF 直接用 cad_inspect/drawing_inspect 读':'请用 drawing_inspect 分流'),
      {path:options.file,detected:sniff.kind})
  await assertOutputDistinctFromSource(options.file,target)
  if(existsSync(target)&&!overwrite)
    throw new CadError('DWG_OUTPUT_EXISTS',
      `输出已存在，不覆盖别人的文件：${target}（确实要覆盖就显式 overwrite=true）`,{path:target})
  const before=await fileFacts(options.file)
  const converter=options.converter
  const version=await probeVersion(options.subprocess,converter.bin,options.signal)
  const warnings:string[]=[]
  // 自己的暂存目录：转换器的输出叫 <目标名>.dxf，但它落在暂存目录里，碰不到调用方的文件
  const staging=await mkdtemp(join(tmpdir(),'lyapunov-dwg-'))
  const staged=join(staging,`${basename(target,extname(target))||'converted'}.dxf`)
  const argv=converterArgv(converter,options.file,staged)
  let keepStaging=false
  try{
    if(options.signal?.aborted)
      throw new CadError('DWG_CONVERT_CANCELLED',`调用方已取消，未开始转换：${options.file}`,{path:options.file})
    const run=await runProcess({subprocess:options.subprocess,argv,cwd,timeoutMs,signal:options.signal,label:converter.label})
    const losses=parseConverterLosses(run.stderr)
    if(run.exitCode!==0||!existsSync(staged))
      throw new CadError('DWG_CONVERT_FAILED',
        `${converter.label} 转换失败（退出码 ${run.exitCode}，signal=${run.signal??'none'}）：`+
        (run.stderr.trim()||run.stdout.trim()).slice(-500),
        {path:options.file,argv,exitCode:run.exitCode,target})
    const stagedInfo=await stat(staged)
    if(stagedInfo.size===0)
      throw new CadError('DWG_CONVERT_FAILED',`转换器产出了空文件（${target} 未改动）`,{path:target,staged})
    // 源文件必须一模一样：变了就撤下本次暂存产物（绝不"默默改原件"，也绝不发布）
    const after=await fileFacts(options.file)
    if(after.sha256!==before.sha256||after.bytes!==before.bytes)
      throw new CadError('DWG_SOURCE_MODIFIED',
        `转换过程中源文件被改动（sha256 ${before.sha256.slice(0,12)} → ${after.sha256.slice(0,12)}），`+
        `本次暂存产物不发布，${target} 未改动`,
        {path:options.file,before:before.sha256,after:after.sha256,target})
    const outputSniff=await sniffDrawingFile(staged)
    const output={...await fileFacts(staged),format:{kind:'dxf' as const,binary:outputSniff.binaryDxf}}
    let verification:DwgConversion['verification']=null
    let dxf:CadReport|null=null
    if(options.verify!==false){
      if(!options.python)
        throw new CadError('CAD_PYTHON_UNCONFIGURED',
          '转换完成但没有配置 CAD 解释器，无法检验转出的 DXF：请在 config 给 python 或设置 LYAPUNOV_CAD_PYTHON',
          {script:options.script??null})
      try{
        dxf=await inspectDxf({
          subprocess:options.subprocess,python:options.python,
          script:options.script??fileURLToPath(CAD_SCRIPT_FALLBACK),file:staged,
          ...(options.maxItems!==undefined?{maxItems:options.maxItems}:{}),
          ...(cwd?{cwd}:{}),timeoutMs,
          ...(options.signal?{signal:options.signal}:{}),
        })
        verification={ok:true,engine:'ezdxf',error:null,entityCount:dxf.counts.modelspaceEntities??null,
          counts:dxf.counts,units:dxf.units}
      }catch(error){
        if(options.signal?.aborted)throw error   // 取消不是"读不出来"，照原样往上抛
        const cad=error instanceof CadError?error:null
        verification={ok:false,engine:'ezdxf',error:cad?`${cad.code}: ${cad.message}`:String(error),
          entityCount:null,counts:null,units:null}
      }
      if(!verification.ok){
        // 检验不过＝没验通过：不发布到调用方的目标，产物留在暂存目录里并如实报路径，不悄悄用掉 overwrite 授权
        keepStaging=true
        throw new CadError('DWG_CONVERTED_UNREADABLE',
          `转换完成但转出的 DXF 读不出来（ezdxf: ${verification.error}），按规矩不发布到 ${target}；`+
          `本次产物留在 ${staged}，需要的话自行取用`,
          {path:options.file,target,staged,verification})
      }
    }
    if(options.signal?.aborted)
      throw new CadError('DWG_CONVERT_CANCELLED',
        `调用方已取消，本次产物不发布，${target} 未改动`,{path:options.file,target})
    const published=await publishAtomically(staged,target,overwrite,options.publishLink)
    if(losses.losses.length)warnings.push('DWG_CONVERTER_LOSSES')
    // 硬链接不可用的文件系统上走了独占创建：发布仍然不覆盖，但如实说出来
    if(published==='exclusive-create')warnings.push('DWG_PUBLISH_EXCLUSIVE_CREATE')
    return {
      ok:true,
      source:{...before,kind:'dwg',dwgVersion:sniff.dwgVersion},
      converter:{kind:converter.kind,bin:converter.bin,label:converter.label,version,argv,
        exitCode:run.exitCode,signal:run.signal,stderrTail:run.stderr.trim().slice(-1000)},
      output:{...await fileFacts(target),format:output.format},
      sourceUnchanged:true,
      losses:losses.losses,
      lossCategories:losses.categories,
      verification,
      dxf,
      warnings,
    }
  }finally{
    // 只清理自己本次的暂存目录；检验不过时留着并在错误里写明路径
    if(!keepStaging)await rm(staging,{recursive:true,force:true})
  }
}

/** 避免循环引用：cad.ts 里的脚本 URL 常量在本模块再算一次同一条路径。 */
const CAD_SCRIPT_FALLBACK=new URL('../python/cad_inspect.py',import.meta.url)

export interface DrawingInspectOptions{
  subprocess:SubprocessRuntime
  file:string
  /** PDF 用的解释器（装了 pypdf）；DXF/DWG 检验用的解释器（装了 ezdxf）。同一个解释器即可。 */
  python?:string
  script?:string
  cadScript?:string
  cwd?:string
  unit?:string
  /** PDF 显式比例尺（1:100 或 100）：不给就没有米制换算。 */
  scale?:string
  /** 转换后的 DXF 写到哪（仅 DWG）。默认 <cwd>/cad-converted/<名字>-<源 sha 前 8>.dxf。 */
  out?:string
  overwrite?:boolean
  /** 是否导出扫描页图像（默认 true，需要 cwd 才能落盘）。 */
  images?:boolean
  imageDirectory?:string
  maxImages?:number
  maxItems?:number
  /** 最多分析多少页（默认全部）。小于总页数时报告只描述已分析的页（scope + PDF_CLASSIFICATION_PARTIAL）。 */
  maxPages?:number
  rasterizer?:'auto'|'gs'|'pdftocairo'|'none'
  rasterizationDpi?:number
  timeoutMs?:number
  signal?:AbortSignal
  converter?:ResolvedDwgConverter
}

export async function inspectPdf(options:{
  subprocess:SubprocessRuntime;file:string;python:string;script:string;cwd?:string
  scale?:string;imageDirectory?:string;maxImages?:number;maxItems?:number;maxPages?:number
  rasterizer?:string;dpi?:number;timeoutMs?:number;signal?:AbortSignal
}):Promise<PdfReport>{
  const argv=[options.python,options.script,'--input',options.file]
  if(options.scale)argv.push('--scale',options.scale)
  if(options.imageDirectory)argv.push('--image-dir',options.imageDirectory)
  if(options.maxImages!==undefined)argv.push('--max-images',String(options.maxImages))
  if(options.maxItems!==undefined)argv.push('--max-items',String(options.maxItems))
  // 页数上限：只分析前 N 页时报告会带 scope 与 PDF_CLASSIFICATION_PARTIAL（不把没读的页推断成同一种）
  if(options.maxPages!==undefined)argv.push('--max-pages',String(options.maxPages))
  if(options.rasterizer)argv.push('--rasterizer',options.rasterizer)
  if(options.dpi!==undefined)argv.push('--dpi',String(options.dpi))
  const timeoutMs=options.timeoutMs??DEFAULT_TIMEOUT_MS
  const timeoutSignal=AbortSignal.timeout(timeoutMs)
  const signal=options.signal?AbortSignal.any([options.signal,timeoutSignal]):timeoutSignal
  let child
  try{
    child=options.subprocess.spawn({
      argv,cwd:options.cwd??dirname(options.file),
      stdio:{stdin:'ignore',stdout:{maxBytes:16_000_000},stderr:{maxBytes:64_000}},
      signal,graceMs:3000,
      env:{HF_ENDPOINT:'https://hf-mirror.com',PYTHONDONTWRITEBYTECODE:'1'},
    })
  }catch(error){
    throw new CadError('DRAWING_PYTHON_UNAVAILABLE',`无法启动 PDF 解析器（${options.python}）：${String(error)}`,{interpreter:options.python})
  }
  const outcome=await child.done
  const stdout=child.collected.stdout?.readFrom(0).text??''
  const stderr=child.collected.stderr?.readFrom(0).text??''
  if(options.signal?.aborted)throw new CadError('DRAWING_CANCELLED','调用方已取消 PDF 读取',{path:options.file})
  if(timeoutSignal.aborted)throw new CadError('DRAWING_TIMEOUT',`读取 PDF 超过 ${timeoutMs} ms 被终止：${options.file}`,{path:options.file,timeoutMs})
  const lines=stdout.split('\n')
  const errorLine=lines.slice().reverse().find(line=>line.startsWith(DRAWING_ERROR_PREFIX))
  const resultLine=lines.slice().reverse().find(line=>line.startsWith(DRAWING_RESULT_PREFIX))
  if(outcome.exitCode!==0){
    if(errorLine)throw drawingErrorFromEnvelope(errorLine.slice(DRAWING_ERROR_PREFIX.length),options.file)
    throw new CadError('DRAWING_INSPECT_FAILED',
      `PDF 解析器退出码 ${outcome.exitCode}（signal=${outcome.signal??'none'}）：${(stderr||stdout).slice(-800)}`,
      {path:options.file,exitCode:outcome.exitCode,interpreter:options.python})
  }
  if(!resultLine)throw new CadError('DRAWING_OUTPUT_MISSING',`解析器成功退出但没有结果行：${(stdout||stderr).slice(-800)}`,{path:options.file})
  let parsed:unknown
  try{ parsed=JSON.parse(resultLine.slice(DRAWING_RESULT_PREFIX.length)) }
  catch(error){ throw new CadError('DRAWING_OUTPUT_UNREADABLE',`结果行不是合法 JSON：${String(error)}`,{path:options.file}) }
  return assertPdfReport(parsed,options.file)
}

function drawingErrorFromEnvelope(payload:string,file:string):CadError{
  try{
    const envelope=JSON.parse(payload) as {error?:{code?:string;message?:string}}
    const error=envelope?.error
    if(error&&typeof error.code==='string')return new CadError(error.code,String(error.message??''),{path:file,...error})
  }catch{/* 载荷不可读：退到通用失败，不编造 code */}
  return new CadError('DRAWING_INSPECT_FAILED',`解析器报错但错误载荷不可读：${payload.slice(0,300)}`,{path:file})
}

/** PDF 报告契约校验：缺关键结构一律当失败，不把半份报告交给下游建模。 */
export function assertPdfReport(value:unknown,file:string):PdfReport{
  const report=value as Partial<PdfReport>|null
  if(!report||typeof report!=='object'||report.ok!==true
    ||typeof report.classification!=='string'||!Array.isArray(report.pages)||!Array.isArray(report.warnings)
    ||typeof report.units!=='object'||report.units===null||typeof report.units.metresKnown!=='boolean'
    ||typeof report.vector!=='object'||report.vector===null||typeof report.vector.pathCount!=='number'
    ||typeof report.text!=='object'||report.text===null||typeof report.text.charCount!=='number'
    ||typeof report.counts!=='object'||report.counts===null)
    throw new CadError('DRAWING_OUTPUT_INVALID','PDF 解析器返回的报告结构不符合约定（缺 classification/pages/units/vector/text/counts）',{path:file})
  return report as PdfReport
}

/**
 * 把报告里的**真实读数**折成三维约束与缺项假设（ENV-13）：
 *  · 约束只从解析器真读出来的字段来（DXF 的 `bounds.sizeMetres`、PDF 的页尺寸/显示盒/矢量化 bbox），
 *    每条带 `source`（点分字段路径）与 `pageRef`，可以逐条回查；`value` 是该轴的范围长度，不是原点值。
 *  · 单位没声明就没有米制条目——缺的是"单位声明"这个事实，写成 `UNIT_UNDECLARED` 假设，
 *    不把图纸单位或纸面毫米当建筑米（调用方显式给 unit/scale 后这条假设不再出现）。
 *  · 标高/层高/厚度这三类事实报告里根本没有，逐条写成假设并给 why，不拿范围长度或纸张高度顶替。
 */
function withDrawingDatum(report:Omit<DrawingReport,'constraints'|'assumptions'|'constraintsDigest'|'openings'|'openingSkips'|'openingsDigest'|'factsDigest'>):DrawingReport{
  const constraints:DrawingConstraint[]=[]
  const assumptions:DrawingAssumption[]=[]
  const dxf=report.dxf
  if(dxf){
    const sizeMetres=dxf.bounds?.sizeMetres??null
    if(dxf.units?.known===true&&Array.isArray(sizeMetres))
      DRAWING_CONSTRAINT_AXES.forEach((axis,index)=>{
        const value=sizeMetres[index]
        if(typeof value==='number')
          constraints.push({axis,value,unit:'m',source:`dxf.bounds.sizeMetres[${index}]`,pageRef:0})
      })
    else
      assumptions.push({code:'UNIT_UNDECLARED',
        detail:'图纸没有可用的单位声明：本次没有产出任何米制约束',
        why:`报告里 units.known=${String(dxf.units?.known)}、`
          +`units.metresPerUnit=${JSON.stringify(dxf.units?.metresPerUnit??null)}、`
          +`bounds.sizeMetres=${JSON.stringify(sizeMetres)}；只有图纸单位读数，缺"单位声明"这个事实，`
          +'所以不给米制数值（调用方用 unit 显式声明单位后这条不再出现）'})
  }
  const pdf=report.pdf
  if(pdf){
    for(const page of pdf.pages.slice(0,DRAWING_CONSTRAINT_PAGES)){
      const size=page.size
      if(!size)continue
      constraints.push({axis:'x',value:size.widthMm,unit:'mm',
        source:`pdf.pages[${page.index}].size.widthMm`,pageRef:page.index})
      constraints.push({axis:'y',value:size.heightMm,unit:'mm',
        source:`pdf.pages[${page.index}].size.heightMm`,pageRef:page.index})
    }
    const display=pdf.pages.find(page=>page.size!==null)
    const box=display?(display.cropBox??display.mediaBox):null
    if(display&&Array.isArray(box)&&box.length>=4){
      const [x0,y0,x1,y1]=box
      const field=display.cropBox?'cropBox':'mediaBox'
      if(typeof x0==='number'&&typeof x1==='number')
        constraints.push({axis:'x',value:x1-x0,unit:'pt',
          source:`pdf.pages[${display.index}].${field}`,pageRef:display.index})
      if(typeof y0==='number'&&typeof y1==='number')
        constraints.push({axis:'y',value:y1-y0,unit:'pt',
          source:`pdf.pages[${display.index}].${field}`,pageRef:display.index})
    }
    const bbox=pdf.vector.bboxMetresByCallerScale
    if(pdf.units.metresKnown===true&&Array.isArray(bbox)&&bbox.length>=4){
      // bboxMetresByCallerScale 是 [minX,minY,maxX,maxY]（页面坐标按调用方比例尺折算），取范围长度
      const pageRef=display?.index??0
      constraints.push({axis:'x',value:bbox[2]!-bbox[0]!,unit:'m',
        source:'pdf.vector.bboxMetresByCallerScale',pageRef})
      constraints.push({axis:'y',value:bbox[3]!-bbox[1]!,unit:'m',
        source:'pdf.vector.bboxMetresByCallerScale',pageRef})
    }
    if(pdf.units.metresKnown!==true)
      assumptions.push({code:'UNIT_UNDECLARED',
        detail:'图纸没有比例尺声明：本次没有产出任何建筑米制约束，只给纸面毫米/点',
        why:`报告里 units.metresKnown=${String(pdf.units.metresKnown)}、`
          +`units.metresSource=${JSON.stringify(pdf.units.metresSource)}、`
          +'vector.bboxMetresByCallerScale=null；缺"比例尺"这个事实，'
          +'所以纸面尺寸照给、建筑尺寸不给（调用方用 scale 显式声明比例尺后这条不再出现）'})
  }
  assumptions.push(
    {code:'NO_ELEVATION',
      detail:'没有标高事实：本次不产出任何标高值',
      why:dxf?'报告里只有平面坐标与几何范围（bounds.sizeMetres 的 z 是范围长度，不是楼层标高）；'
          +'标高需要标高标注/标高图层或调用方显式声明'
        :'PDF 侧只解析页面坐标、页面尺寸与路径 bbox，没有任何标高字段；'
          +'标高需要标高标注/标高图层或调用方显式声明'},
    {code:'NO_STOREY_HEIGHT',
      detail:'没有层高事实：不把纸张高度或图面范围当层高',
      why:dxf?'bounds.sizeMetres[1] 是图面 y 向范围，不是建筑层高；层高需要立面/剖面或显式声明'
        :'pdf.pages[].size.heightMm 是纸张高度，不是建筑层高；层高需要立面/剖面或显式声明'},
    {code:'NO_THICKNESS',
      detail:'没有墙/板厚度事实：本次不产出任何厚度值',
      why:'解析出来的只有线段/多段线/圆弧与文字（dxf.curves、pdf.vector.paths），'
        +'没有成对边界线也没有厚度语义；厚度需要构造做法或调用方显式声明'},
  )
  const {openings,skips:openingSkips}=openingFactsOf(dxf)
  if(dxf&&(dxf.units?.known===true)===false&&openings.length===0)
    assumptions.push({code:'UNIT_UNDECLARED',
      detail:'没有单位声明：本次没有产出任何米制开口（开口需按米折算）',
      why:'开口的跨度是米制事实，与米制约束同一口径：只有 units.known=true 时才折算；'
        +'报告里 units.known=false、units.metresPerUnit=null，缺"单位声明"这个事实'})
  return {...report,constraints,constraintsDigest:constraintsDigest(constraints),
    openings,openingSkips,openingsDigest:openingsDigest(openings),
    factsDigest:factsDigest(constraints,openings),assumptions}
}

/**
 * 开口的**稳定产物**（ENV-14 第二桶）：与 `constraintsDigest` 同口径（规范化排序 + 逐字段固定顺序 + sha256）。
 * 有 `originM` 的条目把最小角也带进摘要（尺寸不变只在层内平移也算变更）；没有该字段的条目不追加任何东西。
 */
export function openingsDigest(openings:readonly DrawingOpening[]):string{
  const lines=openings
    .map(item=>[item.kind,item.layerName,item.axis,canonicalNumber(item.spanM),String(item.count),item.sourceRef,
      ...(item.originM?item.originM.map(canonicalNumber):[])].join('|'))
    .sort()
  return createHash('sha256').update(`ENV14-OPENINGS/1\n${lines.join('\n')}\n`).digest('hex')
}

/**
 * 尺寸 + 开口进**同一份**摘要（ENV-14）：任何一类事实变化摘要必变——所以它能当"已确认事实，之后没被动过"的凭据。
 * 两类事实各自带命名空间前缀，避免"尺寸行恰好等于开口行"这类跨类碰撞。开口条目与其单桶摘要**同一套字段**。
 */
export function factsDigest(
  constraints:readonly DrawingConstraint[],openings:readonly DrawingOpening[],
):string{
  const dimensionLines=constraints
    .map(item=>['D',item.axis,item.unit,canonicalNumber(item.value),item.source,String(item.pageRef)].join('|')).sort()
  const openingLines=openings
    .map(item=>['O',item.kind,item.layerName,item.axis,canonicalNumber(item.spanM),String(item.count),item.sourceRef,
      ...(item.originM?item.originM.map(canonicalNumber):[])].join('|')).sort()
  return createHash('sha256').update(`ENV14-FACTS/1\n${[...dimensionLines,...openingLines].join('\n')}\n`).digest('hex')
}

/** "连接"为什么在 CAD 侧不承载（ENV-14 第三类事实：明文不承载，不填 0）。 */
export const DRAWING_CONNECTIONS_UNAVAILABLE_WHY=
  'CAD 侧没有构件拓扑：解析出来的只有几何（线段/多段线/圆弧）与图层名，'
  +'没有"哪个开口连到哪个房间/构件"的关系数据，也没有房间/构件标识；'
  +'连接事实应由 Scene 侧（实体/资源引用）或地图侧（map-constraints）承担，本工具不产出、也不填 0。'

function openingKey(item:DrawingOpening):string{
  return [item.kind,item.layerName,item.axis,item.sourceRef].join('|')
}

/** 同一条开口的"位置"是否一致：只在两侧都带 `originM` 时可比；只有一侧带 ⇒ 视为变了（事实缺项不冒充当未变）。 */
function sameOrigin(before:DrawingOpening,after:DrawingOpening):boolean{
  const left=before.originM??null,right=after.originM??null
  if(left===null&&right===null)return true
  if(left===null||right===null)return false
  return left.length===right.length&&left.every((value,index)=>value===right[index])
}

/** 开口的变更前后比对：与 `compareConstraints` 同一套分桶语义（逐条逐值，不拿总数冒充）。 */
export function compareOpenings(
  before:readonly DrawingOpening[],after:readonly DrawingOpening[],
):OpeningComparison{
  const equal:DrawingOpening[]=[]
  const changed:Array<{before:DrawingOpening;after:DrawingOpening}>=[]
  const added:DrawingOpening[]=[]
  const removed:DrawingOpening[]=[]
  const buckets=new Map<string,DrawingOpening[]>()
  for(const item of before){
    const key=openingKey(item)
    const list=buckets.get(key)
    if(list)list.push(item)
    else buckets.set(key,[item])
  }
  for(const item of after){
    const key=openingKey(item)
    const list=buckets.get(key)
    const match=list?.shift()
    if(!match){added.push(item);continue}
    if(match.spanM===item.spanM&&match.count===item.count&&sameOrigin(match,item))equal.push(item)
    else changed.push({before:match,after:item})
  }
  for(const list of buckets.values())removed.push(...list)
  const digestBefore=openingsDigest(before)
  const digestAfter=openingsDigest(after)
  return {
    unchanged:digestBefore===digestAfter&&changed.length===0&&removed.length===0&&added.length===0,
    digestBefore,digestAfter,equal,changed,removed,added,
  }
}

/**
 * 两类事实（尺寸 + 开口）的**同一份**判定（ENV-14）：`unchanged` 要求两桶都未变**且**合并摘要逐字相同，
 * **且两侧事实完整**：任一侧有开口层的逐实体明细被截断（或**没给** `openingSkips` ⇒ 不知道读全没有）时，
 * 窗口外的实体根本不在事实里，摘要再相同也**不能**断言"未变"（否则改第 513 条会漏报）。
 * 第三参数可按侧显式声明完整性（例如调用方声明的基线侧确实完整）；不给则看该侧 `openingSkips`。
 * "连接"在此处是**明文不承载**（`connections:null` + why），不参与 unchanged 计算（没有承载就不能假装"未变"）。
 */
export function compareFacts(
  before:DrawingFactSide,
  after:DrawingFactSide,
  completeness:{before?:boolean;after?:boolean}={},
):FactsComparison{
  const dimensions=compareConstraints(before.constraints,after.constraints)
  const openings=compareOpenings(before.openings,after.openings)
  const factsDigestBefore=factsDigest(before.constraints,before.openings)
  const factsDigestAfter=factsDigest(after.constraints,after.openings)
  const factsComplete=(completeness.before??factsCompleteOfSide(before))&&(completeness.after??factsCompleteOfSide(after))
  return {
    unchanged:factsComplete&&dimensions.unchanged&&openings.unchanged&&factsDigestBefore===factsDigestAfter,
    factsComplete,
    factsDigestBefore,factsDigestAfter,dimensions,openings,
    connections:null,connectionsWhy:DRAWING_CONNECTIONS_UNAVAILABLE_WHY,
  }
}

/**
 * 从**真实解析结果**折算开口（ENV-14）：按图层名判定种类，**逐条建模实体**各成一条开口，
 * 跨度取**该实体自身**包围盒较长的一边，用报告自己的 `units.metresPerUnit` 折成米。
 * 单位未声明时不产出米制开口（与 constraints 同一口径）。
 * 空图层与跨度为 0 的退化几何**不写进开口事实**（它们不是"0 m 的开口"，写进去会让 factsDigest 随退化输入变），
 * 但会被记进 `openingSkips` 并写明理由——报告里不允许"整层消失且不给理由"。
 */
function openingFactsOf(dxf:CadReport|null):{openings:DrawingOpening[];skips:DrawingOpeningSkip[]}{
  const empty={openings:[],skips:[]}
  if(!dxf)return empty
  const factor=dxf.units?.known===true?(dxf.units.metresPerUnit??null):null
  if(typeof factor!=='number'||!Number.isFinite(factor))return empty
  const rows=(dxf as CadReport & {layerBounds?:Array<{
    layer:string;entityCount:number;bounds?:{min:number[];max:number[]}|null;sizes?:number[][];origins?:number[][];
    sizesTruncated?:boolean}>}).layerBounds
  if(!Array.isArray(rows))return empty
  const openings:DrawingOpening[]=[]
  const skips:DrawingOpeningSkip[]=[]
  for(const [index,row] of rows.entries()){
    const kind=DRAWING_OPENING_LAYER_WORDS.find(entry=>entry.words.some(word=>String(row.layer).toLowerCase().includes(word)))?.kind
    if(!kind)continue
    const layer=String(row.layer)
    const entityCount=Number(row.entityCount)||0
    const sizes=Array.isArray(row.sizes)?row.sizes:[]
    const origins=Array.isArray(row.origins)?row.origins:[]
    if(sizes.length===0){
      skips.push({layerName:layer,reason:'OPENING_LAYER_EMPTY_IGNORED',entityCount,
        detail:entityCount===0
          ?'该图层没有任何建模实体：本次没有可折算的开口（不等于"开口跨度为 0"）'
          :`该层有 ${entityCount} 条建模实体，但没有一条给出可用包围盒（解析报告未给 sizes 或逐条求界失败）：不折算开口`,
        sourceRef:`dxf.layerBounds[${index}]`})
      continue
    }
    let degenerate=0
    for(const [slot,size] of sizes.entries()){
      const width=Math.abs(Number(size?.[0])||0),height=Math.abs(Number(size?.[1])||0)
      const axis=width>=height?'x':'y'
      const span=(axis==='x'?width:height)*factor
      if(!Number.isFinite(span)||span<=0){degenerate+=1;continue}
      const origin=origins[slot]
      const originM=Array.isArray(origin)&&origin.length>=2
        ?[Number((Number(origin[0])*factor).toFixed(6)),Number((Number(origin[1])*factor).toFixed(6))]
        :null
      const entry:DrawingOpening={kind,layerName:layer,axis,spanM:Number(span.toFixed(6)),count:1,
        sourceRef:`dxf.layerBounds[${index}].sizes[${slot}]`}
      // 只在报告真的给了 origins 时带上（不给就不编造 0）：平移检测靠它，缺它是"事实缺项"而不是 0。
      if(originM&&originM.every(value=>Number.isFinite(value)))entry.originM=originM
      openings.push(entry)
    }
    if(degenerate>0)
      skips.push({layerName:layer,reason:'OPENING_LAYER_DEGENERATE',entityCount:degenerate,
        detail:`该层 ${degenerate} 条建模实体的包围盒跨度为 0（零长度/退化几何）：不写成开口、也不进 factsDigest`,
        sourceRef:`dxf.layerBounds[${index}].sizes`})
    // 逐实体明细被截断：第 sizes.length+1 条起的实体**根本不在这份事实里** ⇒ 必须留痕，
    // 否则"窗口外改动"会以 `unchanged:true` 静默通过（factsComplete 也据此为 false）。
    if(row.sizesTruncated===true)
      skips.push({layerName:layer,reason:'OPENING_LAYER_SIZES_TRUNCATED',entityCount,
        detail:`该层 ${entityCount} 条建模实体里只列了前 ${sizes.length} 条（报告 sizesTruncated=true）：`
          +'其余实体不在 openings/factsDigest 里，本层事实不完整——"未变"不能据此断言（需提高 max_items 或拆层）',
        sourceRef:`dxf.layerBounds[${index}].sizes`})
  }
  return {openings,skips}
}

/** 开口事实（ENV-14）：逐实体折算，见 `openingFactsOf`。 */
export function openingsOf(report:Pick<DrawingReport,'dxf'>):DrawingOpening[]{
  return openingFactsOf(report.dxf).openings
}

/** 开口层里读不出开口的显式理由（空图层/0 m 退化）：与 `openingsOf` 同一次判定，不静默省略。 */
export function openingSkipsOf(report:Pick<DrawingReport,'dxf'>):DrawingOpeningSkip[]{
  return openingFactsOf(report.dxf).skips
}

/** 一个约束条目的身份：同一张图的同一处尺寸（轴/单位/来源字段/来源页）。值变了但身份不变 = 尺寸被改。 */
function constraintKey(item:DrawingConstraint):string{
  return [item.axis,item.unit,item.source,String(item.pageRef)].join('|')
}

/** 数值的规范写法：-0 归一成 0，其余用最短往返表示（同一输入必得同一串，不同值必得不同串）。 */
function canonicalNumber(value:number):string{
  return String(value===0?0:value)
}

/**
 * 已确认尺寸的**稳定产物**（ENV-14）：把 `constraints[]` 规范化（按条目排序、逐字段固定顺序）后取 sha256。
 * 同一次解析必得同一摘要；任何一处数值/单位/来源/页变化摘要必变——所以它能当"已确认，之后没被动过"的凭据。
 */
export function constraintsDigest(constraints:readonly DrawingConstraint[]):string{
  const lines=constraints
    .map(item=>[item.axis,item.unit,canonicalNumber(item.value),item.source,String(item.pageRef)].join('|'))
    .sort()
  return createHash('sha256').update(`ENV14-CONSTRAINTS/1\n${lines.join('\n')}\n`).digest('hex')
}

/**
 * 变更前后比对（ENV-14 的判定）：**逐条逐值**比，不拿"总数一样"冒充"没变"。
 * `unchanged` 要求等值桶外的三个桶（changed/removed/added）都为空且两侧摘要相同。
 */
export function compareConstraints(
  before:readonly DrawingConstraint[],after:readonly DrawingConstraint[],
):ConstraintComparison{
  const equal:DrawingConstraint[]=[]
  const changed:Array<{before:DrawingConstraint;after:DrawingConstraint}>=[]
  const added:DrawingConstraint[]=[]
  const removed:DrawingConstraint[]=[]
  // 按身份分桶：同一条（轴/单位/来源/页）在新读数里找同身份的条目，找到就逐值比；找不到就是丢了。
  const buckets=new Map<string,DrawingConstraint[]>()
  for(const item of before){
    const key=constraintKey(item)
    const list=buckets.get(key)
    if(list)list.push(item)
    else buckets.set(key,[item])
  }
  for(const item of after){
    const key=constraintKey(item)
    const list=buckets.get(key)
    const match=list?.shift()
    if(!match){ added.push(item); continue }
    if(match.value===item.value)equal.push(item)
    else changed.push({before:match,after:item})
  }
  for(const list of buckets.values())removed.push(...list)
  const digestBefore=constraintsDigest(before)
  const digestAfter=constraintsDigest(after)
  return {
    unchanged:digestBefore===digestAfter&&changed.length===0&&removed.length===0&&added.length===0,
    digestBefore,digestAfter,equal,changed,removed,added,
  }
}

/**
 * 共用 operation：按**文件头**分流后读取图纸。DXF 复用 `inspectDxf`；DWG 先转再读（复用 convertDwgToDxf）；
 * PDF 交给隔离 Python。任何一条通道失败都抛 {@link CadError}（含稳定 code），不返回半份结果。
 */
export async function inspectDrawing(options:DrawingInspectOptions):Promise<DrawingReport>{
  const sniff=await sniffDrawingFile(options.file)
  const cwd=options.cwd?resolve(options.cwd):dirname(options.file)
  const file=await fileFacts(options.file)
  if(sniff.kind==='image')
    throw new CadError('DRAWING_KIND_IMAGE',
      `这是位图图纸（${sniff.imageFormat}），不是矢量图纸：本工具不解析像素。`+
      '把图片作为附件交给模型读图（或在对话里贴图），需要矢量数据请提供 DXF/DWG/矢量 PDF',
      {path:options.file,imageFormat:sniff.imageFormat})
  if(sniff.kind==='unknown')
    throw new CadError('DRAWING_FORMAT_UNKNOWN',
      `认不出这个文件是什么格式（文件头 ${sniff.headHex}）：支持 DWG / DXF / PDF / 位图；`+
      '改名不会改变格式判定，请确认文件来源',{path:options.file,headHex:sniff.headHex})
  if(sniff.kind==='dxf'){
    const python=options.python
    if(!python)
      throw new CadError('CAD_PYTHON_UNCONFIGURED',
        '没有配置 CAD 解释器（装 ezdxf）：请在 config 给 python 或设置 LYAPUNOV_CAD_PYTHON',{path:options.file})
    const dxf=await inspectDxf({subprocess:options.subprocess,python,
      script:options.cadScript??fileURLToPath(CAD_SCRIPT_FALLBACK),file:options.file,
      ...(options.unit?{unit:options.unit}:{}),
      ...(options.maxItems!==undefined?{maxItems:options.maxItems}:{}),
      ...(options.cwd?{cwd:resolve(options.cwd)}:{}),
      ...(options.timeoutMs!==undefined?{timeoutMs:options.timeoutMs}:{}),
      ...(options.signal?{signal:options.signal}:{})})
    return withDrawingDatum({ok:true,kind:'dxf',file,format:sniff,dxf,conversion:null,pdf:null,warnings:dxf.warnings})
  }
  if(sniff.kind==='dwg'){
    const converter=options.converter
    if(!converter)
      throw new CadError('DWG_CONVERTER_UNCONFIGURED',converterHint(),{path:options.file})
    const output=options.out??defaultConvertedPath(cwd,options.file,file.sha256)
    const conversion=await convertDwgToDxf({
      subprocess:options.subprocess,file:options.file,output,
      overwrite:options.overwrite??options.out===undefined,
      converter,python:options.python,script:options.cadScript,
      ...(options.maxItems!==undefined?{maxItems:options.maxItems}:{}),
      cwd,...(options.signal?{signal:options.signal}:{}),
      ...(options.timeoutMs!==undefined?{timeoutMs:options.timeoutMs}:{}),
    })
    // 检验不过时 convertDwgToDxf 自己就会抛 DWG_CONVERTED_UNREADABLE 且**不发布**产物，
    // 这里拿到的 conversion 一定是检验通过的（verify 默认开），无需再判一次
    return withDrawingDatum({ok:true,kind:'dwg',file,format:sniff,dxf:conversion.dxf,conversion,pdf:null,
      warnings:[...conversion.warnings,...(conversion.dxf?.warnings??[])]})
  }
  // PDF
  const python=options.python
  if(!python)
    throw new CadError('CAD_PYTHON_UNCONFIGURED',
      '没有配置绘图解释器（装 pypdf/pillow）：请在 config 给 python 或设置 LYAPUNOV_CAD_PYTHON',{path:options.file})
  const script=options.script??fileURLToPath(DRAWING_SCRIPT_URL)
  const images=options.images!==false
  const imageDirectory=images?resolveImageDirectory(options.imageDirectory,cwd,options.file):undefined
  if(imageDirectory){
    try{ await mkdir(imageDirectory,{recursive:true}) }
    catch(error){
      throw new CadError('DRAWING_IMAGE_DIR_UNWRITABLE',
        `扫描页图像目录建不出来：${imageDirectory}（${String(error)}）；给一个可写的 image_directory 或关掉 images`,
        {path:options.file,imageDirectory})
    }
  }
  const pdf=await inspectPdf({
    subprocess:options.subprocess,file:options.file,python,script,
    cwd,...(options.scale?{scale:options.scale}:{}),
    ...(imageDirectory?{imageDirectory}:{}),
    maxImages:options.maxImages??DRAWING_MAX_IMAGES,
    ...(options.maxPages!==undefined?{maxPages:options.maxPages}:{}),
    ...(options.maxItems!==undefined?{maxItems:options.maxItems}:{}),
    ...(options.rasterizer?{rasterizer:options.rasterizer}:{}),
    ...(options.rasterizationDpi!==undefined?{dpi:options.rasterizationDpi}:{}),
    ...(options.timeoutMs!==undefined?{timeoutMs:options.timeoutMs}:{}),
    ...(options.signal?{signal:options.signal}:{}),
  })
  return withDrawingDatum({ok:true,kind:'pdf',file,format:sniff,dxf:null,conversion:null,pdf,warnings:pdf.warnings})
}

/** DWG 自动转换的落点：按源文件 sha256 派生，同名同源可复用，不会踩到别人的文件。 */
export function defaultConvertedPath(cwd:string,file:string,sha:string):string{
  const stem=basename(file,extname(file))
  return join(cwd,'cad-converted',`${stem}-${sha.slice(0,8)}.dxf`)
}

function resolveImageDirectory(configured:string|undefined,cwd:string,file:string):string{
  if(configured)return isAbsolute(configured)?configured:resolve(cwd,configured)
  const stem=basename(file,extname(file))
  return join(cwd,'drawing-images',stem)
}

function drawingFileSummary(report:DrawingReport,limit:number):Record<string,unknown>{
  const base={ok:true,kind:report.kind,file:report.file,
    // 约束与假设是三条通道共有的事实：放顶层，模型读文本就能看到，不必翻 pdf/dxf 子对象
    constraints:report.constraints,constraintsDigest:report.constraintsDigest,
    openings:report.openings,openingsDigest:report.openingsDigest,factsDigest:report.factsDigest,
    openingSkips:report.openingSkips,
    connections:null,connectionsWhy:DRAWING_CONNECTIONS_UNAVAILABLE_WHY,assumptions:report.assumptions,
    format:{kind:report.format.kind,evidence:report.format.evidence,dwgVersion:report.format.dwgVersion}}
  if(report.kind==='pdf'&&report.pdf){
    const pdf=report.pdf
    return {
      ...base,
      pdf:{
        classification:pdf.classification,
        scope:pdf.scope,
        format:pdf.format,
        counts:pdf.counts,
        units:pdf.units,
        pages:pdf.pages.slice(0,8).map(page=>({
          index:page.index,classification:page.classification,size:page.size,
          content:{pathConstructOps:page.content.pathConstructOps,textShowOps:page.content.textShowOps,
            imagesDrawn:page.content.imagesDrawn,imageCoverage:page.content.imageCoverage},
          text:{chars:page.text.chars,sample:page.text.sample},
          images:page.images,
          errors:page.errors,
        })),
        vector:{pathCount:pdf.vector.pathCount,pathsListed:pdf.vector.pathsListed,byPaint:pdf.vector.byPaint,
          bboxPagePoints:pdf.vector.bboxPagePoints,bboxPageMm:pdf.vector.bboxPageMm,
          bboxMetresByCallerScale:pdf.vector.bboxMetresByCallerScale,
          paths:pdf.vector.paths.slice(0,limit)},
        text:{charCount:pdf.text.charCount,itemCount:pdf.text.itemCount,itemsListed:pdf.text.itemsListed,
          items:pdf.text.items.slice(0,limit),pagesWithText:pdf.text.pagesWithText,note:pdf.text.note},
        images:{exported:pdf.images.exported,failures:pdf.images.failures,requestedPages:pdf.images.requestedPages,
          note:pdf.images.note},
        warnings:pdf.warnings,truncated:pdf.truncated,
      },
      summary:{itemsPerList:limit,note:'PDF 事实全在 report 里；这里是有界摘要。'+
        '页面单位是 1/72 英寸的图纸单位，metresKnown=false 时没有米制换算（不把 point 当米）。'+
        'constraints 只由真读出来的字段折算（metresKnown=false 时没有米制条目），'+
        '缺的标高/层高/厚度在 assumptions 里逐条声明。'+
        'scale.pagesAnalyzed < 总页数时 classification 只覆盖已分析的页（看 scope，别外推到没读过的页）。'},
    }
  }
  const dxf=report.dxf
  const dxfSummary=dxf?summarizeCadReport(dxf,limit):null
  return {
    ...base,
    conversion:report.conversion?{
      converter:report.conversion.converter,
      output:report.conversion.output,
      sourceUnchanged:report.conversion.sourceUnchanged,
      losses:report.conversion.losses,
      lossCategories:report.conversion.lossCategories,
      verification:report.conversion.verification,
    }:null,
    dxf:dxfSummary,
    summary:{itemsPerList:limit,note:'转换事实与 DXF 读取事实都是同一份 report 的投影；完整明细在 report 字段。'+
      'constraints 只由真读出来的字段折算（units.known=false 时没有任何米制条目），'+
      '缺的标高/层高/厚度在 assumptions 里逐条声明。'},
  }
}

/**
 * 薄注册：把 `drawing_inspect` 与 `cad_convert` 交给原生 tools 注册表。
 * 调用方（下层插件）在 `apply` 里调用，并自行声明 inject 含 `tools` 与 `subprocess`。
 * `attachments` 不进 inject：它是可选增强（把扫描页图像带进模型上下文），运行时 `ctx.get` 判空。
 * 相对路径按**会话任务工作区**解析（config.workspace 兜底），不落产品根。
 * @returns 注销函数（插件卸载时调用）。
 */
export function registerDrawingTools(ctx:Context,config:DrawingConfig={}){
  const subprocess=ctx.get('subprocess')
  // 扫描页图像：execute 里同步附件化，render 里按结果文本取回（与 blender 插件同一条通路）。
  const attachmentsByResult=new Map<string,unknown[]>()
  const getAttachments=()=>ctx.get('attachments') as
    {saveImage(input:{data:Uint8Array;mediaType:'image/png';name:string}):Promise<unknown>}|undefined

  const disposeInspect=ctx.tools.register(defineTool({
    name:'drawing_inspect',
    description:'Route drawings by **file header**. DXF: parse actual units/layers/blocks/curves/dimensions with ezdxf. DWG: use an external converter (LibreDWG dwg2dxf or a custom command template) to create a new DXF, leaving the source unchanged and publishing only after validation, then read it with ezdxf; report conversion losses and validation results. Vector PDF: return actual path operators including CTM transforms, text/coordinates, and page dimensions. **Page units are drawing points of 1/72 inch, not architectural metres**; metric output requires an explicit scale. Scanned/mixed PDF: export embedded images as PNG and deliver them as images in context. Pages with /Rotate or CropBox prefer a **full-page preview rasterized as displayed**, because original pixels may omit rotation/cropping; disclose this in the receipt. Bitmap drawings are routed to model image reading; this tool does not parse their pixels. DXF layerBounds contains **one row per layer**, including empty layers with entityCount:0 and bounds:null. It reports per-modelling-entity 2D sizes and minimum-corner origins. Downstream derives doors/windows/passages **per entity** using layer names; multiple openings in one layer are not merged, and dimensions/positions both become facts. Record empty layers and zero-metre degenerate geometry in openingSkips with reasons.',
    parameters:{
      path:{type:'string',required:true,description:'Drawing file (DWG/DXF/PDF), absolute or relative to the current session task workspace.'},
      unit:{type:'string',description:'Optional for DXF: explicit caller unit when the file declares no units; recorded as units.source="caller".'},
      scale:{type:'string',description:'Optional for PDF: explicit scale, such as "1:100" or "100". Without it, metresKnown=false and no metric dimensions are reported.'},
      out:{type:'string',description:'Optional for DWG: destination of the newly converted DXF; defaults to <workspace>/cad-converted/<name>-<source-sha8>.dxf.'},
      images:{type:'boolean',description:'Optional for PDF: export scanned-page images as image attachments; defaults to true.'},
      image_directory:{type:'string',description:'Optional for PDF: directory for scanned-page PNGs; defaults to <workspace>/drawing-images/<drawing-name>.'},
      max_images:{type:'integer',description:'Optional maximum scanned-page images added to context; defaults to 4.'},
      max_items:{type:'integer',description:'Optional maximum detail-list items; counts are unaffected.'},
      max_pages:{type:'integer',description:'Optional for PDF: maximum pages to analyze; defaults to all. When below the page count, report scope (pagesTotal/pagesAnalyzed) and PDF_CLASSIFICATION_PARTIAL. Classification covers only analyzed pages and does not infer unread pages.'},
      detail:{type:'string',enum:DRAWING_DETAILS,description:'Presentation detail for result: summary (default, bounded) or full (raw report JSON).'},
    },
    output:{
      schema:{type:'object',additionalProperties:false,properties:{result:{type:'string',required:true},report:{type:'json',required:true}}},
      render:(_args,value)=>{
        const blocks:ContentBlock[]=[{type:'text',text:value.result}]
        const refs=attachmentsByResult.get(value.result)
        attachmentsByResult.delete(value.result)
        for(const ref of refs??[])blocks.push({type:'image',attachment:ref as never})
        return blocks
      },
    },
    async execute(args,exec){
      if(!subprocess)
        throw new CadError('DRAWING_SUBPROCESS_UNAVAILABLE','缺少 subprocess 服务：调用方插件 inject 需要包含 subprocess',{})
      const resolvedPython=resolveCadPython(config)
      const cwd=cadScopeCwd(exec,config)
      const file=resolveCadPath(exec,config,args.path,'path')
      // 扫描页图像要落盘才能附件化。**是否导出**（images 开关）与**默认落点**只由 operation 一处决定
      // （它自己 mkdir，建不出来就报 DRAWING_IMAGE_DIR_UNWRITABLE）；工具只把调用方给的相对目录
      // 解析成绝对路径（工具参数 > 插件 config），不在这里再造一份默认值——两处判定会漂移。
      const wantImages=args.images!==false
      const configuredImageDirectory=wantImages?(args.image_directory??config.imageDirectory):undefined
      // DWG 分流靠它：没有转换器时 inspectDrawing 会明确报 DWG_CONVERTER_UNCONFIGURED（不静默读不出来）
      const converter=resolveDwgConverter(config)
      const report=await inspectDrawing({
        subprocess,file,
        images:wantImages,
        ...(converter?{converter}:{}),
        ...(resolvedPython?{python:resolvedPython}:{}),
        ...(config.script?{script:config.script}:{}),
        ...(cwd?{cwd}:{}),
        ...(args.unit?{unit:args.unit}:{}),
        ...(args.scale?{scale:args.scale}:{}),
        ...(args.out?{out:resolveCadPath(exec,config,args.out,'out')}:{}),
        ...(args.max_items!==undefined?{maxItems:args.max_items}:{}),
        ...(args.max_pages!==undefined?{maxPages:args.max_pages}:{}),
        ...(configuredImageDirectory?{imageDirectory:resolveCadPath(exec,config,configuredImageDirectory,'image_directory')}:{}),
        ...(args.max_images!==undefined?{maxImages:args.max_images}:{}),
        ...(config.rasterizer?{rasterizer:config.rasterizer}:{}),
        ...(config.rasterizationDpi!==undefined?{rasterizationDpi:config.rasterizationDpi}:{}),
        ...(config.timeoutMs!==undefined?{timeoutMs:config.timeoutMs}:{}),
        signal:exec.signal,
      })
      const detail:DrawingDetail=args.detail??'summary'
      const attachments=await attachPdfImages(report,getAttachments,args.max_images??config.maxImages??DRAWING_MAX_IMAGES)
      // 附件化是异步的（读图 + saveImage），回来之后再核一次取消——与已审的 Blender/Depth 同一条原则：
      // 已取消就一张图都不交、也不在 Map 里留结果载体（不造新的任务表，只用本工具自己的同步 Map）。
      if(exec.signal.aborted)
        throw new CadError('DRAWING_CANCELLED',
          '调用在扫描页图像附件化阶段被取消（本次不返回图纸回执与图像）',
          {path:file,attachedImages:attachments.attached.length})
      const result=detail==='full'?JSON.stringify(report):JSON.stringify(
        {...drawingFileSummary(report,CAD_SUMMARY_ITEMS),attachments})
      const refs=attachments.attached.map(item=>item.ref)
      if(refs.length>0)attachmentsByResult.set(result,refs)
      return {result,report:report as unknown as JsonValue}
    },
  }))

  const disposeCheck=ctx.tools.register(defineTool({
    name:'drawing_constraints_check',
    description:'ENV-14: compare a drawing\'s **confirmed facts** from prior drawing_inspect constraints[]/constraintsDigest and openings[]/openingsDigest, or combined factsDigest, against current readings **item by item and value by value**. Report unchanged/changed and identify changed, missing, and added items in **both dimensions and openings**. Use after visual material/texture/style changes to verify facts were preserved; actual geometry changes (dimensions, scaling, door openings) must be reported. At least one of expect_digest/expect_constraints/expect_openings/expect_facts_digest is required, otherwise return CONSTRAINTS_BASELINE_REQUIRED: without a confirmed baseline, unchanged cannot be established. CAD does not carry component connectivity: connections is always null with why, never fabricated as 0. Openings are per modelling entity, never merged within a layer; each span is the longer side of that entity\'s own bounds. Empty layers and zero-metre degenerate geometry are excluded from opening facts and recorded in openingSkips with reasons. Include supplied originM (the entity\'s minimum bound corner in metres) in summaries and per-item comparisons, so translation within the same layer is detected even when dimensions are unchanged. If opening-layer entity counts exceed the per-entity detail limit, record OPENING_LAYER_SIZES_TRUNCATED and factsComplete:false; **do not declare unchanged** because omitted entities are outside the recorded facts.',
    parameters:{
      path:{type:'string',required:true,description:'Drawing file (DWG/DXF/PDF), using the same routing as drawing_inspect.'},
      expect_digest:{type:'string',description:'Digest of confirmed dimensions from prior drawing_inspect constraintsDigest. A digest alone detects a change but cannot identify the changed item.'},
      expect_constraints:{type:'array',items:{type:'object',additionalProperties:false,properties:{
        axis:{type:'string',required:true},value:{type:'number',required:true},unit:{type:'string',required:true},
        source:{type:'string',required:true},pageRef:{type:'integer',required:true},
      }},description:'Original confirmed dimension entries from prior constraints[]. Required to identify individual changed/missing/added entries.'},
      expect_openings:{type:'array',items:{type:'object',additionalProperties:false,properties:{
        kind:{type:'string',required:true},layerName:{type:'string',required:true},axis:{type:'string',required:true},
        spanM:{type:'number',required:true},count:{type:'integer',required:true},sourceRef:{type:'string',required:true},
        originM:{type:'array',items:{type:'number'},description:'Minimum bound corner of this opening entity in metres, from prior openings[]; needed to detect translation within its layer.'},
      }},description:'Original confirmed opening entries from prior openings[]. Required to identify individual changed/missing/added openings, including translation within a layer without changed dimensions.'},
      expect_facts_digest:{type:'string',description:'Combined confirmed-fact digest from prior factsDigest (dimensions and openings in one digest). A digest alone detects change but cannot identify items.'},
      unit:{type:'string',description:'Optional for DXF: explicit caller unit when the file declares no units, consistent with drawing_inspect.'},
      scale:{type:'string',description:'Optional for PDF: explicit scale; omission produces no metric entries.'},
      max_items:{type:'integer',description:'Optional maximum detail-list items; counts are unaffected.'},
    },
    output:{
      schema:{type:'object',additionalProperties:false,properties:{result:{type:'string',required:true},report:{type:'json',required:true}}},
      render:(_args,value)=>{const blocks:ContentBlock[]=[{type:'text',text:value.result}];return blocks},
    },
    async execute(args,exec){
      if(!subprocess)
        throw new CadError('DRAWING_SUBPROCESS_UNAVAILABLE','缺少 subprocess 服务：调用方插件 inject 需要包含 subprocess',{})
      const cwd=cadScopeCwd(exec,config)
      const file=resolveCadPath(exec,config,args.path,'path')
      const baseline=Array.isArray(args.expect_constraints)
        ?args.expect_constraints as DrawingConstraint[]:null
      const baselineOpenings=Array.isArray(args.expect_openings)
        ?args.expect_openings as DrawingOpening[]:null
      const expectDigest=typeof args.expect_digest==='string'&&args.expect_digest.trim()!==''
        ?args.expect_digest.trim():null
      const expectFactsDigest=typeof args.expect_facts_digest==='string'&&args.expect_facts_digest.trim()!==''
        ?args.expect_facts_digest.trim():null
      if(!baseline&&!expectDigest&&!baselineOpenings&&!expectFactsDigest)
        throw new CadError('CONSTRAINTS_BASELINE_REQUIRED',
          '没有"已确认事实"的基线：请在 expect_digest 给上次的 constraintsDigest、在 expect_constraints 给上次的 constraints[]、'
          +'在 expect_openings 给上次的 openings[]，或在 expect_facts_digest 给上次的 factsDigest——'
          +'不给基线就不敢说"没变"（没有"已确认"就没有"未变"）',{path:file})
      const resolvedPython=resolveCadPython(config)
      const report=await inspectDrawing({
        subprocess,file,
        images:false,
        ...(resolvedPython?{python:resolvedPython}:{}),
        ...(config.script?{script:config.script}:{}),
        ...(cwd?{cwd}:{}),
        ...(args.unit?{unit:args.unit}:{}),
        ...(args.scale?{scale:args.scale}:{}),
        ...(args.max_items!==undefined?{maxItems:args.max_items}:{}),
        ...(config.timeoutMs!==undefined?{timeoutMs:config.timeoutMs}:{}),
        signal:exec.signal,
      })
      const comparison=baseline?compareConstraints(baseline,report.constraints):null
      const openingComparison=baselineOpenings?compareOpenings(baselineOpenings,report.openings):null
      // 事实完整性：本次报告若有开口层被截断（sizesTruncated），窗口外的实体根本不在事实里 ⇒ 不能断言"未变"。
      const currentFactsComplete=factsCompleteOf(report)
      // 只给了一类基线时，另一类**视为未断言**（拿本次当基线 ⇒ 该桶恒"未变"），
      // 不能把"没给基线"当成"基线里没有 ⇒ 全多了"——那是把没测说成变了。
      const facts=(baseline||baselineOpenings)
        // 基线侧是调用方声明的"已确认事实"（完整性由声明负责）；本次侧带上 openingSkips ⇒ 截断层自动降级为"证不了未变"。
        ?compareFacts({constraints:baseline??report.constraints,openings:baselineOpenings??report.openings},
          {constraints:report.constraints,openings:report.openings,openingSkips:report.openingSkips},
          {before:true,after:currentFactsComplete})
        :null
      const factsComplete=facts?facts.factsComplete:currentFactsComplete
      const digestBefore=comparison?comparison.digestBefore:(expectDigest??'')
      const dimensionUnchanged=comparison?comparison.unchanged:(expectDigest?expectDigest===report.constraintsDigest:true)
      const openingUnchanged=openingComparison?openingComparison.unchanged:true
      const factsDigestBefore=expectFactsDigest??(facts?facts.factsDigestBefore:report.factsDigest)
      const factsUnchanged=(facts?facts.unchanged:true)
        &&(expectFactsDigest?expectFactsDigest===report.factsDigest:true)
        &&(expectDigest?expectDigest===report.constraintsDigest:true)
      const unchanged=dimensionUnchanged&&openingUnchanged&&factsUnchanged
      const describe=(item:DrawingConstraint)=>`${item.axis} 轴 ${item.value} ${item.unit}（${item.source}，页 ${item.pageRef}）`
      const describeOpening=(item:DrawingOpening)=>
        `${item.kind}「${item.layerName}」${item.axis} 向 ${item.spanM} m × ${item.count} 件（${item.sourceRef}）`
        +(item.originM?`，原点 (${item.originM.join(', ')}) m`:'')
      const lines:string[]=[
        // 首行保持既有措辞（尺寸桶），旧的断言与消费者不受影响；第二行起补开口桶与合并事实。
        dimensionUnchanged
          ?`尺寸约束未变：摘要 ${report.constraintsDigest.slice(0,16)}…，逐条逐值一致 ${comparison?comparison.equal.length:report.constraints.length} 条`
          :`尺寸约束已变：摘要 ${digestBefore.slice(0,16)}… → ${report.constraintsDigest.slice(0,16)}…`,
        openingUnchanged
          ?`开口未变：摘要 ${report.openingsDigest.slice(0,16)}…，逐条逐值一致 ${openingComparison?openingComparison.equal.length:report.openings.length} 处`
          :`开口已变：摘要 ${openingComparison?.digestBefore?.slice(0,16)??'—'}… → ${report.openingsDigest.slice(0,16)}…`,
        factsUnchanged
          ?`已确认事实（尺寸+开口）未变：facts ${report.factsDigest.slice(0,16)}…`
          // 事实不完整时**不能**说"已变"（可能什么都没变，只是窗口外没读）——分开措辞，别把"证不了"说成"变了"。
          :!factsComplete
            ?`已确认事实（尺寸+开口）无法断言"未变"：事实不完整（有开口层的逐实体明细被截断，facts ${factsDigestBefore.slice(0,16)}… → ${report.factsDigest.slice(0,16)}…）`
            :`已确认事实（尺寸+开口）已变：facts ${factsDigestBefore.slice(0,16)}… → ${report.factsDigest.slice(0,16)}…`,
      ]
      if(comparison){
        for(const item of comparison.changed)
          lines.push(` · 尺寸值变了：${describe(item.before)} → ${item.after.value} ${item.after.unit}`)
        for(const item of comparison.removed)lines.push(` · 尺寸丢了：${describe(item)}（已确认过，这次没有）`)
        for(const item of comparison.added)lines.push(` · 尺寸多了：${describe(item)}（已确认里没有）`)
      }else if(!dimensionUnchanged){
        lines.push(' · 尺寸只给了摘要：能判定"变了"，但不能点名是哪一条（要逐条点名请在 expect_constraints 给上次的 constraints[]）')
      }
      if(openingComparison){
        for(const item of openingComparison.changed)
          lines.push(` · 开口变了：${describeOpening(item.before)} → ${describeOpening(item.after)}`)
        for(const item of openingComparison.removed)lines.push(` · 开口丢了：${describeOpening(item)}（已确认过，这次没有）`)
        for(const item of openingComparison.added)lines.push(` · 开口多了：${describeOpening(item)}（已确认里没有）`)
      }else if(report.openings.length>0&&!unchanged){
        lines.push(` · 本次读到 ${report.openings.length} 处开口，但没有基线（要逐条点名请在 expect_openings 给上次的 openings[]）`)
      }
      // 空图层/0 m 退化层/逐实体明细被截断：读不出（或读不全）也要在回执里留痕（不静默省略，也不写进上面两桶与 factsDigest）。
      for(const item of report.openingSkips)
        lines.push(` · 开口层未折算：${item.layerName}（${item.reason}，实体 ${item.entityCount}）—— ${item.detail}`)
      if(!factsComplete)
        lines.push(' · 事实不完整：上列被截断的开口层里，超出逐实体明细上限的实体不在 openings/factsDigest 里'
          +' ⇒ 本次**不能**判"未变"（提高 max_items 或把该层拆小后重取基线）。')
      lines.push(` · 连接：${DRAWING_CONNECTIONS_UNAVAILABLE_WHY}`)
      const value={
        ok:true,unchanged,verdict:lines.join('\n'),file:report.file,kind:report.kind,
        baseline:baseline?'expect_constraints':(baselineOpenings?'expect_openings':(expectFactsDigest?'expect_facts_digest':'expect_digest')),
        digestBefore,digestAfter:report.constraintsDigest,
        equalCount:comparison?comparison.equal.length:null,
        changed:comparison?.changed??[],removed:comparison?.removed??[],added:comparison?.added??[],
        factsDigestBefore,factsDigestAfter:report.factsDigest,factsUnchanged,factsComplete,
        openingsDigest:report.openingsDigest,
        openingsEqualCount:openingComparison?openingComparison.equal.length:null,
        openingsChanged:openingComparison?.changed??[],openingsRemoved:openingComparison?.removed??[],openingsAdded:openingComparison?.added??[],
        openings:report.openings,openingSkips:report.openingSkips,
        connections:null,connectionsWhy:DRAWING_CONNECTIONS_UNAVAILABLE_WHY,
        constraints:report.constraints,assumptions:report.assumptions,
        note:'材质/贴图/风格这类视觉变更不该让 constraints 或 openings 变化；几何变了（改尺寸/缩放/改门洞）必须在这里报出来。'
          +'未变的判定要求两桶都逐条逐值一致且合并摘要（factsDigest）相同——不是"数量一样"就算没变；'
          +'还要求事实完整（factsComplete=true）：开口层逐实体明细被截断时，窗口外的实体不在事实里，绝不能判"未变"。'
          +'连接（构件拓扑）在 CAD 侧不承载：connections 恒为 null，不填 0。',
      }
      return {result:JSON.stringify(value),report:value as unknown as JsonValue}
    },
  }))

  const disposeConvert=ctx.tools.register(defineTool({
    name:'cad_convert',
    description:'Convert DWG to a new DXF using a **configured external converter** (LibreDWG dwg2dxf or a custom command template). Convert only in this operation\'s own temporary directory and never modify the source. Reject the source itself and its symlink/hard-link aliases as output before conversion, and compare source sha256 before/after. **Atomically publish to out only after validation**; failure, cancellation, or invalid output leaves out, including any existing file, byte-for-byte unchanged. Do not overwrite existing out unless overwrite=true. Report the converter\'s warnings/losses and validation verdict accurately.',
    parameters:{
      path:{type:'string',required:true,description:'DWG source file, identified by its header rather than extension.'},
      out:{type:'string',description:'Output DXF path; defaults to <workspace>/cad-converted/<name>.dxf.'},
      overwrite:{type:'boolean',description:'Allow overwriting an existing output; defaults to false.'},
      verify:{type:'boolean',description:'Read-only ezdxf validation after conversion; defaults to true.'},
      max_items:{type:'integer',description:'Optional maximum detail items in the validation report.'},
      detail:{type:'string',enum:DRAWING_DETAILS,description:'Presentation detail for result: summary (default) or full.'},
    },
    output:{
      schema:{type:'object',additionalProperties:false,properties:{result:{type:'string',required:true},report:{type:'json',required:true}}},
      render:(_args,value)=>{const blocks:ContentBlock[]=[{type:'text',text:value.result}];return blocks},
    },
    async execute(args,exec){
      if(!subprocess)
        throw new CadError('DRAWING_SUBPROCESS_UNAVAILABLE','缺少 subprocess 服务：调用方插件 inject 需要包含 subprocess',{})
      const cwd=cadScopeCwd(exec,config)
      const file=resolveCadPath(exec,config,args.path,'path')
      const converter=resolveDwgConverter(config)
      if(!converter)
        throw new CadError('DWG_CONVERTER_UNCONFIGURED',converterHint(),{})
      // 产物落点：显式 out > <工作区>/cad-converted/<名字>.dxf；没有工作区就落在图纸自己旁边的
      // cad-converted/（始终确定，不落进程 cwd，也不动源文件）。
      const output=args.out
        ?resolveCadPath(exec,config,args.out,'out')
        :join(cwd??dirname(file),'cad-converted',`${basename(file,extname(file))}.dxf`)
      const resolvedPython=resolveCadPython(config)
      const conversion=await convertDwgToDxf({
        subprocess,file,output,converter,
        overwrite:args.overwrite===true,
        ...(resolvedPython?{python:resolvedPython}:{}),
        ...(config.script?{script:config.script}:{}),
        ...(cwd?{cwd}:{}),
        verify:args.verify!==false,
        ...(args.max_items!==undefined?{maxItems:args.max_items}:{}),
        ...(config.timeoutMs!==undefined?{timeoutMs:config.timeoutMs}:{}),
        signal:exec.signal,
      })
      const detail:DrawingDetail=args.detail??'summary'
      const result=detail==='full'?JSON.stringify(conversion):JSON.stringify({
        ok:true,
        source:conversion.source,converter:conversion.converter,output:conversion.output,
        sourceUnchanged:conversion.sourceUnchanged,losses:conversion.losses,
        lossCategories:conversion.lossCategories,verification:conversion.verification,
        warnings:conversion.warnings,
        note:'out 只在本次转换成功且检验通过时才被创建/替换；DWG_CONVERTED_UNREADABLE 表示产物读不出来：'+
          '该次不发布（out 未动），产物留在错误信息给出的暂存路径里便于排查，别把"退出码 0"当读懂图纸。',
      })
      return {result,report:conversion as unknown as JsonValue}
    },
  }))

  return ()=>{ disposeInspect(); disposeCheck(); disposeConvert() }
}

/** 缺转换器时的指引：列出探测过的名字与两条真实可走的安装/配置路径。 */
export function converterHint():string{
  return '没有可用的 DWG 转换器（探测过：PATH 里的 '+DWG_CONVERTER_CANDIDATES.map(item=>item.bin).join('、')+
    '；配置项 dwgConverter；环境变量 LYAPUNOV_DWG_CONVERTER）。'+
    '可选：① 安装 GNU LibreDWG（内含 dwg2dxf，本机可用：解包 libredwg-0.14.tar.xz → ./configure --prefix=<目录> && make -j install）；'+
    '② 用 dwgConverter:{kind:"command",path:"<任意命令行转换器>",args:["-o","{out}","{in}"]} 接入已有工具。'
}

/** 会话任务工作区（原生会话 header.cwd 优先，config.workspace 兜底）——与 cad.ts 同一条规则。 */
function cadScopeCwd(exec:CadScope|undefined,config:DrawingConfig):string|undefined{
  const fromSession=exec?.agent?.session?.header?.cwd?.trim()
  if(fromSession)return fromSession
  const configured=config.workspace?.trim()
  return configured?resolve(configured):undefined
}

/** 把扫描页导出的 PNG 送进原生附件库；失败逐条记原因（不静默丢图）。 */
async function attachPdfImages(
  report:DrawingReport,
  getAttachments:()=>{saveImage(input:{data:Uint8Array;mediaType:'image/png';name:string}):Promise<unknown>}|undefined,
  maxImages:number,
):Promise<{attached:Array<{page:number;ref:unknown}>;failures:Array<{page:number;reason:string}>;note:string}>{
  const failures:Array<{page:number;reason:string}>=[]
  const attached:Array<{page:number;ref:unknown}>= []
  const exported=report.pdf?.images?.exported??[]
  if(exported.length===0)
    return {attached,failures,note:report.kind==='pdf'?'本次没有导出扫描页图像':'非 PDF：没有图像可带'}
  const store=getAttachments()
  if(!store)
    return {attached,failures,note:'装配没有附件服务（attachments）：图像没有进上下文，按 result 里的真实路径自行读取'}
  for(const image of exported.slice(0,maxImages)){
    try{
      const data=await readFile(image.path)
      const ref=await store.saveImage({data,mediaType:'image/png',name:basename(image.path)})
      attached.push({page:image.page,ref})
    }catch(error){
      failures.push({page:image.page,reason:`附件化失败：${String(error)}`})
    }
  }
  if(exported.length>maxImages)
    failures.push({page:exported[maxImages]!.page,reason:`超过单次上限 ${maxImages} 张，其余仍以真实路径留在 result 里`})
  const displayed=exported.slice(0,maxImages).filter(image=>image.asDisplayed!==false)
  const pixels=exported.slice(0,maxImages).length-displayed.length
  return {attached,failures,note:
    '图像来源（逐张看 exported[].source/asDisplayed）：source=rasterized 且 asDisplayed=true 的是按页面旋转/裁切'+
    '整页渲染的预览，就是用户看到的图纸；'+
    (pixels>0
      ? `本次有 ${pixels} 张是页面里的嵌入原样像素（asDisplayed=false）：可能不含页面 /Rotate 与 CropBox 的显示效果，`+
        '也可能漏掉画在其上的矢量/文字/叠图，按条目里的 rotateDegrees/cropBox 自行变换才算"用户看到的样子"；'
      : '')+
    '像素与原始扫描件不逐位相同（有缩放/重编码）'}
}

/** 顶层结果契约校验：kind 与对应的载荷必须对得上，缺一份就不算读到了图纸。 */
export function assertDrawingReport(value:unknown,file:string):DrawingReport{
  const report=value as Partial<DrawingReport>|null
  if(!report||typeof report!=='object'||report.ok!==true||!Array.isArray(report.warnings)
    ||typeof report.file!=='object'||report.file===null||typeof report.file.sha256!=='string'
    ||!DRAWING_KINDS.includes(report.kind as DrawingKind))
    throw new CadError('DRAWING_OUTPUT_INVALID','分流报告结构不符合约定（缺 ok/kind/file/warnings）',{path:file})
  if(report.kind==='pdf'&&!(report.pdf&&typeof report.pdf==='object'))
    throw new CadError('DRAWING_OUTPUT_INVALID','PDF 分流的报告缺少 pdf 载荷',{path:file})
  if((report.kind==='dxf'||report.kind==='dwg')&&!(report.dxf&&typeof report.dxf==='object'))
    throw new CadError('DRAWING_OUTPUT_INVALID',`${report.kind} 分流的报告缺少 dxf 载荷`,{path:file})
  if(report.kind==='dwg'&&!(report.conversion&&typeof report.conversion==='object'))
    throw new CadError('DRAWING_OUTPUT_INVALID','DWG 分流的报告缺少 conversion 载荷',{path:file})
  if(!Array.isArray(report.constraints)||!Array.isArray(report.assumptions))
    throw new CadError('DRAWING_OUTPUT_INVALID',
      '分流报告缺 constraints/assumptions（几何约束与缺项假设必须显式给，空数组也要给）',{path:file})
  if(typeof report.constraintsDigest!=='string'||report.constraintsDigest.length===0)
    throw new CadError('DRAWING_OUTPUT_INVALID',
      '分流报告缺 constraintsDigest（已确认尺寸要能被稳定比对，摘要不能为空）',{path:file})
  for(const item of report.constraints as DrawingConstraint[]){
    if(typeof item!=='object'||item===null
      ||!(DRAWING_CONSTRAINT_AXES as readonly unknown[]).includes(item.axis)
      ||typeof item.value!=='number'||!(DRAWING_CONSTRAINT_UNITS as readonly unknown[]).includes(item.unit)
      ||typeof item.source!=='string'||item.source===''||typeof item.pageRef!=='number')
      throw new CadError('DRAWING_OUTPUT_INVALID',
        'constraints 条目不符合约定（需要 axis/value/unit/source/pageRef，且 source 要指出读数字段）',{path:file})
  }
  for(const item of report.assumptions as DrawingAssumption[]){
    if(typeof item!=='object'||item===null
      ||!(DRAWING_ASSUMPTION_CODES as readonly unknown[]).includes(item.code)
      ||typeof item.detail!=='string'||item.detail===''||typeof item.why!=='string'||item.why==='')
      throw new CadError('DRAWING_OUTPUT_INVALID',
        'assumptions 条目不符合约定（需要 code/detail/why，why 要说明为什么是缺项）',{path:file})
  }
  return report as DrawingReport
}
