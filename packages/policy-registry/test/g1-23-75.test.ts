import {describe,expect,test}from "bun:test"
import {mkdtemp,writeFile,rm}from "node:fs/promises"
import {join}from "node:path"
import {tmpdir}from "node:os"
import {g1Observation75,g1Targets75,g1MatchDifferences75,G1_23_75_ID,G1_23_75_MODEL,G1_23_75_REVISION,G1_23_75_ORDER}from "../src/g1-23-75.ts"
import {adoptLocalG1Policy}from "../src/g1-local-policy.ts"
import {IMPLEMENTED_POLICY_ADAPTERS}from "../src/pack-contract.ts"
import type {PreparedAdapter}from "../src/adapter.ts"
import type {Frame}from "../../lyapunov-contracts/src/types.ts"

const names=Array.from({length:23},(_,i)=>"joint"+i)
const adapter={adapter:G1_23_75_ID,jointNames:names,config:{default_angles:Array(23).fill(0),policy_joint_indices:G1_23_75_ORDER,action_scale:.5,kps:Array(23).fill(60),kds:Array(23).fill(1)}}as unknown as PreparedAdapter
const frame=():Frame=>({worldId:"world",generation:1,sceneRevision:1,stepIndex:0,simTime:0,frameId:"f",entities:[{entityId:"g1",transform:{position:[0,0,.793],quaternion:[0,0,0,1],scale:[1,1,1]},joints:{names:[...names],positions:names.map((_,i)=>i+.1),velocities:names.map((_,i)=>i+.2)},sensors:{policyDiagnostics:{gravityWorldMps2:[0,0,-9.81],accelerationsRadps2:Array(23).fill(.1),engineWarningCounts:Array(8).fill(0),duplicateCollisionPlanes:[]},sites:{imu_in_pelvis:{quaternionXyzw:[Math.SQRT1_2,0,0,Math.SQRT1_2]}}}}]})

describe("固定来源75/23观测与动作",()=>{
 test("真实IMU投影、无角速度槽、策略序位置/速度/上动作保持75布局",()=>{
  const previous=names.map((_,i)=>i+.3),obs=g1Observation75(adapter,frame(),"g1",[.4,.5,.6],previous)
  expect(obs.length).toBe(75);expect(obs[0]).toBeCloseTo(0);expect(obs[1]).toBeCloseTo(-1);expect(obs[2]).toBeCloseTo(0)
  expect(obs.slice(3,6)).toEqual([.4,.5,.6]);expect(obs.slice(6,29)).toEqual(G1_23_75_ORDER.map(i=>i+.1));expect(obs.slice(29,52)).toEqual(G1_23_75_ORDER.map(i=>i+.2));expect(obs.slice(52)).toEqual(previous)
 })
 test("网络23动作反排到MuJoCo序，默认姿态只加一次，不交换左右关节",()=>{
  const action=names.map((_,i)=>i),targets=g1Targets75(adapter,action)
  G1_23_75_ORDER.forEach((mj,policy)=>expect(targets[mj]).toBe(policy*.5))
  const limited={...adapter,config:{...adapter.config,joint_ranges:Array(23).fill([-.1,.1])}};expect(g1Targets75(limited,Array(23).fill(5))).toEqual(Array(23).fill(.1))
  expect(()=>g1Targets75(adapter,Array(23).fill(Infinity))).toThrow("POLICY_ACTION_INVALID")
 })
 test("缺真实site、重复关节、非有限反馈都拒绝，不造零观察",()=>{
  const missing=frame();missing.entities[0]!.sensors={};expect(()=>g1Observation75(adapter,missing,"g1",[0,0,0],Array(23).fill(0))).toThrow("POLICY_OBSERVATION_UNAVAILABLE")
  const duplicate=frame();duplicate.entities[0]!.joints!.names[1]="joint0";expect(()=>g1Observation75(adapter,duplicate,"g1",[0,0,0],Array(23).fill(0))).toThrow("POLICY_JOINT_SET_MISMATCH")
  const duplicatedPlane=frame();(duplicatedPlane.entities[0]!.sensors!.policyDiagnostics as any).duplicateCollisionPlanes=[["__ground","g1/floor"]];expect(()=>g1Observation75(adapter,duplicatedPlane,"g1",[0,0,0],Array(23).fill(0))).toThrow("POLICY_DUPLICATE_GROUND")
  const invalid=frame();invalid.entities[0]!.joints!.velocities[0]=NaN;expect(()=>g1Observation75(adapter,invalid,"g1",[0,0,0],Array(23).fill(0))).toThrow("POLICY_OBSERVATION_INVALID")
 })
 test("匹配检查实际PD回读字段，缺字段和错误增益分开点名",()=>{
  const description={joints:names.map(name=>({name,driveStiffness:60,driveDamping:1}))}as any
  expect(g1MatchDifferences75(adapter,frame(),"g1",description)).toEqual([])
  description.joints[3].driveStiffness=100;expect(g1MatchDifferences75(adapter,frame(),"g1",description)).toEqual([{path:"joints.joint3.driveStiffness",reason:"DRIVE_PD_GAIN_MISMATCH",expected:60,actual:100}])
  const differences=g1MatchDifferences75(adapter,undefined,"g1",undefined);expect(differences[0]!.reason).toBe("OBSERVATION_SOURCE_MISSING");expect(differences.length).toBe(47)
 })
 test("唯一登记明确新来源/pin，不把旧12/82/390来源借给75",()=>{
  const entries=IMPLEMENTED_POLICY_ADAPTERS.filter(a=>a.id===G1_23_75_ID);expect(entries.length).toBe(1);expect(entries[0]!.modelId).toBe(G1_23_75_MODEL);expect(entries[0]!.revision).toBe(G1_23_75_REVISION);expect(entries[0]!.requires.files).toEqual(["deployment/policy.pt"])
 })
 test("显式复用先核固定权重字节，不向cache写入不相符权重",async()=>{
  const root=await mkdtemp(join(tmpdir(),"g1-local-weight-"))
  try{const file=join(root,"wrong.pt");await writeFile(file,"not this policy");await expect(adoptLocalG1Policy(root,file)).rejects.toThrow("POLICY_ADAPTER_SOURCE_MISMATCH")}finally{await rm(root,{recursive:true,force:true})}
 })
})
