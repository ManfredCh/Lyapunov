import { createHash } from "node:crypto"
import { resolve, join } from "node:path"
import { SDK_PYTHON_ENV } from "./sdk-python.mjs"

export type RunMode = "formal" | "developer" | "local" | "guest"
export interface RuntimeIdentity { mode: RunMode; accountId?: string; root: string; production?: boolean }

/**
 * 运行时的新 canonical 名称。旧 lyaup 只作为显式兼容输入，不参与新目录
 * 或新 profile 的生成。DSH_HOME 仍保持上游契约名称，不在这里改写。
 */
export const RUNTIME_NAME = "lyapunov" as const
export const LEGACY_RUNTIME_NAME = "lyaup" as const
export const RUNTIME_ENV = {
  productRoot: "LYAPUNOV_PRODUCT_ROOT",
  sceneRoot: "LYAPUNOV_SCENE_ROOT",
  pluginRoot: "LYAPUNOV_PLUGIN_ROOT",
  mode: "LYAPUNOV_MODE",
  developerAuthFile: "LYAPUNOV_DEVELOPER_AUTH_FILE",
  developerProvider: "LYAPUNOV_DEVELOPER_PROVIDER",
  developerModel: "LYAPUNOV_DEVELOPER_MODEL",
  developerReasoningEffort: "LYAPUNOV_DEVELOPER_REASONING_EFFORT",
  apiUrl: "LYAPUNOV_API_URL",
  accountToken: "LYAPUNOV_ACCOUNT_TOKEN",
  accountSessionFile: "LYAPUNOV_ACCOUNT_SESSION_FILE",
  desktopDataDir: "LYAPUNOV_DESKTOP_DATA_DIR",
  simEngine: "LYAPUNOV_SIM_ENGINE",
  graspProvider: "LYAPUNOV_GRASP_PROVIDER",
  electronBinary: "LYAPUNOV_ELECTRON_BINARY",
  sam3Checkpoint: "LYAPUNOV_SAM3_CHECKPOINT",
  updateUrl: "LYAPUNOV_UPDATE_URL",
  // SDK 解释器覆盖键：唯一解析实现在 sdk-python.mjs，doctor 与 Host 装配/物理检查共用。
  policyPython: "LYAPUNOV_POLICY_PYTHON",
  mujocoPython: SDK_PYTHON_ENV.mujoco,
  isaacPython: SDK_PYTHON_ENV.isaac,
  // FastGS 外部工具的本地覆盖键：设置界面/CLI 都在 Host 进程内读 process.env，隔离启动必须逐键搬运。
  fastgsHome: "LYAPUNOV_FASTGS_HOME",
  fastgsPython: "LYAPUNOV_FASTGS_PYTHON",
  fastgsDataDir: "LYAPUNOV_FASTGS_DATA_DIR",
  micromamba: "LYAPUNOV_MICROMAMBA",
} as const
/** FastGS 本地工具的路径与解释器覆盖键，正式和开发入口共用。 */
export const FASTGS_RUNTIME_ENV_KEYS = [
  RUNTIME_ENV.fastgsHome,
  RUNTIME_ENV.fastgsPython,
  RUNTIME_ENV.fastgsDataDir,
  RUNTIME_ENV.micromamba,
] as const
export const LEGACY_RUNTIME_ENV = {
  productRoot: "LYAUP_PRODUCT_ROOT",
  sceneRoot: "LYAUP_SCENE_ROOT",
  pluginRoot: "LYAUP_PLUGIN_ROOT",
  mode: "LYAUP_MODE",
  developerAuthFile: "LYAUP_DEVELOPER_AUTH_FILE",
  developerProvider: "LYAUP_DEVELOPER_PROVIDER",
  developerModel: "LYAUP_DEVELOPER_MODEL",
  developerReasoningEffort: "LYAUP_DEVELOPER_REASONING_EFFORT",
  apiUrl: "LYAUP_API_URL",
  accountToken: "LYAUP_ACCOUNT_TOKEN",
  accountSessionFile: "LYAUP_ACCOUNT_SESSION_FILE",
  desktopDataDir: "LYAUP_DESKTOP_DATA_DIR",
  simEngine: "LYAUP_SIM_ENGINE",
  graspProvider: "LYAUP_GRASP_PROVIDER",
  electronBinary: "LYAUP_ELECTRON_BINARY",
  sam3Checkpoint: "LYAUP_SAM3_CHECKPOINT",
  updateUrl: "LYAUP_UPDATE_URL",
} as const
export type RuntimeEnvKey = keyof typeof RUNTIME_ENV
/** 读取 canonical 环境变量；旧变量只作为显式兼容输入读取一次。 */
export function readRuntimeEnv(parent: NodeJS.ProcessEnv, key: RuntimeEnvKey) {
  // 新增键（如 SDK 解释器覆盖）没有 LYAUP_* 旧名，不新增遗留兼容。
  const legacy = (LEGACY_RUNTIME_ENV as Partial<Record<RuntimeEnvKey, string>>)[key]
  return parent[RUNTIME_ENV[key]] ?? (legacy ? parent[legacy] : undefined)
}

