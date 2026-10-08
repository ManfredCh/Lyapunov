/**
 * 环境任务的阶段路由与域指针合成（ENV-01 / ENV-04 / ENV-53–59 的第一层）。
 *
 * 为什么单独一个文件：`plugin.ts` 的 `agent/pre-step` 只该做接线——把**真实的**输入
 * （本步用户消息的内容块、原生 todo 投影给出的会话任务、工作台选择、工具与技能目录）
 * 交给这里判定，再把结果作为一条请求级用户消息注入。
 *
 * 设计原则（2026-09-20 按主代理反例检查收敛）：
 *
 * 1. **事实与意图分开**。`facts` 只登记可核对的事实：附件形态（照片/图纸/混合）、用户
 *    文字里点名的图纸词、视口批注来源、工作台选择、会话原生 todo 里**带领域名**的未完成项、
 *    技能/工具是否可见。`intent` 只登记这次判定用了哪个词、是否命中否定式。段位（stage）
 *    是两者的保守合成，不是关键词的直译。
 * 2. **不越权停止或启动**。否定式（"不要停止，继续搭建这个庭院"）不算停止；明确"只给方案"
 *    优先于停止；"继续"必须在会话里确实有环境任务（todo 未完成项**带领域名**）时才成立；
 *    没有可识别的领域动词（建/改）时不猜段位（`none`），交给关键词表给保守的能力提示。
 *    "build web server" 这类软件待办里有 build 但不是环境对象，因此 todo 判定只看领域名词。
 * 3. **附件只提供线索，不授权建模**。"这张照片拍的是谁"配一张图不是环境任务；图像附件本身
 *    不把消息变成"新建环境"。反过来，用户文字里点名了图纸（"按照这张平面图生成房间"）时，
 *    即使附件名里没有图纸词也按图纸理解——未知图片不硬说成照片。
 * 4. **同一句话因附件不同走不同路径**（ENV-01）：照片→复现、图纸图/图纸文件→读图重建、
 *    没有附件才是纯文字创作；差异体现在输入来源与随之给出的技能约束上。
 * 5. **不虚构能力**：技能提示只在技能目录里确实存在时给出（目录不可读时不判定缺失，
 *    但也不给"我们并不知道它存在"的猜测）；停止入口只在工具真的可见时点名，否则如实说明
 *    缺口。工具与技能目录都是原生服务的只读事实，这里不另建注册表。
 * 6. **规划档要给出完整的路线面**（2026-09-20 真实回合复盘）：现实复现与多资产混合的任务，
 *    计划阶段同时给"跨来源检索"（`environment-research`）与"资产路线"（`asset-generation`）
 *    两张卡，否则模型容易把**一个目录未命中**当成"全网不存在"，直接锁死到"用几块几何雕"。
 *
 * 关于会话上下文：`agent/pre-step` 的 `messages` 是**本步 claimed 输入**，不等于完整历史——
 * 这是对**这个路由钩子**说的，不是对模型说的。钩子只用两样原生真值（本步消息含附件、
 * 原生 todo 投影）做判定；模型自己的会话历史、todo/job 仍然是它的真值，提示文本里不说
 * "你只有本步输入"这种会诱导模型假装失忆的话。
 *
 * 真值仍归原生：计划与进度是会话的 todo 投影与原生 job；这里不建第二套计划库、不建第二个
 * router agent，也不缓存会话状态。
 *
 * @module
 */

import type { ContentBlock, UserMessage } from "@deepseek-ai/dsh-llm"
// 类型合并：`todos` 投影键由 dsh-tool-todo 声明，读 `stateOf(session,'todos')` 需要它。
import type {} from "@deepseek-ai/dsh-tool-todo"
import type { TodoItem } from "@deepseek-ai/dsh-tool-todo"

/** 环境工作的阶段。`none` = 这条消息不属于环境域，保持既有指针行为不变。 */
export type EnvironmentStage = "new" | "continue" | "local" | "plan-only" | "stop" | "none"

/** 输入来源形态（ENV-01）：同一句话因附件不同而不同。 */
export type EnvironmentInputSource = "photo" | "cad" | "text" | "mixed" | "existing-scene" | "annotation" | "none"

/** 一条要注入的提示。`skill` 走 skill 工具加载；`tool` 是已注册可直接用的工具；`note` 是无入口/缺能力时的如实说明。 */
export interface EnvironmentPointerHint {
  readonly kind: "skill" | "tool" | "note"
  readonly name?: string
  readonly why: string
}

/** 可核对的事实（不含任何"用户想干什么"的推断）。 */
export interface EnvironmentFacts {
  /** 附件形态：照片/图纸/混合（`undefined` = 本步没有附件）。 */
  readonly attachmentKind: EnvironmentInputSource | undefined
  /** 附件依据（真实字段：名字、媒体类型、像素、字节数）。 */
  readonly attachmentSummary: string | undefined
  /** 附件名里的环境词（"厂房照片.jpg" 有，"error.png" 没有）。 */
  readonly attachmentEnvName: string | undefined
  /** 用户文字里点名的图纸词（"按照这张平面图…" → 平面图）。 */
  readonly namedDrawing: string | undefined
  /** 本步就是 3D 视口批注。 */
  readonly annotation: boolean
  /** 工作台当前选择。 */
  readonly sceneId: string | undefined
  readonly worldId: string | undefined
  /** 会话原生 todo 里未完成、且**点名了领域对象**（场景/图纸等名词，不看 build 之类动词）的项。 */
  readonly sessionEnvironmentTodos: readonly TodoItem[]
  /** todo 投影是否可读（不可读时如实登记，不假装"没有任务"）。 */
  readonly todosReadable: boolean
  /** 技能目录是否可读（可读时 `skillExists` 是权威判断）。 */
  readonly skillCatalogReadable: boolean
}

/** 一条**被拒**的意图：命中了词，但因为否定式或缺环境证据没有成立（供核对"为什么没按它走"）。 */
export interface RejectedIntent {
  readonly stage: EnvironmentStage
  readonly word: string
  readonly reason: "negated" | "no-evidence"
}

/** 这次判定用到的意图（只登记命中了什么、什么被拒，不解释语义）。 */
export interface EnvironmentIntent {
  /** 最终成立的段位（`none` = 没有成立任何意图）。 */
  readonly stage: EnvironmentStage
  /** 成立的意图词原文（无则 undefined）。 */
  readonly word: string | undefined
  /** 命中但被拒的意图（否定式 / 缺环境证据）。 */
  readonly rejected: readonly RejectedIntent[]
}

export interface EnvironmentRoutingDecision {
  readonly stage: EnvironmentStage
  readonly inputSource: EnvironmentInputSource
  /** 判定依据（附件/消息词/会话任务/选择/能力/技能目录），人类可读，供注入文本与测试核对。 */
  readonly evidence: readonly string[]
  readonly hints: readonly EnvironmentPointerHint[]
  /** 命中的意图词（无则 undefined），便于回执核对为什么这么判。 */
  readonly matched: string | undefined
  readonly facts: EnvironmentFacts
  readonly intent: EnvironmentIntent
  /** ENV-02 简短场景规格（`none`/`stop` 档不产出）。 */
  readonly spec?: BriefSceneSpec | undefined
}

/** 技能目录只读事实：调用方从原生技能服务（`ctx.skills.snapshot()`）读出名字集合。 */
export interface SkillCatalogFact {
  readonly names: readonly string[]
  /** 目录是否完整（不完整时"查不到"不等于"不存在"）。 */
  readonly complete: boolean
}

export interface EnvironmentRoutingInput {
  /** 本步 claimed 的用户消息（原生 UserMessage）。**不等于完整会话历史。** */
  readonly messages: readonly UserMessage[]
  /** 会话原生任务：todo 投影最新整表；null=本会话没写过；undefined=投影服务不可读。 */
  readonly todos?: readonly TodoItem[] | null | undefined
  /** 工作台当前选择（view-selection 记录的事实）。 */
  readonly selection?: { readonly sceneId?: string; readonly worldId?: string } | undefined
  /** 工具可见性（调用方的 `ctx.tools.get(name, agent)`）；缺省按不可见处理，不假装有入口。 */
  readonly hasTool?: ((name: string) => boolean) | undefined
  /** 原生工具注册表当前可见的 MCP 名称与描述；不假定桥接命名空间或工具存在。 */
  readonly visibleMcpTools?: readonly {name:string;description:string}[] | undefined
  /** 原生技能目录（`ctx.skills.snapshot()`）；缺省=不可读，不据此判定技能缺失。 */
  readonly skillCatalog?: SkillCatalogFact | undefined
}

