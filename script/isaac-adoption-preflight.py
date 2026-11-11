"""S0：在各自解释器检查固定上游组件，不启动 Kit、训练或设备运行。"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def probe(python, source):
    try:
        result = subprocess.run([python, '-c', source], cwd=ROOT, capture_output=True, text=True, timeout=60)
        return {'exitCode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr,
                'facts': json.loads(result.stdout.splitlines()[-1]) if result.returncode == 0 else None}
    except (OSError, subprocess.TimeoutExpired, ValueError) as error:
        return {'exitCode': None, 'error': str(error)}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--export-python', required=True)
    p.add_argument('--capture-python', required=True)
    p.add_argument('--isaac-python', required=True)
    p.add_argument('--json-out', required=True)
    args = p.parse_args()
    vendor = ROOT / 'packages/robot-workflows/python/vendor/isaaclab_data'
    lock = json.loads((vendor / 'UPSTREAM.json').read_text())
    integrity = {row['path']: hashlib.sha256((vendor / row['path']).read_bytes()).hexdigest() == row['sha256'] for row in lock['files']}
    export = probe(args.export_python, '''
import sys,json,tempfile,pathlib
sys.path.insert(0,'packages/robot-workflows/python')
from vendor.isaaclab_data.utils.datasets.episode_data import EpisodeData
from vendor.isaaclab_data.utils.datasets.hdf5_dataset_file_handler import HDF5DatasetFileHandler
import torch,h5py,numpy
with tempfile.TemporaryDirectory() as d:
 e=EpisodeData();e.add('actions',torch.tensor([.1,.2]));e.add('initial_state',{'root_pose':torch.tensor([0.,0.,0.,0.,0.,0.,1.])});e.pre_export()
 path=str(pathlib.Path(d)/'probe.hdf5');w=HDF5DatasetFileHandler();w.create(path,'Lyapunov-Probe');w.write_episode(e);w.close()
 r=HDF5DatasetFileHandler();r.open(path);got=r.load_episode('demo_0','cpu');assert torch.equal(got.data['actions'],e.data['actions']);r.close()
print(json.dumps({'roundtrip':True,'torch':torch.__version__,'h5py':h5py.__version__,'numpy':numpy.__version__,'labRevision':'e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4'}))
''')
    capture = probe(args.capture_python, '''
import json,importlib.metadata as m,pathlib,hashlib
from isaaccapture.retargeters import se3_retargeter,tensor_reorderer,gripper_retargeter
print(json.dumps({'version':m.version('isaaccapture'),'files':{x.__name__.split('.')[-1]:hashlib.sha256(pathlib.Path(x.__file__).read_bytes()).hexdigest() for x in [se3_retargeter,tensor_reorderer,gripper_retargeter]}}))
''')
    capture_lock = json.loads((ROOT / 'distribution/providers/isaac-capture/UPSTREAM.json').read_text())
    if capture.get('facts'):
        integrity.update({'capture/' + row['module']: capture['facts']['files'].get(row['module']) == row['sha256'] for row in capture_lock['files']})
        integrity['capture/version'] = capture['facts']['version'] == capture_lock['version']
    isaac = probe(args.isaac_python, '''
import sys,json,pathlib
sys.path.insert(0,'packages/sim-isaac/python')
from check import check
facts=check();root=pathlib.Path(facts.get('sdkRoot','/nonexistent'))
facts['assetValidationInstalled']=(root/'exts/isaacsim.asset.validation').is_dir()
facts['captureDeviceExecution']=False;facts['kitStarted']=False
print(json.dumps(facts))
''')
    status = 'PASS' if all(integrity.values()) and all(x.get('exitCode') == 0 for x in [export, capture, isaac]) and isaac.get('facts', {}).get('status') == 'AVAILABLE' else 'PARTIAL'
    receipt = {'stage': 'S0', 'status': status, 'sourceIntegrity': integrity, 'export': export, 'capture': capture, 'isaac': isaac,
               'runtimeExecution': '仅导入与官方数据读写，未启动 Kit 或设备'}
    out = Path(args.json_out);out.parent.mkdir(parents=True, exist_ok=True);out.write_text(json.dumps(receipt, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(receipt, ensure_ascii=False, indent=2))
    return 0 if status == 'PASS' else 2


if __name__ == '__main__':
    sys.exit(main())
