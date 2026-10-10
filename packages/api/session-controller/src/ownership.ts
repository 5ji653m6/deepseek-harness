/**
 * Per-user Session ownership decisions for the browser-facing Session API.
 * The rule: a browser dispatch addresses only Sessions whose header owner
 * equals its verified subject, with both ownerless sides matching each other
 * (the process-token path sees ownerless Sessions only). Internal Host work —
 * no active browser dispatch on the async chain — keeps full access, so
 * background drivers (goals, schedules, subagent routing) are unaffected.
 * Every mismatch answers with the same not-found silence a missing Session
 * produces, never a 403 that would reveal another subject's Session exists.
 */

import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { ApiSessionNotFound } from './agent.ts'
import { currentCallerDispatch } from './caller-subject.ts'

/**
 * Test whether the active browser dispatch may address one Session header.
 * @param header - Session header whose ownership is tested.
 * @returns whether the caller (browser or internal) may address the Session.
 */
export function isSessionAddressable(header: Pick<SessionHeader, 'owner'>): boolean {
  const dispatch = currentCallerDispatch()
  if (dispatch === undefined) return true
  return (header.owner ?? undefined) === dispatch.subject
}

/**
 * Enforce per-user ownership for one addressed Session header, failing with
 * not-found silence on mismatch.
 * @param header - Session header whose ownership is enforced.
 * @throws {ApiSessionNotFound} when a browser dispatch addresses a Session
 *   owned by another subject (or an owned Session on the ownerless path).
 */
export function assertSessionAddressable(header: Pick<SessionHeader, 'id' | 'owner'>): void {
  if (isSessionAddressable(header)) return
  throw new ApiSessionNotFound(`session "${header.id}" not found`)
}
