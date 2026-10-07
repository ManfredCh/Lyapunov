#!/usr/bin/env node
/**
 * 固定版本 `isaacsim-extscache-kit` 官方大 wheel 的分段续传下载器（零额外依赖 Node ESM）。
 *
 * 背景（真实 VM）：Isaac 6.0.1.0 的 CPU worker 首次加载扩展时会向 Kit 索要
 * `omni.assets.plugins` 等通用缓存；缺少 `isaacsim-extscache-kit` 就无法完成离线闭包，
 * 而该 wheel（约 5.88GB）整包下载会在中途断开，pip 自身的续传不保留已完成的字节。
 * 这里只做一件事：**按固定官方 URL + 固定总长度 + 固定 SHA256** 把这一件 wheel 取到产品
 * 自己的 `provider-download-cache/wheels/`，把已验证的本地文件交给正常 pip。
 *
 * 硬约束（都不是可选项）：
 *  · 每段都用 `Range: bytes=<start>-<end>` 请求，必须返回 206 且 `Content-Range` 的
 *    start/end/total 与请求逐字相符；同时带 `Accept-Encoding: identity`。
 *  · 断线不丢进度：分片以追加方式写入 `<正式文件名>.partial`，下一轮从文件实际字节数续传。
 *  · 只有总长度与 SHA256 **同时**匹配才 `rename` 成正式 `.whl`（同目录原子改名）；
 *    缺字节、协议不符、SHA 不符一律非零退出，**绝不**把未验证文件交给 pip。
 *  · 已存在的完整 `.whl` 会重新核对长度与 SHA 后复用；已存在但不是固定字节的完整/partial
 *    文件保留原样并明确报错，不静默删除、不降低校验。
 *
 * 用法：
 *   node fetch-extscache-kit.mjs --pin <extscache-kit-wheel.json> --wheels-dir <目录>
 * 成功时 stdout 只输出最终 `.whl` 的绝对路径（供 shell 捕获后传给 pip）；进度与错误写 stderr。
 * 可选：`--segment-bytes`（默认 64MiB）、`--attempts`（默认 4）、`--timeout-ms`（默认 120000）。
 */
