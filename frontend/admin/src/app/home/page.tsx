'use client'
// CEO home (owner, 2026-10-06): a mini CEO dashboard — one top-down view of
// the whole business, a panel per department, each opening that department's
// full dashboard. Blank until the owner picks the headline numbers.

import Link from 'next/link'

const DEPARTMENTS = [
  { title: 'Operations', href: '/dashboard/operations' },
  { title: 'Marketing', href: '/dashboard/marketing' },
  { title: 'Finance', href: '/dashboard/finance' },
  { title: 'HR', href: '/dashboard/hr' },
]

export default function CeoHome() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 pt-7 pb-5">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/40">CEO</p>
        <h1 className="text-2xl font-black text-white/90 mt-1">Home</h1>
        <p className="text-sm text-white/45 mt-1">The whole business at a glance. No numbers chosen yet.</p>
      </header>
      <div className="px-7 pb-10 grid grid-cols-1 md:grid-cols-2 gap-4 max-w-[1200px]">
        {DEPARTMENTS.map((d) => (
          <section key={d.href} className="rounded-2xl p-5 min-h-[180px] flex flex-col"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-black uppercase tracking-[0.2em] text-white/70">{d.title}</h2>
              <Link href={d.href} className="text-xs font-bold text-primary-ink hover:underline">Open dashboard →</Link>
            </div>
            <p className="text-sm text-white/40 mt-auto">No numbers chosen yet.</p>
          </section>
        ))}
      </div>
    </div>
  )
}
