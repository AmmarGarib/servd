'use client'
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { posApi, type ZReport } from '../../../lib/api'
import { usePosStore } from '../../../store/pos'
import { useAuthStore } from '../../../store/auth'
import { useCurrentShift } from '../../../hooks/useCurrentShift'

function fmt(cents: number) { return `PKR ${(cents / 100).toFixed(0)}` }

export default function ShiftPage() {
  const { shiftId, setShiftId } = usePosStore()
  const user = useAuthStore((s) => s.user)
  const [openingFloat, setOpeningFloat] = useState('')
  const [closingFloat, setClosingFloat] = useState('')
  const [zReport, setZReport] = useState<ZReport | null>(null)

  // The server says which drawer this user is on (hooks/useCurrentShift).
  const current = useCurrentShift()

  const openMutation = useMutation({
    mutationFn: () => posApi.openShift(Math.round(parseFloat(openingFloat || '0') * 100)),
    onSuccess: (shift) => { setShiftId(shift.id); void current.refetch() },
  })

  const closeMutation = useMutation({
    mutationFn: () => posApi.closeShift(shiftId!, Math.round(parseFloat(closingFloat || '0') * 100)),
    onSuccess: (report) => {
      setZReport(report)
      setShiftId(null)
      void current.refetch()
    },
    // Closed elsewhere already: drop the stale id and pick up the truth.
    onError: () => { void current.refetch() },
  })

  if (zReport) {
    return <ZReportView report={zReport} onClose={() => setZReport(null)} />
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-kds-bg p-6">
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
            <div>
              <label className="mb-1 block text-sm text-kds-subtext">Closing Cash Count (PKR)</label>
              <input
                type="number"
                value={closingFloat}
                onChange={(e) => setClosingFloat(e.target.value)}
                placeholder="0"
                className="w-full rounded-lg border border-kds-border bg-kds-bg px-4 py-3 text-xl font-bold text-kds-text"
              />
            </div>
            <button
              onClick={() => closeMutation.mutate()}
              disabled={closeMutation.isPending || !closingFloat}
              className="w-full rounded-xl bg-kds-red py-4 font-bold text-white disabled:opacity-50"
            >
              {closeMutation.isPending ? 'Closing…' : 'Close Shift & Print Z-Report'}
            </button>
          </div>
        )}

        <div className="text-center">
          <a href="/pos" className="text-kds-green underline text-sm">← Back to POS</a>
        </div>
      </div>
    </div>
  )
}

function ZReportView({ report, onClose }: { report: ZReport; onClose: () => void }) {
  const rows: Array<[string, string, string?]> = [
    ['Cash Sales', fmt(report.cashSales), 'text-kds-text'],
    ['Card Sales', fmt(report.cardSales), 'text-kds-text'],
    ['Wallet Sales', fmt(report.walletSales), 'text-kds-text'],
    ['Discounts', fmt(report.totalDiscounts), 'text-kds-amber'],
    ['Tax (GST)', fmt(report.totalTax), 'text-kds-subtext'],
    ['Total Sales', fmt(report.totalSales), 'text-kds-green'],
    ['Orders', String(report.totalOrders)],
    ['Expected Cash', fmt(report.expectedCashInDrawer)],
    ['Actual Cash', fmt(report.actualCashInDrawer ?? 0)],
    ['Variance', fmt(Math.abs(report.cashVariance ?? 0)),
      (report.cashVariance ?? 0) === 0 ? 'text-kds-green' : 'text-kds-red'],
  ]

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-kds-bg p-6">
      <div className="w-full max-w-md rounded-2xl bg-kds-card p-6 space-y-4">
        <div className="text-center">
          <h1 className="text-2xl font-black text-kds-text">Z-Report</h1>
          <p className="text-xs text-kds-subtext">{report.staffName} · {new Date(report.openedAt).toLocaleString()}</p>
        </div>

        <div className="divide-y divide-kds-border">
          {rows.map(([label, value, colorClass]) => (
            <div key={label} className="flex justify-between py-2">
              <span className="text-kds-subtext">{label}</span>
              <span className={`font-bold ${colorClass ?? 'text-kds-text'}`}>{value}</span>
            </div>
          ))}
        </div>

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
