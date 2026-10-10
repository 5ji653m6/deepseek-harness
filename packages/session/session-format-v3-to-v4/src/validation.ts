/** Native V4 header validation and restoration through the frozen V3 relationships. */

import { SessionFormatError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV3Header, restoreReleasedV3Artifact } from '@deepseek-ai/dsh-session-format-v2-to-v3'

/**
 * Validate v4 logical metadata with the released-v3 fields plus the optional
 * per-user owner. The owner is the only V4 header addition: V3 records omit
 * it, and the V4 writer stamps it only for Sessions created behind a per-user
 * web login.
 * @param header - decoded v4 Session header.
 */
export function assertReleasedV4Header(header: SessionFormatHeader): void {
  if (header.version !== 4) throw new SessionFormatError('expected format v4 header')
  const { owner, ...released } = header as SessionFormatHeader & { readonly owner?: string }
  assertReleasedV3Header({ ...released, version: 3 })
  if (owner !== undefined && typeof owner !== 'string') {
    throw new SessionFormatError('format v4 header owner must be a string')
  }
}

/**
 * Validate one detached v4 artifact through the frozen V3 relationships. The
 * owner does not participate in any event relationship; the returned artifact
 * and its messages are unchanged.
 * @param artifact - detached v4 artifact.
 * @param knownEventTypes - event types understood by the installed Session package.
 * @returns the same validated artifact.
 */
export function restoreReleasedV4Artifact(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): SessionFormatArtifact {
  assertReleasedV4Header(artifact.header)
  const { owner: _owner, ...releasedHeader } = artifact.header as SessionFormatHeader & { readonly owner?: string }
  restoreReleasedV3Artifact({ ...artifact, header: { ...releasedHeader, version: 3 } }, knownEventTypes)
  return artifact
}
