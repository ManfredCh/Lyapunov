import { mkdir,readdir,readFile,writeFile,copyFile,symlink } from "node:fs/promises"
import { join,resolve } from "node:path"
import { linkUpstream } from "./link-upstream.ts"
import { remoteScopePlugin } from './terminal-build.ts'
const root=resolve(import.meta.dirname,"..")
// 链接归属变化必须**播报**：`linkUpstream()` 明确统计了新建/改指/清理三条计数，以前在唯一调用点被
// 整个丢掉 —— 与 `script/runtime-patch.ts` 那次"返回值在唯一调用点被扔掉"同形（见
// `bugfixHistory/VERIFY-RUNTIME-PATCH-LINKS-20260926.md` §5.2 第 3 条）。同一文件里其它步骤都打
// "已构建 …"，唯独 `node_modules/@deepseek-ai/*` 的归属变化无声。
const upstreamLinks=await linkUpstream(root)
if(upstreamLinks.linked||upstreamLinks.updated||upstreamLinks.pruned)
  console.log(`上游链接（${upstreamLinks.upstream}）：新建 ${upstreamLinks.linked}、改指 ${upstreamLinks.updated}、清理 ${upstreamLinks.pruned}`)
const only=process.argv.slice(2)
const packages=(await readdir(join(root,"packages"))).filter(n=>!only.length||only.includes(n))
// 内联消费包需要独立计算线程闭包；统一构建入口生成，不依赖手工临时bundle。
const geometryWorker=await Bun.build({entrypoints:[join(root,'packages/asset-bake/src/geometry-worker.ts')],outdir:join(root,'packages/asset-bake/dist'),naming:'[name].js',target:'node',format:'esm',minify:false})
if(!geometryWorker.success)throw new AggregateError(geometryWorker.logs,'几何计算worker构建失败')
if(!only.length||only.includes("lyaup-migrations")){
  const result=await Bun.build({entrypoints:[join(root,"packages/lyaup-migrations/src/index.ts")],outdir:join(root,"packages/lyaup-migrations/dist"),naming:"[name].js",target:"node",format:"esm",packages:"external"})
  if(!result.success)throw new AggregateError(result.logs,"迁移器构建失败")
}
if(!only.length||only.includes("lyapunov-product-bundle")){
  // cli.ts 经 github-cli.ts 引入 script/profile.ts：保留 process.env.NODE_ENV 的运行时读取，
  // 避免 Bun.build 把 production 判据在构建期内联为构建机取值。
  const result=await Bun.build({entrypoints:[join(root,"packages/lyapunov-product-bundle/src/cli.ts")],outdir:join(root,"packages/lyapunov-product-bundle/dist"),target:"node",format:"esm",external:["@deepseek-ai/*"],define:{"process.env.NODE_ENV":"process.env.NODE_ENV"}})
  if(!result.success)throw new AggregateError(result.logs,"CLI构建失败")
}
for(const name of packages){
  const dir=join(root,"packages",name)
  // contracts等纯接口包没有plugin入口，但仍是现有工作区公开依赖，须在同一构建入口建立链接。
  if(!await Bun.file(join(dir,"package.json")).exists())continue
  const pkg=JSON.parse(await readFile(join(dir,"package.json"),"utf8"))
  const link=join(root,"node_modules",pkg.name);await mkdir(resolve(link,".."),{recursive:true})
  try{await symlink(dir,link,"dir")}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e}
  const entry=join(dir,"src/plugin.ts")
  if(!await Bun.file(entry).exists())continue
  await mkdir(join(dir,"dist"),{recursive:true})
  const build=await Bun.build({entrypoints:[entry],outdir:join(dir,"dist"),target:"node",format:"esm",external:["@deepseek-ai/*","three","fast-xml-parser"],minify:false})
  if(!build.success)throw new AggregateError(build.logs,"插件构建失败："+name)
  if(name==="desktop"){
    const credentials=await Bun.build({entrypoints:[join(dir,"src/guest-credentials.ts")],outdir:join(dir,"dist"),target:"node",format:"esm",external:["@deepseek-ai/*"]})
    if(!credentials.success)throw new AggregateError(credentials.logs,"游客传输凭据provider构建失败")
  }
  if (name === 'lyapunov-terminal') {
    const remote = await Bun.build({ entrypoints: [join(dir, 'src/remote-terminal.ts')], outdir: join(dir, 'dist'), target: 'node', format: 'esm', external: ['@deepseek-ai/*'], plugins: [remoteScopePlugin()] })
    if (!remote.success) throw new AggregateError(remote.logs, '远端终端构建失败')
  }
  if (name === 'motion-mink') {
    // request.ts 是纯入参规范化模块（无 DSH 依赖），plugin.ts 的 bundle 已把它内联；
    // 产品外的验收脚本按路径直接 import dist/request.js，故另出一份具名产物，
    // 让 dist/ 全部由本构建产出，避免手工 tsc 残留成为隐式依赖。
    const request = await Bun.build({ entrypoints: [join(dir, 'src/request.ts')], outdir: join(dir, 'dist'), target: 'node', format: 'esm', naming: '[name].js', minify: false })
    if (!request.success) throw new AggregateError(request.logs, 'motion-mink 入参模块构建失败')
  }
  for(const file of await readdir(join(dir,"src")))if(file.endsWith(".py"))await copyFile(join(dir,"src",file),join(dir,"dist",file))
  // 算法 worker 随包复制：消费方（scene-kit）把 asset-bake 的 physicalize/operations 整个内联进自己的
  // bundle 后，`new URL('./bake.py', import.meta.url)` 会解析到**消费方的 dist**——所以谁的产品里出现了
  // 这个 worker 的引用，就把同一份 worker 复制到谁的 dist 旁边（来源与目标都打印出来）。这样 built 产物
  // 自带 worker，运行期按相对位置解析，移动项目目录后仍可调用，不依赖任何人手工放副本。
  if(name!=="asset-bake"){
    const texts=await Promise.all(build.outputs.filter(output=>output.path.endsWith(".js")).map(output=>output.text()))
    if(texts.some(text=>text.includes("bake.py"))){
      for(const file of ["bake.py","geometry_stream.py","point_tiled.py","point_surface.py"]){
        const worker=join(root,"packages/asset-bake/src",file),target=join(dir,"dist",file)
        await copyFile(worker,target)
        console.log("已随包复制算法 worker",worker,"->",target)
      }
    }
    if(texts.some(text=>text.includes('geometry-worker.js')))await copyFile(join(root,'packages/asset-bake/dist/geometry-worker.js'),join(dir,'dist/geometry-worker.js'))
  }
  console.log("已构建",pkg.name)
}
for(const name of ["viewer","lyapunov-shell","lyapunov-workspace","lyapunov-session-undo","desktop"].filter(name=>!only.length||only.includes(name))){
  const dir=join(root,"packages",name),pkg=JSON.parse(await readFile(join(dir,"package.json"),"utf8"))
  const build=await Bun.build({entrypoints:[join(dir,"src/client.tsx")],target:"browser",format:"cjs",plugins:[{name:"native-workspace-path",setup(builder){builder.onResolve({filter:/^@deepseek-ai\/dsh-util-workspace-path(?:\/.*)?$/},args=>({path:Bun.resolveSync(args.path,root),external:false}))}}],external:["@deepseek-ai/*","@lyapunov/viewer/client","react","react/jsx-runtime","react-dom"],minify:false,define:{"process.env.NODE_ENV":JSON.stringify("production")}})
  if(!build.success)throw new AggregateError(build.logs,"客户端构建失败")
  const js=await build.outputs[0]!.text()
  await writeFile(join(dir,"dist/client.js"),`window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${js}\nreturn module.exports;}});\n`)
  console.log("已构建 DSH 客户端模块",pkg.name)
}
