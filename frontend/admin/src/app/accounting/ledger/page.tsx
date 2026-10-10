'use client'
// The ledger — every journal entry, newest first. THE transaction feed:
// GET /accounting/ledger (company-scoped, PKT dates). ?id=<entry> opens one
// entry (the Accounting hub's activity feed links here); ?accountId=<id>
// narrows to entries touching that account. Replaces the /finance
// Transactions tab (which called an endpoint that never existed) and the
// unused /finance/ledger, both of which listed the sales register instead of
// the books.
import { Suspense, useMemo, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso, startOfMonthPktIso } from '../../../lib/money'

interface LedgerLine {
  id: string
  type: 'debit' | 'credit'
  amountCents: number
  memo: string | null
  conceptId: string | null
  account: { code: string; name: string; type: string }
}
interface LedgerEntry {
  id: string
  reference: string | null
  description: string
  entryDate: string
  postedBy: string | null
  lines: LedgerLine[]
  // Manual entries only: the reversing entry, when there is one.
  reversedBy?: { id: string; entryDate: string } | null
}
interface LedgerPage { data: LedgerEntry[]; cursor: string | null; hasMore: boolean }
interface Account { id: string; code: string; name: string; isActive: boolean }

function pktDate(iso: string): string {
  return new Date(new Date(iso).getTime() + 5 * 3600_000).toISOString().slice(0, 10)
}

function EntryCard({ e, open, onToggle }: { e: LedgerEntry; open: boolean; onToggle: () => void }) {
  const total = e.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
  return (
    <div className="border-b border-s-border last:border-0">
      <button onClick={onToggle} className="w-full text-left px-4 py-3 hover:bg-s-bg-soft flex items-start gap-3">
        <span className="font-mono text-xs text-s-muted w-24 shrink-0">{pktDate(e.entryDate)}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm text-s-text truncate">{e.description}</span>
          <span className="block text-[11px] text-s-dim font-mono truncate">{e.reference ?? `#${e.id.slice(0, 8)}`} · by {e.postedBy ?? 'system'}</span>
        </span>
        {e.reference?.startsWith('manual.reversal:') && <span className="s-badge-muted shrink-0">Reversal</span>}
        {e.reversedBy && <span className="s-badge-amber shrink-0">Reversed {pktDate(e.reversedBy.entryDate)}</span>}
        <span className="font-mono text-xs text-s-text shrink-0">{fmtPkr(total)}</span>
      </button>
      {open && (
        <div className="px-4 pb-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-s-muted">
              <tr>
                <th className="text-left py-1 pr-3">Account</th>
                <th className="text-left py-1 pr-3">Memo</th>
                <th className="text-right py-1 pr-3">Debit</th>
                <th className="text-right py-1">Credit</th>
              </tr>
            </thead>
            <tbody>
              {e.lines.map((l) => (
                <tr key={l.id} className="border-t border-s-border/50">
                  <td className="py-1 pr-3 text-s-text"><span className="font-mono text-s-muted mr-2">{l.account.code}</span>{l.account.name}</td>
                  <td className="py-1 pr-3 text-s-muted">{l.memo ?? ''}</td>
                  <td className="py-1 pr-3 text-right font-mono">{l.type === 'debit' ? fmtPkr(l.amountCents) : ''}</td>
                  <td className="py-1 text-right font-mono">{l.type === 'credit' ? fmtPkr(l.amountCents) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function LedgerView() {
  const params = useSearchParams()
  const router = useRouter()
  const entryId = params.get('id')
  const [from, setFrom] = useState(startOfMonthPktIso())
  const [to, setTo] = useState(todayPktIso())
  const [accountId, setAccountId] = useState(params.get('accountId') ?? '')
  const [openIds, setOpenIds] = useState<Set<string>>(new Set(entryId ? [entryId] : []))
  const [csvError, setCsvError] = useState<string | null>(null)

  const { data: accounts = [] } = useQuery<Account[]>({
    queryKey: ['chart-of-accounts'],
    queryFn: () => api.get('/setup/chart-of-accounts'),
  })

  const query = useMemo(() => {
    const sp = new URLSearchParams()
    if (entryId) sp.set('id', entryId)
    else {
      sp.set('dateFrom', from); sp.set('dateTo', to)
      if (accountId) sp.set('accountId', accountId)
    }
    return sp.toString()
  }, [entryId, from, to, accountId])

  const feed = useInfiniteQuery({
    queryKey: ['ledger', query],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.get<LedgerPage>(`/accounting/ledger?${query}&limit=50${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (last) => (last.hasMore ? last.cursor : null),
  })
  const entries = (feed.data?.pages ?? []).flatMap((p) => p.data)

  function toggle(id: string) {
    const next = new Set(openIds)
    if (next.has(id)) next.delete(id); else next.add(id)
    setOpenIds(next)
  }

  async function exportCsv() {
    setCsvError(null)
    try { await api.download(`/accounting/ledger?${query}&limit=1000&format=csv`, `ledger-${from}-${to}.csv`) }
    catch (e) { setCsvError((e as Error).message) }
  }

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
          <h1 className="text-xl font-bold text-s-text">Ledger</h1>
          <p className="text-xs text-s-muted">Every journal entry in the books, newest first.</p>
        </div>
        {entryId ? (
          <button onClick={() => router.push('/accounting/ledger')} className="s-btn-secondary text-sm">Show all entries</button>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/accounting/journal" className="s-btn-secondary text-sm">Journal entry</Link>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}
              className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text max-w-[16rem]">
              <option value="">All accounts</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}{a.isActive ? '' : ' (inactive)'}</option>)}
            </select>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text" />
            <span className="text-s-muted text-xs">→</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text" />
            <button onClick={() => void exportCsv()} className="s-btn-secondary text-sm">Export CSV</button>
          </div>
        )}
      </header>

      <div className="p-6 max-w-5xl mx-auto space-y-3">
        {csvError && <p className="text-s-red text-sm">{csvError}</p>}
        {feed.isLoading && <p className="text-s-muted text-sm">Loading…</p>}
        {feed.error && <p className="text-s-red text-sm">{(feed.error as Error).message}</p>}
        {!feed.isLoading && entries.length === 0 && (
          <div className="s-card p-8 text-center text-sm text-s-muted">{entryId ? 'That entry is not in the books you can see.' : 'No entries in this period.'}</div>
        )}
        {entries.length > 0 && (
          <div className="s-card overflow-hidden">
            {entries.map((e) => <EntryCard key={e.id} e={e} open={openIds.has(e.id)} onToggle={() => toggle(e.id)} />)}
          </div>
        )}
        {feed.hasNextPage && (
          <button onClick={() => void feed.fetchNextPage()} disabled={feed.isFetchingNextPage} className="s-btn-secondary text-sm">
            {feed.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  )
}

export default function LedgerPage() {
  return (
    <Suspense fallback={<div className="p-12 text-center text-sm text-s-muted">Loading…</div>}>
      <LedgerView />
    </Suspense>
  )
}
