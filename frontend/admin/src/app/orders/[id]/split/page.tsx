'use client'

// Check-splitting screen. Two flows:
//   1. Even — pick "n ways", system divides equally with residue to first
//   2. Custom — operator types each split's amount + label
//
// On submit, /check-split/orders/:id/split or /split-evenly creates a Payment
// per split (status='pending'). POS settles each independently afterward.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '../../../../lib/api'
import { fmtPkr } from '../../../../lib/money'

interface Order {
  id: string; totalCents: number; concept: { name: string }
  payments: Array<{ id: string; amountCents: number; status: string; splitGroup: number | null; splitLabel: string | null; method: string }>
}

interface SplitDraft { label: string; amountCents: number; method: string }

const METHODS = ['card', 'cash', 'keenu_qr'] as const                   // F-PAY02

export default function SplitPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()

  const { data: order } = useQuery({
    queryKey: ['order-split', id],
    queryFn: () => api.get<Order>(`/orders/${id}`),
  })

  const [mode, setMode] = useState<'even' | 'custom'>('even')
  const [ways, setWays] = useState(2)
  const [method, setMethod] = useState<typeof METHODS[number]>('card')
  const [drafts, setDrafts] = useState<SplitDraft[]>([])
  const [feedback, setFeedback] = useState<string | null>(null)

  useEffect(() => {
    if (!order || drafts.length > 0) return
    const base = Math.floor(order.totalCents / 2)
    setDrafts([
      { label: 'Diner 1', amountCents: base,                       method: 'card' },
      { label: 'Diner 2', amountCents: order.totalCents - base,    method: 'card' },
    ])
  }, [order, drafts.length])

  const splitEven = useMutation({
    mutationFn: () => api.post(`/check-split/orders/${id}/split-evenly`, { ways, method }),
    onSuccess: () => { setFeedback('Split created — settle each in POS.'); void qc.invalidateQueries({ queryKey: ['order-split', id] }) },
    onError: (e: { message?: string }) => setFeedback(e.message ?? 'Failed'),
  })

  const splitCustom = useMutation({
    mutationFn: () => api.post(`/check-split/orders/${id}/split`, { splits: drafts }),
    onSuccess: () => { setFeedback('Split created — settle each in POS.'); void qc.invalidateQueries({ queryKey: ['order-split', id] }) },
    onError: (e: { message?: string }) => setFeedback(e.message ?? 'Failed'),
  })

  const settle = useMutation({
    mutationFn: (paymentId: string) => api.post(`/check-split/payments/${paymentId}/settle`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['order-split', id] }),
  })

  if (!order) return <p className="p-6 text-s-muted text-sm">Loading…</p>

  const draftTotal = drafts.reduce((s, d) => s + d.amountCents, 0)
  const draftMatch = draftTotal === order.totalCents

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <Link href={`/orders/${id}`} className="text-xs text-s-muted hover:text-s-text">← Order</Link>
        <h1 className="text-xl font-bold text-s-text">Split the bill</h1>
        <p className="text-xs text-s-muted">Order total: <strong>{fmtPkr(order.totalCents)}</strong> · {order.concept.name}</p>
      </header>

      <div className="p-6 max-w-2xl space-y-4">
        {/* Existing splits */}
        {order.payments.length > 0 && (
          <div className="s-card overflow-hidden">
            <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-bold">Current splits</div>
            <table className="w-full text-sm">
              <tbody>
                {order.payments.map((p) => (
                  <tr key={p.id} className="border-t border-s-border">
                    <td className="px-4 py-2 font-mono text-xs text-s-muted">{p.splitLabel ?? `Payment ${p.splitGroup ?? 1}`}</td>
                    <td className="px-4 py-2 text-xs text-s-text">{p.method}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs">{fmtPkr(p.amountCents)}</td>
                    <td className="px-4 py-2"><span className={`text-[10px] uppercase font-bold tracking-wider ${p.status === 'paid' ? 'text-s-teal' : 'text-s-amber'}`}>{p.status}</span></td>
                    <td className="px-4 py-2 text-right">
                      {p.status === 'pending' && (
                        <button onClick={() => settle.mutate(p.id)} className="text-xs text-s-teal hover:underline">Settle →</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Mode toggle */}
        <div className="flex gap-2">
          <button onClick={() => setMode('even')} aria-pressed={mode === 'even'}
            className={`px-3 py-1.5 rounded-full text-xs font-bold border ${mode === 'even' ? 'bg-black text-white border-black' : 'bg-white border-s-border'}`}>
            Even split
          </button>
          <button onClick={() => setMode('custom')} aria-pressed={mode === 'custom'}
            className={`px-3 py-1.5 rounded-full text-xs font-bold border ${mode === 'custom' ? 'bg-black text-white border-black' : 'bg-white border-s-border'}`}>
            Custom amounts
          </button>
        </div>

        {mode === 'even' && (
          <div className="s-card p-4 space-y-3">
            <label className="block">
              <span className="text-xs text-s-muted">Number of ways</span>
              <input type="number" min={2} max={20} value={ways} onChange={(e) => setWays(parseInt(e.target.value, 10) || 2)}
                className="w-full mt-1 bg-white border border-s-border rounded px-2 py-1.5 text-sm" />
            </label>
            <label className="block">
              <span className="text-xs text-s-muted">Payment method</span>
              <select value={method} onChange={(e) => setMethod(e.target.value as typeof METHODS[number])}
                className="w-full mt-1 bg-white border border-s-border rounded px-2 py-1.5 text-sm">
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <p className="text-xs text-s-muted">
              Each diner pays <strong>{fmtPkr(Math.floor(order.totalCents / ways))}</strong> (residue to first {order.totalCents % ways} splits).
            </p>
            <button onClick={() => splitEven.mutate()} disabled={splitEven.isPending} className="s-btn-primary w-full">
              {splitEven.isPending ? 'Splitting…' : `Split ${ways} ways`}
            </button>
          </div>
        )}

        {mode === 'custom' && (
          <div className="s-card p-4 space-y-3">
            {drafts.map((d, i) => (
              <div key={i} className="grid grid-cols-[1fr_120px_120px_auto] gap-2 items-center">
                <input value={d.label} onChange={(e) => setDrafts(prev => prev.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
                  placeholder={`Split ${i + 1}`} className="bg-white border border-s-border rounded px-2 py-1.5 text-sm" />
                <input type="number" value={d.amountCents / 100}
                  onChange={(e) => setDrafts(prev => prev.map((x, j) => j === i ? { ...x, amountCents: Math.round(parseFloat(e.target.value || '0') * 100) } : x))}
                  className="bg-white border border-s-border rounded px-2 py-1.5 text-sm font-mono" />
                <select value={d.method}
                  onChange={(e) => setDrafts(prev => prev.map((x, j) => j === i ? { ...x, method: e.target.value } : x))}
                  className="bg-white border border-s-border rounded px-2 py-1.5 text-xs">
                  {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <button onClick={() => setDrafts(prev => prev.filter((_, j) => j !== i))}
                  className="text-s-red text-xs">Remove</button>
              </div>
            ))}
            <button onClick={() => setDrafts(prev => [...prev, { label: `Diner ${prev.length + 1}`, amountCents: 0, method: 'card' }])}
              className="text-xs text-s-teal hover:underline">+ Add another split</button>
            <p className={`text-xs font-bold ${draftMatch ? 'text-s-teal' : 'text-s-red'}`}>
              Sum: {fmtPkr(draftTotal)} · {draftMatch ? '✓ matches' : `must equal ${fmtPkr(order.totalCents)}`}
            </p>
            <button onClick={() => splitCustom.mutate()} disabled={splitCustom.isPending || !draftMatch} className="s-btn-primary w-full">
              {splitCustom.isPending ? 'Splitting…' : 'Apply custom split'}
            </button>
          </div>
        )}

        {feedback && <p className="text-xs text-s-muted">{feedback}</p>}
      </div>
    </div>
  )
}
