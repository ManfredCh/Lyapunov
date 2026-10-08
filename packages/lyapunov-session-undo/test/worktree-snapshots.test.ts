/**
 * 工作树快照的**覆盖与边界**回归（DEV-022 验收项的可判定部分）。
 *
 * 这里跑的是真实的 `WorktreeSnapshots`：真实 Git 工作树、真实私有对象库、真实 journal，不启动 Host、
 * 不调用模型。覆盖：
 *   ① 五类变更 —— 新建文本／新建**二进制**／**删除**／修改（同长度）／**Bash 副作用**（真实 `bash -c`
 *      子进程写入，与模型 bash 工具同一条写入路径），外加执行位与符号链接这两个 Git 条目属性；
 *   ② 撤销／重做双向：`beginRestore(target=before)` → `commit()` → `beginRestore(target=after)` → `commit()`；
 *   ③ **会话私有运行目录**（`<工作树>/.lyapunov/sessions/**`）不进撤销域：既不出现在 `diff()` 里，
 *      被显式塞进恢复请求时也不落一个字节（跨会话误写的边界，见 worktree.ts 的 isSessionRuntime）；
 *   ④ **冷恢复**：事务未 commit/rollback 就"崩溃"，新开的 store 用 `recover()` 按原生持久化结论
 *      二选一（false→原件回滚，true→保留目标），且幂等；
 *   ⑤ 预检冲突（目录/文件互换会删掉未指定文件）在执行前拒绝，不留 journal、不动文件。
 *
 * 产品页上的真机读数（真实模型回合 + `/undo`／`/redo` + 宿主重启）见
 * `bugfixHistory/SESSION-UNDO-CHAIN-20260926.md`。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runtimePluginInsert } from '../../../script/runtime-patch.ts'
import { openWorktreeSnapshots, type WorktreeSnapshots } from '../src/worktree.ts'

const scratch: string[] = []
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** 每个用例一套隔离的真实 Git 工作树 + 工作树之外的私有快照库。 */
async function fixture(): Promise<{ root: string; store: WorktreeSnapshots; storageRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), 'undo-worktree-'))
  scratch.push(base)
  const root = join(base, 'repo'), storageRoot = join(base, 'store')
  mkdirSync(root)
  git(root, ['init', '-q'])
  const opened = await openWorktreeSnapshots({ cwd: root, storageRoot })
  if (!opened.supported) throw new Error('夹具不是 Git 工作树')
  return { root, store: opened.store, storageRoot }
}
const path = (root: string, ...parts: string[]) => join(root, ...parts)
const read = (root: string, ...parts: string[]) => readFileSync(path(root, ...parts))

