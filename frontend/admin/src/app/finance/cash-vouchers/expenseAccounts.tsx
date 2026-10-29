'use client'
// Every expense head (6xxx) of a voucher's company, for the finance pickers (owner, 2026-10-29: "In cash request,
// it's not showing all expense heads to select, fix it"). The voucher categories are a short list of common heads;
// finance may book to ANY active 6xxx account of the company — the API takes it as `accountCode` and runs its own
// checks (6xxx only, not cost of sales, the voucher's company). The chart read is the finance one
// (GET /setup/chart-of-accounts); a login that cannot read it just keeps the short list.
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'

interface ChartRow { code: string; name: string; isActive: boolean; tenantId: string | null }

export function useExpenseAccounts(tenantId: string | null | undefined, enabled = true) {
  const { data: chart = [] } = useQuery<ChartRow[]>({
    queryKey: ['chart-of-accounts'],
    queryFn: () => api.get('/setup/chart-of-accounts'),
    enabled,
    retry: false, meta: { background: true }, staleTime: 300_000,
  })
  return chart
    .filter((a) => /^6\d{3}$/.test(a.code) && a.isActive && (!tenantId || a.tenantId === tenantId))
    .sort((a, b) => a.code.localeCompare(b.code))
}

/** The options under the short category list: every other expense head, by code. */
export function ExpenseAccountOptions({ accounts, exclude }: { accounts: ChartRow[]; exclude: Set<string> }) {
  const rest = accounts.filter((a) => !exclude.has(a.code))
  if (rest.length === 0) return null
  return (
    <optgroup label="All expense accounts">
      {rest.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
    </optgroup>
  )
}
