import {Euler,Quaternion,Vector3} from 'three'
import type {Transform} from '../../lyapunov-contracts/src/types.ts'
import type {ResourceImportDefaults} from '../../scene-kit/src/resources.ts'

/** 旧Background实际是Y-up Viewer中的T(dx,dy,-3+dz)·Ry(yaw)·Rx(π)·S。 */
export function legacyResourceDefaults(old:Record<string,any>):ResourceImportDefaults{
 const legacySource={resourceId:String(old.resource_id??old.id),...(typeof old.assetRevision==='string'?{assetRevision:old.assetRevision}:{}),...(typeof old.sourceRef==='string'?{sourceRef:old.sourceRef}:{})}
 if(old.category!=='background'||!['splat','mesh'].includes(old.kind))return {legacySource}
 const value=old.transform??{position:[0,0,0],rotation:[0,0,0],scale:1}
 const vector=(v:unknown)=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite)
 if(!vector(value.position)||!vector(value.rotation)||!Number.isFinite(value.scale)||value.scale<=0)throw new Error('LEGACY_BACKGROUND_CALIBRATION_INVALID: '+legacySource.resourceId)
 // 固定旧Viewer的-3偏移属于实际显示/碰撞放置矩阵；转换到新Z-up后不再额外加偏移。
 const basis=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),Math.PI/2)
 if(old.kind==='mesh'){
  // 旧GLB作为fileLayer时没有-3偏移或splat基线；新GLB内部已有Y→Z源坐标节点。
  const rotation=new Quaternion().setFromEuler(new Euler(...value.rotation as [number,number,number]))
  const mountTransform:Transform={position:new Vector3(...value.position as [number,number,number]).applyQuaternion(basis).toArray(),quaternion:basis.clone().multiply(rotation).multiply(basis.clone().invert()).normalize().toArray(),scale:[value.scale,value.scale,value.scale]}
  return {mountTransform,legacySource:{...legacySource,backgroundCalibration:structuredClone(value),conversion:'旧Y-up GLB层的XYZ旋转/位置→新Z-up；源节点继续单独处理Y→Z'}}
 }
 const rotation=basis.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0,1,0),value.rotation[1])).multiply(basis.clone().invert())
 const position=new Vector3(value.position[0],value.position[1],-3+value.position[2]).applyQuaternion(basis)
 const mountTransform:Transform={position:position.toArray(),quaternion:rotation.normalize().toArray(),scale:[value.scale,value.scale,value.scale]}
 const visualSourceTransform:Transform={position:[0,0,0],quaternion:basis.clone().multiply(new Quaternion(1,0,0,0)).normalize().toArray(),scale:[1,1,1]}
 return {mountTransform,visualSourceTransform,legacySource:{...legacySource,backgroundCalibration:structuredClone(value),viewerTargetZ:-3,conversion:'旧Y-up实际Viewer放置→新Z-up；旧背景只实际消费rotation[1]；源轴变换与用户放置分开'}}
}
