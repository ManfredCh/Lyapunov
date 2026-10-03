"""只读已装配PhysX/CollisionAPI形状；mesh使用官方cooked representation，不用视觉bbox。"""
import math
from pxr import Gf,Usd,UsdGeom,UsdPhysics,UsdUtils,PhysicsSchemaTools,PhysxSchema
import omni.physx

def unsupported(reason):return {'kind':'unsupported','sizeM':[0.,0.,0.],'reason':reason}

def cooked_mesh(stage,prim,scale):
    approximation=UsdPhysics.MeshCollisionAPI(prim).GetApproximationAttr().Get()
    if approximation!='convexHull':return [unsupported('PHYSX_COOKED_TOPOLOGY_UNAVAILABLE: 实际mesh approximation='+str(approximation)+'；凸读回不能代表原生三角面')]
    values={}
    def received(result,meshes):
        values['result']=int(result);values['meshes']=meshes
    cooking=omni.physx.get_physx_cooking_interface()
    if not hasattr(cooking,'request_convex_collision_representation'):return [unsupported('PHYSX_COOKED_TOPOLOGY_UNAVAILABLE: SDK没有已编译凸碰撞读回接口')]
    cooking.request_convex_collision_representation(UsdUtils.StageCache.Get().Insert(stage).ToLongInt(),PhysicsSchemaTools.sdfPathToInt(prim.GetPath()),False,received)
    if values.get('result')!=0:return [unsupported('PHYSX_COOKED_TOPOLOGY_UNAVAILABLE: 官方凸碰撞读回结果 '+str(values.get('result','not-ready')))]
    result=[]
    for mesh in values.get('meshes',[]):
        vertices=list(mesh.vertices);indices=list(mesh.indices);polygons=list(mesh.polygons)
        if len(vertices)>20000 or len(indices)>60000:return [unsupported('COLLIDER_GEOMETRY_BUDGET: 单形状超出预览预算')]
        points=[float(v[i])*scale[i] for v in vertices for i in range(3)];triangles=[]
        for polygon in polygons:
            base=int(polygon.index_base);count=int(polygon.num_vertices)
            for i in range(1,count-1):triangles.extend([int(indices[base]),int(indices[base+i]),int(indices[base+i+1])])
        if not points or not triangles:return [unsupported('PHYSX_COOKED_TOPOLOGY_EMPTY: 官方结果没有凸面拓扑')]
        result.append({'kind':'convex-hull','sizeM':[0.,0.,0.],'vertices':points,'indices':triangles})
    return result or [unsupported('PHYSX_COOKED_TOPOLOGY_EMPTY: 无已编译凸件')]

def geometry(stage,prim,scale):
    if str(prim.GetTypeName())=='Plane':return [{'kind':'plane','sizeM':[0.,0.,0.],'infinite':True,'axis':str(prim.GetAttribute('axis').Get()or'Z')}]
    if prim.IsA(UsdGeom.Cube):
        size=float(UsdGeom.Cube(prim).GetSizeAttr().Get());return [{'kind':'box','sizeM':[size*abs(s)/2 for s in scale]}]
    if prim.IsA(UsdGeom.Sphere):
        radius=float(UsdGeom.Sphere(prim).GetRadiusAttr().Get())
        return [{'kind':'sphere' if max(scale)-min(scale)<1e-7 else 'ellipsoid','sizeM':[radius*abs(s) for s in scale]}]
    for cls,kind in [(UsdGeom.Capsule,'capsule'),(UsdGeom.Cylinder,'cylinder')]:
        if prim.IsA(cls):
            shape=cls(prim);axis=str(shape.GetAxisAttr().Get());along={'X':0,'Y':1,'Z':2}[axis];radial=[i for i in range(3)if i!=along]
            if abs(scale[radial[0]]-scale[radial[1]])>1e-7:return [unsupported('COLLIDER_NONUNIFORM_RADIUS: 当前胶囊/柱读回不把椭圆截面当圆')]
            return [{'kind':kind,'sizeM':[float(shape.GetRadiusAttr().Get())*abs(scale[radial[0]]),float(shape.GetHeightAttr().Get())*abs(scale[along])/2,0.],'axis':axis}]
    if prim.IsA(UsdGeom.Mesh):return cooked_mesh(stage,prim,scale)
    return [unsupported('COLLIDER_SHAPE_UNSUPPORTED: '+str(prim.GetTypeName()))]

