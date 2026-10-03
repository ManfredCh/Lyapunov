/**
 * 照片相机位姿拟合：用**可配置的隔离 Python**（装了 OpenCV）从 3D-2D 对应点解 PnP，
 * 返回可直接用于 Blender 与原生 Viewer 的位姿/四元数/FOV，以及逐点重投影残差与可辨识性判定。
 *
 * 边界（本切片**不做**的事）：
 *  · 不检测特征、不匹配同名点、不做多视图重建：对应点由调用方给出（模型看图 / 人工 / 其它工具）；
 *  · 不做相机标定：已知 K 就是已知 K；无 K 时只按镜头 FOV、传感器尺寸、消失点或**带理由**的焦距
 *    假设给"标明来源"的估计，从不把某个固定焦距当真值，也不把它叫"实测精度"；
 *  · 不宣称实测精度：残差是给定对应点上的重投影残差；check 点（不参与拟合）才有一点独立证据，
 *    没有 check 点就在 warnings 里明说"没有独立证据"；世界点重复、只有像素不同的 check 点只核对
 *    内参/像素一致性，不算空间外推验证（见 precision.spatialCheck）；
 *  · 尺度未知就不给带 M 的位置字段：worldUnit='unknown' 时三个适配器（worldFromCamera／blender／viewer）
 *    的位置一律叫 positionInputUnits/locationInputUnits（见 {@link cameraFitPosition}），因为消费者
 *    （53/Blender）会把 M 后缀直接当米用——只写 warning 是不够的，warning 会被过滤掉；
 *  · 完全重复的对应点（同 id，或世界点+像素都相同，含跨 role）直接拒绝：既 fit 又 check 会让"独立核对"
 *    退化成复读；世界点相同、像素不同的 check 点允许，但记为 checkRepeatedWorldPoints 且不算空间外推验证；
 *  · Blender 适配给**整套**参数（sensorFit/lens/sensor/shift_x,y/pixel_aspect/分辨率）并自报
 *    resolvesIntrinsics + 复现误差：只给 lens/sensor 会在非居中主点或 fx≠fy 时把画面挪错；
 *  · 不发明第二套坐标合同：像素原点左上、u 右 v 下；world 为右手 Z-up 米制；
 *    worldFromCamera 沿用 `packages/sim-mujoco/python/worker.py` 的 camera calibration
 *    （camera x 右、y 上、看向 -z；world = R·p_cam + t）。
 *
 * 分层：`fitCamera` 是共用 operation（Command／工作流可直接调用），`registerCameraFitTools`
 * 只把同一 operation 注册成模型工具——行为只有一份。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'node:path'

/** camera_fit.py 成功时的结果前缀；解析方不得硬编码字面量。 */
export const CAMERA_FIT_RESULT_PREFIX='LYAPUNOV_CAMERA_FIT_RESULT='
/** camera_fit.py 可预期失败时的错误前缀（退出码 3）。 */
export const CAMERA_FIT_ERROR_PREFIX='LYAPUNOV_CAMERA_FIT_ERROR='
/** 求解器脚本路径：随包走，不依赖安装位置。 */
export const CAMERA_FIT_SCRIPT_URL=new URL('../python/camera_fit.py',import.meta.url)
/** 世界点单位（与 camera_fit.py 的 WORLD_UNITS 一致）；"unknown" 表示尺度未定，只解归一化坐标。 */
export const CAMERA_FIT_WORLD_UNITS=['m','cm','mm','km','dm','in','ft','yd','mil','unknown'] as const
export type CameraFitWorldUnit=(typeof CAMERA_FIT_WORLD_UNITS)[number]
/** 无 K 时允许的镜头来源；`assumed-focal-px` 必须带 rationale，否则求解器拒绝。 */
export const CAMERA_FIT_LENS_KINDS=['fov','sensor','vanishing-points','assumed-focal-px'] as const
export type CameraFitLensKind=(typeof CAMERA_FIT_LENS_KINDS)[number]
/** 工具参数里展示的检查点名上限（计数永远是全量）。 */
export const CAMERA_FIT_SUMMARY_POINTS=5

/** 结构化失败。code 是稳定机器码，message 是给人看的原因与下一步。 */
export class CameraFitError extends Error{
  readonly code:string
  readonly detail:Record<string,unknown>
  constructor(code:string,message:string,detail:Record<string,unknown>={}){
    super(`${code}: ${message}`)
    this.name='CameraFitError'
    this.code=code
    this.detail=detail
  }
}

/** 一条对应点：世界点（米、Z-up）↔ 照片像素（原点左上、u 右 v 下）。role=check 的点不参与拟合。 */
export interface CameraCorrespondence{
  world:[number,number,number]
  pixel:[number,number]
  id?:string
  role?:'fit'|'check'
}

/** 已知 K（实测标定优先路径）。cx/cy 省略时按像素中心口径 (width-1)/2、(height-1)/2。 */
export interface CameraIntrinsics{
  fx:number
  fy:number
  cx?:number
  cy?:number
  width:number
  height:number
  /** OpenCV 口径：k1,k2,p1,p2[,k3[,k4,k5,k6[,s1,s2,s3,s4[,tauX,tauY]]]]；省略=无畸变。 */
  distortion?:number[]
}

/** 无 K 时的镜头来源：每条都标注来源与假设，见结果的 intrinsics.source/assumptions。 */
export type CameraLens =
  |{kind:'fov';fovDegVertical?:number;fovDegHorizontal?:number;width:number;height:number;cx?:number;cy?:number;distortion?:number[]}
  |{kind:'sensor';focalLengthMm:number;sensorWidthMm:number;width:number;height:number;cx?:number;cy?:number;distortion?:number[]}
  |{kind:'vanishing-points';directions:Array<{world:[number,number,number];pixel:[number,number];label?:string}>;width:number;height:number;cx?:number;cy?:number;distortion?:number[]}
  |{kind:'assumed-focal-px';focalPx:number;rationale:string;width:number;height:number;cx?:number;cy?:number;distortion?:number[]}

