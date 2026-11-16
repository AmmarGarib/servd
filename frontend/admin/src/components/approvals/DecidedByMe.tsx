'use client'
// "Decided by you" (owner, 2026-11-16: approved POs "disappeared" — an approved item leaves the inbox). The caller's
// own recent decisions from GET /approvals/decided: what it was, which company, and where it is NOW, with a link.
import { useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'

interface DecidedRow {
  id: string; type: string; typeLabel: string; decision: string; decidedAt: string
  company: string | null; title: string | null; statusNow: string | null; amountCents: number | null; link: string | null
}

const card = { background: 'var(--surface)', border: '1px solid var(--border)' }
const verb = (d: string) => (d === 'approve' ? 'Approved' : d === 'reject' ? 'Rejected' : d === 'return' ? 'Returned' : d ? d.charAt(0).toUpperCase() + d.slice(1).replace(/_/g, ' ') : 'Decided')
const PO_NOW: Record<string, string> = {
  approved: 'With the buyer', sent: 'With the buyer', partial: 'Part-received', completed: 'To confirm receipt', received: 'Received',
  cancelled: 'Cancelled', draft: 'Draft', pending_approval: 'Waiting for the CEO',
}
// A cash voucher's own stages (never the PO's words: an approved voucher waits for finance to pay it).
const VOUCHER_NOW: Record<string, string> = {
  submitted: 'Waiting for finance', draft: 'Waiting for finance', finance_approved: 'Waiting for the CEO', hod_signed: 'Waiting for the CEO',
  approved: 'Approved — finance to pay', disbursed: 'Paid — documents due', posted: 'Paid and closed', settled: 'Paid and closed',
  returned: 'Returned for correction', rejected: 'Rejected', cancelled: 'Cancelled', converted: 'Closed',
}
const isVoucher = (t: string) => t === 'cash_voucher' || t === 'cash_request_finance'
const nowLabel = (type: string, s: string) =>
  s === 'not found' ? 'No longer exists'
    : (isVoucher(type) ? VOUCHER_NOW[s] : type === 'purchase_order' ? PO_NOW[s] : undefined) ?? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ')
const pkr = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`
const when = (iso: string) => new Date(iso).toLocaleString('en-PK', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

export function DecidedByMe({ rootKey }: { rootKey: string }) {
  const [open, setOpen] = useState(false)
  const { data = [], isLoading, error } = useQuery({
    queryKey: [rootKey, 'decided'],
    queryFn: () => api.get<DecidedRow[]>('/approvals/decided?days=30'),
    enabled: open,
  })
  return (
    <div className="mt-6 rounded-2xl" style={card}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left">
        <span>
          <span className="block text-sm font-black text-white/85">Decided by you — last 30 days</span>
          <span className="block text-xs text-white/50">What you approved, returned or rejected, and where each one is now.</span>
        </span>
        <span className="text-xs font-bold shrink-0" style={{ color: 'var(--erp-primary-ink)' }}>{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4">
          {isLoading && <p className="text-sm text-white/50">Loading…</p>}
          {error && <p className="text-sm text-s-red">{(error as Error).message}</p>}
          {!isLoading && !error && data.length === 0 && <p className="text-sm text-white/50">Nothing decided in the last 30 days.</p>}
          <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {data.map((r) => (
              <li key={r.id} className="py-2.5 flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-sm font-bold text-white/85 break-words">{r.title ?? r.typeLabel}</p>
                  <p className="text-xs text-white/50 break-words">
                    {r.typeLabel}{r.company ? ` · ${r.company}` : ''}{r.amountCents != null ? ` · ${pkr(r.amountCents)}` : ''}
                  </p>
                </div>
                <div className="text-xs sm:text-right">
                  <p className="font-bold text-white/75">{verb(r.decision)} · {when(r.decidedAt)}</p>
                  <p className="text-white/50">
                    {r.statusNow ? `Now: ${nowLabel(r.type, r.statusNow)}` : ''}
                    {r.link && (
                      <Link href={r.link} className="font-bold hover:underline ml-2" style={{ color: 'var(--erp-primary-ink)' }}>Open</Link>
                    )}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          {data.some((r) => r.company) && (
            <p className="text-xs text-white/45 mt-2">An item lives in the company shown beside it — pick that company at the top to see it in its own list.</p>
          )}
        </div>
      )}
    </div>
  )
}
