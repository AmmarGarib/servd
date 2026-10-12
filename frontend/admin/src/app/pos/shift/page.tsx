'use client'
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { posApi, type ZReport } from '../../../lib/api'
import { usePosStore } from '../../../store/pos'
import { useAuthStore } from '../../../store/auth'
import { useCurrentShift } from '../../../hooks/useCurrentShift'
import { fmtPkrWhole } from '../../../lib/money'
import { VendorPayoutPanel, CodPayInPanel } from './DrawerPanels'
import { OpenTicketsCloseConfirm } from '../../../components/pos/OpenTicketsCloseConfirm'
import {
  closeDrawer, fetchDrawerOpenTickets, isOpenTicketsError, tillErrorMessage,
  zReportLines, type DrawerOpenTickets, type ZReportExtras, type ZTone,
} from '../../../components/pos/tillApi'

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
  const closeError = closeMutation.isError && !isOpenTicketsError(closeMutation.error)
    ? tillErrorMessage(closeMutation.error, 'Could not close the shift — try again')
    : null

  if (zReport) {
    return <ZReportView report={zReport} onClose={() => setZReport(null)} />
  }

  return (
    <div className="erp-kitchen-dark flex min-h-screen flex-col items-center justify-center bg-kds-bg p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-black text-kds-text">Shift Management</h1>
          {user && <p className="text-kds-subtext">{user.name}</p>}
        </div>

        {!shiftId ? (
          /* Open shift */
          <div className="rounded-2xl bg-kds-card p-6 space-y-4">
            <h2 className="font-bold text-kds-text">Open New Shift</h2>
            <div>
              <label className="mb-1 block text-sm text-kds-subtext">Opening Cash Float (PKR)</label>
              <input
                type="number"
                value={openingFloat}
                onChange={(e) => setOpeningFloat(e.target.value)}
                placeholder="0"
                className="w-full rounded-lg border border-kds-border bg-kds-bg px-4 py-3 text-xl font-bold text-kds-text"
              />
            </div>
            <button
              onClick={() => openMutation.mutate()}
              disabled={openMutation.isPending}
              className="w-full rounded-xl bg-kds-green py-4 font-bold text-white disabled:opacity-50"
            >
              {openMutation.isPending ? 'Opening…' : 'Open Shift'}
            </button>
            {openMutation.isError && (
              <p className="text-sm text-kds-red">Failed to open shift</p>
            )}
          </div>
        ) : (
          /* Close shift */
          <div className="rounded-2xl bg-kds-card p-6 space-y-4">
            <div className="rounded-lg bg-kds-green/20 border border-kds-green px-4 py-3">
              <p className="text-sm font-semibold text-kds-green">Shift Active</p>
              <p className="text-xs text-kds-subtext font-mono">{shiftId}</p>
            </div>
            {/* Owner decision 2: the cashier counts BLIND. Nothing on this
                screen (or anything a cashier can open) shows the expected
                cash before the count is submitted — the Z-report with the
                expected figure and the variance appears only after close. */}
            <div>
              <label className="mb-1 block text-sm text-kds-subtext">Closing Cash Count (PKR)</label>
              <p className="mb-2 text-xs text-kds-subtext">
                Count every note and coin in the drawer and enter the total. The expected amount is shown after you close.
              </p>
              <input
                type="number"
                value={closingFloat}
                onChange={(e) => setClosingFloat(e.target.value)}
                placeholder="0"
                className="w-full rounded-lg border border-kds-border bg-kds-bg px-4 py-3 text-xl font-bold text-kds-text"
              />
            </div>
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
              <>
                <button
                  onClick={() => closeMutation.mutate(false)}
                  disabled={closeMutation.isPending || !closingFloat}
                  className="w-full rounded-xl bg-kds-red py-4 font-bold text-white disabled:opacity-50"
                >
                  {closeMutation.isPending ? 'Closing…' : 'Close Shift & Print Z-Report'}
                </button>
                {closeError && <p className="text-sm text-kds-red" role="alert">{closeError}</p>}
              </>
            )}
          </div>
        )}

        {shiftId && <CodPayInPanel shiftId={shiftId} />}
        {shiftId && <VendorPayoutPanel shiftId={shiftId} />}

        <div className="text-center">
          <a href="/pos" className="text-kds-green underline text-sm">← Back to POS</a>
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
    <div className="erp-kitchen-dark flex min-h-screen flex-col items-center justify-center bg-kds-bg p-6">
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

        {refundDue > 0 && (
          <div className="rounded-lg border border-kds-amber bg-kds-amber/10 px-4 py-3 text-sm">
            <p className="font-bold text-kds-amber">Refund due: {fmtPkrWhole(refundDue)}</p>
            <p className="text-xs text-kds-subtext">
              Taken on {report.cancelledPaid?.count ?? 0} ticket(s) that were then cancelled. Owed back to the customer, not a sale.
            </p>
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
          className="w-full rounded-xl bg-kds-green py-4 font-bold text-white"
        >
          Done
        </button>
      </div>
    </div>
  )
}
