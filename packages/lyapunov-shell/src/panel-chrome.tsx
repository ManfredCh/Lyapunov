/**
 * Lyapunov 自有工具面板的统一骨架（V9 / V8 视觉定稿）。
 *
 * 只解决"一页面板长什么样"：小号工具名、页面标题、返回、列表行、字段行、折叠区与底部
 * 主下一步动作。所有数据与动作仍由各面板的既有 owner 提供，本文件不持有状态、不发请求。
 *
 * 样式全部落在 `.lya-wb-panel` / `.lya-panel-*` 作用域，绝不碰 Harness 原生 Sidebar/Chat/
 * Session/Files/Terminal；原生工作面在本轮修改前后保持一致。
 */
import {useState,type ReactNode} from "react"
import {WorkbenchIcon,type WorkbenchIconId} from "./vendor/tabler/icons.tsx"

export function PanelPage({title,eyebrow,back,onBack,actions,children,className=""}:{
  title:string
  /** 二级页顶部的小号上级名（如 Objects / Robot Library）。 */
  eyebrow?:string
  /** 返回按钮文字；与 onBack 同时给才渲染。 */
  back?:string
  onBack?:()=>void
  actions?:ReactNode
  children:ReactNode
  className?:string
}){
  return <div className={`lya-panel-page${className?` ${className}`:""}`}>
    {back&&onBack&&<button type="button" className="lya-back" onClick={onBack}>{back}</button>}
    <div className="lya-page-head">
      <div className="lya-page-heading">
        {eyebrow&&<span className="lya-eyebrow">{eyebrow}</span>}
        <h2 className="lya-page-title" title={title}>{title}</h2>
      </div>
      {actions&&<div className="lya-page-actions">{actions}</div>}
    </div>
    {children}
  </div>
}

export function PanelSection({label,side,children}:{label:string;side?:ReactNode;children:ReactNode}){
  return <section className="lya-panel-section">
    <div className="lya-section"><span>{label}</span>{side!==undefined&&<span className="lya-section-side">{side}</span>}</div>
    {children}
  </section>
}

export function ListRow({icon,thumb,title,subtitle,side,selected,onClick,testId,trailing,disabled,hint}:{
  icon?:WorkbenchIconId
  /** 真实缩略图 URL（如随包官方图的字节路由）；给了就显示位图，加载失败如实回落到 icon 占位。 */
  thumb?:string
  title:string
  hint?:string
  subtitle?:ReactNode
  side?:ReactNode
  selected?:boolean
  onClick?:()=>void
  testId?:string
  trailing?:ReactNode
  disabled?:boolean
}){
  // 位图加载失败不残留破图：记下失败的 src，同一 URL 不再重试，行回到几何占位图标。
  const [failedThumb,setFailedThumb]=useState<string>()
  const showThumb=Boolean(thumb)&&failedThumb!==thumb
  const body=<>
    {showThumb?<span className="lya-row-thumb" aria-hidden="true"><img src={thumb} alt="" loading="lazy" onError={()=>setFailedThumb(thumb)}/></span>:icon&&<span className="lya-row-icon" aria-hidden="true"><WorkbenchIcon id={icon} size={15}/></span>}
    <span className="lya-row-main">
      <span className="lya-row-title" title={title}>{title}</span>
      {subtitle!==undefined&&<span className="lya-row-subtitle">{subtitle}</span>}
    </span>
    {side!==undefined&&<span className="lya-row-side">{side}</span>}
    {trailing}
    {onClick&&!trailing&&<span className="lya-row-chevron" aria-hidden="true">›</span>}
  </>
  if(onClick)return <button type="button" className="lya-list-row" data-testid={testId} data-selected={selected||undefined} aria-pressed={selected} disabled={disabled} onClick={onClick} title={hint??title}>{body}</button>
  return <div className="lya-list-row" data-testid={testId} data-selected={selected||undefined} title={hint??title}>{body}</div>
}

export function FieldRow({label,value,children}:{label:string;value?:ReactNode;children?:ReactNode}){
  return <div className="lya-field-row">
    <span className="lya-field-label">{label}</span>
    {value!==undefined&&<span className="lya-field-value" title={typeof value==="string"?value:undefined}>{value}</span>}
    {children}
  </div>
}

export function FooterActions({children,note,primary}:{children?:ReactNode;note?:ReactNode;primary?:ReactNode}){
  return <div className="lya-panel-foot">
    {note&&<div className="lya-foot-note">{note}</div>}
    <div className="lya-foot-actions">{children}{primary&&<span className="lya-spacer"/>}{primary}</div>
  </div>
}

export function EmptyState({icon,title,detail,children}:{icon?:WorkbenchIconId;title:string;detail?:string;children?:ReactNode}){
  return <div className="lya-empty-state">
    {icon&&<span className="lya-empty-icon" aria-hidden="true"><WorkbenchIcon id={icon} size={22}/></span>}
    <strong>{title}</strong>
    {detail&&<span>{detail}</span>}
    {children}
  </div>
}

/** 简洁二级详情里的小标签行（不制造大灰卡）。 */
export function MetaBadge({children,tone}:{children:ReactNode;tone?:"ok"|"warn"|"accent"}){
  return <span className={`lya-badge${tone?` lya-badge-${tone}`:""}`}>{children}</span>
}
