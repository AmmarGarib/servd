'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../lib/api'
import { fmtPkr, todayPktIso } from '../../lib/money'
import { format } from 'date-fns'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ShiftSummaryRow {
  shiftId: string
  cashier: string
  openedAt: string
  closedAt: string | null
  status: string
  totalSalesCents: number
  cashSalesCents: number
  expectedCashCents: number
  closingFloatCents: number | null
  varianceCents: number | null
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

interface ShiftReconciliation {
  shiftId: string
  openedAt: string
  closedAt: string | null
  status: string
  cashier: string
  expectedCashCents: number
  closingFloatCents: number | null
  varianceCents: number | null
  isBalanced: boolean
  breakdown: {
    openingFloatCents: number
    cashSalesCents: number
    cardSalesCents: number
    walletSalesCents: number
    compSalesCents: number
    totalSalesCents: number
    cashInCents: number
    cashOutCents: number
    movementCount: number
    paymentCount: number
  }
}

interface BankImport {
  id: string; source: string; accountCode: string; statementDate: string
  openingBalanceCents: number; closingBalanceCents: number
  filename: string | null
  _count: { lines: number }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ReconTab = 'shifts' | 'bank'

function VariancePill({ cents }: { cents: number | null }) {
  if (cents === null) return <span className="text-xs text-s-muted">Pending</span>
  const balanced = Math.abs(cents) <= 50000
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
      balanced ? 'bg-green-900/20 text-green-400' : 'bg-red-900/20 text-red-400'
    }`}>
      {cents === 0 ? 'Balanced' : cents > 0 ? `+${fmtPkr(cents)}` : fmtPkr(cents)}
    </span>
  )
}

// ─── Shift detail panel ────────────────────────────────────────────────────────

function ShiftDetailPanel({
  shiftId,
  onClose,
}: { shiftId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [closingFloat, setClosingFloat] = useState('')
  const [notes, setNotes] = useState('')

  const { data, isLoading } = useQuery<ShiftReconciliation>({
    queryKey: ['recon-shift', shiftId],
    queryFn: () => api.get<ShiftReconciliation>(`/reconciliation/shift/${shiftId}`),
  })

  const complete = useMutation({
    mutationFn: () => api.post<{ isBalanced: boolean; varianceCents: number | null }>(`/reconciliation/shift/${shiftId}/complete`, {
      closingFloat: Math.round(parseFloat(closingFloat) * 100),
      ...(notes ? { notes } : {}),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recon-shift', shiftId] })
      void qc.invalidateQueries({ queryKey: ['recon-summary'] })
    },
  })

  const inp = 'rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-s-teal focus:outline-none w-full'

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-s-bg border border-s-border rounded-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-s-bg border-b border-s-border px-5 py-4 flex items-center justify-between">
          <p className="font-bold text-s-text">Shift Reconciliation</p>
          <button onClick={onClose} className="text-s-muted hover:text-s-text text-xl leading-none">✕</button>
        </div>

        {isLoading && <p className="p-6 text-s-muted">Loading…</p>}

        {data && (
          <div className="p-5 space-y-5">
            {/* Summary header */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-s-text">{data.cashier}</p>
                <p className="text-xs text-s-muted">
                  {format(new Date(data.openedAt), 'dd MMM yyyy, HH:mm')}
                  {data.closedAt && ` → ${format(new Date(data.closedAt), 'HH:mm')}`}
                </p>
              </div>
              <VariancePill cents={data.varianceCents} />
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
                    { label: 'Opening float', value: data.breakdown.openingFloatCents },
                    { label: 'Cash sales', value: data.breakdown.cashSalesCents },
                    { label: 'Cash in (pay-ins)', value: data.breakdown.cashInCents },
                    { label: 'Cash out (drops)', value: -data.breakdown.cashOutCents },
                  ].map((row) => (
                    <tr key={row.label} className="border-b border-s-border last:border-0">
                      <td className="px-4 py-2.5 text-s-muted">{row.label}</td>
                      <td className={`px-4 py-2.5 text-right font-mono ${row.value < 0 ? 'text-s-red' : 'text-s-text'}`}>
                        {row.value < 0 ? `-${fmtPkr(-row.value)}` : fmtPkr(row.value)}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-s-border font-semibold">
                    <td className="px-4 py-2.5 text-s-text">Expected cash</td>
                    <td className="px-4 py-2.5 text-right font-mono text-s-teal">{fmtPkr(data.expectedCashCents)}</td>
                  </tr>
                  {data.closingFloatCents !== null && (
                    <>
                      <tr className="border-b border-s-border">
                        <td className="px-4 py-2.5 text-s-muted">Closing float (counted)</td>
                        <td className="px-4 py-2.5 text-right font-mono text-s-text">{fmtPkr(data.closingFloatCents)}</td>
                      </tr>
                      <tr>
                        <td className="px-4 py-2.5 text-s-text font-semibold">Variance</td>
                        <td className="px-4 py-2.5 text-right">
                          <VariancePill cents={data.varianceCents} />
                        </td>
                      </tr>
                    </>
                  )}
                </tbody>
              </table>
              </div>
            </div>

            {/* Other sales */}
            <div className="rounded-xl border border-s-border overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-muted uppercase tracking-wide">
                All sales ({data.breakdown.paymentCount} payments)
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {[
                    { label: 'Card', value: data.breakdown.cardSalesCents },
                    { label: 'Digital wallets', value: data.breakdown.walletSalesCents },
                    { label: 'Comps', value: data.breakdown.compSalesCents },
                    { label: 'Total', value: data.breakdown.totalSalesCents },
                  ].map((row) => (
                    <tr key={row.label} className={`border-b border-s-border last:border-0 ${row.label === 'Total' ? 'font-semibold' : ''}`}>
                      <td className="px-4 py-2.5 text-s-muted">{row.label}</td>
                      <td className={`px-4 py-2.5 text-right font-mono ${row.label === 'Total' ? 'text-s-teal' : 'text-s-text'}`}>
                        {fmtPkr(row.value)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>

            {/* Complete form — only shown for open shifts without a closing float */}
            {data.status === 'open' && data.closingFloatCents === null && (
              <div className="rounded-xl border border-s-border p-4 space-y-3">
                <p className="text-sm font-semibold text-s-text">Complete reconciliation</p>
                <p className="text-xs text-s-muted">
                  Count the cash in the drawer and enter the total below to finalise this shift.
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
                {complete.isError && (
                  <p className="text-sm text-s-red">{(complete.error as Error).message}</p>
                )}
                <button
                  onClick={() => complete.mutate()}
                  disabled={complete.isPending || !closingFloat}
                  className="w-full rounded-xl bg-s-teal text-white font-bold py-2.5 text-sm hover:opacity-90 disabled:opacity-40">
                  {complete.isPending ? 'Saving…' : 'Submit closing float'}
                </button>
                {complete.data && (
                  <div className={`rounded-lg p-3 text-sm ${complete.data.isBalanced ? 'bg-green-900/20 text-green-400' : 'bg-red-900/20 text-red-400'}`}>
                    {complete.data.isBalanced
                      ? 'Balanced — shift closed successfully.'
                      : `Variance of ${fmtPkr(Math.abs(complete.data.varianceCents ?? 0))} flagged for manager review.`}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Bank import form ──────────────────────────────────────────────────────────

function BankImportForm({ onDone }: { onDone: () => void }) {
  const [source, setSource] = useState('bank:hbl')
  const [accountCode, setAccountCode] = useState('1020')
  const [statementDate, setStatementDate] = useState(todayPktIso())
  const [opening, setOpening] = useState(0)
  const [closing, setClosing] = useState(0)
  const [csv, setCsv] = useState('')
  const [err, setErr] = useState<string | null>(null)

  // Bank import now requires filename + fileUrl — for the admin UI we accept
  // a paste-in flow and use a sentinel filename so the schema passes.
  const submit = useMutation({
    mutationFn: () => api.post('/reconciliation/bank/imports', {
      source, accountCode, statementDate,
      openingBalanceCents: opening * 100, closingBalanceCents: closing * 100,
      csv,
      filename: `${source}-${statementDate}.csv`,
      fileUrl: `data:text/csv;base64,${btoa(csv)}`,
    }),
    onSuccess: onDone,
    onError: (e: { message?: string }) => setErr(e.message ?? 'Import failed'),
  })

  return (
    <div className="p-4 border-b border-s-border space-y-2 text-sm">
      <div className="grid grid-cols-2 gap-2">
        <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="source (bank:hbl)" className="bg-s-card border border-s-border rounded px-2 py-1 text-s-text" />
        <input value={accountCode} onChange={(e) => setAccountCode(e.target.value)} placeholder="account code (1020)" className="bg-s-card border border-s-border rounded px-2 py-1 text-s-text" />
        <input type="date" value={statementDate} onChange={(e) => setStatementDate(e.target.value)} className="bg-s-card border border-s-border rounded px-2 py-1 text-s-text" />
        <div className="flex gap-2">
          <input type="number" value={opening} onChange={(e) => setOpening(parseFloat(e.target.value) || 0)} placeholder="opening (PKR)" className="flex-1 bg-s-card border border-s-border rounded px-2 py-1 text-s-text" />
          <input type="number" value={closing} onChange={(e) => setClosing(parseFloat(e.target.value) || 0)} placeholder="closing (PKR)" className="flex-1 bg-s-card border border-s-border rounded px-2 py-1 text-s-text" />
        </div>
      </div>
      <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={6} placeholder="Paste CSV (date,description,amount,reference)" className="w-full bg-s-card border border-s-border rounded px-2 py-1 text-s-text font-mono text-xs" />
      {err && <p className="text-s-red text-xs">{err}</p>}
      <button onClick={() => submit.mutate()} disabled={submit.isPending} className="s-btn-primary text-xs">
        {submit.isPending ? 'Importing…' : 'Import'}
      </button>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ReconciliationPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<ReconTab>('shifts')
  const [selectedShift, setSelectedShift] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)

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
        <p className="text-xs text-s-muted mt-0.5">POS shift cash reconciliation, bank statements, and delivery settlements</p>
      </header>

      <div className="p-6 max-w-5xl mx-auto space-y-4">

        {/* Summary KPI strip (shifts tab) */}
        {tab === 'shifts' && summary && (
          <div className="grid grid-cols-3 gap-3">
            <div className="s-card p-4">
              <p className="text-xs text-s-muted">Shifts (30 days)</p>
              <p className="text-2xl font-bold text-s-text mt-0.5">{totalCount}</p>
            </div>
            <div className="s-card p-4">
              <p className="text-xs text-s-muted">Balanced</p>
              <p className="text-2xl font-bold text-green-400 mt-0.5">{balancedCount}</p>
            </div>
            <div className="s-card p-4">
              <p className="text-xs text-s-muted">Variance / Pending</p>
              <p className={`text-2xl font-bold mt-0.5 ${unbalancedCount > 0 ? 'text-red-400' : 'text-s-muted'}`}>
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
          ] as { key: ReconTab; label: string }[]).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
                tab === t.key
                  ? 'border-s-teal text-s-teal bg-s-bg-soft'
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
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-s-teal">
                        {fmtPkr(s.expectedCashCents)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <VariancePill cents={s.varianceCents} />
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          onClick={(e) => { e.stopPropagation(); setSelectedShift(s.shiftId) }}
                          className="text-xs text-s-muted hover:text-s-teal transition-colors">
                          {s.status === 'open' && s.closingFloatCents === null ? 'Complete →' : 'View →'}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {(!summary || summary.shifts.length === 0) && !summaryLoading && (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-s-muted text-sm">
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
                  <tr key={i.id} className="border-t border-s-border">
                    <td className="px-4 py-2 text-s-text">{i.source}</td>
                    <td className="px-4 py-2 font-mono text-xs text-s-muted">{i.accountCode}</td>
                    <td className="px-4 py-2 text-xs text-s-text">{i.statementDate.slice(0, 10)}</td>
                    <td className="px-4 py-2 text-right text-xs text-s-text">{i._count.lines}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(i.openingBalanceCents)}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(i.closingBalanceCents)}</td>
                  </tr>
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
