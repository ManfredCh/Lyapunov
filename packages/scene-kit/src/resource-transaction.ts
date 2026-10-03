import { constants } from "node:fs"
import { copyFile, link, mkdir, open, stat, unlink } from "node:fs/promises"
import { dirname, resolve } from "node:path"

/**
 * 资源文件事务的持久化原语：目录创建与文件搬迁在返回前完成 fsync，
 * 崩溃恢复只依据磁盘上可验证的 inventory，不依赖内存状态。
 *
 * 目录整体搬迁的关键不只是每个文件各自搬走，还包括新建中间目录的
 * 目录条目本身：只 fsync 叶子目录时，父目录里指向它的条目仍可能丢失，
 * 让已落盘的文件变成孤儿。这里对缺失目录链自底向上逐级 fsync。
 *
 * 文件搬迁必须是排他的：计划阶段确认目标不存在之后，外部进程仍可能在
 * 搬迁中途创建同名文件，而 POSIX rename 会静默覆盖这类目标。同设备搬迁
 * 改用 link+unlink（新名字由内核原子独占创建，EEXIST 即目标冲突），
 * 不支持硬链接的文件系统退化为 COPYFILE_EXCL 的独占拷贝；两者都不覆盖
 * 任何已存在的目标，且任一崩溃点上至少有一个名字指向原字节。
 */

export type DurableMoveMode = "link" | "copy"

export async function syncDirectoryDurable(path: string): Promise<void> {
  const directory = await open(path, "r")
  try { await directory.sync() } finally { await directory.close() }
}

export async function syncFileDurable(path: string): Promise<void> {
  const file = await open(path, "r")
  try { await file.sync() } finally { await file.close() }
}

function parentConflict(path: string, error: unknown): Error {
  if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return new Error(`RESOURCE_MOVE_TARGET_PARENT_CONFLICT: ${path}`)
  return error as Error
}

/**
 * 只读检查：目录链上最近的已存在祖先必须是目录。计划阶段使用，
 * 避免把一个可预见的 ENOTDIR 失败留到搬迁中途。
 */
export async function assertDirectoryCreatable(path: string): Promise<void> {
  let current = resolve(path)
  for (;;) {
    try {
      const info = await stat(current)
      if (!info.isDirectory()) throw new Error(`RESOURCE_MOVE_TARGET_PARENT_CONFLICT: ${current}`)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOTDIR") throw parentConflict(current, error)
      if (code !== "ENOENT") throw error
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

/**
 * mkdir -p 的持久版本：创建缺失目录链后，先 fsync 每个新目录自身，
 * 再 fsync 最上层新目录的父目录，保证目录条目在崩溃后仍存在。
 * 返回本次实际 fsync 过的目录（去重前的顺序），供调用方记录证据。
 */
export async function ensureDirectoryDurable(path: string, synced: string[] = []): Promise<string[]> {
  const target = resolve(path), missing: string[] = []
  let current = target
  for (;;) {
    try {
      const info = await stat(current)
      if (!info.isDirectory()) throw new Error(`RESOURCE_MOVE_TARGET_PARENT_CONFLICT: ${current}`)
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOTDIR") throw parentConflict(current, error)
      if (code !== "ENOENT") throw error
    }
    missing.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  if (!missing.length) return synced
  await mkdir(target, { recursive: true })
  for (const directory of missing) { await syncDirectoryDurable(directory); synced.push(directory) }
  const outermost = dirname(missing[missing.length - 1]!)
  await syncDirectoryDurable(outermost)
  synced.push(outermost)
  return synced
}

/**
 * 排他搬迁：目标路径已存在时绝不覆盖。同设备用 link+unlink（新名字由内核
 * 原子独占创建，EEXIST 即目标冲突），不支持硬链接的文件系统退化为
 * COPYFILE_EXCL 的独占拷贝。先 fsync 目标目录让新名字落盘，再 unlink 源，
 * 因此任一崩溃点上至少有一个名字仍然有效。调用方已写好 prepared journal。
 */
export async function moveFileDurable(sourcePath: string, targetPath: string, synced: string[] = []): Promise<DurableMoveMode> {
  await ensureDirectoryDurable(dirname(targetPath), synced)
  await syncFileDurable(sourcePath)
  try {
    await link(sourcePath, targetPath)
    await syncDirectoryDurable(dirname(targetPath)); synced.push(dirname(targetPath))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EEXIST") throw new Error(`RESOURCE_MOVE_TARGET_CONFLICT: ${targetPath}`)
    // EXDEV 或文件系统不支持硬链接（FUSE/网络盘等）时退化为独占拷贝；
    // COPYFILE_EXCL 同样以 EEXIST 拒绝已存在的目标，不会静默覆盖。
    if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS"].includes(code ?? "")) throw error
    try {
      await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL)
    } catch (copyError) {
      if ((copyError as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`RESOURCE_MOVE_TARGET_CONFLICT: ${targetPath}`)
      throw copyError
    }
    await syncFileDurable(targetPath)
    await syncDirectoryDurable(dirname(targetPath)); synced.push(dirname(targetPath))
    await unlink(sourcePath)
    await syncDirectoryDurable(dirname(sourcePath)); synced.push(dirname(sourcePath))
    return "copy"
  }
  await unlink(sourcePath)
  await syncDirectoryDurable(dirname(sourcePath)); synced.push(dirname(sourcePath))
  return "link"
}

/** 对一组目录去重后 fsync；目录已不存在（并发清理）时跳过而不伪造失败。 */
export async function syncDirectoriesDurable(directories: Iterable<string>, synced: string[] = []): Promise<string[]> {
  for (const directory of new Set(Array.from(directories, value => resolve(value)))) {
    try { await syncDirectoryDurable(directory) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    synced.push(directory)
  }
  return synced
}

export interface DurableMoveOutcome { modes: DurableMoveMode[]; syncedDirectories: string[] }

/**
 * 按顺序搬迁一组文件；每个文件移动并 fsync 后才回调 afterFileMoved，
 * 让调用方把进度写进 journal 时不会领先于磁盘事实。全部完成后再做一次
 * 批次目录屏障。中途失败时尽力同步已触碰目录后原样抛出，由恢复流程判定。
 */
export async function moveFilesDurable(
  files: readonly { sourcePath: string; targetPath: string }[],
  hooks: { afterFileMoved?: (file: { sourcePath: string; targetPath: string }, index: number, mode: DurableMoveMode) => Promise<void> | void } = {},
): Promise<DurableMoveOutcome> {
  const synced: string[] = [], modes: DurableMoveMode[] = []
  try {
    for (const [index, file] of files.entries()) {
      const mode = await moveFileDurable(file.sourcePath, file.targetPath, synced)
      modes.push(mode)
      await hooks.afterFileMoved?.(file, index, mode)
    }
  } catch (error) {
    try { await syncDirectoriesDurable(synced) } catch { /* 原始搬迁错误才是调用者需要的失败原因 */ }
    throw error
  }
  await syncDirectoriesDurable(synced)
  return { modes, syncedDirectories: [...new Set(synced)] }
}
