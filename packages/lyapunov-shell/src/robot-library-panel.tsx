/**
 * R-004 / P4：Robots 工具的首屏与实例原子动作。
 *
 * 首屏分三块，先分身份再谈控制：
 *  1. 当前场景的机器人实例（点行进入同栏二级详情）；
 *  2. Robot Library——来自既有 `robot-library` 投影（pack / T0 / ResourceLibrary 的薄投影），
 *     每条显示名称、类别与「模型是否随包提供 / 是否已登记」，动作只有真实的「登记」与「加入场景」；
 *  3. 选中库条目后的来源与模型详情（含许可、体积、DOF、缺项），默认折叠到条目卡里。
 *
 * 这里不新建目录数据库：数据由调用方（workbench）从真实 `GET /robot-library` 读入，
 * 图标/关节数/运行状态一律不猜。导入本地文件走调用方原有的域导入链。
 */
import {useEffect,useState} from 'react'
import type {Entity} from '../../lyapunov-contracts/src/types.ts'
import type {AssetRecord} from './workbench-api.ts'
import type {RobotLibraryRow} from './robot-library.ts'
import {robotLibraryText} from './robot-library-text.ts'
import {WorkbenchIcon} from './vendor/tabler/icons.tsx'
import type {Translate} from './entity-editor.tsx'
import {ListRow,PanelPage,FooterActions} from './panel-chrome.tsx'
import {RobotResourcePreview,type RobotPreviewBytesURL,type RobotPreviewRequest} from './robot-resource-preview.tsx'

export type RobotLibraryTab='builtin'|'imported'

/** 策略摘要只读已登记适配器；飞行控制器类型不能当作 VLA 配置。 */
export function robotPolicyCaption(controller:unknown,tr:Translate):string{
 const adapter=(controller as {policyAdapter?:unknown}|undefined)?.policyAdapter
 return typeof adapter==='string'&&adapter.trim()?adapter:tr('未配置','Not configured')
}

