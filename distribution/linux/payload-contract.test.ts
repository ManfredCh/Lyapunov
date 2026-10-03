/**
 * DEV-020（2026-09-26）发行载荷契约守卫：
 *  ① 顶层**只有一个**可执行入口 `lyapunov`（两份入口＝两个可启动 owner）；
 *  ② 随包分发的可选 Provider 定义（`distribution/providers/graspgenx/`）必须在载荷里，
 *     且 `RELEASE.json.providersBundled` 不得再报空清单。
 *  ③ doctor/desktop/setup-sandbox 共用的 `sandbox.mjs` 必须真正进入发行 staging。
 *
 * 这里钉的是**纯判据**（有失败能力）：真实 staging 取数与归档前 fail-closed 由
 * `script/package-linux.ts` 调用；本文件的"真实载体"负对照记录在
 * `bugfixHistory/RELEASE-UPGRADE-20260926.md`（真实 staging 读数 + 变异读数）。
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PRODUCT_ENTRY, PRODUCT_RUNTIME_FILES, bundledProviderViolations, entryViolations, payloadLinkTarget, productRuntimeViolations, sandboxRuntimeViolations, workspacePayloadDestination, type PayloadTopLevelRow } from './payload-contract.ts'

const root = join(import.meta.dirname, '..', '..')
const packager = readFileSync(join(root, 'script/package-linux.ts'), 'utf8')

const row = (name: string, options: { directory?: boolean; executable?: boolean } = {}): PayloadTopLevelRow => ({
  name,
  directory: options.directory ?? false,
  executable: options.executable ?? false,
})

/** 真实发行 staging 顶层形状：目录在左、可执行入口只有一个 `lyapunov`。 */
const realStageShape: PayloadTopLevelRow[] = [
  row('distribution', { directory: true, executable: true }),
  row('.modules', { directory: true, executable: true }),
  row('packages', { directory: true, executable: true }),
  row('runtime', { directory: true, executable: true }),
  row('node_modules', { directory: true, executable: true }),
  row('.upstream', { directory: true, executable: true }),
  row(PRODUCT_ENTRY, { executable: true }),
  row('DSH-LICENSE'),
  row('LICENSE'),
  row('NOTICE'),
  row('RELEASE.json'),
  row('UPSTREAM_LOCK.json'),
  row('package.json'),
]

describe('发行载荷顶层入口契约', () => {
  test('真实发行形状：只有 `lyapunov` 一个可执行入口 ⇒ 无违约', () => {
    expect(entryViolations(realStageShape)).toEqual([])
  })

  test('负对照：顶层多一个可执行入口（如旧安装留下的 `dev`）⇒ 必须报违约并点名', () => {
    const violations = entryViolations([...realStageShape, row('dev', { executable: true })])
    expect(violations.some(violation => violation.includes('dev'))).toBe(true)
    expect(violations.some(violation => violation.includes('第二个可执行入口'))).toBe(true)
  })

  test('负对照：`lyapunov` 丢了执行位或整个缺失 ⇒ 必须报违约', () => {
    const noBit = realStageShape.map(item => (item.name === PRODUCT_ENTRY ? { ...item, executable: false } : item))
    expect(entryViolations(noBit).length).toBeGreaterThan(0)
    expect(entryViolations(realStageShape.filter(item => item.name !== PRODUCT_ENTRY)).length).toBeGreaterThan(0)
  })

  test('目录带执行位（0755 目录）不算可执行入口', () => {
    expect(entryViolations([row(PRODUCT_ENTRY, { executable: true }), row('bin', { directory: true, executable: true })])).toEqual([])
  })
})

describe('随包 Provider 定义契约', () => {
  const required = ['graspgenx']

  test('graspgenx 定义真实拷入（文件数 > 0）⇒ 无违约', () => {
    expect(bundledProviderViolations({ required, present: new Map([['graspgenx', 13]]) })).toEqual([])
  })

  test('负对照：定义缺失或空目录 ⇒ 必须报违约', () => {
    expect(bundledProviderViolations({ required, present: new Map() })[0]).toContain('缺失')
    expect(bundledProviderViolations({ required, present: new Map([['graspgenx', 0]]) })[0]).toContain('为空')
  })
})

