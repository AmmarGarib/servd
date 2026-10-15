'use client'
// The weekly rota (decision 33). Standing shifts and weekly offs are set in
// HR (Shift master + Roster); this week is GENERATED from them. What a manager
// changes here is a one-off exception for one person on one day — other hours,
// an extra shift, or a day off — and "Back to roster" removes it. Approved HR
// shift swaps show up on their own. Approved full-day leave (HR) wins over
// everything planned for the day: the cell reads "Leave", and hours cannot be
// set on it (the API answers 409 ON_LEAVE) — the leave is changed in HR. The
// week is costed from HR salaries.

import { useState } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useBrandFilter } from '../../store/brandFilter'
import { useAuthStore } from '../../store/auth'
import { fmtPkrWhole } from '../../lib/money'
import { useManagerRoles } from '../../lib/roles'
import { Select } from '@/components/ui/Select'

interface Concept { id: string; name: string }
interface StaffMember { id: string; name: string; employeeCode: string; designation: string | null; canHaveExceptions: boolean }
interface Segment { start: string; end: string; shiftId: string | null; shiftName: string | null; exceptionId: string | null; role: string | null; notes: string | null }
// The shape of GET /scheduling cells (backend hr/rota.ts RotaCell).
interface Cell {
  employeeId: string; date: string
  kind: 'shift' | 'off' | 'leave' | 'none'
  source: 'roster' | 'swap' | 'exception' | 'leave' | 'none'
  segments: Segment[]; offExceptionId: string | null; minutes: number
  /** The approved leave record, on a 'leave' day. */
  leaveId?: string | null
}
interface ShiftDef { id: string; name: string; start: string; end: string }
interface WeekView { weekStart: string; weekEnd: string; staff: StaffMember[]; cells: Cell[]; shifts: ShiftDef[] }
interface LaborCost { totalCents: number; totalHours: number; basis: string; byEmployee: Array<{ employeeId: string; name: string; hours: number; totalCents: number; rateUnset: boolean }> }

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const SOURCE_LABEL: Record<Cell['source'], string> = { roster: 'roster', swap: 'swap', exception: 'changed', leave: 'approved', none: '' }
const SOURCE_TONE: Record<Cell['source'], string> = {
  roster: 'rgb(var(--erp-primary-rgb) / 0.12)', swap: 'rgb(var(--ink-rgb) / 0.18)', exception: 'rgba(245,158,11,0.16)', leave: 'color-mix(in srgb, var(--erp-secondary) 10%, transparent)', none: 'transparent',
}

const ymd = (d: Date) => d.toISOString().slice(0, 10)
function mondayOf(d: Date) {
  const u = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  return new Date(u.getTime() - ((u.getUTCDay() + 6) % 7) * 86_400_000)
}
const addDays = (iso: string, n: number) => ymd(new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000))
const fmtDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-PK', { month: 'short', day: 'numeric', timeZone: 'UTC' })

