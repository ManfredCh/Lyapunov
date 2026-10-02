import { randomUUID } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment/types'
import type { PromptContentPart, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { TerminalRemoteConnection } from './remote-connection.ts'

export interface RemoteDraftAttachment { id: string; name: string; data: Uint8Array; mediaType?: ImageMediaType }
interface Draft { text: string; multiline: boolean; base: string; lines: number; revision: number; attachments: RemoteDraftAttachment[]; submission?: { key: string; requestId: SessionRequestId } }
const images: Record<string, ImageMediaType> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

/** 客户端未发送草稿，等价于浏览器的本地File；持久附件与准入全部交给远端原生owner。 */
export class RemoteTerminalDrafts {
  private readonly values = new Map<SessionId, Draft>()
  get(id: SessionId): Draft {
    let value = this.values.get(id)
    if (!value) { value = { text: '', multiline: false, base: '', lines: 0, revision: 0, attachments: [] }; this.values.set(id, value) }
    return value
  }
  setText(id: SessionId, text: string): void { const value = this.get(id); value.text = text; value.revision++; if (value.multiline) value.lines = text ? 1 : 0 }
  begin(id: SessionId): void { const value = this.get(id); if (value.multiline) throw new Error('已经在多行输入中。'); value.multiline = true; value.base = value.text; value.lines = value.text ? 1 : 0 }
  append(id: SessionId, text: string): void { const value = this.get(id); value.text += (value.multiline && value.lines++ ? '\n' : '') + text; value.revision++ }
  cancelMultiline(id: SessionId): void { const value = this.get(id); if (value.multiline) { value.text = value.base; value.multiline = false; value.lines = 0; value.revision++ } }
  clear(id: SessionId): void { this.values.delete(id) }
  requestId(id: SessionId): SessionRequestId {
    const value = this.get(id), key = JSON.stringify([value.revision, value.attachments.map(item => item.id)])
    if (value.submission?.key !== key) value.submission = { key, requestId: randomUUID() as SessionRequestId }
    return value.submission.requestId
  }
  addImage(id: SessionId, image: { data: Uint8Array; mediaType: ImageMediaType; name: string }): RemoteDraftAttachment {
    const attachment = { id: randomUUID(), ...image }; this.get(id).attachments.push(attachment); return attachment
  }
  async addFile(id: SessionId, path: string, signal: AbortSignal): Promise<RemoteDraftAttachment> {
    const value = this.get(id), absolute = resolve(path), file = await open(absolute, 'r')
    try {
      if (!(await file.stat()).isFile()) throw new Error('ATTACHMENT_NOT_FILE: 只能附加本地普通文件。')
      const data = await readFile(file, { signal }); signal.throwIfAborted()
      if (this.values.get(id) !== value) throw new Error('DRAFT_CHANGED: 草稿已清除。')
      const attachment = { id: randomUUID(), name: basename(absolute), data, mediaType: images[extname(absolute).toLowerCase()] }
      value.attachments.push(attachment); return attachment
    } finally { await file.close() }
  }
  async prepare(connection: TerminalRemoteConnection, id: SessionId, signal: AbortSignal, text?: string) {
    const value = this.get(id), revision = value.revision, captured = [...value.attachments], content: PromptContentPart[] = []
    const sentText = text ?? value.text
    if (sentText) content.push({ type: 'text', text: sentText })
    for (const attachment of captured) {
      signal.throwIfAborted()
      if (attachment.mediaType) content.push({ type: 'image', mediaType: attachment.mediaType, data: Buffer.from(attachment.data).toString('base64'), name: attachment.name })
      else {
        // 每次提交从草稿字节重新取得接收者收据，跨Host重连不依赖失效的临时receipt。
        const uploaded = await connection.remote.fileUploads.upload(id, { data: Buffer.from(attachment.data).toString('base64'), name: attachment.name }, signal)
        if (!uploaded.ok) throw uploaded.error
        content.push({ type: 'file', receiptId: uploaded.value.receiptId })
      }
    }
    signal.throwIfAborted()
    if (this.values.get(id) !== value || captured.some(item => !value.attachments.includes(item))) throw new Error('DRAFT_CHANGED: 准备期间附件或草稿已变。')
    return { content, commit: () => {
      if (this.values.get(id) !== value) return
      value.attachments = value.attachments.filter(item => !captured.includes(item))
      if (text === undefined && value.revision === revision) { value.text = ''; value.multiline = false; value.base = ''; value.lines = 0; value.revision++; delete value.submission }
    } }
  }
}
