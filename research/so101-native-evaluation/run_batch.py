"""冻结同一批原生抓放矩阵与 MJCF 审计，收齐独立子任务退出码。"""

import argparse
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ('out','model','python'):
        parser.add_argument('--'+field,type=Path,required=True)
    args=parser.parse_args()
    out, model, python=(getattr(args,key).absolute() for key in ('out','model','python'))
    out.mkdir(parents=True,exist_ok=False)
    repo=Path(__file__).resolve().parents[2]
    runs={
        'mjcf':[str(python),'research/so101-native-evaluation/assets.py','--model',str(model),'--out',str(out/'asset-audit.json')],
        'native':['node','--experimental-transform-types','script/gates/run-so101-paired.ts','--model',str(model),'--python',str(python),
                  '--out',str(out/'paired'),'--comparison','integrated','--seeds','9011,9049,9181','--known-stress-seeds','6151,7129,7919'],
    }
    children={}
    for key,command in runs.items():
        with (out/(key+'.log')).open('wb') as log:
            children[key]=subprocess.Popen(command,cwd=repo,stdout=log,stderr=subprocess.STDOUT)
    results={name:{'command':runs[name],'exitCode':child.wait(),'log':name+'.log'} for name,child in children.items()}
    (out/'batch.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(results,ensure_ascii=False),flush=True)
    raise SystemExit(0 if all(x['exitCode']==0 for x in results.values()) else 1)


if __name__=='__main__':
    main()
