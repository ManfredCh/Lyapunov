import type { SceneLight } from "../../viewer/src/scene-light.ts"
import type { Translate } from "./entity-editor.tsx"
import { MaterialNumber } from "./material-panel.tsx"

/** 选中原 Scene light 实体时编辑同一组件，不写临时 Viewer 参数。 */
export function SceneLightPanel({light,disabled,apply,tr}:{light:SceneLight;disabled:boolean;apply:(light:SceneLight)=>void;tr:Translate}){
 const kind=light.kind??"point",color=light.color??[1,1,1],direction=light.direction??[0,0,-1]
 const patch=(changes:Partial<SceneLight>)=>apply({...light,...changes})
 const vector=(key:"color"|"direction",index:number,value:number)=>{const next=[...(key==="color"?color:direction)];next[index]=value;patch({[key]:next})}
 return <fieldset className="lya-property-editor"><legend>{tr("场景灯光","Scene light")}</legend>
  <label className="lya-field-label">{tr("灯光类型","Light type")}<select className="lya-wide" aria-label={tr("灯光类型","Light type")} disabled={disabled} value={kind} onChange={event=>patch({kind:event.target.value})}>
   <option value="area">{tr("矩形面积灯","Rectangular area")}</option><option value="point">{tr("点光源","Point")}</option><option value="spot">{tr("聚光灯","Spot")}</option><option value="sun">{tr("平行光","Sun")}</option>
  </select></label>
  <MaterialNumber label={tr("灯光能量参数","Light energy input")} value={light.energy??1} max={1000000} step={1} disabled={disabled} commit={energy=>patch({energy})}/>
  {color.slice(0,3).map((value,index)=><MaterialNumber key={index} label={tr(`光色 ${["R","G","B"][index]}（线性）`,`Light ${["R","G","B"][index]} (linear)`)} value={value} max={1} disabled={disabled} commit={next=>vector("color",index,next)}/>)}
  {kind==="area"&&<>
   <MaterialNumber label={tr("面光宽度（米）","Area width (m)")} value={light.widthM??light.sizeM??1} min={.001} max={1000} step={.1} disabled={disabled} commit={widthM=>patch({widthM})}/>
   <MaterialNumber label={tr("面光高度（米）","Area height (m)")} value={light.heightM??light.sizeYM??light.widthM??light.sizeM??1} min={.001} max={1000} step={.1} disabled={disabled} commit={heightM=>patch({heightM})}/>
   <p className="lya-help">{tr("面积灯是矩形辐射面，不投射阴影。能量使用当前实时渲染器的功率参数，与 Blender 瓦数不直接等同。","Area lights emit from a rectangle and do not cast shadows. Energy uses this realtime renderer's power parameter; it is not directly equal to Blender watts.")}</p>
   {direction.slice(0,3).map((value,index)=><MaterialNumber key={index} label={tr(`照射方向 ${["X","Y","Z"][index]}（世界）`,`Emission ${["X","Y","Z"][index]} (world)`)} value={value} min={-1} max={1} step={.1} disabled={disabled} commit={next=>vector("direction",index,next)}/>)}
   <button disabled={disabled||!light.direction} onClick={()=>{const next={...light};delete next.direction;apply(next)}}>{tr("用对象旋转定向","Use entity rotation")}</button>
  </>}
 </fieldset>
}
