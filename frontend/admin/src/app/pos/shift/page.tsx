'use client'
import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { posApi, type ZReport } from '../../../lib/api'
import { usePosStore } from '../../../store/pos'
import { useAuthStore } from '../../../store/auth'
import { useCurrentShift } from '../../../hooks/useCurrentShift'
import { fmtPkr, fmtPkrWhole } from '../../../lib/money'
import { useConfirm } from '../../../components/ui/ConfirmDialog'
import { NumberField } from '../../../components/ui/NumberField'
import { VendorPayoutPanel, CodPayInPanel } from './DrawerPanels'
import { OpenTicketsCloseConfirm } from '../../../components/pos/OpenTicketsCloseConfirm'
import {
  cancelledCardStillOwed, closeDrawer, fetchCancelledCardRefundOffer, fetchDrawerOpenTickets, isOpenTicketsError, tillErrorMessage,
  zReportLines, type DrawerOpenTickets, type TerminalChargeView, type ZReportExtras, type ZTone,
} from '../../../components/pos/tillApi'
import { useIsManager } from '../../../components/pos/managerRole'
import { parsePkrToCents } from '../../../components/pos/handBack'
import { orderRef } from '../../../lib/orderRef'
import { refundErrorMessage, refundOnCardMachine, terminalRefundFinal, terminalRefundText } from '../../refunds/refundEngine'

type ClosedZReport = ZReport & ZReportExtras

/** The close was refused (409 OPEN_TICKETS): the tickets holding it. */
interface CloseBlock {
  message: string
  openTickets: DrawerOpenTickets | null
  loading: boolean
}

