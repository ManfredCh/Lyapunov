import {createHash} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
/** Khronos官方小型外部资产；只固定原始对象，不把许可证声明替换成程序化人偶。 */
export const CESIUM_MAN_SAMPLE={
 repository:'KhronosGroup/glTF-Sample-Assets',revision:'4995a638c96dbc94376d3d6164e70fee3ac7f7a2',license:'CC-BY-4.0',attribution:'© 2017 Cesium. CC-BY-4.0. Original Cesium mark retained; no endorsement claimed.',sourceUpAxis:'Y' as const,headingOffsetRad:Math.PI/2,
 files:[
  {path:'Models/CesiumMan/glTF-Binary/CesiumMan.glb',name:'CesiumMan.glb',bytes:438044,sha256:'b7001eaeea8254bd44773bcd247e78696d94169388fbb2a1800fc69434e777d9'},
  {path:'Models/CesiumMan/README.md',name:'origin-license.txt',bytes:1146,sha256:'1bf7fa794013d2e0de8c244518936b04d95cba780f4510c8cceee4c23dbc04a8'},
  {path:'LICENSES/LicenseRef-LegalMark-Cesium.txt',name:'origin-mark-notice.txt',bytes:625,sha256:'7bafc8dbff0b9d04297bced53a47809e3ab6721cb35b4a2d780533476b28ebd4'},
 ],
 boneMapping:{pelvis:'Skeleton_torso_joint_1',spine:'Skeleton_torso_joint_2',chest:'torso_joint_3',neck:'Skeleton_neck_joint_1',head:'Skeleton_neck_joint_2',leftHip:'leg_joint_L_1',leftKnee:'leg_joint_L_2',leftAnkle:'leg_joint_L_3',leftToe:'leg_joint_L_5',rightHip:'leg_joint_R_1',rightKnee:'leg_joint_R_2',rightAnkle:'leg_joint_R_3',rightToe:'leg_joint_R_5',leftShoulder:'Skeleton_arm_joint_L__4_',leftElbow:'Skeleton_arm_joint_L__3_',leftWrist:'Skeleton_arm_joint_L__2_',rightShoulder:'Skeleton_arm_joint_R',rightElbow:'Skeleton_arm_joint_R__2_',rightWrist:'Skeleton_arm_joint_R__3_'},
}
export async function acquireCesiumMan(directory:string,fetchMissing=false):Promise<string>{
 await mkdir(directory,{recursive:true});const files=[]
 for(const file of CESIUM_MAN_SAMPLE.files){const path=join(directory,file.name);let bytes:Buffer|undefined,fetched=false;try{bytes=await readFile(path)}catch{}
  const url=`https://raw.githubusercontent.com/${CESIUM_MAN_SAMPLE.repository}/${CESIUM_MAN_SAMPLE.revision}/${file.path}`
  if(!bytes){if(!fetchMissing)throw Error('HUMAN_SAMPLE_ASSET_MISSING: '+path+'；显式--fetch只获取固定官方438KB样例与许可')
   const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('HUMAN_SAMPLE_FETCH_FAILED: '+response.status+' '+url);const length=Number(response.headers.get('content-length'));if(length&&length>4*1024*1024)throw Error('HUMAN_SAMPLE_SIZE_LIMIT');bytes=Buffer.from(await response.arrayBuffer());fetched=true;if(bytes.length>4*1024*1024)throw Error('HUMAN_SAMPLE_SIZE_LIMIT')}
  const sha256=createHash('sha256').update(bytes).digest('hex');if(bytes.length!==file.bytes||sha256!==file.sha256)throw Error('HUMAN_SAMPLE_HASH_MISMATCH: '+file.path)
  if(fetched)await writeFile(path,bytes);files.push({...file,url,local:path})
 }
 await writeFile(join(directory,'source.json'),JSON.stringify({...CESIUM_MAN_SAMPLE,files},null,2));return join(directory,'CesiumMan.glb')
}
