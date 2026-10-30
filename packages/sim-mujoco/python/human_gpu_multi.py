"""异构rig/clip的精确CUDA数学合批；只拥有只读描述和GPU buffer/graph。"""
import contextlib
import os
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
from human_gpu import D, HumanGpuError, multiply, rotate, wp

wp.set_module_options({'enable_backward': False, 'fast_math': False, 'fuse_fp': False})


@wp.func
def mixed_slot(times: wp.array(dtype=D), start: int, count: int, t: D):
    # 等价于searchsorted(side='right')；精确保留key边界与首尾clamp语义。
    low = int(0)
    high = count
    while low < high:
        middle = (low + high) // 2
        if t >= times[start + middle]:
            low = middle + 1
        else:
            high = middle
    i = wp.max(0, low - 1)
    j = wp.min(i + 1, count - 1)
    u = D(0)
    denominator = times[start + j] - times[start + i]
    if denominator > D(0):
        u = wp.clamp((t-times[start + i])/denominator, D(0), D(1))
    return wp.vec3d(D(i), D(j), u)


@wp.kernel
def mixed_clip_fk(
    inputs: wp.array2d(dtype=D), actors: wp.array2d(dtype=wp.int32),
    clips: wp.array2d(dtype=D), parents: wp.array(dtype=wp.int32),
    offsets: wp.array2d(dtype=D), rest: wp.array2d(dtype=D),
    r_index: wp.array2d(dtype=wp.int32), r_times: wp.array(dtype=D),
    r_values: wp.array2d(dtype=D), t_index: wp.array2d(dtype=wp.int32),
    t_times: wp.array(dtype=D), t_values: wp.array2d(dtype=D),
    max_bones: int, output: wp.array3d(dtype=D),
):
    actor = wp.tid()
    start = actors[actor, 0]
    bones = actors[actor, 1]
    motion_kind = actors[actor, 2]
    motion_joint = actors[actor, 3]
    duration = clips[actor, 0]
    root = wp.vec3d(inputs[actor, 0], inputs[actor, 1], inputs[actor, 2])
    root_q = wp.vec4d(inputs[actor, 3], inputs[actor, 4], inputs[actor, 5], inputs[actor, 6])
    t = (inputs[actor, 7] + inputs[actor, 8] * duration) % duration
    # Warp使用fmod；冻结标量参考使用Python正余数，负phase必须保留该语义。
    if t < D(0):
        t = t + duration
    if t == D(0):
        t = D(0)
    for joint in range(bones):
        row = start + joint
        q = wp.vec4d(rest[row, 0], rest[row, 1], rest[row, 2], rest[row, 3])
        v = wp.vec3d(offsets[row, 0], offsets[row, 1], offsets[row, 2])
        rs = r_index[row, 0]
        rc = r_index[row, 1]
        if rc > 0:
            indices = mixed_slot(r_times, rs, rc, t)
            i = rs + int(indices[0])
            j = rs + int(indices[1])
            u = indices[2]
            if r_index[row, 2] == 1:
                u = D(0)
            a = wp.vec4d(r_values[i, 0], r_values[i, 1], r_values[i, 2], r_values[i, 3])
            b = wp.vec4d(r_values[j, 0], r_values[j, 1], r_values[j, 2], r_values[j, 3])
            dot = a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3]
            if dot < D(0):
                b = -b
                dot = -dot
            if dot > D(.9995):
                q = (D(1)-u)*a + u*b
                q = q / wp.sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3])
            else:
                theta = wp.acos(wp.clamp(dot, D(-1), D(1)))
                q = (wp.sin((D(1)-u)*theta)*a + wp.sin(u*theta)*b) / wp.sin(theta)
        ts = t_index[row, 0]
        tc = t_index[row, 1]
        if tc > 0:
            indices = mixed_slot(t_times, ts, tc, t)
            i = ts + int(indices[0])
            j = ts + int(indices[1])
            u = indices[2]
            if t_index[row, 2] == 1:
                u = D(0)
            v = ((D(1)-u)*wp.vec3d(t_values[i, 0], t_values[i, 1], t_values[i, 2])
                 + u*wp.vec3d(t_values[j, 0], t_values[j, 1], t_values[j, 2]))
        parent = parents[row]
        p = root
        pq = root_q
        if parent >= 0:
            p = wp.vec3d(output[actor, parent, 0], output[actor, parent, 1], output[actor, parent, 2])
            pq = wp.vec4d(output[actor, parent, 3], output[actor, parent, 4], output[actor, parent, 5], output[actor, parent, 6])
        p = p + rotate(pq, v)
        q = multiply(pq, q)
        for k in range(3):
            output[actor, joint, k] = p[k]
        for k in range(4):
            output[actor, joint, 3+k] = q[k]
    if motion_kind > 0:
        shift = wp.vec3d(D(0), D(0), D(0))
        if motion_kind == 1:
            shift = wp.vec3d(clips[actor, 1], clips[actor, 2], clips[actor, 3]) * (t/duration)
        else:
            inverse = wp.vec4d(root_q[0], -root_q[1], -root_q[2], -root_q[3])
            local = rotate(inverse, wp.vec3d(output[actor, motion_joint, 0], output[actor, motion_joint, 1], output[actor, motion_joint, 2])-root)
            shift = wp.vec3d(local[0]-clips[actor, 4], local[1]-clips[actor, 5], D(0))
        shift = rotate(root_q, shift)
        for joint in range(bones):
            for k in range(3):
                output[actor, joint, k] = output[actor, joint, k] - shift[k]
    # Padding不代表实际骨骼；只使不同骨数的输出确定、有限且便于只读投影。
    for joint in range(bones, max_bones):
        for k in range(7):
            output[actor, joint, k] = D(0)