export default function ShiftPage() {
  const { shiftId, setShiftId } = usePosStore()
  const user = useAuthStore((s) => s.user)
  const [openingFloat, setOpeningFloat] = useState('')
  const [closingFloat, setClosingFloat] = useState('')
  const [zReport, setZReport] = useState<ClosedZReport | null>(null)
  const [closeBlock, setCloseBlock] = useState<CloseBlock | null>(null)
  const confirm = useConfirm()

  // The server says which drawer this user is on (hooks/useCurrentShift).
  const current = useCurrentShift()

  const openMutation = useMutation({
    mutationFn: () => posApi.openShift(Math.round(parseFloat(openingFloat || '0') * 100)),
    onSuccess: (shift) => { setShiftId(shift.id); void current.refetch() },
  })

  // TILL-R1: the close names the unpaid tickets still on the drawer (409
  // OPEN_TICKETS) instead of failing silently; "Close anyway" resends with
  // confirmOpenTickets.
  const closeMutation = useMutation({
    mutationFn: (confirmOpenTickets: boolean) =>
      closeDrawer<ClosedZReport>(shiftId!, Math.round(parseFloat(closingFloat || '0') * 100), { confirmOpenTickets }),
    onSuccess: (report) => {
      setCloseBlock(null)
      setZReport(report)
      // A sign-in lasts one shift (owner B1, 2026-10-26): closing your drawer signs you out shortly.
      toast.info('Shift closed. You will be signed out in 5 minutes — print the Z-report now.', { id: 'shift-closed-signout', duration: 15_000 })
      setShiftId(null)
      void current.refetch()
    },
    onError: (e) => {
      if (isOpenTicketsError(e) && shiftId) {
        const id = shiftId
        setCloseBlock({ message: (e as Error).message, openTickets: null, loading: true })
        fetchDrawerOpenTickets(id)
          .then((openTickets) => setCloseBlock((b) => b && { ...b, openTickets, loading: false }))
          .catch(() => setCloseBlock((b) => b && { ...b, loading: false }))
        return
      }
      // Closed elsewhere already (SHIFT_CLOSED): drop the stale id and pick
      // up the truth. Any other error is shown under the button.
      void current.refetch()
    },
  })
  // Close Shift asks first: a mistyped count (an extra zero) cannot be taken back.
  async function askClose() {
    if (closeBlock || closeMutation.isPending || !closingFloat) return
    const counted = Math.round(parseFloat(closingFloat || '0') * 100)
    const ok = await confirm({
      title: `Close drawer with ${fmtPkr(counted)} counted?`,
      body: 'This closes the shift and prints the Z-report. The count cannot be changed afterwards.',
      confirmLabel: 'Close shift',
      cancelLabel: 'Recount',
      danger: true,
    })
    if (ok) closeMutation.mutate(false)
  }
  const openedAt = current.data?.shift?.openedAt
  const openedLabel = openedAt
    ? new Date(openedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Karachi' })
    : null
  const closeError = closeMutation.isError && !isOpenTicketsError(closeMutation.error)
    ? tillErrorMessage(closeMutation.error, 'Could not close the shift — try again')
    : null

  if (zReport) {
    return <ZReportView report={zReport} onClose={() => setZReport(null)} />
  }

  return (
    <div className="erp-kitchen-dark flex min-h-screen min-h-dvh flex-col items-center justify-center bg-kds-bg p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-black text-kds-text">Shift Management</h1>
          {user && <p className="text-kds-subtext">{user.name}</p>}
        </div>

        {!shiftId ? (
          /* Open shift */
          <form className="rounded-2xl bg-kds-card p-6 space-y-4"
            onSubmit={(e) => { e.preventDefault(); if (!openMutation.isPending) openMutation.mutate() }}>
            <h2 className="font-bold text-kds-text">Open New Shift</h2>
            <div>
              <label htmlFor="shift-open-float" className="mb-1 block text-sm text-kds-subtext">Opening Cash Float (PKR)</label>
              <NumberField
                id="shift-open-float"
                decimals={2}
                min={0}
                value={openingFloat === '' ? null : Number(openingFloat)}
                onValueChange={(v) => setOpeningFloat(v == null ? '' : String(v))}
                placeholder="0"
                className="w-full rounded-lg border border-kds-border bg-kds-bg px-4 py-3 text-xl font-bold text-kds-text"
              />
            </div>
            <button
              type="submit"
              disabled={openMutation.isPending}
              className="w-full rounded-xl bg-kds-green py-4 font-bold text-primary-on disabled:opacity-50"
            >
              {openMutation.isPending ? 'Opening…' : 'Open Shift'}
            </button>
            {openMutation.isError && (
              <p className="text-sm text-kds-red" role="alert">{tillErrorMessage(openMutation.error, 'Failed to open shift')}</p>
            )}
          </form>
        ) : (
          /* Close shift */
          <div className="rounded-2xl bg-kds-card p-6 space-y-4">
            <div className="rounded-lg bg-kds-green/20 border border-kds-green px-4 py-3">
              <p className="text-sm font-semibold text-kds-green">Shift Active</p>
              <p className="text-xs text-kds-subtext">{openedLabel ? `Opened ${openedLabel}` : 'Drawer open'}</p>
            </div>
            {/* Owner decision 2: the cashier counts BLIND. Nothing on this
                screen (or anything a cashier can open) shows the expected
                cash before the count is submitted — the Z-report with the
                expected figure and the variance appears only after close. */}
            <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void askClose() }}>
            <div>
              <label htmlFor="shift-close-count" className="mb-1 block text-sm text-kds-subtext">Closing Cash Count (PKR)</label>
              <p className="mb-2 text-xs text-kds-subtext">
                Count every note and coin in the drawer and enter the total. The expected amount is shown after you close.
              </p>
              <NumberField
                id="shift-close-count"
                decimals={2}
                min={0}
                value={closingFloat === '' ? null : Number(closingFloat)}
                onValueChange={(v) => setClosingFloat(v == null ? '' : String(v))}
                placeholder="0"
                className="w-full rounded-lg border border-kds-border bg-kds-bg px-4 py-3 text-xl font-bold text-kds-text"
              />
            </div>
            {!closeBlock && (
              <button
                type="submit"
                disabled={closeMutation.isPending || !closingFloat}
                className="w-full rounded-xl bg-kds-red py-4 font-bold text-white disabled:opacity-50"
              >
                {closeMutation.isPending ? 'Closing…' : 'Close Shift & Print Z-Report'}
              </button>
            )}
            </form>
            {closeBlock ? (
              <OpenTicketsCloseConfirm
                tone="till"
                openTickets={closeBlock.openTickets}
                message={closeBlock.message}
                loading={closeBlock.loading}
                confirming={closeMutation.isPending}
                error={closeError}
                onBack={() => { setCloseBlock(null); closeMutation.reset() }}
                onConfirm={() => closeMutation.mutate(true)}
              />
            ) : (
              closeError && <p className="text-sm text-kds-red" role="alert">{closeError}</p>
            )}
          </div>
        )}

        {shiftId && <CodPayInPanel shiftId={shiftId} />}
        {shiftId && <VendorPayoutPanel shiftId={shiftId} />}

        <div className="text-center">
          <a href="/pos" className="inline-flex min-h-11 items-center gap-1.5 text-kds-green underline text-sm"><ArrowLeft size={16} aria-hidden="true" /> Back to POS</a>
        </div>
      </div>
    </div>
  )
}

