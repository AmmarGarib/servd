'use client'
// Finance → Stock differences (H20 — owner decision 2026-10-14: suspense,
// the CEO clears).
//
// Waste and stock-count differences leave the shelves at once, but their
// cost waits in 1290 Stock Differences Suspense, with its reason, until the
// CEO approves it into cost of sales (waste → 5040, counts → 5050, dated the
// day of approval — a closed month is never changed). The CEO can also send
// a difference back with a note; it stays pending. Finance and management
// read the list (GET /accounting/stock-differences); only the CEO's buttons
// show (`canApprove` from the server, which also enforces it).
//
// Pending: grouped by outlet, then week (Monday), with totals. Select one
// company's lines and Approve. Cleared: what was approved, when, by whom.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'

// ─── Types (GET /accounting/stock-differences) ───────────────────────────────

type Kind = 'waste' | 'void_waste' | 'count'
type Status = 'pending' | 'cleared'

interface Row {
  lineId: string
  tenantId: string
  companyName: string | null
  reference: string
  kind: Kind
  direction: 'loss' | 'gain'
  valueCents: number
  entryDate: string
  month: string
  week: string
  conceptName: string | null
  locationId: string | null
  locationName: string | null
  itemName: string | null
  reason: string
  notes: string | null
  memo: string | null
  recordedByName: string | null
  status: Status
  queries: Array<{ note: string; byName: string | null; at: string }>
  cleared: { at: string; byName: string | null; account: string } | null
  clearingAccount: string
}

interface Page {
  rows: Row[]
  nextCursor: string | null
  totals: { count: number; lossCents: number; gainCents: number; netCents: number }
  canApprove: boolean
}

const KIND_LABEL: Record<Kind, string> = { waste: 'Waste', void_waste: 'Sold-line waste', count: 'Count' }
const BASE = '/accounting/stock-differences'

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-PK', { timeZone: 'Asia/Karachi', day: '2-digit', month: 'short', year: 'numeric' })
}
function weekLabel(monday: string): string {
  const d = new Date(`${monday}T00:00:00Z`)
  return `Week of ${d.toLocaleDateString('en-PK', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' })}`
}
const reasonText = (r: string) => r.replace(/_/g, ' ')

// ─── Page ────────────────────────────────────────────────────────────────────

