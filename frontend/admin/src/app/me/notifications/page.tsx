'use client'
// My notifications — the bell's full list (owner, 2026-10-16). Personal: every
// login opens it (/me is always open); the API returns only this login's rows.

import { useState } from 'react'
import { useInbox, useMarkAllRead, useUnreadCount, type CompanyFilter } from '../../../lib/notificationsData'
import { NotificationRow, useOpenNotification } from '../../../components/ui/NotificationBell'

export default function MyNotificationsPage() {
  const [tab, setTab] = useState<'all' | 'unread'>('all')
  const [company, setCompany] = useState<CompanyFilter>('all')
  const inbox = useInbox({ unread: tab === 'unread', company, limit: 30 })
  const { data: unread = 0 } = useUnreadCount()
  const markAll = useMarkAllRead()
  const open = useOpenNotification()
  const items = inbox.data?.pages.flatMap((p) => p.items) ?? []
  const chip = (on: boolean) => ({
    background: on ? 'var(--erp-primary)' : 'rgb(var(--fg-rgb) / 0.05)',
    color: on ? 'var(--erp-on-primary)' : undefined,
  })

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-8">
      <p className="text-xs font-bold uppercase tracking-wider text-success">Me</p>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-black text-white">Notifications</h1>
        <button type="button" onClick={() => markAll.mutate()} disabled={unread === 0 || markAll.isPending}
          className="rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-40"
          style={{ background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }}>
          Mark all read
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Show" className="flex gap-1.5">
          {(['all', 'unread'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className="rounded-full px-3 py-1.5 text-xs font-semibold text-white/70" style={chip(tab === t)}>
              {t === 'all' ? 'All' : `Unread${unread ? ` (${unread})` : ''}`}
            </button>
          ))}
        </div>
        <span className="mx-1 h-4 w-px" style={{ background: 'rgb(var(--fg-rgb) / 0.12)' }} aria-hidden="true" />
        <div role="group" aria-label="Company" className="flex gap-1.5">
          {([['all', 'All my companies'], ['active', 'This company']] as const).map(([v, label]) => (
            <button key={v} aria-pressed={company === v} onClick={() => setCompany(v)}
              className="rounded-full px-3 py-1.5 text-xs font-semibold text-white/70" style={chip(company === v)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
        {inbox.isLoading && <p className="px-4 py-10 text-center text-sm text-white/40">Loading…</p>}
        {inbox.isError && <p className="px-4 py-10 text-center text-sm" style={{ color: 'var(--erp-danger)' }}>Could not load notifications.</p>}
        {!inbox.isLoading && !inbox.isError && items.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-white/40">
            {tab === 'unread' ? 'You are all caught up.' : 'Nothing yet. Approvals, night audit reports and warnings sent to you appear here.'}
          </p>
        )}
        {items.map((n) => <NotificationRow key={n.id} n={n} showCompany onOpen={open} />)}
      </div>

      {inbox.hasNextPage && (
        <div className="mt-4 text-center">
          <button type="button" onClick={() => inbox.fetchNextPage()} disabled={inbox.isFetchingNextPage}
            className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50" style={{ color: 'var(--erp-primary)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.4)' }}>
            {inbox.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  )
}