function ZReportView({ report, onClose }: { report: ClosedZReport; onClose: () => void }) {
  // R2-UI-05: takings, money taken on cancelled tickets, refunds, net sales
  // and a signed short/over variance — the rows come from zReportLines so the
  // screen reconciles the way /reconciliation and the shift email do.
  const lines = zReportLines(report, fmtPkrWhole)
  const toneClass: Record<ZTone, string> = {
    text: 'text-kds-text', subtext: 'text-kds-subtext', green: 'text-kds-green', amber: 'text-kds-amber', red: 'text-kds-red',
  }
  const open = report.openTickets
  const refundDue = report.refundDueCents ?? 0

  return (
    <div className="erp-kitchen-dark flex min-h-screen min-h-dvh flex-col items-center justify-center bg-kds-bg p-6">
      <div className="w-full max-w-md rounded-2xl bg-kds-card p-6 space-y-4">
        <div className="text-center">
          <h1 className="text-2xl font-black text-kds-text">Z-Report</h1>
          <p className="text-xs text-kds-subtext">{report.staffName} · {new Date(report.openedAt).toLocaleString()}</p>
        </div>

        <div className="divide-y divide-kds-border">
          {lines.map((l) => (
            <div key={l.label} className="flex justify-between gap-3 py-2">
              <span className="text-kds-subtext">{l.label}</span>
              <span className={`font-bold ${toneClass[l.tone]}`}>{l.value}</span>
            </div>
          ))}
        </div>

        {(report.onAccountSales ?? 0) > 0 && (
          <p className="rounded-lg border border-kds-border px-4 py-3 text-xs text-kds-subtext">
            On account ({fmtPkrWhole(report.onAccountSales ?? 0)}): billed to each client&rsquo;s account, listed by client above.
            It is in the takings but not in the drawer — the client pays it on their statement.
          </p>
        )}

        {refundDue > 0 && (
          <div className="rounded-lg border border-kds-amber bg-kds-amber/10 px-4 py-3 text-sm">
            <p className="font-bold text-kds-amber">Refund due: {fmtPkrWhole(refundDue)}</p>
            <p className="text-xs text-kds-subtext">
              Taken on {report.cancelledPaid?.count ?? 0} ticket(s) that were then cancelled. Owed back to the customer, not a sale.
            </p>
            {cancelledCardStillOwed(report.cancelledPaid) && (
              <CancelledCardRefunds orderIds={report.cancelledPaid?.orderIds ?? null} shiftId={report.shiftId ?? null} />
            )}
          </div>
        )}

        {open && open.count > 0 && (
          <div className="rounded-lg border border-kds-red px-4 py-3 text-sm">
            <p className="font-bold text-kds-red">
              {open.count} unpaid ticket{open.count === 1 ? '' : 's'} left open · {fmtPkrWhole(open.dueCents)} due
            </p>
            <ul className="mt-2 space-y-1">
              {open.tickets.map((t) => (
                <li key={t.id} className="flex justify-between text-xs text-kds-subtext">
                  <span>{t.table ? `Table ${t.table}` : 'Counter'} · #{t.ref}</span>
                  <span className="font-semibold text-kds-text">{fmtPkrWhole(t.dueCents)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <button
          onClick={onClose}
          className="w-full rounded-xl bg-kds-green py-4 font-bold text-primary-on"
        >
          Done
        </button>
      </div>
    </div>
  )
}

// ─── Refund to card on the cancelled tickets (LEDGER-R5 hand-back) ─────────
//
// Card money taken on a ticket that was then cancelled goes back to the card
// on the card machine — managers only (POST /pos/terminal/refunds), up to
// what the ticket still owes back by card. The server checks it before the
// machine moves money, books it as the hand-back (never a sale refund) and
// sends nothing to the fiscal POS. Cash is handed back from the ticket's page.

function CancelledCardRefunds({ orderIds, shiftId }: { orderIds: string[] | null; shiftId: string | null }) {
  const isManager = useIsManager()
  if (!orderIds) {
    // An older API without the ticket list: no per-ticket button to point at.
    return (
      <p className="mt-2 text-xs text-kds-subtext">
        Card money goes back to the card: a manager refunds it on the card machine, then records it on the ticket as a card hand-back.
      </p>
    )
  }
  if (!isManager) {
    return (
      <p className="mt-2 text-xs text-kds-subtext">
        Card money goes back on the card machine — ask a manager to refund it to the card.
      </p>
    )
  }
  return (
    <ul className="mt-3 space-y-2">
      {orderIds.map((id) => <CancelledCardRefundRow key={id} orderId={id} shiftId={shiftId} />)}
    </ul>
  )
}

function CancelledCardRefundRow({ orderId, shiftId }: { orderId: string; shiftId: string | null }) {
  const offer = useQuery({
    queryKey: ['pos', 'cancelled-card-refund', orderId, shiftId],
    queryFn: () => fetchCancelledCardRefundOffer(orderId, shiftId),
    retry: false,
  })
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [progress, setProgress] = useState<TerminalChargeView | null>(null)

  const refund = useMutation({
    mutationFn: (input: { paymentId: string; amountCents: number }) => refundOnCardMachine(orderId, {
      payment: { id: input.paymentId, method: 'card', amountCents: input.amountCents, status: 'paid', gateway: 'card_terminal' },
      amountCents: input.amountCents,
      reason: reason.trim(),
      shiftId,
    }, setProgress),
    onSettled: () => { void offer.refetch() },
  })

  const data = offer.data ?? null
  // Nothing to offer (cash only, no card machine here, or all of it already back): no row.
  if (offer.isLoading) return null
  if (!data && !progress) return null

  const amountCents = parsePkrToCents(amount)
  const amountOk = !!data && Number.isSafeInteger(amountCents) && amountCents > 0 && amountCents <= data.maxCents
  const reasonOk = reason.trim().length >= 3
  const state = progress ? terminalRefundText(progress) : null

  return (
    <li className="rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-kds-text">
          #{orderRef(orderId)}
          {data && <span className="text-kds-subtext"> · up to {fmtPkrWhole(data.maxCents)} by card</span>}
        </span>
        {data && !open && (
          <button
            type="button"
            onClick={() => { setOpen(true); setAmount((data.maxCents / 100).toFixed(2)); setProgress(null); refund.reset() }}
            className="min-h-11 rounded-lg bg-kds-amber px-3 py-1.5 font-bold text-kds-bg"
          >
            Refund to card
          </button>
        )}
      </div>
      {open && data && (
        <div className="mt-2 space-y-2">
          <label className="block text-kds-subtext">
            Amount (PKR)
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              className="min-h-11 mt-1 w-full rounded-lg border border-kds-border bg-kds-card px-3 py-2 font-bold text-kds-text"
            />
          </label>
          <label className="block text-kds-subtext">
            Reason
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
              placeholder="Why the ticket was cancelled"
              className="min-h-11 mt-1 w-full rounded-lg border border-kds-border bg-kds-card px-3 py-2 text-kds-text"
            />
          </label>
          {!amountOk && amount !== '' && (
            <p className="text-kds-red">Enter an amount up to {fmtPkrWhole(data.maxCents)}.</p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setOpen(false); refund.reset() }}
              disabled={refund.isPending}
              className="min-h-11 flex-1 rounded-lg border border-kds-border py-2 font-bold text-kds-text disabled:opacity-50"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => refund.mutate({ paymentId: data.paymentId, amountCents })}
              disabled={!amountOk || !reasonOk || refund.isPending}
              className="min-h-11 flex-1 rounded-lg bg-kds-green py-2 font-bold text-primary-on disabled:opacity-50"
            >
              {refund.isPending ? 'On the card machine…' : 'Refund to card'}
            </button>
          </div>
        </div>
      )}
      {state && (
        <p className={`mt-2 ${state.ok ? 'text-kds-green' : 'text-kds-red'}`} role="status">
          {state.text}
          {progress && terminalRefundFinal(progress) && progress.status === 'recorded' && ' Nothing goes to the fiscal POS — the ticket was never a sale.'}
        </p>
      )}
      {refund.isError && <p className="mt-2 text-kds-red" role="alert">{refundErrorMessage(refund.error)}</p>}
    </li>
  )
}
