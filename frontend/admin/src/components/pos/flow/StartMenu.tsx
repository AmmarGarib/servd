'use client'
import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowLeft, BarChart3, ChevronDown, ChevronUp, ClipboardList, FileText, Receipt, Search, ShoppingBag, Tag, Truck, UtensilsCrossed, Wallet, X } from 'lucide-react'
import { useAuthStore } from '../../../store/auth'
import { useIsManager } from '../managerRole'

export type StartAction = 'dine_in' | 'delivery' | 'no_charge' | 'summary' | 'tickets' | 'takeaway' | 'sales_report'

interface Entry { id: StartAction | 'shift' | 'back' | 'waiter'; label: string; icon: ReactNode; href?: string; badge?: number }

// The till's start menu (owner's flow, step 1): ORDERING · MANAGER · OTHER.
// Room Service and Take Away are NOT under ORDERING; Takeaway lives in OTHER.
export function StartMenu({ onPick, ticketCount, active, onClose }: {
  onPick: (a: StartAction) => void
  ticketCount: number
  active?: StartAction | null
  /** Overlay mode (opened with the menu button): shows the close button. */
  onClose?: () => void
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState({ ordering: true, manager: false, other: false })
  // Sales report: the report readers (managers, finance, procurement — reports/routes.ts REPORT_READERS).
  const isManager = useIsManager()
  const role = useAuthStore((st) => st.user?.role ?? null)
  const seesSales = isManager || role === 'finance' || role === 'procurement'

  const ordering: Entry[] = [
    { id: 'dine_in', label: 'Dine In', icon: <UtensilsCrossed size={18} aria-hidden="true" /> },
    { id: 'delivery', label: 'Delivery', icon: <Truck size={18} aria-hidden="true" /> },
    { id: 'no_charge', label: 'No Charge', icon: <Tag size={18} aria-hidden="true" /> },
    { id: 'summary', label: 'Order Summary', icon: <FileText size={18} aria-hidden="true" /> },
  ]
  // Manager actions that already exist: open tickets (voids and cancels are inside a ticket),
  // Raast bank alerts (the till header shows them with their approvals), the shift / close shift.
  const manager: Entry[] = [
    { id: 'tickets', label: 'Open tickets', icon: <ClipboardList size={18} aria-hidden="true" />, badge: ticketCount },
    { id: 'shift', label: 'Shift / close shift', icon: <Wallet size={18} aria-hidden="true" />, href: '/pos/shift' },
  ]
  const other: Entry[] = [
    { id: 'takeaway', label: 'Takeaway', icon: <ShoppingBag size={18} aria-hidden="true" /> },
    ...(seesSales ? [{ id: 'sales_report' as const, label: 'Sales report', icon: <BarChart3 size={18} aria-hidden="true" /> }] : []),
    { id: 'waiter', label: 'Waiter ordering', icon: <Receipt size={18} aria-hidden="true" />, href: '/pos/waiter' },
    { id: 'back', label: 'Back to admin', icon: <ArrowLeft size={18} aria-hidden="true" />, href: '/w' },
  ]

  const needle = q.trim().toLowerCase()
  const match = (e: Entry) => !needle || e.label.toLowerCase().includes(needle)

  function row(e: Entry) {
    const cls = `flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-base font-semibold transition-colors ${
      active && e.id === active ? 'bg-kds-green/20 text-kds-green' : 'text-kds-text hover:bg-kds-border/60'
    }`
    const inner = (
      <>
        <span className="text-kds-subtext" aria-hidden="true">{e.icon}</span>
        <span className="flex-1">{e.label}</span>
        {!!e.badge && <span className="rounded-full bg-kds-amber px-2 text-xs font-black text-black">{e.badge}</span>}
      </>
    )
    return e.href
      ? <Link key={e.id} href={e.href} className={cls}>{inner}</Link>
      : <button key={e.id} type="button" onClick={() => onPick(e.id as StartAction)} className={cls}>{inner}</button>
  }

  function section(key: 'ordering' | 'manager' | 'other', title: string, entries: Entry[]) {
    const shown = entries.filter(match)
    if (needle && shown.length === 0) return null
    const isOpen = needle ? true : open[key]
    return (
      <section key={key} className="border-t border-kds-border pt-1">
        <button type="button" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}
          className="flex min-h-11 w-full items-center justify-between px-3 text-xs font-bold uppercase tracking-wider text-kds-subtext">
          {title}
          {isOpen ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
        </button>
        {isOpen && <div className="space-y-1 pb-2">{shown.map(row)}</div>}
      </section>
    )
  }

  return (
    <nav aria-label="Till menu" className="flex h-full w-full flex-col bg-kds-card">
      <div className="flex min-h-14 shrink-0 items-center gap-1 border-b border-kds-border pl-3 pr-1">
        {onClose && (
          <button type="button" data-dialog-close onClick={onClose} aria-label="Close menu"
            className="flex h-11 w-11 shrink-0 items-center justify-center text-kds-subtext hover:text-kds-text"><X size={20} aria-hidden="true" /></button>
        )}
        <h2 className="text-lg font-bold text-kds-text">Till menu</h2>
      </div>
      <div className="shrink-0 p-3">
        <label className="relative block">
          <span className="sr-only">Search the menu</span>
          <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kds-subtext" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search"
            className="min-h-11 w-full rounded-lg border border-kds-border bg-kds-bg pl-9 pr-3 text-base text-kds-text placeholder:text-kds-subtext focus:border-kds-green focus:outline-none" />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {section('ordering', 'Ordering', ordering)}
        {section('manager', 'Manager', manager)}
        {section('other', 'Other', other)}
      </div>
    </nav>
  )
}
