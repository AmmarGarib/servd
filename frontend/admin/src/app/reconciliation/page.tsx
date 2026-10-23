'use client'
import { Button, CheckLabel, FieldLabel, Input, LinkButton, Textarea } from '@/components/finance/ui'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { api, posApi, ApiError, type ZReport } from '../../lib/api'
import { fmtPkr, todayPktIso } from '../../lib/money'
import { orderRef } from '../../lib/orderRef'
import { format } from 'date-fns'
import { BackfillUnposted } from './BackfillUnposted'
import { RaastTab } from './RaastTab'
import { CodTab } from './CodTab'
import { CardPayouts, CardPayoutChip, CardPayoutSuggest, cardPayoutErrorText, useCardPayoutBanks, type CardSettlementChip } from './CardPayouts'
import { OpenTicketsCloseConfirm } from '../../components/pos/OpenTicketsCloseConfirm'
import { closeDrawer, isOpenTicketsError, type ZReportExtras } from '../../components/pos/tillApi'
import { useAuthStore } from '../../store/auth'
import { usePermissions } from '../../hooks/useCan'
import { Select } from '@/components/ui/Select'
import { Modal } from '../../components/ui/Modal'
import { MoneyInput } from '../../components/ui/MoneyInput'
import { NumberField } from '../../components/ui/NumberField'
import { useConfirm } from '../../components/ui/ConfirmDialog'
import { DialogForm, RupeeField } from '../../components/finance/PaymentReceivedFields'
import { dateBounds } from '../finance/cash-vouchers/ui'

// Who may do what on this page — the API decides; these only hide buttons the
// API would refuse (wave 3: finance reads and works reconciliation, but a
// red 403 behind a button it was shown is the bug we are removing).
//   Closing a drawer is the till's close (POST /pos/shifts/:id/close, CASHIERS).
//   Booking an adjustment, matching a line by hand and undoing a match: the
//   CEO, co-owners and finance holding the accounting module (owner,
//   2026-10-16: finance does the full bank reconciliation). Ignore needs a
//   reason; an ignored line can be brought back.
const DRAWER_CLOSERS = ['admin', 'owner', 'manager', 'management', 'foh_management', 'boh_management', 'fnb_manager', 'cashier', 'foh']
const BANK_BOOKERS = ['admin', 'owner']

/** The API's BANK_BOOKERS: the CEO, co-owners, and finance with the accounting module. */
function useCanBookBank(): boolean {
  const isBooker = useAuthStore((s) => s.isRole(...BANK_BOOKERS))
  const isFinance = useAuthStore((s) => s.isRole('finance'))
  const { data: perms } = usePermissions()
  return isBooker || (isFinance && (perms?.modules ?? []).includes('accounting'))
}

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
  /** The card payout (H12) this line settles — undone on the Card payouts tab, never by Unmatch. */
  cardSettlement?: CardSettlementChip | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ReconTab = 'shifts' | 'bank' | 'cards' | 'raast' | 'cod'
