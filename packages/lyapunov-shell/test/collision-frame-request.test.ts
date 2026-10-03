import {describe,expect,test} from "bun:test"
import {collisionFrameSelection,worldFrameSelection} from "../src/collision-frame-request.ts"
import {workbenchAPI} from "../src/workbench-api.ts"

describe("按当前会话只读碰撞帧请求",()=>{
 test('实际位置/末端/接触请求同world帧且拒绝模糊开关',()=>{
  expect(worldFrameSelection(new URLSearchParams({sensors:'1',contacts:'1',entityId:'selected'}))).toEqual({sensors:true,contacts:true,entityIds:['selected']})
  expect(()=>worldFrameSelection(new URLSearchParams({sensors:'maybe'}))).toThrow('WORLD_OBSERVATION_SELECTION_INVALID')
 })
 test("默认无拓扑，限定实体/是否读取静态几何，并拒绝空目标",()=>{
  expect(collisionFrameSelection(new URLSearchParams({worldId:"w"}))).toBeUndefined()
  const query=new URLSearchParams({collisionTopology:"1",collisionGeometry:"0"});query.append("collisionEntityId","arm/1");query.append("collisionEntityId","arm/1")
  expect(collisionFrameSelection(query)).toEqual({collisionTopology:{entityIds:["arm/1"],includeGeometry:false}})
  expect(()=>collisionFrameSelection(new URLSearchParams({collisionTopology:"1"}))).toThrow("COLLISION_SELECTION_INVALID")
  query.set("collisionGeometry","yes");expect(()=>collisionFrameSelection(query)).toThrow("COLLISION_GEOMETRY_INVALID")
 })
 test("客户端保持session绑定，首几何与后续位姿走同一frame路由",async()=>{
  const original=globalThis.fetch,calls:string[]=[]
  globalThis.fetch=(async(url:any)=>{calls.push(String(url));return Response.json({worldId:"w"})}) as any
  try{
   const api=workbenchAPI("session-isolated")
   await api.frame("world",{entityIds:["parent","child"],includeGeometry:true})
   await api.frame("world",{entityIds:["parent","child"],includeGeometry:false})
   expect(calls.length).toBe(2)
   const first=new URL(calls[0]!,"http://localhost"),second=new URL(calls[1]!,"http://localhost")
   expect(first.pathname).toBe("/api/lyapunov/frame");expect(first.searchParams.get("sessionId")).toBe("session-isolated");expect(first.searchParams.getAll("collisionEntityId")).toEqual(["parent","child"])
   expect(first.searchParams.get("collisionGeometry")).toBe("1");expect(second.searchParams.get("collisionGeometry")).toBe("0")
  }finally{globalThis.fetch=original}
 })
})
