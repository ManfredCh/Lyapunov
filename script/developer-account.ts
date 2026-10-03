import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { createDeveloperCredential, developerCredentialFingerprint, readDeveloperCredential, verifyDeveloperCredential } from '../packages/lyapunov-product-bundle/src/account/developer.ts'

export function defaultDeveloperAccountFile(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.LYAPUNOV_DEVELOPER_ACCOUNT_FILE?.trim()
  return resolve((configured || '~/.config/lyapunov/developer-account.json').replace(/^~(?=\/|$)/, homedir()))
}

async function password(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') return (await readFile('/dev/stdin', 'utf8')).trimEnd()
  return await new Promise((resolvePassword, reject) => {
    const input = createInterface({ input: process.stdin, output: process.stdout })
    process.stdout.write(prompt)
    process.stdin.setRawMode!(true)
    let value = ''
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') { process.stdin.setRawMode!(false); input.close(); reject(new Error('已取消')); return }
        if (char === '\r' || char === '\n') { process.stdin.setRawMode!(false); input.close(); process.stdout.write('\n'); resolvePassword(value); return }
        if (char === '\u007f') value = value.slice(0, -1)
        else if (char >= ' ') value += char
      }
    }
    process.stdin.on('data', onData)
    input.once('close', () => process.stdin.removeListener('data', onData))
  })
}

export async function initializeDeveloperAccount(path: string, username: string, inputPassword?: string): Promise<void> {
  const value = createDeveloperCredential(username, inputPassword ?? await password('开发者密码（输入不回显）：'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await chmod(path, 0o600)
  console.log(`开发者账号已初始化：${value.username}（指纹 ${developerCredentialFingerprint(value)}）`)
}

export async function authenticateDeveloperAccount(path: string, usernameInput?: string): Promise<void> {
  const record = await readDeveloperCredential(path)
  const username = usernameInput?.trim() || record.username
  const supplied = await password('开发者密码（输入不回显）：')
  if (!verifyDeveloperCredential(record, username, supplied)) throw new Error('开发者账号或密码错误')
  console.log(`开发者账号已验证：${record.username}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { file: { type: 'string' }, username: { type: 'string' }, help: { type: 'boolean', short: 'h' } } })
  const file = resolve((values.file || defaultDeveloperAccountFile()).replace(/^~(?=\/|$)/, homedir()))
  if (values.help || positionals[0] === undefined) {
    console.log('用法：node script/developer-account.ts init --username <用户名> [--file <包外账号文件>]')
    console.log('      node script/developer-account.ts verify [--username <用户名>] [--file <包外账号文件>]')
    process.exit(values.help ? 0 : 2)
  }
  if (positionals[0] === 'init') await initializeDeveloperAccount(file, values.username ?? '')
  else if (positionals[0] === 'verify') await authenticateDeveloperAccount(file, values.username)
  else throw new Error(`未知操作：${positionals[0]}`)
}
