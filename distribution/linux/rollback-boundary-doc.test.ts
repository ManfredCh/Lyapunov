/**
 * 只读文档守卫：保留原 A/macOS、B/Linux L1–L4、C/载荷与九个正负对照。
 * Linux 随包 README 已采用英文与版本化安装，守卫定位当前英文合同与真实命令，
 * 不再要求历史中文标题或特定旧 tar/.bak 文件名。
 * L1：previous 的客户端目标和旧 scene/catalog 数据边界在同段；
 * L2：EXIT=0、doctor/AVAILABLE 不能冒充数据回退成功；
 * L3：升级前快照、回退前恢复，以及无自动备份/无恢复日志的理由；
 * L4：有条件的引用原地改写，不能把历史零改写推广为迁移保证。
 * macOS 的原标题/两句锚点、Linux 载荷禁止 macOS 专有设施均保持。
 * 只读当前文档字节，无环境开关、跳过或引擎运行；通过只证明文档合同和负对照。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEV = resolve(HERE, '../..')

/** 两侧文档的守卫锚点：macOS 侧（A 面）。 */
export const MACOS_ANCHORS = ['迁移是移动语义', '只读备份'] as const

/** macOS README 里专有的设施（C 面：不许进 Linux 载荷）。 */
export const MACOS_ONLY_MARKERS = ['~/Library/Application Support', 'Keychain'] as const

/** 英文升级/回退节的标题（Linux 侧）。 */
const LINUX_SECTION_HEADING = /^##[ \t]+Updates and rollback[ \t]*$/m
/** macOS 侧那一节的标题（`###` 或 `##` 都认，本 README 用的是 `###`）。 */
const MACOS_SECTION_HEADING = /^#{2,3}[ \t]*升级与回退.*$/m

/** 快照步骤与升级命令的稳定锚点（只认命令形状，不认整行文案）。 */
const SNAPSHOT_CMD = 'cp -a -- "$lyapunov_data" "$lyapunov_backup"'
const RESTORE_CMD = 'cp -a -- "$lyapunov_backup" "$lyapunov_data"'
const UPGRADE_CMD = 'curl -fsSL https://vorynel.com/lyapunov/install.sh | sh'
/** 版本化安装的原子切换命令（恢复数据应在切换客户端之前）。 */
const ROLLBACK_CMD = 'mv -Tf -- "$lyapunov_pending" "$lyapunov_prefix/current"'
/** 回退目标的写法（L1：限制句必须点名安装器保存的 previous）。 */
const ROLLBACK_TARGET = '`previous`'

