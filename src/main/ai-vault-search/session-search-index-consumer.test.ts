import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexFile,
  replayTranscriptRead,
  syntheticCandidate,
  syntheticSession,
  SYNTHETIC_TRANSCRIPT,
  userMessages,
  type SessionSearchIndexFile
} from './session-search-staged-write-test-fixture'
import { SessionSearchStore } from './session-search-store'

let index: SessionSearchIndexFile
let store: SessionSearchStore
let errors: unknown[]

beforeEach(async () => {
  index = await openSessionSearchIndexFile('ss-index-consumer')
  errors = []
  store = new SessionSearchStore(index.path, (error) => errors.push(error))
  registerSessionSearchIndexConsumer(store)
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  store.close()
  await index.close()
})

function visibleMessages(): number {
  return (index.db.prepare('SELECT count(*) AS n FROM visible_messages').get() as { n: number }).n
}

function cursor(): number | undefined {
  return store.indexedFile(SYNTHETIC_TRANSCRIPT, null)?.byteOffset
}

it('appends onto its own cursor and carries the content hash forward', async () => {
  replayTranscriptRead({ messages: userMessages('first half', 3), outcome: { byteOffset: 100 } })
  await store.settled()
  const first = index.db
    .prepare('SELECT content_hash AS hash, content_hash_count AS count FROM visible_sessions')
    .get() as { hash: string; count: number }

  replayTranscriptRead({
    mode: 'append',
    previousByteOffset: 100,
    messages: userMessages('second half', 2),
    outcome: { byteOffset: 220 }
  })
  await store.settled()

  expect(visibleMessages()).toBe(5)
  expect(cursor()).toBe(220)
  const second = index.db
    .prepare('SELECT content_hash AS hash, content_hash_count AS count FROM visible_sessions')
    .get() as { hash: string; count: number }
  expect(second.count).toBe(first.count + 2)
  expect(second.hash).not.toBe(first.hash)
  expect(store.takeStale()).toEqual([])
})

it('declines an append that starts past its own cursor and records the file', async () => {
  replayTranscriptRead({ messages: userMessages('indexed span', 3), outcome: { byteOffset: 100 } })
  await store.settled()

  // The session list read further than this index did, so the appended span
  // continues from bytes the index never saw.
  replayTranscriptRead({
    mode: 'append',
    previousByteOffset: 900,
    messages: userMessages('unseen span', 4),
    outcome: { byteOffset: 1200 }
  })
  await store.settled()

  expect(visibleMessages()).toBe(3)
  expect(cursor()).toBe(100)
  expect(store.takeStale().map((candidate) => candidate.file.path)).toEqual([SYNTHETIC_TRANSCRIPT])
})

it('declines a file whose identity changed under the same path', async () => {
  const original = syntheticCandidate({ dev: 1, ino: 10 })
  replayTranscriptRead({
    candidate: original,
    messages: userMessages('original file', 2),
    outcome: { byteOffset: 100 }
  })
  await store.settled()

  replayTranscriptRead({
    candidate: syntheticCandidate({ dev: 1, ino: 77 }),
    mode: 'append',
    previousByteOffset: 100,
    messages: userMessages('replacement file', 2),
    outcome: { byteOffset: 200 }
  })
  await store.settled()

  expect(visibleMessages()).toBe(2)
  expect(store.takeStale()).toHaveLength(1)
})

it('never advances the cursor for an incomplete read', async () => {
  replayTranscriptRead({ messages: userMessages('complete span', 3), outcome: { byteOffset: 100 } })
  await store.settled()

  replayTranscriptRead({
    mode: 'append',
    previousByteOffset: 100,
    messages: userMessages('partial span', 5),
    outcome: { byteOffset: 400, incomplete: true }
  })
  await store.settled()
  await store.purgeOlderThan(null)

  expect(visibleMessages()).toBe(3)
  expect(cursor()).toBe(100)
  expect((index.db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n).toBe(3)
  expect(store.takeStale()).toHaveLength(1)
})

it('indexes nothing at all from a read that was incomplete from the start', async () => {
  replayTranscriptRead({
    messages: userMessages('unreachable', 4),
    outcome: { byteOffset: 0, incomplete: true }
  })
  await store.settled()
  await store.purgeOlderThan(null)

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 })
  expect(cursor()).toBeUndefined()
})

it('drops a file whose parser returned no session', async () => {
  replayTranscriptRead({ messages: userMessages('was indexed', 3), outcome: { byteOffset: 100 } })
  await store.settled()

  replayTranscriptRead({
    messages: userMessages('now rejected', 2),
    outcome: { session: null, byteOffset: 300 }
  })
  await store.settled()
  await store.purgeOlderThan(null)

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 })
  // The file is still read through, so a later scan does not re-read it.
  expect(cursor()).toBe(300)
})

it('ignores a candidate older than the retention cutoff', async () => {
  store.setRetentionCutoffMs(Date.now())
  replayTranscriptRead({ messages: userMessages('too old', 3) })
  await store.settled()

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  expect(store.takeStale()).toEqual([])
})

it('stops writing while the store refuses writes', async () => {
  store.setAcceptingWrites(false)
  replayTranscriptRead({ messages: userMessages('paused', 3) })
  await store.settled()

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  expect(errors).toEqual([])
})

it('keeps the session list running when the index write fails', async () => {
  replayTranscriptRead({ messages: userMessages('healthy', 2), outcome: { byteOffset: 100 } })
  await store.settled()
  index.db.exec('DROP TABLE messages_fts')

  expect(() =>
    replayTranscriptRead({
      mode: 'append',
      previousByteOffset: 100,
      messages: userMessages('broken', 400),
      outcome: { byteOffset: 500 }
    })
  ).not.toThrow()
  expect(store.failures).toBeGreaterThan(0)
  expect(store.takeStale()).toHaveLength(1)
})

it('unregisters cleanly, leaving later reads unindexed', async () => {
  resetTranscriptConsumersForTests()
  replayTranscriptRead({ messages: userMessages('after unregister', 3) })
  await store.settled()

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
})

it('drops a removed source and keeps its cursor gone', async () => {
  replayTranscriptRead({ messages: userMessages('present', 3), outcome: { byteOffset: 100 } })
  await store.settled()
  store.removeFile(SYNTHETIC_TRANSCRIPT)
  await store.purgeOlderThan(null)

  expect(cursor()).toBeUndefined()
  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 })
})

it('publishes the session metadata the read decoded', async () => {
  replayTranscriptRead({
    messages: userMessages('metadata', 1),
    outcome: {
      session: syntheticSession({
        sessionId: 'abc-123',
        title: 'a titled session',
        cwd: '/repo/app',
        branch: 'main',
        messageCount: 1,
        resumeCommand: 'claude --resume abc-123'
      }),
      byteOffset: 42
    }
  })
  await store.settled()

  expect(
    index.db
      .prepare(
        'SELECT session_id, title, cwd, cwd_key, branch, resume_command FROM visible_sessions'
      )
      .get()
  ).toEqual({
    session_id: 'abc-123',
    title: 'a titled session',
    cwd: '/repo/app',
    cwd_key: '/repo/app',
    branch: 'main',
    resume_command: 'claude --resume abc-123'
  })
})
