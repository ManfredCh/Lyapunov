/**
 * 原生 MJCF「只有 worldbody 级 geom/相机」的装配验收（122 现场 sim_open IndexError 的真实修复）。
 *
 * 运行：
 *   node --experimental-transform-types --test packages/sim-mujoco/test/native-worldbody-only.test.ts
 *   （必须开 transform-types：sim-contract/src/python-transport.ts 用了 TypeScript 参数属性。）
 *   解释器：LYAPUNOV_MUJOCO_PYTHON（未设时用仓库内 .runtime/sim-python/bin/python）；没有解释器时
 *   整份测试显式 skip 并说明原因，不假装通过。
 *
 * 现场（122/NEEDS_ROOT.md §1，79 树 worker.py 的原生分支）：实体用 `components.mujoco.xml` 给原生 MJCF，
 * 片段里**没有 body**（geom/相机直接挂 `<worldbody>`，合法的静态台面/墙/地面标记写法）时，登记实体根时
 * `bids[0]` 下标越界，`sim_open` 直接失败（工具只回一句 `list index out of range`，没有 traceback）。
 * 根的要求（ROOT_DIRECTIVE 第 7 条）：不修改原始 MJCF；worldbody 直属 geom/相机必须经**现有装配框架**
 * 得到正确的 Scene 实体位姿/碰撞/观察；不能只避开越界把这些 geom 丢掉，也不把合法 MuJoCo 模型标成不支持；
 * 没有显式 rootBody 且没有子 body 时，沿同一套 MjSpec frame/body 装配**形成**安装根。
 *
 * 本文件量的三个事实（全部在真实 MuJoCo 上，走产品 MuJoCoProvider：
 * open → observe → listCameras → close，不直接调 python）：
 *  1. 原生 worldbody-only geom + 相机：喂进去的 XML 一字不改、里面没有 `<body>`（断言就在文件里，
 *     不存在"手工包一层 body"的绕过）；片段自带的相机以 `实体id/相机名` 进引擎，世界位姿 = 实体位姿 ∘
 *     片段局部位姿（真值由本文件独立算出，不用被核对代码的任何函数）。
 *  2. 该 Scene 实体有非零位姿：`[2.5, -1.5, 0.9]` + 绕 z 30°；observe 必须报出这一位姿与朝向
 *     （越界只避开后实体只剩 world，这里会读成原点、相机也没有父体）。
 *  3. 另一个动态球落到它的台面上：静止球心高度 = 台面顶 1.2 + 球半径 0.06，接触对里出现 `bench/slab`
 *     ——geom 真的作为带实体前缀的碰撞 geom 进了世界（被丢掉的话球会一路穿到地面 0.06）。
 *  再加一颗球落在第二块 worldbody geom（立柱，实体局部 x=+0.8）上：它的静止位置只可能在世界
 *  R(30°)·(0.8,0,0) 上——钉住"偏心的世界系 geom 也跟着实体朝向一起转"，而不是都堆在原点。
 *
 * 诚实边界：
 *  - 片段是本文件自带的合成合法原生 MJCF（尺寸已知、便于独立算真值），**不是**用户真实资产；
 *    122 现场的 coacd part 网格片段（`<asset><mesh/></asset>` + worldbody geom）由任务目录的
 *    tools/native-worldbody-only-run.ts 用同一 provider 另跑一次（含 113 修前的 worker 对照）。
 *  - 不覆盖 Isaac 侧同类装配，也不覆盖 URDF 路径。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync,mkdtempSync,writeFileSync,rmSync } from 'node:fs'
import {tmpdir} from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
import { MuJoCoProvider } from '../src/provider.ts'
import {standardGroundEntity,physicsWorkspaceSettings} from '../../scene-kit/src/scene-template.ts'
import {identityTransform,type Entity,type SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const python = process.env.LYAPUNOV_MUJOCO_PYTHON ?? resolve(root, '.runtime/sim-python/bin/python')
const available = existsSync(python)

test('A08 明确原三角面：非凸/采样拒；凸体与旧default保留，失败sync不污染旧world',{skip:available?false:'缺少Mu解释器',timeout:30_000},async()=>{
 const directory=mkdtempSync(resolve(tmpdir(),'a08-mu-exact-')),provider=new MuJoCoProvider({pythonPath:python})
 const tetra=resolve(directory,'convex.obj'),ring=resolve(directory,'ring.obj')
 writeFileSync(tetra,'v 0 0 0\nv .2 0 0\nv 0 .2 0\nv 0 0 .2\nf 1 3 2\nf 1 2 4\nf 1 4 3\nf 2 3 4\n')
 const outer=[[-1,-1],[1,-1],[1,1],[-1,1]],inner=[[-.4,-.4],[.4,-.4],[.4,.4],[-.4,.4]],points=[0,.6].flatMap(z=>[...outer,...inner].map(([x,y])=>[x,y,z])),faces:number[][]=[]
 for(let i=0;i<4;i++){const j=(i+1)%4;for(const q of [[i,j,j+8,i+8],[i+4,i+12,j+12,j+4],[i+8,j+8,j+12,i+12],[i,i+4,j+4,j]])faces.push([q[0]!,q[1]!,q[2]!],[q[0]!,q[2]!,q[3]!])}
 writeFileSync(ring,[...points.map(v=>'v '+v.join(' ')),...faces.map(f=>'f '+f.map(v=>v+1).join(' '))].join('\n')+'\n')
 const make=(id:string,path:string,explicit:boolean,sampled=false):SceneSnapshot=>({sceneId:id,revision:0,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[{entityId:'surface',name:'surface',resources:[],transform:identityTransform(),components:{collision:{shape:'mesh',parts:[pathToFileURL(path).href]},rigidBody:{type:'static'},...explicit?{physicsBinding:{status:'BOUND',strategy:'triangle_mesh',usage:'environment',...sampled?{pointCloud:[{sourceKind:'point_cloud',processing:'full-spatial-voxel-surface',coverage:'full-measured-sample-voxel-boundary',coverageComplete:true,occupiedUnionVerified:true}]}:{}}}:{}}}]})
 try{
  await assert.rejects(provider.open(make('nonconvex',ring,true),{clock:'manual',ground:false}),(error:any)=>error.code==='MUJOCO_TRIANGLE_SURFACE_UNSUPPORTED');assert.equal((await provider.listWorlds()).length,0)
  await assert.rejects(provider.open(make('sampled',tetra,true,true),{clock:'manual',ground:false}),(error:any)=>error.code==='MUJOCO_SAMPLED_SURFACE_UNSUPPORTED');assert.equal((await provider.listWorlds()).length,0)
  const legacy=await provider.open(make('default',ring,false),{clock:'manual',ground:false});assert.equal(legacy.status,'ready')
  const valid=await provider.open(make('convex',tetra,true),{clock:'manual',ground:false});assert.equal(valid.status,'ready')
  const before=await provider.observe(valid.worldId),bad={...make('convex',ring,true),revision:1}
  await assert.rejects(provider.sync(valid.worldId,bad),(error:any)=>error.code==='MUJOCO_TRIANGLE_SURFACE_UNSUPPORTED')
  const after=await provider.observe(valid.worldId);assert.equal(after.generation,before.generation);assert.equal(after.sceneRevision,before.sceneRevision);assert.equal((await provider.listWorlds()).find(w=>w.worldId===valid.worldId)?.status,'ready')
 }finally{await provider.dispose();rmSync(directory,{recursive:true,force:true})}
})

test('A08 默认地面仅让位同位置真实原生静态plane；model片段、竖直plane、名字和编辑不作资格', {skip:available?false:'缺少真实MuJoCo解释器',timeout:30_000},async()=>{
 const provider=new MuJoCoProvider({pythonPath:python})
 const ground=standardGroundEntity({resourceId:'ground-fixture',version:1,source:{units:'m',upAxis:'Z',handedness:'right'},original:{uri:'/fixture/ground.glb',mimeType:'model/gltf-binary'},representations:[]})
 const scenarios=[
  {name:'scene.xml含静态水平plane',xml:'<geom name="support" type="plane" size="5 5 .1"/>',replace:true},
  {name:'model.xml无floor',xml:'<body name="arm"><geom type="box" size=".1 .1 .1"/></body>',replace:false},
  {name:'叫floor的普通collision盒',xml:'<geom name="floor" type="box" size="5 5 .1"/>',replace:false},
  {name:'竖直plane不能顶替水平支持面',xml:'<geom name="floor" type="plane" quat=".7071067811865476 .7071067811865476 0 0" size="5 5 .1"/>',replace:false},
  {name:'抬高的原生plane不能顶替z0地面',xml:'<geom name="floor" type="plane" pos="0 0 .5" size="5 5 .1"/>',replace:false},
  {name:'已编辑默认地面保留',xml:'<geom name="support" type="plane" size="5 5 .1"/>',replace:false,edited:true},
 ]
 try{
  for(const [index,item]of scenarios.entries()){
   const owned=structuredClone(ground);if(item.edited)owned.transform.position=[1,0,-.05]
   const robot:Entity={entityId:'robot',name:'robot',resources:[],transform:identityTransform(),components:{mujoco:{xml:`<mujoco><worldbody>${item.xml}</worldbody></mujoco>`}}}
   const scene:SceneSnapshot={sceneId:'floor-'+index,revision:0,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},physics:physicsWorkspaceSettings(),entities:[owned,robot]}
   const w=await provider.open(scene,{clock:'manual',ground:false})
   try{
    const f=await provider.observe(w.worldId);assert.equal(f.worldStatus,'ready');assert.equal(f.stepIndex,0)
    assert.equal(f.worldPhysics?.groundSources.some(s=>s.source==='scene'),!item.replace,item.name)
    assert.equal(f.worldPhysics?.collisionCoverage.physicalEntityIds.includes(ground.entityId),!item.replace,item.name)
    assert.deepEqual(f.entities.find(e=>e.entityId===ground.entityId)?.transform.position,owned.transform.position,item.name)
    if(item.replace){assert.deepEqual(w.groundGeomNames,['robot/support']);assert.equal(f.worldPhysics?.collisionCoverage.status,'COMPLETE')}
   }finally{await provider.close(w.worldId)}
  }
 }finally{await provider.dispose()}
})

test('A08 纯视觉环境显式添加测试地面仍PARTIAL；两个隔离世界重力和暂停互不串', {skip:available?false:'缺少真实MuJoCo解释器',timeout:30_000},async()=>{
 const provider=new MuJoCoProvider({pythonPath:python})
 const make=(id:string,g:[number,number,number]):SceneSnapshot=>({sceneId:id,revision:0,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},physics:{gravityWorldMps2:g,template:'blank'},entities:[{entityId:'test-ground',name:'explicit',resources:[],transform:identityTransform(),components:{collision:{shape:'box',halfExtents:[2,2,.05]},rigidBody:{type:'static'},supportSurface:{kind:'ground',source:'user'}}},{entityId:'environment',name:'visual',resources:[],transform:identityTransform(),components:{visual:{kind:'mesh'}}}]})
 try{
  const a=await provider.open(make('isolated-a',[0,0,-2]),{clock:'realtime',ground:false}),b=await provider.open(make('isolated-b',[0,0,-7]),{clock:'realtime',ground:false})
  await provider.setPaused(a.worldId,true,a.worldGeneration)
  const first=await provider.observe(a.worldId);await sleep(80)
  const second=await provider.observe(a.worldId),other=await provider.observe(b.worldId)
  assert.deepEqual(second.worldPhysics?.gravityWorldMps2,[0,0,-2]);assert.deepEqual(other.worldPhysics?.gravityWorldMps2,[0,0,-7])
  assert.equal(second.stepIndex,first.stepIndex);assert.equal(second.worldStatus,'paused');assert.equal(other.worldStatus,'running');assert.ok(other.stepIndex>0)
  assert.equal(second.worldPhysics?.collisionCoverage.status,'PARTIAL');assert.deepEqual(second.worldPhysics?.collisionCoverage.visualOnlyEntityIds,['environment'])
 }finally{await provider.dispose()}
})

/**
 * 原始片段（一字不改）：台面 + 立柱两块 geom 与一台相机都直接挂 `<worldbody>`，**没有 `<body>`**。
 * 相机 quat 是 MJCF 口径 [w,x,y,z]，绕 x 转 +90° 后本地 -z（相机光轴）指向实体系的 +y。
 */
