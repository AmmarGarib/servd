'use client'
// OpEx Tracker — recurring operational expenses per category. Counterpart
// to /finance/capex but the model is fundamentally different: monthly
// commitments, no quote-shopping, watch trends + variances against budget.
//
// Payroll category links to /payroll-snapshot — pulls live from HR payroll runs
// data instead of manual entry. License renewals + subscriptions tracked
// the same way (just with cadence='annual' or 'quarterly').

import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { BankAccountSelect, useBankAccounts } from '../../../components/finance/BankAccountSelect'
import { useAuthStore } from '../../../store/auth'

type Cadence = 'monthly' | 'quarterly' | 'annual' | 'per_use'

interface Payment {
  id: string
  periodStart: string
  periodEnd: string
  expectedCents: number
  actualCents: number | null
  paidAt: string | null
  paymentRef: string | null
  receiptUrl: string | null
  notes: string | null
  // The ledger is the actual (owner decision 23): a paid payment posts
  // Dr the category's expense account / Cr where the money came from.
  ledger?: { status: 'posted' | 'unposted' | 'payroll' | 'not_paid'; entryId: string | null; accountCode: string | null; creditCode?: string | null }
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
  bankAccountId: string | null
  source: 'manual' | 'payroll' | 'license' | 'subscription'
  isActive: boolean
  notes: string | null
  payments: Payment[]
}
interface Category {
  id: string
  tenantId: string | null
  name: string
  emoji: string | null
  conceptId: string | null
  // The 6xxx account its payments post to (its company's chart); null = not
  // set yet, in which case the name's suggestion (never saved by itself).
  expenseAccountCode: string | null
  suggestedExpenseAccountCode: string | null
  // HR payroll books wages — never an account here.
  isPayroll: boolean
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

// ─── Accounts: the category's expense account, where the money came from ──

interface ChartAccount { id: string; code: string; name: string; type: string; isActive: boolean; tenantId: string | null }

/** One company's active operating-expense (6xxx) accounts — what a category can be booked to. */
function useExpenseAccounts(tenantId: string | null | undefined) {
  const q = useQuery<ChartAccount[]>({
    queryKey: ['chart-of-accounts'],
    queryFn: () => api.get('/setup/chart-of-accounts'),
    staleTime: 60_000,
    retry: false,
  })
  const accounts = (q.data ?? []).filter((a) => a.tenantId === tenantId && a.type === 'expense' && a.isActive && /^6\d{3}$/.test(a.code))
  return { accounts, isLoading: q.isLoading, isError: q.isError }
}

function ExpenseAccountSelect({ tenantId, value, onChange, id, emptyLabel = '— not set —' }: {
  tenantId: string | null | undefined; value: string; onChange: (code: string) => void; id: string; emptyLabel?: string
}) {
  const { accounts, isLoading, isError } = useExpenseAccounts(tenantId)
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={fieldCls} disabled={isLoading || isError}>
      <option value="">{isError ? 'Chart of accounts unavailable' : emptyLabel}</option>
      {value && !accounts.some((a) => a.code === value) && <option value={value}>{value}</option>}
      {accounts.map((a) => <option key={a.id} value={a.code}>{a.code} · {a.name}</option>)}
    </select>
  )
}

/** "6010 · Rent" for a code of the company's chart. */
function useAccountLabel(tenantId: string | null | undefined) {
  const { accounts } = useExpenseAccounts(tenantId)
  return (code: string | null | undefined) => {
    if (!code) return ''
    const a = accounts.find((x) => x.code === code)
    return a ? `${a.code} · ${a.name}` : code
  }
}

/** Where a posted payment's money came from, in words: cash, or the bank's name. */
function usePaidFromLabel(tenantId: string | null | undefined) {
  const { data: banks = [] } = useBankAccounts()
  return (creditCode: string | null | undefined) => {
    if (!creditCode) return ''
    if (creditCode === '1010') return 'cash'
    const b = banks.find((x) => x.accountCode === creditCode && (!tenantId || x.tenantId === tenantId))
    return b ? b.name : `account ${creditCode}`
  }
}