export interface CameraFitOptionsRequest{
  /** 'auto'（默认，fit 点 ≥6 时启用 RANSAC 剔外点）| true | false。 */
  ransac?:'auto'|boolean
  /** RANSAC 内点阈值（像素），默认 3。 */
  reprojectionThresholdPx?:number
  /** RANSAC 迭代上限，默认 1000。 */
  iterations?:number
  /** RANSAC 置信度，默认 0.99。 */
  confidence?:number
  /** RANSAC 随机种子（默认 0）；固定后结果可复现。 */
  seed?:number
  /** 最后做 LM 精化，默认 true。 */
  refine?:boolean
  /** 共面两解的判定容差（像素），默认 1：两解误差间隔小于它（或小于 3×拟合 RMS）即判为歧义。 */
  planarGapTolerancePx?:number
}

export interface CameraFitRequest{
  correspondences:CameraCorrespondence[]
  /** 世界点单位，默认 'm'；'unknown' = 尺度未定（只解归一化坐标，位置沿用输入单位）。 */
  worldUnit?:CameraFitWorldUnit
  intrinsics?:CameraIntrinsics
  lens?:CameraLens
  options?:CameraFitOptionsRequest
}

export interface CameraFitPointReadout{
  id:string
  /** 尺度确定（worldUnit 是米制单位）时的世界点，米。与 worldInputUnits 互斥。 */
  worldM?:number[]
  /** 尺度未定（worldUnit='unknown'）时的世界点，**输入单位**（不是米）。与 worldM 互斥。 */
  worldInputUnits?:number[]
  observedPx:number[]
  predictedPx:number[]
  residualPx:number[]
  distancePx:number
  inFrontOfCamera:boolean
  outlier?:boolean
}

export interface CameraFitStats{
  count:number
  usedForStats:number
  rmsPx:number|null
  maxPx:number|null
  medianPx:number|null
  behindCamera:number
  outliers:number
}

/**
 * 相机位姿。位置的**字段名跟着尺度走**：只有 worldUnit 是米制单位（尺度确定）时才叫 positionM；
 * `worldUnit:'unknown'` 时叫 positionInputUnits——那些数不是米，名字里带 M 会被 53/Blender 当米直接用。
 * 用 {@link cameraFitPosition} 取，不要写死字段名。
 */
export interface CameraFitPose{
  positionM?:number[]
  positionInputUnits?:number[]
  rotationMatrix:number[][]
  quaternionXyzw:number[]
}

/** 位置读数 + 它到底是不是米。字段名与 camera.metric 不一致时抛 CAMERA_FIT_OUTPUT_INVALID。 */
export function cameraFitPosition(pose:CameraFitPose,metric=true):{values:number[];metric:boolean}{
  const metricValues=pose.positionM
  const inputValues=pose.positionInputUnits
  // 两个名字同时出现就是"这数到底是不是米"没定论：不猜，直接判失败。
  if(Array.isArray(metricValues)&&Array.isArray(inputValues))
    throw new CameraFitError('CAMERA_FIT_OUTPUT_INVALID',
      '位置同时给了 positionM 与 positionInputUnits：尺度不能有两个说法，只允许出现其中一个',{})
  if(metric&&Array.isArray(metricValues)&&metricValues.length===3)return {values:metricValues,metric:true}
  if(!metric&&Array.isArray(inputValues)&&inputValues.length===3)return {values:inputValues,metric:false}
  throw new CameraFitError('CAMERA_FIT_OUTPUT_INVALID',
    metric?'读数是米制尺度，但 camera.worldFromCamera 里没有 positionM'
      :'读数尺度未定（worldUnit=unknown），但 camera.worldFromCamera 里没有 positionInputUnits'
        +'（位置字段名必须跟着尺度走，不能带 M 后缀）',{metric})
}

/** Blender 相机参数：内参要**同时**用上 sensorFit/lens/sensor/shift/pixel_aspect/分辨率才复现得出 K。 */
export interface CameraFitBlenderCamera{
  /** 尺度确定时的位置（米）。与 locationInputUnits 互斥。 */
  locationM?:number[]
  /** 尺度未定时的位置（**输入单位，不是米**）。与 locationM 互斥。 */
  locationInputUnits?:number[]
  /** 位置数值的尺度（与 camera.metric 同一件事的显式声明）。 */
  metric:boolean
  rotationQuaternionXyzw:number[]
  rotationMode:'QUATERNION'
  /** 显式 sensorFit（不再用 AUTO）：fit 轴固定成 x，所以 angleDeg 就是水平视场角。 */
  sensorFit:string
  lensMm:number
  sensorWidthMm:number
  sensorHeightMm:number
  sensorHeightNote:string
  /** 主点偏移（fit 轴全长=1 的单位）：cx=(width-1)/2 的居中主点也常常是 +0.0005 这种非零小量。 */
  shiftX:number
  shiftY:number
  resolutionPx:{width:number;height:number}
  /** scene.render.pixel_aspect_x/y：fx≠fy 就靠它真实表达（不是输出 1/1 后说"支持"）。 */
  pixelAspect:{x:number;y:number}
  pixelAspectClamped:boolean
  angleDeg:number
  fovXDeg:number
  fovYDeg:number
  squarePixels:boolean
  /** 按这组参数反推的 K（求解器自己的模型算的，回灌时由真实 Blender 的 view_frame 核对）。 */
  resolvesIntrinsics:{fx:number;fy:number;cx:number;cy:number}
  /** 上面那组 K 与请求的 K 的差（像素）。>0.001 就说明这组参数复现不出请求的内参。 */
  intrinsicsReproductionErrorPx:{fx:number;fy:number;cx:number;cy:number;max:number}
  /** 必须一起写进 Blender 的属性清单（少写一条画面就不对）。 */
  requires:string[]
  note:string
  noteSquarePixels:string
}

