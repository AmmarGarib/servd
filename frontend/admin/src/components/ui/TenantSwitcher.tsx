'use client'
// The company helpers the scope bar (components/ui/ScopeBar.tsx) and pages share. The old switcher module that
// lived here (the ∞ button + panel, owner 2026-10-14) was REPLACED by the scope bar on 2026-11-06.
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '../../lib/api'
import { writeLens } from '../../hooks/useLens'

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
export function writeViewAll(on: boolean) {
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

/**
 * Switch the active company (POST /tenants/switch/:id). One hook for the
 * switcher and the notification bell. Clears the lens and the portfolio view,
 * re-reads everything, then calls `after`.
 */
export function useSwitchCompany(after?: () => void) {
  const qc = useQueryClient()
  const router = useRouter()
  return useMutation({
    mutationFn: (id: string) => api.post(`/tenants/switch/${id}`, {}),
    onSuccess: () => {
      writeLens(null)
      writeViewAll(false)
      qc.invalidateQueries()
      after?.()
      router.refresh()
    },
  })
}
