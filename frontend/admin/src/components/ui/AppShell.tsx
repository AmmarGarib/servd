'use client'
import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { usePathname, useRouter } from 'next/navigation'
import { useAuthStore } from '../../store/auth'
import { api } from '../../lib/api'
import { useViewAsRole, type ViewAsRole } from '../../store/viewAsRole'
import { useSyncRoleModules } from '../../store/roleModules'
import { usePermissions } from '../../hooks/useCan'
import { useTeam } from '../../hooks/useTeam'
import { useMyWorkspaces } from '../../hooks/useWorkspaces'
import { APP_ROLES, roleLabel, type ModuleId } from '../../lib/appRoles'
import { TenantSwitcher, useViewAllTenants } from './TenantSwitcher'
import { BrandPicker } from './BrandPicker'
import { MODULE_PAGES, PERSONAL_PAGES } from '../../lib/moduleCatalog'
import { PortfolioWriteGuardModal } from './PortfolioWriteGuardModal'
import { PENDING_LAYOUTS_KEY } from '../storefront/ApprovalsPanel'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

// ─── Nav structure ────────────────────────────────────────────────────────────
//
// The sidebar is grouped by WORKSPACE (owner decision 47): Operations,
// Finance, Marketing, HR, Dev. Which workspaces a user sees, and which
// sections and modules sit in each, come from GET /permissions/me →
// `workspaces` (already filtered to the user's effective modules — the same
// resolver the API enforces with). The admin keeps no copy of the workspace
// definitions; it only knows which PAGES sit behind each module id
// (lib/moduleCatalog.ts MODULE_PAGES), so every item keeps its module tag and
// href. The user's own workspace(s) come first and start open.
//
// - Workspaces collapse independently; the choice is persisted per browser.
// - A page's sub-pages are revealed under it with the chevron.
// - Any item can be pinned (star) into a strip at the top.

interface NavItem {
  href: string
  label: string
  icon: string
  badge?: string
  children?: Array<{ href: string; label: string; module?: ModuleId }>
  module?: ModuleId
}

interface NavGroup {
  id: string
  title: string
  owner: boolean
  sections: Array<{ key: string; title: string; items: NavItem[] }>
}

/** A section's modules → sidebar items (sub-pages become children). With
 *  `lead`, only the workspace's dashboard pages; without, every other page. */
function itemsForModules(modules: readonly string[], seen: Set<string>, lead = false): NavItem[] {
  const items: NavItem[] = []
  for (const m of modules) {
    let parent: NavItem | null = null
    for (const p of MODULE_PAGES[m as ModuleId] ?? []) {
      if (seen.has(p.href) || !!p.lead !== lead) continue
      seen.add(p.href)
      if (p.sub && parent) {
        parent.children = [...(parent.children ?? []), { href: p.href, label: p.label, module: m as ModuleId }]
        continue
      }
      parent = { href: p.href, label: p.label, icon: p.icon ?? '·', module: m as ModuleId }
      items.push(parent)
    }
  }
  return items
}

const FULL_SCREEN_PREFIXES = ['/kds', '/pos', '/login', '/supplier']

