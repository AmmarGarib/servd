// Active shift store. POS won't accept payments until a shift is open.
// Persisted to AsyncStorage so reopening the app on the same tablet keeps
// the cashier on their shift — but the SERVER is the source of truth:
// syncShift() re-reads GET /pos/shifts/current on launch, on focus and after
// any SHIFT_CLOSED / SHIFT_NOT_IN_COMPANY error, so a drawer closed anywhere
// else (a manager in admin /reconciliation, the web till) never strands the
// tablet on a dead shift id.

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import AsyncStorage from '@react-native-async-storage/async-storage'

import { api } from '../lib/api'

interface ShiftState {
  shiftId: string | null
  openedAt: string | null
  openingFloatCents: number
  set: (s: { shiftId: string; openedAt: string; openingFloatCents: number } | null) => void
}

export const useShift = create<ShiftState>()(
  persist(
    (set) => ({
      shiftId: null,
      openedAt: null,
      openingFloatCents: 0,
      set: (s) => set(s ?? { shiftId: null, openedAt: null, openingFloatCents: 0 }),
    }),
    {
      name: 'servd_active_shift',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
)

interface CurrentShift { id: string; openedAt: string; openingFloatCents: number }

/** Adopt the caller's open drawer from the server (or clear it). */
export async function syncShift(): Promise<void> {
  try {
    const { shift } = await api.get<{ shift: CurrentShift | null }>('/pos/shifts/current')
    const current = useShift.getState()
    if (!shift) {
      if (current.shiftId) current.set(null)
      return
    }
    if (current.shiftId !== shift.id) {
      current.set({ shiftId: shift.id, openedAt: shift.openedAt, openingFloatCents: shift.openingFloatCents })
    }
  } catch {
    // Offline or signed out: keep what we have; the next sync corrects it.
  }
}