@wp.kernel
def crowd_local_fk(
    inputs: wp.array2d(dtype=D), actors: wp.array2d(dtype=wp.int32),
    clips: wp.array2d(dtype=D), parents: wp.array(dtype=wp.int32),
    offsets: wp.array2d(dtype=D), rest: wp.array2d(dtype=D),
    r_index: wp.array2d(dtype=wp.int32), r_times: wp.array(dtype=D),
    r_values: wp.array2d(dtype=D), t_index: wp.array2d(dtype=wp.int32),
    t_times: wp.array(dtype=D), t_values: wp.array2d(dtype=D),
    max_bones: int, local: wp.array3d(dtype=D),
):
    # Kernel A：每线程一根骨，track采样/插值/STEP与mixed_clip_fk逐骨部分完全同式；
    # 只产出局部q(wxyz)/v，不做FK合成（合成在Kernel B按拓扑序进行）。
    tid = wp.tid()
    actor = tid // max_bones
    joint = tid - actor * max_bones
    bones = actors[actor, 1]
    if joint >= bones:
        for k in range(7):
            local[actor, joint, k] = D(0)
        return
    duration = clips[actor, 0]
    t = (inputs[actor, 7] + inputs[actor, 8] * duration) % duration
    if t < D(0):
        t = t + duration
    if t == D(0):
        t = D(0)
    row = actors[actor, 0] + joint
    q = wp.vec4d(rest[row, 0], rest[row, 1], rest[row, 2], rest[row, 3])
    v = wp.vec3d(offsets[row, 0], offsets[row, 1], offsets[row, 2])
    rs = r_index[row, 0]
    rc = r_index[row, 1]
    if rc > 0:
        indices = mixed_slot(r_times, rs, rc, t)
        i = rs + int(indices[0])
        j = rs + int(indices[1])
        u = indices[2]
        if r_index[row, 2] == 1:
            u = D(0)
        a = wp.vec4d(r_values[i, 0], r_values[i, 1], r_values[i, 2], r_values[i, 3])
        b = wp.vec4d(r_values[j, 0], r_values[j, 1], r_values[j, 2], r_values[j, 3])
        dot = a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3]
        if dot < D(0):
            b = -b
            dot = -dot
        if dot > D(.9995):
            q = (D(1)-u)*a + u*b
            q = q / wp.sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3])
        else:
            theta = wp.acos(wp.clamp(dot, D(-1), D(1)))
            q = (wp.sin((D(1)-u)*theta)*a + wp.sin(u*theta)*b) / wp.sin(theta)
    ts = t_index[row, 0]
    tc = t_index[row, 1]
    if tc > 0:
        indices = mixed_slot(t_times, ts, tc, t)
        i = ts + int(indices[0])
        j = ts + int(indices[1])
        u = indices[2]
        if t_index[row, 2] == 1:
            u = D(0)
        v = ((D(1)-u)*wp.vec3d(t_values[i, 0], t_values[i, 1], t_values[i, 2])
             + u*wp.vec3d(t_values[j, 0], t_values[j, 1], t_values[j, 2]))
    local[actor, joint, 0] = v[0]
    local[actor, joint, 1] = v[1]
    local[actor, joint, 2] = v[2]
    local[actor, joint, 3] = q[0]
    local[actor, joint, 4] = q[1]
    local[actor, joint, 5] = q[2]
    local[actor, joint, 6] = q[3]


