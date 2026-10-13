'use client'
// Receivables — invoices a customer pays later (catering, events, corporate).
//
// Raising an invoice posts it to 1110 receivable. Against it you can record:
//   - a payment, into the bank (or cash) it actually went to;
//   - income tax the client withheld (their withholding certificate) — it
//     settles that part of the invoice and is a tax credit for us (1330);
//   - a credit note (AR-CN-…) for a dispute or an adjustment — it reverses
//     revenue and the sales tax the invoice charged;
//   - a refund, when a credit note leaves the customer in credit;
//   - a reversal of any receipt that did not stick (a bounced cheque).
// An invoice with nothing against it can be voided; after that, use a credit
// note. Balance = total − received − credited − withheld, everywhere.

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { fmtPkrWhole } from '../../../lib/money'
import { useActiveCompany } from '../../../lib/connectorsApi'
import { BankAccountSelect } from '../../../components/finance/BankAccountSelect'

type PaymentKind = 'payment' | 'withholding' | 'refund'
interface Payment {
  id: string; amountCents: number; receivedAt: string; method: string; reference: string | null
  kind: PaymentKind; bankName: string | null; bankAccountCode: string | null
  reversedAt: string | null; reversedReason: string | null
}
interface CreditNoteRef { id: string; number: string; issueDate: string; totalCents: number; amountCents: number; taxCents: number; status: string; description: string }
type Status = 'open' | 'partial' | 'paid' | 'credited' | 'void' | 'issued'
interface Invoice {
  id: string; tenantId: string; kind: 'invoice' | 'credit_note'; number: string
  customerName: string; customerEmail: string | null; customerPhone: string | null
  issueDate: string; dueDate: string; description: string
  amountCents: number; taxCents: number; totalCents: number
  paidCents: number; creditedCents: number; whtCents: number; balanceCents: number
  status: Status; bucket: string | null; payments: Payment[]
  creditNotes: CreditNoteRef[]; originalInvoiceId: string | null; originalNumber: string | null
}
interface Ledger { invoices: Invoice[]; aging: Record<string, number>; outstandingCents: number; creditBalanceCents: number }
interface Concept { id: string; name: string }
interface TaxPreview { brandName: string | null; rates: { cashPct: number; cardPct: number } | null; accountCode: string; accountName: string }

const card = { background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.07)' }
const inp = 'w-full rounded-lg px-3 py-2 text-sm bg-white/[0.04] border border-white/10 text-white/90 focus:outline-none focus:border-primary'
const today = () => new Date().toISOString().slice(0, 10)
const plusDays = (d: string, n: number) => new Date(new Date(d).getTime() + n * 86_400_000).toISOString().slice(0, 10)
/** Rupees typed → paisa. */
const toPaisa = (rupees: string) => Math.round((Number(rupees) || 0) * 100)
const rupees = (paisa: number) => String(paisa / 100)
const STATUS: Record<Status, { label: string; color: string }> = {
  open:     { label: 'Open',        color: 'var(--erp-primary)' },
  partial:  { label: 'Part paid',   color: 'var(--erp-warning)' },
  paid:     { label: 'Paid',        color: 'var(--erp-success)' },
  credited: { label: 'Credited',    color: 'var(--erp-success)' },
  void:     { label: 'Void',        color: 'rgb(var(--fg-rgb) / 0.35)' },
  issued:   { label: 'Credit note', color: 'var(--erp-primary)' },
}
const KIND_LABEL: Record<PaymentKind, string> = { payment: 'Payment', withholding: 'Income tax withheld', refund: 'Refund to customer' }
const METHOD_LABEL: Record<string, string> = { bank: 'Bank transfer', cheque: 'Cheque', cash: 'Cash', card: 'Card', wht: 'Certificate' }

const isLive = (i: Invoice) => i.kind === 'invoice' && i.status !== 'void'
const creditLeft = (i: Invoice) => {
  const live = i.creditNotes.filter((c) => c.status !== 'void')
  return {
    amount: i.amountCents - live.reduce((t, c) => t + c.amountCents, 0),
    tax: i.taxCents - live.reduce((t, c) => t + c.taxCents, 0),
  }
}

