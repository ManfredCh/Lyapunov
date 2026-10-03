import {createHash} from 'node:crypto'
import {unzipSync} from 'fflate'

export const MAX_ARCHIVE_BYTES=64*1024*1024
export const MAX_EXPORTED_BYTES=256*1024*1024
export interface ShareAsset {path:string;name:string;bytes:number;mediaType:string;attachmentId?:string}
export interface ShareLog {path:string;sessionId:string;header:Record<string,unknown>;events:Record<string,any>[]}
export interface ShareSnapshot {format:'dsh-session-export-v1';digest:string;sourceSessionId:string;logs:ShareLog[];assets:ShareAsset[];archiveBytes:number;exportedBytes:number}
export function archiveDigest(bytes:Uint8Array){return createHash('sha256').update(bytes).digest('hex')}
const media:Record<string,string>={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',pdf:'application/pdf',glb:'model/gltf-binary',gltf:'model/gltf+json',stl:'model/stl',obj:'text/plain',ply:'application/octet-stream',blend:'application/x-blender',wav:'audio/wav',mp3:'audio/mpeg',mp4:'video/mp4',txt:'text/plain',json:'application/json'}
export function assetType(path:string){return media[path.split('.').at(-1)?.toLowerCase()??'']??'application/octet-stream'}
/** 只接收原生导出的相对条目；在解压前限制总大小，不把ZIP路径写入宿主文件系统。 */
export function parseArchive(bytes:Uint8Array):{snapshot:ShareSnapshot;entries:Record<string,Uint8Array>}{
 if(bytes.byteLength>MAX_ARCHIVE_BYTES)throw new Error('SHARE_TOO_LARGE')
 let total=0,count=0
 const entries=unzipSync(bytes,{filter(file){
  const path=file.name
  if(++count>10000||!path||path.startsWith('/')||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..')||/[\x00-\x1f]/.test(path))throw new Error('SHARE_INVALID_ARCHIVE_PATH')
  total+=file.originalSize
  if(total>MAX_EXPORTED_BYTES)throw new Error('SHARE_TOO_LARGE')
  if(!/^(session\.v\d+\.jsonl|subagents\/[^/]+\/session\.v\d+\.jsonl|media\/[^/]+|files\/[a-f0-9]{2}\/[a-f0-9]{64}\/[^/]+)$/.test(path))throw new Error('SHARE_UNEXPECTED_ARCHIVE_ENTRY')
  return true
 }})
 const logs:ShareLog[]=[],assets:ShareAsset[]=[]
 for(const [path,data] of Object.entries(entries)){
  if(/(?:^|\/)session\.v\d+\.jsonl$/.test(path)){
   const lines=new TextDecoder('utf-8',{fatal:true}).decode(data).trimEnd().split('\n').map(l=>JSON.parse(l)),header=lines.shift()
   if(header?.type!=='session'||typeof header.id!=='string'||!Number.isInteger(header.version))throw new Error('SHARE_INVALID_SESSION_EXPORT')
   if(lines.some((e,i)=>e.seq!==i||typeof e.type!=='string'||!e.data||typeof e.data!=='object'))throw new Error('SHARE_INVALID_EVENT_SEQUENCE')
   logs.push({path,sessionId:header.id,header,events:lines})
  }else assets.push({path,name:path.split('/').at(-1)!,bytes:data.length,mediaType:assetType(path),...(path.startsWith('media/')?{attachmentId:path.slice(6).replace(/\.[^.]+$/,'')}:{attachmentId:'sha256:'+path.split('/')[2]})})
 }
 const root=logs.find(l=>!l.path.includes('/'))
 if(!root||logs.filter(l=>!l.path.includes('/')).length!==1)throw new Error('SHARE_ROOT_LOG_REQUIRED')
 return {snapshot:{format:'dsh-session-export-v1',digest:archiveDigest(bytes),sourceSessionId:root.sessionId,logs,assets,archiveBytes:bytes.length,exportedBytes:total},entries}
}
const esc=(v:unknown)=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
export function renderSnapshot(snapshot:ShareSnapshot,options:{title?:string;assetUrl:(path:string)=>string;archiveUrl?:string;preview?:boolean}){
 const content=(blocks:any[]):string=>(blocks??[]).map(b=>{
  if(b.type==='text')return `<p>${esc(b.text)}</p>`
  if(b.type==='image'||b.type==='file'){
   const a=snapshot.assets.find(a=>a.attachmentId===b.attachment?.attachmentId&&(b.type==='image'||a.name===b.attachment?.name))
   if(!a)return '<p>附件未包含在本次导出中</p>'
   const url=esc(options.assetUrl(a.path)),label=b.attachment?.name??a.name
   return a.mediaType.startsWith('image/')?`<figure><img src="${url}" alt="${esc(label)}"><figcaption>${esc(label)}</figcaption></figure>`:`<p><a href="${url}" download>${esc(a.name)}</a> · ${esc(a.mediaType)} · ${a.bytes} 字节</p>`
  }
  return b.type==='tool-result'?content(b.content):''
 }).join('')
 const logs=snapshot.logs.map(log=>`<section><h2>${esc(log.sessionId)}</h2>${log.events.map(event=>{
  const blocks=event.data.content??event.data.message?.content
  const visible=Array.isArray(blocks)?content(blocks):''
  return `<article><small>#${event.seq} · ${esc(event.type)}</small>${visible}<details><summary>原始事件</summary><pre>${esc(JSON.stringify(event,null,2))}</pre></details></article>`
 }).join('')}<details><summary>会话导出元数据</summary><pre>${esc(JSON.stringify(log.header,null,2))}</pre></details></section>`).join('')
 const assetList=snapshot.assets.map(a=>`<li><a href="${esc(options.assetUrl(a.path))}" download>${esc(a.name)}</a> · ${esc(a.mediaType)} · ${a.bytes} 字节</li>`).join('')
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(options.title??'会话分享')}</title><style>body{max-width:900px;margin:40px auto;padding:0 22px;color:#202526;background:#f7f8f7;font:16px/1.65 system-ui}article{background:white;border:1px solid #ddd;padding:16px;margin:14px 0;border-radius:12px}p{white-space:pre-wrap}small,figcaption{color:#606966}img{max-width:100%;max-height:640px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}a{color:#126b55}details{margin:10px 0}h1{font-size:28px}</style><h1>${esc(options.title??'会话分享')}</h1><p>${options.preview?'私有预览，尚未发布。确认后将分享以下完整原生会话导出（包含展开的原始事件、工具输入输出、元数据和附件）。':'这是固定会话快照，后续消息不会自动同步。'}</p><p>${snapshot.logs.length} 个会话 · ${snapshot.logs.reduce((n,l)=>n+l.events.length,0)} 条事件 · ${snapshot.assets.length} 个附件</p>${options.archiveUrl?`<a href="${esc(options.archiveUrl)}" download>下载原生 DSH 归档</a>`:''}${logs}<h2>附件与 3D 原件</h2><ul>${assetList}</ul></html>`
}
