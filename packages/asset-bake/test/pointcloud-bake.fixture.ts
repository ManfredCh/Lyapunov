/** Node 真实公开工具/Jobs 验收；Bun 1.3 的 node:util 缺 getSystemErrorMessage，不能拿 mock 补成通过。
 * 命令：node --experimental-transform-types 本文件 <独立输出目录> <实际算法 Python>。 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { JobId } from '@deepseek-ai/dsh-jobs'
import * as assetBake from '../src/plugin.ts'

const output = resolve(process.argv[2] ?? '.runtime/pointcloud-tool-fixture')
const python = process.argv[3]
// 可显式指向独立搬移的正式 dist/plugin.js，验证其 bake.py 真正随包而非借源码路径。
const plugin = process.argv[4] ? await import(pathToFileURL(resolve(process.argv[4])).href) as typeof assetBake : assetBake
assert(python, '必须明确提供已有算法 Python，不猜另一工作区或用户 SDK')
await mkdir(output, { recursive: true })
const source = join(output, '真实点云.ply')
const points = [[.01, .01, .01], [.11, .01, .01], [.21, .01, .01], [.81, .01, .01], [.91, .01, .01], [1.01, .01, .01]]
const header = Buffer.from('ply\nformat binary_little_endian 1.0\nelement vertex 6\nproperty float x\nproperty float y\nproperty float z\nproperty float opacity\nend_header\n')
const binary = Buffer.alloc(points.length * 16)
points.forEach((point, i) => [...point, 1].forEach((value, a) => binary.writeFloatLE(value, i * 16 + a * 4)))
await writeFile(source, Buffer.concat([header, binary]))
const before = createHash('sha256').update(await readFile(source)).digest('hex')
const ctx = new Context()
const fibers = [await ctx.plugin(Timer), await ctx.plugin(SystemPrompt), await ctx.plugin(Tools), await ctx.plugin(SubprocessLocal), await ctx.plugin(JobsLocal)]
const detach = ctx.jobs.attachController('pointcloud-tool-fixture')
fibers.push(await ctx.plugin({ name: 'pointcloud-asset-bake', inject: plugin.inject, apply: (scoped: Context) => plugin.apply(scoped, { python }) } as never, undefined as never))
const request = { sourcePath: source, outputDirectory: join(output, 'foreground'), sourceUpAxis: 'Z', metersPerUnit: 1, strategy: 'auto', usage: 'environment', voxelSizeM: .1 }
let n = 0
const call = (outputDirectory: string, background: boolean) => ctx.tools.execute({ name: 'asset_bake', arguments: { request_json: JSON.stringify({ ...request, outputDirectory }), background }, signal: new AbortController().signal, callId: ToolCallId('pointcloud-tool-fixture-' + ++n) })
try {
  const foreground = await call(request.outputDirectory, false)
  assert.equal(foreground.isError, false, JSON.stringify(foreground.content))
  const fg = JSON.parse((foreground.value as { result: string }).result)
  assert.equal(fg.objects[0].selected, 'voxel_boxes'); assert.equal(fg.objects[0].pointCloud.sourcePoints, 6)
  assert.equal(fg.objects[0].boxes.length, 2)
  const background = await call(join(output, 'background'), true)
  assert.equal(background.isError, false)
  const completedId = JobId(JSON.parse((background.value as { result: string }).result).jobId)
  const done = await ctx.jobs.wait(completedId, 10000)
  assert.equal(done.status, 'completed')
  const bg = JSON.parse(ctx.jobs.read(completedId).text)
  assert.deepEqual(bg.objects[0].boxes, fg.objects[0].boxes)
  const cancelled = await call(join(output, 'cancelled'), true)
  assert.equal(cancelled.isError, false)
  const cancelId = JobId(JSON.parse((cancelled.value as { result: string }).result).jobId)
  assert.equal(ctx.jobs.get(cancelId).status, 'running')
  ctx.jobs.kill(cancelId)
  const stopped = await ctx.jobs.wait(cancelId, 10000)
  assert.equal(stopped.status, 'killed')
  assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), before)
  await writeFile(join(output, 'tool-job.json'), JSON.stringify({ status: 'passed', before, foreground: fg, background: done, cancelled: stopped }, null, 2))
  console.log(JSON.stringify({ status: 'passed', foregroundBoxes: fg.objects[0].boxes.length, background: done.status, cancel: stopped.status, sourcePreserved: true }))
} finally { detach(); for (const fiber of fibers.reverse()) await fiber.dispose() }
