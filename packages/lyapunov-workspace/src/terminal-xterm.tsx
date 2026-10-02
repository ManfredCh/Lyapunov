/**
 * 真实交互终端：xterm.js 渲染 + Host 侧 node-pty。
 * 输出经 `/api/lyapunov/workspace/xterm-output`（base64 分块流）到达；
 * 键入经 POST `xterm-write` 直达 PTY stdin；容器尺寸变化同步 `xterm-resize`。
 */
import {useEffect,useRef,useState} from "react"
import {Terminal} from "@xterm/xterm"
import {FitAddon} from "@xterm/addon-fit"
import {xtermStyle} from "./xterm-style.ts"

const decode=(b64:string)=>{const bin=atob(b64),bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);return bytes}

export function TerminalXterm({sessionId,tr}:{sessionId:string;tr:(zh:string,en:string)=>string}){
  const hostRef=useRef<HTMLDivElement>(null),[generation,setGeneration]=useState(0),[status,setStatus]=useState<"starting"|"running"|"exited">("starting")
  const controls=useRef<{kill:()=>void;interrupt:()=>void}>({kill:()=>{},interrupt:()=>{}})
  useEffect(()=>{
    const node=hostRef.current;if(!node)return
    const styleEl=document.createElement("style");styleEl.textContent=xtermStyle
    const term=new Terminal({fontSize:13,fontFamily:'ui-monospace,"Cascadia Mono","Noto Sans Mono CJK SC",monospace',cursorBlink:true,scrollback:2000,allowProposedApi:true})
    const fit=new FitAddon();term.loadAddon(fit)
    node.appendChild(styleEl);term.open(node);fit.fit()
    let disposed=false,id:string|undefined,stream:EventSource|undefined
    const post=async(action:string,input:unknown={})=>{const response=await fetch("/api/lyapunov/workspace",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId,action,input})});return response.json()}
    controls.current={
      kill:()=>{if(id)void post("xterm-kill",{id})},
      interrupt:()=>{if(id)void post("xterm-write",{id,data:""})},
    }
    void (async()=>{
      const spawned=await post("xterm-spawn",{cols:term.cols,rows:term.rows})
      if(spawned?.error){term.writeln("\x1b[31m"+String(spawned.error)+"\x1b[0m");return}
      id=spawned.id as string
      if(disposed){void post("xterm-kill",{id});return}
      setStatus("running")
      stream=new EventSource("/api/lyapunov/workspace/xterm-output?sessionId="+encodeURIComponent(sessionId)+"&id="+encodeURIComponent(id))
      stream.onmessage=event=>{
        if(event.data==="__exit__"){setStatus("exited");stream?.close();return}
        term.write(decode(event.data))
      }
    })()
    const inputSub=term.onData(data=>{if(id)void post("xterm-write",{id,data})})
    const observer=new ResizeObserver(()=>{try{fit.fit();if(id)void post("xterm-resize",{id,cols:term.cols,rows:term.rows})}catch{}})
    observer.observe(node)
    return()=>{disposed=true;observer.disconnect();inputSub.dispose();stream?.close();if(id)void post("xterm-kill",{id});term.dispose();styleEl.remove()}
  },[sessionId,generation])
  return <div className="lya-xterm-wrap">
    <div className="lya-xterm-toolbar">
      <button type="button" onClick={()=>setGeneration(value=>value+1)}>{tr("新终端","New terminal")}</button>
      <button type="button" onClick={()=>controls.current.interrupt()}>Ctrl+C</button>
      <button type="button" onClick={()=>controls.current.kill()}>{tr("结束终端","Kill terminal")}</button>
      {status==="exited"&&<span className="lya-xterm-status">{tr("已退出","Exited")}</span>}
    </div>
    <div className="lya-xterm" ref={hostRef}/>
  </div>
}
