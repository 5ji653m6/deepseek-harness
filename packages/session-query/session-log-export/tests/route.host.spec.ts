import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  Config,
  SESSION_LOG_FILENAME,
  SESSION_LOG_EXPORT_PATH,
  apply,
  inject,
} from '../src/index.ts'

const sid = (value: string): SessionId => value as SessionId

function readHandle(id: string): SessionHandle {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: sid(id),
    createdAt: 1,
    isSeeded: false,
    cwd: '/workspace',
    delegationDepth: 0,
  }
  return {
    id: header.id,
    header,
    access: 'read',
    read: async () => ({ eventState: 'detached', events: [] }),
    close: async () => {},
  } as unknown as SessionHandle
}

async function mounted(withServices: boolean): Promise<{
  readonly connection: HostConnectionService
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  ctx.provide('commands', { register: () => () => {} } as never)
  if (withServices) {
    ctx.provide('sessionQuery', {
      traceSession: async () => ({ descendants: [] }),
      observeSession: async (id: SessionId) => ({
        header: readHandle(String(id)).header,
        inheritedEventCount: 0,
        events: [],
        projections: undefined,
        [Symbol.dispose]: () => {},
      }),
    } as never)
    ctx.provide('sessionPersistence', {
      stat: async (id: SessionId) => ({ header: readHandle(String(id)).header }),
      open: async (id: SessionId) => readHandle(String(id)),
    } as never)
    ctx.provide('attachments', {
      readImage: async () => { throw new Error('fixture has no images') },
    } as never)
  }
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber
  return { connection, dispose: () => fiber.dispose() }
}

describe('Session log export Fetch route', () => {
  it('registers one GET/HEAD route and removes it with the plugin fiber', async () => {
    const { connection, dispose } = await mounted(true)
    const shared = connection.createSharedFetchHandler('/api')

    const response = await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`,
    ))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(strFromU8(files[SESSION_LOG_FILENAME] as Uint8Array)).toContain('"id":"session-1"')

    const head = await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`, { method: 'HEAD' },
    ))
    expect(head.status).toBe(200)
    expect(head.body).toBeNull()

    await dispose()
    expect((await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`,
    ))).status).toBe(404)
  })

  it('validates the query before reporting missing export services', async () => {
    const { connection, dispose } = await mounted(false)
    const shared = connection.createSharedFetchHandler('/api')
    expect((await shared.fetch(new Request(`http://host${SESSION_LOG_EXPORT_PATH}`))).status).toBe(400)
    expect((await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1&includeDescendants=1`,
    ))).status).toBe(400)
    expect((await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`,
    ))).status).toBe(500)
    await dispose()
  })

  it('validates the compression level', () => {
    expect(Config({})).toEqual({ compressionLevel: 6 })
    expect(Config({ compressionLevel: 0 })).toEqual({ compressionLevel: 0 })
    expect(Config({ compressionLevel: 9 })).toEqual({ compressionLevel: 9 })
    for (const compressionLevel of [-1, 10, 1.5]) {
      expect(() => Config({ compressionLevel } as never)).toThrow()
    }
  })

  it('exports owned Sessions for their subject and hides foreign ones', async () => {
    const SLOT = Symbol.for('dsh.session-controller.callerSubjectReader')
    const store = globalThis as Record<symbol, unknown>
    const ownedHeader = { ...readHandle('session-1').header, owner: 'alice@example.com' }
    const ctx = new Context()
    ctx.provide('commands', { register: () => () => {} } as never)
    ctx.provide('sessionQuery', {
      traceSession: async () => ({ descendants: [] }),
      observeSession: async () => ({
        header: ownedHeader,
        inheritedEventCount: 0,
        events: [],
        projections: undefined,
        [Symbol.dispose]: () => {},
      }),
    } as never)
    ctx.provide('sessionPersistence', {
      stat: async () => ({ header: ownedHeader }),
      open: async () => readHandle('session-1'),
    } as never)
    ctx.provide('attachments', {
      readImage: async () => { throw new Error('fixture has no images') },
    } as never)
    const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber
    const shared = connection.createSharedFetchHandler('/api')
    const url = `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`

    try {
      // Internal work (no browser dispatch) keeps full access.
      Reflect.deleteProperty(store, SLOT)
      expect((await shared.fetch(new Request(url))).status).toBe(200)

      // The owning subject exports; another subject reads 404 silence.
      store[SLOT] = () => ({ subject: 'alice@example.com' })
      expect((await shared.fetch(new Request(url))).status).toBe(200)
      store[SLOT] = () => ({ subject: 'bob@example.com' })
      expect((await shared.fetch(new Request(url))).status).toBe(404)
      store[SLOT] = () => ({ subject: undefined })
      expect((await shared.fetch(new Request(url))).status).toBe(404)
    } finally {
      Reflect.deleteProperty(store, SLOT)
      await fiber.dispose()
    }
  })

  it('hides ownerless Sessions from a browser dispatch', async () => {
    const SLOT = Symbol.for('dsh.session-controller.callerSubjectReader')
    const store = globalThis as Record<symbol, unknown>
    const { connection, dispose } = await mounted(true)
    const shared = connection.createSharedFetchHandler('/api')

    try {
      store[SLOT] = () => ({ subject: 'alice@example.com' })
      expect((await shared.fetch(new Request(
        `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`,
      ))).status).toBe(404)
    } finally {
      Reflect.deleteProperty(store, SLOT)
      await dispose()
    }
  })

  it('answers 500 without echoing internals when observing the Session fails', async () => {
    const ctx = new Context()
    ctx.provide('commands', { register: () => () => {} } as never)
    ctx.provide('sessionQuery', {
      traceSession: async () => ({ descendants: [] }),
      observeSession: async () => { throw new Error('/host/private/index corrupt') },
    } as never)
    ctx.provide('sessionPersistence', {
      stat: async (id: SessionId) => ({ header: readHandle(String(id)).header }),
      open: async (id: SessionId) => readHandle(String(id)),
    } as never)
    ctx.provide('attachments', {
      readImage: async () => { throw new Error('fixture has no images') },
    } as never)
    const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber
    const shared = connection.createSharedFetchHandler('/api')

    const response = await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`,
    ))
    expect(response.status).toBe(500)
    expect(await response.text()).toBe('session log export failed to read the stored log')
    await fiber.dispose()
  })

  it('answers 404 when the observed Session has no durable log', async () => {
    const ctx = new Context()
    ctx.provide('commands', { register: () => () => {} } as never)
    ctx.provide('sessionQuery', {
      traceSession: async () => ({ descendants: [] }),
      observeSession: async (id: SessionId) => ({
        header: readHandle(String(id)).header,
        inheritedEventCount: 0,
        events: [],
        projections: undefined,
        [Symbol.dispose]: () => {},
      }),
    } as never)
    ctx.provide('sessionPersistence', {
      stat: async () => undefined,
      open: async (id: SessionId) => { throw new SessionPersistenceNotFoundError(id) },
    } as never)
    ctx.provide('attachments', {
      readImage: async () => { throw new Error('fixture has no images') },
    } as never)
    const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber
    const shared = connection.createSharedFetchHandler('/api')

    const response = await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`,
    ))
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('session not found')
    await fiber.dispose()
  })
})
