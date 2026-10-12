'use client'
// All workspaces — servd grouped by owner (decision 47): Operations, Finance,
// Marketing, HR, Dev.
//
// Every workspace is listed for everyone, with who owns it, which roles live
// there, its sections and the pages behind them. Pages you cannot open are
// shown dimmed, so the shape of the whole system stays legible. The
// definitions come from GET /permissions/workspaces; the admin keeps no copy.
// The amber notes are the current known gaps (lib/moduleCatalog.ts).

import Link from 'next/link'
import { useMemo } from 'react'
import { usePermissions } from '../../hooks/useCan'
import { useWorkspaceDefs } from '../../hooks/useWorkspaces'
import { useAuthStore } from '../../store/auth'
import { roleLabel } from '../../lib/appRoles'
import { pagesForModules, gapsForModules, MODULE_PAGES } from '../../lib/moduleCatalog'

export default function WorkspacesPage() {
  const { data: me } = usePermissions()
  const user = useAuthStore((s) => s.user)
  const { data: defs = [], isLoading, error } = useWorkspaceDefs()

  // null = everything (the CEO)
  const allowed = useMemo<Set<string> | null>(() => {
    if (!me) return new Set()
    if (me.role === 'admin') return null
    return new Set(me.modules)
  }, [me])
  const mine = new Set((me?.workspaces ?? []).map((w) => w.id))

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="px-6 pt-8 pb-6 max-w-6xl mx-auto">
        <p className="text-xs uppercase tracking-[0.18em] text-s-muted">
          {user?.name ? `Welcome back, ${user.name.split(' ')[0]}` : 'servd'}
        </p>
        <h1 className="text-3xl font-black text-s-text mt-1">Workspaces</h1>
        <p className="text-sm text-s-muted mt-1.5 max-w-2xl">
          servd is organised by who owns the work. Each workspace has an owner, the roles that
          work in it, and its sections. Pages you can&rsquo;t open are dimmed.
        </p>
      </header>

      <main className="px-6 pb-16 max-w-6xl mx-auto space-y-4">
        {isLoading && <p className="text-sm text-s-muted">Loading…</p>}
        {error != null && <p className="text-sm text-s-muted">Could not load the workspaces.</p>}
        {defs.map((w) => {
          const open = mine.has(w.id)
          return (
            <section key={w.id} className="rounded-2xl p-5"
              style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: `1px solid ${open ? 'rgb(var(--erp-primary-rgb) / 0.22)' : 'rgb(var(--fg-rgb) / 0.07)'}` }}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-black text-s-text">{w.title}</h2>
                  <p className="text-xs text-s-muted mt-1">
                    Owner: <span className="text-s-text font-semibold">{w.ownerRoles.map(roleLabel).join(' / ') || '—'}</span>
                    {w.memberRoles.length > 0 && (
                      <> · Roles: {w.memberRoles.map(roleLabel).join(', ')}</>
                    )}
                  </p>
                </div>
                {open ? (
                  <Link href={`/w/${w.id}`} className="text-xs font-bold px-3 py-1.5 rounded-lg"
                    style={{ background: 'rgb(var(--erp-primary-rgb) / 0.1)', color: 'var(--erp-primary-ink)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.25)' }}>
                    Open {w.title} →
                  </Link>
                ) : (
                  <span className="text-[10px] font-black uppercase tracking-wider px-2 py-1 rounded-full text-s-dim"
                    style={{ border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>No access</span>
                )}
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {w.sections.map((s) => {
                  const pages = pagesForModules(s.modules)
                  const gaps = gapsForModules(s.modules)
                  return (
                    <div key={s.key} className="rounded-xl p-3"
                      style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                      <p className="text-sm font-bold text-s-text">{s.title}</p>
                      <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1">
                        {pages.length === 0 && <span className="text-[11px] text-s-dim">No admin page</span>}
                        {pages.map((p) => {
                          const mod = moduleOfPage(p.href)
                          const can = !allowed || (mod ? allowed.has(mod) : true)
                          return can ? (
                            <Link key={p.href} href={p.href} className="text-[11px] text-primary-ink hover:underline">{p.label}</Link>
                          ) : (
                            <span key={p.href} className="text-[11px] text-s-dim">{p.label}</span>
                          )
                        })}
                      </div>
                      {gaps.map((g) => (
                        <p key={g.module} className="text-[10.5px] mt-2 leading-snug" style={{ color: 'rgba(245,158,11,0.85)' }}>
                          {g.note}
                        </p>
                      ))}
                    </div>
                  )
                })}
              </div>
            </section>
          )
        })}
      </main>
    </div>
  )
}

function moduleOfPage(href: string): string | undefined {
  for (const [mod, pages] of Object.entries(MODULE_PAGES)) {
    if (pages?.some((p) => p.href === href)) return mod
  }
  return undefined
}
