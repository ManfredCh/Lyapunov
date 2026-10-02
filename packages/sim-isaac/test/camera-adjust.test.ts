/**
 * ISAAC-04 第 3 项：`camera_adjust` 的接线（假 worker 只实现行协议，不启动 Kit）。
 * 真实引擎结果见 `bugfixHistory/ISAAC04-CAMERA-ADJUST-20260922.md`
 * （真实 USD prim 上的 world/parent 换算、clear/sync 恢复、结构化拒绝）。
 *
 * 这里钉三件事：①provider 发出的请求名就是传输层的 `camera_adjust`（不是 `camera_pose_override` 之类的壳名）；
 * ②入参**原样**透传（referenceFrame/positionM/quaternionXyzw/fovyDeg/width/height/clear 不被客户端改写或补默认值）；
 * ③worker 的结构化拒绝原样带出（错误码保留），clear 回执的 override/cleared 不被改写成成功。
 */
import {afterEach, describe, expect, test} from 'bun:test'
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {IsaacProvider} from '../src/provider.ts'
import {SimError, type CameraAdjustOptions} from '../../sim-contract/src/index.ts'
import type {SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'

function systemPython():string|undefined{for(const c of['/usr/bin/python3','/usr/local/bin/python3','/bin/python3'])if(existsSync(c))return c;return undefined}
const PYTHON=systemPython()
let base:string|undefined
const providers:IsaacProvider[]=[]
afterEach(async()=>{for(const provider of providers.splice(0))await provider.dispose().catch(()=>undefined);if(base)rmSync(base,{recursive:true,force:true});base=undefined})

/** 假 worker：camera_adjust 只回显收到的 options（证明透传），并可按 env 触发结构化拒绝。 */
function workerSource():string{
  return [
    'import json, os, sys',
    'def emit(value): print(json.dumps(value), flush=True)',
    "emit({'event': 'ready', 'engine': 'fake-isaac', 'version': '0.0.0', 'pid': 1})",
    'for line in sys.stdin:',
    '    request = json.loads(line)',
    "    method = request.get('method'); args = request.get('args', {})",
    "    if method == 'open':",
    "        world = args.get('options', {}).get('worldId') or 'w1'",
    "        emit({'id': request['id'], 'result': {'worldId': world, 'sceneId': args.get('snapshot', {}).get('sceneId', 's'), 'engineId': 'isaac', 'engineVersion': '0.0.0', 'worldGeneration': 1, 'appliedSceneRevision': 0, 'status': 'ready', 'clock': 'realtime', 'timestepS': 0.002}})",
    "    elif method == 'camera_adjust':",
    "        options = args.get('options', {})",
    "        if os.environ.get('CAMERA_ADJUST_ERROR') == 'STALE_GENERATION':",
    "            emit({'id': request['id'], 'error': {'code': 'STALE_GENERATION', 'message': '相机调整代次已过期: 请求 99，当前 1'}})",
    "        elif os.environ.get('CAMERA_ADJUST_ERROR') == 'UNSUPPORTED_CAPABILITY':",
    "            emit({'id': request['id'], 'error': {'code': 'UNSUPPORTED_CAPABILITY', 'message': '当前MJCF相机适配支持固定于body的fovy透视相机'}})",
    '        elif options.get(\'clear\'):',
    "            emit({'id': request['id'], 'result': {'worldId': args.get('worldId'), 'receivedMethod': method, 'receivedOptions': options, 'override': False, 'cleared': True, 'calibration': {'cameraName': options.get('cameraName'), 'override': False, 'intrinsics': {'fx': 579.4, 'fy': 579.4, 'width': 640, 'height': 480}}}})",
    '        else:',
    "            emit({'id': request['id'], 'result': {'worldId': args.get('worldId'), 'receivedMethod': method, 'receivedOptions': options, 'override': True, 'cleared': False, 'positionM': options.get('positionM'), 'quaternionXyzw': options.get('quaternionXyzw'), 'fovyDeg': options.get('fovyDeg'), 'worldFromCamera': {'positionM': options.get('positionM') or [0, 0, 0], 'rotationMatrix': [[1, 0, 0], [0, 1, 0], [0, 0, 1]]}}})",
    "    elif method == 'shutdown':",
    "        emit({'id': request['id'], 'result': None}); break",
    '    else:',
    "        emit({'id': request['id'], 'error': {'code': 'UNKNOWN_METHOD', 'message': str(method)}})",
  ].join('\n')+'\n'
}
const scene=(sceneId='adjust-scene'):SceneSnapshot=>({sceneId,revision:0,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[]})
type AdjustResult={receivedMethod?:string;receivedOptions?:Record<string,unknown>;override?:boolean;cleared?:boolean;worldFromCamera?:{positionM:number[]}}
function provider():IsaacProvider{
  base=mkdtempSync(join(tmpdir(),'isaac-camera-adjust-'))
  const cache=join(base,'cache');mkdirSync(cache,{recursive:true})
  const worker=join(base,'fake-worker.py');writeFileSync(worker,workerSource())
  const instance=new IsaacProvider({pythonPath:PYTHON!,workerPath:worker,cacheRoot:cache})
  providers.push(instance)
  return instance
}
const OPTIONS:CameraAdjustOptions&Record<string,unknown>={cameraName:'cam0',expectedGeneration:1,referenceFrame:'parent',positionM:[0.2,0,0.05],quaternionXyzw:[0,0,0.7071067811865476,0.7071067811865476],fovyDeg:60,width:800,height:600}

describe.skipIf(PYTHON===undefined)('ISAAC-04 camera_adjust：请求名、透传与拒绝语义',()=>{
  test('发出 camera_adjust；options 全字段原样透传（不补默认值、不改写参考系）',async()=>{
    const instance=provider()
    await instance.open(scene(),{worldId:'w1'})
    const result=await instance.adjustCamera('w1',OPTIONS) as AdjustResult
    expect(result.receivedMethod).toBe('camera_adjust')
    expect(result.receivedOptions).toEqual(OPTIONS)
    expect(result.override).toBe(true)
    expect(result.worldFromCamera?.positionM).toEqual([0.2,0,0.05])
  },20000)

  test('clear 走同一请求名：override:false + cleared:true + calibration（不冒充成一次新 override）',async()=>{
    const instance=provider()
    await instance.open(scene(),{worldId:'w1'})
    const result=await instance.adjustCamera('w1',{cameraName:'cam0',expectedGeneration:1,clear:true}) as AdjustResult
    expect(result.receivedMethod).toBe('camera_adjust')
    expect(result.receivedOptions).toEqual({cameraName:'cam0',expectedGeneration:1,clear:true})
    expect(result.override).toBe(false)
    expect(result.cleared).toBe(true)
  },20000)

  test('负对照：代次过期原样带出结构化错误（错误码不被吞掉）',async()=>{
    process.env.CAMERA_ADJUST_ERROR='STALE_GENERATION'
    try{
      const instance=provider()
      await instance.open(scene(),{worldId:'w1'})
      const failure=await instance.adjustCamera('w1',OPTIONS).then(()=>({ok:true}),error=>({ok:false,error}))
      expect(failure.ok).toBe(false)
      const error=(failure as {error:SimError}).error
      expect(error).toBeInstanceOf(SimError)
      expect(error.code).toBe('STALE_GENERATION')
      expect(error.message).toContain('相机调整代次已过期')
    }finally{delete process.env.CAMERA_ADJUST_ERROR}
  },20000)

  test('负对照：适配边界（UNSUPPORTED_CAPABILITY）按原码带出，不用空壳结果冒充成功',async()=>{
    process.env.CAMERA_ADJUST_ERROR='UNSUPPORTED_CAPABILITY'
    try{
      const instance=provider()
      await instance.open(scene(),{worldId:'w1'})
      const failure=await instance.adjustCamera('w1',{cameraName:'wrist_cam',expectedGeneration:1,positionM:[0,0,0]}).then(()=>({ok:true}),error=>({ok:false,error}))
      expect(failure.ok).toBe(false)
      const error=(failure as {error:SimError}).error
      expect(error).toBeInstanceOf(SimError)
      expect(error.code).toBe('UNSUPPORTED_CAPABILITY')
      expect(error.message).toContain('fovy透视相机')
    }finally{delete process.env.CAMERA_ADJUST_ERROR}
  },20000)
})
