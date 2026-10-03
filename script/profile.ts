import { appendFile, lstat, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve, sep } from "node:path"
import {existsSync,readFileSync,realpathSync} from "node:fs"
import { runtimePaths, ensureWorkspaceMapping, RUNTIME_ENV, LEGACY_RUNTIME_ENV, FASTGS_RUNTIME_ENV_KEYS, readRuntimeEnv, RUNTIME_NAME, type RunMode } from "../packages/lyapunov-product-bundle/src/runtime-paths.ts"
import { SDK_PYTHON_ENV } from "../packages/lyapunov-product-bundle/src/sdk-python.mjs"
import { IMAGE_DEVELOPER_ENV_KEYS } from "../packages/generate-image/src/provider.ts"
import { TRIPO_DEVELOPER_ENV_KEYS } from "../packages/generate-tripo/src/provider.ts"
import { HUNYUAN_DEVELOPER_ENV_KEYS } from "../packages/generate-hunyuan/src/provider.ts"
import { MARBLE_DEVELOPER_ENV_KEYS } from "../packages/generate-marble/src/provider.ts"
import type {VerifiedAccount} from "../packages/lyapunov-product-bundle/src/account/formal.ts"
import {linkProductPackage,reconcileProductPackageLinks} from './product-link.ts'
import {migrateLegacyProfile,type LegacyProfileMigration} from './profile-migration.ts'
import {migrateRuntimeLayout} from './migrate-workspace-layout.ts'
import {healProfilesModuleFallback} from '@deepseek-ai/dsh-app-boot'

function productRoot(){
  let directory=resolve(readRuntimeEnv(process.env,"productRoot")??import.meta.dirname)
  while(!existsSync(join(directory,"UPSTREAM_LOCK.json"))){
    const parent=dirname(directory)
    if(parent===directory)throw new Error("找不到LyapunovDSH安装根目录")
    directory=parent
  }
  return directory
}
export const PRODUCT_ROOT = productRoot()
export const UPSTREAM = resolve(PRODUCT_ROOT, JSON.parse(readFileSync(join(PRODUCT_ROOT, "UPSTREAM_LOCK.json"), "utf8")).directory)
export const DSH_BIN = join(UPSTREAM, "apps/cli/lib/bin.js")

/**
 * 为一次 Host 实验解析运行根目录。
 *
 * 默认 Host 继续使用原有持久路径；实验调用方显式指定 runtimeRoot 或 hostId，
 * 让 DSH_HOME、Scene 和插件目录一起隔离。端口只决定监听地址，不参与数据身份。
 */
export function hostRuntimeRoot(input: { engine?: string; runtimeRoot?: string; hostId?: string }) {
  if (input.runtimeRoot) return resolve(input.runtimeRoot)
  if (input.hostId !== undefined) {
    const id = input.hostId.trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("Host ID 必须以字母或数字开头，只能包含字母、数字、点、下划线和连字符")
    return join(PRODUCT_ROOT, ".runtime/hosts", id)
  }
  return input.engine === "benchmark" ? join(PRODUCT_ROOT, ".runtime/product-benchmark") : undefined
}

/* ---------------------------------------------------------------------------------------------------
 * 托管链接切换的播报 + **归属普查**
 *
 * 事故与修复（`bugfixHistory/RELEASE-UPGRADE-20260926.md` §7、`RUNTIME-PATCH-LINK-AUDIT-20260926.md`）：
 * `reconcileProductPackageLinks()` 一直返回 `{updated,removed}`，唯一调用点把它丢掉了 ⇒ 已退场旧安装
 * 对同一运行根启动时静默改指、exit 0、无告警。
 *
 * 修复落地后由验收队实测（`bugfixHistory/VERIFY-RUNTIME-PATCH-LINKS-20260926.md` §4/§5）指出：那次现场
 * 的 **317 条**里只有 **33 条改指 + 4 条清理**流经本函数，其余 **284 条**由上游 DSH 自己的 profile
 * fallback linker（`$DSH_HOME/profiles/node_modules` 那面依赖镜像）改指，本产品一个字没碰。
 * ⇒ 只打"本次改指了 33 条"，会被读成"这次一共就动了 33 条"。
 *
 * 所以本节的输出分两层，**层与层之间不混算**：
 *  · 本函数管辖的改动：`{updated,removed}` 逐条点名（唯一的"改了什么"真值）；
 *  · 不归本函数的范围：同级目录的**当前归属普查**——只数"现在指向谁"，**不声称谁在什么时候改的**
 *    （那发生在别的进程里，本函数没有观测点）。
 * 认不出归属的目标一律记"归属未识别"，不猜一个安装根。
 * ------------------------------------------------------------------------------------------------- */

