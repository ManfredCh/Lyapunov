#!/usr/bin/env python3
"""一个入口同步公开源码、GitHub Release、OSS 和官网，并以提交汇总状态验收。"""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo
import zlib

PLATFORMS = ('linux-x64', 'darwin-arm64')
ROOT = Path(__file__).resolve().parents[1]


class PublishError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise PublishError(message)


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def file_info(path):
    h, md5 = hashlib.sha256(), hashlib.md5()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            h.update(block)
            md5.update(block)
    return {'sha256': h.hexdigest(), 'md5': base64.b64encode(md5.digest()).decode(), 'bytes': Path(path).stat().st_size}


def read_json(path):
    return json.loads(Path(path).read_text())


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.partial')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    os.replace(temporary, path)


def check_manifest(value, platform, version):
    require(value.get('schema') == 1 and value.get('platform') == platform, '平台清单 schema/platform 不正确')
    require(value.get('version') == version, f'{platform} 清单不是当前版本 {version}')
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}', value.get('releaseId', '')), 'releaseId 无效')
    require(re.fullmatch(r'[a-f0-9]{40}', value.get('sourceCommit', '')), 'sourceCommit 无效')
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', value.get('archiveRoot', '')), 'archiveRoot 无效')
    archive = value.get('archive', {})
    check_archive_info(archive)
    require(value.get('mujoco', {}).get('mode') in ('install-provider', 'conda-pack'), 'MuJoCo 模式无效')
    field = 'minimumMacOS' if platform == 'darwin-arm64' else 'minimumGlibc'
    require(re.fullmatch(r'\d+\.\d+', value.get(field, '')), '最低系统版本无效: ' + field)
    if platform == 'darwin-arm64':
        require(value['mujoco']['mode'] == 'install-provider', 'Mac 清单的 MuJoCo 模式不正确')
    return value


def check_archive_info(item):
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz', item.get('path', '')), '归档文件名无效')
    require(re.fullmatch(r'[a-f0-9]{64}', item.get('sha256', '')), '归档 SHA-256 无效')
    require(type(item.get('bytes')) is int and item['bytes'] > 0, '归档大小无效')


def check_tsv(path, manifest):
    rows = dict(line.split('\t', 1) for line in Path(path).read_text().splitlines() if line)
    expected = {'schema': '1', 'release_id': manifest['releaseId'], 'version': manifest['version'],
                'platform': manifest['platform'], 'source_commit': manifest['sourceCommit'],
                'archive_root': manifest['archiveRoot'], 'archive_path': 'releases/' + manifest['releaseId'] + '/' + manifest['archive']['path'],
                'archive_sha256': manifest['archive']['sha256'], 'archive_bytes': str(manifest['archive']['bytes']),
                'mujoco_mode': manifest['mujoco']['mode']}
    expected['minimum_macos' if manifest['platform'] == 'darwin-arm64' else 'minimum_glibc'] = manifest['minimumMacOS' if manifest['platform'] == 'darwin-arm64' else 'minimumGlibc']
    require(all(rows.get(k) == v for k, v in expected.items()), 'JSON 与 TSV 清单不一致: ' + str(path))


def choose_manifest(roots, platform, version, explicit=None):
    candidates = []
    paths = [Path(explicit)] if explicit else []
    if not explicit:
        for root in roots:
            root = Path(root)
            for pattern in [platform + '.json', '*/' + platform + '.json', 'releases/*/' + platform + '.json']:
                paths.extend(root.glob(pattern))
    for path in paths:
        value = read_json(path)
        if value.get('version') == version and value.get('platform') == platform:
            # latest 目录通常只含清单，归档位于它旁边的 releaseId 目录。
            directory = path.parent
            if directory.name == 'latest' and not (directory / value['archive']['path']).exists():
                directory = directory.parent / value['releaseId']
                path = directory / (platform + '.json')
            if (directory / value['archive']['path']).is_file():
                candidates.append((path.stat().st_mtime_ns, str(path), path))
    require(candidates, f'缺少 {version} 的 {platform} 已准备归档；将出包目录放入配置的 artifactRoots，或指定 --{ "linux" if platform == "linux-x64" else "mac" }')
    return max(candidates)[2]


def rollup_result(value, expected):
    obj = value['data']['repository']['object']
    require(obj and obj['oid'] == expected, '远程 main 已变化，本次结果不能代替新提交的检查')
    rollup = obj.get('statusCheckRollup')
    if not rollup or not rollup['contexts']['nodes']:
        return False, '等待检查注册', obj
    nodes = rollup['contexts']['nodes']
    green = rollup['state'] == 'SUCCESS' and all(
        (n.get('status') == 'COMPLETED' and n.get('conclusion') == 'SUCCESS') or n.get('state') == 'SUCCESS'
        for n in nodes)
    return green, rollup['state'], obj


