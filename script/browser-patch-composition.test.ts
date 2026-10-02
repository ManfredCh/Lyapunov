import {test,expect} from "bun:test"
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {dirname,join,resolve} from "node:path"
import {spawnSync} from "node:child_process"
import {createHash} from "node:crypto"
import {verifiedBrowserRootComposition,verifiedComposedPatch} from "./upstream-patches.mjs"
const root=resolve(import.meta.dirname,".."),upstream=join(root,".upstream/deepseek-harness-20260911-candidate")
const digest=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex")
const git=(cwd:string,args:string[])=>{
  const result=spawnSync("git",args,{cwd,encoding:"utf8",maxBuffer:32<<20})
  if(result.status!==0)throw new Error(result.stderr)
  return result.stdout
}
test("E27三补丁只认完整签名postimage，未知变化/缺文件拒绝而不放宽旧签名",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"lyapunov-e27-composition-"))
  try{
    const signed=JSON.parse(await readFile(join(root,"packages/lyapunov-shell/patches/dsh-browser-root-owner.postimage.json"),"utf8"))
    for(const row of signed.postimages){const target=join(directory,row.path);await mkdir(dirname(target),{recursive:true});await copyFile(join(upstream,row.path),target)}
    // 当前51合法consumer已含English；隔离撤回精确一文件语言delta，恢复旧14真实夹具。
    const english=JSON.parse(await readFile(join(root,"UPSTREAM_LOCK.json"),"utf8")).a08BrowserRecoveryEnglishPatch
    const englishPatch=join(root,english.file)
    expect(digest(await readFile(englishPatch))).toBe(english.sha256)
    expect(english.files.map((row:{path:string})=>row.path)).toEqual(["packages/experimental/browser-use-runtime/src/mcp.ts"])
    for(const row of english.files)expect(digest(await readFile(join(directory,row.path)))).toBe(row.postSha256)
    git(directory,["apply","--reverse","--check",englishPatch])
    git(directory,["apply","--reverse",englishPatch])
    for(const row of signed.postimages)expect(digest(await readFile(join(directory,row.path)))).toBe(row.sha256)
    for(const name of ["dsh-browser-use-recovery.patch","dsh-browser-use-runtime-diagnostics.patch"]){
      const patch={file:join(root,"packages/lyapunov-shell/patches",name)}
      expect(verifiedComposedPatch(root,directory,patch)).toBe(true)
      const file=join(directory,"packages/experimental/browser-use-runtime/src/mcp.ts"),original=await readFile(file,"utf8")
      await writeFile(file,original+"\n// unknown fixture change\n")
      expect(verifiedBrowserRootComposition(root,directory,patch)).toBe(false)
      await writeFile(file,original)
      const newFile=join(directory,"packages/experimental/browser-use-runtime/src/root-state.ts"),bytes=await readFile(newFile)
      await rm(newFile);expect(verifiedBrowserRootComposition(root,directory,patch)).toBe(false)
      await writeFile(newFile,bytes)
    }
  }finally{await rm(directory,{recursive:true,force:true})}
})