def collision_topology(world,selection,rendering=False):
    ids=selection.get('entityIds',[])
    if not isinstance(ids,list)or not ids or len(ids)>512 or any(not isinstance(i,str)or not i for i in ids):raise ValueError('COLLISION_SELECTION_INVALID')
    include=selection.get('includeGeometry',True);chosen=set(ids);rows=[]
    for eid in sorted(chosen):
        e=world.entities.get(eid)
        if e and e.get('path'):
            root=world.stage.GetPrimAtPath(e['path'])
            rows.extend((p,eid,False)for p in Usd.PrimRange(root,Usd.TraverseInstanceProxies())if p.HasAPI(UsdPhysics.CollisionAPI))
    ground=world.stage.GetPrimAtPath('/World/ground')
    if ground and ground.IsValid():rows.extend((p,None,True)for p in Usd.PrimRange(ground)if p.HasAPI(UsdPhysics.CollisionAPI))
    unique={str(p.GetPath()):(p,eid,is_ground)for p,eid,is_ground in rows};rows=[unique[p]for p in sorted(unique)]
    cache_key=(world.generation,world.revision)
    if getattr(world,'_topology_cache_key',None)!=cache_key:world._topology_cache_key=cache_key;world._topology_shapes={};world._topology_ids={}
    transforms=UsdGeom.XformCache();geoms=[];omitted=0;points=0
    for prim,eid,is_ground in rows:
        if len(geoms)>=256:omitted+=1;continue
        path=str(prim.GetPath());matrix=transforms.GetLocalToWorldTransform(prim);transform=Gf.Transform(matrix);scale=list(transform.GetScale());rotation=matrix.RemoveScaleShear().ExtractRotationQuat();position=list(matrix.ExtractTranslation());q=[*list(rotation.GetImaginary()),float(rotation.GetReal())]
        # CPU PhysX当前step已写回USD；RTX走Fabric，此首版不给旧USD位姿冒充实时形状。
        if rendering:shapes=[unsupported('ISAAC_RTX_COLLIDER_POSE_UNAVAILABLE: 需Fabric当前step位姿读回，不使用旧USD变换')]
        elif path not in world._topology_shapes:
            try:world._topology_shapes[path]=geometry(world.stage,prim,scale)
            except Exception as error:world._topology_shapes[path]=[unsupported('PHYSX_COLLIDER_READBACK_FAILED: '+type(error).__name__+': '+str(error))]
            shapes=world._topology_shapes[path]
        else:shapes=world._topology_shapes[path]
        for part,shape in enumerate(shapes):
            count=len(shape.get('vertices',[]));points+=count
            if points>150000 or len(geoms)>=256:omitted+=1;continue
            key=(path,part)
            if key not in world._topology_ids:world._topology_ids[key]=len(world._topology_ids)
            axis=shape.get('axis','Z')
            if axis!='Z':
                correction=Gf.Rotation(Gf.Vec3d(0,0,1),Gf.Vec3d(1,0,0)if axis=='X' else Gf.Vec3d(0,1,0)).GetQuat();product=rotation*correction;q=[*list(product.GetImaginary()),float(product.GetReal())]
            if not all(math.isfinite(float(v))for v in [*position,*q,*scale]):raise ValueError('COLLIDER_POSE_INVALID')
            api=UsdPhysics.CollisionAPI(prim);enabled=api.GetCollisionEnabledAttr().Get();row={'geomId':world._topology_ids[key],'name':(eid+'/' if eid else '')+prim.GetName()+(':'+str(part)if len(shapes)>1 else ''),'ground':is_ground,'positionM':[float(v)for v in position],'quaternionXyzw':q,'collisionEnabled':enabled is not False}
            if prim.HasAPI(UsdPhysics.FilteredPairsAPI):row['filteredPairs']=[str(p)for p in UsdPhysics.FilteredPairsAPI(prim).GetFilteredPairsRel().GetTargets()][:128]
            if prim.HasAPI(PhysxSchema.PhysxCollisionAPI):
                collider=PhysxSchema.PhysxCollisionAPI(prim)
                for key,attr in [('contactOffsetM',collider.GetContactOffsetAttr()),('restOffsetM',collider.GetRestOffsetAttr())]:
                    value=attr.Get()
                    if value is not None and math.isfinite(float(value)) and float(value)>=0:row[key]=float(value)
            ancestor=prim
            while ancestor and ancestor.IsValid():
                if ancestor.HasAPI(UsdPhysics.RigidBodyAPI):row['dynamic']=UsdPhysics.RigidBodyAPI(ancestor).GetRigidBodyEnabledAttr().Get()is not False;break
                ancestor=ancestor.GetParent()
            if 'dynamic'not in row:row['dynamic']=False
            if eid:row['entityId']=eid
            if include:row['geometry']={k:v for k,v in shape.items()if k!='axis'}
            geoms.append(row)
    return {'source':'isaac-compiled','worldId':world.id,'generation':world.generation,'sceneRevision':world.revision,'stepIndex':world.index,'geoms':geoms,'geometryIncluded':bool(include),'omitted':omitted}
