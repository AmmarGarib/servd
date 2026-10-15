'use client'
// OpEx Tracker — recurring operational expenses per category. Counterpart
// to /finance/capex but the model is fundamentally different: monthly
// commitments, no quote-shopping, watch trends + variances against budget.
//
// Payroll category links to /payroll-snapshot — pulls live from HR payroll runs
// data instead of manual entry. License renewals + subscriptions tracked
// the same way (just with cadence='annual' or 'quarterly').
//
// Finance wave B (H8 / H25 / H28): a line names its vendor as a Supplier of the
// category's company (GET /procurement/suppliers?view=picker&categoryId=), its
// usual withholding section and the authority that usually charges it sales
// tax. Marking a payment paid takes the INVOICE (incl. sales tax), the sales
// tax with who charged it, and the section; the server works out the WHT and
// the cash (GET /opex/wht-quote previews it — the page computes nothing). A
// rent advance is 'prepaid' for the months it covers (released monthly from
// 1310); refundable deposits are CapEx. Equipment is refused (422 USE_CAPEX):
// it goes through CapEx. Budgets compare the EXPENSE (invoice − input tax).

import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api, ApiError } from '../../../lib/api'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { BankAccountSelect, useBankAccounts } from '../../../components/finance/BankAccountSelect'
import { useAuthStore } from '../../../store/auth'
import { canOpenPath } from '../../../lib/moduleCatalog'
import { usePermissions } from '../../../hooks/useCan'
import { Select } from '@/components/ui/Select'

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
  // Wave B: the tax split (server-worked). actualCents is the CASH paid.
  whtCents?: number
  inputTaxCents?: number
  inputTaxAuthority?: Authority | null
  whtSection?: WhtSection | null
  whtRateBps?: number | null
  filerStatus?: string | null
  whtOverrideReason?: string | null
  treatment?: 'expense' | 'prepaid' | 'deposit'
  coversFrom?: string | null
  coversMonths?: number | null
  /** cash + WHT = invoice; invoice − input tax = expense (what the budget compares). */
  amounts?: { cashCents: number; whtCents: number; inputTaxCents: number; invoiceCents: number; expenseCents: number }
}
type WhtSection = '153_1_a' | '153_1_b' | '153_1_c' | '155'
type Authority = 'fbr' | 'srb'
interface SupplierPick {
  id: string
  name: string
  filerStatus: string
  whtExemptUntil: string | null
  defaultWhtSection: WhtSection | null
  defaultTaxAuthority: Authority | null
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
  /** The vendor as a Supplier of the category's company (wins over `vendor`). */
  supplierId?: string | null
  supplier?: SupplierPick | null
  /** The usual withholding section (null = none). */
  whtSection?: WhtSection | null
  /** Who usually charges this line sales tax. */
  inputTaxAuthority?: Authority | null
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

const WHT_SECTION_LABEL: Record<WhtSection, string> = {
  '153_1_a': 's.153(1)(a) — goods',
  '153_1_b': 's.153(1)(b) — services',
  '153_1_c': 's.153(1)(c) — contracts',
  '155': 's.155 — rent',
}
const AUTHORITY_LABEL: Record<Authority, string> = { fbr: 'FBR', srb: 'SRB (Sindh)' }
const FILER_LABEL: Record<string, string> = { filer: 'Filer', non_filer: 'Non-filer', exempt: 'Exempt', unknown: 'Filer status not known' }

// The OpEx routes' codes, in words (the API's own message is the fallback).
const OPEX_ERROR_TEXT: Record<string, string> = {
  INVOICE_AMOUNT_REQUIRED: 'This vendor is withheld at source: give the invoice amount (what the vendor billed). The cash paid is worked out from it.',
  VENDOR_REQUIRED_FOR_WHT: 'Withholding needs the vendor: pick the supplier on the line — its filer status and exemption decide the rate.',
  INPUT_TAX_AUTHORITY_REQUIRED: 'Say who charged the sales tax on this invoice (FBR or SRB).',
  INPUT_TAX_TOO_LARGE: 'The sales tax must be less than the invoice amount.',
  WHT_OVERRIDE_REASON_REQUIRED: 'Say why the withholding differs from the rate (at least 10 characters) — the CA reads it on the withholding register.',
  WHT_OVERRIDE_TOO_LARGE: 'The withholding cannot be more than the invoice less its sales tax.',
  DEPOSIT_USE_CAPEX: 'A refundable deposit is money we get back, never an expense — record it in CapEx as a deposit.',
  PREPAID_TERM_REQUIRED: 'A prepaid payment needs the months it covers: the first month and how many months.',
  PREPAID_RELEASING: 'This prepaid payment is already being released month by month — its treatment and months can no longer change.',
  USE_CAPEX: 'This looks like equipment. Equipment goes on the fixed-asset register through CapEx (Finance → CapEx → Quick buy), not OpEx.',
  OVERRIDE_NOT_ALLOWED: 'Only finance or the CEO can book something that looks like equipment as an expense.',
  OVERRIDE_REASON_REQUIRED: 'Say why this is not equipment (at least 10 characters).',
  SUPPLIER_NOT_IN_COMPANY: 'That vendor is not a supplier of this company — add it under Procurement → Suppliers first.',
  CATEGORY_NOT_IN_COMPANY: 'That category belongs to another company.',
  PERIOD_LOCKED: 'The books are closed for that date — pick a date in an open month.',
  PAID_IN_FUTURE: 'A payment cannot be marked paid on a date that has not come yet.',
  BANK_ACCOUNT_REQUIRED: 'This company has more than one bank — pick the bank the money left from.',
  BANK_ACCOUNT_ON_CASH: 'A cash payment does not use a bank account.',
  BANK_ACCOUNT_NOT_IN_COMPANY: 'That bank account is not an active account of this company.',
  BANK_ACCOUNT_NOT_LINKED: 'That bank account has no chart code yet (Configuration → Bank accounts).',
  CATEGORY_NOT_MAPPED: 'Pick the expense account for this category.',
  ACCOUNT_NOT_FOUND: 'That expense account is not in this company\'s chart.',
  NOT_AN_EXPENSE_CODE: 'Pick an operating-expense (6xxx) account.',
  AMOUNT_TOO_LARGE: 'That amount is too large.',
  NOT_FOUND: 'Not found in your companies — refresh the page.',
}
function opexErrorText(e: unknown): string {
  const x = e as { code?: string; message?: string } | null
  return (x?.code && OPEX_ERROR_TEXT[x.code]) || x?.message || 'Something went wrong'
}

/** The vendor picker: the suppliers of the category's company, with their tax profile. */
function useVendorPicker(categoryId: string) {
  return useQuery<SupplierPick[]>({
    queryKey: ['opex-vendor-picker', categoryId],
    queryFn: () => api.get(`/procurement/suppliers?view=picker&categoryId=${encodeURIComponent(categoryId)}`),
    staleTime: 60_000,
    retry: false,
    meta: { background: true },
  })
}

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
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={fieldCls} disabled={isLoading || isError}>
      <option value="">{isError ? 'Chart of accounts unavailable' : emptyLabel}</option>
      {value && !accounts.some((a) => a.code === value) && <option value={value}>{value}</option>}
      {accounts.map((a) => <option key={a.id} value={a.code}>{a.code} · {a.name}</option>)}
    </Select>
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
      <header className="px-4 sm:px-7 py-5 border-b border-white/[0.05]">
        <Link href="/finance" className="text-xs text-white/40 hover:text-white/70">← Finance</Link>
        <div className="flex items-start justify-between gap-4 mt-1 flex-wrap">
          <div>
            <h1 className="text-2xl font-black text-white/90">OpEx Tracker</h1>
            <p className="text-sm text-white/40 mt-1 max-w-3xl">
              Every recurring expense — rent, payroll, utilities, software, marketing. System tracks expected vs actual and flags vendor invoices that jump unexpectedly.
            </p>
          </div>
          <button onClick={() => setCreatingCategory(true)} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">+ New category</button>
        </div>
      </header>

