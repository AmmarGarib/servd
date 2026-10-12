'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { api, posApi, ApiError, type ZReport } from '../../lib/api'
import { fmtPkr, todayPktIso } from '../../lib/money'
import { orderRef } from '../../lib/orderRef'
import { format } from 'date-fns'
import { BackfillUnposted } from './BackfillUnposted'
import { MissedBillVariances } from './MissedBillVariances'
import { RaastTab } from './RaastTab'
import { OpenTicketsCloseConfirm } from '../../components/pos/OpenTicketsCloseConfirm'
import { closeDrawer, isOpenTicketsError, type ZReportExtras } from '../../components/pos/tillApi'
import { useAuthStore } from '../../store/auth'

// Who may do what on this page — the API decides; these only hide buttons the
// API would refuse (wave 3: finance reads and works reconciliation, but a
// red 403 behind a button it was shown is the bug we are removing).
//   Closing a drawer is the till's close (POST /pos/shifts/:id/close, CASHIERS).
//   Booking an adjustment journal is the approvers' (CEO + co-owners).
//   Undoing a generic statement match is the approvers' too (S3).
const DRAWER_CLOSERS = ['admin', 'owner', 'manager', 'management', 'foh_management', 'boh_management', 'fnb_manager', 'cashier', 'foh']
const ADJUSTMENT_BOOKERS = ['admin', 'owner']
const LINE_UNMATCHERS = ['admin', 'owner']

// ─── Types ────────────────────────────────────────────────────────────────────

interface ShiftSummaryRow {
  shiftId: string
  cashier: string
  openedAt: string
  closedAt: string | null
  status: string
  totalSalesCents: number
  /** Raast QR takings (absent on an API without Raast). */
  raastSalesCents?: number
  cashSalesCents: number
  expectedCashCents: number
  closingFloatCents: number | null
  varianceCents: number | null
  varianceLimitCents: number
  isBalanced: boolean
  notes: string | null
}

interface SummaryResp {
  dateFrom: string
  dateTo: string
  totalShifts: number
  balancedShifts: number
  shifts: ShiftSummaryRow[]
}

interface BankImport {
  id: string; source: string; accountCode: string; statementDate: string
  bankAccountId: string | null
  openingBalanceCents: number; closingBalanceCents: number
  filename: string | null
  _count: { lines: number }
}

interface BankAccountOpt { id: string; name: string; bankName: string | null; accountCode: string | null; raastDefault?: boolean }

interface StatementLine {
  id: string; postedDate: string; description: string; reference: string | null
  amountCents: number; matchStatus: 'unmatched' | 'matched' | 'adjusted' | 'ignored'; notes: string | null
  /** The Raast QR payment this line matched (absent on an API without Raast). */
  raastReceipt?: { id: string; bankRef: string | null; orderId: string; amountCents: number } | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ReconTab = 'shifts' | 'bank' | 'raast'
const TABS: readonly ReconTab[] = ['shifts', 'bank', 'raast']

// The till's tenders (owner, 2026-10-12): Cash, Card – Keenu, Raast QR.
// Keenu QR is retired — its rows are older sales.
const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash', card: 'Card – Keenu', raast: 'Raast QR', keenu_qr: 'Keenu QR (retired)', comp: 'Comps', split: 'Split',
}

/**
 * The bank accounts Raast QR payments land in (the company default, and every
 * brand's own), so the statement view can warn before an adjustment books a
 * customer's transfer a second time. Best effort: an API without Raast, or a
 * portfolio view, gives the defaults only.
 */
function useRaastAccountIds(banks: BankAccountOpt[]): Set<string> {
  const { data } = useQuery<{ brands: Array<{ overrideBankAccountId: string | null }> }>({
    queryKey: ['raast-accounts'],
    queryFn: () => api.get('/setup/raast-accounts'),
    retry: false,
    staleTime: 60_000,
  })
  return useMemo(() => {
    const ids = new Set<string>(banks.filter((b) => b.raastDefault).map((b) => b.id))
    for (const b of data?.brands ?? []) if (b.overrideBankAccountId) ids.add(b.overrideBankAccountId)
    return ids
  }, [banks, data])
}

