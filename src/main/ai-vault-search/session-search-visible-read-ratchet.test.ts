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
// The unit is one SQL statement, not one file. A file is far too coarse: the
// query module this exists for will name both views somewhere, and that would
// whitelist every raw read in it.

const FTS_TABLE = /\b(?:messages_fts|conversation_fts)\b/
const SELECT = /\bSELECT\b/i
const VISIBLE_VIEW = new RegExp(
  `\\b(?:${VISIBLE_MESSAGES}|${VISIBLE_SESSIONS}|VISIBLE_MESSAGES|VISIBLE_SESSIONS)\\b`
)
// A table name this scan cannot read: `FROM ' + table` or `FROM ${table}`.
const DYNAMIC_TABLE = /\b(?:FROM|JOIN)\s*(?:\$\{|$)/i
// A literal, plus any literals concatenated onto it: one statement, not several.
const SQL_FRAGMENT =
  /(?:`(?:[^`\\]|\\[\s\S])*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")(?:\s*\+\s*(?:`(?:[^`\\]|\\[\s\S])*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"))*/g

/** Statement-sized spans of SQL text, with the quotes and the `+` joins removed. */
export function sqlStatements(source: string): string[] {
  const statements: string[] = []
  for (const [fragment] of source.matchAll(SQL_FRAGMENT)) {
    const sql = fragment
      .split(/\s*\+\s*/)
      .map((part) => part.slice(1, -1))
      .join('')
    statements.push(...sql.split(';'))
  }
  return statements
}

/**
 * Reads that could return a staged or tombstoned row. A statement whose table
 * name is assembled at runtime counts only in a file that names an FTS table
 * somewhere, which is the shape a concatenated or interpolated read takes.
 */
export function unguardedFtsReads(source: string): string[] {
  const fileNamesFts = FTS_TABLE.test(source)
  return sqlStatements(source).filter((statement) => {
    if (!SELECT.test(statement) || VISIBLE_VIEW.test(statement)) {
      return false
    }
    return FTS_TABLE.test(statement) || (fileNamesFts && DYNAMIC_TABLE.test(statement))
  })
}

/**
 * Statements that read an FTS table without subtracting staged rows and are
 * allowed to. Every entry needs a reason, and the census fails on one that has
 * stopped being necessary.
 */
const ALLOWED: Record<string, string> = {}

const ROOTS = ['src/main', 'src/relay', 'src/cli', 'src/shared', 'src/preload']

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

it('flags a raw read and the two shapes that hide the table name', () => {
  expect(
    unguardedFtsReads(
      String.raw`db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?')`
    )
  ).toHaveLength(1)

  // Concatenated: the table name is never inside the SELECT literal.
  expect(
    unguardedFtsReads(String.raw`const t = 'messages_fts'; db.prepare('SELECT rowid FROM ' + t)`)
  ).toHaveLength(1)

  // Interpolated: same, through a template.
  expect(
    unguardedFtsReads(
      // A plain double-quoted string, so the ${...} reaches the checker verbatim.
      "const TABLE = 'conversation_fts'; db.prepare(`SELECT rowid FROM ${TABLE}`)"
    )
  ).toHaveLength(1)

  // Concatenated literals are one statement, so the join is seen.
  expect(
    unguardedFtsReads(
      String.raw`db.prepare('SELECT rowid FROM messages_fts JOIN ' + 'visible_messages m ON m.id = rowid')`
    )
  ).toEqual([])
})

it('flags a raw read in a file that names a view somewhere else entirely', () => {
  // The shape a file-level scan cannot see: the view name is real, but it is in
  // an unrelated string, so it guards nothing.
  const source = String.raw`
    const LABEL = 'visible_messages is the published half'
    export function hits(db: Db) {
      return db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all()
    }
  `
  const offenders = unguardedFtsReads(source)
  expect(offenders).toHaveLength(1)
  expect(offenders[0]).toContain('messages_fts')
})

it('leaves a joined read alone even next to a raw table name in a delete', () => {
  const source = String.raw`
    const purge = db.prepare('DELETE FROM messages_fts WHERE rowid = ?')
    const read = db.prepare('SELECT m.id FROM conversation_fts JOIN visible_messages m ON m.id = conversation_fts.rowid')
  `
  expect(unguardedFtsReads(source)).toEqual([])
})

it('reads every FTS table through a visibility view across every bundled root', async () => {
  const files = (await Promise.all(ROOTS.map((root) => sourceFiles(root)))).flat()
  expect(files.length).toBeGreaterThan(500)
  // The scan really reaches the modules that name these tables.
  expect(files.some((file) => FTS_TABLE.test(file.text))).toBe(true)

  const offenders = files
    .filter((file) => unguardedFtsReads(file.text).length > 0 && !(file.name in ALLOWED))
    .map((file) => file.name)
  expect(offenders).toEqual([])

  // A stale exemption is an unguarded read waiting to happen.
  const unused = Object.keys(ALLOWED).filter(
    (name) => !files.some((file) => file.name === name && unguardedFtsReads(file.text).length > 0)
  )
  expect(unused).toEqual([])
})
