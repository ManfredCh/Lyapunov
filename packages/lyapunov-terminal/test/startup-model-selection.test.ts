/**
 * Offline startup orchestration tests: actual startTerminalSession, native Cordis,
 * in-memory Sessions, and the native model-selection projection. Typed injected
 * controllers provide only the methods startup consumes; they do not exercise
 * the production controller's provider validation, cold persistence, or Agent loop.
 * The fork fixture copies a completed-turn prefix through SessionStore.fork.
 * Every filesystem lookup uses a fresh temporary cwd; no Host/config/env is loaded.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  ModelCatalog, ModelSelection, ModelSelectionProjectionState,
  SessionSelectModelRequest,
} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import { installModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/src/model-selection-projection.ts'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  startTerminalSession,
  type TerminalStartupConfig,
  type TerminalStartupResult,
} from '../src/startup.ts'

const SOURCE_ID = SessionId('startup-model-source')
const CREATED_ID = SessionId('startup-model-created')
const CHILD_ID = SessionId('startup-model-child')
const WORKSPACE_ID = WorkspaceId('startup-model-workspace')
const INITIAL_DEFAULT = { provider: 'server', model: 'configured-before' }
const CHANGED_DEFAULT = { provider: 'server', model: 'configured-after' }
const LOGGED: ModelSelection = { provider: 'saved', model: 'logged', reasoningEffort: 'low' }
const PENDING: ModelSelection = { provider: 'saved', model: 'pending', reasoningEffort: 'medium' }
const EXPLICIT: ModelSelection = { provider: 'cli', model: 'override' }

type ExistingDisposition = Exclude<TerminalStartupResult['disposition'], 'created'>
type SavedState = 'lastUsed' | 'pending'
type StartupController = Pick<
  Context['sessionController'],
  'create' | 'resolveAgent' | 'list' | 'fork' | 'modelCatalog' | 'selectModel'
>

const EXISTING_DISPOSITIONS: readonly ExistingDisposition[] = ['resumed', 'continued', 'forked']
const SAVED_STATES: readonly SavedState[] = ['lastUsed', 'pending']
const ALL_DISPOSITIONS: readonly TerminalStartupResult['disposition'][] = ['created', ...EXISTING_DISPOSITIONS]
const efforts = (...ids: string[]) => ({ efforts: ids.map(id => ({ id, name: id })) })
const GROUPS: ModelCatalog['groups'] = [
  {
    id: 'server', name: 'Configured server',
    models: ['configured-before', 'configured-after'].map(id => ({
      id, name: id, reasoning: efforts('low', 'high', 'max'),
    })),
  },
  {
    id: 'saved', name: 'Session routes',
    models: ['logged', 'pending'].map(id => ({
      id, name: id, reasoning: efforts('minimal', 'low', 'medium', 'high'),
    })),
  },
  { id: 'cli', name: 'Explicit route', models: [{ id: 'override', name: 'Override', reasoning: efforts('low', 'xhigh') }] },
]

function startupConfig(disposition: TerminalStartupResult['disposition'], cwd: string): TerminalStartupConfig {
  switch (disposition) {
    case 'created': return { cwd }
    case 'resumed': return { cwd, sessionId: SOURCE_ID }
    case 'continued': return { cwd, continueLast: true }
    case 'forked': return { cwd, sessionId: SOURCE_ID, fork: true }
  }
}

/** Fail rather than accidentally submitting work through the inert Agent fixture. */
function unexpectedAgentWork(): never {
  throw new Error('startup model-selection tests must not drive an Agent')
}

function inertAgent(ctx: Context, session: Session): Agent {
  return {
    id: session.id, session, ctx, options: {}, status: 'idle',
    inbox: {
      nextTurn: [], nextStep: [], clear: unexpectedAgentWork,
      append: unexpectedAgentWork, prepend: unexpectedAgentWork,
      replace: unexpectedAgentWork, remove: unexpectedAgentWork, splice: unexpectedAgentWork,
    },
    cancel: unexpectedAgentWork, whenIdle: unexpectedAgentWork,
    runMaintenance: unexpectedAgentWork, send: unexpectedAgentWork,
    followup: unexpectedAgentWork, steer: unexpectedAgentWork, inject: unexpectedAgentWork,
  }
}