/** `reconcileProductPackageLinks()` 的改动清单：`updated`＝本次被改指到**当前安装**的包名，`removed`＝当前安装不再提供的槽位。 */
export type ProductLinkSwitchReport={updated:string[];removed:string[]}

/** 一次链接切换的播报内容。0 改动（且不归本函数的那些也没指向别处）时 `lines` 为**空数组**（不制造噪声），`audit` 同时缺省。 */
export type ProductLinkSwitchNotice={lines:string[];audit?:string}

/** 改动审计文件名：与 `script/product-link.ts` 的 `lyapunov-link-recovery.jsonl` 同目录、同 JSONL 形状。 */
export const PRODUCT_LINK_SWITCH_AUDIT="lyapunov-link-switch.jsonl"

/** 一个目录下**软链**的归属普查。只读、只报告：不判定所有权、不改任何链接、不声称改动来源。 */
export type ModuleLinkScopeCensus={directory:string;total:number;currentInstall:number;otherInstall:number;otherRoots:string[]}

/** 播报里的范围说明：`inScope`＝本函数管辖的 Profile 槽位目录；`outOfScope`＝不归本函数的同级目录。 */
export type ProductLinkSwitchScope={inScope?:ModuleLinkScopeCensus;outOfScope?:ModuleLinkScopeCensus}

/**
 * 从一个链接目标文本认出"它属于哪个安装根"。
 * 只认本产品真实存在的两种形状（`<根>/.upstream/**`、`<根>/packages/**`）；认不出返回空串
 * ——**宁可说"归属未识别"，也不猜一个根**。
 */
export function installRootOfLinkTarget(target:string):string{
 const value=resolve(target)
 const upstream=value.indexOf(`${sep}.upstream${sep}`)
 if(upstream>0)return value.slice(0,upstream)
 const packages=value.lastIndexOf(`${sep}packages${sep}`)
 if(packages>0)return value.slice(0,packages)
 return ""
}

/**
 * 普查一个 `node_modules` 目录（自身 + 一层 `@scope`，与产品自己的枚举口径一致：不沿符号链接递归）里的软链，
 * 按"指向本次安装 / 指向别处"归类。
 *
 * **这是归属读数，不是改动读数。** 归本函数的槽位切换由 `reconcileAndReportProductLinks()` 的
 * `{updated,removed}` 逐条给出；同级目录（`<DSH_HOME>/profiles/node_modules`）由上游 DSH 的
 * profile fallback linker 维护，那里**发生了什么本函数观测不到**，所以只报范围与当前归属、不报改动。
 */
export async function censusModuleLinkScope(input:{directory:string;installRoot:string}):Promise<ModuleLinkScopeCensus|undefined>{
 const roots=new Set<string>()
 roots.add(resolve(input.installRoot))
 try{roots.add(realpathSync(input.installRoot))}catch{}
 let entries:string[]
 try{entries=await readdir(input.directory)}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error}
 let total=0,currentInstall=0
 const others=new Map<string,number>()
 const inspect=async(path:string)=>{
  let previous:string
  try{previous=await readlink(path)}catch{return}
  const target=resolve(dirname(path),previous)
  total++
  if([...roots].some(root=>target===root||target.startsWith(root+sep))){currentInstall++;return}
  const owner=installRootOfLinkTarget(target)
  others.set(owner,(others.get(owner)??0)+1)
 }
 for(const name of entries){
  const path=join(input.directory,name)
  let info
  try{info=await lstat(path)}catch{continue}
  if(info.isSymbolicLink()){await inspect(path);continue}
  if(!info.isDirectory()||!name.startsWith("@"))continue
  let children:string[]
  try{children=await readdir(path)}catch{continue}
  for(const child of children){
   const childPath=join(path,child)
   try{if(!(await lstat(childPath)).isSymbolicLink())continue}catch{continue}
   await inspect(childPath)
  }
 }
 const otherRoots=[...others.entries()]
  .sort((left,right)=>right[1]-left[1]||left[0].localeCompare(right[0]))
  .map(([root,count])=>root?`${root}（${count} 条）`:`归属未识别（${count} 条）`)
 return {directory:input.directory,total,currentInstall,otherInstall:total-currentInstall,otherRoots}
}

