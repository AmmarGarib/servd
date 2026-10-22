'use client'
// HR settings — the numbers payroll, overtime, attendance and leave run on.
// One set per company. Money is entered in rupees and stored in paisa.

import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { card, inp, btn } from '../../../lib/hr'
import { HrShell } from '../../../components/hr/HrShell'
import { Select } from '@/components/ui/Select'
import { NumberField } from '@/components/ui/NumberField'
import { useConfirm } from '@/components/ui/ConfirmDialog'

interface HrSettings {
  hoursPerDay: number
  otMultiplier: number
  eobi: { enabled: boolean; employeePct: number; employerPct: number; base: 'fixed' | 'gross'; fixedWageCents: number | null }
  sessi: { employerPct: number; wageCeilingCents: number | null }
  latesPerDeductionDay: number
  lateGraceMinutes: number
  deductAbsences: boolean
  leaveYearStartMonth: number
  encashLeaveOnExit: boolean
  employeeCodePrefix: string
  gratuity: Gratuity
  /** A working day with no check-in is absent from this day (YYYY-MM-DD); null = off. */
  absentWithoutPunchFrom?: string | null
  /** Overtime is worked out from check-in / check-out from this day; null = off. */
  punchOvertimeFrom?: string | null
  standardDayHours?: number
  otMinimumMinutes?: number
  /** Company default rota for anyone with no roster of their own; null = off. */
  defaultRota?: { start: string; end: string; breakMinutes: number; weeklyOff: string[] } | null
}
const WEEKDAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

/** Gratuity at exit (backend hr/logic.ts GratuitySettings, accountant default H6). */
interface Gratuity { enabled: boolean; eligibleTypes: string[]; minServiceMonths: number; partYearOverMonths: number; daysPerYear: number }
const DEFAULT_GRATUITY: Gratuity = { enabled: true, eligibleTypes: ['permanent'], minServiceMonths: 12, partYearOverMonths: 6, daysPerYear: 30 }
/** The employment types the Employee Master offers by default; a type HR added shows once it is ticked. */
const EMPLOYMENT_TYPES = ['permanent', 'probation', 'contract', 'temporary', 'intern']

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** Number boxes tell the page when they were emptied: an emptied box is "not
 *  filled in", never silently 0, and the page refuses to save until it is. */
const EmptyCtx = createContext<(label: string, empty: boolean) => void>(() => {})

const normalise = (x: HrSettings): HrSettings => ({ ...x, gratuity: { ...DEFAULT_GRATUITY, ...(x.gratuity ?? {}) } })

