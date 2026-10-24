'use client'
// The Accounts view (owner, 2026-10-23): open any chart-of-accounts account and
// see every entry parked in it — opening balance, each line with a running
// balance, closing balance — and open / edit / cancel any entry from the row.
// It is THE account statement: GET /accounting/ledger?view=statement. An account
// with sub-accounts shows its sub-ledger summary first; a click on one opens
// that sub-account's own statement (subAccountId).
import { useMemo, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { fmtPkr, startOfMonthPktIso, todayPktIso } from '../../../lib/money'
import { Button, ErrorBanner, Input, LinkButton } from '@/components/finance/ui'
import { Select } from '@/components/ui/Select'
import { ExportMenu } from '@/components/ui/ExportMenu'
import { CompactEmptyState } from '@/components/ui/CompactEmptyState'
import { AccountPicker, StatusBadge, readableDescription } from './JournalBits'
import { pktDate, type Brand, type ChartAccount, type EntryFlags } from './journalTypes'

interface StLine extends Partial<EntryFlags> {
  date: string
  lineId: string
  entryId: string
  conceptId: string | null
  voucherNo: string | null
  sourceType: string | null
  description: string
  /** The document's own narration (owner, 2026-10-24) — shown instead of the system text. */
  particulars?: string
  reference: string | null
  memo: string | null
  debitCents: number
  creditCents: number
  balanceCents: number
}
interface SubRow {
  id: string | null; name: string; code: string | null; kind: string | null; employeeId: string | null; isActive: boolean
  openingCents: number; debitCents: number; creditCents: number; closingCents: number
}
interface Statement {
  account: { id: string; code: string; name: string; type: string; normal: 'debit' | 'credit'; companyName: string | null }
  subAccount?: { id: string; name: string; code: string | null } | null
  subAccounts: SubRow[]
  dateFrom: string
  dateTo: string
  openingCents: number
  closingCents: number
  totals: { debitCents: number; creditCents: number }
  lines: StLine[]
  truncated: boolean
  pageOpeningCents: number
  nextCursor: string | null
  hasMore: boolean
}

export function AccountsTab({ accountId, onAccountChange, onOpen }: {
  accountId: string
  onAccountChange: (id: string) => void
  onOpen: (entryId: string) => void
}) {
  const [picked, setPicked] = useState<ChartAccount | null>(null)
  const [from, setFrom] = useState(startOfMonthPktIso())
  const [to, setTo] = useState(todayPktIso())
  const [brandId, setBrandId] = useState('')
  const [subId, setSubId] = useState('')
  const [exportErr, setExportErr] = useState<string | null>(null)

  const { data: brands = [] } = useQuery<Brand[]>({ queryKey: ['concepts', 'picker'], queryFn: () => api.get('/concepts?view=picker') })

  const query = useMemo(() => {
    const sp = new URLSearchParams({ view: 'statement', accountId, from, to })
    if (brandId) sp.set('brandId', brandId)
    if (subId) sp.set('subAccountId', subId)
    return sp.toString()
  }, [accountId, from, to, brandId, subId])

  const st = useInfiniteQuery({
    queryKey: ['account-statement', query],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.get<Statement>(`/accounting/ledger?${query}&limit=200${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : null),
    enabled: !!accountId,
  })
  const pages = st.data?.pages ?? []
  const first = pages[0]
  const last = pages[pages.length - 1]
  const lines = pages.flatMap((p) => p.lines)
  const subs = first?.subAccounts ?? []
  const selectedAccount: ChartAccount | null = picked && picked.id === accountId ? picked
    : first ? { id: first.account.id, tenantId: null, code: first.account.code, name: first.account.name, type: first.account.type, isActive: true } : null

  function pick(a: ChartAccount | null) {
    setPicked(a); setSubId(''); onAccountChange(a?.id ?? '')
  }

  return (
    <section className="space-y-3 min-w-0" aria-label="Accounts">
      <div className="s-card p-3 space-y-2">
        <p className="text-xs text-s-muted">Search the chart, pick an account, and see every entry in it. Click an entry to open, edit or cancel it.</p>
        <AccountPicker value={accountId} onPick={pick} selected={selectedAccount} />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
          <label className="text-xs text-s-muted">From
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 py-1 text-sm" />
          </label>
          <label className="text-xs text-s-muted">To
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 py-1 text-sm" />
          </label>
          <label className="text-xs text-s-muted">Brand
            <Select value={brandId} onChange={(e) => setBrandId(e.target.value)} className="s-select mt-1 py-1 text-sm">
              <option value="">All brands</option>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </label>
        </div>
      </div>

      {!accountId && <CompactEmptyState message="Pick an account to see its entries." />}
      {accountId && st.isLoading && <p className="text-sm text-s-muted">Loading…</p>}
      {st.error && <ErrorBanner message={(st.error as Error).message} />}
      {exportErr && <ErrorBanner message={exportErr} />}

      {first && last && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-s-text">
                <span className="font-mono text-s-muted mr-2">{first.account.code}</span>{first.account.name}
                {first.subAccount && <span className="text-s-muted"> › {first.subAccount.name}</span>}
              </h2>
              <p className="text-xs text-s-muted">{first.account.companyName ? `${first.account.companyName} · ` : ''}{first.dateFrom} to {first.dateTo} · balance shown as {first.account.normal === 'debit' ? 'debit' : 'credit'}-normal</p>
            </div>
            <ExportMenu label="Export" path={`/accounting/ledger?${query}`} filename={`account-statement-${first.account.code}-${from}-${to}`}
              onError={setExportErr} className="s-btn-secondary text-xs px-3 py-1.5" />
          </div>

          {first.subAccount && (
            <LinkButton tone="primary" size="md" onClick={() => setSubId('')}>← All of {first.account.name}</LinkButton>
          )}

          {!first.subAccount && subs.length > 0 && (
            <div className="s-card overflow-hidden">
              <div className="px-4 py-2 border-b border-s-border bg-s-bg-soft">
                <h3 className="text-xs font-bold uppercase tracking-wider text-s-muted">Sub-accounts</h3>
                <p className="text-xs text-s-muted">Click one to see its own statement. Unassigned is what is not tagged to a sub-account.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[32rem]">
                  <thead className="text-s-muted">
                    <tr>
                      <th className="text-left font-medium py-1.5 px-3">Sub-account</th>
                      <th className="text-right font-medium py-1.5 px-3">Opening</th>
                      <th className="text-right font-medium py-1.5 px-3">Debits</th>
                      <th className="text-right font-medium py-1.5 px-3">Credits</th>
                      <th className="text-right font-medium py-1.5 px-3">Closing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subs.map((s) => (
                      <tr key={s.id ?? 'unassigned'} className="border-t border-s-border">
                        <td className="py-1.5 px-3">
                          {s.id ? (
                            <LinkButton type="button" onClick={() => setSubId(s.id!)}>{s.name}</LinkButton>
                          ) : <span className="text-s-muted">{s.name}</span>}
                          {s.code && <span className="ml-1 font-mono text-s-muted">{s.code}</span>}
                          {!s.isActive && <span className="ml-1 s-badge-muted">Off</span>}
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono whitespace-nowrap">{fmtPkr(s.openingCents)}</td>
                        <td className="py-1.5 px-3 text-right font-mono whitespace-nowrap">{fmtPkr(s.debitCents)}</td>
                        <td className="py-1.5 px-3 text-right font-mono whitespace-nowrap">{fmtPkr(s.creditCents)}</td>
                        <td className="py-1.5 px-3 text-right font-mono whitespace-nowrap font-semibold">{fmtPkr(s.closingCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="s-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[44rem]">
                <thead className="text-s-muted">
                  <tr>
                    <th className="text-left font-medium py-1.5 px-3">Date</th>
                    <th className="text-left font-medium py-1.5 px-3">Particulars</th>
                    <th className="text-right font-medium py-1.5 px-3">Debit</th>
                    <th className="text-right font-medium py-1.5 px-3">Credit</th>
                    <th className="text-right font-medium py-1.5 px-3">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-s-border bg-s-bg-soft">
                    <td className="py-1.5 px-3 text-s-muted" colSpan={4}>Opening balance</td>
                    <td className="py-1.5 px-3 text-right font-mono whitespace-nowrap font-semibold">{fmtPkr(first.openingCents)}</td>
                  </tr>
                  {lines.map((l) => (
                    <tr key={l.lineId} className="border-t border-s-border align-top cursor-pointer hover:bg-s-bg-soft" onClick={() => onOpen(l.entryId)}>
                      <td className="py-1.5 px-3 font-mono text-s-muted whitespace-nowrap">{pktDate(l.date)}</td>
                      <td className="py-1.5 px-3 min-w-0">
                        <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(l.entryId) }} className="text-left text-s-text hover:underline">
                          {l.voucherNo && <span className="font-mono font-semibold mr-1">{l.voucherNo}</span>}{l.particulars ?? readableDescription(l.description)}
                        </button>
                        {l.memo && <span className="block text-s-muted">{l.memo}</span>}
                        {l.status && l.status !== 'live' && <span className="mt-0.5 inline-block"><StatusBadge status={l.status} /></span>}
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono whitespace-nowrap">{l.debitCents ? fmtPkr(l.debitCents) : ''}</td>
                      <td className="py-1.5 px-3 text-right font-mono whitespace-nowrap">{l.creditCents ? fmtPkr(l.creditCents) : ''}</td>
                      <td className="py-1.5 px-3 text-right font-mono whitespace-nowrap">{fmtPkr(l.balanceCents)}</td>
                    </tr>
                  ))}
                  {lines.length === 0 && (
                    <tr className="border-t border-s-border"><td colSpan={5} className="py-4 px-3 text-center text-s-muted">No entries in this period.</td></tr>
                  )}
                </tbody>
                <tfoot className="border-t border-s-border font-semibold">
                  <tr>
                    <td className="py-1.5 px-3" colSpan={2}>{st.hasNextPage ? 'Totals (whole period)' : 'Totals'}</td>
                    <td className="py-1.5 px-3 text-right font-mono whitespace-nowrap">{fmtPkr(first.totals.debitCents)}</td>
                    <td className="py-1.5 px-3 text-right font-mono whitespace-nowrap">{fmtPkr(first.totals.creditCents)}</td>
                    <td />
                  </tr>
                  <tr>
                    <td className="py-1.5 px-3" colSpan={4}>Closing balance</td>
                    <td className="py-1.5 px-3 text-right font-mono whitespace-nowrap">{fmtPkr(last.closingCents)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
          {first.truncated && <p className="text-xs text-s-muted">This statement stops at the line limit — narrow the dates for the rest.</p>}
          {st.hasNextPage && (
            <Button variant="secondary" onClick={() => void st.fetchNextPage()} disabled={st.isFetchingNextPage}>
              {st.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </>
      )}
    </section>
  )
}
