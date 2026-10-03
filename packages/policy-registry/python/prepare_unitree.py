"""将官方力矩 PD 控制等价表达为 MuJoCo position actuator；原件保持只读。"""
import json
import sys
from pathlib import Path
import xml.etree.ElementTree as ET
import numpy as np
import mujoco
import yaml

root, output = map(Path, sys.argv[1:3])
config = yaml.safe_load((root / 'deploy/deploy_mujoco/configs/g1.yaml').read_text())
source = root / 'resources/robots/g1_description/g1_12dof.xml'
tree = ET.parse(source)
model = tree.getroot()
model.find('compiler').set('meshdir', str(source.parent / 'meshes'))
actuators = list(model.find('actuator'))
names = [a.attrib['joint'] for a in actuators]
assert len(names) == config['num_actions'] == 12
for a, kp, kd in zip(actuators, config['kps'], config['kds']):
    # 官方 motor 的 gear=1，关节 actuatorfrcrange 是原生力矩限幅。
    assert a.tag == 'motor' and a.get('gear', '1') == '1'
    a.tag = 'position'
    a.set('kp', str(kp))
    a.set('kv', str(kd))
    # PD 目标允许超出关节机械限位；原官方代码同样不剪裁 action。
    a.set('ctrllimited', 'false')
output.mkdir(parents=True, exist_ok=True)
target = output / 'g1-position-pd.xml'
tree.write(target, encoding='unicode')
before = mujoco.MjModel.from_xml_path(str(source))
after = mujoco.MjModel.from_xml_path(str(target))
fields = ['body_mass','body_inertia','geom_type','geom_size','geom_contype','geom_conaffinity','geom_friction','jnt_range','jnt_actfrcrange','actuator_gear']
for field in fields:
    np.testing.assert_array_equal(getattr(before,field),getattr(after,field), err_msg=field)
assert not np.any(after.body_gravcomp)
# engine 是这个派生模型的"原生格式/引擎"；supportedEngines 是"同一套动作与观测语义可以在哪些引擎上执行"。
# 官方 G1 策略的动作语义（position 参考，增益为源声明 kp/kd，目标=default_angles+0.25·action）与观测语义
# （自由根 + 12 关节 + 相位）都不依赖 MuJoCo 求解器：Isaac Provider 用同一份派生 XML（同 sha256）走 MJCF
# 导入，dt 与控制抽减也相同。缺这一声明时 matchPolicy 会按 adapter.supportedEngines??[adapter.engine]
# 把 Isaac world 判为 SIMULATOR_MISMATCH。
print(json.dumps({'adapter':'unitree-g1-12dof-v1','robot':'unitree-g1-12dof','engine':'mujoco','supportedEngines':['mujoco','isaac'],'modelPath':str(target),'modelSourcePath':str(source),'weightsPath':str(root/'deploy/pre_train/g1/motion.pt'),'config':config,'jointNames':names,'unit':'rad','controlMode':'position','frequencyHz':1/(config['simulation_dt']*config['control_decimation']),'observations':{'type':'STATE','shape':[config['num_obs']],'order':['angularVelocityLocalRadps*ang_vel_scale','projectedGravityFromQuaternion','command*cmd_scale','(jointPosition-default_angles)*dof_pos_scale','jointVelocity*dof_vel_scale','previousAction','sinPhase','cosPhase'],'quaternion':'xyzw','phasePeriodS':0.8},'physicsPreserved':fields,'gravityCompensation':False}))
