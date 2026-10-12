'use client'
// OpEx Tracker — recurring operational expenses per category. Counterpart
// to /finance/capex but the model is fundamentally different: monthly
// commitments, no quote-shopping, watch trends + variances against budget.
//
// Payroll category links to /payroll-snapshot — pulls live from HR payroll runs
// data instead of manual entry. License renewals + subscriptions tracked
// the same way (just with cadence='annual' or 'quarterly').

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { MoneyInput } from '../../../components/ui/MoneyInput'

type Cadence = 'monthly' | 'quarterly' | 'annual' | 'per_use'

interface Payment {
  id: string
  periodStart: string
  periodEnd: string
  expectedCents: number
  actualCents: number | null
  paidAt: string | null
  paymentRef: string | null
  notes: string | null
  // The ledger is the actual (owner decision 23): a paid payment posts
  // Dr expense / Cr the line's bank account when it is recorded.
  ledger?: { status: 'posted' | 'unposted' | 'payroll' | 'not_paid'; entryId: string | null; accountCode: string | null }
}
interface Line {
  id: string
  categoryId: string
  name: string
  vendor: string | null
  vendorContact: string | null
  amountCents: number
  cadence: Cadence
  nextDueDate: string | null
  paymentMethod: string | null
  source: 'manual' | 'payroll' | 'license' | 'subscription'
  isActive: boolean
  notes: string | null
  payments: Payment[]
}
interface Category {
  id: string
  name: string
  emoji: string | null
  conceptId: string | null
  budgetMonthlyCents: number
  monthlyExpectedCents: number
  overBudgetPct: number
  lineCount: number
  notes: string | null
  lines: Line[]
}
interface PayrollRun {
  id: string
  periodStart: string
  periodEnd: string
  status: string
  totalGrossCents: number
  lineCount: number
}
interface PayrollBudget {
  monthlyCents: number          // tenant cost-share total (after contributions)
  grossMonthlyCents: number     // gross monthly salaries
  headcount: number
  openSeats: number
  incomingContributionMonthlyCents: number
  outgoingContributionMonthlyCents: number
  netMonthlyCents: number       // == monthlyCents after add/subtract
}
interface ContributionLine {
  id: string
  label: string
  category: 'head_office' | 'commissary' | 'shared_services' | 'other'
  monthlyCents: number
  sourceTenant:      { id: string; name: string }
  destinationTenant: { id: string; name: string }
  direction: 'incoming' | 'outgoing'
  internalSplit: Array<{ label: string; cents: number }> | null
}
interface PositionsSummary {
  netMonthlyCents: number
  incomingContributionMonthlyCents: number
  outgoingContributionMonthlyCents: number
  totalTenantShareMonthlyCents: number
  totalPositions: number
  contributions: ContributionLine[]
}
interface TenantJV {
  id: string
  name: string
  isActive?: boolean
  isJointVenture?: boolean
  jvPartners?: Array<{ label: string; pct: number }> | null
}
interface PayrollSnapshot {
  runs: PayrollRun[]
  budget?: PayrollBudget
}
interface CashflowItem { id: string; name: string; categoryName: string; categoryEmoji: string | null; dueDate: string | null; amountCents: number; vendor: string | null }

const CADENCE_LABELS: Record<Cadence, string> = {
  monthly: '/mo', quarterly: '/qtr', annual: '/yr', per_use: '/use',
}
const CADENCE_DAYS: Record<Cadence, number> = {
  monthly: 30, quarterly: 90, annual: 365, per_use: 0,
}

const PRESET_CATEGORIES: { name: string; emoji: string }[] = [
  { name: 'Rent / lease',        emoji: '🏢' },
  { name: 'Payroll',             emoji: '👥' },
  { name: 'Utilities',           emoji: '⚡' },
  { name: 'Software',            emoji: '💻' },
  { name: 'Marketing',           emoji: '📣' },
  { name: 'Insurance',           emoji: '🛡' },
  { name: 'Cleaning',            emoji: '🧽' },
  { name: 'Maintenance',         emoji: '🔧' },
  { name: 'Bank fees',           emoji: '🏦' },
  { name: 'Professional services', emoji: '⚖️' },
  { name: 'Licenses',            emoji: '📑' },
  { name: 'Loan / debt',         emoji: '💸' },
]

