/**
 * 媒体路由的「基址 + 相对引用」解析（2026-09-26，RESOURCE-ROUTE-BASE-TOKEN）。
 *
 * 要证明的一件事：**用户导入的机器人（文档里写的是相对引用）拿到的是它自己的网格字节**——
 * 走的是真 `resource` 路由：真 `SceneOperations` + 真场景文档 + 真磁盘资产 + 真依赖闭包，
 * 不是形状等价夹具（夹具与真宿主的差别见 `resource-route-harness.ts` 的文件头）。
 *
 * 事实链（每一环在下面都有一条用例）：
 *   ① 出站投影把 `visual.robot.baseUri` 换成不可逆标记（`res:<指纹>`），文档引用仍是相对串；
 *   ② 消费侧（上一个工作面已修好的那一半）把相对引用**原样**交出，`new URL(相对, 标记)` 抛错；
 *   ③ 媒体路由按"该 Scene 自己的机器人文档目录 + 相对引用"解析，落进**既有**已授权候选集后回真字节；
 *   ④ 判据不足（`..` 越界 / 域外 / 多份文档给出不同件 / 没有文档基准）一律不放行。
 *
 * 隐私口径：路由新增的只有**解析**这一步。授权判据仍是 `listed` / `native.sourcePath` /
 * `parseAsset` 依赖闭包这三条（与改动前逐字同一份），一个字面都没放宽；歧义时明确失败而不是猜。
 *
 * 用法：`bun test packages/lyapunov-shell/test/resource-route-base-token.test.ts`
 */
