export const ENGINE_INSTALL_PROVIDERS = ['mujoco', 'isaac', 'newton'] as const
export type EngineInstallProvider = typeof ENGINE_INSTALL_PROVIDERS[number]
export type EngineInstallDecision =
  | { kind: 'confirm'; provider: EngineInstallProvider; reason: 'EXPLICIT_INSTALL' }
  | { kind: 'choose'; reason: 'ENGINE_REQUIRED' | 'ENGINE_AMBIGUOUS'; providers: readonly EngineInstallProvider[] }
  | { kind: 'none'; reason: 'QUESTION' | 'STATUS' | 'NEGATED' | 'UNINSTALL' | 'NO_ENGINE_INTENT' }

const PROVIDER_ALIASES: Record<EngineInstallProvider, readonly string[]> = {
  mujoco: ['mujoco', 'mu jo co', 'mujo co'],
  isaac: ['isaac', 'isaac sim', 'omniverse isaac'],
  newton: ['newton', 'warp newton'],
}
const INSTALL = /(?:\b(?:install|setup|set\s+up)\b|安装|装好|装上)/iu
const QUESTION = /[?？]|\b(?:how|what|which|can|could|where|status|is)\b/iu
const STATUS = /\b(?:status|ready|installed|available|check)\b|状态|就绪|安装好了吗|能用吗/iu
const UNINSTALL = /\b(?:uninstall|remove|delete)\b|卸载|删除/iu
const NEGATED = /(?:\b(?:do\s+not|don't|never|without|not)\b[^.!?;，。！？；\n]*(?:install|setup|set\s+up)\b|(?:不要|别|不用|无需|禁止)[^.!?;，。！？；\n]*(?:安装|装))/iu
const AFFIRMATIVE = /^(?:yes|y|ok|okay|sure|confirm|confirmed|go ahead|do it|please do|好的?|好吧|可以|行|确认|确定|是的|对|开始)$/iu
export const ENGINE_INSTALL_CONFIRM_TTL_MS = 15 * 60_000

export function planEngineInstallIntent(text: string): EngineInstallDecision {
  const value = text.trim()
  const providers = ENGINE_INSTALL_PROVIDERS.filter(provider => matches(provider, value))
  if (UNINSTALL.test(value)) return { kind: 'none', reason: 'UNINSTALL' }
  if (!INSTALL.test(value)) {
    if (STATUS.test(value)) return { kind: 'none', reason: 'STATUS' }
    if (QUESTION.test(value)) return { kind: 'none', reason: 'QUESTION' }
    return { kind: 'none', reason: 'NO_ENGINE_INTENT' }
  }
  if (NEGATED.test(value)) return { kind: 'none', reason: 'NEGATED' }
  if (QUESTION.test(value)) return { kind: 'none', reason: 'QUESTION' }
  if (providers.length === 1) return { kind: 'confirm', provider: providers[0]!, reason: 'EXPLICIT_INSTALL' }
  if (providers.length > 1) return { kind: 'choose', reason: 'ENGINE_AMBIGUOUS', providers }
  return { kind: 'choose', reason: 'ENGINE_REQUIRED', providers: ENGINE_INSTALL_PROVIDERS }
}

function matches(provider: EngineInstallProvider, text: string): boolean {
  return PROVIDER_ALIASES[provider].some(alias => new RegExp(`(?<![a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replaceAll(' ', '[\\s_-]*')}(?![a-z0-9])`, 'iu').test(text))
}

interface PendingInstall { provider: EngineInstallProvider; turn: number; at: number }
interface InstallGrant { provider: EngineInstallProvider; turn: number; expiresAt: number }

/** Per-session two-step authorization; creates no process plan and never accepts a license. */
export class EngineInstallAuthorization {
  private readonly pending = new Map<string, PendingInstall>()
  private readonly grants = new Map<string, InstallGrant>()

  observe(session: string, text: string, turn: number, now = Date.now()): string {
    const currentGrant = this.grants.get(session)
    if (currentGrant && (currentGrant.turn !== turn || currentGrant.expiresAt < now)) this.grants.delete(session)

    const pending = this.pending.get(session)
    const confirmed = pending && turn === pending.turn + 1 && now >= pending.at
      && now - pending.at <= ENGINE_INSTALL_CONFIRM_TTL_MS && AFFIRMATIVE.test(text.trim())
      ? pending.provider
      : undefined
    if (pending && (turn > pending.turn + 1 || now - pending.at > ENGINE_INSTALL_CONFIRM_TTL_MS)) this.pending.delete(session)

    if (confirmed) {
      this.pending.delete(session)
      this.grants.set(session, { provider: confirmed, turn, expiresAt: now + ENGINE_INSTALL_CONFIRM_TTL_MS })
      return `Installation of ${confirmed} is confirmed. Use the existing installer and wait for its receipt.`
    }

    const decision = planEngineInstallIntent(text)
    if (decision.kind === 'confirm') {
      this.pending.set(session, { provider: decision.provider, turn, at: now })
      this.grants.delete(session)
      return `Installation of ${decision.provider} was requested. It changes the local environment; explicitly confirm before the existing installer is called.`
    }
    if (decision.kind === 'choose') {
      this.pending.delete(session)
      this.grants.delete(session)
      return `Specify the physics engine to install: ${decision.providers.join(', ')}. Do not guess or install automatically.`
    }
    if (decision.reason !== 'NO_ENGINE_INTENT') {
      this.pending.delete(session)
      this.grants.delete(session)
    } else if (pending && turn > pending.turn) {
      this.pending.delete(session)
    }
    return ''
  }

  consume(session: string, provider: unknown, now = Date.now()): provider is EngineInstallProvider {
    const grant = this.grants.get(session)
    const allowed = typeof provider === 'string'
      && (ENGINE_INSTALL_PROVIDERS as readonly string[]).includes(provider)
      && !!grant && grant.provider === provider && grant.expiresAt >= now
    if (allowed) this.grants.delete(session)
    return allowed
  }

  clear(session: string): void {
    this.pending.delete(session)
    this.grants.delete(session)
  }
}
