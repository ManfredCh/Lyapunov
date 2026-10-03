import { useEffect, useState } from 'react'
import { Matrix4, Quaternion, Vector3 } from 'three'
import type { Entity, Frame, SceneSnapshot, Vec3, WorldHandle } from '../../lyapunov-contracts/src/types.ts'
import type { RobotAnchorPose, RobotBaseState, RobotSetBaseInput, RobotSetTcpInput, RobotTcpDefinition } from '../../lyapunov-contracts/src/robot-authoring.ts'
import { validRobotPose } from '../../lyapunov-contracts/src/robot-authoring.ts'
import { currentRobotFrame } from '../../lyapunov-contracts/src/robot-frame.ts'
import type { RobotDescription } from '../../sim-contract/src/index.ts'
import { NumberField, type Translate } from './entity-editor.tsx'

export interface RobotAuthoringPanelProps {
  entity: Entity; scene?: SceneSnapshot; world?: WorldHandle; frame?: Frame; description?: RobotDescription; ready: boolean; tr: Translate
  configure?: (name: 'robot_set_tcp' | 'robot_set_base', input: RobotSetTcpInput | RobotSetBaseInput) => Promise<unknown>
  moveTcp?: (deltaM: Vec3) => Promise<unknown>; stop?: () => void; sync?: () => void; reset?: () => void; editPosition?: () => void
  locate?: (kind: 'tcp' | 'base') => unknown
}
function matrix(pose: RobotAnchorPose) { return new Matrix4().compose(new Vector3(...pose.positionM), new Quaternion(...pose.quaternionXyzw), new Vector3(1, 1, 1)) }
function poseOf(matrix: Matrix4): RobotAnchorPose {
  const p = new Vector3(), q = new Quaternion(), s = new Vector3(); matrix.decompose(p, q, s)
  return { positionM: p.toArray(), quaternionXyzw: q.normalize().toArray() }
}
const coordinates = (pose?: RobotAnchorPose) => validRobotPose(pose) ? pose.positionM.map(value => value.toFixed(4)).join(' · ') + ' m' : '—'

