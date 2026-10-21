/**
 * A→B→C 路线回归：有序编辑、参数校验、机位缺失与镜头类型不可插值的具体原因、时间轴采样
 * （位置 lerp 米、四元数 slerp xyzw、FOV 度、target 始终在视线上）与记录参数复算。
 * 纯函数、离线；真实镜头驱动与视频解码由主控在 Edge 里独立验证。
 */
import {test,expect} from 'bun:test'
import type {NamedCamera} from '../../viewer/src/camera-view.ts'
import {addRouteStop,moveRouteStop,normalizeCaptureRoute,parseCaptureRoutes,planCaptureRoute,prepareCaptureRouteForSave,removeRouteStop,routePlanSummary,sampleRoutePlan,setRouteSegment,setRouteStopHold,slerp,withCaptureRoute,withoutCaptureRoute,MAX_ROUTE_HOLD_MS,type CaptureRoute} from '../src/capture-route.ts'
import {emptyRoute} from '../src/capture-video-panel.tsx'

const cam=(name:string,position:[number,number,number],extra:Record<string,unknown>={}):NamedCamera=>({
  name,savedAt:new Date(0).toISOString(),
  state:{position,quaternion:[0,0,0,1],target:[position[0],position[1]+1,position[2]],up:[0,1,0],fovDeg:50,near:0.1,far:1000,...extra} as NamedCamera['state'],
})
const route=()=>({
  routeId:"r1",name:"Tour",sceneId:"s",sceneRevision:2,
  stops:[{cameraName:"A",holdMs:500},{cameraName:"B",holdMs:0},{cameraName:"C",holdMs:250}],
  segmentMs:[1000,2000],savedAt:new Date(0).toISOString(),
})

test('路线读入校验：段数/名字/停留非法都拒绝',()=>{
  expect(normalizeCaptureRoute(route(),"s").route?.stops.length).toBe(3)
  expect(normalizeCaptureRoute({...route(),segmentMs:[1000]}).reason).toContain("segment durations")
  expect(normalizeCaptureRoute({...route(),name:""}).reason).toContain("route name")
  expect(normalizeCaptureRoute({...route(),stops:[{cameraName:"A",holdMs:0}]}).reason).toContain("at least 2 saved cameras")
  expect(normalizeCaptureRoute({...route(),sceneId:"other"},"s").reason).toContain("not the current scene")
  expect(normalizeCaptureRoute({...route(),stops:[{cameraName:"A",holdMs:-1},{cameraName:"B",holdMs:0}]}).reason).toContain("hold")
})

test('路线直接诊断均为英语并保留字段、错误码和纠正语义',()=>{
  const invalids=[null,{}, {...route(),name:''},{...route(),sceneId:''},{...route(),stops:[]},{...route(),stops:Array.from({length:9},()=>({cameraName:'A',holdMs:0}))},{...route(),stops:[null,null]},{...route(),stops:[{cameraName:'',holdMs:0},{cameraName:'B',holdMs:0}]},{...route(),segmentMs:[0,1]}]
  for(const value of invalids){const parsed=normalizeCaptureRoute(value);expect(parsed.route).toBeUndefined();expect(parsed.reason).toBeTruthy();expect(parsed.reason).not.toMatch(/[\u3400-\u9fff]/)}
  for(const component of [{routes:{}},{routes:[null]}]){
    const parsed=parseCaptureRoutes(component)
    expect(parsed.routes).toHaveLength(0);expect(parsed.warnings).toHaveLength(1);expect(parsed.warnings[0]).not.toMatch(/[\u3400-\u9fff]/)
  }
  for(const change of [()=>addRouteStop(route(),{cameraName:'',holdMs:0},1000),()=>addRouteStop(route(),{cameraName:'A',holdMs:-1},1000),()=>removeRouteStop({...route(),stops:route().stops.slice(0,2)},0),()=>setRouteStopHold(route(),0,Infinity),()=>setRouteSegment(route(),0,0)]){
    let failure='';try{change()}catch(error){failure=String(error)}
    expect(failure).toContain('ROUTE_');expect(failure).not.toMatch(/[\u3400-\u9fff]/)
  }
})

