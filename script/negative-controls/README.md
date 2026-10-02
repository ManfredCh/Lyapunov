# `script/negative-controls/` —— 负对照驱动的**进库落点**

## ⚠️ 先读这一段：这个目录里**有两套东西**（并发落点）

本目录在 2026-09-27 03:33–03:48 之间被**两条 lane 同时选中**为落点。**两套都留着，谁也不删谁的**，读的时候必须分清：

| 套 | 文件 | 出自 | 形态 | 状态 |
| --- | --- | --- | --- | --- |
| **A（本 README 描述的这一套）** | `nc-lib.ts`、`nc-share-bounded-fetch.ts`、`nc-share-preview-status.ts`、`nc-policy-source-attempts.sh`、`run-all.sh`、本 README | 手工收编 `.runtime/{lane-p8fix,lane-p8fix5xx,lane-w25}`，**按今天的交付版重新取锚点** | **改写版**：不读 `.runtime/**`、命中次数断言、逐字节还原、逐条点名期望变红的用例；**本套 3 个驱动 / 12 个变异已实跑通过** | ✅ 可用 |
| **B（另一条 lane 的）** | `run.ts`、`collected/**`、`controls/**` | `.runtime/NEGATIVE-CONTROL-NOOP-SWEEP` §2.4 的 25 个驱动 | `collected/**` 是**原样副本**（脚本本体一字未改，仍引用 `.runtime/…` 的备份/日志路径）+ `index.json` 逐条审计"为什么收/不收"；`controls/*.control.json` 是**规格化**的写法（目标文件 / 锚点 / 期望变红的用例 / 基线三数），由 `run.ts` 执行 | ⚠️ **收编 ≠ 认可**：它的 `index.json` 自己写明"多数不符合 `run.ts` 的八条规矩" |

**B 套怎么跑**（与 A 套并存，互不干扰）：

```bash
bun run script/negative-controls/run.ts --show-noop                       # 只读：演示规矩 4 的陷阱
bun run script/negative-controls/run.ts script/negative-controls/controls/balance-section-one-ready-one-error.control.json
```

该 spec 实测：基线 `4 pass / 0 fail / 5 expect`；两个变异各自**精确**弄红
`balance section > surfaces returned account messages as sync errors`；收尾回到基线、**逐字节还原一致 ✓**。

**两套的关系**：B 的 `collected/p8fix-ts.ts` 与 A 的 `nc-share-bounded-fetch.ts` **是同一个源脚本**（`.runtime/lane-p8fix/scripts/negative-control.ts`）——
B 是**原样留档**，A 是**按口径重写并实测过的可跑版**。要复算请跑 A；要读原始形状请看 B 的副本。
**没有做合并**：合并两条 lane 的产物是 Lead 域的决定，本 lane 只保证**自己那套自洽可跑**，并把重叠写在明面上。

---

## 0. 为什么有这个目录

`bugfixHistory/NEGATIVE-CONTROL-NOOP-SWEEP-20260926.md` §3① 查出一条结构性事实：

> 本轮回执引用的 **24 个负对照驱动全部在 `.runtime/**`**，而 `.gitignore:2` 覆盖 `.runtime/`
> ⇒ **干净 checkout 里这些负对照一条都复算不了**。
> P8 那条 no-op 之所以还能做字节级证明，纯靠 `.runtime/lane-p8/backup/fetch.ts` 还在盘上。
> **负对照是"结论的守门人"，守门人没进库。**

本目录就是落点：**只看库内文件**（`git ls-files` 能列出的东西）就能跑、能复算。
不读 `.runtime/**`、不读 lane 备份、不依赖 `git show HEAD:`（HEAD 会前进）。

## 1. 统一口径（八条，`bugfixHistory/NEGATIVE-CONTROL-NOOP-SWEEP-20260926.md` §4，Lead 已采纳）

