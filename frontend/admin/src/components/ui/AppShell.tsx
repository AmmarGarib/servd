'use client'
import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { usePathname, useRouter } from 'next/navigation'
import { useAuthStore } from '../../store/auth'
import { api } from '../../lib/api'
import { useViewAsRole, type ViewAsRole } from '../../store/viewAsRole'
import { useRoleModules, modulesForRole, useSyncRoleModules } from '../../store/roleModules'
import { usePermissions } from '../../hooks/useCan'
import { APP_ROLES, roleLabel, isExecutive, type AppRole, type ModuleId } from '../../lib/appRoles'
import { TenantSwitcher, useViewAllTenants } from './TenantSwitcher'
import { BrandPicker } from './BrandPicker'
import { moduleForPath } from '../../lib/moduleCatalog'
import { PortfolioWriteGuardModal } from './PortfolioWriteGuardModal'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

// ─── Nav structure ────────────────────────────────────────────────────────────
//
// Design rules:
// - Sections collapse independently. State persisted per-user to localStorage.
// - Heavy / config-tier sections (Marketing, Finance) start collapsed.
// - Items can have `children` — only revealed when the parent's pill is open.
// - User can pin any item (★) — pinned items render in a sticky strip up top.

// Each nav item carries a `module` ID drawn from src/lib/appRoles.ts. The role
// → module mapping (with CEO-editable overrides) decides what each role sees.
// Items without a module are visible to everyone. Sections also carry a
// module — when *every* item in a section is hidden, the section header
// disappears too.

interface NavItem {
  href: string
  label: string
  icon: string
  badge?: string
  children?: Array<{ href: string; label: string; module?: ModuleId }>
  module?: ModuleId
}

interface NavSection {
  title: string
  items: NavItem[]
  defaultCollapsed?: boolean
  module?: ModuleId
}