/** 原生 Viewer（three.js）相机参数：位姿用 positionM/positionInputUnits + quaternion（或 worldFromCamera 矩阵）装。 */
export interface CameraFitViewerCamera{
  /** 尺度确定时的位置（米）。与 positionInputUnits 互斥——三个适配器用同一套命名规则。 */
  positionM?:number[]
  /** 尺度未定时的位置（**输入单位，不是米**）。 */
  positionInputUnits?:number[]
  quaternion:number[]
  /** 位置数值的尺度：worldUnit=unknown 时**不是米**。 */
  units:{metric:boolean;name:string;note:string}
  fov_y_deg:number
  fov_x_deg:number
  aspect:number
  /** 由 R 得出的**真实**相机上向量（含 roll），不是世界 up [0,0,1]。 */
  up:number[]
  upNote:string
  forward:number[]
  /** 位置 + forward·focusDistance：OrbitControls 的 target 用它（不是"世界原点"）。 */
  target:number[]|null
  focusDistance:number|null
  /** 相机 up 相对"世界 up 在像平面上的投影"的有符号 roll（度）；OrbitControls.update() 会把它抹掉。 */
  rollDeg:number|null
  rollNote:string
  sceneUp:number[]
  projection:'perspective'
  intrinsics:{model:string;fx:number;fy:number;cx:number;cy:number;width:number;height:number;
    principalPointOffsetPx:{x:number;y:number};principalPointCentred:boolean;reproducibleByFovAlone:boolean;note:string}
  /** 本读数走 three.js 的普通 fov + 画布 aspect 接口（前提是方形像素）：主点用 setViewOffset 精确表达，
   *  fx≠fy 在这条路径下只能用残余误差报出来——**不是** three.js 的能力上限（给 projectionMatrix 或用
   *  setViewOffset 的整幅适配法都能精确表达 K；66 候选的 Viewer 侧 camera-view.ts（合入主仓后为
   *  packages/viewer/src/camera-view.ts）已实现），note 里写明这条界限。 */
  squarePixelModel:{note:string;viewOffsetPx:{x:number;y:number;apply:string};exact:boolean;
    options:Array<{keeps:'fx'|'fy';fovYDeg:number;aspect:number;maxPixelErrorPx:number;pays:string}>}
  matrixWorldFromCamera:number[][]
}

export interface CameraFitResult{
  ok:true
  scriptVersion:string
  engine:{name:string;version:string;numpy:string;interpreter:string;python:string;solver:string}
  conventions:Record<string,string>
  input:{counts:{total:number;fit:number;check:number;uniqueWorldPoints:number;
      checkRepeatedWorldPoints:number;checkRepeatedWorldPointIds:string[];checkHeldOut:boolean;note:string};
    worldUnit:string;
    metresPerInputUnit:number|null;fitPoints:number;checkPoints:number;fitPointIds:string[];checkPointIds:string[]}
  scale:{determined:boolean;worldUnit:string;source:string;metresPerInputUnit?:number;note:string;normalization?:unknown}
  intrinsics:{fx:number;fy:number;cx:number;cy:number;width:number;height:number;distortion:number[];
    distortionModel:string;fovyDeg:number;fovxDeg:number;source:string;estimated:boolean;calibrated:boolean;assumptions:string[]}
  identifiability:{fit3dRank:number;fit3dSingularValuesRelative:number[];fitPixelRank:number;planar:boolean;
    collinear:boolean;nearCollinear:boolean;nearPlanar:boolean;note:string}
  planarAmbiguity:null|{kind:'planar-twofold';note:string;ippeError:string|null;
    solutions?:Array<{worldFromCamera:CameraFitPose;reprojectionRmsPx:number|null}>;
    reprojectionGapPx?:number|null;rotationDeltaDeg?:number|null;positionDeltaM?:number|null;
    positionDeltaInputUnits?:number|null;ambiguous?:boolean}
  camera:{model:string;worldFromCamera:CameraFitPose;
    fov:{verticalDeg:number;horizontalDeg:number;focalPx:{x:number;y:number}};
    positionUnits:string;metric:boolean;blender:CameraFitBlenderCamera;viewer:CameraFitViewerCamera}
  reprojection:{fit:{stats:CameraFitStats;perPoint:CameraFitPointReadout[];perPointReported:number};
    check:null|{stats:CameraFitStats;perPoint:CameraFitPointReadout[];perPointReported:number}}
  precision:{residualsAre:string;fitPointsUsedForEstimation:boolean;independentCheck:boolean;
    /** 有**世界点也没在 fit 里出现过**的 check 点：只有这种 check 验证空间外推，重复世界点不算。 */
    spatialCheck:boolean;fitResidualRmsPx:number|null;checkResidualRmsPx:number|null;
    spatialCheckRmsPx:number|null;claims:string[];measuredAccuracy:boolean}
  solver:{inputPoints:number;refined:boolean;backend:string;attempts:Array<Record<string,unknown>>;
    ransac:null|Record<string,unknown>;seed:number;options:Record<string,unknown>;notes?:string[]}
  warnings:string[]
}

/** 解析器失败时 Python 侧给出的结构（退出码 3）。 */
interface CameraFitErrorEnvelope{ok:false;scriptVersion?:string;error:{code:string;message:string}&Record<string,unknown>}

export interface CameraFitConfig{
  /** 运行 camera_fit.py 的解释器。必须已装 opencv-python-headless + numpy；未配置时回落 LYAPUNOV_CAMERA_FIT_PYTHON。 */
  python?:string
  /** camera_fit.py 的路径覆盖；默认用包内 python/camera_fit.py。 */
  script?:string
  /** 子进程墙钟上限（毫秒），超时即终止并报 CAMERA_FIT_TIMEOUT。 */
  timeoutMs?:number
  /** 相对路径的兜底基准目录；优先用会话任务工作区的 cwd，这里只是它缺席时的退路。 */
  workspace?:string
}

/** 工具执行上下文里取会话工作目录所需的最小形状（原生会话 header.cwd）。 */
export interface CameraFitScope{
  agent?:{session?:{header?:{cwd?:string}}|undefined}|undefined
}

export interface CameraFitCallOptions extends CameraFitRequest{
  subprocess:SubprocessRuntime
  /** 解释器绝对路径（必须已装 OpenCV）。 */
  python:string
  /** camera_fit.py 路径。 */
  script:string
  /** script 相对路径的基准目录；相对路径没有它直接报错，不落进程 cwd。 */
  cwd?:string
  timeoutMs?:number
  signal?:AbortSignal
}

const DEFAULT_TIMEOUT_MS=120_000

