import {test,expect} from 'bun:test'
import {parseWarehouseCsv,loadWarehouseCatalog,warehouseEntry,verifyWarehouseFile,gitBlob,sha256,WAREHOUSE_REPO,WAREHOUSE_REVISION} from '../src/warehouse-catalog.ts'
import {simreadySearch,simreadyDetail} from '../src/simready-assets.ts'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {SceneOperations} from '../src/operations.ts'
import {PortableArchive} from '../src/portable.ts'
import {fileStamp} from '../src/formats.ts'
import {readUsdStandardLibrary,registerNvidiaUsdStandardLibrary,resolveUsdStandardLibrary,USD_STANDARD_LIBRARY_MIME} from '../src/usd-standard-libraries.ts'

test('独立标准模块资源核验传递imports/using、导出输入类型、许可和SHA；不凭同名文件消除歧义',async()=>{
 const root=await mkdtemp(join(tmpdir(),'usd-standard-module-'))
 try{
  const site=join(root,'site'),core=join(site,'isaacsim/kit/mdl/core'),metadata=join(site,'isaacsim_kernel-6.0.1.0.dist-info/METADATA')
  await mkdir(dirname(metadata),{recursive:true});await writeFile(metadata,'Name: isaacsim-kernel\nVersion: 6.0.1.0\n')
  const header='// SPDX-License-Identifier: BSD-3-Clause\n'
  const files:Record<string,string>={
   'Base/OmniPBR.mdl':header+'mdl 1.7;\nimport ::df::*;\nimport Helper::*;\nexport material OmniPBR(uniform texture_2d diffuse_texture = texture_2d() [[anno::description("https://example.invalid/not-a-request")]], bool enable_ORM_texture=false, float metallic_texture_influence=0., uniform base::mono_mode opacity_mode=base::mono_average,) = material();\n',
   'Base/Helper.mdl':header+'mdl 1.7;\nusing .::Aux import x;\n',
   'Base/Aux.mdl':header+'mdl 1.8;\nexport float x=1.;\n',
   'VERSION.md':'2.1.0\n','PACKAGE-LICENSES/omni-core-materials-LICENSE.md':'BSD-3-Clause 本测试自有模块许可夹具\n',
  }
  for(const [path,text]of Object.entries(files)){await mkdir(dirname(join(core,path)),{recursive:true});await writeFile(join(core,path),text)}
  const ops=new SceneOperations(join(root,'catalog')),resource=await registerNvidiaUsdStandardLibrary(ops.resources,core)
  expect(resource.parsed.kind).toBe('source');expect(resource.ref.original.mimeType).toBe(USD_STANDARD_LIBRARY_MIME);expect(resource.parsed.dependencies).toHaveLength(6);expect(resource.license?.id).toBe('BSD-3-Clause');expect(await ops.list()).toEqual([])
  const checked=await readUsdStandardLibrary(fileURLToPath(resource.ref.original.uri));expect(checked.manifest.requiredMdlVersion).toBe('1.8');expect(checked.manifest.runtimeModules).toEqual(['df']);expect(checked.manifest.files.some(file=>file.path==='Base/Aux.mdl')).toBe(true);expect(checked.manifest.modules[0]!.parameters.opacity_mode).toBe('base::mono_mode')
  const declaration={assetIdentifier:'OmniPBR.mdl',subIdentifier:'OmniPBR',parameters:[{name:'diffuse_texture',typeName:'asset'},{name:'enable_ORM_texture',typeName:'bool'}]}
  expect((await resolveUsdStandardLibrary(ops.resources,declaration)).resourceId).toBe(resource.ref.resourceId)
  await expect(resolveUsdStandardLibrary(ops.resources,{...declaration,subIdentifier:'OtherMaterial'})).rejects.toThrow('USD_STANDARD_LIBRARY_REQUIRED')
  await expect(resolveUsdStandardLibrary(ops.resources,{...declaration,parameters:[{name:'diffuse_texture',typeName:'float'}]})).rejects.toThrow('USD_STANDARD_LIBRARY_REQUIRED')
  await expect(resolveUsdStandardLibrary(ops.resources,{...declaration,parameters:[{name:'unknown',typeName:'float'}]})).rejects.toThrow('USD_STANDARD_LIBRARY_REQUIRED')
  await writeFile(join(core,'VERSION.md'),'2.2.0\n');const second=await registerNvidiaUsdStandardLibrary(ops.resources,core)
  await expect(resolveUsdStandardLibrary(ops.resources,declaration)).rejects.toThrow('USD_STANDARD_LIBRARY_SELECTION_REQUIRED')
  const archive=new PortableArchive(join(root,'portable')),license=join(dirname(fileURLToPath(resource.ref.original.uri)),checked.manifest.license.file)
  await archive.place(license,await fileStamp(license),join(root,'portable/shared/license.txt'),'same-byte-license-first')
  for(const record of [resource,second]){const copies=await archive.copyResource(record.ref,record),entry=copies.get(fileURLToPath(record.ref.original.uri))!;expect((await readUsdStandardLibrary(entry)).manifest.license.id).toBe('BSD-3-Clause');expect((await readUsdStandardLibrary(entry)).files.every(path=>path.startsWith(join(root,'portable')+'/'))).toBe(true)}
  const stored=join(dirname(fileURLToPath(resource.ref.original.uri)),'Base/Helper.mdl');await writeFile(stored,await readFile(stored,'utf8')+'// changed\n')
  await expect(readUsdStandardLibrary(fileURLToPath(resource.ref.original.uri))).rejects.toThrow('USD_STANDARD_LIBRARY_HASH_MISMATCH')
 }finally{await rm(root,{recursive:true,force:true})}
})

