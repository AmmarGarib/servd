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
// itself on load; `?status=pending` opens the pending-signup queue (the CEO's
// sidebar badge points here — /configuration/pending-approvals is retired).
// Which roles may be ASSIGNED comes from the API (GET /permissions/role-modules
// → roles.assignable); the categories below only group and label them.

import { useState, useMemo, Suspense, useEffect } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, deleteWithUndo } from '../../lib/api'
import { roleLabel, type AppRole } from '../../lib/appRoles'
import { usePermissions } from '../../hooks/useCan'
import { useViewAllTenants } from '../../components/ui/TenantSwitcher'
import { PositionsView } from './positions/view'
import { Select } from '@/components/ui/Select'
import { Modal } from '@/components/ui/Modal'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { useIsPracticeCopy } from '@/components/SandboxBanner'
import { PersonModules } from '../../components/staff/PersonModules'
import { OffboardButtons } from '../../components/hr/OffboardButtons'
import { useAuthStore } from '../../store/auth'
import { NavIcon } from '../../components/ui/NavIcon'
import { CompactEmptyState } from '../../components/ui/CompactEmptyState'

interface TenantLite { id: string; name: string; slug: string }

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
  tenant?: TenantLite | null
  tenants?: TenantLite[]
  // Per-user module overrides on top of the role's baseline (enforced by the
  // API). Empty arrays = follow the role default exactly.
  moduleAllow?:     string[]
  moduleDeny?:      string[]
  // Stations this user is rostered to work. Drives /kds (Kitchen view) —
  // empty array = "not station-restricted" (admin/management/expediter
  // get every active station).
  stationIds?:      string[]
  // The login also belongs to a company the viewer is not in — only someone
  // in all of its companies can change it (the API answers 403).
  inOtherCompanies?: boolean
  // The linked HR employee record payroll would still pay (not separated),
  // in the viewer's companies. Switching a login off does not stop pay.
  payroll?: { employeeId: string; status: string; tenantId: string } | null
  // Director logins (owner, 2026-10-18): the brands they may see, read-only.
  directorConceptIds?: string[]
}

// Category → which AppRole values fall under it. A single user has one role
// enum value, but the directory groups them so the CEO picks "Front of House"
// once and we resolve to the primary enum value (the first in `roles`).
interface Category {
  key: string
  label: string
  icon: string
  blurb: string
  /** First entry is the canonical/primary role enum value for new staff. */
  roles: AppRole[]
  /** Optional deep-link to a richer specialist view (kitchen-staff brigade). */
  specialistHref?: string
  specialistLabel?: string
}

const CATEGORIES: Category[] = [
  {
    key: 'owners',
    label: 'Owners',
    icon: 'key',
    blurb: 'Co-owners — see what the CEO sees and approve staff work; their own submissions escalate to the CEO.',
    roles: ['owner'],
  },
  {
    key: 'management',
    label: 'Management',
    icon: 'briefcase',
    blurb: 'GMs, FOH & BOH leads, the F&B manager — the people who run the floor day-to-day.',
    roles: ['management', 'foh_management', 'boh_management', 'fnb_manager'],
  },
  {
    key: 'foh',
    label: 'Front of House',
    icon: 'user',
    blurb: 'Servers, hosts, cashiers — anyone customer-facing.',
    roles: ['foh', 'cashier'],
  },
  {
    key: 'boh',
    label: 'Back of House',
    icon: 'chef',
    blurb: 'Line cooks, expediters, KDS station operators.',
    roles: ['boh', 'kitchen', 'expediter'],
  },
  {
    key: 'procurement',
    label: 'Procurement',
    icon: 'factory',
    blurb: 'Supplier chat and POs. Sees deliveries at the dock; a manager receives.',
    roles: ['procurement'],
  },
  {
    key: 'marketing',
    label: 'Marketing',
    icon: 'rocket',
    blurb: 'Brand manager, CRM, campaigns, reviews, content calendar.',
    roles: ['marketing', 'brand_manager'],
  },
  {
    key: 'finance',
    label: 'Finance',
    icon: 'wallet',
    blurb: 'P&L, payroll, accounting, reconciliation.',
    roles: ['finance'],
  },
  {
    key: 'hr',
    label: 'HR',
    icon: 'users',
    blurb: 'Staff records, scheduling, compliance.',
    roles: ['hr'],
  },
  {
    key: 'it',
    label: 'IT / Dev',
    icon: 'plug',
    blurb: 'IT / developer — integrations, the user audit log, notifications, help.',
    roles: ['it'],
  },
  // Owner, 2026-10-18: brand partners (Yusuf and Ali, Flipd) — read-only
  // figures for the brands picked on their login. Only the CEO adds them.
  {
    key: 'directors',
    label: 'Directors',
    icon: 'eye',
    blurb: 'Brand partners — see how their brand is doing (sales, P&L, food cost, reviews), read-only. CEO only.',
    roles: ['director'],
  },
]

/**
 * The brands a director login may be given: every live brand of the CEO's
 * companies (GET /director/brands answers the CEO with exactly that list).
 */
function DirectorBrandPicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const { data, isLoading } = useQuery<{ brands: Array<{ id: string; name: string }> }>({
    queryKey: ['director', 'brands'],
    queryFn: () => api.get('/director/brands'),
    staleTime: 60_000,
  })
  const brands = data?.brands ?? []
  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-bold uppercase tracking-wider text-s-muted">
          Brands they may see <span className="text-red-700">*</span>
        </span>
        <span className="text-[10px] text-s-muted/70">Read-only. Nothing about any other brand.</span>
      </div>
      <div className="flex flex-wrap gap-2 rounded-lg border border-s-border bg-s-bg p-2">
        {isLoading && <span className="text-xs text-s-muted">Loading brands…</span>}
        {!isLoading && brands.length === 0 && <span className="text-xs text-s-muted">No brands in your companies.</span>}
        {brands.map((b) => {
          const checked = value.includes(b.id)
          return (
            <button key={b.id} type="button" onClick={() => toggle(b.id)} aria-pressed={checked}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-all ${
                checked
                  ? 'bg-accent-dim text-success border border-accent'
                  : 'bg-s-surface text-s-muted border border-s-border hover:border-accent/40'
              }`}>
              <NavIcon name={checked ? 'check' : 'plus'} size={12} />
              <span>{b.name}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

const STATUS_META: Record<StaffUser['accountStatus'], { label: string; color: string; bg: string }> = {
  active:    { label: 'Active',    color: 'var(--erp-success)', bg: 'rgb(var(--erp-accent-rgb) / 0.18)' },
  pending:   { label: 'Pending',   color: 'var(--erp-warning)', bg: 'color-mix(in srgb, var(--erp-warning) 10%, transparent)' },
  suspended: { label: 'Suspended', color: 'var(--erp-danger)', bg: 'color-mix(in srgb, var(--erp-danger) 10%, transparent)' },
}

// The API derives the status in one place (auth/accountStatus.ts) — including
// accounts switched off through the legacy isActive column — so the page
// reads it as given instead of re-deriving it.
function statusOf(u: StaffUser): StaffUser['accountStatus'] {
  return u.accountStatus
}

function categoryOf(role: AppRole): Category | undefined {
  return CATEGORIES.find((c) => c.roles.includes(role))
}

/**
 * Roles the API accepts on the staff editor (GET /permissions/role-modules →
 * roles.assignable). Null while loading, in which case callers fall back to
 * the category's own list — the API still validates every save.
 */
function useAssignableRoles(): Set<string> | null {
  const { data } = useQuery<{ roles?: { assignable?: string[] } }>({
    queryKey: ['permissions', 'role-modules'],
    queryFn:  () => api.get('/permissions/role-modules'),
    staleTime: 60_000,
  })
  const list = data?.roles?.assignable
  return list ? new Set(list) : null
}

/** First role of a category the API will accept — the "primary" for new staff. */
function primaryRoleOf(cat: Category | undefined, assignable: Set<string> | null): AppRole | undefined {
  if (!cat) return undefined
  return cat.roles.find((r) => !assignable || assignable.has(r))
}

function assignableCategories(assignable: Set<string> | null): Category[] {
  return CATEGORIES.filter((c) => !!primaryRoleOf(c, assignable))
}

// ─── Page ────────────────────────────────────────────────────────────────────

function WorkforcePageInner() {
  const router = useRouter()
  const qc = useQueryClient()
  const sp = useSearchParams()
  const { data: me } = usePermissions()
  const canEdit = me?.role === 'admin'
  const viewAll = useViewAllTenants()
  // Tenants the operator belongs to — drives the "transfer" dropdown in the
  // inline editor and lets the page show the brand chip even outside portfolio
  // mode (a single-tenant operator should still see *their* company name).
  const { data: tenants = [] } = useQuery<TenantLite[]>({
    queryKey: ['my-tenants'],
    queryFn:  () => api.get('/tenants/mine'),
    staleTime: 5 * 60_000,
  })

  const initialCategory = useMemo(() => {
    const raw = sp.get('category')
    if (raw) return raw
    const roleParam = sp.get('role')
    if (!roleParam) return 'all'
    const roles = roleParam.split(',').map((r) => r.trim()) as AppRole[]
    const hit = CATEGORIES.find((c) => roles.some((r) => c.roles.includes(r)))
    return hit?.key ?? 'all'
  }, [sp])

  const initialStatus = useMemo<'all' | StaffUser['accountStatus']>(() => {
    const raw = sp.get('status')
    return raw === 'pending' || raw === 'active' || raw === 'suspended' ? raw : 'all'
  }, [sp])

  const [activeCategory, setActiveCategory] = useState<string>(initialCategory)
  const [statusFilter, setStatusFilter] = useState<'all' | StaffUser['accountStatus']>(initialStatus)
  const [search, setSearch] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  // Inline edit: which row, if any, is in edit mode.
  const [editingId, setEditingId] = useState<string | null>(null)
  // Top-level tab: 'positions' = budgeted seats (what we plan to pay for);
  // 'people' = the actual humans hired into those seats. URL ?tab=positions
  // persists the choice so a bookmark stays on the right view.
  const [activeTab, setActiveTab] = useState<'people' | 'positions'>(
    sp.get('tab') === 'positions' ? 'positions' : 'people',
  )

  // The sidebar's Workforce children navigate to /workforce?tab=… and
  // /workforce?category=… . When the page is ALREADY mounted, only the query
  // string changes — useState initialisers don't re-run — so without this
  // sync those links look dead. React to query changes live.
  useEffect(() => {
    setActiveTab(sp.get('tab') === 'positions' ? 'positions' : 'people')
  }, [sp])
  useEffect(() => {
    setActiveCategory(initialCategory)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCategory])
  useEffect(() => {
    setStatusFilter(initialStatus)
  }, [initialStatus])

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

  // Who added each pending login (team leads add logins for their own roles —
  // POST /auth/staff/invite) — from the CEO's queue, GET /auth/staff/pending.
  // Same cache key as the sidebar badge.
  const { data: pendingQueue = [] } = useQuery<Array<{ id: string; invitedBy?: { id: string; name: string } | null; tenantId?: string | null }>>({
    queryKey: ['staff', 'pending'],
    queryFn:  () => api.get('/auth/staff/pending'),
    enabled:  canEdit,
    refetchInterval: 30_000,
    staleTime: 15_000,
  })
  const invitedBy = useMemo(() => new Map(pendingQueue.map((p) => [p.id, p.invitedBy ?? null])), [pendingQueue])

  return (
    <div className="min-h-screen bg-s-bg text-s-text">
      <div className="border-b border-s-border bg-s-surface">
        <div className="max-w-6xl mx-auto px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-black">Workforce</h1>
              <p className="text-sm text-s-muted mt-1">
                {activeTab === 'positions'
                  ? 'Every seat the org pays for, filled or not. Edits flow live into /finance/opex + projections.'
                  : <>Every staff member, every category. {users.length} total · <span className={pendingCount > 0 ? 'text-amber-700 font-bold' : ''}>{pendingCount} pending</span></>}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {pendingCount > 0 && statusFilter !== 'pending' && (
                <button
                  onClick={() => { setActiveTab('people'); setActiveCategory('all'); setStatusFilter('pending'); router.replace('/workforce?status=pending') }}
                  className="rounded-lg px-3 py-2 text-xs font-bold border transition-colors"
                  style={{ background: 'color-mix(in srgb, var(--erp-warning) 10%, transparent)', borderColor: 'color-mix(in srgb, var(--erp-warning) 35%, transparent)', color: 'var(--erp-warning)' }}>
                  ⏳ Review {pendingCount} pending
                </button>
              )}
              {(canEdit || me?.role === 'hr') && activeTab === 'people' && (
                <button onClick={() => setAddOpen(true)}
                  className="rounded-lg px-3 py-2 text-xs font-black bg-primary text-primary-on hover:opacity-90">
                  + Add staff
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Top-level tabs: People (actual humans) vs Positions (budgeted seats).
          Two faces of "workforce" — the org chart in head vs the org chart
          on the ground. Positions feed live into /finance/opex; People drive
          access, scheduling, payroll runs. */}
      <div className="max-w-6xl mx-auto px-6 pt-4 border-b border-s-border">
        <div className="flex gap-2">
          <button onClick={() => { setActiveTab('people'); router.replace('/workforce') }}
            className="px-4 py-2.5 text-sm font-bold transition-colors"
            style={activeTab === 'people'
              ? { color: 'var(--erp-primary-ink)', borderBottom: '2px solid var(--erp-accent)', marginBottom: '-1px' }
              : { color: 'rgb(var(--fg-rgb) / 0.5)' }}>
            <NavIcon name="users" size={14} className="mr-1.5 inline" />People ({users.length})
          </button>
          <button onClick={() => { setActiveTab('positions'); router.replace('/workforce?tab=positions') }}
            className="px-4 py-2.5 text-sm font-bold transition-colors"
            style={activeTab === 'positions'
              ? { color: 'var(--erp-primary-ink)', borderBottom: '2px solid var(--erp-accent)', marginBottom: '-1px' }
              : { color: 'rgb(var(--fg-rgb) / 0.5)' }}>
            <NavIcon name="briefcase" size={14} className="mr-1.5 inline" />Positions (budget)
          </button>
        </div>
      </div>

      {/* Positions tab renders the budgeted-seats view inline. Same code as
          /workforce/positions standalone — single source of truth via the
          named PositionsView export. embedded=true skips the inner header
          since the Workforce page already provides one. */}
      {activeTab === 'positions' && <PositionsView embedded />}

      {activeTab === 'people' && (
      <div className="max-w-6xl mx-auto px-6 pt-5">
        <div className="flex flex-wrap gap-2">
          <CategoryChip
            label="All staff" icon="users" count={users.length}
            active={activeCategory === 'all'}
            onClick={() => { setActiveCategory('all'); router.replace('/workforce') }}
          />
          {CATEGORIES.filter((c) => (countsByCategory.get(c.key) ?? 0) > 0 || activeCategory === c.key).map((c) => (
            <CategoryChip
              key={c.key} label={c.label} icon={c.icon}
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
                  active ? 'bg-accent-dim text-success ring-1 ring-inset ring-accent' : 'text-s-muted hover:bg-s-surface hover:text-s-text'
                }`}>
                {s === 'all' ? 'All status' : s}
              </button>
            )
          })}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email or job title…"
            className="ml-auto rounded-lg px-3 py-1.5 text-sm bg-s-surface border border-s-border focus:border-primary focus:outline-none w-64"
          />
        </div>

        <div className="mt-4 mb-12 rounded-xl border border-s-border bg-s-surface overflow-hidden">
          {isLoading && <div className="p-8 text-center text-sm text-s-muted">Loading staff…</div>}
          {!isLoading && filtered.length === 0 && (
            <div className="p-6"><CompactEmptyState icon={<NavIcon name="inbox" size={28} />} message="No staff here yet" detail={statusFilter === 'pending'
                  ? 'Nobody is waiting for approval.'
                  : activeCategory === 'all'
                    ? 'Tap + Add staff to create an account.'
                    : `No ${CATEGORIES.find((c) => c.key === activeCategory)?.label} staff on file. Add one to get started.`} /></div>
          )}
          {filtered.map((u) => (
            <StaffRow
              key={u.id} user={u} canEdit={canEdit}
              // HR onboards and offboards (owner, 2026-10-15): Offboard /
              // Reinstate on the row; the CEO has them in the editor.
              hrOffboard={me?.role === 'hr'}
              tenants={tenants}
              invitedBy={invitedBy.has(u.id) ? (invitedBy.get(u.id) ?? null) : undefined}
              // Chip is mostly noise in single-tenant view (every row belongs
              // to the same company). Only render it when the operator is
              // looking across companies, OR when the row is orphaned —
              // those always need a "No company" badge.
              showTenantChip={viewAll}
              expanded={editingId === u.id}
              onExpand={() => setEditingId(editingId === u.id ? null : u.id)}
              onClose={() => setEditingId(null)}
              onChange={() => void qc.invalidateQueries({ queryKey: ['workforce'] })}
            />
          ))}
        </div>
      </div>
      )}


      {addOpen && (
        <AddStaffModal
          asHr={me?.role === 'hr'}
          tenants={tenants}
          viewAll={viewAll}
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
    <Suspense fallback={<div className="p-8 text-sm text-s-muted">Loading…</div>}>
      <WorkforcePageInner />
    </Suspense>
  )
}

