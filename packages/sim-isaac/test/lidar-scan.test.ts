/**
 * P7A：Isaac `scanLidar` 的真实接线（假 worker 只实现行协议，不启动 Kit/PhysX）。
 *
 * 验证 provider → 传输层 → worker 的请求名与 options 原样透传，以及 worker 结构化拒绝时如实报错
 * （不返回占位量测）。真实 PhysX `raycast_closest` 几何读取由主控独立 pilot 与 Isaac worker 端到端复验；
 * 本文件不冒充 Kit 运行。
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

/** 与 Isaac worker.scan_lidar 同形的回执，只保留接线判据需要的字段。 */
const PAYLOAD={worldId:'w1',generation:1,sceneRevision:0,stepIndex:3,simTime:0.006,source:'isaac-physx-raycast-closest',
  captureId:'prov-lidar-1',sensorId:'lidar:e1/wrist',sensorKind:'simulated-lidar',sensorSource:'native-physics-raycast',
  cameraName:'e1/wrist',resolvedCameraName:'/World/entities/e1/wrist',geometrySource:'isaac-physx-raycast-closest',selfExclusion:'none',
  parentBodyName:'link6',rangeSemantics:'euclidean-range-meters-along-ray',rayPattern:{channels:2,horizontalSamples:1,horizontalFovDeg:180,verticalFovDeg:[-45,0],rangeM:5,units:'m'},
  worldFromSensor:{positionM:[0,0,1],rotationMatrix:[[1,0,0],[0,1,0],[0,0,1]]},
  range:{uri:'file:///tmp/lidar-range.npy',mimeType:'application/x-npy',units:'m',shape:[2,1]},valid:{uri:'file:///tmp/lidar-valid.npy'},
  hitGeom:{uri:'file:///tmp/lidar-hit.npy',geomIds:{'0':'/World/floor'}},preview:{uri:'file:///tmp/lidar-preview.png',mimeType:'image/png'},
  rayCount:2,validCount:1,noReturnCount:1,rangeMinM:1,rangeMaxM:1,rangeMeanM:1}

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
    "    elif method == 'lidar_scan':",
    "        if os.environ.get('LIDAR_ERROR') == '1':",
    "            emit({'id': request['id'], 'error': {'code': 'SENSOR_UNAVAILABLE', 'message': '当前PhysX运行时没有raycast_closest'}})",
    '        else:',
    "            payload = json.loads(PAYLOAD); payload['receivedMethod'] = method; payload['receivedOptions'] = args.get('options', 'MISSING')",
    "            emit({'id': request['id'], 'result': payload})",
    "    elif method == 'shutdown':",
    "        emit({'id': request['id'], 'result': None}); break",
    '    else:',
    "        emit({'id': request['id'], 'error': {'code': 'UNKNOWN_METHOD', 'message': str(method)}})",
  ].join('\n')+'\n'
}
const scene=(sceneId='lidar-scan-scene'):SceneSnapshot=>({sceneId,revision:0,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[]})

function provider(error=false):IsaacProvider{
  base=mkdtempSync(join(tmpdir(),'isaac-lidar-scan-'))
  const cache=join(base,'cache');mkdirSync(cache,{recursive:true})
  const worker=join(base,'fake-worker.py');writeFileSync(worker,workerSource())
  const instance=new IsaacProvider(error?{pythonPath:PYTHON!,workerPath:worker,cacheRoot:cache}:{pythonPath:PYTHON!,workerPath:worker,cacheRoot:cache})
  providers.push(instance)
  return instance
}

describe.skipIf(PYTHON===undefined)('P7A Isaac scanLidar：provider → worker 的请求名与返回值',()=>{
  test('scanLidar 发出 lidar_scan 并原样返回回执，options 与相机/图案透传',async()=>{
    const instance=provider()
    await instance.open(scene(),{worldId:'w1'})
    const out=await instance.scanLidar!('w1',{outputDir:base!,cameraName:'e1/wrist',channels:2,horizontalSamples:1,horizontalFovDeg:180,verticalFovDeg:[-45,0],rangeM:5}) as typeof PAYLOAD & {receivedMethod?:string;receivedOptions?:any}
    expect(out.receivedMethod).toBe('lidar_scan')
    expect(out.receivedOptions).toMatchObject({cameraName:'e1/wrist',channels:2,horizontalSamples:1,rangeM:5})
    expect(out.receivedOptions.outputDir).toBe(base!)
    expect(out.sensorKind).toBe('simulated-lidar')
    expect(out.geometrySource).toBe('isaac-physx-raycast-closest')
    expect(out.rangeSemantics).toBe('euclidean-range-meters-along-ray')
    expect(out.validCount+out.noReturnCount).toBe(out.rayCount)
  },20000)

  test('负对照：worker 结构化拒绝 时 provider 如实抛错，不返回占位量测',async()=>{
    process.env.LIDAR_ERROR='1'
    try{
      const instance=provider(true)
      await instance.open(scene(),{worldId:'w1'})
      const failure=await instance.scanLidar!('w1',{outputDir:base!,cameraName:'e1/wrist'}).then(()=>({ok:true}),error=>({ok:false,error}))
      expect(failure.ok).toBe(false)
      expect(String((failure as {error:Error}).error.message)).toContain('raycast_closest')
    }finally{delete process.env.LIDAR_ERROR}
  },20000)
})
