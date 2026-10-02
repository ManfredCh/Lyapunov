import type { ReactNode } from "react"
import type { AssetRecord, BuiltinAssetRecord } from "./workbench-api.ts"
import type { Translate } from "./entity-editor.tsx"
import type {Entity,SceneSnapshot} from "../../lyapunov-contracts/src/types.ts"
import {SceneNodeVisibility,assetSceneInstances,sceneSubtreeIds} from "./scene-node-controls.tsx"
import type {Vec3} from '../../lyapunov-contracts/src/types.ts'

export interface AssetPlacement {resourceId:string;version:number;name:string;alignBottomToSurface:boolean}
/** 只消费资源库的真实解析类型；原生模型按源原点放置，不推测底脚或文件扩展名。 */
export function assetPlacementOf(asset:AssetRecord):AssetPlacement{
 return {resourceId:asset.ref.resourceId,version:asset.ref.version,name:asset.name,alignBottomToSurface:asset.parsed?.kind!=='robot'}
}
export function assetPlacementInput(sceneId:string,asset:AssetPlacement,point:Vec3){
 return {sceneId,resourceId:asset.resourceId,version:asset.version,alignBottomToSurface:asset.alignBottomToSurface,transform:{position:point,quaternion:[0,0,0,1] as [number,number,number,number],scale:[1,1,1] as Vec3}}
}
/** 放置选择属于当前待放实例；组件没有跨取消/Scene/session保留的独立偏好。 */
export function AssetPlacementBar({asset,point,tr,alignment,confirm,cancel}:{asset:AssetPlacement;point?:Vec3;tr:Translate;alignment(value:boolean):void;confirm():void;cancel():void}){
 return <div className="lya-placement-bar" style={{flexWrap:'wrap'}} aria-label={tr('放置素材','Place asset')}>
  <strong title={asset.name}>{asset.name}</strong>
  <label title={tr('模型原点放在点击位置；底面对齐需要可用的模型几何范围。','Model origin goes at the clicked point; bottom alignment requires available model geometry bounds.')}>{tr('放置基准','Placement basis')} <select aria-label={tr('放置基准','Placement basis')} value={asset.alignBottomToSurface?'bottom':'origin'} onChange={event=>alignment(event.target.value==='bottom')}><option value="origin">{tr('模型原点','Model origin')}</option><option value="bottom">{tr('底面对齐','Align bottom')}</option></select></label>
  {point?<span className="lya-placement-point">{point.map(value=>value.toFixed(2)).join(', ')}</span>:<span className="lya-muted">{tr('点击场景选择位置','Click a spot in the scene')}</span>}
  {point&&<button className="lya-primary" onClick={confirm}>{tr('确认放置','Confirm placement')}</button>}<button onClick={cancel}>{tr('取消','Cancel')}</button>
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
  tr: Translate
  scene?: SceneSnapshot
  sceneReadOnly?: boolean
  instances?(asset:AssetRecord):Entity[]
  selectedInstanceId?:string
  selectInstance?(entityId:string):void
  focusInstance?(entityId:string):void
  setInstanceVisible?(entityId:string,visible:boolean):void
  removeInstance?(entityId:string):void
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
  return <section className="lya-library" aria-label={tr("素材库", "Asset library")}>
    <header className="lya-library-heading">
      <div><span className="lya-eyebrow">{tr("可重复使用", "REUSABLE ASSETS")}</span><h3>{tr("你的素材", "Your library")}<span className="lya-count">{p.assets.length}</span></h3></div>
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
    {!p.loading && p.assets.length === 0 ? <div className="lya-library-empty">
      <div className="lya-library-empty-mark"><AssetMark robot={false}/></div>
      <strong>{p.query ? tr("没有找到匹配的素材", "No matching assets") : tr("把第一份素材放进来", "Start your library")}</strong>
      <p>{p.query ? tr("试试其他名称或标签。", "Try another name or tag.") : tr("导入本地模型，或在环境中寻找可用素材。", "Import a local model or find an asset in Environment.")}</p>
      {!p.query && <button className="lya-text-link" onClick={p.browseEnvironment}>{tr("去环境中寻找", "Explore environments")} <span aria-hidden="true">↗</span></button>}
    </div> : <div className="lya-library-list" aria-busy={p.loading}>
      {p.assets.map(asset => <article className="lya-asset-card" data-deleted={Boolean(asset.deletedAt)} key={asset.ref.resourceId + ":" + asset.ref.version}>
        <div className="lya-asset-overview">
          <div className="lya-asset-mark" data-kind={asset.parsed?.kind}><AssetMark robot={asset.parsed?.kind === "robot"}/></div>
          <div className="lya-asset-description"><strong title={asset.name}>{asset.name}</strong><span>{formatOf(asset)}<i aria-hidden="true">·</i>{tr("版本", "Version")} {asset.ref.version}{asset.deletedAt && <em>{tr("回收站", "In trash")}</em>}</span></div>
        </div>
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
    {p.builtin.length > 0 && <div className="lya-builtin" aria-label={tr("内置素材", "Built-in assets")}>
      <div className="lya-panel-title"><strong>{tr("内置素材", "Built-in assets")} {p.builtin.length}</strong></div>
      {(["robot", "background", "object"] as const).map(category => {
        const items = p.builtin.filter(item => item.category === category)
        return items.length > 0 && <BuiltinGroup key={category} category={category} items={items} assets={p.assets} busy={p.builtinBusy} available={p.available} tr={tr} importBuiltin={p.importBuiltin}/>
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
export function DomainAssetList({ domain, assets, builtin, busy, available, canMount, tr, importBuiltin, mount, openLibrary, instanceControls }: {
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
}) {
  const label = domain === "robot" ? tr("机器人库", "Robot library") : domain === "environment" ? tr("环境库", "Environment library") : domain === "scene" ? tr("场景资源", "Scene resources") : tr("小物件库", "Object library")
  const empty = domain === "robot" ? tr("还没有可用的机器人：内置库为空，也没有导入过机器人模型。", "No robots yet: the built-in list is empty and none was imported.")
    : domain === "environment" ? tr("还没有可用的环境：内置库为空，也没有下载过环境素材。", "No environments yet: the built-in list is empty and none was downloaded.")
    : domain === "scene" ? tr("当前库还没有场景资源。拖入场景文件即可导入。","No scene resources yet. Import a scene file to add one.") : tr("还没有可用的小物件：内置库为空，也没有导入过模型。", "No objects yet: the built-in list is empty and no model was imported.")
  const builtinItems = builtin.filter(item => item.category === DOMAIN_BUILTIN_CATEGORY[domain])
  // 回收站里的素材不在这里出现（聚合素材面板仍可按“包括回收站”查看与恢复）。
  const imported = assets.filter(asset => !asset.deletedAt && inAssetDomain(domain, asset))
  return <div className="lya-domain" aria-label={label}>
    <div className="lya-section"><span>{label}</span><span className="lya-section-side">{builtinItems.length + imported.length}</span></div>
    {builtinItems.map(item => <BuiltinAssetRow key={item.assetId} item={item} imported={builtinImported(item, assets)} busy={busy} available={available} tr={tr} importBuiltin={importBuiltin}/>)}
    {imported.map(asset => <div key={asset.ref.resourceId + ":" + asset.ref.version} className="lya-domain-asset"><div className="lya-env-card">
      <span className="lya-env-thumb" aria-hidden="true"><AssetMark robot={asset.parsed?.kind === "robot"}/></span>
      <div className="lya-env-main" title={asset.name}><strong>{asset.name}</strong><span>{tr("已导入", "In library")}{" · "}{tr(`库版本 ${asset.ref.version}`,`Library version ${asset.ref.version}`)}{" · "}{formatOf(asset)}{asset.sizeBytes ? ` · ${formatAssetSize(asset.sizeBytes)}` : ""}</span></div>
      <div className="lya-env-actions"><button className="lya-chip lya-chip-accent" disabled={!canMount} title={tr("点击后在 3D 场景中点选位置", "Click, then pick a spot in the 3D scene")} onClick={() => mount(asset)}>{tr("加入场景", "Add to scene")}</button></div>
    </div>{instanceControls&&<AssetSceneInstances asset={asset} controls={instanceControls} available={available} busy={busy} tr={tr}/>}</div>)}
    {imported.length > 0 && !canMount && <p className="lya-help">{tr("选择可编辑场景后即可加入。", "Choose an editable scene to add these.")}</p>}
    {builtinItems.length === 0 && imported.length === 0 && <p className="lya-help">{empty}</p>}
    {openLibrary && <button className="lya-text-link" onClick={openLibrary}>{tr("在素材库导入本地文件", "Import a local file")} <span aria-hidden="true">↗</span></button>}
  </div>
}
