'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { formatDistanceToNowStrict } from 'date-fns'
import { api } from '../../../lib/api'

interface Violation {
  id: string
  staffId: string
  type: string
  description: string
  detectedAt: string
  resolvedAt: string | null
  resolvedBy: string | null
  staff: { id: string; fullName: string; kitchenRole: string }
}

const TYPE_LABELS: Record<string, string> = {
  below_min_wage:     'Below Min Wage',
  ot_week_exceeded:   'OT Week Exceeded',
  ot_ytd_exceeded:    'OT Yearly Exceeded',
  no_weekly_off:      'No Weekly Off',
  shift_too_long:     'Shift Too Long',
  insufficient_breaks:'Insufficient Breaks',
  consecutive_days:   'Consecutive Days',
}

const TYPE_COLOR: Record<string, string> = {
  below_min_wage:     's-badge-red',
  ot_week_exceeded:   's-badge-amber',
  ot_ytd_exceeded:    's-badge-red',
  no_weekly_off:      's-badge-amber',
  shift_too_long:     's-badge-amber',
  insufficient_breaks:'s-badge-amber',
  consecutive_days:   's-badge-amber',
}

const ROLE_LABELS: Record<string, string> = {
  head_chef: 'Head Chef', sous_chef: 'Sous Chef', cdp: 'CDP', demi_chef: 'Demi Chef',
  commis: 'Commis', kitchen_helper: 'Helper', dishwasher: 'Dishwasher',
  baker: 'Baker', tandoor_grill_cook: 'Tandoor/Grill',
}

