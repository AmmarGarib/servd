'use client'
// Versioned test-cook log for a recipe under iteration. Two modes:
//
//   • Saved recipe (recipeId set) — lists past attempts (newest first) and
//     posts new ones straight to GET/POST /recipes/:id/test-attempts.
//   • New recipe (no recipeId; drafts + onDraftsChange set) — the recipe has
//     no id yet, so attempts are buffered locally and the form persists them
//     immediately after the recipe itself is created.
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'

type Outcome = 'promising' | 'needs_work' | 'rejected'

export interface DraftAttempt {
  notes: string
  outcome: Outcome | ''
  rating: number | ''
}

interface TestAttempt {
  id: string
  version: number
  notes: string
  outcome: Outcome | null
  rating: number | null
  testedByName: string | null
  createdAt: string
}

const OUTCOME_META: Record<Outcome, { label: string; color: string; bg: string }> = {
  promising:  { label: 'Promising',  color: '#3f7d20', bg: 'rgb(135 197 64 / 0.12)' },
  needs_work: { label: 'Needs work', color: '#a15c00', bg: 'rgba(245,158,11,0.12)' },
  rejected:   { label: 'Rejected',   color: '#b42318', bg: 'rgba(255,77,79,0.12)' },
}

export function RecipeTestLog({ recipeId, drafts, onDraftsChange }: {
  recipeId?: string
  drafts?: DraftAttempt[]
  onDraftsChange?: (d: DraftAttempt[]) => void
}) {
  const qc = useQueryClient()
  const [notes, setNotes]     = useState('')
  const [outcome, setOutcome] = useState<'' | Outcome>('')
  const [rating, setRating]   = useState<'' | number>('')
  const [err, setErr]         = useState('')
  const isDraftMode = !recipeId

  const { data: attempts = [], isLoading } = useQuery<TestAttempt[]>({
    queryKey: ['recipe', recipeId, 'test-attempts'],
    queryFn: () => api.get(`/recipes/${recipeId}/test-attempts`),
    enabled: !!recipeId,
  })

  const add = useMutation({
    mutationFn: () => api.post(`/recipes/${recipeId}/test-attempts`, {
      notes: notes.trim(),
      ...(outcome ? { outcome } : {}),
      ...(rating ? { rating: Number(rating) } : {}),
    }),
    onSuccess: () => {
      setNotes(''); setOutcome(''); setRating(''); setErr('')
      void qc.invalidateQueries({ queryKey: ['recipe', recipeId, 'test-attempts'] })
    },
    onError: (e: Error) => setErr(e.message),
  })

  function submit() {
    if (!notes.trim()) { setErr('Add a note describing the test.'); return }
    if (isDraftMode) {
      onDraftsChange?.([...(drafts ?? []), { notes: notes.trim(), outcome, rating }])
      setNotes(''); setOutcome(''); setRating(''); setErr('')
      return
    }
    add.mutate()
  }

  return (
    <section className="rounded-xl border border-s-border bg-s-surface p-5">
      <h2 className="text-base font-black">Test log</h2>
      <p className="text-[11px] text-s-muted mt-0.5 mb-3">
        {isDraftMode
          ? 'Log your first test cook(s) now — they save with the recipe. Versions are numbered automatically.'
          : 'Record each test cook as you iterate. Versions are numbered automatically.'}
      </p>

      {/* Add a new attempt */}
      <div className="rounded-lg border border-s-border p-3 space-y-2">
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
          placeholder="What you changed and how it came out — e.g. 'Cut salt 10%, char 30s longer. Better crust, still dry.'"
          className="s-input w-full text-sm resize-none" />
        <div className="flex items-center gap-2 flex-wrap">
          <select value={outcome} onChange={(e) => setOutcome(e.target.value as '' | Outcome)} className="s-select text-xs">
            <option value="">Outcome…</option>
            <option value="promising">Promising</option>
            <option value="needs_work">Needs work</option>
            <option value="rejected">Rejected</option>
          </select>
          <select value={rating} onChange={(e) => setRating(e.target.value ? Number(e.target.value) : '')} className="s-select text-xs">
            <option value="">Rating…</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{'★'.repeat(n)} ({n})</option>)}
          </select>
          <button type="button" onClick={submit} disabled={add.isPending}
            className="ml-auto rounded-lg bg-primary text-primary-on px-3 py-1.5 text-xs font-black hover:opacity-90 disabled:opacity-50">
            {add.isPending ? 'Logging…' : 'Log attempt'}
          </button>
        </div>
        {err && <p className="text-[11px] text-red-700">{err}</p>}
      </div>

      {/* History */}
      <div className="mt-3 space-y-2">
        {isDraftMode ? (
          (drafts ?? []).length === 0 ? (
            <p className="text-xs text-s-dim">No test attempts logged yet.</p>
          ) : (
            (drafts ?? []).map((d, i) => (
              <div key={i} className="rounded-lg border border-s-border p-3">
                <div className="flex items-center gap-2 flex-wrap text-[11px]">
                  <span className="font-black text-s-text">v{i + 1}</span>
                  {d.outcome && (
                    <span className="font-black uppercase tracking-wider rounded-full px-2 py-0.5"
                      style={{ background: OUTCOME_META[d.outcome].bg, color: OUTCOME_META[d.outcome].color }}>
                      {OUTCOME_META[d.outcome].label}
                    </span>
                  )}
                  {d.rating !== '' && <span style={{ color: '#a15c00' }}>{'★'.repeat(Number(d.rating))}</span>}
                  <span className="text-s-dim ml-auto">saves with recipe</span>
                  <button type="button" title="Remove"
                    onClick={() => onDraftsChange?.((drafts ?? []).filter((_, j) => j !== i))}
                    className="text-red-700 hover:bg-red-400/10 rounded px-1.5">×</button>
                </div>
                <p className="mt-1 text-xs text-s-muted whitespace-pre-wrap">{d.notes}</p>
              </div>
            ))
          )
        ) : isLoading ? (
          <p className="text-xs text-s-muted">Loading…</p>
        ) : attempts.length === 0 ? (
          <p className="text-xs text-s-dim">No test attempts logged yet.</p>
        ) : (
          attempts.map((a) => (
            <div key={a.id} className="rounded-lg border border-s-border p-3">
              <div className="flex items-center gap-2 flex-wrap text-[11px]">
                <span className="font-black text-s-text">v{a.version}</span>
                {a.outcome && (
                  <span className="font-black uppercase tracking-wider rounded-full px-2 py-0.5"
                    style={{ background: OUTCOME_META[a.outcome].bg, color: OUTCOME_META[a.outcome].color }}>
                    {OUTCOME_META[a.outcome].label}
                  </span>
                )}
                {a.rating != null && <span style={{ color: '#a15c00' }}>{'★'.repeat(a.rating)}</span>}
                <span className="text-s-dim ml-auto">
                  {a.testedByName ?? 'Unknown'} · {new Date(a.createdAt).toLocaleDateString()}
                </span>
              </div>
              <p className="mt-1 text-xs text-s-muted whitespace-pre-wrap">{a.notes}</p>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
