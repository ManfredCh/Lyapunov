"""把Blender足锁的skin世界矩阵转回原始GLB骨参考基，只追加动作，不重导出原六clip/网格/材质。"""
import sys,json,struct,copy,argparse,hashlib
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'sim-mujoco'/'python'));import human as h
p=argparse.ArgumentParser();p.add_argument('--original',required=True);p.add_argument('--baked',required=True);p.add_argument('--out',required=True);p.add_argument('--avatar',default='Male_Adult_04');args=p.parse_args();out=Path(args.out);a_bytes=Path(args.original).read_bytes();b_bytes=Path(args.baked).read_bytes()
def decode(data):
 length=struct.unpack_from('<I',data,12)[0];return json.loads(data[20:20+length]),data[28+length:]
a,abin=decode(a_bytes);b,bbin=decode(b_bytes)
def accessor(g,blob,i):
 ac=g['accessors'][i];v=g['bufferViews'][ac['bufferView']];n={'SCALAR':1,'VEC3':3,'VEC4':4,'MAT4':16}[ac['type']];return np.ndarray((ac['count'],n),dtype='<f4',buffer=blob,offset=v.get('byteOffset',0)+ac.get('byteOffset',0),strides=(v.get('byteStride',n*4),4)).copy()
def rot(q):
 m=np.empty(9);h.mj.mju_quat2Mat(m,q);return m.reshape(3,3)
def scales(g):
 parents={child:i for i,node in enumerate(g['nodes'])for child in node.get('children',[])};cache={}
 def scale(i):
  if i in cache:return cache[i]
  n=g['nodes'][i];value=float(np.mean(np.linalg.norm(np.asarray(n['matrix']).reshape(4,4,order='F')[:3,:3],axis=0)))if'matrix'in n else float(np.mean(n.get('scale',[1,1,1])));cache[i]=value*(scale(parents[i])if i in parents else 1.);return cache[i]
 return parents,{i:scale(i)for i in range(len(g['nodes']))}
a_parents,a_scales=scales(a);_,b_scales=scales(b);a_skin=a['skins'][0];b_skin=b['skins'][0];a_ibm={a['nodes'][i]['name']:m.reshape(4,4,order='F').astype(float)for i,m in zip(a_skin['joints'],accessor(a,abin,a_skin['inverseBindMatrices']))};b_ibm={b['nodes'][i]['name']:m.reshape(4,4,order='F').astype(float)for i,m in zip(b_skin['joints'],accessor(b,bbin,b_skin['inverseBindMatrices']))};b_indices={node['name']:i for i,node in enumerate(b['nodes'])if'name'in node};a_cfg=json.loads((out/'original-definition.json').read_text());b_cfg=json.loads((out/'baked-definition.json').read_text());original_walk=next(c for c in a_cfg['clips']if c['name']=='Walk');b_walk=next(c for c in b_cfg['clips']if c['name']=='WalkGrounded');a_cfg={**a_cfg,'clips':[{**original_walk,'durationS':original_walk['durationS']+1,'rootMotion':None}]};b_cfg={**b_cfg,'clips':[{**b_walk,'durationS':b_walk['durationS']+1,'rootMotion':None}]};a_cfg['_poseRuntime']=h.compile_pose(a_cfg);b_cfg['_poseRuntime']=h.compile_pose(b_cfg);angle=a_cfg['source']['headingOffsetRad'];conversion=h.mul(np.array([np.cos(angle/2),0,0,np.sin(angle/2)]),np.array([np.cos(np.pi/4),np.sin(np.pi/4),0,0]));inverse_c=conversion*np.array([1,-1,-1,-1]);times_cache={};inverse_a={name:np.linalg.inv(m)for name,m in a_ibm.items()}
def sample(t):
 if t in times_cache:return times_cache[t]
 base=h.pose(a_cfg,np.zeros(3),np.array([1.,0,0,0]),t,'walk',1.,'Walk');baked=h.pose(b_cfg,np.zeros(3),np.array([1.,0,0,0]),t,'walk',1.,'WalkGrounded');desired=dict(base)
 for name,ibm in a_ibm.items():
  p,q=baked[name];m=np.eye(4);m[:3,:3]=rot(h.mul(q,conversion))*b_scales[b_indices[name]];m[:3,3]=p;target=m@b_ibm[name]@inverse_a[name];orientation=target[:3,:3]/np.linalg.norm(target[:3,:3],axis=0);quat=np.empty(4);h.mj.mju_mat2Quat(quat,np.ascontiguousarray(orientation).reshape(-1));desired[name]=(target[:3,3],h.mul(quat,inverse_c))
 times_cache[t]=desired;return desired
binary=bytearray(abin)
def append(values,size):
 while len(binary)%4:binary.append(0)
 offset=len(binary);value=np.asarray(values,dtype='<f4');binary.extend(value.tobytes());view=len(a['bufferViews']);a['bufferViews'].append({'buffer':0,'byteOffset':offset,'byteLength':value.nbytes});index=len(a['accessors']);a['accessors'].append({'bufferView':view,'componentType':5126,'count':len(values),'type':{3:'VEC3',4:'VEC4'}[size]});return index
animation=copy.deepcopy(next(c for c in a['animations']if c['name']=='Walk'));animation['name']='WalkGrounded'
for channel in animation['channels']:
 kind=channel['target']['path']
 if kind=='scale':continue
 node=channel['target']['node'];name=a['nodes'][node]['name'];parent=a_parents.get(node);parent_name=a['nodes'][parent]['name']if parent is not None else None;sampler=animation['samplers'][channel['sampler']];times=accessor(a,abin,sampler['input'])[:,0];values=[]
 for time in times:
  pose=sample(float(time));p,q=pose[name];pp,pq=pose[parent_name]if parent_name else(np.zeros(3),np.array([1.,0,0,0]));inverse=pq*np.array([1,-1,-1,-1])
  if kind=='rotation':local=h.mul(inverse,q);source=h.mul(inverse_c,h.mul(local,conversion));values.append(source[[1,2,3,0]])
  else:values.append(h.rotate(inverse_c,h.rotate(inverse,p-pp))/(a_scales[parent]if parent is not None else 1.))
 sampler['output']=append(values,4 if kind=='rotation'else 3)
a['animations'].append(animation);a['buffers'][0]['byteLength']=len(binary);assert bytes(binary[:len(abin)])==abin;assert a['animations'][:-1]==decode(a_bytes)[0]['animations'];encoded=json.dumps(a,separators=(',',':')).encode();encoded+=b' '*((-len(encoded))%4);data=struct.pack('<III',0x46546c67,2,28+len(encoded)+len(binary))+struct.pack('<II',len(encoded),0x4e4f534a)+encoded+struct.pack('<II',len(binary),0x004e4942)+binary;target=out/(args.avatar+'-Grounded.glb');target.write_bytes(data);report={'originalSha256':hashlib.sha256(a_bytes).hexdigest(),'bakedSha256':hashlib.sha256(b_bytes).hexdigest(),'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'originalBinPrefixUnchanged':True,'originalAnimationObjectsUnchanged':True,'originalMeshMaterialSkinNodeObjectsUnchanged':all(a[k]==decode(a_bytes)[0][k]for k in ['meshes','materials','skins','nodes']),'derivedClip':'WalkGrounded','sampleTimes':len(times_cache),'retarget':'用skin逆绑定矩阵恢复原骨局部参考基；只追加原骨架上的派生动作'};(out/'grounded-retarget.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False))
