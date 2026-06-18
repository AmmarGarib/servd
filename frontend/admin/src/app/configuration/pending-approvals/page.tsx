'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { usePermissions } from '../../../hooks/useCan'

interface PendingStaff {
  id: string
  name: string
  email: string
  phone: string | null
  role: string
  signupReason: string | null
  createdAt: string
}

const ROLE_META: Record<string, { emoji: string; label: string }> = {
  manager:   { emoji: '🧑‍💼', label: 'Manager' },
  cashier:   { emoji: '💳',  label: 'Cashier' },
  kitchen:   { emoji: '🍳',  label: 'Kitchen' },
  expediter: { emoji: '🪧',  label: 'Expediter' },
  marketing: { emoji: '🚀',  label: 'Marketing' },
  admin:     { emoji: '👑',  label: 'Admin / CEO' },
}

/**
 * CEO-only review queue. Lists everyone who self-signed-up via the login page
 * with status='pending'. Each row shows the derived PIN (last 4 of phone) so
 * the CEO has the same info the new hire saw on the signup confirmation
 * screen — useful for printing a welcome card.
 */
export default function PendingApprovalsPage() {
  const qc = useQueryClient()
  const { data: me } = usePermissions()
  const isSuper = me?.role === 'admin'

  const { data: pending = [], isLoading } = useQuery<PendingStaff[]>({
    queryKey: ['staff', 'pending'],
    queryFn:  () => api.get<PendingStaff[]>('/auth/staff/pending'),
    enabled:  isSuper,
    refetchInterval: 30_000,
  })

  const approve = useMutation({
    mutationFn: (id: string) => api.patch(`/auth/staff/${id}/approve`, {}),
    onSuccess:  () => void qc.invalidateQueries({ queryKey: ['staff'] }),
  })
  const reject = useMutation({
    mutationFn: (id: string) => api.patch(`/auth/staff/${id}/reject`, {}),
    onSuccess:  () => void qc.invalidateQueries({ queryKey: ['staff'] }),
  })

  const [confirming, setConfirming] = useState<{ id: string; action: 'approve' | 'reject' } | null>(null)

  function pinFor(phone: string | null) {
    if (!phone) return '—'
    return phone.replace(/\D/g, '').slice(-4) || '—'
  }

  if (!isSuper) {
    return (
      <div className="min-h-screen p-7" style={{ background: '#090a0e' }}>
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <div className="mt-8 max-w-md mx-auto rounded-2xl p-8 text-center"
          style={{ background: 'rgba(255,77,79,0.05)', border: '1px solid rgba(255,77,79,0.2)' }}>
          <p className="text-3xl mb-3">🔒</p>
          <p className="font-bold text-white/85">CEO only</p>
          <p className="text-sm text-white/45 mt-1">Approving staff is a superuser action.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70 mb-2 inline-block">← Configuration Hub</Link>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-black text-white/90">⏳ Pending Approvals</h1>
            <p className="text-sm text-white/40 mt-1">
              New staff who&rsquo;ve signed up via the login page. Approve to activate their PIN, reject to block.
            </p>
          </div>
          <div className="rounded-2xl px-4 py-2.5 text-center"
            style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}>
            <p className="text-[10px] uppercase tracking-wider font-black text-amber-400">Waiting</p>
            <p className="text-2xl font-black text-amber-400 leading-none mt-0.5">{pending.length}</p>
          </div>
        </div>
      </header>

      <div className="px-7 py-6 max-w-[1100px] mx-auto space-y-3">
        {isLoading && <p className="text-sm text-white/40">Loading…</p>}

        {!isLoading && pending.length === 0 && (
          <div className="rounded-2xl p-12 text-center"
            style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <p className="text-4xl mb-2">✓</p>
            <p className="text-sm font-bold text-white/75">No one waiting</p>
            <p className="text-xs text-white/40 mt-1">New signups land here automatically.</p>
          </div>
        )}

        {pending.map((p) => {
          const meta = ROLE_META[p.role] ?? { emoji: '?', label: p.role }
          const pin = pinFor(p.phone)
          const isConfirmingThis = confirming?.id === p.id
          return (
            <div key={p.id} className="rounded-2xl p-5 flex items-center gap-5 flex-wrap"
              style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>

              <div className="h-12 w-12 shrink-0 rounded-full flex items-center justify-center text-lg font-black"
                style={{ background: 'linear-gradient(135deg, #00D4B1, #6366F1)', color: '#000' }}>
                {p.name.slice(0, 1).toUpperCase()}
              </div>

              <div className="flex-1 min-w-[200px]">
                <p className="font-bold text-white/90">{p.name}</p>
                <p className="text-xs text-white/45">{p.email}</p>
                <p className="text-xs text-white/45 mt-0.5">{p.phone ?? 'No phone on file'}</p>
                {p.signupReason && (
                  <p className="text-[11px] text-white/50 mt-1.5 italic leading-snug">&ldquo;{p.signupReason}&rdquo;</p>
                )}
              </div>

              <div className="text-center px-4 py-2 rounded-xl"
                style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)' }}>
                <p className="text-[10px] uppercase tracking-wider font-black text-indigo-300">Role</p>
                <p className="text-sm font-bold text-white/85 mt-0.5">{meta.emoji} {meta.label}</p>
              </div>

              <div className="text-center px-4 py-2 rounded-xl"
                style={{ background: 'rgba(0,212,177,0.06)', border: '1px solid rgba(0,212,177,0.2)' }}>
                <p className="text-[10px] uppercase tracking-wider font-black" style={{ color: '#00D4B1' }}>PIN</p>
                <p className="text-base font-black tracking-[0.3em] text-white/90 mt-0.5">{pin}</p>
              </div>

              {!isConfirmingThis ? (
                <div className="flex gap-2">
                  <button onClick={() => setConfirming({ id: p.id, action: 'reject' })}
                    disabled={reject.isPending}
                    className="rounded-xl px-4 py-2.5 text-xs font-bold transition-colors disabled:opacity-40"
                    style={{ background: 'rgba(255,77,79,0.08)', color: '#FF7B7D', border: '1px solid rgba(255,77,79,0.2)' }}>
                    Reject
                  </button>
                  <button onClick={() => setConfirming({ id: p.id, action: 'approve' })}
                    disabled={approve.isPending}
                    className="rounded-xl px-4 py-2.5 text-xs font-black transition-all disabled:opacity-40"
                    style={{ background: 'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)', color: '#000' }}>
                    Approve ✓
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-white/55 mr-1">
                    {confirming.action === 'approve' ? 'Activate this account?' : 'Reject permanently?'}
                  </span>
                  <button onClick={() => setConfirming(null)}
                    className="rounded-md px-3 py-1.5 text-[11px] font-bold text-white/55 hover:text-white/85">
                    Cancel
                  </button>
                  <button onClick={() => {
                    if (confirming.action === 'approve') approve.mutate(p.id)
                    else reject.mutate(p.id)
                    setConfirming(null)
                  }}
                    className="rounded-md px-3 py-1.5 text-[11px] font-black"
                    style={confirming.action === 'approve'
                      ? { background: '#00D4B1', color: '#000' }
                      : { background: '#FF4D4F', color: '#fff' }}>
                    Yes, {confirming.action}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
