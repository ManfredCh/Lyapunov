/**
 * ENV-21 原型检查 + ENV-49 落地/复制：真实 SceneOperations（真落盘、真登记、真解析）。
 *
 * 覆盖三条真实行为：
 *  - 原型没有可用包围盒（造型/底面/尺度不可判定）时，默认"底面贴地"的挂载**拒绝复制**（PROTOTYPE_BOUNDS_UNAVAILABLE），
 *    场景实体数与 revision 都不动；
 *  - 拒绝的边界要准：不给 position 与显式 alignBottomToSurface:false 仍然可导入；
 *  - 原型通过（有包围盒）时：底面按请求高度落位，≥2 处复制共用同一个 resourceId@version；
 *    缺 NORMAL 这类不阻断落地的项走 warnings 明确点名（不静默）。
 * 运行：`bun test packages/scene-kit/test/prototype-inspection.test.ts`
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireAsset } from '../src/asset-acquisition.ts'
import { SceneOperations } from '../src/operations.ts'
import {assetBounds,parseAsset} from '../src/formats.ts'

let workspace = ''
beforeEach(async () => { workspace = await mkdtemp(join(tmpdir(), 'lya-env21-')) })
afterEach(async () => { await rm(workspace, { recursive: true, force: true }) })

/** 最小 GLB：三角形，可选 NORMAL；用于"有包围盒/无包围盒"两类原型。 */
function triangleGLB(withNormal: boolean): Buffer {
  const positions = Buffer.alloc(9 * 4)
  ;[[0, 0, 0], [1, 0, 0], [0, 1, 0]].forEach((p, i) => p.forEach((v, j) => positions.writeFloatLE(v, (i * 3 + j) * 4)))
  const normals = Buffer.alloc(9 * 4)
  ;[[0, 0, 1], [0, 0, 1], [0, 0, 1]].forEach((n, i) => n.forEach((v, j) => normals.writeFloatLE(v, (i * 3 + j) * 4)))
  const indices = Buffer.alloc(3 * 2); [0, 1, 2].forEach((v, i) => indices.writeUInt16LE(v, i * 2))
  const bin = withNormal ? Buffer.concat([positions, normals, indices]) : Buffer.concat([positions, indices])
  const attributes: Record<string, number> = { POSITION: 0 }
  if (withNormal) attributes.NORMAL = 1
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes, indices: withNormal ? 2 : 1, material: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      ...(withNormal ? [{ bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' }] : []),
      { bufferView: withNormal ? 2 : 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length },
      ...(withNormal ? [{ buffer: 0, byteOffset: positions.length, byteLength: normals.length }] : []),
      { buffer: 0, byteOffset: withNormal ? positions.length + normals.length : positions.length, byteLength: indices.length },
    ],
    buffers: [{ byteLength: bin.length }],
    materials: [{ name: 'proto', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
  }
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8')
  const paddedJSON = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)])
  const paddedBIN = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4, 0)])
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + paddedJSON.length + 8 + paddedBIN.length, 8)
  const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(paddedJSON.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(paddedBIN.length, 0); binHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonHeader, paddedJSON, binHeader, paddedBIN])
}

