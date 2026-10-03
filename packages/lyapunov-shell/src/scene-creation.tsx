import type {SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'
import type {Translate} from './entity-editor.tsx'

export type SceneCreationTemplate='physics-workspace'|'blank'
export interface SceneCreationPort {create(template:SceneCreationTemplate):Promise<SceneSnapshot>;refresh():Promise<unknown>;load(sceneId:string):Promise<{scene?:SceneSnapshot}>;isCurrent?:()=>boolean}
/** 场景库与初次空画布共用原命令、刷新、载入顺序；渲染组件不自动创建任何Scene。 */
export async function createSceneFromTemplate(port:SceneCreationPort,template:SceneCreationTemplate){
 const assertCurrent=()=>{if(port.isCurrent&&!port.isCurrent())throw Error('SCENE_CREATION_SCOPE_CHANGED')}
 assertCurrent()
 const snapshot=await port.create(template)
 assertCurrent();await port.refresh();assertCurrent()
 const loaded=await port.load(snapshot.sceneId)
 assertCurrent()
 if(loaded.scene?.sceneId!==snapshot.sceneId)throw Error(`SCENE_CREATION_NOT_LOADED: ${snapshot.sceneId}`)
 return snapshot
}

/** 场景库和空画布共享一次在途操作；快速连点不能创建多份场景。 */
export function createSceneCreationAction(run:(template:SceneCreationTemplate)=>Promise<SceneSnapshot>){
 let pending:Promise<SceneSnapshot>|undefined
 return (template:SceneCreationTemplate)=>{
  if(pending)return pending
  pending=run(template).finally(()=>{pending=undefined})
  return pending
 }
}
export function SceneCreationActions({create,disabled,busy,tr,initial=false}:{create:(template:SceneCreationTemplate)=>void;disabled:boolean;busy?:SceneCreationTemplate;tr:Translate;initial?:boolean}){
 return <div className="lya-row" aria-busy={Boolean(busy)} data-testid={initial?'scene-empty-create-actions':'scene-library-create-actions'}>
  <button className={initial?'lya-primary':undefined} disabled={disabled||Boolean(busy)} onClick={()=>create('physics-workspace')}>{busy==='physics-workspace'?tr('正在创建…','Creating…'):initial?tr('创建物理工作区','Create physics workspace'):tr('新建物理场景','New physics scene')}</button>
  <button title={tr('只创建编辑场景；首次开始物理时将加入可管理的无限地面。','Create an editing scene. Starting its first physics world adds manageable infinite ground.')} disabled={disabled||Boolean(busy)} onClick={()=>create('blank')}>{busy==='blank'?tr('正在创建…','Creating…'):tr('空白制作','Blank editing scene')}</button>
 </div>
}