describe('载荷内符号链接落点判定', () => {
  const base = { destination: '/stage/pkg', dest: '/stage/pkg/sub', source: '/src/pkg/sub' }

  test('包内链接：写成包内相对目标', () => {
    expect(payloadLinkTarget({ ...base, inside: 'lib/util.js' })).toBe('lib/util.js')
    expect(payloadLinkTarget({ destination: '/stage/pkg', dest: '/stage/pkg/a/b', source: '/src/pkg/a/b', inside: 'c' })).toBe('../c')
    const fixture=mkdtempSync(join(tmpdir(),'lyapunov-sdk-payload-location-')),logical='.upstream/locked-sdk'
    try{
      for(const borrowed of [false,true]){
        const productRoot=join(fixture,borrowed?'borrowed-product':'ordinary-product'),sdk=join(productRoot,logical)
        mkdirSync(dirname(sdk),{recursive:true})
        if(borrowed){const external=join(fixture,'readonly-source-sdk');mkdirSync(external);symlinkSync(external,sdk)}else mkdirSync(sdk)
        const upstreamReal=realpathSync(sdk),map=(source:string)=>workspacePayloadDestination({root:productRoot,upstreamReal,upstreamDirectory:logical,source})
        for(const path of ['packages/llm/llm-pi-ai','packages/client/ui-conversation']){
          mkdirSync(join(sdk,path),{recursive:true})
          expect(map(realpathSync(join(sdk,path)))).toBe(join(logical,path))
        }
        expect(map(join(productRoot,'packages/viewer'))).toBe('packages/viewer')
        expect(map(join(upstreamReal,'node_modules/external'))).toBeNull()
        expect(map(join(upstreamReal,'packages/llm/node_modules/external'))).toBeNull()
        expect(map(join(productRoot,'node_modules/external'))).toBeNull()
        expect(map(join(productRoot,'packages/viewer/node_modules/external'))).toBeNull()
      }
    }finally{rmSync(fixture,{recursive:true,force:true})}
  })

  test('负对照：自指链接（相对目标为空）⇒ 返回 null（跳过，不写自环、不 ENOENT）', () => {
    expect(payloadLinkTarget({ ...base, inside: '' })).toBeNull()
    expect(payloadLinkTarget({ ...base, inside: '.' })).toBeNull()
    const input={root:'/product',upstreamReal:'/shared/sdk',upstreamDirectory:'.upstream/locked-sdk'}
    expect(workspacePayloadDestination({...input,source:input.upstreamReal})).toBeNull()
    expect(workspacePayloadDestination({...input,source:'/shared/sdk-neighbor/packages/client'})).toBeNull()
    expect(workspacePayloadDestination({...input,source:'/other/project/packages/client'})).toBeNull()
  })

  test('负对照：越界链接 ⇒ fail-closed 抛错并点名源路径', () => {
    expect(() => payloadLinkTarget({ ...base, inside: '../outside' })).toThrow('未声明外部符号链接')
    expect(() => payloadLinkTarget({ ...base, inside: '/abs/outside' })).toThrow('未声明外部符号链接')
    const input={root:'/product',upstreamReal:'/shared/sdk',source:'/shared/sdk/packages/client'}
    for(const upstreamDirectory of ['../outside','/absolute','safe/../../outside'])expect(()=>workspacePayloadDestination({...input,upstreamDirectory})).toThrow('SDK逻辑载荷根不安全')
  })
})

describe('沙箱运行时载荷', () => {
  test('真实 staging 的三文件齐全通过，移除 sandbox.mjs 后归档判据明确失败', () => {
    const stage = mkdtempSync(join(tmpdir(), 'lyapunov-sandbox-stage-'))
    try {
      mkdirSync(join(stage, 'distribution/linux'), { recursive: true })
      writeFileSync(join(stage, 'lyapunov'), '#!/bin/sh\n')
      writeFileSync(join(stage, 'distribution/linux/doctor.mjs'), 'export {}\n')
      const sandbox = join(stage, 'distribution/linux/sandbox.mjs')
      writeFileSync(sandbox, 'export {}\n')
      expect(sandboxRuntimeViolations(stage)).toEqual([])
      rmSync(sandbox)
      expect(sandboxRuntimeViolations(stage)).toEqual(['发行载荷缺少 doctor/desktop/setup-sandbox 必需文件：distribution/linux/sandbox.mjs'])
    } finally {
      rmSync(stage, { recursive: true, force: true })
    }
  })
})

