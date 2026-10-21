import { useState, type ReactNode } from "react"
import type { AssetRecord, BuiltinAssetRecord } from "./workbench-api.ts"
import type { Translate } from "./entity-editor.tsx"
import type {Entity,SceneSnapshot} from "../../lyapunov-contracts/src/types.ts"
import {SceneNodeVisibility,assetSceneInstances,sceneSubtreeIds} from "./scene-node-controls.tsx"
import type {Vec3} from '../../lyapunov-contracts/src/types.ts'
import type {ResourcePhysicsProgress} from './physics-binding-settings.ts'

export interface AssetPlacement {resourceId:string;version:number;name:string;alignBottomToSurface:boolean;nativeUsd?:boolean}
/** 只消费资源库的真实解析类型；原生模型按源原点放置，不推测底脚或文件扩展名。 */
export function assetPlacementOf(asset:AssetRecord):AssetPlacement{
 const nativeUsd=asset.ref.original.mimeType==='model/vnd.usd'
 return {resourceId:asset.ref.resourceId,version:asset.ref.version,name:asset.name,alignBottomToSurface:asset.parsed?.kind!=='robot'&&!nativeUsd,...nativeUsd?{nativeUsd:true}:{}}
}
export function assetPlacementInput(sceneId:string,asset:AssetPlacement,point:Vec3,resolved?:{position:Vec3;quaternion:[number,number,number,number];scale:Vec3}){
 // 预览已按与确认同一份 origin/bottom 换算得到最终 transform；确认时原样提交，避免二次换算错位。
 const transform=resolved??{position:point,quaternion:[0,0,0,1] as [number,number,number,number],scale:[1,1,1] as Vec3}
 return {sceneId,resourceId:asset.resourceId,version:asset.version,alignBottomToSurface:resolved?false:asset.alignBottomToSurface,transform}
}
/** 放置选择属于当前待放实例；组件没有跨取消/Scene/session保留的独立偏好。 */
export function AssetPlacementBar({asset,point,status='idle',reason,tr,alignment,confirm,cancel,confirming}:{asset:AssetPlacement;point?:Vec3;status?:'idle'|'loading'|'ready'|'unavailable';reason?:string;tr:Translate;alignment(value:boolean):void;confirm():void;cancel():void;confirming?:boolean}){
 const stateText=status==='loading'?tr('正在加载真实预览…','Loading real preview…')
  :status==='ready'?tr('预览就绪','Preview ready')
  :status==='unavailable'?tr('预览不可用','Preview unavailable')
  :point?tr('正在准备预览','Preparing preview'):tr('点击场景选择位置','Click a spot in the scene')
 // 设计稿 placement：底部浮条只保留「素材名 · Cancel · Place object」；预览状态与选项收进 ⋯ 折叠。
 return <div className="lya-placement-bar" aria-label={tr('放置素材','Place asset')} role="status" data-testid="asset-placement-bar" data-preview-status={status} title={stateText}>
  <strong title={asset.name}>{asset.name}</strong>
  <span className="lya-spacer"/>
  <button data-testid="asset-placement-cancel" onClick={cancel}>{tr('取消','Cancel')}</button>
  {point&&<button className="lya-primary" data-testid="asset-placement-confirm" disabled={status==='loading'||confirming} onClick={confirm}>{confirming?tr('正在放置…','Placing…'):tr('放置物体','Place object')}</button>}
  <details className="lya-placement-options" data-testid="asset-placement-options">
   <summary aria-label={tr('放置选项','Placement options')} title={tr('放置选项','Placement options')}>⋯</summary>
   <span className="lya-placement-state" data-testid="asset-placement-state">{stateText}</span>
   <label title={tr('模型原点放在点击位置；底面对齐需要可用的模型几何范围。','Model origin goes at the clicked point; bottom alignment requires available model geometry bounds.')}>{tr('放置基准','Placement basis')} <select aria-label={tr('放置基准','Placement basis')} value={asset.alignBottomToSurface?'bottom':'origin'} onChange={event=>alignment(event.target.value==='bottom')}><option value="origin">{tr('模型原点','Model origin')}</option><option value="bottom">{tr('底面对齐','Align bottom')}</option></select></label>
   <span className="lya-placement-point" data-testid="asset-placement-point">{point?point.map(value=>value.toFixed(2)).join(', '):tr('尚未选择位置','No position yet')}</span>
   {reason&&<p className="lya-help lya-error" role="alert">{reason}</p>}
   {asset.nativeUsd&&<p className="lya-help">{tr('原生 USD 默认按源原点放置；启动对应引擎后读取可变形体或粒子状态。','Native USD defaults to its source origin; start the matching engine to read deformable or particle state.')}</p>}
  </details>
 </div>
}

