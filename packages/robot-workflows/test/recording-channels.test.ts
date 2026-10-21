/**
 * P7C：Recording 逐通道产物判据回归（纯文件层，不启动物理）。
 *
 * 钉住的是：RGB/相机Z深度/LiDAR range **分源**登记、只按实际落盘计数、缺件读得到、
 * 未采到的通道不得显示完成、summary 真的把 source/channels 发给面板、录制相对路径可读回。
 *
 * 运行：`bun test packages/robot-workflows/test/recording-channels.test.ts`
 */
import {describe,expect,test} from "bun:test"
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {pathToFileURL} from "node:url"
import {captureRecordingLidarResult,captureRecordingResult,readRecordingManifest,readRecordingResource,recordingChannelUnavailable,recordingDirectory,recordingSummary,recordCameraChannels,writeRecordingManifest,type RecordingManifest} from "../src/recording-files.ts"
import {SimulationRecording,accumulateRecordingElapsed,recordingAttributionMismatch} from "../src/recording.ts"

const manifest=(id:string):RecordingManifest=>({recordingId:id,sessionRef:"session-1",runId:"run-1",sceneId:"scene-1",status:"recording",createdAt:"2026-10-16T00:00:00.000Z",maxDurationS:30,frameCount:0,eventCount:0,segments:[],resources:[],missing:[]})

async function fixture(directory:string,name:string,bytes:number){const path=join(directory,name);await writeFile(path,Buffer.alloc(bytes,7));return pathToFileURL(path).href}

