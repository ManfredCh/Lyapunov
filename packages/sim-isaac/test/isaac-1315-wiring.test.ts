/**
 * N33（ISAAC-13/14/15）接线钉桩：假 worker 只实现行协议，不启动 Kit。
 * 真实引擎读数/错误原文见 `bugfixHistory/ISAAC-13-14-15-LIVE-20260922.md`。
 *
 * 这里钉的是**客户端不会替引擎撒谎**的四件事：
 *  ①`robot_walk`/`robot_move(kind:'gait')`/`robot_move(kind:'tendon')` 的动作 kind 原样透传给 worker 的
 *    `execute`（没有客户端降级成 joint，也没有被工具层悄悄改写）；
 *  ②worker 的结构化拒绝（`UNSUPPORTED_CAPABILITY: Isaac没有该资产的已适配策略: gait|tendon`）按原码原话带出；
 *  ③`observe({sensors:true})` 的 `siteObservation` 原样带出：不可用时给出原因，且**不伪造** `sites` 内容；
 *  ④`describe` 不编造 Isaac 未产出的 `tendonActuators` 字段。
 */
import {afterEach, describe, expect, test} from 'bun:test'
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {IsaacProvider} from '../src/provider.ts'
import {createRobotOperations} from '../../robot-tools/src/operations.ts'
import {SimError} from '../../sim-contract/src/index.ts'
import type {SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'

function systemPython():string|undefined{for(const c of['/usr/bin/python3','/usr/local/bin/python3','/bin/python3'])if(existsSync(c))return c;return undefined}
const PYTHON=systemPython()
let base:string|undefined
const providers:IsaacProvider[]=[]
afterEach(async()=>{for(const provider of providers.splice(0))await provider.dispose().catch(()=>undefined);if(base)rmSync(base,{recursive:true,force:true});base=undefined})

/** 假 worker：execute 回显收到的 action（证明 kind 透传），gait/tendon 按真实文案结构化拒绝；observe 回显 site 状态。 */
function workerSource():string{
  return [
    'import json, os, sys',
    'def emit(value): print(json.dumps(value), flush=True)',
    "emit({'event': 'ready', 'engine': 'fake-isaac', 'version': '0.0.0', 'pid': 1})",
    'RECEIPTS = {}',
    'for line in sys.stdin:',
    '    request = json.loads(line)',
    "    method = request.get('method'); args = request.get('args', {})",
    "    if method == 'open':",
    "        world = args.get('options', {}).get('worldId') or 'w1'",
    "        emit({'id': request['id'], 'result': {'worldId': world, 'sceneId': args.get('snapshot', {}).get('sceneId', 's'), 'engineId': 'isaac', 'engineVersion': '0.0.0', 'worldGeneration': 1, 'appliedSceneRevision': 0, 'status': 'ready', 'clock': 'realtime', 'timestepS': 0.002}})",
    "    elif method == 'describe':",
    "        joints = [{'name': 'j', 'type': 'hinge', 'unit': 'rad'}]",
    "        emit({'id': request['id'], 'result': {'entityId': args.get('entityId'), 'joints': joints, 'controlledJointNames': [], 'capabilities': [{'kind': 'joint', 'available': True, 'joints': 1, 'controlledJointNames': []}]}})",
    "    elif method == 'observe':",
    "        if os.environ.get('ISAAC_1315_SITE') == 'NONE':",
    "            sensors = {'siteObservation': {'status': 'UNSUPPORTED_CAPABILITY', 'message': '该原生USD/URDF未提供可核验的命名site定义'}}",
    '        else:',
    "            sensors = {'siteObservation': {'status': 'AVAILABLE', 'source': 'mjcf-imported-usd', 'count': 1}, 'sites': {'tcp': {'positionM': [0.7, 0.0, 0.4], 'quaternionXyzw': [0, 0, 0, 1]}}}",
    "        emit({'id': request['id'], 'result': {'worldId': args.get('worldId'), 'stepIndex': 7, 'simTime': 0.014, 'entities': [{'entityId': 'e1', 'transform': {'position': [0, 0, 0], 'quaternion': [0, 0, 0, 1], 'scale': [1, 1, 1]}, 'joints': {'names': ['j'], 'positions': [0.0], 'velocities': [0.0]}, 'sensors': sensors}]}})",
    "    elif method == 'execute':",
    "        action = args.get('action', {})",
    "        kind = action.get('kind')",
    "        if kind in ('gait', 'tendon'):",
    "            emit({'id': request['id'], 'error': {'code': 'UNSUPPORTED_CAPABILITY', 'message': 'Isaac没有该资产的已适配策略: ' + kind}})",
    '        else:',
    "            receipt = {'actionId': action.get('actionId'), 'worldId': args.get('worldId'), 'generation': 1, 'status': 'completed', 'receivedKind': kind, 'receivedAction': action}",
    '            RECEIPTS[action.get(\'actionId\')] = receipt',
    "            emit({'id': request['id'], 'result': receipt})",
    "    elif method == 'receipt':",
    "        stored = RECEIPTS.get(args.get('actionId'))",
    "        emit({'id': request['id'], 'result': stored} if stored else {'id': request['id'], 'error': {'code': 'ACTION_NOT_FOUND', 'message': str(args.get('actionId'))}})", 
    "    elif method == 'shutdown':",
    "        emit({'id': request['id'], 'result': None}); break",
    '    else:',
    "        emit({'id': request['id'], 'error': {'code': 'UNKNOWN_METHOD', 'message': str(method)}})",
  ].join('\n')+'\n'
}
const scene=(sceneId='isaac-1315-scene'):SceneSnapshot=>({sceneId,revision:0,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[]})
function provider():IsaacProvider{
  base=mkdtempSync(join(tmpdir(),'isaac-1315-'))
  const cache=join(base,'cache');mkdirSync(cache,{recursive:true})
  const worker=join(base,'fake-worker.py');writeFileSync(worker,workerSource())
  const instance=new IsaacProvider({pythonPath:PYTHON!,workerPath:worker,cacheRoot:cache})
  providers.push(instance)
  return instance
}
const sceneStub={snapshot:()=>{throw new Error('本用例不进入 scene')},commit:()=>{throw new Error('本用例不进入 scene')}}
const rejection=async(run:()=>Promise<unknown>):Promise<SimError>=>{try{await run()}catch(error){if(error instanceof SimError)return error;throw error}throw new Error('期望结构化拒绝，实际成功')}

describe.skipIf(PYTHON===undefined)('ISAAC-14/15：gait 与 tendon 动作 kind 原样到达 worker，拒绝原码带出',()=>{
  test('robot_walk(kind:gait) → worker 收到的 kind 是 gait；UNSUPPORTED_CAPABILITY 原文带出',async()=>{
    const instance=provider()
    await instance.open(scene(),{worldId:'w1'})
    const operations=createRobotOperations(instance,sceneStub as never)
    const error=await rejection(()=>operations.robot_walk({worldId:'w1',action:{actionId:'walk-1',expectedGeneration:1,kind:'gait',entityId:'e1',forward:0.5,turn:0,durationS:1} as never}))
    expect(error.code).toBe('UNSUPPORTED_CAPABILITY')
    expect(error.message).toBe('Isaac没有该资产的已适配策略: gait')
  },20000)

  test('robot_move(kind:tendon) → kind 原样透传（没有降级成 joint），拒绝原文带出',async()=>{
    const instance=provider()
    await instance.open(scene(),{worldId:'w1'})
    const operations=createRobotOperations(instance,sceneStub as never)
    const error=await rejection(()=>operations.robot_move({worldId:'w1',action:{actionId:'tendon-1',expectedGeneration:1,kind:'tendon',entityId:'e1',tendonNames:['t'],lengths:[0.5],durationS:0.4} as never}))
    expect(error.code).toBe('UNSUPPORTED_CAPABILITY')
    expect(error.message).toBe('Isaac没有该资产的已适配策略: tendon')
  },20000)

  test('负对照：joint 动作确实走通同一条通路（证明拒绝的是通道，不是 execute 一律拒绝）',async()=>{
    const instance=provider()
    await instance.open(scene(),{worldId:'w1'})
    const operations=createRobotOperations(instance,sceneStub as never)
    const receipt=await operations.robot_move({worldId:'w1',action:{actionId:'joint-1',expectedGeneration:1,kind:'joint',entityId:'e1',jointNames:['j'],positions:[0.5],durationS:0.3} as never}) as {receivedKind?:string;receivedAction?:{kind?:string;jointNames?:string[]}}
    expect(receipt.receivedKind).toBe('joint')
    expect(receipt.receivedAction?.kind).toBe('joint')
    expect(receipt.receivedAction?.jointNames).toEqual(['j'])
  },20000)
})

describe.skipIf(PYTHON===undefined)('ISAAC-13：site 观测原样带出，缺 site 时不伪造内容',()=>{
  test('可用时 sites 原样带出（provider 不重算/不改写位姿）；Isaac 不产出肌腱观测',async()=>{
    const instance=provider()
    await instance.open(scene(),{worldId:'w1'})
    const frame=await instance.observe('w1',{sensors:true})
    const entity=frame.entities[0]
    // sensors 的合同类型就是 Record<string, unknown>：按真实类型收窄读取，不做整对象断言。
    const sensors=(entity.sensors ?? {}) as Record<string,unknown>
    const siteObservation=sensors.siteObservation as {status:string}|undefined
    const sites=sensors.sites as Record<string,{positionM:number[]}>|undefined
    expect(siteObservation?.status).toBe('AVAILABLE')
    expect(sites?.tcp.positionM).toEqual([0.7,0,0.4])
    expect(entity.tendons).toBeUndefined()
  },20000)

  test('无 site 元数据：UNSUPPORTED_CAPABILITY 原因原样，且不出现伪造的 sites 字段',async()=>{
    process.env.ISAAC_1315_SITE='NONE'
    try{
      const instance=provider()
      await instance.open(scene(),{worldId:'w1'})
      const frame=await instance.observe('w1',{sensors:true})
      const sensors=(frame.entities[0].sensors ?? {}) as Record<string,unknown>
      const siteObservation=sensors.siteObservation as {status:string;message?:string}|undefined
      expect(siteObservation?.status).toBe('UNSUPPORTED_CAPABILITY')
      expect(siteObservation?.message).toBe('该原生USD/URDF未提供可核验的命名site定义')
      expect(sensors.sites).toBeUndefined()
    }finally{delete process.env.ISAAC_1315_SITE}
  },20000)

  test('describe 不编造 Isaac 未产出的 tendonActuators 字段',async()=>{
    const instance=provider()
    await instance.open(scene(),{worldId:'w1'})
    const described=await instance.describe('w1','e1')
    expect(described.tendonActuators).toBeUndefined()
    expect(described.joints.some(joint=>joint.tendonActuators!==undefined)).toBe(false)
  },20000)
})
