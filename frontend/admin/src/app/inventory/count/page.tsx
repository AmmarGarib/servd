'use client'
// Physical count — spot counts and the opening count.
//
// This is the ONLY way to set stock on hand by hand (owner decision 28): the
// Inventory page's +/- and bulk "set to" are gone, and every change comes from
// a count (this page, which keeps the PhysicalCount record), a waste log or a
// delivery.
//
//  • Spot — pick items (or ask for a suggestion: a weighted random sample of
//    high-value, fast-moving stock that has not been counted this week), enter
//    what is on the shelf. Every line that differs from the books needs a
//    reason (owner decision H20; the API refuses without one) — a short count
//    is drawn off the oldest stock (FIFO), an over-count is added at the latest
//    purchase price. Counted by the kitchen and its managers.
//  • Opening — stock found by the FIRST count of an item that was never
//    received or counted. It is booked to the owner's capital (not cost of
//    sales), at the unit cost typed here (default: the item's cost estimate).
//    Only finance, the CEO and management may make one — the page asks the API
//    (GET /crosschecks/physical-counts/capabilities), there is no role list here.
//
// Every save answers with the books result: green when the entry posted, red
// when the count is saved but its ledger entry was refused.

import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { fmtPkrWhole } from '../../../lib/money'
import { stockErrorText, errorCode } from '../../../lib/stockUi'

interface InventoryItem {
  id: string; name: string; unit: string; currentStock: number
  unitCostCents?: number | null
  costSource?: 'deliveries' | 'opening' | null
  tenantId?: string | null
  costsHidden?: boolean
}
interface Capabilities { canSpotCount: boolean; canOpeningCount: boolean; costsHidden: boolean }
interface SuggestedItem { id: string; name: string; unit: string; onHandQty: number; onHandValueCents?: number }
interface LocationRow { id: string; name: string; isActive?: boolean; tenant?: { name: string } | null }
interface Ledger { posted: boolean; entryId?: string; reason?: string; error?: string }
interface CountResult {
  count: { id: string }
  lines: Array<{ inventoryItemId: string; systemQty: number; physicalQty: number; reason: string | null }>
  ledger: Ledger
}
interface DraftLine { qty: string; reason: string; costPkr: string }

type Mode = 'spot' | 'opening'
const EPS = 1e-6
const fi = 'w-full rounded-lg bg-s-bg border border-s-border px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none'
const qtyText = (q: number) => String(Math.round(q * 1000) / 1000)

