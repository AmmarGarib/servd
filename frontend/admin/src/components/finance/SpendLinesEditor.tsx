'use client'
// What cash was spent on — the lines of a petty-cash spend or of a cash
// request's receipts. Three kinds:
//   • Expense — a category from the server's one list (GET
//     /trustops/petty-cash/categories — key, label, chart code), or for a cash
//     keeper an explicit operating-expense (6xxx) account of the company.
//   • Stock item — food, drinks or packaging bought with cash: the item, the
//     quantity and the unit it was bought in, and what was paid. The server
//     brings it into stock (a settled goods receipt, FIFO lots) and books it to
//     the item's inventory account. Offered when the login can read the stock
//     list (GET /inventory; hidden on 403). The server allows cash keepers and
//     roles with the inventory module only.
//   • Equipment (CapEx) — paid against a CapEx line (GET /finance/capex;
//     finance and the CEO, hidden on 403), booked to the asset side.
// An optional brand per line; a running total against the spend's amount
// (`mode` 'equal': the lines must add up to it; 'atMost': up to it — a cash
// request's receipts may cover part of what is still open).
//
// The server decides (accounting/pettyCashPosting.ts resolveSpendLinesTx):
// kitchen food / drinks / packaging are never expense lines (they come in as
// stock), equipment is never an expense (422 USE_CAPEX — finance / the CEO
// can say "not equipment" with a reason), and a brand, item or CapEx line of
// another company is 422.

import { useQuery } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import { MoneyInput } from '../ui/MoneyInput'
import { Select } from '@/components/ui/Select'

export type SpendLineKind = 'expense' | 'stock' | 'capex'
/** Every line kind this editor knows. */
export const LINE_KINDS: ReadonlyArray<{ kind: SpendLineKind; label: string }> = [
  { kind: 'expense', label: 'Expense' },
  { kind: 'stock', label: 'Stock item' },
  { kind: 'capex', label: 'Equipment (CapEx)' },
]

export interface SpendLine {
  kind: SpendLineKind
  categoryKey: string
  /** Explicit 6xxx — keepers only; used when categoryKey is empty. */
  accountCode: string
  amountCents: number
  description: string
  conceptId: string
  notEquipment?: boolean
  notEquipmentReason?: string
  // Stock item
  inventoryItemId?: string
  /** As typed (a number in `unit`). */
  quantity?: string
  unit?: string
  // Equipment
  capexLineId?: string
}

export interface SpendCategory { key: string; label: string; code: string; kind: string }

export const emptyLine = (amountCents = 0, description = ''): SpendLine =>
  ({ kind: 'expense', categoryKey: '', accountCode: '', amountCents, description, conceptId: '' })

const qtyOf = (l: SpendLine) => Number((l.quantity ?? '').replace(/,/g, ''))

/** The body the API takes for a line (empty strings dropped). */
export function lineBody(l: SpendLine) {
  const common = {
    kind: l.kind,
    amountCents: l.amountCents,
    description: l.description.trim(),
    ...(l.conceptId && { conceptId: l.conceptId }),
  }
  if (l.kind === 'stock') {
    return { ...common, inventoryItemId: l.inventoryItemId, quantity: qtyOf(l), ...(l.unit?.trim() && { unit: l.unit.trim() }) }
  }
  if (l.kind === 'capex') return { ...common, capexLineId: l.capexLineId }
  return {
    ...common,
    ...(l.categoryKey ? { categoryKey: l.categoryKey } : l.accountCode ? { accountCode: l.accountCode } : {}),
    ...(l.notEquipment && { notEquipment: true, notEquipmentReason: l.notEquipmentReason ?? '' }),
  }
}

/** One line says all it must for its kind. */
export function lineReady(l: SpendLine): boolean {
  if (!(l.amountCents > 0)) return false
  if (l.kind === 'stock') return !!l.inventoryItemId && qtyOf(l) > 0
  if (l.kind === 'capex') return !!l.capexLineId && !!l.description.trim()
  return (!!l.categoryKey || /^6\d{3}$/.test(l.accountCode)) && !!l.description.trim()
}

/**
 * True when every line is complete and the lines add up to `totalCents`
 * ('equal', a box spend) or come to no more than it ('atMost', receipts on a
 * cash request).
 */
export function linesReady(lines: SpendLine[], totalCents: number, mode: 'equal' | 'atMost' = 'equal'): boolean {
  const sum = lines.reduce((s, l) => s + l.amountCents, 0)
  return lines.length > 0 && lines.every(lineReady) && (mode === 'equal' ? sum === totalCents : sum > 0 && sum <= totalCents)
}

