import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { stat } from "node:fs/promises"
import { join, resolve } from "node:path"

/**
 * .blend 的外部依赖（图片/链接库/字体）只存在于 Blender 自己的数据块里，文件字节里没有可解析的
 * 索引。便携打包要证明"依赖闭合"，只能问配置的 Blender：这是唯一权威读法，不在这里另立解析器。
 *
 * 可执行文件取法与产品 Blender 工具同源（`packages/blender/src/plugin.ts`）：BLENDER_EXECUTABLE →
 * snap 载荷（snap run 在服务 cgroup 内失败，直调载荷并补它自己的库路径）→ PATH 上的 blender。
 */
export function blenderExecutable(): string {
  const configured = process.env.BLENDER_EXECUTABLE?.trim()
  if (configured) return configured
  const snap = "/snap/blender/current"
  if (existsSync(join(snap, "blender"))) return join(snap, "blender")
  return "blender"
}

/** 起 Blender 时的统一环境（同源取法的调用方，包括测试夹具，都用这一份，避免各自补库路径）。 */
export function blenderEnvironment(): NodeJS.ProcessEnv {
  const snap = "/snap/blender/current", payload = blenderExecutable().startsWith(snap)
  // HF_ENDPOINT 与产品工具一致：镜像配置随子进程传递，本模块自身不发起任何下载。
  const env: NodeJS.ProcessEnv = { ...process.env, HF_ENDPOINT: "https://hf-mirror.com" }
  if (payload) {
    env.LD_LIBRARY_PATH = [join(snap, "lib"), join(snap, "usr/lib"), join(snap, "usr/lib/x86_64-linux-gnu"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":")
    env.ALSOFT_DRIVERS = "-oss,-alsa,"
    env.SDL_AUDIODRIVER = "pulseaudio"
  }
  return env
}

export interface BlendExternal {
  /** 数据块名（如 checker / 链接库名）。 */
  datablock: string
  kind: "image" | "library" | "font"
  /** .blend 里原样保存的路径（`//` 相对路径或绝对路径）。 */
  raw: string
  /** 相对 .blend 所在目录解析后的绝对路径。 */
  resolved: string
  /** 磁盘上是否真的有这个文件（问文件系统，不猜）。 */
  exists: boolean
}

export interface BlendInspection {
  blend: string
  blender: string
  externals: BlendExternal[]
  /** 内容指纹：只用于证明"副本内容与原件一致（除路径外）"，不参与版本身份。 */
  fingerprint: { objects: string[]; images: string[]; materials: string[]; vertices: number }
}

/** 只读探针：打开 .blend 读出外部依赖与结构指纹，不保存、不改字节。 */
const PROBE = `
import bpy, json, os
def resolved(raw):
    if raw.startswith("//"):
        return os.path.normpath(os.path.join(os.path.dirname(bpy.data.filepath), raw[2:]))
    return os.path.normpath(raw)
rows = []
def collect(collection, kind, builtin_prefix):
    for item in collection:
        raw = getattr(item, "filepath", "") or ""
        if not raw or raw.startswith(builtin_prefix) or getattr(item, "library", None) is not None: continue
        if kind == "image" and (getattr(item, "packed_file", None) or getattr(item, "packed_files", None)): continue
        target = resolved(raw)
        rows.append({"datablock": item.name, "kind": kind, "raw": raw, "resolved": target, "exists": os.path.isfile(target)})
collect(bpy.data.images, "image", "<")
collect(bpy.data.libraries, "library", "<")
collect(bpy.data.fonts, "font", "<")
meshes = [object for object in bpy.data.objects if object.type == "MESH"]
print("BLEND_PROBE=" + json.dumps({
    "blend": bpy.data.filepath,
    "blender": bpy.app.version_string,
    "externals": rows,
    "fingerprint": {
        "objects": sorted(object.name + ":" + object.type for object in bpy.data.objects),
        "images": sorted(image.name + ":" + image.source for image in bpy.data.images),
        "materials": sorted(material.name for material in bpy.data.materials),
        "vertices": sum(len(object.data.vertices) for object in meshes),
    },
}, ensure_ascii=False))
`

/** 只对**副本**做的路径改写（原件绝不进入这条路径）；mapping 的键是 .blend 里原样的路径字符串。 */
const REPATH = `
import bpy, json, sys
mapping = json.loads(sys.argv[sys.argv.index("--") + 1])
changed = []
def assign(collection, kind):
    for item in collection:
        raw = getattr(item, "filepath", "") or ""
        if raw in mapping and getattr(item, "library", None) is None:
            item.filepath = mapping[raw]
            changed.append([kind, item.name, raw, mapping[raw]])
assign(bpy.data.images, "image")
assign(bpy.data.libraries, "library")
assign(bpy.data.fonts, "font")
saved = ""
if changed:
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_mainfile()
    saved = bpy.data.filepath
print("BLEND_REPATH=" + json.dumps({"changed": changed, "saved": saved}, ensure_ascii=False))
`

/** 起一个真实 Blender 读 .blend；超时/非零退出/探针行缺失都明确失败，不退化成"猜一个结果"。 */
async function runBlender(path: string, script: string, argv: string[] = []): Promise<string> {
  const executable = blenderExecutable()
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(settle => {
    execFile(executable, ["--background", path, "--python-exit-code", "1", "--python-expr", script, ...(argv.length ? ["--", ...argv] : [])],
      { env: blenderEnvironment(), timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => settle({ code: error ? (error as { code?: number }).code ?? 1 : 0, stdout: String(stdout), stderr: String(stderr), timedOut: Boolean(error && (error as { killed?: boolean }).killed) }))
  })
  if (result.timedOut) throw new Error(`BLEND_TOOL_TIMEOUT: ${executable} ${path}`)
  if (result.code !== 0) throw new Error(`BLEND_TOOL_FAILED: exit=${result.code} ${path} ${result.stderr.trim().slice(-400)}`)
  return result.stdout
}

export async function inspectBlend(path: string): Promise<BlendInspection> {
  const stdout = await runBlender(path, PROBE)
  const line = stdout.split("\n").find(text => text.startsWith("BLEND_PROBE="))
  if (!line) throw new Error(`BLEND_PROBE_MISSING: ${path}（${blenderExecutable()} 未返回探针结果行）`)
  const parsed = JSON.parse(line.slice("BLEND_PROBE=".length)) as { blend: string; blender: string; externals: BlendExternal[]; fingerprint: BlendInspection["fingerprint"] }
  return { blend: parsed.blend, blender: parsed.blender, externals: parsed.externals, fingerprint: parsed.fingerprint }
}

/**
 * 本机有没有可用的 Blender（取法与 blenderExecutable 同源：环境变量 → snap 载荷 → PATH 扫描）。
 * 只回答"能不能问 Blender"，不回答"这个 .blend 读不读得出"——读得出/读不出由真实调用结果决定。
 */
export function blenderAvailable(): boolean {
  const executable = blenderExecutable()
  if (executable.includes("/")) return existsSync(executable)
  return (process.env.PATH ?? "").split(":").filter(Boolean).some(directory => existsSync(join(directory, executable)))
}

export interface BlendExternalFiles {
  /** confirmed：Blender 真的读出了这份工程的依赖；unknown：本机没有 Blender，依赖状况未知（不假装闭合）。 */
  state: "confirmed" | "unknown"
  blender: string
  /** state=unknown 时的原因码。 */
  reason?: string
  /** 读盘确认真实存在的外部依赖绝对路径（`.blend` 链接库会继续展开它自己的外部依赖）。 */
  files: string[]
  /** Blender 读数里引用、但磁盘上不在场的外部依赖（不塞进依赖集，交给调用方如实记录/拒绝）。 */
  missing: BlendExternal[]
}
/**
 * 一份 .blend 真实的外部依赖文件（图片/链接库/字体），供资源依赖闭包使用。
 * 这是对 `inspectBlend` 的一次包装，不另立解析器；Blender 在场但读失败时**照原样抛错**（BLEND_TOOL_*），
 * 只有"本机根本没有 Blender"才退化为 `state:"unknown"`——依赖未知时如实说，不当成没有依赖。
 */
const externalFilesMemo = new Map<string, Promise<BlendExternalFiles>>()
export async function blendExternalFiles(path: string): Promise<BlendExternalFiles> {
  path = resolve(path)
  if (!blenderAvailable()) return { state: "unknown", blender: blenderExecutable(), reason: "BLENDER_UNAVAILABLE", files: [], missing: [] }
  // 进程内记忆化：键含文件自身的大小与 mtime，同一份字节在一轮里只问一次 Blender；文件一变就换键。
  const key = await stat(path).then(info => `${path}|${info.size}|${info.mtimeMs}`, () => path)
  const known = externalFilesMemo.get(key)
  if (known) return known
  const pending = (async (): Promise<BlendExternalFiles> => {
    const seen = new Set<string>([path]), files: string[] = [], missing: BlendExternal[] = []
    let blender = ""
    const queue = [path]
    while (queue.length) {
      const host = queue.shift()!
      const inspection = await inspectBlend(host)
      blender ||= inspection.blender
      for (const row of inspection.externals) {
        if (!row.exists) { missing.push(row); continue }
        if (!files.includes(row.resolved)) files.push(row.resolved)
        if (row.kind === "library" && !seen.has(row.resolved)) { seen.add(row.resolved); queue.push(row.resolved) }
      }
    }
    return { state: "confirmed", blender, files, missing }
  })()
  externalFilesMemo.set(key, pending)
  if (externalFilesMemo.size > 64) externalFilesMemo.delete(externalFilesMemo.keys().next().value!)
  try { return await pending } catch (error) { externalFilesMemo.delete(key); throw error }
}

/** 在副本上把外部引用改写成便携目录内的相对路径，然后保存**这个副本**。 */
export async function repathBlendCopy(target: string, mapping: Map<string, string>): Promise<void> {
  if (!mapping.size) return
  const stdout = await runBlender(target, REPATH, [JSON.stringify(Object.fromEntries(mapping))])
  const line = stdout.split("\n").find(text => text.startsWith("BLEND_REPATH="))
  if (!line) throw new Error(`BLEND_REPATH_MISSING: ${target}`)
  const parsed = JSON.parse(line.slice("BLEND_REPATH=".length)) as { changed: string[][]; saved: string }
  if (parsed.changed.length !== mapping.size || parsed.saved === "") throw new Error(`BLEND_REPATH_INCOMPLETE: ${target} 声明 ${mapping.size} 条改写，实际 ${parsed.changed.length} 条`)
}
