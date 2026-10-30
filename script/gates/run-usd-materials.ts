/** 生成可直接scene_open的合法USD材质案例；可选以真实共享Viewer/Edge无头渲染截图。 */
import {execFileSync} from 'node:child_process'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve,join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {SceneOperations} from '../../packages/scene-kit/src/operations.ts'
import {usdPython,setUsdInstance} from '../../packages/scene-kit/src/usd-assets.ts'
import {projectPathsOnly,resourceToken} from '../../packages/lyapunov-contracts/src/product-paths.ts'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),args=process.argv.slice(2),arg=(name:string)=>args[args.indexOf(name)+1]
const out=resolve(args.includes('--out')?arg('--out'):join(root,'.runtime/usd-materials-'+Date.now()));await mkdir(out,{recursive:true})
const external=args.includes('--source')?resolve(arg('--source')):undefined
const externalScene=args.includes('--scene')?resolve(arg('--scene')):undefined
if(external&&externalScene)throw Error('材质门的--source与--scene只能选一项')
if(!external&&!externalScene)execFileSync(usdPython(),[join(root,'packages/scene-kit/test/fixtures/usd/make_material_fixture.py'),join(out,'source')])
const operations=new SceneOperations(join(out,'catalog'))
let scene
let sourceVerification
if(externalScene){scene=await operations.open(externalScene,{sceneId:'usd-materials'});const checks=await Promise.all(scene.entities.flatMap(entity=>entity.resources.map(ref=>operations.resources.verifyReference(ref))));sourceVerification={valid:checks.every(check=>check.valid),checks}}
else{
await operations.create({sceneId:'usd-materials'})
const imported=await operations.import({path:external??join(out,'source/material.usda'),sceneId:'usd-materials',entityId:'warm',physicalize:false})
await operations.mount({sceneId:'usd-materials',resourceId:imported.resource.ref.resourceId,entityId:'cool',alignBottomToSurface:false,transform:{position:[0,1.5,0],quaternion:[0,0,0,1],scale:[1,1,1]}})
scene=await operations.scene.snapshot('usd-materials');if(!external)scene=await setUsdInstance(operations,{sceneId:scene.sceneId,entityId:'cool',expectedRevision:scene.revision,variants:{'/MaterialDemo':{finish:'cool'}}})
sourceVerification=await operations.resources.verify(imported.resource.ref.resourceId,imported.resource.ref.version)
}
const externalAsset=!!(external||externalScene),entityIds=scene.entities.filter(entity=>entity.components.visual?.kind==='usd').map(entity=>entity.entityId)
const portable=join(out,'portable/scene.json');await operations.save(scene.sceneId,portable,{portable:true})
await writeFile(join(out,'OPEN_IN_WORKBENCH.md'),'# USD基础材质复跑\n\n在工作台调用同一个人工Command或Agent工具：\n\n```text\n/scene_open '+JSON.stringify({path:portable,sceneId:'usd-materials-review'})+'\n```\n\n'+(externalAsset?'场景使用指定真实USD，按原PreviewSurface或已验证固定OmniPBR子集显示Albedo/packed通道与normal；保留原许可、原材质网络及明确派生损失。':'场景为自有小型USD：两排同源实例，右侧常量材质分别红/蓝，中间RGB棋盘纹理，左侧同图r/b通道控制粗糙度/金属度。')+'源USD仍为主资产，纹理通过派生资源表示和既有受控媒体路由读取。截图门不启动物理。\n')
const receipt:Record<string,any>={status:'GENERATED',portable,source:external??externalScene??'owned-material-fixture',sourceVerification,sourceSha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),worktree:execFileSync('git',['status','--short'],{cwd:root,encoding:'utf8'}).trim()}
if(args.includes('--screenshot')){
 const entry=join(out,'viewer-entry.ts'),bundle=join(out,'viewer.js')
 await writeFile(entry,`import {createViewer} from ${JSON.stringify(join(root,'packages/viewer/src/index.ts'))};\nconst errors:string[]=[];const viewer=createViewer({container:document.getElementById('viewport')!,resolveResource:uri=>'/resource?uri='+encodeURIComponent(uri),onError:error=>errors.push(String(error))});\ntry{await viewer.setScene(await(await fetch('/scene')).json());viewer.cameraPreset('perspective');viewer.frameAll();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const capture=viewer.capture();await fetch('/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status:errors.length?'FAILED':'PASSED',errors,materials:${JSON.stringify(entityIds)}.map(id=>viewer.materialStatus(id)),capture})});document.documentElement.dataset.ready='true'}catch(error){await fetch('/report',{method:'POST',body:JSON.stringify({status:'FAILED',errors:[String(error)]})})}`)
 const built=await Bun.build({entrypoints:[entry],target:'browser',format:'esm',minify:false});if(!built.success)throw new AggregateError(built.logs,'共享Viewer案例构建失败');await writeFile(bundle,await built.outputs[0]!.text())
 const resources=new Map(scene.entities.flatMap(entity=>entity.resources.flatMap(ref=>[ref.original,...ref.representations])).map(rep=>[resourceToken(rep.uri),rep]))
 let reportResolve!:(value:any)=>void
 const reportPromise=new Promise<any>(resolve=>{reportResolve=resolve})
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const url=new URL(request.url)
  if(url.pathname==='/')return new Response('<!doctype html><html><meta charset="utf-8"><title>USD基础材质 · 共享Viewer实测</title><style>html,body{margin:0;background:#18202c;color:#eef1f5;font:16px sans-serif}header{padding:12px 20px;height:36px}#viewport{position:absolute;inset:60px 0 0}</style><header>'+(externalAsset?'真实USD / 原厂材质受支持子集':'USD主资产 · PreviewSurface / st纹理 · 红蓝实例变体')+'</header><div id="viewport"></div><script type="module" src="/viewer.js"></script></html>',{headers:{'content-type':'text/html'}})
  if(url.pathname==='/viewer.js')return new Response(Bun.file(bundle),{headers:{'content-type':'application/javascript'}})
  if(url.pathname==='/scene')return Response.json(projectPathsOnly(scene))
  if(url.pathname==='/resource'){const rep=resources.get(url.searchParams.get('uri')??'');if(!rep)return new Response('RESOURCE_NOT_AUTHORIZED',{status:403});return new Response(await operations.resources.readVerifiedResource(scene,rep.uri),{headers:{'content-type':rep.mimeType}})}
  if(url.pathname==='/report'&&request.method==='POST'){reportResolve(await request.json());return new Response('ok')}
  return new Response('not found',{status:404})}})
 try{
  const browser=args.includes('--browser')?arg('--browser'):'/usr/bin/microsoft-edge'
  const child=Bun.spawn([browser,'--headless=new','--disable-gpu-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check','--user-data-dir='+join(out,'browser-profile'),'--window-size=1280,900','--virtual-time-budget=20000','--screenshot='+join(out,'viewer-page.png'),'http://127.0.0.1:'+server.port],{stdout:Bun.file(join(out,'browser.stdout.log')),stderr:Bun.file(join(out,'browser.stderr.log'))})
  const timeout=setTimeout(()=>{child.kill();reportResolve({status:'BLOCKED',errors:['浏览器60秒内未返回共享Viewer回执']})},60000)
  const report=await reportPromise;clearTimeout(timeout);receipt.viewer=report
  if(report.capture?.dataURL){await writeFile(join(out,'viewer-canvas.png'),Buffer.from(report.capture.dataURL.split(',')[1],'base64'));delete report.capture.dataURL}
  const exit=await child.exited;receipt.browserExit=exit;receipt.status=entityIds.length>0&&report.status==='PASSED'&&exit===0&&report.materials?.every((row:any)=>row.loaded&&(externalAsset?row.materials.some((m:any)=>m.hasTextures):row.materials.filter((m:any)=>m.hasTextures).length===2))&&receipt.sourceVerification.valid?'PASSED':'FAILED'
  if(receipt.status!=='PASSED')process.exitCode=1
 }finally{server.stop(true)}
}
await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({status:receipt.status,portable,out,browserExit:receipt.browserExit,viewerErrors:receipt.viewer?.errors},null,2))
