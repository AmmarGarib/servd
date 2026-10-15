'use client'
// Sales tax return — what each authority's return declares for the period,
// what was paid for it, and the settlement actions (finance gap 6):
//   • Record payment — per authority (and for income tax / sales tax withheld):
//     posts Dr the authority's account / Cr input set off / Cr the bank.
//   • Link existing entry — a payment already posted by hand (a manual journal
//     or a bank-reconciliation adjustment) is recorded without posting again.
//   • Post reclass — a provincial brand's output tax still in 2030 for the
//     month moves to its authority's account, dated in that month.
// Paying tax never lowers the period's output: payments are left out of it.
//
// Wave B (H8–H13): delivery charges and kept no-show deposits are supplies of
// their own (SUPPLY_LABEL rows); sales tax our clients withheld (1335) is shown
// per authority and set off only against that authority's payment; statutory
// payroll challans (salary tax / EOBI / SESSI) are NOT this return's payments —
// they live on Accounting → Statutory payments. Tabs: the return, Withholding
// rates (WithholdingRates.tsx) and the Withholding register
// (WithholdingRegister.tsx). Every figure is the server's.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso, startOfMonthPktIso } from '../../../lib/money'
import { BankAccountSelect } from '../../../components/finance/BankAccountSelect'
import Link from 'next/link'
import WithholdingRates from './WithholdingRates'
import WithholdingRegister from './WithholdingRegister'
import { Select } from '@/components/ui/Select'
import { Modal as SharedModal } from '../../../components/ui/Modal'
import { DialogForm, RupeeField } from '../../../components/finance/PaymentReceivedFields'

interface AccountTotal { code: string; name: string; totalCents: number }
type AuthorityKey = 'fbr' | 'srb'
type WithholdingKey = 'wht' | 'stwh'
type PayKey = AuthorityKey | WithholdingKey
interface AuthorityReturn {
  key: AuthorityKey
  authority: string
  name: string
  output: AccountTotal
  input: AccountTotal
  /** output − input of THIS authority; negative = excess input carried forward with it. */
  netPayableCents: number
  brands: string[]
  /** Output tax not explained by the period's order sales (manual journals, B2B invoices, older entries). */
  otherOutputCents: number
  paidForPeriodCents: number
  inputSetOffForPeriodCents: number
  /** H13: sales tax our clients withheld for this authority in the period (1335). */
  withheldByCustomersCents: number
  /** Customer-withheld tax set off in this period's payments to this authority. */
  customerWithheldSetOffForPeriodCents: number
  /** Customer-withheld tax still available to set off against this authority at the period's end. */
  customerWithheldAvailableCents: number
  /** output − input − withheld by customers; negative = carried forward with this authority. */
  netAfterWithheldCents: number
  ledgerBalanceAtEndCents: number
  inputLedgerBalanceAtEndCents: number
  /** H8: federal input on raw materials (1320) set off in this period's payments to this (provincial) authority. */
  crossSetOffForPeriodCents?: number
  /** H8: federal input still claimable against this authority (the company's one pool, shared in table order). */
  federalInputClaimableCents?: number
  /** netAfterWithheldCents − crossSetOffForPeriodCents − federalInputClaimableCents; negative = carried forward. */
  netAfterCrossSetOffCents?: number
}
interface WithholdingReturn {
  key: WithholdingKey
  authority: string
  name: string
  account: AccountTotal
  paidForPeriodCents: number
  ledgerBalanceAtEndCents: number
}
type Supply = 'standard' | 'zero_rated' | 'exempt' | 'custom' | 'delivery_charge' | 'deposit_forfeit'
interface RateLine {
  authority: string
  supply: Supply
  ratePct: number | null
  tender: 'cash' | 'card' | 'other'
  orders: number
  salesValueCents: number
  salesTaxCents: number
  refundValueCents: number
  refundTaxCents: number
  taxableValueCents: number
  taxCents: number
}
interface Reclass { conceptId: string; conceptSlug: string; conceptName: string; fromAccount: string; toAccount: string; amountCents: number }
interface ReclassPosted { conceptId: string; conceptName: string; month: string; reference: string; entryDate: string; fromAccount: string; toAccount: string; amountCents: number }
interface TaxPayment {
  id: string
  authority: PayKey | 'salary_tax' | 'eobi' | 'sessi'
  /** Statutory challans are listed only on request (they belong to Statutory payments). */
  kind?: 'sales_tax' | 'withholding' | 'statutory'
  periodFrom: string
  periodTo: string
  paidAt: string
  paidCents: number
  inputSetOffCents: number
  /** H13: sales tax our clients withheld (1335) set off in this payment. */
  customerWithheldSetOffCents?: number
  /** H8: federal input on raw materials (1320) set off in this payment. */
  crossSetOffCents?: number
  outputSetOffCents: number
  cprNumber: string | null
  bankAccountId: string | null
  bankAccountName: string | null
  journalEntryId: string | null
  linked: boolean
  notes: string | null
}
interface STR {
  tenantId: string
  period: { from: string; to: string }
  outputTax: { fbr: AccountTotal; srb: AccountTotal; totalCents: number }
  inputTax:  { fbr: AccountTotal; srb: AccountTotal; totalCents: number }
  taxableSalesCents: number
  /** Delivery fees (4110) booked in the period — a taxable supply of their own (H9). */
  deliveryFeesCents?: number
  taxableValueByConceptCents: Array<{ conceptSlug: string; conceptName: string; revenueCents: number; deliveryFeeCents?: number }>
  byAuthority: AuthorityReturn[]
  byRate: RateLine[]
  reclassification: Reclass[]
  reclassesPosted: ReclassPosted[]
  withholding: WithholdingReturn[]
  payments: TaxPayment[]
  netPayableCents: number
  carryForwardCents: number
  /** H8: the company's pool of federal input on food / drink stock that may be set off against a province. */
  federalCrossSetOff?: { availableCents: number; eligibleInPeriodCents: number; setOffForPeriodCents: number; claimableCents: number }
  /** Each authority's net after the claimable federal input, summed where positive. */
  netPayableAfterCrossSetOffCents?: number
  notes: string[]
}
interface Candidate { id: string; reference: string | null; description: string; entryDate: string; debitCents: number }