function L({ t, children }: { t: string; children: React.ReactNode }) {
  return <label className="block"><span className="text-[11px] font-bold text-white/50">{t}</span>{children}</label>
}
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl p-6 max-h-[90vh] overflow-y-auto" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <p className="text-lg font-black text-white/90 mb-4">{title}</p>
        {children}
      </div>
    </div>
  )
}
function Buttons({ busy, disabled, label, busyLabel, onGo, onClose, danger }: {
  busy: boolean; disabled?: boolean; label: string; busyLabel: string; onGo: () => void; onClose: () => void; danger?: boolean
}) {
  return (
    <div className="flex gap-2 mt-5">
      <button onClick={onGo} disabled={busy || disabled}
        className={`rounded-lg px-4 py-2 text-sm font-black disabled:opacity-50 ${danger ? 'bg-s-red text-bone' : 'bg-primary text-primary-on'}`}>
        {busy ? busyLabel : label}
      </button>
      <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-white/60 border border-white/10">Cancel</button>
    </div>
  )
}
function useDone(onClose: () => void) {
  const qc = useQueryClient()
  return () => { void qc.invalidateQueries({ queryKey: ['receivables'] }); onClose() }
}

type Dialog =
  | { kind: 'pay' | 'wht' | 'credit' | 'refund' | 'void'; inv: Invoice }
  | { kind: 'reverse'; inv: Invoice; payment: Payment }

export default function ReceivablesPage() {
  const [filter, setFilter] = useState<'outstanding' | 'in_credit' | '' | 'paid' | 'credit_notes' | 'void'>('outstanding')
  const { data } = useQuery({
    queryKey: ['receivables', filter],
    queryFn: () => api.get<Ledger>(`/accounting/receivables${filter ? `?status=${filter}` : ''}`),
  })
  // Brand list from GET /concepts?view=picker (every staff role, the active
  // brands of its own companies, id + name) — plain /concepts is managers /
  // till only and 403'd for the roles that hold this page (R2-UI-04).
  // Shares the shell BrandPicker's cache key and shape.
  const { data: concepts = [] } = useQuery({
    queryKey: ['concepts', 'brand-picker'],
    queryFn: () => api.get<Concept[]>('/concepts?view=picker'),
    staleTime: 60_000,
  })
  const [raising, setRaising] = useState(false)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const close = () => setDialog(null)

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-4 md:px-7 py-6 border-b border-white/[0.05]">
        <Link href="/modules/tax" className="text-xs text-white/40 hover:text-white/70">← Tax, invoices & filing</Link>
        <div className="flex flex-wrap items-start justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-black text-white/90">Receivables</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">Invoices for customers who pay later. Till sales settle on the spot and never appear here.</p>
          </div>
          <button onClick={() => setRaising(true)} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">+ New invoice</button>
        </div>
      </header>

      <div className="px-4 md:px-7 py-6 max-w-6xl mx-auto space-y-5">
        {data && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
            {[['Outstanding', data.outstandingCents], ['Not yet due', data.aging['current'] ?? 0], ['1–30 days', data.aging['1-30'] ?? 0],
              ['31–60', data.aging['31-60'] ?? 0], ['61–90', data.aging['61-90'] ?? 0], ['90+', data.aging['90+'] ?? 0]].map(([l, v], i) => (
              <div key={l as string} className="rounded-2xl p-4" style={card}>
                <p className="text-[10px] uppercase tracking-wider text-white/40 font-bold">{l}</p>
                <p className="text-lg font-black mt-1" style={{ color: i >= 4 && (v as number) > 0 ? 'var(--erp-danger)' : 'rgb(var(--fg-rgb) / 0.9)' }}>{fmtPkrWhole(v as number)}</p>
              </div>
            ))}
          </div>
        )}
        {data && data.creditBalanceCents > 0 && (
          <button onClick={() => setFilter('in_credit')} className="w-full text-left rounded-2xl p-4 text-sm" style={card}>
            <span className="font-bold" style={{ color: 'var(--erp-warning)' }}>Customers in credit: {fmtPkrWhole(data.creditBalanceCents)}</span>
            <span className="text-white/50"> — a credit note on money already received. Refund it from the invoice.</span>
          </button>
        )}

        <div className="flex flex-wrap gap-2">
          {([['outstanding', 'Outstanding'], ['in_credit', 'In credit'], ['', 'All'], ['paid', 'Paid'], ['credit_notes', 'Credit notes'], ['void', 'Void']] as const).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)}
              className={`rounded-full px-3 py-1 text-xs font-bold border ${filter === k ? 'bg-accent-dim text-s-text border-accent' : 'border-white/10 text-white/50'}`}>{l}</button>
          ))}
        </div>

        {data && data.invoices.length === 0 && (
          <div className="rounded-2xl p-10 text-center" style={card}>
            <p className="font-bold text-white/85">Nothing here</p>
            <p className="text-sm text-white/45 mt-1">Raise an invoice when a customer is paying on account.</p>
          </div>
        )}

        {data && data.invoices.length > 0 && (
          <div className="rounded-2xl overflow-x-auto" style={card}>
            <table className="w-full text-sm min-w-[760px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                  {['Document', 'Customer', 'Due', 'Total', 'Received', 'Balance', 'Status', ''].map((h) => <th key={h} className="px-4 py-3 font-bold">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.invoices.map((i) => (
                  <Row key={i.id} i={i} expanded={open === i.id} onToggle={() => setOpen(open === i.id ? null : i.id)} onAction={setDialog} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {raising && <Raise concepts={concepts} onClose={() => setRaising(false)} />}
      {dialog?.kind === 'pay' && <Pay inv={dialog.inv} onClose={close} />}
      {dialog?.kind === 'wht' && <Withhold inv={dialog.inv} onClose={close} />}
      {dialog?.kind === 'credit' && <CreditNote inv={dialog.inv} onClose={close} />}
      {dialog?.kind === 'refund' && <Refund inv={dialog.inv} onClose={close} />}
      {dialog?.kind === 'reverse' && <Reverse inv={dialog.inv} payment={dialog.payment} onClose={close} />}
      {dialog?.kind === 'void' && <Void inv={dialog.inv} onClose={close} />}
    </div>
  )
}