/* ---------------------------------------------------------------------------------------------------
 * 共享依赖镜像（`$DSH_HOME/profiles/node_modules`）的归并：**由它的真正 owner 执行，产品只调用与播报**
 *
 * 现象（2026-09-28 的启动中间态）：产品托管槽位 36 条先切到新安装，此时同级
 * `profiles/node_modules` 的 284 条原生 DSH 依赖链接尚未由其 owner 归并。随后现场读回
 * new=284 / old=0，不能把中间态当作持续混用。那面镜像的 owner 是上游 DSH 的 profile
 * fallback linker（`healProfilesModuleFallback`），不是 `reconcileProductPackageLinks()`：
 * 产品自己没有改那 284 条，因此仅播报"本次改指 36 条"容易让人误读最终状态。
 *
 * 修法（不夺权、不重写 owner）：在**本次启动**的归属普查之前，先用 owner 自己的函数按**当前安装**
 * 重新归并那面镜像；产品只负责调用、计数与播报。归属判定、冲突 fail-closed、软链写入全部仍由上游
 * 决定——因此只有"当前安装闭包里的同名槽位"会被改指，用户自定义目录/符号链接不会被覆盖或删除。
 *   · 有改动：打一行简短摘要（明细进跨 Profile 的 JSONL 诊断文件）；
 *   · 0 改动且没有指向别处：一个字都不打（幂等启动零噪声）；
 *   · 仍有不归并的链接：如实报条数与归属，并给出原因（不把混用状态藏起来）。
 *
 * `heal`/`census`/`targets`/`log`/`audit` 只用于测试注入替身；本函数不复制归属判定，也不直接删除链接。
 * ------------------------------------------------------------------------------------------------- */

/** 一次共享依赖镜像归并的结果。`switched` 是本次由 owner 改指到当前安装的槽位名。 */
export type InstallationMirrorReport={directory:string;switched:string[];currentInstall:number;otherInstall:number;otherRoots:string[];error?:string}

/** 共享依赖镜像的审计文件名；它是**跨 Profile** 的一份，因此落在 `profiles/` 而不是某个 Profile 里。 */
export const INSTALLATION_MIRROR_AUDIT="lyapunov-installation-mirror.jsonl"

/** 枚举一个 `node_modules` 目录（自身 + 一层 `@scope`，不沿符号链接递归）里每个软链的解析后目标。 */
export async function moduleLinkTargets(directory:string):Promise<Map<string,string>>{
 const targets=new Map<string,string>()
 let entries:string[]
 try{entries=await readdir(directory)}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return targets;throw error}
 const inspect=async(path:string,name:string)=>{
  let previous:string
  try{previous=await readlink(path)}catch{return}
  targets.set(name,resolve(dirname(path),previous))
 }
 for(const name of entries){
  const path=join(directory,name)
  let info
  try{info=await lstat(path)}catch{continue}
  if(info.isSymbolicLink()){await inspect(path,name);continue}
  if(!info.isDirectory()||!name.startsWith("@"))continue
  let children:string[]
  try{children=await readdir(path)}catch{continue}
  for(const child of children){
   const childPath=join(path,child)
   try{if(!(await lstat(childPath)).isSymbolicLink())continue}catch{continue}
   await inspect(childPath,`${name}/${child}`)
  }
 }
 return targets
}

/** 一个安装根的两种文本形态（配置路径与真实路径）；与 `censusModuleLinkScope` 的口径一致。 */
function installRootPrefixes(installRoot:string):Set<string>{
 const roots=new Set<string>([resolve(installRoot)])
 try{roots.add(realpathSync(installRoot))}catch{}
 return roots
}

function targetWithinInstallRoot(target:string,prefixes:ReadonlySet<string>):boolean{
 for(const root of prefixes)if(target===root||target.startsWith(root+sep))return true
 return false
}

/**
 * 用当前安装归并 `$DSH_HOME/profiles/node_modules`，只改由该安装器管理的旧安装链接。
 *
 * 镜像目录不存在时直接返回 `undefined`（没有这一层可归并），因此不制造任何输出。目录存在而
 * `installAnchor` 不在时**不做任何写入**，仍普查并如实报告未归并条数（不猜一个安装闭包）。
 */
