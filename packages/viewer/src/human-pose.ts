import * as THREE from 'three'
import type { HumanComponent, HumanPose } from '../../lyapunov-contracts/src/types.ts'
const humanBindScales=new WeakMap<THREE.Object3D,THREE.Vector3>()
/** 仅消费当前Frame的原生骨body姿态；没有计时器/AnimationMixer推进。原件坐标转换与导入合同成对。 */
export function applyHumanPose(visual:THREE.Object3D,pose:HumanPose,human:HumanComponent):void{
 visual.updateWorldMatrix(true,true)
 // GLTFLoader保留原名在userData.name，并清除Mixamo名字里的冒号；同骨架的非加权指尖/祖先也须同步。
 const wanted=new Set(pose.joints.map(j=>j.name)),bones=new Map<string,THREE.Object3D>();visual.traverse(node=>{const original=node.userData.name;if(typeof original==='string'&&wanted.has(original))bones.set(original,node)})
 // 先完成全部原名绑定，再回退没有原名对应的显示名，避免 A:B→AB 的清洗名覆盖真正AB骨。
 visual.traverse(node=>{if(wanted.has(node.name)&&!bones.has(node.name))bones.set(node.name,node)})
 // 先记录源骨架世界缩放（含单位/父层矩阵），避免写首根后污染子骨的绑定尺度。
 const scales=new Map<string,THREE.Vector3>();for(const[name,bone]of bones){let scale=humanBindScales.get(bone);if(!scale){scale=bone.getWorldScale(new THREE.Vector3());humanBindScales.set(bone,scale.clone())}scales.set(name,scale)}
 const sourceToZ=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),human.source.headingOffsetRad??0).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),human.source.sourceUpAxis==='Y'?Math.PI/2:0))
 for(const joint of pose.joints){const bone=bones.get(joint.name);if(!bone?.parent)continue;bone.parent.updateWorldMatrix(true,false);const desired=new THREE.Matrix4().compose(new THREE.Vector3(...joint.positionM),new THREE.Quaternion(...joint.quaternionXyzw).multiply(sourceToZ),scales.get(joint.name)??new THREE.Vector3(1,1,1));const local=bone.parent.matrixWorld.clone().invert().multiply(desired);local.decompose(bone.position,bone.quaternion,bone.scale);bone.updateMatrix();bone.updateWorldMatrix(false,false)}
 visual.updateMatrixWorld(true)
}
