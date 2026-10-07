import {describe, expect, test} from 'bun:test'
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'

const helper = new URL('../python/artifact_inspect.py', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'lyapunov-artifact-inspect-'))
function glb(name: string, patch: Record<string, unknown> = {}, binary = Buffer.alloc(4)): string {
  const json = Buffer.from(JSON.stringify({asset: {version: '2.0'}, meshes: [{primitives: [{attributes: {POSITION: 0, TEXCOORD_0: 1}}]}], ...patch}))
  const padded = Buffer.concat([json, Buffer.alloc((4-json.length%4)%4, 0x20)])
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28+padded.length+binary.length, 8)
  const jh = Buffer.alloc(8); jh.writeUInt32LE(padded.length, 0); jh.writeUInt32LE(0x4e4f534a, 4)
  const bh = Buffer.alloc(8); bh.writeUInt32LE(binary.length, 0); bh.writeUInt32LE(0x004e4942, 4)
  const path = join(dir, name+'.glb'); writeFileSync(path, Buffer.concat([header, jh, padded, bh, binary])); return path
}
function inspect(path: string, ...flags: string[]) {
  const run = spawnSync(process.env.TESTCI_PYTHON || 'python3', [helper, path, ...flags], {encoding: 'utf8'})
  return {exit: run.status, report: JSON.parse(run.stdout.trim())}
}
describe('GLB exact artifact facts and portable-texture requirement', () => {
  test('untextured exports are facts-readable but cannot claim required portable textures', () => {
    const path = glb('untextured')
    expect(inspect(path).exit).toBe(0)
    const required = inspect(path, '--require-textures')
    expect(required.exit).toBe(2)
    expect(required.report.failures).toContain('GLB_PORTABLE_TEXTURES_MISSING')
    expect(required.report.visualMatch).toBe('not-evaluated')
    expect(required.report.roundtrip).toBe('not-performed')
  })
  test('read bytes and linked texture references; static facts never claim Blender reload', () => {
    const path = glb('embedded', {bufferViews: [{buffer: 0, byteLength: 4}], images: [{bufferView: 0, mimeType: 'image/png'}],
      textures: [{source: 0}], materials: [{pbrMetallicRoughness: {baseColorTexture: {index: 0}}}]})
    const r = inspect(path, '--require-textures')
    expect(r.exit).toBe(0)
    expect(r.report.bytes).toBe(readFileSync(path).byteLength)
    expect(r.report.embeddedImages).toBe(1)
    expect(r.report.materialTextureReferences).toBe(1)
    expect(r.report.roundtrip).toBe('not-performed')
  })
  test('missing UV and external image references are explicit failures', () => {
    const path = glb('external', {meshes: [{primitives: [{attributes: {POSITION: 0}, material: 0}]}], images: [{uri: 'wood.png'}],
      textures: [{source: 0}], materials: [{pbrMetallicRoughness: {baseColorTexture: {index: 0}}}]})
    const r = inspect(path, '--require-textures')
    expect(r.exit).toBe(2)
    expect(r.report.failures).toContain('GLB_TEXTURES_NOT_SELF_CONTAINED')
    expect(r.report.failures).toContain('GLB_UV_MISSING')
  })
  test('reject a truncated export and image data outside the BIN chunk', () => {
    const bad = glb('bad-length'); writeFileSync(bad, readFileSync(bad).subarray(0, 20))
    expect(inspect(bad).report.error).toContain('GLB_HEADER_INVALID')
    const outside = glb('outside', {bufferViews: [{byteOffset: 3, byteLength: 9}], images: [{bufferView: 0}]})
    expect(inspect(outside).report.error).toBe('GLB_IMAGE_BYTES_INVALID')
  })
  test('a texture entry without a valid image source cannot satisfy portable textures', () => {
    const path = glb('invalid-image-source', {bufferViews: [{byteLength: 4}], images: [{bufferView: 0}],
      textures: [{source: 8}], materials: [{pbrMetallicRoughness: {baseColorTexture: {index: 0}}}]})
    const r = inspect(path, '--require-textures')
    expect(r.exit).toBe(2)
    expect(r.report.error).toBe('GLB_TEXTURE_IMAGE_REFERENCE_INVALID')
  })
})
