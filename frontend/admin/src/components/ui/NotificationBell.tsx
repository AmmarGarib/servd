'use client'
// The notification bell (owner, 2026-10-16): one bell with an unread count for
// every login. It tells the right person and links to where they act; it does
// not replace the approvals inbox (/ceo/approvals) or Exceptions (/exceptions).
// The pinned top row reads the SAME counts query as the sidebar badge.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useApprovalCounts } from '../../app/ceo/approvalsData'
import { usePermissions } from '../../hooks/useCan'
import { useHeadOfficeMe } from '../../hooks/useWorkspaces'
import { useLens } from '../../hooks/useLens'
import { useAuthStore } from '../../store/auth'
import { useSwitchCompany } from './TenantSwitcher'
import {
  relativeTime, severityColor, useInbox, useMarkAllRead, useMarkRead, useNotificationSocket, useUnreadCount,
  type NotificationItem,
} from '../../lib/notificationsData'
import { CompactEmptyState } from './CompactEmptyState'

interface MyTenant { id: string; isActive?: boolean }

/** Open a notification: mark read, switch company only when its page needs it, go to the link. */
export function useOpenNotification(after?: () => void) {
  const router = useRouter()
  const markRead = useMarkRead()
  const { reach } = useHeadOfficeMe()
  const { setLens } = useLens()
  // Never ask without a session: a 401 here sends the visitor to /login.
  const signedIn = Boolean(useAuthStore((s) => s.user))
  const { data: tenants = [] } = useQuery<MyTenant[]>({
    queryKey: ['my-tenants'],
    queryFn: () => api.get<MyTenant[]>('/tenants/mine'),
    staleTime: 30_000,
    enabled: signedIn,
  })
  const go = useCallback((link: string | null) => {
    after?.()
    if (link && link.startsWith('/') && !link.startsWith('//')) router.push(link)
  }, [router, after])
  const [pending, setPending] = useState<string | null>(null)
  const switchCompany = useSwitchCompany(() => { const l = pending; setPending(null); go(l) })

  return useCallback((n: NotificationItem) => {
    if (!n.readAt) markRead.mutate(n.id)
    const active = tenants.find((t) => t.isActive)
    if (n.switchCompany && n.tenantId && active?.id !== n.tenantId) {
      if (tenants.some((t) => t.id === n.tenantId)) {
        setPending(n.link)
        switchCompany.mutate(n.tenantId, { onError: () => { setPending(null); go(n.link) } })
        return
      }
      if (reach.some((r) => r.companyId === n.tenantId)) setLens(n.tenantId)
    }
    go(n.link)
  }, [tenants, reach, setLens, markRead, switchCompany, go])
}

export function BellIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 2.5a4.5 4.5 0 0 0-4.5 4.5v2.2c0 .9-.3 1.7-.9 2.4L3.7 12.7a.8.8 0 0 0 .6 1.3h11.4a.8.8 0 0 0 .6-1.3l-.9-1.1a3.7 3.7 0 0 1-.9-2.4V7A4.5 4.5 0 0 0 10 2.5Z"
        stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8 16.2a2.1 2.1 0 0 0 4 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function badgeText(n: number) { return n > 99 ? '99+' : n > 9 ? '9+' : String(n) }

