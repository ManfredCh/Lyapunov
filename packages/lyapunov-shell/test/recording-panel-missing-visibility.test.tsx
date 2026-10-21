/**
 * **D2** 回归：录制**缺件**用户在面板上看得到（`ZERO-CONSUMER-FIELD-AUDIT-20260926.md` D2）。
 *
 * 缺陷形状（审计原文）：`missingCount`/`missing` 由 `recordingSummary()`（`robot-workflows/src/recording-files.ts:33`）
 * **一直在算**、由 `register("recordings")`（`plugin.ts:2053`）**一直在发**（面板每 1.5s 轮询），
 * 而客户端 `recording-panel.tsx` 的 `Pick<...>` **缺这两个键** ⇒ 全仓 0 读 ⇒ **缺件对用户不可见**。
 *
 * 本文件按与本仓 D1/D3 回归（`computer-use-visibility.test.tsx`）**同一形状**取证，两层缺一不可：
 *  ① **渲染层**：`RecordingMissingFiles` 是渲染与判据**共用的同一个**组件 ⇒ 用 `renderToStaticMarkup`
 *     渲染真组件，把"用户看到的那句话"（含 `lya-warning` 色与 `missingCount` 真总数）逐字钉住；
 *     喂进去的行对象**不是手写夹具**，而是真 `recordingSummary(manifest)` 的返回值 —— 于是"服务端发的
 *     这个键、客户端拿的也是这个键"由真函数闭环（键名写错、被裁掉、返回 undefined 都会红）。
 *  ② **挂载层**：本仓**没有**浏览器 DOM 夹具（`react-test-renderer` 未安装、`bunfig.toml` 无 DOM 预载；
 *     见 `camera-list-ui.test.ts` 的同一条诚实边界），所以"这个组件真的挂在行渲染里"用源码守卫钉住 ——
 *     **只有组件、没人渲染**必须也能红。
 *
 * ⚠️ **未覆盖（如实登记，不写"应该没问题"）**：面板 `rows` 由 `useEffect` 的 1.5s 轮询填充，
 * 而 `renderToStaticMarkup` **不跑 effect** ⇒ 本文件**取不到**"真 `RecordingPanel` 整棵树的 HTML"。
 * 那一层由 ② 的源码守卫代替，**不是**等价物。
 *
 * 运行：`bun test packages/lyapunov-shell/test/recording-panel-missing-visibility.test.tsx`
 */
import {describe,expect,mock,test} from "bun:test"
import {readFileSync} from "node:fs"
import {createRequire} from "node:module"
import {join} from "node:path"
import {createElement,act,startTransition} from "react"
import {flushSync} from "react-dom"
import {createRoot,type Root} from "react-dom/client"
import {renderToStaticMarkup} from "react-dom/server"
import type {RecordingManifest,RecordingReplay} from "../../robot-workflows/src/recording-files.ts"

// `recording-panel.tsx` 顶层 import 了 `@lyapunov/viewer/client`（浏览器侧包；bun test 里直接 import 会挂在
// `Export named 'createViewer' not found`）⇒ 与 `computer-use-visibility.test.tsx` 同一手法换最小桩。
import {projectSceneCameraRigs} from "../../viewer/src/scene-camera-rigs.ts"
const viewerStub={setScene:async()=>{},frameAll:()=>{},presentRecordedFrame:()=>{},dispose:()=>{}}
mock.module("@lyapunov/viewer/client",()=>({projectSceneCameraRigs,createViewer:()=>viewerStub,WebGLUnavailableError:class WebGLUnavailableError extends Error{}}))
const panel=await import("../src/recording-panel.tsx")
const RecordingMissingFiles=panel.RecordingMissingFiles
const {recordingSummary}=await import("../../robot-workflows/src/recording-files.ts")

const shell=join(import.meta.dirname,"../src")
/** 中文渲染：`tr` 在中文界面下取第一个参数（与 `workbench.tsx:152` 同一份口径）。 */
const tr=((zh:string,_en:string)=>zh) as never
const markup=(node:unknown)=>renderToStaticMarkup(node as never)

/**
 * 一份**真形状**的录制清单：3 条缺件（`missing` 的真实生产者是 `recording-files.ts:150/175` 的
 * `manifest.missing.push({ uri, reason: String(error) })` ⇒ `reason` 就是 `String(error)` 的形状）。
 */
const manifest:RecordingManifest={
 recordingId:"recording-11111111-2222-3333-4444-555555555555",sessionRef:"session-abc",runId:"run-abc",
 sceneId:"scene-1",status:"completed",createdAt:"2026-09-27T01:00:00.000Z",maxDurationS:30,frameCount:12,eventCount:3,
 segments:[{generation:2,sceneFile:"scene-g2-r7.json",sourceSceneFile:"source-scene-g2-r7.json",world:{worldId:"world-1",sceneId:"scene-1",engineId:"mujoco",engineVersion:"3.3.7",worldGeneration:2,appliedSceneRevision:7,status:"paused"}}],
 resources:[{uri:"file:///models/g1/meshes/waist_roll_link.STL",path:"resources/0/waist_roll_link.STL",bytes:4096,mimeType:"application/octet-stream"}],
 missing:[
  {uri:"file:///models/g1/meshes/left_hand_palm_link.STL",reason:"Error: ENOENT: no such file or directory, open '/models/g1/meshes/left_hand_palm_link.STL'"},
  {uri:"recording:/resources/0/waist_roll_link.STL",reason:"Error: ENOENT: no such file or directory, stat '/recordings/recording-1111/resources/0/waist_roll_link.STL'"},
  {uri:"file:///models/g1/meshes/right_shoulder_roll_link.STL",reason:"Error: EACCES: permission denied, copyfile '/models/g1/meshes/right_shoulder_roll_link.STL'"},
 ],
}
/** `register("recordings")` 发给面板的就是这个对象（`plugin.ts:2053` 的 `.map(manifest=>recordingSummary(manifest,sessionKey))`）。 */
const served=recordingSummary(manifest,"session-abc")

