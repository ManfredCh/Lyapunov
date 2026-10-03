import {afterAll,describe,expect,test} from 'bun:test'
import {chmodSync,copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readlinkSync,rmSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {checkedRuntimeManifest,releaseManifestTsv,type LinuxReleaseManifest} from './release-manifest.ts'
import {desktopExecutable} from './install-entry.mjs'

const source=dirname(import.meta.path),directories:string[]=[]
afterAll(()=>{for(const dir of directories)rmSync(dir,{recursive:true,force:true})})
const put=(path:string,text:string,executable=false)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);if(executable)chmodSync(path,0o755)}
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const quote=(text:string)=>"'"+text.replaceAll("'","'\\''")+"'"
const node=spawnSync('node',['-p','process.execPath'],{encoding:'utf8'}).stdout.trim()
const versions={mujoco:'3.13.0',mink:'1.3.0',ompl:'2.0.1',daqp:'0.9.1',coacd:'1.0.7',trimesh:'5.1.0',numpy:'2.4.6',scipy:'1.17.0',pyzmq:'27.2.0',msgpack:'1.2.2','msgpack-numpy':'0.4.8'}

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'lya-install-'));directories.push(root)
  const prefix=join(root,'install dir safe'),bin=join(root,"user bin 'safe"),data=join(root,'data home'),home=join(root,'home')
  mkdirSync(home)
  const manifests=new Map<string,LinuxReleaseManifest>(),files=new Map<string,Buffer>(),ranges:string[]=[]
  let selected=''
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
    const path=new URL(request.url).pathname.slice(1),release=path==='releases/latest/linux-x64.tsv'?selected:path.split('/')[1]!
    if(path.endsWith('/linux-x64.tsv')){const row=manifests.get(release);return row?new Response(releaseManifestTsv(row)):new Response('missing',{status:404})}
    const bytes=files.get(path);if(!bytes)return new Response('missing',{status:404})
    const range=request.headers.get('range')
    if(range){ranges.push(range);const start=Number(/^bytes=(\d+)-$/.exec(range)?.[1]);return new Response(bytes.subarray(start),{status:206,headers:{'Content-Range':`bytes ${start}-${bytes.length-1}/${bytes.length}`,'Content-Length':String(bytes.length-start)}})}
    return new Response(bytes,{headers:{'Content-Length':String(bytes.length)}})
  }})
  function candidate(id:string,options:{mode?:'conda-pack'|'install-provider';physicsFails?:boolean;doctorBlocked?:boolean;pipFails?:boolean;sandbox?:'required'|'context'|'nnp'|'nosuid'|'libraries'|'provider'|'helper'|'recheck'}={}){
    const archiveRoot='lyapunov-dsh-0.1.0-linux-x64',product=join(root,id,archiveRoot),mode=options.mode??'conda-pack'
    put(join(product,'runtime/node/bin/node'),`#!/bin/sh\nexec ${quote(node)} "$@"\n`,true)
    put(join(product,'RELEASE.json'),JSON.stringify({releaseId:id,version:'0.1.0',platform:'linux-x64',sourceCommit:'ea350139dba86777d0a350da6181b0072a807e08',sourceCommitMatchesPayload:true,userDataBundled:false}))
    put(join(product,'packages/desktop/icons/lyapunov.png'),'fixture icon')
    mkdirSync(join(product,'distribution/linux'),{recursive:true});copyFileSync(join(source,'install-entry.mjs'),join(product,'distribution/linux/install-entry.mjs'))
    put(join(product,'runtime/electron/chrome-sandbox'),'nonprivileged fixture helper\n',true)
    put(join(product,'distribution/linux/fixture-doctor.mjs'),`import fs from 'node:fs';import p from 'node:path';const [root,mode]=process.argv.slice(2);const helper=p.join(root,'runtime/electron/chrome-sandbox'),s=fs.lstatSync(helper);if(fs.existsSync(p.join(root,'setup.done'))&&mode!=='recheck'){console.log(JSON.stringify({status:'AVAILABLE'}));process.exit(0)}const code=mode==='libraries'?'DESKTOP_LIBRARIES_MISSING':mode==='context'?'SANDBOX_CONTEXT_ONLY':'SANDBOX_SETUP_REQUIRED';console.log(JSON.stringify({status:'BLOCKED',providers:{mujoco:{status:mode==='provider'?'BLOCKED':'AVAILABLE'}},desktop:{status:'BLOCKED',code,missingSystemLibraries:mode==='libraries'?['missing-fixture.so']:[],sandbox:{status:'BLOCKED',code:'SANDBOX_SETUP_REQUIRED',noNewPrivileges:mode==='nnp',nosuid:mode==='nosuid',helper:{path:helper,exists:true,uid:mode==='helper'?s.uid+1:s.uid,mode:s.mode&0o7777}}}}));process.exit(2);\n`)
    const blocked=`{"status":"BLOCKED","desktop":{"status":"BLOCKED","code":"SANDBOX_CONTEXT_ONLY"},"providers":{"mujoco":{"status":"AVAILABLE"}}}`
    put(join(product,'lyapunov'),`#!/bin/sh\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nprintf '%s\\n' "python_path=\${PYTHONPATH-}" "python_home=\${PYTHONHOME-}" "node_path=\${NODE_PATH-}" "no_user_site=\${PYTHONNOUSERSITE-}" > "$root/environment.vars"\ncase "$1" in\ninstall-provider) printf '%s\\n' 'fixture provider progress';${options.pipFails?"printf '%s\\n' 'pip download failed';exit 19":`printf '%s\\n' '${blocked}';exit 2`};;\ndoctor) printf '%s\\n' "$*" >> "$root/doctor.args";${options.sandbox?`exec "$root/runtime/node/bin/node" "$root/distribution/linux/fixture-doctor.mjs" "$root" ${quote(options.sandbox)}`:options.doctorBlocked?`printf '%s\\n' '${blocked}';exit 2`:"printf '%s\\n' '{\"status\":\"AVAILABLE\"}';exit 0"};;\nsetup-sandbox) printf '%s\\n' "$*" >> "$root/setup.args"; : > "$root/setup.done";printf '%s\\n' 'fixture setup complete';exit 0;;\nphysics-check) [ "$2" = --managed-sdk ] || exit 99; printf '%s\\n' "$*" > "$root/physics.args";${options.physicsFails?'exit 17':"printf '%s\\n' '{\"status\":\"PASS\"}';exit 0"};;\ndesktop) printf '%s\\n' "$*" > "$root/gui.args";exit 0;;\n*) printf '%s\\n' "$*";;\nesac\n`,true)
    const archive=join(root,id+'.tar.gz'),tar=spawnSync('tar',['-czf',archive,'-C',dirname(product),archiveRoot]);if(tar.status!==0)throw Error('fixture tar failed')
    const bytes=readFileSync(archive),archiveFile=`lyapunov-linux-x64-${id}.tar.gz`
    files.set(`releases/${id}/${archiveFile}`,bytes)
    const row:LinuxReleaseManifest={schema:1,releaseId:id,version:'0.1.0',platform:'linux-x64',minimumGlibc:'2.28',sourceCommit:'ea350139dba86777d0a350da6181b0072a807e08',archiveRoot,archive:{path:archiveFile,sha256:sha(bytes),bytes:bytes.length},mujoco:{mode:'install-provider'}}
    if(mode==='conda-pack'){
      const runtime=join(root,id,'runtime');put(join(runtime,'bin/python'),'#!/bin/sh\nexit 0\n',true);put(join(runtime,'bin/conda-unpack'),'fixture relocation callback\n')
      const runtimeFile=`lyapunov-mujoco-linux-x64-${id}.tar.gz`,runtimeTar=join(root,runtimeFile)
      if(spawnSync('tar',['-czf',runtimeTar,'-C',runtime,'.']).status!==0)throw Error('runtime fixture tar failed')
      const runtimeBytes=readFileSync(runtimeTar);files.set(`releases/${id}/${runtimeFile}`,runtimeBytes)
      row.mujoco={mode:'conda-pack',runtime:{schema:1,format:'conda-pack',platform:'linux-x64',minimumGlibc:'2.28',archive:{path:runtimeFile,sha256:sha(runtimeBytes),bytes:runtimeBytes.length},pythonVersion:'3.12.14',packages:versions,licenses:[{path:'LICENSE',sha256:'0'.repeat(64)}]}}
    }
    manifests.set(id,row);selected=id;return row
  }
  async function run(flags:string[]=[],overrides:Record<string,string>={}){
    const child=Bun.spawn(['/bin/sh',join(source,'install.sh'),'--prefix',prefix,'--bin-dir',bin,...flags],{cwd:root,env:{...process.env,HOME:home,XDG_DATA_HOME:data,LYAPUNOV_INSTALL_BASE_URL:`http://127.0.0.1:${server.port}`,LYAPUNOV_MUJOCO_PYTHON:'/outside/python',...overrides},stdout:'pipe',stderr:'pipe'})
    const [status,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {status,out,err}
  }
  const sudoBin=join(root,'sudo fixture'),sudoLog=join(root,'sudo.args'),sudoTty=join(root,'sudo.stdin-tty')
  function fakeSudo(deny=false){
    // This is a nonprivileged test command. It imitates terminal prompt/retry
    // with public QA words; no password or real sudo is involved.
    put(join(sudoBin,'sudo'),`#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(sudoLog)}\nif [ -t 0 ];then printf '%s' true > ${quote(sudoTty)};else exit 97;fi\n[ "$1" = -p ] || exit 95;shift 2\nprintf '%s' '[sudo] QA authorization: ' > /dev/tty\nIFS= read -r answer < /dev/tty\nif [ "$answer" = qa-retry ];then printf '%s\\n' 'Sorry, try again.' > /dev/tty;printf '%s' '[sudo] QA authorization: ' > /dev/tty;IFS= read -r answer < /dev/tty;fi\n${deny?"printf '%s\\n' 'sudo: QA authorization denied' >&2;exit 41":"[ \"$answer\" = qa-approve ] || exit 42;[ \"$1\" = -- ] || exit 96;shift;exec \"$@\""}\n`,true)
  }
  async function runPty(input='qa-approve\n'){
    const cmd=`cat ${quote(join(source,'install.sh'))} | /bin/sh -s -- --prefix ${quote(prefix)} --bin-dir ${quote(bin)}`
    const child=Bun.spawn(['script','--quiet','--return','--command',cmd,'/dev/null'],{cwd:root,env:{...process.env,HOME:home,XDG_DATA_HOME:data,LYAPUNOV_INSTALL_BASE_URL:`http://127.0.0.1:${server.port}`,PATH:sudoBin+':'+process.env.PATH},stdin:'pipe',stdout:'pipe',stderr:'pipe'})
    child.stdin.write(input);child.stdin.end()
    const [status,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {status,out,err}
  }
  async function runNoTty(){
    // A new session with no controlling terminal, even when CI was launched
    // from a terminal. The actual installer still reads a curl-style pipe.
    const code='import subprocess,sys;raise SystemExit(subprocess.run(["/bin/sh","-s","--",*sys.argv[2:]],input=open(sys.argv[1],"rb").read(),start_new_session=True).returncode)'
    const child=Bun.spawn(['/usr/bin/python3','-c',code,join(source,'install.sh'),'--prefix',prefix,'--bin-dir',bin],{cwd:root,env:{...process.env,HOME:home,XDG_DATA_HOME:data,LYAPUNOV_INSTALL_BASE_URL:`http://127.0.0.1:${server.port}`,PATH:sudoBin+':'+process.env.PATH},stdout:'pipe',stderr:'pipe'})
    const [status,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {status,out,err}
  }
  return {root,prefix,bin,data,home,candidate,run,runPty,runNoTty,fakeSudo,sudoLog,sudoTty,files,ranges,manifests,stop:()=>server.stop(true)}
}
describe('公开 POSIX 用户安装入口',()=>{
  test('默认Mu配套 archive、managed doctor/native physics、单入口和空格路径完整通过，重跑不移动runtime',async()=>{
    const f=fixture();try{f.candidate('a08-one');let result=await f.run();expect(result.status,result.err).toBe(0)
      expect(readlinkSync(join(f.prefix,'current'))).toBe('versions/a08-one')
      const product=join(f.prefix,'versions/a08-one');expect(readFileSync(join(product,'physics.args'),'utf8')).toContain('--managed-sdk')
      expect(readFileSync(join(product,'doctor.args'),'utf8')).toContain('doctor mujoco --managed-sdk')
      expect(existsSync(join(product,'.install/mujoco.sha256'))).toBe(true)
      expect(readFileSync(join(f.data,'applications/lyapunov-desktop.desktop'),'utf8')).toContain('StartupWMClass=lyapunov-desktop')
      const launch=spawnSync(join(f.bin,'lyapunov'),['argument with spaces'],{encoding:'utf8'});expect(launch.status).toBe(0);expect(launch.stdout.trim()).toBe('argument with spaces')
      result=await f.run();expect(result.status,result.err).toBe(0);expect(result.out).toContain('Resuming verified version')
    }finally{f.stop()}
  })
  test('升级保留原版本、previous及用户data；失败物理不切current',async()=>{
    const f=fixture();try{f.candidate('a08-one');expect((await f.run()).status).toBe(0)
      const sentinel=join(f.home,'user-data/session');put(sentinel,'用户数据保持')
      f.candidate('a08-two');expect((await f.run()).status).toBe(0);expect(readlinkSync(join(f.prefix,'previous'))).toBe('versions/a08-one')
      f.candidate('a08-three',{physicsFails:true});const result=await f.run();expect(result.status).toBe(2);expect(result.err).toContain('Native MuJoCo physics check failed')
      expect(readlinkSync(join(f.prefix,'current'))).toBe('versions/a08-two');expect(readFileSync(sentinel,'utf8')).toBe('用户数据保持')
      expect(existsSync(join(f.prefix,'versions/a08-one/RELEASE.json'))).toBe(true)
    }finally{f.stop()}
  })
  test('错hash与截断字节分别拒绝，均不建立current或半版本',async()=>{
    for(const kind of ['hash','truncate']){const f=fixture();try{const row=f.candidate('a08-bad');if(kind==='hash')row.archive.sha256='a'.repeat(64);else f.files.set(`releases/${row.releaseId}/${row.archive.path}`,f.files.get(`releases/${row.releaseId}/${row.archive.path}`)!.subarray(0,32))
      const result=await f.run();expect(result.status).toBe(2);expect(result.err).toContain(kind==='hash'?'SHA256 mismatch':'byte count mismatch')
      expect(existsSync(join(f.prefix,'current'))).toBe(false);expect(existsSync(join(f.prefix,'versions/a08-bad'))).toBe(false)
    }finally{f.stop()}}
  })
  test('下载已有partial使用真实HTTP Range续传，再按完整bytes/hash验收',async()=>{
    const f=fixture();try{const row=f.candidate('a08-resume');const bytes=f.files.get(`releases/${row.releaseId}/${row.archive.path}`)!;const partial=join(f.prefix,'downloads',row.archive.sha256+'.tar.gz.partial');mkdirSync(dirname(partial),{recursive:true});writeFileSync(partial,bytes.subarray(0,64))
      const result=await f.run();expect(result.status,result.err).toBe(0);expect(f.ranges).toContain('bytes=64-');expect(existsSync(partial)).toBe(false)
    }finally{f.stop()}
  })
  test('SDK已准备但desktop CONTEXT_ONLY只保留pending版本，不称ready或切current',async()=>{
    const f=fixture();try{f.candidate('a08-pending',{doctorBlocked:true});const result=await f.run();expect(result.status).toBe(2);expect(result.out).toContain('SANDBOX_CONTEXT_ONLY');expect(result.out).not.toContain('READY:')
      expect(existsSync(join(f.prefix,'versions/a08-pending/.install/mujoco.sha256'))).toBe(true);expect(existsSync(join(f.prefix,'current'))).toBe(false)
    }finally{f.stop()}
  })
  test('无companion时调用既有provider并显示进度，实际pip失败保持原错误及partial版本',async()=>{
    for(const fails of [false,true]){const f=fixture();try{f.candidate('a08-pip',{mode:'install-provider',pipFails:fails});const result=await f.run();expect(result.status,result.err).toBe(fails?2:0)
      expect(result.out).toContain('fixture provider progress');if(fails){expect(result.err).toContain('exit 19');expect(result.out).toContain('pip download failed');expect(existsSync(join(f.prefix,'current'))).toBe(false)}
    }finally{f.stop()}}
  })
  test('仅显式without-mujoco省runtime，仍通过desktop检查且如实标记',async()=>{
    const f=fixture();try{f.candidate('a08-slim');const result=await f.run(['--without-mujoco']);expect(result.status,result.err).toBe(0);expect(result.out).toContain('INSTALLED_WITHOUT_MUJOCO')
      const product=join(f.prefix,'versions/a08-slim');expect(readFileSync(join(product,'doctor.args'),'utf8')).toContain('doctor desktop');expect(existsSync(join(product,'.runtime/sim-python'))).toBe(false);expect(existsSync(join(product,'physics.args'))).toBe(false)
    }finally{f.stop()}
  })
  test('外来用户入口不可覆盖，current不切换',async()=>{
    const f=fixture();try{f.candidate('a08-conflict');put(join(f.bin,'lyapunov'),'original user launcher',true);const result=await f.run();expect(result.status).toBe(2);expect(readFileSync(join(f.bin,'lyapunov'),'utf8')).toBe('original user launcher');expect(existsSync(join(f.prefix,'current'))).toBe(false)
    }finally{f.stop()}
  })
  test('真实Conda单引号prefix边界在下载前明确拒绝，不生成目录或冒充ready',async()=>{
    const f=fixture();try{f.candidate('a08-quote');const unsupported=join(f.root,"unsupported 'prefix");const result=await f.run(['--prefix',unsupported])
      expect(result.status).toBe(2);expect(result.err).toContain('CONDA_PREFIX_UNSUPPORTED');expect(result.out).not.toContain('Fetching');expect(existsSync(unsupported)).toBe(false)
    }finally{f.stop()}
  })
  test('PATH宿主dsh/python与Python/Node环境注入不能进入产品准备进程',async()=>{
    const f=fixture();try{f.candidate('a08-isolated');const dummy=join(f.root,'host bin'),marker=join(f.root,'host-command-used')
      for(const command of ['dsh','python','python3'])put(join(dummy,command),`#!/bin/sh\nprintf '%s' host > ${quote(marker)}\nexit 98\n`,true)
      const injection=join(f.root,'host injection');put(join(injection,'sitecustomize.py'),`raise RuntimeError('host Python leaked')\n`);put(join(injection,'preload.cjs'),`throw Error('host Node leaked');\n`)
      const result=await f.run([],{PATH:dummy+':'+process.env.PATH,PYTHONPATH:injection,PYTHONHOME:injection,NODE_PATH:injection,NODE_OPTIONS:'--require '+quote(join(injection,'preload.cjs')),PYTHONNOUSERSITE:'0'})
      expect(result.status,result.err).toBe(0);expect(existsSync(marker)).toBe(false)
      expect(readFileSync(join(f.prefix,'versions/a08-isolated/environment.vars'),'utf8')).toBe('python_path=\npython_home=\nnode_path=\nno_user_site=1\n')
      // The actual packaged entry also clears host import state after install.
      const product=join(f.prefix,'versions/a08-isolated');copyFileSync(join(source,'lyapunov'),join(product,'lyapunov'));put(join(product,'distribution/linux/sandbox.mjs'),'fixture module')
      put(join(product,'distribution/linux/doctor.mjs'),'console.log(JSON.stringify({pythonPath:process.env.PYTHONPATH??null,nodePath:process.env.NODE_PATH??null,noUserSite:process.env.PYTHONNOUSERSITE}));\n')
      const actual=spawnSync(join(product,'lyapunov'),['doctor','mujoco','--managed-sdk'],{encoding:'utf8',env:{...process.env,PATH:dummy+':'+process.env.PATH,PYTHONPATH:injection,NODE_OPTIONS:'--require '+quote(join(injection,'preload.cjs')),NODE_PATH:injection}})
      expect(actual.status,actual.stderr).toBe(0);expect(JSON.parse(actual.stdout)).toEqual({pythonPath:null,nodePath:null,noUserSite:'1'});expect(existsSync(marker)).toBe(false)
    }finally{f.stop()}
  })
  test('真实PTY下curl管道只由系统sudo替身从控制终端prompt/retry一次调用，doctor重验后才physics与激活',async()=>{
    const f=fixture();try{f.candidate('a08-auth',{sandbox:'required'});f.fakeSudo();const result=await f.runPty('qa-retry\nqa-approve\n')
      expect(result.status,result.out+result.err).toBe(0);expect(result.out).toContain('Sorry, try again.');expect(result.out).toContain('Installation will resume automatically')
      expect(readFileSync(f.sudoTty,'utf8')).toBe('true');const product=join(f.prefix,'versions/a08-auth')
      expect(readFileSync(f.sudoLog,'utf8').trim().split('\n')).toEqual(['-p','Lyapunov one-time sandbox authorization, password for %u: ','--',join(product,'lyapunov'),'setup-sandbox'])
      expect(readFileSync(join(product,'doctor.args'),'utf8').trim().split('\n')).toHaveLength(2)
      expect(readFileSync(join(product,'setup.args'),'utf8').trim().split('\n')).toEqual(['setup-sandbox'])
      expect(readFileSync(join(product,'physics.args'),'utf8')).toContain('--managed-sdk');expect(readlinkSync(join(f.prefix,'current'))).toBe('versions/a08-auth')
      expect(existsSync(join(product,'gui.args'))).toBe(false)
    }finally{f.stop()}
  })
  test('PTY拒绝授权保留旧current和partial版本，不启动physics或GUI',async()=>{
    const f=fixture();try{f.candidate('a08-before');expect((await f.run()).status).toBe(0);f.candidate('a08-denied',{sandbox:'required'});f.fakeSudo(true)
      const result=await f.runPty();expect(result.status).toBe(2);expect(result.out).toContain('SANDBOX_AUTHORIZATION_FAILED');expect(readlinkSync(join(f.prefix,'current'))).toBe('versions/a08-before')
      expect(existsSync(join(f.prefix,'versions/a08-denied/.install/mujoco.sha256'))).toBe(true);expect(existsSync(join(f.prefix,'versions/a08-denied/physics.args'))).toBe(false)
    }finally{f.stop()}
  })
  test('实际无控制终端的curl管道不请求sudo，给可重试终端说明',async()=>{
    const f=fixture();try{f.candidate('a08-no-tty',{sandbox:'required'});f.fakeSudo();const result=await f.runNoTty()
      expect(result.status).toBe(2);expect(result.err).toContain('SANDBOX_TERMINAL_REQUIRED');expect(existsSync(f.sudoLog)).toBe(false);expect(existsSync(join(f.prefix,'current'))).toBe(false)
    }finally{f.stop()}
  })
  test('PTY中的NNP/nosuid/库缺失/SDK缺失/错误helper均不请求sudo',async()=>{
    for(const mode of ['context','nnp','nosuid','libraries','provider','helper'] as const){const f=fixture();try{f.candidate('a08-ineligible',{sandbox:mode});f.fakeSudo();const result=await f.runPty('')
      expect(result.status,result.out).toBe(2);expect(existsSync(f.sudoLog)).toBe(false);expect(existsSync(join(f.prefix,'current'))).toBe(false)
    }finally{f.stop()}}
  })
  test('sudo替身成功仍须正常doctor与physics通过，任一失败不激活',async()=>{
    for(const [mode,physicsFails] of [['recheck',false],['required',true]] as const){const f=fixture();try{f.candidate('a08-after-auth',{sandbox:mode,physicsFails});f.fakeSudo();const result=await f.runPty()
      expect(result.status).toBe(2);expect(result.out).toContain(physicsFails?'Native MuJoCo physics check failed':'SANDBOX_RECHECK_FAILED');expect(existsSync(join(f.prefix,'current'))).toBe(false)
      expect(readFileSync(join(f.prefix,'versions/a08-after-auth/doctor.args'),'utf8').trim().split('\n')).toHaveLength(2)
    }finally{f.stop()}}
  })
})
describe('发布manifest身份与Desktop规则',()=>{
  test('配套runtime缺闭包、pin漂移与压缩总大小超预算明确拒绝',()=>{
    const f=fixture();try{const row=f.candidate('a08-manifest');if(row.mujoco.mode!=='conda-pack')throw Error('fixture mode')
      expect(checkedRuntimeManifest(row.mujoco.runtime).packages.mujoco).toBe('3.13.0')
      expect(()=>checkedRuntimeManifest({...row.mujoco.runtime,packages:{...versions,coacd:'0.0.0'}})).toThrow('coacd==1.0.7')
      row.archive.bytes=2*1024**3;expect(()=>releaseManifestTsv(row)).toThrow('超过2GiB')
    }finally{f.stop()}
  })
  test('桌面Exec保留空格与字面美元、反斜线、百分号',()=>{
    expect(desktopExecutable('/with space/$cash\\icon%/lyapunov')).toBe('"/with space/\\\\$cash\\\\\\\\icon%%/lyapunov"')
  })
})
