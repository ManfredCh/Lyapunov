/**
 * D1 + D3 可见性回归（`bugfixHistory/VISIBILITY-HOLES-20260926.md`）：工作台里**用户看到的那句话**。
 *
 * 来源是只读审计 `ZERO-CONSUMER-FIELD-AUDIT-20260926.md` 的两条缺陷：
 *  · **D1**：宿主一直在投影 `computerUse`（`Lyapunov-shell/src/plugin.ts` 的 `computerUseFacts()`：会话开没开、
 *    可见指示亮没亮、上次恢复失败了哪几项、哪些输入被拒），而 `workbench.tsx` 里 `computerUse` **命中 0**、
 *    `WorkbenchState` 也没有这个键 ⇒ 用户看不到"本会话正在控制输入"和"恢复失败了"。
 *  · **D3**：`WorldHandle.warnings` / `deviceDegraded` / `deviceNote` / `deviceKind` / `warpVersion` 在
 *    `packages/<pkg>/src` 里整片 0 读取 ⇒ 世界编译告警（如"纯视觉实体没有碰撞体被物理装配跳过"）与设备降级不可见。
 *
 * 证据分两层，两层缺一不可（**只加字段不接渲染＝把"零消费"变成"两处零消费"**）：
 *  ① **渲染层**：`computerUseNoticeLines()` / `worldFactLines()` 是渲染与判据共用的**同一份**函数，
 *     这里用 `renderToStaticMarkup` 渲染真组件，把"用户看到的那句话"逐字钉住（含黄色告警态与空态不占位）；
 *  ② **挂载层**：本仓**没有**浏览器 DOM 夹具（见 `camera-list-ui.test.ts` 的同一条诚实边界），
 *     所以"这两个组件真的挂在页面上、且 `computerUse` 真的从宿主投影接进了 state"用源码守卫钉住
 *     （与 `env-route-visibility.test.ts` 同一手法）：`setComputerUse(value.computerUse)` + 两处挂载点。
 *
 * `workbench.tsx` 顶层 import 了 `@lyapunov/viewer/client`（浏览器侧包；`dist/client.js` 是插件打包产物、
 * 没有命名导出），bun test 里直接 import 会挂在 `Export named 'createViewer' not found` ⇒ 用 `mock.module`
 * 换成最小桩。公开相机纯投影转口真实实现，不改变本文件测的任何一行判据。
 *
 * ⚠️ 2026-09-27 更新（`USER-VISIBLE-WORDING-20260927`）：文案层把内部标识翻成了用户话
 * （`refusals[].tool`/`code`/`rule`、`lastReport.reason`、裸 ISO 时间戳），本文件里**钉旧文案**的那几行
 * 随之改成钉新文案；同时把夹具里的 `tool`/`code` 换成**产品真值**（真工具名 `cua_driver_native__<动词>`、
 * `computer-use-input.ts` 里的真错误码）——原来的 `cua_driver_native__key` / `CUA_INPUT_REFUSED` 不是本产品
 * 任何一条拒绝路径会产生的取值（`plugin.ts:291` 先用 `cuaInputTools` 三个集合过滤 `exec.name`）。
 * 内部标识**出现/不出现**的完整判据在 `test/computer-use-wording.test.tsx`（本文件不重复）。
 *
 * 运行：`bun test packages/lyapunov-shell/test/computer-use-visibility.test.tsx`
 */
import {describe,expect,mock,test} from "bun:test"
import {readFileSync} from "node:fs"
import {join} from "node:path"
import {renderToStaticMarkup} from "react-dom/server"

import {projectSceneCameraRigs} from "../../viewer/src/scene-camera-rigs.ts"
mock.module("@lyapunov/viewer/client",()=>({projectSceneCameraRigs,createViewer:()=>({}),WebGLUnavailableError:class WebGLUnavailableError extends Error{}}))
const workbench=await import("../src/workbench.tsx")
const ComputerUseFacts=workbench.ComputerUseFacts,WorldFacts=workbench.WorldFacts
const computerUseNoticeLines=workbench.computerUseNoticeLines,worldFactLines=workbench.worldFactLines

const shell=join(import.meta.dirname,"../src")
const workbenchSource=readFileSync(join(shell,"workbench.tsx"),"utf8")
const apiSource=readFileSync(join(shell,"workbench-api.ts"),"utf8")
/** 中文渲染：`tr` 在中文界面下取第一个参数（与 `workbench.tsx:152` 同一份口径）。 */
const tr=((zh:string,_en:string)=>zh) as never
const markup=(node:unknown)=>renderToStaticMarkup(node as never)

