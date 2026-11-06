import { expect, test } from 'bun:test'
import { captureDepthDownloadHeaders } from '../src/capture-download.ts'

test('camera depth download preserves UTF-8 names without invalid response headers', () => {
  const cameraName = '80d7c7eb-214b-4ab5-b998-85a4e3eea44a/相机'
  const response = new Response(new Uint8Array([1, 2, 3]), { headers: captureDepthDownloadHeaders('capture-1', cameraName) })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-disposition')).toBe(`attachment; filename="capture-1-depth.npy"; filename*=UTF-8''${encodeURIComponent(`capture-1-${cameraName}-depth.npy`).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`)
  expect(response.headers.get('content-disposition')).toContain('%E7%9B%B8%E6%9C%BA-depth.npy')
  return expect(response.bytes()).resolves.toEqual(new Uint8Array([1, 2, 3]))
})

test('camera depth download header cannot be injected through a name', () => {
  for (const cameraName of ['arm/wrist', 'bad"\r\nX-Injected: yes', 'quote\'*()']) {
    const headers = captureDepthDownloadHeaders('capture-1', cameraName)
    const response = new Response(null, { headers })
    expect(response.headers.get('content-disposition')).not.toMatch(/[\r\n]/)
    expect(response.headers.get('content-disposition')).toContain('filename="capture-1-depth.npy"')
  }
})