const TABS: readonly ReconTab[] = ['shifts', 'bank', 'cards', 'raast', 'cod']
// The COD tab shows only while GET /reconciliation/cod/enabled is true (OFF by default).

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
      balanced ? 'bg-success/10 text-success' : 'bg-s-red-dim text-s-red'
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
  // The counted cash: null = not entered yet (0 is a real count).
  const [closingFloat, setClosingFloat] = useState<number | null>(null)
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
      closeDrawer<ZReport>(shiftId, Math.round((closingFloat ?? 0) * 100), { notes: notes || undefined, confirmOpenTickets }),
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

  const inp = 's-input w-full'

  return (
    <Modal title="Shift Reconciliation" onClose={onClose} wide dirty={closingFloat !== null && !complete.isSuccess && !complete.isPending}>
      <div>
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
                          <span className="block text-xs font-normal text-s-muted">tolerance ±{fmtPkr(data.varianceLimitCents)}</span>
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
                <DialogForm busy={complete.isPending} onSubmit={() => complete.mutate(false)} missing={closingFloat == null ? 'Enter the cash counted in the drawer (0 if it is empty).' : null}>
                <div>
                  <FieldLabel htmlFor="sh-closing" className="block mb-1">Closing float (PKR)</FieldLabel>
                  <NumberField
                    id="sh-closing"
                    decimals={2}
                    min={0}
                    value={closingFloat}
                    onValueChange={setClosingFloat}
                    placeholder="e.g. 5000"
                    className={inp}
                  />
                  {closingFloat != null && closingFloat >= 100000 && <p className="text-xs text-s-muted mt-1" aria-live="polite">{fmtPkr(Math.round(closingFloat * 100))}</p>}
                </div>
                <div className="mt-3">
                  <FieldLabel htmlFor="sh-notes" className="block mb-1">Notes (optional)</FieldLabel>
                  <Input
                    id="sh-notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Any discrepancy explanations…"
                    className={`${inp} w-auto px-1.5 py-0.5`}
                  />
                </div>
                {!openTicketsBlock && closeError && (
                  <p role="alert" className="text-sm text-s-red mt-3">{closeError}</p>
                )}
                {!openTicketsBlock && (
                  <Button
                    type="submit"
                    disabled={complete.isPending}
                    className="w-full mt-3">
                    {complete.isPending ? 'Closing…' : 'Close shift'}
                  </Button>
                )}
                </DialogForm>
                {openTicketsBlock && (
                  <OpenTicketsCloseConfirm
                    tone="admin"
                    openTickets={data.openTickets ?? null}
                    message={openTicketsBlock}
                    confirming={complete.isPending}
                    error={closeError}
                    onBack={() => { setOpenTicketsBlock(null); complete.reset() }}
                    onConfirm={() => complete.mutate(true)}
                  />
                )}
              </div>
            )}
            {complete.data && (
              <div className={`rounded-lg p-3 text-sm ${complete.data.isBalanced ? 'bg-success/10 text-success' : 'bg-s-red-dim text-s-red'}`}>
                {complete.data.isBalanced
                  ? 'Balanced — shift closed and posted.'
                  : `Variance of ${fmtPkr(Math.abs(complete.data.varianceCents ?? 0))} flagged for review. Shift closed and posted.`}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
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
  // MoneyInput holds paisa (a negative balance is allowed); it is sent as typed.
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
      // Whole paisa (MoneyInput already rounds: 100.10 * 100 is 10009.999…, which the API refuses).
      openingBalanceCents: opening, closingBalanceCents: closing,
      csv,
      filename: `${label}-${statementDate}.csv`,
      fileUrl: `data:text/csv;base64,${btoa(csv)}`,
    }),
    onSuccess: onDone,
    onError: (e: { message?: string }) => setErr(e.message ?? 'Import failed'),
  })

  // Rows in the pasted CSV: non-empty lines, less a header line when there is one.
  const csvLines = csv.split(/\r?\n/).filter((l) => l.trim())
  const hasHeader = csvLines.length > 0 && /date/i.test(csvLines[0]!) && /amount/i.test(csvLines[0]!)
  const parsedRows = Math.max(0, csvLines.length - (hasHeader ? 1 : 0))
  const bounds = dateBounds()
  const fieldCls = 's-input w-full'
  const labelCls = 'block mb-1'
  const missing = !picked ? 'Pick the bank account the statement is for.'
    : !statementDate || statementDate < bounds.min || statementDate > bounds.max ? `Pick a statement date between ${bounds.min} and ${bounds.max}.`
    : parsedRows === 0 ? 'Paste the statement CSV (date, description, amount, reference).'
    : null

  return (
    <div className="p-4 border-b border-s-border text-sm">
      <DialogForm busy={submit.isPending} onSubmit={() => { setErr(null); submit.mutate() }} missing={missing}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <FieldLabel htmlFor="bi-bank" className={labelCls}>Statement is for</FieldLabel>
          <Select id="bi-bank" value={picked} onChange={(e) => setTarget(e.target.value)} className={fieldCls}>
            {banks.map((b) => <option key={b.id} value={b.id}>{b.name}{b.accountCode ? ` (${b.accountCode})` : ''}</option>)}
            <option value={GATEWAY}>Card / gateway settlement (1030)</option>
          </Select>
        </div>
        <div>
          <FieldLabel htmlFor="bi-date" className={labelCls}>Statement date</FieldLabel>
          <Input id="bi-date" type="date" min={bounds.min} max={bounds.max} value={statementDate} onChange={(e) => setStatementDate(e.target.value)} className={fieldCls}
            aria-invalid={!statementDate || statementDate < bounds.min || statementDate > bounds.max ? true : undefined} />
        </div>
        <div>
          <FieldLabel htmlFor="bi-opening" className={labelCls}>Opening balance (PKR)</FieldLabel>
          <MoneyInput id="bi-opening" allowNegative value={opening} onChange={setOpening} placeholder="0 — a minus sign is fine for an overdrawn account" className={fieldCls} />
        </div>
        <div>
          <FieldLabel htmlFor="bi-closing" className={labelCls}>Closing balance (PKR)</FieldLabel>
          <MoneyInput id="bi-closing" allowNegative value={closing} onChange={setClosing} placeholder="0" className={fieldCls} />
        </div>
      </div>
      {banks.length === 0 && <p className="text-xs text-s-muted mt-2">No bank accounts yet — add one in Configuration → Bank accounts.</p>}
      <div className="mt-2">
        <FieldLabel htmlFor="bi-csv" className={labelCls}>Statement CSV</FieldLabel>
        <Textarea id="bi-csv" value={csv} onChange={(e) => setCsv(e.target.value)} rows={6} placeholder="Paste CSV (date,description,amount,reference)"
          className="w-full font-mono" />
        <p className="text-xs text-s-muted mt-1" aria-live="polite">
          {parsedRows === 0 ? 'No rows yet.' : `${parsedRows} row${parsedRows === 1 ? '' : 's'} parsed${hasHeader ? ' (header line skipped)' : ''}.`}
        </p>
      </div>
      {err && <p role="alert" className="text-s-red text-xs mt-2">{err}</p>}
      <Button size="sm" type="submit" disabled={submit.isPending} className="mt-2">
        {submit.isPending ? 'Importing…' : 'Import'}
      </Button>
      </DialogForm>
    </div>
  )
}

