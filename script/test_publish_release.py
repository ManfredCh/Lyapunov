"""发行入口的离线回归：真实临时 Git/归档/HTTP，云端与 GitHub 写入用替身。"""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
from unittest.mock import patch


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


HERE = Path(__file__).resolve().parent
pub = load('release_publisher', HERE / 'publish-release.py')
remote = load('release_publisher_remote', HERE / 'release-publish-remote.py')


def rollup(state='SUCCESS', conclusion='SUCCESS', oid='a' * 40):
    return {'data': {'repository': {'object': {'oid': oid, 'statusCheckRollup': {
        'state': state, 'contexts': {'nodes': [{'name': 'build', 'status': 'COMPLETED', 'conclusion': conclusion}]}}}}}}


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def manifest(self, directory=None, version='0.2.3', platform='linux-x64'):
        directory = directory or self.root
        directory.mkdir(parents=True, exist_ok=True)
        raw = b'fixture-archive'
        manifest = {'schema': 1, 'version': version, 'releaseId': version + '-test', 'platform': platform,
                    'minimumGlibc': '2.39', 'minimumMacOS': '15.0',
                    'sourceCommit': 'a' * 40, 'archiveRoot': 'fixture', 'archive': {'path': 'fixture.tar.gz',
                    'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}, 'mujoco': {'mode': 'install-provider'}}
        (directory / 'fixture.tar.gz').write_bytes(raw)
        path = directory / (platform + '.json')
        path.write_text(json.dumps(manifest))
        return path, manifest

    def test_cancelled_check_makes_rollup_fail_even_when_main_and_tag_pass(self):
        value = rollup('FAILURE', 'CANCELLED')
        value['data']['repository']['object']['statusCheckRollup']['contexts']['nodes'] += [
            {'status': 'COMPLETED', 'conclusion': 'SUCCESS'}, {'status': 'COMPLETED', 'conclusion': 'SUCCESS'}]
        self.assertFalse(pub.rollup_result(value, 'a' * 40)[0])
        self.assertTrue(pub.rollup_result(rollup(), 'a' * 40)[0])

    def test_no_checks_and_moved_main_never_count_as_green(self):
        value = rollup()
        value['data']['repository']['object']['statusCheckRollup']['contexts']['nodes'] = []
        self.assertFalse(pub.rollup_result(value, 'a' * 40)[0])
        with self.assertRaises(pub.PublishError):
            pub.rollup_result(rollup(oid='b' * 40), 'a' * 40)

    def test_cancelled_run_retries_real_workflow_once_without_cancelling_anything(self):
        class Fake(pub.GitHub):
            def __init__(self): self.calls, self.count = [], 0
            def rollup(self, repo, expression='main'):
                self.count += 1
                return rollup('FAILURE', 'CANCELLED') if self.count < 3 else rollup()
            def api(self, path, method=None, body=None, missing=False):
                self.calls.append((path, method))
                if path.endswith('/rerun'): return {}
                return {'workflow_runs': [{'id': 7, 'conclusion': 'cancelled', 'run_attempt': 1, 'html_url': 'https://ci/7'}]}
        fake, retried = Fake(), []
        with patch.object(pub.time, 'sleep'):
            result = fake.wait_green({'owner/repo': 'a' * 40}, 10, retried, lambda _: None)
        self.assertIn('owner/repo', result)
        self.assertEqual(sum(path.endswith('/rerun') for path, _ in fake.calls), 1)
        self.assertFalse(any(path.endswith('/cancel') for path, _ in fake.calls))

    def test_real_ci_failure_is_not_retried_to_hide_it(self):
        class Fake(pub.GitHub):
            def __init__(self): self.writes = []
            def rollup(self, *args): return rollup('FAILURE', 'FAILURE')
            def api(self, path, method=None, **kwargs):
                self.writes.append(method)
                return {'workflow_runs': [{'id': 7, 'conclusion': 'failure', 'html_url': 'https://ci/7'}]}
        fake = Fake()
        with self.assertRaisesRegex(pub.PublishError, 'https://ci/7'):
            fake.wait_green({'owner/repo': 'a' * 40}, 10, [], lambda _: None)
        self.assertNotIn('POST', fake.writes)

    def test_late_registered_check_cannot_be_missed_after_publish(self):
        class Clock:
            now = 0
            def monotonic(self): return self.now
            def sleep(self, seconds): self.now += seconds
        class Fake(pub.GitHub):
            def __init__(self): self.count = 0
            def rollup(self, repo, expression='main'):
                self.count += 1
                return rollup('PENDING', None) if self.count == 2 else rollup()
            def api(self, *args, **kwargs): return {'workflow_runs': []}
        clock, fake = Clock(), Fake()
        with patch.object(pub.time, 'monotonic', clock.monotonic), patch.object(pub.time, 'sleep', clock.sleep):
            fake.wait_green({'owner/repo': 'a' * 40}, 100, [], lambda _: None, settle_seconds=15)
        self.assertEqual(fake.count, 4)

    def test_release_publish_explicitly_names_existing_tag_and_preserves_assets(self):
        path = self.root / 'linux-x64.json'
        path.write_text('{}')
        asset = {'name': path.name, 'size': path.stat().st_size, 'digest': 'sha256:' + pub.sha(path)}
        release = {'id': 4, 'tag_name': 'v0.2.3', 'assets': [asset], 'draft': True, 'html_url': 'https://release/4'}
        class Fake(pub.GitHub):
            def __init__(self): self.bodies = []
            def release(self, *args): return release
            def ref(self, *args): return 'a' * 40
            def api(self, path, method=None, body=None, missing=False):
                if method == 'PATCH':
                    self.bodies.append(body)
                    release['draft'] = False
                return release
        fake = Fake()
        fake.publish_release('owner/repo', 'v0.2.3', 'a' * 40, [path], '说明')
        self.assertEqual(fake.bodies[0]['tag_name'], 'v0.2.3')
        self.assertIs(fake.bodies[0]['draft'], False)
        asset['digest'] = 'sha256:' + '0' * 64
        with self.assertRaises(pub.PublishError):
            fake.publish_release('owner/repo', 'v0.2.3', 'a' * 40, [path], '说明')

    def test_candidate_discovery_rejects_wrong_version_and_missing_platform(self):
        self.manifest(self.root / 'old', version='0.2.2')
        correct, _ = self.manifest(self.root / 'ready')
        self.assertEqual(pub.choose_manifest([self.root], 'linux-x64', '0.2.3'), correct)
        with self.assertRaises(pub.PublishError):
            pub.choose_manifest([self.root], 'darwin-arm64', '0.2.3')

    def test_platform_batches_have_distinct_checksum_assets(self):
        linux = self.manifest(self.root / 'linux')
        mac = self.manifest(self.root / 'mac', platform='darwin-arm64')
        for path, _ in (linux, mac):
            path.with_suffix('.tsv').write_text('fixture')
        archives = [{'sha256': 'a' * 64, 'local': 'linux.tar.gz'}, {'sha256': 'b' * 64, 'local': 'mac.tar.gz'}]
        linux_assets = pub.metadata_assets({'linux-x64': linux}, archives[:1])
        mac_assets = pub.metadata_assets({'darwin-arm64': mac}, archives[1:])
        combined_assets = pub.metadata_assets({'linux-x64': linux, 'darwin-arm64': mac}, archives)
        self.assertEqual(set(linux_assets), {'linux-x64.json', 'linux-x64.tsv', 'SHA256SUMS-linux-x64'})
        self.assertEqual(set(mac_assets), {'darwin-arm64.json', 'darwin-arm64.tsv', 'SHA256SUMS-darwin-arm64'})
        self.assertEqual(set(combined_assets), {'linux-x64.json', 'linux-x64.tsv', 'darwin-arm64.json', 'darwin-arm64.tsv', 'SHA256SUMS'})

    def test_invalid_archive_path_and_json_tsv_mismatch_stop_before_upload(self):
        path, manifest = self.manifest()
        manifest['archive']['path'] = '../escape.tar.gz'
        with self.assertRaises(pub.PublishError):
            pub.check_manifest(manifest, 'linux-x64', '0.2.3')
        path.with_suffix('.tsv').write_text('version\t0.2.2\n')
        with self.assertRaises(pub.PublishError):
            pub.check_tsv(path.with_suffix('.tsv'), manifest)

    def test_public_git_snapshot_contains_committed_tree_not_untracked_or_private_history(self):
        root = self.root / 'repo'
        root.mkdir()
        subprocess.run(['git', 'init', '-q', str(root)], check=True)
        for key, value in [('user.name', '测试'), ('user.email', 'test@example.invalid')]:
            subprocess.run(['git', '-C', str(root), 'config', key, value], check=True)
        (root / 'tracked').write_text('old')
        subprocess.run(['git', '-C', str(root), 'add', 'tracked'], check=True)
        subprocess.run(['git', '-C', str(root), 'commit', '-qm', 'base'], check=True)
        base = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
        (root / 'tracked').write_text('user edit')
        (root / 'crowd-resource').write_bytes(b'keep')
        shell = pub.Shell(root, self.root / 'logs')
        before = pub.protected_files(root, shell)
        tree = shell.git('rev-parse', 'HEAD^{tree}')
        snapshot = shell.run(['git', 'commit-tree', tree, '-p', base], data='public\n').stdout.strip()
        self.assertEqual(shell.git('show', snapshot + ':tracked'), 'old')
        self.assertEqual(pub.protected_files(root, shell), before)
        self.assertEqual(shell.git('rev-list', snapshot, '^' + base).splitlines(), [snapshot])

    def test_immutable_oss_conflict_never_uploads(self):
        server = remote.Server.__new__(remote.Server)
        server.head = lambda _: {'content-length': '3', 'x-oss-meta-sha256': 'b' * 64}
        server.prefix = 'lyapunov'
        calls = []
        server.oss = lambda *args, **kwargs: calls.append(args)
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            server.copy_verified('lyapunov/staging/source', 'lyapunov/releases/version/archive', {'bytes': 3, 'sha256': 'a' * 64})
        self.assertEqual(calls, [])

    def test_presign_binds_md5_and_rejects_other_products(self):
        server = remote.Server.__new__(remote.Server)
        server.prefix, server.bucket, server.key, server.secret, server.endpoint = 'lyapunov', 'fixture', 'test-key', 'test-secret', 'https://oss.invalid'
        result = server.presign({'key': 'lyapunov/staging/fixture/a', 'md5': base64.b64encode(b'0' * 16).decode()})
        self.assertIn('/lyapunov/staging/fixture/a?', result['url'])
        with self.assertRaises(AssertionError):
            server.presign({'key': 'other/production/a', 'md5': ''})

    def test_download_wrong_range_and_wrong_manifest_never_pass(self):
        path, manifest = self.manifest()
        path.with_suffix('.tsv').write_text('tsv')
        data = {f'/lyapunov/releases/latest/linux-x64.json': path.read_bytes(),
                f'/lyapunov/releases/latest/linux-x64.tsv': b'tsv'}
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                body = data.get(self.path, b'wrong-archive')
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def do_HEAD(self):
                self.send_response(200)
                self.send_header('Content-Length', str(manifest['archive']['bytes']))
                self.end_headers()
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        config = {'baseUrl': f'http://127.0.0.1:{server.server_port}'}
        item = {'local': str(path.parent / 'fixture.tar.gz'), 'bytes': manifest['archive']['bytes'], 'key': 'lyapunov/archive'}
        with self.assertRaisesRegex(pub.PublishError, 'Range'):
            pub.verify_public(config, {'linux-x64': (path, manifest)}, [item])
        data['/lyapunov/releases/latest/linux-x64.json'] = b'wrong'
        with self.assertRaisesRegex(pub.PublishError, 'latest'):
            pub.verify_public(config, {'linux-x64': (path, manifest)}, [])

    def test_remote_atomic_files_do_not_overwrite_other_files(self):
        protected = self.root / 'user-data'
        protected.write_bytes(b'keep')
        remote.atomic(self.root / 'site/index.html', b'new')
        self.assertEqual(protected.read_bytes(), b'keep')
        self.assertEqual((self.root / 'site/index.html').read_bytes(), b'new')
        with self.assertRaises(ValueError): remote.safe_relative('../user-data')

    def test_git_tls_retry_is_bounded_and_never_turns_a_real_conflict_into_success(self):
        shell = pub.Shell(self.root, self.root / 'logs')
        fail = subprocess.CompletedProcess(['git'], 128, '', 'GnuTLS recv error (-110)')
        good = subprocess.CompletedProcess(['git'], 0, 'ok', '')
        with patch.object(pub.subprocess, 'run', side_effect=[fail, good]) as run, patch.object(pub.time, 'sleep'):
            self.assertEqual(shell.git('push', 'origin', 'HEAD:main'), 'ok')
            self.assertEqual(run.call_count, 2)
        conflict = subprocess.CompletedProcess(['git'], 1, '', 'non-fast-forward')
        with patch.object(pub.subprocess, 'run', return_value=conflict) as run:
            with self.assertRaises(pub.PublishError): shell.git('push', 'origin', 'HEAD:main')
            self.assertEqual(run.call_count, 1)

    def test_stale_unpublished_tag_cannot_silently_ship_new_source(self):
        class Shell:
            def __init__(self): self.pushes = []
            def git(self, *args, **kwargs):
                if args[0] == 'rev-parse': return 'new-tree' if args[1].startswith(('a', 'b')) else 'old-tree'
                if args[0] == 'push': self.pushes.append(args)
                return ''
        class GH:
            def ref(self, repo, ref='heads/main'): return 'b' * 40 if repo == 'owner/public' else 'c' * 40
            def release(self, *args): return None
        shell = Shell()
        with self.assertRaisesRegex(pub.PublishError, '未发布标签'):
            pub.synchronize_source(shell, GH(), {'devRepo': 'owner/dev', 'publicRepo': 'owner/public'}, 'a' * 40, 'new-tree', '0.2.4')
        self.assertEqual(shell.pushes, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