export interface AssetInstanceControls {
 scene?:SceneSnapshot
 sceneReadOnly?:boolean
 selectedInstanceId?:string
 selectInstance?(entityId:string):void
 focusInstance?(entityId:string):void
 setInstanceVisible?(entityId:string,visible:boolean):void
  removeInstance?(entityId:string):void
  /** 沿现有同版本实例打开实际物理面板，显式恢复仍由该面板执行。 */
  recoverPhysics?(asset:AssetRecord):void
}

/** 展示资源派生事实与同版本绑定事实；入库和视觉出现不能充当碰撞就绪。 */
export function AssetPhysicsStatus({asset,controls,available,busy,tr}:{asset:AssetRecord;controls:AssetInstanceControls;available:boolean;busy?:boolean;tr:Translate}){
 const physics=asset.physicalization as ResourcePhysicsProgress|undefined
 if(asset.parsed?.kind!=='mesh'&&asset.parsed?.kind!=='splat'&&!physics)return null
 const instances=assetSceneInstances(controls.scene,asset.ref.resourceId).filter(entity=>entity.resources.some(ref=>ref.resourceId===asset.ref.resourceId&&ref.version===asset.ref.version))
 const bindings=instances.map(entity=>entity.components.physicsBinding as {status?:string;reason?:string}|undefined)
 const status=asset.physicalizationRequest===false?'skipped':physics?.status??'unavailable'
 const title=status==='ok'?tr('资源碰撞派生已完成；实例绑定与世界状态见物理面板','Resource colliders derived; inspect binding and world state in Physics')
  :status==='failed'?tr('碰撞派生失败','Collider derivation failed'):status==='skipped'?tr('已跳过自动碰撞生成','Automatic collider derivation skipped'):status==='pending'?tr('碰撞派生待完成','Collider derivation pending'):tr('尚无碰撞派生回执','No collider derivation receipt')
 const reason=physics?.error??bindings.find(binding=>binding?.status==='BIND_REQUIRED')?.reason
 const recovery=status!=='ok'||bindings.some(binding=>binding?.status!=='BOUND')
 return <div className="lya-help" data-testid="asset-physics-status" data-physics-status={status} role={status==='failed'?'alert':'status'}>
  <strong>{title}</strong>{physics?.usage&&<span> · {physics.usage}</span>}
  {reason&&<p>{reason}</p>}
  {bindings.length>0&&<p>{tr('当前同版本实例：','Current instances of this version: ')}{bindings.map(binding=>binding?.status??tr('尚未绑定','Not bound')).join(' / ')}</p>}
  {instances.length>0&&controls.recoverPhysics?<button type="button" disabled={!available||busy||controls.sceneReadOnly||Boolean(asset.deletedAt)} onClick={()=>controls.recoverPhysics?.(asset)}>{recovery?tr('打开物理面板恢复碰撞','Open Physics to recover colliders'):tr('查看绑定与世界状态','Inspect binding and world state')}</button>:recovery&&!asset.deletedAt?<p>{tr('加入当前场景后，在物理面板显式生成或恢复同版本碰撞；保留已有用途与策略。','Add to the current scene, then explicitly generate or recover this version in Physics; existing usage and strategy are retained.')}</p>:null}
 </div>
}