def protected_files(root, shell):
    names = shell.git('ls-files', '--others', '--exclude-standard', '-z').split('\0')
    names += shell.git('diff', '--name-only', '-z', 'HEAD').split('\0')
    result = {}
    for name in sorted(set(n for n in names if n)):
        path = Path(root) / name
        result[name] = sha(path) if path.is_file() else 'MISSING'
    return result


class Shell:
    def __init__(self, root, directory):
        self.root, self.directory, self.sequence = Path(root), Path(directory), 0

    def run(self, arguments, cwd=None, data=None, private=False, allow_failure=False, timeout=3600, env=None):
        self.sequence += 1
        output = []
        for attempt in range(3):
            result = subprocess.run([str(a) for a in arguments], cwd=cwd or self.root, input=data,
                                    text=True, capture_output=True, timeout=timeout, env=env)
            output.append(result.stdout + result.stderr)
            network_git = (Path(str(arguments[0])).name == 'git' and len(arguments) > 1
                           and arguments[1] in ('push', 'fetch', 'clone')
                           and any(text in result.stderr for text in ['GnuTLS recv error', 'TLS connection was non-properly terminated', 'Could not resolve host', 'Connection reset by peer']))
            if result.returncode and network_git and attempt < 2:
                time.sleep(2 ** attempt)
                continue
            break
        log = self.directory / 'logs' / f'{self.sequence:04d}-{Path(str(arguments[0])).name}.log'
        if not private:
            log.parent.mkdir(parents=True, exist_ok=True)
            log.write_text('\n'.join(output))
        if result.returncode and not allow_failure:
            raise PublishError(f'{Path(str(arguments[0])).name} 退出 {result.returncode}；' + ('签名输出未落盘' if private else f'日志: {log}'))
        return result

    def git(self, *arguments, cwd=None):
        return self.run(['git', *arguments], cwd=cwd).stdout.rstrip('\n')


