'use client'
// Exception Inbox — owner sees only what's broken.
// Open flags grouped by severity. Acknowledge = "I'm on it"; Resolve = closed
// with note. Dismissed flags stay in DB for audit but never re-surface.

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../lib/api'

type Severity = 'low' | 'medium' | 'high' | 'critical'
type Status = 'open' | 'acknowledged' | 'resolved' | 'dismissed'

interface ExceptionFlag {
  id: string
  kind: string
  severity: Severity
  status: Status
  title: string
  description: string
  entityType: string | null
  entityId: string | null
  actorId: string | null
  amountCents: number | null
  metadata: Record<string, unknown> | null
  createdAt: string
  acknowledgedAt: string | null
  resolvedAt: string | null
  resolution: string | null
}

const SEV_STYLE: Record<Severity, { bg: string; fg: string; label: string }> = {
  low:      { bg: 'rgb(61 31 59 / 0.1)',  fg: '#6b2f68', label: 'Low' },
  medium:   { bg: 'rgba(245,158,11,0.12)', fg: '#a15c00', label: 'Medium' },
  high:     { bg: 'rgba(239,68,68,0.12)',  fg: '#b42318', label: 'High' },
  critical: { bg: 'rgba(220,38,38,0.18)',  fg: '#FECACA', label: 'CRITICAL' },
}

// Plain labels for every ExceptionFlag kind (backend lib/exceptions.ts
// ExceptionKind). Text, never emoji. A flag written under a stand-in kind
// before its own kind existed carries the intended one in metadata.realKind,
// which wins.
const KIND_LABEL: Record<string, string> = {
  receiving_variance:      'Receiving variance',
  price_drift:             'Supplier price drift',
  short_shipment:          'Short shipment',
  yield_low:               'Low prep yield',
  shrinkage:               'Stock shrinkage',
  shrinkage_trend:         'Shrinkage trend',
  consecutive_voids:       'Repeated voids',
  high_value_void:         'High-value void',
  void_after_fire:         'Void after firing to the kitchen',
  comp_above_threshold:    'Comp above limit',
  refund_above_threshold:  'Refund above limit',
  cash_variance:           'Cash drawer variance',
  route_variance:          'Rider route variance',
  lost_package:            'Lost delivery',
  pii_export:              'Customer data export',
  self_approval:           'Self-approval attempt',
  manager_pin_failed:      'Wrong manager PINs (locked)',
  discount_above_cap:      'Discount above cap',
  price_override:          'Price override',
  ghost_employee:          'Payroll with no clock-ins',
  manual_journal:          'Manual journal entry',
  period_reopened:         'Period reopened',
  wage_change:             'Wage change',
  food_safety_temperature: 'Temperature out of range',
  posting_failed:          'Ledger posting failed',
  fiscal_failed:           'Fiscal filing failed',
  fiscal_rejected:         'Fiscal POS rejected a document',
  fiscal_auth:             'Fiscal POS refused the API key',
  fiscal_manual_refund:    'Refund to file by hand',
  terminal_void_failed:    'Card reversal failed',
  terminal_unreconciled:   'Card payment does not reconcile',
}

/** The kind a flag is really about: metadata.realKind when set, else its kind. */
function kindOf(f: { kind: string; metadata: Record<string, unknown> | null }): string {
  const real = f.metadata?.['realKind']
  return typeof real === 'string' && real ? real : f.kind
}

/** A plain label for a kind, falling back to the code made readable. */
function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? (kind.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()))
}

