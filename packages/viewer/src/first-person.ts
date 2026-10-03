import * as THREE from "three"

/** 环境中心视角：仅操作相机，不修改源件、实体变换或物理世界。 */
export function placeInsideScene(camera: THREE.PerspectiveCamera, bounds: THREE.Box3) {
  if (bounds.isEmpty()) return undefined
  const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3())
  if (![...center.toArray(), ...size.toArray()].every(Number.isFinite)) return undefined
  const forward = size.x > size.y ? new THREE.Vector3(1,0,0) : new THREE.Vector3(0,1,0)
  camera.up.set(0,0,1); camera.position.copy(center)
  const target = center.clone().add(forward)
  camera.near = 0.02; camera.far = Math.max(100, size.length()*4)
  camera.lookAt(target); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true)
  // 场景坐标以米计：普通房间至少 3 m/s，大场景按跨度提高，避免穿越时慢如挪步。
  return { target, speed: Math.max(3, Math.min(20, Math.max(size.x,size.y)/10)) }
}

/** 只抽样 Gaussian 中心用于初始机位；少量离群点不决定相机位置。完整数据仍照常渲染。 */
export function centralSplatBounds(count:number, read:(index:number)=>{center:THREE.Vector3;opacity:number}):THREE.Box3|undefined {
  const axes:[number[],number[],number[]]=[[],[],[]], step=Math.max(1,Math.ceil(count/8192))
  for(let i=0;i<count;i+=step){
    const value=read(i),point=value.center.toArray()
    if(value.opacity<0.01||!point.every(Number.isFinite))continue
    for(let axis=0;axis<3;axis++)axes[axis]!.push(point[axis]!)
  }
  if(!axes[0].length)return undefined
  const min:number[]=[],max:number[]=[]
  for(const values of axes){values.sort((a,b)=>a-b);const trim=values.length>=100?Math.floor(values.length*.02):0;min.push(values[trim]!);max.push(values[values.length-1-trim]!)}
  return new THREE.Box3(new THREE.Vector3(...min),new THREE.Vector3(...max))
}

