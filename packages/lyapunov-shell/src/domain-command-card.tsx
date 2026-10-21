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
 asset_placement_preview:["预览放置资产","Preview placement"],
 sensor_capture_ui:["采集 RGB-D","Capture RGB-D"],fastgs_external:["FastGS 外部工具","FastGS external tool"],
 robot_fleet_run:["多机器人分工","Fleet workflow"],robot_fleet_route:["规划交通路线","Plan traffic route"],
 robot_cargo_transfer:["搬运货物","Transfer cargo"],
 recording_start:["开始录制","Start recording"],recording_stop:["停止录制","Stop recording"],recording_list:["录制列表","Recordings"],recording_inspect:["查看录制来源","Inspect recording"],recording_export:["导出数据集","Export dataset"],
 scene_create:["新建场景","Create scene"],scene_inspect:["读取场景","Inspect scene"],scene_list:["场景列表","List scenes"],scene_history:["场景版本","Scene history"],scene_restore:["恢复场景版本","Restore scene version"],scene_edit:["编辑场景","Edit scene"],scene_import:["导入资产","Import asset"],scene_import_url:["从 HTTPS 导入 GLB","Import GLB from HTTPS"],scene_asset_acquire:["导入模型及依赖","Import model and dependencies"],scene_mount:["放入资产","Place asset"],scene_open:["打开工程","Open project"],scene_save:["保存工程","Save project"],scene_align:["对齐对象","Align object"],
 asset_list:["资源列表","List resources"],asset_edit:["编辑资源","Edit resource"],asset_verify:["检查资源","Check resource"],asset_bake:["生成碰撞表示","Bake collision"],
 sim_open:["启动模拟","Start simulation"],sim_sync:["同步场景","Sync scene"],sim_close:["关闭模拟","Close simulation"],sim_stop:["停止模拟","Stop simulation"],sim_execute_batch:["同步运动","Synchronized motion"],sim_action_receipt:["动作结果","Action receipt"],sim_assist:["模拟辅助操作","Assisted simulation"],
 robot_load:["加载机器人","Load robot"],robot_describe:["读取机器人","Describe robot"],robot_description:["读取机器人描述","Read robot description"],robot_state:["读取状态","Observe state"],robot_move:["关节运动","Joint motion"],robot_walk:["行走","Walk"],robot_gripper:["夹爪控制","Gripper control"],robot_stop:["停止机器人","Stop robot"],robot_pick:["抓取","Pick"],robot_place:["放置","Place"],joint_move:["关节 / 升降","Joint / lift"],vehicle_drive:["车辆控制","Drive vehicle"],viewer_capture:["采集图像","Capture image"],sensor_capture:["传感器采集","Sensor capture"],segment_sam3:["SAM3 图像分割","SAM3 segmentation"],segment_fastgs:["FastGS 分割（历史点击协议，已停用）","FastGS segmentation (retired click protocol)"],
 policy_search:["检索策略来源","Search policies"],policy_metadata:["策略元数据","Policy metadata"],policy_files:["策略文件","Policy files"],policy_verify:["校验策略","Verify policy"],policy_prepare:["装配策略","Prepare policy"],policy_match:["匹配策略","Match policy"],policy_download:["下载策略","Download policy"],policy_execute:["执行策略","Execute policy"],policy_stop:["停止策略","Stop policy"],policy_activate:["启用策略","Activate policy"],policy_download_sources:["策略来源","Policy sources"],
 scene_import_resolve:["解析导入入口","Resolve import entry"],scene_reconcile_physics:["对账物理世界","Reconcile physics"],scene_prepare_world:["准备物理世界","Prepare physics world"],
 ui_action_ack:["界面动作确认","UI action ack"],ui_engine_switch:["切换引擎偏好","Switch engine preference"],ui_computer_use_consent:["计算机使用授权","Computer-use consent"],ui_computer_use_end:["结束计算机使用","End computer use"],
 // P21：界面动作/相机 UI 命令此前没有产品短名，聊天里掉回 SDK 原始命令行（`sim_set_paused · {"status":"paused"}`）。
 sim_set_paused:["暂停 / 继续模拟","Pause / resume simulation"],
 robot_freeze:["冻结机器人","Freeze robot"],robot_restore:["解除冻结","Restore robot"],
 robot_set_base:["固定 / 恢复机器人底座","Set / restore robot base"],robot_set_tcp:["保存机器人末端 TCP","Set robot TCP"],
 robot_assembly_preview:["预览装配","Preview assembly"],robot_assembly_check:["检查装配读回","Check assembly readback"],
 robot_assembly_history:["读取装配历史","Read assembly history"],robot_assembly_undo:["撤销装配变化","Undo assembly change"],
 robot_assembly_mount:["保存安装点","Save assembly mount"],robot_assembly_replace:["替换末端","Replace end-effector"],
 robot_assembly_extract_precheck:["预检内部拆分","Precheck internal split"],robot_assembly_extract:["提取内部部件","Extract internal part"],robot_assembly_reassemble:["重组内部部件","Reassemble internal part"],
 policy_load_local:["加载本地策略","Load local policy"],policy_load_state:["策略加载状态","Policy load state"],
 camera_scene_save:["保存场景相机","Save scene camera"],
 camera_list_ui:["读取命名相机","List named cameras"],camera_adjust_ui:["调整相机位姿 / 视场","Adjust camera pose / FOV"],
 camera_capture_multi_ui:["同帧多视角采集","Multi-view capture"],camera_annotation_ui:["像素标注","Annotate pixel"],
 camera_dataset_export_ui:["导出多视角数据集","Export multi-view dataset"],camera_lidar_scan_ui:["LiDAR 扫描","LiDAR scan"],
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
function domainCommandSummaryRaw(name:string,text:string|undefined,kind:"success"|"error"|null,english=false){
 const tr=(cn:string,en:string)=>english?en:cn
 if(kind===null)return {summary:tr("执行中…","Running…"),tone:"running"}
 if(kind==="error")return {summary:shortened(stripPublicError(text)??tr("执行失败","Failed"),280),tone:"error"}
 const value=unpack(text)
 /**
  * P21：UI 常用动作的显示投影。此前这些名字没有卡片映射，聊天里只显示 SDK 原始命令行
  * （`sim_set_paused · {"status":"paused"...}`）。这里补齐短语义标题/状态：
  *  · 只影响**显示**文案，不改审计事件、不改传给模型的结果、不绕 ControlGestureDisplay/隐私双闸；
  *  · 失败（not-found/mismatched/not-frozen/未就绪）与“未到目标”仍按原判据上屏，不一律绿化；
  *  · 名字判据压在通用 items/snapshot 等宽判据之前，避免被抢先。
  */
 const count=(row:unknown)=>typeof row==="number"?row:Array.isArray(row)?row.length:0
 if(name==="sim_set_paused"){
  const paused=value?.status==="paused"
  return {summary:`${paused?tr("已暂停","Paused"):tr("已继续","Resumed")}${value?.worldGeneration===undefined?"":` · g${value.worldGeneration}`}${value?.appliedSceneRevision===undefined?"":` · rev ${value.appliedSceneRevision}`}`,tone:"ok"}
 }
 if(name==="robot_freeze"||name==="robot_restore"){
  const status=typeof value?.status==="string"?value.status:""
  const rows=count(value?.frozenEntityIds??value?.restoredEntityIds??value?.alreadyFrozenEntityIds??value?.notFrozenEntityIds??value?.entityIds)
  const positive=name==="robot_freeze"?(status==="frozen"||status==="already-frozen"):status==="restored"
  // not-found / mismatched / not-frozen 都是“没到目标”，按 warning 明确上屏（不藏、不绿化）。
  return {summary:`${status||tr("无回执","no receipt")}${rows?` · ${rows} ${tr("个对象","entities")}`:""}${value?.reason?" · "+shortened(value.reason,100):""}`,tone:positive?"ok":"warning"}
 }
 if(name==="policy_load_local"||name==="policy_load_state"){
  const category=typeof value?.category==="string"?value.category:""
  const categoryText=({direct_execution:tr("可直接执行","Direct execution"),weights_need_adapter:tr("权重待适配","Weights need adapter"),missing_files_or_runtime:tr("缺文件或运行时","Missing files or runtime"),model_incompatible:tr("模型不兼容","Model incompatible")} as Record<string,string>)[category]
  const missing=count(value?.missing)
  const ready=value?.ready===true
  return {summary:`${ready?tr("就绪","Ready"):tr("未就绪","Not ready")} · ${categoryText||category||tr("未读取","Unread")}${missing?` · ${missing} ${tr("项缺失","missing")}`:""}${value?.applyEligible===true?tr(" · 可应用"," · appliable"):""}${value?.modelId?` · ${shortened(value.modelId,32)}`:""}`,tone:ready?"ok":"warning"}
 }
 if(name==="camera_scene_save"){
  const snapshot=value?.snapshot
  return {summary:`${value?.entityId?shortened(String(value.entityId),32)+" · ":""}${snapshot?`rev ${snapshot.revision}`:""}${value?.worldNeedsSync?tr(" · 世界待同步"," · world needs sync"):""}`,tone:value?.worldNeedsSync?"warning":"ok"}
 }
 if(name==="camera_list_ui"){
  const cameras=count(value?.cameras)
  return {summary:`${cameras} ${tr("台命名相机","named cameras")} · rev ${value?.sceneRevision??"—"} · g${value?.generation??value?.worldGeneration??"—"}`,tone:cameras?"ok":"warning"}
 }
 if(name==="camera_adjust_ui"){
  const override=value?.override===false?tr("已清除临时调整","Override cleared"):tr("已应用临时调整","Override applied")
  return {summary:`${override}${value?.referenceFrame?` · ${value.referenceFrame}`:""}${value?.parentBodyName?` · ${value.parentBodyName}`:""}${value?.fovyDeg!==undefined?` · fovy ${Number(value.fovyDeg).toFixed(1)}°`:""}`,tone:"ok"}
 }
 if(name==="camera_capture_multi_ui"){
  const cameras=count(value?.cameras??value?.captures)
  const first=Array.isArray(value?.cameras)?value.cameras[0]:Array.isArray(value?.captures)?value.captures[0]:undefined
  const width=value?.width??first?.width??first?.calibration?.intrinsics?.width,height=value?.height??first?.height??first?.calibration?.intrinsics?.height
  return {summary:`${cameras} ${tr("台相机","cameras")}${width!==undefined&&height!==undefined?` · ${width}×${height}`:""}${value?.stepIndex===undefined?"":` · step ${value.stepIndex}`}`,tone:cameras?"ok":"warning"}
 }
 if(name==="camera_annotation_ui"){
  const point=Array.isArray(value?.worldPointM)?value.worldPointM.map((item:number)=>Number(item).toFixed(3)).join(", "):""
  return {summary:`${tr("像素","pixel")} [${Array.isArray(value?.pixel)?value.pixel.join(", "):"—"}]${point?` → [${point}] m`:""}${value?.depthM!==undefined?` · ${tr("深度","depth")} ${Number(value.depthM).toFixed(3)} m`:""}`,tone:"ok"}
 }
 if(name==="camera_dataset_export_ui"){
  const ids=count(value?.shellCaptureIds??value?.providerCaptureIds)
  return {summary:`${ids} ${tr("个多视角采集","multi-view captures")}${value?.outputDir?` · ${shortened(displayPath(String(value.outputDir)),50)}`:""}`,tone:"ok"}
 }
 if(name==="camera_lidar_scan_ui"){
  const range=value?.rangeMinM!==undefined&&value?.rangeMaxM!==undefined?` · ${Number(value.rangeMinM).toFixed(2)}–${Number(value.rangeMaxM).toFixed(2)} m`:""
  return {summary:`${value?.cameraName??tr("命名相机","named camera")}${value?.rayCount!==undefined?` · ${value?.validCount??0}/${value.rayCount} ${tr("有效射线","valid rays")}`:""}${range}`,tone:"ok"}
 }
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
 /**
  * P17：这些产品命令此前没有显示映射，掉回 SDK 原始长命令行。这里只补**显示投影**的短语义摘要，
  * 不改审计事件、不改传给模型的结果、不绕插件命令安全/ControlGestureDisplay 校验。
  * 具体命令判据压在通用分支之前，避免被 items/snapshot 等宽判据抢先。
  */
 const engineName=(id:unknown)=>id==="isaac"?"Isaac":id==="mujoco"?"MuJoCo":id==="auto"?tr("自动","Auto"):id===null||id===undefined?tr("未设置","unset"):String(id)
 if(value?.runningEngine!==undefined&&value?.preference!==undefined){
  const running=engineName(value.runningEngine),saved=engineName(value.preference)
  return {summary:`${running}${saved!==running?` → ${saved}`:""}${value.restartRequired?tr(" · 下次启动"," · next start"):tr(" · 当前"," · current")}`,tone:"ok"}
 }
 // ui_action_ack：宿主只回被消费的界面动作条数，不铺原始 id 列表。
 if(typeof value?.acked==="number")return {summary:tr(`已确认 ${value.acked} 项界面动作`,`${value.acked} UI action${value.acked===1?"":"s"} acknowledged`),tone:"ok"}
 // policy_download_sources：发现面报已登记来源与本地项数量（不是能力包）。
 if(Array.isArray(value?.models)&&Array.isArray(value?.localEntries))return {summary:`${value.models.length} ${tr("个已登记来源","sources")} · ${value.localEntries.length} ${tr("项本地","local")}`,tone:"ok"}
 // scene_import_resolve：入口解析；blocked 是明确需用户改选的下一步（不得静默）。
 if(value?.kind==="blocked"&&value?.models===undefined&&value?.actionId===undefined)return {summary:shortened(stripPublicError(value.reason)??tr("入口不明确，请选择具体文件","Ambiguous entry; choose a specific file"),200),tone:"warning"}
 if(typeof value?.kind==="string"&&(value.kind==="file"||value.kind==="robot-directory"||value.kind==="policy-directory"))return {summary:value.kind==="file"?tr("文件入口","File entry"):tr(`目录入口 ${shortened(value.entryName,44)}`,`Directory entry ${shortened(value.entryName,44)}`),tone:"ok"}
 // scene_reconcile_physics：对账回执（snapshot + pending + issues）；问题/等待按 warning 明确上屏。
 if(value?.snapshot&&Array.isArray(value?.issues))return {summary:`${tr("物理对账","Physics reconcile")} · ${value.pending?tr("等待中","pending"):tr("已应用","applied")} · ${value.issues.length} ${tr("项问题","issues")}`,tone:value.issues.length||value.pending?"warning":"ok"}
 if(Array.isArray(value?.models))return {summary:`${value.models.length} ${tr("个能力包","packs")} · ${publicStatusOf(value.status)||"—"}`,tone:value.status==="ready"?"ok":"warning"}
 if(value?.status==="ready"&&value?.modelEntry!==undefined)return {summary:`${tr("装配完成","Prepared")}${value.modelEntry?` · ${shortened(displayPath(String(value.modelEntry)),60)}`:tr(" · 无模型入口"," · no model entry")}`,tone:"ok"}
 if(typeof value?.files==="number"&&typeof value?.bytes==="number")return {summary:`${tr("已取件","Fetched")} · ${value.files} ${tr("个文件","files")}`,tone:"ok"}
 // V10-06：领域装配/底座命令此前没有卡片映射，掉回原生 JSON 行。只补短语义；
 // UUID/全量 rev/step/notes 仍只在展开详情里。被动读取失败不会被下面任何成功分支吞掉。
 if(name==="robot_assembly_preview"){
  const source=value?.source?.name??value?.source?.entityId??tr("源","source")
  const target=value?.target?.name??value?.target?.entityId??tr("目标","target")
  return {summary:`${source} → ${target}${value?.target?.bodyName?`/${value.target.bodyName}`:""} · ${tr("预览，未提交","preview, not applied")} · rev ${value?.revision??"—"}${value?.generation===undefined?"":` · g${value.generation}`}`,tone:"ok"}
 }
 if(name==="robot_assembly_check"){
  const checked=value?.checked??{}
  const read=["binding","relativePose","joints","contacts","actionReceipt"].filter(key=>checked[key]===true).length
  const attachments=count(value?.attachments)
  return {summary:`${tr("读回","readback")} ${read}/5 · ${attachments} ${tr("个挂接","attachments")}${value?.reason?" · "+shortened(value.reason,100):""}`,tone:read>0?"ok":"warning"}
 }
 if(name==="robot_assembly_history"){
  const changes=count(value?.entries)
  const groups=count(value?.replacements)+count(value?.subtreePartitions)
  return {summary:`${changes} ${tr("条绑定变化","binding changes")}${groups?` · ${groups} ${tr("组成对操作","grouped operations")}`:""} · rev ${value?.revision??"—"}${value?.historyComplete===false?tr(" · 历史缺页"," · history gap"):""}${value?.reason?" · "+shortened(value.reason,100):""}`,tone:value?.historyComplete===false||value?.reason?"warning":"ok"}
 }
 if(name==="robot_assembly_undo"){
  const saved=value?.saved===true||value?.status==="UPDATED"||value?.status==="UNCHANGED"
  return {summary:`${saved?tr("已恢复声明","declaration restored"):tr("未完成","not completed")}${value?.revision===undefined?"":` · rev ${value.revision}`}${value?.syncRequired?tr(" · 物理待同步"," · physics sync required"):value?.sync==="SYNCED"?tr(" · 已同步"," · synced"):""}${value?.reason?" · "+shortened(value.reason,100):""}`,tone:saved?(value?.syncRequired?"warning":"ok"):"warning"}
 }
 if(name==="robot_set_base"||name==="robot_set_tcp"){
  const field=name==="robot_set_base"?tr("底座","base"):"TCP"
  const saved=value?.saved===true
  return {summary:`${field}${saved?tr("已保存"," saved"):tr("未保存"," not saved")}${value?.revision===undefined?"":` · rev ${value.revision}`}${value?.syncRequired?tr(" · 物理待同步"," · physics sync required"):value?.sync==="SYNCED"?tr(" · 已同步"," · synced"):""}${value?.status==="UNCHANGED"?tr(" · 无变化"," · unchanged"):""}`,tone:saved?(value?.syncRequired?"warning":"ok"):"warning"}
 }
 if(name==="robot_assembly_mount"){
  const saved=value?.saved===true
  return {summary:`${saved?tr("安装点已保存","mount saved"):tr("安装点未保存","mount not saved")}${value?.changed?tr(" · 有变化"," · changed"):""}${value?.stale?tr(" · 资源已变化"," · resource changed"):""}${value?.reason?" · "+shortened(value.reason,100):""}`,tone:saved&&!value?.stale?"ok":"warning"}
 }
 if(name==="robot_assembly_replace"){
  const changes=count(value?.changes)
  return {summary:`${tr("已替换","replaced")} · ${changes} ${tr("方字段","sides")}${value?.revision===undefined?"":` · rev ${value.revision}`}${value?.syncRequired?tr(" · 物理待同步"," · physics sync required"):tr(" · 已同步"," · synced")}${value?.reason?" · "+shortened(value.reason,100):""}`,tone:value?.syncRequired?"warning":"ok"}
 }
 if(name==="robot_assembly_extract"||name==="robot_assembly_reassemble"){
  const saved=value?.saved===true||value?.snapshot!==undefined
  return {summary:`${saved?tr("内部部件已更新","internal part updated"):tr("内部部件未更新","internal part unchanged")}${value?.revision===undefined?"":` · rev ${value.revision}`}${value?.syncRequired?tr(" · 物理待同步"," · physics sync required"):""}${value?.reason?" · "+shortened(value.reason,100):""}`,tone:saved?(value?.syncRequired?"warning":"ok"):"warning"}
 }
 if(name==="robot_assembly_extract_precheck"){
  return {summary:`${value?.supported===true?tr("可拆分","extractable"):tr("不可拆分","not extractable")}${value?.reason?" · "+shortened(value.reason,120):""}`,tone:value?.supported===true?"ok":"warning"}
 }
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
/** 被动成功读取（策略来源/描述等）仍保留原生事件、模型结果与审计；只在自有 Chat 视图里不逐行铺卡，失败照常显示。 */
/**
 * 默认 headline 只留动作对象短名/结果/必要失败原因：rev/generation/step/UUID 等机器身份
 * 仍完整保留在机器结果、事件、审计与展开详情里，不在这里删除。
 */
const TECHNICAL_HEADLINE=/(?:\s*·\s*(?:rev\s+\d+|g-?\d+|generation\s+[A-Za-z0-9_.:-]+|step\s+\d+(?:\s*→\s*[^·]+)?|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))+/gi
const UUID_HEADLINE=/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
function publicHeadline(summary:string,english:boolean):string{
 const cleaned=summary.replace(TECHNICAL_HEADLINE,'').replace(UUID_HEADLINE,'').replace(/\s*·\s*·\s*/g,' · ').replace(/^\s*·\s*|\s*·\s*$/g,'').trim()
 return cleaned||(english?'Completed':'已完成')
}
/** 默认 headline 与完整详情分离；失败保留服务端公开原因，不做技术串清理。 */
export function domainCommandSummary(name:string,text:string|undefined,kind:"success"|"error"|null,english=false){
 const result=domainCommandSummaryRaw(name,text,kind,english)
 return result.tone==='error'?result:{...result,summary:publicHeadline(result.summary,english)}
}
const PASSIVE_SUCCESS_READS:ReadonlySet<string>=new Set(["asset_placement_preview","policy_download_sources","policy_metadata","policy_files","policy_search","robot_description","robot_describe","robot_assembly_history"])
/** 被动成功读取不铺卡；同一条命令失败仍必须显示。 */
export const isPassiveSuccessRead=(name:string,outcome:"success"|"error"|null|undefined):boolean=>PASSIVE_SUCCESS_READS.has(name)&&outcome!=="error"
export function DomainCommandCard({node,t}:CommandRowOwnerProps&PropsLocale<"lyapunov">){
 const english=t("open")==="Scene workbench",name=node.name??""
 if(isPassiveSuccessRead(name,node.outcome?.kind))return null
 const view=commandCardView({name,args:node.args,outcomeText:node.outcome?.text,kind:node.outcome?.kind??null},{english,allowRaw:BUILD_ALLOWS_RAW_COMMAND_IO,mode:hostMode})
 return <details className="lya-domain-command" data-domain-command={name} data-gesture-id={node.display?.gestureId} data-state={view.tone}><style>{`
 .lya-domain-command{border:0;border-bottom:1px solid var(--dsw-alias-border-l3,#344255);border-radius:0;margin:2px 0;background:transparent;font-size:12px;min-width:0}.lya-domain-command>summary{cursor:pointer;display:flex;align-items:baseline;gap:6px;padding:4px 2px;list-style:none}.lya-domain-command>summary::before{content:'▸';opacity:.6;flex:none}.lya-domain-command[open]>summary::before{content:'▾'}.lya-domain-command>summary strong{font-weight:550;flex:none}.lya-domain-command-summary{opacity:.78;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;min-width:0}.lya-domain-command[data-state=error] .lya-domain-command-summary{color:#e47680;opacity:1}.lya-domain-command[data-state=warning] .lya-domain-command-summary{color:#d3a562;opacity:1}.lya-domain-command[data-state=error] .lya-domain-command-summary,.lya-domain-command[data-state=warning] .lya-domain-command-summary{white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere}.lya-domain-command pre{margin:0;padding:8px;font:11px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto;border-top:1px solid var(--dsw-alias-border-l3,#344255)}.lya-domain-command small{display:block;padding:5px 2px 0;opacity:.65}.lya-domain-command-details{padding:3px 2px 6px;line-height:1.45;opacity:.88;white-space:normal;overflow-wrap:anywhere}
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
