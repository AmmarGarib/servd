'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface LedgerEntry {
  id: string
  date: string
  amountCents: number
  description: string
  paidTo: string | null
  category: string | null
  invoiceUrl: string | null
}

interface LedgerResp {
  entries: LedgerEntry[]
  totalCents: number
  count: number
}

const CATEGORIES = [
  { key: 'rent',       label: 'Rent / Security', color: '#6366F1' },
  { key: 'broker',     label: 'Broker',          color: '#A855F7' },
  { key: 'capex',      label: 'CapEx',           color: '#F59E0B' },
  { key: 'license',    label: 'License / Reg',   color: '#22C55E' },
  { key: 'equipment',  label: 'Equipment',       color: '#EC4899' },
  { key: 'consulting', label: 'Consulting',      color: '#0EA5E9' },
  { key: 'other',      label: 'Other',           color: '#94A3B8' },
]

function fmtPKR(cents: number) {
  return `PKR ${(cents / 100).toLocaleString('en-PK')}`
}

export default function CapitalLedgerPage() {
  const qc = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [totalAsk, setTotalAsk] = useState<string>(() => {
    if (typeof window === 'undefined') return ''
    return localStorage.getItem('servd_capital_total_ask') ?? ''
  })

  const { data, isLoading } = useQuery<LedgerResp>({
    queryKey: ['capital-ledger'],
    queryFn: () => api.get('/finance/capital-ledger'),
  })

  const askCents = totalAsk ? Math.round(parseFloat(totalAsk) * 100_000_00) : 0   // input in PKR lakhs (100,000)
  const remaining = askCents - (data?.totalCents ?? 0)
  const pctSpent = askCents > 0 ? Math.round(((data?.totalCents ?? 0) / askCents) * 100) : 0

  function saveTotalAsk(value: string) {
    setTotalAsk(value)
    if (typeof window !== 'undefined') localStorage.setItem('servd_capital_total_ask', value)
  }

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <div className="flex items-center gap-2 text-xs text-white/40 mb-2">
          <Link href="/finance" className="hover:text-white/70">← Finance</Link>
        </div>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-black text-white/90">💸 Capital Ledger</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Every PKR out, against your total capital ask. Mirrors the &quot;Date / Amount / For / Paid Out To&quot; tab from your Excel — but searchable, filterable, and tied to projects.
            </p>
          </div>
          <button onClick={() => setShowAdd(true)}
            className="rounded-xl bg-kds-green px-4 py-2.5 text-sm font-black text-black hover:opacity-90">
            + Log expense
          </button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-5xl space-y-5">
        {/* Capital ask + spent + remaining */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div className="rounded-2xl p-4 sm:col-span-1"
            style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/40">Total ask (PKR lakhs)</p>
            <input value={totalAsk} onChange={(e) => saveTotalAsk(e.target.value)}
              type="number" step="0.1" placeholder="340"
              className="w-full mt-2 bg-transparent text-2xl font-black text-white/95 focus:outline-none" />
            <p className="text-[10px] text-white/35 mt-1">{askCents > 0 ? fmtPKR(askCents) : '—'}</p>
          </div>
          <div className="rounded-2xl p-4"
            style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.18)' }}>
            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-amber-400">Spent</p>
            <p className="text-2xl font-black mt-1.5 text-amber-400">{fmtPKR(data?.totalCents ?? 0)}</p>
            <p className="text-[10px] text-white/40 mt-1">{data?.count ?? 0} transactions</p>
          </div>
          <div className="rounded-2xl p-4"
            style={{
              background: remaining >= 0 ? 'rgba(0,212,177,0.05)' : 'rgba(255,77,79,0.08)',
              border: remaining >= 0 ? '1px solid rgba(0,212,177,0.2)' : '1px solid rgba(255,77,79,0.3)',
            }}>
            <p className="text-[10px] font-black uppercase tracking-[0.24em]"
              style={{ color: remaining >= 0 ? '#00D4B1' : '#FF4D4F' }}>Remaining</p>
            <p className="text-2xl font-black mt-1.5"
              style={{ color: remaining >= 0 ? '#00D4B1' : '#FF4D4F' }}>
              {askCents > 0 ? fmtPKR(remaining) : '—'}
            </p>
            <p className="text-[10px] text-white/40 mt-1">{askCents > 0 ? `${pctSpent}% of ask` : 'Set total ask first'}</p>
          </div>
          <div className="rounded-2xl p-4"
            style={{ background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.2)' }}>
            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-[#6366F1]">Burn rate / month</p>
            <p className="text-2xl font-black mt-1.5 text-[#6366F1]">
              {data && data.count > 0 ? fmtPKR(Math.round((data.totalCents) / Math.max(1, monthsBetween(data.entries)))) : '—'}
            </p>
            <p className="text-[10px] text-white/40 mt-1">avg over period</p>
          </div>
        </div>

        {/* Progress bar */}
        {askCents > 0 && (
          <div>
            <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
              <div className="h-full transition-all duration-500"
                style={{
                  width: `${Math.min(100, pctSpent)}%`,
                  background: pctSpent > 90 ? '#FF4D4F' : pctSpent > 70 ? '#F59E0B' : 'linear-gradient(90deg, #00D4B1, #6366F1)',
                }} />
            </div>
            <p className="text-[10px] text-white/35 mt-1.5">{pctSpent}% of ask spent · {fmtPKR(remaining)} remaining</p>
          </div>
        )}

        {/* Entries table */}
        <div className="rounded-2xl overflow-hidden"
          style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
          {isLoading && <div className="p-6 text-sm text-white/40">Loading…</div>}
          {!isLoading && (data?.entries.length ?? 0) === 0 && (
            <div className="p-10 text-center">
              <p className="text-3xl mb-2">💸</p>
              <p className="font-bold text-white/85">No expenses logged yet</p>
              <p className="text-sm text-white/45 mt-1">Click &quot;Log expense&quot; to add your first entry.</p>
            </div>
          )}
          {data && data.entries.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-white/[0.02] border-b border-white/[0.05]">
                <tr>
                  <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-wider text-white/45">Date</th>
                  <th className="px-4 py-3 text-right text-[10px] font-black uppercase tracking-wider text-white/45">Amount</th>
                  <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-wider text-white/45">For</th>
                  <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-wider text-white/45">Paid out to</th>
                  <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-wider text-white/45">Category</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {data.entries.map((e) => {
                  const cat = CATEGORIES.find((c) => c.key === e.category)
                  return (
                    <tr key={e.id}>
                      <td className="px-4 py-3 text-white/65 font-mono text-xs">
                        {new Date(e.date).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: '2-digit' })}
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-bold text-white/85">{fmtPKR(e.amountCents)}</td>
                      <td className="px-4 py-3 text-white/85">{e.description}</td>
                      <td className="px-4 py-3 text-white/65">{e.paidTo ?? '—'}</td>
                      <td className="px-4 py-3">
                        {cat ? (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                            style={{ background: `${cat.color}20`, color: cat.color }}>
                            {cat.label}
                          </span>
                        ) : <span className="text-white/30 text-xs">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <DeleteBtn id={e.id} onDone={() => qc.invalidateQueries({ queryKey: ['capital-ledger'] })} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showAdd && (
        <AddEntryModal
          onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); void qc.invalidateQueries({ queryKey: ['capital-ledger'] }) }}
        />
      )}
    </div>
  )
}

