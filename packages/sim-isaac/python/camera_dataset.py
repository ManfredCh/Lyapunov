"""相机数据集导出的**纯实现**：把已登记的真实采集写成自包含数据集。

为什么单独一个文件：`worker.py` 顶部会启动 Kit，**没有 Isaac SDK 就导不进来**；导出逻辑写在
`World.export_camera_dataset` 里，本机（无 GPU、无 Kit）就只能"读代码"而不能"跑一次"。这里只依赖
**标准库 + 入参**（采集登记表、输出根、和一个把 `file://` URI 解析成路径的函数），不 import numpy/PIL/pxr，
所以：
  · `World.export_camera_dataset` 调用的就是这份实现（不是第二套）；
  · 验收可以在任意解释器上，用**真 PNG/真 npy** 跑一遍真实现，核对 JSONL/标定/标注索引与真实副本。

契约（与 sim-mujoco 的 `export_camera_dataset` 同形，字段名逐条对齐）：
  · `samples.jsonl` 逐帧逐相机；同帧多相机共享 frameId/stepIndex/simTime/captureId，不同帧不拼成同步；
  · `calibration.json` 逐相机（含 sources 溯源）；`annotations.json` 汇总标注；`dataset.json` 是清单；
  · 副本真拷（`copyfile`）；文件缺失时**如实记进 missing 并把 status 置为 PARTIAL**，不冒充完成；
  · 只引用登记过的采集：不存在／ephemeral（深度未落盘）／旧代次都明确拒绝。
"""
import json
import re
import shutil
import time
import uuid
from pathlib import Path

FORMAT = 'lyapunov-camera-dataset-v1'


class DatasetError(Exception):
    """带结构化错误码的拒绝；`World.export_camera_dataset` 原样转成 SceneError(code, message)。"""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def _safe_name(value):
    return re.sub(r'[^A-Za-z0-9_.-]', '_', value or 'free')


def _copy_kind(entry, kind, extension, capture_id, index, safe, target, files, missing, path_from_uri):
    """按登记的 uri 真拷一份；没有登记该通道就跳过，登记了但文件不在就记 missing（不冒充成功）。"""
    metadata = entry.get(kind)
    if not metadata:
        return None
    source = metadata.get('uri') if isinstance(metadata, dict) else None
    if not isinstance(source, str):
        missing.append({'captureId': capture_id, 'cameraName': entry.get('cameraName'), 'kind': kind, 'uri': source, 'reason': 'URI_NOT_RECORDED'})
        return None
    origin = Path(path_from_uri(source))
    if not origin.is_file():
        missing.append({'captureId': capture_id, 'cameraName': entry.get('cameraName'), 'kind': kind, 'uri': source, 'reason': 'FILE_MISSING'})
        return None
    relative = kind + '/' + str(index) + '-' + safe + '.' + extension
    shutil.copyfile(origin, Path(target) / relative)
    files.append(relative)
    return relative


