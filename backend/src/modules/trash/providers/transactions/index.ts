// Every voided / cancelled TRANSACTION type (strategy 'none') — read from each
// module's own status; "Recover as copy" only — plus the F1–F5 money records
// (never restored, never erased). The registry reads this list.
import type { TrashProvider } from '../../types.js'
import { ORDER_TRASH_PROVIDERS } from './orders.js'
import { RESERVATION_TRASH_PROVIDERS } from './reservations.js'
import { STOCK_TRASH_PROVIDERS } from './stock.js'
import { PROCUREMENT_TRASH_PROVIDERS } from './procurement.js'
import { RECEIVABLE_TRASH_PROVIDERS } from './receivables.js'
import { CASH_VOUCHER_TRASH_PROVIDERS } from './cashVouchers.js'
import { JOURNAL_TRASH_PROVIDERS } from './journal.js'
import { INTERCOMPANY_TRASH_PROVIDERS } from './intercompany.js'
import { FIXED_ASSET_TRASH_PROVIDERS } from './fixedAssets.js'
import { HEAD_OFFICE_TRASH_PROVIDERS } from './headOffice.js'
import { HR_TRASH_PROVIDERS } from './hr.js'
import { CONTENT_TRASH_PROVIDERS } from './content.js'
import { CONNECTOR_TRASH_PROVIDERS } from './connectors.js'
import { MONEY_SNAPSHOT_TRASH_PROVIDERS } from './moneySnapshots.js'

export const TRANSACTION_TRASH_PROVIDERS: readonly TrashProvider[] = [
  ...ORDER_TRASH_PROVIDERS,
  ...RESERVATION_TRASH_PROVIDERS,
  ...STOCK_TRASH_PROVIDERS,
  ...PROCUREMENT_TRASH_PROVIDERS,
  ...RECEIVABLE_TRASH_PROVIDERS,
  ...CASH_VOUCHER_TRASH_PROVIDERS,
  ...JOURNAL_TRASH_PROVIDERS,
  ...INTERCOMPANY_TRASH_PROVIDERS,
  ...FIXED_ASSET_TRASH_PROVIDERS,
  ...HEAD_OFFICE_TRASH_PROVIDERS,
  ...HR_TRASH_PROVIDERS,
  ...CONTENT_TRASH_PROVIDERS,
  ...CONNECTOR_TRASH_PROVIDERS,
  ...MONEY_SNAPSHOT_TRASH_PROVIDERS,
]