export default function HrSettingsPage() {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { data, error } = useQuery({ queryKey: ['hr-settings'], queryFn: () => api.get<HrSettings>('/hr/settings') })
  const [s, setS] = useState<HrSettings | null>(null)
  const [baseline, setBaseline] = useState<string>('')
  const [empty, setEmpty] = useState<Record<string, true>>({})
  const [showSaved, setShowSaved] = useState(false)
  const [formErr, setFormErr] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  // A server that predates gratuity sends none: start from the defaults.
  useEffect(() => { if (data) { const n = normalise(data); setS(n); setBaseline(JSON.stringify(n)) } }, [data])
  const save = useMutation({
    mutationFn: (body: HrSettings) => api.put<HrSettings>('/hr/settings', body),
    onSuccess: (next) => { const n = normalise(next); setS(n); setBaseline(JSON.stringify(n)); setEmpty({}); setShowSaved(true); setFormErr(''); void qc.invalidateQueries({ queryKey: ['hr-settings'] }) },
  })
  const emptyLabels = Object.keys(empty)
  const dirty = !!s && (JSON.stringify(s) !== baseline || emptyLabels.length > 0)
  const mark = useMemo(() => (label: string, isEmpty: boolean) => {
    setEmpty((e) => {
      if (isEmpty === (label in e)) return e
      if (isEmpty) return { ...e, [label]: true }
      const { [label]: _gone, ...rest } = e
      return rest
    })
  }, [])
  // Leaving with edits asks first.
  useEffect(() => {
    if (!dirty) return
    const h = (ev: BeforeUnloadEvent) => { ev.preventDefault(); ev.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])
  const doSave = () => {
    if (!s || save.isPending) return
    if (emptyLabels.length > 0) {
      setFormErr(`Fill in or restore: ${emptyLabels.join(', ')}.`)
      setTimeout(() => {
        const el = rootRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
        el?.scrollIntoView({ block: 'center', behavior: (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth') as ScrollBehavior }); el?.focus({ preventScroll: true })
      }, 30)
      return
    }
    setFormErr(''); setShowSaved(false)
    save.mutate(s)
  }
  const discard = async () => {
    const ok = await confirm({ title: 'Discard your changes?', body: 'The settings go back to what was last saved.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true })
    if (!ok) return
    if (baseline) setS(JSON.parse(baseline) as HrSettings)
    setEmpty({}); setFormErr('')
  }

  return (
    <HrShell title="HR settings" subtitle="The rules payroll, overtime, attendance and leave are calculated with — for the active company."
      actions={s && <button className={btn} disabled={save.isPending || !dirty} onClick={doSave}>{save.isPending ? 'Saving…' : 'Save settings'}</button>}>
      {error && <p className="text-sm text-s-red mb-4" role="alert">{(error as Error).message}</p>}
      {!s && !error && <p className="text-sm text-white/40" role="status">Loading settings…</p>}
      {save.error && <p className="text-sm text-s-red mb-4" role="alert">{(save.error as Error).message}</p>}
      {formErr && <p className="text-sm text-s-red mb-4" role="alert">{formErr}</p>}
      <p className="text-sm text-success mb-4" role="status" aria-live="polite">{showSaved && !dirty ? 'Settings saved. The next payroll calculation uses these.' : ''}</p>
      {s && (
        <EmptyCtx.Provider value={mark}>
        <div ref={rootRef} className="grid lg:grid-cols-2 gap-4 pb-24">
          <Panel title="Pay & overtime">
            <div>
              <span className="block text-[11px] font-bold text-white/55 mb-1">Pay days</span>
              <span className="block text-xs text-white/70">Salary = monthly gross ÷ the calendar days of the month (28–31) × paid days — company policy, set by the CEO. Paid days = days employed − absent days − unpaid leave days; weekly offs, holidays and paid leave are paid. Lates, overtime and leave encashment use the same daily rate.</span>
            </div>
            <Num label="Hours per day" max={24} help="Hourly rate = daily rate ÷ this." v={s.hoursPerDay} onSet={(v) => setS({ ...s, hoursPerDay: v })} />
            <Num label="Overtime multiplier" help="OT = hours × hourly rate × this. Factories Act default is 2." v={s.otMultiplier} step="0.25" onSet={(v) => setS({ ...s, otMultiplier: v })} />
            <Check label="Deduct absent days from pay" v={s.deductAbsences} onSet={(v) => setS({ ...s, deductAbsences: v })} />
          </Panel>

          <Panel title="EOBI">
            <Check label="Deduct EOBI in payroll" v={s.eobi.enabled} onSet={(v) => setS({ ...s, eobi: { ...s.eobi, enabled: v } })} />
            <p className="text-xs text-white/55 -mt-1">Compulsory once the company has 10 or more employees. Off, payroll runs without EOBI.</p>
            {s.eobi.enabled && <>
            <Num label="Employee share %" max={100} v={s.eobi.employeePct} step="0.1" onSet={(v) => setS({ ...s, eobi: { ...s.eobi, employeePct: v } })} />
            <Num label="Employer share %" max={100} v={s.eobi.employerPct} step="0.1" onSet={(v) => setS({ ...s, eobi: { ...s.eobi, employerPct: v } })} />
            <label className="block">
              <span className="block text-[11px] font-bold text-white/55 mb-1">Calculated on</span>
              <Select className={inp} value={s.eobi.base} onChange={(e) => setS({ ...s, eobi: { ...s.eobi, base: e.target.value as 'fixed' | 'gross' } })}>
                <option value="fixed">A fixed wage (the notified minimum wage)</option>
                <option value="gross">Each employee&apos;s gross salary</option>
              </Select>
            </label>
            {s.eobi.base === 'fixed' && (
              <Money label="EOBI wage base (Rs / month)" v={s.eobi.fixedWageCents} onSet={(v) => setS({ ...s, eobi: { ...s.eobi, fixedWageCents: v } })}
                help={s.eobi.fixedWageCents == null ? 'Not set — payroll will refuse to run until it is. Enter the currently notified minimum wage.' : 'EOBI is a % of this for everyone, not of their salary.'}
                warn={s.eobi.fixedWageCents == null} />
            )}
            </>}
          </Panel>

          <Panel title="SESSI">
            <Num label="Employer contribution %" max={100} help="0 switches SESSI off." v={s.sessi.employerPct} step="0.1" onSet={(v) => setS({ ...s, sessi: { ...s.sessi, employerPct: v } })} />
            <Money label="Wage ceiling (Rs / month)" help="Contribution is on gross up to this. Leave empty for no ceiling." v={s.sessi.wageCeilingCents} onSet={(v) => setS({ ...s, sessi: { ...s.sessi, wageCeilingCents: v } })} />
          </Panel>

          <Panel title="Attendance">
            <Num label="Grace before late (minutes)" v={s.lateGraceMinutes} onSet={(v) => setS({ ...s, lateGraceMinutes: v })} />
            <Num label="Lates per one day's deduction" help="e.g. 3 = every 3 lates deduct a day's pay. 0 = lates never deduct." v={s.latesPerDeductionDay} onSet={(v) => setS({ ...s, latesPerDeductionDay: v })} />
            <DateOrOff label="No check-in counts as absent from" help="A working day on the rota (not a weekly off, holiday or approved leave) with no check-in is absent and docked, unless HR corrects it. Off = days with no record are paid."
              v={s.absentWithoutPunchFrom ?? null} onSet={(v) => setS({ ...s, absentWithoutPunchFrom: v })} />
          </Panel>

          <Panel title="Company default rota">
            <p className="text-xs text-white/55">Everyone with no rota of their own works this shift. A person&apos;s own rota, a swap or a schedule change wins. Off = people with no rota are never marked absent.</p>
            <label className="flex items-center gap-2 text-sm text-white/80">
              <input type="checkbox" className="h-4 w-4 accent-primary" checked={!!s.defaultRota}
                onChange={(e) => setS({ ...s, defaultRota: e.target.checked ? { start: '11:00', end: '19:00', breakMinutes: 0, weeklyOff: ['monday'] } : null })} />
              Use a company default rota
            </label>
            {s.defaultRota && <>
              <div className="grid grid-cols-2 gap-3">
                <label className="block"><span className="block text-[11px] font-bold text-white/55 mb-1">Shift starts</span>
                  <input type="time" className={inp} value={s.defaultRota.start} onChange={(e) => setS({ ...s, defaultRota: { ...s.defaultRota!, start: e.target.value } })} /></label>
                <label className="block"><span className="block text-[11px] font-bold text-white/55 mb-1">Shift ends</span>
                  <input type="time" className={inp} value={s.defaultRota.end} onChange={(e) => setS({ ...s, defaultRota: { ...s.defaultRota!, end: e.target.value } })} /></label>
              </div>
              <div>
                <span className="block text-[11px] font-bold text-white/55 mb-1">Weekly off</span>
                <div className="flex flex-wrap gap-3">
                  {WEEKDAY_KEYS.map((d) => (
                    <label key={d} className="flex items-center gap-1.5 text-sm text-white/80">
                      <input type="checkbox" className="h-4 w-4 accent-primary" checked={s.defaultRota!.weeklyOff.includes(d)}
                        onChange={(e) => setS({ ...s, defaultRota: { ...s.defaultRota!, weeklyOff: e.target.checked ? [...s.defaultRota!.weeklyOff, d] : s.defaultRota!.weeklyOff.filter((x) => x !== d) } })} />
                      {d[0]!.toUpperCase() + d.slice(1, 3)}
                    </label>
                  ))}
                </div>
              </div>
            </>}
          </Panel>

          <Panel title="Overtime from check-in / check-out">
            <DateOrOff label="Work out overtime from" help="Time after the rota shift ends, or beyond the standard day when there is no shift. It is never paid on its own: HR adds it to each person's payroll."
              v={s.punchOvertimeFrom ?? null} onSet={(v) => setS({ ...s, punchOvertimeFrom: v })} />
            <Num label="Standard day (hours)" max={24} step="0.5" help="Used on a day with no shift on the rota." v={s.standardDayHours ?? 9} onSet={(v) => setS({ ...s, standardDayHours: v })} />
            <Num label="Ignore overtime under (minutes)" v={s.otMinimumMinutes ?? 30} onSet={(v) => setS({ ...s, otMinimumMinutes: v })} />
          </Panel>

          <Panel title="Leave">
            <label className="block">
              <span className="block text-[11px] font-bold text-white/55 mb-1">Leave year starts in</span>
              <Select className={inp} value={s.leaveYearStartMonth} onChange={(e) => setS({ ...s, leaveYearStartMonth: Number(e.target.value) })}>
                {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </Select>
            </label>
            <Check label="Pay out unused leave in final settlement" v={s.encashLeaveOnExit} onSet={(v) => setS({ ...s, encashLeaveOnExit: v })} />
          </Panel>

          <Panel title="Gratuity at exit">
            <Check label="Pay gratuity in the full & final settlement" v={s.gratuity.enabled} onSet={(v) => setS({ ...s, gratuity: { ...s.gratuity, enabled: v } })} />
            <p className="text-xs text-white/55 -mt-1">
              Gratuity = last gross salary ÷ 30 × days per year × counted years. It is booked to Gratuity (6036) when the full &amp; final is approved.
            </p>
            {s.gratuity.enabled && <>
              <div>
                <span className="block text-[11px] font-bold text-white/55 mb-1">Paid to</span>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {Array.from(new Set([...EMPLOYMENT_TYPES, ...s.gratuity.eligibleTypes])).map((t) => (
                    <Check key={t} label={t.charAt(0).toUpperCase() + t.slice(1)} v={s.gratuity.eligibleTypes.includes(t)}
                      onSet={(on) => setS({ ...s, gratuity: { ...s.gratuity, eligibleTypes: on ? [...s.gratuity.eligibleTypes, t] : s.gratuity.eligibleTypes.filter((x) => x !== t) } })} />
                  ))}
                </div>
              </div>
              <Num label="Minimum service (months)" help="No gratuity before this many full months. 12 = one full year." v={s.gratuity.minServiceMonths}
                onSet={(v) => setS({ ...s, gratuity: { ...s.gratuity, minServiceMonths: v } })} />
              <Num label="A part year counts as a full year when it is more than (months)" help="6 = 1 year 6 months counts as 1 year; 1 year 6 months and 1 day counts as 2." v={s.gratuity.partYearOverMonths}
                onSet={(v) => setS({ ...s, gratuity: { ...s.gratuity, partYearOverMonths: v } })} />
              <Num label="Days of last gross per year" help="30 = one month's gross for each counted year." v={s.gratuity.daysPerYear}
                onSet={(v) => setS({ ...s, gratuity: { ...s.gratuity, daysPerYear: v } })} />
            </>}
          </Panel>

          <Panel title="Employee IDs">
            <label className="block">
              <span className="block text-[11px] font-bold text-white/55 mb-1">Prefix</span>
              <input className={inp} maxLength={12} value={s.employeeCodePrefix} onChange={(e) => setS({ ...s, employeeCodePrefix: e.target.value })} />
              <span className="block text-xs text-white/55 mt-1">New employees get the next number after this, e.g. {s.employeeCodePrefix || ''}0001.</span>
            </label>
          </Panel>
        </div>
        </EmptyCtx.Provider>
      )}
      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-white/10 px-4 py-3 flex flex-wrap items-center gap-3 justify-between" style={{ background: 'var(--surface)' }} role="region" aria-label="Unsaved changes">
          <p className="text-sm font-bold text-white/85">Unsaved changes</p>
          <div className="flex gap-2">
            <button type="button" className="rounded-lg px-4 py-2 text-sm text-white/60 border border-white/10 hover:text-white [@media(pointer:coarse)]:min-h-[44px]" onClick={() => void discard()}>Discard</button>
            <button type="button" className={`${btn} [@media(pointer:coarse)]:min-h-[44px]`} disabled={save.isPending} onClick={doSave}>{save.isPending ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}
    </HrShell>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-5 space-y-3" style={card}>
      <p className="text-sm font-black text-white/85">{title}</p>
      {children}
    </div>
  )
}

function Num({ label, help, v, step, max, onSet }: { label: string; help?: string; v: number; step?: string; max?: number; onSet: (v: number) => void }) {
  const mark = useContext(EmptyCtx)
  const [bad, setBad] = useState(false)
  const id = useId()
  const decimals = step?.split('.')[1]?.length ?? 0
  // A box that leaves the page (its panel closed) no longer counts as emptied.
  useEffect(() => () => mark(label, false), [mark, label])
  return (
    <div>
      <label htmlFor={id} className="block text-[11px] font-bold text-white/55 mb-1">{label}</label>
      <NumberField id={id} className={inp} value={v} decimals={decimals} min={0} max={max} aria-invalid={bad || undefined} aria-describedby={help ? `${id}-h` : undefined}
        onValueChange={(n) => { setBad(n == null); mark(label, n == null); if (n != null) onSet(n) }} />
      {bad && <span className="block text-xs mt-1 font-bold" style={{ color: 'var(--erp-danger)' }}>{label} cannot be empty.</span>}
      {help && <span id={`${id}-h`} className="block text-xs text-white/55 mt-1">{help}</span>}
    </div>
  )
}

/** Rupees in the box, paisa in the settings. Empty is a real value here (no ceiling / not set). */
function Money({ label, help, v, warn, onSet }: { label: string; help?: string; v: number | null; warn?: boolean; onSet: (v: number | null) => void }) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="block text-[11px] font-bold text-white/55 mb-1">{label}</label>
      <NumberField id={id} className={inp} value={v == null ? null : v / 100} decimals={2} min={0} aria-describedby={help ? `${id}-h` : undefined}
        onValueChange={(n) => onSet(n == null ? null : Math.round(n * 100))} />
      {help && <span id={`${id}-h`} className={`block text-xs mt-1 ${warn ? 'text-s-amber' : 'text-white/55'}`}>{help}</span>}
    </div>
  )
}

/** A start date, or off (null). */
function DateOrOff({ label, help, v, onSet }: { label: string; help?: string; v: string | null; onSet: (v: string | null) => void }) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="block text-[11px] font-bold text-white/55 mb-1">{label}</label>
      <div className="flex items-center gap-3">
        <input id={id} type="date" className={inp} value={v ?? ''} disabled={v == null} onChange={(e) => onSet(e.target.value || null)} aria-describedby={help ? `${id}-h` : undefined} />
        <label className="flex items-center gap-2 text-sm text-white/80 shrink-0">
          <input type="checkbox" checked={v != null} onChange={(e) => onSet(e.target.checked ? '2026-11-01' : null)} className="h-4 w-4 accent-primary" />
          On
        </label>
      </div>
      {help && <span id={`${id}-h`} className="block text-xs text-white/55 mt-1">{help}</span>}
    </div>
  )
}

function Check({ label, v, onSet }: { label: string; v: boolean; onSet: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-white/80">
      <input type="checkbox" checked={v} onChange={(e) => onSet(e.target.checked)} className="h-4 w-4 accent-primary" />
      {label}
    </label>
  )
}
