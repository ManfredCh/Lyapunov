"""可编排的假 worker：只实现 ProcessSimProvider 的行协议，用于**可控**的启动/退出边界测试。

不是第二个仿真引擎，也不替代任何真实 worker：它存在的唯一理由是让「ready 迟到 / 明确取消 /
显式启动预算到期 / 真实 fatal / 真实 exit / 迟到旧 ready / 正常 SDK 关闭」这些**生命周期时序**
可以逐条复现（Isaac 侧这些时序受 Kit 冷启动分钟级耗时与偶发挂起影响，无法当夹具）。

行为全部来自 `FAKE_SCENARIO` 指向的 JSON（每次启动时重读，因此测试可以在两次启动之间改场景）：

  ready:          'ok'（默认）| 'never' | 'delay'
  readyDelayMs:   发出 ready 前的等待（默认 0）
  phases:         是否发 phase 事件（默认 true）
  phaseDelayMs:   每个 phase 之间的等待（默认 0）
  silentMs:       发出 ready 前完全静默的时长（默认 0；用来证明「没有输出」不等于「要杀」）
  stderr:         启动时写到 stderr 的文本（诊断摘要取证用）
  fatal:          'CODE:message'：在 ready 前发 fatal 事件
  exitCode:       在 ready 前直接退出（真实 exit 路径）
  openDelayMs:    回复 open 前的等待（模拟建世界耗时）
  openDelayByWorld: {'secondary': 700} —— 只把某个 worldId 的 open 拖慢，并为它发一条
                   `opening-<worldId>` 阶段事件（一个 worker 上先交付 primary、再慢开 secondary）
  observeDelayMs: 回复 observe 前的等待（模拟慢观察）
  captureWrites:  false 时落盘类请求（capture/capture_multi/camera_dataset_export）只回执不写文件：
                  用来把「Host 中转代写」与「worker 自己写」两件事分开核对
  captureError:   '文本'：落盘类请求回 worker 侧拒绝（对应真实 worker 被自己的沙箱拒绝的那一面，
                  Host 不得代写、也不得把它变成"成功"）
  closeDelayMs:   回复 close / shutdown 前的等待（模拟慢关闭）
  ignoreShutdown: true 时不回复 shutdown、也不理会 stdin EOF（模拟真的卡死的 worker：
                  卡在 carb 初始化里的进程既不会回复请求，也不会因为 stdin 关闭而退出）
  ignoreSigterm:  true 时忽略 SIGTERM（用来把「迟到 ready」的窗口撑到 SIGKILL 之前）
  framesAfterOpen: 回复 open 之后再发 N 个 frame 事件（模拟真实 worker 的异步帧流）
  exitAfterReadyMs:   ready 之后再过这么多毫秒自行死亡（`exitAfterReadyCode`，默认 9）：
                      模拟 worker 在没有在途请求时突然没了
  exitOnRequest:      {'method': 'observe', 'code': 7} —— 收到该请求时**不回执**直接 os._exit(code)
  fatalOnRequest:     {'method': 'observe', 'fatal': 'CODE:message'} —— 收到该请求时发 fatal 事件后不再答复
                      （真实 fatal 之后进程已经不可用，所以它就停在那里等传输层按归属结束它）
  ignoreShutdown:  true 时（见上）收到 stdin EOF 也不退出：用于让「父进程的写端坏掉」与
                   「子进程因此退出」这两件事分开，好在管道断裂那条路径上做确定的交叉例

`FAKE_MARKER` 指向一个追加写的文本文件：每个关键事件都落一行，供测试核对「这件事真的发生过」
（例如迟到 ready 确实被发出过，只是被传输层按陈旧 worker 丢弃了）。
"""
import json
import os
import signal
import sys
import threading
import time

SCENARIO = os.environ.get('FAKE_SCENARIO')
MARKER = os.environ.get('FAKE_MARKER')


def scenario():
    try:
        with open(SCENARIO) as handle:
            return json.load(handle)
    except Exception:
        return {}


FACT_ENV_KEYS = (
    'LYAPUNOV_SIM_SESSION', 'LYAPUNOV_SIM_RUNTIME_ROOT', 'LYAPUNOV_SIM_SANDBOX_MODE', 'LYAPUNOV_SIM_WORKSPACE_ROOT',
)


def execution_facts():
    """本 worker 实际收到的执行事实（与真实 worker 同形；未接线时是空 dict）。"""
    return {key: os.environ[key] for key in FACT_ENV_KEYS if os.environ.get(key)}


def marker(text):
    if not MARKER:
        return
    with open(MARKER, 'a') as handle:
        handle.write(f'{time.monotonic():.3f} {text}\n')
        handle.flush()


def emit(value):
    print(json.dumps(value, allow_nan=False, separators=(',', ':')), flush=True)


def handle_of(world_id):
    return {'worldId': world_id, 'sceneId': 'fake', 'engineId': 'fake', 'engineVersion': '0.0.0',
            'worldGeneration': 1, 'appliedSceneRevision': 0, 'status': 'ready', 'clock': 'realtime', 'timestepS': 0.002}


