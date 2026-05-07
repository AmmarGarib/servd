'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../lib/api'
import { fmtPkr, todayPktIso } from '../../lib/money'

interface BankImport {
  id: string; source: string; accountCode: string; statementDate: string
  openingBalanceCents: number; closingBalanceCents: number
  filename: string | null
  _count: { lines: number }
}

interface Settlement {
  id: string; settlementDate: string; reference: string | null
  expectedAmountCents: number; actualAmountCents: number; varianceCents: number
  status: string
}

export default function ReconciliationPage() {
  const qc = useQueryClient()
  const [showImport, setShowImport] = useState(false)
  const [showSettle, setShowSettle] = useState(false)

  const { data: imports } = useQuery({
    queryKey: ['bank-imports'],
    queryFn: () => api.get<BankImport[]>('/reconciliation/bank/imports'),
  })
  const { data: settlements } = useQuery({
    queryKey: ['fp-settlements'],
    queryFn: () => api.get<Settlement[]>('/reconciliation/foodpanda/settlements'),
  })

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <h1 className="text-xl font-bold text-s-text">Reconciliation</h1>
      </header>

      <div className="p-6 max-w-5xl space-y-4">
        {/* ── Bank statements ─────────────────────────────────────────── */}
        <div className="s-card overflow-hidden">
          <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border flex items-center justify-between">
            <div className="text-xs font-semibold text-s-text">Bank Statement Imports</div>
            <button onClick={() => setShowImport(!showImport)} className="s-btn-secondary text-xs">
              {showImport ? 'Cancel' : 'Import CSV'}
            </button>
          </div>
          {showImport && <BankImportForm onDone={() => { setShowImport(false); void qc.invalidateQueries({ queryKey: ['bank-imports'] }) }} />}
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
              {imports?.map((i) => (
                <tr key={i.id} className="border-t border-s-border">
                  <td className="px-4 py-2 text-s-text">{i.source}</td>
                  <td className="px-4 py-2 font-mono text-xs text-s-muted">{i.accountCode}</td>
                  <td className="px-4 py-2 text-xs text-s-text">{i.statementDate.slice(0,10)}</td>
                  <td className="px-4 py-2 text-right text-xs text-s-text">{i._count.lines}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(i.openingBalanceCents)}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(i.closingBalanceCents)}</td>
                </tr>
              ))}
              {(!imports || imports.length === 0) && (
                <tr><td colSpan={6} className="px-4 py-3 text-xs text-s-muted">No imports yet</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* ── Foodpanda settlements ───────────────────────────────────── */}
        <div className="s-card overflow-hidden">
          <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border flex items-center justify-between">
            <div className="text-xs font-semibold text-s-text">Foodpanda Settlements</div>
            <button onClick={() => setShowSettle(!showSettle)} className="s-btn-secondary text-xs">
              {showSettle ? 'Cancel' : 'Record Settlement'}
            </button>
          </div>
          {showSettle && <SettlementForm onDone={() => { setShowSettle(false); void qc.invalidateQueries({ queryKey: ['fp-settlements'] }) }} />}
          <table className="w-full text-sm">
            <thead className="text-xs text-s-muted">
              <tr>
                <th className="px-4 py-2 text-left">Date</th>
                <th className="px-4 py-2 text-left">Ref</th>
                <th className="px-4 py-2 text-right">Expected</th>
                <th className="px-4 py-2 text-right">Actual</th>
                <th className="px-4 py-2 text-right">Variance</th>
                <th className="px-4 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {settlements?.map((s) => (
                <tr key={s.id} className="border-t border-s-border">
                  <td className="px-4 py-2 text-xs text-s-text">{s.settlementDate.slice(0,10)}</td>
                  <td className="px-4 py-2 text-xs text-s-muted">{s.reference ?? '—'}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(s.expectedAmountCents)}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(s.actualAmountCents)}</td>
                  <td className={`px-4 py-2 text-right font-mono text-xs ${s.varianceCents === 0 ? 'text-s-text' : 'text-s-amber'}`}>{fmtPkr(s.varianceCents)}</td>
                  <td className="px-4 py-2 text-xs text-s-text capitalize">{s.status.replace('_', ' ')}</td>
                </tr>
              ))}
              {(!settlements || settlements.length === 0) && (
                <tr><td colSpan={6} className="px-4 py-3 text-xs text-s-muted">No settlements yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function BankImportForm({ onDone }: { onDone: () => void }) {
  const [source, setSource] = useState('bank:hbl')
  const [accountCode, setAccountCode] = useState('1020')
  const [statementDate, setStatementDate] = useState(todayPktIso())
  const [opening, setOpening] = useState(0)
  const [closing, setClosing] = useState(0)
  const [csv, setCsv] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const submit = useMutation({
    mutationFn: () => api.post('/reconciliation/bank/imports', {
      source, accountCode, statementDate,
      openingBalanceCents: opening * 100, closingBalanceCents: closing * 100, csv,
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

function SettlementForm({ onDone }: { onDone: () => void }) {
  const [settlementDate, setSettlementDate] = useState(todayPktIso())
  const [periodStart, setPeriodStart] = useState(todayPktIso())
  const [periodEnd, setPeriodEnd]     = useState(todayPktIso())
  const [actualPkr, setActualPkr] = useState(0)
  const [reference, setReference] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const submit = useMutation({
    mutationFn: () => api.post('/reconciliation/foodpanda/settlements', {
      settlementDate, periodStart, periodEnd,
      actualAmountCents: Math.round(actualPkr * 100),
      reference: reference || undefined,
    }),
    onSuccess: onDone,
    onError: (e: { message?: string }) => setErr(e.message ?? 'Settlement failed'),
  })

  return (
    <div className="p-4 border-b border-s-border space-y-2 text-sm">
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-s-muted">Settlement date<input type="date" value={settlementDate} onChange={(e) => setSettlementDate(e.target.value)} className="w-full bg-s-card border border-s-border rounded px-2 py-1 text-s-text" /></label>
        <label className="text-xs text-s-muted">Reference (Foodpanda ID)<input value={reference} onChange={(e) => setReference(e.target.value)} className="w-full bg-s-card border border-s-border rounded px-2 py-1 text-s-text" /></label>
        <label className="text-xs text-s-muted">Period start<input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className="w-full bg-s-card border border-s-border rounded px-2 py-1 text-s-text" /></label>
        <label className="text-xs text-s-muted">Period end<input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="w-full bg-s-card border border-s-border rounded px-2 py-1 text-s-text" /></label>
        <label className="text-xs text-s-muted col-span-2">Actual paid (PKR)<input type="number" value={actualPkr} onChange={(e) => setActualPkr(parseFloat(e.target.value) || 0)} className="w-full bg-s-card border border-s-border rounded px-2 py-1 text-s-text" /></label>
      </div>
      {err && <p className="text-s-red text-xs">{err}</p>}
      <button onClick={() => submit.mutate()} disabled={submit.isPending} className="s-btn-primary text-xs">
        {submit.isPending ? 'Reconciling…' : 'Record'}
      </button>
    </div>
  )
}
