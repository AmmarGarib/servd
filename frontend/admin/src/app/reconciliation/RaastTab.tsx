'use client'
// Finance → Reconciliation → Raast (spec §7.2 / §8 F1; amendments S3, M4).
//
// A Raast QR payment completes the sale at the till and leaves a RaastReceipt
// 'provisional'. The BANK STATEMENT is the truth: a receipt is cleared only
// when a statement line shows the money ('matched' — by the import's
// reference pass, or here by finance). Here finance sees every Raast receipt
// of the companies in view and works the ones the import could not match:
//
//   Match        pick the statement line (same company + receiving account,
//                equal amount, within ±N days). A SUGGESTED line (S3: no line
//                names the reference, exactly one same-day line of the amount,
//                exactly one receipt of that amount that day) is only offered —
//                finance confirms it; nothing is ever matched by a guess.
//   Unmatch      undo a match (CEO / co-owners).
//   Fix reference  the cashier mistyped it (CEO / co-owners — M4; provisional,
//                not once a bank SMS confirmed it; before/after audited).
//   Not received the money never arrived: written off against 1110 till
//                clearing (the customer owes it) / 8010 (a loss) / 1350 (staff
//                owes it) — CEO / co-owners; only once the sale is booked.
//   Void — never booked  (RV-MONEY-1, the CEO only) a provisional payment on
//                a cancelled bill that no entry ever put in the bank: no ledger
//                entry, the reference stays used. Finance / management / an
//                owner "Ask the CEO to void" (it lands in the CEO's approvals
//                inbox); the CEO voids or turns the ask down.
//   Re-run matching  the reference pass over the active company's unmatched
//                credit lines of the last 60 days.
//
// The bank SMS log is read-only here — attaching an SMS to a bill is a till
// action, dismissing one a manager's. Who may do what is the API's decision:
// every row carries the caller's capability flags (canMatch, canUnmatch,
// canFixReference, canWriteOff, canResolve, canVoid, canRequestVoid,
// canRejectVoidRequest) and the buttons follow them — no role list here.
// Admin colour tokens only; text labels, no emoji.

import { Fragment, useMemo, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import Link from 'next/link'
import { api, ApiError, RAAST_STATUS_LABEL, RAAST_STATUS_SHORT, type RaastReceiptStatus } from '../../lib/api'
import { fmtPkr } from '../../lib/money'

/** The server's statuses — 'voided' (wave B) until lib/api.ts lists it. */
type ReceiptStatus = RaastReceiptStatus | 'voided'

const statusLabel = (s: ReceiptStatus): string =>
  s === 'voided' ? 'Voided by the CEO — never booked, no ledger entry' : RAAST_STATUS_LABEL[s] ?? s
const statusShort = (s: ReceiptStatus): string => (s === 'voided' ? 'Voided' : RAAST_STATUS_SHORT[s] ?? s)

// ─── Types (backend modules/reconciliation/raastRoutes.ts) ───────────────────

interface StatementLineRef {
  id: string
  importId: string
  postedDate: string
  description: string
  reference: string | null
  amountCents: number
}

interface RaastReceiptRow {
  id: string
  tenantId: string
  orderId: string
  orderRef: string
  conceptId: string
  brand: string
  shiftId: string | null
  status: ReceiptStatus
  orderStatus: string
  amountCents: number
  tipCents: number
  bankRef: string | null
  confirmedVia: 'cashier' | 'sms' | 'bank_api' | null
  confirmedAt: string | null
  createdAt: string
  cashierVerified: boolean
  smsConfirmed: boolean
  smsConfirmedAt: string | null
  matchedAt: string | null
  matchedAutomatically: boolean
  attentionReason: string | null
  ageDays: number
  ledgerCode: string
  writeOffEntryId: string | null
  bankAccount: { id: string; name: string; bankName: string | null; last4: string | null }
  statementLine: StatementLineRef | null
  /** A pending (or past) ask for the CEO's void. */
  voidRequest: { at: string; by: Person | null; reason: string | null; pending: boolean } | null
  voided: { at: string; by: Person | null; reason: string | null } | null
  /** Why the CEO cannot void it (a provisional payment on a cancelled bill), else null. */
  voidBlockedReason: string | null
  // The caller's buttons (the server's rules).
  canMatch: boolean
  canUnmatch: boolean
  canFixReference: boolean
  canWriteOff: boolean
  canResolve: boolean
  canVoid: boolean
  canRequestVoid: boolean
  canRejectVoidRequest: boolean
}

interface Person { id: string; name: string | null }

interface Bucket { count: number; cents: number }

interface ReceiptsPage {
  receipts: RaastReceiptRow[]
  nextCursor: string | null
  totals: Record<string, Bucket>
  kpis: {
    provisional: Bucket
    olderThanFlagDays: { days: number; count: number; cents: number }
    matched: Bucket
    needsAttention: Bucket
    unreceived: Bucket
    voided?: Bucket
    voidRequested?: Bucket
    unmatchedBankAlerts: number
  }
}

interface Candidate extends StatementLineRef {
  refHit: boolean
  sameDay: boolean
  /** Dated before the bill existed (M4) — never this bill's payment by reference. */
  beforeBill?: boolean
  suggested: boolean
}

interface CandidatesResp {
  receipt: RaastReceiptRow
  statementMatchDays: number
  candidates: Candidate[]
}

interface SmsAlertRow {
  id: string
  tenantId: string
  status: string
  kind: string | null
  sender: string
  amountCents: number | null
  bankRef: string | null
  occurredAt: string | null
  receivedAt: string
  payer: string | null
  accountLast4: string | null
  body: string | null
  resolution: string | null
  resolvedAt: string | null
  bankAccount: { id: string; name: string; bankName: string | null; last4: string | null } | null
  receipt: { id: string; orderId: string; orderRef: string; status: string } | null
}

interface BankAccountOpt { id: string; name: string; bankName: string | null; raastDefault?: boolean }

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** 'void_requested' is not a status: the payments whose void waits for the CEO (?voidRequested=1). */
type StatusFilter = '' | ReceiptStatus | 'void_requested'

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: '', label: 'Every Raast payment' },
  { value: 'provisional', label: 'Provisional (not on a statement)' },
  { value: 'needs_attention', label: 'Needs attention' },
  { value: 'matched', label: 'Matched' },
  { value: 'unreceived', label: 'Not received (written off)' },
  { value: 'void_requested', label: 'Waiting for the CEO to void' },
  { value: 'voided', label: 'Voided — never booked' },
  { value: 'awaiting', label: 'Waiting at the till' },
  { value: 'cancelled', label: 'Cancelled at the till' },
]

