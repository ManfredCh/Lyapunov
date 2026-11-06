#!/usr/bin/env python3
"""统一发布的服务器侧操作；资源标识由本机忽略配置传入，凭据只在服务器内读取。"""
import base64
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.parse


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def atomic(path, data):
    path = Path(path)
    if path.is_file() and path.read_bytes() == data:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temporary, 0o644)
    os.replace(temporary, path)


def safe_relative(name):
    path = Path(name)
    if path.is_absolute() or '..' in path.parts or not path.parts:
        raise ValueError('发布路径越界: ' + name)
    return path


class Server:
    def __init__(self, config):
        self.cfg = config
        self.oss_cfg = config['oss']
        self.paths = config['server']
        self.site = Path(self.paths['site'])
        self.home = Path(self.paths['home'])
        self.prefix = self.oss_cfg.get('prefix', 'lyapunov')
        self.bucket = self.oss_cfg['bucket']
        raw = json.loads(subprocess.check_output(['docker', 'inspect', self.oss_cfg['container']], text=True))[0]
        values = dict(item.split('=', 1) for item in raw['Config']['Env'] if '=' in item)
        assert values['ALIYUN_OSS_BUCKET'] == self.bucket, 'OSS bucket 与现有配置不一致'
        self.key = values['ALIYUN_OSS_ACCESS_KEY_ID']
        self.secret = values['ALIYUN_OSS_ACCESS_KEY_SECRET']
        self.endpoint = values['ALIYUN_OSS_ENDPOINT']
        self.env = os.environ.copy()
        self.env.update(OSS_ACCESS_KEY_ID=self.key, OSS_ACCESS_KEY_SECRET=self.secret,
                        OSS_ENDPOINT=self.endpoint, OSS_REGION=config['cloud']['region'])

    def oss(self, arguments, allow_missing=False):
        result = subprocess.run([self.oss_cfg['cli'], *arguments, '--mode', 'AK'],
                                env=self.env, capture_output=True, text=True)
        if result.returncode:
            if allow_missing and any(s in result.stdout + result.stderr for s in ['NoSuchKey', '404']):
                return None
            raise RuntimeError('OSS ' + arguments[0] + ' 失败；未输出凭据或签名')
        return result.stdout

    def head(self, key):
        raw = self.oss(['api', 'head-object', '--bucket', self.bucket, '--key', key,
                        '--output-format', 'json'], allow_missing=True)
        if raw is None:
            return None
        header = json.JSONDecoder().raw_decode(raw.lstrip())[0]['Header']
        return {k.lower(): v[0] if isinstance(v, list) else v for k, v in header.items()}

    def matches(self, key, item):
        header = self.head(key)
        if header is None:
            return False
        if int(header['content-length']) != item['bytes']:
            raise ValueError('不可变 OSS 对象大小冲突: ' + key)
        actual = header.get('x-oss-meta-sha256')
        if actual is None and item['bytes'] < 2 * 1024 * 1024:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'object'
                self.oss(['cp', self.uri(key), str(path), '--no-progress', '-f'])
                actual = digest(path)
        if actual != item['sha256']:
            raise ValueError('不可变 OSS 对象 SHA-256 冲突: ' + key)
        return True

    def uri(self, key):
        return 'oss://' + self.bucket + '/' + key

    def snapshot(self):
        latest = self.site / 'releases/latest'
        return {'home': digest(self.home / 'index.html'), 'site': digest(self.site / 'index.html'),
                'installer': digest(self.site / 'install.sh'), 'latestLink': os.readlink(latest),
                'latestFiles': {p.name: digest(p) for p in sorted(latest.iterdir()) if p.is_file()}}

    def presign(self, task):
        key = task['key']
        assert key.startswith(self.prefix + '/staging/'), '只签发本产品 staging 路径'
        expires = int(time.time()) + 3600
        md5 = task['md5']
        message = f'PUT\n{md5}\napplication/octet-stream\n{expires}\n/{self.bucket}/{key}'
        signature = base64.b64encode(hmac.new(self.secret.encode(), message.encode(), hashlib.sha1).digest()).decode()
        host = urllib.parse.urlsplit(self.endpoint if '://' in self.endpoint else 'https://' + self.endpoint).netloc
        host = host.removeprefix(self.bucket + '.').replace('-internal.', '.')
        query = urllib.parse.urlencode({'OSSAccessKeyId': self.key, 'Expires': expires, 'Signature': signature})
        return {'url': f'https://{self.bucket}.{host}/{urllib.parse.quote(key, safe="/")}?{query}', 'key': key}

    def copy_verified(self, source, key, item):
        if self.matches(key, item):
            return
        assert source.startswith(self.prefix + '/staging/')
        header = self.head(source)
        assert header is not None and int(header['content-length']) == item['bytes'], 'staging 对象缺失或不完整'
        self.oss(['cp', self.uri(source), self.uri(key), '--metadata', 'sha256=' + item['sha256'],
                  '--cache-control', 'public,max-age=31536000,immutable', '--no-progress', '-f'])
        assert self.matches(key, item)

    def put_file(self, path, key, mutable=False):
        item = {'bytes': path.stat().st_size, 'sha256': digest(path)}
        if not mutable and self.matches(key, item):
            return
        if mutable:
            header = self.head(key)
            if header and header.get('x-oss-meta-sha256') == item['sha256'] and int(header['content-length']) == item['bytes']:
                return
        self.oss(['cp', str(path), self.uri(key), '--metadata', 'sha256=' + item['sha256'],
                  '--cache-control', 'no-cache,max-age=0' if mutable else 'public,max-age=31536000,immutable',
                  '--no-progress', '-f'])
        assert self.matches(key, item)

    def apply(self, task):
        directory = Path(self.paths['work']) / task['runId']
        directory.mkdir(parents=True, exist_ok=True)
        archive = directory / 'payload.tar.gz'
        self.oss(['cp', self.uri(task['payload']['key']), str(archive), '--no-progress', '-f'])
        assert digest(archive) == task['payload']['sha256'], '站点 payload SHA-256 错误'
        stage = Path(tempfile.mkdtemp(prefix='payload-', dir=directory))
        with tarfile.open(archive) as bundle:
            bundle.extractall(stage, filter='data')
        manifest = json.loads((stage / 'manifest.json').read_text())
        for name, item in manifest.items():
            path = stage / safe_relative(name)
            assert path.stat().st_size == item['bytes'] and digest(path) == item['sha256'], name
        assert self.snapshot() == task['before'], '线上状态已被其他发布修改，请重新运行以读取新状态'
        backup = Path(self.paths['backups']) / task['runId']
        backup.mkdir(parents=True, exist_ok=True)
        if not (backup / 'before.json').exists():
            atomic(backup / 'before.json', json.dumps(task['before'], indent=2).encode())
        for item in task['archives']:
            self.copy_verified(item['stageKey'], item['key'], item)
        # 先落不可变版本清单，再发布 mutable latest。
        for name in manifest:
            if name.startswith('releases/'):
                relative = safe_relative(name)
                target = self.site / relative
                data = (stage / relative).read_bytes()
                if target.exists():
                    assert target.read_bytes() == data, '不可变版本文件冲突: ' + name
                else:
                    atomic(target, data)
                self.put_file(target, self.prefix + '/' + name)
        route = Path(self.paths['nginxSnippet'])
        original = route.read_bytes()
        additions = b''
        for item in task['archives']:
            location = '/' + item['key']
            line = f'\nlocation = {location} {{\n    return 302 {self.cfg["cdnUrl"]}/{item["key"]};\n}}\n'.encode()
            if location.encode() not in original:
                additions += line
        if additions:
            atomic(backup / 'nginx.conf', original)
            atomic(route, original + additions)
            for command in [['nginx', '-t'], ['systemctl', 'reload', 'nginx']]:
                result = subprocess.run(command, capture_output=True)
                if result.returncode:
                    atomic(route, original)
                    subprocess.run(['systemctl', 'reload', 'nginx'], capture_output=True)
                    raise RuntimeError('nginx 配置未通过，已恢复原配置')
        files = []
        for name in manifest:
            if name.startswith('home/'):
                target = self.home / safe_relative(name[5:])
            elif name.startswith('site/'):
                target = self.site / safe_relative(name[5:])
            else:
                continue
            if name.startswith('site/updates/') and target.exists():
                assert digest(target) == manifest[name]['sha256'], '已发布说明不能覆盖: ' + name
            files.append((name, target))
        # 先铺齐新资源，保留所有旧内容寻址资源。
        for name, target in files:
            if '/assets/' in name:
                if target.exists():
                    assert digest(target) == manifest[name]['sha256'], '站点不可变资源冲突: ' + name
                else:
                    atomic(target, (stage / name).read_bytes())
        latest_name = 'latest-publish-' + task['runId']
        latest = self.site / 'releases' / latest_name
        if not latest.exists():
            shutil.copytree(self.site / 'releases/latest', latest)
        for platform, item in task['platforms'].items():
            for extension in ['json', 'tsv']:
                name = platform + '.' + extension
                source = stage / 'releases' / item['releaseId'] / name
                atomic(latest / name, source.read_bytes())
                self.put_file(source, self.prefix + '/releases/latest/' + name, mutable=True)
        pending = self.site / 'releases' / ('.latest-' + task['runId'])
        if pending.is_symlink():
            pending.unlink()
        pending.symlink_to(latest_name)
        os.replace(pending, self.site / 'releases/latest')
        for name, target in sorted(files, key=lambda item: item[0].endswith('index.html')):
            if '/assets/' in name:
                continue
            if target.exists() and digest(target) != manifest[name]['sha256']:
                saved = backup / name
                if not saved.exists():
                    saved.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(target, saved)
            atomic(target, (stage / name).read_bytes())
        for name, target in files:
            assert digest(target) == manifest[name]['sha256'], name
        for platform, item in task['platforms'].items():
            for extension in ['json', 'tsv']:
                assert (latest / (platform + '.' + extension)).read_bytes() == (stage / 'releases' / item['releaseId'] / (platform + '.' + extension)).read_bytes()
        return {'allPassed': True, 'backup': str(backup), 'latest': latest_name, 'siteFiles': len(files)}


def dispatch(config, task):
    server = Server(config)
    action = task['action']
    if action == 'presign':
        return server.presign(task)
    if action == 'probe':
        missing, staged = [], []
        for item in task['archives']:
            if not server.matches(item['key'], item):
                missing.append(item['key'])
                header = server.head(item['stageKey'])
                if header and int(header['content-length']) == item['bytes'] and header.get('etag', '').strip('"').lower() == base64.b64decode(item['md5']).hex():
                    staged.append(item['stageKey'])
        return {'before': server.snapshot(), 'missing': missing, 'staged': staged}
    if action == 'verify':
        for item in task['objects']:
            assert server.matches(item['key'], item), 'OSS 对象缺失: ' + item['key']
        return {'allPassed': True, 'objects': len(task['objects'])}
    if action == 'copy-test':
        assert task['target'].startswith(server.prefix + '/staging/')
        server.copy_verified(task['source'], task['target'], task['item'])
        return {'verified': True}
    if action == 'apply':
        lock_path = Path(config['server']['work']) / '.publish.lock'
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return server.apply(task)
    raise ValueError('未知发布操作')


if __name__ == '__main__':
    print(json.dumps(dispatch(CONFIG, TASK), ensure_ascii=False))
