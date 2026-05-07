'use client'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface CustomerAuthState {
  token: string | null
  customerId: string | null
  setAuth: (token: string, customerId: string) => void
  clearAuth: () => void
}

export const useCustomerAuth = create<CustomerAuthState>()(
  persist(
    (set) => ({
      token: null,
      customerId: null,
      setAuth: (token, customerId) => set({ token, customerId }),
      clearAuth: () => set({ token: null, customerId: null }),
    }),
    { name: 'servd-customer-auth' },
  ),
)
