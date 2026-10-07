"""Isaac Sim 6.0.1 官方 MJCF/URDF→USD 与通用 Scene 适配。
所有转换写入独立cache，源文件不写入。MuJoCo只用于SDK附带的MJCF元数据解析，绝不步进。
"""
from pathlib import Path
from urllib.parse import urlparse,unquote
import json
import math
import os
import uuid
import numpy as np
from pxr import Gf, Sdf, Tf, Usd, UsdGeom, UsdPhysics, PhysxSchema, UsdShade,PhysicsSchemaTools
from isaacsim.asset.importer.mjcf import MJCFImporter,MJCFImporterConfig
from isaacsim.asset.importer.urdf import URDFImporter,URDFImporterConfig
from glb_visual import convert_glb
if os.environ.get('LYAPUNOV_ISAAC_DEVICE','cpu')=='cpu' and os.environ.get('LYAPUNOV_ISAAC_RENDERING','none')!='rtx':
    from cpu_prims import Articulation,RigidPrim,XformPrim
else:
    from isaacsim.core.experimental.prims import Articulation,RigidPrim,XformPrim
from isaacsim.core.experimental.utils import stage as stage_utils


def _scalar_joint_types():
    """单自由度关节类型（MuJoCo: hinge/slide）按整数返回。

    mjtJoint 是 enum.Enum，而 model.jnt_type 的元素是 numpy 整型；在 mujoco 3.13 + numpy 2.2 下
    元组成员判断（np.int32(3) in (mjtJoint.mjJNT_HINGE, ...)）恒为 False，会把所有正常关节静默
    跳过，关节表变空。按整数比较，跨 numpy 版本都成立。
    """
    import mujoco
    return (int(mujoco.mjtJoint.mjJNT_HINGE), int(mujoco.mjtJoint.mjJNT_SLIDE))

class SceneError(Exception):
    def __init__(self,code,message):super().__init__(message);self.code=code

def local_path(uri):
    parsed=urlparse(uri)
    if parsed.scheme=='file':return str(Path(unquote(parsed.path)).resolve())
    if parsed.scheme:raise SceneError('RESOURCE_NOT_LOCAL','先导入远端资产再加载物理模型: '+parsed.scheme)
    return str(Path(uri).resolve())

def native_source(entity):
    components=entity.get('components',{});cfg=components.get('isaac',{})
    if cfg.get('sourcePath'):return local_path(cfg['sourcePath']),cfg
    for resource in entity.get('resources',[]):
        for rep in [*resource.get('representations',[]),resource.get('original',{})]:
            if rep.get('uri','').lower().endswith(('.usd','.usda','.usdc','.xml','.urdf')):return local_path(rep['uri']),cfg
    # 通用消费者可继续持有原生MJCF表示；这是文件格式输入，不依赖另一个Provider。
    if components.get('mujoco',{}).get('sourcePath'):return local_path(components['mujoco']['sourcePath']),{**components['mujoco'],**cfg}
    if components.get('mujoco',{}).get('xml'):return None,{**components['mujoco'],**cfg}
    return None,cfg

def declared_resources(entity):
    # 缓存身份只认实体声明的资源版本：依赖mesh换版并登记新version时主XML的mtime不变，
    # 不能因此复用旧USD；也不逐帧哈希文件内容或绕过Resource owner。
    return json.dumps([[rep.get('uri'),resource.get('version')] for resource in entity.get('resources',[]) for rep in [*resource.get('representations',[]),resource.get('original',{})]],sort_keys=True)

def visual_source(entity, cache_root):
    visual=entity.get('components',{}).get('visual',{})
    if visual.get('kind') not in ('mesh',):return None
    for resource in entity.get('resources',[]):
        reps=list(resource.get('representations',[]))
        # ResourceRef permits an original GLB without a separate representation.
        # Prefer an explicitly tagged visual representation, then fall back to
        # the original only when it is itself glTF.
        candidates=[r for r in reps if r.get('role')=='visual' and r.get('mimeType') in ('model/gltf-binary','model/gltf+json')]
        if not candidates:
            original=resource.get('original',{})
            if original.get('mimeType') in ('model/gltf-binary','model/gltf+json') or original.get('uri','').lower().endswith(('.glb','.gltf')):
                candidates=[original]
        for rep in candidates:
            return convert_glb(local_path(rep['uri']),cache_root,visual.get('gltfNode'),resource.get('version'))
    return None


def signatures(scene):
    def structural(components):
        result={k:v for k,v in components.items() if k!='visual'}
        visual=components.get('visual',{})
        result['visualGeometry']={k:visual[k] for k in ('kind','gltfNode','sourceTransformApplied','sourceTransform') if k in visual}
        return result
    return json.dumps({'physics':scene.get('physics'),'entities':[[e['entityId'],e.get('parentId'),e['transform'],e.get('resources',[]),structural(e.get('components',{}))] for e in scene['entities']]},sort_keys=True)

def poses(scene):
    byid={e['entityId']:e for e in scene['entities']};result={};visiting=set()
    def get(eid):
        if eid in result:return result[eid]
        if eid in visiting:raise SceneError('INVALID_SCENE','实体层级成环')
        visiting.add(eid);e=byid[eid];t=e['transform'];q=t['quaternion'];m=Gf.Matrix4d(1)
        m.SetScale(Gf.Vec3d(*t.get('scale',[1,1,1])));r=Gf.Matrix4d(1);r.SetRotate(Gf.Quatd(q[3],Gf.Vec3d(*q[:3])));m=m*r
        m.SetTranslateOnly(Gf.Vec3d(*t['position']))
        if e.get('parentId'):m=m*get(e['parentId'])
        visiting.remove(eid);result[eid]=m;return m
    for eid in byid:get(eid)
    return result

def verified_native_ground_names(stage,entry):
    """源静态plane、实际ColliderAPI与完整安装位姿共同证明标准支持面；名字不作资格。"""
    from world_physics import standard_support_plane
    if not entry.get('nativePhysicsSource'):return []
    root=stage.GetPrimAtPath(entry['path'])
    if not root.IsValid():return []
    matrix=UsdGeom.XformCache().GetLocalToWorldTransform(root);result=[]
    # USD原生世界无需MJCF元数据也能凭实际static Plane Collider证明；有限mesh/盒不作资格。
    cache=UsdGeom.XformCache()
    for prim in Usd.PrimRange(root,Usd.TraverseInstanceProxies()):
        if str(prim.GetTypeName())!='Plane'or not prim.HasAPI(UsdPhysics.CollisionAPI)or UsdPhysics.CollisionAPI(prim).GetCollisionEnabledAttr().Get()is False:continue
        ancestor=prim;dynamic=False
        while ancestor and ancestor.IsValid():
            if ancestor.HasAPI(UsdPhysics.RigidBodyAPI)and UsdPhysics.RigidBodyAPI(ancestor).GetRigidBodyEnabledAttr().Get()is not False:dynamic=True;break
            ancestor=ancestor.GetParent()
        if dynamic:continue
        world=cache.GetLocalToWorldTransform(prim);axis=str(prim.GetAttribute('axis').Get()or'Z');normal=world.TransformDir(Gf.Vec3d(*{'X':(1,0,0),'Y':(0,1,0),'Z':(0,0,1)}[axis])).GetNormalized()
        if standard_support_plane(world.Transform(Gf.Vec3d(0,0,0)),normal):result.append(str(prim.GetPath()))
    for name,definition in (entry.get('metadata',{}).get('geoms')or{}).items():
        if definition.get('geomKind')!='mjGEOM_PLANE' or definition.get('sourceBodyId')!=0:continue
        q=definition.get('quaternionWxyz');position=definition.get('positionM')
        if q is None or position is None:continue
        rotation=Gf.Rotation(Gf.Quatd(float(q[0]),Gf.Vec3d(*map(float,q[1:]))))
        point=matrix.Transform(Gf.Vec3d(*map(float,position)));normal=matrix.TransformDir(rotation.TransformDir(Gf.Vec3d(0,0,1))).GetNormalized()
        if not standard_support_plane(point,normal):continue
        for path in definition.get('nativePaths',[]):
            prim=stage.GetPrimAtPath(path)
            if prim.IsValid()and any(str(p.GetTypeName())=='Plane'and p.HasAPI(UsdPhysics.CollisionAPI)and UsdPhysics.CollisionAPI(p).GetCollisionEnabledAttr().Get()is not False for p in Usd.PrimRange(prim,Usd.TraverseInstanceProxies())):
                result.append(name);break
    return sorted(set(result))

def collision_pose_rejection(matrix,where):
    """Scene 实体的世界矩阵能否原样交给 PhysX collider：None=可以，否则返回可定位的原因。

    视觉路径用完整矩阵复合（`poses()` 的 `SetScale(...)*SetRotate(...)` 及 visual
    sourceTransform 的同类复合），能表达任意线性映射；Isaac 的 collider 只能表达
    「逐轴**正**缩放 × 旋转 + 平移」（PhysX 的 shape scale 必须为正，也不接受剪切）。
    行向量约定下 collider 的世界矩阵是 `S_h·T_c·M`，其线性部分与 M 的线性部分只差一个正对角
    因子，所以判据落在 M 的 3×3 线性部分上：
      · 三行两两正交 ⇔ M = D·R：这时「逐轴 TRS 累积」与「完整矩阵复合」给出同一个矩阵，可照建；
      · 行列式 > 0：负缩放的镜像交给 PhysX 没有意义（必须烘焙），不能静默塞进去；
      · 每行范数 > 0：scale 有 0 分量会把几何压成退化面，任何碰撞形状都表达不了。
    父层非均匀缩放叠加子件旋转会破坏正交性（剪切）：视觉的完整矩阵仍包含它、collider 不能，
    两条路径不再等价。调用方拿到非 None 时必须明确拒绝，不得静默产出一个与视觉不配准的碰撞体。
    """
    rows=[[float(matrix[i][j]) for j in range(3)] for i in range(3)]
    norms=[math.sqrt(sum(value*value for value in row)) for row in rows]
    if min(norms)<=1e-9:return where+' 的世界变换累计缩放含 0 分量：碰撞几何被压成退化面，任何形状都表达不了'
    for i in range(3):
        for j in range(i+1,3):
            if abs(sum(rows[i][k]*rows[j][k] for k in range(3)))>1e-6*norms[i]*norms[j]:
                return where+' 的世界变换含剪切：父层非均匀缩放叠加子件旋转后不再等于「逐轴缩放×旋转」，Isaac collider 表达不了这段剪切，视觉的完整矩阵却包含它'
    determinant=(rows[0][0]*(rows[1][1]*rows[2][2]-rows[1][2]*rows[2][1])
                 -rows[0][1]*(rows[1][0]*rows[2][2]-rows[1][2]*rows[2][0])
                 +rows[0][2]*(rows[1][0]*rows[2][1]-rows[1][1]*rows[2][0]))
    if determinant<0:return where+' 的世界变换含镜像（行列式 '+format(determinant,'.6g')+'<0）：PhysX collider 的缩放必须为正，镜像几何必须先在源侧烘焙'
    return None

def enum_name(enum,value):
    """MuJoCo编译枚举的稳定名字（如mjTRN_SITE）；未知取值回落成数字串，不猜语义。"""
    try:return enum(int(value)).name
    except (ValueError,TypeError):return str(int(value))

