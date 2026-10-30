"""依据实际GLB鞋部skin，拟合骨局部内接足capsule；不改根、其它12段、mask或物理dt。"""
import sys,json,struct,hashlib,argparse,copy
from pathlib import Path
import numpy as np
from rocketbox_shoe_selection import lowest_shoe_component
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'sim-mujoco'/'python'));import human as h
p=argparse.ArgumentParser();p.add_argument('--assets',required=True);p.add_argument('--avatar',default='Male_Adult_04');p.add_argument('--shoe-selection',choices=['weighted','lowest-component'],default='weighted');args=p.parse_args();root=Path(args.assets);path=root/(args.avatar+'-Grounded.glb');data=path.read_bytes();length=struct.unpack_from('<I',data,12)[0];g=json.loads(data[20:20+length]);binary=data[28+length:];cfg=json.loads((root/'definition.json').read_text());cfg['_poseRuntime']=h.compile_pose(cfg);source=json.loads((root/'source.json').read_text());angle=source['headingOffsetRad'];conversion=h.mul(np.array([np.cos(angle/2),0,0,np.sin(angle/2)]),np.array([np.cos(np.pi/4),np.sin(np.pi/4),0,0]));c=np.empty(9);h.mj.mju_quat2Mat(c,conversion);c=c.reshape(3,3)
def rotation(q):
 a=np.empty(9);h.mj.mju_quat2Mat(a,q);return a.reshape(3,3)
def accessor(i):
 a=g['accessors'][i];v=g['bufferViews'][a['bufferView']];n={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}[a['type']];dtype=np.dtype({5121:'u1',5123:'<u2',5125:'<u4',5126:'<f4'}[a['componentType']]);values=np.ndarray((a['count'],n),dtype=dtype,buffer=binary,offset=v.get('byteOffset',0)+a.get('byteOffset',0),strides=(v.get('byteStride',dtype.itemsize*n),dtype.itemsize)).copy()
 if a.get('normalized'):values=values/np.iinfo(dtype).max
 return values
parents={child:i for i,node in enumerate(g['nodes'])for child in node.get('children',[])};world={}
def matrix(i):
 if i in world:return world[i]
 node=g['nodes'][i]
 if 'matrix'in node:m=np.asarray(node['matrix']).reshape(4,4,order='F')
 else:
  m=np.eye(4);m[:3,:3]=rotation(h.wxyz(node.get('rotation',[0,0,0,1])))@np.diag(node.get('scale',[1,1,1]));m[:3,3]=node.get('translation',[0,0,0])
 if i in parents:m=matrix(parents[i])@m
 world[i]=m;return m
skin=g['skins'][0];names=[g['nodes'][i]['name']for i in skin['joints']];inverse=[row.reshape(4,4,order='F').astype(float)for row in accessor(skin['inverseBindMatrices'])];scales=[np.linalg.norm(matrix(i)[:3,:3],axis=0)for i in skin['joints']];positions=[];joints=[];weights=[];triangles=[];vertex_offset=0
for primitive in g['meshes'][0]['primitives']:
 a=primitive['attributes'];count=len(accessor(a['POSITION']));indices=accessor(primitive['indices']).reshape(-1)if'indices'in primitive else np.arange(count);triangles.extend((indices.reshape(-1,3)+vertex_offset).tolist());vertex_offset+=count;positions.append(accessor(a['POSITION']));joints.append(accessor(a['JOINTS_0']).astype(int));weights.append(accessor(a['WEIGHTS_0']))
positions=np.vstack(positions);positions=np.c_[positions,np.ones(len(positions))];joints=np.vstack(joints);weights=np.vstack(weights);foot_ids={}
for side in ['L','R']:
 mask=np.array([name.startswith('Bip01 '+side+' Foot')or name.startswith('Bip01 '+side+' Toe')for name in names]);foot_ids[side]=np.flatnonzero(np.sum(weights*mask[joints],axis=1)>.8)
def geometry(pose):
 matrices=[]
 for i,name in enumerate(names):
  position,q=pose[name];m=np.eye(4);m[:3,:3]=rotation(h.mul(q,conversion))@np.diag(scales[i]);m[:3,3]=position;matrices.append(m@inverse[i])
 matrices=np.asarray(matrices);points=np.zeros((len(positions),3))
 for slot in range(4):points+=np.einsum('nij,nj->ni',matrices[joints[:,slot]],positions)[:,:3]*weights[:,slot,None]
 return points
