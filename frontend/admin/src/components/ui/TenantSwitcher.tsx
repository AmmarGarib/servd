'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { api } from '../../lib/api'
import { useViewAsRole } from '../../store/viewAsRole'

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
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false)
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
      <div className="relative z-20 flex justify-center py-2"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <button onClick={() => setOpen((o) => !o)}
          title={displayLabel}
          className="h-7 w-7 rounded-lg flex items-center justify-center text-[11px] font-black hover:text-white transition-colors"
          style={{
            background: accentTeal ? 'rgba(0,212,177,0.15)' : 'rgba(255,255,255,0.05)',
            border: `1px solid ${accentTeal ? 'rgba(0,212,177,0.4)' : 'rgba(255,255,255,0.08)'}`,
            color: accentTeal ? '#00D4B1' : 'rgba(255,255,255,0.85)',
          }}>
          {displayInitial}
        </button>
        {open && active && (
          <SwitcherPopover ref={popRef} tenants={tenants}
            activeId={viewAll ? '__ALL__' : active.id}
            onSwitch={(id) => switchTo.mutate(id)}
            onActivateAll={activateViewAll}
            allowPortfolio={!isImpersonating}
            switching={switchTo.isPending ? switchTo.variables ?? null : null}
            onClose={() => setOpen(false)}
            anchor="left" />
        )}
      </div>
    )
  }

  // Expanded sidebar — full row with name + chevron
  return (
    <div className="relative z-20"
      style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <button onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-white/[0.03] transition-colors text-left">
        <div className="h-7 w-7 rounded-lg shrink-0 flex items-center justify-center text-[11px] font-black"
          style={{
            background: accentTeal ? 'rgba(0,212,177,0.15)' : 'rgba(255,255,255,0.05)',
            border: `1px solid ${accentTeal ? 'rgba(0,212,177,0.4)' : 'rgba(255,255,255,0.08)'}`,
            color: accentTeal ? '#00D4B1' : 'rgba(255,255,255,0.85)',
          }}>
          {displayInitial}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-wider text-white/35 leading-none">
            {viewAll ? 'Portfolio' : 'Company'}
          </p>
          <p className="text-xs font-bold truncate mt-0.5"
            style={{ color: viewAll ? '#00D4B1' : 'rgba(255,255,255,0.85)' }}>
            {displayLabel}
          </p>
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
          anchor="below" />
      )}
    </div>
  )
}

const SwitcherPopover = ({ ref, tenants, activeId, onSwitch, onActivateAll, allowPortfolio, switching, onClose, anchor }: {
  ref: React.Ref<HTMLDivElement>
  tenants: Tenant[]
  activeId: string                // tenant id, or '__ALL__' when in portfolio view
  onSwitch: (id: string) => void
  onActivateAll: () => void
  allowPortfolio: boolean         // hide "All companies" when impersonating non-admin
  switching: string | null
  onClose: () => void
  anchor: 'below' | 'left'
}) => {
  const allActive = activeId === '__ALL__'
  return (
    <div ref={ref}
      className="absolute z-30 rounded-xl overflow-hidden"
      style={{
        top: anchor === 'below' ? 'calc(100% + 4px)' : '6px',
        left: anchor === 'below' ? '8px' : 'calc(100% + 8px)',
        right: anchor === 'below' ? '8px' : undefined,
        minWidth: anchor === 'left' ? '240px' : undefined,
        background: '#14161e',
        border: '1px solid rgba(255,255,255,0.1)',
        boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
      }}>
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
              allActive ? 'bg-[#00D4B1]/10' : 'hover:bg-white/[0.04]'
            } disabled:cursor-default border-b border-white/[0.05]`}>
            <div className="h-7 w-7 rounded-lg shrink-0 flex items-center justify-center text-[12px] font-black"
              style={{
                background: allActive ? 'rgba(0,212,177,0.18)' : 'rgba(255,255,255,0.05)',
                border: `1px solid ${allActive ? 'rgba(0,212,177,0.4)' : 'rgba(255,255,255,0.08)'}`,
                color: allActive ? '#00D4B1' : 'rgba(255,255,255,0.85)',
              }}>
              ∞
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-xs font-bold text-white/90 truncate">All companies</p>
                {allActive && <span className="text-[9px] font-black uppercase tracking-wider text-[#00D4B1]">Active</span>}
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
                isActive ? 'bg-[#00D4B1]/10' : 'hover:bg-white/[0.04]'
              } disabled:cursor-default`}>
              <div className="h-7 w-7 rounded-lg shrink-0 flex items-center justify-center text-[11px] font-black"
                style={{
                  background: isActive ? 'rgba(0,212,177,0.18)' : 'rgba(255,255,255,0.05)',
                  border: `1px solid ${isActive ? 'rgba(0,212,177,0.4)' : 'rgba(255,255,255,0.08)'}`,
                  color: isActive ? '#00D4B1' : 'rgba(255,255,255,0.85)',
                }}>
                {t.name[0]?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-bold text-white/90 truncate">{t.name}</p>
                  {isActive && <span className="text-[9px] font-black uppercase tracking-wider text-[#00D4B1]">Active</span>}
                </div>
                <p className="text-[10px] text-white/40 font-mono truncate mt-0.5">/{t.slug}</p>
              </div>
              {isSwitching && <span className="text-[10px] text-white/55">Switching…</span>}
            </button>
          )
        })}
      </div>
      <div className="border-t border-white/[0.08] p-1.5">
        <Link href="/onboarding" onClick={onClose}
          className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-bold text-white/70 hover:text-white hover:bg-white/[0.05] transition-colors">
          <span className="text-base leading-none">+</span>
          <span>Add new company</span>
        </Link>
      </div>
    </div>
  )
}
