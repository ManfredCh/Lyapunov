import {execFile} from 'node:child_process'
import {readFile,stat} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {blenderExecutable,blenderEnvironment} from './blend-deps.ts'
export type SourceTexturePolicy='strict'|'available'
/** OBJ 的 MTL 是材质内容依赖，不只登记最终图片；带空格名称由 OBJ 原声明给出。 */
export async function objMaterialFiles(path:string):Promise<string[]>{
 const text=await readFile(path,'utf8'),files:string[]=[]
 if(!/(?:^|\n)\s*v\s+[-+\d.]/.test(text))throw new Error('INVALID_OBJ_HEADER: 没有真实顶点记录')
 for(const line of text.split(/\r?\n/)){
  const match=line.match(/^\s*mtllib\s+(.+?)\s*$/);if(!match)continue
  const raw=match[1]!.replace(/\s+#.*$/,'').trim()
  // Blender 也支持单个包含空格的名称；先核原整串文件，存在时不拆坏。
  const whole=resolve(dirname(path),raw.replace(/^"|"$/g,''))
  if(await stat(whole).then(s=>s.isFile(),()=>false)){files.push(whole);continue}
  const names=raw.match(/"[^"]+"|'[^']+'|\S+/g)??[]
  for(const name of names)files.push(resolve(dirname(path),name.replace(/^["']|["']$/g,'')))
 }
 return [...new Set(files)]
}
/** 实际 Blender 导入读取依赖/层级/骨骼/动画，不保存源文件；列表只有本次已导入场景。 */
export async function geometrySourceFacts(path:string,kind:'obj'|'fbx',texturePolicy:SourceTexturePolicy='strict'){
 if(texturePolicy!=='strict'&&texturePolicy!=='available')throw new Error('SOURCE_TEXTURE_POLICY_INVALID')
 const script=`import bpy,json,os,sys
source,kind=sys.argv[sys.argv.index('--')+1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
if kind=='obj': bpy.ops.wm.obj_import(filepath=source)
else: bpy.ops.import_scene.fbx(filepath=source)
images=[]
for image in bpy.data.images:
 raw=image.filepath or ''
 if not raw or raw.startswith('<') or image.packed_file: continue
 target=os.path.normpath(bpy.path.abspath(raw))
 images.append({'raw':raw,'resolved':target,'exists':os.path.isfile(target)})
objects=[o for o in bpy.data.objects]
print('GEOMETRY_SOURCE='+json.dumps({'blender':bpy.app.version_string,'images':images,'imageCount':len(bpy.data.images),'packedImageCount':sum(bool(image.packed_file) for image in bpy.data.images),'objects':[{'name':o.name,'type':o.type,'parent':o.parent.name if o.parent else None} for o in objects],'materials':len(bpy.data.materials),'meshes':sum(o.type=='MESH' for o in objects),'bones':sum(len(o.data.bones) for o in objects if o.type=='ARMATURE'),'actions':len(bpy.data.actions)}))`
 const result=await new Promise<{stdout:string;stderr:string;code:number|string|null}>((done)=>execFile(blenderExecutable(),['--background','--factory-startup','--python-exit-code','1','--python-expr',script,'--',path,kind],{cwd:dirname(path),env:blenderEnvironment(),timeout:120000,maxBuffer:2*1024*1024},(error,stdout,stderr)=>done({stdout:String(stdout),stderr:String(stderr),code:error?(error as {code?:number|string}).code??1:0})))
 if(result.code!==0)throw new Error('GEOMETRY_SOURCE_IMPORT_FAILED: '+kind+' exit='+result.code+' '+result.stderr.slice(-600))
 const line=result.stdout.split('\n').find(v=>v.startsWith('GEOMETRY_SOURCE='))
 if(!line)throw new Error('GEOMETRY_SOURCE_IMPORT_FAILED: Blender 没有返回真实源事实')
 const facts=JSON.parse(line.slice('GEOMETRY_SOURCE='.length)) as {blender:string;images:Array<{raw:string;resolved:string;exists:boolean}>;imageCount:number;packedImageCount:number;meshes:number;bones:number;objects:unknown[];actions:number}
 if(!facts.meshes)throw new Error('GEOMETRY_SOURCE_EMPTY: 没有可转换的实际mesh')
 const missing=facts.images.filter(v=>!v.exists)
 if(missing.length&&texturePolicy==='strict')throw new Error('RESOURCE_DEPENDENCY_MISSING: '+missing.map(v=>v.raw).join('、')+'；补全贴图后重导入，或明确选择“保留几何与现有材质导入”')
 const emptyTextureDeclarations=result.stdout.split('\n').filter(v=>v.includes('could not find any file path')).map((text,index)=>({index,kind:'empty-texture-path' as const,sha256:createHash('sha256').update(text).digest('hex')}))
 return {...facts,texturePolicy,missingImages:missing,emptyTextureDeclarations,externalsVerified:missing.length===0}
}
