'use client'
// "What they can open" — the CEO's per-person module ticks (owner, 2026-10-15:
// "I click on a person's name and select the modules they are allowed to
// access, but a base case can be preset for roles").
//
// GET / PUT /permissions/users/:id/modules (CEO only). The role preset is the
// base case (Configuration → Role presets); the server stores this person's
// ticks as the difference from it. Grouping comes from the server
// (lib/workspaces.ts); labels from lib/appRoles MODULES — no copy here.
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { MODULES } from '../../lib/appRoles'

interface PersonModulesView {
  id: string
  name: string
  role: string
  locked: boolean
  rolePreset: string[]
  effective: string[]
  allow: string[]
  deny: string[]
  modules: Array<{ id: string; workspace: string; workspaceTitle: string; section: string; sectionTitle: string; ceoOnly: boolean }>
}

const LABEL = new Map(MODULES.map((m) => [m.id as string, m.label]))

export function PersonModules({ userId }: { userId: string }) {
  const qc = useQueryClient()
  const key = ['person-modules', userId]
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<PersonModulesView>(`/permissions/users/${userId}/modules`), retry: false })
  const [ticks, setTicks] = useState<Set<string>>(new Set())
  const [err, setErr] = useState('')
  useEffect(() => { if (data) setTicks(new Set(data.effective)) }, [data])

  const preset = useMemo(() => new Set(data?.rolePreset ?? []), [data])
  const groups = useMemo(() => {
    const out: Array<{ title: string; sections: Array<{ title: string; modules: PersonModulesView['modules'] }> }> = []
    for (const m of data?.modules ?? []) {
      let g = out.find((x) => x.title === m.workspaceTitle)
      if (!g) { g = { title: m.workspaceTitle, sections: [] }; out.push(g) }
      let s = g.sections.find((x) => x.title === m.sectionTitle)
      if (!s) { s = { title: m.sectionTitle, modules: [] }; g.sections.push(s) }
      s.modules.push(m)
    }
    return out
  }, [data])

  const save = useMutation({
    mutationFn: (modules: string[] | null) => api.put<PersonModulesView>(`/permissions/users/${userId}/modules`, { modules }),
    onSuccess: (r) => { setErr(''); qc.setQueryData(key, r) },
    onError: (e: Error) => setErr(e.message),
  })

  if (isLoading) return <p className="text-xs text-s-muted">Loading what they can open…</p>
  if (error) return <p className="text-xs text-s-muted">{(error as Error).message}</p>
  if (!data) return null
  if (data.locked) return <p className="text-xs text-s-muted">The CEO always has every module — this cannot be changed per person.</p>

  const changed = data.modules.filter((m) => !m.ceoOnly && ticks.has(m.id) !== preset.has(m.id)).length
  const dirty = data.modules.some((m) => ticks.has(m.id) !== data.effective.includes(m.id))
  const toggle = (id: string) => setTicks((t) => { const n = new Set(t); if (n.has(id)) n.delete(id); else n.add(id); return n })

  return (
    <div className="space-y-3">
      <p className="text-xs text-s-muted">
        Ticked from the role preset for {data.role.replace(/_/g, ' ')}; change the ticks for this person only.
        {changed > 0 ? ` ${changed} different from the preset.` : ' Same as the role preset.'}
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {groups.map((g) => (
          <div key={g.title} className="rounded-lg border border-s-border p-3">
            <p className="text-[11px] font-black uppercase tracking-wider text-s-text mb-2">{g.title}</p>
            {g.sections.map((s) => (
              <div key={s.title} className="mb-2 last:mb-0">
                <p className="text-[10px] font-bold uppercase tracking-wider text-s-muted mb-1">{s.title}</p>
                {s.modules.map((m) => {
                  const on = ticks.has(m.id)
                  const differs = !m.ceoOnly && on !== preset.has(m.id)
                  return (
                    <label key={m.id} className={`flex items-center gap-2 py-0.5 text-xs ${m.ceoOnly ? 'opacity-50' : 'cursor-pointer'}`}
                      title={m.ceoOnly ? 'CEO only — never given to anyone else' : undefined}>
                      <input type="checkbox" checked={on && !m.ceoOnly} disabled={m.ceoOnly} onChange={() => toggle(m.id)}
                        style={{ accentColor: 'var(--erp-success)' }} />
                      <span className="flex-1">{LABEL.get(m.id) ?? m.id}</span>
                      {differs && (
                        <span className="text-[9px] font-bold uppercase tracking-wider rounded px-1 py-0.5"
                          style={{ color: 'var(--erp-primary)', background: 'rgb(var(--erp-primary-rgb) / 0.1)' }}
                          title={on ? 'Added for this person (not in the role preset)' : 'Removed for this person (in the role preset)'}>
                          {on ? 'added' : 'removed'}
                        </span>
                      )}
                    </label>
                  )
                })}
              </div>
            ))}
          </div>
        ))}
      </div>
      {err && <p className="text-xs" style={{ color: 'var(--erp-danger)' }}>{err}</p>}
      <div className="flex gap-2">
        <button type="button" className="s-btn-primary" disabled={!dirty || save.isPending}
          onClick={() => save.mutate(Array.from(ticks))}>{save.isPending ? 'Saving…' : 'Save what they can open'}</button>
        <button type="button" className="s-btn-secondary" disabled={save.isPending || (data.allow.length === 0 && data.deny.length === 0)}
          onClick={() => save.mutate(null)}>Back to role preset</button>
      </div>
    </div>
  )
}