export async function reconcileAndReportInstallationMirror(input:{
 profileDirectory:string;productRoot:string;installAnchor:string;home?:string;
 heal?:typeof healProfilesModuleFallback;
 census?:typeof censusModuleLinkScope;
 targets?:typeof moduleLinkTargets;
 log?:(line:string)=>void;
 audit?:(line:string)=>Promise<void>;
}):Promise<InstallationMirrorReport|undefined>{
 const home=input.home??dirname(dirname(input.profileDirectory))
 const directory=join(home,"profiles","node_modules")
 let info
 try{info=await lstat(directory)}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error}
 if(!info.isDirectory())return undefined
 const log=input.log??((line:string)=>{console.log(line)})
 const census=input.census??censusModuleLinkScope
 const targetsOf=input.targets??moduleLinkTargets
 const prefixes=installRootPrefixes(input.productRoot)
 const isCurrent=(target:string)=>targetWithinInstallRoot(target,prefixes)
 const before=await targetsOf(directory)
 let error:string|undefined
 if(existsSync(input.installAnchor)){
  try{await (input.heal??healProfilesModuleFallback)({installAnchor:input.installAnchor,home})}
  catch(cause){error=String((cause as Error)?.message??cause)}
 }else error=`当前安装锚点不存在：${input.installAnchor}`
 const after=await targetsOf(directory)
 const switched:{name:string;target:string}[]=[]
 for(const [name,previous] of before){
  const target=after.get(name)
  if(target===undefined)continue
  if(isCurrent(target)&&!isCurrent(previous)&&installRootOfLinkTarget(previous)!=="")switched.push({name,target})
 }
 const post=await census({directory,installRoot:input.productRoot})
 const otherInstall=post?.otherInstall??0
 const otherRoots=post?.otherRoots??[]
 const report:InstallationMirrorReport={directory,switched:switched.map(item=>item.name),currentInstall:post?.currentInstall??0,otherInstall,otherRoots,...(error===undefined?{}:{error})}
 if(switched.length||otherInstall){
  if(switched.length)log(`上游依赖镜像归并（${directory}）：本次改指 ${switched.length} 条到当前安装 ${resolve(input.productRoot)}${otherInstall?`；仍有 ${otherInstall} 条不指向当前安装：${otherRoots.join("、")}`:""}`)
  else log(`上游依赖镜像未归并（${directory}）：仍有 ${otherInstall} 条链接不指向当前安装 ${resolve(input.productRoot)}：${otherRoots.join("、")}${error?`；原因：${error}`:""}`)
  const record=JSON.stringify({time:new Date().toISOString(),directory,productRoot:resolve(input.productRoot),switched,currentInstall:report.currentInstall,otherInstall,otherRoots,...(error===undefined?{}:{error})})+"\n"
  const write=input.audit??(async(line:string)=>{await appendFile(join(home,"profiles",INSTALLATION_MIRROR_AUDIT),line)})
  try{await write(record)}
  catch(cause){log(`  审计记录追加失败（归并已完成，结果不受影响）：${String((cause as Error)?.message??cause)}`)}
 }
 return report
}

/**
 * 把一次托管链接切换的改动清单变成**可见输出**（纯函数，便于用替身断言）。
 *
 * `scope.inScope` 让读者知道"这 N 条"数的是哪个目录；`scope.outOfScope` 把**不归本函数**的那部分
 * 如实说出来并给出当前归属 —— 这样"本次改指了 N 条"不会被读成"这次一共就动了 N 条"。
 * 不归本函数的部分**只报范围与当前归属**；它由 owner 在本次启动的归并里改指，改动计数由
 * `reconcileAndReportInstallationMirror` 单独播报（本函数不自行判定它的归属）。
 */
export function productLinkSwitchNotice(input:{profileDirectory:string;productRoot:string;updated:readonly string[];removed:readonly string[];scope?:ProductLinkSwitchScope;source?:string},now:Date=new Date()):ProductLinkSwitchNotice{
 const {profileDirectory,productRoot,updated,removed,scope,source}=input
 const changed=updated.length+removed.length
 const outOfScope=scope?.outOfScope
 const foreign=outOfScope?.otherInstall??0
 // 0 改动且不归本函数的那些也没指向别处 ⇒ 一个字都不打（幂等启动不制造噪声）。
 if(!changed&&!foreign)return {lines:[]}
 const lines=changed?[
  `托管链接切换（Profile：${profileDirectory}；当前安装：${productRoot}）：本次切换改指了 ${updated.length} 条托管链接${removed.length?`，并清理了 ${removed.length} 条当前安装不再提供的槽位`:""}`,
  ...updated.map(name=>`  改指 → 当前安装：${name}`),
  ...removed.map(name=>`  清理 → 当前安装不再提供：${name}`),
 ]:[
  `托管链接归属（Profile：${profileDirectory}；当前安装：${productRoot}）：本次切换 0 改动，但 Profile 同级目录仍有链接不归本函数`,
 ]
 const inScope=scope?.inScope
 if(changed&&inScope?.total)lines.push(`  范围：本函数只管辖 Profile 自己的 node_modules 下由本次安装提供的托管槽位（本次改指 ${updated.length} 条、清理 ${removed.length} 条；该目录现有软链 ${inScope.total} 条，其中 ${inScope.currentInstall} 条指向本次安装）`)
 if(outOfScope?.total){
  lines.push(`  不归本函数：同级目录 ${outOfScope.directory} 另有 ${outOfScope.total} 条链接（上游 DSH 的 profile fallback linker 维护的依赖镜像）；归属与改指由该 owner 决定，本函数只在启动归并前后播报它的改动`)
  if(outOfScope.otherInstall)lines.push(`    这 ${outOfScope.total} 条里有 ${outOfScope.otherInstall} 条当前指向的不是本次安装：${outOfScope.otherRoots.join("、")}`)
  const visible=inScope?.total??updated.length
  lines.push(`  ⇒ 本次可见的托管链接共 ${visible+outOfScope.total} 条 ＝ 本函数管辖 ${visible} 条 ＋ 不归本函数 ${outOfScope.total} 条；「本次改指 ${updated.length} 条」不是这个数`)
 }
 const audit=changed?JSON.stringify({time:now.toISOString(),profileDirectory,productRoot,updated:[...updated],removed:[...removed],source:source??"reconcile"})+"\n":undefined
 return {lines,...(audit?{audit}:{})}
}