def object_name(model,objtype,objid):
    """按编译后的 (objtype,objid) 取对象名；取不到返回 None（**不返回空串**）。

    这是源侧"这条 sensor/wrap 指向哪个对象"的唯一翻译点。MuJoCo 3.8 的 Python 绑定里
    `MjModel` 没有 `id2name` 方法（旧代码 `model.id2name(...)` 抛 AttributeError 且被同一处的
    except 静默吞掉），于是所有带 object 的 sensor 都拿到 objName=None，下游只能报"目标不在
    导入后的 DOF 里"——把"名字没查到"错报成"关节不存在"。这里按 mj_id2name → 按类型取对象名
    逐级回退，全部失败才返回 None，并让调用方能区分 null 与空名。
    """
    index=int(objid)
    if index<0:return None
    import mujoco
    try:
        name=mujoco.mj_id2name(model,int(objtype),index)
        if name:return name
    except Exception:pass
    accessors={int(mujoco.mjtObj.mjOBJ_BODY):'body',int(mujoco.mjtObj.mjOBJ_JOINT):'joint',
               int(mujoco.mjtObj.mjOBJ_GEOM):'geom',int(mujoco.mjtObj.mjOBJ_SITE):'site',
               int(mujoco.mjtObj.mjOBJ_CAMERA):'camera',int(mujoco.mjtObj.mjOBJ_TENDON):'tendon',
               int(mujoco.mjtObj.mjOBJ_ACTUATOR):'actuator',int(mujoco.mjtObj.mjOBJ_SENSOR):'sensor'}
    try:return getattr(model,accessors[int(objtype)])(index).name or None
    except Exception:return None

def mjcf_metadata(source,cfg):
    import mujoco
    model=mujoco.MjModel.from_xml_path(source)
    key=mujoco.mj_name2id(model,mujoco.mjtObj.mjOBJ_KEY,cfg.get('keyframe','home'))
    home=model.key_qpos[key] if key>=0 else model.qpos0
    joints={};actuators={};sites={};cameras={};geoms={};bodies={}
    for i in range(model.nbody):
        name=model.body(i).name
        if name:bodies[name]={'massKg':float(model.body_mass[i]),'parent':model.body(int(model.body_parentid[i])).name if model.body_parentid[i] else None,
                           'jointTypes':[mujoco.mjtJoint(int(model.jnt_type[j])).name.replace('mjJNT_','').lower() for j in range(model.njnt) if int(model.jnt_bodyid[j])==i],
                           # 源声明的 body 局部位移（相对父 body）与 qpos0 下的世界原点。几何步态要算
                           # "髋→膝→足"的相对量，没有这两个量就只能靠引擎 FK（本适配层不用引擎 FK 做源侧几何）。
                           'positionM':model.body_pos[i].tolist()}
    # MJCF free-base semantics are source metadata, independent of the
    # importer naming scheme.  Only a free joint on a direct child of world
    # is a free base; a nested free joint remains an ordinary articulated body.
    scalar_joints=_scalar_joint_types()
    free_base={'present':False,'sourceRootBody':None,'jointName':None}
    for j in range(model.njnt):
        body_id=int(model.jnt_bodyid[j]);parent_id=int(model.body_parentid[body_id])
        if model.jnt_type[j]==mujoco.mjtJoint.mjJNT_FREE and parent_id==0:
            # 载荷质量是源声明的物理事实（自由根刚体的质量），thrust实现用它做SI单位核对与回执，
            # 不从模型名/固定常数推断。
            free_base={'present':True,'sourceRootBody':model.body(body_id).name,
                       'jointName':model.joint(j).name,'massKg':float(model.body_mass[body_id])}
            break
    for i in range(model.ngeom):
        name=model.geom(i).name or f'geom_{i}'
        body_id=int(model.geom_bodyid[i])
        geoms[name]={'sourceGeomName':name,'sourceGeomId':i,'sourceBody':model.body(body_id).name,'nativePaths':[],
                     # geom 在所属 body 坐标系里的位置与尺寸（编译结果原值）。没有同名 site 的机型
                     # （如 Go2）要靠它找足端，所以这两项是源事实的一部分，不该缺。
                     'positionM':model.geom_pos[i].tolist(),'quaternionWxyz':model.geom_quat[i].tolist(),'sizeM':model.geom_size[i].tolist(),
                     'geomType':int(model.geom_type[i]),'geomKind':enum_name(mujoco.mjtGeom,model.geom_type[i]),'sourceBodyId':body_id}
    for i in range(model.ncam):
        name=model.camera(i).name
        if name:cameras[name]={'body':model.body(int(model.cam_bodyid[i])).name if model.cam_bodyid[i] else None,'positionM':model.cam_pos[i].tolist(),'quaternionWxyz':model.cam_quat[i].tolist(),'fovyDeg':float(model.cam_fovy[i]),'mode':int(model.cam_mode[i]),'orthographic':bool(model.cam_projection[i]!=mujoco.mjtProjection.mjPROJ_PERSPECTIVE) if hasattr(model,'cam_projection') else bool(model.cam_orthographic[i]),'resolution':model.cam_resolution[i].tolist(),'sensorSize':model.cam_sensorsize[i].tolist()}
    for i in range(model.nsite):
        name=model.site(i).name
        if name:sites[name]={'body':model.body(int(model.site_bodyid[i])).name,'positionM':model.site_pos[i].tolist(),'quaternionWxyz':model.site_quat[i].tolist()}
    for j in range(model.njnt):
        if int(model.jnt_type[j]) not in scalar_joints:continue
        name=model.joint(j).name
        joints[name]={'type':'slide' if model.jnt_type[j]==mujoco.mjtJoint.mjJNT_SLIDE else 'hinge','home':float(home[model.jnt_qposadr[j]]),'range':model.jnt_range[j].tolist() if model.jnt_limited[j] else None,
                      # 关节在**父 body 坐标系**里的位置与转轴（编译结果原值）。几何步态要用它复合出
                      # 髋/膝的 qpos0 位置，并据此判定"是不是平面二连杆"；缺失时调用方必须明确报错而不是猜。
                      'positionM':model.jnt_pos[j].tolist(),'axisM':model.jnt_axis[j].tolist(),
                      'body':model.body(int(model.jnt_bodyid[j])).name,
                      # 源声明的被动阻尼（MuJoCo对被动力damping的编译结果：hinge/slide关节各一个DOF）。
                      'damping':float(model.dof_damping[model.jnt_dofadr[j]]),
                      # 源声明的执行器力限（jnt_actfrcrange；铰链=N·m、滑移=N）。它钳位的是**该关节上的
                      # 总执行器力**，和actuator级forcerange（单个执行器出力）不是一回事；导入后必须
                      # 映射到PhysX drive maxForce，否则只在mujoco变体里留个mjc:属性、physx运行成无限。
                      'actuatorForceLimited':bool(model.jnt_actfrclimited[j]),'actuatorForceRange':model.jnt_actfrcrange[j].tolist()}
    for a in range(model.nu):
        # MJCF允许actuator不写name（MuJoCo此时给空名）；空名会让下游“关节是否有执行器”
        # 的判断变成假值，把真实被驱动的关节误判成被动关节。与上面geom同名回退一致，
        # 用稳定合成名保留这个真实actuator的身份。
        # 力律类别必须按biastype判定：biastype=NONE时biasprm整体失效（MuJoCo只把它当纯力源
        # force=gainprm[0]×ctrl）。官方BHL力矩资产就是这种：<motor class="berkeley-humanoid-lite">
        # 继承类默认<position kp="50" dampratio="1"/>，biasprm=[0,-50,1]但biastype=NONE——实机语义是
        # ±20 N·m纯力矩，而“biasprm[1]<0即位置”会把它当kp=50位置伺服，凭空造出一台两台引擎都不存在的
        # 控制器（36号任务 runs/bhl-actuator-semantics.json 行为学实测：同类资产同一ctrl=0、偏角0.3 rad
        # 时位置执行器出力-15 N·m、该motor出力0 N·m）。只有AFFINE偏置才使kp=-biasprm[1]、kv=-biasprm[2]成立。
        bias_applies=model.actuator_biastype[a]==mujoco.mjtBias.mjBIAS_AFFINE
        name=model.actuator(a).name or f'actuator_{a}'
        mode='position' if bias_applies and model.actuator_biasprm[a,1]<0 else 'velocity' if bias_applies and model.actuator_biasprm[a,2]<0 else 'torque'
        item={'mode':mode,'stiffness':float(max(0,-model.actuator_biasprm[a,1])) if bias_applies else 0.,'damping':float(max(0,-model.actuator_biasprm[a,2])) if bias_applies else 0.,'maxEffort':float(max(abs(model.actuator_forcerange[a]))) if model.actuator_forcelimited[a] else None,'controlRange':model.actuator_ctrlrange[a].tolist() if model.actuator_ctrllimited[a] else None,
              # gear把执行器出力缩放成关节力矩（位置执行器gear=1）；forceRange是有符号的
              # 单执行器力限区间，进入关节前要乘gear，二者缺一无法把forcerange折算成关节力限。
              'gear':float(model.actuator_gear[a,0]),'forceRange':model.actuator_forcerange[a].tolist() if model.actuator_forcelimited[a] else None,
              # 外力通道（site传输推力/力矩）所需的源事实，全部取自己编译的MjModel，缺一项都会让
              # “模拟哪个执行器、朝哪个方向、多大权限”变成猜测。gear6是site局部系下的力(前3)与
              # 纯力偶(后3)；gain是固定增益（force=gain×ctrl）；力律类别决定该执行器能否被当作
              # 无状态直接力通道；plugin不落盘到USD（mujoco_usd_converter只写mjc:属性），只能在源侧取。
              'transmission':enum_name(mujoco.mjtTrn,model.actuator_trntype[a]),
              'gear6':[float(v) for v in model.actuator_gear[a,:6]],
              'gain':float(model.actuator_gainprm[a,0]),
              'gainType':enum_name(mujoco.mjtGain,model.actuator_gaintype[a]),
              'biasType':enum_name(mujoco.mjtBias,model.actuator_biastype[a]),
              'dynType':enum_name(mujoco.mjtDyn,model.actuator_dyntype[a]),
              'plugin':int(model.actuator_plugin[a])>=0,
              'refSite':model.site(int(model.actuator_trnid[a,1])).name if int(model.actuator_trnid[a,1])>=0 else None}
        if model.actuator_trntype[a]==mujoco.mjtTrn.mjTRN_JOINT:
            item['joint']=model.joint(int(model.actuator_trnid[a,0])).name
            if item['joint'] in joints:joints[item['joint']]['actuator']=name
        elif model.actuator_trntype[a]==mujoco.mjtTrn.mjTRN_SITE:
            site_id=int(model.actuator_trnid[a,0])
            item['targetSite']=model.site(site_id).name;item['siteBody']=model.body(int(model.site_bodyid[site_id])).name
        elif model.actuator_trntype[a]==mujoco.mjtTrn.mjTRN_TENDON:
            # MJCF的tendon执行器（例如Panda的split tendon驱动两个手指）真实驱动这些关节：
            # 源声明就是编译后的tendon路径（fixed tendon每个wrap对象即被驱动的关节）。
            # 它们不是“无执行器的被动关节”，但也不进controlled——controlled只表示关节级
            # 执行器，机械臂关节向量的语义（G04轨迹）保持不变。
            tendon=int(model.actuator_trnid[a,0]);address=int(model.tendon_adr[tendon]);count=int(model.tendon_num[tendon])
            for wrap in range(address,address+count):
                if model.wrap_type[wrap]!=mujoco.mjtWrap.mjWRAP_JOINT:continue
                joint=model.joint(int(model.wrap_objid[wrap])).name
                if joint in joints:joints[joint].setdefault('tendonActuators',[]).append(name)
        actuators[name]=item
    for name,value in cfg.get('initialJointPositions',{}).items():
        if name in joints:joints[name]['home']=value
    # N57／ISAAC-06：源声明的 MJCF `<sensor>` 与 `<tendon>` 必须"有声明就如实登记"——否则 observe 侧
    # 无法区分「源本来没有传感器/肌腱」与「有声明但适配层没接线」。这里只登记**声明**（名称/类型/维度），
    # 不伪造读数：真实读数由 observe 侧按接线状态如实回答。
    sensors={}
    for i in range(int(model.nsensor)):
        obj_name=object_name(model,int(model.sensor_objtype[i]),int(model.sensor_objid[i]))
        sensor_type=enum_name(mujoco.mjtSensor,model.sensor_type[i])
        sensors[model.sensor(i).name or('sensor'+str(i))]={'type':sensor_type,
            # kind 是下游按语义分派的键（jointpos/jointvel/…），在源侧一次算定：worker 不能再从
            # type 字符串"猜"（旧代码 raw.split('_')[-1].lower() 对 mjSENS_JOINTVEL 之类恰好成立，
            # 但那是字符串巧合，不是契约）。两边同源，避免同一个值在两处各算一遍。
            'kind':mujoco.mjtSensor(int(model.sensor_type[i])).name.lower().replace('mjsens_',''),
            'dim':int(model.sensor_dim[i]),'objType':enum_name(mujoco.mjtObj,model.sensor_objtype[i]),'objName':obj_name}
    tendons={}
    for i in range(int(model.ntendon)):
        # N57／ISAAC-15：只登记了 {width,adr} 时，"这条 tendon 由哪些关节什么系数构成、哪个执行器
        # 驱动它、源声明的长度/力区间是什么"都读不到，下游无法判断一条 tendon 动作是否可保真表达。
        # 全部取自已编译 MjModel（不是猜 XML）：np=wrap对象数、wrap_* 是按 tendon_adr 铺平的全局数组，
        # coef 是 mjWRAP_JOINT 的 wrap_prm[0]（源侧 coef，默认1）；length 用 length0（qpos0 处长度，
        # 与未支持动作前的静态值同源），stiffness/damping 是源的被动力声明。
        name=model.tendon(i).name or('tendon'+str(i))
        address=int(model.tendon_adr[i]);count=int(model.tendon_num[i]);wraps=[]
        # wrap_prm 的维度随 MuJoCo 版本变过：编译器的每个 wrap 有 mp.wrap_prm[5]（joint wrap 只填
        # [0]）；本机 3.8 的 Python 绑定把它暴露成**一维** (nwrap,)，按 [wrap,0] 索引会直接
        # IndexError 把整条 MJCF 导入打成失败（源里有 tendon 就必现）。这里按实际维度取：
        # 2 维取 [wrap,0]，1 维取 [wrap]——两条都与编译器语义同源（joint wrap 的系数就是第一个参数），
        # 不猜、也不因为维度差异静默丢系数。
        wrap_parameters=np.asarray(model.wrap_prm)
        def joint_coefficient(index):
            return float(wrap_parameters[index,0] if wrap_parameters.ndim>1 else wrap_parameters[index])
        for wrap in range(address,address+count):
            wrap_type=enum_name(mujoco.mjtWrap,model.wrap_type[wrap]);objid=int(model.wrap_objid[wrap])
            wraps.append({'type':wrap_type,'objectName':object_name(model,int(mujoco.mjtObj.mjOBJ_JOINT)if wrap_type=='mjWRAP_JOINT'else int(mujoco.mjtObj.mjOBJ_SITE),objid)if wrap_type in('mjWRAP_JOINT','mjWRAP_SITE')else None,
                          'objectId':objid,'coefficient':joint_coefficient(wrap)if wrap_type=='mjWRAP_JOINT'else None})
        tendon_drivers=[{'name':model.actuator(a).name or('actuator'+str(a)),
                    'gear0':float(model.actuator_gear[a,0]),'gain':float(model.actuator_gainprm[a,0]),
                    # 合同 TendonActuatorDescription 直接要 gainprm/biasprm 前三项（position 力律判据
                    # kp=gainprm[0]=-biasprm[1]、kv=-biasprm[2] 必须由调用方能复算），这里取源值原样。
                    'gainprm':[float(v)for v in model.actuator_gainprm[a,:3]],
                    'biasprm':[float(v)for v in model.actuator_biasprm[a,:3]],
                    'gear6':[float(v)for v in model.actuator_gear[a,:6]],
                    'gainType':enum_name(mujoco.mjtGain,model.actuator_gaintype[a]),
                    'biasType':enum_name(mujoco.mjtBias,model.actuator_biastype[a]),
                    'dynType':enum_name(mujoco.mjtDyn,model.actuator_dyntype[a]),
                    'plugin':int(model.actuator_plugin[a])>=0,'refSite':model.site(int(model.actuator_trnid[a,1])).name if int(model.actuator_trnid[a,1])>=0 else None,
                    'ctrlRange':model.actuator_ctrlrange[a].tolist()if model.actuator_ctrllimited[a]else None,
                    'forceRange':model.actuator_forcerange[a].tolist()if model.actuator_forcelimited[a]else None}
                   for a in range(int(model.nu))if int(model.actuator_trntype[a])==int(mujoco.mjtTrn.mjTRN_TENDON)and int(model.actuator_trnid[a,0])==i]
        tendons[name]={'width':int(model.tendon_num[i]),'adr':address,
                       'unit':'m（滑移关节位移的线性组合；MuJoCo tendon length 的 SI 单位）',
                       'wraps':wraps,
                       # 只有纯 mjWRAP_JOINT 的固定 tendon，其长度才是各关节坐标的**线性**函数
                       # （Σ coef_j·q_j），也才有可能用一个关节位置参考保真表达；其余 wrap 类型
                       # （site/pulley/cylinder/sphere）长度依赖位形，本适配层没有对应通道。
                       'type':'fixed'if wraps and all(wrap['type']=='mjWRAP_JOINT'for wrap in wraps)else'spatial',
                       'linearInJointCoordinates':bool(wraps)and all(wrap['type']=='mjWRAP_JOINT'for wrap in wraps),
                       'lengthAtQpos0M':float(model.tendon_length0[i]),
                       'range':model.tendon_range[i].tolist()if model.tendon_limited[i]else None,
                       'actuatorForceRange':model.tendon_actfrcrange[i].tolist()if model.tendon_actfrclimited[i]else None,
                       'stiffness':float(model.tendon_stiffness[i]),'damping':float(model.tendon_damping[i]),
                       'frictionLoss':float(model.tendon_frictionloss[i]),
                       'actuators':tendon_drivers}
    from robot_authoring import source_base_metadata
    return {'joints':joints,'actuators':actuators,'sites':sites,'cameras':cameras,'rootBodies':source_base_metadata(model),
            'freeBase':free_base,'geoms':geoms,'bodies':bodies,'sensors':sensors,'tendons':tendons,'parserVersion':mujoco.__version__,
            # 本次真正喂给 MuJoCo 的源路径：四足步态标定要**把同一份源**再交给 gait.py 的 calibrate()，
            # 不重新推导几何；没有这个字段就只能猜源在哪。
            'source':str(source)}

