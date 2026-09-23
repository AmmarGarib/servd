'use client'
// Module hub — the first thing you see after logging in.
//
// Every module in the system is listed, always, for everyone. What differs is
// the state on the card: full / partial / locked. Locked modules are still
// clickable — opening one explains what it is and who to ask — so the shape of
// the whole system stays legible to everyone, instead of people discovering
// features only when someone grants them.

import Link from 'next/link'
import { useMemo } from 'react'
import { usePermissions } from '../../hooks/useCan'
import { useAuthStore } from '../../store/auth'
import { useRoleModules, modulesForRole } from '../../store/roleModules'
import { isExecutive, type AppRole, type ModuleId } from '../../lib/appRoles'
import { MODULE_CATALOG, moduleAccessFor, type ModuleAccessState } from '../../lib/moduleCatalog'

const STATE_META: Record<ModuleAccessState, { label: string; color: string; bg: string; border: string }> = {
  full:        { label: 'Open',      color: '#00D4B1', bg: 'rgba(0,212,177,0.08)',  border: 'rgba(0,212,177,0.22)' },
  partial:     { label: 'Partial',   color: '#F59E0B', bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.22)' },
  locked:      { label: 'Locked',    color: 'rgba(255,255,255,0.35)', bg: 'rgba(255,255,255,0.02)', border: 'rgba(255,255,255,0.07)' },
  'not-built': { label: 'Not built', color: '#A78BFA', bg: 'rgba(139,92,246,0.10)', border: 'rgba(139,92,246,0.28)' },
}

export default function ModuleHubPage() {
  const { data: me } = usePermissions()
  const user = useAuthStore((s) => s.user)
  const overrides = useRoleModules((s) => s.overrides)

  // null = unrestricted (real CEO). Otherwise the exact atom set for the role.
  const allowed = useMemo<Set<ModuleId> | null>(() => {
    if (!me) return new Set<ModuleId>()
    if (me.role === 'admin') return null
    return new Set(modulesForRole((me.role ?? 'cashier') as AppRole, overrides))
  }, [me, overrides])

  // One list, in catalogue order. The catalogue is ordered by what a defect
  // costs you if left alone, so reading top-down is working in descending order
  // of damage — which is the whole point of collapsing the old A/B split.
  const all = useMemo(
    () => MODULE_CATALOG.map((m) => ({ mod: m, access: moduleAccessFor(m, allowed) })),
    [allowed],
  )
  const notBuilt = all.filter((x) => x.mod.build === 'not-built').length
  const partial  = all.filter((x) => x.mod.build === 'partial').length
  const withGaps = all.filter((x) => x.mod.gaps).length

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="px-6 pt-8 pb-6 max-w-6xl mx-auto">
        <p className="text-xs uppercase tracking-[0.18em] text-s-muted">
          {user?.name ? `Welcome back, ${user.name.split(' ')[0]}` : 'servd'}
        </p>
        <h1 className="text-3xl font-black text-s-text mt-1">Modules</h1>
        <p className="text-sm text-s-muted mt-1.5 max-w-2xl">
          {MODULE_CATALOG.length} modules, ordered by what a defect costs you.{' '}
          {isExecutive(me?.role)
            ? `${notBuilt} not built · ${partial} partly built · ${withGaps} carry known gaps.`
            : 'Locked modules still show what they cover.'}
        </p>
      </header>

      <main className="px-6 pb-16 max-w-6xl mx-auto">
        <ModuleGrid items={all} />
      </main>
    </div>
  )
}

const BUILD_META: Record<string, { label: string; color: string }> = {
  built:       { label: 'Built',     color: 'rgba(255,255,255,0.30)' },
  partial:     { label: 'Partial',   color: '#F59E0B' },
  'not-built': { label: 'Not built', color: '#A78BFA' },
}

function ModuleGrid({ items }: {
  items: Array<{ mod: (typeof MODULE_CATALOG)[number]; access: ReturnType<typeof moduleAccessFor> }>
}) {
  if (items.length === 0) return null
  return (
    <section>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(({ mod, access }) => {
          const meta = STATE_META[access.state]
          const locked = access.state === 'locked'
          const dim = locked || access.state === 'not-built'
          return (
            <Link
              key={mod.id}
              href={`/modules/${mod.id}`}
              className="group rounded-2xl p-4 transition-all block"
              style={{
                background: dim ? 'rgba(255,255,255,0.015)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${meta.border}`,
                opacity: dim ? 0.66 : 1,
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <span className="text-2xl leading-none" aria-hidden>{locked ? '🔒' : mod.icon}</span>
                <span
                  className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0"
                  style={{ background: meta.bg, color: meta.color, border: `1px solid ${meta.border}` }}
                >
                  {meta.label}
                </span>
              </div>
              <div className="flex items-center gap-1.5 mt-2.5">
                <span className="text-[9px] font-black tracking-wider text-s-dim">{mod.ref}</span>
                {mod.build !== 'built' && (
                  <span className="text-[8px] font-black uppercase tracking-wider px-1.5 py-px rounded"
                    style={{ background: 'rgba(255,255,255,0.05)', color: BUILD_META[mod.build]!.color }}
                    title="What exists today, independent of your access">{BUILD_META[mod.build]!.label}</span>
                )}
                {mod.platform && (
                  <span className="text-[8px] font-black uppercase tracking-wider px-1.5 py-px rounded"
                    style={{ background: 'rgba(99,102,241,0.14)', color: '#818CF8' }}
                    title="Platform infrastructure — build once, properly">PLATFORM</span>
                )}
              </div>
              <h3 className="text-sm font-bold text-s-text mt-0.5">{mod.name}</h3>
              <p className="text-[11px] text-s-muted mt-1 leading-snug">{mod.blurb}</p>
              <p className="text-[10px] text-s-dim mt-2">
                {access.state === 'not-built'
                  ? 'Nothing built yet'
                  : locked
                    ? `${access.total} section${access.total === 1 ? '' : 's'} — no access`
                    : `${access.visible.length} of ${access.total} sections`}
              </p>
              {mod.gaps && (
                <p className="text-[10px] mt-1.5 leading-snug" style={{ color: 'rgba(245,158,11,0.85)' }}>
                  ⚠ {mod.gaps.length > 120 ? mod.gaps.slice(0, 120).trimEnd() + '…' : mod.gaps}
                </p>
              )}
            </Link>
          )
        })}
      </div>
    </section>
  )
}
