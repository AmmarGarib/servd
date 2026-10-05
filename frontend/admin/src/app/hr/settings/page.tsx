'use client'
// HR settings — the numbers payroll, overtime, attendance and leave run on.
// One set per company. Money is entered in rupees and stored in paisa.

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { card, inp, btn } from '../../../lib/hr'
import { HrShell } from '../../../components/hr/HrShell'

interface HrSettings {
  workingDaysPerMonth: number
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
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export default function HrSettingsPage() {
  const qc = useQueryClient()
  const { data, error } = useQuery({ queryKey: ['hr-settings'], queryFn: () => api.get<HrSettings>('/hr/settings') })
  const [s, setS] = useState<HrSettings | null>(null)
  useEffect(() => { if (data) setS(data) }, [data])
  const save = useMutation({
    mutationFn: (body: HrSettings) => api.put<HrSettings>('/hr/settings', body),
    onSuccess: (next) => { setS(next); void qc.invalidateQueries({ queryKey: ['hr-settings'] }) },
  })

  return (
    <HrShell title="HR settings" subtitle="The rules payroll, overtime, attendance and leave are calculated with — for the active company."
      actions={s && <button className={btn} disabled={save.isPending} onClick={() => save.mutate(s)}>{save.isPending ? 'Saving…' : 'Save settings'}</button>}>
      {error && <p className="text-sm text-red-700 mb-4">{(error as Error).message}</p>}
      {save.error && <p className="text-sm text-red-700 mb-4">{(save.error as Error).message}</p>}
      {save.isSuccess && <p className="text-sm text-emerald-700 mb-4">Saved. The next payroll calculation uses these.</p>}
      {s && (
        <div className="grid lg:grid-cols-2 gap-4">
          <Panel title="Pay & overtime">
            <Num label="Working days per month" help="Daily rate = gross ÷ this. Absences are deducted at the daily rate." v={s.workingDaysPerMonth} onSet={(v) => setS({ ...s, workingDaysPerMonth: v })} />
            <Num label="Hours per day" help="Hourly rate = daily rate ÷ this." v={s.hoursPerDay} onSet={(v) => setS({ ...s, hoursPerDay: v })} />
            <Num label="Overtime multiplier" help="OT = hours × hourly rate × this. Factories Act default is 2." v={s.otMultiplier} step="0.25" onSet={(v) => setS({ ...s, otMultiplier: v })} />
            <Check label="Deduct absent days from pay" v={s.deductAbsences} onSet={(v) => setS({ ...s, deductAbsences: v })} />
          </Panel>

          <Panel title="EOBI">
            <Check label="Deduct EOBI in payroll" v={s.eobi.enabled} onSet={(v) => setS({ ...s, eobi: { ...s.eobi, enabled: v } })} />
            <p className="text-[10px] text-white/35 -mt-1">Compulsory once the company has 10 or more employees. Off, payroll runs without EOBI.</p>
            {s.eobi.enabled && <>
            <Num label="Employee share %" v={s.eobi.employeePct} step="0.1" onSet={(v) => setS({ ...s, eobi: { ...s.eobi, employeePct: v } })} />
            <Num label="Employer share %" v={s.eobi.employerPct} step="0.1" onSet={(v) => setS({ ...s, eobi: { ...s.eobi, employerPct: v } })} />
            <label className="block">
              <span className="block text-[11px] font-bold text-white/55 mb-1">Calculated on</span>
              <select className={inp} value={s.eobi.base} onChange={(e) => setS({ ...s, eobi: { ...s.eobi, base: e.target.value as 'fixed' | 'gross' } })}>
                <option value="fixed">A fixed wage (the notified minimum wage)</option>
                <option value="gross">Each employee&apos;s gross salary</option>
              </select>
            </label>
            {s.eobi.base === 'fixed' && (
              <Money label="EOBI wage base (Rs / month)" v={s.eobi.fixedWageCents} onSet={(v) => setS({ ...s, eobi: { ...s.eobi, fixedWageCents: v } })}
                help={s.eobi.fixedWageCents == null ? 'Not set — payroll will refuse to run until it is. Enter the currently notified minimum wage.' : 'EOBI is a % of this for everyone, not of their salary.'}
                warn={s.eobi.fixedWageCents == null} />
            )}
            </>}
          </Panel>

          <Panel title="SESSI">
            <Num label="Employer contribution %" help="0 switches SESSI off." v={s.sessi.employerPct} step="0.1" onSet={(v) => setS({ ...s, sessi: { ...s.sessi, employerPct: v } })} />
            <Money label="Wage ceiling (Rs / month)" help="Contribution is on gross up to this. Leave empty for no ceiling." v={s.sessi.wageCeilingCents} onSet={(v) => setS({ ...s, sessi: { ...s.sessi, wageCeilingCents: v } })} />
          </Panel>

          <Panel title="Attendance">
            <Num label="Grace before late (minutes)" v={s.lateGraceMinutes} onSet={(v) => setS({ ...s, lateGraceMinutes: v })} />
            <Num label="Lates per one day's deduction" help="e.g. 3 = every 3 lates deduct a day's pay. 0 = lates never deduct." v={s.latesPerDeductionDay} onSet={(v) => setS({ ...s, latesPerDeductionDay: v })} />
          </Panel>

          <Panel title="Leave">
            <label className="block">
              <span className="block text-[11px] font-bold text-white/55 mb-1">Leave year starts in</span>
              <select className={inp} value={s.leaveYearStartMonth} onChange={(e) => setS({ ...s, leaveYearStartMonth: Number(e.target.value) })}>
                {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
            </label>
            <Check label="Pay out unused leave in final settlement" v={s.encashLeaveOnExit} onSet={(v) => setS({ ...s, encashLeaveOnExit: v })} />
          </Panel>

          <Panel title="Employee IDs">
            <label className="block">
              <span className="block text-[11px] font-bold text-white/55 mb-1">Prefix</span>
              <input className={inp} maxLength={12} value={s.employeeCodePrefix} onChange={(e) => setS({ ...s, employeeCodePrefix: e.target.value })} />
              <span className="block text-[10px] text-white/35 mt-1">New employees get the next number after this, e.g. {s.employeeCodePrefix || ''}0001.</span>
            </label>
          </Panel>
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

function Num({ label, help, v, step, onSet }: { label: string; help?: string; v: number; step?: string; onSet: (v: number) => void }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-bold text-white/55 mb-1">{label}</span>
      <input type="number" step={step ?? '1'} min={0} className={inp} value={Number.isFinite(v) ? v : ''} onChange={(e) => onSet(Number(e.target.value))} />
      {help && <span className="block text-[10px] text-white/35 mt-1">{help}</span>}
    </label>
  )
}

function Money({ label, help, v, warn, onSet }: { label: string; help?: string; v: number | null; warn?: boolean; onSet: (v: number | null) => void }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-bold text-white/55 mb-1">{label}</span>
      <input type="number" min={0} step="any" className={inp} value={v == null ? '' : v / 100}
        onChange={(e) => onSet(e.target.value === '' ? null : Math.round(Number(e.target.value) * 100))} />
      {help && <span className={`block text-[10px] mt-1 ${warn ? 'text-amber-700' : 'text-white/35'}`}>{help}</span>}
    </label>
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