function monthsBetween(entries: LedgerEntry[]): number {
  if (entries.length === 0) return 1
  const dates = entries.map((e) => new Date(e.date).getTime())
  const range = (Math.max(...dates) - Math.min(...dates)) / (30 * 86_400_000)
  return Math.max(1, range)
}

function DeleteBtn({ id, onDone }: { id: string; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const remove = useMutation({ mutationFn: () => api.delete(`/finance/capital-ledger/${id}`), onSuccess: onDone })
  if (!confirming) {
    return <button onClick={() => setConfirming(true)} className="text-xs text-white/40 hover:text-kds-red">Delete</button>
  }
  return (
    <div className="flex gap-2 justify-end">
      <button onClick={() => setConfirming(false)} className="text-xs text-white/40">Cancel</button>
      <button onClick={() => remove.mutate()} className="text-xs font-bold text-kds-red">Confirm</button>
    </div>
  )
}

function AddEntryModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [date,        setDate]        = useState(new Date().toISOString().slice(0, 10))
  const [amount,      setAmount]      = useState('')
  const [description, setDescription] = useState('')
  const [paidTo,      setPaidTo]      = useState('')
  const [category,    setCategory]    = useState<string>('capex')
  const [error,       setError]       = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => api.post('/finance/capital-ledger', {
      date,
      amountCents: Math.round(parseFloat(amount) * 100),
      description: description.trim(),
      paidTo: paidTo.trim() || undefined,
      category,
    }),
    onSuccess: () => onCreated(),
    onError: (e: Error) => setError(e.message),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl overflow-hidden"
        style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">Log expense</h2>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date *">
              <input value={date} onChange={(e) => setDate(e.target.value)} type="date" className="ledger-input" />
            </Field>
            <Field label="Amount (PKR) *">
              <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" step="0.01"
                placeholder="100000" className="ledger-input" autoFocus />
            </Field>
          </div>
          <Field label="For (description) *">
            <input value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Security Deposit Token" className="ledger-input" />
          </Field>
          <Field label="Paid out to">
            <input value={paidTo} onChange={(e) => setPaidTo(e.target.value)}
              placeholder="Malik Enterprises" className="ledger-input" />
          </Field>
          <Field label="Category">
            <div className="grid grid-cols-3 gap-1.5">
              {CATEGORIES.map((c) => (
                <button key={c.key} onClick={() => setCategory(c.key)}
                  className="rounded-lg px-2 py-1.5 text-xs font-bold transition-all"
                  style={category === c.key
                    ? { background: `${c.color}25`, border: `1px solid ${c.color}`, color: c.color }
                    : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.6)' }}>
                  {c.label}
                </button>
              ))}
            </div>
          </Field>
          {error && <p className="text-xs text-kds-red">{error}</p>}
        </div>
        <div className="flex justify-between gap-2 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => create.mutate()}
            disabled={!amount || !description.trim() || create.isPending}
            className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-40">
            {create.isPending ? 'Logging…' : 'Log expense'}
          </button>
        </div>
      </div>
      <style jsx>{`
        .ledger-input {
          width: 100%;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08);
          color: rgba(255,255,255,0.9);
          border-radius: 0.625rem;
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          outline: none;
        }
        .ledger-input:focus { border-color: #00D4B1; }
      `}</style>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-white/55 block mb-1">{label}</label>
      {children}
    </div>
  )
}
