'use client'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

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
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">📅 Reservation policy</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Deposits, no-show buffer, advance booking windows, party size caps, walk-in handling.
        </p>
      </header>

      <div className="px-7 py-7 max-w-3xl space-y-6">
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

        <div>
          <label className="text-xs text-white/55">Notes</label>
          <textarea value={form.notes ?? ''} onChange={(e) => patch('notes', e.target.value || null)} rows={2} className={fieldCls + ' mt-1'} />
        </div>

        <div className="flex justify-end gap-3 pt-4 border-t border-white/[0.05]">
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : 'Save policy'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-5" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
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
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-kds-green" />
      <span className="text-sm text-white/85">{label}</span>
    </label>
  )
}
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-kds-green focus:outline-none"
