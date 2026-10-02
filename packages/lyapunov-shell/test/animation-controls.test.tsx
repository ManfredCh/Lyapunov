import {expect,test} from 'bun:test'
import {renderToStaticMarkup} from 'react-dom/server'
import {AnimationControls,applyAnimationDisplay,animationDisplayChecked,type AnimationDisplayOwner,type AnimationDisplaySummary} from '../src/animation-controls.tsx'

const reference={entityId:'asset:node:3',ownerEntityId:'asset',verified:true,visualPreview:false,physicsSynchronized:false as const}
const summary=():AnimationDisplaySummary=>({entities:1,clips:2,names:['Walk','Idle'],staticReferences:[{...reference}],visualWarnings:[{entityId:reference.entityId,warning:'ANIMATION_STATIC_REFERENCE: 静态碰撞保持源参考姿态'}]})
test('静态参考实际暂停时checkbox不假显示播放，summary真实warning可见',()=>{
 const facts=summary(),html=renderToStaticMarkup(<AnimationControls summary={facts} requested={true} tr={cn=>cn} change={()=>{}}/>)
 expect(animationDisplayChecked(facts,true)).toBe(false);expect(html).toContain('仅视觉试播（碰撞不变）');expect(html).not.toContain('checked=""');expect(html).toContain(facts.visualWarnings![0]!.warning)
 facts.staticReferences[0]!.visualPreview=true
 expect(renderToStaticMarkup(<AnimationControls summary={facts} requested={true} tr={cn=>cn} change={()=>{}}/>)).toContain('checked=""')
 expect(animationDisplayChecked(facts,false)).toBe(false)
})
test('init/effect true不给授权；真实用户change才给flag，false也不授权',()=>{
 const calls:Array<{playing:boolean;options?:{allowStaticReferencePreview?:boolean}}>=[],facts=summary()
 const owner:AnimationDisplayOwner={setAnimationsPlaying(playing,options){calls.push({playing,options});if(!playing)facts.staticReferences[0]!.visualPreview=false;else if(options?.allowStaticReferencePreview===true)facts.staticReferences[0]!.visualPreview=true;return {entities:1,clips:2}},animationSummary:()=>structuredClone(facts)}
 expect(animationDisplayChecked(applyAnimationDisplay(owner,true),true)).toBe(false)
 expect(calls[0]!.options).toBeUndefined()
 expect(animationDisplayChecked(applyAnimationDisplay(owner,true,true),true)).toBe(true)
 expect(calls[1]!.options).toEqual({allowStaticReferencePreview:true})
 expect(animationDisplayChecked(applyAnimationDisplay(owner,true),true)).toBe(true)
 expect(animationDisplayChecked(applyAnimationDisplay(owner,false,true),false)).toBe(false)
 expect(calls[3]!.options).toBeUndefined()
})
test('普通动画保requested行为，未知/无clips不显示假播放；混合静态未全授权不勾选',()=>{
 const facts=summary();facts.staticReferences=[]
 expect(animationDisplayChecked(facts,true)).toBe(true);expect(animationDisplayChecked(facts,false)).toBe(false)
 expect(renderToStaticMarkup(<AnimationControls summary={facts} requested={true} tr={cn=>cn} change={()=>{}}/>)).toContain('烘焙动画')
 expect(animationDisplayChecked(undefined,true)).toBe(false);expect(animationDisplayChecked({...facts,clips:0},true)).toBe(false)
 expect(animationDisplayChecked({...facts,staticReferences:[{...reference,visualPreview:true},{...reference,entityId:'second'}]},true)).toBe(false)
})