class GitHub:
    def __init__(self, shell):
        self.shell = shell

    def api(self, path, method=None, body=None, missing=False):
        arguments = ['gh', 'api', path]
        if method:
            arguments += ['--method', method]
        if body is not None:
            arguments += ['--input', '-']
        result = self.shell.run(arguments, data=json.dumps(body) if body is not None else None, allow_failure=missing)
        if result.returncode:
            require('404' in result.stderr, 'GitHub 查询失败，不能当作对象不存在')
            return None
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def ref(self, repo, ref='heads/main'):
        value = self.api('repos/' + repo + '/git/ref/' + ref, missing=True)
        if value is None:
            return None
        if value['object']['type'] == 'tag':
            return self.api('repos/' + repo + '/git/tags/' + value['object']['sha'])['object']['sha']
        return value['object']['sha']

    def rollup(self, repo, expression='main'):
        owner, name = repo.split('/')
        query = 'query($owner:String!,$name:String!,$expression:String!){repository(owner:$owner,name:$name){object(expression:$expression){... on Commit{oid statusCheckRollup{state contexts(first:100){nodes{... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}}}}}}'
        return self.api('graphql', 'POST', {'query': query, 'variables': {'owner': owner, 'name': name, 'expression': expression}})

    def wait_green(self, targets, timeout, retried, notify=print, settle_seconds=0):
        deadline, last, printed = time.monotonic() + timeout, None, 0
        green_since, green_fingerprint = None, None
        while time.monotonic() < deadline:
            pending, evidence = [], {}
            for label, commit in targets.items():
                repo, _, expression = label.partition('@')
                good, state, obj = rollup_result(self.rollup(repo, commit if expression else 'main'), commit)
                evidence[label] = obj
                if good:
                    continue
                runs = self.api(f'repos/{repo}/actions/runs?head_sha={commit}&per_page=100')['workflow_runs']
                # 取消的检查真实重跑一次，保留原记录；从不取消检查或伪造成功状态。
                for run in runs:
                    require(run['conclusion'] not in ('failure', 'timed_out', 'action_required'), 'CI 未通过: ' + run['html_url'])
                    if run['conclusion'] == 'cancelled':
                        key = repo + ':' + str(run['id'])
                        previous = next((x for x in retried if x['key'] == key), None)
                        if previous:
                            require(run['run_attempt'] <= previous['attempt'], '检查再次取消: ' + run['html_url'])
                        else:
                            self.api(f'repos/{repo}/actions/runs/{run["id"]}/rerun', 'POST')
                            retried.append({'key': key, 'attempt': run['run_attempt']})
                pending.append(label + '=' + state)
            if not pending:
                fingerprint = json.dumps(evidence, sort_keys=True)
                if not settle_seconds:
                    return evidence
                if green_fingerprint != fingerprint:
                    green_since, green_fingerprint = time.monotonic(), fingerprint
                if time.monotonic() - green_since >= settle_seconds:
                    return evidence
                pending.append('发布后的检查已成功，确认汇总状态稳定')
            else:
                green_since, green_fingerprint = None, None
            message = '等待 main 汇总: ' + '；'.join(pending)
            if message != last or time.monotonic() - printed > 60:
                notify(message)
                last = message
                printed = time.monotonic()
            time.sleep(15)
        raise PublishError('等待 main 汇总状态超时；尚未完成，原命令可重新运行')

    def release(self, repo, tag):
        # 草稿不能可靠地用 /releases/tags 定位；按真实 tag_name 查列表。
        for page in range(1, 21):
            items = self.api(f'repos/{repo}/releases?per_page=100&page={page}')
            for item in items:
                if item['tag_name'] == tag:
                    return item
            if len(items) < 100:
                return None
        raise PublishError('Release 列表过长，未定位目标标签')

    def publish_release(self, repo, tag, commit, assets, notes):
        release = self.release(repo, tag)
        if release is None:
            release = self.api('repos/' + repo + '/releases', 'POST',
                               {'tag_name': tag, 'target_commitish': commit, 'name': 'Lyapunov ' + tag.removeprefix('v'),
                                'body': notes, 'draft': True, 'prerelease': False})
        for path in assets:
            found = next((a for a in release['assets'] if a['name'] == path.name), None)
            if found:
                require(found.get('digest') == 'sha256:' + sha(path) and found['size'] == path.stat().st_size,
                        '已存在的 GitHub 资产身份冲突: ' + repo + '/' + path.name)
            else:
                self.shell.run(['gh', 'release', 'upload', tag, str(path), '--repo', repo])
        # 发布草稿时必须显式指定真实标签，避免产生 untagged 标签及额外取消检查。
        self.api(f'repos/{repo}/releases/{release["id"]}', 'PATCH',
                 {'tag_name': tag, 'target_commitish': commit, 'draft': False, 'make_latest': 'true'})
        latest = self.api('repos/' + repo + '/releases/latest')
        require(latest['id'] == release['id'] and latest['tag_name'] == tag and not latest['draft'], 'GitHub Latest 未指向本次版本')
        require(self.ref(repo, 'tags/' + tag) == commit, '已发布标签发生变化')
        for path in assets:
            found = next((a for a in latest['assets'] if a['name'] == path.name), None)
            require(found and found.get('digest') == 'sha256:' + sha(path), 'GitHub 资产校验失败: ' + path.name)
        return {'id': latest['id'], 'tag': tag, 'url': latest['html_url'], 'tagCommit': commit}

    def check_assets(self, repo, tag, assets, require_latest=False):
        release = self.release(repo, tag)
        if release is None:
            require(not require_latest, '缺少 GitHub Release: ' + repo + '/' + tag)
            return
        if require_latest:
            latest = self.api('repos/' + repo + '/releases/latest')
            require(latest['id'] == release['id'] and not release['draft'], 'GitHub Latest 版本不一致: ' + repo)
        for name, item in assets.items():
            found = next((a for a in release['assets'] if a['name'] == name), None)
            if found:
                require(found.get('digest') == 'sha256:' + item['sha256'] and found['size'] == item['bytes'], '已发布资产冲突: ' + repo + '/' + name)
            else:
                require(not require_latest, 'GitHub Release 缺少资产: ' + name)


