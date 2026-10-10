/** Header-only V3-to-V4 migration: events and inherited cuts pass through unchanged. */

import { SessionFormatError, defineSessionFormatMigration, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatEventRun, SessionFormatMigrationContext, SessionFormatMigrationStage, SessionFormatMigrationStageInput } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV3Header } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { assertReleasedV4Header } from './validation.ts'

/** Restamp the released V3 header as V4; every event row and the inherited cut are preserved. */
export const sessionFormatV3ToV4 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v3-to-v4',
  fromVersion: 3,
  toVersion: 4,
  migrateHeader(header) {
    assertReleasedV3Header(header)
    return { ...header, version: 4 }
  },
  createStage(input) { return new ReleasedV3ToV4Stage(input) },
  validateTargetHeader: assertReleasedV4Header,
})

class ReleasedV3ToV4Stage implements SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  private sourceCut: number | undefined

  constructor(private readonly input: SessionFormatMigrationStageInput) {
    assertReleasedV3Header(input.sourceHeader)
    this.sourceCut = input.sourceHeader.isSeeded ? undefined : 0
    if (!input.sourceHeader.isSeeded) this.headerInheritedEventCount = 0
  }

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data)
      && event.data['inherited'] === true) {
      if (!this.input.sourceHeader.isSeeded) {
        throw new SessionFormatError('format v3 unseeded Session contains an inherited end-seed marker')
      }
      this.sourceCut = event.seq
    }
    context.emitEvent(event)
  }

  transformRun(run: SessionFormatEventRun, context: SessionFormatMigrationContext): void {
    context.emitRun(run)
  }

  finish(_context: SessionFormatMigrationContext): number {
    const cut = sessionFormatCount(this.sourceCut, 'format v3 inherited end-seed marker')
    if (this.input.sourceInheritedEventCount !== undefined && this.input.sourceInheritedEventCount !== cut) {
      throw new SessionFormatError('format v3 inherited end-seed marker disagrees with its source cut')
    }
    return cut
  }
}
