'use client'
// Receivables — invoices a customer pays later (catering, events, corporate).
//
// Base layer. Raising an invoice posts it to 1110 receivable; recording a
// payment clears it into bank or cash. An unpaid invoice can be voided; once
// money has come in, the fix is a credit note, which is not built yet.

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { fmtPkrWhole } from '../../../lib/money'

interface Payment { id: string; amountCents: number; receivedAt: string; method: string; reference: string | null }
interface Invoice {
  id: string; number: string; customerName: string; customerEmail: string | null; customerPhone: string | null
  issueDate: string; dueDate: string; description: string
  amountCents: number; taxCents: number; totalCents: number; paidCents: number; balanceCents: number
  status: 'open' | 'partial' | 'paid' | 'void'; bucket: string | null; payments: Payment[]
}
interface Ledger { invoices: Invoice[]; aging: Record<string, number>; outstandingCents: number }
interface Concept { id: string; name: string }

const card = { background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.07)' }
const inp = 'w-full rounded-lg px-3 py-2 text-sm bg-white/[0.04] border border-white/10 text-white/90 focus:outline-none focus:border-primary'
const today = () => new Date().toISOString().slice(0, 10)
const plusDays = (d: string, n: number) => new Date(new Date(d).getTime() + n * 86_400_000).toISOString().slice(0, 10)
const STATUS_COLOR: Record<string, string> = { open: '#1d4ed8', partial: '#a15c00', paid: '#3f7d20', void: 'rgb(var(--fg-rgb) / 0.35)' }

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

