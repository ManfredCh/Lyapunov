/** 真实旧登记/旧 Scene 缺源信息恢复：核同版本字节，不猜轴；只在临时数据目录制造旧记录。 */
import { test, expect, afterEach } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SceneOperations } from '../src/operations.ts'
import { localPath } from '../src/formats.ts'
import { box, solidGlb } from './glb-geometry-fixture.ts'

const directories: string[] = []
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})))})
async function legacy() {
 const root=await mkdtemp(join(tmpdir(),'lya-legacy-source-'));directories.push(root)
 const operations=new SceneOperations(join(root,'data'))
 await mkdir(join(root,'fixtures'))
 const path=join(root,'fixtures','地板.glb')
 const bytes=solidGlb({generator:'来源恢复夹具',nodes:[{name:'地板',mesh:box(.1)}]})
 await writeFile(path,bytes)
 await operations.create({sceneId:'legacy'})
 const added=await operations.import({path,sceneId:'legacy',resourceId:'floor',physicalize:false,source:{units:'mm',metersPerUnit:.001,upAxis:'Y',handedness:'right'}})
 const original=await operations.scene.snapshot('legacy')
 const registry=JSON.parse(await readFile(operations.resources.indexPath,'utf8'))
 delete registry.records[0].ref.source
 await writeFile(operations.resources.indexPath,JSON.stringify(registry))
 for(const entity of original.entities)for(const ref of entity.resources)delete (ref as {source?:unknown}).source
 await writeFile(operations.scene.path('legacy'),JSON.stringify(original))
 return {root,operations,bytes,added,registry,original}
}
test('旧引用从已验同版本 parsed.source 恢复；不改轴、位姿、字节、历史或注册表',async()=>{
 const {operations,bytes,added,original}=await legacy()
 const registryBefore=await readFile(operations.resources.indexPath,'utf8'),sceneBefore=await readFile(operations.scene.path('legacy'),'utf8')
 const resolved=await operations.inspect('legacy')
 expect(resolved.revision).toBe(original.revision)
 expect(resolved.entities.map(e=>({...e,resources:[]}))).toEqual(original.entities.map(e=>({...e,resources:[]})))
 for(const entity of resolved.entities)for(const ref of entity.resources)expect(ref.source).toEqual(added.resource.parsed.source)
 expect((await readFile(localPath(added.resource.ref.original.uri))).toString('hex')).toBe(bytes.toString('hex'))
 expect(await readFile(operations.resources.indexPath,'utf8')).toBe(registryBefore)
 expect(await readFile(operations.scene.path('legacy'),'utf8')).toBe(sceneBefore)
 expect(await operations.resources.readVerifiedResource(resolved,added.resource.ref.original.uri)).toEqual(bytes)
 const mounted=await operations.mount({sceneId:'legacy',resourceId:'floor',entityId:'another'})
 expect(mounted.snapshot.entities.find(e=>e.entityId==='another')!.resources[0]!.source).toEqual(added.resource.parsed.source)
})
test('原件缺失或同版本字节已改时拒绝补源，不写回错误默认值',async()=>{
 const {operations,added}=await legacy()
 const source=localPath(added.resource.ref.original.uri)
 await writeFile(source,Buffer.from('changed'))
 await expect(operations.inspect('legacy')).rejects.toThrow('RESOURCE_SOURCE_ORIGINAL_UNAVAILABLE')
 await rm(source)
 await expect(operations.resources.get('floor',1)).rejects.toThrow('RESOURCE_SOURCE_ORIGINAL_UNAVAILABLE')
})
test('修复写入正常新版本，旧历史可恢复；重复打开不增加版本',async()=>{
 const {operations,original,added}=await legacy()
 const repaired=await operations.repairResourceSources('legacy')
 expect(repaired.revision).toBe(original.revision+1)
 expect((await operations.scene.snapshot('legacy')).entities.flatMap(e=>e.resources).every(ref=>JSON.stringify(ref.source)===JSON.stringify(added.resource.parsed.source))).toBe(true)
 expect((await operations.scene.version('legacy',original.revision)).entities).toEqual(original.entities)
 expect((await operations.repairResourceSources('legacy')).revision).toBe(repaired.revision)
 expect(repaired.entities.map(e=>({...e,resources:[]}))).toEqual(original.entities.map(e=>({...e,resources:[]})))
})
test('已有完整却矛盾的声明不被静默覆盖，缺权威 source 不猜默认',async()=>{
 const {operations,original}=await legacy()
 const explicit=structuredClone(original)
 explicit.entities.flatMap(e=>e.resources).forEach(ref=>ref.source={units:'m',upAxis:'Z',handedness:'right'})
 const returned=await operations.completeResourceSources(explicit)
 expect(returned).toBe(explicit)
 expect(await operations.resources.recordFor(explicit.entities.flatMap(e=>e.resources)[0]!)).toBeUndefined()
 const registry=JSON.parse(await readFile(operations.resources.indexPath,'utf8'))
 delete registry.records[0].parsed.source
 await writeFile(operations.resources.indexPath,JSON.stringify(registry))
 await expect(operations.inspect('legacy')).rejects.toThrow('RESOURCE_SOURCE_UNAVAILABLE')
})