function Row({ i, expanded, onToggle, onAction }: { i: Invoice; expanded: boolean; onToggle: () => void; onAction: (d: Dialog) => void }) {
  const isNote = i.kind === 'credit_note'
  const left = isNote ? null : creditLeft(i)
  const nothingAgainst = i.paidCents === 0 && i.creditedCents === 0 && i.whtCents === 0
  const hasDetail = i.payments.length > 0 || i.creditNotes.length > 0
  const act = (label: string, d: Dialog, muted = false) => (
    <button onClick={() => onAction(d)} className={`text-xs font-bold ml-3 ${muted ? 'text-white/40 hover:text-white' : 'text-primary-ink'}`}>{label}</button>
  )
  return (
    <>
      <tr className="border-t border-white/[0.05]">
        <td className="px-4 py-3">
          <p className="font-bold text-white/90">{i.number}</p>
          <p className="text-[11px] text-white/40 truncate max-w-[200px]">{isNote ? `Credit note on ${i.originalNumber ?? 'an invoice'} — ${i.description}` : i.description}</p>
        </td>
        <td className="px-4 py-3 text-white/70">{i.customerName}</td>
        <td className="px-4 py-3 text-white/60 whitespace-nowrap">
          {new Date(isNote ? i.issueDate : i.dueDate).toLocaleDateString()}
          {i.bucket && i.bucket !== 'current' && <span className="ml-1 text-[10px] text-s-red">{i.bucket}d</span>}
        </td>
        <td className="px-4 py-3 text-white/80 whitespace-nowrap">{fmtPkrWhole(isNote ? -i.totalCents : i.totalCents)}</td>
        <td className="px-4 py-3 text-white/60 whitespace-nowrap">
          {isNote ? '—' : fmtPkrWhole(i.paidCents)}
          {!isNote && (i.creditedCents > 0 || i.whtCents > 0) && (
            <p className="text-[10px] text-white/40">
              {i.creditedCents > 0 && `Credited ${fmtPkrWhole(i.creditedCents)}`}
              {i.creditedCents > 0 && i.whtCents > 0 && ' · '}
              {i.whtCents > 0 && `Tax withheld ${fmtPkrWhole(i.whtCents)}`}
            </p>
          )}
        </td>
        <td className="px-4 py-3 font-bold whitespace-nowrap" style={{ color: i.balanceCents < 0 ? 'var(--erp-warning)' : 'rgb(var(--fg-rgb) / 0.9)' }}>
          {i.balanceCents < 0 ? `In credit ${fmtPkrWhole(-i.balanceCents)}` : fmtPkrWhole(i.balanceCents)}
        </td>
        <td className="px-4 py-3"><span className="text-xs font-bold" style={{ color: STATUS[i.status]?.color }}>{STATUS[i.status]?.label ?? i.status}</span></td>
        <td className="px-4 py-3 text-right whitespace-nowrap">
          {isLive(i) && i.balanceCents > 0 && act('Record payment', { kind: 'pay', inv: i })}
          {isLive(i) && i.balanceCents > 0 && act('Tax withheld', { kind: 'wht', inv: i })}
          {isLive(i) && left && (left.amount > 0 || left.tax > 0) && act('Credit note', { kind: 'credit', inv: i })}
          {isLive(i) && i.balanceCents < 0 && i.paidCents > 0 && act('Refund', { kind: 'refund', inv: i })}
          {isLive(i) && i.status === 'open' && nothingAgainst && act('Void', { kind: 'void', inv: i }, true)}
          {isNote && i.status === 'issued' && act('Void', { kind: 'void', inv: i }, true)}
          {hasDetail && <button onClick={onToggle} className="text-xs font-bold ml-3 text-white/50 hover:text-white">{expanded ? 'Hide' : 'Details'}</button>}
        </td>
      </tr>
      {expanded && hasDetail && (
        <tr className="border-t border-white/[0.03]">
          <td colSpan={8} className="px-4 pb-4 pt-1">
            <div className="rounded-xl p-3 space-y-2" style={{ background: 'rgb(var(--fg-rgb) / 0.03)' }}>
              {i.payments.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <span className="text-white/50 w-20">{new Date(p.receivedAt).toLocaleDateString()}</span>
                  <span className="font-bold text-white/80">{KIND_LABEL[p.kind]}</span>
                  <span className="text-white/50">
                    {METHOD_LABEL[p.method] ?? p.method}
                    {p.bankName ? ` · ${p.bankName}${p.bankAccountCode ? ` (${p.bankAccountCode})` : ''}` : ''}
                    {p.reference ? ` · ${p.reference}` : ''}
                  </span>
                  <span className={`font-bold ${p.reversedAt ? 'line-through text-white/40' : 'text-white/85'}`}>{fmtPkrWhole(Math.abs(p.amountCents))}</span>
                  {p.reversedAt
                    ? <span className="text-s-red">Reversed {new Date(p.reversedAt).toLocaleDateString()}{p.reversedReason ? ` — ${p.reversedReason}` : ''}</span>
                    : <button onClick={() => onAction({ kind: 'reverse', inv: i, payment: p })} className="font-bold text-white/40 hover:text-white">Reverse</button>}
                </div>
              ))}
              {i.creditNotes.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <span className="text-white/50 w-20">{new Date(c.issueDate).toLocaleDateString()}</span>
                  <span className="font-bold text-white/80">Credit note {c.number}</span>
                  <span className="text-white/50 truncate max-w-[260px]">{c.description}</span>
                  <span className={`font-bold ${c.status === 'void' ? 'line-through text-white/40' : 'text-white/85'}`}>{fmtPkrWhole(c.totalCents)}</span>
                  {c.status === 'void' && <span className="text-white/40">Void</span>}
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function Raise({ concepts, onClose }: { concepts: Concept[]; onClose: () => void }) {
  const done = useDone(onClose)
  const [f, setF] = useState({
    customerName: '', customerEmail: '', customerPhone: '', customerNtn: '', conceptId: '',
    issueDate: today(), dueDate: plusDays(today(), 30), description: '', amount: '', tax: '0',
  })
  const [err, setErr] = useState('')
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }))
  // The brand's own rates (cash / card) and where its tax is booked — never
  // a rate assumed here.
  const { data: preview } = useQuery({
    queryKey: ['receivables', 'tax-preview', f.conceptId],
    queryFn: () => api.get<TaxPreview>(`/accounting/receivables/tax-preview${f.conceptId ? `?conceptId=${f.conceptId}` : ''}`),
    staleTime: 60_000,
  })
  const save = useMutation({
    mutationFn: () => api.post('/accounting/receivables', {
      customerName: f.customerName, customerEmail: f.customerEmail || undefined, customerPhone: f.customerPhone || undefined,
      customerNtn: f.customerNtn || undefined, conceptId: f.conceptId || null,
      issueDate: f.issueDate, dueDate: f.dueDate, description: f.description,
      amountCents: toPaisa(f.amount), taxCents: toPaisa(f.tax),
    }),
    onSuccess: done,
    onError: (e: Error) => setErr(e.message),
  })
  const applyRate = (pct: number) => setF((p) => ({ ...p, tax: String(Math.round((Number(p.amount) || 0) * pct) / 100) }))
  const total = (Number(f.amount) || 0) + (Number(f.tax) || 0)
  return (
    <Modal title="New invoice" onClose={onClose}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2"><L t="Customer"><input className={inp} value={f.customerName} onChange={set('customerName')} placeholder="Company or person" /></L></div>
        <L t="Email"><input className={inp} value={f.customerEmail} onChange={set('customerEmail')} /></L>
        <L t="Phone"><input className={inp} value={f.customerPhone} onChange={set('customerPhone')} /></L>
        <L t="NTN"><input className={inp} value={f.customerNtn} onChange={set('customerNtn')} /></L>
        <L t="Brand"><select className={inp} value={f.conceptId} onChange={set('conceptId')}>
          <option value="">—</option>{concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></L>
        <L t="Issued"><input type="date" className={inp} value={f.issueDate} onChange={set('issueDate')} /></L>
        <L t="Due"><input type="date" className={inp} value={f.dueDate} onChange={set('dueDate')} /></L>
        <div className="sm:col-span-2"><L t="What for"><input className={inp} value={f.description} onChange={set('description')} placeholder="Office lunch, 40 covers, 12 Sep" /></L></div>
        <L t="Amount before tax (PKR)"><input type="number" min={0} className={inp} value={f.amount} onChange={set('amount')} /></L>
        <L t="Sales tax (PKR)"><input type="number" min={0} className={inp} value={f.tax} onChange={set('tax')} /></L>
      </div>
      <div className="mt-2 text-[11px] text-white/50 space-y-1">
        {preview?.rates ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span>{preview.brandName}&apos;s rates:</span>
            <button type="button" onClick={() => applyRate(preview.rates!.cashPct)}
              className="rounded-lg px-2 py-0.5 font-bold border border-white/10 text-white/70">Cash {preview.rates.cashPct}%</button>
            <button type="button" onClick={() => applyRate(preview.rates!.cardPct)}
              className="rounded-lg px-2 py-0.5 font-bold border border-white/10 text-white/70">Card / digital {preview.rates.cardPct}%</button>
          </div>
        ) : (
          <p>Pick a brand to use its sales-tax rates.</p>
        )}
        {preview && <p>The tax is booked to {preview.accountCode} {preview.accountName}.</p>}
      </div>
      <p className="text-sm text-white/60 mt-3">Total: <strong className="text-white/90">{fmtPkrWhole(Math.round(total * 100))}</strong></p>
      {err && <p className="text-xs text-s-red mt-2">{err}</p>}
      <Buttons busy={save.isPending} disabled={!f.customerName || !f.amount || !f.description} label="Raise invoice" busyLabel="Saving…" onGo={() => save.mutate()} onClose={onClose} />
    </Modal>
  )
}

