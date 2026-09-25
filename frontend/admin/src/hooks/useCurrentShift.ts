'use client'
// The server says which drawer this user is on (GET /pos/shifts/current).
//
// The web till used to keep its shift id only in this browser, so a drawer
// opened or closed anywhere else — the tablet, a manager closing it from
// /reconciliation — left it paying into a closed shift (422) or refusing to
// open a second one (SHIFT_OPEN). Every till page syncs from here instead.

import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { posApi } from '../lib/api'
import { usePosStore } from '../store/pos'

export function useCurrentShift() {
  const setShiftId = usePosStore((s) => s.setShiftId)
  const current = useQuery({
    queryKey: ['pos', 'current-shift'],
    queryFn: () => posApi.currentShift(),
    refetchOnWindowFocus: true,
  })
  useEffect(() => {
    if (current.data) setShiftId(current.data.shift?.id ?? null)
  }, [current.data, setShiftId])
  return current
}
