"""Isaac Sim 6.0.1 独立单world运行所有者；唯一SimulationManager.step循环。
需要既有合法EULA确认。stdin只排队，动作accept立即返回；不启动第二语言循环。
"""
import copy
import gc
import json
import math
import os
from pathlib import Path
import queue
import sys
import threading
import time
import uuid
import warnings
from urllib.parse import urlparse,unquote
from check import check,cache_status,startup_failure
from world_physics import scene_gravity,declared_ground_ids,explicit_ground_requested,coverage
# 标注/导出用到的像素↔世界算术与生效内参：纯函数、不碰引擎对象，便于在无 Kit/RTX 的解释器上复算
# （见 camera_math.py 的文件头）；本文件只引用它，不另写第二套公式。
from camera_math import intrinsics_from_fovy,unproject_camera_point,camera_point_to_world,world_point_to_pixel,depth_is_valid
from camera_math import select_capture as camera_math_select_capture
# 数据集导出的纯实现（校验+写盘，不 import Kit/numpy）：worker 只接上自己的采集登记表。
from camera_dataset import export_dataset,DatasetError

def emit(value):print(json.dumps(value,allow_nan=False,separators=(',',':')),flush=True)
def fail_startup(code,message,stage,**facts):
    emit({'event':'fatal','error':{'code':code,'message':code+': '+message,
          'details':{'provider':'isaac','status':'BLOCKED','stage':stage,**facts}}})
    current_app=globals().get('app')
    if current_app is not None:
        try:current_app.close()
        except Exception:pass # 原始 fatal 已交传输层，owned process 的结束仍由传输层核实。
    sys.exit(2)
emit({'event':'phase','phase':'sdk-preflight'})
state=check()
if state['status']!='AVAILABLE':
    emit({'event':'fatal','error':startup_failure(state)})
    sys.exit(2)
# RTX shader/cache 预检（Kit 启动前、只会读）：事件供验收/直驱脚本解析，stderr 供日志留存。
# 判定口径 = check.py 的 cache_status()；不创建/修改缓存目录，不阻断启动（冷启动按原流程继续）。
if os.environ.get('LYAPUNOV_ISAAC_RENDERING')=='rtx':
    preflight=cache_status()
    emit({'event':'cache-preflight',**preflight})
    if preflight['status']!='HOT':
        print('[lyapunov] Isaac RTX shader/cache 预检: '+preflight['status']+' — '+str(preflight['coldStartWarning']),file=sys.stderr,flush=True)
emit({'event':'phase','phase':'kit-import'})
try:
    from isaacsim import SimulationApp,AppFramework
except Exception as exc:
    fail_startup('ISAAC_KIT_START_FAILED',str(exc),'kit-import',causeType=type(exc).__name__)
rendering=os.environ.get('LYAPUNOV_ISAAC_RENDERING','none')=='rtx'
privacy=['--/telemetry/enableAnonymousData=false','--/telemetry/enableNVDF=false','--/telemetry/enableSentry=false','--/privacy/usage=false','--/privacy/performance=false','--/privacy/personalization=false']
def start_kit():
    portable=Path(os.environ['LYAPUNOV_ISAAC_CACHE'])/'kit'/str(os.getpid());portable.mkdir(parents=True,exist_ok=True)
    if rendering:
        sys.argv.extend(['--portable-root',str(portable)])
        # Profile 私有 shader 缓存跨 worker 复用；日志和其余数据仍按 PID 隔离。
        shader_root=Path(os.environ['LYAPUNOV_ISAAC_CACHE'])/'rtx-cache'/state['sdkVersion']
        for name in ['shadercache','nv_shadercache']:(shader_root/name).mkdir(parents=True,exist_ok=True)
        shader_args=['--/rtx/shaderDb/shaderCachePath='+str(shader_root/'shadercache'),'--/rtx/shaderDb/driverShaderCachePath='+str(shader_root/'nv_shadercache')]
        # 保持原来的离线经验文件和扩展路径；这里只增加阶段诊断。
        ext_args=[]
        for directory in ['extscache','extsDeprecated','extsUser']:ext_args.extend(['--ext-folder',str(Path(os.environ['ISAAC_PATH'])/directory)])
        return SimulationApp({'headless':True,'renderer':'RaytracedLighting','width':640,'height':480,'sync_loads':True,'multi_gpu':False,'enable_crashreporter':False,'limit_cpu_threads':4,'extra_args':privacy+shader_args+ext_args},str(Path(__file__).with_name('physics-rtx.kit')))
    args=[str(Path(__file__).with_name('physics-cpu.kit')),'--no-window','--portable-root',str(portable),*privacy]
    for directory in ['exts','extscache','extsDeprecated']:args.extend(['--ext-folder',str(Path(os.environ['ISAAC_PATH'])/directory)])
    return AppFramework(name='lyapunov-isaac-cpu',argv=args)

emit({'event':'phase','phase':'kit-initialize'})
try:
    app=start_kit()
except Exception as exc:
    fail_startup('ISAAC_KIT_START_FAILED',str(exc),'kit-initialize',causeType=type(exc).__name__)
emit({'event':'phase','phase':'extensions-load'})
try:
    import numpy as np
    import carb
    import omni.kit.app
    import omni.timeline
    import omni.physx
    from pxr import Gf,Usd,UsdGeom,UsdLux,UsdPhysics,UsdUtils,PhysxSchema,PhysicsSchemaTools
    manager=omni.kit.app.get_app().get_extension_manager()
    for extension in ['isaacsim.core.experimental.prims','isaacsim.asset.importer.mjcf','isaacsim.asset.importer.urdf']+(['isaacsim.sensors.experimental.rtx'] if rendering else []):
        if not manager.set_extension_enabled_immediate(extension,True):
            fail_startup('ISAAC_EXTENSION_UNAVAILABLE','Isaac扩展未加载: '+extension,'extensions-load',extension=extension)
    from isaacsim.core.simulation_manager import SimulationManager as SM
    from isaacsim.core.experimental.utils.backend import use_backend
    from isaacsim.core.experimental.prims import XformPrim
    if rendering:
        from isaacsim.sensors.experimental.rtx import CameraSensor,RtxCamera
        from isaacsim.core.experimental.objects import Camera as UsdCamera
except Exception as exc:
    fail_startup('ISAAC_EXTENSION_UNAVAILABLE',str(exc),'extensions-load',causeType=type(exc).__name__)
from scene_adapter import SceneAdapter,SceneError,quat_to_matrix,signatures,wrench_mapping,camera_mount_bodies,poses
emit({'event':'phase','phase':'physx-initialize'})
try:
    if SM.get_active_physics_engine() != "physx" and not SM.switch_physics_engine("physx"):
        fail_startup('ISAAC_PHYSX_UNAVAILABLE','Isaac PhysX后端未启用','physx-initialize')
    from omni.physx.bindings._physx import ContactEventType
except Exception as exc:
    fail_startup('ISAAC_PHYSX_UNAVAILABLE',str(exc),'physx-initialize',causeType=type(exc).__name__)

def finite(value,label='value'):
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):raise SceneError('INVALID_ARGUMENT',label+'必须有限')
    return float(value)
def positive(value,label):
    value=finite(value,label)
    if value<=0:raise SceneError('INVALID_ARGUMENT',label+'必须大于0')
    return value
def array(value):return value.numpy().copy() if hasattr(value,'numpy') else np.asarray(value).copy()
def path_from_uri(uri):
    """回执里的 `file://` URI → 本地路径；给普通路径时按路径解析（同 sim-mujoco worker 的同名帮手）。

    数据集导出/再次标注**只**读本 worker 自己写下的 uri，不接受调用方塞进来的任意路径。
    """
    if not isinstance(uri,str) or not uri:raise SceneError('INVALID_ARGUMENT','产物 URI 必须是非空字符串')
    parsed=urlparse(uri)
    if parsed.scheme=='file':return Path(unquote(parsed.path))
    if parsed.scheme:raise SceneError('INVALID_ARGUMENT','产物 URI 方案不支持（只接受 file:// 或本地路径）: '+parsed.scheme)
    return Path(unquote(uri))
def scalar_list(value):return array(value).reshape(-1).tolist()
def joint_gain(cfg,key,name,fallback_key,default):
    """逐关节增益（controller.jointKp/jointKd 映射）按关节名取值，缺该关节回落标量 kp/kd。

    官方力矩模型各关节刚度常差一个量级（H1 髋150/膝200/踝40、BHL 腿20/臂10），单一标量表达不了；
    两者都没声明才用调用方默认值（力矩执行器 120/4，与旧行为一致）。
    """
    table=cfg.get(key)
    if isinstance(table,dict)and name in table:return finite(table[name],key+'.'+name)
    scalar=cfg.get(fallback_key)
    return finite(scalar,fallback_key)if scalar is not None else float(default)
def is_ground_geom_name(name):
    """源声明的世界地面 geom 名（floor/ground 字面约定，如官方 h1/scene.xml 与 bhl_scene.xml 的 floor）。

    只用于把这类 geom 的接触标签登记进 world handle 的 groundGeomNames，供接触过滤直接匹配；
    不改物理，也不按机器人名猜测。
    """
    lowered=str(name).lower()
    return 'floor'in lowered or 'ground'in lowered
def joint_limits(robot):
    lower,upper=robot.get_dof_limits();return np.column_stack([array(lower).reshape(-1),array(upper).reshape(-1)])
def controlled_joints(names,joints):
    """源元数据声明了关节级 actuator 的 DOF 才是 controlled（同 scene_adapter：tendon 驱动的关节不进这里）。

    元数据缺失（URDF 与原生 USD 分支 convert() 返回 metadata={}）时无从核验受控 DOF 与被动关节，
    返回空集合，由调用方按“来源不可用”如实报告；绝不回退成“全部 DOF 可控”。
    """
    return [name for name in names if joints.get(name,{}).get('actuator')] if joints else []
def joint_control_mode(metadata,name):
    """逐关节 controlMode 只来自源元数据声明的执行器模式；未声明时返回 None，不默认 'position'。

    prepare(kind:'control') 对无执行器关节是明确拒绝（UNSUPPORTED_CAPABILITY），描述不得给出可执行假象。
    """
    actuator=(metadata.get('joints')or{}).get(name,{}).get('actuator')
    if not actuator:return None
    return (metadata.get('actuators')or{}).get(actuator,{}).get('mode')

# 几何步态的三个相位常数：与 packages/sim-mujoco/python/gait.py 的 targets() **同一取值**，不另立一套。
GAIT_FREQUENCY_HZ=1.8
GAIT_STRIDE_M=.12
GAIT_LIFT_M=.05

def gait_probe_targets(legs,time_s,forward,turn,frequency,stride,lift):
    """调用 **packages/sim-mujoco/python/gait.py 的 targets() 本体** 生成四足步态关节目标。

    这里**不重写公式**：把 gait.py 按路径 import 进来直接用（同一份实现 ⇒ 站立基准、
    相位、缩放与 MuJoCo 侧必然一致）。本适配层只负责"把源 MJCF 喂给 gait.calibrate()
    （见 World.calibrate_gait）"与"把结果接进 Isaac 的下发路径"。
    """
    import os,sys
    gait_dir=os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),'sim-mujoco','python')
    if gait_dir not in sys.path:sys.path.insert(0,gait_dir)
    import gait
    return gait.targets(legs,time_s,forward,turn,frequency,stride,lift)

def empty_frame(world):
    return {'worldId':world.id,'generation':world.generation,'sceneRevision':world.revision,'stepIndex':world.index,'simTime':world.sim_time,'frameId':f'{world.id}:{world.generation}:{world.index}','assistAdvanceCount':world.assist_advances,'entities':[]}

# ISAAC-19／D4：GLB 视觉导入回执的既有通道前缀（`glb_visual.report_import` 用标准 warnings 发出同一份 JSON）。
GLB_IMPORT_WARNING_PREFIX='[lyapunov] GLB 视觉导入: '

def glb_import_warnings(caught):
    """把 GLB 视觉导入回执读成 `WorldHandle.warnings` 的元素（`WorldWarning`：code/entityId?/message）。

    不新建数据通道：`glb_visual.report_import` 本来就发出这份结构化 JSON（T7），此前只有 worker 的
    stderr/日志能看到。这里把 populate 期间的同一批消息原样转成句柄字段，`message` 保留原始 JSON 文本
    （不裁剪、不改写）；无丢弃项时 report_import 不发消息，因此不会产生误导性告警。

    另外把同一份 JSON **解析一次**挂到句柄的 `glbImports` 上（见 `glb_import_reports`）：ISAAC-19 的完成
    条件是"导入前说明保留与不支持的内容"，而 warnings 的 `message` 是给人读的字符串，调用方要拿
    "保留了什么/这个通道一律不支持什么"就得自己再解一遍 JSON。函数签名与返回值形状保持不变
    （`WorldHandle.warnings` 的元素仍是 {code,message}），解析出来的结构化事实走 `glb_import_reports`。
    """
    found=[]
    for entry in caught:
        text=str(entry.message)
        if text.startswith(GLB_IMPORT_WARNING_PREFIX):
            found.append({'code':'GLB_IMPORT_DROPPED_CONTENT','message':text[len(GLB_IMPORT_WARNING_PREFIX):]})
    return found

def glb_import_reports(warnings_list):
    """把 `glb_import_warnings` 的元素解析成结构化导入回执（保留/丢弃/通道不支持清单）。

    只在**同一批** warnings 上解析，不重新扫 warnings 记录、也不构造第二份事实：
    `source`/`nodeIndex`/`kept`/`dropped`/`retained`/`notSupported` 全部原样取自 report_import 的 JSON。
    解不出来的条目跳过（保底：warnings 的原始文本仍在，信息不丢）。
    """
    parsed=[]
    for entry in warnings_list:
        payload=entry.get('message')if isinstance(entry,dict)else None
        if not isinstance(payload,str):continue
        try:document=json.loads(payload)
        except (ValueError,TypeError):continue
        if not isinstance(document,dict):continue
        parsed.append({'source':document.get('source'),'nodeIndex':document.get('nodeIndex'),
                       'kept':document.get('kept'),'dropped':document.get('dropped'),
                       'retained':document.get('retained'),'notSupported':document.get('notSupported')})
    return parsed