def drive_force_limits(metadata):
    """把源声明的执行器力限折算成每个关节的PhysX drive力限（对称；铰链=N·m、滑移=N）。

    这里只求**关节受力区间的包络**（一个上界），不是多执行器力矩分配，也不声称与多执行器
    驱动力律动态等价：PhysX侧仍只有一个关节级drive maxForce。源侧有两层约束，都取自MuJoCo
    编译结果（model.jnt_actfrcrange / actuator_forcerange），不是按PD增益估算：
      - jnt_actfrcrange：钳位**该关节上的总执行器力**；
      - actuator forcerange：钳位单个执行器出力，进入关节的力矩还要乘gear
        （model.actuator_gear，位置执行器为1；非1的缩放不能丢），多执行器时关节受力区间
        是各执行器区间经gear缩放后的Minkowski和。
    聚合必须区分有界/无界：只要有一个非零传动的执行器不设forceRange，它的出力可任意大，
    关节合力区间就无界（有限子集的Minkowski和只是下界，把它当关节上限会把无界约束错误
    缩成有限值）；此时不施加执行器层上限，但源声明的jnt_actfrcrange仍按关节值生效。
    PhysX只有一个对称的drive maxForce（USD PhysicsDriveAPI schema原文：inf表示不限、
    必须非负），所以只有对称区间的源约束才可等价表达：单边/不对称/为零的区间在这里
    明确拒绝（SceneError），绝不退化成"不限"，也不悄悄只取一侧。gear=0的执行器对关节
    不做功，无论其forcerange有无都不构成约束。源未声明任何力限的关节不进结果——那是源本来
    就无限制，不是把丢失的约束默认成无限。返回 {关节名: 限值}。
    """
    joints=metadata.get('joints',{});acts=metadata.get('actuators',{});limits={}
    def symmetric(bounds,detail):
        low,high=bounds
        if not low<0<high or abs(low+high)>1e-9*max(1.,abs(high)):
            raise SceneError('UNSUPPORTED_CAPABILITY','PhysX drive maxForce只能表达对称力限，'+detail+'是['+str(low)+','+str(high)+']，拒绝导入而不是改成无限或只取一侧')
        return high
    for name,joint in joints.items():
        if joint.get('type') not in ('hinge','slide'):continue
        bounds=[]
        if joint.get('actuatorForceLimited'):
            # N40 缺口 2：报错点名执行器与其源区间（jnt_actfrcrange 是关节属性，回显原始区间）。
            bounds.append(symmetric(joint['actuatorForceRange'],'关节'+name+'的jnt_actfrcrange='+repr(list(joint['actuatorForceRange']))))
        low=high=0.;count=0;unbounded=False;contributors=[]
        for actuator_name,a in acts.items():
            if a.get('joint')!=name or not a.get('gear'):continue
            # 无界执行器（forceRange=None，源侧没写forcerange即出力不限）与有限执行器并联时
            # 合力无界：不能再拿有限子集的和当关节上限，也不再对子集做对称性检查。
            if a.get('forceRange') is None:unbounded=True;continue
            scaled=sorted(a['gear']*value for value in a['forceRange']);low+=scaled[0];high+=scaled[1];count+=1
            contributors.append(actuator_name+' forcerange='+repr(list(a['forceRange']))+' gear='+repr(a['gear']))
        if count and not unbounded:bounds.append(symmetric((low,high),'关节'+name+'上'+str(count)+'个执行器（'+'; '.join(contributors)+'）forcerange（经gear缩放）的合力区间'))
        if bounds:limits[name]=min(bounds)
    return limits

def quat_to_matrix(q):
    """MuJoCo (w,x,y,z) 四元数 → 局部→世界的旋转矩阵（与 mju_quat2Mat 同约定，测试里逐值对照）。"""
    w,x,y,z=(float(v) for v in q);norm=math.sqrt(w*w+x*x+y*y+z*z)
    if not norm or not math.isfinite(norm):raise SceneError('INVALID_CONTROL_MAPPING','site四元数不是有效有限值，无法确定site坐标系')
    w,x,y,z=w/norm,x/norm,y/norm,z/norm
    return np.array([[1-2*(y*y+z*z),2*(x*y-w*z),2*(x*z+w*y)],
                     [2*(x*y+w*z),1-2*(x*x+z*z),2*(y*z-w*x)],
                     [2*(x*z-w*y),2*(y*z+w*x),1-2*(x*x+y*y)]])