export default function ExceptionInboxPage() {
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<Status>('open')
  const [resolveFor, setResolveFor] = useState<ExceptionFlag | null>(null)

  const { data: flags = [] } = useQuery<ExceptionFlag[]>({
    queryKey: ['exceptions', statusFilter],
    queryFn: () => api.get(`/crosschecks/exceptions?status=${statusFilter}`),
    refetchInterval: 30_000,
  })
  const { data: stats } = useQuery<{ open: number; acknowledged: number; last24h: number; byKind: { kind: string; count: number }[] }>({
    queryKey: ['exceptions-stats'],
    queryFn: () => api.get('/crosschecks/exceptions/stats'),
    refetchInterval: 30_000,
  })

  const ack = useMutation({
    mutationFn: (id: string) => api.patch(`/crosschecks/exceptions/${id}/acknowledge`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exceptions'] }),
  })
  const resolve = useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution: string }) =>
      api.patch(`/crosschecks/exceptions/${id}/resolve`, { resolution }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['exceptions'] }); setResolveFor(null) },
  })

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30">Owner inbox</p>
        <h1 className="text-2xl font-black text-white/90 mt-1">Exceptions</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Things the system flagged for your eyes. Clean operations stay silent — this list is everything that broke a control rule.
        </p>

        {/* Stats strip */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5 max-w-3xl">
            <Stat value={stats.open}         label="Open" accent="#b42318" />
            <Stat value={stats.acknowledged} label="Acknowledged" accent="#a15c00" />
            <Stat value={stats.last24h}      label="Last 24h" accent="#6b2f68" />
            <Stat value={stats.byKind.length} label="Distinct kinds" accent="var(--erp-primary-ink)" />
          </div>
        )}

        {/* Filter pills */}
        <div className="flex gap-2 mt-5">
          {(['open', 'acknowledged', 'resolved', 'dismissed'] as Status[]).map((s) => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className="text-xs font-bold px-3 py-1.5 rounded-full"
              style={statusFilter === s
                ? { background: 'rgb(135 197 64 / 0.15)', color: 'var(--erp-primary-ink)', border: '1px solid rgb(135 197 64 / 0.4)' }
                : { background: 'rgb(var(--fg-rgb) / 0.04)', color: 'rgb(var(--fg-rgb) / 0.5)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
              {s}
            </button>
          ))}
        </div>
      </header>

      <div className="px-7 py-6 max-w-5xl mx-auto space-y-2">
        {flags.length === 0 && (
          <div className="rounded-2xl p-10 text-center"
            style={{ background: 'rgb(135 197 64 / 0.05)', border: '1px solid rgb(135 197 64 / 0.18)' }}>
            <p className="text-3xl mb-2">✓</p>
            <p className="font-bold text-white/85">No {statusFilter} exceptions</p>
            <p className="text-sm text-white/45 mt-1">
              {statusFilter === 'open' ? 'All controls passing. Quiet system = good system.' : `Switch tabs to see other states.`}
            </p>
          </div>
        )}

        {flags.map((f) => {
          const sev = SEV_STYLE[f.severity]
          return (
            <div key={f.id} className="rounded-2xl p-5"
              style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: `1px solid ${sev.bg.replace(/[\d.]+\)$/, '0.4)')}` }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-black text-white/90">{f.title}</h3>
                    <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full"
                      style={{ background: sev.bg, color: sev.fg }}>
                      {sev.label}
                    </span>
                    <span className="text-[11px] font-semibold text-white/50" title={kindOf(f)}>{kindLabel(kindOf(f))}</span>
                  </div>
                  <p className="text-sm text-white/65 mt-2 leading-relaxed">{f.description}</p>
                  {f.amountCents != null && (
                    <p className="text-sm font-bold text-amber-700 mt-1">PKR {(f.amountCents / 100).toLocaleString()}</p>
                  )}
                  <p className="text-[11px] text-white/30 mt-2">
                    {new Date(f.createdAt).toLocaleString()}
                    {f.entityType && f.entityId && ` · ${f.entityType} ${f.entityId.slice(0, 8)}`}
                  </p>
                  {f.resolution && (
                    <div className="mt-3 rounded-lg p-3 text-xs text-white/65"
                      style={{ background: 'rgb(135 197 64 / 0.06)', border: '1px solid rgb(135 197 64 / 0.18)' }}>
                      <strong className="text-primary-ink">Resolved:</strong> {f.resolution}
                    </div>
                  )}
                </div>
                {f.status === 'open' && (
                  <div className="flex flex-col gap-2 shrink-0">
                    <button onClick={() => ack.mutate(f.id)}
                      className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white">
                      Ack
                    </button>
                    <button onClick={() => setResolveFor(f)}
                      className="rounded-lg bg-primary text-primary-on px-3 py-1.5 text-xs font-bold hover:opacity-90">
                      Resolve
                    </button>
                  </div>
                )}
                {f.status === 'acknowledged' && (
                  <button onClick={() => setResolveFor(f)}
                    className="rounded-lg bg-primary text-primary-on px-3 py-1.5 text-xs font-bold hover:opacity-90 shrink-0">
                    Resolve
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {resolveFor && <ResolveModal flag={resolveFor} onClose={() => setResolveFor(null)} onResolve={(res) => resolve.mutate({ id: resolveFor.id, resolution: res })} pending={resolve.isPending} />}
    </div>
  )
}

function Stat({ value, label, accent }: { value: number; label: string; accent: string }) {
  return (
    <div className="rounded-xl p-3"
      style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <p className="text-2xl font-black" style={{ color: accent }}>{value}</p>
      <p className="text-[10px] font-bold uppercase tracking-wider text-white/45 mt-0.5">{label}</p>
    </div>
  )
}

function ResolveModal({ flag, onClose, onResolve, pending }: { flag: ExceptionFlag; onClose: () => void; onResolve: (r: string) => void; pending: boolean }) {
  const [resolution, setResolution] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }} onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/[0.05]">
          <h2 className="font-black text-white/90">Resolve flag</h2>
          <p className="text-xs text-white/45 mt-0.5 truncate">{flag.title}</p>
        </div>
        <div className="p-5 space-y-3">
          <label className="text-xs text-white/55">What did you do? *</label>
          <textarea value={resolution} onChange={(e) => setResolution(e.target.value)} rows={4}
            placeholder="Spoke with cashier. Reviewed footage. Counter-checked next shift's drawer. Variance traced to PKR 200 wrong-change incident; recovered."
            className="w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none" autoFocus />
        </div>
        <div className="flex justify-between p-4 border-t border-white/[0.05] bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => onResolve(resolution)} disabled={!resolution.trim() || pending}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {pending ? 'Saving…' : 'Mark resolved'}
          </button>
        </div>
      </div>
    </div>
  )
}
