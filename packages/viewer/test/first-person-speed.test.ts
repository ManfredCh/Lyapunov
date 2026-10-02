import { afterEach, describe, expect, test } from "bun:test"
import * as THREE from "three"
import { FirstPersonNavigation, placeInsideScene } from "../src/first-person.ts"

// 只补画布的事件表面；方向、相机矩阵、位移和归一化均执行真实 three 对象及控制器。
class Canvas extends EventTarget {
  dataset: Record<string,string> = {}
  tabIndex = -1
  isConnected = true
  windowFocused = true
  ownerDocument: { defaultView:EventTarget; activeElement:EventTarget|null; hasFocus:()=>boolean } = { defaultView:new EventTarget(), activeElement:this, hasFocus:()=>this.windowFocused }
  focus() { this.ownerDocument.activeElement=this }
  setPointerCapture() {}
  hasPointerCapture() { return false }
  releasePointerCapture() {}
}

const controllers: FirstPersonNavigation[] = []
afterEach(() => { for (const nav of controllers.splice(0)) nav.dispose() })

function rig(bounds?: THREE.Box3) {
  const canvas = new Canvas(), camera = new THREE.PerspectiveCamera(60,1,.1,1000)
  camera.up.set(0,0,1)
  let target = new THREE.Vector3(0,1,0)
  const view = bounds ? placeInsideScene(camera,bounds) : undefined
  if (view) target = view.target
  else camera.lookAt(target)
  const nav = new FirstPersonNavigation(camera,canvas as unknown as HTMLCanvasElement,target,() => nav.setActive(false))
  if (view) nav.speed = view.speed
  controllers.push(nav)
  nav.setActive(true)
  let time = 1000
  nav.update(time)
  return {
    canvas, camera, target, nav,
    key(type: "keydown" | "keyup", code: string, shiftKey = false, surface: EventTarget = canvas) {
      const event = new Event(type,{cancelable:true})
      Object.defineProperties(event,{
        code:{value:code}, shiftKey:{value:shiftKey},
        ctrlKey:{value:false}, altKey:{value:false}, metaKey:{value:false},
      })
      surface.dispatchEvent(event)
      return event
    },
    advance(seconds = 1) {
      const position = camera.position.clone(), targetBefore = target.clone()
      for (let frame = 0; frame < Math.round(seconds*20); frame++) nav.update(time += 50)
      return { delta:camera.position.clone().sub(position), targetDelta:target.clone().sub(targetBefore) }
    },
  }
}

