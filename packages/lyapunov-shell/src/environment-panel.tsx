/**
 * 环境光照面板（「环境」工具里的一节）：HDRI、曝光、IBL 强度、背景、阴影、太阳与昼夜。
 *
 * 为什么是这样一个薄组件：
 *  · **格式不在这里**。组件长什么样、上界多少、昼夜怎么算，全部归 `viewer/environment.ts`；
 *    本文件只读 `SceneViewer.environmentStatus()` 的读数、写 `EnvironmentPatch` 补丁
 *    （两个形状都用 `ReturnType`/`Parameters` 从 Viewer 自己的类型派生，不另抄一份）。
 *  · **不持有第二份状态**。写下去的补丁经 `apply` 交给工作台走既有 `scene_edit`/`scene_mount`
 *    （Agent 用的是同一条命令），读回来的值下一轮轮询就是 Viewer 解析出来的实际值——
 *    面板不做本地持久化，也不"乐观显示"没提交成功的值。
 *  · 滑块的中间值只活在拖动期间：松手/回车/失焦提交一次，提交后即以 Viewer 读数为准。
 */
import {useState} from "react"
import type {SceneViewer} from "@lyapunov/viewer/client"
import type {Translate} from "./entity-editor.tsx"
import {renderControlDiagnostic} from "./render-control-diagnostics.ts"

/** 读数与补丁的形状都从 Viewer 的公开面派生：格式一旦改动，这里编译期就会跟着变。 */
export type EnvironmentStatus=ReturnType<SceneViewer["environmentStatus"]>
export type EnvironmentPatch=Parameters<SceneViewer["composeEnvironment"]>[0]

export interface EnvironmentHdriAsset{resourceId:string;version:number;name:string;mimeType:string}

export interface EnvironmentPanelProps{
 /** Viewer 的实际读数；没有 Viewer（未打开工作区/画布）时缺省。 */
 status?:EnvironmentStatus
 /** 素材库里已登记的 HDRI（按 Viewer 给出的 mimeType 清单筛出，面板不猜扩展名）。 */
 hdris:EnvironmentHdriAsset[]
 hdriBusy:boolean
 readOnly:boolean
 viewerVisible:boolean
 busy:boolean
 apply:(patch:EnvironmentPatch)=>void
 /** 去掉整条环境组件：回到组件出现之前那组内置光照读数。 */
 remove:()=>void
 /** 昼夜播放开关（只动 Viewer 的渲染时钟）。 */
 setPlaying:(playing:boolean)=>void
 /** 背景色（与相机面板同一个 owner：工作台的显示设置）。 */
 color:string
 setColor:(color:string)=>void
 importHdri:(path:string)=>void
 refresh:()=>void
 addAreaLight?:()=>void
 tr:Translate
}

/**
 * 从查看器偏好色生成"场景自带背景色"的初值：偏好色是合法的 `#rrggbb`/`#rgb` 就用它，
 * 否则给一个明确的起步色——初值必须是组件能接受的形状，否则勾上复选框也不会生效（解析会忽略它并记警告）。
 */
