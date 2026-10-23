'use client'

// Check-splitting screen. Two flows:
//   1. Even — pick "n ways", system divides equally with residue to first
//   2. Custom — operator types each split's amount + label
//
// On submit, /check-split/orders/:id/split or /split-evenly creates a Payment
// per split (status='pending'). POS settles each independently afterward.
//
// Tenders (owner, 2026-10-12): Card – Keenu, Cash, Raast QR. Keenu QR is
// retired: a pending Keenu QR portion from before the cutover cannot be
// settled (422 KEENU_QR_RETIRED) — take the rest with Pay at the till. A Raast
// portion is settled with an inline form: the bank reference from the COUNTER
// phone and the "I saw it arrive" tick (never the customer's screen).

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { api, posApi } from '../../../../lib/api'
import { fmtPkr } from '../../../../lib/money'
import {
  KEENU_QR_CUTOVER_NOTE, RAAST_COUNTER_WARNING, normalizeRaastRef, raastRefProblem, settlePortion, tenderLabel, tillErrorMessage, useRaastConfig,
} from '../../../../components/pos/tillApi'
import { Select } from '@/components/ui/Select'

interface Order {
  id: string; totalCents: number; conceptId?: string; concept: { name: string }
  payments: Array<{ id: string; amountCents: number; status: string; splitGroup: number | null; splitLabel: string | null; method: string }>
}

interface SplitDraft { label: string; amountCents: number; method: string }

const METHODS = ['card', 'cash', 'raast'] as const                   // F-PAY02; Keenu QR retired 2026-10-12