const BENCH_XML = `<mujoco model="bench-fragment"><worldbody>`
  + `<geom name="slab" type="box" size="0.6 0.4 0.05" pos="0 0 0.25"/>`
  + `<geom name="post" type="cylinder" size="0.05 0.45" pos="0.8 0 -0.15"/>`
  + `<camera name="side" pos="0 -1.2 0.5" quat="0.70710678 0.70710678 0 0" fovy="45"/>`
  + `</worldbody></mujoco>`
const BENCH_POSITION: [number, number, number] = [2.5, -1.5, 0.9]
const BENCH_YAW_DEG = 30
const BENCH_QUATERNION: [number, number, number, number] = [0, 0, Math.sin((BENCH_YAW_DEG * Math.PI) / 360), Math.cos((BENCH_YAW_DEG * Math.PI) / 360)]
const SLAB_TOP_LOCAL_Z = 0.3            // 台面中心 z=0.25 + 半厚 0.05
const POST_TOP_LOCAL_Z = 0.3            // 立柱中心 z=-0.15 + 半高 0.45（与台面同高）
const BALL_RADIUS = 0.06

/** 独立真值：xyzw 四元数 → 3x3 旋转矩阵（本文件自己的，不用被核对模块的换算）。 */
const rotationOf = (quaternion: readonly number[]): number[][] => {
  const [x, y, z, w] = quaternion as [number, number, number, number]
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ]
}
const applyRotation = (rotation: number[][], local: readonly number[]): [number, number, number] =>
  [0, 1, 2].map(i => rotation[i]![0]! * local[0]! + rotation[i]![1]! * local[1]! + rotation[i]![2]! * local[2]!) as [number, number, number]
