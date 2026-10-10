/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP connects to a URL.
 *
 * @module
 */

import type { Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StreamableHTTPClientTransport, type FetchLike } from '@modelcontextprotocol/client'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { Config, StreamableHttpConfig } from './index.ts'
import { currentCallerSubject } from './caller-subject.ts'

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/**
 * Flatten any Fetch API header container into a plain record, preserving each
 * header's declared name casing. The transport passes static config headers
 * through `requestInit`, so per-request resolution merges over this base
 * without renaming resolver-supplied `X-HRMS-*` names.
 * @param headers - header container received by the custom fetch, if any.
 * @returns a plain record of the same header entries.
 */
function flattenHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const flat: Record<string, string> = {}
  if (headers instanceof Headers) {
    headers.forEach((value, name) => { flat[name] = value })
  } else if (Array.isArray(headers)) {
    for (const [name, value] of headers) flat[name] = value
  } else if (headers !== undefined) {
    Object.assign(flat, headers)
  }
  return flat
}

/**
 * Fetch that consults `resolveRequestHeaders` when each request is issued,
 * with the caller subject active at that moment, and merges the resolved
 * headers over the request's static headers. Concurrent owners sharing one
 * connection therefore each present only their own `X-HRMS-*` values, and the
 * ownerless path presents none. The merge overwrites case-insensitively: the
 * MCP SDK normalizes `init` header names to lowercase while resolved headers
 * keep their declared casing, and a plain-object merge would keep both
 * spellings — fetch then joins the duplicate values (the live audit saw
 * `X-HRMS-User: ', test1@hualing.com'`, still a sidecar 401).
 * @param resolve - per-request header resolver from the resolved config.
 * @returns a `FetchLike` delegating to the global fetch after the merge.
 */
function subjectFetching(resolve: NonNullable<StreamableHttpConfig['resolveRequestHeaders']>): FetchLike {
  return (url, init) => {
    const resolved = resolve(currentCallerSubject())
    const flat = flattenHeaders(init?.headers)
    for (const name of Object.keys(flat)) {
      const collides = Object.keys(resolved).some(
        resolvedName => resolvedName !== name && resolvedName.toLowerCase() === name.toLowerCase(),
      )
      if (collides) Reflect.deleteProperty(flat, name)
    }
    return fetch(url, { ...init, headers: { ...flat, ...resolved } })
  }
}

/**
 * Create an MCP transport from the resolved plugin config. The factory runs
 * once per connection attempt (initial connect and every reconnect). The
 * streamable-http transport consults `config.resolveRequestHeaders` per
 * request through a custom fetch, so per-request headers follow the caller
 * subject at request time instead of freezing at connection establishment
 * (which would bleed one owner's credentials into another's calls on a
 * shared connection). Absent resolver keeps today's byte-identical static
 * `config.headers` behavior.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @returns A connected-ready MCP Transport (stdio or Streamable HTTP).
 */
export function createTransport(config: Config): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'streamable-http': {
      const resolver = config.resolveRequestHeaders
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          requestInit: { headers: config.headers },
          ...(resolver === undefined ? {} : { fetch: subjectFetching(resolver) }),
        },
      )
    }
  }
}
