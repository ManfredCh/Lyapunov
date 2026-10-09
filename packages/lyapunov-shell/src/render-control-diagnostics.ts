import type { Translate } from "./entity-editor.tsx"

/** 只投影本次新增的渲染诊断；稳定 code、源对象名与参数原值保留，旧诊断不改。 */
export function renderControlDiagnostic(warning: string, tr: Translate): string {
 const found=/(MATERIAL_OVERRIDE_INVALID|MATERIAL_OVERRIDE_CLAMPED|MATERIAL_PBR_UNSUPPORTED|MATERIAL_NORMAL_MAP_MISSING|AREA_SHAPE_RECTANGULAR|ENVIRONMENT_FIELD_DEFAULTED|ENVIRONMENT_FIELD_CLAMPED): (.*)$/.exec(warning)
 if(!found)return warning
 const [,code,body]=found
 let zh:string|undefined,parts:RegExpExecArray|null
 if(code==="MATERIAL_OVERRIDE_INVALID"){
  if(body==="kind must be visual/material-override")zh="kind 必须为 visual/material-override"
  else if((parts=/^(\w+) must be (#rrggbb|a finite number|boolean); ignored$/.exec(body)))zh=`${parts[1]} 必须为${parts[2]==="#rrggbb"?" #rrggbb 颜色":parts[2]==="boolean"?"布尔值":"有限数值"}，已忽略`
 }else if(code==="MATERIAL_OVERRIDE_CLAMPED"&&(parts=/^(\w+) clamped to (\[.*\])$/.exec(body)))zh=`${parts[1]} 已收敛到 ${parts[2]}`
 else if(code==="MATERIAL_PBR_UNSUPPORTED")zh="当前实体没有可覆盖的 PBR 网格材质，参数未生效"
 else if(code==="MATERIAL_NORMAL_MAP_MISSING")zh="源材质没有法线贴图，法线强度未生效"
 else if(code==="AREA_SHAPE_RECTANGULAR"&&(parts=/^(.*?) uses a rectangular emitter in the viewer; area lights do not cast shadows$/.exec(body)))zh=`${parts[1]} 在查看器使用矩形辐射面；面积灯不投射阴影`
 else if(code==="ENVIRONMENT_FIELD_DEFAULTED"){
  if(body==="shadow must be an object; using defaults")zh="shadow 必须为对象，使用默认值"
  else if(body==="toneMapping is unsupported; using aces")zh="toneMapping 不受支持，使用默认 aces"
  else if(body==="shadow.mapSize must be 512/1024/2048/4096; using 512")zh="shadow.mapSize 必须为 512/1024/2048/4096，使用默认 512"
  else if(body==="environmentRotationDeg must be [x,y,z]; using [0,0,0]")zh="environmentRotationDeg 必须为 [x,y,z]，使用默认 [0,0,0]"
  else if((parts=/^((?:shadow\.\w+|environmentRotationDeg\[\d+\])=.*) is not a finite number; using (.*)$/.exec(body)))zh=`${parts[1]} 不是有限数值，使用默认 ${parts[2]}`
 }else if(code==="ENVIRONMENT_FIELD_CLAMPED"&&(parts=/^((?:shadow\.\w+|environmentRotationDeg\[\d+\])=.*) clamped to (\[.*\])$/.exec(body)))zh=`${parts[1]} 已收敛到 ${parts[2]}`
 return zh===undefined?warning:`${warning.slice(0,found.index)}${code}: ${tr(zh,body!)}`
}