      <div className="px-4 sm:px-7 py-6 max-w-[1100px] mx-auto space-y-6">
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
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
  const [supplierId, setSupplierId] = useState(line?.supplierId ?? '')
  const [vendorContact, setVendorContact] = useState(line?.vendorContact ?? '')
  const [amountCents, setAmount] = useState(line?.amountCents ?? 0)
  const [cadence, setCadence] = useState<Cadence>(line?.cadence ?? 'monthly')
  const [nextDueDate, setNextDueDate] = useState(line?.nextDueDate?.slice(0, 10) ?? '')
  const [paymentMethod, setPaymentMethod] = useState(line?.paymentMethod ?? '')
  const [bankAccountId, setBankAccountId] = useState(line?.bankAccountId ?? '')
  const [whtSection, setWhtSection] = useState<WhtSection | ''>(line?.whtSection ?? '')
  const [inputTaxAuthority, setInputTaxAuthority] = useState<Authority | ''>(line?.inputTaxAuthority ?? '')
  const [notes, setNotes] = useState(line?.notes ?? '')
  const paidInCash = paymentMethod === 'cash'
  const payroll = category.isPayroll || line?.source === 'payroll'

  // The vendor master is Procurement's suppliers of the category's company.
  const vendors = useVendorPicker(category.id)
  const picked = (vendors.data ?? []).find((v) => v.id === supplierId) ?? null
  const { data: me } = usePermissions()
  const canAddSupplier = !!me && canOpenPath('/procurement', me.role, me.modules ?? [])

