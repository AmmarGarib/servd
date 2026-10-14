'use client'
// Cash requests — anyone asks for cash (owner, 2026-10-13; accountant H3,
// 2026-10-14: "expense at payment; receipts kept for the file").
//
// Anyone raises a request naming its expense category; the HOD (the holder's
// reporting manager, or finance) signs; the director (CEO) approves; the
// cashier who holds the cash box pays it — that books it to the category at
// once — and the holder uploads the receipts. Receipts showing another
// category, stock or equipment move the money there; change goes back in a
// box. The paper stays the "Cash payment voucher" (CV numbers).
//
// API: /trustops/cash-vouchers (backend modules/trustops/cashVouchers.ts).
// Every row carries this login's capability flags; the views are built from
// them. One request: ./[id] (the approvals inbox links there).

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { formatPkr } from './amountInWords'
import { CV_ROOT, errorWords, fmtDate, useVouchers, type CashVoucher } from './data'
import { VoucherForm } from './VoucherForm'
import { Chip, ErrorBanner, StatusBadge } from './ui'

export default function CashRequestsPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-white/40">Loading…</div>}>
      <CashRequests />
    </Suspense>
  )
}

type View = 'mine' | 'hod' | 'director' | 'to_pay' | 'receipts_due' | 'overdue' | 'settled' | 'needs_review' | 'all'

const VIEWS: Array<{ id: View; label: string; test: (v: CashVoucher) => boolean; keeperOnly?: boolean }> = [
  { id: 'mine', label: 'My requests', test: (v) => v.isMine },
  { id: 'hod', label: 'Waiting for my signature', test: (v) => v.canSignHod },
  { id: 'director', label: 'Waiting for director', test: (v) => v.status === 'hod_signed' },
  { id: 'to_pay', label: 'To pay', test: (v) => v.canPay },
  { id: 'receipts_due', label: 'Receipts due', test: (v) => v.status === 'disbursed' && v.canUploadReceipts && v.remainingCents > 0 },
  { id: 'overdue', label: 'Overdue', test: (v) => v.overdue },
  { id: 'settled', label: 'Settled', test: (v) => v.status === 'settled' },
  { id: 'needs_review', label: 'Needs review', test: (v) => v.needsReview, keeperOnly: true },
  { id: 'all', label: 'All', test: () => true },
]