/** Today's date in Karachi, as a date input holds it (YYYY-MM-DD). */
const todayKarachi = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })

/** A date input's day as the instant to send: now for today, else midday in Karachi. */
function paidAtFor(day: string): string {
  return day === todayKarachi() ? new Date().toISOString() : `${day}T12:00:00+05:00`
}
const dayOf = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' }) : '')

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

        <PostOldPayments
          onEditCategory={(id) => setEditingCategory(categories.find((c) => c.id === id) ?? null)}
          onPosted={() => qc.invalidateQueries({ queryKey: ['opex-categories'] })}
        />
      </div>

      {creatingCategory && <CategoryModal activeTenantId={activeTenant?.id ?? null} onClose={() => setCreatingCategory(false)} onSaved={() => { qc.invalidateQueries({ queryKey: ['opex-categories'] }); setCreatingCategory(false) }} />}
      {editingCategory && <CategoryModal category={editingCategory} activeTenantId={activeTenant?.id ?? null} onClose={() => setEditingCategory(null)} onSaved={() => { qc.invalidateQueries({ queryKey: ['opex-categories'] }); setEditingCategory(null) }} />}
      {addingLineFor && <LineModal category={addingLineFor} onClose={() => setAddingLineFor(null)} onSaved={() => { qc.invalidateQueries({ queryKey: ['opex-categories'] }); setAddingLineFor(null) }} />}
      {editingLine && (() => {
        // The fresh copy after a refetch, so a payment just recorded or
        // corrected shows in the open line's history.
        const cat = categories.find((c) => c.id === editingLine.category.id) ?? editingLine.category
        const line = cat.lines.find((l) => l.id === editingLine.line.id) ?? editingLine.line
        return <LineModal category={cat} line={line} onClose={() => setEditingLine(null)} onSaved={() => { qc.invalidateQueries({ queryKey: ['opex-categories'] }); setEditingLine(null) }} />
      })()}
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
  const accountLabel = useAccountLabel(category.tenantId)

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
            {!category.isPayroll && (
              category.expenseAccountCode
                ? <p className="text-[11px] text-white/45">Booked to {accountLabel(category.expenseAccountCode)}</p>
                : category.suggestedExpenseAccountCode
                  ? <p className="text-[11px] text-white/45">No account set — payments use the suggested {accountLabel(category.suggestedExpenseAccountCode)}</p>
                  : <p className="text-[11px]" style={{ color: 'var(--erp-warning)' }}>No expense account yet — set it under Edit category</p>
            )}
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