/** 播报 + 落审计（`productLinkSwitchNotice` 的唯一 I/O 出口）。审计写失败**不回滚、不抛错**，但也不静默。 */
async function emitProductLinkSwitchNotice(input:{notice:ProductLinkSwitchNotice;profileDirectory:string;log?:(line:string)=>void}):Promise<void>{
 if(!input.notice.lines.length)return
 const log=input.log??((line:string)=>{console.log(line)})
 for(const line of input.notice.lines)log(line)
 if(!input.notice.audit)return
 const auditPath=join(input.profileDirectory,PRODUCT_LINK_SWITCH_AUDIT)
 try{await appendFile(auditPath,input.notice.audit)}
 catch(error){log(`  审计记录追加失败（切换已完成，结果不受影响）：${auditPath} —— ${String((error as Error)?.message??error)}`)}
}

/** 两处范围一起普查：本函数管辖的 Profile 槽位目录 + 不归本函数的同级目录。 */
async function productLinkScopes(input:{profileDirectory:string;productRoot:string;census?:typeof censusModuleLinkScope;withOutOfScope?:boolean}):Promise<ProductLinkSwitchScope>{
 const census=input.census??censusModuleLinkScope
 const inScope=await census({directory:join(input.profileDirectory,"node_modules"),installRoot:input.productRoot})
 if(input.withOutOfScope===false)return {inScope}
 return {inScope,outOfScope:await census({directory:join(dirname(input.profileDirectory),"node_modules"),installRoot:input.productRoot})}
}

/**
 * 呼叫产品托管链接切换，并**播报**它实际改了什么（`runtime-patch.ts` 里那个唯一调用点走的就是这里）。
 *
 * **不改变切换语义**：归属判定、冲突 fail-closed、切换动作全部仍由 `script/product-link.ts` 决定，
 * 本函数只消费它的返回值，不多判一次、不改一个链接。
 *
 * `reconcile`/`census`/`log` 只用于测试注入替身（默认分别是 `reconcileProductPackageLinks`、
 * `censusModuleLinkScope` 与 `console.log`）：回归用例据此构造"有改动 / 0 改动"两种场景，
 * **不碰任何真实运行根的链接**。
 *
 * 在归属普查之前先用镜像的真正 owner 归并同级 `profiles/node_modules`（见
 * `reconcileAndReportInstallationMirror`）：这样"本次改指 N 条"与"底座现在指向谁"读的是同一时刻的真值，
 * 而不是"产品改完、owner 还没跑"的中间态。
 */
export async function reconcileAndReportProductLinks(input:{profileDirectory:string;productRoot:string;installAnchor:string;overlayPaths?:readonly string[];reconcile?:typeof reconcileProductPackageLinks;census?:typeof censusModuleLinkScope;mirrorHeal?:typeof healProfilesModuleFallback;mirrorTargets?:typeof moduleLinkTargets;log?:(line:string)=>void}):Promise<ProductLinkSwitchReport>{
 const report=await (input.reconcile??reconcileProductPackageLinks)({profileDirectory:input.profileDirectory,productRoot:input.productRoot,installAnchor:input.installAnchor,overlayPaths:input.overlayPaths})
 await reconcileAndReportInstallationMirror({profileDirectory:input.profileDirectory,productRoot:input.productRoot,installAnchor:input.installAnchor,heal:input.mirrorHeal,census:input.census,targets:input.mirrorTargets,log:input.log})
 const scope=await productLinkScopes(input)
 const notice=productLinkSwitchNotice({profileDirectory:input.profileDirectory,productRoot:input.productRoot,updated:report.updated,removed:report.removed,scope,source:"reconcile"})
 await emitProductLinkSwitchNotice({notice,profileDirectory:input.profileDirectory,log:input.log})
 return report
}

