'use client'
import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useBrandFilter } from '../../store/brandFilter'

interface Concept { id: string; name: string }
interface StaffMember { id: string; name: string; role: string }
interface ScheduledShift {
  id: string
  userId: string
  conceptId: string
  date: string
  startTime: string
  endTime: string
  role: string | null
  notes: string | null
  user: { id: string; name: string; role: string }
}
interface WeekViewData {
  weekStart: string
  staff: StaffMember[]
  shifts: ScheduledShift[]
}
interface LaborCostData {
  totalCents: number
  totalHours: number
  byUser: { userId: string; name: string; hours: number; costCents: number; rateUnset: boolean }[]
}
interface CopyWeekResult {
  copied: number
  skipped: number
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function getMondayOfWeek(d: Date) {
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const monday = new Date(d)
  monday.setDate(d.getDate() + diff)
  return monday
}

function toDateStr(d: Date) { return d.toISOString().split('T')[0]! }

function addDays(d: Date, n: number) {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function fmtDisplayDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-PK', { month: 'short', day: 'numeric' })
}

function fmtPKR(cents: number) {
  return `PKR ${Math.round(cents / 100).toLocaleString()}`
}

export default function SchedulingPage() {
  const today = getMondayOfWeek(new Date())
  const [weekStart, setWeekStart] = useState(toDateStr(today))
  const [conceptId, setConceptId] = useState<string>(() => useBrandFilter.getState().brandId ?? '')
  const [showModal, setShowModal] = useState(false)
  const [editShift, setEditShift] = useState<ScheduledShift | null>(null)
  const [form, setForm] = useState({ userId: '', date: '', startTime: '09:00', endTime: '17:00', role: '', notes: '' })
  const [copyResult, setCopyResult] = useState<string | null>(null)
  const [conflictError, setConflictError] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data: concepts } = useQuery({ queryKey: ['concepts'], queryFn: () => api.get<Concept[]>('/concepts') })

  const { data, isLoading } = useQuery({
    queryKey: ['scheduling', conceptId, weekStart],
    queryFn: () => api.get<WeekViewData>(`/scheduling?conceptId=${conceptId}&weekStart=${weekStart}`),
    enabled: !!conceptId,
  })

  const { data: laborCost } = useQuery({
    queryKey: ['laborCost', conceptId, weekStart],
    queryFn: () => api.get<LaborCostData>(`/scheduling/labor-cost?conceptId=${conceptId}&weekStart=${weekStart}`),
    enabled: !!conceptId,
  })

  const saveMutation = useMutation({
    mutationFn: (body: typeof form & { conceptId: string }) =>
      editShift
        ? api.patch(`/scheduling/${editShift.id}`, body)
        : api.post('/scheduling', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling'] })
      void qc.invalidateQueries({ queryKey: ['laborCost'] })
      setShowModal(false)
      setEditShift(null)
      setConflictError(null)
    },
    onError: (error: Error) => {
      if (error.message.includes('SHIFT_CONFLICT')) {
        setConflictError('This shift conflicts with an existing shift for this staff member.')
      } else {
        setConflictError(error.message)
      }
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/scheduling/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling'] })
      void qc.invalidateQueries({ queryKey: ['laborCost'] })
    },
  })

