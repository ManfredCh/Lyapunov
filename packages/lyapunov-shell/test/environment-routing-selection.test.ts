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

test('A06：规则地面/台面走 Blender，语义外观按约束走 Pontryagin，不按物体名称写死', () => {
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
    expect(plan.text).toContain(method === 'blender' ? "use Blender" : "use Pontryagin 3D")
  }
})

test('A06：显式生成器优先，否定供应商选择不覆盖正向 Blender 选择', () => {
  for (const request of ['用 Pontryagin 3D 生成一块 2m 地板','不要用Blender，生成一个箱子','Use Pontryagin 3D to generate a cube','Generate a cube without Blender'])
    expect(selectAssetGenerationRoute(request)?.method).toBe('peiri3d')
  for (const request of ['用Blender生成一根香蕉','不用 Pontryagin，使用 Blender 生成一个写实箱子','Do not use Pontryagin 3D, use Blender to generate a model'])
    expect(selectAssetGenerationRoute(request)?.method).toBe('blender')
  expect(selectAssetGenerationRoute('用 Blender 生成精确地面，再用 Pontryagin 3D 生成一个写实摆件')?.method).toBe('mixed')
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

test('Alpha6.2：优先实际发现的适用Blender MCP，不猜命名空间；不可见时保留batch fallback',()=>{
 const tool={name:'mcp__custom_bridge__inspect_scene',description:'Inspect the connected Blender scene'}
 const request={...input('用 Blender 生成一块精确地板'),pointers:actualPointers}
 const connected=planDomainPointers({...request,hasTool:name=>name===tool.name,visibleMcpTools:[tool]})!
 expect(connected.text).toContain(tool.name)
 expect(connected.text).toContain('Prefer an applicable tool')
 expect(connected.text).not.toContain('The selected generation interface is not mounted')
 const absent=planDomainPointers({...request,hasTool:name=>name==='blender_run',visibleMcpTools:[tool]})!
 expect(absent.text).toContain('No Blender MCP tool is currently visible')
 expect(absent.text).toContain('blender_run batch fallback remains usable')
 expect(absent.text).not.toContain(tool.name)
})

// Source3095正常账户照片任务的逐字制作目标；预算条件不表示现在取消。
const photoBudgetPrompt = "根据本条附上的唯一檐角照片，自主做一个可编辑的檐角局部：有弧度和厚度的屋檐、至少三条连续瓦垄、可辨的木纹构件。只做局部，不造整塔，不读或复用其它会话的脚本和成品。使用当前已连接的 Blender MCP 实际建模，不以 blender_run、独立 MCP 客户端或空文字代替。\n先实际读这张照片并说明关键形状，然后自主写 bpy。生成真实整体和近景预览并实际看图，指出具体几何差距，至少做一轮针对预览的几何修订，再看同视角验证。保留前后预览。程序材质必须烘焙成可携带图片与 UV，交付可编辑 .blend 和内嵌贴图 .glb；使用当前产品原 export_world／资源版本接口，最终正常导入本会话 Viewer（physicalize:false），不要启动物理世界。所有产物放当前工作区 photo-eave-a9616，文件不要覆盖前一版本。最后如实列未达到照片的地方。\n本轮验收最多15分钟、12个模型step、12000输出token；连续两轮没有新图像或几何事实应停止并报告，不重复提交未知或超时工具。先确保实际工具和图像往返，不用“运行中”代替交付。"

test('照片制作预算中的未来停止条件不抢占目标，当前已发现Blender MCP路线仍可用', () => {
  const request: EnvironmentRoutingInput = {
    messages: [userMessage(text(photoBudgetPrompt), { type: 'image', attachment: { attachmentId: 'own-photo-fixture', name: '03_dougong_detail.jpg', mediaType: 'image/jpeg', width: 1500, height: 998, bytes: 290983 } })],
    todos: [],
    hasTool: name => ['mcp__blender__execute_blender_code', 'sim_world_list', 'job_list'].includes(name),
    visibleMcpTools: [{ name: 'mcp__blender__execute_blender_code', description: '' }],
  }
  const decision = routeEnvironment(request), plan = planDomainPointers({ ...request, pointers: actualPointers })!
  // 只纠正Stop；原modify优先于build仍把后续预览修订归local，不伪称完整新制作验收。
  expect(decision.stage).toBe('local')
  expect(decision.inputSource).toBe('photo')
  expect(decision.facts.sceneId).toBeUndefined()
  expect(decision.facts.worldId).toBeUndefined()
  expect(decision.facts.sessionEnvironmentTodos).toEqual([])
  expect(plan.text).not.toContain('Stop immediately')
  expect(plan.text).not.toContain('[Stop]')
  expect(plan.text).toContain('Blender architectural modeling')
  expect(plan.text).not.toContain('An annotation-based local edit requires scene_edit')
  expect(plan.text).not.toContain('Edit an existing scene locally with scene_edit')
  // 显式制作的同预算句仍消费原实际MCP名称；不冒称local档已点名全部工具。
  const explicitBuild = planDomainPointers({ ...request, messages: [userMessage(text('用Blender创建檐角构件场景；连续两轮没有新图像应停止并报告'))], pointers: actualPointers })!
  expect(explicitBuild.decision.stage).toBe('new')
  expect(explicitBuild.text).toContain('mcp__blender__execute_blender_code')
})

test('中英未来条件和未达到的制作预算不注入立即停止，否定停止保持制作目标', () => {
  for (const request of [
    '用Blender创建庭院场景；连续两轮没有新图像应停止并报告',
    '创建庭院场景，如果两轮没有进展就停止',
    '创建庭院场景；达到12个模型step后停止',
    '创建庭院场景；停止应在连续两轮没有进展后执行',
    'Create a courtyard scene using Blender; stop if two rounds produce no progress.',
    'Create a courtyard scene using Blender; if two rounds fail, stop and report.',
    'Create a courtyard scene using Blender; after two unsuccessful rounds, stop and report.',
    'Create a courtyard scene using Blender; stop after twelve steps.',
    'Create a courtyard scene using Blender; stop when the time budget is reached.',
    '不要停止，用Blender创建庭院场景',
    'Create a courtyard scene using Blender; do not stop.',
    "Create a courtyard scene using Blender; don't cancel.",
  ]) {
    const decision = routeEnvironment(input(request, { hasTool: () => true }))
    expect(decision.stage).toBe('new')
    expect(renderEnvironmentPointer(decision) ?? '').not.toContain('Stop the action immediately')
  }
})

test('当前立即停止、已满足预算后的明确停止，以及未来条件后的独立Stop仍优先', () => {
  for (const request of [
    '现在停止这个场景的生成',
    '取消这个场景的生成',
    '已经连续两轮没有新图像或几何事实，应立即停止场景制作',
    '预算已经耗尽，现在立即停止场景制作',
    '创建庭院场景，如果两轮没有进展就停止。现在立即停止场景生成',
    '不要停止场景生成；现在取消场景生成',
    'Stop creating this courtyard scene now.',
    'Two rounds have already failed; stop the courtyard scene immediately.',
    'Create a courtyard scene; if two rounds fail, stop. Cancel the scene now.',
    'Do not stop the courtyard scene; cancel it now.',
  ]) {
    const decision = routeEnvironment(input(request, { hasTool: name => name === 'sim_stop' || name === 'job_kill' }))
    expect(decision.stage).toBe('stop')
    expect(decision.hints.map(hint => hint.name)).toEqual(['sim_stop', 'job_kill'])
    expect(renderEnvironmentPointer(decision)).not.toContain('Generation route:')
  }
  expect(routeEnvironment(input('只给方案，不要执行：创建庭院场景；如果预算耗尽就停止')).stage).toBe('plan-only')
})

test('R2：当前场景仍在生成的中文条件配现在立即停止，属于当前Stop', () => {
  const decision = routeEnvironment(input('如果这个场景仍在生成，现在立即停止', { hasTool: name => name === 'sim_stop' || name === 'job_kill' }))
  expect(decision.stage).toBe('stop')
  expect(decision.hints.map(hint => hint.name)).toEqual(['sim_stop', 'job_kill'])
  expect(renderEnvironmentPointer(decision)).not.toContain('Generation route:')
  for (const request of [
    '创建庭院场景，如果两轮后这个场景仍在生成就停止',
    '创建庭院场景，如果这个场景仍在生成，连续两轮没有进展后立即停止',
    '如果这个场景仍在生成，现在不要停止',
  ]) expect(routeEnvironment(input(request)).stage).toBe('new')
})

test('R2：当前场景仍在生成的英文条件配stop it now，属于当前Stop', () => {
  const decision = routeEnvironment(input('If this scene is still being generated, stop it now.', { hasTool: name => name === 'sim_stop' || name === 'job_kill' }))
  expect(decision.stage).toBe('stop')
  expect(decision.hints.map(hint => hint.name)).toEqual(['sim_stop', 'job_kill'])
  expect(renderEnvironmentPointer(decision)).not.toContain('Generation route:')
  expect(routeEnvironment(input('Create a courtyard scene; if this scene is still being generated after two rounds, stop it now.')).stage).toBe('new')
  expect(routeEnvironment(input('If this scene is still being generated, do not stop it now.')).stage).toBe('new')
})

test('R2：15.5分钟预算中的小数点不切断未来停止条件，制作目标仍属new', () => {
  for (const request of [
    '创建庭院场景；预算达到15.5分钟后停止',
    'Create a courtyard scene; after 15.5 minutes, stop.',
  ]) {
    const decision = routeEnvironment(input(request))
    expect(decision.stage).toBe('new')
    expect(renderEnvironmentPointer(decision) ?? '').not.toContain('Stop the action immediately')
  }
  expect(routeEnvironment(input('创建庭院场景；预算达到15.5分钟后停止。现在立即停止场景生成')).stage).toBe('stop')
})


test('角色定义：Pontryagin明确选后台世界生成，Peiri加Blender仍是编程建模', () => {
  for (const request of ['用Pontryagin生成一个规则箱子','Use Pontryagin to generate a cube','用Pontryagin 3D生成一块2m地板']) {
    const route=selectAssetGenerationRoute(request)!
    expect(route.method).toBe('peiri3d');expect(route.why).toContain('Pontryagin 3D');expect(route.why).not.toContain('Peiri 3D')
  }
  for (const request of ['用Peiri通过Blender生成一个3D模型','Use Peiri with Blender to generate a cube','用Peiri生成一个规则箱子'])
    expect(selectAssetGenerationRoute(request)?.method).toBe('blender')
  for (const request of ['使用生成式生成一块2m地板','用文生3D生成一个箱子','用图生3D生成一个箱子'])
    expect(selectAssetGenerationRoute(request)?.method).toBe('peiri3d')
  const mixed=selectAssetGenerationRoute('用Blender生成规则地面，再用Pontryagin生成一个写实摆件')!
  expect(mixed.method).toBe('mixed');expect(mixed.why).toContain('Pontryagin 3D')
})