describe('打包脚本接线（漂移守卫）', () => {
  test('沙箱模块进入发行载荷，打包前调用同一份真实 staging 判据', () => {
    expect(packager).toContain("['README.md','doctor.mjs','sandbox.mjs','install-provider','policy-cpu.mjs','lyapunov-desktop.desktop.in','install.sh','install-entry.mjs']")
    expect(packager).toContain('const sandboxProblems=sandboxRuntimeViolations(stage)')
    expect(packager).toContain("if(sandboxProblems.length)throw new Error(sandboxProblems.join('；'))")
    expect(packager).toContain("await cp(join(electronPackage,'dist/chrome-sandbox'),join(stage,'runtime/electron/chrome-sandbox'),{dereference:true})")
    expect(packager).toContain("await chmod(join(stage,'runtime/electron/chrome-sandbox'),0o755)")
  })

  test('package-linux.ts 调用两个判据，而不是只留常量 `providersBundled:[]`', () => {
    expect(packager).toContain("from '../distribution/linux/payload-contract.ts'")
    expect(packager).toContain('entryViolations(topLevel)')
    expect(packager).toContain('bundledProviderViolations({')
    expect(packager).toContain("for(const file of ['LICENSE','NOTICE','README.md','README.zh-CN.md'])await cp(join(root,file),join(stage,file))")
    expect(packager).toContain('license:product.license')
    expect(packager).not.toContain('providersBundled:[]')
    expect(packager).toContain('providersBundled:bundledProviders.map')
  })

  test('自指链接被跳过并记账（`skippedSelfLinks` 进 RELEASE.json），不静默丢弃', () => {
    expect(packager).toContain('payloadLinkTarget({inside,destination,dest,source:src})')
    expect(packager).toContain('skippedSelfLinks.push(')
    expect(packager).toContain('topLevelExecutables,skippedSelfLinks')
  })

  test('micromamba 许可证取值有界（超时 + 重试），不留无限等待', () => {
    expect(packager).toContain('AbortSignal.timeout(30_000)')
    expect(packager).toContain('fetchMambaLicense(licenseUrl)')
    expect(packager).not.toContain('const license=await fetch(licenseUrl)')
  })

  test('发行根本清单名仍是产品安装身份 `lyapunov-dsh`（与 script/product-link.ts 同一身份串）', () => {
    const productLink = readFileSync(join(root, 'script/product-link.ts'), 'utf8')
    const written = /name:'([^']+)',version:product\.version/.exec(packager)?.[1]
    const required = /product\?\.name!=='([^']+)'/.exec(productLink)?.[1]
    expect(written).toBeDefined()
    expect(written).toBe(required)
  })
})