export default function PhysicalCountPage() {
  const qc = useQueryClient()
  // What this login may do here comes from the API, not from a role list.
  const { data: caps, isFetched: capsFetched } = useQuery<Capabilities>({
    queryKey: ['physical-counts', 'capabilities'],
    queryFn: () => api.get('/crosschecks/physical-counts/capabilities'),
    retry: false,
  })
  const canSpot = caps?.canSpotCount ?? false
  const canOpening = caps?.canOpeningCount ?? false

  const { data: items = [], isLoading } = useQuery<InventoryItem[]>({ queryKey: ['inventory'], queryFn: () => api.get('/inventory') })
  const { data: locations = [] } = useQuery<LocationRow[]>({
    queryKey: ['locations'], queryFn: () => api.get('/locations'),
    retry: false, meta: { background: true }, staleTime: 300_000,
  })
  const outlets = locations.filter((l) => l.isActive !== false)

  const [mode, setMode] = useState<Mode>('spot')
  const [search, setSearch] = useState('')
  const [locationId, setLocationId] = useState('')
  const [lines, setLines] = useState<Record<string, DraftLine>>({})
  const [notes, setNotes] = useState('')
  const [suggested, setSuggested] = useState<SuggestedItem[] | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [result, setResult] = useState<{ mode: Mode; res: CountResult; differences: number } | null>(null)

  // A login that can only make opening counts (finance) starts there.
  useEffect(() => {
    if (capsFetched && !canSpot && canOpening) setMode('opening')
  }, [capsFetched, canSpot, canOpening])

  // /inventory/count?item=<id> — opened from an item's "count" link.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('item')
    const it = id ? items.find((i) => i.id === id) : undefined
    if (it) setSearch(it.name)
  }, [items])

  const suggest = useMutation({
    mutationFn: () => api.get<{ items: SuggestedItem[] }>(
      `/crosschecks/physical-counts/suggested?n=8${locationId ? `&locationId=${encodeURIComponent(locationId)}` : ''}`),
    onSuccess: (r) => { setSuggested(r.items); setShowAll(false); setSearch('') },
  })

  const draft = (id: string): DraftLine => lines[id] ?? { qty: '', reason: '', costPkr: '' }
  function patch(id: string, p: Partial<DraftLine>) { setLines((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { qty: '', reason: '', costPkr: '' }), ...p } })) }

  // The items on screen. Opening: only never-received items of a company
  // (costSource 'opening' = no lots, no deliveries). Spot: everything, or just
  // the suggested sample.
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    let base = items.filter((i) => !!i.tenantId)
    if (mode === 'opening') base = base.filter((i) => i.costSource !== 'deliveries' && i.currentStock <= EPS)
    if (mode === 'spot' && suggested && !showAll) {
      const order = new Map(suggested.map((s, idx) => [s.id, idx]))
      return base.filter((i) => order.has(i.id)).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    }
    return base.filter((i) => !q || i.name.toLowerCase().includes(q))
  }, [items, search, mode, suggested, showAll])
  const suggestedById = useMemo(() => new Map((suggested ?? []).map((s) => [s.id, s])), [suggested])
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])

  // What will be sent, and whether it is complete.
  const entered = Object.entries(lines).filter(([id, l]) => l.qty !== '' && itemById.has(id))
  const missingReasons = mode === 'spot'
    ? entered.filter(([id, l]) => Math.abs(Number(l.qty) - (itemById.get(id)?.currentStock ?? 0)) > EPS && l.reason.trim().length < 3).length
    : 0
  const badOpening = mode === 'opening'
    ? entered.filter(([id, l]) => {
        const it = itemById.get(id)!
        const hasCost = l.costPkr.trim() !== '' ? Number(l.costPkr) >= 0 : it.unitCostCents != null
        return !(Number(l.qty) > 0) || !hasCost
      }).length
    : 0
  const ready = entered.length > 0 && missingReasons === 0 && badOpening === 0

  const submit = useMutation({
    mutationFn: () => api.post<CountResult>('/crosschecks/physical-counts', {
      kind: mode,
      locationId: locationId || null,
      lines: entered.map(([id, l]) => {
        const it = itemById.get(id)!
        if (mode === 'opening') {
          return {
            inventoryItemId: id, physicalQty: Number(l.qty),
            unitCostCents: l.costPkr.trim() !== '' ? Math.round(Number(l.costPkr) * 100) : null,
          }
        }
        const differs = Math.abs(Number(l.qty) - it.currentStock) > EPS
        return { inventoryItemId: id, physicalQty: Number(l.qty), reason: differs ? l.reason.trim() : null }
      }),
      notes: notes.trim() || null,
    }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['inventory'] })
      void qc.invalidateQueries({ queryKey: ['exceptions'] })
      void qc.invalidateQueries({ queryKey: ['physical-counts'] })
      const differences = res.lines.filter((l) => Math.abs(l.physicalQty - l.systemQty) > EPS).length
      setResult({ mode, res, differences })
      setLines({}); setNotes(''); setSuggested(null); setShowAll(false)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    },
  })

  // Both modes need a place in the world: a role that can do neither only reads.
  const mayCount = mode === 'spot' ? canSpot : canOpening
  const err = submit.error
  const errCode = errorCode(err)

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="px-4 sm:px-7 py-5 border-b border-s-border">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Link href="/inventory" className="text-xs text-s-muted hover:text-s-text">← Inventory</Link>
          <Link href="/inventory/count/history" className="text-xs font-semibold text-primary-ink hover:underline">Count history</Link>
        </div>
        <h1 className="text-2xl font-black text-s-text mt-2">Physical count</h1>
        <p className="text-sm text-s-muted mt-1 max-w-2xl">
          {mode === 'spot'
            ? 'Count what is on the shelf. A short count comes off the oldest stock; an over-count is added at the latest price paid. Any line that differs from the books needs a reason.'
            : 'Stock found by the first count of an item that was never received or counted. It is booked to the owner’s capital at the unit cost you enter.'}
        </p>
      </header>

      <div className="px-4 sm:px-7 py-5 max-w-4xl mx-auto space-y-4">
        {result && (
          <div role="status" className="rounded-xl px-4 py-3 text-sm space-y-1"
            style={result.res.ledger.posted
              ? { background: 'rgb(var(--erp-accent-rgb) / 0.14)', border: '1px solid rgb(var(--erp-accent-rgb) / 0.45)', color: 'var(--erp-success)' }
              : { background: 'color-mix(in srgb, var(--erp-danger) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-danger) 35%, transparent)', color: 'var(--erp-danger)' }}>
            <p className="font-bold">
              {result.res.ledger.posted
                ? `${result.mode === 'opening' ? 'Opening count' : 'Count'} saved and posted to the books.`
                : `${result.mode === 'opening' ? 'Opening count' : 'Count'} saved, but its books entry did not post.`}
            </p>
            {!result.res.ledger.posted && (
              <p className="text-xs">
                {result.res.ledger.reason ?? result.res.ledger.error ?? 'The ledger refused the entry.'}{' '}
                Stock is already corrected; finance can re-post it from Reconciliation → Backfill unposted.
              </p>
            )}
            {result.mode === 'spot' && (
              <p className="text-xs text-s-text">
                {result.differences === 0
                  ? 'Every line matched the books.'
                  : `${result.differences} line${result.differences === 1 ? '' : 's'} differed from the books and carry the reason you gave.`}
                {' '}<Link href="/inventory/count/history" className="text-primary-ink hover:underline">See it in the count history</Link>.
              </p>
            )}
          </div>
        )}

        {capsFetched && !canSpot && !canOpening && (
          <p className="text-xs text-s-muted">Stock counts are taken by the kitchen and its managers (opening counts by finance and management). You can read stock here, but not submit a count.</p>
        )}

        {/* Mode */}
        {(canSpot || canOpening) && (
          <div className="flex flex-wrap items-center gap-2">
            {canSpot && <ModeButton on={mode === 'spot'} onClick={() => { setMode('spot'); setLines({}) }}>Spot count</ModeButton>}
            {canOpening && <ModeButton on={mode === 'opening'} onClick={() => { setMode('opening'); setLines({}); setSuggested(null) }}>Opening count</ModeButton>}
            {mode === 'spot' && canSpot && (
              <button type="button" onClick={() => suggest.mutate()} disabled={suggest.isPending}
                className="ml-auto rounded-xl border border-s-border px-4 py-2 text-xs font-bold text-s-text hover:border-primary hover:text-primary-ink disabled:opacity-50">
                {suggest.isPending ? 'Choosing…' : 'Suggest a spot count'}
              </button>
            )}
          </div>
        )}
        {suggest.error && <p role="alert" className="text-xs text-s-red">{stockErrorText(suggest.error)}</p>}

        {/* Outlet + search */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input value={search} onChange={(e) => { setSearch(e.target.value); if (suggested) setShowAll(true) }}
            placeholder="Search items…" className={fi} aria-label="Search items" />
          {outlets.length > 0 && (
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className={fi} aria-label="Outlet counted">
              <option value="">Outlet: whole company</option>
              {outlets.map((l) => <option key={l.id} value={l.id}>{l.name}{l.tenant?.name ? ` — ${l.tenant.name}` : ''}</option>)}
            </select>
          )}
        </div>

        {mode === 'spot' && suggested && (
          <div className="flex items-center justify-between gap-3 flex-wrap rounded-xl px-4 py-2.5 text-xs"
            style={{ background: 'rgb(var(--erp-primary-rgb) / 0.08)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.25)' }}>
            <span className="text-s-text">
              {suggested.length === 0
                ? 'Nothing needs a spot count right now — everything with stock was counted in the last 7 days.'
                : `Suggested today: ${suggested.length} item${suggested.length === 1 ? '' : 's'} — chosen by value and how fast they move; items counted this week are left out.`}
            </span>
            <span className="flex gap-3">
              <button type="button" onClick={() => setShowAll((v) => !v)} className="font-bold text-primary-ink hover:underline">
                {showAll ? 'Only the suggestion' : 'Show all items'}
              </button>
              <button type="button" onClick={() => { setSuggested(null); setShowAll(false) }} className="text-s-muted hover:text-s-text">Clear</button>
            </span>
          </div>
        )}

        {mode === 'opening' && (
          <p className="text-xs text-s-muted">
            Listed here: items of a company that were never received or counted. An item that already has stock or deliveries needs a spot count instead.
            The unit cost defaults to the item&rsquo;s cost estimate; type one if it has none.
          </p>
        )}

        {/* Lines */}
        <div className="rounded-2xl overflow-hidden border border-s-border">
          {isLoading && <p className="p-5 text-xs text-s-muted">Loading…</p>}
          {!isLoading && shown.length === 0 && (
            <p className="p-5 text-xs text-s-muted italic">
              {mode === 'opening' ? 'No item is waiting for an opening count.' : 'No items match.'}
            </p>
          )}
          {shown.map((item) => {
            const l = draft(item.id)
            const counted = l.qty !== '' ? Number(l.qty) : null
            const diff = counted != null ? counted - item.currentStock : null
            const differs = diff != null && Math.abs(diff) > EPS
            const pct = diff != null && item.currentStock > 0 ? (diff / item.currentStock) * 100 : null
            const flag = pct != null && Math.abs(pct) > 2
            const sug = suggestedById.get(item.id)
            const reasonShort = mode === 'spot' && differs && l.reason.trim().length < 3
            return (
              <div key={item.id} className="px-4 py-3 border-b border-s-border/60 last:border-b-0">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-s-text">
                      {item.name}
                      {sug && <span className="s-badge-purple ml-2 align-middle">Suggested</span>}
                    </p>
                    <p className="text-xs text-s-muted font-mono">
                      {mode === 'spot' ? `Books: ${qtyText(item.currentStock)} ${item.unit}` : `Unit: ${item.unit}`}
                      {sug?.onHandValueCents != null && ` · worth ${fmtPkrWhole(sug.onHandValueCents)}`}
                    </p>
                  </div>
                  {mayCount && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <input type="number" step="0.001" min={0} inputMode="decimal" value={l.qty}
                        onChange={(e) => patch(item.id, { qty: e.target.value })}
                        placeholder="Counted" aria-label={`${item.name} counted`}
                        className="w-28 rounded-lg bg-s-bg border border-s-border px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none" />
                      <span className="text-xs text-s-muted w-10">{item.unit}</span>
                      {mode === 'opening' && (
                        <input type="number" step="any" min={0} inputMode="decimal" value={l.costPkr}
                          onChange={(e) => patch(item.id, { costPkr: e.target.value })}
                          placeholder={item.unitCostCents != null ? `${item.unitCostCents / 100}` : 'Unit cost'}
                          aria-label={`${item.name} unit cost in rupees`}
                          className="w-28 rounded-lg bg-s-bg border border-s-border px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none" />
                      )}
                    </div>
                  )}
                </div>
                {mode === 'spot' && diff != null && (
                  <div className="mt-2 space-y-1.5">
                    <p className="text-xs font-bold" style={{ color: !differs ? 'var(--erp-success)' : flag ? 'var(--erp-warning)' : 'rgb(var(--fg-rgb) / 0.6)' }}>
                      {!differs ? 'Matches the books'
                        : `${diff > 0 ? 'Over' : 'Short'} by ${qtyText(Math.abs(diff))} ${item.unit}${pct != null ? ` (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)` : ' — nothing on the books'}`}
                    </p>
                    {differs && (
                      <div>
                        <input value={l.reason} onChange={(e) => patch(item.id, { reason: e.target.value })} maxLength={200}
                          placeholder="Why does it differ? (required, 3+ characters)" aria-label={`Reason for the difference on ${item.name}`}
                          className={fi} style={reasonShort ? { borderColor: 'var(--erp-warning)' } : undefined} />
                        <p className="text-[11px] text-s-muted mt-1">
                          {diff < 0 ? 'The missing quantity is written off at the price paid.' : 'The extra is added at the latest purchase price, and flagged if the books held none.'}
                        </p>
                      </div>
                    )}
                  </div>
                )}
                {mode === 'opening' && counted != null && (
                  <p className="mt-1 text-[11px] text-s-muted">
                    {!(counted > 0) ? 'The quantity must be above zero.'
                      : (l.costPkr.trim() === '' && item.unitCostCents == null) ? 'This item has no cost estimate — type its unit cost.'
                      : `Booked at PKR ${l.costPkr.trim() !== '' ? Number(l.costPkr).toLocaleString('en-PK', { maximumFractionDigits: 3 }) : (item.unitCostCents! / 100).toLocaleString('en-PK', { maximumFractionDigits: 3 })} per ${item.unit}.`}
                  </p>
                )}
              </div>
            )
          })}
        </div>

        <div>
          <label className="text-xs text-s-muted" htmlFor="count-notes">Count notes</label>
          <textarea id="count-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={500}
            placeholder="Friday morning, line cooks present, freezer #2 inspected." className={fi + ' mt-1'} />
        </div>

        {err && (
          <div role="alert" className="rounded-xl px-4 py-3 text-sm"
            style={{ background: 'color-mix(in srgb, var(--erp-danger) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-danger) 35%, transparent)', color: 'var(--erp-danger)' }}>
            <strong>Not saved.</strong> {stockErrorText(err)}
            {errCode === 'OPENING_NOT_ALLOWED' && <span className="block text-xs mt-1">Remove that item from the opening count and count it as a spot count.</span>}
          </div>
        )}

        {mayCount ? (
          <div className="flex items-center justify-end gap-3 flex-wrap pt-1">
            {missingReasons > 0 && (
              <span className="text-xs" style={{ color: 'var(--erp-warning)' }}>
                {missingReasons} line{missingReasons === 1 ? ' needs' : 's need'} a reason
              </span>
            )}
            {badOpening > 0 && (
              <span className="text-xs" style={{ color: 'var(--erp-warning)' }}>
                {badOpening} line{badOpening === 1 ? ' needs' : 's need'} a quantity above zero and a unit cost
              </span>
            )}
            <button onClick={() => submit.mutate()} disabled={submit.isPending || !ready}
              className="rounded-xl bg-primary px-6 py-3 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
              {submit.isPending ? 'Saving…' : `Submit ${mode === 'opening' ? 'opening ' : ''}count (${entered.length} item${entered.length === 1 ? '' : 's'})`}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ModeButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors border ${on ? 'bg-primary text-primary-on border-primary' : 'bg-s-surface border-s-border text-s-muted hover:text-s-text'}`}>
      {children}
    </button>
  )
}
