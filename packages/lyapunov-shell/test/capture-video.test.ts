/**
 * 连续视频核心回归：容器/编码如实解析、真实字节与时长、缺 MediaRecorder/缺画布的具名失败、
 * 记录整形与上传封包。全部离线；真实浏览器 WebM 解码由主控在 Edge 里独立验证（不在此文件冒充）。
 */
import {test,expect} from 'bun:test'
import {ContinuousVideoRecorder,captureVideoRecordOf,frameVideoPayload,pickSupportedVideoMimeType,videoCodecFace,videoFileExtension,browserMediaRecorderCtor,type MediaRecorderCtor,type MediaRecorderLike} from '../src/capture-video.ts'

const stream=()=>(({getTracks:()=>[]}) as unknown as MediaStream)
const target=()=>({stream:stream(),width:640,height:480})

class FakeRecorder implements MediaRecorderLike {
  state:"inactive"|"recording"|"paused"="inactive"
  mimeType=""
  ondataavailable:((event:{data:Blob})=>void)|null=null
  onerror:((event:{error?:unknown})=>void)|null=null
  onstop:(()=>void)|null=null
  constructor(_stream:MediaStream,public options?:{mimeType?:string}){ this.mimeType=options?.mimeType??"video/webm" }
  static isTypeSupported=(mime:string)=>mime.startsWith("video/webm")
  start(){ this.state="recording" }
  stop(){ this.state="inactive"; this.ondataavailable?.({data:new Blob([new Uint8Array([1,2,3,4])],{type:this.mimeType})}); this.onstop?.() }
}

test('视频容器/编码/后缀如实解析：WebM 不会变成 MP4',()=>{
  expect(videoCodecFace("video/webm;codecs=vp9")).toMatchObject({container:"webm",codec:"vp9"})
  expect(videoCodecFace("video/webm;codecs=vp8")).toMatchObject({container:"webm",codec:"vp8"})
  expect(videoCodecFace("video/webm")).toMatchObject({container:"webm",codec:"webm"})
  expect(videoCodecFace("video/mp4;codecs=avc1")).toMatchObject({container:"mp4",codec:"avc1"})
  expect(videoCodecFace("")).toMatchObject({container:"unknown",codec:"unknown"})
  expect(videoFileExtension("webm")).toBe("webm")
  expect(videoFileExtension("mp4")).toBe("mp4")
  expect(videoFileExtension("unknown")).toBe("bin")
})

test('只挑平台真实支持的 WebM 编码',()=>{
  expect(pickSupportedVideoMimeType(mime=>mime==="video/webm;codecs=vp8")?.codec).toBe("vp8")
  expect(pickSupportedVideoMimeType(()=>false)).toBeUndefined()
})

test('正常录制：真实字节、时长、如实容器；停止后记录器释放',async()=>{
  const recorder=new ContinuousVideoRecorder({now:()=>1_000,MediaRecorderCtor:FakeRecorder as unknown as MediaRecorderCtor,openTarget:()=>target(),frameRate:30})
  const info=recorder.start()
  expect(info).toMatchObject({container:"webm",codec:"vp9",width:640,height:480})
  expect(recorder.recording).toBe(true)
  const result=await recorder.stop("user-stop")
  expect(result.container).toBe("webm")
  expect(result.bytes).toBe(4)
  expect(result.stopReason).toBe("user-stop")
  expect(result.durationMs).toBe(0)
  expect(recorder.recording).toBe(false)
})

test('缺 MediaRecorder / 缺画布都抛具名错误，不产生半成品',async()=>{
  const noRecorder=new ContinuousVideoRecorder({now:()=>0,MediaRecorderCtor:undefined,openTarget:()=>target()})
  expect(()=>noRecorder.start()).toThrow("MEDIA_RECORDER_UNAVAILABLE")
  const noCanvas=new ContinuousVideoRecorder({now:()=>0,MediaRecorderCtor:FakeRecorder as unknown as MediaRecorderCtor,openTarget:()=>undefined})
  expect(()=>noCanvas.start()).toThrow("VIDEO_CANVAS_UNAVAILABLE")
})

