/**
 * V9 显示层修正：地面/网格点状 z-fighting 由网格微抬升 + 只读深度消除，不改 Scene/碰撞；
 * 3D 变换手柄默认收起，只有显式 setTransformEditing(true) 才挂到选中实体。
 */
import {describe,expect,test} from 'bun:test'
import * as THREE from 'three'
import {SceneViewer,applyViewerGridDepthPolicy,VIEWER_GRID_Z_OFFSET_M} from '../src/index.ts'

describe('网格与地面深度冲突（显示层）',()=>{
 test('网格抬起 2mm、后绘制且不写深度；材质本身仍可见，不关闭网格',()=>{
  const grid=new THREE.GridHelper(20,40)
  applyViewerGridDepthPolicy(grid)
  expect(VIEWER_GRID_Z_OFFSET_M).toBe(0.002)
  expect(grid.position.z).toBe(VIEWER_GRID_Z_OFFSET_M)
  expect(grid.renderOrder).toBe(1)
  const materials=Array.isArray(grid.material)?grid.material:[grid.material]
  expect(materials.length).toBeGreaterThan(0)
  for(const material of materials){expect(material.depthWrite).toBe(false);expect(material.visible).not.toBe(false)}
  expect(grid.visible).toBe(true)
 })
})

describe('默认选中只显示细轮廓',()=>{
 const fixture=(editing=false)=>{
  const group={},events:string[]=[],viewer=Object.create(SceneViewer.prototype)as any
  const controls={enabled:true,axis:'X' as string|null,object:group as unknown,detach(){this.object=undefined;this.axis=null;events.push('detach')},attach(value:unknown){this.object=value;events.push('attach')}}
  viewer.transformEditing=editing;viewer.transformControls=controls;viewer.selected='a';viewer.objects=new Map([['a',{group}]])
  viewer.snapshot={sceneId:'s',revision:1,entities:[{entityId:'a',name:'A',resources:[],components:{},transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]}}]}
  viewer.options={commitEdit:async()=>{events.push('commit')}};viewer.placing=false;viewer.annotating=false;viewer.syncObserverControls=()=>{}
  return{viewer,controls,events,group}
 }
 test('默认不挂 TransformControls，但选中状态保留',()=>{
  const{viewer,controls,events}=fixture()
  expect(viewer.transformEditing).toBe(false)
  viewer.syncTransformGizmo()
  expect(controls.object).toBeUndefined()
  expect(viewer.selected).toBe('a')
  expect(events).not.toContain('attach')
 })
 test('显式进入 Move/Rotate/Scale 才显示手柄，退出后脱开，不提交 Scene',()=>{
  const{viewer,controls,events,group}=fixture()
  viewer.setTransformEditing(true)
  expect(controls.object).toBe(group)
  expect(viewer.transformEditingEnabled()).toBe(true)
  viewer.setTransformEditing(false)
  expect(controls.object).toBeUndefined()
  expect(controls.axis).toBeNull()
  expect(viewer.transformEditingEnabled()).toBe(false)
  expect(events).not.toContain('commit')
 })
})
