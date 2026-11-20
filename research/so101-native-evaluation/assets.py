"""同一批验证箱、杯、夹具和原生机器人编译，另含封腔和坏关节反例。"""

import argparse
import json
from math import cos, pi, sin
from pathlib import Path
import mujoco as mj


def box(name, pos, size, yaw=0):
    return f'<geom type="box" name="{name}" pos="{pos}" size="{size}" euler="0 0 {yaw}"/>'


def container(kind):
    edges = ''
    if kind == 'box':
        edges = ''.join(box('wall'+str(i),pos,size) for i,(pos,size) in enumerate([
            ('.035 0 .019','.003 .038 .017'),('-.035 0 .019','.003 .038 .017'),
            ('0 .035 .019','.032 .003 .017'),('0 -.035 .019','.032 .003 .017')]))
    elif kind == 'cup':
        for i in range(12):
            yaw = i*pi/6
            edges += box('rim'+str(i),f'{.033*cos(yaw)} {.033*sin(yaw)} .019','.003 .010 .017',yaw)
    elif kind == 'blocked':
        edges = box('bad-solid-fill','0 0 .02','.034 .034 .018')
    return '<body name="container">'+box('floor','0 0 .002','.038 .038 .002')+edges+'</body>'


def drop(kind):
    xml = '<mujoco><compiler angle="radian"/><option timestep=".002"/><worldbody><geom name="plane" type="plane" size="1 1 .01"/>'+container(kind)+'''<body name="probe" pos="0 0 .12"><freejoint/><geom name="probe-geom" type="sphere" size=".009" mass=".02"/></body></worldbody></mujoco>'''
    model = mj.MjModel.from_xml_string(xml)
    data = mj.MjData(model)
    start_z = .12
    for _ in range(600):
        mj.mj_step(model,data)
    mj.mj_forward(model,data)
    z = float(data.body('probe').xpos[2])
    contacts = [[model.geom(int(i)).name for i in c.geom] for c in data.contact if c.efc_address >= 0]
    insertion = abs(z-.013) < .001 and any({'probe-geom','floor'} == set(c) for c in contacts)
    return {'scenario':kind,'expected':kind!='blocked','passedCavity':insertion,'startZM':start_z,'finalZM':z,
            'contacts':contacts,'steps':600,'dtS':.002}


def hinge(upper):
    model = mj.MjModel.from_xml_string(f'''<mujoco><compiler angle="radian"/><option timestep=".002"/><worldbody>
    <body name="fixture" pos="0 0 .04"><joint name="hinge" type="hinge" axis="0 0 1" range="-.6 {upper}" damping="1"/>
    <geom type="box" pos=".03 0 0" size=".03 .01 .008" mass=".08"/></body></worldbody>
    <actuator><position name="drive" joint="hinge" kp="30" ctrlrange="-.6 .6"/></actuator></mujoco>''')
    data = mj.MjData(model)
    ends = []
    for x in (-.6,.6):
        data.ctrl[0] = x
        for _ in range(600):
            mj.mj_step(model,data)
        ends.append(float(data.qpos[0]))
    return {'scenario':'fixture' if upper==.6 else 'limited-fixture','expected':upper==.6,
            'passedTravel':abs(ends[0]+.6)<.015 and abs(ends[1]-.6)<.015,'endsRad':ends,'compiledRangeRad':model.jnt_range[0].tolist()}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--model',type=Path,required=True)
    p.add_argument('--out',type=Path,required=True)
    args=p.parse_args()
    model=mj.MjModel.from_xml_path(str(args.model))
    arm = {'joints':{model.joint(i).name:model.jnt_range[i].tolist() for i in range(model.njnt)},'actuators':model.nu,'geoms':model.ngeom}
    drops=[drop(k) for k in ('box','cup','blocked')]
    hinges=[hinge(k) for k in (.6,.15)]
    result={'mujoco':mj.__version__,'so101':arm,'drops':drops,'travel':hinges}
    args.out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    assert arm['actuators']==6 and len(arm['joints'])==6
    assert all(x['expected']==x['passedCavity'] for x in drops)
    assert all(x['expected']==x['passedTravel'] for x in hinges)
    print('MJCF 构型、空腔落体、夹具行程及两个反例通过')


if __name__=='__main__':
    main()
