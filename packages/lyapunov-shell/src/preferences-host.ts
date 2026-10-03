import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-client-connection'
import Schema from '@deepseek-ai/schemastery'
import { defaultPreferences, LEGACY_PREFERENCES_NAMESPACE, PREFERENCES_NAMESPACE, shortcutActions, validateShortcuts, type Preferences } from './preferences.ts'
import { soundOptions } from './preferences-sounds.ts'
import { preferenceSoundAssets } from './preferences-sound-assets.ts'
import { legacyThemePresets } from './preferences-theme-data.ts'
import { applyPreferenceNotificationMarkers } from './preferences-notification-host.ts'

export const PreferencesSchema: Schema<Preferences> = Schema.object({
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
}) as Schema<Preferences>

/** 复用原生设置文档和并发 revision，不创建另一份持久存储。 */
export async function applyPreferencesHost(ctx: Context) {
  await ctx.inject(['settings'], async owner => {
    owner.settings.register(PREFERENCES_NAMESPACE, PreferencesSchema, { validate: value => { validateShortcuts(value.shortcuts) } })
    const existing = owner.settings.describe().find(item => item.ns === PREFERENCES_NAMESPACE)!
    if (existing.user === undefined) {
      // 原生设置只允许读取已注册段；临时读取旧段后卸载，不留下第二个写入口。
      let legacy: object | undefined
      const reader = owner.plugin({ name: 'lyapunov-preferences-migration', apply(reader: Context) {
        let reading = true
        reader.settings.register(LEGACY_PREFERENCES_NAMESPACE, PreferencesSchema, { validate: () => {
          if (!reading) throw new Error('旧偏好仅可读取迁移，请保存到当前偏好。')
        } })
        reading = false
        legacy = reader.settings.describe().find(item => item.ns === LEGACY_PREFERENCES_NAMESPACE)?.user as object | undefined
      } })
      try { await reader } finally { await reader.dispose() }
      if (legacy !== undefined) await owner.settings.replace(PREFERENCES_NAMESPACE, legacy, existing.revision)
    }
    applyPreferenceNotificationMarkers(owner)
  })
  ctx.inject(['connection'], owner => owner.effect(() => owner.connection.fetch.register({ path: '/api/lyapunov/preferences-sound', methods: ['GET'], requestBody: 'buffered', fetch: async request => preferenceSoundResponse(new URL(request.url).searchParams.get('id') ?? '') })))
}

/** 按既有素材ID读取固定本地AAC字节；不提供任意文件或URL读取。 */
export function preferenceSoundResponse(id: string): Response {
  if (!Object.hasOwn(preferenceSoundAssets, id)) return Response.json({ error: '找不到该提示音。' }, { status: 404 })
  const bytes = preferenceSoundAssets[id]
  return new Response(Buffer.from(bytes!, 'base64'), { headers: { 'content-type': 'audio/aac', 'cache-control': 'private, max-age=86400' } })
}
