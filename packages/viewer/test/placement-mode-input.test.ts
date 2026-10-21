/** R-010：放置是独立输入模式，旧实体gizmo不能抢点或重新挂回。真实Scene零写入由Native路径另验。 */
import {test,expect} from 'bun:test'
import {SceneViewer} from '../src/index.ts'

function fixture(enabled=true){
 const group={},events:string[]=[],viewer=Object.create(SceneViewer.prototype)as any
 const controls={enabled,axis:'X' as string|null,object:group as unknown,detach(){this.object=undefined;this.axis=null;events.push('detach')},attach(value:unknown){this.object=value;events.push('attach')}}
 viewer.transformControls=controls;viewer.selected='a';viewer.objects=new Map([['a',{group}]])
 viewer.snapshot={sceneId:'s',revision:1,entities:[{entityId:'a',name:'A',resources:[],components:{},transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]}}]}
 viewer.options={commitEdit:async()=>{events.push('commit')}};viewer.placing=false;viewer.annotating=false;viewer.transformEditing=true
 return{viewer,controls,events,group}
}

test('进入放置禁用并脱离旧gizmo，清旧axis/down；取消恢复原选择控件，不提交实体',()=>{
 const{viewer,controls,events,group}=fixture()
 viewer.placeDown={x:12,y:24};viewer.setPlacementMode(true)
 expect(controls.enabled).toBe(false);expect(controls.object).toBeUndefined();expect(controls.axis).toBeNull();expect(viewer.placeDown).toBeUndefined()
 viewer.setPlacementMode(false)
 expect(controls.enabled).toBe(true);expect(controls.object).toBe(group);expect(viewer.selected).toBe('a');expect(events).not.toContain('commit')
})

test('放置中选择/场景刷新调用gizmo同步也不能重新挂接；重复进入不丢恢复状态',()=>{
 const{viewer,controls,group,events}=fixture()
 viewer.setPlacementMode(true);viewer.setPlacementMode(true);viewer.syncTransformGizmo()
 expect(controls.enabled).toBe(false);expect(controls.object).toBeUndefined();expect(events).not.toContain('attach')
 viewer.setPlacementMode(false);expect(controls.enabled).toBe(true);expect(controls.object).toBe(group)
})

test('原本禁用的控件退出放置仍禁用，未选实体退出不产生挂接/提交',()=>{
 const{viewer,controls,events}=fixture(false)
 viewer.selected=undefined;viewer.setPlacementMode(true);viewer.setPlacementMode(false)
 expect(controls.enabled).toBe(false);expect(controls.object).toBeUndefined();expect(events).not.toContain('commit');expect(events).not.toContain('attach')
})


test('批注禁用并脱离旧gizmo，刷新不重挂，结束恢复原控件与选择',()=>{
 const{viewer,controls,events,group}=fixture()
 viewer.setAnnotationMode(true);viewer.setAnnotationMode(true);viewer.syncTransformGizmo()
 expect(controls.enabled).toBe(false);expect(controls.object).toBeUndefined();expect(controls.axis).toBeNull()
 viewer.setAnnotationMode(false)
 expect(controls.enabled).toBe(true);expect(controls.object).toBe(group);expect(viewer.selected).toBe('a');expect(events).not.toContain('commit')
})

test('批注和放置短暂交接时，最后一个模式结束才恢复控件；原禁用态保留',()=>{
 for(const first of ['setAnnotationMode','setPlacementMode']){
  const second=first==='setAnnotationMode'?'setPlacementMode':'setAnnotationMode'
  for(const enabled of [true,false]){
   const{viewer,controls,events}=fixture(enabled)
   viewer[first](true);viewer[second](true);viewer[first](false)
   expect(controls.enabled).toBe(false);expect(controls.object).toBeUndefined()
   viewer[second](false);expect(controls.enabled).toBe(enabled);expect(events).not.toContain('commit')
  }
 }
})
