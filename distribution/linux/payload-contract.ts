/**
 * 发行载荷结构契约（DEV-020，2026-09-26）：
 *  ① 载荷**顶层只允许一个可执行入口** `lyapunov`。留两个可执行入口 = 同一份运行根存在两个
 *     可启动的旧/新 owner，升级与回退都会变成"谁最后启动谁改托管链接"。
 *  ② `distribution/providers/graspgenx/` 是**随产品分发**的可选 Provider 定义（用户据此自建 worker），
 *     必须真的进载荷；`RELEASE.json.providersBundled` 必须如实登记它，不能报空清单。
 *
 * 入口、Provider 与链接判据是纯函数；沙箱依赖判据直接读取真实 staging 中的文件。
 * `script/package-linux.ts` 在归档前调用，违约即 fail-closed。负对照见 `payload-contract.test.ts`。
 */
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'

/** canonical 来源与载荷逻辑位置分开：借用只读SDK symlink也保持锁定的 .upstream 布局。 */
export function workspacePayloadDestination(input:{root:string;upstreamReal:string;upstreamDirectory:string;source:string}):string|null{
  const safeRelative=(path:string)=>path!==''&&!isAbsolute(path)&&!path.split('/').some(part=>part==='..'||part===''||part==='.')
  if(!safeRelative(input.upstreamDirectory))throw Error(`SDK逻辑载荷根不安全：${input.upstreamDirectory}`)
  const upstreamInside=relative(input.upstreamReal,input.source),productInside=relative(input.root,input.source)
  const child=(path:string)=>safeRelative(path)&&!path.split('/').includes('node_modules')
  // SDK先按真实边界识别；即使它借用到本仓packages下面，目标仍由锁定逻辑根唯一决定。
  const destination=child(upstreamInside)?join(input.upstreamDirectory,upstreamInside)
    :productInside.startsWith('packages/')&&child(productInside)?productInside:null
  if(destination!==null&&!safeRelative(destination))throw Error(`workspace载荷目标越界：${destination}`)
  return destination
}

/** 产品在发行载荷里的唯一顶层可执行入口名。 */
export const PRODUCT_ENTRY = 'lyapunov'

/** 顶层条目读数：`directory` 与 `executable` 都取自真实 staging 的 lstat/stat。 */
export interface PayloadTopLevelRow {
  name: string
  directory: boolean
  executable: boolean
}

/**
 * 顶层入口契约。返回空数组＝契约成立。
 * 目录即使带执行位（0755 目录）也不算入口：只有**普通文件**的可执行位才算可启动入口。
 */
export function entryViolations(rows: readonly PayloadTopLevelRow[]): string[] {
  const executables = rows.filter(row => !row.directory && row.executable).map(row => row.name).sort()
  const violations: string[] = []
  if (!executables.includes(PRODUCT_ENTRY)) violations.push(`顶层缺少可执行入口 ${PRODUCT_ENTRY}`)
  const extra = executables.filter(name => name !== PRODUCT_ENTRY)
  if (extra.length) violations.push(`顶层出现第二个可执行入口：${extra.join('、')}`)
  return violations
}

/**
 * 随包可选 Provider 定义契约：`present` 是"定义名 → 实际拷进载荷的文件数"。
 * 缺失或空目录都算违约（空目录等于把 README 指向的 `provider.sh` 入口发成不存在）。
 */
export function bundledProviderViolations(input: { required: readonly string[]; present: ReadonlyMap<string, number> }): string[] {
  const violations: string[] = []
  for (const name of input.required) {
    const files = input.present.get(name)
    if (files === undefined) violations.push(`随包 Provider 定义缺失：${name}`)
    else if (files <= 0) violations.push(`随包 Provider 定义为空：${name}`)
  }
  return violations
}

/** doctor、desktop 与 setup-sandbox 在发行包中共享的实际入口文件。 */
const SANDBOX_RUNTIME_FILES = ['lyapunov', 'distribution/linux/doctor.mjs', 'distribution/linux/sandbox.mjs'] as const

/** 在真实 staging 中逐件核验；缺文件、目录或符号链接均不能冒充可运行模块。 */
export function sandboxRuntimeViolations(stage: string): string[] {
  const violations: string[] = []
  for (const file of SANDBOX_RUNTIME_FILES) {
    try {
      if (!lstatSync(join(stage, file)).isFile()) violations.push(`发行载荷缺少 doctor/desktop/setup-sandbox 必需文件：${file}`)
    } catch {
      violations.push(`发行载荷缺少 doctor/desktop/setup-sandbox 必需文件：${file}`)
    }
  }
  return violations
}

