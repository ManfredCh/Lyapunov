"""明确三角面意图的源几何消费校验；无SDK步进、无派生或引擎切换。"""
from pathlib import Path
from urllib.parse import urlparse,unquote
import numpy as np

MAX_VERTEX_FACE_WORK=20_000_000
MAX_VERTICES=4096
MAX_FACES=8192

def convex_surface(path,error,eid):
    """由真实OBJ闭合有向边与全部face支持半空间证明凸性；预算不足不猜。"""
    location=Path(path)
    if location.suffix.lower()!='.obj':raise error('MUJOCO_TRIANGLE_CONVEXITY_UNVERIFIED',eid+' 明确三角面需本地OBJ源拓扑验证；未退回凸包')
    points=[];faces=[]
    try:
        with location.open(encoding='utf-8')as stream:
            for line in stream:
                fields=line.split()
                if not fields:continue
                if fields[0]=='v':
                    if len(fields)<4:raise ValueError('顶点缺三个坐标')
                    points.append([float(v)for v in fields[1:4]])
                    if len(points)>MAX_VERTICES:raise error('MUJOCO_TRIANGLE_CONVEXITY_UNVERIFIED',eid+' 源凸性校验超过4096顶点预算；未以bbox或凸包猜原表面')
                elif fields[0]=='f':
                    values=[int(v.split('/')[0])for v in fields[1:]]
                    face=[v-1 if v>0 else len(points)+v for v in values]
                    if len(face)!=3 or any(i<0 or i>=len(points)for i in face):raise ValueError('明确triangle_mesh需有效三角索引')
                    faces.append(face)
                    if len(faces)>MAX_FACES:raise error('MUJOCO_TRIANGLE_CONVEXITY_UNVERIFIED',eid+' 源凸性校验超过8192面预算；未退回凸包')
    except FileNotFoundError as exc:raise error('COLLISION_MESH_NOT_FOUND',eid+' 碰撞网格不存在：'+str(location))from exc
    except (OSError,UnicodeError,ValueError)as exc:raise error('COLLISION_MESH_INVALID',eid+' 三角源无法解析：'+str(exc))from exc
    vertices=np.asarray(points,dtype=float)
    if len(points)<4 or not faces or not np.isfinite(vertices).all():raise error('MUJOCO_TRIANGLE_SURFACE_UNSUPPORTED',eid+' 原表面缺可靠闭合三维凸体；普通mesh会填实开放面')
    if len(points)*len(faces)>MAX_VERTEX_FACE_WORK:raise error('MUJOCO_TRIANGLE_CONVEXITY_UNVERIFIED',eid+' 原表面凸性校验超过有界预算；未退凸')
    edges={}
    for face in faces:
        if len(set(face))!=3:raise error('COLLISION_MESH_INVALID',eid+' 源三角面有重复顶点索引')
        for a,b in zip(face,face[1:]+face[:1]):
            key=(min(a,b),max(a,b));count,orientation=edges.get(key,(0,0));edges[key]=(count+1,orientation+(1 if a<b else -1))
    if any(count!=2 or orientation!=0 for count,orientation in edges.values()):raise error('MUJOCO_TRIANGLE_SURFACE_UNSUPPORTED',eid+' 明确原三角表面未闭合或边方向不一致；Mu普通mesh不能保开放面/孔洞，不自动切引擎')
    span=float(np.max(np.ptp(vertices,axis=0)));tolerance=max(span*1e-7,1e-9)
    if np.linalg.matrix_rank(vertices-vertices.mean(axis=0),tol=tolerance)<3:raise error('MUJOCO_TRIANGLE_SURFACE_UNSUPPORTED',eid+' 源三角表面没有三维体积，普通mesh不能精确消费开放表面')
    for index,face in enumerate(faces):
        a,b,c=vertices[face];normal=np.cross(b-a,c-a);length=float(np.linalg.norm(normal))
        if length<=tolerance*tolerance:raise error('MUJOCO_TRIANGLE_CONVEXITY_UNVERIFIED',eid+' 源有退化面 '+str(index)+'；未猜凸性')
        distances=(vertices-a)@(normal/length)
        if float(distances.min()) < -tolerance and float(distances.max()) > tolerance:raise error('MUJOCO_TRIANGLE_SURFACE_UNSUPPORTED',eid+' 源三角面 '+str(index)+' 的两侧均有源顶点，实际非凸；Mu普通mesh会封孔，需明确其他可支持表示')
    if span<=tolerance:raise error('MUJOCO_TRIANGLE_CONVEXITY_UNVERIFIED',eid+' 源表面退化；未猜闭合凸体')
    return {'status':'SUPPORTED_CONVEX_EQUIVALENT','vertices':len(points),'triangles':len(faces),'proof':'closed-oriented-edges-and-supporting-face-halfspaces'}

def validate_exact_triangle_surfaces(scene,error):
    for entity in scene.get('entities',[]):
        components=entity.get('components')or{};collision=components.get('collision')or{};binding=components.get('physicsBinding')or{}
        if collision.get('shape',collision.get('type'))!='mesh' or binding.get('strategy')!='triangle_mesh':continue
        eid=entity['entityId'];samples=binding.get('pointCloud')or[]
        if not isinstance(samples,list):raise error('MUJOCO_TRIANGLE_CONVEXITY_UNVERIFIED',eid+' pointCloud来源回执结构无效；未退凸')
        if any(isinstance(row,dict)and row.get('processing')=='full-spatial-voxel-surface'and row.get('coverage')=='full-measured-sample-voxel-boundary'for row in samples):
            raise error('MUJOCO_SAMPLED_SURFACE_UNSUPPORTED',eid+' 明确采样占据体素union边界要求原三角面；Mu普通mesh会凸化，当前只Isaac明确static none可消费，不自动切引擎')
        parts=collision.get('parts')
        if not isinstance(parts,list)or not parts:raise error('INVALID_ARGUMENT',eid+' 明确三角表面缺真实parts')
        for part in parts:
            if not isinstance(part,str):raise error('INVALID_ARGUMENT',eid+' 三角parts必须是本地路径/URI')
            parsed=urlparse(part)
            if parsed.scheme and(parsed.scheme!='file'or parsed.netloc not in ('','localhost')):raise error('INVALID_ARGUMENT',eid+' 三角parts必须是本地文件')
            convex_surface(unquote(parsed.path)if parsed.scheme=='file'else part,error,eid)
