---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-15-per-user-web-gui

English | [中文](2026-09-15-per-user-web-gui.zh.md)

## Summary

Adds an optional per-user owner to the Session header (SessionHeader.owner, JsonlHeaderLine.owner) as the sole structural addition of Session format V4, stamped for Sessions created behind a per-user web login.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-15-per-user-web-gui
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-09-11-initial"
    after: "5d00d6b461063f2c2bd6633d2d1765f100fe1a4a9651f53d2b4d5e3203c3af76"
    decision: version-bump
  - root: "SessionHeader"
    previous: "2026-09-11-initial"
    after: "cd9d35eaa760a75ee113b8bafe9ad0ff0bee068162e0050265cb1a227e9c2bf4"
    decision: version-bump
```

<a id="compatibility"></a>
## Compatibility

The owner arrives through the adjacent V3-to-V4 migration edge: SESSION_FORMAT_VERSION increases to 4, events and inherited cuts pass through unchanged, and committed v3 generations are never rewritten. Existing v3 records remain valid; the catalog restores them to v4 with no owner. Ownerless operation (the process-token path) writes no owner key, so single-operator deployments produce logs that differ from v3 only in the header version. Native v4 validation strips the owner before delegating to the frozen released-v3 rules, so released-edge semantics stay frozen.

**Release-base exception.** The format-version cookbook calls for a shared `release/*` integration base carrying the writer, codec, catalog wiring, and identity migration, with each structural transformation landing as a child of that base. This fork has no `release/*` line, so the V4 edge lands directly on its feature branch as one change. The obligations that base exists to enforce still hold: the writer, codec, catalog wiring, adjacent migration, and their verification ship together, and no released generation is rewritten.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/migration.spec.ts: 22 tests passed with per-file 100% coverage, pinning the header restamp, event passthrough, seeded-cut derivation, codec round-trips with and without owner, refusal cases, and strict restoration through every adjacent stage. Keyless snapshot refresh publishes v4 successors across the corpus while fs-read retains a declared v3 adjacent-migration coverage pin.

<a id="dev-note"></a>
## Dev Note

None.