export default function SchedulingPage() {
  const qc = useQueryClient()
  const role = useAuthStore((s) => s.user?.role ?? '')
  // Who plans the rota: the API's MANAGERS (lib/roles.ts) + hr.
  const planner = useManagerRoles('hr').has(role)
  const [weekStart, setWeekStart] = useState(ymd(mondayOf(new Date())))
  const [conceptId, setConceptId] = useState<string>(() => useBrandFilter.getState().brandId ?? '')
  const [editing, setEditing] = useState<{ member: StaffMember; cell: Cell } | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // Brand list from GET /concepts?view=picker (every staff role, the active
  // brands of its own companies, id + name) — plain /concepts is managers /
  // till only and 403'd for the roles that hold this page (R2-UI-03).
  // Shares the shell BrandPicker's cache key and shape.
  const { data: concepts } = useQuery({
    queryKey: ['concepts', 'brand-picker'],
    queryFn: () => api.get<Concept[]>('/concepts?view=picker'),
    staleTime: 60_000,
  })
  const week = useQuery({
    queryKey: ['scheduling', conceptId, weekStart],
    queryFn: () => api.get<WeekView>(`/scheduling?conceptId=${conceptId}&weekStart=${weekStart}`),
    enabled: !!conceptId,
  })
  const cost = useQuery({
    queryKey: ['laborCost', conceptId, weekStart],
    queryFn: () => api.get<LaborCost>(`/scheduling/labor-cost?conceptId=${conceptId}&weekStart=${weekStart}`),
    enabled: !!conceptId && planner,
  })
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['scheduling'] }); void qc.invalidateQueries({ queryKey: ['laborCost'] }) }

  const copyWeek = useMutation({
    mutationFn: () => api.post<{ created: number; skipped: number }>('/scheduling/copy-week', { conceptId, sourceWeekStart: addDays(weekStart, -7), targetWeekStart: weekStart }),
    onSuccess: (r) => { refresh(); setToast(`${r.created} change(s) copied${r.skipped ? `, ${r.skipped} skipped` : ''}`); setTimeout(() => setToast(null), 5000) },
    onError: (e: Error) => { setToast(e.message); setTimeout(() => setToast(null), 5000) },
  })

  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const cellOf = (employeeId: string, date: string) => week.data?.cells.find((c) => c.employeeId === employeeId && c.date === date)
  const today = ymd(new Date())

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-black" style={{ color: 'rgb(var(--fg-rgb) / 0.92)' }}>Rota</h1>
          <p className="text-sm mt-0.5 max-w-2xl" style={{ color: 'rgb(var(--fg-rgb) / 0.4)' }}>
            Generated from each person&apos;s standing shift and weekly offs in <Link href="/hr/s/roster" className="underline">HR → Roster</Link> (shifts are in <Link href="/hr/s/shift" className="underline">HR → Shift master</Link>). A change made here is a one-off for that day. Swaps are requested and approved in <Link href="/hr/s/shift_swap" className="underline">HR → Shift swap</Link>.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className="s-input text-sm px-3 py-2 rounded-xl min-w-[180px]" aria-label="Brand">
          <option value="">Select brand…</option>
          {concepts?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <button onClick={() => setWeekStart(addDays(weekStart, -7))} className="p-2 rounded-xl" style={{ background: 'rgb(var(--fg-rgb) / 0.04)', border: '1px solid rgb(var(--fg-rgb) / 0.07)', color: 'rgb(var(--fg-rgb) / 0.5)' }} aria-label="Previous week">‹</button>
        <span className="text-sm font-semibold px-2" style={{ color: 'rgb(var(--fg-rgb) / 0.7)' }}>{fmtDay(dates[0]!)} – {fmtDay(dates[6]!)}</span>
        <button onClick={() => setWeekStart(addDays(weekStart, 7))} className="p-2 rounded-xl" style={{ background: 'rgb(var(--fg-rgb) / 0.04)', border: '1px solid rgb(var(--fg-rgb) / 0.07)', color: 'rgb(var(--fg-rgb) / 0.5)' }} aria-label="Next week">›</button>
        <button onClick={() => setWeekStart(ymd(mondayOf(new Date())))} className="px-3 py-1.5 rounded-xl text-xs font-semibold" style={{ background: 'rgb(var(--fg-rgb) / 0.04)', border: '1px solid rgb(var(--fg-rgb) / 0.07)', color: 'rgb(var(--fg-rgb) / 0.4)' }}>This week</button>
        {conceptId && planner && (
          <button onClick={() => { if (confirm('Copy last week\'s one-off changes to this week? The roster repeats by itself.')) copyWeek.mutate() }} disabled={copyWeek.isPending}
            className="px-3 py-1.5 rounded-xl text-xs font-semibold disabled:opacity-50" style={{ background: 'rgb(var(--erp-primary-rgb) / 0.08)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.3)', color: 'var(--erp-primary-ink)' }}>
            {copyWeek.isPending ? 'Copying…' : 'Copy last week\'s changes'}
          </button>
        )}
      </div>

      {toast && <div className="px-4 py-2.5 rounded-xl text-sm" style={{ background: 'rgb(var(--erp-primary-rgb) / 0.08)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.25)', color: 'var(--erp-primary-ink)' }}>{toast}</div>}

      {conceptId && cost.data && (
        <div className="px-4 py-2.5 rounded-xl text-sm space-y-1" style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.06)', color: 'rgb(var(--fg-rgb) / 0.55)' }}>
          <p>Rota cost this week: <strong style={{ color: 'rgb(var(--fg-rgb) / 0.85)' }}>{fmtPkrWhole(cost.data.totalCents)}</strong> · {cost.data.totalHours.toFixed(1)} hrs</p>
          <p className="text-[11px]" style={{ color: 'rgb(var(--fg-rgb) / 0.35)' }}>At each person&apos;s HR rate: {cost.data.basis}.</p>
          {cost.data.byEmployee.some((u) => u.rateUnset) && <p className="text-xs" style={{ color: 'var(--erp-warning)' }}>Some rostered people have no gross salary in HR — their hours are costed at zero.</p>}
        </div>
      )}

      {!conceptId && (
        <div className="flex items-center justify-center h-48 rounded-2xl" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
          <p className="text-sm" style={{ color: 'rgb(var(--fg-rgb) / 0.3)' }}>Select a brand to see its rota</p>
        </div>
      )}
      {conceptId && week.error && <p className="text-sm text-red-700">{(week.error as Error).message}</p>}

      {conceptId && week.data && (
        <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
          <div className="overflow-x-auto">
            <table className="w-full" style={{ minWidth: '820px' }}>
              <thead>
                <tr style={{ background: 'rgb(var(--fg-rgb) / 0.03)', borderBottom: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                  <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider w-[180px]" style={{ color: 'rgb(var(--fg-rgb) / 0.3)' }}>Staff</th>
                  {dates.map((d, i) => (
                    <th key={d} className="text-center px-2 py-3 text-[11px] font-bold" style={{ color: d === today ? 'var(--erp-success)' : 'rgb(var(--fg-rgb) / 0.3)' }}>
                      <div>{DAYS[i]}</div><div className="font-normal">{fmtDay(d)}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {week.data.staff.length === 0 && (
                  <tr><td colSpan={8} className="text-center py-12 text-sm" style={{ color: 'rgb(var(--fg-rgb) / 0.3)' }}>No current HR employees work for this brand. Add them in <Link href="/hr/employees" className="underline">HR → Employees</Link>.</td></tr>
                )}
                {week.data.staff.map((m) => (
                  <tr key={m.id} style={{ borderBottom: '1px solid rgb(var(--fg-rgb) / 0.04)' }}>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-sm" style={{ color: 'rgb(var(--fg-rgb) / 0.8)' }}>{m.name}</div>
                      <div className="text-[11px]" style={{ color: 'rgb(var(--fg-rgb) / 0.3)' }}>{m.designation ?? m.employeeCode}</div>
                    </td>
                    {dates.map((d) => {
                      const c = cellOf(m.id, d)
                      const clickable = planner && m.canHaveExceptions && !!c
                      return (
                        <td key={d} className="px-1.5 py-2 align-top">
                          <button type="button" disabled={!clickable} onClick={() => c && setEditing({ member: m, cell: c })}
                            title={!m.canHaveExceptions && planner ? 'No servd login — change their standing shift in HR → Roster' : undefined}
                            className="w-full min-h-[48px] rounded-lg px-2 py-1.5 text-left disabled:cursor-default"
                            style={{ background: c ? SOURCE_TONE[c.source] : 'transparent', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                            {c?.kind === 'shift' && c.segments.map((s, i) => (
                              <div key={i} className="text-xs font-semibold" style={{ color: 'rgb(var(--fg-rgb) / 0.8)' }}>{s.start}–{s.end}{s.shiftName && <span className="font-normal" style={{ color: 'rgb(var(--fg-rgb) / 0.4)' }}> {s.shiftName}</span>}</div>
                            ))}
                            {c?.kind === 'off' && <div className="text-xs font-bold" style={{ color: 'rgb(var(--fg-rgb) / 0.45)' }}>Off</div>}
                            {c?.kind === 'leave' && <div className="text-xs font-bold" style={{ color: 'rgb(var(--fg-rgb) / 0.7)' }}>Leave</div>}
                            {(!c || c.kind === 'none') && <div className="text-xs" style={{ color: 'rgb(var(--fg-rgb) / 0.2)' }}>—</div>}
                            {c && c.source !== 'none' && <div className="text-[10px] mt-0.5" style={{ color: 'rgb(var(--fg-rgb) / 0.35)' }}>{SOURCE_LABEL[c.source]}</div>}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing && week.data && (
        <ExceptionModal conceptId={conceptId} member={editing.member} cell={editing.cell} shifts={week.data.shifts}
          onClose={() => setEditing(null)} onSaved={() => { refresh(); setEditing(null) }} />
      )}
    </div>
  )
}

function ExceptionModal({ conceptId, member, cell, shifts, onClose, onSaved }: {
  conceptId: string; member: StaffMember; cell: Cell; shifts: ShiftDef[]; onClose: () => void; onSaved: () => void
}) {
  const [shiftId, setShiftId] = useState('')
  const [start, setStart] = useState('09:00')
  const [end, setEnd] = useState('17:00')
  const [notes, setNotes] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const exceptionIds = [...cell.segments.map((s) => s.exceptionId), cell.offExceptionId].filter((x): x is string => !!x)
  // Approved leave wins over the day: no hours, no shift, no day-off here.
  const onLeave = cell.kind === 'leave'

  const add = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post('/scheduling', { employeeId: member.id, conceptId, date: cell.date, ...body }),
    onSuccess: onSaved,
    onError: (e: Error) => setErr(e.message),
  })
  const backToRoster = useMutation({
    mutationFn: async () => { for (const id of exceptionIds) await api.delete(`/scheduling/${id}`) },
    onSuccess: onSaved,
    onError: (e: Error) => setErr(e.message),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgb(var(--ink-rgb) / 0.5)' }} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-md rounded-2xl p-6 space-y-4" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.1)' }}>
        <div>
          <h2 className="text-base font-bold" style={{ color: 'rgb(var(--fg-rgb) / 0.9)' }}>{member.name} · {fmtDay(cell.date)}</h2>
          <p className="text-xs mt-1" style={{ color: 'rgb(var(--fg-rgb) / 0.4)' }}>
            {onLeave
              ? 'On approved leave.'
              : <>
                  {cell.kind === 'off' ? 'Off' : cell.kind === 'shift' ? cell.segments.map((s) => `${s.start}–${s.end}`).join(', ') : 'Nothing planned'}
                  {cell.source !== 'none' && ` (${SOURCE_LABEL[cell.source]})`}. A change here applies to this day only.
                </>}
          </p>
        </div>

        {onLeave && (
          <p className="text-xs rounded-xl px-3 py-2" style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.08)', color: 'rgb(var(--fg-rgb) / 0.6)' }}>
            Hours cannot be set on a leave day. To roster {member.name} after all, shorten or cancel the leave in <Link href="/hr/s/leave" className="underline">HR → Leave</Link> first.
          </p>
        )}

        {!onLeave && (
        <div className="space-y-3">
          {shifts.length > 0 && (
            <div className="flex gap-2">
              <Select value={shiftId} onChange={(e) => setShiftId(e.target.value)} className="s-input flex-1 text-sm px-3 py-2 rounded-xl" aria-label="Shift">
                <option value="">Work a shift from the shift master…</option>
                {shifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.start}–{s.end})</option>)}
              </Select>
              <button disabled={!shiftId || add.isPending} onClick={() => add.mutate({ shiftId, ...(notes && { notes }) })}
                className="px-3 py-2 rounded-xl text-sm font-bold disabled:opacity-50" style={{ background: 'rgb(var(--erp-primary-rgb) / 0.12)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.3)', color: 'var(--erp-primary-ink)' }}>Set</button>
            </div>
          )}
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
            <label className="text-xs" style={{ color: 'rgb(var(--fg-rgb) / 0.4)' }}>Start<input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="s-input w-full text-sm px-3 py-2 rounded-xl mt-1" /></label>
            <label className="text-xs" style={{ color: 'rgb(var(--fg-rgb) / 0.4)' }}>End<input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="s-input w-full text-sm px-3 py-2 rounded-xl mt-1" /></label>
            <button disabled={add.isPending} onClick={() => add.mutate({ startTime: start, endTime: end, ...(notes && { notes }) })}
              className="px-3 py-2 rounded-xl text-sm font-bold disabled:opacity-50" style={{ background: 'rgb(var(--erp-primary-rgb) / 0.12)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.3)', color: 'var(--erp-primary-ink)' }}>{cell.source === 'exception' && cell.kind === 'shift' ? 'Add hours' : 'Set hours'}</button>
          </div>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Note (optional)" className="s-input w-full text-sm px-3 py-2 rounded-xl" />
        </div>
        )}

        {err && <p className="text-xs" style={{ color: 'var(--erp-danger)' }}>{err}</p>}

        <div className="flex flex-wrap gap-2">
          {!onLeave && (
            <button disabled={add.isPending} onClick={() => add.mutate({ off: true, ...(notes && { notes }) })}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50" style={{ background: 'rgb(var(--fg-rgb) / 0.04)', border: '1px solid rgb(var(--fg-rgb) / 0.1)', color: 'rgb(var(--fg-rgb) / 0.7)' }}>Day off</button>
          )}
          {exceptionIds.length > 0 && (
            <button disabled={backToRoster.isPending} onClick={() => backToRoster.mutate()}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50" style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', color: 'var(--erp-warning)' }}>Back to roster</button>
          )}
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl text-sm font-semibold" style={{ background: 'rgb(var(--fg-rgb) / 0.04)', border: '1px solid rgb(var(--fg-rgb) / 0.08)', color: 'rgb(var(--fg-rgb) / 0.5)' }}>Close</button>
        </div>
      </div>
    </div>
  )
}
