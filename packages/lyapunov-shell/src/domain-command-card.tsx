import type {Context} from "@deepseek-ai/cordis"
import type {CommandRowOwnerProps} from "@deepseek-ai/dsh-client-ui-chat/client"
import type {PropsLocale} from "@deepseek-ai/dsh-client-ui-slots"
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client"
import { displayPath, hasRawCommandIOAccess, publicCommandFace, publicStatusOf, redactSecretsText, sanitizeOutbound } from "../../lyapunov-contracts/src/command-privacy.ts"

/**
 * 发行构建的一闸：`script/build-plugins.ts` 用 define 内联 `"0"`（浏览器 bundle 里没有开孔）。
 * 与运行期可信 profile **取与**：两闸都开才出诊断面（`hasRawCommandIOAccess` 是唯一判据）。
 */
const BUILD_ALLOWS_RAW_COMMAND_IO = false

/** 卡片视图的纯投影：测试与组件共用同一份判据（不渲染原始内部 JSON，除非两闸都开）。 */
export function commandCardView(input:{name:string;args?:string|null;outcomeText?:string|null;kind:"success"|"error"|null},opts:{english:boolean;allowRaw:boolean;mode?:string}){
 const english=opts.english,outcomeText=input.outcomeText??undefined,details=unpack(outcomeText),info=domainCommandSummary(input.name,outcomeText,input.kind??null,english)
 const allowRaw=hasRawCommandIOAccess(opts.mode??"formal",opts.allowRaw)
 return {
  title:names[input.name]?.[english?1:0]??input.name,
  summary:info.summary,tone:info.tone,
  detailRows:publicCommandFace(input.name,details,english),
  diagnostics:allowRaw?{
   ...input.args?{args:redactSecretsText(String(input.args))}:{},
   ...input.outcomeText!==undefined&&input.outcomeText!==null?{result:redactSecretsText(String(input.outcomeText))}:{},
  }:null,
 }
}

const names:Record<string,[string,string]>={
 sensor_capture_ui:["采集 RGB-D","Capture RGB-D"],fastgs_external:["FastGS 外部工具","FastGS external tool"],
 robot_fleet_run:["多机器人分工","Fleet workflow"],robot_fleet_route:["规划交通路线","Plan traffic route"],
 robot_cargo_transfer:["搬运货物","Transfer cargo"],
 recording_start:["开始录制","Start recording"],recording_stop:["停止录制","Stop recording"],recording_list:["录制列表","Recordings"],recording_inspect:["查看录制来源","Inspect recording"],recording_export:["导出数据集","Export dataset"],
 scene_create:["新建场景","Create scene"],scene_inspect:["读取场景","Inspect scene"],scene_list:["场景列表","List scenes"],scene_history:["场景版本","Scene history"],scene_restore:["恢复场景版本","Restore scene version"],scene_edit:["编辑场景","Edit scene"],scene_import:["导入资产","Import asset"],scene_import_url:["从 HTTPS 导入 GLB","Import GLB from HTTPS"],scene_asset_acquire:["导入模型及依赖","Import model and dependencies"],scene_mount:["放入资产","Place asset"],scene_open:["打开工程","Open project"],scene_save:["保存工程","Save project"],scene_align:["对齐对象","Align object"],
 asset_list:["资源列表","List resources"],asset_edit:["编辑资源","Edit resource"],asset_verify:["检查资源","Check resource"],asset_bake:["生成碰撞表示","Bake collision"],
 sim_open:["启动模拟","Start simulation"],sim_sync:["同步场景","Sync scene"],sim_close:["关闭模拟","Close simulation"],sim_stop:["停止模拟","Stop simulation"],sim_execute_batch:["同步运动","Synchronized motion"],sim_action_receipt:["动作结果","Action receipt"],sim_assist:["模拟辅助操作","Assisted simulation"],
 robot_load:["加载机器人","Load robot"],robot_describe:["读取机器人","Describe robot"],robot_state:["读取状态","Observe state"],robot_move:["关节运动","Joint motion"],robot_walk:["行走","Walk"],robot_gripper:["夹爪控制","Gripper control"],robot_stop:["停止机器人","Stop robot"],robot_pick:["抓取","Pick"],robot_place:["放置","Place"],joint_move:["关节 / 升降","Joint / lift"],vehicle_drive:["车辆控制","Drive vehicle"],viewer_capture:["采集图像","Capture image"],sensor_capture:["传感器采集","Sensor capture"],segment_sam3:["SAM3 图像分割","SAM3 segmentation"],segment_fastgs:["FastGS 分割（历史点击协议，已停用）","FastGS segmentation (retired click protocol)"],
 policy_search:["检索策略来源","Search policies"],policy_metadata:["策略元数据","Policy metadata"],policy_files:["策略文件","Policy files"],policy_verify:["校验策略","Verify policy"],policy_prepare:["装配策略","Prepare policy"],policy_match:["匹配策略","Match policy"],policy_download:["下载策略","Download policy"],policy_execute:["执行策略","Execute policy"],policy_stop:["停止策略","Stop policy"],
}
const shortened=(value:unknown,max=50)=>String(value??"").length>max?String(value).slice(0,max-1)+"…":String(value??"")
/** 失败摘要只留服务端给的公开码 + 人话（`P402: …`），内部码/栈/路径已在出站投影点去掉。 */
function stripPublicError(text?:string):string|undefined{const value=String(text??"").trim();return value?value:undefined}
/**
 * 卡片只读**服务端已裁剪的公共面**（`command/done.text`／命令 HTTP `text` 都是它）：
 * 内部 JSON 在出站投影点就不存在了，所以这里不需要、也不可能还原 `result` 兜底。
 * 旧日志里的 `{result:…}` 只按显示路径处理，不再整份上屏。
 */