function CategoryModal({ category, activeTenantId, onClose, onSaved }: { category?: Category; activeTenantId: string | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(category?.name ?? '')
  const [emoji, setEmoji] = useState(category?.emoji ?? '')
  const [budgetMonthlyCents, setBudget] = useState(category?.budgetMonthlyCents ?? 0)
  const [notes, setNotes] = useState(category?.notes ?? '')
  const [expenseAccountCode, setExpenseAccountCode] = useState(category?.expenseAccountCode ?? '')
  // A category's account lives in ITS company's chart; a new one is created
  // in the active company.
  const tenantId = category ? category.tenantId : activeTenantId
  const accountLabel = useAccountLabel(tenantId)
  const suggested = category?.suggestedExpenseAccountCode ?? null

  const save = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = { name, emoji: emoji || null, budgetMonthlyCents, notes: notes || null }
      if (category) {
        // Only when changed — clearing it is allowed (the next payment asks).
        if (!category.isPayroll && expenseAccountCode !== (category.expenseAccountCode ?? '')) payload.expenseAccountCode = expenseAccountCode || null
        return api.patch(`/opex/categories/${category.id}`, payload)
      }
      // Left blank on a new category: servd suggests one from the name.
      if (expenseAccountCode) payload.expenseAccountCode = expenseAccountCode
      return api.post('/opex/categories', payload)
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
    {category?.isPayroll ? (
      <Hint>Payroll is booked by HR payroll, so this category has no expense account here.</Hint>
    ) : (
      <div>
        <label htmlFor="opex-cat-account" className="text-xs text-white/55">Expense account</label>
        <div className="mt-1">
          <ExpenseAccountSelect id="opex-cat-account" tenantId={tenantId} value={expenseAccountCode} onChange={setExpenseAccountCode}
            emptyLabel={category ? '— not set —' : '— suggest from the name —'} />
        </div>
        {category && !expenseAccountCode && suggested && (
          <p className="text-[11px] text-white/45 mt-1">
            Suggested from the name: {accountLabel(suggested)}.{' '}
            <button type="button" onClick={() => setExpenseAccountCode(suggested)} className="text-primary-ink hover:underline">Use it</button>
          </p>
        )}
        <Hint>Every payment in this category is booked to this account. Changing it affects new payments only.</Hint>
      </div>
    )}
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
  const [bankAccountId, setBankAccountId] = useState(line?.bankAccountId ?? '')
  const [notes, setNotes] = useState(line?.notes ?? '')
  const paidInCash = paymentMethod === 'cash'

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        categoryId: category.id, name,
        vendor: vendor || null, vendorContact: vendorContact || null,
        amountCents, cadence,
        nextDueDate: nextDueDate ? `${nextDueDate}T00:00:00Z` : null,
        paymentMethod: paymentMethod || null,
        // The bank its payments leave from (the category's company's). Cash names none.
        bankAccountId: paidInCash ? null : (bankAccountId || null),
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
    {!paidInCash && (
      <div>
        <BankAccountSelect tenantId={category.tenantId} value={bankAccountId} onChange={setBankAccountId}
          id={`opex-line-bank-${line?.id ?? 'new'}`} label="Paid from (bank account)" className={fieldCls} />
        <Hint>Card and auto-debit payments come out of a bank account too — pick the one they draw on.</Hint>
      </div>
    )}
    <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={fieldCls} /></Field>

    {/* Payment history — only when editing */}
    {line && <PaymentHistory line={line} category={category} onChange={() => qc.invalidateQueries({ queryKey: ['opex-categories'] })} />}

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

function PaymentHistory({ line, category, onChange }: { line: Line; category: Category; onChange: () => void }) {
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const accountLabel = useAccountLabel(category.tenantId)
  const paidFromLabel = usePaidFromLabel(category.tenantId)

  return <Section heading={`Payment history · ${line.payments.length}`}>
    <div className="space-y-1.5">
      {line.payments.slice(0, 6).map((p) => {
        const variance = p.actualCents != null ? p.actualCents - p.expectedCents : 0
        const variancePct = p.expectedCents > 0 ? (variance / p.expectedCents) * 100 : 0
        const posted = p.ledger?.status === 'posted'
        const details = [
          p.paidAt && `paid ${new Date(p.paidAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'Asia/Karachi' })}`,
          posted && p.ledger?.creditCode && `from ${paidFromLabel(p.ledger.creditCode)}`,
          posted && p.ledger?.accountCode && `booked to ${accountLabel(p.ledger.accountCode)}`,
          p.paymentRef && `ref ${p.paymentRef}`,
        ].filter(Boolean) as string[]
        return (
          <div key={p.id} className="rounded-lg p-3"
            style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-xs text-white/55">{new Date(p.periodStart).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-mono text-white/85">{p.actualCents != null ? PKR(p.actualCents) : <em className="text-white/45">unpaid</em>}</p>
                {p.actualCents != null && Math.abs(variancePct) >= 5 && (
                  <p className="text-[11px]" style={{ color: variance > 0 ? 'var(--erp-danger)' : 'var(--erp-success)' }}>
                    {variance > 0 ? '+' : ''}{variancePct.toFixed(0)}% vs expected
                  </p>
                )}
              </div>
              {p.paidAt && (
                posted
                  ? <span className="text-[10px] font-black text-success">PAID · ON THE BOOKS</span>
                  : p.ledger?.status === 'payroll'
                    ? <span className="text-[10px] font-black text-white/55" title="HR payroll books wages">PAID · VIA PAYROLL</span>
                    : <span className="text-[10px] font-black text-s-amber" title="Paid before payments posted to the books — an admin can post it from 'Post old payments' at the foot of this page">PAID · NOT POSTED</span>
              )}
              <button onClick={() => setEditingId(editingId === p.id ? null : p.id)}
                className="text-[11px] text-primary-ink hover:underline">
                {editingId === p.id ? 'Close' : p.paidAt ? 'Correct' : 'Mark paid'}
              </button>
            </div>
            {(details.length > 0 || p.receiptUrl) && (
              <p className="text-[11px] text-white/45 mt-1 break-words">
                {details.join(' · ')}
                {p.receiptUrl && <>{details.length > 0 && ' · '}<a href={p.receiptUrl} target="_blank" rel="noopener noreferrer" className="text-primary-ink hover:underline">Receipt ↗</a></>}
              </p>
            )}
            {editingId === p.id && (
              <PaymentForm line={line} category={category} payment={p}
                onCancel={() => setEditingId(null)} onDone={() => { setEditingId(null); onChange() }} />
            )}
          </div>
        )
      })}
    </div>
    {adding ? (
      <PaymentForm line={line} category={category} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); onChange() }} />
    ) : (
      <button onClick={() => setAdding(true)}
        className="w-full rounded-lg border-2 border-dashed border-white/10 px-3 py-2 text-xs text-white/55 hover:text-white hover:border-white/30 mt-2">
        + Record this period's payment
      </button>
    )}
  </Section>
}

