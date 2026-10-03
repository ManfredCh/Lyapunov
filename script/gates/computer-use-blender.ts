/**
 * Isolated DSH SDK profile -> local scripted adapter -> native computer-use tools.
 * Run with `node script/gates/computer-use-blender.ts`. The loopback control URL
 * accepts grounded native actions; every action is bracketed by window snapshots.
 * Only the owned Blender window may receive input or be captured. No paid model,
 * Blender Python, xdotool input, or replacement product web server is used.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, appendFile, symlink, stat, realpath } from 'node:fs/promises'
import { existsSync, appendFileSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { PRODUCT_ROOT, UPSTREAM, DSH_BIN } from '../profile.ts'
import { runtimePluginInsert, resolveBlenderExecutable } from '../runtime-patch.ts'

const PREFIX = 'cua_driver_native__'
const ACTIONS = new Set(['click', 'press_key', 'hotkey', 'type_text', 'scroll'])
type Row = Record<string, any> // External native MCP payloads are validated at each use below.

/** Extract the native MCP structured payload, including an empty windows array. */
export function structured(result: Row): Row {
  if (!result || typeof result.structuredContent !== 'object' || result.structuredContent === null || Array.isArray(result.structuredContent)) {
    throw new Error('Native result has no structuredContent')
  }
  return result.structuredContent
}

export function ownedWindows(result: Row, pid: number): Row[] {
  const windows = structured(result).windows
  if (!Array.isArray(windows)) throw new Error('Native list_windows returned no windows array')
  if (!Number.isSafeInteger(pid) || pid<=0) throw new Error('Owned process has no valid PID')
  return windows.filter((w: Row) => w && w.pid === pid && Number.isSafeInteger(w.window_id) && w.window_id > 0)
}

export function actionArguments(tool: string, args: Row, target: Row, mode: string): Row {
  if (!ACTIONS.has(tool)) throw new Error('Unsupported control command')
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object')
  for (const key of ['target','pid','window_id','session','screenshot_out_file','cursor_id','element_index','element_token','snapshot_id','from_zoom']) {
    if (key in args) throw new Error(`Caller cannot override ${key}`)
  }
  if ('scope' in args && args.scope !== 'window') throw new Error('Desktop scope is not permitted')
  if ('delivery_mode' in args && args.delivery_mode !== mode) throw new Error('Delivery mode must match the explicit gate launch setting')
  if (!target || !Number.isSafeInteger(target.pid) || target.pid<=0 || !Number.isSafeInteger(target.window_id) || target.window_id<=0) throw new Error('Exact owned target required')
  if (!['background','foreground'].includes(mode)) throw new Error('Invalid delivery mode')
  const fields:Record<string,string[]>={click:['button','count'],press_key:['key','modifiers'],hotkey:['keys'],type_text:['text'],scroll:['direction','amount','by']}
  const allowed=new Set(['x','y','scope','delivery_mode',...fields[tool]!])
  for(const key of Object.keys(args))if(!allowed.has(key))throw new Error(`Unsupported input field: ${key}`)
  if(('x' in args || 'y' in args) && (!Number.isFinite(args.x) || !Number.isFinite(args.y) || args.x<0 || args.y<0))throw new Error('Supply nonnegative finite x,y together')
  if(tool==='click' && !('x' in args))throw new Error('Grounded click requires x,y')
  if(tool==='press_key' && (typeof args.key!=='string' || !args.key))throw new Error('press_key requires key')
  if(tool==='type_text' && typeof args.text!=='string')throw new Error('type_text requires text')
  if(tool==='hotkey' && (!Array.isArray(args.keys) || args.keys.length<2 || args.keys.some((k:unknown)=>typeof k!=='string' || !k)))throw new Error('hotkey requires keys')
  if(tool==='scroll' && !['up','down','left','right'].includes(args.direction))throw new Error('scroll requires direction')
  return { ...args, pid:target.pid, window_id:target.window_id, scope:'window', session:'blender-gate', delivery_mode:mode }
}

