/**
 * packs 技能库工具面（docs/AGENT_GRAPH_CONTRACT.md §4 冻结名）。
 *
 * 由 plugin.ts 以一行 `applySkillTools(ctx)` 接线；packsRoot 缺省取产品安装根的 packs/
 * （与 plugin.ts 的 `resolve(import.meta.dirname,'../../..')` 同口径），测试经
 * `options.packsRoot` 注入临时目录夹具。工具与命令共享同一组执行体，SKILL_* 错误码
 * 原样上抛（与 PACK_* 同纪律：不吞不译）。
 *
 * 冻结签名（契约 §4）：
 *   pack_skill_list      {packId?}                                  → 全部已准入技能
 *   pack_skill_get       {packId, skillId}                          → 单个 PackSkill
 *   skill_propose        {packId, proposal:SkillProposal}           → 写 proposals/<skillId>.json（未准入）
 *   skill_verify_record  {skillId, verifierRunId, reproducedTaskIds, attempts, passed, packId?} → 记录验证
 *   skill_promote        {skillId, packId?}                         → 验证通过才转正，未过 ⇒ SKILL_NOT_VERIFIED
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compatibleToolInput } from '../../lyapunov-contracts/src/tool-input.ts'
import { listSkills, promoteSkill, readSkill, recordVerify, skillError, writeProposal } from './skill-library.ts'

/** 产品安装根的 packs/：本文件位于 packages/policy-registry/src/，向上三级即仓库/安装根。 */
const defaultPacksRoot = () => join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packs')

/**
 * 入参归一化：与 plugin.ts `toolInput` 同语义（对象或对象形状的 JSON 字符串都合法），
 * 错误码用契约冻结的 SKILL_* 前缀。不复用 plugin.ts 的导出——避免 plugin ↔ skill-tools 循环依赖。
 */
const skillInput = (value: unknown): Record<string, any> => {
  if (value === undefined || value === null) return {}
  let parsed: unknown = value
  if (typeof value === 'string') { try { parsed = JSON.parse(value) } catch { throw skillError('SKILL_INPUT_INVALID_JSON') } }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, any>
  throw skillError('SKILL_INPUT_MUST_BE_OBJECT', 'input 需为对象或对象形状的 JSON 字符串')
}

interface SkillOperation { description: string; execute: (input: Record<string, any>) => Promise<any> }

/** 注册五个冻结名工具 + 同名 commands。options.packsRoot 仅供测试注入。 */
export function applySkillTools(ctx: Context, options: { packsRoot?: string } = {}) {
  const packsRoot = resolve(options.packsRoot ?? defaultPacksRoot())
  const operations: Record<string, SkillOperation> = {
    pack_skill_list: {
      description: 'List admitted pack skills (lyapunov-pack-skill/1 with a promotion record). packId omitted scans every pack under packs/; an explicit packId fails SKILL_PACK_NOT_FOUND when the pack is absent. Proposals are never listed.',
      execute: async (input) => {
        const packs = await listSkills(packsRoot, input.packId)
        return { status: 'LISTED', packs, total: packs.reduce((count, pack) => count + pack.skills.length, 0) }
      },
    },
    pack_skill_get: {
      description: 'Read one PackSkill from packs/<packId>/skills/<skillId>.json. admitted=false means the file lacks a promotion record (not worker-usable). Missing pack or skill fails with SKILL_PACK_NOT_FOUND / SKILL_NOT_FOUND.',
      execute: async (input) => {
        const skill = await readSkill(packsRoot, input.packId, input.skillId)
        return { status: 'FOUND', admitted: skill.promotion !== undefined, skill }
      },
    },
    skill_propose: {
      description: 'Write a SkillProposal as an unadmitted PackSkill to packs/<packId>/proposals/<skillId>.json (never directly into skills/). proposal.packId must equal the packId argument. Existing proposal or promoted skill is rejected, never overwritten.',
      execute: async (input) => {
        const proposal = input.proposal
        if (input.packId !== undefined && proposal?.packId !== undefined && proposal.packId !== input.packId) {
          throw skillError('SKILL_PACK_MISMATCH', `proposal.packId=${String(proposal.packId)} 与入参 packId=${String(input.packId)} 不一致`)
        }
        const skill = await writeProposal(packsRoot, { ...(proposal as any), packId: input.packId ?? proposal?.packId })
        return { status: 'PROPOSED', admitted: false, path: `packs/${skill.proposal.packId}/proposals/${skill.proposal.skillId}.json`, skill }
      },
    },
    skill_verify_record: {
      description: 'Record one verifier verdict for a pending proposal (proposals/<skillId>.verify.json, latest record wins). Only passed=true unlocks skill_promote. skillId unique across packs resolves the pack; pass packId to disambiguate.',
      execute: async (input) => {
        const record = await recordVerify(packsRoot, input.skillId, {
          verifierRunId: input.verifierRunId,
          reproducedTaskIds: input.reproducedTaskIds,
          attempts: input.attempts,
          passed: input.passed,
        }, input.packId)
        return { status: 'VERIFICATION_RECORDED', record }
      },
    },
    skill_promote: {
      description: 'Promote a verified proposal into packs/<packId>/skills/<skillId>.json with a SkillPromotion and append one line to skills/promotions.jsonl. Missing or failed verification fails SKILL_NOT_VERIFIED; an already-admitted skill fails SKILL_ALREADY_PROMOTED.',
      execute: async (input) => {
        const { skill, promotion } = await promoteSkill(packsRoot, input.skillId, input.packId)
        return { status: 'PROMOTED', path: `packs/${promotion.packId}/skills/${promotion.skillId}.json`, skill, promotion }
      },
    },
  }
  for (const [name, definition] of Object.entries(operations)) {
    const tool = defineTool({
      name,
      description: definition.description,
      parameters: { input: { type: 'json', required: true, description: 'JSON arguments per docs/AGENT_GRAPH_CONTRACT.md §4.' } },
      output: { schema: { type: 'json' }, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args: any, exec: any) => definition.execute(skillInput(args?.input)),
    })
    ctx.tools.register(compatibleToolInput(tool))
    ctx.commands.register({
      name,
      description: definition.description,
      input: { hint: 'Skill library arguments as JSON.' },
      async handler(invocation) {
        try {
          const parsed = JSON.parse(invocation.rawInput || '{}')
          if (typeof (ctx.tools as { execute?: unknown })?.execute === 'function') {
            const result = await (ctx.tools as { execute: (input: unknown) => Promise<{ isError?: boolean; value?: unknown; content: Array<{ type: string; text?: string }> }> }).execute({
              name,
              arguments: { input: parsed },
              callId: `${name}-cmd-${Date.now()}`,
              ...(invocation.agent !== undefined ? { agent: invocation.agent } : {}),
              signal: invocation.signal ?? new AbortController().signal,
            })
            const text = result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')
            return { kind: result.isError ? 'error' : 'success', text: text || JSON.stringify(result.value) }
          }
          const value = await definition.execute(parsed)
          return { kind: 'success', text: JSON.stringify(value) }
        } catch (error) {
          return { kind: 'error', text: String(error) }
        }
      },
    })
  }
}