// Record a payment (new) or correct one (existing). Marking it paid posts it
// to the books in the same step; a correction to the amount, the paid date or
// an account reverses and reposts it; a reference, receipt or note alone
// changes nothing on the books. If the ledger refuses (closed month, no
// expense account, no bank picked when the company has several) nothing is
// saved and the reason shows here.
function PaymentForm({ line, category, payment, onCancel, onDone }: {
  line: Line; category: Category; payment?: Payment; onCancel: () => void; onDone: () => void
}) {
  const { data: banks = [] } = useBankAccounts()
  const today = todayKarachi()
  const monthEnd = new Date(); monthEnd.setMonth(monthEnd.getMonth() + 1); monthEnd.setDate(0)
  const postedFrom = payment?.ledger?.status === 'posted' ? payment.ledger.creditCode ?? null : null
  const bankOfCode = (code: string | null) =>
    code ? (banks.find((b) => b.accountCode === code && b.tenantId === category.tenantId)?.id ?? '') : ''
  // What the form opened with — a correction sends only what differs from it.
  const [initial] = useState(() => ({
    // Periods are stored as UTC calendar days (T00:00:00Z … T23:59:59Z).
    periodStart: payment ? payment.periodStart.slice(0, 10) : today,
    periodEnd:   payment ? payment.periodEnd.slice(0, 10) : monthEnd.toISOString().slice(0, 10),
    actualCents: payment ? (payment.actualCents ?? payment.expectedCents) : line.amountCents,
    paidOn:      payment?.paidAt ? dayOf(payment.paidAt) : today,
    paymentRef:  payment?.paymentRef ?? '',
    receiptUrl:  payment?.receiptUrl ?? '',
    // Where it was paid from: what its entry says once posted, else the line's.
    cash:        postedFrom ? postedFrom === '1010' : (line.paymentMethod === 'cash' && !line.bankAccountId),
    bankAccountId: postedFrom ? bankOfCode(postedFrom) : (line.bankAccountId ?? ''),
  }))
  const [periodStart, setPeriodStart] = useState(initial.periodStart)
  const [periodEnd, setPeriodEnd] = useState(initial.periodEnd)
  const [actualCents, setActual] = useState(initial.actualCents)
  const [paidOn, setPaidOn] = useState(initial.paidOn)
  const [paymentRef, setPaymentRef] = useState(initial.paymentRef)
  const [receiptUrl, setReceiptUrl] = useState(initial.receiptUrl)
  const [cash, setCash] = useState(initial.cash)
  const [bankAccountId, setBankAccountId] = useState(initial.bankAccountId)
  // Only a deliberate change of cash / bank is sent on a correction — an
  // untouched one keeps the bank the entry was paid from.
  const [moneyTouched, setMoneyTouched] = useState(false)
  useEffect(() => {
    // The bank list may arrive after the form opened: show the posted bank.
    if (!moneyTouched && !bankAccountId && postedFrom && postedFrom !== '1010') {
      const id = bankOfCode(postedFrom)
      if (id) setBankAccountId(id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [banks])
  // The expense account: asked when the category has none (pre-filled with the
  // name's suggestion; remembered for the category), else only on request.
  const needsAccount = !category.isPayroll && !category.expenseAccountCode
  const [expenseAccountCode, setExpenseAccountCode] = useState(needsAccount && !payment?.paidAt ? (category.suggestedExpenseAccountCode ?? '') : '')
  const [overrideAccount, setOverrideAccount] = useState(false)
  const accountLabel = useAccountLabel(category.tenantId)

  const save = useMutation({
    mutationFn: () => {
      if (!payment) {
        return api.post('/opex/payments', {
          lineId: line.id,
          periodStart: `${periodStart}T00:00:00Z`,
          periodEnd:   `${periodEnd}T23:59:59Z`,
          expectedCents: line.amountCents,
          actualCents,
          paidAt: paidAtFor(paidOn),
          paymentRef: paymentRef.trim() || null,
          receiptUrl: receiptUrl.trim() || null,
          ...(cash ? { payFrom: 'cash' } : { payFrom: 'bank', ...(bankAccountId && { bankAccountId }) }),
          ...(expenseAccountCode && { expenseAccountCode }),
        })
      }
      // A correction sends only what changed, so an untouched date or bank
      // never moves the entry.
      const body: Record<string, unknown> = {}
      if (periodStart !== initial.periodStart) body.periodStart = `${periodStart}T00:00:00Z`
      if (periodEnd !== initial.periodEnd) body.periodEnd = `${periodEnd}T23:59:59Z`
      if (actualCents !== initial.actualCents || !payment.paidAt) body.actualCents = actualCents
      if (!payment.paidAt || paidOn !== initial.paidOn) body.paidAt = paidAtFor(paidOn)
      if (paymentRef !== initial.paymentRef) body.paymentRef = paymentRef.trim() || null
      if (receiptUrl !== initial.receiptUrl) body.receiptUrl = receiptUrl.trim() || null
      if (moneyTouched) {
        Object.assign(body, cash ? { payFrom: 'cash' } : { payFrom: 'bank', ...(bankAccountId && { bankAccountId }) })
      }
      if (expenseAccountCode) body.expenseAccountCode = expenseAccountCode
      return api.patch(`/opex/payments/${payment.id}`, body)
    },
    onSuccess: onDone,
  })
  const unpay = useMutation({
    mutationFn: () => api.patch(`/opex/payments/${payment!.id}`, { paidAt: null }),
    onSuccess: onDone,
  })
  const err = (save.error ?? unpay.error) as { code?: string; message?: string } | null
  const showAccount = needsAccount || overrideAccount || err?.code === 'CATEGORY_NOT_MAPPED' || err?.code === 'ACCOUNT_NOT_FOUND'
  const idp = payment?.id ?? `new-${line.id}`

  return (
    <div className="rounded-xl p-3 mt-2 space-y-2" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div>
          <label htmlFor={`ps-${idp}`} className="text-[11px] text-white/55">Period from</label>
          <input id={`ps-${idp}`} type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className={fieldCls} />
        </div>
        <div>
          <label htmlFor={`pe-${idp}`} className="text-[11px] text-white/55">Period to</label>
          <input id={`pe-${idp}`} type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className={fieldCls} />
        </div>
        <div>
          <span className="block text-[11px] text-white/55">Amount paid (PKR)</span>
          <MoneyInput value={actualCents} onChange={setActual} className={fieldCls} ariaLabel="Amount paid (PKR)" />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div>
          <label htmlFor={`pd-${idp}`} className="text-[11px] text-white/55">Paid on</label>
          <input id={`pd-${idp}`} type="date" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} className={fieldCls} />
        </div>
        <div>
          <label htmlFor={`ref-${idp}`} className="text-[11px] text-white/55">Reference (cheque / transfer no.)</label>
          <input id={`ref-${idp}`} value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)} maxLength={120} className={fieldCls} />
        </div>
        <div>
          <label htmlFor={`rc-${idp}`} className="text-[11px] text-white/55">Receipt link</label>
          <input id={`rc-${idp}`} type="url" value={receiptUrl} onChange={(e) => setReceiptUrl(e.target.value)} placeholder="https://…" className={fieldCls} />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-end">
        <label className="flex items-center gap-2 text-xs text-white/70">
          <input type="checkbox" checked={cash} onChange={(e) => { setCash(e.target.checked); setMoneyTouched(true) }} />
          Paid in cash
        </label>
        {!cash && (
          <BankAccountSelect tenantId={category.tenantId} value={bankAccountId} onChange={(v) => { setBankAccountId(v); setMoneyTouched(true) }}
            id={`bank-${idp}`} label="Paid from" className={fieldCls} />
        )}
      </div>
      {showAccount ? (
        <div>
          <label htmlFor={`exp-${idp}`} className="text-[11px] text-white/55">
            {needsAccount ? 'Expense account — remembered for this category' : 'Book this payment to'}
          </label>
          <ExpenseAccountSelect id={`exp-${idp}`} tenantId={category.tenantId} value={expenseAccountCode} onChange={setExpenseAccountCode}
            emptyLabel={needsAccount ? '— pick the expense account —' : '— the category\'s account —'} />
        </div>
      ) : !category.isPayroll && (
        <p className="text-[11px] text-white/45">
          Booked to {accountLabel(category.expenseAccountCode)}.{' '}
          <button type="button" onClick={() => setOverrideAccount(true)} className="text-primary-ink hover:underline">Book this one elsewhere</button>
        </p>
      )}
      {err && <p role="alert" className="text-[11px] text-s-red">{err.message}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {payment?.paidAt && (
          <button onClick={() => { if (confirm('Mark this payment unpaid? Its entry is reversed.')) unpay.mutate() }} disabled={unpay.isPending}
            className="text-xs text-s-red/80 hover:text-s-red mr-auto">Mark unpaid</button>
        )}
        <button onClick={onCancel} className="text-xs text-white/55 hover:text-white">Cancel</button>
        <button onClick={() => save.mutate()} disabled={save.isPending || actualCents <= 0 || !paidOn}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-on disabled:opacity-50">
          {save.isPending ? 'Saving…' : payment ? (payment.paidAt ? 'Save correction' : 'Mark paid') : '+ Record'}
        </button>
      </div>
    </div>
  )
}

// ─── Post old payments (admin) ──────────────────────────────────────────────
// Paid OpEx payments that never reached the books (recorded before payments
// posted). POST /opex/payments/post-unposted: Preview tries each one and rolls
// back, so it says exactly what posting would do; Post does it. Nothing is
// forced — a payment that can't post says why, and how to fix it.

interface BackfillRow {
  paymentId: string; line: string; lineId: string; categoryId: string; category: string
  paidAt: string | null; amountCents: number | null
  outcome: 'payroll' | 'already_posted' | 'would_post' | 'posted' | 'needs_account' | 'needs_bank' | 'period_locked' | 'failed'
  code?: string; reason?: string
}
interface BackfillResult { dryRun: boolean; counts: Partial<Record<BackfillRow['outcome'], number>>; rows: BackfillRow[] }

const BACKFILL_LABEL: Record<BackfillRow['outcome'], string> = {
  would_post: 'Will post on its paid date',
  posted: 'Posted',
  needs_account: 'Needs an expense account — set it on the category',
  needs_bank: 'Needs a bank — pick it on the line',
  period_locked: 'Its month is closed — not posted; for the accountant',
  failed: 'Not posted',
  already_posted: 'Already on the books',
  payroll: 'Payroll — booked by HR payroll',
}

function PostOldPayments({ onEditCategory, onPosted }: { onEditCategory: (categoryId: string) => void; onPosted: () => void }) {
  const isAdmin = useAuthStore((s) => s.isRole('admin'))
  const [result, setResult] = useState<BackfillResult | null>(null)
  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.post<BackfillResult>('/opex/payments/post-unposted', { dryRun }),
    onSuccess: (r) => { setResult(r); if (!r.dryRun) onPosted() },
  })
  if (!isAdmin) return null
  const rows = (result?.rows ?? []).filter((r) => r.outcome !== 'already_posted' && r.outcome !== 'payroll')
  const postable = result?.dryRun ? (result.counts.would_post ?? 0) : 0

  return (
    <section className="rounded-2xl p-5 space-y-3"
      style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-xl">
          <h2 className="text-sm font-black text-white/85">Post old payments</h2>
          <p className="text-xs text-white/50 mt-1">
            Payments marked paid before OpEx posted to the books. Preview first: it says which will post and which need an
            expense account, a bank, or sit in a closed month. Closed months are never reopened.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => run.mutate(true)} disabled={run.isPending}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/70 hover:text-white">Preview</button>
          <button onClick={() => run.mutate(false)} disabled={run.isPending || postable === 0}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-on disabled:opacity-50">
            Post{postable > 0 ? ` ${postable}` : ''}
          </button>
        </div>
      </div>
      {run.error && <p role="alert" className="text-xs text-s-red">{(run.error as Error).message}</p>}
      {result && (
        rows.length === 0
          ? <p className="text-xs text-white/50">Every paid OpEx payment is on the books.</p>
          : (
            <div className="space-y-1.5">
              {rows.map((r) => (
                <div key={r.paymentId} className="rounded-lg px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                  style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
                  <span className="font-bold text-white/80 min-w-0 flex-1 break-words">{r.line}</span>
                  <span className="text-white/50">{r.paidAt ? new Date(r.paidAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'Asia/Karachi' }) : '—'}</span>
                  <span className="font-mono text-white/70">{r.amountCents != null ? PKR(r.amountCents) : '—'}</span>
                  <span style={{ color: r.outcome === 'posted' || r.outcome === 'would_post' ? 'var(--erp-success)' : r.outcome === 'failed' || r.outcome === 'period_locked' ? 'var(--erp-danger)' : 'var(--erp-warning)' }}
                    title={r.reason}>
                    {BACKFILL_LABEL[r.outcome]}{r.outcome === 'failed' && r.reason ? ` — ${r.reason}` : ''}
                  </span>
                  {r.outcome === 'needs_account' && (
                    <button onClick={() => onEditCategory(r.categoryId)} className="text-primary-ink hover:underline">Set account</button>
                  )}
                </div>
              ))}
            </div>
          )
      )}
    </section>
  )
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
