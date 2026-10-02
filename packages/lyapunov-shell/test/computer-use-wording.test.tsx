/**
 * USER-VISIBLE-WORDING-20260927 · computer-use 那三句的**文案判据**（来源：只读复核
 * `bugfixHistory/VERIFY-USERFIX-20260927.md` §二之5 + Lead 的三条裁定）。
 *
 * 为什么单开一个文件：`computer-use-visibility.test.tsx` 钉的是"D1 事实**有没有**渲染出来"，
 * 本文件钉的是"渲染出来的那句话**用户读不读得懂**，而且**事实一条没少**"。两条判据的失败含义不同：
 *   · 前者红 ⇒ 用户看不到；
 *   · 后者红 ⇒ 用户看得到，但看到的是 `cua_driver_native__press_key —— CUA_GLOBAL_INPUT_INDICATOR_REQUIRED／
 *     global-needs-indicator` 这种内部标识（复核的判定是「第 3 句读不懂」，而它恰恰是唯一告诉用户
 *     "你的输入被拒了"的那句）。
 *
 * 三条判据（本文件逐条钉住）：
 *   ① **不许出现**内部标识：`CUA_*` / 产品 rule id / `cua_driver_native__*` / 裸 ISO 时间戳 /
 *      内部英文枚举（`idle`/`host-unload`/`consent-revoked`/`explicit:`）/ 判据函数名与字段名 / `data-*`；
 *   ② **必须保留**可行动信息：哪个动作被拒了 · 为什么 · 去哪儿能改（设置路径 / 系统键名 / 涉及的按键）；
 *   ③ **不许放宽安全事实**：被拒的条数、可见指示状态、恢复失败项数一条不少，且 `refusals` 那一段
 *      不许整段删掉（数据面：`plugin.ts` 仍在记账、`workbench-api.ts` 仍带着机器字段；渲染面：仍出这一行）。
 *
 * ★**唯一的一处豁免**（Lead 裁定③，逐字写在这里，不许扩大）：第 2 句 `原话（逐字照录，未改写）：` 之后
 * 那份 `lastReport.note` **不许改写**，所以它里面**可能**带着 `CUA_A11Y_RESTORE_FAILED` 这类内部串。
 * 本文件的处理：把该行按 `note` 切成两半 —— **前半句必须 0 命中**，后半句必须与 `report.note` **逐字相同**
 * （`endsWith`）。这条豁免**只覆盖这一处引用**，别的行、别的位置一律 0 命中。
 *
 * 运行：`bun test packages/lyapunov-shell/test/computer-use-wording.test.tsx`
 */
import {describe,expect,mock,test} from "bun:test"
import {readFileSync} from "node:fs"
import {join} from "node:path"
import {renderToStaticMarkup} from "react-dom/server"

import {projectSceneCameraRigs} from "../../viewer/src/scene-camera-rigs.ts"
mock.module("@lyapunov/viewer/client",()=>({projectSceneCameraRigs,createViewer:()=>({}),WebGLUnavailableError:class WebGLUnavailableError extends Error{}}))
const workbench=await import("../src/workbench.tsx")
const ComputerUseFacts=workbench.ComputerUseFacts
const computerUseNoticeLines=workbench.computerUseNoticeLines
const computerUseActionText=workbench.computerUseActionText
const computerUseRefusalReasonText=workbench.computerUseRefusalReasonText
const computerUseEndReasonText=workbench.computerUseEndReasonText
const computerUseClockText=workbench.computerUseClockText

const shell=join(import.meta.dirname,"../src")
const workbenchSource=readFileSync(join(shell,"workbench.tsx"),"utf8")
const pluginSource=readFileSync(join(shell,"plugin.ts"),"utf8")
const apiSource=readFileSync(join(shell,"workbench-api.ts"),"utf8")
const tr=((zh:string,_en:string)=>zh) as never
const markup=(node:unknown)=>renderToStaticMarkup(node as never)

