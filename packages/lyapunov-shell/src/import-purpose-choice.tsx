import type {LocalImportPhysicsUsage} from './local-file-import.ts'

/** 只是人类操作草稿；用途真值经scene_import写入Resource，同文件选择/路径/拖入共用。 */
export function ImportPurposeChoice({value,disabled,onChange,tr,compact=false}:{value:LocalImportPhysicsUsage;disabled?:boolean;onChange(value:LocalImportPhysicsUsage):void;tr(zh:string,en:string):string;compact?:boolean}){
 return <div data-testid="import-purpose-choice"><label className="lya-field-label">{tr('网格导入用途','Mesh import purpose')}<select aria-label={tr('网格导入用途','Mesh import purpose')} value={value} disabled={disabled} onChange={event=>onChange(event.target.value as LocalImportPhysicsUsage)}>
  <option value="environment">{tr('环境：固定，保留空间','Environment: fixed, preserve space')}</option>
  <option value="static">{tr('构件：固定','Component: fixed')}</option>
  <option value="dynamic">{tr('物体：可移动','Object: movable')}</option>
 </select></label>{!compact&&<p className="lya-help">{tr('文件选择、本地路径和拖入使用同一用途。物理是否就绪以运行状态为准；点云保持视觉导入，碰撞另行绑定，机器人使用原生本体。','File selection, local paths, and drop share this purpose. Physics readiness is shown by runtime status; point clouds remain visual imports until colliders are bound, and robots use their native models.')}</p>}</div>
}
