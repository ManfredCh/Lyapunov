import type {SceneWorldState} from './scene-world-lifecycle.ts'
import type {Translate} from './entity-editor.tsx'
import {ISAAC_SDK_UNAVAILABLE_PUBLIC_MESSAGE} from '../../lyapunov-contracts/src/command-privacy.ts'
import {StatusDetails,statusMessageSummary} from './status-message.tsx'
/**
 * 底部状态/详情按**界面语言**显示：Isaac 缺 SDK 的公开投影（`command-privacy.ts`）是给人类面的
 * 固定中文句，这里**复用同一个常量**（不是第二套错误/国际化服务）经已有 `tr` 回译，英文设置下
 * 显示英文。原始解释器路径不在这句话里（只留在诊断/模型日志）。其他状态的 detail 原样显示。
 */
export function sceneWorldStatusDetail(state:Pick<SceneWorldState,'code'|'detail'>,tr:Translate):string|undefined{
 const detail=state.detail
 if(!detail)return detail
 const body=detail.replace(/^[A-Z][A-Z0-9_]*[:：]\s*/,'').trim()
 if(state.code==='ISAAC_SDK_UNAVAILABLE'||body===ISAAC_SDK_UNAVAILABLE_PUBLIC_MESSAGE)
  return tr(ISAAC_SDK_UNAVAILABLE_PUBLIC_MESSAGE,'The selected Isaac SDK is unavailable. Install Isaac, or check and register an existing compatible local installation in Physics settings, then save and restart Lyapunov.')
 return detail
}
export function sceneWorldPhaseLabel(phase:SceneWorldState['phase'],tr:Translate){
 return {idle:tr('尚未初始化','Not initialized'),initializing:tr('正在初始化物理世界','Initializing physics'),syncing:tr('正在应用场景修改','Applying scene changes'),ready:tr('物理世界就绪','Physics ready'),running:tr('物理世界运行中','Physics running'),paused:tr('物理世界已暂停','Physics paused'),unsynced:tr('场景已修改，等待应用','Scene changes await application'),failed:tr('物理世界初始化或场景应用失败','Physics startup or scene application failed'),blocked:tr('物理尚不可用','Physics blocked'),closed:tr('物理世界已关闭','Physics closed')}[phase]
}
export function SceneWorldStatus({state,tr,retry,cancel,disabled=false,compact=false}:{state:SceneWorldState;tr:Translate;retry:()=>void;cancel:()=>void;disabled?:boolean;compact?:boolean}){
 const detail=sceneWorldStatusDetail(state,tr),details=[state.code,detail,...state.missing??[]].filter(Boolean).join('\n')
 return <div className={compact?'lya-world-status':undefined} data-testid="scene-world-lifecycle" data-world-phase={state.phase} role="status"><span className={compact?'lya-world-label':undefined}>{sceneWorldPhaseLabel(state.phase,tr)}{state.engine?` · ${state.engine}`:''}{!compact&&state.generation!==undefined?` · g${state.generation}`:''}{!compact&&state.sceneRevision!==undefined?` · rev ${state.sceneRevision}`:''}</span>
  {compact?details&&<><span data-testid="world-status-reason" className="lya-help">{state.code?`${state.code} · `:''}{statusMessageSummary(detail??state.missing?.[0]??'')}</span><StatusDetails key={`${state.phase}:${state.code??''}`} details={details} tr={tr}/></>:<>{state.code&&<code> · {state.code}</code>}{detail&&<p className="lya-help">{detail}</p>}{state.missing?.length?state.missing.map(item=><p key={item} className="lya-help">{item}</p>):null}</>}
  {(state.phase==='initializing'||state.phase==='syncing')&&<button type="button" onClick={cancel}>{state.phase==='syncing'?tr('取消等待同步','Cancel synchronization wait'):tr('取消初始化','Cancel initialization')}</button>}
  {state.phase==='unsynced'&&<button type="button" disabled={disabled} onClick={retry}>{tr('应用场景修改','Apply scene changes')}</button>}
  {(state.phase==='failed'||state.phase==='closed')&&<button type="button" disabled={disabled} onClick={retry}>{tr('重新启动物理世界','Retry physics startup')}</button>}
 </div>
}