const NAV: NavSection[] = [
  // ── Executive — CEO / Admin only by default.
  //
  // Two layers of permission control:
  //   /configuration/roles        → role-level DEFAULTS (what a Cashier can do)
  //   /configuration/role-modules → role-level sidebar DEFAULTS
  //   /workforce (Staff Directory) → per-USER overrides on top of those defaults
  //
  // The standalone pages set the rules for an entire role at once; the
  // staff directory's row editor lets you make subjective per-person
  // adjustments without touching the role baseline.
  {
    title: 'Executive',
    items: [
      { href: '/dashboard/ceo',                 label: 'CEO Overview',        icon: '👑', module: 'ceo_overview' },
      // Single link — the category/tab shortcuts that used to nest here were
      // noise at this team size; filtering lives inside the page itself.
      { href: '/workforce',                     label: 'Workforce',           icon: '👥', module: 'staff_directory' },
      { href: '/hr',                            label: 'HR',                  icon: '🪪', module: 'staff_hr' },
      // Project Tracker — capital projects, run-rate opex, and forward
      // projections. Moved up from its own standalone section (CEO surface).
      { href: '/finance/capex', label: 'Project Tracker', icon: '🏗', module: 'capital', children: [
        { href: '/finance/capex',       label: 'Capex',       module: 'capital' },
        { href: '/finance/opex',        label: 'OpEx',        module: 'capital' },
        { href: '/finance/projections', label: 'Projections', module: 'projections' },
      ]},
      { href: '/configuration/pending-approvals', label: 'Pending Signups',  icon: '⏳', module: 'role_management' },
      { href: '/configuration/roles',           label: 'Roles & Permissions', icon: '🔐', module: 'role_management' },
      { href: '/configuration/role-modules',    label: 'Module Access',       icon: '🗂', module: 'role_modules' },
      { href: '/settings',                      label: 'Tenants & Brands',    icon: '🏷', module: 'tenants' },
      // ── Account config (relocated from the retired "Setup" section). These
      // are one-time-per-account surfaces: connect Meta (FB+IG) / WhatsApp /
      // FBR PRAL / the Supplier Portal, push to staff devices, read the docs.
      { href: '/settings/integrations',         label: 'Integrations',        icon: '🔌', module: 'integrations' },
      { href: '/notifications',                 label: 'Notifications',       icon: '🔔', module: 'notifications' },
      { href: '/help',                          label: 'Help & Support',      icon: '❓', module: 'help' },
    ],
  },
  {
    title: 'Live',
    items: [
      { href: '/dashboard', label: 'Dashboard',    icon: '⬡', module: 'dashboard' },
      // Expo Station is the pass-station screen — expediter/management
      // territory. Orders arrive here, expo fires them, then each line cook
      // works off their own per-station /kds/<id> URL (opened on the station's
      // iPad — managed via KDS Config). Tagged with `expo_station` (not
      // `kds_all`) so the kitchen role can't see it — they get the Kitchen
      // view dashboard below instead.
      { href: '/expo',      label: 'Expo Station', icon: '🪧', module: 'expo_station' },
      // Kitchen view — the line cook's home. Lists their assigned stations
      // with click-to-expand inline queues. Tagged with its own module so
      // it can be shown to roles that don't get /expo.
      { href: '/kds',       label: 'Kitchen view', icon: '🍳', module: 'kds_dashboard' },
      { href: '/chain',     label: 'Chain Rollup', icon: '🏢', module: 'chain' },
    ],
  },
  {
    // ── Management — every manager-facing surface in one tab. The manager-tier
    // dashboards (each gated by module: the Brand Manager gets Brand, the F&B
    // Manager gets F&B, the CEO + GM see both) plus the "look back / look
    // across" layer — past orders, refunds, ops anomalies. Sits right after
    // Live: Live is what's happening RIGHT NOW, Management is the post-hoc +
    // analytical layer the floor can drop into for a quick lookup (refund last
    // night's #1042). For managers whose Executive + Live sections are hidden,
    // this becomes the first section in their sidebar.
    title: 'Management',
    items: [
      { href: '/dashboard/brand', label: 'Brand Dashboard', icon: '📣', module: 'brand_dashboard' },
      { href: '/dashboard/fnb',   label: 'F&B Dashboard',   icon: '🍽️', module: 'fnb_dashboard' },
      { href: '/orders',    label: 'Orders (history)', icon: '📋', module: 'orders', children: [
        { href: '/refunds',         label: 'Refunds',  module: 'refunds' },
      ]},
      { href: '/ops',       label: 'Ops Center',   icon: '⚡', module: 'ops' },
      // People-ops that aren't CEO-only: Scheduling (F&B Manager, GM, FOH
      // Management) and Payroll (HR, Finance, GM) live here so the roles that
      // hold those modules can reach them — the CEO-gated Executive section
      // would otherwise hide them. Module gating keeps each row scoped to the
      // right roles. Workforce *admin* — staff allowances, categories,
      // onboarding — stays CEO-only up in Executive.
      { href: '/scheduling', label: 'Scheduling',  icon: '📅', module: 'scheduling' },
      { href: '/hr/payroll', label: 'Payroll',     icon: '🧾', module: 'staff_hr', children: [
        { href: '/tip-pools', label: 'Tip pools', module: 'payroll' },
      ]},
    ],
  },
  {
    title: 'Service',
    items: [
      { href: '/pos', label: 'Point of Sale', icon: '💳', module: 'pos', children: [
        { href: '/pos/waiter', label: 'Waiter mode', module: 'pos' },
        { href: '/pos/shift',  label: 'Shift / Till', module: 'pos' },
      ]},
      { href: '/reservations', label: 'Reservations', icon: '🍽', module: 'reservations', children: [
        { href: '/reservations/week',      label: 'Week view',            module: 'reservations' },
        { href: '/reservations/blockouts', label: 'Closures & blockouts', module: 'reservations_admin' },
        { href: '/reservations/hours',     label: 'Service hours',        module: 'reservations_admin' },
        { href: '/reservations/analytics', label: 'Analytics',            module: 'reservations_admin' },
        { href: '/kds/reservations',       label: 'Kitchen tracker',      module: 'kds_all' },
      ]},
      { href: '/orders/curbside', label: 'Curbside',   icon: '🚗', module: 'curbside' },
      { href: '/tables',          label: 'Floor Plan', icon: '🪑', module: 'tables' },
      { href: '/dispatch',        label: 'Dispatch',   icon: '🛵', module: 'dispatch', children: [
        { href: '/riders', label: 'Riders', module: 'riders' },
      ]},
    ],
  },
  {
    title: 'Kitchen',
    items: [
      { href: '/menu',                label: 'Menu',         icon: '📝', module: 'menu' },
      { href: '/accounting/recipes',  label: 'Recipes',      icon: '📐', module: 'recipes' },
      // Pricing lives here, not on recipes: recipes are pure cost; this page
      // takes each plate's cost and owns selling price + margins.
      { href: '/menu-engineering',    label: 'Menu Engineering', icon: '💹', module: 'recipes' },
      { href: '/sourcing',            label: 'Sourcing Master Sheet', icon: '🧾', module: 'inventory' },
      { href: '/par-sheet',           label: 'Par Sheet',    icon: '📋', module: 'par_sheet' },
      { href: '/inventory',           label: 'Inventory',    icon: '📦', module: 'inventory' },
      { href: '/kds/config',          label: 'KDS Config',   icon: '⚙️', module: 'kds_config' },
    ],
  },
  {
    // ── Storefront — everything the customer sees, gathered in one place:
    // the brands (identity + colour), their microsite layout, the landing
    // hero, the per-brand footers, the menu, business info and locations.
    // Consolidated here out of Marketing / Executive so all storefront edits
    // live together. (Menu is also linked under Kitchen for the line team.)
    title: 'Storefront',
    defaultCollapsed: true,
    items: [
      { href: '/marketing/brands',  label: 'Brands',        icon: '🏷', module: 'brands', children: [
        { href: '/storefront',           label: 'Visual Layout', module: 'brands' },
        { href: '/marketing/storefront', label: 'Designer hub',  module: 'brands' },
      ]},
      { href: '/storefront-hero',   label: 'Landing Hero',  icon: '🖼', module: 'brands' },
      { href: '/storefront-footer', label: 'Brand Footers', icon: '🔗', module: 'brands' },
      { href: '/menu',              label: 'Menu',          icon: '📝', module: 'menu' },
      { href: '/business-info',     label: 'Business Info', icon: '🏢', module: 'business_info' },
      { href: '/configuration/locations', label: 'Locations', icon: '📍', module: 'business_info' },
    ],
  },
  {
    // Single Marketing umbrella covers customer ops + outbound — for a
    // single-team operator the host who handles a complaint is the same
    // person sending the win-back. Higher-frequency engagement items
    // (CRM, Campaigns, Complaints, Reviews) sit at the top of the group;
    // creative/strategic items (Brands, Calendar, Media, Promotions,
    // Analytics) below.
    title: 'Marketing',
    defaultCollapsed: true,
    items: [
      { href: '/marketing',         label: 'Workspace',   icon: '🚀', module: 'marketing_workspace', children: [
        { href: '/marketing/activity', label: 'Activity Log', module: 'marketing_workspace' },
      ]},
      { href: '/crm',               label: 'CRM',         icon: '👥', module: 'crm', children: [
        { href: '/crm/conversations', label: 'Conversations', module: 'crm' },
        { href: '/crm/segments',      label: 'Segments',      module: 'crm' },
        { href: '/crm/naughty-list',  label: 'Naughty list',  module: 'crm' },
      ]},
      { href: '/crm/campaigns',     label: 'Campaigns',   icon: '✉️', module: 'campaigns' },
      { href: '/complaints',        label: 'Complaints',  icon: '🎫', module: 'complaints' },
      { href: '/reviews',           label: 'Reviews',     icon: '⭐', module: 'reviews' },
      { href: '/calendar',          label: 'Calendar',    icon: '📅', module: 'calendar' },
      { href: '/media',             label: 'Media',       icon: '🖼', module: 'media' },
      { href: '/promos',            label: 'Promotions',  icon: '🎟', module: 'promos', children: [
        { href: '/discounts', label: 'Discounts', module: 'promos' },
        { href: '/qrcodes',   label: 'QR Codes',  module: 'promos' },
      ]},
      { href: '/analytics',         label: 'Analytics',   icon: '📊', module: 'analytics' },
    ],
  },
  {
    title: 'Finance',
    defaultCollapsed: true,
    items: [
      { href: '/finance',                label: 'P&L',             icon: '💰', module: 'finance_pl' },
      { href: '/accounting',             label: 'Accounting',      icon: '📊', module: 'accounting', children: [
        { href: '/accounting/food-cost',        label: 'Food Cost',        module: 'accounting' },
        // Sales-mix quadrant report (orders × margin). Renamed so the ONE
        // "Menu Engineering" is the Kitchen pricing page at /menu-engineering.
        { href: '/accounting/menu-engineering', label: 'Sales Quadrants', module: 'accounting' },
        { href: '/allocations',                 label: 'Allocations',      module: 'accounting' },
      ]},
      { href: '/gift-cards',             label: 'Gift Cards',      icon: '🎁', module: 'gift_cards' },
      { href: '/reconciliation',         label: 'Reconciliation',  icon: '⚖️', module: 'reconciliation' },
      { href: '/exceptions',             label: 'Exceptions',      icon: '🚨', module: 'exceptions' },
      // Investment Dashboard is a read-only roll-up of Project Tracker —
      // every CapexLine + payment flows here. To log anything, use the
      // Capex tab under Project Tracker.
      { href: '/finance/capital-ledger', label: 'Investment',      icon: '📊', module: 'capital' },
      { href: '/procurement',            label: 'Procurement',     icon: '🏭', module: 'procurement', children: [
        { href: '/procurement/chat',    label: 'Supplier Chat', module: 'procurement' },
        { href: '/procurement/monitor', label: 'Monitor',       module: 'procurement' },
      ]},
      { href: '/reports',                label: 'Reports',         icon: '📈', module: 'reports', children: [
        { href: '/analytics/forecast', label: 'Demand Forecast', module: 'reports' },
      ]},
    ],
  },
  // Note: the standalone "Project Tracker" section moved into Executive above
  // (Capex / OpEx / Projections as children of one Project Tracker entry).
  // Note: the standalone "Setup" section was retired — the first-run wizard is
  // still reachable from the Dashboard onboarding checklist, and the surfaces
  // worth keeping (Integrations, Notifications, Help) moved up into Executive.
]