class World:
    def __init__(self,scene,options):
        self.clock=options.get('clock','realtime')
        if self.clock not in ('manual','realtime'):raise SceneError('INVALID_ARGUMENT','clock 必须为 manual 或 realtime')
        self.control_owners={}
        self.id=options.get('worldId',str(uuid.uuid4()));self.options=options;self.generation=0;self.revision=-1;self.scene=None;self.signature=None;self.status='unavailable';self.index=0;self.sim_time=0.;self.actions={};self.receipts={};self.requests={};self.entities={};self.contacts={};self.assisted={};self.assist_advances=0;self.contact_subscription=None;self.camera=None;self.frame_rendered=False;self.camera_overrides={}
        self.paused=options.get('startPaused',False)
        if not isinstance(self.paused,bool):raise SceneError('INVALID_ARGUMENT','startPaused 必须为 boolean')
        # 本 world 生命周期内真实落盘的采集记录（captureId → 回执/逐相机标定/RGB+深度 uri/标注），
        # 供 camera_project_annotation 与 camera_dataset_export 只引用**真实发生过**的采集；
        # 没有 RTX 时这里如实为空（采集本身按 SENSOR_UNAVAILABLE 拒绝），不造空壳记录。
        self.captures={}
        self.dt=positive(options.get('timestepS',.002),'timestepS');self.factor=positive(options.get('realtimeFactor',1),'realtimeFactor');self.frame_hz=positive(options.get('frameRateHz',30),'frameRateHz');self.last_frame=0.;self.next_tick=time.monotonic()
        self.adapter=SceneAdapter(os.environ['LYAPUNOV_ISAAC_CACHE']);self.timeline=omni.timeline.get_timeline_interface()
        self.stage_id=0;self.sleep_query=True;self.import_warnings=[];self.glb_imports=[]
        self.sync(scene)
    def ground_geom_names(self):
        """接触标签口径的地面名：worker 自带地面盒（/World/ground/geometry）与源声明地面 geom
        （floor/ground 字面约定，如官方 h1/scene.xml、bhl_scene.xml 的 floor）的 `<eid>/<geom名>`。

        与 observe 的 contacts[].geom1/geom2 同名字空间（见 label()），供接触过滤精确匹配，
        不再靠实体前缀猜测。ground:false 且源模型无地面 geom 时为空列表（如实为空，不塞默认值）。
        """
        names=['/World/ground/geometry']if self.stage.GetPrimAtPath('/World/ground/geometry').IsValid()else[]
        for eid in declared_ground_ids(self.scene):
            if eid in self.entities:names.extend((self.entities[eid].get('collision')or{}).get('colliderPaths',[]))
        for eid,e in self.entities.items():
            names.extend(eid+'/'+name for name in e['metadata'].get('verifiedNativeGroundNames',[]))
        return sorted(set(names))
    def run_status(self):
        if self.status not in ('ready','running'):return self.status
        if self.paused:return 'paused'
        return 'running'if self.actions or self.clock=='realtime'and self.index>0 else'ready'
    def set_paused(self,paused,generation):
        self.ready()
        if not isinstance(paused,bool):raise SceneError('INVALID_ARGUMENT','paused必须是boolean')
        if generation!=self.generation:raise SceneError('STALE_GENERATION','暂停目标世界代次已变化')
        self.paused=paused;self.next_tick=time.monotonic();return self.handle()
    def world_physics(self):
        scenes=[scene for scene in SM.get_physics_scenes()if str(scene.prim.GetPath())=='/World/PhysicsScene']
        if len(scenes)!=1:raise SceneError('WORLD_PHYSICS_SCENE_UNAVAILABLE','当前世界没有唯一PhysicsScene读回')
        # Scene/代次内collider资格不随FK改变；只在装配版本变更时扫实际USD，重力仍每帧直接问SDK。
        key=(self.generation,self.revision)
        if getattr(self,'_physics_layout_key',None)!=key:
            physical=[];names={};ignored=[];native_planes=[]
            for eid,entry in self.entities.items():
                root=self.stage.GetPrimAtPath(entry['path'])
                colliders=[p for p in Usd.PrimRange(root,Usd.TraverseInstanceProxies())if p.HasAPI(UsdPhysics.CollisionAPI)and UsdPhysics.CollisionAPI(p).GetCollisionEnabledAttr().Get()]
                if colliders:physical.append(eid);names[eid]=[str(p.GetPath())for p in colliders]
                if entry.get('metadata',{}).get('standardGroundReplaced'):ignored.append(eid)
                for name in entry.get('metadata',{}).get('verifiedNativeGroundNames',[]):
                    if colliders:native_planes.append({'source':'native-plane','entityId':eid,'geomNames':[eid+'/'+name]})
            grounds=[{'source':'scene','entityId':eid,'geomNames':names[eid]}for eid in declared_ground_ids(self.scene)if eid in names]
            grounds+=native_planes
            if self.stage.GetPrimAtPath('/World/ground/geometry').IsValid():grounds.append({'source':'explicit-legacy','geomNames':['/World/ground/geometry']})
            self._physics_layout=(physical,grounds,ignored);self._physics_layout_key=key
        physical,grounds,ignored=self._physics_layout
        return {'gravityWorldMps2':[float(v)for v in scenes[0].get_gravity()],'gravityEnabled':bool(scenes[0].get_enabled_gravity()),'units':'m/s^2','source':'isaac-physics-scene','groundSources':grounds,'collisionCoverage':coverage(self.scene,physical,ignored)}
    def handle(self):
        result={'worldId':self.id,'sceneId':self.scene['sceneId'],'engineId':'isaac','engineVersion':state['sdkVersion'],'worldGeneration':self.generation,'appliedSceneRevision':self.revision,'status':self.run_status(),'clock':self.clock,'timestepS':self.dt,'groundGeomNames':self.ground_geom_names(),'supportsPause':True}
        if self.status in ('ready','running'):result['worldPhysics']=self.world_physics()
        # 本次 populate 真实发生的 GLB 导入回执（无丢弃项时不出现该键，不产生噪音）。
        warnings_out=list(self.import_warnings)
        # ISAAC-10：纯视觉实体（无原生源、只有 GLB 视觉；USD 层 collider 为 purpose=guide、非物理）此前在
        # 协议里读不到"该实体无碰撞"这一事实。复用**既有** warnings 通道给一条可读说明，不新建字段/通道。
        for eid in sorted(self.entities):
            if self.entities[eid].get('metadata',{}).get('visualOnly') and not self.entities[eid].get('collision'):
                warnings_out.append({'code':'ENTITY_VISUAL_ONLY','entityId':eid,
                    'message':eid+'：该实体只有视觉几何、没有碰撞体（USD 层为 purpose=guide，非物理），不参与接触/碰撞、也不会出现在接触回执里；需要碰撞请为该实体声明碰撞几何（components.mujoco／collisionSource 等）'})
            # N52／DEV-029：声明了 Scene 碰撞但走了原生源/视觉源装配的实体，其 components.collision
            # **整段没有被消费**（见 scene_adapter.py 的 populate：`:541` 的条件）。此前不报错不告警。
            if self.entities[eid].get('metadata',{}).get('sceneCollisionIgnored'):
                warnings_out.append({'code':'SCENE_COLLISION_IGNORED','entityId':eid,
                    'message':eid+'：该实体声明了 Scene 碰撞（components.collision），但它有原生源/视觉源，Isaac 装配按**源内碰撞**走，这份 Scene 碰撞声明整段没有参与（未据此建任何 collider，也未报错）：几何不会退化成单个盒子，但声明的形状/尺寸不生效。要让它生效请把碰撞烘焙进源资产，或改用 collisionSource=scene.json 的 Scene 侧碰撞'})
        # N52／DEV-029／ISAAC-09：3DGS 派生的场景碰撞补丁在 MuJoCo 侧由 syncArgsExtras 注入的
        # collisionPatches 消费；Isaac 适配层没有该通道，调用方传进来此前被**静默忽略**（不报错、不告警，
        # 这些表面没有碰撞）。复用**既有** warnings 通道（同一个 warnings_out／同一个 result 键）明确说明；
        # 不新建字段/通道、不改官方导入器。
        patches=self.options.get('collisionPatches')
        patch_ignored=patches is not None
        if patch_ignored:
            count=len(patches) if isinstance(patches,(list,dict)) else 1
            warnings_out.append({'code':'COLLISION_PATCHES_IGNORED',
                'message':'本次 open 收到 collisionPatches（3DGS 派生场景碰撞，'+str(count)+' 项），Isaac 适配层未消费该通道、未据此建任何 collider：这些表面没有碰撞。要在 Isaac 里得到碰撞，请把补丁烘焙成 Scene 碰撞声明（components.collision，含逐件 shapes[]/尺寸）或改用原生 USD/MJCF 源内碰撞'})
        # N52／DEV-029／ISAAC-09：装配时 components.collision 在"有原生源"的实体上整段不参与，而
        # Isaac 侧对 3DGS patches 没有消费通道。上面两条 warnings 说的是"声明的没生效"，
        # 但调用方真正需要**事先**知道的是**哪个来源在生效**——这里按实体逐个读回实际落成的碰撞
        # （Scene 侧：primitive() 的 collider 路径/形状/材质/质量记录 + 在组装后的 stage 上数真实
        # CollisionAPI prim；原生源侧：源内 collider 计数）。这是**读回**不是声明回声：数字来自
        # populate 之后遍历 self.stage。没有任何碰撞的实体明确给 'none' 并说明原因。
        collision_sources=[]
        for eid in sorted(self.entities):
            e=self.entities[eid];metadata=e.get('metadata')or{}
            record=e.get('collision')
            if metadata.get('visualOnly'):reason='该实体只有视觉几何（GLB 视觉源），没有碰撞体'
            elif metadata.get('coveredBySceneVisual'):reason='该实体的碰撞由场景级 Scene 视觉覆盖，本实体自身不建 collider'
            else:reason=None
            if record:
                source='scene-primitive';reason=None
            elif e.get('path') and self.stage.GetPrimAtPath(e['path']):
                prim=self.stage.GetPrimAtPath(e['path'])
                native=sum(1 for descendant in Usd.PrimRange(prim,Usd.TraverseInstanceProxies())if descendant.HasAPI(UsdPhysics.CollisionAPI))
                if native:source='native-source'
                elif patch_ignored:
                    # 3DGS 的典型形态：有配准 binding、没有可信几何 → 没有任何 collider，而 patches
                    # 通道又被忽略。这正是 ISAAC-09 要求"单独处理缺几何、明确报错"的那一种。
                    source='none';reason='该实体没有可信碰撞几何，且本次收到的 collisionPatches（3DGS 派生场景碰撞）未被 Isaac 适配层消费：没有任何 collider 生效'
                else:
                    source='none';reason='该实体装配后没有任何 CollisionAPI collider（既没有 Scene 碰撞声明，源内也没有碰撞几何）'
            else:source='none';reason='该实体没有可用 prim'
            item={'entityId':eid,'source':source,'reason':reason}
            if record and record.get('meshParts'):item['meshParts']=copy.deepcopy(record['meshParts'])
            if record:item.update({'shape':record.get('shape'),'colliderPaths':record.get('colliderPaths'),
                                   'declaredMaterial':(record.get('material')or{}).get('declaredMaterial'),
                                   'frictionSource':(record.get('material')or{}).get('frictionSource'),
                                   'mass':record.get('mass')})
            if metadata.get('sceneCollisionIgnored'):item['sceneCollisionIgnored']=True
            collision_sources.append(item)
        if collision_sources:result['collisionSources']=collision_sources
        if warnings_out:result['warnings']=warnings_out
        # ISAAC-19：本次 GLB 视觉导入**结构化**的保留/丢弃/通道不支持清单（与 warnings 同一份事实，
        # 只是解析好的形式）。没有 GLB 导入时不出现该键。
        if self.glb_imports:result['glbImports']=list(self.glb_imports)
        return result
    def ready(self):
        if self.status not in ('ready','running'):raise SceneError('WORLD_UNAVAILABLE','世界未ready: '+self.status)
    def entry(self,eid):
        if eid not in self.entities:raise SceneError('ENTITY_NOT_FOUND',eid)
        return self.entities[eid]
    def robot(self,eid):
        e=self.entry(eid)
        if e['articulation'] is None:raise SceneError('ENTITY_NOT_ARTICULATED',eid)
        return e['articulation']
    def physx_sleeping(self,e):
        """官方PhysX sleeping状态（IPhysxSimulation.is_sleeping），读不到时返回None。
        这是唯一允许改写速度读数的依据：sleeping机构的DOF速度缓冲不再更新，但只有确认
        官方状态后才使用真实值，绝不凭“速度看起来旧”猜测；查询不可用则如实返回None。"""
        if not self.sleep_query or not self.stage_id:return None
        path=e['articulation'].paths[0]if e['articulation']is not None else(e['rigidPaths'][0]if e['rigidPaths']else None)
        prim=self.stage.GetPrimAtPath(path)if path else None
        if not prim:return None
        try:return bool(omni.physx.get_physx_simulation_interface().is_sleeping(self.stage_id,PhysicsSchemaTools.sdfPathToInt(prim.GetPath())))
        except Exception:self.sleep_query=False;return None
    def sync(self,scene,force=False):
        if self.scene and scene['sceneId']!=self.scene['sceneId']:raise SceneError('SCENE_MISMATCH','world与scene绑定不可改变')
        # 回执声明的 clearsOn 含 sim_sync：临时相机 override 属于上一个代次的渲染状态，任何一次被接受的
        # sync 都按源快照恢复并丢弃（同 revision 的空 sync 也清，绝不继续冒充）。
        self.clear_camera_overrides()
        if scene['revision']<self.revision:return self.handle()
        signature=signatures(scene)
        if not force and signature==self.signature and self.status in ('ready','running'):
            self.scene=copy.deepcopy(scene);self.revision=scene['revision'];return self.handle()
        self.stop({});self.control_owners.clear();self.status='unsynced';self.assisted.clear();self.contact_subscription=None
        self.timeline.stop();self.timeline.commit();self.timeline.set_auto_update(False);self.timeline.commit()
        self.entities={};self.contacts={};gc.collect()
        try:
            # ISAAC-19／D4：GLB 视觉导入的回执走标准 warnings 通道，这里读回来挂到句柄的 warnings 上；
            # catch_warnings 会截住打印，随后按原位置重发一次，保留 worker stderr/日志的既有可见性。
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter('always')
                self.stage,self.entities=self.adapter.populate(scene,self.options)
            self.import_warnings=glb_import_warnings(caught)
            self.glb_imports=glb_import_reports(self.import_warnings)
            for entry in caught:warnings.warn_explicit(entry.message,entry.category,entry.filename,entry.lineno)
            initial_rigid_poses={}
            for eid,e in self.entities.items():
                if e['articulation'] is None and e['rigidPaths']:
                    with use_backend('usd',raise_on_fallback=True):p,q=e['pose'].get_world_poses()
                    initial_rigid_poses[eid]=(array(p).reshape(-1).tolist(),array(q).reshape(-1).tolist())
            # 同一条处方也必须落在 articulation 上，否则只做了一半：引擎装配的种子位形是
            # 「模型自带的基体位姿 + 各DOF引擎默认0」（导入产物里没有任何关节状态，见下方 configure_robots
            # 的关节初值通道），initialize_physics() 内部会**自己跑一步物理**（SDK源码
            # isaacsim/core/simulation_manager/impl/simulation_manager.py:702-704 的
            # sim_interface.simulate(get_physics_dt(),0.0)），穿地的种子就在这一步注入去穿透速度；
            # 而这一步发生在下面 configure_robots() 写声明初值**之前**，第0帧的基座会带着预热冲量起飞
            # （实测 Go1：种子 trunk 0.34 + 关节0 ⇒ 预热后基座 linVel=9.7445 m/s）。所以这里与刚体同口径
            # 记下 articulation 的根世界位姿，写声明初值之后再复位：world 从 Scene 位姿 + 声明初值、
            # 零速度起步。只复位根，关节仍由 configure_robots() 的既有通道写。
            initial_articulation_poses={}
            for eid,e in self.entities.items():
                if e['articulation'] is not None:
                    with use_backend('usd',raise_on_fallback=True):p,q=e['pose'].get_world_poses()
                    initial_articulation_poses[eid]=(array(p).reshape(-1).tolist(),array(q).reshape(-1).tolist())
            self.stage_id=UsdUtils.StageCache.Get().GetId(self.stage).ToLongInt()
            device=os.environ.get('LYAPUNOV_ISAAC_DEVICE','cpu')
            SM.setup_simulation(dt=self.dt,device=device)
            # SimulationManager.set_device在CUDA路径把/physics/suppressReadback置True(见其源码
            # set_device)，实测该设置会让GPU运行的接触报告整场收不到：接触缓冲不再回读，回调、
            # umbrella订阅、直接拉取都为0，而同一进程内改成关闭后同一场景立即恢复真实接触
            # (A/B/A对照: 开420步0接触→开后重建400步160次回调→关后重建400步又0，步速307→307)。
            # 接触是交付契约要求的真实反馈，所以GPU路径必须在initialize_physics前保留回读。
            # 运行回执由开发环境单独保存；发布包只保留 worker 实现。
            if device!='cpu':carb.settings.get_settings().set_bool('/physics/suppressReadback',False)
            SM.enable_fabric(rendering)
            self.timeline.set_auto_update(False);self.timeline.play();self.timeline.commit();SM.initialize_physics()
            self.configure_robots()
            # SDK初始化会内部预热物理。关节初态刚写入时，独立刚体也须回到
            # Scene声明的初态，不能把预热中与默认机器人姿态碰撞的冲量带入第0帧。
            for eid,(p,q) in initial_rigid_poses.items():
                with use_backend('tensor',raise_on_fallback=True):
                    self.entities[eid]['pose'].set_world_poses(positions=[p],orientations=[q])
                    self.entities[eid]['pose'].set_velocities(linear_velocities=[[0.]*3],angular_velocities=[[0.]*3])
            # articulation 的同一条复位（见上面 initial_articulation_poses 的说明）：预热把根位姿/速度
            # 改成了去穿透的结果，这里按预热前的 Scene 位姿复位并清零，使第0帧就是声明初态。
            for eid,(p,q) in initial_articulation_poses.items():
                with use_backend('tensor',raise_on_fallback=True):
                    self.entities[eid]['pose'].set_world_poses(positions=[p],orientations=[q])
                    self.entities[eid]['pose'].set_velocities(linear_velocities=[[0.]*3],angular_velocities=[[0.]*3])
            # 只记录诊断字段，不把它当设备测量：requestedPhysicsDevice 是我们请求的设备字符串；
            # simulationManagerReportedDevice 是 SM.get_device() 的回报值，它由 /physics/suppressReadback
            # 反推（suppress=true按场景答cuda；保留回读时直接答cpu，见其源码get_device），只是存储/回读口径。
            # “是否真在GPU执行”以 physicsScenes 的 gpuDynamics/broadphase 与真实world路径为准。
            carb.log_info('LYAPUNOV_ISAAC_BACKEND '+json.dumps({'requestedPhysicsDevice':device,'simulationManagerReportedDevice':str(SM.get_device()),'suppressReadback':bool(carb.settings.get_settings().get_as_bool('/physics/suppressReadback')),'rendering':'rtx' if rendering else 'none','physicsScenes':[{'gpuDynamics':s.get_enabled_gpu_dynamics(),'broadphase':s.get_broadphase_type()} for s in SM.get_physics_scenes()]}))
            self.contact_subscription=omni.physx.get_physx_simulation_interface().subscribe_contact_report_events(self.contact_event)
            self.scene=copy.deepcopy(scene);self.signature=signature;self.revision=scene['revision'];self.generation+=1;self.index=0;self.sim_time=0.;self.status='ready';self.next_tick=time.monotonic()
            from initial_overlap import initial_overlap
            self.initial_overlap=initial_overlap(self)
            if self.initial_overlap['status']!='CLEAR':
                self.import_warnings.append({'code':'INITIAL_OVERLAP' if self.initial_overlap['pairs'] else 'INITIAL_OVERLAP_UNVERIFIED',
                    'message':'初始物理形状检查：'+json.dumps(self.initial_overlap,ensure_ascii=False)})
            if self.timeline.is_auto_updating():raise SceneError('CLOCK_CONFLICT','Timeline自动步进未关闭')
            return self.handle()
        except Exception as error:
            self.status='unavailable';self.entities={};self.timeline.stop();self.timeline.commit()
            if self.scene is None:self.scene=copy.deepcopy(scene)
            # 失败现场不能只剩一句孤立 message：把诊断上下文（时钟/设备/阶段/涉及实体）挂到异常上，
            # 由协议层放进错误详情。**不动**异常类型与错误码（调用方仍按 code 分支），
            # 也不把异常换成另一个码——那会改掉既有失败语义。
            if isinstance(error,SceneError):
                try:error.details={'clock':self.clock,'device':os.environ.get('LYAPUNOV_ISAAC_DEVICE','cpu'),
                                   'stageId':getattr(self,'stage_id',0),'engine':'isaac',
                                   'entityIds':[e['entityId']for e in (self.scene or scene).get('entities',[])]}
                except Exception:pass
            raise
    def configure_robots(self):
        def engine_drive_metadata(articulation,dof_names):
            """从**导入后的 USD articulation** 读回逐 DOF 的 drive：是否有 drive、force/acceleration、力限。

            ISAAC-12 的关闭条件要求"从源和真实 USD articulation/drive 建立最小必要映射"。源元数据缺失
            （URDF 与原生 USD 分支 convert() 返回 metadata={}）时，此前只有两种结局：把全部 DOF 当可控
            （已修）或全部当不可控（保守，但让 robot_move 整条通道不可用）。两者都不是"从真实
            articulation 建立映射"。这里按引擎自己的回报补齐第三态：

              · DOF 归属：以引擎的 `dof_names` 为准（导入改名后源元数据里的名字本就可能对不上）；
              · 是否有 drive：`get_dof_drive_types()` 为 None/'none' 表示该 DOF **没有** drive——这不是
                "有 drive 但参数没读出来"，PhysX 对被动关节就是这个取值，因此它不进受控集合；
              · 控制方式：引擎回报的 drive type 只有 force/acceleration（USD PhysicsDriveAPI 的
                allowedTokens 只有这两个），它**不是** position/velocity 选择器，所以只如实给出
                driveType 与 driveMaxEffort，不据此断言 position；
              · 力限：`get_dof_max_efforts()` 是引擎侧真实生效的 drive maxForce（inf=不限）。
            读不出 drive type 时只回落到 `isfinite(maxEffort)` 这一个更弱的判据，并在 note 里写明用的是
            哪条。任何读回失败都回落成"没有可核验的 drive"（空表 + note），不抛异常、不猜。
            """
            result={'perJoint':{},'note':None,'driveTypesAvailable':False}
            if articulation is None or not dof_names:return result
            try:
                drive_types=articulation.get_dof_drive_types()
                drive_types=[entry[0]if isinstance(entry,(list,tuple))and entry else entry for entry in drive_types]
                result['driveTypesAvailable']=True
            except Exception as error:
                drive_types=None;result['note']='get_dof_drive_types() 不可读（'+type(error).__name__+': '+str(error)+'），本次只用有限 maxEffort 判定 drive'
            try:efforts=[float(value)for value in array(articulation.get_dof_max_efforts()).reshape(-1)]
            except Exception:efforts=[None]*len(dof_names)
            for index,name in enumerate(dof_names):
                drive_type=drive_types[index]if drive_types is not None and index<len(drive_types)else None
                if isinstance(drive_type,str)and drive_type.lower()in('','none'):drive_type=None
                effort=efforts[index]if index<len(efforts)else None
                finite_effort=effort is not None and math.isfinite(effort)
                has_drive=drive_type is not None if drive_types is not None else finite_effort
                if not has_drive:continue
                result['perJoint'][name]={'driveType':drive_type,'maxEffort':effort if finite_effort else None,
                                          'effortSource':'engine get_dof_max_efforts（inf=源不限/引擎默认，不回读成有限值）'}
            return result
        def calibrate_gait(entity):
            """四足步态几何标定：**直接复用 packages/sim-mujoco/python/gait.py 的 calibrate()**。

            不做第二套几何。做法与 sim-mujoco 侧逐条同源：
              · 用**同一个源文件**（metadata['source']，就是 mjcf_metadata 编译过的那一份）再编译一次
                MuJoCo 模型（本机 Isaac 环境内 mujoco 可用，实测 3.8；只做 mj_forward 运动学，不步进）；
              · 按 sim-mujoco 的 info 形状给出同一组字段（body / joints[name]={id,qpos}）；
              · 把 `controller.legs` 原样交给 gait.calibrate()，**照它的行**算 l1/l2/fore/depth/b0/td/bs/
                ss/ks/lateral/phase；本函数不重算任何一个几何量。
            这样站立基准与 MuJoCo 侧必然一致（同一份代码），不存在"两套实现给出两个 b0"。
            """
            legs_cfg=entity['controller'].get('legs')if isinstance(entity['controller'],dict)else None
            if not legs_cfg:return None,'MISSING_CONTROL_CONFIG: 该资产没有 controller.legs 四足腿分组声明（步态通道按资产显式声明启用，不按机型名猜）'
            source=(entity.get('metadata')or{}).get('source')or(entity.get('config')or{}).get('sourcePath')
            if not source:return None,'UNSUPPORTED_CAPABILITY: 该实体没有可核验的源模型路径，无法做四足步态标定'
            try:
                import mujoco as _mj
                import os as _os,sys as _sys
                # sim-mujoco 的 gait.py 是**唯一实现**：按路径加进 sys.path 后直接 import，不复制。
                _gait_dir=_os.path.join(_os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))),'sim-mujoco','python')
                if _gait_dir not in _sys.path:_sys.path.insert(0,_gait_dir)
                import gait as _gait
                model=_mj.MjModel.from_xml_path(str(source))
                data=_mj.MjData(model)
                # qpos 必须落在**源的 home 关键帧**上（同 sim-mujoco 的 key_name/key_qpos 口径）：
                # MjData 初值是 qpos0（关节 ref，Go1 全为 0），此时腿是完全伸直的奇异位形，
                # gait.calibrate 会得到 r=l1+l2、b0=0°（退化），相位目标随即越出关节限位。
                # 用源声明的 keyframe（缺省 'home'）把腿摆到站立位，标定才与 MuJoCo 侧同源。
                key_name=(entity.get('config')or{}).get('keyframe','home')
                key_id=_mj.mj_name2id(model,_mj.mjtObj.mjOBJ_KEY,key_name)
                home_q=model.key_qpos[key_id]if key_id>=0 else model.qpos0
                data.qpos[:]=home_q
                for name,value in ((entity.get('config')or{}).get('initialJointPositions')or{}).items():
                    idx=_mj.mj_name2id(model,_mj.mjtObj.mjOBJ_JOINT,name)
                    if idx>=0:data.qpos[int(model.jnt_qposadr[idx])]=float(value)
                _mj.mj_forward(model,data)
                joints={}
                for index in range(model.njnt):
                    name=model.joint(index).name
                    joints[name]={'id':index,'qpos':int(model.jnt_qposadr[index]),'dof':int(model.jnt_dofadr[index])}
                # base body = 第一条腿的髋关节所属 body 的**最上层祖先**（同 sim-mujoco 的 info['body'] 角色）
                first=legs_cfg[0][0] if isinstance(legs_cfg[0],(list,tuple))else legs_cfg[0]
                body_id=int(model.jnt_bodyid[joints[first]['id']])
                while int(model.body_parentid[body_id])!=0:body_id=int(model.body_parentid[body_id])
                legs=_gait.calibrate(model,data,{'body':body_id,'joints':joints},[list(group)for group in legs_cfg])
            except SceneError:raise
            except Exception as error:
                return None,'UNSUPPORTED_CAPABILITY: 四足步态标定失败（gait.calibrate 拒绝该机型几何）：'+type(error).__name__+': '+str(error)
            return legs,None
        for eid,e in self.entities.items():
            robot=e['articulation']
            if robot is None:continue
            if not robot.is_physics_tensor_entity_valid():raise SceneError('PHYSICS_NOT_READY','Articulation tensor未实际初始化: '+eid)
            names=robot.dof_names;e['names']=names;e['indices']={name:i for i,name in enumerate(names)};meta=e['metadata'];cfg=e['controller'];joints=meta.get('joints',{});acts=meta.get('actuators',{})
            # MJCF关节只有映射到真实actuator才算受控；零执行器的被动机构（门/抽屉）
            # 必须保留空controlled，不得回退成“全部关节可驱动”。源元数据缺失（URDF/原生USD分支
            # convert() 返回 metadata={}）时改由**导入后 USD articulation 的逐 DOF drive 读回**给出
            # 受控集合（ISAAC-12：既不"全部可控"，也不"整条通道不可用"，而是按引擎真实回报）；
            # 引擎一个 drive 都读不到时仍保守为空，并标注来源不可用。
            e['engineDrive']=engine_drive_metadata(robot,names)if not joints else {'perJoint':{},'note':None,'driveTypesAvailable':False}
            if joints:
                e['controlled']=controlled_joints(names,joints);e['controlledSource']='source-metadata'
            elif e['engineDrive']['perJoint']:
                e['controlled']=[name for name in names if name in e['engineDrive']['perJoint']];e['controlledSource']='engine-drive-readback'
            else:
                e['controlled']=[];e['controlledSource']='unavailable'
            e['actuatorJoints']={name:a['joint'] for name,a in acts.items() if a.get('joint') in names}
            # N40 缺口 5：MJCF 把**直接挂在 <worldbody> 根 body 上的关节**静默丢弃（N33 实测：去掉 <tendon>
            # 仍复现、fixBase 无效）。源声明关节数与导入后 DOF 数在这里可核对，因此在**既有** warnings 通道
            # 报一条可读说明；不改官方导入器、不动 fixBase。只在源声明多于导入时发（对得上的夹具不产生噪音）。
            dropped=[name for name in joints if name not in e['indices']]
            if dropped:
                self.import_warnings.append({'code':'MJCF_ROOT_JOINT_DROPPED','entityId':eid,
                    'message':eid+'：源 MJCF 声明 '+str(len(joints))+' 个关节，导入后 articulation 的 DOF 为 '+str(len(names))+'，其中 '+str(len(dropped))+' 个不在 DOF 里（'+', '.join(dropped[:8])+'）：直接挂在 <worldbody> 根 body 上的关节被官方导入器丢弃，Isaac 侧无法驱动这些关节；请在源侧把关节挂到非根 body，或改用原生 USD 源'})
            with use_backend('tensor',raise_on_fallback=True):
                positions=array(robot.get_dof_positions()).reshape(-1)
                for name,joint in joints.items():
                    if name in e['indices']:positions[e['indices'][name]]=joint['home']
                robot.set_dof_positions(positions.tolist());robot.set_dof_position_targets(positions.tolist());robot.set_dof_velocities([0.]*len(names))
                stiffness,damping=robot.get_dof_gains();stiffness=array(stiffness).reshape(-1);damping=array(damping).reshape(-1);efforts=array(robot.get_dof_max_efforts()).reshape(-1)
                # MJCF关节阻尼是源声明的被动力：官方importer把它写成USD源属性mjc:damping
                # （mujoco_usd_converter/_impl/joint.py apply_mjc_joint_api；导入层实测见
                # payloads/Physics/mujoco.usda: uniform double mjc:damping = 2），而mjcPhysics
                # schema原文说明它是“a force linear in velocity ... included in the passive
                # forces.”——PhysX没有任何消费该属性的路径，所以阻尼在导入后失效。
                # 这里按源声明（scene_adapter由MuJoCo编译结果给出的dof damping）映射到PhysX
                # 关节轴粘性摩擦：同样正比于速度的被动力，不是actuator增益，二者互不覆盖。
                # 主动执行器/夹爪增益仍由下面acts/gripper配置决定。
                viscous=[(name,e['indices'][name],float(joint.get('damping')or 0.))for name,joint in joints.items()if name in e['indices']and float(joint.get('damping')or 0.)>0]
                if viscous:
                    robot.set_dof_friction_properties(viscous_frictions=[value for _,_,value in viscous],dof_indices=[index for _,index,_ in viscous])
                    # 静默丢失不可接受：回读PhysX侧真实值，声明未被接受就明确失败。
                    actual=array(robot.get_dof_friction_properties()[2]).reshape(-1)
                    ignored=[name+'：源声明'+str(value)+'，PhysX实测'+str(float(actual[index]))for name,index,value in viscous if abs(float(actual[index])-value)>1e-6]
                    if ignored:raise SceneError('ENGINE_ERROR','PhysX未接受源声明的关节阻尼: '+', '.join(ignored))
                for name,a in acts.items():
                    j=a.get('joint')
                    if j not in e['indices']:continue
                    index=e['indices'][j]
                    # 力矩执行器的 PD 增益：逐关节 jointKp/jointKd 优先，缺该关节回落标量 kp/kd；
                    # 两者都没有沿用旧默认 120/4（PhysX 位置 drive = MuJoCo 端同一 PD 律）。
                    stiffness[index]=a['stiffness'] if a['mode']!='torque' else joint_gain(cfg,'jointKp',j,'kp',120)
                    damping[index]=a['damping'] if a['mode']!='torque' else joint_gain(cfg,'jointKd',j,'kd',4)
                    # 执行器力限不在这里按单个actuator覆盖：源jnt_actfrcrange/forcerange已由导入层
                    # 按MuJoCo物理语义折算成关节级drive maxForce（gear缩放、多执行器求和、与关节钳位
                    # 取交，见scene_adapter.apply_drive_force_limits）并写进USD；这里再用未缩放的
                    # max(abs(forcerange))覆盖会把源约束改宽或改窄，甚至绕过关节级钳位。
                    # 源资产的权限就是唯一真值：部署配置只能给增益（jointKp/jointKd），不给力限。

                gripper=cfg.get('gripper')
                if gripper:
                    tendon=acts.get(gripper.get('actuator'),{})
                    for name in gripper['jointNames']:
                        if name not in e['indices']:raise SceneError('INVALID_CONTROL_MAPPING','夹爪关节不存在: '+name)
                        index=e['indices'][name];stiffness[index]=gripper.get('stiffnessNpm',tendon.get('stiffness',800));damping[index]=gripper.get('dampingNspm',tendon.get('damping',28));efforts[index]=gripper.get('maxForceN',tendon.get('maxEffort') or 100)
                robot.set_dof_gains(stiffness.tolist(),damping.tolist());robot.set_dof_max_efforts(efforts.tolist())
                # 力限同样不能静默丢失：回读PhysX侧真实生效的maxForce，声明了有限限值的DOF逐一核对；
                # inf是"源无限制/引擎默认"，不参与比较。
                actual_efforts=array(robot.get_dof_max_efforts()).reshape(-1)
                rejected=[names[i]+'：声明'+str(float(efforts[i]))+'，PhysX实测'+str(float(actual_efforts[i]))for i in range(len(names))if np.isfinite(efforts[i])and not(np.isfinite(actual_efforts[i])and abs(float(actual_efforts[i])-float(efforts[i]))<=1e-6)]
                if rejected:raise SceneError('ENGINE_ERROR','PhysX未接受声明的执行器力限: '+', '.join(rejected))
                robot.set_solver_iteration_counts(position_counts=32,velocity_counts=8)
            # ISAAC-14：四足步态标定（只在资产显式声明 controller.legs 时做；几何全部来自 gait.calibrate）。
            e['gaitLegs'],e['gaitReason']=calibrate_gait(e)
    def thrust_mapping(self,e):
        """该实体的体坐标 wrench 映射；非无关节自由刚体一律明确拒绝，不改走 articulation 路径。

        thrust 通道只适用于“自由根刚体 + 源模型声明 site 执行器映射”的实体（如 MJCF 无人机）：
        源元数据给出 site 系 gear/gain/ctrlrange/forcerange 与质量，引擎侧只有一个刚体接收外力。
        关节机构没有这套映射（它的外力语义要经关节空间），因此不在这里退化成按关节施力。
        """
        if e['articulation'] is not None:
            raise SceneError('UNSUPPORTED_CAPABILITY','thrust 通道只适用于无关节自由刚体；该实体是 articulation: '+e['entity']['entityId'])
        if not e['rigidPaths']:
            raise SceneError('UNSUPPORTED_CAPABILITY','thrust 需要实体有真实刚体（RigidBodyAPI）；当前实体没有: '+e['entity']['entityId'])
        return wrench_mapping(e['metadata'],e['controller'])
    def capabilities(self,e):
        """只读能力面：该实体各动作类别（thrust/vehicle/joint/gait/tendon/gripper/lift/control）的可用性与**明确原因**。

        消费者（工具面/计划器）据此选择动作；不可用必须给出错误码级原因，而不是留空或抛异常让调用方自己猜。
        每条的判定条件与 prepare() 的实际拒绝同源：available=true 的动作类别，prepare() 不会因缺源声明/配置/时钟而被拒绝。
        gait 一项按**该实体自身腿结构**回答（ISAAC-14）；tendon 一项按**源 tendon 执行器逐条**回答（ISAAC-15）。
        """
        def tendon_description(metadata,entity_id,names,indices):
            """源 tendon 执行器 → `TendonActuatorDescription`（sim-contract 合同字段；名字是源 tendon 名）。

            源元数据只到 `{width,adr}` 时"这条 tendon 由哪些关节什么系数构成、哪个执行器驱动它、源限制区间
            是什么"都读不到，而工具 schema 的 tendon 参数说明明确要求"逐条关节/系数/单位见 robot_describe
            的 tendonActuators"。这里把合同要求的字段从已编译源模型如实填出：
              · controlMode：只有核对过固定位置力律（mjGAIN_FIXED／mjBIAS_AFFINE 且 kp=-biasprm[1]>0，
                与关节执行器同一判据）才是 'position'，其余一律 'custom'——tendon 动作会拒绝 custom；
              · joints/coefficients：fixed tendon 的关节级 wrap 与源 coef（Σ coef·q 就是肌腱坐标）；
              · unit：全部 hinge→rad、全部 slide→m、混合→mixed；
              · controlRange 按合同定义=源 ctrlrange 除以 gear（自定义力律下 ctrl 不是坐标，故为 null）。
            缺源元数据（URDF/原生 USD：metadata={}）时返回空列表——那是"源没有肌腱声明"，不是"查不到"。
            """
            declared=metadata.get('tendons')or{}
            if not declared:return []
            joints_meta=metadata.get('joints')or{};rows=[]
            for tendon_name,definition in declared.items():
                wraps=[wrap for wrap in definition.get('wraps')or[]if wrap.get('type')=='mjWRAP_JOINT']
                coefficients=[float(wrap.get('coefficient'))for wrap in wraps]
                joint_names=[wrap.get('objectName')for wrap in wraps]
                types=[(joints_meta.get(name)or{}).get('type')for name in joint_names]
                unit='mixed' if len({value for value in types if value})>1 else('m' if types and types[0]=='slide' else 'rad')
                for actuator in definition.get('actuators')or[]:
                    gainprm=list(actuator.get('gainprm')or[0.,0.,0.]);biasprm=list(actuator.get('biasprm')or[0.,0.,0.])
                    kp=max(0.,-float(biasprm[1]))if len(biasprm)>1 else 0.
                    faithful=actuator.get('gainType')=='mjGAIN_FIXED'and actuator.get('biasType')=='mjBIAS_AFFINE'and kp>0
                    gear=float(actuator.get('gear0')or 0.)
                    ctrl=actuator.get('ctrlRange')
                    control_range=[float(ctrl[0])/gear,float(ctrl[1])/gear]if ctrl is not None and gear else None
                    row={'name':tendon_name,'actuator':actuator.get('name'),'controlMode':'position'if faithful else 'custom',
                         'tendonType':definition.get('type','fixed'),
                         'joints':joint_names if definition.get('type')=='fixed'else[],
                         'coefficients':coefficients if definition.get('type')=='fixed'else[],
                         'unit':unit,'gear':gear,'controlRange':control_range,
                         'ctrlRange':list(ctrl)if ctrl is not None else None,
                         'forceRange':list(actuator['forceRange'])if actuator.get('forceRange')is not None else None,
                         'gainprm':gainprm,'biasprm':biasprm,
                         'addressable':bool(wraps)and all(name in indices for name in joint_names)and definition.get('type')=='fixed',
                         'blockedBy':tendon_blocking_reason(definition,joint_names,indices,faithful,entity_id)}
                    rows.append(row)
            return rows

        def tendon_blocking_reason(definition,joint_names,indices,faithful,entity_id):
            """一条源 tendon 为什么不能被 Isaac 动作为通道落地；None 表示机制上可落地。

            只讲**当前适配层的真实边界**，不把"没接线"说成"引擎没有"：本机 PhysX 6.0.1 暴露的是
            fixed tendon 的**静态属性**面（omni.physics.tensors 的 get_fixed_tendon_stiffnesses/
            dampings/limit_stiffnesses/limits/rest_lengths/offsets 与 set_fixed_tendon_properties），
            **没有肌腱长度/速度的运行时读回 API**；因此"命令肌腱坐标 → 回读实际坐标判到位"这条闭环无法成立
            （合同要求回执里的坐标是实测值，不接受用关节角反算冒充）。
            """
            if not joint_names:return 'UNSUPPORTED_CAPABILITY: 该 tendon 没有任何关节级 wrap（spatial/site 类型）：肌腱坐标不是关节坐标的线性组合，本适配层没有对应通道'
            missing=[name for name in joint_names if name not in indices]
            if missing:return 'UNSUPPORTED_CAPABILITY: 该 tendon 缠绕的关节不在导入后的 DOF 里（'+', '.join(missing)+'）：肌腱坐标算不出来，见 MJCF_ROOT_JOINT_DROPPED 告警'
            if not faithful:return 'UNSUPPORTED_CAPABILITY: 驱动该 tendon 的源执行器不是核对过的固定位置力律（controlMode=custom）：ctrl 不是肌腱坐标，不冒充 position'
            return 'UNSUPPORTED_CAPABILITY: Isaac/PhysX 侧没有肌腱长度/速度的运行时读回面（本机 omni.physics.tensors 只有 fixed/spatial tendon 的静态属性 get/set），无法回读实际肌腱坐标判到位；本适配层不接一条没有到位判据的动作通道，也不用关节角反算冒充实测'

        def gait_structure(entity):
            """四足腿结构的**轻量预检**：能不能给出 4 条腿 × 3 关节（abduction/thigh/knee）且都可驱动。

            注意：这里**不计算任何几何量**。几何（l1/l2/fore/depth/b0/td/bs/ss/ks/lateral/phase）
            一律由 `packages/sim-mujoco/python/gait.py` 的 `calibrate()` 给出（见 configure_robots
            的 calibrate_gait），避免"同一份事实存两处、两处不一致"。
            腿分组优先读 `controller.legs`（与 sim-mujoco 同一配置键）；没有声明时按
            FR/FL/RR/RL × hip/thigh/calf/knee 的命名分组**探测**，只用于把"差什么"讲清楚。
            """
            names=list(entity.get('names')or[])
            jmeta=entity['metadata'].get('joints')or{}
            engine=entity.get('engineDrive')or{};drive_names=set(engine.get('perJoint')or{})
            def driven(name):
                if jmeta:return bool(jmeta.get(name,{}).get('actuator')or jmeta.get(name,{}).get('tendonActuators'))
                return name in drive_names
            cfg_legs=entity['controller'].get('legs')if isinstance(entity['controller'],dict)else None
            if isinstance(cfg_legs,list)and len(cfg_legs)==4:
                groups=[(str(index),list(group))for index,group in enumerate(cfg_legs)]
            else:
                groups=[]
                for prefix in ('FR','FL','RR','RL'):
                    picked=[]
                    for suffix in ('hip','thigh','calf','knee'):
                        match=[name for name in names if name.startswith(prefix)and suffix in name]
                        if len(match)==1:picked.append(match[0])
                    if picked:groups.append((prefix,picked))
            if not groups:
                return {'legs':[],'complete':False,'reason':'该机型没有可识别的四足腿分组（既没有 controller.legs 声明，DOF 名里也没有 FR/FL/RR/RL × hip/thigh/calf/knee 的结构）：四足步态需要 4 条腿 × 3 关节'}
            legs=[];problems=[]
            for leg,group in groups:
                undriven=[name for name in group if not driven(name)]
                legs.append({'leg':leg,'joints':group,'allPositionActuated':not undriven,'undrivenJoints':undriven})
                if len(group)!=3:problems.append(leg+'（关节数 '+str(len(group))+'≠3）')
                elif undriven:problems.append(leg+'（未声明/无 drive: '+', '.join(undriven)+'）')
            if len(legs)!=4:problems.append('只识别到 '+str(len(legs))+' 条腿（需要 4 条）')
            return {'legs':legs,'complete':not problems,
                    'reason':('该机型的腿结构不完整：'+'；'.join(problems))if problems else None}

        not_articulated_joint='ENTITY_NOT_ARTICULATED: 该实体是无关节刚体，没有关节通道'
        passive_target='UNSUPPORTED_CAPABILITY: 未声明对应执行器的被动关节不能作为位置动作目标: '
        cfg=e['controller'] if isinstance(e['controller'],dict) else {};items=[]
        try:mapping=self.thrust_mapping(e)
        except SceneError as error:items.append({'kind':'thrust','available':False,'reason':error.code+': '+str(error)})
        else:items.append({'kind':'thrust','available':True,
                           'actuators':mapping['actuators'],'siteBody':mapping['siteBody'],'massKg':mapping['massKg'],
                           'controlRanges':{name:limit['ctrlRange'] for name,limit in mapping['limits'].items()},
                           'forceRanges':{name:limit['forceRange'] for name,limit in mapping['limits'].items()},
                           'frame':mapping['frame']})
        articulated=e['articulation'] is not None;wheels=cfg.get('wheels');steering=cfg.get('steering')or{}
        if not articulated:items.append({'kind':'vehicle','available':False,'reason':'UNSUPPORTED_CAPABILITY: 无关节实体没有可寻址的 wheel/steering 执行器（没有 articulation）'})
        elif cfg.get('type')!='vehicle':items.append({'kind':'vehicle','available':False,'reason':'MISSING_CONTROL_CONFIG: 该资产没有 vehicle wheels/steering 配置'})
        elif not wheels:items.append({'kind':'vehicle','available':False,'reason':'MISSING_CONTROL_CONFIG: 车辆需要SI wheels/steering配置'})
        else:
            problems=[]
            if cfg.get('steering')and not steering.get('actuators'):problems.append('MISSING_CONTROL_CONFIG: steering 缺 actuators 列表')
            for wheel in wheels:
                try:positive(wheel.get('radiusM'),'radiusM')
                except SceneError as error:problems.append(error.code+': '+str(error))
            for name in [wheel.get('joint')or wheel.get('actuator')for wheel in wheels]+list(steering.get('actuators')or[]):
                try:self.resolve_actuator(e,name)
                except SceneError as error:problems.append(error.code+': '+str(error))
            size='wheelbaseM' if cfg.get('steering')else 'trackWidthM'
            try:positive(cfg.get(size),size)
            except SceneError as error:problems.append(error.code+': '+str(error))
            if problems:items.append({'kind':'vehicle','available':False,'reason':'; '.join(problems)})
            else:items.append({'kind':'vehicle','available':True,'wheels':len(wheels),'steering':bool(cfg.get('steering'))})
        if not articulated:items.append({'kind':'joint','available':False,'reason':not_articulated_joint})
        elif not e['names']:
            items.append({'kind':'joint','available':False,'reason':'ENTITY_NOT_ARTICULATED: 该实体有 articulation，但导入后关节数为 0（源 metadata.joints 声明 '+str(len(e['metadata'].get('joints')or{}))+' 个），没有可寻址的关节通道'})
        elif (e['metadata'].get('joints')or{})or(e.get('engineDrive')or{}).get('perJoint'):
            items.append({'kind':'joint','available':True,'joints':len(e['names']),'controlledJointNames':list(e['controlled']),
                           'controlledSource':e.get('controlledSource','unavailable')})
        else:
            items.append({'kind':'joint','available':True,'joints':len(e['names']),'controlledJointNames':[],
                           'controlledSource':'unavailable','engineDriveUnverified':True,
                           'reason':'UNSUPPORTED_CAPABILITY: 源资产没有可核验的关节/执行器元数据，且导入后 articulation 的逐 DOF drive 读回没有给出任何可寻址关节（get_dof_drive_types 全为 none 且 maxEffort 全为 inf）：DOF 位置通道存在（按索引下发），但**受控/被动划分未核验**，controlledJointNames 保守为空；需要受控性结论请先在源侧提供关节/执行器元数据'})
        # ISAAC-14：步态可用性以**已标定的 gait.calibrate 结果**为准（与下发路径同一份数据）。
        gait_legs=e.get('gaitLegs')if articulated else None
        gait_probe=gait_structure(e)if articulated else {'legs':[],'complete':False,'geometry':None,'reason':'ENTITY_NOT_ARTICULATED: 无关节实体没有腿结构'}
        e['gaitGeometry']=gait_probe if gait_probe['complete']else None
        if gait_legs:
            # 标定成功 = 通道真的能下发（prepare 读的就是这一份）。几何量全部来自 gait.calibrate()，
            # 与 packages/sim-mujoco/python/gait.py 同一份实现，不存在第二套口径。
            items.append({'kind':'gait','available':True,'legs':gait_legs,
                          'controller':'packages/sim-mujoco/python/gait.py（同一份实现，直接 import；非 Isaac 侧重写）',
                          'geometrySource':'gait.calibrate（源 MJCF 经 MuJoCo mj_forward 的 xpos/xmat/geom_xpos）',
                          'frequencyHz':GAIT_FREQUENCY_HZ,'strideM':GAIT_STRIDE_M,'liftM':GAIT_LIFT_M,
                          'jointNames':[name for leg in gait_legs for name in leg['names']]})
        else:
            items.append({'kind':'gait','available':False,
                          'reason':'UNSUPPORTED_CAPABILITY: '+(e.get('gaitReason')or(gait_probe['reason']if gait_probe else None)or'该机型不具备几何步态所需结构'),
                          'legs':gait_probe['legs']if gait_probe else [],'geometryReady':False})
        tendon_rows=tendon_description(e['metadata'],e['entity']['entityId'],list(e.get('names')or[]),e.get('indices')or{})
        e['tendonRows']=tendon_rows
        declared_tendons=e['metadata'].get('tendons')or{}
        if tendon_rows:
            blocked=[row for row in tendon_rows if row['blockedBy']]
            items.append({'kind':'tendon','available':False,'reason':(blocked[0]['blockedBy']if blocked else 'UNSUPPORTED_CAPABILITY: 源的 tendon 执行器在本适配层没有动作通道'),
                          'tendons':[{key:row[key]for key in ('name','actuator','controlMode','tendonType','joints','coefficients','unit','gear','controlRange','ctrlRange','forceRange','addressable','blockedBy')}for row in tendon_rows]})
        elif declared_tendons:
            items.append({'kind':'tendon','available':False,
                          'reason':'UNSUPPORTED_CAPABILITY: 源声明了 '+str(len(declared_tendons))+' 条 tendon（'+', '.join(list(declared_tendons)[:8])+'），但没有任何执行器的传动是 mjTRN_TENDON（源侧没有 tendon 执行器驱动它们）：没有可寻址的肌腱驱动通道；这不是适配层缺接线，要在源侧为该 tendon 声明 actuator',
                          'declaredTendons':list(declared_tendons)})
        else:
            items.append({'kind':'tendon','available':False,'reason':'UNSUPPORTED_CAPABILITY: 源模型没有 tendon 声明，tendon 动作没有坐标可寻址'})
        declared=e['metadata'].get('joints')or{}
        def passive(names):return [name for name in names if declared and not(declared.get(name,{}).get('actuator')or declared.get(name,{}).get('tendonActuators'))]
        gripper=cfg.get('gripper');gripper_names=(gripper.get('jointNames')if isinstance(gripper,dict)else None)or[]
        if not articulated:items.append({'kind':'gripper','available':False,'reason':'ENTITY_NOT_ARTICULATED: 该实体是无关节刚体，没有夹爪关节通道'})
        elif not gripper:items.append({'kind':'gripper','available':False,'reason':'MISSING_CONTROL_CONFIG: 该资产没有 controller.gripper 关节映射'})
        elif not gripper_names or gripper.get('maxWidthM')is None:items.append({'kind':'gripper','available':False,'reason':'MISSING_CONTROL_CONFIG: controller.gripper 缺 jointNames/maxWidthM，宽度无法换算成关节目标'})
        elif any(name not in e['indices']for name in gripper_names)or len(set(gripper_names))!=len(gripper_names):items.append({'kind':'gripper','available':False,'reason':'INVALID_JOINT_VECTOR: 夹爪关节名称非法或重复'})
        elif passive(gripper_names):items.append({'kind':'gripper','available':False,'reason':passive_target+', '.join(passive(gripper_names))})
        else:items.append({'kind':'gripper','available':True,'jointNames':list(gripper_names),'maxWidthM':gripper['maxWidthM']})
        lift=cfg.get('lift');lift_joint=lift.get('joint')if isinstance(lift,dict)else None
        if not articulated:items.append({'kind':'lift','available':False,'reason':'ENTITY_NOT_ARTICULATED: 该实体是无关节刚体，没有升降关节通道'})
        elif not lift:items.append({'kind':'lift','available':False,'reason':'MISSING_CONTROL_CONFIG: 该资产没有 controller.lift 映射'})
        elif lift_joint not in e['indices']:items.append({'kind':'lift','available':False,'reason':'INVALID_JOINT_VECTOR: lift 关节不存在: '+str(lift_joint)})
        elif passive([lift_joint]):items.append({'kind':'lift','available':False,'reason':passive_target+lift_joint})
        else:items.append({'kind':'lift','available':True,'joint':lift_joint})
        acts=e['metadata'].get('actuators')or{}
        addressable=[name for name in e['names']if declared.get(name,{}).get('actuator')in acts and acts[declared[name]['actuator']].get('mode')!='velocity']if articulated else []
        engine_driven=[name for name in(e.get('engineDrive')or{}).get('perJoint',{})if name in e.get('indices',{})]
        if not articulated:items.append({'kind':'control','available':False,'reason':not_articulated_joint})
        elif self.clock!='manual':items.append({'kind':'control','available':False,'reason':'UNSUPPORTED_CAPABILITY: 按物理步采样的 control 需要显式 manual world（当前 clock='+str(self.clock)+'）'})
        elif not declared and engine_driven:
            items.append({'kind':'control','available':True,'jointNames':engine_driven,'source':'engine-drive-readback',
                          'engineDrive':{name:dict(e['engineDrive']['perJoint'][name])for name in engine_driven},
                          'note':(e['engineDrive'].get('note')or'受控性来自导入后 USD articulation 的逐 DOF drive 读回；引擎回报的 drive type 只有 force/acceleration，不等于源侧 position/velocity 执行器语义')})
        elif not declared:items.append({'kind':'control','available':False,'reason':'UNSUPPORTED_CAPABILITY: 源资产没有可核验的关节/执行器元数据（URDF/原生USD 分支 metadata={}），且导入后 articulation 的逐 DOF drive 读回也没有给出任何可寻址关节（get_dof_drive_types 全为 none 且 maxEffort 全为 inf）：没有关节能作为位置参考目标'})
        elif not addressable:items.append({'kind':'control','available':False,'reason':'UNSUPPORTED_CAPABILITY: 没有 mode 非 velocity 的关节级执行器；velocity 执行器请用 trajectory/joint 动作'})
        else:items.append({'kind':'control','available':True,'jointNames':addressable})
        return items

    def free_bases(self,e):
        """observe 会报告的自由根（只读发现元数据），带源声明的质量；不是受控关节。"""
        free_base=e['metadata'].get('freeBase',{})
        if not free_base.get('present'):return []
        item={'jointName':free_base.get('jointName') or '','bodyName':free_base.get('sourceRootBody') or ''}
        if free_base.get('massKg') is not None:item['massKg']=float(free_base['massKg'])
        return [item]
    def entity_contacting(self,eid):
        """该实体当前是否仍有引擎接触报告（联系人订阅的实时状态，不是模型推算）。"""
        prefix=eid+'/'
        return any(point['geom1'].startswith(prefix)or point['geom2'].startswith(prefix)for points in self.contacts.values()for point in points)
    def label(self,path):
        for eid,e in self.entities.items():
            if path==e['path'] or path.startswith(e['path']+'/'):return eid+'/'+e.get('collisionNames',{}).get(path,path[len(e['path']):].strip('/'))
        return path
    def contact_event(self,headers,data):
        for header in headers:
            a=str(PhysicsSchemaTools.intToSdfPath(header.collider0));b=str(PhysicsSchemaTools.intToSdfPath(header.collider1));key=(a,b)
            if header.type==ContactEventType.CONTACT_LOST:self.contacts.pop(key,None);continue
            points=[]
            for i in range(header.contact_data_offset,header.contact_data_offset+header.num_contact_data):
                c=data[i];points.append({'geom1':self.label(a),'geom2':self.label(b),'distanceM':float(c.separation),'positionM':list(c.position),'normal':list(c.normal),'forceN':[float(v)/self.dt for v in c.impulse],'sourceStep':self.index+1})
            if points:self.contacts[key]=points
    def describe(self,eid):
        self.ready();e=self.entry(eid)
        # 无关节实体（自由刚体：无人机等）不走 articulation 取用路径：它没有关节可描述，
        # 但它有真实的控制能力面（thrust/vehicle 可用性）必须明确回答，不能报“实体不存在”。
        # 有 controller 声明（vehicle/drone 通道的合法载体）才扩到这条路径；没有任何控制声明的
        # 纯刚体（碰撞方块等）保持既有边界：describe 只服务可控实体，仍报 ENTITY_NOT_ARTICULATED。
        if e['articulation'] is None and not (isinstance(e['controller'],dict) and e['controller']):raise SceneError('ENTITY_NOT_ARTICULATED',eid)
        # 模型身份（DEV-027 §3.5，与 sim-mujoco worker 的 describe 同一体例）：旧实现把资源列表字符串化，
        # 于是 resources=[] 的实体（panda 夹具就是）恒得字符串 "[]"，而合同 §2.7 要求 MotionPlan 带
        # 机器人/模型版本；G08/G09 侧此前只判 Boolean(modelVersion)，对 "[]" 恒真 ⇒ 判据不可能红。
        # 这里改用**本次真正喂给导入器的源路径**（scene_adapter.mjcf_metadata 写进 metadata['source']
        # 的那一份，与 MuJoCo 侧优先 sourcePath 同一口径），退化时用 USD 根 prim 路径 + 资源数构造
        # `isaac-usd:<根prim>#<n>res`——绝不返回空串或 "[]"。
        model_source=(e.get('metadata')or{}).get('source')or(e.get('config')or{}).get('sourcePath')
        if model_source:
            model_version=str(model_source)
        else:
            model_root=(e['articulation'].paths[0]if e['articulation'] is not None and e['articulation'].paths
                        else(e['rigidPaths'][0]if e['rigidPaths']else eid))
            model_resources=e['entity'].get('resources')or[]
            model_version='isaac-usd:'+str(model_root)+'#'+str(len(model_resources)if isinstance(model_resources,list)else 0)+'res'
        base={'entityId':eid,'modelVersion':model_version,
              'expectedGeneration':self.generation,'collisionContextVersion':str(self.generation),
              'controller':e['controller'],'capabilities':self.capabilities(e)}
        if getattr(self,'stage',None) is not None and (e.get('metadata')or{}).get('rootBodies'):
            from robot_authoring import authoring_description
            base.update(authoring_description(self,eid))
        free_bases=self.free_bases(e)
        if free_bases:base['freeBases']=free_bases
        # ISAAC-15：源 tendon 执行器逐条说明（源肌腱名/执行器/关节与系数/单位/限制）。源没有肌腱时
        # 该键不出现（与其它"源未声明即无此键"的既有约定一致）；有声明就逐条如实给出，不再让调用方
        # 去读一个合同里有、而这里从不投递的字段。逐条内容与 capabilities.tendon 同源（同一个
        # capabilities() 内嵌生成器），不在两处各算一套。
        # capabilities() 刚在同一实体上算过一遍（上面的 base['capabilities']），并把逐条 tendon 结论
        # 留在 e['tendonRows']；这里读**同一份**，保证 describe.tendonActuators 与 capabilities.tendon 不漂移。
        tendon_rows=e.get('tendonRows')or[];tendon_actuators=[]
        for row in tendon_rows:
            item={'name':row['name'],'actuator':row['actuator'],'controlMode':row['controlMode'],'tendonType':row['tendonType'],
                  'joints':row['joints'],'coefficients':row['coefficients'],'unit':row['unit'],'gear':row['gear'],
                  'controlRange':row['controlRange'],'ctrlRange':row['ctrlRange'],'forceRange':row['forceRange'],
                  'gainprm':row['gainprm'],'biasprm':row['biasprm']}
            # 合同 TendonActuatorDescription 只列到上面这些键；本适配层的"能不能落地+为什么"是**附加**键，
            # 与 capabilities.tendon 逐条一致（addressable/blockedBy），调用方不必去 capabilities 里再对一遍。
            item['addressable']=row['addressable'];item['blockedBy']=row['blockedBy']
            tendon_actuators.append(item)
        if tendon_actuators:base['tendonActuators']=tendon_actuators
        if e['articulation'] is not None and e.get('controlledSource')!='source-metadata':
            # 来源缺失不静默留白：明确说明 controlledJointNames 是谁给的、依据是什么。引擎读回里有
            # 真实 drive 时给出逐 DOF 证据（driveType/maxEffort）；一条都没有时仍是"不可用"。
            source_note=('源资产未提供可核验的关节/执行器元数据（URDF 与原生 USD 分支 convert() 返回 metadata={}）：'
                         '源侧的受控/被动划分、执行器模式、gear/力限声明都无从核对（因此本状态恒为 UNAVAILABLE）。'
                         '受控集合改由导入后 USD articulation 的逐 DOF drive 读回给出（见 source=imported-usd-articulation-drive '
                         '与 engineDrive），它只说明"引擎侧这个 DOF 有没有 drive"（force/acceleration），'
                         '不等于源侧的执行器语义，也不是"全部 DOF 可控"的依据。')
            engine=(e.get('engineDrive')or{}).get('perJoint')or{}
            if engine:
                # status 恒为合同里的 'UNAVAILABLE'（RobotDescription.controlMetadata 目前只有一个取值）：
                # 源侧执行器语义确实没有拿到，这一个字面量不能因为"部分信息从引擎读回来了"就改口，
                # 否则既越出合同，也会让调用方把引擎 drive 当成源执行器语义。引擎读回的内容放在
                # source/engineDrive/note 三个键里，逐 DOF 可核对。
                base['controlMetadata']={'status':'UNAVAILABLE','reason':source_note,
                    'source':'imported-usd-articulation-drive','driveTypesAvailable':bool((e.get('engineDrive')or{}).get('driveTypesAvailable')),
                    # 逐 DOF 引擎证据：declared* 一律为 null —— 源侧没有声明可对照，不拿引擎值冒充源值。
                    'engineDrive':{name:{**entry,'declaredActuator':None,'declaredControlMode':None}for name,entry in engine.items()},
                    'note':(e.get('engineDrive')or{}).get('note')}
            else:
                base['controlMetadata']={'status':'UNAVAILABLE','reason':source_note+
                    '；导入后 articulation 的逐 DOF drive 读回也没有给出任何可寻址关节（get_dof_drive_types 全为 none 且 maxEffort 全为 inf）'}
        if e['articulation'] is None:return {**base,'joints':[],'controlledJointNames':[]}
        robot=e['articulation']
        with use_backend('tensor',raise_on_fallback=True):
            limits=joint_limits(robot);efforts=array(robot.get_dof_max_efforts()).reshape(-1);stiffness,damping=[array(v).reshape(-1)for v in robot.get_dof_gains()]
        engine_drive=(e.get('engineDrive')or{}).get('perJoint')or{}
        joints=[]
        for i,name in enumerate(e['names']):
            source=e['metadata'].get('joints',{}).get(name,{});jointtype=source.get('type')
            if jointtype is None:jointtype='slide' if 'ranslation' in str(robot.dof_types[i]) else 'hinge'
            item={'name':name,'type':jointtype,'unit':'m' if jointtype=='slide' else 'rad'}
            if np.isfinite(limits[i]).all():item['range']=limits[i].tolist()
            # 引擎侧 drive 回读（力限 N·m/N、位置 drive 的刚度/阻尼）：调用方要能核对源声明的执行器
            # 权限与 controller.jointKp/jointKd 的逐关节增益真的落到了引擎上，而不是只看行为推断。
            if np.isfinite(efforts[i]):item['driveMaxEffort']=float(efforts[i])
            if np.isfinite(stiffness[i]):item['driveStiffness']=float(stiffness[i])
            if np.isfinite(damping[i]):item['driveDamping']=float(damping[i])
            if name in e['controlled']:
                # 受控性与控制模式都只报源元数据声明的事实：mode 缺失时不默认 'position'，
                # 与 prepare(kind:'control') 的“关节无执行器”拒绝保持一致。源元数据缺失时受控性来自
                # 引擎 drive 读回，此时**只**报引擎回报的 driveType（force/acceleration），
                # 不用 actuator 名冒充源执行器（引擎侧没有这个身份）。
                if source.get('actuator'):
                    item['actuator']=source['actuator']
                    mode=joint_control_mode(e['metadata'],name)
                    if mode:item['controlMode']=mode
                elif name in engine_drive:
                    item['driveControlSource']='engine-drive-readback'
                    if engine_drive[name].get('driveType'):item['driveType']=engine_drive[name]['driveType']
            joints.append(item)
        return {**base,'joints':joints,'controlledJointNames':e['controlled']}
    def observe(self,selection=None):
        self.ready();selection=selection or {};frame=empty_frame(self)
        # Fabric同步是RTX观察/渲染的按需边界，不应把每个0.002s物理步变成GPU/CPU全场同步。
        # PhysX仍由唯一SM.step推进；读取命名site前刷新一次官方Fabric接口即可。
        if rendering and selection.get('sensors') is True:
            fabric=getattr(SM,'_physx_fabric_interface',None)
            if fabric is None:raise SceneError('SENSOR_UNAVAILABLE','RTX Fabric接口未初始化')
            fabric.update(SM.get_simulation_time(), self.dt)
        for eid,e in self.entities.items():
            if selection.get('entityIds') and eid not in selection['entityIds']:continue
            asleep=self.physx_sleeping(e)
            if e['articulation'] is not None or e['rigidPaths']:
                with use_backend('tensor',raise_on_fallback=True):p,q=e['pose'].get_world_poses();linear,angular=e['pose'].get_velocities();velocity=scalar_list(linear)+scalar_list(angular)
            else:p,q=e['pose'].get_world_poses();velocity=[0.]*6
            # 官方状态为sleeping时PhysX不再推进该刚体/机构，其瞬时速度真实为0；tensor缓冲此时
            # 停留在入睡前的旧值。只有官方sleeping状态确认后才用真实值，读不到状态(asleep=None)
            # 时保持引擎原值，不猜测、不强制清零。
            if asleep:velocity=[0.]*6
            p=array(p).reshape(-1);q=array(q).reshape(-1)
            item={'entityId':eid,'transform':{'position':p.tolist(),'quaternion':[*q[1:].tolist(),float(q[0])],'scale':e['entity']['transform'].get('scale',[1,1,1])}}
            if e.get('collision') and e['articulation'] is None:
                collider_prims=[self.stage.GetPrimAtPath(path) for path in e['collision']['colliderPaths']]
                enabled=[bool(UsdPhysics.CollisionAPI(prim).GetCollisionEnabledAttr().Get()) for prim in collider_prims]
                dynamic=bool(e['rigidPaths']);mass_kg=None
                root_prim=self.stage.GetPrimAtPath(e['path'])
                gravity=not bool(PhysxSchema.PhysxRigidBodyAPI(root_prim).GetDisableGravityAttr().Get())
                if dynamic:
                    with use_backend('tensor',raise_on_fallback=True):
                        mass_kg=float(array(e['pose'].get_masses()).reshape(-1).sum())
                        dynamic=bool(array(e['pose'].get_enabled_rigid_bodies()).reshape(-1).any())
                        gravity=bool(array(e['pose'].get_enabled_gravities()).reshape(-1).any())
                item['physics']={'source':'isaac-compiled','dynamic':dynamic,'massKg':mass_kg,'gravityEnabled':gravity,
                                 'collisionEnabled':any(enabled),'colliderCount':len(collider_prims),'bodyName':e['path']}
            motion=None
            if e['articulation'] is not None:
                with use_backend('tensor',raise_on_fallback=True):positions=scalar_list(e['articulation'].get_dof_positions());joint_velocity=scalar_list(e['articulation'].get_dof_velocities())
                if asleep:joint_velocity=[0.]*len(joint_velocity)
                item['joints']={'names':list(e['names']),'positions':positions,'velocities':joint_velocity}
                # 判停用的显式状态：全部来自引擎数据，不含任何推算。jointPositionDelta是相对
                # 上一次observe的DOF位置读数之差；contacting来自引擎联系人报告；awake且被接触
                # 阻挡时引擎速度读数可能冻结，所以jointVelocitySource标明该帧速度的来源，
                # 下游判停必须结合位姿时间差/位置差，而不是速度读数本身。
                previous=e.get('lastPositions');e['lastPositions']=positions
                motion={'asleep':asleep,'contacting':self.entity_contacting(eid),'positionDeltaFromSimTime':e.get('lastObserveSimTime'),
                        'jointPositionDelta':[a-b for a,b in zip(positions,previous)] if previous else None,
                        'jointVelocitySource':'sleeping-confirmed-zero' if asleep else 'engine'}
            e['lastObserveSimTime']=self.sim_time
            if selection.get('sensors',True):
                item['sensors']={'bodyLinearVelocityMps':velocity[:3],'bodyAngularVelocityRadps':velocity[3:],'asleep':asleep}
                if motion is not None:item['sensors']['motionState']=motion
                free_base=e['metadata'].get('freeBase',{})
                if free_base.get('present') and not e['config'].get('fixBase'):
                    world_to_local=np.asarray(Gf.Matrix3d(Gf.Quatd(float(q[0]),Gf.Vec3d(*q[1:].tolist()))))
                    item['sensors']['freeBase']={'jointName':free_base.get('jointName',''),'positionM':p.tolist(),'quaternionXyzw':[*q[1:].tolist(),float(q[0])],'linearVelocityWorldMps':velocity[:3],'angularVelocityLocalRadps':(world_to_local@np.asarray(velocity[3:])).tolist()}
                if selection.get('sensors',True):
                    # N57／ISAAC-06：`siteObservation` 此前只在 selection.sensors **严格等于 true** 时投递，
                    # 而速度/asleep 用的是 `.get('sensors',True)`——默认 `observe({})` 拿不到 site 观测，
                    # 调用方无法区分"源里没有 site"与"有 site 但没投递"。改用同一判据，其余行为不变。
                    item['sensors']['siteObservation']=e['siteStatus']
                    if e['siteStatus']['status']=='AVAILABLE':
                        sites={}
                        if e['sitePrims'] is not None:
                            # CPU PhysX每步写回USD；RTX使用已由同一step更新的Fabric层级。
                            # 官方API读取site的实时世界变换，禁止用关节FK或其他引擎代算。
                            with use_backend('fabric' if rendering else 'usd',raise_on_fallback=True):site_positions,site_quaternions=e['sitePrims'].get_world_poses()
                            # 变量名必须与 DOF 读数分开：旧代码把 site 的 get_world_poses() 结果写回
                            # `positions`/`quaternions`，覆盖了上面读到的 DOF 位置；site 一旦真的可用
                            # （命名 site 解析成功），下面按 DOF 索引采样的 mjcfSensors 就会拿 3 元 site
                            # 读数去索引 DOF（ValueError: only length-1 arrays…），把整个 observe 打成失败。
                            site_positions=array(site_positions);site_quaternions=array(site_quaternions)
                            for name,site_position,site_quaternion in zip(e['siteNames'],site_positions,site_quaternions):sites[name]={'positionM':site_position.tolist(),'quaternionXyzw':[*site_quaternion[1:].tolist(),float(site_quaternion[0])]}
                        item['sensors']['sites']=sites
                # N72／ISAAC-06：**能采样的就真采样**。jointpos/jointvel 的语义就是已导入 articulation 的
                # DOF 位置/速度，而本函数上面已经用官方 tensor API 读过它们（`positions`／`joint_velocity`），
                # 因此不需要新通道，也不伪造读数：逐条按声明的 objName 取同一个 DOF 值。
                # 其余类型（gyro/accelerometer/framepos/force/torque…）需要 SDK 的传感器扩展或 PhysX 力传感器，
                # 本适配层未接 → 逐条如实 `UNAVAILABLE` + 指向真实原因，**不填 0**。源没有声明时该键不出现。
                declared_sensors=e['metadata'].get('sensors')or{}
                if declared_sensors:
                    samples={};unsupported={}
                    for sensor_name,definition in declared_sensors.items():
                        raw=str(definition.get('type') or '');kind=str(definition.get('kind') or raw.split('_')[-1].lower());target=definition.get('objName')
                        addressable=e['articulation'] is not None and target in(e.get('indices')or{})
                        if kind in ('jointpos','jointvel') and addressable:
                            values=positions if kind=='jointpos' else joint_velocity
                            samples[sensor_name]={'type':kind,'object':target,'value':float(values[e['indices'][target]]),
                                'units':'rad' if kind=='jointpos' else 'radPerS','source':'articulation-dof-readback（与 observe.joints 同一引擎读数）'}
                        elif kind in ('jointpos','jointvel'):
                            # 目标名缺失（objName=None）与"名字有但不在导入后的 DOF 里"必须分开报：
                            # 前者是源侧元数据没解析出对象，后者才是真的被导入器丢了关节。旧代码两处
                            # 共用一句话，把"名字没查到"也写成"关节不在 DOF 里"，指向了错误的下一步。
                            if target is None:
                                unsupported[sensor_name]={'type':kind,'object':None,
                                    'reason':'源侧该 sensor 的对象名未能解析（objType='+str(definition.get('objType'))+'、objId 未映射到名字）：适配层的 MuJoCo 对象名解析失败，不能据此断言关节不存在；请核对源 MJCF 的 sensor 目标声明'}
                            else:
                                unsupported[sensor_name]={'type':kind,'object':target,
                                    'reason':'该传感器的目标关节不在导入后的 DOF 里（源侧声明='+str(target)+'，导入后 DOF='+str(list(e['names']))+'）：无读数可采，见 MJCF_ROOT_JOINT_DROPPED 告警'}
                        else:
                            unsupported[sensor_name]={'type':kind,'object':target,
                                'reason':'UNSUPPORTED_CAPABILITY: 本适配层只从 PhysX articulation DOF 回读采样 jointpos/jointvel；'+kind+' 需要 SDK 的传感器扩展（本机 isaacsim.exts 里 sensor 相关只有 isaacsim.sensors.experimental.physics／isaacsim.sensors.experimental.rtx／isaacsim.sensors.rtx.nodes 等需 Kit 运行时与渲染通道的扩展）或 PhysX 力传感器，本适配层未接'}
                    item['sensors']['mjcfSensors']={'status':'AVAILABLE' if samples and not unsupported else('PARTIAL' if samples else 'UNAVAILABLE'),
                        'declared':list(declared_sensors),'samples':samples,'unsupported':unsupported}
                    if not samples:
                        item['sensors']['mjcfSensors']['reason']='源声明的 '+str(len(declared_sensors))+' 条传感器没有一条能从现有引擎读数取到值（逐条原因见 unsupported），本适配层不填 0 冒充'
                declared_tendons=e['metadata'].get('tendons')or{}
                if declared_tendons:
                    dropped_clause=''
                    if not e['names'] and (e['metadata'].get('joints')or{}):
                        dropped_clause='；另注：本 world 的源侧关节未导入（根 body 关节被官方导入器丢弃，见 MJCF_ROOT_JOINT_DROPPED），tendon 反馈也随之无载体——这属于源侧问题，不是本通道未接线'
                    item['sensors']['tendons']={'status':'UNAVAILABLE','declared':list(declared_tendons),
                        # N72：原因指向**真实原因**（不再是笼统"未建立采样通道"）：Isaac/PhysX 侧没有 tendon 长度/张力回读面；
                        # 本机 SDK 里 tendon 只出现在官方 MJCF 导入器的文档与 omni.usd.schema.mujoco 的 schema 里，
                        # `omni.physx.bindings._physx`／`pxr.PhysxSchema` 在 Kit 外 import 均报 `ModuleNotFoundError: No module named 'omni'`。
                        'reason':'UNSUPPORTED_CAPABILITY: Isaac/PhysX 侧没有 tendon 长度/张力回读面：源 MJCF 的 <tendon> 在本适配层只用于执行器路由与被动关节判定；本机 SDK 中 tendon 仅出现在官方 MJCF 导入器文档与 omni.usd.schema.mujoco 的 schema，未暴露运行时读回 API（要采样需 PhysX tendon API 暴露并在 Kit 运行时内验证）'+dropped_clause}
            frame['entities'].append(item)
        # Scene视觉展开节点是独立USD根；由最近真实物理祖先同帧位姿传播相对布局，避免动态根落地、视觉叶悬空。
        authored=poses(self.scene);scene_byid={entity['entityId']:entity for entity in self.scene['entities']}
        for item in frame['entities']:
            entry=self.entities[item['entityId']]
            if entry['articulation'] is not None or entry['rigidPaths']:continue
            parent=scene_byid[item['entityId']].get('parentId');visited=set()
            while parent and parent not in visited:
                visited.add(parent);ancestor=self.entities.get(parent)
                if ancestor and (ancestor['articulation'] is not None or ancestor['rigidPaths']):
                    with use_backend('tensor',raise_on_fallback=True):position,quaternion=ancestor['pose'].get_world_poses()
                    position=array(position).reshape(-1);quaternion=array(quaternion).reshape(-1)
                    actual=Gf.Matrix4d(1);actual.SetScale(Gf.Transform(authored[parent]).GetScale())
                    rotation=Gf.Matrix4d(1);rotation.SetRotate(Gf.Quatd(float(quaternion[0]),Gf.Vec3d(*quaternion[1:].tolist())))
                    actual=actual*rotation;actual.SetTranslateOnly(Gf.Vec3d(*position.tolist()))
                    current=Gf.Transform(authored[item['entityId']]*authored[parent].GetInverse()*actual)
                    q=current.GetRotation().GetQuat();item['transform']={'position':list(current.GetTranslation()),'quaternion':[*q.GetImaginary(),float(q.GetReal())],'scale':list(current.GetScale())}
                    break
                parent=scene_byid.get(parent,{}).get('parentId')
        if selection.get('contacts'):frame['contacts']=[dict(c,persistent=c['sourceStep']<self.index) for contacts in self.contacts.values() for c in contacts]
        frame['initialOverlap']={**copy.deepcopy(self.initial_overlap),'sceneRevision':self.revision}
        frame['worldStatus']=self.run_status();frame['worldPhysics']=self.world_physics()
        if isinstance(selection.get('collisionTopology'),dict):
            from collision_topology import collision_topology
            frame['collisionTopology']=collision_topology(self,selection['collisionTopology'],rendering)
        self._append_camera_observation(frame,selection)
        frame['executionMode']='assisted-teleport' if self.assisted else 'physical-contact';return frame
    def resolve_actuator(self,e,name):
        joint=e['actuatorJoints'].get(name,name)
        if joint not in e['indices']:raise SceneError('INVALID_CONTROL_MAPPING','执行器无对应关节: '+name)
        return joint
    def prepare(self,motion):
        m=copy.deepcopy(motion);e=self.entry(m['entityId']);kind=m['kind'];cfg=e['controller']
        # thrust 与无关节实体的动作在取 articulation **之前**分派：无关节实体没有 self.robot
        # 可取，误入那条路径只会给出 ENTITY_NOT_ARTICULATED 这种与真实原因无关的错误。
        if kind=='thrust':return self.prepare_thrust(m,e)
        if kind=='vehicle'and e['articulation'] is None:
            raise SceneError('UNSUPPORTED_CAPABILITY','无关节实体不可作为 vehicle 动作目标：没有 wheel/steering 执行器通道（entityId='+m['entityId']+'）')
        robot=self.robot(m['entityId'])
        with use_backend('tensor',raise_on_fallback=True):current=scalar_list(robot.get_dof_positions());limits=joint_limits(robot)
        m['_initialPosition']=self.observe({'entityIds':[m['entityId']]})['entities'][0]['transform']['position']
        if kind=='vehicle':
            if cfg.get('type')!='vehicle' or not cfg.get('wheels'):raise SceneError('MISSING_CONTROL_CONFIG','车辆需要SI wheels/steering配置')
            m['speedMps']=finite(m['speedMps'],'speedMps');m['_duration']=m['_end']=positive(m['durationS'],'durationS')
            for wheel in cfg['wheels']:positive(wheel['radiusM'],'radiusM');self.resolve_actuator(e,wheel.get('joint',wheel['actuator']))
            if cfg.get('steering'):
                if 'yawRateRadps'in m:raise SceneError('INVALID_ARGUMENT','有转向轴车辆使用steeringAngleRad')
                positive(cfg.get('wheelbaseM'),'wheelbaseM');angle=finite(m.get('steeringAngleRad',0),'steeringAngleRad');lo,hi=cfg['steering'].get('rangeRad',[-.55,.55])
                if not lo<=angle<=hi:raise SceneError('OUT_OF_RANGE','转角超出范围')
                for name in cfg['steering']['actuators']:self.resolve_actuator(e,name)
            else:
                if 'steeringAngleRad'in m:raise SceneError('INVALID_ARGUMENT','差速车辆使用yawRateRadps')
                positive(cfg.get('trackWidthM'),'trackWidthM');finite(m.get('yawRateRadps',0),'yawRateRadps')
            return m
        if kind=='gripper':
            gripper=cfg.get('gripper')
            if not gripper:raise SceneError('MISSING_CONTROL_CONFIG','缺夹爪关节映射')
            width=finite(m['widthM'],'widthM')
            if not 0<=width<=gripper['maxWidthM']:raise SceneError('OUT_OF_RANGE','夹爪宽度超范围')
            m['jointNames']=gripper['jointNames'];m['positions']=[width/len(m['jointNames'])]*len(m['jointNames']);m.setdefault('tolerance',.005)
        elif kind=='lift':
            lift=cfg.get('lift')
            if not lift:raise SceneError('MISSING_CONTROL_CONFIG','缺lift映射')
            if ('positionM'in m)==('velocityMps'in m):raise SceneError('INVALID_ARGUMENT','positionM与velocityMps选一个')
            m['jointNames']=[lift['joint']];m['positions']=[m['positionM'] if 'positionM'in m else current[e['indices'][lift['joint']]]+finite(m['velocityMps'],'velocityMps')*positive(m['durationS'],'durationS')];m.setdefault('tolerance',.015)
        elif kind=='control':
            if self.clock!='manual':raise SceneError('UNSUPPORTED_CAPABILITY','按物理步采样的 control 需要显式 manual world')
            names=m.get('jointNames',[]);positions=m.get('positions',[]);steps=m.get('stepCount')
            if not names or len(names)!=len(positions) or len(names)!=len(set(names)) or isinstance(steps,bool) or not isinstance(steps,int) or steps<=0:raise SceneError('INVALID_ARGUMENT','control关节和stepCount无效')
            for name,value in zip(names,positions):
                value=finite(value,name);joint=e['metadata'].get('joints',{}).get(name,{})
                if name not in e['indices']:raise SceneError('INVALID_JOINT_VECTOR','control 关节不存在: '+name)
                if not joint.get('actuator'):
                    # ISAAC-12：源元数据缺失时，受控性来自引擎 drive 读回（与 capabilities.control 同一份
                    # evidence）。此时没有源 ctrlrange 可核对，参考就是关节位置目标本身，由引擎的位置
                    # drive 折成力；不给"有源执行器"的假象，也不因为源元数据缺失就整条通道拒绝。
                    if name not in(e.get('engineDrive')or{}).get('perJoint',{}):raise SceneError('UNSUPPORTED_CAPABILITY','关节无执行器: '+name)
                    continue
                actuator=e['metadata']['actuators'][joint['actuator']]
                # position 执行器：参考是执行器控制量，受 ctrlrange 约束。
                # torque 执行器：参考是**关节位置目标**，由 PhysX 位置 drive（其 stiffness/damping
                # = controller.jointKp/jointKd，缺省标量 kp/kd，见 configure_robots）折成力矩；
                # ctrlrange 是力矩限不是位置限，故不按它钳制参考。官方力矩模型因此不必先派生
                # position 变体。velocity 执行器没有位置参考语义，保持明确拒绝。
                if actuator['mode']=='velocity':
                    raise SceneError('UNSUPPORTED_CAPABILITY','control 需要 position 或 torque 执行器；velocity 执行器请用 trajectory/joint 动作，力矩执行器的 PD 增益由 controller.jointKp/jointKd（或标量 kp/kd）给出: '+name)
                control_range=actuator.get('controlRange')
                if actuator['mode']=='position'and control_range and not control_range[0]<=value<=control_range[1]:raise SceneError('OUT_OF_RANGE','控制参考超出执行器 ctrlrange: '+name)
            m['_duration']=m['_end']=steps*self.dt
            return m
        elif kind=='gait':
            # ISAAC-14：几何步态动作通道（与 packages/sim-mujoco/python/gait.py 同一公式与常数）。
            # 前置全部来自源侧事实：腿结构/站立几何由 gait_structure 从源元数据复合得到；够不着就
            # 逐条报缺什么（不按机型名硬编码，也不"收下动作再报没动"）。
            forward=finite(m.get('forward'),'forward');turn=finite(m.get('turn',0),'turn')
            if not -1<=forward<=1:raise SceneError('OUT_OF_RANGE','gait forward 必须在 [-1,1]')
            if not -1<=turn<=1:raise SceneError('OUT_OF_RANGE','gait turn 必须在 [-1,1]')
            # 腿结构与站立几何读 capabilities() 留档的同一份（gait_structure 是它的内嵌函数）；
            # 实体不具备几何步态所需结构时，这里拿到的就是那份**逐条**说明缺什么的原因。
            rows=self.capabilities(e)
            row=next((item for item in rows if item['kind']=='gait'),None)
            legs=e.get('gaitLegs')
            if not row or not row.get('available') or not legs:
                raise SceneError('UNSUPPORTED_CAPABILITY',(row or {}).get('reason')or'该机型不具备几何步态所需结构')
            duration=positive(m.get('durationS'),'durationS')
            joint_names=[name for leg in legs for name in leg['names']]
            if any(name not in e['indices']for name in joint_names):raise SceneError('INVALID_JOINT_VECTOR','步态关节不在导入后的 DOF 里')
            # 目标由 **gait.targets()** 本体生成（与 MuJoCo 侧同一份实现、同一组常数），本处只做
            # 关节限位核对：几何算出的目标若越界就**明确拒绝**，不交给引擎静默夹取。
            cfg_freq=e['controller'].get('frequencyHz',GAIT_FREQUENCY_HZ)if isinstance(e['controller'],dict)else GAIT_FREQUENCY_HZ
            cfg_stride=e['controller'].get('strideM',GAIT_STRIDE_M)if isinstance(e['controller'],dict)else GAIT_STRIDE_M
            cfg_lift=e['controller'].get('liftM',GAIT_LIFT_M)if isinstance(e['controller'],dict)else GAIT_LIFT_M
            steps=max(1,int(round(duration/self.dt)));sampled=[]
            with use_backend('tensor',raise_on_fallback=True):limits=joint_limits(robot)
            for step in range(steps+1):
                targets=gait_probe_targets(legs,step*self.dt,forward,turn,cfg_freq,cfg_stride,cfg_lift)
                for name,value in targets.items():
                    lo,hi=limits[e['indices'][name]]
                    if value<lo-1e-6 or value>hi+1e-6:
                        raise SceneError('OUT_OF_RANGE','步态目标超出关节限位: '+name+' 目标 '+format(value,'.6g')+' 不在 ['+format(float(lo),'.6g')+', '+format(float(hi),'.6g')+']')
                sampled.append(targets)
            m.update({'_duration':duration,'_end':duration,'_steps':steps,'_jointNames':joint_names,
                      '_gaitLegs':legs,'_gaitSamples':sampled,'_gaitForward':forward,'_gaitTurn':turn})
            return m
        elif kind not in ('trajectory','joint'):
            # ISAAC-15：tendon 动作的拒绝必须指出**是哪条肌腱、哪个源执行器、源限制区间多少**，
            # 而不是一句"没有该资产的已适配策略: tendon"。调用方（工具面/计划器）据此就能判定
            # 该改用什么动作，不需要先猜再试。
            if kind=='tendon':
                requested=[str(name)for name in(m.get('tendonNames')or[])]
                # 逐条 tendon 结论读 capabilities() 留档的同一份（不在两处各算一遍，话术不漂移）。
                self.capabilities(e);rows=e.get('tendonRows')or[]
                known={row['name']:row for row in rows}
                unknown=[name for name in requested if name not in known]
                if unknown:raise SceneError('TENDON_NOT_FOUND','源模型没有这些 tendon: '+', '.join(unknown)+'；源声明='+(', '.join(known)if known else '（无）'))
                if not rows:raise SceneError('UNSUPPORTED_CAPABILITY','Isaac没有该资产的已适配策略: tendon（源模型没有 tendon 声明，tendon 动作没有坐标可寻址: '+m['entityId']+'）')
                detail=[]
                for row in rows:
                    limit='未声明' if row['controlRange'] is None else repr(list(row['controlRange']))
                    detail.append('tendon='+str(row['name'])+' actuator='+str(row['actuator'])+' joints='+repr(row['joints'])+' coef='+repr(row['coefficients'])+' unit='+str(row['unit'])+' controlRange='+limit+'；'+str(row['blockedBy']))
                # 前缀保持与其它未知 kind 同一条文案（调用方按文案分段匹配不会因本项加细而破坏），
                # 后面追加**逐条**源事实与卡点：哪条 tendon、哪个源执行器、源限制区间、卡在哪。
                raise SceneError('UNSUPPORTED_CAPABILITY','Isaac没有该资产的已适配策略: tendon（逐条原因：'+' | '.join(detail)+'）')
            raise SceneError('UNSUPPORTED_CAPABILITY','Isaac没有该资产的已适配策略: '+kind)
        names=m['jointNames']
        if not names or len(set(names))!=len(names) or any(name not in e['indices']for name in names):raise SceneError('INVALID_JOINT_VECTOR','关节名称非法或重复')
        # MJCF关节只有映射到真实actuator才是可驱动DOF：位置目标落在被动关节上会被静默
        # 忽略，因此不做“收下动作再报targetReached=false”，直接按关节拒绝（零执行器机构同此）。
        # 经tendon执行器驱动的关节（源声明，见scene_adapter的tendonActuators；如Panda手指）
        # 同样是可驱动DOF，它不是被动关节，只是不以关节级执行器表达。
        # ISAAC-12：源元数据缺失（joints 为空）时，被动/受控的划分改由**引擎 drive 读回**给出——
        # 有 drive 的 DOF 才可作位置目标，没有 drive 的仍被拒绝（不再"全部放开"，也不"整条通道拒绝"）。
        declared_joints=e['metadata'].get('joints')or{}
        engine_driven=(e.get('engineDrive')or{}).get('perJoint')or{}
        if declared_joints:
            # 源侧声明是权威：没有源执行器/tendon 的关节就是被动关节，拒绝（既有口径）。
            driven=lambda joint:bool(joint.get('actuator')or joint.get('tendonActuators'))
            passive=[name for name in names if not driven(declared_joints.get(name,{}))]
        elif engine_driven:
            # 源元数据缺失但引擎读到了受控 DOF：**只有读到的**才算可下发，其余按"引擎没有 drive"拒绝。
            passive=[name for name in names if name not in engine_driven]
        else:
            # 证据缺口：源没有元数据、引擎也没读到任何 drive。这时不能用"不在 engine_driven 里"当被动
            # 证据（那只是没读到），所以**不在这里拒**——isaacsim.core.experimental.prims 的
            # set_dof_position_targets 是 DOF 通道，能不能动由引擎在动作时给出结论；适配层不替引擎
            # 下"被动"的判断，也不谎报 capabilities。capabilities.joint 在同样的证据缺口下报
            # available:false（那是"通道可用性未知"，见那里的 reason），两者各自如实，不互相冒充。
            passive=[]
        if passive:
            basis='源声明无对应执行器'if declared_joints else '导入后 articulation 的 drive 读回里该 DOF 没有 drive（get_dof_drive_types 为 none 且 maxEffort 为 inf）'
            raise SceneError('UNSUPPORTED_CAPABILITY','被动关节不能作为位置动作目标（'+basis+'）: '+m['entityId']+' -> '+', '.join(passive))
        if kind=='trajectory'and set(names)!=set(e['controlled']):raise SceneError('INCOMPLETE_JOINT_VECTOR','轨迹必须包含完整受控关节')
        points=m['points']if kind=='trajectory'else[{'timeS':positive(m['durationS'],'durationS'),'positions':m['positions']}];previous=-1
        for point in points:
            t=finite(point['timeS'],'timeS')
            if t<0 or t<=previous or len(point['positions'])!=len(names):raise SceneError('INVALID_TRAJECTORY','时点和向量不完整')
            for name,value in zip(names,point['positions']):
                value=finite(value,name);lo,hi=limits[e['indices'][name]]
                if value<lo-1e-6 or value>hi+1e-6:raise SceneError('OUT_OF_RANGE',name)
            previous=t
        if not points or previous<=0:raise SceneError('INVALID_TRAJECTORY','必须有正时长')
        if points[0]['timeS']>0:points.insert(0,{'timeS':0,'positions':[current[e['indices'][name]]for name in names]})
        m['_points']=points;m['_duration']=previous;m['_end']=previous+max(0,finite(m.get('settleTimeS',.3),'settleTimeS'));m['_tolerance']=positive(m.get('tolerance',.03),'tolerance')
        if m.get('plan'):
            plan=m['plan']
            if plan['entityId']!=m['entityId']or plan['expectedGeneration']!=self.generation or plan['collisionContextVersion']!=str(self.generation):raise SceneError('STALE_PLAN','计划上下文已过期')
        return m
    def prepare_thrust(self,m,e):
        """资产声明的体坐标 wrench（SI：N / N·m）→ 整数物理步窗口的源执行器控制值。

        单位比例/方向/上下限全部来自源元数据（固定增益×site/gear）+ ctrlrange/forcerange，见
        scene_adapter.wrench_mapping；没有真实 rotor metadata 的资产在这里被明确拒绝。时长二选一：
        durationS（按物理步量化，max(1,round(durationS/dt))）或 stepCount（显式整数步，需要 manual 时钟）。
        """
        if ('durationS' in m)==('stepCount' in m):raise SceneError('INVALID_ARGUMENT','thrust 必须二选一：durationS 或 stepCount')
        mapping=self.thrust_mapping(e)
        # 回执里的位移必须相对动作开始时的真实引擎位姿（同其它动作类别），不能留空让回执缺项。
        m['_initialPosition']=self.observe({'entityIds':[m['entityId']]})['entities'][0]['transform']['position']
        torque=m.get('torqueNm',[0.,0.,0.])
        if not isinstance(torque,(list,tuple)) or len(torque)!=3:raise SceneError('INVALID_ARGUMENT','torqueNm 必须是长度3的数组')
        wrench=np.array([0.,0.,finite(m.get('thrustN'),'thrustN'),*[finite(v,'torqueNm') for v in torque]],dtype=float)
        matrix=np.asarray(mapping['matrix'],dtype=float);ctrl,*_=np.linalg.lstsq(matrix,wrench,rcond=None)
        # 只有能精确复现请求 wrench 的映射才可用；否则该资产表达不了这条命令，明确拒绝而不静默近似。
        if not np.allclose(matrix@ctrl,wrench,atol=1e-9*max(1.,float(np.max(np.abs(wrench)))),rtol=0):
            raise SceneError('UNSUPPORTED_CAPABILITY','该映射无法精确表达请求的体坐标 wrench: '+m['entityId'])
        controls=[]
        for name,value in zip(mapping['actuators'],ctrl):
            limit=mapping['limits'][name];value=float(value)
            # ctrlrange 是源控制权限（闭区间）：真正超权限必须明确拒绝，不能依赖引擎静默夹取，
            # 否则回执里的模型映射估算会与真实施力不符。线性解最后 1 ulp 的噪声按相对护栏接受并夹回闭区间。
            if limit['ctrlRange'] is not None:
                lo,hi=limit['ctrlRange'];guard=1e-12*max(1.,abs(lo),abs(hi),abs(value))
                if not lo-guard<=value<=hi+guard:raise SceneError('OUT_OF_RANGE','命令 wrench 超出源执行器 ctrlrange: '+name)
                value=float(min(max(value,lo),hi))
            force=limit['gain']*value
            # forcerange 是源执行器标量力权限（force=gain×ctrl），同样显式核对、闭区间 + 1 ulp 护栏。
            if limit['forceRange'] is not None:
                flo,fhi=limit['forceRange'];guard=1e-12*max(1.,abs(flo),abs(fhi),abs(force))
                if not flo-guard<=force<=fhi+guard:raise SceneError('OUT_OF_RANGE','命令 wrench 超出源执行器 forcerange: '+name)
                force=float(min(max(force,flo),fhi))
            controls.append((name,value,force))
        if 'stepCount' in m:
            if self.clock!='manual':raise SceneError('UNSUPPORTED_CAPABILITY','按物理步采样的 thrust 需要显式 manual world')
            steps=m['stepCount']
            if isinstance(steps,bool) or not isinstance(steps,int) or steps<=0:raise SceneError('INVALID_ARGUMENT','stepCount 必须是大于0的整数')
            m['_timingMode']='stepCount'
        else:
            steps=max(1,int(round(positive(m['durationS'],'durationS')/self.dt)));m['_timingMode']='durationS'
        m.update({'_steps':steps,'_wrench':wrench.tolist(),'_mapping':mapping,'_controls':controls,'_drivenSteps':0,
                  '_ctrlApplied':None,'_lastDrivenStep':None,'_worldWrenchLast':None})
        m['_duration']=m['_end']=steps*self.dt
        m['_engineReceipt']={'api':'RigidPrim.apply_forces_and_torques_at_pos','backend':'tensor',
                             'semantics':'forces=None位置参数省略→力施加在刚体变换原点；torques为纯力偶；is_global=True（世界系）',
                             'writeCount':0,'lastWriteStep':None,'zeroWriteCount':0,'lastZeroStep':None,'exceptions':[]}
        return m
    def thrust_writes(self,e):
        return e.setdefault('thrustWrites',{'writeCount':0,'lastWriteStep':None,'zeroWriteCount':0,'lastZeroStep':None,'exceptions':[]})
    def write_wrench(self,e,force,torque,motion=None,zero=False):
        """唯一的外力写入口：世界系力+纯力偶施加到实体根刚体（RigidPrim 张量API），并逐次计数。

        不吞异常：张量后端失败会抛异常（docstring 明说 “raises an exception if the forces and
        torques cannot be applied”），异常登记进回执的 exceptions 后继续抛出，绝不静默忽略。
        """
        entity=self.thrust_writes(e)
        try:
            with use_backend('tensor',raise_on_fallback=True):
                e['pose'].apply_forces_and_torques_at_pos(forces=[list(force)],torques=[list(torque)])
        except Exception as error:
            # 异常必须进回执（动作级）与实体级两份：动作级让消费者能按动作核对失败步骤，
            # 实体级让撤销/中性化期间的失败也不丢。两份共用同一个记录对象。
            record={'step':self.index+1,'error':type(error).__name__+': '+str(error)}
            for log in [entity['exceptions']]+([motion['_engineReceipt']['exceptions']]if motion is not None else[]):log.append(record)
            raise
        for counter in [entity]+([motion['_engineReceipt']]if motion is not None else[]):
            counter['zeroWriteCount' if zero else 'writeCount']+=1
            counter['lastZeroStep' if zero else 'lastWriteStep']=self.index+1
    def apply_thrust(self,m):
        """每个物理步把机体系 thrust/torque 转成世界系并施加；窗口外显式写零。

        世界系换算只用引擎当前真实位姿（根刚体 RigidPrim 的实时世界姿态），不缓存上一帧姿态：
        力在根刚体原点施加（positions 省略）而力矩是纯力偶，因此绕根刚体原点的合力矩严格等于
        源映射算出的 τ。窗口内每步都重写命令值（无零推力孔），窗口外写 0（短推力不被同 batch 的
        长动作拖长，也不留残余推力）；每一步是否真的写成功由 write_wrench 计数并可在回执核对。
        """
        e=self.entry(m['entityId']);driven=self.index+1<=m['_lastStep']
        if not driven:
            if m.get('_zeroWritten')!=self.index+1:self.write_wrench(e,[0.,0.,0.],[0.,0.,0.],m,zero=True);m['_zeroWritten']=self.index+1
            return
        with use_backend('tensor',raise_on_fallback=True):p,q=e['pose'].get_world_poses()
        quaternion=array(q).reshape(-1);rotation=quat_to_matrix([float(quaternion[0]),*quaternion[1:].tolist()])
        body=np.asarray(m['_wrench'],dtype=float)
        worldForce=rotation@body[:3];worldTorque=rotation@body[3:]
        self.write_wrench(e,worldForce.tolist(),worldTorque.tolist(),m)
        m['_drivenSteps']+=1;m['_lastDrivenStep']=self.index+1
        m['_ctrlApplied']={name:value for name,value,_ in m['_controls']}
        m['_worldWrenchLast']={'forceN':worldForce.tolist(),'torqueNm':worldTorque.tolist(),'step':self.index+1,
                               'bodyQuaternionWxyz':[float(quaternion[0]),*quaternion[1:].tolist()],'bodyPositionM':array(p).reshape(-1).tolist()}
    def thrust_effect(self,m,e):
        """thrust 回执：请求/计划控制/映射估算与真实可观测事实分开报告，缺失的观测明确 null。"""
        mapping=m['_mapping'];requested=m['_wrench']
        applied=np.asarray([value for _,value,_ in m['_controls']],dtype=float)
        mapped=np.asarray(mapping['matrix'],dtype=float)@applied
        # 完成/停止/关闭都必须撤销推力：与 stop/close 走同一个 neutral，不声称自动悬停。
        self.neutral(m['entityId']);m['_neutralized']=True
        entity_writes=e.get('thrustWrites',{})
        receipt=dict(m['_engineReceipt'])
        receipt.update({'zeroWriteCount':entity_writes.get('zeroWriteCount',receipt['zeroWriteCount']),
                        'lastZeroStep':entity_writes.get('lastZeroStep',receipt['lastZeroStep'])})
        # 撤销/中性化（本函数内的 neutral）期间发生的写失败也必须出现在回执里，不能只在实体级留痕。
        for record in entity_writes.get('exceptions',[]):
            if record not in receipt['exceptions']:receipt['exceptions'].append(record)
        return {'entityId':m['entityId'],'kind':'thrust',
                'requestedWrench':{'forceN':requested[:3],'torqueNm':requested[3:],
                                   'frame':'实体根刚体坐标系：推力沿+z，力矩绕x/y/z（参考点=刚体坐标系原点）'},
                'ctrlPlanned':{name:float(value) for name,value,_ in m['_controls']},
                'ctrlApplied':m.get('_ctrlApplied'),
                'mappedActuatorForce':{name:force for name,_,force in m['_controls']},
                'wrenchPerDrivenStep':{'forceN':mapped[:3].tolist(),'torqueNm':mapped[3:].tolist(),
                                       'kind':'model-mapping estimate',
                                       'basis':'源执行器固定增益×site/gear 映射换算自计划控制值；prepare 已校验精确表达请求，非传感器实测',
                                       'maxAbsDeltaFromRequest':float(np.max(np.abs(mapped-np.asarray(requested))))},
                # Isaac 对刚体外力没有任何“已施加外力”回读 API（omni.physics.tensors 只有 apply_forces*/
                # clear_forces/get_net_contact_forces），实测力必须如实为 null，绝不拿映射估算冒充实测。
                'measuredActuatorForce':None,
                'measuredActuatorForceNote':'null = 引擎无刚体外力回读 API（本机 Isaac 6.0.1：omni.physics.tensors 只有 apply_forces*/clear_forces/get_net_contact_forces，没有 get_forces 类接口）；映射估算见 wrenchPerDrivenStep，二者不混称',
                'measuredAtStep':None,
                'engineReceipt':receipt,
                'worldWrenchLast':m.get('_worldWrenchLast'),
                'timingMode':m['_timingMode'],'actuatorSteps':m['_steps'],'durationS':m['_duration'],
                'quantizationRule':'durationS→max(1, round(durationS/dt))步；stepCount→显式整数步；实际时长=步数×dt',
                'drivenSteps':m['_drivenSteps'],'lastDrivenStep':m.get('_lastDrivenStep'),
                'zeroForceAfterWindow':{'guaranteed':True,'ctrlZeroed':True,
                                        'basis':'支持范围内写零 wrench（无bias/activation/plugin/refsite，0∈ctrlrange/forcerange）；完成/停止/关闭均经 neutral 显式写零并计数'},
                'rootBody':mapping['siteBody'],'freeBase':self.free_base_state(m['entityId'])}
    def free_base_state(self,eid):
        """自由根的真实状态（世界位姿+速度来自引擎张量读数），观测缺失时返回 None 而不是编造。"""
        e=self.entry(eid)
        if e['articulation'] is not None or not e['rigidPaths']:return None
        with use_backend('tensor',raise_on_fallback=True):p,q=e['pose'].get_world_poses();linear,angular=e['pose'].get_velocities()
        position=array(p).reshape(-1);quaternion=array(q).reshape(-1);free_base=e['metadata'].get('freeBase',{})
        rotation=quat_to_matrix([float(quaternion[0]),*quaternion[1:].tolist()])
        return {'jointName':free_base.get('jointName') or '','bodyName':free_base.get('sourceRootBody') or '','massKg':free_base.get('massKg'),
                'positionM':position.tolist(),'quaternionXyzw':[*quaternion[1:].tolist(),float(quaternion[0])],
                'linearVelocityWorldMps':scalar_list(linear),'angularVelocityLocalRadps':(rotation.T@np.asarray(scalar_list(angular))).tolist()}
    def execute(self,action):
        self.ready();aid=action['actionId'];serialized=json.dumps(action,sort_keys=True)
        if aid in self.receipts:
            if self.requests[aid]!=serialized:raise SceneError('ACTION_ID_CONFLICT','相同actionId不得换参数')
            return copy.deepcopy(self.receipts[aid])
        if action['expectedGeneration']!=self.generation:raise SceneError('STALE_GENERATION','动作代次过期')
        motions=action['motions']if action['kind']=='batch'else[action];ids=[m['entityId']for m in motions]
        if not ids or len(set(ids))!=len(ids):raise SceneError('INVALID_ARGUMENT','batch实体为空或重复')
        occupied={m['entityId']for a in self.actions.values()for m in a['motions']}
        if occupied.intersection(ids):raise SceneError('ENTITY_BUSY','目标实体有活动或排队动作')
        prepared=[self.prepare(m)for m in motions];start=action.get('startStep',self.index+1)
        controls=[m for m in prepared if m['kind']=='control']
        if controls and (len(controls)!=len(prepared) or len({m['stepCount'] for m in controls})!=1):raise SceneError('INVALID_ARGUMENT','control batch 各成员须使用相同 stepCount，不混入定时轨迹')
        if isinstance(start,bool) or not isinstance(start,int)or start<=self.index:raise SceneError('INVALID_START_STEP','startStep必须在未来')
        if controls and start!=self.index+1:raise SceneError('INVALID_START_STEP','control 从下一物理步开始，不隐式推进空白步骤')
        if not self.actions:self.next_tick=time.monotonic()
        receipt={'actionId':aid,'worldId':self.id,'generation':self.generation,'status':'accepted'};self.receipts[aid]=receipt;self.requests[aid]=serialized;self.actions[aid]={'generation':action['expectedGeneration'],'motions':prepared,'start':start,'startTime':None}
        if controls:self.actions[aid]['endStep']=start+controls[0]['stepCount']-1
        # thrust 一律按整数步窗口驱动：每个 motion 自己记最后一步，短推力在 apply_thrust 里精确
        # 截止，不被同 batch 的长动作拖长；全 thrust 的 batch 按最长窗口终结。
        for motion in prepared:
            if motion['kind']=='thrust':motion['_lastStep']=start+motion['_steps']-1
        if prepared and all(m['kind']=='thrust' for m in prepared):self.actions[aid]['endStep']=start+max(m['_steps'] for m in prepared)-1
        for motion in prepared:self.control_owners[motion['entityId']]=aid
        return receipt
    def apply_motion(self,m,elapsed):
        e=self.entry(m['entityId']);robot=e['articulation'];cfg=e['controller']
        if m['kind']=='thrust':return self.apply_thrust(m)
        with use_backend('tensor',raise_on_fallback=True):
            if m['kind']=='control':
                robot.set_dof_position_targets(m['positions'],dof_indices=[e['indices'][n]for n in m['jointNames']])
            elif m['kind']=='gait':
                # 每个物理步按 elapsed 取**已经校验过**的采样点（prepare 里逐点查过关节限位），
                # 相邻点线性插值；步态是连续相位，不做事后"到位"判定（到位判据属于任务层）。
                samples=m['_gaitSamples'];names=m['_jointNames']
                slot=min(len(samples)-1,max(0,int(round(elapsed/self.dt))))
                target=samples[slot]
                robot.set_dof_position_targets([target[name]for name in names],dof_indices=[e['indices'][n]for n in names])
            elif m['kind']=='vehicle':
                # 车辆动作结束后轮速与差速角速度必须回到中性；否则
                # speed=0 但 yawRateRadps 仍会让左右轮持续反向驱动。
                active=elapsed<m['_duration'];speed=m['speedMps']if active else 0;yaw=m.get('yawRateRadps',0)if active else 0
                if cfg.get('steering'):
                    steering=cfg['steering'];angle=m.get('steeringAngleRad',0)if active else 0;target=angle*(-1 if steering.get('axle')=='rear'else 1)*steering.get('sign',1);indices=[e['indices'][self.resolve_actuator(e,n)]for n in steering['actuators']];robot.set_dof_position_targets([target]*len(indices),dof_indices=indices);yaw=speed*math.tan(angle)/cfg['wheelbaseM']if active else 0
                indices=[];targets=[]
                for wheel in cfg['wheels']:
                    index=e['indices'][self.resolve_actuator(e,wheel.get('joint',wheel['actuator']))];linear=speed+(-1 if wheel.get('side')=='left'else 1)*yaw*cfg.get('trackWidthM',0)/2;target=linear/wheel['radiusM']*wheel.get('driveSign',1)
                    a=e['metadata'].get('actuators',{}).get(wheel['actuator'],{});limit=a.get('controlRange')
                    if limit and not limit[0]<=target<=limit[1]:raise SceneError('OUT_OF_RANGE','速度超轮速执行器范围')
                    indices.append(index);targets.append(target)
                robot.set_dof_velocity_targets(targets,dof_indices=indices)
            else:
                target=m['_points'][-1]['positions']
                for left,right in zip(m['_points'],m['_points'][1:]):
                    if elapsed<=right['timeS']:
                        r=max(0,min(1,(elapsed-left['timeS'])/(right['timeS']-left['timeS'])));target=[a+(b-a)*r for a,b in zip(left['positions'],right['positions'])];break
                lift=cfg.get('lift',{});compensated=[v+lift.get('gravityCompensationM',0) if name==lift.get('joint') else v for name,v in zip(m['jointNames'],target)]
                robot.set_dof_position_targets(compensated,dof_indices=[e['indices'][n]for n in m['jointNames']])
    def neutral(self,eid):
        """把该实体控制通道写回中性；唯一出口，stop/finish/close/sync 都走这里，禁止旁路。

        无关节实体没有关节可中性化，但持有外力通道的实体必须在这里显式写零 wrench：否则
        动作完成后外力会留在 PhysX 上（力是写接口、没有“窗口结束自动清零”的语义保证）。
        """
        e=self.entry(eid);robot=e['articulation']
        if robot is None:
            if self.has_thrust_channel(e):self.write_wrench(e,[0.,0.,0.],[0.,0.,0.],zero=True)
            return
        with use_backend('tensor',raise_on_fallback=True):robot.set_dof_position_targets(scalar_list(robot.get_dof_positions()));robot.set_dof_velocity_targets([0.]*len(e['names']))
    def has_thrust_channel(self,e):
        try:self.thrust_mapping(e)
        except SceneError:return False
        return True
    def finish(self,aid,status,reason=None):
        action=self.actions.pop(aid);receipt=self.receipts[aid];receipt.update({'status':status,'endStep':self.index});effects=[]
        if reason:receipt['reason']=reason
        for m in action['motions']:
            e=self.entry(m['entityId']);frame=self.observe({'entityIds':[m['entityId']]});actual=frame['entities'][0];effect={'entityId':m['entityId'],'kind':m['kind'],'displacementM':(np.asarray(actual['transform']['position'])-np.asarray(m['_initialPosition'])).tolist()}
            if m['kind']=='thrust':
                # 推力回执必须让消费者能分清“请求/计划控制/映射估算/真实可观测”，并在完成时也撤销推力。
                effect.update(self.thrust_effect(m,e))
            elif m['kind']=='control':
                effect.update({'controlMode':'position-reference','stepCount':m['stepCount'],'stepsExecuted':max(0,self.index-receipt.get('startStep',self.index+1)+1),'jointNames':m['jointNames'],'referencePositions':m['positions']})
            elif m['kind']=='gait':
                # 步态不报"到位"：它是连续相位轨迹，参考每步都在变，末帧误差没有"到位"语义。
                # 回执给出**实测**的关节位置、几何来源与相位参数，任务层据此判行走结果。
                positions=actual.get('joints',{}).get('positions')or[]
                effect.update({'jointNames':m['_jointNames'],
                               'measuredJointPositions':[positions[e['indices'][n]]for n in m['_jointNames']],
                               'commandedForward':m['_gaitForward'],'commandedTurn':m['_gaitTurn'],
                               'geometrySource':'gait.calibrate（源 MJCF 经 MuJoCo mj_forward）',
                               'frequencyHz':1.8,'strideM':.12,'liftM':.05,
                               'stepsExecuted':max(0,self.index-receipt.get('startStep',self.index+1)+1),
                               'targetReached':None,
                               'targetReachedNote':'步态是连续相位轨迹，无"到位"判据；本字段恒为 null 以免被当成通过'})
            elif m['kind']=='vehicle':
                effect['commandedSpeedMps']=m['speedMps'];effect['wheelVelocitiesRadps']={self.resolve_actuator(e,w['actuator']):actual['joints']['velocities'][e['indices'][self.resolve_actuator(e,w['actuator'])]]for w in e['controller']['wheels']};self.apply_motion(m,m['_duration'])
            else:
                errors=[actual['joints']['positions'][e['indices'][n]]-v for n,v in zip(m['jointNames'],m['_points'][-1]['positions'])];effect.update({'jointErrors':errors,'targetReached':max(map(abs,errors))<=m['_tolerance'],'tolerance':m['_tolerance']})
                if m['kind']=='gripper':effect.update({'actualWidthM':sum(actual['joints']['positions'][e['indices'][n]]for n in m['jointNames']),'targetWidthM':m['widthM']})
            effects.append(effect)
            if status!='completed'and not m.get('_neutralized'):self.neutral(m['entityId'])
        # 完成回执必须覆盖本动作窗口内真实发生过的辅助：只按结束瞬间的map快照会把已解除的辅助从回执上抹掉。
        receipt['finalState']=self.observe({'entityIds':[m['entityId']for m in action['motions']],'contacts':True});receipt['effect']={'motions':effects,'childrenStartSteps':{m['entityId']:receipt.get('startStep')for m in action['motions']},'executionMode':'assisted-teleport'if(self.assisted or action.get('assistedTicks'))else'physical-contact'}
        if status!='completed':receipt['taskAchieved']=False
        emit({'event':'receipt','receipt':receipt})
    def stop(self,selection):
        if selection.get('expectedGeneration')is not None and selection['expectedGeneration']!=self.generation:raise SceneError('STALE_GENERATION','停止请求属于旧模型代次，不触碰新代次控制')
        action_id=selection.get('actionId')
        if action_id and action_id not in self.receipts:raise SceneError('ACTION_NOT_FOUND','停止请求的动作不存在')
        affected={eid for eid in selection.get('entityIds',self.entities)if not action_id or self.control_owners.get(eid)==action_id}
        result=[]
        for aid,action in list(self.actions.items()):
            if selection.get('actionId')and aid!=selection['actionId']:continue
            if selection.get('entityIds')and not any(m['entityId']in selection['entityIds']for m in action['motions']):continue
            affected.update(m['entityId']for m in action['motions'])
            self.finish(aid,'cancelled','STOP_CONFIRMED');result.append(self.receipts[aid])
        for eid in affected:self.neutral(eid);self.control_owners.pop(eid,None)
        if self.status in ('ready','running'):self.status='running' if self.actions else 'ready'
        return {'stopped':True,'stepIndex':self.index,'receipts':result,'affectedEntityIds':sorted(affected)}
    def tick(self):
        if self.paused:return
        if self.status not in ('ready','running'):return
        if self.clock=='manual' and not self.actions:return
        for aid,action in list(self.actions.items()):
            if action['generation']!=self.generation:self.finish(aid,'failed','STALE_GENERATION');continue
            if self.index+1<action['start']:continue
            if action['startTime']is None:action['startTime']=self.sim_time;self.receipts[aid].update({'status':'running','startStep':self.index+1})
            # 本动作窗口内真实经历辅助tick的事实：只累计已开始且本tick正在被驱动的动作，scheduled未来动作不提前标脏；
            # 解除attach不清除已发生的事实，动作结束随动作生命周期消失。
            if self.assisted:action['assistedTicks']=action.get('assistedTicks',0)+1
            try:
                for motion in action['motions']:self.apply_motion(motion,self.sim_time-action['startTime']+self.dt)
            except Exception as error:self.finish(aid,'failed',str(error))
        if self.clock=='manual' and not self.actions:return
        for attachment in self.assisted.values():
            # Gf绑定只收Python double：get_world_poses返回np.float32，实部与虚部都须显式转标量（同本文件既有的float()/tolist()写法）。
            p,q=attachment['anchor'].get_world_poses();p=array(p).reshape(-1);q=array(q).reshape(-1);rotation=Gf.Matrix3d(Gf.Quatd(float(q[0]),Gf.Vec3d(*q[1:].tolist())));target=p+np.asarray(rotation).T@np.asarray(attachment['offset'])
            relative=attachment['relativeOrientation'];orientation=(Gf.Quatd(float(q[0]),Gf.Vec3d(*q[1:].tolist()))*Gf.Quatd(relative[0],Gf.Vec3d(*relative[1:]))).GetNormalized()
            with use_backend('tensor',raise_on_fallback=True):attachment['object'].set_world_poses(positions=[target.tolist()],orientations=[[float(orientation.GetReal()),*map(float,orientation.GetImaginary())]]);attachment['object'].set_velocities(linear_velocities=[[0.]*3],angular_velocities=[[0.]*3])
            # 真实辅助推进计数只随一次真实写回递增；attach/release 调用本身不在计数点内。
            self.assist_advances+=1
        # 唯一推进点；Timeline自动更新被关闭，Viewer/渲染不会推进physics。
        SM.step(steps=1,update_fabric=False);self.index+=1;self.sim_time+=self.dt
        for aid,action in list(self.actions.items()):
            complete=self.index>=action['endStep'] if 'endStep'in action else action['startTime']is not None and self.sim_time-action['startTime']+1e-12>=max(m['_end']for m in action['motions'])
            if complete:self.finish(aid,'completed')
        self.status='running'if self.actions else'ready'
        if time.monotonic()-self.last_frame>=1/self.frame_hz:emit({'event':'frame','frame':self.observe()});self.last_frame=time.monotonic()
    def assist(self,options):
        self.ready()
        if options['expectedGeneration']!=self.generation:raise SceneError('STALE_GENERATION','辅助请求代次过期')
        eid=options['objectId']
        if options['mode']=='release':self.assisted.pop(eid,None)
        elif options['mode']=='attach':
            obj=self.entry(eid);robot=self.entry(options['robotId'])
            if not obj['rigidPaths']or obj['articulation']:raise SceneError('UNSUPPORTED_CAPABILITY','辅助attach需要自由刚体')
            paths=[p for p in robot['rigidPaths']if p.rsplit('/',1)[-1]==options['anchorBody']]
            if len(paths)!=1:raise SceneError('INVALID_ANCHOR','anchorBody没有唯一刚体路径')
            anchor=XformPrim(paths[0]);p,q=anchor.get_world_poses();p=array(p).reshape(-1);q=array(q).reshape(-1)
            with use_backend('tensor',raise_on_fallback=True):op,oq=obj['pose'].get_world_poses()
            # 同上：锚点四元数来自USD（float32），Gf.Quatd实部与Gf.Vec3d分量都须Python double。
            rotation=Gf.Matrix3d(Gf.Quatd(float(q[0]),Gf.Vec3d(*q[1:].tolist())));offset=np.asarray(rotation)@(array(op).reshape(-1)-p)
            # 保留附着瞬间的相对姿态；只跟随位置会使倾转的手与器具错位。
            oq=array(oq).reshape(-1);relative=(Gf.Quatd(float(q[0]),Gf.Vec3d(*q[1:].tolist())).GetInverse()*Gf.Quatd(float(oq[0]),Gf.Vec3d(*oq[1:].tolist()))).GetNormalized()
            self.assisted[eid]={'anchor':anchor,'object':obj['pose'],'offset':list(offset),'relativeOrientation':[float(relative.GetReal()),*map(float,relative.GetImaginary())]}
        else:raise SceneError('INVALID_ARGUMENT','mode须显式attach/release')
        return {'executionMode':'assisted-teleport','attached':eid in self.assisted,'worldId':self.id,'generation':self.generation,'stepIndex':self.index,'countsAsPhysicalGrasp':False}
    def resolve_camera_name(self,name):
        if name.startswith('/'):return name
        matches=[camera for eid,e in self.entities.items() for local,camera in e.get('cameras',{}).items() if name in (local,eid+'/'+local)]
        if not matches:raise SceneError('CAMERA_NOT_FOUND','原生相机不存在: '+name)
        if len(matches)!=1:raise SceneError('AMBIGUOUS_CAMERA','原生相机名匹配多个实体: '+name)
        camera=matches[0]
        if camera['status']!='AVAILABLE':raise SceneError('UNSUPPORTED_CAPABILITY',camera['message'])
        return camera['path']
    def camera_list(self,options=None):
        """真实命名相机清单：来源是导入层核验过的原生相机（scene_adapter.native_cameras 写进实体的 cameras），
        逐条给出实体、原名、原生路径、挂载 body、源声明视场与可用状态；没有相机时如实为空列表，不返回空壳。

        **可用相机**另外给出跨引擎消费合同（与 sim-mujoco worker.camera_list 同一套字段口径）：
        `cameraName`（`entityId/局部名`，与 resolve_camera_name/capture 同一命名空间）、`parentBodyName`、
        `referenceResolution`/`intrinsics`/`fovyDeg`/`intrinsicsSource`、`worldFromCamera`，以及 override 各字段。
        K/位姿不是回声入参：先把该相机的临时 override 重算到 live prim（`_apply_camera_override`，与 capture()
        渲染前同一重算点，所以拿到的是**覆盖后**的位姿/K），再用 capture()/camera_adjust() 共用的
        `_camera_readback` 从 live prim 读回——不新建第二套相机状态。位姿来源如实标 `poseSource=
        'fabric-parent-usd-local'`：RTX 下由 Fabric 的实时父节点与 USD 的局部安装位姿组合；无 RTX 时保留 USD 读回口径。
        不可用相机只保留 `available=false` + `reason`（导入层的拒绝原因），**不给位姿/K**：绝不伪造视锥。
        options.width/height 只影响 intrinsics 的参考分辨率（默认 640×480，与 capture 默认一致）；
        K 由**生效**竖直视场（override 优先，其次源声明）与**本次请求的分辨率**算出（fx=fy），不读 prim 里
        可能停在源件/上一次请求宽高比上的水平孔径——跨分辨率重复请求因此不依赖上一次的状态。
        """
        width,height=self._camera_resolution(options or {})
        cameras=[]
        for eid,e in sorted(self.entities.items()):
            for local,camera in sorted(e.get('cameras',{}).items()):
                width,height=self._camera_resolution(options or {},camera.get('path'))
                name=eid+'/'+local
                item={'entityId':eid,'name':local,'localName':local,'qualifiedName':name,'cameraName':name,
                      'cameraSource':'mjcf',**camera,'referenceResolution':[width,height],**self._camera_frame_identity()}
                # 只有真的导入了 prim 的相机才有挂载 body 可说；不可用条目没有 prim，不编一个 'world' 出来。
                if camera.get('path'):item['parentBodyName']=self._camera_parent_body_name(camera['path'])
                prim=self.stage.GetPrimAtPath(camera.get('path') or '')
                if prim and prim.IsValid():
                    fovy=prim.GetAttribute('lyapunov:sourceFovyDeg')
                    if fovy and fovy.HasValue():item['sourceFovyDeg']=float(fovy.Get())
                item['available']=camera.get('status')=='AVAILABLE'
                if not item['available']:
                    item.setdefault('reason',camera.get('message') or 'UNSUPPORTED_CAPABILITY')
                    cameras.append(item);continue
                resolved=camera['path'];usd_camera=self._camera_prim(resolved)
                override=self.camera_overrides.get(resolved)
                if override is not None:self._apply_camera_override(usd_camera,override)
                readback=self._camera_readback(name,resolved,usd_camera,width,height,override)
                source_aperture=override['source']['verticalAperture'] if override is not None else None
                # 参考系：有 override 就是 override 的解释口径；没有 override 时按**实际挂载**如实报
                # （挂 body 下＝parent，直接挂 worldbody＝world，与 sim-mujoco 同一套取值），不报 None。
                item.update({'referenceFrame':override['referenceFrame'] if override is not None else ('parent' if item.get('parentBodyName','world')!='world' else 'world'),
                             'parentEntityId':readback['parentEntityId'],
                             'intrinsicsSource':readback['intrinsicsSource'],'intrinsics':readback['intrinsics'],
                             'fovyDeg':readback['fovyDeg'],'focalLength':readback['focalLength'],'verticalAperture':readback['verticalAperture'],
                             'sourceFovyDeg':self._camera_source_fovy(usd_camera,{'verticalAperture':source_aperture}),
                             'worldFromCamera':readback['worldFromCamera'],'poseSource':'fabric-parent-usd-local' if rendering else 'usd-xformcache-readback',
                             'parentFromCamera':readback['parentFromCamera'],'worldFromParent':readback['worldFromParent'],
                             'override':override is not None,
                             'positionOverridden':bool(override and override.get('positionOverridden')),
                             'quaternionOverridden':bool(override and override.get('quaternionOverridden')),
                             'fovyOverridden':bool(override and override.get('fovyOverridden')),
                             'stepIndex':self.index,'simTime':self.sim_time})
                if override is not None:
                    # 未施加 override 的源相机位姿：源局部变换按**当前**父变换换算（同 MuJoCo 的 sourceWorldFromCamera）。
                    source_world=Gf.Matrix4d(override['source']['local']*self._camera_parent_world_matrix(usd_camera))
                    item['sourceWorldFromCamera']={'positionM':self._vec3(source_world.ExtractTranslation()),'rotationMatrix':self._camera_world_rotation(source_world)}
                    item['worldGeneration']=override['generation']
                    item['overridePositionM']=list(override['positionM']);item['overrideQuaternionXyzw']=list(override['quaternionXyzw']);item['overrideFovyDeg']=override['fovyDeg']
                cameras.append(item)
        bodies=[]
        for body in camera_mount_bodies(self.stage,self.entities):
            matrix=self._native_world_matrix(self.stage.GetPrimAtPath(body['bodyPath']))
            bodies.append({**body,**self._camera_frame_identity(),'worldFromBody':self._camera_pose_receipt(matrix),
                           'poseSource':'fabric-hierarchy' if rendering else 'usd-xformcache-readback'})
        return {**self._camera_frame_identity(),'rendering':'rtx' if rendering else 'none',
                'count':len(cameras),'cameraCount':len(cameras),'cameras':cameras,'bodies':bodies}
    def ensure_capture_headlight(self,path):
        """采集默认照明：场景自身没有任何 UsdLux 光源时，给相机挂一盏随视线方向的平行光。

        源资产（本仓 fixture 的 arm-2joint.mjcf）没有 <light>，而 MuJoCo 对同一份 MJCF 默认启用
        相机 headlight（mjModel.vis.headlight.active=1，ambient .1/diffuse .4/specular .5）：
        同一个无光源场景在 MuJoCo 侧有可见图像，RTX 侧则 LDR 通道全 0（实测 rgb 全零、同一帧
        depth 是真实几何）——两引擎的采集口径因此不可比，且调用方无法通过 snapshot 声明光源。
        所以这里只补"确实没有光源"的场景：场景里已有任何 UsdLux 光源（LightAPI）就不动它，
        绝不覆盖调用方照明。灯是相机 prim 的子节点，随相机位姿移动，语义同 MuJoCo headlight
        （相机看向 -Z，USD 平行光沿自身局部 -Z 出射，故 identity 局部变换即视线方向）。
        """
        headlight=path+'/lyapunov_capture_headlight'
        existing=self.stage.GetPrimAtPath(headlight)
        if existing and existing.IsValid():return
        if any(prim.HasAPI(UsdLux.LightAPI) for prim in self.stage.Traverse()):return
        UsdLux.DistantLight.Define(self.stage,headlight).CreateIntensityAttr(2000.)
    def publish_capture(self,capture_id,from_dir,to_dir):
        """宿主发布完成后，只更新本次采集登记的文件位置，不重新采集或改动标定。"""
        if capture_id not in self.captures:raise SceneError('CAPTURE_NOT_FOUND','采集登记不存在: '+capture_id)
        source=Path(from_dir).resolve();target=Path(to_dir).resolve();updates=[]
        for entry in self.captures[capture_id]['cameras']:
            for kind in ('rgb','depth'):
                metadata=entry.get(kind)
                if not metadata:continue
                path=target/Path(path_from_uri(metadata['uri'])).relative_to(source)
                if not path.is_file():raise SceneError('CAPTURE_FILE_MISSING','已发布的采集文件不存在: '+str(path))
                updates.append((metadata,path.as_uri()))
        for metadata,uri in updates:metadata['uri']=uri
        return {'captureId':capture_id,'files':len(updates)}
    def _remember_capture(self,capture_id,result,cameras,ephemeral=False):
        """captureId → 真实回执与逐相机条目；标注/数据集导出**只**引用这里记录过的真实采集。

        与 sim-mujoco 的 `_remember_capture` 同一形状（同样只保留最近 128 条，避免无界增长）；
        `ephemeral=True` 的条目（标注自带的新鲜渲染）深度没有按本次渲染重新落盘，
        故可作标注溯源、但数据集导出明确拒绝——同 MuJoCo 的 CAPTURE_NOT_REUSABLE 语义。
        """
        self.captures[capture_id]={'captureId':capture_id,'worldId':self.id,'generation':result['generation'],
            'sceneRevision':result['sceneRevision'],'appliedSceneRevision':result['sceneRevision'],'stepIndex':result['stepIndex'],'simTime':result['simTime'],
            'frameId':result['frameId'],'width':result['width'],'height':result['height'],
            'multi':len(cameras)>1,'ephemeral':bool(ephemeral),'cameras':cameras,'annotations':[]}
        for stale in list(self.captures)[:-128]:
            del self.captures[stale]
    def _rtx_camera_entry(self,resolved,rgb,depth,width,height,root,override,calibration):
        """一次真实渲染 → 采集条目（真实落盘的 RGB PNG + 米制深度 NPY + 标定/位姿来源）。"""
        from PIL import Image
        stem=str(uuid.uuid4());rgbpath=root/(stem+'.png');depthpath=root/(stem+'-depth.npy')
        Image.fromarray(rgb.astype(np.uint8)).save(rgbpath);np.save(depthpath,depth)
        # 无返回值保留在原始 NPY；JSON 范围只报告有限正值，天空全无返回时为 null。
        finite_depth=depth[np.isfinite(depth)&(depth>0)]
        depth_range=[float(np.min(finite_depth)),float(np.max(finite_depth))] if finite_depth.size else None
        return {'cameraName':resolved['cameraName'],'resolvedCameraName':resolved['path'],'override':bool(override),
                'width':width,'height':height,'calibration':calibration,
                **self._camera_frame_identity(),'source':'isaac-rtx-camera',
                'depthRangeM':depth_range,
                'rgb':{'uri':rgbpath.as_uri(),'mimeType':'image/png'},
                'depth':{'uri':depthpath.as_uri(),'mimeType':'application/x-npy','units':'m'},'annotationIds':[]}
    def _rtx_frame(self,path,width,height):
        """命名/自由相机的一次真实 RTX 渲染：返回 RGB、米制深度、标定，不在这里落盘。

        **唯一**的 RTX 渲染点：`capture`/`capture_multi` 与 `project_annotation` 的"本步真实渲染"
        共用它，所以标注用的深度与采集落盘的深度是同一份 framebuffer、同一套内参口径；渲染前后断言
        物理步数不变（渲染不许推进物理钟）也不在这里复制第二份。
        """
        cam=UsdGeom.Camera(self.stage.GetPrimAtPath(path))
        override=self.camera_overrides.get(path)
        # 临时 override 在**每次渲染前**重算：world 帧固定的是世界位姿，父 body 运动后按当前父变换
        # 反算局部变换，不随父运动漂移（同 MuJoCo 每次渲染都用 override 重算 cam_xpos 的语义）。
        if override is not None:self._apply_camera_override(cam,override)
        # 6.0.1 的 RtxCamera 对既有 prim 只校验 schema；必须先显式应用。
        prim=cam.GetPrim()
        if not prim.HasAPI('OmniSensorAPI'):prim.ApplyAPI('OmniSensorAPI')
        camera=RtxCamera(path,reset_xform_op_properties=False)
        # 6.0.1默认optics包装会重置xformOp并丢失matrix挂载偏移；保留原USD局部变换。
        camera._camera=UsdCamera(path,reset_xform_op_properties=False)
        self.ensure_capture_headlight(path)
        if cam.GetProjectionAttr().Get()!=UsdGeom.Tokens.perspective or any('LensDistortion' in name for name in cam.GetPrim().GetAppliedSchemas()):raise SceneError('UNSUPPORTED_CAMERA_MODEL','当前标定采集需要无畸变的透视相机')
        # 渲染前按**生效** fovy（临时 override 优先，其次源声明）与**本次请求分辨率**重算两个孔径：
        # 只在"有源声明且未被 override"时才写水平孔径，会让 fovy 被 override 的非 4:3 采集跳过这一支，
        # 水平孔径停在上一次请求的宽高比上（垂直已改）⇒ 渲染出的水平视场与回执 K 不是同一个口径。
        self._apply_camera_aperture(cam,self._camera_effective_fovy(cam,override),width,height)
        sensor=CameraSensor(camera,resolution=(height,width),annotators=['rgb','distance_to_image_plane'])
        before_steps=SM.get_num_physics_steps();rgb=depth=None
        try:
            fabric=getattr(SM,'_physx_fabric_interface',None)
            if fabric is None:raise SceneError('SENSOR_UNAVAILABLE','RTX Fabric接口未初始化')
            fabric.update(SM.get_simulation_time(), self.dt)
            # 冷驱动/首次shader编译期间app.update可快速返回空帧；固定120次会过早失败。
            # 首帧另有一次性 PSO/shader 编译：实测单次 app.update 会被阻塞 436s、521s
            # （139 冷编译 470-530s），轮询打断不了它——按 120s 判会把“编译刚结束”误判成超时。
            # 预算取自**本 world 是否已经真的出过一帧 rgb+depth**（self.frame_rendered，最薄的
            # “编译已完成”事实：同进程第二次采集实测 537-687ms，新进程首帧 624-782ms）：没出过帧
            # 才是 900s 首帧预算；出过帧的后续采集**从循环第一行起就是 120s**热预算，不会先给 900s
            # 再收紧（无帧时到点仍按 SENSOR_UNAVAILABLE 失败，热路径的失败判定不放宽）。
            # 边界如实说：这是**循环边界上的软截止**——app.update() 一旦阻塞，外面这层 while 只能在
            # 它返回后才检查 deadline，外围循环无法强制截止；最坏实际耗时=预算+单次 app.update 阻塞。
            # 物理时钟仍只由 SM.step 推进。
            render_tick=0;rgb=depth=None;budget=120 if self.frame_rendered else 900
            carb.log_info('LYAPUNOV_ISAAC_CAPTURE_BUDGET '+json.dumps({'worldId':self.id,'frameRenderedAtStart':bool(self.frame_rendered),'budgetS':budget}))
            capture_deadline=time.monotonic()+budget
            while time.monotonic()<capture_deadline:
                app.update();rgb,_=sensor.get_data('rgb');depth,_=sensor.get_data('distance_to_image_plane')
                if rgb is not None and depth is not None:self.frame_rendered=True
                if render_tick>=3 and rgb is not None and depth is not None:break
                render_tick+=1;time.sleep(0.02)
            if rgb is None or depth is None:raise SceneError('SENSOR_UNAVAILABLE','RTX未返回真实RGB/深度')
            rgb=array(rgb);depth=array(depth)[:,:,0]
            if rgb.shape!=(height,width,3) or depth.shape!=(height,width):raise SceneError('SENSOR_UNAVAILABLE','RTX返回的RGB/深度分辨率不匹配')
            if SM.get_num_physics_steps()!=before_steps:raise SceneError('CLOCK_CONFLICT','渲染推进了额外物理步')
            with use_backend('fabric',raise_on_fallback=True):position,orientation=camera.get_world_poses()
            position=array(position).reshape(-1);orientation=array(orientation).reshape(-1)
            rotation=np.asarray(Gf.Matrix3d(Gf.Quatd(float(orientation[0]),Gf.Vec3d(*orientation[1:].tolist())))).T.tolist()
            focal=float(cam.GetFocalLengthAttr().Get());horizontal=float(cam.GetHorizontalApertureAttr().Get());vertical=float(cam.GetVerticalApertureAttr().Get())
            calibration={**self._camera_readback(path,path,cam,width,height,override),'model':'pinhole',
                         'coordinateSystem':'right-handed-z-up; USD camera looks along -Z, +Y up',
                         'intrinsics':intrinsics_from_fovy(math.degrees(2*math.atan(vertical/(2*focal))),width,height,focal,
                            float(cam.GetHorizontalApertureOffsetAttr().Get() or 0.),float(cam.GetVerticalApertureOffsetAttr().Get() or 0.)),
                         'worldFromCamera':{'positionM':position.tolist(),'rotationMatrix':rotation},'poseSource':'fabric-camera-readback',
                         'source':'isaac-rtx-camera'}
            return rgb,depth,calibration
        finally:
            sensor.detach_annotators(['rgb','distance_to_image_plane']);del sensor;gc.collect()
    def _capture_root(self,options):
        """采集落盘根（不存在即建）：capture／capture_multi／数据集导出三处同一解析，不各写一份。"""
        root=Path(options['outputDir']).resolve();root.mkdir(parents=True,exist_ok=True);return root
    def capture(self,options,capture_id=None):
        if not rendering:raise SceneError('SENSOR_UNAVAILABLE','当前Profile未启动RTX；传感器采集需要rendering:rtx')
        self.ready()
        root=self._capture_root(options);requested=options.get('cameraName');path=self.resolve_camera_name(requested) if requested else None
        width,height=self._camera_resolution(options,path)
        if path:
            prim=self.stage.GetPrimAtPath(path)
            if not prim.IsValid() or not prim.IsA(UsdGeom.Camera):raise SceneError('CAMERA_NOT_FOUND','命名相机不存在或不是USD Camera: '+path)
        else:
            path='/World/lyapunov_capture_camera'
            cam=UsdGeom.Camera(self.stage.GetPrimAtPath(path));matrix=Gf.Matrix4d(1);matrix.SetLookAt(Gf.Vec3d(2,-2,1.6),Gf.Vec3d(.4,0,.2),Gf.Vec3d(0,0,1));cam.ClearXformOpOrder();cam.AddTransformOp().Set(matrix.GetInverse());cam.CreateClippingRangeAttr(Gf.Vec2f(.01,100));cam.CreateFocalLengthAttr(24)
        rgb,depth,calibration=self._rtx_frame(path,width,height)
        camera_id=capture_id or str(uuid.uuid4())
        result={**self._camera_frame_identity(),'source':'isaac-rtx-camera','captureId':camera_id,'multi':False,'cameraName':requested or path,'resolvedCameraName':path,'width':width,'height':height,'calibration':calibration,'observation':self.observe({'sensors':True,'contacts':True})}
        entry=self._rtx_camera_entry({'cameraName':requested or path,'path':path},rgb,depth,width,height,root,self.camera_overrides.get(path),calibration)
        result.update({'rgb':entry['rgb'],'depth':entry['depth'],'depthRangeM':entry['depthRangeM'],'override':entry['override']})
        # 单相机采集也登记：标注/导出按 captureId 只引用真实发生过的采集（multi 时由 capture_multi
        # 用同一个 captureId 汇总登记，见下）。
        self._remember_capture(camera_id,result,[entry])
        return result
    def capture_multi(self,options):
        """同一物理步的多相机采集：逐台复用单相机 capture 通路（rgb+米制深度+标定，通路自己断言
        渲染不推进物理步），返回共享的 stepIndex/simTime/frameId/sceneRevision。任一相机名不存在、
        不可用或重复即整体拒绝：不做部分采集，也不返回空壳。

        回执带**一个** captureId：逐台采集在 worker 内用同一个 id 登记，最后汇总成一条
        （cameras = 各相机条目），与 sim-mujoco `capture_multi` 同形状，供标注/数据集导出按 id 引用。
        """
        names=list(options.get('cameraNames') or [])
        if not names or len(set(names))!=len(names):raise SceneError('INVALID_ARGUMENT','cameraNames 必须非空且不重复')
        resolved=[(name,self.resolve_camera_name(name)) for name in names]
        width,height=self._camera_resolution(options,resolved[0][1])
        capture_id=str(uuid.uuid4());captures=[];entries=[]
        identity=self._camera_frame_identity()
        try:
            for name,path in resolved:
                single=self.capture({**options,'cameraName':name,'width':width,'height':height},capture_id=capture_id)
                if any(single.get(key)!=identity[key] for key in ('generation','sceneRevision','stepIndex','frameId','simTime')):
                    raise SceneError('CLOCK_CONFLICT','多相机采集不属于同一原生物理步')
                captures.append({**single,'cameraName':name,'resolvedCameraName':path})
                entries.append(self.captures[capture_id]['cameras'][0])
        except Exception:
            self.captures.pop(capture_id,None)
            raise
        first=captures[0]
        # 逐台登记时每条只带自己那一台，这里汇总成一条多相机记录（保留 128 条的上限逻辑在 _remember_capture）。
        self._remember_capture(capture_id,first,entries)
        return {**identity,
                'captureId':capture_id,'rendering':'rtx' if rendering else 'none','count':len(captures),'captures':captures}
    # ── ISAAC-04 命名相机临时 override（camera_adjust）：只写本 world 的 live USD 相机 prim ──────────
    def _camera_frame_identity(self):
        return {'worldId':self.id,'generation':self.generation,'worldGeneration':self.generation,'sceneRevision':self.revision,
                'appliedSceneRevision':self.revision,'stepIndex':self.index,'simTime':self.sim_time,'frameId':f'{self.id}:{self.generation}:{self.index}'}
    def _append_camera_observation(self,frame,selection):
        if selection.get('sensors') is False:return
        from robot_authoring import authoring_observation
        authoring_observation(self,frame)
        if not any(camera.get('mount') for e in self.entities.values() for camera in e.get('cameras',{}).values()):return
        readback=self.camera_list()
        if any(readback[key]!=frame[key] for key in ('worldId','generation','sceneRevision','stepIndex','frameId','simTime')):
            raise SceneError('CLOCK_CONFLICT','相机标定与机器人观察不属于同一原生帧')
        frame['cameras']=readback['cameras']
        for entity in frame['entities']:
            bodies=[body for body in readback['bodies'] if body['entityId']==entity['entityId']]
            if not bodies:continue
            # 同名实际 body 不覆盖；装配本身拒绝这种歧义，观察也明确失败。
            if len({body['bodyName'] for body in bodies})!=len(bodies):raise SceneError('CAMERA_BODY_AMBIGUOUS','同帧 body 读回重名: '+entity['entityId'])
            entity.setdefault('sensors',{})['bodyWorldPoses']={body['bodyName']:{'bodyName':body['bodyName'],**body['worldFromBody'],**self._camera_frame_identity()} for body in bodies}
    def _camera_resolution(self,options,path=None):
        eid,local,camera=self._camera_entity(path) if path else (None,None,None)
        default=(camera or {}).get('referenceResolution',[640,480])
        width,height=options.get('width',default[0]),options.get('height',default[1])
        if any(isinstance(v,bool) or not isinstance(v,int) or not 16<=v<=4096 for v in (width,height)):raise SceneError('INVALID_ARGUMENT','相机分辨率须为 16 至 4096 的整数')
        return width,height
    def _camera_entity(self,path):
        for eid,e in sorted(self.entities.items()):
            for local,camera in sorted(e.get('cameras',{}).items()):
                if camera.get('path')==path:return eid,local,camera
        return None,None,None
    def _camera_prim(self,path):
        prim=self.stage.GetPrimAtPath(path)
        if not prim.IsValid() or not prim.IsA(UsdGeom.Camera):raise SceneError('CAMERA_NOT_FOUND','命名相机不存在或不是USD Camera: '+path)
        return UsdGeom.Camera(prim)
    def _camera_parent_world_matrix(self,camera):
        """RTX 下从官方 Fabric 层级读物理父节点；USD 局部安装位姿仍由相机 prim 持有。"""
        xform=UsdGeom.Xformable(camera.GetPrim())
        parent=camera.GetPrim().GetParent()
        if xform.GetResetXformStack() or not parent.IsValid() or str(parent.GetPath())=='/':return Gf.Matrix4d(1.)
        return self._native_world_matrix(parent)
    def _native_world_matrix(self,prim):
        if not rendering:return UsdGeom.XformCache().GetLocalToWorldTransform(prim)
        fabric=getattr(SM,'_physx_fabric_interface',None)
        if fabric is None:raise SceneError('SENSOR_UNAVAILABLE','RTX Fabric接口未初始化')
        fabric.update(SM.get_simulation_time(),self.dt)
        import usdrt
        from isaacsim.core.experimental.utils import stage as stage_utils
        stage=stage_utils.get_current_stage(backend='fabric')
        hierarchy=usdrt.hierarchy.IFabricHierarchy().get_fabric_hierarchy(stage.GetFabricId(),stage.GetStageIdAsStageId())
        hierarchy.update_world_xforms()
        matrix=hierarchy.get_world_xform(usdrt.Sdf.Path(str(prim.GetPath())))
        return Gf.Matrix4d(*[float(matrix[i][j]) for i in range(4) for j in range(4)])
    def _camera_parent_body_name(self,path):
        eid,local,camera=self._camera_entity(path);body=(camera or {}).get('bodyPath') or ''
        if (camera or {}).get('parentBodyName'):return camera['parentBodyName']
        return body.rsplit('/',1)[-1] or 'world'
    def _vec3(self,value):return [float(value[0]),float(value[1]),float(value[2])]
    def _quaternion_xyzw(self,quaternion):
        imaginary=quaternion.GetImaginary();return [float(imaginary[0]),float(imaginary[1]),float(imaginary[2]),float(quaternion.GetReal())]
    def _matrix_from_pose(self,position,quaternion):
        matrix=Gf.Matrix4d(1);matrix.SetRotate(Gf.Quatd(float(quaternion[3]),Gf.Vec3d(float(quaternion[0]),float(quaternion[1]),float(quaternion[2]))));matrix.SetTranslateOnly(Gf.Vec3d(float(position[0]),float(position[1]),float(position[2])));return matrix
    def _camera_world_rotation(self,world):
        """世界位姿矩阵 → world-from-camera 3x3（列 = 相机 x/y/z 轴在世界下的方向）。

        只用 TransformDir 变换三个基向量，不依赖 Gf 矩阵的存储/打印约定（Gf.Matrix3d(quat) 的存储与
        Matrix4d.SetRotate 的存储互为转置，靠打印/索引读会给出相反的手性）。
        """
        world=world.RemoveScaleShear()
        axes=[world.TransformDir(Gf.Vec3d(*basis)) for basis in ([1.,0.,0.],[0.,1.,0.],[0.,0.,1.])]
        return [[float(axes[column][row]) for column in range(3)] for row in range(3)]
    def _camera_pose_receipt(self,matrix):
        return {'positionM':self._vec3(matrix.ExtractTranslation()),'quaternionXyzw':self._quaternion_xyzw(matrix.RemoveScaleShear().ExtractRotationQuat()),
                'rotationMatrix':self._camera_world_rotation(matrix),'matrix4x4':[[float(matrix[i][j]) for j in range(4)] for i in range(4)]}
    def _camera_source_snapshot(self,camera):
        """第一次 override 前记录的源状态：局部变换、transform op 是否存在、verticalAperture 的authored情况。

        clear/sync 据此**逐字**恢复（不是"恢复成看起来差不多"，是恢复到源值本身）。
        """
        attr=camera.GetVerticalApertureAttr();value=attr.Get();xform=UsdGeom.Xformable(camera.GetPrim())
        return {'local':Gf.Matrix4d(xform.GetLocalTransformation()),
                'hadTransformOp':any(op.GetOpType()==UsdGeom.XformOp.TypeTransform for op in xform.GetOrderedXformOps()),
                'verticalApertureAuthored':bool(attr.HasAuthoredValue()),'verticalAperture':float(value) if value is not None else None}
    def _camera_source_fovy(self,camera,source=None):
        """源相机生效的竖直视场：优先取适配器写下的 lyapunov:sourceFovyDeg（源 MJCF 声明值，与
        capture() 覆盖孔径时用的是同一个数），没有则从 focalLength 与源竖直孔径派生（source 给出源快照的
        竖直孔径时才用它，否则读 live prim）。"""
        declared=camera.GetPrim().GetAttribute('lyapunov:sourceFovyDeg')
        if declared and declared.HasValue():return float(declared.Get())
        source=source or {}
        vertical=source.get('verticalAperture')
        if vertical is None:vertical=float(camera.GetVerticalApertureAttr().Get())
        return math.degrees(2*math.atan(vertical/(2*float(camera.GetFocalLengthAttr().Get()))))
    def _camera_effective_fovy(self,camera,override):
        """当前**生效**的竖直视场（度）：临时 override 的 fovy 优先，其次源声明 lyapunov:sourceFovyDeg，
        最后从 live prim 的焦距/竖直孔径派生。

        capture 覆盖孔径、camera_list/camera_adjust 报 K 与 fovyDeg，用的都必须是这一个数——三处若各读各的
        （例如 capture 读源声明、readback 读 prim 孔径），回执 K 与真实渲染就不是同一个口径。
        """
        if override is not None and override.get('fovyOverridden') and override.get('fovyDeg') is not None:
            return float(override['fovyDeg'])
        return self._camera_source_fovy(camera)
    def _apply_camera_aperture(self,camera,fovyDeg,width,height):
        """按**生效**竖直视场与**本次请求分辨率**写回 USD 孔径：竖直=2·focalLength·tan(fovy/2)、
        水平=竖直·width/height（方形像素），返回写下的竖直孔径。

        两个孔径必须一起按当前请求重算：只改竖直（fovy override 的写法）会让水平孔径停在源件/上一次请求的
        宽高比上，非 4:3 分辨率下 fx≠fy——渲染出来的水平视场与回执 K/视锥就不是同一个口径了。
        除这两个孔径外不动相机其它约定（焦距、孔径偏移、投影、变换结构）。
        """
        vertical=2*float(camera.GetFocalLengthAttr().Get())*math.tan(math.radians(fovyDeg)/2)
        camera.GetVerticalApertureAttr().Set(vertical)
        camera.GetHorizontalApertureAttr().Set(vertical*width/height)
        return vertical
    def _set_camera_local_matrix(self,camera,matrix):
        """写入相机局部变换。源相机由 scene_adapter 建立，恒为单支 xformOp:transform（改值即可）；
        没有任何 xform op 时新建同一支；其它 op 结构**明确拒绝**，不为了写 override 破坏源变换结构。"""
        xform=UsdGeom.Xformable(camera.GetPrim());ops=list(xform.GetOrderedXformOps())
        if len(ops)==1 and ops[0].GetOpType()==UsdGeom.XformOp.TypeTransform:ops[0].Set(matrix);return
        if not ops:xform.AddTransformOp().Set(matrix);return
        raise SceneError('UNSUPPORTED_CAMERA_MODEL','相机prim变换op不是单支xformOp:transform（当前'+','.join(str(op.GetOpName()) for op in ops)+'）；临时override拒绝破坏源变换结构')
    def _restore_camera_snapshot(self,camera,source):
        """按源快照恢复：源没有 transform op 时删掉 override 新建的那一支，verticalAperture 按作者状态恢复。"""
        xform=UsdGeom.Xformable(camera.GetPrim());ops=list(xform.GetOrderedXformOps())
        if source['hadTransformOp']:
            if len(ops)==1 and ops[0].GetOpType()==UsdGeom.XformOp.TypeTransform:ops[0].Set(source['local'])
            else:self._set_camera_local_matrix(camera,source['local'])
        else:
            xform.ClearXformOpOrder();attribute=xform.GetPrim().GetAttribute('xformOp:transform')
            if attribute and attribute.IsValid():xform.GetPrim().RemoveProperty(attribute.GetName())
        attr=camera.GetVerticalApertureAttr()
        if source['verticalApertureAuthored']:attr.Set(source['verticalAperture'])
        else:attr.Clear()
    def _camera_override_world_matrix(self,camera,override,parent):
        """override 生效时的世界位姿：world 帧用记录的世界位姿；parent 帧用**当前**父变换把记录值换算；
        未显式覆盖的位姿自由度取当前源值（同 MuJoCo：FOV-only 不冻结姿态）。"""
        source_local=override['source']['local'];source_world=Gf.Matrix4d(source_local*parent)
        if override['referenceFrame']=='parent':
            position=override['positionM'] if override['positionOverridden'] else self._vec3(source_local.ExtractTranslation())
            quaternion=override['quaternionXyzw'] if override['quaternionOverridden'] else self._quaternion_xyzw(source_local.ExtractRotationQuat())
            return Gf.Matrix4d(self._matrix_from_pose(position,quaternion)*parent)
        position=override['positionM'] if override['positionOverridden'] else self._vec3(source_world.ExtractTranslation())
        quaternion=override['quaternionXyzw'] if override['quaternionOverridden'] else self._quaternion_xyzw(source_world.ExtractRotationQuat())
        return self._matrix_from_pose(position,quaternion)
    def _apply_camera_override(self,camera,override):
        """把 override 写进 live 相机 prim：局部变换 = 父世界变换⁻¹ · 目标世界位姿；fovy 落在竖直孔径上
        （fovy=2·atan(verticalAperture/(2·focalLength))，保持 focalLength 与水平孔径不动）。"""
        parent=self._camera_parent_world_matrix(camera)
        # Gf 矩阵是行向量约定：A*B = 先施加A再施加B。世界→局部 = world * parent⁻¹
        # （写成 parent⁻¹ * world 只在父旋转为单位阵时偶然正确，父 body 一旦带旋转就会把相机写偏）。
        self._set_camera_local_matrix(camera,Gf.Matrix4d(self._camera_override_world_matrix(camera,override,parent)*parent.GetInverse()))
        if override['fovyOverridden']:
            camera.GetVerticalApertureAttr().Set(2*float(camera.GetFocalLengthAttr().Get())*math.tan(math.radians(override['fovyDeg'])/2))
    def _camera_readback(self,name,resolved,camera,width,height,override):
        """从 **live prim** 读回真实内外参（不是回声入参）：焦距读 prim，竖直视场取**当前生效**口径
        （override 优先，其次源声明，最后 prim 孔径），水平孔径按同一 fovy 与**本次请求分辨率**得出
        （竖直·width/height）⇒ fx=fy，K 与同一回执里的 fovyDeg 是同一个口径；worldFromCamera 由
        实时父变换与 USD 局部安装变换组合得到（含刚写进去的 override）。

        不再直接读 prim 的水平孔径：它可能停在源件声明的宽高比（适配器按 4:3 写）或上一次不同宽高比的
        capture 上，跨分辨率复用即失真（实测 640×480 下 fx/fy=0.464）。K 必须由 fovy+请求分辨率重算。
        """
        focal=float(camera.GetFocalLengthAttr().Get())
        vertical=2*focal*math.tan(math.radians(self._camera_effective_fovy(camera,override))/2)
        horizontal=vertical*width/height
        horizontal_offset=float(camera.GetHorizontalApertureOffsetAttr().Get() or 0.);vertical_offset=float(camera.GetVerticalApertureOffsetAttr().Get() or 0.)
        fovy=math.degrees(2*math.atan(vertical/(2*focal)));local=UsdGeom.Xformable(camera.GetPrim()).GetLocalTransformation();parent=self._camera_parent_world_matrix(camera);world=Gf.Matrix4d(local*parent)
        eid,local_name,record=self._camera_entity(resolved)
        return {**self._camera_frame_identity(),'cameraName':name,'resolvedCameraName':resolved,'entityId':eid,
                'parentEntityId':(record or {}).get('parentEntityId',eid),'parentBodyName':self._camera_parent_body_name(resolved),
                'cameraSource':(record or {}).get('cameraSource','usd'),'override':override is not None,
                'referenceFrame':override['referenceFrame'] if override is not None else None,
                'intrinsicsSource':'usd-camera-focalLength-aperture','focalLength':focal,'verticalAperture':vertical,'fovyDeg':fovy,
                'intrinsics':intrinsics_from_fovy(fovy,width,height,focal,horizontal_offset,vertical_offset),
                'worldFromCamera':self._camera_pose_receipt(world),'worldFromParent':self._camera_pose_receipt(parent),
                'parentFromCamera':self._camera_pose_receipt(local),'poseSource':'fabric-parent-usd-local' if rendering else 'usd-xformcache-readback'}
    def _convert_camera_override(self,camera,override,target_frame):
        """把已有 override 的显式位姿字段按当前父变换安全换算到 target_frame，返回 (换算后记录, 字段名)。

        只换算显式覆盖过的字段：未显式覆盖的自由度在目标 frame 下继续取源值，不与旧 frame 的坐标静默混合。
        """
        parent=self._camera_parent_world_matrix(camera);world=self._camera_override_world_matrix(camera,override,parent)
        local=Gf.Matrix4d(world*parent.GetInverse())
        converted={'cameraName':override['cameraName'],'referenceFrame':target_frame,'positionOverridden':bool(override.get('positionOverridden')),
                   'quaternionOverridden':bool(override.get('quaternionOverridden')),'fovyDeg':override['fovyDeg'],'fovyOverridden':bool(override.get('fovyOverridden')),
                   'generation':override['generation'],'stepIndex':override['stepIndex'],'source':override['source']}
        fields=[]
        if converted['positionOverridden']:
            converted['positionM']=self._vec3((local if target_frame=='parent' else world).ExtractTranslation());fields.append('positionM')
        if converted['quaternionOverridden']:
            converted['quaternionXyzw']=self._quaternion_xyzw((local if target_frame=='parent' else world).ExtractRotationQuat());fields.append('quaternionXyzw')
        return converted,fields
    def clear_camera_overrides(self):
        """丢掉全部临时 override 并按源快照恢复 prim（sync/close 的唯一清理点）；返回真正恢复的相机数。"""
        stage=getattr(self,'stage',None);count=0
        for path,override in list(self.camera_overrides.items()):
            prim=stage.GetPrimAtPath(path) if stage is not None else None
            if prim and prim.IsValid() and prim.IsA(UsdGeom.Camera):self._restore_camera_snapshot(UsdGeom.Camera(prim),override['source']);count+=1
            self.camera_overrides.pop(path,None)
        return count
    def camera_adjust(self,options):
        """命名相机的临时 override：把位置/姿态/竖直视场写进本 world 的 live USD 相机 prim，clear/sync/close
        按源快照逐字恢复；源场景声明（snapshot/MJCF 与源 prim 属性）不被改写。

        referenceFrame='world'（默认）时 positionM/quaternionXyzw 是世界位姿：写入时按当前父变换反算局部变换，
        渲染/读取前重算，父 body 运动不会把"明确固定的世界位姿"带走（同 MuJoCo 语义）；'parent' 时是相对相机
        所属 body 的局部位姿。两 frame 切换做显式安全换算并回执 frameConverted/convertedFromFrame，绝不静默
        混用坐标。未给出的位姿字段先继承同一 frame 下已有的显式值，否则取该 frame 的当前源值；FOV-only 且没有
        显式位姿字段时不冻结姿态。clear=true 与三个字段互斥；非 clear 至少给一个字段。不可用/非透视/变换op结构
        不支持的相机按既有码结构化拒绝，不返回空壳。
        """
        self.ready()
        expected=options.get('expectedGeneration')
        if isinstance(expected,bool) or not isinstance(expected,int):raise SceneError('INVALID_ARGUMENT','expectedGeneration 必须是整数')
        if expected!=self.generation:raise SceneError('STALE_GENERATION','相机调整代次已过期: 请求 '+str(expected)+'，当前 '+str(self.generation))
        name=options.get('cameraName');resolved=self.resolve_camera_name(name)
        frame=options.get('referenceFrame','world')
        if frame not in ('world','parent'):raise SceneError('INVALID_ARGUMENT',"referenceFrame 必须是 'world' 或 'parent'")
        width,height=self._camera_resolution(options,resolved)
        camera=self._camera_prim(resolved)
        if camera.GetProjectionAttr().Get()!=UsdGeom.Tokens.perspective:raise SceneError('UNSUPPORTED_CAMERA_MODEL','相机调整需要透视相机（位姿/竖直视场 override）：'+resolved)
        base={**self._camera_frame_identity(),
              'cameraName':name,'resolvedCameraName':resolved,'parentBodyName':self._camera_parent_body_name(resolved),'referenceFrame':frame,
              'source':'camera-adjust-temporary-override','clearsOn':['sim_close','sim_sync','camera_adjust(clear)']}
        clear=options.get('clear')
        if clear is not None and not isinstance(clear,bool):raise SceneError('INVALID_ARGUMENT','clear 必须是布尔值')
        position,quaternion,fovy=options.get('positionM'),options.get('quaternionXyzw'),options.get('fovyDeg')
        provided=[field for field,value in (('positionM',position),('quaternionXyzw',quaternion),('fovyDeg',fovy)) if value is not None]
        if clear:
            if provided:raise SceneError('INVALID_ARGUMENT','clear=true 与 positionM/quaternionXyzw/fovyDeg 互斥，不能同时给出')
            existed=self.camera_overrides.pop(resolved,None)
            if existed is not None:self._restore_camera_snapshot(camera,existed['source'])
            return {**base,'override':False,'cleared':existed is not None,'calibration':self._camera_readback(name,resolved,camera,width,height,None)}
        if not provided:raise SceneError('INVALID_ARGUMENT','至少给出 positionM/quaternionXyzw/fovyDeg 之一；清除 override 请用 clear=true')
        if position is not None:
            if not isinstance(position,(list,tuple)) or len(position)!=3:raise SceneError('INVALID_ARGUMENT','positionM 必须是 3 个数')
            position=[finite(value,'positionM['+str(index)+']') for index,value in enumerate(position)]
        if quaternion is not None:
            if not isinstance(quaternion,(list,tuple)) or len(quaternion)!=4:raise SceneError('INVALID_ARGUMENT','quaternionXyzw 必须是 4 个数')
            quaternion=[finite(value,'quaternionXyzw['+str(index)+']') for index,value in enumerate(quaternion)]
            norm=math.sqrt(sum(value*value for value in quaternion))
            if norm<1e-8:raise SceneError('INVALID_ARGUMENT','quaternionXyzw 不能是零四元数')
            quaternion=[value/norm for value in quaternion]
        if fovy is not None:
            fovy=finite(fovy,'fovyDeg')
            if not 0<fovy<180:raise SceneError('INVALID_ARGUMENT','fovyDeg 必须在 (0, 180) 开区间（源相机被替换的垂直视场）')
        previous=self.camera_overrides.get(resolved);converted_fields=[];converted_from=None
        if previous is not None and previous['referenceFrame']!=frame:
            converted_from=previous['referenceFrame'];previous,converted_fields=self._convert_camera_override(camera,previous,frame)
            converted_fields=[field for field in converted_fields if (field=='positionM' and position is None) or (field=='quaternionXyzw' and quaternion is None)]
        position_overridden=position is not None or bool(previous and previous.get('positionOverridden'))
        quaternion_overridden=quaternion is not None or bool(previous and previous.get('quaternionOverridden'))
        fovy_overridden=fovy is not None or bool(previous and previous.get('fovyOverridden'))
        source=previous['source'] if previous is not None else self._camera_source_snapshot(camera)
        parent=self._camera_parent_world_matrix(camera);source_world=Gf.Matrix4d(source['local']*parent)
        if position is None:
            position=(self._vec3(previous['positionM']) if previous is not None and previous.get('positionOverridden')
                      else self._vec3(source['local'].ExtractTranslation()) if frame=='parent' else self._vec3(source_world.ExtractTranslation()))
        if quaternion is None:
            quaternion=([float(value) for value in previous['quaternionXyzw']] if previous is not None and previous.get('quaternionOverridden')
                        else self._quaternion_xyzw(source['local'].ExtractRotationQuat()) if frame=='parent' else self._quaternion_xyzw(source_world.ExtractRotationQuat()))
        if fovy is None:
            fovy=(float(previous['fovyDeg']) if previous is not None and previous.get('fovyOverridden') and previous['fovyDeg'] is not None
                  else self._camera_source_fovy(camera,source))
        override={'cameraName':name,'referenceFrame':frame,'positionM':position,'quaternionXyzw':quaternion,'positionOverridden':position_overridden,
                  'quaternionOverridden':quaternion_overridden,'fovyDeg':fovy,'fovyOverridden':fovy_overridden,'generation':self.generation,'stepIndex':self.index,'source':source}
        self._apply_camera_override(camera,override)
        self.camera_overrides[resolved]=override
        readback=self._camera_readback(name,resolved,camera,width,height,override)
        receipt={**base,'override':True,'worldGeneration':self.generation,'positionOverridden':position_overridden,'quaternionOverridden':quaternion_overridden,
                 'positionM':[float(value) for value in position],'quaternionXyzw':[float(value) for value in quaternion],
                 'fovyDeg':readback['fovyDeg'],'fovyOverridden':fovy_overridden,'intrinsicsSource':readback['intrinsicsSource'],
                 'intrinsicsAtReferenceResolution':readback['intrinsics'],'worldFromCamera':readback['worldFromCamera'],
                 'parentEntityId':readback['parentEntityId'],'parentFromCamera':readback['parentFromCamera'],
                 'worldFromParent':readback['worldFromParent'],'poseSource':readback['poseSource'],
                 'appliesTo':['capture','capture_multi','calibration']}
        if fovy_overridden:receipt['fovyApplied']='verticalAperture（fovy 作为整幅竖直视场：focalLength 与主点不动；水平孔径在采集时按该 fovy 与本次请求分辨率重算，回执 K 与之一致）'
        if converted_fields:receipt.update({'frameConverted':True,'convertedFromFrame':converted_from,'convertedFields':converted_fields})
        return receipt

    def _annotation_calibration(self,name,resolved,camera,width,height,override):
        """标注用的标定：只读 live prim 的焦距/孔径偏移 + 与 `_camera_readback`/`capture` 同一份
        **生效** fovy，按 camera_math.intrinsics_from_fovy 算 K。

        为什么不用 `_camera_readback`：那个函数把 `referenceFrame` 记为 `override['referenceFrame']`，
        override 为 None 时写 None；标注的标定里没有参考系字段，直接用它会多出一个 null 键。
        这里只取同一元数据：焦距与孔径偏移从 prim 读，fovy 取 `_camera_effective_fovy`。
        不需要 RTX——`camera_math` 是纯 Python，所以标定/反投影在本机（无 GPU）也能复算。
        """
        focal=float(camera.GetFocalLengthAttr().Get())
        fovy=self._camera_effective_fovy(camera,override)
        intrinsics=intrinsics_from_fovy(fovy,width,height,focal,
            horizontalApertureOffset=float(camera.GetHorizontalApertureOffsetAttr().Get() or 0.),
            verticalApertureOffset=float(camera.GetVerticalApertureOffsetAttr().Get() or 0.))
        return {**self._camera_readback(name,resolved,camera,width,height,override),'model':'pinhole',
                'coordinateSystem':'right-handed-z-up; USD camera looks along -Z, +Y up',
                'intrinsics':intrinsics,'intrinsicsSource':intrinsics['intrinsicsSource']}
    def _camera_far_depth(self,path):
        """相机远裁剪面（米）：USD clippingRange 的第二个分量。没写或非有限时返回 None。

        RTX 的 `distance_to_image_plane` 对**未命中几何**的射线返回的正是远平面距离，所以它是
        "这个读数是不是背景"的唯一有依据的界；读不到就不猜一个上限（见 camera_math.depth_is_valid）。
        """
        prim=self.stage.GetPrimAtPath(path)
        if not prim or not prim.IsValid():return None
        value=UsdGeom.Camera(prim).GetClippingRangeAttr().Get()
        if value is None:return None
        try:far=float(value[1])
        except Exception:return None
        return far if math.isfinite(far) and far>0 else None
    def project_annotation(self,options):
        """像素 (u,v) + **真实米制深度** → camera/world 坐标；断言与重投影核对在 camera_math 里。

        深度来源两种，且都必须是真实读数：
          · 给出 `captureId`：用那次采集**真实落盘**的 depth npy（像素与该帧同源，可再次标注）；
          · 未给：本步**新鲜渲染**一次（与 capture 同一条 `_rtx_frame` 通路，没有第二条渲染路径），
            登记为 ephemeral 记录（深度未重新落盘 ⇒ 数据集导出明确拒绝，同 MuJoCo CAPTURE_NOT_REUSABLE）。
        明确拒绝：像素越界/非整数、背景或远平面像素、`depthM` 与真实深度不符、capture 不属于本 world、
        该相机不在该 capture 里、capture 属于**旧代次**（Isaac 的 world 代次会随 sync 变）。
        """
        self.ready()
        name=options.get('cameraName');resolved=self.resolve_camera_name(name)
        pixel=options.get('pixel')
        if not isinstance(pixel,(list,tuple)) or isinstance(pixel,bool) or len(pixel)!=2:raise SceneError('INVALID_ARGUMENT','pixel 必须是 [u, v] 两个数')
        u,v=finite(pixel[0],'pixel[0]'),finite(pixel[1],'pixel[1]')
        if u!=int(round(u)) or v!=int(round(v)):raise SceneError('INVALID_ARGUMENT','标注像素必须是整数像素坐标 (u, v)')
        u,v=int(round(u)),int(round(v))
        provided=options.get('depthM')
        if provided is not None:
            provided=finite(provided,'depthM')
            if provided<=0:raise SceneError('INVALID_ARGUMENT','depthM 必须是大于零的米制深度')
        width,height=self._camera_resolution(options,resolved)
        capture_id=options.get('captureId');record=entry=None
        if capture_id is not None:
            if not isinstance(capture_id,str) or not capture_id:raise SceneError('INVALID_ARGUMENT','captureId 必须是非空字符串')
            recorded=self.captures.get(capture_id)
            if recorded is not None:
                width,height=self._camera_resolution({**options,'width':options.get('width',recorded['width']),
                    'height':options.get('height',recorded['height'])},resolved)
            # 校验在 camera_math.select_capture（纯函数，本机可复算）：不存在/ephemeral/旧代次/该 capture
            # 没有这台相机/分辨率不一致/缺内外参，各自结构化拒绝。worker 只把 code:message 转成 SceneError。
            try:
                record,entry,intrinsics,world_from_camera=camera_math_select_capture(self.captures,capture_id,name,resolved,width,height,self.generation)
            except ValueError as error:
                code,_,message=str(error).partition(':')
                raise SceneError(code or 'INVALID_ARGUMENT',message or str(error))
            # 深度必须是**本 capture 里这台相机**的真实条目（select_capture 已按 cameraName/resolvedCameraName
            # 选出 entry），不是 capture 记录的第一台，也不是调用方传入的 depthM。
            depth=np.load(path_from_uri(entry['depth']['uri']))
            depth_source='capture-depth-npy'
        else:
            if not rendering:raise SceneError('SENSOR_UNAVAILABLE','当前Profile未启动RTX；像素+真实深度的标注需要 rendering:rtx（未给 captureId 时标注要用本步真实渲染的深度）')
            path=resolved;camera=self._camera_prim(path);override=self.camera_overrides.get(path)
            rgb,depth,calibration=self._rtx_frame(path,width,height)
            intrinsics=calibration['intrinsics'];world_from_camera=calibration['worldFromCamera']
            depth_source='fresh-render'
        # 边界检查必须先于共同的 depth[v,u] 读取：正越界（u=width）与负越界（u=-1）都必须在同一处按
        # 真实 intrinsics 拒绝成 PIXEL_OUT_OF_BOUNDS，而不是先让 numpy 索引回绕或抛 IndexError。
        if not 0<=u<=intrinsics['width']-1 or not 0<=v<=intrinsics['height']-1:raise SceneError('PIXEL_OUT_OF_BOUNDS','像素 ('+str(u)+','+str(v)+') 超出图像范围 '+str(intrinsics['width'])+'x'+str(intrinsics['height']))
        actual=float(depth[v,u])
        far=self._camera_far_depth(resolved)
        valid,why=depth_is_valid(actual,far)
        if not valid:
            hint='（远裁剪面 '+str(far)+' m；RTX 对未命中几何的射线返回远平面距离）' if why=='AT_OR_BEYOND_FAR_CLIP' else ''
            raise SceneError('ANNOTATION_NO_DEPTH','像素 ('+str(u)+','+str(v)+') 没有有效米制深度（'+why+'）: '+str(actual)+' m'+hint)
        if provided is not None and abs(provided-actual)>max(1e-9,1e-6*actual):
            raise SceneError('ANNOTATION_DEPTH_MISMATCH','depthM='+str(provided)+' 与真实渲染深度 '+str(actual)+' 不一致；深度必须来自真实渲染')
        camera_point=unproject_camera_point(u,v,actual,intrinsics)
        world_point=camera_point_to_world(camera_point,world_from_camera)
        round_trip=world_point_to_pixel(world_point,intrinsics,world_from_camera)
        annotation={'annotationId':str(uuid.uuid4()),'worldId':self.id,'worldGeneration':self.generation,
                    'currentWorldGeneration':self.generation,'generation':self.generation,'sceneRevision':self.revision,
                    'frameId':(record['frameId'] if record is not None else f'{self.id}:{self.generation}:{self.index}'),
                    'stepIndex':(record['stepIndex'] if record is not None else self.index),
                    'simTime':(record['simTime'] if record is not None else self.sim_time),
                    'cameraName':name,'resolvedCameraName':resolved,'pixel':[u,v],'depthM':actual,'depthSource':depth_source,
                    'depthProvided':provided is not None,'cameraPointM':[float(value) for value in camera_point],
                    'worldPointM':[float(value) for value in world_point],
                    'resolution':{'width':int(intrinsics['width']),'height':int(intrinsics['height'])},
                    'fov':{'fovyDeg':intrinsics['fovyDeg'],'fx':intrinsics['fx'],'fy':intrinsics['fy'],'cx':intrinsics['cx'],'cy':intrinsics['cy']},
                    'intrinsicsSource':intrinsics['intrinsicsSource'],
                    'override':bool(entry.get('override')) if entry is not None else resolved in self.camera_overrides,
                    'captureId':capture_id,'calibrationSource':intrinsics['intrinsicsSource'],
                    'backgroundDepthM':far,
                    'receiptRoundTripPx':[float(round_trip[0]),float(round_trip[1])],
                    'reverseProjectionResidualPx':[round_trip[0]-u,round_trip[1]-v]}
        if record is not None:
            record.setdefault('annotations',[]).append(annotation)
        else:
            ephemeral_id='annotation-'+annotation['annotationId']
            self.captures[ephemeral_id]={'captureId':ephemeral_id,'worldId':self.id,'generation':self.generation,
                'sceneRevision':self.revision,'stepIndex':self.index,'simTime':self.sim_time,'frameId':annotation['frameId'],
                'width':width,'height':height,'multi':False,'ephemeral':True,'annotations':[annotation],
                'cameras':[{'cameraName':name,'resolvedCameraName':resolved,'override':annotation['override'],'ephemeral':True,
                            'depthRangeM':[actual,actual],'annotationIds':[],'rgb':None,'depth':None}]}
            annotation['captureId']=ephemeral_id
        return annotation
    def export_camera_dataset(self,options):
        """把**已记录的真实采集**导出为自包含数据集：samples.jsonl + calibration.json +
        annotations.json + dataset.json + 真实 PNG/NPY 副本。

        校验与写盘都在 `camera_dataset.export_dataset` 里（**纯实现**：不 import Kit/numpy，本机也能
        跑真实现；worker 只负责把它接上自己的采集登记表、把结构化拒绝转成 SceneError）。
        只引用 `self.captures` 里登记过的采集：captureId 不存在、是标注自带的 ephemeral 记录、或指向
        **旧代次**，都在那里明确拒绝；文件缺失如实记 missing 并把 status 置 PARTIAL，不冒充完成。
        """
        self.ready()
        try:
            return export_dataset(self.captures,options.get('captureIds'),options['outputDir'],self.generation,
                                  self.id,self.scene['sceneId'],engine='isaac',path_from_uri=path_from_uri)
        except DatasetError as error:
            raise SceneError(error.code,error.message)

    def close(self):
        self.stop({});self.assisted.clear();self.camera_overrides.clear();self.captures.clear();self.contact_subscription=None;self.timeline.stop();self.timeline.commit();self.entities={};gc.collect();self.status='closed'

