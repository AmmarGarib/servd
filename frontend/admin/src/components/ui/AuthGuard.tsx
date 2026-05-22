'use client'
import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useAuthStore } from '../../store/auth'

const PUBLIC_PATHS = ['/', '/login', '/kds/login']

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const [hydrated, setHydrated] = useState(false)
  const token = useAuthStore((s) => s.token)
  const router = useRouter()
  const pathname = usePathname()

  // Wait for Zustand persist to rehydrate from localStorage before checking auth.
  // Without this, server renders null (no token) but client renders children (has token)
  // causing a React hydration mismatch and __next_error__.
  useEffect(() => {
    setHydrated(true)
  }, [])

  useEffect(() => {
    if (!hydrated) return
    if (!token && !PUBLIC_PATHS.includes(pathname)) {
      router.replace('/login')
    }
  }, [token, pathname, router, hydrated])

  // Always render children during SSR and initial hydration (matches server output).
  // After hydration, hide content if redirect is pending.
  if (hydrated && !token && !PUBLIC_PATHS.includes(pathname)) return null

  return <>{children}</>
}