const FULL_SCREEN_PREFIXES = ['/kds', '/pos', '/login', '/supplier', '/mobile']

function isActive(pathname: string, href: string): boolean {
  if (href === '/dashboard') return pathname === '/dashboard' || pathname === '/'
  return pathname === href || pathname.startsWith(href + '/')
}

// ─── Local-storage hooks ─────────────────────────────────────────────────────

function usePersistedSet(key: string, defaultValue: Set<string>): [Set<string>, (next: Set<string>) => void] {
  const [value, setValue] = useState<Set<string>>(defaultValue)
  // Hydrate from localStorage after mount
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = localStorage.getItem(key)
      if (raw) setValue(new Set(JSON.parse(raw) as string[]))
    } catch { /* ignore */ }
  }, [key])
  function update(next: Set<string>) {
    setValue(next)
    try { localStorage.setItem(key, JSON.stringify(Array.from(next))) } catch { /* ignore */ }
  }
  return [value, update]
}

// ─── Nav rendering ──────────────────────────────────────────────────────────

function NavLinks({
  pathname,
  collapsed,
  onNavigate,
}: {
  pathname: string
  collapsed: boolean
  onNavigate?: () => void
}) {
  // Determine the role that drives nav visibility. Real role for everyone,
  // overridden by the view-as switcher when admin/CEO is impersonating.
  const { data: me } = usePermissions()
  const viewAsRole = useViewAsRole((s) => s.role)
  // Keep the local role→modules cache in step with the server's rows so every
  // admin browser renders the same matrix (and the API enforces the same one).
  useSyncRoleModules()
  const overrides = useRoleModules((s) => s.overrides)
  const isSuper = me?.role === 'admin'
  const effectiveRole: AppRole = (
    isSuper && viewAsRole
      ? viewAsRole
      : (me?.role ?? 'cashier')
  ) as AppRole

  // Modules the effective role is allowed to see, derived from the CEO-editable
  // role→modules map. Memoised so we don't re-derive on every nav render.
  const allowedModules = useMemo(() => {
    if (isSuper && !viewAsRole) return null               // real admin/CEO sees everything
    return new Set<ModuleId>(modulesForRole(effectiveRole, overrides))
  }, [isSuper, viewAsRole, effectiveRole, overrides])

  function visibleByModule(module?: ModuleId) {
    if (!allowedModules) return true                      // real admin/CEO: full access
    if (!module) return true                              // un-tagged items default visible
    return allowedModules.has(module)
  }

  // Live per-station KDS entries — sidebar injects one child under "Stations"
  // for every station the operator has configured. Stations are concept-scoped
  // and dynamic, so we fetch at runtime rather than hard-coding the NAV array.
  // Visible only to staff who can see kds_all (the kitchen line + management).
  const { data: stations = [] } = useQuery<Array<{ id: string; name: string; isActive: boolean }>>({
    queryKey: ['nav-stations'],
    queryFn:  () => api.get('/kds/stations'),
    staleTime: 60_000,
    // Skip the query for roles that don't see kitchen surfaces — the line cook,
    // POS-only cashier, etc. don't need the sidebar to ask the server.
    enabled:  !allowedModules || allowedModules.has('kds_all'),
  })

  // ── Module-scoped navigation ────────────────────────────────────────────
  //
  // The sidebar used to be the whole app: one long dropdown tree of every
  // section. Navigation now starts at the /modules hub, and the sidebar shows
  // ONLY the module you are currently inside. Items stay module-gated exactly
  // as before, so a partial-access role sees a partial list.
  const currentModule = useMemo(() => moduleForPath(pathname), [pathname])

  const moduleNav: NavSection[] = useMemo(() => {
    if (!currentModule) return []
    const items: NavItem[] = currentModule.sections.map((sec) => ({
      href: sec.href,
      label: sec.label,
      icon: '·',
      ...(sec.module ? { module: sec.module } : {}),
    }))
    // Live per-station KDS entries still belong under the Kitchen module.
    if (currentModule.id === 'kitchen' && stations.length > 0) {
      for (const st of stations.filter((s) => s.isActive)) {
        items.push({ href: `/kds/${st.id}`, label: st.name, icon: '·', module: 'kds_all' })
      }
    }
    return [{ title: currentModule.name, items }]
  }, [currentModule, stations])

  // Legacy full tree — retained only so the station-injection logic below keeps
  // compiling; it is no longer rendered.
  const legacyNav: NavSection[] = useMemo(() => {
    if (stations.length === 0) return NAV
    const activeStations = stations.filter((s) => s.isActive)
    return NAV.map((section) => {
      if (section.title !== 'Live') return section
      const newItems: NavItem[] = []
      for (const item of section.items) {
        newItems.push(item)
        if (item.href === '/expo') {
          // Insert a Stations parent right after Expo Station for expediters
          // and managers — gives them a 1-tap jump into any station's
          // full-screen view. The parent click lands on /kds (kitchen
          // dashboard) since expediters don't have kds_config access;
          // children open each station directly. The kitchen role doesn't
          // have kds_all so this whole subtree filters out for them — they
          // use the /kds dashboard cards instead.
          newItems.push({
            href: '/kds',
            label: 'Stations',
            icon: '🍳',
            module: 'kds_all',
            children: activeStations.map((s) => ({
              href:   `/kds/${s.id}`,
              label:  s.name,
              module: 'kds_all',
            })),
          })
        }
      }
      return { ...section, items: newItems }
    })
  }, [stations])

  // Section collapse state — defaults from NAV definition, persisted to localStorage
  const defaultCollapsedSet = useMemo(() => new Set(NAV.filter((s) => s.defaultCollapsed).map((s) => s.title)), [])
  const [collapsedSections, setCollapsedSections] = usePersistedSet('servd_nav_collapsed_v2', defaultCollapsedSet)

  // Expanded parents (child reveal) — also persisted
  const [expandedParents, setExpandedParents] = usePersistedSet('servd_nav_expanded_parents_v1', new Set())

  // Pinned items — flat list of hrefs the user has starred
  const [pinned, setPinned] = usePersistedSet('servd_nav_pinned_v1', new Set())

  function toggleSection(title: string) {
    const next = new Set(collapsedSections)
    if (next.has(title)) next.delete(title); else next.add(title)
    setCollapsedSections(next)
  }
  function toggleParent(href: string) {
    const next = new Set(expandedParents)
    if (next.has(href)) next.delete(href); else next.add(href)
    setExpandedParents(next)
  }
  function togglePin(href: string) {
    const next = new Set(pinned)
    if (next.has(href)) next.delete(href); else next.add(href)
    setPinned(next)
  }

  // Auto-expand parent if we're on a child route
  useEffect(() => {
    if (collapsed) return
    for (const section of moduleNav) {
      for (const item of section.items) {
        if (item.children?.some((c) => isActive(pathname, c.href))) {
          if (!expandedParents.has(item.href)) {
            const next = new Set(expandedParents)
            next.add(item.href)
            setExpandedParents(next)
          }
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  // Flatten all items so we can resolve pinned hrefs to icon+label.
  // Uses renderedNav so dynamically-injected station children also resolve
  // when the operator pins one (otherwise they'd appear as orphans).
  const allItems = useMemo(() => {
    const map = new Map<string, NavItem>()
    for (const s of legacyNav) {
      for (const i of s.items) {
        map.set(i.href, i)
        for (const c of i.children ?? []) {
          map.set(c.href, { href: c.href, label: c.label, icon: '·' })
        }
      }
    }
    return map
  }, [legacyNav])

  const pinnedItems = useMemo(() =>
    Array.from(pinned).map((h) => allItems.get(h)).filter((x): x is NavItem => !!x),
  [pinned, allItems])

  return (
    <nav className="relative z-10 flex-1 overflow-y-auto scrollbar-hide py-2 space-y-3">
      {/* ── Pinned strip ────────────────────────────────────────────────── */}
      {pinnedItems.length > 0 && (
        <div>
          {!collapsed && (
            <SectionHeader title="Pinned" collapsed={false} onClick={() => { /* always shown */ }} />
          )}
          <div className="space-y-0.5 px-1.5">
            {pinnedItems.map((item) => (
              <NavLinkRow key={item.href} item={item} active={isActive(pathname, item.href)}
                collapsed={collapsed} pinned={true}
                onNavigate={onNavigate}
                onTogglePin={() => togglePin(item.href)} />
            ))}
          </div>
        </div>
      )}

      {/* ── Back to the hub ────────────────────────────────────────────
          Navigation starts at /modules; every screen keeps a way back to it. */}
      <div className="px-1.5 pb-2">
        <Link
          href="/modules"
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-bold transition-colors"
          style={{ color: 'rgba(255,255,255,0.55)', background: 'rgba(255,255,255,0.03)' }}
          title="All modules"
        >
          <span aria-hidden>⊞</span>
          {!collapsed && <span>All modules</span>}
        </Link>
      </div>

      {/* ── Current module ─────────────────────────────────────────────── */}
      {moduleNav.map((section) => {
        // Governance rows (Roles & Permissions, Module Access) stay hidden by
        // their module atoms — an owner simply doesn't hold them — so no
        // section-level special case is needed any more.
        const sectionItems = section.items.filter((i) => visibleByModule(i.module))
        if (sectionItems.length === 0) return null
        const isCollapsed = collapsedSections.has(section.title)
        return (
          <div key={section.title}>
            {!collapsed && (
              <SectionHeader title={section.title} collapsed={isCollapsed}
                onClick={() => toggleSection(section.title)} />
            )}
            {collapsed && <div className="h-px mx-2 mb-2" style={{ background: 'rgba(255,255,255,0.04)' }} />}
            {(!isCollapsed || collapsed) && (
              <div className="space-y-0.5 px-1.5">
                {sectionItems.map((item) => {
                  const active = isActive(pathname, item.href)
                  const visibleChildren = (item.children ?? []).filter((c) => visibleByModule(c.module))
                  const hasChildren = visibleChildren.length > 0
                  const expanded = expandedParents.has(item.href)
                  return (
                    <div key={item.href}>
                      <NavLinkRow
                        item={item}
                        active={active}
                        collapsed={collapsed}
                        pinned={pinned.has(item.href)}
                        expandable={hasChildren}
                        expanded={expanded}
                        onNavigate={onNavigate}
                        onTogglePin={() => togglePin(item.href)}
                        onToggleExpand={() => toggleParent(item.href)}
                      />
                      {/* Children */}
                      {!collapsed && hasChildren && expanded && visibleChildren.map((c) => (
                        <Link key={c.href} href={c.href}
                          onClick={() => onNavigate?.()}
                          className="flex items-center gap-2 rounded-md transition-all duration-150 ml-7 mr-1.5 px-2.5 py-1.5 group"
                          style={isActive(pathname, c.href) ? {
                            background: 'rgba(0,212,177,0.08)',
                            color: '#00D4B1',
                          } : {
                            background: 'transparent',
                            color: 'rgba(255,255,255,0.32)',
                          }}
                          onMouseEnter={(e) => { if (!isActive(pathname, c.href)) e.currentTarget.style.color = 'rgba(255,255,255,0.65)' }}
                          onMouseLeave={(e) => { if (!isActive(pathname, c.href)) e.currentTarget.style.color = 'rgba(255,255,255,0.32)' }}
                        >
                          <span className="text-[10px] opacity-50">└</span>
                          <span className="text-[11.5px] font-medium leading-none truncate flex-1">{c.label}</span>
                        </Link>
                      ))}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </nav>
  )
}

function SectionHeader({ title, collapsed, onClick }: { title: string; collapsed: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="flex items-center gap-1.5 px-4 pb-1.5 w-full group"
      title={collapsed ? `Expand ${title}` : `Collapse ${title}`}>
      <div className="h-px flex-1" style={{ background: 'rgba(255,255,255,0.05)' }} />
      <span className="flex items-center gap-1">
        <span
          className="transition-transform duration-150"
          style={{
            color: 'rgba(255,255,255,0.18)',
            display: 'inline-block',
            transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
            fontSize: '8px',
          }}
        >▼</span>
        <span className="text-[9px] font-black uppercase tracking-[0.28em] group-hover:text-white/45 transition-colors"
          style={{ color: 'rgba(255,255,255,0.32)' }}>
          {title}
        </span>
      </span>
      <div className="h-px flex-1" style={{ background: 'rgba(255,255,255,0.05)' }} />
    </button>
  )
}

function NavLinkRow({
  item,
  active,
  collapsed,
  pinned,
  expandable,
  expanded,
  onNavigate,
  onTogglePin,
  onToggleExpand,
}: {
  item: NavItem
  active: boolean
  collapsed: boolean
  pinned: boolean
  expandable?: boolean
  expanded?: boolean
  onNavigate?: () => void
  onTogglePin: () => void
  onToggleExpand?: () => void
}) {
  return (
    <div className="group relative flex items-center">
      <Link href={item.href}
        onClick={() => onNavigate?.()}
        title={collapsed ? item.label : undefined}
        className={`nav-active-glow flex items-center gap-2.5 rounded-[10px] transition-all duration-150 flex-1 ${
          collapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2'
        }`}
        style={active ? {
          background: 'linear-gradient(135deg, rgba(0,212,177,0.1) 0%, rgba(99,102,241,0.08) 100%)',
          border: '1px solid rgba(0,212,177,0.18)',
          color: '#00D4B1',
          boxShadow: '0 0 12px rgba(0,212,177,0.08)',
        } : {
          background: 'transparent',
          border: '1px solid transparent',
          color: 'rgba(255,255,255,0.42)',
        }}
        onMouseEnter={(e) => { if (!active) { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = 'rgba(255,255,255,0.78)' } }}
        onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.42)' } }}
      >
        <span className="text-[15px] shrink-0">{item.icon}</span>
        {!collapsed && (
          <span className="text-[12.5px] font-semibold leading-none truncate flex-1">{item.label}</span>
        )}
        {!collapsed && item.badge && (
          <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full"
            style={{ background: 'rgba(255,77,79,0.18)', color: '#FF4D4F' }}>
            {item.badge}
          </span>
        )}
      </Link>

      {/* Pin star + expand chevron — only when not collapsed */}
      {!collapsed && (
        <div className="absolute right-1.5 flex items-center gap-0.5">
          <button onClick={(e) => { e.stopPropagation(); onTogglePin() }}
            className="p-1 rounded hover:bg-white/10 transition-colors"
            title={pinned ? 'Unpin' : 'Pin to top'}
            style={{ color: pinned ? '#F59E0B' : 'rgba(255,255,255,0.15)', opacity: pinned ? 1 : 0 }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
            onMouseLeave={(e) => { if (!pinned) e.currentTarget.style.opacity = '0' }}
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5">
              <path d="M6 1l1.5 3.5L11 5l-2.7 2.4L9 11 6 9 3 11l.7-3.6L1 5l3.5-.5L6 1z" />
            </svg>
          </button>
          {expandable && (
            <button onClick={(e) => { e.stopPropagation(); onToggleExpand?.() }}
              className="p-1 rounded hover:bg-white/10 transition-colors"
              title={expanded ? 'Collapse' : 'Expand'}
              style={{ color: 'rgba(255,255,255,0.3)' }}>
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"
                style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                <path d="M4 2l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── AppShell ────────────────────────────────────────────────────────────────

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  // Default to the icon rail on tablet-width screens (the persistent sidebar
  // otherwise eats ~220px of a tablet's content); <768px uses the drawer.
  // A saved preference always wins.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = localStorage.getItem('servd_sidebar_collapsed')
    if (stored !== null) { setCollapsed(stored === '1'); return }
    setCollapsed(window.matchMedia('(min-width: 768px) and (max-width: 1023px)').matches)
  }, [])
  const setCollapsedPersisted = (next: boolean) => {
    setCollapsed(next)
    try { localStorage.setItem('servd_sidebar_collapsed', next ? '1' : '0') } catch { /* ignore */ }
  }
  const [clockingOut, setClockingOut] = useState(false)
  const { user, token, clearAuth } = useAuthStore()

  async function handleClockOut() {
    if (clockingOut) return
    setClockingOut(true)
    try {
      await fetch(`${API_URL}/api/v1/auth/clock-out`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token ?? ''}` },
      })
    } catch { /* ignore network errors — still sign out */ }
    clearAuth()
    router.replace('/login')
  }

  const isFullScreen = FULL_SCREEN_PREFIXES.some((p) => pathname.startsWith(p))
  if (isFullScreen) return <>{children}</>

  const initials = user?.name?.[0]?.toUpperCase() ?? '?'

  const sidebarBg = {
    background: 'linear-gradient(180deg, #0d0f15 0%, #0b0d12 50%, #0d0f16 100%)',
    borderRight: '1px solid rgba(255,255,255,0.055)',
    boxShadow: 'inset -1px 0 0 rgba(0,212,177,0.04)',
  }

  function UserFooter({ collapsed: c }: { collapsed: boolean }) {
    return (
      <div className={`relative z-10 shrink-0 ${c ? 'px-1.5 py-2' : 'px-3 py-3'}`}
        style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        {c ? (
          <button onClick={() => void handleClockOut()} disabled={clockingOut}
            className="w-full flex justify-center py-1.5 rounded-lg transition-colors"
            style={{ color: 'rgba(255,255,255,0.2)' }}
            title="Clock out"
            onMouseEnter={(e) => (e.currentTarget.style.color = '#FF4D4F')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.2)')}>
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
              <path d="M10 5L13 7.5m0 0L10 10M13 7.5H6M6 3H4a1.5 1.5 0 00-1.5 1.5v6A1.5 1.5 0 004 12H6"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        ) : (
          <div className="space-y-1.5">
            <UserIdentityCard initials={initials} />
            <button onClick={() => void handleClockOut()} disabled={clockingOut}
              className="w-full flex items-center justify-center gap-1.5 rounded-xl py-1.5 text-xs font-semibold transition-all disabled:opacity-50"
              style={{ background: 'rgba(255,77,79,0.08)', border: '1px solid rgba(255,77,79,0.18)', color: '#FF4D4F' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,77,79,0.14)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,77,79,0.08)' }}>
              <svg width="12" height="12" viewBox="0 0 13 13" fill="none">
                <path d="M9 4L11.5 6.5m0 0L9 9M11.5 6.5H5M5 2H3.5A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {clockingOut ? 'Clocking out…' : 'Clock out'}
            </button>
          </div>
        )}
      </div>
    )
  }

  function UserIdentityCard({ initials }: { initials: string }) {
    const { data: me } = usePermissions()
    const viewAs = useViewAsRole((s) => s.role)
    const setRole = useViewAsRole((s) => s.setRole)
    // Only the CEO (admin) can impersonate other roles + approve new staff.
    const isSuper = me?.role === 'admin'

    // Pending-approvals badge — only fetched for the CEO. Polls every 30s so
    // a new signup appears in the sidebar without a page refresh.
    const { data: pending = [] } = useQuery<Array<{ id: string }>>({
      queryKey: ['staff', 'pending'],
      queryFn:  () => api.get('/auth/staff/pending'),
      enabled:  isSuper,
      refetchInterval: 30_000,
      staleTime: 15_000,
    })

    // Drop admin/CEO from impersonation targets — viewing-as-self is the
    // default state, no need to offer it as a discrete option.
    const switchTargets = APP_ROLES.filter((r) => r.value !== 'admin')

    return (
      <div className="rounded-xl px-2 py-1.5"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
        <div className="flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-full shrink-0 flex items-center justify-center text-xs font-black"
            style={{
              background: 'linear-gradient(135deg, #00D4B1, #6366F1)',
              color: '#000',
              boxShadow: '0 0 10px rgba(0,212,177,0.25)',
            }}>
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold truncate" style={{ color: 'rgba(255,255,255,0.75)' }}>
              {user?.name ?? 'Staff'}
            </p>
            <p className="text-[10px]" style={{ color: isSuper ? '#FCD34D' : 'rgba(255,255,255,0.25)' }}>
              {isSuper ? '👑 CEO' : roleLabel(user?.role)}
            </p>
          </div>
        </div>

        {/* CEO-only: live link to the pending-approvals queue with a badge
            showing how many staff are waiting. Hidden when nothing is in
            the queue so the card stays quiet. */}
        {isSuper && pending.length > 0 && (
          <Link href="/configuration/pending-approvals"
            className="mt-1.5 pt-1.5 border-t border-white/[0.05] flex items-center gap-2 rounded-md px-1 py-1 -mx-1 transition-colors"
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(245,158,11,0.06)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
            <span className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: '#F59E0B' }} />
            <span className="text-[10px] font-bold flex-1" style={{ color: '#F59E0B' }}>
              {pending.length} pending {pending.length === 1 ? 'signup' : 'signups'}
            </span>
            <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.4)' }}>→</span>
          </Link>
        )}

        {isSuper && (
          <div className={`${pending.length > 0 ? 'mt-1' : 'mt-1.5'} pt-1.5 border-t border-white/[0.05] flex items-center gap-1.5`}>
            <span className="text-[9px] uppercase tracking-wider font-bold shrink-0"
              style={{ color: viewAs ? '#A5B4FC' : 'rgba(255,255,255,0.3)' }}>
              {viewAs ? '🔭 As' : 'View as'}
            </span>
            <select
              value={viewAs ?? ''}
              onChange={(e) => setRole((e.target.value || null) as ViewAsRole)}
              className="flex-1 text-[10.5px] font-semibold rounded-md px-1.5 py-1 cursor-pointer focus:outline-none"
              style={{
                background: viewAs ? 'rgba(99,102,241,0.12)' : 'rgba(0,0,0,0.3)',
                color: viewAs ? '#A5B4FC' : 'rgba(255,255,255,0.6)',
                border: `1px solid ${viewAs ? 'rgba(99,102,241,0.3)' : 'rgba(255,255,255,0.06)'}`,
              }}>
              <option value="">Myself</option>
              {switchTargets.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.emoji} {opt.label}</option>
              ))}
            </select>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#090a0e' }}>

      {/* ── Mobile overlay ─────────────────────────────────────────────────── */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* ── Mobile drawer ──────────────────────────────────────────────────── */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-[220px] flex flex-col transition-transform duration-300 md:hidden ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={sidebarBg}
      >
        <div className="absolute pointer-events-none select-none"
          style={{ width: '200px', height: '200px', bottom: '20%', left: '-60px',
            background: 'radial-gradient(circle, rgba(0,212,177,0.06) 0%, transparent 70%)',
            animation: 'ops-glowPulse 8s ease-in-out infinite' }} />
        <div className="absolute pointer-events-none select-none"
          style={{ width: '160px', height: '160px', top: '15%', right: '-70px',
            background: 'radial-gradient(circle, rgba(99,102,241,0.05) 0%, transparent 70%)',
            animation: 'ops-glowPulse 11s ease-in-out infinite reverse' }} />

        <div className="relative z-10 flex items-center h-[54px] shrink-0 px-4 gap-3"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div className="h-7 w-7 rounded-lg shrink-0 flex items-center justify-center relative overflow-hidden"
            style={{ background: 'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)', boxShadow: '0 0 16px rgba(0,212,177,0.35)' }}>
            <span className="text-xs font-black text-black relative z-10">S</span>
          </div>
          <span className="text-sm font-black tracking-tight ops-shimmer-text flex-1">servd</span>
          <button onClick={() => setMobileOpen(false)}
            className="text-white/30 hover:text-white/70 transition-colors p-1 rounded">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <TenantSwitcher collapsed={false} />
        <BrandPicker collapsed={false} />
        <NavLinks pathname={pathname} collapsed={false} onNavigate={() => setMobileOpen(false)} />
        <UserFooter collapsed={false} />
      </aside>

      {/* ── Desktop sidebar ────────────────────────────────────────────────── */}
      <aside
        className={`hidden md:flex flex-col shrink-0 relative transition-all duration-300 overflow-hidden ${
          collapsed ? 'w-[52px]' : 'w-[220px]'
        }`}
        style={sidebarBg}
      >
        <div className="absolute pointer-events-none select-none"
          style={{ width: '200px', height: '200px', bottom: '20%', left: '-60px',
            background: 'radial-gradient(circle, rgba(0,212,177,0.06) 0%, transparent 70%)',
            animation: 'ops-glowPulse 8s ease-in-out infinite' }} />
        <div className="absolute pointer-events-none select-none"
          style={{ width: '160px', height: '160px', top: '15%', right: '-70px',
            background: 'radial-gradient(circle, rgba(99,102,241,0.05) 0%, transparent 70%)',
            animation: 'ops-glowPulse 11s ease-in-out infinite reverse' }} />

        <div className={`relative z-10 flex items-center h-[54px] shrink-0 ${collapsed ? 'justify-center' : 'px-4 gap-3'}`}
          style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div className="h-7 w-7 rounded-lg shrink-0 flex items-center justify-center relative overflow-hidden"
            style={{ background: 'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)', boxShadow: '0 0 16px rgba(0,212,177,0.35)' }}>
            <span className="text-xs font-black text-black relative z-10">S</span>
          </div>
          {!collapsed && (
            <>
              <span className="text-sm font-black tracking-tight ops-shimmer-text flex-1">servd</span>
              <button onClick={() => setCollapsedPersisted(true)}
                className="text-white/20 hover:text-white/55 transition-colors p-1 rounded"
                style={{ marginRight: '-4px' }}>
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                  <path d="M8 2L3 6.5l5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </>
          )}
        </div>

        {collapsed && (
          <button onClick={() => setCollapsedPersisted(false)}
            className="relative z-10 flex justify-center py-2.5 transition-colors"
            style={{ color: 'rgba(255,255,255,0.2)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.55)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.2)')}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M5 2l5 4.5L5 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        )}

        <TenantSwitcher collapsed={collapsed} />
        <BrandPicker collapsed={collapsed} />
        <NavLinks pathname={pathname} collapsed={collapsed} />
        <UserFooter collapsed={collapsed} />
      </aside>

      {/* ── Main content ──────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden" style={{ background: '#090a0e' }}>

        <header className="md:hidden flex items-center h-[54px] shrink-0 px-4 gap-3"
          style={{ background: '#0d0f15', borderBottom: '1px solid rgba(255,255,255,0.055)' }}>
          <button onClick={() => setMobileOpen(true)}
            className="text-white/40 hover:text-white/80 transition-colors p-1.5 rounded-lg"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
          <div className="h-6 w-6 rounded-md flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)' }}>
            <span className="text-[10px] font-black text-black">S</span>
          </div>
          <span className="text-sm font-black tracking-tight ops-shimmer-text">servd</span>
        </header>

        <PortfolioBanner />
        <ImpersonationBanner />
        <main className="flex-1 min-h-0 overflow-y-auto animate-fade-in">
          {children}
        </main>
      </div>

      {/* Global guard — opens when any portfolio-mode write is attempted via
          the useEnsureTenant hook. Mounted once at the shell so any page can
          trigger it without a parent component plumbing it through. */}
      <PortfolioWriteGuardModal />
    </div>
  )
}

function PortfolioBanner() {
  const on = useViewAllTenants()
  if (!on) return null
  return (
    <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 text-xs"
      style={{
        background: 'rgba(0,212,177,0.08)',
        borderBottom: '1px solid rgba(0,212,177,0.2)',
        color: '#00D4B1',
      }}>
      <span className="font-black">∞</span>
      <span className="font-bold">Portfolio view</span>
      <span className="text-white/55">— viewing across all your companies. We&rsquo;ll ask which company to use when you make a change.</span>
    </div>
  )
}

// ─── Role impersonation options + banner ────────────────────────────────────
//
// Admin / CEO can preview the app as any other role using the dropdown inside
// the user identity card. When engaged, useCan() and the sidebar nav resolve
// against the chosen role's CEO-defined module allow-list. A banner across
// the top reminds the operator they're impersonating.
//
// The dropdown options are drawn from APP_ROLES in src/lib/appRoles.ts so a
// new role only needs to be added in one place.

function ImpersonationBanner() {
  const viewAs = useViewAsRole((s) => s.role)
  const clear = useViewAsRole((s) => s.clear)
  const { data: me } = usePermissions()
  const isSuper = me?.role === 'admin'
  if (!viewAs || !isSuper) return null
  const opt = APP_ROLES.find((o) => o.value === viewAs)
  return (
    <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 text-xs"
      style={{
        background: 'rgba(99,102,241,0.12)',
        borderBottom: '1px solid rgba(99,102,241,0.3)',
        color: '#A5B4FC',
      }}>
      <span className="font-black">{opt?.emoji ?? '🔭'}</span>
      <span className="font-bold">Viewing as {opt?.label ?? viewAs}</span>
      <span className="text-white/55">— sidebar & action buttons reflect what this role sees. Writes still run as you.</span>
      <button onClick={() => clear()}
        className="ml-auto rounded-md px-2 py-0.5 text-[10px] font-bold transition-colors"
        style={{ background: 'rgba(99,102,241,0.2)', color: '#A5B4FC' }}>
        Back to CEO view
      </button>
    </div>
  )
}
