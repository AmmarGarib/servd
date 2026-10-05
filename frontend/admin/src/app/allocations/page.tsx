'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../lib/api'
import { fmtPkr, todayPktIso, startOfMonthPktIso } from '../../lib/money'

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
    onSuccess: (_d, ruleId) => {
      setFeedback(`Rule ${ruleId.slice(0,8)} ran successfully`)
      void qc.invalidateQueries({ queryKey: ['allocation-runs'] })
    },
    onError: (err: { message?: string }) => setFeedback(err.message ?? 'Run failed'),
    onSettled: () => setRunning(null),
  })

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <h1 className="text-xl font-bold text-s-text">Cost Allocation</h1>
        <p className="text-xs text-s-muted">Split shared expenses across concepts</p>
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
                    <button
                      onClick={() => { setRunning(r.id); setFeedback(null); runRule.mutate(r.id) }}
                      disabled={!r.isActive || running === r.id}
                      className="s-btn-secondary text-xs"
                    >
                      {running === r.id ? 'Running…' : 'Run for period'}
                    </button>
                  </td>
                </tr>
              ))}
              {(!rules || rules.length === 0) && (
                <tr><td colSpan={6} className="px-4 py-3 text-xs text-s-muted">No rules configured. Create them via the API: POST /allocations/rules</td></tr>
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
                  <td className="px-4 py-2 text-xs text-s-text">{r.periodStart.slice(0,10)} → {r.periodEnd.slice(0,10)}</td>
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