test('有序编辑：加入/上移下移/删除/停留与段时长',()=>{
  const empty={...route(),stops:[],segmentMs:[]}
  const one=addRouteStop(empty,{cameraName:"A",holdMs:0},2000)
  expect(one.stops).toHaveLength(1)
  const two=addRouteStop(one,{cameraName:"B",holdMs:0},1500)
  expect(two.segmentMs).toEqual([1500])
  const three=addRouteStop(two,{cameraName:"C",holdMs:0},2500)
  expect(three.stops.map(s=>s.cameraName)).toEqual(["A","B","C"])
  const moved=moveRouteStop(three,2,-1)
  expect(moved.stops.map(s=>s.cameraName)).toEqual(["A","C","B"])
  expect(moved.segmentMs).toEqual([1500,2500])
  const removed=removeRouteStop(three,1)
  expect(removed.stops.map(s=>s.cameraName)).toEqual(["A","C"])
  expect(setRouteStopHold(three,0,1200).stops[0]!.holdMs).toBe(1200)
  expect(setRouteSegment(three,0,3000).segmentMs[0]).toBe(3000)
  expect(()=>setRouteStopHold(three,0,MAX_ROUTE_HOLD_MS+1)).toThrow("ROUTE_HOLD_INVALID")
  expect(()=>removeRouteStop(two,0)).toThrow("ROUTE_MIN_STOPS")
})

test('路线的保存/删除按 routeId 覆盖，不产生重复',()=>{
  const a={...route(),routeId:"r1"},b={...route(),routeId:"r2",name:"Other"}
  const list=withCaptureRoute(withCaptureRoute([],a),b)
  expect(list.map(r=>r.routeId)).toEqual(["r2","r1"])
  expect(withCaptureRoute(list,a).map(r=>r.routeId)).toEqual(["r1","r2"])
  expect(withoutCaptureRoute(list,"r1").map(r=>r.routeId)).toEqual(["r2"])
})

test('路线来源版本：emptyRoute 用创建时的源版本，保存按当刻版本钉定并可读回',()=>{
  const draft=emptyRoute('s',7)
  expect(draft.sceneRevision).toBe(7)
  expect(draft.sceneId).toBe('s')
  const filled:CaptureRoute={...draft,name:'Tour',stops:[{cameraName:'A',holdMs:0},{cameraName:'B',holdMs:100}],segmentMs:[1000]}
  const savedAt=new Date(0).toISOString()
  const prepared=prepareCaptureRouteForSave(filled,'s',9,savedAt)
  expect(prepared.route?.sceneRevision).toBe(9)
  expect(prepared.route?.savedAt).toBe(savedAt)
  expect(normalizeCaptureRoute(prepared.route,'s').route?.sceneRevision).toBe(9)
})

test('路线保存校验：空名/少于两站/非法段时长/跨场景草稿都拒绝，绝不产出可保存 route',()=>{
  const savedAt=new Date(0).toISOString()
  const valid:CaptureRoute={...emptyRoute('s',3),name:'Tour',stops:[{cameraName:'A',holdMs:0},{cameraName:'B',holdMs:0}],segmentMs:[1000]}
  expect(prepareCaptureRouteForSave({...valid,name:''},'s',3,savedAt).reason).toContain('route name')
  expect(prepareCaptureRouteForSave({...valid,stops:[{cameraName:'A',holdMs:0}],segmentMs:[]},'s',3,savedAt).reason).toContain('at least 2 saved cameras')
  expect(prepareCaptureRouteForSave({...valid,segmentMs:[0]},'s',3,savedAt).reason).toContain('duration')
  expect(prepareCaptureRouteForSave(valid,'other',3,savedAt).reason).toContain('not the current scene')
  expect(prepareCaptureRouteForSave(valid,undefined,3,savedAt).route).toBeUndefined()
  expect(prepareCaptureRouteForSave({...valid,name:'Tour'},'s',undefined,savedAt).route?.sceneRevision).toBe(3)
})