rest=h.pose(cfg,np.zeros(3),np.array([1.,0,0,0]));rest_vertices=geometry(rest);shoe_selection={};samples=[]
if args.shoe_selection=='lowest-component':
 for side in ['L','R']:foot_ids[side],shoe_selection[side]=lowest_shoe_component(positions,triangles,foot_ids[side],rest_vertices)
for name in ['Idle','Walk','WalkGrounded']:
 clip=next(x for x in cfg['clips']if x['name']==name);clean={**cfg,'clips':[{**clip,'durationS':clip['durationS']+1,'rootMotion':None}]};clean['_poseRuntime']=h.compile_pose(clean)
 for t in np.linspace(0,clip['durationS'],65):
  pose=h.pose(clean,np.zeros(3),np.array([1.,0,0,0]),t,'walk',source['walkSpeedMps'],name);samples.append((name,float(t),pose,geometry(pose)))
calibration={};reports={}
for side,role in [('L','left'),('R','right')]:
 name=cfg['boneMapping'][role+'Ankle'];position,q=rest[name];r=rotation(q);points=(rest_vertices[foot_ids[side]]-position)@r;centered=points-points.mean(axis=0);values,basis=np.linalg.eigh(centered.T@centered);basis=basis[:,::-1];projected=points@basis;low,high=projected.min(axis=0),projected.max(axis=0);center=((low+high)/2)@basis.T;axis=basis[:,0];radius=float(min((high-low)[1:])*.5*.85);half=max(.005,float((high-low)[0]*.5-radius));before=radius;bounds=[]
 for clip,t,pose,mesh in samples:
  p,q=pose[name];r=rotation(q);a=p+r@(center-axis*half);b=p+r@(center+axis*half);sole=float(np.min(mesh[foot_ids[side],2]));bounds.append((clip,t,float(min(a[2],b[2])-sole),sole))
 radius=min(radius,min(row[2]for row in bounds));assert .003<radius<.15,(side,radius);a=center-axis*half;b=center+axis*half;key=role+'Ankle-'+role+'Toe';calibration[key]={'frameJoint':name,'endpointsM':[(c.T@a).tolist(),(c.T@b).tolist()],'radiusM':radius};reports[side]={'shoeVertices':len(points),'localBoundsM':np.c_[low,high].tolist(),'pcaBasis':basis.tolist(),'sourceGeometryRadiusM':before,'fittedRadiusM':radius,'halfLengthM':half,'minProxyMinusSoleM':min(row[2]-radius for row in bounds),'minBottomWorldZM':min(row[2]+row[3]-radius for row in bounds),'perClip':{clip:{'minBottomWorldZM':min(support+sole-radius for name,t,support,sole in bounds if name==clip),'minVisualSoleWorldZM':min(sole for name,t,support,sole in bounds if name==clip)}for clip in ['Idle','Walk','WalkGrounded']}}
g.setdefault('asset',{}).setdefault('extras',{})['lyapunovHumanFootCapsules']={'schema':1,'sourceSha256':hashlib.sha256(data).hexdigest(),'method':'原GLB鞋部skin顶点PCA内接capsule；Idle/Walk/WalkGrounded原骨姿态支撑下界验证','segments':calibration};encoded=json.dumps(g,separators=(',',':')).encode();encoded+=b' '*((-len(encoded))%4);new=struct.pack('<III',0x46546c67,2,28+len(encoded)+len(binary))+struct.pack('<II',len(encoded),0x4e4f534a)+encoded+struct.pack('<II',len(binary),0x004e4942)+binary;output=root/(args.avatar+'-Grounded-Calibrated.glb');output.write_bytes(new);report={'sourceSha256':hashlib.sha256(data).hexdigest(),'sha256':hashlib.sha256(new).hexdigest(),'bytes':len(new),'segments':calibration,'evidence':reports,'shoeSelection':{'mode':args.shoe_selection,'sides':shoe_selection}};(root/'foot-calibration.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False))
