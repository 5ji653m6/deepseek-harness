/** Host HTTP bridge for browser-client RPC. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
// Activates the webServer Context merge used below.
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH } from './api-path.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { assertTrustedAuthority, isTrustedApiRequest } from './api-request-trust.ts'
import { BrowserAuth } from './browser-auth.ts'
import { HostConnectionService } from './rpc-host.ts'
import {
  currentCallerSubjectDispatch,
  publishCallerSubjectReader,
  publishCallerSubjectRunner,
  runWithCallerSubject,
} from './caller-subject.ts'
import { ConnectionRecoveryConfigSchema, resolveConnectionConfig, type ConnectionRecoveryConfig } from './recovery-config.ts'
import {
  assertHrmsBaseUrl,
  createHrmsLoginHandler,
  createHrmsLogoutHandler,
  HRMS_LOGIN_MAX_BODY_BYTES,
  HRMS_LOGIN_PATH,
  HRMS_LOGOUT_PATH,
  HrmsIdentityVerifier,
  HrmsSessionTokenVault,
  hrmsHeaderSource,
} from './hrms-login.ts'

export type {
  ConnectionFetchMethod,
  ConnectionFetchHandler,
  ConnectionFetchRoute,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRequestRejection,
  ConnectionRpcResult,
  ConnectionRequestBodyMode,
  ConnectionTrustRequest,
  ClientRequest,
  HostConnectionHandle,
  HostConnectionFetch,
  HostConnectionRpc,
  RpcMessage,
  ServerResponse,
} from './rpc.ts'
export { RpcId, transportError } from './rpc.ts'
export {
  clientRequestSchema,
  rpcErrorSchema,
  rpcIdSchema,
  rpcMessageSchema,
  rpcResultSchema,
  serverResponseSchema,
} from './rpc-schema.ts'
export { HostConnectionService } from './rpc-host.ts'

export { API_PATH } from './api-path.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/** Services required before providing Connection. */
export const inject = ['credentials']

/** Browser authentication, request limits, and connection recovery configuration. */
export interface ConnectionConfig {
  /** Browser recovery timing, injected into each served page. */
  recovery?: ConnectionRecoveryConfig
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The /api trust fence refuses any
   * request whose Host is neither loopback nor listed here, so a
   * non-loopback (`0.0.0.0`) deployment must declare the names it is reached
   * by; the Web runtime derives LAN IP literals from an active all-interface
   * bind. An entry that is not a bare, canonical authority fails plugin load.
   */
  trustedHosts?: string[]
  /** Absolute browser-session lifetime in days. Default: 30. */
  cookieMaxAgeDays?: number
  /** Maximum buffered JSON body for every `/api` request. Default: 300 MiB. */
  maxRequestBodyBytes?: number
  /**
   * HRMS base URL enabling per-user web login (`POST /api/hrms/login`).
   * When absent, the login and logout routes are not mounted and the Web GUI
   * stays single-operator. Must be an absolute `http` or `https` URL; a
   * malformed value fails plugin load.
   */
  hrmsBaseUrl?: string
  /**
   * Origins allowed to embed the Web GUI in an iframe and make cross-site API
   * requests (e.g., Frappe desk pages). Each entry must be a full origin URL
   * (protocol + host, like `http://frappe.example.com`). When present, the
   * trust fence accepts cross-site requests from these origins and the
   * auto-login flow accepts Frappe tokens from embedded contexts.
   */
  iframeTrustedOrigins?: string[]
}

export const Config: z<ConnectionConfig> = z.object({
  recovery: ConnectionRecoveryConfigSchema.default({}),
  trustedHosts: z.array(String).default([]),
  cookieMaxAgeDays: z.natural().min(1).default(30),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
  // Schemastery fields are optional unless marked `.required()`, so a bare
  // `z.string()` already admits absence (no `zod`-style `.optional()` exists).
  hrmsBaseUrl: z.string(),
  iframeTrustedOrigins: z.array(String).default([]),
})

