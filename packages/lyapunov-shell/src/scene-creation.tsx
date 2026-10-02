import type {SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'
import type {Translate} from './entity-editor.tsx'

export type SceneCreationTemplate='physics-workspace'|'blank'
export interface SceneCreationPort {create(template:SceneCreationTemplate):Promise<SceneSnapshot>;refresh():Promise<unknown>;load(sceneId:string):Promise<unknown>}
/** 场景库与初次空画布共用原命令、刷新、载入顺序；渲染组件不自动创建任何Scene。 */
export async function createSceneFromTemplate(port:SceneCreationPort,template:SceneCreationTemplate){
 const snapshot=await port.create(template)
 await port.refresh();await port.load(snapshot.sceneId)
 return snapshot
}
export function SceneCreationActions({create,disabled,tr,initial=false}:{create:(template:SceneCreationTemplate)=>void;disabled:boolean;tr:Translate;initial?:boolean}){
 return <div className="lya-row" data-testid={initial?'scene-empty-create-actions':'scene-library-create-actions'}>
  <button className={initial?'lya-primary':undefined} disabled={disabled} onClick={()=>create('physics-workspace')}>{initial?tr('创建物理工作区','Create physics workspace'):tr('新建物理场景','New physics scene')}</button>
  <button disabled={disabled} onClick={()=>create('blank')}>{tr('空白制作','Blank scene')}</button>
 </div>
}
