'use client'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { Select } from '@/components/ui/Select'

interface Daypart {
  label: string
  startHour: number     // 0..23 inclusive
  endHour: number       // 1..24 inclusive
}

interface Policy {
  id: string
  depositRequiredAboveParty: number | null
  depositCents: number
  noShowGraceMinutes: number
  cancellationWindowHours: number
  maxAdvanceDays: number
  minAdvanceHours: number
  maxPartySize: number
  walkInsAllowed: boolean
  remindersEnabled: boolean
  reminderHoursBefore: number
  // Slot generation — controls how /availability builds the time-picker grid
  slotIntervalMin: number      // 15 / 30 / 60
  defaultDurationMin: number   // 60..240
  dayparts: Daypart[]          // grouping labels shown above the slots
  notes: string | null
}

export default function ReservationPolicyPage() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<Policy>({ queryKey: ['reservation-policy'], queryFn: () => api.get('/setup/reservation-policy') })
  const [form, setForm] = useState<Partial<Policy>>({})
  useEffect(() => { if (data) setForm(data) }, [data])
  const save = useMutation({
    mutationFn: () => api.patch('/setup/reservation-policy', form),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reservation-policy'] }),
  })

  if (isLoading) return <div className="p-8 text-white/60">Loading…</div>

  function patch<K extends keyof Policy>(k: K, v: Policy[K]) {
    setForm((prev) => ({ ...prev, [k]: v }))
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">📅 Reservation policy</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Deposits, no-show buffer, advance booking windows, party size caps, walk-in handling.
        </p>
      </header>

      <div className="px-7 py-7 max-w-3xl mx-auto space-y-6">
        <Section title="Deposits" desc="Hold a card for large parties">
          <Num label="Require deposit above party of" value={form.depositRequiredAboveParty ?? 0} onChange={(v) => patch('depositRequiredAboveParty', v || null)} suffix="people" />
          <Num label="Deposit amount (paisa)" value={form.depositCents ?? 0} onChange={(v) => patch('depositCents', v)} suffix={`≈ PKR ${((form.depositCents ?? 0) / 100).toFixed(0)}`} />
        </Section>

        <Section title="Booking window">
          <Num label="Max advance days" value={form.maxAdvanceDays ?? 60} onChange={(v) => patch('maxAdvanceDays', v)} />
          <Num label="Min advance hours" value={form.minAdvanceHours ?? 2} onChange={(v) => patch('minAdvanceHours', v)} />
          <Num label="Max party size" value={form.maxPartySize ?? 20} onChange={(v) => patch('maxPartySize', v)} />
        </Section>

        <Section title="No-show / cancellation">
          <Num label="No-show grace minutes" value={form.noShowGraceMinutes ?? 15} onChange={(v) => patch('noShowGraceMinutes', v)} />
          <Num label="Cancellation window (hours)" value={form.cancellationWindowHours ?? 24} onChange={(v) => patch('cancellationWindowHours', v)} />
        </Section>

        <Section title="Walk-ins & reminders">
          <Toggle label="Walk-ins allowed" checked={!!form.walkInsAllowed} onChange={(v) => patch('walkInsAllowed', v)} />
          <Toggle label="Send reminders" checked={!!form.remindersEnabled} onChange={(v) => patch('remindersEnabled', v)} />
          <Num label="Reminder hours before" value={form.reminderHoursBefore ?? 24} onChange={(v) => patch('reminderHoursBefore', v)} />
        </Section>

        <Section title="Time slots" desc="What the public booking widget shows when a guest picks a time">
          <div>
            <label className="text-xs text-white/55">Slot interval</label>
            <Select
              value={form.slotIntervalMin ?? 30}
              onChange={(e) => patch('slotIntervalMin', parseInt(e.target.value, 10))}
              className={fieldCls + ' mt-1'}>
              <option value={15}>Every 15 minutes</option>
              <option value={30}>Every 30 minutes</option>
              <option value={60}>Every 60 minutes</option>
            </Select>
            <p className="text-[10px] text-white/30 mt-1">Granularity of the time picker.</p>
          </div>
          <div>
            <label className="text-xs text-white/55">Default sitting duration</label>
            <Select
              value={form.defaultDurationMin ?? 90}
              onChange={(e) => patch('defaultDurationMin', parseInt(e.target.value, 10))}
              className={fieldCls + ' mt-1'}>
              <option value={60}>60 min</option>
              <option value={75}>75 min</option>
              <option value={90}>90 min (typical dinner)</option>
              <option value={120}>120 min</option>
              <option value={150}>150 min</option>
              <option value={180}>180 min (long tasting)</option>
            </Select>
            <p className="text-[10px] text-white/30 mt-1">How long each booking holds a table.</p>
          </div>
        </Section>

        <DaypartsEditor
          value={form.dayparts ?? DEFAULT_DAYPARTS}
          onChange={(d) => patch('dayparts', d)} />


        <div>
          <label className="text-xs text-white/55">Notes</label>
          <textarea value={form.notes ?? ''} onChange={(e) => patch('notes', e.target.value || null)} rows={2} className={fieldCls + ' mt-1'} />
        </div>

        <div className="flex justify-end gap-3 pt-4 border-t border-white/[0.05]">
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : 'Save policy'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-5" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <h2 className="text-sm font-black uppercase tracking-[0.18em] text-white/65">{title}</h2>
      {desc && <p className="text-xs text-white/35 mt-0.5">{desc}</p>}
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>
    </div>
  )
}
function Num({ label, value, onChange, suffix }: { label: string; value: number | null; onChange: (v: number) => void; suffix?: string }) {
  return (
    <div>
      <label className="text-xs text-white/55">{label}</label>
      <input type="number" value={value ?? 0} onChange={(e) => onChange(parseInt(e.target.value) || 0)} className={fieldCls + ' mt-1'} />
      {suffix && <p className="text-[10px] text-white/30 mt-1">{suffix}</p>}
    </div>
  )
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-accent" />
      <span className="text-sm text-white/85">{label}</span>
    </label>
  )
}
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"