/**
 * Provides carrier-neutral RPC and Fetch registries. When `webServer` is
 * present, the plugin also mounts the `/api` browser transport with Host/Origin
 * checks and persistent browser authentication.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config?: ConnectionConfig): Promise<void> {
  const recovery = resolveConnectionConfig(config?.recovery)
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const trustedHosts = config?.trustedHosts ?? []
  const cookieMaxAgeDays = config?.cookieMaxAgeDays ?? 30
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  const iframeTrustedOrigins = config?.iframeTrustedOrigins ?? []
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  // HRMS per-user login: absent config keeps the Web GUI single-operator and
  // mounts no login surface; a malformed URL fails the load loudly.
  const hrmsBaseUrl = config?.hrmsBaseUrl === undefined || config.hrmsBaseUrl.trim() === ''
    ? undefined
    : assertHrmsBaseUrl(config.hrmsBaseUrl.trim())
  const hrms = hrmsBaseUrl === undefined
    ? undefined
    : {
      verifier: new HrmsIdentityVerifier(hrmsBaseUrl),
      vault: new HrmsSessionTokenVault(),
    }
  assertImageBodyCapacity(ctx, maxRequestBodyBytes)
  const browserAuth = await BrowserAuth.create(ctx.root, ctx.credentials, cookieMaxAgeDays)
  // Configure iframe embedding support when trusted origins are declared.
  if (iframeTrustedOrigins.length > 0 && hrms !== undefined) {
    browserAuth.configureIframeEmbedding(iframeTrustedOrigins, hrms.verifier, hrms.vault)
  }
  const connection = new HostConnectionService(
    ctx,
    trustedHosts,
    browserAuth,
    iframeTrustedOrigins,
  )
  // Host packages outside client-connection (session ownership filtering,
  // per-request MCP headers) read the active browser dispatch through this
  // process-global reader; disposal restores the ownerless path.
  ctx.effect(
    () => publishCallerSubjectReader(() => currentCallerSubjectDispatch()),
    'client-connection: caller-subject reader',
  )
  // The same packages run owned work under an inherited subject through this
  // process-global runner; session-controller wraps prompt admission so an
  // owned Session's agent loop presents its owner's HRMS headers per request.
  ctx.effect(
    () => publishCallerSubjectRunner(runWithCallerSubject),
    'client-connection: caller-subject runner',
  )
  if (hrms !== undefined) {
    // MCP clients resolve per-request HRMS headers from this source; the
    // vault holds the verified token pairs the login route stored.
    ctx.effect(
      () => ctx.provide('hrmsRequestHeaders', hrmsHeaderSource(hrms.vault)),
      'client-connection: hrms request headers',
    )
  }
  ctx.inject(['webServer'], (webCtx) => {
    assertImageBodyCapacity(webCtx, maxRequestBodyBytes)
    webCtx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__DSH_CONNECTION_RECOVERY__', value: recovery })
    })
    if (hrms !== undefined) {
      // Login and logout sit beside the /api prefix route as exact routes:
      // the webserver dispatches exact paths first, so they stay reachable
      // without a cookie while every other /api request keeps the gate. Only
      // the Host/Origin trust fence applies here — authentication is what
      // login establishes.
      const login = createHrmsLoginHandler(browserAuth, hrms.verifier, hrms.vault)
      const logout = createHrmsLogoutHandler(browserAuth, hrms.vault)
      for (const [path, handler] of [[HRMS_LOGIN_PATH, login], [HRMS_LOGOUT_PATH, logout]] as const) {
        const route: WebRoute = {
          kind: 'exact',
          path,
          handler: async (req, res) => {
            if (!isTrustedApiRequest(req, trustedHosts, iframeTrustedOrigins)) {
              res.writeHead(403)
              res.end('forbidden')
              return
            }
            await bridge(req, res, handler, HRMS_LOGIN_MAX_BODY_BYTES)
          },
        }
        webCtx.effect(
          () => webCtx.webServer.register(route),
          `client-connection: ${path} route`,
        )
      }
    }
    const fetchHandler = connection.createSharedFetchHandler(API_PATH)
    const route: WebRoute = {
      kind: 'prefix',
      path: API_PATH,
      handler: async (req, res) => {
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        // Inherit the verified cookie subject through the dispatch so RPC and
        // Fetch callees can filter and stamp by caller without receiving the
        // transport request.
        await connection.asCallerSubject(connection.authenticatedSubject(req), () =>
          bridge(req, res, fetchHandler, maxRequestBodyBytes))
      },
    }
    webCtx.effect(() => webCtx.webServer.register(route), 'client-connection: /api route')
  })
  ctx.inject(['attachments'], (attachmentCtx) => {
    assertImageBodyCapacity(attachmentCtx, maxRequestBodyBytes)
  })
}
