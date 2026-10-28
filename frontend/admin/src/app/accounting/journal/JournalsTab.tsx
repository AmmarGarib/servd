'use client'
// The Journals register (owner, 2026-10-23): every journal in one place —
// Manual / Payment / Receipt / All — to find an entry in no time.
// GET /accounting/journals (cursor paging, ?format= exports the same filter).
import { useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'
import { Button, CheckLabel, ErrorBanner, Input } from '@/components/finance/ui'
import { Select } from '@/components/ui/Select'
import { ExportMenu } from '@/components/ui/ExportMenu'
import { CompactEmptyState } from '@/components/ui/CompactEmptyState'
import { AccountPicker, StatusBadge, readableDescription } from './JournalBits'
import { pktDate, rupeesToCents, type Brand, type RegRow } from './journalTypes'

type View = 'manual' | 'payment' | 'receipt' | 'all'
const VIEWS: Array<[View, string]> = [['manual', 'Manual'], ['payment', 'Payment'], ['receipt', 'Receipt'], ['all', 'All']]

interface Page { view: View; rows: RegRow[]; nextCursor: string | null; hasMore: boolean }

export function JournalsTab({ onOpen }: { onOpen: (row: RegRow) => void }) {
  const [view, setView] = useState<View>('manual')
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [accountCode, setAccountCode] = useState('')
  const [brandId, setBrandId] = useState('')
  const [min, setMin] = useState('')
  const [max, setMax] = useState('')
  const [includeSales, setIncludeSales] = useState(false)
  const [exportErr, setExportErr] = useState<string | null>(null)

  // Search as you type, after a short pause.
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 350)
    return () => clearTimeout(t)
  }, [text])

  const { data: brands = [] } = useQuery<Brand[]>({ queryKey: ['concepts', 'picker'], queryFn: () => api.get('/concepts?view=picker') })

  const minC = rupeesToCents(min)
  const maxC = rupeesToCents(max)
  const amountBad = minC === null || maxC === null

  const query = useMemo(() => {
    const sp = new URLSearchParams({ view })
    if (q) sp.set('q', q)
    if (from) sp.set('from', from)
    if (to) sp.set('to', to)
    if (accountCode) sp.set('accountCode', accountCode)
    if (brandId) sp.set('brandId', brandId)
    if (typeof minC === 'number') sp.set('minCents', String(minC))
    if (typeof maxC === 'number') sp.set('maxCents', String(maxC))
    if (view === 'receipt' && includeSales) sp.set('includeSales', '1')
    return sp.toString()
  }, [view, q, from, to, accountCode, brandId, minC, maxC, includeSales])

  const feed = useInfiniteQuery({
    queryKey: ['journals', query],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.get<Page>(`/accounting/journals?${query}&limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : null),
    enabled: !amountBad,
  })
  const rows = (feed.data?.pages ?? []).flatMap((p) => p.rows)

  return (
    <section className="space-y-3 min-w-0" aria-label="Journals">
      <div role="group" aria-label="Journal kind" className="flex flex-wrap gap-1.5">
        {VIEWS.map(([k, label]) => (
          <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${view === k ? 'border-transparent' : 'border-s-border text-s-muted hover:text-s-text'}`}
            style={view === k ? { background: 'rgb(var(--erp-accent-rgb) / 0.2)', color: 'var(--erp-success)' } : undefined}>
            {label}
          </button>
        ))}
      </div>
      <p className="text-xs text-s-muted">
        {view === 'manual' && 'Entries typed in by hand — opening balances, accruals, corrections.'}
        {view === 'payment' && 'Entries that pay money out of cash or a bank (vouchers, bills, payroll, petty cash…).'}
        {view === 'receipt' && 'Entries that bring money into cash or a bank. Sales and till entries are left out unless you tick the box.'}
        {view === 'all' && 'Every entry in the books.'}
      </p>

      <div className="s-card p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 items-end">
        <label className="text-xs text-s-muted min-w-0 sm:col-span-2">Search
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Voucher no, description, reference" className="mt-1 py-1 text-sm" />
        </label>
        <label className="text-xs text-s-muted">From
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 py-1 text-sm" />
        </label>
        <label className="text-xs text-s-muted">To
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 py-1 text-sm" />
        </label>
        <div className="text-xs text-s-muted min-w-0 sm:col-span-2">Account
          <div className="mt-1">
            <AccountPicker value={accountCode} valueKey="code" onPick={(a) => setAccountCode(a?.code ?? '')} />
          </div>
        </div>
        <label className="text-xs text-s-muted">Brand
          <Select value={brandId} onChange={(e) => setBrandId(e.target.value)} className="s-select mt-1 py-1 text-sm">
            <option value="">All brands</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-s-muted">Min PKR
            <Input inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} className="mt-1 py-1 text-sm text-right font-mono" aria-invalid={minC === null || undefined} />
          </label>
          <label className="text-xs text-s-muted">Max PKR
            <Input inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} className="mt-1 py-1 text-sm text-right font-mono" aria-invalid={maxC === null || undefined} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-4">
          {view === 'receipt' && (
            <CheckLabel><input type="checkbox" className="accent-accent" checked={includeSales} onChange={(e) => setIncludeSales(e.target.checked)} />Include sales and till entries</CheckLabel>
          )}
          {amountBad && <span role="alert" className="text-xs text-s-red">Amounts: digits, up to 2 decimals</span>}
          <span className="ml-auto">
            <ExportMenu path={`/accounting/journals?${query}`} filename={`journals-${view}`} onError={setExportErr} disabled={amountBad} className="s-btn-secondary text-xs px-3 py-1.5" />
          </span>
        </div>
      </div>

      {exportErr && <ErrorBanner message={exportErr} />}
      {feed.error && <ErrorBanner message={(feed.error as Error).message} />}
      {feed.isLoading && <p className="text-sm text-s-muted">Loading…</p>}
      {!feed.isLoading && !feed.error && rows.length === 0 && <CompactEmptyState message="No journal entries match these filters." />}

      {rows.length > 0 && (
        <div className="s-card overflow-hidden">
          {rows.map((r) => <JournalRow key={r.id} r={r} onOpen={() => onOpen(r)} />)}
        </div>
      )}
      {feed.hasNextPage && (
        <Button variant="secondary" onClick={() => void feed.fetchNextPage()} disabled={feed.isFetchingNextPage}>
          {feed.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </section>
  )
}

function JournalRow({ r, onOpen }: { r: RegRow; onOpen: () => void }) {
  const net = r.moneyNetCents
  return (
    <button type="button" onClick={onOpen} className="w-full text-left px-4 py-3 hover:bg-s-bg-soft border-b border-s-border last:border-0 flex flex-wrap items-start gap-x-3 gap-y-1">
      <span className="font-mono text-xs font-semibold text-s-text w-20 shrink-0">{r.voucherNo ?? '—'}</span>
      <span className="font-mono text-xs text-s-muted w-24 shrink-0">{pktDate(r.entryDate)}</span>
      <span className="flex-1 min-w-[12rem]">
        <span className="block text-sm text-s-text truncate">{readableDescription(r.description)}</span>
        <span className="block text-xs text-s-muted truncate">
          {r.counterSummary ?? r.lines.map((l) => `${l.accountCode} ${l.type === 'debit' ? 'Dr' : 'Cr'}`).join(' · ')}
          {r.brands.length > 0 && <> · {r.brands.map((b) => b.name).join(', ')}</>}
          {r.postedBy && <> · by {r.postedBy.name}</>}
          {r.companyName && <> · {r.companyName}</>}
        </span>
      </span>
      <StatusBadge status={r.status} reversedBy={r.reversedBy} reverses={r.reverses} />
      <span className="font-mono text-xs shrink-0 text-right min-w-[6rem]" style={{ color: net > 0 ? 'var(--erp-success)' : net < 0 ? 'var(--erp-danger)' : 'var(--text)' }}>
        {net > 0 ? `In ${fmtPkr(net)}` : net < 0 ? `Out ${fmtPkr(-net)}` : fmtPkr(r.totalCents)}
      </span>
    </button>
  )
}
