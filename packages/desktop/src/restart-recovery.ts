import {existsSync,readFileSync} from "node:fs"
import {join} from "node:path"

/**
 * DEV-036 重启恢复规则（桌面侧）：正常关闭／Host 异常退出／软件重启后，桌面要按**明确规则**决定打开什么、
 * 哪些事实降级，并且**绝不重发机器人动作**。
 *
 * 权威分工（DEVELOPMENT_PRINCIPLES §2）：会话与场景的权威记录由 DSH 原生会话记录与 Scene owner 持有
 * （`<runtimeRoot>/<mode>/dsh/storages/workspace.json` + 各会话的 `worlds/sessions/<sessionId>/scenes/`），
 * 桌面只读这些记录来决定“打开哪个工作区／会话、用什么理由降级”，不复制一份状态、不代替 Scene 写数据。
 */
export interface WorkspaceRecord { id:string; path:string; title:string; sessionIds:string[]; updatedAt?:string }
export interface RecoveryInput { workspaces:WorkspaceRecord[]; archivedSessionIds?:string[]; currentSessionId?:string; liveWorldIds?:string[] }
export interface RecoveryPlan {
  /** open-session：恢复该工作区的某个会话；open-workspace：打开工作区但不锁定会话；none：进入工作区选择（不猜）。 */
  action:"open-session"|"open-workspace"|"none"
  workspaceId?:string; sessionId?:string
  /** 决策依据（可解释、可复现）。 */
  reason:string
  /** 按规则的降级/丢弃事实：失效 world、归档会话等，逐条给原因，不静默丢弃。 */
  downgrades:string[]
  /** 不变量：恢复只读记录与界面选择，绝不自动重发机器人动作。 */
  replaysRobotActions:false
}
export interface StartupFailure { kind:"render"|"resource-missing"|"physics"|"unknown"; reason:string }

/** 读原生会话记录；文件缺失/损坏时返回空记录（让调用方按“没有可恢复目标”处理，不猜）。 */
export function readWorkspaceRecords(runtimeRoot:string,mode:string):{workspaces:WorkspaceRecord[];archivedSessionIds:string[]}{
  const file=join(runtimeRoot,mode,"dsh","storages","workspace.json")
  if(!existsSync(file))return {workspaces:[],archivedSessionIds:[]}
  try{
    const parsed=JSON.parse(readFileSync(file,"utf8")) as {tables?:{workspaces?:Record<string,{path?:string;title?:string;sessionIds?:string[];updatedAt?:string}>};global?:{archivedSessionIds?:string[]}}
    const table=parsed.tables?.workspaces??{}
    const workspaces=Object.entries(table).map(([id,row])=>({id,path:String(row.path??""),title:String(row.title??id),sessionIds:(row.sessionIds??[]).filter(value=>typeof value==="string"),updatedAt:row.updatedAt}))
    return {workspaces,archivedSessionIds:(parsed.global?.archivedSessionIds??[]).filter(value=>typeof value==="string")}
  }catch{return {workspaces:[],archivedSessionIds:[]}}
}

/**
 * 恢复顺序（确定、可解释；每一步失败都降级并记录原因，不静默丢弃）：
 *  1. 记录在案的 currentSessionId 仍在某个工作区且未归档 → 直接恢复那个会话；
 *  2. 否则：全局恰好只剩一个未归档会话 → 恢复它（DEV-036 的“唯一会话”规则）；
 *  3. 否则：恰好只有一个工作区 → 打开它，并选原生记录次序最后的未归档会话（没有就只打开工作区）；
 *  4. 其余情形 → `none`：进入工作区选择，不拿“最近一个”猜。
 * 归档会话永不恢复（逐条记入 downgrades）；`liveWorldIds` 只是诊断输入：已失效的 world 记一条降级，
 * 但恢复规则**不因此重发任何动作**（回执/世界由用户显式重建）。
 */
