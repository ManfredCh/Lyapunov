import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
/**
 * 场景目录的普通只读投影；主动Command与被动界面读取使用同一个实现。
 *
 * 顺序：**最近修改在前**（mtimeMs 降序，平手按文件名）。3D 视口在"没有缓存、也没有显式意图"时
 * 取清单第一条（workbench.tsx 的 `list[0]?.sceneId`）；旧实现按 readdir 原序返回，用户刚导入/刚编辑
 * 过的场景未必在第一条，画布看上去就"没反应"。排序放在这里，agent 的 `scene_list` 与界面投影同时受益。
 */
export async function listSceneSummaries(directory: string, snapshot: (sceneId: string) => Promise<SceneSnapshot>): Promise<Array<{ sceneId: string; revision: number; entityCount: number }>> {
 let names: string[]
 try { names = await readdir(join(directory, 'scenes')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
 const stamped = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
  // 读不到 mtime（并发删除等）时退化为 0，不让一次 stat 失败抹掉整张清单。
  const mtimeMs = await stat(join(directory, 'scenes', name)).then(value => value.mtimeMs).catch(() => 0)
  return { name, mtimeMs }
 }))
 stamped.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
 return Promise.all(stamped.map(async ({ name }) => { const scene = await snapshot(name.slice(0, -5)); return { sceneId: scene.sceneId, revision: scene.revision, entityCount: scene.entities.length } }))
}