@wp.kernel
def crowd_world_fk(
    inputs: wp.array2d(dtype=D), actors: wp.array2d(dtype=wp.int32),
    clips: wp.array2d(dtype=D), parents: wp.array(dtype=wp.int32),
    local: wp.array3d(dtype=D),
    max_bones: int,
    world_out: wp.array3d(dtype=D),
):
    # Kernel B1：每线程一人，只按拓扑序FK+rootMotion（与mixed_clip_fk后半段完全同式），
    # 产出最终世界骨；site/段写回目标由后续并行kernel按相同公式逐元推导。
    actor = wp.tid()
    start = actors[actor, 0]
    bones = actors[actor, 1]
    motion_kind = actors[actor, 2]
    motion_joint = actors[actor, 3]
    duration = clips[actor, 0]
    root = wp.vec3d(inputs[actor, 0], inputs[actor, 1], inputs[actor, 2])
    root_q = wp.vec4d(inputs[actor, 3], inputs[actor, 4], inputs[actor, 5], inputs[actor, 6])
    for joint in range(bones):
        row = start + joint
        v = wp.vec3d(local[actor, joint, 0], local[actor, joint, 1], local[actor, joint, 2])
        q = wp.vec4d(local[actor, joint, 3], local[actor, joint, 4], local[actor, joint, 5], local[actor, joint, 6])
        parent = parents[row]
        p = root
        pq = root_q
        if parent >= 0:
            p = wp.vec3d(world_out[actor, parent, 0], world_out[actor, parent, 1], world_out[actor, parent, 2])
            pq = wp.vec4d(world_out[actor, parent, 3], world_out[actor, parent, 4], world_out[actor, parent, 5], world_out[actor, parent, 6])
        p = p + rotate(pq, v)
        q = multiply(pq, q)
        for k in range(3):
            world_out[actor, joint, k] = p[k]
        for k in range(4):
            world_out[actor, joint, 3+k] = q[k]
    if motion_kind > 0:
        t = (inputs[actor, 7] + inputs[actor, 8] * duration) % duration
        if t < D(0):
            t = t + duration
        if t == D(0):
            t = D(0)
        shift = wp.vec3d(D(0), D(0), D(0))
        if motion_kind == 1:
            shift = wp.vec3d(clips[actor, 1], clips[actor, 2], clips[actor, 3]) * (t/duration)
        else:
            inverse = wp.vec4d(root_q[0], -root_q[1], -root_q[2], -root_q[3])
            local_root = rotate(inverse, wp.vec3d(world_out[actor, motion_joint, 0], world_out[actor, motion_joint, 1], world_out[actor, motion_joint, 2])-root)
            shift = wp.vec3d(local_root[0]-clips[actor, 4], local_root[1]-clips[actor, 5], D(0))
        shift = rotate(root_q, shift)
        for joint in range(bones):
            for k in range(3):
                world_out[actor, joint, k] = world_out[actor, joint, k] - shift[k]
    # Padding不代表实际骨骼；只使不同骨数的输出确定、有限且便于只读投影。
    for joint in range(bones, max_bones):
        for k in range(7):
            world_out[actor, joint, k] = D(0)


@wp.kernel
def crowd_site_derive(
    inputs: wp.array2d(dtype=D), actors: wp.array2d(dtype=wp.int32),
    world_out: wp.array3d(dtype=D),
    max_bones: int, site_local: wp.array3d(dtype=D),
):
    # Kernel C-site：每(人,骨)一线程。R按mju_quat2Mat公式；site局部平移=diff@R（=Rᵀ·diff），
    # 局部姿态=conj(root_q)*world_q，与CPU write_clip_group逐项同式。
    tid = wp.tid()
    actor = tid // max_bones
    joint = tid - actor * max_bones
    bones = actors[actor, 1]
    if joint >= bones:
        for k in range(7):
            site_local[actor, joint, k] = D(0)
        return
    root = wp.vec3d(inputs[actor, 0], inputs[actor, 1], inputs[actor, 2])
    root_q = wp.vec4d(inputs[actor, 3], inputs[actor, 4], inputs[actor, 5], inputs[actor, 6])
    qw = root_q[0]
    qx = root_q[1]
    qy = root_q[2]
    qz = root_q[3]
    r00 = qw*qw + qx*qx - qy*qy - qz*qz
    r11 = qw*qw - qx*qx + qy*qy - qz*qz
    r22 = qw*qw - qx*qx - qy*qy + qz*qz
    r01 = D(2)*(qx*qy - qw*qz)
    r02 = D(2)*(qx*qz + qw*qy)
    r10 = D(2)*(qx*qy + qw*qz)
    r12 = D(2)*(qy*qz - qw*qx)
    r20 = D(2)*(qx*qz - qw*qy)
    r21 = D(2)*(qy*qz + qw*qx)
    dx = world_out[actor, joint, 0] - root[0]
    dy = world_out[actor, joint, 1] - root[1]
    dz = world_out[actor, joint, 2] - root[2]
    site_local[actor, joint, 0] = dx*r00 + dy*r10 + dz*r20
    site_local[actor, joint, 1] = dx*r01 + dy*r11 + dz*r21
    site_local[actor, joint, 2] = dx*r02 + dy*r12 + dz*r22
    conj = wp.vec4d(root_q[0], -root_q[1], -root_q[2], -root_q[3])
    lq = multiply(conj, wp.vec4d(world_out[actor, joint, 3], world_out[actor, joint, 4],
                                 world_out[actor, joint, 5], world_out[actor, joint, 6]))
    for k in range(4):
        site_local[actor, joint, 3+k] = lq[k]