// ─── Components ──────────────────────────────────────────────────────────────

function CategoryChip({
  label, icon, count, active, onClick,
}: { label: string; icon: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-all ${
        active
          ? 'bg-accent-dim border border-accent text-s-text'
          : 'bg-s-surface border border-s-border text-s-text hover:border-primary/40'
      }`}>
      <NavIcon name={icon} size={14} />
      <span>{label}</span>
      <span className={`text-[10px] font-black ${active ? 'opacity-60' : 'text-s-muted'}`}>{count}</span>
    </button>
  )
}

function CategoryBlurb({ category }: { category: Category }) {
  return (
    <div className="mt-3 flex items-center gap-3 rounded-lg border border-s-border bg-s-surface/50 px-4 py-2.5">
      <span className="text-primary-ink"><NavIcon name={category.icon} size={20} /></span>
      <p className="text-xs text-s-muted flex-1">{category.blurb}</p>
      {category.specialistHref && (
        <Link href={category.specialistHref}
          className="text-xs font-bold text-primary-ink hover:opacity-80">
          {category.specialistLabel ?? 'Open ›'}
        </Link>
      )}
    </div>
  )
}

// ─── Staff row + inline editor ──────────────────────────────────────────────

function StaffRow({
  user, canEdit, tenants, showTenantChip, invitedBy, hrOffboard,
  expanded, onExpand, onClose, onChange,
}: {
  user: StaffUser; canEdit: boolean
  /** HR viewing: show Offboard / Reinstate on the row. */
  hrOffboard?: boolean
  /** Set when the viewer may hand this person a one-time sign-in code. */
  tenants: TenantLite[]
  /** Pending rows only: who added the login (null = self sign-up). */
  invitedBy?: { id: string; name: string } | null
  showTenantChip: boolean
  expanded: boolean
  onExpand: () => void
  onClose: () => void
  onChange: () => void
}) {
  const status = statusOf(user)
  const statusM = STATUS_META[status]
  const cat = categoryOf(user.role)
  const isUnnamed = !user.name || user.name === 'Unnamed staff'
  // Tenant chip: prefer the hydrated `tenant` relation; fall back to looking
  // up tenantId in the operator's tenant list (single-tenant view doesn't
  // always include the relation). Null tenantId → "No company" warning.
  const tenant: TenantLite | null =
    user.tenant
    ?? (user.tenantId ? tenants.find((t) => t.id === user.tenantId) ?? null : null)

  return (
    <div className="border-b border-s-border last:border-b-0">
      <div className="flex items-stretch">
      <button
        type="button"
        onClick={canEdit ? onExpand : undefined}
        disabled={!canEdit}
        className={`flex-1 min-w-0 flex items-center gap-3 px-4 py-3 text-left transition-colors ${
          canEdit ? 'hover:bg-s-bg/30 cursor-pointer' : 'cursor-default'
        } ${expanded ? 'bg-s-bg/40' : ''}`}>
        <div className="h-9 w-9 shrink-0 rounded-full flex items-center justify-center text-sm font-black"
          style={{
            background: isUnnamed
              ? 'rgb(var(--fg-rgb) / 0.06)'
              : 'linear-gradient(135deg, rgb(var(--erp-primary-rgb) / 0.4), rgb(var(--ink-rgb) / 0.4))',
            color: isUnnamed ? 'rgb(var(--fg-rgb) / 0.4)' : 'var(--text)',
          }}>
          {isUnnamed ? '?' : user.name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className={`font-semibold text-sm truncate ${isUnnamed ? 'italic text-s-muted' : ''}`}>
              {isUnnamed ? 'Unnamed staff — tap to fill in' : user.name}
            </p>
            <span className="shrink-0 text-[9px] uppercase tracking-wider font-bold rounded px-1.5 py-0.5"
              style={{ background: statusM.bg, color: statusM.color }}>
              {statusM.label}
            </span>
            {/* Switched off here, still paid there: HR payroll reads only the
                employee record. Open the row for the link to HR. */}
            {status === 'suspended' && user.payroll && (
              <span className="shrink-0 text-[9px] uppercase tracking-wider font-bold rounded px-1.5 py-0.5"
                style={{ background: 'color-mix(in srgb, var(--erp-warning) 12%, transparent)', color: 'var(--erp-warning)' }}
                title="This login is switched off, but the person is still on payroll in HR. Start a separation in HR to stop pay.">
                Still on payroll
              </span>
            )}
            {/* Brand chips — one per tenant the staff member is a member of.
                Primary tenant first, additional memberships after. Hidden in
                single-tenant view (every row would carry the same chips). */}
            {/* A pending login always names its company — the CEO is
                approving access to THAT company. */}
            {(showTenantChip || status === 'pending') && (user.tenants ?? (tenant ? [tenant] : [])).map((t) => (
              <span key={t.id} className="shrink-0 text-[9px] uppercase tracking-wider font-bold rounded px-1.5 py-0.5"
                style={{ background: 'rgb(var(--ink-rgb) / 0.15)', color: 'var(--erp-primary-ink)' }}>
                {t.name}
              </span>
            ))}
            {/* Orphan warning — always shown, regardless of view mode. A row
                with no company is a data bug; surface it everywhere. */}
            {!user.tenantId && (
              <span className="shrink-0 text-[9px] uppercase tracking-wider font-bold rounded px-1.5 py-0.5"
                style={{ background: 'color-mix(in srgb, var(--erp-danger) 10%, transparent)', color: 'var(--erp-danger)' }}
                title="This staff row has no company assigned. Tap to fix.">
                No company
              </span>
            )}
          </div>
          <p className="text-xs text-s-muted truncate">
            {user.jobTitle && <span className="text-s-text font-medium">{user.jobTitle}</span>}
            {user.jobTitle && (user.email || user.phone) && <span> · </span>}
            {user.email}{user.email && user.phone ? ' · ' : ''}{user.phone}
            {!user.jobTitle && !user.email && !user.phone && (
              <span className="italic">No contact details yet</span>
            )}
          </p>
          {status === 'pending' && invitedBy !== undefined && (
            <p className="text-[11px] text-amber-700/80 truncate">
              {invitedBy ? <>Added by <span className="font-bold">{invitedBy.name}</span></> : 'Signed up themselves'}
              {tenant && <> · {tenant.name}</>}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[11px] font-bold text-s-text">
            {cat?.label ?? roleLabel(user.role)}
          </p>
          <p className="text-[10px] text-s-muted mt-0.5">
            {user.jobTitle ? roleLabel(user.role) : 'No role title set'}
          </p>
        </div>
        {canEdit && (
          <span className="shrink-0 text-s-muted"
            style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 120ms' }}>
            ▶
          </span>
        )}
      </button>
      {hrOffboard && (
        <div className="shrink-0 flex items-center pr-3">
          <OffboardButtons login={{ id: user.id, name: user.name, role: user.role, status }} onDone={onChange} />
        </div>
      )}
      </div>

      {expanded && canEdit && (
        <InlineEditor user={user} status={status} tenants={tenants}
          onChange={onChange} onClose={onClose} />
      )}
    </div>
  )
}

function InlineEditor({
  user, status, tenants, onChange, onClose,
}: {
  user: StaffUser
  status: StaffUser['accountStatus']
  tenants: TenantLite[]
  onChange: () => void
  onClose: () => void
}) {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [name, setName]         = useState(user.name === 'Unnamed staff' ? '' : user.name)
  const [email, setEmail]       = useState(user.email ?? '')
  const [phone, setPhone]       = useState(user.phone ?? '')
  const [jobTitle, setJobTitle] = useState(user.jobTitle ?? '')
  const assignable = useAssignableRoles()
  const [category, setCategory] = useState<string>(categoryOf(user.role)?.key ?? '')
  const [role, setRole]         = useState<AppRole>(user.role)
  // Primary company (anchor — drives User.tenantId).
  const [tenantId, setTenantId] = useState<string>(user.tenantId ?? '')
  // Every company this user works for. Backend treats this as the source of
  // truth for TenantMember rows. Primary is auto-included on save.
  const [tenantIds, setTenantIds] = useState<string[]>(
    (user.tenants ?? []).map((t) => t.id)
  )
  const [pin, setPin]           = useState('')
  const [err, setErr]           = useState<string | null>(null)
  // Station assignments — drives /kds (Kitchen view). Empty list means
  // "every active station" for unrestricted roles. We let the operator
  // assign stations to anyone (not just kitchen) so an FOH manager can
  // open Kitchen view scoped to one brand's stations if they want.
  const [stationIds, setStationIds] = useState<string[]>(user.stationIds ?? [])
  // Director logins (owner, 2026-10-18): the brands they may see. Their
  // companies follow the brands (the API sets them), so the company, PIN and
  // station pickers are not shown for a director.
  const [directorBrands, setDirectorBrands] = useState<string[]>(user.directorConceptIds ?? [])
  const isDirectorRow = role === 'director'

  function toggleTenant(id: string) {
    setTenantIds((cur) => cur.includes(id) ? cur.filter((t) => t !== id) : [...cur, id])
  }
  function toggleStation(id: string) {
    setStationIds((cur) => cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id])
  }

  // Pull the full station list once per drawer open so the picker can
  // group by concept. We rely on the same /kds/stations endpoint the
  // sidebar uses; managers always have access.
  const { data: allStations = [] } = useQuery<Array<{ id: string; name: string; conceptId: string; isActive: boolean; concept: { name: string } }>>({
    queryKey: ['kds-stations-all'],
    queryFn:  () => api.get('/kds/stations'),
    staleTime: 60_000,
  })
  const stationsByConcept = useMemo(() => {
    const byConcept = new Map<string, { conceptName: string; stations: typeof allStations }>()
    for (const s of allStations) {
      if (!s.isActive) continue
      const g = byConcept.get(s.conceptId) ?? { conceptName: s.concept.name, stations: [] }
      g.stations.push(s)
      byConcept.set(s.conceptId, g)
    }
    for (const g of byConcept.values()) g.stations.sort((a, b) => a.name.localeCompare(b.name))
    return Array.from(byConcept.entries())
      .map(([conceptId, g]) => ({ conceptId, ...g }))
      .sort((a, b) => a.conceptName.localeCompare(b.conceptName))
  }, [allStations])

  // Keep role consistent with category — but ONLY when the operator picks a
  // category. This used to run on mount too, so opening any account whose
  // role sat in no category (legacy 'manager', 'owner') silently rewrote its
  // role to the Management primary on the next save — a promotion to the
  // company P&L nobody asked for.
  function pickCategory(key: string) {
    setCategory(key)
    const cat = CATEGORIES.find((c) => c.key === key)
    if (cat && !cat.roles.includes(role)) {
      const primary = primaryRoleOf(cat, assignable)
      if (primary) setRole(primary)
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      const patch: Record<string, unknown> = {}
      if (name.trim() && name.trim() !== user.name) patch.name = name.trim()
      if (email.trim() !== (user.email ?? '')) patch.email = email.trim()
      if (phone.trim() !== (user.phone ?? '')) patch.phone = phone.trim()
      if (jobTitle.trim() !== (user.jobTitle ?? '')) patch.jobTitle = jobTitle.trim()
      if (role !== user.role) patch.role = role
      if (isDirectorRow) {
        if (directorBrands.length === 0) throw new Error('Pick at least one brand this director may see.')
        const before = (user.directorConceptIds ?? []).slice().sort().join(',')
        if (role !== user.role || before !== directorBrands.slice().sort().join(',')) patch.directorConceptIds = directorBrands
      } else {
        if (tenantId && tenantId !== (user.tenantId ?? '')) patch.tenantId = tenantId
        const existingIds = (user.tenants ?? []).map((t) => t.id).sort().join(',')
        const nextIds = [...tenantIds].sort().join(',')
        if (existingIds !== nextIds) patch.tenantIds = tenantIds
        if (pin.trim()) patch.pin = pin.trim()
      }

      // Station assignments — full replacement. Compare sorted-joined strings
      // so order-only diffs don't trigger a no-op PATCH.
      const existingStations = (user.stationIds ?? []).slice().sort().join(',')
      const nextStations     = stationIds.slice().sort().join(',')
      if (!isDirectorRow && existingStations !== nextStations) patch.stationIds = stationIds

      if (Object.keys(patch).length > 0) {
        await api.patch(`/auth/users/${user.id}`, patch)
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['permissions', 'me'] })
      onChange(); onClose()
    },
    onError:   (e: unknown) => setErr(e instanceof Error ? e.message : 'Failed to save'),
  })

  // Every lifecycle action shows the API's reason when it is refused — e.g.
  // approve without a phone (PHONE_REQUIRED), a number already on another
  // login (PHONE_IN_USE), or a login shared with another company (403).
  const showErr = (e: unknown) => setErr(e instanceof Error ? e.message : 'That did not work')
  const remove = useMutation({
    mutationFn: () => deleteWithUndo(`/auth/users/${user.id}`, { trashType: 'login', id: user.id, label: user.name, onRestored: () => onChange() }),
    onSuccess:  () => { onChange(); onClose() },
    onError:    showErr,
  })
  const approve = useMutation({
    mutationFn: () => api.patch(`/auth/staff/${user.id}/approve`, {}),
    onSuccess:  () => onChange(),
    onError:    showErr,
  })
  const reject = useMutation({
    mutationFn: () => api.patch(`/auth/staff/${user.id}/reject`, {}),
    onSuccess:  () => onChange(),
    onError:    showErr,
  })
  // Reissuing a password is the ONLY remedy for a forgotten one: self-service
  // change needs the current password, and there is no email reset flow. The
  // new password comes back once and is held on screen until dismissed —
  // closing without copying means issuing another.
  const [reissued, setReissued] = useState<string | null>(null)
  const [reissuedCopied, setReissuedCopied] = useState(false)
  const reissue = useMutation({
    mutationFn: () => api.post<{ temporaryPassword: string }>(`/auth/users/${user.id}/reissue-password`, {}),
    onSuccess: (r) => setReissued(r?.temporaryPassword ?? null),
    onError:   showErr,
  })

  const toggleActive = useMutation({
    mutationFn: () => api.patch(`/auth/users/${user.id}`, { isActive: !user.isActive }),
    onSuccess:  () => onChange(),
    onError:    showErr,
  })

  // Offboard / reinstate (owner, 2026-10-15) go through the same routes HR
  // uses (POST /auth/staff/:id/offboard|reinstate). Another CEO login is not
  // offboarded there, so it keeps the staff editor's switch.
  const myId = useAuthStore((st) => st.user?.id ?? '')
  // Per-person module access is the CEO's (owner, 2026-10-20: "Module access belongs in CEO, only presets in HR").
  const iAmCeo = useAuthStore((st) => st.user?.role === 'admin')
  const offboard = useMutation({
    mutationFn: (reason: string) => api.post(`/auth/staff/${user.id}/offboard`, { reason }),
    onSuccess:  () => onChange(),
    onError:    showErr,
  })
  const reinstate = useMutation({
    mutationFn: () => api.post(`/auth/staff/${user.id}/reinstate`, {}),
    onSuccess:  () => onChange(),
    onError:    showErr,
  })
  async function suspend() {
    // Switching a login off does not stop pay — HR payroll reads only the
    // employee record. Say so at the moment it matters.
    const r = await confirm({
      title: `Offboard ${user.name}?`,
      body: user.payroll
        ? `${user.name} is still on payroll in HR. Offboarding stops them signing in and ends every session, but they will keep being paid until HR records a separation.`
        : 'Their login is switched off and every session ends now.',
      confirmLabel: 'Offboard', danger: true, reason: { label: 'Reason', minLength: 3 },
    })
    if (!r) return
    if (user.role === 'admin') toggleActive.mutate()
    else offboard.mutate(r.reason ?? '')
  }
  function unsuspend() {
    if (user.role === 'admin') toggleActive.mutate()
    else reinstate.mutate()
  }

  return (
    <form className="bg-s-bg/30 border-t border-s-border px-4 py-4 space-y-3"
      onSubmit={(e) => { e.preventDefault(); if (!save.isPending) save.mutate() }}>
      {user.inOtherCompanies && (
        <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-800">
          This login also works for a company you are not part of. Its role, status and password apply there too,
          so only someone in all of its companies can change it.
        </p>
      )}
      {status === 'suspended' && user.payroll && (
        <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-800">
          Switched off here, but still on payroll in HR (status: {user.payroll.status}). Suspending a login does not stop pay.{' '}
          <Link href={`/hr/employees/${user.payroll.employeeId}`} className="font-bold underline">
            Open their HR record to start a separation
          </Link>
        </p>
      )}
      {/* Per-person module access (owner, 2026-10-15) — the CEO's ticks for
          this person, on top of the role preset. */}
      {iAmCeo && (
        <details open className="rounded-lg border border-s-border bg-s-surface px-3 py-2">
          <summary className="cursor-pointer text-xs font-black text-s-text">What they can open</summary>
          <div className="mt-2"><PersonModules userId={user.id} /></div>
        </details>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} name="staff-name" autoComplete="off"
            placeholder="e.g. Ahmad Khan" className={inputCls} />
        </Field>
        <Field label="Job title" hint="What the role is called day-to-day.">
          <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)}
            placeholder="e.g. Sous Chef — Bukhari" className={inputCls} />
        </Field>
        <Field label="Email">
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" name="staff-email"
            autoComplete="off" autoCapitalize="none" spellCheck={false}
            placeholder="staff@gsfoods.pk" className={inputCls} />
        </Field>
        <Field label="Phone" hint="Optional. One number per login.">
          <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" inputMode="tel" name="staff-phone"
            autoComplete="off" placeholder="03XX-XXXXXXX" className={inputCls} />
        </Field>
        <Field label="Category">
          <Select value={category} onChange={(e) => pickCategory(e.target.value)} className={inputCls}>
            {/* A role in no category (legacy 'manager') keeps its own entry so
                opening the row never changes it. */}
            {!categoryOf(user.role) && <option value="">{roleLabel(user.role)} (unchanged)</option>}
            {assignableCategories(assignable).map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </Select>
        </Field>
        {/* Manager-override PIN: typed at the till to approve an over-cap
            discount, void, comp, refund, petty-cash top-up or staff meal. Only
            the management tiers can approve with it. It is never derived from
            the phone number — the last four digits of a phone are public. */}
        {isDirectorRow ? (
          <div className="md:col-span-2">
            <DirectorBrandPicker value={directorBrands} onChange={setDirectorBrands} />
          </div>
        ) : (<>
        <Field label="Override PIN" hint={user.hasPin ? 'Type a new PIN to replace.' : '6–8 digits, not guessable.'}>
          <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            maxLength={8} inputMode="numeric" autoComplete="off" name="override-pin" placeholder={user.hasPin ? '• • • •' : '6–8 digit PIN'}
            className={inputCls} />
        </Field>
        {tenants.length > 0 && (
          <div className="md:col-span-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-bold uppercase tracking-wider text-s-muted">
                Companies {!user.tenantId && <span className="text-red-700">— orphan, pick at least one</span>}
              </span>
              <span className="text-[10px] text-s-muted/70">
                Tick every company this person works for. The first one is their primary.
              </span>
            </div>
            <div className="flex flex-wrap gap-2 rounded-lg border border-s-border bg-s-bg p-2">
              {tenants.map((t) => {
                const checked = tenantIds.includes(t.id)
                const isPrimary = tenantId === t.id
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggleTenant(t.id)}
                    className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-all ${
                      checked
                        ? 'bg-accent-dim text-success border border-accent'
                        : 'bg-s-surface text-s-muted border border-s-border hover:border-accent/40'
                    }`}>
                    <NavIcon name={checked ? 'check' : 'plus'} size={12} />
                    <span>{t.name}</span>
                    {isPrimary && <span className="text-[9px] uppercase tracking-wider opacity-70">primary</span>}
                  </button>
                )
              })}
            </div>
            {tenantIds.length > 1 && (
              <div className="mt-2 flex items-center gap-2 text-[11px] text-s-muted">
                <span>Primary company:</span>
                <Select value={tenantId} onChange={(e) => setTenantId(e.target.value)}
                  className="rounded-md border border-s-border bg-s-bg px-2 py-1 text-xs focus:border-primary focus:outline-none">
                  {tenantIds.map((id) => {
                    const t = tenants.find((tt) => tt.id === id)
                    return t ? <option key={id} value={id}>{t.name}</option> : null
                  })}
                </Select>
              </div>
            )}
          </div>
        )}
        </>)}
      </div>

      {/* ── Station assignments ──────────────────────────────────────────
          Drives /kds (Kitchen view) — empty means "every active station"
          for unrestricted roles. Most useful on the line-cook role: tick
          the stations this cook actually works (Grill, Tandoor) so they
          land on a focused dashboard. Stations are grouped by concept so
          duplicate names across brands stay distinguishable. */}
      {!isDirectorRow && stationsByConcept.length > 0 && (
        <div className="rounded-lg border border-s-border bg-s-bg/60 p-3 space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-s-muted">
                Kitchen stations
              </p>
              <p className="text-[10px] text-s-muted/80 mt-0.5">
                Stations this person works. Empty = not restricted (sees every active station in Kitchen view).
              </p>
            </div>
            {stationIds.length > 0 && (
              <button type="button" onClick={() => setStationIds([])}
                className="text-[10px] text-s-muted hover:text-s-text underline">
                Clear all
              </button>
            )}
          </div>
          <div className="space-y-2">
            {stationsByConcept.map((g) => (
              <div key={g.conceptId}>
                <p className="text-[10px] font-bold uppercase tracking-wider text-s-muted mb-1">{g.conceptName}</p>
                <div className="flex flex-wrap gap-1.5">
                  {g.stations.map((s) => {
                    const checked = stationIds.includes(s.id)
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => toggleStation(s.id)}
                        className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold transition-all ${
                          checked
                            ? 'bg-accent-dim text-success border border-accent'
                            : 'bg-s-surface text-s-muted border border-s-border hover:border-accent/40'
                        }`}>
                        <NavIcon name={checked ? 'check' : 'plus'} size={12} />
                        <span>{s.name}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {err && <p className="text-xs font-bold text-red-700">{err}</p>}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button type="submit" disabled={save.isPending}
          className="rounded-lg px-3 py-2 text-xs font-black bg-primary text-primary-on hover:opacity-90 disabled:opacity-50">
          {save.isPending ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" onClick={onClose}
          className="rounded-lg px-3 py-2 text-xs font-bold border border-s-border text-s-muted hover:text-s-text">
          Cancel
        </button>

        {/* Lifecycle controls — pushed to the right */}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {status === 'pending' && (
            <>
              {!user.tenantId && (
                <span className="text-[10px] text-amber-700">Tick a company and save before approving.</span>
              )}
              <button type="button" onClick={() => approve.mutate()} disabled={approve.isPending || !user.tenantId}
                title='They are sent a link to set their password when email or WhatsApp is set up; otherwise use "New password" afterwards.'
                className="rounded-md px-2 py-1.5 text-[11px] font-bold bg-amber-400/15 border border-amber-400/30 text-amber-700 hover:bg-amber-400/25">
                Approve
              </button>
              <button type="button" onClick={() => reject.mutate()} disabled={reject.isPending}
                className="rounded-md px-2 py-1.5 text-[11px] font-bold border border-s-border text-s-muted hover:text-red-700 hover:border-red-400/40">
                Reject
              </button>
            </>
          )}
          {status === 'active' && user.id !== myId && (
            <button type="button" onClick={suspend} disabled={toggleActive.isPending || offboard.isPending}
              className="rounded-md px-2 py-1.5 text-[11px] font-bold border border-s-border text-s-muted hover:text-amber-700 hover:border-amber-400/40">
              Offboard
            </button>
          )}
          {status === 'suspended' && (
            <button type="button" onClick={unsuspend} disabled={toggleActive.isPending || reinstate.isPending}
              className="rounded-md px-2 py-1.5 text-[11px] font-bold border border-s-border text-s-muted hover:text-primary-ink hover:border-primary/40">
              Reinstate
            </button>
          )}
          <button type="button" onClick={async () => {
              if (await confirm({
                title: `Issue a new password for ${user.name}?`,
                body: 'Their current one stops working immediately and they will be signed out everywhere.',
                confirmLabel: 'Issue new password', danger: true,
              })) reissue.mutate()
            }} disabled={reissue.isPending}
            className="rounded-md px-2 py-1.5 text-[11px] font-bold border border-s-border text-s-muted hover:text-primary-ink hover:border-primary/40">
            {reissue.isPending ? 'Issuing…' : 'New password'}
          </button>
          <button type="button" onClick={async () => {
              if (await confirm({
                title: `Delete ${user.name}?`,
                body: 'This soft-deletes — history is preserved.',
                confirmLabel: 'Delete', danger: true,
              })) remove.mutate()
            }} disabled={remove.isPending}
            className="rounded-md px-2 py-1.5 text-[11px] font-bold border border-s-border text-s-muted hover:text-red-700 hover:border-red-400/40">
            <NavIcon name="trash" size={13} className="mr-1 inline" />Delete
          </button>
        </div>

        {/* The reissued password, held on screen until dismissed. Only a hash
            is stored, so this is the only moment it exists in readable form. */}
        {reissued && (
          <div className="mt-3 rounded-lg border border-accent/60 bg-accent-dim p-3">
            <div className="text-[10px] uppercase tracking-wider text-success mb-1">
              New password for {user.name} — shown once
            </div>
            <div className="font-mono text-sm font-bold text-success break-all mb-2 select-all cursor-text"
              onClick={(e) => selectText(e.currentTarget)}>{reissued}</div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  void copyText(reissued).then((ok) => setReissuedCopied(ok))
                }}
                className={`rounded-md px-2 py-1 text-[11px] font-bold border hover:border-primary/40 ${reissuedCopied ? 'border-accent text-success' : 'border-s-border text-s-text'}`}>
                {reissuedCopied ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={() => { setReissued(null); setReissuedCopied(false) }}
                className="rounded-md px-2 py-1 text-[11px] font-bold text-s-muted hover:text-s-text">
                Done
              </button>
            </div>
            <p className="text-[10px] text-s-muted/70 mt-2">
              They can set their own from the &ldquo;Change my password&rdquo; link on the sign-in page.
            </p>
          </div>
        )}
      </div>
    </form>
  )
}

// ─── Add modal (minimal) ────────────────────────────────────────────────────

function AddStaffModal({
  asHr = false, tenants, viewAll, onClose, onCreated,
}: {
  /** HR adds through POST /auth/staff/invite (owner, 2026-10-15/16): floor logins are active at once, every
   *  other role waits for the CEO; never the CEO or a co-owner seat; HR's active company. */
  asHr?: boolean
  tenants: TenantLite[]; viewAll: boolean
  onClose: () => void; onCreated: (created: StaffUser | null) => void
}) {
  const [name, setName]         = useState('')
  const [email, setEmail]       = useState('')
  const [phone, setPhone]       = useState('')
  const [category, setCategory] = useState<string>('management')
  // Practice copy (owner, 2026-10-15): a name and a role are enough; the
  // server generates the sign-in email and every login gets a password.
  const practice = useIsPracticeCopy()
  const [jobTitle, setJobTitle] = useState('')
  // The generated password, shown ONCE after creation. It is never
  // retrievable again — only the bcrypt hash is stored — so if this screen
  // does not surface it, the account it just made is one nobody can sign into.
  const [issued, setIssued] = useState<{ name: string; email: string; password: string } | null>(null)
  const [copied, setCopied] = useState(false)
  // Multi-tenant from the get-go: head-office hires (procurement, finance,
  // HR, marketing) typically work across every company. Default to the
  // operator's currently active tenant when single-tenant; empty in
  // portfolio view so the operator picks intentionally.
  const [tenantIds, setTenantIds] = useState<string[]>(
    viewAll ? [] : (tenants[0] ? [tenants[0].id] : [])
  )
  const [err, setErr] = useState<string | null>(null)
  // Director logins (owner, 2026-10-18): the CEO picks the brands; the API
  // derives the director's companies from them.
  const [directorBrands, setDirectorBrands] = useState<string[]>([])
  const addingDirector = category === 'directors'
  /** HR: what happened to the login it just added. */
  const [hrDone, setHrDone] = useState<string | null>(null)

  function toggleTenant(id: string) {
    setTenantIds((cur) => cur.includes(id) ? cur.filter((t) => t !== id) : [...cur, id])
  }

  // Primary tenant is the first entry of tenantIds (drives User.tenantId).
  const primaryTenantId = tenantIds[0] ?? ''

  // Category drives the primary role enum value — the first entry in roles[]
  // that the API accepts (roles.assignable).
  const assignable = useAssignableRoles()
  const primaryRole = useMemo(() => {
    return primaryRoleOf(CATEGORIES.find((cc) => cc.key === category), assignable) ?? 'cashier'
  }, [category, assignable])

  const invite = useMutation({
    mutationFn: () => api.post<StaffUser & { status?: string; temporaryPassword?: string; passwordLink?: string }>('/auth/staff/invite', {
      name: name.trim(),
      ...(practice ? {} : { email: email.trim().toLowerCase() }),
      ...(!practice && phone.trim() ? { phone: phone.trim() } : {}),
      role: primaryRole,
    }),
    onSuccess: (r) => {
      const who = r?.name ?? name.trim()
      if (r?.temporaryPassword) {
        setIssued({ name: who, email: r.email ?? email, password: r.temporaryPassword })
      } else if (r?.status === 'active') {
        setHrDone(`${who} can sign in now.${r.passwordLink === 'sent' ? ' A link to set their password was sent to their email.' : ''}`)
      } else {
        setHrDone(`${who} is added and waiting for the CEO's approval. They can sign in once the CEO approves.`)
      }
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : 'Failed to add staff'),
  })

  const create = useMutation({
    mutationFn: () => api.post<StaffUser & { temporaryPassword?: string }>('/auth/users', {
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(practice ? {} : { email: email.trim().toLowerCase() }),
      ...(!practice && phone.trim() ? { phone: phone.trim() } : {}),
      role: primaryRole,
      ...(jobTitle.trim() ? { jobTitle: jobTitle.trim() } : {}),
      ...(addingDirector
        ? { directorConceptIds: directorBrands }
        : {
            ...(primaryTenantId ? { tenantId: primaryTenantId } : {}),
            ...(tenantIds.length > 0 ? { tenantIds } : {}),
          }),
    }),
    onSuccess: (created) => {
      // Hold the modal open on the password. Closing straight to the list —
      // which is what it used to do — would throw away the only copy of the
      // credential that exists.
      if (created?.temporaryPassword) {
        setIssued({ name: created.name ?? name, email: created.email ?? email, password: created.temporaryPassword })
      } else {
        onCreated(created ?? null)
      }
    },
    onError:   (e: unknown) => setErr(e instanceof Error ? e.message : 'Failed to create staff'),
  })

  function submit() {
    if (create.isPending || invite.isPending) return
    setErr(null)
    if (asHr) {
      if (!name.trim()) return setErr('Type their name.')
      if (!practice) {
        // Everyone signs in with an @gsfoods.pk email and password.
        if (!email.trim()) return setErr('An email is required — it is how they sign in.')
        if (email.trim() && !/@gsfoods\.pk$/i.test(email.trim())) return setErr('Staff sign in with an @gsfoods.pk address.')
      }
      return invite.mutate()
    }
    if (practice) {
      if (!name.trim()) return setErr('Type their name.')
    } else {
    if (!jobTitle.trim()) return setErr('Type a role / job title so you remember who this is.')
    if (!email.trim()) return setErr('An email is required — it is how they sign in.')
    if (!/@gsfoods\.pk$/i.test(email.trim())) return setErr('Staff sign in with an @gsfoods.pk address.')
    }
    if (addingDirector) {
      if (directorBrands.length === 0) return setErr('Pick at least one brand this director may see.')
    } else if (tenants.length > 0 && tenantIds.length === 0) return setErr('Pick at least one company this hire works for.')
    create.mutate()
  }

  const dirty = !issued && !!(name || email || phone || jobTitle)
  return (
    <Modal title={issued ? `${issued.name} is set up` : 'Add staff'} onClose={onClose}
      dirty={dirty && !hrDone} dismissible={!issued && !create.isPending && !invite.isPending}>
        {hrDone ? (
          <>
            <p role="status" className="text-sm text-s-text mb-4">{hrDone}</p>
            <button type="button" onClick={() => onCreated(null)}
              className="w-full rounded-lg py-2 text-xs font-black bg-primary text-primary-on">Done</button>
          </>
        ) : issued ? (
          <>
            <p className="text-xs text-s-muted mb-4">
              Give them these two things. The password is shown <strong>once</strong> — we
              store only a hash, so nobody can look it up later. If you lose it, issue a new one.
            </p>
            <div className="rounded-lg border border-s-border bg-s-bg p-3 space-y-2 mb-4">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-s-muted mb-0.5">Email</div>
                <div className="font-mono text-sm text-s-text break-all">{issued.email}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-s-muted mb-0.5">Password</div>
                <div className="font-mono text-base font-bold text-success break-all select-all cursor-text"
                  onClick={(e) => selectText(e.currentTarget)}>{issued.password}</div>
              </div>
            </div>
            <div className="flex gap-2">
              <button type="button"
                onClick={() => {
                  void copyText(`${issued.email}\n${issued.password}`).then((ok) => setCopied(ok))
                }}
                className={`flex-1 rounded-lg py-2 text-xs font-bold border hover:border-primary/40 ${copied ? 'border-accent text-success' : 'border-s-border text-s-text'}`}>
                {copied ? 'Copied' : 'Copy both'}
              </button>
              <button type="button"
                onClick={() => onCreated(null)}
                className="flex-1 rounded-lg py-2 text-xs font-black bg-primary text-primary-on">
                Done
              </button>
            </div>
            <p className="text-[10px] text-s-muted/70 mt-3">
              The first time they sign in they are asked to choose their own, so you stop knowing it.
            </p>
          </>
        ) : (
        <form onSubmit={(e) => { e.preventDefault(); submit() }} autoComplete="off">
        <p className="text-xs text-s-muted mb-4">
          {practice
            ? 'Practice copy: just a name and a role. We make their sign-in email and password and show them once on the next screen.'
            : 'Their email is how they sign in, so it is required and must be @gsfoods.pk. We generate a password and show it once on the next screen for you to hand over.'}
        </p>

        <div className="space-y-2.5">
          {practice && (
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus name="new-staff-name" autoComplete="off"
                placeholder="e.g. Ahmad Khan" className={inputCls} />
            </Field>
          )}
          {!practice && (
          <Field label="Email" hint="Required — this is their sign-in">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="firstname.lastname@gsfoods.pk"
              type="email"
              name="new-staff-email"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className={inputCls}
            />
          </Field>
          )}

          {/* Multi-tenant picker. Head-office staff (procurement, finance,
              HR, marketing) typically work for every company — pick more than
              one and the first becomes their primary. */}
          {!asHr && addingDirector && (
            <DirectorBrandPicker value={directorBrands} onChange={setDirectorBrands} />
          )}
          {!asHr && !addingDirector && tenants.length > 1 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-bold uppercase tracking-wider text-s-muted">
                  Companies <span className="text-red-700">*</span>
                </span>
                <span className="text-[10px] text-s-muted/70">
                  Tick all that apply. First = primary.
                </span>
              </div>
              <div className="flex flex-wrap gap-2 rounded-lg border border-s-border bg-s-bg p-2">
                {tenants.map((t) => {
                  const checked = tenantIds.includes(t.id)
                  const isPrimary = primaryTenantId === t.id
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => toggleTenant(t.id)}
                      className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-all ${
                        checked
                          ? 'bg-accent-dim text-success border border-accent'
                          : 'bg-s-surface text-s-muted border border-s-border hover:border-accent/40'
                      }`}>
                      <NavIcon name={checked ? 'check' : 'plus'} size={12} />
                      <span>{t.name}</span>
                      {isPrimary && <span className="text-[9px] uppercase tracking-wider opacity-70">primary</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <Field label={practice ? 'Role' : 'Category'}>
            <Select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
              {assignableCategories(assignable).filter((c) => !asHr || (c.key !== 'owners' && c.key !== 'directors')).map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </Select>
          </Field>
          {!practice && (<>
          <Field label="Mobile number (optional)" hint="One number per login">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" inputMode="tel" name="new-staff-phone" autoComplete="off"
              placeholder="03XX-XXXXXXX" className={inputCls} />
          </Field>
          {!asHr && <Field label="Role / job title" hint="Free text — what you actually call this role.">
            <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} autoFocus name="new-staff-title" autoComplete="off"
              placeholder="e.g. Sous Chef — Bukhari, Floor Manager — Clifton, Procurement Officer"
              className={inputCls} />
          </Field>}
          <Field label={asHr ? 'Name' : 'Name (optional)'} hint={asHr ? 'Required' : "Skip for now — fill in when you know who's joining."}>
            <input value={name} onChange={(e) => setName(e.target.value)} name="new-staff-name" autoComplete="off"
              placeholder="e.g. Ahmad Khan" className={inputCls} />
          </Field>
          </>)}
        </div>

        <p className="mt-3 text-[11px] text-s-muted">
          Tick the company / category / role title now. What each role can open is set
          per role in Module Access.
        </p>

        {err && <p className="mt-2 text-xs font-bold text-red-700">{err}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose}
            className="rounded-lg px-3 py-2 text-xs font-bold border border-s-border text-s-muted hover:text-s-text">
            Cancel
          </button>
          <button type="submit" disabled={create.isPending}
            className="rounded-lg px-3 py-2 text-xs font-black bg-primary text-primary-on hover:opacity-90 disabled:opacity-50">
            {create.isPending || invite.isPending ? 'Adding…' : 'Add staff →'}
          </button>
        </div>
        </form>
        )}
    </Modal>
  )
}

// ─── Small UI bits ───────────────────────────────────────────────────────────

/** Select a node's text so the person can copy by hand when the clipboard is blocked. */
function selectText(el: HTMLElement) {
  try {
    const r = document.createRange()
    r.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(r)
  } catch { /* selection unavailable */ }
}

/** Copy with the Clipboard API; false when it is missing or denied (non-HTTPS, permission). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch { return false }
}

const inputCls =
  'w-full rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm focus:border-primary focus:outline-none'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-bold uppercase tracking-wider text-s-muted">{label}</span>
        {hint && <span className="text-[10px] text-s-muted/70">{hint}</span>}
      </div>
      {children}
    </label>
  )
}
