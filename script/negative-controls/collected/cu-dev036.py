import hashlib,os,shutil,subprocess,sys
target='/home/s18/WS/Lyapunov/Dev/packages/desktop/src/restart-recovery.ts'
old='  return {action:"none",reason:workspaces.length===0?"没有任何可读工作区记录":"存在多个工作区且没有唯一目标：进入工作区选择，不猜测",downgrades,replaysRobotActions:false}'
new='  return {action:"open-session",workspaceId:workspaces[0]?.id,sessionId:active(workspaces[0]).at(-1),reason:"变异：没有唯一目标也猜一个",downgrades,replaysRobotActions:false}'
backup='/home/s18/WS/Lyapunov/Dev/.runtime/cu/lane-dev036/restart-recovery.ts.bak'
shutil.copy2(target,backup)
src=open(target,encoding='utf-8').read();before=hashlib.sha256(src.encode()).hexdigest()
assert src.count(old)==1
open(target,'w',encoding='utf-8').write(src.replace(old,new,1));mutated=open(target,encoding='utf-8').read()
env=dict(os.environ,PATH=os.path.expanduser('~/.bun/bin')+':'+os.environ['PATH'])
try:
    r=subprocess.run(['bun','test','packages/desktop/test/restart-recovery.test.ts'],cwd='/home/s18/WS/Lyapunov/Dev',capture_output=True,text=True,env=env,timeout=300)
    print(r.stdout[-1200:]);print('exit=%d'%r.returncode)
finally:
    if open(target,encoding='utf-8').read()!=mutated: raise SystemExit('第三方改写，拒绝还原')
    shutil.copy2(backup,target)
after=hashlib.sha256(open(target,encoding='utf-8').read().encode()).hexdigest()
print('还原一致=%s'%(after==before))
