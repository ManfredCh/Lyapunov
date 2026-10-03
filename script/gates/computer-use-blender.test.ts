import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { Script, createContext } from 'node:vm'
import { actionArguments, adapterSource, assertScreenshotCoordinates, blendHeader, ownedWindows, parseJsonLines, savedTitleMatches, structured, verifyEvidence } from './computer-use-blender.ts'

const target={pid:38,window_id:260046850}

test('MCP structuredContent, not the envelope, is authoritative',()=>{
  assert.deepEqual(structured({structuredContent:{windows:[]}}),{windows:[]})
  assert.throws(()=>structured({windows:[]}),/structuredContent/)
  assert.throws(()=>structured({structuredContent:[]}),/structuredContent/)
  assert.throws(()=>structured({structuredContent:null}),/structuredContent/)
})

test('owned window discovery filters other PIDs and malformed window IDs',()=>{
  const owned={...target,title:'Blender'}
  assert.deepEqual(ownedWindows({structuredContent:{windows:[owned,{pid:99,window_id:1},{pid:38,windowId:3},{pid:38,window_id:0},null]}},38),[owned])
  assert.throws(()=>ownedWindows({structuredContent:{windows:[]}},0),/PID/)
  assert.throws(()=>ownedWindows({structuredContent:{}},38),/windows array/)
})

test('native input is exact-window scoped and foreground must be explicit',()=>{
  assert.deepEqual(actionArguments('press_key',{key:'s',x:400,y:350},target,'foreground'),{
    key:'s',x:400,y:350,...target,scope:'window',session:'blender-gate',delivery_mode:'foreground',
  })
  assert.equal(actionArguments('hotkey',{keys:['ctrl','s']},target,'background').delivery_mode,'background')
  for(const key of ['target','pid','window_id','session','screenshot_out_file','cursor_id','element_token','snapshot_id','from_zoom']) {
    assert.throws(()=>actionArguments('click',{x:1,y:2,[key]:'override'},target,'background'),/override/)
  }
  assert.throws(()=>actionArguments('click',{x:1,y:2,scope:'desktop'},target,'background'),/Desktop/)
  assert.throws(()=>actionArguments('click',{x:1,y:2,delivery_mode:'foreground'},target,'background'),/launch setting/)
  assert.throws(()=>actionArguments('start_recording',{record_video:true},target,'foreground'),/Unsupported/)
  assert.throws(()=>actionArguments('click',{x:1,y:2,unexpected:1},target,'foreground'),/Unsupported input/)
})

test('malformed coordinates, targets and required input values fail closed',()=>{
  for(const args of [{},{x:1},{x:NaN,y:2},{x:-1,y:2}])assert.throws(()=>actionArguments('click',args,target,'background'))
  assert.throws(()=>actionArguments('click',{x:1,y:2},{pid:38,windowId:1},'background'),/Exact owned target/)
  assert.throws(()=>actionArguments('press_key',{},target,'background'),/requires key/)
  assert.throws(()=>actionArguments('hotkey',{keys:['ctrl']},target,'background'),/requires keys/)
  assert.throws(()=>actionArguments('type_text',{text:3},target,'background'),/requires text/)
  assert.throws(()=>actionArguments('scroll',{direction:'elsewhere'},target,'background'),/requires direction/)
})

test('coordinates stay inside the fresh owned screenshot',()=>{
  const state={screenshot_width:1000,screenshot_height:720}
  assert.doesNotThrow(()=>assertScreenshotCoordinates({x:0,y:0},state))
  assert.doesNotThrow(()=>assertScreenshotCoordinates({x:999,y:719},state))
  for(const args of [{x:1000,y:1},{x:1,y:720},{x:-1,y:1},{x:1,y:Number.NaN},{x:1},{y:1}])assert.throws(()=>assertScreenshotCoordinates(args,state),/coordinates/)
  assert.throws(()=>assertScreenshotCoordinates({x:1,y:1},{screenshot_width:0,screenshot_height:720}),/coordinates/)
})

test('saving requires exact native path and no dirty marker',()=>{
  const path='/owned/run/native-cua-model.blend'
  assert.equal(savedTitleMatches(`native-cua-model [${path}] - Blender`,path),true)
  for(const title of [`* native-cua-model [${path}] - Blender`,'native-cua-model - Blender','(Unsaved) - Blender',`native-cua-model [/other/native-cua-model.blend] - Blender`,null])assert.equal(savedTitleMatches(title,path),false)
})

test('container sanity accepts raw/gzip/zstd headers, never validates geometry',()=>{
  // Synthetic in-memory bytes only: these are not modeled or saved Blender scenes.
  const legacy=Buffer.from('BLENDER-v402'+'\0'.repeat(20))
  const current=Buffer.from('BLENDER17-01v0502'+'\0'.repeat(20))
  for(const bytes of [legacy,current,gzipSync(legacy),zstdCompressSync(current)]){
    const result=blendHeader(bytes)
    assert.equal(result.ok,true)
    assert.equal(result.geometryValidated,false)
  }
  for(const bytes of [Buffer.alloc(0),Buffer.from('not a Blender scene'),Buffer.from([0x28,0xb5,0x2f,0xfd,0])])assert.equal(blendHeader(bytes).ok,false)
})

test('JSONL parser handles trailing lines but rejects truncated evidence',()=>{
  assert.deepEqual(parseJsonLines('{"id":1}\n\n'),[{id:1}])
  assert.throws(()=>parseJsonLines('{"id":'))
})

test('scripted adapter chooses real user command, emits one tool then stops',async()=>{
  const registered:any[]=[]
  const source=adapterSource('/unused-results','/unused-catalog')
    .replace("import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';",'')
    .replace("import { appendFile, writeFile } from 'node:fs/promises';",'')
    .replaceAll('export ','')+'\napply(ctx);'
  const context=createContext({LlmAdapter:class{},ToolCallId:(id:string)=>id,appendFile:async()=>{},writeFile:async()=>{},ctx:{llm:{registerAdapter:(name:unknown,adapter:unknown)=>registered.push(adapter)},on:()=>{}}})
  new Script(source).runInContext(context)
  const adapter=registered[0]
  const command={id:'native-1',tool:'cua_driver_native__press_key',args:{key:'Return',...target}}
  const messages=[{role:'user',source:{kind:'user'},content:[{type:'text',text:JSON.stringify(command)}]},{role:'user',source:{kind:'runtime-context'},content:[{type:'text',text:'Current runtime context is not JSON'}]}]
  const chunks=[]
  for await(const chunk of adapter.stream({messages}))chunks.push(chunk)
  const call=chunks.find(c=>c.type==='block-end').block
  assert.equal(call.name,command.tool)
  assert.deepEqual(JSON.parse(call.arguments),command.args)
  messages.push({role:'user',source:{kind:'tool'},content:[{type:'tool-result',toolCallId:'native-1'}] as any})
  const completed=[]
  for await(const chunk of adapter.stream({messages}))completed.push(chunk)
  assert.equal(completed.some(c=>c.blockType==='tool-call'),false)
  assert.equal(completed.at(-1).reason.kind,'stop')
})

test('offline verification rejects nonexistent evidence instead of green-by-review',async()=>{
  const result=await verifyEvidence('/not-a-gate-run',{method:'visual',reviewer:'test',modeling:[{observation:'looks good'}]})
  assert.equal(result.ok,false)
  assert.equal(result.geometryAutomaticallyValidated,false)
  assert.equal(result.classification,'incomplete_native_ui_evidence')
})