const CHIP: Record<ReceiptStatus, string> = {
  provisional:     'bg-s-amber/15 text-s-amber',
  matched:         'bg-s-teal/20 text-success',
  needs_attention: 'bg-s-red/10 text-s-red',
  unreceived:      'bg-s-red/10 text-s-red',
  awaiting:        'bg-s-bg-soft text-s-muted',
  cancelled:       'bg-s-bg-soft text-s-muted',
  voided:          'bg-s-bg-soft text-s-muted',
}

const ALERT_STATUS_LABEL: Record<string, string> = {
  received: 'Received', processing: 'Processing', unparsed: 'Not understood', off: 'Matching off',
  debit: 'Money out', duplicate: 'Duplicate', matched: 'Paid a bill', confirmed: 'Confirmed a payment',
  unmatched: 'No bill', ambiguous: 'Several bills', needs_attention: 'Needs attention', attached: 'Attached at the till',
  dismissed: 'Not a sale',
}

/** The write-off contras (raast.ts WRITE_OFF_CONTRAS) — 1110 first, the default. */
type Contra = '1110' | '8010' | '1350'
const CONTRA_LABEL: Record<Contra, string> = {
  '1110': 'Customer owes (1110 till clearing)',
  '8010': 'Loss (8010)',
  '1350': 'Staff owes (1350)',
}

function fmtWhen(iso: string | null | undefined): string {
  return iso ? format(new Date(iso), 'dd MMM, HH:mm') : '—'
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'FORBIDDEN': return e.message || 'You can’t do this here — ask the CEO.'
      case 'RAAST_REF_INVALID': return e.message || 'That bank reference doesn’t look right — 6–35 letters or digits, at least 3 digits.'
      case 'RAAST_REF_DISMISSED': return e.message || 'That reference belongs to a bank transfer marked “not a sale” (or money out) — it cannot be a sale.'
    }
    return e.message || e.code
  }
  return e instanceof Error ? e.message : 'Something went wrong'
}

const inputCls = 'bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text'

// ─── Tab ─────────────────────────────────────────────────────────────────────

type RowAction = 'match' | 'reference' | 'unreceived' | 'unmatch' | 'resolve' | 'void' | 'void_request' | 'void_reject'

