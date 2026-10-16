'use client'
// Statutory payments — what payroll owes the authorities (salary tax s.149 on
// 2042, EOBI on 2043, SESSI / PESSI on 2044) and what was paid, month by
// month (finance wave B, H7). The figures come from ONE server computation
// (GET /accounting/statutory); this page computes nothing.
//   • Record payment — a month's challan, through the tax payments register
//     (POST /accounting/sales-tax-return/payments): Dr the payable / Cr the bank.
//   • Link existing entry — a challan already posted by hand (manual journal or
//     bank-reconciliation adjustment) is recorded without posting again.
//   • Void — a challan recorded in error is reversed today (a linked one is
//     unlinked).
//   • The one-time reclass — what payroll booked to 2090 / 2040 before these
//     payables existed moves to them once (POST /accounting/statutory/reclass).
// Who may record / post comes from the server (canPay / canPost).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso } from '../../../lib/money'
import { BankAccountSelect } from '../../../components/finance/BankAccountSelect'
import { Select } from '@/components/ui/Select'
import { Modal as SharedModal } from '../../../components/ui/Modal'
import { DialogForm, RupeeField } from '../../../components/finance/PaymentReceivedFields'

type SchemeKey = 'salary_tax' | 'eobi' | 'sessi'
const SCHEMES: SchemeKey[] = ['salary_tax', 'eobi', 'sessi']

interface PaymentRef {
  id: string
  paidAt: string
  paidCents: number
  cprNumber: string | null
  linked: boolean
  journalEntryId: string | null
  bankAccountId: string | null
}
interface Cell {
  key: SchemeKey
  account: string
  accruedCents: number
  legacyAccruedCents: number
  reclassCents: number
  paidCents: number
  owedCents: number
  overpaid: boolean
  cleared: boolean
  payments: PaymentRef[]
  balanceAtMonthEndCents: number
}
type Month = { month: string } & Record<SchemeKey, Cell>
interface Summary {
  tenantId: string
  from: string
  to: string
  schemes: Array<{ key: SchemeKey; label: string; name: string; account: string }>
  months: Month[]
  totals: Record<SchemeKey, { accruedCents: number; legacyAccruedCents: number; reclassCents: number; paidCents: number; owedCents: number }>
  legacyHrChallans: Array<{ id: string; scheme: string | null; month: string | null; amountCents: number; paidOn: string | null; challanNo: string | null; status: string }>
  reclass: { entryId: string; entryDate: string } | null
  canPay: boolean
}
interface Amounts { eobiCents: number; sessiCents: number; salaryTaxCents: number }
interface Preview {
  tenantId: string
  done: ({ entryId: string; entryDate: string } & Amounts) | null
  hrSourced: Amounts
  balances: { accruedExpenses2090Cents: number; withholding2040Cents: number }
  suggested: Amounts
  afterReclass: Amounts
  entries: Array<{ entryId: string; reference: string; entryDate: string; kind: string; reversal: boolean; eobiCents: number; sessiCents: number; salaryTaxCents: number; basis: 'exact' | 'pro_rata' | 'estimated' }>
  manualDebits: Array<{ entryId: string; reference: string; entryDate: string; description: string; accountCode: string; debitCents: number; kind: string }>
  canPost: boolean
}
interface Candidate { id: string; reference: string | null; description: string; entryDate: string; debitCents: number }

/** Rupees typed → paisa. */
const toPaisa = (rupees: string) => Math.round((Number(rupees) || 0) * 100)
const rupees = (cents: number) => (cents / 100).toFixed(2)
const thisMonth = () => todayPktIso().slice(0, 7)
function monthsBack(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const idx = y * 12 + (m - 1) - n
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
}
const total = (a: Amounts) => a.eobiCents + a.sessiCents + a.salaryTaxCents

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

