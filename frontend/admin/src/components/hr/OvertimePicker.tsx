'use client'
// Overtime is opt-in (owner, 2026-10-21: "give an option to HR to add OT in
// final payroll at time of payroll, other wise it should not include in
// payroll"). Approved, unpaid overtime is listed here; it is paid only once HR
// ticks it and saves. Used by a draft payslip and a draft full & final.

import { useState } from 'react'
import { btn, btnGhost, rs, day } from '../../lib/hr'

/** One approved OT record that may be added (backend hr/service.ts OtAvailable). */
export interface OtAvailable { recordId: string; date: string | null; hours: number; amountCents: number }

const hoursText = (h: number) => `${Math.round(h * 100) / 100} h`

export function otAvailableOf(v: unknown): OtAvailable[] {
  return Array.isArray(v) ? (v as OtAvailable[]).filter((a) => a && typeof a.recordId === 'string') : []
}

/** "Overtime available: 6 h (Rs 3,000)" — what is not added yet. */
export function otSummary(available: OtAvailable[], selected: string[]): { hours: number; cents: number; count: number } {
  const left = available.filter((a) => !selected.includes(a.recordId))
  return { hours: left.reduce((s, a) => s + a.hours, 0), cents: left.reduce((s, a) => s + a.amountCents, 0), count: left.length }
}

export function OvertimePicker({ available, selected, editable, pending, onSave }: {
  available: OtAvailable[]
  selected: string[]
  /** A draft: HR may add or remove. */
  editable: boolean
  pending?: boolean
  onSave: (recordIds: string[]) => void
}) {
  const [picking, setPicking] = useState(false)
  const [ticked, setTicked] = useState<string[]>(selected)
  const added = available.filter((a) => selected.includes(a.recordId))
  // A record added earlier may have dropped out of what is available (paid
  // elsewhere since): it is shown as added until the next save or recalculation.
  const addedHours = added.reduce((s, a) => s + a.hours, 0)
  const addedCents = added.reduce((s, a) => s + a.amountCents, 0)
  const left = otSummary(available, selected)
  const toggle = (id: string) => setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]))

  return (
    <div className="rounded-xl p-3 text-xs space-y-2" style={{ background: 'rgb(var(--fg-rgb) / 0.04)' }}>
      <p className="font-bold text-white/85">Overtime</p>
      {added.length > 0
        ? <p className="text-success font-bold">Added: {hoursText(addedHours)} ({rs(addedCents)}) — paid with this.</p>
        : <p className="text-white/60">No overtime added — none is paid unless you add it.</p>}
      <p className="text-white/70">Overtime available: {hoursText(left.hours)} ({rs(left.cents)}){left.count > 0 ? ` · ${left.count} approved record${left.count === 1 ? '' : 's'}` : ''}</p>
      {editable && !picking && (
        <div className="flex flex-wrap gap-2">
          {available.length > 0 && (
            <button type="button" className={btnGhost} disabled={pending} onClick={() => { setTicked(selected.filter((id) => available.some((a) => a.recordId === id))); setPicking(true) }}>
              {added.length > 0 ? 'Change overtime' : 'Add overtime'}
            </button>
          )}
          {added.length > 0 && (
            <button type="button" className={btnGhost} disabled={pending} onClick={() => onSave([])}>Remove</button>
          )}
        </div>
      )}
      {editable && picking && (
        <div className="space-y-2">
          <ul className="space-y-1">
            {available.map((a) => (
              <li key={a.recordId}>
                <label className="flex items-center gap-2 text-white/80">
                  <input type="checkbox" className="h-4 w-4" style={{ accentColor: 'var(--erp-accent)' }} checked={ticked.includes(a.recordId)} onChange={() => toggle(a.recordId)} />
                  <span>{a.date ? day(a.date) : 'No date'} — {hoursText(a.hours)} — {rs(a.amountCents)}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btn} disabled={pending} onClick={() => { onSave(ticked); setPicking(false) }}>
              {pending ? 'Saving…' : `Save (${ticked.length} ticked)`}
            </button>
            <button type="button" className={btnGhost} onClick={() => setPicking(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
