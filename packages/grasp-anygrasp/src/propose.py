"""AnyGrasp SDK 适配，缺 SDK/权重/许可证明确阻断。不会调用其他抓取算法。"""
import os,sys,json
from pathlib import Path
from dependencies import require_dependencies

def propose(request):
    state=require_dependencies(request)
    sdk=Path(state['sdkPath']);checkpoint=Path(state['checkpointPath'])
    # SDK按其目录加载license；在改变cwd前解析调用者的所有文件引用。
    point_cloud=Path(request['pointCloudPath']).expanduser().resolve()
    if request.get('gripper','parallel_jaw') not in ['parallel_jaw','franka_panda']: raise ValueError('UNSUPPORTED_CAPABILITY: AnyGrasp parallel jaw only')
    sys.path.insert(0,str(sdk)); os.chdir(sdk)
    import numpy as np
    from scipy.spatial.transform import Rotation
    from argparse import Namespace
    from gsnet import create_detector
    detector=create_detector(Namespace(checkpoint_path=str(checkpoint),max_gripper_width=min(.1,request['maxWidthM']),gripper_height=request.get('gripperHeightM',.03)))
    if detector is None: raise RuntimeError('PROVIDER_UNAVAILABLE: SDK detector creation failed')
    points=np.asarray(json.load(open(point_cloud)),dtype=np.float32)
    if points.ndim!=2 or points.shape[1]!=3 or not np.isfinite(points).all(): raise ValueError('INVALID_POINT_CLOUD')
    group=detector.get_grasp(points,{'dense_grasp':False,'collision_detection':True})
    if group is None: return {'provider':'anygrasp','candidates':[],'noSolution':True}
    group=group.nms().sort_by_score(); result=[]
    for index,g in enumerate(group[:request.get('maxCandidates',100)]):
      # GraspNet: +X approach,+Y jaw；Panda TCP: +Z approach,+Y jaw。
      r=g.rotation_matrix; approach=r[:,0]; closing=r[:,1]; tcp_r=np.column_stack((np.cross(closing,approach),closing,approach))
      position=g.translation+g.depth*approach
      result.append({'candidateId':f'anygrasp-{index}','provider':'anygrasp','entityId':request['entityId'],'frameId':request['frameId'],'tcpPose':{'position':position.tolist(),'quaternion':Rotation.from_matrix(tcp_r).as_quat().tolist()},'widthM':float(g.width),'approach':approach.tolist(),'score':float(g.score),'scoreKind':'anygrasp-sdk'})
    return {'provider':'anygrasp','candidates':result,'noSolution':not result,'sdkAPI':'create_detector/get_grasp','tcpConvention':'Panda +Y jaw,+Z approach; SDK depth applied once'}

if __name__=='__main__':
    try: print(json.dumps(propose(json.load(sys.stdin)),allow_nan=False))
    except (ImportError,RuntimeError) as e: print(json.dumps({'error':'PROVIDER_UNAVAILABLE','message':str(e)}));sys.exit(2)
    except Exception as e: print(json.dumps({'error':type(e).__name__,'message':str(e)}));sys.exit(1)
