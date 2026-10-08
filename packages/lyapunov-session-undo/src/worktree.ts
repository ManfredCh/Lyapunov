import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rmdir, symlink, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { canonicalTargetPath, SESSION_PRIVATE_PARENT } from '../../lyapunov-contracts/src/writable-boundary.ts'

export interface SnapshotRef { version: 1; worktree: string; tree: string }
export interface CaptureReport {
  version: 1
  /** 没有可用增量状态、必须读取整棵工作树的基线快照。 */
  full: boolean
  /** 本次快照包含的叶路径数。 */
  files: number
  /** 本次真正读取并写入私有对象库的文件数。 */
  hashed: number
  /** 依指纹确认未改动、直接复用上次对象的文件数。 */
  reused: number
  /** 本次从工作树读取的源字节数。 */
  bytesRead: number
  ms: number
}
export interface CaptureResult { ref: SnapshotRef; report: CaptureReport }
export interface RestoreRequest { operationId: string; sessionId: string; target: SnapshotRef; paths: readonly string[] }
export interface RestoreTransaction {
  operationId: string
  sessionId: string
  /** 文件已恢复，调用方持久化原生 Session 操作后才能 commit。 */
  commit(): Promise<void>
  rollback(): Promise<void>
}
export interface RecoveryResult { operationId: string; sessionId: string; outcome: 'committed' | 'rolled-back' }
/** recovered 只在相关原件已回滚且 journal 清除完成后为 true。 */
export class RestoreError extends Error {
  readonly operationId: string
  readonly recovered: boolean
  constructor(operationId: string, recovered: boolean, cause: unknown) {
    super((recovered ? '文件恢复失败，原件已回滚：' : '文件恢复未完成，需要恢复 journal：') + (cause instanceof Error ? cause.message : String(cause)), { cause })
    this.name = 'RestoreError'; this.operationId = operationId; this.recovered = recovered
  }
}
type Entry = { mode: '100644' | '100755' | '120000'; oid: string }
type Directory = { path: string; mode: number }
/** 复用上次对象所需的文件指纹；字符串保存纳秒时间戳与inode，避免JSON精度丢失。 */
type CaptureEntry = Entry & { size: string; mtimeNs: string; ctimeNs: string; ino: string }
interface CaptureState { version: 1; observedAtNs: string; tree: string; entries: Record<string, CaptureEntry> }
interface Journal extends RestoreRequest {
  version: 1
  phase: 'prepared' | 'applied'
  before: SnapshotRef
  directories: Directory[]
  modes: Record<string, number>
  temporaryFiles: Record<string, string>
}
const queues = new Map<string, Promise<unknown>>()
const isWithin = (parent: string, path: string) => path === parent || path.startsWith(parent + sep)
const absent = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
/**
 * 工作树里的**会话私有运行目录**（`<工作树>/.lyapunov/sessions/**`）不进入撤销的文件域。
 *
 * 这条落点是产品按会话分配的运行态（sim worker、Kit 引擎缓存、导入缓存、内部临时目录），归属规则由
 * `lyapunov-contracts/writable-boundary.ts` 的 `SESSION_PRIVATE_PARENT` 唯一给出，别的会话写它要被明确拒绝
 * （见 scene-kit 的 `SCENE_POLICY_CROSS_SESSION`）。撤销的工作树快照**必须尊重同一条边界**，因为
 * "整工作树 + 路径差集"会把这里也收进来：
 *   · 同一工作区的**另一条会话**正在用它——回滚它等于一次跨会话误写（另一条会话的运行文件被换成旧字节）；
 *   · 本会话自己的引擎缓存/运行根被回滚到旧状态同样是损坏运行态，不是用户内容的历史。
 * 捕获、diff 与恢复三条路径共用这一份判据；`paths` 里遗留的旧路径（修复前写下的 checkpoint/redo 点/journal）
 * 在恢复时被**跳过**：不存在的目标不重建、存在的目标不动一个字节（宁可不回滚运行态，也不跨会话误写）。
 */
const isSessionRuntime = (path: string): boolean => path === SESSION_PRIVATE_PARENT || path.startsWith(SESSION_PRIVATE_PARENT + '/')

