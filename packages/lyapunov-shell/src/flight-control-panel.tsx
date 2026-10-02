import {useEffect,useRef,useState} from 'react'
import type {Entity,EntityObservation,WorldHandle} from '../../lyapunov-contracts/src/types.ts'
import type {RobotDescription} from '../../sim-contract/src/index.ts'
import {NumberField,type Translate} from './entity-editor.tsx'
import {assertFlightProfile} from '../../robot-workflows/src/flight-controller.ts'
export function FlightControlPanel({entity,description,observation,world,ready,command,tr,onWorldReset,describe}:{entity:Entity;description?:RobotDescription;observation?:EntityObservation;world:WorldHandle;ready:boolean;command:(name:string,input:Record<string,unknown>)=>Promise<any>;tr:Translate;onWorldReset?:(world:WorldHandle)=>void;describe?:()=>void}){
 const [target,setTarget]=useState<[number,number,number]>([0,0,.35]),[yaw,setYaw]=useState(0),[groundZ,setGroundZ]=useState(0),[duration,setDuration]=useState(8),[busy,setBusy]=useState(false),[status,setStatus]=useState<any>(),[error,setError]=useState('')
 const mapping=description?.bodyWrench
 let compatible=false;try{compatible=world.engineId==='mujoco'&&Boolean(assertFlightProfile(mapping))}catch{ /* 实際映射未就绪时禁用，不用模型名称猜就绪 */ }
 const identity={worldId:world.worldId,entityId:entity.entityId,expectedGeneration:world.worldGeneration,expectedSceneRevision:world.appliedSceneRevision}
 const commandRef=useRef(command);commandRef.current=command
 const active=useRef(false)
 const controlKey=JSON.stringify([world.worldId,world.worldGeneration,entity.entityId])
 useEffect(()=>{const p=observation?.transform.position;if(p)setTarget([p[0],p[1],Math.max(p[2],.35)]);setStatus(undefined);setError('');return()=>{if(active.current){active.current=false;void commandRef.current('robot_flight',{...identity,operation:'stop'}).catch(()=>{})}}},[controlKey])
 useEffect(()=>{
  if(!ready||!compatible)return
  let ended=false
  const refresh=async()=>{try{const value=await commandRef.current('robot_flight',{...identity,operation:'status'});if(!ended){setStatus(value);active.current=value.status==='running'}}catch(value){if(!ended)setError(String(value))}}
  void refresh();const timer=setInterval(()=>void refresh(),500)
  return()=>{ended=true;clearInterval(timer)}
 },[controlKey,ready,compatible])
 const invoke=async(operation:string)=>{
  setBusy(true);setError('')
  try{const result=await command('robot_flight',{...identity,operation,...['hover','goto'].includes(operation)?{positionM:target,yawRad:yaw,maxDurationS:duration}:{},...operation==='land'?{landingSurfaceZ:groundZ,maxDurationS:20}:{}});setStatus(result);active.current=result.status==='running';if(result.world)onWorldReset?.(result.world)}catch(value){setError(String(value))}finally{setBusy(false)}
 }
 const running=status?.status==='running'
 return <fieldset className='lya-robot-card' data-testid='native-flight-control'><legend>{entity.name} · {tr('本地飞控','Local flight controller')}</legend>
  <p className='lya-help'>{tr('Crazyflie 原生合力/合矩闭环；当前仅验证 MuJoCo、小范围与固定模型。四通道不是电机 RPM，也未连接真实飞行器。','Native Crazyflie force/torque loop. MuJoCo and a fixed model within a small envelope are verified; these channels are not motor RPM or hardware control.')}</p>
  {describe&&<button className='lya-chip' disabled={!ready} onClick={describe}>{tr('读取飞控实际映射','Read native flight mapping')}</button>}
  {!compatible&&<p className='lya-help' role='status'>{tr('当前实例缺少已验证模型或实际引擎映射，飞控暂不可用。通用飞行器仍需要飞控桥。','This instance lacks a verified model or native mapping. Generic aircraft require a flight controller bridge.')}</p>}
  {compatible&&<>
   <p className='lya-help'>{tr('世界坐标，米；Z 向上。目标水平距离 ≤1m、高度 ≤1m。窗口结束撤推力，随后遵循物理下落；落地与立即停止分开。','World coordinates in metres, Z up. Horizontal target ≤1m and height ≤1m. Thrust ends with the bounded window; landing and immediate stop are separate.')}</p>
   <div className='lya-row'>{(['X','Y','Z'] as const).map((axis,i)=><NumberField key={axis} label={`${axis} m`} value={target[i]!} set={value=>setTarget(old=>old.map((v,k)=>k===i?value:v) as [number,number,number])} step={.05} min={axis==='Z'?0:undefined} max={axis==='Z'?1:undefined}/>)}</div>
   <NumberField label={tr('偏航 rad','Yaw rad')} value={yaw} set={setYaw} step={.1}/><NumberField label={tr('维持窗口 s','Control window s')} value={duration} set={setDuration} min={1} max={30} step={1}/>
   <NumberField label={tr('落地表面高度 m','Landing surface Z m')} value={groundZ} set={setGroundZ} step={.05}/>
   <div className='lya-row'><button className='lya-chip' disabled={!ready||busy||running} onClick={()=>void invoke('hover')}>{tr('悬停 / 升到高度','Hover / rise')}</button><button className='lya-chip' disabled={!ready||busy||running} onClick={()=>void invoke('goto')}>{tr('飞到 XYZ / 偏航','Fly to XYZ / yaw')}</button><button className='lya-chip' disabled={!ready||busy||running} onClick={()=>void invoke('land')}>{tr('受控落地','Land')}</button></div>
   <div className='lya-row'><button className='lya-stop' disabled={!ready||busy} onClick={()=>void invoke('stop')}>{tr('立即停止飞控','Stop controller')}</button><button className='lya-chip' disabled={!ready||busy||running} title={tr('复位整个当前会话世界，不改场景原件','Resets this session world; source scene is preserved')} onClick={()=>void invoke('reset')}>{tr('复位整个模拟世界','Reset simulation world')}</button></div>
  </>}
  {observation&&<p className='lya-help'>{tr('当前实测 XYZ：','Current observed XYZ: ')}{observation.transform.position.map(v=>v.toFixed(3)).join(' / ')} m</p>}
  {status&&<p className='lya-help' role='status'>{tr('飞控状态：','Controller: ')}{status.status??status.controllerStatus??(status.stopped?'stopped':'—')}{status.actions!==undefined?` · ${status.actions}`:''}{status.reason?` · ${status.reason}`:''}</p>}
  {error&&<p className='lya-error' role='alert'>{error}</p>}
 </fieldset>
}
