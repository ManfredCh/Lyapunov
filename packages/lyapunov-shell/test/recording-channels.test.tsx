/**
 * P7C：录制通道产物回放的渲染判据。
 *
 * 钉住：RGB 走真实 `<img>`（会话授权 mediaURL），binary 掩码/几何索引**不**被画成图像，
 * 没有通道统计时不占位。深度/range 的 Canvas 解码在浏览器 effect 里，SSR 只出现 canvas 元素。
 *
 * 运行：`bun test packages/lyapunov-shell/test/recording-channels.test.tsx`
 */
import {describe,expect,test} from "bun:test"
import {createRequire} from "node:module"
import {createElement,act,startTransition} from "react"
import {flushSync} from "react-dom"
import {renderToStaticMarkup} from "react-dom/server"
import {createRoot,type Root} from "react-dom/client"
import {RecordingChannels, recordingChannelIndexAt, recordingChannelSamples, recordingSampleIdentity, recordingSensorDelay, recordingSensorTimeline, type RecordingChannelRow} from "../src/recording-channels.tsx"

const tr=((zh:string,_en:string)=>zh) as never
const markup=(node:unknown)=>renderToStaticMarkup(node as never)
const mediaURL=(uri:string)=>"https://host/recording-resource?uri="+encodeURIComponent(uri)
const row=(channel:string,files:RecordingChannelRow["files"],extra:Partial<RecordingChannelRow>={}):RecordingChannelRow=>({channel,cameraName:"robot-a/a_cam",unit:channel==="camera-depth"?"m-axial-z":"m-euclidean-range",frames:files.length,files,...extra})
/** 真 React + jsdom：让播放/暂停真的按定时器推进，而不是只看 SSR 文本。 */
function withDom(run:(host:HTMLElement,render:(node:unknown)=>Promise<void>)=>Promise<void>){
 return async()=>{
  const {JSDOM}=createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json",import.meta.url))("jsdom") as {JSDOM:new(html:string,options?:{url?:string;pretendToBeVisual?:boolean})=>{window:Window&typeof globalThis}}
  const dom=new JSDOM('<div id="root"></div>',{url:"http://fixture.invalid",pretendToBeVisual:true})
  const saved=new Map<string,PropertyDescriptor|undefined>()
  for(const key of ["window","document","HTMLElement","HTMLCanvasElement","Node","navigator","requestAnimationFrame","cancelAnimationFrame","IS_REACT_ACT_ENVIRONMENT"]){
   saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
   const raw=(dom.window as unknown as Record<string,unknown>)[key]
   const value=key==="IS_REACT_ACT_ENVIRONMENT"?true:typeof raw==="function"&&key.includes("AnimationFrame")?(raw as (...args:unknown[])=>unknown).bind(dom.window):raw
   Object.defineProperty(globalThis,key,{configurable:true,value})
  }
  const host=document.getElementById("root")!,root:Root=createRoot(host)
  // React 的旧式 value-change 兜底会对 activeElement 调 attachEvent/detachEvent；jsdom 没有。
  ;(dom.window as unknown as {HTMLElement:{prototype:Record<string,unknown>}}).HTMLElement.prototype.attachEvent=()=>{}
  ;(dom.window as unknown as {HTMLElement:{prototype:Record<string,unknown>}}).HTMLElement.prototype.detachEvent=()=>{}
  const render=async(node:unknown)=>{await act(async()=>{root.render(node as never)})}
  try{await run(host,render)}
  finally{try{await act(async()=>root.unmount())}catch{}dom.window.close();for(const [key,value] of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)}}
 }
}