export default function StatutoryPaymentsPage() {
  const [to, setTo] = useState(thisMonth())
  const [from, setFrom] = useState(monthsBack(thisMonth(), 5))
  const qc = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: ['statutory', from, to],
    queryFn: () => api.get<Summary>(`/accounting/statutory?from=${from}&to=${to}`),
    enabled: /^\d{4}-\d{2}$/.test(from) && /^\d{4}-\d{2}$/.test(to),
  })
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['statutory'] }) }

  const [paying, setPaying] = useState<{ key: SchemeKey; month: string; owedCents: number; topUp?: boolean } | null>(null)
  const [linking, setLinking] = useState<{ key: SchemeKey; month: string } | null>(null)
  const [voiding, setVoiding] = useState<{ label: string; payment: PaymentRef } | null>(null)

  const labelOf = (k: SchemeKey) => data?.schemes.find((s) => s.key === k)?.label ?? k

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
          <p className="text-[11px] font-bold uppercase tracking-wider text-success">Payroll taxes</p>
          <h1 className="text-xl font-bold text-s-text">Statutory payments</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input type="month" aria-label="From month" value={from} onChange={(e) => setFrom(e.target.value)} className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text" />
          <span className="text-s-muted text-xs">→</span>
          <input type="month" aria-label="To month" value={to} onChange={(e) => setTo(e.target.value)} className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text" />
        </div>
      </header>

      <div className="px-4 sm:px-6 py-6 max-w-4xl mx-auto space-y-4">
        <p className="text-xs text-s-muted">
          What payroll and full &amp; final settlements accrued for salary tax, EOBI and SESSI / PESSI each month, and the challans paid for it.
          A month that still owes after its challan takes a top-up challan (its own CPR number). Amounts payroll booked to 2090 / 2040 before these accounts existed show as
          &quot;booked before the split&quot; until the one-time reclass below moves them.
        </p>
        {isLoading && <p className="text-s-muted text-sm">Loading…</p>}
        {error && <p className="text-s-red text-sm">{(error as Error).message}</p>}

        {data && SCHEMES.map((key) => {
          const scheme = data.schemes.find((s) => s.key === key)!
          const t = data.totals[key]
          return (
            <section key={key} className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="text-sm font-semibold text-s-text">{scheme.label}</span>
                  <span className="text-xs text-s-muted"> · {scheme.name} · <span className="font-mono">{scheme.account}</span></span>
                </div>
                {data.canPay && (
                  <button type="button" className="text-xs font-bold text-primary-ink hover:underline" onClick={() => setLinking({ key, month: data.to })}>
                    Link existing entry
                  </button>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-s-muted">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">Month</th>
                      <th className="px-4 py-2 text-right font-medium">Accrued</th>
                      <th className="px-4 py-2 text-right font-medium">Paid</th>
                      <th className="px-4 py-2 text-right font-medium">Owed</th>
                      <th className="px-4 py-2 text-left font-medium">Challan</th>
                      {data.canPay && <th className="px-4 py-2" />}
                    </tr>
                  </thead>
                  <tbody>
                    {data.months.map((m) => {
                      const c = m[key]
                      const accrued = c.accruedCents + c.legacyAccruedCents
                      return (
                        <tr key={m.month} className="border-t border-s-border align-top">
                          <td className="px-4 py-2 text-s-text whitespace-nowrap">
                            {m.month}
                            <div className="text-[11px] text-s-muted">Balance at month end {fmtPkr(c.balanceAtMonthEndCents)}</div>
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-xs text-s-text">
                            {fmtPkr(accrued)}
                            {c.legacyAccruedCents !== 0 && <div className="text-s-muted">{fmtPkr(c.legacyAccruedCents)} booked before the split</div>}
                            {c.reclassCents !== 0 && <div className="text-s-muted">+ reclass {fmtPkr(c.reclassCents)}</div>}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(c.paidCents)}</td>
                          <td className="px-4 py-2 text-right font-mono text-xs">
                            {c.cleared
                              ? <span className="s-badge-green">Cleared</span>
                              : c.overpaid
                                ? <span className="text-s-amber">Overpaid {fmtPkr(-c.owedCents)}</span>
                                : <span className={c.owedCents > 0 ? 'text-s-red font-semibold' : 'text-s-muted'}>{fmtPkr(c.owedCents)}</span>}
                          </td>
                          <td className="px-4 py-2 text-xs text-s-muted">
                            {c.payments.length === 0 && '—'}
                            {c.payments.map((p) => (
                              <div key={p.id} className="flex flex-wrap items-center gap-x-2">
                                <span className="text-s-text">{p.cprNumber ?? 'No CPR'}</span>
                                <span>{p.paidAt}</span>
                                <span>{p.linked ? 'linked' : 'posted here'}</span>
                                {p.journalEntryId && <Link href={`/accounting/ledger?id=${p.journalEntryId}`} className="hover:underline">entry</Link>}
                                {data.canPay && (
                                  <button type="button" className="font-bold text-s-muted hover:text-s-text" onClick={() => setVoiding({ label: scheme.label, payment: p })}>
                                    {p.linked ? 'Unlink' : 'Void'}
                                  </button>
                                )}
                              </div>
                            ))}
                          </td>
                          {data.canPay && (
                            <td className="px-4 py-2 text-right whitespace-nowrap">
                              {(c.payments.length === 0 || c.owedCents > 0) && (
                                <button type="button" className="text-xs font-bold text-primary-ink hover:underline" onClick={() => setPaying({ key, month: m.month, owedCents: Math.max(0, c.owedCents), topUp: c.payments.length > 0 })}>
                                  {c.payments.length > 0 ? 'Record top-up' : 'Record payment'}
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot className="border-t border-s-border bg-s-bg-soft font-semibold">
                    <tr>
                      <td className="px-4 py-2 text-s-text">Total</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(t.accruedCents + t.legacyAccruedCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(t.paidCents)}</td>
                      <td className={`px-4 py-2 text-right font-mono text-xs ${t.owedCents === 0 ? 'text-success' : t.owedCents > 0 ? 'text-s-red' : 'text-s-amber'}`}>{fmtPkr(t.owedCents)}</td>
                      <td colSpan={data.canPay ? 2 : 1} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          )
        })}

        {data && <ReclassPanel onDone={refresh} />}

        {data && data.legacyHrChallans.length > 0 && (
          <section className="s-card overflow-hidden">
            <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">
              Recorded in HR, not on the books — the old &quot;EOBI / SESSI payments&quot; form. Record or link each challan above so the books show it.
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-s-muted">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Scheme</th>
                    <th className="px-4 py-2 text-left font-medium">Month</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                    <th className="px-4 py-2 text-left font-medium">Paid on</th>
                    <th className="px-4 py-2 text-left font-medium">Challan</th>
                  </tr>
                </thead>
                <tbody>
                  {data.legacyHrChallans.map((c) => (
                    <tr key={c.id} className="border-t border-s-border">
                      <td className="px-4 py-2 text-s-text">{c.scheme ?? '—'}</td>
                      <td className="px-4 py-2 text-xs text-s-text">{c.month ?? '—'}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(c.amountCents)}</td>
                      <td className="px-4 py-2 text-xs text-s-muted">{c.paidOn ?? '—'}</td>
                      <td className="px-4 py-2 text-xs text-s-muted">{c.challanNo ?? '—'}{c.status !== 'approved' ? ` · ${c.status}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {data && paying && (
          <PayModal tenantId={data.tenantId} target={paying} label={labelOf(paying.key)} onClose={() => setPaying(null)} onDone={refresh} />
        )}
        {data && linking && (
          <LinkModal initial={linking} schemes={data.schemes} onClose={() => setLinking(null)} onDone={refresh} />
        )}
        {voiding && <VoidModal label={voiding.label} payment={voiding.payment} onClose={() => setVoiding(null)} onDone={refresh} />}
      </div>
    </div>
  )
}

function PayModal({ tenantId, target, label, onClose, onDone }: {
  tenantId: string
  target: { key: SchemeKey; month: string; owedCents: number; topUp?: boolean }
  label: string
  onClose: () => void
  onDone: () => void
}) {
  const [f, setF] = useState({
    month: target.month, paid: rupees(target.owedCents), paidAt: todayPktIso(),
    method: 'bank_transfer', bankAccountId: '', cprNumber: '', notes: '',
  })
  const [err, setErr] = useState('')
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }))
  const go = useMutation({
    mutationFn: () => api.post('/accounting/sales-tax-return/payments', {
      authority: target.key,
      period: f.month,
      paidCents: toPaisa(f.paid),
      paidAt: f.paidAt,
      method: f.method,
      bankAccountId: f.method === 'cash' ? null : (f.bankAccountId || null),
      cprNumber: f.cprNumber || null,
      notes: f.notes || null,
    }),
    onSuccess: () => { onDone(); onClose() },
    onError: (e: Error) => setErr(e.message),
  })
  return (
    <Modal title={`Record payment — ${label}`} onClose={onClose} dirty={!go.isPending && (f.paid !== rupees(target.owedCents) || !!f.cprNumber.trim() || !!f.notes.trim())}>
      <DialogForm busy={go.isPending} onSubmit={() => go.mutate()}
        missing={!f.month ? 'Pick the month the payment is for.' : toPaisa(f.paid) <= 0 ? 'Enter the amount paid.' : !f.paidAt ? 'Pick the day it was paid.' : target.topUp && !f.cprNumber.trim() ? 'A top-up challan needs its own CPR / challan number.' : null}>
      <p className="text-xs text-s-muted mb-3">
        Posts the challan in the books on the day it was paid: the payable is cleared and the money leaves the bank (or cash).
        {target.topUp && ' This month already has a challan — this is a top-up for what is still owed, with its own CPR number.'}
      </p>
      {target.month === f.month && toPaisa(f.paid) > target.owedCents && (
        <p role="status" className="text-xs text-s-amber mb-3">
          This is more than the {fmtPkr(target.owedCents)} still owed for {target.month} — the month will show as overpaid.
        </p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="For the month"><input type="month" className="s-input" min="2000-01" value={f.month} onChange={set('month')} aria-invalid={!f.month ? true : undefined} /></Field>
        <Field label="Paid (PKR)"><RupeeField label="Paid (PKR)" value={f.paid} onChange={(v) => setF((p) => ({ ...p, paid: v }))} invalid={toPaisa(f.paid) <= 0} /></Field>
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
            <BankAccountSelect tenantId={tenantId} value={f.bankAccountId} onChange={(v) => setF((p) => ({ ...p, bankAccountId: v }))} className="s-input" label="Paid from" />
          </div>
        )}
        <Field label={target.topUp ? 'CPR / challan number *' : 'CPR / challan number'}><input className="s-input" value={f.cprNumber} onChange={set('cprNumber')} aria-invalid={target.topUp && !f.cprNumber.trim() ? true : undefined} /></Field>
        <Field label="Notes"><input className="s-input" value={f.notes} onChange={set('notes')} /></Field>
      </div>
      {err && <p role="alert" className="text-xs text-s-red mt-3">{err}</p>}
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

function LinkModal({ initial, schemes, onClose, onDone }: {
  initial: { key: SchemeKey; month: string }
  schemes: Summary['schemes']
  onClose: () => void
  onDone: () => void
}) {
  const [key, setKey] = useState<SchemeKey>(initial.key)
  const [month, setMonth] = useState(initial.month)
  const [entryId, setEntryId] = useState('')
  const [cprNumber, setCpr] = useState('')
  const [err, setErr] = useState('')
  const { data: cands, isLoading, error } = useQuery({
    queryKey: ['statutory', 'link-candidates', key],
    queryFn: () => api.get<{ entries: Candidate[] }>(`/accounting/sales-tax-return/payments/candidates?authority=${key}`),
  })
  const go = useMutation({
    mutationFn: () => api.post('/accounting/sales-tax-return/payments/link', { journalEntryId: entryId, authority: key, period: month, cprNumber: cprNumber || null }),
    onSuccess: () => { onDone(); onClose() },
    onError: (e: Error) => setErr(e.message),
  })
  return (
    <Modal title="Link a challan already posted" onClose={onClose} dirty={!go.isPending && (!!entryId || !!cprNumber.trim())}>
      <DialogForm busy={go.isPending} onSubmit={() => go.mutate()} missing={!month ? 'Pick the month the payment is for.' : !entryId ? 'Pick the entry to link.' : null}>
      <p className="text-xs text-s-muted mb-3">
        A challan you already posted as a manual journal or a bank-reconciliation adjustment. It is recorded as that month&apos;s payment — nothing is posted again.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Scheme">
          <Select className="s-input" value={key} onChange={(e) => { setKey(e.target.value as SchemeKey); setEntryId('') }}>
            {schemes.map((s) => <option key={s.key} value={s.key}>{s.label} ({s.account})</option>)}
          </Select>
        </Field>
        <Field label="For the month"><input type="month" className="s-input" min="2000-01" value={month} onChange={(e) => setMonth(e.target.value)} aria-invalid={!month ? true : undefined} /></Field>
        <Field label="CPR / challan number"><input className="s-input" value={cprNumber} onChange={(e) => setCpr(e.target.value)} /></Field>
      </div>
      <p className="text-[11px] font-bold uppercase tracking-wider text-s-muted mt-4 mb-1">Entry</p>
      <div className="max-h-56 overflow-y-auto rounded border border-s-border">
        {isLoading && <p className="px-3 py-2 text-xs text-s-muted">Loading…</p>}
        {error && <p className="px-3 py-2 text-xs text-s-red">{(error as Error).message}</p>}
        {cands && cands.entries.length === 0 && <p className="px-3 py-2 text-xs text-s-muted">No unlinked manual or reconciliation entry pays this scheme in the last 400 days.</p>}
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
      {err && <p role="alert" className="text-xs text-s-red mt-3">{err}</p>}
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

function VoidModal({ label, payment, onClose, onDone }: { label: string; payment: PaymentRef; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const go = useMutation({
    mutationFn: () => api.post(`/accounting/sales-tax-return/payments/${payment.id}/void`, { reason }),
    onSuccess: () => { onDone(); onClose() },
    onError: (e: Error) => setErr(e.message),
  })
  return (
    <Modal title={payment.linked ? `Unlink this ${label} challan` : `Void this ${label} challan`} onClose={onClose} dirty={!go.isPending && !!reason.trim()}>
      <DialogForm busy={go.isPending} onSubmit={() => go.mutate()} missing={reason.trim().length < 5 ? 'Give a reason (5 characters or more).' : null}>
      <p className="text-sm text-s-muted">
        {payment.linked
          ? 'The entry stays in the ledger as it was posted; it is no longer recorded as this month\'s challan.'
          : `The payment of ${fmtPkr(payment.paidCents)} is reversed in the ledger today. You can then record it again.`}
      </p>
      <div className="mt-4"><Field label="Reason"><input className="s-input" value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={reason.trim().length < 5 ? true : undefined} placeholder="Wrong month picked" /></Field></div>
      {err && <p role="alert" className="text-xs text-s-red mt-3">{err}</p>}
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

const BASIS_LABEL: Record<Preview['entries'][number]['basis'], string> = {
  exact: 'from the payslips / settlement',
  pro_rata: 'split in the payslips\' proportion (they changed after posting)',
  estimated: 'no payslips found — all counted as EOBI',
}

function ReclassPanel({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient()
  const { data: p, isLoading, error } = useQuery({
    queryKey: ['statutory', 'reclass'],
    queryFn: () => api.get<Preview>('/accounting/statutory/reclass'),
  })
  const [edit, setEdit] = useState<{ eobi: string; sessi: string; tax: string } | null>(null)
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [showEntries, setShowEntries] = useState(false)
  const amounts = edit ?? (p ? { eobi: rupees(p.suggested.eobiCents), sessi: rupees(p.suggested.sessiCents), tax: rupees(p.suggested.salaryTaxCents) } : { eobi: '0', sessi: '0', tax: '0' })
  const go = useMutation({
    mutationFn: () => api.post('/accounting/statutory/reclass', {
      eobiCents: toPaisa(amounts.eobi), sessiCents: toPaisa(amounts.sessi), salaryTaxCents: toPaisa(amounts.tax), note,
    }),
    onSuccess: () => { setErr(''); setEdit(null); void qc.invalidateQueries({ queryKey: ['statutory'] }); onDone() },
    onError: (e: Error) => setErr(e.message),
  })

  if (isLoading) return <p className="text-s-muted text-sm">Loading the reclass…</p>
  if (error) return <p className="text-s-red text-sm">{(error as Error).message}</p>
  if (!p) return null
  const hr = total(p.hrSourced)
  if (!p.done && hr === 0 && p.entries.length === 0) return null

  return (
    <section className={`s-card overflow-hidden ${p.done ? '' : 'border-l-4 border-s-amber'}`}>
      <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">
        One-time reclass — payroll amounts booked to 2090 (EOBI, SESSI) and 2040 (salary tax) before the statutory payables existed
      </div>
      <div className="p-4 space-y-3 text-sm">
        {p.done ? (
          <>
            <p className="text-s-text">
              <span className="s-badge-green mr-2">Done</span>
              Posted on {p.done.entryDate}: EOBI {fmtPkr(p.done.eobiCents)}, SESSI {fmtPkr(p.done.sessiCents)}, salary tax {fmtPkr(p.done.salaryTaxCents)}.
              {' '}<Link href={`/accounting/ledger?id=${p.done.entryId}`} className="text-xs hover:underline text-primary-ink">entry</Link>
            </p>
            {total(p.afterReclass) !== 0 && (
              <p className="text-xs text-s-amber">
                Since then payroll entries moved 2090 / 2040 again (EOBI {fmtPkr(p.afterReclass.eobiCents)}, SESSI {fmtPkr(p.afterReclass.sessiCents)},
                salary tax {fmtPkr(p.afterReclass.salaryTaxCents)}) — for example a cancelled old full &amp; final. Correct 2042–2044 with a manual journal.
              </p>
            )}
          </>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <div><p className="text-s-muted">Payroll booked (EOBI / SESSI / salary tax)</p><p className="font-mono text-s-text">{fmtPkr(p.hrSourced.eobiCents)} / {fmtPkr(p.hrSourced.sessiCents)} / {fmtPkr(p.hrSourced.salaryTaxCents)}</p></div>
              <div><p className="text-s-muted">2090 still holds</p><p className="font-mono text-s-text">{fmtPkr(p.balances.accruedExpenses2090Cents)}</p></div>
              <div><p className="text-s-muted">2040 still holds (incl. supplier withholding)</p><p className="font-mono text-s-text">{fmtPkr(p.balances.withholding2040Cents)}</p></div>
            </div>
            {p.manualDebits.length > 0 && (
              <div className="text-xs">
                <p className="text-s-muted mb-1">Already paid out of 2090 / 2040 by hand — lower the amounts below if these paid payroll challans:</p>
                <ul className="space-y-0.5">
                  {p.manualDebits.map((d) => (
                    <li key={`${d.entryId}-${d.accountCode}`} className="text-s-text">
                      {d.entryDate} · <span className="font-mono">{d.accountCode}</span> {fmtPkr(d.debitCents)} · {d.description}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <button type="button" className="text-xs font-bold text-primary-ink hover:underline" onClick={() => setShowEntries((v) => !v)}>
              {showEntries ? 'Hide' : 'Show'} the {p.entries.length} payroll entries
            </button>
            {showEntries && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-s-muted">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium">Date</th>
                      <th className="px-2 py-1 text-left font-medium">Entry</th>
                      <th className="px-2 py-1 text-right font-medium">EOBI</th>
                      <th className="px-2 py-1 text-right font-medium">SESSI</th>
                      <th className="px-2 py-1 text-right font-medium">Salary tax</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.entries.map((e) => (
                      <tr key={e.entryId} className="border-t border-s-border align-top">
                        <td className="px-2 py-1 text-s-text whitespace-nowrap">{e.entryDate}</td>
                        <td className="px-2 py-1 text-s-muted">
                          {e.kind === 'payroll' ? 'Payroll' : 'Full & final'}{e.reversal ? ' (reversal)' : ''}
                          <div>{BASIS_LABEL[e.basis]}</div>
                        </td>
                        <td className="px-2 py-1 text-right font-mono text-s-text">{fmtPkr(e.eobiCents)}</td>
                        <td className="px-2 py-1 text-right font-mono text-s-text">{fmtPkr(e.sessiCents)}</td>
                        <td className="px-2 py-1 text-right font-mono text-s-text">{fmtPkr(e.salaryTaxCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {p.canPost ? (
              <DialogForm busy={go.isPending} onSubmit={() => go.mutate()}
                missing={toPaisa(amounts.eobi) + toPaisa(amounts.sessi) + toPaisa(amounts.tax) <= 0 ? 'Enter at least one amount to move.' : note.trim().length < 5 ? 'Add a note (5 characters or more).' : null}>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Field label="EOBI → 2043 (PKR)"><RupeeField label="EOBI to 2043 (PKR)" value={amounts.eobi} onChange={(v) => setEdit({ ...amounts, eobi: v })} /></Field>
                  <Field label="SESSI → 2044 (PKR)"><RupeeField label="SESSI to 2044 (PKR)" value={amounts.sessi} onChange={(v) => setEdit({ ...amounts, sessi: v })} /></Field>
                  <Field label="Salary tax → 2042 (PKR)"><RupeeField label="Salary tax to 2042 (PKR)" value={amounts.tax} onChange={(v) => setEdit({ ...amounts, tax: v })} /></Field>
                </div>
                <Field label="Note" hint="Posted once, dated today. It cannot be reversed from here.">
                  <input className="s-input" value={note} onChange={(e) => setNote(e.target.value)} aria-invalid={note.trim().length < 5 ? true : undefined} placeholder="Move payroll statutory amounts to their own payables" />
                </Field>
                {err && <p role="alert" className="text-xs text-s-red">{err}</p>}
                <button
                  type="submit"
                  className="s-btn-primary text-sm mt-3"
                  disabled={go.isPending}
                >
                  {go.isPending ? 'Posting…' : `Post the reclass (${fmtPkr(toPaisa(amounts.eobi) + toPaisa(amounts.sessi) + toPaisa(amounts.tax))})`}
                </button>
              </DialogForm>
            ) : (
              <p className="text-xs text-s-muted">Finance or the CEO posts the reclass. Suggested: EOBI {fmtPkr(p.suggested.eobiCents)}, SESSI {fmtPkr(p.suggested.sessiCents)}, salary tax {fmtPkr(p.suggested.salaryTaxCents)}.</p>
            )}
          </>
        )}
      </div>
    </section>
  )
}