/** 取 Linux README 的「Updates and rollback」节正文（到下一个 `##` 为止）。整节缺失时返回空串。 */
export function linuxRollbackSection(linux: string): string {
  const heading = linux.match(LINUX_SECTION_HEADING)
  if (!heading || heading.index === undefined) return ''
  const rest = linux.slice(heading.index + heading[0].length)
  const next = rest.search(/^##[ \t]/m)
  return next === -1 ? rest : rest.slice(0, next)
}

/** 取含指定标记的那一段（按空行切段）；找不到返回空串。 */
export function paragraphContaining(section: string, marker: string): string {
  return section.split(/\n{2,}/).find(paragraph => paragraph.includes(marker)) ?? ''
}

/**
 * 判据本体：返回**所有**违约项（空数组＝通过）。纯函数，负对照直接喂改过的文本即可。
 * 每条违约都带"哪一面、哪条欠账、缺什么"，红的时候不用去猜。
 */
export function docBoundaryViolations(docs: { linux: string; macos: string }): string[] {
  const problems: string[] = []

  // ── A 面：macOS 侧不许再丢掉回退边界 ────────────────────────────────────────────────
  if (!MACOS_SECTION_HEADING.test(docs.macos)) {
    problems.push('A/macOS：`distribution/macos/README.md` 里没有「升级与回退」节（覆盖不对称又回来了）')
  }
  for (const anchor of MACOS_ANCHORS) {
    if (!docs.macos.includes(anchor)) {
      problems.push(`A/macOS：缺「${anchor}」⇒ 回退边界又只剩 Linux 一侧说了`)
    }
  }

  // ── B 面：Linux 侧那四条欠账的修法必须在位 ─────────────────────────────────────────
  const section = linuxRollbackSection(docs.linux)
  if (!section.trim()) {
    problems.push('B/Linux：`distribution/linux/README.md` 的「Updates and rollback」节不在了（随包出货的那一节）')
    return problems
  }

  const snapshotAt = section.indexOf(SNAPSHOT_CMD)
  const upgradeAt = section.indexOf(UPGRADE_CMD)
  const restoreAt = section.indexOf(RESTORE_CMD)
  const rollbackAt = section.indexOf(ROLLBACK_CMD)

  // L3（最重要）：升级**之前**必须有只读快照，并在流程里说清命令与位置。
  if (snapshotAt < 0) {
    problems.push('B/L3：升级流程前没有只读快照步骤（复制实际数据根到升级前备份）——限制句又变成不可执行')
  } else if (upgradeAt >= 0 && snapshotAt > upgradeAt) {
    problems.push('B/L3：只读快照出现在升级命令**之后**——用户照流程做完就来不及备份了')
  }
  if (upgradeAt < 0) problems.push('B/L3：升级命令缺失，无法核对快照在升级之前')
  if (!section.includes('no automatic backup mechanism') || !section.includes('no `backup` subcommand')) {
    problems.push('B/L3：没写产品无自动备份机制和 backup 子命令（这是快照不能省的理由）')
  }
  if (!section.includes('not persisted as a recovery journal')) {
    problems.push('B/L3：没写迁移报告不持久化为恢复日志（用户会以为事后能从报告里补做）')
  }
  // L3 的可执行形式：回退流程里必须有快照恢复，且在切换旧客户端之前。
  if (restoreAt < 0) {
    problems.push('B/L3：回退流程里没有快照恢复步骤（升级前备份恢复实际数据根）——限制句仍不可执行')
  } else if (rollbackAt >= 0 && restoreAt > rollbackAt) {
    problems.push('B/L3：快照恢复排在切换旧客户端**之后**——顺序反了，旧版本会先看到迁移后的运行根')
  }

  if (rollbackAt < 0) problems.push('B/L3：客户端切换命令缺失，无法核对数据恢复在先')

  // L2：不许再把"启动成功"当回退成功的信号。
  if (!section.includes('is not rollback success') || !section.includes('EXIT=0') || !section.includes('`doctor`') || !section.includes('`AVAILABLE`')) {
    problems.push('B/L2：启动 EXIT=0 或 doctor AVAILABLE 必须写成弱信号：旧版本正常启动但看不到 `catalog/` 里的库')
  }

  // L1：回退目标的限制必须与限制句**同一段**，不让读者自己去发现。
  const limit = paragraphContaining(section, '**Rollback boundary:**')
  if (!limit) {
    problems.push('B/L1：找不到「Rollback boundary」段（限制句被删或改了标题）')
  } else {
    if (!limit.includes(ROLLBACK_TARGET)) {
      problems.push('B/L1：限制句那段里没点名回退目标 previous——读者仍要自己去发现')
    }
    if (!limit.includes('only the old `scene/` layout') || !limit.includes('`catalog/`')) {
      problems.push('B/L1：限制句那段里没写旧 scene 布局目标看不到 catalog 库的条件')
    }
  }
  if (!section.includes('read-only snapshot')) {
    problems.push('B/L1：整节里没有只读快照——唯一能回到旧布局的东西没写出来')
  }

  // L4："零改写"必须是有条件的表述。
  if (!section.includes('is not a migration guarantee') || !section.includes('only when') || !section.includes('rewriteJsonReferences()') || !section.includes('writeFile')) {
    problems.push('B/L4：历史零改写必须限定成有条件的读数，并写明 `rewriteJsonReferences()` 会就地 `writeFile` 改写')
  }

  // ── C 面：macOS 内容不许进 Linux 载荷 ─────────────────────────────────────────────
  for (const marker of MACOS_ONLY_MARKERS) {
    if (docs.linux.includes(marker)) {
      problems.push(`C/载荷：Linux README（随包载荷件）里出现了 macOS 专有内容「${marker}」`)
    }
  }

  return problems
}

const linux = readFileSync(join(DEV, 'distribution/linux/README.md'), 'utf8')
const macos = readFileSync(join(DEV, 'distribution/macos/README.md'), 'utf8')

describe('回退边界文档守卫（只读）', () => {
  test('两份 README 的当前字节：0 条违约', () => {
    expect(docBoundaryViolations({ linux, macos })).toEqual([])
  })

  test('负对照 A：macOS 侧丢任一句 ⇒ 精确报出那一句', () => {
    for (const anchor of MACOS_ANCHORS) {
      const problems = docBoundaryViolations({ linux, macos: macos.replaceAll(anchor, '（删掉）') })
      expect(problems.some(problem => problem.includes(`缺「${anchor}」`))).toBe(true)
    }
  })

  test('负对照 B/L3：快照步骤删掉或挪到升级之后 ⇒ 精确报红', () => {
    const removed = docBoundaryViolations({ linux: linux.replace(SNAPSHOT_CMD, 'cp -a /别处'), macos })
    expect(removed.some(problem => problem.includes('升级流程前没有只读快照步骤'))).toBe(true)

    // 把快照那一行整段搬到升级命令之后：位置判据必须抓到"顺序反了"。
    const section = linuxRollbackSection(linux)
    const snapshotParagraph = paragraphContaining(section, SNAPSHOT_CMD)
    expect(snapshotParagraph).not.toBe('')
    const movedSection = section.replace(snapshotParagraph, '').replace(UPGRADE_CMD, `${UPGRADE_CMD}\n${snapshotParagraph}`)
    const moved = linux.replace(section, movedSection)
    const reordered = docBoundaryViolations({ linux: moved, macos })
    expect(reordered.some(problem => problem.includes('只读快照出现在升级命令**之后**'))).toBe(true)
  })

  test('负对照 B/L3：回退流程少了快照恢复 ⇒ 精确报红', () => {
    const problems = docBoundaryViolations({ linux: linux.replace(RESTORE_CMD, 'cp -a /别处'), macos })
    expect(problems.some(problem => problem.includes('回退流程里没有快照恢复步骤'))).toBe(true)
  })

  test('负对照 B/L1：限制句与回退目标拆开 ⇒ 精确报红', () => {
    const limit = paragraphContaining(linuxRollbackSection(linux), '**Rollback boundary:**')
    expect(limit).not.toBe('')
    // 只改限制句那一段：其它判据（含切换客户端顺序）保持原样，红点必须精确落在 L1。
    const stripped = linux.replace(limit, limit.replaceAll(ROLLBACK_TARGET, '（不点名归档）'))
    const problems = docBoundaryViolations({ linux: stripped, macos })
    // 精确：只该红这一条，且就是 L1 那条（别的判据不受影响）。
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain('B/L1：限制句那段里没点名回退目标')
  })

  test('负对照 B/L2：恢复"启动成功"的旧措辞 ⇒ 精确报红', () => {
    const problems = docBoundaryViolations({ linux: linux.replace('is not rollback success', 'is rollback success'), macos })
    expect(problems.some(problem => problem.includes('弱信号'))).toBe(true)
  })

  test('负对照 B/L4：恢复"其它既有数据未被改写" ⇒ 精确报红', () => {
    const problems = docBoundaryViolations({ linux: linux.replace('is not a migration guarantee', 'all existing data remains unchanged'), macos })
    expect(problems.some(problem => problem.includes('L4'))).toBe(true)
  })

  test('负对照 C：把 macOS 数据根抄进 Linux 载荷 ⇒ 精确报红', () => {
    const problems = docBoundaryViolations({ linux: `${linux}\n（macOS 数据根：~/Library/Application Support/LyapunovDSH）\n`, macos })
    expect(problems.some(problem => problem.includes('macOS 专有内容'))).toBe(true)
  })

  test('负对照：Linux 整节删掉 ⇒ 精确报红（不是静默通过）', () => {
    const problems = docBoundaryViolations({ linux: linux.replace(LINUX_SECTION_HEADING, '## 别的一节\n'), macos })
    expect(problems.some(problem => problem.includes('「Updates and rollback」节不在了'))).toBe(true)
  })
})
