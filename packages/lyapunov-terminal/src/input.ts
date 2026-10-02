import { randomUUID } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AttachmentStore, FileAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { FileUploads, FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload'
import type { SessionController, PromptContentPart, SessionPromptValue, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { CommandSubmitAttachment } from '@deepseek-ai/dsh-commands'
import type { ContentBlock, FileBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

export interface TerminalInputOwners {
  readonly attachments: Pick<AttachmentStore, 'imageLimits' | 'saveImage' | 'readImage' | 'readFileStream'>
  readonly fileUploads: Pick<FileUploads, 'uploadStream' | 'resolve'>
  readonly sessionController: Pick<SessionController, 'resolveAgent' | 'prompt'>
}

export interface DraftAttachment {
  readonly id: string
  readonly path?: string
  readonly name: string
  readonly kind: 'file' | 'pdf' | 'image'
  readonly bytes: number
  /** 原生附件服务返回的持久引用；绝不是原始本地路径占位。 */
  readonly block: FileBlock | ImageBlock
}
interface StagedAttachment extends DraftAttachment { receiptId?: FileUploadReceiptId }
interface Draft {
  text: string
  textRevision: number
  multiline: boolean
  multilineBase: string
  multilineEntries: number
  attachments: StagedAttachment[]
}
export interface TerminalDraftSnapshot {
  readonly text: string
  readonly multiline: boolean
  readonly attachments: readonly DraftAttachment[]
}
export interface PreparedTerminalSubmission {
  readonly sessionId: SessionId
  readonly requestId: SessionRequestId
  /** 直接交给原生SessionController.prompt；图片仍经过其模型能力与批量准入。 */
  readonly content: readonly PromptContentPart[]
  /** 直接交给原生commands.execute的附件参数。 */
  readonly commandAttachments: readonly CommandSubmitAttachment[]
  readonly attachmentBlocks: readonly (FileBlock | ImageBlock)[]
  /** 只在prompt accepted或Command成功后调用；保留准备期间新增的草稿内容。 */
  commit(): void
}
export interface PrepareTerminalInput {
  /** 省略时发送当前会话草稿；显式文本不会清掉未被发送的其他草稿文字。 */
  readonly text?: string
  /** 调用者持有取消权；上传/读取被取消后不会触发prompt或追加草稿附件。 */
  readonly signal: AbortSignal
}

const images: Readonly<Record<string, ImageMediaType>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

/** 只拥有终端UI草稿；Agent、上传收据与附件字节由现成原生owner管理。 */
export class TerminalInputDrafts {
  private readonly drafts = new Map<SessionId, Draft>()
  constructor(private readonly owners: TerminalInputOwners) {}

  private draft(sessionId: SessionId): Draft {
    let draft = this.drafts.get(sessionId)
    if (!draft) {
      draft = { text: '', textRevision: 0, multiline: false, multilineBase: '', multilineEntries: 0, attachments: [] }
      this.drafts.set(sessionId, draft)
    }
    return draft
  }
  getSnapshot(sessionId: SessionId): TerminalDraftSnapshot {
    const draft = this.draft(sessionId)
    return { text: draft.text, multiline: draft.multiline, attachments: draft.attachments.map(({ receiptId: _receipt, ...item }) => item) }
  }
  getText(sessionId: SessionId): string { return this.draft(sessionId).text }
  setText(sessionId: SessionId, text: string): void {
    const draft = this.draft(sessionId)
    draft.text = text; draft.textRevision++
    if (draft.multiline) draft.multilineEntries = text.length ? 1 : 0
  }
  beginMultiline(sessionId: SessionId): void {
    const draft = this.draft(sessionId)
    if (draft.multiline) throw new Error('该会话已经在输入多行内容。')
    draft.multiline = true; draft.multilineBase = draft.text; draft.multilineEntries = draft.text.length ? 1 : 0
  }
  /** 文本按字面追加，不解释其中的:quit/:stop或任何斜杠命令。 */
  appendMultiline(sessionId: SessionId, text: string): void {
    const draft = this.draft(sessionId)
    if (!draft.multiline) throw new Error('请先开始多行输入。')
    draft.text += (draft.multilineEntries++ ? '\n' : '') + text
    draft.textRevision++
  }
  /** 取消本次多行编辑，恢复开始前文字；附件仍需用户显式移除。 */
  cancelMultiline(sessionId: SessionId): void {
    const draft = this.draft(sessionId)
    if (!draft.multiline) return
    draft.text = draft.multilineBase; draft.textRevision++; draft.multiline = false; draft.multilineEntries = 0
  }
  removeAttachment(sessionId: SessionId, id: string): boolean {
    const draft = this.draft(sessionId), before = draft.attachments.length
    draft.attachments = draft.attachments.filter(item => item.id !== id)
    return draft.attachments.length !== before
  }
  /** 显式取消整个UI草稿；不删除源文件或原生内容寻址对象。 */
  clear(sessionId: SessionId): void { this.drafts.delete(sessionId) }
  dispose(): void { this.drafts.clear() }

  /** 撤销返回的是原生持久引用；仅替换UI草稿，不改变原用户事件或复用失效上传receipt。 */
  restoreContent(sessionId: SessionId, content: readonly ContentBlock[]): void {
    const text = content.filter(part => part.type === 'text').map(part => part.text).join('')
    const attachments: StagedAttachment[] = content.flatMap(part => {
      if (part.type !== 'file' && part.type !== 'image') return []
      return [{ id: randomUUID(), name: part.attachment.name ?? '恢复图片', kind: part.type === 'image' ? 'image' : part.attachment.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'file', bytes: part.attachment.bytes, block: part } as StagedAttachment]
    })
    this.drafts.set(sessionId, { text, textRevision: 0, multiline: false, multilineBase: '', multilineEntries: 0, attachments })
  }

  /** 剪贴板图像直接进入同一个原生附件 owner，没有伪造本地来源文件。 */
  async addImage(sessionId: SessionId, image: { data: Uint8Array; mediaType: ImageMediaType; name: string }, signal: AbortSignal): Promise<DraftAttachment> {
    signal.throwIfAborted()
    const draft = this.draft(sessionId), receiving = await this.owners.sessionController.resolveAgent(sessionId)
    if ('error' in receiving) throw receiving.error
    signal.throwIfAborted()
    const ref = await this.owners.attachments.saveImage(image)
    signal.throwIfAborted()
    if (this.drafts.get(sessionId) !== draft) throw new Error('DRAFT_CANCELLED: 图像准备期间草稿已取消。')
    const attachment: StagedAttachment = { id: randomUUID(), name: ref.name ?? image.name, kind: 'image', bytes: ref.bytes, block: { type: 'image', attachment: ref } }
    draft.attachments.push(attachment)
    return attachment
  }

  async addAttachment(sessionId: SessionId, path: string, cwd: string, signal: AbortSignal): Promise<DraftAttachment> {
    signal.throwIfAborted()
    const draft = this.draft(sessionId)
    const receiving = await this.owners.sessionController.resolveAgent(sessionId)
    if ('error' in receiving) throw receiving.error
    signal.throwIfAborted()
    if (this.drafts.get(sessionId) !== draft) throw new Error('DRAFT_CANCELLED: 上传期间草稿已取消。')
    const absolute = resolve(cwd, path), file = await open(absolute, 'r')
    try {
      const metadata = await file.stat()
      if (!metadata.isFile()) throw new Error('ATTACHMENT_NOT_FILE: 只能附加普通文件。')
      const mediaType = images[extname(absolute).toLowerCase()]
      let attachment: StagedAttachment
      if (mediaType) {
        if (metadata.size > this.owners.attachments.imageLimits.maxImageBytes) throw new Error('IMAGE_TOO_LARGE: 图片超过当前原生附件限制。')
        const bytes = await readFile(file, { signal })
        signal.throwIfAborted()
        // 原生saveImage没有signal参数；等规范化结束后再次检查取消，不发布迟到草稿。
        const ref = await this.owners.attachments.saveImage({ data: bytes, mediaType, name: basename(absolute) })
        attachment = { id: randomUUID(), path: absolute, name: ref.name ?? basename(absolute), kind: 'image', bytes: ref.bytes, block: { type: 'image', attachment: ref } }
      } else {
        const uploaded = await this.owners.fileUploads.uploadStream({ sessionId, data: file.createReadStream({ autoClose: false, signal }), name: basename(absolute), signal })
        attachment = { id: randomUUID(), path: absolute, name: uploaded.file.name, kind: extname(absolute).toLowerCase() === '.pdf' ? 'pdf' : 'file', bytes: uploaded.file.bytes, block: { type: 'file', attachment: uploaded.file }, receiptId: uploaded.receiptId }
      }
      signal.throwIfAborted()
      if (this.drafts.get(sessionId) !== draft) throw new Error('DRAFT_CANCELLED: 上传期间草稿已取消。')
      draft.attachments.push(attachment)
      const { receiptId: _receipt, ...visible } = attachment
      return visible
    } finally { await file.close() }
  }

  async prepareSubmission(sessionId: SessionId, options: PrepareTerminalInput): Promise<PreparedTerminalSubmission> {
    options.signal.throwIfAborted()
    const draft = this.draft(sessionId), captured = [...draft.attachments], revision = draft.textRevision
    const text = options.text ?? draft.text, sendsDraftText = text === draft.text
    const receiving = await this.owners.sessionController.resolveAgent(sessionId)
    if ('error' in receiving) throw receiving.error
    const content: PromptContentPart[] = text.length ? [{ type: 'text', text }] : []
    const commandAttachments: CommandSubmitAttachment[] = []
    for (const attachment of captured) {
      options.signal.throwIfAborted()
      if (attachment.block.type === 'image') {
        const image = await this.owners.attachments.readImage(attachment.block.attachment, options.signal)
        const part = { type: 'image' as const, mediaType: image.ref.mediaType, data: Buffer.from(image.data).toString('base64'), name: image.ref.name }
        content.push(part); commandAttachments.push(part)
      } else {
        let receiptId = attachment.receiptId
        if (!receiptId || !this.owners.fileUploads.resolve(receiving.agent, receiptId)) {
          // 收据是Agent暂态；需要时从原生持久附件重新装载，不依赖原文件仍在原路径。
          const ref: FileAttachmentRef = attachment.block.attachment
          const uploaded = await this.owners.fileUploads.uploadStream({ sessionId, data: this.owners.attachments.readFileStream(ref, options.signal), name: ref.name, signal: options.signal })
          receiptId = uploaded.receiptId; attachment.receiptId = receiptId
        }
        const part = { type: 'file' as const, receiptId }
        content.push(part); commandAttachments.push(part)
      }
    }
    options.signal.throwIfAborted()
    if (this.drafts.get(sessionId) !== draft || captured.some(item => !draft.attachments.includes(item))) throw new Error('DRAFT_CHANGED: 准备期间草稿附件已被删除，请重新发送。')
    let committed = false
    return {
      sessionId, requestId: randomUUID() as SessionRequestId, content, commandAttachments, attachmentBlocks: captured.map(item => item.block),
      commit: () => {
        if (committed) return
        committed = true
        if (this.drafts.get(sessionId) !== draft) return
        const consumed = new Set(captured.map(item => item.id))
        draft.attachments = draft.attachments.filter(item => !consumed.has(item.id))
        if (sendsDraftText && draft.textRevision === revision) {
          draft.text = ''; draft.textRevision++; draft.multiline = false; draft.multilineBase = ''; draft.multilineEntries = 0
        }
      },
    }
  }
  /** 成功指原生prompt准入accepted，不等待模型完成；拒绝/取消时草稿保持。 */
  async submit(sessionId: SessionId, options: PrepareTerminalInput & { readonly mode?: 'queue' | 'steer' }): Promise<SessionPromptValue> {
    const prepared = await this.prepareSubmission(sessionId, options)
    const result = await this.owners.sessionController.prompt({ sessionId, requestId: prepared.requestId, mode: options.mode ?? 'queue', content: prepared.content }, options.signal)
    if (result.accepted) prepared.commit()
    return result
  }
}

export const BRACKETED_PASTE_ENABLE = '\x1b[?2004h'
export const BRACKETED_PASTE_DISABLE = '\x1b[?2004l'
const PASTE_START = '\x1b[200~', PASTE_END = '\x1b[201~'
export type TerminalInputSegment =
  | { readonly type: 'typed'; readonly text: string }
  | { readonly type: 'paste-start' }
  | { readonly type: 'paste'; readonly text: string; readonly literal: true; readonly complete: boolean }

/** 在readline之前分离bracketed paste；粘贴整体始终标记literal，分块中文由UTF-8解码器保留。 */
export class BracketedPasteDecoder {
  private readonly utf8 = new StringDecoder('utf8')
  private pending = ''
  private pasted = ''
  private pasting = false
  get isPasting(): boolean { return this.pasting }

  push(chunk: string | Uint8Array): TerminalInputSegment[] {
    this.pending += this.utf8.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    return this.drain(false)
  }
  /** 不完整粘贴仍保持literal/complete=false，绝不退回操作命令。 */
  end(): TerminalInputSegment[] {
    this.pending += this.utf8.end()
    return this.drain(true)
  }
  private drain(ended: boolean): TerminalInputSegment[] {
    const out: TerminalInputSegment[] = []
    while (this.pending.length) {
      const marker = this.pasting ? PASTE_END : PASTE_START, at = this.pending.indexOf(marker)
      if (at >= 0) {
        const value = this.pending.slice(0, at)
        this.pending = this.pending.slice(at + marker.length)
        if (this.pasting) {
          out.push({ type: 'paste', text: this.pasted + value, literal: true, complete: true }); this.pasted = ''; this.pasting = false
        } else {
          if (value) out.push({ type: 'typed', text: value })
          out.push({ type: 'paste-start' }); this.pasting = true
        }
        continue
      }
      let retained = 0
      if (!ended) for (let size = 1; size < marker.length; size++) if (this.pending.endsWith(marker.slice(0, size))) retained = size
      const value = this.pending.slice(0, this.pending.length - retained)
      this.pending = this.pending.slice(this.pending.length - retained)
      if (this.pasting) this.pasted += value
      else if (value) out.push({ type: 'typed', text: value })
      break
    }
    if (ended && this.pasting) { out.push({ type: 'paste', text: this.pasted, literal: true, complete: false }); this.pasted = ''; this.pasting = false }
    return out
  }
}

/** 全屏只提供按键路由这一件事；结构化类型让输入层不必依赖全屏实现。 */
export interface TerminalKeyRouter { route(chunk: Buffer): Buffer | undefined }

/**
 * 一个 stdin 数据块的既有接线：先让原生 BracketedPasteDecoder 判定 literal（粘贴起始/结束标记
 * 跨 chunk 由它自己保留），再把 typed 片段交给全屏摘按键；paste/paste-start 片段原样返回。
 * 这样粘贴正文里的 Tab/CR/方向键绝不会被当成全屏操作，也不需要第二份 paste 解析器。
 */
export function decodeTerminalInput(
  decoder: BracketedPasteDecoder, screen: TerminalKeyRouter | undefined, chunk: Buffer | string,
): TerminalInputSegment[] {
  const items = decoder.push(chunk)
  if (!screen) return items
  return items.flatMap((segment): TerminalInputSegment[] => {
    if (segment.type !== 'typed') return [segment]
    const forwarded = screen.route(Buffer.from(segment.text, 'utf8'))
    return forwarded?.length ? [{ type: 'typed' as const, text: forwarded.toString('utf8') }] : []
  })
}
