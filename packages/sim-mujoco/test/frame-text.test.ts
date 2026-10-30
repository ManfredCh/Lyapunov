/**
 * 帧输出快路径（P1）的单元核对：真实 sim-python 解释器调用 `frame_text_check.py`。
 *
 * 覆盖：`human.observe_many_text` 与 `observe_many` 逐字节等价（batch≥256 / scalar<256、
 * kinematic / ragdoll、有无 target/motion、含 % 的实体名），非有限数组抛与原路径同类错误，
 * `observed_quaternions_batch` 新旧实现逐位相等（随机、trace≈0、对角相等、精确 π、-0.0）。
 * 整帧 byte-for-byte 的端到端等价由真实 worker 门（p1/frame_check_worker.py）覆盖，本文件不冒充。
 *
 * 运行：
 *   LYAPUNOV_MUJOCO_PYTHON=<含 mujoco 的解释器> \
 *     node --experimental-transform-types --test packages/sim-mujoco/test/frame-text.test.ts
 * 未提供解释器（且仓内默认路径不存在）时整组 skip，不静默当成通过。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const defaultPython = resolve(here, '../../../.runtime/sim-python/bin/python')
const pythonPath = process.env.LYAPUNOV_MUJOCO_PYTHON ?? (existsSync(defaultPython) ? defaultPython : undefined)
const checkerPath = resolve(here, 'frame_text_check.py')

const suite = pythonPath ? describe : describe.skip
suite(pythonPath ? `帧输出快路径单元核对（真实 MuJoCo：${pythonPath}）` : '帧输出快路径单元核对（跳过：未提供 LYAPUNOV_MUJOCO_PYTHON，且仓内默认解释器不存在）', () => {
  test('observe_many_text 与逐位四元数核对全部通过', () => {
    assert.ok(existsSync(checkerPath), `缺少检查器 ${checkerPath}`)
    const result = spawnSync(pythonPath!, [checkerPath], { env: process.env, encoding: 'utf8', timeout: 600_000 })
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    const payload = /CHECK_RESULT=(\{.*\})/s.exec(output)
    assert.ok(payload, `检查器没有输出 CHECK_RESULT（exit=${result.status}）：\n${output.slice(-2000)}`)
    const parsed = JSON.parse(payload[1])
    assert.equal(parsed.pass, true, `CHECK_RESULT 未通过：${JSON.stringify(parsed)}`)
  })
})