/** 指针注入的上限：环境提示 + 关键词补充合计不超过 3 行（"不灌满"）。 */
export const MAX_POINTERS = 3
/**
 * 阶段提示的**独立**预算（关键词补充仍按 {@link MAX_POINTERS} 算，且只在阶段提示占不满时才补）。
 * 为什么分开：现实复现与多资产混合的计划档要同时给出 planning + 输入契约（读图/照片）+
 * 检索 + 资产路线四张卡；把伴随契约压进 3 行预算会让"跨来源检索"被泛 scene 关键词顶掉，
 * 真实回合里模型因此把"一个目录未命中"当成了"全网没有"。
 */
export const MAX_STAGE_HINTS = 4

/** 域指针表的一条（`plugin.ts` 的 `domainPointers` 形状，门禁 `script/gates/domain-pointers.ts` 从源码解析）。 */
export interface DomainPointer {
  readonly skill: string
  readonly label: string
  readonly pattern: RegExp
  readonly tool?: boolean
}

export interface DomainPointerPlan {
  /** 要注入的整条文本（多行）。 */
  readonly text: string
  readonly decision: EnvironmentRoutingDecision
  /** 实际注入的条目名（环境提示在前，关键词补充在后）。 */
  readonly injected: readonly string[]
}

export interface AssetGenerationRoute {
  readonly method: "blender" | "peiri3d" | "mixed"
  readonly why: string
}

/** 域指针消息的来源身份：计算用户输入时必须跳过自己注入过的指针，避免自我引用。 */
export const DOMAIN_POINTER_SOURCE = "lyapunov-domain-pointer"

/** 界面把 3D 视口批注作为一条用户消息投进会话时用的来源身份（真实字段，见 plugin.ts）。 */
export const ANNOTATION_SOURCE = "lyapunov-annotation"

// —— 词汇表：中英双列。分隔符必须写成 `[\s-]` 而不是 `[\s-]?`：后者让分隔符可选，
// 会让 `floorplan` 这类没有分隔符的写法被"意外"匹配（2026-09-18 曾经因此把 floorplan
// 判成非图纸）。本轮按主代理核对修正：`floorplan` **就是**图纸写法，要显式收进来。
// 名词表刻意不收"模型"：裸"生成一个模型"属于资产生成域，不该被环境域抢走；
// 也不收"桌子/椅子"这类机器人操作常用的目标物（"把箱子搬到桌子上"是动作任务，不是环境任务）；
// 动词单独出现（"改一下""移动过去"）同样不触发环境路由——必须有环境名词、图纸词、批注或
// 名称带环境词的附件，否则机器人/代码/闲聊消息会被误判（ENV-58 的"无关聊天不注入"）。
const ENV_NOUN =
  /(场景|环境|房间|室内|庭院|院子|街道|街区|城市|建筑|厂房|仓库|场地|广场|园区|世界|地图|地形|图纸|平面图|户型图|施工图|立面图|剖面图|总平|蓝图|照片|影像|点云|现场|工地|构件|墙体|墙|屋顶|门窗|地板|家具|树|路面|桥|布景|园林|景观|scene|room|interior|building|warehouse|factory|courtyard|street|city|terrain|floorplan|floor[\s-]plan|blueprint|facade)/i
const BUILD_VERB =
  // ENV-53 收口（N124）：整体重构的口语写法「把整个院子推倒重来」原先一个建造词都不命中
  // （推倒/重来 都不在表里）⇒ 真实回合里路由 none、连"先规划"契约都不注入。补 重来|重做
  // （不加"推倒"：单说"把墙推倒"更像局部拆除，不该被抬成整体重构；"推倒重来/重做"靠这两词命中）。
  /(新建|创建|建造|建个|建一个|建出来|建好|建成|建起|搭建|搭个|搭一个|造个|造一个|做个|做一个|构造|建模|重建|复原|还原|复现|恢复成|复刻|布置|设计|规划|生成|导成|做成|转成|盖一|重来|重做|reconstruct|rebuild|recreate|build|create|model|make|generate|assemble|design|construct)/i
const MODIFY_VERB =
  /(改|调整|修改|修正|修订|纠正|移动|挪|旋转|缩放|放大|缩小|加高|降低|抬高|压低|加宽|收窄|换成|替换|删|去掉|移除|补上|加上|对齐|摆正|颜色|材质|贴图|位置|朝向|再高|再低|再大|再小|不对|错了|有问题|不符|move|rotate|resize|scale|adjust|modify|fix|recolor|replace|align)/i
const STOP_INTENT =
  /(停止|停下|停掉|别做|不要做|不用做|不做了|别继续|不要继续|先停|中断|中止|取消|算了|不弄了|stop|cancel|abort|halt|never\s*mind|forget it)/i
