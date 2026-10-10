'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Fragment, useState } from 'react'
import { api, posApi, type ZReport } from '../../lib/api'
import { fmtPkr, todayPktIso } from '../../lib/money'
import { format } from 'date-fns'
import { BackfillUnposted } from './BackfillUnposted'

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

interface BankAccountOpt { id: string; name: string; bankName: string | null; accountCode: string | null }

interface StatementLine {
  id: string; postedDate: string; description: string; reference: string | null
  amountCents: number; matchStatus: 'unmatched' | 'matched' | 'adjusted' | 'ignored'; notes: string | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ReconTab = 'shifts' | 'bank'

const METHOD_LABEL: Record<string, string> = { cash: 'Cash', card: 'Card', keenu_qr: 'Keenu QR', comp: 'Comps', split: 'Split' }

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

  const { data, isLoading, error } = useQuery<ZReport>({
    queryKey: ['recon-shift', shiftId],
    queryFn: () => posApi.getZReport(shiftId),
  })

  const complete = useMutation({
    mutationFn: () => posApi.closeShift(shiftId, Math.round(parseFloat(closingFloat) * 100), notes || undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recon-shift', shiftId] })
      void qc.invalidateQueries({ queryKey: ['recon-summary'] })
    },
  })

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
                    <td className="px-4 py-2.5 text-s-muted">Total sales (cash + card)</td>
                    <td className="px-4 py-2.5 text-right font-mono text-primary-ink">{fmtPkr(data.grossCents)}</td>
                  </tr>
                </tbody>
              </table>
              </div>
            </div>

            {/* Close — only for a drawer still open */}
            {data.status === 'open' && (
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
                {complete.isError && (
                  <p className="text-sm text-s-red">{(complete.error as Error).message}</p>
                )}
                <button
                  onClick={() => complete.mutate()}
                  disabled={complete.isPending || !closingFloat}
                  className="w-full rounded-xl bg-primary text-primary-on font-bold py-2.5 text-sm hover:opacity-90 disabled:opacity-40">
                  {complete.isPending ? 'Closing…' : 'Close shift'}
                </button>
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
// API refuses it otherwise. Booking is for the CEO and co-owners.

interface SplitRow { code: string; type: 'debit' | 'credit'; amount: string }

const toCents = (pkr: string) => Math.round((parseFloat(pkr) || 0) * 100)

function AdjustForm({ line, onDone, onCancel }: { line: StatementLine; onDone: () => void; onCancel: () => void }) {
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

function StatementLines({ importId }: { importId: string }) {
  const qc = useQueryClient()
  const [adjusting, setAdjusting] = useState<string | null>(null)
  const { data: lines = [], isLoading } = useQuery<StatementLine[]>({
    queryKey: ['bank-lines', importId],
    queryFn: () => api.get(`/reconciliation/bank/imports/${importId}/lines`),
  })
  const refresh = () => void qc.invalidateQueries({ queryKey: ['bank-lines', importId] })
  const ignore = useMutation({ mutationFn: (id: string) => api.post(`/reconciliation/bank/lines/${id}/ignore`, {}), onSuccess: refresh })

  if (isLoading) return <p className="px-4 py-3 text-xs text-s-muted">Loading lines…</p>
  return (
    <div className="bg-s-bg-soft/40 overflow-x-auto">
      {ignore.error && (
        <p className="px-4 pt-2 text-xs text-s-red">{(ignore.error as Error).message}</p>
      )}
      <table className="w-full text-xs">
        <tbody>
          {lines.map((l) => (
            <Fragment key={l.id}>
              <tr className="border-t border-s-border align-top">
                <td className="px-4 py-2 text-s-muted whitespace-nowrap">{l.postedDate.slice(0, 10)}</td>
                <td className="px-4 py-2 text-s-text">{l.description}{l.reference && <span className="text-s-muted"> · {l.reference}</span>}</td>
                <td className={`px-4 py-2 text-right font-mono ${l.amountCents < 0 ? 'text-s-red' : 'text-s-text'}`}>{fmtPkr(l.amountCents)}</td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  {l.matchStatus !== 'unmatched' ? (
                    <span className="text-s-muted">{l.matchStatus}</span>
                  ) : adjusting === l.id ? (
                    <span className="text-s-muted">booking…</span>
                  ) : (
                    <span className="inline-flex gap-3">
                      <button onClick={() => setAdjusting(l.id)} className="text-primary-ink">Book adjustment</button>
                      <button onClick={() => ignore.mutate(l.id)} className="text-s-muted hover:text-s-text">Ignore</button>
                    </span>
                  )}
                </td>
              </tr>
              {adjusting === l.id && l.matchStatus === 'unmatched' && (
                <tr className="border-t border-s-border/50">
                  <td colSpan={4} className="p-0">
                    <AdjustForm line={l} onCancel={() => setAdjusting(null)} onDone={() => { setAdjusting(null); refresh() }} />
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
        <p className="text-xs text-s-muted mt-0.5">POS shift cash reconciliation and bank statements</p>
      </header>

      <div className="p-6 max-w-5xl mx-auto space-y-4">

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
                      <tr><td colSpan={6} className="p-0"><StatementLines importId={i.id} /></td></tr>
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
