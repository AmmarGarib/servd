'use client'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { usePermissions } from '../../../hooks/useCan'
import { roleLabel } from '../../../lib/appRoles'

// User audit log — the Dev workspace's IDENTITY trail (decision 47): who signed
// in (and who failed to), who exists, what access they hold, and what they did
// on shift. Read by IT (role `it`, module audit_log) and the managers who run a
// shift. GET /auth/audit-log filters by user, action prefix and a date window;
// GET /auth/audit-log/users/:id/summary is the per-person picture.
//
// The books' own trail — period closes, journals, wage rates — is a separate
// feed at /accounting/audit-log, CEO and management only.
interface AuditRow {
  id: string
  action: string
  entity: string
  entityId: string | null
  userId: string | null
  userEmail: string | null
  before: unknown
  after: unknown
  metadata: unknown
  createdAt: string
}

interface Page { data: AuditRow[]; cursor: string | null; hasMore: boolean }

interface UserSummary {
  user: { id: string; name: string; email: string | null; role: string }
  lastSignInAt: string | null
  signInsLast30d: number
  failedLast30d: number
  actionsLast30d: number
  topActions: Array<{ action: string; count: number }>
}

type Tab = 'signins' | 'activity'

// Activity is grouped by the question being asked, not by the verb.
const ACTIVITY_FILTERS = [
  { key: '',               label: 'Everything' },
  { key: 'user.',          label: 'Accounts & roles' },
  { key: 'staff.',         label: 'Invites & approvals' },
  { key: 'role_modules',   label: 'Permissions' },
  { key: 'order_',         label: 'Refunds, voids, comps' },
  { key: 'giftcard',       label: 'Gift cards' },
  { key: 'stock-transfer', label: 'Stock moves' },
] as const

// The entries that change who can do what, or that a sign-in went wrong.
const LOUD_ACTIONS = new Set([
  'user.create', 'user.role_change', 'user.enable', 'user.disable',
  'user.password_reissue', 'user.pin_reissue', 'role_modules.update',
  'auth.login_failed', 'auth.2fa_failed',
])

const SIGNIN_LABEL: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.otp_login': 'Signed in with a code',
  'auth.login_failed': 'Failed sign-in',
  'auth.2fa_failed': 'Wrong 2FA code',
  'auth.logout': 'Signed out',
}

const card = { background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.07)' }
const field = 'rounded-lg px-2.5 py-1.5 text-xs bg-white/[0.04] border border-white/10 text-white/80 focus:outline-none focus:border-primary/60'

