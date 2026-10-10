---
description: "The complete V3-to-V4 Session conversion: a header-only restamp that adds the optional per-user owner while every event row and inherited cut passes through unchanged."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-format-v3-to-v4

English | [中文](README.zh.md)

## Summary

Restore supported released V3 Sessions as V4 without changing any event, sequence position, timestamp, or inherited cut. This page is the single specification for this adjacent edge: what it transforms, preserves, and refuses, followed separately by native V4 admission. The only structural addition is the optional header `owner`, the per-user subject stamped for Sessions created behind a per-user web login. Persistence consumes this library through the static catalog; the library does not read or publish files.

## Table of Contents

- [Use this package](#use-this-package)
- [V3-to-V4 specification](#v3-to-v4-specification)
  - [Header restamp](#header-restamp)
  - [Event passthrough and inherited cuts](#event-passthrough)
- [Native V4 admission](#native-v4-admission)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Use the [catalog](../session-format-catalog/README.md) to restore a Session. Direct imports serve catalog assembly and tests; this library has no Cordis mount configuration. The [public exports](src/index.ts) provide the migration declaration, the released V3 source codec re-export, the V4 target codec, the target header validator, and the target restorer.

### Entry point

The header-only operation does not convert or validate an event body:

```text
const targetHeader = sessionFormatV3ToV4.migrateHeader(sourceHeader)
```

Full restoration feeds decoded events through a fresh stage and validates the target artifact. Callers must not treat partial stage emissions as a successful restore: an error can occur at a later event or at `finish()`. The [format protocol](../session-format/README.md) owns stage scheduling and catalog error handling; [JSONL persistence](../session-persistence-jsonl/README.md) owns read preparation and immutable successor publication.

-----

<a id="v3-to-v4-specification"></a>
## V3-to-V4 specification

The complete edge is an identity conversion for events. It preserves the relative order, dense sequence positions, timestamps, payloads, and inherited cut of every source event. Only the header version changes; preservation applies to admitted input, not arbitrary unaudited extensions.

<a id="header-restamp"></a>
### Header restamp

The logical header changes `version: 3` to `version: 4`. It retains `id`, `createdAt`, `isSeeded`, `delegationDepth`, and admitted optional fields unchanged. A released V3 header never carries `owner`; migration therefore never invents one, and a migrated V4 header has no `owner` until a native V4 writer stamps it. A source header that fails released V3 validation is refused before restamping.

<a id="event-passthrough"></a>
### Event passthrough and inherited cuts

Every source event is emitted unchanged, including retired-for-current-writers rows that the frozen V3 codec still admits. Compact runs expand and pass through without per-event inspection.

For a seeded Session, the last `session/end-seed` with `data.inherited: true` identifies the source cut; its source sequence is the inherited event count, excluding that marker. An untagged marker does not establish the cut. A supplied `sourceInheritedEventCount` must agree; a seeded log without a marker and an unseeded log with one are refused. Unseeded stages expose `headerInheritedEventCount: 0`; seeded stages leave it unknown until `finish()` derives the exact cut. This matches the preceding edge's cut semantics, so a V0/V1/V2 chain reaches V4 with the same inherited prefix it had at V3.

-----

<a id="native-v4-admission"></a>
## Native V4 admission

Input already marked V4 does not run V3-to-V4. Native catalog reads with `validation: 'transformed'` apply codec checks only; full relationships require `restoreReleasedV4Artifact` or catalog `validation: 'current'`. The following rules distinguish V4 checks from the frozen V3 rules they delegate to:

- The V4 logical header admits exactly the released V3 fields plus optional `owner`. A supplied `owner` must be a string; any other value is refused. The owner participates in no event relationship, and restoration returns the original artifact with the owner intact.
- Physical V4 headers split into a released-V3 view (`owner` stripped, `version` restamped to 3) plus the optional owner before frozen V3 validation runs. An unstripped `owner` would be a foreign key to the released V2/V3 key sets, so the split is mandatory on every decode and validation path.
- Event rows, envelopes, surface metadata, and relationship checks are exactly the released V3 rules. Row admission reuses `assertV3RowAdmission`; unknown or retired required event types are refused by vocabulary-aware restoration, not re-audited here.
- The V4 writer stamps `owner` only for Sessions created behind a per-user web login. V3 recordings reopened as V4 keep whatever header they decode with; this package neither requires nor clears the field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [stage](src/migration.ts) owns only the seeded-cut derivation and emits every event unchanged. The [codec](src/codec.ts) delegates framing and row decoding to the frozen V3 codec and owns only the header version and optional owner. The [restorer](src/validation.ts) strips the owner, restamps the version, and validates through the frozen V3 relationships before returning the original V4 artifact. Frozen V0-to-V1, V1-to-V2, and V2-to-V3 semantics remain unchanged. No runtime invariant companion is published because this library owns no independently observable registrations or state replicas.

[Migration tests](tests/migration.spec.ts) pin the restamp, passthrough, cut derivation, codec round-trips, refusal cases, and strict restoration through every adjacent stage. [Persistence integration](../session-persistence-jsonl/tests/jsonl.spec.ts) owns publication evidence. The [released-format decision](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md) owns the rationale for testing adjacent composition separately from native admission.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Released V2 to V3](../session-format-v2-to-v3/README.md) — frozen preceding conversion and source codec.
- [Released-format migrations](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md) — compatibility obligations for released generations.
- [Session format status](../../../docs/session-format-status.md) — released versions and migration support.
- [Adding a Session format version](../../../docs/cookbook/adding-a-session-format-version.md) — the version-bump procedure this edge follows.

-----

<a id="model-experience"></a>
## Model Experience

### Historical restoration

#### What the model sees

Each historical request retains its exact prompt, message content, and event order through `sessionFormatV3ToV4` event passthrough. The header `owner` is never model-visible.

#### Token effect

The edge adds, removes, and rewrites no model-visible text.

#### KV Cache effect

The edge preserves historical request meaning and model configuration byte-for-byte; it does not guarantee provider cache hits.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Metadata-only owner** — the owner identifies the creating subject for attribution and per-user listing; it carries no authorization decision inside this package, and no event payload can reference it.
- **No file or settings migration** — this package never changes committed generations or `settings.yaml`. Persistence owns publishing the final successor; an existing V4 generation does not rerun its incoming edge. See [format release status](../../../docs/session-format-status.md) and the compatibility obligations in the [released-format policy](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
