/**
 * ISAAC-04 第一项：`camera_list` 的真实接线（假 worker 只实现行协议，不启动 Kit）。
 *
 * 验证三件事：
 *  · provider → 传输层 → worker 的**请求名与返回值原样透传**（不再是 UNSUPPORTED 空壳），以及 worker
 *    明确报错时 provider 如实把错误码/消息带出来（不给空列表冒充“没有相机”）；
 *  · `worker.camera_list` 交出来的**跨引擎消费合同形状**（`cameraName`/`parentBodyName`/`intrinsics`/
 *    `worldFromCamera`/`fovyDeg`/`poseSource`/`referenceResolution`，见
 *    `packages/sim-isaac/python/worker.py` 的 `camera_list`）真的能被 viewer/Shell 那条判据
 *    （`frustumFromReceipt`）吃进去并画成视锥——PAYLOAD 就是对照 worker 的输出现抄的形状；
 *  · 不可用相机只带 `available=false`＋`reason`、**不带位姿/K** ⇒ 判据如实拒绝，UI 也不许勾选它去采集。
 * 真实 Kit/RTX 上的结果见回执 `bugfixHistory/CAMERA-REVIEW-CCDS-20260923.md` 的未验证项
 * （本机没有 isaacsim/pxr，这一层只能到"合同＋编译"）。
 */
