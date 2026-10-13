'use client'
// Cash vouchers — GS Foods' internal cash payment voucher (owner, 2026-10-13).
//
// The HOD prepares the voucher here and signs it, the director (CEO) approves
// it, it is printed, the cashier (the cash box's custodian) signs the paper
// and pays, and a photo of the signed paper is uploaded. Only that upload puts
// it in cash: it becomes one petty-cash spend on its box. Making, signing or
// printing a voucher never touches cash.
//
// API: /trustops/cash-vouchers (backend modules/trustops/cashVouchers.ts).
// One voucher: ./[id] (the approvals inbox links there).

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { usePermissions } from '../../../hooks/useCan'
import { useAuthStore } from '../../../store/auth'
import { formatPkr } from './amountInWords'
import { CV_ROOT, STATUSES, STATUS_META, errorWords, fmtDate, usePettyBoxes, useVouchers, type VoucherStatus } from './data'
import { VoucherForm } from './VoucherForm'
import { Chip, ErrorBanner, StatusBadge } from './ui'

export default function CashVouchersPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-white/40">Loading…</div>}>
      <CashVouchers />
    </Suspense>
  )
}

function CashVouchers() {
  const router = useRouter()
  const params = useSearchParams()
  const qc = useQueryClient()
  const { data: me } = usePermissions()
  const role = useAuthStore((s) => s.user?.role)
  const isCeo = (me?.role ?? role) === 'admin'
  // Cash keepers read the boxes; a cashier who only holds a box (403 there)
  // sees the vouchers to pay from it and never prepares one.
  const { isSuccess: isKeeper } = usePettyBoxes()

  // An old-style link (?id=…) opens the voucher's own page.
  const linkedId = params?.get('id')
  useEffect(() => { if (linkedId) router.replace(`/finance/cash-vouchers/${linkedId}`) }, [linkedId, router])

  const initial = params?.get('status')
  const [filter, setFilter] = useState<VoucherStatus | 'all'>(
    initial && (STATUSES as string[]).includes(initial) ? (initial as VoucherStatus) : 'all',
  )
  const [creating, setCreating] = useState(false)
  const { data, isLoading, error } = useVouchers()
  const vouchers = useMemo(() => data?.items ?? [], [data])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const v of vouchers) c[v.status] = (c[v.status] ?? 0) + 1
    return c
  }, [vouchers])
  const rows = useMemo(
    () => vouchers
      .filter((v) => filter === 'all' || v.status === filter)
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
    [vouchers, filter],
  )
  const waitingOnMe = isCeo ? (counts['hod_signed'] ?? 0) : 0
  const toPay = counts['approved'] ?? 0

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-4 sm:px-7 py-6 border-b border-white/[0.05]">
        <Link href="/finance/petty-cash" className="text-xs text-white/40 hover:text-white/70">← Petty cash</Link>
        <div className="flex items-start justify-between gap-4 mt-2 flex-wrap">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-success">Finance</p>
            <h1 className="text-2xl font-black text-white/90">Cash vouchers</h1>
            <p className="text-sm text-white/45 mt-1 max-w-2xl">
              The HOD prepares and signs, the director approves, the cashier pays against the printed voucher and signs it.
              Uploading the photo of the signed voucher is what puts it in cash — one petty-cash spend on its box.
            </p>
          </div>
          {(isKeeper || isCeo) && (
            <button onClick={() => setCreating(true)} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">
              + New voucher
            </button>
          )}
        </div>
      </header>

      <div className="px-4 sm:px-7 py-6 max-w-6xl mx-auto">
        {(waitingOnMe > 0 || toPay > 0) && (
          <div className="mb-4 flex flex-wrap gap-2 text-xs">
            {waitingOnMe > 0 && (
              <button onClick={() => setFilter('hod_signed')} className="s-badge-amber">
                {waitingOnMe} waiting for your approval
              </button>
            )}
            {toPay > 0 && (
              <button onClick={() => setFilter('approved')} className="s-badge-purple">
                {toPay} approved — print, pay and upload the signed photo
              </button>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Chip on={filter === 'all'} onClick={() => setFilter('all')} label="All" count={vouchers.length} />
          {STATUSES.map((s) => (
            <Chip key={s} on={filter === s} onClick={() => setFilter(s)} label={STATUS_META[s].chip} count={counts[s] ?? 0} />
          ))}
        </div>

        {data?.truncated && (
          <p className="mt-2 text-xs text-white/45">Showing the newest {vouchers.length} vouchers — counts cover these only.</p>
        )}

        <div className="mt-5">
          {isLoading && <p className="text-sm text-white/40">Loading…</p>}
          {error && <ErrorBanner message={`Could not load cash vouchers: ${errorWords(error)}`} />}
          {!isLoading && !error && rows.length === 0 && (
            <div className="rounded-2xl p-10 text-center" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
              <p className="font-bold text-white/85">{filter === 'all' ? 'No cash vouchers yet' : `No vouchers in “${STATUS_META[filter].chip}”`}</p>
              {filter === 'all' && <p className="text-sm text-white/45 mt-1">Someone needs cash? Make a voucher — it is a draft until the HOD signs it.</p>}
            </div>
          )}

          {rows.length > 0 && (
            <>
              {/* Phones: one card per voucher */}
              <div className="space-y-2 sm:hidden">
                {rows.map((v) => (
                  <Link key={v.id} href={`/finance/cash-vouchers/${v.id}`} className="block s-card-hover p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="mono text-xs font-bold text-white/60">{v.number}</span>
                      <StatusBadge status={v.status} />
                    </div>
                    <div className="mt-1 flex items-baseline justify-between gap-2">
                      <span className="font-bold text-white/85 truncate">{v.payeeName}</span>
                      <span className="font-black text-white/90 shrink-0">PKR {formatPkr(v.amountCents)}</span>
                    </div>
                    <p className="text-xs text-white/50 truncate">{v.purpose}</p>
                    <p className="text-[11px] text-white/35 mt-0.5">{fmtDate(v.voucherDate)}</p>
                  </Link>
                ))}
              </div>

              {/* Wider screens: a table */}
              <div className="hidden sm:block s-card overflow-x-auto">
                <table className="s-table">
                  <thead>
                    <tr>
                      <th>No.</th>
                      <th>Date</th>
                      <th>Pay to</th>
                      <th className="!text-right">Amount (PKR)</th>
                      <th>Purpose</th>
                      <th>Status</th>
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
                        <td className="font-semibold">{v.payeeName}</td>
                        <td className="text-right font-black tabular-nums">{formatPkr(v.amountCents)}</td>
                        <td className="max-w-[22rem] truncate text-white/60" title={v.purpose}>{v.purpose}</td>
                        <td><StatusBadge status={v.status} /></td>
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
        <VoucherForm onClose={() => setCreating(false)}
          onSaved={(v) => {
            setCreating(false)
            void qc.invalidateQueries({ queryKey: [CV_ROOT] })
            if (v?.id) router.push(`/finance/cash-vouchers/${v.id}`)
          }} />
      )}
    </div>
  )
}
