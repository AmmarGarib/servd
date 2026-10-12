'use client'
// My team — the reporting tree under me (from HR), who is in today, and adding
// a login for someone on it (decision 47).
//
// The tree is GET /hr/team (HR is the person master). Adding a login is
// POST /auth/staff/invite: the role picker offers only the roles this user may
// add (GET /permissions/me → childRoles), the account is created PENDING in
// the active company, and the CEO approves every one on /workforce.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { usePermissions } from '../../hooks/useCan'
import { useTeam, treeOrder, isInToday, TODAY_META } from '../../hooks/useTeam'
import { roleLabel } from '../../lib/appRoles'

interface Invite {
  id: string
  name: string
  email: string
  role: string
  status: 'pending' | 'active' | 'suspended'
  createdAt: string
}

const card = { background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.07)' }
const input = 'w-full rounded-lg px-3 py-2 text-sm bg-s-surface border border-white/10 text-white/85 focus:outline-none focus:border-primary/60'

// Roles that sign in with a code sent to their phone instead of a password —
// the server's OTP_LOGIN_ROLES (auth/middleware.ts). A login in one of these
// needs a mobile number; the API refuses one without (PHONE_REQUIRED).
const CODE_LOGIN_ROLES = new Set(['cashier', 'foh', 'boh', 'kitchen', 'expediter'])

const INVITE_STATUS: Record<Invite['status'], { label: string; color: string }> = {
  pending:   { label: 'Waiting for the CEO', color: '#a15c00' },
  active:    { label: 'Approved',            color: '#3f7d20' },
  suspended: { label: 'Rejected / off',      color: '#b42318' },
}

