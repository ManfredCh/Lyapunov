import {robotLibraryText} from './robot-library-text.ts'
import {useEffect,useState} from 'react'
import {Button,Input,IconSearchOutlineRegular,IconRefreshOutlineRegular} from '@deepseek-ai/dsh-client-ui-primitives'
import {SettingsPage,SettingsHeading,SettingsListRow,SettingsField,SettingsDetails} from './settings-ui.tsx'
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
export function RobotLibrarySettings({tr,sessionId,openWorkbench,close}:{tr:Translate;sessionId:()=>string|undefined;openWorkbench:()=>void;close:()=>void}){
 const [rows,setRows]=useState<RobotLibraryRow[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[query,setQuery]=useState(''),[detail,setDetail]=useState<string>()
 const refresh=async(register=false)=>{const id=sessionId();if(!id){setError(tr('请先打开一个会话，机器人库登记归该会话的原资源库。','Open a session to use its resource library.'));return}setBusy(true);setError('');try{const value=await request<{models:RobotLibraryRow[];blocked?:Array<{packId:string;detail:string}>}>(id,register);setRows(value.models);if(value.blocked?.length)setError(value.blocked.map(row=>row.packId+': '+robotLibraryText(row.detail,tr)).join('\n'))}catch(reason){setError(robotLibraryText(reason instanceof Error?reason.message:String(reason),tr))}finally{setBusy(false)}}
 useEffect(()=>{void refresh(true)},[])
 const filtered=rows.filter(row=>[row.packId,row.family,row.source].join(' ').toLowerCase().includes(query.toLowerCase()))
 const names:Record<string,string>={franka_panda:'Panda',ur10e:'UR10e',allegro_hand:'Allegro Hand',leap_hand:'Leap Hand',shadow_hand:'Shadow Hand',unitree_go1:'Unitree Go1',unitree_go2:'Unitree Go2',unitree_g1:'Unitree G1',unitree_a1:'Unitree A1',crazyflie_2:'Crazyflie 2',generic_quadrotor:'Generic Quadrotor'}
 const selected=filtered.find(row=>row.packId===detail)??filtered[0]
 const modelStatus=(row:RobotLibraryRow)=>row.installed?tr('已登记','Registered'):row.modelPath?tr('内置原件','Bundled'):tr('按需／未提供','On demand / absent')
 return <SettingsPage label={tr('机器人库','Robot library')}>
  <SettingsHeading title={tr('机器人库','Robot library')} actions={<Button size='sm' disabled={!sessionId()} onClick={()=>{openWorkbench();close()}}>{tr('打开场景','Open scene')}</Button>}/>
  <div className='lya-settings-toolbar'><Input className="lya-settings-search" type='search' icon={<IconSearchOutlineRegular size={16}/>} placeholder={tr('搜索机器人','Search robots')} aria-label={tr('搜索机器人','Search robots')} value={query} onChange={event=>setQuery(event.target.value)}/><Button size='sm' title={tr('刷新','Refresh')} aria-label={tr('刷新','Refresh')} icon={<IconRefreshOutlineRegular size={16}/>} disabled={busy} onClick={()=>void refresh()}/></div>
  {error&&<p className='lya-settings-message' role='alert'>{error}</p>}
  {busy&&<p className='lya-settings-message' role='status'>{tr('正在读取机器人库…','Reading robot library…')}</p>}
  <div className='lya-settings-split'>
   <nav className='lya-settings-list' aria-label={tr('机器人资源','Robot resources')}>{filtered.map(row=><SettingsListRow key={row.packId} name={names[row.packId]??row.packId} status={row.installed?null:modelStatus(row)} selected={selected?.packId===row.packId} onClick={()=>setDetail(row.packId)}/>)}</nav>
   {selected&&<article aria-label={names[selected.packId]??selected.packId}>
    <div className='lya-settings-title-meta'><h3>{names[selected.packId]??selected.packId}</h3><span className='lya-settings-caption'>{modelStatus(selected)}</span></div>
    <dl className='lya-settings-fields'>
     <SettingsField label={tr('类别','Family')}>{selected.family}</SettingsField>
     <SettingsField label={tr('版本','Version')}>{selected.version}</SettingsField>
     <SettingsField label={tr('控制','Control')}>{robotLibraryText(selected.control,tr)}</SettingsField>
     <SettingsField label={tr('默认策略','Default policy')}>{selected.policyStatus==='PREPARED'?tr('已准备，待场景绑定','Prepared; bind to a scene'):selected.policyStatus==='BLOCKED'?tr('受阻','Blocked'):tr('原生直控','Native control')}</SettingsField>
    </dl>
    <SettingsDetails title={tr('来源与许可','Source & licenses')}><dl className='lya-settings-fields'><SettingsField label={tr('来源','Source')}>{selected.source}</SettingsField><SettingsField label={tr('模型许可','Model license')}>{robotLibraryText(selected.license,tr)}</SettingsField><SettingsField label={tr('策略许可','Policy license')}>{robotLibraryText(selected.policyLicense,tr)}</SettingsField></dl></SettingsDetails>
    <SettingsDetails title={tr('模型文件','Model files')}><dl className='lya-settings-fields'><SettingsField label={tr('资源 ID','Resource ID')}><code>{selected.packId}</code></SettingsField><SettingsField label={tr('包大小','Bundle size')}>{selected.modelBytes===null?tr('未提供／未知','Absent / unknown'):(selected.modelBytes/1048576).toFixed(2)+' MiB'}</SettingsField>{selected.modelSha256&&<SettingsField label='SHA-256'><code>{selected.modelSha256}</code></SettingsField>}</dl></SettingsDetails>
    <SettingsDetails title={tr('控制与兼容性','Control & compatibility')}><dl className='lya-settings-fields'><SettingsField label={tr('来源 DOF','Source DOF')}>{selected.sourceDof??tr('未读取','Not read')}</SettingsField><SettingsField label={tr('策略维数','Policy dimension')}>{selected.policyDof??tr('未声明','Undeclared')}</SettingsField><SettingsField label={tr('通道','Channels')}>{selected.channels.join(', ')||'—'}</SettingsField><SettingsField label={tr('适配','Adaptation')}>{selected.adapterReady?tr('契约满足，待场景绑定','Contract satisfied; bind to a scene'):tr('条件未齐','Requirements missing')}</SettingsField><SettingsField label={tr('策略变体','Policy variant')}>{selected.policyVariant??tr('无需基础权重','No base weights required')}</SettingsField></dl>{selected.policyDetail&&<p className='lya-settings-caption'>{robotLibraryText(selected.policyDetail,tr)}</p>}<p className='lya-settings-caption'>{selected.family==='hand'?tr('先安装到父连杆或台架，再检查关节与夹持。','Mount on a parent link or stand, then inspect joints and grasp control.'):selected.packId==='crazyflie_2'?tr('本地 MuJoCo PID 支持小范围悬停、到点与降落，需真实 thrust 通道。','Local MuJoCo PID supports bounded hover, goto and land with actual thrust channels.'):selected.packId==='unitree_a1'||selected.packId==='generic_quadrotor'?tr('基础运动尚未适配，需准确机型的适配器或外部控制。','Basic motion is not adapted; requires an exact-model adapter or external controller.'):tr('在场景面板中使用关节与姿态控制；策略须通过准备和绑定检查。','Use scene joint and pose controls; policies require preparation and binding checks.')}</p><p className='lya-settings-caption'>{tr('放置后的 robot_describe 提供真实关节与 DOF。','After placement, robot_describe reports actual joints and DOF.')}</p></SettingsDetails>
    {selected.gaps.length>0&&<SettingsDetails title={tr('当前缺项','Current gaps')} meta={selected.gaps.length}><ul className='lya-settings-gap-list'>{selected.gaps.map((gap,index)=><li key={index} title={gap}>{gap==='POLICY_WEIGHTS_NOT_OBTAINABLE'?tr('策略权重不可获取','Policy weights unavailable'):gap==='POLICY_ADAPTER_UNIMPLEMENTED'?tr('策略适配器尚未实现','Policy adapter not implemented'):robotLibraryText(gap,tr)}</li>)}</ul></SettingsDetails>}
   </article>}
  </div>
  {!busy&&!filtered.length&&<p className='lya-settings-caption'>{tr('没有匹配的机器人。','No matching robots.')}</p>}
 </SettingsPage>
}
export function applyRobotLibrarySettings(ctx:Context){
 const t=ctx.locale.bind('lyapunov'),tr:Translate=(zh,en)=>t('open')==='Scene workbench'?en:zh,sessions=ctx.get('sessions') as unknown as ISessions
 ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'lyapunov-robot-library',order:40,label:()=>tr('机器人库','Robot library'),inject:()=>({tr,sessionId:()=>mainSessionId(sessions.list.getSnapshot()),openWorkbench:()=>{const id=mainSessionId(sessions.list.getSnapshot());if(id)ctx.sidebarRight.openTabIn(id,SCENE_TAB_KIND)}})},RobotLibrarySettings))
}