/** A yyyy-mm-dd from a date input → the start / end of that local day. */
const dayStart = (d: string) => new Date(`${d}T00:00:00`).toISOString()
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999`).toISOString()

export default function UserAuditLogPage() {
  const { data: me } = usePermissions()
  const [tab, setTab] = useState<Tab>('signins')
  const [group, setGroup] = useState('')
  const [userId, setUserId] = useState('')
  const [actionText, setActionText] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [drawerUser, setDrawerUser] = useState<string | null>(null)

  const allowed = me?.role === 'admin' || (me?.modules ?? []).includes('audit_log')

  // The action prefix sent to the API: Sign-ins pins `auth.`; Activity uses the
  // group chip, or what was typed.
  const typed = actionText.trim()
  const action = tab === 'signins'
    ? (typed.startsWith('auth.') ? typed : 'auth.')
    : (typed || group)

  const qs = (cursor?: string | null) => {
    const p = new URLSearchParams({ limit: '100' })
    if (action) p.set('action', action)
    if (userId) p.set('userId', userId)
    if (from) p.set('from', dayStart(from))
    if (to) p.set('to', dayEnd(to))
    if (cursor) p.set('cursor', cursor)
    return p.toString()
  }

  const feed = useInfiniteQuery({
    queryKey: ['identity-audit-log', action, userId, from, to],
    queryFn: ({ pageParam }) => api.get<Page>(`/auth/audit-log?${qs(pageParam)}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.cursor : null),
    enabled: allowed,
  })

  const rows = useMemo(() => {
    const all = (feed.data?.pages ?? []).flatMap((p) => p.data)
    // Activity with no specific filter leaves the sign-ins to their own tab.
    return tab === 'activity' && !action ? all.filter((r) => !r.action.startsWith('auth.')) : all
  }, [feed.data, tab, action])

  // The user picker offers everyone seen in the trail so far.
  const people = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of feed.data?.pages ?? []) for (const r of p.data) if (r.userId && !m.has(r.userId)) m.set(r.userId, r.userEmail ?? r.userId.slice(0, 8))
    return Array.from(m.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [feed.data])

  if (me && !allowed) {
    return (
      <Frame>
        <div className="max-w-md rounded-2xl p-6" style={card}>
          <p className="font-bold text-white/85">No access</p>
          <p className="text-sm text-white/45 mt-1">The user audit log needs the audit_log module (IT has it). Ask the CEO.</p>
        </div>
      </Frame>
    )
  }

  return (
    <Frame>
      <div className="flex gap-1 border-b border-white/[0.06]">
        {([['signins', 'Sign-ins'], ['activity', 'Activity']] as const).map(([k, label]) => (
          <button key={k} onClick={() => { setTab(k); setActionText('') }}
            className="px-4 py-2 text-sm font-bold -mb-px border-b-2"
            style={{ borderColor: tab === k ? 'var(--erp-accent)' : 'transparent', color: tab === k ? 'var(--erp-primary-ink)' : 'rgb(var(--fg-rgb) / 0.5)' }}>
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-white/35 font-bold">User</span>
          <select value={userId} onChange={(e) => setUserId(e.target.value)} className={field}>
            <option value="">Everyone</option>
            {userId && !people.some(([id]) => id === userId) && <option value={userId}>{userId.slice(0, 8)}</option>}
            {people.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-white/35 font-bold">Action starts with</span>
          <input value={actionText} onChange={(e) => setActionText(e.target.value)}
            placeholder={tab === 'signins' ? 'auth.login_failed' : 'user.'} className={`${field} w-44 font-mono`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-white/35 font-bold">From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-white/35 font-bold">To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={field} />
        </label>
        {(userId || actionText || from || to) && (
          <button onClick={() => { setUserId(''); setActionText(''); setFrom(''); setTo('') }}
            className="text-xs font-bold text-white/45 hover:text-white/80 px-2 py-1.5">Clear</button>
        )}
      </div>

      {tab === 'activity' && !typed && (
        <div className="flex gap-2 flex-wrap">
          {ACTIVITY_FILTERS.map((f) => (
            <button key={f.key} onClick={() => setGroup(f.key)} aria-pressed={group === f.key}
              className="px-3 py-1.5 rounded-full text-xs font-semibold border"
              style={group === f.key
                ? { background: 'var(--erp-accent-dim)', borderColor: 'var(--erp-accent)', color: 'var(--text)' }
                : { background: 'transparent', borderColor: 'rgb(var(--fg-rgb) / 0.1)', color: 'rgb(var(--fg-rgb) / 0.6)' }}>
              {f.label}
            </button>
          ))}
        </div>
      )}

      <div className="rounded-2xl overflow-hidden" style={card}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[11px] text-white/40" style={{ background: 'rgb(var(--fg-rgb) / 0.02)' }}>
              <tr>
                <th className="px-4 py-2 text-left font-semibold">When</th>
                <th className="px-4 py-2 text-left font-semibold">What</th>
                <th className="px-4 py-2 text-left font-semibold">{tab === 'signins' ? 'From' : 'Who it touched'}</th>
                <th className="px-4 py-2 text-left font-semibold">User</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {feed.isLoading && <tr><td colSpan={5} className="px-4 py-6 text-center text-xs text-white/40">Loading…</td></tr>}
              {feed.error != null && <tr><td colSpan={5} className="px-4 py-6 text-center text-xs text-white/40">Could not load the audit log.</td></tr>}
              {!feed.isLoading && rows.length === 0 && feed.error == null && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-xs text-white/40">No entries match.</td></tr>
              )}
              {rows.map((r) => (
                <Row key={r.id} row={r} signins={tab === 'signins'} open={openRow === r.id}
                  onToggle={() => setOpenRow(openRow === r.id ? null : r.id)}
                  onUser={(id) => setDrawerUser(id)} />
              ))}
            </tbody>
          </table>
        </div>
        {feed.hasNextPage && (
          <div className="p-3 text-center border-t border-white/[0.05]">
            <button onClick={() => void feed.fetchNextPage()} disabled={feed.isFetchingNextPage}
              className="text-xs font-bold text-primary-ink hover:underline disabled:opacity-50">
              {feed.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>

      <p className="text-[11px] text-white/35">
        Passwords and codes are never recorded — only who, when, from where, and why a sign-in failed.
        Entries with no company (legacy rows, failed sign-ins against unknown emails) are visible to the CEO only.
      </p>

      {drawerUser && <UserDrawer userId={drawerUser} onClose={() => setDrawerUser(null)} onFilter={() => { setUserId(drawerUser); setDrawerUser(null) }} />}
    </Frame>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-6 pt-6 pb-4 border-b border-white/[0.05]">
        <Link href="/w/dev" className="text-xs text-white/40 hover:text-white/70">← Dev</Link>
        <h1 className="text-2xl font-black text-white/90 mt-1">User audit log</h1>
        <p className="text-xs text-white/45 mt-1 max-w-3xl">
          Sign-ins, accounts, roles and permissions, plus what staff did on shift. Append-only.
          The books&rsquo; own trail lives in <Link href="/accounting/audit-log" className="underline">Accounting</Link> and is restricted to the CEO and management.
        </p>
      </header>
      <div className="p-6 max-w-6xl mx-auto space-y-3">{children}</div>
    </div>
  )
}

function meta(row: AuditRow): { ip?: string; userAgent?: string; reason?: string } {
  const m = (row.metadata ?? {}) as Record<string, unknown>
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined)
  return { ip: s(m['ip']), userAgent: s(m['userAgent']) ?? s(m['ua']), reason: s(m['reason']) }
}

function Row({ row, signins, open, onToggle, onUser }: {
  row: AuditRow; signins: boolean; open: boolean; onToggle: () => void; onUser: (id: string) => void
}) {
  const loud = LOUD_ACTIONS.has(row.action)
  const before = row.before as { role?: string } | null
  const after = row.after as { role?: string; targetEmail?: string } | null
  const roleMove = row.action === 'user.role_change' && before?.role && after?.role ? `${before.role} → ${after.role}` : null
  const m = meta(row)

  return (
    <>
      <tr className="border-t border-white/[0.05] hover:bg-white/[0.02] cursor-pointer" onClick={onToggle}>
        <td className="px-4 py-2 text-xs text-white/45 whitespace-nowrap">{new Date(row.createdAt).toLocaleString()}</td>
        <td className="px-4 py-2 text-xs">
          <span className="font-mono rounded px-1.5 py-0.5"
            style={loud
              ? { background: 'rgba(245,158,11,0.12)', color: 'var(--erp-warning)' }
              : { background: 'rgb(var(--fg-rgb) / 0.05)', color: 'rgb(var(--fg-rgb) / 0.75)' }}>
            {signins ? (SIGNIN_LABEL[row.action] ?? row.action) : row.action}
          </span>
          {signins && m.reason && <span className="ml-2 text-[11px] text-white/40">{m.reason}</span>}
        </td>
        <td className="px-4 py-2 text-xs text-white/70">
          {signins ? (
            <span className="font-mono text-[11px]">{m.ip ?? '—'}</span>
          ) : (
            <>
              <span>{after?.targetEmail ?? row.entity}</span>
              {roleMove && <span className="ml-2 font-mono text-[11px] text-amber-700">{roleMove}</span>}
              {!roleMove && row.entityId && <span className="text-white/35 ml-1">#{row.entityId.slice(0, 8)}</span>}
            </>
          )}
        </td>
        <td className="px-4 py-2 text-xs">
          {row.userId ? (
            <button onClick={(e) => { e.stopPropagation(); onUser(row.userId!) }} className="text-primary-ink hover:underline">
              {row.userEmail ?? row.userId.slice(0, 8)}
            </button>
          ) : (
            <span className="text-white/45">{row.userEmail ?? 'system'}</span>
          )}
        </td>
        <td className="px-4 py-2 text-right"><span className="text-xs text-white/35">{open ? '▾' : '▸'}</span></td>
      </tr>
      {open && (
        <tr className="border-t border-white/[0.05]" style={{ background: 'rgb(var(--fg-rgb) / 0.015)' }}>
          <td colSpan={5} className="px-6 py-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              {m.userAgent && <p className="md:col-span-2 text-white/45">Device: <span className="text-white/70">{m.userAgent}</span></p>}
              <Json label="Before" value={row.before} />
              <Json label="After" value={row.after} />
              {row.metadata != null && <div className="md:col-span-2"><Json label="Metadata" value={row.metadata} /></div>}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="font-semibold text-white/40 mb-1.5">{label}</p>
      <pre className="rounded p-2 overflow-x-auto text-[11px] text-white/70" style={{ background: 'rgb(var(--fg-rgb) / 0.04)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
        {value ? JSON.stringify(value, null, 2) : '(none)'}
      </pre>
    </div>
  )
}

function UserDrawer({ userId, onClose, onFilter }: { userId: string; onClose: () => void; onFilter: () => void }) {
  const summary = useQuery({
    queryKey: ['identity-audit-summary', userId],
    queryFn: () => api.get<UserSummary>(`/auth/audit-log/users/${encodeURIComponent(userId)}/summary`),
  })
  const timeline = useQuery({
    queryKey: ['identity-audit-log', 'user-timeline', userId],
    queryFn: () => api.get<Page>(`/auth/audit-log?${new URLSearchParams({ userId, limit: '50' })}`),
  })
  const s = summary.data
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-secondary/40" onClick={onClose}>
      <aside className="w-full max-w-md h-full overflow-y-auto p-5" style={{ background: 'var(--surface)', borderLeft: '1px solid rgb(var(--fg-rgb) / 0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-lg font-black text-white/90 truncate">{s?.user.name ?? 'User'}</p>
            {s && <p className="text-xs text-white/45 truncate">{s.user.email ?? '—'} · {roleLabel(s.user.role)}</p>}
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white" aria-label="Close">✕</button>
        </div>

        {summary.isLoading && <p className="text-sm text-white/40 mt-4">Loading…</p>}
        {summary.error != null && <p className="text-sm text-white/40 mt-4">Could not load this person&rsquo;s summary.</p>}
        {s && (
          <>
            <div className="grid grid-cols-2 gap-2 mt-4">
              <Mini label="Last sign-in" value={s.lastSignInAt ? new Date(s.lastSignInAt).toLocaleString() : 'Never'} />
              <Mini label="Sign-ins, 30 days" value={String(s.signInsLast30d)} />
              <Mini label="Failed, 30 days" value={String(s.failedLast30d)} warn={s.failedLast30d > 0} />
              <Mini label="Actions, 30 days" value={String(s.actionsLast30d)} />
            </div>
            {s.topActions.length > 0 && (
              <div className="mt-4">
                <p className="text-[10px] uppercase tracking-wider text-white/40 font-bold mb-1.5">Most frequent</p>
                {s.topActions.map((a) => (
                  <div key={a.action} className="flex justify-between text-xs py-1 border-t border-white/[0.05]">
                    <span className="font-mono text-white/70">{a.action}</span>
                    <span className="text-white/50">{a.count}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div className="mt-5 flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-wider text-white/40 font-bold">Timeline</p>
          <button onClick={onFilter} className="text-[11px] font-bold text-primary-ink hover:underline">Filter the log to them</button>
        </div>
        {timeline.isLoading && <p className="text-xs text-white/40 mt-2">Loading…</p>}
        {(timeline.data?.data ?? []).map((r) => (
          <div key={r.id} className="py-1.5 border-t border-white/[0.05] first:border-t-0">
            <div className="flex justify-between gap-2 text-xs">
              <span className="font-mono" style={{ color: LOUD_ACTIONS.has(r.action) ? 'var(--erp-warning)' : 'rgb(var(--fg-rgb) / 0.75)' }}>{SIGNIN_LABEL[r.action] ?? r.action}</span>
              <span className="text-white/35 shrink-0">{new Date(r.createdAt).toLocaleString()}</span>
            </div>
            {!r.action.startsWith('auth.') && <p className="text-[11px] text-white/40">{r.entity}{r.entityId ? ` #${r.entityId.slice(0, 8)}` : ''}</p>}
          </div>
        ))}
        {timeline.data && timeline.data.data.length === 0 && <p className="text-xs text-white/40 mt-2">Nothing recorded.</p>}
      </aside>
    </div>
  )
}

function Mini({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-xl p-2.5" style={card}>
      <p className="text-[9px] uppercase tracking-wider text-white/40 font-bold">{label}</p>
      <p className="text-sm font-bold mt-0.5" style={{ color: warn ? 'var(--erp-warning)' : 'rgb(var(--fg-rgb) / 0.85)' }}>{value}</p>
    </div>
  )
}