test('旧Warehouse固定源快照按CSV/Git字节身份读取，753仅该版本目录行数；缺扩展名从源文件清单唯一确认',async()=>{
 const catalog=await loadWarehouseCatalog()
 expect(catalog.rows.length).toBe(753);expect(catalog.catalogState).toBe('PINNED_SNAPSHOT');expect(catalog.pins.revision).toBe(WAREHOUSE_REVISION)
 const first=warehouseEntry(catalog,catalog.rows[0]!.catalogPath)
 expect(first.row.catalogPath.endsWith('.usd')).toBe(false);expect(first.file.path).toBe(first.row.catalogPath+'.usd');expect(warehouseEntry(catalog,first.file.path).row.catalogPath).toBe(first.row.catalogPath)
 expect(catalog.rows[0]!.massUnit).toBe('unspecified')
 for(const row of catalog.rows)expect(warehouseEntry(catalog,row.catalogPath).file.path).toMatch(/\.(usd|usda|usdc|usdz)$/i)
})
test('CSV逗号/引号/换行保真；原文官方预览URL不作为自动请求字段返回',()=>{
 const csv='asset_preview,asset_name,relative_path,classification,label,q_code,mass,thumbnail_path\nhttps://huggingface.co/do-not-request,"box, ""A""",Props/box.usd,"Prop\ngeneral",box,Q1,0.5,previews/box.png\n'
 const row=parseWarehouseCsv(csv)[0]!
 expect(row.name).toBe('box, "A"');expect(row.classification).toBe('Prop\ngeneral');expect(row.declaredMass).toBe(.5);expect(row.massUnit).toBe('unspecified');expect(JSON.stringify(row)).not.toContain('huggingface.co')
 expect(()=>parseWarehouseCsv(csv.replace('Props/box.usd','../private.usd'))).toThrow('WAREHOUSE_PATH_UNSAFE')
})
test('资产级搜索/详情来自固定版本，刷新失败保留明确错误与缓存状态；不伪造BOM/验证或缩略图',async()=>{
 const found=await simreadySearch({repoIds:[WAREHOUSE_REPO],query:'glasses'})
 expect(found.status).toBe('FOUND');expect(found.candidates[0]!.source).toBe('warehouse-csv');expect(found.candidates[0]!.thumbnailStatus).toBe('NOT_FETCHED')
 expect(JSON.stringify(found)).not.toContain('huggingface.co')
 const candidate=found.candidates[0]!,detail=await simreadyDetail({repoId:candidate.repoId,revision:candidate.revision,packagePath:candidate.packagePath})
 expect(detail.sourceProtocol).toBe('warehouse-csv-v1');if(detail.sourceProtocol!=='warehouse-csv-v1')throw Error('legacy protocol required')
 expect(detail.license.id).toBe('CC-BY-4.0');expect(detail.rootUsd.endsWith('.usd')).toBe(true);expect(detail.thumbnail.status).toBe('NOT_FETCHED');expect(detail).not.toHaveProperty('packageId');expect(detail).not.toHaveProperty('metadataFiles')
 const failed=await simreadySearch({repoIds:[WAREHOUSE_REPO],query:'glasses',refresh:true},{fetchBytes:async()=>{throw Error('SIMREADY_MIRROR_BLOCKED: official redirect')}})
 expect(failed.status).toBe('PARTIAL');expect(failed.candidates.length).toBeGreaterThan(0);expect(failed.failures[0]!.reason).toContain('刷新失败');expect(failed.sourceSnapshots[0]!.catalogState).toBe('PINNED_SNAPSHOT')
 const noMatch=await simreadySearch({repoIds:[WAREHOUSE_REPO],query:'absent-this-fixture-word'});expect(noMatch.status).toBe('NO_MATCH')
})
test('真实753行目录的托盘Top-k优先原Pallet标签，pallet不误命中调色刀且Q code可查',async()=>{
 const catalog=await loadWarehouseCatalog(),knives=catalog.rows.filter(row=>row.name.includes('palletknife'))
 expect(knives).toHaveLength(5);expect(knives.every(row=>row.label==='painting_knife'&&row.qCode==='Q1756462')).toBe(true)
 for(const query of ['托盘','pallet','Q505996']){
  const found=await simreadySearch({repoIds:[WAREHOUSE_REPO],query,limit:3})
  expect(found.status).toBe('FOUND');expect(found.registeredEntriesRead).toBe(753);expect(found.candidates).toHaveLength(3)
  expect(found.candidates[0]!.packagePath).toBe('Props/general/Pallet_A1/Pallet_A1_physics.usd')
  expect(found.candidates.every(row=>row.catalog?.label==='Pallet'&&row.catalog.qCode==='Q505996')).toBe(true)
  expect(found.candidates.some(row=>row.name.includes('palletknife'))).toBe(false)
 }
 const pallets=await simreadySearch({repoIds:[WAREHOUSE_REPO],query:'pallet',limit:30})
 // 28个源Pallet标签优先，另召回3个Pallet Truck及5个Pallets；不猜无标签palletcomposition的语义。
 expect(pallets.matched).toBe(36);expect(pallets.candidates.every(row=>!row.name.includes('palletknife'))).toBe(true)
 expect(pallets.candidates.slice(0,28).every(row=>row.catalog?.label==='Pallet')).toBe(true)
 const plural=await simreadySearch({repoIds:[WAREHOUSE_REPO],query:'Pallets',limit:3});expect(plural.candidates[0]!.name).toBe('Pallets_A1_physics')
 for(const query of ['palletknife','painting knife','Q1756462']){
  const found=await simreadySearch({repoIds:[WAREHOUSE_REPO],query,limit:3})
  expect(found.status).toBe('FOUND');expect(found.matched).toBe(5);expect(found.candidates).toHaveLength(3)
  expect(found.candidates.every(row=>row.catalog?.label==='painting_knife')).toBe(true)
 }
})
test('源文件身份区分Git blob和LFS SHA，不能把自己的SHA冒称新版BOM',()=>{
 const bytes=Buffer.from('#usda 1.0\n')
 expect(()=>verifyWarehouseFile(bytes,{path:'a.usda',size:bytes.length,gitBlob:gitBlob(bytes)})).not.toThrow()
 expect(()=>verifyWarehouseFile(bytes,{path:'a.usda',size:bytes.length,gitBlob:'1'.repeat(40),lfsSha256:sha256(bytes)})).not.toThrow()
 expect(()=>verifyWarehouseFile(Buffer.from('corrupt'),{path:'a.usda',size:bytes.length,gitBlob:gitBlob(bytes)})).toThrow('WAREHOUSE_FILE_IDENTITY_MISMATCH')
})