/** 否定词：出现在意图词前 4 个字符内即视为"否定式意图"（"不要停止"不是停止）。 */
const NEGATION_BEFORE = /[不别勿非无]/
const PLAN_ONLY_INTENT =
  /(只(?:要|给|出|看)?[^。！？\n]{0,6}(?:方案|计划|思路|路径|想法|建议)|先(?:给|出|说|讲|列)[^。！？\n]{0,6}(?:方案|计划|思路|路径|想法)|只规划|先规划|只做方案|方案就行|计划就行|别(?:动手|执行|开始|真的|直接)|不要执行|不用执行|不执行|先不要(?:做|执行|开始)|先别(?:做|执行|开始|动手|提交)|只(?:告诉|说|讲)[^。！？\n]{0,10}(?:方案|计划|怎么|如何|路径|思路)|不(?:要)?真的?(?:做|提交|执行)|plan\s*only|only (?:a |the )?plan|just (?:the )?plan|don'?t (?:build|execute|start|run)|no execution|design only|just tell me)/i
const CONTINUE_INTENT =
  /(继续|接着(?:做|来|弄|干|完成|往下|刚才|之前)|往下(?:做|走|弄)|剩下的|剩余(?:的|部分)|接着来|续上|做下去|完成剩下|continue|resume|keep going|go on|carry on|finish (?:it|the rest))/i
/** 图纸词汇：判断"这张图"是不是图纸（而不是照片）。裸"图"不算，避免把'把这张图做成 3D 模型'误判成读图。 */
const DRAWING_WORD =
  /(平面图|平面|立面|剖面|总平|施工图|施工|户型|图纸|图则|大样|详图|方案图|竣工|测绘|蓝图|floorplan|floor[\s-]plan|blueprint|elevation|section|technical drawing|construction drawing|drawing)/i
/** 只处理已有文件的打开/预览/拖入，不因文件名含「场景/build/修改」或当前选择而要求环境规划。 */
const RESOURCE_REFERENCE = /(?:\bhtml?\b|\.(?:html?|glb|gltf|obj|fbx|ply|splat|ksplat|spz|dxf|dwg|pdf|svg|png|jpe?g)\b|文件|已有(?:资源|素材|资产)|(?:这个|该)(?:资源|素材|资产)|\b(?:file|asset|resource)\b)/i
const RESOURCE_ACTION = /^(?:请|帮我|请帮我|只要|只需|直接|先|please\s+)?\s*(?:把\s*.+?\s*)?(?:打开|预览|查看|拖入|拖进|拖到|拖拽|导入|open\b|preview\b|view\b|drag\b|drop\b|import\b)\s*(.+)$/i
const RESOURCE_PATH = /(?:["'`「][^"'`」]+["'`」]|[^\s，,。；;！？!?]+)\.(?:html?|glb|gltf|obj|fbx|ply|splat|ksplat|spz|dxf|dwg|pdf|svg|png|jpe?g)\b/gi

function resourceOperationOnly(text: string): boolean {
  if (!RESOURCE_REFERENCE.test(text)) return false
  const action = RESOURCE_ACTION.exec(text.trim())
  if (!action) return false
  // 路径中的普通词不是建造意图；多句或明确附带制作/修改请求仍交给原路由。
  const remainder = text.replace(RESOURCE_PATH, "")
  return !/[，,。；;！？!?\n]/.test(remainder)
    && !BUILD_VERB.test(remainder) && !MODIFY_VERB.test(remainder)
    && !STOP_INTENT.test(remainder) && !CONTINUE_INTENT.test(remainder)
}

const CAD_EXTENSIONS = new Set(["dxf", "dwg", "dwf"])
const DRAWING_FILE_EXTENSIONS = new Set(["pdf", "svg"])
/**
 * 现实复现线索：目标是**真实世界里存在**的东西（照片/实景/复现/还原/参考图）。
 * 它不决定段位，只决定规划阶段要不要把"跨来源检索"这张卡一起给出去。
 */
const REAL_REPRO_WORD = /(照片|相片|摄影|实拍|实景|复现|复原|还原|复刻|重建|测绘|参考图|对比图|photo|photograph|reproduce|reconstruct)/i
/**
 * 资产线索：场景里要靠"找/下一件件资产"补齐的东西（植物、雕刻、摆件、构件、素材、下载）。
 * 复杂雕刻与植物是"库内复用 > 跨来源扫描 > 获授权生成"的路线，不是"默认拿几何雕一个"。
 */
const ASSET_WORD = /(树木|树|植物|绿植|灌木|石狮|狮子|雕塑|雕像|摆件|门墩|构件|家具|匾额|水缸|假山|资产|素材|模型库|资源|下载|tree|plant|sculpture|statue|ornament|furniture|download|asset)/i

// 已有机器人动作与本体准备分开：泛「机器人」不能把左转/行走重新路由为下载。
// 明确下载/导入或建造环境的请求保留原路径；否定式「不要下载」不算准备授权。
const ROBOT_SUBJECT = /(机器人|机器狗|机械臂|人形|叉车|无人机|灵巧手|\b(?:g1|go2|robot|quadruped|humanoid|forklift|drone)\b)/i
const ROBOT_MOTION = /(左转|右转|转向|旋转|下降|下移|上升|上移|推(?:箱|物|动)|(?:向|往)(?:前|后|左|右)(?:走|行进|移动)|前进|后退|行走|走(?:路|两步|几步|到|过去|起来|[一二三四五六七八九十\d]+步)|移动|抓(?:取|起来)|搬(?:运|到)|抬起|起飞|降落|执行.{0,6}(?:动作|策略)|\b(?:walk|move|turn|drive|pick|grasp|lift|lower|descend|push|takeoff|land|execute)\b)/i
const ROBOT_PREPARATION = /(下载|导入|安装|获取|添加|加载|换一个|新建|创建|\b(?:download|import|install|fetch|load|add|spawn)\b)/i
// 本入口没有当前目标行为回执；名单/目录/policy缓存不能授权自动加载站立或自起身流程。
const ROBOT_POLICY_BEHAVIOR = /(站立|站起来|站起|起立|起身|翻身|自恢复|恢复站立|\b(?:stand|standing|rise|self[- ]right(?:ing)?|get[-\s]+up)\b)/i
function robotPolicyBehaviorRequest(text: string): boolean {
  const intent = findIntent(text, ROBOT_POLICY_BEHAVIOR)
  return (ROBOT_SUBJECT.test(text) || /\b(?:go1|a1|unitree_(?:g1|go1|go2|a1))\b/i.test(text))
    && Boolean(intent && !intent.negated)
}

function robotActionRequest(text: string): boolean {
  if (!ROBOT_SUBJECT.test(text)) return false
  const motion = findIntent(text, ROBOT_MOTION)
  const prepare = findIntent(text, ROBOT_PREPARATION)
  const build = findIntent(text, BUILD_VERB)
  return Boolean(motion && !motion.negated)
    && !(prepare && !prepare.negated)
    && !(ENV_NOUN.test(text) && build && !build.negated)
}

/**
 * 本仓随包装配的技能（`packages/lyapunov-shell/skills` + `packages/blender/skills`，由
 * `script/runtime-patch.ts` 的 `customSkillDirs` 装载）。技能目录不可读时只认这些；
 * 目录可读时以目录为准——目录里没有的技能名一律不当候选（"需要技能名但没接能力"就写缺口）。
 * environment-research / photo-reconstruction / unity-environment 已随包落盘（另线实现），
 * 这里只是登记**存在**这个事实，不重复它们的内容。
 */
const SHIPPED_SKILLS = new Set([
  "environment-planning",
  "environment-research",
  "photo-reconstruction",
  "unity-environment",
  "cad-import",
  "architectural-world",
  "environment-assets",
  "scene-construction",
  "asset-generation",
  "robot-provisioning",
  "action-execution",
  "benchmark-evaluation",
  "desktop-automation",
])

const STAGE_LABEL: Record<EnvironmentStage, string> = {
  new: "Create/rebuild",
  continue: "Continue existing work",
  local: "Local edit",
  "plan-only": "Plan only",
  stop: "Stop",
  none: "Not an environment task",
}

const SOURCE_LABEL: Record<EnvironmentInputSource, string> = {
  photo: "Photo",
  cad: "Drawing/CAD",
  text: "Text",
  mixed: "Mixed input",
  "existing-scene": "Existing scene",
  annotation: "3D viewport annotation",
  none: "None",
}

/**
 * ENV-02 简短场景规格的字段顺序（与 `skills/environment-planning/SKILL.md` 的计划字段一一对应）。
 * 这里只**登记骨架与已知值**：能从用户话里核对到的写值，其余显式写 `待确认`，绝不编造。
 */
export const SCENE_SPEC_FIELDS = ["purpose", "scope", "era", "scale", "objects", "style", "camera", "deliverables", "budget", "unknowns"] as const

/** 简短场景规格（ENV-02）。局部修改档的 `deliverables` 必须写明保留既有目标。 */
export interface BriefSceneSpec {
  readonly purpose: string
  readonly scope: string
  readonly era: string
  readonly scale: string
  readonly objects: string
  readonly style: string
  readonly camera: string
  readonly deliverables: string
  readonly budget: string
  /** 仍然未知、需要用户或检索补齐的字段（显式列出，不用空白冒充"已确认"）。 */
  readonly unknowns: readonly string[]
}

export interface BriefSceneSpecInput {
  readonly text: string
  readonly stage: EnvironmentStage
  readonly source: EnvironmentInputSource
  /** 消息点名或附件名里的环境对象（消息点名优先，无则 undefined）。 */
  readonly target?: string | undefined
  readonly sceneId?: string | undefined
  readonly annotation?: boolean | undefined
}

const SPEC_UNKNOWN = "Pending confirmation"
const SPEC_BUDGET_UNKNOWN = "Pending confirmation (time/cost/compute and stopping conditions)"
// 只从用户自己的话里取字段值；取不到就是未知项（ENV-02 的"未知项"字段负责如实登记）。
const SCOPE_WORD = /(室内|房间|单间|客厅|卧室|厨房|庭院|院子|园林|景观|街区|街道|城市|园区|厂房|仓库|车间|楼层|建筑|屋顶|外立面)/i
const ERA_WORD = /(民国|清代|明代|元代|宋代|唐代|汉唐|上世纪|\d{2}\s*年代|现代|当代|未来)/i
const STYLE_WORD = /(新中式|中式|日式|和风|欧式|古典|工业风|极简|简约|现代风|赛博|蒸汽朋克|地中海|乡村风)/i
const CAMERA_WORD = /(俯瞰|鸟瞰|俯视|航拍|正立面|立面视角|街景|人视|第一人称|轴测)/i
const PURPOSE_WORD = /(展示|展览|演示|汇报|拍摄|电影|游戏|关卡|教学|培训|评测|投标|宣传)/i

/**
 * 从用户话 + 输入来源 + 阶段合成**简短场景规格**（ENV-02）。纯函数、无状态：
 * - 值只来自用户原话（范围/年代/风格/机位/用途的词）与可核对的事实（输入来源、阶段、当前选择）；
 * - 尺度按输入来源分级：图纸=按标注，照片/混合=估计三级，纯文字=待确认；
 * - 交付按阶段：只方案=只交付计划；局部=场景增量且**保留既有目标**；继续=沿用当前计划与 jobId；
 * - 取不到的字段写 `待确认` 并进 `unknowns`，预算恒为待确认（时间/费用/算力与停止条件）。
 */
export function briefSceneSpec(input: BriefSceneSpecInput): BriefSceneSpec {
  const scope = input.text.match(SCOPE_WORD)?.[0]
  const era = input.text.match(ERA_WORD)?.[0]
  const style = input.text.match(STYLE_WORD)?.[0]
  const camera = input.text.match(CAMERA_WORD)?.[0]
  const purpose = input.text.match(PURPOSE_WORD)?.[0]
  const scale = input.source === "cad"
    ? "Use drawing dimensions; identify unmarked values as proportion-based estimates or modeling assumptions, not measurements."
    : input.source === "photo" || input.source === "mixed"
      ? "Estimate when no known scale reference exists; distinguish annotated values, derived estimates, and assumptions from measurements."
      : SPEC_UNKNOWN
  const deliverables = input.stage === "plan-only"
    ? "Plan only; no scene or asset output."
    : input.stage === "local"
      ? `Scene delta (preserve${input.sceneId ? ` ${input.sceneId} ` : ""}the existing target; do not rebuild the whole scene)`
      : input.stage === "continue"
        ? "Artifacts continuing the current plan and jobId"
        : "Scene viewable in the native Viewer, with save/reopen support"
  const objects = input.annotation
    ? "Component selected by the viewport annotation; preserve the same target"
    : input.target
      ? `${input.target}${input.source === "existing-scene" ? " (target in the existing scene)" : ""}`
      : SPEC_UNKNOWN
  const styleValue = style ?? SPEC_UNKNOWN
  const cameraValue = camera ?? SPEC_UNKNOWN
  const unknowns = [
    ...(purpose === undefined ? ["Purpose"] : []),
    ...(scope === undefined ? ["Scope"] : []),
    ...(era === undefined ? ["Era"] : []),
    ...(scale === SPEC_UNKNOWN ? ["Scale"] : []),
    ...(objects === SPEC_UNKNOWN ? ["Objects"] : []),
    ...(styleValue === SPEC_UNKNOWN ? ["Style"] : []),
    ...(cameraValue === SPEC_UNKNOWN ? ["Camera"] : []),
    "Budget",
  ]
  return {
    purpose: purpose ?? SPEC_UNKNOWN, scope: scope ?? SPEC_UNKNOWN, era: era ?? SPEC_UNKNOWN, scale,
    objects, style: styleValue, camera: cameraValue, deliverables, budget: SPEC_BUDGET_UNKNOWN, unknowns,
  }
}

/** 规格的一行注入文本（字段顺序固定；未知项显式列出，不编造）。 */
export function renderBriefSceneSpec(spec: BriefSceneSpec): string {
  return `Scene specification (ENV-02): purpose=${spec.purpose}; scope=${spec.scope}; era=${spec.era}; scale=${spec.scale}; objects=${spec.objects}; style=${spec.style}; camera=${spec.camera}; deliverables=${spec.deliverables}; budget=${spec.budget}; unknowns=${spec.unknowns.join("/") || "None"}`
}

interface ImageEvidence {
  readonly name: string | undefined
  readonly mediaType: string
  readonly width: number
  readonly height: number
}
interface FileEvidence {
  readonly name: string
  readonly bytes: number
}
interface MessageView {
  readonly sourceKind: string
  readonly text: string
  readonly images: readonly ImageEvidence[]
  readonly files: readonly FileEvidence[]
}

// 只有这两种来源算"用户说的话"：原生 `user`，以及本产品把 3D 视口批注投进会话用的
// `lyapunov-annotation`。其余来源（plugin/model/tool、自己注入的指针、将来别的插件自定义的
// 来源）一律不参与判定——宁可不判，也不替用户"假定"一条请求（与改动前的行为一致）。
const USER_SOURCES = new Set(["user", ANNOTATION_SOURCE])

/** 把一条真实 UserMessage 读成路由要用的形状：只认 text/image/file 三种内容块。 */
export function messageView(message: UserMessage): MessageView | undefined {
  const sourceKind = (message.source as { kind?: unknown } | undefined)?.kind
  if (typeof sourceKind !== "string" || !USER_SOURCES.has(sourceKind)) return undefined
  const images: ImageEvidence[] = []
  const files: FileEvidence[] = []
  const texts: string[] = []
  for (const block of message.content as readonly ContentBlock[]) {
    if (block.type === "text") texts.push(block.text)
    else if (block.type === "image") images.push({ name: block.attachment.name, mediaType: block.attachment.mediaType, width: block.attachment.width, height: block.attachment.height })
    else if (block.type === "file") files.push({ name: block.attachment.name, bytes: block.attachment.bytes })
  }
  return { sourceKind, text: texts.join("\n").trim(), images, files }
}

const fileKind = (name: string): "cad" | "drawing-image" | "other" => {
  const lower = name.toLowerCase()
  const extension = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : ""
  if (CAD_EXTENSIONS.has(extension)) return "cad"
  if (DRAWING_WORD.test(lower)) return "cad"
  if (DRAWING_FILE_EXTENSIONS.has(extension)) return "drawing-image"
  return "other"
}

const humanBytes = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)}KB` : `${bytes}B`)

/**
 * 附件事实：只报真实字段（名字、媒体类型、像素、字节数）。
 * 图片按**名字**分：名字里有图纸词的是图纸图，其余是照片；名字没有任何线索的图片不做更强声明
 * （不知道是照片还是图纸截图），这时以用户文字为准（见 `routeEnvironment` 的输入来源判定）。
 */
function attachmentFacts(images: readonly ImageEvidence[], files: readonly FileEvidence[]): { kind: EnvironmentInputSource; summary: string; envName: string | undefined } | undefined {
  const cadImages = images.filter(image => DRAWING_WORD.test(image.name ?? ""))
  const photos = images.filter(image => !cadImages.includes(image))
  const cadFiles = files.filter(file => fileKind(file.name) === "cad")
  const otherFiles = files.filter(file => fileKind(file.name) === "other" || fileKind(file.name) === "drawing-image")
  if (!images.length && !files.length) return undefined
  const parts: string[] = []
  if (photos.length) parts.push(`Photos: ${photos.length} (${photos[0]!.name ?? "Unnamed"} ${photos[0]!.mediaType} ${photos[0]!.width}×${photos[0]!.height})`)
  if (cadImages.length) parts.push(`Drawing images: ${cadImages.length} (${cadImages[0]!.name ?? "Unnamed"} ${cadImages[0]!.width}×${cadImages[0]!.height})`)
  if (cadFiles.length) parts.push(`Drawing files: ${cadFiles.length} (${cadFiles.map(file => `${file.name} ${humanBytes(file.bytes)}`).join(", ")})`)
  if (otherFiles.length) parts.push(`Other files: ${otherFiles.length} (${otherFiles.map(file => file.name).join(", ")})`)
  // ENV-01（N193）：`mixed` 只表示**照片与图纸同时在场**这一件事实。既非照片也非图纸的附件
  // （notes.txt 这类"其他文件"）不构成混合输入证据，也不该把 source 顶成 mixed
  // （那会让下面按 source==="cad"||"mixed" 注入的 `cad-import` 落到一个没有图纸的回合上）；
  // 没有任何照片/图纸证据时按纯文字处理（保持既有 `text` 语义，不新增枚举值）。
  const distinct = new Set<EnvironmentInputSource>()
  if (photos.length) distinct.add("photo")
  if (cadImages.length || cadFiles.length) distinct.add("cad")
  const kind: EnvironmentInputSource = distinct.size > 1 ? "mixed" : distinct.has("cad") ? "cad" : distinct.has("photo") ? "photo" : "text"
  // 文件名里的环境词也算环境线索（"厂房照片.jpg" 是，"error.png" 不是）。
  const envName = [...images.map(image => image.name ?? ""), ...files.map(file => file.name)].find(name => ENV_NOUN.test(name) || DRAWING_WORD.test(name))
  return { kind, summary: parts.join(" + "), envName: envName || undefined }
}

/** 会话任务依据：todo 投影的未完成项。`undefined`=投影不可读（如实登记），`null`=本会话没写过。 */
function todoFacts(todos: readonly TodoItem[] | null | undefined): { unfinished: readonly TodoItem[]; unfinishedEnv: readonly TodoItem[]; fact: string | undefined } {
  if (todos === undefined) return { unfinished: [], unfinishedEnv: [], fact: "The todo projection is unreadable; session work cannot be confirmed." }
  if (todos === null) return { unfinished: [], unfinishedEnv: [], fact: undefined }
  const unfinished = todos.filter(todo => todo.status !== "completed")
  // 只有**领域名词**（场景/仓库/图纸…）才算环境任务依据：todo 里出现 build/create 这类通用动词
  // 不能把"build web server"判成环境任务（主代理 2026-09-20 反例）。
  const unfinishedEnv = unfinished.filter(todo => ENV_NOUN.test(todo.content) || DRAWING_WORD.test(todo.content))
  const fact = `Session work: todo count=${todos.length}, unfinished=${unfinished.length}${unfinishedEnv.length ? `, environment-related=${unfinishedEnv.length}` : ""}${unfinished.length ? `（${unfinished.slice(0, 2).map(todo => `"${todo.content.slice(0, 24)}"`).join("")})` : ""}`
  return { unfinished, unfinishedEnv, fact }
}

/** 在文本里找意图词，并判断它是不是否定式（前 4 个字符内出现否定词）。 */
function findIntent(text: string, pattern: RegExp): { word: string; negated: boolean } | undefined {
  const match = pattern.exec(text)
  if (!match?.[0]) return undefined
  const before = text.slice(Math.max(0, (match.index ?? 0) - 4), match.index ?? 0)
  return { word: match[0], negated: NEGATION_BEFORE.test(before) }
}

/** 停止条件不等于当前停止；只在原Stop入口核对句内条件，其他阶段的词义/优先级保持。 */
function findStopIntent(text: string): { word: string; negated: boolean } | undefined {
  let negated: { word: string; negated: boolean } | undefined
  // 小数点两侧都是数字时不是句界，15.5分钟之类的预算须保持完整。
  const sentenceBoundary = /[。！？!?;；\n]|(?<!\d)\.|\.(?!\d)/
  for (const match of text.matchAll(new RegExp(STOP_INTENT.source, 'gi'))) {
    const before = text.slice(0, match.index).split(sentenceBoundary).at(-1) ?? ''
    const after = text.slice(match.index + match[0].length).split(sentenceBoundary, 1)[0] ?? ''
    const isNegated = NEGATION_BEFORE.test(before.slice(-4))
      || /\b(?:do\s+not|don['’]?t|must\s+not|should\s+not|never|no\s+need\s+to|without)\s*$/i.test(before)
    if (isNegated) { negated ??= { word: match[0], negated: true }; continue }
    const conditionalBefore = /(?:如果|假如|倘若|若(?!干)|一旦|只在|仅在|当[^，,]*?(?:时|后))|\b(?:if|unless|when|once)\b/i.test(before)
    const conditionalAfter = /^\s*(?:(?:if|unless|when|once|after|only\s+if)\b|at\s+\d|upon\s+reaching|如果|若(?!干)|一旦|当|(?:应|需要)?在[^。！？!?;；\n]*?(?:后|时))/i.test(after)
    const budgetBefore = /(?:连续|连着)\s*(?:\d+|[一二两三四五六七八九十百]+)\s*(?:轮|次|步)[^。！？!?;；\n]*?(?:应(?:当|该)?|需(?:要)?|须|就|再|则)(?:立即|马上)?\s*$/i.test(before)
      || /(?:达到|超过|耗尽|用完|预算|上限)[^。！？!?;；\n]*?(?:后|时|应(?:当|该)?|再|则|就)(?:立即|马上)?\s*$/i.test(before)
      || /\b(?:after|following)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i.test(before)
    const budgetAlreadyMet = /已经|已(?:连续|达到|超过|耗尽|用完|超时|失败)|\balready\b/i.test(before)
    // 检查当前进行状态并明确现在停止，不是未来预算；条件谓语须直接接立即Stop。
    const currentWorkNow = (
      /(?:如果|假如|倘若|若(?!干))\s*(?:这个|该|当前|本次)?\s*(?:场景|任务|作业)\s*(?:仍(?:然)?|还)?\s*(?:正在|在)\s*(?:生成|制作|构建|运行|执行)\s*[，,]\s*(?:(?:现在|此刻|立即|马上|立刻)\s*)*$/i.test(before)
      || /\bif\s+(?:(?:this|the|current)\s+)?(?:scene|task|job)\s+is\s+(?:still\s+)?(?:being\s+(?:generated|built)|generating|running|executing)\s*,\s*(?:(?:now|immediately)\s*)*$/i.test(before)
    ) && (
      /(?:现在|此刻|立即|马上|立刻)\s*$|\b(?:now|immediately)\s*$/i.test(before)
      || /^\s*(?:(?:it|this\s+(?:scene|task|job))\s+)?(?:now|immediately)\b/i.test(after)
    )
    if (conditionalBefore && !currentWorkNow || conditionalAfter || budgetBefore && !budgetAlreadyMet) continue
    return { word: match[0], negated: false }
  }
  return negated
}

/** 请求级选路提示，不创建任务或保存另一份生成状态。物体名字不决定生成式来源。 */
export function selectAssetGenerationRoute(text: string): AssetGenerationRoute | undefined {
  if (resourceOperationOnly(text) || robotActionRequest(text)) return undefined
  // 泛「生成」也用于代码/文本；这些请求继续交给原有域指针，不推断成三维产物。
  if (/(?:生成|创建|create|generate).{0,8}(?:代码|脚本|报告|文章|测试数据|网页|\b(?:code|script|report|text|website)\b)/i.test(text) && !/\b3d\b|三维|模型|资产/i.test(text)) return undefined
  const build = findIntent(text, BUILD_VERB)
  if (!build || build.negated) return undefined
  const nonBlender = /(?:不要|不用|别|禁止|非)\s*(?:用|使用)?\s*blender|(?:without|do\s+not\s+use|don'?t\s+use|not\s+using)\s+blender/i.test(text)
  const positiveChoice = (pattern: RegExp): boolean => [...text.matchAll(new RegExp(pattern.source,"gi"))].some(match => {
    const before = text.slice(Math.max(0,match.index! - 12),match.index)
    return !/[不别勿非无][^，,。；;]{0,3}$|(?:not|don'?t|do\s+not|without)\s*$/i.test(before)
  })
  const explicitWorldModel = positiveChoice(/(?:用|使用|选择|通过|走|换成|use|using|with|through)\s*(?:Pontryagin\s*(?:3D)?|生成式|文生\s*3D|图生\s*3D|AI\s*(?:生成|3D))|Pontryagin\s*(?:3D)?\s*(?:生成|generate)/i)
  const explicitBlender = positiveChoice(/(?:用|使用|选择|通过|走|换成|use|using|with|through)\s*blender|blender\s*(?:生成|建模|create|generate)/i)
  if (explicitWorldModel && explicitBlender) return { method: "mixed", why: "The user explicitly selected a mixed route: use Blender for regular geometry and Pontryagin 3D for generative parts. Acquire new artifacts for this task separately, then assemble them. Obtain the actual quote and one confirmation before the Pontryagin portion." }
  if (nonBlender || explicitWorldModel) return { method: "peiri3d", why: "The user explicitly selected a generative or non-Blender route: use Pontryagin 3D after reading the actual central quote and completing one native confirmation. Stop when configuration or a positive quote is missing; do not present old custom geometry as a new artifact." }
  if (explicitBlender) return { method: "blender", why: "The user explicitly selected Blender: create/edit and export for this task. Write and verify real Base Color, UV, textures/PBR as required; changing diffuse_color alone is insufficient." }
  // 尺寸只有与规则几何/参数化目标共同出现才构成 Blender 依据；有机资产也可以有目标尺度。
  const regular = /(地面|地板|台面|桌面|板材|箱|方块|立方体|长方体|盒子|圆柱|圆锥|管材|料架|工装|floor|ground|tabletop|countertop|cube|box|crate|cylinder|cone|pipe)/i.test(text)
  const parameterized = /(参数化|程序化|规则几何|精确(?:尺寸|几何)|可编辑|parametric|procedural|editable|precise geometry)/i.test(text)
  const appearance = /(真实(?:外观|质感|纹理)|逼真|写实|有机|自然外形|语义外形|realistic|photoreal|organic|natural shape)/i.test(text)
  const dimensions = /\d+(?:\.\d+)?\s*(?:mm|cm|m\b|米|厘米|毫米)|(?:长|宽|高|厚|半径|直径).{0,4}\d/i.test(text)
  const mixed = /(?:再|并且|同时|另外|以及|和|and|also).{0,24}(?:生成|做个|做一个|create|generate)/i.test(text)
  if ((regular || parameterized) && appearance && mixed) return { method: "mixed", why: "This combines regular geometry with semantic appearance: use Blender for precise parts and Pontryagin 3D for semantic or realistic assets. Acquire new artifacts separately, then assemble their scene relationships. Read the actual quote and obtain confirmation for paid work." }
  if (parameterized || regular && (!appearance || dimensions)) return { method: "blender", why: "For regular or parametric geometry, use Blender to preserve dimensions and editability. If materials are needed, write real Base Color and UV/texture connections, then export, register, mount, and observe." }
  return { method: "peiri3d", why: "For a new semantic asset or realistic appearance, use Pontryagin 3D. Set texture:true and pbr:true explicitly when textures/PBR are required. Read the actual central quote and obtain one confirmation first. Stop if configuration is missing; offer free public models only when they satisfy the user's source requirements." }
}

function assetRouteHint(route: AssetGenerationRoute | undefined, hasTool?: (name: string) => boolean, mcpTools?:readonly {name:string;description:string}[]): string {
  if (!route) return ""
  const blenderMcp=(mcpTools??[]).filter(tool=>/blender/i.test(tool.name+' '+tool.description)&&(!hasTool||hasTool(tool.name))).slice(0,6)
  const usesBlender=route.method==='blender'||route.method==='mixed'
  const blenderGuide=usesBlender?(blenderMcp.length?` Prefer an applicable tool from the currently discovered Blender MCP tools (${blenderMcp.map(v=>'`'+v.name+'`').join(', ')}); inspect its actual schema and editor/project state before invoking it. Use blender_run for a separate authorized batch script when the connected MCP cannot perform that operation.`:' No Blender MCP tool is currently visible. Read the native MCP configuration/connection state and report the concrete missing bridge, addon, endpoint, handshake, discovery, or scope. The authorized blender_run batch fallback remains usable when mounted; do not invent MCP tools.'):' '
  const tools = route.method === "peiri3d" ? ["generate_tripo"] : route.method === "mixed" ? [...blenderMcp.length?[]:["blender_run"],"generate_tripo"] : blenderMcp.length?[]:["blender_run"]
  const gap = hasTool && tools.some(tool=>!hasTool(tool)) ? " The selected generation interface is not mounted. Report the block explicitly; do not call an unavailable capability or silently switch sources." : ""
  return ` Generation route: ${route.why}${blenderGuide}${gap} Reuse the contract of already loaded skills without loading the same skill again. Do not repeat a request when server configuration and the quote have not changed.`
}

/**
 * 技能是否可用（"所有候选技能必须存在"的统一判据，路由与关键词补充都用它）：
 * - 目录里确实有 → 可用；
 * - 目录完整但目录里没有 → **确认缺失**；
 * - 目录不可读/不完整 → 只认本仓随包装配的 {@link SHIPPED_SKILLS}，不猜别的。
 */
export function skillAvailable(name: string, catalog?: SkillCatalogFact | undefined): boolean {
  if (catalog?.names.includes(name)) return true
  if (catalog?.complete) return false
  return SHIPPED_SKILLS.has(name)
}

/**
 * 判定一条消息（带附件与会话上下文）属于环境任务的哪个阶段、哪种输入来源。
 * 纯函数：不读服务、不写状态；调用方把真实字段喂进来，结果可被测试逐项核对。
 */
export function routeEnvironment(input: EnvironmentRoutingInput): EnvironmentRoutingDecision {
  const views = input.messages.map(messageView).filter((view): view is MessageView => view !== undefined)
  const trigger = views.at(-1)
  const text = trigger?.text ?? ""
  const images = views.flatMap(view => view.images)
  const files = views.flatMap(view => view.files)
  const annotation = views.some(view => view.sourceKind === ANNOTATION_SOURCE)
  const attachment = attachmentFacts(images, files)
  const todos = todoFacts(input.todos)
  const sceneId = typeof input.selection?.sceneId === "string" && input.selection.sceneId ? input.selection.sceneId : undefined
  const worldId = typeof input.selection?.worldId === "string" && input.selection.worldId ? input.selection.worldId : undefined
  const hasTool = input.hasTool ?? (() => false)
  const catalog = input.skillCatalog
  /** 确认缺失的技能：提示改成缺口的如实说明，而不是给出加载不出来的技能名。 */
  const skillExists = (name: string): boolean => skillAvailable(name, catalog)

  const envNoun = text.match(ENV_NOUN)?.[0]
  const namedDrawing = text.match(DRAWING_WORD)?.[0]
  // 环境证据：消息里的环境名词、附件名里的环境词、视口批注。**裸附件不算**——
  // "这张照片拍的是谁"配一张图不是环境任务，报错截图同理（主代理 2026-09-20 反例）。
  const messageEnv = Boolean(envNoun) || Boolean(attachment?.envName) || annotation
  // 会话里已在做环境任务：todo 未完成项点名了领域对象，或本步就是视口批注（批注天然是场景内修改）。
  const sessionEnvWork = annotation || todos.unfinishedEnv.length > 0
  // 资源路径可能包含 scene/build/modify 等词；它们不是用户意图，先从意图词扫描中移除。
  const intentText = text.replace(RESOURCE_PATH, "")
  const stop = findStopIntent(intentText)
  const plan = findIntent(intentText, PLAN_ONLY_INTENT)
  const cont = findIntent(intentText, CONTINUE_INTENT)
  const build = findIntent(intentText, BUILD_VERB)
  const modify = findIntent(intentText, MODIFY_VERB)

  // 输入来源（ENV-01）：批注 > 用户点名的图纸词 > 附件形态 > 已选场景的修改 > 纯文字。
  // 用户的话最明确（"这张平面图"就是图纸，哪怕附件名里看不出）；名字无线索的图片不硬说成
  // 照片（附件 kind 只登记"名字里有图纸词的是图纸图、其余按照片处理"这一层事实）。
  const source: EnvironmentInputSource = annotation
    ? "annotation"
    : namedDrawing
      ? "cad"
      : attachment
        ? attachment.kind
        : sceneId && !build
          ? "existing-scene"
          : "text"

  const facts: EnvironmentFacts = {
    attachmentKind: attachment?.kind,
    attachmentSummary: attachment?.summary,
    attachmentEnvName: attachment?.envName,
    namedDrawing,
    annotation,
    sceneId,
    worldId,
    sessionEnvironmentTodos: todos.unfinishedEnv,
    todosReadable: input.todos !== undefined,
    skillCatalogReadable: catalog !== undefined,
  }

  const evidence: string[] = []
  if (attachment) evidence.push(`Attachments=${attachment.summary}`)
  if (envNoun ?? namedDrawing ?? build?.word ?? modify?.word) evidence.push(`Message contains "${envNoun ?? namedDrawing ?? build?.word ?? modify?.word}"`)
  else if (attachment?.envName) evidence.push(`Attachment name contains "${attachment.envName}"`)
  if (todos.fact) evidence.push(todos.fact)
  if (sceneId) evidence.push(worldId ? "A scene and running world are selected in the workbench." : "A scene is selected in the workbench.")
  if (catalog && !catalog.complete) evidence.push("The skill catalog is incomplete; presence is evidence, but absence does not establish unavailability.")

  const planning = (why: string): EnvironmentPointerHint => skill("environment-planning", why)
  /** 技能提示：技能确实可用才给加载提示，否则如实说明缺口（不虚构能力）。 */
  const skill = (name: string, why: string): EnvironmentPointerHint =>
    skillExists(name) ? { kind: "skill", name, why } : { kind: "note", why: `Skill \`${name}\` is not in the mounted catalog. Report the missing capability rather than claiming it is available.` }
  const append = (hints: readonly EnvironmentPointerHint[], hint: EnvironmentPointerHint): EnvironmentPointerHint[] => [...hints, hint]
  /**
   * ENV-03：提示里点名的工具必须是**当前真的可见**的。`hasTool` 读的是原生工具注册表这一只读事实，
   * 不另建能力表；"知道工具名"不等于"后端可用"，缺的必须按既有 note 口径如实说明缺口
   * （与 `skill()`、停止入口同一写法），不能让提示把不可用能力说成可以做。
   * 调用方**没给**可见性事实时返回空表：不据此断言工具缺失（与技能目录不可读时同一条保守口径）。
   */
  const missingTools = (names: readonly string[]): string[] =>
    input.hasTool === undefined ? [] : names.filter(name => !hasTool(name))
  /** 缺件说明（ENV-03 口径）：只点名真正不可见的能力；措辞只此一份（plan-only/local/new 共用）。 */
  const capabilityGapNote = (names: readonly string[]): string => {
    const missing = missingTools(names)
    return missing.length ? `. The current instance has no visible ${missing.join("/")} tools. Report these capability gaps when needed rather than claiming availability.` : ""
  }

  // 规划阶段的**伴随契约**（2026-09-20 真实回合复盘）。真实回合里模型只查了一个目录
  // （PolyHaven）没命中中式石狮，就写下"石狮不可下载 → Blender 分件雕刻为主"，且全程没读过
  // environment-research / asset-generation。所以：现实复现（真实现场/照片/参考图）与多资产混合
  // 的任务，计划阶段必须把"跨来源检索"与"资产路线"两张卡一起给出去。它们进的是**阶段提示**，
  // 不占关键词补充的额度，也不会被泛 scene 关键词挤掉（见 `planDomainPointers`）。
  // 用 `source`（已按"用户点名的图纸词 > 附件形态"排过序）而不是裸的附件形态：用户说"这张平面图"
  // 时不要因为附件名像照片就按现实复现给卡（附件名只是线索）。
  const realistic = source === "photo" || source === "mixed" || REAL_REPRO_WORD.test(text)
  const assetHeavy = attachment?.kind === "mixed" || ASSET_WORD.test(text)
  /** 「补什么参考」的唯一一份文案：new／plan-only 与**局部档**（ENV-54）共用，避免两处漂移。 */
  const RESEARCH_CONTRACT = "Search and check sources when information is missing. A miss in one catalog establishes only that catalog miss, not that the asset is unavailable everywhere. Continue from evidence needed for the current decision, the user's budget, and new information; do not require a universal search count or exhaustion of all sources before starting."
  const planningCompanions = (): EnvironmentPointerHint[] => {
    const companions: EnvironmentPointerHint[] = []
    if (source === "cad" || source === "mixed") companions.push(skill("cad-import", "Read drawing dimensions, topology, and units first; do not invent them."))
    else if (realistic) companions.push(skill("photo-reconstruction", "Follow the photo reconstruction contract: distinguish viewpoints, scale, and unknown back surfaces, and do not treat inference as established fact."))
    if (realistic) companions.push(skill("environment-research", RESEARCH_CONTRACT))
    if (assetHeavy) companions.push(skill("asset-generation", "Select a route using the user's source/provider requirements, quality, editability, availability, and cost. Existing-library reuse, public assets, task scripts, and authorized generation are candidates. Do not impose one provider or require exhaustive retrieval before making an asset."))
    return companions
  }

  // 阶段判定（保守合成，顺序即优先级）：
  // 只给方案 > 停止（否定式不算）> 继续（必须有既有环境任务）> 局部（有修改动词）> 新建（有建造动词）> 不猜。
  let stage: EnvironmentStage = "none"
  let matchedWord: string | undefined
  let hints: EnvironmentPointerHint[] = []
  const decided = (next: EnvironmentStage, hit: { word: string; negated: boolean }, why: readonly EnvironmentPointerHint[]): void => {
    stage = next
    matchedWord = hit.word
    hints = [...why]
  }
  if (!annotation && resourceOperationOnly(text)) {
    // 已有资源操作不授权建模；保留附件、选择等事实，不产生环境阶段或场景规格。
  } else if (plan && !plan.negated && (messageEnv || sessionEnvWork)) {
    // 只读调研与制作路径点名的工具按真实可见性收口（ENV-03）：缺了就在提示里说缺，不显示成可完成。
    const capabilityGap = capabilityGapNote(["web_search", "web_fetch", "blender_run", "scene_edit"])
    decided("plan-only", plan, [
      planning(`Return only a plan; do not call fabrication tools or paid generation. Follow native plan mode without requiring todo_write. Identify necessary unknowns, route, budget, and acceptance for the goal. Authorized read-only research is allowed when evidence is missing; do not claim resources are unavailable without searching.${capabilityGap}`),
      ...planningCompanions(),
    ])
  } else if (stop && !stop.negated && (messageEnv || sessionEnvWork)) {
    const stopTools = ["sim_stop", "robot_stop", "job_kill"].filter(name => hasTool(name)).slice(0, MAX_POINTERS)
    decided("stop", stop, stopTools.length
      ? stopTools.map(name => ({ kind: "tool" as const, name, why: name === "job_kill" ? "Cancel the long Job immediately without waiting for planning or starting it again." : "Stop the action immediately without waiting for planning." }))
      : [{ kind: "note", why: "Stop immediately without waiting for planning. No stop interface (sim_stop/robot_stop/job_kill) is visible; report this and provide a feasible alternative." }])
  } else if (!annotation && robotActionRequest(text)) {
    // 「机器人在场景里移动」的场景只是动作所在世界，不是 scene_edit 的授权。
  } else if (cont && !cont.negated && sessionEnvWork) {
    let why = [planning("Reuse the current plan and jobId without replanning. Preserve the source project, scene, and references; history and native todo/Job remain authoritative. Read status for unconfirmed effects before retrying. Continuing does not require reloading a known contract.")]
    if (attachment?.kind === "cad" || namedDrawing) why = append(why, skill("cad-import", "Incorporate the newly supplied drawing into the existing plan under the drawing contract, without changing confirmed dimensions."))
    decided("continue", cont, why)
  // ENV-58：路由输入包含**选择**——已选场景 + 修改动词就是既有的「已有场景就地修改」路径
  // （下面 `sceneId` 分支本来就是为它写的）。此前证据闸只有 messageEnv||sessionEnvWork，于是
  // "已选场景 + 只说改什么（消息里没有环境名词）"会被记成 no-evidence，那条分支永远走不到。
  } else if (modify && !modify.negated && (messageEnv || sessionEnvWork || Boolean(sceneId))) {
    let why: EnvironmentPointerHint[] = [{ kind: "note", why: `Handle a local edit through its target, action, and review result; do not require a full environment plan or rebuild the whole scene. First identify the affected component with scene_inspect or another real query when entityId is missing; do not guess. Resolve reference gaps as needed${capabilityGapNote(["scene_edit"])}` }]
    if (annotation) why = append(why, input.hasTool === undefined || hasTool("scene_edit")
      ? skill("scene-construction", "Use an in-scene scene_edit for an annotation when it can perform the local edit; do not return to Blender.")
      : { kind: "note", why: "An annotation-based local edit requires scene_edit, which is not currently visible. Report the missing capability rather than claiming availability." })
    // ENV-01「已有场景修改」是与"新建/照片/CAD"并列的一条路径：已选场景 + 修改动词时，
    // 就地改既有场景（保留同一目标与版本），不要回 Blender 重做全场。
    else if (sceneId) why = append(why, skill("scene-construction", "Edit an existing scene locally with scene_edit. Preserve the selected target and version rather than rebuilding the whole scene."))
    if (source === "cad") why = append(why, skill("cad-import", "Edit only components marked in the drawing; label missing values as assumptions."))
    // 只有照片复现等确有参考需求的局部任务才建议检索，不让选择变化级联加载教程。
    if (realistic) why = append(why, skill("environment-research", RESEARCH_CONTRACT))
    decided("local", modify, why)
  } else if (build && !build.negated && messageEnv) {
    decided("new", build, [
      planning(`For creation or a full rebuild, plan as needed for complexity under native plan mode and the user's execution authorization. A simple operation does not require a complete form or prior search; choose fabrication and acceptance steps according to actual needs${capabilityGapNote(["blender_run", "scene_edit"])}`),
      ...planningCompanions(),
    ])
  }

  // 被拒的意图：命中了词但没成立——否定式（不要停止）或缺环境证据（"继续"但会话里没有环境任务）。
  // 登记下来，回执与门禁都能核对"为什么没按它走"，而不是只看最终段位猜。
  const rejected: RejectedIntent[] = []
  const candidates: { stage: EnvironmentStage; hit: { word: string; negated: boolean } | undefined; evidence: boolean }[] = [
    { stage: "plan-only", hit: plan, evidence: messageEnv || sessionEnvWork },
    { stage: "stop", hit: stop, evidence: messageEnv || sessionEnvWork },
    { stage: "continue", hit: cont, evidence: sessionEnvWork },
    { stage: "local", hit: modify, evidence: messageEnv || sessionEnvWork || Boolean(sceneId) },
    { stage: "new", hit: build, evidence: messageEnv },
  ]
  for (const candidate of candidates) {
    if (!candidate.hit || candidate.stage === stage) continue
    if (candidate.hit.negated) rejected.push({ stage: candidate.stage, word: candidate.hit.word, reason: "negated" })
    else if (!candidate.evidence) rejected.push({ stage: candidate.stage, word: candidate.hit.word, reason: "no-evidence" })
  }

  const intent: EnvironmentIntent = { stage, word: matchedWord, rejected }
  // ENV-02：环境档（none/stop 除外）产出简短场景规格；值只来自用户原话与可核对事实，其余进未知项。
  const spec = stage === "none" || stage === "stop"
    ? undefined
    : briefSceneSpec({ text, stage, source, target: envNoun ?? namedDrawing, sceneId, annotation })
  return { stage, inputSource: stage === "none" ? "none" : source, evidence: evidence.slice(0, 3), hints: hints.slice(0, MAX_STAGE_HINTS), matched: matchedWord, facts, intent, spec }
}

const hintLine = (hint: EnvironmentPointerHint): string =>
  hint.kind === "skill" ? `- Read skill \`${hint.name}\` for the operation contract: ${hint.why}` : hint.kind === "tool" ? `- Use tool \`${hint.name}\`：${hint.why}` : `- ${hint.why}`

/** 收尾一句：无论提示由谁拼接，它都必须是**最后一行**（`planDomainPointers` 负责追加）。 */
export const POINTER_FOOTER = "Guidance applies only to the current next step. Do not load every skill; reuse a visible contract of the same version. Permissions do not change. Ignore guidance that does not apply."

/** 环境提示正文（表头 + 提示行 + ENV-02 场景规格行，**不含**收尾句）；`none` 阶段返回 undefined。 */
export function renderEnvironmentPointer(decision: EnvironmentRoutingDecision): string | undefined {
  if (decision.stage === "none") return undefined
  // 命中词与页面状态行同一套措辞（`workbench.tsx` 的 `环境路由：<档位>（命中「…」）`）：
  // 少了它，模型只看得到「依据：消息含「改」」这类**词表证据**，看不出真正定档的是哪个词
  // （DEV-019 真实回合：插话里"停下"定成 [停止]，卡上却只写「改」，模型据此判成误判并自己找理由）。
  const header = `Environment task route: [${STAGE_LABEL[decision.stage]}]${decision.matched ? ` (matched "${decision.matched}")` : ""}; input source=[${SOURCE_LABEL[decision.inputSource]}]${decision.evidence.length ? `; evidence: ${decision.evidence.join("; ")}` : ""}`
  const lines = [header, ...decision.hints.map(hintLine)]
  // 规格结构仍供调用方核对；局部/继续档不重复贴十个待确认字段。
  if (decision.spec && (decision.stage === "new" || decision.stage === "plan-only")) lines.push(renderBriefSceneSpec(decision.spec))
  return lines.join("\n")
}

/**
 * pre-step 的实际注入规划：环境路由（阶段提示在前）+ 关键词表补充。
 * 阶段提示有独立预算 {@link MAX_STAGE_HINTS}（≤4 行），关键词补充只在阶段提示占不满
 * {@link MAX_POINTERS} 行时才补位——所以"跨来源检索/资产路线"这类伴随契约不会被泛 scene
 * 关键词挤掉。返回 undefined 表示这一轮不注入任何消息。
 *
 * 关键词表仍是 `plugin.ts` 里的同一份（门禁 `script/gates/domain-pointers.ts` 从源码解析），
 * 这里只决定**顺序与取舍**：环境判定给出阶段与输入来源，压过"命中文本靠前的两条"。
 */
export function planDomainPointers(input: EnvironmentRoutingInput & { readonly pointers: readonly DomainPointer[] }): DomainPointerPlan | undefined {
  const decision = routeEnvironment(input)
  const views = input.messages.map(messageView).filter((view): view is MessageView => view !== undefined)
  const text = views.at(-1)?.text ?? ""
  // 条目可用性：技能类看技能目录（`skillAvailable`），工具类看工具可见性（`ui_action` 是工具，不是技能）。
  const pointerAvailable = (pointer: DomainPointer): boolean => (pointer.tool ? (input.hasTool ? input.hasTool(pointer.skill) : true) : skillAvailable(pointer.skill, input.skillCatalog))
  // 提到机器人不等于准备/下载本体；局部场景编辑与已装机器人动作不注入准备流程。
  const pointerRelevant=(pointer:DomainPointer):boolean=>pointer.pattern.test(text)&&(pointer.skill!=='robot-provisioning'||Boolean(findIntent(text,ROBOT_PREPARATION)&&!findIntent(text,ROBOT_PREPARATION)?.negated))
  const assetRoute = selectAssetGenerationRoute(text)
  const manualControl = findIntent(text, /(手动|\bmanual(?:ly)?\b)/i)
  const directMotion = findIntent(text, ROBOT_MOTION)
  const usesDirectControl = Boolean(manualControl && !manualControl.negated)
    || (/(关节|夹爪|tcp|\b(?:joint|gripper)\b)/i.test(text) && Boolean(directMotion && !directMotion.negated))
  if (decision.stage !== 'stop' && robotPolicyBehaviorRequest(text) && !usesDirectControl) {
    const stop = findStopIntent(text)
    if (stop && !stop.negated) return undefined
    const acquisition = findIntent(text, ROBOT_PREPARATION)
    const line = acquisition && !acquisition.negated
      ? "This explicitly requests source acquisition for a robot behavior. Use the body's official website or official repository as source metadata. Resolve source, interface, or error uncertainty with Browser Use keyword search and official pages, WebFetch for a known URL, and Bash for necessary acquisition; public research does not require a regional or adapted endpoint. Report the actual source revision and missing requirements. Do not automatically load provisioning or remote capability context or recommend a full bundle. Catalog/T0/downloaded/PREPARED/MATCHED or short inference does not verify behavior; use the client's actual simulation readback."
      : "This requests standing or self-righting with the current robot. No target-specific adaptation or behavior receipt is provided to this routing step. Do not automatically load provisioning or remote catalog/policy capability context or recommend downloading a full bundle. Inspect the actual current body, runtime, world, and behavior evidence through client simulation interfaces. Server source metadata does not report actual robot behavior; downloaded/PREPARED/MATCHED or short inference does not prove it. For uncertain source, interface, or error facts, use Browser Use keyword search and official pages, WebFetch for a known URL, and Bash when acquisition is necessary; resolve new evidence before repeating a failed action."
    return { text: line, decision, injected: [] }
  }
  if (decision.stage === "none") {
    // 非环境消息：与既有行为一致（只扫最新一条用户消息，命中前两条）；能力可核对时同守"不虚构"。
    if (!text) return undefined
    if (robotActionRequest(text)) {
      const action = skillAvailable("action-execution", input.skillCatalog)
      const line = action
        ? "This requests an action with an existing robot. Read action-execution through the skill tool for its contract. Check the current robot, running world, and prepared policy, reusing assets and Jobs. Do not download another body for an action. Identify a missing execution chain explicitly; visual translation does not establish walking."
        : "This requests a robot action rather than a body download. action-execution is not visible in the current catalog. Check the existing robot, world, and policy through visible interfaces, report execution gaps, and do not repeat a download."
      return { text: line, decision, injected: action ? ["action-execution"] : [] }
    }
    const hits = input.pointers.filter(pointer => pointerRelevant(pointer) && pointerAvailable(pointer)).slice(0, 2)
    if (!hits.length) return undefined
    const lines = hits.map(hit => (hit.tool ? `This may involve ${hit.label}: use tool \`${hit.skill}\` directly for interface control. Ignore this guidance if it does not apply.` : `This may involve ${hit.label}: read skill \`${hit.skill}\` for the operation contract. Ignore this guidance if it does not apply.`) + (hit.skill === "asset-generation" ? assetRouteHint(assetRoute,input.hasTool,input.visibleMcpTools) : ""))
    return { text: lines.join("\n"), decision, injected: hits.map(hit => hit.skill) }
  }
  const envText = renderEnvironmentPointer(decision)?.split("\n").map(line => line.includes("`asset-generation`") ? line + assetRouteHint(assetRoute,input.hasTool,input.visibleMcpTools) : line).join("\n")
  const used = new Set(decision.hints.flatMap(hint => (hint.name ? [hint.name] : [])))
  // 停止档不加关键词补充：这一轮只该停，不该顺带推荐"可用某技能"（否则模型会先去加载技能）。
  // 补充也守"技能必须存在"：目录确认缺失的技能名不注入（不给人加载不出来的建议）。
  const supplements = text && decision.stage !== "stop"
    ? input.pointers.filter(pointer => pointerRelevant(pointer) && !used.has(pointer.skill) && pointerAvailable(pointer)).slice(0, Math.max(0, MAX_POINTERS - decision.hints.length))
    : []
  const supplementLines = supplements.map(hit => `- Use ${hit.tool ? "" : "skill "}tool to read \`${hit.skill}\` for the operation contract: ${hit.label}` + (hit.skill === "asset-generation" ? assetRouteHint(assetRoute,input.hasTool,input.visibleMcpTools) : ""))
  const body = [envText, ...supplementLines, POINTER_FOOTER].join("\n")
  return { text: body, decision, injected: [...decision.hints.flatMap(hint => (hint.name ? [hint.name] : [])), ...supplements.map(hit => hit.skill)] }
}
