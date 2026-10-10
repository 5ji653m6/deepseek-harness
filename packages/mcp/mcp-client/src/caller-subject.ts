/**
 * Read the browser dispatch subject active on this async chain without
 * value-importing dsh-client-connection (the package-dependency policy
 * classifies client-connection Host value exports for Connection's own
 * entry only). The streamable-http transport resolves per-request request
 * headers from this subject at request time; Connection publishes the reader
 * in a cordis effect for its plugin lifetime, and a missing reader (plugin
 * startup, timer-driven reconnects) reads as the ownerless path. The slot
 * key must match `CALLER_SUBJECT_READER_SLOT` in client-connection's
 * caller-subject module.
 */

const CALLER_SUBJECT_READER_SLOT = Symbol.for('dsh.session-controller.callerSubjectReader')

/**
 * Read the verified subject of the browser dispatch being serviced.
 * @returns the verified subject, or undefined for a subject-less
 *   process-token cookie and outside browser dispatches.
 */
export function currentCallerSubject(): string | undefined {
  const reader = Reflect.get(globalThis, CALLER_SUBJECT_READER_SLOT) as unknown
  if (typeof reader !== 'function') return undefined
  const dispatch = (reader as () => { readonly subject: string | undefined } | undefined)()
  return dispatch === undefined ? undefined : dispatch.subject
}
