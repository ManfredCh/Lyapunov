import type { Context, Fiber, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-config-editor'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isMap, parseDocument } from 'yaml'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-client-connection'
import Schema from '@deepseek-ai/schemastery'
import { defaultPreferences, LEGACY_PREFERENCES_NAMESPACE, PREFERENCES_NAMESPACE, shortcutActions, validateShortcuts, type Preferences } from './preferences.ts'
import { soundOptions } from './preferences-sounds.ts'
import { preferenceSoundAssets } from './preferences-sound-assets.ts'
import { legacyThemePresets } from './preferences-theme-data.ts'
import { applyPreferenceNotificationMarkers } from './preferences-notification-host.ts'

const preferenceFields = {
  agent: Schema.boolean().default(defaultPreferences.agent),
  permissions: Schema.boolean().default(defaultPreferences.permissions),
  errors: Schema.boolean().default(defaultPreferences.errors),
  agentSound: Schema.boolean().default(defaultPreferences.agentSound),
  permissionsSound: Schema.boolean().default(defaultPreferences.permissionsSound),
  errorsSound: Schema.boolean().default(defaultPreferences.errorsSound),
  agentSoundId: Schema.union([...soundOptions]).default(defaultPreferences.agentSoundId),
  permissionsSoundId: Schema.union([...soundOptions]).default(defaultPreferences.permissionsSoundId),
  errorsSoundId: Schema.union([...soundOptions]).default(defaultPreferences.errorsSoundId),
  backgroundOnly: Schema.boolean().default(defaultPreferences.backgroundOnly),
  themePalette: Schema.union(['native', ...legacyThemePresets.map(theme => theme.id)]).default('native'),
  notificationCounter: Schema.number().min(0).step(1).default(0),
  notificationMarkers: Schema.array(Schema.object({ seq: Schema.number().min(1).step(1).required(), sessionId: Schema.string().required(), kind: Schema.union(['completed', 'error']).required(), time: Schema.number().min(0).required() })).max(500).default([]),
  notificationReads: Schema.dict(Schema.number().min(0).step(1)).default({}),
  shortcuts: Schema.object(Object.fromEntries(shortcutActions.map(action => [action, Schema.string().default(defaultPreferences.shortcuts[action])]))).default(defaultPreferences.shortcuts),
}

export const PreferencesSchema = Schema.object(preferenceFields) as Schema<Preferences>

/** 原生 Loader 配置中的偏好字段；表单 namespace 仍是现有 entry id。 */
export type Config = { [K in keyof Preferences]: Volatile<Preferences[K]> }
export const Config = Schema.object({
  agent: preferenceFields.agent.volatile(),
  permissions: preferenceFields.permissions.volatile(),
  errors: preferenceFields.errors.volatile(),
  agentSound: preferenceFields.agentSound.volatile(),
  permissionsSound: preferenceFields.permissionsSound.volatile(),
  errorsSound: preferenceFields.errorsSound.volatile(),
  agentSoundId: preferenceFields.agentSoundId.volatile(),
  permissionsSoundId: preferenceFields.permissionsSoundId.volatile(),
  errorsSoundId: preferenceFields.errorsSoundId.volatile(),
  backgroundOnly: preferenceFields.backgroundOnly.volatile(),
  themePalette: preferenceFields.themePalette.volatile(),
  notificationCounter: preferenceFields.notificationCounter.volatile(),
  notificationMarkers: preferenceFields.notificationMarkers.volatile(),
  notificationReads: preferenceFields.notificationReads.volatile(),
  shortcuts: preferenceFields.shortcuts.volatile(),
})
export const name = 'lyapunov-preferences'
export const inject = ['settings', 'configEditor', 'profileContext']

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 旧文档字段仅补当前字段未出现的值，显式当前字段（包括 false/空值）优先。 */
function mergePreferences(legacy: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...legacy }
  for (const [key, value] of Object.entries(current)) {
    const prior = merged[key]
    merged[key] = record(prior) && record(value) ? mergePreferences(prior, value) : value
  }
  return merged
}

