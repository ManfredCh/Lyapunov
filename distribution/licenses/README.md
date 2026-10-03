# 随包第三方许可证入库件（distribution/licenses/）

这里放**打包链需要的、但不属于本仓库版权**的许可证原文，让打包不再依赖构建机当时的网络状态。

## 为什么需要它

`script/package-linux.ts` 要把 micromamba 的 LICENSE 放进载荷（`runtime/micromamba/LICENSE`）——
它是随包分发的法律产物，取不到就必须**中止打包**，不能静默省掉。
此前这份许可证**只能**从 `https://raw.githubusercontent.com/mamba-org/mamba/<version>/LICENSE` 现取，
于是"能不能打包"隐含依赖"构建机此刻能不能出网"：

- 2026-09-26 构建 #2：前 6 秒已完成全部拷贝，随后在取许可证这一步**静默挂了 5 分钟**才以 `TimeoutError` 失败；
- 同日本单取证时同一个 URL 先 200/0.93s，紧接着两次 60s/30s **0 字节超时**（瞬时停摆可复现），
  重试第 2 次才成功。

对没有网络的客户 CI / 离线环境，这不是"偶发慢"，而是**打包直接失败**。

## 取件顺序（`distribution/licenses/mamba-license.ts`）

| 顺序 | 来源 | 命中时联网 | 校验 |
| --- | --- | --- | --- |
| 1 | 环境变量 `LYAPUNOV_MAMBA_LICENSE`（指向许可证文件；相对路径按仓库根解析） | 否 | 原样采用，如实报告是否与登记身份一致；文件不存在或为空 ⇒ 中止打包 |
| 2 | 入库件 `distribution/licenses/micromamba-<version>-LICENSE` | 否 | sha256 必须等于 `…meta.json` 里的登记值，被改动 ⇒ 中止打包（不能用网络掩盖）；**登记身份本身不可用（meta.json 缺失/损坏/没有 sha256）⇒ 同样中止打包**，且**不回落到 3/4** |
| 3 | 缓存 `.runtime/licenses/micromamba-<version>-LICENSE` | 否 | 同上；不一致则拒用该候选并继续（缓存可自愈），原因进最终报错。**该版本未登记 ⇒ 身份不可用 ⇒ 交付闸门拒绝**（缓存自愈救不了未登记版本） |
| 4 | 网络兜底 `fetchMambaLicense`（`AbortSignal.timeout(30_000)` × 3 次） | 是 | 同上；成功后就地写回缓存，让下一次构建回到离线路径。**该版本未登记 ⇒ 身份不可用 ⇒ 交付闸门拒绝**（网络兜底不再是未登记版本的出路） |

四种来源全部落空 **或者**取到了字节但**身份不可核验** ⇒ 抛错中止打包；错误信息同时带**上游 URL**与**每个候选各自的失败原因**。

**身份是三态，不是布尔**（2026-09-26 fail-closed 收紧，取证与改动见
`bugfixHistory/LICENSE-PIN-FAIL-CLOSED-20260926.md`，验收报告 §C1 的处置）：

```
hashMatchesPin = true    实际内容与登记 sha256 逐字节一致          ⇒ 放行
hashMatchesPin = false   内容与登记身份不符                        ⇒ 拒用（原有行为，未动）
hashMatchesPin = null    登记身份不可用（缺失／损坏／没有 sha256）  ⇒ 【也拒绝】—— 不再是"没有意见"
```

交付闸门 `mambaLicenseIdentityVerdict()`（`script/package-linux.ts` 取件后立刻调用）只放行 `true`；`false` 与 `null`
一律不许进发行载荷 ⇒ 中止打包。**唯一例外**是上表 1 号来源 `LYAPUNOV_MAMBA_LICENSE`（操作者显式覆盖，见下节「出路②」）：
它放行，但会**响亮报告**身份未证实。改动前的行为是 `null` 被当通过——一份 62 B 的假文本曾因此被当作入库件正常采用、构建继续。

## 当前入库身份

| 字段 | 值 |
| --- | --- |
| 件 | `micromamba-2.9.0-LICENSE` |
| 版本 | micromamba 2.9.0（与本机 `.runtime/bin/micromamba --version` 一致） |
| SPDX | `BSD-3-Clause` |
| 字节 | 1483 |
| sha256 | `41fd98a468e39d319911bd94f4e65d6ad6a7ea66559dd5aa4112f138ff9b629a` |
| 来源 URL | https://raw.githubusercontent.com/mamba-org/mamba/2.9.0/LICENSE |
| tag / commit | `2.9.0` / `2676ec2050f7dd5b8a524287526f50a8a4fb9652` |

完整来源记录（含取证命令与时间）见同目录 `micromamba-2.9.0-LICENSE.meta.json`。