import {createHash} from 'node:crypto'
import {createReadStream,existsSync,mkdirSync,renameSync,statSync} from 'node:fs'
import {open,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {argv,exit,stderr,stdout} from 'node:process'

const DEFAULT_SEGMENT_BYTES=64*1024*1024
const DEFAULT_ATTEMPTS=4
const DEFAULT_TIMEOUT_MS=120_000
const FILENAME=/^[A-Za-z0-9][A-Za-z0-9._-]*\.whl$/
const SHA256=/^[0-9a-f]{64}$/
const CONTENT_RANGE=/^bytes (\d+)-(\d+)\/(\d+)$/

function fail(code,message){
  stderr.write(`\n[fetch-extscache-kit] ${code}: ${message}\n`)
  exit(1)
}
function progress(message){stderr.write(`[fetch-extscache-kit] ${message}\n`)}

function parseArguments(args){
  const options={segmentBytes:DEFAULT_SEGMENT_BYTES,attempts:DEFAULT_ATTEMPTS,timeoutMs:DEFAULT_TIMEOUT_MS}
  if(args.length===0)fail('USAGE','缺少参数：需要 --pin <json> 与 --wheels-dir <目录>')
  for(let index=0;index<args.length;index+=2){
    const key=args[index],value=args[index+1]
    if(value===undefined)fail('ARGUMENT_MISSING',`参数 ${key} 缺少取值`)
    if(key==='--pin')options.pin=value
    else if(key==='--wheels-dir')options.wheelsDir=value
    else if(key==='--segment-bytes')options.segmentBytes=Number(value)
    else if(key==='--attempts')options.attempts=Number(value)
    else if(key==='--timeout-ms')options.timeoutMs=Number(value)
    else fail('ARGUMENT_UNKNOWN',`未知参数 ${key}`)
  }
  for(const key of ['pin','wheelsDir'])if(typeof options[key]!=='string'||options[key]==='')fail('ARGUMENT_MISSING',`缺少参数 --${key==='pin'?'pin':'wheels-dir'}`)
  if(!Number.isSafeInteger(options.segmentBytes)||options.segmentBytes<=0)fail('ARGUMENT_INVALID','--segment-bytes 必须是正整数')
  if(!Number.isSafeInteger(options.attempts)||options.attempts<=0)fail('ARGUMENT_INVALID','--attempts 必须是正整数')
  if(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<=0)fail('ARGUMENT_INVALID','--timeout-ms 必须是正整数')
  return options
}

async function readPin(path){
  let pin
  try{pin=JSON.parse(await readFile(path,'utf8'))}catch(error){fail('PIN_UNREADABLE',`无法读取固定 pin：${path}（${(error)?.message??String(error)}）`)}
  if(pin===null||typeof pin!=='object'||Array.isArray(pin))fail('PIN_INVALID',`固定 pin 不是 JSON 对象：${path}`)
  const {filename,url,bytes,sha256}=pin
  if(typeof filename!=='string'||!FILENAME.test(filename)||filename.includes('..'))fail('PIN_INVALID',`固定 pin 的 filename 不安全：${filename}`)
  if(typeof url!=='string'||!/^https?:\/\//.test(url))fail('PIN_INVALID',`固定 pin 的 url 不是 http(s)：${url}`)
  if(!Number.isSafeInteger(bytes)||bytes<=0)fail('PIN_INVALID',`固定 pin 的 bytes 不是正整数：${bytes}`)
  if(typeof sha256!=='string'||!SHA256.test(sha256))fail('PIN_INVALID',`固定 pin 的 sha256 不是小写十六进制：${sha256}`)
  return {filename,url,bytes,sha256}
}

function fileSize(path){try{const row=statSync(path);return row.isFile()?row.size:null}catch{return null}}

function sha256File(path){
  return new Promise((resolve,reject)=>{
    const hash=createHash('sha256'),stream=createReadStream(path)
    stream.on('data',chunk=>hash.update(chunk))
    stream.on('error',reject)
    stream.on('end',()=>resolve(hash.digest('hex')))
  })
}

async function matchesPin(path,bytes,sha256){
  if(fileSize(path)!==bytes)return false
  return (await sha256File(path))===sha256
}

/**
 * 下载一个闭区间分片并追加到 partial；只信任严格核对的 206/Content-Range。
 * 返回写入的字节数（等于 end-start+1）。任何协议或网络错误都抛出，由调用方决定续传重试。
 */
async function downloadSegment({url,partial,start,end,total,timeoutMs}){
  const expected=end-start+1
  let response
  try{
    response=await fetch(url,{headers:{Range:`bytes=${start}-${end}`,'Accept-Encoding':'identity'},signal:AbortSignal.timeout(timeoutMs),redirect:'follow'})
  }catch(error){throw new Error(`请求 bytes=${start}-${end} 失败：${error?.message??String(error)}`)}
  const cancel=async()=>{try{await response.body?.cancel()}catch{}}
  if(response.status!==206){await cancel();throw new Error(`期望 206，实际 ${response.status}（bytes=${start}-${end}）`)}
  const header=response.headers.get('content-range'),match=header?CONTENT_RANGE.exec(header.trim()):null
  if(!match){await cancel();throw new Error(`Content-Range 不合法或缺席：${header??'(none)'}`)}
  const actualStart=Number(match[1]),actualEnd=Number(match[2]),actualTotal=Number(match[3])
  if(actualStart!==start||actualEnd!==end||actualTotal!==total){await cancel();throw new Error(`Content-Range 与请求不符：请求 ${start}-${end}/${total}，返回 ${header}`)}
  const contentLength=response.headers.get('content-length')
  if(contentLength!==null&&Number(contentLength)!==expected){await cancel();throw new Error(`Content-Length ${contentLength} 与分片长度 ${expected} 不符`)}
  if(!response.body){throw new Error('响应没有 body，无法写入分片')}
  const handle=await open(partial,'a')
  let written=0
  try{
    const reader=response.body.getReader()
    try{
      while(written<expected){
        const {done,value}=await reader.read()
        if(done)break
        const remaining=expected-written
        const chunk=value.length>remaining?value.subarray(0,remaining):value
        let offset=0
        while(offset<chunk.length){
          const result=await handle.write(chunk,offset,chunk.length-offset)
          if(!result.bytesWritten)throw new Error('写入返回 0 字节')
          offset+=result.bytesWritten
        }
        written+=chunk.length
      }
    }finally{try{await reader.cancel()}catch{}}
  }finally{await handle.close()}
  if(written<expected)throw new Error(`连接提前结束：期望 ${expected} 字节，实际 ${written} 字节`)
  return written
}

async function main(){
  const options=parseArguments(argv.slice(2))
  const pin=await readPin(options.pin)
  mkdirSync(options.wheelsDir,{recursive:true})
  const destination=join(options.wheelsDir,pin.filename),partial=`${destination}.partial`

  // 已有完整缓存：重新核对长度与 SHA 后复用，绝不因为“文件在”就跳过校验。
  if(existsSync(destination)){
    if(await matchesPin(destination,pin.bytes,pin.sha256)){stdout.write(`${destination}\n`);return}
    fail('WHEEL_CACHE_MISMATCH',`已存在的完整 wheel 与固定长度/SHA256 不符，未覆盖也未交给 pip：${destination}`)
  }

  let have=fileSize(partial)??0
  if(have>pin.bytes)fail('PARTIAL_OVERSIZED',`续传文件超过固定总长度：${partial}（${have} > ${pin.bytes}）`)
  if(have>0)progress(`从已有 partial 续传：${have}/${pin.bytes} 字节`)

  let attempt=0
  while(have<pin.bytes){
    const start=have,end=Math.min(start+options.segmentBytes-1,pin.bytes-1)
    try{
      await downloadSegment({url:pin.url,partial,start,end,total:pin.bytes,timeoutMs:options.timeoutMs})
      have=end+1
      attempt=0
      progress(`已完成 ${have}/${pin.bytes} 字节`)
    }catch(error){
      const observed=fileSize(partial)??0
      if(observed>have){have=observed;attempt=0}else attempt+=1
      if(attempt>=options.attempts)fail('SEGMENT_FAILED',`分片 ${start}-${end} 重试 ${options.attempts} 次仍失败（保持在 ${have} 字节，可重跑续传）：${error?.message??String(error)}`)
      await new Promise(resolve=>setTimeout(resolve,250*attempt))
    }
  }

  const digest=await sha256File(partial)
  if(digest!==pin.sha256)fail('SHA256_MISMATCH',`完整下载 SHA256 不符（固定 ${pin.sha256}，实际 ${digest}）；未原子改名，保留 ${partial}`)
  renameSync(partial,destination)
  progress(`已通过长度与 SHA256 校验并原子落盘：${destination}`)
  stdout.write(`${destination}\n`)
}

main().catch(error=>fail('UNEXPECTED',error?.stack??String(error)))
