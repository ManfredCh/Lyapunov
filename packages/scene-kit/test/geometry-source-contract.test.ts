import {test,expect} from 'bun:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {objMaterialFiles} from '../src/geometry-source-deps.ts'
import {parseAsset} from '../src/formats.ts'
import {convertSourceOf,registrableConvertSourceOf} from '../../lyapunov-workspace/src/model-source.ts'
import {localFileKind,importLocalFiles} from '../../lyapunov-shell/src/local-file-import.ts'
test('OBJ/FBX分类与登记源/转换入口一致，MAX不伪支持',()=>{for(const suffix of ['.obj','.fbx']){expect(convertSourceOf('/test/model'+suffix)).toBe(suffix.slice(1) as any);expect(registrableConvertSourceOf('/test/model'+suffix)).toBe(suffix.slice(1) as any);expect(localFileKind('/test/model'+suffix)).toBe('source')}expect(localFileKind('/test/model.max')).toBeUndefined()})
test('OBJ MTL带空格原名/多个声明与缺件均沿真实路径',async()=>{const dir=await mkdtemp(join(tmpdir(),'obj-mtl-'));try{const path=join(dir,'model.obj'),mtl=join(dir,'colored material.mtl');await writeFile(mtl,'newmtl Color\nKd 1 .7 .02\n');await writeFile(path,'mtllib colored material.mtl\nv 0 0 0\n');expect(await objMaterialFiles(path)).toEqual([mtl]);await writeFile(path,'mtllib missing.mtl\nv 0 0 0\n');await expect(parseAsset(path)).rejects.toThrow('RESOURCE_DEPENDENCY_MISSING');await writeFile(path,'not an obj');await expect(objMaterialFiles(path)).rejects.toThrow('INVALID_OBJ_HEADER')}finally{await rm(dir,{recursive:true,force:true})}})
test('MAX原件明确转换要求，不改后缀或调用源件入库假成功',async()=>{const dir=await mkdtemp(join(tmpdir(),'max-unsupported-'));try{const path=join(dir,'model.max');await writeFile(path,'fixture-unsupported');await expect(parseAsset(path)).rejects.toThrow('MAX_CONVERSION_REQUIRED');let invoked=false;const result=await importLocalFiles({current:()=>true,command:async()=>{invoked=true;throw new Error('不能执行')},show:()=>{},progress:()=>{}},[path],'library');expect(invoked).toBe(false);expect(result.errors[0]).toContain('3ds Max')}finally{await rm(dir,{recursive:true,force:true})}})