/**
 * 预切换 Profile 的 `@lyapunov/product-bundle` 槽位并**播报**（`prepareProfile()` 走这里）。
 *
 * 为什么必须在这里播报：这一步发生在 `runtimePatch()` 的 `reconcileProductPackageLinks()` **之前**，
 * 等 reconcile 再跑时该槽位已经"无改动" ⇒ 只做预切换不播报，就等于这个槽位**永远报不出来**。
 * （验收队 2026-09-27 定位：`VERIFY-RUNTIME-PATCH-LINKS-20260926.md` §7.2 B3，属修复自己留的空洞。）
 * `link`/`census`/`log` 只用于测试注入替身；本函数不改切换语义。
 */
export async function linkProductBundleSlot(input:{profileDirectory:string;productRoot:string;link?:typeof linkProductPackage;census?:typeof censusModuleLinkScope;log?:(line:string)=>void}):Promise<{updated:boolean}>{
 const result=await (input.link??linkProductPackage)(input.profileDirectory,"@lyapunov/product-bundle",join(input.productRoot,"packages/lyapunov-product-bundle"))
 // 只在本步真的改了东西时出声；"不归本函数"的那半由紧随其后的 reconcile 播报一次，不在这里重复。
 if(!result.updated)return result
 const scope=await productLinkScopes({profileDirectory:input.profileDirectory,productRoot:input.productRoot,census:input.census,withOutOfScope:false})
 const notice=productLinkSwitchNotice({profileDirectory:input.profileDirectory,productRoot:input.productRoot,updated:["@lyapunov/product-bundle"],removed:[],scope,source:"prepareProfile"})
 await emitProductLinkSwitchNotice({notice,profileDirectory:input.profileDirectory,log:input.log})
 return result
}

/**
 * 旧 Profile 迁移并**播报**结果（`prepareProfile()` 走这里）。
 *
 * 迁移报告以前被整个丢掉 —— 而同一函数体上方几行的"存储分治迁移"是播报的（`:50-53`），
 * 同一处代码一半播报一半不播报：旧 profile 静默链了哪些依赖、缺了哪些依赖，无人可见。
 * 只报"本次真的迁移了"（`status==='migrated'`）这一次；已迁移过的重启不再重复打印。
 */
export async function migrateLegacyProfileAndReport(input:{dshHome:string;mode:Exclude<RunMode,"local"|"guest">;surface:"web"|"sdk"|"headless"|"acp";targetDir:string;canonicalManifest?:Record<string,unknown>;migrate?:typeof migrateLegacyProfile;log?:(line:string)=>void}):Promise<LegacyProfileMigration>{
 const migration=await (input.migrate??migrateLegacyProfile)({dshHome:input.dshHome,mode:input.mode,surface:input.surface,targetDir:input.targetDir,canonicalManifest:input.canonicalManifest})
 if(migration.status==="migrated"){
  const log=input.log??((line:string)=>{console.log(line)})
  log(`旧 Profile 迁移（${migration.sourceProfile} → ${migration.targetProfile}）：链接依赖 ${migration.linkedDependencies.length} 条、缺失依赖 ${migration.missingDependencies.length} 条`)
  for(const name of migration.linkedDependencies)log(`  已链接 → 本次安装：${name}`)
  for(const name of migration.missingDependencies)log(`  缺失（未链接）：${name}`)
 }
 return migration
}

