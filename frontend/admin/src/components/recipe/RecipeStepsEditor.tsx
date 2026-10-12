'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'

/**
 * Recipe step editor — phase tabs, station picker, dependency picker, duration.
 *
 * Mount this inside the recipe modal when editing an existing recipe (steps
 * need a recipeId to attach to). The CEO can build a step graph like:
 *
 *   Phase: service_cook
 *     1. Sear steak       station=Grill        deps=[]            120s
 *     2. Boil rice        station=Rice         deps=[step 1]      180s
 *   Phase: service_assemble
 *     3. Plate            station=Pass         deps=[step 1, 2]    30s
 *
 * The expo-fire engine reads this graph: on Confirm & Fire, steps with empty
 * `deps` go to `preparing` immediately and broadcast to their station's KDS;
 * downstream steps stay `waiting` until their deps clear via the cascade.
 */

const PHASES = [
  { id: 'prep_mep',         label: 'Mise en place',  emoji: '🥗', desc: 'Pre-service dice/portion/sauces' },
  { id: 'prep_mop',         label: 'Prep MOP',       emoji: '🧪', desc: 'Pre-service marinades, par-bakes, sous-vide' },
  { id: 'service_cook',     label: 'Service cook',   emoji: '🔥', desc: 'Hot-line cook during service' },
  { id: 'service_assemble', label: 'Plate & finish', emoji: '🍽',  desc: 'Final assembly / box / garnish' },
] as const

type Phase = typeof PHASES[number]['id']

interface RecipeStep {
  id:              string
  phase:           Phase
  ordinal:         number
  stationId:       string | null
  station?:        { id: string; name: string } | null
  instruction:     string
  instructionUrdu: string | null
  estimatedSeconds: number
  dependsOnIds:    string[]
  createdAt:       string
}

interface Station {
  id: string
  name: string
  concept?: { id: string; slug: string; name: string } | null
}

