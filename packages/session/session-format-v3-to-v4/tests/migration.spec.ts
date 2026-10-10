import { describe, expect, it } from 'vitest'
import { createSessionFormatCatalog, SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatHeader, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { releasedV2SessionFormatCodec, releasedV3SessionFormatCodec, sessionFormatV2ToV3 } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { assertReleasedV4Header, assertV4RowAdmission, releasedV4SessionFormatCodec, restoreReleasedV4Artifact, sessionFormatV3ToV4 } from '../src/index.ts'

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

type V4Header = SessionFormatHeader & { readonly owner?: string }

const header: SessionFormatHeader = { version: 3, id: 'identity', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const v4 = (owner?: string): V4Header => ({ ...header, version: 4, ...(owner === undefined ? {} : { owner }) })
const request = (system?: string) => ({ header: { config: { provider: 'mock', model: 'mock' }, ...(system === undefined ? {} : { system }) }, reason: 'initial' })
const user = (id = 'user') => ({ role: 'user', id, source: { kind: 'user' }, content: [{ type: 'text', text: id }] })
const event = (type: string, data: SessionFormatEvent['data'], surfaceOp?: SessionFormatEvent['surfaceOp']): SessionFormatEvent => ({ type, seq: 0, time: 42, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) })
const dense = (events: readonly SessionFormatEvent[]) => events.map((e, seq) => ({ ...e, seq }))
const opening = () => [event('turn/start', { turn: 1 }), event('step/start', { turn: 1, step: 1 })]
function stage(source = header, sourceCut?: number) {
  const target = sessionFormatV3ToV4.migrateHeader(source)
  return { target, value: sessionFormatV3ToV4.createStage({ sourceHeader: source, targetHeader: target, sourceInheritedEventCount: sourceCut, sourceKind: 'decoded' }), collector: new SessionFormatEventCollector() }
}
function migrate(events: readonly SessionFormatEvent[], source = header, cut: number | undefined = 0): SessionFormatArtifact {
  const h = stage(source, cut)
  for (const e of dense(events)) h.value.transformEvent(e, h.collector)
  const artifact = { header: h.target, inheritedEventCount: h.value.finish(h.collector), events: h.collector.values }
  return restoreReleasedV4Artifact(artifact, new Set())
}
const catalog = createSessionFormatCatalog({
  currentVersion: 4,
  codecs: [
    releasedV0SessionFormatCodec,
    releasedV1SessionFormatCodec,
    releasedV2SessionFormatCodec,
    releasedV3SessionFormatCodec,
    releasedV4SessionFormatCodec,
  ],
  currentEncoder: releasedV4SessionFormatCodec,
  migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3, sessionFormatV3ToV4],
  restoreCurrent: artifact => restoreReleasedV4Artifact(artifact, new Set()),
  restoreTransformedCurrent: artifact => restoreReleasedV4Artifact(artifact, new Set()),
  restoreCurrentHeader(value) { assertReleasedV4Header(value); return value },
})

