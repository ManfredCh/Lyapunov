"""核对严格配对的原生操作、录像及统计，并生成 HTML 回放页。"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from html import escape
import json
from os.path import relpath
from pathlib import Path
import subprocess
import tempfile

LABELS = {'nominal':'标称', 'shift':'偏移', 'stress':'强化扰动'}
VARIANTS = ('baseline','candidate')
BATCHES = {
    'heldout': ('分段下降 · 独立新种子','原下降','分段下降'),
    'crossSeed': ('分段下降 · 历史种子复跑','原下降','分段下降'),
    'reacquire': ('腕相机复拍 · 针对历史视野故障','单次观测','有界退远复拍'),
}


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def make_video(root, episode_path, recording_id):
    recording = root/'recordings/sessions/so101-paired'/recording_id
    manifest = read(recording/'recording.json')
    assert manifest['status'] == 'completed' and manifest['frameCount'] > 0 and not manifest['missing']
    rgb = next(c for c in manifest['channels'] if c['channel'] == 'rgb')
    samples = [(recording/item['uri'], frame['simTime']) for frame in rgb['samples'] for item in frame['files'] if item['role'] == 'rgb']
    assert samples and all(path.stat().st_size > 0 for path,_ in samples)
    video = episode_path.parent/'replay.mp4'
    if not video.exists():
        def quoted(path):
            return "file '" + str(path).replace("'", "'\\''") + "'"
        with tempfile.TemporaryDirectory(prefix='so101-native-media-') as temp:
            playlist = Path(temp)/'frames.txt'
            lines = []
            for i,(sample,t) in enumerate(samples):
                duration = (samples[i+1][1]-t)/3 if i+1<len(samples) else .3
                assert duration >= 0
                lines.extend([quoted(sample),f'duration {max(.06,duration):.6f}'])
            playlist.write_text('\n'.join([*lines, quoted(samples[-1][0])])+'\n',encoding='utf-8')
            subprocess.run(['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-n','-f','concat','-safe','0','-i',str(playlist),
                '-an','-vf','fps=20,format=yuv420p','-c:v','libx264','-threads','1','-movflags','+faststart',str(video)],check=True)
    facts = json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0',
        '-show_entries','stream=codec_name,width,height,nb_frames','-of','json',str(video)],text=True))['streams'][0]
    assert (facts['codec_name'],facts['width'],facts['height']) == ('h264',320,240) and int(facts['nb_frames']) > 0
    return video,samples[0][0],recording/'recording.json'


def batch_data(root):
    campaign = read(root/'comparison.json')
    comparison = campaign['comparison']
    assert campaign['campaign']['status'] == 'completed' and (comparison['complete'],comparison['incomplete']) == (12,0)
    controls = read(root/'goal-controls.json')
    assert len(controls)==4 and sum(x['expected'] for x in controls)==1 and all(x['observed']['evaluated'] and x['expected']==x['observed']['taskAchieved'] for x in controls)
    cases, work = [], []
    for pair in comparison['pairs']:
        members = {}
        for variant in VARIANTS:
            index = pair[variant]
            native = index['result']
            path = root/'episodes'/index['taskId']/'episode.json'
            episode = read(path)
            run_path = root/'.lyapunov/campaigns'/campaign['campaign']['campaignId']/'runs'/native['runId']/'run.json'
            run = read(run_path)
            assert pair['requirePreflight'] and native == episode['run']['pairResult']
            assert native['taskAchieved'] == episode['verdict']['taskAchieved'] == (run['summary']['outcome'] == 'success')
            assert native['executionMode'] == 'physical-contact' and native['assistAdvanceCount'] == 0
            assert episode['initial']['stepIndex'] == episode['preflight']['stepIndex'] == 0
            preflights = [x['pairEvidence'] for x in run['calls'] if x.get('pairEvidence',{}).get('kind') in ('initial','preflight')]
            assert [x['kind'] for x in preflights] == ['initial','preflight'] and len({f['frameId'] for f in preflights}) == 1
            assert preflights[0]['stateSha256'] == native['initialStateSha256']
            assert len(native['workflows']) >= 1 and native['workflows'][0]['tool'] == 'robot_pick'
            assert native['recordingId'] == episode['recording']['recordingId']
            member = {'episode':episode,'path':path,'run':run_path,'native':native}
            members[variant] = member
            work.append(member)
        a,b = (members[v] for v in VARIANTS)
        assert a['native']['initialStateSha256'] == b['native']['initialStateSha256'] and a['episode']['condition']==b['episode']['condition']
        cases.append((pair,members))
    def render_member(member):
        member['video'],member['poster'],member['recording'] = make_video(root,member['path'],member['native']['recordingId'])
    with ThreadPoolExecutor(max_workers=5) as pool:
        list(pool.map(render_member,work))
    return comparison, cases


def make_html(root, data):
    def href(path):
        return escape(relpath(path,root),quote=True)

    def card(labels,variant,item,hero=False):
        episode,native = item['episode'],item['native']
        label = '通过' if native['taskAchieved'] else '失败'
        note = '实际终态通过' if native['taskAchieved'] else '。'.join(episode['failures'])
        if episode.get('pick',{}).get('effect',{}).get('wristReacquisition'):
            note = '触发一次退远复拍。' + note
        attrs = 'autoplay loop' if hero else 'preload="none"'
        return f'''<article><video controls muted playsinline {attrs} poster="{href(item['poster'])}" src="{href(item['video'])}"></video><div><b>{labels[VARIANTS.index(variant)+1]}</b> <span>{label}</span><p>{escape(note)}</p><small><a href="{href(item['path'])}">判定与动作</a> · <a href="{href(item['run'])}">Agent Graph 证据</a> · <a href="{href(item['recording'])}">原生录制</a> · <a href="{href(item['video'])}">MP4</a></small></div></article>'''

    sections = []
    for key,(comparison,cases) in data.items():
        labels = BATCHES[key]
        rows = ''.join(f'<tr><td>{LABELS[t["tier"]]}</td><td>{t["both"]+t["baselineOnly"]}/{t["complete"]}</td><td>{t["both"]+t["candidateOnly"]}/{t["complete"]}</td><td>{t["candidateOnly"]}</td><td>{t["baselineOnly"]}</td></tr>' for t in comparison['tiers'])
        sections.append(f'''<h2>{labels[0]}</h2><table><thead><tr><th>扰动</th><th>{labels[1]}</th><th>{labels[2]}</th><th>仅候选通过</th><th>仅参考通过</th></tr></thead><tbody>{rows}</tbody></table><p>完整对 {comparison['complete']}/12，配对精确检验 p={comparison['statistics']['exactMcNemarP']:.5g}。</p>''')
        for pair, members in cases:
            cards=''.join(card(labels,v,members[v]) for v in VARIANTS)
            sections.append(f'<details><summary>{escape(pair["id"])} · {labels[1]} {"通过" if members["baseline"]["native"]["taskAchieved"] else "失败"} · {labels[2]} {"通过" if members["candidate"]["native"]["taskAchieved"] else "失败"}</summary><div class="grid">{cards}</div></details>')
    hero_key = next((key for key in ('reacquire','crossSeed','heldout') if any(p['outcome']=='candidateOnly' for p,_ in data[key][1])), 'heldout')
    hero_pair, hero = next(((p,m) for p,m in data[hero_key][1] if p['outcome']=='candidateOnly'),data[hero_key][1][0])
    hero_html = ''.join(card(BATCHES[hero_key],v,hero[v],True) for v in VARIANTS)
    body=f'''<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SO-101 原生 Agent Graph 评测</title>
<style>*{{box-sizing:border-box}}body{{margin:0;background:#f3f6f5;color:#15272a;font:16px system-ui,sans-serif}}main{{max-width:1080px;margin:auto;padding:24px 18px 45px}}h1{{margin:8px 0 20px}}h2{{margin-top:28px}}.note{{background:#e0ede9;border-left:4px solid #137760;padding:12px 16px;margin-bottom:20px}}p,small{{line-height:1.52}}.grid{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}}article,table,details{{background:white;border:1px solid #d8e3e0;border-radius:8px}}article{{overflow:hidden}}article>div{{padding:12px}}article p{{margin:6px 0;overflow-wrap:anywhere}}video{{display:block;background:#142022;aspect-ratio:4/3;width:100%}}a{{color:#0e695a}}table{{border-collapse:collapse;width:100%}}td,th{{padding:10px;text-align:left;border-bottom:1px solid #d8e3e0}}details{{padding:10px;margin-top:8px}}summary{{cursor:pointer;font-weight:600}}details .grid{{margin-top:8px}}@media(max-width:650px){{.grid{{grid-template-columns:1fr}}}}</style>
<main><h1>SO-101 原生 Agent Graph 评测</h1><div class="note">三批共 36 对完整抓放。每对从第 0 步相同观测状态开始，终态以原生谓词和录制判分。分段下降与退远复拍独立对照。真机和运行时故障注入待验证。</div>
<h2>{BATCHES[hero_key][0]} · {escape(hero_pair['id'])}</h2><p>画面为 MuJoCo 原生 RGB，按仿真时间约 3 倍速回放。</p><div class="grid">{hero_html}</div>
{''.join(sections)}<p><a href="STAGE_SUMMARY.md">研究记录</a> · <a href="results.json">汇总</a></p></main></html>'''
    (root/'index.html').write_text(body,encoding='utf-8')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for stage in ('heldout','cross-seed','reacquire'):
        p.add_argument('--'+stage,type=Path,required=True)
    a=p.parse_args()
    paths={'heldout':a.heldout.resolve(),'crossSeed':a.cross_seed.resolve(),'reacquire':a.reacquire.resolve()}
    data={key:batch_data(path) for key,path in paths.items()}
    result={key:{**{k:v for k,v in comparison.items() if k!='pairs'},'validatedVideos':2*len(cases),
                 'goalControls':4,'reacquisitions':sum(bool(m['candidate']['episode'].get('pick',{}).get('effect',{}).get('wristReacquisition')) for _,m in cases)}
            for key,(comparison,cases) in data.items()}
    (paths['heldout']/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    make_html(paths['heldout'],data)
    for key,summary in result.items():
        print(key,json.dumps({k:v for k,v in summary.items() if k!='tiers'},ensure_ascii=False))


if __name__ == '__main__':
    main()