// 'card' is the digital tax group: Card – Keenu, Raast QR and online card
// (backend lib/pricing.ts CARD_TENDERS → the brand's card rate).
const TENDER_LABEL: Record<RateLine['tender'], string> = { cash: 'Cash', card: 'Card / Raast (digital rate)', other: 'Other' }
// The API's SUPPLY_LABEL (backend accounting/salesTaxReturn.ts).
const SUPPLY_LABEL: Record<Supply, string> = {
  standard: 'Standard-rated', custom: 'Own rate', zero_rated: 'Zero-rated', exempt: 'Exempt',
  delivery_charge: 'Delivery charges',
  // H10 (accountant, 2026-10-14): a kept no-show deposit is untaxed OTHER
  // income (4210), not a supply. Until the API stops sending these rows they
  // are shown apart from the return's rows and are never declared.
  deposit_forfeit: 'Other income, not taxable (H10)',
}
/** Rows the return declares: every supply except the H10 no-show deposits. */
const isDeclared = (r: RateLine) => r.supply !== 'deposit_forfeit'
/** The API's old H10 caveat ("No-show deposits kept are taxable…") is superseded. */
const isStaleNote = (n: string) => /no-show deposits? kept are taxable|deposit_forfeit/i.test(n)
const PAY_LABEL: Record<PayKey, string> = {
  fbr: 'FBR sales tax', srb: 'SRB',
  wht: 'Income tax withheld', stwh: 'Sales tax withheld',
}
const TABS = [
  { key: 'return', label: 'Return' },
  { key: 'withholding-rates', label: 'Withholding rates' },
  { key: 'withholding-register', label: 'Withholding register' },
] as const
type Tab = (typeof TABS)[number]['key']

// The settlement routes' codes, in words (the API's own message is the fallback).
const ERROR_TEXT: Record<string, string> = {
  NO_WITHHELD_SET_OFF: 'Withheld tax can be set off only against a sales tax authority\'s payment (FBR or SRB) — never against income tax or sales tax withheld by us. Leave "Withheld by customers set off" at 0.',
  WITHHELD_SET_OFF_TOO_LARGE: 'That is more withheld tax than our clients withheld for this authority and is still unused. Lower "Withheld by customers set off".',
  NO_INPUT_SET_OFF: 'This tax is paid in full — there is no input tax to set off against it.',
  NOTHING_PAID: 'Enter the amount paid (or the tax set off).',
  BAD_AMOUNT: 'Amounts cannot be negative.',
  PAID_IN_FUTURE: 'The payment date is in the future.',
  INVALID_DATE: 'Check the dates.',
  BAD_PERIOD: 'The period ends before it starts.',
  BANK_ACCOUNT_REQUIRED: 'This company has more than one bank — pick the bank the payment left from.',
  ALREADY_LINKED: 'That entry is already recorded as a tax payment.',
  ENTRY_REVERSED: 'That entry has been reversed — it no longer pays anything.',
  NO_ACTIVE_COMPANY: 'Pick a company first — a return is filed by one company.',
  RECLASS_ONE_MONTH: 'A reclass is for one month — pick dates inside the same month.',
  RECLASS_FUTURE_MONTH: 'That month has not started yet.',
  INPUT_SET_OFF_TOO_LARGE: 'That is more input tax than this authority\'s input account still holds. Lower "Input tax set off".',
  TAX_PAYMENT_EXISTS: 'A payment of this tax for the same period is already recorded — void it first to record it again.',
  NOT_A_TAX_PAYMENT: 'That entry is not a payment of this tax (it does not debit the tax account from a bank or cash account).',
  NOT_LINKABLE: 'Only a manual journal or a bank-reconciliation adjustment can be linked. Entries posted by sales, bills or payroll belong to their own document.',
  NOT_PROVINCIAL: 'This brand files its sales tax with FBR (2030) — there is nothing to move.',
  BAD_AUTHORITY: 'Pick which tax this payment is for.',
  WITHHELD_ALREADY_SET_OFF: 'That withheld tax has already been set off in a sales-tax payment — void or correct that payment first.',
  CROSS_SETOFF_TOO_LARGE: 'That is more federal input on raw materials than can still be claimed. Use the claimable figure shown (FBR output owed is paid from it first).',
  NO_CROSS_SET_OFF: 'Federal input on raw materials can only be set off against a provincial authority (SRB), never FBR, withholding or statutory payments.',
}
const errText = (e: unknown) => {
  const x = e as { code?: string; message?: string } | null
  return (x?.code && ERROR_TEXT[x.code]) || x?.message || 'Something went wrong'
}

/** Rupees typed → paisa. */
const toPaisa = (rupees: string) => Math.round((Number(rupees) || 0) * 100)
const rupees = (cents: number) => (cents / 100).toFixed(2)

/** Thin wrapper over the shared Modal (Escape, focus trap, scroll lock, "Discard changes?" when `dirty`). */
function Modal({ title, children, onClose, dirty }: { title: string; children: React.ReactNode; onClose: () => void; dirty?: boolean }) {
  return <SharedModal title={title} onClose={onClose} dirty={dirty}>{children}</SharedModal>
}
function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-bold uppercase tracking-wider text-s-muted mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-s-muted mt-1">{hint}</span>}
    </label>
  )
}

