/** 原生preload持有的启动失败入口；不依赖React或尚未激活的shell。 */
export interface WorkspaceBootRecoveryActions {
 locale():Promise<'zh'|'en'>
 failed(detail:string):void
 ready?():void
 retry():Promise<void>
 returnToLogin():Promise<void>
}

const texts={
 zh:{title:'工作台界面未能加载',summary:'可以重试，或返回登录页。账号、会话和工程不会因此被删除。',retry:'重试工作台',back:'返回登录',details:'查看详情',retrying:'正在重试…',returning:'正在返回…'},
 en:{title:'The workspace could not load',summary:'Retry or return to sign-in. Your account, sessions and projects are kept.',retry:'Retry workspace',back:'Return to sign-in',details:'View details',retrying:'Retrying…',returning:'Returning…'},
}

export function safeWorkspaceBootDetail(value:string):string{
 return value.slice(0,8192).replace(/([?&](?:token|access_token|api_key|key)=)[^\s&]+/gi,'$1[redacted]').replace(/(Bearer\s+)[^\s]+/gi,'$1[redacted]')
}

export function mountWorkspaceBootFailure(document:Document,detail:string,actions:WorkspaceBootRecoveryActions){
 const root=document.createElement('section');root.dataset.lyapunovWorkspaceFailure=''
 Object.assign(root.style,{position:'fixed',inset:'0',zIndex:'2147483647',display:'grid',placeItems:'center',padding:'24px',background:'var(--background-base,#141418)',color:'var(--text-strong,#f4f4f6)',fontFamily:'system-ui,"Lyapunov CJK",sans-serif'})
 const card=document.createElement('div');Object.assign(card.style,{width:'min(560px,100%)',display:'grid',gap:'16px',padding:'32px',border:'1px solid #56565e',borderRadius:'16px',background:'var(--background-raised,#202025)'})
 const brand=document.createElement('strong');brand.textContent='Lyapunov'
 const title=document.createElement('h1'),summary=document.createElement('p'),buttons=document.createElement('div')
 Object.assign(title.style,{margin:'0',fontSize:'24px'});Object.assign(summary.style,{margin:'0',lineHeight:'1.6'});Object.assign(buttons.style,{display:'flex',gap:'12px',flexWrap:'wrap'})
 const retry=document.createElement('button'),back=document.createElement('button'),details=document.createElement('details'),label=document.createElement('summary'),pre=document.createElement('pre')
 retry.type=back.type='button';retry.dataset.lyapunovWorkspaceRetry='';back.dataset.lyapunovReturnToLogin=''
 for(const button of [retry,back])Object.assign(button.style,{border:'1px solid #777780',borderRadius:'8px',padding:'10px 16px',color:'inherit',background:'transparent',cursor:'pointer',font:'inherit'})
 pre.textContent=safeWorkspaceBootDetail(detail);Object.assign(pre.style,{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:'12px',maxHeight:'220px',overflow:'auto'})
 details.append(label,pre);buttons.append(retry,back);card.append(brand,title,summary,buttons,details);root.append(card);document.body.append(root)
 let locale:'zh'|'en'='en'
 const render=()=>{const t=texts[locale];title.textContent=t.title;summary.textContent=t.summary;retry.textContent=t.retry;back.textContent=t.back;label.textContent=t.details}
 render();void actions.locale().then(value=>{locale=value;render()}).catch(()=>{})
 const perform=async(which:'retry'|'back')=>{
  retry.disabled=back.disabled=true;summary.textContent=texts[locale][which==='retry'?'retrying':'returning']
  try{await(which==='retry'?actions.retry():actions.returnToLogin())}
  catch(error){summary.textContent=safeWorkspaceBootDetail(error instanceof Error?error.message:String(error));retry.disabled=back.disabled=false}
 }
 retry.addEventListener('click',()=>void perform('retry'));back.addEventListener('click',()=>void perform('back'))
 return()=>root.remove()
}

export function watchWorkspaceBoot(document:Document,actions:WorkspaceBootRecoveryActions){
 let finished=false,seenBoot:HTMLElement|undefined,remove:(()=>void)|undefined
 const check=()=>{
  if(finished)return
  const boot=document.querySelector<HTMLElement>('[data-dsh-boot]')
  if(!boot){if(seenBoot&&!seenBoot.isConnected){finished=true;observer.disconnect();actions.ready?.()}return}
  seenBoot=boot
  if(boot.querySelector('[data-dsh-boot-spinner]'))return
  const report=boot.textContent??''
  if(!report.includes('Failed to load plugins')&&!report.includes('web boot:'))return
  finished=true;observer.disconnect();const detail=safeWorkspaceBootDetail(report);actions.failed(detail);remove=mountWorkspaceBootFailure(document,detail,actions)
 }
 const observer=new MutationObserver(check);observer.observe(document,{childList:true,subtree:true});check()
 const stop=()=>{finished=true;observer.disconnect();remove?.();document.defaultView?.removeEventListener('pagehide',stop)}
 document.defaultView?.addEventListener('pagehide',stop,{once:true})
 return stop
}