export function RecipeStepsEditor({ recipeId }: { recipeId: string }) {
  const qc = useQueryClient()
  const [activePhase, setActivePhase] = useState<Phase>('service_cook')
  const [drafting, setDrafting] = useState<null | Partial<RecipeStep>>(null)

  const { data: steps = [], isLoading } = useQuery<RecipeStep[]>({
    queryKey: ['recipe', recipeId, 'steps'],
    queryFn:  () => api.get<RecipeStep[]>(`/recipes/${recipeId}/steps`),
    enabled:  !!recipeId,
  })

  const { data: stations = [] } = useQuery<Station[]>({
    queryKey: ['stations'],
    queryFn:  () => api.get<Station[]>('/kds/stations'),
  })

  const create = useMutation({
    mutationFn: (body: Partial<RecipeStep>) => api.post(`/recipes/${recipeId}/steps`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['recipe', recipeId, 'steps'] }); setDrafting(null) },
  })
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<RecipeStep> }) =>
      api.patch(`/recipes/steps/${id}`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['recipe', recipeId, 'steps'] }); setDrafting(null) },
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/recipes/steps/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recipe', recipeId, 'steps'] }),
  })

  function startNew() {
    setDrafting({
      phase: activePhase,
      ordinal: (steps.filter((s) => s.phase === activePhase).at(-1)?.ordinal ?? 0) + 10,
      stationId: null,
      instruction: '',
      estimatedSeconds: 60,
      dependsOnIds: [],
    })
  }

  function startEdit(step: RecipeStep) {
    setDrafting({ ...step })
  }

  function saveDraft() {
    if (!drafting) return
    const body = {
      phase: drafting.phase!,
      ordinal: drafting.ordinal ?? 0,
      stationId: drafting.stationId ?? null,
      instruction: drafting.instruction ?? '',
      instructionUrdu: drafting.instructionUrdu ?? null,
      estimatedSeconds: drafting.estimatedSeconds ?? 60,
      dependsOnIds: drafting.dependsOnIds ?? [],
    }
    if (drafting.id) update.mutate({ id: drafting.id, body })
    else create.mutate(body)
  }

  // Steps in the active phase, sorted.
  const phaseSteps = steps.filter((s) => s.phase === activePhase).sort((a, b) => a.ordinal - b.ordinal)
  // All steps available as dependency candidates for the current draft —
  // we restrict to steps in the same or earlier phase to keep the graph
  // intuitive; the backend allows any in-recipe dep.
  const PHASE_ORDER: Phase[] = ['prep_mep', 'prep_mop', 'service_cook', 'service_assemble']
  const draftPhaseIdx = drafting?.phase ? PHASE_ORDER.indexOf(drafting.phase) : 0
  const depCandidates = steps.filter((s) =>
    s.id !== drafting?.id && PHASE_ORDER.indexOf(s.phase) <= draftPhaseIdx,
  )

  return (
    <div className="rounded-xl border" style={{ borderColor: 'rgb(var(--fg-rgb) / 0.06)', background: 'rgb(var(--fg-rgb) / 0.015)' }}>

      {/* Phase tabs */}
      <div className="flex gap-1 p-2 border-b" style={{ borderColor: 'rgb(var(--fg-rgb) / 0.06)' }}>
        {PHASES.map((p) => {
          const active = p.id === activePhase
          const count = steps.filter((s) => s.phase === p.id).length
          return (
            <button key={p.id} onClick={() => setActivePhase(p.id)}
              className="flex-1 rounded-lg px-3 py-2 text-xs font-bold transition-colors"
              style={active
                ? { background: 'rgb(var(--erp-primary-rgb) / 0.12)', color: 'var(--erp-primary-ink)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.3)' }
                : { background: 'transparent', color: 'rgb(var(--fg-rgb) / 0.5)', border: '1px solid transparent' }}>
              <span className="mr-1">{p.emoji}</span>
              {p.label}
              {count > 0 && <span className="ml-1.5 text-[10px] opacity-70">({count})</span>}
            </button>
          )
        })}
      </div>

      {/* Phase description */}
      <p className="text-[11px] text-white/40 px-4 pt-3 italic">
        {PHASES.find((p) => p.id === activePhase)?.desc}
      </p>

      {/* Step rows */}
      <div className="p-4 space-y-2">
        {isLoading && <p className="text-xs text-white/40">Loading…</p>}

        {!isLoading && phaseSteps.length === 0 && !drafting && (
          <div className="rounded-lg p-6 text-center"
            style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px dashed rgb(var(--fg-rgb) / 0.1)' }}>
            <p className="text-xs text-white/45">No steps in this phase yet.</p>
          </div>
        )}

        {phaseSteps.map((s) => {
          const station = stations.find((st) => st.id === s.stationId)
          const isEditingThis = drafting?.id === s.id
          if (isEditingThis) return <StepForm key={s.id} draft={drafting!} setDraft={setDrafting} stations={stations}
            depCandidates={depCandidates} onSave={saveDraft} onCancel={() => setDrafting(null)} saving={update.isPending} />
          return (
            <div key={s.id} className="rounded-lg p-3 flex items-baseline gap-3 group"
              style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
              <span className="text-[10px] font-black tabular-nums shrink-0 rounded px-1.5 py-0.5"
                style={{ background: 'rgb(var(--ink-rgb) / 0.12)', color: 'var(--erp-primary-ink)' }}>{s.ordinal}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white/90 leading-snug">{s.instruction}</p>
                <div className="flex items-center gap-2 mt-1 flex-wrap text-[10px]">
                  <span style={{ color: 'var(--erp-primary-ink)' }}>📍 {station?.name ?? 'No station'}</span>
                  <span className="text-white/40">⏱ {s.estimatedSeconds}s</span>
                  {s.dependsOnIds.length > 0 && (
                    <span className="text-white/40">
                      ↓ depends on {s.dependsOnIds.length} step{s.dependsOnIds.length === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
              </div>
              <div className="opacity-0 group-hover:opacity-100 transition-opacity flex gap-1 shrink-0">
                <button onClick={() => startEdit(s)} className="text-[10px] px-2 py-1 rounded font-bold"
                  style={{ background: 'rgb(var(--fg-rgb) / 0.05)', color: 'rgb(var(--fg-rgb) / 0.7)' }}>
                  Edit
                </button>
                <button onClick={() => { if (confirm('Delete this step?')) remove.mutate(s.id) }}
                  className="text-[10px] px-2 py-1 rounded font-bold"
                  style={{ background: 'rgba(255,77,79,0.08)', color: '#b42318' }}>
                  Delete
                </button>
              </div>
            </div>
          )
        })}

        {drafting && !drafting.id && (
          <StepForm draft={drafting} setDraft={setDrafting} stations={stations}
            depCandidates={depCandidates} onSave={saveDraft} onCancel={() => setDrafting(null)} saving={create.isPending} />
        )}

        {!drafting && (
          <button onClick={startNew}
            className="w-full rounded-lg py-2.5 text-xs font-bold transition-colors mt-1"
            style={{ background: 'rgb(var(--erp-primary-rgb) / 0.06)', color: 'var(--erp-primary-ink)', border: '1px dashed rgb(var(--erp-primary-rgb) / 0.25)' }}>
            + Add step
          </button>
        )}
      </div>

      {(create.error || update.error || remove.error) && (
        <p className="px-4 pb-3 text-xs text-red-700">
          {(create.error || update.error || remove.error)?.message}
        </p>
      )}
    </div>
  )
}

// Inline form — used for both create and edit. Kept here so the editor file
// is one drop-in component.
function StepForm({ draft, setDraft, stations, depCandidates, onSave, onCancel, saving }: {
  draft:    Partial<RecipeStep>
  setDraft: (d: Partial<RecipeStep>) => void
  stations: Station[]
  depCandidates: RecipeStep[]
  onSave:   () => void
  onCancel: () => void
  saving:   boolean
}) {
  const deps = draft.dependsOnIds ?? []
  function toggleDep(id: string) {
    setDraft({ ...draft, dependsOnIds: deps.includes(id) ? deps.filter((x) => x !== id) : [...deps, id] })
  }
  return (
    <div className="rounded-lg p-3 space-y-2"
      style={{ background: 'rgb(var(--erp-primary-rgb) / 0.04)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.2)' }}>
      <div className="space-y-1">
        <label className="block text-[9px] uppercase tracking-wider font-black text-white/45">Step instruction (English)</label>
        <textarea value={draft.instruction ?? ''} onChange={(e) => setDraft({ ...draft, instruction: e.target.value })}
          rows={2} placeholder="e.g. 'Sear steak medium rare on grill, 90s/side'"
          className="w-full rounded-md px-3 py-2 text-sm focus:outline-none resize-none"
          style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)', color: 'rgb(var(--fg-rgb) / 0.92)' }} />
      </div>

      {/* Urdu instruction — backend schema supports per-step Urdu so a
          line cook on Urdu mode sees their step text in Urdu. Optional;
          falls back to the English instruction when blank. */}
      <div className="space-y-1">
        <label className="block text-[9px] uppercase tracking-wider font-black text-white/45">
          ہدایت — Step instruction (اردو, optional)
        </label>
        <textarea value={draft.instructionUrdu ?? ''} onChange={(e) => setDraft({ ...draft, instructionUrdu: e.target.value })}
          rows={2} dir="rtl" placeholder="مثلاً: گرل پر سٹیک ۹۰ سیکنڈ فی طرف بھونیں"
          className="w-full rounded-md px-3 py-2 text-sm focus:outline-none resize-none"
          style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)', color: 'rgb(var(--fg-rgb) / 0.92)', fontFamily: 'sans-serif' }} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[9px] uppercase tracking-wider font-black text-white/45 mb-1">Station</label>
          <select value={draft.stationId ?? ''} onChange={(e) => setDraft({ ...draft, stationId: e.target.value || null })}
            className="w-full rounded-md px-2.5 py-1.5 text-xs font-semibold cursor-pointer focus:outline-none"
            style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)', color: 'rgb(var(--fg-rgb) / 0.85)' }}>
            <option value="">— pick a station —</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>{s.name}{s.concept?.slug ? ` (${s.concept.slug})` : ''}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[9px] uppercase tracking-wider font-black text-white/45 mb-1">Duration (sec)</label>
          <input type="number" min={0} value={draft.estimatedSeconds ?? 60}
            onChange={(e) => setDraft({ ...draft, estimatedSeconds: parseInt(e.target.value) || 0 })}
            className="w-full rounded-md px-2.5 py-1.5 text-xs font-semibold focus:outline-none"
            style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)', color: 'rgb(var(--fg-rgb) / 0.85)' }} />
        </div>
      </div>

      {depCandidates.length > 0 && (
        <div>
          <label className="block text-[9px] uppercase tracking-wider font-black text-white/45 mb-1">
            Depends on (must complete first)
          </label>
          <div className="flex flex-wrap gap-1">
            {depCandidates.map((c) => {
              const on = deps.includes(c.id)
              return (
                <button key={c.id} type="button" onClick={() => toggleDep(c.id)}
                  className="text-[10px] rounded-full px-2 py-1 font-semibold transition-colors max-w-[260px] truncate"
                  style={on
                    ? { background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }
                    : { background: 'rgb(var(--fg-rgb) / 0.05)', color: 'rgb(var(--fg-rgb) / 0.7)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}
                  title={c.instruction}>
                  {on ? '✓ ' : '+ '}{c.instruction.slice(0, 36)}{c.instruction.length > 36 ? '…' : ''}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-xs font-bold"
          style={{ background: 'rgb(var(--fg-rgb) / 0.05)', color: 'rgb(var(--fg-rgb) / 0.6)' }}>
          Cancel
        </button>
        <button onClick={onSave} disabled={saving || !draft.instruction?.trim()}
          className="flex-1 rounded-md py-1.5 text-xs font-black transition-all disabled:opacity-40"
          style={{ background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }}>
          {saving ? 'Saving…' : draft.id ? 'Save changes' : 'Add step'}
        </button>
      </div>
    </div>
  )
}