test('R-005：录制结束/取消/构造失败都清掉画布手动取帧定时器（不泄漏）',async()=>{
  let stops=0
  const withStop=()=>({...target(),stop:()=>{stops++}})
  const recorder=new ContinuousVideoRecorder({now:()=>1_000,MediaRecorderCtor:FakeRecorder as unknown as MediaRecorderCtor,openTarget:withStop})
  recorder.start();await recorder.stop("user-stop")
  expect(stops).toBe(1)
  const cancelled=new ContinuousVideoRecorder({now:()=>1_000,MediaRecorderCtor:FakeRecorder as unknown as MediaRecorderCtor,openTarget:withStop})
  cancelled.start();cancelled.cancel()
  expect(stops).toBe(2)
  class ThrowingRecorder extends FakeRecorder { constructor(){ super(undefined as unknown as MediaStream); throw new Error("no recorder") } }
  const failed=new ContinuousVideoRecorder({now:()=>1_000,MediaRecorderCtor:ThrowingRecorder as unknown as MediaRecorderCtor,openTarget:withStop})
  expect(()=>failed.start()).toThrow("MEDIA_RECORDER_UNAVAILABLE")
  expect(stops).toBe(3)
})

test('记录器报错也先交出已产生字节并标出不完整',async()=>{
  class ErroringRecorder extends FakeRecorder {
    override stop(){ this.state="inactive"; this.ondataavailable?.({data:new Blob([new Uint8Array([9])],{type:this.mimeType})}); this.onerror?.({error:new Error("boom")}); this.onstop?.() }
  }
  const recorder=new ContinuousVideoRecorder({now:()=>2_000,MediaRecorderCtor:ErroringRecorder as unknown as MediaRecorderCtor,openTarget:()=>target()})
  recorder.start()
  const result=await recorder.stop("renderer-closed")
  expect(result.bytes).toBe(1)
  expect(result.error).toContain("MEDIA_RECORDER_ERROR")
  expect(result.stopReason).toBe("renderer-closed")
})

test('停止时钟取 stop 调用当刻，编码 flush/onstop 延迟不计入 media duration',async()=>{
  let clock=1_000
  class SlowStopRecorder extends FakeRecorder {
    override stop(){ this.state="inactive"; this.ondataavailable?.({data:new Blob([new Uint8Array([1])],{type:this.mimeType})}); clock+=700; this.onstop?.() }
  }
  const recorder=new ContinuousVideoRecorder({now:()=>clock,MediaRecorderCtor:SlowStopRecorder as unknown as MediaRecorderCtor,openTarget:()=>target()})
  recorder.start()
  clock=1_600 // 真实录制区间 600ms，之后 stop 内部再耗 700ms
  const result=await recorder.stop("user-stop")
  expect(result.bytes).toBe(1)
  expect(result.durationMs).toBe(600)
  expect(result.error).toBeUndefined()
})

test('停止超时标明不完整并保留实际字节，不当完整成功',async()=>{
  class SilentRecorder extends FakeRecorder {
    override stop(){ this.state="inactive"; this.ondataavailable?.({data:new Blob([new Uint8Array([1,2])],{type:this.mimeType})}); /* 永不 onstop */ }
  }
  const recorder=new ContinuousVideoRecorder({now:()=>1_000,MediaRecorderCtor:SilentRecorder as unknown as MediaRecorderCtor,openTarget:()=>target(),stopTimeoutMs:20})
  recorder.start()
  const result=await recorder.stop("user-stop")
  expect(result.bytes).toBe(2)
  expect(result.error).toContain("MEDIA_RECORDER_STOP_TIMEOUT")
  expect(result.stopReason).toBe("user-stop")
})

test('记录整形保留真实字节与必要相机采样',()=>{
  const result={blob:new Blob([new Uint8Array(10)]),bytes:10,mimeType:"video/webm;codecs=vp9",container:"webm" as const,codec:"vp9",width:640,height:480,startedAt:"2026-01-01T00:00:00.000Z",stoppedAt:"2026-01-01T00:00:02.000Z",durationMs:2000,stopReason:"completed"}
  const record=captureVideoRecordOf("vid-1","/tmp/vid-1.webm",result,{sceneId:"s",sceneRevision:3,source:"route",frameRate:30,cameraSamples:[{tMs:0,position:[0,0,0],quaternion:[0,0,0,1]}]},new Date(0).toISOString())
  expect(record).toMatchObject({videoId:"vid-1",kind:"continuous-video",sceneId:"s",container:"webm",codec:"vp9",bytes:10,durationMs:2000,source:"route"})
  expect(record.cameraSamples).toHaveLength(1)
})

