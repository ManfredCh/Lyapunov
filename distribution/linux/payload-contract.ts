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
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative } from 'node:path'

/** Linux x64 glibc 发行进程首次获取文件锁时加载的固定 SDK addon。 */
export const NATIVE_SYSTEM_GLIBC_ADDON = 'native/system/packages/linux-x64/bin/glibc/system.node'

/** 与上游 prepack 同口径核验必需 addon 的普通文件、ELF 架构及 Node-API 入口。 */
export function nativeSystemRuntimeViolations(stage: string, upstreamDirectory: string): string[] {
  const file = join(upstreamDirectory, NATIVE_SYSTEM_GLIBC_ADDON)
  let data: Buffer
  try {
    if (!lstatSync(join(stage, file)).isFile()) throw new Error('不是普通文件')
    data = readFileSync(join(stage, file))
  } catch {
    return [`发行载荷缺少 Linux x64 glibc 文件锁原生模块：${file}`]
  }
  if (data.length < 64 || data.readUInt32LE(0) !== 0x464c457f || data[4] !== 2 || data[5] !== 1)
    return [`发行载荷文件锁原生模块不是小端 ELF64：${file}`]
  if (data.readUInt16LE(18) !== 62 || data.readUInt16LE(16) !== 3)
    return [`发行载荷文件锁原生模块不是 Linux x64 共享库：${file}`]
  if (!data.includes(Buffer.from('napi_register_module_v1')) || !data.includes(Buffer.from('node_api_module_get_api_version_v1')))
    return [`发行载荷文件锁原生模块缺少 Node-API 入口：${file}`]
  const unsupported = [...new Set([...data.toString('latin1').matchAll(/GLIBC_(\d+)\.(\d+)(?:\.\d+)?/g)]
    .filter(row => Number(row[1]) > 2 || Number(row[1]) === 2 && Number(row[2]) > 28).map(row => row[0]))]
  return unsupported.length ? [`发行载荷文件锁原生模块超过最低 glibc 2.28：${file}（${unsupported.join('、')}）`] : []
}

