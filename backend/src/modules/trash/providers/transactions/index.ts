// Every voided / cancelled TRANSACTION type (strategy 'none') — read from each
// module's own status; "Recover as copy" only. Filled by the transactions
// build stream; the registry reads this list.
import type { TrashProvider } from '../../types.js'

export const TRANSACTION_TRASH_PROVIDERS: readonly TrashProvider[] = []