function Pay({ inv, onClose }: { inv: Invoice; onClose: () => void }) {
  const done = useDone(onClose)
  const [amount, setAmount] = useState(rupees(inv.balanceCents))
  const [date, setDate] = useState(today())
  const [method, setMethod] = useState('bank')
  const [bankAccountId, setBankAccountId] = useState('')
  const [reference, setReference] = useState('')
  const [err, setErr] = useState('')
  const usesBank = method === 'bank' || method === 'cheque'
  const go = useMutation({
    mutationFn: () => api.post(`/accounting/receivables/${inv.id}/payments`, {
      amountCents: toPaisa(amount), receivedAt: date, method, reference: reference || undefined,
      bankAccountId: usesBank && bankAccountId ? bankAccountId : undefined,
    }),
    onSuccess: done,
    onError: (e: Error) => setErr(e.message),
  })
  return (
    <Modal title={`Payment on ${inv.number}`} onClose={onClose}>
      <p className="text-sm text-white/60">Balance owed: <strong className="text-white/90">{fmtPkrWhole(inv.balanceCents)}</strong></p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
        <L t="Amount received (PKR)"><input type="number" min={0} className={inp} value={amount} onChange={(e) => setAmount(e.target.value)} /></L>
        <L t="Received"><input type="date" className={inp} value={date} onChange={(e) => setDate(e.target.value)} /></L>
        <L t="Method"><select className={inp} value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="bank">Bank transfer</option><option value="cheque">Cheque</option><option value="cash">Cash</option><option value="card">Card</option></select></L>
        <L t="Reference"><input className={inp} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Cheque / txn no." /></L>
        {usesBank && (
          <div className="sm:col-span-2">
            <BankAccountSelect tenantId={inv.tenantId} value={bankAccountId} onChange={setBankAccountId} id="ar-pay-bank" label="Received into" className={inp} />
          </div>
        )}
      </div>
      <p className="text-[11px] text-white/45 mt-3">If the client kept back income tax, record the cash here and the tax with &ldquo;Tax withheld&rdquo; when their certificate arrives.</p>
      {err && <p className="text-xs text-s-red mt-3">{err}</p>}
      <Buttons busy={go.isPending} disabled={!Number(amount)} label="Record payment" busyLabel="Saving…" onGo={() => go.mutate()} onClose={onClose} />
    </Modal>
  )
}