export function assertScreenshotCoordinates(args: Row, state: Row): void {
  if (!('x' in args) && !('y' in args)) return
  if (!Number.isFinite(state.screenshot_width) || state.screenshot_width<=0 ||
      !Number.isFinite(state.screenshot_height) || state.screenshot_height<=0 ||
      !Number.isFinite(args.x) || !Number.isFinite(args.y) || args.x<0 || args.y<0 ||
      args.x>=state.screenshot_width || args.y>=state.screenshot_height) {
    throw new Error('Input coordinates outside fresh owned screenshot')
  }
}

/** Container sanity only, not a geometry parser or proof of a UI operation. */
export function blendHeader(bytes: Buffer): Row {
  let decoded: Buffer, compression='none'
  try {
    if (bytes.subarray(0,4).equals(Buffer.from([0x28,0xb5,0x2f,0xfd]))) {
      compression='zstd'; decoded=zstdDecompressSync(bytes,{maxOutputLength:128*1024*1024})
    } else if (bytes[0]===0x1f && bytes[1]===0x8b) {
      compression='gzip'; decoded=gunzipSync(bytes,{maxOutputLength:128*1024*1024})
    } else decoded=bytes
    const header=decoded.subarray(0,17).toString('ascii')
    return {ok:decoded.length>=17 && /^BLENDER(?:[-_][vV][0-9]{3}|17-01v[0-9]{4})/.test(header),compression,header,geometryValidated:false}
  } catch(error) { return {ok:false,compression,error:String(error),geometryValidated:false} }
}

export function savedTitleMatches(title: unknown, path: string): boolean {
  return typeof title==='string' && !title.trimStart().startsWith('*') && title.includes(`[${path}]`)
}

export function parseJsonLines(text: string): Row[] {
  return text.split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line))
}

/**
 * Validate the evidence chain without input/capture or modifying a saved scene.
 * Geometry meaning is explicitly an operator review of native screenshots, not
 * an automatic claim inferred from an action receipt or a nonempty .blend file.
 */