describe("第一人称速度与 Shift 加速",() => {
  test("画布未拥有焦点不收键；连接/窗口/表单焦点变化即使没有blur也不续跑held键",()=>{
    const control=rig(),input=new EventTarget()
    control.canvas.ownerDocument.activeElement=input
    expect(control.key('keydown','KeyD').defaultPrevented).toBe(false)
    expect(control.advance().delta.length()).toBe(0)
    for(const lose of [()=>{control.canvas.ownerDocument.activeElement=input},()=>{control.canvas.isConnected=false},()=>{control.canvas.windowFocused=false}]){
      control.canvas.isConnected=true;control.canvas.windowFocused=true;control.canvas.focus()
      control.key('keydown','KeyE');expect(control.advance(.1).delta.z).toBeGreaterThan(0)
      lose();expect(control.advance().delta.length()).toBe(0)
      control.canvas.isConnected=true;control.canvas.windowFocused=true;control.canvas.focus()
      expect(control.advance().delta.length()).toBe(0)
    }
  })
  test("光学roll90仍按世界Z执行QE，平移不改保存姿态与cameraUp",()=>{
    const control=rig()
    control.camera.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),Math.PI/2))
    control.camera.up.set(0,1,0).applyQuaternion(control.camera.quaternion)
    const quaternion=control.camera.quaternion.clone(),opticalUp=control.camera.up.clone()
    control.key('keydown','KeyE');expect(control.advance().delta.distanceTo(new THREE.Vector3(0,0,3))).toBeLessThan(1e-9);control.key('keyup','KeyE');control.key('keydown','KeyQ');expect(control.advance().delta.z).toBeCloseTo(-3)
    expect(control.camera.quaternion.equals(quaternion)).toBe(true);expect(control.camera.up.equals(opticalUp)).toBe(true);expect(Math.abs(opticalUp.dot(new THREE.Vector3(0,0,1)))).toBeLessThan(1e-8)
  })
  test("倾斜roll90视角的六方向都有效且相机/target同步平移，姿态不被世界up重写",()=>{
    const control=rig()
    control.camera.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),.7)).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),Math.PI/2))
    control.camera.up.set(0,1,0).applyQuaternion(control.camera.quaternion)
    const before=control.camera.quaternion.clone(),up=control.camera.up.clone()
    const moved=new Map<string,THREE.Vector3>()
    for(const code of ['KeyW','KeyS','KeyA','KeyD','KeyQ','KeyE']){
      control.key('keydown',code);const result=control.advance();control.key('keyup',code)
      expect(result.delta.length()).toBeCloseTo(3);expect(result.targetDelta.distanceTo(result.delta)).toBeLessThan(1e-9);moved.set(code,result.delta)
    }
    for(const [a,b] of [['KeyW','KeyS'],['KeyA','KeyD'],['KeyQ','KeyE']])expect(moved.get(a!)!.clone().add(moved.get(b!)!).length()).toBeLessThan(1e-9)
    expect(moved.get('KeyW')!.z).toBeCloseTo(0);expect(moved.get('KeyD')!.z).toBeCloseTo(0);expect(moved.get('KeyE')!.z).toBeCloseTo(3)
    expect(control.camera.quaternion.equals(before)).toBe(true);expect(control.camera.up.equals(up)).toBe(true)
  })
  test("垂直向上/向下的W使用最后有效水平heading，位移有限且保持速度",()=>{
    const control=rig();control.key('keydown','KeyW');control.advance(.05);control.key('keyup','KeyW')
    for(const z of [-1,1]){
      control.camera.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,-1),new THREE.Vector3(0,0,z));control.key('keydown','KeyW')
      const move=control.advance();expect(move.delta.toArray().every(Number.isFinite)).toBe(true);expect(move.delta.x).toBeCloseTo(0);expect(move.delta.y).toBeCloseTo(3);expect(move.delta.z).toBeCloseTo(0);control.key('keyup','KeyW')
    }
  })
  test("右键绕世界up偏航与俯仰保光学roll，竖直附近不产生NaN",()=>{
    const control=rig();control.camera.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),Math.PI/2));control.camera.up.set(0,1,0).applyQuaternion(control.camera.quaternion)
    const pointer=(type:string,x:number,y:number)=>{const event=new Event(type,{cancelable:true});Object.defineProperties(event,{button:{value:2},pointerId:{value:1},clientX:{value:x},clientY:{value:y}});control.canvas.dispatchEvent(event)}
    pointer('pointerdown',100,100);pointer('pointermove',200,80);pointer('pointerup',200,80)
    const opticalUp=new THREE.Vector3(0,1,0).applyQuaternion(control.camera.quaternion),direction=control.camera.getWorldDirection(new THREE.Vector3())
    expect(control.camera.up.distanceTo(opticalUp)).toBeLessThan(1e-9);expect(Math.abs(opticalUp.dot(new THREE.Vector3(0,0,1)))).toBeLessThan(1e-8);expect(direction.toArray().every(Number.isFinite)).toBe(true);expect(control.target.clone().sub(control.camera.position).normalize().distanceTo(direction)).toBeLessThan(1e-9)
    control.camera.quaternion.identity();pointer('pointerdown',10,10);pointer('pointermove',30,40);expect(control.camera.quaternion.toArray().every(Number.isFinite)).toBe(true)
  })
  test("默认连续前进 1 秒移动 3 m，相机和目标同步平移",() => {
    const control = rig()
    expect(control.key("keydown","KeyW").defaultPrevented).toBe(true)
    const movement = control.advance()
    expect(movement.delta.x).toBeCloseTo(0)
    expect(movement.delta.y).toBeCloseTo(3)
    expect(movement.delta.z).toBeCloseTo(0)
    expect(movement.targetDelta.distanceTo(movement.delta)).toBeCloseTo(0)
    control.key("keyup","KeyW")
    expect(control.advance().delta.length()).toBe(0)
  })

  test("10 m 房间前进 3 m/s，100 m 场景前进 10 m/s，大场景限于 20 m/s",() => {
    for (const [extent,speed] of [[10,3],[100,10],[1000,20]] as const) {
      const control = rig(new THREE.Box3(new THREE.Vector3(),new THREE.Vector3(extent,extent/2,3)))
      control.key("keydown","KeyW")
      expect(control.advance().delta.length()).toBeCloseTo(speed)
    }
  })

  test("左 Shift 按住前进 15 m/s，松开仍按 W 时立即恢复 3 m/s",() => {
    const control = rig()
    control.key("keydown","KeyW")
    control.key("keydown","ShiftLeft",true)
    expect(control.advance().delta.length()).toBeCloseTo(15)
    control.key("keyup","ShiftLeft")
    expect(control.advance().delta.length()).toBeCloseTo(3)
    expect(control.nav.speed).toBe(3)
  })

  test("右 Shift 同样加速；两侧同时按住后释放一侧仍保持 5 倍",() => {
    const control = rig()
    control.key("keydown","ShiftRight",true)
    control.key("keydown","KeyW",true)
    expect(control.advance().delta.length()).toBeCloseTo(15)
    control.key("keydown","ShiftLeft",true)
    control.key("keyup","ShiftRight",true)
    expect(control.advance().delta.length()).toBeCloseTo(15)
    control.key("keyup","ShiftLeft")
    expect(control.advance().delta.length()).toBeCloseTo(3)
  })

  test("获得画布焦点前已经按住 Shift，移动键的修饰状态仍能加速",() => {
    const control = rig()
    control.key("keydown","KeyW",true)
    expect(control.advance().delta.length()).toBeCloseTo(15)
    control.key("keyup","ShiftLeft")
    expect(control.advance().delta.length()).toBeCloseTo(3)
  })

  test("Q 下降、E 上升；加速对上下移动也生效",() => {
    const control = rig()
    control.key("keydown","KeyQ")
    expect(control.advance().delta.z).toBeCloseTo(-3)
    control.key("keyup","KeyQ")
    control.key("keydown","KeyE")
    expect(control.advance().delta.z).toBeCloseTo(3)
    control.key("keydown","ShiftRight",true)
    expect(control.advance().delta.z).toBeCloseTo(15)
  })

  test("W+D+E 组合与单方向速度相同，Shift 不叠加对角倍速",() => {
    const control = rig()
    for (const key of ["KeyW","KeyD","KeyE"]) control.key("keydown",key)
    expect(control.advance().delta.length()).toBeCloseTo(3)
    control.key("keydown","ShiftLeft",true)
    expect(control.advance().delta.length()).toBeCloseTo(15)
  })

  test("画布或窗口失焦都停止移动，重新获得输入后没有残留加速",() => {
    for (const surface of ["canvas","window"] as const) {
      const control = rig()
      control.key("keydown","KeyW")
      control.key("keydown","ShiftLeft",true)
      expect(control.advance().delta.length()).toBeCloseTo(15)
      const target = surface === "canvas" ? control.canvas : control.canvas.ownerDocument.defaultView
      target.dispatchEvent(new Event("blur"))
      expect(control.advance().delta.length()).toBe(0)
      control.key("keydown","KeyW")
      expect(control.advance().delta.length()).toBeCloseTo(3)
    }
  })

  test("Esc 离开、重新进入及销毁控制器都不会残留移动或 Shift",() => {
    const control = rig()
    control.key("keydown","KeyW")
    control.key("keydown","ShiftRight",true)
    control.key("keydown","Escape",true)
    expect(control.nav.active).toBe(false)
    expect(control.advance().delta.length()).toBe(0)
    control.nav.setActive(true)
    expect(control.advance().delta.length()).toBe(0)
    control.key("keydown","KeyW")
    expect(control.advance().delta.length()).toBeCloseTo(3)
    control.nav.dispose()
    control.key("keydown","KeyW")
    expect(control.advance().delta.length()).toBe(0)
  })

  test("窗口和其他画布的按键不会驱动当前相机",() => {
    const control = rig()
    const otherCanvas = new Canvas()
    control.key("keydown","KeyW",false,otherCanvas)
    control.key("keydown","ShiftLeft",true,control.canvas.ownerDocument.defaultView)
    expect(control.advance().delta.length()).toBe(0)
    control.key("keydown","KeyW")
    expect(control.advance().delta.length()).toBeCloseTo(3)
  })
})
