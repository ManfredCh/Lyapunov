"""使用同世界PhysX的实际GPrim查询；不执行step，不用bbox替代几何相交。"""
import math
from pxr import Gf, Usd, UsdGeom, UsdPhysics, PhysicsSchemaTools
import omni.physx

def _static_matrix(world,prim):
    ancestor=prim
    while ancestor and ancestor.IsValid():
        if ancestor.HasAPI(UsdPhysics.RigidBodyAPI):raise ValueError('本窄路径只读静态形状，不以USD缓存代替动态体pose')
        ancestor=ancestor.GetParent()
    matrix=world._native_world_matrix(prim);scale=list(Gf.Transform(matrix).GetScale())
    if not all(math.isfinite(float(v))and v>0 for v in scale):raise ValueError('静态形状缩放非正或无效')
    rotation=matrix.RemoveScaleShear();reconstructed=Gf.Matrix4d(1).SetScale(Gf.Vec3d(*scale))*rotation
    if any(abs(float(matrix[i][j]-reconstructed[i][j]))>1e-9*max(1.,abs(float(matrix[i][j])))for i in range(4)for j in range(4)):raise ValueError('静态形状包含剪切，未把它当作PhysX可保真的TRS')
    return matrix,rotation,scale

def _numeric_guard(points):
    # 数据/查询结果按PhysX float32精度读回。64个舍入单位的数值保护带，非SDK认证的误差定理；
    # 带内一律接触/未知，不把微小负值判穿透，也不声称数学严格CLEAR。
    magnitude=max((abs(float(v))for point in points for v in point),default=0.)
    return max(1e-6,64.*2.**-24*(1.+magnitude))

def _native_plane(world,prim,query):
    matrix,_,_=_static_matrix(world,prim);axis=str(prim.GetAttribute('axis').Get()or'Z')
    normal=matrix.GetInverse().GetTranspose().TransformDir(Gf.Vec3d(*{'X':(1,0,0),'Y':(0,1,0),'Z':(0,0,1)}[axis])).GetNormalized()
    point=matrix.Transform(Gf.Vec3d(0));path=str(prim.GetPath());sides=[]
    # 只验证当前无限Plane身份/pose/朝向。射线不用于凸包覆盖或通用无相交证明。
    for side in (1.,-1.):
        hits=[]
        def hit(value):
            if str(value.collision)==path:hits.append((float(value.distance),Gf.Vec3d(*value.position),Gf.Vec3d(*value.normal)))
            return True
        query.raycast_all(tuple(point+normal*side),tuple(normal*(-side)),2.,hit,False);sides.append(hits)
    if len(sides[0])!=1 or sides[1]:raise ValueError('原生Plane正反面射线未确认其身份/半空间方向')
    distance,native_point,native_normal=sides[0][0];native_normal=native_normal.GetNormalized();guard=_numeric_guard([point,native_point])
    if not all(math.isfinite(float(v))for v in [distance,*native_point,*native_normal])or abs(distance-1.)>guard*4 or(native_point-point).GetLength()>guard*4 or(native_normal-normal).GetLength()>1e-5:raise ValueError('原生Plane射线pose/法向与当前静态变换不一致')
    return native_point,native_normal

def _cooked_points(world,prim):
    from collision_topology import cooked_mesh
    _,rotation,scale=_static_matrix(world,prim);parts=cooked_mesh(world.stage,prim,scale)
    if not parts or any(part.get('kind')!='convex-hull'for part in parts):raise ValueError('官方cooked凸碰撞表示未完整读回')
    points=[rotation.Transform(Gf.Vec3d(*part['vertices'][i:i+3]))for part in parts for i in range(0,len(part['vertices']),3)]
    if not points or not all(math.isfinite(float(v))for point in points for v in point):raise ValueError('cooked凸包完整顶点为空或无效')
    return points

