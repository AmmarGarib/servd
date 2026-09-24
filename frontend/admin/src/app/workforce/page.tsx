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
import { roleLabel, MODULES, type AppRole, type ModuleId } from '../../lib/appRoles'
import { usePermissions } from '../../hooks/useCan'
import { modulesForRole, useRoleModules } from '../../store/roleModules'
import { useViewAllTenants } from '../../components/ui/TenantSwitcher'
import { PositionsView } from './positions/view'

interface TenantLite { id: string; name: string; slug: string }

interface PermissionMeta {
  key: string
  label: string
  desc: string
  category: 'live' | 'service' | 'kitchen' | 'menu' | 'finance' | 'crm' | 'platform'
}
interface PermissionsMatrix {
  roles: string[]
  matrix: Record<string, Record<string, boolean>>
}

const PERMISSION_CATEGORY_META: Record<PermissionMeta['category'], { label: string; emoji: string }> = {
  live:     { label: 'Live operations',     emoji: '⚡' },
  service:  { label: 'Service / floor',     emoji: '💳' },
  kitchen:  { label: 'Kitchen',             emoji: '🍳' },
  menu:     { label: 'Menu & storefront',   emoji: '📝' },
  finance:  { label: 'Finance & reports',   emoji: '💰' },
  crm:      { label: 'Customers & CRM',     emoji: '👥' },
  platform: { label: 'Platform & settings', emoji: '🎛' },
}
const PERMISSION_CATEGORY_ORDER: PermissionMeta['category'][] = [
  'live', 'service', 'kitchen', 'menu', 'finance', 'crm', 'platform',
]

// Hand-tuned labels for resource ids that don't title-case cleanly. Anything
// missing falls back to a generic Capitalize(resource). Keep this small —
// most catalogue keys are already nicely named ("orders", "menu", "tables").
const RESOURCE_LABELS: Record<string, string> = {
  pos:           'POS',
  kds:           'KDS',
  crm:           'CRM',
  ap:            'Accounts payable',
  ar:            'Accounts receivable',
  storefront:    'Storefront',
  procurement:   'Procurement',
  reservations:  'Reservations',
  inventory:     'Inventory',
  reports:       'Reports',
  accounting:    'Accounting',
  riders:        'Riders / dispatch',
  tables:        'Floor plan',
  chain:         'Chain rollup',
  recipes:       'Recipes',
  dashboard:     'Dashboard',
  orders:        'Orders',
  menu:          'Menu',
  campaigns:     'Campaigns',
  customers:     'Customers',
  discounts:     'Discounts',
  payroll:       'Payroll',
  settings:      'Settings',
  permissions:   'Permissions',
}
function resourceLabel(resource: string): string {
  return RESOURCE_LABELS[resource] ?? (resource.charAt(0).toUpperCase() + resource.slice(1))
}