describe("P7C 录制通道产物回放",()=>{
 test("RGB 用真实 img 且在具名折叠里",()=>{
  const html=markup(<RecordingChannels channels={[row("rgb",[{role:"rgb",uri:"resources/capture-0/a.png",mimeType:"image/png"}])]} mediaURL={mediaURL} tr={tr}/>)
  expect(html).toContain('data-testid="recording-channels"')
  expect(html).toContain('data-testid="recording-channel-rgb"')
  expect(html).toContain("<img")
  expect(html).toContain(mediaURL("resources/capture-0/a.png"))
 })
 test("相机深度用 NPY canvas，不冒充 RGB img",()=>{
  const html=markup(<RecordingChannels channels={[row("camera-depth",[{role:"depth",uri:"resources/capture-0/d.npy",mimeType:"application/x-npy",dtype:"<f4",shape:[240,320],unit:"m-axial-z"}])]} mediaURL={mediaURL} tr={tr}/>)
  expect(html).toContain("<canvas")
  expect(html).not.toContain("<img")
  expect(html).toContain("m-axial-z")
 })
 test("LiDAR range 显示真实有效/无返回统计，二进制掩码只给下载不画图",()=>{
  const html=markup(<RecordingChannels channels={[row("lidar-range",[{role:"valid",uri:"resources/capture-0/v.npy",mimeType:"application/x-npy",shape:[3,61]}],{validCount:183,noReturnCount:7,rangeMinM:0.12,rangeMaxM:0.18,rangeMeanM:0.15})]} mediaURL={mediaURL} tr={tr}/>)
  expect(html).toContain("有效 183")
  expect(html).toContain("无返回 7")
  expect(html).toContain("不在页面改画成图像")
  expect(html).not.toContain("<img")
  expect(html).not.toContain("<canvas")
 })
 test("没有通道统计时不占位",()=>{
  expect(markup(<RecordingChannels channels={undefined} mediaURL={mediaURL} tr={tr}/>)).toBe("")
  expect(markup(<RecordingChannels channels={[]} mediaURL={mediaURL} tr={tr}/>)).toBe("")
 })
})

