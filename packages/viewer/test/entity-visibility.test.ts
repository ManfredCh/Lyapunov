import {describe,expect,test} from "bun:test"
import * as THREE from "three"
import {TransformControls} from "three/addons/controls/TransformControls.js"
import {SceneViewer} from "../src/index.ts"
import {FrameProjection} from "../src/projection.ts"
import {SCENE_COORDINATES,identityTransform,type Entity,type SceneSnapshot} from "../../lyapunov-contracts/src/types.ts"

/** 真 setScene/Three 层级，只有资源读取替身；不签 WebGL/GPU 出图。 */
function viewer(){
 const value=Object.create(SceneViewer.prototype) as any
 value.options={onError:(error:Error)=>{throw error}};value.scene=new THREE.Scene();value.objects=new Map();value.mixers=new Map();value.splatRuntime=new Map();value.visualWarnings=new Map();value.loadingErrors=new Map();value.projection=new FrameProjection()
 // Object.create不运行构造字段；保留真实setScene/setCameraRigs路径。
 value.cameraRigs=new Map();value.cameraRigRoot=new THREE.Group();value.scene.add(value.cameraRigRoot)
 value.camera=new THREE.PerspectiveCamera();value.transformControls=new TransformControls(value.camera)
 value.sun=new THREE.DirectionalLight();value.generation=0;value.geometryRevision=0;value.sceneLightsVisible=true
 for(const method of ["setSceneEnvironment","trackAnimation","applyDisplay","updateAnnotationMarkers","syncEnvironmentMap"])value[method]=()=>{}
 let loads=0
 value.loadVisual=async()=>{loads++;return new THREE.Group()}
 return {value,loads:()=>loads}
}
const node=(id:string,parentId?:string):Entity=>({entityId:id,name:id,...parentId?{parentId}:{},transform:identityTransform(),resources:[],components:{visual:{kind:"splat"}}})
const snapshot=(revision:number,entities:Entity[]):SceneSnapshot=>({sceneId:"visibility",revision,coordinates:SCENE_COORDINATES,entities})
const visible=(object:THREE.Object3D)=>{for(let node:THREE.Object3D|null=object;node;node=node.parent)if(!node.visible)return false;return true}

describe("节点显隐独立于资源加载与全局灯开关",()=>{
 test("隐藏/恢复复用同一Loaded与资源，父隐藏作用于子树，原子节点设置保留",async()=>{
  const {value,loads}=viewer(),parent=node("parent"),child=node("child","parent"),other=node("other")
  await value.setScene(snapshot(1,[parent,child,other]))
  expect(loads()).toBe(3)
  const loaded=value.objects.get("parent"),childLoaded=value.objects.get("child")
  await value.setScene(snapshot(2,[{...parent,components:{visual:{kind:"splat",visible:false}}},child,other]))
  expect(value.objects.get("parent")).toBe(loaded);expect(value.objects.get("child")).toBe(childLoaded)
  expect(loads()).toBe(3);expect(visible(childLoaded.group)).toBe(false);expect(visible(value.objects.get("other").group)).toBe(true)
  await value.setScene(snapshot(3,[parent,{...child,components:{visual:{kind:"splat",visible:false}}},other]))
  expect(loads()).toBe(3);expect(visible(loaded.group)).toBe(true);expect(visible(childLoaded.group)).toBe(false)
  await value.setScene(snapshot(4,[parent,child,other]))
  expect(loads()).toBe(3);expect(visible(childLoaded.group)).toBe(true)
  await value.setScene(snapshot(5,[{...parent,transform:{position:[20,30,40],quaternion:[1,0,0,0],scale:[1,1,1]}},child,other]))
  expect(loads()).toBe(3);expect(value.objects.get("parent")).toBe(loaded)
  expect(loaded.group.position.toArray()).toEqual([20,30,40])
  value.options.commitEdit=()=>{}
  value.select("parent");value.select("child")
  expect(value.transformControls.object).toBe(childLoaded.group)
  expect(loads()).toBe(3)
  await value.setScene(snapshot(6,[{...parent,components:{...parent.components,collision:{shape:"box",halfExtents:[1,1,1]}}},child,other]))
  expect(loads()).toBe(3);expect(value.objects.get("parent")).toBe(loaded)
  value.select("parent");expect(value.transformControls.object).toBe(loaded.group)
  await value.setScene(snapshot(7,[{...parent,locked:true},child,other]))
  expect(value.transformControls.object).toBeUndefined();expect(value.transformControls.getHelper().visible).toBe(false)
  await value.setScene(snapshot(8,[parent,child,other]))
  expect(value.transformControls.object).toBe(loaded.group);expect(value.transformControls.getHelper().visible).toBe(true)
  await value.setScene({...snapshot(0,[]),sceneId:"another-scene"})
  expect(value.transformControls.object).toBeUndefined();expect(value.transformControls.getHelper().visible).toBe(false)
 })

 test("资源相关visual改变仍重新加载，排除的只有visible",async()=>{
  const {value,loads}=viewer(),entity=node("asset")
  await value.setScene(snapshot(1,[entity]));expect(loads()).toBe(1)
  await value.setScene(snapshot(2,[{...entity,components:{visual:{kind:"mesh",visible:false}}}]))
  expect(loads()).toBe(2)
  await value.setScene(snapshot(3,[{...entity,components:{visual:{kind:"mesh",visible:true}}}]))
  expect(loads()).toBe(2)
 })

 test("灯同时遵守本节点visible与全局灯设置，父节点依旧控制整个子树",async()=>{
  const {value}=viewer(),parent=node("parent"),light={...node("light","parent"),components:{light:{kind:"point",color:[1,1,1],energy:1},visual:{visible:false}}}
  await value.setScene(snapshot(1,[parent,light]))
  expect(value.objects.get("light").group.visible).toBe(false)
  value.setSceneLights(false);value.setSceneLights(true)
  expect(value.objects.get("light").group.visible).toBe(false)
  await value.setScene(snapshot(2,[{...parent,components:{visual:{kind:"splat",visible:false}}},{...light,components:{...light.components,visual:{visible:true}}}]))
  expect(value.objects.get("light").group.visible).toBe(true)
  expect(visible(value.objects.get("light").group)).toBe(false)
  value.setSceneLights(false);expect(value.objects.get("light").group.visible).toBe(false)
 })
})
