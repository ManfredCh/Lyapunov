"""真实依赖检查入口；缺项退出 2，存在性不代表许可有效或检测成功。"""
import argparse
import importlib
import json
import sys
from dependencies import dependency_state

parser = argparse.ArgumentParser()
parser.add_argument('--sdk-path')
parser.add_argument('--checkpoint-path')
parser.add_argument('--imports', action='store_true', help='实际导入依赖，不调用detector或机器ID接口')
args = parser.parse_args()
state = dependency_state({'sdkPath': args.sdk_path, 'checkpointPath': args.checkpoint_path})
if args.imports:
    sys.path.insert(0, state['sdkPath'])
    state['imports'] = {}
    for name in ['gsnet', *state['modulesFound'], 'MinkowskiEngineBackend._C', 'pointnet2._ext']:
        try:
            module = importlib.import_module(name)
            state['imports'][name] = {'status': 'IMPORTED', 'version': getattr(module, '__version__', None)}
            if name == 'gsnet':
                state['imports'][name]['createDetector'] = callable(getattr(module, 'create_detector', None))
                state['imports'][name]['checkLicense'] = callable(getattr(module, 'check_license', None))
        except Exception as error:
            state['imports'][name] = {'status': 'BLOCKED', 'errorType': type(error).__name__, 'message': str(error)}
            state['missing'].append({'code': 'PYTHON_DEPENDENCY_IMPORT_FAILED', 'object': name, 'errorType': type(error).__name__})
    if state['missing']:
        state['status'] = 'BLOCKED'
        state['code'] = 'PROVIDER_UNAVAILABLE'
print(json.dumps(state, ensure_ascii=False, indent=2))
sys.exit(2 if state['missing'] else 0)