> 1. **每个变异必须带「命中次数断言」**：改写前对**目标文件**（不是副本、不是全仓 grep）数一次，
>    断言**恰好 1**（或脚本里显式写明的 N）；**0 或 ≥2 一律拒绝执行**（非零退出，不许静默继续）。
> 2. **锚定版本**：断言读入的字节就是**交付的那一版**；脚本开头打印目标文件的 `sha256`，
>    跑完**逐字节还原**并复核同一 `sha256`。
> 3. **失败必须响**：每个变异打印 `命中次数=`、`还原=一致/不一致`；任一项不满足 ⇒ **脚本以非零码结束**（不许 `|| true` 吞掉）。
> 4. **no-op 的判据 =「目标文件在它跑的那一版里命中 0」**；跨版本判定必须附**版本哈希**。
>    **禁止用"某处 grep 得到"当命中证据。**
> 5. **一次运行一行读数**：每个读数带**同一次运行**的 `pass/fail` + 变红用例名。**不许把两次运行的数字写进同一行**。
> 6. **负对照跑的那一版 = 交付的那一版**：回执给出三文件 sha256 对照（改前 / 交付 / 负对照用）。
> 7. **只做"去掉/还原"**：变异改的是**产品代码**，**用例一个字不动**；不许用"删断言/改判据"换红。
> 8. **负对照脚本进库**（或把正文摘进回执）：不进库的负对照 = 不可复算的声称。

本目录的驱动把这八条**做成机制**，不靠写手自觉：

| 条 | 机制（在哪实现） |
| --- | --- |
| ① | `nc-lib.ts` `runNegativeControl()`：`命中次数 !== 1` ⇒ 打印 `REFUSE`、判失败、**不写文件**；bash 侧 `mutate_and_check()` 同一判据 |
| ② | 跑前逐个打印 `# 目标 sha256 <path> <sha256> bytes=<n>`；`Restorer` 用**内存里的原字节**还原，逐字节比 sha256 |
| ③ | 任一变异 `MISMATCH`/`REFUSE` 或还原不一致 ⇒ 进程 `exit 1`；bash 侧 `set -uo pipefail` + 显式 `OK=1/0`（`|| true` 只在**数失败条数**那一处，不吞退出码） |
| ④ | 每个变异**恰好一行** `MUTATION …`，该行自带 `pass= fail= expect= exit= 变红用例(N)[…] 期望组命中=x/y 期望条数=n MATCH✓/MISMATCH✗`，全部取自**同一次** `runCase()` |
| ⑤ | 目标文件 sha256 打进读数行；`AFTER` 复跑必须回到基线（`回到基线 ✓`） |
| ⑥ | 变异表只有 `from/to`（"改前"的形状）；**没有**改测试文件的入口 |
| ⑦ | 本目录（`script/negative-controls/`，随仓库走）；驱动本体不引用 `.runtime/**` |
| ⑧ | 终态 `# 终态逐字节还原：一致 ✓`；`run-all.sh` 末尾再核一遍四个目标文件的 sha256 |

**读数行格式**（照抄即可，三种语言同一口径）：

```text
MUTATION <变异名> file=<目标文件> 目标sha256=<sha> 命中次数=1 pass=<n> fail=<n> expect=<n> exit=<rc> <ms>ms 变红用例(<N>)[<名字 | 名字>] 期望组命中=<x>/<y> 期望条数=<want> MATCH ✓|MISMATCH ✗
  逐字节还原：一致 ✓ (<目标文件>)
```

`期望组` = 该变异**必须**弄红的那几条（逐条点名，片段匹配）；`期望条数` = 应当变红的**总条数**。
**只红几条不看红在哪 = 没证**：多红一条或少红一条都判 `MISMATCH`（那说明记忆里那条不变式已经变了）。

## 2. 怎么跑

```bash
bun script/negative-controls/nc-share-bounded-fetch.ts      # 分享取件：超时/取消/诊断不泄漏（8 个变异，≈15s）
bun script/negative-controls/nc-share-preview-status.ts     # preview 失败码映射（3 个变异，≈7s）
bash script/negative-controls/nc-policy-source-attempts.sh  # 策略取件：有界重试（1 个变异，≈2s）
bash script/negative-controls/run-all.sh                    # 全部（串行）
NC_SLOW=1 bash script/negative-controls/run-all.sh          # 追加慢变异（≈92s 一条，见 §4）
```

⚠️ **变异窗口内目标产品文件是被改过的**（单个变异约 1–2 秒）。请确认没有别的 lane 正在写这些文件时再跑。
中断（Ctrl-C / 异常）已挂 `restoreAll()` 兜底，但**进程被 SIGKILL 时兜不住** —— 跑完请核 `git diff`。

## 3. 收编登记表（哪些进了库、哪些没进、为什么）

