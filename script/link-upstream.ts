import { readdir, readFile, mkdir, symlink, readlink, rename, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve, relative, dirname, isAbsolute } from "node:path"

/** 将固定上游源码包链接为唯一运行实例，不使用 registry 的另一份 Cordis。 */
export async function linkUpstream(root = resolve(import.meta.dirname, ".."), options: {replaceOwned?: boolean} = {}) {
  const lock = JSON.parse(await readFile(join(root, "UPSTREAM_LOCK.json"), "utf8"))
  const upstream = resolve(root, lock.directory)
  const groups = [join(upstream,"vendor"), join(upstream,"apps")]
  const nativePackages = join(upstream,"native/system/packages")
  if(existsSync(nativePackages)) groups.push(nativePackages)
  for (const item of await readdir(join(upstream,"packages"), {withFileTypes:true})) {
    if(item.isDirectory()) groups.push(join(upstream,"packages",item.name))
  }
  let count=0,updated=0
  for(const group of groups) for(const item of await readdir(group,{withFileTypes:true})) {
    if(!item.isDirectory())continue
    const dir=join(group,item.name)
    let pkg:{name?:string}
    try { pkg=JSON.parse(await readFile(join(dir,"package.json"),"utf8")) } catch { continue }
    if(!pkg.name?.startsWith("@deepseek-ai/"))continue
    const dest=join(root,"node_modules",pkg.name)
    await mkdir(resolve(dest,".."),{recursive:true})
    try { await symlink(dir,dest,"dir"); count++ } catch(error) {
      if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error
      const previous=await readlink(dest)
      if(resolve(dirname(dest),previous)===dir)continue
      if(!options.replaceOwned)throw new Error(`上游包已有不同安装：${pkg.name}；关闭活动Host后通过bootstrap更新链接`)
      const previousDirectory=resolve(dirname(dest),previous)
      const ownedPath=relative(join(root,'.upstream'),previousDirectory)
      if(ownedPath==='..'||ownedPath.startsWith('../'))throw new Error(`保留非本产品上游链接：${pkg.name}（原链接：${previous}）`)
      let previousPackage:{name?:string}|undefined
      try{previousPackage=JSON.parse(await readFile(join(previousDirectory,'package.json'),'utf8'))}
      catch(error){
        // 悬空自家链接（旧 .upstream 目录被删除/移动）：目标已不存在，没有可保留的安装内容；
        // 只在 .upstream 归属已确认时接管。其余不可核实状态明确失败，不再漏出裸 ENOENT。
        if((error as NodeJS.ErrnoException).code==='ENOENT'&&!existsSync(previousDirectory))previousPackage=undefined
        else throw new Error(`保留非本产品上游链接：${pkg.name}（原链接 ${previous} 不可核实：${String((error as Error)?.message??error)}）`)
      }
      if(previousPackage&&previousPackage.name!==pkg.name)throw new Error(`保留非本产品上游链接：${pkg.name}（原链接指向 ${previousPackage.name??'未命名包'}）`)
      const temporary=dest+'.upstream-next-'+process.pid
      await symlink(dir,temporary,'dir')
      await rename(temporary,dest)
      updated++
    }
  }
  // 上游改版会整组删除包（如 e2b / code-runtime），其旧链接随即悬空：lstat/realpath 直接 ENOENT，
  // 打包期（package-linux 的 collect）首当其冲。悬空链接没有任何可解析的安装内容，且仍存在的上游包
  // 每轮都会在这里重建，故按“指向本上游目录”的归属边界就地清理，不碰其它来源的链接。
  let pruned=0
  const scope=join(root,"node_modules","@deepseek-ai")
  if(existsSync(scope))for(const item of await readdir(scope)){
    const link=join(scope,item)
    let target:string
    try { target=await readlink(link) } catch { continue }
    if(existsSync(link))continue
    const ownedPath=relative(upstream,resolve(scope,target))
    if(ownedPath===''||ownedPath==='..'||ownedPath.startsWith('../')||isAbsolute(ownedPath))continue
    await rm(link,{force:true})
    pruned++
  }
  return {upstream,linked:count,updated,pruned}
}
if(import.meta.main) console.log(await linkUpstream(undefined,{replaceOwned:process.argv.includes('--replace-owned')}))