class Cloud:
    def __init__(self, config, shell, directory):
        self.cfg, self.shell, self.directory = config, shell, Path(directory)
        self.source = (ROOT / 'script/release-publish-remote.py').read_text()

    def call(self, task, private=False):
        config = {key: self.cfg[key] for key in ('oss', 'server', 'cdnUrl')}
        config['cloud'] = {'region': self.cfg['cloud']['region']}
        program = 'CONFIG=' + repr(config) + '\nTASK=' + repr(task) + '\n' + self.source
        encoded = base64.b64encode(zlib.compress(program.encode())).decode()
        command = "python3 - <<'PY_RELEASE'\nimport base64,zlib\nexec(zlib.decompress(base64.b64decode('" + encoded + "')))\nPY_RELEASE\n"
        require(len(command.encode()) < 24000, '云端发布命令超过 Cloud Assistant 限制')
        base = [self.cfg['cloud'].get('cli', 'aliyun'), 'ecs']
        common = ['--RegionId', self.cfg['cloud']['region']]
        def api(arguments):
            return json.loads(self.shell.run([*base, *arguments, *common], private=private).stdout)
        invocation = api(['RunCommand', '--InstanceId.1', self.cfg['cloud']['instance'], '--Type', 'RunShellScript',
                          '--Name', 'lyapunov-publish-' + task['action'], '--CommandContent', command,
                          '--Timeout', '1800', '--KeepCommand', 'false'])
        deadline = time.monotonic() + 1845
        while time.monotonic() < deadline:
            time.sleep(3)
            values = api(['DescribeInvocationResults', '--InstanceId', self.cfg['cloud']['instance'],
                          '--InvokeId', invocation['InvokeId'], '--ContentEncoding', 'PlainText'])
            rows = values.get('Invocation', {}).get('InvocationResults', {}).get('InvocationResult', [])
            if rows and rows[0].get('InvokeRecordStatus') == 'Finished':
                row = rows[0]
                require(row.get('ExitCode') == 0, '云端 ' + task['action'] + ' 失败；见本地云回执日志')
                result = json.loads(row['Output'])
                if not private:
                    save(self.directory / ('cloud-' + task['action'] + '.json'), result)
                return result
        raise PublishError('云端操作超时: ' + task['action'])

    def upload(self, path, key):
        info = file_info(path)
        signed = self.call({'action': 'presign', 'key': key, 'md5': info['md5']}, private=True)
        require(signed['key'] == key, '签名返回路径不一致')
        config = ('url = ' + json.dumps(signed['url']) + '\nrequest = "PUT"\n'
                  'header = "Content-Type: application/octet-stream"\nheader = "Content-MD5: ' + info['md5'] + '"\n'
                  'upload-file = ' + json.dumps(str(path)) + '\n')
        self.shell.run(['curl', '--fail', '--silent', '--show-error', '--connect-timeout', '30', '--retry', '2', '--config', '-'], data=config, private=True)
        return {'key': key, **info}


def synchronize_source(shell, gh, config, source, tree, version):
    dev, public, tag = config['devRepo'], config['publicRepo'], 'v' + version
    public_before = gh.ref(public)
    shell.git('fetch', '--no-tags', 'https://github.com/' + public + '.git', 'main')
    if shell.git('rev-parse', public_before + '^{tree}') == tree:
        published = public_before
    else:
        message = f'release: 同步 Lyapunov {version} 的公开源码\n\nDev 基线 {source}；仅复制已提交树，不复制私有历史、运行目录或人群资源。\n'
        published = shell.run(['git', 'commit-tree', tree, '-p', public_before], data=message).stdout.strip()
        require(shell.git('rev-list', published, '^' + public_before).splitlines() == [published], '公开快照混入私有历史')
    tags = {}
    for repo, commit in [(dev, source), (public, published)]:
        existing = gh.ref(repo, 'tags/' + tag)
        refs = [commit + ':refs/heads/main']
        if existing is None:
            refs.append(commit + ':refs/tags/' + tag)
        # 现有标签保留；重复发布同版本只补齐入口与同步 main。
        tags[repo] = existing or commit
        shell.git('push', '--atomic', 'https://github.com/' + repo + '.git', *refs)
    return published, tags


def prepare_website(shell, gh, config, directory, version):
    repo = config['websiteRepo']
    base = gh.ref(repo)
    target = Path(tempfile.mkdtemp(prefix='website-', dir=directory))
    shell.git('clone', '--shared', '--no-checkout', config['websiteGit'], str(target))
    shell.git('remote', 'set-url', 'origin', 'https://github.com/' + repo + '.git', cwd=target)
    shell.git('fetch', 'origin', 'main', cwd=target)
    shell.git('sparse-checkout', 'set', 'Web', '.github', cwd=target)
    shell.git('checkout', '--detach', base, cwd=target)
    metadata_path = target / 'Web/lyapunov-standalone/current-release.json'
    metadata = read_json(metadata_path)
    if metadata['version'] != version:
        metadata = {'version': version, 'date': datetime.now(ZoneInfo('Asia/Singapore')).date().isoformat(),
                    'notesUrl': '/lyapunov/updates/' + version + '.html' if (target / 'Web/lyapunov-standalone/updates' / (version + '.html')).exists()
                    else 'https://github.com/' + config['publicRepo'] + '/releases/tag/v' + version}
        save(metadata_path, metadata)
        shell.git('add', '--', 'Web/lyapunov-standalone/current-release.json', cwd=target)
        shell.git('commit', '-m', 'release: 官网切换到 Lyapunov ' + version, cwd=target)
    commit = shell.git('rev-parse', 'HEAD', cwd=target)
    require(gh.ref(repo) == base, '官网 main 已变化，请重新运行')
    shell.git('push', 'origin', 'HEAD:refs/heads/main', cwd=target)
    env = {k: v for k, v in os.environ.items() if not k.startswith('VITE_')}
    env.update(config.get('websiteEnv', {}))
    # npm 缓存可复用；隔离的 node_modules 避免修改已有工作树或共享 tsbuildinfo。
    for arguments in [['npm', 'ci', '--prefer-offline'], ['npm', 'run', 'build'],
                      ['npm', 'run', 'build:lyapunov'], ['npm', 'run', 'check:public-brand']]:
        shell.run(arguments, cwd=target / 'Web', env=env)
    for name in ['index.html', 'manual.html', 'guide.html', 'guide.en.html']:
        html = (target / 'Web/dist/lyapunov' / name).read_text()
        require('__LYAPUNOV_' not in html and version in html, '官网当前版本未正确渲染: ' + name)
    return commit, target / 'Web/dist', metadata


