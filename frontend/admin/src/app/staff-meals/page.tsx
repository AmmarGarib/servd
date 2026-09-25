'use client'
// Staff meal log — every free or staff-rate meal needs manager-PIN approval +
// is tracked here. Cumulative consumption per staff over 7 days flags above
// PKR 2,000.

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../lib/api'

interface User { id: string; name: string; role: string }
interface Meal { id: string; staffId: string; description: string; estimatedCostCents: number; reason: string; consumedAt: string }

export default function StaffMealsPage() {
  const qc = useQueryClient()
  const { data: meals = [] } = useQuery<Meal[]>({ queryKey: ['staff-meals'], queryFn: () => api.get('/trustops/staff-meals?days=30'), refetchInterval: 30_000 })
  const { data: users = [] } = useQuery<User[]>({ queryKey: ['users'], queryFn: () => api.get('/auth/users') })
  const [adding, setAdding] = useState(false)

  const userMap = new Map(users.map((u) => [u.id, u]))

  // Group by staff for the leaderboard
  const byStaff = meals.reduce<Record<string, { count: number; cents: number; name: string }>>((acc, m) => {
    const u = userMap.get(m.staffId)
    if (!u) return acc
    const cur = acc[m.staffId] ?? { count: 0, cents: 0, name: u.name }
    cur.count += 1; cur.cents += m.estimatedCostCents
    acc[m.staffId] = cur
    return acc
  }, {})
  const leaderboard = Object.entries(byStaff).sort((a, b) => b[1].cents - a[1].cents)

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-white/90">🍽 Staff meals</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Free / staff-rate meals consumed by employees. Manager PIN required to log. Cumulative weekly spend over PKR 2,000 per person flags for review.
            </p>
          </div>
          <button onClick={() => setAdding(true)} className="rounded-xl bg-kds-green px-4 py-2.5 text-sm font-black text-black hover:opacity-90">+ Log meal</button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-5xl mx-auto space-y-6">
        {leaderboard.length > 0 && (
          <section>
            <h2 className="text-xs font-black uppercase tracking-[0.24em] text-white/55 mb-3">30-day consumption · top 5</h2>
            <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
              {leaderboard.slice(0, 5).map(([uid, s]) => (
                <div key={uid} className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
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
              <div key={m.id} className="rounded-2xl p-4" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-bold text-white/85">{userMap.get(m.staffId)?.name ?? '—'}</p>
                      <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: 'rgba(99,102,241,0.12)', color: '#A5B4FC' }}>{m.reason.replace('_', ' ')}</span>
                    </div>
                    <p className="text-xs text-white/55 mt-1">{m.description}</p>
                    <p className="text-[11px] text-white/35 mt-1">{new Date(m.consumedAt).toLocaleString()}</p>
                  </div>
                  <span className="text-sm font-bold text-amber-400">PKR {(m.estimatedCostCents / 100).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {adding && <MealModal users={users} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); qc.invalidateQueries({ queryKey: ['staff-meals'] }); qc.invalidateQueries({ queryKey: ['exceptions'] }) }} />}
    </div>
  )
}

function MealModal({ users, onClose, onSaved }: { users: User[]; onClose: () => void; onSaved: () => void }) {
  const [staffId, setStaffId] = useState('')
  const [description, setDescription] = useState('')
  const [estimatedCostCents, setEstimatedCostCents] = useState(50000)
  // No 'comp' here: comping a customer's order is the till's comp (reason,
  // caps, manager PIN, on the drawer). Older 'comp' rows still list below.
  const [reason, setReason] = useState<'shift_meal' | 'training' | 'tasting'>('shift_meal')
  const [managerPin, setManagerPin] = useState('')

  const save = useMutation({
    mutationFn: () => api.post('/trustops/staff-meals', { staffId, description, estimatedCostCents, reason, managerPin }),
    onSuccess: () => onSaved(),
  })

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
    <div className="w-full max-w-md rounded-2xl overflow-hidden" style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
        <h2 className="font-black text-white/90">Log a staff meal</h2>
        <button onClick={onClose} className="text-white/40 text-xl">✕</button>
      </div>
      <div className="p-5 space-y-3">
        <Field label="Staff member *">
          <select value={staffId} onChange={(e) => setStaffId(e.target.value)} className={fieldCls} autoFocus>
            <option value="">— pick —</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
          </select>
        </Field>
        <Field label="Description *"><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Smash burger + fries" className={fieldCls} /></Field>
        <Field label="Estimated cost (paisa)">
          <input type="number" value={estimatedCostCents} onChange={(e) => setEstimatedCostCents(parseInt(e.target.value) || 0)} className={fieldCls} />
          <p className="text-[10px] text-white/30 mt-1">≈ PKR {(estimatedCostCents / 100).toLocaleString()}</p>
        </Field>
        <Field label="Reason">
          <select value={reason} onChange={(e) => setReason(e.target.value as typeof reason)} className={fieldCls}>
            <option value="shift_meal">Shift meal</option>
            <option value="training">Training</option>
            <option value="tasting">Tasting</option>
          </select>
        </Field>
        <Field label="Manager PIN *">
          <input type="password" value={managerPin} onChange={(e) => setManagerPin(e.target.value)} placeholder="Required" className={fieldCls} />
        </Field>
        {save.error && <div className="rounded-xl px-4 py-3 text-sm text-red-400" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>{(save.error as Error).message}</div>}
      </div>
      <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
        <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
        <button onClick={() => save.mutate()} disabled={save.isPending || !staffId || !description.trim() || !managerPin} className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50">{save.isPending ? 'Logging…' : 'Log meal'}</button>
      </div>
    </div>
  </div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div> }
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-kds-green focus:outline-none"