function CashRequests() {
  const router = useRouter()
  const params = useSearchParams()
  const qc = useQueryClient()

  // An old-style link (?id=…) opens the request's own page.
  const linkedId = params?.get('id')
  useEffect(() => { if (linkedId) router.replace(`/finance/cash-vouchers/${linkedId}`) }, [linkedId, router])

  const initial = (params?.get('view') ?? '') as View
  const [view, setView] = useState<View | null>(VIEWS.some((x) => x.id === initial) ? initial : null)
  const [creating, setCreating] = useState(false)
  const { data, isLoading, error } = useVouchers()
  const keeper = !!data?.keeper
  const items = useMemo(() => data?.items ?? [], [data])

  const counts = useMemo(() => Object.fromEntries(VIEWS.map((x) => [x.id, items.filter(x.test).length])) as Record<View, number>, [items])
  // Open on what needs this login first.
  const current: View = view ?? (counts.hod > 0 ? 'hod' : counts.to_pay > 0 ? 'to_pay' : counts.receipts_due > 0 && !keeper ? 'receipts_due' : keeper ? 'all' : 'mine')
  const test = VIEWS.find((x) => x.id === current)!.test
  const rows = useMemo(
    () => items.filter(test).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
    [items, test],
  )
  const shown = VIEWS.filter((x) => (!x.keeperOnly || keeper) && (x.id === 'all' || x.id === 'mine' || counts[x.id] > 0 || x.id === current))

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-4 sm:px-7 py-6 border-b border-white/[0.05]">
        {keeper && <Link href="/finance/petty-cash" className="text-xs text-white/40 hover:text-white/70">← Petty cash</Link>}
        <div className="flex items-start justify-between gap-4 mt-2 flex-wrap">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-success">Finance</p>
            <h1 className="text-2xl font-black text-white/90">Cash requests</h1>
            <p className="text-sm text-white/45 mt-1 max-w-2xl">
              Ask for cash here. Your HOD signs, the director approves, the cashier pays you. Keep the receipts and upload them on the
              request; hand back any change.
            </p>
          </div>
          <button onClick={() => setCreating(true)} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">
            + Request cash
          </button>
        </div>
      </header>

      <div className="px-4 sm:px-7 py-6 max-w-6xl mx-auto">
        <div className="flex flex-wrap gap-2">
          {shown.map((x) => <Chip key={x.id} on={current === x.id} onClick={() => setView(x.id)} label={x.label} count={counts[x.id]} />)}
        </div>

        {data?.truncated && (
          <p className="mt-2 text-xs text-white/45">Showing the newest {items.length} requests — counts cover these only.</p>
        )}

        <div className="mt-5">
          {isLoading && <p className="text-sm text-white/40">Loading…</p>}
          {error && <ErrorBanner message={`Could not load cash requests: ${errorWords(error)}`} />}
          {!isLoading && !error && rows.length === 0 && (
            <div className="rounded-2xl p-10 text-center" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
              <p className="font-bold text-white/85">Nothing in &ldquo;{VIEWS.find((x) => x.id === current)!.label}&rdquo;</p>
              {current === 'mine' && <p className="text-sm text-white/45 mt-1">Need cash for work? Request it — it goes to your HOD first.</p>}
            </div>
          )}

          {rows.length > 0 && (
            <>
              {/* Phones: one card per request */}
              <div className="space-y-2 sm:hidden">
                {rows.map((v) => (
                  <Link key={v.id} href={`/finance/cash-vouchers/${v.id}`} className="block s-card-hover p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="mono text-xs font-bold text-white/60">{v.number}</span>
                      <span className="flex items-center gap-1">
                        {v.overdue && <span className="s-badge-red">Overdue</span>}
                        <StatusBadge stage={v.stage} />
                      </span>
                    </div>
                    <div className="mt-1 flex items-baseline justify-between gap-2">
                      <span className="font-bold text-white/85 truncate">{v.holderName ?? v.payeeName}</span>
                      <span className="font-black text-white/90 shrink-0">PKR {formatPkr(v.amountCents)}</span>
                    </div>
                    <p className="text-xs text-white/50 truncate">{v.purpose}</p>
                    <p className="text-[11px] text-white/35 mt-0.5">
                      {fmtDate(v.voucherDate)}{v.status === 'disbursed' && v.remainingCents > 0 ? ` · PKR ${formatPkr(v.remainingCents)} open` : ''}
                    </p>
                  </Link>
                ))}
              </div>

              {/* Wider screens: a table */}
              <div className="hidden sm:block s-card overflow-x-auto">
                <table className="s-table">
                  <thead>
                    <tr>
                      <th>No.</th>
                      <th>Needed on</th>
                      <th>For</th>
                      <th className="!text-right">Amount (PKR)</th>
                      <th className="!text-right">Open</th>
                      <th>Purpose</th>
                      <th>Step</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((v) => (
                      <tr key={v.id} className="cursor-pointer" onClick={() => router.push(`/finance/cash-vouchers/${v.id}`)}>
                        <td>
                          <Link href={`/finance/cash-vouchers/${v.id}`} onClick={(e) => e.stopPropagation()} className="mono text-xs font-bold text-primary-ink hover:underline">
                            {v.number}
                          </Link>
                        </td>
                        <td className="text-white/60">{fmtDate(v.voucherDate)}</td>
                        <td className="font-semibold">{v.holderName ?? v.payeeName}</td>
                        <td className="text-right font-black tabular-nums">{formatPkr(v.amountCents)}</td>
                        <td className="text-right tabular-nums text-white/60">{v.status === 'disbursed' ? formatPkr(v.remainingCents) : '—'}</td>
                        <td className="max-w-[22rem] truncate text-white/60" title={v.purpose}>{v.purpose}</td>
                        <td>
                          <span className="flex items-center gap-1">
                            <StatusBadge stage={v.stage} />
                            {v.overdue && <span className="s-badge-red">Overdue</span>}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>

      {creating && (
        <VoucherForm isKeeper={keeper} onClose={() => setCreating(false)}
          onSaved={(v) => {
            setCreating(false)
            void qc.invalidateQueries({ queryKey: [CV_ROOT] })
            if (v?.id) router.push(`/finance/cash-vouchers/${v.id}`)
          }} />
      )}
    </div>
  )
}