def wrench_mapping(metadata,controller):
    """把资产 drone 映射解析成体坐标 wrench 的线性映射：每列 = 1 单位源 ctrl 产生的合 wrench。

    换算只用源模型编译结果（metadata），语义与 MuJoCo 参考实现逐条同源：
      · 只支持 transmission=site 且 site 在实体自由根刚体上的执行器（否则无法表达统一体 wrench）；
      · 只支持固定增益（mjGAIN_FIXED）、无状态（mjDYN_NONE）、无偏置（mjBIAS_NONE）、无 plugin、
        无 refsite 的执行器——此时标量执行器力严格等于 gain×ctrl；
      · gear6 表达在 **site 局部系**：力施加在 site 点、gear[3:6] 是纯力偶，所以该实体根刚体
        坐标系下 F = R·gear[:3]·gain·ctrl，τ = (R·gear[3:] + site_pos × R·gear[:3])·gain·ctrl
        （力矩参考点 = 根刚体坐标系原点）；
      · 0 必须同时落在 ctrlrange/forcerange 内，否则 ctrl=0 撤不掉力，“停止即零力”没有保证。
    没有真实 rotor metadata（无 freeBase/无 sites/无上述字段）时明确拒绝，绝不用固定常数冒充。
    返回 {'actuators','matrix','limits','site','siteBody','massKg','frame'}；matrix 是 6×4。
    """
    if not isinstance(controller,dict) or controller.get('type')!='drone':
        raise SceneError('MISSING_CONTROL_CONFIG','该资产没有 drone 推力/力矩映射')
    torque_axes=controller.get('torqueActuators') or {}
    names={'thrust':controller.get('thrustActuator'),'x':torque_axes.get('x'),'y':torque_axes.get('y'),'z':torque_axes.get('z')}
    if not all(isinstance(names[k],str) and names[k] for k in ('thrust','x','y','z')):
        raise SceneError('MISSING_CONTROL_CONFIG','drone 映射需要 thrustActuator 与 torqueActuators.x/y/z')
    ordered=[names[k] for k in ('thrust','x','y','z')]
    if len(set(ordered))!=len(ordered):
        raise SceneError('INVALID_CONTROL_MAPPING','drone 映射的 4 个执行器名必须互不相同: '+str(ordered))
    free_base=metadata.get('freeBase') or {}
    sources=metadata.get('actuators') or {};sites=metadata.get('sites') or {}
    if not free_base.get('present'):
        raise SceneError('UNSUPPORTED_CAPABILITY','thrust 要求源模型声明自由根刚体（freeBase.present）；当前实体没有')
    root=free_base.get('sourceRootBody')
    columns=[];limits={}
    for name in ordered:
        source=sources.get(name)
        if not source:
            raise SceneError('INVALID_CONTROL_MAPPING','源模型不存在执行器: '+name)
        for key in ('transmission','gear6','gain','gainType','biasType','dynType','plugin'):
            if key not in source:
                raise SceneError('UNSUPPORTED_CAPABILITY','执行器 '+name+' 缺源元数据字段 '+key+'（无法核对 SI 换算与撤销，明确不支持）')
        if source['transmission']!='mjTRN_SITE':
            raise SceneError('INVALID_CONTROL_MAPPING','drone 映射执行器必须是源模型的 site 执行器: '+name)
        if source['plugin']:
            raise SceneError('UNSUPPORTED_CAPABILITY','执行器 '+name+' 使用 plugin 力律，当前通道无法核对 SI 换算与撤销，明确不支持')
        unsupported=[]
        if source['gainType']!='mjGAIN_FIXED':unsupported.append('gaintype='+str(source['gainType']))
        if source['biasType']!='mjBIAS_NONE':unsupported.append('biastype='+str(source['biasType'])+'（ctrl=0 仍有偏置力）')
        if source['dynType']!='mjDYN_NONE':unsupported.append('dyntype='+str(source['dynType'])+'（force 由 activation 而非 ctrl 驱动）')
        if unsupported:
            raise SceneError('UNSUPPORTED_CAPABILITY','执行器 '+name+' 不是固定增益无状态直接力通道：'+'、'.join(unsupported)+'；当前零力撤销无法保证正确 SI 换算，明确不支持')
        if source.get('siteBody')!=root:
            raise SceneError('UNSUPPORTED_CAPABILITY','无法表达统一体 wrench：执行器 '+name+' 的 site 不在该实体自由根刚体上（'+str(source.get('siteBody'))+' != '+str(root)+'）')
        if source.get('refSite'):
            raise SceneError('UNSUPPORTED_CAPABILITY','执行器 '+name+' 指定 refsite='+str(source['refSite'])+'：gear 表达在 refsite 系且按相对位姿量测，transmission 坐标语义与 site 系直接力不同，明确不支持')
        site_name=source.get('targetSite');definition=sites.get(site_name)
        if not site_name or not definition:
            raise SceneError('UNSUPPORTED_CAPABILITY','执行器 '+name+' 的目标 site 不在源模型 site 元数据里: '+str(site_name))
        gain=float(source['gain'])
        if not math.isfinite(gain) or gain==0:
            raise SceneError('INVALID_CONTROL_MAPPING','执行器 '+name+' 的固定增益不是有效非零有限值: '+repr(source['gain']))
        control_range=source.get('controlRange')
        if control_range is not None and not control_range[0]<=0<=control_range[1]:
            raise SceneError('UNSUPPORTED_CAPABILITY','执行器 '+name+' 的 ctrlrange 不含 0，停止/完成后 ctrl=0 撤不掉推力，明确不支持')
        force_range=source.get('forceRange')
        if force_range is not None and not force_range[0]<=0<=force_range[1]:
            raise SceneError('UNSUPPORTED_CAPABILITY','执行器 '+name+' 的 forcerange 不含 0，停止/完成后力回不到零，明确不支持')
        gear=np.asarray(source['gear6'],dtype=float)
        if gear.shape!=(6,) or not np.isfinite(gear).all():
            raise SceneError('INVALID_CONTROL_MAPPING','执行器 '+name+' 的 gear6 不是 6 个有限值')
        rotation=quat_to_matrix(definition['quaternionWxyz']);force=rotation@gear[:3]
        torque=rotation@gear[3:]+np.cross(np.asarray(definition['positionM'],dtype=float),force)
        columns.append(gain*np.concatenate([force,torque]))
        limits[name]={'gain':gain,'ctrlRange':list(control_range) if control_range else None,
                      'forceRange':list(force_range) if force_range else None,
                      'gear6':[float(v) for v in gear],'site':site_name}
    return {'actuators':ordered,'matrix':np.column_stack(columns).tolist(),'limits':limits,
            # 每个执行器自己的 target site 在 limits[name].site；4 个执行器允许用不同 site
            # （列各自按自己的 site 系换算），所以这里不做“统一 site”的错误概括。
            'sites':[sources[name]['targetSite'] for name in ordered],'siteBody':root,'massKg':free_base.get('massKg'),
            'frame':'实体根刚体坐标系（原点=根刚体原点；力沿机体+Z，力矩绕机体x/y/z，SI：N / N·m）'}

def apply_drive_force_limits(usd,metadata):
    """把源力限写进导入产物，让PhysX真正加载的composed stage带上drive力限。

    单位核对（不靠复写数字蒙对）：PhysicsDriveAPI的maxForce在angular drive上是**力矩**
    （usdPhysics/schema.usda：Units: if angular drive: mass*DIST_UNITS*DIST_UNITS/second/second，
    即N·m；linear drive为N），Isaac引擎的set/get_dof_max_efforts直接读写该属性、无任何角度
    换算（isaacsim.core.experimental.prims.impl.articulation.py: drive_api.GetMaxForceAttr()），
    所以源N·m/N数值直接写入；同一DriveAPI里的stiffness/damping才是按度存储（引擎API侧按
    每弧度换算），本函数绝不改写它们。写入落在根层（显式edit target），对physx/physics/
    mujoco各变体都生效，不依赖只被mujoco变体承载的mjc:属性。
    """
    limits=drive_force_limits(metadata)
    if not limits:return {},{}
    stage=Usd.Stage.Open(str(usd))
    if not stage:raise SceneError('IMPORT_INCOMPLETE','导入产物无法打开: '+str(usd))
    stage.SetEditTarget(stage.GetRootLayer())
    joints=metadata['joints'];applied=set();aliases={Tf.MakeValidIdentifier(name):name for name in limits}
    for prim in Usd.PrimRange(stage.GetPseudoRoot()):
        if prim.IsInstanceProxy():continue
        name=prim.GetName();name=name if name in limits else aliases.get(name)
        if name is None:continue
        kind=joints[name]['type']
        if not prim.IsA(UsdPhysics.RevoluteJoint if kind=='hinge' else UsdPhysics.PrismaticJoint):continue
        drive=UsdPhysics.DriveAPI.Apply(prim,'angular' if kind=='hinge' else 'linear')
        drive.CreateMaxForceAttr().Set(float(limits[name]))
        # 源侧原值留档：physx变体里看不到mjc:actuatorfrcrange，核对方便且不参与PhysX解析。
        prim.CreateAttribute('lyapunov:sourceForceLimit',Sdf.ValueTypeNames.Double).Set(float(limits[name]))
        applied.add(name)
    missing=sorted(set(limits)-applied)
    if missing:raise SceneError('IMPORT_INCOMPLETE','源声明的关节力限在导入产物里找不到对应关节，不能静默丢失: '+', '.join(missing))
    stage.GetRootLayer().Save()
    return limits,len(applied)

def collision_names(prim,metadata):
    """将导入器实际生成的 collider 路径映射回 MJCF geom 名称。

    官方 MJCF 导入器通常保留 source geom 名称作为 `Geometry/<name>` 的
    中间 prim，并在其下创建一个 shape prim（例如 `Box`）。联系人报告
    可能指向任一层，因此记录 geom prim 及其所有后代，worker 可按最长
    路径前缀稳定解析为 entityId/sourceGeomName。没有 MJCF geom 元数据时
    返回空映射，绝不按特定机器人名称猜测。
    """
    geoms=metadata.get('geoms',{})
    if not geoms:return {}
    # 官方导入器把碰撞几何放进 instanceable Xform 的引用里（payloads/instances.usda），
    # 这些 prim 只以实例代理可见；不带 TraverseInstanceProxies 的遍历会整片漏掉它们，
    # 联系人路径随后映射不到 geom。这里必须连实例代理一起遍历。
    descendants=list(Usd.PrimRange(prim,Usd.TraverseInstanceProxies()));result={}
    for source_name,definition in geoms.items():
        valid=Tf.MakeValidIdentifier(source_name)
        matches=[p for p in descendants if p.GetName() in (source_name,valid)]
        # 同名节点可能出现在多个 imported body；保留全部原生路径，
        # 由联系人收到的完整路径消歧，不覆盖通用模型的同名 geom。
        for match in matches:
            for path_prim in Usd.PrimRange(match,Usd.TraverseInstanceProxies()):
                result[str(path_prim.GetPath())]=source_name
            definition['nativePaths'].append(str(match.GetPath()))
    return result

