import { afterEach, expect, it } from 'vitest'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import SyncDatabase from '../sqlite/sync-database'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexFile,
  replayTranscriptRead,
  SYNTHETIC_TRANSCRIPT,
  userMessages
} from './session-search-staged-write-test-fixture'
import { SessionSearchStore } from './session-search-store'
import { assertSearchWalBudget, SearchWalBackpressureError } from './session-search-wal-budget'

afterEach(() => {
  resetTranscriptConsumersForTests()
})

it('backpressures a pinned snapshot and resumes checkpoints after that reader releases', async () => {
  const index = await openSessionSearchIndexFile('ss-wal-budget')
  const reader = new SyncDatabase(index.path, { readonly: true })
  try {
    assertSearchWalBudget(index.db)
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) FROM sessions').get()
    index.db
      .prepare(
        'INSERT INTO sessions(agent,session_id,file_path,title,resume_command) VALUES (?,?,?,?,?)'
      )
      .run('claude', 'a', 'a', 'synthetic'.repeat(10000), '')
    expect(() => assertSearchWalBudget(index.db, 4096)).toThrow(SearchWalBackpressureError)
    reader.exec('COMMIT')
    expect(() => assertSearchWalBudget(index.db, 4096)).not.toThrow()
  } finally {
    reader.close()
    await index.close()
  }
})

it('retains the searchable generation and retries a backpressured read once the reader releases', async () => {
  const index = await openSessionSearchIndexFile('ss-wal-write')
  const errors: unknown[] = []
  const store = new SessionSearchStore(index.path, (error) => errors.push(error), {
    walBudgetBytes: 4096
  })
  registerSessionSearchIndexConsumer(store)
  const reader = new SyncDatabase(index.path, { readonly: true })
  const hits = (term: string): number =>
    (
      index.db
        .prepare(
          `SELECT count(*) AS n FROM messages_fts JOIN visible_messages m ON m.id = messages_fts.rowid
           WHERE messages_fts MATCH ?`
        )
        .get(term) as { n: number }
    ).n
  try {
    replayTranscriptRead({ messages: userMessages('oldneedle', 1), outcome: { byteOffset: 1 } })
    await store.settled()
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) FROM messages').get()

    replayTranscriptRead({
      mode: 'append',
      previousByteOffset: 1,
      messages: userMessages('newneedle', 1000),
      outcome: { byteOffset: 2 }
    })
    await store.settled()
    expect(store.failures).toBeGreaterThan(0)
    expect(store.pendingFileCount).toBe(1)
    // The published generation is untouched and the cursor has not moved.
    expect(hits('oldneedle')).toBe(1)
    expect(hits('newneedle')).toBe(0)
    expect(store.indexedFile(SYNTHETIC_TRANSCRIPT, null)?.byteOffset).toBe(1)

    reader.exec('COMMIT')
    replayTranscriptRead({
      mode: 'append',
      previousByteOffset: 1,
      messages: userMessages('newneedle', 1000),
      outcome: { byteOffset: 2 }
    })
    await store.settled()
    await store.purgeOlderThan(null)
    expect(hits('newneedle')).toBe(1000)
    expect(store.pendingFileCount).toBe(0)
    expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 1001 })
  } finally {
    reader.close()
    store.close()
    await index.close()
  }
})
