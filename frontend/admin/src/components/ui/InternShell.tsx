'use client'
// Marketing intern / designer logins (owner, 2026-11-03): the whole admin for an intern is their board cards
// (/marketing/board — the API shows them only the cards they work on), their own progress, My HR, the time clock,
// the bell and their password. Like DirectorShell, this replaces the full ERP shell so none of its background reads
// (companies, approvals, team) fire for a login the API refuses them to. Any other path goes to /marketing/board.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { Bell } from 'lucide-react'
import { api } from '../../lib/api'
import { useAuthStore } from '../../store/auth'
import { canOpenPath } from '../../lib/moduleCatalog'
import { relativeTime, useInbox, useMarkRead, useUnreadCount } from '../../lib/notificationsData'
import { AnchoredMenu } from './AnchoredMenu'
import { CompactEmptyState } from './CompactEmptyState'

const LINKS = [
  { href: '/marketing/board', label: 'My cards' },
  { href: '/me/tasks', label: 'My tasks' },
  { href: '/marketing/progress', label: 'My progress' },
  { href: '/hr/me', label: 'My HR' },
  { href: '/time-clock', label: 'Clock' },
]

function InternBell() {
  const btn = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const { data: unread = 0 } = useUnreadCount()
  const inbox = useInbox({ limit: 20, enabled: open })
  const markRead = useMarkRead()
  const items = inbox.data?.pages.flatMap((p) => p.items) ?? []
  return (
    <>
      <button ref={btn} type="button" onClick={() => setOpen((o) => !o)} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        className="relative flex h-10 w-10 items-center justify-center rounded-lg"
        style={{ border: '1px solid rgb(var(--fg-rgb) / 0.2)', color: 'rgb(var(--fg-rgb) / 0.85)' }}>
        <Bell size={18} aria-hidden="true" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 min-w-[18px] rounded-full px-1 text-center text-[10px] font-bold"
            style={{ background: 'var(--erp-accent)', color: 'var(--erp-secondary)' }}>{unread > 99 ? '99+' : unread}</span>
        )}
      </button>
      <AnchoredMenu anchor={btn} open={open} onClose={() => setOpen(false)} align="end" minWidth={300} maxHeight={420}>
        <div className="erp-on-surface p-2" style={{ background: 'var(--surface)' }}>
          {items.length === 0 && <CompactEmptyState message={inbox.isLoading ? 'Loading…' : 'Nothing new.'} />}
          {items.map((n) => (
            <button key={n.id} type="button" role="menuitem"
              onClick={() => { if (!n.readAt) markRead.mutate(n.id); setOpen(false); if (n.link?.startsWith('/') && !n.link.startsWith('//')) router.push(n.link) }}
              className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-s-elevated">
              <span className="flex items-center gap-2">
                {!n.readAt && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--erp-accent)' }} aria-label="unread" />}
                <span className="font-semibold">{n.title}</span>
              </span>
              {n.body && <span className="mt-0.5 block truncate text-xs text-s-muted">{n.body}</span>}
              <span className="mt-0.5 block text-[11px] text-s-muted">{relativeTime(n.createdAt)}</span>
            </button>
          ))}
        </div>
      </AnchoredMenu>
    </>
  )
}

export function InternShell({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const router = useRouter()
  const qc = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const clearAuth = useAuthStore((s) => s.clearAuth)
  const [signingOut, setSigningOut] = useState(false)
  const allowed = canOpenPath(pathname, 'marketing_intern', [])

  useEffect(() => {
    if (!allowed) router.replace('/marketing/board')
  }, [allowed, router])

  async function signOut() {
    if (signingOut) return
    setSigningOut(true)
    try { await api.post('/auth/logout', {}) } catch { /* sign out locally anyway */ }
    qc.clear()
    clearAuth()
    router.replace('/login')
  }

  const pill = { border: '1px solid rgb(var(--fg-rgb) / 0.2)', color: 'rgb(var(--fg-rgb) / 0.85)' }
  return (
    <div className="min-h-screen min-h-dvh flex flex-col" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <header className="erp-on-secondary shrink-0" style={{ background: 'var(--erp-secondary)' }}>
        <div className="flex items-center gap-3 px-4 h-[54px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/servd-logo.png" alt="servd" width={30} height={30} className="shrink-0 block" style={{ width: 30, height: 30 }} />
          <span className="text-sm font-bold truncate" style={{ color: 'rgb(var(--fg-rgb) / 0.9)' }}>Marketing</span>
          <span className="flex-1" />
          <span className="hidden sm:inline text-xs truncate max-w-[12rem]" style={{ color: 'rgb(var(--fg-rgb) / 0.6)' }}>{user?.name ?? ''}</span>
          <InternBell />
          <Link href="/account/password" className="hidden sm:inline rounded-lg px-2.5 py-1.5 text-xs font-semibold" style={pill}>Password</Link>
          <button type="button" onClick={() => void signOut()} disabled={signingOut} className="rounded-lg px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50" style={pill}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-2" aria-label="Your pages">
          {LINKS.map((l) => {
            const active = pathname === l.href || pathname.startsWith(l.href + '/')
            return (
              <Link key={l.href} href={l.href}
                className="shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold"
                style={active ? { background: 'var(--erp-accent)', color: 'var(--erp-secondary)' } : { color: 'rgb(var(--fg-rgb) / 0.8)' }}>
                {l.label}
              </Link>
            )
          })}
        </nav>
      </header>
      <main id="main" className="flex-1 min-h-0 overflow-y-auto">
        {allowed ? children : null}
      </main>
    </div>
  )
}