## 升级 micromamba 时怎么办

入库件**按版本命名**，版本号来自本机二进制的 `--version` 输出（文件名 `micromamba-<版本>-LICENSE`，
上游 URL 也是 `…/mamba/<版本>/LICENSE`）。

> ### ⚠️ 前置条件（2026-09-26 起收紧，与旧行为不同）
>
> **换到一个未登记的新版本 ⇒ 打包必然失败。**
> 这不是"网络不通"那种可以重试的失败：缓存（3 号来源）与网络兜底（4 号来源）**即使取到字节完全正确**的上游
> LICENSE，也没有登记身份可比 ⇒ `hashMatchesPin:null` ⇒ **交付闸门拒绝、打包中止**。
> 也就是说，未登记版本的升级路径已经从"网络兜底可用"变成"**必须先登记，或先设 env 覆盖**"。

### 出路①（正规流程）：把新版本入库 + 补 meta.json

1. 取回新版本的 LICENSE，命名 `micromamba-<新版本>-LICENSE`，**放进本目录 `distribution/licenses/`**；
   只把它放在本机别处（或只写文档）打包链看不到它 —— 那正是下面形态二的失败。
2. 同目录补一份 `micromamba-<新版本>-LICENSE.meta.json`，字段照 `micromamba-2.9.0-LICENSE.meta.json`：
   `version` / `spdx` / `source`(来源 URL) / `tag` / `commit` / `bytes` / `sha256`。
   **旧版本记录保留**（缓存与入库件都可能还在被旧版本用到）。
3. 核对登记的 `sha256` 与实际文件逐字节一致：

   ```bash
   sha256sum distribution/licenses/micromamba-<新版本>-LICENSE
   ```

4. **不要在 meta 里改 sha256 去迁就一个对不上的文件** —— 那正是本机制要拦的事。
5. 复核（可选但便宜）：`bun test distribution/licenses/mamba-license.test.ts` 应全绿；
   或直接跑一次打包，日志里应出现 `"phase":"micromamba-license"`，其中 `"source":"vendored"`、`"hashMatchesPin":true`。

### 出路②（显式覆盖）：`LYAPUNOV_MAMBA_LICENSE=<路径>`

不想入库（例如离线 CI 的公司镜像另有副本）时，指向一份**你确认过的**副本：

```bash
LYAPUNOV_MAMBA_LICENSE=/绝对路径/LICENSE bun run script/package-linux.ts …
```

- 相对路径按**仓库根**解析；文件不存在或为空 ⇒ **立刻中止**（显式覆盖被静默忽略比失败更危险）。
- 它是**操作者显式指令**：即使身份不可核验也采用，但**必须响亮报告** —— 日志里多一条
  `{"phase":"micromamba-license-identity-unverified","disposition":"operator-override",…}`，
  `RELEASE.json` 里多一个 `pinProblem` 字段。**不是静默采用。**

### 失败报文长什么样（逐字，2026-09-26 实测；换行与路径前缀 `…` 只为排版）

**形态一：入库件在、登记身份不在**（裁剪检出 / 镜像脚本漏抓 meta.json）—— 解析层直接抛错，**不回落到缓存/网络**：

```
入库许可证无法核验身份，停止打包（fail-closed）：登记身份文件不存在：…/distribution/licenses/micromamba-<版本>-LICENSE.meta.json。入库件在、登记身份不在，说明这份检出被裁剪或被写坏；请恢复它（登记 sha256/来源），或用 LYAPUNOV_MAMBA_LICENSE 指向一份你确认过的副本。
```

开头的「登记身份文件不存在：…」按三支**分开报**，另两支是
「登记身份文件不是合法 JSON：…（JSON Parse error: …）」与「登记身份文件里没有可用的 sha256 字段：…（实际 undefined）」
—— 「缺什么」决定你该怎么修。

**形态二：交付闸门拒绝**（未登记版本的缓存/网络字节，或内容与登记身份不符）—— 打包中止，报文点名缺什么、从哪来：

```
许可证身份未被证实，拒绝把它写进发行载荷（fail-closed）：没有可核验的登记身份：登记身份文件不存在：…/distribution/licenses/micromamba-<版本>-LICENSE.meta.json
  取件来源：network（https://raw.githubusercontent.com/mamba-org/mamba/<版本>/LICENSE）
  实际内容：sha256=<64 位十六进制>，<字节数> B
  处置建议：把该件与 micromamba-<版本>-LICENSE.meta.json 一起入库（sha256/字节/SPDX/来源/tag/commit），或用 LYAPUNOV_MAMBA_LICENSE 指向一份你确认过的副本（该变量是操作者显式覆盖，采用时只如实报告身份是否一致）。
```

只写文档、不入库（方案 c）不足以让离线 CI 打包成功：许可证仍然只能现取。
