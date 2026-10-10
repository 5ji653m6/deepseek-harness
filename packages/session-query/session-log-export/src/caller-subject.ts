/**
 * Read the browser dispatch active on this async chain without value-importing
 * dsh-client-connection (the package-dependency policy classifies
 * client-connection Host value exports for Connection's own entry only).
 * The log-export route consults the dispatch so one subject cannot export
 * another subject's Sessions; Connection publishes the reader in a cordis
 * effect for its plugin lifetime, and a missing reader means no browser
 * dispatch is active (internal work), which keeps full access. The slot key
 * must match `CALLER_SUBJECT_READER_SLOT` in client-connection's
 * caller-subject module.
 */

const CALLER_SUBJECT_READER_SLOT = Symbol.for('dsh.session-controller.callerSubjectReader')

type CallerSubjectReader = () => { readonly subject: string | undefined } | undefined

/**
 * Read the browser dispatch currently being serviced.
 * @returns the active dispatch carrying the verified subject (undefined for
 *   a subject-less process-token cookie), or undefined outside a browser
 *   dispatch or when Connection publishes no reader.
 */
export function currentCallerDispatch(): { readonly subject: string | undefined } | undefined {
  const reader = Reflect.get(globalThis, CALLER_SUBJECT_READER_SLOT) as unknown
  return typeof reader === 'function' ? (reader as CallerSubjectReader)() : undefined
}
