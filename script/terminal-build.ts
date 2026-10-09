import { fileURLToPath } from 'node:url'
import type { BunPlugin } from 'bun'

/** 把原生Client身份scope源码纳入客户端产物，发行启动不读取上游开发源码。 */
export function remoteScopePlugin(): BunPlugin {
  return { name: 'terminal-native-scope', setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\/dsh-api-session-controller\/src\/client\/scope\.ts$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: false }))
  } }
}

/** 浏览器安全的纯叶随客户端内联；它们没有独立客户端module factory，不能留给运行期require。 */
export function nativeClientLeafPlugin(): BunPlugin {
  return { name: 'native-client-leaves', setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\/dsh-util-workspace-path(?:\/.*)?$|^@deepseek-ai\/dsh-file-reference\/grammar$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: false }))
  } }
}
