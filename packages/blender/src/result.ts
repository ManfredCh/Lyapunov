import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

/**
 * blender_run 的结束结果判定与多图结果读取：**前台调用与后台 DSH Jobs 共用同一份**。
 *
 * 之前前台自己解析 `LYAPUNOV_RESULT` 行、后台只按退出码报 `completed`，同一件事有两套判据：
 * 后台在"进程退出码 0 但 world.py 根本没打印结果行"（参数错、脚本提前退出、只跑了一部分）时
 * 会报成功，而旧输出文件还在磁盘上，看起来像本次真的产出了。现在两边都走这里：
 *
 *  - 取消（自己的信号已触发 / 被信号杀死）→ `killed`，不看退出码；
 *  - 非零退出码 → `failed`；
 *  - 退出码 0 但没有结果行 → `failed`（**不**用磁盘上遗留的 scene.json/preview.png 兜底）；
 *  - 结果行不是合法 JSON 对象 → `failed`；
 *  - 只有以上都不成立才 `completed`，并把 world.py 的结果行 JSON 原样（或装饰后）交回。
 *
 * 失败文本一律带上 stderr 尾部（Blender 的 Python traceback 只在这里），有 stdout 尾部可查时一并给出。
 * 结果行前缀由调用方（plugin.ts）传入，全仓只保留一处定义。
 *
 * 下半部分是**前台与后台共用的附件化**：结果里的图片路径 → 真附件 + 如实读数（`ImageReport`）。
 * 没有附件服务、文件不在、不是图像、被附件服务拒绝，都记成带原因的失败，不再静默返回 undefined。
 */

/** 一次 Blender 子进程的真实结束事实（进程层，不含产品判定）。 */
export interface BlenderProcessFacts {
  /** 子进程退出码；被信号杀死时为 null。 */
  exitCode: number | null
  /** 终止信号；正常退出为 null。 */
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** 调用方自己的取消信号是否已触发（工具调用取消 / 后台 job 取消）。 */
  cancelled?: boolean
}

/** 共用结束判定：前台据此抛错或回结果，后台据此给 JobOutcome.status。 */
export type BlenderFinish =
  | { status: 'completed'; result: string; value: Record<string, unknown> }
  | { status: 'killed' | 'failed'; error: string }

/** 失败证据的截断长度：够看到 traceback 尾部，又不淹没工具回执。 */
const EVIDENCE_TAIL = 2000

