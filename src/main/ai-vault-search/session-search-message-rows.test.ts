import { expect, it } from 'vitest'
import type { TranscriptMessage } from '../ai-vault/session-transcript-consumers'
import {
  chunkMessageText,
  insertSearchMessage,
  searchMessageRows
} from './session-search-message-rows'
import {
  openSessionSearchIndexFile,
  type SessionSearchIndexFile
} from './session-search-staged-write-test-fixture'

const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
const PEM_BODY_LINE = 'MIIEowIBAAKCAQEAqhVmVvXTPQzWjkLmNbQxRfGhYuIoPlAsDfGhJkLzXcVbNmQw'
const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  ...Array.from({ length: 12 }, () => PEM_BODY_LINE),
  '-----END RSA PRIVATE KEY-----'
].join('\n')

async function indexOne(
  index: SessionSearchIndexFile,
  message: TranscriptMessage
): Promise<string[]> {
  index.db.exec('INSERT INTO search_write_batches(id,session_row_id) VALUES (1,1)')
  for (const row of searchMessageRows([message])) {
    insertSearchMessage(index.db, 1, 1, row)
  }
  // Every column of both tables, so an assertion cannot miss the shadow terms.
  const full = index.db
    .prepare('SELECT user_text, assistant_text, tool_text, identifiers FROM messages_fts')
    .all() as Record<string, string>[]
  const conversation = index.db
    .prepare('SELECT user_text, assistant_text FROM conversation_fts')
    .all() as Record<string, string>[]
  return [...full, ...conversation].flatMap((row) => Object.values(row))
}

it('splits an oversized message on a line boundary and keeps every character', () => {
  const line = `${'padding '.repeat(11)}word\n`
  const text = line.repeat(400)
  const chunks = chunkMessageText(text)

  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.join('')).toBe(text)
  for (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(8000)
    expect(chunk.endsWith('\n')).toBe(true)
  }
})

it('leaves a message that fits as a single row', () => {
  expect(chunkMessageText('short enough')).toEqual(['short enough'])
})

it('redacts a JWT that straddles the chunk boundary', async () => {
  const index = await openSessionSearchIndexFile('ss-rows-jwt')
  try {
    // No newline in the filler, so the boundary lands at exactly 8000 chars.
    const text = `${'a'.repeat(7960)}${JWT} trailing prose`
    // The bug this pins: chunk-then-redact sees two halves, neither a JWT.
    expect(chunkMessageText(text).some((chunk) => chunk.includes(JWT))).toBe(false)

    const stored = await indexOne(index, { role: 'assistant', text, timestamp: null })
    for (const half of [JWT.slice(0, 30), JWT.slice(-30), JWT]) {
      expect(stored.some((column) => column.includes(half))).toBe(false)
    }
    expect(stored.some((column) => column.includes('[redacted:jwt]'))).toBe(true)
    expect(stored.some((column) => column.includes('trailing prose'))).toBe(true)
  } finally {
    await index.close()
  }
})

it('redacts a PEM block that straddles the chunk boundary', async () => {
  const index = await openSessionSearchIndexFile('ss-rows-pem')
  try {
    const filler = `${'deployment notes for the staging worker'.padEnd(79)}\n`.repeat(97)
    const text = `${filler}${PEM}\nrollout finished`
    expect(chunkMessageText(text).some((chunk) => chunk.includes(PEM))).toBe(false)

    const stored = await indexOne(index, { role: 'tool', text, timestamp: null })
    expect(stored.some((column) => column.includes(PEM_BODY_LINE))).toBe(false)
    expect(stored.some((column) => column.includes('BEGIN RSA PRIVATE KEY'))).toBe(false)
    expect(stored.some((column) => column.includes('[redacted:pem]'))).toBe(true)
    expect(stored.some((column) => column.includes('rollout finished'))).toBe(true)
  } finally {
    await index.close()
  }
})

it('redacts before either FTS table sees the text', async () => {
  const index = await openSessionSearchIndexFile('ss-message-rows')
  try {
    const stored = await indexOne(index, {
      role: 'assistant',
      text: 'use AKIAIOSFODNN7EXAMPLE for the upload',
      timestamp: null
    })
    expect(stored.some((column) => column.includes('AKIAIOSFODNN7EXAMPLE'))).toBe(false)
    expect(
      stored.filter((column) => column.includes('[redacted:aws-access-key-id]')).length
    ).toBeGreaterThanOrEqual(2)
  } finally {
    await index.close()
  }
})

it('keeps a tool row out of the conversation half', async () => {
  const index = await openSessionSearchIndexFile('ss-message-rows-tool')
  try {
    index.db.exec('INSERT INTO search_write_batches(id,session_row_id) VALUES (1,1)')
    for (const row of searchMessageRows([
      { role: 'tool', text: 'rg pericardium', timestamp: null }
    ])) {
      insertSearchMessage(index.db, 1, 1, row)
    }
    expect(index.db.prepare('SELECT count(*) AS n FROM messages_fts').get()).toEqual({ n: 1 })
    expect(index.db.prepare('SELECT count(*) AS n FROM conversation_fts').get()).toEqual({ n: 0 })
  } finally {
    await index.close()
  }
})
