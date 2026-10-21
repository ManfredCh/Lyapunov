/**
 * Components（R-011）：某个实体**真实部件**的只读目录 + 展示层炸开控件。
 *
 * 边界（本组件明确不做的事）：
 *  · 部件选择/高亮与 Exploded view 都只是**显示层**——不提交 Scene、不写物理 Transform、不改源模型；
 *    从 Viewer 的 `listParts`/`selectPart`/`setPartExplode` 读写的，全部是 Viewer 拥有的真实部件身份与
 *    presentation 偏移（唯一 owner 在 `packages/viewer`）。
 *  · 内部子树提取/换装不在本组件：只显示该部件的能力状态，不提供假的 Attach 成功操作。
 *  · 展示层状态以 Viewer 读数为准（`partExplodeStatus` + `subscribePresentationState`）：外部合拢、
 *    换身份或资源加载完成后，滑杆/按钮/选中会被拉回实际状态，不新增轮询所有者。
 */
import {useEffect,useMemo,useRef,useState} from "react"
import type {ReactNode} from "react"
import type {ViewerPart,ViewerPartSelection} from "@lyapunov/viewer/client"
import type {Translate} from "./entity-editor.tsx"

/** 面板用到的 Viewer 最小面（真实实现是 `packages/viewer/src/index.ts` 的 SceneViewer；测试用替身）。 */
export interface ComponentsViewer {
  listParts(entityId?: string): ViewerPart[]
  selectedPartRef?(): ViewerPartSelection | undefined
  selectPart(entityId: string | undefined, partId: string | undefined): void
  /** 显式观察相机取景；无当前可见几何/身份过期时抛错，不修改装配或炸开状态。 */
  setPartExplode(entityId: string, spread: number): { spread: number; reason?: string }
  restorePartExplode(): void
  partExplodeStatus?(): { entityId?: string; spread: number; reason?: string }
  /** 展示层状态播报（外部合拢/换身份/资源加载完成）；面板据此读回真实 0 状态。 */
  subscribePresentationState?(listener: () => void): () => void
}

export interface ComponentsExtractPrecheck {
  supported: boolean
  selectedBody: string
  selectedBodyParent: string
  subtree: { bodies: string[]; joints: string[]; actuators: string[]; tendons: string[]; equalities: string[]; sensors: string[] }
  remaining: { bodies: string[]; joints: string[]; actuators: string[]; tendons: string[]; equalities: string[]; sensors: string[] }
  crossEdges: Array<{ kind: string; name: string; reason: string }>
  reason?: string
}
/**
 * R-013：Components 的第二动作端口。只做**一个具名 Extract part 入口**：预检按需展开，目标明确时不加长向导。
 * 预检/提取/重组的真实身份与环境由宿主（workbench）补齐；面板不自己编 world/scene/revision/generation，
 * 也不把"可炸开"当成"物理可拆"。
 */
export interface ComponentsExtractionPort {
  /** 本实体真实 nativeBodies（含 root 标记）；只有非根内部 body 才是拆分候选。 */
  bodies?(entityId: string): Promise<Array<{ name: string; root: boolean; parentName?: string }>>
  /** 实体是否已有成对拆分（remaining 侧），用于显示 Reassemble。 */
  pairing?(entityId: string): { operationId: string; partEntityId: string } | undefined
  precheck?(entityId: string, bodyName: string): Promise<ComponentsExtractPrecheck>
  extract?(entityId: string, bodyName: string): Promise<{ remainingEntityId: string; partEntityId: string; sync?: 'SYNCED' | 'REQUIRED'; syncRequired?: boolean; reason?: string }>
  reassemble?(entityId: string): Promise<{ partEntityId: string; sync?: 'SYNCED' | 'REQUIRED'; syncRequired?: boolean; reason?: string }>
}

/**
 * 把提取端口的**对象身份**稳定下来：每次渲染传入最新实现，返回的端口只在挂载时创建一次，内部
 * 调用的是最新一版实现。
 *
 * 为什么必须：宿主（Workbench）里 `describe` 会 setState 触发重渲染；若每次渲染都换新 port，
 * `ComponentsPanel` 的按需预检 effect（依赖 `extraction`）会在 cleanup 里把尚未完成的请求取消，
 * 反复清空 bodies，真机上内部 body 选择框永远不出现。换实体仍由调用方 `key`/`entityId` 触发清理，
 * 不丢身份变化语义。返回值可直接传给 `ComponentsPanel`（测试也用同一 hook，不另造替身路径）。
 */