def frame_of(world_id):
    return {'worldId': world_id, 'generation': 1, 'sceneRevision': 0, 'stepIndex': 7, 'simTime': 0.014,
            'frameId': f'{world_id}:1:7', 'assistAdvanceCount': 0, 'entities': []}


def main():
    plan = scenario()
    if plan.get('ignoreSigterm'):
        signal.signal(signal.SIGTERM, lambda *_args: marker('sigterm-ignored'))
        # 处理器装好才算“真的能忽略 SIGTERM”：测试要等这一行再取消，否则可能在 Python 还没
        # 装处理器时就被默认处置杀掉，撑不出「迟到 ready」的窗口。
        marker('sigterm-armed')
    marker(f'started pid={os.getpid()}')
    if plan.get('stderr'):
        print(str(plan['stderr']), file=sys.stderr, flush=True)
        marker('stderr-written')
    if plan.get('phases', True):
        for name in ('python-start', 'kit-import', 'kit-app-start'):
            emit({'event': 'phase', 'phase': name, 'elapsedS': 0.0})
            marker(f'phase {name}')
            if plan.get('phaseDelayMs'):
                time.sleep(float(plan['phaseDelayMs']) / 1000)
    if plan.get('silentMs'):
        time.sleep(float(plan['silentMs']) / 1000)
    exit_code = plan.get('exitCode')
    if exit_code is not None:
        marker(f'exit {exit_code}')
        sys.exit(int(exit_code))
    fatal = plan.get('fatal')
    if fatal:
        code, _, message = str(fatal).partition(':')
        emit({'event': 'fatal', 'error': {'code': code, 'message': message}})
        marker(f'fatal {code}')
        sys.exit(3)
    if plan.get('ready', 'ok') == 'never':
        marker('ready-withheld')
    else:
        if plan.get('readyDelayMs'):
            time.sleep(float(plan['readyDelayMs']) / 1000)
        # 与真实 worker 同形：ready 时自报**实际收到**的执行事实（会话身份/运行根/生效模式/授权根），
        # 供测试核对「启动接线给出的身份与模式真的到了 worker 进程里」，而不是只在宿主侧算过一遍。
        emit({'event': 'ready', 'engine': 'fake', 'version': '0.0.0', 'pid': os.getpid(), 'runtime': execution_facts()})
        marker('ready-emitted')
    if plan.get('exitAfterReadyMs'):
        # 就绪之后**没有在途请求**时自行死亡：用来验证「worker 死后不复活、后续调用不挂起」。
        def die():
            time.sleep(float(plan['exitAfterReadyMs']) / 1000)
            marker('exit-after-ready')
            os._exit(int(plan.get('exitAfterReadyCode', 9)))
        threading.Thread(target=die, daemon=True).start()
    # 与真实 worker 一致：ready 之后才开始读 stdin（因此 ready 之前的请求本来就得不到回复）。
    world = None
    worlds = []  # 这个 worker 上真实建出来的世界（一个 worker 可以复用多个 world）
    prepared = {}  # 可选初始暂停协议场景；默认旧夹具不变，不模拟真实物理。
    for line in sys.stdin:
        try:
            request = json.loads(line)
        except Exception as error:
            emit({'event': 'protocol-error', 'message': str(error)})
            continue
        method = request.get('method')
        args = request.get('args', {})
        marker(f'request {method}')
        crash = plan.get('exitOnRequest')
        if crash and method == crash.get('method'):
            marker(f'exit-on-request {method}')
            os._exit(int(crash.get('code', 7)))
        fatal_mid = plan.get('fatalOnRequest')
        if fatal_mid and method == fatal_mid.get('method'):
            code, _, message = str(fatal_mid.get('fatal', 'FAKE_MID_FATAL:运行中致命错误')).partition(':')
            emit({'event': 'fatal', 'error': {'code': code, 'message': message}})
            marker(f'fatal-on-request {method} {code}')
            # fatal 之后这个 worker 已经不可用（真实 Kit 那侧也是进程自己就要没了）：
            # 它不再答复任何请求，等传输层按归属结束它。
            while True:
                time.sleep(0.1)
        if method == 'open':
            world = args.get('options', {}).get('worldId') or 'fake-world'
            by_world = plan.get('openDelayByWorld') or {}
            if world in by_world:
                emit({'event': 'phase', 'phase': f'opening-{world}', 'elapsedS': 0.0})
                marker(f'opening {world}')
                time.sleep(float(by_world[world]) / 1000)
            if plan.get('openDelayMs'):
                time.sleep(float(plan['openDelayMs']) / 1000)
            if world not in worlds:
                worlds.append(world)
            if plan.get('initialPauseSupport'):
                prepared[world] = {**handle_of(world), 'status': 'paused' if args.get('options', {}).get('startPaused') else 'ready', 'supportsPause': True,
                                   'clock': args.get('options', {}).get('clock', 'realtime')}
            emit({'id': request['id'], 'result': prepared.get(world, handle_of(world))})
            emit({'event': 'receipt', 'receipt': {'actionId': 'fake-action', 'worldId': world, 'generation': 1, 'status': 'completed'}})
            for index in range(int(plan.get('framesAfterOpen', 0))):
                frame = frame_of(world)
                frame['stepIndex'] = 7 + index
                frame['frameId'] = f'{world}:1:{7 + index}'
                emit({'event': 'frame', 'frame': frame})
        elif method == 'capture_publish':
            target = os.path.join(args['toDir'], 'shot.png')
            marker(f'capture-published captureId={args["captureId"]} path={target} exists={os.path.isfile(target)}')
            emit({'id':request['id'], 'result':{'captureId':args['captureId'],'files':1}})
        elif method == 'sync':
            # 写类操作的最小真实形态：按 worldId 回一份新句柄（真实 worker 会在这里写引擎别名/镜像）。
            # 已 prepared 的世界（initialPauseSupport）保留自己的暂停能力位：真实引擎 sync 后仍保留它。
            sync_world = args.get('worldId') or world or 'fake-world'
            sync_handle = prepared.get(sync_world, handle_of(sync_world))
            emit({'id': request['id'], 'result': {**sync_handle, 'appliedSceneRevision': args.get('snapshot', {}).get('revision', 0)}})
        elif method == 'list_worlds':
            emit({'id': request['id'], 'result': [prepared.get(name, handle_of(name)) for name in worlds]})
        elif method == 'set_paused' and args.get('worldId') in prepared:
            asked = args['worldId']
            prepared[asked]['status'] = 'paused' if args['paused'] else 'ready'
            emit({'id': request['id'], 'result': prepared[asked]})
        elif method in ('capture', 'capture_multi', 'camera_dataset_export'):
            # 落盘类请求：真实 worker 会把产物写到被指定的 outputDir（越界时由它自己的沙箱拒绝）。
            # 这里记录**实际收到的 outputDir**——Host 有没有做媒体中转（改写成 <运行根>/staging/media-N）
            # 只能从 worker 收到的路径上看出来；`captureWrites: false` 时只回执不写（用来把
            # “Host 代写”与“worker 自己写”两件事分开）。
            options = args.get('options', {})
            capture_dir = options.get('outputDir')
            marker(f'{method} outputDir={capture_dir}')
            if plan.get('captureError'):
                emit({'id': request['id'], 'error': {'code': 'CAPTURE_DENIED', 'message': str(plan['captureError'])}})
            elif plan.get('captureWrites') is False:
                emit({'id': request['id'], 'result': {'path': os.path.join(capture_dir or '', 'shot.png'), 'writtenByWorker': False}})
            else:
                os.makedirs(capture_dir, exist_ok=True)
                with open(os.path.join(capture_dir, 'shot.png'), 'w') as handle:
                    handle.write('fake-capture')
                marker(f'capture-written {capture_dir}')
                emit({'id': request['id'], 'result': {'path': os.path.join(capture_dir, 'shot.png'), 'writtenByWorker': True, **({'captureId':'fixture-capture'} if plan.get('rememberCapture') else {})}})
        elif method == 'observe':
            if plan.get('observeDelayMs'):
                time.sleep(float(plan['observeDelayMs']) / 1000)
            asked = args.get('worldId') or world or 'fake-world'
            # stillAlive 由 worker 自己的世界表得出：被取消的 open 若在 worker 里留了孤儿、
            # 或取消把同 worker 的其它 world 一起带走，这个读数会直接暴露出来。
            frame = frame_of(asked)
            if asked in prepared:
                frame.update(stepIndex=0, simTime=0.0, frameId=f'{asked}:1:0')
            emit({'id': request['id'], 'result': {**frame, 'stillAlive': asked in worlds}})
        elif method == 'stop':
            emit({'id': request['id'], 'result': {'stopped': True, 'stepIndex': 7, 'receipts': [], 'affectedEntityIds': []}})
        elif method == 'close':
            emit({'event': 'phase', 'phase': 'world-close-request', 'elapsedS': 0.0})
            if plan.get('closeDelayMs'):
                time.sleep(float(plan['closeDelayMs']) / 1000)
            closed = args.get('worldId')
            if closed in worlds:
                worlds.remove(closed)
            if world == closed:
                world = None
            marker(f'closed {closed}')
            emit({'event': 'phase', 'phase': 'world-closed', 'elapsedS': 0.0})
            emit({'id': request['id'], 'result': None})
        elif method == 'shutdown':
            if plan.get('ignoreShutdown'):
                marker('shutdown-ignored')
                continue
            if plan.get('closeDelayMs'):
                time.sleep(float(plan['closeDelayMs']) / 1000)
            emit({'id': request['id'], 'result': None})
            emit({'event': 'phase', 'phase': 'shutdown-world-closed', 'elapsedS': 0.0})
            emit({'event': 'phase', 'phase': 'shutdown-app-close', 'elapsedS': 0.0})
            marker('shutdown-done')
            return
        else:
            emit({'id': request['id'], 'error': {'code': 'UNKNOWN_METHOD', 'message': str(method)}})
    marker('stdin-eof')
    if plan.get('ignoreShutdown'):
        # 卡死的进程不会因为 stdin 关闭而退出：只有信号能结束它。
        while True:
            time.sleep(0.1)


main()