/** 项目许可、原文件、内联消费方worker和运行产物都须进入同一个发行根。 */
export const PRODUCT_RUNTIME_FILES = [
  'LICENSE',
  'NOTICE',
  'runtime/electron/chrome-sandbox',
  'packages/sim-isaac/python/worker.py',
  'packages/sim-isaac/python/collision_topology.py',
  'packages/sim-mujoco/python/collision_topology.py',
  'packages/asset-bake/src/bake.py',
  'packages/asset-bake/dist/bake.py',
  'packages/asset-bake/requirements.txt',
  'packages/asset-bake/requirements-isaac.txt',
  'packages/asset-bake/requirements-common.txt',
  'packages/scene-kit/dist/bake.py',
  'packages/robot-workflows/dist/plugin.js',
  'packages/blender/src/world.py',
  'packages/blender/dist/world.py',
  'packages/lyapunov-workspace/src/model-convert.ts',
  'packages/lyapunov-workspace/dist/plugin.js',
  'packages/lyapunov-workspace/dist/client.js',
  'packages/viewer/dist/client.js',
  'packages/lyapunov-shell/dist/client.js',
  'packages/desktop/dist/main.js',
  'packages/desktop/renderer/account.js',
  'packages/desktop/icons/lyapunov.png',
  'distribution/linux/lyapunov-desktop.desktop.in',
  'distribution/linux/install.sh',
  'distribution/linux/install-entry.mjs',
] as const

/** 只核真实staging载荷；存在源码不能替代缺失的运行worker或已构建SDK。 */
export function productRuntimeViolations(stage:string,upstreamDirectory:string):string[]{
  const files=[...PRODUCT_RUNTIME_FILES,
    join(upstreamDirectory,'packages/llm/llm-pi-ai/lib/index.js'),
    join(upstreamDirectory,'packages/client/ui-conversation/lib/client.js'),
  ]
  const violations:string[]=[]
  const available=new Set<string>()
  for(const file of files){
    try{
      const row=lstatSync(join(stage,file))
      if(row.isFile()&&row.size>0){available.add(file);continue}
    }catch{}
    violations.push(`发行载荷缺少非空${file==='LICENSE'||file==='NOTICE'?'项目许可':'物理/材质/桌面运行'}文件：${file}`)
  }
  const common='packages/asset-bake/requirements-common.txt'
  if(available.has(common)&&!/^coacd==1\.0\.7\s*$/m.test(readFileSync(join(stage,common),'utf8')))
    violations.push('发行载荷的asset-bake公共requirements未声明coacd==1.0.7')
  for(const file of ['packages/asset-bake/requirements.txt','packages/asset-bake/requirements-isaac.txt'])
    if(available.has(file)&&!/^\s*-r\s+requirements-common\.txt\s*$/m.test(readFileSync(join(stage,file),'utf8')))
      violations.push(`发行载荷的几何依赖未引用公共requirements：${file}`)
  const desktop='distribution/linux/lyapunov-desktop.desktop.in',main='packages/desktop/dist/main.js'
  if(available.has(desktop)&&!/^StartupWMClass=lyapunov-desktop\s*$/m.test(readFileSync(join(stage,desktop),'utf8')))
    violations.push('发行载荷desktop entry的StartupWMClass未与lyapunov-desktop配对')
  if(available.has(main)&&!readFileSync(join(stage,main),'utf8').includes('lyapunov-desktop.desktop'))
    violations.push('发行载荷的桌面main未包含同名lyapunov-desktop.desktop身份')
  const conversation=join(upstreamDirectory,'packages/client/ui-conversation/lib/client.js')
  if(available.has(conversation)&&!readFileSync(join(stage,conversation),'utf8').includes('conversation.hero.headline'))
    violations.push('发行载荷的私有SDK未构建conversation.hero.headline品牌插槽')
  return violations
}

/**
 * 载荷内符号链接的落点判定（`inside` 是链接真实目标相对**当前复制根**的路径）。
 * - 自指（`inside` 为空／`.`，链接解析回复制根自身）⇒ 返回 `null`：没有可交付语义
 *   （写进载荷只是自环，直接 `symlink('')` 会 ENOENT），调用方跳过并记账；
 * - 越界 ⇒ 抛错 fail-closed（发行包不得携带指向包外的链接）；
 * - 包内 ⇒ 返回应写出的相对链接目标。
 */
export function payloadLinkTarget(input: { inside: string; destination: string; dest: string; source: string }): string | null {
  if (input.inside === '' || input.inside === '.') return null
  if (input.inside === '..' || input.inside.startsWith('../') || isAbsolute(input.inside)) throw new Error(`包内容存在未声明外部符号链接：${input.source}`)
  return relative(dirname(input.dest), join(input.destination, input.inside))
}
