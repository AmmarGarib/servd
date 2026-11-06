'use client'
// The ledger — every journal entry, newest first. THE transaction feed:
// GET /accounting/ledger (company-scoped, PKT dates). ?id=<entry> opens one
// entry (the Accounting hub's activity feed links here); ?accountId=<id>
// narrows to entries touching that account. Replaces the /finance
// Transactions tab (which called an endpoint that never existed) and the
// unused /finance/ledger, both of which listed the sales register instead of
// the books.
import { Button, Input } from '@/components/finance/ui'
import { Suspense, useMemo, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso, startOfMonthPktIso } from '../../../lib/money'
import { Select } from '@/components/ui/Select'
import { ExportMenu } from '@/components/ui/ExportMenu'
import { CompactEmptyState } from '@/components/ui/CompactEmptyState'

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
  /** Automatic voucher number (JV- / PV- / RV-), null for sales, till and non-cash entries. */
  voucherNo?: string | null
  description: string
  entryDate: string
  postedBy: string | null
  /** Plain details (owner, 2026-11-06): the narration, the source document, the typed cheque reference, the preparer's name. */
  particulars?: string
  sourceLabel?: string
  chequeReference?: string | null
  preparedBy?: string | null
  lines: LedgerLine[]
  // Manual entries only: the reversing entry, when there is one.
  reversedBy?: { id: string; entryDate: string } | null
}
interface LedgerPage { data: LedgerEntry[]; cursor: string | null; hasMore: boolean }
interface Account { id: string; code: string; name: string; isActive: boolean }

function pktDate(iso: string): string {
  return new Date(new Date(iso).getTime() + 5 * 3600_000).toISOString().slice(0, 10)
}

