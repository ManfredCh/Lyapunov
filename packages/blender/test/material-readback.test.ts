/** 真 Blender 运行与导出；需要 BLENDER_EXECUTABLE，不把缺条件当通过。 */
import {describe, expect, test} from 'bun:test'
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'

const blender = process.env.BLENDER_EXECUTABLE || 'blender'
const world = new URL('../src/world.py', import.meta.url).pathname
const helper = new URL('../python/artifact_inspect.py', import.meta.url).pathname
const available = spawnSync(blender, ['--version'], {encoding: 'utf8'}).status === 0
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
describe.skipIf(!available)('Actual Blender material loss and GLB reload', () => {
  test('connected procedural effects are exposed, disconnected nodes are not, image GLB really reloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lyapunov-material-readback-'))
    const script = join(dir, 'scene.py')
    writeFileSync(script, `import bpy
for obj in list(bpy.data.objects): bpy.data.objects.remove(obj, do_unlink=True)
for name,x,kind in [('Procedural',0,'noise'),('Image',3,'image'),('Disconnected',6,'unused')]:
 bpy.ops.mesh.primitive_cube_add(size=2, location=(x,0,1))
 obj=bpy.context.active_object;obj.name=name;obj.data.name=name+'Mesh'
 mat=bpy.data.materials.new(name+'Mat');mat.use_nodes=True
 tree=mat.node_tree;bsdf=next(n for n in tree.nodes if n.type=='BSDF_PRINCIPLED')
 if kind=='noise':
  noise=tree.nodes.new('ShaderNodeTexNoise');bump=tree.nodes.new('ShaderNodeBump')
  tree.links.new(noise.outputs['Fac'],bump.inputs['Height']);tree.links.new(bump.outputs['Normal'],bsdf.inputs['Normal'])
 elif kind=='image':
  img=bpy.data.images.new('PortableChecker',width=8,height=8)
  img.pixels=[c for y in range(8) for x in range(8) for c in ([0.8,0.2,0.1,1] if (x+y)%2 else [0.1,0.7,0.4,1])]
  img.pack();node=tree.nodes.new('ShaderNodeTexImage');node.image=img
  tree.links.new(node.outputs['Color'],bsdf.inputs['Base Color'])
 else: tree.nodes.new('ShaderNodeTexNoise')
 obj.data.materials.append(mat)
`)
    const run = spawnSync(blender, ['--background','--factory-startup','--python-exit-code','1','--python',script,
      '--python',world,'--','--output',dir,'--operation','export'], {encoding:'utf8',timeout:60_000})
    expect(run.status).toBe(0)
    const result = JSON.parse(run.stdout.split('\n').find(line => line.startsWith('LYAPUNOV_RESULT='))!.slice(16))
    expect(result.materialLosses).toHaveLength(1)
    expect(result.materialLosses[0]).toContain('BUMP, TEX_NOISE')
    const scene = readJson(join(dir,'scene.json'))
    const rep = (name: string) => scene.entities.find((e: any) => e.name===name).resources[0].representations[0]
    expect(rep('Procedural').losses.some((x: string) => x.startsWith('BLENDER_PROCEDURAL_MATERIAL_UNBAKED:'))).toBe(true)
    expect(rep('Disconnected').losses.some((x: string) => x.startsWith('BLENDER_PROCEDURAL_MATERIAL_UNBAKED:'))).toBe(false)
    const reload = spawnSync(blender, ['--background','--factory-startup','--python-exit-code','1','--python',helper,
      '--',rep('Image').uri,'--require-textures','--roundtrip'], {encoding:'utf8',timeout:60_000})
    expect(reload.status).toBe(0)
    const facts = JSON.parse(reload.stdout.split('\n').find(line => line.startsWith('{"path":'))!)
    expect(facts.roundtrip.evidence).toBe('blender-gltf-import')
    expect(facts.roundtrip.meshObjects).toBe(1)
    expect(facts.roundtrip.loadedImageTextures).toBe(1)
    expect(facts.visualMatch).toBe('not-evaluated')
  }, 120_000)
})
