"""两引擎共用Scene参数解析；不创建世界或补地面，不导入SDK。"""
import math

def scene_gravity(scene,error):
    value=(scene.get('physics')or{}).get('gravityWorldMps2',[0.,0.,-9.81])
    if not isinstance(value,(list,tuple))or len(value)!=3 or any(isinstance(v,bool)or not isinstance(v,(int,float))or not math.isfinite(v)for v in value)or not math.isfinite(math.hypot(*value)):
        raise error('WORLD_GRAVITY_INVALID','世界重力必须是三个有限分量，单位m/s²')
    return list(map(float,value))

def declared_ground_ids(scene):
    return [e['entityId']for e in scene.get('entities',[])if (e.get('components',{}).get('supportSurface')or{}).get('kind')=='ground'and (e.get('components',{}).get('collision')or{}).get('enabled',True)]

def explicit_ground_requested(scene,options):
    # 不再有default=true。显式兼容参数也不能叠Scene-owned支持面。
    return options.get('ground')is True and not declared_ground_ids(scene)and (scene.get('physics')or{}).get('template')not in ('blank','physics-workspace-v1')

def replaceable_standard_ground(scene,entity):
    """只允许未编辑的具名模板支持面让位给已验证原生plane；不是按名称/bbox猜。"""
    c=entity.get('components')or{};s=c.get('supportSurface')or{};p=scene.get('physics')or{}
    return p.get('template')=='physics-workspace-v1'and p.get('groundEntityId')==entity.get('entityId')and s.get('source')=='scene-template'and s.get('template')=='physics-workspace-v1'and not entity.get('parentId')and entity.get('transform')=={'position':[0,0,-.05],'quaternion':[0,0,0,1],'scale':[1,1,1]}and c.get('collision')=={'shape':'box','halfExtents':[10,10,.05],'friction':[1.2,.08,.01]}and c.get('rigidBody')=={'type':'static'}

def standard_support_plane(position,normal):
    """已验证静态原生plane只有顶面z=0、法向+Z才与未编辑标准支持面重合。"""
    return len(position)==len(normal)==3 and all(math.isfinite(v)for v in (*position,*normal))and abs(position[2])<=1e-6 and abs(normal[0])<=1e-6 and abs(normal[1])<=1e-6 and abs(normal[2]-1)<=1e-6

def coverage(scene,physical_ids,ignored_ids=()):
    physical=sorted(set(physical_ids));ignored=set(ignored_ids)
    entities={e['entityId']:e for e in scene.get('entities',[])}
    def covered(entity):
        refs={(r.get('resourceId'),r.get('version'))for r in entity.get('resources',[])};parent=entity.get('parentId');visited=set()
        while parent and parent not in visited and parent in entities:
            visited.add(parent);owner=entities[parent];c=owner.get('components')or{}
            bound=(c.get('physicsBinding')or{}).get('status')=='BOUND'or any(c.get(k)for k in ('mujoco','isaac','newton','articulation'))
            owner_refs={(r.get('resourceId'),r.get('version'))for r in owner.get('resources',[])}
            if parent in physical and bound and refs and refs<=owner_refs:return True
            parent=owner.get('parentId')
        return False
    visual=sorted(e['entityId']for e in scene.get('entities',[])if (e.get('components',{}).get('visual')or e.get('resources'))and e['entityId']not in physical and e['entityId']not in ignored and not covered(e))
    return {'status':'PARTIAL'if physical and visual else'COMPLETE'if physical else'NONE','physicalEntityIds':physical,'visualOnlyEntityIds':visual}