const pkr = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`
const UNITS = ['kg', 'g', 'l', 'ml', 'pcs', 'dozen', 'pack', 'box']

interface StockItem { id: string; name: string; unit: string; tenantId: string | null; category: string | null }
interface CapexProject { id: string; name: string; tenantId: string | null; lines: Array<{ id: string; item: string; scope: string | null; treatment?: string | null }> }

const no403 = (count: number, err: unknown) => !(err instanceof ApiError && (err.status === 403 || err.status === 404)) && count < 1

export function SpendLinesEditor({
  lines,
  onChange,
  totalCents,
  canPickAccount,
  tenantId,
  fieldClassName,
  mode = 'equal',
  kinds = ['expense', 'stock', 'capex'],
}: {
  lines: SpendLine[]
  onChange: (next: SpendLine[]) => void
  /** The spend's amount (or what is still open on a cash request). */
  totalCents: number
  /** A cash keeper may book a line to an explicit 6xxx account. */
  canPickAccount: boolean
  /** The company of the box / request: brands, items, CapEx lines and accounts are its own. */
  tenantId: string | null
  fieldClassName: string
  mode?: 'equal' | 'atMost'
  /** The kinds offered (a kind whose list this login cannot read is hidden). */
  kinds?: SpendLineKind[]
}) {
  const { data: cats } = useQuery<{ categories: SpendCategory[] }>({
    queryKey: ['petty-cash-categories'],
    queryFn: () => api.get('/trustops/petty-cash/categories'),
    staleTime: 300_000,
  })
  const categories = (cats?.categories ?? []).filter((c) => c.kind === 'expense')
  const { data: brands = [] } = useQuery<Array<{ id: string; name: string; tenantId: string | null }>>({
    queryKey: ['concepts-picker'],
    queryFn: () => api.get('/concepts?view=picker'),
    retry: false, meta: { background: true }, staleTime: 300_000,
  })
  const companyBrands = brands.filter((b) => !tenantId || b.tenantId === tenantId)
  const { data: chart = [] } = useQuery<Array<{ code: string; name: string; type: string; isActive: boolean; tenantId: string | null }>>({
    queryKey: ['chart-of-accounts'],
    queryFn: () => api.get('/setup/chart-of-accounts'),
    enabled: canPickAccount,
    retry: false, meta: { background: true }, staleTime: 300_000,
  })
  const expenseAccounts = chart.filter((a) => /^6\d{3}$/.test(a.code) && a.isActive && (!tenantId || a.tenantId === tenantId))
  const { data: stockItems, isError: stockHidden } = useQuery<StockItem[]>({
    queryKey: ['inventory-items-picker'],
    queryFn: () => api.get('/inventory'),
    enabled: kinds.includes('stock'),
    retry: no403, meta: { background: true }, staleTime: 300_000,
  })
  const items = (stockItems ?? []).filter((i) => !tenantId || i.tenantId === tenantId)
  const { data: projects, isError: capexHidden } = useQuery<CapexProject[]>({
    queryKey: ['capex-projects-picker'],
    queryFn: () => api.get('/finance/capex'),
    enabled: kinds.includes('capex'),
    retry: no403, meta: { background: true }, staleTime: 300_000,
  })
  const capexLines = (projects ?? [])
    .filter((p) => !tenantId || p.tenantId === tenantId)
    .flatMap((p) => p.lines.map((l) => ({ id: l.id, label: `${p.name} — ${l.item}` })))

  const offered = LINE_KINDS.filter((k) => kinds.includes(k.kind)
    && (k.kind !== 'stock' || (!stockHidden && !!stockItems))
    && (k.kind !== 'capex' || (!capexHidden && !!projects)))

  const sum = lines.reduce((s, l) => s + l.amountCents, 0)
  const set = (i: number, patch: Partial<SpendLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const switchKind = (i: number, kind: SpendLineKind) =>
    set(i, { kind, categoryKey: '', accountCode: '', inventoryItemId: '', quantity: '', unit: '', capexLineId: '', notEquipment: undefined })
  const balanced = mode === 'equal' ? sum === totalCents : sum > 0 && sum <= totalCents

  return (
    <div className="space-y-2">
      {lines.map((l, i) => {
        const item = items.find((x) => x.id === l.inventoryItemId)
        return (
          <div key={i} className="rounded-lg p-3 space-y-2" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.07)' }}>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[11px] font-bold uppercase tracking-wider text-white/40">Line {i + 1}</span>
              <div className="flex items-center gap-2">
                {offered.length > 1 && (
                  <Select value={l.kind} onChange={(e) => switchKind(i, e.target.value as SpendLineKind)}
                    className="rounded-md px-2 py-1 text-[11px] font-bold" aria-label={`Line ${i + 1} kind`}
                    style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}>
                    {offered.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                  </Select>
                )}
                {lines.length > 1 && (
                  <button type="button" onClick={() => onChange(lines.filter((_, j) => j !== i))} className="text-[11px] text-white/45 hover:text-white">Remove</button>
                )}
              </div>
            </div>

            {l.kind === 'stock' ? (
              <>
                <Select value={l.inventoryItemId ?? ''} className={fieldClassName} aria-label={`Line ${i + 1} stock item`}
                  onChange={(e) => {
                    const it = items.find((x) => x.id === e.target.value)
                    set(i, { inventoryItemId: e.target.value, unit: it?.unit ?? '', description: l.description || (it?.name ?? '') })
                  }}>
                  <option value="">— which stock item —</option>
                  {items.map((it) => <option key={it.id} value={it.id}>{it.name} ({it.unit})</option>)}
                </Select>
                <div className="grid grid-cols-3 gap-2">
                  <input value={l.quantity ?? ''} onChange={(e) => set(i, { quantity: e.target.value })} inputMode="decimal"
                    placeholder="Quantity" className={fieldClassName} aria-label={`Line ${i + 1} quantity`} />
                  <input value={l.unit ?? ''} onChange={(e) => set(i, { unit: e.target.value })} list={`spend-units-${i}`}
                    placeholder={item?.unit ?? 'Unit'} className={fieldClassName} aria-label={`Line ${i + 1} unit`} />
                  <datalist id={`spend-units-${i}`}>{[...new Set([item?.unit, ...UNITS].filter(Boolean))].map((u) => <option key={u} value={u!} />)}</datalist>
                  <MoneyInput value={l.amountCents} onChange={(v) => set(i, { amountCents: v })} className={fieldClassName} ariaLabel={`Line ${i + 1} amount in rupees`} />
                </div>
                {item && <p className="text-[10px] text-white/40">Comes into stock as {item.unit}; booked to its inventory account at what was paid.</p>}
              </>
            ) : l.kind === 'capex' ? (
              <>
                <input value={l.description} onChange={(e) => set(i, { description: e.target.value })} maxLength={200}
                  placeholder="What was bought (e.g. Blender)" className={fieldClassName} aria-label={`Line ${i + 1} description`} />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Select value={l.capexLineId ?? ''} onChange={(e) => set(i, { capexLineId: e.target.value })} className={fieldClassName} aria-label={`Line ${i + 1} CapEx line`}>
                    <option value="">— which CapEx item —</option>
                    {capexLines.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </Select>
                  <MoneyInput value={l.amountCents} onChange={(v) => set(i, { amountCents: v })} className={fieldClassName} ariaLabel={`Line ${i + 1} amount in rupees`} />
                </div>
              </>
            ) : (
              <>
                <input value={l.description} onChange={(e) => set(i, { description: e.target.value })} maxLength={200}
                  placeholder="What was bought (e.g. Printer paper)" className={fieldClassName} aria-label={`Line ${i + 1} description`} />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Select value={l.categoryKey || (l.accountCode ? `acct:${l.accountCode}` : '')}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v.startsWith('acct:')) set(i, { categoryKey: '', accountCode: v.slice(5) })
                      else set(i, { categoryKey: v, accountCode: '' })
                    }}
                    className={fieldClassName} aria-label={`Line ${i + 1} category`}>
                    <option value="">— what for —</option>
                    {categories.map((c) => <option key={c.key} value={c.key}>{c.label} ({c.code})</option>)}
                    {canPickAccount && expenseAccounts.length > 0 && (
                      <optgroup label="Another expense account">
                        {expenseAccounts.map((a) => <option key={a.code} value={`acct:${a.code}`}>{a.code} {a.name}</option>)}
                      </optgroup>
                    )}
                  </Select>
                  <MoneyInput value={l.amountCents} onChange={(v) => set(i, { amountCents: v })} className={fieldClassName} ariaLabel={`Line ${i + 1} amount in rupees`} />
                </div>
              </>
            )}

            {companyBrands.length > 1 && (
              <Select value={l.conceptId} onChange={(e) => set(i, { conceptId: e.target.value })} className={fieldClassName} aria-label={`Line ${i + 1} brand`}>
                <option value="">Brand: the box&apos;s / request&apos;s own</option>
                {companyBrands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            )}
            {l.kind === 'expense' && l.notEquipment !== undefined && (
              <div className="space-y-1">
                <label className="flex items-center gap-2 text-xs text-white/60">
                  <input type="checkbox" checked={!!l.notEquipment} onChange={(e) => set(i, { notEquipment: e.target.checked })} />
                  This is not equipment (finance or the CEO only)
                </label>
                {l.notEquipment && (
                  <input value={l.notEquipmentReason ?? ''} onChange={(e) => set(i, { notEquipmentReason: e.target.value })}
                    placeholder="Why it is an expense (at least 10 characters)" className={fieldClassName} />
                )}
              </div>
            )}
          </div>
        )
      })}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <button type="button" onClick={() => onChange([...lines, emptyLine(Math.max(0, totalCents - sum))])} disabled={lines.length >= 20}
          className="text-xs font-bold disabled:opacity-40" style={{ color: 'var(--erp-primary)' }}>+ Add a line</button>
        <span className="text-xs font-bold" style={{ color: balanced ? 'var(--erp-success)' : 'var(--erp-danger)' }}>
          {mode === 'equal'
            ? <>Lines {pkr(sum)} of {pkr(totalCents)}{sum !== totalCents ? ` — ${sum > totalCents ? 'over' : 'short'} by ${pkr(Math.abs(totalCents - sum))}` : ''}</>
            : <>Lines {pkr(sum)} — {pkr(totalCents)} still open{sum > totalCents ? ` (over by ${pkr(sum - totalCents)})` : ''}</>}
        </span>
      </div>
    </div>
  )
}
