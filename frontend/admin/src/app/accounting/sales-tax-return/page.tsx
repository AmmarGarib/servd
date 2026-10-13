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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso, startOfMonthPktIso } from '../../../lib/money'
import { useAuthStore } from '../../../store/auth'
import { BankAccountSelect } from '../../../components/finance/BankAccountSelect'
import Link from 'next/link'

interface AccountTotal { code: string; name: string; totalCents: number }
type AuthorityKey = 'fbr' | 'pra' | 'srb' | 'kpra' | 'bra'
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
  ledgerBalanceAtEndCents: number
  inputLedgerBalanceAtEndCents: number
}
interface WithholdingReturn {
  key: WithholdingKey
  authority: string
  name: string
  account: AccountTotal
  paidForPeriodCents: number
  ledgerBalanceAtEndCents: number
}
type Supply = 'standard' | 'zero_rated' | 'exempt' | 'custom'
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
  authority: PayKey
  periodFrom: string
  periodTo: string
  paidAt: string
  paidCents: number
  inputSetOffCents: number
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
  outputTax: { fbr: AccountTotal; pra: AccountTotal; srb: AccountTotal; kpra: AccountTotal; bra: AccountTotal; totalCents: number }
  inputTax:  { fbr: AccountTotal; pra: AccountTotal; srb: AccountTotal; kpra: AccountTotal; bra: AccountTotal; totalCents: number }
  taxableSalesCents: number
  taxableValueByConceptCents: Array<{ conceptSlug: string; conceptName: string; revenueCents: number }>
  byAuthority: AuthorityReturn[]
  byRate: RateLine[]
  reclassification: Reclass[]
  reclassesPosted: ReclassPosted[]
  withholding: WithholdingReturn[]
  payments: TaxPayment[]
  netPayableCents: number
  carryForwardCents: number
  notes: string[]
}
interface Candidate { id: string; reference: string | null; description: string; entryDate: string; debitCents: number }

// 'card' is the digital tax group: Card – Keenu, Raast QR and online card
// (backend lib/pricing.ts CARD_TENDERS → the brand's card rate).
const TENDER_LABEL: Record<RateLine['tender'], string> = { cash: 'Cash', card: 'Card / Raast (digital rate)', other: 'Other' }
const SUPPLY_LABEL: Record<Supply, string> = { standard: 'Standard', custom: 'Own rate', zero_rated: 'Zero-rated', exempt: 'Exempt' }
const PAY_LABEL: Record<PayKey, string> = {
  fbr: 'FBR sales tax', pra: 'PRA', srb: 'SRB', kpra: 'KPRA', bra: 'BRA',
  wht: 'Income tax withheld', stwh: 'Sales tax withheld',
}
// Who may record payments, link entries and post reclasses (backend TAX_PAYERS).
const TAX_PAYERS = ['admin', 'finance']

