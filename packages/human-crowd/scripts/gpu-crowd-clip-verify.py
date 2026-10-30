"""必需真实CUDA的人群级clip/FK/写回目标数值门；冻结标量与CPU写回公式独验，不证明World/RTF/渲染。

CrowdPoseBatch：全体clip行人单graph（Kernel A逐骨局部姿态 + Kernel B每人FK+site/段写回目标）。
世界骨对同输入MixedClipBatch逐位一致；site局部与段中心/四元数对CPU write_clip_group公式≤1e-12。"""
import argparse
import contextlib
import copy
import hashlib
import importlib.util
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'sim-mujoco/python'))
import human_gpu_multi as gpu


def load_reference(path):
    spec = importlib.util.spec_from_file_location('frozen_crowd_gpu_reference', path)
    ref = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ref)
    return ref


@contextlib.contextmanager
def calls():
    """核对真实Warp入口调用；graph内部节点由已捕获的copy/kernel/copy代码固定。"""
    counts = {name: 0 for name in ['copy', 'launch', 'capture_launch', 'synchronize_stream']}
    originals = {name: getattr(gpu.wp, name) for name in counts}
    counts.update({'capturedH2D': 0, 'capturedD2H': 0, 'capturedKernels': 0})
    def wrap(name):
        def counted(*values, **options):
            counts[name] += 1
            stream = options.get('stream')
            if stream is not None and stream.device.captures:
                if name == 'launch':
                    counts['capturedKernels'] += 1
                if name == 'copy':
                    if values[0].device.is_cuda and values[1].device.is_cpu:
                        counts['capturedH2D'] += 1
                    elif values[0].device.is_cpu and values[1].device.is_cuda:
                        counts['capturedD2H'] += 1
            return originals[name](*values, **options)
        return counted
    try:
        for name in originals:
            setattr(gpu.wp, name, wrap(name))
        yield counts
    finally:
        for name, original in originals.items():
            setattr(gpu.wp, name, original)


def edge_definitions(base):
    rows = []
    for case, extra in enumerate([0, 1, 2, 47]):
        cfg = copy.deepcopy(base)
        names = [joint['name'] for joint in cfg['rig']]
        for i in range(extra):
            cfg['rig'].append({'name': 'GpuQaLeaf'+str(i), 'parent': names[i],
                               'offsetM': [.013*(i+1), -.002, .005],
                               'quaternionXyzw': [0., math.sin(.11), 0., math.cos(.11)]})
        tracks = []
        for i, dot in enumerate([.9995-1e-12, .9995, .9995+1e-12]):
            tracks.append({'joint': names[i], 'timesS': [0., 1.], 'rotationsXyzw':
                           [[0., 0., 0., 1.], [math.sqrt(1-dot*dot), 0., 0., dot]], 'interpolation': 'LINEAR'})
        tracks.append({'joint': names[3], 'timesS': [0., .5, 1.], 'rotationsXyzw':
                       [[0., 0., 0., 1.], [0., 0., 1., 0.], [0., 0., 0., -1.]], 'interpolation': 'STEP'})
        duration = [1., 1.3, .7, 2.1][case]
        cfg['clips'] = [{'name': 'GpuBoundaryFixture', 'durationS': duration, 'tracks': tracks,
                         'translations': [{'joint': names[0], 'timesS': [0., .33, .67, 1.],
                          'positionsM': [[0., 0., 0.], [.1, -.2, .03], [-.04, .01, .1], [0., 0., 0.]],
                          'interpolation': 'STEP'}]}]
        if case in (1, 2):
            cfg['clips'][0]['rootMotion'] = {'joint': names[3], 'horizontal': 'remove' if case == 1 else 'remove-drift',
                                              'baselineM': [.1, -.03, .2], 'driftM': [.02, -.04, 0.]}
        rows.append(('显式SLERP/STEP/附加叶骨数值夹具'+str(extra)+'，非资源动作', cfg))
    return rows


