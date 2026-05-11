// Active shift store. POS won't accept payments until a shift is open.
// Persisted to AsyncStorage so reopening the app on the same tablet keeps
// the cashier on their shift.

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import AsyncStorage from '@react-native-async-storage/async-storage'

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