/** Rupees typed → paisa. */
const toPaisa = (rupees: string) => Math.round((Number(rupees) || 0) * 100)
const rupees = (cents: number) => (cents / 100).toFixed(2)

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4" onClick={onClose}>
      <div className="s-card w-full max-w-lg p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <p className="text-lg font-bold text-s-text mb-4">{title}</p>
        {children}
      </div>
    </div>
  )
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
  const canPay = useAuthStore((s) => s.isRole(...TAX_PAYERS))
  const qc = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: ['sales-tax-return', from, to],
    queryFn: () => api.get<STR>(`/accounting/sales-tax-return?dateFrom=${from}&dateTo=${to}`),
  })

  // Through api.download so the request carries the session (a plain link
  // sent no Authorization header and the export came back 401).
  const [csvError, setCsvError] = useState<string | null>(null)
  async function exportCsv() {
    setCsvError(null)
    try { await api.download(`/accounting/sales-tax-return?dateFrom=${from}&dateTo=${to}&format=csv`, `sales-tax-return-${from}-${to}.csv`) }
    catch (e) { setCsvError((e as Error).message) }
  }

  const [paying, setPaying] = useState<{ key: PayKey; paidCents: number; inputSetOffCents: number } | null>(null)
  const [linking, setLinking] = useState(false)
  const [voiding, setVoiding] = useState<TaxPayment | null>(null)
  const [reclassMsg, setReclassMsg] = useState<Record<string, string>>({})
  const reclass = useMutation({
    mutationFn: (r: Reclass) => api.post<{ posted: boolean; amountCents: number; month: string }>('/accounting/sales-tax-return/reclass', { conceptId: r.conceptId, from, to }),
    onSuccess: (res, r) => {
      setReclassMsg((m) => ({ ...m, [r.conceptId]: res.posted ? `Posted ${fmtPkr(Math.abs(res.amountCents))} for ${res.month}` : `Nothing left to move for ${res.month}` }))
      void qc.invalidateQueries({ queryKey: ['sales-tax-return'] })
    },
    onError: (e: Error, r) => setReclassMsg((m) => ({ ...m, [r.conceptId]: e.message })),
  })

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
          <h1 className="text-xl font-bold text-s-text">Sales Tax Return Helper</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text" />
          <span className="text-s-muted text-xs">→</span>
          <input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text" />
          <button type="button" onClick={exportCsv} className="s-btn-secondary text-sm">Export CSV</button>
        </div>
      </header>

      <div className="px-4 sm:px-6 py-6 max-w-4xl mx-auto space-y-4">
        {csvError && <p className="text-s-red text-sm">CSV export failed: {csvError}</p>}
        {isLoading && <p className="text-s-muted text-sm">Loading…</p>}
        {error && <p className="text-s-red text-sm">{(error as Error).message}</p>}
        {data && (
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
                  {[data.outputTax.fbr, data.outputTax.pra, data.outputTax.srb, data.outputTax.kpra, data.outputTax.bra].map((r) => (
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
                  {[data.inputTax.fbr, data.inputTax.pra, data.inputTax.srb, data.inputTax.kpra, data.inputTax.bra].map((r) => (
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
                      <td className="px-4 py-2 text-right font-mono text-xs font-semibold text-s-text">{fmtPkr(Math.max(0, a.netPayableCents))}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-muted">{fmtPkr(Math.max(0, -a.netPayableCents))}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">
                        {fmtPkr(a.paidForPeriodCents)}
                        {a.inputSetOffForPeriodCents !== 0 && <div className="text-s-muted">+ input set off {fmtPkr(a.inputSetOffForPeriodCents)}</div>}
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
                            })}
                          >
                            Record payment
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {data.byAuthority.length === 0 && (
                    <tr><td colSpan={canPay ? 8 : 7} className="px-4 py-3 text-xs text-s-muted">No sales tax in this period</td></tr>
                  )}
                </tbody>
              </table>
              </div>
            </div>

            {/* Tax withheld from others — paid over like sales tax */}
            <div className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">
                Tax withheld — income tax deducted from suppliers and salaries (2040), sales tax withheld as an agent (2041)
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
                            onClick={() => setPaying({ key: w.key, inputSetOffCents: 0, paidCents: Math.max(0, w.account.totalCents) })}
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
                <span className="text-xs font-semibold text-s-text">Payments for this period</span>
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
                    <th className="px-4 py-2 text-left font-medium">CPR · from</th>
                    {canPay && <th className="px-4 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {data.payments.map((p) => (
                    <tr key={p.id} className="border-t border-s-border align-top">
                      <td className="px-4 py-2 text-s-text">
                        <div className="font-semibold">{PAY_LABEL[p.authority] ?? p.authority}</div>
                        <div className="text-xs text-s-muted">
                          {p.linked ? 'Linked entry' : 'Posted here'}
                          {p.journalEntryId && <> · <Link href={`/accounting/ledger?id=${p.journalEntryId}`} className="hover:underline">entry</Link></>}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-xs text-s-text whitespace-nowrap">{p.periodFrom} → {p.periodTo}</td>
                      <td className="px-4 py-2 text-xs text-s-text whitespace-nowrap">{p.paidAt}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(p.paidCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-muted">{fmtPkr(p.inputSetOffCents)}</td>
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
                  {data.payments.length === 0 && (
                    <tr><td colSpan={canPay ? 7 : 6} className="px-4 py-3 text-xs text-s-muted">No tax payment recorded for a period overlapping this one</td></tr>
                  )}
                </tbody>
              </table>
              </div>
            </div>

            {/* Per rate — the brand's cash and card rates, refunds netted */}
            <div className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">By rate (cash 15% / card and Raast QR 8%; zero-rated and exempt lines on their own rows) — refunds netted</div>
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
                  {data.byRate.map((r) => (
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
                  {data.byRate.length === 0 && (
                    <tr><td colSpan={7} className="px-4 py-3 text-xs text-s-muted">No order sales in this period</td></tr>
                  )}
                </tbody>
              </table>
              </div>
            </div>

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
                <span className="text-s-text">Net payable (each authority&apos;s own net)</span>
                <span className={data.netPayableCents > 0 ? 'text-s-red' : 'text-s-text'}>{fmtPkr(data.netPayableCents)}</span>
              </div>
              <div className="flex justify-between gap-3 text-sm">
                <span className="text-s-muted">Excess input carried forward (with its own authority)</span>
                <span className="font-mono text-s-text">{fmtPkr(data.carryForwardCents)}</span>
              </div>
              <p className="text-xs text-s-muted">Total taxable sales: {fmtPkr(data.taxableSalesCents)}</p>
            </div>

            <div className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">Taxable Sales by Concept</div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {data.taxableValueByConceptCents.map((c) => (
                    <tr key={c.conceptSlug} className="border-t border-s-border">
                      <td className="px-4 py-2 text-xs font-mono text-s-muted w-32">{c.conceptSlug}</td>
                      <td className="px-4 py-2 text-s-text">{c.conceptName}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(c.revenueCents)}</td>
                    </tr>
                  ))}
                  {data.taxableValueByConceptCents.length === 0 && (
                    <tr><td colSpan={3} className="px-4 py-3 text-xs text-s-muted">No taxable sales in this period</td></tr>
                  )}
                </tbody>
              </table>
              </div>
            </div>

            {data.notes.length > 0 && (
              <div className="s-card p-4 border-l-4 border-s-amber">
                <p className="text-xs font-semibold text-s-amber mb-1">Caveats — read before filing</p>
                <ul className="text-xs text-s-text space-y-1 list-disc list-inside">
                  {data.notes.map((n, i) => <li key={i}>{n}</li>)}
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

function PayModal({ report, target, onClose }: { report: STR; target: { key: PayKey; paidCents: number; inputSetOffCents: number }; onClose: () => void }) {
  const qc = useQueryClient()
  const salesTax = target.key !== 'wht' && target.key !== 'stwh'
  const [f, setF] = useState({
    periodFrom: report.period.from, periodTo: report.period.to,
    paid: rupees(target.paidCents), input: rupees(target.inputSetOffCents),
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
      paidAt: f.paidAt,
      method: f.method,
      bankAccountId: f.method === 'cash' ? null : (f.bankAccountId || null),
      cprNumber: f.cprNumber || null,
      notes: f.notes || null,
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['sales-tax-return'] }); onClose() },
    onError: (e: Error) => setErr(e.message),
  })
  const settled = toPaisa(f.paid) + (salesTax ? toPaisa(f.input) : 0)
  return (
    <Modal title={`Record payment — ${PAY_LABEL[target.key]}`} onClose={onClose}>
      <p className="text-xs text-s-muted mb-3">
        Posts the payment in the books on the day it was paid. It settles the tax owed; it never lowers the output of any period.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Period from"><input type="date" className="s-input" value={f.periodFrom} onChange={set('periodFrom')} /></Field>
        <Field label="Period to"><input type="date" className="s-input" value={f.periodTo} onChange={set('periodTo')} /></Field>
        <Field label="Paid (PKR)"><input type="number" min={0} step="0.01" inputMode="decimal" className="s-input" value={f.paid} onChange={set('paid')} /></Field>
        {salesTax && (
          <Field label="Input tax set off (PKR)" hint="Recoverable input of the same authority, used against this output.">
            <input type="number" min={0} step="0.01" inputMode="decimal" className="s-input" value={f.input} onChange={set('input')} />
          </Field>
        )}
        <Field label="Paid on"><input type="date" className="s-input" value={f.paidAt} max={todayPktIso()} onChange={set('paidAt')} /></Field>
        <Field label="How">
          <select className="s-input" value={f.method} onChange={set('method')}>
            <option value="bank_transfer">Bank transfer / e-payment</option>
            <option value="cheque">Cheque</option>
            <option value="online">Online banking</option>
            <option value="cash">Cash at the bank counter</option>
          </select>
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
      {err && <p className="text-xs text-s-red mt-2">{err}</p>}
      <div className="flex flex-wrap gap-2 mt-5">
        <button type="button" className="s-btn-primary text-sm" disabled={go.isPending || settled <= 0 || !f.paidAt} onClick={() => go.mutate()}>
          {go.isPending ? 'Saving…' : 'Record payment'}
        </button>
        <button type="button" className="s-btn-secondary text-sm" onClick={onClose}>Cancel</button>
      </div>
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
    onError: (e: Error) => setErr(e.message),
  })
  return (
    <Modal title="Link an entry already posted" onClose={onClose}>
      <p className="text-xs text-s-muted mb-3">
        A tax payment you already posted as a manual journal or a bank-reconciliation adjustment. It is recorded as this period&apos;s payment — nothing is posted again.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Tax">
          <select className="s-input" value={authority} onChange={(e) => { setAuthority(e.target.value as PayKey); setEntryId('') }}>
            {(Object.keys(PAY_LABEL) as PayKey[]).map((k) => <option key={k} value={k}>{PAY_LABEL[k]}</option>)}
          </select>
        </Field>
        <Field label="CPR / challan number"><input className="s-input" value={cprNumber} onChange={(e) => setCpr(e.target.value)} /></Field>
        <Field label="Period from"><input type="date" className="s-input" value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)} /></Field>
        <Field label="Period to"><input type="date" className="s-input" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} /></Field>
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
      {err && <p className="text-xs text-s-red mt-2">{err}</p>}
      <div className="flex flex-wrap gap-2 mt-5">
        <button type="button" className="s-btn-primary text-sm" disabled={go.isPending || !entryId} onClick={() => go.mutate()}>
          {go.isPending ? 'Linking…' : 'Link as payment'}
        </button>
        <button type="button" className="s-btn-secondary text-sm" onClick={onClose}>Cancel</button>
      </div>
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
    onError: (e: Error) => setErr(e.message),
  })
  return (
    <Modal title={payment.linked ? 'Unlink this payment' : 'Void this payment'} onClose={onClose}>
      <p className="text-sm text-s-muted">
        {payment.linked
          ? 'The entry stays in the ledger as it was posted; it is no longer recorded as this period\'s payment.'
          : `The payment of ${fmtPkr(payment.paidCents)} is reversed in the ledger today. You can then record it again.`}
      </p>
      <div className="mt-4"><Field label="Reason"><input className="s-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Wrong amount typed" /></Field></div>
      {err && <p className="text-xs text-s-red mt-2">{err}</p>}
      <div className="flex flex-wrap gap-2 mt-5">
        <button type="button" className="s-btn-danger text-sm" disabled={go.isPending || reason.trim().length < 5} onClick={() => go.mutate()}>
          {go.isPending ? 'Saving…' : payment.linked ? 'Unlink' : 'Void payment'}
        </button>
        <button type="button" className="s-btn-secondary text-sm" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  )
}
