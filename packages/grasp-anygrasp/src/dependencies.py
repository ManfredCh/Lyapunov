"""只检查本 Provider 的真实依赖；不生成机器 ID、不申请许可、不初始化检测器。"""
import importlib.util
import json
import os
from pathlib import Path
import sys

PRODUCT_ROOT = Path(__file__).resolve().parents[3]
SDK_COMMIT = 'b8eaafc9eca7babd5208e7a5ade3c561060be4c5'
MODULES = ('numpy', 'scipy', 'torch', 'open3d', 'graspnetAPI', 'MinkowskiEngine', 'pointnet2')

def dependency_state(request=None):
    request = request or {}
    sdk = Path(request.get('sdkPath') or os.environ.get('ANYGRASP_SDK_PATH') or PRODUCT_ROOT / '.runtime/providers/anygrasp/sdk/grasp_detection').expanduser().resolve()
    if (sdk / 'grasp_detection').is_dir():
        sdk = sdk / 'grasp_detection'
    checkpoint = Path(request.get('checkpointPath') or os.environ.get('ANYGRASP_CHECKPOINT') or sdk / 'log/checkpoint_detection.tar').expanduser().resolve()
    tag = sys.implementation.cache_tag
    binaries = list(sdk.glob('gsnet*.so')) if sdk.is_dir() else []
    binary = next((p for p in binaries if tag in p.name), None) or next((p for p in binaries if p.name == 'gsnet.so'), None)
    missing = []
    if binary is None:
        missing.append({'code': 'SDK_BINARY_MISSING', 'object': str(sdk / ('gsnet.' + tag + '-x86_64-linux-gnu.so'))})
    modules = {}
    for name in MODULES:
        found = importlib.util.find_spec(name)
        modules[name] = bool(found)
        if not found:
            missing.append({'code': 'PYTHON_DEPENDENCY_MISSING', 'object': name})
    license_directory = sdk / 'license'
    license_config = license_directory / 'licenseCfg.json'
    license_files = []
    if not license_config.is_file():
        missing.append({'code': 'LICENSE_MISSING', 'object': str(license_config), 'required': ['licenseCfg.json', '<授权名>.public_key', '<授权名>.signature', '<授权名>.lic']})
    else:
        # 只读取文件引用，不输出或计算配置中的 feature_id；有效性仍由真实 SDK 决定。
        try:
            config = json.loads(license_config.read_text())
            for field in ('public_key', 'signature', 'license'):
                name = config.get(field)
                if not isinstance(name, str) or not name or not (license_directory / name).is_file():
                    missing.append({'code': 'LICENSE_FILE_MISSING', 'object': field})
                else:
                    license_files.append(field)
        except (ValueError, OSError):
            missing.append({'code': 'LICENSE_CONFIG_INVALID', 'object': str(license_config)})
    if not checkpoint.is_file() or checkpoint.stat().st_size == 0:
        missing.append({'code': 'CHECKPOINT_MISSING', 'object': str(checkpoint)})
    return {
        'provider': 'anygrasp', 'status': 'BLOCKED' if missing else 'DEPENDENCIES_PRESENT',
        'code': 'PROVIDER_UNAVAILABLE' if missing else 'READY_FOR_REAL_PROVIDER_VALIDATION',
        'python': sys.executable, 'pythonTag': tag, 'sdkPath': str(sdk),
        'binaryPath': str(binary) if binary else None, 'checkpointPath': str(checkpoint),
        'licensePath': str(license_directory), 'licenseValidation': 'not-executed',
        'modulesFound': modules, 'missing': missing,
        'sourceCommit': SDK_COMMIT, 'inferenceExecuted': False,
        'licenseInstructions': 'https://github.com/graspnet/anygrasp_sdk/blob/' + SDK_COMMIT + '/license_registration/README.md',
    }

def require_dependencies(request):
    state = dependency_state(request)
    if state['missing']:
        raise RuntimeError('PROVIDER_UNAVAILABLE: ' + json.dumps(state, ensure_ascii=False))
    return state
