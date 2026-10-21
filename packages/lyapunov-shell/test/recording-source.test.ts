/**
 * P7C：固定机器人机位 Recording 的来源/通道纯判据回归。
 *
 * 这里钉的是"面板列什么、能不能开始、开始请求带什么、请求了但没采到的通道怎么显示"——
 * 全部走 `recording-source.ts` 的真实函数，不用手写夹具假装判据。
 *
 * 运行：`bun test packages/lyapunov-shell/test/recording-source.test.ts`
 */
import {describe,expect,test} from "bun:test"
import {recordingChannelFaces,recordingFixedScope,recordingScopeLabel,recordingSourceOptions,recordingSourceReady,recordingStartInput} from "../src/recording-source.ts"

const robot=(entityId:string,name:string)=>(
 {entityId,name,transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{mujoco:{sourcePath:entityId+'.xml'}}}
)
const sceneCamera=(entityId:string,name:string,mountEntityId:string,bodyName:string)=>({
 ...robot(entityId,name),
 components:{camera:{name, fovYDeg:50, width:640, height:480, mount:{entityId:mountEntityId, bodyName, positionM:[0,0,0], quaternionXyzw:[0,0,0,1]}}},
})
/** 场景：两台机器人各挂一台同名 body（arm）与同名相机（wrist），用于验证完整机位身份区分同名。 */
const scene:any={sceneId:"scene-1",revision:3,coordinates:{units:"m",upAxis:"Z",handedness:"right",quaternion:"xyzw"},entities:[
 robot("robot-a","Robot A"),
 robot("robot-b","Robot B"),
 sceneCamera("cam-a","wrist","robot-a","arm"),
 sceneCamera("cam-b","wrist","robot-b","arm"),
]}
const receipt:any={cameras:[
 {cameraName:"cam-a/wrist",resolvedCameraName:"cam-a/wrist",entityId:"cam-a",parentEntityId:"robot-a",parentBodyName:"arm",cameraSource:"scene-camera",available:true,width:640,height:480},
 {cameraName:"cam-b/wrist",resolvedCameraName:"cam-b/wrist",entityId:"cam-b",parentEntityId:"robot-b",parentBodyName:"arm",cameraSource:"scene-camera",available:true,width:640,height:480},
 {cameraName:"native-b/wrist",resolvedCameraName:"native-b/wrist",entityId:"native-b",parentEntityId:"robot-b",parentBodyName:"arm",cameraSource:"native",available:false,reason:"engine rejected"},
 // 世界固定机位（无 parent body）：不属于 Recording，不得出现在列表里
 {cameraName:"world-cam",resolvedCameraName:"world-cam",entityId:"world-cam",available:true},
]}

