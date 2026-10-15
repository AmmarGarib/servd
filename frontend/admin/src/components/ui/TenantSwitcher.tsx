'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { api } from '../../lib/api'
import { useViewAsRole, type ViewAsRole } from '../../store/viewAsRole'
import { usePermissions } from '../../hooks/useCan'
import { useHeadOfficeMe, type ReachEntry } from '../../hooks/useWorkspaces'
import { useLens, writeLens } from '../../hooks/useLens'
import { APP_ROLES, roleLabel } from '../../lib/appRoles'
import { BrandColumn, brandLabel, useBrandOptions, type PickerConcept } from './BrandPicker'

interface Tenant {
  id: string
  name: string
  slug: string
  industry: string | null
  role?: string
  isActive?: boolean
  /** Test company (server field `isTest`). */
  isTest?: boolean
}

// Chip shown beside a test company's name.
export function TestChip() {
  return (
    <span className="shrink-0 rounded px-1 py-px text-[9px] font-black uppercase tracking-wider"
      style={{ color: 'var(--erp-warning)', background: 'color-mix(in srgb, var(--erp-warning) 14%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-warning) 45%, transparent)' }}>
      Test
    </span>
  )
}

// Virtual sentinel for the "All companies" portfolio view (no real tenant ID).
// Stored in localStorage when active; read by pages that support aggregation.
const VIEW_ALL_KEY = 'servd_view_all_tenants'
const VIEW_ALL_EVENT = 'servd:view-all-changed'
function readViewAll(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(VIEW_ALL_KEY) === '1'
}
function writeViewAll(on: boolean) {
  if (typeof window === 'undefined') return
  if (on) localStorage.setItem(VIEW_ALL_KEY, '1')
  else localStorage.removeItem(VIEW_ALL_KEY)
  window.dispatchEvent(new CustomEvent(VIEW_ALL_EVENT, { detail: { on } }))
}

// Hook for other components: returns whether portfolio view is active and
// stays in sync if the switcher is toggled elsewhere.
export function useViewAllTenants(): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    setOn(readViewAll())
    const handler = () => setOn(readViewAll())
    window.addEventListener(VIEW_ALL_EVENT, handler)
    window.addEventListener('storage', handler)
    return () => {
      window.removeEventListener(VIEW_ALL_EVENT, handler)
      window.removeEventListener('storage', handler)
    }
  }, [])
  return on
}

// Stash for portfolio-on state across impersonation. When the CEO flips
// view-as on while in portfolio view, we collapse portfolio (incoherent for
// non-admin roles) but remember that they had it on so we can restore when
// they exit impersonation. Lives in localStorage so a page refresh during
// impersonation doesn't lose the original intent.
const PORTFOLIO_STASH_KEY = 'servd_view_all_stash'

// The switcher module (owner, 2026-10-14): ONE place at the bottom-left to
// pick the company, the brand and — for the CEO only — the role to view as.
// Desktop: in the sidebar footer, where the CEO's "View as" used to be.
// Phone: a pill pinned to the bottom-left of the screen. The panel has a
// column per choice (Companies | Brands | View as) and opens upwards.
export type SwitcherPlacement = 'sidebar' | 'collapsed' | 'floating'