export default function MyTeamPage() {
  const { data: me } = usePermissions()
  const { data, isLoading } = useTeam()
  const rows = useMemo(() => treeOrder(data?.me?.id ?? null, data?.team ?? []), [data])
  const canOpenHr = me?.role === 'admin' || (me?.modules ?? []).includes('staff_hr')
  const childRoles = me?.childRoles ?? []
  const isCeo = me?.role === 'admin'
  const inToday = (data?.team ?? []).filter(isInToday).length
  const pending = data?.pendingApprovals ?? 0

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <header>
          <p className="text-[11px] font-bold uppercase tracking-wider text-white/35">Me</p>
          <h1 className="text-3xl font-black text-white/90">My team</h1>
          <p className="text-sm text-white/45 mt-1">Everyone who reports to you, directly or through someone else, and how today looks.</p>
        </header>

        {data?.me && (
          <div className="grid grid-cols-3 gap-3 max-w-xl">
            <Stat label="People" value={data.team.length} />
            <Stat label="In today" value={inToday} color="#3f7d20" />
            <Link href="/ceo/approvals?type=hr_request"><Stat label="Waiting on you" value={pending} color={pending > 0 ? '#a15c00' : undefined} /></Link>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-5">
          <section className="lg:col-span-3 rounded-2xl overflow-hidden" style={card}>
            <p className="px-4 pt-4 pb-2 text-sm font-black text-white/85">Reporting tree</p>
            {isLoading && <p className="px-4 pb-4 text-sm text-white/40">Loading…</p>}
            {!isLoading && !data?.me && (
              <p className="px-4 pb-4 text-xs text-white/40">
                Your login isn&rsquo;t linked to an employee record, so no team is shown. HR can link it from the employee&rsquo;s profile.
              </p>
            )}
            {data?.me && rows.length === 0 && <p className="px-4 pb-4 text-xs text-white/40">Nobody reports to you.</p>}
            {rows.map((m) => {
              const today = m.todayStatus ? TODAY_META[m.todayStatus] : null
              return (
                <div key={m.id} className="flex items-center gap-3 px-4 py-2 border-t border-white/[0.05]">
                  <div className="flex items-center min-w-0 flex-1" style={{ paddingLeft: m.level * 18 }}>
                    {m.level > 0 && <span className="text-[10px] text-white/25 mr-1.5">└</span>}
                    {canOpenHr ? (
                      <Link href={`/hr/employees/${m.id}`} className="text-sm font-semibold text-white/85 hover:text-primary-ink truncate">{m.fullName}</Link>
                    ) : (
                      <span className="text-sm font-semibold text-white/85 truncate">{m.fullName}</span>
                    )}
                    <span className="ml-2 text-[11px] text-white/30 shrink-0">{m.employeeCode}</span>
                    {m.userId && <span className="ml-2 text-[9px] font-bold uppercase tracking-wider px-1 rounded shrink-0"
                      style={{ background: 'rgb(61 31 59 / 0.15)', color: '#6b2f68' }}>login</span>}
                  </div>
                  <span className="text-[11px] font-bold shrink-0" style={{ color: today?.color ?? 'rgb(var(--fg-rgb) / 0.3)' }}>
                    {today?.label ?? '—'}
                  </span>
                </div>
              )
            })}
            {data?.me && rows.length > 0 && !canOpenHr && (
              <p className="px-4 py-3 border-t border-white/[0.05] text-[11px] text-white/35">HR records are opened by HR; requests from your team reach you under My approvals.</p>
            )}
          </section>

          <div className="lg:col-span-2 space-y-5">
            {isCeo ? (
              <section className="rounded-2xl p-4" style={card}>
                <p className="text-sm font-black text-white/85">Add a login</p>
                <p className="text-xs text-white/45 mt-1">As CEO you add logins directly, with no approval step, from <Link href="/workforce" className="text-primary-ink hover:underline">Workforce</Link>.</p>
              </section>
            ) : childRoles.length > 0 ? (
              <AddLoginForm childRoles={childRoles} employees={rows.filter((r) => !r.userId)} />
            ) : (
              <section className="rounded-2xl p-4" style={card}>
                <p className="text-sm font-black text-white/85">Add a login</p>
                <p className="text-xs text-white/45 mt-1">Your role can&rsquo;t add logins. Ask your manager or the CEO.</p>
              </section>
            )}
            {!isCeo && childRoles.length > 0 && <MyInvites />}
          </div>
        </div>
      </div>
    </div>
  )
}

function AddLoginForm({ childRoles, employees }: { childRoles: string[]; employees: Array<{ id: string; fullName: string; employeeCode: string }> }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [role, setRole] = useState(childRoles[0] ?? '')
  const [employeeId, setEmployeeId] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const needsPhone = CODE_LOGIN_ROLES.has(role)

  const invite = useMutation({
    mutationFn: () => api.post('/auth/staff/invite', {
      name: name.trim(),
      email: email.trim().toLowerCase(),
      ...(phone.trim() ? { phone: phone.trim() } : {}),
      role,
      ...(employeeId ? { employeeId } : {}),
    }),
    onSuccess: () => {
      setDone(`${name.trim()} is waiting for the CEO's approval.`)
      setName(''); setEmail(''); setPhone(''); setEmployeeId('')
      void qc.invalidateQueries({ queryKey: ['staff', 'invites'] })
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : 'Could not add the login'),
  })

  function pickEmployee(id: string) {
    setEmployeeId(id)
    const emp = employees.find((e) => e.id === id)
    if (emp && !name.trim()) setName(emp.fullName)
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null); setDone(null)
    if (!name.trim()) return setErr('Type their name.')
    if (!email.trim()) return setErr('An email is required — it is how they sign in.')
    if (!role || !childRoles.includes(role)) return setErr('Pick a role.')
    if (needsPhone && phone.replace(/\D/g, '').length < 10) {
      return setErr('Add their mobile number — cashiers, servers and kitchen staff sign in with a code sent to it.')
    }
    invite.mutate()
  }

  return (
    <section id="add-login" className="rounded-2xl p-4" style={card}>
      <p className="text-sm font-black text-white/85">Add a login</p>
      <p className="text-xs text-white/45 mt-1">The CEO approves each one before it can sign in. Once approved they get a link to set their own password, or the CEO gives them one.</p>
      <form onSubmit={submit} className="mt-3 space-y-2.5">
        {employees.length > 0 && (
          <label className="block">
            <span className="text-[11px] text-white/45">Someone on your team (optional)</span>
            <select value={employeeId} onChange={(e) => pickEmployee(e.target.value)} className={input}>
              <option value="">— not linked to an HR record —</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.fullName} · {e.employeeCode}</option>)}
            </select>
          </label>
        )}
        <label className="block">
          <span className="text-[11px] text-white/45">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={input} />
        </label>
        <label className="block">
          <span className="text-[11px] text-white/45">Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={input} />
        </label>
        <label className="block">
          <span className="text-[11px] text-white/45">
            {needsPhone ? 'Mobile number (required — they sign in with a code sent here)' : 'Mobile number (optional for this role; required for cashiers, servers and kitchen staff)'}
          </span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" inputMode="tel" required={needsPhone} className={input} />
        </label>
        <label className="block">
          <span className="text-[11px] text-white/45">Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value)} className={input}>
            {childRoles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
          </select>
        </label>
        {err && <p className="text-xs font-bold text-red-700">{err}</p>}
        {done && <p className="text-xs font-bold text-[#3f7d20]">{done}</p>}
        <button type="submit" disabled={invite.isPending}
          className="rounded-lg px-3 py-2 text-xs font-black disabled:opacity-50" style={{ background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }}>
          {invite.isPending ? 'Sending…' : 'Send for approval'}
        </button>
      </form>
    </section>
  )
}

function MyInvites() {
  const { data: invites = [], isLoading } = useQuery<Invite[]>({
    queryKey: ['staff', 'invites'],
    queryFn: () => api.get<Invite[]>('/auth/staff/invites'),
    staleTime: 30_000,
  })
  return (
    <section className="rounded-2xl overflow-hidden" style={card}>
      <p className="px-4 pt-4 text-sm font-black text-white/85">Logins I&rsquo;ve added</p>
      <p className="px-4 pb-2 text-[11px] text-white/40">The CEO approves each one.</p>
      {isLoading && <p className="px-4 pb-4 text-xs text-white/40">Loading…</p>}
      {!isLoading && invites.length === 0 && <p className="px-4 pb-4 text-xs text-white/40">None yet.</p>}
      {invites.map((i) => {
        const st = INVITE_STATUS[i.status] ?? INVITE_STATUS.pending
        return (
          <div key={i.id} className="px-4 py-2 border-t border-white/[0.05]">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white/85 truncate flex-1">{i.name}</span>
              <span className="text-[11px] font-bold shrink-0" style={{ color: st.color }}>{st.label}</span>
            </div>
            <p className="text-[11px] text-white/40">{i.email} · {roleLabel(i.role)} · {new Date(i.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</p>
          </div>
        )
      })}
    </section>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="rounded-2xl p-3" style={card}>
      <p className="text-[10px] uppercase tracking-wider text-white/40 font-bold">{label}</p>
      <p className="text-xl font-black mt-0.5" style={{ color: color ?? 'rgb(var(--fg-rgb) / 0.9)' }}>{value}</p>
    </div>
  )
}
