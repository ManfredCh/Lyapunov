/**
 * 生成插件共享的**作业记录落盘**（DEV-018/P7 合并点）。
 *
 * `generate-hunyuan` / `generate-marble` / `generate-image` / `generate-tripo` 原先各有一份**逐字相同**
 * 的 `persist` 闭包（`{...record, ...binding, ...update, updatedAt}` + 临时文件 + `rename` + `mode: 0o600`），
 * 四份合到这里一处；四包的错误/取消语义留在各自 `operations.ts`，一个字都没动。
 *
 * 规则就两条，都只在本文件里：
 *  1. **合并顺序**：`{...当前记录, ...binding, ...update, updatedAt: 写入时刻}`——路由绑定
 *     （mode/accountId/apiUrl/serverRequestId）在前、本次变化在后、`updatedAt` 恒为写入时刻；
 *  2. **原子落盘**：同目录临时文件（`<目标>.<uuid>.tmp`）写全后 `rename` 覆盖，`mode: 0o600`。
 *     记录文件是"重启后不要第二次提交收费任务"的唯一依据，半截 JSON 会被读成"没有记录"。
 *
 * 落点选在 `generate-hunyuan/src/`：本包已是这一族的共享助手位置——`./url-safety.ts` 同样被
 * `generate-tripo` 以 `../../generate-hunyuan/src/url-safety.ts` 复用（该包 exports 映射里也只有
 * `.` 与 `./operations`，相对导入即内部共享）。因此不需要新包、新 exports 映射或新框架。
 */
import { randomUUID } from "node:crypto"
import { rename, writeFile } from "node:fs/promises"

/** 本族唯一一处"临时文件 + rename + 0600"：先写同目录临时文件，再原子替换目标。 */
export async function writeFileAtomic0600(target: string, data: string | Uint8Array): Promise<void> {
  const temporary = target + "." + randomUUID() + ".tmp"
  await writeFile(temporary, data, { mode: 0o600 })
  await rename(temporary, target)
}

/** 作业记录的最小形状：每次落盘都会把 `updatedAt` 刷成写入时刻。 */
export interface JobRecordLike {
  updatedAt: string
}

export interface JobRecordPersisterOptions<T extends JobRecordLike> {
  /** 记录文件路径（四包都是 `<dataDirectory>/<requestId>.json`）。 */
  file: string
  /** 本次调用绑定的路由身份（formal/developer + 账户/入口/服务端请求行）；每次落盘都重新盖上去。 */
  binding: Partial<T>
  /** 读调用方的内存态记录；落盘内容与它同源。 */
  read: () => T | undefined
  /**
   * 合并结果**先**回写内存态、再落盘。顺序与原实现一致且必须保留：写盘失败时内存态也已更新，
   * 四包 catch 分支据此读 `record.operationId` 判断"远端作业已确认提交"（丢了它，落盘的
   * interrupted/cancelled-local 记录会少一个作业ID，取消报告的 `submissionConfirmed` 也会失真）。
   */
  write: (record: T) => void
}

/**
 * 造一份 `persist(update)`：合并 → 回写内存态 → 原子落盘。
 * 返回签名与四包原来的闭包相同（`(update: Partial<T>) => Promise<void>`），调用方其余代码不变。
 */
export function createJobRecordPersister<T extends JobRecordLike>(
  options: JobRecordPersisterOptions<T>,
): (update: Partial<T>) => Promise<void> {
  return async (update) => {
    const record = { ...options.read(), ...options.binding, ...update, updatedAt: new Date().toISOString() } as T
    options.write(record)
    await writeFileAtomic0600(options.file, JSON.stringify(record, null, 2))
  }
}
