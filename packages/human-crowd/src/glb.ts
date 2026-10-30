import { createHash } from 'node:crypto'
import { Matrix4, Quaternion, Vector3 } from 'three'
import type { HumanDefinition, HumanClip, HumanRigJoint, Quaternion as Q4, Vec3 } from '../../lyapunov-contracts/src/types.ts'
import { HUMAN_SEGMENTS } from './rig.ts'
/** 原创、小体积rigged GLB。每段方棱几何具有真实skin权重和逆绑定矩阵，不把胶囊截图叫逼真人体。 */
export function proceduralGlb(human:HumanDefinition):Buffer {
 const chunks:Buffer[]=[], views:object[]=[],accessors:object[]=[];let length=0
 const add=(data:Float32Array|Uint16Array,type:string,count:number)=>{const bytes=Buffer.from(data.buffer);const pad=(4-length%4)%4;if(pad){chunks.push(Buffer.alloc(pad));length+=pad}const offset=length;chunks.push(bytes);length+=bytes.length;views.push({buffer:0,byteOffset:offset,byteLength:bytes.length});const components=type==='VEC3'?3:type==='VEC4'?4:type==='MAT4'?16:1;const min=Array.from({length:components},(_,i)=>Math.min(...Array.from(data).filter((_,n)=>n%components===i)));const max=Array.from({length:components},(_,i)=>Math.max(...Array.from(data).filter((_,n)=>n%components===i)));accessors.push({bufferView:views.length-1,componentType:data instanceof Uint16Array?5123:5126,count,type,...type==='VEC3'?{min,max}:{}});return accessors.length-1}
 const world=new Map<string,Vector3>();for(const j of human.rig)world.set(j.name,new Vector3(...j.offsetM).add(j.parent?world.get(j.parent)!:new Vector3()))
 const positions:number[]=[], joints:number[]=[],weights:number[]=[],indices:number[]=[]
 const parts: Array<[string,string,number]>=[...HUMAN_SEGMENTS.map(([a,b,r])=>[a,b,r] as [string,string,number]),['head','head',.11]]
 for(const [a,b,r]of parts){const name=human.boneMapping[a]!,end=world.get(human.boneMapping[b]!)!,start=world.get(name)!,bone=human.rig.findIndex(j=>j.name===name),mid=start.clone().add(end).multiplyScalar(.5);const axis=end.clone().sub(start);const len=axis.length();const rotation=new Quaternion().setFromUnitVectors(new Vector3(0,0,1),len?axis.normalize():new Vector3(0,0,1));const base=positions.length/3;for(const x of[-1,1])for(const y of[-1,1])for(const z of[-1,1]){const p=new Vector3(x*r,y*r,z*(len*.5+r*.3)).applyQuaternion(rotation).add(mid);positions.push(...p.toArray());joints.push(bone,0,0,0);weights.push(1,0,0,0)}for(const tri of [[0,1,3],[0,3,2],[4,6,7],[4,7,5],[0,4,5],[0,5,1],[2,3,7],[2,7,6],[0,2,6],[0,6,4],[1,5,7],[1,7,3]])indices.push(...tri.map(i=>base+i))}
 const position=add(new Float32Array(positions),'VEC3',positions.length/3),joint=add(new Uint16Array(joints),'VEC4',joints.length/4),weight=add(new Float32Array(weights),'VEC4',weights.length/4),index=add(new Uint16Array(indices),'SCALAR',indices.length)
 const inverse=human.rig.flatMap(j=>new Matrix4().makeTranslation(...world.get(j.name)!.toArray()).invert().toArray()),ibm=add(new Float32Array(inverse),'MAT4',human.rig.length)
 const nodes:Record<string,unknown>[]=human.rig.map(j=>({name:j.name,translation:j.offsetM,rotation:j.quaternionXyzw,children:human.rig.flatMap((c,i)=>c.parent===j.name?[i]:[])}));nodes.push({name:'humanSkin',mesh:0,skin:0})
 const animations=[{name:'stand',duration:1,amplitude:0},{name:'walk',duration:1,amplitude:.45},{name:'run',duration:.65,amplitude:.8},{name:'turn',duration:1,amplitude:.4}].map(clip=>{const times=[0,.25,.5,.75,1].map(t=>t*clip.duration),time=add(new Float32Array(times),'SCALAR',times.length),samplers:object[]=[],channels:object[]=[];for(const [role,sign]of[['leftHip',1],['rightHip',-1],['leftShoulder',-.65],['rightShoulder',.65]]as const){const node=human.rig.findIndex(j=>j.name===human.boneMapping[role]);const values=times.flatMap((_,i)=>{const angle=Math.sin(i*Math.PI/2)*clip.amplitude*sign;return clip.name==='turn'?[0,0,Math.sin(angle/2),Math.cos(angle/2)]:[0,Math.sin(angle/2),0,Math.cos(angle/2)]});const output=add(new Float32Array(values),'VEC4',times.length);channels.push({sampler:samplers.length,target:{node,path:'rotation'}});samplers.push({input:time,output,interpolation:'LINEAR'})}return{name:clip.name,samplers,channels}})
 const json={animations,asset:{version:'2.0',generator:'Lyapunov human-crowd original'},scene:0,scenes:[{nodes:[...human.rig.flatMap((j,i)=>!j.parent?[i]:[]),nodes.length-1]}],nodes,skins:[{joints:human.rig.map((_,i)=>i),inverseBindMatrices:ibm}],meshes:[{primitives:[{attributes:{POSITION:position,JOINTS_0:joint,WEIGHTS_0:weight},indices:index,material:0}]}],materials:[{name:'原创低多边形人偶',pbrMetallicRoughness:{baseColorFactor:[.12,.42,.65,1],metallicFactor:0,roughnessFactor:.8}}],buffers:[{byteLength:length}],bufferViews:views,accessors}
 let j=Buffer.from(JSON.stringify(json));j=Buffer.concat([j,Buffer.alloc((4-j.length%4)%4,32)]);let bin=Buffer.concat(chunks);bin=Buffer.concat([bin,Buffer.alloc((4-bin.length%4)%4)]);const header=Buffer.alloc(12);header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(28+j.length+bin.length,8);const jc=Buffer.alloc(8);jc.writeUInt32LE(j.length);jc.writeUInt32LE(0x4e4f534a,4);const bc=Buffer.alloc(8);bc.writeUInt32LE(bin.length);bc.writeUInt32LE(0x004e4942,4);return Buffer.concat([header,jc,j,bc,bin])
}
export const HUMAN_GLB_MAX_BYTES=32*1024*1024
export function readRiggedGlb(bytes:Buffer,input:{boneMapping:Record<string,string>;license:string;sourceUpAxis:'Y'|'Z';attribution?:string;metersPerUnit?:number;headingOffsetRad?:number}):HumanDefinition {
 if(!input.license?.trim()||input.license==='unknown')throw Error('HUMAN_LICENSE_REQUIRED: 请提供角色及动作的使用许可声明')
 if(bytes.length>HUMAN_GLB_MAX_BYTES)throw Error('HUMAN_GLB_LIMIT: 首版只接受32MiB内的自包含角色')
 if(bytes.length<28||bytes.readUInt32LE(0)!==0x46546c67||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length)throw Error('HUMAN_GLB_INVALID')
 const jl=bytes.readUInt32LE(12);if(20+jl+8>bytes.length)throw Error('HUMAN_GLB_TRUNCATED')
 const gltf=JSON.parse(bytes.subarray(20,20+jl).toString()),bin=bytes.subarray(28+jl)
 if(gltf.buffers?.length!==1||gltf.buffers[0].uri||gltf.images?.some((i:{uri?:string})=>i.uri))throw Error('HUMAN_GLB_EXTERNAL_DEPENDENCY: 请先打包为自包含GLB')
 if(gltf.extensionsRequired?.length)throw Error('HUMAN_GLB_EXTENSION_UNSUPPORTED: '+gltf.extensionsRequired.join(','))
 const skin=gltf.skins;if(!Array.isArray(skin)||skin.length<1||skin.length>8)throw Error('HUMAN_SKIN_REQUIRED: 要求1至8个共享骨架的skin')
 type Node={name?:string;children?:number[];matrix?:number[];translation?:number[];rotation?:number[];scale?:number[]}
 const nodes=gltf.nodes as Node[];if(!Array.isArray(nodes)||nodes.length>10000)throw Error('HUMAN_GLB_NODE_LIMIT: GLB须有至多10000个有效节点')
 const parents=new Map<number,number>(),indegree=nodes.map(()=>0)
 for(const[i,node]of nodes.entries()){
  if(!node||typeof node!=='object'||node.children!==undefined&&!Array.isArray(node.children))throw Error('HUMAN_RIG_TREE_INVALID: 节点children须为索引数组')
  for(const child of node.children??[]){if(!Number.isInteger(child)||child<0||child>=nodes.length)throw Error('HUMAN_RIG_INDEX_INVALID: 子节点索引越界');if(parents.has(child))throw Error('HUMAN_RIG_MULTIPLE_PARENTS: 节点有重复或多个父节点');parents.set(child,i);indegree[child]!++}
 }
 const order=indegree.flatMap((n,i)=>n===0?[i]:[])
 for(let cursor=0;cursor<order.length;cursor++)for(const child of nodes[order[cursor]!]!.children??[]){indegree[child]!--;if(indegree[child]===0)order.push(child)}
 if(order.length!==nodes.length)throw Error('HUMAN_RIG_CYCLE: 骨架/场景节点存在循环')
 for(const item of skin)if(!Array.isArray(item?.joints)||!item.joints.length||new Set(item.joints).size!==item.joints.length||item.joints.some((i:unknown)=>!Number.isInteger(i)||Number(i)<0||Number(i)>=nodes.length)||item.skeleton!==undefined&&(!Number.isInteger(item.skeleton)||item.skeleton<0||item.skeleton>=nodes.length))throw Error('HUMAN_SKIN_JOINT_INVALID: skin关节索引须非空、唯一且在节点范围内')
 if(skin.length>1){const root=skin[0].skeleton,connected=new Set<number>(skin[0].joints);for(const item of skin.slice(1)){if(!(root!==undefined&&item.skeleton===root)&&!item.joints.some((i:number)=>connected.has(i)))throw Error('HUMAN_SKIN_HIERARCHY_UNSUPPORTED: 多skin须共享明确骨架，不能混合独立角色');for(const i of item.joints)connected.add(i)}}
 const skinJoints=new Set<number>(skin.flatMap((item:{joints:number[]})=>item.joints)),wanted=new Set<number>(skinJoints)
 // 未被网格加权的指尖骨仍可能有动作通道；保存同一骨架下全部真实通道，不静默丢弃。
 for(const animation of gltf.animations??[])for(const channel of animation.channels??[]){const i=channel.target?.node;if(!Number.isInteger(i)||i<0||i>=nodes.length)throw Error('HUMAN_ANIMATION_TARGET_UNSUPPORTED: 非法节点索引');if(wanted.has(i))continue;let parent=parents.get(i);while(parent!==undefined&&!skinJoints.has(parent))parent=parents.get(parent);if(parent!==undefined)wanted.add(i)}
 for(const i of[...wanted]){let p=parents.get(i);while(p!==undefined){wanted.add(p);p=parents.get(p)}}
 if(wanted.size>128)throw Error('HUMAN_RIG_LIMIT: 骨架最多128个节点')
 const names=new Map<number,string>();for(const i of wanted){if(!nodes[i]?.name||[...names.values()].includes(nodes[i]!.name!))throw Error('HUMAN_BONE_NAME_REQUIRED: 骨架节点须有唯一名字');names.set(i,nodes[i]!.name!)}
 const meters=input.metersPerUnit??1;if(!Number.isFinite(meters)||meters<=0||meters>1000)throw Error('HUMAN_UNIT_INVALID')
 const heading=input.headingOffsetRad??0;if(!Number.isFinite(heading))throw Error('HUMAN_HEADING_INVALID')
 const conversion=new Quaternion().setFromAxisAngle(new Vector3(0,0,1),heading).multiply(new Quaternion().setFromAxisAngle(new Vector3(1,0,0),input.sourceUpAxis==='Y'?Math.PI/2:0)),inverse=conversion.clone().invert(),rig:HumanRigJoint[]=[],parentScales=new Map<number,number>(),worldScale=new Map<number,number>(),restScales=new Map<number,number[]>(),worldPositions=new Map<string,Vector3>(),worldQuaternions=new Map<string,Quaternion>()
 const vector=(v:unknown,n:number,label:string,defaultValue:number[])=>{const a=v??defaultValue;if(!Array.isArray(a)||a.length!==n||!a.every(x=>typeof x==='number'&&Number.isFinite(x)))throw Error('HUMAN_RIG_TRANSFORM_INVALID: '+label);return a as number[]}
 for(const i of order.filter(i=>wanted.has(i))){
  const node=nodes[i]!,position=new Vector3(),rotation=new Quaternion(),scale=new Vector3(1,1,1)
  if(node.matrix){const values=vector(node.matrix,16,'matrix',[]),matrix=new Matrix4().fromArray(values);matrix.decompose(position,rotation,scale);const rebuilt=new Matrix4().compose(position,rotation,scale);if(matrix.elements.some((v,k)=>Math.abs(v-rebuilt.elements[k]!)>1e-5))throw Error('HUMAN_RIG_SHEAR_UNSUPPORTED: '+node.name)}
  else{position.fromArray(vector(node.translation,3,'translation',[0,0,0]));rotation.fromArray(vector(node.rotation,4,'rotation',[0,0,0,1]));scale.fromArray(vector(node.scale,3,'scale',[1,1,1]))}
  if(Math.abs(rotation.length()-1)>1e-4||Math.min(...scale.toArray())<=0||Math.max(...scale.toArray())-Math.min(...scale.toArray())>1e-5)throw Error('HUMAN_RIG_NONUNIFORM_SCALE_UNSUPPORTED: '+node.name)
  rotation.normalize();const parent=parents.get(i),parentScale=parent===undefined?1:worldScale.get(parent)!;parentScales.set(i,parentScale);worldScale.set(i,parentScale*(scale.x+scale.y+scale.z)/3);restScales.set(i,scale.toArray())
  const offset=position.multiplyScalar(parentScale*meters).applyQuaternion(conversion),q=conversion.clone().multiply(rotation).multiply(inverse),name=names.get(i)!,parentName=parent===undefined?undefined:names.get(parent)
  rig.push({name,...parentName?{parent:parentName}:{},offsetM:offset.toArray() as Vec3,quaternionXyzw:q.toArray() as Q4})
  const wp=offset.clone(),wq=q.clone();if(parentName){wp.applyQuaternion(worldQuaternions.get(parentName)!).add(worldPositions.get(parentName)!);wq.premultiply(worldQuaternions.get(parentName)!)}worldPositions.set(name,wp);worldQuaternions.set(name,wq)
 }
 const required=[...new Set(HUMAN_SEGMENTS.flatMap(s=>[s[0],s[1]]))];for(const role of required)if(!rig.some(j=>j.name===input.boneMapping[role]))throw Error('HUMAN_BONE_MAPPING_MISSING: '+role)
 const accessor=(id:number,size:number)=>{
  const a=gltf.accessors?.[id],v=gltf.bufferViews?.[a?.bufferView];if(!a||!v||a.componentType!==5126||a.sparse||a.type!==({1:'SCALAR',3:'VEC3',4:'VEC4'} as Record<number,string>)[size]||!Number.isInteger(a.count)||a.count<1||a.count>1000000)throw Error('HUMAN_ANIMATION_ACCESSOR_UNSUPPORTED')
  const start=(v.byteOffset??0)+(a.byteOffset??0),stride=v.byteStride??size*4;if(!Number.isInteger(stride)||stride<size*4||start+(a.count-1)*stride+size*4>bin.length)throw Error('HUMAN_GLB_TRUNCATED')
  return Array.from({length:a.count*size},(_,k)=>bin.readFloatLE(start+Math.floor(k/size)*stride+(k%size)*4))
 }
 const clips:HumanClip[]=(gltf.animations??[]).map((animation:any,ci:number)=>{
  let durationS=0,maxUnitScaleDeviation=0,normalizedUnitScales=0;const tracks:HumanClip['tracks']=[],translations:NonNullable<HumanClip['translations']>=[]
  for(const channel of animation.channels){
   const ni=channel.target?.node,path=channel.target?.path;if(!wanted.has(ni))throw Error('HUMAN_ANIMATION_TARGET_UNSUPPORTED: '+String(nodes[ni]?.name??ni)+'/'+path)
   if(!['rotation','translation','scale'].includes(path))throw Error('HUMAN_ANIMATION_PATH_UNSUPPORTED: '+path)
   const sampler=animation.samplers[channel.sampler];if(!sampler||!['LINEAR','STEP',undefined].includes(sampler.interpolation))throw Error('HUMAN_ANIMATION_INTERPOLATION_UNSUPPORTED')
   const timesS=accessor(sampler.input,1),size=path==='rotation'?4:3,values=accessor(sampler.output,size);if(values.length!==timesS.length*size||timesS.some((t,k)=>!Number.isFinite(t)||t<0||k>0&&t<=timesS[k-1]!)||!values.every(Number.isFinite))throw Error('HUMAN_ANIMATION_TIME_INVALID')
   durationS=Math.max(durationS,timesS.at(-1)!);const interpolation=(sampler.interpolation??'LINEAR') as 'LINEAR'|'STEP',joint=names.get(ni)!
   if(path==='rotation'){const rotationsXyzw=timesS.map((_,k)=>{const q=new Quaternion(...values.slice(k*4,k*4+4) as Q4);if(Math.abs(q.length()-1)>1e-3)throw Error('HUMAN_ANIMATION_QUATERNION_INVALID');return conversion.clone().multiply(q.normalize()).multiply(inverse).toArray() as Q4});tracks.push({joint,timesS,rotationsXyzw,interpolation})}
   else if(path==='translation'){const positionsM=timesS.map((_,k)=>new Vector3(...values.slice(k*3,k*3+3) as Vec3).multiplyScalar(parentScales.get(ni)!*meters).applyQuaternion(conversion).toArray() as Vec3);translations.push({joint,timesS,positionsM,interpolation})}
   else{const rest=restScales.get(ni)!;const deviation=Math.max(...values.map((v,k)=>Math.abs(v-rest[k%3]!)));maxUnitScaleDeviation=Math.max(maxUnitScaleDeviation,deviation);if(deviation>1e-5)throw Error('HUMAN_ANIMATION_SCALE_UNSUPPORTED: '+joint+'（非数值噪声的伸缩未适配）');normalizedUnitScales++}
  }
  if(!durationS||!tracks.length)throw Error('HUMAN_ANIMATION_EMPTY')
  return{name:animation.name??`clip_${ci}`,durationS,tracks,translations,channelReport:{total:animation.channels.length,rotations:tracks.length,translations:translations.length,normalizedUnitScales,maxUnitScaleDeviation}}
 })
 const definition:HumanDefinition={schema:1,mode:'kinematic',collision:'detailed',rig,boneMapping:{...input.boneMapping},clips,source:{kind:'rigged-glb',license:input.license,...input.attribution?{attribution:input.attribution}:{},sourceUpAxis:input.sourceUpAxis,metersPerUnit:meters,headingOffsetRad:heading,sha256:createHash('sha256').update(bytes).digest('hex')},heightM:Math.max(...[...worldPositions.values()].map(v=>v.z))+.12,phase:0}
 const foot=gltf.asset.extras?.lyapunovHumanFootCapsules
 if(foot!==undefined){
  if(!foot||foot.schema!==1||!/^([a-f0-9]{64})$/.test(foot.sourceSha256)||typeof foot.method!=='string'||!foot.method.trim()||!foot.segments||typeof foot.segments!=='object'||Array.isArray(foot.segments))throw Error('HUMAN_FOOT_CALIBRATION_INVALID')
  const segments:NonNullable<HumanDefinition['footCollision']>['segments']={}
  for(const[key,row]of Object.entries(foot.segments)as Array<[string,any]>){const role=key==='leftAnkle-leftToe'?'leftAnkle':key==='rightAnkle-rightToe'?'rightAnkle':undefined;if(!role||row.frameJoint!==input.boneMapping[role]||!Array.isArray(row.endpointsM)||row.endpointsM.length!==2||row.endpointsM.some((v:any)=>!Array.isArray(v)||v.length!==3||!v.every((x:unknown)=>typeof x==='number'&&Number.isFinite(x))||Math.hypot(...v)>1)||typeof row.radiusM!=='number'||!Number.isFinite(row.radiusM)||row.radiusM<.003||row.radiusM>.15)throw Error('HUMAN_FOOT_CALIBRATION_INVALID: '+key);const endpoints=row.endpointsM.map((v:Vec3)=>new Vector3(...v).multiplyScalar(meters).applyQuaternion(conversion).toArray())as[Vec3,Vec3];if(new Vector3(...endpoints[0]).distanceTo(new Vector3(...endpoints[1]))<1e-6)throw Error('HUMAN_FOOT_CALIBRATION_INVALID: 端点重合');segments[key as keyof typeof segments]={frameJoint:row.frameJoint,endpointsM:endpoints,radiusM:row.radiusM*meters}}
  definition.footCollision={schema:1,sourceSha256:foot.sourceSha256,method:foot.method,segments}
 }
 for(const clip of clips){const sample=sampleImportedRig(definition,clip,0),baseline=sample.get(input.boneMapping.pelvis!)!,end=sampleImportedRig(definition,clip,clip.durationS).get(input.boneMapping.pelvis!)!,drift=end.clone().sub(baseline);drift.z=0;clip.rootMotion={joint:input.boneMapping.pelvis!,horizontal:'remove-drift',baselineM:baseline.toArray() as Vec3,driftM:drift.toArray() as Vec3}}
 if(!Number.isFinite(definition.heightM)||definition.heightM<.5||definition.heightM>3)throw Error('HUMAN_RIG_SCALE_INVALID: 请提供正确metersPerUnit和脚底参考的人体')
 return definition
}
/** 导入时的根轨迹基线；运行时以相同原始track采样，不删除髋部起伏。 */
export function sampleImportedRig(human:HumanDefinition,clip:HumanClip,time:number):Map<string,Vector3>{
 const positions=new Map<string,Vector3>(),rotations=new Map<string,Quaternion>()
 const slot=(track:{timesS:number[];interpolation:string})=>{const next=track.timesS.findIndex(t=>t>time),i=next<0?track.timesS.length-1:Math.max(0,next-1),j=Math.min(i+1,track.timesS.length-1);return{i,j,u:j===i||track.interpolation==='STEP'?0:Math.max(0,Math.min(1,(time-track.timesS[i]!)/(track.timesS[j]!-track.timesS[i]!)))}}
 for(const joint of human.rig){const rt=clip.tracks.find(t=>t.joint===joint.name),tt=clip.translations?.find(t=>t.joint===joint.name);let p=new Vector3(...joint.offsetM),q=new Quaternion(...joint.quaternionXyzw);if(tt){const s=slot(tt);p=new Vector3(...tt.positionsM[s.i]!).lerp(new Vector3(...tt.positionsM[s.j]!),s.u)}if(rt){const s=slot(rt);q=new Quaternion(...rt.rotationsXyzw[s.i]!).slerp(new Quaternion(...rt.rotationsXyzw[s.j]!),s.u)}if(joint.parent){p.applyQuaternion(rotations.get(joint.parent)!).add(positions.get(joint.parent)!);q.premultiply(rotations.get(joint.parent)!)}positions.set(joint.name,p);rotations.set(joint.name,q)}return positions
}