def http_get(url, method='GET', headers=None):
    request = urllib.request.Request(url, method=method, headers={'Cache-Control': 'no-cache', **(headers or {})})
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.status, dict(response.headers), response.read() if method != 'HEAD' else b''


def verify_public(config, manifests, archives, files=None):
    base = config['baseUrl'].rstrip('/')
    for platform, (path, manifest) in manifests.items():
        for extension in ('json', 'tsv'):
            _, _, body = http_get(base + '/lyapunov/releases/latest/' + platform + '.' + extension)
            require(body == path.with_suffix('.' + extension).read_bytes(), '线上 latest 清单不一致: ' + platform)
    for item in archives:
        url = base + '/' + item['key']
        status, headers, _ = http_get(url, 'HEAD')
        require(status == 200 and int(headers['Content-Length']) == item['bytes'], '下载入口大小不正确: ' + url)
        length = min(65536, item['bytes'])
        status, _, body = http_get(url, headers={'Range': f'bytes=0-{length - 1}'})
        with Path(item['local']).open('rb') as stream:
            require(status == 206 and body == stream.read(length), '下载入口 Range 字节不一致: ' + url)
    if files:
        def check(item):
            name, entry = item
            if name.startswith('home/'):
                path = '/' + name[5:]
            elif name.startswith('site/'):
                path = '/lyapunov/' + name[5:]
            else:
                return
            _, _, body = http_get(base + path)
            require(hashlib.sha256(body).hexdigest() == entry['sha256'], '官网公开文件不一致: ' + path)
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(check, files.items()))
    _, _, installer = http_get(base + '/lyapunov/install.sh')
    result = subprocess.run(['sh', '-n'], input=installer, capture_output=True)
    require(result.returncode == 0, '线上安装脚本语法不正确')
    return {'platforms': list(manifests), 'archives': len(archives), 'websiteFiles': len(files or {}), 'installerSyntax': 'passed'}


