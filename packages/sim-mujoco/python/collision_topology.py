"""按需读本 world 的真实编译碰撞几何；不读取原件、不物理化、不改变引擎状态。"""
import mujoco as mj
import numpy as np

MAX_GEOMS=512
MAX_VERTICES=200000
MAX_INDICES=600000

def geometry(model,gid,vertex_budget=MAX_VERTICES,index_budget=MAX_INDICES):
    kind=int(model.geom_type[gid]);size=model.geom_size[gid].tolist()
    names={int(mj.mjtGeom.mjGEOM_BOX):'box',int(mj.mjtGeom.mjGEOM_SPHERE):'sphere',
           int(mj.mjtGeom.mjGEOM_CAPSULE):'capsule',int(mj.mjtGeom.mjGEOM_CYLINDER):'cylinder',
           int(mj.mjtGeom.mjGEOM_ELLIPSOID):'ellipsoid',int(mj.mjtGeom.mjGEOM_PLANE):'plane'}
    if kind in names:
        result={'kind':names[kind],'sizeM':size}
        if result['kind']=='plane':result['infinite']=True
        return result
    if kind!=int(mj.mjtGeom.mjGEOM_MESH):return {'kind':'unsupported','sizeM':size,'reason':'当前引擎形状的拓扑未提供；不显示视觉包围盒代替。'}
    mesh=int(model.geom_dataid[gid]);vadr=int(model.mesh_vertadr[mesh]);vnum=int(model.mesh_vertnum[mesh])
    if vnum>vertex_budget:return {'kind':'unsupported','sizeM':size,'reason':'实际网格超过碰撞预览顶点预算；未读取原文件或简化成包围盒。'}
    # MuJoCo 的 mesh 接触使用编译后的凸包多边形，不能把源三角面冒充实际碰撞拓扑。
    if not all(hasattr(model,key) for key in ('mesh_polyadr','mesh_polynum','mesh_polyvertadr','mesh_polyvertnum','mesh_polyvert')):
        return {'kind':'unsupported','sizeM':size,'reason':'当前MuJoCo版本未提供编译凸包多边形拓扑。'}
    start=int(model.mesh_polyadr[mesh]);count=int(model.mesh_polynum[mesh]);indices=[]
    for polygon in range(start,start+count):
        at=int(model.mesh_polyvertadr[polygon]);n=int(model.mesh_polyvertnum[polygon]);vertices=model.mesh_polyvert[at:at+n]
        for index in range(1,n-1):indices.extend([int(vertices[0]),int(vertices[index]),int(vertices[index+1])])
        if len(indices)>index_budget:return {'kind':'unsupported','sizeM':size,'reason':'编译凸包超过碰撞预览面数预算。'}
    if not indices:return {'kind':'unsupported','sizeM':size,'reason':'引擎未提供该mesh的凸包表面。'}
    return {'kind':'convex-hull','sizeM':size,'vertices':model.mesh_vert[vadr:vadr+vnum].reshape(-1).tolist(),'indices':indices}

def patch_ownership(world,patches):
    # 绑定编译器明确传递实例ID；只关联实际编译成功的geom，不按sourceKey或名字猜实例。
    if not isinstance(patches,dict):return {}
    entity=patches.get('entityId')
    if not isinstance(entity,str) or not any(e['entityId']==entity for e in world.scene['entities']):return {}
    candidates={};ground=patches.get('ground') or {}
    if ground.get('kind')=='hfield':candidates[ground.get('name') or 'scene_ground']=True
    elif ground.get('kind')=='boxes':
        for i in range(len(ground.get('boxes') or [])):candidates['scene_collision_ground_'+str(i)]=True
    for i in range(len(patches.get('walls') or [])):candidates['scene_collision_wall_'+str(i)]=False
    if patches.get('catchNetZ') is not None:candidates['scene_catch_net']=True
    present={world.model.geom(i).name for i in range(world.model.ngeom)}
    return {name:(entity,ground) for name,ground in candidates.items() if name in present}