/** 宿主 `computerUseFacts()` 的真实形状（`plugin.ts:248` 逐字）+ 一条"恢复失败"的历史报告。 */
const restoreFailedFacts={
 active:true,since:"2026-09-26T18:00:00.000Z",consent:false,consentReason:null,
 indicator:{a11yStatusIcon:"not-needed" as const,changedVisibility:true,notification:"failed" as const,projection:true,visible:false,note:"notify-send 不在 PATH：桌面通知没发出去"},
 snapshot:{at:"2026-09-26T18:00:00.000Z",display:":0",readableCount:7,note:"检查过这些键"},
 lastReport:{at:"2026-09-26T18:00:09.000Z",reason:"idle",note:"RESTORE_FAILED: gsettings set org.gnome.desktop.a11y 退出码 1",restored:["always-show-universal-access-status"],failed:["screen-reader-enabled","stickykeys-enable"]},
 refusals:[
  {at:"2026-09-26T18:00:03.000Z",tool:"cua_driver_native__clipboard_write",code:"CUA_CLIPBOARD_WRITE_REFUSED",rule:"clipboard-not-restorable",combos:[]},
  {at:"2026-09-26T18:00:05.000Z",tool:"cua_driver_native__hotkey",code:"CUA_GLOBAL_INPUT_CONSENT_REQUIRED",rule:"global-needs-consent",combos:["super","space"]},
  {at:"2026-09-26T18:00:07.000Z",tool:"cua_driver_native__press_key",code:"CUA_GLOBAL_INPUT_INDICATOR_REQUIRED",rule:"global-needs-indicator",combos:["alt","tab"]},
 ],
}
const healthyFacts={active:false,since:null,consent:false,consentReason:null,indicator:null,snapshot:null,lastReport:null,refusals:[]}

