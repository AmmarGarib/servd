'use client'
// Frame for every HR page: title, the module's own navigation, and room below.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAuthStore } from '../../store/auth'
import { HR_ADMIN_ROLES, PAYROLL_APPROVER_ROLES, type HrFormat, type HrSectionInfo, type Lookups, type OrgData } from '../../lib/hr'

// `staff` tabs are open to every login (the API only shows them their own
// requests and the ones waiting on them); the rest are HR's and would only 403.
const NAV: Array<{ href: string; label: string; staff?: boolean }> = [
  { href: '/dashboard/hr', label: 'Dashboard' },
  { href: '/hr/employees', label: 'Employees' },
  { href: '/hr/attendance', label: 'Attendance' },
  { href: '/hr/sections', label: 'All sections' },
  { href: '/hr/documents', label: 'Documents' },
  { href: '/hr/payroll', label: 'Payroll' },
  { href: '/hr/approvals', label: 'Approvals', staff: true },
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
  return { userId: user?.id ?? null, role, isHrAdmin: HR_ADMIN_ROLES.includes(role), isPayrollApprover: PAYROLL_APPROVER_ROLES.includes(role) }
}

export function HrShell({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  const path = usePathname() ?? ''
  const { isHrAdmin } = useHrAccess()
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-6 pt-5 border-b border-white/[0.05]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-white/35">HR</p>
            <h1 className="text-2xl font-black text-white/90">{title}</h1>
            {subtitle && <p className="text-sm text-white/40 mt-1 max-w-3xl">{subtitle}</p>}
          </div>
          {actions && <div className="flex gap-2 shrink-0">{actions}</div>}
        </div>
        <nav className="flex gap-1 overflow-x-auto mt-4 -mb-px">
          {NAV.filter((n) => isHrAdmin || n.staff).map((n) => {
            const on = path.startsWith(n.href)
            return (
              <Link key={n.href} href={n.href}
                className="px-3 py-2 text-xs font-bold whitespace-nowrap border-b-2"
                style={{ borderColor: on ? 'var(--erp-primary)' : 'transparent', color: on ? 'var(--erp-primary-ink)' : 'rgb(var(--fg-rgb) / 0.5)' }}>
                {n.label}
              </Link>
            )
          })}
        </nav>
      </header>
      <main className="px-6 py-6 max-w-7xl mx-auto">{children}</main>
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

export function Modal({ title, wide, onClose, children }: { title: string; wide?: boolean; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-secondary/50 p-4 overflow-y-auto" onClick={onClose}>
      <div className={`w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-2xl p-6 my-8`} style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 mb-4">
          <p className="text-lg font-black text-white/90">{title}</p>
          <button onClick={onClose} className="text-white/40 hover:text-white" aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'warn' | 'bad' | 'good' }) {
  const color = tone === 'warn' ? '#a15c00' : tone === 'bad' ? '#b42318' : tone === 'good' ? '#3f7d20' : 'rgb(var(--fg-rgb) / 0.9)'
  return (
    <div className="rounded-2xl p-4" style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.07)' }}>
      <p className="text-[10px] uppercase tracking-wider text-white/40 font-bold">{label}</p>
      <p className="text-xl font-black mt-1" style={{ color }}>{value}</p>
    </div>
  )
}