const familyLabel=(value:string):string=>value||'—'
/** 列表副标题只给真实短格式：从原模型入口后缀读，未知时不猜。 */
const formatLabel=(row:RobotLibraryRow):string=>{
 const extension=/^[^?#]+\.([A-Za-z0-9]+)(?:[?#].*)?$/.exec(row.modelPath??'')?.[1]?.toLowerCase()
 const known:Record<string,string>={xml:'MJCF',urdf:'URDF',usd:'USD',usda:'USD',usdc:'USD',glb:'GLB',gltf:'glTF'}
 return extension&&known[extension]?known[extension]:'—'
}

/** 库条目状态：模型是否随包提供、是否已登记进原资源库；全是真实字段，不猜 Ready。 */
export function robotLibraryStatus(row:RobotLibraryRow,tr:Translate):{label:string;tone:'ok'|'accent'|'warn';detail:string}{
  if(row.installed)return {label:tr('已登记','Registered'),tone:'ok',detail:tr('已在原资源库，可加入当前场景','In the resource library; can be added to this scene')}
  if(row.modelPath)return {label:tr('可用','Available'),tone:'accent',detail:tr('模型原件随包提供，登记后即可加入场景','Model bytes are bundled; register, then add to a scene')}
  return {label:tr('模型未随包提供','Model not bundled'),tone:'warn',detail:robotLibraryText('MODEL_NOT_BUNDLED',tr)}
}

export function RobotLibrarySection({tr,rows,rowsBusy,rowsError,query,setQuery,tab,setTab,imported,canMount,available,selectedPackId,onSelectPack,onAdd,onMount,onImport,onRefresh,sessionId,previewRequest,previewBytesURL,previewHost,previewScope}:{
  tr:Translate
  rows:RobotLibraryRow[]
  rowsBusy:boolean
  rowsError:string
  query:string
  setQuery(value:string):void
  tab:RobotLibraryTab
  setTab(value:RobotLibraryTab):void
  imported:AssetRecord[]
  canMount:boolean
  available:boolean
  selectedPackId?:string
  onSelectPack(packId?:string):void
  onAdd(row:RobotLibraryRow):void
  onMount(asset:AssetRecord):void
  onImport():void
  onRefresh():void
  /** 资源详情的只读预览：session + 原生 model-preview RPC/字节路由；缺任一项时如实显示不可用。 */
  sessionId?:string
  previewRequest?:RobotPreviewRequest
  previewBytesURL?:RobotPreviewBytesURL
  /** 真实 Native 主画布宿主；缺省时右栏 220px 回退。 */
  previewHost?:HTMLElement|null
  /** 当前 Session:Scene 座位；切座位销毁预览 Viewer/在途请求。 */
  previewScope?:string
}){
  const filtered=rows.filter(row=>`${row.packId} ${row.family} ${row.source}`.toLowerCase().includes(query.trim().toLowerCase()))
  // 首屏先是可浏览列表；只有用户真正点选条目才进入同栏二级详情。绝不自动选中某个模型，
  // 否则详情卡会被排到 11 行列表之后（真实 1669×942 实测 Add to scene 在 y≈1332，不在首屏）。
  const selected=selectedPackId?rows.find(row=>row.packId===selectedPackId):undefined
  // 二级页绑定"打开时那条 packId"：换选中机型时旧详情立即不再匹配，不会先替新机型加载一次旧页面。
  const [detailPackId,setDetailPackId]=useState<string>()
  useEffect(()=>{setDetailPackId(undefined)},[selected?.packId])
  if(selected&&detailPackId===selected.packId)return <LibraryResourceDetail row={selected} tr={tr} canMount={canMount} available={available} onAdd={onAdd} onBack={()=>{setDetailPackId(undefined);onSelectPack(undefined)}} preview={sessionId&&previewRequest&&previewBytesURL?{request:previewRequest,bytesURL:previewBytesURL,host:previewHost,scopeKey:previewScope}:undefined} poster={previewBytesURL&&selected.previewPath?previewBytesURL(selected.previewPath):undefined}/>
  return <div className="lya-robot-library" data-testid="robot-library">
    <div className="lya-section"><span>{tr('机器人库','Robot Library')}</span><span className="lya-section-side">{tab==='builtin'?rows.length:imported.length}</span></div>
    <div className="lya-segment" role="tablist" aria-label={tr('机器人库分类','Robot library source')}>
      <button role="tab" aria-selected={tab==='builtin'} onClick={()=>setTab('builtin')}>{tr('内置','Built-in')}</button>
      <button role="tab" aria-selected={tab==='imported'} onClick={()=>setTab('imported')}>{tr('已导入','Imported')}</button>
    </div>
    {tab==='builtin'?<>
      <div className="lya-library-search" data-testid="robot-library-search-row">
        <input type="search" aria-label={tr('搜索机器人','Search robots')} placeholder={tr('搜索机器人','Search robots')} value={query} onChange={event=>setQuery(event.target.value)}/>
        <button className="lya-chip" disabled={rowsBusy} onClick={onRefresh} aria-label={tr('刷新机器人库','Refresh robot library')} title={tr('重新读取并登记随包模型','Re-read and register bundled models')}>{rowsBusy?'…':'↻'}</button>
      </div>
      {rowsError&&<p className="lya-error" role="alert">{rowsError}</p>}
      {rows.length===0&&!rowsBusy&&<p className="lya-help">{tr('当前没有可读的机器人库。','No readable robot library.')}</p>}
      <div className="lya-list" data-testid="robot-library-list" role="listbox" aria-label={tr('机器人库条目','Robot library entries')}>
        {filtered.map(row=>{const status=robotLibraryStatus(row,tr)
          return <ListRow key={row.packId} icon="robot" thumb={previewBytesURL&&row.previewPath?previewBytesURL(row.previewPath):undefined} title={row.packId} subtitle={`${familyLabel(row.family)} · ${formatLabel(row)}`} hint={`${familyLabel(row.family)} · ${formatLabel(row)} · ${robotLibraryText(row.control,tr)}`} side={status.label} selected={selected?.packId===row.packId} testId={`robot-library-row-${row.packId}`} onClick={()=>onSelectPack(row.packId)}/>})}
      </div>
      {filtered.length===0&&rows.length>0&&<p className="lya-help">{tr('没有匹配的机型。','No matching robot.')}</p>}
      {/* V5 EN-25：列表保持可见，选中项在底部给主动作；不再用详情卡替换整张清单。 */}
      {selected&&<LibraryModelCard row={selected} tr={tr} canMount={canMount} available={available} onAdd={onAdd} onBack={()=>onSelectPack(undefined)} onDetails={()=>selected&&setDetailPackId(selected.packId)}/>}
      <button type="button" className="lya-wide" disabled={!available} onClick={onImport}>{tr('导入机器人','Import robot')}</button>
    </>:<>
      <div className="lya-row"><button className="lya-chip" disabled={!available} onClick={onImport}>{tr('导入本地文件','Import local file')}</button></div>
      {imported.length===0&&<p className="lya-help" data-testid="robot-library-imported-empty">{tr('还没有导入过机器人模型。','No imported robot models yet.')}</p>}
      <div className="lya-domain" role="listbox" aria-label={tr('已导入机器人','Imported robots')}>
        {imported.map(asset=><div key={asset.ref.resourceId+':'+asset.ref.version} className="lya-env-card">
          <span className="lya-env-thumb" aria-hidden="true"><WorkbenchIcon id="robot" size={18}/></span>
          <span className="lya-env-main" title={asset.name}><strong>{asset.name}</strong><span>{tr('库版本','Library version')} {asset.ref.version}{asset.sizeBytes?` · ${(asset.sizeBytes/1048576).toFixed(2)} MiB`:''}</span></span>
          <button className="lya-chip lya-chip-accent" disabled={!canMount} title={tr('点击后在 3D 场景点选位置','Click, then pick a spot in the 3D scene')} onClick={()=>onMount(asset)}>{tr('加入场景','Add to scene')}</button>
        </div>)}
      </div>
    </>}
  </div>
}

/**
 * 选中条目的底部紧凑卡：只保留资源名、短状态与主动作；完整来源/许可/哈希在具名 Details 二级页。
 * 主动作只走调用方真实的登记/加入回调，禁用原因来自真实字段，不造 Ready。
 */
function LibraryModelCard({row,tr,canMount,available,onAdd,onBack,onDetails}:{row:RobotLibraryRow;tr:Translate;canMount:boolean;available:boolean;onAdd(row:RobotLibraryRow):void;onBack():void;onDetails():void}){
  const status=robotLibraryStatus(row,tr)
  const canRegister=!row.installed&&Boolean(row.modelPath)
  const action=row.installed
    ? <button className="lya-primary" data-testid="robot-library-add" disabled={!canMount} title={canMount?status.detail:tr('先选择可编辑场景','Choose an editable scene first')} onClick={()=>onAdd(row)}>{tr('加入场景','Add to scene')}</button>
    : canRegister
      ? <button className="lya-primary" data-testid="robot-library-register" disabled={!available} onClick={()=>onAdd(row)}>{tr('登记并加入场景','Register, then add')}</button>
      : <button className="lya-primary" disabled title={status.detail}>{tr('模型未随包提供','Model not bundled')}</button>
  return <div className="lya-detail-box lya-library-compact" data-testid="robot-library-detail-card">
    <div className="lya-row">
      <button type="button" className="lya-chip" data-testid="robot-library-back" aria-label={tr('返回列表','Back to list')} title={tr('返回列表','Back to list')} onClick={onBack}>×</button>
      <strong title={row.packId}>{row.packId}</strong><span className="lya-spacer"/><button type="button" className="lya-chip" data-testid="robot-library-details" onClick={onDetails}>{tr('详情','Details')}</button>
    </div>
    <span className="lya-help" title={`${familyLabel(row.family)} · ${robotLibraryText(row.control,tr)}`}>{tr('库模型','Library model')} · {familyLabel(row.family)} · {formatLabel(row)}</span>
    <div className="lya-row" data-testid="robot-library-primary-action">{action}</div>
  </div>
}

/**
 * V8-13 资源二级页：先真实只读模型预览，再短名称/类型/DOF 与 Add to scene；
 * 技术字段、许可、路径、哈希全部默认折叠，列表首屏仍是 V5 紧凑清单。
 * 预览只走宿主既有 model-preview RPC + 原生 Viewer，不写 Scene/selection/world。
 */
function LibraryResourceDetail({row,tr,canMount,available,onAdd,onBack,preview,poster}:{row:RobotLibraryRow;tr:Translate;canMount:boolean;available:boolean;onAdd(row:RobotLibraryRow):void;onBack():void;preview?:{request:RobotPreviewRequest;bytesURL:RobotPreviewBytesURL;host?:HTMLElement|null;scopeKey?:string};poster?:string}){
  const status=robotLibraryStatus(row,tr)
  const canRegister=!row.installed&&Boolean(row.modelPath)
  const action=row.installed
    ? <button className="lya-primary" data-testid="robot-library-add" disabled={!canMount} title={canMount?status.detail:tr('先选择可编辑场景','Choose an editable scene first')} onClick={()=>onAdd(row)}>{tr('加入场景','Add to scene')}</button>
    : canRegister
      ? <button className="lya-primary" data-testid="robot-library-register" disabled={!available} onClick={()=>onAdd(row)}>{tr('登记并加入场景','Register, then add')}</button>
      : <button className="lya-primary" disabled title={status.detail}>{tr('模型未随包提供','Model not bundled')}</button>
  const dof=row.sourceDof!==null?`${row.sourceDof} DOF`:tr('DOF 未知','DOF unknown')
  return <PanelPage className="lya-library-resource-page" title={row.packId} back={tr('‹ 机器人库','‹ Robot Library')} onBack={onBack}>
    <RobotResourcePreview tr={tr} path={row.modelPath??''} identity={row.modelSha256??row.packId} load={preview?.request} bytesURL={preview?.bytesURL} host={preview?.host} scopeKey={preview?.scopeKey} poster={poster}/>
    <div className="lya-row" data-testid="robot-library-resource-summary">
      <div className="lya-help" data-testid="robot-library-resource-short">{familyLabel(row.family)} · {dof} · {formatLabel(row)}</div>
      <span className="lya-spacer"/>
      <span className={`lya-badge${status.tone==='ok'?' lya-badge-ok':status.tone==='accent'?' lya-badge-accent':''}`}>{status.label}</span>
    </div>
    <details className="lya-advanced" data-testid="robot-library-fields" data-default="closed">
      <summary>{tr('模型详情','Model details')}</summary>
      <dl className="lya-kv">
        <dt>{tr('类别','Category')}</dt><dd>{familyLabel(row.family)} · T0 · v{row.version}</dd>
        <dt>{tr('格式','Format')}</dt><dd>{formatLabel(row)}</dd>
        <dt>{tr('控制','Control')}</dt><dd>{robotLibraryText(row.control,tr)} · {row.channels.length?row.channels.join(', '):tr('无声明通道','no declared channels')}</dd>
        <dt>{tr('依赖包体积','Dependency bundle bytes')}</dt><dd>{row.modelBytes===null?tr('未提供或未知','absent or unknown'):(row.modelBytes/1048576).toFixed(2)+' MiB'}</dd>
        <dt>{tr('原模型 DOF / 策略动作维数','Source DOF / policy action dim')}</dt><dd>{row.sourceDof??'—'} / {row.policyDof??'—'}</dd>
      </dl>
      {row.policyDetail&&<p className="lya-help" data-testid="robot-library-policy-detail">{robotLibraryText(row.policyDetail,tr)}</p>}
      {row.gaps.length>0&&<details className="lya-help" data-testid="robot-library-gaps"><summary>{tr('缺项','Gaps')} ({row.gaps.length})</summary><ul>{row.gaps.map((gap,index)=><li key={index}>{robotLibraryText(gap,tr)}</li>)}</ul></details>}
    </details>
    <details className="lya-advanced" data-testid="robot-library-source-license" data-default="closed">
      <summary>{tr('来源与许可','Source & license')}</summary>
      <dl className="lya-kv">
        <dt>{tr('模型许可','Model license')}</dt><dd>{robotLibraryText(row.license,tr)}</dd>
        <dt>{tr('策略许可','Policy license')}</dt><dd>{robotLibraryText(row.policyLicense,tr)}</dd>
        {row.source&&<><dt>{tr('来源','Source')}</dt><dd>{row.source}</dd></>}
        {row.modelPath&&<><dt>{tr('模型入口','Model entry')}</dt><dd><code>{row.modelPath}</code></dd></>}
        {row.modelSha256&&<><dt>SHA-256</dt><dd><code data-testid="robot-library-model-sha">{row.modelSha256}</code></dd></>}
      </dl>
    </details>
    <FooterActions primary={<div data-testid="robot-library-primary-action">{action}</div>}/>
  </PanelPage>
}

/** 当前场景实例：点行进入同栏二级详情；显示真实资源版本与是否已绑定世界。 */
export function RobotInstanceList({tr,instances,selectedId,worldBoundFor,onOpen}:{tr:Translate;instances:Entity[];selectedId?:string;worldBoundFor(entityId:string):boolean;onOpen(entityId:string):void}){
  return <div className="lya-domain" data-testid="robot-instance-list">
    <div className="lya-section"><span>{tr('场景内','In scene')}</span><span className="lya-section-side">{instances.length}</span></div>
    {instances.length===0&&<p className="lya-help" data-testid="robot-instance-empty">{tr('当前场景没有机器人实例。','No robot instances in this scene.')}</p>}
    {instances.map(instance=><div className="lya-tree-row" key={instance.entityId} aria-selected={selectedId===instance.entityId}>
      <button className="lya-tree-name" data-testid={`robot-instance-${instance.entityId}`} title={instance.entityId} onClick={()=>onOpen(instance.entityId)}>⚙ {instance.name}</button>
      <small>{instance.resources.map(ref=>`v${ref.version}`).join(' · ')||tr('无版本引用','no resource version')} · {worldBoundFor(instance.entityId)?tr('已绑定世界','World bound'):tr('未启动世界','World not started')} <span aria-hidden="true">›</span></small>
    </div>)}
  </div>
}

/**
 * R-004 目标级原子动作（完整计划 §2.7）。
 *
 * Start = **仅**启动所选机器人当前已配置的动作（复用现有 RobotControl 目标/最后有效 recipe 的 execute 路径）；
 * 禁止用 `sim_open`/`sim_sync` 的全 world 重建冒充 Start。
 * Stop = 既有 `sim_stop` 的 **entityIds 选择**，只停当前实例，不影响其它机器人。
 * Prepare physics = 单独的准备/同步世界入口（world 准备不是机器人 Start）。
 * Freeze/Restore = 真实目标级原生保持：Freeze 只停止本实例动作并按当前 pose 启用原生约束/关节锁；
 * Restore 只解除本次保持、不自动继续旧动作。禁用整 world 暂停与 Scene 检查点冒充。
 */
export function RobotAtomicActions({tr,entityName,canStart,canStop,canFreeze=false,canRestore=false,onStart,onStop,onFreeze,onRestore,busy,canPrepare=false,onPrepare,prepareBusy,startUnavailableReason,freezeDetail}:{tr:Translate;entityName:string;canStart:boolean;canStop:boolean;canFreeze?:boolean;canRestore?:boolean;onStart():void;onStop():void;onFreeze?():void;onRestore?():void;busy?:boolean;canPrepare?:boolean;onPrepare?():void;prepareBusy?:boolean;startUnavailableReason?:string;freezeDetail?:string}){
  const startTitle=canStart
    ? tr(`启动「${entityName}」当前已配置的动作。`,`Start the action currently configured for ${entityName}.`)
    : startUnavailableReason??tr('当前没有可启动的目标级动作。','No target-level action is currently available to start.')
  return <div className="lya-robot-card lya-robot-atomic" data-testid="robot-atomic-actions">
    {/* 设计稿 robot-policy：底部是 4 个图标按钮（▶ Stop/Reset 形态），文案只留在 aria-label/title。 */}
    <div className="lya-robot-atomic-grid lya-robot-atomic-icons">
      <button className="lya-chip lya-chip-accent" data-testid="robot-start" aria-label={tr('开始','Start')} disabled={!canStart||busy} title={startTitle} onClick={onStart}><span aria-hidden="true">▶</span></button>
      <button className="lya-chip lya-stop" data-testid="robot-stop" aria-label={tr('停止','Stop')} disabled={!canStop||busy} title={tr(`只停止「${entityName}」当前动作，不影响其它机器人。`,`Stop only the current actions of ${entityName}; other robots are unaffected.`)} onClick={onStop}><span aria-hidden="true">■</span></button>
      <button className="lya-chip" data-testid="robot-freeze" aria-label={tr('冻结','Freeze')} disabled={!canFreeze||busy} title={tr(`用引擎原生约束/关节锁把「${entityName}」保持在当前姿态；不暂停整world、不影响其它机器人。`,`Hold ${entityName} at its current pose with native engine constraints/joint locks; the whole world is not paused and other robots are unaffected.`)} onClick={onFreeze}><span aria-hidden="true">◎</span></button>
      <button className="lya-chip" data-testid="robot-restore" aria-label={tr('恢复','Restore')} disabled={!canRestore||busy} title={tr(`解除「${entityName}」本次原生保持；不会自动继续旧动作，重新Start才运动。`,`Release this native hold for ${entityName}; old actions are not resumed, start again to move.`)} onClick={onRestore}><span aria-hidden="true">↺</span></button>
    </div>
    {(canPrepare||prepareBusy)&&<div className="lya-row"><button className="lya-chip" data-testid="robot-prepare-physics" disabled={!canPrepare||busy||prepareBusy} title={tr('按当前场景准备或同步物理世界；这与机器人Start是两个动作。','Prepare or synchronize the physics world for this scene; this is separate from the robot Start action.')} onClick={onPrepare}>{tr('准备物理','Prepare physics')}</button></div>}
    {!canStart&&startUnavailableReason&&<p className="lya-help" data-testid="robot-start-unavailable">{startUnavailableReason}</p>}
    {freezeDetail&&<p className="lya-help" data-testid="robot-freeze-detail">{freezeDetail}</p>}
  </div>
}
