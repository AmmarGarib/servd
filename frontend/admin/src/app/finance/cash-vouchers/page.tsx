'use client'
// Cash vouchers — anyone asks for cash (owner, 2026-10-15).
//
// A request is a voucher the moment it is sent: it goes to finance, then to the
// CEO; after the CEO approves the cashier pays it, the holder uploads the
// supporting documents — the voucher is CLOSED for them then (it leaves "My
// open vouchers") — and finance checks the documents after, which books the
// expense (books: pending → booked). Finance may send it back with a note.
// Finance can also raise a voucher for an outside payee (with a discount).
//
// Dashboard tiles filter the list (server views). API: /trustops/cash-vouchers.
// One voucher: ./[id] (the approvals inbox links there).

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { formatPkr } from './amountInWords'
import { CV_ROOT, errorWords, fmtDate, stageOf, useDashboard, useVouchers, type Dashboard, type ListView } from './data'
import { VoucherForm } from './VoucherForm'
import { useTrashPrefill } from '../../../lib/trash'
import { unwrapPrefill, pStr } from '../../../lib/trashPrefill'
import { ErrorBanner, StatusBadge } from './ui'

export default function CashVouchersPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-white/40">Loading…</div>}>
      <CashVouchers />
    </Suspense>
  )
}

type Tile = { view: ListView; label: string; key: Exclude<keyof Dashboard, 'scope'>; bad?: boolean; good?: boolean }
const TILES: Tile[] = [
  { view: 'finance', label: 'Waiting for finance', key: 'waitingFinance' },
  { view: 'ceo', label: 'Waiting for CEO', key: 'waitingCeo' },
  { view: 'returned', label: 'Returned', key: 'returned', bad: true },
  { view: 'to_pay', label: 'Approved – unpaid', key: 'approvedUnpaid' },
  { view: 'missing_docs', label: 'Paid — documents missing', key: 'missingDocs', bad: true },
  { view: 'awaiting_verification', label: 'Closed — finance to check', key: 'awaitingVerification' },
  { view: 'overdue', label: 'Documents overdue', key: 'docsOverdue', bad: true },
  { view: 'posted', label: 'Booked this month', key: 'postedThisMonth', good: true },
]
const EXTRA_VIEWS: Array<{ view: ListView; label: string; count?: Exclude<keyof Dashboard, 'scope'> }> = [
  { view: 'open', label: 'My open vouchers' },
  { view: 'sent_back', label: 'Sent back by finance', count: 'sentBack' },
  { view: 'closed', label: 'Closed' },
  { view: 'mine', label: 'All mine' },
  { view: 'all', label: 'All' },
]
const VIEW_IDS = new Set<string>([...TILES.map((t) => t.view), ...EXTRA_VIEWS.map((e) => e.view), 'receipts_due', 'settled', 'needs_review'])