class Publisher:
    def __init__(self, config, root, directory):
        self.config, self.root, self.directory = config, Path(root), Path(directory)
        self.shell = Shell(root, directory)
        self.gh = GitHub(self.shell)
        self.cloud = Cloud(config, self.shell, directory)
        self.receipt = {'状态': '部分完成', 'steps': {}, 'reruns': []}

    def progress(self, message):
        print(message, flush=True)
        save(self.directory / 'receipt.json', self.receipt)

    def run(self, arguments):
        shell, config = self.shell, self.config
        source = shell.git('rev-parse', 'HEAD')
        require(shell.git('branch', '--show-current') == 'main', '请在 Dev main 调用发布命令；不会切换或覆盖已有分支')
        package = json.loads(shell.git('show', source + ':package.json'))
        version = package['version']
        require(re.fullmatch(r'\d+\.\d+\.\d+', version), '本命令发布正式版本，package.json 必须为 x.y.z')
        require(read_json(self.root / 'package.json')['version'] == version, 'package.json 的版本变更尚未提交')
        names = shell.git('ls-tree', '-r', '--name-only', source).splitlines()
        require('docs/releases/' + version + '.md' in names, '缺少已提交的本版发布说明: docs/releases/' + version + '.md')
        require(not any('.runtime' in Path(n).parts or n.startswith('packages/human-crowd/assets/') for n in names), '已提交树包含禁止发布的运行文件或人群资源')
        before = protected_files(self.root, shell)
        manifests, archives = {}, []
        roots = [self.root / p for p in config.get('artifactRoots', ['.runtime/releases', '.runtime/release-inputs'])]
        for platform in PLATFORMS:
            explicit = arguments.linux if platform == 'linux-x64' else arguments.mac
            path = choose_manifest(roots, platform, version, explicit)
            value = check_manifest(read_json(path), platform, version)
            check_tsv(path.with_suffix('.tsv'), value)
            shell.git('merge-base', '--is-ancestor', value['sourceCommit'], source)
            main = path.parent / value['archive']['path']
            info = file_info(main)
            require(info['bytes'] == value['archive']['bytes'] and info['sha256'] == value['archive']['sha256'], '归档字节与清单不一致: ' + str(main))
            with tarfile.open(main) as bundle:
                stream = bundle.extractfile(value['archiveRoot'] + '/RELEASE.json')
                require(stream is not None, '归档缺少 RELEASE.json')
                release = json.loads(stream.read(10 * 1024 * 1024))
            require(all(release.get(k) == value[k] for k in ['sourceCommit', 'version', 'platform', 'releaseId'])
                    and release.get('sourceCommitMatchesPayload') is True, '归档源码身份与清单不一致')
            manifests[platform] = (path, value)
            objects = [value['archive']]
            if value['mujoco']['mode'] == 'conda-pack':
                objects.append(value['mujoco']['runtime']['archive'])
            for item in objects:
                check_archive_info(item)
                local = path.parent / item['path']
                actual = info if local == main else file_info(local)
                require(actual['sha256'] == item['sha256'] and actual['bytes'] == item['bytes'], '运行时归档校验失败')
                archives.append({**actual, 'local': str(local), 'key': config['oss'].get('prefix', 'lyapunov') + '/releases/' + value['releaseId'] + '/' + item['path']})
        identity = hashlib.sha256(json.dumps([a['sha256'] for a in archives]).encode()).hexdigest()[:12]
        run_id = version + '-' + source[:12] + '-' + identity
        for item in archives:
            item['stageKey'] = config['oss'].get('prefix', 'lyapunov') + '/staging/' + run_id + '/' + Path(item['local']).name
        self.receipt.update(version=version, sourceCommit=source, archives=archives, runId=run_id)
        self.progress('发布已提交的 main ' + source[:12] + '，版本 ' + version)
        if arguments.plan:
            self.receipt['状态'] = '计划'
            self.progress('计划已生成；未写入 GitHub、OSS 或官网')
            return self.receipt
        for platform in PLATFORMS:
            _, _, body = http_get(config['baseUrl'].rstrip('/') + '/lyapunov/releases/latest/' + platform + '.json')
            current = json.loads(body)['version']
            require(tuple(map(int, current.split('.'))) <= tuple(map(int, version.split('.'))), '线上已有更新版本，拒绝降级 latest: ' + current)
        if arguments.verify_only:
            tree = shell.git('rev-parse', source + '^{tree}')
            public = self.gh.ref(config['publicRepo'])
            shell.git('fetch', '--no-tags', 'https://github.com/' + config['publicRepo'] + '.git', 'main')
            require(shell.git('rev-parse', public + '^{tree}') == tree, '公开 main 尚未与 Dev 同步')
            targets = {config['devRepo']: source, config['publicRepo']: public, config['websiteRepo']: self.gh.ref(config['websiteRepo'])}
            for repo in [config['devRepo'], config['publicRepo']]:
                tag_commit = self.gh.ref(repo, 'tags/v' + version)
                require(tag_commit, '缺少发布标签: ' + repo)
                targets[repo + '@v' + version] = tag_commit
            # 核验模式严格只读，不重跑 CI。
            for label, commit in targets.items():
                repo, _, tag = label.partition('@')
                good, state, obj = rollup_result(self.gh.rollup(repo, commit if tag else 'main'), commit)
                require(good, label + ' 尚未全绿: ' + state)
            self.receipt['steps']['public'] = verify_public(config, manifests, archives)
            expected_assets = metadata_assets(manifests, archives)
            for repo in [config['devRepo'], config['publicRepo']]:
                self.gh.check_assets(repo, 'v' + version, expected_assets, require_latest=True)
        else:
            tree = shell.git('rev-parse', source + '^{tree}')
            public, tags = synchronize_source(shell, self.gh, config, source, tree, version)
            self.progress('GitHub 主线已同步，准备官网构建')
            website, dist, metadata = prepare_website(shell, self.gh, config, self.directory, version)
            deployment_id = run_id + '-' + website[:12]
            self.receipt['runId'] = deployment_id
            targets = {config['devRepo']: source, config['publicRepo']: public, config['websiteRepo']: website}
            targets.update({repo + '@v' + version: commit for repo, commit in tags.items()})
            payload = self.directory / 'payload'
            payload.mkdir(exist_ok=True)
            for name, src in [('home', dist), ('site', dist / 'lyapunov')]:
                dest = payload / name
                dest.mkdir(exist_ok=True)
                shutil.copy2(src / 'index.html', dest / 'index.html')
                shutil.copytree(src / 'assets', dest / 'assets', dirs_exist_ok=True)
                if name == 'site':
                    for doc in ['manual.html', 'guide.html', 'guide.en.html']:
                        shutil.copy2(src / doc, dest / doc)
                    current_notes = dist / 'lyapunov/updates' / (version + '.html')
                    if current_notes.exists():
                        (dest / 'updates').mkdir(exist_ok=True)
                        shutil.copy2(current_notes, dest / 'updates' / current_notes.name)
            installer = payload / 'site/install.sh'
            installer.write_text(shell.run(['git', 'show', source + ':distribution/linux/install.sh']).stdout)
            shell.run(['sh', '-n', str(installer)])
            assets = self.directory / 'github-assets'
            assets.mkdir(exist_ok=True)
            sums, by_release = [], {}
            for platform, (path, value) in manifests.items():
                target = payload / 'releases' / value['releaseId']
                target.mkdir(parents=True, exist_ok=True)
                for extension in ['json', 'tsv']:
                    name = platform + '.' + extension
                    shutil.copy2(path.with_suffix('.' + extension), target / name)
                    shutil.copy2(path.with_suffix('.' + extension), assets / name)
            for item in archives:
                rid = item['key'].split('/releases/', 1)[1].split('/', 1)[0]
                line = item['sha256'] + '  ' + Path(item['local']).name + '\n'
                sums.append(line)
                by_release.setdefault(rid, []).append(line)
            for rid, lines in by_release.items():
                (payload / 'releases' / rid / 'SHA256SUMS').write_text(''.join(lines))
            (assets / 'SHA256SUMS').write_text(''.join(sums))
            expected_assets = {p.name: {'sha256': sha(p), 'bytes': p.stat().st_size} for p in assets.iterdir()}
            for repo in [config['devRepo'], config['publicRepo']]:
                self.gh.check_assets(repo, 'v' + version, expected_assets)
            files = {str(p.relative_to(payload)): {'sha256': sha(p), 'bytes': p.stat().st_size} for p in payload.rglob('*') if p.is_file()}
            save(payload / 'manifest.json', files)
            tar_path = self.directory / 'payload.tar.gz'
            with tarfile.open(tar_path, 'w:gz') as bundle:
                for path in sorted(payload.rglob('*')):
                    if path.is_file():
                        bundle.add(path, arcname=str(path.relative_to(payload)))
            self.progress('官网已构建，检查 OSS 不可变对象')
            probe = self.cloud.call({'action': 'probe', 'archives': archives})
            for item in archives:
                if item['key'] in probe['missing'] and item['stageKey'] not in probe['staged']:
                    self.progress('上传归档: ' + Path(item['local']).name)
                    self.cloud.upload(Path(item['local']), item['stageKey'])
            payload_key = config['oss'].get('prefix', 'lyapunov') + '/staging/' + deployment_id + '/payload.tar.gz'
            staged = self.cloud.upload(tar_path, payload_key)
            self.receipt['steps']['mainCI'] = self.gh.wait_green(targets, arguments.timeout, self.receipt['reruns'], self.progress)
            self.progress('各仓 main 汇总全绿，切换 OSS latest 与官网')
            self.receipt['steps']['deployment'] = self.cloud.call({'action': 'apply', 'before': probe['before'],
                'payload': staged, 'runId': deployment_id, 'archives': archives, 'platforms': {p: m for p, (_, m) in manifests.items()}})
            self.receipt['steps']['public'] = verify_public(config, manifests, archives, files)
            notes = release_notes(config, version, manifests)
            self.receipt['steps']['releases'] = [self.gh.publish_release(repo, 'v' + version, tags[repo], sorted(assets.iterdir()), notes)
                                                 for repo in [config['devRepo'], config['publicRepo']]]
            # 发布之后再查一次汇总；不遗漏后续触发、取消或排队的额外检查。
            self.receipt['steps']['finalMainRollup'] = self.gh.wait_green(targets, arguments.timeout, self.receipt['reruns'], self.progress, settle_seconds=15)
        storage = list(archives)
        for platform, (path, value) in manifests.items():
            for extension in ['json', 'tsv']:
                file = path.with_suffix('.' + extension)
                storage.append({'key': config['oss'].get('prefix', 'lyapunov') + '/releases/latest/' + file.name,
                                'bytes': file.stat().st_size, 'sha256': sha(file)})
        self.receipt['steps']['ossVerified'] = self.cloud.call({'action': 'verify', 'objects': storage})
        require(protected_files(self.root, shell) == before, '原有修改在发布期间发生变化；请核对保护记录')
        self.receipt['protectedFiles'] = {'count': len(before), 'unchanged': True}
        self.receipt['状态'] = '完成'
        self.progress('完成：GitHub、OSS、官网与下载入口一致，main 汇总全绿')
        return self.receipt


