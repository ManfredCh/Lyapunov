"""Verify accepted artifacts and assemble the standalone AGY robotics report."""
import argparse
from collections import Counter
import hashlib
from html import escape
import json
from math import dist
import os
from pathlib import Path
import subprocess

from mcap.reader import make_reader
from PIL import Image, ImageDraw
from zstandard import ZstdDecompressor


def load(path):
    return json.loads(path.read_text())


def plot(out, paths, obstacles):
    image = Image.new('RGB', (1000, 544), '#f4f7fa')
    draw = ImageDraw.Draw(image)
    for row, (depth, lo, hi, label) in enumerate(((1, -.4, .4, 'Plan view / XY'), (2, -.03, .48, 'Profile / XZ'))):
        top = 20 + row * 251
        x1, x2, y1, y2 = 48, 963, top+38, top+221
        draw.rectangle((x1, y1, x2, y2), outline='#d7e4ee', fill='white')
        draw.text((x1, top+12), label, fill='#183049', font_size=18)

        def pixel(p):
            return (int(x1 + (p[0]+.36)/.72*(x2-x1)), int(y2 - (p[depth]-lo)/(hi-lo)*(y2-y1)))

        for obstacle in obstacles:
            if depth == 1 and obstacle['name'] == 'work_surface':
                continue
            c, h = obstacle['center'], obstacle['halfExtents']
            p1 = pixel([a-b for a, b in zip(c, h)])
            p2 = pixel([a+b for a, b in zip(c, h)])
            draw.rectangle((max(x1, p1[0]), max(y1, p2[1]), min(x2, p2[0]), min(y2, p1[1])), fill='#d7dce2')
        for path, color in paths:
            coords = [pixel(point) for point in path]
            draw.line(coords, fill=color, width=4)
            for x, y in coords:
                draw.ellipse((x-3, y-3, x+3, y+3), fill=color)
    image.save(out)


