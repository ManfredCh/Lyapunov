"""将 Lyapunov 原生控制样本映射到固定的 Isaac Lab 数据 API。"""
import hashlib
import json
import math
from pathlib import Path
import sys

import torch
from vendor.isaaclab_data.utils.datasets.episode_data import EpisodeData
from vendor.isaaclab_data.utils.datasets.hdf5_dataset_file_handler import HDF5DatasetFileHandler


def tensor(values, size):
    if len(values) != size or any(type(value) not in (float, int) or not math.isfinite(value) for value in values):
        raise ValueError('LAB_EXPORT_INVALID_VECTOR')
    return torch.tensor(values, dtype=torch.float64)


def state(frame, entity_id, joints):
    entity, = (e for e in frame['entities'] if e['entityId'] == entity_id)
    observed = entity['joints']
    indices = [observed['names'].index(name) for name in joints]
    transform = entity['transform']
    orientation = tensor(transform['quaternion'], 4)
    if abs(float(torch.linalg.vector_norm(orientation)) - 1) > 1e-4:
        raise ValueError('LAB_EXPORT_INVALID_QUATERNION')
    return {
        'root_pose': torch.cat((tensor(transform['position'], 3), orientation)),
        'joint_position': tensor([observed['positions'][i] for i in indices], len(indices)),
        'joint_velocity': tensor([observed['velocities'][i] for i in indices], len(indices)),
    }


def check_equal(expected, actual):
    if isinstance(expected, dict):
        if expected.keys() != actual.keys():
            raise ValueError('LAB_EXPORT_ROUNDTRIP_KEYS')
        for key in expected:
            check_equal(expected[key], actual[key])
    elif expected.dtype != actual.dtype or not torch.equal(expected, actual):
        raise ValueError('LAB_EXPORT_ROUNDTRIP_VALUES')


def export(request):
    source = Path(request['source'])
    output = Path(request['output'])
    expected = request['controlSamples']
    identity_fields = ('profile', 'episodeId', 'entityId', 'worldId', 'generation', 'sceneRevision',
                       'jointNames', 'jointUnits', 'physicsTimestepS', 'requestedSteps')
    identity = None
    previous_end = None
    actions = set()
    episode = EpisodeData()
    count = 0
    digest = hashlib.sha256()
    with source.open('rb') as stream:
        for count, line in enumerate(stream, 1):
            digest.update(line)
            row = json.loads(line)
            sample = row['sample']
            current = {key: sample[key] for key in identity_fields}
            if (row['kind'] != 'control-sample' or row['sessionRef'] != request['sessionRef']
                    or any(current[key] != expected[key] for key in ('profile', 'episodeId', 'entityId'))
                    or sample['schemaVersion'] != 1 or sample['controlCycleIndex'] != count - 1
                    or sample['complete'] is not True or sample['status'] != 'completed'
                    or sample['requestedSteps'] <= 0 or sample['appliedSteps'] != sample['requestedSteps']
                    or sample['physicsStepEnd'] - sample['physicsStepStart'] != sample['appliedSteps']
                    or sample['actionId'] in actions):
                raise ValueError(f'LAB_EXPORT_INCOMPLETE_SAMPLE: {count}')
            if identity is not None and (identity != current or sample['physicsStepStart'] != previous_end):
                raise ValueError(f'LAB_EXPORT_SOURCE_OR_TIMELINE_CHANGED: {count}')
            for frame, step_key in ((sample['before'], 'physicsStepStart'), (sample['after'], 'physicsStepEnd')):
                if any(frame[key] != sample[key] for key in ('worldId', 'generation', 'sceneRevision')) or frame['stepIndex'] != sample[step_key]:
                    raise ValueError(f'LAB_EXPORT_FRAME_IDENTITY: {count}')
            joints = current['jointNames']
            before = state(sample['before'], current['entityId'], joints)
            after = state(sample['after'], current['entityId'], joints)
            if identity is None:
                identity = current
            episode.add('actions', tensor(sample['positions'], len(joints)))
            episode.add('obs', before)
            episode.add('states/articulation/' + current['entityId'], after)
            actions.add(sample['actionId'])
            previous_end = sample['physicsStepEnd']
            if count == 1:
                initial_state = {'articulation': {current['entityId']: before}}
    if not count or count != expected['sampleCount'] or count != expected['completeCount']:
        raise ValueError('LAB_EXPORT_INCOMPLETE_EPISODE')
    episode.pre_export()
    episode.data['initial_state'] = initial_state
    receipt = {'format': 'isaac-lab', 'status': 'DATASET_WRITTEN', 'sampleCount': count, 'episodeCount': 1,
               'profile': identity['profile'], 'source': identity, 'sourceSha256': digest.hexdigest(),
               'sceneId': request.get('sceneId'), 'recordingId': request.get('recordingId'),
               'controlPeriodS': identity['requestedSteps'] * identity['physicsTimestepS'],
               'taskValidation': 'unverified', 'quaternion': 'xyzw', 'datasetFile': 'dataset.hdf5'}
    path = output / receipt['datasetFile']
    if path.exists():
        raise FileExistsError(path)
    writer = HDF5DatasetFileHandler()
    writer.create(str(path))
    try:
        writer.add_env_args({'lyapunov': receipt})
        writer.write_episode(episode)
        writer.flush()
    finally:
        writer.close()
    reader = HDF5DatasetFileHandler()
    reader.open(str(path))
    try:
        names = list(reader.get_episode_names())
        if len(names) != 1 or reader.get_format_version() != 1:
            raise ValueError('LAB_EXPORT_ROUNDTRIP_FORMAT')
        check_equal(episode.data, reader.load_episode(names[0], 'cpu').data)
    finally:
        reader.close()
    receipt['readerRoundtrip'] = 'passed'
    (output / 'manifest.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
    return receipt


if __name__ == '__main__':
    print(json.dumps(export(json.load(sys.stdin)), ensure_ascii=False))
