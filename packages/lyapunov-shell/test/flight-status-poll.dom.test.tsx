import {expect,test} from 'bun:test'
import {createRequire} from 'node:module'

test('飞控面板用只读状态轮询，只有用户动作调用原命令',async()=>{
 const req=createRequire(new URL('../../../.upstream/deepseek-harness-0.2.0-rc.2/package.json',import.meta.url)),{JSDOM}=req('jsdom')
 const dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.invalid'}),saved=new Map<string,PropertyDescriptor|undefined>()
 for(const key of ['window','document','HTMLElement','Node','navigator','IS_REACT_ACT_ENVIRONMENT']){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value:key==='IS_REACT_ACT_ENVIRONMENT'?true:(dom.window as any)[key]})}
 const {createElement,act}=await import('react'),{createRoot}=await import('react-dom/client'),{FlightControlPanel}=await import('../src/flight-control-panel.tsx')
 const root=createRoot(document.getElementById('root')!),calls:any[]=[],reads:any[]=[]
 const entity={entityId:'quad',name:'fixture',components:{controller:{type:'drone'}}},world={worldId:'w',sceneId:'s',worldGeneration:1,appliedSceneRevision:2,engineId:'mujoco'}
 const mapping={available:true,frame:'body-root',units:{force:'N',torque:'Nm'},massKg:.027,bodyName:'quad/cf2',sourceSha256:'c1260dd47cded49edd5c1c02226529a5452a73f70000515f83bf223814037933',gravityWorldMps2:[0,0,-9.81],actuators:['body_thrust','x_moment','y_moment','z_moment'],matrix:[[0,0,0,0],[0,0,0,0],[1,0,0,0],[0,-1e-5,0,0],[0,0,-1e-5,0],[0,0,0,-1e-5]],limits:['body_thrust','x_moment','y_moment','z_moment'].map((name,i)=>({name,gain:1,ctrlrange:i===0?[0,.35]:[-1,1],forcerange:null}))}
 let status='idle'
 const readStatus=async(input:any)=>{reads.push(input);return {status}},command=async(name:string,input:any)=>{calls.push({name,input});status=input.operation==='hover'?'running':'idle';return {status}}
 try{
  await act(async()=>root.render(createElement(FlightControlPanel,{entity,world,description:{bodyWrench:mapping},ready:true,command,readStatus,tr:(zh:string)=>zh} as any)))
  await act(async()=>{await new Promise(done=>setTimeout(done,1100))})
  expect(reads.length).toBeGreaterThanOrEqual(2);expect(reads[0]).toEqual({worldId:'w',entityId:'quad',expectedGeneration:1,expectedSceneRevision:2});expect(calls).toHaveLength(0)
  const hover=[...document.querySelectorAll('button')].find(button=>button.textContent?.includes('悬停 / 升到高度'))!;expect(hover.disabled).toBe(false)
  await act(async()=>hover.click());expect(calls[0].name).toBe('robot_flight');expect(calls[0].input.operation).toBe('hover')
 }finally{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of saved)descriptor?Object.defineProperty(globalThis,key,descriptor):delete (globalThis as any)[key]}
},10000)
