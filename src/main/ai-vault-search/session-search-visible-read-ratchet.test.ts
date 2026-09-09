import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { VISIBLE_MESSAGES, VISIBLE_SESSIONS } from './session-search-schema'

// Why a ratchet and not a type: publish makes a read's rows visible atomically,
// but it does that by flipping `batch_id` and `index_ready`, not by moving the
// FTS rows — those land in the staging flushes. An FTS table on its own still
// holds staged and tombstoned rows, and only the views subtract them. Every read
// site has to join one, and nothing in SQL can force that.

const FTS_TABLES = /\b(?:messages_fts|conversation_fts)\b/
// The view by its resolved name or by the constant a module interpolates.
const VISIBLE_VIEW = new RegExp(
  `\\b(?:${VISIBLE_MESSAGES}|${VISIBLE_SESSIONS}|VISIBLE_MESSAGES|VISIBLE_SESSIONS)\\b`
)
const STRING_LITERAL = /`(?:[^`\\]|\\[\s\S])*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g

/** SQL literals in `source` that read an FTS table without subtracting staged rows. */
export function unguardedFtsReads(source: string): string[] {
  const offenders: string[] = []
  for (const [literal] of source.matchAll(STRING_LITERAL)) {
    if (!/\bSELECT\b/i.test(literal) || !FTS_TABLES.test(literal)) {
      continue
    }
    if (!VISIBLE_VIEW.test(literal)) {
      offenders.push(literal.replaceAll(/\s+/g, ' ').slice(0, 120))
    }
  }
  return offenders
}

async function productionSources(): Promise<{ name: string; text: string }[]> {
  const dir = import.meta.dirname
  const names = (await readdir(dir)).filter(
    (name) =>
      name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('-test-fixture.ts')
  )
  return Promise.all(
    names.map(async (name) => ({ name, text: await readFile(join(dir, name), 'utf-8') }))
  )
}

it('flags a read of an FTS table that does not subtract staged rows', () => {
  const bare = String.raw`db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?')`
  expect(unguardedFtsReads(bare)).toHaveLength(1)

  const joined = String.raw`db.prepare(\`SELECT s.id FROM conversation_fts
    JOIN visible_messages m ON m.id = conversation_fts.rowid
    WHERE conversation_fts MATCH ?\`)`
  expect(unguardedFtsReads(joined)).toEqual([])

  // A delete is not a read: retention removes staged rows on purpose.
  expect(
    unguardedFtsReads(String.raw`db.prepare('DELETE FROM messages_fts WHERE rowid = ?')`)
  ).toEqual([])
  // Two statements in one file must not blur into one match.
  expect(
    unguardedFtsReads(
      String.raw`db.prepare('SELECT path FROM files'); db.prepare('INSERT INTO messages_fts(rowid) VALUES (?)')`
    )
  ).toEqual([])
})

it('reads every FTS table through a visibility view across the index modules', async () => {
  const sources = await productionSources()
  expect(sources.length).toBeGreaterThan(10)
  // Pointed at the real corpus, so a query module is covered the moment it lands.
  expect(sources.some((file) => FTS_TABLES.test(file.text))).toBe(true)

  const offenders = sources.flatMap((file) =>
    unguardedFtsReads(file.text).map((statement) => `${file.name}: ${statement}`)
  )
  expect(offenders).toEqual([])
})
