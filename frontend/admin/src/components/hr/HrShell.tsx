'use client'
// Frame for every HR page: title, the module's own navigation, and room below.

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Modal as DialogModal } from '../ui/Modal'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAuthStore } from '../../store/auth'
import { HR_ADMIN_ROLES, PAYROLL_APPROVER_ROLES, PAYROLL_PAYER_ROLES, PAYROLL_FINANCE_REVIEW_ROLES, type HrFormat, type HrSectionInfo, type Lookups, type OrgData } from '../../lib/hr'

// `staff` tabs are open to every login (the API only shows them their own
// requests and the ones waiting on them); the rest are HR's and would only 403.
const NAV: Array<{ href: string; label: string; staff?: boolean }> = [
  { href: '/dashboard/hr', label: 'Dashboard' },
  { href: '/hr/employees', label: 'Employees' },
  { href: '/hr/attendance', label: 'Attendance' },
  { href: '/hr/sections', label: 'All sections' },
  { href: '/hr/documents', label: 'Documents' },
  { href: '/hr/payroll', label: 'Payroll' },
  { href: '/hr/letters', label: 'Letters' },
  { href: '/hr/reports', label: 'Reports' },
  { href: '/hr/formats', label: 'Formats' },
  { href: '/hr/org', label: 'Org setup' },
  { href: '/hr/settings', label: 'Settings' },
  { href: '/hr/me', label: 'My HR', staff: true },
]

/** What the signed-in user may do in HR — mirrors the API's role gates. */
export function useHrAccess() {
  const user = useAuthStore((s) => s.user)
  const role = user?.role ?? ''
  return { userId: user?.id ?? null, role, isHrAdmin: HR_ADMIN_ROLES.includes(role), isPayrollApprover: PAYROLL_APPROVER_ROLES.includes(role), isPayrollPayer: PAYROLL_PAYER_ROLES.includes(role), isFinanceReviewer: PAYROLL_FINANCE_REVIEW_ROLES.includes(role) }
}

const navBase = (href: string) => href.split('?')[0] ?? href
const navActive = (path: string, href: string) => {
  const base = navBase(href)
  return path === base || path.startsWith(`${base}/`)
}

export function HrShell({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  const path = usePathname() ?? ''
  const { isHrAdmin } = useHrAccess()
  const navRef = useRef<HTMLElement>(null)
  const [edge, setEdge] = useState({ left: false, right: false })
  const measure = () => {
    const el = navRef.current
    if (!el) return
    setEdge({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 })
  }
  // The active tab scrolls into view (a long strip on a phone), then the edge fades follow.
  useEffect(() => {
    const el = navRef.current
    const active = el?.querySelector<HTMLElement>('[aria-current="page"]')
    if (el && active) {
      const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      const a = active.getBoundingClientRect(); const n = el.getBoundingClientRect()
      el.scrollTo({ left: el.scrollLeft + (a.left - n.left) - (el.clientWidth - a.width) / 2, behavior: reduce ? 'auto' : 'smooth' })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [path, isHrAdmin])
  const fade = `linear-gradient(to right, ${edge.left ? 'transparent 0, #000 28px' : '#000 0'}, ${edge.right ? '#000 calc(100% - 28px), transparent 100%' : '#000 100%'})`
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-4 sm:px-6 pt-5 border-b border-white/[0.05]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-white/35">HR</p>
            <h1 className="text-2xl sm:text-3xl font-black text-white/90">{title}</h1>
            {subtitle && <p className="text-sm text-white/60 mt-1 max-w-3xl">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
        <nav ref={navRef} aria-label="HR sections" onScroll={measure} className="flex gap-1 overflow-x-auto mt-4 -mb-px"
          style={{ WebkitMaskImage: fade, maskImage: fade, scrollbarWidth: 'none' }}>
          {NAV.filter((n) => isHrAdmin || n.staff).map((n) => {
            const on = navActive(path, n.href)
            return (
              <Link key={n.href} href={n.href} aria-current={on ? 'page' : undefined}
                className="px-3 py-2.5 text-xs font-bold whitespace-nowrap border-b-2"
                style={{ borderColor: on ? 'var(--erp-primary)' : 'transparent', color: on ? 'var(--erp-primary-ink)' : 'rgb(var(--fg-rgb) / 0.5)' }}>
                {n.label}
              </Link>
            )
          })}
        </nav>
      </header>
      <main className="px-4 sm:px-6 py-6 max-w-7xl mx-auto">{children}</main>
    </div>
  )
}

// Pickers for one company: pass the company a record or employee belongs to
// (self-service: the employee's own) — left out, the active company's.
const forTenant = (tenantId?: string | null) => (tenantId ? `?${new URLSearchParams({ tenantId })}` : '')
export function useHrLookups(tenantId?: string | null) {
  return useQuery({ queryKey: ['hr-lookups', tenantId ?? null], queryFn: () => api.get<Lookups>(`/hr/lookups${forTenant(tenantId)}`), staleTime: 30_000 })
}
export function useHrOrg(tenantId?: string | null) {
  return useQuery({ queryKey: ['hr-org', tenantId ?? null], queryFn: () => api.get<OrgData>(`/hr/org${forTenant(tenantId)}`), staleTime: 60_000 })
}
export function useHrForm(section: string, tenantId?: string | null) {
  return useQuery({ queryKey: ['hr-form', section, tenantId ?? null], queryFn: () => api.get<{ current: HrFormat }>(`/hr/forms/${section}${forTenant(tenantId)}`) })
}
export function useHrSections() {
  return useQuery({ queryKey: ['hr-sections'], queryFn: () => api.get<HrSectionInfo[]>('/hr/sections'), staleTime: 30_000 })
}

/** The HR dialog: a thin wrapper over the admin's one Modal (focus trap, Escape,
 *  scroll lock, backdrop only on a full click). `dirty` asks before discarding. */
export function Modal({ title, wide, onClose, children, dirty }: { title: string; wide?: boolean; onClose: () => void; children: React.ReactNode; dirty?: boolean }) {
  return <DialogModal title={title} wide={wide} onClose={onClose} dirty={dirty}>{children}</DialogModal>
}

export function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'warn' | 'bad' | 'good' }) {
  const color = tone === 'warn' ? 'var(--erp-warning)' : tone === 'bad' ? 'var(--erp-danger)' : tone === 'good' ? 'var(--erp-success)' : 'rgb(var(--fg-rgb) / 0.9)'
  return (
    <div className="rounded-2xl p-4" style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.07)' }}>
      <p className="text-xs uppercase tracking-wider text-white/65 font-bold">{label}</p>
      <p className="text-xl font-black mt-1" style={{ color }}>{value}</p>
    </div>
  )
}