/** 已在 profile 用户层出现的字段保持该层权威；其余旧值交原生 import 处理。 */
function withoutOverrides(values: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const retained = { ...values }
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(retained, key)) continue
    const prior = retained[key]
    if (record(prior) && record(value)) {
      const child = withoutOverrides(prior, value)
      if (Object.keys(child).length) retained[key] = child
      else delete retained[key]
    } else delete retained[key]
  }
  return retained
}

/**
 * 在原生旧 settings.yaml import 前规范 legacy section；原节点保留供官方 rename 归档。
 * 只准备旧文档，实际偏好写入由 Settings 在 Loader settle 后执行。
 */
export async function prepareLegacyPreferenceSection(ctx: Context, namespace: string, legacyNamespace: string): Promise<void> {
  const path = join(ctx.profileContext.home, 'settings.yaml')
  await withFileLock(path, async () => {
    let text: string
    try { text = await readFile(path, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    const document = parseDocument(text)
    if (document.errors[0]) throw document.errors[0]
    if (!isMap(document.contents)) return
    const old = document.get(legacyNamespace, true)
    const current = document.get(namespace, true)
    if (old === undefined && current === undefined) return
    if (old !== undefined && !isMap(old)) throw new Error(`旧偏好 ${legacyNamespace} 必须是字段对象。`)
    if (current !== undefined && !isMap(current)) throw new Error(`当前偏好 ${namespace} 必须是字段对象。`)
    const legacy: unknown = old?.toJSON() ?? {}, canonical: unknown = current?.toJSON() ?? {}
    if (!record(legacy) || !record(canonical)) throw new Error('偏好文档必须包含字段对象。')
    const entry = ctx.configEditor.configuration().find(row => row.entry.options.id === namespace)
    if (!entry) throw new Error(`原生偏好 Config entry 未就绪：${namespace}`)
    const next = withoutOverrides(mergePreferences(legacy, canonical), entry.override)
    if (isDeepStrictEqual(next, canonical)) return
    document.set(namespace, next)
    await writeFileAtomic(path, document.toString(), { mode: 0o600, dirMode: 0o700 })
  })
}

/** 小配置入口只声明原生可热更新字段，不创建 Settings 注册或持久 store。 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  validateShortcuts(config.shortcuts.get())
  const owner = ctx.fiber
  ctx.on('internal/config', function (this: Fiber, _raw, next) {
    const raw: unknown = next()
    if (this === owner) validateShortcuts((Schema.resolve(raw, PreferencesSchema, {})[0] as Preferences).shortcuts)
    return raw
  })
  ctx.effect(() => ctx.settings.configure({ auto: false }, owner))
  await prepareLegacyPreferenceSection(ctx, PREFERENCES_NAMESPACE, LEGACY_PREFERENCES_NAMESPACE)
}

/** 保留声音路由和通知标记接线，字段归原生 Config 小入口。 */
export async function applyPreferencesHost(ctx: Context): Promise<void> {
  await ctx.inject(['settings'], owner => { applyPreferenceNotificationMarkers(owner) })
  ctx.inject(['connection'], owner => owner.effect(() => owner.connection.fetch.register({ path: '/api/lyapunov/preferences-sound', methods: ['GET'], requestBody: 'buffered', fetch: async request => preferenceSoundResponse(new URL(request.url).searchParams.get('id') ?? '') })))
}

/** 按既有素材ID读取固定本地AAC字节；不提供任意文件或URL读取。 */
export function preferenceSoundResponse(id: string): Response {
  if (!Object.hasOwn(preferenceSoundAssets, id)) return Response.json({ error: '找不到该提示音。' }, { status: 404 })
  const bytes = preferenceSoundAssets[id]
  return new Response(Buffer.from(bytes!, 'base64'), { headers: { 'content-type': 'audio/aac', 'cache-control': 'private, max-age=86400' } })
}
