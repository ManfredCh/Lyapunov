/**
 * P14：批注标记的确认稿几何回归（替换 P8 的"圆弧 + 短圆角矩形尾部"）。
 *
 * 判据：画布 Sprite 贴图与截图像素叠加共用**用户 2026-10-16 确认稿**的那一段单一路径
 * （`note-icon.ts` 的 `NOTE_ICON_PATH`，尾部落在左下 (5,20.5)）；标记按屏幕像素定尺寸，
 * Sprite 中心与贴图绘制的锚点用同一份换算，不再以横向中心/长杆底端为落点。
 * 默认/选中只换填充与外描边颜色；截图叠加保留编号与文字标识，编号落在气泡中心。
 * 只验证几何/绘制调用与尺寸换算，不量真实浏览器像素。
 */
import {afterEach,describe,expect,test} from 'bun:test'
import * as THREE from 'three'
import {ANNOTATION_MARKER_PATH,annotationScreenScale,buildAnnotationMarker,drawAnnotationPins,paintAnnotationMarker,refreshAnnotationMarker,updateAnnotationMarker} from '../src/annotations.ts'
import {NOTE_ICON_ANCHOR_X,NOTE_ICON_ANCHOR_Y,NOTE_ICON_MARKER_FILL,NOTE_ICON_MARKER_FILL_SELECTED,NOTE_ICON_MARKER_STROKE,NOTE_ICON_MARKER_STROKE_SELECTED,NOTE_ICON_PATH,NOTE_ICON_VIEWBOX} from '../../lyapunov-contracts/src/note-icon.ts'

interface DrawCall{op:'fill'|'stroke'|'fillText'|'strokeText'|'translate'|'scale'|'fillRect';d?:string;style?:string;text?:string;x?:number;y?:number;sx?:number;sy?:number;lineWidth?:number;w?:number;h?:number}
class FakePath2D{constructor(public d:string){}}
function recordingContext(calls:DrawCall[]){
 const ctx:any={lineJoin:'',lineCap:'',fillStyle:'',strokeStyle:'',lineWidth:0,font:'',textAlign:'',textBaseline:'',
  save(){},restore(){},setTransform(){},clearRect(){},drawImage(){},
  translate(x:number,y:number){calls.push({op:'translate',x,y})},
  scale(sx:number,sy:number){calls.push({op:'scale',sx,sy})},
  fillRect(x:number,y:number,w:number,h:number){calls.push({op:'fillRect',x,y,w,h})},
  fill(path:any){calls.push({op:'fill',d:path?.d,style:String(this.fillStyle),lineWidth:this.lineWidth})},
  stroke(path:any){calls.push({op:'stroke',d:path?.d,style:String(this.strokeStyle),lineWidth:this.lineWidth})},
  fillText(text:string,x:number,y:number){calls.push({op:'fillText',text,x,y})},
  strokeText(text:string,x:number,y:number){calls.push({op:'strokeText',text,x,y})},
  measureText(text:string){return {width:6*text.length}}}
 return ctx
}
const savedPath2D=Object.getOwnPropertyDescriptor(globalThis,'Path2D')
const savedDocument=Object.getOwnPropertyDescriptor(globalThis,'document')
const savedImage=Object.getOwnPropertyDescriptor(globalThis,'Image')
afterEach(()=>{
 for(const [key,value] of [['Path2D',savedPath2D],['document',savedDocument],['Image',savedImage]] as const){
  if(value)Object.defineProperty(globalThis,key,value);else delete (globalThis as any)[key]
 }
})

/** 用户确认稿逐字节的字面量：独立于实现常量，防止路径被悄悄改动。 */
const CONFIRMED_PATH='M12 3.5a8.5 8.5 0 1 1 0 17H5a1 1 0 0 1-1-1v-7A8.5 8.5 0 0 1 12 3.5Z'