def file_receipt(path, root):
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'path': str(path.relative_to(root)), 'bytes': path.stat().st_size, 'sha256': digest}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--job-dir', default='final-v4')
    args = parser.parse_args()
    root = args.root.resolve()
    stage = root / args.job_dir
    so101 = root / 'so101'
    run_evidence = stage / 'native-jobs.json'
    jobs = load(run_evidence)
    output = {id_: result['output']['summary'] for id_, result in jobs.items() if isinstance(result, dict) and result.get('status') == 'completed' and id_ != 'blender'}
    ppo = output.get('ppo')
    assert len(output) == (18 if ppo else 17) and jobs['blender']['status'] == 'completed'
    assert output['probe']['missing'] and all(not value for value in output['probe']['missing'].values())

    def native(id_, filename):
        return Path(jobs[id_]['outputDir']) / filename

    if ppo:
        checkpoint = native('ppo', ppo['checkpoint'])
        training_log = native('ppo', ppo['log'])
        assert ppo['steps'] == 16 and ppo['iterations'] == 1 and ppo['device'] == 'cpu'
        assert file_receipt(checkpoint, root)['sha256'] == ppo['checkpointSha256']
        assert 'Total steps: 16' in training_log.read_text()

    exact_file, vision_file = (native(id_, 'trajectory.json') for id_ in ('exactPlan', 'visionPlan'))
    localization_file = native('visionPlan', 'localization.json')
    exact, vision = load(exact_file), load(vision_file)
    exact_summary, vision_summary = output['exactPlan'], output['visionPlan']['trajectory']
    assert exact_summary['sampledPathValid'] and vision_summary['sampledPathValid'] and not exact['reference']['valid'] and not vision['reference']['valid']
    inputs = load(stage / 'exact-plan.json')
    radius = inputs['spheres'][0]['radius']
    for candidate in (exact, vision):
        assert min(point[2] for point in candidate['plan']['waypoints']) >= radius, '轨迹需完整位于台面以上'
    expected = load(stage / 'truth.json')['targetPositionM']
    observed = output['visionPlan']['localizedStartM']
    error_mm = dist(expected, observed) * 1000
    exact_clearance, vision_clearance = (
        min(segment['min_clearance_m'] for segment in candidate['segmentChecks']) * 1000
        for candidate in (exact, vision)
    )
    assert error_mm < 3 and output['yam']['solved'] and output['fr3']['sampledPathValid']
    assert output['ibvs']['computed'] and output['rl']['findings'] == 1
    assert output['schedule']['cases'] == 20 and len(load(native('schedule','schedule.json'))['schedule']) == 20
    assert output['calibration']['rmse_reprojection_px'] == 0
    calibration = output['playgroundCamera']
    assert calibration['intrinsics'][0][2] == 160 and calibration['worldFromCamera'][2][2] == -1
    video_paths = sorted(so101.rglob('*.mp4'))
    for path in video_paths:
        result = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', str(path)], check=True, capture_output=True, text=True)
        assert result.stdout.strip() == 'video', path
    mcap = native('mcap', 'calls.mcap')
    with mcap.open('rb') as stream:
        messages = list(make_reader(stream).iter_messages(log_time_order=False))
    assert len(messages) == jobs['campaignCalls'] and all(ch.topic == 'lyapunov/campaign/call' for _, ch, _ in messages)
    with (stage / 'exported-calls.jsonl').open('rb') as stream:
        assert [msg.data for _, _, msg in messages] == stream.read().splitlines()

    asset_sheet = native('audit', 'asset_scenarios.png')
    showcase = native('showcase', 'showcase.png')
    scenario_file = native('audit', 'asset_scenarios.json')
    scenario_stats = Counter(entry['status'] for entry in load(scenario_file)['scenarios'].values())
    assert sum(scenario_stats.values()) == 10
    blend = Path(jobs['blender']['output']['source'])
    glb = next((stage / 'blender-prop/visuals').glob('*.glb'))
    with glb.open('rb') as stream:
        assert stream.read(4) == b'glTF'
    with blend.open('rb') as stream:
        if stream.read(7) != b'BLENDER':
            stream.seek(0)
            with ZstdDecompressor().stream_reader(stream) as decompressed:
                assert decompressed.read(7) == b'BLENDER'
    for image in (asset_sheet, showcase, stage/'camera-0.png', stage/'camera-1.png'):
        with Image.open(image) as opened:
            opened.verify()
    baseline_video = so101/'paired/episodes/stress-6151-baseline/replay.mp4'
    candidate_video = so101/'paired/episodes/stress-6151-candidate/replay.mp4'
    comparison = load(so101 / 'summary.json')
    assert comparison['completePairs'] == 12 and len(video_paths) == 27
    assert comparison['safety']['baselineSafePass'] == 7 and comparison['safety']['candidateSafePass'] == 6

    chart = root / 'paths.png'
    plot(chart, [
        ([inputs['start'], inputs['goal']], '#c33b30'),
        (exact['plan']['waypoints'], '#1250a2'),
        (vision['plan']['waypoints'], '#008061'),
    ], inputs['obstacles'])
    summary = {
        'nativeJobCompletions': len(output) + 1, 'domainSkillsDiscovered': len(jobs['skills']),
        'campaignCallCount': jobs['campaignCalls'], 'mcapDecodedMessages': len(messages),
        'perceptionErrorMm': error_mm, 'exactPlanWaypoints': exact_summary['waypoints'],
        'visionPlanWaypoints': vision_summary['waypoints'], 'straightPathFirstBreachM': exact['reference']['min_clearance_m'],
        'sampledClearanceMm': {'exactPlan': exact_clearance, 'visionPlan': vision_clearance},
        'auditScenarios': dict(scenario_stats), 'YamIK': output['yam'], 'Fr3': output['fr3'],
        'hardware': output['hardware'], 'optionalDependencies': output['probe']['optional'],
        'scheduleCases': output['schedule']['cases'], 'physicalSort': comparison,
        **({'playgroundPpo': ppo} if ppo else {}),
    }
    (root / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n')
    sources = [run_evidence, exact_file, vision_file, localization_file, mcap, asset_sheet, showcase, scenario_file, blend, glb,
               stage/'camera-0.png', stage/'camera-1.png', stage/'menagerie-supply.json',
               so101/'summary.json', so101/'paired/comparison.json', so101/'paired/checkpoint-replay.json', so101/'paired/fault-results.json', *video_paths]
    if ppo:
        sources.extend([native('ppo','result.json'), checkpoint, training_log])
    (root / 'evidence.json').write_text(json.dumps([file_receipt(path, root) for path in sources], indent=2) + '\n')

    def href(path):
        return escape(os.path.relpath(path, root), quote=True)

    def link(path, label):
        return f'<a href="{href(path)}">{escape(label)}</a>'

    raw_links = ' · '.join(link(path, label) for path, label in (
        (run_evidence, '原生 Job 回执'), (exact_file, '精确起点轨迹'), (vision_file, 'RGB 起点轨迹'),
        (localization_file, '定位原件'), (mcap, 'MCAP'), (blend, 'Blender 源文件'), (glb, 'GLB'),
        (scenario_file, '十工况原件'), (so101/'index.html', '全部抓放、判定和回放'),
        (root/'summary.json', '摘要'), (root/'evidence.json', 'SHA-256 清单'), (root/'STAGE_SUMMARY.md','实验时间线')))
    hero = ''.join(f'<div><h3>{label}</h3><video controls muted autoplay loop preload="metadata" src="{href(path)}"></video></div>'
                   for path, label in ((baseline_video,'参考开爪，种子 6151'), (candidate_video,'安全开爪，种子 6151')))
    images = ''.join(f'<figure><a href="{href(path)}"><img src="{href(path)}" alt="{name}"></a><figcaption>{name}</figcaption></figure>'
                     for path, name in ((stage/'camera-0.png','真实仿真 RGB 视角一'), (stage/'camera-1.png','真实仿真 RGB 视角二'),
                                        (asset_sheet,'十工况物理审计'), (showcase,'28 格视觉／碰撞检查')))
    training_card = (
        f'<section><h2>Playground 训练入口</h2><p>SO101PickCube 在 2 个 CPU 并行环境执行 16 个仿真步、1 次 PPO 更新。'
        f'权重的完整入盒能力待独立评估。{link(training_log, "训练日志")} · {link(checkpoint, "检查点")}</p></section>'
        if ppo else ''
    )
    fragment = f"""<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><title>机器人组合技能验收</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{{max-width:1060px;margin:2rem auto;padding:0 20px;font:16px/1.55 system-ui,sans-serif;color:#17283d}}
h1,h2{{line-height:1.2}}section{{margin:2rem 0}}.notice{{background:#fff3da;border-inline-start:4px solid #af7222;padding:.8rem 1rem}}
.grid{{display:grid;gap:1.1rem;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}}figure{{margin:0}}img,video{{width:100%;height:auto;max-height:450px;object-fit:contain;background:#f4f7fa}}
table{{width:100%;border-collapse:collapse}}td,th{{padding:.45rem .6rem;text-align:left;border-bottom:1px solid #dbe4ef}}
a{{color:#154b8e}}</style><h1>机器人组合技能验收</h1>
<aside class="notice">离线组合、原生 Job 与 SO-101 回归均有实测。真机控制、Playground 策略效果、T0–T4 实际扰动与整臂视觉闭环还缺运行证据。</aside>
<section><h2>SO-101 原生分拣回归</h2><p>12 对。参考 7 次入盒，候选 6 次。历史失败三例的开爪接触从 3 次降至 0 次。两段视频采用同一扰动种子。</p><div class="grid">{hero}</div></section>
<section><h2>显式台面和隔板上的三种路径</h2>
<table><thead><tr><th>输入与方法</th><th>采样判定</th><th>路径点</th></tr></thead><tbody>
<tr><td>精确起点直走（红）</td><td>碰撞，首次侵入 4 mm</td><td>2</td></tr>
<tr><td>精确起点＋Bi-RRT（蓝）</td><td>通过，最小采样净空 {exact_clearance:.2f} mm</td><td>{exact_summary['waypoints']}</td></tr>
<tr><td>双视角 RGB 定位＋Bi-RRT（绿）</td><td>通过，最小采样净空 {vision_clearance:.2f} mm，起点误差 {error_mm:.2f} mm</td><td>{vision_summary['waypoints']}</td></tr>
</tbody></table><img src="{href(chart)}" alt="避障路径俯视和侧视投影"></section>
<section><h2>相机与资产检查</h2><div class="grid">{images}</div></section>
{training_card}
<section><h2>实验原件</h2><p>{raw_links}</p></section></html>"""
    (root / 'index.html').write_text(fragment)
    print(json.dumps({k: v for k, v in summary.items() if k != 'physicalSort'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
