import {useEffect,useState} from 'react'
import type {JointDescription,RobotDescription} from '../../sim-contract/src/index.ts'
import type {Translate} from './entity-editor.tsx'
export function jointTargetError(joint:JointDescription|undefined,value:unknown):string|undefined {
 if(!joint)return 'JOINT_DESCRIPTION_REQUIRED'
 if(typeof value!=='number'||!Number.isFinite(value))return 'JOINT_TARGET_NOT_FINITE'
 if(joint.range){const [min,max]=joint.range;if(!Number.isFinite(min)||!Number.isFinite(max)||min>max)return 'JOINT_LIMIT_INVALID';if(value<min||value>max)return 'JOINT_TARGET_OUT_OF_RANGE'}
}
export function fullJointTargetErrors(description:RobotDescription,targets:Record<string,number>):Array<{name:string;code:string}>{
 return description.controlledJointNames.flatMap(name=>{const code=jointTargetError(description.joints.find(j=>j.name===name),targets[name]);return code?[{name,code}]:[]})
}
export function requireFullJointTargets(description:RobotDescription,targets:Record<string,number>):number[]{
 const errors=fullJointTargetErrors(description,targets)
 if(errors.length)throw Error(errors.map(e=>`${e.code}: ${e.name}`).join('；'))
 return description.controlledJointNames.map(name=>targets[name]!)
}
export function JointTargetInput({joint,value,set,tr,disabled=false}:{joint:JointDescription;value:number;set:(value:number)=>void;tr:Translate;disabled?:boolean}){
 const [text,setText]=useState(Number.isFinite(value)?String(value):'')
 useEffect(()=>{if(Number.isFinite(value)&&Number(text)!==value)setText(String(value))},[value])
 const parsed=text.trim()?Number(text):Number.NaN,code=jointTargetError(joint,parsed)
 return <span><input type="text" inputMode="decimal" aria-label={tr('关节目标 ','Joint target ')+joint.name} aria-invalid={Boolean(code)} disabled={disabled} value={text} onChange={event=>{const raw=event.target.value;setText(raw);set(raw.trim()?Number(raw):Number.NaN)}}/>{code&&<small role="alert" className="lya-error">{code==='JOINT_TARGET_OUT_OF_RANGE'?tr(`超出实际限位 [${joint.range![0]}, ${joint.range![1]}] ${joint.unit}`,`Outside the declared limits [${joint.range![0]}, ${joint.range![1]}] ${joint.unit}`):tr('请输入有限数值；草稿未提交。','Enter a finite value; this draft was not submitted.')}</small>}</span>
}