function CashVouchers() {
  const router = useRouter()
  const params = useSearchParams()
  const qc = useQueryClient()

  // An old-style link (?id=…) opens the voucher's own page.
  const linkedId = params?.get('id')
  useEffect(() => { if (linkedId) router.replace(`/finance/cash-vouchers/${linkedId}`) }, [linkedId, router])

  const initial = params?.get('view') ?? ''
  const [view, setView] = useState<ListView>(VIEW_IDS.has(initial) ? (initial as ListView) : 'open')
  const [mode, setMode] = useState<'request' | 'expense' | null>(null)
  // "Recover as copy" from the Trash: a rejected / cancelled voucher opens the
  // new-voucher form pre-filled. It is a normal submission (finance, then CEO).
  const trashPrefill = unwrapPrefill(useTrashPrefill('cash_voucher'))
  useEffect(() => {
    if (trashPrefill) setMode(pStr(trashPrefill, 'kind') === 'expense' ? 'expense' : 'request')
  }, [trashPrefill])
  const { data, isLoading, error } = useVouchers(view)
  const dash = useDashboard()
  const keeper = !!data?.keeper
  const rows = useMemo(() => data?.items ?? [], [data])
  // The whole dashboard is the company's for finance / CEO, a person's own for anyone else.
  const label = TILES.find((t) => t.view === view)?.label ?? EXTRA_VIEWS.find((e) => e.view === view)?.label ?? 'Vouchers'

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-4 sm:px-7 py-6 border-b border-white/[0.05]">
        {keeper && <Link href="/finance/petty-cash" className="text-xs text-white/40 hover:text-white/70">← Petty cash</Link>}
        <div className="flex items-start justify-between gap-4 mt-2 flex-wrap">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-success">Finance</p>
            <h1 className="text-2xl font-black text-white/90">Cash vouchers</h1>
            <p className="text-sm text-white/45 mt-1 max-w-2xl">
              Request cash here — a voucher is created and goes to finance at once, then to the CEO. After approval the cashier pays you;
              attach the supporting documents and the voucher is closed for you. Finance checks them afterwards and books the expense.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setMode('request')} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">
              + Request cash
            </button>
            {data?.financeApprover && (
              <button onClick={() => setMode('expense')}
                className="rounded-xl border border-white/10 px-4 py-2.5 text-sm font-bold text-white/70 hover:text-white hover:border-primary">
                + New payee voucher
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="px-4 sm:px-7 py-6 max-w-6xl mx-auto">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {TILES.map((t) => {
            const d = dash.data?.[t.key]
            const on = view === t.view
            const hot = !!d && d.count > 0
            return (
              <button key={t.view} onClick={() => setView(t.view)} aria-pressed={on}
                className="rounded-2xl p-3.5 text-left transition-colors"
                style={on
                  ? { background: 'var(--erp-accent-dim)', border: '1px solid var(--erp-accent)' }
                  : { background: 'var(--surface)', border: '1px solid var(--border)' }}>
                <p className="text-[11px] font-bold text-white/55 leading-tight">{t.label}</p>
                <p className="mt-1 text-2xl font-black tabular-nums"
                  style={{ color: hot && t.bad ? 'var(--erp-danger)' : hot && t.good ? 'var(--erp-success)' : 'var(--text)' }}>
                  {d ? d.count : '—'}
                </p>
                <p className="text-[11px] text-white/45 tabular-nums">{d ? `PKR ${formatPkr(d.cents)}` : ' '}</p>
              </button>
            )
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {EXTRA_VIEWS.map((e) => (
            <button key={e.view} onClick={() => setView(e.view)}
              className="rounded-full px-3 py-1.5 text-xs font-bold"
              style={view === e.view
                ? { background: 'var(--erp-accent-dim)', border: '1px solid var(--erp-accent)', color: 'var(--text)' }
                : { background: 'var(--surface)', border: '1px solid var(--border)', color: 'rgb(var(--fg-rgb) / 0.75)' }}>
              {e.label}
              {e.count && (dash.data?.[e.count]?.count ?? 0) > 0 ? ` (${dash.data?.[e.count]?.count})` : ''}
            </button>
          ))}
          <span className="text-xs text-white/40">Showing: <b className="text-white/70">{label}</b></span>
        </div>

        {data?.truncated && <p className="mt-2 text-xs text-white/45">Showing the newest {rows.length} vouchers.</p>}

        <div className="mt-5">
          {isLoading && <p className="text-sm text-white/40">Loading…</p>}
          {error && <ErrorBanner message={`Could not load cash vouchers: ${errorWords(error)}`} />}
          {!isLoading && !error && rows.length === 0 && (
            <div className="rounded-2xl p-10 text-center" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
              <p className="font-bold text-white/85">Nothing in &ldquo;{label}&rdquo;</p>
              {(view === 'mine' || view === 'open') && <p className="text-sm text-white/45 mt-1">Need cash for work? Request it — it goes to finance first.</p>}
            </div>
          )}

          {rows.length > 0 && (
            <>
              <div className="space-y-2 sm:hidden">
                {rows.map((v) => (
                  <Link key={v.id} href={`/finance/cash-vouchers/${v.id}`} className="block s-card-hover p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="mono text-xs font-bold text-white/60">{v.number}</span>
                      <span className="flex items-center gap-1">
                        {v.overdue && <span className="s-badge-red">Overdue</span>}
                        <StatusBadge stage={stageOf(v)} />
                      </span>
                    </div>
                    <div className="mt-1 flex items-baseline justify-between gap-2">
                      <span className="font-bold text-white/85 truncate">{v.holderName ?? v.payeeName}</span>
                      <span className="font-black text-white/90 shrink-0">PKR {formatPkr(v.amountCents)}</span>
                    </div>
                    <p className="text-xs text-white/50 truncate">{v.purpose}</p>
                    <p className="text-[11px] text-white/35 mt-0.5">{fmtDate(v.voucherDate)}{v.kind === 'expense' ? ' · payee voucher' : ''}</p>
                  </Link>
                ))}
              </div>

              <div className="hidden sm:block s-card overflow-x-auto">
                <table className="s-table">
                  <thead>
                    <tr>
                      <th>No.</th>
                      <th>Date</th>
                      <th>Payee</th>
                      <th className="!text-right">Total (PKR)</th>
                      <th className="!text-right">Docs</th>
                      <th>Particulars</th>
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
                        <td className="font-semibold">{v.holderName ?? v.payeeName}{v.kind === 'expense' && <span className="s-badge-muted ml-1">payee</span>}</td>
                        <td className="text-right font-black tabular-nums">{formatPkr(v.amountCents)}</td>
                        <td className="text-right tabular-nums text-white/60">{v.supportingCount ?? v.receiptCount ?? 0}</td>
                        <td className="max-w-[22rem] truncate text-white/60" title={v.purpose}>{v.purpose}</td>
                        <td>
                          <span className="flex items-center gap-1">
                            <StatusBadge stage={stageOf(v)} />
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

      {mode && (
        <VoucherForm mode={mode} isKeeper={keeper} prefill={trashPrefill} onClose={() => setMode(null)}
          onSaved={(v) => {
            setMode(null)
            void qc.invalidateQueries({ queryKey: [CV_ROOT] })
            void qc.invalidateQueries({ queryKey: ['approvals'] })
            if (v?.id) router.push(`/finance/cash-vouchers/${v.id}`)
          }} />
      )}
    </div>
  )
}
