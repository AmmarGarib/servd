'use client'
// Staff meal log — read-only. A staff meal is rung up at the till and comped
// as a staff meal with a manager PIN (POST /pos/orders/:orderId/comp with
// staffMealFor, owner decision 11): that takes the stock out and books the
// food cost. The comp writes the row this log lists, and cumulative weekly
// consumption over the cap flags for review. The old hand-typed "Log meal"
// form posted to a retired endpoint (410) and is gone.
//
// Who reads it: the manager tiers and HR (GET /trustops/staff-meals). Each row
// carries the staff member's name, so the page does not need the staff-account
// list.

import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'

interface Meal { id: string; staffId: string; staffName?: string | null; description: string; estimatedCostCents: number; reason: string; consumedAt: string }

export default function StaffMealsPage() {
  const { data: meals = [] } = useQuery<Meal[]>({ queryKey: ['staff-meals'], queryFn: () => api.get('/trustops/staff-meals?days=30'), refetchInterval: 30_000 })

  // Group by staff for the leaderboard
  const byStaff = meals.reduce<Record<string, { count: number; cents: number; name: string }>>((acc, m) => {
    if (!m.staffName) return acc
    const cur = acc[m.staffId] ?? { count: 0, cents: 0, name: m.staffName }
    cur.count += 1; cur.cents += m.estimatedCostCents
    acc[m.staffId] = cur
    return acc
  }, {})
  const leaderboard = Object.entries(byStaff).sort((a, b) => b[1].cents - a[1].cents)

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-white/90">Staff meals</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Free / staff-rate meals consumed by employees. A staff meal is rung up at the till and comped as a staff meal with a manager PIN — it shows here. Cumulative weekly spend over the cap per person flags for review.
            </p>
          </div>
        </div>
      </header>

      <div className="px-7 py-6 max-w-5xl mx-auto space-y-6">
        {leaderboard.length > 0 && (
          <section>
            <h2 className="text-xs font-black uppercase tracking-[0.24em] text-white/55 mb-3">30-day consumption · top 5</h2>
            <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
              {leaderboard.slice(0, 5).map(([uid, s]) => (
                <div key={uid} className="rounded-lg p-3" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                  <p className="text-xs text-white/50">{s.name}</p>
                  <p className="text-lg font-black text-white/90">PKR {(s.cents / 100).toLocaleString()}</p>
                  <p className="text-[10px] text-white/40">{s.count} meals</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <h2 className="text-xs font-black uppercase tracking-[0.24em] text-white/55 mb-3">Recent · {meals.length}</h2>
          {meals.length === 0 && <p className="text-sm text-white/45 italic">None logged in the last 30 days.</p>}
          <div className="space-y-2">
            {meals.map((m) => (
              <div key={m.id} className="rounded-2xl p-4" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-bold text-white/85">{m.staffName ?? '—'}</p>
                      <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: 'rgb(var(--ink-rgb) / 0.12)', color: 'var(--erp-primary-ink)' }}>{m.reason.replace('_', ' ')}</span>
                    </div>
                    <p className="text-xs text-white/55 mt-1">{m.description}</p>
                    <p className="text-[11px] text-white/35 mt-1">{new Date(m.consumedAt).toLocaleString()}</p>
                  </div>
                  <span className="text-sm font-bold text-s-amber">PKR {(m.estimatedCostCents / 100).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

    </div>
  )
}

