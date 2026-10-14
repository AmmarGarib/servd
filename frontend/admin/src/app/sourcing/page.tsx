'use client'
// Sourcing Master Sheet — the ingredient catalogue, per company. This is the
// list the Recipe page pulls ingredients from. Edit names/units/categories/
// notes inline; add new items. Stock on hand lives on the separate Inventory
// page; both pages are views of the same InventoryItem rows and both create
// through POST /inventory, which binds the item to one company (owner
// decision 30, 2026-09-27 — there are no "shared" items any more).
//
// Cost: an ingredient's cost is the price actually paid (the oldest open stock
// lot), and only receiving moves it. The price typed here is the opening
// estimate for an item nothing has been received for yet; once it has stock or
// has been delivered the cell is read-only (422 COST_FROM_DELIVERIES).
//
// Category: a fixed list. The category decides the stock account the item's
// value sits in — Drinks in 1220, Packaging in 1230, everything else in 1210.
// "Issue on receipt" (managers) is for oil, salt and other items no recipe
// measures: each delivery goes straight to cost of sales. (The negotiated list price gets its own
// reference column when InventoryItem.listPriceCents lands.)
import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../lib/api'
import { TenantChip, TenantField, useMyTenants } from '../../components/ui/TenantPicker'
import { useViewAllTenants } from '../../components/ui/TenantSwitcher'
import { useKitchenView } from '../inventory/kitchenView'
import { useManagerRoles } from '../../lib/roles'
import { useAuthStore } from '../../store/auth'
import { INVENTORY_CATEGORY_OPTIONS, categoryOptionText, categoryValueOf, stockErrorText } from '../../lib/stockUi'

interface Item {
  id: string; name: string; unit: string
  unitCostCents: number | null; category: string | null; notes: string | null
  costSource?: 'deliveries' | 'opening'
  currentStock?: number
  /** Oil, salt and other items no recipe measures: each receipt goes straight to cost of sales. */
  issueOnReceipt?: boolean
  costsHidden?: boolean
  tenantId?: string | null
  tenant?: { id: string; name: string; slug: string } | null
}

// 'dozen' is not offered: recipe costing treats every non-kg/litre unit as
// per piece, so a dozen-priced item costed 12x too much.
const UNITS = ['g', 'ml', 'each', 'kg', 'litres', 'pcs']
const fi = 'rounded-md border border-s-border bg-s-bg px-2 py-1 text-sm text-s-text focus:border-primary focus:outline-none'

function pkr(cents: number | null): string {
  if (cents == null) return ''
  // sub-rupee per-gram prices need decimals; show up to 3
  return (cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 3 })
}