describe("P7C-review 传感器样本分组与按真实采样时间回放",()=>{
 const en=((_zh:string,value:string)=>value) as never
 const lidarFiles=()=>Array.from({length:8},(_,i)=>[{role:"range",uri:`resources/scan-${i}/range.npy`,mimeType:"application/x-npy",shape:[3,9],unit:"m"},{role:"valid",uri:`resources/scan-${i}/valid.npy`,mimeType:"application/x-npy",shape:[3,9]},{role:"hitGeom",uri:`resources/scan-${i}/hit.npy`,mimeType:"application/x-npy",shape:[3,9]},{role:"preview",uri:`resources/scan-${i}/preview.png`,mimeType:"image/png"}]).flat() as RecordingChannelRow["files"]

 test("旧 flat 格式：LiDAR 8 次量测 32 文件 → 滑条 max=7，辅助文件不冒充帧",()=>{
  const channel:RecordingChannelRow={channel:"lidar-range",cameraName:"robot-a/a_cam",unit:"m-euclidean-range",frames:8,files:lidarFiles(),validCount:27,noReturnCount:0,rangeMinM:1.05,rangeMaxM:1.29,rangeMeanM:1.16}
  expect(recordingChannelSamples(channel)).toHaveLength(8)
  expect(recordingChannelSamples(channel).every(sample=>sample.files.length===4)).toBe(true)
  const html=markup(<RecordingChannels channels={[channel]} mediaURL={mediaURL} tr={en}/>)
  const {JSDOM}=createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json",import.meta.url))("jsdom")
  const dom=new JSDOM(html),field=dom.window.document.querySelector('[data-testid="recording-channel-lidar-range"]'),slider=field?.querySelector('input[type="range"]')
  expect(Number(slider?.getAttribute("max"))).toBe(7) // 8 次真实量测，不是 32 个文件
  expect(html).not.toContain('max="31"')
  expect(dom.window.document.querySelector('[data-testid="recording-channel-lidar-range-aux"]')).not.toBeNull()
  expect(dom.window.document.querySelector('[data-testid="recording-sensor-playback"]')).not.toBeNull()
  expect(html).toContain("Play sensor playback")
  expect(dom.window.document.querySelector('[data-testid="recording-channel-lidar-range-identity"]')?.textContent).toContain("no per-sample identity")
  dom.window.close()
 })

 test("新样本带身份：captureId/step/generation/simTime 显示，且总量程取该次自己的配置",()=>{
  const samples=Array.from({length:3},(_,i)=>({
   captureId:`lidar-${i}`,frameId:`world-1:1:${100+i}`,stepIndex:100+i,generation:1,sceneRevision:1,worldId:"world-1",simTime:i*0.1,
   cameraName:"robot-a/a_cam",parentEntityId:"robot-a",parentBodyName:"a_head",receiptPath:`resources/lidar-receipt-${i}.json`,rangeM:20-i,
   ...(i===0?{targetStepIndex:98,stepDrift:2,synchronized:false}:{}),
   files:[{role:"range",uri:`resources/scan-${i}/range.npy`,mimeType:"application/x-npy",shape:[3,9],unit:"m",sampleIndex:i},{role:"valid",uri:`resources/scan-${i}/valid.npy`,mimeType:"application/x-npy",shape:[3,9],sampleIndex:i}],
  }))
  const channel:RecordingChannelRow={channel:"lidar-range",cameraName:"robot-a/a_cam",unit:"m-euclidean-range",frames:3,files:samples.flatMap(sample=>sample.files),samples,validCount:27,noReturnCount:0,rangeMinM:1,rangeMaxM:2,rangeMeanM:1.5}
  expect(recordingChannelSamples(channel)).toHaveLength(3)
  const identity=recordingSampleIdentity(channel.samples![0],en)
  expect(identity).toContain("lidar-0")
  expect(identity).toContain("step 100")
  expect(identity).toContain("g1")
  expect(identity).toContain("0.000 s")
  expect(identity).toContain("range 20.000 m")
  expect(identity).toContain("sync drift 2 steps")
  const html=markup(<RecordingChannels channels={[channel]} mediaURL={mediaURL} tr={en}/>)
  expect(html).toContain("lidar-0")
  expect(html).toContain("20.000 m")
 })

 test("展开回放后首屏只有可读来源、图和播放；UUID/frame/step/drift与下载在关闭详情中",withDom(async(host,render)=>{
  const channel:RecordingChannelRow={channel:"rgb",cameraName:"entity-long-uuid/hand/Wrist RGB-D",unit:"png-rgb-8bit",frames:1,files:[],samples:[{cameraName:"entity-long-uuid/hand/Wrist RGB-D",captureId:"capture-long-uuid",frameId:"frame-long-uuid",worldId:"world-long-uuid",parentEntityId:"entity-long-uuid",parentBodyName:"entity-long-uuid/hand",generation:2,sceneRevision:3,stepIndex:99,targetStepIndex:97,stepDrift:2,synchronized:false,simTime:9.54,files:[{role:"rgb",uri:"sensor.png",mimeType:"image/png"}]}]}
  await render(createElement(RecordingChannels,{channels:[channel],source:{cameraName:channel.cameraName,robotName:"Panda",channels:["rgb"]},mediaURL:(uri:string)=>uri,tr:en}))
  const outer=host.querySelector('[data-testid="recording-channels"]') as HTMLDetailsElement
  await act(async()=>{outer.open=true;outer.dispatchEvent(new window.Event("toggle",{bubbles:true}))})
  const identity=host.querySelector('[data-testid="recording-channel-rgb-identity"]')!
  const details=identity.closest("details") as HTMLDetailsElement
  expect(details.open).toBe(false)
  const copy=host.cloneNode(true) as HTMLElement
  copy.querySelectorAll("details:not([open])").forEach(node=>node.remove())
  expect(copy.textContent).toContain("Panda · Wrist RGB-D")
  expect(copy.textContent).toContain("Play sensor playback")
  expect(copy.querySelector("img")?.getAttribute("src")).toBe("sensor.png")
  for(const value of ["entity-long-uuid","capture-long-uuid","frame-long-uuid","world-long-uuid","step 99","sync drift","Download main file"])expect(copy.textContent).not.toContain(value)
  await act(async()=>{details.open=true})
  for(const value of ["capture-long-uuid","frame frame-long-uuid","world world-long-uuid","step 99","target step 97","sync drift 2 steps"])expect(details.textContent).toContain(value)
  expect(details.querySelector("a")?.getAttribute("href")).toBe("sensor.png")
 }))
 test("折叠技术详情不遮通道故障，所有通道零样本仍给真实不可用原因",withDom(async(host,render)=>{
  await render(createElement(RecordingChannels,{channels:[row("lidar-range",[],{frames:0,unavailable:"SENSOR_UNAVAILABLE: no rays"})],mediaURL,tr:en}))
  const outer=host.querySelector('[data-testid="recording-channels"]') as HTMLDetailsElement
  expect(outer).not.toBeNull()
  await act(async()=>{outer.open=true})
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("SENSOR_UNAVAILABLE: no rays")
  expect(host.querySelector('[role="alert"]')?.closest("details")).toBe(outer)
  expect(host.querySelector('[data-testid="recording-sensor-playback"]')).toBeNull()
 }))
 test("NPY读取失败在图像位置显示，不收入样本技术详情",withDom(async(host,render)=>{
  const saved=globalThis.fetch
  const unavailableFetch=Object.assign(async()=>new Response("missing",{status:404,statusText:"Not Found"}),{preconnect(){}})
  globalThis.fetch=unavailableFetch as typeof fetch
  try{
   await render(createElement(RecordingChannels,{channels:[row("camera-depth",[{role:"depth",uri:"missing.npy",mimeType:"application/x-npy"}])],mediaURL,tr:en}))
   await act(async()=>{await Promise.resolve();await Promise.resolve()})
   const outer=host.querySelector('[data-testid="recording-channels"]') as HTMLDetailsElement
   await act(async()=>{outer.open=true})
   const error=host.querySelector('[role="alert"]')!
   expect(error.textContent).toContain("NPY decode failed: HTTP 404 Not Found")
   expect(error.closest("details")).toBe(outer)
   expect((host.querySelector('[data-testid="recording-channel-camera-depth-details"]') as HTMLDetailsElement).open).toBe(false)
  }finally{globalThis.fetch=saved}
 }))
 test("实时回放按真实采样时间：合并各通道样本、带播放/暂停与逐帧选择",()=>{
  const channel=row("rgb",[{role:"rgb",uri:"resources/a.png",mimeType:"image/png"},{role:"rgb",uri:"resources/b.png",mimeType:"image/png"}],{frames:2,files:[{role:"rgb",uri:"resources/a.png",mimeType:"image/png"},{role:"rgb",uri:"resources/b.png",mimeType:"image/png"}],samples:[{captureId:"cap-1",stepIndex:1,generation:1,sceneRevision:1,worldId:"w",simTime:0,files:[{role:"rgb",uri:"resources/a.png",mimeType:"image/png"}]},{captureId:"cap-2",stepIndex:11,generation:1,sceneRevision:1,worldId:"w",simTime:0.1,files:[{role:"rgb",uri:"resources/b.png",mimeType:"image/png"}]}]})
  const html=markup(<RecordingChannels channels={[channel]} mediaURL={mediaURL} tr={en}/>)
  expect(html).toContain("Fixed sensor playback")
  expect(html).toContain("Play sensor playback")
  expect(html).toContain("Next frame")
  expect(html).toContain("1/2 · by real sample time")
 })

 test("回放节拍取参考通道各次量测的真实 simTime 差，末帧退固定节拍",()=>{
  const channel=row("lidar-range",[{role:"range",uri:"resources/0/range.npy",mimeType:"application/x-npy"},{role:"range",uri:"resources/1/range.npy",mimeType:"application/x-npy"},{role:"range",uri:"resources/2/range.npy",mimeType:"application/x-npy"}],{frames:3,samples:[{stepIndex:0,simTime:0,files:[]},{stepIndex:10,simTime:0.25,files:[]},{stepIndex:20,simTime:0.5,files:[]}]})
  expect(recordingSensorDelay([channel],0)).toBe(250)
  expect(recordingSensorDelay([channel],1)).toBe(250)
  expect(recordingSensorDelay([channel],2)).toBe(500)
 })

 test("回放延迟就是已记录 simTime 的 1 倍速，不夹取（主控 delay probe 同判据）",()=>{
  const mk=(seconds:number):RecordingChannelRow=>({channel:"rgb",cameraName:"a",unit:"png",frames:2,files:[],samples:[{simTime:1,files:[]},{simTime:1+seconds,files:[]}]})
  expect(Math.abs(recordingSensorDelay([mk(.033)],0)-33)).toBeLessThan(1e-6)
  expect(Math.abs(recordingSensorDelay([mk(.2)],0)-200)).toBeLessThan(1e-6)
  expect(Math.abs(recordingSensorDelay([mk(5)],0)-5000)).toBeLessThan(1e-6)
 })

 test("时间线按真实 simTime 合并三通道；光标时间决定各通道显示哪次量测（主控 playback-time probe 同判据）",()=>{
  const ch=(name:string,times:number[]):RecordingChannelRow=>({channel:name,cameraName:"robot-a/sensor",unit:"m",frames:times.length,files:times.map((_,i)=>({role:"preview",uri:`${name}${i}.png`,mimeType:"image/png"})),samples:times.map((simTime,i)=>({captureId:`${name}-${i}`,cameraName:"robot-a/sensor",simTime,stepIndex:Math.round(simTime*1000),generation:1,files:[{role:"preview",uri:`${name}${i}.png`,mimeType:"image/png"}]}))})
  const channels=[ch("rgb",[0,1]),ch("camera-depth",[0,1]),ch("lidar-range",[.05,1.05])]
  expect(recordingSensorTimeline(channels).map(entry=>[entry.channel.channel,Number(entry.sample.simTime)])).toEqual([["rgb",0],["camera-depth",0],["lidar-range",.05],["rgb",1],["camera-depth",1],["lidar-range",1.05]])
  expect(recordingChannelIndexAt(recordingChannelSamples(channels[0]!),recordingSensorTimeline(channels)[1]!.sample.simTime)).toBe(0)
  expect(recordingChannelIndexAt(recordingChannelSamples(channels[0]!),1)).toBe(1)
 })

 test("点播放后真的按真实采样时间前进，到末帧停住",withDom(async(host,render)=>{
  const channel:RecordingChannelRow={channel:"rgb",cameraName:"robot-a/a_cam",unit:"png-rgb-8bit",frames:3,files:[],samples:[
   {captureId:"c0",stepIndex:0,generation:1,sceneRevision:1,worldId:"w",simTime:0,files:[{role:"rgb",uri:"a.png",mimeType:"image/png"}]},
   {captureId:"c1",stepIndex:10,generation:1,sceneRevision:1,worldId:"w",simTime:0.05,files:[{role:"rgb",uri:"b.png",mimeType:"image/png"}]},
   {captureId:"c2",stepIndex:20,generation:1,sceneRevision:1,worldId:"w",simTime:0.1,files:[{role:"rgb",uri:"c.png",mimeType:"image/png"}]},
  ]}
  await render(createElement(RecordingChannels,{channels:[channel],mediaURL:(uri:string)=>uri,tr:en}))
  const playback=()=>host.querySelector('[data-testid="recording-sensor-playback"]')?.textContent??""
  expect(playback()).toContain("1/3")
  const play=[...host.querySelectorAll("button")].find(button=>button.textContent?.includes("Play sensor playback")) as HTMLButtonElement
  await act(async()=>{play.click()})
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,90))})
  expect(playback()).not.toContain("1/3")
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,200))})
  expect(playback()).toContain("3/3")
  // 到末帧自动停住：暂停按钮回到 Play（继续走也不会超过末帧）
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,120))})
  expect(playback()).toContain("3/3")
 }))

 test("R-006：暂停当刻关闸，已排队的 timeout 不再推进；恢复后继续前进",withDom(async(host,render)=>{
  const channel:RecordingChannelRow={channel:"rgb",cameraName:"robot-a/a_cam",unit:"png-rgb-8bit",frames:4,files:[],samples:[0,0.03,0.06,0.09].map((simTime,i)=>({captureId:`c${i}`,stepIndex:i*10,generation:1,sceneRevision:1,worldId:"w",simTime,files:[{role:"rgb",uri:`${i}.png`,mimeType:"image/png"}]}))}
  await render(createElement(RecordingChannels,{channels:[channel],mediaURL:(uri:string)=>uri,tr:en}))
  const playback=()=>host.querySelector('[data-testid="recording-sensor-playback"]')?.textContent??""
  const findButton=(label:string)=>[...host.querySelectorAll("button")].find(button=>button.textContent?.includes(label)) as HTMLButtonElement
  await act(async()=>{findButton("Play sensor playback").click()})
  // 在第一个 30ms 定时器尚未触发时暂停。
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10))})
  await act(async()=>{findButton("Pause sensor playback").click()})
  const paused=playback()
  // 等过原定 delay 仍不得前进（旧实现会落一次）。
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,120))})
  expect(playback()).toBe(paused)
  // 恢复后继续按真实采样时间推进。
  await act(async()=>{findButton("Play sensor playback").click();await new Promise(resolve=>setTimeout(resolve,80))})
  expect(playback()).not.toBe(paused)
  // 拖动时间线立即暂停并落到指定样本。
  const slider=host.querySelector('input[aria-label="Sensor sample timeline"]') as HTMLInputElement
  await act(async()=>{const key=Object.keys(slider).find(name=>name.startsWith("__reactProps$"));const props=key?(slider as any)[key]:undefined;const setter=Object.getOwnPropertyDescriptor((window as any).HTMLInputElement.prototype,"value")!.set!;setter.call(slider,"3");props.onChange({target:slider})})
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,80))})
  expect(playback()).toContain("4/4")
 }))

 test("R-006-14：低优先级advance已在队列→Pause高优先级提交→flush旧更新，游标必须停在Pause当刻；Play从保持点继续",withDom(async(host,render)=>{
  const channel:RecordingChannelRow={channel:"rgb",cameraName:"robot-a/a_cam",unit:"png-rgb-8bit",frames:4,files:[],samples:[0,0.03,0.06,0.09].map((simTime,i)=>({captureId:`c${i}`,stepIndex:i*10,generation:1,sceneRevision:1,worldId:"w",simTime,files:[{role:"rgb",uri:`${i}.png`,mimeType:"image/png"}]}))}
  await render(createElement(RecordingChannels,{channels:[channel],mediaURL:(uri:string)=>uri,tr:en}))
  const playback=()=>host.querySelector('[data-testid="recording-sensor-playback"]')?.textContent??""
  const findButton=(label:string)=>[...host.querySelectorAll("button")].find(button=>button.textContent?.includes(label)) as HTMLButtonElement
  const realSetTimeout=globalThis.setTimeout
  let advance:(()=>void)|undefined
  // 捕获组件自己的真实回放定时器；测试在 startTransition 里调用它，等价于“advance 已排队但尚未提交”。
  ;(globalThis as any).setTimeout=((fn:any,delay?:number,...args:any[])=>{if(typeof fn==="function"&&delay===30){advance=()=>fn(...args);return 0 as any}return realSetTimeout(fn,delay,...args)}) as typeof setTimeout
  try{
   await act(async()=>{findButton("Play sensor playback").click()})
   expect(playback()).toContain("1/4")
   expect(advance).toBeDefined()
   act(()=>{
    startTransition(()=>{advance!()})                       // 旧低优先级 advance 入队（此时不应提交）
    flushSync(()=>{findButton("Pause sensor playback").click()}) // 用户 Pause：高优先级，同步提交 playing=false
    expect(playback()).toContain("1/4")
   })
   // 冲刷旧 transition：没有“Pause 当刻显式游标”的旧实现会在这里把 1/4 推到 2/4（桌面 7→8 的同一形状）。
   await act(async()=>{await new Promise(resolve=>realSetTimeout(resolve,0))})
   expect(playback()).toContain("1/4")
   // Play 从保持点继续：下一条真实 advance 才到 2/4。
   await act(async()=>{findButton("Play sensor playback").click()})
   expect(advance).toBeDefined()
   await act(async()=>{advance!()})
   expect(playback()).toContain("2/4")
  }finally{globalThis.setTimeout=realSetTimeout}
 }))

 test("R-006-14：逐通道样本选择走同一暂停/定位入口，旧低优先级advance不能把用户选择冲掉",withDom(async(host,render)=>{
  const channel:RecordingChannelRow={channel:"rgb",cameraName:"robot-a/a_cam",unit:"png-rgb-8bit",frames:4,files:[],samples:[0,0.03,0.06,0.09].map((simTime,i)=>({captureId:`c${i}`,stepIndex:i*10,generation:1,sceneRevision:1,worldId:"w",simTime,files:[{role:"rgb",uri:`${i}.png`,mimeType:"image/png"}]}))}
  await render(createElement(RecordingChannels,{channels:[channel],mediaURL:(uri:string)=>uri,tr:en}))
  const playback=()=>host.querySelector('[data-testid="recording-sensor-playback"]')?.textContent??""
  const findButton=(label:string)=>[...host.querySelectorAll("button")].find(button=>button.textContent?.includes(label)) as HTMLButtonElement
  const realSetTimeout=globalThis.setTimeout
  let advance:(()=>void)|undefined
  ;(globalThis as any).setTimeout=((fn:any,delay?:number,...args:any[])=>{if(typeof fn==="function"&&delay===30){advance=()=>fn(...args);return 0 as any}return realSetTimeout(fn,delay,...args)}) as typeof setTimeout
  try{
   await act(async()=>{findButton("Play sensor playback").click()})
   expect(advance).toBeDefined()
   const sample=host.querySelector('input[aria-label="rgb frame"]') as HTMLInputElement
   act(()=>{
    startTransition(()=>{advance!()})
    flushSync(()=>{const key=Object.keys(sample).find(name=>name.startsWith("__reactProps$"));const props=key?(sample as any)[key]:undefined;const setter=Object.getOwnPropertyDescriptor((window as any).HTMLInputElement.prototype,"value")!.set!;setter.call(sample,"3");props.onChange({target:sample})})
    expect(playback()).toContain("4/4")
   })
   await act(async()=>{await new Promise(resolve=>realSetTimeout(resolve,0))})
   expect(playback()).toContain("4/4")
   expect(playback()).toContain("Play sensor playback")        // 选择样本同时暂停，旧播放不得继续
   expect(host.querySelector('[data-testid="recording-channel-rgb-identity"]')?.textContent).toContain("c3")
  }finally{globalThis.setTimeout=realSetTimeout}
 }))
})