/**
 * 解释器解析：显式配置 > 环境变量（供装配层注入）> 未配置。
 * **没有**静默默认解释器：装 OpenCV 的解释器是环境事实，猜一个就等于"看起来能拟合、其实没依赖"。
 */
export function resolveCameraFitPython(config:CameraFitConfig={},env:NodeJS.ProcessEnv=process.env):string|undefined{
  const configured=config.python?.trim()
  if(configured)return configured
  const fromEnv=env.LYAPUNOV_CAMERA_FIT_PYTHON?.trim()
  return fromEnv?fromEnv:undefined
}

/** 任务工作区解析：会话任务 cwd 优先（与终端/工作台同一事实），config.workspace 只作兜底。 */
export function cameraFitTaskCwd(exec:CameraFitScope|undefined,config:CameraFitConfig={}):string|undefined{
  const fromSession=exec?.agent?.session?.header?.cwd?.trim()
  if(fromSession)return fromSession
  const configured=config.workspace?.trim()
  return configured?resolve(configured):undefined
}

/** 相对路径 → 绝对路径；没有会话 cwd/config.workspace 时报 CAMERA_FIT_CWD_UNRESOLVED。 */
export function resolveCameraFitPath(value:string,label:string,cwd?:string):string{
  if(isAbsolute(value))return value
  if(!cwd)
    throw new CameraFitError('CAMERA_FIT_CWD_UNRESOLVED',
      `${label} 是相对路径（${value}），但当前执行上下文没有会话工作目录、本插件也未配置 workspace；请传绝对路径`,
      {value,label})
  return resolve(cwd,value)
}

/**
 * 参数形状预检（不启进程）：世界点必须是 3 个有限数、像素必须是 2 个有限数、role 只能是 fit/check，
 * 且必须给 intrinsics 或 lens 之一。数值/几何层面的判定（点数、共线、共面）由求解器负责，不在这里重复。
 */
export function preflightCameraFitRequest(request:CameraFitRequest):void{
  if(!Array.isArray(request.correspondences)||request.correspondences.length===0)
    throw new CameraFitError('CAMERA_FIT_INPUT_INVALID','correspondences 必须是非空数组',{})
  request.correspondences.forEach((entry,index)=>{
    const where=`correspondences[${index}]`
    if(entry===null||typeof entry!=='object')
      throw new CameraFitError('CAMERA_FIT_INPUT_INVALID',`${where} 必须是对象`,{index})
    if(!Array.isArray(entry.world)||entry.world.length!==3||entry.world.some(value=>typeof value!=='number'||!Number.isFinite(value)))
      throw new CameraFitError('CAMERA_FIT_INPUT_INVALID',`${where}.world 必须是 3 个有限数`,{index})
    if(!Array.isArray(entry.pixel)||entry.pixel.length!==2||entry.pixel.some(value=>typeof value!=='number'||!Number.isFinite(value)))
      throw new CameraFitError('CAMERA_FIT_INPUT_INVALID',`${where}.pixel 必须是 2 个有限数`,{index})
    if(entry.role!==undefined&&entry.role!=='fit'&&entry.role!=='check')
      throw new CameraFitError('CAMERA_FIT_INPUT_INVALID',`${where}.role 只能是 fit 或 check`,{index,role:entry.role})
  })
  if(request.intrinsics===undefined&&request.lens===undefined)
    throw new CameraFitError('CAMERA_FIT_INTRINSICS_REQUIRED',
      '必须给 intrinsics（已知 K：fx/fy/cx/cy/width/height）或 lens（按镜头 FOV、传感器、消失点或带理由的焦距假设）',
      {fields:['intrinsics','lens']})
  if(request.intrinsics!==undefined&&request.lens!==undefined)
    throw new CameraFitError('CAMERA_FIT_INPUT_INVALID','intrinsics 与 lens 只能给一个',{})
}

/** 子进程 argv：解释器 + 脚本 + `--input -`（请求 JSON 从 stdin 走，不落临时文件）。 */
export function cameraFitArgv(options:{python:string;script:string}):string[]{
  return [options.python,options.script,'--input','-']
}

/**
 * 共用 operation：调隔离 Python 解 PnP，返回结构化读数。
 * 成功即返回读数；任何可预期失败抛 {@link CameraFitError}（含稳定 code），不返回半份结果。
 */
