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
import {join} from "node:path"
import {renderToStaticMarkup} from "react-dom/server"
import type {RecordingManifest} from "../../robot-workflows/src/recording-files.ts"

// `recording-panel.tsx` 顶层 import 了 `@lyapunov/viewer/client`（浏览器侧包；bun test 里直接 import 会挂在
// `Export named 'createViewer' not found`）⇒ 与 `computer-use-visibility.test.tsx` 同一手法换最小桩。
import {projectSceneCameraRigs} from "../../viewer/src/scene-camera-rigs.ts"
mock.module("@lyapunov/viewer/client",()=>({projectSceneCameraRigs,createViewer:()=>({}),WebGLUnavailableError:class WebGLUnavailableError extends Error{}}))
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
  expect(source).toMatch(/\{rows\.map\(row => <div className="lya-receipt"[^]*?<RecordingMissingFiles row=\{row\} tr=\{tr\}\/>/)
  // ③ 出口侧：`register("recordings")` 发的行必须经真 `recordingSummary`（键名从它来）。
  const plugin=readFileSync(join(shell,"plugin.ts"),"utf8")
  expect(plugin).toContain('register("recordings"')
  expect(plugin).toMatch(/register\("recordings"[^]*?recordingSummary\(manifest,sessionKey\)/)
 })
})