/** 四个域与聚合素材只读同一 Scene；实例根/旧版本均来自实际资源引用。 */
export function AssetSceneInstances({asset,controls,available,busy,tr}:{asset:AssetRecord;controls:AssetInstanceControls;available:boolean;busy?:boolean;tr:Translate}) {
 const {scene}=controls,instances=assetSceneInstances(scene,asset.ref.resourceId)
 return <div className="lya-asset-scene-instances" data-testid="asset-scene-instances" aria-label={tr("当前场景实例 ","Current scene instances ")+asset.name}>
  <span className={instances.length?"lya-badge lya-badge-ok":"lya-badge"}>{instances.length?tr(`已放置 ${instances.length} 个实例`,`Placed: ${instances.length}`):tr("尚未放入当前场景","Not placed in this scene")}</span>
  {instances.map((entity,index)=><div key={entity.entityId} data-entity-id={entity.entityId}>
   <button type="button" className="lya-tree-name lya-asset-instance-link" style={{width:'100%',minWidth:0,textAlign:'left',marginTop:6}} title={entity.entityId} aria-label={tr("选择场景实例 ","Select scene instance ")+entity.name} aria-pressed={controls.selectedInstanceId!==undefined&&sceneSubtreeIds(scene!,entity.entityId).includes(controls.selectedInstanceId)} disabled={!controls.selectInstance} onClick={()=>controls.selectInstance?.(entity.entityId)}>{entity.name}{instances.length>1?` (${index+1})`:""}<small> · {entity.resources.filter(ref=>ref.resourceId===asset.ref.resourceId).map(ref=>`v${ref.version}`).join(" / ")}</small></button>
   <div className="lya-row">
   <button type="button" className="lya-icon-button" aria-label={tr("定位场景实例 ","Focus scene instance ")+entity.name} disabled={!controls.focusInstance} onClick={()=>controls.focusInstance?.(entity.entityId)}>◎</button>
   <SceneNodeVisibility entity={entity} scene={scene!} tr={tr} disabled={!available||busy||controls.sceneReadOnly||!controls.setInstanceVisible} onChange={visible=>controls.setInstanceVisible?.(entity.entityId,visible)}/>
   <button type="button" aria-label={tr("从场景移除实例 ","Remove scene instance ")+entity.name} disabled={!available||busy||controls.sceneReadOnly||!controls.removeInstance} onClick={()=>controls.removeInstance?.(entity.entityId)}>{tr("从场景移除","Remove from scene")}</button>
   </div>
  </div>)}
 </div>
}

type Props = {
  assets: AssetRecord[]
  builtin: BuiltinAssetRecord[]
  builtinBusy: boolean
  query: string
  loading: boolean
  includeDeleted: boolean
  canMount: boolean
  available: boolean
  importPanel?: ReactNode
  /** 限定到某个业务类别（R-008）：Objects/Environment/Robots 各自的二级“资源管理”只显示本类资源，
   *  但复用同一份 AssetRecord/ResourceLibrary；不传＝聚合视图（回收站仍可按需查看）。 */
  domain?: AssetDomain
  tr: Translate
  scene?: SceneSnapshot
  sceneReadOnly?: boolean
  instances?(asset:AssetRecord):Entity[]
  selectedInstanceId?:string
  selectInstance?(entityId:string):void
  focusInstance?(entityId:string):void
  setInstanceVisible?(entityId:string,visible:boolean):void
  removeInstance?(entityId:string):void
  recoverPhysics?(asset:AssetRecord):void
  setQuery(value: string): void
  setIncludeDeleted(value: boolean): void
  search(): void
  refresh(): void
  mount(asset: AssetRecord): void
  verify(asset: AssetRecord): void
  rename(asset: AssetRecord): void
  toggleDeleted(asset: AssetRecord): void
  importFile(): void
  importBuiltin(asset: BuiltinAssetRecord): void
  browseEnvironment(): void
}