export async function verifyEvidence(root: string, review: Row): Promise<Row> {
  const checks:Row[]=[]
  const check=(name:string,ok:boolean,detail:unknown)=>checks.push({name,ok,detail})
  const json=async(name:string)=>JSON.parse(await readFile(join(root,name),'utf8'))
  try {
    root=await realpath(root)
    const expectedRuntime=await realpath(join(PRODUCT_ROOT,'.runtime'))
    if(dirname(root)!==expectedRuntime || !basename(root).startsWith('computer-use-blender-')) throw new Error('Evidence must be an owned computer-use-blender run directory')
    const route=await json('route.json'), launch=await json('blender-launch.json')
    const results=parseJsonLines(await readFile(join(root,'tool-results.jsonl'),'utf8'))
    const events=parseJsonLines(await readFile(join(root,'session-events.jsonl'),'utf8'))
    const calls=events.filter(e=>e.type==='tool/call').map(e=>({...e.data,time:e.time,args:JSON.parse(e.data.arguments)}))
    const successful=(c:Row)=>results.some(r=>r.id===c.callId && r.name===c.name && r.result?.isError===false && !r.result?.value?.isError)
    const attemptedActions=calls.filter(c=>c.name.startsWith(PREFIX) && ACTIONS.has(c.name.slice(PREFIX.length)))
    const nativeActions=attemptedActions.filter(successful)
    check('supported_local_sdk_route',route.paidModelCalls===0 && route.modelAutonomy===false &&
      ['lyapunov-computer-use','lyapunov-computer-use-cua-native'].every(id=>route.selected?.some((entry:Row)=>entry.id===id)) &&
      events.some(e=>e.type==='assistant/message' && e.data.message?.source?.provider==='blender-local-scripted'),
      {profile:route.profile,paidModelCalls:route.paidModelCalls,modelAutonomy:route.modelAutonomy})
    check('only_owned_native_inputs',nativeActions.length>0 && attemptedActions.every(c=>c.args.pid===launch.pid && Number.isSafeInteger(c.args.window_id) && c.args.window_id>0 && c.args.scope!=='desktop' && !c.args.target),{pid:launch.pid,successfulActions:nativeActions.length,attemptedActions:attemptedActions.length,deliveryModes:[...new Set(attemptedActions.map(c=>c.args.delivery_mode))]})
    const start=calls.find(c=>c.name===PREFIX+'start_recording' && successful(c))
    check('window_only_recording',Boolean(start && start.args.record_video===false && start.args.output_dir===join(root,'trajectory')), {start:start?.callId,video:false})
    const final=structured(await json('final.json'))
    const finalCall=calls.findLast(c=>c.name===PREFIX+'get_window_state' && c.args.screenshot_out_file===join(root,'final.png') && successful(c))
    const pngValid=async(path:string)=>{
      const canonical=await realpath(path)
      if(dirname(canonical)!==root)throw new Error('Screenshot outside evidence directory')
      const bytes=await readFile(canonical)
      return bytes.length>24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    }
    check('fresh_owned_final_snapshot',Boolean(finalCall && final.pid===launch.pid && final.window_id===finalCall.args.window_id && await pngValid(join(root,'final.png'))),{callId:finalCall?.callId,title:final.window_title})
    const modeled=review?.modeling
    const validReview=review?.method==='ocr' || review?.method==='visual'
    check('explicit_operator_review',Boolean(validReview && typeof review.reviewer==='string' && review.reviewer.trim() && Array.isArray(modeled) && modeled.length>0), {method:review?.method,reviewer:review?.reviewer,meaning:'Operator-reviewed screenshots, not automatic geometry validation'})
    let lastModelTime=0, lastModelSequence=0
    if(Array.isArray(modeled))for(const observation of modeled) {
      const sequence=observation.actionSequence
      const action=nativeActions.find(c=>c.callId===`native-${sequence}`)
      const screenshot=typeof observation.screenshot==='string'?observation.screenshot:''
      const safeName=/^[a-z0-9-]+\.png$/i.test(screenshot)
      const snap=safeName?calls.find(c=>c.name===PREFIX+'get_window_state' && c.args.screenshot_out_file===join(root,screenshot) && successful(c)):undefined
      const ok=Boolean(Number.isSafeInteger(sequence) && screenshot===`after-${sequence}.png` && action && snap && snap.time>=action.time &&
        snap.args.pid===launch.pid && snap.args.window_id===action.args.window_id &&
        typeof observation.observation==='string' && observation.observation.trim() && await pngValid(join(root,screenshot)))
      check('modeling_screenshot_review',ok,{...observation,actionId:action?.callId,snapshotId:snap?.callId})
      if(ok) {lastModelTime=Math.max(lastModelTime,action.time);lastModelSequence=Math.max(lastModelSequence,sequence)}
    }
    const save=nativeActions.find(c=>c.callId===`native-${review?.save?.actionSequence}`)
    const savedPath=join(root,'native-cua-model.blend')
    const saved=await stat(savedPath).catch(()=>null)
    const savedCanonical=saved?await realpath(savedPath):''
    if(saved && savedCanonical!==savedPath)throw new Error('Saved scene must be a regular file in this run, not an external symlink')
    const header=saved?.isFile()?blendHeader(await readFile(savedPath)):{ok:false}
    check('post_model_save_and_container',Boolean(lastModelSequence>0 && save && review.save && Number.isSafeInteger(review.save.actionSequence) && review.save.actionSequence>lastModelSequence && finalCall && finalCall.time>=save.time &&
      savedCanonical===savedPath && saved?.isFile() && saved.size>16 && saved.mtimeMs>=lastModelTime-1000 && header.ok && savedTitleMatches(final.window_title,savedPath)),
      {saveAction:save?.callId,bytes:saved?.size,modifiedAt:saved?.mtime.toISOString(),title:final.window_title,...header})
  } catch(error) {check('evidence_readable',false,String(error))}
  const ok=checks.length>0 && checks.every(c=>c.ok)
  return {ok,classification:ok?'operator_reviewed_native_ui_acceptance':'incomplete_native_ui_evidence',checkedAt:new Date().toISOString(),checks,review,geometryAutomaticallyValidated:false}
}

