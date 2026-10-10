/**
 * Read the browser dispatch active on this async chain without value-importing
 * dsh-client-connection (the package-dependency policy classifies
 * client-connection Host value exports for Connection's own entry only).
 * Session listing, resume, and fork gating in this package consult the
 * dispatch: a subject addresses only its own Sessions, the ownerless path
 * sees only ownerless Sessions, and internal Host work (no dispatch) keeps
 * full access. Connection publishes the reader in a cordis effect for its
 * plugin lifetime; a missing reader means no browser dispatch is active.
 * The slot key must match `CALLER_SUBJECT_READER_SLOT` in client-connection's
 * caller-subject module.
 *
 * Prompt admission additionally runs an owned Session's agent loop under its
 * owner's subject through the process-global runner slot
 * (`dsh.session-controller.callerSubjectRunner`, published by Connection in
 * the same way), so per-request MCP header resolution observes the owner on
 * every tool call without this package value-importing client-connection.
 */

/** Verified cookie subject inherited by one authenticated browser dispatch. */
export interface CallerSubjectDispatch {
  /**
   * Verified per-user subject (the Frappe email minted by the HRMS login
   * route), or undefined for a subject-less process-token cookie.
   */
  readonly subject: string | undefined
}

const CALLER_SUBJECT_READER_SLOT = Symbol.for('dsh.session-controller.callerSubjectReader')

const CALLER_SUBJECT_RUNNER_SLOT = Symbol.for('dsh.session-controller.callerSubjectRunner')

type CallerSubjectReader = () => CallerSubjectDispatch | undefined

type CallerSubjectRunner = <T>(subject: string | undefined, operation: () => T) => T

function publishedReader(): CallerSubjectReader | undefined {
  const reader = Reflect.get(globalThis, CALLER_SUBJECT_READER_SLOT) as unknown
  return typeof reader === 'function' ? reader as CallerSubjectReader : undefined
}

/**
 * Read the browser dispatch currently being serviced.
 * @returns the active dispatch, or undefined outside a browser dispatch
 *   (internal Host work) or when Connection publishes no reader.
 */
export function currentCallerDispatch(): CallerSubjectDispatch | undefined {
  return publishedReader()?.()
}

/**
 * Read the verified subject of the browser dispatch being serviced.
 * @returns the verified subject, or undefined on the ownerless path and
 *   outside browser dispatches.
 */
export function currentCallerSubject(): string | undefined {
  return currentCallerDispatch()?.subject
}

/**
 * Run one operation with the given verified subject inherited by its async
 * chain. Prompt admission uses this to drive an owned Session's agent loop
 * under its owner's subject: the agent-loop driver chain starts inside the
 * admission, so per-request MCP header resolution observes the owner on
 * every tool call. A missing or non-function runner (Connection not applied
 * in this process) runs the operation unchanged, preserving single-operator
 * behavior.
 * @param subject - verified owner subject, or undefined for the ownerless path.
 * @param operation - operation to execute inside the inherited boundary.
 * @returns the exact value returned by the operation.
 */
export function runWithCallerSubject<T>(subject: string | undefined, operation: () => T): T {
  const runner = Reflect.get(globalThis, CALLER_SUBJECT_RUNNER_SLOT) as unknown
  if (typeof runner !== 'function') return operation()
  return (runner as CallerSubjectRunner)(subject, operation)
}
