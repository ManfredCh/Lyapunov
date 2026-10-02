/**
 * MuJoCo 的 MUJOCO_GL 后端默认值必须按平台选择。
 *
 * MuJoCo 官方支持的取值：Linux 用 egl/osmesa/glfw，macOS 用 cgl/glfw，
 * Windows 用 wgl/glfw。把 Linux 的 egl 硬编码成唯一默认值，会让 macOS 上的
 * worker 在 import mujoco 阶段直接报“不支持的 MUJOCO_GL”，而用户即使显式
 * 设置 MUJOCO_GL=cgl 也会被覆盖。
 *
 * 解析顺序（与 SDK 解释器覆盖同一约定）：
 *   1. 调用方显式传入的后端（例如 LYAPUNOV_MUJOCO_RENDER_BACKEND 展开的配置）；
 *   2. 已继承的 MUJOCO_GL；
 *   3. 当前平台的安全默认值。
 * 本 helper 不做安装、不探测 GPU、不改变任何源的物理语义。
 */
export type MuJoCoGlBackend = 'egl' | 'osmesa' | 'glfw' | 'cgl' | 'wgl'

/** MuJoCo 文档化的后端全集；只用于校验显式配置，不表示每个平台都支持。 */
export const MUJOCO_GL_BACKENDS: readonly MuJoCoGlBackend[] = ['egl', 'osmesa', 'glfw', 'cgl', 'wgl']

export function isMuJoCoGlBackend(value: string): value is MuJoCoGlBackend {
  return (MUJOCO_GL_BACKENDS as readonly string[]).includes(value)
}

export function resolveMuJoCoGlBackend(
  explicit?: string,
  platform: NodeJS.Platform = process.platform,
  inherited: string | undefined = process.env.MUJOCO_GL,
): string {
  const configured = explicit?.trim() || inherited?.trim()
  if (configured) return configured
  if (platform === 'darwin') return 'cgl'
  if (platform === 'win32') return 'wgl'
  return 'egl'
}