function installFixture(ctx: Context, cwd: string) {
  const sessions = new SessionStore(ctx)
  const projections = new SessionProjectionRegistry(ctx)
  installModelSelectionProjection(ctx)
  const actions: string[] = []
  const selections: SessionSelectModelRequest[] = []
  let serverDefault = INITIAL_DEFAULT

  function session(id: SessionId): Session {
    const found = sessions.get(id)
    if (found === undefined) throw new Error(`missing fixture session: ${id}`)
    return found
  }

  const controller: StartupController = {
    async create(request) {
      actions.push(request.sessionId === undefined ? 'create' : 'attach')
      if (request.workspaceId !== WORKSPACE_ID) throw new Error('unexpected fixture workspace')
      const created = request.sessionId === undefined
        ? sessions.create(CREATED_ID, { meta: { cwd } })
        : session(request.sessionId)
      return { sessionId: created.id }
    },
    async resolveAgent(id) {
      actions.push('resolve')
      return { agent: inertAgent(ctx, session(id)) }
    },
    async list(_request, signal) {
      signal.throwIfAborted()
      actions.push('list')
      return {
        items: sessions.list().map(item => ({
          sessionId: item.id, cwd: item.header.cwd,
          updatedAt: item.header.createdAt, running: false, blank: item.seq === 0,
        })),
      }
    },
    async fork(request) {
      actions.push('fork')
      const source = session(request.sessionId)
      const boundary = source.snapshotEvents().findLast(event => event.type === 'turn/end')
      if (boundary === undefined) throw new Error('fixture fork requires a completed turn')
      return { sessionId: sessions.fork(source, boundary.seq, CHILD_ID).id }
    },
    async modelCatalog() {
      actions.push('catalog')
      return { default: serverDefault, groups: GROUPS, routableProviders: ['server', 'saved', 'cli'], failures: [] }
    },
    async selectModel(request) {
      actions.push('select')
      selections.push({ ...request })
      const { sessionId, ...selected } = request
      session(sessionId).append('model/selection', selected)
      return { selected }
    },
  }
  const workspaceController: Pick<Context['workspaceController'], 'create'> = {
    async create(request) {
      actions.push('workspace')
      if (request.path !== cwd) throw new Error('startup escaped its temporary cwd')
      return {
        created: true,
        workspace: {
          workspaceId: WORKSPACE_ID, path: cwd, title: 'Startup fixture', sessionIds: [],
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        },
      }
    },
  }
  const defaults: Pick<Context['agentDefaultModel'], 'currentSelection'> = {
    currentSelection() {
      actions.push('default')
      return serverDefault
    },
  }
  // Cordis permits partial service injection; each fixture above is checked
  // against the exact production methods rather than cast to a full service.
  ctx.provide('sessionController', controller)
  ctx.provide('workspaceController', workspaceController)
  ctx.provide('agentDefaultModel', defaults)

  function seed(saved: SavedState): Session {
    const source = sessions.create(SOURCE_ID, { meta: { cwd } })
    source.append('turn/start', { turn: 1 })
    source.append('request/header', {
      header: {
        config: {
          provider: LOGGED.provider, model: LOGGED.model,
          reasoningEffort: ReasoningEffortId('low'),
        },
      },
      reason: 'initial',
    })
    // A selection made during the completed turn is included in a fork prefix.
    if (saved === 'pending') source.append('model/selection', PENDING)
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    return source
  }

  return {
    ctx, cwd, sessions, projections, actions, selections, session, seed,
    changeDefault() { serverDefault = CHANGED_DEFAULT },
  }
}

type Fixture = ReturnType<typeof installFixture>

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp('/tmp/lyapunov-startup-model-')
  const ctx = new Context()
  try {
    await run(installFixture(ctx, cwd))
  } finally {
    try {
      // SessionStore owns every in-memory Session through Cordis effects.
      await ctx.fiber.dispose()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }
}

function savedSelection(saved: SavedState): ModelSelection {
  return saved === 'pending' ? PENDING : LOGGED
}

function savedProjection(saved: SavedState): ModelSelectionProjectionState {
  return { lastUsed: LOGGED, pending: saved === 'pending' ? PENDING : null }
}

