/** 产品 producer 与相邻迁移已转换的历史来源；自动 notice 不授予人工权限。 */
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

type NoticeSource<K extends string> = { readonly kind: K } & ContextFormed

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'lyapunov-blender': NoticeSource<'lyapunov-blender'>
    'plugin:lyapunov-blender': NoticeSource<'plugin:lyapunov-blender'>
    'lyapunov-depth-estimation': NoticeSource<'lyapunov-depth-estimation'>
    'plugin:lyapunov-depth-estimation': NoticeSource<'plugin:lyapunov-depth-estimation'>
    'lyapunov-generate-image': NoticeSource<'lyapunov-generate-image'>
    'plugin:lyapunov-generate-image': NoticeSource<'plugin:lyapunov-generate-image'>
    'lyapunov-engine-install': NoticeSource<'lyapunov-engine-install'>
    'plugin:lyapunov-engine-install': NoticeSource<'plugin:lyapunov-engine-install'>
    'lyapunov-orientation': NoticeSource<'lyapunov-orientation'>
    'plugin:lyapunov-orientation': NoticeSource<'plugin:lyapunov-orientation'>
    'lyapunov-annotation': { readonly kind: 'lyapunov-annotation' }
    'lyapunov-domain-pointer': { readonly kind: 'lyapunov-domain-pointer'; readonly form?: 'snapshot' }
  }
}

export type { NoticeSource }
