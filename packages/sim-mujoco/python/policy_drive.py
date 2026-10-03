"""已登记75来源的显式运行时驱动适配；仅私有MjSpec，源模型和身体参数保持只读。"""
import mujoco as mj
import numpy as np

ADAPTER='jlog-g1-23-75-torchscript-v1'
REVISION='fbfa38706b817e2d4b19e444db95ae7fb2537b46'
WEIGHTS='1123d5348c5f7638363f7af24e5c243adedd8dcdfd2838127d388410f7b7ad47'

def apply_policy_drive(spec,controller):
    flag=controller.get('nativePositionPD')
    if flag is None:return
    if not isinstance(flag,dict) or controller.get('policyAdapter')!=ADAPTER or flag.get('revision')!=REVISION or flag.get('weightsSha256')!=WEIGHTS:
        raise ValueError('POLICY_DRIVE_ADAPTER_UNSUPPORTED: 原生PD仅支持明确登记的75来源')
    before=spec.compile()
    if before.nu!=23:raise ValueError('POLICY_DRIVE_JOINT_SET_MISMATCH')
    preserved=['body_mass','body_inertia','body_pos','body_quat','geom_type','geom_size','geom_contype','geom_conaffinity','geom_friction','jnt_range','dof_armature','dof_damping','actuator_gear']
    original={key:getattr(before,key).copy() for key in preserved}
    for aid in range(before.nu):
        jid=int(before.actuator_trnid[aid,0]);name=before.joint(jid).name;act=spec.actuator(before.actuator(aid).name)
        if not np.allclose(before.actuator_gear[aid],[1,0,0,0,0,0])or not np.allclose(before.actuator_gainprm[aid,:3],[1,0,0])or np.any(before.actuator_biasprm[aid]):raise ValueError('POLICY_DRIVE_SOURCE_NOT_GEAR1_MOTOR: '+name)
        kp=(controller.get('jointKp')or{}).get(name);kd=(controller.get('jointKd')or{}).get(name)
        if not isinstance(kp,(int,float))or not isinstance(kd,(int,float))or not np.isfinite([kp,kd]).all()or kp<=0 or kd<0:raise ValueError('POLICY_DRIVE_GAIN_MISSING: '+name)
        # gear1 motor旧ctrlrange是力矩预算；不能拿来当servo位置范围。
        ranges=[]
        if before.actuator_ctrllimited[aid]:ranges.append(before.actuator_ctrlrange[aid].copy())
        if before.actuator_forcelimited[aid]:ranges.append(before.actuator_forcerange[aid].copy())
        if before.jnt_actfrclimited[jid]:ranges.append(before.jnt_actfrcrange[jid].copy())
        if not ranges:raise ValueError('POLICY_DRIVE_EFFORT_LIMIT_MISSING: '+name)
        budget=[max(float(r[0])for r in ranges),min(float(r[1])for r in ranges)]
        if not np.isfinite(budget).all()or budget[0]>=budget[1]:raise ValueError('POLICY_DRIVE_EFFORT_LIMIT_INVALID: '+name)
        act.gaintype=mj.mjtGain.mjGAIN_FIXED;act.biastype=mj.mjtBias.mjBIAS_AFFINE;act.dyntype=mj.mjtDyn.mjDYN_NONE
        act.gainprm[:]=0;act.gainprm[0]=kp;act.biasprm[:]=0;act.biasprm[1]=-kp;act.biasprm[2]=-kd
        act.forcelimited=True;act.forcerange=budget
        act.ctrllimited=bool(before.jnt_limited[jid])
        if act.ctrllimited:act.ctrlrange=before.jnt_range[jid].copy()
    after=spec.compile()
    for key in preserved:np.testing.assert_array_equal(getattr(after,key),original[key],err_msg='POLICY_DRIVE_BODY_CHANGED: '+key)

def policy_diagnostics(world,info):
    key=(id(world.model),world.generation)
    cached=getattr(world,'_policy_plane_ids',None)
    if cached is None or cached[0]!=key:
        ids=[i for i in range(world.model.ngeom)if int(world.model.geom_type[i])==int(mj.mjtGeom.mjGEOM_PLANE)and (world.model.geom_contype[i]or world.model.geom_conaffinity[i])]
        cached=(key,ids);world._policy_plane_ids=cached
    duplicate=[]
    for at,gid in enumerate(cached[1]):
        normal=world.data.geom_xmat[gid].reshape(3,3)[:,2]
        for other in cached[1][at+1:]:
            other_normal=world.data.geom_xmat[other].reshape(3,3)[:,2]
            if float(np.dot(normal,other_normal))>1-1e-9 and abs(float(np.dot(world.data.geom_xpos[gid]-world.data.geom_xpos[other],normal)))<1e-8:
                duplicate.append([world.model.geom(gid).name,world.model.geom(other).name])
    return {'jointNames':list(info['joints']),'accelerationsRadps2':[float(world.data.qacc[j['dof']])for j in info['joints'].values()],
            'gravityWorldMps2':world.model.opt.gravity.tolist(),'engineWarningCounts':world.data.warning.number.tolist(),'duplicateCollisionPlanes':duplicate}
