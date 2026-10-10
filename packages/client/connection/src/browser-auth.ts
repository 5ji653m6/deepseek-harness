/** Browser-session authentication for the Host Connection carrier. */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionTrustRequest,
} from './rpc.ts'
import type { HrmsIdentityVerifier } from './hrms-login.ts'
import type { HrmsSessionTokenVault } from './hrms-login.ts'

const AUTH_RECORD_KEY = credentialKey('client-connection', 'browser-session')
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const SECRET_BYTES = 32
const TOKEN_QUERY = 'token'
const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_PAYLOAD_VERSION = 1
const STORED_SECRET_VERSION = 1
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/
const PROCESS_LAUNCH_TOKENS = new WeakMap<object, string>()

interface StoredSecretPayload {
  readonly version: typeof STORED_SECRET_VERSION
  readonly secret: string
}

interface BrowserCookiePayload {
  readonly version: typeof COOKIE_PAYLOAD_VERSION
  readonly authority: string
  readonly issuedAt: number
  readonly expiresAt: number
  /**
   * Verified per-user subject (the Frappe email minted by the HRMS login
   * route). Absent on cookies minted by the process-token exchange, so legacy
   * cookies decode unchanged.
   */
  readonly subject?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

function processLaunchToken(owner: object): string {
  const existing = PROCESS_LAUNCH_TOKENS.get(owner)
  if (existing !== undefined) return existing
  const created = encodeBase64Url(randomBytes(SECRET_BYTES))
  PROCESS_LAUNCH_TOKENS.set(owner, created)
  return created
}

function header(
  headers: ConnectionTrustRequest['headers'],
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Canonical request authority used as the cookie name and signed audience.
 * @param headers - request headers carrying the Host value.
 * @returns the canonical `host:port`, or undefined when the Host header is
 *   absent or unusable.
 */
export function requestAuthority(headers: ConnectionTrustRequest['headers']): string | undefined {
  const host = header(headers, 'host')
  if (host === undefined) return undefined
  try {
    return new URL(`http://${host}`).host
  } catch {
    return undefined
  }
}

function canonicalSecret(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined
  const decoded = decodeBase64Url(value)
  if (decoded === undefined || decoded.byteLength !== SECRET_BYTES) return undefined
  return decoded
}

function storedSecret(record: CredentialRecord | undefined): Buffer | undefined {
  if (record === undefined) return undefined
  if (record.kind !== 'grant' || !isRecord(record.payload)
    || record.payload.version !== STORED_SECRET_VERSION) {
    throw new Error('client-connection: browser-session credential record has an unsupported format')
  }
  const secret = canonicalSecret(record.payload.secret)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record has an invalid secret')
  }
  return secret
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes)
}

function cookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/** Read the exact generated cookie without implementing general Cookie decoding. */
function cookieValue(headerValue: string, name: string): string | undefined {
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/** Serialize the fixed browser-session attributes; generated names and values are cookie-safe base64url. */
function sessionCookie(
  name: string,
  value: string,
  expiresAt: number,
  maxAgeSeconds: number,
  sameSite: 'Strict' | 'None' = 'Strict',
): string {
  const secure = sameSite === 'None' ? '; Secure' : ''
  return `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=${sameSite}${secure}`
}

function signature(secret: Buffer, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

function encodeCookie(payload: BrowserCookiePayload, secret: Buffer): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `v1.${body}.${encodeBase64Url(signature(secret, body))}`
}

function decodeCookie(value: string, secret: Buffer): BrowserCookiePayload | undefined {
  const parts = value.split('.')
  const [version, body, encodedSignature] = parts
  if (parts.length !== 3 || version !== 'v1' || body === undefined || encodedSignature === undefined) {
    return undefined
  }
  const actualSignature = decodeBase64Url(encodedSignature)
  if (actualSignature === undefined) return undefined
  const expectedSignature = signature(secret, body)
  if (actualSignature.byteLength !== expectedSignature.byteLength
    || !timingSafeEqual(actualSignature, expectedSignature)) return undefined
  let decoded: unknown
  try {
    const bodyBytes = decodeBase64Url(body)
    if (bodyBytes === undefined) return undefined
    decoded = JSON.parse(bodyBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(decoded)
    || decoded.version !== COOKIE_PAYLOAD_VERSION
    || typeof decoded.authority !== 'string'
    || !Number.isSafeInteger(decoded.issuedAt)
    || !Number.isSafeInteger(decoded.expiresAt)
    || (decoded.subject !== undefined && typeof decoded.subject !== 'string')) return undefined
  return decoded as unknown as BrowserCookiePayload
}

async function initializeSecret(credentials: CredentialProvider): Promise<Buffer> {
  const generated: StoredSecretPayload = {
    version: STORED_SECRET_VERSION,
    secret: encodeBase64Url(randomBytes(SECRET_BYTES)),
  }
  const record = await credentials.modifyRecord(AUTH_RECORD_KEY, (current) => {
    if (current !== undefined) {
      storedSecret(current)
      return Promise.resolve(undefined)
    }
    return Promise.resolve({ kind: 'grant', payload: generated })
  })
  const secret = storedSecret(record)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record was not created')
  }
  return secret
}

/**
 * Process launch-token exchange and persistent signed-cookie verification.
 * Connection loads the credential provider's signing secret during activation
 * and retains it for synchronous request authentication.
 */
export class BrowserAuth {
  private readonly launchToken: string
  private readonly maxAgeMilliseconds: number
  private iframeTrustedOrigins: readonly string[] = []
  private hrmsVerifier: HrmsIdentityVerifier | undefined
  private hrmsVault: HrmsSessionTokenVault | undefined

  private constructor(
    processOwner: object,
    private readonly secret: Buffer,
    maxAgeDays: number,
  ) {
    this.launchToken = processLaunchToken(processOwner)
    this.maxAgeMilliseconds = maxAgeDays * DAY_MILLISECONDS
    if (!Number.isSafeInteger(this.maxAgeMilliseconds)
      || !Number.isSafeInteger(Date.now() + this.maxAgeMilliseconds)) {
      throw new Error('client-connection: cookieMaxAgeDays exceeds the safe timestamp range')
    }
  }

  /**
   * Initialize browser authentication and create its durable signing secret
   * when this Harness home has none.
   * @param processOwner - root application context retaining one token across Connection reloads.
   * @param credentials - persistent credential provider for the Web profile.
   * @param maxAgeDays - positive absolute browser-cookie lifetime in days.
   * @returns initialized authentication owner with the process owner's launch token.
   */
  static async create(
    processOwner: object,
    credentials: CredentialProvider,
    maxAgeDays: number,
  ): Promise<BrowserAuth> {
    return new BrowserAuth(processOwner, await initializeSecret(credentials), maxAgeDays)
  }

  /**
   * Configure iframe embedding support for cross-origin Frappe desk integration.
   * @param iframeTrustedOrigins - origins allowed to embed the GUI in an iframe.
   * @param verifier - Frappe identity verifier for token validation.
   * @param vault - server-side token vault for storing verified credentials.
   */
  configureIframeEmbedding(
    iframeTrustedOrigins: readonly string[],
    verifier: HrmsIdentityVerifier,
    vault: HrmsSessionTokenVault,
  ): void {
    this.iframeTrustedOrigins = iframeTrustedOrigins
    this.hrmsVerifier = verifier
    this.hrmsVault = vault
  }

  /**
   * Add this process's launch token to the ordinary application root URL.
   * @param baseUrl - canonical browser origin without credentials.
   * @returns root URL carrying the process token as its sole authentication input.
   */
  authenticatedUrl(baseUrl: string): string {
    const url = new URL(baseUrl)
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    url.searchParams.set(TOKEN_QUERY, this.launchToken)
    return url.href
  }

  /**
   * Authenticate an index request. A valid root query token mints the cookie
   * and redirects to clean `/`; a valid cookie lets the caller serve the
   * index; every other request receives the same minimal 401 response.
   * Frappe iframe embedding: when `frappe_token` and `frappe_email` are
   * present, the outcome is binary — verify against Frappe and mint a
   * subject-carrying cookie, or 401. The flow never falls through to the
   * existing-cookie path: silently serving a presented Frappe identity under
   * a previously minted cookie collapses every desk user into one subject.
   * Browsers send no `Origin` on iframe GET navigations, so the embedding
   * source is read from `Origin` first and the `Referer` origin second; a
   * present-but-untrusted source is rejected, an absent one is allowed (the
   * token pair is itself the bearer credential). The minted cookie uses
   * `SameSite=Strict` for same-site embedding (works over plain HTTP) and
   * `SameSite=None; Secure` for cross-site embedding (requires HTTPS).
   * @param req - incoming root or configured-index request.
   * @param res - response owned when this method returns false.
   * @returns true only when the caller may serve index.html.
   */
  async authorizeIndex(req: ConnectionIndexRequest, res: ConnectionIndexResponse): Promise<boolean> {
    /* v8 ignore next -- node:http always supplies url on server requests. */
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')

    // Frappe iframe auto-login: detect frappe_token and frappe_email parameters
    const frappeToken = url.searchParams.get('frappe_token')
    const frappeEmail = url.searchParams.get('frappe_email')
    if (frappeToken !== null && frappeEmail !== null && this.hrmsVerifier !== undefined && this.hrmsVault !== undefined) {
      const source = this.embeddingSource(req)
      if (source !== undefined && !this.isIframeTrustedOrigin(source)) {
        this.writeUnauthorized(req, res)
        return false
      }
      return await this.handleFrappeLogin(req, res, frappeEmail, frappeToken, url, source)
    }

    const tokens = url.searchParams.getAll(TOKEN_QUERY)
    if (tokens.length > 0) {
      const authority = requestAuthority(req.headers)
      if (req.method === 'GET' && url.pathname === '/' && tokens.length === 1
        && authority !== undefined && tokenMatches(tokens.join(''), this.launchToken)) {
        const issuedAt = Date.now()
        const expiresAt = issuedAt + this.maxAgeMilliseconds
        const value = encodeCookie({
          version: COOKIE_PAYLOAD_VERSION,
          authority,
          issuedAt,
          expiresAt,
        }, this.secret)
        const isIframe = this.isIframeContext(req)
        const sameSite = isIframe ? 'None' : 'Strict'
        res.writeHead(303, {
          'cache-control': 'no-store',
          'location': '/',
          'referrer-policy': 'no-referrer',
          'set-cookie': sessionCookie(
            cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1000), sameSite,
          ),
        })
        res.end()
        return false
      }
      if (req.method === 'GET' && url.pathname === '/' && this.isAuthenticated(req)) {
        res.writeHead(303, {
          'cache-control': 'no-store',
          'location': '/',
          'referrer-policy': 'no-referrer',
        })
        res.end()
        return false
      }
      this.writeUnauthorized(req, res)
      return false
    }
    if (this.isAuthenticated(req)) return true
    this.writeUnauthorized(req, res)
    return false
  }

  /**
   * Handle Frappe auto-login from iframe embedding URL parameters.
   * Validates the token against Frappe, stores it in the vault, and mints a
   * subject-carrying cookie. The cookie uses `SameSite=Strict` when the
   * embedding source is same-site with this GUI (works over plain HTTP) and
   * `SameSite=None; Secure` when it is cross-site (requires HTTPS — browsers
   * drop both `Secure` cookies over HTTP and `SameSite=None` without
   * `Secure`, so cross-site plain-HTTP embedding cannot persist a cookie).
   * @param req - incoming request with frappe_token and frappe_email parameters.
   * @param res - response to write the redirect and cookie to.
   * @param email - Frappe user email from URL parameter.
   * @param token - Frappe API token pair (api_key:api_secret) from URL parameter.
   * @param url - parsed URL to clean after login.
   * @param source - validated embedding source origin, when the browser sent one.
   * @returns true when login succeeded and the caller should continue, false when response was written.
   */
  private async handleFrappeLogin(
    req: ConnectionIndexRequest,
    res: ConnectionIndexResponse,
    email: string,
    token: string,
    url: URL,
    source: string | undefined,
  ): Promise<boolean> {
    if (this.hrmsVerifier === undefined || this.hrmsVault === undefined) {
      this.writeUnauthorized(req, res)
      return false
    }

    const subject = await this.hrmsVerifier.verify(email, token, new AbortController().signal)
    if (subject === undefined) {
      this.writeUnauthorized(req, res)
      return false
    }

    this.hrmsVault.store(subject, token)

    const authority = requestAuthority(req.headers)
    if (authority === undefined) {
      this.writeUnauthorized(req, res)
      return false
    }

    const issuedAt = Date.now()
    const expiresAt = issuedAt + this.maxAgeMilliseconds
    const value = encodeCookie({
      version: COOKIE_PAYLOAD_VERSION,
      authority,
      issuedAt,
      expiresAt,
      subject,
    }, this.secret)

    // Clean URL: remove frappe_token and frappe_email parameters
    const cleanUrl = new URL(url)
    cleanUrl.searchParams.delete('frappe_token')
    cleanUrl.searchParams.delete('frappe_email')

    const sameSite = this.isCrossSiteEmbedding(source, authority) ? 'None' : 'Strict'
    res.writeHead(303, {
      'cache-control': 'no-store',
      'location': cleanUrl.pathname + cleanUrl.search + cleanUrl.hash,
      'referrer-policy': 'no-referrer',
      'set-cookie': sessionCookie(
        cookieName(authority), value, expiresAt,
        Math.floor(this.maxAgeMilliseconds / 1000), sameSite,
      ),
    })
    res.end()
    return false
  }

  /**
   * Read the embedding source origin of one navigation request. Browsers do
   * not send `Origin` on GET navigations (top-level or iframe), so the
   * `Referer` origin is the fallback observation; both absent means a direct
   * or stripped navigation.
   * @param req - request headers carrying Origin or Referer.
   * @returns the embedding origin, or undefined when neither header is usable.
   */
  private embeddingSource(req: ConnectionTrustRequest): string | undefined {
    const origin = header(req.headers, 'origin')
    if (origin !== undefined) return origin
    const referer = header(req.headers, 'referer')
    if (referer === undefined) return undefined
    try {
      return new URL(referer).origin
    } catch {
      return undefined
    }
  }

  /**
   * Whether the embedding source is cross-site relative to this GUI's
   * authority. Site-ness compares hostnames (ports and scheme do not decide
   * here — the embedding admin chose the GUI URL, so a matching hostname
   * implies the same scheme); an absent source is treated as same-site so
   * direct navigations keep the stricter cookie.
   * @param source - validated embedding source origin, when observed.
   * @param authority - canonical `host:port` this GUI serves.
   * @returns true when the embedding page is cross-site from the GUI.
   */
  private isCrossSiteEmbedding(source: string | undefined, authority: string): boolean {
    if (source === undefined) return false
    try {
      return new URL(source).hostname !== authority.split(':')[0]
    } catch {
      return true
    }
  }

  /**
   * Whether the request is from an iframe context (cross-origin embedding).
   * @param req - request headers carrying the Origin or Referer value.
   * @returns true when the observed embedding source matches a trusted iframe origin.
   */
  private isIframeContext(req: ConnectionTrustRequest): boolean {
    const source = this.embeddingSource(req)
    return source !== undefined && this.isIframeTrustedOrigin(source)
  }

  /**
   * Whether the origin matches one of the configured iframe trusted origins.
   * @param origin - the Origin header value from the request.
   * @returns true when the origin's protocol and host match a trusted entry.
   */
  private isIframeTrustedOrigin(origin: string): boolean {
    if (this.iframeTrustedOrigins.length === 0) {
      return false
    }
    try {
      const originUrl = new URL(origin)
      return this.iframeTrustedOrigins.some((trusted) => {
        try {
          const trustedUrl = new URL(trusted)
          return originUrl.protocol === trustedUrl.protocol && originUrl.host === trustedUrl.host
        } catch {
          return false
        }
      })
    } catch {
      return false
    }
  }

  /**
   * Verify the authority-bound browser cookie on a Host request.
   * @param request - request headers carrying Host and Cookie.
   * @returns true only for an unexpired cookie signed by this activation's loaded secret.
   */
  isAuthenticated(request: ConnectionTrustRequest): boolean {
    return this.verifiedPayload(request) !== undefined
  }

  /**
   * Read the per-user subject carried by an authenticated browser cookie.
   * The process-token exchange mints subject-less cookies, so the
   * single-operator path reads `undefined` here.
   * @param request - request headers carrying Host and Cookie.
   * @returns the verified subject, or undefined for a subject-less, missing,
   *   expired, or wrong-authority cookie.
   */
  authenticatedSubject(request: ConnectionTrustRequest): string | undefined {
    return this.verifiedPayload(request)?.subject
  }

  /**
   * Mint one authority-bound Set-Cookie header carrying a verified subject.
   * Used by the HRMS login route after Frappe verification succeeds; the
   * token pair itself never enters the cookie.
   * @param authority - canonical request authority the cookie binds to.
   * @param subject - verified subject (Frappe email) to stamp into the payload.
   * @returns the complete `Set-Cookie` header value.
   */
  subjectSessionCookie(authority: string, subject: string): string {
    const issuedAt = Date.now()
    const expiresAt = issuedAt + this.maxAgeMilliseconds
    const value = encodeCookie({
      version: COOKIE_PAYLOAD_VERSION,
      authority,
      issuedAt,
      expiresAt,
      subject,
    }, this.secret)
    return sessionCookie(
      cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1000),
    )
  }

  /**
   * Mint the Set-Cookie header that clears the authority-bound browser
   * cookie. Used by the HRMS logout route; idempotent for absent cookies.
   * @param authority - canonical request authority the cookie binds to.
   * @returns the complete expiring `Set-Cookie` header value.
   */
  clearedSessionCookie(authority: string): string {
    return `${cookieName(authority)}=; Max-Age=0; Path=/; Expires=${new Date(0).toUTCString()}; HttpOnly; SameSite=Strict`
  }

  /** Decode and validate the authority-bound cookie on a Host request. */
  private verifiedPayload(request: ConnectionTrustRequest): BrowserCookiePayload | undefined {
    const authority = requestAuthority(request.headers)
    const rawCookie = header(request.headers, 'cookie')
    if (authority === undefined || rawCookie === undefined) return undefined
    const value = cookieValue(rawCookie, cookieName(authority))
    if (value === undefined) return undefined
    const payload = decodeCookie(value, this.secret)
    if (payload === undefined || payload.authority !== authority) return undefined
    const now = Date.now()
    return payload.issuedAt <= now
      && payload.expiresAt > now
      && payload.expiresAt > payload.issuedAt
      && payload.expiresAt - payload.issuedAt <= this.maxAgeMilliseconds
      ? payload
      : undefined
  }

  private writeUnauthorized(req: ConnectionIndexRequest, res: ConnectionIndexResponse): void {
    res.writeHead(401, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    })
    res.end(req.method === 'HEAD'
      ? undefined
      : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
  }
}