describe('ENV-21 原型不通过就不复制', () => {
  it('原生MJCF/URDF真实kind为robot：缺bounds默认及显式true拒写，false保用户模型原点与原件姿态',async()=>{
    const pose={position:[2,3,4] as [number,number,number],quaternion:[0,0,0,1] as [number,number,number,number],scale:[1,1,1] as [number,number,number]}
    // MJCF 尚未派生 bounds；合法但没有 visual 的 URDF 也不能猜测底面。
    const sources=[['xml','mjcf','<mujoco model="arbitrary-native"><worldbody><body name="root" pos="0 0 1"><geom type="box" size=".1 .2 .3"/></body></worldbody></mujoco>'],['urdf','urdf','<robot name="other-native"><link name="root"/></robot>']] as const
    for(const [extension,format,source] of sources){
      const path=join(workspace,`arbitrary.${extension}`);await writeFile(path,source)
      const operations=new SceneOperations(join(workspace,'data-'+extension)),scene=await operations.create({name:extension})
      const imported=await operations.import({path,resourceId:'arbitrary-resource',physicalize:false}),row=(await operations.resources.list({}))[0]!
      expect(row.parsed.kind).toBe('robot');expect(row.parsed.metadata.format).toBe(format)
      const input={sceneId:scene.sceneId,resourceId:row.ref.resourceId,version:row.ref.version,transform:pose}
      await expect(operations.mount(input)).rejects.toThrow('PROTOTYPE_BOUNDS_UNAVAILABLE')
      await expect(operations.mount({...input,alignBottomToSurface:true})).rejects.toThrow('PROTOTYPE_BOUNDS_UNAVAILABLE')
      expect((await operations.inspect(scene.sceneId)).revision).toBe(0);expect((await operations.inspect(scene.sceneId)).entities).toEqual([])
      const placed=await operations.mount({...input,alignBottomToSurface:false}),entity=placed.snapshot.entities.find(row=>row.entityId===placed.entityId)!
      expect(placed.snapshot.revision).toBe(1);expect(entity.transform).toEqual(pose);expect(entity.components.articulation?.format).toBe(format);expect(entity.components.visual?.robot).toBeDefined()
      expect(entity.resources[0]?.resourceId).toBe(imported.resource.ref.resourceId);expect(await readFile(path,'utf8')).toBe(source)
    }
  })
  it('没有包围盒（造型/底面/尺度不可判定）：默认落地对齐拒绝复制，场景不动；显式 false 与不给 position 仍可导入', async () => {
    const prototype = join(workspace, 'prototype-nobounds.sog')
    await writeFile(prototype, Buffer.concat([Buffer.from('SOG0'), Buffer.alloc(1024, 3)]))
    const operations = new SceneOperations(join(workspace, 'data'))
    const scene = await operations.create({ name: 'nobounds' })
    const pose = { position: [0, 0, 1.5] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] }

    await expect(operations.import({ path: prototype, sceneId: scene.sceneId, name: 'proto', transform: pose, physicalize: false }))
      .rejects.toThrow(/PROTOTYPE_BOUNDS_UNAVAILABLE/)
    const untouched = await operations.inspect(scene.sceneId)
    expect(untouched.entities).toEqual([])
    expect(untouched.revision).toBe(0)

    // 拒绝的边界：不给 position（不做落地对齐）与显式 alignBottomToSurface:false（调用方自己落位）都放行。
    const origin = await operations.import({ path: prototype, sceneId: scene.sceneId, name: 'origin', physicalize: false })
    const explicit = await operations.import({ path: prototype, sceneId: scene.sceneId, name: 'explicit', transform: pose, alignBottomToSurface: false, physicalize: false })
    const snapshot = await operations.inspect(scene.sceneId)
    expect(snapshot.entities.find(entity => entity.entityId === origin.entityId)?.transform?.position).toEqual([0, 0, 0])
    expect(snapshot.entities.find(entity => entity.entityId === explicit.entityId)?.transform?.position).toEqual([0, 0, 1.5])
  })

  it('原型通过：底面按请求高度落位，≥2 处复制共用同一 resourceId@version；缺 NORMAL 走 warnings 点名', async () => {
    const prototype = join(workspace, 'prototype.glb')
    await writeFile(prototype, triangleGLB(false))
    const operations = new SceneOperations(join(workspace, 'data'))
    const scene = await operations.create({ name: 'pass' })
    const acquired = await acquireAsset(operations, {
      path: prototype, sceneId: scene.sceneId, name: 'proto',
      transform: { position: [0, 0, 2], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, physicalize: false,
    })
    // 读数：造型范围/底面/法线/材质通道都来自组装结果本身。
    expect(acquired.model.bounds).toEqual({ min: [0, 0, 0], max: [1, 0, 1] })
    expect(acquired.model.bottomM).toBe(0)
    expect(acquired.model.normals).toEqual({ primitives: 1, withNormals: 0, missing: 1 })
    expect(acquired.model.materialChannels).toEqual([['baseColorFactor']])
    expect(acquired.warnings.some(warning => warning.includes('没有 NORMAL 法线数据'))).toBe(true)

    const second = await operations.mount({
      sceneId: scene.sceneId, resourceId: acquired.resource.ref.resourceId, version: acquired.resource.ref.version,
      transform: { position: [3, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    })
    const snapshot = await operations.inspect(scene.sceneId)
    const roots = snapshot.entities.filter(entity => entity.entityId === acquired.entityId || entity.entityId === second.entityId)
    expect(roots.map(entity => entity.resources!.map(ref => `${ref.resourceId}@${ref.version}`))).toEqual([
      [`${acquired.resource.ref.resourceId}@${acquired.resource.ref.version}`],
      [`${acquired.resource.ref.resourceId}@${acquired.resource.ref.version}`],
    ])
    // 落地：请求高度 2 与 0 都被"底面贴到该高度"吸收（包围盒底面自身为 0，不额外抬升）。
    expect(roots[0]!.transform!.position[2]).toBeCloseTo(2, 6)
    expect(roots[1]!.transform!.position[2]).toBeCloseTo(0, 6)
  })

  it('原型文件不存在时是明确报错，不产生场景实体', async () => {
    const operations = new SceneOperations(join(workspace, 'data'))
    const scene = await operations.create({ name: 'missing' })
    await expect(operations.import({ path: join(workspace, 'nope.glb'), sceneId: scene.sceneId, physicalize: false })).rejects.toThrow(/ENOENT|not exist|不存在/i)
    expect((await operations.inspect(scene.sceneId)).entities).toEqual([])
  })
})

describe('Native URDF initial visual bounds and ordinary bottom placement',()=>{
  const triangleSTL=()=>{
    const data=Buffer.alloc(134);data.writeUInt32LE(1,80)
    ;[[0,0,-2],[1,0,0],[0,2,0]].flat().forEach((v,i)=>data.writeFloatLE(v,96+i*4))
    return data
  }
  const robot=(geometry:string,joint='')=>`<robot name="bound-original"><link name="base"/><link name="tip"><visual><origin xyz="1 0 0"/><geometry>${geometry}</geometry></visual></link><joint name="hinge" type="revolute"><parent link="base"/><child link="tip"/><origin xyz="1 2 3" rpy="0 0 1.5707963267948966"/></joint>${joint}</robot>`
  it('STL vertices, mesh scale, visual origin and zero-joint FK determine placement without a guessed robot height',async()=>{
    const mesh=join(workspace,'original.stl'),path=join(workspace,'original.urdf')
    await writeFile(mesh,triangleSTL());await writeFile(path,robot('<mesh filename="original.stl" scale="2 3 4"/>'))
    const before=await readFile(mesh),operations=new SceneOperations(join(workspace,'urdf-data')),scene=await operations.create({})
    const imported=await operations.import({path,sceneId:scene.sceneId,physicalize:false,transform:{position:[9,8,4],quaternion:[0,0,0,1],scale:[1,1,1]}})
    const bounds=imported.resource.parsed.metadata.aabb as {min:number[];max:number[]}
    for(const [i,n] of [-5,3,-5].entries())expect(bounds.min[i]).toBeCloseTo(n,6)
    for(const [i,n] of [1,5,3].entries())expect(bounds.max[i]).toBeCloseTo(n,6)
    const facts=imported.resource.parsed.metadata.boundsFacts as any
    expect(facts).toMatchObject({status:'available',source:'urdf-visual-vertices',pose:'zero-joint-initial',dynamicPoseEvaluated:false,meshCount:1})
    expect(facts.meshSources[0].sha256).toHaveLength(64)
    const mounted=imported.snapshot!.entities.find(e=>e.entityId===imported.entityId)!
    expect(mounted.transform.position).toEqual([9,8,9])
    expect(mounted.components.articulation?.format).toBe('urdf')
    expect(await readFile(mesh)).toEqual(before)
    const converted=assetBounds(imported.resource.parsed,{units:'mm',upAxis:'Z',handedness:'right',metersPerUnit:0.001})!
    expect(converted.min[2]).toBeCloseTo(-0.005,9)
  })
  it('existing OBJ geometry and declared primitive visuals can supply a complete initial bound',async()=>{
    const path=join(workspace,'obj.urdf');await writeFile(join(workspace,'part.obj'),'v 0 0 -2\nv 1 0 0\nv 0 2 0\nf 1 2 3\n')
    await writeFile(path,robot('<mesh filename="part.obj" scale="2 3 4"/>'))
    const mesh=await parseAsset(path);expect((mesh.metadata.aabb as any).min[2]).toBeCloseTo(-5,6)
    const box=join(workspace,'box.urdf');await writeFile(box,'<robot name="box"><link name="root"><visual><origin xyz="0 0 1"/><geometry><box size=".2 .3 .4"/></geometry></visual></link></robot>')
    const declared=await parseAsset(box);expect((declared.metadata.aabb as any).min[2]).toBeCloseTo(.8,6)
    const operations=new SceneOperations(join(workspace,'box-data')),scene=await operations.create({})
    const mounted=await operations.import({path:box,sceneId:scene.sceneId,physicalize:false,transform:{position:[0,0,2],quaternion:[0,0,0,1],scale:[1,1,1]}})
    expect(mounted.snapshot!.entities.find(e=>e.entityId===mounted.entityId)!.transform.position[2]).toBeCloseTo(1.2,6)
  })
  it('bad scale, unsupported mesh and invalid joint tree return a concrete issue, no partial aabb and no Scene write',async()=>{
    await writeFile(join(workspace,'part.stl'),triangleSTL());await writeFile(join(workspace,'part.msh'),'unsupported mesh bytes')
    const cases=[robot('<mesh filename="part.stl" scale="1 NaN 1"/>'),robot('<mesh filename="part.msh"/>'),robot('<mesh filename="part.stl"/>','<joint name="cycle" type="fixed"><parent link="tip"/><child link="base"/></joint>')]
    for(const [i,source] of cases.entries()){
      const path=join(workspace,`bad-${i}.urdf`);await writeFile(path,source)
      const parsed=await parseAsset(path);expect(parsed.metadata.aabb).toBeUndefined();expect((parsed.metadata.boundsFacts as any).issue).toMatch(/^URDF_BOUNDS_/)
      const operations=new SceneOperations(join(workspace,`bad-data-${i}`)),scene=await operations.create({})
      await expect(operations.import({path,sceneId:scene.sceneId,physicalize:false,transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]}})).rejects.toThrow('PROTOTYPE_BOUNDS_UNAVAILABLE')
      expect((await operations.inspect(scene.sceneId)).revision).toBe(0);expect((await operations.inspect(scene.sceneId)).entities).toHaveLength(0)
    }
  })
  it('a missing registered mesh remains a dependency failure instead of an invented bound',async()=>{
    const path=join(workspace,'missing.urdf');await writeFile(path,robot('<mesh filename="missing.stl"/>'))
    await expect(parseAsset(path)).rejects.toThrow()
    const operations=new SceneOperations(join(workspace,'missing-data')),scene=await operations.create({})
    await expect(operations.import({path,sceneId:scene.sceneId,physicalize:false,transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]}})).rejects.toThrow()
    expect((await operations.inspect(scene.sceneId)).entities).toHaveLength(0)
  })
  it('mixed URDF fixed-axis roll/yaw follows the document convention without calling a physics engine',async()=>{
    const path=join(workspace,'mixed-rpy.urdf')
    await writeFile(path,'<robot name="mixed-rpy"><link name="root"><visual><origin rpy="1.5707963267948966 0 1.5707963267948966"/><geometry><box size="2 4 6"/></geometry></visual></link></robot>')
    const parsed=await parseAsset(path),bounds=parsed.metadata.aabb as {min:number[];max:number[]}
    for(const [i,n] of [3,1,2].entries()){expect(bounds.max[i]).toBeCloseTo(n,6);expect(bounds.min[i]).toBeCloseTo(-n,6)}
    expect((parsed.metadata.boundsFacts as any).dynamicPoseEvaluated).toBe(false)
  })
  it('mount can read missing legacy metadata without rewriting its resource identity or source bytes',async()=>{
    const path=join(workspace,'legacy.urdf');await writeFile(path,'<robot name="legacy"><link name="root"><visual><origin xyz="0 0 1"/><geometry><box size=".2 .3 .4"/></geometry></visual></link></robot>')
    const operations=new SceneOperations(join(workspace,'legacy-data')),scene=await operations.create({})
    const imported=await operations.import({path,physicalize:false}),legacy=structuredClone(imported.resource)
    delete legacy.parsed.metadata.aabb;delete legacy.parsed.metadata.boundsFacts
    const before=await readFile(path)
    const mounted=await operations.mount({sceneId:scene.sceneId,resourceId:legacy.ref.resourceId,version:legacy.ref.version,transform:{position:[0,0,2],quaternion:[0,0,0,1],scale:[1,1,1]}},legacy)
    expect(mounted.snapshot.entities.find(e=>e.entityId===mounted.entityId)!.transform.position[2]).toBeCloseTo(1.2,6)
    expect(legacy.parsed.metadata.aabb).toBeUndefined()
    expect(mounted.snapshot.entities.find(e=>e.entityId===mounted.entityId)!.resources[0]?.resourceId).toBe(legacy.ref.resourceId)
    expect(mounted.snapshot.entities.find(e=>e.entityId===mounted.entityId)!.resources[0]?.version).toBe(legacy.ref.version)
    expect(await readFile(path)).toEqual(before)
  })
})

describe('ENV-49 依赖缺件不留半成品（原型检查不影响这一条）', () => {
  it('缺外部依赖：逐项点名报错、目录清单不变', async () => {
    const gltf = join(workspace, 'broken.gltf')
    await writeFile(gltf, JSON.stringify({
      asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
      buffers: [{ uri: 'broken.bin', byteLength: 42 }],
    }), 'utf8')
    const operations = new SceneOperations(join(workspace, 'data'))
    const scene = await operations.create({ name: 'broken' })
    const before = await readFile(join(workspace, 'data', 'scenes', `${scene.sceneId}.json`), 'utf8')
    await expect(acquireAsset(operations, { path: gltf, sceneId: scene.sceneId, physicalize: false })).rejects.toThrow(/ASSET_ACQUISITION_DEPENDENCY_UNAVAILABLE: 以下外部依赖没有取到：broken\.bin/)
    expect(await readFile(join(workspace, 'data', 'scenes', `${scene.sceneId}.json`), 'utf8')).toBe(before)
    expect((await operations.inspect(scene.sceneId)).entities).toEqual([])
  })
})