/** 延续旧账号的稳定路径算法；模式仅由启动进程确定。 */
export function runtimePaths(input: RuntimeIdentity) {
  if (input.mode === "developer" && input.production) throw new Error("生产构建不允许开发模式")
  if (input.mode === "formal" && !input.accountId?.trim()) throw new Error("AUTH_REQUIRED: 正式 Host 需要服务端验证后的账号身份")
  if (input.mode === "guest" && input.accountId !== undefined) throw new Error("GUEST_ACCOUNT_FORBIDDEN: 游客运行身份不接受账号 ID")
  const identity = input.mode !== "formal" ? input.mode : createHash("sha256")
    .update(`lyaup-account-workspace-v1\0${input.accountId!.trim()}`).digest("hex").slice(0, 32)
  const root = resolve(input.root, input.mode !== "formal" ? input.mode : join("accounts", identity))
  // 三类可调用产物分治：world（场景+环境）/ assets（小物件）/ robots（机器人）各一个域根，
  // 派生、下载、CAS 统一进 cache（可整删可重建）；catalog 只放唯一目录索引。
  // sceneRoot 是分治前的单根位置，仅保留给迁移与旧数据读取，不再是新的写入落点。
  return {
    root, identity,
    dshHome: join(root, "dsh"),
    pluginRoot: join(root, "plugins"),
    workspaceRoot: join(root, "workspace"),
    sceneRoot: join(root, "scene"),
    worldsRoot: join(root, "worlds"),
    assetsRoot: join(root, "assets"),
    robotsRoot: join(root, "robots"),
    cacheRoot: join(root, "cache"),
    catalogRoot: join(root, "catalog"),
  }
}

export type RuntimePaths = ReturnType<typeof runtimePaths>

/** scene-kit 等消费方使用的分域布局；与 runtimePaths 的域根一一对应。 */
export function sceneLayout(paths: Pick<RuntimePaths, "worldsRoot" | "assetsRoot" | "robotsRoot" | "cacheRoot" | "catalogRoot">) {
  return { worlds: paths.worldsRoot, assets: paths.assetsRoot, robots: paths.robotsRoot, cache: paths.cacheRoot, catalog: paths.catalogRoot }
}

/**
 * 把分域目录映射进用户工作文件夹，让"自己的工作区"下一眼就能看到三类内容，
 * 而不必去记 .runtime/<mode>/<account>/ 这种机器路径：
 *   <workspaceRoot>/{worlds,assets,robots,cache} -> 各域真实根
 *   <productRoot>/workspace                       -> 当前活动 workspaceRoot（人类入口）
 * 只创建/刷新符号链接，绝不接管或删除同名真实目录；返回本函数真实创建或修正的条目。
 */
export async function ensureWorkspaceMapping(input: { productRoot: string; workspaceRoot: string; paths: Pick<RuntimePaths, "worldsRoot" | "assetsRoot" | "robotsRoot" | "cacheRoot">; /**
 * 是否认领 <产品根>/workspace 人类导航入口。默认 true，保持明确认领/旧调用的行为。
 * false 时不创建也不重指全局入口；runtime.workspaceRoot 内四条域映射仍照常建立。
 * 同名真实目录始终属于用户内容，不接管。
 *
 * 调用方 script/profile.ts:prepareProfile 仍按父目录名 === mode 判 canonicalEntry；
 * 正式账户根的父目录是 accounts、桌面 guest 根的父目录是 runtime，都会传 false。
 * Files 的状态根是原生 Session.cwd，不从这个导航软链推导。
 *
 * 已知开口仍保留给 Lead：目录名谓词不能证明持久性，临时根若恰好叫 developer
 * 仍可能被调用方误传 true；本次只闭合非认领首准备误建入口，不改该谓词或 Session scope。
 * 持久但非 canonical 的调用同样不认领全局导航；若要全局入口，应由实际调用方显式声明。
 */ claimProductEntry?: boolean }) {
  const { lstat, mkdir, symlink, rm } = await import("node:fs/promises")
  const { relative } = await import("node:path")
  const changed: string[] = []
  const link = async (path: string, target: string) => {
    const want = relative(join(path, ".."), target) || target
    const existing = await lstat(path).catch(() => undefined)
    if (existing?.isSymbolicLink()) {
      const { readlink } = await import("node:fs/promises")
      if ((await readlink(path).catch(() => "")) === want) return
      await rm(path, { force: true })
    } else if (existing) return // 同名真实目录属于用户内容，不接管
    await symlink(want, path)
    changed.push(path)
  }
  await mkdir(input.workspaceRoot, { recursive: true })
  for (const [name, target] of [["worlds", input.paths.worldsRoot], ["assets", input.paths.assetsRoot], ["robots", input.paths.robotsRoot], ["cache", input.paths.cacheRoot]] as const) {
    await mkdir(target, { recursive: true })
    await link(join(input.workspaceRoot, name), target)
  }
  // 非认领调用不创建也不重指全局导航入口，不能让首次 QA 准备占住它。
  // 域内四条软链与本标志无关，上一段已照常建立。
  if (input.claimProductEntry === false) return changed
  const entry = join(input.productRoot, "workspace")
  await link(entry, input.workspaceRoot)
  return changed
}

/** Host 退出后才切换身份，清理旧世界与订阅和 Session 句柄。 */
export class RuntimeOwner {
  #dispose?: () => Promise<void>
  #pending: Promise<void> = Promise.resolve()
  switch(start: () => Promise<() => Promise<void>>) {
    const next = this.#pending.then(async () => {
      if (this.#dispose) { await this.#dispose(); this.#dispose = undefined }
      this.#dispose = await start()
    })
    this.#pending = next.catch(() => {})
    return next
  }
  close() { return this.switch(async () => async () => {}) }
}