function Withhold({ inv, onClose }: { inv: Invoice; onClose: () => void }) {
  const done = useDone(onClose)
  const [amount, setAmount] = useState(rupees(inv.balanceCents))
  const [certificateNo, setCertificateNo] = useState('')
  const [date, setDate] = useState(today())
  const [err, setErr] = useState('')
  const go = useMutation({
    mutationFn: () => api.post(`/accounting/receivables/${inv.id}/withholding`, {
      amountCents: toPaisa(amount), certificateNo: certificateNo || undefined, date,
    }),
    onSuccess: done,
    onError: (e: Error) => setErr(e.message),
  })
  return (
    <Modal title={`Income tax withheld on ${inv.number}`} onClose={onClose}>
      <p className="text-sm text-white/60">
        Income tax {inv.customerName} kept back and paid to FBR for us. It settles that part of the invoice and is a tax credit on our own return.
        Still due: <strong className="text-white/90">{fmtPkrWhole(inv.balanceCents)}</strong>
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
        <L t="Tax withheld (PKR)"><input type="number" min={0} className={inp} value={amount} onChange={(e) => setAmount(e.target.value)} /></L>
        <L t="Date"><input type="date" className={inp} value={date} onChange={(e) => setDate(e.target.value)} /></L>
        <div className="sm:col-span-2"><L t="Certificate no."><input className={inp} value={certificateNo} onChange={(e) => setCertificateNo(e.target.value)} placeholder="From the client's withholding certificate" /></L></div>
      </div>
      <p className="text-[11px] text-white/45 mt-3">Sales tax a client withholds is not recorded here yet.</p>
      {err && <p className="text-xs text-s-red mt-3">{err}</p>}
      <Buttons busy={go.isPending} disabled={!Number(amount)} label="Record tax withheld" busyLabel="Saving…" onGo={() => go.mutate()} onClose={onClose} />
    </Modal>
  )
}