/** 判据①：Lead 点名的五类 + 只读复核那套（每条独立给命中，不合并成一个布尔）。 */
const FORBIDDEN:Array<[string,RegExp]>=[
 ["CUA_* 错误码",/CUA_[A-Z_]+/],
 ["产品 rule id",/\b(?:global-needs-consent|global-needs-indicator|clipboard-not-restorable|clipboard-read-not-disclosable|a11y-screen-reader|a11y-magnifier|a11y-sticky-keys|media-keys|ime-switch|wm-window-switch|accessx-toggle|vt-switch-and-desktop|super-combos|sysrq|unparsable|drag-moves-user-window|not-an-input-tool|key-field-unusable|session-unavailable)\b/],
 ["驱动工具名 cua_driver_*",/cua_driver_[a-z_]*/],
 ["裸 ISO 时间戳",/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/],
 ["内部英文枚举",/\b(?:idle|host-unload|consent-revoked|explicit:)\b/],
 ["判据函数名",/planComputerUseInput/],
 ["字段名",/\b(?:lastReport|refusals|a11yStatusIcon|consentReason|readableCount|changedVisibility|restored|failed|combos|snapshot)\b/],
 ["data-* 名",/data-[a-z-]+/],
]
/** 英文句子里 `snapshot`/`restored` 这类是正常的英文词，所以英文只用"标识类"那几条（字段名那条不适用）。 */
const FORBIDDEN_EN=FORBIDDEN.filter(([label])=>label!=="字段名")
const hits=(text:string,patterns=FORBIDDEN)=>patterns.flatMap(([label,re])=>[...new Set(text.match(new RegExp(re.source,"g"))||[])].map(hit=>`${label} ⇒ ${hit}`))
/**
 * ★比"点名的几个 rule id"更硬的一条：**中文用户话里不许出现任何小写连字符标识**
 * （`global-needs-indicator` / `drag-moves-user-window` / 将来新加的 rule id 都是这个形状）。
 * 白名单只有两样（都是 Lead 裁定要保留的）：
 *   · `computer-use` —— 功能名（黄条徽标上就写着它）；
 *   · `lastReport.failed[]` 里的 GNOME 桌面键名（裁定④：真实键名保留原文，用户要拿去 `gsettings` 查改）。
 */
