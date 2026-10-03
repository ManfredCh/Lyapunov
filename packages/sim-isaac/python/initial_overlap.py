"""使用同世界PhysX的实际GPrim查询；不执行step，不用bbox替代几何相交。"""
from pxr import Usd, UsdGeom, UsdPhysics, PhysicsSchemaTools
import omni.physx

def initial_overlap(world, maximum_shapes=2048):
    result={'source':'isaac-scene-query','checkedAtStep':world.index,'sceneRevision':world.revision,'status':'UNVERIFIED','pairs':[]}
    if world.index != 0 or not world.timeline.is_playing():
        result['reason']='初始查询仅在初始化完成且World尚未tick的step0执行'
        return result
    failures=[];pairs={};colliders={}
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
        current_owner=owner(path);self_hit=[False]
        def hit(overlap_hit):
            target=str(overlap_hit.collision)
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
                failures.append(path+' 查询未确认自身collider；初始化数据或pose未验证')
        except Exception as error:
            failures.append(path+' 原生shape查询失败：'+str(error))
    result['pairs']=[pairs[identity] for identity in sorted(pairs)][:16]
    result['status']='OVERLAP' if pairs else 'UNVERIFIED' if failures else 'CLEAR'
    reasons=['PhysX overlap_shape提供真实形状相交；API没有穿透距离，depthM=null，不把0当测量']
    if failures:
        reasons.extend(failures[:3])
    if len(pairs)>16:
        reasons.append('共'+str(len(pairs))+'对，展示前16对')
    result['reason']='；'.join(reasons)
    return result