/** 一次真实 bash 子进程完成五类写入（含二进制与删除）——与模型 bash 工具同一条落盘路径。 */
function bashSideEffects(root: string): void {
  execFileSync('bash', ['-c',
    'mkdir -p sub && printf A > sub/new.txt && printf "\\000\\001\\377\\376" > bin.dat && ' +
    'printf D-MODIFIED > same.txt && chmod +x sub/new.txt && ln -s sub/new.txt link.txt && rm victim.txt',
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
}

describe('五类变更（新建／二进制／删除／修改／Bash 副作用）的捕获、撤销与重做', () => {
  test('diff 精确列出五条路径；撤销回原字节，重做回改后字节（含执行位与符号链接）', async () => {
    const { root, store } = await fixture()
    writeFileSync(path(root, 'victim.txt'), 'C-ORIGINAL')
    writeFileSync(path(root, 'same.txt'), 'D-ORIGINAL')
    const before = await store.capture()
    bashSideEffects(root)
    const after = await store.capture()
    const changed = (await store.diff(before, after)).sort()
    expect(changed).toEqual(['bin.dat', 'link.txt', 'same.txt', 'sub/new.txt', 'victim.txt'])
    // 撤销前的真实字节（二进制按原字节、执行位、符号链接目标）
    expect(read(root, 'bin.dat').equals(Buffer.from([0x00, 0x01, 0xff, 0xfe]))).toBe(true)
    expect(lstatSync(path(root, 'sub', 'new.txt')).mode & 0o111).toBe(0o111)
    expect(lstatSync(path(root, 'link.txt')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(path(root, 'link.txt'))).toBe('sub/new.txt')
    expect(existsSync(path(root, 'victim.txt'))).toBe(false)

    const undo = await store.beginRestore({ operationId: 'op-undo', sessionId: 'session-a', target: before, paths: changed })
    await undo.commit()
    expect(read(root, 'victim.txt').toString()).toBe('C-ORIGINAL')
    expect(read(root, 'same.txt').toString()).toBe('D-ORIGINAL')
    expect(existsSync(path(root, 'bin.dat'))).toBe(false)
    expect(existsSync(path(root, 'link.txt'))).toBe(false)
    expect(existsSync(path(root, 'sub', 'new.txt'))).toBe(false)

    const redo = await store.beginRestore({ operationId: 'op-redo', sessionId: 'session-a', target: after, paths: changed })
    await redo.commit()
    expect(read(root, 'bin.dat').equals(Buffer.from([0x00, 0x01, 0xff, 0xfe]))).toBe(true)
    expect(read(root, 'same.txt').toString()).toBe('D-MODIFIED')
    expect(lstatSync(path(root, 'sub', 'new.txt')).mode & 0o111).toBe(0o111)
    expect(readlinkSync(path(root, 'link.txt'))).toBe('sub/new.txt')
    expect(existsSync(path(root, 'victim.txt'))).toBe(false)
  }, 30_000)

  test('只恢复 paths 里的文件：同目录的无关文件一个字节不动', async () => {
    const { root, store } = await fixture()
    writeFileSync(path(root, 'touched.txt'), 'v1')
    writeFileSync(path(root, 'untouched.txt'), 'keep')
    const before = await store.capture()
    writeFileSync(path(root, 'touched.txt'), 'v2')
    const after = await store.capture()
    const transaction = await store.beginRestore({ operationId: 'op-scope', sessionId: 'session-a', target: before, paths: await store.diff(before, after) })
    await transaction.commit()
    expect(read(root, 'touched.txt').toString()).toBe('v1')
    expect(read(root, 'untouched.txt').toString()).toBe('keep')
  }, 30_000)
})

describe('会话私有运行目录（.lyapunov/sessions/**）不进撤销域', () => {
  test('另一条会话的运行文件变化不出现在 diff，显式塞进恢复请求也不落字节', async () => {
    const { root, store } = await fixture()
    const otherRuntime = ['.lyapunov', 'sessions', 'session-other', 'sim']
    mkdirSync(path(root, ...otherRuntime), { recursive: true })
    writeFileSync(path(root, ...otherRuntime, 'worker.json'), '{"v":1}')
    writeFileSync(path(root, 'user.txt'), 'before')
    const before = await store.capture()
    // 另一条会话正在写它自己的运行态；同一工作区里的用户内容也在变。
    writeFileSync(path(root, ...otherRuntime, 'worker.json'), '{"v":2}')
    writeFileSync(path(root, 'user.txt'), '')
    rmSync(path(root, 'user.txt'))
    const after = await store.capture()
    const changed = await store.diff(before, after)
    expect(changed).toEqual(['user.txt'])
    // 恢复请求里带上运行态路径（例如修复前的 checkpoint/redo 遗留）也不许动它。
    const transaction = await store.beginRestore({
      operationId: 'op-runtime', sessionId: 'session-a', target: before,
      paths: ['.lyapunov/sessions/session-other/sim/worker.json', 'user.txt'],
    })
    await transaction.commit()
    expect(read(root, ...otherRuntime, 'worker.json').toString()).toBe('{"v":2}')
    expect(read(root, 'user.txt').toString()).toBe('before')
  }, 30_000)
})

describe('冷恢复：事务未定论时的 recover 结论', () => {
  test('原生操作未持久化 → 原件回滚；已持久化 → 保留目标；重复 recover 无动作', async () => {
    const { root, store, storageRoot } = await fixture()
    writeFileSync(path(root, 'a.txt'), 'original')
    const before = await store.capture()
    writeFileSync(path(root, 'a.txt'), 'modified')
    const after = await store.capture()
    // 模拟崩溃：beginRestore 已应用目标并落 journal，但既不 commit 也不 rollback。
    // 两阶段语义：恢复目标**当场生效**，等原生 Session 操作 flush 成功才 commit；未定论时由 recover 定夺。
    await store.beginRestore({ operationId: 'op-crash-rollback', sessionId: 'session-a', target: before, paths: ['a.txt'] })
    expect(read(root, 'a.txt').toString()).toBe('original')
    const reopened = await openWorktreeSnapshots({ cwd: root, storageRoot })
    if (!reopened.supported) throw new Error('夹具不是 Git 工作树')
    // 原生操作**没有**持久化 ⇒ 这次文件恢复必须整体撤销，回到 beginRestore 之前。
    const rolled = await reopened.store.recover(async () => false)
    expect(rolled).toEqual([{ operationId: 'op-crash-rollback', sessionId: 'session-a', outcome: 'rolled-back' }])
    expect(read(root, 'a.txt').toString()).toBe('modified')
    expect(await reopened.store.recover(async () => false)).toEqual([])

    // 已持久化的那一路：目标保留（recover 不把已成立的原生操作回退掉）。
    await reopened.store.beginRestore({ operationId: 'op-crash-committed', sessionId: 'session-a', target: after, paths: ['a.txt'] })
    const committedBranch = await reopened.store.recover(async () => true)
    expect(committedBranch).toEqual([{ operationId: 'op-crash-committed', sessionId: 'session-a', outcome: 'committed' }])
    expect(read(root, 'a.txt').toString()).toBe('modified')
  }, 30_000)

  test('恢复失败/未完成不冒充成功：目录文件互换的预检冲突不留 journal、不动文件', async () => {
    const { root, store } = await fixture()
    writeFileSync(path(root, 'swap'), 'file-before')
    const before = await store.capture()
    rmSync(path(root, 'swap'))
    mkdirSync(path(root, 'swap'))
    writeFileSync(path(root, 'swap', 'inner.txt'), 'inner')
    // 只恢复 swap 这一条会删掉未指定的 inner.txt ⇒ 执行前拒绝。
    await expect(store.beginRestore({ operationId: 'op-conflict', sessionId: 'session-a', target: before, paths: ['swap'] }))
      .rejects.toThrow(/RESTORE_PATH_CONFLICT/)
    expect(lstatSync(path(root, 'swap')).isDirectory()).toBe(true)
    expect(read(root, 'swap', 'inner.txt').toString()).toBe('inner')
    // 纯预检：没有留下待恢复 journal。
    expect(await store.recover(async () => true)).toEqual([])
  }, 30_000)
})


describe('明确产品运行根排除与真实 Git 暂态文件竞争', () => {
  const protectedPaths = ['private/config', 'private/data', 'private/cache', 'private/state', 'private/tmp', 'dsh', 'worktree-history']
  async function runtimeFixture() {
    const original = await fixture()
    const runtime = path(original.root, 'managed-runtime')
    for (const relative of protectedPaths) mkdirSync(path(runtime, relative), { recursive: true })
    const excludedRoots = protectedPaths.map(relative => path(runtime, relative))
    const opened = await openWorktreeSnapshots({ cwd: original.root, storageRoot: original.storageRoot, excludedRoots })
    if (!opened.supported) throw new Error('夹具不是 Git 工作树')
    return { ...original, store: opened.store, runtime, excludedRoots }
  }

  /** 包装器只安排文件删除时序；所有 Git 命令及其返回均来自实际系统 Git。 */
  function hashTimeRemoval(base: string, victim: string) {
    const realGit = Bun.which('git')
    if (!realGit) throw new Error('真实 Git 不可用')
    const bin = path(base, 'git-wrapper'), output = path(base, 'git-wrapper.jsonl')
    mkdirSync(bin)
    const wrapper = path(bin, 'git')
    const code = `#!${process.execPath}
` + `
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, unlinkSync } from 'node:fs'
const args = process.argv.slice(2)
const input = args.includes('--stdin-paths') ? Buffer.from(await Bun.stdin.arrayBuffer()) : undefined
if (input !== undefined) {
  const present = existsSync(${JSON.stringify(victim)})
  if (present) unlinkSync(${JSON.stringify(victim)})
  appendFileSync(${JSON.stringify(output)}, JSON.stringify({ removed: present, args, input: input.toString() }) + '\\n')
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { input, stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'] })
if (result.error) throw result.error
process.exit(result.status ?? 1)
`
    writeFileSync(wrapper, code)
    chmodSync(wrapper, 0o755)
    return { bin, output }
  }

  test('临时索引在 hash 子进程前真实删除；排除运行根后用户快照、Git 元数据及普通同名目录仍正常', async () => {
    const { root, store, storageRoot, runtime } = await runtimeFixture()
    const original = path(runtime, 'private/tmp/dsh-workspace-changes-abc/index-def/index')
    mkdirSync(dirname(original), { recursive: true }); writeFileSync(original, 'temporary-index')
    for (const relative of protectedPaths) writeFileSync(path(runtime, relative, 'owned.txt'), 'runtime-before')
    writeFileSync(path(root, 'tracked.txt'), 'tracked-before')
    mkdirSync(path(root, 'another/private/tmp'), { recursive: true })
    writeFileSync(path(root, 'another/private/tmp/user.txt'), 'same-name-before')
    mkdirSync(path(runtime, 'private/project'), { recursive: true })
    writeFileSync(path(runtime, 'private/project/user.txt'), 'legacy-private-before')
    writeFileSync(path(runtime, 'private/.bashrc'), 'ordinary-private-before')
    git(root, ['add', 'tracked.txt'])
    git(root, ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial'])
    const indexBefore = read(root, '.git/index'), headBefore = git(root, ['rev-parse', 'HEAD']), refsBefore = git(root, ['show-ref'])
    const wrapper = hashTimeRemoval(dirname(storageRoot), original)
    const previousPath = process.env.PATH
    process.env.PATH = wrapper.bin + ':' + previousPath
    try {
      const before = await store.capture()
      expect(existsSync(original)).toBe(false)
      const evidence = readFileSync(wrapper.output, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(evidence[0].removed).toBe(true)
      expect(evidence[0].input).not.toContain('dsh-workspace-changes-abc')
      for (const relative of protectedPaths) writeFileSync(path(runtime, relative, 'owned.txt'), 'runtime-after')
      writeFileSync(path(root, 'tracked.txt'), 'tracked-after')
      writeFileSync(path(root, 'bin.dat'), Buffer.from([0, 1, 254, 255]))
      writeFileSync(path(root, 'run.sh'), '#!/bin/sh\nexit 0\n'); chmodSync(path(root, 'run.sh'), 0o755)
      symlinkSync('tracked.txt', path(root, 'user-link'))
      writeFileSync(path(root, 'another/private/tmp/user.txt'), 'same-name-after')
      writeFileSync(path(runtime, 'private/project/user.txt'), 'legacy-private-after')
      writeFileSync(path(runtime, 'private/.bashrc'), 'ordinary-private-after')
      const after = await store.capture(), changed = (await store.diff(before, after)).sort()
      expect(changed).toEqual([
        'another/private/tmp/user.txt', 'bin.dat', 'managed-runtime/private/.bashrc',
        'managed-runtime/private/project/user.txt', 'run.sh', 'tracked.txt', 'user-link',
      ])
      const undo = await store.beginRestore({ operationId: 'runtime-roots-undo', sessionId: 'test', target: before, paths: [...changed, ...protectedPaths.map(relative => 'managed-runtime/' + relative + '/owned.txt')] })
      await undo.commit()
      expect(read(root, 'tracked.txt').toString()).toBe('tracked-before')
      expect(read(root, 'another/private/tmp/user.txt').toString()).toBe('same-name-before')
      expect(read(runtime, 'private/project/user.txt').toString()).toBe('legacy-private-before')
      expect(read(runtime, 'private/.bashrc').toString()).toBe('ordinary-private-before')
      for (const relative of protectedPaths) expect(read(runtime, relative, 'owned.txt').toString()).toBe('runtime-after')
      const redo = await store.beginRestore({ operationId: 'runtime-roots-redo', sessionId: 'test', target: after, paths: changed })
      await redo.commit()
      expect(read(root, 'bin.dat').equals(Buffer.from([0, 1, 254, 255]))).toBe(true)
      expect(lstatSync(path(root, 'run.sh')).mode & 0o111).toBe(0o111)
      expect(readlinkSync(path(root, 'user-link'))).toBe('tracked.txt')
      expect(read(root, '.git/index').equals(indexBefore)).toBe(true)
      expect(git(root, ['rev-parse', 'HEAD'])).toBe(headBefore)
      expect(git(root, ['show-ref'])).toBe(refsBefore)
      const liveAlias = path(dirname(storageRoot), 'runtime-alias')
      symlinkSync(runtime, liveAlias)
      const aliasOpened = await openWorktreeSnapshots({ cwd: root, storageRoot, excludedRoots: protectedPaths.map(relative => path(liveAlias, relative)) })
      if (!aliasOpened.supported) throw new Error('夹具不是 Git 工作树')
      expect((await aliasOpened.store.captureReported()).report.files).toBe(7)
    } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath }
  }, 30_000)

  test('未排除普通用户文件的真实 hash 读取失败仍拒绝，清理操作锁后下一次能够恢复', async () => {
    const { root, store, storageRoot } = await runtimeFixture()
    const userFile = path(root, 'user.txt')
    writeFileSync(userFile, 'real-user-before')
    const wrapper = hashTimeRemoval(dirname(storageRoot), userFile), previousPath = process.env.PATH
    process.env.PATH = wrapper.bin + ':' + previousPath
    try {
      await expect(store.capture()).rejects.toThrow("could not open 'user.txt'")
      expect(existsSync(path(storageRoot, 'operation.lock'))).toBe(false)
      expect(existsSync(path(storageRoot, 'capture.json'))).toBe(false)
    } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath }
    writeFileSync(userFile, 'real-user-restored')
    expect((await store.captureReported()).report.files).toBe(1)
  }, 30_000)

  test('旧 journal 的运行目录、临时文件和目录模式均不覆盖；正常用户文件仍按原事务结论恢复', async () => {
    const { root, storageRoot, runtime, excludedRoots } = await runtimeFixture()
    const old = await openWorktreeSnapshots({ cwd: root, storageRoot })
    if (!old.supported) throw new Error('夹具不是 Git 工作树')
    const managed = 'managed-runtime/private/cache/state.txt'
    writeFileSync(path(root, managed), 'runtime-v1'); writeFileSync(path(root, 'user.txt'), 'user-v1')
    const before = await old.store.capture()
    writeFileSync(path(root, managed), 'runtime-v2'); writeFileSync(path(root, 'user.txt'), 'user-v2')
    await old.store.beginRestore({ operationId: 'old-runtime-journal', sessionId: 'test', target: before, paths: [managed, 'user.txt'] })
    const journalPath = path(storageRoot, 'journals/old-runtime-journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
    const protectedTemporary = path(root, journal.temporaryFiles[managed])
    writeFileSync(protectedTemporary, 'keep-owned-temporary')
    writeFileSync(path(root, managed), 'live-runtime-v3')
    chmodSync(path(runtime, 'private/cache'), 0o700)
    journal.directories.push({ path: 'managed-runtime/private/cache', mode: 0o777 })
    writeFileSync(journalPath, JSON.stringify(journal) + '\n')
    const next = await openWorktreeSnapshots({ cwd: root, storageRoot, excludedRoots })
    if (!next.supported) throw new Error('夹具不是 Git 工作树')
    expect(await next.store.recover(async () => false)).toEqual([{ operationId: 'old-runtime-journal', sessionId: 'test', outcome: 'rolled-back' }])
    expect(read(root, managed).toString()).toBe('live-runtime-v3')
    expect(readFileSync(protectedTemporary, 'utf8')).toBe('keep-owned-temporary')
    expect(lstatSync(path(runtime, 'private/cache')).mode & 0o777).toBe(0o700)
    expect(read(root, 'user.txt').toString()).toBe('user-v2')
    expect(await next.store.recover(async () => false)).toEqual([])
  }, 30_000)

  test('原 runtime 装配只登记七个明确目录，旧布局与分域布局共用原账号运行根', () => {
    const previousUndo = process.env.LYAPUNOV_SESSION_UNDO
    delete process.env.LYAPUNOV_SESSION_UNDO
    try {
      const runtime = '/tmp/undo-runtime-wiring/account'
      const sceneRoot = path(runtime, 'scene')
      const domains = { worldsRoot: path(runtime, 'worlds'), assetsRoot: path(runtime, 'assets'), robotsRoot: path(runtime, 'robots'), cacheRoot: path(runtime, 'cache'), catalogRoot: path(runtime, 'catalog') }
      for (const input of [{ sceneRoot }, { sceneRoot: '/tmp/legacy-scene/scene', domains }]) {
        const plugin = runtimePluginInsert({ mode: 'guest', surface: 'web', engine: 'none', ...input }).find(plugin => plugin.id === 'lyapunov-lyapunov-session-undo')
        expect(plugin?.config).toEqual({ dataRoot: path(runtime, 'worktree-history'), excludedRoots: protectedPaths.map(relative => path(runtime, relative)) })
      }
    } finally { if (previousUndo === undefined) delete process.env.LYAPUNOV_SESSION_UNDO; else process.env.LYAPUNOV_SESSION_UNDO = previousUndo }
  })

  test('外置运行根不扩大文件域、排除缺失末端有效；非 Git 无快照；错误装配不能排整个工作树', async () => {
    const { root, storageRoot } = await fixture()
    const external = path(dirname(storageRoot), 'external-runtime')
    mkdirSync(external); writeFileSync(path(external, 'state.txt'), 'external-before')
    const pending = path(root, 'future-runtime/private/tmp')
    const opened = await openWorktreeSnapshots({ cwd: root, storageRoot, excludedRoots: [external, pending] })
    if (!opened.supported) throw new Error('夹具不是 Git 工作树')
    mkdirSync(pending, { recursive: true }); writeFileSync(path(pending, 'index'), 'temporary')
    writeFileSync(path(root, 'user.txt'), 'user-before')
    const before = await opened.store.capture()
    writeFileSync(path(external, 'state.txt'), 'external-after'); writeFileSync(path(root, 'user.txt'), 'user-after')
    const after = await opened.store.capture()
    expect(await opened.store.diff(before, after)).toEqual(['user.txt'])
    expect((await opened.store.captureReported()).report.files).toBe(1)
    const notGit = await openWorktreeSnapshots({ cwd: external, storageRoot: path(external, 'store'), excludedRoots: [pending] })
    expect(notGit).toEqual({ supported: false, reason: 'NOT_GIT_WORKTREE' })
    expect(existsSync(path(external, 'store'))).toBe(false)
    await expect(openWorktreeSnapshots({ cwd: root, storageRoot, excludedRoots: [root] })).rejects.toThrow('不能包含工作树或当前工作目录')
    await expect(openWorktreeSnapshots({ cwd: root, storageRoot, excludedRoots: [dirname(root)] })).rejects.toThrow('不能包含工作树或当前工作目录')
    await expect(openWorktreeSnapshots({ cwd: root, storageRoot, excludedRoots: ['relative/private/tmp'] })).rejects.toThrow('必须是绝对路径')
  }, 30_000)
})