test('真实ToolRegistry同路提供旧Warehouse搜索与详情，不内联二进制或undefined值',async()=>{
 const {Context}=await import('@deepseek-ai/cordis'),{default:SystemPrompt}=await import('@deepseek-ai/dsh-system-prompt'),{default:Tools}=await import('@deepseek-ai/dsh-tools'),{default:Sessions,SessionId}=await import('@deepseek-ai/dsh-session'),{default:Commands}=await import('@deepseek-ai/dsh-commands'),{ToolCallId}=await import('@deepseek-ai/dsh-llm'),Scene=await import('../src/plugin.ts')
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),root=await mkdtemp(join(tmpdir(),'warehouse-tools-'))
 try{const ctx=new Context();await ctx.plugin(SystemPrompt);await ctx.plugin(Tools);await ctx.plugin(Sessions);await ctx.plugin(Commands);await ctx.plugin(Scene,{dataRoot:join(root,'catalog'),productRoot:join(root,'empty')})
  const session=ctx.sessions.create(SessionId('warehouse-fixture')),agent={id:session.id,session} as any,signal=new AbortController().signal
  const search=await ctx.tools.execute({callId:ToolCallId('warehouse-search'),name:'simready_search',arguments:{input:{repoIds:[WAREHOUSE_REPO],query:'glasses'}},signal,agent});expect(search.isError).toBe(false);if(search.isError)throw Error(search.error.message)
  const candidate=(search.value as any).candidates[0],detail=await ctx.tools.execute({callId:ToolCallId('warehouse-detail'),name:'simready_detail',arguments:{input:{repoId:candidate.repoId,revision:candidate.revision,packagePath:candidate.packagePath}},signal,agent});expect(detail.isError).toBe(false);if(detail.isError)throw Error(detail.error.message)
  expect((detail.value as any).sourceProtocol).toBe('warehouse-csv-v1');expect(JSON.stringify(detail.value)).not.toContain('huggingface.co')
  const pallets=await ctx.tools.execute({callId:ToolCallId('warehouse-pallet-search'),name:'simready_search',arguments:{input:{repoIds:[WAREHOUSE_REPO],query:'托盘',limit:3}},signal,agent});expect(pallets.isError).toBe(false);if(pallets.isError)throw Error(pallets.error.message)
  expect((pallets.value as any).candidates.map((row:any)=>row.name)).toEqual(['Pallet_A1_physics','Pallet_B1_physics','Pallet_C1_physics'])
 }finally{await rm(root,{recursive:true,force:true})}
})
