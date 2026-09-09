import { afterEach, beforeEach, expect, it } from 'vitest'
import { SessionSearchIndexConsumer } from './session-search-index-consumer'
import { SessionSearchIndexWriter } from './session-search-index-writer'
import {
  openSessionSearchIndexFile,
  syntheticCandidate,
  syntheticSession,
  SYNTHETIC_TRANSCRIPT,
  userMessages,
  type SessionSearchIndexFile
} from './session-search-staged-write-test-fixture'
import { SessionSearchStore } from './session-search-store'

// The store is driven directly here. Every guard below is also shadowed by the
// consumer's own check, so a test that goes through the consumer proves nothing
// about which of the two is holding.

let index: SessionSearchIndexFile
let store: SessionSearchStore
let errors: unknown[]

beforeEach(async () => {
  index = await openSessionSearchIndexFile('ss-index-writer')
  errors = []
  store = new SessionSearchStore(index.path, (error) => errors.push(error))
})

afterEach(async () => {
  store.close()
  await index.close()
})

function count(table: string): number {
  return (index.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
}

function publishRead(previousByteOffset: number, byteOffset: number, text: string): boolean {
  const staged = store.beginWrite(
    syntheticCandidate(),
    previousByteOffset === 0 ? 'replace' : 'append',
    previousByteOffset
  )
  if (!staged) {
    return false
  }
  for (const message of userMessages(text, 2)) {
    staged.add(message)
  }
  const published = staged.publish({ session: syntheticSession(), byteOffset, incomplete: false })
  staged.discard()
  return published
}

it('refuses an append whose predecessor offset is not the published cursor', () => {
  expect(publishRead(0, 100, 'first')).toBe(true)

  expect(store.beginWrite(syntheticCandidate(), 'append', 900)).toBeNull()
  expect(store.beginWrite(syntheticCandidate(), 'append', 99)).toBeNull()
  // The one offset that does continue the published span is accepted.
  expect(store.beginWrite(syntheticCandidate(), 'append', 100)).not.toBeNull()
})

it('refuses to publish a stage whose cursor moved underneath it', async () => {
  const candidate = syntheticCandidate()
  const stale = store.beginWrite(candidate, 'replace', 0)!
  for (const message of userMessages('stalegeneration', 40)) {
    stale.add(message)
  }
  // A second read of the same path finishes first. Without the parse file lane
  // this is the overlap that would otherwise resurrect the stale rows.
  expect(publishRead(0, 200, 'winninggeneration')).toBe(true)

  expect(stale.publish({ session: syntheticSession(), byteOffset: 100, incomplete: false })).toBe(
    false
  )
  stale.discard()
  await store.purgeOlderThan(null)

  expect(store.indexedFile(SYNTHETIC_TRANSCRIPT, null)?.byteOffset).toBe(200)
  expect(count('visible_sessions')).toBe(1)
  expect(count('messages')).toBe(2)
  expect(count('search_pending_deletes')).toBe(0)
  expect(errors).toEqual([])
})

it('refuses to publish a stage whose file was removed mid-read', async () => {
  expect(publishRead(0, 100, 'firstgeneration')).toBe(true)
  const staged = store.beginWrite(syntheticCandidate(), 'append', 100)!
  for (const message of userMessages('afterremoval', 10)) {
    staged.add(message)
  }
  store.removeFile(SYNTHETIC_TRANSCRIPT)

  expect(staged.publish({ session: syntheticSession(), byteOffset: 300, incomplete: false })).toBe(
    false
  )
  staged.discard()
  await store.purgeOlderThan(null)

  expect(store.indexedFile(SYNTHETIC_TRANSCRIPT, null)).toBeNull()
  expect(count('sessions')).toBe(0)
  expect(count('messages')).toBe(0)
})

it('declines a behind cursor in beginRead before it ever reaches the store', () => {
  const attempted: number[] = []
  const stub = {
    acceptsCandidate: () => true,
    indexedFile: () => ({ byteOffset: 100, mtimeMs: 1, sizeBytes: 1 }),
    beginWrite: (_candidate: unknown, _mode: unknown, previousByteOffset: number) => {
      attempted.push(previousByteOffset)
      return { add: () => undefined, publish: () => true, discard: () => undefined }
    },
    markStale: () => undefined
  } as unknown as SessionSearchStore
  const consumer = new SessionSearchIndexConsumer(stub)

  expect(
    consumer.beginRead({ candidate: syntheticCandidate(), mode: 'append', previousByteOffset: 900 })
  ).toBeNull()
  // The store was never asked, so the writer's own guard cannot be what refused.
  expect(attempted).toEqual([])
  expect(
    consumer.beginRead({ candidate: syntheticCandidate(), mode: 'append', previousByteOffset: 100 })
  ).not.toBeNull()
  expect(attempted).toEqual([100])
})

it('treats half a recorded identity as no identity at all', async () => {
  // A host that could stat dev but not ino: `remote-session-file-stat` spreads
  // the two independently, and `upsertFile` preserves the half it was given.
  const partial = { ...syntheticCandidate({ dev: 7 }), agent: 'claude' as const }
  const staged = store.beginWrite(partial, 'replace', 0)!
  for (const message of userMessages('halfidentity', 2)) {
    staged.add(message)
  }
  staged.publish({ session: syntheticSession(), byteOffset: 100, incomplete: false })
  staged.discard()
  expect(index.db.prepare('SELECT dev, ino FROM files').get()).toEqual({ dev: 7, ino: null })

  // One matching number is not proof of sameness, and one mismatching number is
  // not proof of replacement. Neither compares, so neither declines.
  expect(store.indexedFile(SYNTHETIC_TRANSCRIPT, { dev: 7, ino: 99 })?.byteOffset).toBe(100)
  expect(store.indexedFile(SYNTHETIC_TRANSCRIPT, { dev: 8, ino: 99 })?.byteOffset).toBe(100)
  expect(store.beginWrite(syntheticCandidate({ dev: 8, ino: 99 }), 'append', 100)).not.toBeNull()
})

it('forgets a finished read rather than growing a stage per path', () => {
  const writer = new SessionSearchIndexWriter(index.db)
  for (const path of ['/a.jsonl', '/b.jsonl', '/a.jsonl']) {
    const staged = writer.beginWrite(syntheticCandidate({ path }), 'replace', 0)!
    staged.add(userMessages('leakcheck', 1)[0])
    staged.publish({ session: syntheticSession(), byteOffset: 10, incomplete: false })
    staged.discard()
    expect(writer.openStageCount).toBe(0)
  }
  // An abandoned read is still a finished one once it is discarded.
  const abandoned = writer.beginWrite(syntheticCandidate({ path: '/c.jsonl' }), 'replace', 0)!
  expect(writer.openStageCount).toBe(1)
  abandoned.discard()
  expect(writer.openStageCount).toBe(0)
})