test('上传封包可原样解析出 meta 与字节',async()=>{
  const blob=new Blob([new Uint8Array([7,8,9])],{type:"video/webm"})
  const buffer=await frameVideoPayload({sceneId:"s",source:"free-view"},blob)
  const view=new DataView(buffer)
  const metaLength=view.getUint32(0)
  const meta=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,4,metaLength)))
  const bytes=new Uint8Array(buffer,4+metaLength)
  expect(meta).toEqual({sceneId:"s",source:"free-view"})
  expect([...bytes]).toEqual([7,8,9])
})

test('browserMediaRecorderCtor 在无全局时返回 undefined',()=>{
  const original=(globalThis as {MediaRecorder?:unknown}).MediaRecorder
  try{ Reflect.deleteProperty(globalThis,"MediaRecorder"); expect(browserMediaRecorderCtor()).toBeUndefined() }
  finally{ if(original!==undefined)Object.defineProperty(globalThis,"MediaRecorder",{configurable:true,value:original}) }
})

test('Cancel 等到原生 onstop 才释放：ack 前拒绝新录制，迟到 ondata/onstop 不污染下一段',async()=>{
  let current:any,targetStops=0,trackStops=0
  class DeferredRecorder extends FakeRecorder{
    override stop(){this.state='inactive';this.ondataavailable?.({data:new Blob([new Uint8Array([9,9,9])],{type:this.mimeType})})}
    ack(){this.onstop?.()}
  }
  class Ctor extends DeferredRecorder{constructor(stream:MediaStream,options?:{mimeType?:string}){super(stream,options);current=this}}
  const withTarget=()=>({stream:{getTracks:()=>[{stop:()=>{trackStops++}}]} as unknown as MediaStream,width:640,height:480,stop:()=>{targetStops++}})
  const recorder=new ContinuousVideoRecorder({now:()=>1_000,MediaRecorderCtor:Ctor as unknown as MediaRecorderCtor,openTarget:withTarget})
  recorder.start()
  let settled=false
  const cancelPromise=recorder.cancel();void cancelPromise.then(()=>{settled=true})
  // 原生 onstop 之前：不能复用/开始第二段。
  expect(()=>recorder.start()).toThrow('VIDEO_CANCEL_PENDING')
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(targetStops).toBe(0)
  // 取消期间的迟到数据必须丢弃；onstop 之后才释放轨道。
  current.ondataavailable?.({data:new Blob([new Uint8Array(100)])})
  const lateStop=current.onstop
  current.ack()
  const outcome=await cancelPromise
  expect(outcome).toMatchObject({acknowledged:true})
  expect(settled).toBe(true)
  expect(targetStops).toBe(1)
  expect(trackStops).toBe(1)
  // ack 后才能重开；旧 onstop 迟到也不得结束新录制。
  const info=recorder.start()
  expect(info).toMatchObject({width:640,height:480})
  lateStop?.()
  expect(recorder.recording).toBe(true)
  current.ondataavailable?.({data:new Blob([new Uint8Array([7])],{type:current.mimeType})})
  const stopPromise=recorder.stop('user-stop')
  current.ack()
  const result=await stopPromise
  // 新段只含本段手动 1 B + stop 的 3 B，旧段 100 B 已被丢弃。
  expect(result.bytes).toBe(4)
  expect(result.error).toBeUndefined()
  expect(targetStops).toBe(2)
})

test('Stop 的 onstop ack 之前不能开始第二段；ack 后结果只含本段字节',async()=>{
  let current:any
  class DeferredStopRecorder extends FakeRecorder{
    override stop(){this.state='inactive';this.ondataavailable?.({data:new Blob([new Uint8Array([1,2,3])],{type:this.mimeType})})}
    ack(){this.onstop?.()}
  }
  class Ctor extends DeferredStopRecorder{constructor(stream:MediaStream,options?:{mimeType?:string}){super(stream,options);current=this}}
  const recorder=new ContinuousVideoRecorder({now:()=>1_000,MediaRecorderCtor:Ctor as unknown as MediaRecorderCtor,openTarget:()=>({stream:stream(),width:640,height:480})})
  recorder.start()
  const stopped=recorder.stop('user-stop')
  expect(()=>recorder.start()).toThrow('VIDEO_ALREADY_RECORDING')
  current.ack()
  const result=await stopped
  expect(result.bytes).toBe(3)
  expect(recorder.recording).toBe(false)
  // 旧段落已 onstop，允许重新开始。
  expect(recorder.start()).toMatchObject({width:640,height:480})
})

