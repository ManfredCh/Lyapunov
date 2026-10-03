/**
 * 包内回归：生成作业记录落盘规则的**唯一实现**（`../src/job-record.ts`）。
 *
 * 背景（DEV-018/P7）：`generate-hunyuan` / `generate-marble` / `generate-image` / `generate-tripo`
 * 原先各有一份**逐字相同**的 `persist` 闭包（`{...record, ...binding, ...update, updatedAt}` +
 * 临时文件 + `rename` + `mode: 0o600`），四份合到共享实现一处。本用例钉两件事：
 *  1. 共享实现本身的规则：合并顺序、落盘形状（`JSON.stringify(record, null, 2)`）、`0600`、
 *     原子替换、以及"写盘失败时内存态已更新"（四包 catch 分支依赖它）；
 *  2. 四个调用方**确实都走这一处**——内联副本不再存在。这一组是"还原合并即精确变红"的锚点：
 *     把内联闭包拷回任何一份 `operations.ts`，或把临时文件名规则再抄一份，本文件立刻失败。
 *
 * 全部离线：只用临时目录与内存态，不发任何请求、不产生费用。
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createJobRecordPersister, writeFileAtomic0600 } from "../src/job-record.ts"

const SHARED_MODULE = new URL("../src/job-record.ts", import.meta.url)
/** 四个调用方（本包 + 其余三包）与它们的 src 目录。 */
const CALLERS = [
  { package: "generate-hunyuan", module: "../src/operations.ts", specifier: '"./job-record.ts"' },
  { package: "generate-marble", module: "../../generate-marble/src/operations.ts", specifier: '"../../generate-hunyuan/src/job-record.ts"' },
  { package: "generate-image", module: "../../generate-image/src/operations.ts", specifier: '"../../generate-hunyuan/src/job-record.ts"' },
  { package: "generate-tripo", module: "../../generate-tripo/src/operations.ts", specifier: '"../../generate-hunyuan/src/job-record.ts"' },
] as const

/** 原四份闭包的内联写法（合并规则与临时文件名规则）：出现即说明合并被还原。 */
const INLINE_MERGE_RULE = "...record, ...binding, ...update, updatedAt: new Date().toISOString()"
const INLINE_TEMP_NAME = '+ "." + randomUUID() + ".tmp"'

function withDirectory<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "job-record-"))
  return body(directory).finally(() => rmSync(directory, { recursive: true, force: true }))
}

type TestRecord = { updatedAt: string } & Record<string, unknown>

function modeOf(path: string) {
  return (statSync(path).mode & 0o777).toString(8)
}

function tempResidue(directory: string) {
  return readdirSync(directory).filter((name) => name.endsWith(".tmp"))
}