  const save = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
        categoryId: category.id, name,
        vendorContact: vendorContact || null,
        amountCents, cadence,
        nextDueDate: nextDueDate ? `${nextDueDate}T00:00:00Z` : null,
        paymentMethod: paymentMethod || null,
        // The bank its payments leave from (the category's company's). Cash names none.
        bankAccountId: paidInCash ? null : (bankAccountId || null),
        notes: notes || null,
      }
      if (!payroll) {
        // A picked supplier fills the vendor's name on the server; a free-text
        // vendor stays for a line with none.
        payload.supplierId = supplierId || null
        if (!supplierId) payload.vendor = vendor || null
        payload.whtSection = whtSection || 'none'
        payload.inputTaxAuthority = inputTaxAuthority || null
      } else {
        payload.vendor = vendor || null
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
    {payroll ? (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Vendor"><input value={vendor} onChange={(e) => setVendor(e.target.value)} className={fieldCls} /></Field>
        <Field label="Contact"><input value={vendorContact} onChange={(e) => setVendorContact(e.target.value)} placeholder="+92 300 1234567" className={fieldCls} /></Field>
      </div>
    ) : (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor={`opex-vendor-${line?.id ?? 'new'}`} className="text-xs text-white/55">Vendor (supplier)</label>
          <div className="mt-1">
            <Select id={`opex-vendor-${line?.id ?? 'new'}`} value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={fieldCls} disabled={vendors.isLoading}>
              <option value="">{vendors.isError ? 'Suppliers unavailable' : '— no supplier picked —'}</option>
              {(vendors.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </Select>
          </div>
          {picked && (
            <Hint>
              {FILER_LABEL[picked.filerStatus] ?? picked.filerStatus}
              {picked.whtExemptUntil && ` · exemption certificate until ${dayOf(picked.whtExemptUntil)}`}
              {picked.defaultWhtSection && ` · usually ${WHT_SECTION_LABEL[picked.defaultWhtSection]}`}
            </Hint>
          )}
          {!supplierId && line?.vendor && <Hint>Recorded as &ldquo;{line.vendor}&rdquo; (free text). Pick the supplier so withholding can be worked out.</Hint>}
          {canAddSupplier && (
            <Hint><Link href="/procurement" className="text-primary-ink hover:underline">Not listed? Add it in Procurement →</Link></Hint>
          )}
        </div>
        <Field label="Contact"><input value={vendorContact} onChange={(e) => setVendorContact(e.target.value)} placeholder="+92 300 1234567" className={fieldCls} /></Field>
      </div>
    )}
    {!payroll && !supplierId && (
      <Field label="Vendor name (no supplier record)">
        <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Landlord name" className={fieldCls} />
      </Field>
    )}
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <Field label="Amount (PKR) *">
        <MoneyInput value={amountCents} onChange={setAmount} className={fieldCls} />
        <Hint>{PKR(amountCents)}{CADENCE_LABELS[cadence]} — the invoice you expect, sales tax included</Hint>
      </Field>
      <Field label="Cadence">
        <Select value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)} className={fieldCls}>
          <option value="monthly">Monthly</option>
          <option value="quarterly">Quarterly</option>
          <option value="annual">Annual</option>
          <option value="per_use">Per use</option>
        </Select>
      </Field>
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <Field label="Next due"><input type="date" value={nextDueDate} onChange={(e) => setNextDueDate(e.target.value)} className={fieldCls} /></Field>
      <Field label="Payment method">
        <Select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} className={fieldCls}>
          <option value="">—</option>
          <option value="bank_transfer">Bank transfer</option>
          <option value="card">Card</option>
          <option value="cash">Cash</option>
          <option value="auto_debit">Auto-debit</option>
          <option value="cheque">Cheque</option>
        </Select>
      </Field>
    </div>
    {!paidInCash && (
      <div>
        <BankAccountSelect tenantId={category.tenantId} value={bankAccountId} onChange={setBankAccountId}
          id={`opex-line-bank-${line?.id ?? 'new'}`} label="Paid from (bank account)" className={fieldCls} />
        <Hint>Card and auto-debit payments come out of a bank account too — pick the one they draw on.</Hint>
      </div>
    )}
    {!payroll && (
      <Section heading="Tax">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Income tax withheld (section)">
            <Select value={whtSection} onChange={(e) => setWhtSection(e.target.value as WhtSection | '')} className={fieldCls}>
              <option value="">None</option>
              {(Object.keys(WHT_SECTION_LABEL) as WhtSection[]).map((k) => <option key={k} value={k}>{WHT_SECTION_LABEL[k]}</option>)}
            </Select>
          </Field>
          <Field label="Sales tax usually charged by">
            <Select value={inputTaxAuthority} onChange={(e) => setInputTaxAuthority(e.target.value as Authority | '')} className={fieldCls}>
              <option value="">— not usually charged —</option>
              {(Object.keys(AUTHORITY_LABEL) as Authority[]).map((k) => <option key={k} value={k}>{AUTHORITY_LABEL[k]}</option>)}
            </Select>
          </Field>
        </div>
        <Hint>
          Withholding needs the supplier picked above: its filer status and exemption certificate decide the rate (Accounting → Sales tax return → Withholding rates).
          A rent paid months ahead is marked &ldquo;prepaid&rdquo; on the payment; a refundable deposit is recorded in CapEx.
        </Hint>
        {whtSection && !supplierId && <p className="text-[11px] text-s-amber">Pick the supplier — a withholding section needs one.</p>}
      </Section>
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
      <button onClick={() => save.mutate()} disabled={save.isPending || !name.trim() || (!!whtSection && !supplierId && !payroll)} className={primaryBtn}>
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
        // The budget compares the EXPENSE (invoice less its sales tax), never the cash.
        const a = p.amounts
        const spent = p.actualCents != null ? (a ? a.expenseCents : p.actualCents) : null
        const variance = spent != null ? spent - p.expectedCents : 0
        const variancePct = p.expectedCents > 0 ? (variance / p.expectedCents) * 100 : 0
        const posted = p.ledger?.status === 'posted'
        const details = [
          p.paidAt && `paid ${new Date(p.paidAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'Asia/Karachi' })}`,
          a && p.actualCents != null && a.whtCents > 0 && `cash ${PKR(a.cashCents)} + withheld ${PKR(a.whtCents)}${p.whtRateBps != null ? ` (${p.whtRateBps / 100}%)` : ''}`,
          a && a.inputTaxCents > 0 && `sales tax ${PKR(a.inputTaxCents)}${p.inputTaxAuthority ? ` (${AUTHORITY_LABEL[p.inputTaxAuthority] ?? p.inputTaxAuthority})` : ''}`,
          p.treatment === 'prepaid' && p.coversFrom && `prepaid from ${p.coversFrom} for ${p.coversMonths ?? '?'} month${p.coversMonths === 1 ? '' : 's'}`,
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
                <p className="text-sm font-mono text-white/85">
                  {p.actualCents != null ? PKR(a ? a.invoiceCents : p.actualCents) : <em className="text-white/45">unpaid</em>}
                  {p.actualCents != null && a && a.invoiceCents !== a.cashCents && <span className="text-[10px] text-white/45 font-sans"> invoice</span>}
                </p>
                {spent != null && Math.abs(variancePct) >= 5 && (
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
            {p.whtOverrideReason && <p className="text-[11px] text-white/45 mt-0.5">Withholding stated by hand: {p.whtOverrideReason}</p>}
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
        + Record this period&apos;s payment
      </button>
    )}
  </Section>
}

interface WhtQuote {
  whtCents: number; rateBps: number; section: WhtSection | null; filerStatus: string
  exempt: boolean; needsAtlCheck: boolean; cashCents: number; expenseCents: number
}
type SectionChoice = WhtSection | 'none' | 'usual'

// Record a payment (new) or correct one (existing). Marking it paid posts it
// to the books in the same step; a correction to the amount, the paid date or
// an account reverses and reposts it; a reference, receipt or note alone
// changes nothing on the books. If the ledger refuses (closed month, no
// expense account, no bank picked when the company has several) nothing is
// saved and the reason shows here.
//
// Wave B: the operator types the INVOICE (sales tax included), the sales tax
// and who charged it, and the withholding section; the server works out the
// WHT and the cash (the quote below previews it). A correction of a payment
// already paid sends the money fields only when they changed — its cash and
// WHT are facts otherwise (a date fix or an authority change moves nothing).
function PaymentForm({ line, category, payment, onCancel, onDone }: {
  line: Line; category: Category; payment?: Payment; onCancel: () => void; onDone: () => void
}) {
  const { data: banks = [] } = useBankAccounts()
  const { data: me } = usePermissions()
  const canOpenCapex = !!me && canOpenPath('/finance/capex', me.role, me.modules ?? [])
  const today = todayKarachi()
  // Last day of the current Karachi month, from the Karachi `today` (UTC arithmetic on a date-only value).
  const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0))
  const postedFrom = payment?.ledger?.status === 'posted' ? payment.ledger.creditCode ?? null : null
  const bankOfCode = (code: string | null) =>
    code ? (banks.find((b) => b.accountCode === code && b.tenantId === category.tenantId)?.id ?? '') : ''
  // Payroll is HR's: no tax split here — the amount is the cash.
  const payroll = category.isPayroll || line.source === 'payroll'
  const wasPaid = !!payment?.paidAt
  const usualSection = line.whtSection ?? line.supplier?.defaultWhtSection ?? null
  // What the form opened with — a correction sends only what differs from it.
  const [initial] = useState(() => {
    const invoice = payment
      ? (payment.actualCents != null ? (payment.amounts?.invoiceCents ?? payment.actualCents) : payment.expectedCents)
      : line.amountCents
    return {
      // Periods are stored as UTC calendar days (T00:00:00Z … T23:59:59Z).
      periodStart: payment ? payment.periodStart.slice(0, 10) : today,
      periodEnd:   payment ? payment.periodEnd.slice(0, 10) : monthEnd.toISOString().slice(0, 10),
      invoiceCents: invoice,
      inputTaxCents: payment?.inputTaxCents ?? 0,
      authority: (payment?.inputTaxAuthority ?? line.inputTaxAuthority ?? line.supplier?.defaultTaxAuthority ?? '') as Authority | '',
      // Paid: the section it was paid under; not paid yet: the line's usual one.
      section: (wasPaid ? (payment?.whtSection ?? 'none') : 'usual') as SectionChoice,
      overrideOn: !!payment?.whtOverrideReason,
      overrideCents: payment?.whtCents ?? 0,
      overrideReason: payment?.whtOverrideReason ?? '',
      treatment: (payment?.treatment === 'prepaid' ? 'prepaid' : 'expense') as 'expense' | 'prepaid',
      coversFrom: payment?.coversFrom ?? (payment ? payment.periodStart.slice(0, 7) : today.slice(0, 7)),
      coversMonths: payment?.coversMonths ? String(payment.coversMonths) : '12',
      paidOn:      payment?.paidAt ? dayOf(payment.paidAt) : today,
      paymentRef:  payment?.paymentRef ?? '',
      receiptUrl:  payment?.receiptUrl ?? '',
      // Where it was paid from: what its entry says once posted, else the line's.
      cash:        postedFrom ? postedFrom === '1010' : (line.paymentMethod === 'cash' && !line.bankAccountId),
      bankAccountId: postedFrom ? bankOfCode(postedFrom) : (line.bankAccountId ?? ''),
    }
  })
  const [periodStart, setPeriodStart] = useState(initial.periodStart)
  const [periodEnd, setPeriodEnd] = useState(initial.periodEnd)
  const [invoiceCents, setInvoice] = useState(initial.invoiceCents)
  const [inputTaxCents, setInputTax] = useState(initial.inputTaxCents)
  const [authority, setAuthority] = useState<Authority | ''>(initial.authority)
  const [section, setSection] = useState<SectionChoice>(initial.section)
  const [overrideOn, setOverrideOn] = useState(initial.overrideOn)
  const [overrideCents, setOverrideCents] = useState(initial.overrideCents)
  const [overrideReason, setOverrideReason] = useState(initial.overrideReason)
  const [treatment, setTreatment] = useState(initial.treatment)
  const [coversFrom, setCoversFrom] = useState(initial.coversFrom)
  const [coversMonths, setCoversMonths] = useState(initial.coversMonths)
  const [notEquipment, setNotEquipment] = useState(false)
  const [notEquipmentReason, setNotEquipmentReason] = useState('')
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

  // What changed in the money (a paid payment's split is restated only then).
  const invoiceChanged = invoiceCents !== initial.invoiceCents
  const taxChanged = inputTaxCents !== initial.inputTaxCents
  const sectionChanged = section !== initial.section
  const overrideChanged = overrideOn !== initial.overrideOn
    || (overrideOn && (overrideCents !== initial.overrideCents || overrideReason.trim() !== initial.overrideReason))
  const moneyRestated = !wasPaid || invoiceChanged || taxChanged || sectionChanged || overrideChanged

  // The server's withholding on this invoice (today's rate and the vendor's
  // status) — shown, never worked out here.
  const quoteReady = !payroll && invoiceCents > 0 && inputTaxCents < invoiceCents && moneyRestated && !overrideOn
  const sectionParam = section === 'usual' ? '' : `&section=${section}`
  const quote = useQuery<WhtQuote>({
    queryKey: ['opex-wht-quote', line.id, invoiceCents, inputTaxCents, section],
    queryFn: () => api.get(`/opex/wht-quote?lineId=${line.id}&invoiceCents=${invoiceCents}&inputTaxCents=${inputTaxCents}${sectionParam}`),
    enabled: quoteReady,
    retry: false,
    staleTime: 30_000,
    meta: { inlineErrors: true },
  })

  /** The money fields to send (non-payroll). */
  function moneyBody(): Record<string, unknown> {
    const b: Record<string, unknown> = {}
    if (!wasPaid || invoiceChanged) b.invoiceCents = invoiceCents
    if (!wasPaid ? inputTaxCents > 0 : taxChanged) b.inputTaxCents = inputTaxCents
    if (authority !== initial.authority || (!wasPaid && inputTaxCents > 0)) b.inputTaxAuthority = authority || null
    if (section !== 'usual' && (!wasPaid || sectionChanged)) b.whtSection = section
    if (overrideOn && (!wasPaid || overrideChanged)) { b.whtOverrideCents = overrideCents; b.whtOverrideReason = overrideReason.trim() }
    else if (!overrideOn && initial.overrideOn) b.whtOverrideCents = null
    if (!wasPaid || treatment !== initial.treatment || coversFrom !== initial.coversFrom || coversMonths !== initial.coversMonths) {
      b.treatment = treatment
      if (treatment === 'prepaid') { b.coversFrom = coversFrom; b.coversMonths = Number(coversMonths) }
    }
    if (notEquipment) { b.notEquipment = true; b.notEquipmentReason = notEquipmentReason.trim() }
    return b
  }

  const save = useMutation({
    mutationFn: () => {
      if (!payment) {
        return api.post('/opex/payments', {
          lineId: line.id,
          periodStart: `${periodStart}T00:00:00Z`,
          periodEnd:   `${periodEnd}T23:59:59Z`,
          expectedCents: line.amountCents,
          ...(payroll ? { actualCents: invoiceCents } : moneyBody()),
          paidAt: paidAtFor(paidOn),
          paymentRef: paymentRef.trim() || null,
          receiptUrl: receiptUrl.trim() || null,
          ...(cash ? { payFrom: 'cash' } : { payFrom: 'bank', ...(bankAccountId && { bankAccountId }) }),
          ...(expenseAccountCode && { expenseAccountCode }),
        })
      }
      // A correction sends only what changed, so an untouched date, bank or
      // amount never moves the entry.
      const body: Record<string, unknown> = {}
      if (periodStart !== initial.periodStart) body.periodStart = `${periodStart}T00:00:00Z`
      if (periodEnd !== initial.periodEnd) body.periodEnd = `${periodEnd}T23:59:59Z`
      if (payroll) {
        if (invoiceChanged || !payment.paidAt) body.actualCents = invoiceCents
      } else {
        Object.assign(body, moneyBody())
      }
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
    meta: { inlineErrors: true },
  })
  const unpay = useMutation({
    mutationFn: () => api.patch(`/opex/payments/${payment!.id}`, { paidAt: null }),
    onSuccess: onDone,
    meta: { inlineErrors: true },
  })
  const err = (save.error ?? unpay.error) as (Error & { code?: string; details?: unknown }) | null
  const showAccount = needsAccount || overrideAccount || err?.code === 'CATEGORY_NOT_MAPPED' || err?.code === 'ACCOUNT_NOT_FOUND'
  // The equipment refusal: on a name / note match finance or the CEO may say
  // it is not equipment (the server decides — 403 OVERRIDE_NOT_ALLOWED).
  const equipment = err instanceof ApiError && (err.code === 'USE_CAPEX' || err.code === 'OVERRIDE_REASON_REQUIRED' || err.code === 'OVERRIDE_NOT_ALLOWED')
    ? (err.details as { matched?: string; accountCode?: string } | undefined) ?? {}
    : null
  const idp = payment?.id ?? `new-${line.id}`
  const prepaidOk = treatment !== 'prepaid' || (/^\d{4}-(0[1-9]|1[0-2])$/.test(coversFrom) && Number.isInteger(Number(coversMonths)) && Number(coversMonths) >= 1 && Number(coversMonths) <= 120)
  const overrideOk = !overrideOn || overrideReason.trim().length >= 10
  const notEquipmentOk = !notEquipment || notEquipmentReason.trim().length >= 10
  const shownSection: WhtSection | null = section === 'usual' ? usualSection : section === 'none' ? null : section

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
          <span className="block text-[11px] text-white/55">{payroll ? 'Amount paid (PKR)' : 'Invoice amount, incl. sales tax (PKR)'}</span>
          <MoneyInput value={invoiceCents} onChange={setInvoice} className={fieldCls} ariaLabel={payroll ? 'Amount paid (PKR)' : 'Invoice amount (PKR)'} />
        </div>
      </div>

      {!payroll && (
        <div className="rounded-lg p-2.5 space-y-2" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div>
              <span className="block text-[11px] text-white/55">Sales tax on the invoice (PKR)</span>
              <MoneyInput value={inputTaxCents} onChange={setInputTax} className={fieldCls} ariaLabel="Sales tax on the invoice (PKR)" />
            </div>
            <div>
              <label htmlFor={`auth-${idp}`} className="text-[11px] text-white/55">Charged by</label>
              <Select id={`auth-${idp}`} value={authority} onChange={(e) => setAuthority(e.target.value as Authority | '')} className={fieldCls}>
                <option value="">{inputTaxCents > 0 ? '— pick who charged it —' : '— no sales tax —'}</option>
                {(Object.keys(AUTHORITY_LABEL) as Authority[]).map((k) => <option key={k} value={k}>{AUTHORITY_LABEL[k]}</option>)}
              </Select>
            </div>
            <div>
              <label htmlFor={`sec-${idp}`} className="text-[11px] text-white/55">Income tax withheld</label>
              <Select id={`sec-${idp}`} value={section} onChange={(e) => setSection(e.target.value as SectionChoice)} className={fieldCls}>
                {!wasPaid && <option value="usual">{usualSection ? `The line's usual — ${WHT_SECTION_LABEL[usualSection]}` : 'The line\'s usual — none'}</option>}
                <option value="none">None</option>
                {(Object.keys(WHT_SECTION_LABEL) as WhtSection[]).map((k) => <option key={k} value={k}>{WHT_SECTION_LABEL[k]}</option>)}
              </Select>
            </div>
          </div>
          {inputTaxCents > 0 && <p className="text-[11px] text-white/45">The sales tax is input tax, set off only against {authority ? AUTHORITY_LABEL[authority] : 'the authority that charged it'}.</p>}

          {/* The server's quote */}
          {wasPaid && !moneyRestated && payment?.amounts && (
            <p className="text-[11px] text-white/55">
              Paid: cash {PKR(payment.amounts.cashCents)}{payment.amounts.whtCents > 0 && <> + withheld {PKR(payment.amounts.whtCents)}{payment.whtRateBps != null && ` at ${payment.whtRateBps / 100}%`}</>}
              {payment.filerStatus && <> · {FILER_LABEL[payment.filerStatus] ?? payment.filerStatus}</>}. Change an amount or the section to work it out again.
            </p>
          )}
          {quoteReady && quote.isLoading && <p className="text-[11px] text-white/45">Working out the withholding…</p>}
          {quoteReady && quote.error && <p className="text-[11px] text-s-red">{opexErrorText(quote.error)}</p>}
          {quoteReady && quote.data && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              <span className="text-white/70">
                {quote.data.section
                  ? <>Withheld {PKR(quote.data.whtCents)} at {quote.data.rateBps / 100}% ({WHT_SECTION_LABEL[quote.data.section]})</>
                  : <>No income tax withheld</>}
              </span>
              {quote.data.section && (
                <span className={quote.data.exempt ? 's-badge-muted text-[10px]' : 's-badge-purple text-[10px]'}>
                  {quote.data.exempt ? 'Exempt (certificate)' : FILER_LABEL[quote.data.filerStatus] ?? quote.data.filerStatus}
                </span>
              )}
              {quote.data.needsAtlCheck && <span className="s-badge-amber text-[10px]" title="The supplier's filer status is not known: the filer rate is used. Check FBR's Active Taxpayers List and update the supplier.">Check ATL status</span>}
              <span className="text-white/85 font-semibold">Cash to pay {PKR(quote.data.cashCents)}</span>
              <span className="text-white/45">Expense {PKR(quote.data.expenseCents)}</span>
              {wasPaid && <span className="text-white/45">(today&apos;s rate; a paid payment keeps the filer status it was paid under)</span>}
            </div>
          )}

          {(shownSection || overrideOn) && (
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-[11px] text-white/70">
                <input type="checkbox" className="accent-accent" checked={overrideOn} onChange={(e) => { setOverrideOn(e.target.checked); if (e.target.checked && quote.data) setOverrideCents(quote.data.whtCents) }} />
                Withhold a different amount
              </label>
              {overrideOn && (
                <div className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-2">
                  <MoneyInput value={overrideCents} onChange={setOverrideCents} className={fieldCls} ariaLabel="Withholding (PKR)" />
                  <input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} maxLength={500}
                    placeholder="Why (e.g. the vendor's certificate covers part of the year)" className={fieldCls} />
                  <p className="sm:col-span-2 text-[11px] text-white/45">The cash paid is the invoice less this. The reason (10 characters or more) is on the withholding register for the CA.</p>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
            <div>
              <label htmlFor={`tr-${idp}`} className="text-[11px] text-white/55">This payment is</label>
              <Select id={`tr-${idp}`} value={treatment} onChange={(e) => setTreatment(e.target.value as 'expense' | 'prepaid')} className={fieldCls}>
                <option value="expense">An expense of this period</option>
                <option value="prepaid">Paid ahead (e.g. a rent advance)</option>
              </Select>
            </div>
            {treatment === 'prepaid' && (
              <>
                <div>
                  <label htmlFor={`cf-${idp}`} className="text-[11px] text-white/55">Covers from (month)</label>
                  <input id={`cf-${idp}`} type="month" value={coversFrom} onChange={(e) => setCoversFrom(e.target.value)} className={fieldCls} />
                </div>
                <div>
                  <label htmlFor={`cm-${idp}`} className="text-[11px] text-white/55">For how many months</label>
                  <input id={`cm-${idp}`} type="number" min={1} max={120} step={1} inputMode="numeric" value={coversMonths} onChange={(e) => setCoversMonths(e.target.value)} className={fieldCls} />
                </div>
              </>
            )}
          </div>
          {treatment === 'prepaid'
            ? <p className="text-[11px] text-white/45">Booked to prepaid expenses (1310) and moved to the expense one month at a time.</p>
            : <p className="text-[11px] text-white/45">A refundable deposit (money we get back) is not an expense — record it in CapEx as a deposit.</p>}
        </div>
      )}

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
      {err && (
        <div role="alert" className="text-[11px] text-s-red space-y-1">
          <p>{opexErrorText(err)}</p>
          {equipment && canOpenCapex && (
            <p><Link href="/finance/capex?quickBuy=1" className="text-primary-ink hover:underline">Buy it through CapEx → Quick buy</Link></p>
          )}
        </div>
      )}
      {equipment?.matched && (
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-[11px] text-white/70">
            <input type="checkbox" className="accent-accent" checked={notEquipment} onChange={(e) => setNotEquipment(e.target.checked)} />
            It is not equipment (&ldquo;{equipment.matched}&rdquo; matched) — finance or the CEO only
          </label>
          {notEquipment && (
            <input value={notEquipmentReason} onChange={(e) => setNotEquipmentReason(e.target.value)} maxLength={500}
              placeholder="Why it is an expense (10 characters or more)" className={fieldCls} />
          )}
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {payment?.paidAt && (
          <button onClick={() => { if (confirm('Mark this payment unpaid? Its entry is reversed.')) unpay.mutate() }} disabled={unpay.isPending}
            className="text-xs text-s-red/80 hover:text-s-red mr-auto">Mark unpaid</button>
        )}
        <button onClick={onCancel} className="text-xs text-white/55 hover:text-white">Cancel</button>
        <button onClick={() => save.mutate()}
          disabled={save.isPending || invoiceCents <= 0 || !paidOn || !prepaidOk || !overrideOk || !notEquipmentOk || (!payroll && inputTaxCents > 0 && !authority)}
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
  outcome: 'payroll' | 'already_posted' | 'would_post' | 'posted' | 'needs_account' | 'needs_bank' | 'needs_tax_details' | 'prepaid_releasing' | 'period_locked' | 'failed'
  code?: string; reason?: string
}
interface BackfillResult { dryRun: boolean; counts: Partial<Record<BackfillRow['outcome'], number>>; rows: BackfillRow[] }

const BACKFILL_LABEL: Record<BackfillRow['outcome'], string> = {
  would_post: 'Will post on its paid date',
  posted: 'Posted',
  needs_account: 'Needs an expense account — set it on the category',
  needs_bank: 'Needs a bank — pick it on the line',
  needs_tax_details: 'Needs its tax details — open the payment and fix the sales tax, who charged it, or the prepaid months',
  prepaid_releasing: 'A prepaid payment already being released — its treatment cannot change',
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
      {run.error && <p role="alert" className="text-xs text-s-red">{opexErrorText(run.error)}</p>}
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
                    {BACKFILL_LABEL[r.outcome] ?? r.outcome}{(r.outcome === 'failed' || r.outcome === 'needs_tax_details') && r.reason ? ` — ${r.code && OPEX_ERROR_TEXT[r.code] ? OPEX_ERROR_TEXT[r.code] : r.reason}` : ''}
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
  return (
    <div className="rounded-xl px-4 py-3 text-sm text-s-red"
      style={{ background: 'color-mix(in srgb, var(--erp-danger) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-danger) 30%, transparent)' }}>
      {opexErrorText(error)}
    </div>
  )
}
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
const primaryBtn = "rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50"
