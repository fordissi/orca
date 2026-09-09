import { parserPublishesMessages } from '../ai-vault/session-scanner-agent-parser'
import {
  registerTranscriptConsumer,
  type TranscriptConsumer,
  type TranscriptMessage,
  type TranscriptReadConsumer,
  type TranscriptReadOutcome,
  type TranscriptReadStart
} from '../ai-vault/session-transcript-consumers'
import { fileIdentity } from './session-search-file-cursor'
import type { SessionSearchStagedWrite } from './session-search-index-writer'
import type { SessionSearchStore } from './session-search-store'

/**
 * The search index as a consumer of the transcript reader.
 *
 * It keeps its own cursor in the `files` table and never consults the parse
 * cache: the two answer different questions and diverge the moment either
 * declines a read. Three refusals, each of which leaves the cursor where it
 * was and records the file for a later whole re-read:
 *
 * - `beginRead` returns null when this index's cursor is behind the offset an
 *   `append` continues from, or when the file's identity changed.
 * - a staging failure stops the read's rows without failing the session list.
 * - an `incomplete` outcome never publishes; those rows are not the whole span.
 */
export class SessionSearchIndexConsumer implements TranscriptConsumer {
  constructor(private readonly store: SessionSearchStore) {}

  beginRead(start: TranscriptReadStart): TranscriptReadConsumer | null {
    const { candidate } = start
    if (!this.store.acceptsCandidate(candidate)) {
      return null
    }
    // A parser that decodes where the channel cannot reach it reports every read
    // as incomplete. Declining here is not the same as being behind: no re-read
    // would help, so the file is not recorded either.
    if (!parserPublishesMessages(candidate)) {
      return null
    }
    if (start.mode === 'append') {
      const cursor = this.store.indexedFile(candidate.file.path, fileIdentity(candidate.file))
      if (!cursor || cursor.byteOffset !== start.previousByteOffset) {
        // This index never saw the span before `previousByteOffset`; appending
        // here would leave a hole no later read can fill.
        this.store.markStale(candidate)
        return null
      }
    }
    const staged = this.store.beginWrite(candidate, start.mode, start.previousByteOffset)
    if (!staged) {
      this.store.markStale(candidate)
      return null
    }
    return new SessionSearchReadConsumer(this.store, start, staged)
  }
}

class SessionSearchReadConsumer implements TranscriptReadConsumer {
  private failed = false

  constructor(
    private readonly store: SessionSearchStore,
    private readonly start: TranscriptReadStart,
    private readonly staged: SessionSearchStagedWrite
  ) {}

  message(message: TranscriptMessage): void {
    if (this.failed) {
      return
    }
    try {
      this.staged.add(message)
    } catch (error) {
      // Never throws back into the reader: the channel would drop this consumer
      // for the rest of the read and `finish` would never run, stranding the
      // staged batch. Failing here keeps the cleanup on one path.
      this.failed = true
      this.store.reportWriteFailure(error)
    }
  }

  finish(outcome: TranscriptReadOutcome): void {
    const { candidate } = this.start
    try {
      // An incomplete read's rows are not the whole span, so the cursor must not
      // move past them; the file is re-read whole instead.
      if (this.failed || outcome.incomplete || !this.staged.publish(outcome)) {
        this.store.markStale(candidate)
        return
      }
      this.store.writePublished(candidate)
    } catch (error) {
      this.store.markStale(candidate)
      this.store.reportWriteFailure(error)
    } finally {
      this.staged.discard()
    }
  }
}

/**
 * Registers the index with the reader and returns the unregister function.
 * Nothing in production calls this yet: PR 3 owns when the index is live.
 */
export function registerSessionSearchIndexConsumer(store: SessionSearchStore): () => void {
  return registerTranscriptConsumer(new SessionSearchIndexConsumer(store))
}
