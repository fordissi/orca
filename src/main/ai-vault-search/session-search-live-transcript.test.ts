import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import SyncDatabase from '../sqlite/sync-database'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { SessionSearchStore } from './session-search-store'
import {
  assistantRecord,
  CLAUDE_SESSION_ID as SESSION_ID,
  CODEX_ROLLOUT_FILE,
  codexRolloutLines,
  parseTranscript,
  userRecord
} from './session-search-transcript-fixtures'

const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`

let tempRoots: string[] = []
let store: SessionSearchStore
// The store keeps its connection private, so row assertions need a second one.
let reader: SyncDatabase
let errors: unknown[]

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  errors = []
  const path = join(await makeTempDir(), 'index.sqlite')
  store = new SessionSearchStore(path, (error) => errors.push(error))
  registerSessionSearchIndexConsumer(store)
  reader = new SyncDatabase(path, { readonly: true })
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  reader.close()
  store.close()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeTempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-session-search-live-'))
  tempRoots.push(root)
  return root
}

/** Sessions a query over the published views would return for one FTS term. */
function sessionsMatching(term: string, table = 'messages_fts'): string[] {
  return (
    reader
      .prepare(
        `SELECT DISTINCT s.session_id AS id FROM ${table}
         JOIN visible_messages m ON m.id = ${table}.rowid
         JOIN visible_sessions s ON s.id = m.session_row_id
         WHERE ${table} MATCH ? ORDER BY s.session_id`
      )
      .all(term) as { id: string }[]
  ).map((row) => row.id)
}

it('indexes a Claude transcript through the reader and resumes on append', async () => {
  const root = await makeTempDir()
  const path = join(root, `${SESSION_ID}.jsonl`)
  await writeFile(
    path,
    `${[
      userRecord(0, 'find the flaky terminal reattach'),
      assistantRecord(1, 'look at resolveTerminalPath first')
    ].join('\n')}\n`
  )
  await parseTranscript(path)
  expect(errors).toEqual([])
  expect(sessionsMatching('reattach')).toEqual([SESSION_ID])
  // The identifier column shadows a camel-case symbol into its pieces.
  expect(sessionsMatching('terminal')).toEqual([SESSION_ID])

  await appendFile(path, `${assistantRecord(2, 'the zygomorphic follow-up landed')}\n`)
  const resumed = await parseTranscript(path)
  // The reader resumed, so the index saw an `append`, not a whole re-read.
  expect(resumed.stats).toMatchObject({ incremental: 1, fullParses: 0 })
  expect(errors).toEqual([])
  expect(sessionsMatching('zygomorphic')).toEqual([SESSION_ID])
  // An append extends one session rather than creating a second.
  expect(reader.prepare('SELECT count(*) AS n FROM visible_sessions').get()).toEqual({ n: 1 })
})

it('keeps a tool result searchable but out of the conversation half', async () => {
  const root = await makeTempDir()
  const codexHome = await makeTempDir()
  const path = join(root, CODEX_ROLLOUT_FILE)
  await writeFile(
    path,
    `${codexRolloutLines(
      ['rg', 'pericardium'],
      'src/main/pericardium.ts:12: match',
      'search for the pericardium module'
    ).join('\n')}\n`
  )
  await parseTranscript(path, 'codex', codexHome)
  expect(errors).toEqual([])

  expect(sessionsMatching('pericardium')).toHaveLength(1)
  // The prompt is conversation; the command output is not.
  expect(sessionsMatching('pericardium', 'conversation_fts')).toHaveLength(1)
  expect(sessionsMatching('rg', 'conversation_fts')).toHaveLength(0)
})

it('never indexes a credential that appeared in tool output', async () => {
  const root = await makeTempDir()
  const path = join(root, `${SESSION_ID}.jsonl`)
  await writeFile(
    path,
    `${[
      userRecord(0, 'deploy the staging worker'),
      userRecord(1, [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [
            'writing deployment credentials to the staging environment',
            `github_token=${GITHUB_TOKEN}`,
            'deployment finished with a green rollout'
          ].join('\n')
        }
      ])
    ].join('\n')}\n`
  )
  await parseTranscript(path)
  expect(errors).toEqual([])

  expect(sessionsMatching('credentials')).toEqual([SESSION_ID])
  expect(sessionsMatching('rollout')).toEqual([SESSION_ID])
  expect(sessionsMatching(`"${GITHUB_TOKEN}"`)).toEqual([])
  expect(sessionsMatching('redacted')).toEqual([SESSION_ID])
})