def initial_overlap(world, maximum_shapes=2048):
    result={'source':'isaac-scene-query','checkedAtStep':world.index,'sceneRevision':world.revision,'status':'UNVERIFIED','pairs':[]}
    if world.index != 0 or not world.timeline.is_playing():
        result['reason']='初始查询仅在初始化完成且World尚未tick的step0执行'
        return result
    failures=[];path_failures={};pairs={};colliders={};self_hits={};native_hits={}
    roots=sorted(((e['path'],eid) for eid,e in world.entities.items()),key=lambda item:len(item[0]),reverse=True)
    def owner(path):
        return next((eid for root,eid in roots if path==root or path.startswith(root+'/')),None)
    for prim in Usd.PrimRange(world.stage.GetPseudoRoot(),Usd.TraverseInstanceProxies()):
        if not prim.HasAPI(UsdPhysics.CollisionAPI):
            continue
        enabled=UsdPhysics.CollisionAPI(prim).GetCollisionEnabledAttr().Get()
        if enabled is False:
            continue
        colliders[str(prim.GetPath())]=prim
    query=omni.physx.get_physx_scene_query_interface()
    if not hasattr(query,'overlap_shape'):
        result['reason']='现有PhysX运行时没有overlap_shape'
        return result
    candidates=list(colliders.items())
    if len(candidates)>maximum_shapes:
        failures.append('实际collider超过'+str(maximum_shapes)+'个查询预算，未用bbox判无相交')
    for path,prim in candidates[:maximum_shapes]:
        if not prim.IsA(UsdGeom.Gprim):
            failures.append(path+' 不是可查询GPrim；该形状未验')
            continue
        if prim.IsA(UsdGeom.Mesh):
            approximation=UsdPhysics.MeshCollisionAPI(prim).GetApproximationAttr().Get()
            # overlap_shape的mesh输入会做convex approximation；只有实际collider本身已是convexHull时口径一致。
            if approximation!='convexHull':
                failures.append(path+' 的实际mesh approximation='+str(approximation)+'，查询会凸化且不能代表它')
                continue
        current_owner=owner(path);self_hit=[False];targets=set()
        def hit(overlap_hit):
            target=str(overlap_hit.collision)
            targets.add(target)
            if target==path:
                self_hit[0]=True
                return True
            if target not in colliders:
                return True
            target_owner=owner(target)
            if current_owner==target_owner:
                return True
            identity=tuple(sorted((path,target)))
            pairs[identity]={'geom1':world.label(path),'geom2':world.label(target),'depthM':None,'depthStatus':'UNKNOWN',
                             **({'entity1':current_owner} if current_owner else {}),**({'entity2':target_owner} if target_owner else {})}
            return True
        try:
            encoded=PhysicsSchemaTools.encodeSdfPath(prim.GetPath())
            query.overlap_shape(encoded[0],encoded[1],hit,False)
            # 未连自身实际collider都命中时，缓存/pose或几何尚未就绪；不能把零hits包装成CLEAR。
            if not self_hit[0]:
                path_failures[path]=path+' 查询未确认自身collider；初始化数据或pose未验证'
            self_hits[path]=self_hit[0]
            native_hits[path]=targets
        except Exception as error:
            path_failures[path]=path+' 原生shape查询失败：'+str(error)
    # overlap_shape包含闭集相切，不能据命中断言穿透。只为实际静态convexHull/Plane补全支持函数。
    cooked={};evaluations=0;pair_checks=0;measured=[]
    for plane_path,plane in candidates[:maximum_shapes]:
        if str(plane.GetTypeName())!='Plane':continue
        others=[(path,prim)for path,prim in candidates if path!=plane_path and owner(path)!=owner(plane_path)]
        try:plane_point,plane_normal=_native_plane(world,plane,query)
        except Exception as error:
            path_failures[plane_path]=plane_path+' 原生Plane验证失败：'+str(error);continue
        all_covered=bool(others)
        for path,prim in others:
            if not prim.IsA(UsdGeom.Mesh)or UsdPhysics.MeshCollisionAPI(prim).GetApproximationAttr().Get()!='convexHull':all_covered=False;continue
            identity=tuple(sorted((path,plane_path)));pairs.pop(identity,None);pair_checks+=1
            try:
                if pair_checks>4096:raise ValueError('凸包/Plane形状对超过4096预算')
                if evaluations>=1000000:raise ValueError('完整顶点支持计算超过预算，未继续读入几何')
                if not self_hits.get(path):raise ValueError('凸包query未确认其当前原生collider')
                if path not in cooked:cooked[path]=_cooked_points(world,prim)
                points=cooked[path];evaluations+=len(points)
                if evaluations>1000000:raise ValueError('完整顶点支持计算超过预算，未用采样替代')
                minimum=min(float(plane_normal.GetDot(point-plane_point))for point in points);guard=_numeric_guard([plane_point,*points])
                if minimum < -guard:
                    if plane_path not in native_hits.get(path,set()):raise ValueError('负支持间距与原生凸查询未命中不一致，保持未知')
                    a,b=identity;pairs[identity]={'geom1':world.label(a),'geom2':world.label(b),'depthM':-minimum,**({'entity1':owner(a)}if owner(a)else{}),**({'entity2':owner(b)}if owner(b)else{})}
                    relation='穿透'
                elif minimum > guard:
                    if plane_path in native_hits.get(path,set()):raise ValueError('正支持间距与原生凸查询命中不一致，保持未知')
                    relation='分离'
                else:
                    relation='相切/数值边界，穿透未确定';failures.append(world.label(path)+' / '+world.label(plane_path)+' 接触或保护带内，未判严格CLEAR')
                measured.append(world.label(path)+' / '+world.label(plane_path)+': '+relation+'，cooked完整顶点signed min='+format(minimum,'.9g')+' m，数值保护带±'+format(guard,'.3g')+' m')
            except Exception as error:all_covered=False;failures.append(path+' / '+plane_path+' 凸包/Plane未验证：'+str(error))
        if all_covered:path_failures.pop(plane_path,None)
        else:path_failures[plane_path]=plane_path+' 原生Plane身份/pose已验证；部分形状对未被本凸包窄路径覆盖'
    failures.extend(path_failures.values())
    result['pairs']=[pairs[identity] for identity in sorted(pairs)][:16]
    result['status']='OVERLAP' if pairs else 'UNVERIFIED' if failures else 'CLEAR'
    reasons=['其它PhysX overlap_shape命中仍无穿透距离，depthM=null；仅当前静态cooked凸包/原生Plane以全部顶点支持函数分离接触与穿透，保护带内保持未知']
    reasons.extend(measured[:8])
    if failures:
        reasons.extend(failures[:3])
    if len(pairs)>16:
        reasons.append('共'+str(len(pairs))+'对，展示前16对')
    result['reason']='；'.join(reasons)
    return result
