import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
/** 结果行前缀；bake.py 当前打印无前缀的单行 JSON，这里只在它出现时按真实长度截断（不得写死数字）。 */
const RESULT_PREFIX='LYAPUNOV_RESULT='

/**
 * 算法 worker（bake.py）的定位口径，唯一一处。
 *
 * 这个模块会被消费方**内联**进它自己的 bundle（scene-kit 就是：它动态 import 本包的
 * physicalize.ts，Bun.build 把整条链打进 scene-kit/dist/plugin.js）。内联之后 `import.meta.url`
 * 指向消费方的 dist，`./bake.py` 就落到那里去找——所以 worker 必须随消费方的产物一起存在，
 * 而不是靠谁手工放一份副本：
 *   · 本包自己的产物：构建脚本把 `src/*.py` 复制到本包 `dist/`（既有规则）；
 *   · 内联了本模块的消费方：构建脚本按产物内容把同一份 worker 复制到该消费方的 `dist/`
 *     （见 `script/build-plugins.ts`，日志里会打出来源与目标）。
 * 解析顺序：显式配置 → 与本模块同目录（源码直达或上面两条复制规则命中的产物都走这里）。
 * 相对 `import.meta.url` 解析，不写死任何绝对路径，产物整体搬目录后仍成立。
 */
export function resolveWorkerPath(explicit?: string): string {
  const bundled = fileURLToPath(new URL('./bake.py', import.meta.url))
  const candidates = [explicit, bundled].filter((value): value is string => Boolean(value))
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  throw new Error('PROVIDER_UNAVAILABLE: 找不到算法 worker bake.py（已尝试：' + candidates.join('、') + '）')
}

/**
 * `asset_bake` 的公开分流口径，唯一一处（前台与后台共用同一条 run，两个入口不各写分支）。
 *
 *   · 显式 `strategy`（含 `auto`）→ 高层 `physicalize`：逐节点判定/改派、写完整回执；
 *   · 只给 `usage:'environment'`、没给 `strategy`/`method` → **同一条高层默认路线**：补 `strategy:'auto'` 后原样进
 *     physicalize，与调用方显式写 `strategy:'auto'` 完全同一路。调用方声明了环境用途就是要求保空腔的表示，
 *     不能让这条正常默认请求落到低层基础几何导出——低层导出不逐节点改派，水密凹实体会被引擎按凸包补实，
 *     门洞/房间在消费后消失，而回执里一个字都不会提；
 *   · 显式 `method`（没给 `strategy`）→ 低层基础几何导出，按该 method 原样（不补策略、不逐节点改派）；
 *   · `method` 与 `strategy` 同时给 → `strategy` 优先（physicalize 按策略决定基础 method），与既有行为一致；
 *   · 其余（没有用途、也没有 strategy/method）→ 低层基础几何导出的既有默认。
 */
export function resolveBakeRoute(request: { strategy?: unknown; method?: unknown; usage?: unknown; [field: string]: unknown }): { physicalize: boolean; injectStrategy?: 'auto' } {
  if (request.strategy) return { physicalize: true }
  if (request.usage === 'environment' && request.method === undefined) return { physicalize: true, injectStrategy: 'auto' }
  return { physicalize: false }
}