def named_sites(prim,metadata):
    """只绑定官方导入器实际保留的site；源模型只给名称/局部定义，不计算关节FK。"""
    if not metadata.get('sites'):return {'status':'UNSUPPORTED_CAPABILITY','message':'该原生USD/URDF未提供可核验的命名site定义'},[],None
    descendants=list(Usd.PrimRange(prim));names=[];paths=[];missing=[]
    for name,definition in metadata['sites'].items():
        candidates=[p for p in descendants if p.GetName()==name and p.GetParent().GetName()==definition['body'] and p.IsA(UsdGeom.Xformable)]
        if len(candidates)!=1:missing.append({'name':name,'reason':'导入后site与所属body不能唯一匹配'});continue
        site=candidates[0];local=UsdGeom.Xformable(site).GetLocalTransformation();q=local.RemoveScaleShear().ExtractRotationQuat()
        actualq=np.array([q.GetReal(),*q.GetImaginary()]);expectedq=np.array(definition['quaternionWxyz'])
        if not np.allclose(local.ExtractTranslation(),definition['positionM'],atol=1e-6,rtol=0) or abs(float(np.dot(actualq,expectedq)))<1-1e-6:
            missing.append({'name':name,'reason':'导入后site局部位姿与原件定义不一致'});continue
        names.append(name);paths.append(str(site.GetPath()))
    if missing:return {'status':'UNSUPPORTED_CAPABILITY','message':'部分MJCF命名site未被精确保留','missing':missing},[],None
    return {'status':'AVAILABLE','source':'mjcf-imported-usd','count':len(names)},names,XformPrim(paths) if paths else None

def native_cameras(stage,prim,metadata):
    """官方 MJCF 转换器暂不输出 camera；按编译后的声明挂到真实 USD body。"""
    result={};descendants=list(Usd.PrimRange(prim))
    # 原生 USD 已有的 Camera 也进入同一清单；只认实际 schema，不按节点名猜相机。
    for node in descendants:
        if not node.IsA(UsdGeom.Camera):continue
        name=str(node.GetPath().MakeRelativePath(prim.GetPath()))
        camera=UsdGeom.Camera(node)
        supported=camera.GetProjectionAttr().Get()==UsdGeom.Tokens.perspective and not any('LensDistortion' in item for item in node.GetAppliedSchemas())
        result[name]={'status':'AVAILABLE' if supported else 'UNSUPPORTED_CAPABILITY','cameraSource':'usd',
                      'path':str(node.GetPath()),'bodyPath':str(node.GetParent().GetPath())}
        if not supported:result[name]['message']='原生 USD 相机不是无畸变透视模型: '+str(node.GetPath())
    for name,definition in metadata.get('cameras',{}).items():
        if definition['mode']!=0 or definition['orthographic'] or any(definition['sensorSize']):
            # 不支持项**逐条说明为什么**（N27）：只写"支持固定机身 fovy 透视相机"时，调用方分不清是跟踪模式、
            # 正交还是非零 sensorSize 被拒，也无法判断该改什么。这里把命中的条件与源值一起给出。
            reasons=[]
            if definition['mode']!=0:reasons.append('mode='+str(definition['mode'])+'（只支持 fixed/0：跟踪模式每步要重算机位，当前适配不消费）')
            if definition['orthographic']:reasons.append('正交投影（只支持透视）')
            if any(definition['sensorSize']):reasons.append('sensorSize='+repr(list(definition['sensorSize']))+'、resolution='+repr(list(definition.get('resolution') or []))+'（只支持 0：带 sensorSize 的相机其画幅比/内参与本适配写死的 4:3 不一致，接受会给出错误 K）')
            result[name]={'status':'UNSUPPORTED_CAPABILITY','message':'当前MJCF相机适配支持固定于body的fovy透视相机；本相机 '+('；'.join(reasons))}
            continue
        parents=[prim] if definition['body'] is None else [p for p in descendants if p.GetName()==definition['body'] and p.IsA(UsdGeom.Xformable)]
        if len(parents)!=1:raise SceneError('CAMERA_BODY_AMBIGUOUS','相机所属body不能唯一匹配: '+name)
        path=parents[0].GetPath().AppendChild(Tf.MakeValidIdentifier(name))
        if stage.GetPrimAtPath(path).IsValid():raise SceneError('CAMERA_PATH_CONFLICT','相机路径已被占用: '+str(path))
        camera=UsdGeom.Camera.Define(stage,path);q=definition['quaternionWxyz']
        matrix=Gf.Matrix4d(1);matrix.SetRotate(Gf.Quatd(q[0],Gf.Vec3d(*q[1:])));matrix.SetTranslateOnly(Gf.Vec3d(*definition['positionM']))
        camera.AddTransformOp().Set(matrix);camera.CreateClippingRangeAttr(Gf.Vec2f(.01,1000));camera.CreateFocalLengthAttr(24)
        vertical=48*math.tan(math.radians(definition['fovyDeg'])/2);camera.CreateVerticalApertureAttr(vertical);camera.CreateHorizontalApertureAttr(vertical*4/3)
        camera.GetPrim().CreateAttribute('lyapunov:sourceFovyDeg',Sdf.ValueTypeNames.Double).Set(definition['fovyDeg'])
        result[name]={'status':'AVAILABLE','cameraSource':'mjcf','path':str(path),'bodyPath':str(parents[0].GetPath())}
    return result

def camera_mount_bodies(stage,entities):
    """实际刚体/Scene 静态碰撞根索引；源名称只描述 body，不使同名视觉 Xform 成为 link。"""
    rows=[]
    for eid,entity in sorted(entities.items()):
        root=stage.GetPrimAtPath(entity['path']);names={}
        for prim in Usd.PrimRange(root):
            if not prim.IsA(UsdGeom.Xformable) or prim.IsA(UsdGeom.Camera):continue
            # 官方 MJCF 导入器可能保留 link1/link1 这样的视觉 Xform；
            # 与源 body 同名不代表它是刚体，也不能把 entity wrapper 当源根 body。
            if not (prim.HasAPI(UsdPhysics.RigidBodyAPI) or (entity.get('collision') and str(prim.GetPath())==entity['path'])):continue
            name=prim.GetName();path=str(prim.GetPath())
            if name in names:
                raise SceneError('CAMERA_BODY_AMBIGUOUS','同一实体的原生 body 名不唯一: '+eid+'/'+name+'（'+names[name]+'；'+path+'）')
            names[name]=path
            rows.append({'entityId':eid,'bodyName':name,'bodyPath':path})
    return rows

def camera_vector(value,size,label):
    if not isinstance(value,(list,tuple)) or len(value)!=size or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in value):
        raise SceneError('INVALID_ARGUMENT',label+' 必须是 '+str(size)+' 个有限数值')
    return [float(v) for v in value]

def camera_pose(position,quaternion,label):
    position=camera_vector(position,3,label+'.positionM');quaternion=camera_vector(quaternion,4,label+'.quaternionXyzw')
    norm=math.sqrt(sum(v*v for v in quaternion))
    if abs(norm-1)>1e-4:raise SceneError('INVALID_ARGUMENT',label+' 的四元数必须归一化')
    quaternion=[v/norm for v in quaternion]
    matrix=Gf.Matrix4d(1).SetRotate(Gf.Quatd(quaternion[3],Gf.Vec3d(*quaternion[:3])))
    return matrix.SetTranslateOnly(Gf.Vec3d(*position))

def scene_cameras(stage,scene,entities,worldposes):
    """先导入全部实体，再把 Scene camera 装到具体真实 body；所有读/调/拍复用原相机登记表。"""
    bodies=camera_mount_bodies(stage,entities)
    for entity in scene['entities']:
        eid=entity['entityId'];components=entity.get('components') or {};declarations=[]
        component=components.get('camera')
        if isinstance(component,dict) and component:declarations.append(('camera',component.get('name') or entity.get('name') or eid,component))
        viewer=components.get('viewerCamera')
        for entry in ((viewer or {}).get('cameras') or []) if isinstance(viewer,dict) else []:
            if isinstance(entry,dict):declarations.append(('viewerCamera',entry.get('name') or entity.get('name') or eid,entry.get('state') or entry))
        for kind,name,definition in declarations:
            if not isinstance(name,str) or not name.strip() or not isinstance(definition,dict):raise SceneError('INVALID_ARGUMENT','Scene 相机名字/声明无效: '+eid)
            name=name.strip();record=entities[eid]['cameras']
            if name in record:raise SceneError('CAMERA_PATH_CONFLICT','Scene 与原生相机重名: '+eid+'/'+name)
            mount=definition.get('mount');parent_id=None
            if mount is not None:
                if not isinstance(mount,dict) or not isinstance(mount.get('entityId'),str) or not isinstance(mount.get('bodyName'),str):raise SceneError('INVALID_ARGUMENT','相机 mount 必须指定 entityId/bodyName: '+eid+'/'+name)
                parent_id=mount['entityId']
                if parent_id not in entities:raise SceneError('CAMERA_BODY_NOT_FOUND','相机目标实体不存在: '+parent_id)
                matches=[row for row in bodies if row['entityId']==parent_id and row['bodyName']==mount['bodyName']]
                if not matches:raise SceneError('CAMERA_BODY_NOT_FOUND','相机目标原生 body 不存在: '+parent_id+'/'+mount['bodyName'])
                if len(matches)!=1:raise SceneError('CAMERA_BODY_AMBIGUOUS','相机目标原生 body 不能唯一匹配: '+parent_id+'/'+mount['bodyName'])
                parent_path=matches[0]['bodyPath'];local=camera_pose(mount.get('positionM'),mount.get('quaternionXyzw'),'camera.mount')
            else:
                parent_path='/World'
                if kind=='viewerCamera':local=camera_pose(definition.get('position'),definition.get('quaternion'),'viewerCamera.state')
                else:local=Gf.Matrix4d(worldposes[eid]).RemoveScaleShear()
                # 已存在的 Scene parentId 绑定只在原生根 body 唯一时接受，不任意选第一个连杆。
                if entity.get('parentId'):
                    parent_id=entity['parentId'];target=entities[parent_id]
                    paths=list(target.get('rigidPaths') or [])
                    if target.get('articulation') is not None:paths=list(target['articulation'].paths)
                    if len(paths)!=1:raise SceneError('CAMERA_BODY_AMBIGUOUS','相机 parentId 没有唯一原生根 body；请显式指定 mount: '+eid)
                    parent_path=paths[0];local=local*UsdGeom.XformCache().GetLocalToWorldTransform(stage.GetPrimAtPath(parent_path)).GetInverse()
            width=definition.get('width',640);height=definition.get('height',480)
            if any(isinstance(v,bool) or not isinstance(v,int) or not 16<=v<=4096 for v in (width,height)):raise SceneError('INVALID_ARGUMENT','Scene 相机 width/height 必须是 16–4096 的整数: '+eid+'/'+name)
            fovy=definition.get('fovYDeg') if kind=='camera' else definition.get('fovDeg')
            focal=definition.get('lensMm',24.)
            if isinstance(focal,bool) or not isinstance(focal,(int,float)) or not math.isfinite(focal) or focal<=0:raise SceneError('INVALID_ARGUMENT','Scene 相机 lensMm 必须为有限正数')
            intrinsics=definition.get('intrinsics');offset_x=offset_y=0.
            if intrinsics is not None:
                if not isinstance(intrinsics,dict):raise SceneError('INVALID_ARGUMENT','Scene 相机 intrinsics 必须为对象')
                fx,fy,cx,cy=camera_vector([intrinsics.get(k) for k in ('fx','fy','cx','cy')],4,'camera.intrinsics')
                iw,ih=intrinsics.get('width'),intrinsics.get('height')
                if any(isinstance(v,bool) or not isinstance(v,int) or not 16<=v<=4096 for v in (iw,ih)) or min(fx,fy)<=0:raise SceneError('INVALID_ARGUMENT','Scene 相机内参分辨率/焦距非法')
                distortion=intrinsics.get('distortion',[])
                if not isinstance(distortion,(list,tuple)):raise SceneError('INVALID_ARGUMENT','Scene 相机 distortion 必须为有限数组')
                if any(camera_vector(distortion,len(distortion),'camera.distortion')):raise SceneError('UNSUPPORTED_CAMERA_MODEL','Isaac 原生相机当前采集不支持非零畸变: '+eid+'/'+name)
                if abs(fx-fy)>1e-6*max(fx,fy):raise SceneError('UNSUPPORTED_CAMERA_MODEL','Isaac RTX 方形像素不能保留该相机的非方形 K；拒绝改写标定: '+eid+'/'+name)
                if 'width' in definition and width!=iw or 'height' in definition and height!=ih:raise SceneError('INVALID_ARGUMENT','Scene 相机声明的分辨率与 intrinsics 不一致')
                width,height=iw,ih;fovy=math.degrees(2*math.atan(height/(2*fy)))
                horizontal=float(focal)*width/fx;vertical=float(focal)*height/fy
                offset_x=((width-1)/2-cx)*horizontal/width;offset_y=(cy-(height-1)/2)*vertical/height
            else:
                if isinstance(fovy,bool) or not isinstance(fovy,(int,float)) or not math.isfinite(fovy) or not 0<fovy<180:raise SceneError('INVALID_ARGUMENT','Scene 相机缺少合法 fovYDeg/K: '+eid+'/'+name)
                vertical=2*float(focal)*math.tan(math.radians(fovy)/2);horizontal=vertical*width/height
            near=definition.get('near',.01);far=definition.get('far',1000.)
            if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in (near,far)) or not 0<near<far:raise SceneError('INVALID_ARGUMENT','Scene 相机 near/far 必须满足 0<near<far')
            path=Sdf.Path(parent_path).AppendChild(Tf.MakeValidIdentifier('lyapunov_camera_'+eid+'_'+name))
            if stage.GetPrimAtPath(path).IsValid():raise SceneError('CAMERA_PATH_CONFLICT','Scene 相机 USD 路径已被占用: '+str(path))
            camera=UsdGeom.Camera.Define(stage,path);camera.AddTransformOp().Set(local)
            camera.CreateProjectionAttr(UsdGeom.Tokens.perspective);camera.CreateClippingRangeAttr(Gf.Vec2f(near,far))
            camera.CreateFocalLengthAttr(focal);camera.CreateVerticalApertureAttr(vertical);camera.CreateHorizontalApertureAttr(horizontal)
            camera.CreateHorizontalApertureOffsetAttr(offset_x);camera.CreateVerticalApertureOffsetAttr(offset_y)
            camera.GetPrim().CreateAttribute('lyapunov:sourceFovyDeg',Sdf.ValueTypeNames.Double).Set(fovy)
            record[name]={'status':'AVAILABLE','cameraSource':'scene-camera','cameraComponent':kind,'path':str(path),'bodyPath':parent_path,
                          'parentEntityId':parent_id,'parentBodyName':stage.GetPrimAtPath(parent_path).GetName() if parent_id else 'world',
                          'referenceResolution':[width,height],'isActive':bool(definition.get('isActive'))}
            if mount is not None:record[name]['mount']=dict(mount)

