'use client'
// Sourcing Master Sheet — the ingredient + price catalog. This is the list the
// Recipe page pulls ingredients from. Edit prices/units/notes inline; add new
// items (shared across all brands by default). Actual stock-on-hand lives on
// the separate Inventory page; this sheet is purely "what's available + what it
// costs". Backed by the same InventoryItem table (GET/POST/PATCH /inventory).
import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../lib/api'
import { TenantChip, useMyTenants } from '../../components/ui/TenantPicker'

interface Item {
  id: string; name: string; unit: string
  unitCostCents: number | null; category: string | null; notes: string | null
  tenantId?: string | null
  tenant?: { id: string; name: string; slug: string } | null
}

const UNITS = ['g', 'ml', 'each', 'kg', 'litres', 'pcs', 'dozen']
const fi = 'rounded-md border border-kds-border bg-kds-bg px-2 py-1 text-sm text-kds-text focus:border-kds-green focus:outline-none'

function pkr(cents: number | null): string {
  if (cents == null) return ''
  // sub-rupee per-gram prices need decimals; show up to 3
  return (cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 3 })
}

export default function SourcingPage() {
  const qc = useQueryClient()
  const { data: tenants = [] } = useMyTenants()
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({ name: '', unit: 'g', pricePkr: '', category: '', notes: '' })
  const [err, setErr] = useState('')

  const { data: items = [], isLoading } = useQuery<Item[]>({
    queryKey: ['inventory'],
    queryFn: () => api.get<Item[]>('/inventory'),
  })

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/inventory/${id}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['inventory'] }),
  })
  const add = useMutation({
    mutationFn: () => api.post('/inventory', {
      name: addForm.name.trim(),
      unit: addForm.unit,
      shared: true,
      unitCostCents: addForm.pricePkr.trim() ? Math.round(parseFloat(addForm.pricePkr) * 100) : null,
      category: addForm.category.trim() || null,
      notes: addForm.notes.trim() || null,
    }),
    onSuccess: () => {
      setAddForm({ name: '', unit: 'g', pricePkr: '', category: '', notes: '' }); setShowAdd(false); setErr('')
      void qc.invalidateQueries({ queryKey: ['inventory'] })
    },
    onError: (e: Error) => setErr(e.message),
  })

  // Patch a single field if it actually changed from the server value.
  function savePrice(it: Item, raw: string) {
    const next = raw.trim() ? Math.round(parseFloat(raw) * 100) : null
    if (next !== it.unitCostCents && !(next != null && Number.isNaN(next))) patch.mutate({ id: it.id, body: { unitCostCents: next } })
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

  return (
    <div className="min-h-screen bg-kds-bg">
      <header className="border-b border-kds-border px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-black text-kds-text mt-0.5">Sourcing Master Sheet</h1>
          <p className="text-sm text-kds-subtext">
            {filtered.length} ingredients · {pricedCount} priced. This catalog feeds{' '}
            <Link href="/accounting/recipes" className="text-kds-green hover:underline">Recipe</Link> costing.
            Stock on hand lives on <Link href="/inventory" className="text-kds-green hover:underline">Inventory</Link>.
          </p>
        </div>
        <button onClick={() => setShowAdd((s) => !s)}
          className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90">
          + Add ingredient
        </button>
      </header>

      {showAdd && (
        <div className="mx-6 mt-4 rounded-xl border border-kds-border bg-kds-card p-4">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
            <label className="col-span-2 text-xs text-kds-subtext">Name
              <input value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                placeholder="e.g. Beef Tenderloin" className={fi + ' w-full mt-1'} autoFocus />
            </label>
            <label className="text-xs text-kds-subtext">Unit
              <select value={addForm.unit} onChange={(e) => setAddForm({ ...addForm, unit: e.target.value })} className={fi + ' w-full mt-1'}>
                {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </label>
            <label className="text-xs text-kds-subtext">Price (PKR/unit)
              <input type="number" step="any" min={0} value={addForm.pricePkr} onChange={(e) => setAddForm({ ...addForm, pricePkr: e.target.value })}
                placeholder="1.5" className={fi + ' w-full mt-1'} />
            </label>
            <label className="text-xs text-kds-subtext">Category
              <input value={addForm.category} onChange={(e) => setAddForm({ ...addForm, category: e.target.value })}
                placeholder="protein, produce…" className={fi + ' w-full mt-1'} />
            </label>
            <label className="text-xs text-kds-subtext">Source / notes
              <input value={addForm.notes} onChange={(e) => setAddForm({ ...addForm, notes: e.target.value })}
                placeholder="Region / supplier" className={fi + ' w-full mt-1'} />
            </label>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button onClick={() => add.mutate()} disabled={!addForm.name.trim() || add.isPending}
              className="rounded-lg bg-kds-green text-black font-bold px-4 py-2 text-sm disabled:opacity-50">
              {add.isPending ? 'Adding…' : 'Add (shared)'}
            </button>
            <span className="text-xs text-kds-subtext">New items are shared across all brands.</span>
            {err && <span className="text-xs text-kds-red">{err}</span>}
          </div>
        </div>
      )}

      <main className="px-6 py-4">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ingredients, source, category…"
          className={fi + ' w-full max-w-md mb-3'} />

        {isLoading ? (
          <p className="text-sm text-kds-subtext">Loading…</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-kds-border">
            <table className="w-full text-sm">
              <thead className="text-kds-subtext bg-kds-card">
                <tr className="text-left">
                  <th className="px-3 py-2 font-bold">Ingredient</th>
                  <th className="px-3 py-2 font-bold w-24">Unit</th>
                  <th className="px-3 py-2 font-bold w-36">Price (PKR/unit)</th>
                  <th className="px-3 py-2 font-bold w-32">Category</th>
                  <th className="px-3 py-2 font-bold">Source / notes</th>
                  <th className="px-3 py-2 font-bold w-28">Brand</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((it) => (
                  <tr key={it.id} className="border-t border-kds-border">
                    <td className="px-3 py-1.5">
                      <input key={`n${it.id}${it.name}`} defaultValue={it.name}
                        onBlur={(e) => saveField(it, 'name', e.target.value)} className={fi + ' w-full min-w-[180px]'} />
                    </td>
                    <td className="px-3 py-1.5">
                      <select key={`u${it.id}${it.unit}`} defaultValue={UNITS.includes(it.unit) ? it.unit : 'g'}
                        onChange={(e) => saveField(it, 'unit', e.target.value)} className={fi + ' w-full'}>
                        {(UNITS.includes(it.unit) ? UNITS : [it.unit, ...UNITS]).map((u) => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-1.5">
                      <input key={`p${it.id}${it.unitCostCents}`} type="number" step="any" min={0} defaultValue={pkr(it.unitCostCents)}
                        placeholder="—" onBlur={(e) => savePrice(it, e.target.value)}
                        className={fi + ' w-full text-right font-mono'} />
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
                      {it.tenant
                        ? <TenantChip tenant={it.tenant} tenantId={it.tenantId} tenants={tenants} />
                        : <span className="text-[10px] text-kds-subtext">Shared</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {patch.isError && <p className="mt-2 text-xs text-kds-red">{(patch.error as Error)?.message}</p>}
      </main>
    </div>
  )
}