// Pull the action half of a `resource:action` key and humanise it.
// e.g. "orders:refund" → "Refund", "pos:open_shift" → "Open shift".
function actionLabel(permKey: string): string {
  const idx = permKey.indexOf(':')
  if (idx < 0) return permKey
  const action = permKey.slice(idx + 1).replace(/_/g, ' ')
  return action.charAt(0).toUpperCase() + action.slice(1)
}

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
  // Per-user overrides on top of the role's baseline. Empty arrays = follow
  // the role default exactly. Resolution rule (matches backend):
  //   effective = (role_default ∪ allow) \ deny
  permissionAllow?: string[]
  permissionDeny?:  string[]
  moduleAllow?:     string[]
  moduleDeny?:      string[]
  // Stations this user is rostered to work. Drives /kds (Kitchen view) —
  // empty array = "not station-restricted" (admin/management/expediter
  // get every active station).
  stationIds?:      string[]
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
    blurb: 'GMs, FOH & BOH leads, the F&B manager — the people who run the floor day-to-day.',
    roles: ['management', 'foh_management', 'boh_management', 'fnb_manager'],
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
    blurb: 'Brand manager, CRM, campaigns, reviews, content calendar.',
    roles: ['marketing', 'brand_manager'],
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

  const [activeCategory, setActiveCategory] = useState<string>(initialCategory)
  const [statusFilter, setStatusFilter] = useState<'all' | StaffUser['accountStatus']>('all')
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
                {activeTab === 'positions'
                  ? 'Every seat the org pays for, filled or not. Edits flow live into /finance/opex + projections.'
                  : <>Every staff member, every category. {users.length} total · <span className={pendingCount > 0 ? 'text-amber-400 font-bold' : ''}>{pendingCount} pending</span></>}
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
              {canEdit && activeTab === 'people' && (
                <button onClick={() => setAddOpen(true)}
                  className="rounded-lg px-3 py-2 text-xs font-black bg-kds-green text-black hover:opacity-90">
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
      <div className="max-w-6xl mx-auto px-6 pt-4 border-b border-kds-border">
        <div className="flex gap-2">
          <button onClick={() => { setActiveTab('people'); router.replace('/workforce') }}
            className="px-4 py-2.5 text-sm font-bold transition-colors"
            style={activeTab === 'people'
              ? { color: '#00D4B1', borderBottom: '2px solid #00D4B1', marginBottom: '-1px' }
              : { color: 'rgba(255,255,255,0.5)' }}>
            👥 People ({users.length})
          </button>
          <button onClick={() => { setActiveTab('positions'); router.replace('/workforce?tab=positions') }}
            className="px-4 py-2.5 text-sm font-bold transition-colors"
            style={activeTab === 'positions'
              ? { color: '#00D4B1', borderBottom: '2px solid #00D4B1', marginBottom: '-1px' }
              : { color: 'rgba(255,255,255,0.5)' }}>
            💼 Positions (budget)
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
              tenants={tenants}
              // Chip is mostly noise in single-tenant view (every row belongs
              // to the same company). Only render it when the operator is
              // looking across companies, OR when the row is orphaned —
              // those always need a "⚠ No company" badge.
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
  user, canEdit, tenants, showTenantChip,
  expanded, onExpand, onClose, onChange,
}: {
  user: StaffUser; canEdit: boolean
  tenants: TenantLite[]
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
          <div className="flex items-center gap-2 flex-wrap">
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
            {/* Brand chips — one per tenant the staff member is a member of.
                Primary tenant first, additional memberships after. Hidden in
                single-tenant view (every row would carry the same chips). */}
            {showTenantChip && (user.tenants ?? (tenant ? [tenant] : [])).map((t) => (
              <span key={t.id} className="shrink-0 text-[9px] uppercase tracking-wider font-bold rounded px-1.5 py-0.5"
                style={{ background: 'rgba(99,102,241,0.15)', color: '#A5B4FC' }}>
                {t.name}
              </span>
            ))}
            {/* Orphan warning — always shown, regardless of view mode. A row
                with no company is a data bug; surface it everywhere. */}
            {!user.tenantId && (
              <span className="shrink-0 text-[9px] uppercase tracking-wider font-bold rounded px-1.5 py-0.5"
                style={{ background: 'rgba(255,77,79,0.10)', color: '#FF4D4F' }}
                title="This staff row has no company assigned. Tap to fix.">
                ⚠ No company
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
  const [name, setName]         = useState(user.name === 'Unnamed staff' ? '' : user.name)
  const [email, setEmail]       = useState(user.email ?? '')
  const [phone, setPhone]       = useState(user.phone ?? '')
  const [jobTitle, setJobTitle] = useState(user.jobTitle ?? '')
  const [category, setCategory] = useState<string>(categoryOf(user.role)?.key ?? 'management')
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

  // Keep role consistent with category: if the category changes and the
  // current role doesn't fit the new category, fall back to its primary.
  useEffect(() => {
    const cat = CATEGORIES.find((c) => c.key === category)
    if (cat && !cat.roles.includes(role)) {
      setRole(cat.roles[0]!)
    }
  }, [category])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Per-user permission overrides ─────────────────────────────────────
  // Each action chip is tri-state for THIS staff member:
  //   - 'default': follow the role's baseline (set in /configuration/roles)
  //   - 'allow':   force-grant (in user.permissionAllow)
  //   - 'deny':    force-revoke (in user.permissionDeny)
  // Click cycles: default → allow → deny → default.

  type OverrideState = 'default' | 'allow' | 'deny'

  const { data: permsCatalogue = [] } = useQuery<PermissionMeta[]>({
    queryKey: ['permissions', 'catalogue'],
    queryFn:  () => api.get('/permissions/catalogue'),
    staleTime: 5 * 60_000,
  })
  const { data: permsMatrix } = useQuery<PermissionsMatrix>({
    queryKey: ['permissions', 'matrix'],
    queryFn:  () => api.get('/permissions/matrix'),
    staleTime: 30_000,
  })

  // Local edit buffer keyed by permission key. Tracks the user's override
  // state — falls back to "default" when not in this map.
  const [permOverrides, setPermOverrides] = useState<Record<string, OverrideState>>(() => {
    const out: Record<string, OverrideState> = {}
    for (const k of user.permissionAllow ?? []) out[k] = 'allow'
    for (const k of user.permissionDeny  ?? []) out[k] = 'deny'
    return out
  })

  function getPermState(permKey: string): OverrideState {
    return permOverrides[permKey] ?? 'default'
  }
  function getRoleDefault(permKey: string): boolean {
    return permsMatrix?.matrix[role]?.[permKey] ?? false
  }
  function getEffectivePerm(permKey: string): boolean {
    const state = getPermState(permKey)
    if (state === 'allow') return true
    if (state === 'deny')  return false
    return getRoleDefault(permKey)
  }
  function cyclePerm(permKey: string) {
    setPermOverrides((cur) => {
      const next = { ...cur }
      const state = next[permKey] ?? 'default'
      // default → allow → deny → default
      const nextState: OverrideState = state === 'default' ? 'allow' : state === 'allow' ? 'deny' : 'default'
      if (nextState === 'default') delete next[permKey]
      else next[permKey] = nextState
      return next
    })
  }

  // Dirty when the override map diverges from what the server has on file.
  const permsDirty = useMemo(() => {
    const serverAllow = new Set(user.permissionAllow ?? [])
    const serverDeny  = new Set(user.permissionDeny  ?? [])
    const draftAllow  = new Set(Object.entries(permOverrides).filter(([, v]) => v === 'allow').map(([k]) => k))
    const draftDeny   = new Set(Object.entries(permOverrides).filter(([, v]) => v === 'deny').map(([k]) => k))
    if (serverAllow.size !== draftAllow.size || serverDeny.size !== draftDeny.size) return true
    for (const k of draftAllow) if (!serverAllow.has(k)) return true
    for (const k of draftDeny)  if (!serverDeny.has(k))  return true
    return false
  }, [permOverrides, user.permissionAllow, user.permissionDeny])

  // Group catalogue permissions by category, then by resource within each
  // category. Permission keys follow a `resource:action` convention
  // (`orders:view`, `orders:refund`, `menu:edit`, …) so splitting on the
  // colon gives us a natural "Orders → [View, Refund, Cancel]" structure
  // — a per-action chip row per resource, which is what the operator
  // actually thinks in.
  interface ResourceGroup {
    resource: string         // e.g. 'orders'
    label: string            // operator-readable resource name
    actions: PermissionMeta[] // each action on this resource
  }
  const groupedByCategory = useMemo(() => {
    const cats: Record<string, ResourceGroup[]> = {}
    const byCatThenRes = new Map<string, Map<string, PermissionMeta[]>>()
    for (const p of permsCatalogue) {
      const cat = byCatThenRes.get(p.category) ?? new Map<string, PermissionMeta[]>()
      const [resource] = p.key.split(':')
      const r = resource ?? p.key
      const arr = cat.get(r) ?? []
      arr.push(p)
      cat.set(r, arr)
      byCatThenRes.set(p.category, cat)
    }
    for (const [cat, resMap] of byCatThenRes) {
      cats[cat] = Array.from(resMap.entries()).map(([resource, actions]) => ({
        resource,
        // Title-case the resource id ("orders" → "Orders") unless the only
        // action's label happens to start with the resource (e.g. "Operate
        // POS"), in which case fall back to a tidy name.
        label: resourceLabel(resource),
        actions: actions.sort((a, b) => a.key.localeCompare(b.key)),
      }))
    }
    return cats
  }, [permsCatalogue])

  const derivedPin = phone.replace(/\D/g, '').slice(-4)

  const save = useMutation({
    mutationFn: async () => {
      const patch: Record<string, unknown> = {}
      if (name.trim() && name.trim() !== user.name) patch.name = name.trim()
      if (email.trim() !== (user.email ?? '')) patch.email = email.trim()
      if (phone.trim() !== (user.phone ?? '')) patch.phone = phone.trim()
      if (jobTitle.trim() !== (user.jobTitle ?? '')) patch.jobTitle = jobTitle.trim()
      if (role !== user.role) patch.role = role
      if (tenantId && tenantId !== (user.tenantId ?? '')) patch.tenantId = tenantId
      const existingIds = (user.tenants ?? []).map((t) => t.id).sort().join(',')
      const nextIds = [...tenantIds].sort().join(',')
      if (existingIds !== nextIds) patch.tenantIds = tenantIds
      if (pin.trim()) patch.pin = pin.trim()

      // Permission overrides — full replacement arrays. Backend stores the
      // allow/deny lists verbatim; resolution against role baseline happens
      // at read time (effectivePermissionsForUser).
      if (permsDirty) {
        patch.permissionAllow = Object.entries(permOverrides)
          .filter(([, v]) => v === 'allow').map(([k]) => k)
        patch.permissionDeny  = Object.entries(permOverrides)
          .filter(([, v]) => v === 'deny').map(([k]) => k)
      }

      // Station assignments — full replacement. Compare sorted-joined strings
      // so order-only diffs don't trigger a no-op PATCH.
      const existingStations = (user.stationIds ?? []).slice().sort().join(',')
      const nextStations     = stationIds.slice().sort().join(',')
      if (existingStations !== nextStations) patch.stationIds = stationIds

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
  // Reissuing a password is the ONLY remedy for a forgotten one: self-service
  // change needs the current password, and there is no email reset flow. The
  // new password comes back once and is held on screen until dismissed —
  // closing without copying means issuing another.
  const [reissued, setReissued] = useState<string | null>(null)
  const reissue = useMutation({
    mutationFn: () => api.post<{ temporaryPassword: string }>(`/auth/users/${user.id}/reissue-password`, {}),
    onSuccess: (r) => setReissued(r?.temporaryPassword ?? null),
  })

  const toggleActive = useMutation({
    mutationFn: () => api.patch(`/auth/users/${user.id}`, { isActive: !user.isActive }),
    onSuccess:  () => onChange(),
  })

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
        {/* PIN sits in the slot the old "Specific role" dropdown vacated —
            keeps the form compact and surfaces the login gate next to the
            role definition. Category alone decides the bucket; the
            permission matrix below decides what the role can do. */}
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
        {tenants.length > 0 && (
          <div className="md:col-span-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-bold uppercase tracking-wider text-kds-subtext">
                Companies {!user.tenantId && <span className="text-red-400">— orphan, pick at least one</span>}
              </span>
              <span className="text-[10px] text-kds-subtext/70">
                Tick every company this person works for. The first one is their primary.
              </span>
            </div>
            <div className="flex flex-wrap gap-2 rounded-lg border border-kds-border bg-kds-bg p-2">
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
                        ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40'
                        : 'bg-kds-card text-kds-subtext border border-kds-border hover:border-indigo-400/30'
                    }`}>
                    <span>{checked ? '✓' : '+'}</span>
                    <span>{t.name}</span>
                    {isPrimary && <span className="text-[9px] uppercase tracking-wider opacity-70">primary</span>}
                  </button>
                )
              })}
            </div>
            {tenantIds.length > 1 && (
              <div className="mt-2 flex items-center gap-2 text-[11px] text-kds-subtext">
                <span>Primary company:</span>
                <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}
                  className="rounded-md border border-kds-border bg-kds-bg px-2 py-1 text-xs focus:border-kds-green focus:outline-none">
                  {tenantIds.map((id) => {
                    const t = tenants.find((tt) => tt.id === id)
                    return t ? <option key={id} value={id}>{t.name}</option> : null
                  })}
                </select>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Station assignments ──────────────────────────────────────────
          Drives /kds (Kitchen view) — empty means "every active station"
          for unrestricted roles. Most useful on the line-cook role: tick
          the stations this cook actually works (Grill, Tandoor) so they
          land on a focused dashboard. Stations are grouped by concept so
          duplicate names across brands stay distinguishable. */}
      {stationsByConcept.length > 0 && (
        <div className="rounded-lg border border-kds-border bg-kds-bg/60 p-3 space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-kds-subtext">
                Kitchen stations
              </p>
              <p className="text-[10px] text-kds-subtext/80 mt-0.5">
                Stations this person works. Empty = not restricted (sees every active station in Kitchen view).
              </p>
            </div>
            {stationIds.length > 0 && (
              <button type="button" onClick={() => setStationIds([])}
                className="text-[10px] text-kds-subtext hover:text-kds-text underline">
                Clear all
              </button>
            )}
          </div>
          <div className="space-y-2">
            {stationsByConcept.map((g) => (
              <div key={g.conceptId}>
                <p className="text-[10px] font-bold uppercase tracking-wider text-kds-subtext mb-1">{g.conceptName}</p>
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
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                            : 'bg-kds-card text-kds-subtext border border-kds-border hover:border-emerald-400/30'
                        }`}>
                        <span>{checked ? '✓' : '+'}</span>
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

      {/* ── Per-user permission overrides ───────────────────────────────
          {roleLabel(role)} has a baseline matrix in /configuration/roles.
          Use the chips below to subjectively grant or revoke actions for
          THIS staff member without touching the role default. Click cycles:
            • greyed = follow role default
            • ★ teal = force-grant
            • ✕ red  = force-revoke
          Chip background also shows what the role default is (subtle), so
          you can tell a default-allow + user-deny from a default-deny that
          just hasn't been overridden. */}
      <div className="rounded-lg border border-kds-border bg-kds-bg/60 p-3 space-y-2.5">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-kds-subtext">
              Override actions for {user.name || 'this staff'}
            </p>
            <p className="text-[10px] text-kds-subtext/70">
              Baseline = {roleLabel(role)} role default. Click a chip to grant or revoke just for this person.
              <Link href="/configuration/roles" className="text-kds-green font-bold hover:opacity-80 ml-1.5">
                Edit role defaults →
              </Link>
            </p>
          </div>
          {permsDirty && (
            <span className="text-[10px] font-bold uppercase tracking-wider rounded px-1.5 py-0.5"
              style={{ background: 'rgba(245,158,11,0.15)', color: '#F59E0B' }}>
              Unsaved overrides
            </span>
          )}
        </div>

        <div className="space-y-3">
          {PERMISSION_CATEGORY_ORDER.map((catKey) => {
            const resources = groupedByCategory[catKey]
            if (!resources || resources.length === 0) return null
            const catMeta = PERMISSION_CATEGORY_META[catKey]
            return (
              <div key={catKey} className="rounded-md border border-kds-border/60 bg-kds-card/40 p-2.5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-kds-subtext mb-2">
                  {catMeta.emoji} {catMeta.label}
                </p>
                <div className="space-y-1.5">
                  {resources.map((res) => (
                    <div key={res.resource}
                      className="grid grid-cols-[140px_1fr] items-center gap-3 px-1.5 py-1 rounded hover:bg-kds-bg/40">
                      <p className="text-[12px] font-semibold text-kds-text leading-tight truncate">
                        {res.label}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {res.actions.map((perm) => {
                          const state         = getPermState(perm.key)
                          const roleDefault   = getRoleDefault(perm.key)
                          const effective     = getEffectivePerm(perm.key)
                          const tooltip = `${perm.desc ?? perm.label}\n— Role default: ${roleDefault ? 'allowed' : 'denied'}\n— This user: ${state === 'default' ? '(follows role)' : state}\n— Effective: ${effective ? 'allowed' : 'denied'}`
                          // Style by the user's override state. The "default"
                          // chip also reflects the role baseline (faint teal
                          // when the role allows; faint grey when it denies)
                          // so the operator sees the inherited state.
                          let style: React.CSSProperties
                          let prefix: string
                          if (state === 'allow') {
                            style  = { background: 'rgba(0,212,177,0.22)', color: '#00D4B1', borderColor: 'rgba(0,212,177,0.6)' }
                            prefix = '★'
                          } else if (state === 'deny') {
                            style  = { background: 'rgba(255,77,79,0.18)', color: '#FF8A8C', borderColor: 'rgba(255,77,79,0.45)' }
                            prefix = '✕'
                          } else if (roleDefault) {
                            style  = { background: 'rgba(0,212,177,0.06)', color: 'rgba(0,212,177,0.7)', borderColor: 'rgba(0,212,177,0.18)' }
                            prefix = '✓'
                          } else {
                            style  = { background: 'rgba(255,255,255,0.02)', color: 'rgba(255,255,255,0.4)', borderColor: 'rgba(255,255,255,0.08)' }
                            prefix = '·'
                          }
                          return (
                            <button key={perm.key}
                              type="button"
                              onClick={() => cyclePerm(perm.key)}
                              title={tooltip}
                              className="text-[11px] font-bold rounded-full px-2.5 py-0.5 border transition-all"
                              style={style}>
                              {prefix} {actionLabel(perm.key)}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
        {permsCatalogue.length === 0 && (
          <p className="text-[11px] text-kds-subtext italic">Permissions catalogue loading…</p>
        )}
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
              if (window.confirm(`Issue a new password for ${user.name}? Their current one stops working immediately and they will be signed out everywhere.`)) reissue.mutate()
            }} disabled={reissue.isPending}
            className="rounded-md px-2 py-1.5 text-[11px] font-bold border border-kds-border text-kds-subtext hover:text-emerald-400 hover:border-emerald-400/40">
            {reissue.isPending ? 'Issuing…' : 'New password'}
          </button>
          <button onClick={() => {
              if (window.confirm(`Delete ${user.name}? This soft-deletes — history is preserved.`)) remove.mutate()
            }} disabled={remove.isPending}
            className="rounded-md px-2 py-1.5 text-[11px] font-bold border border-kds-border text-kds-subtext hover:text-red-400 hover:border-red-400/40">
            🗑 Delete
          </button>
        </div>

        {/* The reissued password, held on screen until dismissed. Only a hash
            is stored, so this is the only moment it exists in readable form. */}
        {reissued && (
          <div className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-400/5 p-3">
            <div className="text-[10px] uppercase tracking-wider text-emerald-400/80 mb-1">
              New password for {user.name} — shown once
            </div>
            <div className="font-mono text-sm font-bold text-emerald-400 break-all mb-2">{reissued}</div>
            <div className="flex gap-2">
              <button
                onClick={() => { void navigator.clipboard?.writeText(reissued).catch(() => undefined) }}
                className="rounded-md px-2 py-1 text-[11px] font-bold border border-kds-border text-kds-text hover:border-emerald-400/40">
                Copy
              </button>
              <button
                onClick={() => setReissued(null)}
                className="rounded-md px-2 py-1 text-[11px] font-bold text-kds-subtext hover:text-kds-text">
                Done
              </button>
            </div>
            <p className="text-[10px] text-kds-subtext/70 mt-2">
              They can set their own from the &ldquo;Change my password&rdquo; link on the sign-in page.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Add modal (minimal) ────────────────────────────────────────────────────

function AddStaffModal({
  tenants, viewAll, onClose, onCreated,
}: {
  tenants: TenantLite[]; viewAll: boolean
  onClose: () => void; onCreated: (created: StaffUser | null) => void
}) {
  const [name, setName]         = useState('')
  const [email, setEmail]       = useState('')
  const [category, setCategory] = useState<string>('management')
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

  function toggleTenant(id: string) {
    setTenantIds((cur) => cur.includes(id) ? cur.filter((t) => t !== id) : [...cur, id])
  }

  // Primary tenant is the first entry of tenantIds (drives User.tenantId).
  const primaryTenantId = tenantIds[0] ?? ''

  // Category drives the primary role enum value — first entry in roles[].
  const primaryRole = useMemo(() => {
    const c = CATEGORIES.find((cc) => cc.key === category)
    return c?.roles[0] ?? 'cashier'
  }, [category])

  const create = useMutation({
    mutationFn: () => api.post<StaffUser & { temporaryPassword?: string }>('/auth/users', {
      ...(name.trim() ? { name: name.trim() } : {}),
      email: email.trim().toLowerCase(),
      role: primaryRole,
      ...(jobTitle.trim() ? { jobTitle: jobTitle.trim() } : {}),
      ...(primaryTenantId ? { tenantId: primaryTenantId } : {}),
      ...(tenantIds.length > 0 ? { tenantIds } : {}),
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
    setErr(null)
    if (!jobTitle.trim()) return setErr('Type a role / job title so you remember who this is.')
    if (!email.trim()) return setErr('An email is required — it is how they sign in.')
    if (!/@gsfoods\.pk$/i.test(email.trim())) return setErr('Staff sign in with an @gsfoods.pk address.')
    if (tenants.length > 0 && tenantIds.length === 0) return setErr('Pick at least one company this hire works for.')
    create.mutate()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-kds-card border border-kds-border rounded-2xl p-5 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}>
        {issued ? (
          <>
            <h2 className="font-black text-lg mb-1">{issued.name} is set up</h2>
            <p className="text-xs text-kds-subtext mb-4">
              Give them these two things. The password is shown <strong>once</strong> — we
              store only a hash, so nobody can look it up later. If you lose it, issue a new one.
            </p>
            <div className="rounded-lg border border-kds-border bg-kds-bg p-3 space-y-2 mb-4">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-kds-subtext mb-0.5">Email</div>
                <div className="font-mono text-sm text-kds-text break-all">{issued.email}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-kds-subtext mb-0.5">Password</div>
                <div className="font-mono text-base font-bold text-emerald-400 break-all">{issued.password}</div>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(`${issued.email}\n${issued.password}`)
                    .then(() => setCopied(true)).catch(() => undefined)
                }}
                className="flex-1 rounded-lg py-2 text-xs font-bold border border-kds-border text-kds-text hover:border-emerald-400/40">
                {copied ? 'Copied' : 'Copy both'}
              </button>
              <button
                onClick={() => onCreated(null)}
                className="flex-1 rounded-lg py-2 text-xs font-black bg-emerald-500 text-black">
                Done
              </button>
            </div>
            <p className="text-[10px] text-kds-subtext/70 mt-3">
              They can change it themselves from the &ldquo;Change my password&rdquo; link on the sign-in page.
            </p>
          </>
        ) : (
        <>
        <h2 className="font-black text-lg mb-1">Add staff</h2>
        <p className="text-xs text-kds-subtext mb-4">
          Their email is how they sign in, so it is required and must be
          @gsfoods.pk. We generate a password and show it once on the next
          screen for you to hand over.
        </p>

        <div className="space-y-2.5">
          <Field label="Email" hint="Required — this is their sign-in">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="firstname.lastname@gsfoods.pk"
              type="email"
              autoCapitalize="none"
              className={inputCls}
            />
          </Field>

          {/* Multi-tenant picker. Head-office staff (procurement, finance,
              HR, marketing) typically work for every company — pick more than
              one and the first becomes their primary. */}
          {tenants.length > 1 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-bold uppercase tracking-wider text-kds-subtext">
                  Companies <span className="text-red-400">*</span>
                </span>
                <span className="text-[10px] text-kds-subtext/70">
                  Tick all that apply. First = primary.
                </span>
              </div>
              <div className="flex flex-wrap gap-2 rounded-lg border border-kds-border bg-kds-bg p-2">
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
                          ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40'
                          : 'bg-kds-card text-kds-subtext border border-kds-border hover:border-indigo-400/30'
                      }`}>
                      <span>{checked ? '✓' : '+'}</span>
                      <span>{t.name}</span>
                      {isPrimary && <span className="text-[9px] uppercase tracking-wider opacity-70">primary</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
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

        <p className="mt-3 text-[11px] text-kds-subtext">
          Tick the company / category / role title now. You can fine-tune what this role
          <em> does</em> inside the row's edit panel — every staff form has the permission
          matrix folded in.
        </p>

        {err && <p className="mt-2 text-xs font-bold text-red-400">{err}</p>}

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
        </>
        )}
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
