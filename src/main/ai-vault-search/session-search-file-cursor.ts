import type { FileWithMtime } from '../ai-vault/session-scanner-types'

// Why the index keeps its own cursor: the parse cache's cursor answers "what
// does the session list already show", which is a different question from "what
// bytes of this file are already rows". They diverge the moment either side
// declines a read, so neither may consult the other.

/** Filesystem identity, when discovery could prove it. */
export type SessionSearchFileIdentity = { dev: number; ino: number } | null

/** What the index holds for one transcript. */
export type SessionSearchIndexedFile = {
  byteOffset: number
  mtimeMs: number
  sizeBytes: number | null
}

export function fileIdentity(file: FileWithMtime): SessionSearchFileIdentity {
  return typeof file.dev === 'number' && typeof file.ino === 'number'
    ? { dev: file.dev, ino: file.ino }
    : null
}

/** True when the index already covers this file at its current stat. */
export function isSessionSearchFileCurrent(
  indexed: SessionSearchIndexedFile | null,
  file: FileWithMtime
): boolean {
  return (
    indexed !== null &&
    indexed.mtimeMs === file.mtimeMs &&
    (indexed.sizeBytes === null ||
      file.sizeBytes === undefined ||
      indexed.sizeBytes === file.sizeBytes)
  )
}