def export_dataset(captures, capture_ids, output_dir, current_generation, world_id, scene_id, engine='isaac', path_from_uri=None):
    """把 `capture_ids` 指向的采集导出到 `output_dir`，返回回执（含 datasetPath 等真实落盘路径）。

    `captures` 是 worker 的登记表（captureId → 记录）；`path_from_uri` 由调用方给出（worker 用自己那份
    解析，保证只读回 worker 自己写下的 uri）。
    """
    if not isinstance(capture_ids, list) or isinstance(capture_ids, bool) or not capture_ids:
        raise DatasetError('INVALID_ARGUMENT', 'captureIds 必须是非空数组（至少一个 captureId）')
    resolve_uri = path_from_uri
    if resolve_uri is None:
        raise DatasetError('INVALID_ARGUMENT', '导出需要 path_from_uri（把产物 uri 解析成本地路径）')
    seen = set()
    for value in capture_ids:
        if not isinstance(value, str) or not value:
            raise DatasetError('INVALID_ARGUMENT', 'captureIds 每项必须是非空字符串')
        if value in seen:
            raise DatasetError('INVALID_ARGUMENT', 'captureIds 不能重复: ' + value)
        seen.add(value)
        if value not in captures:
            raise DatasetError('CAPTURE_NOT_FOUND', 'captureId 不存在于当前 world: ' + value)
        record = captures[value]
        if record.get('ephemeral'):
            raise DatasetError('CAPTURE_NOT_REUSABLE', '该 capture 的深度未按本次渲染重新落盘，不能导出: ' + value)
        if record.get('generation') != current_generation:
            raise DatasetError('STALE_GENERATION', 'captureId ' + value + ' 属于旧世界代次（采集时 generation='
                               + str(record.get('generation')) + '，当前 ' + str(current_generation) + '）：拒绝导出可能已过期的采集')
    target = Path(output_dir).resolve()
    for kind in ('rgb', 'depth'):
        (target / kind).mkdir(parents=True, exist_ok=True)
    dataset_id = str(uuid.uuid4())
    samples, cameras_index, files, missing, annotation_rows = [], {}, [], [], []
    frame_ids = set()
    for index, capture_id in enumerate(capture_ids):
        record = captures[capture_id]
        frame_ids.add(record['frameId'])
        for entry in record.get('cameras') or []:
            key = entry.get('resolvedCameraName') or 'free'
            safe = _safe_name(key)
            row = {'captureId': capture_id, 'frameId': record['frameId'], 'stepIndex': record['stepIndex'], 'simTime': record['simTime'],
                   'sceneRevision': record['sceneRevision'], 'generation': record['generation'], 'worldId': record['worldId'],
                   'cameraName': entry.get('cameraName'), 'resolvedCameraName': entry.get('resolvedCameraName'),
                   'override': bool(entry.get('override')), 'worldGeneration': entry.get('worldGeneration'),
                   'resolution': {'width': record['width'], 'height': record['height']},
                   'calibration': entry.get('calibration'),
                   'annotationIds': [item['annotationId'] for item in (record.get('annotations') or [])
                                     if item.get('cameraName') == entry.get('cameraName') or item.get('resolvedCameraName') == entry.get('resolvedCameraName')],
                   'rgb': None, 'depth': None, 'depthRangeM': entry.get('depthRangeM')}
            row['rgb'] = _copy_kind(entry, 'rgb', 'png', capture_id, index, safe, target, files, missing, resolve_uri)
            row['depth'] = _copy_kind(entry, 'depth', 'npy', capture_id, index, safe, target, files, missing, resolve_uri)
            samples.append(row)
            if entry.get('calibration'):
                bucket = cameras_index.setdefault(key, {'cameraName': entry.get('cameraName'), 'resolvedCameraName': entry.get('resolvedCameraName'),
                                                        'calibration': entry['calibration'], 'sources': []})
                bucket['calibration'] = entry['calibration']
                bucket['sources'].append({'captureId': capture_id, 'frameId': record['frameId'], 'stepIndex': record['stepIndex'],
                                          'override': bool(entry.get('override')), 'worldGeneration': entry.get('worldGeneration')})
        annotation_rows.extend(record.get('annotations') or [])
    payload = {'format': FORMAT, 'datasetId': dataset_id, 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               'worldId': world_id, 'sceneId': scene_id, 'engine': engine, 'cameraNames': sorted(cameras_index),
               'captureIds': list(capture_ids), 'frameCount': len(frame_ids), 'sampleCount': len(samples),
               'multiView': len({row['frameId'] for row in samples}) < len(samples),
               'samples': 'samples.jsonl', 'calibration': 'calibration.json', 'annotations': 'annotations.json',
               'annotationCount': len(annotation_rows), 'files': files, 'missing': missing,
               'status': 'PARTIAL' if missing else 'completed',
               'source': '来自真实 ' + ('Isaac RTX' if engine == 'isaac' else engine) + ' 采集的 RGB/米制深度与 capture 回执标定；同 frameId 的多相机是同一物理步采集，不同 frameId 不拼为同步'}
    (target / 'samples.jsonl').write_text('\n'.join(json.dumps(row, allow_nan=False) for row in samples) + ('\n' if samples else ''))
    (target / 'calibration.json').write_text(json.dumps({'cameras': cameras_index}, indent=2, allow_nan=False))
    (target / 'annotations.json').write_text(json.dumps({'annotations': annotation_rows}, indent=2, allow_nan=False))
    (target / 'dataset.json').write_text(json.dumps(payload, indent=2, allow_nan=False))
    return {**payload, 'directory': str(target), 'datasetPath': str(target / 'dataset.json'), 'samplesPath': str(target / 'samples.jsonl'),
            'calibrationPath': str(target / 'calibration.json'), 'annotationsPath': str(target / 'annotations.json')}