test('Cancel 在 Stop 等待期间也等同一个 onstop，并丢弃该段结果',async()=>{
  let current:any,targetStops=0
  class DeferredStopRecorder extends FakeRecorder{
    override stop(){this.state='inactive';this.ondataavailable?.({data:new Blob([new Uint8Array([5])],{type:this.mimeType})})}
    ack(){this.onstop?.()}
  }
  class Ctor extends DeferredStopRecorder{constructor(stream:MediaStream,options?:{mimeType?:string}){super(stream,options);current=this}}
  const recorder=new ContinuousVideoRecorder({now:()=>1_000,MediaRecorderCtor:Ctor as unknown as MediaRecorderCtor,openTarget:()=>({stream:stream(),width:640,height:480,stop:()=>{targetStops++}})})
  recorder.start()
  const stopped=recorder.stop('user-stop')
  const cancelled=recorder.cancel()
  expect(targetStops).toBe(0)
  current.ack()
  expect((await stopped).bytes).toBe(1)
  expect(await cancelled).toMatchObject({acknowledged:true})
  expect(targetStops).toBe(1)
  // 取消丢弃结果后仍可开始下一段。
  expect(recorder.start()).toMatchObject({width:640,height:480})
})

test('0B 停止结果明确 VIDEO_BYTES_EMPTY，不是可恢复字节',async()=>{
  class EmptyStopRecorder extends FakeRecorder{
    override stop(){this.state='inactive';queueMicrotask(()=>this.onstop?.())}
  }
  const recorder=new ContinuousVideoRecorder({now:()=>1_000,MediaRecorderCtor:EmptyStopRecorder as unknown as MediaRecorderCtor,openTarget:()=>({stream:stream(),width:640,height:480})})
  recorder.start()
  const result=await recorder.stop('user-stop')
  expect(result.bytes).toBe(0)
  expect(result.error).toContain('VIDEO_BYTES_EMPTY')
  expect(recorder.recording).toBe(false)
})

test('recorder.start 抛错也释放 target/轨道，并允许随后重新开始',async()=>{
  let targetStops=0,trackStops=0,fail=true
  class ToggleStartRecorder extends FakeRecorder{
    override start(){if(fail)throw new Error('start boom');super.start()}
  }
  const recorder=new ContinuousVideoRecorder({now:()=>1_000,MediaRecorderCtor:ToggleStartRecorder as unknown as MediaRecorderCtor,openTarget:()=>({stream:{getTracks:()=>[{stop:()=>{trackStops++}}]} as unknown as MediaStream,width:320,height:240,stop:()=>{targetStops++}})})
  expect(()=>recorder.start()).toThrow('MEDIA_RECORDER_UNAVAILABLE')
  expect(targetStops).toBe(1)
  expect(trackStops).toBe(1)
  expect(recorder.recording).toBe(false)
  fail=false
  expect(recorder.start()).toMatchObject({width:320,height:240})
  const result=await recorder.stop('user-stop')
  expect(result.bytes).toBe(4)
  expect(targetStops).toBe(2)
})

test('Cancel 超时会如实返回未确认并释放轨道，不无限等待',async()=>{
  let targetStops=0
  class SilentStopRecorder extends FakeRecorder{
    override stop(){this.state='inactive'} // 永不 onstop
  }
  const recorder=new ContinuousVideoRecorder({now:()=>1_000,MediaRecorderCtor:SilentStopRecorder as unknown as MediaRecorderCtor,openTarget:()=>({stream:stream(),width:640,height:480,stop:()=>{targetStops++}}),cancelTimeoutMs:20})
  recorder.start()
  const outcome=await recorder.cancel()
  expect(outcome.acknowledged).toBe(false)
  expect(outcome.error).toContain('MEDIA_RECORDER_CANCEL_TIMEOUT')
  expect(targetStops).toBe(1)
  expect(recorder.recording).toBe(false)
})
