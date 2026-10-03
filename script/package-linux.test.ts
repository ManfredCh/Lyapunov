/**
 * N71 / DEV-020 漂移守卫：**发行根清单名**与**产品链接归属判定**必须用同一个身份串。
 *
 * 真实缺陷（本轮 R3 负对照复现）：旧安装 A 的运行根交给新安装 B 启动时，
 * `script/product-link.ts:42` 要求既有安装根 `package.json.name === 'lyapunov-dsh'`；
 * 而 `script/package-linux.ts:93` 原本写 worktree 的 `product.name`（`lyapunov`）。
 * 两个字面量不一致 → `ownedProductLink()` 对**任何真实发行安装**都返回未归属 →
 * `PRODUCT_PACKAGE_CONFLICT: … 指向自定义或已不可确认的安装（原链接已保留）`，退出 1，
 * 跨安装升级（换目录解包新版本 + 指向旧版本运行根）永久失败关闭。
 *
 * 这是**漂移守卫**（读源码字面量），不冒充行为证据：行为面证据是回执里的真实起停实验
 * （R3 预修产物 → 冲突；R4 修复产物 → 启动成功且链接切到新安装；用户自定义链接仍被拒）。
 */
import { describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { prepareLinuxNativeSystem } from './native-system.ts'

const root = join(import.meta.dirname, '..')
const packager = readFileSync(join(root, 'script/package-linux.ts'), 'utf8')
const productLink = readFileSync(join(root, 'script/product-link.ts'), 'utf8')

describe('发行原生构建与归档接线', () => {
  test('原生构建在依赖收闭前执行，真实载荷缺件检查紧邻tar之前', () => {
    const prepareAt = packager.indexOf('const nodeRuntime=prepareLinuxNativeSystem(upstream,values.node!)')
    const closureAt = packager.indexOf('const nodes=new Map<string,PackageNode>()')
    const checkAt = packager.indexOf('const nativeProblems=nativeSystemRuntimeViolations(stage,lock.directory)')
    const tarAt = packager.indexOf("const tar=spawnSync('tar'")
    expect(prepareAt).toBeGreaterThan(-1)
    expect(prepareAt).toBeLessThan(closureAt)
    expect(checkAt).toBeGreaterThan(packager.indexOf('await verify(stage)'))
    expect(checkAt).toBeLessThan(tarAt)
    expect(packager.slice(checkAt, tarAt)).toContain("if(nativeProblems.length)throw new Error(nativeProblems.join('；'))")
  })

  test('固定SDK构建命令漂移会在执行或写产物之前阻断', () => {
    const sdk = mkdtempSync(join(tmpdir(), 'lyapunov-native-command-'))
    try {
      writeFileSync(join(sdk, 'package.json'), JSON.stringify({ scripts: { 'build:native-system': 'tsx unexpected.ts' } }))
      const probe = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' })
      expect(probe.status).toBe(0)
      expect(() => prepareLinuxNativeSystem(sdk, probe.stdout.trim())).toThrow('build:native-system 命令发生变化')
      expect(existsSync(join(sdk, 'native'))).toBe(false)
    } finally { rmSync(sdk, { recursive: true, force: true }) }
  })
})

describe('发行根清单名与产品链接归属判定同一身份', () => {
  test('打包脚本写产品安装身份 `lyapunov-dsh`，不再写 worktree 的 product.name', () => {
    expect(packager).toContain("name:'lyapunov-dsh'")
    expect(packager).not.toContain('name:product.name')
  })

  test('产品链接归属判定要求的身份串与打包脚本写出的完全一致', () => {
    const written = /name:'([^']+)',version:product\.version/.exec(packager)?.[1]
    const required = /product\?\.name!=='([^']+)'/.exec(productLink)?.[1]
    expect(written).toBeDefined()
    expect(required).toBeDefined()
    expect(written).toBe(required)
  })
})