const hyphenTokens=(text:string)=>[...new Set(text.match(/[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g)||[])]
const strayIdentifiers=(text:string,allowed:readonly string[])=>hyphenTokens(text).filter(token=>!allowed.includes(token))

/** 产品真值夹具（工具名/错误码逐字取自 `computer-use-input.ts`；`report.note` 逐字取自 `restoreDesktopSettings`）。 */
const REAL_NOTE="有 2 个键**没能写回原值**（screen-reader-enabled、stickykeys-enable）：CUA_A11Y_RESTORE_FAILED: org.gnome.desktop.a11y.applications screen-reader-enabled 写回 false 失败（退出码 1）；CUA_A11Y_RESTORE_FAILED: org.gnome.desktop.a11y.keyboard stickykeys-enable 写回 false 失败（退出码 1）"
const factsOf=(over:Record<string,unknown>={})=>({
 active:true,since:"2026-09-26T18:00:00.000Z",consent:false,consentReason:null,
 indicator:{a11yStatusIcon:"not-needed" as const,changedVisibility:true,notification:"failed" as const,projection:true,visible:false,note:"notify-send 不在 PATH：桌面通知没发出去"},
 snapshot:{at:"2026-09-26T18:00:00.000Z",display:":0",readableCount:7,note:"检查过这些键"},
 lastReport:{at:"2026-09-26T18:00:09.000Z",reason:"idle",note:REAL_NOTE,restored:["always-show-universal-access-status"],failed:["screen-reader-enabled","stickykeys-enable"]},
 refusals:[
  {at:"2026-09-26T18:00:03.000Z",tool:"cua_driver_native__clipboard_write",code:"CUA_CLIPBOARD_WRITE_REFUSED",rule:"clipboard-not-restorable",combos:[]},
  {at:"2026-09-26T18:00:05.000Z",tool:"cua_driver_native__hotkey",code:"CUA_GLOBAL_INPUT_CONSENT_REQUIRED",rule:"global-needs-consent",combos:["super","space"]},
  {at:"2026-09-26T18:00:07.000Z",tool:"cua_driver_native__press_key",code:"CUA_GLOBAL_INPUT_INDICATOR_REQUIRED",rule:"global-needs-indicator",combos:["alt","tab"]},
 ],
 ...over,
})
const REAL_FACTS=factsOf()
const linesOf=(cu:unknown)=>computerUseNoticeLines(cu as never)
const zhOf=(cu:unknown)=>linesOf(cu).map(line=>line.zh)

/** HTML → 用户读到的文本（去标签、去属性、折叠空白）；并按裁定③切出 `note` 前后两半。 */
const visibleOf=(html:string)=>{
 const text=html.replace(/<[^>]+>/g," ").replace(/computer-use/g," ").replace(/\s+/g," ").trim()
 const at=text.indexOf(REAL_NOTE)
 return {text,quoted:at>=0,beforeQuote:at<0?text:text.slice(0,at),afterQuote:at<0?"":text.slice(at+REAL_NOTE.length)}
}

describe("判据① · 用户可见文案里不许出现内部标识",()=>{
 test("三句（中文）逐句扫：第 1、3 句 0 命中；第 2 句只有 `原话：` 之后那份逐字引用可能带内部串",()=>{
  const lines=linesOf(REAL_FACTS)
  expect(lines.map(line=>line.key)).toEqual(["active","restore-failed","refusals"])
  expect(hits(lines[0]!.zh)).toEqual([])
  expect(hits(lines[2]!.zh)).toEqual([])
  // 连字符标识的**通用**那条：中文话里只准出现 `computer-use`，第 2 句另准 GNOME 键名（裁定④）
  expect(strayIdentifiers(lines[0]!.zh,["computer-use"])).toEqual([])
  expect(strayIdentifiers(lines[2]!.zh,["computer-use"])).toEqual([])
  expect(strayIdentifiers(lines[1]!.zh,["computer-use",...REAL_FACTS.lastReport.failed])).toEqual([])
  const restore=lines[1]!.zh
  // ★豁免面**只到**"note 逐字引用"为止：把它整段切掉后，前半句必须 0 命中
  expect(restore.endsWith(REAL_NOTE)).toBe(true)
  const beforeQuote=restore.slice(0,restore.length-REAL_NOTE.length)
  expect(hits(beforeQuote)).toEqual([])
  expect(strayIdentifiers(beforeQuote,["computer-use",...REAL_FACTS.lastReport.failed])).toEqual([])
  // 引用本身确实带着内部串（如实登记：我们没有把它藏起来，也没有改写它）
  expect(hits(restore).length).toBeGreaterThan(0)
  expect(hits(restore)).toContain("CUA_* 错误码 ⇒ CUA_A")
 })

 test("渲染出来的 HTML 文本节点也扫一遍（不是只扫判据函数的返回值）",()=>{
  const html=markup(<ComputerUseFacts computerUse={REAL_FACTS} tr={tr} place="status"/>)
  const visible=visibleOf(html)
  expect(visible.quoted).toBe(true)
  // 引用之前（第 1 句 + 第 2 句前半）与引用之后（第 3 句）都必须 0 命中
  expect(hits(visible.beforeQuote)).toEqual([])
  expect(hits(visible.afterQuote)).toEqual([])
  expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
 })

 test("英文界面同一条判据（标识类 0 命中）",()=>{
  const en=(zh:string,_en:string)=>_en
  const html=markup(<ComputerUseFacts computerUse={REAL_FACTS} tr={en as never} place="status"/>)
  const visible=visibleOf(html)
  // 英文侧同样只豁免那一份逐字引用
  expect(visible.quoted).toBe(true)
  expect(hits(visible.beforeQuote,FORBIDDEN_EN)).toEqual([])
  expect(hits(visible.afterQuote,FORBIDDEN_EN)).toEqual([])
 })

 test("映射表本身干净：33 个 rule id、35 个动作名、4 种结束原因 + 兜底，逐个扫",()=>{
  // rule id 取值域＝`computer-use-input.ts` 的三张表（input/state/read）+ 快捷键规则 + 计划期规则 + `plugin.ts` 的 session-unavailable
  const rules=["global-needs-consent","global-needs-indicator","clipboard-not-restorable","clipboard-read-not-disclosable","trajectory-replay-bypasses-input-guard","capture-escalation-not-reversible","dependency-install-not-reversible","process-termination-not-reversible","driver-config-not-restorable","window-frame-not-restorable","foreground-activation-not-restored","browser-download-writes-user-disk","browser-prepare-exposes-devtools","app-launch-runs-arbitrary-command","legacy-page-escape-hatch","desktop-capture-not-disclosable","local-file-upload-not-disclosable","driver-tool-unclassified","a11y-screen-reader","a11y-magnifier","a11y-sticky-keys","media-keys","ime-switch","wm-window-switch","accessx-toggle","vt-switch-and-desktop","super-combos","sysrq","unparsable","drag-moves-user-window","not-an-input-tool","key-field-unusable","session-unavailable","这台工作台没见过的新规则"]
  for(const rule of rules){
   const text=computerUseRefusalReasonText(rule)
   expect(text.zh.length).toBeGreaterThan(6)
   expect(text.en.length).toBeGreaterThan(6)
   expect(hits(text.zh)).toEqual([])
   expect(hits(text.en,FORBIDDEN_EN)).toEqual([])
   expect(strayIdentifiers(text.zh,["computer-use"])).toEqual([])
  }
  const tools=["click","double_click","right_click","drag","move_cursor","type_text","press_key","hotkey","scroll","browser_dialog","mouse_button_down","mouse_button_up","mouse_drag","parallel_mouse_drag","set_value","invoke_menu","browser_click","browser_type","browser_pointer","browser_navigate","clipboard_write","clipboard_read","replay_trajectory","escalate_session","install_ffmpeg","kill_app","set_config","set_window_frame","bring_to_front","browser_download","browser_prepare","launch_app","page","get_desktop_state","browser_set_input_files","过去没有过的动作"]
  for(const tool of tools){
   const text=computerUseActionText(`cua_driver_native__${tool}`)
   expect(text.zh.length).toBeGreaterThan(1)
   expect(hits(text.zh)).toEqual([])
   expect(hits(text.en,FORBIDDEN_EN)).toEqual([])
   // 动作名进句子时也得干净（兜底那句不能把原始工具名带出来）
   expect(text.zh).not.toContain(tool)
  }
  for(const reason of ["idle","host-unload","consent-revoked","explicit:session-55f4b555","将来才有的一种结束原因"]){
   const text=computerUseEndReasonText(reason)
   expect(text.zh.length).toBeGreaterThan(2)
   expect(hits(text.zh)).toEqual([])
   expect(hits(text.en,FORBIDDEN_EN)).toEqual([])
  }
 })

 test("时间戳：本地时间人话；没给/读不出来也是人话（裸 ISO 一个都不出现）",()=>{
  const at=computerUseClockText("2026-09-26T18:00:00.000Z")
  expect(at.zh).toMatch(/^\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}:\d{2}（本地时间）$/)
  expect(at.zh).toContain("（本地时间）")
  expect(hits(at.zh)).toEqual([])
  expect(hits(at.en,FORBIDDEN_EN)).toEqual([])
  for(const bad of [undefined,null,"","不是时间"]){
   const text=computerUseClockText(bad as never)
   expect(hits(text.zh)).toEqual([])
   expect(hits(text.en,FORBIDDEN_EN)).toEqual([])
  }
  // 同一个瞬间 ⇒ 同一个串（格式化只依赖本地时区解释，不依赖调用时刻）
  expect(computerUseClockText(new Date("2026-09-26T18:00:00.000Z").toISOString())).toEqual(at)
 })
})