function CreditNote({ inv, onClose }: { inv: Invoice; onClose: () => void }) {
  const qc = useQueryClient()
  const left = creditLeft(inv)
  const [amount, setAmount] = useState('')
  const [tax, setTax] = useState('0')
  const [reason, setReason] = useState('')
  const [date, setDate] = useState(today())
  const [err, setErr] = useState('')
  const [warning, setWarning] = useState<string | null>(null)
  const go = useMutation({
    mutationFn: () => api.post<{ number: string; warning: string | null }>(`/accounting/receivables/${inv.id}/credit-notes`, {
      amountCents: toPaisa(amount), taxCents: toPaisa(tax), reason, date,
    }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['receivables'] })
      if (r.warning) setWarning(`${r.number} issued. ${r.warning}`)
      else onClose()
    },
    onError: (e: Error) => setErr(e.message),
  })
  // The invoice's own tax share — no rate assumed.
  const taxShare = () => setTax(inv.amountCents > 0 ? String(Math.round(toPaisa(amount) * inv.taxCents / inv.amountCents) / 100) : '0')
  if (warning) {
    return (
      <Modal title="Credit note issued" onClose={onClose}>
        <p className="text-sm" style={{ color: 'var(--erp-warning)' }}>{warning}</p>
        <button onClick={onClose} className="mt-5 rounded-lg bg-primary px-4 py-2 text-sm font-black text-primary-on">Done</button>
      </Modal>
    )
  }
  return (
    <Modal title={`Credit note on ${inv.number}`} onClose={onClose}>
      <p className="text-sm text-white/60">
        Reverses revenue and the sales tax this invoice charged. Left to credit: <strong className="text-white/90">{fmtPkrWhole(left.amount)}</strong> before tax,{' '}
        <strong className="text-white/90">{fmtPkrWhole(left.tax)}</strong> tax.
        {inv.paidCents > 0 && ' If it is more than is still owed, the customer is left in credit and you can refund them.'}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
        <L t="Credit before tax (PKR)"><input type="number" min={0} className={inp} value={amount} onChange={(e) => setAmount(e.target.value)} /></L>
        <L t="Tax credited (PKR)">
          <div className="flex gap-1">
            <input type="number" min={0} className={inp} value={tax} onChange={(e) => setTax(e.target.value)} />
            {inv.taxCents > 0 && (
              <button type="button" onClick={taxShare} className="rounded-lg px-2 text-[11px] font-bold border border-white/10 text-white/60 whitespace-nowrap">Invoice&apos;s rate</button>
            )}
          </div>
        </L>
        <L t="Date"><input type="date" className={inp} value={date} onChange={(e) => setDate(e.target.value)} /></L>
        <L t="Reason"><input className={inp} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Short delivery, price agreed lower…" /></L>
      </div>
      {err && <p className="text-xs text-s-red mt-3">{err}</p>}
      <Buttons busy={go.isPending} disabled={toPaisa(amount) + toPaisa(tax) <= 0 || reason.trim().length < 3}
        label="Issue credit note" busyLabel="Saving…" onGo={() => go.mutate()} onClose={onClose} />
    </Modal>
  )
}