export function planRestartRecovery(input:RecoveryInput):RecoveryPlan{
  const archived=new Set(input.archivedSessionIds??[])
  const downgrades:string[]=[]
  const workspaces=input.workspaces.filter(workspace=>workspace.path!=="")
  for(const workspace of input.workspaces)if(workspace.path==="")downgrades.push(`工作区 ${workspace.id}（${workspace.title}）没有可读路径，已排除`)
  if(input.liveWorldIds!==undefined)downgrades.push(`重启后不自动恢复运行世界（${input.liveWorldIds.length} 个曾打开）：世界必须由用户显式 sim_open 重建，且不重发旧机器人动作`)
  downgrades.push("重启后不自动恢复文件预览标签（含 HTML 预览）：标签是会话内临时视图，没有独立持久记录；工作区文件仍在磁盘上，由用户重新打开，不猜也不伪造恢复")
  const active=(workspace:WorkspaceRecord)=>workspace.sessionIds.filter(id=>!archived.has(id))
  const archivedSeen=input.workspaces.flatMap(workspace=>workspace.sessionIds.filter(id=>archived.has(id)))
  for(const id of archivedSeen)downgrades.push(`归档会话 ${id} 不恢复（保留在原生记录里，可由用户手动打开）`)

  if(input.currentSessionId){
    const owner=workspaces.find(workspace=>active(workspace).includes(input.currentSessionId!))
    if(owner)return {action:"open-session",workspaceId:owner.id,sessionId:input.currentSessionId,reason:"记录在案的当前会话仍属于未归档集合",downgrades,replaysRobotActions:false}
    downgrades.push(`记录在案的当前会话 ${input.currentSessionId} 已不在任何工作区的未归档集合里，按后面的规则降级`)
  }
  const allActive=workspaces.flatMap(workspace=>active(workspace).map(sessionId=>({workspace,sessionId})))
  if(allActive.length===1)return {action:"open-session",workspaceId:allActive[0]!.workspace.id,sessionId:allActive[0]!.sessionId,reason:"全局只剩唯一一个未归档会话",downgrades,replaysRobotActions:false}
  if(workspaces.length===1){
    const workspace=workspaces[0]!
    const sessions=active(workspace)
    if(sessions.length===0)return {action:"open-workspace",workspaceId:workspace.id,reason:"只有一个工作区且没有未归档会话：打开工作区、让用户新建会话",downgrades,replaysRobotActions:false}
    const last=sessions[sessions.length-1]!
    return {action:"open-session",workspaceId:workspace.id,sessionId:last,reason:"只有一个工作区：取原生记录次序最后的未归档会话（记录次序不代表最近使用时间）",downgrades,replaysRobotActions:false}
  }
  return {action:"none",reason:workspaces.length===0?"没有任何可读工作区记录":"存在多个工作区且没有唯一目标：进入工作区选择，不猜测",downgrades,replaysRobotActions:false}
}

/**
 * 启动/连接失败的归因（DEV-036：区分渲染失败、资源缺失与物理失败）。只看失败原文里的稳定事实，
 * 命中不了就如实返回 unknown，不把“没认出来”说成某一类。
 */
export function classifyStartupFailure(message:string):StartupFailure{
  const text=String(message??"")
  if(/EGL|GL[A-Z]?|frame ?buffer|WebGL|ANGLE|SwiftShader|gpu process|Failed to create|context lost|renderer/i.test(text))
    return {kind:"render",reason:"图形后端/上下文相关失败（EGL、framebuffer、WebGL、ANGLE、GPU 进程）"}
  if(/ENOENT|not found|no such file|missing|EACCES|permission denied|ENOSPC|EMFILE|ENFILE|too many open files|inotify|file.?watch(er)?s?|打开的文件过多/i.test(text))
    return {kind:"resource-missing",reason:"资源缺失或系统资源耗尽（文件/权限/句柄/文件监控）；句柄与文件监控耗尽属资源归因，不改系统限额掩盖"}
  if(/PhysX|physics|solver|articulation|NaN|diverge|contact/i.test(text))
    return {kind:"physics",reason:"物理/求解器相关失败"}
  return {kind:"unknown",reason:"未识别的失败类型：按原文如实上报，不归类到某一层"}
}

/**
 * 登录先行的启动协调：正式桌面只有在持有**已通过 /v1/me 验证的账户**时才允许解析出 Host 模式。
 * 缺账户时直接抛错，绝不回落到 `local`（匿名本地工作台）——这正是 A01「未登录直接进本地工作台」的缺陷。
 * 开发源码模式的显式入口不受影响，仍按原行为启动 `developer`。
 */
export function resolveWorkspaceHostMode(mode:"formal"|"developer",account:unknown):"formal"|"developer"{
  if(mode==="formal"&&!account)throw new Error("AUTH_REQUIRED: 登录验证通过前不启动正式工作台")
  return mode
}
