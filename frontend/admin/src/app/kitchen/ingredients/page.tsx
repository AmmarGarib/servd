'use client'
// Operations → Ingredients: servd's ONE ingredient master (owner, 2026-10-26 — kitchen flow K1, K2, K3, K6).
//
// The master is servd-wide: one definition per ingredient — unit, category, allergens, yield %, buying unit and the
// SPEC (what we buy, e.g. "burger meat = 80/20, coarse ground", printed on purchase orders and the shopping list).
// It is servd's ingredient AND PRICING sheet (owner, 2026-10-29: "a pure ingredient availability and pricing sheet …
// for people to create recipes on servd and see avg cost on that recipe basis historical prices"): ONE servd price per
// ingredient — the latest paid anywhere in servd, the 90-day average beside it, and the full history (date, company,
// supplier). Recipes cost at that latest price. Stocking, stock in / out and pars are each outlet's, on Inventory.
// It replaced the Sourcing sheet (owner, 2026-10-29).
//   • Search runs on the server (GET /ingredient-master?q=).
//   • A chef's new ingredient joins at once, marked "needs review" (K2). The CEO or the F&B manager marks it reviewed
//     or MERGES a duplicate into the right one (a company that stocks both must merge its stock items first).
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api, ApiError } from '../../../lib/api'
import { useAuthStore } from '../../../store/auth'
import { useManagerRoles } from '../../../lib/roles'
import { INVENTORY_CATEGORY_OPTIONS, categoryLabel, stockErrorText } from '../../../lib/stockUi'
import { Button, Dialog, DialogFooter, ErrorBanner, Field, Input, SidePanel, Textarea } from '../../../components/finance/ui'
import type { MasterPrice, MasterRow } from '../../../components/kitchen/MasterIngredientPicker'

const UNITS = ['g', 'ml', 'pcs', 'kg', 'litres', 'each']
const REVIEWERS = new Set(['admin', 'fnb_manager'])

interface Draft {
  name: string; unit: string; category: string; allergens: string; yieldPct: string
  purchaseUnit: string; purchaseUnitFactor: string; spec: string; specFields: Array<{ k: string; v: string }>
  perishable: boolean; shelfLifeDays: string
}
const draftOf = (m: MasterRow): Draft => ({
  name: m.name, unit: m.stockUnit, category: m.category ?? '', allergens: m.allergens.join(', '), yieldPct: String(m.yieldPct),
  purchaseUnit: m.purchaseUnit ?? '', purchaseUnitFactor: String(m.purchaseUnitFactor),
  spec: m.spec ?? '', specFields: Object.entries(m.specFields ?? {}).map(([k, v]) => ({ k, v })),
  perishable: !!m.perishable, shelfLifeDays: m.shelfLifeDays != null ? String(m.shelfLifeDays) : '',
})

