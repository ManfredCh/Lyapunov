/**
 * ENV-58／53 回归：路由必须**综合"选择"**这一输入，且常用建造动词不能被漏掉。
 *
 * 起因（N42 只读定位 + 真实调用复现）：
 *  1. `local` 档的证据闸只有 `messageEnv || sessionEnvWork`，于是"已选场景 + 只说改什么"（消息里没有
 *     环境名词，如"把门口的石狮换成铜的"）被记成 `no-evidence`；而 `local` 分支里的 `sceneId` 子句
 *     （既有场景就地修改）因此**永远走不到**——选择明明是 ENV-58 明列的输入之一。
 *  2. `BUILD_VERB` 收了 新建/创建/建个/建一个/搭建…，却漏了同样常用的 **建造**，于是
 *     "帮我建造一条中式老街的环境" 落到 `none`（新建档完全没触发）。
 */
import { expect, test } from 'bun:test'
import { planDomainPointers, renderEnvironmentPointer, routeEnvironment, selectAssetGenerationRoute, type EnvironmentRoutingInput } from '../src/environment-routing.ts'
import { parsePointers } from '../../../script/gates/domain-pointers.ts'
import { readFileSync } from 'node:fs'

const text = (value: string) => ({ type: 'text', text: value })
const userMessage = (...blocks: unknown[]) => ({ role: 'user', content: blocks, source: { kind: 'user' } }) as never
const input = (value: string, extra: Partial<EnvironmentRoutingInput> = {}): EnvironmentRoutingInput =>
  ({ messages: [userMessage(text(value))], ...extra }) as EnvironmentRoutingInput

test('未证G1站立/起身不自动加载远端policy/provisioning正文，目录命中与prepared不是行为依据',()=>{
 const pointers=parsePointers(readFileSync(new URL('../src/plugin.ts',import.meta.url),'utf8'))
 for(const request of ['让G1站起来','机器人从地上起身','unitree_go1 self-righting','不要停止，让G1站起来']) {
  const plan=planDomainPointers({...input(request,{selection:{sceneId:'current'}}),pointers})!
  expect(plan.injected).toEqual([]);expect(plan.text).toContain('No target-specific adaptation or behavior receipt')
  expect(plan.text).not.toContain('read skill `robot-provisioning`')
  expect(plan.text).not.toContain('policy_download_bundle')
 }
 expect(planDomainPointers({...input('停止 G1 起身'),pointers})).toBeUndefined()
 expect(planDomainPointers({...input('停止下载G1站立policy'),pointers})).toBeUndefined()
})
test('显式下载行为来源指官方站点或仓库并按需联网，不要求适配端点；普通本体获取保原路径',()=>{
 const pointers=parsePointers(readFileSync(new URL('../src/plugin.ts',import.meta.url),'utf8'))
 for(const requestText of ['下载G1站立policy','下载G1站立policy 的关节观测映射']) {
  const request=planDomainPointers({...input(requestText),pointers})!
  expect(request.injected).toEqual([]);expect(request.text).toContain("body's official website or official repository")
  expect(request.text).toContain('Browser Use keyword search');expect(request.text).toContain('WebFetch for a known URL')
  expect(request.text).toContain('Bash for necessary acquisition');expect(request.text).toContain('does not require a regional or adapted endpoint')
  expect(request.text).toContain("client's actual simulation readback")
 }
 expect(planDomainPointers({...input('下载一个G1机器人'),pointers})!.injected).toContain('robot-provisioning')
 expect(planDomainPointers({...input('手动抬起机器人关节，使G1站起来'),pointers})!.injected).toContain('action-execution')
})

test('已选场景 + 修改动词（消息无环境名词）→ local 档，并给出就地修改技能提示', () => {
  const decision = routeEnvironment(input('把门口的石狮换成铜的', { selection: { sceneId: 'scene_a' } }))
  expect(decision.stage).toBe('local')
  expect(decision.inputSource).toBe('existing-scene')
  expect(decision.intent.word).toBe('换成')
  expect(decision.intent.rejected).toEqual([])                       // 不再被记成 no-evidence
  expect(decision.hints.map(hint => hint.name)).toEqual([undefined, 'scene-construction'])
  expect(decision.hints[1]!.why).toContain("Preserve the selected target and version")
  // ENV-54：局部档必须点名「补什么参考」与「影响哪个构件」，并如实说明本档拿不到 entityId
  expect(decision.hints[0]!.why).toContain("Resolve reference gaps as needed")
  expect(decision.hints[0]!.why).toContain("identify the affected component")
  expect(decision.hints[0]!.why).toContain("when entityId is missing")
})

test('负对照：没有任何选择/环境证据时，同一个修改动词仍被记成 no-evidence（不无根据地判成环境任务）', () => {
  const decision = routeEnvironment(input('把门口的石狮换成铜的'))
  expect(decision.stage).toBe('none')
  expect(decision.intent.rejected).toContainEqual({ stage: 'local', word: '换成', reason: 'no-evidence' })
})

test('"建造" 是新建动词：与 建一个/新建 同档（ENV-53 新建先规划）', () => {
  const built = routeEnvironment(input('帮我建造一条中式老街的环境'))
  expect(built.stage).toBe('new')
  expect(built.intent.word).toBe('建造')
  expect(built.hints.map(hint => hint.name)).toContain('environment-planning')
  expect(built.hints[0]!.why).toContain("plan as needed for complexity")
})

test('四类意图在同一份路由里可区分（新建／继续／局部／只给方案）', () => {
  const stages = [
    routeEnvironment(input('给我建一个庭院环境')).stage,
    routeEnvironment(input('继续上次的环境', { todos: [{ content: '生成老街环境资产', status: 'pending' }] as never })).stage,
    routeEnvironment(input('把门口的石狮换成铜的', { selection: { sceneId: 's1' } })).stage,
    routeEnvironment(input('只给方案，不要动手：做个庭院')).stage,
  ]
  expect(stages).toEqual(['new', 'continue', 'local', 'plan-only'])
})