// Balanced is the server's verdict against the drawer company's own
// tolerance (Configuration → Receipts) — never a threshold of our own.
function VariancePill({ cents, balanced }: { cents: number | null; balanced: boolean }) {
  if (cents === null) return <span className="text-xs text-s-muted">Pending</span>
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
      balanced ? 'bg-green-100/20 text-green-700' : 'bg-red-100/20 text-red-700'
    }`}>
      {cents === 0 ? 'Balanced' : cents > 0 ? `+${fmtPkr(cents)}` : fmtPkr(cents)}
    </span>
  )
}

// ─── Shift detail panel ────────────────────────────────────────────────────────
// The Z-report (GET /pos/shifts/:id/zreport) is the one shift summary, and
// POST /pos/shifts/:id/close is the one close — the same close the till uses,
// which posts the shift to the ledger. A manager can close any drawer here
// (an abandoned one, say); the till re-syncs from the server and lets go.

function ShiftDetailPanel({
  shiftId,
  onClose,
}: { shiftId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [closingFloat, setClosingFloat] = useState('')
  const [notes, setNotes] = useState('')

  const { data, isLoading, error } = useQuery<ZReport & ZReportExtras>({
    queryKey: ['recon-shift', shiftId],
    queryFn: () => posApi.getZReport(shiftId),
  })

  // TILL-R1: a drawer with unpaid tickets on it answers 409 OPEN_TICKETS.
  // The tickets are named (the Z-report above lists them, refreshed on the
  // refusal) and the manager confirms "Close anyway" (confirmOpenTickets).
  const [openTicketsBlock, setOpenTicketsBlock] = useState<string | null>(null)
  const canCloseDrawer = useAuthStore((s) => s.isRole(...DRAWER_CLOSERS))
  const complete = useMutation({
    mutationFn: (confirmOpenTickets: boolean) =>
      closeDrawer<ZReport>(shiftId, Math.round(parseFloat(closingFloat) * 100), { notes: notes || undefined, confirmOpenTickets }),
    onSuccess: () => {
      setOpenTicketsBlock(null)
      void qc.invalidateQueries({ queryKey: ['recon-shift', shiftId] })
      void qc.invalidateQueries({ queryKey: ['recon-summary'] })
    },
    onError: (e) => {
      if (!isOpenTicketsError(e)) return
      setOpenTicketsBlock((e as Error).message)
      void qc.invalidateQueries({ queryKey: ['recon-shift', shiftId] })
    },
  })
  const closeError = complete.isError && !isOpenTicketsError(complete.error) ? (complete.error as Error).message : null

  const inp = 'rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-s-teal focus:outline-none w-full'

  return (
    <div className="fixed inset-0 bg-secondary/50 flex items-center justify-center z-50 p-4">
      <div className="bg-s-bg border border-s-border rounded-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-s-bg border-b border-s-border px-5 py-4 flex items-center justify-between">
          <p className="font-bold text-s-text">Shift Reconciliation</p>
          <button onClick={onClose} className="text-s-muted hover:text-s-text text-xl leading-none">✕</button>
        </div>

        {isLoading && <p className="p-6 text-s-muted">Loading…</p>}
        {error && <p className="p-6 text-s-red text-sm">{(error as Error).message}</p>}

        {data && (
          <div className="p-5 space-y-5">
            {/* Summary header */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-s-text">{data.staffName}</p>
                <p className="text-xs text-s-muted">
                  {format(new Date(data.openedAt), 'dd MMM yyyy, HH:mm')}
                  {data.closedAt && ` → ${format(new Date(data.closedAt), 'HH:mm')}`}
                </p>
              </div>
              <VariancePill cents={data.varianceCents} balanced={data.isBalanced} />
            </div>

            {/* Breakdown table */}
            <div className="rounded-xl border border-s-border overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-muted uppercase tracking-wide">
                Cash breakdown
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {[
                    { label: 'Opening float', value: data.openingFloatCents },
                    { label: 'Cash sales', value: data.cashSales },
                    { label: 'Cash refunds', value: -data.cashRefundsCents },
                    { label: 'Drops to safe', value: -data.cashMovements.drops },
                    { label: 'Pay-outs', value: -data.cashMovements.payouts },
                    { label: 'Cash added', value: data.cashMovements.adds },
                    { label: 'Pay-ins', value: data.cashMovements.payins },
                  ].filter((row) => row.value !== 0 || row.label === 'Opening float' || row.label === 'Cash sales').map((row) => (
                    <tr key={row.label} className="border-b border-s-border last:border-0">
                      <td className="px-4 py-2.5 text-s-muted">{row.label}</td>
                      <td className={`px-4 py-2.5 text-right font-mono ${row.value < 0 ? 'text-s-red' : 'text-s-text'}`}>
                        {row.value < 0 ? `-${fmtPkr(-row.value)}` : fmtPkr(row.value)}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-s-border font-semibold">
                    <td className="px-4 py-2.5 text-s-text">Expected cash</td>
                    <td className="px-4 py-2.5 text-right font-mono text-primary-ink">{fmtPkr(data.expectedCashCents)}</td>
                  </tr>
                  {data.closingFloatCents !== null && (
                    <>
                      <tr className="border-b border-s-border">
                        <td className="px-4 py-2.5 text-s-muted">Closing float (counted)</td>
                        <td className="px-4 py-2.5 text-right font-mono text-s-text">{fmtPkr(data.closingFloatCents)}</td>
                      </tr>
                      <tr>
                        <td className="px-4 py-2.5 text-s-text font-semibold">
                          Variance
                          <span className="block text-[10px] font-normal text-s-muted">tolerance ±{fmtPkr(data.varianceLimitCents)}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <VariancePill cents={data.varianceCents} balanced={data.isBalanced} />
                        </td>
                      </tr>
                    </>
                  )}
                </tbody>
              </table>
              </div>
            </div>

            {/* Tenders */}
            <div className="rounded-xl border border-s-border overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-muted uppercase tracking-wide">
                Tenders ({data.totalOrders} orders)
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {data.byMethod.map((m) => (
                    <tr key={m.method} className="border-b border-s-border">
                      <td className="px-4 py-2.5 text-s-muted">{METHOD_LABEL[m.method] ?? m.method} <span className="text-xs">({m.count})</span></td>
                      <td className="px-4 py-2.5 text-right font-mono text-s-text">{fmtPkr(m.amountCents)}</td>
                    </tr>
                  ))}
                  {data.refundsCents > 0 && (
                    <tr className="border-b border-s-border">
                      <td className="px-4 py-2.5 text-s-muted">Refunds</td>
                      <td className="px-4 py-2.5 text-right font-mono text-s-red">-{fmtPkr(data.refundsCents)}</td>
                    </tr>
                  )}
                  <tr className="font-semibold">
                    <td className="px-4 py-2.5 text-s-muted">Total sales (cash + card + Raast)</td>
                    <td className="px-4 py-2.5 text-right font-mono text-primary-ink">{fmtPkr(data.grossCents)}</td>
                  </tr>
                  {(data.raastProvisionalCents ?? 0) > 0 && (
                    <tr>
                      <td colSpan={2} className="px-4 py-2 text-xs text-s-amber">
                        {fmtPkr(data.raastProvisionalCents ?? 0)} of the Raast takings is not on a bank statement yet — see the Raast tab.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              </div>
            </div>

            {/* Close — only for a drawer still open, and only for the roles
                the till's close lets in; finance sees that it is still open. */}
            {data.status === 'open' && !canCloseDrawer && (
              <p className="text-xs text-s-muted">This drawer is still open. A manager or the cashier closes it from the till or here.</p>
            )}
            {data.status === 'open' && canCloseDrawer && (
              <div className="rounded-xl border border-s-border p-4 space-y-3">
                <p className="text-sm font-semibold text-s-text">Close this shift</p>
                <p className="text-xs text-s-muted">
                  Count the cash in the drawer and enter the total. This is the same close the till uses — it posts the shift to the books.
                </p>
                <div>
                  <label className="text-xs text-s-muted block mb-1">Closing float (PKR)</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={closingFloat}
                    onChange={(e) => setClosingFloat(e.target.value)}
                    placeholder="e.g. 5000"
                    className={inp}
                  />
                </div>
                <div>
                  <label className="text-xs text-s-muted block mb-1">Notes (optional)</label>
                  <input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Any discrepancy explanations…"
                    className={inp}
                  />
                </div>
                {openTicketsBlock ? (
                  <OpenTicketsCloseConfirm
                    tone="admin"
                    openTickets={data.openTickets ?? null}
                    message={openTicketsBlock}
                    confirming={complete.isPending}
                    error={closeError}
                    onBack={() => { setOpenTicketsBlock(null); complete.reset() }}
                    onConfirm={() => complete.mutate(true)}
                  />
                ) : (
                  <>
                    {closeError && (
                      <p className="text-sm text-s-red">{closeError}</p>
                    )}
                    <button
                      onClick={() => complete.mutate(false)}
                      disabled={complete.isPending || !closingFloat}
                      className="w-full rounded-xl bg-primary text-primary-on font-bold py-2.5 text-sm hover:opacity-90 disabled:opacity-40">
                      {complete.isPending ? 'Closing…' : 'Close shift'}
                    </button>
                  </>
                )}
              </div>
            )}
            {complete.data && (
              <div className={`rounded-lg p-3 text-sm ${complete.data.isBalanced ? 'bg-green-100/20 text-green-700' : 'bg-red-100/20 text-red-700'}`}>
                {complete.data.isBalanced
                  ? 'Balanced — shift closed and posted.'
                  : `Variance of ${fmtPkr(Math.abs(complete.data.varianceCents ?? 0))} flagged for review. Shift closed and posted.`}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Bank import form ──────────────────────────────────────────────────────────
// A statement is always FOR a bank account (Configuration → Bank accounts):
// its ledger code and label come from there, so a deposit posted to that
// bank's code can auto-match its statement line. Card-gateway settlements
// reconcile against 1030 instead.

const GATEWAY = '__gateway__'

function BankImportForm({ onDone }: { onDone: () => void }) {
  const { data: banks = [] } = useQuery<BankAccountOpt[]>({ queryKey: ['bank-accounts'], queryFn: () => api.get('/setup/bank-accounts') })
  const [target, setTarget] = useState('')
  const [statementDate, setStatementDate] = useState(todayPktIso())
  const [opening, setOpening] = useState(0)
  const [closing, setClosing] = useState(0)
  const [csv, setCsv] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const picked = target || banks[0]?.id || ''
  const label = picked === GATEWAY ? 'keenu' : (banks.find((b) => b.id === picked)?.name ?? 'bank')

  // Bank import requires filename + fileUrl — for the admin UI we accept
  // a paste-in flow and use a sentinel filename so the schema passes.
  const submit = useMutation({
    mutationFn: () => api.post('/reconciliation/bank/imports', {
      ...(picked === GATEWAY ? { source: 'keenu', accountCode: '1030' } : { bankAccountId: picked }),
      statementDate,
      // Whole paisa: 100.10 * 100 is 10009.999…, which the API refuses.
      openingBalanceCents: Math.round(opening * 100), closingBalanceCents: Math.round(closing * 100),
      csv,
      filename: `${label}-${statementDate}.csv`,
      fileUrl: `data:text/csv;base64,${btoa(csv)}`,
    }),
    onSuccess: onDone,
    onError: (e: { message?: string }) => setErr(e.message ?? 'Import failed'),
  })

  return (
    <div className="p-4 border-b border-s-border space-y-2 text-sm">
      <div className="grid grid-cols-2 gap-2">
        <select value={picked} onChange={(e) => setTarget(e.target.value)} className="bg-s-card border border-s-border rounded px-2 py-1 text-s-text">
          {banks.map((b) => <option key={b.id} value={b.id}>{b.name}{b.accountCode ? ` (${b.accountCode})` : ''}</option>)}
          <option value={GATEWAY}>Card / gateway settlement (1030)</option>
        </select>
        <input type="date" value={statementDate} onChange={(e) => setStatementDate(e.target.value)} className="bg-s-card border border-s-border rounded px-2 py-1 text-s-text" />
        <input type="number" value={opening} onChange={(e) => setOpening(parseFloat(e.target.value) || 0)} placeholder="opening (PKR)" className="bg-s-card border border-s-border rounded px-2 py-1 text-s-text" />
        <input type="number" value={closing} onChange={(e) => setClosing(parseFloat(e.target.value) || 0)} placeholder="closing (PKR)" className="bg-s-card border border-s-border rounded px-2 py-1 text-s-text" />
      </div>
      {banks.length === 0 && <p className="text-xs text-s-muted">No bank accounts yet — add one in Configuration → Bank accounts.</p>}
      <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={6} placeholder="Paste CSV (date,description,amount,reference)" className="w-full bg-s-card border border-s-border rounded px-2 py-1 text-s-text font-mono text-xs" />
      {err && <p className="text-s-red text-xs">{err}</p>}
      <button onClick={() => submit.mutate()} disabled={submit.isPending || !picked} className="s-btn-primary text-xs">
        {submit.isPending ? 'Importing…' : 'Import'}
      </button>
    </div>
  )
}

// ─── Statement lines — clear what didn't auto-match ───────────────────────────
// "Book adjustment" posts the line against one account for the whole amount,
// or SPLIT across several (BOOKS-11): a Keenu settlement that lands net of its
// MDR books Dr bank (the line) + Dr 6080 fee / Cr 1030 gross, so the card
// receivable clears in full. The split must balance against the line; the
// API refuses it otherwise. Booking is for the CEO and co-owners; finance
// ignores lines and leaves the booking to them.

interface SplitRow { code: string; type: 'debit' | 'credit'; amount: string }

const toCents = (pkr: string) => Math.round((parseFloat(pkr) || 0) * 100)

function AdjustForm({ line, raastAccount, onDone, onCancel }: { line: StatementLine; raastAccount: boolean; onDone: () => void; onCancel: () => void }) {
  const inflow = line.amountCents > 0
  const abs = Math.abs(line.amountCents)
  const bankSide: 'debit' | 'credit' = inflow ? 'debit' : 'credit'
  const otherSide: 'debit' | 'credit' = inflow ? 'credit' : 'debit'
  const [split, setSplit] = useState(false)
  const [contra, setContra] = useState('')
  const [memo, setMemo] = useState('')
  const [rows, setRows] = useState<SplitRow[]>([
    { code: '', type: otherSide, amount: (abs / 100).toFixed(2) },
    { code: '6080', type: bankSide, amount: '' },
  ])

  const debits  = (bankSide === 'debit'  ? abs : 0) + rows.filter((r) => r.type === 'debit').reduce((t, r) => t + toCents(r.amount), 0)
  const credits = (bankSide === 'credit' ? abs : 0) + rows.filter((r) => r.type === 'credit').reduce((t, r) => t + toCents(r.amount), 0)
  const off = debits - credits
  const splitReady = rows.every((r) => r.code.trim() && toCents(r.amount) > 0) && off === 0

  const adjust = useMutation({
    mutationFn: () => api.post(`/reconciliation/bank/lines/${line.id}/adjust`, split
      ? { memo: memo.trim(), lines: rows.map((r) => ({ accountCode: r.code.trim(), type: r.type, amountCents: toCents(r.amount) })) }
      : { memo: memo.trim(), contraAccountCode: contra.trim() }),
    onSuccess: onDone,
  })
  const setRow = (i: number, patch: Partial<SplitRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const inp = 'bg-s-card border border-s-border rounded px-1.5 py-0.5 text-s-text'

  return (
    <div className="px-4 py-3 space-y-2 text-xs">
      {inflow && raastAccount && (
        <p role="alert" className="rounded-lg border border-s-amber/40 bg-s-amber-dim px-3 py-2 text-s-text">
          This account receives Raast QR payments. If this credit is a customer&rsquo;s Raast payment for a bill, match it on the Raast tab instead —
          the sale already booked it to this bank account, so an adjustment would book it twice.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-1"><input type="radio" name={`adjust-mode-${line.id}`} checked={!split} onChange={() => setSplit(false)} /> One account</label>
        <label className="inline-flex items-center gap-1"><input type="radio" name={`adjust-mode-${line.id}`} checked={split} onChange={() => setSplit(true)} /> Split (e.g. card settlement less fee)</label>
      </div>
      {!split ? (
        <div className="flex flex-wrap gap-2">
          <input value={contra} onChange={(e) => setContra(e.target.value)} placeholder="account code (6080)" className={`${inp} w-36`} />
        </div>
      ) : (
        <div className="space-y-1.5">
          <p className="text-s-muted">
            This line: <span className="font-mono">{bankSide === 'debit' ? 'Dr' : 'Cr'} {fmtPkr(abs)}</span> to the statement&rsquo;s account. Other side:
          </p>
          {rows.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input value={r.code} onChange={(e) => setRow(i, { code: e.target.value })} placeholder="code" className={`${inp} w-20 font-mono`} />
              <select value={r.type} onChange={(e) => setRow(i, { type: e.target.value as 'debit' | 'credit' })} className={inp}>
                <option value="debit">Dr</option>
                <option value="credit">Cr</option>
              </select>
              <input type="number" min="0" step="0.01" value={r.amount} onChange={(e) => setRow(i, { amount: e.target.value })} placeholder="PKR" className={`${inp} w-28 text-right`} />
              {rows.length > 1 && <button onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="text-s-muted hover:text-s-text">Remove</button>}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={() => setRows((rs) => [...rs, { code: '', type: otherSide, amount: '' }])} className="text-primary-ink">+ Add line</button>
            <span className={off === 0 ? 'text-green-700' : 'text-s-red'}>
              {off === 0 ? 'Balanced' : `Off by ${fmtPkr(Math.abs(off))} (${off > 0 ? 'more debits' : 'more credits'})`}
            </span>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="memo (what this is)" className={`${inp} flex-1 min-w-[10rem]`} />
        <button
          onClick={() => adjust.mutate()}
          disabled={!memo.trim() || adjust.isPending || (split ? !splitReady : !contra.trim())}
          className="text-primary-ink font-semibold disabled:opacity-40">
          {adjust.isPending ? 'Booking…' : 'Book'}
        </button>
        <button onClick={onCancel} className="text-s-muted">Cancel</button>
      </div>
      {adjust.error && <p className="text-s-red">{(adjust.error as Error).message}</p>}
    </div>
  )
}

function StatementLines({ importId, raastAccount, onOpenRaast }: { importId: string; raastAccount: boolean; onOpenRaast: () => void }) {
  const qc = useQueryClient()
  const [adjusting, setAdjusting] = useState<string | null>(null)
  const canBook = useAuthStore((s) => s.isRole(...ADJUSTMENT_BOOKERS))
  const canUnmatch = useAuthStore((s) => s.isRole(...LINE_UNMATCHERS))
  const { data: lines = [], isLoading } = useQuery<StatementLine[]>({
    queryKey: ['bank-lines', importId],
    queryFn: () => api.get(`/reconciliation/bank/imports/${importId}/lines`),
  })
  const refresh = () => void qc.invalidateQueries({ queryKey: ['bank-lines', importId] })
  const ignore = useMutation({ mutationFn: (id: string) => api.post(`/reconciliation/bank/lines/${id}/ignore`, {}), onSuccess: refresh })
  // S3: undo a GENERIC match (the matcher paired the line with the wrong
  // journal line). A line matched to a Raast payment is unmatched on the Raast tab.
  const unmatch = useMutation({
    mutationFn: (id: string) => api.post(`/reconciliation/bank/lines/${id}/unmatch`, {}),
    onSuccess: () => { refresh(); void qc.invalidateQueries({ queryKey: ['raast-receipts'] }) },
  })
  const lineError = ignore.error ?? unmatch.error

  if (isLoading) return <p className="px-4 py-3 text-xs text-s-muted">Loading lines…</p>
  return (
    <div className="bg-s-bg-soft/40 overflow-x-auto">
      {lineError && (
        <p className="px-4 pt-2 text-xs text-s-red">
          {lineError instanceof ApiError && lineError.code === 'RAAST_MATCHED_LINE'
            ? 'That line is matched to a Raast payment — unmatch it on the Raast tab.'
            : (lineError as Error).message}
        </p>
      )}
      <table className="w-full text-xs">
        <tbody>
          {lines.map((l) => (
            <Fragment key={l.id}>
              <tr className="border-t border-s-border align-top">
                <td className="px-4 py-2 text-s-muted whitespace-nowrap">{l.postedDate.slice(0, 10)}</td>
                <td className="px-4 py-2 text-s-text">
                  {l.description}{l.reference && <span className="text-s-muted"> · {l.reference}</span>}
                  {l.raastReceipt && (
                    <button onClick={onOpenRaast} title={`Raast payment${l.raastReceipt.bankRef ? ` ${l.raastReceipt.bankRef}` : ''} on bill #${orderRef(l.raastReceipt.orderId)}`}
                      className="ml-2 s-badge-green text-[10px] font-semibold">
                      Raast #{orderRef(l.raastReceipt.orderId)}
                    </button>
                  )}
                </td>
                <td className={`px-4 py-2 text-right font-mono ${l.amountCents < 0 ? 'text-s-red' : 'text-s-text'}`}>{fmtPkr(l.amountCents)}</td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  {l.matchStatus === 'matched' && !l.raastReceipt && canUnmatch ? (
                    <span className="inline-flex gap-3">
                      <span className="text-s-muted">matched</span>
                      <button onClick={() => { if (confirm('Undo this match? The line goes back to unmatched and its journal line is free again.')) unmatch.mutate(l.id) }}
                        disabled={unmatch.isPending} className="text-s-muted underline hover:text-s-text">Unmatch</button>
                    </span>
                  ) : l.matchStatus !== 'unmatched' ? (
                    <span className="text-s-muted">{l.matchStatus}</span>
                  ) : adjusting === l.id ? (
                    <span className="text-s-muted">booking…</span>
                  ) : (
                    <span className="inline-flex gap-3">
                      {canBook && <button onClick={() => setAdjusting(l.id)} className="text-primary-ink">Book adjustment</button>}
                      <button onClick={() => ignore.mutate(l.id)} className="text-s-muted hover:text-s-text">Ignore</button>
                    </span>
                  )}
                </td>
              </tr>
              {adjusting === l.id && l.matchStatus === 'unmatched' && (
                <tr className="border-t border-s-border/50">
                  <td colSpan={4} className="p-0">
                    <AdjustForm line={l} raastAccount={raastAccount} onCancel={() => setAdjusting(null)} onDone={() => { setAdjusting(null); refresh() }} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {lines.length === 0 && <tr><td className="px-4 py-3 text-s-muted">No lines</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ReconciliationPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<ReconTab>('shifts')
  // ?tab=raast (the period close and the Exceptions inbox link here). Read
  // once on mount from window, so the page needs no Suspense boundary.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab')
    if (t && (TABS as readonly string[]).includes(t)) setTab(t as ReconTab)
  }, [])
  const [selectedShift, setSelectedShift] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [openImport, setOpenImport] = useState<string | null>(null)

  const { data: summary, isLoading: summaryLoading } = useQuery<SummaryResp>({
    queryKey: ['recon-summary'],
    queryFn: () => api.get<SummaryResp>('/reconciliation/summary'),
    enabled: tab === 'shifts',
  })

  const { data: imports } = useQuery({
    queryKey: ['bank-imports'],
    queryFn: () => api.get<BankImport[]>('/reconciliation/bank/imports'),
    enabled: tab === 'bank',
  })
  const { data: banks = [] } = useQuery<BankAccountOpt[]>({
    queryKey: ['bank-accounts'],
    queryFn: () => api.get('/setup/bank-accounts'),
    enabled: tab === 'bank',
  })
  const raastAccountIds = useRaastAccountIds(banks)

  const balancedCount = summary?.balancedShifts ?? 0
  const totalCount = summary?.totalShifts ?? 0
  const unbalancedCount = totalCount - balancedCount

  return (
    <div className="min-h-screen bg-s-bg">
      {selectedShift && (
        <ShiftDetailPanel
          shiftId={selectedShift}
          onClose={() => setSelectedShift(null)}
        />
      )}

      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <h1 className="text-xl font-bold text-s-text">Reconciliation</h1>
        <p className="text-xs text-s-muted mt-0.5">POS shift cash reconciliation, bank statements and Raast QR payments</p>
      </header>

      <div className="p-6 max-w-5xl mx-auto space-y-4">

        {tab === 'shifts' && <BackfillUnposted />}
        {tab === 'shifts' && <MissedBillVariances />}

        {/* Summary KPI strip (shifts tab) */}
        {tab === 'shifts' && summary && (
          <div className="grid grid-cols-3 gap-3">
            <div className="s-card p-4">
              <p className="text-xs text-s-muted">Shifts (30 days)</p>
              <p className="text-2xl font-bold text-s-text mt-0.5">{totalCount}</p>
            </div>
            <div className="s-card p-4">
              <p className="text-xs text-s-muted">Balanced</p>
              <p className="text-2xl font-bold text-green-700 mt-0.5">{balancedCount}</p>
            </div>
            <div className="s-card p-4">
              <p className="text-xs text-s-muted">Variance / Pending</p>
              <p className={`text-2xl font-bold mt-0.5 ${unbalancedCount > 0 ? 'text-red-700' : 'text-s-muted'}`}>
                {unbalancedCount}
              </p>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 border-b border-s-border pb-0">
          {([
            { key: 'shifts', label: 'POS Shifts' },
            { key: 'bank', label: 'Bank Imports' },
            { key: 'raast', label: 'Raast' },
          ] as { key: ReconTab; label: string }[]).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
                tab === t.key
                  ? 'border-s-teal text-primary-ink bg-s-bg-soft'
                  : 'border-transparent text-s-muted hover:text-s-text'
              }`}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Shifts tab ── */}
        {tab === 'shifts' && (
          <div className="s-card overflow-hidden">
            <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">
              POS Shift Cash Reconciliation — last 30 days
            </div>
            {summaryLoading && (
              <div className="py-8 text-center text-s-muted text-sm">Loading shifts…</div>
            )}
            {!summaryLoading && (
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-s-muted bg-s-bg-soft">
                  <tr>
                    <th className="px-4 py-2 text-left">Cashier</th>
                    <th className="px-4 py-2 text-left">Opened</th>
                    <th className="px-4 py-2 text-left">Closed</th>
                    <th className="px-4 py-2 text-right">Total sales</th>
                    <th className="px-4 py-2 text-right">Raast</th>
                    <th className="px-4 py-2 text-right">Expected cash</th>
                    <th className="px-4 py-2 text-right">Variance</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {(summary?.shifts ?? []).map((s) => (
                    <tr
                      key={s.shiftId}
                      className="border-t border-s-border hover:bg-s-bg-soft/40 cursor-pointer"
                      onClick={() => setSelectedShift(s.shiftId)}>
                      <td className="px-4 py-2.5 text-s-text font-medium">{s.cashier}</td>
                      <td className="px-4 py-2.5 text-xs text-s-muted">
                        {format(new Date(s.openedAt), 'dd MMM, HH:mm')}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-s-muted">
                        {s.closedAt
                          ? format(new Date(s.closedAt), 'HH:mm')
                          : <span className="text-s-amber">Open</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-s-text">
                        {fmtPkr(s.totalSalesCents)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-s-muted">
                        {s.raastSalesCents ? fmtPkr(s.raastSalesCents) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-primary-ink">
                        {fmtPkr(s.expectedCashCents)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <VariancePill cents={s.varianceCents} balanced={s.isBalanced} />
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          onClick={(e) => { e.stopPropagation(); setSelectedShift(s.shiftId) }}
                          className="text-xs text-s-muted hover:text-primary-ink transition-colors">
                          {s.status === 'open' ? 'Close →' : 'View →'}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {(!summary || summary.shifts.length === 0) && !summaryLoading && (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center text-s-muted text-sm">
                        No POS shifts in the last 30 days
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              </div>
            )}
          </div>
        )}

        {/* ── Raast tab ── */}
        {tab === 'raast' && <RaastTab />}

        {/* ── Bank imports tab ── */}
        {tab === 'bank' && (
          <div className="s-card overflow-hidden">
            <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border flex items-center justify-between">
              <div className="text-xs font-semibold text-s-text">Bank Statement Imports</div>
              <button onClick={() => setShowImport(!showImport)} className="s-btn-secondary text-xs">
                {showImport ? 'Cancel' : 'Import CSV'}
              </button>
            </div>
            {showImport && (
              <BankImportForm
                onDone={() => {
                  setShowImport(false)
                  void qc.invalidateQueries({ queryKey: ['bank-imports'] })
                }}
              />
            )}
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-s-muted">
                <tr>
                  <th className="px-4 py-2 text-left">Source</th>
                  <th className="px-4 py-2 text-left">Account</th>
                  <th className="px-4 py-2 text-left">Date</th>
                  <th className="px-4 py-2 text-right">Lines</th>
                  <th className="px-4 py-2 text-right">Opening</th>
                  <th className="px-4 py-2 text-right">Closing</th>
                </tr>
              </thead>
              <tbody>
                {(imports ?? []).map((i) => (
                  <Fragment key={i.id}>
                    <tr className="border-t border-s-border hover:bg-s-bg-soft/40 cursor-pointer" onClick={() => setOpenImport(openImport === i.id ? null : i.id)}>
                      <td className="px-4 py-2 text-s-text">{i.source}</td>
                      <td className="px-4 py-2 font-mono text-xs text-s-muted">{i.accountCode}</td>
                      <td className="px-4 py-2 text-xs text-s-text">{i.statementDate.slice(0, 10)}</td>
                      <td className="px-4 py-2 text-right text-xs text-s-text">{i._count.lines} {openImport === i.id ? '▴' : '▾'}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(i.openingBalanceCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(i.closingBalanceCents)}</td>
                    </tr>
                    {openImport === i.id && (
                      <tr><td colSpan={6} className="p-0">
                        <StatementLines importId={i.id} raastAccount={!!i.bankAccountId && raastAccountIds.has(i.bankAccountId)} onOpenRaast={() => setTab('raast')} />
                      </td></tr>
                    )}
                  </Fragment>
                ))}
                {(!imports || imports.length === 0) && (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-xs text-s-muted">No imports yet</td></tr>
                )}
              </tbody>
            </table>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