export async function fitCamera(options:CameraFitCallOptions):Promise<CameraFitResult>{
  preflightCameraFitRequest(options)
  if(!isAbsolute(options.script)&&!options.cwd)
    throw new CameraFitError('CAMERA_FIT_CWD_UNRESOLVED',`script 是相对路径（${options.script}）但没有给 cwd`,{value:options.script,label:'script'})
  const cwd=options.cwd?resolve(options.cwd):undefined
  const script=cwd?resolve(cwd,options.script):options.script
  const request:Record<string,unknown>={
    correspondences:options.correspondences,
    ...(options.worldUnit!==undefined?{worldUnit:options.worldUnit}:{}),
    ...(options.intrinsics!==undefined?{intrinsics:options.intrinsics}:{}),
    ...(options.lens!==undefined?{lens:options.lens}:{}),
    ...(options.options!==undefined?{options:options.options}:{}),
  }
  let payload:string
  try{ payload=JSON.stringify(request) }
  catch(error){ throw new CameraFitError('CAMERA_FIT_INPUT_NOT_SERIALISABLE',`请求无法序列化成 JSON：${String(error)}`,{}) }
  const timeoutMs=options.timeoutMs??DEFAULT_TIMEOUT_MS
  const timeoutSignal=AbortSignal.timeout(timeoutMs)
  const signal=options.signal?AbortSignal.any([options.signal,timeoutSignal]):timeoutSignal
  let child
  try{
    child=options.subprocess.spawn({
      argv:cameraFitArgv({python:options.python,script}),
      cwd:cwd??process.cwd(),
      // 请求 JSON 从 stdin 进（{data} 写完即关），不落临时文件也不留清理负担。
      stdio:{stdin:{data:payload},stdout:{maxBytes:16_000_000},stderr:{maxBytes:64_000}},
      signal,graceMs:3000,
      // 隔离解释器纪律：显式关掉 user site（开发机上"能跑"、产品私有 HOME 下缺依赖是最常见的坑）；
      // PYTHONDONTWRITEBYTECODE：别在源码目录里落 __pycache__。
      // HF_ENDPOINT 只为遵守"HF 只走镜像"的仓库纪律（本工具不发 HF 请求）。
      env:{PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',HF_ENDPOINT:'https://hf-mirror.com'},
    })
  }catch(error){
    throw new CameraFitError('CAMERA_FIT_PYTHON_UNAVAILABLE',`无法启动求解器解释器 ${options.python}：${String(error)}`,{interpreter:options.python})
  }
  const outcome=await child.done
  const stdout=child.collected.stdout?.readFrom(0).text??''
  const stderr=child.collected.stderr?.readFrom(0).text??''
  if(options.signal?.aborted)throw new CameraFitError('CAMERA_FIT_CANCELLED','调用方已取消相机拟合',{})
  if(timeoutSignal.aborted)throw new CameraFitError('CAMERA_FIT_TIMEOUT',`相机拟合超过 ${timeoutMs} ms 被终止`,{timeoutMs})
  const lines=stdout.split('\n')
  const errorLine=lines.slice().reverse().find(line=>line.startsWith(CAMERA_FIT_ERROR_PREFIX))
  const resultLine=lines.slice().reverse().find(line=>line.startsWith(CAMERA_FIT_RESULT_PREFIX))
  if(outcome.exitCode!==0){
    if(errorLine)throw cameraFitErrorFromEnvelope(errorLine.slice(CAMERA_FIT_ERROR_PREFIX.length))
    throw new CameraFitError('CAMERA_FIT_FAILED',
      `求解器退出码 ${outcome.exitCode}（signal=${outcome.signal??'none'}）：${(stderr||stdout).slice(-800)}`,
      {exitCode:outcome.exitCode,signal:outcome.signal,interpreter:options.python})
  }
  // 退出码 0 但没有结果行 = 调用约定被破坏，不能拿"退出成功"当拟合完成。
  if(!resultLine)throw new CameraFitError('CAMERA_FIT_OUTPUT_MISSING',`求解器成功退出但没有结果行：${(stdout||stderr).slice(-800)}`,{interpreter:options.python})
  let parsed:unknown
  try{ parsed=JSON.parse(resultLine.slice(CAMERA_FIT_RESULT_PREFIX.length)) }
  catch(error){ throw new CameraFitError('CAMERA_FIT_OUTPUT_UNREADABLE',`结果行不是合法 JSON：${String(error)}`,{}) }
  return assertCameraFitResult(parsed)
}

function cameraFitErrorFromEnvelope(payload:string):CameraFitError{
  try{
    const envelope=JSON.parse(payload) as CameraFitErrorEnvelope
    const error=envelope?.error
    if(error&&typeof error.code==='string')
      return new CameraFitError(error.code,String(error.message??''),{...error})
  }catch{/* 载荷不可读时退到通用失败，不编造 code */}
  return new CameraFitError('CAMERA_FIT_FAILED',`求解器报错但错误载荷不可读：${payload.slice(0,300)}`,{})
}

/**
 * 结果契约校验：位姿/内参/重投影读数缺一块就判失败，不把半份读数交给下游建模。
 *
 * 这里**同时**把"位置字段名与尺度必须一致"钉死：尺度未定（camera.metric=false / worldUnit=unknown）时，
 * positionM 不许出现，positionInputUnits 必须有；反之亦然。字段名是消费者唯一不会过滤掉的信号，
 * 所以它属于合同，不属于注释。
 */
export function assertCameraFitResult(value:unknown):CameraFitResult{
  const report=value as Partial<CameraFitResult>|null
  const pose=report?.camera?.worldFromCamera
  if(!report||typeof report!=='object'||report.ok!==true||typeof report.camera!=='object'||report.camera===null
    ||typeof pose!=='object'||pose===null
    ||!Array.isArray(pose.rotationMatrix)||pose.rotationMatrix.length!==3
    ||!Array.isArray(pose.quaternionXyzw)||pose.quaternionXyzw.length!==4)
    throw new CameraFitError('CAMERA_FIT_OUTPUT_INVALID','求解器返回的读数缺少位姿（camera.worldFromCamera 的 rotationMatrix/quaternionXyzw）',{})
  const metric=report.camera.metric
  if(typeof metric!=='boolean')
    throw new CameraFitError('CAMERA_FIT_OUTPUT_INVALID','求解器返回的读数缺少 camera.metric（位置字段名是否等于米制必须显式声明）',{})
  try{
    cameraFitPosition(pose as CameraFitPose,metric)
  }catch(error){
    throw new CameraFitError('CAMERA_FIT_OUTPUT_INVALID',
      `求解器返回的位置字段与尺度不一致（camera.metric=${metric}）：${error instanceof Error?error.message:String(error)}`,{metric})
  }
  const blender=report.camera.blender
  const blenderPosition=blender?.locationM??blender?.locationInputUnits
  if(!Array.isArray(blenderPosition)||blenderPosition.length!==3
    ||(metric&&!Array.isArray(blender?.locationM))||(!metric&&Array.isArray(blender?.locationM))
    ||blender?.metric!==metric)
    throw new CameraFitError('CAMERA_FIT_OUTPUT_INVALID',
      'Blender 适配的位置字段与尺度不一致（尺度确定才允许 locationM，未定只能给 locationInputUnits，'
      +'blender.metric 必须与 camera.metric 相同）',{metric})
  const resolution=blender?.resolutionPx
  if(typeof blender?.sensorFit!=='string'||blender.sensorFit==='AUTO'
    ||typeof blender.shiftX!=='number'||typeof blender.shiftY!=='number'
    ||typeof blender.pixelAspect?.x!=='number'||typeof blender.pixelAspect?.y!=='number'
    ||typeof resolution?.width!=='number'||typeof resolution?.height!=='number'
    ||typeof blender.resolvesIntrinsics?.fx!=='number'
    ||typeof blender.intrinsicsReproductionErrorPx?.max!=='number')
    throw new CameraFitError('CAMERA_FIT_OUTPUT_INVALID',
      'Blender 适配缺少复现内参必需的参数（sensorFit 不能是 AUTO，且要 lens/sensor + shiftX/shiftY + '
      +'pixelAspect + resolutionPx + resolvesIntrinsics + intrinsicsReproductionErrorPx）',{})
  const viewer=report.camera.viewer
  if(!Array.isArray(viewer?.up)||viewer.up.length!==3||!Array.isArray(viewer?.forward)||viewer.forward.length!==3
    ||typeof viewer?.rollDeg!=='number'&&viewer?.rollDeg!==null
    ||viewer?.intrinsics?.reproducibleByFovAlone!==false
    ||typeof viewer?.units?.metric!=='boolean'||viewer.units.metric!==metric
    ||(metric&&(!Array.isArray(viewer.positionM)||Array.isArray(viewer.positionInputUnits)))
    ||(!metric&&(!Array.isArray(viewer.positionInputUnits)||Array.isArray(viewer.positionM))))
    throw new CameraFitError('CAMERA_FIT_OUTPUT_INVALID',
      'Viewer 适配缺少由 R 得出的 up/forward/rollDeg，或仍声称"一条 fov 就能复现内参"，'
      +'或位置字段名与尺度不一致（viewer.intrinsics.reproducibleByFovAlone 必须是 false，'
      +'viewer.units.metric 必须与 camera.metric 一致，位置只能给 positionM 或 positionInputUnits 其中一个）',{})
  const intrinsics=report.intrinsics
  if(typeof intrinsics!=='object'||intrinsics===null||typeof intrinsics.fx!=='number'||typeof intrinsics.calibrated!=='boolean')
    throw new CameraFitError('CAMERA_FIT_OUTPUT_INVALID','求解器返回的读数缺少内参（intrinsics.fx/calibrated）',{})
  const fit=report.reprojection?.fit
  if(typeof fit!=='object'||fit===null||typeof fit.stats?.rmsPx!=='number'&&fit.stats?.rmsPx!==null||!Array.isArray(fit.perPoint))
    throw new CameraFitError('CAMERA_FIT_OUTPUT_INVALID','求解器返回的读数缺少重投影读数（reprojection.fit.stats/perPoint）',{})
  if(!Array.isArray(report.warnings)||typeof report.precision?.independentCheck!=='boolean'
    ||typeof report.precision?.spatialCheck!=='boolean')
    throw new CameraFitError('CAMERA_FIT_OUTPUT_INVALID','求解器返回的读数缺少 warnings 或 precision.independentCheck/spatialCheck',{})
  return report as CameraFitResult
}

/**
 * 有界摘要：模型默认看到的就是它。**每条事实都来自读数**，只是把逐点列表压到最坏/最相关的几条，
 * 并给出"完整读数在哪"的说明；不新增任何读数里没有的结论。
 */
export function summarizeCameraFit(result:CameraFitResult,limit:number=CAMERA_FIT_SUMMARY_POINTS):Record<string,unknown>{
  const fit=result.reprojection.fit
  const check=result.reprojection.check
  const worst=[...fit.perPoint].sort((a,b)=>b.distancePx-a.distancePx).slice(0,limit)
  return {
    ok:true,
    engine:result.engine,
    conventions:result.conventions,
    input:{counts:result.input.counts,worldUnit:result.input.worldUnit,
      metresPerInputUnit:result.input.metresPerInputUnit,fitPoints:result.input.fitPoints,checkPoints:result.input.checkPoints},
    scale:result.scale,
    intrinsics:{fx:result.intrinsics.fx,fy:result.intrinsics.fy,cx:result.intrinsics.cx,cy:result.intrinsics.cy,
      width:result.intrinsics.width,height:result.intrinsics.height,distortion:result.intrinsics.distortion,
      distortionModel:result.intrinsics.distortionModel,source:result.intrinsics.source,
      calibrated:result.intrinsics.calibrated,assumptions:result.intrinsics.assumptions},
    camera:result.camera,
    identifiability:result.identifiability,
    planarAmbiguity:result.planarAmbiguity?{
      kind:result.planarAmbiguity.kind,note:result.planarAmbiguity.note,ippeError:result.planarAmbiguity.ippeError,
      reprojectionGapPx:result.planarAmbiguity.reprojectionGapPx,rotationDeltaDeg:result.planarAmbiguity.rotationDeltaDeg,
      positionDeltaM:result.planarAmbiguity.positionDeltaM,ambiguous:result.planarAmbiguity.ambiguous,
      solutions:result.planarAmbiguity.solutions?.map(item=>({worldFromCamera:item.worldFromCamera,reprojectionRmsPx:item.reprojectionRmsPx})),
    }:null,
    reprojection:{
      fit:{stats:fit.stats,worstPoints:worst.map(point=>({id:point.id,distancePx:point.distancePx,residualPx:point.residualPx,
        outlier:point.outlier??false,inFrontOfCamera:point.inFrontOfCamera})),perPointReported:fit.perPointReported},
      check:check?{stats:check.stats,points:check.perPoint.slice(0,limit).map(point=>({id:point.id,distancePx:point.distancePx,
        residualPx:point.residualPx,inFrontOfCamera:point.inFrontOfCamera})),perPointReported:check.perPointReported}:null,
    },
    precision:result.precision,
    solver:{backend:result.solver.backend,refined:result.solver.refined,ransac:result.solver.ransac,
      inputPoints:result.solver.inputPoints,options:result.solver.options,notes:result.solver.notes},
    warnings:result.warnings,
    summary:{pointsPerList:limit,
      note:'这是有界摘要：逐点明细只给残差最大的 '+limit+' 个 fit 点与前 '+limit+' 个 check 点，'
        +'完整逐点读数在本次调用的 report 字段（结构化值）。计数与统计永远是全量。'},
  }
}

/** 工具参数里的一条对应点（与 camera_fit.py 的 read_correspondences 同一形状）。 */
function correspondenceParameter(){return {type:'array' as const,required:true as const,
  description:'3D-to-2D correspondences: world coordinates (metres, Z-up) and photo pixels (top-left origin, u right, v down). '
    +'Points with role="check" **do not participate in fitting**; they provide independent checks. Supply check points to obtain independent evidence. '
    +'The same correspondence (identical world point and pixel) cannot serve as both fit and check; such duplicates are rejected. '
    +'Check points that repeat a world point with different pixels can only check intrinsics or pixel consistency; they do not validate spatial extrapolation.',
  items:{type:'object' as const,additionalProperties:false,properties:{
    world:{type:'array' as const,required:true as const,items:{type:'number' as const},
      description:'[x,y,z], in the units declared by worldUnit (metres by default).'},
    pixel:{type:'array' as const,required:true as const,items:{type:'number' as const},
      description:'[u,v], with a top-left origin, u right and v down, consistent with MuJoCo calibration and Blender rendering.'},
    id:{type:'string' as const,description:'Optional point identifier for matching residuals to objects; defaults to p1, p2, etc.'},
    role:{type:'string' as const,enum:['fit','check'],description:'fit (default, included in fitting) or check (excluded from fitting and used only for independent checks).'},
  }}}}

function intrinsicsParameter(){return {type:'object' as const,additionalProperties:false,
  description:'Known K from measured calibration (the primary path): fx/fy/cx/cy/width/height and optional distortion. Mutually exclusive with lens.',
  properties:{
    fx:{type:'number' as const,required:true as const,description:'Horizontal focal length in pixels.'},
    fy:{type:'number' as const,required:true as const,description:'Vertical focal length in pixels.'},
    cx:{type:'number' as const,description:'Principal-point u in pixels; defaults to (width-1)/2.'},
    cy:{type:'number' as const,description:'Principal-point v in pixels; defaults to (height-1)/2.'},
    width:{type:'number' as const,required:true as const,description:'Image width in pixels.'},
    height:{type:'number' as const,required:true as const,description:'Image height in pixels.'},
    distortion:{type:'array' as const,items:{type:'number' as const},
      description:'OpenCV coefficients k1,k2,p1,p2[,k3...]; omission means no distortion.'},
  }}}

function lensParameter(){return {type:'object' as const,additionalProperties:false,
  description:'Lens source when K is unavailable; mutually exclusive with intrinsics. The result records source and assumptions and **does not count as measured calibration**.',
  properties:{
    kind:{type:'string' as const,required:true as const,enum:CAMERA_FIT_LENS_KINDS,
      description:'fov uses field of view; sensor uses focal length and sensor dimensions; vanishing-points estimates focal length from vanishing points; '
        +'assumed-focal-px is a focal-length assumption with a required rationale.'},
    fovDegVertical:{type:'number' as const,description:'kind=fov: vertical field of view in degrees.'},
    fovDegHorizontal:{type:'number' as const,description:'kind=fov: horizontal field of view in degrees.'},
    focalLengthMm:{type:'number' as const,description:'kind=sensor: focal length in millimetres.'},
    sensorWidthMm:{type:'number' as const,description:'kind=sensor: sensor width in millimetres.'},
    focalPx:{type:'number' as const,description:'kind=assumed-focal-px: assumed focal length in pixels.'},
    rationale:{type:'string' as const,description:'kind=assumed-focal-px: source of this focal length; must be nonempty or the solver rejects it.'},
    directions:{type:'array' as const,description:'kind=vanishing-points: at least two pairs of orthogonal world directions and pixel vanishing points.',
      items:{type:'object' as const,additionalProperties:false,properties:{
        world:{type:'array' as const,required:true as const,items:{type:'number' as const},description:'[x,y,z] world direction in the metric Z-up frame.'},
        pixel:{type:'array' as const,required:true as const,items:{type:'number' as const},description:'[u,v] pixel vanishing point for this direction in the photo.'},
        label:{type:'string' as const,description:'Direction identifier, such as vertical/x/y, for inspecting constraint pairs.'},
      }}},
    width:{type:'number' as const,required:true as const,description:'Image width in pixels.'},
    height:{type:'number' as const,required:true as const,description:'Image height in pixels.'},
    cx:{type:'number' as const,description:'Principal-point u in pixels; defaults to (width-1)/2.'},
    cy:{type:'number' as const,description:'Principal-point v in pixels; defaults to (height-1)/2.'},
  }}}

function optionsParameter(){return {type:'object' as const,additionalProperties:false,
  description:'Solver options. Omission uses defaults: RANSAC auto and LM refinement.',
  properties:{
    ransac:{type:'string' as const,enum:['auto','true','false'],
      description:'auto (default, enables RANSAC outlier rejection with at least 6 fit points), true, or false.'},
    reprojectionThresholdPx:{type:'number' as const,description:'RANSAC inlier threshold in pixels; defaults to 3.'},
    iterations:{type:'integer' as const,description:'Maximum RANSAC iterations; defaults to 1000.'},
    confidence:{type:'number' as const,description:'RANSAC confidence; defaults to 0.99.'},
    seed:{type:'integer' as const,description:'RANSAC random seed (default 0); fixing it makes results reproducible.'},
    refine:{type:'string' as const,enum:['true','false'],description:'LM refinement; defaults to true.'},
    planarGapTolerancePx:{type:'number' as const,
      description:'Tolerance for ambiguity between two planar solutions, in pixels (default 1). A difference below this tolerance, or below 3 times the fit RMS, is classified as ambiguous.'},
  }}}

/** 把工具参数字符串化的布尔/整数转回请求的原生类型（工具 schema 只认 type/enum/const，没有 boolean 之外的花样）。 */
function optionsFromArgs(args:Record<string,unknown>):CameraFitOptionsRequest|undefined{
  const raw=args.options
  if(raw===undefined)return undefined
  if(typeof raw!=='object'||raw===null||Array.isArray(raw))
    throw new CameraFitError('CAMERA_FIT_INPUT_INVALID','options 必须是对象',{})
  const source=raw as Record<string,unknown>
  const out:CameraFitOptionsRequest={}
  if(source.ransac!==undefined){
    if(source.ransac==='auto')out.ransac='auto'
    else if(source.ransac==='true')out.ransac=true
    else if(source.ransac==='false')out.ransac=false
    else throw new CameraFitError('CAMERA_FIT_INPUT_INVALID','options.ransac 只能是 auto/true/false',{value:source.ransac})
  }
  for(const key of ['reprojectionThresholdPx','confidence','planarGapTolerancePx'] as const){
    const value=source[key]
    if(value===undefined)continue
    if(typeof value!=='number'||!Number.isFinite(value))
      throw new CameraFitError('CAMERA_FIT_INPUT_INVALID',`options.${key} 必须是有限数`,{value})
    out[key]=value
  }
  for(const key of ['iterations','seed'] as const){
    const value=source[key]
    if(value===undefined)continue
    if(typeof value!=='number'||!Number.isInteger(value))
      throw new CameraFitError('CAMERA_FIT_INPUT_INVALID',`options.${key} 必须是整数`,{value})
    out[key]=value
  }
  if(source.refine!==undefined){
    if(source.refine!=='true'&&source.refine!=='false')
      throw new CameraFitError('CAMERA_FIT_INPUT_INVALID','options.refine 只能是 true/false',{value:source.refine})
    out.refine=source.refine==='true'
  }
  return out
}

/**
 * 薄注册：把 `camera_fit` 交给原生 tools 注册表。调用方（下层插件）在 `apply` 里调用，
 * 并自行声明 inject 含 `tools` 与 `subprocess`——本函数不新建插件、不持有状态。
 * @returns 注销函数（插件卸载时调用）。
 */
export function registerCameraFitTools(ctx:Context,config:CameraFitConfig={}){
  const subprocess=ctx.get('subprocess')
  return ctx.tools.register(defineTool({
    name:'camera_fit',
    description:'Fit camera pose from known 3D world points (metres, Z-up) and corresponding photo pixels using PnP in isolated Python with OpenCV. '
      +'The primary path uses known K (intrinsics: fx/fy/cx/cy/width/height and optional distortion). Without K, lens can use field of view, '
      +'sensor dimensions, vanishing points, or a justified focal-length assumption; the result records sources and assumptions and is not measured calibration. Returns reprojected '
      +'pixels and residuals for each correspondence, pose (worldFromCamera: rotationMatrix/quaternionXyzw plus position, consistent with sim-mujoco calibration: '
      +'camera x right, y up, looking along -z; world=R*p_cam+t). Position field names reflect scale: positionM is used only when scale is known; '
      +'worldUnit="unknown" uses positionInputUnits without an M suffix. Also returns FOV and fields usable directly in Blender '
      +'(locationM/rotationQuaternionXyzw/sensorFit/lensMm/sensorWidthMm/shiftX/shiftY/pixelAspect/resolutionPx, '
      +'installing this complete set together reproduces the supplied K, including an off-centre principal point and fx!=fy), and native Viewer fields (positionM/quaternion/up/forward/target/'
      +'fov_y_deg plus complete K; position field names likewise reflect scale. OrbitControls.update() overwrites quaternion and removes roll; '
      +'see viewer.rollNote). '
      +'Points with role="check" are excluded from fitting and used only for independent checks. Without check points there is no independent evidence; checks that repeat world points do not validate spatial extrapolation. '
      +'Duplicate correspondences with identical world points and pixels, including duplicates across fit and check, are rejected. '
      +'Planar point sets return two solutions and an ambiguity verdict; collinear points are rejected. Low residuals do not establish measured accuracy or a unique pose.',
    parameters:{
      correspondences:correspondenceParameter(),
      worldUnit:{type:'string',enum:CAMERA_FIT_WORLD_UNITS,
        description:'World-point units (default m). "unknown" means unresolved scale: solve normalized coordinates, keep position in input units, and make no absolute-scale claim.'},
      intrinsics:intrinsicsParameter(),
      lens:lensParameter(),
      options:optionsParameter(),
      detail:{type:'string',enum:['summary','full'],
        description:'Presentation detail for result: summary (default) is a bounded summary showing only the worst point residuals; '
          +'full returns raw reading JSON (at most 200 point records per group; counts and statistics remain complete). Complete structured readings are always in report.'},
    },
    output:{
      schema:{type:'object',additionalProperties:false,properties:{
        result:{type:'string',required:true},report:{type:'json',required:true}}},
      render:(_args,value)=>{const blocks:ContentBlock[]=[{type:'text',text:value.result}];return blocks},
    },
    async execute(args,exec){
      const python=resolveCameraFitPython(config)
      if(!python)
        throw new CameraFitError('CAMERA_FIT_PYTHON_UNCONFIGURED',
          '没有配置相机拟合解释器：请在插件 config 里给 python，或设置 LYAPUNOV_CAMERA_FIT_PYTHON 指向一个装好 '
          +'opencv-python-headless 与 numpy 的隔离 venv（python3 -m venv <venv> && <venv>/bin/pip install '
          +'opencv-python-headless numpy）',
          {script:config.script??fileURLToPath(CAMERA_FIT_SCRIPT_URL)})
      if(!subprocess)
        throw new CameraFitError('CAMERA_FIT_SUBPROCESS_UNAVAILABLE','缺少 subprocess 服务：调用方插件 inject 需要包含 subprocess',{})
      const cwd=cameraFitTaskCwd(exec,config)
      const script=config.script??fileURLToPath(CAMERA_FIT_SCRIPT_URL)
      const options=optionsFromArgs(args as Record<string,unknown>)
      const result=await fitCamera({
        subprocess,python,script,...cwd?{cwd}:{},
        correspondences:args.correspondences as CameraCorrespondence[],
        ...(args.worldUnit!==undefined?{worldUnit:args.worldUnit as CameraFitWorldUnit}:{}),
        ...(args.intrinsics!==undefined?{intrinsics:args.intrinsics as CameraIntrinsics}:{}),
        ...(args.lens!==undefined?{lens:args.lens as CameraLens}:{}),
        ...(options!==undefined?{options}:{}),
        ...(config.timeoutMs!==undefined?{timeoutMs:config.timeoutMs}:{}),
        signal:exec.signal,
      })
      return {
        result:args.detail==='full'?JSON.stringify(result):JSON.stringify(summarizeCameraFit(result)),
        report:result as unknown as JsonValue,
      }
    },
  }))
}
