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
  low:      { bg: 'rgba(99,102,241,0.1)',  fg: '#A5B4FC', label: 'Low' },
  medium:   { bg: 'rgba(245,158,11,0.12)', fg: '#FCD34D', label: 'Medium' },
  high:     { bg: 'rgba(239,68,68,0.12)',  fg: '#FCA5A5', label: 'High' },
  critical: { bg: 'rgba(220,38,38,0.18)',  fg: '#FECACA', label: 'CRITICAL' },
}

const KIND_EMOJI: Record<string, string> = {
  receiving_variance:    '📦',
  short_shipment:        '⚠️',
  price_drift:           '💸',
  yield_low:             '📉',
  shrinkage:             '🕳',
  shrinkage_trend:       '📉',
  consecutive_voids:     '🔄',
  high_value_void:       '🚫',
  comp_above_threshold:  '🎁',
  refund_above_threshold:'↩️',
  cash_variance:         '💰',
  route_variance:        '🛵',
  lost_package:          '📭',
  pii_export:            '🔐',
  self_approval:         '🛑',
  ghost_employee:        '👻',
  manual_journal:        '📒',
  period_reopened:       '🔓',
  wage_change:           '💼',
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
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30">Owner inbox</p>
        <h1 className="text-2xl font-black text-white/90 mt-1">⚠️ Exceptions</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Things the system flagged for your eyes. Clean operations stay silent — this list is everything that broke a control rule.
        </p>

        {/* Stats strip */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5 max-w-3xl">
            <Stat value={stats.open}         label="Open" accent="#FCA5A5" />
            <Stat value={stats.acknowledged} label="Acknowledged" accent="#FCD34D" />
            <Stat value={stats.last24h}      label="Last 24h" accent="#A5B4FC" />
            <Stat value={stats.byKind.length} label="Distinct kinds" accent="#00D4B1" />
          </div>
        )}

        {/* Filter pills */}
        <div className="flex gap-2 mt-5">
          {(['open', 'acknowledged', 'resolved', 'dismissed'] as Status[]).map((s) => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className="text-xs font-bold px-3 py-1.5 rounded-full"
              style={statusFilter === s
                ? { background: 'rgba(0,212,177,0.15)', color: '#00D4B1', border: '1px solid rgba(0,212,177,0.4)' }
                : { background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.08)' }}>
              {s}
            </button>
          ))}
        </div>
      </header>

      <div className="px-7 py-6 max-w-5xl mx-auto space-y-2">
        {flags.length === 0 && (
          <div className="rounded-2xl p-10 text-center"
            style={{ background: 'rgba(0,212,177,0.05)', border: '1px solid rgba(0,212,177,0.18)' }}>
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
              style={{ background: 'rgba(255,255,255,0.025)', border: `1px solid ${sev.bg.replace(/[\d.]+\)$/, '0.4)')}` }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-2xl shrink-0" aria-hidden="true">{KIND_EMOJI[f.kind] ?? '⚠️'}</span>
                    <h3 className="font-black text-white/90">{f.title}</h3>
                    <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full"
                      style={{ background: sev.bg, color: sev.fg }}>
                      {sev.label}
                    </span>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-white/40 font-mono">{f.kind}</span>
                  </div>
                  <p className="text-sm text-white/65 mt-2 leading-relaxed">{f.description}</p>
                  {f.amountCents != null && (
                    <p className="text-sm font-bold text-amber-400 mt-1">PKR {(f.amountCents / 100).toLocaleString()}</p>
                  )}
                  <p className="text-[11px] text-white/30 mt-2">
                    {new Date(f.createdAt).toLocaleString()}
                    {f.entityType && f.entityId && ` · ${f.entityType} ${f.entityId.slice(0, 8)}`}
                  </p>
                  {f.resolution && (
                    <div className="mt-3 rounded-lg p-3 text-xs text-white/65"
                      style={{ background: 'rgba(0,212,177,0.06)', border: '1px solid rgba(0,212,177,0.18)' }}>
                      <strong className="text-[#00D4B1]">Resolved:</strong> {f.resolution}
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
                      className="rounded-lg bg-kds-green text-black px-3 py-1.5 text-xs font-bold hover:opacity-90">
                      Resolve
                    </button>
                  </div>
                )}
                {f.status === 'acknowledged' && (
                  <button onClick={() => setResolveFor(f)}
                    className="rounded-lg bg-kds-green text-black px-3 py-1.5 text-xs font-bold hover:opacity-90 shrink-0">
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
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <p className="text-2xl font-black" style={{ color: accent }}>{value}</p>
      <p className="text-[10px] font-bold uppercase tracking-wider text-white/45 mt-0.5">{label}</p>
    </div>
  )
}

function ResolveModal({ flag, onClose, onResolve, pending }: { flag: ExceptionFlag; onClose: () => void; onResolve: (r: string) => void; pending: boolean }) {
  const [resolution, setResolution] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl overflow-hidden" style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/[0.05]">
          <h2 className="font-black text-white/90">Resolve flag</h2>
          <p className="text-xs text-white/45 mt-0.5 truncate">{flag.title}</p>
        </div>
        <div className="p-5 space-y-3">
          <label className="text-xs text-white/55">What did you do? *</label>
          <textarea value={resolution} onChange={(e) => setResolution(e.target.value)} rows={4}
            placeholder="Spoke with cashier. Reviewed footage. Counter-checked next shift's drawer. Variance traced to PKR 200 wrong-change incident; recovered."
            className="w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-kds-green focus:outline-none" autoFocus />
        </div>
        <div className="flex justify-between p-4 border-t border-white/[0.05] bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => onResolve(resolution)} disabled={!resolution.trim() || pending}
            className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50">
            {pending ? 'Saving…' : 'Mark resolved'}
          </button>
        </div>
      </div>
    </div>
  )
}
