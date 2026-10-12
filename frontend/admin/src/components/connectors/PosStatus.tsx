'use client'
// POS connector → Status tab (spec §10): the fiscal mode, its health, the
// backlog (each count opens Submissions filtered to it) and the card-machine
// charges that need a person. Polls every 10 s and refreshes on the
// `fiscal.filed` socket event.

import { useState } from 'react'
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import {
  connectorsApi, connectorErrorText, type ConnectorsOverview, type FiscalDocStatus, type TerminalChargeStatus, type TerminalChargeView,
} from '../../lib/connectorsApi'
import { fmtPkr } from '../../lib/money'
import { Badge, Card, ChargeChip, Dot, ErrorLine, Field, Modal, TestBadge, fmtAge, fmtWhen, type Tone } from './ui'

export function fiscalMode(o: ConnectorsOverview): { label: string; tone: Tone; test: boolean } {
  const f = o.fiscal
  if (!o.fiscalReportingRequired) return { label: 'Not required for this company', tone: 'muted', test: false }
  if (f.enabled) return { label: f.liveSince ? `Live since ${fmtWhen(f.liveSince)}` : 'Live', tone: 'ok', test: f.isTest }
  if (f.liveSince) return { label: 'Switched off — new sales are held', tone: 'bad', test: f.isTest }
  return { label: 'Off — sales are held until go-live', tone: 'warn', test: f.isTest }
}

export function fiscalHealth(o: ConnectorsOverview): { tone: Tone; label: string } {
  const c = o.counts
  if (!o.fiscalReportingRequired) return { tone: 'muted', label: 'Not required' }
  if (!o.fiscal.enabled) return { tone: c.held > 0 ? 'warn' : 'muted', label: c.held > 0 ? `${c.held} held` : 'Off' }
  if (c.failed + c.rejected + c.manualRequired > 0) return { tone: 'bad', label: 'Needs attention' }
  const oldMs = c.oldestPendingAt ? Date.now() - new Date(c.oldestPendingAt).getTime() : 0
  if (c.held > 0 || c.submittingStale > 0 || oldMs > 15 * 60_000) return { tone: 'warn', label: 'Behind' }
  return { tone: 'ok', label: 'Filing' }
}

const ATTENTION: TerminalChargeStatus[] = ['needs_attention', 'unknown', 'unverified']

/**
 * Mirrors resolveTerminalCharge (terminal/service.ts): only a CHARGE can be
 * resolved by hand — one whose outcome is unknown, or a needs_attention
 * charge the bank never approved (no approval ref, no payment). A
 * needs_attention charge WITH an approval is a failed reversal: Reverse it.
 * A refund is never resolvable.
 */
export function canResolveCharge(ch: TerminalChargeView): boolean {
  if (ch.kind !== 'charge') return false
  if (ch.status === 'unknown') return true
  return ch.status === 'needs_attention' && !ch.approvalRef && !ch.payment
}

/**
 * Everything here is the ACTIVE company's — the counts and the "needs a
 * person" charges too, even in the all-companies view (the API binds them to
 * that company; the page header says so).
 */