const PKR = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`

export default function OpexTrackerPage() {
  const qc = useQueryClient()
  const { data: categories = [] } = useQuery<Category[]>({ queryKey: ['opex-categories'], queryFn: () => api.get('/opex/categories') })
  const { data: payrollSnap } = useQuery<PayrollSnapshot>({ queryKey: ['opex-payroll'], queryFn: () => api.get('/opex/payroll-snapshot') })
  // Positions summary gives the per-contribution rows the snapshot only
  // aggregates. We need both: snapshot for budget headline, summary for
  // the JV breakdown rows.
  const { data: positionsSummary } = useQuery<PositionsSummary>({
    queryKey: ['positions', 'summary'],
    queryFn:  () => api.get('/positions/summary'),
  })

  // Active tenant's JV config — if isJointVenture, every cost line shows
  // partner-split chips ("Viva 60% / GS 40%"). Pulled from /tenants/mine
  // since that's the source of truth for tenant flags.
  const { data: tenants = [] } = useQuery<TenantJV[]>({
    queryKey: ['my-tenants'],
    queryFn:  () => api.get('/tenants/mine'),
    staleTime: 5 * 60_000,
  })
  const activeTenant = tenants.find((t) => t.isActive) ?? tenants[0]
  const jvPartners = activeTenant?.isJointVenture ? (activeTenant.jvPartners ?? []) : []
  const { data: cashflow = [] } = useQuery<CashflowItem[]>({ queryKey: ['opex-cashflow'], queryFn: () => api.get('/opex/cashflow') })

  const [creatingCategory, setCreatingCategory] = useState(false)
  const [editingCategory, setEditingCategory] = useState<Category | null>(null)
  const [addingLineFor, setAddingLineFor] = useState<Category | null>(null)
  const [editingLine, setEditingLine] = useState<{ line: Line; category: Category } | null>(null)

  // Roll-ups across all categories
  const totalMonthly = categories.reduce((s, c) => s + c.monthlyExpectedCents, 0)
  const totalBudget  = categories.reduce((s, c) => s + c.budgetMonthlyCents, 0)
  const overBudgetCount = categories.filter((c) => c.overBudgetPct > 0).length

  // Cashflow buckets — next 30 / 60 / 90
  const now = Date.now()
  const next30 = cashflow.filter((c) => c.dueDate && new Date(c.dueDate).getTime() <= now + 30 * 86400_000)
  const next60 = cashflow.filter((c) => c.dueDate && new Date(c.dueDate).getTime() > now + 30 * 86400_000 && new Date(c.dueDate).getTime() <= now + 60 * 86400_000)
  const next90 = cashflow.filter((c) => c.dueDate && new Date(c.dueDate).getTime() > now + 60 * 86400_000)
  const sum = (rows: CashflowItem[]) => rows.reduce((s, r) => s + r.amountCents, 0)

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-5 border-b border-white/[0.05]">
        <Link href="/finance" className="text-xs text-white/40 hover:text-white/70">← Finance</Link>
        <div className="flex items-start justify-between gap-4 mt-1 flex-wrap">
          <div>
            <h1 className="text-2xl font-black text-white/90 flex items-center gap-2">💸 OpEx Tracker</h1>
            <p className="text-sm text-white/40 mt-1 max-w-3xl">
              Every recurring expense — rent, payroll, utilities, software, marketing. System tracks expected vs actual and flags vendor invoices that jump unexpectedly.
            </p>
          </div>
          <button onClick={() => setCreatingCategory(true)} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">+ New category</button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-[1100px] mx-auto space-y-6">
        {/* JV partner banner — only shown when active tenant is flagged as
            a joint venture. Documents the partner split that's then applied
            to every total + headline number on the page. Click to edit. */}
        {activeTenant?.isJointVenture && jvPartners.length > 0 && (
          <Link href="/settings"
            className="block rounded-2xl px-5 py-3 hover:bg-white/[0.03] transition-colors"
            style={{ background: 'rgb(var(--erp-primary-rgb) / 0.06)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.25)' }}>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-black uppercase tracking-wider rounded px-1.5 py-0.5"
                  style={{ background: 'rgb(var(--erp-primary-rgb) / 0.20)', color: 'var(--erp-primary-ink)' }}>
                  Joint venture
                </span>
                <span className="text-sm text-white/85 font-bold">{activeTenant.name}</span>
                <span className="text-xs text-white/40">- every cost line below splits as:</span>
                {jvPartners.map((p, i) => (
                  <span key={i} className="text-[11px] font-bold rounded px-2 py-0.5"
                    style={{ background: 'rgb(var(--erp-primary-rgb) / 0.10)', color: 'var(--erp-primary-ink)' }}>
                    {p.label} {p.pct}%
                  </span>
                ))}
              </div>
              <span className="text-[11px] text-white/45 hover:underline">Edit JV config →</span>
            </div>
          </Link>
        )}

        {/* Top stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Monthly run-rate" value={PKR(totalMonthly)} accent="var(--erp-primary-ink)"
            jvPartners={jvPartners} />
          <Stat label="Monthly budget"   value={PKR(totalBudget)}  accent="var(--erp-primary-ink)"
            jvPartners={jvPartners} />
          <Stat label="Categories over budget" value={`${overBudgetCount} / ${categories.length}`} accent={overBudgetCount > 0 ? 'var(--erp-danger)' : 'var(--erp-success)'} />
          <Stat label="Annual run-rate"   value={PKR(totalMonthly * 12)} accent="var(--erp-warning)"
            jvPartners={jvPartners} />
        </div>

        {/* Cashflow horizon */}
        {cashflow.length > 0 && (
          <section className="rounded-2xl p-5"
            style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
            <h2 className="text-xs font-black uppercase tracking-[0.24em] text-white/55 mb-3">90-day cashflow forecast</h2>
            <div className="grid grid-cols-3 gap-3">
              <CashBucket label="Next 30 days" rows={next30} total={sum(next30)} />
              <CashBucket label="31–60 days"  rows={next60} total={sum(next60)} />
              <CashBucket label="61–90 days"  rows={next90} total={sum(next90)} />
            </div>
          </section>
        )}

        {/* Quick-add suggested categories */}
        {categories.length === 0 && (
          <section className="rounded-2xl p-5"
            style={{ background: 'rgb(var(--erp-primary-rgb) / 0.05)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.18)' }}>
            <h2 className="text-sm font-black text-white/85">Pick the categories you actually pay for</h2>
            <p className="text-xs text-white/55 mt-1 mb-3">Tap one to add it. You can rename, set a monthly budget, and add lines underneath.</p>
            <div className="flex flex-wrap gap-1.5">
              {PRESET_CATEGORIES.map((p) => (
                <PresetButton key={p.name} preset={p} onAdd={() => qc.invalidateQueries({ queryKey: ['opex-categories'] })} />
              ))}
            </div>
          </section>
        )}

        {/* Categories */}
        <div className="space-y-3">
          {categories.map((c) => (
            <CategoryCard
              key={c.id}
              category={c}
              payrollSnap={c.name.toLowerCase() === 'payroll' ? payrollSnap : undefined}
              positionsSummary={c.name.toLowerCase() === 'payroll' ? positionsSummary : undefined}
              jvPartners={jvPartners}
              onEditCategory={() => setEditingCategory(c)}
              onAddLine={() => setAddingLineFor(c)}
              onEditLine={(line) => setEditingLine({ line, category: c })}
            />
          ))}
        </div>
      </div>

      {creatingCategory && <CategoryModal onClose={() => setCreatingCategory(false)} onSaved={() => { qc.invalidateQueries({ queryKey: ['opex-categories'] }); setCreatingCategory(false) }} />}
      {editingCategory && <CategoryModal category={editingCategory} onClose={() => setEditingCategory(null)} onSaved={() => { qc.invalidateQueries({ queryKey: ['opex-categories'] }); setEditingCategory(null) }} />}
      {addingLineFor && <LineModal category={addingLineFor} onClose={() => setAddingLineFor(null)} onSaved={() => { qc.invalidateQueries({ queryKey: ['opex-categories'] }); setAddingLineFor(null) }} />}
      {editingLine && <LineModal category={editingLine.category} line={editingLine.line} onClose={() => setEditingLine(null)} onSaved={() => { qc.invalidateQueries({ queryKey: ['opex-categories'] }); setEditingLine(null) }} />}
    </div>
  )
}

function PresetButton({ preset, onAdd }: { preset: { name: string; emoji: string }; onAdd: () => void }) {
  const add = useMutation({
    mutationFn: () => api.post('/opex/categories', { name: preset.name, emoji: preset.emoji }),
    onSuccess: onAdd,
  })
  return (
    <button onClick={() => add.mutate()} disabled={add.isPending}
      className="text-xs font-bold px-3 py-2 rounded-full"
      style={{ background: 'rgb(var(--fg-rgb) / 0.04)', color: 'rgb(var(--fg-rgb) / 0.75)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
      {preset.emoji} {preset.name}
    </button>
  )
}

function CashBucket({ label, rows, total }: { label: string; rows: CashflowItem[]; total: number }) {
  return (
    <div className="rounded-xl p-3" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <p className="text-[10px] font-black uppercase tracking-wider text-white/45">{label}</p>
      <p className="text-lg font-black text-white/90 mt-1">{PKR(total)}</p>
      <p className="text-[11px] text-white/45">{rows.length} payments</p>
    </div>
  )
}

function Stat({ label, value, accent, jvPartners }: {
  label: string; value: string; accent: string
  jvPartners?: Array<{ label: string; pct: number }>
}) {
  // Parse "PKR 1,235,000" back to cents so we can render the per-partner split.
  const rawCents = (() => {
    if (!jvPartners || jvPartners.length === 0) return 0
    const digits = value.replace(/[^0-9]/g, '')
    return digits ? parseInt(digits) * 100 : 0
  })()
  return (
    <div className="rounded-xl p-3" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-white/35">{label}</p>
      <p className="text-base font-black mt-1" style={{ color: accent }}>{value}</p>
      {jvPartners && jvPartners.length > 0 && rawCents > 0 && (
        <div className="mt-1.5 flex gap-1.5 flex-wrap">
          {jvPartners.map((p, i) => (
            <span key={i} className="text-[10px] font-mono rounded px-1.5 py-0.5"
              style={{ background: 'rgb(var(--erp-primary-rgb) / 0.10)', color: 'var(--erp-primary-ink)' }}>
              {p.label}: {PKR(Math.round(rawCents * p.pct / 100))}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function CategoryCard({ category, payrollSnap, positionsSummary, jvPartners, onEditCategory, onAddLine, onEditLine }: {
  category: Category
  payrollSnap: PayrollSnapshot | undefined
  positionsSummary: PositionsSummary | undefined
  jvPartners?: Array<{ label: string; pct: number }>
  onEditCategory: () => void; onAddLine: () => void; onEditLine: (l: Line) => void
}) {
  const overBudget = category.overBudgetPct > 0
  const variancePct = category.budgetMonthlyCents > 0
    ? ((category.monthlyExpectedCents - category.budgetMonthlyCents) / category.budgetMonthlyCents) * 100
    : 0
  const isPayroll = category.name.toLowerCase() === 'payroll'

  return (
    <section className="rounded-2xl overflow-hidden"
      style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <header className="px-5 py-3 flex items-center justify-between gap-3 flex-wrap"
        style={{ background: 'rgb(var(--fg-rgb) / 0.02)', borderBottom: '1px solid rgb(var(--fg-rgb) / 0.04)' }}>
        <div className="flex items-center gap-2">
          {category.emoji && <span className="text-2xl">{category.emoji}</span>}
          <div>
            <p className="font-black text-white/90 text-sm">{category.name}</p>
            <p className="text-[11px] text-white/45">
              {category.lineCount} line{category.lineCount === 1 ? '' : 's'} · {PKR(category.monthlyExpectedCents)}/mo
              {category.budgetMonthlyCents > 0 && (
                <span style={{ color: overBudget ? 'var(--erp-danger)' : 'rgb(var(--fg-rgb) / 0.45)' }}>
                  {' '}· {variancePct >= 0 ? '+' : ''}{variancePct.toFixed(0)}% vs budget
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onEditCategory} className="text-xs text-white/55 hover:text-white">Edit category</button>
          <button onClick={onAddLine} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-on hover:opacity-90">+ Line</button>
        </div>
      </header>

      {/* Budgeted payroll from workforce/positions — only Payroll category. */}
      {isPayroll && payrollSnap?.budget && (
        <div className="px-5 py-4 border-b border-white/[0.04]"
          style={{ background: 'rgb(var(--erp-primary-rgb) / 0.04)' }}>
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-wider text-primary-ink">Budgeted payroll · from workforce</p>
              <p className="text-[10px] text-white/40 mt-0.5">
                {payrollSnap.budget.headcount} ppl
                {payrollSnap.budget.openSeats > 0 && ` · ${payrollSnap.budget.openSeats} open`}
              </p>
            </div>
            <Link href="/workforce/positions" className="text-[11px] text-primary-ink hover:underline">Manage positions →</Link>
          </div>

          {/* Gross / contributions / net stack. Mirrors the JV card on
              /workforce/positions so the operator sees the same number
              in two places. */}
          <div className="grid gap-1.5 text-xs font-mono">
            <div className="flex justify-between">
              <span className="text-white/55">Position gross</span>
              <span className="font-bold text-white/85">{PKR(payrollSnap.budget.grossMonthlyCents)}</span>
            </div>
            {positionsSummary && positionsSummary.contributions.map((c) => (
              <div key={c.id} className="flex justify-between items-baseline">
                <span className="text-white/55 flex items-center gap-1.5">
                  <span style={{ color: c.direction === 'incoming' ? 'var(--erp-success)' : 'var(--erp-warning)' }}>
                    {c.direction === 'incoming' ? '<--' : '-->'}
                  </span>
                  {c.label}
                  <span className="text-[10px] text-white/35">
                    ({c.direction === 'incoming' ? 'from' : 'to'}{' '}
                    {c.direction === 'incoming' ? c.sourceTenant.name : c.destinationTenant.name})
                  </span>
                </span>
                <span className="font-bold"
                  style={{ color: c.direction === 'incoming' ? 'var(--erp-success)' : 'var(--erp-warning)' }}>
                  {c.direction === 'incoming' ? '-' : '+'} {PKR(c.monthlyCents)}
                </span>
              </div>
            ))}
            <div className="border-t border-white/10 mt-1 pt-2 flex justify-between items-baseline text-sm">
              <span className="font-bold text-white/85">Net to this tenant&apos;s P&L</span>
              <div className="text-right">
                <span className="font-black block" style={{ color: 'var(--erp-primary-ink)' }}>
                  {PKR(payrollSnap.budget.netMonthlyCents)}
                </span>
                {jvPartners && jvPartners.length > 0 && (
                  <div className="mt-1 flex gap-1.5 flex-wrap justify-end">
                    {jvPartners.map((p, i) => (
                      <span key={i} className="text-[10px] font-mono rounded px-1.5 py-0.5"
                        style={{ background: 'rgb(var(--erp-primary-rgb) / 0.10)', color: 'var(--erp-primary-ink)' }}>
                        {p.label} {p.pct}%: {PKR(Math.round(payrollSnap.budget!.netMonthlyCents * p.pct / 100))}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Live payroll panel — only renders for the Payroll category */}
      {isPayroll && payrollSnap && payrollSnap.runs.length > 0 && (
        <div className="px-5 py-3 border-b border-white/[0.04]"
          style={{ background: 'rgb(var(--ink-rgb) / 0.04)' }}>
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] font-black uppercase tracking-wider text-primary-ink">Posted runs · last 6 months</p>
            <Link href="/hr/payroll" className="text-[11px] text-primary-ink hover:underline">Open payroll →</Link>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {payrollSnap.runs.slice(0, 6).map((r) => (
              <div key={r.id} className="rounded-lg p-2" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                <p className="text-[10px] text-white/45">{new Date(r.periodStart).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}</p>
                <p className="text-xs font-bold text-white/85 mt-0.5">{PKR(r.totalGrossCents)}</p>
                <p className="text-[10px] text-white/35">{r.lineCount} staff · {r.status}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {isPayroll && (!payrollSnap || payrollSnap.runs.length === 0) && (
        <div className="px-5 py-3 border-b border-white/[0.04]" style={{ background: 'rgb(var(--ink-rgb) / 0.04)' }}>
          <p className="text-xs text-white/55">
            No payroll runs yet. <Link href="/hr/payroll" className="text-primary-ink hover:underline">Run payroll</Link> to see actuals here, or
            <Link href="/settings" className="text-primary-ink hover:underline ml-1">add staff</Link> to start tracking hours.
          </p>
        </div>
      )}

      {/* Lines */}
      {category.lines.length === 0 ? (
        <p className="px-5 py-5 text-xs text-white/30 italic">No lines yet. Add one to start tracking spend.</p>
      ) : (
        <div className="divide-y divide-white/[0.04]">
          {category.lines.map((l) => <LineRow key={l.id} line={l} onClick={() => onEditLine(l)} />)}
        </div>
      )}
    </section>
  )
}

function LineRow({ line, onClick }: { line: Line; onClick: () => void }) {
  const lastPaid = line.payments.find((p) => p.paidAt)
  const dueSoon = line.nextDueDate && new Date(line.nextDueDate).getTime() < Date.now() + 7 * 86400_000

  return (
    <button onClick={onClick} className="w-full text-left px-5 py-3 hover:bg-white/[0.015] transition-colors">
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-bold text-white/90 truncate">{line.name}</p>
            {line.source !== 'manual' && (
              <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: 'rgb(var(--ink-rgb) / 0.12)', color: 'var(--erp-primary-ink)' }}>
                {line.source}
              </span>
            )}
          </div>
          <p className="text-[11px] text-white/45 mt-0.5">
            {line.vendor ?? <em>no vendor</em>}
            {lastPaid && <span> · last paid {new Date(lastPaid.paidAt!).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>}
          </p>
        </div>

        <div className="text-right whitespace-nowrap">
          <p className="text-sm font-mono text-white/85">{PKR(line.amountCents)}<span className="text-[10px] text-white/45">{CADENCE_LABELS[line.cadence]}</span></p>
        </div>

        <div className="text-right whitespace-nowrap">
          <p className="text-[11px]" style={{ color: dueSoon ? 'var(--erp-warning)' : 'rgb(var(--fg-rgb) / 0.45)' }}>
            {line.nextDueDate ? `due ${new Date(line.nextDueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : 'no due date'}
          </p>
        </div>

        <span className="text-white/30 text-xs">›</span>
      </div>
    </button>
  )
}

