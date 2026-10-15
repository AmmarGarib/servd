'use client'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { usePermissions } from '../../../hooks/useCan'
import { useRoleModules, modulesForRole } from '../../../store/roleModules'
import { APP_ROLES, MODULES, type AppRole, type ModuleId } from '../../../lib/appRoles'
import { useViewAsRole } from '../../../store/viewAsRole'
import { useWorkspaceDefs } from '../../../hooks/useWorkspaces'

/**
 * Module Access editor — CEO / Admin only.
 *
 * One row per role, one column per top-level NAV section. The CEO toggles
 * which modules each role can see in the sidebar. Admin + CEO are pinned to
 * "all modules" and not editable from this page — that's the safety net.
 *
 * Live preview: tick a box and the sidebar updates immediately for anyone
 * currently impersonating that role. Click the role label to jump straight
 * into view-as mode and watch the change.
 *
 * Storage is currently client-side (localStorage via zustand). When you're
 * ready to enforce server-side, mirror the same shape to a `RoleModuleAccess`
 * Prisma model — the keys are stable.
 */
export default function RoleModulesPage() {
  const { data: me } = usePermissions()
  const overrides = useRoleModules((s) => s.overrides)
  // CEO-only modules (Brands, owner 2026-10-14): never granted to another
  // role — the server drops them from a save, so the cells are locked.
  const ceoOnly = useRoleModules((s) => s.ceoOnlyModules)
  const setRoleModules = useRoleModules((s) => s.setRoleModules)
  const resetRole = useRoleModules((s) => s.resetRole)
  const resetAll = useRoleModules((s) => s.resetAll)
  const setViewAs = useViewAsRole((s) => s.setRole)
  const isSuper = me?.role === 'admin'

  const [search, setSearch] = useState('')
  const [focusRole, setFocusRole] = useState<AppRole | null>(null)

  // Editable roles = everyone except the CEO (admin) — they're locked to all modules.
  const editableRoles = useMemo(() => APP_ROLES.filter((r) => r.value !== 'admin'), [])

  // Grouped by WORKSPACE (decision 47) as the API defines them — the admin
  // keeps no copy of which module sits where. Anything no workspace lists
  // (retired ids) falls into "Other".
  const { data: workspaceDefs } = useWorkspaceDefs()
  const sections = useMemo(() => {
    const home = new Map<string, string>()
    for (const w of workspaceDefs ?? []) for (const s of w.sections) for (const m of s.modules) if (!home.has(m)) home.set(m, w.title)
    const map = new Map<string, typeof MODULES>()
    for (const w of workspaceDefs ?? []) map.set(w.title, [])
    for (const m of MODULES) {
      if (search && !m.label.toLowerCase().includes(search.toLowerCase()) && !m.id.includes(search.toLowerCase())) continue
      const group = home.get(m.id) ?? 'Other'
      const arr = map.get(group) ?? []
      arr.push(m)
      map.set(group, arr)
    }
    return Array.from(map.entries()).filter(([, mods]) => mods.length > 0)
  }, [search, workspaceDefs])

  if (!isSuper) {
    return (
      <div className="min-h-screen p-7" style={{ background: 'var(--bg)' }}>
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <div className="mt-8 max-w-md mx-auto rounded-2xl p-8 text-center"
          style={{ background: 'rgba(255,77,79,0.05)', border: '1px solid rgba(255,77,79,0.2)' }}>
          <p className="text-3xl mb-3">🔒</p>
          <p className="font-bold text-white/85">CEO / Admin only</p>
          <p className="text-sm text-white/45 mt-1">Setting role module access is a superuser action.</p>
        </div>
      </div>
    )
  }

  function toggleModule(role: AppRole, mod: ModuleId) {
    if (ceoOnly.includes(mod)) return
    const current = new Set(modulesForRole(role, overrides))
    if (current.has(mod)) current.delete(mod); else current.add(mod)
    setRoleModules(role, Array.from(current))
  }

  function toggleSection(role: AppRole, sectionModuleIds: ModuleId[]) {
    sectionModuleIds = sectionModuleIds.filter((id) => !ceoOnly.includes(id))
    const current = new Set(modulesForRole(role, overrides))
    const allOn = sectionModuleIds.every((id) => current.has(id))
    if (allOn) {
      for (const id of sectionModuleIds) current.delete(id)
    } else {
      for (const id of sectionModuleIds) current.add(id)
    }
    setRoleModules(role, Array.from(current))
  }

  const focusedRoleMeta = focusRole ? APP_ROLES.find((r) => r.value === focusRole) : null
  const focusedRoleModules = focusRole ? new Set(modulesForRole(focusRole, overrides)) : null

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <div className="flex items-center gap-2 text-xs text-white/40 mb-2">
          <Link href="/configuration" className="hover:text-white/70">← Configuration Hub</Link>
        </div>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-black text-white/90">🗂 Module Access by Role</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              For each role, tick the modules that should appear in the sidebar. Admin + CEO always see everything — they&rsquo;re not editable. Tap a role label to switch into View-as mode and watch the sidebar reshape in real time.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { if (confirm('Reset every role back to its default module list? Custom overrides will be discarded.')) resetAll() }}
              className="rounded-xl border border-white/10 px-4 py-2.5 text-xs font-bold text-white/55 hover:text-white">
              ↺ Reset every role
            </button>
          </div>
        </div>
      </header>

      <div className="px-7 py-6 max-w-[1600px] mx-auto space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search modules — try 'menu', 'shift', 'crm'…"
            className="flex-1 min-w-[240px] rounded-xl px-4 py-2.5 text-sm focus:outline-none"
            style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.08)', color: 'rgb(var(--fg-rgb) / 0.85)' }}
          />

          <div className="text-xs text-white/45 flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: 'var(--erp-accent)' }} />
            allowed
            <span className="inline-block w-3 h-3 rounded-sm ml-3 border border-white/15" />
            hidden
            <span className="inline-block w-3 h-3 rounded-sm ml-3" style={{ background: 'var(--erp-warning)' }} />
            customised
          </div>
        </div>

        {/* Role focus chip strip — quick jump into impersonation */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider font-black text-white/35">Preview as:</span>
          {editableRoles.map((r) => (
            <button key={r.value} onClick={() => { setFocusRole(r.value); setViewAs(r.value) }}
              className="rounded-full px-2.5 py-1 text-[11px] font-bold transition-all"
              style={focusRole === r.value
                ? { background: 'var(--erp-accent-dim)', color: 'var(--text)', border: '1px solid var(--erp-accent)' }
                : { background: 'rgb(var(--fg-rgb) / 0.02)', color: 'rgb(var(--fg-rgb) / 0.45)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
              {r.emoji} {r.label}
            </button>
          ))}
          {focusRole && (
            <button onClick={() => { setFocusRole(null); setViewAs(null) }}
              className="rounded-full px-2.5 py-1 text-[11px] font-bold transition-all"
              style={{ background: 'rgba(255,77,79,0.08)', color: 'var(--erp-danger)', border: '1px solid rgba(255,77,79,0.18)' }}>
              Clear preview
            </button>
          )}
        </div>

        {/* Module grid */}
        <div className="rounded-2xl overflow-x-auto" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
          <table className="w-full text-sm border-collapse min-w-[1200px]">
            <thead>
              <tr style={{ background: 'var(--surface)' }}>
                <th className="text-left px-4 py-3 text-[10px] font-black uppercase tracking-[0.2em] text-white/45 sticky left-0"
                  style={{ background: 'var(--surface)', borderBottom: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                  Module
                </th>
                {editableRoles.map((r) => (
                  <th key={r.value} className="px-2 py-3 border-l border-white/[0.04]"
                    style={{ borderBottom: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                    <button onClick={() => { setFocusRole(r.value); setViewAs(r.value) }}
                      className="w-full text-center hover:opacity-100 transition-opacity"
                      style={{ opacity: focusRole === r.value ? 1 : 0.85 }}
                      title={r.description}>
                      <p className="text-base leading-none">{r.emoji}</p>
                      <p className="text-[9px] font-black uppercase tracking-wider text-white/65 mt-1">{r.label}</p>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sections.map(([sectionName, mods]) => {
                const modIds = mods.map((m) => m.id)
                return (
                  <>
                    <tr key={`section-${sectionName}`}>
                      <td colSpan={editableRoles.length + 1} className="px-4 py-2 border-y border-white/[0.04]"
                        style={{ background: 'rgb(var(--fg-rgb) / 0.015)' }}>
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/55">
                          {sectionName}
                        </p>
                      </td>
                    </tr>
                    {/* Quick-toggle row: per-role checkbox to bulk-toggle this whole section */}
                    <tr style={{ background: 'rgb(var(--fg-rgb) / 0.005)' }}>
                      <td className="px-4 py-1.5 text-[10px] text-white/45 italic sticky left-0"
                        style={{ background: 'var(--surface)' }}>
                        — toggle whole section —
                      </td>
                      {editableRoles.map((r) => {
                        const current = new Set(modulesForRole(r.value, overrides))
                        const allOn = modIds.every((id) => current.has(id))
                        const someOn = modIds.some((id) => current.has(id))
                        return (
                          <td key={`bulk-${sectionName}-${r.value}`}
                            className="px-2 py-1.5 text-center border-l border-white/[0.03]">
                            <button onClick={() => toggleSection(r.value, modIds)}
                              className="h-4 w-4 rounded-sm mx-auto flex items-center justify-center transition-all"
                              style={allOn
                                ? { background: 'var(--erp-accent)', color: 'var(--erp-on-accent)' }
                                : someOn
                                  ? { background: 'rgba(245,158,11,0.7)', color: 'var(--erp-on-primary)' }
                                  : { background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.1)' }}>
                              {allOn ? '✓' : someOn ? '−' : ''}
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                    {mods.map((m) => (
                      <tr key={m.id} className="hover:bg-white/[0.015] transition-colors">
                        <td className="px-4 py-2 sticky left-0"
                          style={{ background: 'var(--surface)', borderRight: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
                          <p className="text-xs font-bold text-white/85">{m.label}</p>
                          <p className="text-[10px] text-white/30 font-mono mt-0.5">{m.id}</p>
                        </td>
                        {editableRoles.map((r) => {
                          const effective = modulesForRole(r.value, overrides)
                          const enabled = effective.includes(m.id)
                          const isCustom = overrides[r.value] !== undefined
                          const locked = ceoOnly.includes(m.id)
                          if (locked) {
                            return (
                              <td key={`${m.id}-${r.value}`}
                                className="px-2 py-2 text-center border-l border-white/[0.03] text-[9px] text-white/35"
                                title="CEO only — no other role can be given this module">
                                CEO
                              </td>
                            )
                          }
                          return (
                            <td key={`${m.id}-${r.value}`}
                              className="px-2 py-2 text-center border-l border-white/[0.03]">
                              <button onClick={() => toggleModule(r.value, m.id)}
                                className="h-5 w-5 rounded-sm mx-auto flex items-center justify-center text-[10px] font-black transition-all hover:scale-110"
                                style={enabled
                                  ? (isCustom ? { background: 'var(--erp-warning)', color: 'var(--erp-on-primary)' } : { background: 'var(--erp-accent)', color: 'var(--erp-on-accent)' })
                                  : { background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.1)', color: 'transparent' }}
                                title={enabled ? 'Allowed — click to hide' : 'Hidden — click to allow'}>
                                {enabled ? '✓' : ''}
                              </button>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Per-role reset row */}
        <div className="flex items-center gap-2 flex-wrap text-[11px]">
          <span className="text-white/35">Reset a single role to defaults:</span>
          {editableRoles.map((r) => {
            const isCustom = overrides[r.value] !== undefined
            return (
              <button key={r.value} onClick={() => resetRole(r.value)} disabled={!isCustom}
                className="rounded-md px-2 py-1 text-[11px] font-semibold transition-colors disabled:opacity-25"
                style={isCustom
                  ? { background: 'rgba(245,158,11,0.1)', color: 'var(--erp-warning)', border: '1px solid rgba(245,158,11,0.25)' }
                  : { background: 'rgb(var(--fg-rgb) / 0.02)', color: 'rgb(var(--fg-rgb) / 0.35)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
                {r.emoji} {r.label}
              </button>
            )
          })}
        </div>

        {/* Helper card */}
        <div className="rounded-xl p-4 text-xs text-white/45 leading-relaxed"
          style={{ background: 'rgb(var(--ink-rgb) / 0.05)', border: '1px solid rgb(var(--ink-rgb) / 0.15)' }}>
          💡 <strong>How this works:</strong> when an operator logs in with role <em>cashier</em>, their sidebar is filtered to the modules ticked under the Cashier column. The CEO is the only one who can change this map — non-admin sessions can&rsquo;t open this page. Amber ticks indicate a role you&rsquo;ve customised; green ticks are still on defaults. Actions that need sign-off (refunds, voids, comps) ask for a manager PIN at the till; there is no separate per-action matrix.
        </div>

        {focusedRoleMeta && focusedRoleModules && (
          <div className="fixed bottom-4 right-4 rounded-2xl p-4 max-w-sm shadow-2xl"
            style={{ background: 'var(--surface)', border: '1px solid rgb(var(--erp-accent-rgb) / 0.6)' }}>
            <p className="text-[10px] uppercase tracking-wider font-black mb-1" style={{ color: 'var(--erp-success)' }}>
              🔭 Previewing as
            </p>
            <p className="text-sm font-bold text-white/90">{focusedRoleMeta.emoji} {focusedRoleMeta.label}</p>
            <p className="text-[11px] text-white/45 mt-0.5">{focusedRoleMeta.description}</p>
            <p className="text-[11px] text-white/55 mt-2">{focusedRoleModules.size} of {MODULES.length} modules visible</p>
          </div>
        )}
      </div>
    </div>
  )
}
