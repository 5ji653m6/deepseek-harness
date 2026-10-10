/**
 * Per-user Session ownership decisions: browser dispatches address only
 * Sessions they own (ownerless path sees ownerless Sessions); internal Host
 * work keeps full access; every mismatch is not-found silence.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { ApiSessionNotFound } from '../src/agent.ts'
import {
  assertSessionAddressable,
  isSessionAddressable,
} from '../src/ownership.ts'
import { currentCallerDispatch, currentCallerSubject } from '../src/caller-subject.ts'

const SLOT = Symbol.for('dsh.session-controller.callerSubjectReader')

function publish(reader: (() => { subject: string | undefined }) | undefined): void {
  const store = globalThis as Record<symbol, unknown>
  if (reader === undefined) Reflect.deleteProperty(store, SLOT)
  else store[SLOT] = reader
}

afterEach(() => {
  publish(undefined)
})

describe('session ownership decisions', () => {
  it('treats absent reader and absent dispatch as the ownerless internal path', () => {
    expect(currentCallerDispatch()).toBeUndefined()
    expect(currentCallerSubject()).toBeUndefined()
    expect(isSessionAddressable({ owner: 'alice@example.com' })).toBe(true)
    expect(() =>{  assertSessionAddressable({ id: 'session-x' as never, owner: 'alice@example.com' }) })
      .not.toThrow()
  })

  it('lets a subject address only its own Sessions', () => {
    publish(() => ({ subject: 'alice@example.com' }))
    expect(isSessionAddressable({ owner: 'alice@example.com' })).toBe(true)
    expect(isSessionAddressable({ owner: 'bob@example.com' })).toBe(false)
    expect(isSessionAddressable({})).toBe(false)
    expect(() =>{  assertSessionAddressable({ id: 'session-b' as never, owner: 'bob@example.com' }) })
      .toThrow(ApiSessionNotFound)
    expect(() =>{  assertSessionAddressable({ id: 'session-b' as never, owner: 'bob@example.com' }) })
      .toThrow('session "session-b" not found')
  })

  it('lets the ownerless browser path address only ownerless Sessions', () => {
    publish(() => ({ subject: undefined }))
    expect(isSessionAddressable({})).toBe(true)
    expect(isSessionAddressable({ owner: 'alice@example.com' })).toBe(false)
    expect(() =>{  assertSessionAddressable({ id: 'session-a' as never, owner: 'alice@example.com' }) })
      .toThrow(ApiSessionNotFound)
  })
})
