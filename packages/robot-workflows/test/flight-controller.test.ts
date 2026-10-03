import {describe,test,expect} from 'bun:test'
import {assertFlightProfile,CRAZYFLIE_SOURCE_SHA256,flightState,flightControl,angleError} from '../src/flight-controller.ts'
import {validateFlightInput} from '../src/flight-run.ts'
import type {NativeBodyWrenchDescription} from '../../sim-contract/src/index.ts'
const mapping:Extract<NativeBodyWrenchDescription,{available:true}>={available:true,frame:'body-root',units:{force:'N',torque:'Nm'},massKg:.027,bodyName:'quad/cf2',sourceSha256:CRAZYFLIE_SOURCE_SHA256,gravityWorldMps2:[0,0,-9.81],actuators:['body_thrust','x_moment','y_moment','z_moment'],matrix:[[0,0,0,0],[0,0,0,0],[1,0,0,0],[0,-1e-5,0,0],[0,0,-1e-5,0],[0,0,0,-1e-5]],limits:['body_thrust','x_moment','y_moment','z_moment'].map((name,i)=>({name,gain:1,ctrlrange:i===0?[0,.35] as [number,number]:[-1,1] as [number,number],forcerange:null}))}
const state={positionM:[0,0,.35] as [number,number,number],quaternionXyzw:[0,0,0,1] as [number,number,number,number],velocityWorldMps:[0,0,0] as [number,number,number],omegaBodyRadps:[0,0,0] as [number,number,number]}
describe('飞控真实观测与固定来源合同',()=>{
 test('缺真实自由根/速度拒绝，不把 Entity 静态 transform 当零速度观察',()=>{
  expect(()=>flightState({entityId:'x',transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]}})).toThrow('FLIGHT_OBSERVATION_REQUIRED')
  expect(()=>flightState({entityId:'x',transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},sensors:{freeBase:{positionM:[0,0,0],quaternionXyzw:[0,0,0,1],linearVelocityWorldMps:[0,0,NaN],angularVelocityLocalRadps:[0,0,0]}}})).toThrow('FLIGHT_OBSERVATION_REQUIRED')
 })
 test('固定来源/实际映射/重力逐项拒绝，普通 generic 不冒称 ready',()=>{
  expect(assertFlightProfile(mapping)).toBe(mapping)
  expect(()=>assertFlightProfile({...mapping,sourceSha256:'unknown'})).toThrow('FLIGHT_PROFILE_UNVERIFIED')
  expect(()=>assertFlightProfile({...mapping,matrix:[[0]]})).toThrow('FLIGHT_MAPPING_MISMATCH')
  expect(()=>assertFlightProfile({...mapping,gravityWorldMps2:[0,0,0]})).toThrow('FLIGHT_GRAVITY_PROFILE_UNVERIFIED')
 })
 test('零误差输出真实 mg；正向/正yaw生成正确符号力矩并保源权限',()=>{
  const hover=flightControl(state,{positionM:state.positionM,yawRad:0},mapping)
  expect(hover.thrustN).toBeCloseTo(.26487,8);expect(hover.torqueNm).toEqual([0,0,0])
  const move=flightControl(state,{positionM:[.25,0,.35],yawRad:.25},mapping)
  expect(move.torqueNm[1]).toBeGreaterThan(0);expect(move.torqueNm[2]).toBeGreaterThan(0)
  expect(move.thrustN).toBeLessThanOrEqual(.35);expect(move.torqueNm.every(v=>Math.abs(v)<=1e-5)).toBe(true)
  expect(Math.abs(angleError(-Math.PI+.1,Math.PI-.1))).toBeCloseTo(.2,8)
 })
 test('输入身份/必需目标/落地高度/有界时长统一验证',()=>{
  const input={worldId:'w',entityId:'quad',expectedGeneration:1,expectedSceneRevision:1,operation:'hover' as const}
  expect(()=>validateFlightInput(input)).not.toThrow()
  expect(()=>validateFlightInput({...input,operation:'goto'})).toThrow('FLIGHT_TARGET_REQUIRED')
  expect(()=>validateFlightInput({...input,operation:'land'})).toThrow('FLIGHT_LANDING_SURFACE_REQUIRED')
  expect(()=>validateFlightInput({...input,maxDurationS:31})).toThrow('FLIGHT_DURATION_OUT_OF_RANGE')
  expect(()=>validateFlightInput({...input,expectedGeneration:0})).toThrow('FLIGHT_INVALID_IDENTITY')
 })
})
