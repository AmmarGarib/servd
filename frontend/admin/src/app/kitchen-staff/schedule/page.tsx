'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface StaffShift {
  id: string
  staffId: string
  staffName: string
  date: string
  scheduledStart: string | null
  scheduledEnd: string | null
  breakMinutes: number
  isWeeklyOff: boolean
  isFestivalHoliday: boolean
  notes: string | null
}

interface ShiftGridData {
  staff: Array<{ id: string; fullName: string; role: string }>
  shifts: StaffShift[]
}

interface ShiftModalForm {
  scheduledStart: string
  scheduledEnd: string
  breakMinutes: string
  isWeeklyOff: boolean
  isFestivalHoliday: boolean
  notes: string
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DAYS_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

const DEFAULT_PATTERNS = [
  { label: 'Single shift 11am–9pm', start: '11:00', end: '21:00' },
  { label: 'AM Brigade 8am–5pm', start: '08:00', end: '17:00' },
  { label: 'PM Brigade 2pm–11pm', start: '14:00', end: '23:00' },
]

function getMondayOfWeek(d: Date): Date {
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const monday = new Date(d)
  monday.setDate(d.getDate() + diff)
  return monday
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function fmtWeekRange(weekStart: string): string {
  const mon = new Date(weekStart)
  const sun = addDays(mon, 6)
  const fmtDay = (d: Date) =>
    d.toLocaleDateString('en-PK', { weekday: 'short', day: 'numeric', month: 'short' })
  return `${fmtDay(mon)} – ${fmtDay(sun)}`
}

function calcHours(shift: StaffShift): number {
  if (shift.isWeeklyOff || shift.isFestivalHoliday || !shift.scheduledStart || !shift.scheduledEnd) return 0
  const [sh, sm] = shift.scheduledStart.split(':').map(Number)
  const [eh, em] = shift.scheduledEnd.split(':').map(Number)
  const startMin = (sh ?? 0) * 60 + (sm ?? 0)
  let endMin = (eh ?? 0) * 60 + (em ?? 0)
  if (endMin <= startMin) endMin += 24 * 60 // past midnight
  return Math.max(0, (endMin - startMin - shift.breakMinutes) / 60)
}

function weeklyHoursColor(hours: number): string {
  if (hours > 60) return '#FF4D4F'
  if (hours >= 48) return '#F59E0B'
  return '#00D4B1'
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function SchedulePage() {
  const qc = useQueryClient()
  const [weekStart, setWeekStart] = useState(() => toDateStr(getMondayOfWeek(new Date())))

  // Modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [modalStaffId, setModalStaffId] = useState('')
  const [modalDate, setModalDate] = useState('')
  const [modalExistingId, setModalExistingId] = useState<string | null>(null)
  const [modalForm, setModalForm] = useState<ShiftModalForm>({
    scheduledStart: '11:00',
    scheduledEnd: '21:00',
    breakMinutes: '30',
    isWeeklyOff: false,
    isFestivalHoliday: false,
    notes: '',
  })

  // Default pattern selection
  const [selectedPattern, setSelectedPattern] = useState('')
  const [patternStaffId, setPatternStaffId] = useState('')

  const weekDates = Array.from({ length: 7 }, (_, i) => toDateStr(addDays(new Date(weekStart), i)))

  const { data, isLoading } = useQuery({
    queryKey: ['kitchen-staff-shifts', weekStart],
    queryFn: () => api.get<ShiftGridData>(`/kitchen-staff/shifts?week=${weekStart}`),
  })

  const saveMutation = useMutation({
    mutationFn: (body: {
      staffId: string
      date: string
      scheduledStart: string | null
      scheduledEnd: string | null
      breakMinutes: number
      isWeeklyOff: boolean
      isFestivalHoliday: boolean
      notes: string | null
    }) => api.post('/kitchen-staff/shifts', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['kitchen-staff-shifts'] })
      setModalOpen(false)
    },
  })

  const patternMutation = useMutation({
    mutationFn: (body: {
      staffId: string
      weekStart: string
      scheduledStart: string
      scheduledEnd: string
    }) => api.post('/kitchen-staff/shifts/pattern', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kitchen-staff-shifts'] }),
  })

  function openModal(staffId: string, date: string, existing?: StaffShift) {
    setModalStaffId(staffId)
    setModalDate(date)
    setModalExistingId(existing?.id ?? null)
    setModalForm({
      scheduledStart: existing?.scheduledStart ?? '11:00',
      scheduledEnd: existing?.scheduledEnd ?? '21:00',
      breakMinutes: String(existing?.breakMinutes ?? 30),
      isWeeklyOff: existing?.isWeeklyOff ?? false,
      isFestivalHoliday: existing?.isFestivalHoliday ?? false,
      notes: existing?.notes ?? '',
    })
    setModalOpen(true)
  }

  function handleSaveShift() {
    saveMutation.mutate({
      staffId: modalStaffId,
      date: modalDate,
      scheduledStart: modalForm.isWeeklyOff ? null : modalForm.scheduledStart || null,
      scheduledEnd: modalForm.isWeeklyOff ? null : modalForm.scheduledEnd || null,
      breakMinutes: parseInt(modalForm.breakMinutes || '0', 10),
      isWeeklyOff: modalForm.isWeeklyOff,
      isFestivalHoliday: modalForm.isFestivalHoliday,
      notes: modalForm.notes || null,
    })
  }

  function applyPattern() {
    const pattern = DEFAULT_PATTERNS.find((p) => p.label === selectedPattern)
    if (!pattern || !patternStaffId) return
    patternMutation.mutate({
      staffId: patternStaffId,
      weekStart,
      scheduledStart: pattern.start,
      scheduledEnd: pattern.end,
    })
  }

  const staffList = data?.staff ?? []
  const shifts = data?.shifts ?? []

  // Weekly hours per staff
  const weeklyHours: Record<string, number> = {}
  for (const s of shifts) {
    weeklyHours[s.staffId] = (weeklyHours[s.staffId] ?? 0) + calcHours(s)
  }

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <Link href="/kitchen-staff" className="text-xs text-s-muted hover:text-s-text">← Kitchen Staff</Link>
        <h1 className="text-xl font-bold text-s-text mt-0.5">Weekly Schedule</h1>
      </header>

      <div className="p-6 space-y-5">
        {/* Week picker + pattern selector */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Week navigation */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setWeekStart(toDateStr(addDays(new Date(weekStart), -7)))}
              className="p-2 rounded-xl transition-colors"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.5)' }}
            >
              ‹
            </button>
            <span className="text-sm font-semibold px-3 min-w-[220px] text-center"
              style={{ color: 'rgba(255,255,255,0.75)' }}>
              {fmtWeekRange(weekStart)}
            </span>
            <button
              onClick={() => setWeekStart(toDateStr(addDays(new Date(weekStart), 7)))}
              className="p-2 rounded-xl transition-colors"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.5)' }}
            >
              ›
            </button>
            <button
              onClick={() => setWeekStart(toDateStr(getMondayOfWeek(new Date())))}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.4)' }}
            >
              Today
            </button>
          </div>

          {/* Default pattern applicator */}
          <div className="flex items-center gap-2">
            <select
              value={patternStaffId}
              onChange={(e) => setPatternStaffId(e.target.value)}
              className="s-input text-xs px-2 py-1.5 rounded-lg"
              style={{ minWidth: '130px' }}
            >
              <option value="">Select staff…</option>
              {staffList.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
            </select>
            <select
              value={selectedPattern}
              onChange={(e) => setSelectedPattern(e.target.value)}
              className="s-input text-xs px-2 py-1.5 rounded-lg"
              style={{ minWidth: '170px' }}
            >
              <option value="">Default pattern…</option>
              {DEFAULT_PATTERNS.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
            </select>
            <button
              onClick={applyPattern}
              disabled={!selectedPattern || !patternStaffId || patternMutation.isPending}
              className="text-xs px-3 py-1.5 rounded-lg font-semibold disabled:opacity-40 transition-opacity"
              style={{ background: 'rgba(0,212,177,0.1)', border: '1px solid rgba(0,212,177,0.25)', color: '#00D4B1' }}
            >
              {patternMutation.isPending ? 'Applying…' : 'Apply'}
            </button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center h-48">
            <div className="animate-spin h-6 w-6 rounded-full border-2"
              style={{ borderColor: 'rgba(0,212,177,0.3)', borderTopColor: '#00D4B1' }} />
          </div>
        ) : (
          <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="overflow-x-auto">
              <table className="w-full" style={{ minWidth: '920px' }}>
                <thead>
                  <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider w-[180px]"
                      style={{ color: 'rgba(255,255,255,0.3)' }}>
                      Staff / Hours
                    </th>
                    {weekDates.map((date, i) => {
                      const isToday = date === toDateStr(new Date())
                      return (
                        <th key={date} className="text-center px-2 py-3 text-[11px] font-bold"
                          style={{ color: isToday ? '#00D4B1' : 'rgba(255,255,255,0.3)' }}>
                          <div>{DAYS_SHORT[i]}</div>
                          <div className="font-normal text-[10px] mt-0.5">
                            {new Date(date).toLocaleDateString('en-PK', { day: 'numeric', month: 'short' })}
                          </div>
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {staffList.length === 0 && (
                    <tr>
                      <td colSpan={8} className="text-center py-12 text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>
                        No active kitchen staff found
                      </td>
                    </tr>
                  )}
                  {staffList.map((member) => {
                    const wh = weeklyHours[member.id] ?? 0
                    const hoursColor = weeklyHoursColor(wh)
                    return (
                      <tr key={member.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-sm" style={{ color: 'rgba(255,255,255,0.8)' }}>{member.fullName}</div>
                          <div className="text-[10px] mt-0.5" style={{ color: 'rgba(255,255,255,0.3)' }}>{member.role}</div>
                          <div className="text-[11px] font-bold mt-1" style={{ color: hoursColor }}>
                            {wh.toFixed(1)}h
                          </div>
                        </td>
                        {weekDates.map((date, di) => {
                          const shift = shifts.find(
                            (s) => s.staffId === member.id && s.date.startsWith(date)
                          )
                          return (
                            <td key={date} className="px-1.5 py-2 align-top">
                              <button
                                className="w-full min-h-[52px] rounded-lg text-center text-[11px] transition-all group relative"
                                style={shift
                                  ? shift.isWeeklyOff || shift.isFestivalHoliday
                                    ? { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.25)' }
                                    : { background: 'rgba(0,212,177,0.07)', border: '1px solid rgba(0,212,177,0.15)', color: '#00D4B1' }
                                  : { background: 'transparent', border: '1px dashed rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.18)' }
                                }
                                onClick={() => openModal(member.id, date, shift)}
                                title={`${DAYS_FULL[di]}: click to ${shift ? 'edit' : 'add'} shift`}
                              >
                                {shift ? (
                                  shift.isWeeklyOff ? 'OFF'
                                  : shift.isFestivalHoliday ? 'HOL'
                                  : shift.scheduledStart && shift.scheduledEnd
                                    ? <span>{shift.scheduledStart.slice(0,5)}<br />–{shift.scheduledEnd.slice(0,5)}</span>
                                    : '—'
                                ) : (
                                  <span className="opacity-0 group-hover:opacity-100 transition-opacity">+</span>
                                )}
                              </button>
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Legend */}
            <div className="flex items-center gap-6 px-4 py-2.5 text-[11px]"
              style={{ borderTop: '1px solid rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.35)' }}>
              <span style={{ color: '#00D4B1' }}>■</span> Scheduled
              <span style={{ color: 'rgba(255,255,255,0.25)' }}>■</span> Day off / Holiday
              <span>Weekly hours: </span>
              <span style={{ color: '#00D4B1' }}>● &lt;48h OK</span>
              <span style={{ color: '#F59E0B' }}>● 48–60h caution</span>
              <span style={{ color: '#FF4D4F' }}>● &gt;60h excessive</span>
            </div>
          </div>
        )}
      </div>

      {/* Shift Modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setModalOpen(false) }}
        >
          <div className="w-full max-w-sm rounded-2xl p-6 space-y-4"
            style={{ background: '#0d0f15', border: '1px solid rgba(255,255,255,0.1)' }}>
            <h2 className="text-base font-bold" style={{ color: 'rgba(255,255,255,0.9)' }}>
              {modalExistingId ? 'Edit Shift' : 'Add Shift'}
            </h2>
            <p className="text-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>
              {new Date(modalDate).toLocaleDateString('en-PK', { weekday: 'long', day: 'numeric', month: 'long' })}
            </p>

            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={modalForm.isWeeklyOff}
                  onChange={(e) => setModalForm((f) => ({ ...f, isWeeklyOff: e.target.checked, isFestivalHoliday: false }))}
                  className="rounded"
                />
                <span className="text-xs text-s-muted">Weekly off</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={modalForm.isFestivalHoliday}
                  onChange={(e) => setModalForm((f) => ({ ...f, isFestivalHoliday: e.target.checked, isWeeklyOff: false }))}
                  className="rounded"
                />
                <span className="text-xs text-s-muted">Festival holiday</span>
              </label>
            </div>

            {!modalForm.isWeeklyOff && !modalForm.isFestivalHoliday && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] font-semibold mb-1 block" style={{ color: 'rgba(255,255,255,0.4)' }}>Start</label>
                    <input
                      type="time"
                      value={modalForm.scheduledStart}
                      onChange={(e) => setModalForm((f) => ({ ...f, scheduledStart: e.target.value }))}
                      className="s-input w-full text-sm px-3 py-2 rounded-xl"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold mb-1 block" style={{ color: 'rgba(255,255,255,0.4)' }}>End</label>
                    <input
                      type="time"
                      value={modalForm.scheduledEnd}
                      onChange={(e) => setModalForm((f) => ({ ...f, scheduledEnd: e.target.value }))}
                      className="s-input w-full text-sm px-3 py-2 rounded-xl"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-[11px] font-semibold mb-1 block" style={{ color: 'rgba(255,255,255,0.4)' }}>Break (minutes)</label>
                  <input
                    type="number"
                    value={modalForm.breakMinutes}
                    onChange={(e) => setModalForm((f) => ({ ...f, breakMinutes: e.target.value }))}
                    className="s-input w-full text-sm px-3 py-2 rounded-xl"
                    min={0}
                    max={120}
                  />
                </div>
              </>
            )}

            <div>
              <label className="text-[11px] font-semibold mb-1 block" style={{ color: 'rgba(255,255,255,0.4)' }}>Notes (optional)</label>
              <input
                type="text"
                value={modalForm.notes}
                onChange={(e) => setModalForm((f) => ({ ...f, notes: e.target.value }))}
                className="s-input w-full text-sm px-3 py-2 rounded-xl"
                placeholder="e.g. Catering event"
              />
            </div>

            <div className="flex gap-3">
              <button onClick={() => setModalOpen(false)}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}>
                Cancel
              </button>
              <button
                onClick={handleSaveShift}
                disabled={saveMutation.isPending}
                className="flex-1 py-2.5 rounded-xl text-sm font-bold disabled:opacity-50"
                style={{ background: 'rgba(0,212,177,0.12)', border: '1px solid rgba(0,212,177,0.3)', color: '#00D4B1' }}
              >
                {saveMutation.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