  const copyWeekMutation = useMutation({
    mutationFn: ({ sourceWeekStart, targetWeekStart }: { sourceWeekStart: string; targetWeekStart: string }) =>
      api.post<CopyWeekResult>('/scheduling/copy-week', { conceptId, sourceWeekStart, targetWeekStart }),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ['scheduling'] })
      void qc.invalidateQueries({ queryKey: ['laborCost'] })
      if (result.skipped > 0) {
        setCopyResult(`${result.copied} shifts copied, ${result.skipped} skipped (conflicts)`)
      } else {
        setCopyResult(`Copied ${result.copied} shifts`)
      }
      setTimeout(() => setCopyResult(null), 5000)
    },
    onError: (error: Error) => {
      setCopyResult(`Error: ${error.message}`)
      setTimeout(() => setCopyResult(null), 5000)
    },
  })

  function openCreate(date: string, userId?: string) {
    setEditShift(null)
    setConflictError(null)
    setForm({ userId: userId ?? '', date, startTime: '09:00', endTime: '17:00', role: '', notes: '' })
    setShowModal(true)
  }

  function openEdit(shift: ScheduledShift) {
    setEditShift(shift)
    setConflictError(null)
    setForm({ userId: shift.userId, date: shift.date, startTime: shift.startTime, endTime: shift.endTime, role: shift.role ?? '', notes: shift.notes ?? '' })
    setShowModal(true)
  }

  function prevWeek() {
    const d = new Date(weekStart)
    d.setDate(d.getDate() - 7)
    setWeekStart(toDateStr(d))
  }

  function nextWeek() {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + 7)
    setWeekStart(toDateStr(d))
  }

  function handleCopyPrevWeek() {
    const prevMonday = addDays(new Date(weekStart), -7)
    const prevWeekStart = toDateStr(prevMonday)
    const prevEnd = toDateStr(addDays(prevMonday, 6))
    const currEnd = toDateStr(addDays(new Date(weekStart), 6))
    const ok = confirm(
      `Copy all shifts from ${fmtDisplayDate(prevWeekStart)}–${fmtDisplayDate(prevEnd)} to ${fmtDisplayDate(weekStart)}–${fmtDisplayDate(currEnd)}?`
    )
    if (ok) {
      copyWeekMutation.mutate({ sourceWeekStart: prevWeekStart, targetWeekStart: weekStart })
    }
  }

  const weekDates = Array.from({ length: 7 }, (_, i) => toDateStr(addDays(new Date(weekStart), i)))
  const staff = data?.staff ?? []
  const shifts = data?.shifts ?? []

  const SHIFT_COLORS = ['rgba(0,212,177,0.15)', 'rgba(99,102,241,0.15)', 'rgba(245,158,11,0.15)', 'rgba(236,72,153,0.15)', 'rgba(34,211,238,0.15)']
  const hasRateUnset = laborCost?.byUser.some(u => u.rateUnset) ?? false

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-black" style={{ color: 'rgba(255,255,255,0.92)' }}>Employee Scheduling</h1>
          <p className="text-sm mt-0.5" style={{ color: 'rgba(255,255,255,0.35)' }}>Weekly roster view</p>
        </div>
        <button onClick={() => openCreate(weekDates[0]!)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all"
          style={{ background: 'rgba(0,212,177,0.12)', border: '1px solid rgba(0,212,177,0.3)', color: '#00D4B1' }}>
          + Add Shift
        </button>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <select value={conceptId} onChange={e => setConceptId(e.target.value)}
          className="s-input text-sm px-3 py-2 rounded-xl min-w-[180px]">
          <option value="">Select concept…</option>
          {concepts?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div className="flex items-center gap-2">
          <button onClick={prevWeek} className="p-2 rounded-xl transition-colors"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.5)' }}>
            ‹
          </button>
          <span className="text-sm font-semibold px-2" style={{ color: 'rgba(255,255,255,0.7)' }}>
            {fmtDisplayDate(weekDates[0]!)} – {fmtDisplayDate(weekDates[6]!)}
          </span>
          <button onClick={nextWeek} className="p-2 rounded-xl transition-colors"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.5)' }}>
            ›
          </button>
          <button onClick={() => setWeekStart(toDateStr(getMondayOfWeek(new Date())))}
            className="px-3 py-1.5 rounded-xl text-xs font-semibold"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.4)' }}>
            Today
          </button>
          {conceptId && (
            <button
              onClick={handleCopyPrevWeek}
              disabled={copyWeekMutation.isPending}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold disabled:opacity-50 transition-opacity"
              style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)', color: 'rgba(165,168,255,0.9)' }}>
              {copyWeekMutation.isPending ? 'Copying…' : 'Copy prev week'}
            </button>
          )}
        </div>
      </div>

      {/* Copy week result toast */}
      {copyResult && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium"
          style={{ background: 'rgba(0,212,177,0.08)', border: '1px solid rgba(0,212,177,0.25)', color: '#00D4B1' }}>
          {copyResult}
          <button onClick={() => setCopyResult(null)} className="ml-auto text-xs opacity-60 hover:opacity-100">✕</button>
        </div>
      )}

      {/* Labor cost strip */}
      {conceptId && laborCost && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-4 px-4 py-2.5 rounded-xl text-sm"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.55)' }}>
            <span>
              Est. labor this week:{' '}
              <span className="font-bold" style={{ color: 'rgba(255,255,255,0.85)' }}>
                {fmtPKR(laborCost.totalCents)}
              </span>
              {' · '}
              <span className="font-semibold" style={{ color: 'rgba(255,255,255,0.75)' }}>
                {laborCost.totalHours.toFixed(1)} hrs total
              </span>
            </span>
          </div>
          {hasRateUnset && (
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium"
              style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', color: '#F59E0B' }}>
              ⚠ Some staff have no wage set — check Settings
            </div>
          )}
        </div>
      )}

      {!conceptId && (
        <div className="flex items-center justify-center h-48 rounded-2xl" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <p className="text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>Select a concept to view the schedule</p>
        </div>
      )}

      {conceptId && isLoading && (
        <div className="flex items-center justify-center h-48">
          <div className="animate-spin h-6 w-6 rounded-full border-2" style={{ borderColor: 'rgba(0,212,177,0.3)', borderTopColor: '#00D4B1' }} />
        </div>
      )}

      {conceptId && !isLoading && (
        <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="overflow-x-auto">
            <table className="w-full" style={{ minWidth: '780px' }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider w-[160px]"
                    style={{ color: 'rgba(255,255,255,0.3)' }}>Staff</th>
                  {weekDates.map((date, i) => {
                    const isToday = date === toDateStr(new Date())
                    return (
                      <th key={date} className="text-center px-2 py-3 text-[11px] font-bold"
                        style={{ color: isToday ? '#00D4B1' : 'rgba(255,255,255,0.3)' }}>
                        <div>{DAYS[i]}</div>
                        <div className="font-normal">{fmtDisplayDate(date)}</div>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {staff.length === 0 && (
                  <tr>
                    <td colSpan={8} className="text-center py-12 text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>
                      No staff found for this concept
                    </td>
                  </tr>
                )}
                {staff.map((member, memberIdx) => {
                  const color = SHIFT_COLORS[memberIdx % SHIFT_COLORS.length]!
                  return (
                    <tr key={member.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-sm" style={{ color: 'rgba(255,255,255,0.8)' }}>{member.name}</div>
                        <div className="text-[11px] capitalize" style={{ color: 'rgba(255,255,255,0.3)' }}>{member.role}</div>
                      </td>
                      {weekDates.map(date => {
                        const dayShifts = shifts.filter(s => s.userId === member.id && s.date.startsWith(date))
                        return (
                          <td key={date} className="px-2 py-2 align-top">
                            <div className="space-y-1 min-h-[48px]">
                              {dayShifts.map(shift => (
                                <div key={shift.id} className="rounded-lg px-2 py-1.5 cursor-pointer group relative"
                                  style={{ background: color, border: '1px solid rgba(255,255,255,0.06)' }}
                                  onClick={() => openEdit(shift)}>
                                  <div className="text-xs font-semibold" style={{ color: 'rgba(255,255,255,0.8)' }}>
                                    {shift.startTime}–{shift.endTime}
                                  </div>
                                  {shift.role && <div className="text-[10px]" style={{ color: 'rgba(255,255,255,0.4)' }}>{shift.role}</div>}
                                  <button
                                    onClick={e => { e.stopPropagation(); void deleteMutation.mutate(shift.id) }}
                                    className="absolute top-1 right-1 opacity-70 group-hover:opacity-100 transition-opacity text-xs rounded px-1.5 py-0.5"
                                    style={{ color: '#FF4D4F', background: 'rgba(255,77,79,0.1)' }}>
                                    ×
                                  </button>
                                </div>
                              ))}
                              <button onClick={() => openCreate(date, member.id)}
                                className="w-full text-center text-[11px] py-1.5 rounded-lg opacity-60 hover:opacity-100 transition-opacity"
                                style={{ color: 'rgba(255,255,255,0.2)', border: '1px dashed rgba(255,255,255,0.1)' }}>
                                +
                              </button>
                            </div>
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={e => { if (e.target === e.currentTarget) { setShowModal(false); setConflictError(null) } }}>
          <div className="w-full max-w-md rounded-2xl p-6 space-y-4" style={{ background: '#0d0f15', border: '1px solid rgba(255,255,255,0.1)' }}>
            <h2 className="text-base font-bold" style={{ color: 'rgba(255,255,255,0.9)' }}>
              {editShift ? 'Edit Shift' : 'Add Shift'}
            </h2>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold mb-1 block" style={{ color: 'rgba(255,255,255,0.4)' }}>Staff member</label>
                <select value={form.userId} onChange={e => setForm(f => ({ ...f, userId: e.target.value }))}
                  className="s-input w-full text-sm px-3 py-2 rounded-xl">
                  <option value="">Select staff…</option>
                  {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold mb-1 block" style={{ color: 'rgba(255,255,255,0.4)' }}>Date</label>
                <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                  className="s-input w-full text-sm px-3 py-2 rounded-xl" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold mb-1 block" style={{ color: 'rgba(255,255,255,0.4)' }}>Start time</label>
                  <input type="time" value={form.startTime} onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))}
                    className="s-input w-full text-sm px-3 py-2 rounded-xl" />
                </div>
                <div>
                  <label className="text-xs font-semibold mb-1 block" style={{ color: 'rgba(255,255,255,0.4)' }}>End time</label>
                  <input type="time" value={form.endTime} onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))}
                    className="s-input w-full text-sm px-3 py-2 rounded-xl" />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold mb-1 block" style={{ color: 'rgba(255,255,255,0.4)' }}>Role (optional)</label>
                <input type="text" value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                  placeholder="e.g. Head Chef, Cashier…"
                  className="s-input w-full text-sm px-3 py-2 rounded-xl" />
              </div>
              <div>
                <label className="text-xs font-semibold mb-1 block" style={{ color: 'rgba(255,255,255,0.4)' }}>Notes (optional)</label>
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  rows={2} className="s-input w-full text-sm px-3 py-2 rounded-xl resize-none" />
              </div>
            </div>

            {/* Conflict error */}
            {conflictError && (
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs font-medium"
                style={{ background: 'rgba(255,77,79,0.1)', border: '1px solid rgba(255,77,79,0.3)', color: '#FF4D4F' }}>
                ⚠ {conflictError}
              </div>
            )}

            <div className="flex gap-3">
              <button onClick={() => { setShowModal(false); setConflictError(null) }}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}>
                Cancel
              </button>
              <button
                disabled={!form.userId || !form.date || saveMutation.isPending}
                onClick={() => { setConflictError(null); saveMutation.mutate({ ...form, conceptId }) }}
                className="flex-1 py-2.5 rounded-xl text-sm font-bold disabled:opacity-50 transition-opacity"
                style={{ background: 'rgba(0,212,177,0.12)', border: '1px solid rgba(0,212,177,0.3)', color: '#00D4B1' }}>
                {saveMutation.isPending ? 'Saving…' : editShift ? 'Save Changes' : 'Add Shift'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