test('AG2: simple resource actions retain facts without full environment planning', () => {
  for (const request of [
    '打开 HTML 文件', '打开 scene-build.html', '打开 场景修改.html',
    '把已有资源拖入场景', '拖入 building.glb 到当前场景', 'import model.glb into the scene',
  ]) {
    const decision = routeEnvironment(input(request, {
      selection: { sceneId: 'scene_a' },
      todos: [{ content: '继续构建场景', status: 'pending' }],
    }))
    expect(decision.stage).toBe('none')
    expect(decision.spec).toBeUndefined()
    expect(decision.facts.sceneId).toBe('scene_a')
    expect(decision.facts.sessionEnvironmentTodos).toHaveLength(1)
    expect(renderEnvironmentPointer(decision)).toBeUndefined()
  }
})

test('AG2: opening a resource does not mask an explicit scene edit or build request', () => {
  for (const request of ['打开 scene.html，再建一个房间', '导入 model.glb 然后调整场景位置', '把要修改的场景文件打开']) {
    expect(routeEnvironment(input(request, { selection: { sceneId: 'scene_a' } })).stage).not.toBe('none')
  }
})

test('AG2: a local edit keeps its target but does not require planning/research skills or a full specification', () => {
  const plan = planDomainPointers({ ...input('把院墙加高一点', { selection: { sceneId: 'scene_a' } }), pointers: [] })!
  expect(plan.injected).toEqual(['scene-construction'])
  expect(plan.text).not.toContain('environment-planning')
  expect(plan.text).not.toContain('environment-research')
  expect(plan.text).not.toContain("Scene specification (ENV-02)")
  expect(plan.decision.spec!.deliverables).toContain("preserve scene_a the existing target")
})

test('AG2: planning hint respects a complete native skill catalog', () => {
  const decision = routeEnvironment(input('建一个场景', { skillCatalog: { names: [], complete: true } }))
  expect(decision.hints[0]?.kind).toBe('note')
  expect(decision.hints[0]?.name).toBeUndefined()
  expect(renderEnvironmentPointer(decision)).not.toContain("Read skill `environment-planning`")
})

const actualPointers = parsePointers(readFileSync(new URL('../src/plugin.ts',import.meta.url),'utf8'))

test('A06：规则地面/台面走 Blender，语义外观按约束走 Peiri，不按物体名称写死', () => {
  const cases = [
    ['生成一个 3m × 2m、厚 0.1m 的地板','blender'],
    ['做一个长 1.2 米宽 0.6 米的可编辑台面','blender'],
    ['生成一根香蕉','peiri3d'],
    ['生成一个有机外形的三维物体，目标高度20cm','peiri3d'],
    ['生成一件有真实纹理的自然外形资产','peiri3d'],
    ['生成一个写实木箱','peiri3d'],
    ['生成一个写实木箱，长1m宽0.5m高0.5m','blender'],
    ['Generate a textured organic 3D asset','peiri3d'],
    ['Generate a text-to-3D model','peiri3d'],
  ] as const
  for (const [request,method] of cases) {
    expect(selectAssetGenerationRoute(request)?.method).toBe(method)
    const plan = planDomainPointers({...input(request),pointers:actualPointers})!
    expect(plan.injected).toContain('asset-generation')
    expect(plan.text).toContain("Generation route:")
    expect(plan.text).toContain(method === 'blender' ? "use Blender" : "use Peiri 3D")
  }
})

test('A06：显式生成器优先，否定供应商选择不覆盖正向 Blender 选择', () => {
  for (const request of ['用 Peiri 3D 生成一块 2m 地板','不要用Blender，生成一个箱子','Use Peiri 3D to generate a cube','Generate a cube without Blender'])
    expect(selectAssetGenerationRoute(request)?.method).toBe('peiri3d')
  for (const request of ['用Blender生成一根香蕉','不用 Peiri，使用 Blender 生成一个写实箱子','Do not use Peiri 3D, use Blender to generate a model'])
    expect(selectAssetGenerationRoute(request)?.method).toBe('blender')
  expect(selectAssetGenerationRoute('用 Blender 生成精确地面，再用 Peiri 3D 生成一个写实摆件')?.method).toBe('mixed')
})

test('A06：没有生成授权的动作/导入保持原路由；只方案与停止不能新增提交', () => {
  for (const request of ['让机器人把香蕉放到桌上','打开 Blender模型.glb','生成测试数据','不要生成模型'])
    expect(selectAssetGenerationRoute(request)).toBeUndefined()
  for (const [request,stage] of [['只给方案：生成一个真实环境','plan-only'],['取消这个场景的生成','stop']] as const) {
    const plan = planDomainPointers({...input(request),pointers:actualPointers})!
    expect(plan.decision.stage).toBe(stage)
    if (plan.decision.stage === 'stop') expect(plan.text).not.toContain("Generation route:")
  }
})

test('A06：所选工具缺失要明确阻断，不暗换来源；技能缺失时不伪造注入', () => {
  const blocked = planDomainPointers({...input('生成一件写实三维资产'),pointers:actualPointers,hasTool:()=>false})!
  expect(blocked.text).toContain("The selected generation interface is not mounted")
  expect(blocked.text).toContain("Do not repeat a request when server configuration and the quote have not changed")
  expect(blocked.text).toContain("without loading the same skill again")
  const absent = planDomainPointers({...input('生成一件写实三维资产'),pointers:actualPointers,skillCatalog:{names:[],complete:true}})
  expect(absent).toBeUndefined()
})
