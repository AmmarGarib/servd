'use client'
// The loyalty switch (owner, 2026-10-22 pause; 2026-11-13: "no sale should book loyalty points until CEO or Finance
// turn it on"). Off = nothing earned, used, expired or revalued, nothing booked to 2060. The CEO or finance (with
// accounting) switches it — PUT /loyalty/pause; read GET /loyalty/pause. Shown on Configuration → Loyalty and on the
// Accounting home.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAuthStore } from '../../store/auth'

export interface LoyaltyPauseView { paused: boolean; reason: string | null; updatedAt: string | null }

export function LoyaltySwitch({ pause: given, onSaved }: { pause?: LoyaltyPauseView; onSaved?: () => void }) {
  const qc = useQueryClient()
  const role = useAuthStore((s) => s.user?.role ?? null)
  const canSwitch = role === 'admin' || role === 'finance'
  const { data } = useQuery({ queryKey: ['loyalty-pause'], queryFn: () => api.get<LoyaltyPauseView>('/loyalty/pause'), enabled: !given && canSwitch, meta: { background: true } })
  const pause = given ?? data
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const flip = useMutation({
    mutationFn: () => api.put('/loyalty/pause', { paused: !pause!.paused, reason }),
    onSuccess: () => { setReason(''); setErr(null); void qc.invalidateQueries({ queryKey: ['loyalty-pause'] }); onSaved?.() },
    onError: (e: Error) => setErr(e.message),
  })
  if (!pause) return null
  return (
    <section className="rounded-2xl border p-6 space-y-3" style={{ borderColor: pause.paused ? 'var(--erp-warning)' : 'var(--border)', background: 'var(--surface)' }}>
      <h2 className="text-lg font-bold">{pause.paused ? 'Loyalty points are off' : 'Loyalty points are on'}</h2>
      <p className="text-sm text-s-muted max-w-2xl">
        {pause.paused
          ? 'No sale earns points, no points are used, nothing expires and the point value is frozen — nothing is booked to the loyalty points account (2060). Customers keep the points they already have.'
          : 'A till bill earns points only when the cashier ticks "Add loyalty points" at settlement; online orders earn as set in Loyalty settings. The loyalty points account (2060) moves with them.'}
        {pause.reason ? ` Reason: ${pause.reason}.` : ''}
      </p>
      {canSwitch ? (
        <div className="flex flex-wrap items-end gap-3">
          <label className="block flex-1 min-w-[240px]">
            <span className="block text-xs font-bold text-s-muted mb-1">Reason (at least 10 characters)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300}
              className="w-full rounded-lg border border-s-border bg-s-surface px-3 py-2 text-sm" />
          </label>
          <button type="button" disabled={reason.trim().length < 10 || flip.isPending} onClick={() => flip.mutate()}
            className="rounded-lg px-4 py-2 text-sm font-black disabled:opacity-50" style={{ background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }}>
            {flip.isPending ? 'Saving…' : pause.paused ? 'Switch loyalty on' : 'Switch loyalty off'}
          </button>
        </div>
      ) : <p className="text-xs text-s-muted">Only the CEO or finance switches loyalty on or off.</p>}
      {err && <p className="text-xs" style={{ color: 'var(--erp-danger)' }}>{err}</p>}
    </section>
  )
}