function tail(text: string, limit = EVIDENCE_TAIL): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`
}

/** 把 stderr/stdout 尾部（有内容才给）拼到判定文本后面；stderr 在前，因为 traceback 在那里。 */
export function blenderEvidence(message: string, stdout: string, stderr: string): string {
  const parts = [message]
  const stderrTail = tail(stderr)
  if (stderrTail) parts.push(`stderr尾部=${stderrTail}`)
  const stdoutTail = tail(stdout, 1200)
  if (stdoutTail) parts.push(`stdout尾部=${stdoutTail}`)
  return parts.join('；')
}

/**
 * 结果行：stdout 里**最后一条**带前缀的行。Blender 自身会往 stdout 打启动与导出日志，
 * 早期日志里出现同名前缀也不该抢在真正结果之前；前缀长度按传入值计算，不写死数字。
 */
export function lastResultLine(stdout: string, resultPrefix: string): string | undefined {
  return stdout.split('\n').map(line => line.trimEnd()).reverse().find(line => line.startsWith(resultPrefix))
}

/** 共用结束判定。`resultPrefix` 由 plugin.ts 传入本工具的 `RESULT_PREFIX`。 */
export function finishBlenderRun(facts: BlenderProcessFacts, resultPrefix: string): BlenderFinish {
  const { exitCode, signal, stdout, stderr } = facts
  if (facts.cancelled || signal !== null || exitCode === null) {
    return { status: 'killed', error: blenderEvidence(`BLENDER_CANCELLED: Blender 进程被取消（signal=${signal ?? 'unknown'}）`, stdout, stderr) }
  }
  if (exitCode !== 0) {
    return { status: 'failed', error: blenderEvidence(`BLENDER_FAILED: Blender 退出码 ${exitCode}`, stdout, stderr) }
  }
  const line = lastResultLine(stdout, resultPrefix)
  if (line === undefined) {
    return {
      status: 'failed',
      error: blenderEvidence(`BLENDER_OUTPUT_MISSING: 退出码 0 但 stdout 没有 ${resultPrefix} 结果行（旧输出文件存在也不能算本次成功）`, stdout, stderr),
    }
  }
  const json = line.slice(resultPrefix.length)
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    return { status: 'failed', error: blenderEvidence(`BLENDER_RESULT_INVALID: 结果行不是合法 JSON（${String(error instanceof Error ? error.message : error)}）：${tail(json, 800)}`, stdout, stderr) }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { status: 'failed', error: blenderEvidence(`BLENDER_RESULT_INVALID: 结果行必须是 JSON 对象，实际是 ${Array.isArray(value) ? 'array' : typeof value}：${tail(json, 800)}`, stdout, stderr) }
  }
  return { status: 'completed', result: json, value: value as Record<string, unknown> }
}

/** 子进程没能正常收场（spawn 失败、provider 故障）：也算失败，并保留已收集到的 stderr。 */
export function blenderSpawnFailure(error: unknown, stdout: string, stderr: string): BlenderFinish {
  const message = error instanceof Error ? error.message : String(error)
  return { status: 'failed', error: blenderEvidence(`BLENDER_SPAWN_FAILED: ${message}`, stdout, stderr) }
}

/**
 * 本次结果里的图像路径（`preview` + `extraRenders`），按出现次序去重。
 *
 * 多机位结果（world.py 的 `extraRenders`）按真实路径逐条读取；条目允许是字符串路径，
 * 也允许是带 `path` 的对象（机位元数据与路径放在一起时不必由调用方拆两种形状）。
 * 这里只做结构读取与去重：文件在不在、能不能解码，由附件化那一步真实决定，
 * **不**在这里用"文件存在"冒充成功。
 *
 * @param limit - 上限（省略 = 不限，用于同时报出"超出上限没处理"的那些路径）。
 */
export function resultImagePaths(value: unknown, limit = Number.POSITIVE_INFINITY): string[] {
  if (typeof value !== 'object' || value === null) return []
  const record = value as { preview?: unknown; extraRenders?: unknown }
  const paths: string[] = []
  const push = (candidate: unknown): void => {
    if (typeof candidate === 'string' && candidate.length > 0 && !paths.includes(candidate)) paths.push(candidate)
  }
  push(record.preview)
  if (Array.isArray(record.extraRenders)) {
    for (const entry of record.extraRenders) {
      if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) push((entry as { path?: unknown }).path)
      else push(entry)
    }
  }
  return paths.slice(0, Math.max(0, limit))
}

/** 单张图没能附件化的原因；模型据此判断"这次到底有没有看到图"。 */
export interface ImageFailure {
  path: string
  reason: string
}

/**
 * 附件化读数：跟着结果走，模型看得到。`render: true` 跑完不等于模型看见了图——
 * 只有 `attached` 才是真的进了上下文；`failures` / `skipped` / `deliveryError` 都不为空时，
 * 结果文本本身就说明"图片没送到"，不需要模型自己猜。
 */
export interface ImageReport {
  /** 结果里给出的图片路径数。 */
  requested: number
  /** 真的作为图像附件送进模型上下文的张数。 */
  attached: number
  failures: ImageFailure[]
  /** 有路径但超过上限、本次没处理的（路径仍在结果 JSON 里）。 */
  skipped: string[]
  /** 图片最终怎么到模型面前：工具结果 / 后台作业完成通知 / 没送到。 */
  delivery: 'tool-result' | 'job-notice' | 'none'
  /** 投递失败的原因（写明失败，不假装模型看到了）。 */
  deliveryError?: string
}

/**
 * 附件服务的最小面：真实实现是 `ctx.get('attachments')`，没装配时为 undefined。
 * 只声明这里真正用到的能力，不把隐私接口带进来。
 */
export interface ImageStore {
  saveImage(input: { data: Uint8Array; mediaType: string; name: string }): Promise<unknown>
}

/** 允许送进上下文的图像类型（与附件服务的准入一致）。 */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/**
 * 按**魔数**识别图像类型，不按扩展名。
 *
 * 为什么必须这样：`textures.ts` 把候选预览图一律写成 `<assetId>.thumb.png`，而 Poly Haven
 * 的预览图常常就是 JPEG——按扩展名声明 `image/png` 会在附件服务解码那一步变成一句含混的失败，
 * 或者更糟：把类型声明错了还当成功。这里读前 12 个字节，识别不出来就如实说"不是可识别的图像"。
 */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  return undefined
}

/**
 * 附件化之后的图片读数收尾：`delivery` 说的是"图到底有没有送出去"，不是"我们打算怎么送"。
 *
 * 三条规则（每条都对应一类真实误报）：
 *  · 有图送出去了 → `delivery` = 车道（`tool-result`=跟工具结果一起到；`job-notice`=随后台完成通知到）；
 *  · 一张都没有、而且**没请求**渲染（普通 build/export）→ `delivery='none'` 且**不写** `deliveryError`：
 *    没要图就没有图是正常结果，写成"没有可附的渲染图"会让模型以为这次调用出了问题；
 *  · 一张都没有、但**请求了**渲染/preview → `delivery='none'` + `deliveryError`：要么结果里根本没有
 *    图片路径，要么全部附件化失败（逐条原因见 `failures`）。"请求了渲染"必须能被模型判出来。
 *
 * 投递本身失败（owner 已释放、inject 抛错）不在这里管：那条路要把失败原因写进 `deliveryError`。
 */
export function noteImageDelivery(report:ImageReport,input:{lane:'tool-result'|'job-notice';renderRequested:boolean}):void{
  if(report.attached>0){report.delivery=input.lane;return}
  report.delivery='none'
  if(!input.renderRequested)return
  report.deliveryError=report.failures.length>0
    ? `请求了渲染但没有任何一张图进上下文：requested=${report.requested}，${report.failures.length} 张附件化失败（逐条原因见 failures）`
    : `请求了渲染但结果里没有图片路径（requested=0）：本次结果行没有 preview/extraRenders（例如渲染没产出文件、operation 不是 preview、或没传 render）`
}

/**
 * 前台与后台**共用**的附件化：把结果里的图像路径变成真附件，并给出一份如实的读数。
 *
 * 与旧的静默 `undefined` 的区别就在这里：读不到文件、不是图像、类型不被接受、附件服务没装配，
 * 每一种都变成 `failures` 里一条带原因的记录，最终进结果 JSON，而不是"静默没有图"。
 * 附件服务本身仍负责真实解码与落盘——这里不假装成功。
 */
export async function attachResultImages(
  store: ImageStore | undefined,
  paths: readonly string[],
  limit: number,
  delivery: ImageReport['delivery'],
): Promise<{ refs: unknown[]; report: ImageReport }> {
  const take = paths.slice(0, Math.max(0, limit))
  const report: ImageReport = { requested: paths.length, attached: 0, failures: [], skipped: paths.slice(Math.max(0, limit)), delivery }
  if (store === undefined) {
    for (const path of take) report.failures.push({ path, reason: '没有装配附件服务（ctx.get(\'attachments\') 为空）：图片只能按路径自行读取' })
    return { refs: [], report }
  }
  const refs: unknown[] = []
  for (const path of take) {
    try {
      const bytes = await readFile(path)
      const mediaType = sniffImageMediaType(bytes)
      if (mediaType === undefined) throw new Error(`不是可识别的图像（PNG/JPEG/WebP/GIF 的魔数都不匹配），前 8 字节=${bytes.subarray(0, 8).toString('hex')}`)
      refs.push(await store.saveImage({ data: bytes, mediaType, name: basename(path) }))
      report.attached += 1
    } catch (error) {
      report.failures.push({ path, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { refs, report }
}
