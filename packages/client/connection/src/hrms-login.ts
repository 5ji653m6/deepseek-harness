/**
 * HRMS per-user login support for the Web GUI: Frappe token-pair
 * verification and the server-side token vault that binds a verified token
 * pair to its subject for per-request MCP headers. Mounted only when the
 * owning plugin's `hrmsBaseUrl` config is present; the token pair is used
 * only to verify against Frappe and is never logged, never placed in a
 * cookie, and never returned in a response body.
 */

import { requestAuthority } from './browser-auth.ts'
import type { BrowserAuth } from './browser-auth.ts'
import type { ConnectionFetchHandler, ConnectionTrustRequest } from './rpc.ts'

/** Exact login route path mounted when `hrmsBaseUrl` is configured. */
export const HRMS_LOGIN_PATH = '/api/hrms/login'
/** Exact logout route path mounted when `hrmsBaseUrl` is configured. */
export const HRMS_LOGOUT_PATH = '/api/hrms/logout'

/** Login request bodies stay far below the shared 300 MiB RPC cap. */
export const HRMS_LOGIN_MAX_BODY_BYTES = 64 * 1024

/** Login request body accepted by the HRMS login route. */
export interface HrmsLoginBody {
  /** Presenter's Frappe user email. */
  readonly email: string
  /** Presenter's own Frappe `api_key:api_secret` token pair. */
  readonly token: string
}

/** Successful Frappe `get_logged_user` response envelope. */
interface FrappeLoggedUserResponse {
  readonly message?: unknown
}

/**
 * Validate the configured HRMS base URL at plugin load.
 * @param value - configured `hrmsBaseUrl`, verbatim.
 * @returns the parsed absolute http(s) URL.
 * @throws when the value is not an absolute http(s) URL.
 */
export function assertHrmsBaseUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new Error(`client-connection: hrmsBaseUrl ${JSON.stringify(value)} is not a valid URL`, { cause })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`client-connection: hrmsBaseUrl ${JSON.stringify(value)} must use http or https`)
  }
  return url
}

/**
 * Verify presented HRMS credentials against Frappe before any identity is
 * issued. Mirrors the deployed sidecar contract: the returned logged-in user
 * must equal the presented email case-insensitively, and failures never
 * reveal which step rejected the login.
 */
export class HrmsIdentityVerifier {
  private readonly verificationUrl: URL

  /**
   * @param baseUrl - validated HRMS base URL (see {@link assertHrmsBaseUrl}).
   */
  constructor(baseUrl: URL) {
    this.verificationUrl = new URL('/api/method/frappe.auth.get_logged_user', baseUrl)
  }

  /**
   * Verify one email + token pair against Frappe's `get_logged_user`.
   * @param email - presented Frappe user email.
   * @param tokenPair - presented `api_key:api_secret` pair.
   * @param signal - cancellation owned by the login request.
   * @returns the canonical subject Frappe confirmed (its logged-in user), or
   *   undefined when verification fails at any step.
   */
  async verify(email: string, tokenPair: string, signal: AbortSignal): Promise<string | undefined> {
    let response: Response
    try {
      response = await fetch(this.verificationUrl, {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'authorization': `token ${tokenPair}`,
        },
        signal,
      })
    } catch {
      return undefined
    }
    if (!response.ok) return undefined
    let body: FrappeLoggedUserResponse
    try {
      body = await response.json() as FrappeLoggedUserResponse
    } catch {
      return undefined
    }
    return typeof body.message === 'string' && body.message.toLowerCase() === email.toLowerCase()
      ? body.message
      : undefined
  }
}

/**
 * Server-side binding of verified HRMS token pairs to their subjects, held
 * for per-request MCP header resolution. Process-lifetime only: a restart
 * clears the vault while the signing secret survives, so still-valid cookies
 * simply present no HRMS headers until the next login. The token pair never
 * leaves this process.
 */
export class HrmsSessionTokenVault {
  private readonly tokens = new Map<string, string>()

  /**
   * Bind one verified token pair to its subject, replacing any earlier pair.
   * @param subject - verified subject (Frappe email).
   * @param tokenPair - verified `api_key:api_secret` pair.
   */
  store(subject: string, tokenPair: string): void {
    this.tokens.set(subject.toLowerCase(), tokenPair)
  }

  /**
   * Read the token pair held for one subject.
   * @param subject - verified subject (Frappe email).
   * @returns the held pair, or undefined when the subject never logged in or logged out.
   */
  lookup(subject: string): string | undefined {
    return this.tokens.get(subject.toLowerCase())
  }

  /**
   * Drop one subject's held token pair (logout).
   * @param subject - verified subject (Frappe email).
   */
  remove(subject: string): void {
    this.tokens.delete(subject.toLowerCase())
  }
}

/**
 * Resolve per-request MCP headers from the owning session's subject and its
 * server-held token pair. Returns no headers for the ownerless path, which
 * keeps the deployed service-mode behavior byte-identical and stays loudly
 * rejected by a per-user sidecar until the operator opts in.
 */