describe('header-only V3-to-V4 migration', () => {
  it('restamps released V3 headers as V4 and rejects foreign headers', () => {
    const source = deepFreeze({ ...header })
    expect(sessionFormatV3ToV4.migrateHeader(source)).toEqual({ ...header, version: 4 })
    expect(() => sessionFormatV3ToV4.migrateHeader({ ...header, version: 2 })).toThrow(/expected format v3 header/)
    expect(() => sessionFormatV3ToV4.migrateHeader({ ...header, isSeeded: 'yes' } as unknown as SessionFormatHeader)).toThrow(/isSeeded/)
  })

  it('passes events and runs through unchanged for unseeded Sessions', () => {
    const input = dense([...opening(), event('user/message', user(), 'append'), event('request/header', request())])
    deepFreeze(input)
    const before = JSON.stringify(input)
    const output = migrate(input)
    expect(output.events).toEqual(input)
    expect(output.header).toEqual({ ...header, version: 4 })
    expect(output.inheritedEventCount).toBe(0)
    expect(JSON.stringify(input)).toBe(before)
    const h = stage()
    h.value.transformRun({ runType: 'test', firstSeq: 0, eventCount: input.length, *expand() { yield* input } }, h.collector)
    expect(h.collector.values).toEqual(input)
    expect(h.value.finish(h.collector)).toBe(0)
  })

  it('derives unknown seeded cuts from the inherited end-seed marker and isolates simultaneous stages', () => {
    const source = { ...header, isSeeded: true, parentSession: 'parent' }
    const events = dense([...opening(), event('user/message', user(), 'append'), event('session/end-seed', { inherited: true })])
    const a = stage(source, undefined)
    const b = stage()
    expect(a.value.headerInheritedEventCount).toBeUndefined()
    expect(b.value.headerInheritedEventCount).toBe(0)
    for (const e of events) a.value.transformEvent(e, a.collector)
    expect(a.value.finish(a.collector)).toBe(3)
    expect(b.value.finish(b.collector)).toBe(0)
    const output = migrate(events, source, 3)
    expect(output.inheritedEventCount).toBe(3)
    expect(output.header).toEqual({ ...source, version: 4 })
    expect(() => migrate(events, source, 2)).toThrow(/source cut/)
    expect(() => migrate([], source, undefined)).toThrow(/inherited end-seed marker/)
    expect(() => migrate([event('session/end-seed', { inherited: true })])).toThrow(/unseeded/)
  })

  it('emits end-seed rows without the inherited marker unchanged', () => {
    const h = stage()
    h.value.transformEvent(event('session/end-seed', {}), h.collector)
    h.value.transformEvent(event('session/end-seed', null), h.collector)
    expect(h.collector.values.map(e => e.data)).toEqual([{}, null])
    expect(h.value.finish(h.collector)).toBe(0)
  })
})

describe('released V4 codec', () => {
  it.each([undefined, 'user@example.com'])('round-trips headers with owner %s through encode and decode', (owner) => {
    const logical = v4(owner)
    const physical = releasedV4SessionFormatCodec.encodeHeader(logical, 0)
    expect(physical['version']).toBe(4)
    expect(physical['owner']).toBe(owner)
    expect(releasedV4SessionFormatCodec.decodeHeader(physical)).toEqual(logical)
  })

  it('rejects foreign, owner-mistyped, and released-invalid headers on encode', () => {
    expect(() => releasedV4SessionFormatCodec.encodeHeader(header, 0)).toThrow(/expected format v4 header/)
    expect(() => releasedV4SessionFormatCodec
      .encodeHeader({ ...v4(), owner: 7 } as unknown as SessionFormatHeader, 0))
      .toThrow(/owner must be a string/)
    expect(() => releasedV4SessionFormatCodec.encodeHeader({ ...v4(), isSeeded: 'yes' } as unknown as SessionFormatHeader, 0)).toThrow(/isSeeded/)
  })

  it.each([null, [], false, { version: 3 }, { type: 'session', ...header }, { type: 'session', ...v4(), owner: 7 }])('rejects non-v4 physical metadata %j', (value) => {
    expect(() => releasedV4SessionFormatCodec.decodeHeader(value)).toThrow(/format v4 physical|owner must be a string/)
  })

  it('decodes owned and ownerless physical V4 headers', () => {
    expect(releasedV4SessionFormatCodec.decodeHeader({ type: 'session', ...v4('user@example.com') })).toEqual(v4('user@example.com'))
    expect(releasedV4SessionFormatCodec.decodeHeader({ type: 'session', ...v4() })).toEqual(v4())
  })

  it.each([undefined, 'user@example.com'])('round-trips events through the installed catalog with owner %s intact', (owner) => {
    const target = migrate([...opening(), event('user/message', user(), 'append'), event('request/header', request())])
    const ownedTarget: SessionFormatArtifact = { ...target, header: v4(owner) }
    const restore = catalog.createRestore(releasedV4SessionFormatCodec.encodeHeader(ownedTarget.header, 0), { recovery: 'strict', validation: 'current' })
    for (const e of ownedTarget.events) restore.decodeRow(releasedV4SessionFormatCodec.encodeEvent(e))
    expect(restore.finish()).toEqual(ownedTarget)
    expect(restoreReleasedV4Artifact(ownedTarget, new Set())).toBe(ownedTarget)
  })

  it('admits structurally owned rows and rejects retired event tags at the scanner boundary', () => {
    expect(() => assertV4RowAdmission(event('turn/start', { turn: 1 }))).not.toThrow()
    expect(() => assertV4RowAdmission({ type: 'tool/code-dispatch', seq: 0, time: 1, data: null })).toThrow(/unknown event type/)
  })

  it('rejects foreign logical headers and propagates event relationship failures on restore', () => {
    expect(() => assertReleasedV4Header(header)).toThrow(/expected format v4 header/)
    expect(() => assertReleasedV4Header({ ...v4(), owner: 7 } as unknown as SessionFormatHeader)).toThrow(/owner must be a string/)
    expect(() => assertReleasedV4Header({ ...v4(), isSeeded: 'yes' } as unknown as SessionFormatHeader)).toThrow(/isSeeded/)
    const foreign: SessionFormatArtifact = { header, inheritedEventCount: 0, events: [] }
    expect(() => restoreReleasedV4Artifact(foreign, new Set())).toThrow(/expected format v4 header/)
    const unknown: SessionFormatArtifact = { header: v4(), inheritedEventCount: 0, events: [event('external/event', null)] }
    expect(() => restoreReleasedV4Artifact(unknown, new Set())).toThrow(/unknown event/)
  })
})

