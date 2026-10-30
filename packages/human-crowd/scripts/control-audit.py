"""只读核查固定已安装推理权重及实际人体执行器；不联网、不训练、不把形状推理当步态通过。"""
import argparse,hashlib,json,sys,time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--policy-root',required=True);p.add_argument('--scene',required=True);p.add_argument('--output',required=True);a=p.parse_args();root=Path(a.policy_root).resolve();expected={'deploy/pre_train/g1/motion.pt':'cf668f75b90d1abf73d2b87612a6e76bccc61ff7e083b63582d3f6aaa3c1759d','deploy/deploy_mujoco/configs/g1.yaml':'73044e7d355c61915695c16d6e09eb3efef46eec1e3d708fd3eb9157dfe3bbbb'}
for file,sha in expected.items():
 actual=hashlib.sha256((root/file).read_bytes()).hexdigest()
 if actual!=sha:raise RuntimeError('POLICY_IDENTITY_MISMATCH: '+file+' '+actual)
license=(root/'LICENSE').read_text();assert license.startswith('BSD 3-Clause License')
import torch
# 只在这个核查进程设置1线程；不写全局配置，不冒称产品既有线程设置。
torch.set_num_threads(1);t=time.perf_counter();model=torch.jit.load(str(root/'deploy/pre_train/g1/motion.pt'),map_location='cpu');model.eval();load_s=time.perf_counter()-t
with torch.inference_mode():
 output=model(torch.zeros((1,47)));t=time.perf_counter()
 for _ in range(100):model(torch.zeros((1,47)))
 inference_s=time.perf_counter()-t
assert list(output.shape)==[1,12]and bool(torch.isfinite(output).all())
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'sim-mujoco/python'));import worker
worker.emit=lambda _:None;worker.emit_text=lambda _:None
scene=json.loads(Path(a.scene).read_text());person=next(e for e in scene['entities']if e.get('components',{}).get('human'));person['components']['human']['mode']='ragdoll';person['components']['human']['collision']='detailed';scene['entities']=[e for e in scene['entities']if e is person or e.get('components',{}).get('humanDefinition')];w=worker.World(scene,{'clock':'manual','timestepS':.002,'ground':True});description=w.describe(person['entityId']);info=w.info(person['entityId']);native={'nq':w.model.nq,'nv':w.model.nv,'actuators':w.model.nu,'freeRoots':len(info['freeJoints']),'ballJoints':int((w.model.jnt_type==worker.mj.mjtJoint.mjJNT_BALL).sum()),'controlledJointNames':description['controlledJointNames'],'scalarJoints':list(info['joints'])};w.close()
result={'status':'PARTIAL','installedCandidate':{'modelId':'unitreerobotics/unitree_rl_gym','revision':'276801e46c5d433564f24658bac64f254b7d2d4b','filesSha256':expected,'license':'BSD-3-Clause','licenseSha256':hashlib.sha256(license.encode()).hexdigest(),'weightBytes':(root/'deploy/pre_train/g1/motion.pt').stat().st_size},'cpuShapeInference':{'status':'PASSED','torch':torch.__version__,'threads':torch.get_num_threads(),'input':[1,47],'output':list(output.shape),'finite':True,'loadS':load_s,'meanMs':inference_s*10},'nativeHuman':native,'physicalHumanAdaptation':{'status':'BLOCKED','reasons':['固定G1策略需要G1的12个hinge执行器与47维特定顺序/尺度观测；当前原创人体controlledJointNames为空且没有执行器','球关节姿态/速度、惯量、关节范围、力矩限值与G1不同，不能以截断/补零观测或按维数复制动作代替适配','尚无针对该自然人体物理定义的平衡、步态和跌倒恢复权重；未启动训练或下载模型包']},'closed':True};Path(a.output).write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False))
