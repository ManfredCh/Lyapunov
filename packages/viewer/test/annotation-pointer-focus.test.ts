/**
 * P8 焦点返修：Viewer 批注左键的"命中才吞默认动作"回归。
 *
 * 真机失败链：点物体落批注 → React 把焦点交给浮条输入框 → 浏览器补发的 mousedown 默认动作
 * 又把焦点落回画布（事件序复现见 `.rc-evidence/p8-focus-fix`）。修复点是：批注左键**真的命中**
 * 标记/表面时对 pointerdown 调 `preventDefault()`，从而不产生那次会抢焦点的 mousedown。
 *
 * 这里用无 WebGL 的 `Object.create(SceneViewer.prototype)` 直接调用产品源码里的
 * `handleAnnotationPointer` / `applyAnnotationHit`（箭头监听器只做一次转发），
 * 钉住三条判据：命中才返回 true、命中才 preventDefault、空白/其它按钮/非批注模式一律不动默认行为。
 * 不冒充真实浏览器像素与真实事件序，那两条由真机验收覆盖。
 */
import {describe,expect,test} from "bun:test"
import {SceneViewer} from "../src/index.ts"
import type {ViewerAnnotationAnchor} from "../src/annotations.ts"

interface ViewerLike{annotating:boolean;transformControls:{axis?:unknown};handleAnnotationPointer(event:PointerEvent):void;applyAnnotationHit(hit:{annotationId:string}|{anchor:ViewerAnnotationAnchor}|undefined):boolean;options:{onAnnotationSelect?:(id:string)=>void;onAnnotationCreate?:(anchor:ViewerAnnotationAnchor)=>void};annotationHitAtPointer?:(x:number,y:number)=>{annotationId:string}|{anchor:ViewerAnnotationAnchor}|undefined}

const anchor:ViewerAnnotationAnchor={entityId:"ent-a",local:[0,0,0],world:[0,0,0],normal:[0,-1,0],sceneId:"scene-a",sceneRevision:1}

function rig(hit:{annotationId:string}|{anchor:ViewerAnnotationAnchor}|undefined,button=0){
 const selects:string[]=[],creates:ViewerAnnotationAnchor[]=[]
 let prevented=false
 const viewer=Object.create(SceneViewer.prototype) as unknown as ViewerLike
 viewer.annotating=true;viewer.transformControls={axis:undefined}
 viewer.options={onAnnotationSelect:id=>selects.push(id),onAnnotationCreate:value=>creates.push(value)}
 viewer.annotationHitAtPointer=()=>hit
 const event={button,clientX:12,clientY:34,preventDefault(){prevented=true}} as unknown as PointerEvent
 return {viewer,event,selects,creates,prevented:()=>prevented}
}

describe("viewer annotation pointer default-action ownership",()=>{
 test("命中标记：交给编辑回调并 preventDefault（不让浏览器把焦点抢回画布）",()=>{
  const {viewer,event,selects,creates,prevented}=rig({annotationId:"note-a"})
  viewer.handleAnnotationPointer(event)
  expect(selects).toEqual(["note-a"]);expect(creates).toEqual([])
  expect(prevented()).toBe(true)
 })

 test("命中表面：落新批注并 preventDefault",()=>{
  const {viewer,event,selects,creates,prevented}=rig({anchor})
  viewer.handleAnnotationPointer(event)
  expect(creates).toEqual([anchor]);expect(selects).toEqual([])
  expect(prevented()).toBe(true)
 })

 test("空白点击：不动回调也不吞默认行为（导航/选择分毫不变）",()=>{
  const {viewer,event,selects,creates,prevented}=rig(undefined)
  viewer.handleAnnotationPointer(event)
  expect(selects).toEqual([]);expect(creates).toEqual([])
  expect(prevented()).toBe(false)
 })

 test("非批注模式/正在拖 gizmo/非左键：完全不处理也不吞默认行为",()=>{
  for(const mutate of [
   (viewer:ViewerLike)=>{viewer.annotating=false},
   (viewer:ViewerLike)=>{viewer.transformControls={axis:"x"}},
  ]){
   const {viewer,event,selects,creates,prevented}=rig({annotationId:"note-a"});mutate(viewer)
   viewer.handleAnnotationPointer(event)
   expect(selects).toEqual([]);expect(creates).toEqual([])
   expect(prevented()).toBe(false)
  }
  const {viewer,event,selects,prevented}=rig({annotationId:"note-a"},2)
  viewer.handleAnnotationPointer(event)
  expect(selects).toEqual([]);expect(prevented()).toBe(false)
 })

 test("applyAnnotationHit 的三态返回值就是 preventDefault 的唯一判据",()=>{
  const {viewer,selects,creates}=rig(undefined)
  expect(viewer.applyAnnotationHit(undefined)).toBe(false)
  expect(selects).toEqual([]);expect(creates).toEqual([])
  expect(viewer.applyAnnotationHit({annotationId:"note-b"})).toBe(true)
  expect(selects).toEqual(["note-b"])
  expect(viewer.applyAnnotationHit({anchor})).toBe(true)
  expect(creates).toEqual([anchor])
 })
})
