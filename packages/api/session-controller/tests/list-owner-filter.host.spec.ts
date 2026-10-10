/**
 * Corpus listing filter: a browser dispatch lists only Sessions it owns
 * (the ownerless process-token path lists ownerless Sessions); internal Host
 * work lists the full corpus.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import { ApiSessionList } from '../src/list.ts'

const SLOT = Symbol.for('dsh.session-controller.callerSubjectReader')

function header(id: string, owner?: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: id as SessionId,
    createdAt: 1,
    isSeeded: false,
    cwd: '/workspace',
    ...(owner === undefined ? {} : { owner }),
  }
}

function fakeCtx(headers: SessionHeader[]): Context {
  return {
    sessionProjections: { register: vi.fn() },
    inject: vi.fn(),
    get: () => undefined,
    logger: { warn: vi.fn() },
    sessionQuery: {
      listSessions: async () => headers.map(recordHeader => ({ header: recordHeader })),
    },
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
  } as unknown as Context
}

function publish(subject: string | undefined | null): void {
  const store = globalThis as Record<symbol, unknown>
  if (subject === null) {
    Reflect.deleteProperty(store, SLOT)
    return
  }
  store[SLOT] = () => ({ subject })
}

afterEach(() => {
  publish(null)
})

describe('ApiSessionList ownership filter', () => {
  const corpus = [
    header('session-alice', 'alice@example.com'),
    header('session-bob', 'bob@example.com'),
    header('session-shared'),
  ]

  it('lists the full corpus for internal Host work', async () => {
    publish(null)
    const list = new ApiSessionList(fakeCtx(corpus))
    const items = await list.list()
    expect(items.map(item => item.sessionId)).toEqual([
      'session-alice',
      'session-bob',
      'session-shared',
    ])
  })

  it('lists only owned Sessions for a subject dispatch', async () => {
    publish('alice@example.com')
    const list = new ApiSessionList(fakeCtx(corpus))
    const items = await list.list()
    expect(items.map(item => item.sessionId)).toEqual(['session-alice'])
  })

  it('lists only ownerless Sessions for the process-token dispatch', async () => {
    publish(undefined)
    const list = new ApiSessionList(fakeCtx(corpus))
    const items = await list.list()
    expect(items.map(item => item.sessionId)).toEqual(['session-shared'])
  })
})