// ─── Modals ───────────────────────────────────────────────────────────────

function CategoryModal({ category, onClose, onSaved }: { category?: Category; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(category?.name ?? '')
  const [emoji, setEmoji] = useState(category?.emoji ?? '')
  const [budgetMonthlyCents, setBudget] = useState(category?.budgetMonthlyCents ?? 0)
  const [notes, setNotes] = useState(category?.notes ?? '')

  const save = useMutation({
    mutationFn: () => {
      const payload = { name, emoji: emoji || null, budgetMonthlyCents, notes: notes || null }
      return category ? api.patch(`/opex/categories/${category.id}`, payload) : api.post('/opex/categories', payload)
    },
    onSuccess: () => onSaved(),
  })
  const del = useMutation({
    mutationFn: () => api.delete(`/opex/categories/${category!.id}`),
    onSuccess: () => onSaved(),
  })

  return <ModalShell title={category ? 'Edit category' : 'New OpEx category'} onClose={onClose}>
    <div className="grid grid-cols-[80px_1fr] gap-3">
      <Field label="Emoji"><input value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="🏢" className={fieldCls + ' text-center text-2xl'} /></Field>
      <Field label="Name *"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Rent / lease" className={fieldCls} autoFocus /></Field>
    </div>
    <Field label="Monthly budget (PKR)">
      <MoneyInput value={budgetMonthlyCents} onChange={setBudget} className={fieldCls} />
      <Hint>{PKR(budgetMonthlyCents)}/mo · variance flags fire when actuals exceed this</Hint>
    </Field>
    <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={fieldCls} /></Field>
    {save.error && <ErrorBanner error={save.error} />}
    <ModalFooter onCancel={onClose}>
      {category && (
        <button onClick={() => { if (confirm('Archive this category?')) del.mutate() }}
          className="rounded-xl border border-red-500/20 text-s-red/70 px-4 py-2.5 text-xs hover:text-s-red mr-auto">Archive</button>
      )}
      <button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()} className={primaryBtn}>
        {save.isPending ? 'Saving…' : category ? 'Save' : 'Create category'}
      </button>
    </ModalFooter>
  </ModalShell>
}

