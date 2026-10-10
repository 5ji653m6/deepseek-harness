/**
 * Per-request request-header resolution for the streamable-http MCP
 * transport: `resolveRequestHeaders` is consulted when each request is
 * issued, with the caller subject active at that moment, so concurrent owners
 * sharing one connection each present only their own `X-HRMS-*` headers and
 * the ownerless path presents none. Absent resolver keeps the static
 * `config.headers` behavior byte-identical.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/client'
import type { StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client'
import { createTransport } from '@deepseek-ai/dsh-mcp-client/src/transport.ts'

const SLOT = Symbol.for('dsh.session-controller.callerSubjectReader')

const RUNNER_SLOT = Symbol.for('dsh.session-controller.callerSubjectRunner')

interface CapturedTransport {
  readonly url: URL
  readonly options: StreamableHTTPClientTransportOptions
}

const captured: CapturedTransport[] = []

vi.mock('@modelcontextprotocol/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/client')>()
  return {
    ...actual,
    StreamableHTTPClientTransport: vi.fn(function (url: URL, options: StreamableHTTPClientTransportOptions) {
      captured.push({ url, options })
    }),
  }
})

function publish(subject: string | undefined | null): void {
  const store = globalThis as Record<symbol, unknown>
  if (subject === null) {
    Reflect.deleteProperty(store, SLOT)
    return
  }
  store[SLOT] = () => ({ subject })
}

/** Issue one request through the captured transport's custom fetch. */
async function issue(entry: CapturedTransport, init?: RequestInit): Promise<RequestInit | undefined> {
  const fetchImpl = entry.options.fetch
  if (fetchImpl === undefined) return undefined
  const delegated = vi.fn((_url: string | URL, _init?: RequestInit): Promise<Response> =>
    Promise.resolve(new Response(null, { status: 200 })))
  vi.stubGlobal('fetch', delegated)
  await fetchImpl('https://mcp.example.com/rpc', init)
  return delegated.mock.calls[0]?.[1]
}