### 3.1 ✅ 已收编（**3 个驱动 / 12 个变异**，全部本单实跑通过）

| 驱动 | 出自 | 变异 | 判据 | 本单实测 |
| --- | --- | --- | --- | --- |
| `nc-share-bounded-fetch.ts` | `.runtime/lane-p8fix/scripts/negative-control.ts`（R-fix#7） | 8 | 目标 `lyapunov-share/src/{fetch,operations}.ts` 8/8 锚点**今天仍恰好命中 1** | 基线 `36/0/267`；8 个变异逐个精确变红（3/2/6/3/3/1/1/1 条）；还原后回到 `36/0/267` ✓ |
| `nc-share-preview-status.ts` | `.runtime/lane-p8fix5xx/scripts/negative-control.ts` | 3 | **收编时重新锚定**（原锚点今天命中 **0**，见 §3.2） | 基线 `36/0/267`；3 个变异精确变红（4/1/4 条）；还原一致 ✓ |
| `nc-policy-source-attempts.sh` | `.runtime/lane-w25/scripts/negative-control.sh` | 1（+1 慢，见 §4） | 目标 `policy-registry/src/source.ts`；原脚本两处不合口径已换掉（见 §3.3） | 基线 `8/0/43`；变异 A 精确变红 3 条；还原一致 ✓ |

### 3.2 ⚠️ **收编时抓到的两处"锚点已腐烂"**（这正是"负对照会随交付版腐烂"的实例）

| 原脚本 | 原锚点 | 今天命中 | 处置 |
| --- | --- | --- | --- |
| `lane-p8fix5xx/scripts/negative-control.ts` | `    const status=isShareFetchError(error)&&error.retryable?503:/AUTH|ACCOUNT/.test(code)?401:…` | **0** | 该文件已被重写成 `previewFailureStatus()`（非瞬时改判 **502**）⇒ 按**今天的交付版**重新取锚点 |
| `lane-w25/scripts/negative-control.sh` | `const composite = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)` | **0** | 该文件后来长出 connect / stall 两个 30s 的分工 ⇒ 换锚点为 `timeoutScope === 'connect'` 那一行 |

两条原脚本遇到这种情况都会**响亮拒绝**（`throw` / `assert`），不会静默 no-op —— 这一点是它们做对的地方；
但**"拒绝跑"= 这条负对照从此不再复算**，所以只留在 `.runtime` 里等于慢性失效。
**⇒ 收编动作本身必须包含"按今天的字节重新取锚点 + 重新实测期望条数"。**

### 3.3 🔧 收编时改掉的口径缺陷（原脚本 → 本库）

| 原脚本 | 缺陷 | 本库怎么改 |
| --- | --- | --- |
| `lane-w25/scripts/negative-control.sh` | `assert old in s`（只断"存在"）⇒ 命中 ≥2 会静默全改 | 换成 `count(old) == 1` |
| 同上 | `bun … \| tee … \| tail -6 \|\| true` ⇒ **退出码被吞** | 不吞；`MISMATCH` 直接判失败 |
| 同上 | `MUTATION_A_RED=$(grep -cE '^\s*[0-9]+ fail' …)` ⇒ 只数"有没有 fail 行"，不看红在哪 | 逐条点名期望变红的用例 + 校验总条数 |
| `lane-p8fix/scripts/negative-control.ts` | 备份与日志写在 `.runtime/lane-p8fix/`（gitignored） | 原字节存内存 + `process.on` 兜底；不落 `.runtime` |
| `lane-p8fix5xx/scripts/negative-control.ts` | 只用 `includes()` 断"锚点还在"（等价于命中 ≥1） | `split().length-1 === 1` |

### 3.4 ❌ **未收编**的 `.runtime` 驱动（逐条给理由；**"未收编" ≠ "有问题"**）