def collision_vector(value,where,positive=False):
    """碰撞声明的三维向量（center/halfExtents）：必须恰为 3 个有限数值；尺寸另要求全部为正。

    声明即事实：缺项/非数值/非正尺寸明确报错，不回落成默认小盒（与 MuJoCo worker 派生碰撞段同口径）。
    """
    if not isinstance(value,(list,tuple)) or len(value)!=3 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in value) or (positive and min(value)<=0):
        raise SceneError('INVALID_ARGUMENT',where+' 必须是 3 个有限'+('正' if positive else '')+'数值，收到 '+repr(value))
    return [float(v) for v in value]

def collision_scalar(value,where,positive=True):
    """碰撞声明里的标量（球半径/柱半长/friction 分量/restitution）：有限数值，positive 时要求 >0。"""
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or (positive and value<=0):
        raise SceneError('INVALID_ARGUMENT',where+' 必须是有限'+('正' if positive else '非负')+'数值，收到 '+repr(value))
    return float(value)

def scene_mesh_approximation(rigid,binding,collision=None):
    """只消费既有Scene明确策略；静态原始三角面不退为凸包，动态请求明确拒绝。"""
    binding=binding or{}
    topology=(collision or{}).get('meshTopology')
    if topology not in (None,'static-triangles'):raise SceneError('UNSUPPORTED_CAPABILITY','未支持的明确碰撞拓扑：'+str(topology))
    if topology=='static-triangles' and (collision or{}).get('surfaceRadiusM')!=1e-9:raise SceneError('INVALID_ARGUMENT','static-triangles 缺明确 surfaceRadiusM=1e-9 m 来源合同')
    if topology is None and binding.get('strategy')!='triangle_mesh':return 'convexHull'
    if binding.get('usage')not in ('static','environment')or rigid.get('type','static')!='static':
        raise SceneError('UNSUPPORTED_CAPABILITY','ISAAC_STATIC_TRIANGLE_MESH_REQUIRED: triangle_mesh只支持明确static/environment静态绑定；动态体需凸件或已标定SDF，不回退凸包')
    return 'none'

def collision_mesh(uri,where,triangle_mesh=False):
    """消费真实asset-bake OBJ；原始三角面与旧凸件分别校验，不拿bbox替代碰撞。"""
    if not isinstance(uri,str):raise SceneError('INVALID_ARGUMENT',where+' 必须是本地OBJ路径/URI')
    path=Path(local_path(uri))
    if not path.is_file():raise SceneError('COLLISION_MESH_NOT_FOUND',where+' 不存在：'+str(path))
    if path.suffix.lower()!='.obj':raise SceneError('UNSUPPORTED_CAPABILITY',where+' 只接受已派生OBJ，不猜其它格式')
    points=[];counts=[];indices=[]
    try:
        for line in path.read_text(encoding='utf-8').splitlines():
            fields=line.split()
            if not fields:continue
            if fields[0]=='v':
                points.append(collision_vector([float(value) for value in fields[1:4]],where+' 顶点'))
            elif fields[0]=='f':
                face=[int(value.split('/')[0]) for value in fields[1:]]
                if len(face)<3:raise ValueError('面少于3点')
                face=[value-1 if value>0 else len(points)+value for value in face]
                if any(value<0 or value>=len(points) for value in face):raise ValueError('面索引越界')
                counts.append(len(face));indices.extend(face)
    except (OSError,UnicodeError,ValueError) as error:raise SceneError('COLLISION_MESH_INVALID',where+' OBJ无法解析：'+str(error)) from error
    if len(points)<(3 if triangle_mesh else 4)or not counts:raise SceneError('COLLISION_MESH_INVALID',where+' 缺有效网格顶点/面')
    if triangle_mesh and any(count!=3 for count in counts):raise SceneError('COLLISION_MESH_INVALID',where+' 明确triangle_mesh要求真实三角面；不猜凹多边形的三角划分')
    return {'shape':'mesh','points':points,'faceCounts':counts,'faceIndices':indices}

