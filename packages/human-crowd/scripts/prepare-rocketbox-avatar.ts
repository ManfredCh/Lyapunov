/** 固定官方原件→每目标bind重定向→只追加Grounded→各角色鞋底校准；离线、无World/GPU。 */
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises'
import { resolve, join, dirname, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { readRiggedGlb } from '../src/glb.ts'
import { ROCKETBOX_SOURCE, ROCKETBOX_LICENSE_SHA256, ROCKETBOX_README_SHA256 } from '../src/rocketbox-sample.ts'

const args = process.argv.slice(2)
const value = (key: string, optional = false) => {
  const index = args.indexOf(key)
  if (index < 0 || !args[index + 1]) { if (optional) return undefined; throw Error('缺少参数 ' + key) }
  return args[index + 1]!
}
const source = resolve(value('--source')!), manifestPath = resolve(value('--manifest')!), out = resolve(value('--out')!)
const avatar = value('--avatar')!, blender = value('--blender')!, python = value('--python')!, reference = resolve(value('--reference-avatar')!)
if (!/^(Female|Male)_Adult_\d{2}$/.test(avatar)) throw Error('AVATAR_ID_INVALID')
const shoeSelection = value('--shoe-selection', true) ?? 'weighted'
if (!['weighted', 'lowest-component'].includes(shoeSelection)) throw Error('ROCKETBOX_SHOE_SELECTION_INVALID')
const prefix = avatar.startsWith('Female') ? 'f' : 'm', scripts = import.meta.dirname
const hash = (bytes: Uint8Array, kind = 'sha256') => createHash(kind).update(bytes).digest('hex')
const stages: Array<{ stage: string; command?: string[]; operation?: string; exitCode: number | null; timedOut: boolean; elapsedMs: number }> = []
await mkdir(out, { recursive: true })
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const save = async (path: string, data: unknown) => writeFile(path, JSON.stringify(data, null, 2))
async function run(stage: string, command: string[]) {
  const start = performance.now()
  const child = Bun.spawn(command, { env: { ...process.env, CUDA_VISIBLE_DEVICES: '' }, stdout: Bun.file(join(out, stage + '.log')), stderr: Bun.file(join(out, stage + '.stderr.log')) })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill() }, 120_000)
  const exitCode = await child.exited
  clearTimeout(timer)
  stages.push({ stage, command, exitCode, timedOut, elapsedMs: performance.now() - start })
  await save(join(out, 'stages.json'), stages)
  if (exitCode !== 0 || timedOut) throw Error(`ROCKETBOX_STAGE_FAILED: ${stage} exit=${exitCode} timeout=${timedOut}`)
}
async function packForImport(stage: string, input: string, output: string) {
  const bytes = await readFile(input)
  if (bytes.length > 32 * 1024 * 1024) {
    await run(stage, [python, join(scripts, 'rocketbox-png-lossless.py'), '--input', input, '--output', output])
    return
  }
  const start = performance.now()
  await copyFile(input, output)
  await save(join(out, stage + '.json'), { operation: 'copy-within-import-budget', inputBytes: bytes.length, outputBytes: bytes.length, sha256: hash(bytes), imageAndBinaryBytesUnchanged: true })
  stages.push({ stage, operation: 'copy-within-import-budget', exitCode: null, timedOut: false, elapsedMs: performance.now() - start })
  await save(join(out, 'stages.json'), stages)
}
const verified: Array<{ path: string; bytes: number; sha256: string; gitBlob?: string }> = []
try {
  const manifest = await json(manifestPath)
  if (manifest.repository !== ROCKETBOX_SOURCE.repository || manifest.revision !== ROCKETBOX_SOURCE.revision || manifest.license !== 'MIT') throw Error('ROCKETBOX_MANIFEST_IDENTITY_MISMATCH')
  const rows = [...(manifest.sourceFiles ?? []), ...(manifest.motionFiles ?? [])] as typeof verified
  async function verify(path: string, expected?: { bytes?: number; sha256: string; gitBlob?: string }) {
    const absolute = resolve(source, path)
    if (relative(source, absolute).startsWith('..')) throw Error('ROCKETBOX_SOURCE_PATH_INVALID: ' + path)
    const row = expected ?? rows.find(row => row.path === path)
    if (!row) throw Error('ROCKETBOX_MANIFEST_FILE_MISSING: ' + path)
    const bytes = await readFile(absolute), sha256 = hash(bytes)
    if (row.bytes !== undefined && bytes.length !== row.bytes || sha256 !== row.sha256) throw Error('ROCKETBOX_SOURCE_IDENTITY_MISMATCH: ' + path)
    const gitBlob = hash(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]), 'sha1')
    if (row.gitBlob && row.gitBlob !== gitBlob) throw Error('ROCKETBOX_SOURCE_GIT_BLOB_MISMATCH: ' + path)
    verified.push({ path, bytes: bytes.length, sha256, gitBlob })
  }
  await verify('LICENSE.md', { sha256: ROCKETBOX_LICENSE_SHA256 })
  await verify('README.md', { sha256: ROCKETBOX_README_SHA256 })
  const folder = `Assets/Avatars/Adults/${avatar}`
  const selected = rows.filter(row => row.path.startsWith(folder + '/'))
  if (!selected.some(row => row.path === `${folder}/Export/${avatar}.fbx`)) throw Error('ROCKETBOX_AVATAR_SOURCE_MISSING')
  // 原Textures文件逐件保留在来源表；源目录内的未登记材质/贴图不得悄然进入转换。
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(join(source, path), { withFileTypes: true })) {
      const file = path + '/' + entry.name
      if (entry.isDirectory()) await visit(file)
      else if (!selected.some(row => row.path === file)) throw Error('ROCKETBOX_TEXTURE_NOT_IN_MANIFEST: ' + file)
    }
  }
  await visit(folder + '/Textures')
  for (const row of selected) await verify(row.path)
  for (const [directory, name] of [['static', 'idle_breathe_01'], ['xy', 'walk_neutral'], ['xy', 'run_neutral'], ['xy', 'walk_start'], ['xy', 'walk_stop'], ['xyz', 'turn_left_180_to_walk']]) {
    await verify(`Assets/Animations/all_animations_max_motextr_${directory}/${prefix}_${name}.max.fbx`)
  }
  const referenceExpected = prefix === 'f'
    ? { name: 'Female_Adult_01.fbx', bytes: 609152, sha256: '8cbaf86576004b96469bc80df123b97fef788f4a7bb3f3eaa616fcfaf55698a3' }
    : { name: 'Male_Adult_04.fbx', bytes: 571296, sha256: 'fe0d026bc59e7d7ea8f4049edf77ee8040e050224b44a10fb4727b9b3d6efba0' }
  const referenceBytes = await readFile(reference)
  if (referenceBytes.length !== referenceExpected.bytes || hash(referenceBytes) !== referenceExpected.sha256) throw Error('ROCKETBOX_CANONICAL_REFERENCE_IDENTITY_MISMATCH')
  await save(join(out, 'verified-sources.json'), { repository: manifest.repository, revision: manifest.revision, license: 'MIT', files: verified, canonicalReference: referenceExpected })
  const baseRaw = join(out, 'base-raw'), base = join(out, 'base'), bakedRaw = join(out, 'baked-raw'), baked = join(out, 'baked'), final = join(out, 'final')
  for (const path of [baseRaw, base, bakedRaw, baked, final]) await mkdir(path, { recursive: true })
  const cachedBase = value('--base', true), packedBase = value('--packed-base', true), cachedReport = value('--conversion-report', true)
  if (cachedBase && packedBase) throw Error('ROCKETBOX_BASE_INPUT_AMBIGUOUS')
  if (cachedBase) {
    if (!cachedReport) throw Error('ROCKETBOX_CACHED_BASE_REQUIRES_CONVERSION_REPORT')
    const report = await json(resolve(cachedReport)), bytes = await readFile(resolve(cachedBase))
    if (report.avatar !== avatar || report.glbSha256 !== hash(bytes) || report.glbBytes !== bytes.length || !report.animations.every((clip: any) => clip.targetRestLengthsPreserved)) throw Error('ROCKETBOX_CACHED_BASE_IDENTITY_MISMATCH')
    await copyFile(resolve(cachedBase), join(baseRaw, avatar + '.glb'))
    await copyFile(resolve(cachedReport), join(baseRaw, 'conversion.json'))
  } else if (!packedBase) {
    await run('01-convert', [blender, '--factory-startup', '--background', '--threads', '2', '--python-exit-code', '1', '--python', join(scripts, 'rocketbox-convert.py'), '--', '--source', source, '--out', baseRaw, '--avatar', avatar, '--motion-prefix', prefix, '--specular-maps', '--retarget-rest-lengths', '--reference-avatar', reference])
  }
  const baseAsset = join(base, avatar + '.glb')
  if (packedBase) {
    const pngReportPath = value('--png-report')!
    if (!cachedReport) throw Error('ROCKETBOX_CACHED_BASE_REQUIRES_CONVERSION_REPORT')
    const report = await json(resolve(cachedReport)), pngReport = await json(resolve(pngReportPath)), bytes = await readFile(resolve(packedBase))
    if (report.avatar !== avatar || report.motionBank !== prefix || report.canonicalReference?.sha256 !== referenceExpected.sha256 || !report.animations.every((clip: any) => clip.targetRestLengthsPreserved) || pngReport.inputSha256 !== report.glbSha256 || pngReport.inputBytes !== report.glbBytes || pngReport.outputSha256 !== hash(bytes) || pngReport.outputBytes !== bytes.length) throw Error('ROCKETBOX_PACKED_BASE_IDENTITY_MISMATCH')
    await copyFile(resolve(cachedReport), join(baseRaw, 'conversion.json'))
    await copyFile(resolve(packedBase), baseAsset)
    await copyFile(resolve(pngReportPath), join(base, avatar + '.png-lossless.json'))
  } else {
    await packForImport('02-lossless-base', join(baseRaw, avatar + '.glb'), baseAsset)
  }
  const bytes = await readFile(baseAsset), parseInput = { boneMapping: { ...ROCKETBOX_SOURCE.boneMapping }, license: 'MIT', sourceUpAxis: 'Y' as const }
  const initial = readRiggedGlb(bytes, parseInput), walk = initial.clips.find(clip => clip.name === 'Walk')!, drift = walk.rootMotion!.driftM!
  const headingOffsetRad = -Math.atan2(drift[1], drift[0]), walkSpeedMps = Math.hypot(drift[0], drift[1]) / walk.durationS
  const input = { ...parseInput, headingOffsetRad }, definition = readRiggedGlb(bytes, input)
  await run('03-grounded', [blender, '--factory-startup', '--background', '--threads', '2', '--python-exit-code', '1', '--python', join(scripts, 'rocketbox-grounded.py'), '--', '--asset', baseAsset, '--out', bakedRaw, '--avatar', avatar, '--per-foot-contact-floor', '--vertical-foot-clearance', '--sole-clearance-m', '0.003', '--shoe-selection', shoeSelection])
  const bakedAsset = join(baked, avatar + '-Grounded.glb')
  await packForImport('04-lossless-baked', join(bakedRaw, avatar + '-Grounded.glb'), bakedAsset)
  await save(join(final, 'original-definition.json'), definition)
  await save(join(final, 'baked-definition.json'), readRiggedGlb(await readFile(bakedAsset), input))
  await run('05-retarget-grounded', [python, join(scripts, 'rocketbox-retarget-grounded.py'), '--original', baseAsset, '--baked', bakedAsset, '--out', final, '--avatar', avatar])
  const restored = await readFile(join(final, avatar + '-Grounded.glb'))
  await save(join(final, 'definition.json'), readRiggedGlb(restored, input))
  const sourceInfo = { avatarId: avatar, repository: manifest.repository, revision: manifest.revision, license: 'MIT', licenseFile: 'LICENSE-character.txt', licenseSha256: ROCKETBOX_LICENSE_SHA256, sourceUpAxis: 'Y', metersPerUnit: 1, boneMapping: parseInput.boneMapping, headingOffsetRad, walkSpeedMps, walkClip: 'WalkGrounded', sourceFiles: verified, canonicalReference: referenceExpected, attribution: 'Copyright (c) 2020 Microsoft. Rocketbox MIT; per-target bind/length retarget, neutral face, full original source maps retained; derived PBR approximation, not Max shader execution.' }
  await save(join(final, 'source.json'), sourceInfo)
  await run('06-fit-feet', [python, join(scripts, 'rocketbox-fit-feet.py'), '--assets', final, '--avatar', avatar, '--shoe-selection', shoeSelection])
  const glb = avatar + '-Grounded-Calibrated.glb', calibrated = await readFile(join(final, glb)), finalDefinition = readRiggedGlb(calibrated, input)
  if (finalDefinition.clips.length !== 7 || Object.keys(finalDefinition.footCollision?.segments ?? {}).length !== 2) throw Error('ROCKETBOX_DERIVATION_INCOMPLETE')
  const conversion = await json(join(baseRaw, 'conversion.json')), grounding = await json(join(bakedRaw, 'grounded-conversion.json')), retarget = await json(join(final, 'grounded-retarget.json')), calibration = await json(join(final, 'foot-calibration.json'))
  await copyFile(join(source, 'LICENSE.md'), join(final, 'LICENSE-character.txt'))
  await save(join(final, 'verified-sources.json'), { repository: manifest.repository, revision: manifest.revision, license: 'MIT', files: verified, canonicalReference: referenceExpected })
  await save(join(final, 'definition.json'), finalDefinition)
  await save(join(final, 'source.json'), { ...sourceInfo, glb, bytes: calibrated.length, sha256: hash(calibrated), derivation: { conversion, grounding, retarget, calibration } })
  await save(join(out, 'receipt.json'), { status: 'DERIVED_REQUIRES_NATIVE_AND_VISUAL_REVIEW', avatarId: avatar, glb: join(final, glb), source: join(final, 'source.json'), bytes: calibrated.length, sha256: hash(calibrated), bones: finalDefinition.rig.length, clips: finalDefinition.clips.map(clip => ({ name: clip.name, durationS: clip.durationS })), stages })
  console.log(JSON.stringify({ status: 'DERIVED_REQUIRES_NATIVE_AND_VISUAL_REVIEW', avatarId: avatar, final, bytes: calibrated.length, sha256: hash(calibrated) }))
} catch (error) {
  await save(join(out, 'receipt.json'), { status: 'FAILED', avatarId: avatar, error: String(error), stages })
  throw error
}
