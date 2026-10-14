'use client'
// Global brand filter — the Brands column of the switcher module at the
// bottom-left (owner, 2026-10-14; it replaced the separate "Brand" row under
// the old top switcher, so there is still ONE brand picker).
//
// "All brands" by default. Picking one narrows every page that can be narrowed,
// and the switcher says so when a page cannot ("not filtered here"), so a brand
// name never sits in the sidebar over figures for every brand.

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import { useBrandFilter } from '../../store/brandFilter'
import { formatBrandName } from '../../lib/brandName'

export interface PickerConcept { id: string; name: string }

/**
 * The brand filter's state for the shell. Call it from a component that is
 * always mounted (the company switcher), because it also drops a brand that
 * no longer belongs to the companies in view.
 */
export function useBrandOptions() {
  const qc = useQueryClient()
  const pathname = usePathname() ?? ''
  const { brandId, setBrand, seen, applied } = useBrandFilter()

  // Company-scoped: switching company changes this list, which is what clears
  // a brand that belongs to the previous company (below).
  // GET /concepts?view=picker: every staff role reads the active brands of its
  // own companies (id + name only), so the till, KDS, finance and HR logins
  // get the picker too (UI-13 — the plain list is managers / till only, and
  // its 403 put a red "Role X is not allowed" toast on every page).
  // Still a shell widget the user didn't ask for: if the read fails with a 403
  // the column just hides — no toast, no retry (the `background` opt-out in
  // components/ui/Providers.tsx).
  // Its own cache key: a page's ['concepts'] query (full rows, no opt-out)
  // must not be overwritten by — or overwrite — this narrow list.
  const { data: concepts } = useQuery({
    queryKey: ['concepts', 'brand-picker'],
    queryFn: () => api.get<PickerConcept[]>('/concepts?view=picker'),
    staleTime: 60_000,
    meta: { background: true },
    retry: (count, err) => !(err instanceof ApiError && err.status === 403) && count < 1,
  })

  const pick = (id: string | null) => {
    if (id === brandId) return
    setBrand(id)
    // Every cached read was fetched under the old filter.
    void qc.invalidateQueries()
  }

  // A brand from another company (or a deleted one) is dropped rather than
  // quietly filtering everything to nothing.
  useEffect(() => {
    if (brandId && concepts && !concepts.some((c) => c.id === brandId)) pick(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId, concepts])

  const current = concepts?.find((c) => c.id === brandId) ?? null
  const notHere = !!brandId && !!seen[pathname] && !applied[pathname]
  return { concepts: concepts ?? null, brandId, current, notHere, pick }
}

/** "Simmer" / "All brands" for the switcher's closed state. */
export function brandLabel(current: PickerConcept | null): string {
  return current ? formatBrandName(current.name) : 'All brands'
}

/** The brands column inside the company switcher's panel. */
export function BrandColumn({ concepts, brandId, onPick, scroll = true, notHere = false }: {
  concepts: PickerConcept[]
  brandId: string | null
  onPick: (id: string | null) => void
  /** Own scroll box (side-by-side columns); off when the columns stack. */
  scroll?: boolean
  /** The chosen brand does not narrow this page. */
  notHere?: boolean
}) {
  const rows = [{ id: null as string | null, name: 'All brands' }, ...concepts]
  return (
    <div className="min-w-0 flex flex-col">
      <div className="px-3 py-2 border-b border-white/[0.08]">
        <p className="text-[10px] uppercase tracking-wider font-bold text-white/40">Brands</p>
        {notHere && <p className="text-[10px] mt-0.5" style={{ color: 'var(--erp-warning)' }}>Not filtered on this page</p>}
      </div>
      <div className={scroll ? 'max-h-[320px] overflow-y-auto' : undefined}>
        {rows.map((c) => {
          const selected = c.id === brandId
          return (
            <button key={c.id ?? 'all'} onClick={() => onPick(c.id)}
              aria-pressed={selected}
              className={`w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors ${
                selected ? 'bg-primary/10' : 'hover:bg-white/[0.04]'
              } ${c.id ? '' : 'border-b border-white/[0.05]'}`}>
              <span className="flex-1 min-w-0 text-xs font-bold truncate"
                style={{ color: selected ? 'var(--erp-primary-ink)' : 'rgb(var(--fg-rgb) / 0.85)' }}>
                {c.id ? formatBrandName(c.name) : c.name}
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
  )
}