/** 右键环顾、WASD 移动、Q 下降/E 上升、Shift 加速 5 倍；失焦立刻停。按键只监听本画布。 */
export class FirstPersonNavigation {
  active=false
  speed=3
  private keys=new Set<string>()
  private shiftHeld=false
  private lastTime=0
  private pointer?:{id:number;x:number;y:number}
  private heading=new THREE.Vector3(0,1,0)
  constructor(private camera:THREE.PerspectiveCamera,private canvas:HTMLCanvasElement,private target:THREE.Vector3,private exit:()=>void,private getWorldUp:()=>THREE.Vector3=()=>new THREE.Vector3(0,0,1)){
    canvas.tabIndex=0
    canvas.addEventListener("pointerdown",this.down,true)
    canvas.addEventListener("pointermove",this.move,true)
    canvas.addEventListener("pointerup",this.up,true)
    canvas.addEventListener("pointercancel",this.up,true)
    canvas.addEventListener("keydown",this.keyDown)
    canvas.addEventListener("keyup",this.keyUp)
    canvas.addEventListener("blur",this.blur)
    canvas.ownerDocument?.defaultView?.addEventListener("blur",this.blur)
    canvas.addEventListener("contextmenu",this.contextMenu)
  }
  setActive(active:boolean){this.active=active;this.blur();this.canvas.dataset.navigation=active?"first-person":"orbit"}
  clearInput(){this.blur()}
  private ownsInput(){return this.canvas.isConnected&&this.canvas.ownerDocument.activeElement===this.canvas&&this.canvas.ownerDocument.hasFocus()}
  private worldUp(){const up=this.getWorldUp().clone();if(!up.toArray().every(Number.isFinite)||up.lengthSq()<1e-12)throw new Error("VIEWER_WORLD_UP_INVALID");return up.normalize()}
  private horizontalForward(up:THREE.Vector3){
    const forward=this.camera.getWorldDirection(new THREE.Vector3())
    forward.addScaledVector(up,-forward.dot(up))
    if(forward.lengthSq()>1e-8)this.heading.copy(forward.normalize())
    else{this.heading.addScaledVector(up,-this.heading.dot(up));if(this.heading.lengthSq()<1e-8){this.heading.set(0,1,0).addScaledVector(up,-up.y);if(this.heading.lengthSq()<1e-8)this.heading.set(1,0,0).addScaledVector(up,-up.x)}this.heading.normalize()}
    return this.heading.clone()
  }
  private down=(event:PointerEvent)=>{
    if(!this.active)return
    this.canvas.focus({preventScroll:true})
    if(event.button!==2)return
    event.preventDefault();event.stopImmediatePropagation();this.canvas.focus({preventScroll:true})
    this.pointer={id:event.pointerId,x:event.clientX,y:event.clientY};this.canvas.setPointerCapture(event.pointerId)
  }
  private move=(event:PointerEvent)=>{
    const start=this.pointer;if(!this.active||!start)return
    event.preventDefault();event.stopImmediatePropagation()
    const up=this.worldUp(),yaw=-(event.clientX-start.x)*.003,distance=Math.max(.001,this.camera.position.distanceTo(this.target))
    this.heading.applyAxisAngle(up,yaw)
    this.camera.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(up,yaw)).normalize()
    const direction=this.camera.getWorldDirection(new THREE.Vector3()),right=new THREE.Vector3().crossVectors(this.horizontalForward(up),up).normalize()
    const currentPitch=Math.asin(THREE.MathUtils.clamp(direction.dot(up),-1,1)),pitch=THREE.MathUtils.clamp(currentPitch-(event.clientY-start.y)*.003,-Math.PI*.49,Math.PI*.49)
    this.camera.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(right,pitch-currentPitch)).normalize()
    // 光学up由新姿态推导以保roll；世界up只决定导航轴，不覆盖相机标定。
    this.camera.up.set(0,1,0).applyQuaternion(this.camera.quaternion).normalize()
    this.target.copy(this.camera.position).addScaledVector(this.camera.getWorldDirection(new THREE.Vector3()),distance)
    start.x=event.clientX;start.y=event.clientY
  }
  private up=(event:PointerEvent)=>{if(!this.pointer)return;this.pointer=undefined;if(this.canvas.hasPointerCapture(event.pointerId))this.canvas.releasePointerCapture(event.pointerId)}
  private contextMenu=(event:Event)=>{if(this.active)event.preventDefault()}
  private keyDown=(event:KeyboardEvent)=>{
    if(!this.active||!this.ownsInput()||event.isComposing||event.ctrlKey||event.altKey||event.metaKey)return
    if(event.code==="Escape"){event.preventDefault();this.exit();return}
    if(!["KeyW","KeyA","KeyS","KeyD","KeyQ","KeyE","ShiftLeft","ShiftRight"].includes(event.code))return
    event.preventDefault();event.stopPropagation();this.keys.add(event.code)
    // Shift 可先于画布获得焦点按下，移动键携带的修饰状态同样生效。
    this.shiftHeld=Boolean(event.shiftKey)
  }
  private keyUp=(event:KeyboardEvent)=>{this.keys.delete(event.code);this.shiftHeld=Boolean(event.shiftKey)}
  private blur=()=>{this.keys.clear();this.shiftHeld=false;const pointer=this.pointer;this.pointer=undefined;if(pointer&&this.canvas.hasPointerCapture(pointer.id))this.canvas.releasePointerCapture(pointer.id);this.lastTime=0}
  update(time=performance.now()){
    // 隐藏/拆卸画布或表单接管输入时不依赖blur是否已投递，下一帧即释放旧held键。
    if(!this.active||!this.ownsInput()){this.blur();return}
    const dt=this.lastTime?Math.min(.05,(time-this.lastTime)/1000):0;this.lastTime=time
    if(!this.keys.size)return
    const up=this.worldUp(),forward=this.horizontalForward(up)
    const right=new THREE.Vector3().crossVectors(forward,up).normalize(),delta=new THREE.Vector3()
    delta.addScaledVector(forward,Number(this.keys.has("KeyW"))-Number(this.keys.has("KeyS")))
    delta.addScaledVector(right,Number(this.keys.has("KeyD"))-Number(this.keys.has("KeyA")))
    delta.addScaledVector(up,Number(this.keys.has("KeyE"))-Number(this.keys.has("KeyQ")))
    const boost=this.shiftHeld||this.keys.has("ShiftLeft")||this.keys.has("ShiftRight")?5:1
    delta.normalize().multiplyScalar(this.speed*boost*dt);this.camera.position.add(delta);this.target.add(delta)
  }
  dispose(){
    this.blur();const c=this.canvas
    c.ownerDocument?.defaultView?.removeEventListener("blur",this.blur)
    c.removeEventListener("pointerdown",this.down,true);c.removeEventListener("pointermove",this.move,true)
    c.removeEventListener("pointerup",this.up,true);c.removeEventListener("pointercancel",this.up,true)
    c.removeEventListener("keydown",this.keyDown);c.removeEventListener("keyup",this.keyUp);c.removeEventListener("blur",this.blur);c.removeEventListener("contextmenu",this.contextMenu)
  }
}
