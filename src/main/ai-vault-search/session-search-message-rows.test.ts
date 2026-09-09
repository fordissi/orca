import { expect, it } from 'vitest'
import { chunkMessageText, insertSearchMessage } from './session-search-message-rows'
import { openSessionSearchIndexFile } from './session-search-staged-write-test-fixture'

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

it('redacts before either FTS table sees the text', async () => {
  const index = await openSessionSearchIndexFile('ss-message-rows')
  try {
    index.db.exec('INSERT INTO search_write_batches(id,session_row_id) VALUES (1,1)')
    insertSearchMessage(index.db, 1, 1, {
      role: 'assistant',
      text: 'use AKIAIOSFODNN7EXAMPLE for the upload',
      timestamp: null
    })
    for (const table of ['messages_fts', 'conversation_fts']) {
      const row = index.db.prepare(`SELECT assistant_text AS text FROM ${table}`).get() as {
        text: string
      }
      expect(row.text).toBe('use [redacted:aws-access-key-id] for the upload')
    }
  } finally {
    await index.close()
  }
})

it('keeps a tool row out of the conversation half', async () => {
  const index = await openSessionSearchIndexFile('ss-message-rows-tool')
  try {
    index.db.exec('INSERT INTO search_write_batches(id,session_row_id) VALUES (1,1)')
    insertSearchMessage(index.db, 1, 1, { role: 'tool', text: 'rg pericardium', timestamp: null })
    expect(index.db.prepare('SELECT count(*) AS n FROM messages_fts').get()).toEqual({ n: 1 })
    expect(index.db.prepare('SELECT count(*) AS n FROM conversation_fts').get()).toEqual({ n: 0 })
  } finally {
    await index.close()
  }
})
