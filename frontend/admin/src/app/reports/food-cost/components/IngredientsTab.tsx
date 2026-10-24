'use client'
// Ingredients: per item of one company, opening → received → used → closing,
// with the unexplained (count variance + cooked while not on the books)
// first. Class and brand filters; a row opens its lot movements.
import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../../lib/api'
import { ErrorNote, Section, pkr, qtyText } from './ui'
import type { IngredientRow, IngredientsResponse, MovementsResponse } from './types'
import { Select } from '@/components/ui/Select'

const CLASSES: Array<{ key: string; label: string }> = [
  { key: '', label: 'All classes' }, { key: 'food', label: 'Food' }, { key: 'beverage', label: 'Drinks' }, { key: 'packaging', label: 'Packaging' },
]
const SORTS: Array<{ key: string; label: string }> = [
  { key: 'unexplained', label: 'Unexplained PKR' }, { key: 'theoretical', label: 'Theoretical PKR' }, { key: 'waste', label: 'Waste PKR' }, { key: 'name', label: 'Name' },
]
const KIND_LABEL: Record<string, string> = {
  receipt: 'Received', opening: 'Opening', fifo_cutover: 'Cut-over lot', count_gain: 'Count over', count_loss: 'Count short', sale: 'Sold',
  sale_return: 'Given back', sale_void: 'Voided (to waste)', waste: 'Waste', prep_draw: 'Prep', supplier_return: 'Returned to supplier',
  cost_adjust: 'Price adjustment', class_reclass: 'Class change', legacy_return: 'Given back (pre-FIFO)', issue_on_receipt: 'Issued on receipt',
  shortfall_settle: 'Late delivery settled', transfer_out: 'Sent to another outlet', transfer_in: 'Arrived from another outlet', prep_make: 'Prep made',
}

function Cell({ v, unit }: { v: { qty: number; cents: number }; unit: string }) {
  if (Math.abs(v.qty) < 1e-9 && v.cents === 0) return <td className="text-right text-s-dim">—</td>
  return (
    <td className="text-right">
      <span className="font-mono">{pkr(v.cents)}</span>
      <p className="text-[10px] text-s-dim">{qtyText(v.qty, unit)}</p>
    </td>
  )
}

function Flags({ r }: { r: IngredientRow }) {
  return (
    <div className="flex flex-wrap gap-1">
      {r.flags.noCost && <span className="s-badge-amber">no cost</span>}
      {r.flags.notOnAnyRecipe && <span className="s-badge-muted">on no recipe</span>}
      {r.flags.shortfall && <span className="s-badge-red">cooked before received</span>}
      {r.flags.notCountedInPeriod && <span className="s-badge-muted">not counted</span>}
    </div>
  )
}

