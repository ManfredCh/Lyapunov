import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"

export async function atomicJSON(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, "wx", 0o600)
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n")
    await file.sync()
  } finally { await file.close() }
  try { await rename(temporary, path) } catch (error) { await rm(temporary, { force: true }); throw error }
  const directory = await open(dirname(path), "r")
  try { await directory.sync() } finally { await directory.close() }
}

export async function readJSON<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T
}

/** 锁只覆盖一个文件事务；崩溃遗留锁会明确报错，不猜测并删掉另一个 Host 的锁。 */
export async function fileTransaction<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true })
  const lock = `${path}.lock`
  const deadline = Date.now() + 5000
  for (;;) {
    try { await mkdir(lock); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (Date.now() >= deadline) throw new Error(`SCENE_BUSY: ${path}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  try { return await fn() } finally {
    // 清理锁失败**不能**把一次已经落盘的交易报成失败：目录整个被删除（dataRoot 收尾、测试 teardown）
    // 时 rm 会 ENOENT，而 fn() 里的写早已生效——调用方若把这次当失败，会去清掉刚写下的产物、
    // 用 failed 覆盖成功的回执（真实撞到过：派生 ok 回执已可见，随后却记了一条"失败标记"）。
    // 失败只记日志：锁残留会让后续事务等超时并显式报 SCENE_BUSY，这里不假装它没发生。
    await rm(lock, { recursive: true, force: true }).catch(error => console.debug(`fileTransaction 锁清理失败 ${lock}: ${String(error)}`))
  }
}

/** ID 必须是字符串：RegExp.test 会把 undefined/null/数字/布尔先转成字符串匹配，外部 JSON 的
 * 缺失键或数字 ID 会被误验为有效并写出 undefined.json / 数字 sceneId（CR-002）。 */
export function safeId(value: string): string {
  if (typeof value !== "string") throw new Error(`INVALID_ID_TYPE: ${typeof value}`)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)) throw new Error(`INVALID_ID: ${value}`)
  return value
}
