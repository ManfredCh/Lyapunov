"""校验 SO-101 双批次分叉产物，生成本地 HTML 回放页和汇总。"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
from html import escape
import json
from pathlib import Path
from os.path import relpath
import subprocess

METHODS = {'reference':'历史参考', 'raised':'抬高 4 mm', 'segmented':'分段下降', 'raised-segmented':'抬高并分段'}
BATCHES = {'diagnostic':'诊断批次', 'crossSeed':'跨种子复跑'}


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def video_ok(path):
    video = json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0',
        '-show_entries','stream=codec_name,width,height,duration,nb_frames','-of','json',str(path)], text=True))['streams'][0]
    assert (video['codec_name'],video['width'],video['height']) == ('h264',480,360)
    assert int(video['nb_frames']) > 0 and float(video['duration']) > 0
    return True


def summarize(batch):
    summary = read(batch/'summary.json')
    assert summary['mujoco'] == '3.13.0'
    assert set(summary['variants']) == set(METHODS)
    assert len(summary['cases']) == len({a['case'] for a in summary['cases']}) == 12
    stats = {k:{'passed':0,'rescued':0,'regressed':0,'probed':0,'probeAgreed':0} for k in METHODS}
    videos = []
    for case in summary['cases']:
        d = batch/case['case']
        assert case['deterministicReference'] and (d/'pre-descent-state.npy').is_file()
        c = case['variants']
        endpoints, windows = {}, {}
        for variant in METHODS:
            path = d/variant
            result = read(path/'result.json')
            commands = read(path/'actions.json')
            trace = (path/'contact-trace.jsonl').read_text(encoding='utf-8')
            lines = trace.splitlines()
            assert digest(('[' + ','.join(lines) + ']').encode()) == result['traceSha256']
            assert case['checkpointSha256'] == result['checkpointSha256']
            c[variant]['probePassed'] = None
            if result['completed']:
                assert result['liftPassed'] == c[variant]['liftPassed']
                assert [x['request']['actionId'] for x in commands] == ['descend','close','lift']
                endpoints[variant] = commands[0]['request']['points'][-1]['positions']
                windows[variant] = [x['step'] for x in commands]
                assert commands[0]['request']['points'][-1]['timeS'] == .55
                # 离线试抬判据，度量已经发生的动作，不触发追加动作。
                lift = [x for x in map(json.loads,lines) if x['phase'] == 'lift']
                start = lift[0]
                probe = next((x for x in lift if x['tcpM'][2] - start['tcpM'][2] >= .008),None)
                if probe:
                    forces = probe['normalForceN']
                    passed = bool(probe['targetM'][2] - start['targetM'][2] >= .003 and forces['fixedFinger'] > 0
                                  and forces['movingFinger'] > 0 and forces['targetSupport'] == 0)
                    c[variant]['probePassed'] = passed
                    stats[variant]['probed'] += 1
                    stats[variant]['probeAgreed'] += passed == result['liftPassed']
            stats[variant]['passed'] += result['liftPassed']
            if variant != 'reference':
                stats[variant]['rescued'] += result['liftPassed'] and not c['reference']['liftPassed']
                stats[variant]['regressed'] += not result['liftPassed'] and c['reference']['liftPassed']
            videos.append(path/'replay.mp4')
        assert len({tuple(a) for a in windows.values()}) <= 1
        for a,b in (('reference','segmented'),('raised','raised-segmented')):
            if a in endpoints and b in endpoints:
                assert endpoints[a] == endpoints[b], (d,a,b)
    with ThreadPoolExecutor(max_workers=6) as pool:
        assert all(pool.map(video_ok,videos))
    summary['counts'] = stats
    summary['validatedVideos'] = len(videos)
    summary['historicalAgreements'] = sum(x['referenceAgrees'] for x in summary['cases'])
    return summary


def render(output, paths, batches):
    def href(path):
        return escape(relpath(path,output),quote=True)

    def card(key,case,variant,autoplay=False):
        place = paths[key]/case['case']/variant
        r = case['variants'][variant]
        mark = '通过' if r['liftPassed'] else '失败'
        css = 'ok' if r['liftPassed'] else 'fail'
        rise = f"净抬升 {r['liftM']*1000:.1f} mm，下降肩执行器饱和 {r['descentShoulderSaturatedSteps']} 步" if r['completed'] else r['error']
        return f'''<article><video src="{href(place/'replay.mp4')}" controls muted playsinline {'autoplay loop' if autoplay else 'preload="none"'}></video>
        <div><strong>{METHODS[variant]}</strong> <span class="{css}">{mark}</span><p>{escape(rise)}</p>
        <small><a href="{href(place/'result.json')}">阶段回执</a> · <a href="{href(place/'contact-trace.jsonl')}">逐步接触</a> · <a href="{href(place/'actions.json')}">动作请求</a></small></div></article>'''

    table=''.join(f'''<tr><td>{method}</td><td>{batches['diagnostic']['counts'][name]['passed']}/12</td>
        <td>{batches['crossSeed']['counts'][name]['passed']}/12</td></tr>''' for name,method in METHODS.items())
    a,b=batches['diagnostic'],batches['crossSeed']
    hero=next(c for c in a['cases'] if not c['variants']['reference']['liftPassed'] and c['variants']['segmented']['liftPassed'])
    panels=[]
    for key,batch in batches.items():
        panels.append(f'<h2>{BATCHES[key]}</h2>')
        for case in batch['cases']:
            names=' · '.join(METHODS[k] for k in METHODS if case['variants'][k]['liftPassed'])
            cards=''.join(card(key,case,k) for k in METHODS)
            panels.append(f'<details><summary>{escape(case["case"])} · 通过 {escape(names or "0 项")}</summary><div class="grid">{cards}</div></details>')
    page=f'''<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SO-101 抓取失败分叉</title><style>
*{{box-sizing:border-box}}body{{margin:0;background:#f6f8f7;color:#17292b;font:16px system-ui,sans-serif}}main{{max-width:1120px;margin:auto;padding:30px 20px 60px}}h1{{margin:8px 0 16px}}h2{{margin-top:30px}}.note{{background:#e2efeb;border-left:4px solid #137760;padding:12px 16px;margin-bottom:24px}}p,small{{line-height:1.5}}.grid{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}}article,table,details{{background:white;border:1px solid #d9e4e1;border-radius:8px}}article{{overflow:hidden}}article>div{{padding:13px}}article p{{margin:6px 0}}video{{display:block;background:#1e2626;aspect-ratio:4/3;width:100%}}a{{color:#107060}}.ok,.fail{{padding:2px 6px;border-radius:4px;font-size:13px}}.ok{{background:#d9f1e4;color:#184b37}}.fail{{background:#f6e5e1;color:#823325}}table{{border-collapse:collapse;width:100%}}td,th{{padding:11px;text-align:left;border-bottom:1px solid #d9e4e1}}details{{padding:10px 12px;margin:8px 0}}summary{{cursor:pointer;font-weight:600}}details .grid{{margin-top:12px}}@media(max-width:660px){{.grid{{grid-template-columns:1fr}}}}
</style><main><h1>SO-101 抓取失败分叉</h1>
<div class="note">从同一仿真状态改变下降路径，共 24 个案例、96 次分叉。分段下降在诊断批次为 {a['counts']['segmented']['passed']}/12，跨种子复跑为 {b['counts']['segmented']['passed']}/12。验收终点为夹持抬升。</div>
<h2>{escape(hero['case'])} 的同状态对照</h2><p>两段画面从同一个下降前快照开始，按仿真时间播放。</p><div class="grid">{card('diagnostic',hero,'reference',True)}{card('diagnostic',hero,'segmented',True)}</div>
<h2>两批抬升通过数</h2><table><thead><tr><th>下降方式</th><th>诊断批次</th><th>跨种子复跑</th></tr></thead><tbody>{table}</tbody></table>
{''.join(panels)}<p><a href="STAGE_SUMMARY.md">研究记录</a> · <a href="results.json">汇总及试抬诊断</a></p></main></html>'''
    (output/'index.html').write_text(page,encoding='utf-8')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--diagnostic',type=Path,required=True)
    p.add_argument('--cross-seed',type=Path,required=True)
    args=p.parse_args()
    paths={'diagnostic':args.diagnostic.resolve(),'crossSeed':args.cross_seed.resolve()}
    batches={name:summarize(path) for name,path in paths.items()}
    output=paths['diagnostic']
    (output/'results.json').write_text(json.dumps(batches,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    render(output,paths,batches)
    print(json.dumps({k:{q:v[q] for q in ('counts','historicalAgreements','validatedVideos')} for k,v in batches.items()},ensure_ascii=False))


if __name__=='__main__':
    main()
