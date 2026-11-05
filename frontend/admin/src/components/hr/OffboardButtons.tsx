'use client'
// Offboard / Reinstate a login — HR and the CEO (owner, 2026-10-15). Used on the
// HR employee profile's Login tab and on Workforce rows. The server decides
// (auth/routes.ts /staff/:id/offboard|reinstate); this only hides the buttons
// where they would be refused. HR's offboard waits for the CEO (owner,
// 2026-11-05): POST /offboard answers 202 and the login stays on until the CEO
// approves (approvals inbox, type staff_offboard); a pending request shows here
// with Withdraw (GET /auth/staff/offboard-requests — one shared query for every
// row on the page, never one request per row).
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { usePermissions } from '../../hooks/useCan'
import { useAuthStore } from '../../store/auth'
import { useConfirm } from '@/components/ui/ConfirmDialog'

/** The floor category (server: OTP_LOGIN_ROLES) — HR invites and reinstates them at once. They sign in with email and password like everyone else. */
export const FLOOR_LOGIN_ROLES = ['cashier', 'foh', 'boh', 'kitchen', 'expediter']

const OFFBOARD_PENDING_KEY = ['offboard-requests', 'pending'] as const
interface PendingOffboard { id: string; userId: string; requestedById: string; createdAt: string }

const ghost = 'rounded-md px-2 py-1.5 text-[11px] font-bold border border-s-border text-s-muted hover:text-s-text hover:border-primary/40 disabled:opacity-50'

/** Offboard / Reinstate a login (POST /auth/staff/:id/offboard|reinstate) — HR and the CEO only. Never the CEO's
 *  login, never your own (the server refuses both too). HR's reinstate of a manager or office login waits for the CEO. */