describe("P7C 逐通道录制产物",()=>{
 test("RGB 与相机Z深度各记一条通道，引用录制目录内副本且可读回",async()=>{
  const root=await mkdtemp(join(tmpdir(),"recording-channels-")),source=await mkdtemp(join(tmpdir(),"recording-source-"))
  try{
   const rgb=await fixture(source,"cam.png",64),depth=await fixture(source,"cam-depth.npy",128)
   const m=manifest("recording-channels-a")
   await captureRecordingResult(root,m,{source:{name:"camera_capture_multi",callId:"cap-1",kind:"provider"},result:{worldId:"world-1",generation:1,sceneRevision:2,stepIndex:10,simTime:0.5,frameId:"frame-10",captureId:"cap-1",cameras:[{cameraName:"robot-a/arm/wrist",parentEntityId:"robot-a",parentBodyName:"arm",rgb:{uri:rgb,mimeType:"image/png"},depth:{uri:depth,mimeType:"application/x-npy",units:"m"},calibration:{intrinsics:{fx:1,fy:1,cx:0,cy:0,width:640,height:480}}}]}})
   // plugin 会在采集上下文补订阅帧步号与真实步差；这里按同一路径先补上，供样本同步差判据。
   m.captures![0]!.targetStepIndex=8;m.captures![0]!.stepDrift=2;m.captures![0]!.synchronized=false
   await recordCameraChannels(root,m,["rgb","camera-depth"])
   await writeRecordingManifest(root,m)
   const rgbStat=m.channels!.find(row=>row.channel==="rgb")!
   const depthStat=m.channels!.find(row=>row.channel==="camera-depth")!
   expect(rgbStat.frames).toBe(1)
   expect(rgbStat.unit).toBe("png-rgb-8bit")
   expect(rgbStat.files).toHaveLength(1)
   expect(depthStat.unit).toBe("m-axial-z")
   expect(depthStat.files[0]!.uri).toStartWith("resources/")
   // P7C-review：逐样本真身份落进通道元数据；samples 长度必须等于 frames。
   for(const stat of [rgbStat,depthStat]){
    expect(stat.samples).toHaveLength(stat.frames)
    expect(stat.samples![0]!.captureId).toBe("cap-1")
    expect(stat.samples![0]!.frameId).toBe("frame-10")
    expect(stat.samples![0]!.stepIndex).toBe(10)
    expect(stat.samples![0]!.generation).toBe(1)
    expect(stat.samples![0]!.simTime).toBe(0.5)
    expect(stat.samples![0]!.parentEntityId).toBe("robot-a")
    expect(stat.samples![0]!.parentBodyName).toBe("arm")
    expect(stat.samples![0]!.targetStepIndex).toBe(8)
    expect(stat.samples![0]!.stepDrift).toBe(2)
    expect(stat.samples![0]!.synchronized).toBe(false)
    expect(stat.samples![0]!.files).toHaveLength(1)
    expect(stat.samples![0]!.files[0]!.sampleIndex).toBe(0)
   }
   // RGB 与相机Z深度共享同一 captureId/frameId：界面据此保持配对。
   expect(rgbStat.samples![0]!.captureId).toBe(depthStat.samples![0]!.captureId)
   expect(rgbStat.samples![0]!.frameId).toBe(depthStat.samples![0]!.frameId)
   // 相对副本真实存在且能按 manifest 授权读回
   const read=await readRecordingResource(root,m.recordingId,depthStat.files[0]!.uri)
   expect(read.data.length).toBe(128)
   expect(read.mimeType).toBe("application/x-npy")
   // summary 真的发布 source/channels（面板才能显示实际范围）
   const summary=recordingSummary(m,"session-1") as any
   expect(summary.channels).toHaveLength(2)
   expect(m.captures![0]!.targetFrameId).toBeUndefined() // 由 plugin 在订阅帧上下文里补，纯文件层不写
  }finally{await rm(root,{recursive:true,force:true});await rm(source,{recursive:true,force:true})}
 })

 test("LiDAR range 四文件分源登记，量测统计抄真实回执；与相机通道分开",async()=>{
  const root=await mkdtemp(join(tmpdir(),"recording-lidar-")),source=await mkdtemp(join(tmpdir(),"recording-lidar-src-"))
  try{
   const range=await fixture(source,"scan-range.npy",256),valid=await fixture(source,"scan-valid.npy",32),hit=await fixture(source,"scan-hit.npy",64),preview=await fixture(source,"scan-preview.png",16)
   const m=manifest("recording-lidar-a")
   await captureRecordingLidarResult(root,m,{source:{name:"camera_lidar_scan",callId:"lidar-1",kind:"provider"},result:{worldId:"world-1",generation:1,sceneRevision:2,stepIndex:11,simTime:0.6,frameId:"frame-11",captureId:"lidar-1",cameraName:"robot-a/arm/wrist",parentEntityId:"robot-a",parentBodyName:"arm",rayPattern:{rangeM:20},range:{uri:range,mimeType:"application/x-npy",units:"m",shape:[3,181],dtype:"float64"},valid:{uri:valid,mimeType:"application/x-npy",shape:[3,181],dtype:"bool"},hitGeom:{uri:hit,mimeType:"application/x-npy",shape:[3,181],dtype:"int32"},preview:{uri:preview,mimeType:"image/png"},rayCount:543,validCount:313,noReturnCount:230,rangeMinM:1.697,rangeMaxM:11.79,rangeMeanM:4.095}})
   await writeRecordingManifest(root,m)
   const stat=m.channels!.find(row=>row.channel==="lidar-range")!
   expect(stat.frames).toBe(1)
   expect(stat.unit).toBe("m-euclidean-range")
   expect(stat.files.map(file=>file.role).sort()).toEqual(["hitGeom","preview","range","valid"])
   expect(stat.validCount).toBe(313)
   expect(stat.noReturnCount).toBe(230)
   expect(stat.rangeMeanM).toBeCloseTo(4.095,3)
   expect(stat.files.find(file=>file.role==="range")!.unit).toBe("m")
   // P7C-review：range/valid/hitGeom/preview 是同一次量测，共享一个 sampleIndex、只算一帧。
   expect(stat.samples).toHaveLength(1)
   expect(stat.samples![0]!.captureId).toBe("lidar-1")
   expect(stat.samples![0]!.stepIndex).toBe(11)
   expect(stat.samples![0]!.simTime).toBe(0.6)
   expect(stat.samples![0]!.rangeM).toBe(20)
   expect(stat.samples![0]!.files).toHaveLength(4)
   expect(stat.samples![0]!.files.every(file=>file.sampleIndex===0)).toBe(true)
   expect(m.lidarCaptures).toHaveLength(1)
   expect(m.captures ?? []).toHaveLength(0)
   const receipt=JSON.parse(await readFile(join(recordingDirectory(root,m.recordingId),m.lidarCaptures![0]!.receiptPath),"utf8"))
   expect(receipt.outputDir).toBeUndefined()
   expect(receipt.range.uri).toStartWith("resources/")
  }finally{await rm(root,{recursive:true,force:true});await rm(source,{recursive:true,force:true})}
 })

 test("请求了却采不到的通道：frames=0 且保留原因，不得显示完成",()=>{
  const m=manifest("recording-unavailable-a")
  recordingChannelUnavailable(m,"lidar-range","robot-a/arm/wrist","m-euclidean-range","SENSOR_UNAVAILABLE: 当前Provider未提供模拟LiDAR量测接口")
  const stat=m.channels!.find(row=>row.channel==="lidar-range")!
  expect(stat.frames).toBe(0)
  expect(stat.files).toEqual([])
  expect(stat.unavailable).toContain("SENSOR_UNAVAILABLE")
 })

 test("缺件不静默：源文件不存在时登记进 missing，录制本身不抛",async()=>{
  const root=await mkdtemp(join(tmpdir(),"recording-missing-"))
  try{
   const m=manifest("recording-missing-a")
   await captureRecordingResult(root,m,{source:{name:"camera_capture_multi",callId:"cap-x",kind:"provider"},result:{worldId:"world-1",generation:1,sceneRevision:2,stepIndex:1,frameId:"frame-1",captureId:"cap-x",cameras:[{cameraName:"robot-a/arm/wrist",rgb:{uri:pathToFileURL(join(tmpdir(),"does-not-exist-"+Date.now()+".png")).href,mimeType:"image/png"},depth:{uri:pathToFileURL(join(tmpdir(),"does-not-exist-"+Date.now()+"-d.npy")).href,mimeType:"application/x-npy",units:"m"}}]}})
   expect(m.missing.length).toBeGreaterThan(0)
   expect(m.missing[0]!.reason).toContain("ENOENT")
   await writeRecordingManifest(root,m)
   const reread=await readRecordingManifest(root,m.recordingId)
   expect(reread.missing.length).toBe(m.missing.length)
  }finally{await rm(root,{recursive:true,force:true})}
 })
})

