import type { HumanDefinition, HumanRigJoint, Vec3 } from '../../lyapunov-contracts/src/types.ts'
export const IDENTITY = { position: [0,0,0] as Vec3, quaternion: [0,0,0,1] as [number,number,number,number], scale: [1,1,1] as Vec3 }
export function proceduralHuman(heightM = 1.75): HumanDefinition {
  if (!Number.isFinite(heightM) || heightM < .8 || heightM > 2.3) throw Error('HUMAN_HEIGHT_INVALID: 身高须为0.8至2.3米')
  const factor=heightM/1.75
  const rows: Array<[string,string|undefined,Vec3]> = [
    ['pelvis',undefined,[0,0,.95]],['spine','pelvis',[0,0,.18]],['chest','spine',[0,0,.23]],['neck','chest',[0,0,.14]],['head','neck',[0,0,.12]],
    ['leftHip','pelvis',[0,.105,0]],['leftKnee','leftHip',[0,0,-.42]],['leftAnkle','leftKnee',[0,0,-.43]],['leftToe','leftAnkle',[.14,0,-.045]],
    ['rightHip','pelvis',[0,-.105,0]],['rightKnee','rightHip',[0,0,-.42]],['rightAnkle','rightKnee',[0,0,-.43]],['rightToe','rightAnkle',[.14,0,-.045]],
    ['leftShoulder','chest',[0,.21,0]],['leftElbow','leftShoulder',[0,.03,-.29]],['leftWrist','leftElbow',[0,0,-.27]],
    ['rightShoulder','chest',[0,-.21,0]],['rightElbow','rightShoulder',[0,-.03,-.29]],['rightWrist','rightElbow',[0,0,-.27]],
  ]
  const rig: HumanRigJoint[]=rows.map(([name,parent,p])=>({name,...parent?{parent}:{},offsetM:p.map(v=>v*factor) as Vec3,quaternionXyzw:[0,0,0,1]}))
  return {schema:1,mode:'kinematic',collision:'detailed',rig,boneMapping:Object.fromEntries(rig.map(j=>[j.name,j.name])),clips:[],source:{kind:'procedural',license:'Apache-2.0',attribution:'Lyapunov原创程序化骨架与蒙皮人偶',sourceUpAxis:'Z'},heightM,phase:0}
}
/** 声明驱动碰撞的语义边。粗模式仍保留完整骨架/外观，只降低碰撞段数。 */
export const HUMAN_SEGMENTS = [
 ['pelvis','spine',.12],['spine','chest',.14],['chest','neck',.115],['neck','head',.09],
 ['leftHip','leftKnee',.065],['leftKnee','leftAnkle',.05],['leftAnkle','leftToe',.055],['rightHip','rightKnee',.065],['rightKnee','rightAnkle',.05],['rightAnkle','rightToe',.055],
 ['leftShoulder','leftElbow',.045],['leftElbow','leftWrist',.037],['rightShoulder','rightElbow',.045],['rightElbow','rightWrist',.037],
] as const
export function randomSource(seed: number):()=>number { let state=seed>>>0; return ()=>{state=(state+0x6d2b79f5)>>>0;let x=state;x=Math.imul(x^(x>>>15),x|1);x^=x+Math.imul(x^(x>>>7),x|61);return ((x^(x>>>14))>>>0)/4294967296} }
