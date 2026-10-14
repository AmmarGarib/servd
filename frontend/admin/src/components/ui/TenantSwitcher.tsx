'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { api } from '../../lib/api'
import { useViewAsRole } from '../../store/viewAsRole'
import { BrandColumn, brandLabel, useBrandOptions, type PickerConcept } from './BrandPicker'

interface Tenant {
  id: string
  name: string
  slug: string
  industry: string | null
  role?: string
  isActive?: boolean
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

export function TenantSwitcher({ collapsed }: { collapsed: boolean }) {
  const qc = useQueryClient()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [viewAll, setViewAll] = useState(false)
  const popRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLDivElement | null>(null)
  // The brand filter lives in this switcher's second column (owner,
  // 2026-10-14). Always called here, so a brand from another company is
  // dropped even while the panel is closed.
  const brand = useBrandOptions()
  const showBrands = !!brand.concepts && brand.concepts.length > 0
  // When the CEO impersonates a non-admin role, portfolio view is incoherent
  // — that role wouldn't have multi-company access in production. Auto-clear
  // it on impersonation, and hide the "All companies" entry from the popover.
  const viewAsRole = useViewAsRole((s) => s.role)
  const isImpersonating = viewAsRole !== null

  // Hydrate after mount so SSR doesn't mismatch
  useEffect(() => { setViewAll(readViewAll()) }, [])

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
      writeViewAll(false)
      setViewAll(false)
      qc.invalidateQueries()
      setOpen(false)
      router.refresh()
    },
  })

  function activateViewAll() {
    writeViewAll(true)
    setViewAll(true)
    qc.invalidateQueries()
    setOpen(false)
    router.refresh()
  }

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      const t = e.target as Node
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const active = tenants.find((t) => t.isActive) ?? tenants[0]
  const displayLabel = viewAll ? 'All companies' : (active?.name ?? '—')
  const displayInitial = viewAll ? '∞' : (active?.name ?? '?')[0]?.toUpperCase()
  const accentTeal = viewAll

  if (tenants.length === 0) return null

  // Collapsed sidebar — just a small badge with the first letter
  if (collapsed) {
    return (
      <div ref={triggerRef} className="relative z-20 flex flex-col items-center gap-1 py-2"
        style={{ borderBottom: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
        <button onClick={() => setOpen((o) => !o)}
          title={showBrands ? `${displayLabel} · ${brandLabel(brand.current)}` : displayLabel}
          className="h-7 w-7 rounded-lg flex items-center justify-center text-[11px] font-black hover:text-white transition-colors"
          style={{
            background: accentTeal ? 'rgb(var(--erp-primary-rgb) / 0.15)' : 'rgb(var(--fg-rgb) / 0.05)',
            border: `1px solid ${accentTeal ? 'rgb(var(--erp-primary-rgb) / 0.4)' : 'rgb(var(--fg-rgb) / 0.08)'}`,
            color: accentTeal ? 'var(--erp-primary)' : 'rgb(var(--fg-rgb) / 0.85)',
          }}>
          {displayInitial}
        </button>
        {showBrands && brand.current && (
          <button onClick={() => setOpen((o) => !o)} title={`Brand: ${brandLabel(brand.current)}`}
            className="h-5 min-w-6 px-1 rounded-md text-[9px] font-black"
            style={{ background: 'rgb(var(--erp-primary-rgb) / 0.15)', color: 'var(--erp-primary)' }}>
            {brandLabel(brand.current).slice(0, 2)}
          </button>
        )}
        {open && active && (
          <SwitcherPopover ref={popRef} tenants={tenants}
            activeId={viewAll ? '__ALL__' : active.id}
            onSwitch={(id) => switchTo.mutate(id)}
            onActivateAll={activateViewAll}
            allowPortfolio={!isImpersonating}
            switching={switchTo.isPending ? switchTo.variables ?? null : null}
            onClose={() => setOpen(false)}
            brands={showBrands ? brand.concepts : null}
            brandId={brand.brandId}
            onPickBrand={(id) => { brand.pick(id); setOpen(false) }}
            triggerRef={triggerRef}
            anchor="left" />
        )}
      </div>
    )
  }

  // Expanded sidebar — full row with name + chevron
  return (
    <div ref={triggerRef} className="relative z-20"
      style={{ borderBottom: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-white/[0.03] transition-colors text-left">
        <div className="h-7 w-7 rounded-lg shrink-0 flex items-center justify-center text-[11px] font-black"
          style={{
            background: accentTeal ? 'rgb(var(--erp-primary-rgb) / 0.15)' : 'rgb(var(--fg-rgb) / 0.05)',
            border: `1px solid ${accentTeal ? 'rgb(var(--erp-primary-rgb) / 0.4)' : 'rgb(var(--fg-rgb) / 0.08)'}`,
            color: accentTeal ? 'var(--erp-primary)' : 'rgb(var(--fg-rgb) / 0.85)',
          }}>
          {displayInitial}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-wider text-white/35 leading-none">
            {viewAll ? 'Portfolio' : 'Company'}
          </p>
          <p className="text-xs font-bold truncate mt-0.5"
            style={{ color: viewAll ? 'var(--erp-primary)' : 'rgb(var(--fg-rgb) / 0.85)' }}>
            {displayLabel}
          </p>
          {showBrands && (
            <p className="text-[10px] font-bold truncate mt-0.5"
              style={{ color: brand.current ? 'var(--erp-primary)' : 'rgb(var(--fg-rgb) / 0.5)' }}>
              {brandLabel(brand.current)}
            </p>
          )}
          {brand.notHere && <p className="text-[10px] mt-0.5" style={{ color: 'var(--erp-warning)' }}>Brand not filtered on this page</p>}
        </div>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className={`text-white/40 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && active && (
        <SwitcherPopover ref={popRef} tenants={tenants}
          activeId={viewAll ? '__ALL__' : active.id}
          onSwitch={(id) => switchTo.mutate(id)}
          onActivateAll={activateViewAll}
          allowPortfolio={!isImpersonating}
          switching={switchTo.isPending ? switchTo.variables ?? null : null}
          onClose={() => setOpen(false)}
          brands={showBrands ? brand.concepts : null}
          brandId={brand.brandId}
          onPickBrand={(id) => { brand.pick(id); setOpen(false) }}
          triggerRef={triggerRef}
          anchor="below" />
      )}
    </div>
  )
}

const SwitcherPopover = ({ ref, tenants, activeId, onSwitch, onActivateAll, allowPortfolio, switching, onClose, brands, brandId, onPickBrand, triggerRef, anchor }: {
  ref: React.Ref<HTMLDivElement>
  tenants: Tenant[]
  activeId: string                // tenant id, or '__ALL__' when in portfolio view
  onSwitch: (id: string) => void
  onActivateAll: () => void
  allowPortfolio: boolean         // hide "All companies" when impersonating non-admin
  switching: string | null
  onClose: () => void
  /** The brands column; null hides it (no brands, or the read was refused). */
  brands: PickerConcept[] | null
  brandId: string | null
  onPickBrand: (id: string | null) => void
  triggerRef: React.RefObject<HTMLDivElement | null>
  anchor: 'below' | 'left'
}) => {
  // The sidebar clips its children (overflow-hidden, and the mobile drawer is
  // a transformed box), so the panel is portalled to <body> and placed from
  // the trigger's box: under it when the sidebar is open, beside it when
  // collapsed. Two columns need more room than the 220px sidebar.
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect()
      if (!r) return
      const vw = window.innerWidth
      const want = brands ? 480 : 260
      const width = Math.min(want, vw - 16)
      const left0 = anchor === 'below' ? r.left + 8 : r.right + 8
      const left = Math.max(8, Math.min(left0, vw - width - 8))
      setPos({ top: anchor === 'below' ? r.bottom + 4 : r.top + 6, left, width })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, brands, triggerRef])
  if (typeof document === 'undefined' || !pos) return null
  const allActive = activeId === '__ALL__'
  return createPortal(
    <div ref={ref}
      className="erp-on-surface fixed z-[100] rounded-xl overflow-hidden"
      style={{
        top: pos.top,
        left: pos.left,
        width: pos.width,
        // The panel sits inside the purple sidebar but is a light card:
        // .erp-on-surface resets the area colours so its text reads on white.
        color: 'var(--text)',
        background: 'var(--surface)',
        border: '1px solid rgb(var(--fg-rgb) / 0.1)',
        boxShadow: '0 16px 40px rgb(var(--ink-rgb) / 0.18)',
      }}>
      <div className={brands ? 'grid' : ''}
        style={brands ? { gridTemplateColumns: 'minmax(0, 1.45fr) minmax(0, 1fr)' } : undefined}>
      <div className="min-w-0">
      <div className="px-3 py-2 border-b border-white/[0.08]">
        <p className="text-[10px] uppercase tracking-wider font-bold text-white/40">Your companies</p>
      </div>
      <div className="max-h-[280px] overflow-y-auto">
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
              <p className="text-[10px] text-white/40 truncate mt-0.5">Portfolio view · {tenants.length} compan{tenants.length === 1 ? 'y' : 'ies'}</p>
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
                  {isActive && <span className="text-[9px] font-black uppercase tracking-wider text-primary-ink">Active</span>}
                </div>
                <p className="text-[10px] text-white/40 font-mono truncate mt-0.5">/{t.slug}</p>
              </div>
              {isSwitching && <span className="text-[10px] text-white/55">Switching…</span>}
            </button>
          )
        })}
      </div>
      </div>
      {brands && (
        <div className="min-w-0" style={{ borderLeft: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
          <BrandColumn concepts={brands} brandId={brandId} onPick={onPickBrand} />
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
