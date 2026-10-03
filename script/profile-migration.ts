import { access, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, relative } from 'node:path'
import { createRequire } from 'node:module'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
// 与原生 Include 使用同一个 YAML 方言和依赖实例。
const { load, dump } = createRequire(import.meta.resolve('@deepseek-ai/cordis-plugin-include'))('js-yaml')

export type LegacyProfileMigration = {
  status: 'not-needed' | 'migrated' | 'already-migrated'
  sourceProfile: string
  targetProfile: string
  patchCopied: boolean
  manifestMerged: boolean
  linkedDependencies: string[]
  missingDependencies: string[]
}

type JsonObject = Record<string, any>

/** Package-manager sections that can affect a profile's loader-visible closure. */
const dependencySections = [
  'dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies',
] as const

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

async function readJsonObject(path: string): Promise<JsonObject | undefined> {
  if (!(await exists(path))) return undefined
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  const object = objectValue(value)
  if (object === undefined) throw new Error(`Profile manifest 必须是 JSON 对象: ${path}`)
  return object
}

/**
 * Merge user metadata from the old manifest into the canonical manifest.
 * The target is the authority: existing target keys and values win. Bundle
 * lists are additive because a legacy custom bundle is an independent layer;
 * target user layers run after imported legacy layers and keep their order.
 */
function mergeManifestMetadata(target: JsonObject, legacy: JsonObject, sourceDir: string, defaults?: JsonObject): JsonObject {
  const merged: JsonObject = structuredClone(target)
  for (const section of dependencySections) {
    const from = objectValue(legacy[section])
    if (from === undefined) continue
    const into = objectValue(merged[section]) ?? {}
    for (const [name, spec] of Object.entries(from)) if (!(name in into)) {
      const pathSpec = typeof spec === 'string' ? /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(spec) : null
      into[name] = pathSpec?.groups?.path === undefined ? spec : `${pathSpec.groups.prefix ?? ''}${resolve(sourceDir, pathSpec.groups.path)}`
    }
    merged[section] = into
  }

  const oldDsh = objectValue(legacy.dsh), newDsh = objectValue(merged.dsh)
  if (oldDsh !== undefined || newDsh !== undefined) {
    const profileOld = objectValue(oldDsh?.profile), profileNew = objectValue(newDsh?.profile)
    const profile: JsonObject = { ...(profileOld ?? {}), ...(profileNew ?? {}) }
    const oldBundles = Array.isArray(profileOld?.bundles) ? profileOld.bundles.filter((x: unknown): x is string => typeof x === 'string') : []
    const newBundles = Array.isArray(profileNew?.bundles) ? profileNew.bundles.filter((x: unknown): x is string => typeof x === 'string') : []
    if (profileOld?.bundles !== undefined || profileNew?.bundles !== undefined) {
      const defaultBundles: string[] = objectValue(objectValue(defaults?.dsh)?.profile)?.bundles ?? []
      // The old in-box product layer must not be mounted beside the new one.
      // Only the user's additional layers migrate, before any new user layers.
      const extras = oldBundles.filter((name) => !defaultBundles.includes(name === '@lyaup/product-bundle' ? '@lyapunov/product-bundle' : name) && !newBundles.includes(name))
      const firstUserLayer = newBundles.findIndex((name) => !defaultBundles.includes(name))
      const insertion = firstUserLayer < 0 ? newBundles.length : firstUserLayer
      profile.bundles = [...newBundles.slice(0, insertion), ...extras, ...newBundles.slice(insertion)]
    }
    merged.dsh = { ...(oldDsh ?? {}), ...(newDsh ?? {}), profile }
  }
  return merged
}

function packagePathWithinModules(modulesDir: string, packageName: string): string | undefined {
  if (!packageName || packageName.includes('\\') || packageName.split('/').includes('..')) return undefined
  const path = resolve(modulesDir, packageName)
  const rel = relative(modulesDir, path)
  return rel === '' || rel.startsWith('..') ? undefined : path
}