function Movements({ id, qs }: { id: string; qs: string }) {
  const { data, error, isLoading } = useQuery<MovementsResponse>({
    queryKey: ['food-cost', 'movements', id, qs],
    queryFn: () => api.get(`/reports/food-cost/ingredients/${id}/movements?${qs}`),
  })
  if (isLoading) return <p className="p-4 text-sm text-s-dim">Loading lots…</p>
  if (error || !data) return <div className="p-4"><ErrorNote error={error} /></div>
  return (
    <div className="space-y-3 p-3">
      <p className="text-xs text-s-muted">{data.item.name} · {data.item.classLabel} · on hand {qtyText(data.item.currentStock, data.item.unit)} · next cost {pkr(data.item.unitCostCents)} / {data.item.unit}</p>
      <div className="overflow-x-auto">
        <table className="s-table">
          <thead><tr><th>Lot received</th><th>Source</th><th className="text-right">In</th><th className="text-right">Left</th><th className="text-right">Unit cost</th><th className="text-right">Value left</th></tr></thead>
          <tbody>
            {data.lots.map((l) => (
              <tr key={l.id}>
                <td>{l.receivedAt.slice(0, 10)}</td><td className="text-s-muted">{l.sourceType.replace(/_/g, ' ')}</td>
                <td className="text-right">{qtyText(l.qtyIn)}</td><td className="text-right">{qtyText(l.remainingQty)}</td>
                <td className="text-right font-mono">{pkr(l.unitCostCents)}</td><td className="text-right font-mono">{pkr(l.remainingValueCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="max-h-80 overflow-auto">
        <table className="s-table">
          <thead><tr><th>When</th><th>Movement</th><th className="text-right">Quantity</th><th className="text-right">Value</th><th>Note</th></tr></thead>
          <tbody>
            {data.movements.length === 0 && <tr><td colSpan={5} className="text-center text-s-dim">No movements in this period</td></tr>}
            {data.movements.map((m) => (
              <tr key={m.id}>
                <td>{m.occurredAt.slice(0, 16).replace('T', ' ')}</td>
                <td>{KIND_LABEL[m.kind] ?? m.kind}</td>
                <td className="text-right">{qtyText(m.qty, data.item.unit)}{m.shortfallQty ? <span className="ml-1 s-badge-red">short {qtyText(m.shortfallQty)}</span> : null}</td>
                <td className="text-right font-mono">{pkr(m.valueCents)}</td>
                <td className="text-s-dim">{m.allocated ? 'allocated by use' : m.orderId ? `order ${m.orderId.slice(-8).toUpperCase()}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function IngredientsTab({ tenantId, range, brands, locationId }: {
  tenantId: string; range: { from: string; to: string }; brands: Array<{ id: string; name: string }>; locationId?: string
}) {
  const [costClass, setCostClass] = useState('')
  const [conceptId, setConceptId] = useState('')
  const [sort, setSort] = useState('unexplained')
  const [open, setOpen] = useState<string | null>(null)
  const p = new URLSearchParams({ tenantId, from: range.from, to: range.to, sort })
  if (costClass) p.set('costClass', costClass)
  if (conceptId) p.set('conceptId', conceptId)
  if (locationId) p.set('locationId', locationId)
  const qs = p.toString()
  const { data, error, isLoading } = useQuery<IngredientsResponse>({
    queryKey: ['food-cost', 'ingredients', qs],
    queryFn: () => api.get(`/reports/food-cost/ingredients?${qs}`),
  })
  const rangeQs = new URLSearchParams({ from: range.from, to: range.to }).toString()

  return (
    <Section title="Ingredients" hint="Opening + received − used = closing, at the lot cost. Unexplained = count differences and food cooked before its delivery was entered.">
      <div className="mb-3 flex flex-wrap gap-2">
        <Select className="s-select w-auto" value={costClass} onChange={(e) => setCostClass(e.target.value)} aria-label="Class">
          {CLASSES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </Select>
        <Select className="s-select w-auto" value={conceptId} onChange={(e) => setConceptId(e.target.value)} aria-label="Brand">
          <option value="">All brands</option>
          {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>
        <Select className="s-select w-auto" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          {SORTS.map((s) => <option key={s.key} value={s.key}>Sort: {s.label}</option>)}
        </Select>
      </div>
      <ErrorNote error={error} />
      {isLoading ? <p className="py-6 text-center text-sm text-s-dim">Loading…</p> : (
        <div className="overflow-x-auto">
          <table className="s-table">
            <thead>
              <tr>
                <th>Ingredient</th><th>Class</th><th className="text-right">Opening</th><th className="text-right">Received</th>
                <th className="text-right">Theoretical</th><th className="text-right">Comps / meals</th><th className="text-right">Waste</th>
                <th className="text-right">Prep</th><th className="text-right">Count</th><th className="text-right">Closing</th>
                <th className="text-right">Unexplained</th><th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {(data?.rows ?? []).length === 0 && <tr><td colSpan={12} className="text-center text-s-dim">No stock moved in this period</td></tr>}
              {(data?.rows ?? []).map((r) => (
                <Fragment key={r.inventoryItemId}>
                  <tr className="cursor-pointer" onClick={() => setOpen(open === r.inventoryItemId ? null : r.inventoryItemId)}>
                    <td className="font-semibold">{r.name}</td>
                    <td className="text-s-muted">{r.classLabel}</td>
                    <Cell v={r.opening} unit={r.unit} />
                    <Cell v={r.received} unit={r.unit} />
                    <Cell v={r.theoretical} unit={r.unit} />
                    <Cell v={{ qty: r.comps.qty + r.staffMeals.qty, cents: r.comps.cents + r.staffMeals.cents }} unit={r.unit} />
                    <Cell v={r.waste} unit={r.unit} />
                    <Cell v={r.prep} unit={r.unit} />
                    <Cell v={r.count} unit={r.unit} />
                    <Cell v={r.closing} unit={r.unit} />
                    <td className="text-right" style={{ color: r.unexplained.cents > 0 ? 'var(--erp-danger)' : r.unexplained.cents < 0 ? 'var(--erp-success)' : undefined }}>
                      <span className="font-mono font-semibold">{pkr(r.unexplained.cents)}</span>
                      <p className="text-[10px] opacity-70">{qtyText(r.unexplained.qty, r.unit)}</p>
                    </td>
                    <td><Flags r={r} /></td>
                  </tr>
                  {open === r.inventoryItemId && (
                    <tr><td colSpan={12} className="whitespace-normal p-0" style={{ background: 'rgb(var(--fg-rgb) / 0.02)' }}><Movements id={r.inventoryItemId} qs={rangeQs} /></td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}