export function PosStatus({ data, canManageCharges, onOpenSubmissions }: {
  data: ConnectorsOverview
  /** Managers (and the CEO) may resolve / reverse card charges. */
  canManageCharges: boolean
  /** `today` narrows the list to documents created today (Pakistan time). */
  onOpenSubmissions: (status: FiscalDocStatus | '', opts?: { today?: boolean }) => void
}) {
  const mode = fiscalMode(data)
  const health = fiscalHealth(data)
  const c = data.counts
  const f = data.fiscal

  const counters: Array<{ label: string; value: number; status: FiscalDocStatus | ''; tone: Tone; sub?: string; today?: boolean }> = [
    { label: 'Held', value: c.held, status: 'held', tone: c.held ? 'warn' : 'muted', sub: f.enabled ? 'not registered yet, or waiting for release' : 'filed once released after go-live' },
    { label: 'Waiting', value: c.waiting, status: 'waiting', tone: c.waiting ? 'warn' : 'muted', sub: 'refunds waiting for their sale' },
    { label: 'Pending', value: c.pending, status: 'pending', tone: c.pending ? 'warn' : 'muted', sub: [c.oldestPendingAt ? `oldest ${fmtAge(c.oldestPendingAt)}` : '', 'incl. sending now'].filter(Boolean).join(' · ') },
    { label: 'Failed', value: c.failed, status: 'failed', tone: c.failed ? 'bad' : 'muted' },
    { label: 'Rejected', value: c.rejected, status: 'rejected', tone: c.rejected ? 'bad' : 'muted' },
    { label: 'File by hand', value: c.manualRequired, status: 'manual_required', tone: c.manualRequired ? 'bad' : 'muted' },
    { label: 'Filed today', value: c.filedToday, status: 'filed', tone: 'ok', today: true, sub: 'incl. filed by hand; the list opens on today\u2019s sales filed by the POS' },
  ]

  return (
    <div className="space-y-4">
      <Card title="Fiscal POS" subtitle="Files every full & final bill with FBR / SRB through the external fiscal POS. Pre-bills are never sent.">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={mode.tone}>{mode.label}</Badge>
          {mode.test && <TestBadge />}
          <Dot tone={health.tone} label={health.label} />
          <span className="text-xs text-s-muted">Driver: <span className="font-mono text-s-text">{f.driver}</span></span>
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div>
            <dt className="text-s-muted">Last good answer</dt>
            <dd className="text-s-text">{fmtWhen(f.lastOkAt)}</dd>
          </div>
          <div>
            <dt className="text-s-muted">Last test</dt>
            <dd className="text-s-text">
              {f.lastTestAt ? `${fmtWhen(f.lastTestAt)} — ${f.lastTestOk ? 'passed' : 'failed'}` : 'Never'}
              {f.lastTestDetail && <span className="block text-s-muted break-words">{f.lastTestDetail}</span>}
            </dd>
          </div>
          <div>
            <dt className="text-s-muted">Last error</dt>
            <dd className={f.lastError ? 'text-s-red break-words' : 'text-s-text'}>
              {f.lastError ? `${fmtWhen(f.lastErrorAt)} — ${f.lastError}` : 'None'}
            </dd>
          </div>
        </dl>
      </Card>

      <Card title="Backlog" subtitle="Tap a number to see those documents. Nothing is lost while the fiscal POS is unreachable — servd keeps retrying.">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          {counters.map((k) => (
            <button key={k.label} onClick={() => onOpenSubmissions(k.status, { today: k.today })}
              className="rounded-lg border border-s-border bg-s-bg p-3 text-left hover:border-s-border-strong transition-colors">
              <p className="text-[11px] uppercase tracking-wider text-s-muted">{k.label}</p>
              <p className={`text-xl font-bold ${k.tone === 'bad' ? 'text-s-red' : k.tone === 'warn' ? 'text-s-amber' : 'text-s-text'}`}>{k.value}</p>
              {k.sub && <p className="text-[10px] text-s-muted leading-tight">{k.sub}</p>}
            </button>
          ))}
        </div>
        {c.submittingStale > 0 && (
          <p className="text-xs text-s-amber">{c.submittingStale} sending attempt(s) timed out — servd looks each one up with the fiscal POS before resending, so nothing is filed twice.</p>
        )}
      </Card>

      <CardAttention canManage={canManageCharges} terminalAttention={data.terminalAttention} />
    </div>
  )
}

