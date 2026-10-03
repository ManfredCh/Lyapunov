import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
export async function runProvider(request: Record<string, unknown>, options: { python?: string; signal?: AbortSignal } = {}): Promise<any> {
  const python = options.python ?? process.env.LYAPUNOV_ALGORITHM_PYTHON
  if (!python) throw new Error('PROVIDER_UNAVAILABLE: 设置 LYAPUNOV_ALGORITHM_PYTHON 为隔离算法解释器')
  const child = spawn(python, [fileURLToPath(new URL('./propose.py', import.meta.url))], {stdio:['pipe','pipe','pipe'], signal:options.signal, env:{...process.env,HF_ENDPOINT:'https://hf-mirror.com'}})
  let out='', err=''; child.stdout.on('data',v=>{out+=v}); child.stderr.on('data',v=>{err+=v}); child.stdin.end(JSON.stringify(request))
  let spawnError:Error|undefined;let killTimer:ReturnType<typeof setTimeout>|undefined
  const abort=()=>{killTimer=setTimeout(()=>child.kill('SIGKILL'),2000)};options.signal?.addEventListener('abort',abort,{once:true})
  const code = await new Promise<number|null>(resolve=>{child.once('error',error=>{spawnError=error});child.once('close',resolve)})
  if(killTimer)clearTimeout(killTimer);options.signal?.removeEventListener('abort',abort)
  if(spawnError)throw spawnError
  const lines=out.trim().split('\n'); const line=lines.slice().reverse().find(v=>v.startsWith('LYAPUNOV_RESULT='))?.slice(13) ?? lines.at(-1)!
  if (code !== 0) throw new Error(`${code===2?'PROVIDER_UNAVAILABLE':'PROVIDER_FAILED'}: ${line || err}`)
  return JSON.parse(line)
}
