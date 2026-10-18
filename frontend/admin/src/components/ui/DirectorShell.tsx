'use client'
// Director logins (owner, 2026-10-18): the whole admin for a director is the
// Director page (/director) and their own password page. This shell replaces
// the full ERP shell for them — no sidebar, bell, company switcher, approvals
// or time clock (the API refuses all of those for the role anyway), so none
// of their background reads ever fire. Any other path goes to /director.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAuthStore } from '../../store/auth'
import { canOpenPath } from '../../lib/moduleCatalog'

export function DirectorShell({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const router = useRouter()
  const qc = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const clearAuth = useAuthStore((s) => s.clearAuth)
  const [signingOut, setSigningOut] = useState(false)
  const allowed = canOpenPath(pathname, 'director', [])

  useEffect(() => {
    if (!allowed) router.replace('/director')
  }, [allowed, router])

  async function signOut() {
    if (signingOut) return
    setSigningOut(true)
    try { await api.post('/auth/logout', {}) } catch { /* sign out locally anyway */ }
    qc.clear()
    clearAuth()
    router.replace('/login')
  }

  return (
    <div className="min-h-screen min-h-dvh flex flex-col" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <header className="erp-on-secondary shrink-0 flex items-center gap-3 px-4 h-[54px]"
        style={{ background: 'var(--erp-secondary)' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/servd-logo.png" alt="servd" width={30} height={30} className="shrink-0 block" style={{ width: 30, height: 30 }} />
        <Link href="/director" className="text-sm font-bold truncate" style={{ color: 'rgb(var(--fg-rgb) / 0.9)' }}>
          Brand performance
        </Link>
        <span className="flex-1" />
        <span className="hidden sm:inline text-xs truncate max-w-[12rem]" style={{ color: 'rgb(var(--fg-rgb) / 0.6)' }}>
          {user?.name ?? 'Director'}
        </span>
        <Link href="/account/password" className="rounded-lg px-2.5 py-1.5 text-xs font-semibold"
          style={{ border: '1px solid rgb(var(--fg-rgb) / 0.2)', color: 'rgb(var(--fg-rgb) / 0.85)' }}>
          Password
        </Link>
        <button type="button" onClick={() => void signOut()} disabled={signingOut}
          className="rounded-lg px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50"
          style={{ border: '1px solid rgb(var(--fg-rgb) / 0.2)', color: 'rgb(var(--fg-rgb) / 0.85)' }}>
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </header>
      <main id="main" className="flex-1 min-h-0 overflow-y-auto">
        {allowed ? children : null}
      </main>
    </div>
  )
}
