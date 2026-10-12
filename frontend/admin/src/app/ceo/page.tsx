'use client'
// The CEO section's home (owner decision D2, 2026-10-11): what is waiting on
// you first, then the section's parts — Companies & head offices, Logins &
// access, Company rules. The sections and who may open them come from the API
// (GET /permissions/me → the 'ceo' workspace, lib/workspaces.ts); the pages
// behind each module from lib/moduleCatalog.ts. Operations (menu, stock, till,
// kitchen, buying) is the F&B manager's workspace, at /w/operations.

import Link from 'next/link'
import { useMyWorkspaces } from '../../hooks/useWorkspaces'
import { pagesForModules } from '../../lib/moduleCatalog'
import { useApprovalCounts } from './approvalsData'

const card = { background: 'var(--surface)', border: '1px solid var(--border)' }

export default function CeoHomePage() {
  const { workspaces, isLoading } = useMyWorkspaces()
  const ws = workspaces.find((w) => w.id === 'ceo')
  const { data: counts } = useApprovalCounts()

  if (isLoading) return <Shell><p className="text-sm text-white/40">Loading…</p></Shell>

  if (!ws) {
    return (
      <Shell>
        <h1 className="text-2xl font-black text-white/90">CEO</h1>
        <p className="text-sm text-white/50 mt-2 max-w-xl">This section is the CEO&rsquo;s. Anything waiting on your own approval is in Approvals.</p>
        <Link href="/ceo/approvals" className="inline-block mt-4 text-xs font-bold hover:underline" style={{ color: 'var(--erp-primary-ink)' }}>Approvals →</Link>
      </Shell>
    )
  }

  const waiting = (counts?.types ?? []).filter((t) => t.count > 0)
  const sections = ws.sections.filter((s) => s.key !== 'approvals')

  return (
    <Shell>
      <p className="text-[11px] font-bold uppercase tracking-wider text-white/35">Workspace</p>
      <h1 className="text-3xl font-black text-white/90">CEO</h1>
      <p className="text-sm text-white/50 mt-1 max-w-2xl">
        Approvals, your companies, who can sign in and what they can open, and the rules every branch runs on.
        Day-to-day F&amp;B work is in <Link href="/w/operations" className="font-bold hover:underline" style={{ color: 'var(--erp-primary-ink)' }}>Operations</Link>.
      </p>

      <Link href="/ceo/approvals" className="mt-5 block rounded-2xl px-4 py-4 hover:opacity-95" style={card}>
        <div className="flex items-center gap-3">
          <span className="text-sm font-black text-white/85">Approvals</span>
          <span className="rounded-full px-2 py-0.5 text-[11px] font-black"
            style={(counts?.total ?? 0) > 0
              ? { background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }
              : { background: 'rgb(var(--fg-rgb) / 0.08)', color: 'rgb(var(--fg-rgb) / 0.5)' }}>
            {counts?.total ?? 0} waiting
          </span>
          <span className="ml-auto text-xs text-white/40">Open →</span>
        </div>
        {waiting.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
            {waiting.map((t) => (
              <span key={t.type} className="text-xs text-white/60"><b className="text-white/85">{t.count}</b> {t.label.toLowerCase()}</span>
            ))}
          </div>
        )}
      </Link>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((s) => {
          const pages = pagesForModules(s.modules)
          return (
            <div key={s.key} className="rounded-2xl p-4" style={card}>
              <p className="text-sm font-black text-white/85">{s.title}</p>
              <div className="mt-2 space-y-1">
                {pages.length === 0 && <p className="text-[11px] text-white/35">No admin page for this section yet.</p>}
                {pages.map((p) => (
                  <Link key={p.href} href={p.href} className="block rounded-lg px-2 py-1.5 -mx-2 hover:bg-white/[0.04]">
                    <span className="text-[13px] font-semibold text-white/80">{p.label}</span>
                    {p.hint && <span className="block text-[11px] text-white/40">{p.hint}</span>}
                  </Link>
                ))}
                {s.key === 'companies' && (
                  <p className="text-[11px] text-white/35 pt-1">Head offices join this section when head office is set up.</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="px-4 sm:px-6 py-6 max-w-6xl mx-auto">{children}</div>
}