describe("作业记录落盘共享实现（本族唯一一处规则）", () => {
  test("合并顺序 binding < update < updatedAt：updatedAt 恒为写入时刻", async () => {
    await withDirectory(async (directory) => {
      const file = join(directory, "record.json")
      const startedAt = Date.now()
      const state: { record: TestRecord | undefined } = {
        record: { updatedAt: "2026-01-01T00:00:00.000Z", keep: "保留", mode: "旧绑定" },
      }
      const persist = createJobRecordPersister<TestRecord>({
        file,
        binding: { mode: "developer", apiUrl: "https://binding.test" },
        read: () => state.record,
        write: (value) => {
          state.record = value
        },
      })
      await persist({ updatedAt: "1999-01-01T00:00:00.000Z", mode: "formal", status: "running" })

      // 记录里原有的键保留；binding 盖上路由身份；update 覆盖 binding；updatedAt 被写入时刻覆盖。
      expect(state.record?.keep).toBe("保留")
      expect(state.record?.apiUrl).toBe("https://binding.test")
      expect(state.record?.mode).toBe("formal")
      expect(state.record?.status).toBe("running")
      expect(state.record?.updatedAt).not.toBe("1999-01-01T00:00:00.000Z")
      expect(Date.parse(state.record!.updatedAt)).toBeGreaterThanOrEqual(startedAt)
    })
  })

  test("落盘形状与原实现逐字一致：JSON.stringify(record, null, 2) + 0600 + 无 .tmp 残留", async () => {
    await withDirectory(async (directory) => {
      const file = join(directory, "record.json")
      const state: { record: TestRecord | undefined } = { record: undefined }
      const persist = createJobRecordPersister<TestRecord>({
        file,
        binding: { mode: "developer" },
        read: () => state.record,
        write: (value) => {
          state.record = value
        },
      })
      await persist({ status: "submitting", cancellation: null })

      expect(readFileSync(file, "utf8")).toBe(JSON.stringify(state.record, null, 2))
      expect(modeOf(file)).toBe("600")
      expect(tempResidue(directory)).toEqual([])
    })
  })

  test("原子替换：第二次落盘整体换掉旧内容（临时文件先写全再 rename）", async () => {
    await withDirectory(async (directory) => {
      const file = join(directory, "record.json")
      writeFileSync(file, "旧内容：半截 JSON 也不能被读到", { mode: 0o600 })
      const state: { record: TestRecord | undefined } = { record: undefined }
      const persist = createJobRecordPersister<TestRecord>({
        file,
        binding: {},
        read: () => state.record,
        write: (value) => {
          state.record = value
        },
      })
      await persist({ status: "completed", result: { ok: true } })

      const onDisk = JSON.parse(readFileSync(file, "utf8")) as TestRecord
      expect(onDisk.status).toBe("completed")
      expect(onDisk.result).toEqual({ ok: true })
      expect(readFileSync(file, "utf8")).toBe(JSON.stringify(state.record, null, 2))
      expect(tempResidue(directory)).toEqual([])
    })
  })

  test("原子替换：并发读者只会看到旧内容或新内容，不会看到半截 JSON", async () => {
    await withDirectory(async (directory) => {
      const file = join(directory, "record.json")
      const filler = (mark: string) => mark.repeat(1_500_000)
      const state: { record: TestRecord | undefined } = {
        record: { updatedAt: "2026-01-01T00:00:00.000Z", status: "旧记录", payload: filler("a") },
      }
      writeFileSync(file, JSON.stringify(state.record, null, 2), { mode: 0o600 })
      const persist = createJobRecordPersister<TestRecord>({
        file,
        binding: {},
        read: () => state.record,
        write: (value) => {
          state.record = value
        },
      })
      const seen = new Set<string>()
      let writing = true
      const reader = (async () => {
        while (writing) {
          try {
            seen.add(String((JSON.parse(readFileSync(file, "utf8")) as TestRecord).status))
          } catch (error) {
            // 非原子写法（就地截断/直写）会让读者拿到半截 JSON：SyntaxError 或空内容。
            seen.add("PARTIAL:" + (error instanceof Error ? error.name : String(error)))
          }
          await new Promise((resolve) => setImmediate(resolve))
        }
      })()
      await persist({ status: "新记录", payload: filler("b") })
      writing = false
      await reader
      // 绿是确定的（rename 原子）；红只在"改成非原子落盘"时出现——检测是概率性的，方向不会反。
      expect([...seen].filter((item) => item.startsWith("PARTIAL:"))).toEqual([])
      expect([...seen].every((item) => item === "旧记录" || item === "新记录")).toBe(true)
    })
  })

  test("写盘失败时内存态已更新（原实现语义，四包 catch 分支据此读作业ID）", async () => {
    await withDirectory(async (directory) => {
      // 目标路径被一个目录占位 ⇒ rename 必然失败；此时合并结果必须已经回写到内存态。
      const file = join(directory, "record.json")
      mkdirSync(file)
      const state: { record: TestRecord | undefined } = { record: { updatedAt: "旧时间", status: "submitting" } }
      const persist = createJobRecordPersister<TestRecord>({
        file,
        binding: { mode: "developer" },
        read: () => state.record,
        write: (value) => {
          state.record = value
        },
      })
      const failure = await persist({ operationId: "990000000000000002", status: "running" }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(Error)
      // 关键语义：写盘失败也不能丢掉这次 update——否则落盘的 interrupted/cancelled-local 记录会少一个
      // 供应商作业ID，取消报告的 submissionConfirmed 也会失真。
      expect(state.record?.operationId).toBe("990000000000000002")
      expect(state.record?.status).toBe("running")
      // 失败会留下临时文件：这是合并前四份实现就有的行为，本用例如实钉住（不吞、不美化）。
      expect(tempResidue(directory)).toHaveLength(1)
    })
  })

  test("字节内容落盘同样 0600 + 无 .tmp 残留（generate-image 的产物落盘走同一处）", async () => {
    await withDirectory(async (directory) => {
      const target = join(directory, "image-1.png")
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      await writeFileAtomic0600(target, bytes)
      expect(new Uint8Array(readFileSync(target))).toEqual(bytes)
      expect(modeOf(target)).toBe("600")
      expect(tempResidue(directory)).toEqual([])
    })
  })
})

describe("四个调用方都走这一处（还原合并即精确变红）", () => {
  test("四份 operations.ts 各只构造一处共享 persister，且 import 自同一模块", () => {
    for (const caller of CALLERS) {
      const source = readFileSync(new URL(caller.module, import.meta.url), "utf8")
      expect({ package: caller.package, constructions: source.split("createJobRecordPersister<").length - 1 }).toEqual({
        package: caller.package,
        constructions: 1,
      })
      expect({ package: caller.package, imported: source.includes(caller.specifier) }).toEqual({
        package: caller.package,
        imported: true,
      })
    }
  })

  test("四份 operations.ts 的接线块逐字节相同（同一处实现的同一份用法）", () => {
    const blocks = new Set<string>()
    for (const caller of CALLERS) {
      const source = readFileSync(new URL(caller.module, import.meta.url), "utf8")
      const matched = source.match(/const persist = createJobRecordPersister<JobRecord>\(\{[\s\S]*?\n  \}\)/)
      expect({ package: caller.package, matched: matched !== null }).toEqual({ package: caller.package, matched: true })
      blocks.add(matched![0])
    }
    expect([...blocks]).toHaveLength(1)
  })

  test("四份 operations.ts 都不再内联合并规则与临时文件名规则", () => {
    for (const caller of CALLERS) {
      const source = readFileSync(new URL(caller.module, import.meta.url), "utf8")
      expect({ package: caller.package, inlineMerge: source.includes(INLINE_MERGE_RULE) }).toEqual({
        package: caller.package,
        inlineMerge: false,
      })
      expect({ package: caller.package, inlineTempName: source.includes(INLINE_TEMP_NAME) }).toEqual({
        package: caller.package,
        inlineTempName: false,
      })
    }
  })

  test("四包 src 里含临时文件名规则的文件只有共享模块（没有第二处副本）", () => {
    const holders: string[] = []
    for (const caller of CALLERS) {
      const directory = new URL(`../../${caller.package}/src/`, import.meta.url)
      for (const name of readdirSync(directory)) {
        if (!name.endsWith(".ts")) continue
        const source = readFileSync(new URL(name, directory), "utf8")
        if (source.includes(INLINE_TEMP_NAME)) holders.push(`${caller.package}/src/${name}`)
      }
    }
    expect(holders).toEqual(["generate-hunyuan/src/job-record.ts"])
  })

  test("共享模块自身：合并规则与临时文件名规则各恰好一处", () => {
    const source = readFileSync(SHARED_MODULE, "utf8")
    const mergeRule = "...options.read(), ...options.binding, ...update, updatedAt: new Date().toISOString()"
    expect(source.split(mergeRule).length - 1).toBe(1)
    expect(source.split(INLINE_TEMP_NAME).length - 1).toBe(1)
    expect(fileURLToPath(SHARED_MODULE).endsWith("packages/generate-hunyuan/src/job-record.ts")).toBe(true)
  })
})