describe('annotation marker geometry',()=>{
 test('确认稿单一路径，工具栏/贴图/PNG 共用同一份且锚点在 (5,20.5)',()=>{
  expect(NOTE_ICON_PATH).toBe(CONFIRMED_PATH)
  expect(ANNOTATION_MARKER_PATH).toBe(CONFIRMED_PATH)
  // 单一路径：只有一个 M 起点、以 Z 闭合；不再有内部文字线与分离的长杆尾部。
  expect((CONFIRMED_PATH.match(/M/g)??[]).length).toBe(1)
  expect(CONFIRMED_PATH.endsWith('Z')).toBe(true)
  expect(NOTE_ICON_VIEWBOX).toBe(24)
  expect(NOTE_ICON_ANCHOR_X).toBe(5)
  expect(NOTE_ICON_ANCHOR_Y).toBe(20.5)
  // 旧几何（三道 path、`Q` 圆角长杆）已不适用。
  expect(CONFIRMED_PATH).not.toContain('Q ')
  expect(CONFIRMED_PATH).not.toContain('M8 9h8')
 })

 test('同一路径用于绘制：填充 + 1.1 单位外描边，默认/选中两套色',()=>{
  ;(globalThis as any).Path2D=FakePath2D
  const calls:DrawCall[]=[];paintAnnotationMarker(recordingContext(calls),10,20,30,false)
  const fill=calls.find(call=>call.op==='fill')!,stroke=calls.find(call=>call.op==='stroke')!
  expect(fill.d).toBe(NOTE_ICON_PATH)
  expect(stroke.d).toBe(NOTE_ICON_PATH)
  expect(fill.style).toBe(NOTE_ICON_MARKER_FILL)
  expect(stroke.style).toBe(NOTE_ICON_MARKER_STROKE)
  expect(stroke.lineWidth).toBeCloseTo(1.1,6)
  expect(calls.some(call=>call.style===NOTE_ICON_MARKER_FILL_SELECTED||call.style===NOTE_ICON_MARKER_STROKE_SELECTED)).toBe(false)
  const selected:DrawCall[]=[];paintAnnotationMarker(recordingContext(selected),0,0,30,true)
  const selectedFill=selected.find(call=>call.op==='fill')!,selectedStroke=selected.find(call=>call.op==='stroke')!
  expect(selectedFill.d).toBe(NOTE_ICON_PATH)
  expect(selectedStroke.d).toBe(NOTE_ICON_PATH)
  expect(selectedFill.style).toBe(NOTE_ICON_MARKER_FILL_SELECTED)
  expect(selectedStroke.style).toBe(NOTE_ICON_MARKER_STROKE_SELECTED)
  // 原黄色长杆/断圆头的强调色彻底退场。
  expect(selected.some(call=>call.style==='#ffd34d'||call.style==='#4fb3ff')).toBe(false)
 })

 test('三维标记贴图用同一路径，尾部落点与 Sprite 中心同锚点',()=>{
  ;(globalThis as any).Path2D=FakePath2D
  const calls:DrawCall[]=[];const ctx=recordingContext(calls)
  ;(globalThis as any).document={createElement:()=>({width:0,height:0,getContext:()=>ctx})}
  const entry=buildAnnotationMarker({annotationId:'note-a',index:1,text:'',anchor:{entityId:'e',local:[0,0,0],world:[0,0,0]}})
  expect(entry.badge.material.depthTest).toBe(false) // 同一确认稿完整覆盖物体表面，不被切成折角
  const translates=calls.filter(call=>call.op==='translate')
  // 贴图绘制的第一个 translate 是锚点像素位置，第二个把 viewBox 里的 (5,20.5) 移到原点。
  expect(translates[0]?.x).toBeGreaterThan(0)
  expect(translates[1]!.x).toBeCloseTo(-NOTE_ICON_ANCHOR_X,6)
  expect(translates[1]!.y).toBeCloseTo(-NOTE_ICON_ANCHOR_Y,6)
  // Sprite.center 与贴图锚点逐像素一致（y 轴从画布底往上），不再固定横向中心。
  expect(entry.badge.center.x).toBeCloseTo(translates[0]!.x!/entry.badgeCanvas.width,6)
  expect(1-entry.badge.center.y).toBeCloseTo(translates[0]!.y!/entry.badgeCanvas.height,6)
  expect(entry.badge.center.x).not.toBeCloseTo(0.5,2)
  expect(calls.some(call=>call.d===NOTE_ICON_PATH)).toBe(true)
  calls.length=0
  refreshAnnotationMarker(entry,1,true)
  expect(calls.find(call=>call.op==='fill')?.style).toBe(NOTE_ICON_MARKER_FILL_SELECTED)
 })

 test('截图叠加复用同一路径并保留编号/文字标识，编号落在气泡中心',async()=>{
  ;(globalThis as any).Path2D=FakePath2D
  const calls:DrawCall[]=[];const ctx=recordingContext(calls)
  ;(globalThis as any).document={createElement:()=>({width:0,height:0,getContext:()=>ctx,toDataURL:()=>'data:image/png;base64,FAKE'})}
  class FakeImage{naturalWidth=200;naturalHeight=100;onload:any;onerror:any;set src(_value:string){this.onload?.()}get src(){return ''}}
  ;(globalThis as any).Image=FakeImage
  const result=await drawAnnotationPins('data:image/png;base64,AAA',[{index:3,point:[50,40],text:'tighten here'}],1)
  expect(result).toBe('data:image/png;base64,FAKE')
  expect(calls.some(call=>call.d===NOTE_ICON_PATH)).toBe(true)
  const texts=calls.filter(call=>call.op==='fillText')
  expect(texts.some(call=>call.text==='3')).toBe(true)
  expect(texts.some(call=>call.text==='tighten here')).toBe(true)
  // 编号位置 = 气泡中心：相对锚点 (5,20.5)，viewBox (12,12) 换成像素。
  const shapeUnit=30/NOTE_ICON_VIEWBOX
  const number=texts.find(call=>call.text==='3')!
  expect(number.x).toBeCloseTo(50+(12-NOTE_ICON_ANCHOR_X)*shapeUnit,6)
  expect(number.y).toBeCloseTo(40+(12-NOTE_ICON_ANCHOR_Y)*shapeUnit,6)
  // caption 垫条贴新气泡右缘右侧，保证对白底可读。
  const chip=calls.find(call=>call.op==='fillRect')!
  expect(chip.x!).toBeGreaterThan(50+(20.5-NOTE_ICON_ANCHOR_X)*shapeUnit)
 })

 test('屏幕恒定尺寸：距离越远世界尺寸越大，且与距离成正比',()=>{
  const camera=new THREE.PerspectiveCamera(50,1,0.1,1000)
  const near=annotationScreenScale(1,camera,800),far=annotationScreenScale(10,camera,800)
  expect(far).toBeGreaterThan(near)
  expect(far/near).toBeCloseTo(10,4)
 })
})


test('远景气泡本体按可见屏幕区域命中同一批注，退出批注模式停止拾取',()=>{
 ;(globalThis as any).Path2D=FakePath2D
 ;(globalThis as any).document={createElement:()=>({width:0,height:0,getContext:()=>recordingContext([])})}
 const entry=buildAnnotationMarker({annotationId:'note-screen',index:1,text:'',anchor:{entityId:'e',local:[0,0,0],world:[0,0,0]}})
 const camera=new THREE.PerspectiveCamera(50,1,.1,10000);camera.position.set(0,0,1000);camera.lookAt(0,0,0);camera.updateMatrixWorld(true)
 updateAnnotationMarker(entry,new THREE.Vector3(),camera,800,true);entry.marker.updateMatrixWorld(true)
 const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2(8/400,10/400),camera)
 expect(ray.intersectObjects([entry.pick],false)).toHaveLength(0)
 expect(ray.intersectObjects([entry.badge],false)[0]?.object.userData.annotationId).toBe('note-screen')
 updateAnnotationMarker(entry,new THREE.Vector3(),camera,800,false)
 expect(ray.intersectObjects([entry.badge,entry.pick],false)).toHaveLength(0)
})
