/** 真实GLB沿公共导入/共享Viewer取三视图；独立软件WebGL，不启动World或占用用户浏览器。 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { SceneOperations } from '../../scene-kit/src/operations.ts'
import { importHuman } from '../src/operations.ts'
import { projectPathsOnly, resourceToken } from '../../lyapunov-contracts/src/product-paths.ts'
import type { HumanDefinition } from '../../lyapunov-contracts/src/types.ts'

const args = process.argv.slice(2), value = (key: string) => {
  const index = args.indexOf(key)
  if (index < 0 || !args[index + 1]) throw Error('缺少参数 ' + key)
  return args[index + 1]!
}
const assets = resolve(value('--assets')), out = resolve(value('--out'))
const source = JSON.parse(await readFile(join(assets, 'source.json'), 'utf8'))
const asset = resolve(assets, source.glb), bytes = await readFile(asset)
const sha256 = createHash('sha256').update(bytes).digest('hex')
if (bytes.length !== source.bytes || sha256 !== source.sha256) throw Error('HUMAN_SAMPLE_IDENTITY_MISMATCH')
await mkdir(out, { recursive: true })
const ops = new SceneOperations(join(out, 'catalog')), sceneId = 'appearance-preview'
await ops.create({ sceneId })
const imported = await importHuman(ops, { sceneId, expectedRevision: 0, path: asset, entityId: 'appearance-person', boneMapping: source.boneMapping, license: source.license, attribution: source.attribution, sourceUpAxis: source.sourceUpAxis, metersPerUnit: source.metersPerUnit, headingOffsetRad: source.headingOffsetRad })
const scene = imported.snapshot, definition = scene.entities.find(entity => entity.components.humanDefinition)!.components.humanDefinition as HumanDefinition
const height = definition.heightM
await writeFile(join(out, 'scene.json'), JSON.stringify(scene))
const entry = join(out, 'client.ts'), viewerModule = resolve(import.meta.dirname, '../../viewer/src/index.ts'), threeModule = fileURLToPath(import.meta.resolve('three'))
await writeFile(entry, `
import { createViewer } from ${JSON.stringify(viewerModule)};
import * as T from ${JSON.stringify(threeModule)};
const errors = [], events = [];
const event = message => { events.push(message); fetch('/event', {method:'POST',body:String(message)}) };
window.addEventListener('error',e => event('error: '+e.message));
window.addEventListener('unhandledrejection',e => event('rejection: '+e.reason));
const host = document.getElementById('canvas');
const viewer = createViewer({container:host,resolveResource:uri=>'/resource?uri='+encodeURIComponent(uri),onError:error=>errors.push(String(error))});
try {
 event('setScene-start');
 await viewer.setScene(await (await fetch('/scene')).json());
 event('setScene-ready');
 const captures = {}, height = ${JSON.stringify(height)};
 for (const view of ['front','side','close']) {
  const target = [0,0,height*(view==='close'?.84:.53)];
  const eye = view==='side'?[0,-3.7,height*.58]:view==='close'?[1.6,-.45,height*.88]:[3.5,-.7,height*.62];
  const camera = new T.PerspectiveCamera(45,host.clientWidth/host.clientHeight,.01,100);
  camera.up.set(0,0,1);camera.position.fromArray(eye);camera.lookAt(new T.Vector3(...target));camera.updateMatrixWorld();
  viewer.setViewState({position:eye,target,quaternion:camera.quaternion.toArray(),up:[0,0,1],fovDeg:45,near:.01,far:100},{focus:false});
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  captures[view] = viewer.capture();
 }
 const materialDetails = [];
 viewer.objects.get('appearance-person').visual.traverse(object=>{
  if(object.isMesh)for(const material of Array.isArray(object.material)?object.material:[object.material])materialDetails.push({name:material.name,physical:!!material.isMeshPhysicalMaterial,baseColorMap:!!material.map,normalMap:!!material.normalMap,specularColorMap:!!material.specularColorMap});
 });
 const canvas=host.querySelector('canvas'),gl=canvas.getContext('webgl2')||canvas.getContext('webgl'),debug=gl.getExtension('WEBGL_debug_renderer_info');
 await fetch('/report',{method:'POST',body:JSON.stringify({status:errors.length?'FAILED':'CAPTURED_STATIC_APPEARANCE',errors,events,captures,materialDetails,materialStatus:viewer.materialStatus('appearance-person'),renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)})});
} catch(error) {await fetch('/report',{method:'POST',body:JSON.stringify({status:'FAILED',error:String(error),errors,events})})}
`)
const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' })
if (!built.success) throw Error(String(built.logs))
const bundle = await built.outputs[0]!.text()
const representations = new Map(scene.entities.flatMap(entity => entity.resources.flatMap(ref => [ref.original, ...ref.representations])).map(rep => [resourceToken(rep.uri), rep]))
let done!: (report: Record<string, any>) => void
const finished = new Promise<Record<string, any>>(resolve => { done = resolve })
const events: Array<{ at: string; message: string }> = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url)
  if (url.pathname === '/') return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0;color:white;background:#18212c;font:18px sans-serif}header{padding:20px}#canvas{position:absolute;inset:80px 0 0}</style><header>真实角色 · 项目共享Viewer · 静态外观（不是World/GPU验收）</header><div id="canvas"></div><script type="module" src="/client.js"></script>', { headers: { 'content-type': 'text/html' } })
  if (url.pathname === '/client.js') return new Response(bundle, { headers: { 'content-type': 'application/javascript' } })
  if (url.pathname === '/scene') return Response.json(projectPathsOnly(scene))
  if (url.pathname === '/resource') {
    const rep = representations.get(url.searchParams.get('uri') ?? '')
    return rep ? new Response(await ops.resources.readVerifiedResource(scene, rep.uri), { headers: { 'content-type': rep.mimeType } }) : new Response('未登记资源', { status: 403 })
  }
  if (url.pathname === '/event') { events.push({ at: new Date().toISOString(), message: await request.text() }); return new Response('ok') }
  if (url.pathname === '/report') { done(await request.json() as Record<string, any>); return new Response('ok') }
  return new Response('not found', { status: 404 })
} })
const command = ['/usr/bin/microsoft-edge', '--headless=new', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + join(out, 'profile'), '--window-size=1280,900', server.url.href]
const child = Bun.spawn(command, { env: { ...process.env, CUDA_VISIBLE_DEVICES: '' }, stdout: Bun.file(join(out, 'browser.log')), stderr: Bun.file(join(out, 'browser.stderr.log')) })
let reported = false
child.exited.then(exitCode => { if (!reported) done({ status: 'BROWSER_EXITED_BEFORE_REPORT', browserExit: exitCode }) })
const timer = setTimeout(() => { done({ status: 'TIMED_OUT' }) }, 60_000)
try {
  const report = await finished
  reported = true
  clearTimeout(timer)
  for (const [name, capture] of Object.entries(report.captures ?? {}) as Array<[string, any]>) {
    if (!['front', 'side', 'close'].includes(name) || !capture.dataURL?.startsWith('data:image/png;base64,')) throw Error('HUMAN_CAPTURE_INVALID')
    await writeFile(join(out, name + '.png'), Buffer.from(capture.dataURL.split(',')[1], 'base64'))
    delete capture.dataURL
  }
  child.kill()
  report.browserExit = await child.exited
  report.browserTermination = 'own-headless-terminated-after-report'
  report.scope = '公共导入/ResourceLibrary/共享Viewer的静态外观；CPU软件WebGL，无Provider/World/原生动作或GPU性能结论'
  report.source = { avatarId: source.avatarId, bytes: bytes.length, sha256 }
  report.events = events
  report.command = command
  await writeFile(join(out, 'receipt.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, avatarId: source.avatarId, renderer: report.renderer, error: report.error, out }))
  if (report.status !== 'CAPTURED_STATIC_APPEARANCE' || !report.renderer?.includes('SwiftShader') || Object.keys(report.captures ?? {}).length !== 3) process.exitCode = 1
} finally {
  clearTimeout(timer)
  if (child.exitCode === null) child.kill()
  server.stop(true)
}
