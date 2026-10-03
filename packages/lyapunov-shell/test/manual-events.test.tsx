import {test,expect} from 'bun:test'
import {renderToStaticMarkup} from 'react-dom/server'
import {jointTargetError,requireFullJointTargets,JointTargetInput} from '../src/joint-target-input.tsx'
import {RobotControlPanel,ActionCards} from '../src/robot-control-panel.tsx'
import {validateControlDisplay,validateRegisteredControlDisplay,projectControlActionRows,upsertControlActionRow} from '../src/control-gesture.ts'
import {workbenchAPI,bindControlExitState} from '../src/workbench-api.ts'
import {projectWireEvent} from '../../lyapunov-contracts/src/session-event-projection.ts'
import {deriveEventMessage} from '@deepseek-ai/dsh-session/surface'
import {Context} from '@deepseek-ai/cordis'
import SessionStore,{SessionId} from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
const sdkRoot=new URL('../../../.upstream/deepseek-harness-20260911-candidate/',import.meta.url).href
const sdkFixture=async()=>{const path=sdkRoot+'packages/client/ui-chat/src/client/conversation-nodes/';return {...await import(path+'command.ts'),...await import(sdkRoot+'packages/client/ui-conversation/src/client/conversation/assembler.ts'),...await import(path+'chat-snapshot-builder.ts')}}
const display=(sequence:number,phase:'update'|'final'|'stop'='update')=>({kind:'control-gesture' as const,clientId:'client',gestureId:'gesture',worldId:'world',generation:2,entityId:'robot',jointName:'j1',sequence,phase})
const at=(seq:number,type:string,data:any)=>({seq,time:seq*10,type,data})
const receipt=(id:string,reached=false)=>({actionId:id,status:'completed',effect:{motions:[{entityId:'robot',targetReached:reached,tolerance:.015}]}})
const events=()=>[at(1,'command/run',{commandId:'c1',name:'joint_move',source:{kind:'user'},display:display(1)}),at(2,'command/done',{commandId:'c1',kind:'success',text:JSON.stringify(receipt('a1')),display:display(1)}),at(3,'command/run',{commandId:'c2',name:'joint_move',source:{kind:'user'},display:display(2,'final')}),at(4,'command/done',{commandId:'c2',kind:'success',text:JSON.stringify(receipt('a2')),display:display(2,'final')})]
test('同gesture原始4事件保留，product一张卡、最终false与中间详情不变',()=>{
 const raw=events(),saved=JSON.stringify(raw),rows=projectControlActionRows(raw,v=>v,String)
 expect(rows).toHaveLength(1);expect(rows[0].display.phase).toBe('final');expect(rows[0].history).toHaveLength(2);expect(rows[0].receipt.effect.motions[0].targetReached).toBe(false);expect(JSON.stringify(raw)).toBe(saved)
 const html=renderToStaticMarkup(<ActionCards actions={rows} tr={cn=>cn}/>);expect(html.match(/class="lya-receipt"/g)).toHaveLength(1);expect(html).toContain('目标未到达');expect(html).toContain('2 条真实命令')
 const other={id:'other',label:'robot_move',waiting:false},updated={...rows[0],waiting:true}
 expect(upsertControlActionRow([other,rows[0]],updated).map(row=>row.id)).toEqual(['other',rows[0].id])
 expect(upsertControlActionRow([other,rows[0]],updated)[1].waiting).toBe(true)
 const malformed=projectControlActionRows([at(1,'command/run',{commandId:'invalid-1',name:'joint_move',display:{}}),at(2,'command/run',{commandId:'invalid-2',name:'joint_move',display:{}})],v=>v,String)
 expect(malformed).toHaveLength(2);expect(malformed[0].display).toBeUndefined()
 const legacy=projectControlActionRows([at(1,'command/run',{commandId:'legacy-command',name:'robot_move',args:JSON.stringify({action:{actionId:'legacy-action'}})})],v=>v,String)
 expect(legacy[0].id).toBe('legacy-action');expect(legacy[0].history).toHaveLength(1)
})
test('SDK真实事件组fold及assembler增量追加保持first seq，模型surface仍null',async()=>{
 const {gestureCommand,commandDefinition,ConversationNodeAssembler,chatViewDefinition}=await sdkFixture()
 const raw=events(),matches=raw.map(event=>({event,role:'update',key:'gesture'})) as any
 const node=gestureCommand(matches)!;expect(node.seq).toBe(1);expect(node.commandId).toBe('c2');expect(node.gestureHistory).toHaveLength(2);expect(node.outcome?.text).toContain('false')
 const definitions:any={entries:()=>[commandDefinition],fallbackEntry:()=>commandDefinition},views:any={entries:()=>[chatViewDefinition]}
 const assembly=new ConversationNodeAssembler(definitions,views);assembly.replaceWindow([],false);assembly.activateTarget("chat")
 for(const event of raw){expect(deriveEventMessage(event as any)).toBeNull();assembly.append({type:'event',event} as any);assembly.flush()}
 const snapshot:any=assembly.get('chat');expect(snapshot).toBeDefined()
 expect(snapshot.order).toHaveLength(1);const projected=snapshot.nodes.get(snapshot.order[0]);expect(projected.data.seq).toBe(1);expect(projected.data.gestureHistory).toHaveLength(2)
 const first=commandDefinition.match(raw[0] as any),last=commandDefinition.match(raw[3] as any);expect(first?.id).toBe(last?.id);expect(first?.role).toBe('update')
})
test('different client/world/generation/entity/joint/gesture不混组，late旧done不盖Stop',async()=>{
 const {gestureCommand}=await sdkFixture()
 const raw=events();for(const field of ['clientId','worldId','generation','entityId','jointName','gestureId']){
  const other={...display(3),[field]:field==='generation'?3:'other'};const rows=projectControlActionRows([...raw,at(5,'command/run',{commandId:'other',name:'joint_move',display:other})],v=>v,String);expect(rows).toHaveLength(2)
 }
 const stop=[...raw,at(5,'command/run',{commandId:'stop',name:'sim_stop',display:display(3,'stop')}),at(6,'command/done',{commandId:'stop',kind:'success',text:JSON.stringify({stopped:true,receipts:[{status:'cancelled'}]}),display:display(3,'stop')}),at(7,'command/done',{commandId:'c1',kind:'success',text:JSON.stringify(receipt('a1',true)),display:display(1)})]
 const node=gestureCommand(stop.map(event=>({event,role:'update'})) as any)!;expect(node.display?.phase).toBe('stop');expect(node.outcome?.text).toContain('stopped');expect(node.gestureHistory).toHaveLength(3)
 const rows=projectControlActionRows(stop,v=>v,String);expect(rows).toHaveLength(1);expect(rows[0].receipt.stopped).toBe(true);expect(rows[0].display.phase).toBe('stop')
 const html=renderToStaticMarkup(<ActionCards actions={rows} tr={cn=>cn}/>);expect(html).toContain('已停止');expect(html).toContain('stop')
})
test('UI metadata只关联显示并校验原动作/窗口scope，公开投影保false且不进模型',()=>{
 const input={worldId:'world',action:{kind:'joint',expectedGeneration:2,entityId:'robot',jointNames:['j1']}},selection={worldId:'world',clientId:'client'}
 expect(validateControlDisplay(display(1),'joint_move',input,selection,'client')).toEqual(display(1))
 expect(()=>validateControlDisplay({...display(1),entityId:'other'},'joint_move',input,selection,'client')).toThrow('INVALID_CONTROL_GESTURE_SCOPE')
 for(const event of events()){const wire:any=projectWireEvent(event,{},true);expect(wire.seq).toBe(event.seq);expect(wire.data.display).toEqual(event.data.display);expect(deriveEventMessage(event as any)).toBeNull()}
 const secret:any=events()[0];secret.data.display.extraToken='private-secret';const publicEvent:any=projectWireEvent(secret,{},true);expect(publicEvent.data.display.extraToken).toBeUndefined();expect(secret.data.display.extraToken).toBe('private-secret')
 const facts={sceneId:'scene',entityId:'robot',worldId:'world',expectedGeneration:2,sceneRevision:3,appliedSceneRevision:3},owner={clientId:'client',facts,live:true},selected={...selection,sceneId:'scene'}
 expect(validateRegisteredControlDisplay(display(1),'joint_move',input,selected,owner,[])).toEqual(display(1))
 expect(()=>validateRegisteredControlDisplay(display(1),'joint_move',input,selected,undefined,[])).toThrow('CONTROL_WINDOW_NOT_REGISTERED')
 expect(()=>validateRegisteredControlDisplay(display(1),'joint_move',input,selected,{...owner,live:false},[])).toThrow('CONTROL_WINDOW_NOT_REGISTERED')
 for(const field of ['sceneId','entityId','worldId','expectedGeneration','appliedSceneRevision'])expect(()=>validateRegisteredControlDisplay(display(1),'joint_move',input,selected,{...owner,facts:{...facts,[field]:field==='expectedGeneration'||field==='appliedSceneRevision'?9:'other'}},[])).toThrow('CONTROL_SELECTION_CHANGED')
 const stopInput={worldId:'world',expectedGeneration:2,entityIds:['robot']}
 expect(validateRegisteredControlDisplay(display(3,'stop'),'sim_stop',stopInput,selected,{...owner,facts:{}},events())).toEqual(display(3,'stop'))
 expect(validateRegisteredControlDisplay(display(3,'stop'),'sim_stop',stopInput,selected,owner,[])).toBeUndefined()
 expect(validateRegisteredControlDisplay(undefined,'robot_move',input,selected,undefined,[])).toBeUndefined()
})
test('实际私有SDK executeDisplayed只追加原run/done，legacy接口保留且拒非法metadata',async()=>{
 const ctx=new Context();await ctx.plugin(SessionStore);await ctx.plugin(CommandRuntime)
 {
  const session=ctx.sessions.create(SessionId('manual-events-fixture')),agent:any={id:session.id,session}
  ctx.commands.register({name:'gesture_fixture',description:'fixture',handler:()=>({kind:'success',text:JSON.stringify(receipt('actual'))})})
  await ctx.commands.executeDisplayed(agent,'/gesture_fixture',[],display(1,'final'),new AbortController().signal)
  await ctx.commands.execute(agent,'/gesture_fixture',[],new AbortController().signal)
  const raw=session.snapshotEvents().filter((e:any)=>e.type==='command/run'||e.type==='command/done') as any[]
  expect(raw).toHaveLength(4);expect(raw[0].data.display).toEqual(display(1,'final'));expect(raw[1].data.display).toEqual(display(1,'final'));expect(raw[1].data.text).toContain('false');expect(raw[2].data.display).toBeUndefined();expect(raw[3].data.display).toBeUndefined()
  for(const event of raw)expect(deriveEventMessage(event as any)).toBeNull()
  await expect(ctx.commands.executeDisplayed(agent,'/gesture_fixture',[],{...display(2),phase:'invalid'} as any,new AbortController().signal)).rejects.toThrow('INVALID_COMMAND_DISPLAY')
 }
})
test('完整Panda草稿3rad越限/NaN/缺值禁提交，不静默clamp，正常同边界可发',()=>{
 const joint:any={name:'j1',range:[-2.8973,2.8973],unit:'rad',type:'hinge',controlMode:'position'},description:any={joints:[joint],controlledJointNames:['j1']}
 expect(jointTargetError(joint,3)).toBe('JOINT_TARGET_OUT_OF_RANGE');expect(()=>requireFullJointTargets(description,{j1:3})).toThrow('JOINT_TARGET_OUT_OF_RANGE');expect(()=>requireFullJointTargets(description,{j1:Number.NaN})).toThrow('NOT_FINITE');expect(()=>requireFullJointTargets(description,{})).toThrow('NOT_FINITE');expect(requireFullJointTargets(description,{j1:2.8973})).toEqual([2.8973])
 const html=renderToStaticMarkup(<JointTargetInput joint={joint} value={3} set={()=>{throw Error('SSR不提交')}} tr={cn=>cn}/>);expect(html).toContain('value="3"');expect(html).toContain('aria-invalid="true"');expect(html).toContain('超出实际限位')
 const panel=renderToStaticMarkup(<RobotControlPanel entity={{entityId:'robot',name:'robot'} as any} description={description} targets={{j1:3}} setTargets={()=>{}} ready duration={1} setDuration={()=>{}} describe={()=>{}} move={()=>{throw Error('非法草稿不可提交')}} fullMotion={()=>({} as any)} tr={cn=>cn}/>);expect(panel).toContain('JOINT_TARGET_OUT_OF_RANGE');expect(panel).toMatch(/disabled=""[^>]*>全部关节同步运动/)
})
test('实际workbenchAPI等待本窗口选择ACK，旧ACK/清scope不能释放新gesture，legacy与Stop不被拖慢',async()=>{
 const oldFetch=globalThis.fetch,commands:any[]=[],pending:Array<{input:any;resolve:(response:Response)=>void}>=[]
 globalThis.fetch=(async(url:unknown,options?:RequestInit)=>{
  const path=new URL(String(url),'http://fixture.invalid').pathname,input=JSON.parse(String(options?.body??'{}'))
  if(path.endsWith('/view-selection'))return new Promise<Response>(resolve=>pending.push({input,resolve}))
  commands.push(input);return Response.json({kind:'success',ui:{status:'completed'}})
 }) as typeof fetch
 const {clientId:_,...local}=display(1),selection={sceneId:'scene',worldId:'world'},action={worldId:'world',action:{kind:'joint',entityId:'robot',jointNames:['j1'],positions:[.5],expectedGeneration:2}}
 const ack=(item:{input:any;resolve:(response:Response)=>void},generation=2)=>item.resolve(Response.json({updated:true,facts:{sceneId:item.input.sceneId,worldId:item.input.worldId,entityId:item.input.entityId,expectedGeneration:generation}}))
 try{
  const api=workbenchAPI('api-gesture-fixture')
  const first=api.selection({...selection,entityId:'robot',sequence:1})
  const oldGesture=api.command('joint_move',action,selection,undefined,local).catch(error=>error)
  expect(commands).toHaveLength(0)
  const second=api.selection({...selection,entityId:'other',sequence:2})
  ack(pending.shift()!);await first
  expect(String(await oldGesture)).toContain('CONTROL_SELECTION_CHANGED');expect(commands).toHaveLength(0)
  const otherDisplay={...local,entityId:'other'},otherAction={...action,action:{...action.action,entityId:'other'}}
  const wrongGeneration=api.command('joint_move',otherAction,selection,undefined,otherDisplay).catch(error=>error)
  ack(pending.shift()!,3);await second
  expect(String(await wrongGeneration)).toContain('CONTROL_SELECTION_CHANGED');expect(commands).toHaveLength(0)

  const third=api.selection({...selection,entityId:'other',sequence:3})
  const current=api.command('joint_move',otherAction,selection,undefined,otherDisplay)
  ack(pending.shift()!);await third;await current
  expect(commands).toHaveLength(1);expect(commands[0].display.clientId).toBe(api.clientId);expect(commands[0].selection.clientId).toBe(api.clientId)
  const next=api.selection({...selection,entityId:'other',sequence:4})
  const cleared=api.command('joint_move',otherAction,selection,undefined,otherDisplay).catch(error=>error)
  api.clearControlSelection();ack(pending.shift()!);await next
  expect(String(await cleared)).toContain('CONTROL_SELECTION_CHANGED');expect(commands).toHaveLength(1)
  const otherAPI=workbenchAPI('another-api-gesture-fixture')
  await expect(otherAPI.command('joint_move',otherAction,selection,undefined,otherDisplay)).rejects.toThrow('CONTROL_SELECTION_CHANGED')
  expect(commands).toHaveLength(1)

  const waiting=api.selection({...selection,entityId:'other',sequence:5})
  await api.command('robot_move',otherAction,selection)
  expect(commands).toHaveLength(2);expect(commands[1].display).toBeUndefined()
  api.clearControlSelection()
  await api.command('sim_stop',{worldId:'world',expectedGeneration:2,entityIds:['other']},selection,undefined,{...otherDisplay,phase:'stop',sequence:2})
  expect(commands).toHaveLength(3);expect(commands[2].display.phase).toBe('stop')
  ack(pending.shift()!);await waiting
  const cancelledSelection=api.selection({...selection,entityId:'other',sequence:6}),controller=new AbortController()
  const cancelled=api.command('joint_move',otherAction,selection,controller.signal,otherDisplay).catch(error=>error)
  controller.abort();expect(String(await cancelled)).toContain('AbortError');expect(commands).toHaveLength(3)
  ack(pending.shift()!);await cancelledSelection;await Promise.resolve();expect(commands).toHaveLength(3)
 }finally{globalThis.fetch=oldFetch}
})
test('桌面committing真实订阅锁住晚到控制，flush失败解锁；Stop/读状态继续，清订阅不发动作',async()=>{
 const oldFetch=globalThis.fetch,commands:string[]=[],changed:boolean[]=[]
 let acknowledge!:(response:Response)=>void,listener:((value:boolean)=>void)|undefined,removed=0
 globalThis.fetch=(async(url:unknown,options?:RequestInit)=>{
  const path=new URL(String(url),'http://fixture.invalid').pathname,input=JSON.parse(String(options?.body??'{}'))
  if(path.endsWith('/view-selection'))return new Promise<Response>(resolve=>{acknowledge=resolve})
  commands.push(input.name);return Response.json({kind:'success',ui:{status:'completed'}})
 }) as typeof fetch
 const api=workbenchAPI('exit-control-fixture'),bridge={onExitStateChanged:(callback:(value:boolean)=>void)=>{listener=callback;callback(false);return()=>{listener=undefined;removed++}}}
 const release=bindControlExitState(bridge,api,value=>changed.push(value))
 try{
  const selection={sceneId:'scene',worldId:'world'},input={worldId:'world',action:{kind:'joint',expectedGeneration:2,entityId:'robot',jointNames:['j1'],positions:[.2]}},{clientId:_,...local}=display(1)
  const selected=api.selection({...selection,entityId:'robot',sequence:1}),late=api.command('joint_move',input,selection,undefined,local).catch(error=>error)
  listener!(true);expect(api.areControlsBlocked()).toBe(true)
  acknowledge(Response.json({updated:true,facts:{...selection,entityId:'robot',expectedGeneration:2}}));await selected
  expect(String(await late)).toContain('CONTROL_EXIT_IN_PROGRESS');expect(commands).toEqual([])
  await expect(api.command('robot_move',input,selection)).rejects.toThrow('CONTROL_EXIT_IN_PROGRESS')
  await expect(api.command('robot_flight',{operation:'hover'})).rejects.toThrow('CONTROL_EXIT_IN_PROGRESS')
  await api.command('sim_stop',{worldId:'world',expectedGeneration:2},selection)
  await api.command('scene_list',{})
  expect(commands).toEqual(['sim_stop','scene_list'])
  listener!(false);expect(api.areControlsBlocked()).toBe(false)
  await api.command('joint_move',input,selection,undefined,local)
  expect(commands).toEqual(['sim_stop','scene_list','joint_move']);expect(changed.at(-1)).toBe(false)
  release();expect(removed).toBe(1);expect(listener).toBeUndefined();expect(commands).toHaveLength(3)
 }finally{release();globalThis.fetch=oldFetch}
})