function CardAttention({ canManage, terminalAttention }: { canManage: boolean; terminalAttention: number }) {
  const results = useQueries({
    queries: ATTENTION.map((status) => ({
      queryKey: ['connector-charges', { status }],
      queryFn: () => connectorsApi.charges({ status, limit: 50 }),
      refetchInterval: 10_000,
    })),
  })
  const items = results.flatMap((r) => r.data?.items ?? [])
  const loading = results.some((r) => r.isLoading)
  const err = results.find((r) => r.error)?.error
  const [resolving, setResolving] = useState<TerminalChargeView | null>(null)
  const [reversing, setReversing] = useState<TerminalChargeView | null>(null)

  return (
    <Card title="Card machine — needs a person"
      subtitle="Charges whose outcome servd could not confirm, or whose automatic reversal failed. Never re-key a charge on the machine while servd shows it here — resolve it.">
      {loading && <p className="text-xs text-s-muted">Loading…</p>}
      <ErrorLine>{err ? connectorErrorText(err) : null}</ErrorLine>
      {!loading && items.length === 0 && (
        <p className="text-xs text-s-muted">
          Nothing waiting.{terminalAttention > 0 && ` (${terminalAttention} charge(s) are being reversed automatically.)`}
        </p>
      )}
      {items.length > 0 && (
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="s-table">
            <thead><tr><th>Started</th><th>Machine</th><th>Order</th><th>Amount</th><th>Status</th><th>Note</th><th /></tr></thead>
            <tbody>
              {items.map((ch) => (
                <tr key={ch.id}>
                  <td>{fmtWhen(ch.createdAt)}</td>
                  <td>{ch.terminalLabel}</td>
                  <td className="font-mono text-xs">{ch.orderId.slice(-6).toUpperCase()}</td>
                  <td>{fmtPkr(ch.amountCents)}{ch.kind === 'refund' && <span className="text-s-muted"> refund</span>}</td>
                  <td><ChargeChip status={ch.status} /></td>
                  <td className="max-w-[260px] whitespace-normal text-xs text-s-muted">{ch.message ?? ch.refusalCode ?? ''}</td>
                  <td className="text-right space-x-1">
                    {canManage && canResolveCharge(ch) && (
                      <button className="s-btn-secondary px-2 py-1 text-xs" onClick={() => setResolving(ch)}>Resolve</button>
                    )}
                    {canManage && ch.status === 'needs_attention' && ch.kind === 'charge' && (
                      <button className="s-btn-secondary px-2 py-1 text-xs" onClick={() => setReversing(ch)}>Reverse</button>
                    )}
                    {canManage && ch.kind === 'refund' &&['unknown', 'needs_attention'].includes(ch.status) && (
                      <span className="block text-[11px] text-s-muted text-left">Check the machine&rsquo;s refund list; if it did not refund, record the refund on the order by hand.</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!canManage && items.length > 0 && <p className="text-[11px] text-s-muted">A manager resolves or reverses these.</p>}
      {resolving && <ResolveDialog charge={resolving} onClose={() => setResolving(null)} />}
      {reversing && <ReverseDialog charge={reversing} onClose={() => setReversing(null)} />}
    </Card>
  )
}

function ResolveDialog({ charge, onClose }: { charge: TerminalChargeView; onClose: () => void }) {
  const qc = useQueryClient()
  const [outcome, setOutcome] = useState<'approved_manual' | 'not_charged'>('approved_manual')
  const [ref, setRef] = useState('')
  const [note, setNote] = useState('')
  const m = useMutation({
    mutationFn: () => connectorsApi.resolveCharge(charge.id,
      outcome === 'approved_manual' ? { outcome, gatewayRef: ref.trim() } : { outcome, ...(note.trim() && { note: note.trim() }) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['connector-charges'] }); void qc.invalidateQueries({ queryKey: ['connectors'] }); onClose() },
  })
  return (
    <Modal title={`Resolve card charge — ${fmtPkr(charge.amountCents)} on ${charge.terminalLabel}`} onClose={onClose}>
      <p className="text-xs text-s-muted">Read the machine&rsquo;s own record (its last-transactions list or the slip) and say what happened.</p>
      <div className="space-y-2 text-sm">
        <label className="flex items-start gap-2">
          <input type="radio" checked={outcome === 'approved_manual'} onChange={() => setOutcome('approved_manual')} className="mt-1" />
          <span>The card WAS charged — record the payment from the slip</span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" checked={outcome === 'not_charged'} onChange={() => setOutcome('not_charged')} className="mt-1" />
          <span>The card was NOT charged — release the order (servd keeps checking for 24 h)</span>
        </label>
      </div>
      {outcome === 'approved_manual'
        ? <Field label="Approval / reference on the slip"><input className="s-input font-mono" value={ref} onChange={(e) => setRef(e.target.value)} maxLength={64} /></Field>
        : <Field label="Note (optional)"><input className="s-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>}
      <ErrorLine>{m.error ? connectorErrorText(m.error) : null}</ErrorLine>
      <div className="flex justify-end gap-2">
        <button className="s-btn-ghost" onClick={onClose}>Cancel</button>
        <button className="s-btn-primary" disabled={m.isPending || (outcome === 'approved_manual' && ref.trim().length < 3)} onClick={() => m.mutate()}>
          {m.isPending ? 'Saving…' : 'Resolve'}
        </button>
      </div>
    </Modal>
  )
}

function ReverseDialog({ charge, onClose }: { charge: TerminalChargeView; onClose: () => void }) {
  const qc = useQueryClient()
  const [manual, setManual] = useState(false)
  const [note, setNote] = useState('')
  const m = useMutation({
    mutationFn: () => connectorsApi.reverseCharge(charge.id, { markRefundedOnMachine: manual, ...(note.trim() && { note: note.trim() }) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['connector-charges'] }); void qc.invalidateQueries({ queryKey: ['connectors'] }); onClose() },
  })
  return (
    <Modal title={`Reverse card charge — ${fmtPkr(charge.amountCents)}`} onClose={onClose}>
      <p className="text-xs text-s-muted">
        The card was charged but servd refused the payment, and the automatic reversal failed. Try the reversal again, or — if the money was
        already given back on the machine itself — record that.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} className="mt-1" />
        <span>It was already refunded on the machine — mark it reversed</span>
      </label>
      <Field label="Note (optional)"><input className="s-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
      <ErrorLine>{m.error ? connectorErrorText(m.error) : null}</ErrorLine>
      <div className="flex justify-end gap-2">
        <button className="s-btn-ghost" onClick={onClose}>Cancel</button>
        <button className="s-btn-primary" disabled={m.isPending} onClick={() => m.mutate()}>
          {m.isPending ? 'Working…' : manual ? 'Mark reversed' : 'Retry reversal'}
        </button>
      </div>
    </Modal>
  )
}