describe("P7C 录制来源清单",()=>{
 test("同名 body/相机的两台机器人按完整机位身份分开",()=>{
  const options=recordingSourceOptions(scene,receipt)
  const keys=options.map(option=>option.key)
  expect(keys).toContain("robot-a/arm/cam-a/wrist")
  expect(keys).toContain("robot-b/arm/cam-b/wrist")
  expect(new Set(keys).size).toBe(keys.length)
  const a=options.find(option=>option.key==="robot-a/arm/cam-a/wrist")!
  const b=options.find(option=>option.key==="robot-b/arm/cam-b/wrist")!
  expect(a.label).toContain("Robot A")
  expect(b.label).toContain("Robot B")
  expect(a.bodyName).toBe("arm")
  expect(b.bodyName).toBe("arm")
 })
 test("V8-26：bodyName 带实体前缀时只精简可见 label，source 仍保留完整 bodyName",()=>{
  const prefixedScene:any={...scene,entities:[robot("entity_c6047d61-46d9-42ca-bc82-c901d5b16bca","franka_panda")]}
  const prefixed={cameras:[{cameraName:"entity_c6047d61-46d9-42ca-bc82-c901d5b16bca/hand/Wrist RGB-D",resolvedCameraName:"entity_c6047d61-46d9-42ca-bc82-c901d5b16bca/hand/Wrist RGB-D",entityId:"entity_c6047d61-46d9-42ca-bc82-c901d5b16bca",parentEntityId:"entity_c6047d61-46d9-42ca-bc82-c901d5b16bca",parentBodyName:"entity_c6047d61-46d9-42ca-bc82-c901d5b16bca/hand",cameraSource:"scene-camera",available:true,width:640,height:480}]}
  const option=recordingSourceOptions(prefixedScene,prefixed)[0]!
  // 可见 label 用真实机器人名 / 本地 body / 相机短名，不把实体 UUID 插进正文。
  expect(option.label).toBe("franka_panda · hand · Wrist RGB-D")
  expect(option.label).not.toContain("entity_c6047d61")
  // 身份与开始请求仍用完整 bodyName/cameraName，不改 source 结构。
  expect(option.bodyName).toBe("entity_c6047d61-46d9-42ca-bc82-c901d5b16bca/hand")
  expect(option.key).toContain("entity_c6047d61-46d9-42ca-bc82-c901d5b16bca/hand")
  const input=recordingStartInput(option,["rgb"],30,640,480)!
  expect(input.source).toEqual({robotEntityId:"entity_c6047d61-46d9-42ca-bc82-c901d5b16bca",robotName:"franka_panda",bodyName:"entity_c6047d61-46d9-42ca-bc82-c901d5b16bca/hand",cameraName:"entity_c6047d61-46d9-42ca-bc82-c901d5b16bca/hand/Wrist RGB-D"})
 })
 test("真实尺寸：Scene声明优于轮询参考K；原生配置和有效K也可继承",()=>{
  const native={cameraName:"native/wrist",parentEntityId:"robot-a",parentBodyName:"arm",available:true,cameraSource:"mjcf"}
  const declared={...scene,entities:scene.entities.map((entity:any)=>entity.entityId==="cam-a"?{...entity,components:{camera:{...entity.components.camera,width:160,height:120}}}:entity)}
  const options=recordingSourceOptions(declared,{cameras:[
   {...receipt.cameras[0],width:undefined,height:undefined,intrinsics:{width:640,height:480}},
   {...native,engineIntrinsics:{resolution:[1280,720]},intrinsics:{width:640,height:480}},
   {...native,cameraName:"native/head",intrinsics:{width:800,height:600}},
  ]})
  expect(options.find(option=>option.cameraName==="cam-a/wrist")).toMatchObject({width:160,height:120})
  expect(options.find(option=>option.cameraName==="native/wrist")).toMatchObject({width:1280,height:720})
  expect(options.find(option=>option.cameraName==="native/head")).toMatchObject({width:800,height:600})
 })
 test("世界固定机位不进 Recording 清单；不可用原生机位如实标原因",()=>{
  const options=recordingSourceOptions(scene,receipt)
  expect(options.some(option=>option.cameraName==="world-cam")).toBe(false)
  const unavailable=options.find(option=>option.key==="robot-b/arm/native-b/wrist")!
  expect(unavailable.available).toBe(false)
  expect(unavailable.reason).toBe("engine rejected")
 })
 test("Scene 声明但未读回原生的挂载机位仍在列表（标 unavailable + 原因）",()=>{
  const options=recordingSourceOptions(scene,{cameras:[{cameraName:"cam-a/wrist",resolvedCameraName:"cam-a/wrist",entityId:"cam-a",parentEntityId:"robot-a",parentBodyName:"arm",cameraSource:"scene-camera",available:true}]})
  const pending=options.find(option=>option.key==="robot-b/arm/cam-b/wrist")
  expect(pending).toBeDefined()
  expect(pending!.available).toBe(false)
  expect(pending!.reason).toBe("CAMERA_NOT_READ_BACK")
 })
 test("没有可用来源时不能开始；有来源但没选也不行",()=>{
  expect(recordingSourceReady(undefined).ok).toBe(false)
  const options=recordingSourceOptions(scene,{cameras:[]})
  expect(recordingSourceReady(options[0]).ok).toBe(false)
  const ready=recordingSourceOptions(scene,receipt).find(option=>option.available)!
  expect(recordingSourceReady(ready).ok).toBe(true)
 })
 test("开始请求固定真实来源与请求通道；非法时长/空通道返回 undefined",()=>{
  const option=recordingSourceOptions(scene,receipt).find(row=>row.key==="robot-a/arm/cam-a/wrist")!
  const input=recordingStartInput(option,["rgb","lidar-range"],30,640,480)!
  expect(input.source).toEqual({robotEntityId:"robot-a",robotName:"Robot A",bodyName:"arm",cameraName:"cam-a/wrist"})
  expect(input.channels).toEqual(["rgb","lidar-range"])
  expect(input.maxDurationS).toBe(30)
  expect(recordingStartInput(option,[],30,640,480)).toBeUndefined()
  expect(recordingStartInput(option,["rgb"],0,640,480)).toBeUndefined()
  expect(recordingStartInput(undefined,["rgb"],30,640,480)).toBeUndefined()
 })
 test("尺寸缺失、半边或非法不能开始；有效整数边界保持可用",()=>{
  const option=recordingSourceOptions(scene,receipt).find(row=>row.available)!
  for(const value of [undefined,NaN,Infinity,0,15,4097,160.5]){
   expect(recordingStartInput(option,["rgb"],30,value,120)).toBeUndefined()
   expect(recordingStartInput(option,["rgb"],30,160,value)).toBeUndefined()
  }
  expect(recordingStartInput(option,["rgb"],30,16,4096)).toMatchObject({width:16,height:4096})
  const native={cameraName:"robot-a/unknown",parentEntityId:"robot-a",parentBodyName:"arm",available:true}
  for(const size of [{},{height:240},{width:160},{width:15,height:120},{width:4097,height:120}]){
   const projected=recordingSourceOptions(scene,{cameras:[{...native,...size}]}).find(row=>row.cameraName===native.cameraName)!
   expect(projected.width).toBeUndefined()
   expect(projected.height).toBeUndefined()
  }
 })
 test("部分成功后不可用：同时保留失败原因和已采帧数",()=>{
  for(const channel of ["rgb","camera-depth","lidar-range"]){
   expect(recordingChannelFaces([channel],[{channel,frames:1,unavailable:"SECOND_SAMPLE_FAILED"}])[0]).toMatchObject({id:channel,status:"unavailable",frames:1,reason:"SECOND_SAMPLE_FAILED"})
  }
 })
 test("请求了但没采到的通道不显示完成",()=>{
  const faces=recordingChannelFaces(["rgb","camera-depth","lidar-range"],[
   {channel:"rgb",frames:3,files:[{role:"rgb",uri:"resources/0/a.png"}]},
   {channel:"lidar-range",frames:0,files:[],unavailable:"SENSOR_UNAVAILABLE: no rays"},
  ])
  expect(faces.find(face=>face.id==="rgb")!.status).toBe("completed")
  expect(faces.find(face=>face.id==="camera-depth")!.status).toBe("requested")
  const lidar=faces.find(face=>face.id==="lidar-range")!
  expect(lidar.status).toBe("unavailable")
  expect(lidar.frames).toBe(0)
  expect(lidar.reason).toContain("SENSOR_UNAVAILABLE")
 })
 test("作业来源投影：开始后按服务端 source 读，字段缺失不编造",()=>{
  expect(recordingFixedScope(undefined)).toBeUndefined()
  const scope=recordingFixedScope({cameraName:"cam-a/wrist",robotName:"Robot A",bodyName:"arm",channels:["rgb","camera-depth"]})!
  expect(scope.cameraName).toBe("cam-a/wrist")
  expect(scope.channels).toEqual(["rgb","camera-depth"])
  const fixed={cameraName:"camera-instance/Wrist RGB-D",robotName:"Robot A",robotEntityId:"robot-instance",bodyName:"robot-instance/hand",channels:["rgb"]}
  expect(recordingScopeLabel(fixed)).toBe("Robot A · hand · Wrist RGB-D")
  expect(fixed.bodyName).toBe("robot-instance/hand")
  expect(fixed.cameraName).toBe("camera-instance/Wrist RGB-D")
  expect(recordingScopeLabel({cameraName:"cam-1",bodyName:"other/body",channels:[]})).toBe("other/body · cam-1")
  expect(recordingFixedScope({cameraName:"cam-1"})?.bodyName).toBeUndefined()
 })
})