/** 表单是未提交草稿；实际状态只读当前 Scene、描述与同版本 Frame。 */
export function RobotAuthoringPanel({ entity, scene, world, frame, description, ready, tr, configure, moveTcp, stop, sync, reset, editPosition, locate }: RobotAuthoringPanelProps) {
  const saved = entity.components.controller?.tcp as RobotTcpDefinition | undefined
  const [body, setBody] = useState(saved?.body ?? ''), [site, setSite] = useState(saved?.site ?? '')
  const [offset, setOffset] = useState<Vec3>(saved?.offsetM ?? [0, 0, 0]), [localQ, setLocalQ] = useState(saved?.quaternionXyzw ?? [0, 0, 0, 1])
  const [step, setStep] = useState(.02), [target, setTarget] = useState('world'), [anchor, setAnchor] = useState<RobotAnchorPose>({ positionM: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1] })
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState('')
  useEffect(() => { setBody(saved?.body ?? ''); setSite(saved?.site ?? ''); setOffset(saved?.offsetM ?? [0, 0, 0]); setLocalQ(saved?.quaternionXyzw ?? [0, 0, 0, 1]); setError(''); setResult('') }, [entity.entityId, JSON.stringify(saved)])
  const currentFrame = currentRobotFrame(scene, world, frame)
  const observation = currentFrame?.entities.find(row => row.entityId === entity.entityId)
  const currentBase = observation?.sensors?.robotBase as RobotBaseState | undefined
  const base = currentFrame ? currentBase ?? description?.base : undefined
  const tcp = observation?.sensors?.tcp as RobotAnchorPose | undefined
  const canConfigure = Boolean(ready && currentFrame && configure && world && scene && description?.expectedGeneration === world.worldGeneration)
  const nativeBodies = description?.nativeBodies ?? [], nativeSites = description?.nativeSites ?? []
  const targetBodies = currentFrame?.entities.filter(row => row.entityId !== entity.entityId).flatMap(row => Object.entries(row.sensors?.bodyWorldPoses as Record<string, RobotAnchorPose> ?? {}).filter(([, pose]) => validRobotPose(pose)).map(([bodyName, pose]) => ({ entityId: row.entityId, bodyName, pose }))) ?? []
  const currentBinding = entity.components.baseBinding as unknown as { target?: RobotAnchorPose & { entityId?: string; bodyName?: string } } | undefined
  useEffect(() => {
    const bindingTarget = currentBinding?.target
    if (bindingTarget) { setTarget(bindingTarget.entityId ? JSON.stringify([bindingTarget.entityId, bindingTarget.bodyName]) : 'world'); setAnchor({ positionM: bindingTarget.positionM, quaternionXyzw: bindingTarget.quaternionXyzw }) }
    else if (validRobotPose(base?.worldFromBody)) { setTarget('world'); setAnchor(base.worldFromBody) }
  }, [entity.entityId, JSON.stringify(currentBinding), description?.expectedGeneration])
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(''); setResult('')
    try {
      const value = await action() as { status?: string; taskAchieved?: boolean; reason?: string; measuredDeltaM?: number[]; targetErrorM?: number }
      const failed = value.reason === 'TCP_BLOCKED_BY_CONTACT' ? tr('末端被碰撞接触阻挡，已停止。请调整对象位置或固定锚点，再同步。', 'The TCP is blocked by contact and has stopped. Edit the object position or base anchor, then sync.')
        : value.reason === 'TCP_STOP_CONFIRMED' ? tr('已停止机器人，并取消后续末端修正。', 'The robot stopped and further TCP corrections were cancelled.')
        : value.reason === 'TCP_TRACKING_JOINT_LIMIT' || value.reason === 'TCP_TRACKING_REFERENCE_LIMIT' ? tr('末端修正超出关节限位或有界跟踪范围，已停止；可减小步长或手调关节。', 'TCP correction exceeds a joint limit or the tracking bound and has stopped; reduce the step or adjust the joints.')
        : tr('动作结束，末端尚未到达目标，已停止；可减小步长或手调关节。', 'Motion ended before the TCP reached the target and has stopped; reduce the step or adjust joints.')
      setResult(value?.taskAchieved === false ? failed : value?.measuredDeltaM ? tr('实测末端位移：', 'Measured TCP delta: ') + value.measuredDeltaM.map(value => value.toFixed(4)).join(' · ') + ' m' : tr('已保存并读取对应版本的物理状态。', 'Saved and read the physics state for this revision.'))
    } catch (value) { setError(String(value instanceof Error ? value.message : value)) }
    finally { setBusy(false) }
  }
  const identity = () => {
    if (!canConfigure || !world || !scene) throw new Error(tr('先同步当前场景并读取机器人。', 'Sync the current scene and read the robot first.'))
    return { worldId: world.worldId, sceneId: scene.sceneId, entityId: entity.entityId, expectedRevision: scene.revision, expectedGeneration: world.worldGeneration }
  }
  const saveBase = (mode: 'source' | 'free' | 'fixed') => run(() => {
    const endpoint = target === 'world' ? undefined : targetBodies.find(row => JSON.stringify([row.entityId, row.bodyName]) === target)
    if (mode === 'fixed' && target !== 'world' && !endpoint) throw new Error(tr('绑定目标已变化，请重新选择。', 'The binding target changed; select it again.'))
    return configure!('robot_set_base', { ...identity(), base: { mode, bodyName: base!.bodyName, ...(mode === 'fixed' ? { target: { ...anchor, ...(endpoint ? { entityId: endpoint.entityId, bodyName: endpoint.bodyName } : {}) } } : {}) } })
  })
  const chooseTarget = (value: string) => {
    setTarget(value)
    if (!validRobotPose(base?.worldFromBody)) return
    if (value === 'world') setAnchor(base.worldFromBody)
    else {
      const endpoint = targetBodies.find(row => JSON.stringify([row.entityId, row.bodyName]) === value)
      if (endpoint) setAnchor(poseOf(matrix(endpoint.pose).invert().multiply(matrix(base.worldFromBody))))
    }
  }
  const overlap = currentFrame?.initialOverlap?.status === 'OVERLAP' && currentFrame.initialOverlap.pairs.some(pair => pair.entity1 === entity.entityId || pair.entity2 === entity.entityId || pair.geom1.startsWith(entity.entityId + '/') || pair.geom2.startsWith(entity.entityId + '/'))
  const locateAnchor=(kind:'tcp'|'base')=>{setError('');try{if(!locate)throw Error('ROBOT_ANCHOR_FOCUS_UNAVAILABLE');locate(kind);setResult(tr('已定位当前物理帧的真实标记。','Focused the native marker in the current physics frame.'))}catch(value){setError(value instanceof Error?value.message:String(value))}}
  return <div className="lya-robot-authoring" data-testid="robot-authoring-panel">
    <div className="lya-row"><button className="lya-stop" disabled={!world} onClick={stop}>{tr('停止机器人', 'Stop robot')}</button><button disabled={!scene} onClick={sync}>{tr('启动 / 同步物理', 'Start / sync physics')}</button><button disabled={!currentFrame || busy} onClick={reset}>{tr('复位世界全部实例', 'Reset all world instances')}</button></div>
    {!currentFrame && <p className="lya-help">{tr('先启动或同步物理世界，读取当前版本后即可手调；模型服务出错也可以使用。', 'Start or sync the physics world to use manual controls for this revision.')}</p>}
    {overlap && <div className="lya-warning" role="status"><p>{tr('机器人初始位置与其他碰撞体重叠。先停止，调整实例位置或下方固定锚点，再同步。', 'The robot initially overlaps another collider. Stop, edit the instance or base anchor, then sync.')}</p><button onClick={editPosition}>{tr('编辑实例位置', 'Edit instance position')}</button><button onClick={stop}>{tr('停止', 'Stop')}</button></div>}
    <fieldset><legend>{tr('底座与绑定点', 'Base and attachment')}</legend>
      <p data-testid="robot-base-mode"><strong>{base?.mode === 'fixed' ? tr('底座已固定', 'Base fixed') : base?.mode === 'free' ? tr('底座可自由运动', 'Base free') : tr('底座状态待读取', 'Read base status')}</strong>{base?.bodyName ? ` · ${base.bodyName}` : ''}</p>
      <p className="lya-help">{base?.reason ?? tr('读取真实模型的根关节和约束后显示来源。', 'Read the native root joints and constraints to show their source.')}</p>
      {base?.target?.entityId && <p>{tr('绑定目标：', 'Attached to: ')}{scene?.entities.find(row => row.entityId === base.target!.entityId)?.name ?? base.target.entityId} · {base.target.bodyName}</p>}
      <p>{tr('底座当前位置：', 'Current base position: ')}{coordinates(currentBase?.worldFromBody)}</p>
      <button disabled={!currentFrame||!validRobotPose(currentBase?.worldFromBody)||!locate} onClick={()=>locateAnchor('base')}>{tr('定位底座 / 绑定点标记','Focus base / attachment marker')}</button>
      {base?.target&&<p className="lya-help">{tr('锚点位置：','Anchor position: ')}{coordinates(base.target)} · {base.target.entityId?tr('目标连杆局部系','Target body local frame'):tr('世界坐标系','World frame')}<br/>xyzw {base.target.quaternionXyzw.join(' · ')}</p>}
      <select className="lya-wide" aria-label={tr('底座固定目标', 'Base attachment target')} value={target} disabled={!canConfigure || busy} onChange={event => chooseTarget(event.target.value)}><option value="world">{tr('世界坐标（固定原位）', 'World coordinates')}</option>{targetBodies.map(row => <option key={JSON.stringify([row.entityId, row.bodyName])} value={JSON.stringify([row.entityId, row.bodyName])}>{scene?.entities.find(entity => entity.entityId === row.entityId)?.name ?? row.entityId} · {row.bodyName}</option>)}</select>
      <details><summary>{tr('编辑固定锚点', 'Edit attachment anchor')}</summary><p className="lya-help">{target === 'world' ? tr('位置在世界坐标系。', 'Position uses world coordinates.') : tr('位置相对所选目标连杆；目标移动时跟随真实约束。', 'Position is relative to the target body; a native constraint follows its motion.')}</p>{(['X', 'Y', 'Z'] as const).map((label, i) => <NumberField key={label} label={label + ' m'} value={anchor.positionM[i]!} step={.01} set={value => setAnchor({ ...anchor, positionM: anchor.positionM.map((previous, index) => index === i ? value : previous) as Vec3 })}/>)}<div className="lya-row">{(['x', 'y', 'z', 'w'] as const).map((label, i) => <NumberField key={label} label={'q' + label} value={anchor.quaternionXyzw[i]!} step={.01} set={value => setAnchor({ ...anchor, quaternionXyzw: anchor.quaternionXyzw.map((previous, index) => index === i ? value : previous) as [number, number, number, number] })}/>)}</div></details>
      <div className="lya-row"><button disabled={!canConfigure || !base?.editable.fixed || busy} onClick={() => void saveBase('fixed')}>{tr('固定 / 保存锚点', 'Fix / save anchor')}</button><button disabled={!canConfigure || !base?.editable.free || busy} onClick={() => void saveBase('free')}>{tr('解除固定', 'Release base')}</button><button disabled={!canConfigure || !base?.bodyName || busy} onClick={() => void saveBase('source')}>{tr('恢复源模型基座', 'Restore source base')}</button></div>
      {base?.editable.reason && <p className="lya-help">{base.editable.reason}</p>}
      {base && <details><summary>{tr('固定来源与约束', 'Base source and constraints')}</summary><p>{({ 'native-model': tr('原模型根关节', 'Native root joints'), 'scene-base-binding': tr('当前场景固定声明', 'Scene attachment'), 'importer-fixed-base': tr('导入器固定世界', 'Importer fixed base'), 'native-constraint': tr('原生约束', 'Native constraint') })[base.source]}</p>{base.constraints.map(row => <p key={row.name}>{row.kind} · {row.active ? tr('生效', 'Active') : tr('关闭', 'Disabled')} · {row.targetEntityId ? `${scene?.entities.find(entity => entity.entityId === row.targetEntityId)?.name ?? row.targetEntityId}/${row.targetBodyName}` : tr('世界', 'World')}</p>)}</details>}
    </fieldset>
    <fieldset><legend>{tr('末端 TCP 与小步移动', 'TCP and small movements')}</legend>
      <p data-testid="robot-tcp-current">{tr('当前末端：', 'Current TCP: ')}{coordinates(tcp)}{saved?.body ? ` · ${saved.body}${saved.site ? '/' + saved.site : ''}` : ''}</p>
      <button disabled={!currentFrame||!validRobotPose(tcp)||!locate} onClick={()=>locateAnchor('tcp')}>{tr('定位末端 TCP 标记','Focus TCP marker')}</button>
      {saved&&<p className="lya-help" data-testid="robot-tcp-source">{tr('TCP 来源：','TCP source: ')}{saved.site?tr('模型原生 site','Native model site'):tr('Scene 人工 body 局部声明','Scene manual body-local declaration')} · {saved.body}{saved.site?' / '+saved.site:''}<br/>{tr('相对连杆外参：','Body-local pose: ')}{(saved.offsetM??[0,0,0]).join(' · ')} m · xyzw {(saved.quaternionXyzw??[0,0,0,1]).join(' · ')}</p>}
      {!saved && <p className="lya-help">{tr('尚未设置 TCP。选择真实末端连杆或已有 site 后保存；连杆原点是明确的人工选择。', 'TCP is unset. Select a native end link or site and save; a body origin is an explicit manual choice.')}</p>}
      {nativeSites.length===0&&<p className="lya-help">{tr('这份模型没有原生 site。下方连杆来自真实模型；原点与偏移均由你明确选择，未自动套用其他机型配置。','This model has no native site. The links below come from the native model; choose an origin or offset explicitly.')}</p>}
      {nativeSites.length>0&&<div className="lya-row" style={{flexWrap:'wrap'}}>{nativeSites.map(candidate=><button key={`${candidate.bodyName}/${candidate.name}`} disabled={!canConfigure||busy} onClick={()=>void run(()=>configure!('robot_set_tcp',{...identity(),tcp:{body:candidate.bodyName,site:candidate.name}}))}>{tr('采用原生位置作 TCP：','Use native site as TCP: ')}{candidate.bodyName}/{candidate.name}</button>)}</div>}
      <select className="lya-wide" aria-label={tr('TCP 末端连杆', 'TCP end link')} value={body} disabled={!canConfigure || busy} onChange={event => { setBody(event.target.value); setSite(''); setOffset([0, 0, 0]); setLocalQ([0, 0, 0, 1]) }}><option value="">{tr('选择真实末端连杆', 'Select native end link')}</option>{nativeBodies.map(row => <option key={row.name} value={row.name}>{row.name}</option>)}</select>
      <select className="lya-wide" aria-label={tr('TCP 来源位置', 'TCP location source')} value={site} disabled={!canConfigure || !body || busy} onChange={event => setSite(event.target.value)}><option value="">{tr('所选连杆原点 / 自定义偏移', 'Selected body origin / local offset')}</option>{nativeSites.filter(row => row.bodyName === body).map(row => <option key={row.name} value={row.name}>{row.name} · {tr('模型原生 site', 'Native site')}</option>)}</select>
      {!site && <details><summary>{tr('高级：连杆局部偏移与姿态', 'Advanced: local offset and orientation')}</summary>{(['X', 'Y', 'Z'] as const).map((label, i) => <NumberField key={label} label={label + ' m'} value={offset[i]!} step={.005} set={value => setOffset(offset.map((previous, index) => index === i ? value : previous) as Vec3)}/>)}<div className="lya-row">{(['x', 'y', 'z', 'w'] as const).map((label, i) => <NumberField key={label} label={'q' + label} value={localQ[i]!} step={.01} set={value => setLocalQ(localQ.map((previous, index) => index === i ? value : previous))}/>)}</div></details>}
      <div className="lya-row"><button disabled={!canConfigure || !body || busy} onClick={() => void run(() => configure!('robot_set_tcp', { ...identity(), tcp: { body, ...(site ? { site } : { offsetM: offset, quaternionXyzw: localQ as [number, number, number, number] }) } }))}>{tr('保存 TCP', 'Save TCP')}</button><button disabled={!canConfigure || !saved || busy} onClick={() => void run(() => configure!('robot_set_tcp', { ...identity(), clear: true }))}>{tr('清除 TCP', 'Clear TCP')}</button></div>
      <NumberField label={tr('移动步长 m', 'Movement step m')} value={step} set={setStep} min={.001} max={.15} step={.005}/>
      <div className="lya-row">{([{ label: tr('上升', 'Up'), delta: [0, 0, step] }, { label: tr('下降', 'Down'), delta: [0, 0, -step] }, { label: 'X+', delta: [step, 0, 0] }, { label: 'X−', delta: [-step, 0, 0] }, { label: 'Y+', delta: [0, step, 0] }, { label: 'Y−', delta: [0, -step, 0] }]).map(row => <button key={row.label} disabled={!canConfigure || !validRobotPose(tcp) || !moveTcp || base?.mode !== 'fixed' || Boolean(base.target?.entityId) || busy} onClick={() => void run(() => moveTcp!(row.delta as Vec3))}>{row.label}</button>)}</div>
      {saved && (base?.mode !== 'fixed' || base.target?.entityId) && <p className="lya-help">{tr('当前小步 IK 要求固定世界基座。可固定世界后移动末端，或直接手调下方关节。', 'Small-step IK requires a world-fixed base. Fix the base to the world or adjust the joints directly.')}</p>}
    </fieldset>
    {busy && <p role="status">{tr('正在等待引擎回执…', 'Awaiting the engine receipt…')}</p>}{result && <p role="status" className="lya-help">{result}</p>}{error && <p role="alert" className="lya-error">{error}</p>}
  </div>
}
