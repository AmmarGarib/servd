'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../lib/api'
import { fmtPkr, todayPktIso, startOfMonthPktIso } from '../../lib/money'
import { useAuthStore } from '../../store/auth'
import { usePermissions } from '../../hooks/useCan'

/** A stored instant as its Karachi calendar day (a run covers whole PKT days). */
const pktDay = (iso: string) => new Date(new Date(iso).getTime() + 5 * 3600_000).toISOString().slice(0, 10)

interface Rule {
  id: string; name: string; sourceAccountCode: string; driver: 'fixed_pct'|'revenue_share'; isActive: boolean
  weights: Array<{ id: string; conceptId: string; weightBps: number; targetAccountCode: string | null; concept: { name: string; slug: string } }>
}

interface Run {
  id: string; ruleId: string; periodStart: string; periodEnd: string; totalAmountCents: number; postedAt: string
  reversedAt: string | null
  rule: { name: string; sourceAccountCode: string }
}

interface Brand { id: string; name: string }

interface Draft {
  name: string; sourceAccountCode: string; driver: 'fixed_pct' | 'revenue_share'; isActive: boolean
  /** Percent per brand id, as typed (fixed % only; revenue share uses the ticks). */
  pct: Record<string, string>
  on: Record<string, boolean>
}

const emptyDraft = (): Draft => ({ name: '', sourceAccountCode: '', driver: 'fixed_pct', isActive: true, pct: {}, on: {} })

const draftOf = (r: Rule): Draft => ({
  name: r.name, sourceAccountCode: r.sourceAccountCode, driver: r.driver, isActive: r.isActive,
  pct: Object.fromEntries(r.weights.map((w) => [w.conceptId, String(w.weightBps / 100)])),
  on: Object.fromEntries(r.weights.map((w) => [w.conceptId, true])),
})

