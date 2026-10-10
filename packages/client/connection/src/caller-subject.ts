/**
 * Process-local caller-subject attribution for requests authenticated by
 * {@link BrowserAuth}. The /api HTTP route and the Gateway WebSocket upgrade
 * run each dispatch inside `runWithCallerSubject`, and any code servicing
 * that dispatch reads the verified cookie subject back through
 * `currentCallerSubject` on the Connection service — without receiving the
 * transport request itself. A subject is present only for cookies minted by
 * the HRMS login route; the process-token path reads `undefined` everywhere,
 * preserving single-operator behavior.
 *
 * Host packages outside client-connection read the active dispatch through
 * the process-global {@link CALLER_SUBJECT_READER_SLOT}: Connection publishes
 * the reader for its plugin lifetime (see `publishCallerSubjectReader`), so
 * those packages never value-import this module, which the package-dependency
 * policy forbids outside Connection's own Host entry. The same packages run
 * work under an inherited subject through the process-global
 * {@link CALLER_SUBJECT_RUNNER_SLOT} (see `publishCallerSubjectRunner`):
 * session-controller drives an owned Session's agent loop under its owner's
 * subject so per-request MCP header resolution observes the owner on every
 * tool call.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Verified cookie subject inherited by one authenticated browser dispatch.
 * The wrapper object (rather than a bare string) distinguishes "no browser
 * dispatch on this async chain" (store absent — internal Host work) from a
 * subject-less browser dispatch (store present, subject undefined).
 */
export interface CallerSubjectDispatch {
  /**
   * Verified per-user subject (the Frappe email minted by the HRMS login
   * route), or undefined for a subject-less process-token cookie.
   */
  readonly subject: string | undefined
}

/**
 * Process-global registry key under which Connection publishes the active
 * dispatch reader. `Symbol.for` gives every copy of this module (including
 * copies inlined into other bundles) one registry identity.
 */
export const CALLER_SUBJECT_READER_SLOT = Symbol.for('dsh.session-controller.callerSubjectReader')

/**
 * Process-global registry key under which Connection publishes the
 * caller-subject runner. Same registry identity contract as
 * {@link CALLER_SUBJECT_READER_SLOT}.
 */
export const CALLER_SUBJECT_RUNNER_SLOT = Symbol.for('dsh.session-controller.callerSubjectRunner')

/** Reader of the browser dispatch active on the current async chain. */
export type CallerSubjectReader = () => CallerSubjectDispatch | undefined

/** Runner executing one operation with a caller subject inherited by its async chain. */
export type CallerSubjectRunner = <T>(subject: string | undefined, operation: () => T) => T

const callerSubjectStorage = new AsyncLocalStorage<CallerSubjectDispatch>()

/**
 * Run one authenticated dispatch with the caller's verified subject.
 * @param subject - verified cookie subject, or undefined for a subject-less cookie.
 * @param operation - dispatch to execute inside the inherited boundary.
 * @returns the exact value returned by the operation.
 */
export function runWithCallerSubject<T>(subject: string | undefined, operation: () => T): T {
  return callerSubjectStorage.run({ subject }, operation)
}

/**
 * Read the browser dispatch active on this async chain.
 * @returns the active dispatch, or undefined outside a browser dispatch.
 */
export function currentCallerSubjectDispatch(): CallerSubjectDispatch | undefined {
  return callerSubjectStorage.getStore()
}

/**
 * Read the subject of the dispatch currently handling this call.
 * @returns the verified subject inherited by the active dispatch, or undefined
 *   outside an authenticated dispatch or for a subject-less cookie.
 */
export function currentCallerSubject(): string | undefined {
  return currentCallerSubjectDispatch()?.subject
}

/**
 * Publish one value on a process-global slot, restoring the previous entry on
 * disposal. `Symbol.for` slots type as plain `symbol`, so access goes through
 * `Reflect` (the frozen tree's registry slots set this precedent).
 * @param slot - process-global registry key to publish on.
 * @param value - value to publish.
 * @returns disposer restoring the previously published value, or deleting the
 *   key when none was published.
 */
function publishSlot(slot: symbol, value: unknown): () => void {
  const previous: unknown = Reflect.get(globalThis, slot)
  Reflect.set(globalThis, slot, value)
  return () => {
    if (previous === undefined) Reflect.deleteProperty(globalThis, slot)
    else Reflect.set(globalThis, slot, previous)
  }
}

/**
 * Publish this process's caller-subject reader for Host packages that cannot
 * value-import client-connection. Disposal restores the previous reader, so
 * plugin reload leaves the ownerless path (reader absent) intact.
 * @param reader - dispatch reader backed by this module's AsyncLocalStorage.
 * @returns disposer restoring the previously published reader.
 */
export function publishCallerSubjectReader(reader: CallerSubjectReader): () => void {
  return publishSlot(CALLER_SUBJECT_READER_SLOT, reader)
}

/**
 * Publish this process's caller-subject runner for Host packages that cannot
 * value-import client-connection. Session-controller uses it to drive an
 * owned Session's agent loop under its owner's subject. Disposal restores the
 * previous runner, so plugin reload leaves the direct path (runner absent) intact.
 * @param runner - dispatch runner backed by this module's AsyncLocalStorage.
 * @returns disposer restoring the previously published runner.
 */
export function publishCallerSubjectRunner(runner: CallerSubjectRunner): () => void {
  return publishSlot(CALLER_SUBJECT_RUNNER_SLOT, runner)
}
