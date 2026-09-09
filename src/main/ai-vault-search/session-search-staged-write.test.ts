import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import type SyncDatabase from '../sqlite/sync-database'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { SEARCH_WRITE_ROWS_PER_STEP } from './session-search-index-writer'
import {
  openSessionSearchIndexFile,
  replayTranscriptRead,
  syntheticCandidate,
  syntheticSession,
  userMessages,
  type SessionSearchIndexFile
} from './session-search-staged-write-test-fixture'
import { SessionSearchStore } from './session-search-store'

let index: SessionSearchIndexFile
let store: SessionSearchStore
let errors: unknown[]

beforeEach(async () => {
  index = await openSessionSearchIndexFile('ss-staged-write')
  errors = []
  store = new SessionSearchStore(index.path, (error) => errors.push(error))
  registerSessionSearchIndexConsumer(store)
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  store.close()
  await index.close()
})

function counts(db: SyncDatabase): Record<string, number> {
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n
  return {
    sessions: one('SELECT count(*) AS n FROM visible_sessions'),
    messages: one('SELECT count(*) AS n FROM visible_messages'),
    rawMessages: one('SELECT count(*) AS n FROM messages'),
    batches: one('SELECT count(*) AS n FROM search_write_batches'),
    tombstones: one('SELECT count(*) AS n FROM search_pending_deletes'),
    full: one('SELECT count(*) AS n FROM messages_fts'),
    conversation: one('SELECT count(*) AS n FROM conversation_fts')
  }
}

it('publishes a whole read atomically and leaves no batch behind', async () => {
  replayTranscriptRead({ messages: userMessages('needle text', 300) })
  await store.settled()

  const after = counts(index.db)
  expect(after.sessions).toBe(1)
  expect(after.messages).toBe(300)
  expect(after.batches).toBe(0)
  expect(after.tombstones).toBe(0)
  expect(errors).toEqual([])
})

it('writes both FTS tables for every published conversational row', async () => {
  replayTranscriptRead({
    messages: [
      { role: 'user', text: 'alpha question', timestamp: null },
      { role: 'assistant', text: 'beta answer', timestamp: null },
      { role: 'tool', text: 'gamma tool output', timestamp: null }
    ]
  })
  await store.settled()

  // messages_fts carries every row; conversation_fts is the tool-free half.
  expect(counts(index.db).full).toBe(3)
  expect(counts(index.db).conversation).toBe(2)
  const matches = (table: string, term: string): number =>
    (
      index.db
        .prepare(
          `SELECT count(*) AS n FROM ${table} JOIN visible_messages m ON m.id = ${table}.rowid
           WHERE ${table} MATCH ?`
        )
        .get(term) as { n: number }
    ).n
  expect(matches('messages_fts', 'gamma')).toBe(1)
  expect(matches('conversation_fts', 'gamma')).toBe(0)
  expect(matches('conversation_fts', 'beta')).toBe(1)
})

it('hides staged rows from both halves until the read finishes', async () => {
  const candidate = syntheticCandidate()
  const staged = store.beginWrite(candidate, 'replace', 0)!
  for (const message of userMessages('stagedneedle', 200)) {
    staged.add(message)
  }

  // Rows really are on disk mid-read; only the views hold them back.
  const mid = counts(index.db)
  expect(mid.rawMessages).toBe(SEARCH_WRITE_ROWS_PER_STEP)
  expect(mid.messages).toBe(0)
  expect(mid.sessions).toBe(0)

  expect(staged.publish({ session: syntheticSession(), byteOffset: 4096, incomplete: false })).toBe(
    true
  )
  staged.discard()
  expect(counts(index.db).messages).toBe(200)
  expect(counts(index.db).sessions).toBe(1)
})

it('tombstones an abandoned batch instead of publishing half a file', async () => {
  const staged = store.beginWrite(syntheticCandidate(), 'replace', 0)!
  for (const message of userMessages('abandoned', 50)) {
    staged.add(message)
  }
  staged.discard()

  expect(counts(index.db).messages).toBe(0)
  expect(counts(index.db).sessions).toBe(0)
  await store.purgeOlderThan(null)
  expect(counts(index.db).rawMessages).toBe(0)
  expect(counts(index.db).tombstones).toBe(0)
})

it('recovers a batch its writer never finished when the store reopens', async () => {
  const staged = store.beginWrite(syntheticCandidate(), 'replace', 0)!
  for (const message of userMessages('crashed', 20)) {
    staged.add(message)
  }
  // No discard and no publish: the process died mid-write.
  store.close()

  const reopened = new SessionSearchStore(index.path, (error) => errors.push(error))
  try {
    expect(counts(index.db).sessions).toBe(0)
    expect(counts(index.db).messages).toBe(0)
    await reopened.purgeOlderThan(null)
    expect(counts(index.db).rawMessages).toBe(0)
    expect(counts(index.db).batches).toBe(0)
  } finally {
    reopened.close()
    store = new SessionSearchStore(index.path, (error) => errors.push(error))
  }
})

it('replaces the previous generation without ever showing both', async () => {
  replayTranscriptRead({ messages: userMessages('firstgeneration', 10) })
  await store.settled()
  replayTranscriptRead({ messages: userMessages('secondgeneration', 10) })
  await store.settled()
  await store.purgeOlderThan(null)

  expect(counts(index.db).sessions).toBe(1)
  expect(counts(index.db).messages).toBe(10)
  const hits = (term: string): number =>
    (
      index.db
        .prepare(
          `SELECT count(*) AS n FROM messages_fts JOIN visible_messages m ON m.id = messages_fts.rowid
           WHERE messages_fts MATCH ?`
        )
        .get(term) as { n: number }
    ).n
  expect(hits('firstgeneration')).toBe(0)
  expect(hits('secondgeneration')).toBe(10)
})
