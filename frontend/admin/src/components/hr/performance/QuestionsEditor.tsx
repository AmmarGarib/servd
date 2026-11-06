'use client'
// Editable list of prompts per performance area (add / remove). An area with no prompts gets one plain rating.

import { bpOf, inputCls, type PerfArea, type PromptMap } from './shared'

export function QuestionsEditor({ areas, value, onChange, disabled }: { areas: PerfArea[]; value: PromptMap; onChange: (v: PromptMap) => void; disabled?: boolean }) {
  const set = (key: string, list: string[]) => onChange({ ...value, [key]: list })
  return (
    <div className="space-y-3">
      {areas.map((a) => {
        const list = value[a.key] ?? []
        return (
          <div key={a.key} className="rounded-xl p-3" style={{ border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
            <p className="text-sm font-black text-white/90">{a.label} <span className="text-white/55 font-bold">· {bpOf(a.weightBp)}</span></p>
            {list.length === 0 && <p className="text-xs text-white/55 mt-1">No questions — the employee gives one rating for this area.</p>}
            <div className="space-y-2 mt-2">
              {list.map((t, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <textarea className={`${inputCls} min-h-[44px]`} rows={2} disabled={disabled} aria-label={`${a.label} question ${i + 1}`} value={t}
                    onChange={(e) => set(a.key, list.map((x, j) => (j === i ? e.target.value : x)))} />
                  <button type="button" disabled={disabled} className="shrink-0 min-h-[44px] px-3 rounded-lg text-xs font-bold border border-white/10 text-white/70 hover:text-white" aria-label={`Remove ${a.label} question ${i + 1}`}
                    onClick={() => set(a.key, list.filter((_, j) => j !== i))}>Remove</button>
                </div>
              ))}
            </div>
            <button type="button" disabled={disabled} className="mt-2 text-xs font-bold text-primary-ink underline min-h-[32px]" onClick={() => set(a.key, [...list, ''])}>+ Add a question</button>
          </div>
        )
      })}
    </div>
  )
}

/** Drop blank prompts before sending. */
export const trimPrompts = (m: PromptMap): PromptMap => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.map((s) => s.trim()).filter(Boolean)]))