async function git(cwd: string, args: string[], input?: Buffer, extraEnv: Record<string, string> = {}, accepted = [0]): Promise<Buffer> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  return new Promise((done, fail) => {
    const child = spawn('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] })
    const output: Buffer[] = [], errors: Buffer[] = []
    child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk))
    child.once('error', fail); child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') fail(error) })
    child.once('close', code => accepted.includes(code ?? -1) ? done(Buffer.concat(output)) : fail(new Error('Git 快照命令失败：' + args[0] + '\n' + Buffer.concat(errors).toString())))
    child.stdin.end(input)
  })
}
const nulPaths = (paths: readonly string[]) => Buffer.from(paths.length ? paths.join('\0') + '\0' : '')
const splitNul = (data: Buffer) => data.toString().split('\0').filter(Boolean)

async function syncDirectory(path: string): Promise<void> { const file = await open(path, 'r'); try { await file.sync() } finally { await file.close() } }
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp', file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync() } finally { await file.close() }
  await rename(temporary, path); await syncDirectory(dirname(path))
}

/** 仅打开真实 Git 工作树；storageRoot 是这个工作树专用的 DSH 私有目录。 */
export async function openWorktreeSnapshots(options: { cwd: string; storageRoot: string; excludedRoots?: readonly string[] }): Promise<
  { supported: false; reason: 'NOT_GIT_WORKTREE' } | { supported: true; store: WorktreeSnapshots }
> {
  const cwd = await realpath(options.cwd)
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'], undefined, {}, [0, 128])
  if (inside.toString().trim() !== 'true') return { supported: false, reason: 'NOT_GIT_WORKTREE' }
  const worktree = await realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).toString().replace(/\n$/, ''))
  const sourceGit = await realpath((await git(cwd, ['rev-parse', '--absolute-git-dir'])).toString().replace(/\n$/, ''))
  const sourceCommon = await realpath((await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toString().replace(/\n$/, ''))
  // 装配方仅登记明确的非用户运行目录；不存在的末端使用产品共用的规范路径规则。
  const excludedRoots = [...new Set((options.excludedRoots ?? []).map(root => {
    if (!isAbsolute(root)) throw new Error('排除运行目录必须是绝对路径')
    const canonical = canonicalTargetPath(root)
    if (isWithin(canonical, worktree) || isWithin(canonical, cwd)) throw new Error('排除运行目录不能包含工作树或当前工作目录')
    return canonical
  }))]
  const requested = resolve(options.storageRoot)
  if (requested === worktree || isWithin(sourceGit, requested) || isWithin(sourceCommon, requested)) throw new Error('快照目录不能是工作树本身或用户 Git 目录')
  await mkdir(requested, { recursive: true, mode: 0o700 })
  const storageRoot = await realpath(requested)
  if (storageRoot === worktree || isWithin(sourceGit, storageRoot) || isWithin(sourceCommon, storageRoot)) throw new Error('快照目录不能指向工作树本身或用户 Git 目录')
  const store = new WorktreeSnapshots(worktree, storageRoot, excludedRoots)
  await store.initialize()
  return { supported: true, store }
}