export function TenantSwitcher({ placement, hidden = false }: { placement: SwitcherPlacement; /** The phone pill hides while the drawer is open. */ hidden?: boolean }) {
  const qc = useQueryClient()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [viewAll, setViewAll] = useState(false)
  const popRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLDivElement | null>(null)
  // Always called here, so a brand from another company is dropped even
  // while the panel is closed.
  const brand = useBrandOptions()
  const showBrands = !!brand.concepts && brand.concepts.length > 0
  // Only the CEO (admin) can view as other roles — the real role from the
  // server, never the role being viewed as.
  const { data: me } = usePermissions()
  // Head-office lens: companies reached (not belonged to) through a head
  // office. Picking one sets the lens; it never calls /tenants/switch.
  const { reach } = useHeadOfficeMe()
  const { lensId, lens, setLens } = useLens()
  const isSuper = me?.role === 'admin'
  const setViewAsRole = useViewAsRole((s) => s.setRole)
  // When the CEO impersonates a non-admin role, portfolio view is incoherent
  // — that role wouldn't have multi-company access in production. Auto-clear
  // it on impersonation, and hide the "All companies" entry from the popover.
  const viewAsRole = useViewAsRole((s) => s.role)
  const isImpersonating = viewAsRole !== null

  // Hydrate after mount so SSR doesn't mismatch, and follow every change:
  // the sidebar, collapsed and phone switchers are mounted together, and only
  // one of them runs the view-as stash below, so each listens for the event.
  useEffect(() => {
    const sync = () => setViewAll(readViewAll())
    sync()
    window.addEventListener(VIEW_ALL_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(VIEW_ALL_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  // Auto-collapse portfolio when impersonation starts; restore when it ends.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (isImpersonating) {
      // Entering view-as — if portfolio was on, stash that fact and turn it off.
      if (readViewAll()) {
        localStorage.setItem(PORTFOLIO_STASH_KEY, '1')
        writeViewAll(false)
        setViewAll(false)
        qc.invalidateQueries()
      }
    } else {
      // Leaving view-as — restore portfolio if we had stashed it.
      if (localStorage.getItem(PORTFOLIO_STASH_KEY) === '1') {
        localStorage.removeItem(PORTFOLIO_STASH_KEY)
        writeViewAll(true)
        setViewAll(true)
        qc.invalidateQueries()
      }
    }
  }, [isImpersonating, qc])

  const { data: tenants = [] } = useQuery<Tenant[]>({
    queryKey: ['my-tenants'],
    queryFn: () => api.get<Tenant[]>('/tenants/mine'),
    staleTime: 30_000,
  })

  const switchTo = useMutation({
    mutationFn: (id: string) => api.post(`/tenants/switch/${id}`, {}),
    onSuccess: () => {
      writeLens(null)
      writeViewAll(false)
      setViewAll(false)
      qc.invalidateQueries()
      setOpen(false)
      router.refresh()
    },
  })

  function activateViewAll() {
    writeLens(null)
    writeViewAll(true)
    setViewAll(true)
    qc.invalidateQueries()
    setOpen(false)
    router.refresh()
  }

  useEffect(() => { if (hidden) setOpen(false) }, [hidden])

  // Close on outside click (the trigger toggles itself) and on Escape.
  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      const t = e.target as Node
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.querySelector('button')?.focus()
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const active = tenants.find((t) => t.isActive) ?? tenants[0]
  const activeIsTest = !viewAll && !lens && !!active?.isTest
  const companyLabel = lens ? lens.name : viewAll ? 'All companies' : (active?.name ?? '—')
  const initial = lens ? lens.name[0]?.toUpperCase() : viewAll ? '∞' : (active?.name ?? '?')[0]?.toUpperCase()
  const brandText = showBrands ? brandLabel(brand.current) : null
  const viewAsText = isSuper && viewAsRole ? roleLabel(viewAsRole) : null

  if (tenants.length === 0 && !isSuper && reach.length === 0) return null

  const panel = open && (
    <SwitcherPopover panelRef={popRef} tenants={tenants}
      activeId={lens ? '__LENS__' : viewAll ? '__ALL__' : (active?.id ?? '')}
      reach={reach}
      lensId={lensId}
      onPickLens={(id) => { setLens(id); setOpen(false); router.refresh() }}
      onSwitch={(id) => switchTo.mutate(id)}
      onActivateAll={activateViewAll}
      allowPortfolio={!isImpersonating}
      switching={switchTo.isPending ? switchTo.variables ?? null : null}
      onClose={() => setOpen(false)}
      brands={showBrands ? brand.concepts : null}
      brandId={brand.brandId}
      brandNotHere={brand.notHere}
      onPickBrand={(id) => { brand.pick(id); setOpen(false) }}
      viewAs={isSuper ? { role: viewAsRole, onPick: (r) => { setViewAsRole(r); setOpen(false) } } : null}
      triggerRef={triggerRef}
      placement={placement} />
  )

  const badge = (
    <span className="h-7 w-7 rounded-lg shrink-0 flex items-center justify-center text-[11px] font-black"
      style={{
        background: viewAll ? 'rgb(var(--erp-primary-rgb) / 0.15)' : 'rgb(var(--fg-rgb) / 0.05)',
        border: `1px solid ${viewAll ? 'rgb(var(--erp-primary-rgb) / 0.4)' : 'rgb(var(--fg-rgb) / 0.08)'}`,
        color: viewAll ? 'var(--erp-primary)' : 'rgb(var(--fg-rgb) / 0.85)',
      }}>
      {initial}
    </span>
  )
  const chevron = (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden className={`text-white/40 shrink-0 transition-transform ${open ? '' : 'rotate-180'}`}>
      <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
  const summary = [activeIsTest ? `${companyLabel} (test)` : companyLabel, brandText, viewAsText ? `as ${viewAsText}` : null].filter(Boolean).join(' · ')

  // Collapsed sidebar — the badge alone; the panel opens to the right.
  if (placement === 'collapsed') {
    return (
      <div ref={triggerRef} className="flex justify-center pb-1.5">
        <button onClick={() => setOpen((o) => !o)} title={summary} aria-label={`Switch company, brand${isSuper ? ' or role' : ''}: ${summary}`} aria-expanded={open}>
          {badge}
        </button>
        {panel}
      </div>
    )
  }

  // Phone — a pill pinned to the bottom-left of the screen.
  if (placement === 'floating') {
    if (hidden) return null
    return (
      <div ref={triggerRef} className="erp-on-secondary fixed left-3 z-[35] md:hidden rounded-full"
        style={{ bottom: 'calc(12px + env(safe-area-inset-bottom, 0px))', background: 'var(--erp-secondary)', boxShadow: '0 8px 24px rgb(var(--ink-rgb) / 0.3)' }}>
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`Switch company, brand${isSuper ? ' or role' : ''}: ${summary}`}
          className="flex items-center gap-2 pl-1.5 pr-3 py-1.5 max-w-[78vw] text-left">
          {badge}
          <span className="min-w-0 flex flex-col">
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="text-[11px] font-bold truncate" style={{ color: 'rgb(var(--fg-rgb) / 0.9)' }}>{companyLabel}</span>
              {activeIsTest && <TestChip />}
            </span>
            {(brandText || viewAsText) && (
              <span className="text-[10px] font-bold truncate" style={{ color: 'var(--erp-accent)' }}>
                {[brandText, viewAsText ? `as ${viewAsText}` : null].filter(Boolean).join(' · ')}
              </span>
            )}
            {brand.notHere && <span className="text-[10px] font-bold truncate" style={{ color: 'var(--erp-warning)' }}>Brand not filtered here</span>}
          </span>
          {chevron}
        </button>
        {panel}
      </div>
    )
  }

  // Sidebar footer — a full-width card; the panel opens upwards.
  return (
    <div ref={triggerRef} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="w-full flex items-center gap-2.5 rounded-xl px-2 py-2 transition-colors text-left hover:bg-white/[0.04]"
        style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
        {badge}
        <span className="flex-1 min-w-0">
          <span className="block text-[10px] font-bold uppercase tracking-wider text-white/35 leading-none">
            {lens ? 'Through head office' : viewAll ? 'Portfolio' : 'Company'}
          </span>
          <span className="flex items-center gap-1.5 mt-0.5 min-w-0">
            <span className="block text-xs font-bold truncate" style={{ color: viewAll ? 'var(--erp-primary)' : 'rgb(var(--fg-rgb) / 0.85)' }}>
              {companyLabel}
            </span>
            {activeIsTest && <TestChip />}
          </span>
          {brandText && (
            <span className="block text-[10px] font-bold truncate mt-0.5" style={{ color: brand.current ? 'var(--erp-accent)' : 'rgb(var(--fg-rgb) / 0.55)' }}>
              {brandText}
            </span>
          )}
          {isSuper && (
            <span className="block text-[10px] font-bold truncate mt-0.5" style={{ color: viewAsText ? 'var(--erp-accent)' : 'rgb(var(--fg-rgb) / 0.45)' }}>
              {viewAsText ? `Viewing as ${viewAsText}` : 'Viewing as myself'}
            </span>
          )}
          {brand.notHere && <span className="block text-[10px] mt-0.5" style={{ color: 'var(--erp-warning)' }}>Brand not filtered on this page</span>}
        </span>
        {chevron}
      </button>
      {panel}
    </div>
  )
}

const ROLE_TARGETS = APP_ROLES.filter((r) => r.value !== 'admin')

const SwitcherPopover = ({ panelRef, tenants, reach, lensId, onPickLens, activeId, onSwitch, onActivateAll, allowPortfolio, switching, onClose, brands, brandId, brandNotHere, onPickBrand, viewAs, triggerRef, placement }: {
  // Not `ref`: on React 18 a function component never receives `ref` as a
  // prop, which left the outside-click check blind to the panel.
  panelRef: React.MutableRefObject<HTMLDivElement | null>
  tenants: Tenant[]
  /** Companies reached through a head office (the lens); [] hides the group. */
  reach: ReachEntry[]
  lensId: string | null
  onPickLens: (companyId: string) => void
  activeId: string                // tenant id, or '__ALL__' when in portfolio view
  onSwitch: (id: string) => void
  onActivateAll: () => void
  allowPortfolio: boolean         // hide "All companies" when impersonating non-admin
  switching: string | null
  onClose: () => void
  /** The brands column; null hides it (no brands, or the read was refused). */
  brands: PickerConcept[] | null
  brandId: string | null
  brandNotHere: boolean
  onPickBrand: (id: string | null) => void
  /** The CEO's "View as" column; null for everyone else. */
  viewAs: { role: ViewAsRole; onPick: (role: ViewAsRole) => void } | null
  triggerRef: React.RefObject<HTMLDivElement | null>
  placement: SwitcherPlacement
}) => {
  // The sidebar clips its children (overflow-hidden; the phone drawer is a
  // transformed box), so the panel is portalled to <body> and placed from the
  // trigger's box: above it in the footer / on the phone pill, beside it when
  // the sidebar is collapsed. Columns stack when the screen is too narrow.
  const cols = 1 + (brands ? 1 : 0) + (viewAs ? 1 : 0)
  const [pos, setPos] = useState<{ bottom: number; left: number; width: number; maxHeight: number; stacked: boolean } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect()
      if (!r) return
      // The trigger was hidden (e.g. the window crossed the phone/desktop
      // width): close rather than place the panel off-screen.
      if (r.width === 0 && r.height === 0) { onClose(); return }
      const vw = window.innerWidth
      const vh = window.innerHeight
      const want = cols === 1 ? 280 : cols === 2 ? 500 : 700
      const width = Math.min(want, vw - 16)
      const stacked = width < cols * 165
      const left0 = placement === 'collapsed' ? r.right + 8 : r.left
      const left = Math.max(8, Math.min(left0, vw - width - 8))
      const bottom = placement === 'collapsed' ? Math.max(8, vh - r.bottom) : vh - r.top + 6
      setPos({ bottom, left, width, maxHeight: Math.max(200, vh - bottom - 12), stacked })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [cols, placement, triggerRef, onClose])

  // Keyboard: focus the selected entry (else the first) when the panel opens,
  // and give focus back to the trigger when it closes.
  useEffect(() => {
    if (!pos) return
    const box = panelRef.current
    const target = box?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ?? box?.querySelector<HTMLButtonElement>('button:not([disabled])')
    target?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!pos])
  useEffect(() => () => {
    const active = document.activeElement
    if (!active || active === document.body || panelRef.current?.contains(active)) triggerRef.current?.querySelector('button')?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (typeof document === 'undefined' || !pos) return null

  const allActive = activeId === '__ALL__'
  const colBorder = pos.stacked ? { borderTop: '1px solid rgb(var(--fg-rgb) / 0.08)' } : { borderLeft: '1px solid rgb(var(--fg-rgb) / 0.08)' }
  const listMax = pos.stacked ? undefined : 'max-h-[320px] overflow-y-auto'
  return createPortal(
    <div ref={panelRef} role="dialog" aria-label="Switch company, brand or role"
      className="erp-on-surface fixed z-[100] rounded-xl overflow-y-auto"
      style={{
        bottom: pos.bottom,
        left: pos.left,
        width: pos.width,
        maxHeight: pos.maxHeight,
        // The panel sits over the purple sidebar but is a light card:
        // .erp-on-surface resets the area colours so its text reads on white.
        color: 'var(--text)',
        background: 'var(--surface)',
        border: '1px solid rgb(var(--fg-rgb) / 0.1)',
        boxShadow: '0 16px 40px rgb(var(--ink-rgb) / 0.18)',
      }}>
      <div className={pos.stacked ? '' : 'grid'}
        style={pos.stacked ? undefined : { gridTemplateColumns: cols === 3 ? 'minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1.1fr)' : cols === 2 ? 'minmax(0, 1.45fr) minmax(0, 1fr)' : 'minmax(0, 1fr)' }}>
      <div className="min-w-0">
      <div className="px-3 py-2 border-b border-white/[0.08]">
        <p className="text-[10px] uppercase tracking-wider font-bold text-white/40">Your companies</p>
      </div>
      <div className={listMax}>
        {/* Virtual "All companies" entry — only shown when portfolio access is
            allowed. While impersonating a non-admin role, the view-as target
            wouldn't have portfolio in production, so the option is hidden. */}
        {allowPortfolio && (
          <button onClick={() => { if (!allActive) onActivateAll() }}
            disabled={allActive || !!switching}
            className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
              allActive ? 'bg-primary/10' : 'hover:bg-white/[0.04]'
            } disabled:cursor-default border-b border-white/[0.05]`}>
            <div className="h-7 w-7 rounded-lg shrink-0 flex items-center justify-center text-[12px] font-black"
              style={{
                background: allActive ? 'rgb(var(--erp-primary-rgb) / 0.18)' : 'rgb(var(--fg-rgb) / 0.05)',
                border: `1px solid ${allActive ? 'rgb(var(--erp-primary-rgb) / 0.4)' : 'rgb(var(--fg-rgb) / 0.08)'}`,
                color: allActive ? 'var(--erp-primary-ink)' : 'rgb(var(--fg-rgb) / 0.85)',
              }}>
              ∞
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-xs font-bold text-white/90 truncate">All companies</p>
                {allActive && <span className="text-[9px] font-black uppercase tracking-wider text-primary-ink">Active</span>}
              </div>
              <p className="text-[10px] text-white/40 truncate mt-0.5">Portfolio view · {tenants.filter((t) => !t.isTest).length} compan{tenants.filter((t) => !t.isTest).length === 1 ? 'y' : 'ies'}{tenants.some((t) => t.isTest) ? ' · test left out' : ''}</p>
            </div>
          </button>
        )}

        {tenants.map((t) => {
          const isActive = !allActive && t.id === activeId
          const isSwitching = switching === t.id
          return (
            <button key={t.id}
              onClick={() => { if (!isActive) onSwitch(t.id) }}
              disabled={isActive || !!switching}
              className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                isActive ? 'bg-primary/10' : 'hover:bg-white/[0.04]'
              } disabled:cursor-default`}>
              <div className="h-7 w-7 rounded-lg shrink-0 flex items-center justify-center text-[11px] font-black"
                style={{
                  background: isActive ? 'rgb(var(--erp-primary-rgb) / 0.18)' : 'rgb(var(--fg-rgb) / 0.05)',
                  border: `1px solid ${isActive ? 'rgb(var(--erp-primary-rgb) / 0.4)' : 'rgb(var(--fg-rgb) / 0.08)'}`,
                  color: isActive ? 'var(--erp-primary-ink)' : 'rgb(var(--fg-rgb) / 0.85)',
                }}>
                {t.name[0]?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-bold text-white/90 truncate">{t.name}</p>
                  {t.isTest && <TestChip />}
                  {isActive && <span className="text-[9px] font-black uppercase tracking-wider text-primary-ink">Active</span>}
                </div>
                <p className="text-[10px] text-white/40 font-mono truncate mt-0.5">/{t.slug}</p>
              </div>
              {isSwitching && <span className="text-[10px] text-white/55">Switching…</span>}
            </button>
          )
        })}
        {reach.length > 0 && (
          <div className="border-t border-white/[0.08]">
            {Array.from(new Set(reach.flatMap((c) => c.via.map((v) => v.name || 'Head office')))).map((hoName) => (
              <div key={hoName}>
                <p className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider font-bold text-white/40">Through {hoName}</p>
                {reach.filter((c) => c.via.some((v) => (v.name || 'Head office') === hoName)).map((c) => {
                  const isLens = c.companyId === lensId
                  return (
                    <button key={c.companyId} onClick={() => { if (!isLens) onPickLens(c.companyId) }}
                      disabled={isLens || !!switching} aria-pressed={isLens}
                      className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${isLens ? 'bg-primary/10' : 'hover:bg-white/[0.04]'} disabled:cursor-default`}>
                      <div className="h-7 w-7 rounded-lg shrink-0 flex items-center justify-center text-[11px] font-black"
                        style={{
                          background: isLens ? 'rgb(var(--erp-primary-rgb) / 0.18)' : 'rgb(var(--fg-rgb) / 0.05)',
                          border: `1px solid ${isLens ? 'rgb(var(--erp-primary-rgb) / 0.4)' : 'rgb(var(--fg-rgb) / 0.08)'}`,
                          color: isLens ? 'var(--erp-primary-ink)' : 'rgb(var(--fg-rgb) / 0.85)',
                        }}>
                        {c.name[0]?.toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-bold text-white/90 truncate">{c.name}</p>
                          {isLens && <span className="text-[9px] font-black uppercase tracking-wider text-primary-ink">Viewing</span>}
                        </div>
                        <p className="text-[10px] text-white/40 truncate mt-0.5">Look and send for approval</p>
                      </div>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>
      </div>
      {brands && (
        <div className="min-w-0" style={colBorder}>
          <BrandColumn concepts={brands} brandId={brandId} onPick={onPickBrand} scroll={!pos.stacked} notHere={brandNotHere} />
        </div>
      )}
      {viewAs && (
        <div className="min-w-0" style={colBorder}>
          <div className="px-3 py-2 border-b border-white/[0.08]">
            <p className="text-[10px] uppercase tracking-wider font-bold text-white/40">View as</p>
          </div>
          <div className={listMax}>
            {[{ value: null as ViewAsRole, label: 'Myself (CEO)' }, ...ROLE_TARGETS.map((r) => ({ value: r.value as ViewAsRole, label: r.label }))].map((r) => {
              const selected = r.value === viewAs.role
              return (
                <button key={r.value ?? 'me'} onClick={() => viewAs.onPick(r.value)} aria-pressed={selected}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
                    selected ? 'bg-primary/10' : 'hover:bg-white/[0.04]'
                  } ${r.value ? '' : 'border-b border-white/[0.05]'}`}>
                  <span className="flex-1 min-w-0 text-xs font-bold truncate"
                    style={{ color: selected ? 'var(--erp-primary-ink)' : 'rgb(var(--fg-rgb) / 0.85)' }}>
                    {r.label}
                  </span>
                  {selected && (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0" style={{ color: 'var(--erp-success)' }}>
                      <path d="M2.5 6.2l2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
      </div>
      <div className="border-t border-white/[0.08] p-1.5">
        <Link href="/onboarding" onClick={onClose}
          className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-bold text-white/70 hover:text-white hover:bg-white/[0.05] transition-colors">
          <span className="text-base leading-none">+</span>
          <span>Add new company</span>
        </Link>
      </div>
    </div>,
    document.body,
  )
}
