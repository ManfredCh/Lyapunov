import {cp,mkdir,readdir,readFile,writeFile,realpath,readlink,symlink,chmod,rm,stat,rename} from 'node:fs/promises'
import {existsSync,writeSync,createReadStream} from 'node:fs'
import {dirname,join,relative,resolve,isAbsolute,basename} from 'node:path'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {parseArgs} from 'node:util'
// 发行载荷结构契约（顶层单一可执行入口 + 随包 Provider 定义）：纯函数在 distribution/linux/payload-contract.ts，
// 这里只做取数与 fail-closed；守卫/负对照见 distribution/linux/payload-contract.test.ts。
import {entryViolations,bundledProviderViolations,payloadLinkTarget,sandboxRuntimeViolations,productRuntimeViolations,frontendRuntimeViolations,nativeSystemRuntimeViolations,workspacePayloadDestination,PRODUCT_ENTRY,type PayloadTopLevelRow} from '../distribution/linux/payload-contract.ts'
// micromamba 许可证的**取件顺序与身份校验**（env 覆盖 → 入库件 → 缓存 → 网络兜底）：
// 纯逻辑在 distribution/licenses/mamba-license.ts，这里只注入有界取件器并 fail-closed。
import {MAMBA_LICENSE_ENV,mambaLicenseFileName,mambaLicenseIdentityVerdict,mambaLicenseUrl,resolveMambaLicense} from '../distribution/licenses/mamba-license.ts'
import {checkedRuntimeManifest,checkedReleaseManifest,releaseManifestTsv,type LinuxReleaseManifest} from '../distribution/linux/release-manifest.ts'
import {prepareLinuxNativeSystem} from './native-system.ts'

const root=resolve(import.meta.dirname,'..')
const {values}=parseArgs({options:{output:{type:'string',default:join(root,'.runtime/releases')},node:{type:'string',default:process.env.LYAPUNOV_PACKAGE_NODE??'node'},micromamba:{type:'string',default:join(root,'.runtime/bin/micromamba')},'check-source':{type:'boolean',default:false},root:{type:'string'},'release-id':{type:'string'},'mujoco-runtime-archive':{type:'string'},'mujoco-runtime-manifest':{type:'string'}}})
if(process.platform!=='linux'||process.arch!=='x64')throw new Error('当前交付入口仅支持 Linux x64')

