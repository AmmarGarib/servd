// Current / non-current — the ONE reading of an asset or liability account's term (owner, 2026-10-31: "Add sub
// categories for Assets and liabilities as Current/Non-Current assets/liabilities to break asset list in current non
// current"). Stored on Account.classification when finance or the CEO picks it; otherwise the default below.
// Revenue, expense and equity accounts have no term (null).
//
// Defaults by code (the leading four digits):
//   assets       1500–1599 fixed assets + their accumulated depreciation, 1360 refundable security deposits and
//                1600+ → non-current; every other asset → current
//   liabilities  below 2200 → current; 2200+ (e.g. 2210 Due to Garibsons) → non-current

export type AccountTerm = 'current' | 'non_current'
export const ACCOUNT_TERMS: readonly AccountTerm[] = ['current', 'non_current']
export const TERM_LABEL: Record<AccountTerm, string> = { current: 'Current', non_current: 'Non-current' }

const lead = (code: string): number | null => {
  const m = /^\s*(\d{4})(?!\d)/.exec(code)
  return m ? Number(m[1]) : null
}

export function defaultTermOf(code: string, type: string): AccountTerm | null {
  const n = lead(code)
  if (type === 'asset') {
    if (n == null) return 'current'
    return (n >= 1500 && n <= 1599) || n === 1360 || n >= 1600 ? 'non_current' : 'current'
  }
  if (type === 'liability') return n != null && n >= 2200 ? 'non_current' : 'current'
  return null
}

/** The account's term: the stored pick, else the default. Null for revenue / expense / equity. */
export function termOf(a: { code: string; type: string; classification?: string | null }): AccountTerm | null {
  if (a.type !== 'asset' && a.type !== 'liability') return null
  return a.classification === 'current' || a.classification === 'non_current' ? a.classification : defaultTermOf(a.code, a.type)
}
