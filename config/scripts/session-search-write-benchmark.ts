import assert from 'node:assert/strict'
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from '../../src/main/ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../../src/main/ai-vault/session-transcript-consumers'
import { registerSessionSearchIndexConsumer } from '../../src/main/ai-vault-search/session-search-index-consumer'
import { SessionSearchStore } from '../../src/main/ai-vault-search/session-search-store'
import { writeSyntheticTranscriptCorpus } from '../../src/main/ai-vault-search/session-search-synthetic-corpus'
import { sessionCandidate } from '../../src/main/ai-vault-search/session-search-transcript-fixtures'
import SyncDatabase from '../../src/main/sqlite/sync-database'

// The cost model owed to the two-FTS-table decision. Everything runs through the
// real transcript reader and SessionSearchStore over a synthetic corpus, so the
// numbers include tokenization, the identifier shadow column, both FTS tables and
// the post-write cleanup a live index pays for. Never point this at a real
// transcript tree.

/** Staging flushes synchronously, so a peer chain samples the gap each read leaves. */
async function sampleLoopStalls(running: () => boolean, stalls: number[]): Promise<void> {
  let previous = performance.now()
  while (running()) {
    await yieldToEventLoop()
    const now = performance.now()
    stalls.push(now - previous)
    previous = now
  }
}

function tableBytes(db: SyncDatabase): Record<string, number> {
  const rows = db.prepare('SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name').all() as {
    name: string
    bytes: number
  }[]
  const group = (prefix: string): number =>
    rows
      .filter((row) => row.name === prefix || row.name.startsWith(`${prefix}_`))
      .reduce((sum, row) => sum + row.bytes, 0)
  return {
    messagesFts: group('messages_fts'),
    conversationFts: group('conversation_fts'),
    messages: group('messages') - group('messages_fts'),
    sessions: group('sessions'),
    total: rows.reduce((sum, row) => sum + row.bytes, 0)
  }
}

const corpus = await writeSyntheticTranscriptCorpus()
const indexPath = join(corpus.root, 'index.sqlite')
try {
  const errors: unknown[] = []
  const store = new SessionSearchStore(indexPath, (error) => errors.push(error))
  const unregister = registerSessionSearchIndexConsumer(store)
  const stalls: number[] = []
  let indexing = true
  try {
    const stats = createSessionParseStats()
    const started = performance.now()
    const sampler = sampleLoopStalls(() => indexing, stalls)
    for (const path of corpus.files) {
      await parseAgentSessionFileCached(
        await sessionCandidate('claude', path),
        process.platform,
        stats
      )
    }
    indexing = false
    await sampler
    const rebuildMs = performance.now() - started
    assert.deepEqual(errors, [])

    const reader = new SyncDatabase(indexPath, { readonly: true })
    try {
      const rows = (
        reader.prepare('SELECT count(*) AS n FROM visible_messages').get() as { n: number }
      ).n
      const sessions = (
        reader.prepare('SELECT count(*) AS n FROM visible_sessions').get() as {
          n: number
        }
      ).n
      assert.equal(sessions, corpus.files.length)
      const bytes = tableBytes(reader)
      const perMb = (value: number): number =>
        Math.round((value / (corpus.transcriptBytes / (1024 * 1024))) * 10) / 10
      const fileBytes = (await stat(indexPath)).size
      stalls.sort((a, b) => a - b)
      console.log(
        JSON.stringify(
          {
            platform: process.platform,
            node: process.version,
            transcriptMb: Math.round((corpus.transcriptBytes / (1024 * 1024)) * 100) / 100,
            sessions,
            rows,
            rebuildMs: Math.round(rebuildMs),
            rowsPerSecond: Math.round(rows / (rebuildMs / 1000)),
            transcriptMbPerSecond:
              Math.round((corpus.transcriptBytes / (1024 * 1024) / (rebuildMs / 1000)) * 100) / 100,
            bytesPerTranscriptMb: {
              messagesFts: perMb(bytes.messagesFts),
              conversationFts: perMb(bytes.conversationFts),
              messages: perMb(bytes.messages),
              sessions: perMb(bytes.sessions),
              total: perMb(bytes.total)
            },
            writeAmplification: Math.round((bytes.total / corpus.transcriptBytes) * 100) / 100,
            fileWriteAmplification: Math.round((fileBytes / corpus.transcriptBytes) * 100) / 100,
            maxLoopStallMs: Math.round(stalls.at(-1) ?? 0),
            p95LoopStallMs: Math.round(stalls[Math.floor(stalls.length * 0.95)] ?? 0),
            loopStallSamples: stalls.length,
            parseStats: stats
          },
          null,
          2
        )
      )
    } finally {
      reader.close()
    }
  } finally {
    indexing = false
    unregister()
    resetTranscriptConsumersForTests()
    resetSessionParseCacheForTests()
    store.close()
  }
} finally {
  await rm(corpus.root, { recursive: true, force: true })
}