describe("判据② · 可行动信息必须保留（哪个动作 · 为什么 · 去哪儿能改）",()=>{
 test("第 3 句：动作 + 原因 + 涉及的按键，一个不少",()=>{
  const refusal=linesOf(REAL_FACTS)[2]!
  expect(refusal.zh).toContain("最近一次：按下一个键被拒")
  expect(refusal.zh).toContain("你已经同意过全局输入，但此刻屏幕上没有「正在控制输入」的可见提示")
  expect(refusal.zh).toContain("要放行得先让这个提示亮起来")
  expect(refusal.zh).toContain("涉及的按键：alt tab")
  const en=linesOf(REAL_FACTS)[2]!
  expect(refusal.en).toContain("a key press was refused")
  expect(refusal.en).toContain("keys involved: alt tab")
  expect(en.key).toBe("refusals")
 })

 test("真工具名各自给出**互不相同**的中文动作（不再出现驱动名）",()=>{
  const named=["press_key","hotkey","click","type_text","drag","clipboard_read"].map(name=>({name,text:computerUseActionText(`cua_driver_native__${name}`)}))
  expect(new Set(named.map(entry=>entry.text.zh)).size).toBe(named.length)
  for(const entry of named)expect(entry.text.zh).not.toContain(entry.name)
 })

 test("第 2 句：失败项点名 + 设置路径 + 「这些是系统里的键名」+ `gsettings`",()=>{
  const restore=linesOf(REAL_FACTS)[1]!
  expect(restore.zh).toContain("screen-reader-enabled、stickykeys-enable")
  expect(restore.zh).toContain("这些是系统里的设置键名")
  expect(restore.zh).toContain("在系统「设置」里能找到对应的开关")
  expect(restore.zh).toContain("gsettings")
  expect(restore.zh).toContain("恢复没做完")
 })

 test("第 1 句：可见指示状态 + 全局同意状态（用户上次投诉的那件事）",()=>{
  const active=linesOf(REAL_FACTS)[0]!
  expect(active.zh).toContain("本会话正在控制输入")
  expect(active.zh).toContain("可见指示未点亮——你现在看不到「正在控制输入」的提示")
  expect(active.zh).toContain("全局输入同意：未给")
  const given=linesOf(factsOf({consent:true,consentReason:"我同意这次会话发全局输入"}))[0]!
  expect(given.zh).toContain("全局输入同意：已给（我同意这次会话发全局输入）")
 })
})