export default function SalesTaxReturnPage() {
  const [from, setFrom] = useState(startOfMonthPktIso())
  const [to,   setTo]   = useState(todayPktIso())
  // Who may record payments, link entries and post reclasses is the API's
  // TAX_PAYER_ROLES — the same roles as the withholding rates' `canEdit`
  // flag, so the page reads that flag instead of keeping a role list.
  const { data: rateCaps } = useQuery({
    queryKey: ['withholding-rates'],
    queryFn: () => api.get<{ canEdit: boolean }>('/accounting/withholding/rates'),
    retry: false,
    staleTime: 60_000,
    // Only a capability read: no payment buttons when it fails (the tab shows its own error).
    meta: { inlineErrors: true },
  })
  const canPay = rateCaps?.canEdit ?? false
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('return')
  // ?tab=withholding-rates (Configuration → Operations links here). Read once
  // on mount from window, so the page needs no Suspense boundary.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab')
    if (t && TABS.some((x) => x.key === t)) setTab(t as Tab)
  }, [])

  const { data, isLoading, error } = useQuery({
    queryKey: ['sales-tax-return', from, to],
    queryFn: () => api.get<STR>(`/accounting/sales-tax-return?dateFrom=${from}&dateTo=${to}`),
    enabled: tab === 'return',
  })

  // Through api.download so the request carries the session (a plain link
  // sent no Authorization header and the export came back 401).
  const [csvError, setCsvError] = useState<string | null>(null)
  async function exportCsv() {
    setCsvError(null)
    try { await api.download(`/accounting/sales-tax-return?dateFrom=${from}&dateTo=${to}&format=csv`, `sales-tax-return-${from}-${to}.csv`) }
    catch (e) { setCsvError((e as Error).message) }
  }

  const [paying, setPaying] = useState<PayTarget | null>(null)
  const [linking, setLinking] = useState(false)
  const [voiding, setVoiding] = useState<TaxPayment | null>(null)
  const [reclassMsg, setReclassMsg] = useState<Record<string, string>>({})
  const reclass = useMutation({
    mutationFn: (r: Reclass) => api.post<{ posted: boolean; amountCents: number; month: string }>('/accounting/sales-tax-return/reclass', { conceptId: r.conceptId, from, to }),
    onSuccess: (res, r) => {
      setReclassMsg((m) => ({ ...m, [r.conceptId]: res.posted ? `Posted ${fmtPkr(Math.abs(res.amountCents))} for ${res.month}` : `Nothing left to move for ${res.month}` }))
      void qc.invalidateQueries({ queryKey: ['sales-tax-return'] })
    },
    onError: (e: Error, r) => setReclassMsg((m) => ({ ...m, [r.conceptId]: errText(e) })),
  })

  // Statutory payroll challans belong to Statutory payments — never listed here
  // (the API leaves them out; this keeps it so if it ever sends one).
  const returnPayments = (data?.payments ?? []).filter((p) => p.kind !== 'statutory')
  const declaredRates = (data?.byRate ?? []).filter(isDeclared)
  const depositRows = (data?.byRate ?? []).filter((r) => !isDeclared(r))
  const notes = (data?.notes ?? []).filter((n) => !isStaleNote(n))

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
          <h1 className="text-xl font-bold text-s-text">Sales Tax Return Helper</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {tab !== 'withholding-rates' && (
            <>
              <input type="date" aria-label="From" min="2000-01-01" value={from} onChange={(e) => setFrom(e.target.value)} className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text" />
              <span className="text-s-muted text-xs">→</span>
              <input type="date" aria-label="To" min="2000-01-01" value={to} onChange={(e) => setTo(e.target.value)} className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text" />
            </>
          )}
          {tab === 'return' && <button type="button" onClick={exportCsv} className="s-btn-secondary text-sm">Export CSV</button>}
        </div>
        <nav className="w-full flex gap-1 overflow-x-auto -mb-4" role="tablist" aria-label="Sales tax return sections">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`shrink-0 px-3 py-2 text-xs font-semibold border-b-2 ${tab === t.key ? 'text-s-text' : 'border-transparent text-s-muted hover:text-s-text'}`}
              style={tab === t.key ? { borderColor: 'var(--erp-accent)' } : undefined}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="px-4 sm:px-6 py-6 max-w-4xl mx-auto space-y-4">
        {tab === 'withholding-rates' && <WithholdingRates />}
        {tab === 'withholding-register' && <WithholdingRegister from={from} to={to} />}
        {tab === 'return' && csvError && <p className="text-s-red text-sm">CSV export failed: {csvError}</p>}
        {tab === 'return' && isLoading && <p className="text-s-muted text-sm">Loading…</p>}
        {tab === 'return' && error && <p className="text-s-red text-sm">{errText(error)}</p>}
        {tab === 'return' && data && (
          <>
            <p className="text-xs text-s-muted">
              Period: {data.period.from} → {data.period.to}. This is reference data — file via FBR IRIS / provincial portal yourself.
              Output and input are what was charged and recovered in the period; tax you paid is shown separately and never lowers them.
            </p>

            {/* Output tax */}
            <div className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">Output Tax (collected from customers)</div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {[data.outputTax.fbr, data.outputTax.srb].map((r) => (
                    <tr key={r.code} className="border-t border-s-border">
                      <td className="px-4 py-2 font-mono text-xs text-s-muted w-20">{r.code}</td>
                      <td className="px-4 py-2 text-s-text">{r.name}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.totalCents)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-s-border bg-s-bg-soft font-semibold">
                  <tr><td colSpan={2} className="px-4 py-2 text-s-text">Total output</td><td className="px-4 py-2 text-right font-mono text-s-text">{fmtPkr(data.outputTax.totalCents)}</td></tr>
                </tfoot>
              </table>
              </div>
            </div>

            {/* Input tax */}
            <div className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">Input Tax (paid on supplier purchases)</div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {[data.inputTax.fbr, data.inputTax.srb].map((r) => (
                    <tr key={r.code} className="border-t border-s-border">
                      <td className="px-4 py-2 font-mono text-xs text-s-muted w-20">{r.code}</td>
                      <td className="px-4 py-2 text-s-text">{r.name}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.totalCents)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-s-border bg-s-bg-soft font-semibold">
                  <tr><td colSpan={2} className="px-4 py-2 text-s-text">Total input</td><td className="px-4 py-2 text-right font-mono text-s-text">{fmtPkr(data.inputTax.totalCents)}</td></tr>
                </tfoot>
              </table>
              </div>
            </div>

            {/* Per authority — each files its own return */}
            <div className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">
                By authority — each files its own return; one authority&apos;s input is never set off against another&apos;s output
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-s-muted">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Authority</th>
                    <th className="px-4 py-2 text-right font-medium">Output</th>
                    <th className="px-4 py-2 text-right font-medium">Input</th>
                    <th className="px-4 py-2 text-right font-medium">Net payable</th>
                    <th className="px-4 py-2 text-right font-medium">Withheld by customers (1335)</th>
                    <th className="px-4 py-2 text-right font-medium">Net after withholding</th>
                    <th className="px-4 py-2 text-right font-medium">Federal input on raw materials (H8)</th>
                    <th className="px-4 py-2 text-right font-medium">Carried forward</th>
                    <th className="px-4 py-2 text-right font-medium">Paid for this period</th>
                    <th className="px-4 py-2 text-right font-medium">Ledger balance at period end</th>
                    {canPay && <th className="px-4 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {data.byAuthority.map((a) => (
                    <tr key={a.authority} className="border-t border-s-border align-top">
                      <td className="px-4 py-2 text-s-text">
                        <div className="font-semibold">{a.authority}</div>
                        <div className="text-xs text-s-muted">{a.name}</div>
                        {a.brands.length > 0 && <div className="text-xs text-s-muted font-mono">{a.brands.join(', ')}</div>}
                        {a.otherOutputCents !== 0 && (
                          <div className="text-xs text-s-muted">Not from order sales (manual journals, B2B invoices, older entries): {fmtPkr(a.otherOutputCents)}</div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">
                        {fmtPkr(a.output.totalCents)}<div className="text-s-muted">{a.output.code}</div>
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">
                        {fmtPkr(a.input.totalCents)}<div className="text-s-muted">{a.input.code}</div>
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(Math.max(0, a.netPayableCents))}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">
                        {fmtPkr(a.withheldByCustomersCents ?? 0)}
                        {(a.customerWithheldAvailableCents ?? 0) !== 0 && <div className="text-s-muted">{fmtPkr(a.customerWithheldAvailableCents)} still to set off</div>}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs font-semibold text-s-text">{fmtPkr(Math.max(0, a.netAfterWithheldCents ?? a.netPayableCents))}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">
                        {a.key === 'fbr' ? (
                          <span className="text-s-muted">—</span>
                        ) : (
                          <>
                            {fmtPkr(a.federalInputClaimableCents ?? 0)}
                            <div className="text-s-muted">claimable against {a.authority}</div>
                            {((a.federalInputClaimableCents ?? 0) !== 0 || (a.crossSetOffForPeriodCents ?? 0) !== 0) && (
                              <div className="text-s-muted">
                                {(a.netAfterCrossSetOffCents ?? 0) >= 0
                                  ? `${fmtPkr(a.netAfterCrossSetOffCents ?? 0)} payable after it`
                                  : `${fmtPkr(-(a.netAfterCrossSetOffCents ?? 0))} carried forward after it`}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-muted">{fmtPkr(Math.max(0, -(a.netAfterWithheldCents ?? a.netPayableCents)))}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">
                        {fmtPkr(a.paidForPeriodCents)}
                        {a.inputSetOffForPeriodCents !== 0 && <div className="text-s-muted">+ input set off {fmtPkr(a.inputSetOffForPeriodCents)}</div>}
                        {(a.customerWithheldSetOffForPeriodCents ?? 0) !== 0 && <div className="text-s-muted">+ withheld set off {fmtPkr(a.customerWithheldSetOffForPeriodCents)}</div>}
                        {(a.crossSetOffForPeriodCents ?? 0) !== 0 && <div className="text-s-muted">+ federal input set off {fmtPkr(a.crossSetOffForPeriodCents ?? 0)}</div>}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">
                        {fmtPkr(a.ledgerBalanceAtEndCents)}<div className="text-s-muted">owed ({a.output.code})</div>
                        {a.inputLedgerBalanceAtEndCents !== 0 && <div className="text-s-muted">{fmtPkr(a.inputLedgerBalanceAtEndCents)} recoverable ({a.input.code})</div>}
                      </td>
                      {canPay && (
                        <td className="px-4 py-2 text-right whitespace-nowrap">
                          <button
                            type="button"
                            className="text-xs font-bold text-primary-ink hover:underline"
                            onClick={() => setPaying({
                              key: a.key,
                              inputSetOffCents: Math.max(0, Math.min(a.input.totalCents, a.output.totalCents)),
                              paidCents: Math.max(0, a.netPayableCents),
                              withheldAvailableCents: Math.max(0, a.customerWithheldAvailableCents ?? 0),
                              crossAvailableCents: a.key === 'fbr' ? 0 : Math.max(0, a.federalInputClaimableCents ?? 0),
                            })}
                          >
                            Record payment
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {data.byAuthority.length === 0 && (
                    <tr><td colSpan={canPay ? 11 : 10} className="px-4 py-3 text-xs text-s-muted">No sales tax in this period</td></tr>
                  )}
                </tbody>
              </table>
              </div>
            </div>

            {/* Tax withheld from others — paid over like sales tax */}
            <div className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">
                Tax withheld — income tax deducted from vendors (2040), sales tax withheld as an agent (2041)
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-s-muted">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Account</th>
                    <th className="px-4 py-2 text-right font-medium">Withheld in the period</th>
                    <th className="px-4 py-2 text-right font-medium">Paid for this period</th>
                    <th className="px-4 py-2 text-right font-medium">Ledger balance at period end</th>
                    {canPay && <th className="px-4 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {data.withholding.map((w) => (
                    <tr key={w.key} className="border-t border-s-border align-top">
                      <td className="px-4 py-2 text-s-text">
                        <div className="font-semibold">{w.name}</div>
                        <div className="text-xs text-s-muted font-mono">{w.account.code} {w.account.name}</div>
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(w.account.totalCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(w.paidForPeriodCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(w.ledgerBalanceAtEndCents)}</td>
                      {canPay && (
                        <td className="px-4 py-2 text-right whitespace-nowrap">
                          <button
                            type="button"
                            className="text-xs font-bold text-primary-ink hover:underline"
                            onClick={() => setPaying({ key: w.key, inputSetOffCents: 0, paidCents: Math.max(0, w.account.totalCents), withheldAvailableCents: 0, crossAvailableCents: 0 })}
                          >
                            Record payment
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>

            {/* Payments for this period */}
            <div className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-s-text">
                  Payments for this period
                  <span className="block font-normal text-s-muted">
                    Salary tax, EOBI and SESSI challans are on{' '}
                    <Link href="/accounting/statutory" className="underline">Accounting → Statutory payments</Link>, not here.
                  </span>
                </span>
                {canPay && (
                  <button type="button" className="text-xs font-bold text-primary-ink hover:underline" onClick={() => setLinking(true)}>
                    Link existing entry
                  </button>
                )}
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-s-muted">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Tax</th>
                    <th className="px-4 py-2 text-left font-medium">Period</th>
                    <th className="px-4 py-2 text-left font-medium">Paid on</th>
                    <th className="px-4 py-2 text-right font-medium">Paid</th>
                    <th className="px-4 py-2 text-right font-medium">Input set off</th>
                    <th className="px-4 py-2 text-right font-medium">Withheld set off</th>
                    <th className="px-4 py-2 text-left font-medium">CPR · from</th>
                    {canPay && <th className="px-4 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {returnPayments.map((p) => (
                    <tr key={p.id} className="border-t border-s-border align-top">
                      <td className="px-4 py-2 text-s-text">
                        <div className="font-semibold">{PAY_LABEL[p.authority as PayKey] ?? p.authority}</div>
                        <div className="text-xs text-s-muted">
                          {p.linked ? 'Linked entry' : 'Posted here'}
                          {p.journalEntryId && <> · <Link href={`/accounting/ledger?id=${p.journalEntryId}`} className="hover:underline">entry</Link></>}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-xs text-s-text whitespace-nowrap">{p.periodFrom} → {p.periodTo}</td>
                      <td className="px-4 py-2 text-xs text-s-text whitespace-nowrap">{p.paidAt}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(p.paidCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-muted">{fmtPkr(p.inputSetOffCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-muted">
                        {fmtPkr(p.customerWithheldSetOffCents ?? 0)}
                        {(p.crossSetOffCents ?? 0) !== 0 && <div>+ federal input {fmtPkr(p.crossSetOffCents ?? 0)}</div>}
                      </td>
                      <td className="px-4 py-2 text-xs text-s-muted">
                        {p.cprNumber ?? '—'}{p.bankAccountName ? ` · ${p.bankAccountName}` : ''}
                        {p.notes && <div>{p.notes}</div>}
                      </td>
                      {canPay && (
                        <td className="px-4 py-2 text-right whitespace-nowrap">
                          <button type="button" className="text-xs font-bold text-s-muted hover:text-s-text" onClick={() => setVoiding(p)}>
                            {p.linked ? 'Unlink' : 'Void'}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {returnPayments.length === 0 && (
                    <tr><td colSpan={canPay ? 8 : 7} className="px-4 py-3 text-xs text-s-muted">No tax payment recorded for a period overlapping this one</td></tr>
                  )}
                </tbody>
              </table>
              </div>
            </div>

            {/* Per rate — the brand's cash and card rates, refunds netted */}
            <div className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">By rate (cash 15% / card and Raast QR 8%; zero-rated, exempt and delivery charges on their own rows) — refunds netted</div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-s-muted">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Authority</th>
                    <th className="px-4 py-2 text-left font-medium">Supply · tender · rate</th>
                    <th className="px-4 py-2 text-right font-medium">Orders</th>
                    <th className="px-4 py-2 text-right font-medium">Sales value / tax</th>
                    <th className="px-4 py-2 text-right font-medium">Refunds value / tax</th>
                    <th className="px-4 py-2 text-right font-medium">Value to declare</th>
                    <th className="px-4 py-2 text-right font-medium">Output tax</th>
                  </tr>
                </thead>
                <tbody>
                  {declaredRates.map((r) => (
                    <tr key={`${r.authority}-${r.supply}-${r.tender}-${r.ratePct ?? 'none'}`} className="border-t border-s-border">
                      <td className="px-4 py-2 text-s-text">{r.authority}</td>
                      <td className="px-4 py-2 text-s-text">{SUPPLY_LABEL[r.supply] ?? r.supply} · {TENDER_LABEL[r.tender]} · {r.ratePct == null ? 'rate not stored' : `${r.ratePct}%`}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{r.orders}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.salesValueCents)} / {fmtPkr(r.salesTaxCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-muted">{fmtPkr(r.refundValueCents)} / {fmtPkr(r.refundTaxCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.taxableValueCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs font-semibold text-s-text">{fmtPkr(r.taxCents)}</td>
                    </tr>
                  ))}
                  {declaredRates.length === 0 && (
                    <tr><td colSpan={7} className="px-4 py-3 text-xs text-s-muted">No order sales in this period</td></tr>
                  )}
                </tbody>
              </table>
              </div>
            </div>

            {/* H10: kept no-show deposits — other income (4210), never declared */}
            {depositRows.length > 0 && (
              <div className="s-card overflow-hidden">
                <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">
                  {SUPPLY_LABEL.deposit_forfeit} — no-show deposits kept
                  <span className="block font-normal text-s-muted">
                    Not a supply: a kept deposit is other income (4210) with no sales tax. Shown for reference only — not declared on this return. Tax an older entry booked on a deposit sits in the output account above; correct it with a journal before filing.
                  </span>
                </div>
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-s-muted">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">Authority</th>
                      <th className="px-4 py-2 text-right font-medium">Deposits</th>
                      <th className="px-4 py-2 text-right font-medium">Value kept</th>
                      <th className="px-4 py-2 text-right font-medium">Tax booked on it (old rule)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {depositRows.map((r) => (
                      <tr key={`${r.authority}-${r.tender}-${r.ratePct ?? 'none'}`} className="border-t border-s-border">
                        <td className="px-4 py-2 text-s-text">{r.authority}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{r.orders}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.taxableValueCents)}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs text-s-muted">{fmtPkr(r.taxCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}

            {/* Tax still in 2030 for provincially-taxed brands */}
            {data.reclassification.length > 0 && (
              <div className="s-card overflow-hidden border-l-4 border-s-amber">
                <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">
                  To reclassify — output tax still in 2030 (FBR) for brands taxed by a province. The reclass moves the brand&apos;s whole month, dated in that month.
                </div>
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {data.reclassification.map((r) => (
                      <tr key={r.conceptId} className="border-t border-s-border align-top">
                        <td className="px-4 py-2 text-s-text">{r.conceptName} <span className="text-xs font-mono text-s-muted">{r.conceptSlug}</span></td>
                        <td className="px-4 py-2 font-mono text-xs text-s-text">
                          {r.amountCents >= 0 ? `Dr ${r.fromAccount} / Cr ${r.toAccount}` : `Dr ${r.toAccount} / Cr ${r.fromAccount} (refund)`}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(Math.abs(r.amountCents))}</td>
                        {canPay && (
                          <td className="px-4 py-2 text-right">
                            <button
                              type="button"
                              className="s-btn-primary text-xs"
                              disabled={reclass.isPending}
                              onClick={() => reclass.mutate(r)}
                            >
                              Post reclass
                            </button>
                            {reclassMsg[r.conceptId] && <div className="text-[11px] text-s-muted mt-1 max-w-[220px] ml-auto">{reclassMsg[r.conceptId]}</div>}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}
            {data.reclassesPosted.length > 0 && (
              <div className="s-card overflow-hidden">
                <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">Reclasses posted in this period</div>
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {data.reclassesPosted.map((r) => (
                      <tr key={r.reference} className="border-t border-s-border">
                        <td className="px-4 py-2 text-s-text">{r.conceptName} <span className="text-xs text-s-muted">{r.month}</span></td>
                        <td className="px-4 py-2 font-mono text-xs text-s-text">{r.fromAccount} → {r.toAccount} on {r.entryDate}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.amountCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}
            {/* After the last row is moved, its "posted" message has no row to sit on. */}
            {Object.keys(reclassMsg).length > 0 && data.reclassification.length === 0 && (
              <p className="text-xs text-s-muted">{Object.values(reclassMsg).join(' · ')}</p>
            )}

            {/* Net */}
            <div className="s-card p-4 space-y-1">
              <div className="flex justify-between gap-3 text-base font-bold">
                <span className="text-s-text">Net payable (each authority&apos;s own net, after tax our clients withheld)</span>
                <span className={data.netPayableCents > 0 ? 'text-s-red' : 'text-s-text'}>{fmtPkr(data.netPayableCents)}</span>
              </div>
              <div className="flex justify-between gap-3 text-sm">
                <span className="text-s-muted">Excess input and withheld tax carried forward (with its own authority)</span>
                <span className="font-mono text-s-text">{fmtPkr(data.carryForwardCents)}</span>
              </div>
              <p className="text-xs text-s-muted">
                Total taxable sales: {fmtPkr(data.taxableSalesCents)}
                {(data.deliveryFeesCents ?? 0) !== 0 && <> · of which delivery charges (4110): {fmtPkr(data.deliveryFeesCents ?? 0)}</>}
              </p>
            </div>

            <div className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">Taxable sales by brand — revenue and delivery charges</div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {data.taxableValueByConceptCents.map((c) => (
                    <tr key={c.conceptSlug || c.conceptName} className="border-t border-s-border align-top">
                      <td className="px-4 py-2 text-xs font-mono text-s-muted w-32">{c.conceptSlug}</td>
                      <td className="px-4 py-2 text-s-text">{c.conceptName}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">
                        {fmtPkr(c.revenueCents)}
                        {(c.deliveryFeeCents ?? 0) !== 0 && <div className="text-s-muted">+ delivery charges {fmtPkr(c.deliveryFeeCents ?? 0)}</div>}
                      </td>
                    </tr>
                  ))}
                  {data.taxableValueByConceptCents.length === 0 && (
                    <tr><td colSpan={3} className="px-4 py-3 text-xs text-s-muted">No taxable sales in this period</td></tr>
                  )}
                </tbody>
              </table>
              </div>
            </div>

            {notes.length > 0 && (
              <div className="s-card p-4 border-l-4 border-s-amber">
                <p className="text-xs font-semibold text-s-amber mb-1">Caveats — read before filing</p>
                <ul className="text-xs text-s-text space-y-1 list-disc list-inside">
                  {notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </div>
            )}

            {paying && <PayModal report={data} target={paying} onClose={() => setPaying(null)} />}
            {linking && <LinkModal report={data} onClose={() => setLinking(false)} />}
            {voiding && <VoidModal payment={voiding} onClose={() => setVoiding(null)} />}
          </>
        )}
      </div>
    </div>
  )
}

interface PayTarget { key: PayKey; paidCents: number; inputSetOffCents: number; withheldAvailableCents: number; crossAvailableCents: number }
/** H8: federal input on raw materials is set off against the provincial authorities only. */
const PROVINCIAL: ReadonlySet<PayKey> = new Set<PayKey>(['srb'])

function PayModal({ report, target, onClose }: { report: STR; target: PayTarget; onClose: () => void }) {
  const qc = useQueryClient()
  const salesTax = target.key !== 'wht' && target.key !== 'stwh'
  const provincial = PROVINCIAL.has(target.key)
  const [f, setF] = useState({
    periodFrom: report.period.from, periodTo: report.period.to,
    paid: rupees(target.paidCents), input: rupees(target.inputSetOffCents), withheld: '0', cross: '0',
    paidAt: todayPktIso(), method: 'bank_transfer', bankAccountId: '', cprNumber: '', notes: '',
  })
  const [err, setErr] = useState('')
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }))
  const go = useMutation({
    mutationFn: () => api.post('/accounting/sales-tax-return/payments', {
      authority: target.key,
      periodFrom: f.periodFrom, periodTo: f.periodTo,
      paidCents: toPaisa(f.paid),
      inputSetOffCents: salesTax ? toPaisa(f.input) : 0,
      // H13: only a sales-tax authority takes it (422 NO_WITHHELD_SET_OFF otherwise).
      customerWithheldSetOffCents: salesTax ? toPaisa(f.withheld) : 0,
      // H8: provincial authorities only (422 NO_CROSS_SET_OFF otherwise).
      crossSetOffCents: provincial ? toPaisa(f.cross) : 0,
      paidAt: f.paidAt,
      method: f.method,
      bankAccountId: f.method === 'cash' ? null : (f.bankAccountId || null),
      cprNumber: f.cprNumber || null,
      notes: f.notes || null,
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['sales-tax-return'] }); onClose() },
    onError: (e: Error) => setErr(errText(e)),
  })
  const settled = toPaisa(f.paid) + (salesTax ? toPaisa(f.input) + toPaisa(f.withheld) : 0) + (provincial ? toPaisa(f.cross) : 0)
  return (
    <Modal title={`Record payment — ${PAY_LABEL[target.key]}`} onClose={onClose} dirty={!go.isPending && (f.paid !== rupees(target.paidCents) || f.input !== rupees(target.inputSetOffCents) || f.withheld !== '0' || f.cross !== '0' || !!f.cprNumber.trim() || !!f.notes.trim())}>
      <DialogForm busy={go.isPending} onSubmit={() => go.mutate()}
        missing={settled <= 0 ? 'Enter an amount: what was paid, or what is set off.' : !f.paidAt ? 'Pick the day it was paid.' : !f.periodFrom || !f.periodTo ? 'Pick the period the payment covers.' : null}>
      <p className="text-xs text-s-muted mb-3">
        Posts the payment in the books on the day it was paid. It settles the tax owed; it never lowers the output of any period.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Period from"><input type="date" className="s-input" min="2000-01-01" value={f.periodFrom} onChange={set('periodFrom')} aria-invalid={!f.periodFrom ? true : undefined} /></Field>
        <Field label="Period to"><input type="date" className="s-input" min="2000-01-01" value={f.periodTo} onChange={set('periodTo')} aria-invalid={!f.periodTo ? true : undefined} /></Field>
        <Field label="Paid (PKR)"><RupeeField label="Paid (PKR)" value={f.paid} onChange={(v) => setF((p) => ({ ...p, paid: v }))} invalid={settled <= 0} /></Field>
        {salesTax && (
          <Field label="Input tax set off (PKR)" hint="Recoverable input of the same authority, used against this output.">
            <RupeeField label="Input tax set off (PKR)" value={f.input} onChange={(v) => setF((p) => ({ ...p, input: v }))} />
          </Field>
        )}
        {salesTax && (
          <Field
            label="Withheld by customers set off (PKR)"
            hint={target.withheldAvailableCents > 0
              ? `Sales tax our clients withheld for ${PAY_LABEL[target.key]} (1335) and not yet used: ${fmtPkr(target.withheldAvailableCents)} at the period's end.`
              : `No tax our clients withheld for ${PAY_LABEL[target.key]} is waiting to be set off.`}
          >
            <div className="flex gap-2">
              <div className="flex-1 min-w-0"><RupeeField label="Withheld by customers set off (PKR)" value={f.withheld} onChange={(v) => setF((p) => ({ ...p, withheld: v }))} /></div>
              {target.withheldAvailableCents > 0 && (
                <button type="button" className="s-btn-secondary text-xs shrink-0" onClick={() => setF((p) => ({ ...p, withheld: rupees(target.withheldAvailableCents) }))}>
                  Use all
                </button>
              )}
            </div>
          </Field>
        )}
        {provincial && (
          <Field
            label="Federal input on raw materials set off (PKR)"
            hint={target.crossAvailableCents > 0
              ? `FBR input tax on food and drink stock that can be claimed against ${PAY_LABEL[target.key]} (H8): ${fmtPkr(target.crossAvailableCents)}.`
              : `No federal input on raw materials is claimable against ${PAY_LABEL[target.key]} right now.`}
          >
            <div className="flex gap-2">
              <div className="flex-1 min-w-0"><RupeeField label="Federal input on raw materials set off (PKR)" value={f.cross} onChange={(v) => setF((p) => ({ ...p, cross: v }))} /></div>
              {target.crossAvailableCents > 0 && (
                <button type="button" className="s-btn-secondary text-xs shrink-0" onClick={() => setF((p) => ({ ...p, cross: rupees(target.crossAvailableCents) }))}>
                  Use all
                </button>
              )}
            </div>
          </Field>
        )}
        <Field label="Paid on"><input type="date" className="s-input" min="2000-01-01" value={f.paidAt} max={todayPktIso()} onChange={set('paidAt')} aria-invalid={!f.paidAt ? true : undefined} /></Field>
        <Field label="How">
          <Select className="s-input" value={f.method} onChange={set('method')}>
            <option value="bank_transfer">Bank transfer / e-payment</option>
            <option value="cheque">Cheque</option>
            <option value="online">Online banking</option>
            <option value="cash">Cash at the bank counter</option>
          </Select>
        </Field>
        {f.method !== 'cash' && (
          <div className="sm:col-span-2">
            <BankAccountSelect tenantId={report.tenantId} value={f.bankAccountId} onChange={(v) => setF((p) => ({ ...p, bankAccountId: v }))} className="s-input" label="Paid from" />
          </div>
        )}
        <Field label="CPR / challan number"><input className="s-input" value={f.cprNumber} onChange={set('cprNumber')} /></Field>
        <Field label="Notes"><input className="s-input" value={f.notes} onChange={set('notes')} /></Field>
      </div>
      <p className="text-sm text-s-muted mt-3">Settles <strong className="text-s-text">{fmtPkr(settled)}</strong> of tax owed.</p>
      {err && <p role="alert" className="text-xs text-s-red mt-2">{err}</p>}
      <div className="flex flex-wrap gap-2 mt-5">
        <button type="submit" className="s-btn-primary text-sm" disabled={go.isPending}>
          {go.isPending ? 'Saving…' : 'Record payment'}
        </button>
        <button type="button" className="s-btn-secondary text-sm" onClick={onClose}>Cancel</button>
      </div>
      </DialogForm>
    </Modal>
  )
}

function LinkModal({ report, onClose }: { report: STR; onClose: () => void }) {
  const qc = useQueryClient()
  const [authority, setAuthority] = useState<PayKey>('srb')
  const [periodFrom, setPeriodFrom] = useState(report.period.from)
  const [periodTo, setPeriodTo] = useState(report.period.to)
  const [entryId, setEntryId] = useState('')
  const [cprNumber, setCpr] = useState('')
  const [err, setErr] = useState('')
  const { data: cands, isLoading } = useQuery({
    queryKey: ['sales-tax-return', 'link-candidates', authority],
    queryFn: () => api.get<{ entries: Candidate[] }>(`/accounting/sales-tax-return/payments/candidates?authority=${authority}`),
  })
  const go = useMutation({
    mutationFn: () => api.post('/accounting/sales-tax-return/payments/link', {
      journalEntryId: entryId.trim(), authority, periodFrom, periodTo, cprNumber: cprNumber || null,
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['sales-tax-return'] }); onClose() },
    onError: (e: Error) => setErr(errText(e)),
  })
  return (
    <Modal title="Link an entry already posted" onClose={onClose} dirty={!go.isPending && (!!entryId || !!cprNumber.trim())}>
      <DialogForm busy={go.isPending} onSubmit={() => go.mutate()} missing={!entryId ? 'Pick the entry to link.' : !periodFrom || !periodTo ? 'Pick the period it covers.' : null}>
      <p className="text-xs text-s-muted mb-3">
        A tax payment you already posted as a manual journal or a bank-reconciliation adjustment. It is recorded as this period&apos;s payment — nothing is posted again.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Tax">
          <Select className="s-input" value={authority} onChange={(e) => { setAuthority(e.target.value as PayKey); setEntryId('') }}>
            {(Object.keys(PAY_LABEL) as PayKey[]).map((k) => <option key={k} value={k}>{PAY_LABEL[k]}</option>)}
          </Select>
        </Field>
        <Field label="CPR / challan number"><input className="s-input" value={cprNumber} onChange={(e) => setCpr(e.target.value)} /></Field>
        <Field label="Period from"><input type="date" className="s-input" min="2000-01-01" value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)} aria-invalid={!periodFrom ? true : undefined} /></Field>
        <Field label="Period to"><input type="date" className="s-input" min="2000-01-01" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} aria-invalid={!periodTo ? true : undefined} /></Field>
      </div>
      <p className="text-[11px] font-bold uppercase tracking-wider text-s-muted mt-4 mb-1">Entry</p>
      <div className="max-h-56 overflow-y-auto rounded border border-s-border">
        {isLoading && <p className="px-3 py-2 text-xs text-s-muted">Loading…</p>}
        {cands && cands.entries.length === 0 && <p className="px-3 py-2 text-xs text-s-muted">No unlinked manual or reconciliation entry pays this tax in the last 400 days.</p>}
        {cands?.entries.map((c) => (
          <label key={c.id} className="flex items-start gap-2 px-3 py-2 border-t border-s-border first:border-t-0 cursor-pointer">
            <input type="radio" name="entry" className="mt-1" checked={entryId === c.id} onChange={() => setEntryId(c.id)} />
            <span className="flex-1 min-w-0">
              <span className="block text-sm text-s-text truncate">{c.description}</span>
              <span className="block text-[11px] text-s-muted">{c.entryDate} · {fmtPkr(c.debitCents)}</span>
            </span>
          </label>
        ))}
      </div>
      {err && <p role="alert" className="text-xs text-s-red mt-2">{err}</p>}
      <div className="flex flex-wrap gap-2 mt-5">
        <button type="submit" className="s-btn-primary text-sm" disabled={go.isPending}>
          {go.isPending ? 'Linking…' : 'Link as payment'}
        </button>
        <button type="button" className="s-btn-secondary text-sm" onClick={onClose}>Cancel</button>
      </div>
      </DialogForm>
    </Modal>
  )
}

function VoidModal({ payment, onClose }: { payment: TaxPayment; onClose: () => void }) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const go = useMutation({
    mutationFn: () => api.post(`/accounting/sales-tax-return/payments/${payment.id}/void`, { reason }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['sales-tax-return'] }); onClose() },
    onError: (e: Error) => setErr(errText(e)),
  })
  return (
    <Modal title={payment.linked ? 'Unlink this payment' : 'Void this payment'} onClose={onClose} dirty={!go.isPending && !!reason.trim()}>
      <DialogForm busy={go.isPending} onSubmit={() => go.mutate()} missing={reason.trim().length < 5 ? 'Give a reason (5 characters or more).' : null}>
      <p className="text-sm text-s-muted">
        {payment.linked
          ? 'The entry stays in the ledger as it was posted; it is no longer recorded as this period\'s payment.'
          : `The payment of ${fmtPkr(payment.paidCents)} is reversed in the ledger today. You can then record it again.`}
      </p>
      <div className="mt-4"><Field label="Reason"><input className="s-input" value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={reason.trim().length < 5 ? true : undefined} placeholder="Wrong amount typed" /></Field></div>
      {err && <p role="alert" className="text-xs text-s-red mt-2">{err}</p>}
      <div className="flex flex-wrap gap-2 mt-5">
        <button type="submit" className="s-btn-danger text-sm" disabled={go.isPending}>
          {go.isPending ? 'Saving…' : payment.linked ? 'Unlink' : 'Void payment'}
        </button>
        <button type="button" className="s-btn-secondary text-sm" onClick={onClose}>Cancel</button>
      </div>
      </DialogForm>
    </Modal>
  )
}