export default function ReceivablesPage() {
  const [filter, setFilter] = useState<'outstanding' | '' | 'paid' | 'void'>('outstanding')
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
  const [paying, setPaying] = useState<Invoice | null>(null)
  const [voiding, setVoiding] = useState<Invoice | null>(null)

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/modules/tax" className="text-xs text-white/40 hover:text-white/70">← Tax, invoices & filing</Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-black text-white/90">Receivables</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">Invoices for customers who pay later. Till sales settle on the spot and never appear here.</p>
          </div>
          <button onClick={() => setRaising(true)} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">+ New invoice</button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-6xl mx-auto space-y-5">
        {data && (
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
            {[['Outstanding', data.outstandingCents], ['Not yet due', data.aging['current'] ?? 0], ['1–30 days', data.aging['1-30'] ?? 0],
              ['31–60', data.aging['31-60'] ?? 0], ['61–90', data.aging['61-90'] ?? 0], ['90+', data.aging['90+'] ?? 0]].map(([l, v], i) => (
              <div key={l as string} className="rounded-2xl p-4" style={card}>
                <p className="text-[10px] uppercase tracking-wider text-white/40 font-bold">{l}</p>
                <p className="text-lg font-black mt-1" style={{ color: i >= 4 && (v as number) > 0 ? '#b42318' : 'rgb(var(--fg-rgb) / 0.9)' }}>{fmtPkrWhole(v as number)}</p>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          {([['outstanding', 'Outstanding'], ['', 'All'], ['paid', 'Paid'], ['void', 'Void']] as const).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)}
              className={`rounded-full px-3 py-1 text-xs font-bold border ${filter === k ? 'bg-primary text-primary-on border-primary' : 'border-white/10 text-white/50'}`}>{l}</button>
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
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                  {['Invoice', 'Customer', 'Due', 'Total', 'Paid', 'Balance', 'Status', ''].map((h) => <th key={h} className="px-4 py-3 font-bold">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.invoices.map((i) => (
                  <tr key={i.id} className="border-t border-white/[0.05]">
                    <td className="px-4 py-3"><p className="font-bold text-white/90">{i.number}</p><p className="text-[11px] text-white/40 truncate max-w-[180px]">{i.description}</p></td>
                    <td className="px-4 py-3 text-white/70">{i.customerName}</td>
                    <td className="px-4 py-3 text-white/60">{new Date(i.dueDate).toLocaleDateString()}{i.bucket && i.bucket !== 'current' && <span className="ml-1 text-[10px] text-red-700">{i.bucket}d</span>}</td>
                    <td className="px-4 py-3 text-white/80">{fmtPkrWhole(i.totalCents)}</td>
                    <td className="px-4 py-3 text-white/60">{fmtPkrWhole(i.paidCents)}</td>
                    <td className="px-4 py-3 font-bold text-white/90">{fmtPkrWhole(i.balanceCents)}</td>
                    <td className="px-4 py-3"><span className="text-xs font-bold" style={{ color: STATUS_COLOR[i.status] }}>{i.status}</span></td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {(i.status === 'open' || i.status === 'partial') &&
                        <button onClick={() => setPaying(i)} className="text-xs font-bold text-primary-ink mr-3">Record payment</button>}
                      {i.status === 'open' && i.paidCents === 0 &&
                        <button onClick={() => setVoiding(i)} className="text-xs font-bold text-white/40 hover:text-white">Void</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {raising && <Raise concepts={concepts} onClose={() => setRaising(false)} />}
      {paying && <Pay inv={paying} onClose={() => setPaying(null)} />}
      {voiding && <Void inv={voiding} onClose={() => setVoiding(null)} />}
    </div>
  )
}

function Raise({ concepts, onClose }: { concepts: Concept[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({
    customerName: '', customerEmail: '', customerPhone: '', customerNtn: '', conceptId: '',
    issueDate: today(), dueDate: plusDays(today(), 30), description: '', amount: '', tax: '0',
  })
  const [err, setErr] = useState('')
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }))
  const save = useMutation({
    mutationFn: () => api.post('/accounting/receivables', {
      customerName: f.customerName, customerEmail: f.customerEmail || undefined, customerPhone: f.customerPhone || undefined,
      customerNtn: f.customerNtn || undefined, conceptId: f.conceptId || null,
      issueDate: f.issueDate, dueDate: f.dueDate, description: f.description,
      amountCents: Math.round(Number(f.amount) * 100), taxCents: Math.round(Number(f.tax || 0) * 100),
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['receivables'] }); onClose() },
    onError: (e: Error) => setErr(e.message),
  })
  const total = (Number(f.amount) || 0) + (Number(f.tax) || 0)
  return (
    <Modal title="New invoice" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><L t="Customer"><input className={inp} value={f.customerName} onChange={set('customerName')} placeholder="Company or person" /></L></div>
        <L t="Email"><input className={inp} value={f.customerEmail} onChange={set('customerEmail')} /></L>
        <L t="Phone"><input className={inp} value={f.customerPhone} onChange={set('customerPhone')} /></L>
        <L t="NTN"><input className={inp} value={f.customerNtn} onChange={set('customerNtn')} /></L>
        <L t="Brand"><select className={inp} value={f.conceptId} onChange={set('conceptId')}>
          <option value="">—</option>{concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></L>
        <L t="Issued"><input type="date" className={inp} value={f.issueDate} onChange={set('issueDate')} /></L>
        <L t="Due"><input type="date" className={inp} value={f.dueDate} onChange={set('dueDate')} /></L>
        <div className="col-span-2"><L t="What for"><input className={inp} value={f.description} onChange={set('description')} placeholder="Office lunch, 40 covers, 12 Sep" /></L></div>
        <L t="Amount before tax (PKR)"><input type="number" min={0} className={inp} value={f.amount} onChange={set('amount')} /></L>
        <L t="Sales tax (PKR)">
          <div className="flex gap-1">
            <input type="number" min={0} className={inp} value={f.tax} onChange={set('tax')} />
            <button type="button" onClick={() => setF((p) => ({ ...p, tax: String(Math.round((Number(p.amount) || 0) * 0.15)) }))}
              className="rounded-lg px-2 text-[11px] font-bold border border-white/10 text-white/60 whitespace-nowrap">15%</button>
          </div>
        </L>
      </div>
      <p className="text-sm text-white/60 mt-3">Total: <strong className="text-white/90">{fmtPkrWhole(Math.round(total * 100))}</strong></p>
      {err && <p className="text-xs text-red-700 mt-2">{err}</p>}
      <div className="flex gap-2 mt-5">
        <button onClick={() => save.mutate()} disabled={save.isPending || !f.customerName || !f.amount || !f.description}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-black text-primary-on disabled:opacity-50">{save.isPending ? 'Saving…' : 'Raise invoice'}</button>
        <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-white/60 border border-white/10">Cancel</button>
      </div>
    </Modal>
  )
}

function Pay({ inv, onClose }: { inv: Invoice; onClose: () => void }) {
  const qc = useQueryClient()
  const [amount, setAmount] = useState(String(inv.balanceCents / 100))
  const [date, setDate] = useState(today())
  const [method, setMethod] = useState('bank')
  const [reference, setReference] = useState('')
  const [err, setErr] = useState('')
  const go = useMutation({
    mutationFn: () => api.post(`/accounting/receivables/${inv.id}/payments`, {
      amountCents: Math.round(Number(amount) * 100), receivedAt: date, method, reference: reference || undefined,
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['receivables'] }); onClose() },
    onError: (e: Error) => setErr(e.message),
  })
  return (
    <Modal title={`Payment on ${inv.number}`} onClose={onClose}>
      <p className="text-sm text-white/60">Balance owed: <strong className="text-white/90">{fmtPkrWhole(inv.balanceCents)}</strong></p>
      <div className="grid grid-cols-2 gap-3 mt-4">
        <L t="Amount (PKR)"><input type="number" min={0} className={inp} value={amount} onChange={(e) => setAmount(e.target.value)} /></L>
        <L t="Received"><input type="date" className={inp} value={date} onChange={(e) => setDate(e.target.value)} /></L>
        <L t="Method"><select className={inp} value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="bank">Bank transfer</option><option value="cheque">Cheque</option><option value="cash">Cash</option><option value="card">Card</option></select></L>
        <L t="Reference"><input className={inp} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Cheque / txn no." /></L>
      </div>
      {err && <p className="text-xs text-red-700 mt-3">{err}</p>}
      <div className="flex gap-2 mt-5">
        <button onClick={() => go.mutate()} disabled={go.isPending || !Number(amount)} className="rounded-lg bg-primary px-4 py-2 text-sm font-black text-primary-on disabled:opacity-50">{go.isPending ? 'Saving…' : 'Record payment'}</button>
        <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-white/60 border border-white/10">Cancel</button>
      </div>
    </Modal>
  )
}

function Void({ inv, onClose }: { inv: Invoice; onClose: () => void }) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const go = useMutation({
    mutationFn: () => api.post(`/accounting/receivables/${inv.id}/void`, { reason }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['receivables'] }); onClose() },
    onError: (e: Error) => setErr(e.message),
  })
  return (
    <Modal title={`Void ${inv.number}`} onClose={onClose}>
      <p className="text-sm text-white/60">This reverses the invoice in the ledger. It stays on record as void.</p>
      <div className="mt-4"><L t="Reason"><input className={inp} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Raised in error" /></L></div>
      {err && <p className="text-xs text-red-700 mt-3">{err}</p>}
      <div className="flex gap-2 mt-5">
        <button onClick={() => go.mutate()} disabled={go.isPending || reason.trim().length < 3} className="rounded-lg bg-red-500 px-4 py-2 text-sm font-black text-[#fff] disabled:opacity-50">{go.isPending ? 'Voiding…' : 'Void invoice'}</button>
        <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-white/60 border border-white/10">Cancel</button>
      </div>
    </Modal>
  )
}