const DEFAULT_DAYPARTS: Daypart[] = [
  { label: 'Lunch',      startHour: 0,  endHour: 12 },
  { label: 'Afternoon',  startHour: 12, endHour: 16 },
  { label: 'Dinner',     startHour: 16, endHour: 22 },
  { label: 'Late night', startHour: 22, endHour: 24 },
]

// Editor for the policy.dayparts array. The dayparts decide how the public
// widget groups its time grid (e.g. "Lunch / Afternoon / Dinner"). We
// validate locally — server-side has the same rules — so the operator gets
// instant feedback if they create a gap or overlap.
function DaypartsEditor({ value, onChange }: { value: Daypart[]; onChange: (d: Daypart[]) => void }) {
  const sorted = [...value].sort((a, b) => a.startHour - b.startHour)

  const issues: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!
    if (cur.endHour <= cur.startHour) issues.push(`${cur.label || 'Unnamed'}: end must be after start`)
    if (i > 0) {
      const prev = sorted[i - 1]!
      if (cur.startHour < prev.endHour) issues.push(`${cur.label || 'Unnamed'} overlaps ${prev.label}`)
    }
  }

  function update(idx: number, patch: Partial<Daypart>) {
    onChange(value.map((d, i) => (i === idx ? { ...d, ...patch } : d)))
  }
  function remove(idx: number) {
    onChange(value.filter((_, i) => i !== idx))
  }
  function add() {
    const last = sorted[sorted.length - 1]
    const start = last ? Math.min(23, last.endHour) : 0
    onChange([...value, { label: 'New', startHour: start, endHour: Math.min(24, start + 2) }])
  }
  function resetDefaults() {
    onChange(DEFAULT_DAYPARTS)
  }

  return (
    <div className="rounded-2xl p-5" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-sm font-black uppercase tracking-[0.18em] text-white/65">Daypart grouping</h2>
          <p className="text-xs text-white/35 mt-0.5">Headings shown above the slot picker. Must cover non-overlapping hour ranges.</p>
        </div>
        <button onClick={resetDefaults} className="text-[11px] text-white/40 hover:text-white/70 underline-offset-2 hover:underline">
          reset defaults
        </button>
      </div>

      <div className="mt-4 space-y-2">
        {value.map((d, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 items-center">
            <input
              value={d.label}
              onChange={(e) => update(i, { label: e.target.value })}
              maxLength={40}
              placeholder="e.g. Brunch"
              className={fieldCls + ' col-span-5'} />
            <Select
              value={d.startHour}
              onChange={(e) => update(i, { startHour: parseInt(e.target.value, 10) })}
              className={fieldCls + ' col-span-3'}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{h.toString().padStart(2, '0')}:00</option>
              ))}
            </Select>
            <Select
              value={d.endHour}
              onChange={(e) => update(i, { endHour: parseInt(e.target.value, 10) })}
              className={fieldCls + ' col-span-3'}>
              {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => (
                <option key={h} value={h}>{h === 24 ? '24:00 (end of day)' : `${h.toString().padStart(2, '0')}:00`}</option>
              ))}
            </Select>
            <button
              onClick={() => remove(i)}
              disabled={value.length <= 1}
              className="col-span-1 rounded-lg bg-white/[0.05] hover:bg-rose-500/20 px-2 py-2 text-xs text-white/55 hover:text-rose-700 disabled:opacity-30">
              ×
            </button>
          </div>
        ))}
      </div>

      <button onClick={add} className="mt-3 rounded-lg border border-dashed border-white/15 hover:border-white/30 px-3 py-2 text-xs text-white/50 hover:text-white/85 w-full">
        + Add daypart
      </button>

      {issues.length > 0 && (
        <ul className="mt-3 space-y-0.5">
          {issues.map((m, i) => (
            <li key={i} className="text-[11px] text-rose-700">⚠ {m}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