export function useStableExtractionPort(implementations: Required<ComponentsExtractionPort>): ComponentsExtractionPort {
  const latest = useRef(implementations)
  latest.current = implementations
  return useMemo(() => ({
    bodies: (entityId: string) => latest.current.bodies(entityId),
    pairing: (entityId: string) => latest.current.pairing(entityId),
    precheck: (entityId: string, bodyName: string) => latest.current.precheck(entityId, bodyName),
    extract: (entityId: string, bodyName: string) => latest.current.extract(entityId, bodyName),
    reassemble: (entityId: string) => latest.current.reassemble(entityId),
  }), [])
}

export interface ComponentsPanelProps {
  viewer?: ComponentsViewer
  entityId: string
  entityName: string
  selectedPart?: ViewerPartSelection
  tr: Translate
  viewerVisible: boolean
  onBack: () => void
  extraction?: ComponentsExtractionPort
  /**
   * 真实上下文身份（scene/revision/worldId/worldGeneration）。它变化时只刷新内部 body 与预检；
   * 普通 Frame 轮询不带这一项，因此不会把用户选中的内部 body 或预检结果反复清掉。
   */
  identity?: string
}

export function ComponentsPanel({viewer,entityId,entityName,selectedPart,tr,viewerVisible,onBack,extraction,identity}:ComponentsPanelProps):ReactNode {
  const [spread,setSpread]=useState(0)
  const [blockReason,setBlockReason]=useState<string|undefined>()
  const [revision,setRevision]=useState(0)
  const [bodies,setBodies]=useState<Array<{name:string;root:boolean;parentName?:string}>>([])
  const [extractBody,setExtractBody]=useState<string|undefined>()
  const [extractPrecheck,setExtractPrecheck]=useState<ComponentsExtractPrecheck|undefined>()
  const [extractBusy,setExtractBusy]=useState(false)
  const [extractStatus,setExtractStatus]=useState<string|undefined>()
  const [extractError,setExtractError]=useState<string|undefined>()
  // 换实体就显式合拢（不留"上一个实体的展开态"），并清掉高亮。
  useEffect(()=>{setSpread(0);setBlockReason(undefined);viewer?.restorePartExplode();setRevision(value=>value+1)},[entityId,viewer])
  // 换实体就清掉拆分预检/状态：不把上一个实体的"可拆"读数留给下一个。
  useEffect(()=>{setExtractBody(undefined);setExtractPrecheck(undefined);setExtractStatus(undefined);setExtractError(undefined)},[entityId])
  // 读真实内部 body。`useStableExtractionPort` 让 `extraction` 对象身份稳定，父级 Frame 重渲染不会在 cleanup 里
  // 取消请求；`identity` 只在 scene/revision/worldId/worldGeneration 真实变化时改变，此时刷新 body 与预检，
  // 但**保留**刚得到的 Saved/Native 短反馈，普通 Frame 轮询也不会重置用户选中的内部 body。
  useEffect(()=>{
    let cancelled=false
    setExtractPrecheck(undefined)
    if(extraction?.bodies)extraction.bodies(entityId).then(rows=>{if(cancelled)return;setBodies(rows);setExtractBody(rows.find(row=>!row.root)?.name)}).catch(error=>{if(!cancelled)setExtractError(error instanceof Error?error.message:String(error))})
    else setBodies([])
    return()=>{cancelled=true}
  },[entityId,extraction,identity])
  // Viewer 是展示层状态的唯一 owner：它播报变化时读回实际读数（外部 Restore/换身份/加载完成都在这里对齐）。
  useEffect(()=>{
    if(!viewer?.subscribePresentationState)return
    return viewer.subscribePresentationState(()=>{
      const status=viewer.partExplodeStatus?.()
      setSpread(status?.entityId===entityId?status.spread??0:0)
      setBlockReason(status?.reason)
      setRevision(step=>step+1)
    })
  },[entityId,viewer])
  const parts=viewer?viewer.listParts(entityId):[]
  const active=selectedPart?.entityId===entityId?parts.find(part=>part.entityId===entityId&&part.partId===selectedPart.partId):undefined
  const separable=parts.filter(part=>part.separable).length
  const applySpread=(value:number)=>{
    if(!viewer||!viewerVisible)return
    const result=viewer.setPartExplode(entityId,value)
    setSpread(result.spread);setBlockReason(result.reason);setRevision(step=>step+1)
  }
  const restore=()=>{viewer?.restorePartExplode();setSpread(0);setBlockReason(undefined);setRevision(step=>step+1)}
  const select=(part:ViewerPart)=>{viewer?.selectPart(entityId,part.partId);setRevision(step=>step+1)}
  const candidates=bodies.filter(row=>!row.root)
  const pairing=extraction?.pairing?.(entityId)
  /** 提取/重组的 Saved 短反馈：只有回执明确 `syncRequired=false`/`sync=SYNCED` 才说"原生已就绪"，未读回确认不显示 Verified。 */
  const subtreeStatus=(result:{sync?:'SYNCED'|'REQUIRED';syncRequired?:boolean;reason?:string},what:string):string=>{
    const state=result.syncRequired===true?tr('已保存 · 物理待同步','Saved · Physics sync required'):result.sync==='SYNCED'||result.syncRequired===false?tr('已保存 · 原生已就绪','Saved · Native ready'):tr('已保存','Saved')
    return `${state}：${what}${result.reason?` · ${result.reason}`:''}`
  }
  const runPrecheck=async()=>{
    if(!extraction?.precheck||!extractBody)return
    setExtractBusy(true);setExtractError(undefined);setExtractStatus(undefined)
    try{
      const result=await extraction.precheck(entityId,extractBody)
      setExtractPrecheck(result)
      setExtractStatus(result.supported?tr('预检通过：两侧闭包可严格保全，可提取。','Precheck passed: both sides close cleanly; extraction is available.'):(result.reason??tr('预检未通过；未写入任何内容。','Precheck did not pass; nothing was written.')))
    }catch(error){setExtractError(error instanceof Error?error.message:String(error))}
    finally{setExtractBusy(false)}
  }
  const runExtract=async()=>{
    if(!extraction?.extract||!extractBody)return
    setExtractBusy(true);setExtractError(undefined)
    try{
      const result=await extraction.extract(entityId,extractBody)
      setExtractStatus(subtreeStatus(result,tr(`剩余 ${result.remainingEntityId}，独立件 ${result.partEntityId}`,`remaining ${result.remainingEntityId}, independent part ${result.partEntityId}`)))
      setExtractPrecheck(undefined)
    }catch(error){setExtractError(error instanceof Error?error.message:String(error))}
    finally{setExtractBusy(false)}
  }
  const runReassemble=async()=>{
    if(!extraction?.reassemble)return
    setExtractBusy(true);setExtractError(undefined)
    try{
      const result=await extraction.reassemble(entityId)
      setExtractStatus(subtreeStatus(result,tr(`独立件 ${result.partEntityId} 已移除，原模型引用已恢复`,`independent part ${result.partEntityId} removed and the original model reference restored`)))
      setExtractPrecheck(undefined)
    }catch(error){setExtractError(error instanceof Error?error.message:String(error))}
    finally{setExtractBusy(false)}
  }
  return <div className="lya-components" data-testid="components-panel" data-entity={entityId} data-revision={revision}>
    <div data-testid="components-header">
      <button type="button" className="lya-back" onClick={onBack}>{tr('‹ 返回','‹ Back')}</button>
      <div className="lya-page-head">
        <div className="lya-page-heading"><h2 className="lya-page-title">{tr('部件','Components')}</h2><span className="lya-eyebrow" data-testid="components-entity">{entityName}</span></div>
      </div>
    </div>
    <div data-testid="components-framing">
    </div>
        {!viewer&&<p className="lya-help" data-testid="components-unavailable">{tr('3D 视口尚未就绪，无法读取部件。','The 3D viewport is not ready; components cannot be read.')}</p>}
    {viewer&&parts.length===0&&<p className="lya-help" data-testid="components-empty">{tr('这个实体当前没有可读部件（尚未加载或不含可视节点）。','This entity has no readable components yet (not loaded or no visual nodes).')}</p>}
    {viewer&&parts.length>0&&<>
      <div className="lya-panel-title" title={tr(`可炸开 ${separable} 个`,`${separable} separable`)}><strong>{tr('部件目录','Component tree')} {parts.length}</strong></div>
      <div className="lya-tree" data-testid="components-tree" role="tree">
        {parts.map(part=>{
          const level=Math.max(1,part.path.length)
          const isSelected=part.entityId===selectedPart?.entityId&&part.partId===selectedPart?.partId
          return <div className="lya-tree-row" key={part.partId} role="treeitem" aria-level={level} aria-selected={isSelected} style={{paddingLeft:(level-1)*12}} data-testid={`components-row-${part.partId}`} data-part-id={part.partId} data-entity-id={part.entityId}>
            <button type="button" className="lya-tree-name" title={part.separable?tr('可分离','separable'):tr('不可分离','not separable')} onClick={()=>select(part)}>{isSelected?'◉':'○'} {part.name}</button>
          </div>
        })}
      </div>
      <section aria-label={tr('展开视图','Exploded view')} data-testid="components-exploded-view" style={{display:'grid',gap:8,borderTop:'1px solid var(--lya-panel-divider)',paddingTop:8}}>
        <div className="lya-row" style={{justifyContent:'space-between',minHeight:28}}>
          <span>{tr('展开视图','Exploded view')}</span>
          <button type="button" role="switch" aria-label={tr('展开视图','Exploded view')} aria-checked={spread>0} data-testid="components-explode-toggle" disabled={!viewerVisible||separable===0} onClick={()=>spread>0?restore():applySpread(1)} style={{display:'flex',alignItems:'center',width:28,minHeight:28,padding:0,border:0,background:'transparent'}}>
            <span aria-hidden="true" style={{display:'flex',alignItems:'center',justifyContent:spread>0?'flex-end':'flex-start',boxSizing:'border-box',width:28,height:16,padding:2,borderRadius:8,background:spread>0?'var(--lya-panel-action)':'var(--lya-line-2)'}}><span style={{width:12,height:12,borderRadius:'50%',background:'var(--lya-text)'}}/></span>
          </button>
        </div>
        <div className="lya-row" data-testid="components-spread" style={{flexWrap:'nowrap',minHeight:28}}>
          <input type="range" min={0} max={1} step={0.05} value={spread} disabled={!viewerVisible||separable===0} aria-label={tr('展开比例','Spread')} aria-valuetext={`${Math.round(spread*100)}%`} style={{flex:1,minWidth:0}} onChange={event=>applySpread(Number(event.target.value))}/>
          <span className="lya-help" data-testid="components-spread-value" style={{minWidth:'4ch',textAlign:'right',fontVariantNumeric:'tabular-nums'}}>{Math.round(spread*100)}%</span>
        </div>
        {(blockReason||(!separable&&parts.length>0))&&<p className="lya-help" data-testid="components-explode-blocked">{blockReason??parts.find(part=>part.reason)?.reason??tr('当前没有可分离的部件。','No separable components.')}</p>}
        <p className="lya-help" data-testid="components-display-only">{tr('仅显示，装配不变','Display only · Assembly unchanged')}</p>
        <div className="lya-row" data-testid="components-restore-row">
          <button type="button" className="lya-wide" data-testid="components-restore" disabled={!viewerVisible} onClick={restore}>{tr('恢复视图','Restore view')}</button>
        </div>
      </section>
      <fieldset className="lya-property-editor"><legend>{tr('选中部件','Selected component')}</legend>
        {active
          ?<>
            <p className="lya-selected-name" data-testid="components-selected" data-part-id={active.partId}><strong>{active.name}</strong></p>
            <details className="lya-advanced" data-testid="components-details">
              <summary>{tr('详情','Details')}</summary>
              <dl className="lya-kv">
                <dt>{tr('身份','Identity')}</dt><dd>{active.entityId} / {active.partId}</dd>
                <dt>{tr('路径','Path')}</dt><dd>{active.path.join(' / ')}</dd>
                <dt>{tr('类型','Kind')}</dt><dd>{active.kind}{' · '}{active.granularity==='hierarchy'?tr('层级','hierarchy'):tr('单网格','single')}</dd>
                <dt>{tr('资源','Resource')}</dt><dd>{active.resource??active.resourceSignature}</dd>
                {active.reason&&<><dt>{tr('说明','Note')}</dt><dd>{active.reason}</dd></>}
              </dl>
            </details>
          </>
          :<p className="lya-help" data-testid="components-selected-empty">{tr('在树或画布上选择一个部件。','Select a component in the tree or on the canvas.')}</p>}
      </fieldset>
      {extraction&&<details className="lya-advanced" data-testid="components-extraction"><summary>{tr('部件操作（分离 / 提取 / 重组）','Part actions (extract / reassemble)')}</summary><fieldset className="lya-property-editor"><legend>{tr('内部部件提取','Internal part')}</legend>
        {candidates.length===0&&<p className="lya-help" data-testid="components-extract-unavailable">{pairing?tr('剩余侧当前只有根/世界体，没有其它可拆的内部 body；下方仍可重组已提取的部件。','The remaining side has only the root/world body; the extracted part can still be reassembled below.'):tr('该实体当前没有可拆的真实内部 body（原生描述不可用，或只有根/世界体）。','No extractable internal real body for this entity (native description unavailable, or only the root/world body).')}</p>}
        {candidates.length>0&&<>
          <div className="lya-row">
            <select data-testid="components-extract-body" value={extractBody??''} aria-label={tr('要提取的内部真实 body','Internal real body to extract')} onChange={event=>{setExtractBody(event.target.value);setExtractPrecheck(undefined);setExtractStatus(undefined);setExtractError(undefined)}}>
              {candidates.map(row=><option key={row.name} value={row.name}>{row.name}{row.parentName?` ← ${row.parentName}`:''}</option>)}
            </select>
            <button type="button" data-testid="components-extract-precheck" disabled={extractBusy||!extraction.precheck} onClick={()=>void runPrecheck()}>{tr('预检','Precheck')}</button>
            <button type="button" className="lya-primary" data-testid="components-extract" disabled={extractBusy||!extractPrecheck?.supported||!extraction.extract} onClick={()=>void runExtract()}>{tr('提取部件','Extract part')}</button>
          </div>
          {extractPrecheck&&<details className="lya-advanced" data-testid="components-extract-details">
            <summary>{extractPrecheck.supported?tr('预检详情（可提取）','Precheck details (extractable)'):tr('预检详情（不可提取）','Precheck details (not extractable)')}</summary>
            <dl className="lya-kv">
              <dt>{tr('切口','Cut')}</dt><dd>{extractPrecheck.selectedBody} ← {extractPrecheck.selectedBodyParent||'-'}</dd>
              <dt>{tr('提取侧','Part side')}</dt><dd>{tr('体','bodies')} {extractPrecheck.subtree.bodies.join(', ')||'-'} · {tr('关节','joints')} {extractPrecheck.subtree.joints.join(', ')||'-'} · {tr('驱动','actuators')} {extractPrecheck.subtree.actuators.join(', ')||'-'}</dd>
              <dt>{tr('肌腱/等式/传感','tendon/equality/sensor')}</dt><dd>{[...extractPrecheck.subtree.tendons,...extractPrecheck.subtree.equalities,...extractPrecheck.subtree.sensors].join(', ')||'-'}</dd>
              <dt>{tr('剩余侧','Remaining side')}</dt><dd>{tr('体','bodies')} {extractPrecheck.remaining.bodies.join(', ')||'-'} · {tr('关节','joints')} {extractPrecheck.remaining.joints.join(', ')||'-'} · {tr('驱动','actuators')} {extractPrecheck.remaining.actuators.join(', ')||'-'}</dd>
              {extractPrecheck.crossEdges.length>0&&<><dt>{tr('跨切口引用','Cross-cut references')}</dt><dd>{extractPrecheck.crossEdges.map(edge=>`${edge.kind}:${edge.name} (${edge.reason})`).join('; ')}</dd></>}
            </dl>
          </details>}
        </>}
        {/* Reassemble 只由成对标记决定：remaining 侧只剩 root、没有其它候选内部 body 时，恢复入口仍须可达。 */}
        {pairing&&<div className="lya-row" data-testid="components-reassemble-row"><button type="button" data-testid="components-reassemble" disabled={extractBusy||!extraction.reassemble} onClick={()=>void runReassemble()}>{tr('重组已提取部件','Reassemble extracted part')}</button></div>}
        {(extractStatus||extractError)&&<p className="lya-help" data-testid="components-extract-status">{extractError??extractStatus}</p>}
      </fieldset></details>}
    </>}
  </div>
}
