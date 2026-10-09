import { useState } from "react"
import type { SceneViewer } from "@lyapunov/viewer/client"
import type { Translate } from "./entity-editor.tsx"
import { renderControlDiagnostic } from "./render-control-diagnostics.ts"

export type MaterialStatus = ReturnType<SceneViewer["materialStatus"]>
export type MaterialPatch = Parameters<SceneViewer["composeMaterial"]>[1]

/** 草稿仅在当前输入中；回车/失焦提交一次，读回数值仍来自 Viewer。空白不转成 0。 */
export function MaterialNumber({label,value,min=0,max,step=.01,disabled,commit}:{label:string;value:number;min?:number;max:number;step?:number;disabled:boolean;commit:(value:number)=>void}){
 const [draft,setDraft]=useState<string>()
 const save=()=>{if(draft===undefined)return;const input=draft.trim()?Number(draft):NaN,next=Math.max(min,Math.min(max,input));setDraft(undefined);if(Number.isFinite(next)&&next!==value)commit(next)}
 return <label className="lya-field-label">{label}<input className="lya-wide" aria-label={label} type="number" min={min} max={max} step={step} value={draft??String(value)} disabled={disabled} onChange={event=>setDraft(event.target.value)} onBlur={save} onKeyUp={event=>{if(event.key==="Enter")(event.target as HTMLInputElement).blur()}}/></label>
}

/** 只控制当前实体已加载的 PBR 网格；原贴图/UV/材质由资源继续持有。 */
export function MaterialPanel({status,busy,readOnly,apply,reset,tr}:{status?:MaterialStatus;busy:boolean;readOnly:boolean;apply:(patch:MaterialPatch)=>void;reset:()=>void;tr:Translate}){
 const first=status?.materials[0], component=status?.component, disabled=busy||readOnly||!status?.loaded||!first
 return <fieldset className="lya-property-editor"><legend>{tr("视觉材质","Visual material")}</legend>
  {!status?.loaded?<p className="lya-help">{tr("等待当前实体的视觉资源加载。","Waiting for this entity's visual resource.")}</p>:!first?<p className="lya-help">{tr("当前实体没有可调的 PBR 网格材质（点云、灯光与非 PBR 材质不适用）。","This entity has no editable PBR mesh materials; splats, lights and non-PBR materials are not supported.")}</p>:<>
   <p className="lya-help">{tr(`当前实体有 ${status.supported} 种 PBR 材质。修改的参数对它们统一覆盖，未修改的参数与原贴图/UV保留；多个实例互不影响。`,`This entity has ${status.supported} PBR materials. Edited fields override them together; other fields, source textures and UVs are preserved. Instances stay independent.`)}</p>
   {status.unsupported>0&&<p className="lya-help">{tr(`${status.unsupported} 种非 PBR 材质保持原样。`,`${status.unsupported} non-PBR materials retain their source values.`)}</p>}
   <label className="lya-field-label">{tr("基础颜色（乘原贴图）","Base color (texture multiplier)")}<input aria-label={tr("基础颜色","Base color")} type="color" value={first.baseColor} disabled={disabled} onChange={event=>apply({baseColor:event.target.value})}/></label>
   <MaterialNumber label={tr("粗糙度","Roughness")} value={first.roughness} max={1} disabled={disabled} commit={roughness=>apply({roughness})}/>
   <MaterialNumber label={tr("金属度","Metalness")} value={first.metalness} max={1} disabled={disabled} commit={metalness=>apply({metalness})}/>
   <label className="lya-field-label">{tr("发光颜色","Emissive color")}<input aria-label={tr("发光颜色","Emissive color")} type="color" value={first.emissive} disabled={disabled} onChange={event=>apply({emissive:event.target.value})}/></label>
   <MaterialNumber label={tr("发光强度","Emissive intensity")} value={first.emissiveIntensity} max={32} step={.1} disabled={disabled} commit={emissiveIntensity=>apply({emissiveIntensity})}/>
   <MaterialNumber label={tr("不透明度","Opacity")} value={first.opacity} max={1} disabled={disabled} commit={opacity=>apply({opacity})}/>
   <label><input aria-label={tr("使用原贴图","Use source textures")} type="checkbox" checked={component?.textures!==false} disabled={disabled||!status.materials.some(material=>material.hasTextures)} onChange={event=>apply({textures:event.target.checked})}/>{tr("使用原贴图","Use source textures")}</label>
   <MaterialNumber label={tr("法线强度倍率","Normal strength multiplier")} value={component?.normalScale??1} max={8} step={.1} disabled={disabled||component?.textures===false||!status.materials.some(material=>material.hasNormalMap)} commit={normalScale=>apply({normalScale})}/>
   {!status.materials.some(material=>material.hasNormalMap)&&<p className="lya-help">{tr("源材质没有法线贴图，法线强度不适用。","The source material has no normal map; normal strength is unavailable.")}</p>}
   {status.supported>1&&<p className="lya-help">{tr("数值显示第一种材质的当前实值；编辑某项后，该项应用到本实体全部 PBR 材质。","Values show the first material's current readings. Editing a field applies it to all PBR materials of this entity.")}</p>}
  </>}
  <button disabled={busy||readOnly||!component&&!status?.declared} onClick={reset}>{tr("重置为原始材质","Reset to source materials")}</button>
  {status?.warnings.map(warning=><p className="lya-help" key={warning}>{renderControlDiagnostic(warning,tr)}</p>)}
 </fieldset>
}