@wp.kernel
def crowd_seg_derive(
    actors: wp.array2d(dtype=wp.int32),
    world_out: wp.array3d(dtype=D),
    seg_index: wp.array2d(dtype=wp.int32), seg_points: wp.array2d(dtype=D),
    max_segs: int, seg_out: wp.array3d(dtype=D),
):
    # Kernel C-seg：每(人,段)一线程。规则段端点=两端世界骨；足段=anchor+rotate(q,endpointsM)；
    # center=(a+b)/2；段四元数与z_quaternion同式（atan2/hypot、1e-15阈值、反向Z=[0,1,0,0]）。
    tid = wp.tid()
    actor = tid // max_segs
    s = tid - actor * max_segs
    seg_count = actors[actor, 4]
    if s >= seg_count:
        for k in range(7):
            seg_out[actor, s, k] = D(0)
        return
    kind = seg_index[actor, s*3+2]
    if kind == 0:
        a = wp.vec3d(world_out[actor, seg_index[actor, s*3+0], 0],
                     world_out[actor, seg_index[actor, s*3+0], 1],
                     world_out[actor, seg_index[actor, s*3+0], 2])
        b = wp.vec3d(world_out[actor, seg_index[actor, s*3+1], 0],
                     world_out[actor, seg_index[actor, s*3+1], 1],
                     world_out[actor, seg_index[actor, s*3+1], 2])
    else:
        anchor = wp.vec3d(world_out[actor, seg_index[actor, s*3+1], 0],
                          world_out[actor, seg_index[actor, s*3+1], 1],
                          world_out[actor, seg_index[actor, s*3+1], 2])
        aq = wp.vec4d(world_out[actor, seg_index[actor, s*3+1], 3],
                      world_out[actor, seg_index[actor, s*3+1], 4],
                      world_out[actor, seg_index[actor, s*3+1], 5],
                      world_out[actor, seg_index[actor, s*3+1], 6])
        a = anchor + rotate(aq, wp.vec3d(seg_points[actor, s*6+0], seg_points[actor, s*6+1], seg_points[actor, s*6+2]))
        b = anchor + rotate(aq, wp.vec3d(seg_points[actor, s*6+3], seg_points[actor, s*6+4], seg_points[actor, s*6+5]))
    d = b - a
    length = wp.sqrt(d[0]*d[0] + d[1]*d[1] + d[2]*d[2])
    inv = D(1) / wp.max(length, D(1e-30))
    ux = d[0] * inv
    uy = d[1] * inv
    uz = d[2] * inv
    axis_length = wp.sqrt(ux*ux + uy*uy)
    sq = wp.vec4d(D(1), D(0), D(0), D(0))
    if length >= D(1e-15):
        if axis_length >= D(1e-15):
            half = wp.atan2(axis_length, uz) * D(.5)
            sine = wp.sin(half) / axis_length
            sq = wp.vec4d(wp.cos(half), -uy*sine, ux*sine, D(0))
        elif uz < D(0):
            sq = wp.vec4d(D(0), D(1), D(0), D(0))
    seg_out[actor, s, 0] = (a[0]+b[0]) * D(.5)
    seg_out[actor, s, 1] = (a[1]+b[1]) * D(.5)
    seg_out[actor, s, 2] = (a[2]+b[2]) * D(.5)
    for k in range(4):
        seg_out[actor, s, 3+k] = sq[k]


