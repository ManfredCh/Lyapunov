/** SAM3 输出仅为来源图像上的二维分割；不会把 mask 冒充三维实体。 */
export interface SegmentationSource {
  sceneId:string
  sceneRevision:number
  frameId:string
  worldId?:string
  worldGeneration?:number
  stepIndex?:number
  camera?:Record<string,unknown>
}
export interface Sam3Request {
  requestId:string
  imagePath:string
  textPrompt?:string
  boxPrompts?:Array<{boxXYXY:[number,number,number,number];positive:boolean}>
  source:SegmentationSource
  confidenceThreshold?:number
}
export interface Sam3Result {
  provider:'sam3'
  requestId:string
  source:SegmentationSource
  sourceModel:{repository:string;commit:string;checkpoint:string}
  image:{uri:string;width:number;height:number;mimeType:'image/png'}
  overlay:{uri:string;mimeType:'image/png'}
  masks:Array<{id:string;uri:string;mimeType:'image/png';boxXYXY:[number,number,number,number];score:number;label?:string;pixelCount:number}>
  emptyResult:boolean
  inferenceSeconds:number
}