class SceneAdapter:
    def __init__(self,cache_root):
        self.cache_root=Path(cache_root).resolve();self.cache_root.mkdir(parents=True,exist_ok=True);self.converted={}
    def convert(self,entity,covered_by_scene_visual=False):
        source,cfg=native_source(entity)
        base=entity.get('components',{}).get('baseBinding')
        if base and base.get('mode')!='source':
            cfg={**cfg,'fixBase':base.get('mode')=='fixed' and not (base.get('target')or{}).get('entityId')}
        if cfg.get('xml') and not source:
            folder=self.cache_root/'inline'/str(uuid.uuid4());folder.mkdir(parents=True);path=folder/'model.xml';path.write_text(cfg['xml']);source=str(path)
        if not source:
            if covered_by_scene_visual:return None,cfg,{'coveredBySceneVisual':True}
            visual=visual_source(entity,self.cache_root)
            return visual,cfg,{'visualOnly':bool(visual)}
        if not Path(source).exists():raise SceneError('RESOURCE_MISSING',source)
        if source.endswith(('.usd','.usda','.usdc')):return source,cfg,{}
        key=(source,Path(source).stat().st_mtime_ns,json.dumps(cfg,sort_keys=True),declared_resources(entity))
        if key in self.converted:return self.converted[key]
        output=self.cache_root/'imports'/str(uuid.uuid4());output.mkdir(parents=True)
        urdf_fail_prefix='URDF 导入失败（阶段 URDFImporter.import_urdf，源 '  # N146／DEV-018：同一文案段只此一处，两个失败分支共用
        if source.endswith('.urdf'):
            config=URDFImporterConfig(urdf_path=source,usd_path=str(output),fix_base=cfg.get('fixBase'),collision_from_visuals=False,run_multi_physics_conversion=True,merge_fixed_joints=False)
            # N40 缺口 1：导入失败必须如实报错（阶段＋源＋原始异常原文），不得静默退化成"没有元数据"。
            try:usd=URDFImporter(config).import_urdf()
            except Exception as error:
                raise SceneError('IMPORT_FAILED',urdf_fail_prefix+source+'）：'+type(error).__name__+': '+str(error)) from error
            if usd is None:raise SceneError('IMPORT_FAILED',urdf_fail_prefix+source+'）：导入器未抛异常但没有返回 stage，按失败处理，不当作"没有元数据"继续')
            metadata={}
        else:
            config=MJCFImporterConfig(mjcf_path=source,usd_path=str(output),import_scene=False,fix_base=cfg.get('fixBase'),collision_from_visuals=False,allow_self_collision=cfg.get('selfCollision',False),run_multi_physics_conversion=True)
            usd=MJCFImporter(config).import_mjcf();metadata=mjcf_metadata(source,cfg)
            # 导入器把mjc:actuatorfrcrange只写进mujoco变体，physx运行时读不到；在产物上补写
            # 变体无关的drive maxForce，让"真实加载的组合stage"就带源力限（不是只写没加载的usda文件）。
            limits,applied=apply_drive_force_limits(usd,metadata)
            metadata['driveForceLimits']={'limits':limits,'appliedPrims':applied}
        result=(usd,cfg,metadata);self.converted[key]=result;return result
    def populate(self,scene,options):
        # 完成全部转换再切stage，编译失败不会留下半个ready world。
        byid={e['entityId']:e for e in scene['entities']}
        def covered(entity):
            seen=set();parent=entity.get('parentId')
            while parent and parent not in seen:
                seen.add(parent);ancestor=byid[parent]
                if ancestor.get('components',{}).get('isaac',{}).get('collisionSource')=='scene.json':return True
                parent=ancestor.get('parentId')
            return False
        sources={e['entityId']:self.convert(e,covered(e)) for e in scene['entities']}
        stage=stage_utils.create_new_stage();UsdGeom.SetStageUpAxis(stage,UsdGeom.Tokens.z);UsdGeom.SetStageMetersPerUnit(stage,1)
        UsdGeom.Xform.Define(stage,'/World');worldposes=poses(scene)
        from world_physics import scene_gravity,explicit_ground_requested
        gravity=scene_gravity(scene,SceneError);magnitude=math.hypot(*gravity)
        direction=[v/magnitude for v in gravity]if magnitude else[0,0,-1]
        physics=UsdPhysics.Scene.Define(stage,'/World/PhysicsScene');physics.CreateGravityDirectionAttr(Gf.Vec3f(*direction));physics.CreateGravityMagnitudeAttr(magnitude)
        physx=PhysxSchema.PhysxSceneAPI.Apply(physics.GetPrim());physx.CreateEnableCCDAttr(True);physx.CreateEnableStabilizationAttr(True);physx.CreateSolverTypeAttr('TGS')
        if explicit_ground_requested(scene,options):self.primitive(stage,'/World/ground',{'shape':'plane','infinite':True,'size':[0,0,.1],'friction':[1.2,.08,.01]},{'type':'static'},Gf.Matrix4d(1))
        result={}
        for i,e in enumerate(scene['entities']):
            eid=e['entityId'];path=f'/World/entities/e{i}';source,cfg,metadata=sources[eid];components=e.get('components',{});root=UsdGeom.Xform.Define(stage,path)
            if source:
                visual_only=metadata.get('visualOnly',False)
                reference_path=path+'/visual' if visual_only else path
                if visual_only:
                    prim=UsdGeom.Xform.Define(stage,reference_path).GetPrim()
                    prim.GetReferences().AddReference(source)
                else:
                    prim=stage_utils.add_reference_to_stage(usd_path=source,path=reference_path)
                if visual_only:
                    visual=components.get('visual',{})
                    if not visual.get('sourceTransformApplied',False):
                        ref=next((r for r in e['resources'] if any(rep.get('mimeType') in ('model/gltf-binary','model/gltf+json') for rep in [*r.get('representations',[]), r.get('original',{})])), None)
                        if ref is None: raise SceneError('GLB_SOURCE_MISSING','visual source has no glTF representation or original')
                        explicit=visual.get('sourceTransform')
                        if explicit:
                            matrix=Gf.Matrix4d(1).SetScale(Gf.Vec3d(*explicit.get('scale',[1,1,1])))
                            q=explicit.get('quaternion',[0,0,0,1]);matrix=matrix*Gf.Matrix4d(1).SetRotate(Gf.Quatd(q[3],Gf.Vec3d(*q[:3])))
                            matrix.SetTranslateOnly(Gf.Vec3d(*explicit.get('position',[0,0,0])))
                        else:
                            origin=ref.get('source',{});scale=origin.get('metersPerUnit',1)
                            if origin.get('handedness')=='left': raise SceneError('UNSUPPORTED_CAPABILITY','左手坐标GLB需要显式visual.sourceTransform')
                            matrix=Gf.Matrix4d(1).SetScale(Gf.Vec3d(scale,scale,scale))
                            if origin.get('upAxis','Y')=='Y':matrix=matrix*Gf.Matrix4d(1).SetRotate(Gf.Rotation(Gf.Vec3d(1,0,0),90))
                            elif origin.get('upAxis')=='X':matrix=matrix*Gf.Matrix4d(1).SetRotate(Gf.Rotation(Gf.Vec3d(0,1,0),-90))
                        correction=UsdGeom.Xformable(prim)
                        correction.AddTransformOp(opSuffix='sourceCoordinates').Set(matrix)
                else:
                    # 原生机构的变换按规范化Scene pose设置一次。
                    root=UsdGeom.Xform(prim)
            collision_record=None
            if components.get('collision') and (not source or metadata.get('visualOnly')):
                # 视觉走完整矩阵复合、collider 只能表达「逐轴正缩放×旋转」：先在装配前把契约问清楚，
                # 含剪切/镜像/零缩放的层级明确拒绝，不让碰撞体静默地与视觉不配准（ISAAC-11）。
                rejection=collision_pose_rejection(worldposes[eid],'实体 '+eid+'（'+path+'）')
                if rejection is not None:raise SceneError('UNSUPPORTED_CAPABILITY',rejection+'；Scene 碰撞不能用 Isaac collider 保真装配，请把该层级在源侧烘焙成 TRS，或改用原生 USD 源内碰撞')
                collision_record=self.primitive(stage,path,components['collision'],components.get('rigidBody',{}),worldposes[eid],components.get('physicsBinding'))
            else:
                root.ClearXformOpOrder();root.AddTransformOp().Set(worldposes[eid])
                # N52／DEV-029：实体有原生源/视觉源时，Scene 的 components.collision **整段不参与装配**
                # （`:541` 的条件只在「无源」或「视觉-only」时走 primitive 分支）。此前这既不报错也不告警，
                # 调用方会以为声明的碰撞生效了。这里只在既有实体元数据上登记该事实，由 worker 的
                # warnings 通道（WorldHandle.warnings）如实说明；装配行为不变、不新建通道。
                if components.get('collision'):metadata['sceneCollisionIgnored']=True
            if (metadata.get('visualOnly') or metadata.get('coveredBySceneVisual')) and components.get('collision'):
                # 组合碰撞的真实落点是 geometry<i>，不能只把单个 /geometry 标成 guide。
                for collider_path in (collision_record or {}).get('colliderPaths',[path+'/geometry']):
                    UsdGeom.Imageable(stage.GetPrimAtPath(collider_path)).CreatePurposeAttr(UsdGeom.Tokens.guide)
            prim=stage.GetPrimAtPath(path)
            roots=[p for p in Usd.PrimRange(prim) if p.HasAPI(UsdPhysics.ArticulationRootAPI)]
            for articulation_root in roots:PhysxSchema.PhysxArticulationAPI.Apply(articulation_root)
            # PhysX 只为「含关节的链接树」注册真实 articulation。但 Isaac 6.0.1 的 MJCF 导入器会给
            # 只有 free joint 的自由刚体（无人机等，无任何关节后代）也写上 PhysicsArticulationRootAPI：
            # converter.py:187 无条件调用 enable_self_collision(stage, allow_self_collision)，
            # 而 importer_utils.enable_self_collision 在「全 stage 找不到 articulation root」时
            # 直接把 PhysicsArticulationRootAPI/NewtonArticulationRootAPI 加到 default prim 上
            # （importer_utils.py:277-289；cf2 的产物见 payloads/base.usda 根 prim 与 newton:selfCollisionEnabled=0）。
            # 这类 prim 在引擎侧没有 tensor 实体（Articulation.is_physics_tensor_entity_valid() 为 False，
            # 实测报 PHYSICS_NOT_READY）。它本身就是有质量的动态刚体，必须按无关节刚体走 RigidPrim
            # （thrust 通道的合法载体），不能被导入器写法当成「有 articulation 却读不出关节」的机构；
            # 有真实关节的机构（含被动门等）分类不变。
            # ISAAC-12：判定"这个 root 是不是真 articulation"不能要求关节是**它的后代**。
            # 官方 URDF 导入器把关节放在同级 `Physics/` scope（实测：root=`…/Geometry/base`，
            # 关节=`…/Physics/{root_joint,j0,j1}`），关节不在 root 子树里；只按后代找关节会把
            # 一个真实 articulation 判成"有 API 没有关节"，于是退化成 RigidPrim，下游 describe
            # 直接 ENTITY_NOT_ARTICULATED——关节、drive、控制通道整条消失。MJCF 导入器则把关节
            # 放在 root 之下，两种布局都要成立。判据改为：**该实体的子树里有真实关节**即认为
            # root 是 articulation 的根（关节与 root 同属一个已装配的 physics 层级；不做名字猜测）。
            subtree_joints=[p for p in Usd.PrimRange(prim,Usd.TraverseInstanceProxies())if p.IsA(UsdPhysics.Joint)]
            articulated=[p for p in roots if subtree_joints]
            rigid=[p for p in Usd.PrimRange(prim) if p.HasAPI(UsdPhysics.RigidBodyAPI)]
            for body in rigid:PhysxSchema.PhysxContactReportAPI.Apply(body).CreateThresholdAttr(0)
            if cfg.get('articulationRoot') and roots:articulation=Articulation(cfg['articulationRoot'])
            elif articulated:articulation=Articulation(str(articulated[0].GetPath()))
            else:articulation=None
            runtime_pose=articulation if articulation else RigidPrim(str(rigid[0].GetPath())) if rigid else XformPrim(path)
            site_status,site_names,site_prims=named_sites(prim,metadata)
            cameras=native_cameras(stage,prim,metadata)
            native_collision_names=collision_names(prim,metadata)
            result[eid]={'entity':e,'path':path,'articulation':articulation,'pose':runtime_pose,
                         'nativePhysicsSource':bool(source and not metadata.get('visualOnly',False)),
                         'metadata':metadata,'config':cfg,'controller':components.get('controller',{}),
                         'rigidPaths':[str(p.GetPath()) for p in rigid],
                         'collisionNames':native_collision_names,
                         'siteStatus':site_status,'siteNames':site_names,'sitePrims':site_prims,
                         'cameras':cameras,
                         # Scene 声明碰撞实际落成的东西（collider 路径、材质与质量来源）；没有声明
                         # 碰撞的实体（走导入源碰撞）这里为 None，不假装有 Scene 侧消费记录。
                         'collision':collision_record}
        from robot_authoring import capture_model_origin
        for eid,entry in result.items():
            capture_model_origin(stage,entry,worldposes[eid])
        from world_physics import replaceable_standard_ground
        verified_planes=[]
        for eid,entry in result.items():
            entry['metadata']['verifiedNativeGroundNames']=[]
            entry['metadata']['verifiedNativeGroundNames']=verified_native_ground_names(stage,entry)
            verified_planes.extend((eid,name)for name in entry['metadata']['verifiedNativeGroundNames'])
        if verified_planes:
            if stage.GetPrimAtPath('/World/ground').IsValid():stage.RemovePrim('/World/ground')
            for entity in scene['entities']:
                if not replaceable_standard_ground(scene,entity):continue
                entry=result[entity['entityId']]
                for path in (entry.get('collision')or{}).get('colliderPaths',[]):
                    prim=stage.GetPrimAtPath(path);UsdPhysics.CollisionAPI(prim).CreateCollisionEnabledAttr(False);prim.RemoveAPI(UsdPhysics.CollisionAPI)
                entry['metadata']['standardGroundReplaced']=True
                if entry.get('collision'):entry['collision']={**entry['collision'],'source':'native-support-reused','colliderPaths':[]}
        from robot_authoring import install_base_bindings
        install_base_bindings(stage,scene,result,SceneError)
        scene_cameras(stage,scene,result,worldposes)
        return stage,result
    def primitive(self,stage,path,collision,rigid,matrix,binding=None):
        """按 Scene 声明造碰撞体，返回材质/质量/几何来源可读回的记录。

        消费口径与 MuJoCo worker 的派生碰撞段一致（同一 Scene 两个引擎给同一几何）：
          - `shapes[]`（asset-bake voxel_boxes／多 primitive 组合）存在时逐件用自己的 center 与
            halfExtents 造一个盒 collider；顶层单盒字段被忽略，不再把整个实体压成一个默认盒；
          - 单形状必须声明尺寸：box 要 3 个正 halfExtents，sphere 要 radiusM 或 size[0]，
            cylinder/capsule 要 size[0] 半径 + size[1] 半长，plane 要 size[0..1]。缺尺寸、非正尺寸、
            未知形状都在造任何 prim 之前明确报错，不再静默回落成边长 0.2 米的默认盒；
          - center 是实体局部偏移：每个 collider 只带自己的 translate(center) 与尺寸，实体世界变换
            仍由 root（`matrix`）承载（父链复合，与 poses() 同一口径），不改写导入源几何。
        材质与质量按声明落位并各自记账：源声明的摩擦是 MuJoCo 三元组 [滑动,扭转,滚动]，而
        UsdPhysics.MaterialAPI 只有静态/动态摩擦两个库仑通道——滑动系数分别落到两个通道（源没有
        独立的静摩擦声明，两条来源分开记录），扭转/滚动在该材质里没有等价属性，如实记录为未表达，
        既不塞进恢复系数也不静默丢弃。恢复系数与 massKg 未声明时按源语义取默认并记 default。
        """
        shape=collision.get('shape',collision.get('type','box'));entries=collision.get('shapes');declarations=[]
        approximation=scene_mesh_approximation(rigid,binding,collision)if shape=='mesh'else None
        for field,value in [('gravityEnabled',rigid.get('gravityEnabled',True)),('collision.enabled',collision.get('enabled',True))]:
            if not isinstance(value,bool):raise SceneError('INVALID_ARGUMENT',path+' 的 '+field+' 必须是布尔值')
        if shape=='mesh':
            parts=collision.get('parts')
            if not isinstance(parts,list) or not parts:raise SceneError('INVALID_ARGUMENT',path+' 的mesh碰撞必须有真实parts')
            declarations=[collision_mesh(part,path+' 的collision.parts['+str(index)+']',triangle_mesh=approximation=='none') for index,part in enumerate(parts)]
        if entries is not None:
            if shape not in ('box','mesh'):raise SceneError('UNSUPPORTED_CAPABILITY',path+' 的 collision.shapes（组合盒）只对 box/mesh 声明有效，收到 shape='+str(shape))
            if not isinstance(entries,list) or not entries:raise SceneError('INVALID_ARGUMENT',path+' 的 collision.shapes 必须是非空数组，收到 '+repr(entries))
            for index,entry in enumerate(entries):
                if not isinstance(entry,dict):raise SceneError('INVALID_ARGUMENT',path+' 的 collision.shapes['+str(index)+'] 必须是 {center,halfExtents} 对象，收到 '+repr(entry))
                declarations.append({'shape':'box','center':collision_vector(entry.get('center',[0,0,0]),path+' 的 collision.shapes['+str(index)+'].center'),
                                     'size':collision_vector(entry.get('halfExtents'),path+' 的 collision.shapes['+str(index)+'].halfExtents',positive=True)})
        elif shape!='mesh':
            center=collision_vector(collision.get('center',[0,0,0]),path+' 的 collision.center');size=collision.get('halfExtents',collision.get('size'))
            if shape=='box':
                declarations=[{'shape':'box','center':center,'size':collision_vector(size,path+' 的 collision.'+('halfExtents' if 'halfExtents' in collision else 'size'),positive=True)}]
            elif shape=='plane':
                if collision.get('infinite')is True:
                    if rigid.get('type','static')!='static':raise SceneError('UNSUPPORTED_CAPABILITY',path+' 的无限plane只支持静态体')
                    declarations=[{'shape':'plane','infinite':True,'center':center,'size':[0.,0.]}]
                else:
                    if not isinstance(size,(list,tuple)) or len(size)<2:raise SceneError('INVALID_ARGUMENT',path+' 的 plane 碰撞缺 size[0..1]，不按默认尺寸造面')
                    declarations=[{'shape':'plane','center':center,'size':[collision_scalar(size[0],path+' 的 collision.size[0]'),collision_scalar(size[1],path+' 的 collision.size[1]')]}]
            elif shape in ('sphere','cylinder','capsule'):
                radius=collision.get('radiusM')
                if radius is None:
                    if not isinstance(size,(list,tuple)) or not size:raise SceneError('INVALID_ARGUMENT',path+' 的 '+shape+' 碰撞缺尺寸（radiusM 或 collision.halfExtents[0]），不按默认尺寸造 collider')
                    radius=size[0]
                declaration={'shape':shape,'center':center,'radius':collision_scalar(radius,path+' 的 collision.radiusM' if collision.get('radiusM') is not None else path+' 的 collision.halfExtents[0]')}
                if shape!='sphere':
                    half=size[1] if isinstance(size,(list,tuple)) and len(size)>1 else None
                    if half is None:raise SceneError('INVALID_ARGUMENT',path+' 的 '+shape+' 碰撞缺半长（collision.halfExtents[1]），不按默认尺寸造 collider')
                    declaration['halfLength']=collision_scalar(half,path+' 的 collision.halfExtents[1]')
                declarations=[declaration]
            else:raise SceneError('UNSUPPORTED_CAPABILITY','碰撞需要原生USD或asset-bake: '+str(shape))
        declared_friction=collision.get('friction')
        if declared_friction is None:
            if collision.get('material') is not None:
                raise SceneError('UNSUPPORTED_CAPABILITY',path+' 声明了 collision.material='+repr(collision['material'])+' 但没有 collision.friction：Isaac 适配层没有材质表（材质表在 asset-bake／MuJoCo 侧），无法解析该材质的摩擦，也不拿默认摩擦冒充它；请显式声明 collision.friction')
            friction,friction_source=[1.,.005,.0001],'default'
        elif isinstance(declared_friction,bool) or not isinstance(declared_friction,(int,float,list,tuple)):
            raise SceneError('INVALID_ARGUMENT',path+' 的 collision.friction 必须是数值或 3 元数组 [滑动,扭转,滚动]，收到 '+repr(declared_friction))
        elif isinstance(declared_friction,(int,float)):
            sliding=collision_scalar(declared_friction,path+' 的 collision.friction',positive=False)
            # 标量按 asset-bake frictionTripleFromSliding 的比例展开（与 MuJoCo 侧逐值一致）。
            friction,friction_source=[sliding,max(.001,sliding*.05),max(.0001,sliding*.005)],'declared-scalar'
        elif len(declared_friction)!=3 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or v<0 for v in declared_friction):
            raise SceneError('INVALID_ARGUMENT',path+' 的 collision.friction 必须是 3 个非负有限数值 [滑动,扭转,滚动]，收到 '+repr(declared_friction))
        else:friction,friction_source=[float(v) for v in declared_friction],'declared'
        declared_restitution=collision.get('restitution')
        if declared_restitution is None:restitution,restitution_source=0.,'default'
        else:restitution,restitution_source=collision_scalar(declared_restitution,path+' 的 collision.restitution',positive=False),'declared'
        root=UsdGeom.Xform.Define(stage,path);root.ClearXformOpOrder();root.AddTransformOp().Set(matrix)
        material=UsdShade.Material.Define(stage,path+'/material');mat=UsdPhysics.MaterialAPI.Apply(material.GetPrim())
        mat.CreateStaticFrictionAttr(friction[0]);mat.CreateDynamicFrictionAttr(friction[0]);mat.CreateRestitutionAttr(restitution)
        geoms=[]
        for index,declaration in enumerate(declarations):
            geompath=path+'/geometry' if len(declarations)==1 else path+'/geometry'+str(index)
            kind=declaration['shape']
            if kind=='box':
                geom=UsdGeom.Cube.Define(stage,geompath);geom.CreateSizeAttr(2);geom.AddTranslateOp().Set(Gf.Vec3f(*declaration['center']));geom.AddScaleOp().Set(Gf.Vec3f(*declaration['size']))
            elif kind=='plane':
                if declaration.get('infinite'):
                    # 官方helper建立PhysX Plane Collider；20只供有限视觉参考，绝不造厚盒。
                    PhysicsSchemaTools.addGroundPlane(stage,geompath,'Z',20.,Gf.Vec3f(*declaration['center']),Gf.Vec3f(.35,.4,.45))
                    planes=[p for p in Usd.PrimRange(stage.GetPrimAtPath(geompath))if str(p.GetTypeName())=='Plane'and p.HasAPI(UsdPhysics.CollisionAPI)]
                    if len(planes)!=1:raise SceneError('UNSUPPORTED_CAPABILITY',path+' 的SDK未生成单一真实Plane Collider')
                    geom=UsdGeom.Xformable(planes[0])
                else:
                    geom=UsdGeom.Cube.Define(stage,geompath);geom.CreateSizeAttr(2);geom.AddTranslateOp().Set(Gf.Vec3f(*declaration['center']));geom.AddScaleOp().Set(Gf.Vec3f(declaration['size'][0],declaration['size'][1],.002))
            elif kind=='sphere':
                geom=UsdGeom.Sphere.Define(stage,geompath);geom.CreateRadiusAttr(declaration['radius']);geom.AddTranslateOp().Set(Gf.Vec3f(*declaration['center']))
            elif kind=='mesh':
                geom=UsdGeom.Mesh.Define(stage,geompath);geom.CreatePointsAttr([Gf.Vec3f(*point) for point in declaration['points']])
                geom.CreateFaceVertexCountsAttr(declaration['faceCounts']);geom.CreateFaceVertexIndicesAttr(declaration['faceIndices']);geom.CreateSubdivisionSchemeAttr('none')
                UsdPhysics.MeshCollisionAPI.Apply(geom.GetPrim()).CreateApproximationAttr(approximation)
            else:
                geom=(UsdGeom.Cylinder if kind=='cylinder' else UsdGeom.Capsule).Define(stage,geompath);geom.CreateRadiusAttr(declaration['radius']);geom.CreateHeightAttr(declaration['halfLength']*2);geom.CreateAxisAttr('Z');geom.AddTranslateOp().Set(Gf.Vec3f(*declaration['center']))
            UsdPhysics.CollisionAPI.Apply(geom.GetPrim()).CreateCollisionEnabledAttr(collision.get('enabled',True));physx=PhysxSchema.PhysxCollisionAPI.Apply(geom.GetPrim());physx.CreateContactOffsetAttr(.001);physx.CreateRestOffsetAttr(0)
            UsdShade.MaterialBindingAPI.Apply(geom.GetPrim()).Bind(material,UsdShade.Tokens.weakerThanDescendants,'physics')
            geoms.append(geom)
        mass_record={'type':rigid.get('type','static'),'massKg':None,'source':'not-applicable（非动态体不写质量）'}
        body_api=PhysxSchema.PhysxRigidBodyAPI.Apply(root.GetPrim());body_api.CreateDisableGravityAttr(not rigid.get('gravityEnabled',True))
        if rigid.get('type')=='dynamic':
            declared_mass=rigid.get('massKg')
            if declared_mass is None:mass_value,mass_source=1.,'default'
            else:mass_value,mass_source=collision_scalar(declared_mass,path+' 的 rigidBody.massKg'),'declared'
            if rigid.get('massScalePolicy')=='density':mass_value*=abs(float(matrix.GetDeterminant()));mass_source='asset-bake-density'
            UsdPhysics.RigidBodyAPI.Apply(root.GetPrim());mass=UsdPhysics.MassAPI.Apply(root.GetPrim());mass.CreateMassAttr(float(mass_value))
            api=PhysxSchema.PhysxRigidBodyAPI.Apply(root.GetPrim());api.CreateEnableCCDAttr(True);api.CreateSolverPositionIterationCountAttr(16);api.CreateSolverVelocityIterationCountAttr(4)
            mass_record={'type':'dynamic','massKg':mass_value,'source':mass_source}
        return {'shape':shape,'colliderPaths':[str(geom.GetPath()) for geom in geoms],
                'material':{'declaredMaterial':collision.get('material'),'frictionTriple':friction,'frictionSource':friction_source,
                            # 源只有一个滑动系数：PhysX 的静/动摩擦是两个库仑通道，都取该系数（PhysX 要求
                            # static>=dynamic），但两条来源分开记账；扭转/滚动没有等价属性，记录而不搬别处。
                            'staticFriction':{'value':friction[0],'source':'friction[0] 滑动系数（源无独立静摩擦声明）'},
                            'dynamicFriction':{'value':friction[0],'source':'friction[0] 滑动系数'},
                            'restitution':{'value':restitution,'source':restitution_source},
                            'notExpressed':{'torsional':friction[1],'rolling':friction[2],'reason':'UsdPhysics.MaterialAPI 只有静态/动态摩擦与恢复系数三个通道，扭转/滚动摩擦无等价属性'}},
                'mass':mass_record,
                **({'meshParts':[{'colliderPath':str(geom.GetPath()),'approximation':UsdPhysics.MeshCollisionAPI(geom.GetPrim()).GetApproximationAttr().Get(),'pointCount':len(geom.GetPointsAttr().Get()),'faceCount':len(geom.GetFaceVertexCountsAttr().Get()),'nativeFormat':'obj'}for geom in geoms if geom.GetPrim().IsA(UsdGeom.Mesh)]}if shape=='mesh'else{})}