describe('strict restoration through every adjacent stage', () => {
  const seededEvents = (endSeed: SessionFormatJsonObject) => dense([
    ...opening(), event('user/message', user(), 'append'), event('request/header', request('seed')),
    event('step/end', { turn: 1, step: 1 }), event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event('session/end-seed', endSeed),
  ])

  it.each([0, 1, 2])('restores seeded V%s through physical codecs and the full migration chain', (version) => {
    const source = seededEvents(version === 2 ? { inherited: true } : {})
    const physical = version === 2
      ? { type: 'session', id: header.id, createdAt: 1, isSeeded: true, delegationDepth: 0, version }
      : { type: 'session', version, id: header.id, createdAt: 1, delegationDepth: 0, seedLength: 6 }
    const restore = catalog.createRestore(physical, { recovery: 'strict', validation: 'current' })
    for (const e of source) restore.decodeRow(e)
    const output = restore.finish()
    expect(output.header['version']).toBe(4)
    expect(output.header['owner']).toBeUndefined()
    const last = output.events.at(-1)!
    expect(last.type).toBe('session/end-seed')
    expect((last.data as SessionFormatJsonObject)['inherited']).toBe(true)
    expect(output.inheritedEventCount).toBe(last.seq)
  })

  it('restores seeded V3 Sessions through the adjacent stage with exact event identity', () => {
    const source = dense([
      ...opening(), event('user/message', user(), 'append'), event('request/header', request()),
      event('step/end', { turn: 1, step: 1 }), event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      event('session/end-seed', { inherited: true }),
    ])
    const physical = { type: 'session', ...header, isSeeded: true, parentSession: 'parent' }
    const restore = catalog.createRestore(physical, { recovery: 'strict', validation: 'current' })
    for (const e of source) restore.decodeRow(e)
    const output = restore.finish()
    expect(output.header).toEqual({ ...header, version: 4, isSeeded: true, parentSession: 'parent' })
    expect(output.events).toEqual(source)
    expect(output.inheritedEventCount).toBe(6)
  })
})
