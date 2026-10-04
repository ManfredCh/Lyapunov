import {describe,expect,test,afterEach} from 'bun:test'
import type {Context} from '@deepseek-ai/cordis'
import {startExternalInstallSession} from '../src/external-install-session.ts'

function fixture(ok=true){
 const calls:Array<{kind:string;value:unknown}>=[]
 const sessions={list:{getSnapshot:()=>({byId:{existing:{id:'existing',cwd:'/task',retainedBy:{mainView:1}}}})},
  create:async(opts:unknown)=>{calls.push({kind:'create',value:opts});return 'fresh-install'},
  binding:(id:string)=>({session:{prompt:async(content:unknown,mode:unknown)=>{
    calls.push({kind:'prompt',value:{id,content,mode}})
    return ok?{ok:true}:{ok:false,error:{message:'模型未连接'}}
  }}})}

 const workspaces={list:{getSnapshot:()=>({items:[{workspaceId:'workspace',sessionIds:['existing']}]})}}
 const ctx={get:(name:string)=>name==='sessions'?sessions:name==='workspaces'?workspaces:undefined,uiWorkspace:{openSession:(id:string)=>{calls.push({kind:'open',value:id});calls.push({kind:'panel',value:null})}}} as unknown as Context
 return {ctx,calls,close:()=>calls.push({kind:'close',value:true})}
}
describe('外部工具从设置进入新会话',()=>{
 test('创建新会话后只向新绑定发送Blender自然语言请求，不复用已有任务',async()=>{
  const f=fixture();expect(await startExternalInstallSession(f.ctx,'blender',f.close)).toBe('fresh-install')
  expect(f.calls.map(row=>row.kind)).toEqual(['create','open','panel','prompt','close'])
  expect(f.calls[0]!.value).toEqual({workspaceId:'workspace'})
  expect(f.calls[3]!.value).toMatchObject({id:'fresh-install',mode:'queue',content:[{type:'text',text:expect.stringContaining('请帮我下载并安装 Blender')}]})
 })
 test('Unity MCP使用配置与连接检查请求，不将已配置当作已安装',async()=>{
  const f=fixture();await startExternalInstallSession(f.ctx,'unity-mcp',f.close)
  expect(JSON.stringify(f.calls[3]!.value)).toContain('不能据此声称已经安装或启动编辑器')
 })
 test('提交失败保留设置错误处理机会，不报告完成',async()=>{
  const f=fixture(false);await expect(startExternalInstallSession(f.ctx,'blender',f.close)).rejects.toThrow('模型未连接')
  expect(f.calls.some(row=>row.kind==='close')).toBe(false)
 })
 test('未知工具不会创建会话或提交任何请求',async()=>{
  const f=fixture();await expect(startExternalInstallSession(f.ctx,'unknown-tool',f.close)).rejects.toThrow('未找到')
  expect(f.calls).toEqual([])
 })
})


// 本轮配置迁移走实际 RC2 built Cordis/Loader/Profile/ConfigEditor，不注册 Settings 替身。
import { Context as NativeContext } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import { initProfile, mountRootInclude, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as ShellPreferences from '../src/preferences-host.ts'
import * as WorkspacePreferences from '../../lyapunov-workspace/src/preferences-host.ts'
import { defaultPreferences, PREFERENCES_NAMESPACE } from '../src/preferences.ts'
import { workspaceDefaults, WORKSPACE_PREFERENCES } from '../../lyapunov-workspace/src/preferences.ts'

const ownedContexts: NativeContext[] = [], ownedHomes: string[] = []
afterEach(async () => {
 for (const ctx of ownedContexts.splice(0)) await ctx.fiber.dispose()
 for (const home of ownedHomes.splice(0)) await rm(home, { recursive: true, force: true })
})

async function preferencesFixture(input: { legacy?: string; overrides?: object[]; built?: boolean } = {}) {
 const home = await mkdtemp(join(tmpdir(), 'lyapunov-rc2-config-'))
 ownedHomes.push(home)
 const dir = join(home, 'profile'), bundle = join(dir, 'node_modules', 'test-preferences-bundle')
 initProfile(dir, ['test-preferences-bundle'])
 await mkdir(bundle, { recursive: true })
 await writeFile(join(home, 'package.json'), '{"name":"test-preferences-installation"}\n')
 await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-preferences-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
 await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
  { id: 'config-editor', name: 'cordis:test-editor' },
  { id: 'settings', name: 'cordis:test-settings' },
  { id: PREFERENCES_NAMESPACE, name: input.built ? pathToFileURL(Bun.resolveSync('@lyapunov/shell/preferences', resolve(import.meta.dirname, '../../..'))).href : 'cordis:test-shell-preferences' },
  { id: WORKSPACE_PREFERENCES, name: input.built ? pathToFileURL(Bun.resolveSync('@lyapunov/workspace/preferences', resolve(import.meta.dirname, '../../..'))).href : 'cordis:test-workspace-preferences' },
 ] }]))
 await writeFile(join(dir, 'cordis.yml'), '[]\n')
 await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify(input.overrides ?? []))
 if (input.legacy !== undefined) await writeFile(join(home, 'settings.yaml'), input.legacy)
 const profile: ProfileContext = { name: 'test-preferences', startedBundles: ['test-preferences-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
 const start = async () => {
  const ctx = new NativeContext()
  ownedContexts.push(ctx)
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  const errors: string[] = []
  ctx.logger.exporter({ export: message => { if (message.type === 'error') errors.push(message.args.map(String).join(' ')) } })
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, 'test-editor': ConfigEditor, 'test-settings': Settings, 'test-shell-preferences': ShellPreferences, 'test-workspace-preferences': WorkspacePreferences })
  ctx.provide('profileContext', profile)
  await mountRootInclude(ctx, join(dir, 'cordis.yml'), readProfilePatches('dsh', profile))
  await ctx.loader.await()
  if (input.built && errors.length) throw new Error(errors.join('\n'))
  for (const entry of ctx.configEditor.entries()) await entry.fiber?.await()
  return ctx
 }
 const view = (ctx: NativeContext, namespace: string) => {
  const row = ctx.settings.describe().find(row => row.ns === namespace)
  if (!row) throw Error(`原生 Config 表单不存在：${namespace}`)
  return row
 }
 return { ctx: await start(), start, home, profile, view }
}

