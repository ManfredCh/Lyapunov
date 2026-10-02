/**
 * 环境变量读取：规范名（`LYAPUNOV_*`）权威，`LYAUP_*` 只作只读兼容输入。
 *
 * 从服务端 `services/lyapunov-api/src/config.ts` 提取。客户端只需要这一个纯函数，
 * 不需要随之拖入服务端配置加载器（数据库路径、监听地址、密钥校验等）。
 */
export function env(environment: NodeJS.ProcessEnv, canonical: string, legacy = canonical.replace(/^LYAPUNOV_/, "LYAUP_")) {
  return environment[canonical] ?? environment[legacy]
}
