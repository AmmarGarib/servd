'use client'
// ─── Workforce hub — every staff record in one place ──────────────────────────
// The CEO wanted a single screen that surfaces every staff bucket (Management,
// FOH, BOH, Procurement, Marketing, Finance, HR) — not just the kitchen-staff
// brigade view. This page lists every User row, with category chips that
// deep-link to a filtered view, plus a status filter for pending / active /
// suspended and a "+ Add staff" modal. Kitchen brigade (with payroll / EOBI
// / compliance) keeps its dedicated /kitchen-staff route — link out from
// the BOH category card.
//
// Sidebar deep-links pass `?role=foh,foh_management` so the chip highlights
// itself on load. Roles are read from src/lib/appRoles.ts so a new role only
// needs to be added in one place.

import { useState, useMemo, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { APP_ROLES, roleLabel, type AppRole } from '../../lib/appRoles'
import { usePermissions } from '../../hooks/useCan'

interface StaffUser {
  id: string
  name: string
  email: string
  phone: string | null
  role: AppRole
  isActive: boolean
  accountStatus: 'pending' | 'active' | 'suspended'
  createdAt: string
  hasPin: boolean
  tenantId: string | null
}

// Category → which AppRole values fall under it. A single user has one role,
// but the directory groups them so the CEO sees "Front of House" as a bucket
// rather than the raw enum granularity.
interface Category {
  key: string
  label: string
  emoji: string
  blurb: string
  roles: AppRole[]
  /** Optional deep-link to a richer specialist view (kitchen-staff brigade). */
  specialistHref?: string
  specialistLabel?: string
}

const CATEGORIES: Category[] = [
  {
    key: 'management',
    label: 'Management',
    emoji: '🧑‍💼',
    blurb: 'GMs, FOH & BOH leads, the people who run the floor day-to-day.',
    roles: ['management', 'foh_management', 'boh_management', 'manager'],
  },
  {
    key: 'foh',
    label: 'Front of House',
    emoji: '💁',
    blurb: 'Servers, hosts, cashiers — anyone customer-facing.',
    roles: ['foh', 'cashier'],
  },
  {
    key: 'boh',
    label: 'Back of House',
    emoji: '🍳',
    blurb: 'Line cooks, expediters, KDS station operators.',
    roles: ['boh', 'kitchen', 'expediter'],
    specialistHref: '/kitchen-staff',
    specialistLabel: 'Open kitchen brigade ›',
  },
  {
    key: 'procurement',
    label: 'Procurement',
    emoji: '🏭',
    blurb: 'Supplier chat, POs, inventory receiving.',
    roles: ['procurement'],
  },
  {
    key: 'marketing',
    label: 'Marketing',
    emoji: '🚀',
    blurb: 'CRM, campaigns, reviews, content calendar.',
    roles: ['marketing'],
  },
  {
    key: 'finance',
    label: 'Finance',
    emoji: '💰',
    blurb: 'P&L, payroll, accounting, reconciliation.',
    roles: ['finance'],
  },
  {
    key: 'hr',
    label: 'HR',
    emoji: '👥',
    blurb: 'Staff records, scheduling, compliance.',
    roles: ['hr'],
  },
]

const STATUS_META: Record<StaffUser['accountStatus'], { label: string; color: string; bg: string }> = {
  active:    { label: 'Active',    color: '#00D4B1', bg: 'rgba(0,212,177,0.10)' },
  pending:   { label: 'Pending',   color: '#F59E0B', bg: 'rgba(245,158,11,0.10)' },
  suspended: { label: 'Suspended', color: '#FF4D4F', bg: 'rgba(255,77,79,0.10)' },
}

// AppRoles minus admin — admins are managed through the existing CEO-only
// surface. Showing "Admin" in the add-staff dropdown would mislead someone
// into thinking creating a CEO is a routine workforce action.
const ASSIGNABLE_ROLES = APP_ROLES.filter((r) => r.value !== 'admin')

function statusOf(u: StaffUser): StaffUser['accountStatus'] {
  // accountStatus is canonical; older rows that haven't been migrated may
  // still be 'active' with isActive=false — treat that as suspended.
  if (!u.isActive) return 'suspended'
  return u.accountStatus
}

function categoryOf(role: AppRole): Category | undefined {
  return CATEGORIES.find((c) => c.roles.includes(role))
}

// ─── Page ────────────────────────────────────────────────────────────────────

function WorkforcePageInner() {
  const router = useRouter()
  const qc = useQueryClient()
  const sp = useSearchParams()
  const { data: me } = usePermissions()
  const canEdit = me?.role === 'admin'

  // ?role=foh,cashier → highlight FOH category. We resolve by category key so
  // the chip stays selected even when the URL contains the raw role values.
  const initialCategory = useMemo(() => {
    const raw = sp.get('category')
    if (raw) return raw
    const roleParam = sp.get('role')
    if (!roleParam) return 'all'
    const roles = roleParam.split(',').map((r) => r.trim()) as AppRole[]
    const hit = CATEGORIES.find((c) => roles.some((r) => c.roles.includes(r)))
    return hit?.key ?? 'all'
  }, [sp])

  const [activeCategory, setActiveCategory] = useState<string>(initialCategory)
  const [statusFilter, setStatusFilter] = useState<'all' | StaffUser['accountStatus']>('all')
  const [search, setSearch] = useState('')
  const [addOpen, setAddOpen] = useState(false)

  const { data: users = [], isLoading } = useQuery<StaffUser[]>({
    queryKey: ['workforce', 'users'],
    queryFn:  () => api.get('/auth/users'),
    refetchInterval: 60_000,
  })

  // Group + filter — do everything client-side so flipping category chips is
  // instant. The user list is tiny (tens of rows, not thousands).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return users.filter((u) => {
      if (activeCategory !== 'all') {
        const cat = CATEGORIES.find((c) => c.key === activeCategory)
        if (!cat || !cat.roles.includes(u.role)) return false
      }
      if (statusFilter !== 'all' && statusOf(u) !== statusFilter) return false
      if (q && !(u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))) return false
      return true
    })
  }, [users, activeCategory, statusFilter, search])

  // Counts per category for the chip badges — derived from the *unfiltered*
  // set so the chips show what you'd see if you clicked them.
  const countsByCategory = useMemo(() => {
    const m = new Map<string, number>()
    for (const u of users) {
      const c = categoryOf(u.role)
      if (c) m.set(c.key, (m.get(c.key) ?? 0) + 1)
    }
    return m
  }, [users])

  const pendingCount = users.filter((u) => statusOf(u) === 'pending').length

  return (
    <div className="min-h-screen bg-kds-bg text-kds-text">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="border-b border-kds-border bg-kds-card">
        <div className="max-w-6xl mx-auto px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-black">Workforce</h1>
              <p className="text-sm text-kds-subtext mt-1">
                Every staff member, every category. {users.length} total ·
                <span className={pendingCount > 0 ? 'text-amber-400 font-bold' : ''}> {pendingCount} pending</span>
              </p>
            </div>
            <div className="flex items-center gap-2">
              {pendingCount > 0 && (
                <Link href="/configuration/pending-approvals"
                  className="rounded-lg px-3 py-2 text-xs font-bold border transition-colors"
                  style={{ background: 'rgba(245,158,11,0.10)', borderColor: 'rgba(245,158,11,0.35)', color: '#F59E0B' }}>
                  ⏳ Review {pendingCount} pending
                </Link>
              )}
              {canEdit && (
                <button onClick={() => setAddOpen(true)}
                  className="rounded-lg px-3 py-2 text-xs font-black bg-kds-green text-black hover:opacity-90">
                  + Add staff
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Category chips ─────────────────────────────────────────────── */}
      <div className="max-w-6xl mx-auto px-6 pt-5">
        <div className="flex flex-wrap gap-2">
          <CategoryChip
            label="All staff" emoji="∞" count={users.length}
            active={activeCategory === 'all'}
            onClick={() => { setActiveCategory('all'); router.replace('/workforce') }}
          />
          {CATEGORIES.map((c) => (
            <CategoryChip
              key={c.key} label={c.label} emoji={c.emoji}
              count={countsByCategory.get(c.key) ?? 0}
              active={activeCategory === c.key}
              onClick={() => { setActiveCategory(c.key); router.replace(`/workforce?category=${c.key}`) }}
            />
          ))}
        </div>

        {/* Category blurb + specialist link */}
        {activeCategory !== 'all' && (
          <CategoryBlurb category={CATEGORIES.find((c) => c.key === activeCategory)!} />
        )}

        {/* ── Status filter + search ───────────────────────────────────── */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {(['all', 'active', 'pending', 'suspended'] as const).map((s) => {
            const active = statusFilter === s
            return (
              <button key={s} onClick={() => setStatusFilter(s)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider transition-colors ${
                  active ? 'bg-kds-green text-black' : 'text-kds-subtext hover:bg-kds-card hover:text-kds-text'
                }`}>
                {s === 'all' ? 'All status' : s}
              </button>
            )
          })}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or email…"
            className="ml-auto rounded-lg px-3 py-1.5 text-sm bg-kds-card border border-kds-border focus:border-kds-green focus:outline-none w-64"
          />
        </div>

        {/* ── Staff table ──────────────────────────────────────────────── */}
        <div className="mt-4 mb-12 rounded-xl border border-kds-border bg-kds-card overflow-hidden">
          {isLoading && <div className="p-8 text-center text-sm text-kds-subtext">Loading staff…</div>}
          {!isLoading && filtered.length === 0 && (
            <div className="p-12 text-center">
              <p className="text-4xl mb-2">📭</p>
              <p className="text-sm font-semibold">No staff here yet</p>
              <p className="text-xs text-kds-subtext mt-1">
                {activeCategory === 'all'
                  ? 'Tap + Add staff or share the self-signup link with your team.'
                  : `No ${CATEGORIES.find((c) => c.key === activeCategory)?.label} staff on file. Add one to get started.`}
              </p>
            </div>
          )}
          {filtered.map((u) => (
            <StaffRow key={u.id} user={u} canEdit={canEdit}
              onChange={() => void qc.invalidateQueries({ queryKey: ['workforce'] })} />
          ))}
        </div>
      </div>

      {addOpen && (
        <AddStaffModal onClose={() => setAddOpen(false)}
          onCreated={() => { setAddOpen(false); void qc.invalidateQueries({ queryKey: ['workforce'] }) }} />
      )}
    </div>
  )
}

export default function WorkforcePage() {
  // useSearchParams must be inside Suspense per Next.js 14 app-router rules.
  return (
    <Suspense fallback={<div className="p-8 text-sm text-kds-subtext">Loading…</div>}>
      <WorkforcePageInner />
    </Suspense>
  )
}

// ─── Components ──────────────────────────────────────────────────────────────

function CategoryChip({
  label, emoji, count, active, onClick,
}: { label: string; emoji: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-all ${
        active
          ? 'bg-kds-green text-black'
          : 'bg-kds-card border border-kds-border text-kds-text hover:border-kds-green/40'
      }`}>
      <span>{emoji}</span>
      <span>{label}</span>
      <span className={`text-[10px] font-black ${active ? 'opacity-60' : 'text-kds-subtext'}`}>{count}</span>
    </button>
  )
}

function CategoryBlurb({ category }: { category: Category }) {
  return (
    <div className="mt-3 flex items-center gap-3 rounded-lg border border-kds-border bg-kds-card/50 px-4 py-2.5">
      <span className="text-xl">{category.emoji}</span>
      <p className="text-xs text-kds-subtext flex-1">{category.blurb}</p>
      {category.specialistHref && (
        <Link href={category.specialistHref}
          className="text-xs font-bold text-kds-green hover:opacity-80">
          {category.specialistLabel ?? 'Open ›'}
        </Link>
      )}
    </div>
  )
}

function StaffRow({
  user, canEdit, onChange,
}: { user: StaffUser; canEdit: boolean; onChange: () => void }) {
  const status = statusOf(user)
  const statusM = STATUS_META[status]
  const cat = categoryOf(user.role)

  const approve = useMutation({
    mutationFn: () => api.patch(`/auth/staff/${user.id}/approve`, {}),
    onSuccess:  onChange,
  })
  const reject = useMutation({
    mutationFn: () => api.patch(`/auth/staff/${user.id}/reject`, {}),
    onSuccess:  onChange,
  })
  const toggleActive = useMutation({
    mutationFn: () => api.patch(`/auth/users/${user.id}`, { isActive: !user.isActive }),
    onSuccess:  onChange,
  })
  const remove = useMutation({
    mutationFn: () => api.delete(`/auth/users/${user.id}`),
    onSuccess:  onChange,
  })

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-kds-border last:border-b-0 hover:bg-kds-bg/30">
      <div className="h-9 w-9 shrink-0 rounded-full flex items-center justify-center text-sm font-black"
        style={{ background: 'linear-gradient(135deg, rgba(0,212,177,0.4), rgba(99,102,241,0.4))', color: '#000' }}>
        {user.name.charAt(0).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="font-semibold text-sm truncate">{user.name}</p>
          <span className="shrink-0 text-[9px] uppercase tracking-wider font-bold rounded px-1.5 py-0.5"
            style={{ background: statusM.bg, color: statusM.color }}>
            {statusM.label}
          </span>
          {!user.hasPin && status === 'active' && (
            <span className="shrink-0 text-[9px] uppercase tracking-wider font-bold rounded px-1.5 py-0.5"
              style={{ background: 'rgba(255,77,79,0.10)', color: '#FF4D4F' }}>
              No PIN
            </span>
          )}
        </div>
        <p className="text-xs text-kds-subtext truncate">
          {user.email}{user.phone ? ` · ${user.phone}` : ''}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-[11px] font-bold text-kds-text">
          {cat?.emoji ?? '·'} {cat?.label ?? roleLabel(user.role)}
        </p>
        <p className="text-[10px] text-kds-subtext mt-0.5">{roleLabel(user.role)}</p>
      </div>
      {canEdit && (
        <div className="shrink-0 flex items-center gap-1.5">
          {status === 'pending' && (
            <>
              <button onClick={() => approve.mutate()} disabled={approve.isPending}
                className="rounded-md px-2 py-1 text-[11px] font-bold bg-kds-green text-black hover:opacity-90 disabled:opacity-50">
                Approve
              </button>
              <button onClick={() => reject.mutate()} disabled={reject.isPending}
                className="rounded-md px-2 py-1 text-[11px] font-bold border border-kds-border text-kds-subtext hover:text-red-400 hover:border-red-400/40">
                Reject
              </button>
            </>
          )}
          {status === 'active' && (
            <button onClick={() => toggleActive.mutate()} disabled={toggleActive.isPending}
              className="rounded-md px-2 py-1 text-[11px] font-bold border border-kds-border text-kds-subtext hover:text-amber-400 hover:border-amber-400/40">
              Suspend
            </button>
          )}
          {status === 'suspended' && (
            <button onClick={() => toggleActive.mutate()} disabled={toggleActive.isPending}
              className="rounded-md px-2 py-1 text-[11px] font-bold border border-kds-border text-kds-subtext hover:text-emerald-400 hover:border-emerald-400/40">
              Reactivate
            </button>
          )}
          <button
            onClick={() => {
              if (window.confirm(`Delete ${user.name}? This soft-deletes — history is preserved.`)) {
                remove.mutate()
              }
            }}
            disabled={remove.isPending}
            className="rounded-md px-2 py-1 text-[11px] font-bold border border-kds-border text-kds-subtext hover:text-red-400 hover:border-red-400/40"
            title="Delete (soft)">
            🗑
          </button>
        </div>
      )}
    </div>
  )
}

function AddStaffModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName]   = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [role, setRole]   = useState<AppRole>('cashier')
  const [pin, setPin]     = useState('')
  const [err, setErr]     = useState<string | null>(null)

  // Auto-derive PIN from the last 4 digits of phone, matching the self-signup
  // convention. The CEO can override if they want.
  const derivedPin = phone.replace(/\D/g, '').slice(-4)
  const effectivePin = pin.trim() || derivedPin

  const create = useMutation({
    mutationFn: () => api.post('/auth/users', {
      name: name.trim(),
      email: email.trim().toLowerCase(),
      phone: phone.trim() || undefined,
      role,
      pin: effectivePin,
    }),
    onSuccess: onCreated,
    onError:   (e: unknown) => setErr(e instanceof Error ? e.message : 'Failed to create staff'),
  })

  function submit() {
    setErr(null)
    if (!name.trim() || !email.trim()) return setErr('Name and email are required')
    if (effectivePin.length < 4) return setErr('PIN must be ≥4 digits (or enter a phone number ending in 4+ digits)')
    create.mutate()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-kds-card border border-kds-border rounded-2xl p-5 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}>
        <h2 className="font-black text-lg mb-1">Add staff</h2>
        <p className="text-xs text-kds-subtext mb-4">
          New accounts are active immediately — no approval needed when the CEO creates them directly.
        </p>

        <div className="space-y-2.5">
          <Field label="Full name">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Email">
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" className={inputCls} />
          </Field>
          <Field label="Phone (optional)" hint="Last 4 digits become their PIN.">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} className={inputCls} placeholder="e.g. 0301-1234567" />
          </Field>
          <Field label="Role">
            <select value={role} onChange={(e) => setRole(e.target.value as AppRole)} className={inputCls}>
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r.value} value={r.value}>{r.emoji} {r.label} — {r.description}</option>
              ))}
            </select>
          </Field>
          <Field label="PIN" hint={derivedPin && !pin ? `Defaulting to ${derivedPin} from phone.` : '4–8 digits.'}>
            <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              maxLength={8} className={inputCls} placeholder={derivedPin || '4-digit PIN'} />
          </Field>
        </div>

        {err && <p className="mt-3 text-xs font-bold text-red-400">{err}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose}
            className="rounded-lg px-3 py-2 text-xs font-bold border border-kds-border text-kds-subtext hover:text-kds-text">
            Cancel
          </button>
          <button onClick={submit} disabled={create.isPending}
            className="rounded-lg px-3 py-2 text-xs font-black bg-kds-green text-black hover:opacity-90 disabled:opacity-50">
            {create.isPending ? 'Creating…' : 'Create staff'}
          </button>
        </div>
      </div>
    </div>
  )
}

const inputCls =
  'w-full rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-sm focus:border-kds-green focus:outline-none'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-bold uppercase tracking-wider text-kds-subtext">{label}</span>
        {hint && <span className="text-[10px] text-kds-subtext/70">{hint}</span>}
      </div>
      {children}
    </label>
  )
}
