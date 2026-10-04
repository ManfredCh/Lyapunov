import type { Context, Fiber, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-config-editor'
import Schema from '@deepseek-ai/schemastery'
import { LEGACY_WORKSPACE_PREFERENCES, WORKSPACE_PREFERENCES, workspaceDefaults, workspaceActions, validateWorkspaceShortcuts, type WorkspacePreferences } from './preferences.ts'
import { prepareLegacyPreferenceSection } from '../../lyapunov-shell/src/preferences-host.ts'

const workspacePreferenceFields = {
 autoSave: Schema.boolean().default(workspaceDefaults.autoSave),
 autoSaveDelayMs: Schema.number().min(250).max(10000).default(workspaceDefaults.autoSaveDelayMs),
 editorFontFamily: Schema.string().max(100).default(''), editorFontSize: Schema.number().min(10).max(28).default(14),
 terminalFontFamily: Schema.string().max(100).default(''), terminalFontSize: Schema.number().min(10).max(28).default(14),
 shortcuts: Schema.object(Object.fromEntries(workspaceActions.map(action => [action, Schema.string().default(workspaceDefaults.shortcuts[action])]))).default(workspaceDefaults.shortcuts),
}
export const WorkspacePreferencesSchema = Schema.object(workspacePreferenceFields) as Schema<WorkspacePreferences>
export type Config = { [K in keyof WorkspacePreferences]: Volatile<WorkspacePreferences[K]> }
export const Config = Schema.object({
 autoSave: workspacePreferenceFields.autoSave.volatile(),
 autoSaveDelayMs: workspacePreferenceFields.autoSaveDelayMs.volatile(),
 editorFontFamily: workspacePreferenceFields.editorFontFamily.volatile(),
 editorFontSize: workspacePreferenceFields.editorFontSize.volatile(),
 terminalFontFamily: workspacePreferenceFields.terminalFontFamily.volatile(),
 terminalFontSize: workspacePreferenceFields.terminalFontSize.volatile(),
 shortcuts: workspacePreferenceFields.shortcuts.volatile(),
})
export const name = 'lyapunov-workspace-preferences'
export const inject = ['settings', 'configEditor', 'profileContext']

function validate(value: WorkspacePreferences): void {
 validateWorkspaceShortcuts(value.shortcuts)
 for (const field of ['editorFontFamily', 'terminalFontFamily'] as const) {
  if (/[\r\n\0]/.test(value[field])) throw new Error('字体名称长度须不超过100且不能包含控制换行')
 }
}

/** 工作区偏好归一个原生 Config entry，保留完整字段验证与 revision 事务。 */
export async function apply(ctx: Context, config: Config): Promise<void> {
 const value = Object.fromEntries(Object.entries(config).map(([key, field]) => [key, field.get()]))
 validate(Schema.resolve(value, WorkspacePreferencesSchema, {})[0] as WorkspacePreferences)
 const owner = ctx.fiber
 ctx.on('internal/config', function (this: Fiber, _raw, next) {
  const raw: unknown = next()
  if (this === owner) validate(Schema.resolve(raw, WorkspacePreferencesSchema, {})[0] as WorkspacePreferences)
  return raw
 })
 ctx.effect(() => ctx.settings.configure({ auto: false }, owner))
 await prepareLegacyPreferenceSection(ctx, WORKSPACE_PREFERENCES, LEGACY_WORKSPACE_PREFERENCES)
}
