import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent'
import { SessionUndoController } from './controller.ts'
import type {} from './types.ts'

export const name = 'lyapunov-session-undo'
export const inject = ['commands', 'agents', 'sessions', 'sessionController', 'sessionPersistence', 'attachments']
export interface Config { dataRoot: string; snapshots?: boolean }
export const Config: Schema<Config> = Schema.object({ dataRoot: Schema.string().required(), snapshots: Schema.boolean().default(true) })

export function apply(ctx: Context, config: Config): void {
  const controller = new SessionUndoController(ctx, config)
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'enter' && decision.messages.length) await controller.beforeStep(payload.agent, payload.turn, payload.step, decision.messages, payload.signal)
    return decision
  }, { prepend: true })
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => { await controller.turnStopping(agent, signal) })
  for (const action of ['undo', 'redo', 'undo_status'] as const) ctx.commands.register({
    name: action,
    description: action === 'undo' ? 'Undo the latest user input and subsequent working-tree changes while preserving original session facts.' : action === 'redo' ? 'Redo the previous undo boundary and file state.' : 'Inspect native session undo/redo and file-snapshot state.',
    input: { hint: 'No parameters.', attachments: true },
    async handler(invocation) {
      if (invocation.rawInput.trim()) return { kind: 'error', text: '/' + action + ' 不接受参数。' }
      const result = action === 'undo_status' ? await controller.status(invocation.agent) : await controller.perform(invocation.agent, action, invocation.signal, invocation.commandId)
      return { kind: 'success', text: JSON.stringify(result), ...(result.checkoutSeq === undefined ? {} : { sourceEventSeq: result.checkoutSeq as import('@deepseek-ai/dsh-session').SessionSeq }) }
    },
  })
  // 已鉴权原生Connection上的只读附件取回：不执行撤销、不修改Session，只恢复客户端草稿字节。
  ctx.inject(['connection'], connected => {
  const connection = connected.get('connection') as unknown as { fetch: { register(route: { path: string; methods: string[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): void } }
  connection.fetch.register({ path: '/api/lyapunov/history-draft', methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    const input = await request.json() as { sessionId?: string; userSeq?: number }
    if (!input.sessionId || !Number.isSafeInteger(input.userSeq) || input.userSeq! < 0) return Response.json({ error: '需要sessionId与非负userSeq。' }, { status: 400 })
    const state = await ctx.sessionController.inspect(SessionId(input.sessionId), request.signal)
    const event = state.events[input.userSeq!]
    if (event?.type !== 'user/message' || event.data.source.kind !== 'user' || event.surfaceOp !== 'append') return Response.json({ error: '该位置不是原生用户消息。' }, { status: 404 })
    const content: unknown[] = []
    for (const part of event.data.content) {
      if (part.type === 'text') content.push({ type: 'text', text: part.text })
      else if (part.type === 'image') {
        const image = await ctx.attachments.readImage(part.attachment, request.signal)
        content.push({ type: 'image', name: image.ref.name ?? '恢复图片', mediaType: image.ref.mediaType, data: Buffer.from(image.data).toString('base64') })
      } else if (part.type === 'file') {
        const chunks: Uint8Array[] = []
        for await (const chunk of ctx.attachments.readFileStream(part.attachment, request.signal)) chunks.push(chunk)
        content.push({ type: 'file', name: part.attachment.name, data: Buffer.concat(chunks).toString('base64') })
      }
    }
    return Response.json({ sessionId: input.sessionId, userSeq: input.userSeq, content })
  } })
  })
}
