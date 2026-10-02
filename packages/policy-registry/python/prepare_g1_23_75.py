"""固定75/23契约适配；读取当前MJCF，不替换或写入机器人/惯性/碰撞模型。"""
from pathlib import Path
import hashlib
import json
import sys
import mujoco as mj
import numpy as np

root,source=map(Path,sys.argv[1:3]);weights=root/'deployment/policy.pt'
if weights.stat().st_size!=299424 or hashlib.sha256(weights.read_bytes()).hexdigest()!='1123d5348c5f7638363f7af24e5c243adedd8dcdfd2838127d388410f7b7ad47':raise ValueError('POLICY_ADAPTER_SOURCE_MISMATCH: 固定75来源权重字节不符')
names=['left_hip_pitch_joint','left_hip_roll_joint','left_hip_yaw_joint','left_knee_joint','left_ankle_pitch_joint','left_ankle_roll_joint','right_hip_pitch_joint','right_hip_roll_joint','right_hip_yaw_joint','right_knee_joint','right_ankle_pitch_joint','right_ankle_roll_joint','waist_yaw_joint','left_shoulder_pitch_joint','left_shoulder_roll_joint','left_shoulder_yaw_joint','left_elbow_joint','left_wrist_roll_joint','right_shoulder_pitch_joint','right_shoulder_roll_joint','right_shoulder_yaw_joint','right_elbow_joint','right_wrist_roll_joint']
defaults=[-.2,0,0,.42,-.23,0,-.2,0,0,.42,-.23,0,0,.35,.16,0,.87,0,.35,-.16,0,.87,0]
order=[0,6,12,1,7,2,8,3,9,13,18,4,10,14,19,5,11,15,20,16,21,17,22]
# pin中g1.py的真实驱动参数；当前源被动阻尼从model回读，避免重复加阻尼。
kps=[60,60,60,100,40,40,60,60,60,100,40,40,60,40,40,40,40,40,40,40,40,40,40]
effective_kds=[1,1,1,2,1,1,1,1,1,2,1,1,1,1,1,1,1,1,1,1,1,1,1]
model=mj.MjModel.from_xml_path(str(source))
ids=[i for i in range(model.njnt)if int(model.jnt_type[i])==int(mj.mjtJoint.mjJNT_HINGE)]
actual=[model.joint(i).name for i in ids]
if len(actual)!=23 or set(actual)!=set(names) or model.nu!=23:raise ValueError('POLICY_JOINT_SET_MISMATCH: 需要完整23关节与23执行器')
if np.any(model.body_gravcomp):raise ValueError('CONTROL_GRAVITY_MISMATCH')
site=model.site('imu_in_pelvis');body=model.body(int(model.site_bodyid[site.id]));free=[i for i in range(model.njnt)if int(model.jnt_type[i])==int(mj.mjtJoint.mjJNT_FREE)and int(model.jnt_bodyid[i])==body.id]
if len(free)!=1 or not np.allclose(site.quat,[1,0,0,0]):raise ValueError('POLICY_OBSERVATION_SOURCE_MISSING: 需要pelvis自由根与原始IMU坐标')
native=[];kds=[];passive=[]
for name,kp,kd in zip(names,kps,effective_kds):
 jid=model.joint(name).id;acts=[i for i in range(model.nu)if int(model.actuator_trnid[i,0])==jid]
 if len(acts)!=1:raise ValueError('POLICY_ACTUATOR_MAPPING_MISMATCH: '+name)
 aid=acts[0]
 if not np.allclose(model.actuator_gear[aid],[1,0,0,0,0,0])or not np.allclose(model.actuator_gainprm[aid,:3],[1,0,0])or np.any(model.actuator_biasprm[aid]):raise ValueError('POLICY_NATIVE_DRIVE_UNSUPPORTED: 只支持保留现有gear1 motor的原生PD')
 damping=float(model.dof_damping[model.jnt_dofadr[jid]]);remaining=kd-damping
 if remaining<0:raise ValueError('POLICY_DAMPING_MISMATCH: '+name)
 passive.append(damping);kds.append(remaining);native.append(model.actuator(aid).name)
config={'num_obs':75,'num_actions':23,'simulation_dt':.005,'control_decimation':4,'action_scale':.5,'default_angles':defaults,'policy_joint_indices':order,'kps':kps,'kds':kds,'effective_kds':effective_kds,'passive_damping':passive,'control_semantics':'position_pd','behavior_validation':{'status':'candidate-evidence-scoped','defaultDurationS':3,'defaultAbsCommand':.3,'longDistanceVerified':False,'behaviorVerified':False,'testedModelSha256':'8ca62fcccdca91a431ca04f1a42f9c2fda241fdd5e13411168dc82de00f978de','currentModelSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'currentModelMatchesEvidence':hashlib.sha256(source.read_bytes()).hexdigest()=='8ca62fcccdca91a431ca04f1a42f9c2fda241fdd5e13411168dc82de00f978de','requiresWorldBindingValidation':True},'gravity_world':[0,0,-1],'weights_sha256':'1123d5348c5f7638363f7af24e5c243adedd8dcdfd2838127d388410f7b7ad47','joint_ranges':[model.jnt_range[model.joint(name).id].tolist() if model.jnt_limited[model.joint(name).id]else None for name in names]}
config['has_own_static_plane']=any(int(model.geom_type[i])==int(mj.mjtGeom.mjGEOM_PLANE)and int(model.geom_bodyid[i])==0 and (model.geom_contype[i]or model.geom_conaffinity[i])for i in range(model.ngeom))
config['physics_profile']={'currentArmature':[float(model.dof_armature[model.jnt_dofadr[model.joint(name).id]])for name in names],
 'deploymentArmature':[.01017752004,.025101925,.01017752004,.025101925,.00721945,.00721945,.01017752004,.025101925,.01017752004,.025101925,.00721945,.00721945,.01017752004,*([.003609725]*10)],
 'currentPassiveDamping':passive,'deploymentPassiveDamping':effective_kds,
 'currentJointFrictionloss':[float(model.dof_frictionloss[model.jnt_dofadr[model.joint(name).id]])for name in names],'deploymentJointFrictionloss':[.1]*23,
 'nativeWorldIntegrator':'implicitfast','deploymentIntegrator':'Euler/eulerdamp-disabled','compatibility':'candidate-evidence-scoped;current-world-behavior-not-validated'}
print(json.dumps({'adapter':'jlog-g1-23-75-torchscript-v1','robot':'unitree-g1-23dof','engine':'mujoco','supportedEngines':['mujoco'],'modelPath':str(source),'modelSourcePath':str(source),'weightsPath':str(weights),'config':config,'jointNames':names,'modelJointNames':names,'modelActuatorNames':native,'rootBody':body.name,'unit':'rad','controlMode':'position','frequencyHz':50,'inferenceFormat':'torchscript','observations':{'type':'STATE','shape':[75],'order':['imuProjectedGravity','velocityCommandMpsRadps','jointPositionRelativeInPolicyOrder','jointVelocityInPolicyOrder','previousActionInPolicyOrder'],'quaternion':'xyzw'},'physicsPreserved':['currentMJCFBytes','body_mass','body_inertia','geom_type','geom_size','jnt_range','actuator_gear','effortLimits'],'gravityCompensation':False},allow_nan=False))
