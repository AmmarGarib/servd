'use client'

// The head-office lens (D3, spec §10). A head-office member can LOOK at a
// company they reach through a head office; they never switch into it
// (/tenants/switch is refused for a reached company). The chosen company id
// lives in localStorage 'servd_lens_tenant'; lib/api.ts sends it as
// x-servd-active-tenant on every request while it is set.

import { useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { LENS_KEY, readLensTenant } from '../lib/api'
import { useHeadOfficeMe, type ReachEntry } from './useWorkspaces'

const LENS_EVENT = 'servd:lens-changed'

/** Set (or clear, with null) the lens. Every storage access is guarded. */
export function writeLens(id: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (id) localStorage.setItem(LENS_KEY, id)
    else localStorage.removeItem(LENS_KEY)
  } catch { /* storage blocked: the lens simply stays off */ }
  window.dispatchEvent(new CustomEvent(LENS_EVENT))
}

export interface LensState {
  /** The lens company id, only when it is still reachable. */
  lensId: string | null
  /** Its reach entry (name, which head office(s)). */
  lens: ReachEntry | null
  setLens: (companyId: string) => void
  exitLens: () => void
}

export function useLens(): LensState {
  const qc = useQueryClient()
  const { reach, loaded } = useHeadOfficeMe()
  const [raw, setRaw] = useState<string | null>(null)

  useEffect(() => {
    const sync = () => setRaw(readLensTenant())
    sync()
    window.addEventListener(LENS_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(LENS_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  // At load: a lens that is no longer reachable (link ended, membership
  // changed) is dropped, and everything re-reads without it.
  useEffect(() => {
    if (!loaded || !raw) return
    if (!reach.some((r) => r.companyId === raw)) {
      writeLens(null)
      qc.invalidateQueries()
    }
  }, [loaded, raw, reach, qc])

  const lens = raw ? reach.find((r) => r.companyId === raw) ?? null : null
  const setLens = useCallback((companyId: string) => {
    try { localStorage.removeItem('servd_view_all_tenants') } catch { /* storage blocked */ }
    window.dispatchEvent(new CustomEvent('servd:view-all-changed', { detail: { on: false } }))
    writeLens(companyId)
    qc.invalidateQueries()
  }, [qc])
  const exitLens = useCallback(() => {
    writeLens(null)
    qc.invalidateQueries()
  }, [qc])

  return { lensId: lens ? raw : null, lens, setLens, exitLens }
}
