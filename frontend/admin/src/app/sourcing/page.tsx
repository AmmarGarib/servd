'use client'
// Sourcing Master Sheet — the ingredient catalogue, per company. This is the
// list the Recipe page pulls ingredients from. Edit names/units/categories/
// notes inline; add new items. Stock on hand lives on the separate Inventory
// page; both pages are views of the same InventoryItem rows and both create
// through POST /inventory, which binds the item to one company (owner
// decision 30, 2026-09-27 — there are no "shared" items any more).
//
// Cost: an ingredient's cost is the moving average of what deliveries actually
// cost, and only receiving moves it. The price typed here is the opening
// estimate for an item nothing has been received for yet; once it has been
// delivered the cell is read-only. (The negotiated list price gets its own
// reference column when InventoryItem.listPriceCents lands.)
import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../lib/api'
import { TenantChip, TenantField, useMyTenants } from '../../components/ui/TenantPicker'
import { useViewAllTenants } from '../../components/ui/TenantSwitcher'
import { useKitchenView } from '../inventory/kitchenView'

interface Item {
  id: string; name: string; unit: string
  unitCostCents: number | null; category: string | null; notes: string | null
  costSource?: 'deliveries' | 'opening'
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

  const { data: items = [], isLoading } = useQuery<Item[]>({
    queryKey: ['inventory'],
    queryFn: () => api.get<Item[]>('/inventory'),
  })

  // The sheet is the catalogue and its prices — the buyer's and the managers'.
  // A line cook holds the inventory module for stock, not for this.
  const kitchenView = useKitchenView(items)

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/inventory/${id}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['inventory'] }),
  })
  const add = useMutation({
    mutationFn: () => api.post('/inventory', {
      name: addForm.name.trim(),
      unit: addForm.unit,
      unitCostCents: addForm.pricePkr.trim() ? Math.round(parseFloat(addForm.pricePkr) * 100) : null,
      category: addForm.category.trim() || null,
      notes: addForm.notes.trim() || null,
      ...(needsCompanyPick && addForm.tenantId ? { tenantId: addForm.tenantId } : {}),
    }),
    onSuccess: () => {
      setAddForm({ name: '', unit: 'g', pricePkr: '', category: '', notes: '', tenantId: '' }); setShowAdd(false); setErr('')
      void qc.invalidateQueries({ queryKey: ['inventory'] })
    },
    onError: (e: Error) => setErr(e.message),
  })

  // Patch a single field if it actually changed from the server value.
  function savePrice(it: Item, raw: string) {
    const next = raw.trim() ? Math.round(parseFloat(raw) * 100) : null
    if (next == null || Number.isNaN(next)) return
    if (next !== it.unitCostCents) patch.mutate({ id: it.id, body: { unitCostCents: next } })
  }
  function saveField(it: Item, field: 'name' | 'unit' | 'category' | 'notes', raw: string) {
    const v = raw.trim()
    const cur = (it[field] ?? '') as string
    if (v !== cur) patch.mutate({ id: it.id, body: { [field]: field === 'name' || field === 'unit' ? v : (v || null) } })
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (items ?? [])
      .filter((i) => !q || i.name.toLowerCase().includes(q) || (i.notes ?? '').toLowerCase().includes(q) || (i.category ?? '').toLowerCase().includes(q))
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
      <header className="border-b border-s-border px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-black text-s-text mt-0.5">Sourcing Master Sheet</h1>
          <p className="text-sm text-s-muted">
            {filtered.length} ingredients · {pricedCount} costed. This catalogue feeds{' '}
            <Link href="/accounting/recipes" className="text-primary-ink hover:underline">Recipe</Link> costing.
            Stock on hand lives on <Link href="/inventory" className="text-primary-ink hover:underline">Inventory</Link>.
          </p>
          <p className="text-xs text-s-muted mt-1">
            Cost is the average of what deliveries cost. You can type an opening cost for an item that has not been delivered yet.
          </p>
        </div>
        <button onClick={() => setShowAdd((s) => !s)}
          className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90">
          + Add ingredient
        </button>
      </header>

      {unassignedCount > 0 && (
        <div className="mx-6 mt-4 rounded-xl border border-s-amber/40 bg-s-amber/5 px-4 py-3 text-sm text-s-text">
          {unassignedCount} ingredient{unassignedCount === 1 ? ' has' : 's have'} no company. Their waste never reaches the books and
          their cost can be moved by either company&rsquo;s deliveries. Assign each one in the Company column.
        </div>
      )}

      {showAdd && (
        <div className="mx-6 mt-4 rounded-xl border border-s-border bg-s-surface p-4">
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
            <label className="text-xs text-s-muted">Category
              <input value={addForm.category} onChange={(e) => setAddForm({ ...addForm, category: e.target.value })}
                placeholder="protein, produce…" className={fi + ' w-full mt-1'} />
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

      <main className="px-6 py-4">
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
                  <th className="px-3 py-2 font-bold w-32">Category</th>
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
                        <span className="block w-full text-right font-mono text-s-text" title="Average of what deliveries cost — moves when stock is received">
                          {pkr(it.unitCostCents) || '—'}
                          <span className="ml-1 text-[10px] font-sans text-s-muted">avg</span>
                        </span>
                      ) : (
                        <input key={`p${it.id}${it.unitCostCents}`} type="number" step="any" min={0} defaultValue={pkr(it.unitCostCents)}
                          placeholder="—" title="Opening cost — replaced by the delivery average at the first delivery"
                          onBlur={(e) => savePrice(it, e.target.value)}
                          className={fi + ' w-full text-right font-mono'} />
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <input key={`c${it.id}${it.category}`} defaultValue={it.category ?? ''}
                        onBlur={(e) => saveField(it, 'category', e.target.value)} className={fi + ' w-full'} />
                    </td>
                    <td className="px-3 py-1.5">
                      <input key={`d${it.id}${it.notes}`} defaultValue={it.notes ?? ''}
                        onBlur={(e) => saveField(it, 'notes', e.target.value)} className={fi + ' w-full min-w-[200px]'} />
                    </td>
                    <td className="px-3 py-1.5">
                      {it.tenantId
                        ? <TenantChip tenant={it.tenant} tenantId={it.tenantId} tenants={tenants} />
                        : (
                          <select defaultValue="" className={fi + ' w-full'}
                            onChange={(e) => { if (e.target.value) patch.mutate({ id: it.id, body: { tenantId: e.target.value } }) }}>
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
        {patch.isError && <p className="mt-2 text-xs text-s-red">{(patch.error as Error)?.message}</p>}
      </main>
    </div>
  )
}