afterEach(() => {
  publish(null)
  Reflect.deleteProperty(globalThis, RUNNER_SLOT)
  captured.length = 0
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function streamableHttpConfig(overrides: Partial<StreamableHttpConfig> = {}): StreamableHttpConfig {
  return {
    transport: 'streamable-http',
    serverName: 'fixture',
    url: 'https://mcp.example.com/rpc',
    headers: { 'x-static': 'config-value' },
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    ...overrides,
  }
}

/** Resolver shaped like the wired `hrmsRequestHeaders.resolveFor` source. */
function hrmsResolver() {
  return vi.fn((subject: string | undefined) => subject === undefined
    ? {}
    : { 'X-HRMS-User': subject, 'X-HRMS-User-Token': 'key:secret' })
}

describe('streamable-http transport request headers', () => {
  it('keeps static headers byte-identical when no resolver is configured', () => {
    publish('user@example.com')
    createTransport(streamableHttpConfig())
    expect(captured).toHaveLength(1)
    expect(captured[0]!.options.requestInit?.headers).toEqual({ 'x-static': 'config-value' })
    expect(captured[0]!.options.fetch).toBeUndefined()
  })

  it("presents owner A's headers for A's run on a shared connection", async () => {
    const resolveRequestHeaders = hrmsResolver()
    publish('alice@example.com')
    createTransport(streamableHttpConfig({ resolveRequestHeaders }))

    const sent = await issue(captured[0]!, { headers: { 'x-static': 'config-value' } })
    expect(resolveRequestHeaders).toHaveBeenCalledWith('alice@example.com')
    expect(sent?.headers).toEqual({
      'x-static': 'config-value',
      'X-HRMS-User': 'alice@example.com',
      'X-HRMS-User-Token': 'key:secret',
    })
  })

  it("presents owner B's headers for B's run on the same connection", async () => {
    const resolveRequestHeaders = hrmsResolver()
    publish('alice@example.com')
    createTransport(streamableHttpConfig({ resolveRequestHeaders }))
    const connection = captured[0]!

    publish('bob@example.com')
    const sent = await issue(connection, { headers: { 'x-static': 'config-value' } })
    expect(resolveRequestHeaders).toHaveBeenLastCalledWith('bob@example.com')
    expect(sent?.headers).toEqual({
      'x-static': 'config-value',
      'X-HRMS-User': 'bob@example.com',
      'X-HRMS-User-Token': 'key:secret',
    })
    expect(JSON.stringify(sent?.headers)).not.toContain('alice@example.com')
  })

  it('presents no HRMS headers for the ownerless run on the same connection', async () => {
    const resolveRequestHeaders = hrmsResolver()
    publish('alice@example.com')
    createTransport(streamableHttpConfig({ resolveRequestHeaders }))
    const connection = captured[0]!

    publish(null)
    const sent = await issue(connection, { headers: { 'x-static': 'config-value' } })
    expect(resolveRequestHeaders).toHaveBeenLastCalledWith(undefined)
    expect(sent?.headers).toEqual({ 'x-static': 'config-value' })
  })

  it('observes at request time a subject delivered through the runner slot', async () => {
    const resolveRequestHeaders = hrmsResolver()
    // The contract client-connection publishes and session-controller drives:
    // one AsyncLocalStorage behind both slots, so a runner-wrapped owned turn
    // (prompt admission) is the dispatch the transport's per-request reader
    // observes on every tool-call request.
    const storage = new AsyncLocalStorage<{ subject: string | undefined }>()
    const store = globalThis as Record<symbol, unknown>
    store[SLOT] = () => storage.getStore()
    store[RUNNER_SLOT] = <T>(subject: string | undefined, operation: () => T): T =>
      storage.run({ subject }, operation)
    createTransport(streamableHttpConfig({ resolveRequestHeaders }))
    const connection = captured[0]!
    const run = store[RUNNER_SLOT] as <T>(subject: string | undefined, operation: () => T) => T

    const sent = await run('carol@example.com', () =>
      issue(connection, { headers: { 'x-static': 'config-value' } }))
    expect(resolveRequestHeaders).toHaveBeenLastCalledWith('carol@example.com')
    expect(sent?.headers).toEqual({
      'x-static': 'config-value',
      'X-HRMS-User': 'carol@example.com',
      'X-HRMS-User-Token': 'key:secret',
    })
  })

  it('treats a published reader without an active dispatch, and a non-function slot value, as ownerless', async () => {
    const resolveRequestHeaders = hrmsResolver()
    const store = globalThis as Record<symbol, unknown>
    // Connection is applied but this request runs outside any browser
    // dispatch (startup, timer-driven reconnects).
    store[SLOT] = () => undefined
    createTransport(streamableHttpConfig({ resolveRequestHeaders }))
    const sent = await issue(captured[0]!, { headers: { 'x-static': 'config-value' } })
    expect(resolveRequestHeaders).toHaveBeenLastCalledWith(undefined)
    expect(sent?.headers).toEqual({ 'x-static': 'config-value' })

    publish(null)
    store[SLOT] = 'not-a-reader'
    createTransport(streamableHttpConfig({ resolveRequestHeaders }))
    const sentUnreadable = await issue(captured[1]!, { headers: { 'x-static': 'config-value' } })
    expect(resolveRequestHeaders).toHaveBeenLastCalledWith(undefined)
    expect(sentUnreadable?.headers).toEqual({ 'x-static': 'config-value' })
  })

  it('lets resolver headers override same-named static config headers', async () => {
    publish(null)
    createTransport(streamableHttpConfig({
      resolveRequestHeaders: () => ({ 'x-static': 'resolved-value' }),
    }))
    const sent = await issue(captured[0]!, { headers: { 'x-static': 'config-value' } })
    expect(sent?.headers).toEqual({ 'x-static': 'resolved-value' })
  })

  it('overwrites a static header that collides with a resolved name only by case', async () => {
    // The live deployment carried static empty X-HRMS-* placeholders, and the
    // MCP SDK normalizes init header names to lowercase; the merged request
    // must carry exactly the resolved declared-case value, not fetch's
    // comma-joined pair (`, test1@hualing.com` — still a sidecar 401).
    publish('test1@hualing.com')
    createTransport(streamableHttpConfig({
      resolveRequestHeaders: () => ({ 'X-HRMS-User': 'test1@hualing.com', 'X-HRMS-User-Token': 'key:secret' }),
    }))
    const sent = await issue(captured[0]!, { headers: { 'x-hrms-user': '', 'x-hrms-user-token': '' } })
    expect(sent?.headers).toEqual({ 'X-HRMS-User': 'test1@hualing.com', 'X-HRMS-User-Token': 'key:secret' })
  })

  it('flattens Headers and array header containers at request time', async () => {
    const resolveRequestHeaders = hrmsResolver()
    publish('alice@example.com')
    createTransport(streamableHttpConfig({ resolveRequestHeaders }))

    const fromHeaders = await issue(
      captured[0]!,
      { headers: new Headers({ 'x-static': 'config-value' }) },
    )
    expect(fromHeaders?.headers).toEqual({
      'x-static': 'config-value',
      'X-HRMS-User': 'alice@example.com',
      'X-HRMS-User-Token': 'key:secret',
    })

    publish('bob@example.com')
    const fromArray = await issue(captured[0]!, { headers: [['x-static', 'config-value']] })
    expect(fromArray?.headers).toEqual({
      'x-static': 'config-value',
      'X-HRMS-User': 'bob@example.com',
      'X-HRMS-User-Token': 'key:secret',
    })
  })

  it('resolves headers when the SDK issues a request without an init', async () => {
    const resolveRequestHeaders = hrmsResolver()
    publish('alice@example.com')
    createTransport(streamableHttpConfig({ resolveRequestHeaders }))
    const sent = await issue(captured[0]!)
    expect(resolveRequestHeaders).toHaveBeenCalledWith('alice@example.com')
    expect(sent?.headers).toEqual({
      'X-HRMS-User': 'alice@example.com',
      'X-HRMS-User-Token': 'key:secret',
    })
  })
})