| 驱动 | 未收编的理由 |
| --- | --- |
| `lane-p8/scripts/negative-control.sh` | **它自己就是被勘误的那条**（变异 B 的停摆模式命中 0，grade C 无命中断言）。修复版是 `lane-p8fix`，已收编 |
| `lane-p8fix/scripts/p8-delivered-negative-control.ts` | 诊断工装（grade C，自报读数），且目标是 `baseline-p8/` 里的**副本**，不是交付版 ⇒ 复算价值低 |
| `lane-w6/frozen-20260927/nc/{nc-mutate.py,nc-run.sh}` | 判据是 grade A，但**还原依赖 `.runtime/…/backup/` + `baseline.sha256`**，且用 `\|\| echo "(!! mutation was a no-op)"` **吞掉 no-op** ⇒ 要收编必须重写还原与判定两块（本单未做） |
| `lane-github-429-noheader/{patch.ts,make-nodeliver.ts}` | 235 行补丁脚本、目标 `policy-registry/src/source.ts`；未逐条实测命中与期望条数 ⇒ 未收编（不是判它无效） |
| `lane-gate-nondeterminism/*.py`、`GATE-EXIT-FLUSH/phases.sh` | **目标是 `script/release-gate.ts`**。本单纪律是**只读门文件（已定版）** ⇒ 会变异门文件的负对照**本单不跑、不收编**；要收编须由 Lead 另派（或在门解冻后） |
| `lane-p1-viewer/{make-negatives.ts,negative-control-runs.sh}` | grade B/C：4 处锚点只守 3 处、无命中次数断言（NC-SWEEP §2.2 已点名）⇒ 需重写后收编 |
| `lane-p3-rework/negative-control.sh` | grade B（`assert … in s`）；目标 `workbench.tsx` 未逐条复跑 |
| `lane-w15/negative-control.sh` | 用 `git show HEAD:` 当"改前版" ⇒ **改前版随 HEAD 漂移**，不是"模式 no-op"而是另一种不可复算（NC-SWEEP §2.3） |
| `lane-dev028h/patch-height.py` | grade D（`assert patched != text`），且目标是 `.runtime` 内的**派生 MJCF**（不在库里）⇒ 干净 checkout 无目标可改 |
| `lane-dev007-artifact/{mutate.py,apply.py}`、`lane-client-tests-restore/{apply_mutation.py,mutate.sh}`、`p7-dedup/mutate.py`、`dev018-residual/mutate.py`、`cu/lane-dev036/mut.py`、`lane-env09d/n340-make-variants.py`、`ccds-…/mutate-no-settle.sh` | 判据是 grade A，**但本单没有逐条复跑 + 按模板改写 + 实测期望条数**（每一条都要单独走一遍"取锚点→跑→冻结期望"）。登记为**待收编**，不是判它们无效 |

## 4. 慢变异（已实测有效，默认不跑）

`nc-policy-source-attempts.sh` 的**变异 B**（把 `timeoutScope === 'connect'` 那一支摘掉，即"超时一直挂在正文上"）：

- 观测窗口**不是** `policy-source-bounded-fetch.test.ts`（那里 0 条变红 ⇒ 该文件的用例不覆盖这一条不变式），
  而是 `packages/policy-registry/test/policy-source-stall-cap.test.ts`；
- 本单实测：**4 条精确变红**（含 `真·判据：真实默认常量（建连 30s / 停摆 30s）下，32.5s 的 trickle 必须收完`），
  该文件单跑 **≈92s**（其中一条用例本身就要 90s）；
- 所以默认 `SKIP`（打印一行说明，不静默），要跑设 `NC_SLOW=1`。
- **它不是 no-op**：锚点今天恰好命中 1，变异确实生效。

## 5. 边界（如实登记）

1. **本目录不在 `tsconfig.json` 的编译闭包内**（该配置的 `include` 只到 `script/*.ts` 顶层）。
   ⇒ 类型错误不会被 `tsc` 抓到，只能靠"跑起来"证明 ⇒ 每次改动都必须真跑一遍。
   （不把 `script/negative-controls/**` 加进 tsconfig：那要改 `tsconfig.json`，不在本单写入域。）
2. 本目录**不是**测试文件（不含 `.test.ts`/`.spec.ts`）⇒ 不会被 `bun test` 发现、不会进 `test-ci.manifest.json` 的
   test-like 面、不会让 `manifest-gate-gap` 的 `notRun` 变多。（已按 `TEST_LIKE = /\.(test|spec)\.(t|j)sx?$/` 核过。）
3. **它没有被任何门/CI 自动跑**：本目录是"可复算的落点"，不是"自动判据"。谁引用负对照，谁在回执里给出这次运行的读数行。
4. 收编只覆盖**已实测能跑**的 3 个驱动；§3.4 那 7 类**未收编**，因此"负对照进库"这件事**还没有做完**——
   本目录是起点，不是终点。