export function RaastTab() {
  const qc = useQueryClient()
  const [status, setStatus] = useState<StatusFilter>('')
  const [bankAccountId, setBankAccountId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<{ id: string; action: RowAction } | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [view, setView] = useState<'receipts' | 'alerts'>('receipts')

  const { data: banks = [] } = useQuery<BankAccountOpt[]>({ queryKey: ['bank-accounts'], queryFn: () => api.get('/setup/bank-accounts') })

  const params = useMemo(() => {
    const p = new URLSearchParams()
    if (status === 'void_requested') p.set('voidRequested', '1')
    else if (status) p.set('status', status)
    if (bankAccountId) p.set('bankAccountId', bankAccountId)
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    if (q.trim()) p.set('q', q.trim())
    p.set('limit', '50')
    return p.toString()
  }, [status, bankAccountId, from, to, q])

  const receipts = useInfiniteQuery({
    queryKey: ['raast-receipts', params],
    queryFn: ({ pageParam }) => api.get<ReceiptsPage>(`/reconciliation/raast/receipts?${params}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: view === 'receipts',
  })
  const first = receipts.data?.pages[0]
  const rows = receipts.data?.pages.flatMap((p) => p.receipts) ?? []

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['raast-receipts'] })
    void qc.invalidateQueries({ queryKey: ['raast-candidates'] })
    void qc.invalidateQueries({ queryKey: ['bank-lines'] })
  }

  const rematch = useMutation({
    mutationFn: () => api.post<{ matched: number; mismatched: number; accounts: number }>('/reconciliation/raast/rematch', {}),
    onSuccess: (r) => {
      setNotice({ ok: true, text: r.matched > 0
        ? `Matched ${r.matched} Raast payment${r.matched === 1 ? '' : 's'} to the bank statement${r.mismatched ? `; ${r.mismatched} line${r.mismatched === 1 ? '' : 's'} named a reference with a different amount (flagged)` : ''}.`
        : `Nothing new matched${r.mismatched ? `; ${r.mismatched} line${r.mismatched === 1 ? '' : 's'} named a reference with a different amount (flagged)` : ''}. Import the latest statement, or match by hand.` })
      refresh()
    },
    onError: (e) => setNotice({ ok: false, text: errorText(e) }),
  })

  function done(text: string) {
    setOpen(null)
    setNotice({ ok: true, text })
    refresh()
  }

  const toggle = (id: string, action: RowAction) => setOpen(open?.id === id && open.action === action ? null : { id, action })

  const k = first?.kpis
  const voidAsks = k?.voidRequested?.count ?? 0

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-s-border bg-s-bg-soft/50 px-4 py-3 text-xs text-s-muted">
        A Raast QR payment completes the sale at the till and stays <strong className="text-s-text">provisional</strong> until a bank-statement
        line shows the money. Importing a statement for the receiving bank account matches them by reference; the rest are worked here.
        The cashier checks the money on the counter phone — never the customer&rsquo;s screen — so a provisional payment that never reaches
        the bank is the one to chase.
      </div>

      {notice && (
        <div role={notice.ok ? 'status' : 'alert'} className={`s-card p-3 text-sm flex items-start gap-3 ${notice.ok ? 'border-l-4 border-s-teal' : 'border-l-4 border-s-red'}`}>
          <span className={notice.ok ? 'text-success' : 'text-s-red'}>{notice.text}</span>
          <button onClick={() => setNotice(null)} className="ml-auto text-xs text-s-muted underline">Dismiss</button>
        </div>
      )}

      {/* KPIs */}
      {k && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <Kpi label="Provisional" value={fmtPkr(k.provisional.cents)} sub={`${k.provisional.count} payment${k.provisional.count === 1 ? '' : 's'} not on a statement`} tone={k.provisional.count > 0 ? 'amber' : 'muted'} />
          <Kpi label={`Older than ${k.olderThanFlagDays.days} day${k.olderThanFlagDays.days === 1 ? '' : 's'}`} value={String(k.olderThanFlagDays.count)} sub={fmtPkr(k.olderThanFlagDays.cents)} tone={k.olderThanFlagDays.count > 0 ? 'red' : 'muted'} />
          <Kpi label="Matched" value={fmtPkr(k.matched.cents)} sub={`${k.matched.count} on the bank statement`} tone="green" />
          <Kpi label="Needs attention" value={String(k.needsAttention.count)} sub={fmtPkr(k.needsAttention.cents)} tone={k.needsAttention.count > 0 ? 'red' : 'muted'} />
          <Kpi label="Unmatched bank alerts" value={String(k.unmatchedBankAlerts)} sub="bank SMS with no bill" tone={k.unmatchedBankAlerts > 0 ? 'amber' : 'muted'} />
        </div>
      )}

      {voidAsks > 0 && status !== 'void_requested' && (
        <div className="s-card p-3 text-xs flex flex-wrap items-center gap-2 border-l-4 border-s-amber">
          <span className="s-badge-amber">Void asked for</span>
          <span className="text-s-text">
            {voidAsks} Raast payment{voidAsks === 1 ? '' : 's'} ({fmtPkr(k?.voidRequested?.cents ?? 0)}) waiting for the CEO to void — never booked.
          </span>
          <button onClick={() => setStatus('void_requested')} className="ml-auto text-primary-ink font-semibold">Show them</button>
        </div>
      )}

      <div className="flex gap-1 border-b border-s-border">
        {([['receipts', 'Raast payments'], ['alerts', 'Bank SMS log']] as const).map(([key, label]) => (
          <button key={key} onClick={() => setView(key)}
            className={`px-3 py-1.5 text-xs font-semibold border-b-2 ${view === key ? 'border-s-teal text-primary-ink' : 'border-transparent text-s-muted hover:text-s-text'}`}>
            {label}
          </button>
        ))}
      </div>

      {view === 'alerts' ? <SmsLog /> : (
        <>
          {/* Filters */}
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-s-muted">
              <span className="block mb-0.5">Status</span>
              <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className={inputCls}>
                {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
            <label className="text-xs text-s-muted">
              <span className="block mb-0.5">Receiving account</span>
              <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} className={inputCls}>
                <option value="">All accounts</option>
                {banks.map((b) => <option key={b.id} value={b.id}>{b.name}{b.raastDefault ? ' (default Raast)' : ''}</option>)}
              </select>
            </label>
            <label className="text-xs text-s-muted">
              <span className="block mb-0.5">From</span>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
            </label>
            <label className="text-xs text-s-muted">
              <span className="block mb-0.5">To</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
            </label>
            <label className="text-xs text-s-muted flex-1 min-w-[10rem]">
              <span className="block mb-0.5">Bank reference or order #</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. 4F3A9C1B" className={`${inputCls} w-full font-mono`} />
            </label>
            <button onClick={() => rematch.mutate()} disabled={rematch.isPending}
              className="s-btn-secondary text-xs" title="Look for each provisional payment's reference in the active company's unmatched statement lines of the last 60 days">
              {rematch.isPending ? 'Matching…' : 'Re-run matching'}
            </button>
          </div>

          {/* Receipts */}
          <div className="s-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-s-muted bg-s-bg-soft">
                  <tr>
                    <th className="px-3 py-2 text-left">Paid</th>
                    <th className="px-3 py-2 text-left">Bill</th>
                    <th className="px-3 py-2 text-left">Bank reference</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    <th className="px-3 py-2 text-left">Receiving account</th>
                    <th className="px-3 py-2 text-left">State</th>
                    <th className="px-3 py-2 text-right"></th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.isLoading && <tr><td colSpan={7} className="px-4 py-8 text-center text-xs text-s-muted">Loading Raast payments…</td></tr>}
                  {receipts.isError && <tr><td colSpan={7} className="px-4 py-6 text-center text-xs text-s-red">{errorText(receipts.error)}</td></tr>}
                  {!receipts.isLoading && !receipts.isError && rows.length === 0 && (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-xs text-s-muted">No Raast payments match these filters.</td></tr>
                  )}
                  {rows.map((r) => {
                    const isOpen = open?.id === r.id
                    const pendingAsk = r.voidRequest?.pending ? r.voidRequest : null
                    return (
                      <Fragment key={r.id}>
                        <tr className="border-t border-s-border align-top">
                          <td className="px-3 py-2 text-xs text-s-muted whitespace-nowrap">
                            {fmtWhen(r.confirmedAt ?? r.createdAt)}
                            {r.status === 'provisional' && <span className={`block ${r.ageDays >= (k?.olderThanFlagDays.days ?? 3) ? 'text-s-red' : 'text-s-dim'}`}>{r.ageDays} day{r.ageDays === 1 ? '' : 's'} old</span>}
                          </td>
                          <td className="px-3 py-2">
                            <Link href={`/orders/${r.orderId}`} className="font-mono text-xs text-primary-ink hover:underline">#{r.orderRef}</Link>
                            <span className="block text-[11px] text-s-muted">{r.brand}</span>
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-s-text">
                            {r.bankRef ?? <span className="text-s-dim">—</span>}
                            <span className="block font-sans text-[10px] text-s-dim">
                              {r.confirmedVia === 'sms' ? 'from the bank SMS' : r.confirmedVia === 'bank_api' ? 'from the bank' : r.confirmedVia === 'cashier' ? 'typed by the cashier' : ''}
                              {r.smsConfirmed && r.confirmedVia !== 'sms' ? ' · bank SMS seen' : ''}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-xs text-s-text">
                            {fmtPkr(r.amountCents)}
                            {r.tipCents > 0 && <span className="block text-[10px] text-s-dim">incl. tip {fmtPkr(r.tipCents)}</span>}
                          </td>
                          <td className="px-3 py-2 text-xs text-s-muted">
                            {r.bankAccount.name}{r.bankAccount.last4 ? ` ••${r.bankAccount.last4}` : ''}
                            <span className="block font-mono text-[10px] text-s-dim">{r.ledgerCode}</span>
                          </td>
                          <td className="px-3 py-2 text-xs">
                            <span title={statusLabel(r.status)} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${CHIP[r.status]}`}>{statusShort(r.status)}</span>
                            {pendingAsk && (
                              <span className="block mt-1">
                                <span className="s-badge-amber text-[10px]">Void asked for</span>
                                <span className="block text-[10px] text-s-muted">
                                  {pendingAsk.by?.name ?? 'Finance'}, {fmtWhen(pendingAsk.at)}{pendingAsk.reason ? `: ${pendingAsk.reason}` : ''}
                                </span>
                              </span>
                            )}
                            {r.status === 'voided' && r.voided && (
                              <span className="block mt-1 text-[10px] text-s-muted">
                                Voided by {r.voided.by?.name ?? 'the CEO'}, {fmtWhen(r.voided.at)}{r.voided.reason ? `: ${r.voided.reason}` : ''}. No ledger entry; the reference stays used.
                              </span>
                            )}
                            {r.status === 'provisional' && r.voidBlockedReason && (r.orderStatus === 'cancelled' || r.orderStatus === 'rejected' || pendingAsk) && (
                              <span className="block mt-1 text-[10px] text-s-dim" title="Why this payment cannot be voided as never booked">Not voidable: {r.voidBlockedReason}</span>
                            )}
                            {r.status === 'matched' && r.statementLine && (
                              <span className="block mt-1 text-[10px] text-s-muted">
                                {r.statementLine.postedDate.slice(0, 10)} · {r.matchedAutomatically ? 'by the import' : 'by finance'}
                              </span>
                            )}
                            {r.status === 'needs_attention' && r.attentionReason && (
                              <span className="block mt-1 text-[10px] text-s-red">{r.attentionReason.replace(/_/g, ' ').toLowerCase()}</span>
                            )}
                            {r.status === 'needs_attention' && (
                              <span className="block text-[10px] text-s-muted">A customer transfer the till could not book — attach it at the till&rsquo;s bank alerts while the bill is open; once the bill is closed, refund the customer and resolve it here.</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right whitespace-nowrap text-xs">
                            <span className="inline-flex flex-wrap justify-end gap-x-3 gap-y-1">
                              {r.canMatch && <button onClick={() => toggle(r.id, 'match')} className="text-primary-ink font-semibold">Match</button>}
                              {r.canFixReference && !r.smsConfirmed && <button onClick={() => toggle(r.id, 'reference')} className="text-s-muted hover:text-s-text">Fix reference</button>}
                              {r.canWriteOff && <button onClick={() => toggle(r.id, 'unreceived')} className="text-s-red">Not received</button>}
                              {r.canUnmatch && <button onClick={() => toggle(r.id, 'unmatch')} className="text-s-muted hover:text-s-text">Unmatch</button>}
                              {r.canResolve && <button onClick={() => toggle(r.id, 'resolve')} className="text-primary-ink font-semibold">Resolve</button>}
                              {r.canRequestVoid && <button onClick={() => toggle(r.id, 'void_request')} className="text-primary-ink font-semibold">Ask the CEO to void</button>}
                              {r.canVoid && <button onClick={() => toggle(r.id, 'void')} className="text-s-red font-semibold">Void — never booked</button>}
                              {r.canRejectVoidRequest && <button onClick={() => toggle(r.id, 'void_reject')} className="text-s-muted hover:text-s-text">Turn down the ask</button>}
                            </span>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-t border-s-border/50 bg-s-bg-soft/40">
                            <td colSpan={7} className="px-4 py-3">
                              {open!.action === 'match' && <MatchPanel receipt={r} onDone={done} onCancel={() => setOpen(null)} />}
                              {open!.action === 'reference' && <ReferencePanel receipt={r} onDone={done} onCancel={() => setOpen(null)} />}
                              {open!.action === 'unreceived' && <UnreceivedPanel receipt={r} onDone={done} onCancel={() => setOpen(null)} />}
                              {open!.action === 'unmatch' && <UnmatchPanel receipt={r} onDone={done} onCancel={() => setOpen(null)} />}
                              {open!.action === 'resolve' && <ResolvePanel receipt={r} onDone={done} onCancel={() => setOpen(null)} />}
                              {open!.action === 'void_request' && <VoidRequestPanel receipt={r} onDone={done} onCancel={() => setOpen(null)} />}
                              {open!.action === 'void' && <VoidPanel receipt={r} onDone={done} onCancel={() => setOpen(null)} />}
                              {open!.action === 'void_reject' && <VoidRejectPanel receipt={r} onDone={done} onCancel={() => setOpen(null)} />}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {receipts.hasNextPage && (
              <div className="border-t border-s-border px-4 py-2 text-center">
                <button onClick={() => void receipts.fetchNextPage()} disabled={receipts.isFetchingNextPage} className="text-xs text-primary-ink">
                  {receipts.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </div>
          <p className="text-[11px] text-s-dim">
            Fixing a reference, unmatching, writing off a payment as not received and resolving a payment that needs attention are for the CEO or a
            co-owner. Voiding a payment that was never booked is the CEO&rsquo;s alone — finance asks for it. You see the buttons your role may use.
          </p>
        </>
      )}
    </div>
  )
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: 'amber' | 'red' | 'green' | 'muted' }) {
  const color = tone === 'amber' ? 'text-s-amber' : tone === 'red' ? 'text-s-red' : tone === 'green' ? 'text-success' : 'text-s-text'
  return (
    <div className="s-card p-3">
      <p className="text-xs text-s-muted">{label}</p>
      <p className={`text-xl font-bold mt-0.5 ${color}`}>{value}</p>
      <p className="text-[11px] text-s-dim mt-0.5">{sub}</p>
    </div>
  )
}

// ─── Match ───────────────────────────────────────────────────────────────────

function MatchPanel({ receipt, onDone, onCancel }: { receipt: RaastReceiptRow; onDone: (t: string) => void; onCancel: () => void }) {
  const { data, isLoading, error } = useQuery<CandidatesResp>({
    queryKey: ['raast-candidates', receipt.id],
    queryFn: () => api.get<CandidatesResp>(`/reconciliation/raast/receipts/${receipt.id}/candidates`),
  })
  const [picked, setPicked] = useState<string | null>(null)
  const match = useMutation({
    mutationFn: (lineId: string) => api.post(`/reconciliation/raast/receipts/${receipt.id}/match`, { statementLineId: lineId }, { tenantId: receipt.tenantId }),
    onSuccess: () => onDone(`Raast payment on bill #${receipt.orderRef} matched to the bank statement${receipt.status === 'unreceived' ? ' — its write-off was reversed' : ''}.`),
  })
  if (isLoading) return <p className="text-xs text-s-muted">Looking for statement lines…</p>
  if (error) return <p className="text-xs text-s-red">{errorText(error)}</p>
  const cands = data?.candidates ?? []
  const refHits = cands.filter((c) => c.refHit)
  const chosen = picked ?? (refHits.length === 1 ? refHits[0]!.id : null)
  return (
    <div className="space-y-2 text-xs">
      <p className="text-s-muted">
        Unmatched credit lines of <strong className="text-s-text">{receipt.bankAccount.name}</strong> for exactly <strong className="text-s-text">{fmtPkr(receipt.amountCents)}</strong>,
        within {data?.statementMatchDays ?? '—'} day{data?.statementMatchDays === 1 ? '' : 's'} of the payment.
        {receipt.status === 'unreceived' && ' This payment was written off as not received — matching it reverses the write-off.'}
      </p>
      {cands.length === 0 ? (
        <p className="text-s-amber">
          No unmatched line fits. Import the bank statement for this account (Bank Imports tab) — if the money never arrived, a CEO or co-owner marks it not received.
        </p>
      ) : (
        <div className="rounded-lg border border-s-border overflow-hidden">
          <table className="w-full">
            <tbody>
              {cands.map((c) => (
                <tr key={c.id} className={`border-t border-s-border first:border-0 ${chosen === c.id ? 'bg-s-teal/10' : ''}`}>
                  <td className="px-3 py-1.5 w-6">
                    <input type="radio" className="accent-primary" name={`raast-line-${receipt.id}`} checked={chosen === c.id} onChange={() => setPicked(c.id)} aria-label="Pick this statement line" />
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-s-muted">{c.postedDate.slice(0, 10)}</td>
                  <td className="px-2 py-1.5 text-s-text">{c.description}{c.reference && <span className="text-s-muted"> · {c.reference}</span>}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-s-text">{fmtPkr(c.amountCents)}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    {c.refHit && <span className="s-badge-green text-[10px]">Names the reference</span>}
                    {c.suggested && <span className="s-badge-purple text-[10px]" title="No line names the reference, but this is the only line of this amount on the payment's day and the only payment of this amount that day. Check it before confirming.">Suggested — check it</span>}
                    {c.beforeBill && <span className="text-[10px] text-s-red" title="This credit is dated before the bill existed — it cannot be this bill's payment by its reference.">before the bill</span>}
                    {!c.refHit && !c.suggested && !c.beforeBill && c.sameDay && <span className="text-[10px] text-s-dim">same day</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {chosen && !cands.find((c) => c.id === chosen)?.refHit && (
        <p className="text-s-amber">
          This line does not name the payment&rsquo;s reference{receipt.bankRef ? ` (${receipt.bankRef})` : ''}. Confirm only if you are sure it is this customer&rsquo;s transfer —
          banks sometimes print a different ID on the statement than in the SMS.
        </p>
      )}
      {match.error && <p className="text-s-red">{errorText(match.error)}</p>}
      <div className="flex gap-3">
        <button onClick={() => chosen && match.mutate(chosen)} disabled={!chosen || match.isPending} className="text-primary-ink font-semibold disabled:opacity-40">
          {match.isPending ? 'Matching…' : 'Confirm match'}
        </button>
        <button onClick={onCancel} className="text-s-muted">Cancel</button>
      </div>
    </div>
  )
}

// ─── Fix reference (APPROVERS — M4) ──────────────────────────────────────────

function ReferencePanel({ receipt, onDone, onCancel }: { receipt: RaastReceiptRow; onDone: (t: string) => void; onCancel: () => void }) {
  const [bankRef, setBankRef] = useState('')
  const [reason, setReason] = useState('')
  const fix = useMutation({
    mutationFn: () => api.patch<RaastReceiptRow & { smsConfirmedNow?: boolean; statementMatchedNow?: boolean }>(
      `/reconciliation/raast/receipts/${receipt.id}/reference`, { bankRef: bankRef.trim(), reason: reason.trim() }, { tenantId: receipt.tenantId }),
    onSuccess: (r) => onDone(`Reference on bill #${receipt.orderRef} changed to ${r.bankRef ?? bankRef.trim().toUpperCase()}${r.statementMatchedNow ? ' — and it is now matched to the bank statement' : r.smsConfirmedNow ? ' — a bank SMS confirms it' : ''}. The change is on the audit trail.`),
  })
  return (
    <div className="space-y-2 text-xs max-w-xl">
      <p className="text-s-muted">
        For a reference the cashier mistyped. Take the right one from the bank statement or the bank&rsquo;s own record of this transfer — never from the
        customer. The same checks as the till apply: one transfer pays one bill, and a transfer marked &ldquo;not a sale&rdquo; can never become one.
        Before and after are recorded.
      </p>
      <div className="flex flex-wrap gap-2">
        <input value={bankRef} onChange={(e) => setBankRef(e.target.value)} placeholder={receipt.bankRef ? `now ${receipt.bankRef}` : 'bank reference'} autoComplete="off" spellCheck={false}
          className={`${inputCls} w-56 font-mono uppercase`} />
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why (e.g. cashier typed 0 for O)" className={`${inputCls} flex-1 min-w-[12rem]`} />
      </div>
      {fix.error && <p className="text-s-red">{errorText(fix.error)}</p>}
      <div className="flex gap-3">
        <button onClick={() => fix.mutate()} disabled={fix.isPending || !bankRef.trim() || reason.trim().length < 3} className="text-primary-ink font-semibold disabled:opacity-40">
          {fix.isPending ? 'Saving…' : 'Change reference'}
        </button>
        <button onClick={onCancel} className="text-s-muted">Cancel</button>
      </div>
    </div>
  )
}

// ─── Not received (APPROVERS) ────────────────────────────────────────────────

function UnreceivedPanel({ receipt, onDone, onCancel }: { receipt: RaastReceiptRow; onDone: (t: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('')
  const [contra, setContra] = useState<Contra>('1110')
  const writeOff = useMutation({
    mutationFn: () => api.post(`/reconciliation/raast/receipts/${receipt.id}/unreceived`, { reason: reason.trim(), contraAccountCode: contra }, { tenantId: receipt.tenantId }),
    onSuccess: () => onDone(`Bill #${receipt.orderRef}'s Raast payment (${fmtPkr(receipt.amountCents)}) written off as not received: Dr ${contra} / Cr ${receipt.ledgerCode}. If the money turns up on a later statement, matching it reverses this.`),
  })
  return (
    <div className="space-y-2 text-xs max-w-xl">
      <p className="text-s-muted">
        The bank never received this payment (a fake screen, a reversed transfer). The sale stands; the money is taken off{' '}
        <span className="font-mono">{receipt.ledgerCode}</span> and booked to the account you pick, dated today. Only once the sale is on the books
        (its shift closed).
      </p>
      <select value={contra} onChange={(e) => setContra(e.target.value as Contra)} className={`${inputCls} w-full`}>
        {(Object.keys(CONTRA_LABEL) as Array<keyof typeof CONTRA_LABEL>).map((c) => <option key={c} value={c}>{CONTRA_LABEL[c]}</option>)}
      </select>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="what happened (required)" className={`${inputCls} w-full`} />
      {writeOff.error && <p className="text-s-red">{errorText(writeOff.error)}</p>}
      <div className="flex gap-3">
        <button onClick={() => writeOff.mutate()} disabled={writeOff.isPending || reason.trim().length < 3} className="text-s-red font-semibold disabled:opacity-40">
          {writeOff.isPending ? 'Booking…' : `Write off ${fmtPkr(receipt.amountCents)}`}
        </button>
        <button onClick={onCancel} className="text-s-muted">Cancel</button>
      </div>
    </div>
  )
}

// ─── Unmatch (APPROVERS) ─────────────────────────────────────────────────────

function UnmatchPanel({ receipt, onDone, onCancel }: { receipt: RaastReceiptRow; onDone: (t: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('')
  const unmatch = useMutation({
    mutationFn: () => api.post(`/reconciliation/raast/receipts/${receipt.id}/unmatch`, reason.trim() ? { reason: reason.trim() } : {}, { tenantId: receipt.tenantId }),
    onSuccess: () => onDone(`Bill #${receipt.orderRef}'s Raast payment is provisional again; its statement line is free to match.`),
  })
  return (
    <div className="space-y-2 text-xs max-w-xl">
      {receipt.statementLine && (
        <p className="text-s-muted">
          Matched to <span className="text-s-text">{receipt.statementLine.postedDate.slice(0, 10)} · {receipt.statementLine.description}</span>{' '}
          ({fmtPkr(receipt.statementLine.amountCents)}). Unmatching puts the payment back to provisional.
        </p>
      )}
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why (optional, recorded)" className={`${inputCls} w-full`} />
      {unmatch.error && <p className="text-s-red">{errorText(unmatch.error)}</p>}
      <div className="flex gap-3">
        <button onClick={() => unmatch.mutate()} disabled={unmatch.isPending || (reason.trim().length > 0 && reason.trim().length < 3)} className="text-primary-ink font-semibold disabled:opacity-40">
          {unmatch.isPending ? 'Unmatching…' : 'Unmatch'}
        </button>
        <button onClick={onCancel} className="text-s-muted">Cancel</button>
      </div>
    </div>
  )
}

// ─── Resolve a needs-attention payment (APPROVERS — RV-FIN-1) ────────────────

const RESOLVE_LABEL = {
  refunded_to_customer: 'Refunded to the customer (a transfer sent back)',
  not_a_sale: 'Not a sale (the transfer was something else)',
  booked_elsewhere: 'Booked elsewhere (finance adjusted the statement line)',
} as const
type ResolveOutcome = keyof typeof RESOLVE_LABEL

function ResolvePanel({ receipt, onDone, onCancel }: { receipt: RaastReceiptRow; onDone: (t: string) => void; onCancel: () => void }) {
  const [outcome, setOutcome] = useState<ResolveOutcome>('refunded_to_customer')
  const [reason, setReason] = useState('')
  const [refundRef, setRefundRef] = useState('')
  const resolve = useMutation({
    mutationFn: () => api.post(`/reconciliation/raast/receipts/${receipt.id}/resolve`, {
      outcome, reason: reason.trim(), ...(outcome === 'refunded_to_customer' && refundRef.trim() && { refundReference: refundRef.trim() }),
    }, { tenantId: receipt.tenantId }),
    onSuccess: () => onDone(`Bill #${receipt.orderRef}'s Raast payment that needed attention is resolved (${RESOLVE_LABEL[outcome].split(' (')[0]!.toLowerCase()}). Book the statement credit${outcome === 'refunded_to_customer' ? ' and the refund going out' : ''} on the Bank Imports tab.`),
  })
  return (
    <div className="space-y-2 text-xs max-w-xl">
      <p className="text-s-muted">
        A bank transfer reached this bill but servd could not book it, and the bill is now closed. Nothing is posted here — the transfer was never
        booked as a sale. Book the money on its statement line (Bank Imports → Adjust). Its bank SMS is closed and its reference can never pay a bill.
      </p>
      <select value={outcome} onChange={(e) => setOutcome(e.target.value as ResolveOutcome)} className={`${inputCls} w-full`}>
        {(Object.keys(RESOLVE_LABEL) as ResolveOutcome[]).map((o) => <option key={o} value={o}>{RESOLVE_LABEL[o]}</option>)}
      </select>
      {outcome === 'refunded_to_customer' && (
        <input value={refundRef} onChange={(e) => setRefundRef(e.target.value)} placeholder="reference of the transfer sent back (optional)" autoComplete="off" spellCheck={false}
          className={`${inputCls} w-full font-mono uppercase`} />
      )}
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="what happened (required)" className={`${inputCls} w-full`} />
      {resolve.error && <p className="text-s-red">{errorText(resolve.error)}</p>}
      <div className="flex gap-3">
        <button onClick={() => resolve.mutate()} disabled={resolve.isPending || reason.trim().length < 3} className="text-primary-ink font-semibold disabled:opacity-40">
          {resolve.isPending ? 'Saving…' : 'Resolve'}
        </button>
        <button onClick={onCancel} className="text-s-muted">Cancel</button>
      </div>
    </div>
  )
}

// ─── Void, never booked (RV-MONEY-1 — the CEO only; finance asks) ───────────

const VOID_EXPLAINER = 'Only for a provisional payment on a cancelled or rejected bill that no entry ever put in the bank (its drawers are closed, nothing failed, nothing was paid back). '
  + 'Voiding makes no ledger entry and the bank reference stays used, so the same transfer can never pay another bill. '
  + 'If the money did reach the bank, book the statement credit with the bank line’s own adjustment (Bank Imports → Adjust).'

function VoidRequestPanel({ receipt, onDone, onCancel }: { receipt: RaastReceiptRow; onDone: (t: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('')
  const ask = useMutation({
    mutationFn: () => api.post(`/reconciliation/raast/receipts/${receipt.id}/void-request`, { reason: reason.trim() }, { tenantId: receipt.tenantId }),
    onSuccess: () => onDone(`Asked the CEO to void bill #${receipt.orderRef}'s Raast payment (${fmtPkr(receipt.amountCents)}). It is in the CEO's approvals inbox.`),
  })
  return (
    <div className="space-y-2 text-xs max-w-xl">
      <p className="text-s-muted">{VOID_EXPLAINER}</p>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why it was never booked (required, a sentence)" className={`${inputCls} w-full`} />
      {ask.error && <p className="text-s-red">{errorText(ask.error)}</p>}
      <div className="flex gap-3">
        <button onClick={() => ask.mutate()} disabled={ask.isPending || reason.trim().length < 10} className="text-primary-ink font-semibold disabled:opacity-40">
          {ask.isPending ? 'Sending…' : 'Ask the CEO to void'}
        </button>
        <button onClick={onCancel} className="text-s-muted">Cancel</button>
      </div>
    </div>
  )
}

function VoidPanel({ receipt, onDone, onCancel }: { receipt: RaastReceiptRow; onDone: (t: string) => void; onCancel: () => void }) {
  const ask = receipt.voidRequest?.pending ? receipt.voidRequest : null
  const [reason, setReason] = useState(ask?.reason ?? '')
  const [understood, setUnderstood] = useState(false)
  const voidIt = useMutation({
    mutationFn: () => api.post(`/reconciliation/raast/receipts/${receipt.id}/void`, { reason: reason.trim() }, { tenantId: receipt.tenantId }),
    onSuccess: () => onDone(`Bill #${receipt.orderRef}'s Raast payment (${fmtPkr(receipt.amountCents)}) is voided — never booked. No ledger entry was made; reference ${receipt.bankRef ?? '—'} stays used.`),
  })
  return (
    <div className="space-y-2 text-xs max-w-xl">
      <p className="text-s-muted">{VOID_EXPLAINER}</p>
      {ask && (
        <p className="text-s-text">
          Asked for by {ask.by?.name ?? 'finance'} on {fmtWhen(ask.at)}{ask.reason ? `: “${ask.reason}”` : ''}.
        </p>
      )}
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why it was never booked (required, a sentence)" className={`${inputCls} w-full`} />
      <label className="flex items-start gap-2 text-s-text">
        <input type="checkbox" className="mt-0.5 accent-primary" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
        <span>No ledger entry is made. The statement credit, if the money arrived, is booked with the bank-line adjustment.</span>
      </label>
      {voidIt.error && <p className="text-s-red">{errorText(voidIt.error)}</p>}
      <div className="flex gap-3">
        <button onClick={() => voidIt.mutate()} disabled={voidIt.isPending || !understood || reason.trim().length < 10} className="text-s-red font-semibold disabled:opacity-40">
          {voidIt.isPending ? 'Voiding…' : `Void ${fmtPkr(receipt.amountCents)} — never booked`}
        </button>
        <button onClick={onCancel} className="text-s-muted">Cancel</button>
      </div>
    </div>
  )
}

function VoidRejectPanel({ receipt, onDone, onCancel }: { receipt: RaastReceiptRow; onDone: (t: string) => void; onCancel: () => void }) {
  const [note, setNote] = useState('')
  const reject = useMutation({
    mutationFn: () => api.post(`/reconciliation/raast/receipts/${receipt.id}/void-request/reject`, { note: note.trim() }, { tenantId: receipt.tenantId }),
    onSuccess: () => onDone(`The ask to void bill #${receipt.orderRef}'s Raast payment was turned down; the payment stays provisional.`),
  })
  return (
    <div className="space-y-2 text-xs max-w-xl">
      <p className="text-s-muted">The payment stays provisional — finance matches it, or a CEO / co-owner marks it not received once its sale is booked.</p>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="a note for finance (required)" className={`${inputCls} w-full`} />
      {reject.error && <p className="text-s-red">{errorText(reject.error)}</p>}
      <div className="flex gap-3">
        <button onClick={() => reject.mutate()} disabled={reject.isPending || note.trim().length < 3} className="text-primary-ink font-semibold disabled:opacity-40">
          {reject.isPending ? 'Saving…' : 'Turn down the ask'}
        </button>
        <button onClick={onCancel} className="text-s-muted">Cancel</button>
      </div>
    </div>
  )
}

// ─── Bank SMS log (read only) ────────────────────────────────────────────────

function SmsLog() {
  const [status, setStatus] = useState('')
  const [shown, setShown] = useState<string | null>(null)
  const alerts = useInfiniteQuery({
    queryKey: ['raast-sms-log', status],
    queryFn: ({ pageParam }) => api.get<{ alerts: SmsAlertRow[]; nextCursor: string | null }>(
      `/reconciliation/raast/alerts?limit=50${status ? `&status=${status}` : ''}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  const rows = alerts.data?.pages.flatMap((p) => p.alerts) ?? []
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-s-muted">
          <span className="block mb-0.5">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
            <option value="">Every bank SMS</option>
            {Object.entries(ALERT_STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <p className="text-[11px] text-s-dim pb-1">
          Read only. A bank SMS with no bill is attached at the till (Bank alerts); a manager marks one that is not a sale. Only SMS from the
          bank senders IT listed are kept — OTPs and other messages never are.
        </p>
      </div>
      <div className="s-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-s-muted bg-s-bg-soft">
              <tr>
                <th className="px-3 py-2 text-left">Received</th>
                <th className="px-3 py-2 text-left">From</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-left">Reference</th>
                <th className="px-3 py-2 text-left">Account</th>
                <th className="px-3 py-2 text-left">State</th>
              </tr>
            </thead>
            <tbody>
              {alerts.isLoading && <tr><td colSpan={6} className="px-4 py-8 text-center text-xs text-s-muted">Loading…</td></tr>}
              {alerts.isError && <tr><td colSpan={6} className="px-4 py-6 text-center text-xs text-s-red">{errorText(alerts.error)}</td></tr>}
              {!alerts.isLoading && !alerts.isError && rows.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-xs text-s-muted">No bank SMS yet.</td></tr>}
              {rows.map((a) => (
                <Fragment key={a.id}>
                  <tr className="border-t border-s-border align-top">
                    <td className="px-3 py-2 text-xs text-s-muted whitespace-nowrap">{fmtWhen(a.occurredAt ?? a.receivedAt)}</td>
                    <td className="px-3 py-2 text-xs text-s-text">
                      <span className="font-mono">{a.sender}</span>
                      {a.payer && <span className="block text-[11px] text-s-muted">{a.payer}</span>}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono text-xs ${a.kind === 'debit' ? 'text-s-red' : 'text-s-text'}`}>
                      {a.amountCents != null ? `${a.kind === 'debit' ? '-' : ''}${fmtPkr(a.amountCents)}` : '—'}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-s-text">{a.bankRef ?? '—'}</td>
                    <td className="px-3 py-2 text-xs text-s-muted">{a.bankAccount ? `${a.bankAccount.name}${a.bankAccount.last4 ? ` ••${a.bankAccount.last4}` : ''}` : (a.accountLast4 ? `••${a.accountLast4}` : '—')}</td>
                    <td className="px-3 py-2 text-xs">
                      <span className="text-s-text">{ALERT_STATUS_LABEL[a.status] ?? a.status}</span>
                      {a.receipt && <Link href={`/orders/${a.receipt.orderId}`} className="block font-mono text-[11px] text-primary-ink hover:underline">#{a.receipt.orderRef}</Link>}
                      {a.resolution && <span className="block text-[11px] text-s-muted">{a.resolution}</span>}
                      {a.body && (
                        <button onClick={() => setShown(shown === a.id ? null : a.id)} className="block text-[11px] text-s-muted underline">
                          {shown === a.id ? 'Hide the message' : 'Show the message'}
                        </button>
                      )}
                    </td>
                  </tr>
                  {shown === a.id && a.body && (
                    <tr className="border-t border-s-border/50 bg-s-bg-soft/40">
                      <td colSpan={6} className="px-4 py-2 text-xs text-s-text font-mono whitespace-pre-wrap break-words">{a.body}</td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {alerts.hasNextPage && (
          <div className="border-t border-s-border px-4 py-2 text-center">
            <button onClick={() => void alerts.fetchNextPage()} disabled={alerts.isFetchingNextPage} className="text-xs text-primary-ink">
              {alerts.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
