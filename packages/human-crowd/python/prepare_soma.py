"""从 Hugging Face 镜像备齐并校验 SOMA 检查点，再用固定的 NVIDIA 导出器生成本地 ONNX。"""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen

ENDPOINT = 'https://hf-mirror.com'
MODEL = 'nvidia/MotionBricks'
REVISION = '3cb362d9b95aa40462abcb4d8cfae9ffb6d97410'
EXPORTER_REVISION = '54fc563aeaaf819a753d72cc9fdc6713989cdd43'
RIG_PATH = 'tools/onnx/assets/soma_model_rig.npz'
RIG_HASH = 'a3a349e4dd10b13731528c8613bd564629df9b8444201bd9278a5c414ffd2b40'


class HubRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        url = urlsplit(new_url)
        domain = url.hostname or ''
        if url.scheme != 'https' or not (
            domain == 'hf-mirror.com' or domain.endswith(('.hf-mirror.com', '.cdn.hf.co'))
        ):
            raise RuntimeError(f'HTTP {code} 指向 {url.hostname}，未跟随')
        return super().redirect_request(request, fp, code, message, headers, new_url)


def file_digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fetch(url, target, size, digest, *, hub):
    if target.is_file() and target.stat().st_size == size and file_digest(target) == digest:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    opener = build_opener(HubRedirect).open if hub else urlopen
    request = Request(url, headers={'User-Agent': 'Lyapunov-SOMA/1'})
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as stream:
            temporary = Path(stream.name)
            try:
                with opener(request, timeout=30) as response:
                    received = 0
                    while block := response.read(1024 * 1024):
                        received += len(block)
                        if received > size:
                            raise ValueError(f'响应超过预期的 {size} 字节')
                        stream.write(block)
                stream.flush()
                if received != size or file_digest(temporary) != digest:
                    raise ValueError('字节数或 SHA-256 不符')
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
    except Exception as error:
        code = 'SOMA_HUB_BLOCKED' if hub else 'SOMA_EXPORT_RIG_UNAVAILABLE'
        raise RuntimeError(f'{code}: {urlsplit(url).path} · {error}') from error


def prepare(upstream, output):
    if upstream == output or upstream in output.parents:
        raise ValueError('SOMA_OUTPUT_INVALID: 请将权重与导出结果放在上游源码目录之外')
    product = Path(__file__).resolve().parents[3]
    if output == product or product in output.parents and output.relative_to(product).parts[0] != '.runtime':
        raise ValueError('SOMA_OUTPUT_INVALID: 请使用 Dev 的 .runtime 目录或主包外的绝对路径')
    revision = subprocess.check_output(['git', '-C', str(upstream), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != EXPORTER_REVISION:
        raise ValueError(f'SOMA_EXPORTER_REVISION_MISMATCH: 需要 {EXPORTER_REVISION}，实际 {revision}')
    pinned = subprocess.check_output(['git', '-C', str(upstream), 'show', f'{revision}:tools/onnx/checksums.py'], text=True)
    code = ast.parse(pinned)
    release = ast.literal_eval(code.body[-1].value)['soma']
    checkpoint_root = output / 'checkpoints' / release['root_directory']
    for entry in release['files']:
        path = entry['path']
        source = f'{ENDPOINT}/{MODEL}/resolve/{REVISION}/soma/{release["root_directory"]}/{quote(path)}'
        fetch(source, checkpoint_root / path, entry['bytes'], entry['sha256'], hub=True)
        print(f'通过 SHA-256 校验 {path}', flush=True)

    with tempfile.TemporaryDirectory(prefix='export-', dir=output) as stage_name:
        stage = Path(stage_name)
        exporter = stage / 'exporter'
        # 用 Git 对象导出固定版本源码，绕开本机检出目录的未提交修改及 LFS smudge。
        archive = subprocess.check_output(['git', '-C', str(upstream), 'archive', revision, 'tools/onnx'])
        import tarfile
        from io import BytesIO
        with tarfile.open(fileobj=BytesIO(archive)) as bundle:
            bundle.extractall(exporter, filter='data')
        fetch(f'https://media.githubusercontent.com/media/NVlabs/motionbricks/{revision}/{RIG_PATH}',
              exporter / RIG_PATH, 1184, RIG_HASH, hub=False)
        model = stage / 'soma-fp32.onnx'
        subprocess.run(['uv', 'run', '--locked', '--project', str(exporter / 'tools/onnx'),
                        'motionbricks-onnx', '--model', 'soma', '--checkpoints', str(checkpoint_root),
                        '--output', str(model)], cwd=exporter, check=True, env={**os.environ, 'HF_ENDPOINT': ENDPOINT, 'HF_HUB_OFFLINE': '1'})
        digest = file_digest(model)
        manifest = dict(schema=1, model=MODEL, revision=REVISION, endpoint=ENDPOINT,
                        exporterRevision=revision, precision='fp32', sha256=digest, bytes=model.stat().st_size,
                        file=f'soma-{digest}.onnx')
        model.replace(output / manifest['file'])
        ready = stage / 'soma.json'
        ready.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
        ready.replace(output / 'soma.json')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream', required=True, type=Path, help='固定 revision 的 MotionBricks 源码检出')
    parser.add_argument('--output', required=True, type=Path, help='主包外的本地 SOMA 目录')
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.upstream.resolve(), args.output.resolve()), ensure_ascii=False))
    except Exception as error:
        parser.exit(1, f'{error}\n')
