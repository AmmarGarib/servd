'use client'
// ─── Workforce hub — every staff record in one place ──────────────────────────
// The CEO wanted a single screen that surfaces every staff bucket (Management,
// FOH, BOH, Procurement, Marketing, Finance, HR) — not just the kitchen-staff
// brigade view. Add Staff is intentionally minimal: pick a category, type the
// role title, optionally drop a name. Email / phone / PIN get filled in on the
// row itself once the CEO knows them. Click a row to expand into the inline
// editor.
//
// Sidebar deep-links pass `?role=foh,foh_management` so the chip highlights
// itself on load. Roles are read from src/lib/appRoles.ts so a new role only
// needs to be added in one place.

import { useState, useMemo, Suspense, useEffect } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { roleLabel, type AppRole } from '../../lib/appRoles'
import { usePermissions } from '../../hooks/useCan'

interface StaffUser {
  id: string
  name: string
  email: string | null
  phone: string | null
  role: AppRole
  jobTitle: string | null
  isActive: boolean
  accountStatus: 'pending' | 'active' | 'suspended'
  createdAt: string
  hasPin: boolean
  tenantId: string | null
}

// Category → which AppRole values fall under it. A single user has one role
// enum value, but the directory groups them so the CEO picks "Front of House"
// once and we resolve to the primary enum value (the first in `roles`).
interface Category {
  key: string
  label: string
  emoji: string
  blurb: string
  /** First entry is the canonical/primary role enum value for new staff. */
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

function statusOf(u: StaffUser): StaffUser['accountStatus'] {
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
  // Inline edit: which row, if any, is in edit mode.
  const [editingId, setEditingId] = useState<string | null>(null)

  const { data: users = [], isLoading } = useQuery<StaffUser[]>({
    queryKey: ['workforce', 'users'],
    queryFn:  () => api.get('/auth/users'),
    refetchInterval: 60_000,
  })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return users.filter((u) => {
      if (activeCategory !== 'all') {
        const cat = CATEGORIES.find((c) => c.key === activeCategory)
        if (!cat || !cat.roles.includes(u.role)) return false
      }
      if (statusFilter !== 'all' && statusOf(u) !== statusFilter) return false
      if (q) {
        const hay = `${u.name} ${u.email ?? ''} ${u.jobTitle ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [users, activeCategory, statusFilter, search])

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

        {activeCategory !== 'all' && (
          <CategoryBlurb category={CATEGORIES.find((c) => c.key === activeCategory)!} />
        )}

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
            placeholder="Search name, email or job title…"
            className="ml-auto rounded-lg px-3 py-1.5 text-sm bg-kds-card border border-kds-border focus:border-kds-green focus:outline-none w-64"
          />
        </div>

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
            <StaffRow
              key={u.id} user={u} canEdit={canEdit}
              expanded={editingId === u.id}
              onExpand={() => setEditingId(editingId === u.id ? null : u.id)}
              onClose={() => setEditingId(null)}
              onChange={() => void qc.invalidateQueries({ queryKey: ['workforce'] })}
            />
          ))}
        </div>
      </div>

      {addOpen && (
        <AddStaffModal
          onClose={() => setAddOpen(false)}
          onCreated={(created) => {
            setAddOpen(false)
            void qc.invalidateQueries({ queryKey: ['workforce'] })
            // Pop the new row straight into edit mode so the CEO can fill in
            // contact details + PIN without clicking through.
            if (created?.id) setEditingId(created.id)
          }}
        />
      )}
    </div>
  )
}

export default function WorkforcePage() {
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

// ─── Staff row + inline editor ──────────────────────────────────────────────

function StaffRow({
  user, canEdit, expanded, onExpand, onClose, onChange,
}: {
  user: StaffUser; canEdit: boolean
  expanded: boolean
  onExpand: () => void
  onClose: () => void
  onChange: () => void
}) {
  const status = statusOf(user)
  const statusM = STATUS_META[status]
  const cat = categoryOf(user.role)
  const isUnnamed = !user.name || user.name === 'Unnamed staff'

  return (
    <div className="border-b border-kds-border last:border-b-0">
      <button
        type="button"
        onClick={canEdit ? onExpand : undefined}
        disabled={!canEdit}
        className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
          canEdit ? 'hover:bg-kds-bg/30 cursor-pointer' : 'cursor-default'
        } ${expanded ? 'bg-kds-bg/40' : ''}`}>
        <div className="h-9 w-9 shrink-0 rounded-full flex items-center justify-center text-sm font-black"
          style={{
            background: isUnnamed
              ? 'rgba(255,255,255,0.06)'
              : 'linear-gradient(135deg, rgba(0,212,177,0.4), rgba(99,102,241,0.4))',
            color: isUnnamed ? 'rgba(255,255,255,0.4)' : '#000',
          }}>
          {isUnnamed ? '?' : user.name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className={`font-semibold text-sm truncate ${isUnnamed ? 'italic text-kds-subtext' : ''}`}>
              {isUnnamed ? 'Unnamed staff — tap to fill in' : user.name}
            </p>
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
            {user.jobTitle && <span className="text-kds-text font-medium">{user.jobTitle}</span>}
            {user.jobTitle && (user.email || user.phone) && <span> · </span>}
            {user.email}{user.email && user.phone ? ' · ' : ''}{user.phone}
            {!user.jobTitle && !user.email && !user.phone && (
              <span className="italic">No contact details yet</span>
            )}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[11px] font-bold text-kds-text">
            {cat?.emoji ?? '·'} {cat?.label ?? roleLabel(user.role)}
          </p>
          <p className="text-[10px] text-kds-subtext mt-0.5">
            {user.jobTitle ? roleLabel(user.role) : 'No role title set'}
          </p>
        </div>
        {canEdit && (
          <span className="shrink-0 text-kds-subtext"
            style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 120ms' }}>
            ▶
          </span>
        )}
      </button>

      {expanded && canEdit && (
        <InlineEditor user={user} status={status}
          onChange={onChange} onClose={onClose} />
      )}
    </div>
  )
}

function InlineEditor({
  user, status, onChange, onClose,
}: {
  user: StaffUser
  status: StaffUser['accountStatus']
  onChange: () => void
  onClose: () => void
}) {
  const [name, setName]         = useState(user.name === 'Unnamed staff' ? '' : user.name)
  const [email, setEmail]       = useState(user.email ?? '')
  const [phone, setPhone]       = useState(user.phone ?? '')
  const [jobTitle, setJobTitle] = useState(user.jobTitle ?? '')
  const [category, setCategory] = useState<string>(categoryOf(user.role)?.key ?? 'management')
  const [role, setRole]         = useState<AppRole>(user.role)
  const [pin, setPin]           = useState('')
  const [err, setErr]           = useState<string | null>(null)

  // Keep role consistent with category: if the category changes and the
  // current role doesn't fit the new category, fall back to its primary.
  useEffect(() => {
    const cat = CATEGORIES.find((c) => c.key === category)
    if (cat && !cat.roles.includes(role)) {
      setRole(cat.roles[0]!)
    }
  }, [category])  // eslint-disable-line react-hooks/exhaustive-deps

  const derivedPin = phone.replace(/\D/g, '').slice(-4)

  const save = useMutation({
    mutationFn: () => {
      const patch: Record<string, unknown> = {}
      if (name.trim() && name.trim() !== user.name) patch.name = name.trim()
      // Empty string is sent verbatim — backend treats that as "clear it".
      if (email.trim() !== (user.email ?? '')) patch.email = email.trim()
      if (phone.trim() !== (user.phone ?? '')) patch.phone = phone.trim()
      if (jobTitle.trim() !== (user.jobTitle ?? '')) patch.jobTitle = jobTitle.trim()
      if (role !== user.role) patch.role = role
      if (pin.trim()) patch.pin = pin.trim()
      return api.patch(`/auth/users/${user.id}`, patch)
    },
    onSuccess: () => { onChange(); onClose() },
    onError:   (e: unknown) => setErr(e instanceof Error ? e.message : 'Failed to save'),
  })

  const remove = useMutation({
    mutationFn: () => api.delete(`/auth/users/${user.id}`),
    onSuccess:  () => { onChange(); onClose() },
  })
  const approve = useMutation({
    mutationFn: () => api.patch(`/auth/staff/${user.id}/approve`, {}),
    onSuccess:  () => onChange(),
  })
  const reject = useMutation({
    mutationFn: () => api.patch(`/auth/staff/${user.id}/reject`, {}),
    onSuccess:  () => onChange(),
  })
  const toggleActive = useMutation({
    mutationFn: () => api.patch(`/auth/users/${user.id}`, { isActive: !user.isActive }),
    onSuccess:  () => onChange(),
  })

  const currentCategory = CATEGORIES.find((c) => c.key === category)
  const roleOptions = currentCategory ? currentCategory.roles : []

  return (
    <div className="bg-kds-bg/30 border-t border-kds-border px-4 py-4 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Ahmad Khan" className={inputCls} />
        </Field>
        <Field label="Job title" hint="What the role is called day-to-day.">
          <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)}
            placeholder="e.g. Sous Chef — Bukhari" className={inputCls} />
        </Field>
        <Field label="Email">
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email"
            placeholder="staff@gsfoods.pk" className={inputCls} />
        </Field>
        <Field label="Phone" hint={derivedPin ? `PIN can derive to ${derivedPin}.` : undefined}>
          <input value={phone} onChange={(e) => setPhone(e.target.value)}
            placeholder="03XX-XXXXXXX" className={inputCls} />
        </Field>
        <Field label="Category">
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
            {CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>{c.emoji} {c.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Role enum" hint="Granular role inside the category — drives sidebar visibility.">
          <select value={role} onChange={(e) => setRole(e.target.value as AppRole)} className={inputCls}>
            {roleOptions.map((r) => (
              <option key={r} value={r}>{roleLabel(r)}</option>
            ))}
          </select>
        </Field>
        <Field label="PIN" hint={user.hasPin ? 'Type a new PIN to replace.' : 'Set a 4-digit PIN to enable login.'}>
          <div className="flex gap-2">
            <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              maxLength={8} placeholder={user.hasPin ? '• • • •' : (derivedPin || '4-digit PIN')}
              className={inputCls + ' flex-1'} />
            {derivedPin && (
              <button type="button" onClick={() => setPin(derivedPin)}
                className="rounded-lg px-3 py-2 text-xs font-bold border border-kds-border text-kds-subtext hover:text-kds-text whitespace-nowrap">
                Use {derivedPin}
              </button>
            )}
          </div>
        </Field>
      </div>

      {err && <p className="text-xs font-bold text-red-400">{err}</p>}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button onClick={() => save.mutate()} disabled={save.isPending}
          className="rounded-lg px-3 py-2 text-xs font-black bg-kds-green text-black hover:opacity-90 disabled:opacity-50">
          {save.isPending ? 'Saving…' : 'Save changes'}
        </button>
        <button onClick={onClose}
          className="rounded-lg px-3 py-2 text-xs font-bold border border-kds-border text-kds-subtext hover:text-kds-text">
          Cancel
        </button>

        {/* Lifecycle controls — pushed to the right */}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {status === 'pending' && (
            <>
              <button onClick={() => approve.mutate()} disabled={approve.isPending}
                className="rounded-md px-2 py-1.5 text-[11px] font-bold bg-amber-400/15 border border-amber-400/30 text-amber-400 hover:bg-amber-400/25">
                Approve
              </button>
              <button onClick={() => reject.mutate()} disabled={reject.isPending}
                className="rounded-md px-2 py-1.5 text-[11px] font-bold border border-kds-border text-kds-subtext hover:text-red-400 hover:border-red-400/40">
                Reject
              </button>
            </>
          )}
          {status === 'active' && (
            <button onClick={() => toggleActive.mutate()} disabled={toggleActive.isPending}
              className="rounded-md px-2 py-1.5 text-[11px] font-bold border border-kds-border text-kds-subtext hover:text-amber-400 hover:border-amber-400/40">
              Suspend
            </button>
          )}
          {status === 'suspended' && (
            <button onClick={() => toggleActive.mutate()} disabled={toggleActive.isPending}
              className="rounded-md px-2 py-1.5 text-[11px] font-bold border border-kds-border text-kds-subtext hover:text-emerald-400 hover:border-emerald-400/40">
              Reactivate
            </button>
          )}
          <button onClick={() => {
              if (window.confirm(`Delete ${user.name}? This soft-deletes — history is preserved.`)) remove.mutate()
            }} disabled={remove.isPending}
            className="rounded-md px-2 py-1.5 text-[11px] font-bold border border-kds-border text-kds-subtext hover:text-red-400 hover:border-red-400/40">
            🗑 Delete
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Add modal (minimal) ────────────────────────────────────────────────────

function AddStaffModal({
  onClose, onCreated,
}: { onClose: () => void; onCreated: (created: StaffUser | null) => void }) {
  const [name, setName]         = useState('')
  const [category, setCategory] = useState<string>('management')
  const [jobTitle, setJobTitle] = useState('')
  const [err, setErr]           = useState<string | null>(null)

  // Category drives the primary role enum value — first entry in roles[].
  const primaryRole = useMemo(() => {
    const c = CATEGORIES.find((cc) => cc.key === category)
    return c?.roles[0] ?? 'cashier'
  }, [category])

  const create = useMutation({
    mutationFn: () => api.post<StaffUser>('/auth/users', {
      ...(name.trim() ? { name: name.trim() } : {}),
      role: primaryRole,
      ...(jobTitle.trim() ? { jobTitle: jobTitle.trim() } : {}),
    }),
    onSuccess: (created) => onCreated(created ?? null),
    onError:   (e: unknown) => setErr(e instanceof Error ? e.message : 'Failed to create staff'),
  })

  function submit() {
    setErr(null)
    if (!jobTitle.trim()) return setErr('Type a role / job title so you remember who this is.')
    create.mutate()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-kds-card border border-kds-border rounded-2xl p-5 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}>
        <h2 className="font-black text-lg mb-1">Add staff</h2>
        <p className="text-xs text-kds-subtext mb-4">
          Pick a category and type their role. You can fill in name, email, phone, and PIN
          straight on the row right after.
        </p>

        <div className="space-y-2.5">
          <Field label="Category">
            <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
              {CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>{c.emoji} {c.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Role / job title" hint="Free text — what you actually call this role.">
            <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} autoFocus
              placeholder="e.g. Sous Chef — Bukhari, Floor Manager — Clifton, Procurement Officer"
              className={inputCls} />
          </Field>
          <Field label="Name (optional)" hint="Skip for now — fill in when you know who's joining.">
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ahmad Khan" className={inputCls} />
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
            {create.isPending ? 'Adding…' : 'Add staff →'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Small UI bits ───────────────────────────────────────────────────────────

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