def metadata_assets(manifests, archives):
    items = {}
    for platform, (path, _) in manifests.items():
        for extension in ['json', 'tsv']:
            file = path.with_suffix('.' + extension)
            items[file.name] = {'sha256': sha(file), 'bytes': file.stat().st_size}
    sums = ''.join(a['sha256'] + '  ' + Path(a['local']).name + '\n' for a in archives).encode()
    items['SHA256SUMS'] = {'sha256': hashlib.sha256(sums).hexdigest(), 'bytes': len(sums)}
    return items


def release_notes(config, version, manifests):
    base = config['baseUrl'].rstrip('/')
    rows = [f'# Lyapunov {version}', '', f'[官网安装页]({base}/lyapunov/) · [完整发布说明](https://github.com/{config["publicRepo"]}/blob/v{version}/docs/releases/{version}.md)',
            '', 'Linux、Mac 在本机终端执行；Windows 在 WSL2 的 Ubuntu 24.04+ 终端执行：', '',
            '```sh', 'curl -fsSL ' + base + '/lyapunov/install.sh | sh', '"$HOME/.local/bin/lyapunov"', '```', '',
            '| 平台 | 下载 | 发布 ID |', '| --- | --- | --- |']
    for platform, (_, value) in manifests.items():
        url = base + '/lyapunov/releases/' + value['releaseId'] + '/' + value['archive']['path']
        label = 'Mac Apple Silicon（macOS 15+，便携版，未公证）' if platform == 'darwin-arm64' else 'Linux x64 / Windows WSL2 + WSLg'
        rows.append(f'| {label} | [直接下载]({url}) | `{value["releaseId"]}` |')
    rows += ['', '各归档的真实源码提交、大小与 SHA-256 以附件和平台清单为准。已发布标签、归档与历史资产保持不变。']
    return '\n'.join(rows) + '\n'