function LineModal({ category, line, onClose, onSaved }: { category: Category; line?: Line; onClose: () => void; onSaved: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState(line?.name ?? '')
  const [vendor, setVendor] = useState(line?.vendor ?? '')
  const [vendorContact, setVendorContact] = useState(line?.vendorContact ?? '')
  const [amountCents, setAmount] = useState(line?.amountCents ?? 0)
  const [cadence, setCadence] = useState<Cadence>(line?.cadence ?? 'monthly')
  const [nextDueDate, setNextDueDate] = useState(line?.nextDueDate?.slice(0, 10) ?? '')
  const [paymentMethod, setPaymentMethod] = useState(line?.paymentMethod ?? '')
  const [notes, setNotes] = useState(line?.notes ?? '')

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        categoryId: category.id, name,
        vendor: vendor || null, vendorContact: vendorContact || null,
        amountCents, cadence,
        nextDueDate: nextDueDate ? `${nextDueDate}T00:00:00Z` : null,
        paymentMethod: paymentMethod || null,
        notes: notes || null,
      }
      return line ? api.patch(`/opex/lines/${line.id}`, payload) : api.post('/opex/lines', payload)
    },
    onSuccess: () => onSaved(),
  })
  const del = useMutation({
    mutationFn: () => api.delete(`/opex/lines/${line!.id}`),
    onSuccess: () => onSaved(),
  })

  return <ModalShell title={`${line ? 'Edit' : 'Add'} line · ${category.name}`} onClose={onClose} wide>
    <Field label="Name *">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Office rent — DHA Phase 5" className={fieldCls} autoFocus />
    </Field>
    <div className="grid grid-cols-2 gap-3">
      <Field label="Vendor"><input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Landlord name" className={fieldCls} /></Field>
      <Field label="Contact"><input value={vendorContact} onChange={(e) => setVendorContact(e.target.value)} placeholder="+92 300 1234567" className={fieldCls} /></Field>
    </div>
    <div className="grid grid-cols-2 gap-3">
      <Field label="Amount (PKR) *">
        <MoneyInput value={amountCents} onChange={setAmount} className={fieldCls} />
        <Hint>{PKR(amountCents)}{CADENCE_LABELS[cadence]}</Hint>
      </Field>
      <Field label="Cadence">
        <select value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)} className={fieldCls}>
          <option value="monthly">Monthly</option>
          <option value="quarterly">Quarterly</option>
          <option value="annual">Annual</option>
          <option value="per_use">Per use</option>
        </select>
      </Field>
    </div>
    <div className="grid grid-cols-2 gap-3">
      <Field label="Next due"><input type="date" value={nextDueDate} onChange={(e) => setNextDueDate(e.target.value)} className={fieldCls} /></Field>
      <Field label="Payment method">
        <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} className={fieldCls}>
          <option value="">—</option>
          <option value="bank_transfer">Bank transfer</option>
          <option value="card">Card</option>
          <option value="cash">Cash</option>
          <option value="auto_debit">Auto-debit</option>
          <option value="cheque">Cheque</option>
        </select>
      </Field>
    </div>
    <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={fieldCls} /></Field>

    {/* Payment history — only when editing */}
    {line && <PaymentHistory line={line} onChange={() => qc.invalidateQueries({ queryKey: ['opex-categories'] })} />}

    {save.error && <ErrorBanner error={save.error} />}

    <ModalFooter onCancel={onClose}>
      {line && (
        <button onClick={() => { if (confirm('Archive this line?')) del.mutate() }}
          className="rounded-xl border border-red-500/20 text-s-red/70 px-4 py-2.5 text-xs hover:text-s-red mr-auto">Archive</button>
      )}
      <button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()} className={primaryBtn}>
        {save.isPending ? 'Saving…' : line ? 'Save changes' : 'Add line'}
      </button>
    </ModalFooter>
  </ModalShell>
}

