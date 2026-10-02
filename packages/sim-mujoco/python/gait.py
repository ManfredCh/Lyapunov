"""原 quadruped-gait 的平面二连杆几何/对角步态，移至 native Provider。
关节微扰仅作用私有 MjData 校准副本；运行时仅输出完整命名目标。
"""
import math
import mujoco as mj
import numpy as np

def bend(l1,l2,r):return math.acos(np.clip((r*r-l1*l1-l2*l2)/(2*l1*l2),-1,1))
def beta(l1,l2,b):return math.atan2(l2*math.sin(b),l1+l2*math.cos(b))
def calibrate(model,data,info,groups):
    if len(groups)!=4:raise ValueError('步态需要四组三关节映射')
    probe=mj.MjData(model);probe.qpos[:]=data.qpos;mj.mj_forward(model,probe)
    base=info['body'];rotation=probe.xmat[base].reshape(3,3).T;legs=[]
    for names in groups:
        if len(names)!=3:raise ValueError('每条腿需abduction/thigh/knee三个关节')
        abd,thigh,knee=names;tj,kj=info['joints'][thigh],info['joints'][knee]
        hip=int(model.jnt_bodyid[tj['id']]);kb=int(model.jnt_bodyid[kj['id']])
        geoms=[i for i in range(model.ngeom) if model.geom_bodyid[i]==kb]
        foot=max(geoms,key=lambda i:np.linalg.norm(probe.geom_xpos[i]-probe.xpos[kb]))
        def measure():
            p=rotation@(probe.geom_xpos[foot]-probe.xpos[hip]);return float(p[0]),float(-p[2]),float(p[1])
        fore,depth,lat=measure();l1=float(np.linalg.norm(probe.xpos[kb]-probe.xpos[hip]));l2=float(np.linalg.norm(probe.geom_xpos[foot]-probe.xpos[kb]))
        if abs(lat)>.005 or min(l1,l2)<.01:raise ValueError('该腿不是已支持的平面二连杆')
        r=math.hypot(fore,depth);b0=bend(l1,l2,r);alpha=math.atan2(fore,depth)
        kp=rotation@(probe.xpos[kb]-probe.xpos[hip]);td=math.atan2(kp[0],-kp[2]);bs=1 if alpha-td>=0 else -1
        hth=float(probe.qpos[tj['qpos']]);hk=float(probe.qpos[kj['qpos']]);hab=float(probe.qpos[info['joints'][abd]['qpos']])
        probe.qpos[tj['qpos']]=hth+.15;mj.mj_forward(model,probe);ft,dt,lt=measure();da=math.atan2(ft,dt)-alpha
        if abs(abs(da)-.15)>.0045 or abs(lt)>.005:raise ValueError('大腿关节几何不满足平面步态')
        probe.qpos[tj['qpos']]=hth;probe.qpos[kj['qpos']]=hk+.15;mj.mj_forward(model,probe);fk,dk,lk=measure();db=bend(l1,l2,math.hypot(fk,dk))-b0
        if abs(abs(db)-.15)>.0045 or abs(lk)>.005:raise ValueError('膝关节几何不满足平面步态')
        probe.qpos[kj['qpos']]=hk;mj.mj_forward(model,probe)
        corner=rotation@(probe.xpos[hip]-probe.xpos[base]);lateral=1 if corner[1]>0 else -1
        legs.append(dict(names=names,home=[hab,hth,hk],l1=l1,l2=l2,fore=fore,depth=depth,b0=b0,td=td,bs=bs,ss=1 if da>0 else -1,ks=1 if db>0 else -1,lateral=lateral,phase=0 if corner[0]*lateral>0 else math.pi))
    return legs

def targets(legs,time_s,forward,turn,frequency=1.8,stride=.12,lift=.05):
    result={};walking=abs(forward)+abs(turn)>1e-9
    for leg in legs:
        phase=2*math.pi*frequency*time_s+leg['phase'];speed=float(np.clip(forward-turn*leg['lateral'],-1,1))
        fore=leg['fore']+stride/2*-math.cos(phase)*speed;depth=leg['depth']-lift*max(0,math.sin(phase))*walking
        r=float(np.clip(math.hypot(fore,depth),abs(leg['l1']-leg['l2'])+.02,leg['l1']+leg['l2']-.02));b=bend(leg['l1'],leg['l2'],r);td=math.atan2(fore,depth)-leg['bs']*beta(leg['l1'],leg['l2'],b)
        result.update(zip(leg['names'],[leg['home'][0],leg['home'][1]+leg['ss']*(td-leg['td']),leg['home'][2]+leg['ks']*(b-leg['b0'])]))
    return result
