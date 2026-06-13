'use client'
import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useAuthStore } from '../../store/auth'

const PUBLIC_PATHS = ['/', '/login', '/kds/login']

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const [hydrated, setHydrated] = useState(false)
  // Gate on `user` (persisted identity), NOT the token. The access token now
  // lives in an httpOnly cookie and is no longer in JS — so on reload `token`
  // is null even though the session is valid. `user` is what tells us we're
  // logged in; the cookie carries auth to the API.
  const user = useAuthStore((s) => s.user)
  const router = useRouter()
  const pathname = usePathname()

  // Wait for Zustand persist to rehydrate from localStorage before checking auth.
  // Without this, server renders null (no user) but client renders children
  // causing a React hydration mismatch and __next_error__.
  useEffect(() => {
    setHydrated(true)
  }, [])

  useEffect(() => {
    if (!hydrated) return
    if (!user && !PUBLIC_PATHS.includes(pathname)) {
      router.replace('/login')
    }
  }, [user, pathname, router, hydrated])

  // Always render children during SSR and initial hydration (matches server output).
  // After hydration, hide content if redirect is pending.
  if (hydrated && !user && !PUBLIC_PATHS.includes(pathname)) return null

  return <>{children}</>
}
