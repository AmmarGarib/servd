'use client'
// The top-bar "My tasks" button (owner, 2026-11-04: "the person who is working on the task to be notified through the
// 'my tasks' bar on the portal. the bar should be next to notification panel only for MARKETING resources"). Shown
// to marketing, brand-manager and marketing-intern logins only. The badge = tasks still to do + tasks waiting on your
// approval (GET /my-tasks/count, every minute and on focus); the drop-down lists them and opens My tasks.
import { useRef, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ListChecks } from 'lucide-react'
import { api } from '../../lib/api'
import { AnchoredMenu } from './AnchoredMenu'

export const TASK_BAR_ROLES = ['marketing', 'brand_manager', 'marketing_intern']
export const showsTaskBar = (role: string | null | undefined) => !!role && TASK_BAR_ROLES.includes(role)

interface TaskLite { id: string; title: string; deadline: string; overdue: boolean; link: string; board: { name: string } | null }
interface Counts { open: number; awaitingApproval: number; toApprove: number; badge: number }

const day = (iso: string) => new Date(iso).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', timeZone: 'Asia/Karachi' })

export function TaskBell({ role, size = 'h-11 w-11', bordered = false }: { role: string | null | undefined; size?: string; bordered?: boolean }) {
  const show = showsTaskBar(role)
  const btn = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const { data: counts } = useQuery<Counts>({
    queryKey: ['my-tasks', 'count'], queryFn: () => api.get('/my-tasks/count'),
    enabled: show, refetchInterval: 60_000, refetchOnWindowFocus: true, staleTime: 20_000,
  })
  const { data: list } = useQuery<{ open: TaskLite[]; toApprove: TaskLite[] }>({
    queryKey: ['my-tasks'], queryFn: () => api.get('/my-tasks'), enabled: show && open,
  })
  if (!show) return null
  const badge = counts?.badge ?? 0
  const rows = (items: TaskLite[]) => items.slice(0, 6).map((t) => (
    <Link key={t.id} href={t.link} onClick={() => setOpen(false)} role="menuitem" className="block rounded-lg px-3 py-2 text-sm hover:bg-s-elevated">
      <span className="block break-words font-semibold">{t.title}</span>
      <span className={`block text-xs ${t.overdue ? 'text-s-red' : 'text-s-muted'}`}>
        {t.board ? `${t.board.name} · ` : 'Calendar · '}{t.overdue ? 'Overdue ' : 'Due '}{day(t.deadline)}
      </span>
    </Link>
  ))
  return (
    <>
      <button ref={btn} type="button" onClick={() => setOpen((o) => !o)} title="My tasks"
        aria-label={`My tasks${badge ? `, ${badge} waiting` : ''}`} aria-expanded={open} aria-haspopup="menu"
        className={`relative flex ${size} shrink-0 items-center justify-center rounded-lg text-white/50 transition-colors hover:text-white/90`}
        style={bordered ? { border: '1px solid rgb(var(--fg-rgb) / 0.2)', color: 'rgb(var(--fg-rgb) / 0.85)' } : undefined}>
        <ListChecks size={18} aria-hidden="true" />
        {badge > 0 && (
          <span className="absolute right-0.5 top-0.5 flex min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-black leading-4"
            style={{ background: 'var(--erp-accent)', color: 'var(--erp-secondary)' }} aria-hidden="true">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </button>
      <AnchoredMenu anchor={btn} open={open} onClose={() => setOpen(false)} align="end" minWidth={300} maxHeight={440}>
        <div className="erp-on-surface p-2" style={{ background: 'var(--surface)' }}>
          <p className="px-3 pb-1 pt-1 text-xs font-bold uppercase tracking-wider text-success">My tasks</p>
          {!list && <p className="px-3 py-4 text-sm text-s-muted">Loading…</p>}
          {list && list.toApprove.length > 0 && (
            <>
              <p className="px-3 pt-2 text-xs font-semibold text-s-muted">Waiting for your approval ({list.toApprove.length})</p>
              {rows(list.toApprove)}
            </>
          )}
          {list && (
            <>
              <p className="px-3 pt-2 text-xs font-semibold text-s-muted">To do ({list.open.length})</p>
              {list.open.length === 0 ? <p className="px-3 py-2 text-sm text-s-muted">Nothing on your list.</p> : rows(list.open)}
            </>
          )}
          <Link href="/me/tasks" onClick={() => setOpen(false)} className="mt-1 block rounded-lg px-3 py-2 text-center text-xs font-semibold" style={{ color: 'var(--erp-primary)' }}>
            Open My tasks
          </Link>
        </div>
      </AnchoredMenu>
    </>
  )
}
