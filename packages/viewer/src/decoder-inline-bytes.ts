/**
 * 内联解码器字节 → `blob:` URL 的**共用机械**：DRACO 与 KTX2 走同一份实现。
 *
 * 形状来自 DRACO 那一单（`bugfixHistory/GLB-DRACO-RENDER-20260926.md`）已验证过的那条路：
 * 解码器/转码器的字节**内联在客户端产物里**，靠 `LoadingManager.setURLModifier` 把
 * `<route><文件名>` 这一个精确形状的请求改写成由内联字节建出的 blob URL，其余 URL 一律原样放行。
 *
 * **为什么是"精确到 route + 文件名"而不是前缀通配**：装载器自己的解码器请求与 glTF 自己的资源
 * 请求走的是同一个 `LoadingManager`；改写器一旦放宽，就会把不该动的 URL 也换掉（那是"看起来能用、
 * 出事说不清"的形状）。这里 `rewrite()` 只认表里登记过的键，glTF 的 bin/贴图/媒体路由 URL 原样返回。
 *
 * **两个查询口径是有意分开的**（由用例分别钉住）：
 *  - `matchInlineRequest(routes, url)`：**只认 `<route><文件名>`** —— 改写器的输入是拼好的 URL；
 *  - `inlineEntryByName(routes, name)`：**只认裸文件名** —— 生成文件的核对口径（对照盘上 three 的文件名）。
 */
/** base64 → 字节。base64 是文本编码，浏览器与 bun 都有 `atob`；不用 `fetch(data:)` 是为了同步可用。 */
export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** 内联表里的一条：源文件长度 + sha256（可复算）+ base64 字节 + 写进 Blob 的 MIME。 */
export interface InlineDecoderFile {
  mediaType: string
  bytes: number
  sha256: string
  data: string
}

export type InlineDecoderTable = Readonly<Record<string, InlineDecoderFile>>

/** 一条解码器路由：`route` 是名义基址（末尾带 `/`），`table` 是这条路由上内联的文件名 → 字节。 */
export interface InlineDecoderRoute {
  route: string
  table: InlineDecoderTable
}

/** 命中一次解码器请求：哪个路由、哪个文件名、表里那条。 */
export interface InlineDecoderMatch {
  route: string
  name: string
  entry: InlineDecoderFile
}

/**
 * 解码器请求的 blob URL 源。
 *
 * `rewrite` 只认登记过的键，其余一律 `undefined`（= 调用方原样放行）；blob URL 按需建、按名缓存
 * ⇒ **不带压缩的 glTF 一次都不建 blob、一次解码器请求也不发**（由用例与真机读数各钉一遍）。
 * `revoke` 撤掉建过的那些（没建过就是空操作）。`created()` 是"这次加载到底有没有碰解码器"的读数口径。
 */
export interface DecoderBlobSource {
  rewrite(url: string): string | undefined
  revoke(): void
  /** 已经建出来的 blob URL 对应的**解码器文件名**（DRACO 那一单的读数口径，逐字保留）。 */
  created(): string[]
}

/** **只认 `<route><文件名>`**（改写器口径）：不是这个形状就 `undefined`（调用方原样放行）。 */
export function matchInlineRequest(routes: readonly InlineDecoderRoute[], url: string): InlineDecoderMatch | undefined {
  for (const { route, table } of routes) {
    if (!url.startsWith(route)) continue
    const name = url.slice(route.length)
    const entry = table[name]
    if (entry) return { route, name, entry }
  }
  return undefined
}

/** **只认裸文件名**（生成文件核对口径）：跨所有路由的表按名字查。 */
export function inlineEntryByName(routes: readonly InlineDecoderRoute[], name: string): InlineDecoderFile | undefined {
  for (const { table } of routes) {
    const entry = table[name]
    if (entry) return entry
  }
  return undefined
}

/** 裸文件名 → 内联字节；表里没有就 `undefined`（**不猜、不回落网络**）。 */
export function inlineBytesByName(routes: readonly InlineDecoderRoute[], name: string): Uint8Array | undefined {
  const entry = inlineEntryByName(routes, name)
  return entry ? base64ToBytes(entry.data) : undefined
}

export function createInlineBlobSource(routes: readonly InlineDecoderRoute[]): DecoderBlobSource {
  const created = new Map<string, { name: string; objectURL: string }>()
  return {
    rewrite(url) {
      const match = matchInlineRequest(routes, url)
      if (!match) return undefined
      const cached = created.get(url)
      if (cached) return cached.objectURL
      const bytes = base64ToBytes(match.entry.data)
      const objectURL = URL.createObjectURL(new Blob([bytes], { type: match.entry.mediaType }))
      created.set(url, { name: match.name, objectURL })
      return objectURL
    },
    revoke() {
      for (const row of created.values()) URL.revokeObjectURL(row.objectURL)
      created.clear()
    },
    created() { return [...created.values()].map(row => row.name) },
  }
}
