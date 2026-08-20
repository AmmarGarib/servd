'use client'
// A single module's contents.
//
// Three renderings, driven entirely by derived access:
//   full     — every section
//   partial  — ONLY the sections you hold, with a quiet note that more exists
//   locked   — no sections at all; what the module covers and who to ask
//
// Withheld sections are never listed by name on a locked module: knowing the
// exact shape of what you can't reach isn't useful, and the hub card already
// tells you the module exists and how big it is.

import Link from 'next/link'
import { useMemo } from 'react'
import { useParams } from 'next/navigation'
import { usePermissions } from '../../../hooks/useCan'
import { useRoleModules, modulesForRole } from '../../../store/roleModules'
import { roleLabel, type AppRole, type ModuleId } from '../../../lib/appRoles'
import { findModule, moduleAccessFor } from '../../../lib/moduleCatalog'

export default function ModuleDetailPage() {
  const params = useParams<{ id: string }>()
  const { data: me } = usePermissions()
  const overrides = useRoleModules((s) => s.overrides)
  const mod = findModule(params?.id ?? '')

  const allowed = useMemo<Set<ModuleId> | null>(() => {
    if (!me) return new Set<ModuleId>()
    if (me.role === 'admin') return null
    return new Set(modulesForRole((me.role ?? 'cashier') as AppRole, overrides))
  }, [me, overrides])

  if (!mod) {
    return (
      <Shell>
        <p className="text-sm text-s-muted">No such module.</p>
      </Shell>
    )
  }

  const access = moduleAccessFor(mod, allowed)
  const withheld = access.total - access.visible.length

  return (
    <Shell>
      <div className="flex items-start gap-3">
        <span className="text-3xl leading-none" aria-hidden>
          {access.state === 'locked' ? '🔒' : mod.icon}
        </span>
        <div>
          <h1 className="text-2xl font-black text-s-text">{mod.name}</h1>
          <p className="text-sm text-s-muted mt-0.5">{mod.blurb}</p>
        </div>
      </div>

      {access.state === 'locked' ? (
        <div
          className="mt-6 rounded-2xl p-6"
          style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          <h2 className="text-sm font-bold text-s-text">Module locked</h2>
          <p className="text-sm text-s-muted mt-1.5 max-w-xl leading-relaxed">
            Your role{me?.role ? ` (${roleLabel(me.role)})` : ''} doesn&apos;t include any part of{' '}
            {mod.name}. It covers {access.total} section
            {access.total === 1 ? '' : 's'} — ask the CEO if you need it opened up.
          </p>
          <Link
            href="/modules"
            className="inline-block mt-4 text-xs font-bold text-s-teal hover:underline"
          >
            ← Back to modules
          </Link>
        </div>
      ) : (
        <>
          <div className="mt-6 grid gap-2 sm:grid-cols-2">
            {access.visible.map((s) => (
              <Link
                key={s.href}
                href={s.href}
                className="rounded-xl px-4 py-3 transition-colors block"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
              >
                <span className="text-sm font-semibold text-s-text">{s.label}</span>
                {s.hint && <p className="text-[11px] text-s-dim mt-0.5">{s.hint}</p>}
              </Link>
            ))}
          </div>

          {withheld > 0 && (
            <p className="text-[11px] text-s-dim mt-4">
              {withheld} further section{withheld === 1 ? '' : 's'} in this module{' '}
              {withheld === 1 ? 'is' : 'are'} not available to your role.
            </p>
          )}
        </>
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-s-bg">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <Link href="/modules" className="text-xs text-s-muted hover:text-s-text">
          ← All modules
        </Link>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  )
}
