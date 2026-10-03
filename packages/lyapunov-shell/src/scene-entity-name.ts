import type {Entity} from '../../lyapunov-contracts/src/types.ts'
import type {Translate} from './entity-editor.tsx'

/** 只投影内置模板的原始默认名；用户修改的名字与普通资产名照原文显示。 */
export function entityDisplayName(entity:Entity,tr:Translate):string{
 const support=entity.components.supportSurface as {source?:string;template?:string}|undefined
 return support?.source==='scene-template'&&support.template==='physics-workspace-v2'&&entity.name==='Infinite ground'?tr('无限地面','Infinite ground'):entity.name
}