// ─── Statement lines — clear what didn't auto-match ───────────────────────────
// "Book adjustment" posts the line against one account for the whole amount,
// or SPLIT across several (BOOKS-11): a Keenu settlement that lands net of its
// MDR books Dr bank (the line) + Dr 6080 fee / Cr 1030 gross, so the card
// receivable clears in full. The split must balance against the line; the
// API refuses it otherwise. Booking is for the CEO, co-owners and finance
// with the accounting module.

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
  const inp = 's-input'

  return (
    <DialogForm busy={adjust.isPending} onSubmit={() => adjust.mutate()}
      missing={!memo.trim() ? 'Add a memo — what this is.' : split ? (splitReady ? null : 'Every line needs a code and an amount, and the lines must balance.') : (!contra.trim() ? 'Enter the account code to book it to.' : null)}>
    <div className="px-4 py-3 space-y-2 text-xs">
      {inflow && raastAccount && (
        <p role="alert" className="rounded-lg border border-s-amber/40 bg-s-amber-dim px-3 py-2 text-s-text">
          This account receives Raast QR payments. If this credit is a customer&rsquo;s Raast payment for a bill, match it on the Raast tab instead —
          the sale already booked it to this bank account, so an adjustment would book it twice.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <CheckLabel className="inline-flex items-center gap-1"><input type="radio" name={`adjust-mode-${line.id}`} checked={!split} onChange={() => setSplit(false)} /> One account</CheckLabel>
        <CheckLabel className="inline-flex items-center gap-1"><input type="radio" name={`adjust-mode-${line.id}`} checked={split} onChange={() => setSplit(true)} /> Split (e.g. card settlement less fee)</CheckLabel>
      </div>
      {!split ? (
        <div className="flex flex-wrap gap-2">
          <Input value={contra} onChange={(e) => setContra(e.target.value)} aria-label="Account code" placeholder="account code (6080)" className={`${inp} w-36`} />
        </div>
      ) : (
        <div className="space-y-1.5">
          <p className="text-s-muted">
            This line: <span className="font-mono">{bankSide === 'debit' ? 'Dr' : 'Cr'} {fmtPkr(abs)}</span> to the statement&rsquo;s account. Other side:
          </p>
          {rows.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input value={r.code} onChange={(e) => setRow(i, { code: e.target.value })} aria-label={`Line ${i + 1} account code`} placeholder="code" className={`${inp} w-20 font-mono`} />
              <Select value={r.type} onChange={(e) => setRow(i, { type: e.target.value as 'debit' | 'credit' })} className={`${inp} w-auto px-1.5 py-0.5`}>
                <option value="debit">Dr</option>
                <option value="credit">Cr</option>
              </Select>
              <span className="w-28"><RupeeField label={`Line ${i + 1} amount (PKR)`} value={r.amount} onChange={(v) => setRow(i, { amount: v })} className={`${inp} w-full text-right`} /></span>
              {rows.length > 1 && <LinkButton tone="muted" size="md" type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>Remove</LinkButton>}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <LinkButton size="md" type="button" onClick={() => setRows((rs) => [...rs, { code: '', type: otherSide, amount: '' }])}>+ Add line</LinkButton>
            <span className={off === 0 ? 'text-success' : 'text-s-red'}>
              {off === 0 ? 'Balanced' : `Off by ${fmtPkr(Math.abs(off))} (${off > 0 ? 'more debits' : 'more credits'})`}
            </span>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input value={memo} onChange={(e) => setMemo(e.target.value)} aria-label="Memo" placeholder="memo (what this is)" className={`${inp} flex-1 min-w-[10rem]`} />
        <LinkButton size="md"
          type="submit"
          disabled={adjust.isPending}>
          {adjust.isPending ? 'Booking…' : 'Book'}
        </LinkButton>
        <LinkButton tone="muted" size="md" type="button" onClick={onCancel}>Cancel</LinkButton>
      </div>
      {adjust.error && (
        <p role="alert" className="text-s-red">
          {adjust.error instanceof ApiError && adjust.error.code === 'USE_CARD_PAYOUT_CONFIRM'
            ? cardPayoutErrorText(adjust.error)
            : (adjust.error as Error).message}
        </p>
      )}
    </div>
    </DialogForm>
  )
}

// Ignore needs a reason (≥ 10 characters, audited); it can be undone with "Bring back".
function IgnoreForm({ busy, onCancel, onSubmit }: { busy: boolean; onCancel: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  const ok = reason.trim().length >= 10
  return (
    <div className="px-4 py-3 flex flex-wrap items-center gap-2 text-xs">
      <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} aria-label="Why ignore this line"
        placeholder="Why is this line ignored? (at least 10 characters)" className="flex-1 min-w-[14rem]" />
      <LinkButton size="md" type="button" disabled={!ok || busy} onClick={() => onSubmit(reason.trim())}>{busy ? 'Saving…' : 'Ignore line'}</LinkButton>
      <LinkButton tone="muted" size="md" type="button" onClick={onCancel}>Cancel</LinkButton>
    </div>
  )
}

interface MatchCandidate {
  journalLineId: string; entryId: string; entryDate: string; reference: string | null; description: string; memo: string | null; amountCents: number
}

// Pair the line with the journal line that already booked it (a payment that
// cleared late, outside the import's window). Never an adjustment — that
// would book the money twice. The API lists only live, free lines of the
// same amount on this statement's account.
function ManualMatch({ line, onCancel, onDone }: { line: StatementLine; onCancel: () => void; onDone: () => void }) {
  const [days, setDays] = useState(45)
  const { data: cands = [], isLoading, error } = useQuery<MatchCandidate[]>({
    queryKey: ['bank-line-candidates', line.id, days],
    queryFn: () => api.get(`/reconciliation/bank/lines/${line.id}/candidates?days=${days}`),
  })
  const match = useMutation({
    mutationFn: (journalLineId: string) => api.post(`/reconciliation/bank/lines/${line.id}/match`, { journalLineId }),
    onSuccess: onDone,
  })
  return (
    <div className="px-4 py-3 space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-s-muted">Journal lines of {fmtPkr(line.amountCents)} within</span>
        <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="bg-s-card border border-s-border rounded px-1.5 py-0.5 text-s-text">
          {[15, 45, 90, 180, 400].map((d) => <option key={d} value={d}>{d} days</option>)}
        </Select>
        <LinkButton tone="muted" size="md" type="button" onClick={onCancel}>Cancel</LinkButton>
      </div>
      {isLoading && <p className="text-s-muted">Looking…</p>}
      {error && <p role="alert" className="text-s-red">{(error as Error).message}</p>}
      {!isLoading && !error && cands.length === 0 && (
        <p className="text-s-muted">No free journal line of this amount on this account — book an adjustment if the money was never booked.</p>
      )}
      {cands.length > 0 && (
        <ul className="space-y-1">
          {cands.map((c) => (
            <li key={c.journalLineId} className="flex flex-wrap items-center gap-3">
              <span className="text-s-muted whitespace-nowrap">{c.entryDate.slice(0, 10)}</span>
              <span className="text-s-text flex-1 min-w-[12rem]">{c.description}{c.reference && <span className="text-s-muted"> · {c.reference}</span>}</span>
              <span className="font-mono">{fmtPkr(c.amountCents)}</span>
              <LinkButton size="md" type="button" disabled={match.isPending} onClick={() => match.mutate(c.journalLineId)}>Match</LinkButton>
            </li>
          ))}
        </ul>
      )}
      {match.error && <p role="alert" className="text-s-red">{(match.error as Error).message}</p>}
    </div>
  )
}

function StatementLines({ importId, raastAccount, payoutBank, onOpenRaast, onOpenCards }: {
  importId: string
  raastAccount: boolean
  /** This statement's bank is the one Keenu pays card sales into (card payout matching on). */
  payoutBank: boolean
  onOpenRaast: () => void
  onOpenCards: () => void
}) {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [adjusting, setAdjusting] = useState<string | null>(null)
  const [cardLine, setCardLine] = useState<string | null>(null)
  const canBook = useCanBookBank()
  const canUnmatch = canBook
  const [matching, setMatching] = useState<string | null>(null)
  const [ignoring, setIgnoring] = useState<string | null>(null)
  const { data: lines = [], isLoading } = useQuery<StatementLine[]>({
    queryKey: ['bank-lines', importId],
    queryFn: () => api.get(`/reconciliation/bank/imports/${importId}/lines`),
  })
  const refresh = () => void qc.invalidateQueries({ queryKey: ['bank-lines', importId] })
  const ignore = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post(`/reconciliation/bank/lines/${id}/ignore`, { reason }),
    onSuccess: () => { setIgnoring(null); refresh() },
  })
  const unignore = useMutation({ mutationFn: (id: string) => api.post(`/reconciliation/bank/lines/${id}/unignore`, {}), onSuccess: refresh })
  // S3: undo a GENERIC match (the matcher paired the line with the wrong
  // journal line). A line matched to a Raast payment is unmatched on the Raast tab.
  const unmatch = useMutation({
    mutationFn: (id: string) => api.post(`/reconciliation/bank/lines/${id}/unmatch`, {}),
    onSuccess: () => { refresh(); void qc.invalidateQueries({ queryKey: ['raast-receipts'] }) },
  })
  const lineError = ignore.error ?? unmatch.error ?? unignore.error

  if (isLoading) return <p className="px-4 py-3 text-xs text-s-muted">Loading lines…</p>
  return (
    <div className="bg-s-bg-soft/40 overflow-x-auto">
      {lineError && (
        <p className="px-4 pt-2 text-xs text-s-red">
          {lineError instanceof ApiError && lineError.code === 'RAAST_MATCHED_LINE'
            ? 'That line is matched to a Raast payment — unmatch it on the Raast tab.'
            : lineError instanceof ApiError && lineError.code === 'CARD_PAYOUT_LINE'
              ? cardPayoutErrorText(lineError)
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
                      className="ml-2 s-badge-green text-xs font-semibold">
                      Raast #{orderRef(l.raastReceipt.orderId)}
                    </button>
                  )}
                  {l.cardSettlement && <CardPayoutChip chip={l.cardSettlement} onOpen={onOpenCards} />}
                </td>
                <td className={`px-4 py-2 text-right font-mono ${l.amountCents < 0 ? 'text-s-red' : 'text-s-text'}`}>{fmtPkr(l.amountCents)}</td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  {l.matchStatus === 'matched' && l.cardSettlement ? (
                    <LinkButton tone="muted" size="md" type="button" onClick={onOpenCards}>card payout — undo on Card payouts</LinkButton>
                  ) : l.matchStatus === 'matched' && !l.raastReceipt && canUnmatch ? (
                    <span className="inline-flex gap-3">
                      <span className="text-s-muted">matched</span>
                      <LinkButton tone="muted" size="md" type="button" onClick={async () => { if (await confirm({ title: `Undo the match on ${fmtPkr(l.amountCents)}?`, body: `${l.description || 'This statement line'} goes back to unmatched and its journal line is free again.`, confirmLabel: 'Undo match', danger: true })) unmatch.mutate(l.id) }}
                        disabled={unmatch.isPending}>Unmatch</LinkButton>
                    </span>
                  ) : l.matchStatus === 'ignored' ? (
                    <span className="inline-flex gap-3">
                      <span className="text-s-muted" title={l.notes ?? undefined}>ignored</span>
                      <LinkButton tone="muted" size="md" type="button" onClick={() => unignore.mutate(l.id)} disabled={unignore.isPending}>Bring back</LinkButton>
                    </span>
                  ) : l.matchStatus !== 'unmatched' ? (
                    <span className="text-s-muted">{l.matchStatus}</span>
                  ) : adjusting === l.id ? (
                    <span className="text-s-muted">booking…</span>
                  ) : cardLine === l.id ? (
                    <span className="text-s-muted">card payout…</span>
                  ) : matching === l.id ? (
                    <span className="text-s-muted">matching…</span>
                  ) : ignoring === l.id ? (
                    <span className="text-s-muted">ignoring…</span>
                  ) : (
                    <span className="inline-flex flex-wrap justify-end gap-x-3 gap-y-1">
                      {payoutBank && l.amountCents > 0 && (
                        <LinkButton size="md" type="button" onClick={() => { setAdjusting(null); setCardLine(l.id) }}>Card payout?</LinkButton>
                      )}
                      {canBook && <LinkButton size="md" type="button" onClick={() => { setCardLine(null); setAdjusting(null); setIgnoring(null); setMatching(l.id) }}>Match by hand</LinkButton>}
                      {canBook && <LinkButton size="md" type="button" onClick={() => { setCardLine(null); setMatching(null); setIgnoring(null); setAdjusting(l.id) }}>Book adjustment</LinkButton>}
                      <LinkButton tone="muted" size="md" type="button" onClick={() => { setCardLine(null); setMatching(null); setAdjusting(null); setIgnoring(l.id) }}>Ignore</LinkButton>
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
              {matching === l.id && l.matchStatus === 'unmatched' && (
                <tr className="border-t border-s-border/50">
                  <td colSpan={4} className="p-0">
                    <ManualMatch line={l} onCancel={() => setMatching(null)} onDone={() => { setMatching(null); refresh() }} />
                  </td>
                </tr>
              )}
              {ignoring === l.id && l.matchStatus === 'unmatched' && (
                <tr className="border-t border-s-border/50">
                  <td colSpan={4} className="p-0">
                    <IgnoreForm busy={ignore.isPending} onCancel={() => setIgnoring(null)} onSubmit={(reason) => ignore.mutate({ id: l.id, reason })} />
                  </td>
                </tr>
              )}
              {cardLine === l.id && l.matchStatus === 'unmatched' && (
                <tr className="border-t border-s-border/50">
                  <td colSpan={4} className="p-0">
                    <CardPayoutSuggest lineId={l.id} onCancel={() => setCardLine(null)} onDone={() => { setCardLine(null); refresh() }} />
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
  // Cash on delivery shows only while a company in view has code-only delivery on.
  const { data: codOn, isError: codOnError } = useQuery({
    queryKey: ['recon-cod-enabled'],
    queryFn: () => api.get<{ enabled: boolean }>('/reconciliation/cod/enabled'),
    retry: false,
    staleTime: 60_000,
  })
  const codEnabled = !!codOn?.enabled
  // ?tab=cod while COD is off (or the check failed) would leave a blank page.
  useEffect(() => {
    if (tab === 'cod' && ((codOn && !codOn.enabled) || codOnError)) setTab('shifts')
  }, [codOn, codOnError, tab])
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
  const payoutBankIds = useCardPayoutBanks(tab === 'bank')

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

      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-4 sm:px-6 py-4">
        <h1 className="text-xl font-bold text-s-text">Reconciliation</h1>
        <p className="text-xs text-s-muted mt-0.5">POS shift cash reconciliation, bank statements, card payouts and Raast QR payments</p>
      </header>

      <div className="px-4 py-6 sm:p-6 max-w-5xl mx-auto space-y-4">

        {tab === 'shifts' && <BackfillUnposted />}

        {/* Summary KPI strip (shifts tab) */}
        {tab === 'shifts' && summary && (
          <div className="grid grid-cols-3 gap-3">
            <div className="s-card p-4">
              <p className="text-xs text-s-muted">Shifts (30 days)</p>
              <p className="text-2xl font-bold text-s-text mt-0.5">{totalCount}</p>
            </div>
            <div className="s-card p-4">
              <p className="text-xs text-s-muted">Balanced</p>
              <p className="text-2xl font-bold text-success mt-0.5">{balancedCount}</p>
            </div>
            <div className="s-card p-4">
              <p className="text-xs text-s-muted">Variance / Pending</p>
              <p className={`text-2xl font-bold mt-0.5 ${unbalancedCount > 0 ? 'text-s-red' : 'text-s-muted'}`}>
                {unbalancedCount}
              </p>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 border-b border-s-border pb-0 overflow-x-auto">
          {([
            { key: 'shifts', label: 'POS Shifts' },
            { key: 'bank', label: 'Bank Imports' },
            { key: 'cards', label: 'Card payouts' },
            { key: 'raast', label: 'Raast' },
            ...(codEnabled ? [{ key: 'cod', label: 'Cash on delivery' }] : []),
          ] as { key: ReconTab; label: string }[]).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`shrink-0 px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
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
                        <LinkButton tone="muted" type="button"
                          onClick={(e) => { e.stopPropagation(); setSelectedShift(s.shiftId) }}>
                          {s.status === 'open' ? 'Close →' : 'View →'}
                        </LinkButton>
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
        {tab === 'cod' && codEnabled && <CodTab />}

        {/* ── Card payouts tab (H12) ── */}
        {tab === 'cards' && <CardPayouts />}

        {/* ── Bank imports tab ── */}
        {tab === 'bank' && (
          <div className="s-card overflow-hidden">
            <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border flex items-center justify-between">
              <div className="text-xs font-semibold text-s-text">Bank Statement Imports</div>
              <Button size="sm" variant="secondary" type="submit" onClick={() => setShowImport(!showImport)}>
                {showImport ? 'Cancel' : 'Import CSV'}
              </Button>
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
                        <StatementLines
                          importId={i.id}
                          raastAccount={!!i.bankAccountId && raastAccountIds.has(i.bankAccountId)}
                          payoutBank={!!i.bankAccountId && payoutBankIds.has(i.bankAccountId)}
                          onOpenRaast={() => setTab('raast')}
                          onOpenCards={() => setTab('cards')}
                        />
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
