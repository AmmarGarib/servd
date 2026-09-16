'use client'
import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useAuthStore } from '../../store/auth'

// Exact paths anyone may load without a session.
//
// `/reset-password` is public because it HAS to be: it is where the emailed
// reset link lands, and the entire situation it exists for is "this person
// cannot obtain a session". The credential is the one-shot token in the query
// string, which the API checks; the page itself renders nothing sensitive and
// reads no account data before that token is verified.
const PUBLIC_PATHS = ['/', '/login', '/kds/login', '/reset-password']

// Public route SUBTREES. Empty on purpose.
//
// `/supplier/<token>` — the external supplier portal — was the one candidate.
// It authenticates on a token in the URL rather than a staff session, so
// gating it locks suppliers out. Per the product owner that is accepted: the
// portal stays behind the staff gate rather than carrying an exception that
// has to stay correct forever. Anything added here is a page served to the
// open internet, so it needs the same scrutiny as an unauthenticated API
// route — name the reason, or leave it out.
const PUBLIC_PREFIXES: string[] = []

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.includes(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))
}

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
    if (!user && !isPublicPath(pathname)) {
      router.replace('/login')
    }
  }, [user, pathname, router, hydrated])

  // A protected route renders NOTHING until the client has rehydrated and found
  // a user. It used to render children during SSR and first paint "to match
  // server output", which meant `curl https://servd-admin…/modules` returned
  // the whole module hub — every module name, the finance and payroll and
  // ledger nav — to anyone, with no session at all. No business data leaked
  // (the API 401s every request without a token) but the app's shape did, and
  // with JS disabled the page simply stayed up.
  //
  // There is no server-side gate available here on purpose: the session cookie
  // is host-only to the API (see backend/src/lib/cookies.ts), so Next
  // middleware on the admin host cannot see it. Rendering nothing until the
  // client proves a session is the correct gate for this architecture.
  //
  // No hydration mismatch: the server and the first client pass both render
  // null for a protected path. Children appear only on a later pass.
  const isPublic = isPublicPath(pathname)
  if (!isPublic && (!hydrated || !user)) return null

  return <>{children}</>
}