/** 初始化私有 Profile；用户后续写入的 Profile/settings 不被重复覆盖。 */
export async function prepareProfile(options: {mode: RunMode; surface: "web" | "sdk" | "headless" | "acp"; runtimeRoot?: string; accountId?: string; log?:(line:string)=>void}) {
  const log=options.log??((line:string)=>{console.log(line)})
  const paths=runtimePaths({root: options.runtimeRoot ?? join(PRODUCT_ROOT,".runtime/product"), mode:options.mode, accountId:options.accountId, production:process.env.NODE_ENV==="production"})
  // 存储分治迁移：旧单根 scene/ 存在时自动搬到 worlds/cache/catalog 并改写绝对路径引用。
  // 幂等且不覆盖冲突项；用户内容有残留时保留旧目录并打印，不静默删除。
  const migration=await migrateRuntimeLayout(paths,{productRoot:PRODUCT_ROOT})
  if(migration.moved.length||migration.merged.length||migration.rewrote.length||migration.conflicts.length){
    log(`存储分治迁移：移动 ${migration.moved.length}、合并 ${migration.merged.length}、冲突 ${migration.conflicts.length}、改写引用 ${migration.rewrote.length}`)
    for(const item of migration.conflicts)log(`  冲突（未覆盖）：${item}`)
    for(const item of migration.leftovers)log(`  旧目录残留（原样保留）：${item}`)
  }
  // 工作文件夹映射：三类域与缓存映射进 <workspaceRoot>，产品根 workspace 指向活动工作区；
  // 只建/修软链、不接管同名真实目录（三个入口共用同一实现）。
  // 只有规范运行根（父目录名 = 运行模式，如 .runtime/developer/developer）才认领
  // <产品根>/workspace 这个人类入口；验证/临时根不抢（否则一次验收就把入口指到临时目录）。
  const canonicalEntry=basename(dirname(paths.root))===options.mode
  await ensureWorkspaceMapping({productRoot:PRODUCT_ROOT,workspaceRoot:paths.workspaceRoot,paths,claimProductEntry:canonicalEntry})
  const profile=`${RUNTIME_NAME}-${options.mode}-${options.surface}`
  const dir=join(paths.dshHome,"profiles",profile)
  await mkdir(dir,{recursive:true})
  await mkdir(paths.workspaceRoot,{recursive:true})
  const manifest={name:`${profile}-profile`,private:true,type:"module",dsh:{profile:{bundles:["@deepseek-ai/dsh-base",`@deepseek-ai/dsh-${options.surface==="web"?"web-app":options.surface==="sdk"?"sdk-app":options.surface==="acp"?"acp-app":"headless"}`,"@lyapunov/product-bundle"],patchReload:"startup"}}}
  if(options.mode!=="local"&&options.mode!=="guest")await migrateLegacyProfileAndReport({dshHome:paths.dshHome,mode:options.mode,surface:options.surface,targetDir:dir,canonicalManifest:manifest,log})
  try {await writeFile(join(dir,"package.json"),JSON.stringify(manifest,null,2)+"\n",{flag:"wx"})} catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e}
  // 预切换的槽位必须在这里就报出来：reconcile 再跑时它已"无改动"（见 `linkProductBundleSlot`）。
  await linkProductBundleSlot({profileDirectory:dir,productRoot:PRODUCT_ROOT,log})
  try{await writeFile(join(dir,"cordis.patch.yml"),"[]\n",{flag:"wx"})}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e}
  return {paths,profile,dir}
}