import { describe, expect, test, spyOn } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { boot, writeScene, fetchResource, viewerSubmissions, viewerResourceURI, SESSION } from "./resource-route-harness.ts"
import { resourceToken, RESOURCE_TOKEN_PREFIX } from "../../lyapunov-contracts/src/product-paths.ts"
import type { Entity, SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"

const SCENE = "scene-route-base"
const COORDINATES = { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" } as const

function syntheticStl(name: string): string {
  return `solid ${name}\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid ${name}\n`
}

/** 合成机器人元件（真 MJCF 形状：`compiler.meshdir` + 相对 `file`），与真实用户导入的机器人同形。 */
async function layRobot(root: string, id: string, meshNames: string[]): Promise<{ document: string; directory: string }> {
  const source = join(root, "robots", id, "source")
  await mkdir(join(source, "meshes"), { recursive: true })
  const asset = meshNames.map(name => `    <mesh name="${name.replace(/\.STL$/i, "")}" file="${name}"/>`).join("\n")
  await writeFile(join(source, "arm.xml"), `<mujoco model="arm">\n  <compiler angle="radian" meshdir="meshes"/>\n\n  <asset>\n${asset}\n  </asset>\n\n  <worldbody>\n    <body name="base">\n${meshNames.map((name, index) => `      <geom name="g${String(index)}" type="mesh" mesh="${name.replace(/\.STL$/i, "")}"/>`).join("\n")}\n    </body>\n  </worldbody>\n</mujoco>\n`)
  for (const name of meshNames) await writeFile(join(source, "meshes", name), syntheticStl(name))
  return { document: join(source, "arm.xml"), directory: source }
}

function robotEntity(sourcePath: string, meshFiles: string[], entityId = "robot-1", resourceId = "res_robot_1"): Entity {
  const uri = pathToFileURL(sourcePath).href
  return {
    entityId, name: entityId, transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    resources: [{ resourceId, version: 1, original: { uri, mimeType: "application/x-mjcf+xml" }, representations: [{ uri, mimeType: "application/x-mjcf+xml", role: "simulation" }], source: { units: "m", upAxis: "Z", handedness: "right", metersPerUnit: 1 } }],
    components: {
      mujoco: { sourcePath, source: "user-import", meshdir: "meshes" },
      visual: { kind: "robot", robot: { format: "mjcf", baseUri: pathToFileURL(dirname(sourcePath) + "/").href, document: { compiler: { angle: "radian", meshdir: "meshes" }, asset: { mesh: meshFiles.map(name => ({ name: name.replace(/\.STL$/i, ""), file: name })) } } } },
    },
  } as unknown as Entity
}

const sceneOf = (entities: Entity[]): SceneSnapshot => ({ sceneId: SCENE, revision: 1, coordinates: { ...COORDINATES }, entities })

describe("resource 路由：用户导入的机器人（相对引用 + meshdir）", () => {
  test("① 出站投影把基址换成不可逆标记，文档引用仍是相对串：消费侧只能原样交出", async () => {
    const harness = await boot()
    try {
      const { document } = await layRobot(harness.root, "arm", ["pelvis.STL"])
      const raw = sceneOf([robotEntity(document, ["pelvis.STL"])])
      const [submission] = viewerSubmissions(raw)
      const mesh = submission!.meshes[0]!
      expect(mesh.base.startsWith(RESOURCE_TOKEN_PREFIX)).toBe(true)                       // 基址是标记
      expect(mesh.base).toBe(resourceToken(pathToFileURL(dirname(document) + "/").href))   // 正是那份目录的指纹
      expect(mesh.locator).toBe("meshes/pelvis.STL")                                       // 相对引用**原样**交出
      expect(() => new URL(mesh.locator, mesh.base)).toThrow()                             // 标记当不了相对基准
    } finally { await harness.dispose() }
  })

  test("②③ 媒体路由按机器人文档目录解析该引用，回的是**磁盘上同一份字节**", async () => {
    const harness = await boot()
    try {
      const { document, directory } = await layRobot(harness.root, "arm", ["pelvis.STL", "torso_link.STL"])
      await writeScene(harness, sceneOf([robotEntity(document, ["pelvis.STL", "torso_link.STL"])]))
      const [submission] = viewerSubmissions(sceneOf([robotEntity(document, ["pelvis.STL", "torso_link.STL"])]))
      expect(submission!.meshes.map(row => row.locator)).toEqual(["meshes/pelvis.STL", "meshes/torso_link.STL"])
      for (const mesh of submission!.meshes) {
        const read = await fetchResource(harness, SCENE, mesh.locator)
        expect(read.error).toBeUndefined()
        expect(read.status).toBe(200)
        const onDisk = await readFile(join(directory, "meshes", mesh.file))
        expect(createHash("sha256").update(read.bytes).digest("hex")).toBe(createHash("sha256").update(onDisk).digest("hex"))
      }
    } finally { await harness.dispose() }
  })

  test("④ 生产侧（`robot-visual-assets` 的标记化）**够不着**的那一类：URDF 的相对 `<mesh filename>` 仍由本路由解析", async () => {
    const harness = await boot()
    try {
      const { document, directory } = await layRobot(harness.root, "arm", ["pelvis.STL"])
      // 生产侧那一层只认 MJCF 的 `document.asset` 段（URDF 的 `<mesh filename>` 没有 asset 段可读，
      // 也没有 `name` 键可保），所以这条引用到浏览器手里仍然是相对串 —— 只有路由能解析。
      const uri = pathToFileURL(document).href
      const urdf = {
        ...robotEntity(document, ["pelvis.STL"]),
        components: {
          mujoco: { sourcePath: document, source: "user-import" },
          visual: { kind: "robot", robot: { format: "urdf", baseUri: pathToFileURL(dirname(document) + "/").href, document: { link: { name: "base", visual: { geometry: { mesh: { filename: "meshes/pelvis.STL" } } } } } } },
        },
      } as unknown as Entity
      await writeScene(harness, sceneOf([urdf]))
      const read = await fetchResource(harness, SCENE, "meshes/pelvis.STL")
      expect(read.error).toBeUndefined()
      expect(read.status).toBe(200)
      const onDisk = await readFile(join(directory, "meshes", "pelvis.STL"))
      expect(createHash("sha256").update(read.bytes).digest("hex")).toBe(createHash("sha256").update(onDisk).digest("hex"))
      expect(resourceToken(uri)).not.toBe("")   // 文档本身仍是已授权件（依赖闭包就是从这里算出来的）
    } finally { await harness.dispose() }
  })

  test("④ 未授权件照样进不来：`..` 越界、域外绝对路径、域外 file: URI 都不放行", async () => {
    const harness = await boot()
    try {
      const { document } = await layRobot(harness.root, "arm", ["pelvis.STL"])
      await writeFile(join(harness.root, "outside.STL"), syntheticStl("outside"))
      await writeScene(harness, sceneOf([robotEntity(document, ["pelvis.STL"])]))
      expect((await fetchResource(harness, SCENE, "meshes/../../outside.STL")).error).toBe("RESOURCE_NOT_REFERENCED_BY_SCENE")
      expect((await fetchResource(harness, SCENE, join(harness.root, "outside.STL"))).error).toBe("RESOURCE_NOT_REFERENCED_BY_SCENE")
      expect((await fetchResource(harness, SCENE, pathToFileURL(join(harness.root, "outside.STL")).href)).error).toBe("RESOURCE_NOT_REFERENCED_BY_SCENE")
    } finally { await harness.dispose() }
  })

  test("④ 解析得出来、但**没有**被任何已授权表示引用的同目录网格：仍然不放行", async () => {
    const harness = await boot()
    try {
      const { document, directory } = await layRobot(harness.root, "arm", ["pelvis.STL"])
      await writeFile(join(directory, "meshes", "not-referenced.STL"), syntheticStl("not-referenced"))
      await writeScene(harness, sceneOf([robotEntity(document, ["pelvis.STL"])]))
      expect((await fetchResource(harness, SCENE, "meshes/not-referenced.STL")).error).toBe("RESOURCE_NOT_REFERENCED_BY_SCENE")
      expect((await fetchResource(harness, SCENE, "meshes/pelvis.STL")).status).toBe(200)
    } finally { await harness.dispose() }
  })

  test("④ 判据不足就失败：同一相对引用在两份机器人文档下解析出两份不同的已授权件 ⇒ 拒绝猜", async () => {
    const harness = await boot()
    try {
      const first = await layRobot(harness.root, "arm-a", ["pelvis.STL"])
      const second = await layRobot(harness.root, "arm-b", ["pelvis.STL"])
      await writeScene(harness, sceneOf([robotEntity(first.document, ["pelvis.STL"]), robotEntity(second.document, ["pelvis.STL"], "robot-2", "res_robot_2")]))
      expect(String((await fetchResource(harness, SCENE, "meshes/pelvis.STL")).error)).toContain("RESOURCE_REFERENCE_AMBIGUOUS")
    } finally { await harness.dispose() }
  })

  test("④ 没有可用的机器人文档基准 ⇒ 精确回到 RESOURCE_NOT_REFERENCED_BY_SCENE（不猜基址）", async () => {
    const harness = await boot()
    try {
      const { document } = await layRobot(harness.root, "arm", ["pelvis.STL"])
      const entity = robotEntity(document, ["pelvis.STL"])
      // 抹掉两条基址线索（`mujoco.sourcePath` 与带 MJCF mimeType 的表示），模拟"判据缺失"。
      const blind = { ...entity, resources: [], components: { ...entity.components, mujoco: {} } } as unknown as Entity
      await writeScene(harness, sceneOf([blind]))
      expect((await fetchResource(harness, SCENE, "meshes/pelvis.STL")).error).toBe("RESOURCE_NOT_REFERENCED_BY_SCENE")
    } finally { await harness.dispose() }
  })
})

describe("静态对齐：宿主侧夹具里复刻的那一句必须与产品源码同形（行为面由 `workbench-import-surface.test.tsx` 真 import 覆盖）", () => {
  test("`workbench.tsx` 里 `viewerResourceURI` 的正则与夹具里那一份逐字相同", async () => {
    const source = await readFile(new URL("../src/workbench.tsx", import.meta.url), "utf8")
    const product = source.match(/export function viewerResourceURI\(uri:string\):string\{return (.*?)\}\n/)![1]!
    expect(product).toBe(String.raw`/^(res:[^?#]+)\?ext=\.[A-Za-z0-9]+$/.exec(uri)?.[1]??uri`)
    expect(viewerResourceURI("/x")).toBe("/x")
    expect(viewerResourceURI("res:abc?ext=.STL")).toBe("res:abc")
  })
})

describe('state 同版本条件投影：真SceneStore、真HTTP、真文件身份',()=>{
  const scene=(name='初始'):SceneSnapshot=>({sceneId:'state-scene',revision:0,coordinates:COORDINATES,entities:[{entityId:'actor',name,transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{human:{schema:1,mode:'kinematic',collision:'detailed',heightM:1.7,phase:0,source:{kind:'procedural',license:'fixture',sourceUpAxis:'Z'},rig:[{name:'root',offsetM:[0,0,0],quaternionXyzw:[0,0,0,1]}],clips:[{name:'walk',durationS:1,tracks:[{joint:'root',timesS:[0,1],rotationsXyzw:[[0,0,0,1],[0,0,.1,.99498743710662]],interpolation:'LINEAR'}]}]}}}]})
  const state=async(harness:Awaited<ReturnType<typeof boot>>,extra:Record<string,string>={})=>{
    const query=new URLSearchParams({sessionId:SESSION,sceneId:'state-scene',clientId:'window-one',displaySceneId:'state-scene',displayRevision:'0',...extra})
    const response=await harness.routes.get('/api/lyapunov/state')!(new Request('http://host/api/lyapunov/state?'+query))
    return {status:response.status,body:await response.json() as {scene?:SceneSnapshot;error?:string;hostInstanceId?:string}}
  }
  test('首次全量、后续同窗口省读和投影；缺标记/新窗口/切场景/过期与未来版本均全量',async()=>{
    const h=await boot()
    const read=spyOn(h.operations.scene,'snapshot'),project=spyOn(h.operations,'completeResourceSources')
    try{
      await writeScene(h,scene())
      const first=await state(h)
      expect(first.status).toBe(200);expect(first.body.scene?.entities[0]?.components.human).toEqual(scene().entities[0]!.components.human)
      const reads=read.mock.calls.length,projections=project.mock.calls.length
      expect(reads).toBe(1)
      const second=await state(h)
      expect(second.status).toBe(200);expect(second.body.scene).toBeUndefined();expect(second.body.hostInstanceId).toBe(first.body.hostInstanceId)
      expect(read.mock.calls.length).toBe(reads);expect(project.mock.calls.length).toBe(projections)
      const fallbacks:Record<string,string>[]=[{clientId:'new-window'},{clientId:''},{displaySceneId:''},{displayRevision:''},{displayRevision:'-1'},{displayRevision:'999'},{displaySceneId:'other-scene'}]
      for(const extra of fallbacks){
        const before=read.mock.calls.length,result=await state(h,extra)
        expect(result.status).toBe(200);expect(result.body.scene?.sceneId).toBe('state-scene');expect(read.mock.calls.length).toBe(before+1)
      }
      await h.operations.create({sceneId:'other-scene'})
      expect((await state(h,{sceneId:'other-scene'})).body.scene?.sceneId).toBe('other-scene')
      expect((await state(h,{displaySceneId:'other-scene'})).body.scene?.sceneId).toBe('state-scene')
    }finally{read.mockRestore();project.mockRestore();await h.dispose()}
  })
  test('同rev外部改写重新读取全量；坏JSON和删除报错；并发CAS提交后返回获胜的新版本',async()=>{
    const h=await boot()
    try{
      await writeScene(h,scene());await state(h)
      await writeScene(h,scene('外改'))
      expect((await state(h)).body.scene?.entities[0]?.name).toBe('外改')
      expect((await state(h)).body.scene).toBeUndefined()
      await writeFile(h.operations.scene.path('state-scene'),'{broken')
      const broken=await state(h);expect(broken.status).toBeGreaterThanOrEqual(400);expect(broken.body.scene).toBeUndefined();expect(broken.body.error).toBeTruthy()
      await writeScene(h,scene('恢复'));expect((await state(h)).body.scene?.entities[0]?.name).toBe('恢复')
      const edits=await Promise.allSettled(['甲','乙'].map(name=>h.operations.scene.commit({sceneId:'state-scene',expectedRevision:0,patch:[{op:'update',entityId:'actor',changes:{name}}]})))
      expect(edits.filter(row=>row.status==='fulfilled')).toHaveLength(1)
      const changed=await state(h);expect(changed.body.scene?.revision).toBe(1);expect(changed.body.scene?.entities[0]?.name).toBe((edits.find(row=>row.status==='fulfilled') as PromiseFulfilledResult<SceneSnapshot>).value.entities[0]!.name)
      expect((await state(h,{displayRevision:'1'})).body.scene).toBeUndefined()
      await import('node:fs/promises').then(fs=>fs.rm(h.operations.scene.path('state-scene')))
      const missing=await state(h,{displayRevision:'1'});expect(missing.status).toBeGreaterThanOrEqual(400);expect(missing.body.error).toContain('SCENE_NOT_FOUND')
    }finally{await h.dispose()}
  })
  test('同Host相同窗口ID、同SceneId和rev跨会话仍首次全量；Host重开不复用旧下发身份',async()=>{
    const other='session-route-other',h=await boot({sessionIds:[other]})
    try{
      await writeScene(h,scene('会话甲'))
      const ops=h.operationsFor(other);await ops.create({sceneId:'state-scene'})
      await writeFile(ops.scene.path('state-scene'),JSON.stringify(scene('会话乙')))
      expect((await state(h)).body.scene?.entities[0]?.name).toBe('会话甲')
      expect((await state(h)).body.scene).toBeUndefined()
      expect((await state(h,{sessionId:other})).body.scene?.entities[0]?.name).toBe('会话乙')
      expect((await state(h,{sessionId:other})).body.scene).toBeUndefined()
      expect((await state(h)).body.scene).toBeUndefined()
      const reopened=await boot({sceneRoot:h.root})
      try{expect((await state(reopened)).body.scene?.entities[0]?.name).toBe('会话甲')}finally{await reopened.dispose()}
    }finally{await h.dispose()}
  })
})
