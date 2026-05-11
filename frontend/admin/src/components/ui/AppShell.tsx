'use client'
import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useAuthStore } from '../../store/auth'
import { TenantSwitcher, useViewAllTenants } from './TenantSwitcher'
import { PortfolioWriteGuardModal } from './PortfolioWriteGuardModal'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

// ─── Nav structure ────────────────────────────────────────────────────────────
//
// Design rules:
// - Sections collapse independently. State persisted per-user to localStorage.
// - Heavy / config-tier sections (Marketing, Finance, Setup) start collapsed.
// - Items can have `children` — only revealed when the parent's pill is open.
// - User can pin any item (★) — pinned items render in a sticky strip up top.

interface NavItem {
  href: string
  label: string
  icon: string
  badge?: string
  children?: Array<{ href: string; label: string }>
}

interface NavSection {
  title: string
  items: NavItem[]
  defaultCollapsed?: boolean
}

const NAV: NavSection[] = [
  {
    title: 'Live',
    items: [
      { href: '/dashboard', label: 'Dashboard',    icon: '⬡' },
      { href: '/ops',       label: 'Ops Center',   icon: '⚡' },
      { href: '/orders',    label: 'Orders',       icon: '📋' },
      { href: '/kds/all',   label: 'Kitchen KDS',  icon: '🖥' },
      { href: '/chain',     label: 'Chain Rollup', icon: '🏢' },
    ],
  },
  {
    title: 'Service',
    items: [
      { href: '/pos', label: 'Point of Sale', icon: '💳', children: [
        { href: '/pos/waiter', label: 'Waiter mode' },
        { href: '/pos/shift',  label: 'Shift / Till' },
      ]},
      { href: '/reservations', label: 'Reservations', icon: '🍽', children: [
        { href: '/reservations/week',      label: 'Week view' },
        { href: '/reservations/blockouts', label: 'Closures & blockouts' },
        { href: '/reservations/hours',     label: 'Service hours' },
        { href: '/reservations/analytics', label: 'Analytics' },
        { href: '/kds/reservations',       label: 'Kitchen tracker' },
      ]},
      { href: '/orders/curbside', label: 'Curbside', icon: '🚗' },
      { href: '/scheduling',  label: 'Scheduling', icon: '📅' },
      { href: '/tables',      label: 'Floor Plan', icon: '🪑' },
      { href: '/dispatch',    label: 'Dispatch',   icon: '🛵', children: [
        { href: '/riders', label: 'Riders' },
      ]},
    ],
  },
  {
    title: 'Kitchen',
    items: [
      { href: '/menu',                label: 'Menu',         icon: '📝' },
      { href: '/components',          label: 'Components',   icon: '🧪' },
      { href: '/accounting/recipes',  label: 'Recipes',      icon: '📐' },
      { href: '/inventory',           label: 'Inventory',    icon: '📦' },
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
      { href: '/marketing',         label: 'Workspace',   icon: '🚀', children: [
        { href: '/marketing/activity', label: 'Activity Log' },
      ]},
      { href: '/crm',               label: 'CRM',         icon: '👥', children: [
        { href: '/crm/conversations', label: 'Conversations' },
        { href: '/crm/segments',      label: 'Segments' },
        { href: '/crm/naughty-list',  label: 'Naughty list' },
      ]},
      { href: '/crm/campaigns',     label: 'Campaigns',   icon: '✉️' },
      { href: '/complaints',        label: 'Complaints',  icon: '🎫' },
      { href: '/reviews',           label: 'Reviews',     icon: '⭐' },
      { href: '/calendar',          label: 'Calendar',    icon: '📅' },
      { href: '/media',             label: 'Media',       icon: '🖼' },
      { href: '/promos',            label: 'Promotions',  icon: '🎟', children: [
        { href: '/discounts', label: 'Discounts' },
        { href: '/qrcodes',   label: 'QR Codes' },
      ]},
      { href: '/marketing/brands',  label: 'Brands',      icon: '🏷', children: [
        { href: '/marketing/storefront', label: 'Storefront Designer' },
        { href: '/storefront',          label: 'Visual Layout' },
      ]},
      { href: '/analytics',         label: 'Analytics',   icon: '📊' },
    ],
  },
  {
    title: 'Finance',
    defaultCollapsed: true,
    items: [
      { href: '/finance',                label: 'P&L',          icon: '💰' },
      { href: '/accounting',             label: 'Accounting',   icon: '📊', children: [
        { href: '/accounting/food-cost',         label: 'Food Cost' },
        { href: '/accounting/menu-engineering', label: 'Menu Engineering' },
      ]},
      { href: '/finance/capital-ledger', label: 'Capital',      icon: '💸' },
      { href: '/finance/capex',          label: 'Project Tracker', icon: '📊' },
      { href: '/finance/projections',    label: 'Pro-Forma',    icon: '📈' },
      { href: '/procurement',            label: 'Procurement',  icon: '🏭', children: [
        { href: '/procurement/chat',    label: 'Supplier Chat' },
        { href: '/procurement/monitor', label: 'Monitor' },
      ]},
      { href: '/reports',                label: 'Reports',      icon: '📈', children: [
        { href: '/analytics/forecast', label: 'Demand Forecast' },
      ]},
    ],
  },
  {
    title: 'Setup',
    defaultCollapsed: false,
    items: [
      { href: '/setup',         label: 'First-run setup',   icon: '🚀' },
      { href: '/configuration', label: 'Configuration Hub', icon: '🎛' },
      { href: '/settings',      label: 'Brands & Stations', icon: '🏷' },
      { href: '/help',          label: 'Help & Support',    icon: '❓' },
    ],
  },
]

const FULL_SCREEN_PREFIXES = ['/kds', '/pos', '/login', '/supplier', '/welcome', '/signup', '/mobile']

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
    for (const section of NAV) {
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

  // Flatten all items so we can resolve pinned hrefs to icon+label
  const allItems = useMemo(() => {
    const map = new Map<string, NavItem>()
    for (const s of NAV) {
      for (const i of s.items) {
        map.set(i.href, i)
        for (const c of i.children ?? []) {
          map.set(c.href, { href: c.href, label: c.label, icon: '·' })
        }
      }
    }
    return map
  }, [])

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

      {/* ── Sections ───────────────────────────────────────────────────── */}
      {NAV.map((section) => {
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
                {section.items.map((item) => {
                  const active = isActive(pathname, item.href)
                  const hasChildren = (item.children?.length ?? 0) > 0
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
                      {!collapsed && hasChildren && expanded && item.children!.map((c) => (
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
            <div className="flex items-center gap-2.5 rounded-xl px-2 py-1.5"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div className="h-7 w-7 rounded-full shrink-0 flex items-center justify-center text-xs font-black"
                style={{
                  background: 'linear-gradient(135deg, #00D4B1, #6366F1)',
                  color: '#000',
                  boxShadow: '0 0 10px rgba(0,212,177,0.25)',
                }}>
                {initials}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold truncate" style={{ color: 'rgba(255,255,255,0.75)' }}>{user?.name ?? 'Staff'}</p>
                <p className="text-[10px] capitalize" style={{ color: 'rgba(255,255,255,0.25)' }}>{user?.role ?? ''}</p>
              </div>
            </div>
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
              <button onClick={() => setCollapsed(true)}
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
          <button onClick={() => setCollapsed(false)}
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