export function OffboardButtons({ login, onDone }: { login: { id: string; name: string; role: string; status?: 'pending' | 'active' | 'suspended' }; onDone: () => void }) {
  const { data: me } = usePermissions()
  const myId = useAuthStore((st) => st.user?.id ?? '')
  const confirm = useConfirm()
  const [msg, setMsg] = useState('')
  const qc = useQueryClient()
  const role = me?.role
  const canOffboard = role === 'hr' || role === 'admin'
  // Every OffboardButtons on the page shares this one query (same key).
  const pendingQ = useQuery({
    queryKey: OFFBOARD_PENDING_KEY,
    queryFn: () => api.get<{ items: PendingOffboard[] }>('/auth/staff/offboard-requests?status=pending'),
    enabled: canOffboard,
    staleTime: 30_000,
  })
  const pending = pendingQ.data?.items?.find((r) => r.userId === login.id) ?? null
  const off = useMutation({
    mutationFn: (reason: string) => api.post<{ pendingApproval?: boolean }>(`/auth/staff/${login.id}/offboard`, { reason }),
    onSuccess: (r) => {
      setMsg(r?.pendingApproval ? 'Sent to the CEO. The login stays on until the CEO approves.' : `${login.name} is offboarded and signed out everywhere.`)
      void qc.invalidateQueries({ queryKey: OFFBOARD_PENDING_KEY })
      onDone()
    },
    onError: (e: Error) => setMsg(e.message),
  })
  const withdraw = useMutation({
    mutationFn: (id: string) => api.post(`/auth/staff/offboard-requests/${id}/withdraw`, {}),
    onSuccess: () => { setMsg('Offboard request withdrawn.'); void qc.invalidateQueries({ queryKey: OFFBOARD_PENDING_KEY }); onDone() },
    onError: (e: Error) => setMsg(e.message),
  })
  const back = useMutation({
    mutationFn: () => api.post<{ status: string; waitsForCeo: boolean }>(`/auth/staff/${login.id}/reinstate`, {}),
    onSuccess: (r) => { setMsg(r?.waitsForCeo ? 'Reinstated — waiting for the CEO to approve it.' : `${login.name} can sign in again.`); onDone() },
    onError: (e: Error) => setMsg(e.message),
  })
  // Password reset link (owner, 2026-10-16): the same one-use, 30-minute link
  // as "Forgot password", sent to the person's own email / WhatsApp
  // (POST /auth/staff/:id/send-password-link). Nobody else sees it.
  const link = useMutation({
    mutationFn: () => api.post<{ email: string; sentBy: { email: boolean; whatsapp: boolean } }>(`/auth/staff/${login.id}/send-password-link`, {}),
    onSuccess: (r) => {
      const where = [r?.sentBy?.email ? r.email : null, r?.sentBy?.whatsapp ? 'WhatsApp' : null].filter(Boolean).join(' and ')
      setMsg(`Reset link sent to ${where || 'them'}. It works once and expires in 30 minutes.`)
    },
    onError: (e: Error) => setMsg(e.message),
  })
  // A new password shown ONCE (owner, 2026-10-16: HR too) — POST
  // /auth/users/:id/reissue-password. The old one stops working and every
  // session ends; they set their own at the next sign-in.
  const [issued, setIssued] = useState<string | null>(null)
  const reissue = useMutation({
    mutationFn: () => api.post<{ temporaryPassword: string }>(`/auth/users/${login.id}/reissue-password`, {}),
    onSuccess: (r) => { setIssued(r?.temporaryPassword ?? null); setMsg('') },
    onError: (e: Error) => setMsg(e.message),
  })
  if (!canOffboard) return null
  if (login.role === 'admin' || login.id === myId) return null
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {login.status !== 'suspended' && login.status !== 'pending' && (role === 'admin' || login.role !== 'owner') && (
          <button type="button" className={ghost} disabled={link.isPending} onClick={async () => {
            const r = await confirm({
              title: `Send ${login.name} a password reset link?`,
              body: 'A link to set a new password goes to their own email (and WhatsApp if they have a number). It works once and expires in 30 minutes. Their current password keeps working until they use it.',
              confirmLabel: 'Send link',
            })
            if (r) link.mutate()
          }}>{link.isPending ? 'Sending…' : 'Send password reset link'}</button>
        )}
        {login.status !== 'suspended' && login.status !== 'pending' && (role === 'admin' || login.role !== 'owner') && (
          <button type="button" className={ghost} disabled={reissue.isPending} onClick={async () => {
            const r = await confirm({
              title: `Issue a new password for ${login.name}?`,
              body: 'Their current password stops working now and they are signed out everywhere. You will see the new one once — give it to them in person; they set their own at the next sign-in.',
              confirmLabel: 'Issue new password', danger: true,
            })
            if (r) reissue.mutate()
          }}>{reissue.isPending ? 'Issuing…' : 'New password'}</button>
        )}
        {login.status !== 'suspended' && pending && (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold text-s-muted">
              Offboard waiting for the CEO — requested {new Date(pending.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
            </span>
            {(role === 'admin' || pending.requestedById === myId) && (
              <button type="button" className={ghost} disabled={withdraw.isPending} onClick={async () => {
                const r = await confirm({ title: `Withdraw the offboard request for ${login.name}?`, body: 'The login stays on and the CEO no longer sees the request.', confirmLabel: 'Withdraw' })
                if (r) withdraw.mutate(pending.id)
              }}>{withdraw.isPending ? 'Withdrawing…' : 'Withdraw'}</button>
            )}
          </span>
        )}
        {login.status !== 'suspended' && pending && role !== 'admin' ? null : login.status !== 'suspended' ? (
          <button type="button" className={ghost} disabled={off.isPending} onClick={async () => {
            const r = await confirm(role === 'admin' ? {
              title: `Offboard ${login.name}?`,
              body: 'Their login is switched off and every session ends now. Pay is not affected — record a separation in HR for that.',
              confirmLabel: 'Offboard', danger: true, reason: { label: 'Reason', minLength: 10 },
            } : {
              title: `Request offboarding of ${login.name}?`,
              body: 'The CEO approves it. Until then their login stays on; once approved it is switched off and every session ends. Pay is not affected — record a separation in HR for that.',
              confirmLabel: 'Send to the CEO', danger: true, reason: { label: 'Reason (at least 10 characters)', minLength: 10 },
            })
            if (r && r.reason) off.mutate(r.reason)
          }}>{role === 'admin' ? 'Offboard' : 'Request offboarding (CEO approves)'}</button>
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
      {issued && (
        <div className="mt-2 rounded-lg border border-accent/60 bg-accent-dim p-3">
          <p className="text-[10px] uppercase tracking-wider text-success mb-1">New password for {login.name} — shown once</p>
          <p className="font-mono text-sm font-bold text-success break-all select-all mb-2">{issued}</p>
          <div className="flex gap-2">
            <button type="button" className={ghost} onClick={() => { void navigator.clipboard?.writeText(issued).catch(() => undefined) }}>Copy</button>
            <button type="button" className={ghost} onClick={() => setIssued(null)}>Done</button>
          </div>
        </div>
      )}
      {msg && <p className="text-xs text-white/60 mt-2">{msg}</p>}
    </div>
  )
}

