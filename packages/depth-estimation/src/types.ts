/** 单目相对深度估计的请求/结果合同。数值语义固定为“相对深度”，不出现米制或置信度字段。 */
/** 来源是可选的：网络照片/素材库里导出的单图没有 scene/world/frame，只有需要时字段才出现。 */
export interface DepthSource { sceneId?:string;sceneRevision?:number;worldId?:string;worldGeneration?:number;frameId?:string;stepIndex?:number;camera?:Record<string,unknown> }
/** 输入引用：只接受文件路径或 file: URI；相对路径按调用会话的 cwd 解析。 */
export interface DepthImageRef { path?:string;uri?:string }
export interface DepthParams {
  /** 推理设备。CPU 为默认，避免抢占他人 GPU；'cuda' 只在显式指定时使用。 */
  device?:'cpu'|'cuda'
  /** 模型输入短边尺寸（预处理后的短边，处理器保证 14 的倍数）。默认 518（权重自带配置）。 */
  modelInputSize?:number
  /** 预览 PNG 的长边上限，默认 1024；只影响可视化，不影响 npy。 */
  previewMaxSide?:number
  /** 可视化归一化分位点（只影响 PNG 灰度/彩色映射，不改 npy 数值）。 */
  lowPercentile?:number
  highPercentile?:number
}
export interface DepthEstimationRequest { requestId:string;image:DepthImageRef;params?:DepthParams;source?:DepthSource }
/** 产物引用：只记录运行层**真的核过**的事实（存在、非空、落在本次产物目录内）。哈希不在推理期重算。 */
export interface DepthArtifact { type:string;path:string;uri:string;size_bytes:number;metadata?:Record<string,unknown> }
export interface DepthSizes { width:number;height:number }
/** 模型来源身份；revision 为空时 revisionSource='unavailable'，调用方必须把它当缺口而不是默认值。 */
export interface DepthModelIdentity { modelId:string;revision:string|null;revisionSource:'manifest'|'unavailable';license:string|null;architecture:string|null;weightsSha256:string|null;weightsBytes:number|null;directory:string;maxDepthConfig:number|null;depthEstimationType:string|null }
/** 数值读数。常量预测（standardDeviation=0）是有效输出，用 constant 标出而不是失败。 */
export interface DepthStatistics { min:number;max:number;mean:number;std:number;percentiles:{p2:number;p50:number;p98:number};zeroFraction:number;nonFiniteCount:number;validPixels:number;constant:boolean }
/** worker 单条结构化结果的形状（stdout 的 LYAPUNOV_RESULT= 行）。 */
export interface DepthWorkerArtifact { type:string;path:string;bytes:number;note?:string }
export interface DepthWorkerResult { artifacts:DepthWorkerArtifact[];metadata:Record<string,unknown> }
export interface DepthWorkerError { error:{ code:string;message:string;detail?:unknown } }
export interface DepthOutputSummary {
  artifacts:DepthArtifact[]
  image:{ path:string;bytes:number;width:number;height:number }
  sizes:{ input:DepthSizes;modelInput:DepthSizes;modelOutput:DepthSizes;fullDepth:DepthSizes;preview:DepthSizes }
  depth:{ relative:true;metric:false;largerMeans:'closer';scale:string;dtype:'float32';statistics:DepthStatistics }
  preprocessing:Record<string,unknown>
  model:DepthModelIdentity
  /** 真实缺口清单（例如权重目录缺 manifest 导致 revision 未知），不是错误也不伪造。 */
  gaps:string[]
  /** 本次运行的产物目录（worker 写入；每次请求一个独立目录）。 */
  outputDirectory:string
}
/** 图像交付读数：预览图有没有真的进入模型上下文（没有就写明原因，不让人以为看到了图）。 */
export interface DepthImageDelivery { mode:'tool-result'|'job-notice'|'none';attached:number;error?:string }
export interface DepthEstimationResult { provider:'depth-anything-v2';requestId:string;source?:DepthSource;output:DepthOutputSummary;runtime:{ worker:string;python:string;device:'cpu'|'cuda';packages:Record<string,string> };imageDelivery?:DepthImageDelivery }
