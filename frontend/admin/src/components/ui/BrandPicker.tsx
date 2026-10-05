'use client'
// Global brand filter picker — sits under the company switcher.
//
// "All brands" by default. Picking one narrows every page that can be narrowed,
// and the picker says so when a page cannot ("not filtered here"), so a brand
// name never sits in the sidebar over figures for every brand.

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useBrandFilter } from '../../store/brandFilter'

interface Concept { id: string; name: string }

export function BrandPicker({ collapsed }: { collapsed: boolean }) {
  const qc = useQueryClient()
  const pathname = usePathname() ?? ''
  const { brandId, setBrand, seen, applied } = useBrandFilter()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  // Company-scoped: switching company changes this list, which is what clears
  // a brand that belongs to the previous company (below).
  const { data: concepts } = useQuery({
    queryKey: ['concepts'],
    queryFn: () => api.get<Concept[]>('/concepts'),
    staleTime: 60_000,
  })

  const pick = (id: string | null) => {
    setBrand(id)
    setOpen(false)
    // Every cached read was fetched under the old filter.
    void qc.invalidateQueries()
  }

  // A brand from another company (or a deleted one) is dropped rather than
  // quietly filtering everything to nothing.
  useEffect(() => {
    if (brandId && concepts && !concepts.some((c) => c.id === brandId)) pick(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId, concepts])

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const current = concepts?.find((c) => c.id === brandId) ?? null
  const notHere = !!brandId && !!seen[pathname] && !applied[pathname]
  if (!concepts || concepts.length < 2) return null   // nothing to choose between

  if (collapsed) {
    return (
      <div className="flex justify-center py-1.5" ref={ref} style={{ borderBottom: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
        <button onClick={() => pick(null)} title={current ? `Brand: ${current.name} — click to show all` : 'All brands'}
          className="h-6 min-w-6 px-1.5 rounded-md text-[10px] font-black"
          style={{ background: current ? 'rgb(135 197 64 / 0.15)' : 'rgb(var(--fg-rgb) / 0.04)', color: current ? 'var(--erp-primary)' : 'rgb(var(--fg-rgb) / 0.45)' }}>
          {current ? current.name.slice(0, 2) : 'All'}
        </button>
      </div>
    )
  }

  return (
    <div className="relative z-10" ref={ref} style={{ borderBottom: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
      <button onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.03] transition-colors text-left">
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-wider text-white/35 leading-none">Brand</p>
          <p className="text-xs font-bold truncate mt-0.5" style={{ color: current ? 'var(--erp-primary)' : 'rgb(var(--fg-rgb) / 0.7)' }}>
            {current ? current.name : 'All brands'}
          </p>
          {notHere && <p className="text-[10px] mt-0.5" style={{ color: '#a15c00' }}>Not filtered on this page</p>}
        </div>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className={`text-white/40 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-30 left-2 right-2 rounded-xl overflow-hidden"
          style={{ ['--fg-rgb' as string]: '61 31 59', color: 'var(--text)', top: 'calc(100% + 4px)', background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.1)', boxShadow: '0 16px 40px rgb(61 31 59 / 0.18)' }}>
          {[{ id: null as string | null, name: 'All brands' }, ...concepts].map((c) => (
            <button key={c.id ?? 'all'} onClick={() => pick(c.id)}
              className="w-full text-left px-3 py-2 text-xs font-bold hover:bg-white/[0.05]"
              style={{ color: c.id === brandId ? 'var(--erp-primary-ink)' : 'rgb(var(--fg-rgb) / 0.8)' }}>
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