export function adapterSource(resultFile: string, catalogFile: string): string {
  return `import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { appendFile, writeFile } from 'node:fs/promises';
class Scripted extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id:model, name:model, inputModalities:['text','image'] }; }
  async *stream(options) {
    const user=options.messages.findLast(m=>m.role==='user' && m.source?.kind==='user');
    const command=JSON.parse(user.content.filter(b=>b.type==='text').map(b=>b.text).join(''));
    const done=options.messages.some(m=>m.content.some(b=>b.type==='tool-result' && b.toolCallId===command.id));
    if (!done) {
      const args=JSON.stringify(command.args), id=ToolCallId(command.id);
      yield {type:'block-start',index:0,blockType:'tool-call'};
      yield {type:'tool-call-delta',index:0,id,name:command.tool,argumentsDelta:args};
      yield {type:'block-end',index:0,block:{type:'tool-call',id,name:command.tool,arguments:args}};
      yield {type:'finish',reason:{kind:'tool-calls'}};
    } else {
      yield {type:'block-start',index:0,blockType:'text'};
      yield {type:'text-delta',index:0,text:'Native call completed; inspect the real tool result.'};
      yield {type:'block-end',index:0,block:{type:'text',text:'Native call completed; inspect the real tool result.'}};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
}
export const name='computer-use-blender-scripted-adapter';
export const inject=['llm','tools'];
export function apply(ctx) {
  ctx.llm.registerAdapter(['blender-local-scripted'],new Scripted());
  ctx.on('tools/execute',async (exec,next)=>{
    const result=await next();
    if(exec.name.startsWith('${PREFIX}')) await appendFile(${JSON.stringify(resultFile)},JSON.stringify({id:exec.callId,name:exec.name,result})+'\\n');
    return result;
  });
  ctx.on('llm/stream',async function* (options,next) {
    await writeFile(${JSON.stringify(catalogFile)},JSON.stringify(options.tools,null,2)+'\\n');
    yield* next();
  });
}
`
}