function isActive(pathname: string, href: string): boolean {
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
  const { data: me } = usePermissions()
  const isSuper = me?.role === 'admin'
  // Keep the local role→modules cache in step with the server's rows — the
  // CEO's view-as preview filters the workspace definitions with it.
  useSyncRoleModules()
  const { workspaces } = useMyWorkspaces()

  const allowedModules = useMemo(() => {
    const s = new Set<string>()
    for (const w of workspaces) for (const sec of w.sections) for (const m of sec.modules) s.add(m)
    return s
  }, [workspaces])

  // Live per-station KDS entries — one child under Kitchen view for every
  // station the operator has configured (concept-scoped, so fetched).
  const { data: stations = [] } = useQuery<Array<{ id: string; name: string; isActive: boolean }>>({
    queryKey: ['nav-stations'],
    queryFn:  () => api.get('/kds/stations'),
    staleTime: 60_000,
    enabled:  allowedModules.has('kds_all'),
  })

  // CEO queues — same cache keys as the identity card's badges.
  const { data: pendingStaff = [] } = useQuery<Array<{ id: string }>>({
    queryKey: ['staff', 'pending'],
    queryFn:  () => api.get('/auth/staff/pending'),
    enabled:  isSuper,
    refetchInterval: 30_000,
    staleTime: 15_000,
  })
  const { data: pendingLayouts = [] } = useQuery<Array<{ id: string }>>({
    queryKey: PENDING_LAYOUTS_KEY,
    queryFn:  () => api.get('/site-layouts?status=pending'),
    enabled:  isSuper,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  const groups: NavGroup[] = useMemo(() => {
    return workspaces.map((w) => {
      const seen = new Set<string>()
      // The workspace's dashboard goes first, ahead of every section.
      const lead = itemsForModules(w.sections.flatMap((sec) => sec.modules), seen, true)
      const sections = w.sections.map((sec) => {
        const items = itemsForModules(sec.modules, seen).map((item) => {
          if (item.href === '/kds' && allowedModules.has('kds_all')) {
            const live = stations.filter((s) => s.isActive).map((s) => ({ href: `/kds/${s.id}`, label: s.name, module: 'kds_all' as ModuleId }))
            if (live.length) return { ...item, children: [...(item.children ?? []), ...live] }
          }
          if (item.module === 'role_management' && pendingStaff.length > 0) return { ...item, badge: String(pendingStaff.length) }
          if (item.module === 'storefront' && pendingLayouts.length > 0) return { ...item, badge: String(pendingLayouts.length) }
          return item
        })
        return { key: sec.key, title: sec.title, items }
      }).filter((s) => s.items.length > 0)
      if (lead.length) sections.unshift({ key: 'dashboard', title: 'Dashboard', items: lead })
      return { id: w.id, title: w.title, owner: w.owner, sections }
    }).filter((g) => g.sections.length > 0)
  }, [workspaces, stations, allowedModules, pendingStaff.length, pendingLayouts.length])

  // The "Me" pages only show when they have something for this login: My team
  // when people report to you (or you add logins for your workspace), My
  // approvals when you have a team or requests waiting, My HR when your login
  // is linked to an employee record. The CEO, unlinked, sees none of them.
  const { data: team } = useTeam()
  const personalItems: NavItem[] = useMemo(() => {
    const hasTeam = (team?.team.length ?? 0) > 0
    const addsLogins = me?.role !== 'admin' && (me?.childRoles?.length ?? 0) > 0
    const show: Record<string, boolean> = {
      '/team': hasTeam || addsLogins,
      '/hr/approvals': hasTeam || (team?.pendingApprovals ?? 0) > 0,
      '/hr/me': Boolean(team?.me),
    }
    return PERSONAL_PAGES.filter((p) => show[p.href] ?? true).map((p) => ({ href: p.href, label: p.label, icon: '·' }))
  }, [team, me?.role, me?.childRoles])

  // Workspace open/closed — entries "id:1" / "id:0" once the user has chosen;
  // until then the first (own) workspace and any they own start open, and the
  // one holding the current page opens itself.
  const [wsState, setWsState] = usePersistedSet('servd_nav_workspaces_v1', new Set())
  function explicitOpen(id: string): boolean | undefined {
    if (wsState.has(`${id}:1`)) return true
    if (wsState.has(`${id}:0`)) return false
    return undefined
  }
  function groupHasActive(g: NavGroup): boolean {
    return g.sections.some((s) => s.items.some((i) => isActive(pathname, i.href) || i.children?.some((c) => isActive(pathname, c.href))))
  }
  function isOpen(g: NavGroup, index: number): boolean {
    const e = explicitOpen(g.id)
    if (e !== undefined) return e
    return index === 0 || g.owner || groupHasActive(g)
  }
  function toggleGroup(g: NavGroup, index: number) {
    const next = new Set(Array.from(wsState).filter((k) => !k.startsWith(`${g.id}:`)))
    next.add(`${g.id}:${isOpen(g, index) ? 0 : 1}`)
    setWsState(next)
  }

  // Expanded parents (child reveal) — also persisted
  const [expandedParents, setExpandedParents] = usePersistedSet('servd_nav_expanded_parents_v1', new Set())

  // Pinned items — flat list of hrefs the user has starred
  const [pinned, setPinned] = usePersistedSet('servd_nav_pinned_v1', new Set())

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
    for (const g of groups) {
      for (const section of g.sections) {
        for (const item of section.items) {
          if (item.children?.some((c) => isActive(pathname, c.href)) && !expandedParents.has(item.href)) {
            const next = new Set(expandedParents)
            next.add(item.href)
            setExpandedParents(next)
          }
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, groups.length])

  // Pinned hrefs resolve only against pages this user can see — a pin to a
  // module that was since withdrawn simply disappears.
  const allItems = useMemo(() => {
    const map = new Map<string, NavItem>()
    for (const i of personalItems) map.set(i.href, i)
    for (const g of groups) {
      for (const s of g.sections) {
        for (const i of s.items) {
          map.set(i.href, i)
          for (const c of i.children ?? []) map.set(c.href, { href: c.href, label: c.label, icon: '·' })
        }
      }
    }
    return map
  }, [groups, personalItems])

  const pinnedItems = useMemo(() =>
    Array.from(pinned).map((h) => allItems.get(h)).filter((x): x is NavItem => !!x),
  [pinned, allItems])

  function renderItems(items: NavItem[]) {
    return (
      <div className="space-y-0.5 px-1.5">
        {items.map((item) => {
          const active = isActive(pathname, item.href)
          const children = item.children ?? []
          const hasChildren = children.length > 0
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
              {!collapsed && hasChildren && expanded && children.map((c) => (
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
    )
  }

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

      {/* ── Me — only the pages that have something for this login ── */}
      {personalItems.length > 0 && (
        <div>
          {!collapsed && <SubHeader title="Me" />}
          {renderItems(personalItems)}
        </div>
      )}

      {/* ── Workspaces ─────────────────────────────────────────────────── */}
      {groups.map((g, index) => {
        const open = isOpen(g, index)
        return (
          <div key={g.id}>
            {collapsed ? (
              <div className="h-px mx-2 mb-2" style={{ background: 'rgba(255,255,255,0.06)' }} />
            ) : (
              <div className="flex items-center gap-1 px-2.5 pb-1">
                <button onClick={() => toggleGroup(g, index)}
                  className="flex items-center gap-1.5 flex-1 min-w-0 rounded-md px-1.5 py-1 text-left hover:bg-white/[0.03]"
                  title={open ? `Collapse ${g.title}` : `Expand ${g.title}`}>
                  <span className="transition-transform duration-150"
                    style={{ color: 'rgba(255,255,255,0.3)', display: 'inline-block', fontSize: '8px', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
                  <span className="text-[10.5px] font-black uppercase tracking-[0.2em] truncate"
                    style={{ color: open ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.4)' }}>{g.title}</span>
                </button>
                <Link href={`/w/${g.id}`} onClick={onNavigate}
                  className="text-[10px] font-bold px-1.5 py-1 rounded-md hover:bg-white/[0.05]"
                  style={{ color: isActive(pathname, `/w/${g.id}`) ? '#00D4B1' : 'rgba(255,255,255,0.3)' }}
                  title={`${g.title} home`}>
                  home
                </Link>
              </div>
            )}
            {(open || collapsed) && g.sections.map((s) => (
              <div key={s.key} className="mb-1.5">
                {!collapsed && <SubHeader title={s.title} />}
                {renderItems(s.items)}
              </div>
            ))}
          </div>
        )
      })}

      {/* ── Every workspace, including the ones you can't open ─────────── */}
      <div className="px-1.5 pb-2">
        <Link
          href="/modules"
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-bold transition-colors"
          style={{ color: 'rgba(255,255,255,0.45)', background: 'rgba(255,255,255,0.03)' }}
          title="All workspaces"
        >
          <span aria-hidden>⊞</span>
          {!collapsed && <span>All workspaces</span>}
        </Link>
      </div>
    </nav>
  )
}

function SubHeader({ title }: { title: string }) {
  return (
    <p className="px-4 pt-1 pb-1 text-[9px] font-bold uppercase tracking-[0.18em]" style={{ color: 'rgba(255,255,255,0.22)' }}>
      {title}
    </p>
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

    // Storefront changes waiting for CEO approval (decision 41) — same
    // pattern, 60s poll. Shares its cache key with the hub's Approvals tab.
    const { data: pendingLayouts = [] } = useQuery<Array<{ id: string }>>({
      queryKey: PENDING_LAYOUTS_KEY,
      queryFn:  () => api.get('/site-layouts?status=pending'),
      enabled:  isSuper,
      refetchInterval: 60_000,
      staleTime: 30_000,
    })
    const hasQueue = pending.length > 0 || pendingLayouts.length > 0

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

        {/* CEO-only: live link to the pending queue on /workforce with a
            badge showing how many staff are waiting. Hidden when nothing is
            in the queue so the card stays quiet. */}
        {isSuper && pending.length > 0 && (
          <Link href="/workforce?status=pending"
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

        {isSuper && pendingLayouts.length > 0 && (
          <Link href="/storefront?tab=approvals"
            className={`${pending.length > 0 ? 'mt-0.5' : 'mt-1.5 pt-1.5 border-t border-white/[0.05]'} flex items-center gap-2 rounded-md px-1 py-1 -mx-1 transition-colors`}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(245,158,11,0.06)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
            <span className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: '#F59E0B' }} />
            <span className="text-[10px] font-bold flex-1" style={{ color: '#F59E0B' }}>
              {pendingLayouts.length} storefront {pendingLayouts.length === 1 ? 'change' : 'changes'} to approve
            </span>
            <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.4)' }}>→</span>
          </Link>
        )}

        {isSuper && (
          <div className={`${hasQueue ? 'mt-1' : 'mt-1.5'} pt-1.5 border-t border-white/[0.05] flex items-center gap-1.5`}>
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