/** Project old installed package links without copying or deleting user data. */
async function linkLegacyDependencies(input: {
  sourceDir: string
  targetDir: string
  manifest: JsonObject
  installationBundles: string[]
}): Promise<{ linked: string[]; missing: string[] }> {
  const names = new Set<string>()
  for (const section of dependencySections) {
    const rows = objectValue(input.manifest[section])
    if (rows !== undefined) for (const name of Object.keys(rows)) names.add(name)
  }
  const profile = objectValue(objectValue(input.manifest.dsh)?.profile)
  if (Array.isArray(profile?.bundles)) for (const name of profile.bundles) if (typeof name === 'string') names.add(name)
  for (const name of [...input.installationBundles, '@lyaup/product-bundle']) names.delete(name)
  const sourceModules = join(input.sourceDir, 'node_modules'), targetModules = join(input.targetDir, 'node_modules')
  const linked: string[] = [], missing: string[] = []
  for (const name of names) {
    const source = packagePathWithinModules(sourceModules, name)
    const target = packagePathWithinModules(targetModules, name)
    if (source === undefined || target === undefined) continue
    let sourceExists = false
    try { await lstat(source); sourceExists = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (!sourceExists) { missing.push(name); continue }
    try { await lstat(target); continue } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await mkdir(dirname(target), { recursive: true })
    await symlink(source, target, 'junction')
    linked.push(name)
  }
  return { linked, missing }
}

async function exists(path: string) {
  try { await access(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

function anchorLegacyRelativeReferences(text: string, sourceDir: string) {
  const patches = load(text, { schema: entryListSchema })
  if (!Array.isArray(patches)) throw new Error('旧 Profile patch 必须是 Cordis patch 数组')
  const anchor = (value: unknown) => typeof value === 'string' && /^\.\.?\//.test(value) ? resolve(sourceDir, value) : value
  const visit = (rows: any[]) => {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      if (row.name) row.name = anchor(row.name)
      if (Array.isArray(row.insert)) visit(row.insert)
      if (row.group && Array.isArray(row.config)) visit(row.config)
      // Include 内部条目继续由该文件自己的 baseUrl 解析；不改普通插件配置。
      if (row.name === '@deepseek-ai/cordis-plugin-include' && row.config?.path) row.config.path = anchor(row.config.path)
    }
  }
  visit(patches)
  return dump(patches, { schema: entryListSchema, noRefs: true })
}

/** 将旧 profile 的用户 patch 一次性接到新 profile，不删除旧目录且不覆盖新 patch。 */
export async function migrateLegacyProfile(input: {
  dshHome: string
  mode: 'formal' | 'developer'
  surface: 'web' | 'sdk' | 'headless' | 'acp'
  targetDir: string
  /** Canonical profile defaults; existing target values remain authoritative. */
  canonicalManifest?: JsonObject
}): Promise<LegacyProfileMigration> {
  const sourceProfile = `lyaup-${input.mode}-${input.surface}`
  const targetProfile = `lyapunov-${input.mode}-${input.surface}`
  const sourceDir = join(input.dshHome, 'profiles', sourceProfile)
  const marker = join(input.targetDir, '.lyapunov-legacy-profile-migrated.json')
  const empty = { manifestMerged: false, linkedDependencies: [], missingDependencies: [] }
  const priorMarker = await readJsonObject(marker)
  // N4 markers predate manifest migration. Keep their patch result, but allow
  // this later migration stage to run exactly once against the old manifest.
  if (priorMarker?.manifestMerged === true) {
    return { status: 'already-migrated', sourceProfile, targetProfile, patchCopied: priorMarker.patchCopied === true, manifestMerged: true, linkedDependencies: Array.isArray(priorMarker.linkedDependencies) ? priorMarker.linkedDependencies : [], missingDependencies: Array.isArray(priorMarker.missingDependencies) ? priorMarker.missingDependencies : [] }
  }
  const priorPatchCopied = priorMarker?.patchCopied === true
  if (priorMarker !== undefined && !(await exists(sourceDir))) return { status: 'already-migrated', sourceProfile, targetProfile, patchCopied: priorPatchCopied, ...empty }
  if (sourceProfile === targetProfile || !(await exists(sourceDir))) return { status: 'not-needed', sourceProfile, targetProfile, patchCopied: false, ...empty }

  await mkdir(input.targetDir, { recursive: true })
  const sourcePatch = join(sourceDir, 'cordis.patch.yml')
  const targetPatch = join(input.targetDir, 'cordis.patch.yml')
  const targetText = await exists(targetPatch) ? await readFile(targetPatch, 'utf8') : ''
  const targetHasPatch = targetText.trim() !== '' && targetText.trim() !== '[]'
  const copyPatchNow = await exists(sourcePatch) && !targetHasPatch
  const patchCopied = copyPatchNow || priorPatchCopied
  if (copyPatchNow) {
    const sourceText = await readFile(sourcePatch, 'utf8')
    await writeFile(targetPatch, anchorLegacyRelativeReferences(sourceText, sourceDir))
  }
  const sourceManifest = await readJsonObject(join(sourceDir, 'package.json'))
  let manifestMerged = false
  let linkedDependencies: string[] = []
  let missingDependencies: string[] = []
  if (sourceManifest !== undefined) {
    const existing = await readJsonObject(join(input.targetDir, 'package.json'))
    const base = existing ?? input.canonicalManifest ?? {}
    const merged = mergeManifestMetadata(base, sourceManifest, sourceDir, input.canonicalManifest)
    // Avoid creating a target manifest when no canonical defaults were given;
    // prepareProfile supplies them, while direct callers can remain patch-only.
    if (existing !== undefined || input.canonicalManifest !== undefined) {
      await writeFile(join(input.targetDir, 'package.json'), JSON.stringify(merged, null, 2) + '\n')
      manifestMerged = true
      // Only project packages declared by the old profile. Canonical bundles
      // are supplied by the new installation and must not be reported as
      // missing legacy dependencies.
      const installationBundles: string[] = objectValue(objectValue(input.canonicalManifest?.dsh)?.profile)?.bundles ?? []
      const links = await linkLegacyDependencies({ sourceDir, targetDir: input.targetDir, manifest: sourceManifest, installationBundles })
      linkedDependencies = links.linked
      missingDependencies = links.missing
    }
  }
  await writeFile(marker, JSON.stringify({ sourceProfile, targetProfile, patchCopied, manifestMerged, linkedDependencies, missingDependencies, migratedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
  return { status: 'migrated', sourceProfile, targetProfile, patchCopied, manifestMerged, linkedDependencies, missingDependencies }
}
