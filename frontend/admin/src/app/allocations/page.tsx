'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../lib/api'
import { fmtPkr, todayPktIso, startOfMonthPktIso } from '../../lib/money'
import { useAuthStore } from '../../store/auth'

/** A stored instant as its Karachi calendar day (a run covers whole PKT days). */
const pktDay = (iso: string) => new Date(new Date(iso).getTime() + 5 * 3600_000).toISOString().slice(0, 10)

interface Rule {
  id: string; name: string; sourceAccountCode: string; driver: 'fixed_pct'|'revenue_share'; isActive: boolean
  weights: Array<{ id: string; conceptId: string; weightBps: number; targetAccountCode: string | null; concept: { name: string; slug: string } }>
}

interface Run {
  id: string; ruleId: string; periodStart: string; periodEnd: string; totalAmountCents: number; postedAt: string
  rule: { name: string; sourceAccountCode: string }
}

export default function AllocationsPage() {
  const qc = useQueryClient()
  const [from, setFrom] = useState(startOfMonthPktIso())
  const [to,   setTo]   = useState(todayPktIso())
  const [running, setRunning] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  // Running a rule is the CEO's (the API is ADMIN_ONLY), so the button is
  // not shown to anyone else.
  const canRun = useAuthStore((s) => s.isRole('admin'))

  const { data: rules } = useQuery({
    queryKey: ['allocation-rules'],
    queryFn: () => api.get<Rule[]>('/allocations/rules'),
  })
  const { data: runs } = useQuery({
    queryKey: ['allocation-runs'],
    queryFn: () => api.get<Run[]>('/allocations/runs'),
  })

  const runRule = useMutation({
    mutationFn: (ruleId: string) => api.post(`/allocations/rules/${ruleId}/run`, { periodStart: from, periodEnd: to }),
    onSuccess: (d, ruleId) => {
      const r = d as { totalAmountCents?: number; brandTaggedCents?: number }
      const name = rules?.find((x) => x.id === ruleId)?.name ?? 'Rule'
      setFeedback(`${name} ran: ${fmtPkr(r.totalAmountCents ?? 0)} of shared cost allocated`
        + (r.brandTaggedCents ? ` (${fmtPkr(r.brandTaggedCents)} already booked to brands was left with them)` : ''))
      void qc.invalidateQueries({ queryKey: ['allocation-runs'] })
    },
    onError: (err: { message?: string }) => setFeedback(err.message ?? 'Run failed'),
    onSettled: () => setRunning(null),
  })

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <h1 className="text-xl font-bold text-s-text">Cost Allocation</h1>
        <p className="text-xs text-s-muted">Split shared expenses across brands. Only cost not already booked to a brand is split; a run covers whole Pakistan days.</p>
      </header>

      <div className="p-6 max-w-5xl mx-auto space-y-4">
        <div className="s-card p-4 flex items-center gap-3">
          <p className="text-xs text-s-muted flex-1">Period to allocate</p>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text" />
          <span className="text-s-muted text-xs">→</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text" />
        </div>

        {feedback && <p className="text-primary-ink text-sm">{feedback}</p>}

        <div className="s-card overflow-hidden">
          <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">Rules</div>
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-s-muted">
              <tr>
                <th className="px-4 py-2 text-left">Source Account</th>
                <th className="px-4 py-2 text-left">Name</th>
                <th className="px-4 py-2 text-left">Driver</th>
                <th className="px-4 py-2 text-left">Concepts</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rules?.map((r) => (
                <tr key={r.id} className="border-t border-s-border align-top">
                  <td className="px-4 py-2 font-mono text-xs text-s-muted">{r.sourceAccountCode}</td>
                  <td className="px-4 py-2 text-s-text">{r.name}</td>
                  <td className="px-4 py-2 text-xs text-s-muted">{r.driver === 'fixed_pct' ? 'Fixed %' : 'Revenue share'}</td>
                  <td className="px-4 py-2 text-xs text-s-text">
                    {r.weights.map((w) => (
                      <div key={w.id}>
                        {w.concept.name}: {(w.weightBps / 100).toFixed(1)}%
                      </div>
                    ))}
                  </td>
                  <td className="px-4 py-2"><span className={r.isActive ? 's-badge-teal' : 's-badge-muted'}>{r.isActive ? 'active' : 'inactive'}</span></td>
                  <td className="px-4 py-2 text-right">
                    {canRun && <button
                      onClick={() => { setRunning(r.id); setFeedback(null); runRule.mutate(r.id) }}
                      disabled={!r.isActive || running === r.id}
                      className="s-btn-secondary text-xs"
                    >
                      {running === r.id ? 'Running…' : 'Run for period'}
                    </button>}
                  </td>
                </tr>
              ))}
              {(!rules || rules.length === 0) && (
                <tr><td colSpan={6} className="px-4 py-3 text-xs text-s-muted">No rules configured. Rules are set by the CEO.</td></tr>
              )}
            </tbody>
          </table>
          </div>
        </div>

        <div className="s-card overflow-hidden">
          <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">Recent Runs</div>
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-s-muted">
              <tr>
                <th className="px-4 py-2 text-left">Posted</th>
                <th className="px-4 py-2 text-left">Rule</th>
                <th className="px-4 py-2 text-left">Period</th>
                <th className="px-4 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {runs?.map((r) => (
                <tr key={r.id} className="border-t border-s-border">
                  <td className="px-4 py-2 text-xs text-s-muted">{new Date(r.postedAt).toLocaleString()}</td>
                  <td className="px-4 py-2 text-s-text">{r.rule.name} <span className="font-mono text-xs text-s-muted">({r.rule.sourceAccountCode})</span></td>
                  <td className="px-4 py-2 text-xs text-s-text">{pktDay(r.periodStart)} → {pktDay(r.periodEnd)}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.totalAmountCents)}</td>
                </tr>
              ))}
              {(!runs || runs.length === 0) && (
                <tr><td colSpan={4} className="px-4 py-3 text-xs text-s-muted">No runs yet</td></tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      </div>
    </div>
  )
}