export default function StockDifferencesPage() {
  const qc = useQueryClient()
  const [status, setStatus] = useState<Status>('pending')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)

  const list = useInfiniteQuery<Page>({
    queryKey: ['stock-differences', status],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.get<Page>(`${BASE}?status=${status}&limit=200${pageParam ? `&cursor=${encodeURIComponent(String(pageParam))}` : ''}`),
    getNextPageParam: (last) => last.nextCursor,
  })
  const pages = list.data?.pages ?? []
  const rows = useMemo(() => pages.flatMap((p) => p.rows), [pages])
  const totals = pages[0]?.totals
  const canApprove = pages[0]?.canApprove ?? false

  // Outlet → week → rows (newest week first, as the server orders them).
  const groups = useMemo(() => {
    const byOutlet = new Map<string, { label: string; weeks: Map<string, Row[]> }>()
    for (const r of rows) {
      const key = r.locationId ?? ''
      const label = r.locationName ?? 'No outlet (head office)'
      const g = byOutlet.get(key) ?? { label, weeks: new Map<string, Row[]>() }
      const w = g.weeks.get(r.week) ?? []
      w.push(r)
      g.weeks.set(r.week, w)
      byOutlet.set(key, g)
    }
    return [...byOutlet.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label))
  }, [rows])

  const selectedRows = rows.filter((r) => selected.has(r.lineId))
  const selectedCompanies = new Set(selectedRows.map((r) => r.tenantId))
  const selectedNet = selectedRows.reduce((t, r) => t + r.valueCents, 0)

  const refresh = () => {
    setSelected(new Set())
    qc.invalidateQueries({ queryKey: ['stock-differences'] })
  }
  const approve = useMutation({
    mutationFn: (lineIds: string[]) => api.post<{ cleared: unknown[]; alreadyCleared: string[]; clearedCents: number }>(`${BASE}/approve`, { lineIds }),
    onSuccess: (r) => {
      setNotice(`Approved ${r.cleared.length} difference${r.cleared.length === 1 ? '' : 's'} into cost of sales (${fmtPkr(r.clearedCents)} net)${r.alreadyCleared.length ? ` — ${r.alreadyCleared.length} were already approved` : ''}.`)
      refresh()
    },
  })

  const toggle = (ids: string[], on: boolean) => setSelected((s) => {
    const next = new Set(s)
    for (const id of ids) { if (on) next.add(id); else next.delete(id) }
    return next
  })

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-4 sm:px-7 py-6 border-b border-white/[0.05]">
        <Link href="/finance" className="text-xs text-white/40 hover:text-white/70">← Finance</Link>
        <p className="mt-2 text-[11px] font-bold uppercase tracking-wider text-success">Food cost</p>
        <h1 className="text-2xl font-black text-white/90">Stock differences</h1>
        <p className="text-sm text-white/45 mt-1 max-w-3xl">
          Waste and stock-count differences leave the shelves at once, but their cost waits in 1290 Stock Differences Suspense, with its reason,
          until the CEO approves it into cost of sales — waste to 5040, count differences to 5050, dated the day it is approved, so a closed month is
          never changed. The month-end close warns while anything still waits.
        </p>
        <div role="tablist" className="mt-4 flex gap-1 border-b border-white/[0.06]">
          {(['pending', 'cleared'] as const).map((s) => (
            <button key={s} role="tab" type="button" aria-selected={status === s}
              onClick={() => { setStatus(s); setSelected(new Set()); setNotice(null) }}
              className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold ${status === s ? 'text-white/90' : 'border-transparent text-white/45 hover:text-white/75'}`}
              style={status === s ? { borderColor: 'var(--erp-accent)' } : undefined}>
              {s === 'pending' ? 'Waiting for the CEO' : 'Approved'}
            </button>
          ))}
        </div>
      </header>

      <div className="px-4 sm:px-7 py-6 max-w-6xl mx-auto space-y-4">
        {totals && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label={status === 'pending' ? 'Waiting' : 'Approved'} value={String(totals.count)} />
            <Stat label="Losses" value={fmtPkr(totals.lossCents)} tone="danger" />
            <Stat label="Gains (count over)" value={fmtPkr(totals.gainCents)} tone="success" />
            <Stat label="Net to cost of sales" value={fmtPkr(totals.netCents)} />
          </div>
        )}

        {notice && <Banner tone="success" onClose={() => setNotice(null)}>{notice}</Banner>}
        {approve.error && <Banner tone="danger" onClose={() => approve.reset()}>{(approve.error as Error).message}</Banner>}
        {list.error && <Banner tone="danger">{(list.error as Error).message}</Banner>}

        {status === 'pending' && canApprove && rows.length > 0 && (
          <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3"
            style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
            <div className="text-sm text-white/70">
              {selectedRows.length === 0
                ? 'Select the differences to approve into cost of sales.'
                : `${selectedRows.length} selected · ${fmtPkr(selectedNet)} net`}
              {selectedCompanies.size > 1 && <span className="ml-2 font-semibold" style={{ color: 'var(--erp-warning)' }}>Pick one company&apos;s differences at a time.</span>}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => toggle(rows.map((r) => r.lineId), selectedRows.length < rows.length)}
                className="s-btn-secondary px-3 py-2">
                {selectedRows.length < rows.length ? 'Select all shown' : 'Clear selection'}
              </button>
              <button type="button"
                disabled={selectedRows.length === 0 || selectedCompanies.size > 1 || approve.isPending}
                onClick={() => {
                  if (window.confirm(`Approve ${selectedRows.length} difference${selectedRows.length === 1 ? '' : 's'} (${fmtPkr(selectedNet)} net) into cost of sales, dated today?`)) {
                    approve.mutate(selectedRows.map((r) => r.lineId))
                  }
                }}
                className="s-btn-primary px-4 py-2">
                {approve.isPending ? 'Approving…' : 'Approve'}
              </button>
            </div>
          </div>
        )}

        {list.isLoading && <p className="text-sm text-white/45">Loading…</p>}
        {!list.isLoading && rows.length === 0 && (
          <div className="rounded-2xl p-10 text-center" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
            <p className="font-bold text-white/85">{status === 'pending' ? 'Nothing is waiting' : 'Nothing approved yet'}</p>
            <p className="text-sm text-white/45 mt-1">{status === 'pending' ? 'Every waste and count difference has reached cost of sales.' : 'Approved differences show here.'}</p>
          </div>
        )}

        {groups.map(([key, g]) => {
          const outletRows = [...g.weeks.values()].flat()
          const outletNet = outletRows.reduce((t, r) => t + r.valueCents, 0)
          return (
            <section key={key || 'none'} className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
              <div className="flex items-center justify-between gap-3 px-4 py-3" style={{ background: 'rgb(var(--fg-rgb) / 0.03)' }}>
                <h2 className="font-black text-white/85">{g.label}</h2>
                <span className="text-sm font-bold text-white/70">{outletRows.length} · {fmtPkr(outletNet)}</span>
              </div>
              {[...g.weeks.entries()].map(([week, wr]) => (
                <div key={week}>
                  <div className="flex items-center justify-between gap-3 px-4 py-2 text-xs text-white/50 border-t border-white/[0.05]">
                    <label className="flex items-center gap-2">
                      {status === 'pending' && canApprove && (
                        <input type="checkbox" aria-label={`Select ${weekLabel(week)}`}
                          checked={wr.every((r) => selected.has(r.lineId))}
                          onChange={(e) => toggle(wr.map((r) => r.lineId), e.target.checked)} />
                      )}
                      <span className="font-semibold uppercase tracking-wider">{weekLabel(week)}</span>
                    </label>
                    <span>{fmtPkr(wr.reduce((t, r) => t + r.valueCents, 0))}</span>
                  </div>
                  <ul>
                    {wr.map((r) => (
                      <DifferenceRow key={r.lineId} row={r} canApprove={canApprove && status === 'pending'}
                        checked={selected.has(r.lineId)} onCheck={(on) => toggle([r.lineId], on)} onQueried={refresh} />
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          )
        })}

        {list.hasNextPage && (
          <button type="button" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}
            className="s-btn-secondary w-full px-4 py-2.5">
            {list.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  )
}

// ─── One difference ──────────────────────────────────────────────────────────

function DifferenceRow({ row: r, canApprove, checked, onCheck, onQueried }: {
  row: Row; canApprove: boolean; checked: boolean; onCheck: (on: boolean) => void; onQueried: () => void
}) {
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState('')
  const send = useMutation({
    mutationFn: () => api.post(`${BASE}/${encodeURIComponent(r.lineId)}/query`, { note: note.trim() }),
    onSuccess: () => { setAsking(false); setNote(''); onQueried() },
  })
  const loss = r.valueCents > 0
  return (
    <li className="px-4 py-3 border-t border-white/[0.04]">
      <div className="flex items-start gap-3">
        {canApprove && (
          <input type="checkbox" className="mt-1" aria-label={`Select ${r.itemName ?? r.reference}`} checked={checked} onChange={(e) => onCheck(e.target.checked)} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-white/85">{r.itemName ?? r.reference}</span>
            <span className="s-badge-purple text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full">{KIND_LABEL[r.kind]}</span>
            <span className="text-xs text-white/55">{reasonText(r.reason)}</span>
            {r.queries.length > 0 && r.status === 'pending' && (
              <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--erp-warning)' }}>Sent back</span>
            )}
          </div>
          <p className="text-xs text-white/45 mt-1">
            {fmtDay(r.entryDate)}
            {r.conceptName ? ` · ${r.conceptName}` : ' · head office'}
            {r.companyName ? ` · ${r.companyName}` : ''}
            {r.recordedByName ? ` · by ${r.recordedByName}` : ''}
            {` · to ${r.clearingAccount} on approval`}
          </p>
          {r.notes && <p className="text-xs text-white/55 mt-1">{r.notes}</p>}
          {r.queries.map((q, i) => (
            <p key={i} className="text-xs mt-1" style={{ color: 'var(--erp-warning)' }}>
              Sent back{q.byName ? ` by ${q.byName}` : ''} on {fmtDay(q.at)}: {q.note}
            </p>
          ))}
          {r.cleared && (
            <p className="text-xs text-success mt-1">
              Approved into {r.cleared.account} on {fmtDay(r.cleared.at)}{r.cleared.byName ? ` by ${r.cleared.byName}` : ''}
            </p>
          )}
          {asking && (
            <div className="mt-2 space-y-2">
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} autoFocus
                placeholder="What should the kitchen or finance check? (3–500 characters)"
                className="s-input" />
              {send.error && <p className="text-xs" style={{ color: 'var(--erp-danger)' }}>{(send.error as Error).message}</p>}
              <div className="flex gap-2">
                <button type="button" onClick={() => send.mutate()} disabled={send.isPending || note.trim().length < 3}
                  className="s-btn-primary px-3 py-1.5 text-xs">
                  {send.isPending ? 'Sending…' : 'Send back'}
                </button>
                <button type="button" onClick={() => { setAsking(false); setNote('') }} className="s-btn-secondary px-3 py-1.5 text-xs">Cancel</button>
              </div>
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="font-black" style={{ color: loss ? 'var(--erp-danger)' : 'var(--erp-success)' }}>
            {loss ? '' : '+'}{fmtPkr(Math.abs(r.valueCents))}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-white/40">{loss ? 'loss' : 'gain'}</div>
          {canApprove && !asking && (
            <button type="button" onClick={() => setAsking(true)} className="mt-1 text-xs text-primary-ink hover:underline">Send back</button>
          )}
        </div>
      </div>
    </li>
  )
}

// ─── Bits ────────────────────────────────────────────────────────────────────

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'danger' | 'success' }) {
  return (
    <div className="rounded-2xl p-4" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <div className="text-[11px] uppercase tracking-wider text-white/45">{label}</div>
      <div className="text-lg font-black mt-1" style={{ color: tone === 'danger' ? 'var(--erp-danger)' : tone === 'success' ? 'var(--erp-success)' : undefined }}>{value}</div>
    </div>
  )
}

function Banner({ tone, children, onClose }: { tone: 'success' | 'danger'; children: React.ReactNode; onClose?: () => void }) {
  const c = tone === 'success' ? 'var(--erp-success)' : 'var(--erp-danger)'
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className="flex items-start justify-between gap-3 rounded-xl px-4 py-3 text-sm"
      style={{ color: c, background: `color-mix(in srgb, ${c} 8%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 30%, transparent)` }}>
      <span>{children}</span>
      {onClose && <button type="button" onClick={onClose} aria-label="Dismiss" className="opacity-70 hover:opacity-100">✕</button>}
    </div>
  )
}
