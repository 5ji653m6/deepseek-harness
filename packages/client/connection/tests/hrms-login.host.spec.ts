/**
 * HRMS per-user login: Frappe token verification, the server-side token
 * vault, the per-request header source, and the login/logout routes —
 * including the subject-carrying cookie round trip.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserAuth } from '../src/browser-auth.ts'
import type { ConnectionTrustRequest } from '../src/rpc.ts'
import {
  assertHrmsBaseUrl,
  createHrmsLoginHandler,
  createHrmsLogoutHandler,
  hrmsHeaderSource,
  HrmsIdentityVerifier,
  HrmsSessionTokenVault,
} from '../src/hrms-login.ts'
import { RecordCredentials } from './browser-credentials.ts'

const AUTHORITY = '127.0.0.1:3080'

function trustRequest(cookie?: string): ConnectionTrustRequest {
  return {
    headers: cookie === undefined
      ? { host: AUTHORITY }
      : { host: AUTHORITY, cookie },
  }
}

function cookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0]!
}

async function createAuth(): Promise<BrowserAuth> {
  return BrowserAuth.create({}, new RecordCredentials() as never, 30)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('subject-carrying browser cookie', () => {
  it('round-trips the verified subject and stays authenticated', async () => {
    const auth = await createAuth()
    const setCookie = auth.subjectSessionCookie(AUTHORITY, 'user@example.com')
    expect(setCookie).toMatch(/; HttpOnly; SameSite=Strict$/u)
    const pair = cookiePair(setCookie)

    expect(auth.isAuthenticated(trustRequest(pair))).toBe(true)
    expect(auth.authenticatedSubject(trustRequest(pair))).toBe('user@example.com')
    // Wrong authority binds nothing.
    expect(auth.authenticatedSubject({
      headers: { host: '127.0.0.1:3081', cookie: pair },
    })).toBeUndefined()
  })

  it('keeps legacy process-token cookies decoding with no subject', async () => {
    const auth = await createAuth()
    const launchUrl = auth.authenticatedUrl(`http://${AUTHORITY}`)
    const exchanged = new URL(launchUrl)
    const res: { status?: number; headers?: Record<string, string> } = {}
    auth.authorizeIndex(
      {
        method: 'GET',
        url: `${exchanged.pathname}${exchanged.search}`,
        headers: { host: AUTHORITY },
      },
      {
        writeHead(status, headers) {
          res.status = status
          res.headers = headers as Record<string, string>
        },
        end() {},
      },
    )
    const pair = cookiePair(res.headers!['set-cookie']!)

    expect(auth.isAuthenticated(trustRequest(pair))).toBe(true)
    expect(auth.authenticatedSubject(trustRequest(pair))).toBeUndefined()
  })

  it('rejects a cookie whose subject is not a string', async () => {
    const { createHmac } = await import('node:crypto')
    const store = new RecordCredentials()
    const auth = await BrowserAuth.create({}, store as never, 30)
    const record = store.record
    if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
      throw new Error('test credential store has no signing secret')
    }
    const secret: unknown = Reflect.get(record.payload, 'secret')
    if (typeof secret !== 'string') throw new Error('test credential record has no string secret')
    const body = Buffer.from(JSON.stringify({
      version: 1,
      authority: AUTHORITY,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      subject: 42,
    }), 'utf8').toString('base64url')
    const signature = createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest('base64url')
    const name = cookiePair(auth.subjectSessionCookie(AUTHORITY, 'user@example.com')).split('=', 1)[0]!

    expect(auth.isAuthenticated(trustRequest(`${name}=v1.${body}.${signature}`))).toBe(false)
  })

  it('clears the session cookie idempotently', async () => {
    const auth = await createAuth()
    const cleared = auth.clearedSessionCookie(AUTHORITY)
    expect(cleared).toMatch(/^dsh-auth-[A-Za-z0-9_-]+=; Max-Age=0;/u)
    const pair = cookiePair(cleared)
    expect(auth.isAuthenticated(trustRequest(pair))).toBe(false)
  })
})

describe('HrmsIdentityVerifier', () => {
  it('fails loud on a malformed configured base URL', () => {
    expect(() => assertHrmsBaseUrl('not a url')).toThrow(/not a valid URL/u)
    expect(() => assertHrmsBaseUrl('ftp://hrms.example.com')).toThrow(/http or https/u)
    expect(assertHrmsBaseUrl('https://hrms.example.com').href).toBe('https://hrms.example.com/')
  })

  it('confirms the subject Frappe reports through get_logged_user', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'User@Example.com' }),
      { status: 200 },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const verifier = new HrmsIdentityVerifier(new URL('https://hrms.example.com'))

    await expect(verifier.verify('user@example.com', 'key:secret', new AbortController().signal))
      .resolves.toBe('User@Example.com')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.href).toBe('https://hrms.example.com/api/method/frappe.auth.get_logged_user')
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>).authorization).toBe('token key:secret')
  })

  it('returns undefined for mismatch, failure, and unreadable responses', async () => {
    const verifier = new HrmsIdentityVerifier(new URL('https://hrms.example.com'))
    const cases: Array<() => Promise<unknown>> = [
      () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
          JSON.stringify({ message: 'someone-else@example.com' }), { status: 200 },
        )))
        return verifier.verify('user@example.com', 'key:secret', new AbortController().signal)
      },
      () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })))
        return verifier.verify('user@example.com', 'key:secret', new AbortController().signal)
      },
      () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 200 })))
        return verifier.verify('user@example.com', 'key:secret', new AbortController().signal)
      },
      () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
        return verifier.verify('user@example.com', 'key:secret', new AbortController().signal)
      },
    ]
    for (const run of cases) {
      await expect(run()).resolves.toBeUndefined()
    }
  })
})

describe('HrmsSessionTokenVault and header source', () => {
  it('binds token pairs to subjects case-insensitively and drops them on logout', () => {
    const vault = new HrmsSessionTokenVault()
    vault.store('User@Example.com', 'key:secret')
    expect(vault.lookup('user@example.com')).toBe('key:secret')
    vault.store('user@example.com', 'new:pair')
    expect(vault.lookup('USER@EXAMPLE.COM')).toBe('new:pair')
    vault.remove('user@example.com')
    expect(vault.lookup('user@example.com')).toBeUndefined()
  })

  it('resolves X-HRMS headers from the subject and its held pair, none for the ownerless path', () => {
    const vault = new HrmsSessionTokenVault()
    const source = hrmsHeaderSource(vault)
    expect(source.resolveFor(undefined)).toEqual({})
    vault.store('user@example.com', 'key:secret')
    expect(source.resolveFor('user@example.com')).toEqual({
      'X-HRMS-User': 'user@example.com',
      'X-HRMS-User-Token': 'key:secret',
    })
    // A subject whose pair was never stored still presents its email with an
    // empty token — the deployed Track 1 contract for missing credentials.
    expect(source.resolveFor('other@example.com')).toEqual({
      'X-HRMS-User': 'other@example.com',
      'X-HRMS-User-Token': '',
    })
  })
})

describe('HRMS login and logout routes', () => {
  function loginRequest(body: unknown, cookie?: string): Request {
    return new Request(`http://${AUTHORITY}/api/hrms/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'host': AUTHORITY,
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify(body),
    })
  }

  it('verifies, stores the pair server-side, and issues the subject cookie', async () => {
    const auth = await createAuth()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'user@example.com' }), { status: 200 },
    )))
    const verifier = new HrmsIdentityVerifier(new URL('https://hrms.example.com'))
    const vault = new HrmsSessionTokenVault()
    const handler = createHrmsLoginHandler(auth, verifier, vault)

    const response = await handler.fetch(loginRequest({ email: ' user@example.com ', token: ' key:secret ' }))
    expect(response.status).toBe(204)
    const setCookie = response.headers.get('set-cookie')!
    expect(setCookie).toMatch(/; HttpOnly; SameSite=Strict$/u)
    expect(vault.lookup('user@example.com')).toBe('key:secret')
    const pair = cookiePair(setCookie)
    expect(auth.authenticatedSubject(trustRequest(pair))).toBe('user@example.com')
  })

  it('answers every failure class with the same plain 401', async () => {
    const auth = await createAuth()
    const verifier = new HrmsIdentityVerifier(new URL('https://hrms.example.com'))
    const vault = new HrmsSessionTokenVault()
    const handler = createHrmsLoginHandler(auth, verifier, vault)

    // Verification mismatch.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'other@example.com' }), { status: 200 },
    )))
    const rejected = await handler.fetch(loginRequest({ email: 'user@example.com', token: 'key:secret' }))
    expect(rejected.status).toBe(401)
    expect(rejected.headers.get('cache-control')).toBe('no-store')
    expect(vault.lookup('user@example.com')).toBeUndefined()

    // Unusable bodies and methods fail identically, without spending the verifier.
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    for (const request of [
      loginRequest({ email: 'user@example.com' }),
      loginRequest({ email: 'not-an-email', token: 'key:secret' }),
      loginRequest({ email: 'user@example.com', token: 'nocolon' }),
      new Request(`http://${AUTHORITY}/api/hrms/login`, { method: 'GET', headers: { host: AUTHORITY } }),
    ]) {
      expect((await handler.fetch(request)).status).toBe(401)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('declares a buffered request body on both routes', async () => {
    const auth = await createAuth()
    const verifier = new HrmsIdentityVerifier(new URL('https://hrms.example.com'))
    const vault = new HrmsSessionTokenVault()
    const login = createHrmsLoginHandler(auth, verifier, vault)
    const logout = createHrmsLogoutHandler(auth, vault)

    expect(login.requestBodyMode({
      method: 'POST', url: new URL(`http://${AUTHORITY}/api/hrms/login`),
    })).toBe('buffered')
    expect(logout.requestBodyMode({
      method: 'POST', url: new URL(`http://${AUTHORITY}/api/hrms/logout`),
    })).toBe('buffered')
  })

  it('rejects malformed login bodies identically, without spending the verifier', async () => {
    const auth = await createAuth()
    const verifier = new HrmsIdentityVerifier(new URL('https://hrms.example.com'))
    const vault = new HrmsSessionTokenVault()
    const handler = createHrmsLoginHandler(auth, verifier, vault)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const wrongMediaType = new Request(`http://${AUTHORITY}/api/hrms/login`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'host': AUTHORITY },
      body: JSON.stringify({ email: 'user@example.com', token: 'key:secret' }),
    })
    const invalidJson = new Request(`http://${AUTHORITY}/api/hrms/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'host': AUTHORITY },
      body: 'not json',
    })
    for (const request of [
      wrongMediaType,
      invalidJson,
      loginRequest('just-a-string'),
      loginRequest(null),
      loginRequest(['user@example.com', 'key:secret']),
    ]) {
      expect((await handler.fetch(request)).status).toBe(401)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('logout rejects non-POST methods and clears no cookie without an authority', async () => {
    const auth = await createAuth()
    const vault = new HrmsSessionTokenVault()
    vault.store('user@example.com', 'key:secret')
    const handler = createHrmsLogoutHandler(auth, vault)

    const get = await handler.fetch(new Request(`http://${AUTHORITY}/api/hrms/logout`, {
      method: 'GET',
      headers: { host: AUTHORITY },
    }))
    expect(get.status).toBe(401)
    expect(vault.lookup('user@example.com')).toBe('key:secret')

    // No Host header: still 204, but no authority-bound cookie can be cleared.
    const noAuthority = await handler.fetch(new Request(`http://${AUTHORITY}/api/hrms/logout`, {
      method: 'POST',
    }))
    expect(noAuthority.status).toBe(204)
    expect(noAuthority.headers.get('set-cookie')).toBeNull()
  })

  it('logout drops the held pair and clears the cookie', async () => {
    const auth = await createAuth()
    const vault = new HrmsSessionTokenVault()
    vault.store('user@example.com', 'key:secret')
    const setCookie = auth.subjectSessionCookie(AUTHORITY, 'user@example.com')
    const handler = createHrmsLogoutHandler(auth, vault)

    const response = await handler.fetch(new Request(`http://${AUTHORITY}/api/hrms/logout`, {
      method: 'POST',
      headers: { host: AUTHORITY, cookie: cookiePair(setCookie) },
    }))
    expect(response.status).toBe(204)
    expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/u)
    expect(vault.lookup('user@example.com')).toBeUndefined()

    // Idempotent without a cookie: still 204, nothing held to drop.
    const anonymous = await handler.fetch(new Request(`http://${AUTHORITY}/api/hrms/logout`, {
      method: 'POST',
      headers: { host: AUTHORITY },
    }))
    expect(anonymous.status).toBe(204)
  })
})