/** 凭据只供对应后端使用；不读正式账号存储。 */
export async function backendEnvironment(mode:RunMode, paths:ReturnType<typeof runtimePaths>, options:{account?:VerifiedAccount;parent?:NodeJS.ProcessEnv;isolated?:boolean}={}) {
  const parent=options.parent??process.env
  const permitted=["PATH","HOME","USER","LOGNAME","SHELL","LANG","LC_ALL","TZ","TMPDIR","DISPLAY","WAYLAND_DISPLAY","XDG_RUNTIME_DIR","DBUS_SESSION_BUS_ADDRESS","HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","all_proxy","no_proxy","SystemRoot","WINDIR","APPDATA","LOCALAPPDATA","USERPROFILE","COMSPEC","PATHEXT"]
  const inherited=mode!=="developer"||options.isolated?Object.fromEntries(permitted.filter(k=>parent[k]!==undefined).map(k=>[k,parent[k]])):{...parent}
  const env:NodeJS.ProcessEnv={...inherited,DSH_HOME:paths.dshHome,DSH_AGENTS_HOME:join(paths.root,"agents-home"),DSH_TELEMETRY_DISABLED:"1",HF_ENDPOINT:"https://hf-mirror.com",[RUNTIME_ENV.sceneRoot]:paths.sceneRoot,[RUNTIME_ENV.pluginRoot]:paths.pluginRoot,[RUNTIME_ENV.mode]:mode}
  if(mode==="guest"){env.DSH_ENV_FILES="disabled";env.DSH_PERMISSION_MODE="workspace-write"}
  // 用户级技能根(~/.agents/skills)不属于产品;钉到运行根私有目录,产品技能只经显式 customSkillDirs 装配。
  const agentsHome=join(paths.root,"agents-home")
  await mkdir(agentsHome,{recursive:true})
  for(const key of Object.values(LEGACY_RUNTIME_ENV)) delete env[key]
  delete env[RUNTIME_ENV.accountToken]
  delete env[RUNTIME_ENV.accountSessionFile]
  // 管理员仅继承当前原生直连端点；认证 Cookie、密码与其他父进程凭据不进入 Host。
  if(mode==="developer"&&options.isolated&&parent.DEEPSEEK_BASE_URL)env.DEEPSEEK_BASE_URL=parent.DEEPSEEK_BASE_URL
  // 开发直连的**图像 / Tripo / Hunyuan / Marble 供应商配置**同样只从宿主环境来，而隔离启动会清掉父进程环境（终端 `script/terminal.ts`
  // 与管理员 Web Host `script/host.ts` 都走 isolated）。它不能改走 Profile 补丁 YAML——那是普通可读文件，
  // 等于把 key 落盘。所以按插件**声明过**的那几个键名逐个搬运（`IMAGE_DEVELOPER_ENV_KEYS` +
  // `TRIPO_DEVELOPER_ENV_KEYS` + `HUNYUAN_DEVELOPER_ENV_KEYS` + `MARBLE_DEVELOPER_ENV_KEYS`，分别与
  // packages/generate-image/src/provider.ts、packages/generate-tripo/src/provider.ts、
  // packages/generate-hunyuan/src/provider.ts、packages/generate-marble/src/provider.ts 的读取处一一对应；
  // 四份清单互有交集，按名字去重后各搬一次），
  // **不是**把父进程环境整体透传：清单外的任何变量（含 HOME/XDG 与其它凭据）继续按隔离规则处理。
  // 正式模式永不搬运（上面的 inherited 分支已经把它挡在外面）：那条路由经中央账户网关，供应商 key 只在服务端。
  if(mode==="developer"&&options.isolated)for(const key of new Set<string>([...IMAGE_DEVELOPER_ENV_KEYS,...TRIPO_DEVELOPER_ENV_KEYS,...HUNYUAN_DEVELOPER_ENV_KEYS,...MARBLE_DEVELOPER_ENV_KEYS]))if(parent[key]!==undefined)env[key]=parent[key]
  // 本地工具的目录/解释器覆盖在正式、开发入口均有效；逐键搬运明确登记的路径配置。
  for(const key of FASTGS_RUNTIME_ENV_KEYS)if(parent[key]!==undefined)env[key]=parent[key]
  // Profile 在父进程已按这三条规范 SDK 路径生成；子 Host 的设置页/Provider 再读时必须是同一份。
  // 只转发明确登记的解释器路径，formal/local 其余父环境和模型密钥仍受上面的有界白名单约束。
  if(parent[RUNTIME_ENV.policyPython]!==undefined)env[RUNTIME_ENV.policyPython]=parent[RUNTIME_ENV.policyPython]
  for(const key of Object.values(SDK_PYTHON_ENV)){
    const path=parent[key]?.trim()
    if(path)env[key]=path
    else delete env[key]
  }
  if(mode==="developer"&&!env.DEEPSEEK_API_KEY){
    const file=readRuntimeEnv(parent,"developerAuthFile") ?? join(PRODUCT_ROOT,".runtime/session-secrets/deepseek-auth.json")
    try{const auth=JSON.parse(await readFile(file,"utf8"));if(auth.deepseek?.type==="api"&&typeof auth.deepseek.key==="string")env.DEEPSEEK_API_KEY=auth.deepseek.key}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e}
  }
  if(mode==="formal"&&!options.account)throw new Error("AUTH_REQUIRED: 正式后端只接受已验证的账户会话")
  if(mode!=="developer"||options.isolated){
    // 正式和管理员 Host 不得通过 HOME/XDG 读取其他 Profile 的本地配置。
    // 保留 XDG_RUNTIME_DIR/DBus 等桌面会话通道，但把持久配置、缓存、状态和临时文件
    // 固定到各自私有目录；普通开发模式继续沿用用户开发环境。
    const privateRoot=join(paths.root,"private")
    await Promise.all([
      mkdir(privateRoot,{recursive:true}),
      mkdir(join(privateRoot,"config"),{recursive:true}),
      mkdir(join(privateRoot,"data"),{recursive:true}),
      mkdir(join(privateRoot,"cache"),{recursive:true}),
      mkdir(join(privateRoot,"state"),{recursive:true}),
      mkdir(join(privateRoot,"tmp"),{recursive:true}),
    ])
    env.HOME=privateRoot
    env.XDG_CONFIG_HOME=join(privateRoot,"config")
    env.XDG_DATA_HOME=join(privateRoot,"data")
    env.XDG_CACHE_HOME=join(privateRoot,"cache")
    env.XDG_STATE_HOME=join(privateRoot,"state")
    env.TMPDIR=join(privateRoot,"tmp")
    if(mode==="guest"){env.USERPROFILE=privateRoot;env.APPDATA=join(privateRoot,"config");env.LOCALAPPDATA=join(privateRoot,"data")}
  }
  if(mode==="formal"){
    env[RUNTIME_ENV.accountToken]=options.account!.token
    env[RUNTIME_ENV.apiUrl]=options.account!.apiUrl
  }
  return env
}
