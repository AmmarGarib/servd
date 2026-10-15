// Every master-data Trash provider, by domain. One file per build stream; the
// registry (../../registry.ts) reads this list — never a second one.
import type { TrashProvider } from '../../types.js'
import { MENU_TRASH_PROVIDERS } from './menu.js'
import { COMPANY_TRASH_PROVIDERS } from './company.js'
import { SETUP_TRASH_PROVIDERS } from './setup.js'
import { MARKETING_TRASH_PROVIDERS } from './marketing.js'
import { PEOPLE_TRASH_PROVIDERS } from './people.js'
import { FINANCE_TRASH_PROVIDERS } from './finance.js'

export const MASTER_TRASH_PROVIDERS: readonly TrashProvider[] = [
  ...MENU_TRASH_PROVIDERS,
  ...COMPANY_TRASH_PROVIDERS,
  ...SETUP_TRASH_PROVIDERS,
  ...MARKETING_TRASH_PROVIDERS,
  ...PEOPLE_TRASH_PROVIDERS,
  ...FINANCE_TRASH_PROVIDERS,
]