describe('发行安装器的几何依赖与包内前缀复用', () => {
  const quote = (value:string) => "'"+value.replaceAll("'", "'\\''")+"'"
  const fixture = (provider:'mujoco'|'isaac',geometryFails=false,pipFails=false) => {
    const directory=mkdtempSync(join(tmpdir(),'lyapunov-geometry-install-')),product=join(directory,'product')
    const put=(file:string,text:string,executable=false)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);if(executable)chmodSync(file,0o755)}
    for(const file of ['distribution/linux/install-provider','packages/asset-bake/requirements.txt','packages/asset-bake/requirements-isaac.txt','packages/asset-bake/requirements-common.txt']){
      mkdirSync(dirname(join(product,file)),{recursive:true});copyFileSync(join(root,file),join(product,file))
    }
    put(join(product,'script/package-linux.ts'),'// 离线安装路由夹具\n')
    put(join(product,'distribution/linux/sandbox.mjs'),'export {}\n')
    put(join(product,'packages/lyapunov-product-bundle/src/sdk-python.mjs'),'export {}\n')
    const doctor=join(directory,'doctor.json'),log=join(directory,'pip.jsonl'),imports=join(directory,'imports.log')
    put(join(product,'distribution/linux/doctor.mjs'),`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(doctor)},JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({status:'AVAILABLE',scope:'离线安装路由夹具'}))\n`)
    const prefix=join(product,provider==='isaac'?'.runtime/conda/envs/isaac':'.runtime/sim-python')
    const logger=join(directory,'pip-log.mjs')
    put(logger,`import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');if(${pipFails}){console.error('ERROR: Connection broken: BrokenPipeError');process.exit(19)}\n`)
    const nodeProbe=spawnSync('node',['-p','process.execPath'],{encoding:'utf8'})
    if(nodeProbe.status!==0)throw new Error('离线安装路由夹具需要现有 Node')
    const node=nodeProbe.stdout.trim()
    // 此 Python、pip、micromamba 与 doctor 均为明确的离线替身，不下载、不执行 Isaac、不接受真实许可。
    put(join(prefix,'bin/python'),`#!/bin/sh\nif [ "$1" = -c ];then\ncase "$2" in\n*sys.prefix*) printf '%s\\n' ${quote(prefix)};;\n*coacd*) printf '%s\\n' "$2" >> ${quote(imports)};${geometryFails?"printf '%s\\n' 'ModuleNotFoundError: coacd' >&2;exit 17":"exit 0"};;\nesac\nexit 0\nfi\nif [ "$1" = -m ] && [ "$2" = pip ] && [ "$3" = --version ];then printf '%s\\n' 'offline pip';exit 0;fi\nexec ${quote(node)} ${quote(logger)} "$@"\n`,true)
    const micromamba=join(directory,'micromamba');put(micromamba,'#!/bin/sh\nexit 91\n',true)
    const run=()=>spawnSync('/bin/sh',[join(product,'distribution/linux/install-provider'),provider,...(provider==='isaac'?['--accept-omniverse-eula']:[])],{encoding:'utf8',timeout:5000,env:{...process.env,LYAPUNOV_NODE_BIN:node,LYAPUNOV_MICROMAMBA:micromamba,LYAPUNOV_MUJOCO_PYTHON:'/outside/mujoco/python',LYAPUNOV_ISAAC_PYTHON:'/outside/isaac/python'}})
    return {directory,product,prefix,doctor,log,imports,run}
  }

  test('MuJoCo与Isaac真实shell安装入口复用自己的前缀、递归依赖声明与pip缓存',()=>{
    for(const provider of ['mujoco','isaac'] as const){
      const f=fixture(provider)
      try{
        const result=f.run();expect(result.error).toBeUndefined();expect(result.status,result.stderr).toBe(0)
        expect(result.stdout).toContain('复用已有 Python 前缀')
        const argv=JSON.parse(readFileSync(f.log,'utf8').trim()) as string[]
        expect(argv.slice(0,5)).toEqual(['-m','pip','--isolated','install','--cache-dir'])
        expect(argv[5]).toBe(join(f.product,'.runtime/provider-download-cache/pip'))
        expect(argv[argv.indexOf('--timeout')+1]).toBe('60')
        expect(argv[argv.indexOf('--retries')+1]).toBe('3')
        expect(argv).toContain('--disable-pip-version-check')
        expect(argv[argv.indexOf('--index-url')+1]).toBe('https://pypi.org/simple')
        const requirement=argv[argv.indexOf('-r')+1]!
        expect(requirement).toBe(join(f.product,'packages/asset-bake',provider==='isaac'?'requirements-isaac.txt':'requirements.txt'))
        expect(readFileSync(requirement,'utf8')).toContain('-r requirements-common.txt')
        expect(readFileSync(join(dirname(requirement),'requirements-common.txt'),'utf8').trim().split('\n')).toContain('coacd==1.0.7')
        expect(readFileSync(requirement,'utf8')).toContain(provider==='isaac'?'trimesh==4.11.1':'trimesh==5.1.0')
        expect(readFileSync(f.imports,'utf8')).toContain('import numpy,scipy,trimesh,coacd')
        expect(JSON.parse(readFileSync(f.doctor,'utf8'))).toEqual([provider,'--managed-sdk'])
      }finally{rmSync(f.directory,{recursive:true,force:true})}
    }
  })

  test('pip传输失败保持非零与partial前缀，不进入导入或doctor成功分支',()=>{
    const f=fixture('mujoco',false,true)
    try{
      const marker=join(f.prefix,'existing-marker');writeFileSync(marker,'原前缀字节')
      const result=f.run();expect(result.status).toBe(19)
      expect(result.stderr).toContain('BrokenPipeError')
      expect(existsSync(f.doctor)).toBe(false)
      expect(existsSync(f.imports)).toBe(false)
      expect(readFileSync(marker,'utf8')).toBe('原前缀字节')
      expect(existsSync(join(f.prefix,'bin/python'))).toBe(true)
      expect(readFileSync(f.log,'utf8').trim().split('\n')).toHaveLength(1)
    }finally{rmSync(f.directory,{recursive:true,force:true})}
  })

  test('pip退出0但几何原生库无法导入时明确阻断，不能交给doctor报告成功',()=>{
    const f=fixture('mujoco',true)
    try{
      const result=f.run();expect(result.status).toBe(2)
      expect(result.stderr).toContain('ModuleNotFoundError: coacd')
      const report=JSON.parse(result.stdout.trim().split('\n').at(-1)!)
      expect(report).toMatchObject({provider:'mujoco',status:'BLOCKED',code:'ASSET_BAKE_DEPENDENCY_MISSING'})
      expect(report.message).toContain(f.prefix)
      expect(existsSync(f.doctor)).toBe(false)
      expect(existsSync(join(f.prefix,'bin/python'))).toBe(true)
    }finally{rmSync(f.directory,{recursive:true,force:true})}
  })

  test('缺随包公共requirements在安装之前失败并点名，不改现有前缀',()=>{
    const f=fixture('mujoco')
    try{
      rmSync(join(f.product,'packages/asset-bake/requirements-common.txt'))
      const result=f.run();expect(result.status).toBe(2)
      expect(JSON.parse(result.stdout)).toMatchObject({provider:'mujoco',status:'BLOCKED',code:'RELEASE_PAYLOAD_MISSING'})
      expect(result.stdout).toContain('requirements-common.txt')
      expect(existsSync(f.log)).toBe(false)
      expect(existsSync(join(f.prefix,'bin/python'))).toBe(true)
    }finally{rmSync(f.directory,{recursive:true,force:true})}
  })
})

