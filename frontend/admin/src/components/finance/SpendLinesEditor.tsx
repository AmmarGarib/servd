'use client'
// What a cash spend was for: one or more EXPENSE lines, each a category from
// the server's one list (GET /trustops/petty-cash/categories — key, label and
// chart code), or for a cash keeper an explicit operating-expense (6xxx)
// account of the company's chart; an optional brand per line; a running total
// against the spend's amount.
//
// The server decides (accounting/pettyCashPosting.ts resolveSpendLinesTx):
// kitchen food / drinks / packaging are never expense lines (they come in as
// stock), equipment goes through CapEx (422 USE_CAPEX — finance / the CEO can
// say "not equipment" with a reason), and a brand of another company is 422.
//
// Extension points (W3, w3-cash-requests): `SpendLine.kind` is 'expense' here;
// stock lines (item, quantity) and CapEx lines plug in as further kinds with
// their own row component — LINE_KINDS lists what this editor offers.

import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { MoneyInput } from '../ui/MoneyInput'

export type SpendLineKind = 'expense'
/** The line kinds this editor offers (W3 adds 'stock' and 'capex'). */
export const LINE_KINDS: ReadonlyArray<{ kind: SpendLineKind; label: string }> = [{ kind: 'expense', label: 'Expense' }]

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
}

export interface SpendCategory { key: string; label: string; code: string; kind: string }

export const emptyLine = (amountCents = 0, description = ''): SpendLine =>
  ({ kind: 'expense', categoryKey: '', accountCode: '', amountCents, description, conceptId: '' })

/** The body the API takes for a line (empty strings dropped). */
export function lineBody(l: SpendLine) {
  return {
    kind: l.kind,
    ...(l.categoryKey ? { categoryKey: l.categoryKey } : l.accountCode ? { accountCode: l.accountCode } : {}),
    amountCents: l.amountCents,
    description: l.description.trim(),
    ...(l.conceptId && { conceptId: l.conceptId }),
    ...(l.notEquipment && { notEquipment: true, notEquipmentReason: l.notEquipmentReason ?? '' }),
  }
}

/** True when every line says what it is for and the lines add up to `totalCents`. */
export function linesReady(lines: SpendLine[], totalCents: number): boolean {
  return lines.length > 0
    && lines.every((l) => (l.categoryKey || /^6\d{3}$/.test(l.accountCode)) && l.amountCents > 0 && l.description.trim())
    && lines.reduce((s, l) => s + l.amountCents, 0) === totalCents
}

const pkr = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`

export function SpendLinesEditor({
  lines,
  onChange,
  totalCents,
  canPickAccount,
  tenantId,
  fieldClassName,
}: {
  lines: SpendLine[]
  onChange: (next: SpendLine[]) => void
  /** The spend's amount; the lines must add up to it. */
  totalCents: number
  /** A cash keeper may book a line to an explicit 6xxx account. */
  canPickAccount: boolean
  /** The company of the box / request: brands and accounts are its own. */
  tenantId: string | null
  fieldClassName: string
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

  const sum = lines.reduce((s, l) => s + l.amountCents, 0)
  const set = (i: number, patch: Partial<SpendLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))

  return (
    <div className="space-y-2">
      {lines.map((l, i) => (
        <div key={i} className="rounded-lg p-3 space-y-2" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.07)' }}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-white/40">Line {i + 1}</span>
            {lines.length > 1 && (
              <button type="button" onClick={() => onChange(lines.filter((_, j) => j !== i))} className="text-[11px] text-white/45 hover:text-white">Remove</button>
            )}
          </div>
          <input value={l.description} onChange={(e) => set(i, { description: e.target.value })} maxLength={200}
            placeholder="What was bought (e.g. Printer paper)" className={fieldClassName} aria-label={`Line ${i + 1} description`} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <select value={l.categoryKey || (l.accountCode ? `acct:${l.accountCode}` : '')}
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
            </select>
            <MoneyInput value={l.amountCents} onChange={(v) => set(i, { amountCents: v })} className={fieldClassName} ariaLabel={`Line ${i + 1} amount in rupees`} />
          </div>
          {companyBrands.length > 1 && (
            <select value={l.conceptId} onChange={(e) => set(i, { conceptId: e.target.value })} className={fieldClassName} aria-label={`Line ${i + 1} brand`}>
              <option value="">Brand: the box&apos;s own</option>
              {companyBrands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          )}
          {l.notEquipment !== undefined && (
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
      ))}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <button type="button" onClick={() => onChange([...lines, emptyLine(Math.max(0, totalCents - sum))])} disabled={lines.length >= 20}
          className="text-xs font-bold disabled:opacity-40" style={{ color: 'var(--erp-primary)' }}>+ Add a line</button>
        <span className="text-xs font-bold" style={{ color: sum === totalCents ? 'var(--erp-success)' : 'var(--erp-danger)' }}>
          Lines {pkr(sum)} of {pkr(totalCents)}{sum !== totalCents ? ` — ${sum > totalCents ? 'over' : 'short'} by ${pkr(Math.abs(totalCents - sum))}` : ''}
        </span>
      </div>
    </div>
  )
}