describe("D1 · computer-use 事实：用户看到的原话",()=>{
 test("会话开着且可见指示**未点亮** ⇒ 页面出现常驻提示（黄条），并给出「看不见提示」这句原话",()=>{
  const html=markup(<ComputerUseFacts computerUse={restoreFailedFacts} tr={tr} place="status"/>)
  expect(html).toContain('data-testid="lyapunov-computer-use"')
  expect(html).toContain('data-cu-line="active"')
  // 时间戳给的是**本地时间的人话**（不再是裸 ISO）——格式断言不写死时区
  expect(html).toContain("本会话正在控制输入（computer-use 会话开始于 ")
  expect(html).toMatch(/本会话正在控制输入（computer-use 会话开始于 \d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}:\d{2}（本地时间））：/)
  expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  expect(html).toContain("可见指示未点亮——你现在看不到")
  expect(html).toContain("全局输入同意：未给")
  // tone=warn 走既有 `.lya-warning`（黄条），不是普通灰字
  expect(html).toContain('class="lya-help lya-warning"')
 })

 test("会话结束**恢复失败** ⇒ 黄条点名哪几项没写回去 + 恢复报告原话",()=>{
  const html=markup(<ComputerUseFacts computerUse={restoreFailedFacts} tr={tr} place="status"/>)
  expect(html).toContain('data-cu-line="restore-failed"')
  expect(html).toContain("空闲太久自动结束")
  expect(html).toContain("结束后，桌面恢复有 2 项没写回去：screen-reader-enabled、stickykeys-enable")
  // 键名保留（用户要去系统设置/gsettings 里查改），但补一句说明它是系统键名
  expect(html).toContain("这些是系统里的设置键名")
  expect(html).toContain("恢复没做完，下面是系统报告的原话（逐字照录，未改写）：RESTORE_FAILED: gsettings set org.gnome.desktop.a11y 退出码 1")
 })

 test("拒绝记录 ⇒ 条数 + 最近一条做了什么／为什么／涉及哪些键（用户能看出「拒的是什么」）",()=>{
  const html=markup(<ComputerUseFacts computerUse={restoreFailedFacts} tr={tr} place="status"/>)
  expect(html).toContain('data-cu-line="refusals"')
  expect(html).toContain("本机记录了 3 次被拒的 computer-use 输入")
  expect(html).toContain("最近一次：按下一个键被拒")
  expect(html).toContain("你已经同意过全局输入，但此刻屏幕上没有「正在控制输入」的可见提示")
  expect(html).toContain("涉及的按键：alt tab")
  expect(html).toContain("被拒的输入一个字节都没发到你的桌面上")
  // 内部标识（工具名／错误码／rule id）一个都不许出现在用户可见文案里
  expect(html).not.toContain("cua_driver_native__")
  expect(html).not.toContain("CUA_")
  expect(html).not.toContain("global-needs-indicator")
 })

 test("恢复**成功**也要说话（不报黄条）：写回了几项、无失败",()=>{
  const facts={...restoreFailedFacts,active:false,indicator:null,refusals:[],lastReport:{...restoreFailedFacts.lastReport,failed:[],restored:["screen-reader-enabled","stickykeys-enable"]}}
  const html=markup(<ComputerUseFacts computerUse={facts} tr={tr} place="status"/>)
  expect(html).toContain('data-cu-line="restore-ok"')
  expect(html).toContain("桌面设置已全部写回（2 项，无失败）")
  expect(html).not.toContain("没写回去")
  expect(html).not.toContain("lya-warning")
 })

 test("健康态／宿主没给这一面 ⇒ 一个字都不渲染（不占位、不编默认值）",()=>{
  expect(computerUseNoticeLines(undefined)).toEqual([])
  expect(computerUseNoticeLines(healthyFacts)).toEqual([])
  expect(markup(<ComputerUseFacts computerUse={undefined} tr={tr} place="status"/>)).toBe("")
  expect(markup(<ComputerUseFacts computerUse={healthyFacts} tr={tr} place="settings"/>)).toBe("")
 })

 test("一个字段两处渲染、同一句话：settings（审计落点）与 status（常驻）逐字相同",()=>{
  const inSettings=markup(<ComputerUseFacts computerUse={restoreFailedFacts} tr={tr} place="settings"/>)
  const inStatus=markup(<ComputerUseFacts computerUse={restoreFailedFacts} tr={tr} place="status"/>)
  for(const line of computerUseNoticeLines(restoreFailedFacts))expect(inSettings).toContain(line.zh)
  for(const line of computerUseNoticeLines(restoreFailedFacts))expect(inStatus).toContain(line.zh)
  expect(inSettings).toContain('data-testid="lyapunov-computer-use-settings"')
  expect(inStatus).toContain('data-testid="lyapunov-computer-use"')
  // 英文界面取第二个参数（与 tr 同一份口径）
  const translated=markup(<ComputerUseFacts computerUse={restoreFailedFacts} tr={((_zh:string,en:string)=>en) as never} place="status"/>)
  expect(translated).toContain("This session is controlling input")
  expect(translated).toContain("left 2 desktop setting(s) unrestored: screen-reader-enabled, stickykeys-enable")
 })

 test("挂载层：合同类型先有键、宿主投影接进 state、两个挂载点都在页面上",()=>{
  // ① 客户端合同（`workbench-api.ts`）：先有类型再谈渲染——没有它渲染点连键都看不见
  expect(apiSource).toContain("export interface ComputerUseFacts {")
  expect(apiSource).toContain("computerUse?:ComputerUseFacts }")
  // ② 宿主状态投影 → 本窗口 state（轮询落地那一句）
  expect(workbenchSource).toContain("setComputerUse(value.computerUse)")
  expect(workbenchSource).toContain('const [computerUse,setComputerUse]=useState<WorkbenchState["computerUse"]>()')
  // ③ 两个挂载点：世界状态行区块（审计落点）+ 底部常驻状态区
  expect(workbenchSource).toContain('<ComputerUseFacts computerUse={computerUse} tr={tr} place="settings"/>')
  expect(workbenchSource).toContain('<ComputerUseFacts computerUse={computerUse} tr={tr} place="status"/>')
  expect(workbenchSource).toContain('data-testid="lyapunov-computer-use-row"')
 })
})