describe("判据③ · 安全事实一条不许少（文案友好化 ≠ 少说）",()=>{
 test("被拒的**条数**照旧出现，且宿主截断到最近 5 条时不许把「至少 5 次」说成「5 次」",()=>{
  const three=linesOf(REAL_FACTS)[2]!
  expect(three.zh).toContain("本机记录了 3 次被拒的 computer-use 输入")
  const five=linesOf(factsOf({refusals:[...REAL_FACTS.refusals,...REAL_FACTS.refusals.slice(0,2)]}))[2]!
  expect(five.zh).toContain("本机记录了至少 5 次被拒的 computer-use 输入")
  expect(five.zh).toContain("这一行只列最近 5 条")
  expect(five.zh).toContain("最近一次：")
 })

 test("「被拒」这件事必须说清是**没有发出去**（不是「出错了」）",()=>{
  expect(linesOf(REAL_FACTS)[2]!.zh).toContain("被拒的输入一个字节都没发到你的桌面上")
  expect(linesOf(REAL_FACTS)[2]!.en).toContain("not a single byte")
 })

 test("可见指示亮着/没亮两种状态都照旧分行如实说",()=>{
  const off=linesOf(REAL_FACTS)[0]!
  expect(off.tone).toBe("warn")
  expect(off.zh).toContain("可见指示未点亮")
  const on=linesOf(factsOf({indicator:{a11yStatusIcon:"visible" as const,changedVisibility:false,notification:"sent" as const,projection:true,visible:true,note:"可见"}}))[0]!
  expect(on.tone).toBe("muted")
  expect(on.zh).toContain("可见指示已点亮")
  // 无障碍状态读不到也照旧说
  const unreadable=linesOf(factsOf({indicator:{a11yStatusIcon:"unreadable" as const,changedVisibility:false,notification:"failed" as const,projection:true,visible:false,note:"读不到"}}))[0]!
  expect(unreadable.zh).toContain("无障碍状态读不到")
 })

 test("恢复失败/恢复成功两种都照旧说话；失败时项数与项名不少",()=>{
  const failed=linesOf(REAL_FACTS)[1]!
  expect(failed.tone).toBe("warn")
  expect(failed.zh).toContain("桌面恢复有 2 项没写回去")
  const ok=linesOf(factsOf({active:false,refusals:[],lastReport:{...REAL_FACTS.lastReport,failed:[],restored:["screen-reader-enabled","stickykeys-enable"]}}))[0]!
  expect(ok.key).toBe("restore-ok")
  expect(ok.tone).toBe("muted")
  expect(ok.zh).toContain("桌面设置已全部写回（2 项，无失败）")
 })

 test("★`refusals` 这一段不许整段删掉：渲染面 + 数据面 + 宿主记账面三条一起钉",()=>{
  // 渲染面：这一行还在，而且带 key 锚点
  expect(linesOf(REAL_FACTS).some(line=>line.key==="refusals")).toBe(true)
  expect(workbenchSource).toContain('key:"refusals"')
  // 数据面：机器字段仍在合同里（诊断/模型仍拿得到 code/rule/tool，只是不进用户那句话）
  expect(apiSource).toContain("refusals:Array<{at:string;tool:string;code:string;rule:string;combos:readonly string[]}>")
  // 宿主记账面：拒绝时仍在写账（`plugin.ts` 的 refuse()）
  expect(pluginSource).toContain("cuaRefusals.push(")
  expect(pluginSource).toContain("rule:plan.rule")
  expect(pluginSource).toContain("combos:plan.combos")
  expect(pluginSource).toContain("refusals:cuaRefusals.slice(-5)")
 })

 test("健康态/空态照旧一个字都不渲染（改文案没有把空态变成占位）",()=>{
  const healthy={active:false,since:null,consent:false,consentReason:null,indicator:null,snapshot:null,lastReport:null,refusals:[]}
  expect(linesOf(undefined)).toEqual([])
  expect(linesOf(healthy)).toEqual([])
  expect(markup(<ComputerUseFacts computerUse={undefined} tr={tr} place="status"/>)).toBe("")
 })
})
