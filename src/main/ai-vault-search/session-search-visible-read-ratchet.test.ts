import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { VISIBLE_MESSAGES, VISIBLE_SESSIONS } from './session-search-schema'

// Why a ratchet and not a type: publish makes a read's rows visible atomically,
// but it does that by flipping `batch_id` and `index_ready`, not by moving the
// FTS rows — those land in the staging flushes. An FTS table on its own still
// holds staged and tombstoned rows, and only the views subtract them. Every read
// site has to join one, and nothing in SQL can force that.
//
// The unit is the file, not the statement: `'SELECT rowid FROM ' + table` and a
// `${TABLE}` interpolation both hide the table name from any per-literal scan.

const FTS_TABLE = /\b(?:messages_fts|conversation_fts)\b/
const SELECT = /\bSELECT\b/i
const VISIBLE_VIEW = new RegExp(
  `\\b(?:${VISIBLE_MESSAGES}|${VISIBLE_SESSIONS}|VISIBLE_MESSAGES|VISIBLE_SESSIONS)\\b`
)

/**
 * Modules that name an FTS table next to a SELECT without reading published
 * rows. Every entry needs a reason, and the census below fails on an entry that
 * has stopped being necessary.
 */
// The schema module is not here: it names both views while declaring them, so
// it satisfies the rule outright rather than needing an exemption.
const ALLOWED: Record<string, string> = {
  'session-search-retention-delete.ts':
    'deletes by rowid, and deliberately reaches staged and tombstoned rows'
}

export function readsFtsWithoutView(text: string): boolean {
  return FTS_TABLE.test(text) && SELECT.test(text) && !VISIBLE_VIEW.test(text)
}

async function sourceFiles(root: string): Promise<{ name: string; text: string }[]> {
  const out: { name: string; text: string }[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (
        !entry.name.endsWith('.ts') ||
        entry.name.endsWith('.test.ts') ||
        entry.name.endsWith('-test-fixture.ts')
      ) {
        continue
      }
      out.push({ name: entry.name, text: await readFile(path, 'utf-8') })
    }
  }
  await walk(root)
  return out
}

it('flags the shapes a per-statement scan would miss', () => {
  const literal = String.raw`db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?')`
  expect(readsFtsWithoutView(literal)).toBe(true)

  // Concatenation: the table name never appears inside the SELECT literal.
  const concatenated = String.raw`const t = 'messages_fts'; db.prepare('SELECT rowid FROM ' + t)`
  expect(readsFtsWithoutView(concatenated)).toBe(true)

  // Interpolation: same, through a template.
  const interpolated = String.raw`const TABLE = 'conversation_fts'; db.prepare(\`SELECT rowid FROM ${'${TABLE}'}\`)`
  expect(readsFtsWithoutView(interpolated)).toBe(true)

  const joined = String.raw`db.prepare(\`SELECT s.id FROM conversation_fts
    JOIN visible_messages m ON m.id = conversation_fts.rowid\`)`
  expect(readsFtsWithoutView(joined)).toBe(false)

  // A module that only deletes from an FTS table is not a read site.
  expect(
    readsFtsWithoutView(String.raw`db.prepare('DELETE FROM messages_fts WHERE rowid = ?')`)
  ).toBe(false)
})

it('reads every FTS table through a visibility view across main and relay', async () => {
  const roots = ['src/main', 'src/relay']
  const files = (await Promise.all(roots.map((root) => sourceFiles(root)))).flat()
  expect(files.length).toBeGreaterThan(500)
  // The scan really reaches the modules that name these tables.
  expect(files.filter((file) => FTS_TABLE.test(file.text)).length).toBeGreaterThanOrEqual(
    Object.keys(ALLOWED).length
  )

  const offenders = files
    .filter((file) => readsFtsWithoutView(file.text) && !(file.name in ALLOWED))
    .map((file) => file.name)
  expect(offenders).toEqual([])

  // A stale exemption is an unguarded read waiting to happen.
  const unused = Object.keys(ALLOWED).filter(
    (name) => !files.some((file) => file.name === name && readsFtsWithoutView(file.text))
  )
  expect(unused).toEqual([])
})
