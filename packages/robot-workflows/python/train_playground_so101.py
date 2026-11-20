"""Run the upstream SO101PickCube PPO task in an independent CPU environment."""
import argparse
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import json
from importlib.metadata import version
from pathlib import Path
import re
import sys

from robotics_lab import checked_mjcf, workspace_file


ROBOT_URI = 'github:google-deepmind/mujoco_menagerie/robotstudio_so101/so101.xml'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ('source', 'workspace', 'output'):
        parser.add_argument('--' + field, required=True, type=Path)
    for field in ('iterations', 'worlds', 'steps', 'seed'):
        parser.add_argument('--' + field, required=True, type=int)
    args = parser.parse_args()
    source = checked_mjcf(args.workspace, workspace_file(args.workspace, args.source))
    try:
        from absl import flags
        from mujoco_playground import asset
        from mujoco_playground.rl.rsl_rl import train
    except ImportError as error:
        raise SystemExit(f'PLAYGROUND_DEPENDENCY_MISSING: {error}') from error

    original_get = asset.get
    used_robot = False

    def load_asset(uri):
        nonlocal used_robot
        if uri == ROBOT_URI:
            used_robot = True
            return original_get(f'local:{source}')
        if uri.startswith('runfile:'):
            return original_get(uri)
        raise ValueError(f'PLAYGROUND_ASSET_NOT_PROVIDED: {uri}')

    overrides = json.dumps({'max_iterations': args.iterations, 'nworld': args.worlds, 'num_steps_per_env': args.steps})
    flags.FLAGS([
        'playground_train_so101', '--env=SO101PickCube', '--device=cpu', f'--seed={args.seed}',
        f'--overrides={overrides}', f'--logdir={args.output / "checkpoints"}',
        f'--wp_kernel_cache_dir={args.output / "warp-kernels"}',
    ])
    log = args.output / 'training.log'
    asset.get = load_asset
    try:
        with log.open('w', encoding='utf-8', buffering=1) as stream, redirect_stdout(stream), redirect_stderr(stream):
            train.main([])
    except Exception:
        print(f'完整训练日志见 {log}', file=sys.stderr)
        raise
    finally:
        asset.get = original_get

    checkpoints = sorted((args.output / 'checkpoints').glob('model_*.pt'),
                         key=lambda path: int(path.stem.rsplit('_', 1)[1]))
    measured = re.findall(r'Total steps:\s*([0-9,]+)', log.read_text(encoding='utf-8'))
    expected = args.iterations * args.worlds * args.steps
    if not used_robot or not measured or int(measured[-1].replace(',', '')) != expected or not checkpoints or checkpoints[-1].stat().st_size == 0:
        raise RuntimeError(f'PLAYGROUND_TRAINING_RECEIPT_INCOMPLETE: {log}')
    checkpoint = checkpoints[-1]
    with checkpoint.open('rb') as stream:
        checkpoint_digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    with source.open('rb') as stream:
        model_digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    result = {
        'environment': 'SO101PickCube', 'device': 'cpu', 'iterations': args.iterations, 'steps': expected,
        'worlds': args.worlds, 'seed': args.seed, 'log': log.name,
        'checkpoint': str(checkpoint.relative_to(args.output)), 'checkpointSha256': checkpoint_digest,
        'inputMjcfSha256': model_digest, 'playgroundVersion': version('playground'),
        'mujocoVersion': version('mujoco'), 'policyEvaluated': False,
    }
    (args.output / 'result.json').write_text(json.dumps({'summary': result}, ensure_ascii=False) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