/** 宿主 `sim-mujoco/src/provider.ts:96` 的真实形状：碰撞编译告警并入 sync 句柄。 */
const worldWithWarnings={
 worldId:"w-1",sceneId:"s-1",engineId:"mujoco",engineVersion:"3.3.7",worldGeneration:4,appliedSceneRevision:12,status:"ready" as const,
 warnings:[
  {code:"ENTITY_SKIPPED_NO_COLLISION",entityId:"visual-only-1",message:"纯视觉实体没有碰撞体，物理装配跳过（该实体不参与接触）"},
  {code:"SCENE_COLLISION_HEIGHTFIELD_APPROXIMATED",message:"地面高度场按 64×64 近似"},
 ],
}
const newtonWorld={
 worldId:"w-2",sceneId:"s-1",engineId:"newton",engineVersion:"0.1.0",worldGeneration:1,appliedSceneRevision:3,status:"ready" as const,
 device:"cpu",deviceKind:"cpu" as const,deviceDegraded:true,deviceNote:"auto 下没有可用 CUDA，已降级到 cpu：接触与肌腱按 CPU 后端编译",solver:"xpbd" as const,warpVersion:"1.2.3",
}

describe("D3 · WorldHandle 自报读数：世界状态行补的几行",()=>{
 test("有告警 ⇒ 条数 + **首条原文**（code/entityId 一并给），其余条数如实说",()=>{
  const html=markup(<WorldFacts world={worldWithWarnings} tr={tr}/>)
  expect(html).toContain('data-testid="lyapunov-world-facts"')
  expect(html).toContain('data-world-line="warnings"')
  expect(html).toContain("世界编译告警 2 条（另有 1 条未展开）")
  expect(html).toContain("纯视觉实体没有碰撞体，物理装配跳过（该实体不参与接触）")
  expect(html).toContain("（ENTITY_SKIPPED_NO_COLLISION · visual-only-1）")
  expect(html).toContain('class="lya-help lya-warning"')
 })

 test("设备降级 ⇒ 追加 `deviceNote` 原话；设备/求解器/Warp 版本同处一行",()=>{
  const html=markup(<WorldFacts world={newtonWorld} tr={tr}/>)
  expect(html).toContain('data-world-line="device-degraded"')
  expect(html).toContain("设备已降级（cpu）：auto 下没有可用 CUDA，已降级到 cpu：接触与肌腱按 CPU 后端编译")
  expect(html).toContain("设备 cpu（cpu） · 求解器 xpbd · Warp 1.2.3")
 })

 test("Provider 什么都没自报 ⇒ 一行都不补（不占位、不编「无告警」）",()=>{
  expect(worldFactLines(undefined)).toEqual([])
  expect(worldFactLines({worldId:"w",sceneId:"s",engineId:"mujoco",engineVersion:"3",worldGeneration:1,appliedSceneRevision:1,status:"ready"})).toEqual([])
  expect(markup(<WorldFacts world={undefined} tr={tr}/>)).toBe("")
 })

 test("挂载层：当前world事实传入原物理卡，编译告警与设备降级默认可见",async()=>{
  const {WorldPhysicsPanel}=await import('../src/world-physics-panel.tsx'),noop=()=>{}
  expect(workbenchSource).toContain('diagnostics={<WorldFacts world={world} tr={tr}/>}')
  for(const phase of ['blocked','running','paused']as const){
   const w={...newtonWorld,warnings:worldWithWarnings.warnings,status:phase==='blocked'?'unavailable' as const:phase}
   const html=markup(<WorldPhysicsPanel world={w} state={{phase,code:phase==='blocked'?'SOURCE_NOT_READY':undefined,detail:phase==='blocked'?'当前来源尚未确认':undefined}} worlds={[w]} disabled={false} tr={tr} start={noop} sync={noop} pause={noop} stop={noop} close={noop} prepare={noop} saveGravity={noop} selectWorld={noop} cancel={noop} diagnostics={<WorldFacts world={w} tr={tr}/>}/>)
   const visible=html.split('<details')[0]!
   expect(visible).toContain('data-world-line="warnings"');expect(visible).toContain('ENTITY_SKIPPED_NO_COLLISION');expect(visible).toContain('data-world-line="device-degraded"');expect(visible).toContain(newtonWorld.deviceNote!)
   if(phase==='blocked')expect(visible).toContain('当前来源尚未确认')
  }
  const unknown=markup(<WorldPhysicsPanel state={{phase:'idle'}} worlds={[]} disabled={false} tr={tr} start={noop} sync={noop} pause={noop} stop={noop} close={noop} prepare={noop} saveGravity={noop} selectWorld={noop} cancel={noop} diagnostics={<WorldFacts world={undefined} tr={tr}/>}/>).split('<details')[0]!
  expect(unknown).not.toContain('data-world-line=');expect(unknown).not.toContain('data-testid="world-gravity-readback"');expect(unknown).toContain('世界尚未读回重力与碰撞状态')
 })
})