class CrowdPoseBatch:
    """全部clip行人一次graph：Kernel A逐骨局部姿态 → Kernel B每人FK+写回目标 → 三输出D2H。

    构造参数 entries=[(cfg, clip_name, segments_desc), ...]：segments_desc 为该 actor 14段
    [{'a':骨索引,'b':骨索引} | {'joint':frameJoint骨索引,'p0':[3],'p1':[3]}]（按humanSegments顺序）。
    批成员在动作内固定；sample(active, ...)只更新参与行输入，其余行保留上次有限输入。
    返回 (world_p, world_q, site_p, site_q, seg_center, seg_q) 独立拷贝，wxyz。
    """
    def __init__(self, entries, device='cuda:0', cache_root=None):
        entries = tuple(entries)
        if not 1 <= len(entries) <= 1000:
            raise ValueError('HUMAN_GPU_BATCH_INVALID: 批大小须1-1000')
        if wp.__version__ != '1.13.0':
            raise HumanGpuError('HUMAN_GPU_DEPENDENCY_VERSION', '当前受验版本为warp-lang==1.13.0，实际'+wp.__version__)
        names, actor_rows, clip_rows = [], [], []
        parents, offsets, rest, r_index, r_times, r_values, t_index, t_times, t_values = [], [], [], [], [], [], [], [], []
        descriptions = {}
        segments, seg_points = [], []
        for cfg, clip_name, segments_desc in entries:
            key = (id(cfg), clip_name)
            if key not in descriptions:
                rig = cfg['rig']
                indices = {joint['name']: i for i, joint in enumerate(rig)}
                if not 1 <= len(rig) <= 128 or len(indices) != len(rig):
                    raise ValueError('HUMAN_GPU_BATCH_INVALID: 骨架须包含1-128个唯一骨名')
                clip = next((c for c in cfg['clips'] if c['name'] == clip_name), None)
                if clip is None:
                    raise ValueError('HUMAN_GPU_BATCH_INVALID: 动作不存在 '+str(clip_name))
                duration = float(clip['durationS'])
                if not np.isfinite(duration) or duration <= 0:
                    raise ValueError('HUMAN_GPU_BATCH_INVALID: 动作时长须有限且大于0')
                start = len(parents)
                for i, joint in enumerate(rig):
                    parent = indices.get(joint.get('parent'), -1)
                    if parent >= i:
                        raise ValueError('HUMAN_GPU_BATCH_INVALID: 骨架须父先子后')
                    parents.append(parent)
                    offsets.append(joint['offsetM'])
                    q = joint['quaternionXyzw']
                    rest.append([q[3], *q[:3]])
                def tracks(rows, target_index, target_times, target_values, field, rotation=False):
                    metadata = [[0, 0, 0] for _ in rig]
                    for track in rows:
                        metadata[indices[track['joint']]] = [len(target_times), len(track['timesS']), int(track['interpolation'] == 'STEP')]
                        target_times.extend(track['timesS'])
                        target_values.extend([[q[3], *q[:3]] for q in track[field]] if rotation else track[field])
                    target_index.extend(metadata)
                tracks(clip['tracks'], r_index, r_times, r_values, 'rotationsXyzw', True)
                tracks(clip.get('translations', []), t_index, t_times, t_values, 'positionsM')
                mapping = clip.get('rootMotion')
                kind = 0 if not mapping else 1 if mapping['horizontal'] == 'remove-drift' else 2
                root_joint = indices[mapping['joint']] if mapping else 0
                descriptions[key] = (tuple(indices), [start, len(rig), kind, root_joint],
                                     [duration, *(mapping.get('driftM', [0., 0., 0.]) if mapping else [0., 0., 0.]),
                                      *(mapping['baselineM'] if mapping else [0., 0., 0.])])
            actor_names, actor_row, clip_row = descriptions[key]
            names.append(actor_names)
            actor_rows.append(actor_row)
            clip_rows.append(clip_row)
            row = []
            points = []
            for seg in segments_desc:
                if 'a' in seg:
                    row.extend([int(seg['a']), int(seg['b']), 0])
                    points.extend([0.]*6)
                else:
                    row.extend([0, int(seg['joint']), 1])
                    points.extend([*seg['p0'], *seg['p1']])
            segments.append(row)
            seg_points.append(points)
        self.names = tuple(names)
        self.bone_counts = tuple(len(row) for row in self.names)
        self.seg_counts = tuple(len(row)//3 for row in segments)
        self.count = len(entries)
        self.max_bones = max(self.bone_counts)
        self.max_segs = max(self.seg_counts)
        self.descriptions = len(descriptions)
        actor_rows = [row + [self.seg_counts[i], 0] for i, row in enumerate(actor_rows)]
        segments = [row + [0]*(self.max_segs*3-len(row)) for row in segments]
        seg_points = [row + [0.]*(self.max_segs*6-len(row)) for row in seg_points]
        configured = cache_root or os.environ.get('LYAPUNOV_HUMAN_GPU_CACHE_ROOT')
        if not configured:
            raise HumanGpuError('HUMAN_GPU_CACHE_REQUIRED', '显式CUDA人体需要当前Provider的可写私有cacheRoot')
        cache = Path(configured).resolve()
        try:
            cache.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryFile(dir=cache):
                pass
        except OSError as exc:
            raise HumanGpuError('HUMAN_GPU_CACHE_UNWRITABLE', 'GPU内核缓存不可写: '+str(cache)) from exc
        wp.config.kernel_cache_dir = str(cache)
        try:
            with contextlib.redirect_stdout(sys.stderr):
                wp.init()
            self.device = wp.get_device(device)
        except Exception as exc:
            raise HumanGpuError('HUMAN_CUDA_UNAVAILABLE', '显式GPU人体计算的CUDA设备不可用: '+str(exc)) from exc
        if not self.device.is_cuda:
            raise HumanGpuError('HUMAN_CUDA_UNAVAILABLE', '显式GPU人体计算需要CUDA设备')
        self.calls = 0
        self.closed = False
        self.prepare_s = 0.
        self.sample_s = 0.
        self.stream = None
        self.graph = None
        self.arguments_a = self.arguments_b = self.arguments_c = self.arguments_d = self.immutable = None
        self.host_inputs = self.device_inputs = None
        self.device_local = self.device_world = self.device_site = self.device_seg = None
        self.host_world = self.host_site = self.host_seg = None
        self._input = self._world = self._site = self._seg = None
        started = time.perf_counter()
        try:
            self.stream = wp.Stream(self.device)
            packed = [(actor_rows, wp.int32), (clip_rows, D), (parents, wp.int32), (offsets, D), (rest, D),
                      (r_index, wp.int32), (r_times or [0.], D), (r_values or [[0.]*4], D),
                      (t_index, wp.int32), (t_times or [0.], D), (t_values or [[0.]*3], D),
                      (segments, wp.int32), (seg_points, D)]
            self.immutable = [wp.array(np.asarray(rows, dtype=np.int32 if dtype == wp.int32 else np.float64), dtype=dtype, device=self.device) for rows, dtype in packed]
            (d_actors, d_clips, d_parents, d_offsets, d_rest, d_ri, d_rt, d_rv, d_ti, d_tt, d_tv,
             d_seg_index, d_seg_points) = self.immutable
            self.host_inputs = wp.zeros((self.count, 9), dtype=D, device='cpu', pinned=True)
            self.device_inputs = wp.empty((self.count, 9), dtype=D, device=self.device)
            self.device_local = wp.empty((self.count, self.max_bones, 7), dtype=D, device=self.device)
            self.device_world = wp.empty((self.count, self.max_bones, 7), dtype=D, device=self.device)
            self.device_site = wp.empty((self.count, self.max_bones, 7), dtype=D, device=self.device)
            self.device_seg = wp.empty((self.count, self.max_segs, 7), dtype=D, device=self.device)
            self.host_world = wp.empty((self.count, self.max_bones, 7), dtype=D, device='cpu', pinned=True)
            self.host_site = wp.empty((self.count, self.max_bones, 7), dtype=D, device='cpu', pinned=True)
            self.host_seg = wp.empty((self.count, self.max_segs, 7), dtype=D, device='cpu', pinned=True)
            self._input = self.host_inputs.numpy()
            self._world = self.host_world.numpy()
            self._site = self.host_site.numpy()
            self._seg = self.host_seg.numpy()
            self._input[:, 3] = 1.
            self.arguments_a = [self.device_inputs, d_actors, d_clips, d_parents, d_offsets, d_rest,
                                d_ri, d_rt, d_rv, d_ti, d_tt, d_tv, self.max_bones, self.device_local]
            self.arguments_b = [self.device_inputs, d_actors, d_clips, d_parents, self.device_local,
                                self.max_bones, self.device_world]
            self.arguments_c = [self.device_inputs, d_actors, self.device_world, self.max_bones, self.device_site]
            self.arguments_d = [d_actors, self.device_world, d_seg_index, d_seg_points, self.max_segs, self.device_seg]
            with contextlib.redirect_stdout(sys.stderr):
                wp.copy(self.device_inputs, self.host_inputs, stream=self.stream)
                wp.launch(crowd_local_fk, dim=self.count*self.max_bones, inputs=self.arguments_a, device=self.device, stream=self.stream)
                wp.launch(crowd_world_fk, dim=self.count, inputs=self.arguments_b, device=self.device, stream=self.stream)
                wp.launch(crowd_site_derive, dim=self.count*self.max_bones, inputs=self.arguments_c, device=self.device, stream=self.stream)
                wp.launch(crowd_seg_derive, dim=self.count*self.max_segs, inputs=self.arguments_d, device=self.device, stream=self.stream)
                wp.synchronize_stream(self.stream)
                wp.capture_begin(device=self.device, stream=self.stream)
                try:
                    wp.copy(self.device_inputs, self.host_inputs, stream=self.stream)
                    wp.launch(crowd_local_fk, dim=self.count*self.max_bones, inputs=self.arguments_a, device=self.device, stream=self.stream)
                    wp.launch(crowd_world_fk, dim=self.count, inputs=self.arguments_b, device=self.device, stream=self.stream)
                    wp.launch(crowd_site_derive, dim=self.count*self.max_bones, inputs=self.arguments_c, device=self.device, stream=self.stream)
                    wp.launch(crowd_seg_derive, dim=self.count*self.max_segs, inputs=self.arguments_d, device=self.device, stream=self.stream)
                    wp.copy(self.host_world, self.device_world, stream=self.stream)
                    wp.copy(self.host_site, self.device_site, stream=self.stream)
                    wp.copy(self.host_seg, self.device_seg, stream=self.stream)
                finally:
                    self.graph = wp.capture_end(device=self.device, stream=self.stream)
        except BaseException:
            self.close()
            raise
        self.prepare_s = time.perf_counter() - started

    def sample(self, active, roots, quaternions, elapsed, phases):
        """active为批成员索引int数组；只更新这些行的输入，未参与行保留上次有限输入。"""
        if self.closed:
            raise HumanGpuError('HUMAN_GPU_CLOSED', '本World人群GPU批已释放')
        active = np.asarray(active, dtype=np.int64)
        if (active.ndim != 1 or len(active) == 0 or roots.shape != (len(active), 3)
                or quaternions.shape != (len(active), 4)
                or elapsed.shape != (len(active),) or phases.shape != (len(active),)):
            raise ValueError('HUMAN_GPU_BATCH_INVALID: 当前根/相位输入维度不匹配')
        self._input[active, :3] = roots
        self._input[active, 3:7] = quaternions
        self._input[active, 7] = elapsed
        self._input[active, 8] = phases
        if not np.isfinite(self._input[active]).all():
            raise HumanGpuError('HUMAN_GPU_NONFINITE', '当前CUDA根/相位输入须为有限值，未执行graph')
        started = time.perf_counter()
        wp.capture_launch(self.graph, stream=self.stream)
        wp.synchronize_stream(self.stream)
        self.calls += 1
        self.sample_s += time.perf_counter() - started
        outputs = (self._world[active], self._site[active], self._seg[active])
        if not all(np.isfinite(o).all() for o in outputs):
            raise HumanGpuError('HUMAN_GPU_NONFINITE', '当前CUDA骨骼计算产生非有限值，未提交原生目标')
        return (self._world[active, :, :3].copy(), self._world[active, :, 3:].copy(),
                self._site[active, :, :3].copy(), self._site[active, :, 3:].copy(),
                self._seg[active, :, :3].copy(), self._seg[active, :, 3:].copy())

    def facts(self):
        return {'backend': 'warp-cuda-float64', 'device': self.device.alias, 'name': self.device.name,
                'uuid': self.device.uuid, 'arch': self.device.arch, 'warpVersion': wp.__version__,
                'dtype': 'float64', 'fastMath': False, 'fuseFp': False, 'actors': self.count,
                'boneCounts': list(self.bone_counts), 'segCounts': list(self.seg_counts),
                'maxBones': self.max_bones, 'maxSegs': self.max_segs, 'descriptions': self.descriptions,
                'kernelCalls': self.calls, 'graphReplays': self.calls, 'h2dCopies': self.calls,
                'd2hCopies': self.calls*3, 'sampleSynchronizations': self.calls,
                'prepareS': self.prepare_s, 'graphReplayAndSyncS': self.sample_s, 'closed': self.closed}

    def close(self):
        if self.closed:
            return
        try:
            if self.stream is not None:
                wp.synchronize_stream(self.stream)
        finally:
            self.graph = self.arguments_a = self.arguments_b = self.arguments_c = self.arguments_d = self.immutable = None
            self._input = self._world = self._site = self._seg = None
            self.host_inputs = self.device_inputs = None
            self.device_local = self.device_world = self.device_site = self.device_seg = None
            self.host_world = self.host_site = self.host_seg = None
            self.stream = None
            self.closed = True


class MixedClipBatch:
    """固定[(canonical_cfg, clip_name), ...]；采样输入均来自调用方当前tick。

    sample返回(N,max_bones,3)/(N,max_bones,4)独立数组，四元数为wxyz。
    逐人只消费[:bone_counts[i]]；names[i]与该段一一对应。不拥有World或动作状态。
    """
    def __init__(self, entries, device='cuda:0', cache_root=None):
        entries = tuple(entries)
        if not 1 <= len(entries) <= 1000:
            raise ValueError('HUMAN_GPU_BATCH_INVALID: 批大小须1-1000')
        if wp.__version__ != '1.13.0':
            raise HumanGpuError('HUMAN_GPU_DEPENDENCY_VERSION', '当前受验版本为warp-lang==1.13.0，实际'+wp.__version__)
        # 描述先打包再初始化CUDA；从此不保留cfg引用，之后的Scene修改不会反写本批。
        names, actor_rows, clip_rows = [], [], []
        parents, offsets, rest, r_index, r_times, r_values, t_index, t_times, t_values = [], [], [], [], [], [], [], [], []
        descriptions = {}
        for cfg, clip_name in entries:
            key = (id(cfg), clip_name)
            if key not in descriptions:
                rig = cfg['rig']
                indices = {joint['name']: i for i, joint in enumerate(rig)}
                if not 1 <= len(rig) <= 128 or len(indices) != len(rig):
                    raise ValueError('HUMAN_GPU_BATCH_INVALID: 骨架须包含1-128个唯一骨名')
                clip = next((c for c in cfg['clips'] if c['name'] == clip_name), None)
                if clip is None:
                    raise ValueError('HUMAN_GPU_BATCH_INVALID: 动作不存在 '+str(clip_name))
                duration = float(clip['durationS'])
                if not np.isfinite(duration) or duration <= 0:
                    raise ValueError('HUMAN_GPU_BATCH_INVALID: 动作时长须有限且大于0')
                start = len(parents)
                for i, joint in enumerate(rig):
                    parent = indices.get(joint.get('parent'), -1)
                    if parent >= i:
                        raise ValueError('HUMAN_GPU_BATCH_INVALID: 骨架须父先子后')
                    parents.append(parent)
                    offsets.append(joint['offsetM'])
                    q = joint['quaternionXyzw']
                    rest.append([q[3], *q[:3]])
                def tracks(rows, target_index, target_times, target_values, field, rotation=False):
                    metadata = [[0, 0, 0] for _ in rig]
                    for track in rows:
                        metadata[indices[track['joint']]] = [len(target_times), len(track['timesS']), int(track['interpolation'] == 'STEP')]
                        target_times.extend(track['timesS'])
                        target_values.extend([[q[3], *q[:3]] for q in track[field]] if rotation else track[field])
                    target_index.extend(metadata)
                tracks(clip['tracks'], r_index, r_times, r_values, 'rotationsXyzw', True)
                tracks(clip.get('translations', []), t_index, t_times, t_values, 'positionsM')
                mapping = clip.get('rootMotion')
                kind = 0 if not mapping else 1 if mapping['horizontal'] == 'remove-drift' else 2
                root_joint = indices[mapping['joint']] if mapping else 0
                descriptions[key] = (tuple(indices), [start, len(rig), kind, root_joint],
                                     [duration, *(mapping.get('driftM', [0., 0., 0.]) if mapping else [0., 0., 0.]),
                                      *(mapping['baselineM'] if mapping else [0., 0., 0.])])
            actor_names, actor_row, clip_row = descriptions[key]
            names.append(actor_names)
            actor_rows.append(actor_row)
            clip_rows.append(clip_row)
        self.names = tuple(names)
        self.bone_counts = tuple(len(row) for row in self.names)
        self.count = len(entries)
        self.max_bones = max(self.bone_counts)
        self.descriptions = len(descriptions)
        configured = cache_root or os.environ.get('LYAPUNOV_HUMAN_GPU_CACHE_ROOT')
        if not configured:
            raise HumanGpuError('HUMAN_GPU_CACHE_REQUIRED', '显式CUDA人体需要当前Provider的可写私有cacheRoot')
        cache = Path(configured).resolve()
        try:
            cache.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryFile(dir=cache):
                pass
        except OSError as exc:
            raise HumanGpuError('HUMAN_GPU_CACHE_UNWRITABLE', 'GPU内核缓存不可写: '+str(cache)) from exc
        wp.config.kernel_cache_dir = str(cache)
        try:
            with contextlib.redirect_stdout(sys.stderr):
                wp.init()
            self.device = wp.get_device(device)
        except Exception as exc:
            raise HumanGpuError('HUMAN_CUDA_UNAVAILABLE', '显式GPU人体计算的CUDA设备不可用: '+str(exc)) from exc
        if not self.device.is_cuda:
            raise HumanGpuError('HUMAN_CUDA_UNAVAILABLE', '显式GPU人体计算需要CUDA设备')
        self.calls = 0
        self.closed = False
        self.prepare_s = 0.
        self.sample_s = 0.
        self.stream = None
        self.graph = None
        self.arguments = self.immutable = None
        self.host_inputs = self.device_inputs = self.device_output = self.host_output = None
        self._input = self._output = None
        started = time.perf_counter()
        try:
            self.stream = wp.Stream(self.device)
            packed = [(actor_rows, wp.int32), (clip_rows, D), (parents, wp.int32), (offsets, D), (rest, D),
                      (r_index, wp.int32), (r_times or [0.], D), (r_values or [[0.]*4], D),
                      (t_index, wp.int32), (t_times or [0.], D), (t_values or [[0.]*3], D)]
            self.immutable = [wp.array(np.asarray(rows, dtype=np.int32 if dtype == wp.int32 else np.float64), dtype=dtype, device=self.device) for rows, dtype in packed]
            self.host_inputs = wp.zeros((self.count, 9), dtype=D, device='cpu', pinned=True)
            self.device_inputs = wp.empty((self.count, 9), dtype=D, device=self.device)
            self.device_output = wp.empty((self.count, self.max_bones, 7), dtype=D, device=self.device)
            self.host_output = wp.empty((self.count, self.max_bones, 7), dtype=D, device='cpu', pinned=True)
            self._input = self.host_inputs.numpy()
            self._output = self.host_output.numpy()
            self._input[:, 3] = 1.
            self.arguments = [self.device_inputs, *self.immutable, self.max_bones, self.device_output]
            with contextlib.redirect_stdout(sys.stderr):
                wp.copy(self.device_inputs, self.host_inputs, stream=self.stream)
                wp.launch(mixed_clip_fk, dim=self.count, inputs=self.arguments, device=self.device, stream=self.stream)
                wp.synchronize_stream(self.stream)
                wp.capture_begin(device=self.device, stream=self.stream)
                try:
                    wp.copy(self.device_inputs, self.host_inputs, stream=self.stream)
                    wp.launch(mixed_clip_fk, dim=self.count, inputs=self.arguments, device=self.device, stream=self.stream)
                    wp.copy(self.host_output, self.device_output, stream=self.stream)
                finally:
                    self.graph = wp.capture_end(device=self.device, stream=self.stream)
        except BaseException:
            self.close()
            raise
        self.prepare_s = time.perf_counter() - started

    def sample(self, roots, quaternions, elapsed, phases):
        if self.closed:
            raise HumanGpuError('HUMAN_GPU_CLOSED', '本World异构GPU批已释放')
        if (roots.shape != (self.count, 3) or quaternions.shape != (self.count, 4)
                or elapsed.shape != (self.count,) or phases.shape != (self.count,)):
            raise ValueError('HUMAN_GPU_BATCH_INVALID: 当前根/相位输入维度不匹配')
        self._input[:, :3] = roots
        self._input[:, 3:7] = quaternions
        self._input[:, 7] = elapsed
        self._input[:, 8] = phases
        if not np.isfinite(self._input).all():
            raise HumanGpuError('HUMAN_GPU_NONFINITE', '当前CUDA根/相位输入须为有限值，未执行graph')
        started = time.perf_counter()
        wp.capture_launch(self.graph, stream=self.stream)
        wp.synchronize_stream(self.stream)
        self.calls += 1
        self.sample_s += time.perf_counter() - started
        if not np.isfinite(self._output).all():
            raise HumanGpuError('HUMAN_GPU_NONFINITE', '当前CUDA骨骼计算产生非有限值，未提交原生目标')
        return self._output[:, :, :3].copy(), self._output[:, :, 3:].copy()

    def facts(self):
        return {'backend': 'warp-cuda-float64', 'device': self.device.alias, 'name': self.device.name,
                'uuid': self.device.uuid, 'arch': self.device.arch, 'warpVersion': wp.__version__,
                'dtype': 'float64', 'fastMath': False, 'fuseFp': False, 'actors': self.count,
                'boneCounts': list(self.bone_counts), 'maxBones': self.max_bones, 'descriptions': self.descriptions,
                'kernelCalls': self.calls, 'graphReplays': self.calls, 'h2dCopies': self.calls,
                'd2hCopies': self.calls, 'sampleSynchronizations': self.calls,
                'prepareS': self.prepare_s, 'graphReplayAndSyncS': self.sample_s, 'closed': self.closed}

    def close(self):
        if self.closed:
            return
        try:
            if self.stream is not None:
                wp.synchronize_stream(self.stream)
        finally:
            self.graph = self.arguments = self.immutable = None
            self._input = self._output = None
            self.host_inputs = self.device_inputs = self.device_output = self.host_output = None
            self.stream = None
            self.closed = True