describe("P7C-review 固定来源归属与换代替换",()=>{
 const frame=(generation:number,stepIndex:number)=>({worldId:"world-1",generation,sceneRevision:1,stepIndex,simTime:stepIndex/100,frameId:`frame-${generation}-${stepIndex}`,entities:[]}) as any

 test("同一相机重挂到另一台机器人/换代后，回执不再属于固定来源",()=>{
  const bound={worldId:"world-1",generation:1,parentEntityId:"robot-a",parentBodyName:"a_head",cameraName:"record-cam/sensor",resolvedCameraName:"record-cam/sensor"}
  expect(recordingAttributionMismatch({worldId:"world-1",generation:1,cameras:[{cameraName:"record-cam/sensor",parentEntityId:"robot-a",parentBodyName:"a_head"}]},bound)).toBeUndefined()
  expect(recordingAttributionMismatch({worldId:"world-1",generation:2,cameras:[{cameraName:"record-cam/sensor",parentEntityId:"robot-a",parentBodyName:"a_head"}]},bound)).toBe("source-generation-changed")
  expect(recordingAttributionMismatch({worldId:"world-1",generation:1,cameras:[{cameraName:"record-cam/sensor",parentEntityId:"robot-b",parentBodyName:"b_head"}]},bound)).toBe("source-attribution-mismatch")
  // LiDAR 回执的顶层父身份同码同义
  expect(recordingAttributionMismatch({worldId:"world-1",generation:1,cameraName:"record-cam/sensor",parentEntityId:"robot-b",parentBodyName:"b_head"},bound)).toBe("source-attribution-mismatch")
  expect(recordingAttributionMismatch({worldId:"world-1",generation:1,cameraName:"record-cam/sensor",parentEntityId:"robot-a",parentBodyName:"a_head"},bound)).toBeUndefined()
 })

 test("订阅帧门把非本代次帧挡在 events.jsonl 之外并触发终止回调",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"recording-gate-"))
  try{
   const recorder=new SimulationRecording(directory,"session-1");let listener:((frame:any)=>void)|undefined
   const sim:any={observe:async()=>frame(1,1),subscribeFrames:(_world:string,next:(frame:any)=>void)=>{listener=next;return()=>{}}}
   const accepted:number[]=[],rejected:number[]=[]
   await recorder.start(sim,"world-1",value=>accepted.push(value.stepIndex),frame(1,1),{accept:value=>value.generation===1,onReject:value=>rejected.push(value.generation)})
   listener!(frame(1,2));listener!(frame(1,3));listener!(frame(2,1))
   const stats=await recorder.stop()
   expect(accepted).toEqual([1,2,3]) // seed + 两帧同代；gen2 不接收
   expect(rejected).toEqual([2])
   const events=await readFile(join(directory,"events.jsonl"),"utf8")
   expect(events).not.toContain('"generation":2')
   expect(stats.frameCount).toBe(3)
  }finally{await rm(directory,{recursive:true,force:true})}
 })
})


describe("V10 录制累计时长（仿真秒）",()=>{
 test("simTime=100 开始、采到 102 ⇒ 累计 2s；暂停无新帧不增长；换代不把差值串进本段",()=>{
  const start={generation:1,simTime:100},next={generation:1,simTime:102}
  const elapsed=accumulateRecordingElapsed(0,start,next)
  expect(elapsed).toBe(2)
  // 暂停没有新 frame 时调用方不会调用累加器；再次收到同一帧也不增长。
  expect(accumulateRecordingElapsed(elapsed,next,{generation:1,simTime:102})).toBe(2)
  // 负 delta/换代不累加；不是墙钟，也不是绝对 simTime。
  expect(accumulateRecordingElapsed(elapsed,next,{generation:1,simTime:101})).toBe(2)
  expect(accumulateRecordingElapsed(elapsed,next,{generation:2,simTime:150})).toBe(2)
 })
 test("manifest/recordingSummary 可选投影 elapsedS；旧记录缺字段不编造",()=>{
  const current=manifest("recording-elapsed-current")
  current.elapsedS=2
  const projected=recordingSummary(current,"session-1") as any
  expect(projected.elapsedS).toBe(2)
  expect(projected.maxDurationS).toBe(30)
  const old=manifest("recording-elapsed-old")
  const oldProjected=recordingSummary(old,"session-1") as any
  expect("elapsedS" in oldProjected).toBe(false)
 })
})
