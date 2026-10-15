'use client'
// Offboard / Reinstate a login — HR and the CEO (owner, 2026-10-15). Used on the
// HR employee profile's Login tab and on Workforce rows. The server decides
// (auth/routes.ts /staff/:id/offboard|reinstate); this only hides the buttons
// where they would be refused.
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { usePermissions } from '../../hooks/useCan'
import { useAuthStore } from '../../store/auth'
import { useConfirm } from '@/components/ui/ConfirmDialog'

/** Roles that sign in with a code (server: OTP_LOGIN_ROLES) — HR brings them back at once. */
export const FLOOR_LOGIN_ROLES = ['cashier', 'foh', 'boh', 'kitchen', 'expediter']

const ghost = 'rounded-md px-2 py-1.5 text-[11px] font-bold border border-s-border text-s-muted hover:text-s-text hover:border-primary/40 disabled:opacity-50'

/** Offboard / Reinstate a login (POST /auth/staff/:id/offboard|reinstate) — HR and the CEO only. Never the CEO's
 *  login, never your own (the server refuses both too). HR's reinstate of a manager or office login waits for the CEO. */
export function OffboardButtons({ login, onDone }: { login: { id: string; name: string; role: string; status?: 'pending' | 'active' | 'suspended' }; onDone: () => void }) {
  const { data: me } = usePermissions()
  const myId = useAuthStore((st) => st.user?.id ?? '')
  const confirm = useConfirm()
  const [msg, setMsg] = useState('')
  const off = useMutation({
    mutationFn: (reason: string) => api.post(`/auth/staff/${login.id}/offboard`, { reason }),
    onSuccess: () => { setMsg(`${login.name} is offboarded and signed out everywhere.`); onDone() },
    onError: (e: Error) => setMsg(e.message),
  })
  const back = useMutation({
    mutationFn: () => api.post<{ status: string; waitsForCeo: boolean }>(`/auth/staff/${login.id}/reinstate`, {}),
    onSuccess: (r) => { setMsg(r?.waitsForCeo ? 'Reinstated — waiting for the CEO to approve it.' : `${login.name} can sign in again.`); onDone() },
    onError: (e: Error) => setMsg(e.message),
  })
  const role = me?.role
  if (role !== 'hr' && role !== 'admin') return null
  if (login.role === 'admin' || login.id === myId) return null
  return (
    <div>
      <div className="flex gap-2">
        {login.status !== 'suspended' ? (
          <button type="button" className={ghost} disabled={off.isPending} onClick={async () => {
            const r = await confirm({
              title: `Offboard ${login.name}?`,
              body: 'Their login is switched off and every session ends now. Pay is not affected — record a separation in HR for that.',
              confirmLabel: 'Offboard', danger: true, reason: { label: 'Reason', minLength: 3 },
            })
            if (r && r.reason) off.mutate(r.reason)
          }}>Offboard</button>
        ) : (
          <button type="button" className={ghost} disabled={back.isPending} onClick={async () => {
            const r = await confirm({
              title: `Reinstate ${login.name}?`,
              body: role === 'admin' || FLOOR_LOGIN_ROLES.includes(login.role)
                ? 'They can sign in again at once.'
                : 'A manager or office login goes back to the CEO for approval before they can sign in.',
              confirmLabel: 'Reinstate',
            })
            if (r) back.mutate()
          }}>Reinstate</button>
        )}
      </div>
      {msg && <p className="text-xs text-white/60 mt-2">{msg}</p>}
    </div>
  )
}