function sceneColorSeed(value:string):string{
 if(/^#[0-9a-fA-F]{6}$/.test(value))return value.toLowerCase()
 if(/^#[0-9a-fA-F]{3}$/.test(value))return `#${[...value.slice(1)].map(ch=>ch+ch).join("")}`.toLowerCase()
 return "#000000"
}

/** 拖动期间显示草稿值，松手/回车/失焦提交一次；提交后清空草稿，显示回到 Viewer 的实际读数。 */
function Slider({label,value,min,max,step,disabled,onCommit,format}:{label:string;value:number;min:number;max:number;step:number;disabled?:boolean;onCommit:(value:number)=>void;format?:(value:number)=>string}){
 const [draft,setDraft]=useState<string>()
 const shown=draft?.trim()&&Number.isFinite(Number(draft))?Number(draft):value
 const commit=()=>{if(draft===undefined)return;const next=draft.trim()?Number(draft):NaN;setDraft(undefined);if(Number.isFinite(next)&&next!==value)onCommit(next)}
 return <label className="lya-field-label">{label} <span className="lya-muted">{format?format(shown):shown.toFixed(2)}</span>
  <input className="lya-wide" type="range" aria-label={label} min={min} max={max} step={step} value={shown} disabled={disabled}
   onChange={event=>setDraft(event.target.value)} onPointerUp={commit} onKeyUp={commit} onBlur={commit}/>
  <input className="lya-wide" type="number" aria-label={`${label} (${min}–${max})`} min={min} max={max} step={step} value={draft??String(value)} disabled={disabled}
   onChange={event=>setDraft(event.target.value)} onBlur={commit} onKeyUp={event=>{if(event.key==="Enter")(event.target as HTMLInputElement).blur()}}/>
 </label>
}

export function EnvironmentPanel({status,hdris,hdriBusy,readOnly,viewerVisible,busy,apply,remove,setPlaying,color,setColor,importHdri,refresh,addAreaLight,tr}:EnvironmentPanelProps){
 const [path,setPath]=useState("")
 const [cycleDraft,setCycleDraft]=useState<string>("")
 const component=status?.component
 const disabled=readOnly||busy||!viewerVisible||!status
 // `locked` 只表达"有/无组件"（`none` 会在 !status 提前 return 后不可达，故不再用它做启用分支的门）：
 // 无组件时 `locked!=="edit"`，启用入口必须可达（N76 修）。
 const locked=component?"edit":"create"
 if(!viewerVisible||!status)return <fieldset className="lya-property-editor"><legend>{tr("光照","Lighting")}</legend>
  <p className="lya-help">{viewerVisible?tr("打开一个场景后这里显示并控制环境光照（HDRI/曝光/太阳/昼夜）。","Open a scene to see and control its lighting (HDRI, exposure, sun, day/night)."):tr("Viewer 已关闭，环境光照的读数与提交都不可用。","The viewer is closed, so lighting read-outs and commits are unavailable.")}</p></fieldset>
 const hdri=status.hdri
 const sun=status.sun
 const dayNight=component?.dayNight
 return <>
  <fieldset className="lya-property-editor"><legend>{tr("光照","Lighting")}</legend>
   <div className="lya-row">
    <span className="lya-badge">{status.environmentSource==="hdri"?tr("HDRI 环境光","HDRI lighting"):tr("内置环境光","Built-in lighting")}</span>
    {component&&<span className="lya-badge">{`IBL ${status.environmentIntensity.toFixed(2)} · ${tr("曝光倍率","exposure multiplier")} ${status.exposure.toFixed(2)}`}</span>}
    {!component&&<span className="lya-badge">{tr("未启用环境组件","No environment component")}</span>}
   </div>
   {addAreaLight&&<button disabled={disabled} onClick={addAreaLight}>{tr("添加面积灯","Add area light")}</button>}
   {!component&&<><p className="lya-help">{tr("当前场景没有 environment 组件，读到的就是内置光照（与旧版一致）。启用后会往场景文档里写入一条实体组件，可被 Agent 用 scene_edit 改、也随版本历史回退。","This scene has no environment component, so it reads the built-in lighting (unchanged from before). Enabling writes one entity component into the scene document: agents can change it with scene_edit and it follows scene history.")}</p>
    <div className="lya-row"><button className="lya-primary" disabled={disabled} onClick={()=>apply({})}>{tr("启用环境光照","Enable environment lighting")}</button><button disabled={busy} onClick={refresh}>{tr("刷新素材","Refresh assets")}</button></div></>}
   {component&&<>
    <label className="lya-field-label">{tr("色调映射","Tone mapping")}<select className="lya-wide" aria-label={tr("色调映射","Tone mapping")} value={component.toneMapping} disabled={disabled} onChange={event=>apply({toneMapping:event.target.value as EnvironmentPatch["toneMapping"]})}>
     <option value="aces">ACES Filmic</option><option value="agx">AgX</option><option value="neutral">Neutral</option><option value="linear">{tr("线性","Linear")}</option><option value="none">{tr("无映射","None")}</option>
    </select></label>
    <div className="lya-row"><button disabled={disabled} onClick={()=>apply({toneMapping:"agx",exposure:1,environmentIntensity:1,hemisphereIntensity:0,sun:{intensity:0}})}>{tr("AgX 中性起点","AgX neutral starting point")}</button></div>
    <p className="lya-help">{tr("中性起点使用 AgX、曝光倍率 1、IBL 1，并关闭半球补光和太阳；可继续选择 HDRI。曝光 1 对应 0 EV。材质与光照仍由当前实时渲染器计算。","The starting point uses AgX, exposure 1, IBL 1 and no hemisphere fill or sun. Choose an HDRI as needed. Exposure 1 equals 0 EV; this realtime renderer calculates the result.")}</p>
    <Slider label={tr("曝光倍率（1 = 0 EV）","Exposure multiplier (1 = 0 EV)")} value={component.exposure} min={0} max={8} step={0.05} disabled={disabled||component.toneMapping==="none"} onCommit={value=>apply({exposure:value})}/>
    {component.toneMapping==="none"&&<p className="lya-help">{tr("无映射模式不应用曝光倍率。","None tone mapping does not apply the exposure multiplier.")}</p>}
    <Slider label={tr("环境光强（IBL）","Environment intensity (IBL)")} value={component.environmentIntensity} min={0} max={8} step={0.05} disabled={disabled} onCommit={value=>apply({environmentIntensity:value})}/>
    <Slider label={tr("半球补光","Hemisphere fill")} value={component.hemisphereIntensity} min={0} max={8} step={0.1} disabled={disabled} onCommit={value=>apply({hemisphereIntensity:value})}/>
    <label><input type="checkbox" checked={component.shadows} disabled={disabled} onChange={event=>apply({shadows:event.target.checked})}/>{tr("阴影（太阳投影）","Shadows (sun)")}</label>
    {component.shadows&&<>
     <label className="lya-field-label">{tr("太阳阴影精度","Sun shadow resolution")}<select className="lya-wide" aria-label={tr("太阳阴影精度","Sun shadow resolution")} disabled={disabled} value={component.shadow.mapSize} onChange={event=>apply({shadow:{mapSize:Number(event.target.value) as 512|1024|2048|4096}})}>{[512,1024,2048,4096].map(size=><option key={size} value={size}>{size} × {size}</option>)}</select></label>
     <Slider label={tr("阴影深度偏移","Shadow depth bias")} value={component.shadow.bias} min={-.01} max={.01} step={.0001} disabled={disabled} onCommit={bias=>apply({shadow:{bias}})} format={value=>value.toFixed(4)}/>
     <Slider label={tr("阴影法线偏移（米）","Shadow normal bias (m)")} value={component.shadow.normalBias} min={0} max={1} step={.001} disabled={disabled} onCommit={normalBias=>apply({shadow:{normalBias}})} format={value=>value.toFixed(3)}/>
    </>}
    <div className="lya-row"><button className="lya-chip" disabled={disabled} onClick={remove}>{tr("移除环境组件","Remove environment component")}</button><span className="lya-help">{tr("移除后回到内置光照；HDRI 资源仍留在素材库。","Removing returns to the built-in lighting; the HDRI stays in your library.")}</span></div>
   </>}
  </fieldset>
  {component&&<>
   <fieldset className="lya-property-editor"><legend>{tr("HDRI 环境贴图","HDRI environment map")}</legend>
    {component.environmentRotationDeg.map((value,index)=><Slider key={index} label={tr(`环境方向 ${["X","Y","Z"][index]}（度）`,`Environment ${["X","Y","Z"][index]} rotation (deg)`)} value={value} min={0} max={360} step={1} disabled={disabled} onCommit={next=>{const rotation=[...component.environmentRotationDeg] as [number,number,number];rotation[index]=next;apply({environmentRotationDeg:rotation})}} format={next=>`${next.toFixed(0)}°`}/>)}
    <div className="lya-row"><button disabled={disabled} onClick={()=>apply({environmentRotationDeg:[90,0,0]})}>{tr("Y 向上 HDRI 转 Z 向上","Align Y-up HDRI to Z-up")}</button><button disabled={disabled} onClick={()=>apply({environmentRotationDeg:[0,0,0]})}>{tr("重置环境方向","Reset environment rotation")}</button></div>
    <p className="lya-help">{tr("方向同时作用于环境反射与天空背景；Z 调朝向，X/Y 可对齐原图坐标轴。","Rotation applies to reflections and the sky background together. Z controls yaw; X/Y align the source axes.")}</p>
    <div className="lya-row"><span className="lya-badge">{hdri?(hdri.loaded?tr("已加载","loaded"):hdri.loading?tr("正在加载","loading"):tr("没装上（见下方原因）","not applied (see reason)")):tr("未设置，用内置环境光","Not set, built-in lighting")}</span>{hdri?.size&&<span className="lya-badge">{`${hdri.size[0]}×${hdri.size[1]}`}</span>}{hdri&&!hdri.loaded&&hdri.applied&&<span className="lya-badge">{tr(`画面仍在用 ${hdri.applied.resourceId}@${hdri.applied.version}`,`still showing ${hdri.applied.resourceId}@${hdri.applied.version}`)}</span>}</div>
    {hdri?.uri&&<p className="lya-help" title={hdri.uri}>{hdri.uri}</p>}
    {status.error&&<p className="lya-help lya-error">{status.error}</p>}
    <label className="lya-field-label">{tr("选择已登记 HDRI","Registered HDRI")}
     <select className="lya-wide" aria-label={tr("选择已登记 HDRI","Registered HDRI")} disabled={disabled} value={hdri?`${hdri.resourceId}@${hdri.version}`:""} onChange={event=>{const found=hdris.find(item=>`${item.resourceId}@${item.version}`===event.target.value);apply({hdri:found?{resourceId:found.resourceId,version:found.version}:null})}}>
      <option value="">{tr("（不用 HDRI）","(no HDRI)")}</option>{hdris.map(item=><option key={`${item.resourceId}@${item.version}`} value={`${item.resourceId}@${item.version}`}>{`${item.name} · v${item.version}`}</option>)}
     </select></label>
    {hdris.length===0&&<p className="lya-help">{tr("素材库里还没有 HDRI。用下面的路径导入一个 .hdr/.exr 原件，它会作为普通资源登记。","No HDRI in your library yet. Import a .hdr/.exr original below; it is registered as a normal asset.")}</p>}
    <label className="lya-field-label">{tr("导入 HDRI 原件路径","Import HDRI path")}<input className="lya-wide" aria-label={tr("导入 HDRI 原件路径","Import HDRI path")} placeholder="/path/to/sky.hdr" value={path} onChange={event=>setPath(event.target.value)}/></label>
    <div className="lya-row"><button disabled={readOnly||busy||hdriBusy||!path.trim()} onClick={()=>{importHdri(path.trim());setPath("")}}>{hdriBusy?tr("导入中…","Importing…"):tr("导入并登记","Import asset")}</button><button disabled={busy} onClick={refresh}>{tr("刷新素材","Refresh assets")}</button></div>
   </fieldset>
   <fieldset className="lya-property-editor"><legend>{tr("背景","Background")}</legend>
    <div className="lya-row"><label><input type="radio" name="lya-env-background" checked={component.background==="environment"} disabled={disabled||!hdri} onChange={()=>apply({background:"environment"})}/>{tr("HDRI 天空盒","HDRI skybox")}</label><label><input type="radio" name="lya-env-background" checked={component.background==="color"} disabled={disabled} onChange={()=>apply({background:"color"})}/>{tr("纯色","Solid color")}</label></div>
    {!hdri&&<p className="lya-help">{tr("选了天空盒但没有可用的 HDRI：背景仍是纯色（不猜一张贴图）。","Skybox selected without a usable HDRI: the background stays solid (no guesswork).")}</p>}
    <label><input type="checkbox" aria-label={tr("背景色随场景保存","Save the background color in the scene")} checked={Boolean(component.backgroundColor)} disabled={disabled} onChange={event=>apply({backgroundColor:event.target.checked?sceneColorSeed(status.colorBackground):null})}/>{tr("把纯色背景存进场景（重开/换窗口都一致）","Save the solid background color in the scene")}</label>
    {component.backgroundColor&&<label className="lya-field-label">{tr("场景背景色","Scene background color")}<input type="color" aria-label={tr("场景背景色","Scene background color")} disabled={disabled} value={component.backgroundColor} onChange={event=>apply({backgroundColor:event.target.value})}/></label>}
    <p className="lya-help">{tr(`纯色背景当前生效：${status.colorBackground}（${component.backgroundColor?"来自场景文档":"来自查看器偏好"}）` ,`Effective solid background: ${status.colorBackground} (${component.backgroundColor?"from the scene document":"from the viewer preference"}).`)}</p>
    <label className="lya-field-label">{tr("查看器背景色（场景没存色时用它）","Viewer background color (used when the scene saves none)")}<input type="color" aria-label={tr("背景颜色","Background color")} disabled={readOnly||busy} value={color} onChange={event=>setColor(event.target.value)}/></label>
   </fieldset>
   <fieldset className="lya-property-editor"><legend>{tr("太阳","Sun")}</legend>
    <div className="lya-row"><span className="lya-badge">{sun.source==="dayNight"?tr("由时刻推导","from time of day"):tr("手动方向","manual direction")}</span><span className="lya-badge">{`${sun.azimuthDeg.toFixed(0)}° / ${sun.elevationDeg.toFixed(0)}°`}</span><span className="lya-badge">{`${sun.intensity.toFixed(2)}`}</span></div>
    <Slider label={tr("方位角","Azimuth")} value={sun.azimuthDeg} min={0} max={360} step={1} disabled={disabled||sun.source==="dayNight"} onCommit={value=>apply({sun:{azimuthDeg:value}})} format={value=>`${value.toFixed(0)}°`}/>
    <Slider label={tr("仰角","Elevation")} value={sun.elevationDeg} min={-90} max={90} step={1} disabled={disabled||sun.source==="dayNight"} onCommit={value=>apply({sun:{elevationDeg:value}})} format={value=>`${value.toFixed(0)}°`}/>
    <Slider label={tr("太阳强度","Sun intensity")} value={sun.intensity} min={0} max={8} step={0.1} disabled={disabled} onCommit={value=>apply({sun:{intensity:value}})}/>
    {sun.source==="dayNight"&&<p className="lya-help">{tr("昼夜开启时太阳方向由时刻推导（简化模型，不是天文星历），强度在上面的基础上乘以日照系数。","With day/night on, the sun direction comes from the time of day (a simplified model, not an ephemeris); the intensity above is scaled by the daylight factor.")}</p>}
   </fieldset>
   <fieldset className="lya-property-editor"><legend>{tr("昼夜","Day and night")}</legend>
    <label><input type="checkbox" checked={component.dayNight.enabled} disabled={disabled} onChange={event=>apply({dayNight:{enabled:event.target.checked}})}/>{tr("启用连续昼夜","Continuous day/night")}</label>
    <Slider label={tr("静态时刻（小时，保存的配置）","Static time of day (hours, saved)")} value={component.dayNight.timeHours} min={0} max={24} step={0.1} disabled={disabled} onCommit={value=>apply({dayNight:{timeHours:value}})} format={value=>`${value.toFixed(1)} h`}/>
    <label className="lya-field-label">{tr("一昼夜长度（秒）","Seconds per full day")}<input className="lya-wide" type="number" min={5} max={86400} step={1} disabled={disabled} value={cycleDraft||String(component.dayNight.cycleSeconds)} onChange={event=>setCycleDraft(event.target.value)} onBlur={()=>{const value=Number(cycleDraft);setCycleDraft("");if(Number.isFinite(value)&&value>0&&value!==component.dayNight.cycleSeconds)apply({dayNight:{cycleSeconds:value}})}} onKeyUp={event=>{if(event.key==="Enter")(event.target as HTMLInputElement).blur()}}/></label>
    <div className="lya-row"><button className="lya-chip lya-chip-accent" disabled={disabled||!component.dayNight.enabled} onClick={()=>setPlaying(!status.clock.playing)}>{status.clock.playing?tr("停止播放","Stop"):tr("播放昼夜","Play")}</button><button className="lya-chip" disabled={disabled} onClick={()=>apply({dayNight:{timeHours:12}})}>{tr("回到正午","Back to noon")}</button><span className="lya-help">{tr("播放只推进查看器的渲染时钟：物理时间与场景版本都不会变。","Playback only advances the viewer's render clock: neither physics time nor the scene revision changes.")}</span></div>
    <dl className="lya-kv"><dt>{tr("当前时刻","Current time")}</dt><dd>{`${status.timeHours.toFixed(2)} h`}</dd><dt>{tr("渲染时钟","Render clock")}</dt><dd>{`${status.clock.playing?tr("播放中","playing"):tr("已暂停","paused")} · +${status.clock.offsetHours.toFixed(3)} h · ${status.clock.advancedSeconds.toFixed(1)} s`}</dd></dl>
    {!component.dayNight.enabled&&<p className="lya-help">{tr("未启用连续昼夜时，下面的时刻/周期仍会保存，但画面用的是上面手填的太阳方向。","While day/night is off, the time and cycle below are still saved, but the view uses the manual sun direction above.")}</p>}
   </fieldset>
  </>}
  {(status.warnings.length>0||status.ignored.length>0)&&<fieldset className="lya-property-editor"><legend>{tr("文档里的问题","Document issues")}</legend>
   {status.warnings.map(warning=><p className="lya-help" key={warning}>{renderControlDiagnostic(warning,tr)}</p>)}
   {status.ignored.map(item=><p className="lya-help" key={`${item.entityId}:${item.reason}`}>{`${item.entityId}: ${item.reason}`}</p>)}
  </fieldset>}
 </>
}
