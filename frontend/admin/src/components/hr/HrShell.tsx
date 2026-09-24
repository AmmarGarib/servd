'use client'
// Frame for every HR page: title, the module's own navigation, and room below.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import type { HrSectionInfo, Lookups, OrgData } from '../../lib/hr'

const NAV: Array<{ href: string; label: string }> = [
  { href: '/hr', label: 'Dashboard' },
  { href: '/hr/employees', label: 'Employees' },
  { href: '/hr/sections', label: 'All sections' },
  { href: '/hr/documents', label: 'Documents' },
  { href: '/hr/payroll', label: 'Payroll' },
  { href: '/hr/approvals', label: 'Approvals' },
  { href: '/hr/letters', label: 'Letters' },
  { href: '/hr/reports', label: 'Reports' },
  { href: '/hr/formats', label: 'Formats' },
  { href: '/hr/org', label: 'Org setup' },
  { href: '/hr/settings', label: 'Settings' },
  { href: '/hr/me', label: 'My HR' },
]

export function HrShell({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  const path = usePathname() ?? ''
  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
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
          {NAV.map((n) => {
            const on = n.href === '/hr' ? path === '/hr' : path.startsWith(n.href)
            return (
              <Link key={n.href} href={n.href}
                className="px-3 py-2 text-xs font-bold whitespace-nowrap border-b-2"
                style={{ borderColor: on ? '#00D4B1' : 'transparent', color: on ? '#00D4B1' : 'rgba(255,255,255,0.5)' }}>
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

export function useHrLookups() {
  return useQuery({ queryKey: ['hr-lookups'], queryFn: () => api.get<Lookups>('/hr/lookups'), staleTime: 30_000 })
}
export function useHrOrg() {
  return useQuery({ queryKey: ['hr-org'], queryFn: () => api.get<OrgData>('/hr/org'), staleTime: 60_000 })
}
export function useHrSections() {
  return useQuery({ queryKey: ['hr-sections'], queryFn: () => api.get<HrSectionInfo[]>('/hr/sections'), staleTime: 30_000 })
}

export function Modal({ title, wide, onClose, children }: { title: string; wide?: boolean; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 overflow-y-auto" onClick={onClose}>
      <div className={`w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-2xl p-6 my-8`} style={{ background: '#12131a', border: '1px solid rgba(255,255,255,0.08)' }}
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
  const color = tone === 'warn' ? '#f59e0b' : tone === 'bad' ? '#f87171' : tone === 'good' ? '#34d399' : 'rgba(255,255,255,0.9)'
  return (
    <div className="rounded-2xl p-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <p className="text-[10px] uppercase tracking-wider text-white/40 font-bold">{label}</p>
      <p className="text-xl font-black mt-1" style={{ color }}>{value}</p>
    </div>
  )
}