function AssetMark({ robot }: { robot: boolean }) {
  return <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {robot ? <><path d="M12 3v4M7 19v2M17 19v2"/><rect x="4" y="7" width="16" height="12" rx="4"/><path d="M8.5 12h.01M15.5 12h.01M9 15.5h6"/></> : <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></>}
  </svg>
}

function formatOf(asset: AssetRecord) {
  const uri = asset.ref.original.uri.split(/[?#]/)[0] ?? ""
  const extension = uri.match(/\.([a-z0-9]{1,7})$/i)?.[1]
  return extension?.toUpperCase() ?? asset.parsed?.kind?.toUpperCase() ?? "3D"
}

export function formatAssetSize(bytes?: number) {
  if (!bytes) return ""
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB"
}

function truncateMiddle(value: string, max = 72) {
  if (value.length <= max) return value
  const half = Math.floor((max - 1) / 2)
  return value.slice(0, half) + "…" + value.slice(value.length - half)
}

function originLabel(origin: AssetRecord["origin"], tr: Translate) {
  return origin === "builtin" ? tr("内置素材", "Built-in") : origin === "download" ? tr("网络下载", "Downloaded") : origin === "generated" ? tr("生成任务", "Generated") : tr("本地导入", "Imported")
}

/** resourceId（导入时登记的 assetId）或同名素材已存在即视为已导入。 */
const builtinImported = (item: BuiltinAssetRecord, assets: AssetRecord[]) => assets.some(asset => asset.ref.resourceId === item.assetId || asset.name === item.displayName)

/** 内置条目行：入口只有「导入」一种；素材面板的内置分组与三个域面板共用同一行。 */
function BuiltinAssetRow({ item, imported, busy, available, tr, importBuiltin }: { item: BuiltinAssetRecord; imported: boolean; busy: boolean; available: boolean; tr: Translate; importBuiltin(asset: BuiltinAssetRecord): void }) {
  return <div className="lya-env-card">
    <span className="lya-env-thumb" aria-hidden="true"><AssetMark robot={item.category === "robot"}/></span>
    <div className="lya-env-main" title={item.path}><strong>{item.displayName}</strong><span>{item.kind.toUpperCase()}{item.sizeBytes ? ` · ${formatAssetSize(item.sizeBytes)}` : ""}</span></div>
    <div className="lya-env-actions"><button className="lya-chip lya-chip-accent" disabled={imported || busy || !available} onClick={() => importBuiltin(item)}>{imported ? tr("已导入", "Imported") : tr("导入", "Import")}</button></div>
  </div>
}

/** 内置素材按 category 分组；导入动作与域面板完全同一行（builtinImported 判据共享）。 */
function BuiltinGroup({ category, items, assets, busy, available, tr, importBuiltin }: { category: string; items: BuiltinAssetRecord[]; assets: AssetRecord[]; busy: boolean; available: boolean; tr: Translate; importBuiltin(asset: BuiltinAssetRecord): void }) {
  const label = category === "robot" ? tr("机器人", "Robots") : category === "background" ? tr("环境", "Environments") : tr("对象", "Objects")
  return <div className="lya-builtin-group">
    <div className="lya-section"><span>{label}</span><span className="lya-section-side">{items.length}</span></div>
    {items.map(item => <BuiltinAssetRow key={item.assetId} item={item} imported={builtinImported(item, assets)} busy={busy} available={available} tr={tr} importBuiltin={importBuiltin}/>)}
  </div>
}

/** 素材的主路径是复用到场景；维护动作随每个素材按需展开。 */
export function AssetLibraryPanel(p: Props) {
  const { tr } = p
  // 域限定：只按真实 kind/origin 过滤，不复制资源列表；聚合视图（无 domain）保持原样。
  const domainAssets = p.domain ? p.assets.filter(asset => inAssetDomain(p.domain!, asset)) : p.assets
  const domainBuiltin = p.domain ? p.builtin.filter(item => item.category === DOMAIN_BUILTIN_CATEGORY[p.domain!]) : p.builtin
  return <section className="lya-library" aria-label={tr("素材库", "Asset library")} data-domain={p.domain}>
    <header className="lya-library-heading">
      <div><span className="lya-eyebrow">{tr("可重复使用", "REUSABLE ASSETS")}</span><h3>{tr("你的素材", "Your library")}<span className="lya-count">{domainAssets.length}</span></h3></div>
      <button className="lya-icon-button" disabled={p.loading} onClick={p.refresh} aria-label={tr("刷新素材库", "Refresh asset library")} title={tr("刷新素材库", "Refresh asset library")}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.2 6.2A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.8 5.8"/></svg>
      </button>
    </header>
    <p className="lya-library-intro">{tr("素材可以重复加入场景。下方“当前场景图层”管理已放置的实例；回收站只管理素材条目，原文件保留。", "Assets can be reused. Current scene layers controls placed instances; trash manages library entries and preserves original files.")}</p>
    <button className="lya-library-import" disabled={!p.available} onClick={p.importFile}><span aria-hidden="true">＋</span>{tr("导入本地素材", "Import a local asset")}</button>
    {p.importPanel}
    {!p.available && <p className="lya-help">{tr("先在左侧选择工作区，再导入和使用素材。", "Choose a workspace on the left to import and use assets.")}</p>}
    <form className="lya-library-search" onSubmit={event => { event.preventDefault(); p.search() }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
      <input aria-label={tr("搜索资源", "Search assets")} placeholder={tr("搜索名称或标签", "Search name or tag")} value={p.query} onChange={event => p.setQuery(event.target.value)}/>
      <button type="submit" disabled={p.loading} aria-label={tr("搜索素材", "Search assets")}>{tr("搜索", "Find")}</button>
    </form>
    <div className="lya-library-filter"><label><input type="checkbox" checked={p.includeDeleted} onChange={event => p.setIncludeDeleted(event.target.checked)}/>{tr("包括回收站", "Include trash")}</label>{p.loading && <span role="status">{tr("正在读取…", "Loading…")}</span>}</div>
    {!p.loading && domainAssets.length === 0 ? <div className="lya-library-empty">
      <div className="lya-library-empty-mark"><AssetMark robot={false}/></div>
      <strong>{p.query ? tr("没有找到匹配的素材", "No matching assets") : tr("把第一份素材放进来", "Start your library")}</strong>
      <p>{p.query ? tr("试试其他名称或标签。", "Try another name or tag.") : tr("导入本地模型，或在环境中寻找可用素材。", "Import a local model or find an asset in Environment.")}</p>
      {!p.query && <button className="lya-text-link" onClick={p.browseEnvironment}>{tr("去环境中寻找", "Explore environments")} <span aria-hidden="true">↗</span></button>}
    </div> : <div className="lya-library-list" aria-busy={p.loading}>
      {domainAssets.map(asset => <article className="lya-asset-card" data-deleted={Boolean(asset.deletedAt)} key={asset.ref.resourceId + ":" + asset.ref.version}>
        <div className="lya-asset-overview">
          <div className="lya-asset-mark" data-kind={asset.parsed?.kind}><AssetMark robot={asset.parsed?.kind === "robot"}/></div>
          <div className="lya-asset-description"><strong title={asset.name}>{asset.name}</strong><span>{formatOf(asset)}<i aria-hidden="true">·</i>{tr("版本", "Version")} {asset.ref.version}{asset.deletedAt && <em>{tr("回收站", "In trash")}</em>}</span></div>
        </div>
        <AssetPhysicsStatus asset={asset} controls={p} available={p.available} busy={p.loading} tr={tr}/>
        <button className="lya-asset-use" disabled={!p.canMount || Boolean(asset.deletedAt)} title={tr("点击后在 3D 场景中点选位置", "Click, then pick a spot in the 3D scene")} onClick={() => p.mount(asset)}>{tr("加入当前场景", "Add to scene")}<span aria-hidden="true">↗</span></button>
        {!p.canMount && !asset.deletedAt && <p className="lya-asset-requirement">{tr("选择可编辑场景后即可加入。", "Choose an editable scene to add this asset.")}</p>}
        <details className="lya-asset-details"><summary>{tr("信息与管理", "Details & actions")}</summary>
          {asset.tags.length > 0 && <div className="lya-asset-tags">{asset.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
          <dl><dt>{tr("来源文件", "Source file")}</dt><dd>{asset.ref.original.uri}</dd>
            {asset.sizeBytes !== undefined && <><dt>{tr("大小", "Size")}</dt><dd>{formatAssetSize(asset.sizeBytes)}{(asset.parsed?.dependencies?.length ?? 0) > 1 ? tr(`（含 ${asset.parsed!.dependencies!.length} 个依赖文件）`, ` (${asset.parsed!.dependencies!.length} files)`) : ""}</dd></>}
            <dt>{tr("来源", "Origin")}</dt><dd>{originLabel(asset.origin, tr)}</dd>
            <dt>{tr("存储", "Storage")}</dt><dd>{asset.storage === "cas" ? tr("已存副本（内容寻址，原件可移动）", "Stored copy (content-addressed)") : tr("引用原位置", "References original location")}</dd>
            {asset.storedEntryPath && <><dt>{tr("存储路径", "Stored at")}</dt><dd title={asset.storedEntryPath}>{truncateMiddle(asset.storedEntryPath)}</dd></>}
            {asset.folder && <><dt>{tr("文件夹", "Folder")}</dt><dd>{asset.folder}</dd></>}</dl>
          <div className="lya-asset-actions"><button disabled={!p.available||p.loading} onClick={() => p.verify(asset)}>{tr("检查文件", "Check files")}</button><button disabled={!p.available||p.loading} onClick={() => p.rename(asset)}>{tr("重命名", "Rename")}</button><button disabled={!p.available||p.loading} title={tr("只回收或恢复本会话的素材条目，原文件和已放置实例保留。","Trash or restore this session's library entry; originals and placed instances remain.")} onClick={() => p.toggleDeleted(asset)}>{asset.deletedAt ? tr("恢复素材", "Restore") : tr("回收素材条目", "Trash library entry")}</button></div>
        </details>
        <AssetSceneInstances asset={asset} controls={p} available={p.available} busy={p.loading} tr={tr}/>
      </article>)}
    </div>}
    {domainBuiltin.length > 0 && <div className="lya-builtin" aria-label={tr("内置素材", "Built-in assets")}>
      <div className="lya-panel-title"><strong>{tr("内置素材", "Built-in assets")} {domainBuiltin.length}</strong></div>
      {(["robot", "background", "object"] as const).map(category => {
        const items = domainBuiltin.filter(item => item.category === category)
        return items.length > 0 && <BuiltinGroup key={category} category={category} items={items} assets={domainAssets} busy={p.builtinBusy} available={p.available} tr={tr} importBuiltin={p.importBuiltin}/>
      })}
    </div>}
  </section>
}

/** 三个域面板各自的素材归属：机器人 / 小物件 / 世界环境。 */
export type AssetDomain = "robot" | "object" | "environment" | "scene"

/**
 * 素材的域归属：内置条目按 category 分组（DOMAIN_BUILTIN_CATEGORY），已导入素材按解析 kind
 * 判定——splat/source 是世界，robot 是机器人，mesh（含解析信息缺失的导入件）是小物件。
 * 下载来源（环境检索/网络导入）一律归世界域：它是整片环境而不是小摆件。
 */
export function inAssetDomain(domain: AssetDomain, asset: AssetRecord): boolean {
  const kind = asset.parsed?.kind
  const usage=(asset.physicalizationRequest&&asset.physicalizationRequest.usage)||asset.physicalization?.usage
  if(kind!=='robot'&&usage){
    if(domain==='robot')return false
    if(domain==='scene'||domain==='environment')return usage==='environment'
    return usage==='static'||usage==='dynamic'
  }
  if (domain === "scene") return kind === "source" || kind === "splat"
  if (domain === "robot") return kind === "robot"
  if (domain === "environment") return asset.origin === "download" || kind === "splat" || kind === "source"
  return asset.origin !== "download" && (kind === "mesh" || kind === undefined)
}

const DOMAIN_BUILTIN_CATEGORY: Record<AssetDomain, string> = { robot: "robot", object: "object", environment: "background", scene:"scene" }

/**
 * 域面板（机器人/物件/环境）共用的素材列表：内置条目可就地导入，已导入条目可直接加入当前场景。
 * 数据与素材面板同源（同一份 assets/builtin 状态与同一套动作），域面板不是第二份库：
 * 素材面板仍是含来源分组/搜索/回收站的聚合视图，这里只按域取子集。
 */
type DomainAssetListProps = {
  domain: AssetDomain
  assets: AssetRecord[]
  builtin: BuiltinAssetRecord[]
  busy: boolean
  available: boolean
  canMount: boolean
  tr: Translate
  importBuiltin(asset: BuiltinAssetRecord): void
  mount(asset: AssetRecord): void
  /** 次要入口：本地文件导入表单位于聚合素材面板；添加素材的主路径始终是本列表。 */
  openLibrary?: () => void
  instanceControls?: AssetInstanceControls
  /** V8-07：选中资源后再由底部 Place 进入放置；行内不再各放一个主按钮。 */
  selectionMode?: boolean
  selectedKey?: string
  onSelect?(asset: AssetRecord): void
}

export function DomainAssetList(props: DomainAssetListProps & {selectionHeader?: React.ReactNode}) {
  return props.domain === "object" && props.selectionMode
    ? <ObjectAssetPicker {...props}/>
    : <DomainAssetRows {...props}/>
}

function ObjectAssetPicker(props: DomainAssetListProps & {selectionHeader?: React.ReactNode}) {
  const [query, setQuery] = useState("")
  // 设计稿 object-assets：Search assets → Import file → IMPORTED 行。
  return <div className="lya-object-asset-picker">
    <input type="search" className="lya-wide lya-object-asset-search" data-testid="object-asset-search" aria-label={props.tr("搜索资源", "Search assets")} placeholder={props.tr("搜索资源", "Search assets")} value={query} onChange={event => setQuery(event.target.value)}/>
    {props.selectionHeader}
    <DomainAssetRows {...props} query={query}/>
  </div>
}

function DomainAssetRows({ domain, assets, builtin, busy, available, canMount, tr, importBuiltin, mount, openLibrary, instanceControls, selectionMode=false, selectedKey, onSelect, query="" }: DomainAssetListProps & {query?: string}) {
  // 设计稿 object-assets：物件选择页的分组标题是 `IMPORTED` 且不带计数。
  const label = selectionMode && domain === "object" ? tr("已导入", "IMPORTED") : domain === "robot" ? tr("机器人库", "Robot library") : domain === "environment" ? tr("环境库", "Environment library") : domain === "scene" ? tr("场景资源", "Scene resources") : tr("小物件库", "Object library")
  const empty = domain === "robot" ? tr("还没有可用的机器人：内置库为空，也没有导入过机器人模型。", "No robots yet: the built-in list is empty and none was imported.")
    : domain === "environment" ? tr("还没有可用的环境：内置库为空，也没有下载过环境素材。", "No environments yet: the built-in list is empty and none was downloaded.")
    : domain === "scene" ? tr("当前库还没有场景资源。拖入场景文件即可导入。","No scene resources yet. Import a scene file to add one.") : tr("还没有可用的小物件：内置库为空，也没有导入过模型。", "No objects yet: the built-in list is empty and no model was imported.")
  const needle = query.trim().toLowerCase()
  const matches = (values: string[]) => values.some(value => value.toLowerCase().includes(needle))
  const builtinItems = builtin.filter(item => item.category === DOMAIN_BUILTIN_CATEGORY[domain] && matches([item.displayName, item.kind]))
  // 仅过滤当前域的显示，不改资源、版本或外层选择；取消搜索可恢复同一选择。
  const imported = assets.filter(asset => !asset.deletedAt && inAssetDomain(domain, asset) && matches([asset.name, formatOf(asset), ...asset.tags]))
  return <div className="lya-domain" aria-label={label} data-selection-mode={selectionMode||undefined}>
    <div className="lya-section"><span>{label}</span>{!(selectionMode && domain === "object") && <span className="lya-section-side">{builtinItems.length + imported.length}</span>}</div>
    {builtinItems.map(item => <BuiltinAssetRow key={item.assetId} item={item} imported={builtinImported(item, assets)} busy={busy} available={available} tr={tr} importBuiltin={importBuiltin}/>)}
    {imported.map(asset => {const key=`${asset.ref.resourceId}:${asset.ref.version}`,selected=selectionMode&&selectedKey===key;return <div key={key} className="lya-domain-asset" data-selected={selected||undefined}>{selectionMode?<button type="button" className="lya-object-asset-row" aria-label={tr("选择资源 ", "Select asset ")+asset.name} aria-pressed={selected} disabled={!canMount} title={`${asset.name} · ${formatOf(asset)} · ${tr(`库版本 ${asset.ref.version}`,`Library version ${asset.ref.version}`)}`} onClick={()=>onSelect?.(asset)}><AssetMark robot={asset.parsed?.kind === "robot"}/><span className="lya-object-asset-name">{asset.name}</span><span className="lya-object-asset-choice">{selected?tr("已选中","Selected"):tr("选择","Select")}</span></button>:<div className="lya-env-card">
      <span className="lya-env-thumb" aria-hidden="true"><AssetMark robot={asset.parsed?.kind === "robot"}/></span>
      <div className="lya-env-main" title={asset.name}><strong>{asset.name}</strong><span title={tr(`库版本 ${asset.ref.version}`,`Library version ${asset.ref.version}`)}>{formatOf(asset)}{asset.sizeBytes ? ` · ${formatAssetSize(asset.sizeBytes)}` : ""}</span></div>
      <div className="lya-env-actions"><button className="lya-chip lya-chip-accent" disabled={!canMount} title={tr("点击后在 3D 场景中点选位置", "Click, then pick a spot in the 3D scene")} onClick={() => mount(asset)}>{tr("加入场景", "Add to scene")}</button></div>
    </div>}<details className="lya-advanced" data-testid="domain-asset-details"><summary>{asset.physicalization?.status==="pending"?tr("详情 · 碰撞待准备","Details · Colliders pending"):asset.physicalization?.status==="failed"?tr("详情 · 碰撞失败","Details · Collider failed"):tr("详情","Details")}</summary>{selectionMode&&<p className="lya-help">{formatOf(asset)} · {tr(`库版本 ${asset.ref.version}`,`Library version ${asset.ref.version}`)}{asset.sizeBytes?` · ${formatAssetSize(asset.sizeBytes)}`:""}</p>}<AssetPhysicsStatus asset={asset} controls={instanceControls??{}} available={available} busy={busy} tr={tr}/>{instanceControls&&<AssetSceneInstances asset={asset} controls={instanceControls} available={available} busy={busy} tr={tr}/>}</details></div>})}
    {imported.length > 0 && !canMount && <p className="lya-help">{tr("选择可编辑场景后即可加入。", "Choose an editable scene to add these.")}</p>}
    {builtinItems.length === 0 && imported.length === 0 && <p className="lya-help" role="status">{needle?tr("没有匹配的资源", "No matching assets"):empty}</p>}
    {openLibrary && !selectionMode && <button className="lya-text-link" onClick={openLibrary}>{tr("在素材库导入本地文件", "Import a local file")} <span aria-hidden="true">↗</span></button>}
  </div>
}
