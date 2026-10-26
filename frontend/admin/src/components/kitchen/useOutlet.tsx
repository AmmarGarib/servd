'use client'
// The outlet a kitchen screen is about (prep list, par board, shopping list): the active company's live outlets
// (GET /locations), the choice remembered on this device. The API resolves the outlet to its company (another
// company's is 404) — this is only the picker.
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { todayPktIso } from '../../lib/money'

export interface OutletLite { id: string; name: string; isActive?: boolean }
const KEY = 'servd_kitchen_outlet'

export function useOutlet() {
  const { data: outlets = [], isLoading } = useQuery<OutletLite[]>({
    queryKey: ['locations'], queryFn: () => api.get('/locations'), staleTime: 300_000, retry: false,
  })
  const live = outlets.filter((o) => o.isActive !== false)
  const [locationId, setLocationId] = useState('')
  useEffect(() => {
    if (locationId || live.length === 0) return
    let saved = ''
    try { saved = localStorage.getItem(KEY) ?? '' } catch { /* private window */ }
    setLocationId(live.some((o) => o.id === saved) ? saved : live[0]!.id)
  }, [live, locationId])
  const pick = (id: string) => {
    setLocationId(id)
    try { localStorage.setItem(KEY, id) } catch { /* private window */ }
  }
  return { outlets: live, locationId, setLocationId: pick, isLoading }
}

export function OutletPicker({ outlets, value, onChange }: { outlets: OutletLite[]; value: string; onChange: (id: string) => void }) {
  if (outlets.length <= 1) return outlets[0] ? <span className="text-sm text-s-muted">{outlets[0].name}</span> : null
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="s-input w-auto" aria-label="Outlet">
      {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  )
}

export const todayIso = () => todayPktIso()
