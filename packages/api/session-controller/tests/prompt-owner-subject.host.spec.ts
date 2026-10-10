/**
 * Prompt admission drives the admitted agent-loop turn under the Session
 * owner's verified subject, through the process-global caller-subject runner
 * slot: an owned Session's tool calls observe their own owner (never another
 * subject's ambient dispatch), and an ownerless Session observes no subject.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import AttachmentStore from '@deepseek-ai/dsh-attachment'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createScope } from '@deepseek-ai/dsh-scope'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { currentCallerSubject } from '../src/caller-subject.ts'
import type { SessionRequestId } from '../src/types.ts'

const READER_SLOT = Symbol.for('dsh.session-controller.callerSubjectReader')
const RUNNER_SLOT = Symbol.for('dsh.session-controller.callerSubjectRunner')

function clearSlots(): void {
  const store = globalThis as Record<symbol, unknown>
  Reflect.deleteProperty(store, READER_SLOT)
  Reflect.deleteProperty(store, RUNNER_SLOT)
}

afterEach(clearSlots)

/**
 * Publish an AsyncLocalStorage-backed reader/runner bridge on both slots, the
 * same contract client-connection publishes in its apply.
 */
function publishSubjectBridge(): void {
  const storage = new AsyncLocalStorage<{ subject: string | undefined }>()
  const store = globalThis as Record<symbol, unknown>
  store[READER_SLOT] = () => storage.getStore()
  store[RUNNER_SLOT] = <T>(subject: string | undefined, operation: () => T): T =>
    storage.run({ subject }, operation)
}

async function promptHarness(owner?: string): Promise<{
  controller: SessionCommandController
  sessionId: SessionId
  observed: (string | undefined)[]
  steerObserved: (string | undefined)[]
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  const sessionId = SessionId(`prompt-${owner ?? 'ownerless'}`)
  const session = ctx.sessions.create(sessionId, {
    meta: { cwd: '/workspace', ...(owner === undefined ? {} : { owner }) },
  })
  const observed: (string | undefined)[] = []
  const steerObserved: (string | undefined)[] = []
  const agent = {
    id: session.id,
    session,
    inbox: createInboxStub(),
    status: 'idle',
    ctx: undefined,
    steer: vi.fn(() => { steerObserved.push(currentCallerSubject()) }),
    followup: vi.fn(() => { observed.push(currentCallerSubject()) }),
    cancel: vi.fn(),
  } as unknown as Agent
  ;(agent as { ctx: Context }).ctx = createScope(ctx, agent).ctx
  await ctx.agents.register(agent)
  ctx.provide('attachments', Object.setPrototypeOf({}, AttachmentStore.prototype) as never)
  ctx.provide('connection', {
    fetch: { register: () => () => {} },
  } as never)
  ctx.provide('llm', {
    listProviders: () => [{ id: 'fixture', name: 'Fixture' }],
    resolveModelInfo: () => Promise.resolve({ provider: 'fixture', id: 'fixture-model', name: 'Fixture' }),
  } as never)
  new FileUploads(ctx)
  const selection: ModelSelectionRef = {
    current: { provider: 'fixture', model: 'fixture-model' },
    assembled: undefined,
  }
  const agents = {
    resolveAgent: () => Promise.resolve({ agent }),
    selectionFor: () => selection,
    serializeImageAdmission: <Value>(_agent: Agent, operation: () => Promise<Value>) => operation(),
  } as unknown as ApiSessionAgentController
  return {
    controller: new SessionCommandController(ctx, agents, '/workspace'),
    sessionId,
    observed,
    steerObserved,
  }
}

function promptRequest(
  sessionId: SessionId,
  mode: 'queue' | 'steer',
): Parameters<SessionCommandController['prompt']>[0] {
  return {
    requestId: `req-${mode}-${String(sessionId)}` as SessionRequestId,
    sessionId,
    mode,
    content: [{ type: 'text', text: 'hello' }],
  }
}

describe('prompt admission caller-subject wrap', () => {
  it("runs owner A's admitted turn under A's subject", async () => {
    publishSubjectBridge()
    const { controller, sessionId, observed } = await promptHarness('alice@example.com')
    await expect(controller.prompt(promptRequest(sessionId, 'queue'))).resolves.toEqual({ accepted: true })
    expect(observed).toEqual(['alice@example.com'])
  })

  it("runs owner B's admitted turn under B's subject even inside another dispatch", async () => {
    publishSubjectBridge()
    const { controller, sessionId, observed } = await promptHarness('bob@example.com')
    const store = globalThis as Record<symbol, unknown>
    const runner = store[RUNNER_SLOT] as <T>(subject: string | undefined, operation: () => T) => T
    // An ambient dispatch of a third subject must not bleed into the owned turn.
    await runner('mallory@example.com', () => controller.prompt(promptRequest(sessionId, 'queue')))
    expect(observed).toEqual(['bob@example.com'])
  })

  it('runs an ownerless admitted turn with no subject', async () => {
    publishSubjectBridge()
    const { controller, sessionId, observed } = await promptHarness()
    await expect(controller.prompt(promptRequest(sessionId, 'queue'))).resolves.toEqual({ accepted: true })
    expect(observed).toEqual([undefined])
  })

  it('wraps steering admissions under the owner subject as well', async () => {
    publishSubjectBridge()
    const { controller, sessionId, steerObserved } = await promptHarness('alice@example.com')
    await expect(controller.prompt(promptRequest(sessionId, 'steer'))).resolves.toEqual({ accepted: true })
    expect(steerObserved).toEqual(['alice@example.com'])
  })

  it('admits unchanged when no runner is published (single-operator process)', async () => {
    const { controller, sessionId, observed } = await promptHarness('alice@example.com')
    await expect(controller.prompt(promptRequest(sessionId, 'queue'))).resolves.toEqual({ accepted: true })
    expect(observed).toEqual([undefined])
  })

  it('admits unchanged when the runner slot holds a non-function value', async () => {
    const store = globalThis as Record<symbol, unknown>
    store[RUNNER_SLOT] = 'not-a-runner'
    const { controller, sessionId, observed } = await promptHarness('alice@example.com')
    await expect(controller.prompt(promptRequest(sessionId, 'queue'))).resolves.toEqual({ accepted: true })
    expect(observed).toEqual([undefined])
  })
})