def main():
    parser = argparse.ArgumentParser(description='一条命令发布已提交 main 与已准备的 Linux/Mac 归档')
    parser.add_argument('--config', default=str(ROOT / '.runtime/release-publish.json'))
    parser.add_argument('--linux', help='指定 Linux JSON 清单')
    parser.add_argument('--mac', help='指定 Mac JSON 清单')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--plan', action='store_true', help='仅检查本地输入并显示计划，不写生产')
    mode.add_argument('--verify-only', action='store_true', help='仅核对线上状态，不写生产或重跑检查')
    parser.add_argument('--timeout', type=int, default=3600, help='等待 GitHub 汇总的秒数')
    arguments = parser.parse_args()
    config_path = Path(arguments.config)
    require(config_path.is_file(), '缺少本机发布配置，见 docs/RELEASE_PUBLISH.md：' + str(config_path))
    config = read_json(config_path)
    require(config.get('schema') == 1, '发布配置 schema 无效')
    for name in ['devRepo', 'publicRepo', 'websiteRepo']:
        require(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', config[name]), 'GitHub 仓库标识无效')
    for name in ['baseUrl', 'cdnUrl']:
        require(config[name].startswith('https://'), '发布 URL 必须使用 HTTPS')
    root = ROOT / '.runtime/release-publish'
    root.mkdir(parents=True, exist_ok=True)
    with (root / 'publish.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        directory = Path(tempfile.mkdtemp(prefix=datetime.now(ZoneInfo('Asia/Singapore')).strftime('%Y%m%dT%H%M%S-'), dir=root))
        save(root / 'last.json', {'directory': str(directory)})
        publisher = Publisher(config, ROOT, directory)
        try:
            publisher.run(arguments)
        except Exception as error:
            publisher.receipt['状态'] = '阻断'
            publisher.receipt['error'] = str(error)
            save(directory / 'receipt.json', publisher.receipt)
            print('尚未完成：' + str(error) + '\n回执: ' + str(directory / 'receipt.json'), file=sys.stderr)
            return 1
        print('回执: ' + str(directory / 'receipt.json'))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (PublishError, BlockingIOError) as error:
        print('尚未完成：' + str(error), file=sys.stderr)
        sys.exit(1)
