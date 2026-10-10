/** Caller-subject dispatch attribution and the process-global reader/runner slots. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { BrowserAuth } from '../src/browser-auth.ts'
import { HostConnectionService } from '../src/rpc-host.ts'
import {
  CALLER_SUBJECT_READER_SLOT,
  CALLER_SUBJECT_RUNNER_SLOT,
  currentCallerSubject,
  currentCallerSubjectDispatch,
  publishCallerSubjectReader,
  publishCallerSubjectRunner,
  runWithCallerSubject,
} from '../src/caller-subject.ts'

function slottedReader(): unknown {
  return (globalThis as Record<symbol, unknown>)[CALLER_SUBJECT_READER_SLOT]
}

function slottedRunner(): unknown {
  return (globalThis as Record<symbol, unknown>)[CALLER_SUBJECT_RUNNER_SLOT]
}

describe('caller-subject dispatch attribution', () => {
  it('distinguishes no dispatch from a subject-less dispatch', () => {
    expect(currentCallerSubjectDispatch()).toBeUndefined()
    expect(currentCallerSubject()).toBeUndefined()

    runWithCallerSubject('user@example.com', () => {
      expect(currentCallerSubjectDispatch()).toEqual({ subject: 'user@example.com' })
      expect(currentCallerSubject()).toBe('user@example.com')
    })

    runWithCallerSubject(undefined, () => {
      expect(currentCallerSubjectDispatch()).toEqual({ subject: undefined })
      expect(currentCallerSubject()).toBeUndefined()
    })

    expect(currentCallerSubjectDispatch()).toBeUndefined()
  })

  it('nests dispatches and returns the exact operation value', () => {
    const outer = runWithCallerSubject('outer@example.com', () =>
      runWithCallerSubject('inner@example.com', () => currentCallerSubject()))
    expect(outer).toBe('inner@example.com')
    expect(runWithCallerSubject('value', () => 42)).toBe(42)
  })
})

describe('caller-subject reader slot', () => {
  it('publishes the reader for out-of-package consumers and restores on dispose', () => {
    expect(slottedReader()).toBeUndefined()
    const dispose = publishCallerSubjectReader(currentCallerSubjectDispatch)
    try {
      expect(slottedReader()).toBeTypeOf('function')
      runWithCallerSubject('dispatched@example.com', () => {
        expect((slottedReader() as () => { subject: string | undefined })()).toEqual({
          subject: 'dispatched@example.com',
        })
      })
      expect((slottedReader() as () => { subject: string | undefined })()).toBeUndefined()
    } finally {
      dispose()
    }
    expect(slottedReader()).toBeUndefined()
  })

  it('restores the previously published reader instead of leaving an undefined entry', () => {
    const first = publishCallerSubjectReader(() => ({ subject: 'first@example.com' }))
    try {
      const second = publishCallerSubjectReader(() => ({ subject: 'second@example.com' }))
      second()
      expect((slottedReader() as () => { subject: string | undefined })()).toEqual({
        subject: 'first@example.com',
      })
    } finally {
      first()
    }
    expect(slottedReader()).toBeUndefined()
  })
})

describe('Connection service caller-subject surface', () => {
  it('reads the subject inherited by the authenticated dispatch it services', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin((pluginCtx) => {
      new HostConnectionService(pluginCtx, [], {} as BrowserAuth)
    })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionService
    try {
      expect(connection.currentCallerSubject()).toBeUndefined()
      const observed = connection.asCallerSubject('owner@example.com', () =>
        connection.currentCallerSubject())
      expect(observed).toBe('owner@example.com')
      expect(connection.asCallerSubject(undefined, () =>
        connection.currentCallerSubject())).toBeUndefined()
      expect(connection.currentCallerSubject()).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })
})

describe('caller-subject runner slot', () => {
  it('publishes the runner for out-of-package consumers and restores on dispose', () => {
    expect(slottedRunner()).toBeUndefined()
    const dispose = publishCallerSubjectRunner(runWithCallerSubject)
    try {
      expect(slottedRunner()).toBeTypeOf('function')
      const observed = (slottedRunner() as <T>(subject: string | undefined, operation: () => T) => T)(
        'dispatched@example.com',
        () => currentCallerSubject(),
      )
      expect(observed).toBe('dispatched@example.com')
      expect(currentCallerSubject()).toBeUndefined()
    } finally {
      dispose()
    }
    expect(slottedRunner()).toBeUndefined()
  })

  it('restores the previously published runner instead of leaving an undefined entry', () => {
    const direct = <T>(_subject: string | undefined, operation: () => T): T => operation()
    const first = publishCallerSubjectRunner(direct)
    try {
      const second = publishCallerSubjectRunner(runWithCallerSubject)
      second()
      expect(slottedRunner()).toBe(direct)
    } finally {
      first()
    }
    expect(slottedRunner()).toBeUndefined()
  })
})
