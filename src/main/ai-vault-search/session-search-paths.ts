import { join } from 'node:path'

// Why: like the parse cache, the index path is captured once at the composition
// root from the canonical userData dir; every export is a no-op until then.
let databasePath: string | null = null

export function initSessionSearchPaths(userDataPath: string): void {
  databasePath = join(userDataPath, 'ai-vault-search', 'index.sqlite')
}

export function getSessionSearchDatabasePath(): string | null {
  return databasePath
}

export function resetSessionSearchPathsForTests(): void {
  databasePath = null
}
