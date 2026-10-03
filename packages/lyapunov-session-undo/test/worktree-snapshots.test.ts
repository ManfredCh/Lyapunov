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
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