function Refund({ inv, onClose }: { inv: Invoice; onClose: () => void }) {
  const done = useDone(onClose)
  const max = Math.max(0, Math.min(-inv.balanceCents, inv.paidCents))
  const [amount, setAmount] = useState(rupees(max))
  const [date, setDate] = useState(today())
  const [method, setMethod] = useState('bank')
  const [bankAccountId, setBankAccountId] = useState('')
  const [reference, setReference] = useState('')
  const [err, setErr] = useState('')
  const usesBank = method === 'bank' || method === 'cheque'
  const go = useMutation({
    mutationFn: () => api.post(`/accounting/receivables/${inv.id}/refunds`, {
      amountCents: toPaisa(amount), date, method, reference: reference || undefined,
      bankAccountId: usesBank && bankAccountId ? bankAccountId : undefined,
    }),
    onSuccess: done,
    onError: (e: Error) => setErr(e.message),
  })
  return (
    <Modal title={`Refund ${inv.customerName}`} onClose={onClose}>
      <p className="text-sm text-white/60">They are in credit by <strong className="text-white/90">{fmtPkrWhole(-inv.balanceCents)}</strong> on {inv.number}. You can refund up to {fmtPkrWhole(max)}.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
        <L t="Refund (PKR)"><input type="number" min={0} className={inp} value={amount} onChange={(e) => setAmount(e.target.value)} /></L>
        <L t="Paid on"><input type="date" className={inp} value={date} onChange={(e) => setDate(e.target.value)} /></L>
        <L t="Method"><select className={inp} value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="bank">Bank transfer</option><option value="cheque">Cheque</option><option value="cash">Cash</option></select></L>
        <L t="Reference"><input className={inp} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Cheque / txn no." /></L>
        {usesBank && (
          <div className="sm:col-span-2">
            <BankAccountSelect tenantId={inv.tenantId} value={bankAccountId} onChange={setBankAccountId} id="ar-refund-bank" label="Paid from" className={inp} />
          </div>
        )}
      </div>
      {err && <p className="text-xs text-s-red mt-3">{err}</p>}
      <Buttons busy={go.isPending} disabled={!Number(amount)} label="Record refund" busyLabel="Saving…" onGo={() => go.mutate()} onClose={onClose} />
    </Modal>
  )
}