import {afterEach, describe, expect, test} from 'bun:test'
import {existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {IsaacProvider} from '../src/provider.ts'
import {frustumFromReceipt} from '../../viewer/src/camera-frustum.ts'
import type {SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'

function systemPython():string|undefined{for(const c of['/usr/bin/python3','/usr/local/bin/python3','/bin/python3'])if(existsSync(c))return c;return undefined}
const PYTHON=systemPython()
let base:string|undefined
const providers:IsaacProvider[]=[]
afterEach(async()=>{for(const provider of providers.splice(0))await provider.dispose().catch(()=>undefined);if(base)rmSync(base,{recursive:true,force:true});base=undefined})

/** 与 `worker.camera_list` 同形：一台可用（带合同）+ 一台被导入层拒绝（只有 reason）。 */
const INTRINSICS={fx:554.2562584220408,fy:554.2562584220408,cx:319.5,cy:239.5,width:640,height:480,fovyDeg:45}
const PAYLOAD={worldId:'w1',generation:1,sceneRevision:0,stepIndex:3,simTime:0.006,rendering:'none',count:2,cameraCount:2,
  cameras:[
    {entityId:'e1',name:'wrist',localName:'wrist',qualifiedName:'e1/wrist',cameraName:'e1/wrist',cameraSource:'mjcf',
      referenceResolution:[640,480],status:'AVAILABLE',path:'/World/entities/e0/wrist',bodyPath:'/World/entities/e0/link6',
      parentBodyName:'link6',sourceFovyDeg:48,available:true,referenceFrame:'parent',
      intrinsicsSource:'usd-camera-focalLength-aperture',intrinsics:INTRINSICS,
      fovyDeg:45,focalLength:18.75,verticalAperture:15.6,
      worldFromCamera:{positionM:[0.4,-0.2,0.9],rotationMatrix:[[1,0,0],[0,1,0],[0,0,1]]},
      poseSource:'usd-xformcache-readback',override:false,positionOverridden:false,quaternionOverridden:false,fovyOverridden:false,
      stepIndex:3,simTime:0.006},
    {entityId:'e1',name:'gripper',localName:'gripper',qualifiedName:'e1/gripper',cameraName:'e1/gripper',cameraSource:'mjcf',
      referenceResolution:[640,480],status:'UNSUPPORTED_CAPABILITY',path:'/World/entities/e0/gripper',bodyPath:'/World/entities/e0/link6',
      parentBodyName:'link6',available:false,reason:'当前Profile未启动RTX：该相机的原生prim未导入'},
  ]}

/**
 * 假 worker：ready → open 回句柄 → camera_list 回真形状；`CAMERA_LIST_ERROR=1` 时改成结构化拒绝。
 * 回包带 `receivedMethod`，用来证明 provider 发的是 `camera_list` 而不是别的请求。
 */
function workerSource():string{
  return [
    'import json, os, sys',
    'def emit(value): print(json.dumps(value), flush=True)',
    "emit({'event': 'ready', 'engine': 'fake-isaac', 'version': '0.0.0', 'pid': 1})",
    'PAYLOAD = ' + JSON.stringify(JSON.stringify(PAYLOAD)),
    'for line in sys.stdin:',
    '    request = json.loads(line)',
    "    method = request.get('method'); args = request.get('args', {})",
    "    if method == 'open':",
    "        world = args.get('options', {}).get('worldId') or 'w1'",
    "        emit({'id': request['id'], 'result': {'worldId': world, 'sceneId': args.get('snapshot', {}).get('sceneId', 's'), 'engineId': 'isaac', 'engineVersion': '0.0.0', 'worldGeneration': 1, 'appliedSceneRevision': 0, 'status': 'ready', 'clock': 'realtime', 'timestepS': 0.002}})",
    "    elif method == 'camera_list':",
    "        if os.environ.get('CAMERA_LIST_ERROR') == '1':",
    "            emit({'id': request['id'], 'error': {'code': 'SENSOR_UNAVAILABLE', 'message': '当前Profile未启动RTX；命名相机清单不可用'}})",
    '        else:',
    "            payload = json.loads(PAYLOAD); payload['receivedMethod'] = method; payload['receivedOptions'] = args.get('options', 'MISSING')",
    "            emit({'id': request['id'], 'result': payload})",
    "    elif method == 'shutdown':",
    "        emit({'id': request['id'], 'result': None}); break",
    '    else:',
    "        emit({'id': request['id'], 'error': {'code': 'UNKNOWN_METHOD', 'message': str(method)}})",
  ].join('\n')+'\n'
}
const scene=(sceneId='camera-list-scene'):SceneSnapshot=>({sceneId,revision:0,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[]})

function provider(error=false):IsaacProvider{
  base=mkdtempSync(join(tmpdir(),'isaac-camera-list-'))
  const cache=join(base,'cache');mkdirSync(cache,{recursive:true})
  const worker=join(base,'fake-worker.py');writeFileSync(worker,workerSource())
  const instance=new IsaacProvider(error?{pythonPath:PYTHON!,workerPath:worker,cacheRoot:cache}:{pythonPath:PYTHON!,workerPath:worker,cacheRoot:cache})
  providers.push(instance)
  return instance
}

describe.skipIf(PYTHON===undefined)('ISAAC-04 camera_list：provider → worker 的请求名与返回值',()=>{
  test('listCameras 发出 camera_list 并原样返回清单（含 available/路径/源视场）',async()=>{
    const instance=provider()
    await instance.open(scene(),{worldId:'w1'})
    const list=await instance.listCameras('w1') as typeof PAYLOAD & {receivedMethod?:string;receivedOptions?:unknown}
    expect(list.receivedMethod).toBe('camera_list')
    expect(list.receivedOptions).toEqual({})                 // 传输层必须带 options 字典（worker 的 _camera_resolution 读它），不是 undefined
    expect(list.count).toBe(2)
    expect(list.cameras[0]).toMatchObject({entityId:'e1',name:'wrist',localName:'wrist',cameraName:'e1/wrist',qualifiedName:'e1/wrist',
      status:'AVAILABLE',available:true,sourceFovyDeg:48,parentBodyName:'link6',referenceFrame:'parent',poseSource:'usd-xformcache-readback'})
    expect(list.cameras[0]!.path).toBe('/World/entities/e0/wrist')
  },20000)

  test('合同：可用条目喂进 frustumFromReceipt 真的成锥；不可用条目只有 reason、判据如实拒绝',async()=>{
    const instance=provider()
    await instance.open(scene(),{worldId:'w1'})
    const list=await instance.listCameras('w1') as typeof PAYLOAD
    const [ready,rejected]=list.cameras
    // 可用：位姿/K/挂载实体都进了 spec，视锥画得出来（viewer/Shell 那条判据的全部输入都在回执里）。
    const drawn=frustumFromReceipt(ready)
    expect(drawn.ok).toBe(true)
    if(!drawn.ok)throw new Error(drawn.unavailable)
    expect(drawn.spec.key).toBe('e1/wrist')
    expect(drawn.spec.entityId).toBe('e1')
    expect(drawn.spec.parentBodyName).toBe('link6')
    expect(drawn.spec.intrinsicsSource).toBe('usd-camera-focalLength-aperture')   // K 由 live prim 的 focalLength/孔径算出，不是回声入参
    expect(drawn.spec.positionM).toEqual([0.4,-0.2,0.9])
    expect([drawn.spec.intrinsics.fx,drawn.spec.intrinsics.fy,drawn.spec.intrinsics.cx,drawn.spec.intrinsics.cy]).toEqual([554.2562584220408,554.2562584220408,319.5,239.5])
    expect(drawn.spec.measured?.stepIndex).toBe(3)
    // 不可用：**没有**位姿/K ⇒ 判据拒绝（原因里点名缺的是位姿），UI 的 `available!==false && ok` 于是把它排除在勾选之外。
    expect(rejected!.available).toBe(false)
    expect(frustumFromReceipt(rejected).ok).toBe(false)
    expect((frustumFromReceipt(rejected) as {unavailable:string}).unavailable).toContain('worldFromCamera')
    expect(String(rejected!.reason)).toContain('未启动RTX')
  },20000)

  test('负对照：worker 结构化拒绝时 provider 如实抛错，不用空列表冒充“没有相机”',async()=>{
    process.env.CAMERA_LIST_ERROR='1'
    try{
      const instance=provider(true)
      await instance.open(scene(),{worldId:'w1'})
      const failure=await instance.listCameras('w1').then(()=>({ok:true}),error=>({ok:false,error}))
      expect(failure.ok).toBe(false)
      expect(String((failure as {error:Error}).error.message)).toContain('当前Profile未启动RTX')
    }finally{delete process.env.CAMERA_LIST_ERROR}
  },20000)
})
