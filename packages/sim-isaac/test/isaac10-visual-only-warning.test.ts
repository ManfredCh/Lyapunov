/**
 * ISAAC-10 收口：纯视觉实体（无碰撞）说明的**离线回归守卫**（静态契约，不是引擎实测）。
 *
 * 真机证据见回执 `bugfixHistory/ISAAC10-VISUAL-WARNING-20260922.md`：同一场景下修前 handle 完全没有
 * `warnings` 键；修后只在 `visual-only`（GLB 视觉、无原生源）上出现 `ENTITY_VISUAL_ONLY`，而同场景的
 * `collide-box`（MJCF box，有碰撞）不出现。
 *
 * 这里把三件事钉在源码上（都在 worker.py 的 `handle()` 里）：
 *  1. 说明走**既有** `warnings` 通道（不是新字段/新通道），且是与 GLB 导入回执**合并**后写出；
 *  2. 触发条件是适配层已有的 `metadata.visualOnly`（没有原生源、只有 GLB 视觉）；
 *  3. 文案可读且带实体 id（人能看懂"该实体没有碰撞体"），并保留 `purpose=guide` 这个 USD 层事实。
 * 另外做一次**共享写域自检**：`worker.py` 是多 lane 热点，本文件顺带断言既有标记（GLB 导入回执通道、
 * camera_adjust）没有被覆盖。
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const worker = readFileSync(join(import.meta.dirname, '../python/worker.py'), 'utf8')

/** 取出 handle() 的函数体（缩进块），避免匹配到别处的同名片段。 */
function handleBody(): string {
  const start = worker.indexOf('    def handle(self):')
  expect(start).toBeGreaterThan(-1)
  const rest = worker.slice(start + '    def handle(self):'.length)
  const next = rest.search(/\n {4}def /)
  return next === -1 ? rest : rest.slice(0, next)
}

test('handle() 通过既有 warnings 通道写出纯视觉实体说明，并与 GLB 导入回执合并', () => {
  const body = handleBody()
  // 既有通道：先取导入回执，再把新说明 append 进去，最后只在非空时写 result['warnings']。
  expect(body).toContain('warnings_out=list(self.import_warnings)')
  expect(body).toContain("if warnings_out:result['warnings']=warnings_out")
  expect(body).toContain("'code':'ENTITY_VISUAL_ONLY'")
  // 不新建字段/通道：不出现第二个 warnings 键或其他新增顶层字段。
  expect(body.match(/result\['warnings'\]/g)?.length).toBe(1)
})

test('触发条件是适配层已有的 metadata.visualOnly，说明按 entityId 归属且文案可读', () => {
  const body = handleBody()
  expect(body).toContain("self.entities[eid].get('metadata',{}).get('visualOnly')")
  expect(body).toContain("'entityId':eid")
  expect(body).toContain('没有碰撞体')
  expect(body).toContain('purpose=guide')
  expect(body).toContain('不参与接触/碰撞')
})
test('GLB视觉来源已有真实Scene primitive时不报无碰撞，collisionSources不再带矛盾reason',()=>{
 const body=handleBody()
 expect(body).toContain("get('visualOnly') and not self.entities[eid].get('collision')")
 expect(body).toContain("source='scene-primitive';reason=None")
})

test('适配层确实产出 visualOnly（无原生源、只有 GLB 视觉时才为真）', () => {
  const adapter = readFileSync(join(import.meta.dirname, '../python/scene_adapter.py'), 'utf8')
  expect(adapter).toContain("return visual,cfg,{'visualOnly':bool(visual)}")
  // 有原生源（MJCF/URDF/USD）的分支不返回 visualOnly —— 这正是负对照成立的原因。
  expect(adapter).toContain("if source.endswith(('.usd','.usda','.usdc')):return source,cfg,{}")
})

test('共享写域自检：既有标记仍在（本 lane 只做定点编辑，未覆盖他人块）', () => {
  expect(worker).toContain('glb_import_warnings')            // N15：GLB 导入回执通道
  expect(worker).toContain('GLB_IMPORT_WARNING_PREFIX')
  expect(worker).toContain('camera_adjust')                  // N15/N22：相机族
  expect(worker).toContain("'capabilities':self.capabilities(e)")   // T4/T16：能力面
  expect(worker).toContain("e['controlledSource']")                 // T4/T16：受控来源
})