function Reverse({ inv, payment, onClose }: { inv: Invoice; payment: Payment; onClose: () => void }) {
  const done = useDone(onClose)
  const [reason, setReason] = useState(payment.method === 'cheque' ? 'Cheque bounced' : '')
  const [date, setDate] = useState(today())
  const [err, setErr] = useState('')
  const go = useMutation({
    mutationFn: () => api.post(`/accounting/receivables/${inv.id}/payments/${payment.id}/reverse`, { reason, date }),
    onSuccess: done,
    onError: (e: Error) => setErr(e.message),
  })
  const what = payment.kind === 'refund'
    ? 'The refund is undone: the customer is back in credit by this amount.'
    : payment.kind === 'withholding'
      ? 'The withholding is taken off: the invoice owes this amount again.'
      : 'The money is taken back out of the books: the invoice owes this amount again.'
  return (
    <Modal title={`Reverse ${KIND_LABEL[payment.kind].toLowerCase()} on ${inv.number}`} onClose={onClose}>
      <p className="text-sm text-white/60">
        {fmtPkrWhole(Math.abs(payment.amountCents))} · {METHOD_LABEL[payment.method] ?? payment.method}
        {payment.bankName ? ` · ${payment.bankName}` : ''}{payment.reference ? ` · ${payment.reference}` : ''}. {what} It stays on record as reversed.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
        <L t="Reason"><input className={inp} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Cheque bounced" /></L>
        <L t="Date"><input type="date" className={inp} value={date} onChange={(e) => setDate(e.target.value)} /></L>
      </div>
      {err && <p className="text-xs text-s-red mt-3">{err}</p>}
      <Buttons busy={go.isPending} disabled={reason.trim().length < 3} label="Reverse" busyLabel="Reversing…" onGo={() => go.mutate()} onClose={onClose} danger />
    </Modal>
  )
}

function Void({ inv, onClose }: { inv: Invoice; onClose: () => void }) {
  const done = useDone(onClose)
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const isNote = inv.kind === 'credit_note'
  const go = useMutation({
    mutationFn: () => api.post(`/accounting/receivables/${inv.id}/void`, { reason }),
    onSuccess: done,
    onError: (e: Error) => setErr(e.message),
  })
  return (
    <Modal title={`Void ${inv.number}`} onClose={onClose}>
      <p className="text-sm text-white/60">
        {isNote
          ? `This withdraws the credit note: ${inv.originalNumber ?? 'the invoice'} owes ${fmtPkrWhole(inv.totalCents)} again, and the ledger entry is reversed.`
          : 'This reverses the invoice in the ledger. It stays on record as void.'}
      </p>
      <div className="mt-4"><L t="Reason"><input className={inp} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Raised in error" /></L></div>
      {err && <p className="text-xs text-s-red mt-3">{err}</p>}
      <Buttons busy={go.isPending} disabled={reason.trim().length < 3} label={isNote ? 'Void credit note' : 'Void invoice'} busyLabel="Voiding…" onGo={() => go.mutate()} onClose={onClose} danger />
    </Modal>
  )
}
