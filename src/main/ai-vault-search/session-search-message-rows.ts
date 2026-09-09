import type SyncDatabase from '../sqlite/sync-database'
import type { TranscriptMessage } from '../ai-vault/session-transcript-consumers'
import { identifierShadowText } from './session-search-identifier-split'
import { redactSessionSearchText } from './session-search-redaction'

const CHUNK_TARGET_CHARS = 8000

declare const redactedRow: unique symbol

/**
 * A row whose text has been through `redactSessionSearchText`. Only
 * `searchMessageRows` can mint one, so no insert site can reach an FTS table
 * with raw transcript text.
 */
export type RedactedMessageRow = TranscriptMessage & { readonly [redactedRow]: true }

function* textChunks(text: string): Generator<string> {
  if (text.length <= CHUNK_TARGET_CHARS) {
    yield text
    return
  }
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_TARGET_CHARS)
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end)
      if (newline > start + CHUNK_TARGET_CHARS / 2) {
        end = newline + 1
      }
    }
    yield text.slice(start, end)
    start = end
  }
}

/**
 * One message becomes N rows: FTS5 ranks a short row far better than a huge one.
 *
 * Redaction happens here, over the whole message, before it is cut up. A
 * credential is a shape, and a shape split across two chunks matches neither
 * half: redacting per chunk indexed any PEM block or JWT that straddled the
 * boundary in full, identifier shadow terms included.
 */
export function* searchMessageRows(
  messages: Iterable<TranscriptMessage>
): Generator<RedactedMessageRow> {
  for (const message of messages) {
    const redacted = redactSessionSearchText(message.text)
    for (const text of textChunks(redacted)) {
      yield { ...message, text } as RedactedMessageRow
    }
  }
}

/**
 * Writes one row into `messages` and both FTS tables in the caller's
 * transaction, so a published message is never present in one table and absent
 * from the other. `tool` rows stay out of `conversation_fts`: that table is the
 * conversation-only half of the split.
 */
export function insertSearchMessage(
  db: SyncDatabase,
  sessionId: number,
  batchId: number,
  message: RedactedMessageRow
): void {
  const text = message.text
  const id = db
    .prepare('INSERT INTO messages(session_row_id, batch_id, role, ts) VALUES (?, ?, ?, ?)')
    .run(sessionId, batchId, message.role, message.timestamp).lastInsertRowid
  const user = message.role === 'user' ? text : ''
  const assistant = message.role === 'assistant' ? text : ''
  const tool = message.role === 'tool' ? text : ''
  db.prepare(
    'INSERT INTO messages_fts(rowid,user_text,assistant_text,tool_text,identifiers) VALUES (?,?,?,?,?)'
  ).run(id, user, assistant, tool, identifierShadowText(text))
  if (message.role !== 'tool') {
    db.prepare('INSERT INTO conversation_fts(rowid,user_text,assistant_text) VALUES (?,?,?)').run(
      id,
      user,
      assistant
    )
  }
}

export function chunkMessageText(text: string): string[] {
  return [...textChunks(text)]
}
