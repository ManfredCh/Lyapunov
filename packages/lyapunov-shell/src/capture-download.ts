export function captureDepthDownloadHeaders(id: string, cameraName?: string): Record<string, string> {
  const filename = cameraName === undefined ? `${id}-depth.npy` : `${id}-${cameraName}-depth.npy`
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  return { "content-disposition": `attachment; filename="${id}-depth.npy"; filename*=UTF-8''${encoded}` }
}
