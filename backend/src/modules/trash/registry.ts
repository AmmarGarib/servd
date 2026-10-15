// THE list of everything that can sit in the Trash (README.md). Keys are
// unique and every moduleId is a known module (tests/trashCore.test.ts).
import type { TrashProvider } from './types.js'
import { MASTER_TRASH_PROVIDERS } from './providers/masters/index.js'
import { TRANSACTION_TRASH_PROVIDERS } from './providers/transactions/index.js'

let extra: TrashProvider[] = []

function all(): TrashProvider[] {
  return [...MASTER_TRASH_PROVIDERS, ...TRANSACTION_TRASH_PROVIDERS, ...extra]
}

export function trashProviders(): readonly TrashProvider[] {
  return all()
}

export function trashProvider(key: string): TrashProvider | null {
  return all().find((p) => p.key === key) ?? null
}

/** Tests only: register a provider for the duration of a test file. */
export function __registerTestTrashProvider(p: TrashProvider): () => void {
  extra = [...extra, p]
  return () => { extra = extra.filter((x) => x !== p) }
}