export default function IngredientsPage() {
  const qc = useQueryClient()
  const role = useAuthStore((s) => s.user?.role) ?? ''
  const managers = useManagerRoles()
  const canEdit = managers.has(role)
  const isReviewer = REVIEWERS.has(role)
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [tab, setTab] = useState<'all' | 'needs_review'>('all')
  const [open, setOpen] = useState<MasterRow | null>(null)
  const [adding, setAdding] = useState(false)
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t) }, [q])

  const { data: rows = [], isLoading } = useQuery<MasterRow[]>({
    queryKey: ['ingredient-master', 'page', debounced, tab],
    queryFn: () => api.get<MasterRow[]>(`/ingredient-master?limit=500${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}${tab === 'needs_review' ? '&status=needs_review' : ''}`),
  })
  const pricesShown = rows.some((r) => r.price != null)

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-success">Operations</p>
          <h1 className="text-xl font-bold text-s-text">Ingredients</h1>
          <p className="text-xs text-s-muted">servd&rsquo;s ingredients and their prices. Recipes are costed at the latest price paid anywhere in servd; the 90-day average is beside it. Stock in and out is on <Link href="/inventory" className="text-primary-ink underline">Inventory</Link>.</p>
        </div>
        {canEdit && <Button onClick={() => setAdding(true)}>Add ingredient</Button>}
      </header>

      <div className="p-6 max-w-6xl mx-auto space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ingredients…" className="s-input w-auto min-w-[16rem]" aria-label="Search ingredients" />
          <div role="tablist" className="flex gap-1 text-sm">
            {(['all', 'needs_review'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                className={`px-3 py-1.5 border-b-2 ${tab === t ? 'border-accent font-semibold text-s-text' : 'border-transparent text-s-muted'}`}>
                {t === 'all' ? 'All' : 'Needs review'}
              </button>
            ))}
          </div>
        </div>
        {/* Phone: one compact row per ingredient — name, price, average; nothing to swipe. */}
        <ul className="s-card sm:hidden divide-y divide-s-border">
          {rows.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => setOpen(m)} className="w-full text-left px-3 py-2.5 min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm text-s-text break-words">{m.name}</span>
                  <span className="text-sm font-mono whitespace-nowrap">{priceText(m.price?.latestCents, m.price)}</span>
                </div>
                <p className="text-xs text-s-muted break-words">
                  {[categoryLabel(m.category), m.price?.averageCents != null ? `avg ${priceText(m.price.averageCents, m.price)}` : null, lastBought(m.price), m.status === 'needs_review' ? 'needs review' : null].filter(Boolean).join(' · ')}
                </p>
              </button>
            </li>
          ))}
          {!isLoading && rows.length === 0 && <li className="px-3 py-6 text-center text-xs text-s-muted">No ingredients match.</li>}
          {isLoading && <li className="px-3 py-6 text-center text-xs text-s-muted">Loading…</li>}
        </ul>
        <div className="s-card overflow-x-auto hidden sm:block">
          <table className="w-full text-sm">
            <thead className="text-xs text-s-muted">
              <tr>
                <th className="px-3 py-2 text-left">Ingredient</th>
                <th className="px-3 py-2 text-left">Unit</th>
                <th className="px-3 py-2 text-left">Category</th>
                {pricesShown && <th className="px-3 py-2 text-right">Latest price</th>}
                {pricesShown && <th className="px-3 py-2 text-right">90-day average</th>}
                {pricesShown && <th className="px-3 py-2 text-left">Last bought</th>}
                <th className="px-3 py-2 text-left">Spec (what we buy)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className="border-t border-s-border hover:bg-s-bg-soft cursor-pointer" onClick={() => setOpen(m)}>
                  <td className="px-3 py-2 text-s-text">
                    {m.name}
                    {m.status === 'needs_review' && <span className="ml-2 s-badge-purple text-[10px] px-1.5 py-0.5 rounded">needs review</span>}
                    {m.perishable && <span className="ml-2 s-badge-teal text-[10px] px-1.5 py-0.5 rounded">perishable{m.shelfLifeDays ? ` · ${m.shelfLifeDays} d` : ''}</span>}
                  </td>
                  <td className="px-3 py-2 text-s-muted">{m.stockUnit}{m.purchaseUnit ? ` · bought by ${m.purchaseUnit} (${m.purchaseUnitFactor})` : ''}</td>
                  <td className="px-3 py-2 text-s-muted">{categoryLabel(m.category)}</td>
                  {pricesShown && <td className="px-3 py-2 text-right font-mono text-xs whitespace-nowrap">{priceText(m.price?.latestCents, m.price)}</td>}
                  {pricesShown && <td className="px-3 py-2 text-right font-mono text-xs whitespace-nowrap text-s-muted">{priceText(m.price?.averageCents, m.price)}</td>}
                  {pricesShown && <td className="px-3 py-2 text-xs text-s-muted">{lastBought(m.price) ?? '—'}</td>}
                  <td className="px-3 py-2 text-s-muted max-w-xs truncate">{m.spec ?? '—'}</td>
                </tr>
              ))}
              {!isLoading && rows.length === 0 && <tr><td colSpan={pricesShown ? 7 : 4} className="px-3 py-8 text-center text-xs text-s-muted">No ingredients match.</td></tr>}
              {isLoading && <tr><td colSpan={pricesShown ? 7 : 4} className="px-3 py-8 text-center text-xs text-s-muted">Loading…</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {open && <Editor master={open} canEdit={canEdit} isReviewer={isReviewer} onClose={() => setOpen(null)} />}
      {adding && <AddDialog onClose={() => setAdding(false)} />}
    </div>
  )
}

function AddDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({ name: '', unit: 'kg', category: '', spec: '' })
  const add = useMutation({
    mutationFn: () => api.post('/ingredient-master', { name: f.name.trim(), unit: f.unit, category: f.category || null, spec: f.spec.trim() || null }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ingredient-master'] }); onClose() },
  })
  return (
    <Dialog title="Add ingredient" onClose={onClose} dirty={!!f.name}>
      <div className="space-y-3">
        <Field label="Name" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Stock unit"><select className="s-input" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select></Field>
        <Field label="Category"><select className="s-input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          <option value="">—</option>{INVENTORY_CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select></Field>
        <Field label="Spec" hint="What we buy — e.g. 80/20, coarse ground"><Textarea rows={2} value={f.spec} onChange={(e) => setF({ ...f, spec: e.target.value })} /></Field>
        <p className="text-xs text-s-muted">A new ingredient is marked for review until the CEO or the F&amp;B manager checks it.</p>
        {add.error && <ErrorBanner message={stockErrorText(add.error)} />}
      </div>
      <DialogFooter onCancel={onClose}>
        <Button disabled={!f.name.trim() || add.isPending} onClick={() => add.mutate()}>Add</Button>
      </DialogFooter>
    </Dialog>
  )
}

function Editor({ master, canEdit, isReviewer, onClose }: { master: MasterRow; canEdit: boolean; isReviewer: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [d, setD] = useState<Draft>(draftOf(master))
  const [mergeQ, setMergeQ] = useState('')
  const [mergeErr, setMergeErr] = useState('')
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['ingredient-master'] }); void qc.invalidateQueries({ queryKey: ['inventory'] }) }
  const save = useMutation({
    mutationFn: (extra: Record<string, unknown> = {}) => api.patch<MasterRow>(`/ingredient-master/${master.id}`, {
      name: d.name.trim(), unit: d.unit, category: d.category || null,
      allergens: d.allergens.split(',').map((a) => a.trim()).filter(Boolean),
      yieldPct: Number(d.yieldPct) || 100,
      purchaseUnit: d.purchaseUnit.trim() || null, purchaseUnitFactor: Number(d.purchaseUnitFactor) || 1,
      spec: d.spec.trim() || null,
      perishable: d.perishable,
      shelfLifeDays: d.perishable && Number(d.shelfLifeDays) >= 1 ? Math.round(Number(d.shelfLifeDays)) : null,
      specFields: d.specFields.filter((r) => r.k.trim()).length ? Object.fromEntries(d.specFields.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v.trim()])) : null,
      ...extra,
    }),
    onSuccess: () => { refresh(); onClose() },
  })
  const { data: candidates = [] } = useQuery<MasterRow[]>({
    queryKey: ['ingredient-master', 'merge', mergeQ],
    queryFn: () => api.get<MasterRow[]>(`/ingredient-master?q=${encodeURIComponent(mergeQ)}&limit=10`),
    enabled: isReviewer && mergeQ.trim().length > 1,
  })
  const merge = useMutation({
    mutationFn: (intoId: string) => api.post(`/ingredient-master/${master.id}/merge`, { intoId }),
    onSuccess: () => { refresh(); onClose() },
    onError: (e) => setMergeErr(e instanceof ApiError && e.code === 'MERGE_NEEDS_STOCK_MERGE'
      ? `${e.message}. On Inventory, move the stock of one item into the other (count one to zero and the other up), then merge here.`
      : stockErrorText(e)),
  })
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value })

  return (
    <SidePanel title={master.name} subtitle={master.status === 'needs_review' ? 'Needs review' : 'Reviewed'} onClose={onClose} wide>
      <div className="space-y-3">
        <Field label="Name"><Input value={d.name} onChange={set('name')} disabled={!canEdit} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Stock unit" hint="Fixed once a company stocks or cooks it"><select className="s-input" value={d.unit} onChange={set('unit')} disabled={!canEdit}>
            {[...new Set([d.unit, ...UNITS])].map((u) => <option key={u}>{u}</option>)}
          </select></Field>
          <Field label="Category"><select className="s-input" value={d.category} onChange={set('category')} disabled={!canEdit}>
            <option value="">—</option>{INVENTORY_CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select></Field>
          <Field label="Yield %" hint="Edible part after trim"><Input inputMode="decimal" value={d.yieldPct} onChange={set('yieldPct')} disabled={!canEdit} /></Field>
          <Field label="Allergens" hint="Comma separated"><Input value={d.allergens} onChange={set('allergens')} disabled={!canEdit} /></Field>
          <Field label="Bought by" hint="e.g. case of 24"><Input value={d.purchaseUnit} onChange={set('purchaseUnit')} disabled={!canEdit} /></Field>
          <Field label={`Stock units in one ${d.purchaseUnit || 'buying unit'}`}><Input inputMode="decimal" value={d.purchaseUnitFactor} onChange={set('purchaseUnitFactor')} disabled={!canEdit} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3 items-end">
          <label className="flex items-center gap-2 text-sm text-s-text">
            <input type="checkbox" checked={d.perishable} disabled={!canEdit} onChange={(e) => setD({ ...d, perishable: e.target.checked })} />
            Perishable — deliveries carry a use-by date
          </label>
          <Field label="Shelf life (days)" hint="Optional: fills the use-by at the dock (received day + days)">
            <Input inputMode="numeric" value={d.shelfLifeDays} onChange={set('shelfLifeDays')} disabled={!canEdit || !d.perishable} />
          </Field>
        </div>
        <Field label="Spec — what we buy" hint="Printed on purchase orders and the shopping list"><Textarea rows={3} value={d.spec} onChange={set('spec')} disabled={!canEdit} /></Field>
        <div>
          <p className="text-xs font-semibold text-s-text mb-1">Spec details</p>
          {d.specFields.map((r, i) => (
            <div key={i} className="flex gap-2 mb-1">
              <Input className="s-input w-auto flex-1" placeholder="e.g. Fat" value={r.k} disabled={!canEdit} onChange={(e) => setD({ ...d, specFields: d.specFields.map((x, j) => j === i ? { ...x, k: e.target.value } : x) })} />
              <Input className="s-input w-auto flex-1" placeholder="e.g. 20%" value={r.v} disabled={!canEdit} onChange={(e) => setD({ ...d, specFields: d.specFields.map((x, j) => j === i ? { ...x, v: e.target.value } : x) })} />
              {canEdit && <button type="button" className="text-xs text-s-muted" onClick={() => setD({ ...d, specFields: d.specFields.filter((_, j) => j !== i) })} aria-label="Remove">Remove</button>}
            </div>
          ))}
          {canEdit && <button type="button" className="text-xs font-semibold text-primary-ink" onClick={() => setD({ ...d, specFields: [...d.specFields, { k: '', v: '' }] })}>Add a spec line</button>}
        </div>
        {master.price != null && (
          <div className="border-t border-s-border pt-3">
            <p className="text-sm font-semibold text-s-text">Price across servd</p>
            <p className="text-xs text-s-muted mb-2">
              Latest {priceText(master.price.latestCents, master.price)}{lastBought(master.price) ? ` (${lastBought(master.price)})` : ''} — what recipes use.
              {' '}90-day average {priceText(master.price.averageCents, master.price)}{master.price.averageDeliveries ? ` over ${master.price.averageDeliveries} deliveries` : ''}.
            </p>
            <ServdPriceHistory ingredientId={master.id} />
          </div>
        )}
        {save.error && <ErrorBanner message={stockErrorText(save.error)} />}
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button disabled={save.isPending} onClick={() => save.mutate({})}>Save</Button>
            {isReviewer && master.status === 'needs_review' && <Button variant="secondary" disabled={save.isPending} onClick={() => save.mutate({ status: 'approved' })}>Save and mark reviewed</Button>}
          </div>
        )}
        {isReviewer && (
          <div className="border-t border-s-border pt-3">
            <p className="text-sm font-semibold text-s-text">Merge a duplicate</p>
            <p className="text-xs text-s-muted mb-2">Every company&rsquo;s stock item for &ldquo;{master.name}&rdquo; moves to the ingredient you pick; this one is retired.</p>
            <Input value={mergeQ} onChange={(e) => setMergeQ(e.target.value)} placeholder="Search the ingredient to keep…" />
            <ul className="mt-2 space-y-1">
              {candidates.filter((c) => c.id !== master.id).map((c) => (
                <li key={c.id} className="flex items-center justify-between text-sm">
                  <span>{c.name} <span className="text-xs text-s-muted">({c.stockUnit})</span></span>
                  <button type="button" disabled={merge.isPending} onClick={() => { setMergeErr(''); merge.mutate(c.id) }} className="text-xs font-semibold text-primary-ink hover:underline">Merge into this</button>
                </li>
              ))}
            </ul>
            {mergeErr && <ErrorBanner message={mergeErr} />}
          </div>
        )}
      </div>
    </SidePanel>
  )
}