describe('物理、材质、转换器和品牌真实载荷',()=>{
  const upstream='.upstream/fixture-sdk'
  const stageFixture=()=>{
    const stage=mkdtempSync(join(tmpdir(),'lyapunov-product-runtime-'))
    const put=(file:string,text='离线载荷存在性夹具\n')=>{mkdirSync(dirname(join(stage,file)),{recursive:true});writeFileSync(join(stage,file),text)}
    for(const file of PRODUCT_RUNTIME_FILES)put(file)
    put(join(upstream,'packages/llm/llm-pi-ai/lib/index.js'))
    put(join(upstream,'packages/client/ui-conversation/lib/client.js'),'conversation.hero.headline\n')
    put(join(upstream,'apps/web/dist/index.html'),'<script type="module" src="./assets/entry.js"></script><link rel="stylesheet" href="./assets/entry.css">')
    put(join(upstream,'apps/web/dist/assets/entry.js'),'console.log("fixture")\n')
    put(join(upstream,'apps/web/dist/assets/entry.css'),'body { color: inherit }\n')
    put('packages/asset-bake/requirements-common.txt','numpy>=1.25,<3\nscipy>=1.10,<2\ncoacd==1.0.7\n')
    for(const file of ['packages/asset-bake/requirements.txt','packages/asset-bake/requirements-isaac.txt'])put(file,'-r requirements-common.txt\n')
    put('packages/desktop/dist/main.js','app.setDesktopName("lyapunov-desktop.desktop")\n')
    put('distribution/linux/lyapunov-desktop.desktop.in',readFileSync(join(root,'distribution/linux/lyapunov-desktop.desktop.in'),'utf8'))
    return {stage,put}
  }

  test('实际目录的必须文件/SDK产物/依赖及desktop身份齐全通过；删除Isaac拓扑明确失败',()=>{
    const {stage}=stageFixture()
    try{
      expect(productRuntimeViolations(stage,upstream)).toEqual([])
      rmSync(join(stage,'packages/sim-isaac/python/collision_topology.py'))
      expect(productRuntimeViolations(stage,upstream)).toEqual(['发行载荷缺少非空物理/材质/桌面运行文件：packages/sim-isaac/python/collision_topology.py'])
      // 在同一真实staging负对照里保留项目两件许可必须存在的约束，不新增case。
      rmSync(join(stage,'LICENSE'));rmSync(join(stage,'NOTICE'))
      const licenseProblems=productRuntimeViolations(stage,upstream)
      expect(licenseProblems).toContain('发行载荷缺少非空项目许可文件：LICENSE')
      expect(licenseProblems).toContain('发行载荷缺少非空项目许可文件：NOTICE')
      // Alpha2实物曾遗漏整个dist；首页存在也不能替代真实入口与样式资源。
      const frontendIndex=join(upstream,'apps/web/dist/index.html'),frontendJs=join(upstream,'apps/web/dist/assets/entry.js')
      rmSync(join(stage,frontendIndex))
      expect(productRuntimeViolations(stage,upstream)).toContain(`发行载荷缺少非空原生工作台前端首页：${frontendIndex}`)
      writeFileSync(join(stage,frontendIndex),'<script type="module" src="./assets/entry.js"></script><link rel="stylesheet" href="./assets/entry.css">')
      rmSync(join(stage,frontendJs))
      expect(productRuntimeViolations(stage,upstream)).toContain(`发行载荷缺少非空原生工作台前端启动资源：${frontendJs}`)
    }finally{rmSync(stage,{recursive:true,force:true})}
  })

  test('空烘焙worker、转换器软链和遗漏CoACD不能冒充完整运行载荷',()=>{
    const {stage,put}=stageFixture()
    try{
      put('packages/scene-kit/dist/bake.py','')
      put('LICENSE','')
      rmSync(join(stage,'NOTICE'));symlinkSync('DSH-LICENSE',join(stage,'NOTICE'))
      const converter=join(stage,'packages/lyapunov-workspace/src/model-convert.ts')
      rmSync(converter);symlinkSync('../dist/plugin.js',converter)
      put('packages/asset-bake/requirements-common.txt','numpy>=1.25,<3\nscipy>=1.10,<2\n')
      const problems=productRuntimeViolations(stage,upstream)
      expect(problems).toContain('发行载荷缺少非空物理/材质/桌面运行文件：packages/scene-kit/dist/bake.py')
      expect(problems).toContain('发行载荷缺少非空物理/材质/桌面运行文件：packages/lyapunov-workspace/src/model-convert.ts')
      expect(problems).toContain('发行载荷的asset-bake公共requirements未声明coacd==1.0.7')
      expect(problems).toContain('发行载荷缺少非空项目许可文件：LICENSE')
      expect(problems).toContain('发行载荷缺少非空项目许可文件：NOTICE')
    }finally{rmSync(stage,{recursive:true,force:true})}
  })

  test('旧SDK构建、desktop identity漂移和漏掉公共requirements都明确失败',()=>{
    const {stage,put}=stageFixture()
    try{
      put(join(upstream,'packages/client/ui-conversation/lib/client.js'),'旧构建无headline插槽\n')
      put('distribution/linux/lyapunov-desktop.desktop.in','StartupWMClass=electron\n')
      put('packages/desktop/dist/main.js','app.setDesktopName("old.desktop")\n')
      put('packages/asset-bake/requirements-isaac.txt','trimesh==4.11.1\n')
      const problems=productRuntimeViolations(stage,upstream)
      expect(problems).toContain('发行载荷的私有SDK未构建conversation.hero.headline品牌插槽')
      expect(problems).toContain('发行载荷desktop entry的StartupWMClass未与lyapunov-desktop配对')
      expect(problems).toContain('发行载荷的桌面main未包含同名lyapunov-desktop.desktop身份')
      expect(problems).toContain('发行载荷的几何依赖未引用公共requirements：packages/asset-bake/requirements-isaac.txt')
    }finally{rmSync(stage,{recursive:true,force:true})}
  })

  test('productRuntimeViolations在真实staging写RELEASE与归档之前运行',()=>{
    const check=packager.indexOf('const productProblems=productRuntimeViolations(stage,lock.directory)')
    expect(check).toBeGreaterThan(packager.indexOf('const buildEntries=['))
    expect(check).toBeLessThan(packager.indexOf("join(stage,'RELEASE.json')"))
    expect(packager).toContain("if(productProblems.length)throw new Error(productProblems.join('；'))")
    expect(packager).toContain('const upstreamReal=await realpath(upstream)')
    expect(packager).toContain('workspacePayloadDestination({root,upstreamReal,upstreamDirectory:lock.directory,source})')
    expect(packager).toContain("const destination=workspaceDestination(source)??join('.modules'")
    expect(packager).not.toContain('workspace(source)?relative(root,source)')
  })
})
