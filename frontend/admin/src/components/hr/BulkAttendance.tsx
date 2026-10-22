'use client'
// Attendance in bulk (owner, 2026-10-22).
//  - "Enter days in bulk": ONE employee, a date range, every day as a row
//    prefilled from the rota (present on working days, the rota's hours). HR
//    edits each day's status / times, unticks what to leave out, and submits
//    once — POST /hr/attendance/bulk-days.
//  - "Mark present for dates": many people, a date range — every working day
//    with no record yet becomes present at the rota's hours, after a preview
//    — POST /hr/attendance/mark-present (dryRun first).
// Every day is a hand-keyed attendance record that waits for the CEO, who
// approves them together in the approvals inbox.

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { card, inp, btn, btnGhost, human } from '../../lib/hr'
import { Modal, useHrLookups, useHrForm } from './HrShell'
import { Select } from '@/components/ui/Select'

const karachiToday = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10)
const monthStart = () => `${karachiToday().slice(0, 7)}-01`
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
const FALLBACK_STATUSES = ['present', 'absent', 'late', 'early_departure', 'half_day', 'missing_punch', 'off_day', 'holiday']

interface PreviewDay {
  date: string; kind: 'working' | 'holiday' | 'off' | 'leave' | 'none'
  start: string | null; end: string | null; shiftId: string | null
  employed: boolean; future: boolean
  existing: { id: string; status: string | null; state: string } | null
}
interface Row { date: string; on: boolean; status: string; checkIn: string; checkOut: string; shiftId: string | null; locked: string | null; kind: PreviewDay['kind'] }

const KIND_LABEL: Record<PreviewDay['kind'], string> = { working: 'Rota shift', holiday: 'Holiday', off: 'Weekly off', leave: 'On leave', none: 'No rota' }

function useStatuses(): string[] {
  const { data } = useHrForm('attendance')
  const f = data?.current.fields.find((x) => x.key === 'status' || x.bind === 'category')
  return f?.options?.length ? f.options : FALLBACK_STATUSES
}

export function BulkAttendanceButtons() {
  const [open, setOpen] = useState<'days' | 'present' | null>(null)
  return (
    <>
      <div className="flex flex-wrap gap-2 mb-4">
        <button type="button" className={btnGhost} onClick={() => setOpen('days')}>Enter days in bulk</button>
        <button type="button" className={btnGhost} onClick={() => setOpen('present')}>Mark present for dates</button>
      </div>
      {open === 'days' && <BulkDaysModal onClose={() => setOpen(null)} />}
      {open === 'present' && <MarkPresentModal onClose={() => setOpen(null)} />}
    </>
  )
}

function Done({ created, failed, onClose }: { created: number; failed: Array<{ date: string; message: string; name?: string }>; onClose: () => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-bold text-success">{created} day{created === 1 ? '' : 's'} sent to the CEO for approval.</p>
      <p className="text-xs text-white/55">They count for attendance and payroll once the CEO approves them (Approvals → HR requests → Select all).</p>
      {failed.length > 0 && (
        <ul className="rounded-lg px-3 py-2 text-xs space-y-0.5" style={{ border: '1px solid var(--erp-danger)', color: 'var(--erp-danger)' }}>
          {failed.slice(0, 30).map((f, k) => <li key={k}>{f.name ? `${f.name}, ` : ''}{f.date}: {f.message}</li>)}
          {failed.length > 30 && <li>…and {failed.length - 30} more</li>}
        </ul>
      )}
      <div className="flex justify-end"><button type="button" className={btn} onClick={onClose}>Close</button></div>
    </div>
  )
}

function BulkDaysModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const { data: lookups } = useHrLookups()
  const statuses = useStatuses()
  const [employeeId, setEmployeeId] = useState('')
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(karachiToday())
  const [remarks, setRemarks] = useState('')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const employees = (lookups?.employees ?? []).filter((e) => e.status === 'active' || e.status === 'on_leave')

  const load = useMutation({
    mutationFn: () => api.get<{ days: PreviewDay[] }>(`/hr/attendance/bulk-days/preview?employeeId=${encodeURIComponent(employeeId)}&from=${from}&to=${to}`),
    onSuccess: (r) => {
      setErr(null)
      setRows(r.days.map((d) => {
        const locked = d.existing ? `Already recorded (${human(d.existing.status ?? '')}${d.existing.state === 'submitted' ? ', waiting for the CEO' : ''})`
          : d.future ? 'Still to come' : !d.employed ? 'Not employed' : null
        const working = d.kind === 'working'
        return {
          date: d.date, kind: d.kind, locked, shiftId: d.shiftId,
          on: !locked && working,
          status: working ? 'present' : d.kind === 'holiday' ? 'holiday' : 'off_day',
          checkIn: working ? (d.start ?? '') : '', checkOut: working ? (d.end ?? '') : '',
        }
      }))
    },
    onError: (e: Error) => setErr(e.message),
  })
  const chosen = (rows ?? []).filter((r) => r.on && !r.locked)
  const save = useMutation({
    mutationFn: () => api.post<{ created: number; failed: Array<{ date: string; message: string }> }>('/hr/attendance/bulk-days', {
      employeeId, remarks,
      days: chosen.map((r) => ({ date: r.date, status: r.status, checkIn: r.checkIn || null, checkOut: r.checkOut || null, shiftId: r.shiftId })),
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['time-clock-logs'] }) },
    onError: (e: Error) => setErr(e.message),
  })
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs && rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  if (save.data) return <Modal title="Enter days in bulk" wide onClose={onClose}><Done created={save.data.created} failed={save.data.failed} onClose={onClose} /></Modal>
  return (
    <Modal title="Enter days in bulk" wide onClose={onClose} dirty={!!rows}>
      <p className="text-xs text-white/55 mb-3">One person, many days. Each day is prefilled from their rota; change the status or times, untick what to leave out, and send them all to the CEO in one go.</p>
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-[1fr_1fr_auto] items-end">
        <label className="block col-span-2 sm:col-span-3"><span className="block text-[11px] font-bold text-white/55 mb-1">Employee</span>
          <Select className={inp} value={employeeId} onChange={(e) => { setEmployeeId(e.target.value); setRows(null) }}>
            <option value="">Pick a person…</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.employeeCode})</option>)}
          </Select></label>
        <label className="block"><span className="block text-[11px] font-bold text-white/55 mb-1">From</span>
          <input type="date" className={inp} value={from} max={karachiToday()} onChange={(e) => { setFrom(e.target.value); setRows(null) }} /></label>
        <label className="block"><span className="block text-[11px] font-bold text-white/55 mb-1">To</span>
          <input type="date" className={inp} value={to} max={karachiToday()} onChange={(e) => { setTo(e.target.value); setRows(null) }} /></label>
        <button type="button" className={btn} disabled={!employeeId || !from || !to || load.isPending} onClick={() => load.mutate()}>{load.isPending ? 'Loading…' : 'Show days'}</button>
      </div>

      {rows && (
        <div className="mt-4 space-y-3">
          <div className="overflow-x-auto rounded-xl" style={card}>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wider text-white/45">
                <th className="px-2 py-2 w-8"><span className="sr-only">Include</span></th><th className="px-2 py-2">Day</th>
                <th className="px-2 py-2">Status</th><th className="px-2 py-2">In</th><th className="px-2 py-2">Out</th>
              </tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.date} className="border-t border-white/5" style={{ opacity: r.locked ? 0.5 : 1 }}>
                    <td className="px-2 py-1.5"><input type="checkbox" className="h-4 w-4 accent-primary" aria-label={`Include ${r.date}`} disabled={!!r.locked} checked={r.on} onChange={(e) => set(i, { on: e.target.checked })} /></td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <span className="block font-semibold text-white/80">{dayLabel(r.date)}</span>
                      <span className="block text-[11px] text-white/50">{r.locked ?? KIND_LABEL[r.kind]}</span></td>
                    <td className="px-2 py-1.5 w-[9rem]">
                      <Select className={inp} aria-label={`Status ${r.date}`} value={r.status} disabled={!!r.locked || !r.on} onChange={(e) => set(i, { status: e.target.value })}>
                        {statuses.map((s) => <option key={s} value={s}>{human(s)}</option>)}
                      </Select></td>
                    <td className="px-2 py-1.5 w-[7.5rem]"><input type="time" className={`${inp} px-2`} aria-label={`Check-in ${r.date}`} disabled={!!r.locked || !r.on} value={r.checkIn} onChange={(e) => set(i, { checkIn: e.target.value })} /></td>
                    <td className="px-2 py-1.5 w-[7.5rem]"><input type="time" className={`${inp} px-2`} aria-label={`Check-out ${r.date}`} disabled={!!r.locked || !r.on} value={r.checkOut} onChange={(e) => set(i, { checkOut: e.target.value })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="block"><span className="block text-[11px] font-bold text-white/55 mb-1">Remarks (for every day)</span>
            <input className={inp} value={remarks} maxLength={300} placeholder="e.g. Not checked in — servd release 22 Oct" onChange={(e) => setRemarks(e.target.value)} /></label>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <span className="text-xs text-white/55">{chosen.length} day{chosen.length === 1 ? '' : 's'} ticked</span>
            <button type="button" className={btn} disabled={chosen.length === 0 || remarks.trim().length < 5 || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Sending…' : `Send ${chosen.length} day${chosen.length === 1 ? '' : 's'} for approval`}</button>
          </div>
        </div>
      )}
      {err && <p className="mt-3 text-xs" style={{ color: 'var(--erp-danger)' }}>{err}</p>}
    </Modal>
  )
}

interface PlanPerson { employeeId: string; name: string; code: string; days: number; alreadyRecorded: number; notEmployed: number }

function MarkPresentModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const { data: lookups } = useHrLookups()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(karachiToday())
  const [remarks, setRemarks] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const employees = useMemo(() => (lookups?.employees ?? []).filter((e) => e.status === 'active' || e.status === 'on_leave'), [lookups])
  const shown = employees.filter((e) => !q || `${e.fullName} ${e.employeeCode}`.toLowerCase().includes(q.toLowerCase()))
  const body = () => ({ employeeIds: [...picked], from, to, remarks })

  const preview = useQuery({
    queryKey: ['mark-present-preview', [...picked].sort().join(','), from, to],
    enabled: false,
    queryFn: () => api.post<{ toMark: number; people: PlanPerson[] }>('/hr/attendance/mark-present', { ...body(), remarks: remarks.trim().length >= 5 ? remarks : 'preview only', dryRun: true }),
  })
  const run = useMutation({
    mutationFn: () => api.post<{ created: number; failed: Array<{ employeeId: string; date: string; message: string }>; people: PlanPerson[] }>('/hr/attendance/mark-present', body()),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['time-clock-logs'] }) },
    onError: (e: Error) => setErr(e.message),
  })
  const toggle = (id: string, on: boolean) => setPicked((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n })

  if (run.data) {
    const name = (id: string) => run.data!.people.find((p) => p.employeeId === id)?.name
    return <Modal title="Mark present for dates" wide onClose={onClose}><Done created={run.data.created} failed={run.data.failed.map((f) => ({ ...f, name: name(f.employeeId) }))} onClose={onClose} /></Modal>
  }
  const stale = preview.data && preview.dataUpdatedAt > 0
  return (
    <Modal title="Mark present for dates" wide onClose={onClose} dirty={picked.size > 0}>
      <p className="text-xs text-white/55 mb-3">Every working day on each person&apos;s rota in these dates that has no attendance yet is marked present at the rota&apos;s hours. Weekly offs, holidays, leave and days already recorded are left alone. To set a different status for some days, use Enter days in bulk.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block"><span className="block text-[11px] font-bold text-white/55 mb-1">From</span>
          <input type="date" className={inp} value={from} max={karachiToday()} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="block"><span className="block text-[11px] font-bold text-white/55 mb-1">To</span>
          <input type="date" className={inp} value={to} max={karachiToday()} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <div className="mt-3 rounded-xl p-3" style={card}>
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <input className={`${inp} max-w-[240px]`} placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="flex items-center gap-2 text-xs font-bold text-white/70">
            <input type="checkbox" className="h-4 w-4 accent-primary" checked={shown.length > 0 && shown.every((e) => picked.has(e.id))}
              onChange={(e) => setPicked((s) => { const n = new Set(s); for (const x of shown) { if (e.target.checked) n.add(x.id); else n.delete(x.id) } return n })} />
            Select all {shown.length}
          </label>
          <span className="ml-auto text-xs text-white/55">{picked.size} picked</span>
        </div>
        <div className="max-h-56 overflow-y-auto grid sm:grid-cols-2 gap-x-4 gap-y-1">
          {shown.map((e) => (
            <label key={e.id} className="flex items-center gap-2 text-sm text-white/80">
              <input type="checkbox" className="h-4 w-4 accent-primary" checked={picked.has(e.id)} onChange={(ev) => toggle(e.id, ev.target.checked)} />
              {e.fullName} <span className="text-white/40 text-xs">{e.employeeCode}</span>
            </label>
          ))}
        </div>
      </div>
      <label className="block mt-3"><span className="block text-[11px] font-bold text-white/55 mb-1">Remarks (for every day)</span>
        <input className={inp} value={remarks} maxLength={300} placeholder="e.g. Not checked in — servd release 22 Oct" onChange={(e) => setRemarks(e.target.value)} /></label>

      {stale && (
        <div className="mt-3 rounded-xl p-3 text-sm" style={card}>
          <p className="font-bold text-white/85">{preview.data!.toMark} day{preview.data!.toMark === 1 ? '' : 's'} will be marked present</p>
          <ul className="mt-1 text-xs text-white/60 space-y-0.5 max-h-40 overflow-y-auto">
            {preview.data!.people.map((p) => (
              <li key={p.employeeId}>{p.name}: {p.days} day{p.days === 1 ? '' : 's'}{p.alreadyRecorded ? ` · ${p.alreadyRecorded} already recorded` : ''}{p.notEmployed ? ` · ${p.notEmployed} before joining / after leaving` : ''}</li>
            ))}
          </ul>
        </div>
      )}
      {(err || preview.error) && <p className="mt-3 text-xs" style={{ color: 'var(--erp-danger)' }}>{err ?? (preview.error as Error).message}</p>}
      <div className="mt-4 flex flex-wrap justify-end gap-3">
        <button type="button" className={btnGhost} disabled={picked.size === 0 || preview.isFetching} onClick={() => { setErr(null); void preview.refetch() }}>{preview.isFetching ? 'Checking…' : 'Preview'}</button>
        <button type="button" className={btn} disabled={!stale || picked.size === 0 || remarks.trim().length < 5 || run.isPending || preview.data!.toMark === 0} onClick={() => run.mutate()}>
          {run.isPending ? 'Sending…' : `Send ${preview.data?.toMark ?? 0} days for approval`}</button>
      </div>
    </Modal>
  )
}
