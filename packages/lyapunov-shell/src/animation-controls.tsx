import type {Translate} from './entity-editor.tsx'

export interface AnimationDisplaySummary {
 entities:number;clips:number;names:string[]
 staticReferences:Array<{entityId:string;ownerEntityId:string;verified:boolean;visualPreview:boolean;physicsSynchronized:false}>
 visualWarnings?:Array<{entityId:string;warning:string}>
}
export interface AnimationDisplayOwner {
 setAnimationsPlaying(playing:boolean,options?:{allowStaticReferencePreview?:boolean}):{entities:number;clips:number}
 animationSummary():AnimationDisplaySummary
}
/** 只有真实用户事件授予视觉试播；初始化/显示同步仍由 Viewer 的参考姿态合同决定。 */
export function applyAnimationDisplay(owner:AnimationDisplayOwner,playing:boolean,userChange=false):AnimationDisplaySummary {
 owner.setAnimationsPlaying(playing,userChange&&playing?{allowStaticReferencePreview:true}:undefined)
 return owner.animationSummary()
}
export function animationDisplayChecked(summary:AnimationDisplaySummary|undefined,requested:boolean):boolean {
 if(!summary?.clips||!requested)return false
 return summary.staticReferences.length?summary.staticReferences.every(reference=>reference.visualPreview):requested
}
export function AnimationControls({summary,requested,tr,disabled=false,change}:{summary?:AnimationDisplaySummary;requested:boolean;tr:Translate;disabled?:boolean;change:(playing:boolean)=>void}) {
 const staticReference=Boolean(summary?.staticReferences.length)
 return <span data-testid="animation-display-control"><label title={staticReference?tr('碰撞固定在源参考姿态。明确选择后只试播视觉动画，暂停时恢复参考姿态。','Collision stays at the source reference pose. Explicit playback previews visuals only; pause restores the reference pose.'):tr('播放或暂停文件中的关键帧动画；显示动画不推进物理。','Play or pause the file’s keyframes; visual animation never advances physics.')}><input type="checkbox" aria-label={staticReference?tr('仅视觉试播（碰撞不变）','Visual preview only (collision unchanged)'):tr('烘焙动画','Baked animation')} checked={animationDisplayChecked(summary,requested)} disabled={disabled||!summary?.clips} onChange={event=>change(event.target.checked)}/>{staticReference?tr('仅视觉试播（碰撞不变）','Visual preview only (collision unchanged)'):tr('烘焙动画','Baked animation')}</label>{summary?.visualWarnings?.map(({entityId,warning},index)=><p key={entityId+':'+index} className="lya-help lya-warning" role="status">{warning}</p>)}</span>
}
