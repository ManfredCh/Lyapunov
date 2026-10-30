/** 离线SimReady来源协议，不访问网络。 */
import {test,expect} from 'bun:test'
import {createServer,request as httpRequest} from 'node:http'
import {once} from 'node:events'
import {createHash} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {assertSimreadyUrl,fetchSimreadyBytes,parseSimreadyIndex,simreadyDetail,simreadySearch,type SimreadyFetch} from '../src/simready-assets.ts'
const revision='a'.repeat(40),hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex'),bytes=(value:unknown)=>Buffer.from(JSON.stringify(value))
const input={repoId:'nvidia/simready-assets',revision,packagePath:'box/com.nvidia.simready.packaging.json'}
const source='https://huggingface.co/datasets/nvidia/simready-assets/resolve/'+revision+'/box/com.nvidia.simready.packaging.json'
function fixture(bad=false):SimreadyFetch{
 const bom=bytes({format_version:'1.0',items:[{relative_path:'simready_usd/box.usda',size:32,hash:{sha256:'b'.repeat(64)}}]})
 const descriptor=bytes({format_version:'1.0',package_id:'simready.test.box.1',license:'CC-BY-4.0',metadata:[{name:'com.nvidia.simready.packaging.bom.json',hash:{sha256:bad?'c'.repeat(64):hash(bom)}}]})
 return async url=>url.includes('/.metadata/')?bom:descriptor
}
test('固定40位revision与镜像跳转边界在请求之前拒绝',()=>{
 const row=parseSimreadyIndex(source,'test')[0]!
 expect(row.revision).toBe(revision)
 for(const url of ['https://huggingface.co/datasets/a','https://x.hf.co/a','http://hf-mirror.com/a','https://hf-mirror.com@evil.example/a'])expect(()=>assertSimreadyUrl(url)).toThrow('SIMREADY_MIRROR_BLOCKED')
 expect(()=>parseSimreadyIndex(source.replace(revision,'main'),'test')).toThrow('SIMREADY_INDEX_INVALID')
})
test('BOM逐项身份与metadata哈希校验，源许可与USD入口按清单返回',async()=>{
 const detail=await simreadyDetail(input,{fetchBytes:fixture()});if(detail.sourceProtocol!=='central-bom-v1')throw Error('expected central protocol');expect(detail.rootUsd).toBe('simready_usd/box.usda');expect(detail.license.id).toBe('CC-BY-4.0');expect(detail.files.length).toBe(1)
 await expect(simreadyDetail(input,{fetchBytes:fixture(true)})).rejects.toThrow('SIMREADY_HASH_MISMATCH')
 await expect(simreadyDetail({...input,revision:'main'},{fetchBytes:fixture()})).rejects.toThrow('SIMREADY_FIXED_REVISION_REQUIRED')
})
test('搜索无命中与网络失败不同；默认覆盖已登记厂商，中英别名与索引缓存复用',async()=>{
 const root=await mkdtemp(join(tmpdir(),'simready-cache-'));let reads=0
 const fetchBytes:SimreadyFetch=async url=>{reads++;const vendor=url.includes('LGElectronics');return Buffer.from(vendor?source.replaceAll('nvidia/simready-assets','LGElectronics/simready-assets').replaceAll('/box/','/refrigerator_x/'):source)}
 try{
  const first=await simreadySearch({query:'冰箱'},{fetchBytes,cacheDirectory:root});expect(first.status).toBe('FOUND');expect(first.candidates.some(row=>row.repoId==='LGElectronics/simready-assets')).toBe(true);expect(reads).toBe(12)
  await simreadySearch({query:'冰箱'},{fetchBytes,cacheDirectory:root});expect(reads).toBe(12)
  const vendor=await simreadySearch({query:'LG冰箱'},{fetchBytes,cacheDirectory:root});expect(vendor.status).toBe('FOUND');expect(vendor.candidates.every(row=>row.repoId==='LGElectronics/simready-assets')).toBe(true);expect(reads).toBe(12)
  const no=await simreadySearch({query:'absent',repoIds:['nvidia/simready-assets']},{fetchBytes});expect(no.status).toBe('NO_MATCH')
  const fail=await simreadySearch({query:'absent',repoIds:['nvidia/simready-assets']},{fetchBytes:async()=>{throw Error('mirror revision missing')}});expect(fail.status).toBe('BLOCKED');expect(fail.failures[0]!.reason).toContain('mirror revision missing')
 }finally{await rm(root,{recursive:true,force:true})}
})

test('真实受控传输在发官方跳转前拒绝，镜像内跳转仍读真字节并支持取消',async()=>{
 const hits:string[]=[]
 const server=createServer((request,response)=>{hits.push(request.url??'');if(request.url==='/official'){response.writeHead(302,{location:'https://huggingface.co/never-send'});response.end()}else if(request.url==='/mirror'){response.writeHead(307,{location:'/content'});response.end()}else{response.writeHead(200,{'content-length':'2'});response.end('ok')}}).listen(0,'127.0.0.1')
 await once(server,'listening');const port=(server.address() as {port:number}).port
 const options={maxBytes:1024,hostResolver:async()=>[{address:'1.1.1.1',family:4}],networkTransport:((_url:any,request:any,listener:any)=>httpRequest({hostname:'127.0.0.1',port,path:_url.pathname,method:request.method},listener))}
 try{
  await expect(fetchSimreadyBytes('https://hf-mirror.com/official',options)).rejects.toThrow('SIMREADY_MIRROR_BLOCKED')
  expect(hits).toEqual(['/official'])
  expect(new TextDecoder().decode(await fetchSimreadyBytes('https://hf-mirror.com/mirror',options))).toBe('ok')
  expect(hits).toEqual(['/official','/mirror','/content'])
  const controller=new AbortController();controller.abort()
  await expect(fetchSimreadyBytes('https://hf-mirror.com/content',{...options,signal:controller.signal})).rejects.toThrow()
  expect(hits.length).toBe(3)
 }finally{server.close();await once(server,'close')}
})

test('USD解释器缺失保留明确安装动作，公开错误不泄露路径或误报调整请求',async()=>{
 const {inspectUsd,usdLayerDependencies}=await import('../src/usd-assets.ts'),{publicCommandError}=await import('../../lyapunov-contracts/src/command-privacy.ts')
 const previous=process.env.LYAPUNOV_USD_PYTHON
 try{process.env.LYAPUNOV_USD_PYTHON='/missing/private-fixture/usd-python';await expect(inspectUsd('/fixture/source.usda')).rejects.toThrow('USD_RUNTIME_UNAVAILABLE');await expect(usdLayerDependencies('/fixture/source.usda')).rejects.toThrow('USD_RUNTIME_UNAVAILABLE')
  const view=publicCommandError('USD_RUNTIME_UNAVAILABLE: /missing/private-fixture/usd-python')
  expect(view.code).toBe('P500');expect(view.message).toContain('install-usd-parser');expect(view.message).not.toContain('请求内容');expect(view.message).not.toContain('private-fixture')
 }finally{if(previous===undefined)delete process.env.LYAPUNOV_USD_PYTHON;else process.env.LYAPUNOV_USD_PYTHON=previous}
})
