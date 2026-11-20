"""Run independent CPU rollouts of a locally trained SO101PickCube policy."""
import argparse
import dataclasses
import hashlib
import json
from pathlib import Path

from robotics_lab import checked_mjcf, workspace_file
from train_playground_so101 import ROBOT_URI


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write(path, info):
    path.write_text(json.dumps(info, ensure_ascii=False, allow_nan=False, indent=2) + '\n', encoding='utf-8')


def evaluate(args):
    import mujoco
    from PIL import Image
    import torch
    from rsl_rl.runners import OnPolicyRunner
    from mujoco_playground import asset
    from mujoco_playground._src.rl import env_registry, rng
    from mujoco_playground._src.rl.rsl_rl.vecenv_wrapper import RslRlVecEnvWrapper

    workspace = args.workspace
    source = checked_mjcf(workspace, workspace_file(workspace, args.source))
    checkpoint = workspace_file(workspace, args.checkpoint)
    receipt = json.loads(workspace_file(workspace, args.training_receipt).read_text())['summary']
    source_hash, checkpoint_hash = sha(source), sha(checkpoint)
    if receipt.get('environment') != 'SO101PickCube' or receipt.get('inputMjcfSha256') != source_hash or receipt.get('checkpointSha256') != checkpoint_hash or type(receipt.get('seed')) is not int:
        raise ValueError('PLAYGROUND_EVAL_TRAINING_RECEIPT_MISMATCH')
    seeds = list(range(args.seed, args.seed + args.episodes))
    if receipt['seed'] in seeds:
        raise ValueError('PLAYGROUND_EVAL_SEED_OVERLAPS_TRAINING')
    trained = torch.load(checkpoint, map_location='cpu', weights_only=True)['actor_state_dict']
    original_get = asset.get

    def local_asset(uri):
        if uri == ROBOT_URI:
            return original_get(f'local:{source}')
        if uri.startswith('runfile:'):
            return original_get(uri)
        raise ValueError(f'PLAYGROUND_ASSET_NOT_PROVIDED: {uri}')

    asset.get = local_asset
    results = []
    try:
        for seed in seeds:
            pair = []
            for variant in ('zero-action', 'checkpoint'):
                rng.seed(seed)
                entry = env_registry.get('SO101PickCube')
                raw = entry.env_builder(nworld=1, device='cpu', impl='cpp')
                env = None
                try:
                    env = RslRlVecEnvWrapper(raw, clip_actions=entry.runner_cfg.clip_actions, cfg=entry.runner_cfg.vecenv_wrapper_cfg)
                    simulator = raw.device_layer.sim
                    if simulator.impl.name != 'CPP':
                        raise RuntimeError('PLAYGROUND_EVAL_CPU_NATIVE_REQUIRED')
                    model, data = simulator.mj_model, simulator.mj_data
                    cube, goal = model.body('cube/cube').id, model.body('target/target').id
                    runner = OnPolicyRunner(env, dataclasses.asdict(entry.runner_cfg), device='cpu')
                    if variant == 'checkpoint':
                        runner.alg.actor.load_state_dict(trained, strict=True)
                    inference = runner.get_inference_policy(device='cpu')
                    rng.seed(seed)
                    obs, _ = env.reset()
                    mujoco.mj_forward(model, data)
                    initial = {'qpos': data.qpos.tolist(), 'qvel': data.qvel.tolist(),
                               'cubeM': data.xpos[cube].tolist(), 'goalM': data.xpos[goal].tolist()}
                    directory = args.output / f'{seed}-{variant}'
                    directory.mkdir()
                    frames = []
                    records = []
                    camera = mujoco.MjvCamera()
                    camera.lookat[:] = [.16, 0, .14]
                    camera.azimuth, camera.elevation, camera.distance = 115, -35, .78
                    with mujoco.Renderer(model, height=240, width=320) as renderer, torch.inference_mode():
                        def capture():
                            renderer.update_scene(data, camera=camera)
                            frames.append(Image.fromarray(renderer.render().copy()))

                        capture()
                        for step in range(1, args.steps + 1):
                            action = inference(obs) if variant == 'checkpoint' else torch.zeros((1, env.num_actions), dtype=torch.float32)
                            if not torch.isfinite(action).all():
                                raise RuntimeError('PLAYGROUND_EVAL_NONFINITE_ACTION')
                            obs, reward, done, extras = env.step(action)
                            reset = bool(done.item())
                            term = float(extras['reward_terms_per_world']['success'].item())
                            row = {'step': step, 'reward': float(reward.item()), 'upstreamSuccess': term > 0,
                                   'terminated': reset, 'timeLimit': bool(extras.get('time_outs', done).item()) if reset else False}
                            if not reset:
                                mujoco.mj_forward(model, data)
                                row.update(cubeM=data.xpos[cube].tolist(), goalM=data.xpos[goal].tolist())
                                if step % 6 == 0 or step == args.steps:
                                    capture()
                            records.append(row)
                            if reset:
                                break
                    gif = directory / 'replay.gif'
                    frames[0].save(gif, save_all=True, append_images=frames[1:], loop=0, duration=120)
                    success = any(row['upstreamSuccess'] for row in records)
                    heights = [row['cubeM'][2] for row in records if 'cubeM' in row]
                    result = {'seed': seed, 'variant': variant, 'steps': len(records),
                              'officialSuccess': success, 'peakCubeZM': max(heights, default=initial['cubeM'][2]),
                              'reason': 'upstream-goal' if success else 'early-termination' if records[-1]['terminated'] and not records[-1]['timeLimit'] else 'goal-not-achieved',
                              'initial': initial, 'trace': str((directory/'steps.json').relative_to(args.output)),
                              'recording': str(gif.relative_to(args.output))}
                    write(directory/'steps.json', records)
                    write(directory/'result.json', result)
                    pair.append(result)
                finally:
                    (env if env is not None else raw).close()
            if pair[0]['initial'] != pair[1]['initial']:
                raise RuntimeError(f'PLAYGROUND_EVAL_PAIRED_RESET_MISMATCH: {seed}')
            results.extend(pair)
            write(args.output/'episodes.json', results)
    finally:
        asset.get = original_get
    return {'environment': 'SO101PickCube', 'deployment': 'independent-mujoco-cpu', 'seedStart': args.seed, 'episodesPerVariant': len(seeds),
            'checkpointSha256': checkpoint_hash, 'mjcfSha256': source_hash, 'trainingSeed': receipt['seed'],
            'officialSuccesses': {variant: sum(r['officialSuccess'] for r in results if r['variant'] == variant) for variant in ('zero-action', 'checkpoint')},
            'recordings': len(results), 'artifact': 'episodes.json'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ('source', 'checkpoint', 'training-receipt', 'workspace', 'output'):
        parser.add_argument('--' + field, type=Path, required=True)
    for field in ('episodes', 'steps', 'seed'):
        parser.add_argument('--' + field, type=int, required=True)
    args = parser.parse_args()
    write(args.output/'result.json', {'summary': evaluate(args)})


if __name__ == '__main__':
    main()
