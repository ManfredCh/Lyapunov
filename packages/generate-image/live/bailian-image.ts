/**
 * **真实百炼调用**（本任务验收：1 次文生图 + 1 次基于该图的局部编辑）。
 *
 * 用法：
 *   node packages/generate-image/live/bailian-image.ts --out <任务私有目录> [--model qwen-image-3.0] [--env-file <文件>]
 *
 * 凭据只从可信来源读：进程环境 `IMAGE_API_KEY`（回落 `DASHSCOPE_API_KEY`）；
 * 显式给了 `--env-file`（或设了 `LYAPUNOV_IMAGE_ENV_FILE`）时**只读那一个文件**里的同名变量，
 * 不遍历任何凭据目录、不打印任何 key、不把 key 写进任何产物。
 * 本脚本是**用户已授权的本机验收脚本**（授权的就是这两次真实调用），所以显式 `allowPaidSubmission: true`；
 * 产品路径必须走原生用户问答授权，绝不走这条。地址只打印 `origin`，不悄悄回落到官方域名之外的任何地方。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { homedir } from "node:os"
import { preflightImageGeneration } from "../src/provider.ts"
import { isPreparedOnly, runImageGeneration, type ImageGenerationResult } from "../src/operations.ts"

interface Arguments {
  out?: string
  model?: string
  envFile?: string
  size: string
}

function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = { size: "1024*1024" }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === "--out" && value) parsed.out = value
    else if (flag === "--model" && value) parsed.model = value
    else if (flag === "--env-file" && value) parsed.envFile = value
    else if (flag === "--size" && value) parsed.size = value
  }
  return parsed
}

/** 只读取**一个明确给出的**文件里的 `KEY=VALUE`（忽略注释/空值），已存在的环境变量优先。 */
async function loadEnvFile(path: string): Promise<string[]> {
  const loaded: string[] = []
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch {
    return loaded
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const name = match[1]
    const value = match[2].trim().replace(/^["']|["']$/g, "")
    if (!value || process.env[name]) continue
    process.env[name] = value
    loaded.push(name)
  }
  return loaded
}

const DIRECTIONS = {
  t2i: "北方合院民居的院落概念图：正房三开间、东西厢房、灰砖影壁，青石铺地，午后侧光，建筑体量清楚，无文字无水印",
  i2i: "只把画面中的石材与铺地换成浅灰色花岗岩，墙面改为灰白色抹灰；保持所有门窗开口的位置、数量与形状完全不变，其余构图、相机与光照不变",
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (!args.out) throw new Error("缺少 --out <目录>（本次真实调用的产物目录）")
  const out = isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out)
  await mkdir(out, { recursive: true })
  const envFile = args.envFile ?? process.env.LYAPUNOV_IMAGE_ENV_FILE ?? join(homedir(), "WS/Lyapunov/Dev/.runtime/session-secrets/tripo.env")
  const loadedFromFile = await loadEnvFile(envFile)
  const keySource = process.env.IMAGE_API_KEY ? "IMAGE_API_KEY" : process.env.DASHSCOPE_API_KEY ? "DASHSCOPE_API_KEY" : undefined
  if (!keySource) {
    console.error(
      JSON.stringify(
        {
          status: "CREDENTIALS_UNAVAILABLE",
          envFile,
          loadedVariables: loadedFromFile,
          message: "没有可用的百炼 API Key：进程环境与指定的 env 文件里都没有 IMAGE_API_KEY / DASHSCOPE_API_KEY 的值。真实调用未执行、未产生费用。",
        },
        null,
        2,
      ),
    )
    process.exitCode = 2
    return
  }
  const controller = new AbortController()
  process.on("SIGINT", () => controller.abort())
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const options = {
    dataDirectory: out,
    allowPaidSubmission: true,
    signal: controller.signal,
    ...(args.model === undefined ? {} : { model: args.model }),
  }
  // 只打印 origin：报告里出现服务 host 是允许的，出现 key 是禁止的。
  const endpointOrigin = (await preflightImageGeneration({ input: { prompt: DIRECTIONS.t2i } }, options)).endpoint
  const host = new URL(endpointOrigin).origin
  const summary: Record<string, unknown> = { status: "RUNNING", host, keySource, envFile, loadedVariables: loadedFromFile, model: args.model ?? "qwen-image-3.0", out }

  const results: ImageGenerationResult[] = []
  const runStep = async (step: { name: "t2i" | "i2i"; prompt: string; referenceImages?: string[] }) => {
    const result = await runImageGeneration(
      { requestId: `${step.name}-${stamp}`, input: { prompt: step.prompt, size: args.size, n: 1, ...(step.referenceImages ? { referenceImages: step.referenceImages } : {}) } },
      options,
    )
    if (isPreparedOnly(result)) throw new Error("live 脚本不该走到 prepareOnly 分支")
    results.push(result)
    summary[step.name] = {
      requestId: result.requestId,
      model: result.model,
      taskId: result.taskId,
      requestIds: result.requestIds,
      usage: result.usage,
      images: result.images,
      referenceImages: result.referenceImages,
    }
    console.log(JSON.stringify({ step: step.name, host, model: result.model, taskId: result.taskId, requestIds: result.requestIds, usage: result.usage, images: result.images.map((image) => image.path) }, null, 2))
    return result
  }
  // 第 1 步：文生图（院落参考概念，1024 级、1 张）。
  const concept = await runStep({ name: "t2i", prompt: DIRECTIONS.t2i })
  const reference = concept.images[0]?.path
  if (!reference) throw new Error("文生图没有返回任何图，无法进行第二步的图生图编辑")
  // 第 2 步：拿**第 1 步真下载下来的那张图**做局部编辑（证明是实际图生图，不是又一次文生图）。
  await runStep({ name: "i2i", prompt: DIRECTIONS.i2i, referenceImages: [reference] })
  summary.status = "COMPLETED"
  summary.note = "计费口径以官方价格页为准（输入图像张数 + 成功生成的图像张数，失败不计费）；本脚本不做积分换算，也不写价目表。"
  const reportPath = join(out, "live-bailian-image.json")
  await writeFile(reportPath, JSON.stringify(summary, null, 2))
  console.log(JSON.stringify({ status: "COMPLETED", reportPath, images: results.flatMap((result) => result.images.map((image) => image.path)) }, null, 2))
}

await main().catch((error: unknown) => {
  console.error(JSON.stringify({ status: "FAILED", message: error instanceof Error ? error.message : String(error) }, null, 2))
  process.exitCode = 1
})
