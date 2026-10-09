import {robotLibraryText} from './robot-library-text.ts'
import {useEffect,useState} from 'react'
import type {Context} from '@deepseek-ai/cordis'
import type {ISessions} from '@deepseek-ai/dsh-api-session-controller/client'
import type {RobotLibraryRow} from './robot-library.ts'
import {SCENE_TAB_KIND} from './native-workspace.tsx'
import {mainSessionId} from './history-navigation.ts'
type Translate=(zh:string,en:string)=>string
async function request<T>(sessionId:string,register=false):Promise<T>{
 const response=await fetch('/api/lyapunov/robot-library?sessionId='+encodeURIComponent(sessionId),register?{method:'POST'}:undefined)
 const value=await response.json();if(!response.ok)throw Error(value.error??'ROBOT_LIBRARY_UNAVAILABLE');return value
}
export function RobotLibrarySettings({tr,sessionId,openWorkbench}:{tr:Translate;sessionId:()=>string|undefined;openWorkbench:()=>void}){
 const [rows,setRows]=useState<RobotLibraryRow[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[query,setQuery]=useState(''),[detail,setDetail]=useState<string>()
 const refresh=async(register=false)=>{const id=sessionId();if(!id){setError(tr('请先打开一个会话，机器人库登记归该会话的原资源库。','Open a session to use its resource library.'));return}setBusy(true);setError('');try{const value=await request<{models:RobotLibraryRow[];blocked?:Array<{packId:string;detail:string}>}>(id,register);setRows(value.models);if(value.blocked?.length)setError(value.blocked.map(row=>row.packId+': '+robotLibraryText(row.detail,tr)).join('\n'))}catch(reason){setError(robotLibraryText(reason instanceof Error?reason.message:String(reason),tr))}finally{setBusy(false)}}
 useEffect(()=>{void refresh(true)},[])
 const filtered=rows.filter(row=>[row.packId,row.family,row.source].join(' ').toLowerCase().includes(query.toLowerCase()))
 return <section style={{padding:20,display:'grid',gap:14}} aria-label={tr('机器人库','Robot library')}>
  <h2 style={{margin:0}}>{tr('机器人库','Robot library')}</h2>
  <p>{tr('内置 T0 模型是可重复使用的示例资产。来源与许可、模型登记、控制适配和实际动作分别展示。','Bundled T0 models are reusable demo assets. Sources, licenses, registration, control adaptation and motion evidence are separate.')}</p>
  <div><input type='search' aria-label={tr('搜索机器人','Search robots')} value={query} onChange={event=>setQuery(event.target.value)}/> <button disabled={busy} onClick={()=>void refresh()}>{tr('刷新','Refresh')}</button> <button onClick={openWorkbench}>{tr('打开场景：导入、放置与操作','Open scene: import, place and operate')}</button></div>
  {error&&<p role='alert' style={{whiteSpace:'pre-wrap'}}>{error}</p>}{busy&&<p role='status'>{tr('正在读取并登记内置示例…','Reading and registering bundled examples…')}</p>}
  <div style={{display:'grid',gridTemplateColumns:'minmax(130px,200px) minmax(0,1fr)',gap:18}}>
   <nav aria-label={tr('T0 机型','T0 models')}>{filtered.map(row=><button key={row.packId} style={{display:'block',width:'100%',textAlign:'left',marginBottom:6}} onClick={()=>setDetail(row.packId)}>{row.packId}<small style={{display:'block'}}>{row.installed?tr('已登记','Registered'):row.modelPath?tr('内置原件','Bundled original'):tr('按需／未提供','On demand / absent')}</small></button>)}</nav>
   <div>{filtered.filter(row=>row.packId===(detail??filtered[0]?.packId)).map(row=><article key={row.packId} style={{overflowWrap:'anywhere'}}>
    <h3>{row.packId} · T0</h3><p>{tr('版本：','Version: ')}{row.version} · {row.family}</p>
    <p>{tr('来源：','Source: ')}{row.source}</p><p>{tr('模型许可：','Model license: ')}{robotLibraryText(row.license,tr)}</p><p>{tr('策略许可：','Policy license: ')}{robotLibraryText(row.policyLicense,tr)}</p>
    <p>{tr('模型原件体积：','Original model bytes: ')}{row.modelBytes===null?tr('未供给／未知','Absent / unknown'):(row.modelBytes/1048576).toFixed(2)+' MiB'}{row.modelSha256&&<><br/>SHA-256: <code>{row.modelSha256}</code></>}</p>
    <p>{tr('默认策略：','Default policy: ')}{row.policyStatus==='PREPARED'?tr('已准备，待场景绑定','Prepared; bind to a scene'):row.policyStatus==='BLOCKED'?tr('当前受阻','Blocked'):tr('原生直控，无基础权重','Native control; no base weights')} · {row.policyVariant??tr('无需基础权重','No base weights required')}{row.policyDetail&&<small style={{display:'block'}}>{robotLibraryText(row.policyDetail,tr)}</small>}</p>
    <p>{tr('原模型 DOF（含自由根）：','Source DOF (including free root): ')}{row.sourceDof??tr('尚未读取','Not read')} · {tr('策略动作维数：','Policy action dimension: ')}{row.policyDof??tr('未声明','Undeclared')}</p>
    <p>{tr('基础控制：','Basic control: ')}{robotLibraryText(row.control,tr)} · {row.channels.join(', ')}<br/>{tr('包适配：','Pack adaptation: ')}{row.adapterReady?tr('契约满足；须绑定正确机型与运行时','Contract satisfied; bind correct model and runtime'):tr('条件未齐全','Requirements missing')}</p>
    <p>{tr('关节／DOF 以放置后 robot_describe 的真实机型读数为准；不得跨机型借用策略。','Read actual joints / DOF through robot_describe after placement. Policies must match the exact model.')}</p>
    <p>{row.family==='hand'?tr('安装示例：父连杆或台架。先安装与核对关节，再进行关节／夹持示范。','Example: parent link or stand. Install and inspect joints before joint / grasp demonstrations.'):row.packId==='crazyflie_2'?tr('示范：本地 MuJoCo PID 的小范围悬停、到点与降落；需真实 thrust 通道。','Demo: bounded MuJoCo PID hover, goto and land with actual thrust channels.'):row.packId==='unitree_a1'||row.packId==='generic_quadrotor'?tr('尚未适配基础运动；需要该机型的适配器或外部控制。','Basic motion is not adapted; requires its own adapter or external controller.'):tr('示范入口：场景面板的关节／姿态控制；策略模型须先通过原策略装配与绑定检查。','Demo entry: scene joint / pose controls; policy models require preparation and binding checks.')}</p>
    {row.gaps.length>0&&<details><summary>{tr('当前缺项','Current gaps')}</summary><ul>{row.gaps.map((gap,index)=><li key={index}>{robotLibraryText(gap,tr)}</li>)}</ul></details>}
   </article>)}</div>
  </div>
 </section>
}
export function applyRobotLibrarySettings(ctx:Context){
 const t=ctx.locale.bind('lyapunov'),tr:Translate=(zh,en)=>t('open')==='Scene workbench'?en:zh,sessions=ctx.get('sessions') as unknown as ISessions
 ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'lyapunov-robot-library',order:40,label:()=>tr('机器人库','Robot library'),inject:()=>({tr,sessionId:()=>mainSessionId(sessions.list.getSnapshot()),openWorkbench:()=>{const id=mainSessionId(sessions.list.getSnapshot());if(id)ctx.sidebarRight.openTabIn(id,SCENE_TAB_KIND)}})},RobotLibrarySettings))
}