// ─────────────────────────────────────────────────────────────────────────────
// 出处守卫（ARCHIVE-SOURCECOMMIT-HONESTY，2026-09-27）：**包里装的东西**与**RELEASE.json 声明的
// `sourceCommit`** 必须是同一棵树；不是 ⇒ 拒绝打包并点名。
//
// 为什么必须拦、而不是"打个标记就算"：下面第 20 行**无条件**重跑 `script/build-plugins.ts`
// （它对本仓每个 `packages/*/src/plugin.ts` 都跑一次 `Bun.build`，**没有**"没变就跳过"的分支）⇒
// 载荷里的 `dist` 是**打包那一刻工作树 src** 的函数；而 `sourceCommit` 取 `git rev-parse HEAD`。
// 工作树非空 ⇒ 「包内容 ← 工作树 / 声明 ← HEAD」不对齐，而这件事在产物里**原本一个字都看不出来**：
// 2026-09-26 的发行归档正是如此 —— 包内 20 条判据 18 条不合期望，而 `sourceCommitResolution`
// 仍写着 `git rev-parse HEAD`（`bugfixHistory/VERIFY-DIST-PRODUCT-20260927.md` §4.4–4.5）。
//
// 口径是**载荷相关路径**，不是"树脏就拦"：只拦可能进包的 `packages/` · `distribution/` ·
// `script/` · `package.json` · `bun.lock` · `UPSTREAM_LOCK.json`。回执与 `docs/` 的未提交改动
// **不进载荷**，不拦 —— 本仓的日常形态就是"回执写在仓里"，恒红的守卫等于没有守卫。
// 已知边界（如实登记，别当成已覆盖）：`.upstream/` 与 `node_modules/` 都是 gitignored，
// `git status` **看不见**它们，而它们**确实进载荷**（`collect()` 经 node_modules 链接 realpath 进
// `.upstream`）；`.upstream` 的版本另由 `UPSTREAM_LOCK.json.commit` 钉住。
//
// 读数与 `script/release-gate.ts` 的 `PROVENANCE` 行**同一口径**：`dirty` = porcelain 条目数、
// `worktree` = **同一份 porcelain 文本**的 sha256 前 12 位（`docs/REMAINING_WORK_PLAN.md` §7.17 ②：
// 回执把这一行抄走，读数就带上了"这是哪一版树"）。
// `--check-source` 自检模式退出码：`0` = CLEAN / `3` = 载荷相关路径脏（正式打包会拒绝）/ `4` = 取不到 git 读数。
// ─────────────────────────────────────────────────────────────────────────────
const PAYLOAD_SCOPE=['packages','distribution','script','package.json','bun.lock','UPSTREAM_LOCK.json','LICENSE','NOTICE'] as const
const ALLOW_DIRTY_ENV='LYAPUNOV_PACKAGE_ALLOW_DIRTY'
const PROVENANCE_EXIT={CLEAN:0,DIRTY:3,UNKNOWN:4} as const
// `copyPayload()` 复制时**不带走**的条目名（`ignored` 用同一个字面量，见下）。守卫拿它剔掉"改了也进不了包"
// 的文件：不剔的话，改一个测试文件就会把守卫判成 DIRTY —— 那是**假指控**（包内容其实与 HEAD 一致），
// 与本守卫要防的"声明说谎"同形。提到这里只为两侧共用**同一个字面量**，不是新口径。
const PAYLOAD_SKIPPED_NAMES=['node_modules','.git','.runtime','.env','.DS_Store','test','tests','__tests__','fixtures','coverage','__pycache__']
// 与 `copyPayload()` 的扩展名/测试文件跳过规则**同一口径**（那里是 `startsWith('.env')` / `endsWith('.log'|'.tsbuildinfo'|'.pyc'|'.map'|'-evidence.mjs')`
// 与 workspace 的 `\.(test|spec)\.[cm]?[jt]sx?$`）。⚠️ 那两处是内联字面量：谁改了 `copyPayload` 的跳过规则，
// 这里要跟着改（本守卫未覆盖这条漂移，已在回执登记）。
const PAYLOAD_SKIPPED_PATTERN=/(?:^|\/)\.env|\.log$|\.tsbuildinfo$|\.pyc$|\.map$|-evidence\.mjs$|\.(?:test|spec)\.[cm]?[jt]sx?$/
/** porcelain 一行的路径：`XY PATH`（改名是 `R  old -> new`，带特殊字符会被引号包起来）。 */
function porcelainPath(line:string):string{
  const body=line.slice(3)
  const arrow=body.lastIndexOf(' -> ')
  const raw=arrow===-1?body:body.slice(arrow+4)
  return raw.startsWith('"')&&raw.endsWith('"')?raw.slice(1,-1):raw
}
function payloadRelevant(line:string):boolean{
  const path=porcelainPath(line),segments=path.split('/')
  if(segments.some(segment=>PAYLOAD_SKIPPED_NAMES.includes(segment)))return false
  return !PAYLOAD_SKIPPED_PATTERN.test(path)
}
if(values.root!==undefined&&!values['check-source'])throw new Error(`--root 只与 --check-source 同用（守卫自检）：打包根由脚本位置决定、不许改 —— 改了 RELEASE.json 的 sourceCommit 就会指向另一棵树`)
const provenanceRoot=values['check-source']&&values.root!==undefined?resolve(values.root):root
/** 只读 git 子命令；取不到读数（不在检出里 / 没有 git）返回 `null`，由调用方决定 fail-closed 还是如实降级。 */
function porcelainOf(directory:string,paths:readonly string[]):string|null{
  const probe=spawnSync('git',['status','--porcelain','--',...paths],{cwd:directory,encoding:'utf8'})
  return probe.status===0?probe.stdout:null
}
/** 单次快照：HEAD + 全树 porcelain + **载荷相关** porcelain。`worktree` 与门同口径（全树文本的 sha256 前 12 位）。 */
function payloadProvenance(directory:string){
  const headProbe=spawnSync('git',['rev-parse','HEAD'],{cwd:directory,encoding:'utf8'})
  const head=headProbe.status===0?headProbe.stdout.trim():null
  const all=porcelainOf(directory,[]),payload=porcelainOf(directory,PAYLOAD_SCOPE)
  const lines=(text:string|null)=>text===null?null:text.split('\n').filter(Boolean)
  const digest=(text:string|null)=>text===null?null:createHash('sha256').update(text).digest('hex').slice(0,12)
  const changed=lines(all),payloadRaw=lines(payload)
  const payloadChanged=payloadRaw===null?null:payloadRaw.filter(payloadRelevant)
  return {head,changed,payloadRaw,payloadChanged,worktree:digest(all),payloadWorktree:digest(payload),
    verdict:(head===null||changed===null||payloadChanged===null?'UNKNOWN':payloadChanged.length?'DIRTY':'CLEAN') as 'CLEAN'|'DIRTY'|'UNKNOWN'}
}
const provenanceAtStart=payloadProvenance(provenanceRoot)
const provenanceLine=`PROVENANCE HEAD=${(provenanceAtStart.head??'unknown').slice(0,12)} dirty=${provenanceAtStart.changed?.length??-1} worktree=${provenanceAtStart.worktree??'unknown'} payloadDirty=${provenanceAtStart.payloadChanged?.length??-1} payloadScoped=${provenanceAtStart.payloadRaw?.length??-1} payload=${provenanceAtStart.payloadWorktree??'unknown'} verdict=${provenanceAtStart.verdict} scope=[${PAYLOAD_SCOPE.join(' ')}]`
if(values['check-source']){
  // 同步 `writeSync` 后退出：`script/test-ci.ts` 那次"最后一次 write 之后立刻 `process.exit()` ⇒ 经管道
  // **偶发丢收尾行**"是本仓已定性的缺陷（`docs/REMAINING_WORK_PLAN.md` §7.9 ②）。守卫的输出是自检的
  // 唯一读数，不能走那条路。
  writeSync(1,JSON.stringify({phase:'release-provenance',mode:'check-source',root:provenanceRoot,scope:[...PAYLOAD_SCOPE],head:provenanceAtStart.head,changed:provenanceAtStart.changed?.length??null,payloadScoped:provenanceAtStart.payloadRaw?.length??null,payloadChanged:provenanceAtStart.payloadChanged?.length??null,payloadSkipped:(provenanceAtStart.payloadRaw?.length??0)-(provenanceAtStart.payloadChanged?.length??0),worktree:provenanceAtStart.worktree,payloadWorktree:provenanceAtStart.payloadWorktree,verdict:provenanceAtStart.verdict,sample:(provenanceAtStart.payloadChanged??[]).slice(0,10)},null,2)+'\n')
  process.exit(PROVENANCE_EXIT[provenanceAtStart.verdict])
}
const allowDirty=process.env[ALLOW_DIRTY_ENV]==='1'
if(provenanceAtStart.verdict==='UNKNOWN')throw new Error(`无法核实源码提交，拒绝打包：${provenanceLine}`)
if(provenanceAtStart.verdict==='DIRTY'&&!allowDirty)throw new Error(
  `工作树有 ${provenanceAtStart.payloadChanged!.length} 处**载荷相关**未提交改动，拒绝打包（fail-closed）：\n`
  +provenanceAtStart.payloadChanged!.slice(0,10).map(line=>`  ${line}`).join('\n')
  +(provenanceAtStart.payloadChanged!.length>10?`\n  …另有 ${provenanceAtStart.payloadChanged!.length-10} 处（完整清单：\`git status --porcelain -- ${PAYLOAD_SCOPE.join(' ')}\`）`:'')
  +`\n  为什么拒绝：载荷里的 dist 由 script/build-plugins.ts **无条件**从【当前工作树 src】重建，`
  +`而 RELEASE.json 的 sourceCommit 取 \`git rev-parse HEAD\` ⇒ 声明的那条提交里【没有】这些改动，`
  +`用户拿到的是"修复在包里、声明里没有"的包（比不打包更坏：声明会说谎）。\n`
  +`  两条出路：① 先把载荷相关改动提交，再打包（推荐）；`
  +`② 确实要打一个"工作树包"，用 ${ALLOW_DIRTY_ENV}=1 —— RELEASE.json 会写明`
  +`【本包内容不是 sourceCommit 的内容】。\n  ${provenanceLine}`,
)
console.log(provenanceLine)
const product=JSON.parse(await readFile(join(root,'package.json'),'utf8')),lock=JSON.parse(await readFile(join(root,'UPSTREAM_LOCK.json'),'utf8'))
const upstream=resolve(root,lock.directory)
const upstreamReal=await realpath(upstream)
async function fileSha256(path:string){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex')}
if(Boolean(values['mujoco-runtime-archive'])!==Boolean(values['mujoco-runtime-manifest']))throw Error('MuJoCo runtime archive 与 manifest 必须同时指定')
const runtimeInput=values['mujoco-runtime-manifest']?checkedRuntimeManifest(JSON.parse(await readFile(resolve(values['mujoco-runtime-manifest']),'utf8'))):null
if(runtimeInput){const archive=resolve(values['mujoco-runtime-archive']!);if((await stat(archive)).size!==runtimeInput.archive.bytes||await fileSha256(archive)!==runtimeInput.archive.sha256)throw Error('MuJoCo runtime archive 大小/SHA256与manifest不匹配')}
// flock 懒加载不会在首页启动时发现缺件；必须在依赖收闭前从固定 SDK 重建所选 glibc addon。
const nodeRuntime=prepareLinuxNativeSystem(upstream,values.node!)
console.log(JSON.stringify({phase:'native-system-build',node:nodeRuntime.version,command:nodeRuntime.command}))
// 发行时从同一源码重建插件，避免把上次工作树留下的 dist 当作当前候选。
const pluginBuild=spawnSync(process.execPath,['run',join(root,'script/build-plugins.ts')],{cwd:root,stdio:'inherit'})
if(pluginBuild.status!==0)throw new Error('发行插件构建失败，停止打包')
// 原生Web首页是独立Vite产物，插件构建和Host ready不能替代；收闭/复制前始终走其原build脚本。
const frontendBuild=spawnSync('pnpm',['--filter','@deepseek-ai/dsh-web-frontend','run','build'],{cwd:upstream,stdio:'inherit',env:{...process.env,DSH_CLIENT_TITLE:'Lyapunov',DSH_TELEMETRY_DISABLED:'1',HF_ENDPOINT:'https://hf-mirror.com'}})
if(frontendBuild.error)throw frontendBuild.error
if(frontendBuild.status!==0)throw new Error('原生工作台前端构建失败，停止打包')
const frontendProblems=frontendRuntimeViolations(upstream,'')
if(frontendProblems.length)throw new Error(frontendProblems.join('；'))
// 构建器在 Bun 中运行；Bun 的 builtinModules 包含 ws，Node 并不包含。
const builtinProbe=spawnSync(values.node!,['-p','JSON.stringify(require("node:module").builtinModules)'],{encoding:'utf8'})
if(builtinProbe.status!==0)throw new Error('无法读取发行 Node 的内置模块清单')
const builtinModules:string[]=JSON.parse(builtinProbe.stdout)
const name=`lyapunov-dsh-${product.version}-linux-x64`,output=resolve(values.output!),stamp=new Date().toISOString().replaceAll(':','-')
const releaseId=values['release-id']??`${product.version}-${provenanceAtStart.head!.slice(0,12)}-${stamp.replace(/[^0-9TZ]/g,'')}`
if(!/^[-A-Za-z0-9_.]+$/.test(releaseId)||releaseId==='.'||releaseId==='..')throw Error('release-id必须是安全版本标识')
const publicOutput=join(output,'releases',releaseId)
const runtimePublic=runtimeInput?{...runtimeInput,archive:{...runtimeInput.archive,path:`lyapunov-mujoco-linux-x64-${releaseId}.tar.gz`}}:null
await mkdir(join(output,'releases'),{recursive:true})
await mkdir(publicOutput) // 版本化路径不可覆盖；需要另一个release-id才能重发。
const stage=join(output,`staging-${stamp}`,name)
await mkdir(stage,{recursive:true})
const nodes=new Map<string,PackageNode>(),missingOptional:Array<{package:string;dependency:string}>=[]
// 上游树里的自指链接（`<包目录>/<包名>` 经开发检出 node_modules 绕回该包目录自身）相对目标为空串，
// `symlink('')` 直接 ENOENT；即便写进载荷也只是自环。跳过并记账，不带进发行包。
const skippedSelfLinks:string[]=[]
// 同一形状的链也会落在**依赖收闭**这一路：开发检出的 `node_modules/<scope>/<scope>`（本机实测 `@lyapunov/@lyapunov`）
// 经 realpath 落回它所在的 scope 目录自己，而那里没有 package.json ⇒ `collect()` 崩在裸 ENOENT 上，
// 报错里看不出"是链的问题"（2026-09-26 归档候选构建 0.47s 失败现场）。判据与 P10 的 D2 相同
// （`realpath(链接) === realpath(它所在目录)`），处置与上面的 copyPayload 同形：跳过 + 记账。
// 两处分列记账：`.upstream/**` 里的（载荷复制阶段）与 scope 目录里的（依赖收闭阶段）各自可查，不混成一个数。
const skippedSelfLinksInClosure:string[]=[]
type Manifest={name:string;version?:string;license?:unknown;dependencies?:Record<string,string>;optionalDependencies?:Record<string,string>;peerDependencies?:Record<string,string>;peerDependenciesMeta?:Record<string,{optional?:boolean}>;bin?:string|Record<string,string>}
type PackageNode={source:string;destination:string;manifest:Manifest;dependencies:Map<string,PackageNode>}
const ignored=new Set(PAYLOAD_SKIPPED_NAMES)
const workspaceDestination=(source:string)=>workspacePayloadDestination({root,upstreamReal,upstreamDirectory:lock.directory,source})
function workspace(source:string){return workspaceDestination(source)!==null}
async function locate(name:string,from:string){
  let dir=from
  for(;;){const found=join(dir,'node_modules',name);if(existsSync(join(found,'package.json')))return realpath(found);const parent=dirname(dir);if(parent===dir)break;dir=parent}
  throw new Error(`${from} 无法解析运行依赖 ${name}`)
}
/** 自指链接判据（P10 D2 原文）：`realpath(链接) === realpath(它所在的目录)` ⇒ 相对目标为空串，没有可交付语义。 */
async function resolvesToOwnParent(entry:string):Promise<boolean>{
  try{return await realpath(entry)===await realpath(dirname(entry))}catch{return false}
}
/** 读包清单：读不到就点名**是哪个路径**读不到，而不是把裸 ENOENT 抛给用户（裸 ENOENT 看不出是链的问题）。 */
async function manifestOf(source:string):Promise<Manifest>{
  const file=join(source,'package.json')
  try{return JSON.parse(await readFile(file,'utf8')) as Manifest}
  catch(error){
    if(error instanceof SyntaxError)throw new Error(`包清单不是合法 JSON：${relative(root,file)}`)
    const code=(error as {code?:string})?.code??String(error)
    throw new Error(`不是可收集的包：${relative(root,source)}（读 ${relative(root,file)} 失败：${code}）—— 自指/悬空/畸形链接请先修好环境`)
  }
}
async function collect(source:string):Promise<PackageNode|null>{
  // 自指链接（scope 目录里 `<scope>/<scope>` 这种退化条目）：没有可交付语义（写进载荷只是自环），跳过并记账。
  if(await resolvesToOwnParent(source)){skippedSelfLinksInClosure.push(relative(root,source));return null}
  source=await realpath(source);const prior=nodes.get(source);if(prior)return prior
  const manifest:Manifest=await manifestOf(source)
  // 保留标准 node_modules/<包名> 布局，原生依赖（如 sharp/libvips）的 RPATH 据此定位兄弟包。
  const destination=workspaceDestination(source)??join('.modules',`${manifest.name.replaceAll('/','+')}@${manifest.version??'0'}-${nodes.size}`,'node_modules',manifest.name)
  const node={source,destination,manifest,dependencies:new Map<string,PackageNode>()};nodes.set(source,node)
  const dependencies={...manifest.peerDependencies,...manifest.dependencies,...manifest.optionalDependencies}
  for(const name of Object.keys(dependencies).sort()){
    if(name==='electron'||builtinModules.includes(name)||name.startsWith('node:'))continue
    const optional=name in (manifest.optionalDependencies??{})||manifest.peerDependenciesMeta?.[name]?.optional===true
    let path:string
    try{path=await locate(name,source)}catch(error){if(optional){missingOptional.push({package:manifest.name,dependency:name});continue}throw error}
    node.dependencies.set(name,await requirePackage(path))
  }
  return node
}
/** 依赖路径上的必得解析：`locate()` 已确认目标有 package.json，真落到自指链接上就是"依赖真的缺了"，
 *  点名 fail-closed —— 跳过只用于 scope 枚举里那种本来就没有交付语义的退化条目。 */
async function requirePackage(source:string):Promise<PackageNode>{
  const node=await collect(source)
  if(node===null)throw new Error(`依赖解析落在自指链接上：${relative(root,source)}（它解析回自己所在的目录，那里没有 package.json）`)
  return node
}
const rootLinks=new Map<string,PackageNode>()
for(const scope of ['@deepseek-ai','@lyapunov']){
  const dir=join(root,'node_modules',scope)
  for(const item of (await readdir(dir)).sort()){
    const node=await collect(join(dir,item));if(node===null)continue   // 自指链接：collect() 已记账并跳过
    rootLinks.set(node.manifest.name,node)
  }
}
for(const item of (await readdir(join(root,'packages'))).sort()){
  const dir=join(root,'packages',item);if(!existsSync(join(dir,'package.json')))continue
  const node=await requirePackage(dir);rootLinks.set(node.manifest.name,node)
}
for(const name of Object.keys(product.dependencies??{}))rootLinks.set(name,await requirePackage(await locate(name,root)))
console.log(JSON.stringify({phase:'dependency-closure',packages:nodes.size,missingOptional:missingOptional.length,skippedSelfLinksInClosure:skippedSelfLinksInClosure.length,stage}))

async function copyPayload(source:string,destination:string){
  await mkdir(destination,{recursive:true})
  for(const item of await readdir(source,{withFileTypes:true})){
    if(ignored.has(item.name)||item.name.startsWith('.env')||item.name.endsWith('.log')||item.name.endsWith('.tsbuildinfo')||item.name.endsWith('.pyc')||item.name.endsWith('.map')||item.name.endsWith('-evidence.mjs'))continue
    const src=join(source,item.name),dest=join(destination,item.name)
    if(workspace(src)&&/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(item.name))continue
    if(item.isDirectory()){await copyPayload(src,dest);continue}
    if(item.isSymbolicLink()){
      const target=await realpath(src),inside=relative(source,target)
      // 自指链接（解析回本复制根）没有可交付语义：跳过并记账；越界链接仍 fail-closed。
      const linkTarget=payloadLinkTarget({inside,destination,dest,source:src})
      if(linkTarget===null){skippedSelfLinks.push(relative(root,src));continue}
      await symlink(linkTarget,dest);continue
    }
    if(item.isFile())await cp(src,dest)
  }
}
async function link(linkPath:string,target:string){await mkdir(dirname(linkPath),{recursive:true});await symlink(relative(dirname(linkPath),target),linkPath)}
async function countFiles(directory:string){let total=0;for(const item of await readdir(directory,{withFileTypes:true})){if(item.isDirectory())total+=await countFiles(join(directory,item.name));else if(item.isFile())total++}return total}
for(const node of nodes.values())await copyPayload(node.source,join(stage,node.destination))
for(const node of nodes.values()){
  const dir=join(stage,node.destination)
  const moduleDir=workspace(node.source)?join(dir,'node_modules'):resolve(dir,...node.manifest.name.split('/').map(()=> '..'))
  for(const [name,target] of node.dependencies){
    await link(join(moduleDir,name),join(stage,target.destination))
    const bins=typeof target.manifest.bin==='string'?{[basename(target.manifest.name)]:target.manifest.bin}:target.manifest.bin??{}
    for(const [bin,path] of Object.entries(bins)){
      const dest=join(moduleDir,'.bin',bin)
      if(!existsSync(dest)&&existsSync(join(stage,target.destination,path)))await link(dest,join(stage,target.destination,path))
    }
  }
}
for(const [name,node] of rootLinks)await link(join(stage,'node_modules',name),join(stage,node.destination))
// 发行根清单名必须是产品安装身份 `lyapunov-dsh`：`script/product-link.ts:42` 的归属判定要求
// 既有安装根的 `package.json.name === 'lyapunov-dsh'`（悬空链接才走恢复分支）。写 worktree 的
// `product.name`（`lyapunov`）会让该判定对**任何真实发行安装**都不成立——于是"换目录解包新版本 +
// 指向旧版本运行根"的升级会在 PRODUCT_PACKAGE_CONFLICT 上失败关闭（实测原链接被保留）。
// 发行产物名（`lyapunov-dsh-<版本>-linux-x64`）、目录名与判定用的都是同一身份串，这里对齐。
await writeFile(join(stage,'package.json'),JSON.stringify({name:'lyapunov-dsh',version:product.version,license:product.license,private:true,type:'module'},null,2)+'\n')
await cp(join(root,'UPSTREAM_LOCK.json'),join(stage,'UPSTREAM_LOCK.json'))
for(const file of ['LICENSE','NOTICE','README.md','README.zh-CN.md'])await cp(join(root,file),join(stage,file))
await cp(join(upstream,'LICENSE'),join(stage,'DSH-LICENSE'))
await mkdir(join(stage,lock.directory),{recursive:true})
await writeFile(join(stage,lock.directory,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-root',private:true,type:'module',version:lock.version},null,2))

await mkdir(join(stage,'runtime/node/bin'),{recursive:true});await cp(nodeRuntime.executable,join(stage,'runtime/node/bin/node'))
const nodeLicense=join(dirname(dirname(nodeRuntime.executable)),'LICENSE');if(!existsSync(nodeLicense))throw new Error('Node 运行时缺少随附许可证')
await cp(nodeLicense,join(stage,'runtime/node/LICENSE'))
const require=createRequire(join(root,'packages/desktop/package.json')),electronPackage=dirname(require.resolve('electron/package.json')),electron=JSON.parse(await readFile(join(electronPackage,'package.json'),'utf8')).version
await cp(join(electronPackage,'dist'),join(stage,'runtime/electron'),{recursive:true,dereference:false})
// 开发安装可能把已授权helper链接到旧安装。发行只复制helper本体，不能带走包外绝对链或旧授权。
await rm(join(stage,'runtime/electron/chrome-sandbox'),{force:true})
await cp(join(electronPackage,'dist/chrome-sandbox'),join(stage,'runtime/electron/chrome-sandbox'),{dereference:true})
await chmod(join(stage,'runtime/electron/chrome-sandbox'),0o755)
const electronExecutable=existsSync(join(stage,'runtime/electron','electron'))?'electron':'lyapunov-desktop'
if(electronExecutable!=='lyapunov-desktop')await rename(join(stage,'runtime/electron',electronExecutable),join(stage,'runtime/electron/lyapunov-desktop'))
if(existsSync(join(stage,'runtime/electron/resources/default_app.asar')))await rm(join(stage,'runtime/electron/resources/default_app.asar'))
await rm(join(stage,'runtime/electron/resources/app'),{recursive:true,force:true})
await link(join(stage,'runtime/electron/resources/app'),join(stage,'packages/desktop'))
await mkdir(join(stage,'runtime/micromamba'),{recursive:true})
await cp(values.micromamba!,join(stage,'runtime/micromamba/micromamba'))
const mambaVersion=spawnSync(values.micromamba!,['--version'],{encoding:'utf8'});if(mambaVersion.status!==0)throw new Error('micromamba 无法运行')
const mambaVersionText=mambaVersion.stdout.trim()
const licenseUrl=mambaLicenseUrl(mambaVersionText)
// 许可证必须在包里，所以最终取不到就 fail-closed；但**不能无限等**：2026-09-26 构建 #2 在这里
// 静默挂了 5 分钟才以 TimeoutError 失败（前 6 秒已完成全部拷贝）。保留有界重试，失败时报出
// URL 与每次尝试的原因，不再把"网络抖动"变成一次 5 分钟无输出的失败。
// 2026-09-26（W16）：它同时是**打包链唯一的联网点**——同一 URL 取证时先 200/0.93s、紧接着
// 0 字节超时；对没有网络的客户 CI 这不是"偶发慢"而是"打包直接失败"。于是取件顺序改为
// env 覆盖（LYAPUNOV_MAMBA_LICENSE）→ 随包入库件 distribution/licenses/ → .runtime/licenses 缓存
// → **这个网络兜底**；顺序、身份校验（sha256 对不上即 fail-closed）与缓存回写都在
// distribution/licenses/mamba-license.ts，本函数退为兜底，不再是主路径。
async function fetchMambaLicense(url:string){
  const attempts=3,errors:string[]=[]
  for(let attempt=1;attempt<=attempts;attempt++){
    try{
      const response=await fetch(url,{signal:AbortSignal.timeout(30_000)})
      if(!response.ok)throw new Error('HTTP '+response.status)
      return await response.text()
    }catch(error){errors.push(`第 ${attempt} 次：${(error as Error)?.message??String(error)}`)}
  }
  throw new Error(`无法取得当前 micromamba 许可证（${attempts} 次尝试均失败）：${url}；${errors.join('；')}`)
}
const mambaLicense=await resolveMambaLicense({version:mambaVersionText,root,url:licenseUrl,env:process.env,fetchLicense:()=>fetchMambaLicense(licenseUrl)})
// 交付闸门（2026-09-26 验收 §C1）：`hashMatchesPin` 是**三态**（true/false/null），`null` 不是"通过"。
// 这份许可证要写进发行载荷、是随包分发的法律产物，所以"验不了身份"必须等于"不进包"——
// 一份 62 B 的假文本曾经就是靠 meta.json 缺失 ⇒ 校验恒真 ⇒ 被正常采用、构建继续。
// 唯一例外是 LYAPUNOV_MAMBA_LICENSE（操作者**显式**指定，W16 语义为"原样采用 + 如实报告"）；
// 连它也必须把"身份未证实"喊出来，不许静默。判定逻辑在 distribution/licenses/mamba-license.ts。
const licenseIdentity=mambaLicenseIdentityVerdict(mambaLicense)
if(!licenseIdentity.adoptable)throw new Error(
  `许可证身份未被证实，拒绝把它写进发行载荷（fail-closed）：${licenseIdentity.problem}\n`
  +`  取件来源：${mambaLicense.source}（${mambaLicense.source==='network'?mambaLicense.location:relative(root,mambaLicense.location)}）\n`
  +`  实际内容：sha256=${mambaLicense.sha256}，${mambaLicense.bytes} B\n`
  +`  处置建议：把该件与 ${mambaLicenseFileName(mambaVersionText)}.meta.json 一起入库（sha256/字节/SPDX/来源/tag/commit），`
  +`或用 ${MAMBA_LICENSE_ENV} 指向一份你确认过的副本（该变量是操作者显式覆盖，采用时只如实报告身份是否一致）。`,
)
if(!licenseIdentity.verified)console.error(JSON.stringify({phase:'micromamba-license-identity-unverified',disposition:licenseIdentity.disposition,source:mambaLicense.source,location:mambaLicense.source==='network'?mambaLicense.location:relative(root,mambaLicense.location),sha256:mambaLicense.sha256,pinnedSha256:mambaLicense.pinnedSha256,problem:licenseIdentity.problem}))
console.log(JSON.stringify({phase:'micromamba-license',version:mambaLicense.version,source:mambaLicense.source,location:mambaLicense.location,spdx:mambaLicense.spdx,sha256:mambaLicense.sha256,bytes:mambaLicense.bytes,hashMatchesPin:mambaLicense.hashMatchesPin,cached:mambaLicense.cached}))
await writeFile(join(stage,'runtime/micromamba/LICENSE'),mambaLicense.text)
// 入 RELEASE.json 的是**身份与出处**（不含正文、不含构建机绝对路径），让"这份许可证是谁、从哪来"可查；
// 身份不可核验时连**原因**一起记（`pinProblem` 只在登记身份不可用时出现，正常路径的字段与改动前逐字相同）。
const mambaLicenseRecord={version:mambaLicense.version,spdx:mambaLicense.spdx,url:mambaLicense.url,source:mambaLicense.source,location:mambaLicense.source==='network'?mambaLicense.location:relative(root,mambaLicense.location),payloadLocation:'runtime/micromamba/LICENSE',sha256:mambaLicense.sha256,bytes:mambaLicense.bytes,pinnedSha256:mambaLicense.pinnedSha256,hashMatchesPin:mambaLicense.hashMatchesPin,cached:mambaLicense.cached,...(mambaLicense.pinProblem?{pinProblem:mambaLicense.pinProblem}:{})}

await mkdir(join(stage,'distribution/linux'),{recursive:true})
for(const file of ['README.md','doctor.mjs','sandbox.mjs','install-provider','policy-cpu.mjs','lyapunov-desktop.desktop.in','install.sh','install-entry.mjs'])await cp(join(root,'distribution/linux',file),join(stage,'distribution/linux',file))
// 随包分发的可选 Provider 定义：`distribution/providers/graspgenx/` 是**产品的可选 Provider 定义**
// （用户据此自建 worker，`packages/grasp-graspgenx/README.md` 与 `distribution/linux/README.md` 都指向它），
// 不是服务端内容，必须随产品分发。缺失即 fail-closed 停止打包，拷入后在 RELEASE.json 如实登记。
const bundledProviders=[{name:'graspgenx',source:join(root,'distribution/providers/graspgenx')}]
const bundledProviderFiles=new Map<string,number>()
for(const provider of bundledProviders){
  if(!existsSync(join(provider.source,'provider.sh')))throw new Error(`随包可选 Provider 定义缺失或损坏：${relative(root,provider.source)}/provider.sh`)
  const destination=join(stage,'distribution/providers',provider.name)
  await copyPayload(provider.source,destination)
  bundledProviderFiles.set(provider.name,await countFiles(destination))
}
const providerProblems=bundledProviderViolations({required:bundledProviders.map(provider=>provider.name),present:bundledProviderFiles})
if(providerProblems.length)throw new Error('发行载荷 Provider 定义契约不成立：'+providerProblems.join('；'))
await cp(join(root,'distribution/linux/lyapunov'),join(stage,'lyapunov'))
for(const path of ['lyapunov','distribution/linux/install-provider','runtime/node/bin/node','runtime/micromamba/micromamba'])await chmod(join(stage,path),0o755)
const buildEntries=[
  {entry:'packages/desktop/src/main.ts',output:'packages/desktop/dist/main.js',target:'node',format:'esm',external:['electron','electron-store','electron-window-state','electron-updater','@deepseek-ai/*']},
  {entry:'packages/desktop/src/preload.ts',output:'packages/desktop/dist/preload.cjs',target:'node',format:'cjs',external:['electron']},
  {entry:'packages/desktop/src/account-view.tsx',output:'packages/desktop/renderer/account.js',target:'browser',format:'iife',external:[]},
  {entry:'distribution/linux/physics-check.ts',output:'distribution/linux/physics-check.js',target:'node',format:'esm',external:['@deepseek-ai/*']},
  {entry:'script/host.ts',output:'distribution/linux/host.js',target:'node',format:'esm',external:['@deepseek-ai/*']},
  {entry:'script/administrator.ts',output:'distribution/linux/administrator.js',target:'node',format:'esm',external:['@deepseek-ai/*']},
  {entry:'script/architecture.ts',output:'distribution/linux/architecture.js',target:'node',format:'esm',external:['@deepseek-ai/*']},
  {entry:'script/terminal.ts',output:'distribution/linux/terminal.js',target:'node',format:'esm',external:['@deepseek-ai/*']},
  {entry:'script/benchmark.ts',output:'distribution/linux/benchmark.js',target:'node',format:'esm',external:['@deepseek-ai/*']},
] as const
for(const item of buildEntries){
  // Bun.build 会把 process.env.NODE_ENV 在构建期内联为构建机取值；node 入口必须以自引用 define
  // 保留运行时读取（script/profile.ts 用它在正式构建中拒绝开发模式），否则判据会恒为构建机值。
  const result=await Bun.build({entrypoints:[join(root,item.entry)],target:item.target,format:item.format,external:[...item.external],minify:false,define:{'process.env.NODE_ENV':item.target==='browser'?JSON.stringify('production'):'process.env.NODE_ENV'}})
  if(!result.success)throw new AggregateError(result.logs,`发行构建失败 ${item.entry}`)
  await mkdir(dirname(join(stage,item.output)),{recursive:true});await writeFile(join(stage,item.output),await result.outputs[0]!.text())
}
// 顶层入口契约：载荷顶层只允许**一个**可执行入口（`lyapunov`）。留两份入口＝同一运行根上存在两个
// 可启动 owner，升级/回退会退化成"谁最后启动谁改托管链接"；这里在写清单与归档前 fail-closed。
const topLevel:PayloadTopLevelRow[]=[]
for(const item of await readdir(stage,{withFileTypes:true}))topLevel.push({name:item.name,directory:item.isDirectory(),executable:item.isFile()&&((await stat(join(stage,item.name))).mode&0o111)!==0})
const entryProblems=entryViolations(topLevel)
if(entryProblems.length)throw new Error('发行载荷入口契约不成立：'+entryProblems.join('；'))
// 在真实 staging 上逐件核验，漏复制时归档前直接失败。
const sandboxProblems=sandboxRuntimeViolations(stage)
if(sandboxProblems.length)throw new Error(sandboxProblems.join('；'))
const productProblems=productRuntimeViolations(stage,lock.directory)
if(productProblems.length)throw new Error(productProblems.join('；'))
const topLevelExecutables=topLevel.filter(row=>!row.directory&&row.executable).map(row=>row.name).sort()
// 上游 TS/source 条件不用于发行进程，完整保留已构建 lib、原生资源和许可证。
const records=[...nodes.values()].map(node=>({name:node.manifest.name,version:node.manifest.version,license:node.manifest.license??null,path:node.destination})).sort((a,b)=>a.name.localeCompare(b.name))
// 出处取数：**同一个函数**在打包末尾再取一次快照。两次不同 ⇒ 打包期间有人写了树，载荷是**两棵树拼的**
// （本仓实测：`dist` 的 stale 读数 6 分 42 秒内从 0 变 4 —— `bugfixHistory/VERIFY-DIST-PRODUCT-20260927.md` §5.3）。
// 那次变化不能靠"开工时干净"掩盖，所以这里 fail-closed；`${ALLOW_DIRTY_ENV}=1` 时如实记下两个快照而不拦。
const provenanceAtWrite=payloadProvenance(root)
if(provenanceAtWrite.verdict==='UNKNOWN')throw new Error('打包收尾无法核实源码提交，拒绝出包')
const provenanceMoved=provenanceAtStart.head!==provenanceAtWrite.head||provenanceAtWrite.worktree!==provenanceAtStart.worktree
const writeLine=`PROVENANCE HEAD=${(provenanceAtWrite.head??'unknown').slice(0,12)} dirty=${provenanceAtWrite.changed?.length??-1} worktree=${provenanceAtWrite.worktree??'unknown'} payloadDirty=${provenanceAtWrite.payloadChanged?.length??-1} payloadScoped=${provenanceAtWrite.payloadRaw?.length??-1} payload=${provenanceAtWrite.payloadWorktree??'unknown'} verdict=${provenanceAtWrite.verdict} scope=[${PAYLOAD_SCOPE.join(' ')}]`
if(provenanceMoved&&!allowDirty)throw new Error(
  `打包期间工作树变了 ⇒ 载荷不是任何单一状态的函数，拒绝出包（fail-closed）：\n  开工 ${provenanceLine}\n  收尾 ${writeLine}\n`
  +`  处置：让并发的写手停下（或先提交），再重打一次；确实要留这个包，用 ${ALLOW_DIRTY_ENV}=1 并如实登记两个快照。`,
)
const sourceCommit=provenanceAtWrite.head
const release={product:'LyapunovDSH',version:product.version,license:product.license,releaseId,platform:'linux-x64',sourceCommit,sourceCommitResolution:sourceCommit?'git rev-parse HEAD':'unavailable outside a Git checkout',builtAt:new Date().toISOString(),node:nodeRuntime.version,electron,micromamba:mambaVersion.stdout.trim(),upstreamCommit:lock.commit,packages:records,missingOptional,defaultMuJoCo:runtimePublic?{mode:'conda-pack',runtime:runtimePublic}:{mode:'install-provider'},providersBundled:bundledProviders.map(provider=>({name:provider.name,path:`distribution/providers/${provider.name}`,files:bundledProviderFiles.get(provider.name)??0})),entry:PRODUCT_ENTRY,topLevelExecutables,skippedSelfLinks,skippedSelfLinksInClosure,userDataBundled:false,
// 出处守卫的读数（ARCHIVE-SOURCECOMMIT-HONESTY）——**这一格就是"声明"**：
// `sourceCommitMatchesPayload` 明说"本包内容是不是 sourceCommit 的内容"；`false` 时**必须**能一眼看出
// 本包不是从那条提交构建的（改前产物里没有这一格，所以 2026-09-26 那次"包内容 ← 工作树 / 声明 ← HEAD"
// 在包里完全隐形）。`worktree`/`payload` 与 release-gate 的 `worktree=` 同一口径，供回执锚定版本。
sourceCommitMatchesPayload:provenanceAtStart.verdict==='CLEAN'&&!provenanceMoved,
worktreeProvenance:{scope:[...PAYLOAD_SCOPE],changed:provenanceAtWrite.changed?.length??null,payloadScoped:provenanceAtWrite.payloadRaw?.length??null,payloadChanged:provenanceAtWrite.payloadChanged?.length??null,worktree:provenanceAtWrite.worktree,payloadWorktree:provenanceAtWrite.payloadWorktree,startWorktree:provenanceAtStart.worktree,movedDuringPackaging:provenanceMoved,sample:(provenanceAtStart.payloadChanged??[]).slice(0,10),dirtyOverride:allowDirty?ALLOW_DIRTY_ENV:null},
// 随包法律产物的来源与身份：从入库件、缓存、环境变量覆盖还是网络取到，sha256 一并入册，
// 让"这份许可证是谁、从哪来"在产物里可查，而不是只有一句"包里有 LICENSE"。
micromambaLicense:mambaLicenseRecord}
await writeFile(join(stage,'RELEASE.json'),JSON.stringify(release,null,2)+'\n')
const symlinks:Array<{path:string;target:string}>=[]
// 发行包只携带代码和许可证；用户凭据、运行时状态和模型权重必须在包外。
// 这里在 staging 阶段 fail-closed，而不是只依赖归档后的人工扫描。
const forbiddenName=/^(?:auth|credentials?|secrets?|session-secrets)\.(?:json|ya?ml|toml|env|db|sqlite)$/i
const forbiddenExtension=/\.(?:pt|pth|ckpt|safetensors|onnx|gguf|npz|npy|engine|plan|pem|key|token)$/i
async function verify(dir:string){for(const item of await readdir(dir,{withFileTypes:true})){const path=join(dir,item.name)
  const relPath=relative(stage,path)
  if(item.isFile()&&(forbiddenName.test(item.name)||forbiddenExtension.test(item.name)))throw new Error(`发行包包含禁止的凭据/模型文件：${relPath}`)
  if(item.isSymbolicLink()){const target=await readlink(path),actual=await realpath(path),rel=relative(stage,actual);if(isAbsolute(target)||rel==='..'||rel.startsWith('../'))throw new Error('发行包链接越界：'+relative(stage,path));symlinks.push({path:relative(stage,path),target})}
  else if(item.isDirectory()){if(item.name==='.runtime'||item.name==='session-secrets')throw new Error('禁止把用户/运行数据加入发行包');await verify(path)}
}}
await verify(stage)
await writeFile(join(output,`package-${stamp}.json`),JSON.stringify({status:'BUILT_NOT_RUNTIME_VERIFIED',stage,packages:nodes.size,relativeSymlinks:symlinks.length,missingOptional,
// 构建回执带上出处：回执/门引用这个包时，"它是从哪一版树来的"跟着一起走（§7.17 ② 的零成本锚定）。
provenance:{head:provenanceAtWrite.head,changed:provenanceAtWrite.changed?.length??null,payloadChanged:provenanceAtWrite.payloadChanged?.length??null,worktree:provenanceAtWrite.worktree,payloadWorktree:provenanceAtWrite.payloadWorktree,verdict:provenanceAtWrite.verdict,sourceCommitMatchesPayload:release.sourceCommitMatchesPayload,movedDuringPackaging:provenanceMoved}},null,2))
const archive=join(publicOutput,`lyapunov-linux-x64-${releaseId}.tar.gz`),pendingArchive=archive+'.partial-'+stamp
const nativeProblems=nativeSystemRuntimeViolations(stage,lock.directory)
if(nativeProblems.length)throw new Error(nativeProblems.join('；'))
const tar=spawnSync('tar',['-czf',pendingArchive,'-C',dirname(stage),name],{stdio:'inherit'})
if(tar.status!==0)throw new Error('tar 打包失败')
await rename(pendingArchive,archive)
if(runtimePublic)await cp(resolve(values['mujoco-runtime-archive']!),join(publicOutput,runtimePublic.archive.path))
const downloadManifest:LinuxReleaseManifest=checkedReleaseManifest({schema:1,releaseId,version:product.version,platform:'linux-x64',minimumGlibc:'2.28',sourceCommit:sourceCommit!,archiveRoot:name,archive:{path:basename(archive),sha256:await fileSha256(archive),bytes:(await stat(archive)).size},mujoco:runtimePublic?{mode:'conda-pack',runtime:runtimePublic}:{mode:'install-provider'}})
for(const [extension,text] of [['json',JSON.stringify(downloadManifest,null,2)+'\n'],['tsv',releaseManifestTsv(downloadManifest)]])await writeFile(join(publicOutput,`linux-x64.${extension}`),text)
await mkdir(join(output,'releases/latest'),{recursive:true})
for(const extension of ['json','tsv'])await cp(join(publicOutput,`linux-x64.${extension}`),join(output,'releases/latest',`linux-x64.${extension}`))
await cp(join(root,'distribution/linux/install.sh'),join(output,'install.sh'))
console.log(JSON.stringify({status:'BUILT_NOT_RUNTIME_VERIFIED',archive,bytes:downloadManifest.archive.bytes,sha256:downloadManifest.archive.sha256,releaseId,downloadManifest:join(publicOutput,'linux-x64.json'),mujoco:downloadManifest.mujoco,stage,packages:nodes.size,relativeSymlinks:symlinks.length,sourceCommit:provenanceAtWrite.head,sourceCommitMatchesPayload:release.sourceCommitMatchesPayload,worktree:provenanceAtWrite.worktree,payloadWorktree:provenanceAtWrite.payloadWorktree,payloadChanged:provenanceAtWrite.payloadChanged?.length??null}))
console.log(writeLine)
