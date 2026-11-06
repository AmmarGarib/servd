'use client'
// CEO home (owner, 2026-10-06): a mini CEO dashboard — one top-down view of
// the whole business, a panel per department, each opening that department's
// full dashboard. The headline numbers are the owner's starter set (C4, 2026-10-26).

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { DashboardTiles } from '../../components/ui/DashboardTiles'
import { useMyTenants } from '../../components/ui/TenantPicker'

// The company the home numbers show (owner, 2026-11-06: "a company flipper button … GS Foods cash in front of me
// cleanly and switch to Flipd"). Remembered on this device only.
const COMPANY_KEY = 'servd_home_company'

const DEPARTMENTS = [
  { title: 'Operations', href: '/dashboard/operations' },
  { title: 'Marketing', href: '/dashboard/marketing' },
  { title: 'Finance', href: '/dashboard/finance' },
  { title: 'HR', href: '/dashboard/hr' },
]

export default function CeoHome() {
  const { data: companies = [], isLoading: companiesLoading } = useMyTenants()
  const [picked, setPicked] = useState<string | null>(null)
  useEffect(() => {
    if (picked || companies.length === 0) return
    let saved: string | null = null
    try { saved = localStorage.getItem(COMPANY_KEY) } catch { /* storage blocked */ }
    setPicked(companies.some((c) => c.id === saved) ? saved : companies[0]!.id)
  }, [companies, picked])
  const choose = (id: string) => {
    setPicked(id)
    try { localStorage.setItem(COMPANY_KEY, id) } catch { /* storage blocked */ }
  }
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 pt-7 pb-5">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/40">CEO</p>
        <h1 className="text-2xl font-black text-white/90 mt-1">Home</h1>
        <p className="text-sm text-white/45 mt-1">The whole business at a glance.</p>
      </header>
      {companies.length > 1 && (
        <div className="px-7 pb-4 max-w-[1200px]">
          <div role="tablist" aria-label="Company" className="inline-flex flex-wrap gap-1 rounded-xl p-1"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            {companies.map((c) => {
              const on = c.id === picked
              return (
                <button key={c.id} role="tab" aria-selected={on} type="button" onClick={() => choose(c.id)}
                  className="rounded-lg px-4 py-2 text-sm font-bold transition-colors"
                  style={on
                    ? { background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }
                    : { color: 'rgb(var(--ink-rgb) / 0.65)' }}>
                  {c.name}
                </button>
              )
            })}
          </div>
        </div>
      )}
      <div className="px-7 pb-6 max-w-[1200px]">
        {companiesLoading || (companies.length > 1 && !picked) ? null : <DashboardTiles id="ceo" tenantId={picked ?? undefined} />}
      </div>
      <div className="px-7 pb-10 grid grid-cols-1 md:grid-cols-2 gap-4 max-w-[1200px]">
        {DEPARTMENTS.map((d) => (
          <section key={d.href} className="rounded-2xl p-5 flex flex-col"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-black uppercase tracking-[0.2em] text-white/70">{d.title}</h2>
              <Link href={d.href} className="text-xs font-bold text-primary-ink hover:underline">Open dashboard →</Link>
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