const SOURCE_LABEL: Record<string, string> = { delivery: 'Delivery', bill: 'Bill', manual: 'Cost typed', estimate: 'Estimate' }

/** "PKR 1,250.00 / kg" — or a dash. */
function priceText(cents: number | null | undefined, p: MasterPrice | null | undefined): string {
  if (cents == null || !p) return '—'
  return `PKR ${(cents / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / ${p.displayUnit}`
}

/** "12 Oct · Karachi Meat · GS Foods" for the latest price. */
function lastBought(p: MasterPrice | null | undefined): string | null {
  if (!p || p.latestCents == null) return null
  const when = p.latestAt ? new Date(p.latestAt).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'Asia/Karachi' }) : null
  const what = p.latestSource && p.latestSource !== 'delivery' ? SOURCE_LABEL[p.latestSource] : null
  return [when, what, p.latestSupplier, p.latestCompany].filter(Boolean).join(' · ') || null
}

interface PricePoint { at: string; source: 'delivery' | 'bill' | 'manual'; priceCents: number; displayUnit: string; qty: number | null; supplier: string | null; company: string | null }

/** Every price of the ingredient across servd, newest first (GET /ingredient-master/:id/prices). */
function ServdPriceHistory({ ingredientId }: { ingredientId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['ingredient-master', ingredientId, 'prices'],
    queryFn: () => api.get<{ displayUnit?: string; points: PricePoint[] }>(`/ingredient-master/${ingredientId}/prices`),
  })
  if (isLoading) return <p className="text-xs text-s-muted">Loading prices…</p>
  const points = data?.points ?? []
  if (points.length === 0) return <p className="text-xs text-s-muted">No deliveries or bills yet.</p>
  const fmt = (c: number) => (c / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return (
    <ul className="divide-y divide-s-border text-xs max-h-80 overflow-y-auto">
      {points.map((x, i) => (
        <li key={i} className="py-1.5 flex items-baseline justify-between gap-3 min-w-0">
          <span className="min-w-0 break-words text-s-muted">
            <span className="text-s-text">{new Date(x.at).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'Asia/Karachi' })}</span>
            {' · '}{SOURCE_LABEL[x.source]}{x.supplier ? ` · ${x.supplier}` : ''}{x.company ? ` · ${x.company}` : ''}
            {x.qty != null ? ` · ${x.qty.toLocaleString('en-PK', { maximumFractionDigits: 2 })} ${x.displayUnit}` : ''}
          </span>
          <span className="font-mono whitespace-nowrap">PKR {fmt(x.priceCents)} / {x.displayUnit}</span>
        </li>
      ))}
    </ul>
  )
}