requests=queue.Queue()
def reader():
    for line in sys.stdin:
        try:requests.put(json.loads(line))
        except Exception as error:emit({'event':'protocol-error','message':str(error)})
    requests.put({'id':'eof','method':'shutdown','args':{}})
threading.Thread(target=reader,daemon=True).start();world=None;running=True
emit({'event':'ready','engine':'isaac','version':state['sdkVersion'],'pid':os.getpid(),'capabilities':{'engine':'isaac','supported':{'staticTriangleMesh':True},'unsupported':{'dynamicTriangleMesh':'UNSUPPORTED_CAPABILITY'},'notes':['明确static/environment+triangle_mesh绑定使用原生none三角面；真实接触以本世界Frame为准，默认mesh仍凸包']}})
while running and omni.kit.app.get_app().is_running():
    while not requests.empty():
        request=requests.get();args=request.get('args',{});method=request['method']
        try:
            if method=='shutdown':
                if world:world.close()
                running=False;result=None
            elif method=='open':
                if world:raise SceneError('WORLD_EXISTS','每个Kit进程只管理一个world')
                world=World(args['snapshot'],args.get('options',{}));result=world.handle()
            elif method=='list_worlds':result=[world.handle()]if world else[]
            else:
                if world is None or args['worldId']!=world.id:raise SceneError('WORLD_NOT_FOUND','world不存在')
                if method=='sync':result=world.sync(args['snapshot'],args.get('options',{}).get('forceRebuild',False))
                elif method=='observe':result=world.observe(args.get('selection'))
                elif method=='set_paused':result=world.set_paused(args['paused'],args['expectedGeneration'])
                elif method=='describe':result=world.describe(args['entityId'])
                elif method=='execute':result=world.execute(args['action'])
                elif method=='receipt':
                    if args['actionId']not in world.receipts:raise SceneError('ACTION_NOT_FOUND','未知actionId；先观察不自动重发')
                    result=world.receipts[args['actionId']]
                elif method=='stop':result=world.stop(args.get('selection',{}))
                elif method=='capture_publish':result=world.publish_capture(args['captureId'],args['fromDir'],args['toDir'])
                elif method=='capture':result=world.capture(args['options'])
                elif method=='camera_list':result=world.camera_list(args.get('options'))
                elif method=='capture_multi':result=world.capture_multi(args['options'])
                elif method=='camera_adjust':result=world.camera_adjust(args['options'])
                elif method=='assist':result=world.assist(args['options'])
                elif method=='camera_project_annotation':result=world.project_annotation(args['options'])
                elif method=='camera_dataset_export':result=world.export_camera_dataset(args['options'])
                elif method=='close':world.close();world=None;result=None
                else:raise SceneError('UNKNOWN_METHOD',method)
            emit({'id':request['id'],'result':result})
        except Exception as error:
            # 错误详情带上诊断上下文（有就带，没有就不加键）：code/message 的既有形状不变。
            # 另发一条**只在失败时出现**的诊断事件（含 Python 堆栈）：传输层只带 code/message，
            # 没有堆栈时"意外异常"无法定位；正常路径不发该事件，不产生噪音。
            import traceback
            details=getattr(error,'details',None)
            emit({'id':request['id'],'error':{'code':getattr(error,'code','ENGINE_ERROR'),'message':str(error),**({'details':details}if details else{})}})
            if not isinstance(error,SceneError):
                emit({'event':'method-error','method':method,'code':getattr(error,'code','ENGINE_ERROR'),
                      'message':str(error),'traceback':traceback.format_exc()})
                # 同一份堆栈也写到 stderr（传输层收进 diagnostics）：事件通道对未知 event 名是丢弃的，
                # 只靠事件在外部看不到堆栈。
                traceback.print_exc()
    now=time.monotonic()
    if world and not world.paused and world.status in ('ready','running')and (world.clock=='realtime' or world.actions)and now>=world.next_tick:
        try:world.tick();world.next_tick=max(world.next_tick+world.dt/world.factor,now-.05)
        except Exception as error:
            for aid in list(world.actions):
                try:world.finish(aid,'failed','ENGINE_ERROR: '+str(error))
                except Exception:pass
            world.status='unavailable'
            # 驱动循环里的意外异常必须带堆栈出去（只有 message 时无法定位；这里不是 SceneError 语义）。
            import traceback
            emit({'event':'world-error','worldId':world.id,'error':str(error),'traceback':traceback.format_exc()})
    if requests.empty():time.sleep(.05 if world is None else .0001)
app.close()
