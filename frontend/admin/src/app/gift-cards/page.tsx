'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Fragment, useState } from 'react'
import Link from 'next/link'
import { api } from '../../lib/api'
import { fmtPkr } from '../../lib/money'
import { useAuthStore } from '../../store/auth'

interface GiftCard {
  id: string; code: string
  issuedAmountCents: number; balanceCents: number
  status: 'active' | 'redeemed_full' | 'expired' | 'voided'
  buyerEmail: string | null; recipientName: string | null
  expiresAt: string | null; createdAt: string
}

interface CardHistory {
  card: { id: string; code: string; issuedAmountCents: number; balanceCents: number; status: GiftCard['status']; voidedAt: string | null; voidReason: string | null }
  redemptions: Array<{ id: string; amountCents: number; balanceAfter: number; redeemedAt: string; reversedAt: string | null; order: { id: string; placedAt: string; status: string } | null }>
}

const STATUS_COLOR: Record<GiftCard['status'], string> = {
  active:        'bg-primary text-primary-on',
  redeemed_full: 'bg-s-border-strong text-s-text',
  expired:       'bg-s-amber text-[#fff]',
  voided:        'bg-s-red text-[#fff]',
}

export default function GiftCardsPage() {
  const qc = useQueryClient()
  const [showNew, setShowNew] = useState(false)
  const [redeemCode, setRedeemCode] = useState('')
  const [redeemAmt,  setRedeemAmt]  = useState<number | ''>('')
  const [redeemOrder, setRedeemOrder] = useState('')
  const [feedback,   setFeedback]   = useState<{ ok: boolean; msg: string } | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  // The books' audit trail is the CEO's and management's (accounting_audit);
  // everyone else reads a card's history in the row below instead.
  const canReadBooksTrail = useAuthStore((s) => s.isRole('admin', 'management'))

  const { data, isLoading } = useQuery({
    queryKey: ['gift-cards'],
    queryFn: () => api.get<GiftCard[]>('/gift-cards'),
  })

  // A card is always spent against an order (the one redeem engine lowers
  // that order's bill by what the card paid; a till sale the card fully
  // covers is closed). Cards of another company are not found (decision 14).
  const redeem = useMutation({
    mutationFn: () => api.post<{ appliedCents: number; remainingDueCents: number; completed: boolean }>('/gift-cards/redeem', {
      code: redeemCode,
      orderId: redeemOrder.trim(),
      ...(redeemAmt ? { amountCents: Math.round(Number(redeemAmt) * 100) } : {}),
    }),
    onSuccess: (r) => {
      setFeedback({ ok: true, msg: `Applied ${fmtPkr(r.appliedCents)}. ${r.completed ? 'Bill settled.' : `Still due: ${fmtPkr(r.remainingDueCents)}.`}` })
      void qc.invalidateQueries({ queryKey: ['gift-cards'] })
      setRedeemCode(''); setRedeemAmt(''); setRedeemOrder('')
    },
    onError: (e: { message?: string }) => setFeedback({ ok: false, msg: e.message ?? 'Failed' }),
  })

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between">
        <div>
          <p className="text-xs text-s-muted">Finance</p>
          <h1 className="text-xl font-bold text-s-text">Gift cards</h1>
        </div>
        <button onClick={() => setShowNew(true)} className="s-btn-primary text-xs">+ Issue card</button>
      </header>

      <div className="p-6 max-w-5xl mx-auto space-y-4">
        {/* Quick redeem */}
        <div className="s-card p-4">
          <h2 className="text-sm font-bold mb-1">Apply a card to an order</h2>
          <p className="text-xs text-s-muted mb-3">At the till, use the gift-card tender on the bill. Here: the order it pays for, and optionally how much (blank = as much as the card and the bill allow).</p>
          <div className="flex gap-2 flex-wrap items-end">
            <label className="flex-1 min-w-[220px]">
              <span className="block text-xs text-s-muted mb-1">Order ID</span>
              <input value={redeemOrder} onChange={(e) => setRedeemOrder(e.target.value)} placeholder="order id" className="w-full bg-s-surface border border-s-border rounded px-2 py-1.5 text-sm font-mono" />
            </label>
            <label className="flex-1 min-w-[160px]">
              <span className="block text-xs text-s-muted mb-1">Card code</span>
              <input value={redeemCode} onChange={(e) => setRedeemCode(e.target.value)} placeholder="GS-XXXX-XXXX" className="w-full bg-s-surface border border-s-border rounded px-2 py-1.5 text-sm font-mono uppercase" />
            </label>
            <label className="w-32">
              <span className="block text-xs text-s-muted mb-1">Amount (PKR)</span>
              <input type="number" min={1} value={redeemAmt} onChange={(e) => setRedeemAmt(e.target.value === '' ? '' : Number(e.target.value))} className="w-full bg-s-surface border border-s-border rounded px-2 py-1.5 text-sm" />
            </label>
            <button onClick={() => redeem.mutate()} disabled={!redeemCode.trim() || !redeemOrder.trim() || redeem.isPending} className="s-btn-primary text-sm">
              {redeem.isPending ? 'Applying…' : 'Apply'}
            </button>
          </div>
          {feedback && <p className={`text-xs mt-2 ${feedback.ok ? 'text-primary-ink' : 'text-s-red'}`}>{feedback.msg}</p>}
        </div>

        {/* List */}
        <div className="s-card overflow-hidden">
          <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-bold text-s-text">All cards</div>
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-s-muted">
              <tr>
                <th className="px-4 py-2 text-left">Code</th>
                <th className="px-4 py-2 text-left">Recipient</th>
                <th className="px-4 py-2 text-right">Balance</th>
                <th className="px-4 py-2 text-right">Issued</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Issued at</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={6} className="px-4 py-6 text-center text-xs text-s-muted">Loading…</td></tr>}
              {!isLoading && (data ?? []).length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-xs text-s-muted">No gift cards issued yet.</td></tr>
              )}
              {(data ?? []).map((c) => (
                <Fragment key={c.id}>
                <tr className={`border-t border-s-border cursor-pointer ${openId === c.id ? 'bg-s-bg-soft' : 'hover:bg-s-bg-soft'}`}
                  onClick={() => setOpenId(openId === c.id ? null : c.id)} aria-expanded={openId === c.id}>
                  <td className="px-4 py-2 font-mono text-xs">{c.code}</td>
                  <td className="px-4 py-2 text-xs text-s-text">
                    {c.recipientName ?? '—'}
                    {c.buyerEmail && <p className="text-[11px] text-s-dim">via {c.buyerEmail}</p>}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs">{fmtPkr(c.balanceCents)}</td>
                  <td className="px-4 py-2 text-right text-xs text-s-muted">{fmtPkr(c.issuedAmountCents)}</td>
                  <td className="px-4 py-2"><span className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full ${STATUS_COLOR[c.status]}`}>{c.status.replace('_', ' ')}</span></td>
                  <td className="px-4 py-2 text-xs text-s-muted">{new Date(c.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                </tr>
                {openId === c.id && (
                  <tr className="border-t border-s-border/50">
                    <td colSpan={6} className="p-0"><CardHistoryPanel id={c.id} /></td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
          </div>
        </div>

        <p className="text-xs text-s-muted">
          Click a card for what was spent from it and what refunds put back.
          {canReadBooksTrail && <> Who issued or voided it is in the <Link href="/accounting/audit-log?action=giftcard" className="text-primary-ink hover:underline">audit log</Link>.</>}
        </p>
      </div>

      {showNew && <NewGiftCardModal onClose={() => setShowNew(false)} onCreated={() => { void qc.invalidateQueries({ queryKey: ['gift-cards'] }); setShowNew(false) }} />}
    </div>
  )
}

// One card's own ledger: GET /gift-cards/:id/redemptions (the card's company
// only). A reversed line is a redemption a refund put back on the card.
function CardHistoryPanel({ id }: { id: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['gift-card-history', id],
    queryFn: () => api.get<CardHistory>(`/gift-cards/${id}/redemptions`),
  })
  if (isLoading) return <p className="px-4 py-3 text-xs text-s-muted">Loading history…</p>
  if (error || !data) return <p className="px-4 py-3 text-xs text-s-red">{(error as Error | null)?.message ?? 'Could not load this card'}</p>
  return (
    <div className="px-4 py-3 bg-s-bg-soft/40 text-xs space-y-1">
      <p className="text-s-muted">
        Issued {fmtPkr(data.card.issuedAmountCents)} · balance {fmtPkr(data.card.balanceCents)}
        {data.card.voidedAt && <> · voided {new Date(data.card.voidedAt).toLocaleDateString('en-GB')}{data.card.voidReason ? ` (${data.card.voidReason})` : ''}</>}
      </p>
      {data.redemptions.length === 0 && <p className="text-s-muted">Not spent yet.</p>}
      {data.redemptions.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-x-3">
          <span className="font-mono">-{fmtPkr(r.amountCents)}</span>
          <span className="text-s-muted">{new Date(r.redeemedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          {r.order && <Link href={`/orders/${r.order.id}`} className="text-primary-ink hover:underline">order</Link>}
          <span className="text-s-muted">balance after {fmtPkr(r.balanceAfter)}</span>
          {r.reversedAt && <span className="text-s-muted">· put back by a refund {new Date(r.reversedAt).toLocaleDateString('en-GB')}</span>}
        </div>
      ))}
    </div>
  )
}

function NewGiftCardModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [amount,   setAmount]   = useState(2000)
  const [recipient, setRecipient] = useState('')
  const [recEmail, setRecEmail] = useState('')
  const [buyerEmail, setBuyerEmail] = useState('')
  const [message,  setMessage]  = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'bank_transfer'>('card')
  const [err, setErr] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => api.post<{ code: string }>('/gift-cards', {
      issuedAmountCents: amount * 100,
      recipientName: recipient.trim() || null,
      recipientEmail: recEmail.trim() || null,
      buyerEmail: buyerEmail.trim() || null,
      message: message.trim() || null,
      paymentMethod,
    }),
    onSuccess: (c) => { alert(`Card issued: ${c.code}`); onCreated() },
    onError: (e: { message?: string }) => setErr(e.message ?? 'Failed'),
  })

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 bg-secondary/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-s-surface rounded-2xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-s-border flex justify-between">
          <h2 className="text-lg font-bold">Issue gift card</h2>
          <button onClick={onClose} className="text-2xl leading-none text-s-muted">×</button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <label className="block">
            <span className="text-xs text-s-muted">Amount (PKR)</span>
            <input type="number" min={100} max={100000} value={amount} onChange={(e) => setAmount(Number(e.target.value))} className="w-full mt-1 bg-s-surface border border-s-border rounded px-2 py-1.5" />
          </label>
          <label className="block">
            <span className="text-xs text-s-muted">Recipient name</span>
            <input value={recipient} onChange={(e) => setRecipient(e.target.value)} className="w-full mt-1 bg-s-surface border border-s-border rounded px-2 py-1.5" />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs text-s-muted">Recipient email</span>
              <input type="email" value={recEmail} onChange={(e) => setRecEmail(e.target.value)} className="w-full mt-1 bg-s-surface border border-s-border rounded px-2 py-1.5" />
            </label>
            <label className="block">
              <span className="text-xs text-s-muted">Buyer email</span>
              <input type="email" value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} className="w-full mt-1 bg-s-surface border border-s-border rounded px-2 py-1.5" />
            </label>
          </div>
          <label className="block">
            <span className="text-xs text-s-muted">Message (optional)</span>
            <textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} className="w-full mt-1 bg-s-surface border border-s-border rounded px-2 py-1.5" />
          </label>
          <label className="block">
            <span className="text-xs text-s-muted">Payment</span>
            <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as typeof paymentMethod)} className="w-full mt-1 bg-s-surface border border-s-border rounded px-2 py-1.5">
              <option value="card">Card</option>
              <option value="cash">Cash</option>
              <option value="bank_transfer">Bank transfer</option>
            </select>
          </label>
          {err && <p className="text-xs text-s-red">{err}</p>}
        </div>
        <div className="px-5 py-3 border-t border-s-border flex justify-end gap-2">
          <button onClick={onClose} className="s-btn-secondary text-sm">Cancel</button>
          <button onClick={() => create.mutate()} disabled={create.isPending || amount < 100} className="s-btn-primary text-sm">
            {create.isPending ? 'Issuing…' : `Issue · PKR ${amount.toLocaleString('en-PK')}`}
          </button>
        </div>
      </div>
    </div>
  )
}
