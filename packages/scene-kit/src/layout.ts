import { join, resolve } from "node:path"
import { safeId } from "./persistence.ts"

/**
 * 运行根的存储分治布局：世界（场景+环境）→ worlds、可调用小物件 → assets、机器人 → robots、
 * 派生/下载/CAS → cache、目录索引 → catalog。
 *
 * 省略 layout 时五个域根全部等于 dataRoot，逐路径等价于过去的单根行为：
 *   场景 <dataRoot>/scenes、索引 <dataRoot>/resources、CAS <dataRoot>/assets/cas、
 *   派生 <dataRoot>/assets/derived、下载 <dataRoot>/resources/network、生成来源 <dataRoot>/provider-jobs。
 * 因此 layout 是纯增量参数，既有调用方无需改动。
 */
export interface SceneLayout { worlds: string; assets: string; robots: string; cache: string; catalog: string }

/** 资源归属的域：world 含场景与背景/环境，object 是可调用小物件，robot 是机器人本体。 */
export type SceneLayoutDomain = "worlds" | "assets" | "robots"

/** 解析后的布局：五个域根一律是绝对路径，另带域模式标记与“运行根内已托管目录”清单。 */
export interface ResolvedSceneLayout extends SceneLayout {
  /** 域模式：显式给出 layout 即 true。域模式下目录索引根就是 <catalog> 本身，
   *  CAS/派生/下载分别落在 <cache>/{cas,derived,download}；省略 layout 时保持单根旧形状。 */
  split: boolean
  /** 已管轄的运行根：这些目录内的原件导入时引用原位置、不复制（与旧行为 pathInside(dataRoot, path) 同义）。 */
  managedRoots: string[]
}

const LAYOUT_KEYS = ["worlds", "assets", "robots", "cache", "catalog"] as const

/**
 * 把可选 layout 解析成生效布局。给出 layout 时五个域一律必填（缺失/空白直接报错，
 * 不做“半个布局”的猜测）；省略时五域回落到 directory 并保持单根旧路径形状。
 */
export function resolveSceneLayout(directory: string, layout?: SceneLayout): ResolvedSceneLayout {
  const root = resolve(directory)
  if (!layout) return { worlds: root, assets: root, robots: root, cache: root, catalog: root, split: false, managedRoots: [root] }
  const resolved = {} as SceneLayout
  for (const key of LAYOUT_KEYS) {
    const value = layout[key]
    if (typeof value !== "string" || !value.trim()) throw new Error(`SCENE_LAYOUT_INVALID: ${key}`)
    resolved[key] = resolve(value)
  }
  return { ...resolved, split: true, managedRoots: [...new Set(LAYOUT_KEYS.map(key => resolved[key]))] }
}

/**
 * 域内 home 目录：<域根>/<assetId>/source；world 域统一收在 environments/ 下
 * （background 与 scene 两类来源同属世界域，不另造第五个目录）。
 */
export function materializedHome(layout: ResolvedSceneLayout, domain: SceneLayoutDomain, assetId: string): { domain: SceneLayoutDomain; directory: string } {
  const id = safeId(assetId)
  return domain === "worlds"
    ? { domain, directory: join(layout.worlds, "environments", id, "source") }
    : { domain, directory: join(layout[domain], id, "source") }
}
