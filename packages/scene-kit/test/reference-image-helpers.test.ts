/**
 * reference-tools 纯函数部分的真实行为测试（无网络、无 Cordis）：格式判定、来源页核对、缩略图信号。
 * 这里不编造结论：断言的是"函数返回了什么"，不是"这张图是不是原图"。
 * 运行：`bun test packages/scene-kit/test/reference-image-helpers.test.ts`
 */
import { describe, expect, it } from 'bun:test'
import {
  assertReferenceSourcePage,
  headerMediaType,
  resolveReferenceImageMediaType,
  sniffImageMediaType,
  thumbnailSignals,
  REFERENCE_IMAGE_DEFAULT_MAX_BYTES,
  REFERENCE_IMAGE_HARD_MAX_BYTES,
  type ReferenceImageSignal,
} from '../src/reference-tools.ts'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)])
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(8)])
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(8)])
const HTML = Buffer.from('<html><body>not an image</body></html>', 'utf8')

describe('图片字节嗅探', () => {
  it('认出 png/jpeg/gif/webp 的签名', () => {
    expect(sniffImageMediaType(PNG)).toBe('image/png')
    expect(sniffImageMediaType(JPEG)).toBe('image/jpeg')
    expect(sniffImageMediaType(GIF)).toBe('image/gif')
    expect(sniffImageMediaType(WEBP)).toBe('image/webp')
  })

  it('HTML、空字节与短前缀都不认作图片', () => {
    expect(sniffImageMediaType(HTML)).toBeUndefined()
    expect(sniffImageMediaType(Buffer.alloc(0))).toBeUndefined()
    expect(sniffImageMediaType(Buffer.from([0x89, 0x50]))).toBeUndefined()
  })
})

describe('Content-Type 归一', () => {
  it('去掉参数、转小写，并把 image/jpg 折成 image/jpeg', () => {
    expect(headerMediaType('IMAGE/PNG; charset=binary')).toBe('image/png')
    expect(headerMediaType('image/jpg')).toBe('image/jpeg')
    expect(headerMediaType('')).toBe('')
  })
})

describe('原图格式判定', () => {
  it('头与字节一致的受支持格式直接通过', () => {
    expect(resolveReferenceImageMediaType('image/png', PNG)).toBe('image/png')
    expect(resolveReferenceImageMediaType('image/jpeg; charset=binary', JPEG)).toBe('image/jpeg')
  })

  it('头写 application/octet-stream 时按真实字节判定（图床常见）', () => {
    expect(resolveReferenceImageMediaType('application/octet-stream', WEBP)).toBe('image/webp')
    expect(resolveReferenceImageMediaType('', PNG)).toBe('image/png')
  })

  it('头声明图片但字节不符：明确拒绝而不是谎报格式', () => {
    expect(() => resolveReferenceImageMediaType('image/png', GIF)).toThrow(/REFERENCE_IMAGE_CONTENT_TYPE_MISMATCH/)
    expect(() => resolveReferenceImageMediaType('image/png', HTML)).toThrow(/REFERENCE_IMAGE_BYTES_NOT_IMAGE/)
  })

  it('网页 URL 被点名为"不是图片直链"并给出下一步', () => {
    let message = ''
    try { resolveReferenceImageMediaType('text/html; charset=utf-8', HTML) } catch (error) { message = (error as Error).message }
    expect(message).toContain('REFERENCE_IMAGE_NOT_AN_IMAGE_LINK')
    expect(message).toContain('web_fetch')
    expect(message).toContain('可采取的动作')
  })

  it('AVIF/SVG/TIFF 等附件不支持的格式给出换格式的动作', () => {
    expect(() => resolveReferenceImageMediaType('image/avif', Buffer.alloc(4))).toThrow(/REFERENCE_IMAGE_FORMAT_UNSUPPORTED/)
    expect(() => resolveReferenceImageMediaType('image/svg+xml', Buffer.from('<svg/>'))).toThrow(/REFERENCE_IMAGE_FORMAT_UNSUPPORTED/)
  })

  it('无法识别且无可用 Content-Type 时说明"很可能不是原图直链"', () => {
    expect(() => resolveReferenceImageMediaType('application/octet-stream', Buffer.from('hello'))).toThrow(/REFERENCE_IMAGE_FORMAT_UNRECOGNIZED/)
  })
})

describe('来源页核对', () => {
  it('接受 https 绝对地址', () => {
    expect(assertReferenceSourcePage('https://example.org/a?b=1#c').href).toBe('https://example.org/a?b=1#c')
  })

  it('拒绝相对地址、http 与带凭据的地址', () => {
    expect(() => assertReferenceSourcePage('/a/b')).toThrow(/REFERENCE_IMAGE_SOURCE_PAGE_INVALID/)
    expect(() => assertReferenceSourcePage('http://example.org/a')).toThrow(/REFERENCE_IMAGE_SOURCE_PAGE_INVALID/)
    expect(() => assertReferenceSourcePage('https://user:secret@example.org/a')).toThrow(/REFERENCE_IMAGE_SOURCE_PAGE_INVALID/)
  })
})

describe('缩略图信号', () => {
  const codes = (signals: ReferenceImageSignal[]): string[] => signals.map(signal => signal.code)

  it('干净的原图直链不产生任何信号', () => {
    expect(thumbnailSignals(new URL('https://upload.example.org/files/cathedral-facade.jpg'), { width: 3000, height: 2000 })).toEqual([])
  })

  it('文件名尺寸标记在与实测一致时被说明，并与路径/查询参数信号一起列出', () => {
    const signals = thumbnailSignals(new URL('https://images.example.org/thumbs/photo-150x150.jpg?w=150'), { width: 150, height: 150 })
    expect(codes(signals)).toEqual(['filename-size-token', 'thumbnail-path-token', 'resize-query-param', 'measured-small'])
    expect(signals[0]!.detail).toContain('与实际像素一致')
  })

  it('实测尺寸偏小本身就是一个信号', () => {
    const signals = thumbnailSignals(new URL('https://images.example.org/a/photo.jpg'), { width: 320, height: 240 })
    expect(codes(signals)).toEqual(['measured-small'])
  })

  it('没有实测尺寸时仍能给出 URL 形态信号，且不谎报尺寸一致', () => {
    const signals = thumbnailSignals(new URL('https://images.example.org/photo-1200x800.jpg'), undefined)
    expect(codes(signals)).toEqual(['filename-size-token'])
    expect(signals[0]!.detail).not.toContain('与实际像素一致')
  })
})

describe('体积上限常量', () => {
  it('默认上限不超过硬上限，硬上限在附件服务默认单图上限（20 MiB）以内', () => {
    expect(REFERENCE_IMAGE_DEFAULT_MAX_BYTES).toBeLessThanOrEqual(REFERENCE_IMAGE_HARD_MAX_BYTES)
    expect(REFERENCE_IMAGE_HARD_MAX_BYTES).toBeLessThanOrEqual(20 * 1024 * 1024)
  })
})