export interface HrmsHeaderSource {
  /**
   * Resolve the HRMS request headers for one caller subject.
   * @param subject - owning session's verified subject, or undefined on the ownerless path.
   * @returns the `X-HRMS-*` header set, or an empty record for the ownerless path.
   */
  resolveFor(subject: string | undefined): Record<string, string>
}

/**
 * Build the HRMS header source over one token vault, using the Track 1
 * header contract: `X-HRMS-User` carries the subject and `X-HRMS-User-Token`
 * its held pair. A subject whose pair is absent (vault cleared) still
 * presents its email with an empty token — inert in service mode and loudly
 * rejected by a per-user sidecar, matching the deployed Track 1 contract
 * for missing credentials.
 * @param vault - server-side token vault populated by the login route.
 * @returns the header source published for MCP clients in this process.
 */
export function hrmsHeaderSource(vault: HrmsSessionTokenVault): HrmsHeaderSource {
  return {
    resolveFor(subject) {
      if (subject === undefined) return {}
      return { 'X-HRMS-User': subject, 'X-HRMS-User-Token': vault.lookup(subject) ?? '' }
    },
  }
}

/**
 * Canonical request authority of one login/logout request, for cookie binding.
 * @param request - login or logout request whose Host header names the authority.
 * @returns the canonical `host:port`, or undefined when the Host header is
 *   absent or unusable.
 */
export function loginRequestAuthority(request: ConnectionTrustRequest): string | undefined {
  return requestAuthority(request.headers)
}

/**
 * Parse and validate one login request body at the HTTP boundary.
 * @param request - login request with a buffered JSON body.
 * @returns the presented credentials, or undefined when the body is unusable.
 */
async function parseLoginBody(request: Request): Promise<HrmsLoginBody | undefined> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') return undefined
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return undefined
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  if (typeof record.email !== 'string' || typeof record.token !== 'string') return undefined
  const email = record.email.trim()
  const token = record.token.trim()
  // The Track 1 contract carries `api_key:api_secret`; an email shape and a
  // colon-separated pair are the minimum sanity bounds before the verifier
  // is spent on a Frappe round trip.
  if (email.length === 0 || !email.includes('@') || !token.includes(':')) return undefined
  return { email, token }
}

/** Plain, detail-free rejection for every login failure class. */
function loginUnauthorized(): Response {
  return new Response('unauthorized', {
    status: 401,
    headers: { 'cache-control': 'no-store' },
  })
}

/**
 * Build the cookie-less HRMS login route: verify the presented token pair
 * against Frappe, hold it server-side bound to the confirmed subject, and
 * issue the subject-carrying cookie. Every failure returns the same plain
 * 401 without naming the failing step.
 * @param browserAuth - signing owner that mints and clears session cookies.
 * @param verifier - Frappe `get_logged_user` verifier.
 * @param vault - server-side token vault consulted by per-request MCP headers.
 * @returns buffered Fetch handler for `POST /api/hrms/login`.
 */
export function createHrmsLoginHandler(
  browserAuth: BrowserAuth,
  verifier: HrmsIdentityVerifier,
  vault: HrmsSessionTokenVault,
): ConnectionFetchHandler {
  return {
    requestBodyMode: () => 'buffered',
    fetch: async (request) => {
      if (request.method !== 'POST') return loginUnauthorized()
      const credentials = await parseLoginBody(request)
      const authority = loginRequestAuthority(request)
      if (credentials === undefined || authority === undefined) return loginUnauthorized()
      const subject = await verifier.verify(credentials.email, credentials.token, request.signal)
      if (subject === undefined) return loginUnauthorized()
      vault.store(subject, credentials.token)
      return new Response(null, {
        status: 204,
        headers: {
          'cache-control': 'no-store',
          'set-cookie': browserAuth.subjectSessionCookie(authority, subject),
        },
      })
    },
  }
}

/**
 * Build the HRMS logout route: drop the caller's held token pair and clear
 * the browser cookie. Idempotent without a valid cookie so the route stays
 * safe to call unconditionally.
 * @param browserAuth - signing owner that mints and clears session cookies.
 * @param vault - server-side token vault the login route populated.
 * @returns buffered Fetch handler for `POST /api/hrms/logout`.
 */
export function createHrmsLogoutHandler(
  browserAuth: BrowserAuth,
  vault: HrmsSessionTokenVault,
): ConnectionFetchHandler {
  return {
    requestBodyMode: () => 'buffered',
    fetch: (request) => {
      if (request.method !== 'POST') return Promise.resolve(loginUnauthorized())
      const subject = browserAuth.authenticatedSubject(request)
      if (subject !== undefined) vault.remove(subject)
      const authority = loginRequestAuthority(request)
      return Promise.resolve(new Response(null, {
        status: 204,
        headers: {
          'cache-control': 'no-store',
          ...authority === undefined
            ? {}
            : { 'set-cookie': browserAuth.clearedSessionCookie(authority) },
        },
      }))
    },
  }
}
