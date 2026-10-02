/**
 * ISAAC-04 第 2 项：`camera_capture_multi` 的接线（假 worker 只实现行协议，不启动 Kit）。
 * 真实引擎结果见 `bugfixHistory/ISAAC04-CAPTURE-MULTI-20260922.md`（同一物理步 + rendering:none 阶段化拒绝）。
 *
 * 这里钉三件事：①provider 发出的请求名就是传输层的 `capture_multi`；②多台相机的返回**共享**同一
 * stepIndex/simTime/frameId/sceneRevision（同一步），且每台自带 rgb/米制深度/标定；③worker 结构化拒绝时
 * provider 如实抛错——不用空结果或部分结果冒充成功。
 */
import {afterEach, describe, expect, test} from 'bun:test'
import {existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {IsaacProvider} from '../src/provider.ts'
import type {SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'

function systemPython():string|undefined{for(const c of['/usr/bin/python3','/usr/local/bin/python3','/bin/python3'])if(existsSync(c))return c;return undefined}
const PYTHON=systemPython()
let base:string|undefined
const providers:IsaacProvider[]=[]
afterEach(async()=>{for(const provider of providers.splice(0))await provider.dispose().catch(()=>undefined);if(base)rmSync(base,{recursive:true,force:true});base=undefined})

/** 与真实 worker 同形的返回：两台相机共享同一步，各自带 rgb/深度/标定。 */
const PAYLOAD={worldId:'w1',generation:1,sceneRevision:0,stepIndex:7,simTime:0.014,frameId:'w1:1:7',rendering:'rtx',count:2,
  captures:[
    {cameraName:'cam0',resolvedCameraName:'/World/entities/e0/cam0',stepIndex:7,simTime:0.014,frameId:'w1:1:7',sceneRevision:0,width:64,height:48,rgb:{uri:'file:///out/a.png',mimeType:'image/png'},depth:{uri:'file:///out/a-depth.npy',mimeType:'application/x-npy',units:'m'},calibration:{model:'pinhole',intrinsics:{fx:50,fy:50,cx:31.5,cy:23.5,width:64,height:48,distortion:[0,0,0,0,0]},worldFromCamera:{positionM:[0.6,-0.6,0.5],rotationMatrix:[[1,0,0],[0,1,0],[0,0,1]]}}},
    {cameraName:'cam1',resolvedCameraName:'/World/entities/e0/cam1',stepIndex:7,simTime:0.014,frameId:'w1:1:7',sceneRevision:0,width:64,height:48,rgb:{uri:'file:///out/b.png',mimeType:'image/png'},depth:{uri:'file:///out/b-depth.npy',mimeType:'application/x-npy',units:'m'},calibration:{model:'pinhole',intrinsics:{fx:48,fy:48,cx:31.5,cy:23.5,width:64,height:48,distortion:[0,0,0,0,0]},worldFromCamera:{positionM:[0,0,1],rotationMatrix:[[1,0,0],[0,1,0],[0,0,1]]}}}]}

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
    "    elif method == 'capture_multi':",
    "        options = args.get('options', {})",
    "        if os.environ.get('CAPTURE_MULTI_ERROR') == '1':",
    "            emit({'id': request['id'], 'error': {'code': 'SENSOR_UNAVAILABLE', 'message': '当前Profile未启动RTX；传感器采集需要rendering:rtx'}})",
    "        elif not options.get('cameraNames'):",
    "            emit({'id': request['id'], 'error': {'code': 'INVALID_ARGUMENT', 'message': 'cameraNames 必须非空且不重复'}})",
    '        else:',
    "            payload = json.loads(PAYLOAD); payload['receivedMethod'] = method; payload['requested'] = options.get('cameraNames')",
    "            emit({'id': request['id'], 'result': payload})",
    "    elif method == 'shutdown':",
    "        emit({'id': request['id'], 'result': None}); break",
    '    else:',
    "        emit({'id': request['id'], 'error': {'code': 'UNKNOWN_METHOD', 'message': str(method)}})",
  ].join('\n')+'\n'
}
const scene=(sceneId='capture-multi-scene'):SceneSnapshot=>({sceneId,revision:0,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[]})

type MultiResult=typeof PAYLOAD & {receivedMethod?:string;requested?:string[]}
function provider():IsaacProvider{
  base=mkdtempSync(join(tmpdir(),'isaac-capture-multi-'))
  const cache=join(base,'cache');mkdirSync(cache,{recursive:true})
  const worker=join(base,'fake-worker.py');writeFileSync(worker,workerSource())
  const instance=new IsaacProvider({pythonPath:PYTHON!,workerPath:worker,cacheRoot:cache})
  providers.push(instance)
  return instance
}

describe.skipIf(PYTHON===undefined)('ISAAC-04 camera_capture_multi：请求名、同一步与拒绝语义',()=>{
  test('发出 capture_multi；多台相机共享同一步且各自带 rgb/米制深度/标定',async()=>{
    const instance=provider()
    await instance.open(scene(),{worldId:'w1'})
    const result=await instance.captureMulti('w1',{outputDir:join(base!,'out'),cameraNames:['cam0','cam1']}) as MultiResult
    expect(result.receivedMethod).toBe('capture_multi')
    expect(result.requested).toEqual(['cam0','cam1'])
    expect(result.count).toBe(2)
    const steps=new Set(result.captures.map(capture=>`${capture.stepIndex}|${capture.simTime}|${capture.frameId}|${capture.sceneRevision}`))
    expect(steps.size).toBe(1)
    expect(result.stepIndex).toBe(7);expect(result.frameId).toBe('w1:1:7')
    for(const capture of result.captures){
      expect(capture.depth.units).toBe('m')
      expect(capture.calibration.intrinsics.fx).toBeGreaterThan(0)
      expect(capture.calibration.worldFromCamera.positionM).toHaveLength(3)
    }
  },20000)

  test('负对照：空相机名 → 整体拒绝（不部分采集）',async()=>{
    const instance=provider()
    await instance.open(scene(),{worldId:'w1'})
    const failure=await instance.captureMulti('w1',{outputDir:join(base!,'out'),cameraNames:[]}).then(()=>({ok:true}),error=>({ok:false,error}))
    expect(failure.ok).toBe(false)
    expect(String((failure as {error:Error}).error.message)).toContain('cameraNames 必须非空且不重复')
  },20000)

  test('负对照：rendering:none 的阶段化拒绝原样带出（不用空结果冒充成功）',async()=>{
    process.env.CAPTURE_MULTI_ERROR='1'
    try{
      const instance=provider()
      await instance.open(scene(),{worldId:'w1'})
      const failure=await instance.captureMulti('w1',{outputDir:join(base!,'out'),cameraNames:['cam0']}).then(()=>({ok:true}),error=>({ok:false,error}))
      expect(failure.ok).toBe(false)
      expect(String((failure as {error:Error}).error.message)).toContain('未启动RTX')
    }finally{delete process.env.CAPTURE_MULTI_ERROR}
  },20000)
})
