"""冻结 T0–T4 条件，每档保留覆盖所需的原生样本。"""
import argparse
import dataclasses
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages/robot-workflows/python'))
from agy.perturb_spec import TIERS, sample, streams


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seed', type=int, default=9131)
    args = parser.parse_args()
    coverage = {'T0': ['base'], 'T1': ['base'], 'T2': ['frame_delay=0', 'frame_delay=1'],
                'T3': ['slip', 'push', 'knockout'], 'T4': ['camera_freeze', 'dead_gripper', 'base']}
    out = []
    for tier in TIERS:
        found = {}
        for index in range(256):
            draw = streams(args.seed, 'so101-tabletop', tier, index, secret='')
            profile = dataclasses.asdict(sample(tier, index, draw.spec))
            case = f"frame_delay={profile['frame_delay']}" if tier == 'T2' else (profile['disturbance'] or profile['fault'] or 'base')
            if case == 'camera_freeze' and (profile['fault_trigger'] != 'arm_motion' or not profile['fault_restamp']):
                continue
            if case in coverage[tier] and case not in found:
                seed = int.from_bytes(hashlib.sha256(f'{args.seed}/{tier}/{index}'.encode()).digest()[:4], 'little')
                found[case] = {'id': f'{tier}-{index}', 'tier': tier, 'seed': seed,
                               'baseSeed': args.seed, 'coverage': case, 'profile': profile}
            if len(found) == len(coverage[tier]):
                break
        assert set(found) == set(coverage[tier]), tier
        out.extend(found[case] for case in coverage[tier])
    args.output.write_text(json.dumps(out, indent=2, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    main()
