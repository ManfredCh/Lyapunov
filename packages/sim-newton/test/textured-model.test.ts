/** 真实默认纹理模型与 Newton CPU；缺外部发行供给时明确跳过。 */
import {describe,expect,test} from 'bun:test'
import {spawnSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
const here=dirname(fileURLToPath(import.meta.url)),root=join(here,'../../..')
const python=process.env.LYAPUNOV_NEWTON_PYTHON??join(root,'.runtime/newton-env/bin/python')
const supply=process.env.LYAPUNOV_ROBOT_STAGING_ROOT??join(root,'.runtime/linux-0.2.1-supply')
const available=existsSync(python)&&['unitree_a1/asset/a1.xml','unitree_go2/asset/go2.xml'].every(path=>existsSync(join(supply,'packs',path)))
describe.skipIf(!available)('Newton 默认纹理模型 CPU',()=>{
 test('A1 和 Go2 实际导入并步进',()=>{
  const result=spawnSync(python,['-B',join(here,'textured_model_fixture.py'),join(here,'../python/worker.py'),supply],{encoding:'utf8',timeout:120_000,env:{...process.env,CUDA_VISIBLE_DEVICES:'',NVIDIA_VISIBLE_DEVICES:''}})
  expect(result.error).toBeUndefined();expect(result.signal).toBeNull()
  if(result.status!==0)throw new Error(`Newton 纹理模型真实测试失败：\n${result.stdout}\n${result.stderr}`)
  expect(result.stderr).toContain('Ran 1 test');expect(result.stderr).toContain('OK')
 },130_000)
})