/** Launch and own the isolated profile, Blender process, and control listener. */
export async function nativeGate(): Promise<void> {
  await mkdir(join(PRODUCT_ROOT,'.runtime'),{recursive:true})
  const root = await mkdtemp(join(PRODUCT_ROOT, '.runtime/computer-use-blender-'))
  const deliveryMode=process.env.COMPUTER_USE_BLENDER_FOREGROUND==='1'?'foreground':'background'
  await writeFile(join(root,'gate-source.ts'),await readFile(new URL(import.meta.url),'utf8'))
  const resultFile = join(root, 'tool-results.jsonl')
  const home = join(root, 'home')
  await mkdir(home)
  await writeFile(resultFile, '')
  const selected = runtimePluginInsert({ mode:'developer', surface:'web', sceneRoot:join(root,'scene') })
    .filter(entry => entry.id === 'lyapunov-computer-use' || entry.id === 'lyapunov-computer-use-cua-native')
  if (selected.length !== 2) throw new Error('Product web composition does not expose native computer use on this host')
  const profile = 'computer-use-blender'
  const dshHome = join(root, 'dsh')
  const profileDir = join(dshHome, 'profiles', profile)
  await mkdir(profileDir, { recursive:true })
  await symlink(join(UPSTREAM,'node_modules'),join(profileDir,'node_modules'),'dir')
  await writeFile(join(profileDir,'package.json'), JSON.stringify({name:'computer-use-blender-test-profile',private:true,type:'module',dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-sdk-app'],patchReload:'startup'}}},null,2)+'\n')
  await writeFile(join(profileDir,'cordis.patch.yml'),'[]\n')
  const adapter = join(root,'scripted-adapter.mjs')
  await writeFile(adapter, adapterSource(resultFile,join(root,'model-tool-catalog.json')))
  const patch = join(root,'native.cordis.patch.yml')
  // JSON is a YAML subset; select the exact native entries returned by product wiring.
  await writeFile(patch,JSON.stringify([{insert:[...selected,{id:'blender-local-scripted',name:adapter}]}],null,2)+'\n')
  await writeFile(join(root,'route.json'),JSON.stringify({route:'DSH SDK profile -> local scripted model adapter -> production native provider -> Cua Driver',profile,dshBin:DSH_BIN,selected,deliveryMode,paidModelCalls:0,modelAutonomy:false,video:false,videoReason:'Native video captures the full display; evidence is restricted to the owned Blender window.'},null,2)+'\n')
  const allowedEnv = ['PATH','DISPLAY','WAYLAND_DISPLAY','XAUTHORITY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','LANG','USER','LOGNAME']
  const env:NodeJS.ProcessEnv = Object.fromEntries(allowedEnv.flatMap(k=>process.env[k]===undefined?[]:[[k,process.env[k]!]]))
  Object.assign(env,{HOME:home,XDG_CONFIG_HOME:join(home,'config'),XDG_CACHE_HOME:join(home,'cache'),DSH_TELEMETRY_DISABLED:'1'})
  const harness = new DeepSeekHarness({dshBin:DSH_BIN,profile,patches:[patch],dshHome,processCwd:root,cwd:root,env,provider:'blender-local-scripted',model:'scripted-native-acceptance',initializeTimeoutMs:60000})
  let blender:ChildProcess|undefined, target:Row|undefined, sessionId:string|undefined
  let sequence=0, recording=false, actions=0, closing=false, ready=false
  let blocker:string|null=null
  let queue=Promise.resolve()
  let cleanupPromise:Promise<void>|undefined, idleTimer:ReturnType<typeof setTimeout>|undefined
  const ensureRunning=()=>{if(closing)throw new Error('Gate shutdown requested')}
  const requestStop=()=>{
    closing=true;process.exitCode=2
    // Do not tear down the SDK midway through startup or an input call.
    // Startup checks the flag before creating another owned resource.
    if(ready)queue=queue.then(()=>cleanup()).catch(error=>console.error(String(error)))
  }
  const armIdle=()=>{
    clearTimeout(idleTimer)
    idleTimer=setTimeout(()=>{blocker='No control request for 15 minutes';requestStop()},15*60*1000)
  }
  const checks:Row[]=[]
  const savePath=join(root,'native-cua-model.blend')
  const server=createServer()
  const record = async (name:string,ok:boolean,detail:unknown) => { checks.push({name,ok,detail}); await writeFile(join(root,'status.json'),JSON.stringify({root,checks,blocker,target,actions,savePath},null,2)+'\n') }
  const call = async (tool:string,args:Row):Promise<Row> => {
    const id=`native-${++sequence}`
    const run=await harness.run(JSON.stringify({id,tool:PREFIX+tool,args}),{...(sessionId?{sessionId}:{} )})
    sessionId=run.sessionId
    await appendFile(join(root,'session-events.jsonl'),run.events.map(event=>JSON.stringify(event)).join('\n')+'\n')
    const row=(await readFile(resultFile,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).findLast(row=>row.id===id)
    if (!row) throw new Error(`No real native result for ${tool}: ${run.finalResponse}`)
    if(row.result.isError || row.result.value?.isError) throw new Error(`${tool}: ${JSON.stringify(row.result)}`)
    const value=row.result.value
    if(!value || typeof value!=='object') throw new Error(`No native MCP value from ${tool}`)
    return value
  }
  const snapshot = async (label:string) => {
    if(!target) throw new Error('No owned Blender window')
    const value=await call('get_window_state',{...target,session:'blender-gate',include_accessibility_tree:false,include_screenshot:true,screenshot_out_file:join(root,`${label}.png`)})
    const state=structured(value)
    if(state.pid!==target.pid || state.window_id!==target.window_id || state.screenshot_file_path!==join(root,`${label}.png`))throw new Error('Snapshot did not prove the exact owned window')
    await writeFile(join(root,`${label}.json`),JSON.stringify(value,null,2)+'\n')
    return value
  }
  const cleanup = ():Promise<void> => {
    if(cleanupPromise)return cleanupPromise
    closing=true
    clearTimeout(idleTimer)
    cleanupPromise=(async()=>{
      if(server.listening)server.close()
      let sdkClosed=false
      if(recording) {
        try {
          const state=structured(await call('get_recording_state',{}))
          if(state.output_dir!==join(root,'trajectory'))throw new Error('Recorder ownership changed; refusing to stop another recording')
          const stopped=structured(await call('stop_recording',{}))
          recording=Boolean(stopped.enabled || stopped.recording)
          await record('recording_cleanup',!recording,stopped)
        } catch(error) {await record('recording_cleanup',false,String(error));process.exitCode=2}
      }
      try {await harness.close();sdkClosed=true} catch(error) {await record('sdk_cleanup',false,String(error));process.exitCode=2}
      if(blender && blender.exitCode===null && blender.signalCode===null) {
        const exited=once(blender,'exit'); blender.kill('SIGTERM')
        const timer=setTimeout(()=>blender?.kill('SIGKILL'),5000)
        try {await exited} finally {clearTimeout(timer)}
      }
      await record('owned_processes_closed',sdkClosed && (!blender || blender.exitCode!==null || blender.signalCode!==null),
        {sdkCloseResolved:sdkClosed,blenderExit:blender?.exitCode,blenderSignal:blender?.signalCode,recordingStopConfirmed:!recording})
    })()
    return cleanupPromise
  }
  const onSignal=()=>requestStop()
  process.once('SIGTERM',onSignal)
  process.once('SIGINT',onSignal)
  try {
    await harness.start()
    ensureRunning()
    await record('supported_sdk_started',true,{profile})
    const permissions=await call('check_permissions',{})
    await writeFile(join(root,'permissions.json'),JSON.stringify(permissions,null,2)+'\n')
    await record('native_permissions_called',true,structured(permissions))
    const executable=resolveBlenderExecutable()
    const version=spawnSync(executable,['--version'],{encoding:'utf8',env})
    await record('blender_version',version.status===0,version.stdout?.split('\n')[0])
    ensureRunning()
    if(version.status!==0)throw new Error('Blender version probe failed')
    blender=spawn(executable,['--factory-startup','--window-geometry','0','0','1000','720'],{cwd:root,env:{...env,LIBGL_ALWAYS_SOFTWARE:'1',GALLIUM_DRIVER:'llvmpipe'},stdio:['ignore','pipe','pipe']})
    const logChunk=(chunk:Buffer)=>{try {appendFileSync(join(root,'blender.log'),chunk)} catch(error) {console.error(String(error))}}
    blender.stdout?.on('data',logChunk)
    blender.stderr?.on('data',logChunk)
    let launchError:Error|undefined
    blender.once('error',error=>{launchError=error})
    await writeFile(join(root,'blender-launch.json'),JSON.stringify({executable,pid:blender.pid,softwareGL:true},null,2)+'\n')
    const deadline=Date.now()+60000
    while(Date.now()<deadline) {
      ensureRunning()
      if(launchError)throw launchError
      const rows=ownedWindows(await call('list_windows',{pid:blender.pid,on_screen_only:true}),blender.pid!)
      const own=rows.find((w:Row)=>/blender/i.test(`${w.app_name ?? ''} ${w.title ?? ''}`))
      if(own){target={pid:own.pid,window_id:own.window_id};break}
      if(blender.exitCode!==null || blender.signalCode!==null)throw new Error('Owned Blender exited before discovery')
      await new Promise(resolve=>setTimeout(resolve,1000))
    }
    if(!target)throw new Error('Native list_windows did not discover the owned Blender window within 60 seconds')
    await record('owned_blender_discovered',true,target)
    await snapshot('initial')
    await record('fresh_blender_screenshot',existsSync(join(root,'initial.png')),join(root,'initial.png'))
    const recorder=structured(await call('get_recording_state',{}))
    if(recorder.enabled || recorder.recording)throw new Error('Another native recording is already active')
    ensureRunning()
    await call('start_recording',{output_dir:join(root,'trajectory'),record_video:false}); recording=true
    await record('native_window_trajectory_started',true,{video:false})
    ensureRunning()
    server.on('request',(request,response)=>{
      queue=queue.then(async()=>{
        try {
          ensureRunning(); armIdle()
          if(request.method==='GET') {response.setHeader('content-type','application/json');response.end(JSON.stringify({root,target,savePath,actions,checks}));return}
          if(request.method!=='POST'){response.statusCode=405;response.end(JSON.stringify({error:'POST required',root}));return}
          let body=''; for await(const chunk of request) {body+=chunk;if(body.length>1024*1024)throw new Error('Control request too large')}
          const command=JSON.parse(body)
          if(!command || typeof command!=='object' || Array.isArray(command))throw new Error('Control request must be an object')
          let result:unknown
          if(command.tool==='finish') {
            const review=command.review
            if(!review || typeof review!=='object' || Array.isArray(review))throw new Error('finish requires structured operator review')
            await snapshot('final')
            const evidence=await verifyEvidence(root,review)
            await writeFile(join(root,'evidence-verification.json'),JSON.stringify(evidence,null,2)+'\n')
            const ok=evidence.ok
            await record('modeled_and_saved_by_ui',ok,{evidenceFile:join(root,'evidence-verification.json'),classification:evidence.classification})
            if(!ok)process.exitCode=2
            result={ok,root,evidenceFile:join(root,'evidence-verification.json')}
            response.setHeader('content-type','application/json');response.end(JSON.stringify(result)); await cleanup(); return
          }
          if(command.tool==='list_windows') result=ownedWindows(await call('list_windows',{pid:blender!.pid,on_screen_only:true}),blender!.pid!)
          else if(command.tool==='select_window') {
            const rows=ownedWindows(await call('list_windows',{pid:blender!.pid,on_screen_only:true}),blender!.pid!)
            const own=rows.find(w=>w.window_id===command.window_id)
            if(!own)throw new Error('Requested window is not currently owned by this Blender process')
            target={pid:own.pid,window_id:own.window_id}
            result=await snapshot(`selected-${sequence+1}`)
          }
          else if(command.tool==='get_window_state') result=await snapshot(`state-${sequence+1}`)
          else if(ACTIONS.has(command.tool)) {
            const args=actionArguments(command.tool,command.args??{},target!,deliveryMode)
            const before=structured(await snapshot(`before-${sequence+1}`))
            assertScreenshotCoordinates(args,before)
            const actionSeq=sequence+1
            try {
              result=await call(command.tool,args)
              actions++
              await record('native_action_receipt',true,{tool:command.tool,sequence:actionSeq,deliveryMode,effect:structured(result as Row).effect??'unverified'})
            } finally {
              await new Promise(resolve=>setTimeout(resolve,250))
              try {await snapshot(`after-${actionSeq}`)} catch(error) {
                // Saving can close an owned modal. Retain the delivered receipt,
                // record missing post-state, and require explicit re-discovery.
                await record('action_post_snapshot',false,{actionSequence:actionSeq,error:String(error),next:'list_windows, then select_window'})
                if(result)result={...(result as Row),gateWarning:'Post-action window snapshot unavailable; list and select an owned window before proceeding.'}
                else throw error
              }
            }
          } else throw new Error('Unsupported control command')
          response.setHeader('content-type','application/json');response.end(JSON.stringify({root,result}))
        } catch(error) { response.statusCode=400;response.end(JSON.stringify({error:String(error),root})) }
      })
    })
    server.listen(0,'127.0.0.1'); await once(server,'listening')
    const serverClosed=once(server,'close')
    ensureRunning(); ready=true; armIdle()
    const address=server.address()
    const url=`http://127.0.0.1:${typeof address==='object'&&address?address.port:0}`
    await writeFile(join(root,'control.json'),JSON.stringify({url,root,target,savePath},null,2)+'\n')
    console.log(JSON.stringify({ready:true,url,root,target,savePath}))
    await serverClosed
    await cleanupPromise
  } catch(error) {
    blocker=String(error)
    await record('acceptance_blocked',false,blocker)
    console.error(JSON.stringify({root,blocker}))
    process.exitCode=2
    await cleanup()
  } finally {
    clearTimeout(idleTimer)
    process.removeListener('SIGTERM',onSignal)
    process.removeListener('SIGINT',onSignal)
  }
}

if(import.meta.main) {
  try {
    if(process.argv[2]==='--verify') {
      const root=process.argv[3], reviewFile=process.argv[4]
      if(!root || !reviewFile)throw new Error('Usage: --verify OWNED_RUN_DIR REVIEW_JSON')
      const review=JSON.parse(await readFile(reviewFile,'utf8'))
      const evidence=await verifyEvidence(root,review)
      // Only write after verifyEvidence established that this is an owned run.
      if(evidence.checks.some((c:Row)=>c.name==='supported_local_sdk_route'))await writeFile(join(root,'evidence-verification.json'),JSON.stringify(evidence,null,2)+'\n')
      console.log(JSON.stringify(evidence,null,2))
      if(!evidence.ok)process.exitCode=2
    } else await nativeGate()
  } catch(error) {console.error(String(error));process.exitCode=2}
}