def collision_topology(world,request):
    only=set(request.get('entityIds') or [])
    include_geometry=request.get('includeGeometry',True) is not False
    cache=getattr(world,'_collision_topology_cache',None)
    key=(id(world.model),world.generation,world.applied_revision,tuple(sorted(only)))
    if cache is None or cache['key']!=key:
        cache={'key':key,'geometry':{}}
        world._collision_topology_cache=cache
    geoms=[];omitted=0;model=world.model;vertex_count=0;index_count=0
    explicit=set(int(value) for values in (model.pair_geom1,model.pair_geom2) for value in values)
    for gid in range(model.ngeom):
        if not int(model.geom_contype[gid]) and not int(model.geom_conaffinity[gid]) and gid not in explicit:continue
        name=model.geom(gid).name or 'geom_'+str(gid);entity=world.entity_of_geom(name);ground=name in world.ground_names
        owner=getattr(world,'collision_patch_owners',{}).get(name)
        if owner is not None:entity=owner[0];ground=bool(owner[1])
        if only and entity not in only and not ground:continue
        if len(geoms)>=MAX_GEOMS:omitted+=1;continue
        quat=np.zeros(4);mj.mju_mat2Quat(quat,world.data.geom_xmat[gid])
        row={'geomId':gid,'name':name,'ground':ground,'positionM':world.data.geom_xpos[gid].tolist(),
             'quaternionXyzw':[float(quat[1]),float(quat[2]),float(quat[3]),float(quat[0])]}
        row['collisionEnabled']=True
        row['collisionMask']={'contype':int(model.geom_contype[gid]),'conaffinity':int(model.geom_conaffinity[gid]),'explicitPair':gid in explicit}
        row['dynamic']=int(model.body_weldid[int(model.geom_bodyid[gid])])!=0
        if entity is not None:row['entityId']=entity
        if include_geometry:
            if gid not in cache['geometry']:cache['geometry'][gid]=geometry(model,gid,max(0,MAX_VERTICES-vertex_count),max(0,MAX_INDICES-index_count))
            value=cache['geometry'][gid]
            vertex_count+=len(value.get('vertices',[]))//3;index_count+=len(value.get('indices',[]))
            if vertex_count>MAX_VERTICES or index_count>MAX_INDICES:
                row['geometry']={'kind':'unsupported','sizeM':value['sizeM'],'reason':'选中对象的实际碰撞网格超过总预览预算；未重新读取原件或替换成包围盒。'}
            else:row['geometry']=value
        geoms.append(row)
    for fid in range(model.nflex):
        if not int(model.flex_contype[fid]) and not int(model.flex_conaffinity[fid]):continue
        name=mj.mj_id2name(model,mj.mjtObj.mjOBJ_FLEX,fid) or 'flex_'+str(fid);entity=world.entity_of_geom(name)
        if only and entity not in only:continue
        if len(geoms)>=MAX_GEOMS:omitted+=1;continue
        row={'geomId':model.ngeom+fid,'name':name,'ground':False,'positionM':[0.,0.,0.],
             'quaternionXyzw':[0.,0.,0.,1.],'collisionEnabled':True,
             'collisionMask':{'contype':int(model.flex_contype[fid]),'conaffinity':int(model.flex_conaffinity[fid]),'explicitPair':False}}
        if entity is not None:row['entityId']=entity
        vnum=int(model.flex_vertnum[fid]);vadr=int(model.flex_vertadr[fid]);enum=int(model.flex_elemnum[fid]);eadr=int(model.flex_elemdataadr[fid])
        bodies=model.flex_vertbodyid[vadr:vadr+vnum]
        row['dynamic']=bool(np.any(model.body_weldid[bodies]!=0))
        if include_geometry:
            if int(model.flex_dim[fid])!=2 or row['dynamic']:
                value={'kind':'unsupported','sizeM':[0.,0.,0.],'reason':'当前预览只支持静态二维原三角flex，未猜可变形表面。'}
            elif vnum>MAX_VERTICES-vertex_count or enum*3>MAX_INDICES-index_count:
                value={'kind':'unsupported','sizeM':[0.,0.,0.],'reason':'真实原三角flex超过选中对象总预览预算，未简化为bbox。'}
            else:
                value={'kind':'triangle-mesh','sizeM':[0.,0.,0.],
                       'vertices':world.data.flexvert_xpos[vadr:vadr+vnum].reshape(-1).tolist(),
                       'indices':model.flex_elem[eadr:eadr+enum*3].tolist()}
                vertex_count+=vnum;index_count+=enum*3
            row['geometry']=value
        geoms.append(row)
    return {'source':'mujoco-compiled','worldId':world.id,'generation':world.generation,'sceneRevision':world.applied_revision,
            'stepIndex':world.step_index,'geoms':geoms,'omitted':omitted,'geometryIncluded':include_geometry}