function PaymentHistory({ line, onChange }: { line: Line; onChange: () => void }) {
  const [adding, setAdding] = useState(false)
  const today = new Date().toISOString().slice(0, 10)
  const monthEnd = new Date(); monthEnd.setMonth(monthEnd.getMonth() + 1); monthEnd.setDate(0)
  const [periodStart, setPeriodStart] = useState(today)
  const [periodEnd, setPeriodEnd] = useState(monthEnd.toISOString().slice(0, 10))
  const [actualCents, setActual] = useState(line.amountCents)
  const [expenseAccountCode, setExpenseAccountCode] = useState('')

  // Recording a payment as paid posts it to the books in the same step; if
  // the ledger refuses (closed month, category with no expense account, bank
  // account with no chart code) nothing is saved and the reason shows here.
  const add = useMutation({
    mutationFn: () => api.post('/opex/payments', {
      lineId: line.id,
      periodStart: `${periodStart}T00:00:00Z`,
      periodEnd:   `${periodEnd}T23:59:59Z`,
      expectedCents: line.amountCents,
      actualCents,
      paidAt: new Date().toISOString(),
      ...(expenseAccountCode.trim() && { expenseAccountCode: expenseAccountCode.trim() }),
    }),
    onSuccess: () => { setAdding(false); setExpenseAccountCode(''); onChange() },
  })
  const addError = add.error as { code?: string; message?: string } | null

  return <Section heading={`Payment history · ${line.payments.length}`}>
    <div className="space-y-1.5">
      {line.payments.slice(0, 6).map((p) => {
        const variance = p.actualCents != null ? p.actualCents - p.expectedCents : 0
        const variancePct = p.expectedCents > 0 ? (variance / p.expectedCents) * 100 : 0
        return (
          <div key={p.id} className="rounded-lg p-3 grid grid-cols-[auto_1fr_auto_auto] gap-2 items-center"
            style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
            <span className="text-xs text-white/55">{new Date(p.periodStart).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}</span>
            <div>
              <p className="text-sm font-mono text-white/85">{p.actualCents != null ? PKR(p.actualCents) : <em className="text-white/45">unpaid</em>}</p>
              {p.actualCents != null && Math.abs(variancePct) >= 5 && (
                <p className="text-[11px]" style={{ color: variance > 0 ? 'var(--erp-danger)' : 'var(--erp-success)' }}>
                  {variance > 0 ? '+' : ''}{variancePct.toFixed(0)}% vs expected
                </p>
              )}
            </div>
            {p.paidAt && (
              p.ledger?.status === 'posted'
                ? <span className="text-[10px] font-black text-success" title={p.ledger.accountCode ? `Booked to ${p.ledger.accountCode}` : undefined}>PAID · ON THE BOOKS</span>
                : p.ledger?.status === 'payroll'
                  ? <span className="text-[10px] font-black text-white/55" title="HR payroll books wages">PAID · VIA PAYROLL</span>
                  : <span className="text-[10px] font-black text-s-amber" title="Paid before payments posted to the books — an admin can post it">PAID · NOT POSTED</span>
            )}
            {p.paymentRef && <span className="text-[10px] font-mono text-white/45">{p.paymentRef}</span>}
          </div>
        )
      })}
    </div>
    {adding ? (
      <div className="rounded-xl p-3 mt-2" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
        <div className="grid grid-cols-3 gap-2">
          <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className={fieldCls} />
          <input type="date" value={periodEnd}   onChange={(e) => setPeriodEnd(e.target.value)}   className={fieldCls} />
          <MoneyInput value={actualCents} onChange={setActual} className={fieldCls} placeholder="Actual paid (PKR)" />
        </div>
        {addError?.code === 'CATEGORY_NOT_MAPPED' && (
          <div className="mt-2">
            <label htmlFor={`exp-${line.id}`} className="text-[11px] text-white/55">Expense account (6xxx) this is booked to</label>
            <input id={`exp-${line.id}`} value={expenseAccountCode} onChange={(e) => setExpenseAccountCode(e.target.value)}
              placeholder="e.g. 6040" className={fieldCls} inputMode="numeric" />
          </div>
        )}
        {addError && <p role="alert" className="text-[11px] text-s-red mt-2">{addError.message}</p>}
        <div className="flex justify-end gap-2 mt-2">
          <button onClick={() => setAdding(false)} className="text-xs text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => add.mutate()} disabled={add.isPending}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-on disabled:opacity-50">+ Record</button>
        </div>
      </div>
    ) : (
      <button onClick={() => setAdding(true)}
        className="w-full rounded-lg border-2 border-dashed border-white/10 px-3 py-2 text-xs text-white/55 hover:text-white hover:border-white/30 mt-2">
        + Record this period's payment
      </button>
    )}
  </Section>
}

// ─── Shared ───────────────────────────────────────────────────────────────

function ModalShell({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4" onClick={onClose}>
    <div className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-2xl overflow-hidden`}
      style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
        <h2 className="font-black text-white/90">{title}</h2>
        <button onClick={onClose} className="text-white/40 text-xl">✕</button>
      </div>
      <div className="p-5 space-y-4 max-h-[80vh] overflow-y-auto">{children}</div>
    </div>
  </div>
}
function ModalFooter({ children, onCancel }: { children: React.ReactNode; onCancel: () => void }) {
  return <div className="flex items-center justify-between gap-3 pt-4 mt-4 border-t border-white/[0.05]">
    <button onClick={onCancel} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
    {children}
  </div>
}
function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return <div className="rounded-xl p-3 space-y-2 mt-2"
    style={{ background: 'rgb(var(--fg-rgb) / 0.015)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
    <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/45">{heading}</p>
    {children}
  </div>
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div>
}
function Hint({ children }: { children: React.ReactNode }) { return <p className="text-[11px] text-white/35 mt-1">{children}</p> }
function ErrorBanner({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : 'Failed'
  return <div className="rounded-xl px-4 py-3 text-sm text-s-red" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>{msg}</div>
}
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
const primaryBtn = "rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50"