export default function SplitPage() {
  const { id } = useParams<{ id: string }>()
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

  // Settling a split takes the money on the cashier's open drawer; a card
  // split needs the terminal's reference (owner decision 4), a Raast split
  // the bank reference and the counter-phone tick.
  // GET /pos/shifts/current answers { shift: {…} | null } (UI-1).
  const { data: currentShift } = useQuery({ queryKey: ['pos', 'current-shift'], queryFn: () => posApi.currentShift() })
  const shiftId = currentShift?.shift?.id ?? null
  const [settling, setSettling] = useState<{ paymentId: string; method: string } | null>(null)
  const [ref, setRef] = useState('')
  const [seen, setSeen] = useState(false)
  const settle = useMutation({
    mutationFn: ({ paymentId, method }: { paymentId: string; method: string }) => {
      if (!shiftId) throw new Error('Open a shift at the till before settling a split.')
      return settlePortion(paymentId, {
        shiftId,
        ...(method === 'card' && { gatewayRef: ref.trim() }),
        ...(method === 'raast' && { gatewayRef: normalizeRaastRef(ref), raastVerified: true as const }),
      })
    },
    onSuccess: () => {
      setSettling(null); setRef(''); setSeen(false)
      void qc.invalidateQueries({ queryKey: ['order-split', id] })
    },
  })
  const hasRaastPortion = !!order?.payments.some((p) => p.status === 'pending' && p.method === 'raast')
  const raastConfig = useRaastConfig(shiftId, order?.conceptId, hasRaastPortion)
  const raast = raastConfig.data ?? null

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

      <div className="p-6 max-w-2xl mx-auto space-y-4">
        {/* Existing splits */}
        {order.payments.length > 0 && (
          <div className="s-card overflow-hidden">
            <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-bold">Current splits</div>
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {order.payments.map((p) => (
                  <tr key={p.id} className="border-t border-s-border">
                    <td className="px-4 py-2 font-mono text-xs text-s-muted">{p.splitLabel ?? `Payment ${p.splitGroup ?? 1}`}</td>
                    <td className="px-4 py-2 text-xs text-s-text">{tenderLabel(p.method)}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs">{fmtPkr(p.amountCents)}</td>
                    <td className="px-4 py-2"><span className={`text-[10px] uppercase font-bold tracking-wider ${p.status === 'paid' ? 'text-primary-ink' : 'text-s-amber'}`}>{p.status}</span></td>
                    <td className="px-4 py-2 text-right">
                      {p.status === 'pending' && p.method === 'keenu_qr' ? (
                        <span className="text-[11px] text-s-amber">Retired — take the rest with Pay</span>
                      ) : p.status === 'pending' && (
                        <button onClick={() => {
                          settle.reset()
                          // Cash settles at once; card and Raast take a reference first (inline below).
                          if (p.method === 'cash') { setSettling(null); settle.mutate({ paymentId: p.id, method: 'cash' }); return }
                          setRef(''); setSeen(false)
                          setSettling({ paymentId: p.id, method: p.method })
                        }} className="text-xs text-primary-ink hover:underline">Settle →</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {order.payments.some((p) => p.status === 'pending' && p.method === 'keenu_qr') && (
              <p className="border-t border-s-border px-4 py-2 text-xs text-s-amber">
                Keenu QR is retired. Take the rest of this bill with Pay at the till (cash, Card – Keenu or Raast QR). {KEENU_QR_CUTOVER_NOTE}
              </p>
            )}
            {settling && (() => {
              const portion = order.payments.find((p) => p.id === settling.paymentId)
              if (!portion) return null
              const isRaast = settling.method === 'raast'
              const rule = raast?.refRule ?? { min: 6, max: 35 }
              const problem = isRaast ? raastRefProblem(ref, rule, order.id) : null
              const raastBlocked = isRaast && !!raast && !raast.available
              return (
                <form
                  className="space-y-3 border-t border-s-border px-4 py-3"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (settle.isPending || !ref.trim() || problem || raastBlocked || (isRaast && !seen)) return
                    settle.mutate({ paymentId: portion.id, method: settling.method })
                  }}
                >
                  <p className="text-sm font-bold text-s-text">
                    Settle {portion.splitLabel ?? 'this split'} — {tenderLabel(settling.method)} {fmtPkr(portion.amountCents)}
                  </p>
                  {isRaast && (
                    <>
                      <div className="rounded-lg border border-s-amber bg-s-amber-dim px-3 py-2" role="note">
                        <p className="text-xs font-bold uppercase tracking-wider text-s-amber">Check the counter phone</p>
                        <p className="mt-1 text-sm text-s-text">{raast?.warning || RAAST_COUNTER_WARNING}</p>
                      </div>
                      {raast?.account && (
                        <p className="text-xs text-s-muted">
                          To {[raast.account.accountTitle, raast.account.bankName, raast.account.last4 ? `account ending ${raast.account.last4}` : null].filter(Boolean).join(' · ')}
                          {raast.account.raastId && <> · Raast ID <span className="font-mono">{raast.account.raastId}</span></>}
                        </p>
                      )}
                      {raastBlocked && (
                        <p className="text-sm font-semibold text-s-red" role="alert">
                          Raast is not set up for {order.concept.name} — finance sets the receiving account in Finance → Bank accounts.
                        </p>
                      )}
                    </>
                  )}
                  <label className="block">
                    <span className="text-xs text-s-muted">
                      {isRaast ? 'Bank reference (transaction ID) from the bank SMS or merchant app' : 'Terminal reference from the card machine slip'}
                    </span>
                    <input value={ref} onChange={(e) => { setRef(e.target.value); settle.reset() }} autoFocus autoComplete="off" spellCheck={false} maxLength={64}
                      className="mt-1 w-full rounded border border-s-border bg-s-surface px-2 py-1.5 font-mono text-sm" />
                  </label>
                  {problem && ref.trim() && <p className="text-xs text-s-amber">{problem}</p>}
                  {isRaast && (
                    <label className="flex items-start gap-2 text-sm text-s-text">
                      <input type="checkbox" checked={seen} onChange={(e) => setSeen(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>I saw {fmtPkr(portion.amountCents)} arrive on the counter phone (not the customer’s screen).</span>
                    </label>
                  )}
                  <div className="flex gap-2">
                    <button type="submit" className="s-btn-primary flex-1"
                      disabled={settle.isPending || !ref.trim() || !!problem || raastBlocked || (isRaast && !seen)}>
                      {settle.isPending ? 'Settling…' : `Settle ${fmtPkr(portion.amountCents)}`}
                    </button>
                    <button type="button" onClick={() => { setSettling(null); settle.reset() }}
                      className="flex-1 rounded border border-s-border px-3 py-1.5 text-sm text-s-muted hover:text-s-text">
                      Cancel
                    </button>
                  </div>
                </form>
              )
            })()}
            {settle.isError && (
              <p className="border-t border-s-border px-4 py-2 text-sm text-s-red" role="alert">{tillErrorMessage(settle.error, 'Could not settle that split')}</p>
            )}
          </div>
        )}

        {/* Mode toggle */}
        <div className="flex gap-2">
          <button onClick={() => setMode('even')} aria-pressed={mode === 'even'}
            className={`px-3 py-1.5 rounded-full text-xs font-bold border ${mode === 'even' ? 'bg-primary text-primary-on border-primary' : 'bg-s-surface border-s-border'}`}>
            Even split
          </button>
          <button onClick={() => setMode('custom')} aria-pressed={mode === 'custom'}
            className={`px-3 py-1.5 rounded-full text-xs font-bold border ${mode === 'custom' ? 'bg-primary text-primary-on border-primary' : 'bg-s-surface border-s-border'}`}>
            Custom amounts
          </button>
        </div>

        {mode === 'even' && (
          <div className="s-card p-4 space-y-3">
            <label className="block">
              <span className="text-xs text-s-muted">Number of ways</span>
              <input type="number" min={2} max={20} value={ways} onChange={(e) => setWays(parseInt(e.target.value, 10) || 2)}
                className="w-full mt-1 bg-s-surface border border-s-border rounded px-2 py-1.5 text-sm" />
            </label>
            <label className="block">
              <span className="text-xs text-s-muted">Payment method</span>
              <Select value={method} onChange={(e) => setMethod(e.target.value as typeof METHODS[number])}
                className="w-full mt-1 bg-s-surface border border-s-border rounded px-2 py-1.5 text-sm">
                {METHODS.map((m) => <option key={m} value={m}>{tenderLabel(m)}</option>)}
              </Select>
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
                  placeholder={`Split ${i + 1}`} className="bg-s-surface border border-s-border rounded px-2 py-1.5 text-sm" />
                <input type="number" value={d.amountCents / 100}
                  onChange={(e) => setDrafts(prev => prev.map((x, j) => j === i ? { ...x, amountCents: Math.round(parseFloat(e.target.value || '0') * 100) } : x))}
                  className="bg-s-surface border border-s-border rounded px-2 py-1.5 text-sm font-mono" />
                <Select value={d.method}
                  onChange={(e) => setDrafts(prev => prev.map((x, j) => j === i ? { ...x, method: e.target.value } : x))}
                  className="bg-s-surface border border-s-border rounded px-2 py-1.5 text-xs">
                  {METHODS.map((m) => <option key={m} value={m}>{tenderLabel(m)}</option>)}
                </Select>
                <button onClick={() => setDrafts(prev => prev.filter((_, j) => j !== i))}
                  className="text-s-red text-xs">Remove</button>
              </div>
            ))}
            <button onClick={() => setDrafts(prev => [...prev, { label: `Diner ${prev.length + 1}`, amountCents: 0, method: 'card' }])}
              className="text-xs text-primary-ink hover:underline">+ Add another split</button>
            <p className={`text-xs font-bold ${draftMatch ? 'text-success' : 'text-s-red'}`}>
              Sum: {fmtPkr(draftTotal)} · {draftMatch ? 'matches' : `must equal ${fmtPkr(order.totalCents)}`}
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
