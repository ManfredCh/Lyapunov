/** 使用真实 Newton CPU 与项目固定 MuJoCo 解析器检查初始状态，不自动下载依赖。 */
import {describe,expect,test} from 'bun:test'
import {spawnSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
const here=dirname(fileURLToPath(import.meta.url))
const root=join(here,'../../..')
const python=process.env.LYAPUNOV_NEWTON_PYTHON??join(root,'.runtime/newton-env/bin/python')
describe.skipIf(!existsSync(python))('Newton 原生源初始状态',()=>{
 test('关键帧、覆盖值、同步、多实体与自由根',()=>{
  const result=spawnSync(python,['-B',join(here,'initial_state_fixture.py'),join(here,'../python/worker.py')],{encoding:'utf8',timeout:120_000,env:{...process.env,CUDA_VISIBLE_DEVICES:'',NVIDIA_VISIBLE_DEVICES:''}})
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  if(result.status!==0)throw new Error(`Newton 初始状态真实测试失败：\n${result.stdout}\n${result.stderr}`)
  expect(result.stderr).toContain('Ran 9 tests')
  expect(result.stderr).toContain('OK')
 },130_000)
})