export default function SourcingPage() {
  const qc = useQueryClient()
  const { data: tenants = [] } = useMyTenants()
  const viewAll = useViewAllTenants()
  const needsCompanyPick = viewAll && tenants.length > 1
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({ name: '', unit: 'g', pricePkr: '', category: '', notes: '', tenantId: '' })
  const [err, setErr] = useState('')
  const me = useAuthStore((s) => s.user)
  const managerRoles = useManagerRoles()
  const canSetIssueOnReceipt = managerRoles.has(me?.role ?? '')
  // A company-less item that holds stock gets an opening count in its new
  // company, at a unit cost typed here (finance, CEO or management).
  const [assigning, setAssigning] = useState<{ item: Item; tenantId: string; costPkr: string } | null>(null)

  const { data: items = [], isLoading } = useQuery<Item[]>({
    queryKey: ['inventory'],
    queryFn: () => api.get<Item[]>('/inventory'),
  })

  // The sheet is the catalogue and its prices — the buyer's and the managers'.
  // A line cook holds the inventory module for stock, not for this.
  const kitchenView = useKitchenView(items)

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/inventory/${id}`, body),
    onSuccess: () => { setAssigning(null); void qc.invalidateQueries({ queryKey: ['inventory'] }) },
  })
  const add = useMutation({
    mutationFn: () => api.post('/inventory', {
      name: addForm.name.trim(),
      unit: addForm.unit,
      unitCostCents: addForm.pricePkr.trim() ? Math.round(parseFloat(addForm.pricePkr) * 100) : null,
      category: addForm.category || null,
      notes: addForm.notes.trim() || null,
      ...(needsCompanyPick && addForm.tenantId ? { tenantId: addForm.tenantId } : {}),
    }),
    onSuccess: () => {
      setAddForm({ name: '', unit: 'g', pricePkr: '', category: '', notes: '', tenantId: '' }); setShowAdd(false); setErr('')
      void qc.invalidateQueries({ queryKey: ['inventory'] })
    },
    onError: (e: Error) => setErr(stockErrorText(e)),
  })

  // Patch a single field if it actually changed from the server value.
  function savePrice(it: Item, raw: string) {
    const next = raw.trim() ? Math.round(parseFloat(raw) * 100) : null
    if (next == null || Number.isNaN(next)) return
    if (next !== it.unitCostCents) patch.mutate({ id: it.id, body: { unitCostCents: next } })
  }
  function saveField(it: Item, field: 'name' | 'unit' | 'notes', raw: string) {
    const v = raw.trim()
    const cur = (it[field] ?? '') as string
    if (v !== cur) patch.mutate({ id: it.id, body: { [field]: field === 'name' || field === 'unit' ? v : (v || null) } })
  }
  function saveCategory(it: Item, value: string) {
    if (value !== categoryValueOf(it.category)) patch.mutate({ id: it.id, body: { category: value || null } })
  }
  function pickCompany(it: Item, tenantId: string) {
    if (!tenantId) return
    if ((it.currentStock ?? 0) > 0) {
      setAssigning({ item: it, tenantId, costPkr: it.unitCostCents != null ? String(it.unitCostCents / 100) : '' })
      return
    }
    patch.mutate({ id: it.id, body: { tenantId } })
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (items ?? [])
      .filter((i) => !q || i.name.toLowerCase().includes(q) || (i.notes ?? '').toLowerCase().includes(q)
        || (INVENTORY_CATEGORY_OPTIONS.find((o) => o.value === categoryValueOf(i.category))?.label ?? '').toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [items, search])

  const pricedCount = filtered.filter((i) => i.unitCostCents != null).length
  const unassignedCount = (items ?? []).filter((i) => !i.tenantId).length

  if (kitchenView) {
    return (
      <div className="min-h-screen bg-s-bg px-6 py-10">
        <h1 className="text-2xl font-black text-s-text">Sourcing Master Sheet</h1>
        <p className="text-sm text-s-muted mt-2 max-w-xl">
          The sourcing sheet holds ingredient prices and suppliers, so it is kept by managers and the buyer.
          Stock on hand, counts, low stock and prep are on{' '}
          <Link href="/inventory" className="text-primary-ink hover:underline">Inventory</Link>.
        </p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="border-b border-s-border px-4 sm:px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-black text-s-text mt-0.5">Sourcing Master Sheet</h1>
          <p className="text-sm text-s-muted">
            {filtered.length} ingredients · {pricedCount} costed. This catalogue feeds{' '}
            <Link href="/accounting/recipes" className="text-primary-ink hover:underline">Recipe</Link> costing.
            Stock on hand lives on <Link href="/inventory" className="text-primary-ink hover:underline">Inventory</Link>.
          </p>
          <p className="text-xs text-s-muted mt-1">
            Cost is the price actually paid for the stock. You can type an opening cost for an item that has no stock or deliveries yet.
          </p>
        </div>
        <button onClick={() => setShowAdd((s) => !s)}
          className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90">
          + Add ingredient
        </button>
      </header>

      {unassignedCount > 0 && (
        <div className="mx-4 sm:mx-6 mt-4 rounded-xl border border-s-amber/40 bg-s-amber/5 px-4 py-3 text-sm text-s-text">
          {unassignedCount} ingredient{unassignedCount === 1 ? ' has' : 's have'} no company. Their waste never reaches the books and
          their cost can be moved by either company&rsquo;s deliveries. Assign each one in the Company column; an item that holds stock
          is booked as an opening count at the unit cost you give (finance, the CEO or management).
        </div>
      )}

      {assigning && (
        <div className="mx-4 sm:mx-6 mt-4 rounded-xl border border-primary bg-s-surface p-4 space-y-3">
          <p className="font-bold text-s-text text-sm">
            Assign {assigning.item.name} to {tenants.find((t) => t.id === assigning.tenantId)?.name ?? 'the company'}
          </p>
          <p className="text-xs text-s-muted">
            It holds {assigning.item.currentStock} {assigning.item.unit} with no company. Giving it a company books that stock as an opening count
            to the owner&rsquo;s capital, at this unit cost.
          </p>
          <label className="block max-w-xs text-xs text-s-muted">Opening unit cost (PKR per {assigning.item.unit})
            <input type="number" step="any" min={0} value={assigning.costPkr} autoFocus
              onChange={(e) => setAssigning({ ...assigning, costPkr: e.target.value })} className={fi + ' w-full mt-1'} />
          </label>
          <div className="flex gap-2">
            <button disabled={patch.isPending || assigning.costPkr.trim() === ''}
              onClick={() => patch.mutate({ id: assigning.item.id, body: { tenantId: assigning.tenantId, unitCostCents: Math.round(Number(assigning.costPkr) * 100) } })}
              className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm disabled:opacity-50">
              {patch.isPending ? 'Assigning…' : 'Assign company'}
            </button>
            <button onClick={() => setAssigning(null)} className="rounded-xl border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
          </div>
        </div>
      )}

      {showAdd && (
        <div className="mx-4 sm:mx-6 mt-4 rounded-xl border border-s-border bg-s-surface p-4">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
            <label className="col-span-2 text-xs text-s-muted">Name
              <input value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                placeholder="e.g. Beef Tenderloin" className={fi + ' w-full mt-1'} autoFocus />
            </label>
            <label className="text-xs text-s-muted">Unit
              <select value={addForm.unit} onChange={(e) => setAddForm({ ...addForm, unit: e.target.value })} className={fi + ' w-full mt-1'}>
                {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </label>
            <label className="text-xs text-s-muted">Opening cost (PKR/unit)
              <input type="number" step="any" min={0} value={addForm.pricePkr} onChange={(e) => setAddForm({ ...addForm, pricePkr: e.target.value })}
                placeholder="1.5" className={fi + ' w-full mt-1'} />
            </label>
            <label className="text-xs text-s-muted col-span-2 md:col-span-1">Category
              <select value={addForm.category} onChange={(e) => setAddForm({ ...addForm, category: e.target.value })} className={fi + ' w-full mt-1'}>
                <option value="">— pick a category —</option>
                {INVENTORY_CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{categoryOptionText(o)}</option>)}
              </select>
            </label>
            <label className="text-xs text-s-muted">Source / notes
              <input value={addForm.notes} onChange={(e) => setAddForm({ ...addForm, notes: e.target.value })}
                placeholder="Region / supplier" className={fi + ' w-full mt-1'} />
            </label>
          </div>
          {needsCompanyPick && (
            <div className="mt-3 max-w-xs">
              <TenantField value={addForm.tenantId} autoDefault={false} required={!addForm.tenantId}
                onChange={(id) => setAddForm({ ...addForm, tenantId: id })} />
            </div>
          )}
          <div className="mt-3 flex items-center gap-3">
            <button onClick={() => add.mutate()}
              disabled={!addForm.name.trim() || (needsCompanyPick && !addForm.tenantId) || add.isPending}
              className="rounded-lg bg-primary text-primary-on font-bold px-4 py-2 text-sm disabled:opacity-50">
              {add.isPending ? 'Adding…' : 'Add ingredient'}
            </button>
            <span className="text-xs text-s-muted">
              {needsCompanyPick ? 'Added to the company you pick.' : 'Added to your current company.'}
            </span>
            {err && <span className="text-xs text-s-red">{err}</span>}
          </div>
        </div>
      )}

      <main className="px-4 sm:px-6 py-4">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ingredients, source, category…"
          className={fi + ' w-full max-w-md mb-3'} />

        {isLoading ? (
          <p className="text-sm text-s-muted">Loading…</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-s-border">
            <table className="w-full text-sm">
              <thead className="text-s-muted bg-s-surface">
                <tr className="text-left">
                  <th className="px-3 py-2 font-bold">Ingredient</th>
                  <th className="px-3 py-2 font-bold w-24">Unit</th>
                  <th className="px-3 py-2 font-bold w-36">Cost (PKR/unit)</th>
                  <th className="px-3 py-2 font-bold w-56">Category (stock account)</th>
                  {canSetIssueOnReceipt && <th className="px-3 py-2 font-bold w-36" title="For oil, salt and other items no recipe measures">Issue on receipt</th>}
                  <th className="px-3 py-2 font-bold">Source / notes</th>
                  <th className="px-3 py-2 font-bold w-40">Company</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((it) => (
                  <tr key={it.id} className="border-t border-s-border">
                    <td className="px-3 py-1.5">
                      <input key={`n${it.id}${it.name}`} defaultValue={it.name}
                        onBlur={(e) => saveField(it, 'name', e.target.value)} className={fi + ' w-full min-w-[180px]'} />
                    </td>
                    <td className="px-3 py-1.5">
                      <select key={`u${it.id}${it.unit}`} defaultValue={it.unit}
                        onChange={(e) => saveField(it, 'unit', e.target.value)} className={fi + ' w-full'}>
                        {(UNITS.includes(it.unit) ? UNITS : [it.unit, ...UNITS]).map((u) => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-1.5">
                      {it.costSource === 'deliveries' ? (
                        <span className="block w-full text-right font-mono text-s-text" title="The price actually paid — moves when stock is received, not by typing">
                          {pkr(it.unitCostCents) || '—'}
                          <span className="ml-1 text-[10px] font-sans text-s-muted">paid</span>
                        </span>
                      ) : (
                        <input key={`p${it.id}${it.unitCostCents}`} type="number" step="any" min={0} defaultValue={pkr(it.unitCostCents)}
                          placeholder="—" title="Opening cost — replaced by the delivery average at the first delivery"
                          onBlur={(e) => savePrice(it, e.target.value)}
                          className={fi + ' w-full text-right font-mono'} />
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <select key={`c${it.id}${it.category}`} defaultValue={categoryValueOf(it.category)}
                        onChange={(e) => saveCategory(it, e.target.value)} className={fi + ' w-full'} aria-label={`${it.name} category`}>
                        <option value="">— none —</option>
                        {INVENTORY_CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{categoryOptionText(o)}</option>)}
                      </select>
                    </td>
                    {canSetIssueOnReceipt && (
                      <td className="px-3 py-1.5">
                        {it.tenantId ? (
                          <label className="flex items-center gap-2 text-xs text-s-muted cursor-pointer">
                            <input type="checkbox" className="accent-accent" checked={!!it.issueOnReceipt}
                              onChange={(e) => patch.mutate({ id: it.id, body: { issueOnReceipt: e.target.checked } })} />
                            {it.issueOnReceipt ? 'On' : 'Off'}
                          </label>
                        ) : <span className="text-xs text-s-muted">—</span>}
                      </td>
                    )}
                    <td className="px-3 py-1.5">
                      <input key={`d${it.id}${it.notes}`} defaultValue={it.notes ?? ''}
                        onBlur={(e) => saveField(it, 'notes', e.target.value)} className={fi + ' w-full min-w-[200px]'} />
                    </td>
                    <td className="px-3 py-1.5">
                      {it.tenantId
                        ? <TenantChip tenant={it.tenant} tenantId={it.tenantId} tenants={tenants} />
                        : (
                          <select defaultValue="" className={fi + ' w-full'}
                            onChange={(e) => pickCompany(it, e.target.value)}>
                            <option value="">No company — assign…</option>
                            {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                          </select>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canSetIssueOnReceipt && (
          <p className="mt-3 text-xs text-s-muted">
            <span className="font-semibold text-s-text">Issue on receipt</span> is for oil, salt and other items no recipe measures: each delivery goes straight to cost of sales instead of sitting in stock.
          </p>
        )}
        {patch.isError && <p role="alert" className="mt-2 text-xs text-s-red">{stockErrorText(patch.error)}</p>}
      </main>
    </div>
  )
}