export async function runProvider(request: Record<string, unknown>, options: { python?: string; workerPath?: string; signal?: AbortSignal;onProgress?:(message:{mode:string;node?:string;facts:Record<string,unknown>})=>void } = {}): Promise<any> {
  options.signal?.throwIfAborted()
  const python = options.python ?? process.env.LYAPUNOV_ALGORITHM_PYTHON
  if (!python) throw new Error('PROVIDER_UNAVAILABLE: 设置 LYAPUNOV_ALGORITHM_PYTHON 为隔离算法解释器')
  const child = spawn(python, [resolveWorkerPath(options.workerPath)], {stdio:['pipe','pipe','pipe'], signal:options.signal, env:{...process.env,HF_ENDPOINT:'https://hf-mirror.com'}})
  // 只接收有界结果清单；进度与原生算法日志仅留尾部，不随节点总数增长。
  const maxResultBytes=8*1024*1024,maxDiagnosticBytes=64*1024
  const decoder=new StringDecoder('utf8')
  const diagnosticsDecoder=new StringDecoder('utf8');let progressLine=''
  let out='',diagnosticTail=Buffer.alloc(0),outBytes=0,outputFailure:Error|undefined
  child.stdout.on('data',v=>{
    outBytes+=v.length
    if(outBytes>maxResultBytes){outputFailure??=new Error('GEOMETRY_RESULT_BUDGET_EXCEEDED: worker 结果超过 8 MiB 小清单预算');child.kill('SIGKILL');return}
    out+=decoder.write(v)
  })
  child.stderr.on('data',v=>{
    diagnosticTail=Buffer.concat([diagnosticTail,v]).subarray(-maxDiagnosticBytes)
    progressLine=(progressLine+diagnosticsDecoder.write(v)).slice(-maxDiagnosticBytes)
    for(;;){const newline=progressLine.indexOf('\n');if(newline<0)break;const line=progressLine.slice(0,newline);progressLine=progressLine.slice(newline+1)
      if(line.startsWith('LYAPUNOV_PROGRESS='))try{const facts=JSON.parse(line.slice('LYAPUNOV_PROGRESS='.length));options.onProgress?.({mode:facts.stage==='geometry-node'?'measure':'voxel',node:facts.node??'point-cloud',facts})}catch{}
    }
  })
  child.stdin.on('error',()=>{}) // 取消/输出预算中止后管道关闭；真实失败由 close/error 统一回收。
  child.stdin.end(JSON.stringify(request))
  let spawnError:Error|undefined;let killTimer:ReturnType<typeof setTimeout>|undefined
  const abort=()=>{killTimer=setTimeout(()=>child.kill('SIGKILL'),2000)};options.signal?.addEventListener('abort',abort,{once:true})
  const code = await new Promise<number|null>(resolve=>{child.once('error',error=>{spawnError=error});child.once('close',resolve)})
  if(killTimer)clearTimeout(killTimer);options.signal?.removeEventListener('abort',abort)
  if(spawnError)throw spawnError
  if(outputFailure)throw outputFailure
  out+=decoder.end();const err=diagnosticTail.toString('utf8')
  const lines=out.trim().split('\n'),prefixed=lines.slice().reverse().find(v=>v.startsWith(RESULT_PREFIX))
  const line=(prefixed?prefixed.slice(RESULT_PREFIX.length):lines.at(-1))!
  if (code !== 0) {
    // 几何依赖故障保留自己的阶段，不混成 Kit/PhysX 失败或请求内容错误。
    let failure:{error?:unknown;message?:unknown;details?:{stage?:unknown}}|undefined
    try{failure=JSON.parse(line)}catch{}
    if(failure?.error==='ASSET_BAKE_DEPENDENCY_UNAVAILABLE'&&typeof failure.message==='string'){
      const stage=typeof failure.details?.stage==='string'?failure.details.stage:'geometry-dependencies'
      throw new Error(`ASSET_BAKE_DEPENDENCY_UNAVAILABLE: ${failure.message}（阶段：${stage}）`,{cause:failure.details})
    }
    const failureError=new Error(`${code===2?'PROVIDER_UNAVAILABLE':'PROVIDER_FAILED'}: ${line || err}`,{cause:failure?.details})
    throw Object.assign(failureError,{code:failure?.error,details:failure?.details})
  }
  // 多行日志里最后一行不是结果就是失败：不把解析不了的输出当成功吞掉。
  try { return JSON.parse(line) } catch { throw new Error(`PROVIDER_FAILED: bake.py 结果不是合法 JSON（stdout 尾部：${out.slice(-500)}）`) }
}
