'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface AttendanceRecord {
  id: string
  staffId: string
  staffName: string
  role: string
  date: string
  scheduledStart: string | null
  scheduledEnd: string | null
  actualStart: string | null
  actualEnd: string | null
  hoursWorked: number | null
  status: 'present' | 'absent' | 'late' | 'early_leave' | 'off'
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function todayIso(): string {
  const now = new Date()
  const pkt = new Date(now.getTime() + 5 * 3600_000)
  return pkt.toISOString().slice(0, 10)
}

function fmtTime(t: string | null): string {
  if (!t) return '—'
  return t.slice(0, 5)
}

function statusBadge(status: AttendanceRecord['status']) {
  switch (status) {
    case 'present':     return <span className="s-badge-teal">Present</span>
    case 'late':        return <span className="s-badge-amber">Late</span>
    case 'early_leave': return <span className="s-badge-amber">Early Leave</span>
    case 'absent':      return <span className="s-badge-red">Absent</span>
    case 'off':         return <span className="s-badge-muted">Off</span>
    default:            return <span className="s-badge-muted">{status}</span>
  }
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function AttendancePage() {
  const qc = useQueryClient()
  const [date, setDate] = useState(todayIso)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ actualStart: '', actualEnd: '' })

  const { data: records, isLoading } = useQuery({
    queryKey: ['kitchen-attendance', date],
    queryFn: () => api.get<AttendanceRecord[]>(`/kitchen-staff/attendance?date=${date}`),
  })

  const punchMutation = useMutation({
    mutationFn: ({ shiftId, action }: { shiftId: string; action: 'in' | 'out' }) =>
      api.patch(`/kitchen-staff/shifts/${shiftId}/punch`, { action }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kitchen-attendance'] }),
  })

  const editMutation = useMutation({
    mutationFn: ({ shiftId, actualStart, actualEnd }: { shiftId: string; actualStart: string; actualEnd: string }) =>
      api.patch(`/kitchen-staff/shifts/${shiftId}/punch`, {
        actualStart: actualStart || null,
        actualEnd: actualEnd || null,
        manual: true,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['kitchen-attendance'] })
      setEditingId(null)
    },
  })

  function prevDay() {
    const d = new Date(date)
    d.setDate(d.getDate() - 1)
    setDate(d.toISOString().slice(0, 10))
  }
  function nextDay() {
    const d = new Date(date)
    d.setDate(d.getDate() + 1)
    setDate(d.toISOString().slice(0, 10))
  }

  const fmtDisplayDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-PK', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

  const isToday = date === todayIso()

  // Summary counts
  const summary = {
    present: records?.filter((r) => r.status === 'present').length ?? 0,
    absent: records?.filter((r) => r.status === 'absent').length ?? 0,
    late: records?.filter((r) => r.status === 'late').length ?? 0,
    off: records?.filter((r) => r.status === 'off').length ?? 0,
  }

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <Link href="/kitchen-staff" className="text-xs text-s-muted hover:text-s-text">← Kitchen Staff</Link>
        <h1 className="text-xl font-bold text-s-text mt-0.5">Daily Attendance</h1>
      </header>

      <div className="p-6 space-y-5 max-w-6xl">
        {/* Date picker */}
        <div className="flex items-center gap-3">
          <button onClick={prevDay} className="p-2 rounded-xl transition-colors"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.5)' }}>
            ‹
          </button>
          <span className="text-sm font-semibold px-3" style={{ color: 'rgba(255,255,255,0.8)' }}>
            {fmtDisplayDate(date)}
          </span>
          <button onClick={nextDay} className="p-2 rounded-xl transition-colors"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.5)' }}>
            ›
          </button>
          {!isToday && (
            <button onClick={() => setDate(todayIso())}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.4)' }}>
              Today
            </button>
          )}
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="s-input text-sm px-3 py-1.5 rounded-xl"
          />
        </div>

        {/* Summary strip */}
        {records && records.length > 0 && (
          <div className="flex items-center gap-4 flex-wrap">
            {[
              { label: 'Present', count: summary.present, color: '#00D4B1' },
              { label: 'Absent', count: summary.absent, color: '#FF4D4F' },
              { label: 'Late', count: summary.late, color: '#F59E0B' },
              { label: 'Off', count: summary.off, color: 'rgba(255,255,255,0.3)' },
            ].map((item) => (
              <div key={item.label} className="px-3 py-2 rounded-xl text-sm"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <span style={{ color: item.color }} className="font-bold">{item.count}</span>
                <span className="ml-1.5 text-xs text-s-muted">{item.label}</span>
              </div>
            ))}
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center h-48">
            <div className="animate-spin h-6 w-6 rounded-full border-2"
              style={{ borderColor: 'rgba(0,212,177,0.3)', borderTopColor: '#00D4B1' }} />
          </div>
        ) : (
          <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  {['Name / Role', 'Scheduled', 'Actual In', 'Actual Out', 'Hours', 'Status', 'Actions'].map((col) => (
                    <th key={col} className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider"
                      style={{ color: 'rgba(255,255,255,0.3)' }}>
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(!records || records.length === 0) && (
                  <tr>
                    <td colSpan={7} className="text-center py-12 text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>
                      No attendance records for this date
                    </td>
                  </tr>
                )}
                {records?.map((r) => (
                  <tr key={r.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td className="px-4 py-3">
                      <div className="font-semibold" style={{ color: 'rgba(255,255,255,0.85)' }}>{r.staffName}</div>
                      <div className="text-[11px]" style={{ color: 'rgba(255,255,255,0.35)' }}>{r.role}</div>
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'rgba(255,255,255,0.55)' }}>
                      {r.scheduledStart && r.scheduledEnd
                        ? `${fmtTime(r.scheduledStart)} – ${fmtTime(r.scheduledEnd)}`
                        : '—'}
                    </td>

                    {/* Actual In / Out — inline edit mode */}
                    {editingId === r.id ? (
                      <>
                        <td className="px-4 py-3">
                          <input
                            type="time"
                            value={editForm.actualStart}
                            onChange={(e) => setEditForm((f) => ({ ...f, actualStart: e.target.value }))}
                            className="s-input text-xs px-2 py-1 rounded-lg w-28"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <input
                            type="time"
                            value={editForm.actualEnd}
                            onChange={(e) => setEditForm((f) => ({ ...f, actualEnd: e.target.value }))}
                            className="s-input text-xs px-2 py-1 rounded-lg w-28"
                          />
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-4 py-3 text-xs" style={{ color: r.actualStart ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.2)' }}>
                          {fmtTime(r.actualStart)}
                        </td>
                        <td className="px-4 py-3 text-xs" style={{ color: r.actualEnd ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.2)' }}>
                          {fmtTime(r.actualEnd)}
                        </td>
                      </>
                    )}

                    <td className="px-4 py-3 text-xs font-mono" style={{ color: 'rgba(255,255,255,0.6)' }}>
                      {r.hoursWorked != null ? `${r.hoursWorked.toFixed(1)}h` : '—'}
                    </td>
                    <td className="px-4 py-3">{statusBadge(r.status)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {editingId === r.id ? (
                          <>
                            <button
                              onClick={() => editMutation.mutate({ shiftId: r.id, actualStart: editForm.actualStart, actualEnd: editForm.actualEnd })}
                              disabled={editMutation.isPending}
                              className="text-xs px-2.5 py-1 rounded-lg disabled:opacity-50"
                              style={{ background: 'rgba(0,212,177,0.1)', border: '1px solid rgba(0,212,177,0.2)', color: '#00D4B1' }}
                            >
                              {editMutation.isPending ? '…' : 'Save'}
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="text-xs px-2 py-1 rounded-lg"
                              style={{ color: 'rgba(255,255,255,0.35)' }}
                            >
                              ✕
                            </button>
                          </>
                        ) : (
                          <>
                            {r.status !== 'off' && !r.actualStart && (
                              <button
                                onClick={() => punchMutation.mutate({ shiftId: r.id, action: 'in' })}
                                disabled={punchMutation.isPending}
                                className="text-xs px-2.5 py-1 rounded-lg disabled:opacity-50"
                                style={{ background: 'rgba(0,212,177,0.08)', border: '1px solid rgba(0,212,177,0.18)', color: '#00D4B1' }}
                              >
                                Punch In
                              </button>
                            )}
                            {r.actualStart && !r.actualEnd && (
                              <button
                                onClick={() => punchMutation.mutate({ shiftId: r.id, action: 'out' })}
                                disabled={punchMutation.isPending}
                                className="text-xs px-2.5 py-1 rounded-lg disabled:opacity-50"
                                style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.18)', color: '#F59E0B' }}
                              >
                                Punch Out
                              </button>
                            )}
                            <button
                              onClick={() => {
                                setEditingId(r.id)
                                setEditForm({
                                  actualStart: r.actualStart?.slice(0, 5) ?? '',
                                  actualEnd: r.actualEnd?.slice(0, 5) ?? '',
                                })
                              }}
                              className="text-xs px-2 py-1 rounded-lg"
                              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.4)' }}
                            >
                              Edit
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
