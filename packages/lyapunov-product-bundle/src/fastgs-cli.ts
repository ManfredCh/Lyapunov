/**
 * `./lyapunov fastgs download|install|doctor|train` 的命令行入口。
 *
 * 只做参数解析与转发；下载/安装/检查/训练的全部判据都在 `fastgs-external.ts`（同一份实现也给
 * 设置界面的宿主路由使用）。stdout 只出 JSON 回执，过程日志走 stderr，便于脚本消费。
 * 退出码按真实结果：download/install/train 回执不是 `OK`（BLOCKED/FAILED）即非 0，绝不假成功。
 */
import {parseArgs} from 'node:util'
import {
  FASTGS_COMMIT, FASTGS_REPOSITORY,
  fastgsDownload, fastgsHome, fastgsInstall, fastgsProductRoot, fastgsStatus, fastgsTrain,
} from './fastgs-external.ts'

const USAGE = `FastGS 外部工具（官方 ${FASTGS_REPOSITORY} @ ${FASTGS_COMMIT}，按需下载，不随包分发）
  ./lyapunov fastgs download                          下载并检出官方源码到本地运行目录
  ./lyapunov fastgs install                           按官方 environment.yml 建隔离环境（或用 LYAPUNOV_FASTGS_PYTHON 复用）
  ./lyapunov fastgs doctor                            读取真实依赖状态（JSON）
  ./lyapunov fastgs train -s <dataset> -m <output>    显式转发官方 train.py（下载后不会自动训练）
环境变量：
  LYAPUNOV_FASTGS_HOME    本地工具根（默认 <产品根>/.runtime/fastgs-external）
  LYAPUNOV_FASTGS_PYTHON  显式复用已有解释器（install 只校验、不修改它）
  LYAPUNOV_MICROMAMBA     micromamba 可执行文件
  LYAPUNOV_FASTGS_DATA_DIR 权重/数据目录（只报告，不自动下载）
本地运行目录默认在产品根内的 .runtime 下、不随发行包分发；LYAPUNOV_FASTGS_HOME 可指向其它目录。
`

/** 过程日志走 stderr，stdout 只留 JSON 回执。 */
const log = (line: string) => process.stderr.write(line)

export async function runFastGSCli(argv: string[]): Promise<void> {
  const command = (argv[0] ?? 'help').trim()
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE)
    return
  }
  if (!['download', 'install', 'doctor', 'train'].includes(command)) {
    throw new Error(`FASTGS_COMMAND_UNSUPPORTED: ${command}（可用 download|install|doctor|train）`)
  }
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  const hooks = {log, signal: controller.signal}
  try {
    // CLI 与设置界面同源：wrapper 已设 LYAPUNOV_PRODUCT_ROOT；否则从本模块位置回推，绝不按调用时的 cwd。
    const productRoot = fastgsProductRoot()
    if (command === 'doctor') {
      const status = await fastgsStatus({productRoot}, hooks)
      process.stdout.write(JSON.stringify({...status, home: fastgsHome({productRoot})}, null, 2) + '\n')
      return
    }
    if (command === 'download') {
      const receipt = await fastgsDownload({productRoot}, hooks)
      process.stdout.write(JSON.stringify(receipt, null, 2) + '\n')
      if (receipt.status !== 'OK') process.exitCode = 1
      return
    }
    if (command === 'install') {
      const receipt = await fastgsInstall({productRoot}, hooks)
      process.stdout.write(JSON.stringify(receipt, null, 2) + '\n')
      if (receipt.status !== 'OK') process.exitCode = 1
      return
    }
    const {values} = parseArgs({args: argv.slice(1), options: {
      source: {type: 'string', short: 's'},
      model: {type: 'string', short: 'm'},
    }})
    const receipt = await fastgsTrain({productRoot}, {dataset: values.source, output: values.model}, hooks)
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n')
    if (receipt.status !== 'OK') process.exitCode = 1
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  }

}