/** 实体局部位姿 → 世界（M·local，精确仿射像；父体是 None，只有实体自身的位姿）。 */
const worldPoint = (local: readonly number[]): [number, number, number] => {
  const offset = applyRotation(rotationOf(BENCH_QUATERNION), local)
  return [BENCH_POSITION[0] + offset[0], BENCH_POSITION[1] + offset[1], BENCH_POSITION[2] + offset[2]]
}

const scene = () => ({
  sceneId: 'w123-native-worldbody-only', revision: 1,
  coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' } as const,
  entities: [
    {
      entityId: 'bench', name: '台面片段',
      transform: { position: [...BENCH_POSITION], quaternion: [...BENCH_QUATERNION], scale: [1, 1, 1] },
      resources: [],
      icons: [],
      components: { mujoco: { xml: BENCH_XML } },
    },
    {
      entityId: 'ballA', name: '球A',
      transform: { position: [...worldPoint([0, 0, SLAB_TOP_LOCAL_Z + 0.4])], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      resources: [],
      components: { collision: { shape: 'sphere', halfExtents: [BALL_RADIUS, 0, 0], source: 'native-worldbody-only-test' }, rigidBody: { type: 'dynamic', massKg: 0.5 } },
    },
    {
      entityId: 'ballB', name: '球B',
      transform: { position: [...worldPoint([0.8, 0, POST_TOP_LOCAL_Z + 0.35])], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      resources: [],
      components: { collision: { shape: 'sphere', halfExtents: [BALL_RADIUS, 0, 0], source: 'native-worldbody-only-test' }, rigidBody: { type: 'dynamic', massKg: 0.5 } },
    },
  ],
}) as any

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('原生 worldbody-only', () => {
test('原生 MJCF 只有 worldbody 级 geom/相机：实体有位姿、geom 不丢、球落在台面上', { skip: available ? false : `MuJoCo 解释器不存在: ${python}（设 LYAPUNOV_MUJOCO_PYTHON）`, timeout: 30_000 }, async () => {
  // 事实 1 的前半：喂进去的片段一字不改、确实没有 body（不靠"手工给输入 XML 包一层 body"绕过）。
  assert.ok(!/<body/.test(BENCH_XML), '本用例的输入片段必须是 worldbody 直属 geom/相机（不含 <body>），否则就不是这条路径的验收')
  const provider = new MuJoCoProvider({ pythonPath: python })
  const input = scene()
  const handle = await provider.open(input, { ground: true, worldId: 'w123-native-worldbody-only', timestepS: 0.002, clock: 'realtime' })
  try {
    assert.equal(handle.status, 'ready')
    // 片段被原样消费：调用方手里的字符串没有被改写（worker 也没有回写）。
    assert.equal(input.entities[0]!.components!.mujoco.xml, BENCH_XML, '原始 MJCF 必须一字不动')

    // 事实 3：两颗球落到两块 worldbody geom 的台面上。边落边等速度收敛，不靠固定等待。
    const deadline = Date.now() + 10_000
    let frame: any = await provider.observe(handle.worldId, { contacts: true, entityIds: ['ballA', 'ballB'] })
    let stable = 0
    while (Date.now() < deadline) {
      await sleep(50)
      frame = await provider.observe(handle.worldId, { contacts: true, entityIds: ['ballA', 'ballB'] })
      stable = frame.entities.every((item: any) => Math.hypot(...(item.sensors?.bodyLinearVelocityMps ?? [0, 0, 0])) < 5e-3) ? stable + 1 : 0
      if (stable >= 3 && frame.simTime > 0.2) break
    }
    const rest = (id: string) => frame.entities.find((item: any) => item.entityId === id).transform.position as number[]
    const onSlab = worldPoint([0, 0, SLAB_TOP_LOCAL_Z])[2] + BALL_RADIUS
    const onPost = worldPoint([0.8, 0, POST_TOP_LOCAL_Z])[2] + BALL_RADIUS
    const slab = rest('ballA'), post = rest('ballB')
    assert.ok(Math.abs(slab[2]! - onSlab) < 0.01,
      `球A 静止在 z=${slab[2]!.toFixed(4)}，真值台面顶 ${worldPoint([0, 0, SLAB_TOP_LOCAL_Z])[2].toFixed(4)} + 球半径 ${BALL_RADIUS} = ${onSlab.toFixed(4)}（geom 被丢掉时球会落到地面 0.06）`)
    assert.ok(Math.abs(post[2]! - onPost) < 0.01,
      `球B 静止在 z=${post[2]!.toFixed(4)}，真值立柱顶 ${worldPoint([0.8, 0, POST_TOP_LOCAL_Z])[2].toFixed(4)} + 球半径 ${BALL_RADIUS} = ${onPost.toFixed(4)}`)
    // 第二块 geom 在实体系里偏心 x=0.8：世界位置必须随实体朝向转（30°），不是 (0.8,0,0) 直接加。
    const postTruth = worldPoint([0.8, 0, 0])
    assert.ok(Math.abs(post[0]! - postTruth[0]) < 0.02 && Math.abs(post[1]! - postTruth[1]) < 0.02,
      `球B 落在 (${post[0]!.toFixed(4)}, ${post[1]!.toFixed(4)})，真值偏心柱位置 = 实体位姿 ∘ (0.8,0,0) = (${postTruth[0].toFixed(4)}, ${postTruth[1].toFixed(4)})（不转的话是 (3.3, -1.5)）`)
    const pairs = (frame.contacts ?? []).map((c: any) => `${c.geom1}|${c.geom2}`)
    assert.ok(pairs.some((pair: string) => pair.includes('bench/slab')), `球A 必须接触带实体前缀的台面 geom bench/slab（实测接触对 ${JSON.stringify(pairs)}）`)
    assert.ok(pairs.some((pair: string) => pair.includes('bench/post')), `球B 必须接触立柱 geom bench/post（实测接触对 ${JSON.stringify(pairs)}）`)
    // 纯视觉跳过告警不能出现在这个实体上：它有真实物理体。
    assert.ok(!(handle.warnings ?? []).some((w: any) => w.entityId === 'bench'),
      `带原生 MJCF 的实体不该被登记为跳过（${JSON.stringify(handle.warnings)}）`)

    // 事实 2：实体非零位姿 + 朝向（安装根承载 Scene 声明位姿，observe 如实报告）。
    const observed = (await provider.observe(handle.worldId, { entityIds: ['bench'] })).entities[0].transform
    assert.ok(observed.position.every((v: number, i: number) => Math.abs(v - BENCH_POSITION[i]!) < 1e-6),
      `实体位姿应为声明的 ${JSON.stringify(BENCH_POSITION)}，实测 ${JSON.stringify(observed.position)}`)
    assert.ok(observed.quaternion.every((v: number, i: number) => Math.abs(v - BENCH_QUATERNION[i]!) < 1e-6),
      `实体朝向应为声明的 ${JSON.stringify(BENCH_QUATERNION)}，实测 ${JSON.stringify(observed.quaternion)}`)

    // 事实 1 的后半：片段自带的相机进了引擎，世界位姿 = 实体位姿 ∘ 片段局部位姿。
    const list = await provider.listCameras(handle.worldId) as any
    const camera = list.cameras.find((c: any) => c.cameraName === 'bench/side')
    assert.ok(camera, `原生片段相机必须以 bench/side 进引擎（实测 ${JSON.stringify(list.cameras.map((c: any) => c.cameraName))}）`)
    assert.equal(camera.cameraSource, 'mjcf')
    assert.equal(camera.parentBodyName, 'bench/root', '原生相机必须挂在承载实体位姿的安装根上（world 系意味着实体没有可依附的物理体）')
    const cameraTruth = worldPoint([0, -1.2, 0.5])
    const cameraPosition = camera.worldFromCamera.positionM as number[]
    assert.ok(cameraPosition.every((v: number, i: number) => Math.abs(v - cameraTruth[i]!) < 1e-5),
      `相机世界位置应为 实体位姿 ∘ (0,-1.2,0.5) = ${JSON.stringify(cameraTruth.map(v => Number(v.toFixed(6))))}，实测 ${JSON.stringify(cameraPosition)}`)
    // 光轴：相机本地 -z 经片段 quat（绕 x +90°）指向实体系 +y，再被实体 30° 偏航带走。
    const look = [-camera.worldFromCamera.rotationMatrix[0][2], -camera.worldFromCamera.rotationMatrix[1][2], -camera.worldFromCamera.rotationMatrix[2][2]]
    const lookTruth = applyRotation(rotationOf(BENCH_QUATERNION), [0, 1, 0])
    assert.ok(look.every((v: number, i: number) => Math.abs(v - lookTruth[i]!) < 1e-5),
      `相机光轴应为 实体偏航 ∘ (0,1,0) = ${JSON.stringify(lookTruth.map(v => Number(v.toFixed(6))))}，实测 ${JSON.stringify(look.map(v => Number(v.toFixed(6))))}`)
  } finally {
    await provider.close(handle.worldId).catch(() => {})
    await provider.dispose()
  }
})
})