export default function CompliancePage() {
  const qc = useQueryClient()
  const [resolved, setResolved] = useState<'all' | 'open' | 'resolved'>('all')
  const [typeFilter, setTypeFilter] = useState('all')

  const resolvedParam = resolved === 'open' ? 'false' : resolved === 'resolved' ? 'true' : undefined
  const { data: violations = [], isLoading } = useQuery<Violation[]>({
    queryKey: ['kitchen-compliance', resolved],
    queryFn: () => api.get<Violation[]>(`/kitchen-staff/compliance${resolvedParam ? `?resolved=${resolvedParam}` : ''}`),
  })

  const resolve = useMutation({
    mutationFn: (id: string) => api.patch(`/kitchen-staff/compliance/${id}/resolve`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['kitchen-compliance'] }),
  })

  const allTypes = Array.from(new Set(violations.map((v) => v.type)))
  const filtered = typeFilter === 'all' ? violations : violations.filter((v) => v.type === typeFilter)

  const openCount = violations.filter((v) => !v.resolvedAt).length
  const resolvedCount = violations.filter((v) => v.resolvedAt).length
  const typeCounts = violations.reduce<Record<string, number>>((acc, v) => {
    acc[v.type] = (acc[v.type] ?? 0) + 1
    return acc
  }, {})
  const mostCommon = Object.entries(typeCounts).sort(([, a], [, b]) => b - a)[0]

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <Link href="/kitchen-staff" className="text-xs text-s-muted hover:text-s-text">← Kitchen Staff</Link>
            <h1 className="text-xl font-bold text-s-text mt-0.5">Labour Compliance Log</h1>
            <p className="text-xs text-s-muted mt-0.5">Sindh Labour Law — 48h/week limit, 2× OT, min wages FY 2025-26</p>
          </div>
        </div>
      </header>

      <div className="px-6 py-6 space-y-6">
        {/* Summary cards */}
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-2xl border border-s-border bg-s-card p-4">
            <p className="text-xs text-s-muted uppercase tracking-wider mb-1">Total Violations</p>
            <p className="text-3xl font-black text-s-text">{violations.length}</p>
          </div>
          <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-4">
            <p className="text-xs text-red-400 uppercase tracking-wider mb-1">Open</p>
            <p className="text-3xl font-black text-red-400">{openCount}</p>
          </div>
          <div className="rounded-2xl border border-s-border bg-s-card p-4">
            <p className="text-xs text-s-muted uppercase tracking-wider mb-1">Most Common</p>
            <p className="text-lg font-bold text-s-text">
              {mostCommon ? (TYPE_LABELS[mostCommon[0]] ?? mostCommon[0]) : '—'}
            </p>
            {mostCommon && <p className="text-xs text-s-muted">{mostCommon[1]} occurrences</p>}
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex rounded-xl border border-s-border overflow-hidden text-sm">
            {(['all', 'open', 'resolved'] as const).map((f) => (
              <button key={f} onClick={() => setResolved(f)}
                className={`px-4 py-2 capitalize transition-colors ${resolved === f ? 'bg-s-teal/20 text-s-teal font-semibold' : 'text-s-muted hover:text-s-text'}`}>
                {f} {f === 'open' ? `(${openCount})` : f === 'resolved' ? `(${resolvedCount})` : `(${violations.length})`}
              </button>
            ))}
          </div>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
            className="s-input text-sm px-3 py-2 rounded-xl">
            <option value="all">All types</option>
            {allTypes.map((t) => (
              <option key={t} value={t}>{TYPE_LABELS[t] ?? t}</option>
            ))}
          </select>
        </div>

        {/* Table */}
        {isLoading && <p className="text-s-muted text-sm">Loading…</p>}

        {!isLoading && filtered.length === 0 && (
          <div className="rounded-2xl border border-s-border p-10 text-center">
            <p className="text-3xl mb-3">✅</p>
            <p className="text-s-text font-semibold mb-1">No violations found</p>
            <p className="text-s-muted text-sm">Kitchen is compliant with the current filter.</p>
          </div>
        )}

        {filtered.length > 0 && (
          <div className="rounded-2xl border border-s-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-s-border bg-s-card/50">
                  <th className="text-left px-4 py-3 text-s-muted font-semibold text-xs uppercase tracking-wide">Staff</th>
                  <th className="text-left px-4 py-3 text-s-muted font-semibold text-xs uppercase tracking-wide">Violation</th>
                  <th className="text-left px-4 py-3 text-s-muted font-semibold text-xs uppercase tracking-wide">Description</th>
                  <th className="text-left px-4 py-3 text-s-muted font-semibold text-xs uppercase tracking-wide">Detected</th>
                  <th className="text-left px-4 py-3 text-s-muted font-semibold text-xs uppercase tracking-wide">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-s-border">
                {filtered.map((v) => (
                  <tr key={v.id} className={`hover:bg-s-card/30 transition-colors ${!v.resolvedAt ? 'bg-red-500/3' : ''}`}>
                    <td className="px-4 py-3">
                      <Link href={`/kitchen-staff/${v.staff.id}`} className="font-semibold text-s-text hover:text-s-teal transition-colors">
                        {v.staff.fullName}
                      </Link>
                      <p className="text-xs text-s-muted">{ROLE_LABELS[v.staff.kitchenRole] ?? v.staff.kitchenRole}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={TYPE_COLOR[v.type] ?? 's-badge-muted'}>
                        {TYPE_LABELS[v.type] ?? v.type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-s-muted max-w-xs">
                      <p className="text-xs leading-relaxed">{v.description}</p>
                    </td>
                    <td className="px-4 py-3 text-s-muted text-xs whitespace-nowrap">
                      {formatDistanceToNowStrict(new Date(v.detectedAt), { addSuffix: true })}
                    </td>
                    <td className="px-4 py-3">
                      {v.resolvedAt ? (
                        <div>
                          <span className="s-badge-teal">Resolved</span>
                          {v.resolvedBy && <p className="text-xs text-s-muted mt-0.5">by {v.resolvedBy}</p>}
                        </div>
                      ) : (
                        <span className="s-badge-red">Open</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {!v.resolvedAt && (
                        <button onClick={() => resolve.mutate(v.id)} disabled={resolve.isPending}
                          className="text-xs text-s-teal hover:underline disabled:opacity-50 transition-colors">
                          Resolve
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