/** Git 只保存文件对象；事务日志只协调文件恢复，不拥有 Session 或 Agent 状态。 */
export class WorktreeSnapshots {
  private readonly objects: string
  private readonly journals: string
  readonly worktree: string
  readonly storageRoot: string
  constructor(worktree: string, storageRoot: string, private readonly excludedRoots: readonly string[] = []) {
    this.worktree = worktree; this.storageRoot = storageRoot
    this.objects = join(storageRoot, 'git'); this.journals = join(storageRoot, 'journals')
  }
  /** 产品运行目录与会话私有目录不属于用户文件撤销域。 */
  private excludes(path: string): boolean {
    return isSessionRuntime(path) || this.excludedRoots.some(root => isWithin(root, join(this.worktree, path)))
  }
  async initialize(): Promise<void> {
    await this.exclusive(async () => {
      const identity = join(this.storageRoot, 'worktree.json')
      try { if (JSON.parse(await readFile(identity, 'utf8')).worktree !== this.worktree) throw new Error('快照目录属于另一个工作树') }
      catch (error) { if (!absent(error)) throw error; await atomicJson(identity, { version: 1, worktree: this.worktree }) }
      await mkdir(this.journals, { recursive: true, mode: 0o700 })
      try { await lstat(join(this.objects, 'HEAD')) } catch (error) { if (!absent(error)) throw error; await git(this.storageRoot, ['init', '--bare', this.objects]) }
    })
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.storageRoot) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      const path = join(this.storageRoot, 'operation.lock')
      try { await symlink(String(process.pid), path) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const pid = Number(await readlink(path))
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('无法识别快照操作锁')
        let alive = true
        try { process.kill(pid, 0) } catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw failure }
        if (alive) throw new Error('WORKTREE_BUSY: 另一个进程正在操作快照')
        await unlink(path); await symlink(String(process.pid), path)
      }
      try { return await operation() }
      finally { await unlink(path) }
    })
    queues.set(this.storageRoot, pending)
    try { return await pending } finally { if (queues.get(this.storageRoot) === pending) queues.delete(this.storageRoot) }
  }
  private privateGit(args: string[], input?: Buffer, env?: Record<string, string>, accepted?: number[]): Promise<Buffer> {
    return git(this.worktree, ['--git-dir=' + this.objects, '--work-tree=' + this.worktree, ...args], input, env, accepted)
  }
  private checkedPath(path: string): string {
    if (!path || isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git') || path.includes('\0')) throw new Error('无效的快照相对路径：' + path)
    if (isWithin(this.storageRoot, join(this.worktree, path))) throw new Error('恢复路径不能包含快照私有目录')
    return path
  }
  private ref(tree: string): SnapshotRef { return { version: 1, worktree: this.worktree, tree } }
  private checkRef(ref: SnapshotRef): void {
    if (ref.version !== 1 || ref.worktree !== this.worktree || !/^[a-f0-9]{40,64}$/.test(ref.tree)) throw new Error('快照引用不属于当前工作树')
  }
  /** 不沿祖先符号链接读取；文件/链接阻挡的后代在当前树中不存在。 */
  private async info(path: string) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      try { if (!(await lstat(join(this.worktree, ...parts.slice(0, i)))).isDirectory()) return undefined }
      catch (error) { if (absent(error)) return undefined; throw error }
    }
    try { return await lstat(join(this.worktree, path)) } catch (error) { if (absent(error)) return undefined; throw error }
  }
  private async treeFor(paths: readonly string[]): Promise<SnapshotRef> {
    const lines: string[] = [], index = join(this.storageRoot, 'index-' + randomUUID())
    try {
      for (const path of paths) {
        this.checkedPath(path)
        const info = await this.info(path)
        if (!info || info.isDirectory()) continue
        if (!info.isFile() && !info.isSymbolicLink()) throw new Error('快照不支持特殊文件：' + path)
        const bytes = info.isSymbolicLink() ? Buffer.from(await readlink(join(this.worktree, path))) : await readFile(join(this.worktree, path))
        const oid = (await this.privateGit(['hash-object', '-w', '--stdin'], bytes)).toString().trim()
        lines.push((info.isSymbolicLink() ? '120000' : info.mode & 0o111 ? '100755' : '100644') + ' ' + oid + '\t' + path)
      }
      const env = { GIT_INDEX_FILE: index }
      await this.privateGit(['read-tree', '--empty'], undefined, env)
      if (lines.length) await this.privateGit(['update-index', '-z', '--index-info'], nulPaths(lines), env)
      return this.ref((await this.privateGit(['write-tree'], undefined, env)).toString().trim())
    } finally { await unlink(index).catch(error => { if (!absent(error)) throw error }) }
  }
  /** 捕获整个工作树的 Git 可见文件；遵循忽略规则，不修改用户索引或 HEAD。 */
  async capture(): Promise<SnapshotRef> { return (await this.captureReported()).ref }
  /** 与capture同一实现；额外返回本次增量统计，并在需要整树基线读取前通知调用方。 */
  captureReported(onPreparing?: () => Promise<void>): Promise<CaptureResult> {
    return this.exclusive(async () => {
      const started = process.hrtime.bigint()
      const observedAtNs = BigInt(Date.now()) * 1000000n
      const previous = await this.captureState()
      if (!previous) await onPreparing?.()
      // 尾随斜杠是git对“不递归的未跟踪目录”（如嵌套仓库）的整体标记，不是可快照叶路径；其内容git也不会逐个列出。
      // 忽略规则已由--exclude-standard施加在未跟踪文件上，且忽略规则从不作用于已跟踪文件；
      // 曾用check-ignore --no-index复核会误删已跟踪的*.log等文件，并让每步空转约0.5秒。
      const candidates = [...new Set(splitNul(await git(this.worktree, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])))].filter(path => !path.endsWith('/') && !path.split('/').includes('.git') && !isWithin(this.storageRoot, join(this.worktree, path)) && !this.excludes(path))
      const directories = new Map<string, boolean>(), entries = new Map<string, CaptureEntry>(), unhashed = new Map<string, { mode: Entry['mode']; size: string; mtimeNs: string; ctimeNs: string; ino: string; link: boolean }>()
      let reused = 0, bytesRead = 0
      for (const path of candidates) {
        this.checkedPath(path)
        const info = await this.captureInfo(path, directories)
        if (!info || info.isDirectory()) continue
        if (!info.isFile() && !info.isSymbolicLink()) throw new Error('快照不支持特殊文件：' + path)
        const mode: Entry['mode'] = info.isSymbolicLink() ? '120000' : info.mode & 0o111n ? '100755' : '100644'
        const fingerprint = { mode, size: info.size.toString(), mtimeNs: info.mtimeNs.toString(), ctimeNs: info.ctimeNs.toString(), ino: info.ino.toString() }
        const cached = previous?.entries[path]
        // 只有在上次捕捉开始前就已定稿的文件才可复用，避免把捕捉窗口内的半成品当成稳定内容。
        const stable = cached && cached.mode === fingerprint.mode && cached.size === fingerprint.size && cached.mtimeNs === fingerprint.mtimeNs && cached.ctimeNs === fingerprint.ctimeNs && cached.ino === fingerprint.ino && BigInt(fingerprint.mtimeNs) < BigInt(previous!.observedAtNs)
        if (stable) { entries.set(path, cached); reused++ } else unhashed.set(path, { ...fingerprint, link: info.isSymbolicLink() })
      }
      if (unhashed.size) {
        for (const file of unhashed.values()) bytesRead += Number(file.size)
        for (const [path, oid] of await this.hashEntries(unhashed)) {
          const file = unhashed.get(path)!
          entries.set(path, { mode: file.mode, oid, size: file.size, mtimeNs: file.mtimeNs, ctimeNs: file.ctimeNs, ino: file.ino })
        }
      }
      const untouched = previous !== undefined && unhashed.size === 0 && entries.size === Object.keys(previous.entries).length
      let tree = previous ? previous.tree : ''
      if (!untouched) {
        const index = join(this.storageRoot, 'index-' + randomUUID()), lines = [...entries].map(([path, entry]) => entry.mode + ' ' + entry.oid + '\t' + path)
        const env = { GIT_INDEX_FILE: index }
        try {
          await this.privateGit(['read-tree', '--empty'], undefined, env)
          if (lines.length) await this.privateGit(['update-index', '-z', '--index-info'], nulPaths(lines), env)
          tree = (await this.privateGit(['write-tree'], undefined, env)).toString().trim()
        } finally { await unlink(index).catch(error => { if (!absent(error)) throw error }) }
        await atomicJson(join(this.storageRoot, 'capture.json'), { version: 1, observedAtNs: observedAtNs.toString(), tree, entries: Object.fromEntries(entries) } satisfies CaptureState)
      }
      return { ref: this.ref(tree), report: { version: 1, full: previous === undefined, files: entries.size, hashed: unhashed.size, reused, bytesRead, ms: Number(process.hrtime.bigint() - started) / 1e6 } }
    })
  }
  /** 增量状态只记录“上次捕捉观察到什么”，不是历史事实；缺失或对象已不在时退化为整树重读。 */
  private async captureState(): Promise<CaptureState | undefined> {
    let state: CaptureState
    try { state = JSON.parse(await readFile(join(this.storageRoot, 'capture.json'), 'utf8')) as CaptureState }
    catch (error) { if (absent(error) || error instanceof SyntaxError) return undefined; throw error }
    if (state?.version !== 1 || !/^[a-f0-9]{40,64}$/.test(state.tree ?? '') || typeof state.observedAtNs !== 'string' || typeof state.entries !== 'object' || state.entries === null) return undefined
    const kind = await this.privateGit(['cat-file', '-t', state.tree], undefined, {}, [0, 128]).then(output => output.toString().trim(), () => '')
    return kind === 'tree' ? state : undefined
  }
  /** 祖先目录检查在同一次捕捉内记忆；叶节点额外取纳秒时间戳作为增量指纹。 */
  private async captureInfo(path: string, directories: Map<string, boolean>) {
    const parts = path.split('/')
    let ancestor = ''
    for (let i = 0; i < parts.length - 1; i++) {
      ancestor = i === 0 ? parts[0]! : ancestor + '/' + parts[i]!
      let directory = directories.get(ancestor)
      if (directory === undefined) {
        try { directory = (await lstat(join(this.worktree, ancestor))).isDirectory() }
        catch (error) { if (!absent(error)) throw error; directory = false }
        directories.set(ancestor, directory)
      }
      if (!directory) return undefined
    }
    try { return await lstat(join(this.worktree, path), { bigint: true }) } catch (error) { if (absent(error)) return undefined; throw error }
  }
  /** 单进程批量写入对象，保持与treeFor相同的原始字节语义；换行、符号链接与双引号开头的路径退回逐文件。
      --stdin-paths 逐行读取裸路径：换行会截断一行，而以双引号开头的一行会被 git 按 C 引用语法解释
      （只有开引号会 fatal: line is badly quoted 让整次快照失败，两端引号会被去引号后读到同名普通文件）。 */
  private async hashEntries(files: ReadonlyMap<string, { link: boolean }>): Promise<Map<string, string>> {
    const result = new Map<string, string>(), bulkSafe = (path: string, file: { link: boolean }) => !file.link && !path.includes('\n') && !path.startsWith('"'), bulk = [...files].filter(([path, file]) => bulkSafe(path, file)).map(([path]) => path)
    if (bulk.length) {
      // 私有库对象只被本组件cat-file读取；等级0不为本地快照付压缩代价，首快照吞吐提高约5倍。
      const output = await this.privateGit(['-c', 'core.looseCompression=0', 'hash-object', '-w', '--stdin-paths', '--no-filters'], Buffer.from(bulk.join('\n') + '\n'))
      const oids = output.toString().split('\n').filter(Boolean)
      if (oids.length !== bulk.length) throw new Error('Git 快照命令失败：hash-object --stdin-paths 返回数量不一致')
      bulk.forEach((path, index) => result.set(path, oids[index]!.trim()))
    }
    for (const [path, file] of files) {
      if (bulkSafe(path, file)) continue
      const bytes = file.link ? Buffer.from(await readlink(join(this.worktree, path))) : await readFile(join(this.worktree, path))
      result.set(path, (await this.privateGit(['-c', 'core.looseCompression=0', 'hash-object', '-w', '--stdin'], bytes)).toString().trim())
    }
    return result
  }
  /** 返回两个树之间变化的精确叶路径；重命名表现为删除和新增，NUL 分隔避免路径转义。 */
  diff(before: SnapshotRef, after: SnapshotRef): Promise<string[]> {
    return this.exclusive(async () => {
      this.checkRef(before); this.checkRef(after)
      // 同一排除判据保护旧快照：运行目录不构成用户撤销路径。
      return splitNul(await this.privateGit(['diff-tree', '-r', '--no-renames', '--name-only', '-z', before.tree, after.tree])).map(path => this.checkedPath(path)).filter(path => !this.excludes(path))
    })
  }
  private async entries(ref: SnapshotRef): Promise<Map<string, Entry>> {
    this.checkRef(ref)
    const result = new Map<string, Entry>()
    for (const row of splitNul(await this.privateGit(['ls-tree', '-r', '-z', '--full-tree', ref.tree]))) {
      const tab = row.indexOf('\t'), [mode, type, oid] = row.slice(0, tab).split(' '), path = row.slice(tab + 1)
      this.checkedPath(path)
      if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode!)) throw new Error('快照包含不支持的 Git 条目：' + path)
      result.set(path, { mode: mode as Entry['mode'], oid: oid! })
    }
    return result
  }
  private journalPath(operationId: string): string {
    if (!operationId || operationId === '.' || operationId === '..') throw new Error('operationId不能为空或目录标记')
    return join(this.journals, encodeURIComponent(operationId) + '.json')
  }
  private async pending(): Promise<string[]> { return (await readdir(this.journals)).filter(name => name.endsWith('.json')) }
  /** 保存当前相关文件、持久化 journal，再应用目标；失败时自动恢复相关原件。 */
  beginRestore(request: RestoreRequest): Promise<RestoreTransaction> {
    return this.exclusive(async () => {
      if (!request.sessionId) throw new Error('sessionId不能为空')
      const path = this.journalPath(request.operationId)
      if ((await this.pending()).length) throw new Error('WORKTREE_RESTORE_PENDING: 先完成或恢复已有文件事务')
      const paths = [...new Set(request.paths.map(path => this.checkedPath(path)))].filter(path => !this.excludes(path)).sort()
      const target = await this.entries(request.target)
      const plan = await this.plan(paths, target, [])
      const before = await this.treeFor(paths), directories: Directory[] = [], modes: Record<string, number> = {}, temporaryFiles: Record<string, string> = {}
      for (const directory of new Set([...paths, ...plan.removeDirectories])) { const info = await this.info(directory); if (info?.isDirectory()) directories.push({ path: directory, mode: info.mode & 0o777 }) }
      for (const file of paths) { const info = await this.info(file); if (info?.isFile()) modes[file] = info.mode & 0o777 }
      for (const file of paths) temporaryFiles[file] = join(dirname(file), '.lyapunov-restore-' + randomUUID())
      const journal: Journal = { ...request, paths, version: 1, phase: 'prepared', before, directories, modes, temporaryFiles }
      try { await atomicJson(path, journal) }
      catch (error) {
        // rename 后的目录同步也可能失败；只要 journal 仍在，就交给明确恢复流程。
        try { await lstat(path) } catch (inspectionError) { if (absent(inspectionError)) throw error; throw new RestoreError(request.operationId, false, error) }
        throw new RestoreError(request.operationId, false, error)
      }
      try { await this.apply(journal.paths, target, [], {}, temporaryFiles); journal.phase = 'applied'; await atomicJson(path, journal) }
      catch (error) {
        try { await this.cleanTemporary(journal); await this.apply(journal.paths, await this.entries(before), directories, modes, temporaryFiles); await this.removeJournal(path) }
        catch (rollbackError) { throw new RestoreError(request.operationId, false, new AggregateError([error, rollbackError], '恢复与回滚均未完成，文件原件与 journal 已保留')) }
        throw new RestoreError(request.operationId, true, error)
      }
      return { operationId: request.operationId, sessionId: request.sessionId, commit: () => this.finish(request.operationId, true), rollback: () => this.finish(request.operationId, false) }
    })
  }
  private async removeJournal(path: string): Promise<void> { await unlink(path); await syncDirectory(this.journals) }
  private async finish(operationId: string, committed: boolean): Promise<void> {
    try { await this.exclusive(async () => {
      const path = this.journalPath(operationId), journal = JSON.parse(await readFile(path, 'utf8')) as Journal
      if (committed && journal.phase !== 'applied') throw new Error('文件恢复尚未完成，不能commit')
      await this.cleanTemporary(journal)
      if (!committed) await this.apply(journal.paths, await this.entries(journal.before), journal.directories, journal.modes, journal.temporaryFiles)
      await this.removeJournal(path)
    }) } catch (error) { if (!committed) throw new RestoreError(operationId, false, error); throw error }
  }
  /** 调用方只查询原生 Session 操作是否已持久化；查询失败时保留文件与journal。 */
  recover(isPersisted: (operationId: string, sessionId: string) => Promise<boolean>): Promise<RecoveryResult[]> {
    return this.exclusive(async () => {
      const results: RecoveryResult[] = []
      for (const name of await this.pending()) {
        const path = join(this.journals, name), journal = JSON.parse(await readFile(path, 'utf8')) as Journal
        if (journal.version !== 1 || path !== this.journalPath(journal.operationId)) throw new Error('无法识别文件恢复journal')
        const committed = await isPersisted(journal.operationId, journal.sessionId)
        await this.cleanTemporary(journal)
        await this.apply(journal.paths, await this.entries(committed ? journal.target : journal.before), committed ? [] : journal.directories, committed ? {} : journal.modes, journal.temporaryFiles)
        await this.removeJournal(path)
        results.push({ operationId: journal.operationId, sessionId: journal.sessionId, outcome: committed ? 'committed' : 'rolled-back' })
      }
      return results
    })
  }
  private async plan(paths: readonly string[], entries: Map<string, Entry>, restoredDirectories: Directory[]) {
    const selected = new Set(paths.map(path => this.checkedPath(path))), desired = new Map([...entries].filter(([path]) => selected.has(path)))
    const directories = new Set(restoredDirectories.map(row => this.checkedPath(row.path)))
    for (const path of [...desired.keys(), ...directories]) {
      let parent = dirname(path)
      while (parent !== '.') { directories.add(parent); parent = dirname(parent) }
    }
    const removeLeaves = new Set<string>(), removeDirectories = new Set<string>()
    const visitRemoval = async (path: string): Promise<void> => {
      for (const name of await readdir(join(this.worktree, path))) {
        const child = this.checkedPath(path + '/' + name), info = await this.info(child)
        if (info?.isDirectory()) await visitRemoval(child)
        else { if (!selected.has(child)) throw new Error('RESTORE_PATH_CONFLICT: 恢复会覆盖未指定文件：' + child); removeLeaves.add(child) }
      }
      removeDirectories.add(path)
    }
    for (const path of selected) {
      const info = await this.info(path)
      if (info?.isDirectory() && !directories.has(path)) await visitRemoval(path)
      else if (info && !info.isDirectory() && !desired.has(path)) removeLeaves.add(path)
    }
    for (const path of directories) {
      const info = await this.info(path)
      if (info && !info.isDirectory()) { if (!selected.has(path)) throw new Error('RESTORE_PATH_CONFLICT: 父路径不是目录：' + path); removeLeaves.add(path) }
    }
    return { desired, directories, removeLeaves, removeDirectories }
  }
  private async cleanTemporary(journal: Journal): Promise<void> {
    for (const [file, path] of Object.entries(journal.temporaryFiles)) {
      this.checkedPath(path)
      if (dirname(path) !== dirname(file) || !path.split('/').at(-1)?.startsWith('.lyapunov-restore-')) throw new Error('无效的恢复临时文件记录')
      if (!this.excludes(file) && !this.excludes(path) && await this.info(path)) await unlink(join(this.worktree, path))
    }
  }
  private async apply(paths: readonly string[], entries: Map<string, Entry>, restoredDirectories: Directory[], modes: Record<string, number>, temporaryFiles: Record<string, string>): Promise<void> {
    // 产品/会话私有运行目录不落字节，含修复前 journal/redo 点的遗留路径。
    paths = paths.filter(path => !this.excludes(path))
    restoredDirectories = restoredDirectories.filter(row => !this.excludes(row.path))
    const plan = await this.plan(paths, entries, restoredDirectories), contents = new Map<string, Buffer>()
    for (const [path, entry] of plan.desired) contents.set(path, await this.privateGit(['cat-file', 'blob', entry.oid]))
    const deepest = (a: string, b: string) => b.split('/').length - a.split('/').length
    for (const path of [...plan.removeLeaves].sort(deepest)) await unlink(join(this.worktree, path))
    for (const path of [...plan.removeDirectories].sort(deepest)) await rmdir(join(this.worktree, path))
    for (const path of [...plan.directories].sort((a, b) => -deepest(a, b))) {
      if (!(await this.info(path))) await mkdir(join(this.worktree, path))
    }
    for (const [path, entry] of plan.desired) {
      const destination = join(this.worktree, path), bytes = contents.get(path)!, info = await this.info(path)
      const mode = modes[path] ?? (entry.mode === '100755' ? 0o755 : 0o644)
      if (entry.mode === '120000' && info?.isSymbolicLink() && await readlink(destination) === bytes.toString()) continue
      if (entry.mode !== '120000' && info?.isFile() && (info.mode & 0o777) === mode && (await readFile(destination)).equals(bytes)) continue
      const temporary = join(this.worktree, this.checkedPath(temporaryFiles[path]!))
      try {
        if (entry.mode === '120000') await symlink(bytes.toString(), temporary)
        else { const file = await open(temporary, 'wx', mode); try { await file.writeFile(bytes); await file.chmod(mode); await file.sync() } finally { await file.close() } }
        await rename(temporary, destination); await syncDirectory(dirname(destination))
      } finally { await unlink(temporary).catch(error => { if (!absent(error)) throw error }) }
    }
    for (const row of restoredDirectories) if ((await this.info(row.path))?.isDirectory()) await chmod(join(this.worktree, row.path), row.mode)
    await syncDirectory(this.worktree)
  }
}