function unpack(text?:string):any{if(!text)return;try{const value=JSON.parse(text);if(value&&typeof value.result==="string")return sanitizeOutbound(JSON.parse(value.result))}catch{}try{return JSON.parse(text)}catch{return {text}}}
/** 发行态构建恒为 false（build-plugins 的 define 内联）；运行期还要可信 profile 同时为 developer 才出诊断面。 */
const hostMode = (globalThis as {process?:{env?:Record<string,string|undefined>}}).process?.env?.LYAPUNOV_MODE
export function domainCommandSummary(name:string,text:string|undefined,kind:"success"|"error"|null,english=false){
 const tr=(cn:string,en:string)=>english?en:cn
 if(kind===null)return {summary:tr("执行中…","Running…"),tone:"running"}
 if(kind==="error")return {summary:shortened(stripPublicError(text)??tr("执行失败","Failed"),280),tone:"error"}
 const value=unpack(text)
 if(typeof value?.items==="number")return {summary:tr(`${value.items} ${name==="scene_list"?"个场景":name==="asset_list"?"项资源":"项结果"}`,`${value.items} ${name==="scene_list"?"scenes":name==="asset_list"?"resources":"results"}`),tone:"ok"}
 if(Array.isArray(value))return {summary:tr(`${value.length} ${name==="scene_list"?"个场景":name==="asset_list"?"项资源":"项结果"}`,`${value.length} ${name==="scene_list"?"scenes":name==="asset_list"?"resources":"results"}`),tone:"ok"}
 if(value?.stopped===true)return {summary:tr(`已停止 · step ${value.stepIndex}`,`Stopped · step ${value.stepIndex}`),tone:"ok"}
 if(value?.closed===true)return {summary:tr("世界已关闭","World closed"),tone:"ok"}
 if(value?.width!==undefined&&value?.height!==undefined&&(value?.rgb!==undefined||value?.captureId===undefined&&value?.pinhole!==undefined))return {summary:`${value.width} × ${value.height} · ${value.resolvedCameraName??value.cameraName??""} · ${value.pinhole?tr("已标定","Calibrated"):tr("自由相机，未标定","Free camera, uncalibrated")}${value.stepIndex===undefined?"":` · step ${value.stepIndex}`}`,tone:"ok"}
 // 尺寸按记录的正本（originalImage 原帧）报；附件被缩过图时它只是预览，摘要里点明。
 if(value?.captureId!==undefined&&value.attachment){const width=value.originalImage?.width??value.attachment.width,height=value.originalImage?.height??value.attachment.height;return {summary:`${width} × ${height}${value.originalImage?tr("（原帧；附件是预览）"," (original frame; attachment is a preview)"):""} · rev ${value.sceneRevision}${value.stepIndex===undefined?"":` · step ${value.stepIndex}`}`,tone:"ok"}}
 if(value?.actionId){
  const status=({accepted:tr("已接受","Accepted"),running:tr("执行中","Running"),completed:tr("执行完成","Completed"),failed:tr("执行失败","Failed"),cancelled:tr("已取消","Cancelled")} as Record<string,string>)[value.status]??String(value.status)
  // 指令结束 ≠ 到达目标（真实回执里 `effect.motions[].targetReached=false` 明确写了没进容差）：
  // 摘要不得只写"执行完成"而把这层事实藏在展开的原回执里——原回执照旧完整保留。
  const motions=Array.isArray(value.effect?.motions)?value.effect.motions as any[]:[]
  const unreached=motions.filter(motion=>motion?.targetReached===false)
  const tolerance=typeof unreached[0]?.tolerance==="number"?`（${tr("容差","tolerance")} ${unreached[0].tolerance}）`:""
  const headline=value.status==="completed"&&unreached.length?tr("动作已结束，目标未到达","Action finished; target not reached"):status
  return {summary:`${headline}${value.startStep===undefined?"":` · step ${value.startStep} → ${value.endStep??"…"}`}${unreached.length?` · ${unreached.length}/${motions.length} ${tr("个动作未进入容差","motions outside tolerance")}${tolerance}`:""}${value.taskAchieved===undefined?"":value.taskAchieved?tr(" · 任务达成"," · Task achieved"):tr(" · 任务未达成"," · Task not achieved")}${value.reason?" · "+shortened(value.reason,100):""}`,tone:value.status==="failed"?"error":value.status==="cancelled"||unreached.length?"warning":"ok"}
 }
 // 能力包三面回执（搜/取/装配各报它**实际返回**的字段）：发现面写 plane 与匹配数；
 // 装配面写 status 与模型入口（直控路由的入口是缓存内绝对路径，交不出时报错码，不会走这里）。
 if(Array.isArray(value?.models))return {summary:`${value.models.length} ${tr("个能力包","packs")} · ${publicStatusOf(value.status)||"—"}`,tone:value.status==="ready"?"ok":"warning"}
 if(value?.status==="ready"&&value?.modelEntry!==undefined)return {summary:`${tr("装配完成","Prepared")}${value.modelEntry?` · ${shortened(displayPath(String(value.modelEntry)),60)}`:tr(" · 无模型入口"," · no model entry")}`,tone:"ok"}
 if(typeof value?.files==="number"&&typeof value?.bytes==="number")return {summary:`${tr("已取件","Fetched")} · ${value.files} ${tr("个文件","files")}`,tone:"ok"}
 const entities=(row:any)=>typeof row==="number"?row:Array.isArray(row)?row.length:0
 const snapshot=value?.snapshot??(value?.sceneId&&value.entities!==undefined?value:undefined)
 if(snapshot)return {summary:`${value.name?shortened(value.name,28)+" · ":""}rev ${snapshot.revision} · ${entities(snapshot.entities??snapshot.entityCount)} ${tr("个实体","entities")}${entities(value.missing)?tr(` · ${entities(value.missing)} 项引用缺失`,` · ${entities(value.missing)} missing references`):""}`,tone:entities(value.missing)?"warning":"ok"}
 if(value?.worldId&&value.engineId)return {summary:`${value.engineId} · generation ${value.worldGeneration} · rev ${value.appliedSceneRevision} · ${value.status}`,tone:["unsynced","unavailable"].includes(value.status)?"warning":"ok"}
 if(value?.joints!==undefined&&value.entityId)return {summary:`${shortened(value.entityId,24)} · ${entities(value.joints)} ${tr("个关节","joints")}${value.controlledJointNames?` · ${entities(value.controlledJointNames)} ${tr("可控","controlled")}`:""}`,tone:"ok"}
 if(value?.frameId)return {summary:`step ${value.stepIndex} · ${Number(value.simTime).toFixed(3)} s · ${entities(value.entities)} ${tr("个实体","entities")}`,tone:"ok"}
 if(typeof value?.valid==="boolean")return {summary:value.valid?tr("校验通过","Verification passed"):tr(`缺失 ${entities(value.missing)} 项 · 变化 ${entities(value.changed)} 项`,`${entities(value.missing)} missing · ${entities(value.changed)} changed`),tone:value.valid?"ok":"warning"}
 if(value?.name!==undefined)return {summary:`${shortened(value.name,40)}${value.ref?.version===undefined?"":` · v${value.ref.version}`}${value.deletedAt?tr(" · 回收站"," · In trash"):""}`,tone:"ok"}
 if(value?.masks!==undefined)return {summary:value.emptyResult?tr("未找到匹配对象","No matching objects"):`${value.provider??""} · ${entities(value.masks)} masks`,tone:"ok"}
 if(value?.status==="absent"&&Array.isArray(value.masks)===false&&value.models!==undefined&&value.items===undefined)return {summary:tr("没有匹配的 policy · 请调整检索条件","No matching policy · adjust the search"),tone:"warning"}
 if(value?.status==="blocked"&&typeof value.blocked==="number")return {summary:tr(`已阻断 · ${value.blocked} 项匹配条件不满足`,"Blocked · match requirements unmet"),tone:"warning"}
 if(value?.output?.artifacts!==undefined)return {summary:`${value.provider??""} · ${entities(value.output.artifacts)} ${tr("个产物","artifacts")}`,tone:"ok"}
 if(value?.recordingId&&typeof value.frameCount==="number")return {summary:`${value.status??""} · ${value.frameCount} ${tr("帧","frames")}${value.lastFrame?` · g${value.lastFrame.generation} / step ${value.lastFrame.stepIndex}`:""}`,tone:value.status==="failed"?"error":value.status==="recording"?"running":"ok"}
 if(value?.assignments!==undefined&&typeof value.taskAchieved==="boolean")return {summary:`${entities(value.assignments)} ${tr("个分工","assignments")} · ${entities(value.actions)} ${tr("个批次","batches")} · ${value.taskAchieved?tr("任务达成","Task achieved"):tr("任务未达成","Task not achieved")}`,tone:value.taskAchieved?"ok":"warning"}
 if(typeof value?.taskAchieved==="boolean")return {summary:(value.taskAchieved?tr("任务达成","Task achieved"):tr("任务未达成","Task not achieved"))+(value.reason?" · "+shortened(value.reason,120):""),tone:value.taskAchieved?"ok":"warning"}
 if(value?.execution==="not-started")return {summary:tr("路线已计算，尚未执行","Route computed; not executed"),tone:"ok"}
 if(value?.jobId)return {summary:tr("任务已启动","Job started"),tone:"running"}
 return {summary:value?tr("操作完成，详情可展开","Completed; expand for details"):shortened(text??tr("操作完成","Completed"),140),tone:"ok"}
}
function DomainCommandCard({node,t}:CommandRowOwnerProps&PropsLocale<"lyapunov">){
 const english=t("open")==="Scene workbench",name=node.name??""
 const view=commandCardView({name,args:node.args,outcomeText:node.outcome?.text,kind:node.outcome?.kind??null},{english,allowRaw:BUILD_ALLOWS_RAW_COMMAND_IO,mode:hostMode})
 return <details className="lya-domain-command" data-domain-command={name} data-gesture-id={node.display?.gestureId} data-state={view.tone}><style>{`
 .lya-domain-command{border:1px solid var(--dsw-alias-border-l3,#344255);border-radius:7px;margin:5px 0;background:var(--dsw-alias-bg-l1,transparent);font-size:12px;min-width:0}.lya-domain-command>summary{cursor:pointer;display:flex;align-items:baseline;gap:9px;padding:8px 10px;list-style:none}.lya-domain-command>summary::before{content:'▸';opacity:.6;flex:none}.lya-domain-command[open]>summary::before{content:'▾'}.lya-domain-command>summary strong{font-weight:550;flex:none}.lya-domain-command-summary{opacity:.78;white-space:normal;overflow-wrap:anywhere;line-height:1.45}.lya-domain-command[data-state=error] .lya-domain-command-summary{color:#e47680;opacity:1}.lya-domain-command[data-state=warning] .lya-domain-command-summary{color:#d3a562;opacity:1}.lya-domain-command pre{margin:0;padding:10px;font:11px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:330px;overflow:auto;border-top:1px solid var(--dsw-alias-border-l3,#344255)}.lya-domain-command small{display:block;padding:7px 10px 0;opacity:.65}.lya-domain-command-details{padding:4px 10px 8px;line-height:1.55;opacity:.88;white-space:normal;overflow-wrap:anywhere}
 `}</style><summary><strong>{view.title}</strong><span className="lya-domain-command-summary">{node.display?.phase==='update'?(english?'Gesture in progress; final target pending. · ':'手势中，最终目标尚未提交。 · '):''}{view.summary}</span></summary>
  {node.gestureHistory&&node.gestureHistory.length>1&&<div className="lya-domain-command-details"><strong>{english?`Recorded commands: ${node.gestureHistory.length}`:`本手势 ${node.gestureHistory.length} 条真实命令`}</strong>{node.gestureHistory.map(row=><p key={row.commandId}>{row.phase} · {row.outcome?domainCommandSummary(row.name??'joint_move',row.outcome.text,row.outcome.kind,english).summary:english?'Pending engine receipt':'等待引擎回执'}</p>)}</div>}
  <small>{english?"Details":"详情"}</small>
  <div className="lya-domain-command-details">{view.detailRows.map(row=><div key={row}>{row}</div>)}</div>
  {view.diagnostics&&(view.diagnostics.args!==undefined||view.diagnostics.result!==undefined)&&<><small>{english?"Diagnostics (secrets redacted)":"诊断（凭据已脱敏）"}</small>
   {view.diagnostics.args!==undefined&&<pre>{view.diagnostics.args}</pre>}
   {view.diagnostics.result!==undefined&&<pre>{view.diagnostics.result}</pre>}</>}
 </details>
}
export function applyDomainCommandCards(ctx:Context){
 ctx.slots.inject("conversation.chat.commandview",()=>{
  const disposers=Object.keys(names).map(key=>ctx.slots.register({name:"conversation.chat.commandview",key,locale:"lyapunov"},DomainCommandCard))
  return()=>{for(const dispose of disposers)dispose()}
 })
}