def segments_for(cfg, ref):
    """按_humanSegments同序的14段：GPU desc + CPU独立参考用的segment dict。"""
    names = [joint['name'] for joint in cfg['rig']]
    order = {name: i for i, name in enumerate(names)}
    desc, segments = [], []
    for a, b, _ in ref.SEGMENTS:
        segment = {'a': cfg['boneMapping'][a], 'b': cfg['boneMapping'][b],
                   'calibration': ref.segment_calibration(cfg, a, b)}
        segments.append(segment)
        if segment['calibration']:
            desc.append({'joint': order[segment['calibration']['frameJoint']],
                         'p0': list(segment['calibration']['endpointsM'][0]),
                         'p1': list(segment['calibration']['endpointsM'][1])})
        else:
            desc.append({'a': order[segment['a']], 'b': order[segment['b']]})
    return desc, segments


def mju_quat2mat(q):
    # 与原生mju_quat2Mat同一公式；CPU write_clip_group的site局部位移用此矩阵。
    w, x, y, z = q
    return np.array([[w*w+x*x-y*y-z*z, 2*(x*y-w*z), 2*(x*z+w*y)],
                     [2*(x*y+w*z), w*w-x*x+y*y-z*z, 2*(y*z-w*x)],
                     [2*(x*z-w*y), 2*(y*z+w*x), w*w-x*x-y*y+z*z]])


def z_quaternion(direction):
    # human_batch.z_quaternion单项移植：atan2/hypot、1e-15阈值、反向Z=[0,1,0,0]。
    length = float(np.linalg.norm(direction))
    unit = direction/max(length, 1e-30)
    axis_length = float(np.hypot(unit[0], unit[1]))
    q = np.array([1., 0., 0., 0.])
    if length >= 1e-15:
        if axis_length >= 1e-15:
            half = np.arctan2(axis_length, unit[2])/2
            sine = np.sin(half)/axis_length
            q = np.array([np.cos(half), -unit[1]*sine, unit[0]*sine, 0.])
        elif unit[2] < 0:
            q = np.array([0., 1., 0., 0.])
    return q


def cpu_targets(ref, cfg, names, expected, root, q, segments):
    """CPU write_clip_group同式：site局部=Rᵀ·(world−root)/conj(q)*world_q；段中心/四元数。"""
    n = len(names)
    wp_ = np.asarray([expected[name][0] for name in names])
    wq_ = np.asarray([expected[name][1] for name in names])
    matrix = mju_quat2mat(np.asarray(q, dtype=float))
    local_p = (wp_-np.asarray(root, dtype=float)) @ matrix
    conj = np.asarray([q[0], -q[1], -q[2], -q[3]], dtype=float)
    local_q = np.asarray([ref.mul(conj, wq_[i]) for i in range(n)])
    centers = np.empty((len(segments), 3))
    quats = np.empty((len(segments), 4))
    for s, segment in enumerate(segments):
        a, b = ref.segment_points(expected, segment)
        centers[s] = (a+b)/2
        quats[s] = z_quaternion(np.asarray(b)-np.asarray(a))
    return local_p, local_q, centers, quats