export default function AllocationsPage() {
  const qc = useQueryClient()
  const [from, setFrom] = useState(startOfMonthPktIso())
  const [to,   setTo]   = useState(todayPktIso())
  const [running, setRunning] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [editing, setEditing] = useState<Draft | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [reversing, setReversing] = useState<{ id: string; reason: string } | null>(null)
  // Finance runs the allocation and edits the rules (owner, 2026-10-16); the
  // CEO keeps it. The API gate is the same: the CEO, or finance holding the
  // accounting module. Deleting a rule stays the CEO's. A run or reversal in
  // closed / reopened books is refused by the API for anyone but the CEO.
  const isCeo = useAuthStore((s) => s.isRole('admin'))
  const isFinance = useAuthStore((s) => s.isRole('finance'))
  const { data: perms } = usePermissions()
  const canRun = isCeo || (isFinance && (perms?.modules ?? []).includes('accounting'))

  const { data: rules } = useQuery({
    queryKey: ['allocation-rules'],
    queryFn: () => api.get<Rule[]>('/allocations/rules'),
  })
  const { data: runs } = useQuery({
    queryKey: ['allocation-runs'],
    queryFn: () => api.get<Run[]>('/allocations/runs'),
  })

  const { data: brands } = useQuery({
    queryKey: ['concepts', 'brand-picker'],
    queryFn: () => api.get<Brand[]>('/concepts?view=picker'),
    enabled: canRun,
    staleTime: 60_000,
  })

  const saveRule = useMutation({
    mutationFn: (d: Draft) => {
      const chosen = (brands ?? []).filter((b) => d.on[b.id])
      return api.post('/allocations/rules', {
        name: d.name.trim(),
        sourceAccountCode: d.sourceAccountCode.trim(),
        driver: d.driver,
        isActive: d.isActive,
        weights: chosen.map((b) => ({
          conceptId: b.id,
          weightBps: d.driver === 'fixed_pct' ? Math.round(Number(d.pct[b.id] || 0) * 100) : 0,
        })),
      })
    },
    onSuccess: () => {
      setEditing(null); setFormError(null)
      setFeedback('Rule saved')
      void qc.invalidateQueries({ queryKey: ['allocation-rules'] })
    },
    onError: (err: { message?: string }) => setFormError(err.message ?? 'Could not save the rule'),
  })

  const reverseRun = useMutation({
    mutationFn: (v: { id: string; reason: string }) => api.post(`/allocations/runs/${v.id}/reverse`, { reason: v.reason }),
    onSuccess: () => {
      setReversing(null)
      setFeedback('Run reversed — its entry is off the books and the period can be run again')
      void qc.invalidateQueries({ queryKey: ['allocation-runs'] })
    },
    onError: (err: { message?: string }) => setFeedback(err.message ?? 'Reverse failed'),
  })

  const draftTotalPct = editing
    ? (brands ?? []).filter((b) => editing.on[b.id]).reduce((s, b) => s + Number(editing.pct[b.id] || 0), 0)
    : 0

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

        {canRun && !editing && (
          <div className="flex justify-end">
            <button onClick={() => { setEditing(emptyDraft()); setFormError(null) }} className="s-btn-primary text-xs">New rule</button>
          </div>
        )}

        {canRun && editing && (
          <div className="s-card p-4 space-y-3">
            <p className="text-sm font-semibold text-s-text">{rules?.some((r) => r.sourceAccountCode === editing.sourceAccountCode.trim()) ? 'Edit rule' : 'New rule'}</p>
            <p className="text-xs text-s-muted">One rule per expense account: saving a rule for an account that already has one replaces its split. Every save is recorded.</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="text-xs text-s-muted">Name
                <input className="s-input w-full mt-1" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Rent split" />
              </label>
              <label className="text-xs text-s-muted">Expense account code
                <input className="s-input w-full mt-1 font-mono" value={editing.sourceAccountCode} onChange={(e) => setEditing({ ...editing, sourceAccountCode: e.target.value })} placeholder="6010" />
              </label>
              <label className="text-xs text-s-muted">Split by
                <select className="s-input w-full mt-1" value={editing.driver} onChange={(e) => setEditing({ ...editing, driver: e.target.value as Draft['driver'] })}>
                  <option value="fixed_pct">Fixed %</option>
                  <option value="revenue_share">Revenue share</option>
                </select>
              </label>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-s-muted">Brands {editing.driver === 'fixed_pct' && <>(total {draftTotalPct.toFixed(2)}% — must be 100%)</>}</p>
              {(brands ?? []).map((b) => (
                <div key={b.id} className="flex items-center gap-3 text-sm text-s-text">
                  <label className="flex items-center gap-2 flex-1">
                    <input type="checkbox" checked={!!editing.on[b.id]} onChange={(e) => setEditing({ ...editing, on: { ...editing.on, [b.id]: e.target.checked } })} />
                    {b.name}
                  </label>
                  {editing.driver === 'fixed_pct' && editing.on[b.id] && (
                    <input type="number" min={0} max={100} step="0.01" className="s-input w-24 text-right"
                      value={editing.pct[b.id] ?? ''} onChange={(e) => setEditing({ ...editing, pct: { ...editing.pct, [b.id]: e.target.value } })} />
                  )}
                </div>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm text-s-text">
              <input type="checkbox" checked={editing.isActive} onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })} /> Active
            </label>
            {formError && <p className="text-sm text-s-red">{formError}</p>}
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setEditing(null); setFormError(null) }} className="s-btn-ghost text-xs">Cancel</button>
              <button onClick={() => saveRule.mutate(editing)} disabled={saveRule.isPending} className="s-btn-primary text-xs">
                {saveRule.isPending ? 'Saving…' : 'Save rule'}
              </button>
            </div>
          </div>
        )}

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
                  <td className="px-4 py-2 text-right whitespace-nowrap space-x-2">
                    {canRun && <button
                      onClick={() => { setEditing(draftOf(r)); setFormError(null) }}
                      className="s-btn-ghost text-xs"
                    >
                      Edit
                    </button>}
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
                <tr><td colSpan={6} className="px-4 py-3 text-xs text-s-muted">No rules configured yet.</td></tr>
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
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {runs?.map((r) => (
                <tr key={r.id} className="border-t border-s-border">
                  <td className="px-4 py-2 text-xs text-s-muted">{new Date(r.postedAt).toLocaleString()}</td>
                  <td className="px-4 py-2 text-s-text">{r.rule.name} <span className="font-mono text-xs text-s-muted">({r.rule.sourceAccountCode})</span></td>
                  <td className="px-4 py-2 text-xs text-s-text">{pktDay(r.periodStart)} → {pktDay(r.periodEnd)}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.totalAmountCents)}</td>
                  <td className="px-4 py-2 text-right">
                    {r.reversedAt
                      ? <span className="s-badge-muted">reversed</span>
                      : canRun && (reversing?.id === r.id
                        ? <span className="inline-flex items-center gap-2">
                            <input className="s-input text-xs w-48" placeholder="Reason (10+ characters)" value={reversing.reason}
                              onChange={(e) => setReversing({ id: r.id, reason: e.target.value })} />
                            <button className="s-btn-danger text-xs" disabled={reversing.reason.trim().length < 10 || reverseRun.isPending}
                              onClick={() => { setFeedback(null); reverseRun.mutate({ id: r.id, reason: reversing.reason.trim() }) }}>
                              {reverseRun.isPending ? 'Reversing…' : 'Confirm'}
                            </button>
                            <button className="s-btn-ghost text-xs" onClick={() => setReversing(null)}>Cancel</button>
                          </span>
                        : <button className="s-btn-ghost text-xs" onClick={() => setReversing({ id: r.id, reason: '' })}>Reverse</button>)}
                  </td>
                </tr>
              ))}
              {(!runs || runs.length === 0) && (
                <tr><td colSpan={5} className="px-4 py-3 text-xs text-s-muted">No runs yet</td></tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      </div>
    </div>
  )
}
