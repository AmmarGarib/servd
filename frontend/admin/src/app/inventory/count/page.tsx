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

import { ArrowLeft } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { fmtPkrWhole } from '../../../lib/money'
import { stockErrorText, errorCode } from '../../../lib/stockUi'
import { Select } from '@/components/ui/Select'
import { NumberField } from '../../../components/ui/NumberField'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { useConfirm } from '../../../components/ui/ConfirmDialog'
import { useAuthStore } from '../../../store/auth'
import { readLensTenant } from '../../../lib/api'
import { useMyTenants } from '../../../components/ui/TenantPicker'

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
// Draft lines keep numbers as typed text ('' = empty); the fields want number | null.
const numOf = (t: string): number | null => (t.trim() === '' || !Number.isFinite(Number(t)) ? null : Number(t))
const textOf = (n: number | null): string => (n == null ? '' : String(n))
// Unit cost is typed in rupees; MoneyInput works in cents, the API gets cents.
const centsOf = (pkr: string): number => Math.round((numOf(pkr) ?? 0) * 100)
const pkrOf = (cents: number): string => (cents > 0 ? String(cents / 100) : '')
const DRAFT_PREFIX = 'servd:count-draft:'

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
  // Brand stock (owner B13 (a)): count ONE brand's stock ('' = the outlet's whole stock). Shared stock the brand finds
  // on its shelf becomes the brand's (no variance); a shortfall comes off the brand's own stock only.
  const [countBrand, setCountBrand] = useState('')
  const { data: stockBrands = [] } = useQuery<Array<{ id: string; name: string; tenantId: string | null }>>({
    queryKey: ['concepts-picker'], queryFn: () => api.get('/concepts?view=picker'), retry: false, meta: { background: true }, staleTime: 300_000,
  })
  const [lines, setLines] = useState<Record<string, DraftLine>>({})
  const [notes, setNotes] = useState('')
  const [suggested, setSuggested] = useState<SuggestedItem[] | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [result, setResult] = useState<{ mode: Mode; res: CountResult; differences: number } | null>(null)
  const [tried, setTried] = useState(false)
  const confirm = useConfirm()
  const me = useAuthStore((s) => s.user)
  const { data: myTenants = [], isFetched: tenantsFetched } = useMyTenants()
  const linesRef = useRef<HTMLDivElement>(null)

  // ── Draft autosave (ERP-OPS-7) ─────────────────────────────────────────
  // A count session = this login, the company, the kind of count and the
  // outlet. The draft lives in this browser only; it is cleared on submit.
  const companyKey = readLensTenant() ?? (myTenants.length === 1 ? myTenants[0]!.id : 'all')
  const draftKey = me && tenantsFetched ? `${DRAFT_PREFIX}${me.id}:${companyKey}:${mode}:${locationId || 'all'}` : null
  const [hydratedKey, setHydratedKey] = useState<string | null>(null)
  const [restored, setRestored] = useState(false)

  // Load the session's draft whenever the session changes.
  useEffect(() => {
    if (!draftKey) return
    type Saved = { lines?: Record<string, DraftLine>; notes?: string }
    let got: Saved | null = null
    try {
      const raw = localStorage.getItem(draftKey)
      if (raw) got = JSON.parse(raw) as Saved
    } catch { got = null }
    const l = got?.lines && typeof got.lines === 'object' ? got.lines : {}
    const has = Object.values(l).some((x) => x && x.qty !== '')
    setLines(has ? l : {})
    setNotes(has && typeof got?.notes === 'string' ? got.notes : '')
    setRestored(has)
    setHydratedKey(draftKey)
  }, [draftKey])

  // Save as the counter types (only after the load above, so it never wipes a draft).
  useEffect(() => {
    if (!draftKey || hydratedKey !== draftKey) return
    const has = Object.values(lines).some((x) => x.qty !== '')
    try {
      if (has) localStorage.setItem(draftKey, JSON.stringify({ lines, notes, savedAt: Date.now() }))
      else localStorage.removeItem(draftKey)
    } catch { /* private window or blocked storage: the count still works */ }
  }, [lines, notes, draftKey, hydratedKey])

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

  // The count schedule (2026-10-24): daily items every day, weekly items until counted this week, at this outlet.
  const due = useMutation({
    mutationFn: () => api.get<{ items: SuggestedItem[] }>(
      `/crosschecks/physical-counts/due${locationId ? `?locationId=${encodeURIComponent(locationId)}` : ''}`),
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
  const countedOnScreen = shown.filter((i) => (lines[i.id]?.qty ?? '') !== '').length

  // Leaving with typed quantities that were not submitted loses the count (the
  // draft is kept in this browser, but a refresh should still ask).
  const unsaved = entered.length > 0
  useEffect(() => {
    if (!unsaved) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [unsaved])

  // The keyboard's Next / Enter key on a phone: every field of the list is one
  // input, so Enter moves to the next input in page order (the reason box of a
  // differing line comes right after its Counted box). The last one goes on to
  // the notes. Typing never submits the whole count by accident.
  useEffect(() => {
    linesRef.current?.querySelectorAll('input').forEach((i) => { i.enterKeyHint = 'next' })
  })
  function onLinesKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
    const t = e.target
    if (!(t instanceof HTMLInputElement)) return
    e.preventDefault()
    const all = Array.from(e.currentTarget.querySelectorAll<HTMLInputElement>('input:not([type=hidden]):not([disabled])'))
    const next = all[all.indexOf(t) + 1]
    if (next) { next.focus(); next.scrollIntoView({ block: 'center', behavior: 'smooth' }) }
    else document.getElementById('count-notes')?.focus()
  }

  const submit = useMutation({
    mutationFn: () => api.post<CountResult>('/crosschecks/physical-counts', {
      kind: mode,
      locationId: locationId || null,
      ...(countBrand ? { conceptId: countBrand } : {}),
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
      setTried(false); setRestored(false)
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
          <Link href="/inventory" className="inline-flex min-h-11 items-center gap-1.5 text-xs text-s-muted hover:text-s-text"><ArrowLeft size={14} aria-hidden="true" />Inventory</Link>
          <Link href="/inventory/count/history" className="text-xs font-semibold text-primary-ink hover:underline">Count history</Link>
        </div>
        <h1 className="text-2xl font-black text-s-text mt-2">Physical count</h1>
        <p className="text-sm text-s-muted mt-1 max-w-2xl">
          {mode === 'spot'
            ? 'Count what is on the shelf. A short count comes off the oldest stock; an over-count is added at the latest price paid. Any line that differs from the books needs a reason.'
            : 'Stock found by the first count of an item that was never received or counted. It is booked to the owner’s capital at the unit cost you enter.'}
        </p>
      </header>

      <form noValidate className="px-4 sm:px-7 py-5 max-w-4xl mx-auto space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          setTried(true)
          if (ready && !submit.isPending) submit.mutate()
        }}>
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
            {canSpot && <ModeButton on={mode === 'spot'} onClick={() => { setMode('spot'); setResult(null) }}>Spot count</ModeButton>}
            {canOpening && <ModeButton on={mode === 'opening'} onClick={() => { setMode('opening'); setSuggested(null); setResult(null) }}>Opening count</ModeButton>}
            {mode === 'spot' && canSpot && (<>
              <button type="button" onClick={() => due.mutate()} disabled={due.isPending}
                className="ml-auto rounded-xl border border-s-border px-4 py-2 text-xs font-bold text-s-text hover:border-primary hover:text-primary-ink disabled:opacity-50">
                {due.isPending ? 'Loading…' : 'Due today'}
              </button>
              <button type="button" onClick={() => suggest.mutate()} disabled={suggest.isPending}
                className="rounded-xl border border-s-border px-4 py-2 text-xs font-bold text-s-text hover:border-primary hover:text-primary-ink disabled:opacity-50">
                {suggest.isPending ? 'Choosing…' : 'Suggest a spot count'}
              </button>
            </>)}
          </div>
        )}
        {suggest.error && <p role="alert" className="text-xs text-s-red">{stockErrorText(suggest.error)}</p>}
        {due.error && <p role="alert" className="text-xs text-s-red">{stockErrorText(due.error)}</p>}

        {/* Outlet + search */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input value={search} onChange={(e) => { setSearch(e.target.value); if (suggested) setShowAll(true) }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); linesRef.current?.querySelector('input')?.focus() } }}
            placeholder="Search items…" className={fi} aria-label="Search items" />
          {outlets.length > 0 && (
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} className={fi} aria-label="Outlet counted">
              <option value="">Outlet: pick the one counted</option>
              {outlets.map((l) => <option key={l.id} value={l.id}>{l.name}{l.tenant?.name ? ` — ${l.tenant.name}` : ''}</option>)}
            </Select>
          )}
          {stockBrands.length > 1 && (
            <Select value={countBrand} onChange={(e) => setCountBrand(e.target.value)} className={fi} aria-label="Brand counted">
              <option value="">Brand: the outlet's whole stock</option>
              {stockBrands.map((b) => <option key={b.id} value={b.id}>Only {b.name}'s stock</option>)}
            </Select>
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
        {restored && (
          <div role="status" className="flex items-center justify-between gap-3 flex-wrap rounded-xl px-4 py-2.5 text-xs"
            style={{ background: 'rgb(var(--erp-primary-rgb) / 0.08)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.25)' }}>
            <span className="text-s-text">Restored your draft — {entered.length} line{entered.length === 1 ? '' : 's'} you had counted but not submitted.</span>
            <span className="flex gap-3">
              <button type="button" onClick={() => setRestored(false)} className="text-s-muted hover:text-s-text">Dismiss</button>
              <button type="button" className="font-bold text-s-red hover:underline" onClick={async () => {
                const ok = await confirm({ title: 'Discard the draft?', body: 'The quantities you typed are cleared. Nothing has been submitted.', confirmLabel: 'Discard draft', danger: true })
                if (ok) { setLines({}); setNotes(''); setRestored(false) }
              }}>Discard draft</button>
            </span>
          </div>
        )}

        {/* Progress — stays in view while the list scrolls */}
        {mayCount && shown.length > 0 && (
          <div className="sticky top-0 z-10 -mx-1 px-1 py-2" style={{ background: 'var(--bg)' }}>
            <div className="flex items-center gap-3 rounded-xl border border-s-border bg-s-surface px-4 py-2 text-xs">
              <span role="status" className="font-bold text-s-text">{countedOnScreen} of {shown.length} counted</span>
              <span className="h-1.5 flex-1 rounded-full bg-s-border overflow-hidden" aria-hidden>
                <span className="block h-full rounded-full" style={{ width: `${Math.round((countedOnScreen / shown.length) * 100)}%`, background: 'var(--erp-success)' }} />
              </span>
            </div>
          </div>
        )}

        <div ref={linesRef} onKeyDown={onLinesKey} className="rounded-2xl overflow-hidden border border-s-border">
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
                      <NumberField decimals={3} min={0} value={numOf(l.qty)}
                        onValueChange={(v) => patch(item.id, { qty: textOf(v) })}
                        placeholder="Counted" aria-label={`${item.name} counted`}
                        className="w-28 rounded-lg bg-s-bg border border-s-border px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none" />
                      <span className="text-xs text-s-muted w-10">{item.unit}</span>
                      {mode === 'opening' && (
                        <MoneyInput value={centsOf(l.costPkr)}
                          onChange={(c) => patch(item.id, { costPkr: pkrOf(c) })}
                          placeholder={item.unitCostCents != null ? `${item.unitCostCents / 100}` : 'Unit cost'}
                          ariaLabel={`${item.name} unit cost in rupees`}
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
                        <input enterKeyHint="next" value={l.reason} onChange={(e) => patch(item.id, { reason: e.target.value })} maxLength={200}
                          placeholder="Why does it differ? (required, 3+ characters)" aria-label={`Reason for the difference on ${item.name}`}
                          className={fi} style={reasonShort ? { borderColor: 'var(--erp-warning)' } : undefined} />
                        <p className="text-xs text-s-muted mt-1">
                          {diff < 0 ? 'The missing quantity is written off at the price paid.' : 'The extra is added at the latest purchase price, and flagged if the books held none.'}
                        </p>
                      </div>
                    )}
                  </div>
                )}
                {mode === 'opening' && counted != null && (
                  <p className="mt-1 text-xs text-s-muted">
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
            {tried && entered.length === 0 && <span role="alert" className="text-xs" style={{ color: 'var(--erp-warning)' }}>Enter at least one counted quantity first.</span>}
            <button type="submit" disabled={submit.isPending}
              className="rounded-xl bg-primary px-6 py-3 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
              {submit.isPending ? 'Saving…' : `Submit ${mode === 'opening' ? 'opening ' : ''}count (${entered.length} item${entered.length === 1 ? '' : 's'})`}
            </button>
          </div>
        ) : null}
      </form>
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
