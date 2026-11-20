"""验证整批验收证据并生成回放入口。"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from html import escape
import importlib.util
import json
import math
from pathlib import Path

spec = importlib.util.spec_from_file_location('native_report',Path(__file__).resolve().parents[1]/'agent-graph-gauntlet/report.py')
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)
KNOWN = {6151,7129,7919}


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def target_shift(frame, initial):
    pos = next(x['transform']['position'] for x in frame['entities'] if x['entityId']=='target')
    return math.dist(pos[:2], initial[:2])*1000


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--batch',type=Path,required=True)
    args=p.parse_args()
    root=args.batch.resolve(); pairroot=root/'paired'
    process=read(root/'batch.json')
    assert all(x['exitCode']==0 for x in process.values())
    data=read(pairroot/'comparison.json'); comparison=data['comparison']
    assert data['campaign']['status']=='completed' and (comparison['complete'],comparison['incomplete'])==(12,0)
    assert comparison['safety']['complete']==12
    forks=read(pairroot/'checkpoint-replay.json')
    assert len(forks)==4 and {x['phase'] for x in forks}=={'beforeOpen','beforeDescend','beforeClose','beforeLift'}
    for x in forks:
        assert len(x['replicas'])==2 and len({r['final']['stateSha256'] for r in x['replicas']})==1
        assert all(r['replay']['status']=='completed' and r['replay']['endStep']==x['command']['endStep'] for r in x['replicas'])
    faults=read(pairroot/'fault-results.json')
    assert len(faults)==3 and sum(x['correctStop'] for x in faults)==2
    unsafe=next(x for x in faults if x['kind']=='arm-contact-limit')
    assert unsafe['pick']['taskAchieved'] and not unsafe['safety']['passed']
    audit=read(root/'asset-audit.json')
    assert all(x['expected']==x['passedCavity'] for x in audit['drops']) and all(x['expected']==x['passedTravel'] for x in audit['travel'])
    rows, jobs = [], []
    clearance=[]
    for x in comparison['pairs']:
        members={}
        for variant in ('baseline','candidate'):
            paired=x[variant]
            path=pairroot/'episodes'/paired['taskId']/'episode.json'
            e=read(path); facts=paired['result']; safety=facts['safety']
            assert e['run']['pairResult']==facts and e['verdict']['taskAchieved']==facts['taskAchieved'] and facts['assistAdvanceCount']==0
            assert safety['startStep']==0 and safety['samples']==safety['endStep']+1
            pick=e.get('pick',{}); opened=next((act for act in pick.get('actions',[]) if act['actionId'].endswith('-open')),None)
            touched=[obj for m in opened['effect']['motions'] for obj in m.get('payload',{}).get('objects',[]) if obj['objectId']=='target'] if opened else []
            member={'variant':variant,'episode':path,'passed':facts['taskAchieved'],'safe':safety['passed'],
                    'opened':opened is not None,'openContactSteps':sum(obj['contactSteps'] for obj in touched),
                    'beforePickShiftMm':target_shift(pick['before'],e['condition']['targetPosition']) if pick else None,
                    'finalShiftMm':target_shift(e['final'],e['condition']['targetPosition']),
                    'notes':e['failures'],'recordingId':facts['recordingId']}
            for act in e.get('place',{}).get('actions',[]):
                for m in act.get('effect',{}).get('motions',[]):
                    c=m.get('sampledClearance')
                    if c and c.get('payload'):
                        clearance.append({'case':paired['taskId'],**c})
            members[variant]=member; jobs.append(member)
        assert x['baseline']['result']['initialStateSha256']==x['candidate']['result']['initialStateSha256']
        rows.append({'id':x['id'],'historical':x['seed'] in KNOWN,'members':members})
    assert clearance
    fault_members=[]
    for f in faults:
        path=pairroot/'faults'/f['kind']/'fault.json'
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(json.dumps(f,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        m={'episode':path,'recordingId':f['recording']['recordingId'],'kind':f['kind'],'correctStop':f['correctStop'],'safe':f['safety']['passed']}
        fault_members.append(m); jobs.append(m)
    def attach(m):
        m['video'],m['poster'],m['recording']=media.make_video(pairroot,m['episode'],m['recordingId'])
    with ThreadPoolExecutor(max_workers=4) as pool: list(pool.map(attach,jobs))

    def href(path): return escape(str(path.relative_to(root)),quote=True)
    def card(m,name,hero=False):
        attrs='autoplay loop' if hero else 'preload="none"'
        passed='任务通过' if m.get('passed') else '任务未通过'
        if m.get('kind'): passed='正确止损' if m['correctStop'] else '力限反例'
        note=escape('。'.join(m.get('notes',[])[:1]))
        return f'<article><video controls muted playsinline {attrs} poster="{href(m["poster"])}" src="{href(m["video"])}"></video><div><b>{name}</b> · {passed}<p>{note}</p><a href="{href(m["episode"])}">动作判定</a> · <a href="{href(m["recording"])}">原生录制</a> · <a href="{href(m["video"])}">MP4</a></div></article>'
    hero=next(x for x in rows if x['historical'] and x['members']['candidate']['passed'] and not x['members']['baseline']['passed']) if any(x['historical'] and x['members']['candidate']['passed'] and not x['members']['baseline']['passed'] for x in rows) else next(x for x in rows if x['historical'])
    labels={'baseline':'原顺序','candidate':'通过净空预检后开爪'}
    show=''.join(card(hero['members'][v],l,True) for v,l in labels.items())
    all_pairs=''.join(f'<details><summary>{escape(x["id"])} · {"历史故障" if x["historical"] else "新种子"}</summary><div class="grid">'+''.join(card(x['members'][v],l) for v,l in labels.items())+'</div></details>' for x in rows)
    fault_html=''.join(card(m,n) for m,n in zip(fault_members,('腕相机冻结','夹爪卡滞','接触力限反例')))
    root.joinpath('index.html').write_text(f'''<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SO-101 原生集成验收</title><style>
*{{box-sizing:border-box}}body{{margin:0;background:#f3f6f5;color:#15272a;font:16px system-ui,sans-serif}}main{{max-width:1100px;margin:auto;padding:24px 18px 46px}}.note{{background:#e0efeb;border-left:4px solid #08745d;padding:12px 16px}}.grid{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}}article,details{{background:white;border:1px solid #d8e3e0;border-radius:8px}}article{{overflow:hidden}}article>div{{padding:12px}}video{{display:block;background:#142022;aspect-ratio:4/3;width:100%}}a{{color:#0e695a}}details{{padding:10px;margin-top:8px}}summary{{cursor:pointer;font-weight:600}}details .grid{{margin-top:8px}}p{{overflow-wrap:anywhere}}@media(max-width:650px){{.grid{{grid-template-columns:1fr}}}}</style><main>
<h1>SO-101 原生集成验收</h1><div class="note">12 对完整抓放、四个阶段原生分叉、两项故障止损、一项力限反例和 MJCF 审计。夹持和运动数值来自 MuJoCo 仿真。</div>
<h2>同场景开爪对照 · {escape(hero['id'])}</h2><div class="grid">{show}</div><h2>故障止损与安全判分</h2><div class="grid">{fault_html}</div><h2>全部配对</h2>{all_pairs}<p><a href="STAGE_SUMMARY.md">研究过程</a> · <a href="summary.json">结果摘要</a> · <a href="asset-audit.json">MJCF 原始审计</a> · <a href="paired/checkpoint-replay.json">原生分叉回执</a></p></main></html>''',encoding='utf-8')
    grouped={}
    for label,subset in [('historical',[r for r in rows if r['historical']]),('new',[r for r in rows if not r['historical']])]:
        grouped[label]={v:{'passed':sum(r['members'][v]['passed'] for r in subset),'total':len(subset),
                            'openingContacts':sum(r['members'][v]['openContactSteps']>0 for r in subset),
                            'openingPrevented':sum(not r['members'][v]['opened'] for r in subset)} for v in labels}
    concise={'completePairs':comparison['complete'],'statistics':comparison['statistics'],'safety':comparison['safety'],
              'grouped':grouped,'videos':len(jobs),'forks':len(forks),'faultStops':sum(x['correctStop'] for x in faults),
              'carriedClearanceCount':len(clearance),'minimumCarryClearanceM':min(x['payload']['distanceM'] for x in clearance),
              'historicalOpening':[{'id':r['id'],**{m:{f:x[f] for f in ('opened','openContactSteps','beforePickShiftMm','finalShiftMm','notes')} for m,x in r['members'].items()}} for r in rows if r['historical']]}
    (root/'summary.json').write_text(json.dumps(concise,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(concise,ensure_ascii=False))


if __name__=='__main__':
    main()
