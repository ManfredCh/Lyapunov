/** 实际 Newton World + 受控故障注入；缺运行时只跳过，不假装物理测试通过。 */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {existsSync,mkdtempSync,realpathSync,rmSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'

const root=resolve(import.meta.dirname,'../../..'),python=process.env.LYAPUNOV_NEWTON_PYTHON||join(root,'.runtime/newton-env/bin/python')
const worker=process.env.LYAPUNOV_NEWTON_WORKER_PATH||join(root,'packages/sim-newton/python/worker.py')
test('真实 World 故障终结活动动作后可确认停止并关闭，错误身份仍拒绝',{skip:existsSync(python)?false:`缺少 Newton Python：${python}`,timeout:120_000},()=>{
 const cache=mkdtempSync(join(realpathSync(tmpdir()),'newton-fault-cleanup-'))
 try{
  const run=spawnSync(python,['-B',join(root,'packages/sim-newton/test/fault_cleanup_fixture.py'),worker,join(root,'packages/sim-mujoco/fixtures/arm.xml')],{encoding:'utf8',timeout:110_000,env:{...process.env,CUDA_VISIBLE_DEVICES:'',NVIDIA_VISIBLE_DEVICES:'',LYAPUNOV_NEWTON_DEVICE:'cpu',LYAPUNOV_NEWTON_CACHE_ROOT:cache,HF_ENDPOINT:'https://hf-mirror.com'}})
  assert.equal(run.status,0,run.stderr);const result=JSON.parse(run.stdout.trim());assert.equal(result.status,'PASS');assert.equal(result.failedAction.status,'failed');assert.equal(result.stop.reason,'WORLD_ALREADY_UNAVAILABLE')
 }finally{rmSync(cache,{recursive:true,force:true})}
})