test('计划：机位缺失给具体原因',()=>{
  const planned=planCaptureRoute(route(),[cam("A",[0,0,0]),cam("C",[0,0,0])])
  expect(planned.ok).toBe(false)
  if(!planned.ok){
    expect(planned.reason).toContain('Stop 2')
    expect(planned.reason).toContain('“B”')
    expect(planned.reason).toContain('Choose another camera or remove this stop.')
    expect(planned.reason).not.toMatch(/[\u3400-\u9fff]/)
  }
})

test('计划：镜头类型不可插值给具体原因，不静默改类型',()=>{
  const intrinsics={fx:320,fy:320,cx:160,cy:120,width:320,height:240}
  const plain=cam("A",[0,0,0]),photo=cam("B",[1,0,0],{intrinsics})
  const mixed=planCaptureRoute({...route(),stops:[{cameraName:"A",holdMs:0},{cameraName:"B",holdMs:0}],segmentMs:[1000]},[plain,photo])
  expect(mixed.ok).toBe(false)
  if(!mixed.ok)expect(mixed.reason).toContain("same lens type")
  const otherSize=cam("B",[1,0,0],{intrinsics:{...intrinsics,width:640,height:480}})
  const mismatch=planCaptureRoute({...route(),stops:[{cameraName:"A",holdMs:0},{cameraName:"B",holdMs:0}],segmentMs:[1000]},[cam("A",[0,0,0],{intrinsics}),otherSize])
  expect(mismatch.ok).toBe(false)
  if(!mismatch.ok)expect(mismatch.reason).toContain("different frame sizes")
})

test('时间轴：停留取整站状态，段内位置 lerp / FOV 插值 / target 在视线上',()=>{
  const planned=planCaptureRoute(route(),[cam("A",[0,0,0],{fovDeg:40}),cam("B",[8,0,0],{fovDeg:60}),cam("C",[8,8,0],{fovDeg:80})])
  expect(planned.ok).toBe(true)
  if(!planned.ok)return
  const {plan}=planned
  expect(plan.totalMs).toBe(500+1000+0+2000+250)
  // 停留期
  expect(sampleRoutePlan(plan,100).state.position).toEqual([0,0,0])
  expect(sampleRoutePlan(plan,100).phase).toBe("hold")
  // A→B 段中点 t=500+500=1000
  const mid=sampleRoutePlan(plan,1000)
  expect(mid.phase).toBe("move")
  expect(mid.state.position[0]).toBeCloseTo(4,10)
  expect(mid.state.fovDeg).toBeCloseTo(50,10)
  // B 站 hold=0：段起点即 B（t=1500 落在 B→C 段 u=0）
  expect(sampleRoutePlan(plan,1500).state.position).toEqual([8,0,0])
  // 总时长之后取末站
  expect(sampleRoutePlan(plan,plan.totalMs+50).state.position).toEqual([8,8,0])
  // target 始终在视线上：|target-position| 等于插值距离
  for(const t of [500,900,1200,2000,3000]){
    const s=sampleRoutePlan(plan,t).state
    const dx=s.target[0]-s.position[0],dy=s.target[1]-s.position[1],dz=s.target[2]-s.position[2]
    expect(Math.hypot(dx,dy,dz)).toBeCloseTo(1,6)
  }
})

test('四元数 slerp：90° 绕 Z 的中点约 45°',()=>{
  const half=Math.SQRT1_2
  const r=slerp([0,0,0,1],[0,0,half,half],0.5)
  expect(r[2]!).toBeCloseTo(Math.sin(Math.PI/8),6)
  expect(r[3]!).toBeCloseTo(Math.cos(Math.PI/8),6)
  expect(Math.hypot(...r)).toBeCloseTo(1,10)
})

test('复算参数摘要保留顺序、段时长与镜头口径',()=>{
  const planned=planCaptureRoute(route(),[cam("A",[0,0,0]),cam("B",[1,0,0]),cam("C",[1,1,0])])
  if(!planned.ok)throw new Error(planned.reason)
  const summary=routePlanSummary(planned.plan)
  expect(summary.stops.map(s=>s.cameraName)).toEqual(["A","B","C"])
  expect(summary.segmentMs).toEqual([1000,2000])
  expect(summary.totalMs).toBe(3750)
  expect(summary.lens[0]).toMatchObject({from:"A",to:"B",mode:"plain"})
})