export function NotificationRow({ n, showCompany, onOpen }: { n: NotificationItem; showCompany: boolean; onOpen: (n: NotificationItem) => void }) {
  const unread = !n.readAt
  return (
    <button type="button" onClick={() => onOpen(n)}
      className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-white/5"
      style={{ borderBottom: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
        style={{ background: unread ? severityColor(n.severity) : 'transparent', border: unread ? 'none' : '1px solid rgb(var(--fg-rgb) / 0.15)' }}
        aria-label={unread ? 'Unread' : 'Read'} />
      <span className="min-w-0 flex-1">
        <span className={`block text-[13px] leading-snug ${unread ? 'font-semibold text-white' : 'text-white/70'}`}>{n.title}</span>
        {n.body && <span className="mt-0.5 block text-xs text-white/50" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{n.body}</span>}
        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-white/40">
          {showCompany && n.companyName && (
            <span className="rounded px-1.5 py-px font-semibold" style={{ background: 'rgb(var(--fg-rgb) / 0.07)' }}>{n.companyName}</span>
          )}
          <span>{relativeTime(n.createdAt)}</span>
        </span>
      </span>
    </button>
  )
}

// The panel's width on desktop (md:w-[360px] below).
const PANEL_W = 360

export function NotificationBell({ variant = 'sidebar' }: { variant?: 'sidebar' | 'collapsed' | 'mobile' }) {
  const { data: me } = usePermissions()
  const enabled = Boolean(me)
  useNotificationSocket(enabled)
  const { data: unread = 0 } = useUnreadCount(enabled)
  const { data: counts } = useApprovalCounts(enabled)
  const waiting = counts?.total ?? 0
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const inbox = useInbox({ limit: 10, enabled: enabled && open })
  const markAll = useMarkAllRead()
  const openItem = useOpenNotification(() => setOpen(false))
  const { data: tenants = [] } = useQuery<MyTenant[]>({
    queryKey: ['my-tenants'],
    queryFn: () => api.get<MyTenant[]>('/tenants/mine'),
    staleTime: 30_000,
    enabled,
  })
  const items = (inbox.data?.pages[0]?.items ?? []).slice(0, 10)
  const multi = tenants.length > 1

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect()
      if (!r) return
      const mobile = window.innerWidth < 768
      if (mobile) setPos({ top: r.bottom + 6, left: 0 })
      // Beside the bell when there is room (sidebar); otherwise below it,
      // right edge aligned to the bell, kept inside the window (top bar).
      else if (r.right + 8 + PANEL_W + 8 <= window.innerWidth) {
        setPos({ top: Math.max(8, Math.min(r.top, window.innerHeight - 480)), left: r.right + 8 })
      } else {
        setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.right - PANEL_W, window.innerWidth - PANEL_W - 8)) })
      }
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  if (!enabled) return null
  const size = variant === 'mobile' ? 'h-11 w-11' : 'h-9 w-9'

  const panel = open && pos && typeof document !== 'undefined' && createPortal(
    <div ref={panelRef} role="dialog" aria-label="Notifications"
      className="fixed z-[70] flex max-h-[70vh] flex-col overflow-hidden rounded-xl shadow-xl max-md:!left-0 max-md:!w-full max-md:rounded-t-none md:w-[360px]"
      style={{ top: pos.top, left: pos.left, background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.1)' }}>
      <div className="flex items-center justify-between px-3 py-2.5" style={{ borderBottom: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
        <span className="text-sm font-bold text-white">Notifications</span>
        <button type="button" onClick={() => markAll.mutate()} disabled={unread === 0 || markAll.isPending}
          className="text-xs font-semibold disabled:opacity-40" style={{ color: 'var(--erp-primary)' }}>
          Mark all read
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {waiting > 0 && (
          <Link href="/ceo/approvals" onClick={() => setOpen(false)}
            className="flex items-center justify-between gap-2 px-3 py-2.5 text-[13px] font-semibold"
            style={{ background: 'rgb(var(--erp-primary-rgb) / 0.08)', color: 'var(--erp-primary)', borderBottom: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
            <span>{waiting} approval{waiting === 1 ? '' : 's'} waiting</span>
            <span aria-hidden="true">Approvals &rarr;</span>
          </Link>
        )}
        {inbox.isLoading && <p className="px-3 py-6 text-center text-xs text-white/40">Loading…</p>}
        {inbox.isError && <p className="px-3 py-6 text-center text-xs" style={{ color: 'var(--erp-danger)' }}>Could not load notifications.</p>}
        {!inbox.isLoading && !inbox.isError && items.length === 0 && (
          <CompactEmptyState message="Nothing yet. Approvals, night audit reports and warnings sent to you appear here." />
        )}
        {items.map((n) => <NotificationRow key={n.id} n={n} showCompany={multi} onOpen={openItem} />)}
      </div>
      <div className="px-3 py-2 text-center" style={{ borderTop: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
        <Link href="/me/notifications" onClick={() => setOpen(false)} className="text-xs font-semibold" style={{ color: 'var(--erp-primary)' }}>See all</Link>
      </div>
    </div>,
    document.body,
  )

  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications, ${unread} unread`} aria-expanded={open} aria-haspopup="dialog"
        className={`relative flex ${size} shrink-0 items-center justify-center rounded-lg text-white/50 transition-colors hover:text-white/90`}>
        <BellIcon />
        {unread > 0 && (
          <span className="absolute right-0.5 top-0.5 flex min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-black leading-4"
            style={{ background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }} aria-hidden="true">
            {badgeText(unread)}
          </span>
        )}
      </button>
      <span className="sr-only" role="status" aria-live="polite">{unread > 0 ? `${unread} unread notifications` : ''}</span>
      {panel}
    </>
  )
}
