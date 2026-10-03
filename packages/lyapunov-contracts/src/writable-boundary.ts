import { lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import { safeSessionKey } from "./session-scope.ts"

/**
 * 「宿主代写目标」的**唯一判定规则**：场景/资产工具的显式导出路径（scene-kit）与 Host 媒体中转
 * （sim-contract 的 `stagingFor`）共用这一份，避免同一个"写出去"换入口就换判据。
 *
 * 判据本身不是这里发明的，是**上游已有的两条**：
 *   · 许可根 = 原生 `writableRoots(policy)`，其内部已按 `canonicalPath`（`realpathSync.native`）规范
 *     （`.upstream/.../sandbox/sandbox/src/roots.ts`）；
 *   · 目标 = 上游 fs 的同一个做法：端点存在就取它自己的 realpath（符号链接解析到真实目标），
 *     端点或其前缀还不存在就 realpath **最近的存在祖先**再拼回缺失后缀
 *     （`.upstream/.../fs/fs-local/src/fsio.ts` 的 `resolveLocalTarget`，理由是不存在的末端路径
 *     在创建前后身份要一致——导出目录本来就常常还没建）。
 * 词法 `relative` 比较正是被这两条取代的东西：它既看不到符号链接，也把"根里的链接指向根外"当根内。
 */

/**
 * 目标的规范路径（绝对路径）：符号链接按文件系统真实目标解析；末端或中间目录还不存在时按上游
 * 缺失后缀规则回填，比较结果与"目标创建之后"一致。
 * @param path - 绝对或相对路径；相对路径按宿主进程 cwd 解析（调用方应先按会话工作区解析）。
 */
export function canonicalTargetPath(path: string): string {
  // 相对路径拼成绝对路径时**不做词法归一**：`link/../x` 里 `..` 是跟着链接走的（内核先展开链接再回退），
  // 词法折叠会把它错判成"还在根内"，而真正落盘的是链接指向的目录。native realpath 按组件查表，正是为此。
  return resolveCanonical(isAbsolute(path) ? path : `${process.cwd()}/${path}`, 0)
}

/**
 * 解析到"最具体的可解析前缀 + 缺失后缀"：与上游 `resolveLocalTarget` 同一条规则，唯一补的一点是
 * **悬空符号链接**——它同样让 `realpath` 失败，但写入时内核会跟着链接落到链接指向的目录
 *（那个目录可能还不存在），所以不能把它当成"普通的不存在目录"从词法上放行；这里先把链接下来再继续解析。
 * 递归深度上限只为兜住链接自指，正常路径一次都不触发。
 */
function resolveCanonical(absolute: string, depth: number): string {
  const missing: string[] = []
  let cursor = absolute
  while (true) {
    try {
      // 与上游 canonicalPath 同一原语：native realpath 按文件系统逐组件查表，先展开符号链接再收尾。
      return join(realpathSync.native(cursor), ...missing)
    } catch {
      // 解析不了：这一段不存在，或者是悬空符号链接（下面单独处理），继续往上找最近的存在祖先。
    }
    if (depth < 16) {
      const info = lstatIfPresent(cursor)
      if (info?.isSymbolicLink()) {
        const link = readlinkSync(cursor)
        const linked = isAbsolute(link) ? link : join(dirname(cursor), link)
        return resolveCanonical(join(linked, ...missing), depth + 1)
      }
    }
    const parent = dirname(cursor)
    if (parent === cursor) return join(cursor, ...missing)
    missing.unshift(basename(cursor))
    cursor = parent
  }
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

/** 路径是否落在某个根之内（含根本身）：两边都按 {@link canonicalTargetPath} 规范化后比较。 */
export function pathWithin(root: string, path: string): boolean {
  const rel = relative(canonicalTargetPath(root), canonicalTargetPath(path))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** 会话私有目录在授权根内的落点（原生 worker 运行根与产品会话存储共用这一条命名规则）。 */
export const SESSION_PRIVATE_PARENT = ".lyapunov/sessions"

/** 会话私有目录的父目录（`<授权根>/.lyapunov/sessions`）的规范路径；它本身是共享层，不是某条会话的私有目录。 */
export function sessionPrivateParent(workspaceRoot: string, runtimeParent = SESSION_PRIVATE_PARENT): string {
  return canonicalTargetPath(join(workspaceRoot, runtimeParent))
}

/**
 * 目标落在哪条会话的私有目录里：返回 `<父目录>/<会话键>` 的第一段会话键；目标不在会话私有目录下
 * （包括就是父目录本身、或压根不在父目录里）时返回 undefined。
 * `safeSessionKey` 与目录命名是同一份规则，所以拿会话 id 算出来的键可以直接比对。
 */
export function sessionKeySegment(target: string, workspaceRoot: string, runtimeParent = SESSION_PRIVATE_PARENT): string | undefined {
  const rel = relative(sessionPrivateParent(workspaceRoot, runtimeParent), canonicalTargetPath(target))
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined
  return rel.split(/[\\/]/)[0]
}

/** 目标是否落在**别人**的会话私有目录里（自己的会话键与共享层都放行）。 */
export function isForeignSessionTarget(target: string, workspaceRoot: string, ownSessionKey: string | undefined, runtimeParent = SESSION_PRIVATE_PARENT): boolean {
  const segment = sessionKeySegment(target, workspaceRoot, runtimeParent)
  if (segment === undefined) return false
  return ownSessionKey === undefined || segment !== safeSessionKey(ownSessionKey)
}