/**
 * 出处守卫（ARCHIVE-SOURCECOMMIT-HONESTY，2026-09-27）：**包里装的东西**与 **RELEASE.json 声明的
 * `sourceCommit`** 必须是同一棵树；不是 ⇒ 拒绝打包并点名（`script/package-linux.ts` 开工处的
 * `payloadProvenance()` + `--check-source` 自检模式）。
 *
 * 为什么这条不能靠"读源码字面量"：真实缺陷的形状正是"代码看起来对、产物里没有"。
 * 所以这里是**行为负对照** —— 真 git 仓库、真跑打包脚本、真退出码：
 *   · **锚点** = 测试自己用 `git status --porcelain` 数出来的改动数（不引用守卫的输出）
 *   · **下限** = 守卫必须给出数字（`changed` / `payloadChanged` 不许是 `null`）
 *   · **反向** = 干净树必须**放行**（只会拦的桩过不了这一条；只会放的桩过不了脏树那一条）
 * 守卫对**真实打包**的接线（第 20 行 `build-plugins` **之前**拦、写 `RELEASE.json` **之前**再取一次快照）
 * 由本文件第 5 条以源码锚点守着 —— 真实打包要复制 544MB 并重跑全部插件构建，单测里跑不起（如实登记）。
 */
describe('出处守卫：载荷相关的脏拒绝、载荷无关的脏放行', () => {
  const repos: string[] = []
  const gitIn = (dir: string, args: string[]): string => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`)
    return result.stdout
  }
  /** 合成检出：`packages/demo/src/plugin.ts` 进载荷、`packages/demo/test/case.ts` 与 `docs/note.md` 不进。 */
  const makeRepo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lyapunov-provenance-'))
    repos.push(dir)
    gitIn(dir, ['init', '-q'])
    gitIn(dir, ['config', 'user.email', 'guard@example.invalid'])
    gitIn(dir, ['config', 'user.name', 'guard'])
    mkdirSync(join(dir, 'packages/demo/src'), { recursive: true })
    mkdirSync(join(dir, 'packages/demo/test'), { recursive: true })
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'packages/demo/src/plugin.ts'), 'export const plugin = 1\n')
    writeFileSync(join(dir, 'packages/demo/test/case.ts'), 'export const cases = 1\n')
    writeFileSync(join(dir, 'docs/note.md'), '# note\n')
    gitIn(dir, ['add', '-A'])
    gitIn(dir, ['commit', '-q', '-m', 'base'])
    return dir
  }
  /** 用**测试进程自己**的 `process.execPath` 拉起守卫：不依赖调用方 PATH 上有 bun（§7.7 ④）。 */
  const checkSource = (dir: string | null): { status: number | null; report: Record<string, unknown> | null; raw: string } => {
    const args = [join(root, 'script/package-linux.ts'), '--check-source']
    if (dir !== null) args.push('--root', dir)
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
    const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`
    let report: Record<string, unknown> | null = null
    try {
      report = JSON.parse(result.stdout ?? '') as Record<string, unknown>
    } catch {
      report = null
    }
    return { status: result.status, report, raw }
  }
  const porcelainCount = (dir: string, paths: string[]): number =>
    gitIn(dir, ['status', '--porcelain', '--', ...paths]).split('\n').filter(Boolean).length
  const payloadScope = ['packages', 'distribution', 'script', 'package.json', 'bun.lock', 'UPSTREAM_LOCK.json', 'LICENSE', 'NOTICE']

  test('干净树 ⇒ CLEAN、退出 0，且读数不是 null（下限：守卫必须给出数字）', () => {
    const dir = makeRepo()
    const { status, report } = checkSource(dir)
    expect(report).not.toBeNull()
    expect(report?.verdict).toBe('CLEAN')
    expect(status).toBe(0)
    expect(report?.changed).toBe(0)
    expect(report?.payloadChanged).toBe(0)
    expect(report?.head).toMatch(/^[0-9a-f]{40}$/)
  })

  test('载荷无关的脏（docs/ 与 packages/**/test/**）⇒ 仍 CLEAN、退出 0，但总脏数如实报出', () => {
    const dir = makeRepo()
    writeFileSync(join(dir, 'docs/note.md'), '# note changed\n')
    writeFileSync(join(dir, 'packages/demo/test/case.ts'), 'export const cases = 2\n')
    const measured = porcelainCount(dir, [])
    const { status, report } = checkSource(dir)
    expect(measured).toBe(2) // 锚点：测试自己数一遍，不引用守卫的输出
    expect(report?.verdict).toBe('CLEAN')
    expect(status).toBe(0)
    expect(report?.changed).toBe(measured) // 总脏数如实报出（不藏）
    expect(report?.payloadChanged).toBe(0) // 但载荷面为 0 ⇒ 这些改动进不了包
  })

  test('载荷相关的脏（packages/**/src/**）⇒ DIRTY、退出 3、点名该文件，计数与锚点一致', () => {
    const dir = makeRepo()
    writeFileSync(join(dir, 'packages/demo/src/plugin.ts'), 'export const plugin = 2\n')
    writeFileSync(join(dir, 'docs/note.md'), '# note changed\n')
    const measuredPayload = porcelainCount(dir, payloadScope)
    const { status, report, raw } = checkSource(dir)
    expect(measuredPayload).toBe(1) // 锚点：只有 src 那条落在载荷相关路径上
    expect(report?.verdict).toBe('DIRTY')
    expect(status).toBe(3)
    expect(report?.payloadChanged).toBe(measuredPayload)
    expect(report?.payloadScoped).toBe(measuredPayload)
    expect(String((report?.sample as string[])?.join('\n'))).toContain('packages/demo/src/plugin.ts')
    // 正式打包的拒绝路径：同一条判据（`DIRTY` + 非零退出）就是打包开工时的 fail-closed 依据
    expect(raw).not.toContain('undefined')
  })

  test('`--root` 不许改打包根：不带 `--check-source` 时直接拒绝（退出非 0，且话里点名 --root）', () => {
    const dir = makeRepo()
    const result = spawnSync(process.execPath, [join(root, 'script/package-linux.ts'), '--root', dir], { encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('--root 只与 --check-source 同用')
  })

  test('非 Git 目录无法确认来源，退出 UNKNOWN 而不是当作干净树', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lyapunov-provenance-unknown-'))
    repos.push(dir)
    const { status, report } = checkSource(dir)
    expect(status).toBe(4)
    expect(report?.verdict).toBe('UNKNOWN')
    expect(report?.head).toBeNull()
  })

  test('普通打包在构建前拒绝未知来源，并识别干净提交间的 HEAD 变化', () => {
    const unknownAt = packager.indexOf("if(provenanceAtStart.verdict==='UNKNOWN')throw new Error(")
    const buildAt = packager.indexOf("join(root,'script/build-plugins.ts')")
    expect(unknownAt).toBeGreaterThan(-1)
    expect(unknownAt).toBeLessThan(buildAt)
    expect(packager).toContain("if(provenanceAtWrite.verdict==='UNKNOWN')throw new Error(")
    expect(packager).toContain('provenanceAtStart.head!==provenanceAtWrite.head')
  })

  test('接线锚点：守卫在 build-plugins 之前拦、RELEASE.json 写点带出处读数字段', () => {
    const guardAt = packager.indexOf('const provenanceAtStart=payloadProvenance(provenanceRoot)')
    const blockAt = packager.indexOf("if(provenanceAtStart.verdict==='DIRTY'&&!allowDirty)throw new Error(")
    const buildAt = packager.indexOf("join(root,'script/build-plugins.ts')")
    const writeAt = packager.indexOf('const provenanceAtWrite=payloadProvenance(root)')
    const manifestAt = packager.indexOf("join(stage,'RELEASE.json')")
    expect(guardAt).toBeGreaterThan(-1)
    expect(blockAt).toBeGreaterThan(guardAt) // 判定在开工处
    expect(buildAt).toBeGreaterThan(blockAt) // 拒绝发生在**动手构建之前**（不是收尾才发现）
    expect(writeAt).toBeGreaterThan(buildAt) // 收尾再取一次快照
    expect(manifestAt).toBeGreaterThan(writeAt) // 快照先于 RELEASE.json 写点
    // 声明字段必须在写 RELEASE.json 的那一份对象里（"包里能看出来这个包不是从 sourceCommit 构建的"）
    expect(packager).toContain('sourceCommitMatchesPayload:')
    expect(packager).toContain('worktreeProvenance:{scope:[...PAYLOAD_SCOPE]')
    expect(packager).toContain("'UPSTREAM_LOCK.json','LICENSE','NOTICE']")
    // 收尾快照：打包期间树动了 ⇒ 默认拒绝（`LYAPUNOV_PACKAGE_ALLOW_DIRTY=1` 时才如实记两个快照）
    expect(packager).toContain('if(provenanceMoved&&!allowDirty)throw new Error(')
  })
})