def verify_group(definitions, clip_offset, variant, ref, args, roots, qs, phases):
    entries, labels = [], []
    segment_rows = []
    for i in range(20):
        label, cfg = definitions[i % len(definitions)]
        clip = cfg['clips'][(i // len(definitions) + clip_offset) % len(cfg['clips'])]
        desc, segments = segments_for(cfg, ref)
        entries.append((cfg, clip['name'], desc))
        segment_rows.append(segments)
        labels.append({'definition': label, 'clip': clip['name'], 'durationS': clip['durationS'],
                       'bones': len(cfg['rig']), 'segments': len(desc)})
    with calls() as prepare_calls:
        batch = gpu.CrowdPoseBatch(entries, device=args.device, cache_root=args.cache)
    assert prepare_calls['copy'] >= 15, prepare_calls  # 构造时另有不可变描述上传，不计入每次采样。
    # graph：H2D + 局部姿态A + FK(B1) + site派生(C) + 段派生(C) + 3×D2H。
    assert {key: value for key, value in prepare_calls.items() if key != 'copy'} == {
        'launch': 8, 'capture_launch': 0, 'synchronize_stream': 1,
        'capturedH2D': 1, 'capturedD2H': 3, 'capturedKernels': 4}, prepare_calls
    mixed_entries = [(cfg, clip_name) for cfg, clip_name, _ in entries]
    mixed = gpu.MixedClipBatch(mixed_entries, device=args.device, cache_root=args.cache)
    maximum, site_max, seg_max, samples = 0., 0., 0., 0
    previous = None
    try:
        facts = batch.facts()
        assert facts['uuid'] == args.expected_uuid, facts
        assert facts['dtype'] == 'float64' and facts['fastMath'] is False and facts['fuseFp'] is False
        assert facts['graphReplays'] == 0 and facts['d2hCopies'] == 0
        assert batch.count == 20 and len(set(label['definition'] for label in labels)) >= 4
        assert batch.bone_counts == tuple(label['bones'] for label in labels)
        assert batch.seg_counts == tuple(label['segments'] for label in labels)
        # 每人使用自己的duration/key边界；混合负phase和不同elapsed，不按clip分小组。
        with calls() as sample_calls:
            for step in range(43):
                elapsed = np.empty(20)
                current_phases = phases + step*.0013
                for i, (cfg, clip_name, _) in enumerate(entries):
                    clip = next(c for c in cfg['clips'] if c['name'] == clip_name)
                    duration = clip['durationS']
                    if step < 31:
                        elapsed[i] = duration * step / 15. - i*.0001
                    else:
                        keys = [0., duration, .33, .5, .67, 1.]
                        elapsed[i] = keys[(step-31)//2] + (-1e-12 if step % 2 else 1e-12) - current_phases[i]*duration
                current_roots = roots + np.array([step*.013, -.003*step, .0001*step])
                active = np.arange(20)
                out = batch.sample(active, current_roots, qs, elapsed, current_phases)
                world_p, world_q, site_p, site_q, centers, seg_q = out
                mixed_p, mixed_q = mixed.sample(current_roots, qs, elapsed, current_phases)
                # 世界骨须与同输入MixedClipBatch逐位一致。
                for i in range(20):
                    n = batch.bone_counts[i]
                    assert np.array_equal(world_p[i, :n], mixed_p[i, :n]), '世界骨位置未逐位一致'
                    assert np.array_equal(world_q[i, :n], mixed_q[i, :n]), '世界骨四元数未逐位一致'
                    assert np.count_nonzero(world_p[i, n:]) == 0 and np.count_nonzero(world_q[i, n:]) == 0
                maximum = max(maximum, float(np.max(np.abs(world_p[active][:, :batch.max_bones, :]
                                                          - mixed_p[:, :batch.max_bones, :]))))
                if previous is not None:
                    assert np.array_equal(previous[0], previous[1]), '下次graph覆盖了之前返回的独立数组'
                previous = (centers, centers.copy())
                for i, (cfg, clip_name, _) in enumerate(entries):
                    expected = ref.pose({**cfg, 'phase': float(current_phases[i])}, current_roots[i], qs[i],
                                        float(elapsed[i]), 'walk', 1.402, clip_name)
                    names = batch.names[i]
                    n = batch.bone_counts[i]
                    ep = np.asarray([expected[name][0] for name in names])
                    eq = np.asarray([expected[name][1] for name in names])
                    maximum = max(maximum, float(np.max(np.abs(ep-world_p[i, :n]))),
                                  float(np.max(np.abs(eq-world_q[i, :n]))))
                    lp, lq, ec, eqq = cpu_targets(ref, cfg, names, expected, current_roots[i], qs[i],
                                                  segment_rows[i])
                    site_max = max(site_max, float(np.max(np.abs(lp-site_p[i, :n]))),
                                   float(np.max(np.abs(lq-site_q[i, :n]))))
                    s = batch.seg_counts[i]
                    seg_max = max(seg_max, float(np.max(np.abs(ec-centers[i, :s]))),
                                  float(np.max(np.abs(eqq-seg_q[i, :s]))))
                    assert np.count_nonzero(centers[i, s:]) == 0 and np.count_nonzero(seg_q[i, s:]) == 0
                    samples += 1
            # 计数含同循环内MixedClipBatch参照批的43次graph replay+sync；每批各1次/次采样。
            assert sample_calls == {'copy': 0, 'launch': 0, 'capture_launch': 86, 'synchronize_stream': 86,
                                    'capturedH2D': 0, 'capturedD2H': 0, 'capturedKernels': 0}, sample_calls
        # 部分活跃行：未参与行保留上次有限输入并仍被graph计算，但只核对活跃行输出。
        last_inputs = {'roots': roots.copy(), 'qs': qs.copy(),
                       'elapsed': np.zeros(20), 'phases': phases.copy()}
        batch.sample(np.arange(20), roots, qs, np.zeros(20), phases)
        partial = np.array([0, 3, 7, 11, 19])
        pr = roots[partial] + .5
        pe = np.full(5, .37)
        pp = phases[partial] + .25
        out = batch.sample(partial, pr, qs[partial], pe, pp)
        for j, member in enumerate(partial):
            cfg, clip_name, _ = entries[member]
            expected = ref.pose({**cfg, 'phase': float(pp[j])}, pr[j], qs[member], float(pe[j]),
                                'walk', 1.402, clip_name)
            names = batch.names[member]
            n = batch.bone_counts[member]
            ep = np.asarray([expected[name][0] for name in names])
            eq = np.asarray([expected[name][1] for name in names])
            assert np.array_equal(ep, out[0][j, :n]) or np.max(np.abs(ep-out[0][j, :n])) < 1e-12
            assert np.array_equal(eq, out[1][j, :n]) or np.max(np.abs(eq-out[1][j, :n])) < 1e-12
            last_inputs['roots'][member] = pr[j]
            last_inputs['elapsed'][member] = pe[j]
            last_inputs['phases'][member] = pp[j]
        # 再次全员采样：每人按各自最后输入重算，输出仍须对冻结参考。
        out = batch.sample(np.arange(20), last_inputs['roots'], qs, last_inputs['elapsed'], last_inputs['phases'])
        for i, (cfg, clip_name, _) in enumerate(entries):
            expected = ref.pose({**cfg, 'phase': float(last_inputs['phases'][i])}, last_inputs['roots'][i],
                                qs[i], float(last_inputs['elapsed'][i]), 'walk', 1.402, clip_name)
            names = batch.names[i]
            n = batch.bone_counts[i]
            ep = np.asarray([expected[name][0] for name in names])
            assert np.max(np.abs(ep-out[0][i, :n])) < 1e-12, '停住行输出未保留上次有限输入'
        assert maximum < 1e-12 and site_max < 1e-12 and seg_max < 1e-12, (maximum, site_max, seg_max)
        result = {'variant': variant, 'clipOffset': clip_offset, 'actors': labels, 'samples': samples,
                  'maxAbsDifference': maximum, 'siteLocalMaxDifference': site_max,
                  'segmentMaxDifference': seg_max, 'worldVsMixedBitwise': True,
                  'partialActiveRows': True, 'staleMemberInputsRetained': True,
                  'prepareWarpCalls': prepare_calls, 'sampleWarpCalls': sample_calls, 'gpu': batch.facts()}
    finally:
        batch.close()
        mixed.close()
    batch.close()
    assert batch.closed and batch.graph is None and batch.stream is None and batch.immutable is None
    try:
        batch.sample(np.arange(20), roots, qs, np.zeros(20), phases)
    except gpu.HumanGpuError as exc:
        assert exc.code == 'HUMAN_GPU_CLOSED'
    else:
        raise AssertionError('释放后的批执行了graph')
    result['gpuAfterClose'] = batch.facts()
    print(json.dumps({key: result[key] for key in ['variant', 'clipOffset', 'samples', 'maxAbsDifference',
                                                  'siteLocalMaxDifference', 'segmentMaxDifference']},
                     ensure_ascii=False), flush=True)
    return result


def lifecycle(entries, roots, qs, phases, args):
    device = gpu.wp.get_device(args.device)
    before = set(device.captures)
    original_copy = gpu.wp.copy
    def fail_during_capture(*values, **options):
        if device.captures:
            raise RuntimeError('HUMAN_GPU_CROWD_TEST_CAPTURE_FAILURE')
        return original_copy(*values, **options)
    gpu.wp.copy = fail_during_capture
    try:
        try:
            gpu.CrowdPoseBatch(entries, device=args.device, cache_root=args.cache)
        except RuntimeError as exc:
            assert 'HUMAN_GPU_CROWD_TEST_CAPTURE_FAILURE' in str(exc), str(exc)
        else:
            raise AssertionError('捕获故障未实际触发')
    finally:
        gpu.wp.copy = original_copy
    assert set(device.captures) == before
    first = gpu.CrowdPoseBatch(entries, device=args.device, cache_root=args.cache)
    second = gpu.CrowdPoseBatch(entries, device=args.device, cache_root=args.cache)
    try:
        first.close()
        active = np.arange(len(entries))
        second.sample(active, roots, qs, np.zeros(len(entries)), phases)
        original_launch = gpu.wp.capture_launch
        def fail_launch(*values, **options):
            raise RuntimeError('HUMAN_GPU_CROWD_TEST_LAUNCH_FAILURE')
        gpu.wp.capture_launch = fail_launch
        count = second.calls
        try:
            try:
                second.sample(active, roots, qs, np.zeros(len(entries)), phases)
            except RuntimeError as exc:
                assert 'HUMAN_GPU_CROWD_TEST_LAUNCH_FAILURE' in str(exc)
            else:
                raise AssertionError('graph提交故障未触发')
        finally:
            gpu.wp.capture_launch = original_launch
        assert second.calls == count
        second.sample(active, roots, qs, np.zeros(len(entries)), phases)
        invalid = phases.copy()
        invalid[0] = np.nan
        try:
            second.sample(active, roots, qs, np.zeros(len(entries)), invalid)
        except gpu.HumanGpuError as exc:
            assert exc.code == 'HUMAN_GPU_NONFINITE'
        else:
            raise AssertionError('非有限输入被执行')
        second.sample(active, roots, qs, np.zeros(len(entries)), phases)
    finally:
        first.close()
        second.close()
    assert set(device.captures) == before
    try:
        gpu.CrowdPoseBatch(entries, device='cpu', cache_root=args.cache)
    except gpu.HumanGpuError as exc:
        assert exc.code == 'HUMAN_CUDA_UNAVAILABLE'
    else:
        raise AssertionError('显式GPU落回CPU')
    cfg = copy.deepcopy(entries[0][0])
    immutable = gpu.CrowdPoseBatch([(cfg, entries[0][1], entries[0][2])]*20,
                                   device=args.device, cache_root=args.cache)
    try:
        active = np.arange(20)
        before_pose = immutable.sample(active, roots, qs, np.zeros(20), phases)
        cfg['rig'][0]['offsetM'][0] += 99.
        cfg['clips'][0]['durationS'] += 99.
        after_pose = immutable.sample(active, roots, qs, np.zeros(20), phases)
        assert all(np.array_equal(a, b) for a, b in zip(before_pose, after_pose)), '调用方描述修改影响已冻结GPU描述'
    finally:
        immutable.close()
    return {'captureFailureAndRecovery': True, 'launchFailureAndRecovery': True,
            'descriptionSnapshotIndependent': True, 'closeOneKeepsOther': True,
            'explicitCpuRejected': True, 'nonfiniteInputRejectedAndRecovered': True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--definition', required=True, action='append')
    parser.add_argument('--reference-human', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--device', default='cuda:0')
    parser.add_argument('--expected-uuid', required=True)
    parser.add_argument('--cache', required=True)
    args = parser.parse_args()
    assert len(args.definition) >= 4, '真实导入定义至少4个；可为同一源的不同单位/heading导入，不能冒充4种外观'
    path = Path(args.reference_human).resolve()
    expected_reference = '7d1537fac7a0aae78144246d4eda0141178c74bdc8c00179e76998a914fff435'
    assert hashlib.sha256(path.read_bytes()).hexdigest() == expected_reference, '参考须为独立冻结a089 human.py原字节'
    ref = load_reference(path)
    definitions = [(str(Path(name).resolve()), json.loads(Path(name).read_text())) for name in args.definition]
    rng = np.random.default_rng(42)
    roots = rng.normal(size=(20, 3))
    qs = rng.normal(size=(20, 4))
    qs /= np.linalg.norm(qs, axis=1)[:, None]
    qs[:4] = [[1., 0., 0., 0.], [math.cos((math.pi-1e-12)/2), math.sin((math.pi-1e-12)/2), 0., 0.],
              [0., 0., 1., 0.], [-1., 0., 0., 0.]]
    phases = np.arange(20)*.61803398875 % 1
    phases[:8] = [-.25, 1.25, -1.25, 2., -2., -1e-12, 1+1e-12, 1000.37]
    results = []
    for variant in ['original', 'antipodal']:
        rows = copy.deepcopy(definitions)
        if variant == 'antipodal':
            for _, cfg in rows:
                for clip in cfg['clips']:
                    for track in clip['tracks']:
                        for i, q in enumerate(track['rotationsXyzw']):
                            if i % 2:
                                track['rotationsXyzw'][i] = [-value for value in q]
        for _, cfg in rows:
            cfg['_poseRuntime'] = ref.compile_pose(cfg)
        for offset in range(max(len(cfg['clips']) for _, cfg in rows)):
            results.append(verify_group(rows, offset, variant, ref, args, roots, qs, phases))
    edges = edge_definitions(definitions[0][1])
    for _, cfg in edges:
        cfg['_poseRuntime'] = ref.compile_pose(cfg)
    results.append(verify_group(edges, 0, 'SLERP/STEP/不同duration/骨数夹具', ref, args, roots, qs, phases))
    entries = []
    for i in range(20):
        cfg = definitions[i % len(definitions)][1]
        desc, _ = segments_for(cfg, ref)
        entries.append((cfg, cfg['clips'][0]['name'], desc))
    recovery = lifecycle(entries, roots, qs, phases, args)
    batch = gpu.CrowdPoseBatch(entries, device=args.device, cache_root=args.cache)
    try:
        active = np.arange(20)
        for _ in range(10):
            batch.sample(active, roots, qs, np.zeros(20), phases)
        started = time.perf_counter()
        for i in range(200):
            batch.sample(active, roots, qs, np.full(20, i*.002), phases)
        local_s = time.perf_counter()-started
        local = {'scope': '仅20演员人群sample(含site/段写回目标)，含Python输入/输出copy/graph/sync；不是World或RTF',
                 'calls': 200, 'totalS': local_s, 'meanMs': local_s*1000/200, 'gpu': batch.facts()}
    finally:
        batch.close()
    report = {'status': 'PASSED', 'scope': '必需真实CUDA人群clip/FK/写回目标及生命周期；未证明World/物理/实时/RTX渲染',
              'definitions': len(definitions), 'actorsPerBatch': 20,
              'samples': sum(row['samples'] for row in results),
              'maxAbsDifference': max(row['maxAbsDifference'] for row in results),
              'siteLocalMaxDifference': max(row['siteLocalMaxDifference'] for row in results),
              'segmentMaxDifference': max(row['segmentMaxDifference'] for row in results),
              'worldVsMixedBitwise': all(row['worldVsMixedBitwise'] for row in results),
              'threshold': 1e-12, 'referenceSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
              'gpuSourceSha256': hashlib.sha256(Path(gpu.__file__).read_bytes()).hexdigest(),
              'primitiveSourceSha256': hashlib.sha256(Path(gpu.__file__).with_name('human_gpu.py').read_bytes()).hexdigest(),
              'definitionSha256': {name: hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in args.definition},
              'recovery': recovery, 'localSampleCost': local, 'closed': True, 'results': results}
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({key: value for key, value in report.items() if key not in ['results', 'definitionSha256']},
                     ensure_ascii=False))


if __name__ == '__main__':
    main()
