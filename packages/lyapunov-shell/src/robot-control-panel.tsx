import {useEffect,useRef,useState} from "react"
import type {Entity,EntityObservation,ActionReceipt} from "../../lyapunov-contracts/src/types.ts"
import type {RobotDescription,EntityMotion} from "../../sim-contract/src/index.ts"
import {NumberField,NumericInput,type Translate} from "./entity-editor.tsx"
import {domainCommandSummary} from "./domain-command-card.tsx"
import {LatestControlQueue} from "./latest-control-queue.ts"
import {JointTargetInput,fullJointTargetErrors,jointTargetError} from "./joint-target-input.tsx"
import type {ControlGestureDisplay} from "./control-gesture.ts"
// 动作结果卡的详情与诊断面共用同一份判据（原始回执只在两闸都开的开发诊断面出现）。
import {hasRawCommandIOAccess,publicCommandFace,redactSecretsText} from "../../lyapunov-contracts/src/command-privacy.ts"
export interface RecentAction {id:string;label:string;waiting:boolean;receipt?:ActionReceipt;error?:string;display?:ControlGestureDisplay;history?:Array<{commandId:string;phase:string;waiting:boolean;receipt?:ActionReceipt;error?:string}>}
export interface NativeJointResult { receipt:ActionReceipt; observedStep:number; actualPosition:number|null; observedLatencyMs:number;display?:ControlGestureDisplay }
export function RobotControlPanel({entity,description,observation,targets,setTargets,ready,duration,setDuration,describe,move,fullMotion,tr,controlKey,controlScope,liveMove,cancelLive,registerLiveCancel,controlBlocked=false}:{entity:Entity;description?:RobotDescription;observation?:EntityObservation;targets:Record<string,number>;setTargets:(values:Record<string,number>,draft?:boolean)=>void;ready:boolean;duration:number;setDuration:(value:number)=>void;describe:()=>void;move:(name:string,motion:EntityMotion,label:string)=>void;fullMotion:()=>EntityMotion;tr:Translate;controlKey?:string;controlScope?:{worldId:string;generation:number};controlBlocked?:boolean;liveMove?:(motion:EntityMotion,display?:ControlGestureDisplay,signal?:AbortSignal)=>Promise<NativeJointResult>;cancelLive?:(display?:ControlGestureDisplay)=>void;registerLiveCancel?:(cancel:(()=>ControlGestureDisplay|undefined)|undefined)=>void}){
  const [speed,setSpeed]=useState(.2),[steering,setSteering]=useState(0),[yawRate,setYawRate]=useState(0),[lift,setLift]=useState(0),[gripper,setGripper]=useState(.04)
  const [live,setLive]=useState(true),[activeJoint,setActiveJoint]=useState(""),[nativeInfo,setNativeInfo]=useState<{result:NativeJointResult;latencyMs:number}>(),[nativeError,setNativeError]=useState("")
  const liveRef=useRef(liveMove);liveRef.current=liveMove
  const gesture=useRef<{id:string;sequence:number;jointName:string}>(),latest=useRef<ControlGestureDisplay>(),target=useRef<number>()
  const queue=useRef<LatestControlQueue<{motion:EntityMotion;display:ControlGestureDisplay},NativeJointResult>>()
  queue.current??=new LatestControlQueue(async (value,signal)=>{if(!liveRef.current)throw new Error("NATIVE_CONTROL_UNAVAILABLE");return liveRef.current(value.motion,value.display,signal)},(result,latencyMs)=>{setNativeInfo({result,latencyMs});setNativeError("");if(["failed","cancelled"].includes(result.receipt.status)){queue.current?.clear();gesture.current=undefined;latest.current=undefined}if(result.display?.phase==='final'&&latest.current?.gestureId===result.display.gestureId&&latest.current.sequence===result.display.sequence)latest.current=undefined},error=>{gesture.current=undefined;latest.current=undefined;setNativeError(String(error))})
  const clearGesture=()=>{queue.current?.clear();const previous=latest.current;gesture.current=undefined;latest.current=undefined;return previous?{...previous,phase:'stop' as const,sequence:previous.sequence+1}:undefined}
  const cancelGesture=()=>{const stopped=clearGesture();if(stopped)cancelLive?.(stopped)}
  useEffect(()=>{registerLiveCancel?.(clearGesture);return()=>{cancelGesture();registerLiveCancel?.(undefined)}},[controlKey,entity.entityId])
  useEffect(()=>{if(!ready)cancelGesture()},[ready])
  useEffect(()=>{if(controlBlocked){queue.current?.clearPending();gesture.current=undefined}},[controlBlocked])
  const controller=description?.controller as any
  const vehicle=controller?.type==="vehicle"
  const directJoints=description?.joints.filter(joint=>description.controlledJointNames.includes(joint.name)&&Boolean(joint.controlMode)&&joint.range&&joint.range.every(Number.isFinite))??[]
  const selectedJoint=directJoints.find(joint=>joint.name===activeJoint)??directJoints[0]
  const observedIndex=selectedJoint?observation?.joints?.names.indexOf(selectedJoint.name)??-1:-1
  const observedValue=observedIndex>=0?observation?.joints?.positions[observedIndex]:undefined
  const nativeReady=ready&&Boolean(liveMove)&&Boolean(controlScope)&&typeof observedValue==="number"&&Number.isFinite(observedValue)
  const beginGesture=()=>{if(controlBlocked||!selectedJoint||!controlScope||!nativeReady)return;if(!gesture.current){if(latest.current)cancelGesture();gesture.current={id:crypto.randomUUID(),sequence:0,jointName:selectedJoint.name};target.current=targets[selectedJoint.name]??observedValue}}
  const nextDisplay=(phase:'update'|'final'):ControlGestureDisplay|undefined=>{beginGesture();const active=gesture.current;if(!active||!controlScope)return;const display:ControlGestureDisplay={kind:'control-gesture',gestureId:active.id,worldId:controlScope.worldId,generation:controlScope.generation,entityId:entity.entityId,jointName:active.jointName,phase,sequence:++active.sequence};latest.current=display;return display}
  const changeJoint=(value:number)=>{if(controlBlocked||!selectedJoint)return;setTargets({...targets,[selectedJoint.name]:value},!live);target.current=value;const error=jointTargetError(selectedJoint,value);if(error){setNativeError(error);return}if(live&&nativeReady){const display=nextDisplay('update');target.current=value;if(display)void queue.current?.submit({display,motion:{kind:'joint',entityId:entity.entityId,jointNames:[selectedJoint.name],positions:[value],durationS:.08,settleTimeS:.04,tolerance:.015}})}}
  const finishGesture=()=>{if(controlBlocked||!gesture.current||!selectedJoint)return;const value=target.current;const error=jointTargetError(selectedJoint,value);if(error||!Number.isFinite(duration)||duration<=0){setNativeError(error??'CONTROL_DURATION_INVALID');cancelGesture();return}const display=nextDisplay('final');gesture.current=undefined;if(display&&live&&nativeReady)void queue.current?.submit({display,motion:{kind:'joint',entityId:entity.entityId,jointNames:[selectedJoint.name],positions:[value!],durationS:Math.max(.25,duration),settleTimeS:.3,tolerance:.015}})}
  const targetErrors=description?fullJointTargetErrors(description,targets):[]

  return <fieldset className="lya-robot-card" disabled={controlBlocked}><legend>{entity.name} · {tr("直接控制","Direct controls")}</legend><div className="lya-row"><button className="lya-chip" onClick={describe}>{tr("读取完整关节","Read all joints")}</button><NumberField label={tr("时长 s","Duration s")} value={duration} set={setDuration} min={.05} step={.1}/></div>
    {description&&(vehicle?<>
      <NumberField label={tr("速度 m/s","Speed m/s")} value={speed} set={setSpeed} step={.05}/><NumberField label={tr("虚拟转角 rad","Virtual steering rad")} value={steering} set={setSteering} min={controller.steering?.rangeRad?.[0]??-.6} max={controller.steering?.rangeRad?.[1]??.6} step={.05}/>
      {!controller.steering&&<NumberField label={tr("偏航 rad/s","Yaw rad/s")} value={yawRate} set={setYawRate} step={.1}/>}
      <p className="lya-help">{tr("负速度倒车；前进时正转角向左。速度为 0 时只转向。","Negative speed reverses; positive steering turns left when moving forward. Zero speed only steers.")}</p>
      <div className="lya-row"><button className="lya-chip lya-chip-accent" disabled={!ready} onClick={()=>move("vehicle_drive",{kind:"vehicle",entityId:entity.entityId,speedMps:speed,...controller.steering?{steeringAngleRad:steering}:{yawRateRadps:yawRate},durationS:duration},tr("车辆行驶","Vehicle drive"))}>{tr("执行行驶 / 转向","Drive / steer")}</button></div>
      {controller.lift&&<><div style={{marginTop:8}}><NumberField label={tr("绝对货叉高度 m","Absolute lift m")} value={lift} set={setLift} min={controller.lift.rangeM?.[0]} max={controller.lift.rangeM?.[1]} step={.02}/></div><div className="lya-row"><button className="lya-chip" disabled={!ready} onClick={()=>move("joint_move",{kind:"lift",entityId:entity.entityId,positionM:lift,durationS:duration},tr("货叉升降","Fork lift"))}>{tr("移动到指定高度","Move to height")}</button></div></>}
      {observation?.joints&&<details><summary>{tr("实测轮组 / 升降","Observed wheels / lift")}</summary>{observation.joints.names.map((name,i)=><div className="lya-row" key={name}><small>{name}</small><span className="lya-spacer"/><code>{observation.joints!.positions[i]?.toFixed(3)}</code></div>)}</details>}
    </>:<>
      {directJoints.length>0&&<div data-testid="native-joint-adjustment">
       <p className="lya-help">{tr("原生单关节手调：直接调用当前引擎，不等待模型。连续拖动只保留最新目标；停止或切换实例会清除待发目标。","Native single joint controls call the engine directly. Continuous changes retain only the latest target; stop or instance switches clear pending targets.")}</p>
       <select className="lya-wide" aria-label={tr("手调受控关节","Native controlled joint")} value={selectedJoint?.name??""} onChange={event=>{cancelGesture();setActiveJoint(event.target.value)}}>{directJoints.map(joint=><option key={joint.name} value={joint.name}>{joint.name} · {joint.unit}</option>)}</select>
       <label><input type="checkbox" checked={live} disabled={!nativeReady} onChange={event=>{setLive(event.target.checked);if(!event.target.checked){cancelGesture()}}}/>{tr("拖动时直接运动","Move directly while dragging")}</label>
       {selectedJoint&&<input className="lya-wide" type="range" aria-label={tr("原生关节滑块 ","Native joint slider ")+selectedJoint.name} min={selectedJoint.range![0]} max={selectedJoint.range![1]} step={selectedJoint.unit==="m"?.001:.005} value={targets[selectedJoint.name]??observedValue??selectedJoint.range![0]} disabled={!nativeReady} onPointerDown={event=>{beginGesture();if(gesture.current)event.currentTarget.setPointerCapture?.(event.pointerId)}} onPointerUp={finishGesture} onPointerCancel={cancelGesture} onLostPointerCapture={()=>{if(gesture.current)cancelGesture()}} onKeyDown={event=>{if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End","PageUp","PageDown"].includes(event.key))beginGesture()}} onKeyUp={finishGesture} onBlur={()=>{if(gesture.current)cancelGesture()}} onChange={event=>changeJoint(Number(event.target.value))}/>}
       <p className="lya-help">{tr("实测 / 目标：","Observed / target: ")}{typeof observedValue==="number"?observedValue.toFixed(4):"—"} / {selectedJoint&&typeof targets[selectedJoint.name]==="number"?targets[selectedJoint.name]!.toFixed(4):"—"} {selectedJoint?.unit}</p>
       {nativeInfo&&<p className="lya-help" role="status">{tr("引擎回执：","Engine receipt: ")}{nativeInfo.result.receipt.status} · {Math.round(nativeInfo.latencyMs-nativeInfo.result.observedLatencyMs)}ms · {tr("实测帧：","Observed frame: ")}{nativeInfo.result.observedStep} · {nativeInfo.result.actualPosition?.toFixed(4)??"—"} · {Math.round(nativeInfo.result.observedLatencyMs)}ms</p>}
       {nativeError&&<p className="lya-error" role="alert">{nativeError}</p>}
      </div>}
      <details className="lya-advanced" open><summary>{tr("完整关节目标","Complete joint targets")} ({description.controlledJointNames.length})</summary>
      <div className="lya-joint"><small>{tr("关节 / 单位","Joint / unit")}</small><small>{tr("实测","Observed")}</small><small>{tr("完整目标","Full target")}</small></div>
      {description.joints.map(joint=>{const i=observation?.joints?.names.indexOf(joint.name)??-1,controlled=description.controlledJointNames.includes(joint.name);return <div className="lya-joint" key={joint.name}><span title={joint.actuator}>{joint.name}<br/><small>{joint.unit}{joint.range?` [${joint.range[0].toFixed(2)}, ${joint.range[1].toFixed(2)}]`:""}</small></span><code>{i>=0?observation?.joints?.positions[i]?.toFixed(3):"—"}</code>{controlled?<JointTargetInput joint={joint} value={targets[joint.name]??Number.NaN} tr={tr} set={value=>setTargets({...targets,[joint.name]:value},true)}/>:<small>{tr("耦合 / 被动","Coupled / passive")}</small>}</div>})}
      {targetErrors.length>0&&<p className="lya-error" role="alert">{tr("目标未提交：","Targets not submitted: ")}{targetErrors.map(e=>`${e.name} · ${e.code}`).join("；")}</p>}
      <div className="lya-row" style={{marginTop:8}}><button className="lya-chip" onClick={()=>{const joints=observation?.joints;if(joints)setTargets(Object.fromEntries(description.controlledJointNames.map(name=>[name,joints.positions[joints.names.indexOf(name)]??Number.NaN])),false)}}>{tr("实测值填入目标","Use observed state")}</button><button className="lya-chip lya-chip-accent" disabled={!ready||!description.controlledJointNames.length||targetErrors.length>0||!Number.isFinite(duration)||duration<=0} onClick={()=>move("robot_move",fullMotion(),tr("完整关节运动","Full joint motion"))}>{tr("全部关节同步运动","Move all joints")}</button></div>
      </details>
      {controller?.gripper&&<><div style={{marginTop:8}}><NumberField label={tr("夹爪宽度 m","Gripper width m")} value={gripper} set={setGripper} min={0} max={controller.gripper.maxWidthM??.1} step={.005}/></div><div className="lya-row"><button className="lya-chip" disabled={!ready} onClick={()=>move("robot_gripper",{kind:"gripper",entityId:entity.entityId,widthM:gripper,durationS:duration},tr("夹爪控制","Gripper control"))}>{tr("设置夹爪宽度","Set gripper width")}</button></div></>}
    </>)}
  </fieldset>
}
/** 动作结果同样走**一份**摘要口径（R5）：这里过去只写 `receipt.status`，把 `targetReached=false`
 * 藏在展开的原回执里——"指令结束"被读成"到达目标"。同一个 `status=completed` 的回执现在点明
 * "动作已结束，目标未到达"与未进容差的动作数/容差；原回执照旧整份可展开。 */
/** 失败回执在服务端已裁成 `{code,message}`；这里只取稳定公开码 + 人话，不回显内部原文。 */
const publicErrorText=(error:unknown)=>typeof error==="string"?error:(error&&typeof error==="object"?""
 // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 回执是服务端投影出的 JSON，形状由 commandRouteResponse 决定
 +String((error as any).code??"")+((error as any).message?`: ${(error as any).message}`:""):"")
export function ActionCards({actions,tr,allowRaw=false,mode}:{actions:RecentAction[];tr:Translate;allowRaw?:boolean;mode?:string}){
 const english=tr("中","en")==="en"
 return <>{actions.map(action=>{
  const info=action.waiting?{summary:tr("请求已提交，等待引擎结果…","Request submitted; awaiting engine result…"),tone:"running" as const}
   :domainCommandSummary(action.display?.phase==='stop'?'sim_stop':action.label,action.receipt?JSON.stringify(action.receipt):action.error?publicErrorText(action.error):undefined,action.error?"error":"success",english)
  const label=({robot_move:tr("完整关节运动","Full joint motion"),sim_execute_batch:tr("多机器人同步","Synchronized robots"),vehicle_drive:tr("车辆行驶","Vehicle drive"),joint_move:tr("关节 / 升降","Joint / lift"),robot_gripper:tr("夹爪控制","Gripper control")}[action.label])??action.label
  // 详情区只写公共字段（含"目标未到达"这类负面事实）；原始回执只在两闸都开的开发诊断面出现。
  const rows=(action.receipt?publicCommandFace(action.display?.phase==='stop'?'sim_stop':action.label,action.receipt,english):(action.error?publicCommandFace(action.label,{status:"failed"},english):[])) as string[]
  const raw=hasRawCommandIOAccess(mode??"formal",allowRaw)&&action.receipt?JSON.stringify(action.receipt,null,2):undefined
  return <div className="lya-receipt" key={action.id} data-gesture-id={action.display?.gestureId}><strong>{label}</strong>{action.display?.phase==='update'&&<small>{tr("手势中，最终目标尚未提交。","Gesture in progress; the final target is not submitted yet.")}</small>}<p className={info.tone==="error"?"lya-error":info.tone==="warning"?"lya-warning":"lya-muted"}>{info.summary}</p>{rows.length>0&&<div className="lya-receipt-details">{rows.map((row:string)=><div key={row}>{row}</div>)}</div>}{action.history&&action.history.length>1&&<details><summary>{tr(`本手势 ${action.history.length} 条真实命令`,`This gesture: ${action.history.length} recorded commands`)}</summary>{action.history.map(item=><p key={item.commandId}>{item.phase} · {item.waiting?tr("等待回执","Pending"):item.error??domainCommandSummary(item.phase==='stop'?'sim_stop':'joint_move',item.receipt?JSON.stringify(item.receipt):undefined,"success",english).summary}</p>)}</details>}{raw&&<details><summary>{tr("诊断（凭据已脱敏）","Diagnostics (secrets redacted)")}</summary><pre>{redactSecretsText(raw)}</pre></details>}</div>
 })}</>}