/** "Cash in hand" / "Cash in hand and 2 more" — the accounts on one side of an entry, by name. */
function sideNames(lines: LedgerLine[], type: 'debit' | 'credit'): string {
  const names = [...new Set(lines.filter((l) => l.type === type).map((l) => l.account.name))]
  if (names.length === 0) return '—'
  return names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

// One entry, kept readable for someone who is not an accountant (owner, 2026-11-06): what it was for, the document
// it came from, which accounts went up / down (debit / credit, by name), the amount and who prepared it — never the
// system key or a user id. Open it for every line.
function EntryCard({ e, open, onToggle }: { e: LedgerEntry; open: boolean; onToggle: () => void }) {
  const total = e.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
  const credits = e.lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amountCents, 0)
  const details = [
    e.sourceLabel,
    e.chequeReference ? `Ref ${e.chequeReference}` : null,
    e.preparedBy ? `Prepared by ${e.preparedBy}` : 'Posted automatically by servd',
  ].filter(Boolean).join(' · ')
  return (
    <div className="border-b border-s-border last:border-0">
      <button onClick={onToggle} aria-expanded={open} className="w-full text-left px-4 py-3 hover:bg-s-bg-soft flex flex-wrap sm:flex-nowrap items-start gap-x-3 gap-y-1">
        <span className="font-mono text-xs font-semibold text-s-text w-20 shrink-0">{e.voucherNo ?? '—'}</span>
        <span className="font-mono text-xs text-s-muted w-24 shrink-0">{pktDate(e.entryDate)}</span>
        <span className="order-last sm:order-none basis-full sm:basis-auto flex-1 min-w-0">
          <span className="block text-sm text-s-text sm:truncate">{e.particulars || e.description}</span>
          <span className="block text-xs text-s-muted sm:truncate">
            <span className="text-s-text/80">Debit:</span> {sideNames(e.lines, 'debit')}
            <span className="mx-1.5">→</span>
            <span className="text-s-text/80">Credit:</span> {sideNames(e.lines, 'credit')}
          </span>
          <span className="block text-xs text-s-muted sm:truncate">{details}</span>
        </span>
        {e.reference?.startsWith('manual.reversal:') && <span className="s-badge-muted shrink-0">Reversal</span>}
        {e.reversedBy && <span className="s-badge-amber shrink-0">Reversed {pktDate(e.reversedBy.entryDate)}</span>}
        <span className="font-mono text-xs text-s-text shrink-0 ml-auto sm:ml-0">{fmtPkr(total)}</span>
      </button>
      {open && (
        <div className="px-4 pb-3 overflow-x-auto">
          {e.particulars && e.particulars !== e.description && (
            <p className="text-xs text-s-muted mb-2 break-words">{e.description}</p>
          )}
          <table className="w-full min-w-[520px] text-xs">
            <thead className="text-s-muted">
              <tr>
                <th className="text-left py-1 pr-3">Account</th>
                <th className="text-left py-1 pr-3">Line description</th>
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
              <tr className="border-t border-s-border font-semibold">
                <td className="py-1 pr-3 text-s-text" colSpan={2}>Total</td>
                <td className="py-1 pr-3 text-right font-mono">{fmtPkr(total)}</td>
                <td className="py-1 text-right font-mono">{fmtPkr(credits)}</td>
              </tr>
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


  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
          <h1 className="text-xl font-bold text-s-text">Ledger</h1>
          <p className="text-xs text-s-muted">Every journal entry in the books, newest first.</p>
        </div>
        {entryId ? (
          <Button variant="secondary" type="submit" onClick={() => router.push('/accounting/ledger')}>Show all entries</Button>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/accounting/journal?tab=journals" className="s-btn-secondary text-sm">Journals</Link>
            {/* One account = the Journals → Accounts view (statement + open / edit / cancel any entry). */}
            <Select value={accountId} aria-label="Open an account"
              onChange={(e) => { if (e.target.value) router.push(`/accounting/journal?tab=accounts&accountId=${encodeURIComponent(e.target.value)}`); else setAccountId('') }}
              className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text max-w-[16rem]">
              <option value="">All accounts (pick one to open it)</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}{a.isActive ? '' : ' (inactive)'}</option>)}
            </Select>
            <Input className="w-auto px-2 py-1 text-sm" type="date" value={from} onChange={(e) => setFrom(e.target.value)}
               />
            <span className="text-s-muted text-xs">→</span>
            <Input className="w-auto px-2 py-1 text-sm" type="date" value={to} onChange={(e) => setTo(e.target.value)}
               />
            {/* An account picked: its statement (opening, running balance, closing). Otherwise the journal feed. */}
            {accountId && (
              <ExportMenu label="Account statement" path={`/accounting/ledger?dateFrom=${from}&dateTo=${to}&accountId=${accountId}&view=statement`}
                filename={`account-statement-${accounts.find((a) => a.id === accountId)?.code ?? 'account'}-${from}-${to}`} onError={(m) => setCsvError(m)} />
            )}
            <ExportMenu path={`/accounting/ledger?${query}&limit=20000`} filename={`ledger-${from}-${to}`} onError={(m) => setCsvError(m)} />
          </div>
        )}
      </header>

      <div className="p-6 max-w-5xl mx-auto space-y-3">
        {csvError && <p className="text-s-red text-sm">{csvError}</p>}
        {feed.isLoading && <p className="text-s-muted text-sm">Loading…</p>}
        {feed.error && <p className="text-s-red text-sm">{(feed.error as Error).message}</p>}
        {!feed.isLoading && entries.length === 0 && (
          <CompactEmptyState message={entryId ? 'That entry is not in the books you can see.' : 'No entries in this period.'} />
        )}
        {entries.length > 0 && (
          <div className="s-card overflow-hidden">
            {entries.map((e) => <EntryCard key={e.id} e={e} open={openIds.has(e.id)} onToggle={() => toggle(e.id)} />)}
          </div>
        )}
        {feed.hasNextPage && (
          <Button variant="secondary" type="submit" onClick={() => void feed.fetchNextPage()} disabled={feed.isFetchingNextPage}>
            {feed.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
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