describe('startTerminalSession model selection (offline injected controllers, native Session projection)', () => {
  test('a created session selects the current configured default with its highest catalog effort', () => withFixture(async h => {
    h.changeDefault()
    const result = await startTerminalSession(h.ctx, { cwd: h.cwd })
    const selected = { ...CHANGED_DEFAULT, reasoningEffort: 'max' }
    expect(result).toEqual({ sessionId: CREATED_ID, disposition: 'created', cwd: h.cwd, selectedModel: selected })
    expect(h.selections).toEqual([{ sessionId: CREATED_ID, ...selected }])
    expect(h.projections.stateOf(h.session(CREATED_ID), 'modelSelection')).toEqual({ lastUsed: null, pending: selected })
    expect(h.actions).toEqual(['workspace', 'create', 'resolve', 'default', 'catalog', 'select'])
  }))

  for (const disposition of EXISTING_DISPOSITIONS) {
    for (const saved of SAVED_STATES) {
      test(`${disposition} keeps ${saved} after the server default changes without selecting again`, () => withFixture(async h => {
        const source = h.seed(saved)
        const originalEvents = source.snapshotEvents()
        expect(h.projections.stateOf(source, 'modelSelection')).toEqual(savedProjection(saved))
        h.changeDefault()

        const result = await startTerminalSession(h.ctx, startupConfig(disposition, h.cwd))
        const expectedId = disposition === 'forked' ? CHILD_ID : SOURCE_ID
        expect(result).toEqual({
          sessionId: expectedId, disposition, cwd: h.cwd,
          selectedModel: savedSelection(saved),
          ...(disposition === 'forked' ? { sourceSessionId: SOURCE_ID } : {}),
        })
        expect(h.projections.stateOf(h.session(expectedId), 'modelSelection')).toEqual(savedProjection(saved))
        expect(h.selections).toEqual([])
        expect(h.actions).not.toContain('catalog')
        expect(h.actions).not.toContain('default')
        expect(source.snapshotEvents()).toEqual(originalEvents)
        expect(h.actions).toEqual([
          ...(disposition === 'resumed' ? [] : ['list']),
          ...(disposition === 'forked' ? ['fork'] : []),
          'resolve', 'workspace', 'attach',
        ])
        if (disposition === 'forked') {
          expect(h.session(expectedId).header.parentSession).toBe(SOURCE_ID)
          expect([...h.session(expectedId).snapshotEvents().slice(0, originalEvents.length)]).toEqual([...originalEvents])
        }
      }))
    }
  }

  for (const disposition of ALL_DISPOSITIONS) {
    test(`${disposition} honors an explicit model override instead of the saved route or server default`, () => withFixture(async h => {
      const source = disposition === 'created' ? undefined : h.seed('pending')
      const originalEvents = source?.snapshotEvents()
      h.changeDefault()
      const result = await startTerminalSession(h.ctx, {
        ...startupConfig(disposition, h.cwd), provider: EXPLICIT.provider, model: EXPLICIT.model,
      })
      const expectedId = disposition === 'created' ? CREATED_ID : disposition === 'forked' ? CHILD_ID : SOURCE_ID
      const selected = { ...EXPLICIT, reasoningEffort: 'xhigh' }
      expect(result.disposition).toBe(disposition)
      expect(result.sessionId).toBe(expectedId)
      expect(result.selectedModel).toEqual(selected)
      expect(h.selections).toEqual([{ sessionId: expectedId, ...selected }])
      expect(h.actions.filter(action => action === 'catalog')).toEqual(['catalog'])
      expect(h.projections.stateOf(h.session(expectedId), 'modelSelection')).toEqual({
        lastUsed: disposition === 'created' ? null : LOGGED, pending: selected,
      })
      if (disposition === 'forked') expect(source?.snapshotEvents()).toEqual(originalEvents)
    }))
  }

  for (const disposition of EXISTING_DISPOSITIONS) {
    for (const saved of SAVED_STATES) {
      test(`${disposition} reasoning-only override retains the ${saved} provider/model route`, () => withFixture(async h => {
        const source = h.seed(saved)
        const originalEvents = source.snapshotEvents()
        h.changeDefault()
        const result = await startTerminalSession(h.ctx, {
          ...startupConfig(disposition, h.cwd), reasoningEffort: 'minimal',
        })
        const expectedId = disposition === 'forked' ? CHILD_ID : SOURCE_ID
        const selected = { ...savedSelection(saved), reasoningEffort: 'minimal' }
        expect(result.disposition).toBe(disposition)
        expect(result.selectedModel).toEqual(selected)
        expect(h.selections).toEqual([{ sessionId: expectedId, ...selected }])
        expect(h.actions).not.toContain('default')
        expect(h.projections.stateOf(h.session(expectedId), 'modelSelection')).toEqual({ lastUsed: LOGGED, pending: selected })
        if (disposition === 'forked') expect(source.snapshotEvents()).toEqual(originalEvents)
      }))
    }
  }

  // Startup validates pair completeness before cwd/controller work. Unsupported
  // complete routes are validated later and are not a pre-side-effect guarantee.
  const incompletePairs: readonly TerminalStartupConfig[] = [{ provider: 'cli' }, { model: 'override' }]
  for (const pair of incompletePairs) {
    test(`rejects ${pair.provider === undefined ? 'model-only' : 'provider-only'} before filesystem lookup or controller effects`, () => withFixture(async h => {
      await expect(startTerminalSession(h.ctx, { ...pair, cwd: join(h.cwd, 'does-not-exist') }))
        .rejects.toThrow('启动模型需要同时提供 provider 和 model。')
      expect(h.actions).toEqual([])
      expect(h.selections).toEqual([])
      expect(h.sessions.list()).toEqual([])
    }))
  }
})