describe("D2 录制缺件可见",()=>{
 test("服务端出口确实带 missing/missingCount（真 recordingSummary）",()=>{
  expect(served.missingCount).toBe(3)
  expect(served.missing).toHaveLength(3)
  expect(served.missing[0]!.uri).toContain("left_hand_palm_link.STL")
 })

 test("有缺件 ⇒ 面板行渲染出告警（渲染原文）",()=>{
  const html=markup(<RecordingMissingFiles row={served} tr={tr}/>)
  // 渲染原文（逐字）：颜色类走既有 `.lya-warning`，条数是**真总数**，标题带逐条 uri 与原因。
  expect(html).toBe('<span class="lya-badge lya-warning" role="status" data-testid="recording-missing" title="录制缺件\nfile:///models/g1/meshes/left_hand_palm_link.STL：Error: ENOENT: no such file or directory, open &#x27;/models/g1/meshes/left_hand_palm_link.STL&#x27;\nrecording:/resources/0/waist_roll_link.STL：Error: ENOENT: no such file or directory, stat &#x27;/recordings/recording-1111/resources/0/waist_roll_link.STL&#x27;\nfile:///models/g1/meshes/right_shoulder_roll_link.STL：Error: EACCES: permission denied, copyfile &#x27;/models/g1/meshes/right_shoulder_roll_link.STL&#x27;">缺件 3 项</span>')
  expect(html).toContain("缺件 3 项")
  expect(html).toContain("left_hand_palm_link.STL：Error: ENOENT")
  expect(html).toContain("permission denied")
 })

 test("没有缺件 ⇒ 不占位（空串，不是空壳告警）",()=>{
  expect(markup(<RecordingMissingFiles row={{...served,missing:[],missingCount:0}} tr={tr}/>)).toBe("")
 })

 test(">20 条：条数报**真总数**，详情如实说明只列了前几条",()=>{
  const many=Array.from({length:25},(_v,index)=>({uri:`recording:/resources/0/f${index}.STL`,reason:"Error: ENOENT: no such file or directory"}))
  const row=recordingSummary({...manifest,missing:many},"session-abc")
  expect(row.missingCount).toBe(25)
  expect(row.missing).toHaveLength(20)                       // 服务端截断（既有口径，不是本单引入）
  const html=markup(<RecordingMissingFiles row={row} tr={tr}/>)
  expect(html).toContain("缺件 25 项")                        // 显示的是真总数
  expect(html).not.toContain("缺件 20 项")
  expect(html).toContain("只列前 20 条，共 25 条")             // 截断如实写清
 })

 test("挂载层：行渲染真的挂了这个组件，且行类型真的带着这两个键",()=>{
  const source=readFileSync(join(shell,"recording-panel.tsx"),"utf8")
  // ① 行类型必须真的带这两个键（少了它 ⇒ `row.missingCount` 根本不存在，渲染层拿不到数据）。
  //    ⚠️ 修正（2026-09-27；同文件另一条 lane 的落盘曾在此处把**仓库的门**弄红）：`missingCount`
  //    **不是** `RecordingManifest` 的键（它是 `recordingSummary()` 现算的；清单上只有被截到前 20 条的
  //    `missing`）⇒ **不能**写进 `Pick<RecordingManifest, …>`（`tsc -p tsconfig.json` 实测红 3 条）。
  //    判据本身**不放宽**：`missing` 在 Pick 里 + `missingCount` 在行类型里显式声明 `number`，两条都要，
  //    且那个 tsc 红的形状**不许回来**。
  expect(source).toMatch(/type Summary = Pick<RecordingManifest,[^>]*'missing'[^>]*>/)
  expect(source).toMatch(/type Summary = [^\n]*missingCount:\s*number/)
  expect(source).not.toMatch(/Pick<RecordingManifest,[^>]*'missingCount'[^>]*>/)
  // ② 行渲染（`rows.map`）必须挂上这个组件（返回值被丢弃、只留组件没挂上去 ⇒ 这里红）。
  expect(source).toMatch(/\{recentRows\.map\(row => <div className="lya-receipt"[^]*?<RecordingMissingFiles row=\{row\} tr=\{tr\}\/>/)
  // ③ 出口侧：`register("recordings")` 发的行必须经真 `recordingSummary`（键名从它来）。
  const plugin=readFileSync(join(shell,"plugin.ts"),"utf8")
  expect(plugin).toContain('register("recordings"')
  expect(plugin).toMatch(/register\("recordings"[^]*?recordingSummary\(manifest,sessionKey\)/)
 })
})

describe("V10 Recording 空态/来源/通道层级",()=>{
 const RecordingPanel=panel.RecordingPanel
 const emptyScene:any={sceneId:"scene-empty",revision:1,coordinates:{units:"m",upAxis:"Z",handedness:"right",quaternion:"xyzw"},entities:[]}
 test("无 Robot：下一步是 Add robot 直达 Robot Library，不经过 Camera 空态，也不渲染参数",()=>{
  let robots=0,cameras=0
  const html=markup(<RecordingPanel visible api={{request:async()=>[],mediaURL:()=>""} as never} sceneId="scene-empty" scene={emptyScene} nativeReceipt={{cameras:[]}} hasRobot={false} openRobotLibrary={()=>{robots++}} openCamera={()=>{cameras++}} tr={tr} perform={()=>{}} onReplayChange={()=>{}} close={()=>{}}/>)
  expect(html).toContain('data-testid="recording-empty"')
  expect(html).toContain('data-empty-reason="no-robot"')
  expect(html).toContain("添加机器人")
  expect(html).not.toContain("配置机位")
  expect(cameras).toBe(0)
  for(const text of ["通道","时长","分辨率","开始录制","最近录制"])expect(html).not.toContain(text)
  // 标题/说明不重复同一事实：一句缺失前提 + 一句可执行下一步。
  expect(html).toContain("先添加一台机器人")
  expect(html).toContain("录制需要机器人上的真实挂载机位")
  expect(robots).toBe(0)
 })
 test("已有 Robot 但无 Camera：下一步才进 Configure camera；标题/说明不互相复述",()=>{
  const robotId="robot-camera-source"
  const scene:any={...emptyScene,entities:[{entityId:robotId,name:"Panda",transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{articulation:{}}}]}
  let cameras=0,robots=0
  const html=markup(<RecordingPanel visible api={{request:async()=>[],mediaURL:()=>""} as never} sceneId="scene-empty" scene={scene} nativeReceipt={{cameras:[]}} hasRobot openCamera={()=>{cameras++}} openRobotLibrary={()=>{robots++}} tr={tr} perform={()=>{}} onReplayChange={()=>{}} close={()=>{}}/>)
  expect(html).toContain('data-empty-reason="no-camera"')
  expect(html).toContain("这台机器人还没有可用机位")
  expect(html).toContain("配置机位")
  expect(html).not.toContain("添加机器人")
  expect(html).not.toContain("没有可用的机器人机位")
  expect(html).not.toContain("当前场景没有可用的机器人挂载机位")
  expect(cameras).toBe(0); expect(robots).toBe(0)
 })
 test("有机位但未选中：只给来源选择和必要提示，不提前铺通道与 Start",()=>{
  const robotId="robot-camera-source"
  const scene:any={...emptyScene,entities:[{entityId:robotId,name:"Panda",transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{articulation:{}}}]}
  const nativeReceipt:any={cameras:[{cameraName:`${robotId}/wrist/rgb`,resolvedCameraName:`${robotId}/wrist/rgb`,parentEntityId:robotId,parentBodyName:`${robotId}/wrist`,cameraSource:"scene-camera",available:true,width:640,height:480}]}
  const html=markup(<RecordingPanel visible api={{request:async()=>[],mediaURL:()=>""} as never} sceneId="scene-empty" scene={scene} nativeReceipt={nativeReceipt} hasRobot tr={tr} perform={()=>{}} onReplayChange={()=>{}} close={()=>{}}/>)
  expect(html).toContain('data-testid="recording-source-choice"')
  expect(html).toContain('data-testid="recording-source-hint"')
  expect(html).not.toContain('data-testid="recording-ready-form"')
  expect(html).not.toContain("Channels")
  expect(html).not.toContain("Start recording")
 })
 test("累计录制时长只读服务端 elapsedS；旧清单缺值如实写未记录",()=>{
  expect(panel.recordingElapsedLabel({elapsedS:2,maxDurationS:30},tr)).toBe("2.00 / 30.00 s sim")
  expect(panel.recordingElapsedLabel({maxDurationS:30},tr)).toContain("未记录")
  const current=recordingSummary({...manifest,status:"recording",elapsedS:2,lastFrame:{frameId:"f",generation:1,sceneRevision:7,stepIndex:30,simTime:102}},"session-abc") as any
  expect(current.elapsedS).toBe(2)
  expect(current.maxDurationS).toBe(30)
  const old=recordingSummary({...manifest,status:"completed"},"session-abc") as any
  expect("elapsedS" in old).toBe(false)
  expect(panel.recordingElapsedLabel(old,tr)).toContain("未记录")
 })
 test("层级判据：运行中优先固定作业；选定可用来源才进入 setup",()=>{
  expect(panel.recordingPanelStage({rows:[{status:"recording"}],sources:0,selected:false,ready:false})).toBe("running")
  expect(panel.recordingPanelStage({rows:[],sources:0,selected:false,ready:false})).toBe("empty")
  expect(panel.recordingPanelStage({rows:[],sources:1,selected:false,ready:false})).toBe("choose-source")
  expect(panel.recordingPanelStage({rows:[],sources:1,selected:true,ready:false})).toBe("unavailable-source")
  expect(panel.recordingPanelStage({rows:[],sources:1,selected:true,ready:true})).toBe("setup")
 })
})

describe("V9 Recording 只有一个关闭入口",()=>{
 const RecordingPanel=panel.RecordingPanel
 const props=(embedded:boolean)=>(<RecordingPanel embedded={embedded} visible api={{request:async()=>[],mediaURL:()=>''} as never} tr={tr} perform={()=>{}} onReplayChange={()=>{}} close={()=>{}}/>)
 test("主面板 embedded 时由 PanelColumn 提供唯一 ×；Outputs 抽屉保留自身关闭",()=>{
  expect((markup(props(true)).match(/关闭录制面板/g)??[]).length).toBe(0)
  expect((markup(props(false)).match(/关闭录制面板/g)??[]).length).toBe(1)
 })
 test("V11-P26：相机选项正文与悬停提示都只显示可读名，UUID 只留在 value",()=>{
  const robotId="entity_c6047d61-46d9-42ca-bc82-c901d5b16bca"
  const scene:any={sceneId:"scene-1",revision:1,coordinates:{units:"m",upAxis:"Z",handedness:"right",quaternion:"xyzw"},entities:[{entityId:robotId,name:"franka_panda",transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{articulation:{}}}]}
  const nativeReceipt:any={cameras:[{cameraName:`${robotId}/hand/Wrist RGB-D`,resolvedCameraName:`${robotId}/hand/Wrist RGB-D`,entityId:robotId,parentEntityId:robotId,parentBodyName:`${robotId}/hand`,cameraSource:"scene-camera",available:true,width:640,height:480}]}
  const html=markup(<RecordingPanel embedded visible api={{request:async()=>[],mediaURL:()=>""} as never} sceneId="scene-1" scene={scene} world={{worldId:"w",sceneId:"scene-1",worldGeneration:1,appliedSceneRevision:1,status:"running"} as never} nativeReceipt={nativeReceipt} tr={tr} perform={()=>{}} onReplayChange={()=>{}} close={()=>{}}/>)
  // 正文可读：真实机器人名 / 本地 body / 相机短名。
  expect(html).toContain(">franka_panda · hand · Wrist RGB-D</option>")
  // V11：UUID 不进入正文，也不进入悬停提示；完整身份只在 option value。
  expect(html).not.toMatch(new RegExp(`>[^<]*${robotId}[^<]*<`))
  expect(html).not.toMatch(new RegExp(`title="[^"]*${robotId}[^"]*"`))
   expect(html).toMatch(new RegExp(`<option value="[^"]*${robotId}[^"]*"[^>]*>`))
 })
})

/** 真 React + jsdom：让 3D replay 的播放/暂停真的按定时器推进，并复现并发队列。 */
function withDom(run:(host:HTMLElement,render:(node:unknown)=>Promise<void>)=>Promise<void>){
 return async()=>{
  const {JSDOM}=createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json",import.meta.url))("jsdom") as {JSDOM:new(html:string,options?:{url?:string;pretendToBeVisual?:boolean})=>{window:Window&typeof globalThis}}
  const dom=new JSDOM('<div id="root"></div>',{url:"http://fixture.invalid",pretendToBeVisual:true})
  const saved=new Map<string,PropertyDescriptor|undefined>()
  for(const key of ["window","document","HTMLElement","HTMLCanvasElement","HTMLInputElement","Node","navigator","requestAnimationFrame","cancelAnimationFrame","IS_REACT_ACT_ENVIRONMENT"]){
   saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
   const raw=(dom.window as unknown as Record<string,unknown>)[key]
   const value=key==="IS_REACT_ACT_ENVIRONMENT"?true:typeof raw==="function"&&key.includes("AnimationFrame")?(raw as (...args:unknown[])=>unknown).bind(dom.window):raw
   Object.defineProperty(globalThis,key,{configurable:true,value})
  }
  const host=document.getElementById("root")!,root:Root=createRoot(host)
  ;(dom.window as unknown as {HTMLElement:{prototype:Record<string,unknown>}}).HTMLElement.prototype.attachEvent=()=>{}
  ;(dom.window as unknown as {HTMLElement:{prototype:Record<string,unknown>}}).HTMLElement.prototype.detachEvent=()=>{}
  const render=async(node:unknown)=>{await act(async()=>{root.render(node as never)})}
  try{await run(host,render)}
  finally{try{await act(async()=>root.unmount())}catch{}dom.window.close();for(const [key,value] of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)}}
 }
}

describe("V11 真实机位分辨率与用户录制草稿",()=>{
 const en=((_zh:string,value:string)=>value) as never
 test("Record this camera继承尺寸；用户改值在轮询刷新、切来源和隐藏重开后保留；换world/代次隔离",withDom(async(host,render)=>{
  const robotId="robot-a",scene:any={sceneId:"scene-1",revision:1,entities:[{entityId:robotId,name:"Panda",components:{}}]}
  const camera=(name:string,width:number,height:number)=>({cameraName:`${robotId}/${name}`,resolvedCameraName:`alias/${name}`,parentEntityId:robotId,parentBodyName:"arm",available:true,width,height})
  let nativeReceipt={cameras:[camera("wrist",160,120),camera("head",1280,720)]}
  const commands:Array<{name:string;input:any}>=[],api={request:async()=>[],mediaURL:()=>"",command:async(name:string,input:any)=>{commands.push({name,input});return {}}}
  const world:any={worldId:"world-a",worldGeneration:1,sceneId:"scene-1",status:"running"}
  const props:any={visible:true,api,sceneId:"scene-1",scene,world,nativeReceipt,preferredCameraName:"alias/wrist",tr:en,perform:(fn:()=>Promise<unknown>)=>{void fn()},onReplayChange:()=>{},close:()=>{}}
  const paint=async(change:Record<string,unknown>={})=>{Object.assign(props,change);await render(createElement(panel.RecordingPanel,props))}
  const button=(text:string)=>[...host.querySelectorAll("button")].find(button=>button.textContent===text) as HTMLButtonElement
  const change=async(selector:string,value:string)=>{const input=host.querySelector(selector) as HTMLInputElement;expect(input).not.toBeNull();const key=Object.keys(input).find(name=>name.startsWith("__reactProps$"))!;await act(async()=>{(input as any)[key].onChange({target:{value}})})}
  await paint()
  expect(host.textContent).toContain("160 × 120")
  await act(async()=>{button("Start recording").click();await Promise.resolve()})
  expect(commands.at(-1)).toMatchObject({name:"recording_start",input:{width:160,height:120,source:{cameraName:"robot-a/wrist"}}})
  await act(async()=>{button("Edit").click()})
  await change('input[aria-label="Width"]',"320")
  await change('input[aria-label="Height"]',"240")
  nativeReceipt={cameras:[camera("wrist",800,600),camera("head",1280,720)]}
  await paint({nativeReceipt})
  expect(host.textContent).toContain("320 × 240")
  await act(async()=>{button("Start recording").click();await Promise.resolve()})
  expect(commands.at(-1)).toMatchObject({name:"recording_start",input:{width:320,height:240,maxDurationS:30,source:{cameraName:"robot-a/wrist",robotEntityId:"robot-a",bodyName:"arm"}}})
  await change('select[aria-label="Robot camera"]',"robot-a/arm/robot-a/head")
  expect(host.textContent).toContain("1280 × 720")
  await paint({nativeReceipt:{cameras:[...nativeReceipt.cameras]}})
  expect((host.querySelector('select[aria-label="Robot camera"]') as HTMLSelectElement).value).toContain("head")
  await change('select[aria-label="Robot camera"]',"robot-a/arm/robot-a/wrist")
  expect(host.textContent).toContain("320 × 240")
  await paint({visible:false});await paint({visible:true})
  expect(host.textContent).toContain("320 × 240")
  await paint({world:{...world,worldId:"world-b"}})
  expect(host.textContent).toContain("800 × 600")
  await change('input[aria-label="Width"]',"400")
  await paint({world:{...world,worldId:"world-b",worldGeneration:2}})
  expect(host.textContent).toContain("800 × 600")
  // Scene座位按真实owner的key重建，旧草稿不会进入另一Scene。
  await render(createElement(panel.RecordingPanel,{...props,key:panel.recordingPanelSeatKey("session-1","scene-2"),sceneId:"scene-2",world:{...world,sceneId:"scene-2"}}))
  expect(host.textContent).toContain("800 × 600")
 }))
})

describe("V11 录制返修未知值与部分失败",()=>{
 const en=((_zh:string,value:string)=>value) as never
 test("未知累计时长不因completed或停止原因变成成功；原始身份保留",()=>{
  for(const elapsedS of [undefined,NaN,Infinity,-1]){
   for(const stopReason of [undefined,"duration-limit","wall-time-limit","frame-limit","unexpected-stop","recording-stop"]){
    const row:any={status:"completed",elapsedS,maxDurationS:30,stopReason}
    const outcome=panel.recordingOutcome(row,en)
    expect(outcome.label).not.toBe("Completed")
    expect(row.status).toBe("completed")
    expect(row.stopReason).toBe(stopReason)
    if(stopReason==="recording-stop")expect(outcome.label).toBe("Stopped")
    else expect(outcome.reason).toBeTruthy()
   }
  }
  expect(panel.recordingOutcome({status:"completed",elapsedS:30,maxDurationS:30} as never,en).label).toBe("Completed")
  expect(panel.recordingOutcome({status:"completed",elapsedS:30,maxDurationS:NaN} as never,en).label).toBe("Ended")
  expect(panel.recordingOutcome({status:"completed",elapsedS:30,maxDurationS:30,stopReason:"unexpected-stop"} as never,en)).toMatchObject({label:"Ended",reason:"unexpected-stop"})
 })
 test("未知尺寸只填一边不可Start；同批补齐后发送明确值；无效或清空后再禁用",withDom(async(host,render)=>{
  const commands:any[]=[],api={request:async()=>[],mediaURL:()=>"",command:async(name:string,input:any)=>{commands.push({name,input});return {}}}
  const props:any={visible:true,api,sceneId:"scene-size",scene:{sceneId:"scene-size",entities:[]},world:{worldId:"world-size",worldGeneration:1},nativeReceipt:{cameras:[{cameraName:"robot/wrist",parentEntityId:"robot",parentBodyName:"hand",height:240,available:true}]},preferredCameraName:"robot/wrist",tr:en,perform:(fn:()=>Promise<unknown>)=>{void fn()},onReplayChange:()=>{},close:()=>{}}
  await render(createElement(panel.RecordingPanel,props))
  const button=(text:string)=>[...host.querySelectorAll("button")].find(button=>button.textContent===text) as HTMLButtonElement
  const change=(name:string,value:string)=>{const input=host.querySelector(`input[aria-label="${name}"]`) as HTMLInputElement;const key=Object.keys(input).find(name=>name.startsWith("__reactProps$"))!;(input as any)[key].onChange({target:{value}})}
  expect(host.textContent).toContain("Not declared")
  expect(host.textContent).not.toContain("640 × 480")
  expect(button("Start recording").disabled).toBe(true)
  await act(async()=>button("Edit").click())
  expect((host.querySelector('input[aria-label="Width"]') as HTMLInputElement).value).toBe("")
  expect((host.querySelector('input[aria-label="Height"]') as HTMLInputElement).value).toBe("")
  await act(async()=>change("Width","320"))
  expect(button("Start recording").disabled).toBe(true)
  await act(async()=>button("Start recording").click())
  expect(commands).toHaveLength(0)
  await act(async()=>{change("Width","352");change("Height","288")})
  expect(host.textContent).toContain("352 × 288")
  expect(button("Start recording").disabled).toBe(false)
  await act(async()=>button("Start recording").click())
  expect(commands.at(-1)).toMatchObject({name:"recording_start",input:{width:352,height:288,source:{cameraName:"robot/wrist",robotEntityId:"robot",bodyName:"hand"}}})
  for(const invalid of ["","0","15","4097","160.5"]){
   await act(async()=>change("Height",invalid))
   expect(button("Start recording").disabled).toBe(true)
  }
  await act(async()=>change("Height","240"))
  expect(button("Start recording").disabled).toBe(false)
  expect(commands).toHaveLength(1)
 }))
 for(const status of ["recording","completed"] as const)test(`${status}的部分帧失败在默认来源区域同时显示帧数与原因`,withDom(async(host,render)=>{
  const row=recordingSummary({...manifest,status,elapsedS:3,source:{cameraName:"robot/wrist",robotName:"Panda",channels:["lidar-range"]},channels:[{channel:"lidar-range",cameraName:"robot/wrist",unit:"m-euclidean-range",frames:1,files:[],unavailable:"SECOND_SAMPLE_FAILED"}]} as never,"session-abc")
  await render(createElement(panel.RecordingPanel,{visible:true,api:{request:async()=>[row],mediaURL:()=>""} as never,tr:en,perform:()=>{},onReplayChange:()=>{},close:()=>{}}))
  const scope=host.querySelector('[data-testid="recording-running-scope"]')!
  expect(scope.textContent).toContain("unavailable")
  expect(scope.textContent).toContain("1 frames")
  expect(scope.textContent).toContain("SECOND_SAMPLE_FAILED")
  expect(scope.closest("details")).toBeNull()
  expect(scope.textContent).not.toContain("LiDAR range ✓")
 }))
})

describe("R-006-14 3D replay 暂停/seek 的并发队列",()=>{
 const en=((_zh:string,value:string)=>value) as never
 const frame=(i:number)=>({frameId:`f${i}`,worldId:"world-1",generation:1,sceneRevision:1,stepIndex:i*10,simTime:i*0.03}) as never
 const replay=():RecordingReplay=>({
  manifest:{recordingId:"recording-1",sessionRef:"session-1",runId:"run-1",sceneId:"scene-1",status:"completed",createdAt:"2026-10-18T00:00:00.000Z",maxDurationS:30,frameCount:4,eventCount:0,segments:[{generation:1,sceneFile:"scene.json",sourceSceneFile:"source.json",world:{worldId:"world-1",sceneId:"scene-1",engineId:"mujoco",engineVersion:"3",worldGeneration:1,appliedSceneRevision:1,status:"paused"}}],resources:[],missing:[]},
  segments:[{world:{worldId:"world-1",sceneId:"scene-1",engineId:"mujoco",engineVersion:"3",worldGeneration:1,appliedSceneRevision:1,status:"paused"} as never,scene:{sceneId:"scene-1",revision:1,coordinates:{units:"m",upAxis:"Z",handedness:"right",quaternion:"xyzw"},entities:[],resources:[]} as never,frames:[frame(0),frame(1),frame(2),frame(3)]}],
 })
 const row={recordingId:"recording-1",sceneId:"scene-1",status:"completed",createdAt:"2026-10-18T00:00:00.000Z",frameCount:4,missing:[],missingCount:0,channels:[],generations:[]}
 const api={request:async(resource:string)=>resource.startsWith("recordings")?[row]:replay(),mediaURL:()=>""}
 const props=(host:HTMLElement,render:(node:unknown)=>Promise<void>)=>render(createElement(panel.RecordingPanel,{visible:true,api:api as never,sceneId:"scene-1",tr:en,perform:(fn:()=>Promise<unknown>)=>{void fn()},onReplayChange:()=>{},close:()=>{}}))
 const button=(host:HTMLElement,label:string)=>[...host.querySelectorAll("button")].find(item=>item.textContent?.includes(label)) as HTMLButtonElement
 const index=(host:HTMLElement)=>host.querySelector('[data-testid="recording-step"]')?.getAttribute("data-frame-index")
 const load=async(host:HTMLElement,render:(node:unknown)=>Promise<void>)=>{await props(host,render);await act(async()=>{await Promise.resolve()});await act(async()=>{button(host,"Watch replay").click();await Promise.resolve();await Promise.resolve()});await act(async()=>{await Promise.resolve()});expect(index(host)).toBe("0")}

 test("Pause 前已排队的低优先级 advance 不能在 Pause 提交后再动；Play 从保持点继续；seek 定位不被冲掉",withDom(async(host,render)=>{
  await load(host,render)
  expect(button(host,"Play recording").disabled).toBe(false)
  const realSetTimeout=globalThis.setTimeout
  let advance:(()=>void)|undefined
  ;(globalThis as any).setTimeout=((fn:any,delay?:number,...args:any[])=>{if(typeof fn==="function"&&delay===30){advance=()=>fn(...args);return 0 as any}return realSetTimeout(fn,delay,...args)}) as typeof setTimeout
  try{
   await act(async()=>{button(host,"Play recording").click()})
   expect(advance).toBeDefined()
   act(()=>{
    startTransition(()=>{advance!()})
    flushSync(()=>{button(host,"Pause replay").click()})
    expect(index(host)).toBe("0")
   })
   await act(async()=>{await new Promise(resolve=>realSetTimeout(resolve,0))})
   expect(index(host)).toBe("0")
   // Play 从 Pause 保持的第 0 帧继续，下一条真实 advance 才到 1。
   await act(async()=>{button(host,"Play recording").click()})
   expect(advance).toBeDefined()
   await act(async()=>{advance!()})
   expect(index(host)).toBe("1")
   // 播放中 seek：旧 advance 已排队，用户拖到第 3 帧后旧更新不得覆盖选择。
   const slider=host.querySelector('input[aria-label="Recorded replay timeline"]') as HTMLInputElement
   act(()=>{
    startTransition(()=>{advance!()})
    flushSync(()=>{const key=Object.keys(slider).find(name=>name.startsWith("__reactProps$"));const value=key?(slider as any)[key]:undefined;const setter=Object.getOwnPropertyDescriptor((window as any).HTMLInputElement.prototype,"value")!.set!;setter.call(slider,"3");value.onChange({target:slider})})
    expect(index(host)).toBe("3")
   })
   await act(async()=>{await new Promise(resolve=>realSetTimeout(resolve,0))})
   expect(index(host)).toBe("3")
   expect(button(host,"Play recording")).toBeDefined()
  }finally{globalThis.setTimeout=realSetTimeout}
 }))

 test("Play 中重开 recording：先停播放并定位第 0 帧，旧排队 advance 不得把重开位置冲掉",withDom(async(host,render)=>{
  await load(host,render)
  const realSetTimeout=globalThis.setTimeout
  let advance:(()=>void)|undefined
  ;(globalThis as any).setTimeout=((fn:any,delay?:number,...args:any[])=>{if(typeof fn==="function"&&delay===30){advance=()=>fn(...args);return 0 as any}return realSetTimeout(fn,delay,...args)}) as typeof setTimeout
  try{
   await act(async()=>{button(host,"Play recording").click()})
   expect(advance).toBeDefined()
   await act(async()=>{advance!()})
   expect(index(host)).toBe("1")
   // V10：右栏清单在回放期间保留，重开不再依赖播放条里的 “Recordings” 开关。
   await act(async()=>{button(host,"Watch replay").click();await Promise.resolve();await Promise.resolve()})
   expect(index(host)).toBe("0")
   expect(button(host,"Play recording")).toBeDefined()                // 重开后回到暂停，不残留旧播放
  }finally{globalThis.setTimeout=realSetTimeout}
 }))
})

describe("V10 回放挂到自有主画布宿主并在返回实时时清理",()=>{
 const en=((_zh:string,value:string)=>value) as never
 const replay=():RecordingReplay=>({
  manifest:{recordingId:"recording-host",sessionRef:"session-1",runId:"run-1",sceneId:"scene-1",status:"completed",createdAt:"2026-10-18T00:00:00.000Z",maxDurationS:30,frameCount:1,eventCount:0,segments:[{generation:1,sceneFile:"scene.json",sourceSceneFile:"source.json",world:{worldId:"world-1",sceneId:"scene-1",engineId:"mujoco",engineVersion:"3",worldGeneration:1,appliedSceneRevision:1,status:"paused"}}],resources:[],missing:[]},
  segments:[{world:{worldId:"world-1",sceneId:"scene-1",engineId:"mujoco",engineVersion:"3",worldGeneration:1,appliedSceneRevision:1,status:"paused"} as never,scene:{sceneId:"scene-1",revision:1,coordinates:{units:"m",upAxis:"Z",handedness:"right",quaternion:"xyzw"},entities:[],resources:[]} as never,frames:[{frameId:"f0",worldId:"world-1",generation:1,sceneRevision:1,stepIndex:0,simTime:0} as never]}],
 })
 const row={recordingId:"recording-host",sceneId:"scene-1",status:"completed",createdAt:"2026-10-18T00:00:00.000Z",frameCount:1,missing:[],missingCount:0,channels:[],generations:[]}
 const api={request:async(resource:string)=>resource.startsWith("recordings")?[row]:replay(),mediaURL:()=>""}
 test("Viewer 只出现在传入的 replayHost；Return to live 清除宿主内容",withDom(async(host,render)=>{
  const replayHost=document.createElement("div")
  document.body.appendChild(replayHost)
  const button=(label:string)=>[...document.querySelectorAll("button")].find(item=>item.textContent?.includes(label)) as HTMLButtonElement
  try{
   await render(createElement(panel.RecordingPanel,{visible:true,api:api as never,sceneId:"scene-1",replayHost,tr:en,perform:(fn:()=>Promise<unknown>)=>{void fn()},onReplayChange:()=>{},close:()=>{}} as never))
   await act(async()=>{await Promise.resolve()})
   await act(async()=>{button("Watch replay").click();await Promise.resolve();await Promise.resolve()})
   expect(replayHost.querySelector('[data-testid="recording-replay-view"]')).not.toBeNull()
   expect(host.querySelector('[data-testid="recording-replay-view"]')).toBeNull()
   await act(async()=>{button("Return to live view").click()})
   expect(replayHost.querySelector('[data-testid="recording-replay-view"]')).toBeNull()
   expect(host.querySelector('[data-testid="recording-recent-list"]')).not.toBeNull()
  }finally{replayHost.remove()}
 }))
})


describe("V10 录制累计时长与 Scene 座位",()=>{
 const en=((_zh:string,value:string)=>value) as never
 const row=(over:Record<string,unknown>={})=>({recordingId:"recording-live",sceneId:"scene-1",status:"recording",createdAt:"2026-10-18T00:00:00.000Z",frameCount:3,eventCount:0,maxDurationS:30,elapsedS:2,lastFrame:{frameId:"f",generation:1,sceneRevision:1,stepIndex:30,simTime:102},missing:[],missingCount:0,channels:[],generations:[],...over})
 test("空态下一步真实点击：无 Robot → Add robot；有 Robot 无 Camera → Configure camera",withDom(async(host,render)=>{
  const emptyScene:any={sceneId:"scene-empty",revision:1,coordinates:{units:"m",upAxis:"Z",handedness:"right",quaternion:"xyzw"},entities:[]}
  let robots=0,cameras=0
  await render(createElement(panel.RecordingPanel,{visible:true,api:{request:async()=>[],mediaURL:()=>""} as never,sceneId:"scene-empty",scene:emptyScene,nativeReceipt:{cameras:[]},hasRobot:false,openRobotLibrary:()=>{robots++},openCamera:()=>{cameras++},tr:en,perform:()=>{},onReplayChange:()=>{},close:()=>{}}))
  const add=host.querySelector('[data-testid="recording-add-robot"]') as HTMLButtonElement
  expect(add).not.toBeNull()
  await act(async()=>add.click())
  expect({robots,cameras}).toEqual({robots:1,cameras:0})
  const robotScene:any={...emptyScene,entities:[{entityId:"robot-1",name:"Panda",transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{articulation:{}}}]}
  await render(createElement(panel.RecordingPanel,{visible:true,api:{request:async()=>[],mediaURL:()=>""} as never,sceneId:"scene-empty",scene:robotScene,nativeReceipt:{cameras:[]},hasRobot:true,openRobotLibrary:()=>{robots++},openCamera:()=>{cameras++},tr:en,perform:()=>{},onReplayChange:()=>{},close:()=>{}}))
  const configure=[...host.querySelectorAll("button")].find(button=>button.textContent==="Configure camera") as HTMLButtonElement
  expect(configure).not.toBeNull()
  await act(async()=>configure.click())
  expect({robots,cameras}).toEqual({robots:1,cameras:1})
 }))
 test("显示 2s 累计而非绝对 simTime=102s",withDom(async(host,render)=>{
  await render(createElement(panel.RecordingPanel,{visible:true,api:{request:async()=>[row()],mediaURL:()=>""} as never,sceneId:"scene-1",tr:en,perform:()=>{},onReplayChange:()=>{},close:()=>{}}))
  await act(async()=>{await Promise.resolve()})
  const text=host.querySelector('[data-testid="recording-running-elapsed"]')?.textContent??""
  expect(text).toContain("2.00 / 30.00 s sim")
  expect(text).not.toContain("102.00")
 }))
 test("用户停止默认显示Stopped；UUID、技术原因和物理步进入关闭的详情",withDom(async(host,render)=>{
  await render(createElement(panel.RecordingPanel,{visible:true,api:{request:async()=>[row({status:"completed",recordingId:"recording-technical-id",stopReason:"recording-stop"})],mediaURL:()=>""} as never,sceneId:"scene-1",tr:en,perform:()=>{},onReplayChange:()=>{},close:()=>{}}))
  await act(async()=>{await Promise.resolve()})
  const details=host.querySelector('[data-testid="recording-technical-details"]') as HTMLDetailsElement
  expect(details.open).toBe(false)
  expect(details.textContent).toContain("recording-technical-id")
  expect(details.textContent).toContain("step 30")
  const copy=host.cloneNode(true) as HTMLElement
  copy.querySelectorAll("details:not([open])").forEach(node=>node.remove())
  expect(copy.textContent).toContain("Stopped · 2.00 / 30.00 s sim")
  expect(copy.textContent).not.toContain("recording-technical-id")
  expect(copy.textContent).not.toContain("recording-stop")
  expect(copy.textContent).not.toContain("step 30")
 }))
 test("wall-time-limit默认显示提前结束与真实9.54/30秒；达到目标才显示Completed",withDom(async(host,render)=>{
  const api={request:async()=>[row({status:"completed",elapsedS:9.54,stopReason:"wall-time-limit"})],mediaURL:()=>""}
  const props={visible:true,api:api as never,sceneId:"scene-1",tr:en,perform:()=>{},onReplayChange:()=>{},close:()=>{}}
  await render(createElement(panel.RecordingPanel,props))
  await act(async()=>{await Promise.resolve()})
  const copy=host.cloneNode(true) as HTMLElement
  copy.querySelectorAll("details:not([open])").forEach(node=>node.remove())
  expect(copy.textContent).toContain("Ended early · 9.54 / 30.00 s sim")
  expect(copy.textContent).toContain("Wall-clock safety limit reached")
  expect(copy.textContent).not.toContain("Completed")
  api.request=async()=>[row({status:"completed",elapsedS:30.02,stopReason:"duration-limit"})]
  await render(createElement(panel.RecordingPanel,{...props,api:{...api} as never}))
  await act(async()=>{await Promise.resolve()})
  expect(host.querySelector('[data-testid="recording-outcome"]')?.textContent).toBe("Completed · 30.02 / 30.00 s sim")
  expect(host.querySelector('[data-testid="recording-end-reason"]')).toBeNull()
 }))
 test("帧上限、旧缺时长与未知停止原因不冒称达到目标",()=>{
  expect(panel.recordingOutcome(row({status:"completed",elapsedS:8,stopReason:"frame-limit"}) as never,en)).toMatchObject({label:"Ended early",reason:"Frame limit reached"})
  expect(panel.recordingOutcome(row({status:"completed",elapsedS:undefined,stopReason:"wall-time-limit"}) as never,en)).toMatchObject({label:"Ended",reason:"Wall-clock safety limit reached"})
  expect(panel.recordingOutcome(row({status:"completed",elapsedS:8,stopReason:"unexpected-stop"}) as never,en)).toMatchObject({label:"Ended early",reason:"unexpected-stop"})
  expect(panel.recordingOutcome(row({status:"completed",elapsedS:undefined,stopReason:undefined}) as never,en).label).toBe("Ended")
 })
 test("失败的停止原因默认可见，不能因收起技术详情而掩盖失败",withDom(async(host,render)=>{
  await render(createElement(panel.RecordingPanel,{visible:true,api:{request:async()=>[row({status:"failed",stopReason:"Camera read failed"})],mediaURL:()=>""} as never,sceneId:"scene-1",tr:en,perform:()=>{},onReplayChange:()=>{},close:()=>{}}))
  await act(async()=>{await Promise.resolve()})
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Camera read failed")
 }))
 test("切 Scene 重建座位：旧回放在途 open 不挂到新 Scene；返回旧 Scene 可从真实历史重开",withDom(async(host,render)=>{
  let resolveOpen!:(value:RecordingReplay)=>void
  const opened=new Promise<RecordingReplay>(resolve=>{resolveOpen=resolve})
  const replay:RecordingReplay={manifest:{recordingId:"recording-old",sessionRef:"session-1",runId:"run-1",sceneId:"scene-1",status:"completed",createdAt:"2026-10-18T00:00:00.000Z",maxDurationS:30,frameCount:1,eventCount:0,segments:[{generation:1,sceneFile:"scene.json",sourceSceneFile:"source.json",world:{worldId:"world-1",sceneId:"scene-1",engineId:"mujoco",engineVersion:"3",worldGeneration:1,appliedSceneRevision:1,status:"paused"}}],resources:[],missing:[]},segments:[{world:{worldId:"world-1",sceneId:"scene-1",engineId:"mujoco",engineVersion:"3",worldGeneration:1,appliedSceneRevision:1,status:"paused"} as never,scene:{sceneId:"scene-1",revision:1,coordinates:{units:"m",upAxis:"Z",handedness:"right",quaternion:"xyzw"},entities:[],resources:[]} as never,frames:[]}]}
  const completed={...row({recordingId:"recording-old",status:"completed",elapsedS:2,frameCount:1})}
  const api={request:async(resource:string)=>resource.startsWith("recordings")?[completed]:opened,mediaURL:()=>""}
  const panelProps=(sceneId:string)=>({visible:true,api:api as never,sceneId,tr:en,perform:(fn:()=>Promise<unknown>)=>{void fn()},onReplayChange:()=>{},close:()=>{}})
  await render(createElement(panel.RecordingPanel,{...panelProps("scene-1"),key:panel.recordingPanelSeatKey("session-1","scene-1")}))
  await act(async()=>{await Promise.resolve()})
  const watch=[...host.querySelectorAll("button")].find(button=>button.textContent?.includes("Watch replay")) as HTMLButtonElement
  await act(async()=>{watch.click();await Promise.resolve()})
  // 在途 open 尚未返回时切实例座位：旧组件被 key 替换，旧回放/迟到结果不能出现在新 Scene。
  await render(createElement(panel.RecordingPanel,{...panelProps("scene-2"),key:panel.recordingPanelSeatKey("session-1","scene-2")}))
  await act(async()=>{resolveOpen(replay);await Promise.resolve();await Promise.resolve()})
  expect(host.querySelector('[data-testid="recording-replay-view"]')).toBeNull()
  expect(host.querySelector('[data-testid="recording-replay-summary"]')).toBeNull()
  // 回到旧 Scene：座位重建，真实历史清单仍可重开。
  const openedAgain={...replay}
  api.request=async(resource:string)=>resource.startsWith("recordings")?[completed]:openedAgain
  await render(createElement(panel.RecordingPanel,{...panelProps("scene-1"),key:panel.recordingPanelSeatKey("session-1","scene-1")}))
  await act(async()=>{await Promise.resolve()})
  const watchAgain=[...host.querySelectorAll("button")].find(button=>button.textContent?.includes("Watch replay")) as HTMLButtonElement
  await act(async()=>{watchAgain.click();await Promise.resolve();await Promise.resolve()})
  expect(host.querySelector('[data-testid="recording-replay-summary"]')).not.toBeNull()
 }))
})
