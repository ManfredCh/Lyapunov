"""生成 Dev 三项仿真工作的可复核对照页。"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from html import escape
import importlib.util
import json
from pathlib import Path


def read(path):
    return json.loads(path.read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    gauntlet = root/'gauntlet-native'
    graph = read(gauntlet/'comparison.json')
    pairs = graph['comparison']['pairs']
    assert graph['comparison']['complete'] == len(pairs) == 10
    assert graph['comparison']['incomplete'] == 0
    yam_dir = Path(read(root/'yam-final/native-eval-job.json')['outputDir'])
    yam = read(yam_dir/'result.json')['summary']
    policy_dir = Path(read(root/'policy/native-eval-job.json')['outputDir'])
    policy = read(policy_dir/'result.json')['summary']
    rollouts = read(policy_dir/'episodes.json')
    assert len(rollouts) == policy['recordings'] == 12
    assert all((policy_dir/r['recording']).is_file() for r in rollouts)
    for seed in sorted({row['seed'] for row in rollouts}):
        a, b = [row for row in rollouts if row['seed'] == seed]
        assert a['initial'] == b['initial'] and seed != policy['trainingSeed']
    assert yam['modes']['feedback']['reason'] == 'converged'
    assert yam['modes']['freeze']['reason'] == 'stale-frame' and yam['modes']['freeze']['commands'] == 1
    assert yam['modes']['unreachable']['reason'] == 'ik-unreachable' and yam['modes']['unreachable']['commands'] == 0

    spec = importlib.util.spec_from_file_location('recording_media', Path(__file__).resolve().parents[1]/'agent-graph-gauntlet/report.py')
    media = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(media)

    def episode(member):
        path = gauntlet/'episodes'/member['taskId']/'episode.json'
        e = read(path)
        result = member['result']
        assert result and e['run']['pairResult'] == result
        video, _, recording = media.make_video(gauntlet, path, result['recordingId'])
        end = e['gauntletEnd']
        trace = e.get('pick',{}).get('effect',{}).get('wristFeedback',[])
        return {'taskId': member['taskId'], 'success': e['verdict']['taskAchieved'], 'reason': e['failures'],
                'safe': end is not None and e['safety']['passed'], 'forceSteps': end['forceSteps'],
                'forceN': end['forceN'], 'disturbance': end['disturbance'], 'fault': end['fault'],
                'faultStep': end['faultActualStep'], 'deliveries': end['cameraDeliveries'],
                'imageSamples': end['imageSamples'], 'jointSamples': end['jointSamples'],
                'feedbackResidualM': [r['residualM'] for r in trace],
                'episode': str(path.relative_to(root)), 'video': str(video.relative_to(root)), 'recording': str(recording.relative_to(root))}

    with ThreadPoolExecutor(max_workers=4) as pool:
        evaluated = list(pool.map(episode, (pair[key] for pair in pairs for key in ('baseline','candidate'))))

    rows, coverage = [], Counter()
    for idx, pair in enumerate(pairs):
        baseline, candidate = evaluated[2*idx:2*idx+2]
        for e in (baseline, candidate):
            if e['forceSteps']:
                coverage[e['disturbance']] += 1
            if e['faultStep'] is not None:
                coverage[e['fault']] += 1
            if any(d['delayed'] for d in e['deliveries']):
                coverage['frame-delay'] += 1
            if any(d['frozen'] and 'faultyReportedStep' in d for d in e['deliveries']):
                coverage['camera-restamp'] += 1
        rows.append({'id': pair['id'], 'tier': pair['tier'], 'outcome': pair['outcome'],
                     'baseline': baseline, 'candidate': candidate})
    for key in ('slip','push','knockout','dead_gripper','camera_freeze','frame-delay','camera-restamp'):
        assert coverage[key] == 2, (key, coverage)
    stalls = [e for e in evaluated if e['fault']=='dead_gripper']
    freezes = [e for e in evaluated if e['fault']=='camera_freeze']
    assert all(any('GRIPPER_STALL' in x for x in e['reason']) for e in stalls)
    assert all(any('WRIST_STALE_FRAME' in x for x in e['reason']) for e in freezes)
    assert all(e['jointSamples'] > 0 for e in evaluated)
    tier_table = {tier: {k: sum(row[k]['success'] for row in rows if row['tier']==tier) for k in ('baseline','candidate')}
                  for tier in sorted({row['tier'] for row in rows})}
    for tier, scores in tier_table.items():
        scores['pairs'] = sum(row['tier']==tier for row in rows)
    summary = {'gauntlet': {'validPairs': len(pairs), 'tiers': tier_table, 'coverage': dict(coverage),
                            'safety': graph['comparison']['safety'], 'recordings':len(evaluated)},
               'yam': yam, 'playground': policy}
    (root/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
    (root/'pairs.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')

    def rel(path):
        return escape(str(path.relative_to(root)), quote=True)

    table_rows = ''.join(f"<tr><td>{tier}</td><td>{s['pairs']}</td><td>{s['baseline']}</td><td>{s['candidate']}</td></tr>"
                         for tier,s in tier_table.items())
    info = '，'.join(f'{key} {num} 次' for key,num in coverage.items())
    yam_cards = ''.join(f'<article><h3>{name}</h3><a href="{rel(yam_dir/m["recording"])}"><img src="{rel(yam_dir/m["recording"])}" alt="{name} 仿真回放"></a><p>{m["reason"]} · {m["commands"]} 条关节命令 · {m["finalErrorPx"]:.2f} px</p><a href="{rel(yam_dir/m["trace"])}">逐帧回执</a></article>'
                        for name,m in yam['modes'].items())
    pair_rows = []
    for row in rows:
        cards = []
        for key,label in (('baseline','单次纠偏'),('candidate','反馈闭环')):
            e = row[key]
            reason = escape(e['reason'][0] if e['reason'] else '任务达成')
            cards.append(f'<article><h3>{label}</h3><video controls muted preload="none" src="{escape(e["video"])}"></video><p>{reason}</p><a href="{escape(e["episode"])}">原始判定与动作</a> · <a href="{escape(e["recording"])}">录制回执</a></article>')
        pair_rows.append(f'<details><summary>{row["id"]} · {row["outcome"]}</summary><div class="grid">{"".join(cards)}</div></details>')
    clips = ''.join(f'<li>{r["seed"]} {r["variant"]} <a href="{rel(policy_dir/r["recording"])}">回放</a> · <a href="{rel(policy_dir/r["trace"])}">轨迹</a></li>'
                    for r in rollouts)
    (root/'index.html').write_text(f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Dev 仿真扩展结果</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{{max-width:1060px;margin:24px auto;padding:0 18px;font:15px/1.58 system-ui,sans-serif;color:#183348;background:#f5f8fa}}
h1,h2{{line-height:1.2}} h2{{margin-top:2rem}} .lead{{padding:12px 15px;background:#e6f0f4;border-left:4px solid #176e88}} .grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}}
article,details{{background:#fff;padding:12px;margin:8px 0;border:1px solid #d8e3ea;border-radius:8px}}
img,video{{display:block;width:100%;max-height:270px;object-fit:contain;background:#e6edf2}} table{{width:100%;border-collapse:collapse;background:white}} td,th{{padding:6px;border-bottom:1px solid #d8e3ea}} a{{color:#075b76}} p{{overflow-wrap:anywhere}}
</style><h1>Dev 仿真扩展验收</h1><div class="lead">YAM 标记夹具达到视觉闭环阈值，SO‑101 完成五档物理仿真配对。Playground 检查点可在独立进程推理，当前保留种子成功率为 0/6。证据覆盖仿真夹具。</div>
<h2>YAM 六轴视觉闭环</h2><div class="grid">{yam_cards}</div><p><a href="{rel(yam_dir/'reference.png')}">腕相机目标参考图</a>。左侧是固定视点，右侧是控制器腕相机图。</p>
<h2>SO‑101 五档配对</h2><table><thead><tr><th>档位</th><th>有效对</th><th>单次纠偏达成</th><th>反馈闭环达成</th></tr></thead><tbody>{table_rows}</tbody></table><p>实际激活记录 {info}。</p>
{''.join(pair_rows)}
<h2>Playground 独立评估</h2><p>{policy["episodesPerVariant"]} 个相同保留种子，每组保留原生目标判定。零动作达成 {policy["officialSuccesses"]["zero-action"]} 次，检查点达成 {policy["officialSuccesses"]["checkpoint"]} 次。</p><ul>{clips}</ul>
<p><a href="STAGE_SUMMARY.md">研究过程</a> · <a href="summary.json">摘要</a> · <a href="pairs.json">逐对证据</a> · <a href="{rel(policy_dir/'episodes.json')}">Playground 原始判定</a></p>''', encoding='utf-8')
    print(json.dumps(summary,ensure_ascii=False))


if __name__ == '__main__':
    main()
