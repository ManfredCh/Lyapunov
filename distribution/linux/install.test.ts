import {afterAll,describe,expect,test} from 'bun:test'
import {chmodSync,copyFileSync,existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,readlinkSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {runInNewContext} from 'node:vm'
import {checkedRuntimeManifest,releaseManifestTsv,type LinuxReleaseManifest} from './release-manifest.ts'
import {desktopExecutable} from './install-entry.mjs'

const source=dirname(import.meta.path),directories:string[]=[]
afterAll(()=>{for(const dir of directories)rmSync(dir,{recursive:true,force:true})})
const put=(path:string,text:string,executable=false)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);if(executable)chmodSync(path,0o755)}
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const quote=(text:string)=>"'"+text.replaceAll("'","'\\''")+"'"
const node=spawnSync('node',['-p','process.execPath'],{encoding:'utf8'}).stdout.trim()
const curl=Bun.which('curl')!
const versions={mujoco:'3.13.0',mink:'1.3.0',ompl:'2.0.1',daqp:'0.9.1',coacd:'1.0.7',trimesh:'5.1.0',numpy:'2.4.6',scipy:'1.17.0',pyzmq:'27.2.0',msgpack:'1.2.2','msgpack-numpy':'0.4.8'}

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'lya-install-'));directories.push(root)
  const prefix=join(root,'install dir safe'),bin=join(root,"user bin 'safe"),data=join(root,'data home'),home=join(root,'home')
  mkdirSync(home)
  const manifests=new Map<string,LinuxReleaseManifest>(),files=new Map<string,Buffer>(),ranges:string[]=[],requests:string[]=[]
  let selected=''
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
    const path=new URL(request.url).pathname.slice(1),release=path==='releases/latest/linux-x64.tsv'?selected:path.split('/')[1]!
    requests.push(path)
    if(path.endsWith('/linux-x64.tsv')){const row=manifests.get(release);return row?new Response(releaseManifestTsv(row)):new Response('missing',{status:404})}
    const bytes=files.get(path);if(!bytes)return new Response('missing',{status:404})
    const range=request.headers.get('range')
    if(range){ranges.push(range);const match=/^bytes=(\d+)-(\d*)$/.exec(range);const start=Number(match?.[1]);const end=match?.[2]?Number(match[2]):bytes.length-1;return new Response(bytes.subarray(start,end+1),{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':String(end-start+1)}})}
    return new Response(bytes,{headers:{'Content-Length':String(bytes.length)}})
  }})
  function candidate(id:string,options:{mode?:'conda-pack'|'install-provider';physicsFails?:boolean;doctorBlocked?:boolean;pipFails?:boolean;entryFails?:boolean;desktopLibraries?:'required'|'unknown'|'changed'|'remain'|'sandbox'|'bad-exit';sandbox?:'required'|'context'|'nnp'|'nosuid'|'libraries'|'provider'|'helper'|'recheck'}={}){
    const archiveRoot='lyapunov-dsh-0.1.0-linux-x64',product=join(root,id,archiveRoot),mode=options.mode??'conda-pack'
    put(join(product,'runtime/node/bin/node'),`#!/bin/sh\nexec ${quote(node)} "$@"\n`,true)
    put(join(product,'RELEASE.json'),JSON.stringify({releaseId:id,version:'0.1.0',platform:'linux-x64',sourceCommit:'ea350139dba86777d0a350da6181b0072a807e08',sourceCommitMatchesPayload:true,userDataBundled:false}))
    put(join(product,'packages/desktop/icons/lyapunov.png'),'fixture icon')
    mkdirSync(join(product,'distribution/linux'),{recursive:true});copyFileSync(join(source,'install-entry.mjs'),join(product,'distribution/linux/install-entry.mjs'))
    if(options.entryFails)put(join(product,'distribution/linux/install-entry.mjs'),'export function installEntries(){throw Error("fixture entry write failed")}\n')
    put(join(product,'runtime/electron/chrome-sandbox'),'nonprivileged fixture helper\n',true)
    put(join(product,'runtime/electron/lyapunov-desktop'),'nonprivileged desktop binary fixture\n',true)
    put(join(product,'distribution/linux/fixture-doctor.mjs'),`import fs from 'node:fs';import p from 'node:path';const [root,mode]=process.argv.slice(2);const helper=p.join(root,'runtime/electron/chrome-sandbox'),s=fs.lstatSync(helper);if(fs.existsSync(p.join(root,'setup.done'))&&mode!=='recheck'){console.log(JSON.stringify({status:'AVAILABLE'}));process.exit(0)}const code=mode==='libraries'?'DESKTOP_LIBRARIES_MISSING':mode==='context'?'SANDBOX_CONTEXT_ONLY':'SANDBOX_SETUP_REQUIRED';console.log(JSON.stringify({status:'BLOCKED',providers:{mujoco:{status:mode==='provider'?'BLOCKED':'AVAILABLE'}},desktop:{status:'BLOCKED',code,missingSystemLibraries:mode==='libraries'?['missing-fixture.so']:[],sandbox:{status:'BLOCKED',code:'SANDBOX_SETUP_REQUIRED',noNewPrivileges:mode==='nnp',nosuid:mode==='nosuid',helper:{path:helper,exists:true,uid:mode==='helper'?s.uid+1:s.uid,mode:s.mode&0o7777}}}}));process.exit(2);\n`)
    put(join(product,'distribution/linux/fixture-library-doctor.mjs'),`import fs from 'node:fs';const [root,mode]=process.argv.slice(2);if(fs.existsSync(${JSON.stringify(join(root,'dependency-installed'))})&&mode!=='remain'){if(mode==='sandbox'&&!fs.existsSync(root+'/setup.done')){process.argv=[process.argv[0],process.argv[1],root,'required'];await import('./fixture-doctor.mjs')}else{console.log(JSON.stringify({status:'AVAILABLE'}));process.exit(mode==='bad-exit'?7:0)}}else{console.log(JSON.stringify({status:'BLOCKED',providers:{mujoco:{status:'AVAILABLE'}},desktop:{status:'BLOCKED',code:'DESKTOP_LIBRARIES_MISSING',missingSystemLibraries:mode==='unknown'?['libunknown-fixture.so.1 => not found']:['libgtk-3.so.0 => not found','libasound.so.2 => not found','libnss3.so => not found']}}));process.exit(2)}\n`)
    const blocked=`{"status":"BLOCKED","desktop":{"status":"BLOCKED","code":"SANDBOX_CONTEXT_ONLY"},"providers":{"mujoco":{"status":"AVAILABLE"}}}`
    put(join(product,'lyapunov'),`#!/bin/sh\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nprintf '%s\\n' "python_path=\${PYTHONPATH-}" "python_home=\${PYTHONHOME-}" "node_path=\${NODE_PATH-}" "no_user_site=\${PYTHONNOUSERSITE-}" > "$root/environment.vars"\ncase "$1" in\ninstall-provider) printf '%s\\n' 'fixture provider progress';${options.pipFails?"printf '%s\\n' 'pip download failed';exit 19":`printf '%s\\n' '${blocked}';exit 2`};;\ndoctor) printf '%s\\n' "$*" >> "$root/doctor.args";${options.desktopLibraries?`exec "$root/runtime/node/bin/node" "$root/distribution/linux/fixture-library-doctor.mjs" "$root" ${quote(options.desktopLibraries)}`:options.sandbox?`exec "$root/runtime/node/bin/node" "$root/distribution/linux/fixture-doctor.mjs" "$root" ${quote(options.sandbox)}`:options.doctorBlocked?`printf '%s\\n' '${blocked}';exit 2`:"printf '%s\\n' '{\"status\":\"AVAILABLE\"}';exit 0"};;\nsetup-sandbox) printf '%s\\n' "$*" >> "$root/setup.args"; : > "$root/setup.done";printf '%s\\n' 'fixture setup complete';exit 0;;\nphysics-check) [ "$2" = --managed-sdk ] || exit 99; printf '%s\\n' "$*" > "$root/physics.args";${options.physicsFails?'exit 17':"printf '%s\\n' '{\"status\":\"PASS\"}';exit 0"};;\ndesktop) printf '%s\\n' "$*" > "$root/gui.args";exit 0;;\n*) printf '%s\\n' "$*";;\nesac\n`,true)
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
  const storageBin=join(root,'storage fixture'),storageState=join(root,'df.state'),dfLog=join(root,'df.args'),curlLog=join(root,'curl.args')
  function fakeSpace(availableKiB:number|'unreadable'|'malformed'=1_048_576){
    put(storageState,String(availableKiB))
    // 所有安装夹具都走此 PATH 替身，不读取主机真实磁盘容量。
    put(join(storageBin,'df'),`#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(dfLog)}\nvalue=$(cat ${quote(storageState)})\ncase "$value" in unreadable) exit 1;; malformed) printf '%s\\n' 'unreadable filesystem report';exit 0;; esac\nprintf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' "fixture-device 2097152 1048576 $value 50% /fixture mount"\n`,true)
  }
  function withoutDfPath(){
    rmSync(join(storageBin,'df'))
    for(const command of ['curl','sha256sum','tar','mktemp','getconf','tee','uname','mkdir','cat','rm','rmdir','wc','tr','mv','cp','dirname','readlink','ln','gzip','sed','chmod','git']){
      const executable=Bun.which(command);if(!executable)throw Error(`fixture command missing: ${command}`)
      symlinkSync(executable,join(storageBin,command))
    }
    return storageBin
  }
  function fakeCurlFailure(code:number,availableAfter:number|'unreadable'=1_048_576,resource:'archive'|'manifest'='archive'){
    put(join(storageBin,'curl'),`#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(curlLog)}\nfor value in "$@";do case "$value" in http://127.0.0.1:*/releases/${resource==='manifest'?'*.tsv':'*.tar.gz'}) printf '%s' ${quote(String(availableAfter))} > ${quote(storageState)};printf '%s\\n' 'curl: (${code}) fixture transfer failure' >&2;exit ${code};; esac;done\nexec ${quote(curl)} "$@"\n`,true)
  }
  fakeSpace()
  async function run(flags:string[]=[],overrides:Record<string,string>={},trace=false){
    const child=Bun.spawn(['/bin/sh',...(trace?['-x']:[]),join(source,'install.sh'),'--prefix',prefix,'--bin-dir',bin,...flags],{cwd:root,env:{...process.env,HOME:home,XDG_DATA_HOME:data,LYAPUNOV_INSTALL_BASE_URL:`http://127.0.0.1:${server.port}`,LYAPUNOV_MUJOCO_PYTHON:'/outside/python',...overrides,PATH:storageBin+':'+(overrides.PATH??process.env.PATH)},stdout:'pipe',stderr:'pipe'})
    const [status,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {status,out,err}
  }
  const sudoBin=join(root,'sudo fixture'),sudoLog=join(root,'sudo.args'),sudoTty=join(root,'sudo.stdin-tty')
  function fakeSudo(deny=false){
    // This is a nonprivileged test command. It imitates terminal prompt/retry
    // with public QA words; no password or real sudo is involved.
    put(join(sudoBin,'sudo'),`#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(sudoLog)}\nif [ -t 0 ];then printf '%s' true > ${quote(sudoTty)};else exit 97;fi\n[ "$1" = -p ] || exit 95;shift 2\nprintf '%s' '[sudo] QA authorization: ' > /dev/tty\nIFS= read -r answer < /dev/tty\nif [ "$answer" = qa-retry ];then printf '%s\\n' 'Sorry, try again.' > /dev/tty;printf '%s' '[sudo] QA authorization: ' > /dev/tty;IFS= read -r answer < /dev/tty;fi\n${deny?"printf '%s\\n' 'sudo: QA authorization denied' >&2;exit 41":"[ \"$answer\" = qa-approve ] || exit 42;[ \"$1\" = -- ] || exit 96;shift;exec \"$@\""}\n`,true)
  }
  function fakeDependencies(options:{legacy?:boolean;deny?:boolean;updateFails?:boolean;installFails?:boolean;changed?:boolean;unknown?:boolean;packageMissing?:boolean;runtimeGit?:boolean;gitRemainsMissing?:boolean}={}){
    const state=join(root,'dependency-installed'),auth=join(root,'dependency-auth'),aptLog=join(root,'apt.args')
    const gitInstall=options.runtimeGit&&!options.gitRemainsMissing?`printf %s ${quote("#!/bin/sh\nprintf '%s\\n' 'git version 2.53.0-fixture'\n")} > ${quote(join(sudoBin,'git'))}; chmod 755 ${quote(join(sudoBin,'git'))};`:''
    put(join(sudoBin,'ldd'),`#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(join(root,'ldd.args'))}\n${options.changed?"printf '%s\\n' 'libasound.so.2 => not found'":options.unknown?"printf '%s\\n' 'libunknown-fixture.so.1 => not found'":"printf '%s\\n' 'libgtk-3.so.0 => not found' 'libasound.so.2 => not found' 'libnss3.so => not found'"}\n`,true)
    put(join(sudoBin,'apt-cache'),`#!/bin/sh\n[ "$1" = policy ] || exit 96\ncase "$2" in ${options.runtimeGit?'git|':''}${options.legacy?'libgtk-3-0|libasound2|libnss3':'libgtk-3-0t64|libasound2t64|libnss3'}) printf '%s\\n' '  Candidate: ${options.packageMissing?'(none)':'1.0-qa'}';; *) printf '%s\\n' '  Candidate: (none)';; esac\n`,true)
    put(join(sudoBin,'apt-get'),`#!/bin/sh\nprintf '%s\\n' CALL "$@" >> ${quote(aptLog)}\ncase " $* " in *' update '*) ${options.updateFails?'exit 51':'exit 0'};; *' install '*) ${options.installFails?'exit 52':`${gitInstall} : > ${quote(state)};exit 0`};; *) exit 53;; esac\n`,true)
    put(join(sudoBin,'sudo'),`#!/bin/sh\nprintf '%s\\n' CALL "$@" >> ${quote(sudoLog)}\n[ -t 0 ] || exit 97\n[ "$1" = -p ] || exit 95;shift 2\nif [ ! -f ${quote(auth)} ];then printf '%s' '[sudo] QA dependency authorization: ' > /dev/tty;IFS= read -r answer < /dev/tty;${options.deny?'exit 41':'[ "$answer" = qa-approve ] || exit 42'}; : > ${quote(auth)};fi\n[ "$1" = -- ] || exit 96;shift;exec "$@"\n`,true)
    return {aptLog}
  }
  async function runPty(input='qa-approve\n',pathTail=process.env.PATH??''){
    const cmd=`cat ${quote(join(source,'install.sh'))} | /bin/sh -s -- --prefix ${quote(prefix)} --bin-dir ${quote(bin)}`
    const child=Bun.spawn([Bun.which('script')!,'--quiet','--return','--command',cmd,'/dev/null'],{cwd:root,env:{...process.env,HOME:home,XDG_DATA_HOME:data,LYAPUNOV_INSTALL_BASE_URL:`http://127.0.0.1:${server.port}`,PATH:storageBin+':'+sudoBin+(pathTail?':'+pathTail:'')},stdin:'pipe',stdout:'pipe',stderr:'pipe'})
    child.stdin.write(input);child.stdin.end()
    const [status,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {status,out,err}
  }
  async function runNoTty(){
    // A new session with no controlling terminal, even when CI was launched
    // from a terminal. The actual installer still reads a curl-style pipe.
    const code='import subprocess,sys;raise SystemExit(subprocess.run(["/bin/sh","-s","--",*sys.argv[2:]],input=open(sys.argv[1],"rb").read(),start_new_session=True).returncode)'
    const child=Bun.spawn(['/usr/bin/python3','-c',code,join(source,'install.sh'),'--prefix',prefix,'--bin-dir',bin],{cwd:root,env:{...process.env,HOME:home,XDG_DATA_HOME:data,LYAPUNOV_INSTALL_BASE_URL:`http://127.0.0.1:${server.port}`,PATH:storageBin+':'+sudoBin+':'+process.env.PATH},stdout:'pipe',stderr:'pipe'})
    const [status,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {status,out,err}
  }
  function legacyDesktop(wrapper=true){
    const old=join(root,'legacy application'),oldData=join(root,'legacy user data'),entry=join(data,'applications/lyapunov-desktop.desktop')
    put(join(old,'RELEASE.json'),JSON.stringify({product:'LyapunovDSH',platform:'linux-x64',version:'0.0.9'}));put(join(old,'package.json'),JSON.stringify({name:'lyapunov-dsh'}))
    put(join(old,'packages/desktop/icons/lyapunov.png'),'old product icon');put(join(old,'lyapunov'),'#!/bin/sh\nexit 93\n',true);put(join(oldData,'session'),'keep old data')
    const executable=wrapper?join(root,'legacy launcher.sh'):join(old,'lyapunov')
    if(wrapper)put(executable,`#!/bin/sh\nprevious_package=${quote(old)}\nexport LYAPUNOV_DESKTOP_DATA_DIR=${quote(oldData)}\ncd "$previous_package"\nexec ./lyapunov desktop "$@"\n`,true)
    const text=`[Desktop Entry]\nType=Application\nName=Lyapunov联测\nStartupWMClass=lyapunov-desktop\nExec=${desktopExecutable(executable)}\nIcon=${join(old,'packages/desktop/icons/lyapunov.png')}\nTerminal=false\n`
    put(entry,text);return {old,oldData,entry,text,executable}
  }
  return {root,prefix,bin,data,home,candidate,run,runPty,runNoTty,fakeSudo,fakeDependencies,sudoLog,sudoTty,legacyDesktop,fakeSpace,withoutDfPath,fakeCurlFailure,dfLog,curlLog,files,ranges,requests,manifests,port:server.port,stop:()=>server.stop(true)}
}
describe('公开 POSIX 用户安装入口',()=>{
  test('无系统Git的普通PTY安装自动准备固定git包并真实重验；准备后仍不可用保current',async()=>{
    for(const gitRemainsMissing of [false,true]){
      const f=fixture()
      try{
        f.candidate('git-required');const bare=f.withoutDfPath();rmSync(join(bare,'git'));f.fakeSpace();const apt=f.fakeDependencies({runtimeGit:true,gitRemainsMissing})
        const old=join(f.prefix,'versions/old-git-safe');mkdirSync(old,{recursive:true});symlinkSync('versions/old-git-safe',join(f.prefix,'current'))
        const result=await f.runPty('qa-approve\n','')
        expect(readFileSync(apt.aptLog,'utf8')).toContain('git')
        expect(readFileSync(apt.aptLog,'utf8')).toContain('--no-remove')
        if(gitRemainsMissing){expect(result.status).toBe(2);expect(result.out).toContain('RUNTIME_GIT_UNAVAILABLE_AFTER_PREPARATION');expect(readlinkSync(join(f.prefix,'current'))).toBe('versions/old-git-safe')}
        else{expect(result.status,result.out+result.err).toBe(0);expect(readlinkSync(join(f.prefix,'current'))).toContain('git-required');expect(readFileSync(join(f.prefix,'versions/git-required/doctor.args'),'utf8')).toContain('doctor mujoco --managed-sdk')}
      }finally{f.stop()}
    }
  })
  test('实际doctor在无Git时阻断，版本探测通过才报告工具可用，不以桌面或Mu结果冒充',()=>{
    const root=mkdtempSync(join(tmpdir(),'lya-doctor-git-'));directories.push(root)
    const commands=join(root,'commands');mkdirSync(commands)
    put(join(root,'RELEASE.json'),JSON.stringify({product:'Lyapunov',version:'0.1.0',platform:'linux-x64'}))
    put(join(root,'runtime/electron/lyapunov-desktop'),'#!/bin/sh\nexit 0\n',true)
    put(join(commands,'ldd'),'#!/bin/sh\nexit 0\n',true)
    put(join(root,'packages/lyapunov-product-bundle/src/sdk-python.mjs'),'export function resolveSdkPython(){return {python:"/not-used",source:"package-default"}}\n')
    const doctor=join(root,'distribution/linux/doctor.mjs');mkdirSync(dirname(doctor),{recursive:true});copyFileSync(join(source,'doctor.mjs'),doctor);copyFileSync(join(source,'sandbox.mjs'),join(dirname(doctor),'sandbox.mjs'))
    const probe=()=>spawnSync(node,[doctor,'desktop'],{encoding:'utf8',env:{...process.env,PATH:commands}})
    let result=probe(),report=JSON.parse(result.stdout)
    expect(result.status).toBe(2);expect(report.desktop.code).toBe('RUNTIME_GIT_UNAVAILABLE');expect(report.desktop.runtimeTools.git.status).toBe('BLOCKED')
    put(join(commands,'git'),'#!/bin/sh\nprintf "%s\\n" "git version 2.53.0-fixture"\n',true)
    result=probe();report=JSON.parse(result.stdout);expect(report.desktop.runtimeTools.git).toMatchObject({status:'AVAILABLE',version:'git version 2.53.0-fixture'});expect(report.desktop.code).not.toBe('RUNTIME_GIT_UNAVAILABLE')
  })

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
      f.candidate('a08-three',{physicsFails:true});const result=await f.run();expect(result.status).toBe(17);expect(result.err).toContain('Native MuJoCo physics check failed')
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
      // 通用 Kit 大 wheel 的独立 helper：以真实 loopback Range 证明续传、完整缓存复用、
      // 错误 Content-Range 与错误 SHA256 都不会产出交给 pip 的正式 .whl，且不静默删错件。
      const wheel=Buffer.alloc(1024);for(let index=0;index<wheel.length;index++)wheel[index]=index%251
      const wheelName='isaacsim_extscache_kit-6.0.1.0-cp312-none-manylinux_2_35_x86_64.whl'
      f.files.set(`wheels/${wheelName}`,wheel)
      const wheelsDir=join(f.root,'wheel-cache'),pinPath=join(f.root,'extscache-pin.json'),helper=join(source,'fetch-extscache-kit.mjs')
      const writePin=(overrides:Record<string,unknown>={})=>writeFileSync(pinPath,JSON.stringify({filename:wheelName,url:`http://127.0.0.1:${f.port}/wheels/${wheelName}`,bytes:wheel.length,sha256:sha(wheel),...overrides}))
      const runHelper=async()=>{const child=Bun.spawn([node,helper,'--pin',pinPath,'--wheels-dir',wheelsDir,'--segment-bytes','256'],{stdout:'pipe',stderr:'pipe'});const [status,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {status,out:out.trim(),err}}
      const wheelPath=join(wheelsDir,wheelName),wheelPartial=wheelPath+'.partial'
      // ① 从已有 100 字节 partial 续传：必须发 bytes=100-355 并从该处接续，最终原子改名去 partial。
      mkdirSync(wheelsDir,{recursive:true});writeFileSync(wheelPartial,wheel.subarray(0,100));writePin();f.ranges.length=0
      let helperRun=await runHelper()
      expect(helperRun.status,helperRun.err).toBe(0);expect(helperRun.out).toBe(wheelPath)
      expect(readFileSync(wheelPath).equals(wheel)).toBe(true);expect(existsSync(wheelPartial)).toBe(false);expect(f.ranges).toContain('bytes=100-355')
      // ② 完整缓存重验复用：不再发任何网络请求。
      f.ranges.length=0;helperRun=await runHelper()
      expect(helperRun.status,helperRun.err).toBe(0);expect(helperRun.out).toBe(wheelPath);expect(f.ranges).toEqual([])
      // ③ 错误 Content-Range（pin 总长度与官方实际不符）：明确非零、不产出正式 .whl。
      rmSync(wheelPath);rmSync(wheelPartial,{force:true});writePin({bytes:wheel.length+1})
      helperRun=await runHelper()
      expect(helperRun.status).not.toBe(0);expect(helperRun.err).toContain('Content-Range');expect(existsSync(wheelPath)).toBe(false)
      // ④ 错误 SHA256：完整下载后校验失败，不原子改名，保留完整 partial 并明确报错。
      rmSync(wheelPath,{force:true});rmSync(wheelPartial,{force:true});writePin({sha256:'a'.repeat(64)})
      helperRun=await runHelper()
      expect(helperRun.status).not.toBe(0);expect(helperRun.err).toContain('SHA256_MISMATCH');expect(existsSync(wheelPath)).toBe(false);expect(existsSync(wheelPartial)).toBe(true)
      // ⑤ 已存在的完整文件不是固定字节：保留原文件并明确报错，不覆盖、不降低校验。
      rmSync(wheelPartial,{force:true});writeFileSync(wheelPath,Buffer.alloc(wheel.length,9));writePin()
      helperRun=await runHelper()
      expect(helperRun.status).not.toBe(0);expect(helperRun.err).toContain('WHEEL_CACHE_MISMATCH');expect(readFileSync(wheelPath).equals(Buffer.alloc(wheel.length,9))).toBe(true)
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
      expect(result.status).toBe(physicsFails?17:2);expect(result.out).toContain(physicsFails?'Native MuJoCo physics check failed':'SANDBOX_RECHECK_FAILED');expect(existsSync(join(f.prefix,'current'))).toBe(false)
      expect(readFileSync(join(f.prefix,'versions/a08-after-auth/doctor.args'),'utf8').trim().split('\n')).toHaveLength(2)
    }finally{f.stop()}}
  })
  test('旧同产品direct或自定义wrapper入口先保留再生成canonical，数据不变且重复不累积',async()=>{
    for(const wrapper of [false,true]){const f=fixture();try{f.candidate('a08-upgrade-entry');const old=f.legacyDesktop(wrapper);const before=readFileSync(old.executable,'utf8');let result=await f.run()
      expect(result.status,result.err).toBe(0);expect(readFileSync(old.entry,'utf8')).toContain('X-Lyapunov-Install-Root=')
      expect(readFileSync(join(f.data,'applications/lyapunov-desktop.legacy.desktop'),'utf8')).toBe(old.text)
      expect(readFileSync(join(f.prefix,'entry-backups/lyapunov-desktop.original'),'utf8')).toBe(old.text)
      expect(readFileSync(join(old.oldData,'session'),'utf8')).toBe('keep old data');expect(readFileSync(old.executable,'utf8')).toBe(before)
      result=await f.run();expect(result.status,result.err).toBe(0);expect(readdirSync(join(f.prefix,'entry-backups'))).toEqual(['lyapunov-desktop.original'])
      expect(readdirSync(join(f.data,'applications')).sort()).toEqual(['lyapunov-desktop.desktop','lyapunov-desktop.legacy.desktop'])
    }finally{f.stop()}}
  })
  test('unknown foreign或只伪WMClass的desktop保原样，不创建legacy/backup/current',async()=>{
    for(const identity of [false,true]){const f=fixture();try{f.candidate('a08-foreign-entry');const old=f.legacyDesktop();const text=identity?old.text.replace(desktopExecutable(old.executable),desktopExecutable('/bin/true')):'[Desktop Entry]\nName=Foreign app\nExec=/bin/true\n'
      put(old.entry,text);const result=await f.run();expect(result.status).not.toBe(0);expect(readFileSync(old.entry,'utf8')).toBe(text)
      expect(existsSync(join(f.prefix,'entry-backups'))).toBe(false);expect(existsSync(join(f.data,'applications/lyapunov-desktop.legacy.desktop'))).toBe(false);expect(existsSync(join(f.prefix,'current'))).toBe(false)
    }finally{f.stop()}}
  })
  test('legacy保留名字已被foreign占用则两入口都不覆盖',async()=>{
    const f=fixture();try{f.candidate('a08-legacy-conflict');const old=f.legacyDesktop();const saved=join(f.data,'applications/lyapunov-desktop.legacy.desktop');put(saved,'foreign retained entry')
      const result=await f.run();expect(result.status).not.toBe(0);expect(readFileSync(old.entry,'utf8')).toBe(old.text);expect(readFileSync(saved,'utf8')).toBe('foreign retained entry')
    }finally{f.stop()}
  })
  test('新入口生成失败或后续activation失败恢复旧canonical并保数据',async()=>{
    for(const entryFails of [true,false]){const f=fixture();try{f.candidate('a08-restore-entry',{entryFails});const old=f.legacyDesktop();const denyBin=join(f.root,'activation failure')
      put(join(denyBin,'mv'),'#!/bin/sh\nfor part in "$@";do case "$part" in *.current.*) exit 23;;esac;done\nexec /bin/mv "$@"\n',true)
      const result=await f.run([],entryFails?{}:{PATH:denyBin+':'+process.env.PATH});expect(result.status).not.toBe(0);expect(readFileSync(old.entry,'utf8')).toBe(old.text)
      expect(readFileSync(join(old.oldData,'session'),'utf8')).toBe('keep old data');expect(existsSync(old.entry+'.lyapunov-upgrade-pending')).toBe(false);expect(existsSync(join(f.prefix,'current'))).toBe(false)
    }finally{f.stop()}}
  })
  test('physics详细JSON进产品日志，终端短PASS；真实失败exit保留',async()=>{
    for(const physicsFails of [false,true]){const f=fixture();try{f.candidate('a08-physics-log',{physicsFails});const result=await f.run();expect(result.status).toBe(physicsFails?17:0)
      const log=join(f.prefix,'versions/a08-physics-log/.install/physics-check.log');expect(existsSync(log)).toBe(true);expect(result.out).not.toContain('{"status":"PASS"}')
      expect(result.out+result.err).toContain(log);if(!physicsFails)expect(JSON.parse(readFileSync(log,'utf8'))).toEqual({status:'PASS'})
    }finally{f.stop()}}
  })
  test('真实PTY的默认管道按实际缺库选择t64或legacy候选，重验后才激活且不自动打开GUI',async()=>{
    for(const legacy of [false,true]){const f=fixture();try{f.candidate('a08-libraries',{desktopLibraries:'required'});const {aptLog}=f.fakeDependencies({legacy});const result=await f.runPty()
      expect(result.status,result.out+result.err).toBe(0);const product=join(f.prefix,'versions/a08-libraries'),args=readFileSync(aptLog,'utf8')
      expect(args).toContain('update');expect(args).toContain('install\n--yes\n--no-install-recommends\n--no-upgrade\n--no-remove\n')
      expect(args).toContain(legacy?'libasound2\nlibgtk-3-0\nlibnss3':'libasound2t64\nlibgtk-3-0t64\nlibnss3');expect(args).not.toContain('ubuntu-desktop')
      expect(readFileSync(join(product,'doctor.args'),'utf8').trim().split('\n')).toHaveLength(2);expect(existsSync(join(product,'physics.args'))).toBe(true)
      expect(readlinkSync(join(f.prefix,'current'))).toBe('versions/a08-libraries');expect(existsSync(join(product,'gui.args'))).toBe(false)
    }finally{f.stop()}}
  })
  test('库补齐后显露的真实sandbox阻断仍经原门禁授权与normal doctor，不跳过安全检查',async()=>{
    const f=fixture();try{f.candidate('a08-deps-sandbox',{desktopLibraries:'sandbox'});f.fakeDependencies();const result=await f.runPty()
      expect(result.status,result.out+result.err).toBe(0);const product=join(f.prefix,'versions/a08-deps-sandbox')
      expect(readFileSync(join(product,'doctor.args'),'utf8').trim().split('\n')).toHaveLength(3);expect(readFileSync(join(product,'setup.args'),'utf8').trim()).toBe('setup-sandbox')
      expect(readFileSync(f.sudoLog,'utf8')).toContain(join(product,'lyapunov')+'\nsetup-sandbox');expect(readlinkSync(join(f.prefix,'current'))).toBe('versions/a08-deps-sandbox')
    }finally{f.stop()}
  })
  test('依赖授权拒绝、网络更新失败、包缺候选、安装失败及重验仍缺库均保留旧current与数据',async()=>{
    for(const failure of ['deny','updateFails','packageMissing','installFails','remain','bad-exit'] as const){const f=fixture();try{f.candidate('a08-before');expect((await f.run()).status).toBe(0);put(join(f.home,'session'),'unchanged user data')
      f.candidate('a08-deps-failed',{desktopLibraries:failure==='remain'||failure==='bad-exit'?failure:'required'});f.fakeDependencies(failure==='remain'||failure==='bad-exit'?{}:{[failure]:true});const result=await f.runPty()
      expect(result.status,result.out+result.err).toBe(2);const product=join(f.prefix,'versions/a08-deps-failed')
      expect(readlinkSync(join(f.prefix,'current'))).toBe('versions/a08-before');expect(readFileSync(join(f.home,'session'),'utf8')).toBe('unchanged user data')
      expect(existsSync(join(product,'.install/mujoco.sha256'))).toBe(true);expect(existsSync(join(product,'physics.args'))).toBe(false);expect(existsSync(join(product,'gui.args'))).toBe(false)
    }finally{f.stop()}}
  // 六个分支顺序建立真实 tar/HTTP/PTY 夹具，实测总耗时超过默认 5s；只给本用例留出有界余量。
  },30_000)
  test('未知SONAME与重读ldd不符时不请求系统权限，不进行猜测安装',async()=>{
    for(const mode of ['unknown','changed'] as const){const f=fixture();try{f.candidate('a08-unknown',{desktopLibraries:mode});f.fakeDependencies({[mode]:true});const result=await f.runPty('')
      expect(result.status,result.out+result.err).toBe(2);expect(result.out).toContain(mode==='unknown'?'DESKTOP_LIBRARY_UNMAPPED':'DESKTOP_DEPENDENCY_REPORT_CHANGED')
      expect(existsSync(f.sudoLog)).toBe(false);expect(existsSync(join(f.prefix,'current'))).toBe(false)
    }finally{f.stop()}}
  })
  test('缺GUI库且无控制终端时明确停止，不从脚本流读取认证输入',async()=>{
    const f=fixture();try{f.candidate('a08-deps-no-tty',{desktopLibraries:'required'});f.fakeDependencies();const result=await f.runNoTty()
      expect(result.status,result.out+result.err).toBe(2);expect(result.err).toContain('DESKTOP_DEPENDENCIES_TERMINAL_REQUIRED');expect(existsSync(f.sudoLog)).toBe(false)
    }finally{f.stop()}
  })
})
describe('安装下载空间与写入失败回归（受控df、真实POSIX入口和loopback）',()=>{
  test('低空间在归档下载前拒绝，保留current/previous/用户数据及partial，释放后同入口Range续传',async()=>{
    const f=fixture();try{
      f.candidate('storage-old');expect((await f.run()).status).toBe(0)
      f.candidate('storage-current');expect((await f.run()).status).toBe(0)
      const sentinel=join(f.home,'user-data/session');put(sentinel,'保留用户数据')
      const row=f.candidate('storage-next'),bytes=f.files.get(`releases/${row.releaseId}/${row.archive.path}`)!,partial=join(f.prefix,'downloads',row.archive.sha256+'.tar.gz.partial')
      writeFileSync(partial,bytes.subarray(0,64));f.fakeSpace(0);f.requests.length=0
      let result=await f.run([],{},true)
      expect(result.status,result.err).toBe(2);expect(result.err).toContain('Lyapunov [storage] STORAGE_INSUFFICIENT')
      expect(result.err).toContain(`target=${partial}; available=0 bytes; remaining download requires at least ${bytes.length-64} bytes`)
      expect(result.err).toContain('rerun the same curl installer to resume');expect(result.err).toContain('additional space not specified by this manifest')
      expect(result.err).toContain(`df -Pk ${join(f.prefix,'downloads')}`)
      expect(f.requests).toEqual(['releases/latest/linux-x64.tsv']);expect(f.ranges).toEqual([])
      expect(readlinkSync(join(f.prefix,'current'))).toBe('versions/storage-current');expect(readlinkSync(join(f.prefix,'previous'))).toBe('versions/storage-old')
      expect(readFileSync(sentinel,'utf8')).toBe('保留用户数据');expect(readFileSync(partial).equals(bytes.subarray(0,64))).toBe(true)
      expect(existsSync(join(f.prefix,'versions/storage-next'))).toBe(false);expect(existsSync(join(f.prefix,'.install-lock'))).toBe(false)
      expect(readFileSync(f.dfLog,'utf8').trim().split('\n').slice(-2)).toEqual(['-Pk',join(f.prefix,'downloads')])
      f.fakeSpace();result=await f.run();expect(result.status,result.err).toBe(0)
      expect(f.ranges).toContain('bytes=64-');expect(existsSync(partial)).toBe(false);expect(readlinkSync(join(f.prefix,'current'))).toBe('versions/storage-next')
      expect(readFileSync(sentinel,'utf8')).toBe('保留用户数据')
    }finally{f.stop()}
  })
  test('首次安装空间不足时只取manifest，不创建partial或current',async()=>{
    const f=fixture();try{const row=f.candidate('storage-empty');f.fakeSpace(0);const result=await f.run()
      expect(result.status,result.err).toBe(2);expect(result.err).toContain(`remaining download requires at least ${row.archive.bytes} bytes`)
      expect(f.requests).toEqual(['releases/latest/linux-x64.tsv']);expect(existsSync(join(f.prefix,'current'))).toBe(false)
      expect(existsSync(join(f.prefix,'downloads',row.archive.sha256+'.tar.gz.partial'))).toBe(false)
    }finally{f.stop()}
  })
  test('仅剩512字节时1KiB空间足够；真实HTTP Range完成后仍校验完整bytes/hash',async()=>{
    const f=fixture();try{const row=f.candidate('storage-remainder'),bytes=f.files.get(`releases/${row.releaseId}/${row.archive.path}`)!
      expect(bytes.length).toBeGreaterThan(1024)
      const partial=join(f.prefix,'downloads',row.archive.sha256+'.tar.gz.partial');mkdirSync(dirname(partial),{recursive:true});writeFileSync(partial,bytes.subarray(0,bytes.length-512));f.fakeSpace(1)
      const result=await f.run();expect(result.status,result.err).toBe(0);expect(f.ranges).toContain(`bytes=${bytes.length-512}-`)
      expect(readFileSync(partial.slice(0,-'.partial'.length)).equals(bytes)).toBe(true);expect(existsSync(partial)).toBe(false)
    }finally{f.stop()}
  })
  test('已有校验通过的主包与runtime缓存不重复要求整包空间，也不再次下载归档',async()=>{
    const f=fixture();try{const row=f.candidate('storage-cache');if(row.mujoco.mode!=='conda-pack')throw Error('fixture mode')
      mkdirSync(join(f.prefix,'downloads'),{recursive:true})
      for(const artifact of [row.archive,row.mujoco.runtime.archive])writeFileSync(join(f.prefix,'downloads',artifact.sha256+'.tar.gz'),f.files.get(`releases/${row.releaseId}/${artifact.path}`)!)
      f.fakeSpace(0);const result=await f.run();expect(result.status,result.err).toBe(0)
      expect(result.out.match(/Reusing verified download\./g)).toHaveLength(2);expect(f.requests).toEqual(['releases/latest/linux-x64.tsv']);expect(existsSync(f.dfLog)).toBe(false)
      expect(existsSync(join(f.prefix,'versions/storage-cache/physics.args'))).toBe(true)
    }finally{f.stop()}
  })
  test('完整partial先验hash再改名，不请求超出末尾的Range；同长度错hash保持拒绝且留原件',async()=>{
    for(const corrupt of [false,true]){const f=fixture();try{const row=f.candidate('storage-full-partial',{mode:'install-provider'}),bytes=Buffer.from(f.files.get(`releases/${row.releaseId}/${row.archive.path}`)!)
      if(corrupt)bytes[0]^=1
      const partial=join(f.prefix,'downloads',row.archive.sha256+'.tar.gz.partial');mkdirSync(dirname(partial),{recursive:true});writeFileSync(partial,bytes);f.fakeSpace(0)
      const result=await f.run(['--without-mujoco']);expect(result.status,result.err).toBe(corrupt?2:0);expect(f.requests).toEqual(['releases/latest/linux-x64.tsv']);expect(f.ranges).toEqual([])
      expect(existsSync(partial)).toBe(corrupt);expect(existsSync(partial.slice(0,-'.partial'.length))).toBe(!corrupt)
      if(corrupt){expect(result.err).toContain('SHA256 mismatch');expect(readFileSync(partial).equals(bytes)).toBe(true);expect(existsSync(join(f.prefix,'current'))).toBe(false)}
    }finally{f.stop()}}
  })
  test('df缺失、读取失败或格式不可解析均明示未知并保留原验证路径，不把未知当空间充足或零',async()=>{
    for(const mode of ['missing','unreadable','malformed'] as const){const f=fixture();try{const row=f.candidate('storage-unknown')
      const overrides=mode==='missing'?{PATH:f.withoutDfPath()}:{};if(mode!=='missing')f.fakeSpace(mode)
      const result=await f.run([],overrides);expect(result.status,result.err).toBe(0)
      expect(result.err).toContain('STORAGE_CHECK_UNAVAILABLE');expect(result.err).toContain('available=unknown')
      expect(result.err).toContain(`remaining download requires at least ${row.archive.bytes} bytes`);expect(result.err).toContain('additional space not specified by this manifest')
      expect(result.err).not.toContain('STORAGE_INSUFFICIENT');expect(existsSync(join(f.prefix,'versions/storage-unknown/physics.args'))).toBe(true)
      expect(f.requests).toContain(`releases/${row.releaseId}/${row.archive.path}`)
    }finally{f.stop()}}
  })
  test('curl23分别复查零/非零/未知容量：仅实测零指出无可用空间，所有失败保留partial和旧current',async()=>{
    for(const availableAfter of [0,1_048_576,'unreadable'] as const){const f=fixture();try{
      f.candidate('storage-before-write');expect((await f.run()).status).toBe(0)
      const row=f.candidate('storage-write-failed'),bytes=f.files.get(`releases/${row.releaseId}/${row.archive.path}`)!,partial=join(f.prefix,'downloads',row.archive.sha256+'.tar.gz.partial')
      writeFileSync(partial,bytes.subarray(0,64));f.fakeCurlFailure(23,availableAfter)
      const result=await f.run([],{},true);expect(result.status,result.err).toBe(2);expect(result.err).toContain('Lyapunov [storage] STORAGE_WRITE_FAILED: curl exit 23')
      expect(result.err).toContain(`target=${partial}`);expect(result.err).toContain(`remaining download requires at least ${bytes.length-64} bytes`)
      expect(result.err).toContain('rerun the same curl installer to resume');expect(result.err).not.toContain('MuJoCo installation failed')
      if(availableAfter===0)expect(result.err).toContain('The destination filesystem reports no available space.')
      else{expect(result.err).not.toContain('The destination filesystem reports no available space.');expect(result.err.toLowerCase()).toContain('check filesystem space and write permissions.')}
      if(availableAfter==='unreadable')expect(result.err).toContain('available=unknown')
      expect(readlinkSync(join(f.prefix,'current'))).toBe('versions/storage-before-write');expect(readFileSync(partial).equals(bytes.subarray(0,64))).toBe(true)
      expect(existsSync(join(f.prefix,'versions/storage-write-failed'))).toBe(false)
      expect(readFileSync(f.curlLog,'utf8')).toContain('--continue-at\n-\n--output\n'+partial)
    }finally{f.stop()}}
  })
  test('真实curl向临时partial的/dev/full写入失败为23；df仍有空间时只提示检查写入条件',async()=>{
    const f=fixture();try{const row=f.candidate('storage-real-write'),partial=join(f.prefix,'downloads',row.archive.sha256+'.tar.gz.partial')
      mkdirSync(dirname(partial),{recursive:true});symlinkSync('/dev/full',partial)
      const result=await f.run();expect(result.status,result.err).toBe(2);expect(result.err).toContain('STORAGE_WRITE_FAILED: curl exit 23')
      expect(result.err).toContain('Check filesystem space and write permissions.');expect(result.err).not.toContain('The destination filesystem reports no available space.')
      expect(f.requests).toContain(`releases/${row.releaseId}/${row.archive.path}`);expect(readlinkSync(partial)).toBe('/dev/full');expect(existsSync(join(f.prefix,'current'))).toBe(false)
    }finally{f.stop()}
  })
  test('manifest自身curl23也报实际写入目标和容量，清单未读时剩余归档体积保持未知',async()=>{
    const f=fixture();try{
      f.candidate('storage-before-manifest');expect((await f.run()).status).toBe(0)
      const row=f.candidate('storage-manifest-failed'),bytes=f.files.get(`releases/${row.releaseId}/${row.archive.path}`)!,partial=join(f.prefix,'downloads',row.archive.sha256+'.tar.gz.partial')
      writeFileSync(partial,bytes.subarray(0,64));f.fakeCurlFailure(23,0,'manifest')
      const result=await f.run([],{},true);expect(result.status,result.err).toBe(2);expect(result.err).toContain('Lyapunov [storage] STORAGE_WRITE_FAILED: curl exit 23')
      expect(result.err).toContain('/manifest.tsv; available=0 bytes; Remaining archive download size is unknown until the release manifest is read.')
      expect(result.err).toContain('The destination filesystem reports no available space.');expect(result.err).toContain('rerun the same curl installer to resume')
      expect(readlinkSync(join(f.prefix,'current'))).toBe('versions/storage-before-manifest');expect(readFileSync(partial).equals(bytes.subarray(0,64))).toBe(true)
      expect(existsSync(join(f.prefix,'versions/storage-manifest-failed'))).toBe(false)
      expect(readFileSync(f.dfLog,'utf8').trim().split('\n').at(-1)).toContain(join(f.prefix,'.incoming.'))
    }finally{f.stop()}
  })
  test('非写入类curl失败仍报告实际退出码，不误报磁盘或依赖失败',async()=>{
    const f=fixture();try{f.candidate('storage-curl-other');f.fakeCurlFailure(22,0);const result=await f.run()
      expect(result.status,result.err).toBe(2);expect(result.err).toContain('Archive download failed (curl exit 22)')
      expect(result.err).not.toContain('STORAGE_WRITE_FAILED');expect(result.err).not.toContain('STORAGE_INSUFFICIENT');expect(result.err).not.toContain('MuJoCo installation failed')
      expect(existsSync(join(f.prefix,'current'))).toBe(false)
    }finally{f.stop()}
  })
})
describe('与bootstrap同字节的受限依赖计划',()=>{
  test('未知发行版、provider未ready和注入式SONAME都拒绝；完整Ubuntu/debian报告仅输出固定包候选',()=>{
    const code=readFileSync(join(source,'install.sh'),'utf8').split('// BEGIN_DESKTOP_DEPENDENCY_PLAN\n')[1]!.split('// END_DESKTOP_DEPENDENCY_PLAN')[0]!
    function plan(os:string,rows:string[],provider='AVAILABLE'){
      let exit=0,out='',err='';const report={status:'BLOCKED',providers:{mujoco:{status:provider}},desktop:{status:'BLOCKED',code:'DESKTOP_LIBRARIES_MISSING',missingSystemLibraries:rows}}
      const context={require:(id:string)=>id==='node:fs'?{readFileSync:(path:string)=>path==='/etc/os-release'?os:JSON.stringify(report)}:id==='node:path'?{join:(...parts:string[])=>parts.join('/')}:id==='node:child_process'?{spawnSync:()=>({status:0,stdout:rows.join('\n')})}:null,process:{argv:['node','report.json','/product','true'],env:{},exit:(value:number)=>{exit=value;throw Error('fixture exit')}},console:{log:(value:string)=>{out=value},error:(value:string)=>{err=value}}}
      try{runInNewContext(code,context)}catch(error){if((error as Error).message!=='fixture exit')throw error}return {exit,out,err}
    }
    const rows=['libgtk-3.so.0 => not found','libasound.so.2 => not found','libnss3.so => not found']
    for(const os of ['ID=ubuntu\nVERSION_ID="24.04"','ID="ubuntu"\nVERSION_ID="26.04"','ID=debian'])expect(plan(os,rows)).toEqual({exit:0,out:'libasound2t64 libasound2\nlibgtk-3-0t64 libgtk-3-0\nlibnss3',err:''})
    expect(plan('ID=fedora',rows).err).toBe('DESKTOP_DEPENDENCY_OS_UNSUPPORTED');expect(plan('ID=ubuntu',rows,'BLOCKED').err).toBe('DESKTOP_DEPENDENCY_REPORT_INVALID')
    expect(plan('ID=ubuntu',['libgtk-3.so.0; touch /tmp/injected => not found']).err).toBe('DESKTOP_DEPENDENCY_REPORT_INVALID')
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
