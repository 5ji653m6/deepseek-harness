/** V4 framing: released V3 rows with an optional per-user header owner. */

import { SessionFormatError, isSessionFormatJsonObject, snapshotSessionFormatJson } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatCodec,
  SessionFormatCurrentEncoder,
  SessionFormatHeader,
} from '@deepseek-ai/dsh-session-format'
import { assertV3RowAdmission, releasedV3SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { assertReleasedV4Header } from './validation.ts'

/** V4 codec delegates unchanged event rows to the frozen V3 codec and owns only the header version and optional owner. */
export const releasedV4SessionFormatCodec = Object.freeze({
  version: 4,
  decodeHeader(value: unknown) {
    const physical = v4PhysicalHeader(value)
    return {
      ...releasedV3SessionFormatCodec.decodeHeader(physical.released),
      version: 4,
      ...physical.owner === undefined ? {} : { owner: physical.owner },
    }
  },
  createDecoder(value, recovery) {
    const physical = v4PhysicalHeader(value)
    const decoder = releasedV3SessionFormatCodec.createDecoder(physical.released, recovery)
    return {
      header: {
        ...decoder.header,
        version: 4,
        ...physical.owner === undefined ? {} : { owner: physical.owner },
      },
      decodeRow(row, context) {
        decoder.decodeRow(row, context)
      },
      finish(context) {
        return decoder.finish(context)
      },
    }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV4Header(header)
    const { owner, ...released } = header as SessionFormatHeader & { readonly owner?: string }
    return {
      ...releasedV3SessionFormatCodec.encodeHeader({ ...released, version: 3 }, inheritedEventCount),
      version: 4,
      ...owner === undefined ? {} : { owner },
    }
  },
  encodeEvent(event) {
    return releasedV3SessionFormatCodec.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

/**
 * Validate owned V4 admission rules before a scanner or codec can discard a recoverable tail.
 * Event rows are unchanged between V3 and V4, so the frozen V3 structural admission applies.
 * @param row - parsed physical row, before envelope or compressed-range decoding.
 */
export function assertV4RowAdmission(row: unknown): void {
  assertV3RowAdmission(row)
}

/**
 * Split one physical v4 header into the released-v3 view (owner stripped —
 * the frozen v3 generation never carried it) and the optional owner the V4
 * writer stamps. Owner is admitted only as a string; the released v3
 * delegation validates every other field.
 * @param value - parsed physical v4 header candidate.
 * @returns the released-v3 header view and the admitted owner, if any.
 */
function v4PhysicalHeader(value: unknown): {
  readonly released: SessionFormatHeader
  readonly owner?: string
} {
  const header = snapshotSessionFormatJson(value, 'format v4 physical header')
  if (!isSessionFormatJsonObject(header) || header['version'] !== 4) {
    throw new SessionFormatError('expected format v4 physical Session header')
  }
  const owner = header['owner']
  if (owner !== undefined && typeof owner !== 'string') {
    throw new SessionFormatError('format v4 header owner must be a string')
  }
  const { owner: _omitted, ...released } = header
  return { released: { ...released, version: 3 } as SessionFormatHeader, ...owner === undefined ? {} : { owner } }
}