/** 原生工作台首页与它直接引用的本地启动资源必须是真正构建的非空文件。 */
export function frontendRuntimeViolations(stage:string,upstreamDirectory:string):string[]{
  const prefix=join(upstreamDirectory,'apps/web/dist'),index=join(prefix,'index.html')
  const nonempty=(file:string)=>{try{const row=lstatSync(join(stage,file));return row.isFile()&&row.size>0}catch{return false}}
  if(!nonempty(index))return [`发行载荷缺少非空原生工作台前端首页：${index}`]
  const html=readFileSync(join(stage,index),'utf8'),violations:string[]=[]
  const moduleScripts=[...html.matchAll(/<script\b[^>]*\btype\s*=\s*["']module["'][^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map(row=>row[1]!)
  if(moduleScripts.length===0)violations.push(`原生工作台前端首页缺少构建后的module入口：${index}`)
  const resources=[...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi)].map(row=>row[1]!)
  for(const resource of new Set(resources)){
    if(/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(resource))continue
    const path=resource.split(/[?#]/,1)[0]!.replace(/^\//,'')
    const file=join(prefix,path)
    if(!nonempty(file))violations.push(`发行载荷缺少非空原生工作台前端启动资源：${file}`)
  }
  return violations
}

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
  '.runtime/computer-use-linux/bin/computer-use-linux',
  '.runtime/computer-use-linux/bin/computer-use-linux-cosmic',
  '.runtime/computer-use-linux/bin/computer-use-linux-indicator',
  '.runtime/computer-use-linux/LICENSE',
  '.runtime/computer-use-linux/provenance.json',
  '.runtime/computer-use-linux/official/computer-use-linux',
  '.runtime/computer-use-linux/atspi-bus.patch',
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
  'packages/desktop/renderer/fonts/NotoSansSC-Regular.otf',
  'packages/desktop/renderer/fonts/lyapunov-fonts.css',
  'packages/desktop/renderer/fonts/OFL.txt',
  'packages/desktop/renderer/fonts/NOTICE.txt',
  'packages/desktop/renderer/fonts/SOURCES.json',
  'packages/desktop/renderer/fonts/fonts.conf',
  'packages/desktop/icons/lyapunov.png',
  'distribution/linux/lyapunov-desktop.desktop.in',
  'distribution/linux/install.sh',
  'distribution/linux/install-entry.mjs',
  // 通用 Kit 大缓存（isaacsim-extscache-kit 6.0.1.0，约 5.88GB）的固定 pin 与分段续传 helper：
  // 需随包分发；helper 只按 pin 的长度/SHA256 校验并把已验证本地 wheel 交给 pip。
  'distribution/linux/fetch-extscache-kit.mjs',
  'distribution/linux/extscache-kit-wheel.json',
] as const

/** 只核真实staging载荷；存在源码不能替代缺失的运行worker或已构建SDK。 */
export function productRuntimeViolations(stage:string,upstreamDirectory:string):string[]{
  const files=[...PRODUCT_RUNTIME_FILES,
    join(upstreamDirectory,'packages/llm/llm-pi-ai/lib/index.js'),
    join(upstreamDirectory,'packages/client/ui-conversation/lib/client.js'),
  ]
  const violations:string[]=frontendRuntimeViolations(stage,upstreamDirectory)
  const available=new Set<string>()
  for(const file of files){
    try{
      const row=lstatSync(join(stage,file))
      if(row.isFile()&&row.size>0){available.add(file);continue}
    }catch{}
    violations.push(`发行载荷缺少非空${file==='LICENSE'||file==='NOTICE'?'项目许可':'物理/材质/桌面运行'}文件：${file}`)
  }
  // 字体本体与原许可已由来源验收钉死；宿主字库不能替代归档内资产。
  const fontRoot='packages/desktop/renderer/fonts',sourceFile=join(fontRoot,'SOURCES.json')
  const fontPins=[
    {file:'NotoSansSC-Regular.otf',bytes:8331336,sha256:'faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9'},
    {file:'OFL.txt',bytes:4301,sha256:'6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2'},
  ]
  if(available.has(sourceFile)){
    try{
      const source=JSON.parse(readFileSync(join(stage,sourceFile),'utf8'))
      if(source.family!=='Noto Sans SC'||source.version!=='2.004'||source.license!=='OFL-1.1'||source.modified!==false||source.repository!=='https://github.com/notofonts/noto-cjk'||source.revision!=='523d033d6cb47f4a80c58a35753646f5c3608a78')
        violations.push('发行载荷的中文字体来源或许可身份不符')
      for(const pin of fontPins){
        const declared=Array.isArray(source.files)?source.files.find((row:{file?:string})=>row.file===pin.file):undefined
        if(declared?.bytes!==pin.bytes||declared?.sha256!==pin.sha256)
          violations.push(`发行载荷的中文字体来源登记与已验字节不符：${pin.file}`)
      }
    }catch{violations.push('发行载荷的中文字体SOURCES.json无法解析')}
  }
  for(const pin of fontPins){
    const file=join(fontRoot,pin.file)
    if(!available.has(file))continue
    const data=readFileSync(join(stage,file))
    if(data.length!==pin.bytes||createHash('sha256').update(data).digest('hex')!==pin.sha256)
      violations.push(`发行载荷的中文字体或原许可字节不符：${file}`)
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

/**
 * 应用包清单在载荷里的固定逻辑位置：Electron `app.getVersion()`（欢迎页 `api.version` 的来源）
 * 读的就是 `runtime/electron/resources/app/package.json` —— 它是指向 `packages/desktop` 的链接。
 *
 * 为什么需要这组函数（真实缺陷）：发行清单 `RELEASE.json.version` 取根 `package.json` 的
 * `product.version`，而欢迎页取应用包自己的 `version`；两者是**两个文件里的两个字段**。
 * 源桌面包停在 `0.1.0-alpha.4` 时，真实安装包的欢迎页就停在旧版本，而清单已写新版本 ——
 * 归档前没有任何判据会把两者对上。这里在**已复制的 staging** 上把应用清单 `version`
 * 同步为冻结来源（开工时读到的根 `product.version`），其余字段/依赖原样保留；源文件不动，
 * Electron 取值逻辑不动（不做运行时伪装）。
 */
export const DESKTOP_APP_MANIFEST_PATH = 'packages/desktop/package.json'

/** 只替换 `version`、其余字段/依赖逐字保留的新清单对象；非对象或空版本 fail-closed。 */
export function desktopAppManifestWithVersion(source: unknown, version: string): Record<string, unknown> {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) throw new Error('desktop app manifest must be a JSON object')
  if (typeof version !== 'string' || version.trim() === '') throw new Error('release version must be a non-empty string')
  return { ...(source as Record<string, unknown>), version }
}

/** 在真实 staging 上把应用清单 `version` 同步为发行版本；只改 `version`，写回 2 空格 JSON + 换行。 */
export function stampDesktopAppVersion(stage: string, version: string): void {
  const file = join(stage, DESKTOP_APP_MANIFEST_PATH)
  let source: unknown
  try {
    source = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`desktop app manifest missing or unreadable: ${DESKTOP_APP_MANIFEST_PATH} (${(error as Error)?.message ?? String(error)})`)
  }
  writeFileSync(file, JSON.stringify(desktopAppManifestWithVersion(source, version), null, 2) + '\n')
}

/** 读回真实 staging 应用清单的 `version`；缺失/非串即抛（不让假版本过关）。 */
export function readDesktopAppVersion(stage: string): string {
  const file = join(stage, DESKTOP_APP_MANIFEST_PATH)
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`desktop app manifest missing or unreadable: ${DESKTOP_APP_MANIFEST_PATH} (${(error as Error)?.message ?? String(error)})`)
  }
  const version = (manifest as { version?: unknown } | null)?.version
  if (typeof version !== 'string' || version.trim() === '') throw new Error(`desktop app manifest has no version: ${DESKTOP_APP_MANIFEST_PATH}`)
  return version
}

/** 归档前断言：真实应用清单版本必须与 `RELEASE.json` 的发行版本逐字一致；不可核验也算违约（fail-closed）。 */
export function desktopAppVersionViolations(stage: string, expected: string): string[] {
  try {
    const actual = readDesktopAppVersion(stage)
    return actual === expected ? [] : [`desktop app manifest version mismatch: application=${actual} release=${expected} (${DESKTOP_APP_MANIFEST_PATH})`]
  } catch (error) {
    return [`desktop app manifest version unverifiable, refusing to archive: ${(error as Error)?.message ?? String(error)}`]
  }
}