describe('RC2 原生偏好 Config/profile 事务', () => {
 test('产品两个真实built exports通过Loader生成可写原生表单并重开', async () => {
  const h = await preferencesFixture({ built: true })
  const shell = h.view(h.ctx, PREFERENCES_NAMESPACE)
  await h.ctx.settings.update(PREFERENCES_NAMESPACE, { backgroundOnly: false }, shell.revision)
  const workspace = h.view(h.ctx, WORKSPACE_PREFERENCES)
  await h.ctx.settings.update(WORKSPACE_PREFERENCES, { terminalFontFamily: 'built font', terminalFontSize: 18 }, workspace.revision)
  await h.ctx.fiber.dispose()
  const reopened = await h.start()
  expect(h.view(reopened, PREFERENCES_NAMESPACE).value).toMatchObject({ backgroundOnly: false })
  expect(h.view(reopened, WORKSPACE_PREFERENCES).value).toMatchObject({ terminalFontFamily: 'built font', terminalFontSize: 18 })
  expect(h.view(reopened, PREFERENCES_NAMESPACE).autoGenerate).toBe(false)
  expect(h.view(reopened, WORKSPACE_PREFERENCES).autoGenerate).toBe(false)
 })
 test('投影原字段与默认值，热写入保留 fibre，重开读回字体/声音/主题/快捷键', async () => {
  const h = await preferencesFixture()
  expect(h.view(h.ctx, PREFERENCES_NAMESPACE).value).toEqual(defaultPreferences)
  expect(h.view(h.ctx, WORKSPACE_PREFERENCES).value).toEqual(workspaceDefaults)
  const shellEntry = h.ctx.configEditor.entries().find(row => row.options.id === PREFERENCES_NAMESPACE)!
  const before = shellEntry.fiber
  const shell = h.view(h.ctx, PREFERENCES_NAMESPACE)
  await h.ctx.settings.update(PREFERENCES_NAMESPACE, { agentSound: false, agentSoundId: 'nope-03', themePalette: 'native', shortcuts: { newSession: 'ctrl+alt+n' } }, shell.revision)
  const workspace = h.view(h.ctx, WORKSPACE_PREFERENCES)
  await h.ctx.settings.update(WORKSPACE_PREFERENCES, { autoSave: false, editorFontFamily: 'Noto Sans Mono CJK SC', editorFontSize: 19, terminalFontFamily: 'DejaVu Sans Mono', autoSaveDelayMs: 920 }, workspace.revision)
  expect(shellEntry.fiber).toBe(before)
  expect(h.view(h.ctx, WORKSPACE_PREFERENCES).value).toMatchObject({ autoSave: false, editorFontFamily: 'Noto Sans Mono CJK SC', editorFontSize: 19, autoSaveDelayMs: 920 })
  await h.ctx.fiber.dispose()
  const reopened = await h.start()
  expect(h.view(reopened, PREFERENCES_NAMESPACE).value).toMatchObject({ agentSound: false, agentSoundId: 'nope-03', shortcuts: { newSession: 'ctrl+alt+n' } })
  expect(h.view(reopened, WORKSPACE_PREFERENCES).value).toMatchObject({ autoSave: false, editorFontFamily: 'Noto Sans Mono CJK SC', editorFontSize: 19, terminalFontFamily: 'DejaVu Sans Mono', autoSaveDelayMs: 920 })
 })
 test('旧 lyaup 值按官方 import/rename迁移；canonical与显式profile字段优先', async () => {
  const h = await preferencesFixture({ legacy: 'lyaup-preferences:\n  agentSound: false\n  agentSoundId: nope-03\n  backgroundOnly: false\nlyapunov-preferences:\n  agentSound: true\nlyaup-workspace:\n  autoSave: false\n  editorFontFamily: 旧中文字体\n  editorFontSize: 21\nlyapunov-workspace:\n  editorFontSize: 17\n', overrides: [
   { id: PREFERENCES_NAMESPACE, name: 'cordis:test-shell-preferences', config: { agentSound: false } },
   { id: WORKSPACE_PREFERENCES, name: 'cordis:test-workspace-preferences', config: { editorFontSize: 23, terminalFontFamily: '新终端字体' } },
  ] })
  for (let attempt = 0; attempt < 200 && ((h.view(h.ctx, PREFERENCES_NAMESPACE).value as typeof defaultPreferences).agentSoundId !== 'nope-03' || (h.view(h.ctx, WORKSPACE_PREFERENCES).value as typeof workspaceDefaults).editorFontFamily !== '旧中文字体'); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(h.view(h.ctx, PREFERENCES_NAMESPACE).value).toMatchObject({ agentSound: false, agentSoundId: 'nope-03', backgroundOnly: false })
  expect(h.view(h.ctx, WORKSPACE_PREFERENCES).value).toMatchObject({ autoSave: false, editorFontFamily: '旧中文字体', editorFontSize: 23, terminalFontFamily: '新终端字体' })
  const archived = await readFile(join(h.home, 'settings.yaml.imported'), 'utf8')
  expect(archived).toContain('lyaup-preferences:')
  expect(archived).toContain('lyaup-workspace:')
  await expect(readFile(join(h.home, 'settings.yaml'), 'utf8')).rejects.toThrow()
  await h.ctx.fiber.dispose()
  const reopened = await h.start()
  expect(h.view(reopened, WORKSPACE_PREFERENCES).value).toMatchObject({ editorFontFamily: '旧中文字体', editorFontSize: 23 })
 })
 test('仅canonical旧文档也不覆盖较新的显式profile用户字段', async () => {
  const h = await preferencesFixture({ legacy: 'lyapunov-preferences:\n  agentSound: true\n  errors: true\nlyapunov-workspace:\n  autoSave: false\n  editorFontSize: 17\n', overrides: [
   { id: PREFERENCES_NAMESPACE, name: 'cordis:test-shell-preferences', config: { agentSound: false } },
   { id: WORKSPACE_PREFERENCES, name: 'cordis:test-workspace-preferences', config: { editorFontSize: 24 } },
  ] })
  for (let attempt = 0; attempt < 200 && (!(h.view(h.ctx, PREFERENCES_NAMESPACE).value as typeof defaultPreferences).errors || (h.view(h.ctx, WORKSPACE_PREFERENCES).value as typeof workspaceDefaults).autoSave); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(h.view(h.ctx, PREFERENCES_NAMESPACE).value).toMatchObject({ agentSound: false, errors: true })
  expect(h.view(h.ctx, WORKSPACE_PREFERENCES).value).toMatchObject({ editorFontSize: 24, autoSave: false })
  expect(await readFile(join(h.home, 'settings.yaml.imported'), 'utf8')).toContain('lyapunov-preferences:')
 })
 test('拒绝旧revision和非法组合后patch与权威值不变，unset回原生默认', async () => {
  const h = await preferencesFixture()
  const original = h.view(h.ctx, WORKSPACE_PREFERENCES)
  await h.ctx.settings.update(WORKSPACE_PREFERENCES, { editorFontSize: 20 }, original.revision)
  const before = await readFile(h.profile.patchPath, 'utf8')
  await expect(h.ctx.settings.update(WORKSPACE_PREFERENCES, { editorFontSize: 22 }, original.revision)).rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' })
  expect(await readFile(h.profile.patchPath, 'utf8')).toBe(before)
  const fresh = h.view(h.ctx, WORKSPACE_PREFERENCES)
  await expect(h.ctx.settings.update(WORKSPACE_PREFERENCES, { editorFontFamily: 'bad\nfont' }, fresh.revision)).rejects.toThrow('字体名称')
  await expect(h.ctx.settings.update(WORKSPACE_PREFERENCES, { shortcuts: { fileOpen: 'mod+k', panelClose: 'mod+k' } }, fresh.revision)).rejects.toThrow('同一快捷键')
  expect(await readFile(h.profile.patchPath, 'utf8')).toBe(before)
  await h.ctx.settings.mutate(WORKSPACE_PREFERENCES, [{ op: 'unset', path: ['editorFontSize'] }], fresh.revision)
  expect(h.view(h.ctx, WORKSPACE_PREFERENCES).value).toMatchObject({ editorFontSize: workspaceDefaults.editorFontSize })
 })
})
