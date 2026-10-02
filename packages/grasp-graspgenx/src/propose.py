"""GraspGenX 独立 ZMQ 候选；保留真实来源，不调用规划单体和解析 fallback。"""
import json,os,sys,math
from runtime import resolve_endpoint
import numpy as np
import zmq,msgpack,msgpack_numpy
msgpack_numpy.patch()
COUNTS_PROTOCOL = 'nvlabs-graspgenx-b9429097-lyapunov-adapter-v2'
LEGACY_COUNTS_PROTOCOL = 'nvlabs-graspgenx-b9429097-lyaup-adapter-v2'

def candidate_counts(raw, maximum, include_counts):
    """rawCount仍是进入DSH过滤的数组数；旧v1没有cap前计数，准确返回未知。"""
    received=len(raw['grasps'])
    if type(raw.get('num_grasps')) is not int or raw['num_grasps']!=received or received>maximum:
        raise ValueError('PROVIDER_INVALID: 候选数与实际数组或maxCandidates不一致')
    if not include_counts: return received,None
    counts=raw.get('counts')
    if (not isinstance(counts,dict) or set(counts)!={'upstream_raw_count','returned_count'}
        or type(counts['upstream_raw_count']) is not int or type(counts['returned_count']) is not int
        or counts['returned_count']!=received or counts['upstream_raw_count']<received):
        raise ValueError('PROVIDER_INVALID: v2候选计数缺失或不一致')
    return received,counts['upstream_raw_count']

def quat_xyzw(r):
    # 旋转矩阵转四元数，不额外加载物理引擎。
    k=np.array([[r[0,0]-r[1,1]-r[2,2],r[1,0]+r[0,1],r[2,0]+r[0,2],r[2,1]-r[1,2]], [r[1,0]+r[0,1],r[1,1]-r[0,0]-r[2,2],r[2,1]+r[1,2],r[0,2]-r[2,0]], [r[2,0]+r[0,2],r[2,1]+r[1,2],r[2,2]-r[0,0]-r[1,1],r[1,0]-r[0,1]], [r[2,1]-r[1,2],r[0,2]-r[2,0],r[1,0]-r[0,1],r.trace()]])/3
    _,v=np.linalg.eigh(k); q=v[:,-1]; return (q if q[3]>=0 else -q).tolist()

def propose(request):
    if request.get('gripper','franka_panda')!='franka_panda': raise ValueError('UNSUPPORTED_CAPABILITY: GraspGenX 当前绑定仅为 franka_panda')
    missing=[key for key in ('pointCloudPath','entityId','frameId') if key not in request]
    if missing: raise ValueError('INVALID_INPUT: 缺少必需字段: '+', '.join(missing))
    with open(request['pointCloudPath']) as source: points=np.asarray(json.load(source),dtype=np.float32)
    if points.shape!=(2048,3) or not np.isfinite(points).all(): raise ValueError('pointCloud 必须为米制 float32 (2048,3)')
    maximum=request.get('maxCandidates',100)
    if type(maximum) is not int or not 1<=maximum<=200: raise ValueError('maxCandidates 必须为1..200整数')
    context=zmq.Context(); sock=context.socket(zmq.REQ); timeout=request.get('timeoutMs',120000); sock.setsockopt(zmq.LINGER,0); sock.setsockopt(zmq.SNDTIMEO,timeout); sock.setsockopt(zmq.RCVTIMEO,timeout)
    try:
      sock.connect(request.get('endpoint') or resolve_endpoint())
      def rpc(payload):
        sock.send(msgpack.packb(payload,use_bin_type=True)); result=msgpack.unpackb(sock.recv(),raw=False)
        if 'error' in result: raise RuntimeError('PROVIDER_ERROR: '+str(result['error']))
        return result
      metadata=rpc({'action':'metadata'})
      if metadata.get('gripper_name')!='franka_panda' or 'graspgenx' not in metadata.get('provider_version','').lower(): raise ValueError('PROVIDER_IDENTITY_MISMATCH')
      # 接受旧 worker 的协议回执，但新 worker 应返回 LYAPUNOV 命名。
      include_counts=metadata.get('protocol_revision') in {COUNTS_PROTOCOL,LEGACY_COUNTS_PROTOCOL}
      infer_request={'action':'infer','point_cloud':np.ascontiguousarray(points),'grasp_threshold':request.get('scoreThreshold',0.),'num_grasps':200,'topk_num_grasps':maximum,'min_grasps':1,'max_tries':1,'remove_outliers':True}
      if include_counts: infer_request['include_counts']=True
      raw=rpc(infer_request)
    finally: sock.close(); context.term()
    raw_count,upstream_raw_count=candidate_counts(raw,maximum,include_counts)
    candidates=[]; rejects={'invalidPose':0,'tooWide':0}; depth=request.get('referenceDepthM',.1034)
    for i,(pose,score) in enumerate(zip(raw['grasps'],raw['confidences'])):
      pose=np.asarray(pose); r=pose[:3,:3]
      if pose.shape!=(4,4) or not np.isfinite(pose).all() or not np.allclose(r.T@r,np.eye(3),atol=1e-4) or abs(np.linalg.det(r)-1)>1e-4: rejects['invalidPose']+=1; continue
      closing=r[:,0]; approach=r[:,2]; projection=points@closing; width=float(np.ptp(projection))+.008
      if width>request.get('maxWidthM',.08): rejects['tooWide']+=1; continue
      tcp=pose[:3,3]+depth*approach; tcp+=((float(projection.min())+float(projection.max()))/2-float(tcp@closing))*closing
      # Panda TCP 的闭合轴为本地 Y；模型抓点的闭合轴为 X。仅此处转换一次。
      tcp_r=np.column_stack((np.cross(closing,approach),closing,approach))
      candidates.append({'candidateId':f'graspgenx-{i}','provider':'graspgenx','entityId':request['entityId'],'frameId':request['frameId'],'tcpPose':{'position':tcp.tolist(),'quaternion':quat_xyzw(tcp_r)},'widthM':width,'approach':approach.tolist(),'score':float(score),'scoreKind':'graspgenx-discriminator'})
    candidates.sort(key=lambda c:c['score'],reverse=True)
    return {'provider':'graspgenx','candidates':candidates,'noSolution':not candidates,'rawCount':raw_count,'upstreamRawCount':upstream_raw_count,'returnedCount':len(candidates),'rejections':rejects,'metadata':{k:metadata[k] for k in ['provider_version','protocol_revision','source_commit','model_revision','gripper_revision'] if k in metadata},'timing':raw.get('timing'),'tcpConvention':'Panda gripper center; local +Y closing, +Z approach; reference depth 0.1034m'}

if __name__=='__main__':
    try: print(json.dumps(propose(json.load(sys.stdin)),allow_nan=False))
    except (ImportError,zmq.Again) as e: print(json.dumps({'error':'PROVIDER_UNAVAILABLE','message':str(e)})); sys.exit(2)
    except Exception as e: print(json.dumps({'error':type(e).__name__,'message':str(e)})); sys.exit(2 if str(e).startswith('PROVIDER_UNAVAILABLE') else 1)
