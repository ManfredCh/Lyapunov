import {parseArgs} from 'node:util'
import {spawn} from 'node:child_process'
import {mkdir,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {prepareProfile,backendEnvironment,DSH_BIN,PRODUCT_ROOT,UPSTREAM,reconcileAndReportProductLinks} from '../../../script/profile.ts'
import {GitHubClient,installGitHubWorkflow,type GitHubAuth,type GitHubPublication,type GitHubOptions} from './github.ts'

export async function runGitHubCli(argv:string[],pluginPath:string):Promise<void>{
  const command=argv[0]
  if(!command||command==='help'||command==='--help'){
    process.stdout.write('GitHub入口：\n  github install --repo owner/name --support-url URL [--cwd DIR]\n  github inspect --repo owner/name --auth gh|github-token|pat|oidc\n  github run --repo owner/name --auth gh|github-token|pat|oidc [--event-path FILE | --issue N --prompt TEXT]\n  --publish none|comment|pull-request|update-branch 显式选择外部写入；默认none\n  --support-url URL 或 LYAPUNOV_SUPPORT_API_URL 配置既有支持服务\n  --resume SESSION --result FILE 复用原生DSH会话与本地结果\n')
    return
  }
  if(!['install','inspect','run'].includes(command))throw new Error('GITHUB_COMMAND_UNSUPPORTED: '+command)
  const {values}=parseArgs({args:argv.slice(1),options:{repo:{type:'string'},auth:{type:'string'},cwd:{type:'string'},'support-url':{type:'string'},'api-url':{type:'string'},'gh-path':{type:'string'},'pat-env':{type:'string'},prompt:{type:'string'},issue:{type:'string'},'event-path':{type:'string'},'event-name':{type:'string'},publish:{type:'string'},remote:{type:'string'},branch:{type:'string'},base:{type:'string'},'commit-message':{type:'string'},resume:{type:'string'},result:{type:'string'},'runtime-root':{type:'string'},provider:{type:'string'},model:{type:'string'},'cancel-after-ms':{type:'string'}}})
  const repository=values.repo??process.env.GITHUB_REPOSITORY
  if(!repository)throw new Error('GITHUB_REPOSITORY_REQUIRED: --repo owner/name')
  const auth=values.auth??(process.env.GITHUB_ACTIONS==='true'?'oidc':'github-token'),publication=values.publish??process.env.LYAPUNOV_GITHUB_PUBLICATION??'none'
  if(!['gh','pat','oidc','github-token'].includes(auth))throw new Error('GITHUB_AUTH_MODE_INVALID')
  if(!['none','comment','pull-request','update-branch'].includes(publication))throw new Error('GITHUB_PUBLICATION_INVALID')
  const options:GitHubOptions={repository,auth:auth as GitHubAuth,publication:publication as GitHubPublication,...values['support-url']?{supportUrl:values['support-url']}:{},...values['api-url']?{apiUrl:values['api-url']}:{},...values['gh-path']?{ghPath:values['gh-path']}:{},...values['pat-env']?{patEnv:values['pat-env']}:{},...values.prompt?{prompt:values.prompt}:{},...values.issue?{issue:Number(values.issue)}:{},...values['event-path']?{eventPath:resolve(values['event-path'])}:{},...values['event-name']?{eventName:values['event-name']}:{},...values.remote?{remote:values.remote}:{},...values.branch?{branch:values.branch}:{},...values.base?{baseBranch:values.base}:{},...values['commit-message']?{commitMessage:values['commit-message']}:{}}
  const cwd=resolve(values.cwd??process.cwd())
  if(command!=='run'){
    const client=new GitHubClient(options)
    try{const result=command==='install'?await installGitHubWorkflow(client,cwd,AbortSignal.timeout(30000),{provider:values.provider,model:values.model,publication:values.publish}):await client.repository(AbortSignal.timeout(30000));process.stdout.write(JSON.stringify(result)+'\n')}
    finally{await client.dispose()}
    return
  }
  const runtime=await prepareProfile({mode:'developer',surface:'sdk',runtimeRoot:values['runtime-root']??join(PRODUCT_ROOT,'.runtime/github')})
  const profile='lyapunov-developer-github',dir=join(runtime.paths.dshHome,'profiles',profile);await mkdir(dir,{recursive:true})
  // 这条入口以前是裸 `linkProductPackage()`：返回值丢掉，而且**整条入口不调用 `runtimePatch()`**
  // ⇒ 它的槽位切换 100% 静默，`reconcileProductPackageLinks()` 在这里一次都没跑过。
  // （验收队 2026-09-27 定位：`VERIFY-RUNTIME-PATCH-LINKS-20260926.md` §7.2 B4。）
  // 改为与 host/terminal/launch 三个入口**同一条路径**：切换 + 播报 + 审计；归属判定、冲突
  // fail-closed、切换动作仍全在 `script/product-link.ts`，本入口一个字没有自己实现。
  await reconcileAndReportProductLinks({profileDirectory:dir,productRoot:PRODUCT_ROOT,installAnchor:join(UPSTREAM,'apps/cli/package.json')})
  const profileManifest={name:profile,version:'0.1.0',private:true,type:'module',dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@lyapunov/product-bundle'],patchReload:'startup'}}}
  try{await writeFile(join(dir,'package.json'),JSON.stringify(profileManifest,null,2),{flag:'wx'})}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
  const config={github:options,cwd,...values.resume?{resumeSessionId:values.resume}:{},...values.result?{resultFile:resolve(values.result)}:{},...(values.provider??process.env.LYAPUNOV_GITHUB_PROVIDER)?{provider:values.provider??process.env.LYAPUNOV_GITHUB_PROVIDER}:{},...(values.model??process.env.LYAPUNOV_GITHUB_MODEL)?{model:values.model??process.env.LYAPUNOV_GITHUB_MODEL}:{},...values['cancel-after-ms']?{cancelAfterMs:Number(values['cancel-after-ms'])}:{}}
  const patch=join(dir,'github-'+randomUUID()+'.yml')
  await writeFile(patch,'- insert: '+JSON.stringify([{id:'lyapunov-github-cli',name:pluginPath,config}])+'\n',{mode:0o600})
  const child=spawn(process.execPath,[DSH_BIN,'--profile',profile,'--patch',patch],{cwd,env:await backendEnvironment('developer',runtime.paths),stdio:'inherit'})
  const interrupt=()=>child.kill('SIGINT');process.once('SIGINT',interrupt)
  try{process.exitCode=await new Promise<number>((done,reject)=>{child.once('error',reject);child.once('exit',code=>done(code??1))})}
  finally{process.off('SIGINT',interrupt)}
}
