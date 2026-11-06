'use client'
// "Mark in bulk" for intern attendance: pick interns, a date range (≤ 62 days) and a status. The answer lists what was
// created, updated and skipped — and why (POST /hr/interns/attendance/bulk).

import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { btn, btnGhost, inp } from '../../../lib/hr'
import {
  ATTENDANCE_FALLBACK_LABEL, ATTENDANCE_STATUS_ORDER, SKIP_REASON, apiErrors, daysOfMonth, pktToday, shortDate, useInternLookups, type AttendanceStatus,
} from '../../../lib/interns'
import { Select } from '@/components/ui/Select'
import { Modal } from '../HrShell'
import { ErrorBox } from './ui'
import type { AttendanceIntern } from './AttendanceTab'

interface BulkResult { created: number; updated: number; skipped: Array<{ internId: string; date: string; reason: string }> }

export function BulkInternAttendance({ interns, month, onClose }: { interns: AttendanceIntern[]; month: string; onClose: () => void }) {
  const qc = useQueryClient()
  const { data: lk } = useInternLookups()
  const today = pktToday()
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [find, setFind] = useState('')
  const monthDays = daysOfMonth(month)
  const [from, setFrom] = useState(monthDays[0]! > today ? today : monthDays[0]!)
  const [to, setTo] = useState(monthDays[monthDays.length - 1]! > today ? today : monthDays[monthDays.length - 1]!)
  const [status, setStatus] = useState<AttendanceStatus>('present')
  const [note, setNote] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState<BulkResult | null>(null)
  const shown = useMemo(() => interns.filter((i) => !find.trim() || `${i.fullName} ${i.internCode}`.toLowerCase().includes(find.trim().toLowerCase())), [interns, find])
  const nameOf = (id: string) => interns.find((i) => i.id === id)
  const run = useMutation({
    mutationFn: () => api.post<BulkResult>('/hr/interns/attendance/bulk', { internIds: [...sel], from, to, status, overwrite, ...(note.trim() && { note: note.trim() }) }),
    onSuccess: (r) => { setResult(r); setErr(''); void qc.invalidateQueries({ queryKey: ['intern-attendance'] }); void qc.invalidateQueries({ queryKey: ['intern'] }) },
    onError: (e) => setErr(apiErrors(e).message),
  })
  const label = (s: AttendanceStatus) => lk?.attendanceLabels[s] ?? ATTENDANCE_FALLBACK_LABEL[s]
  const toggle = (id: string) => setSel((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const bad = !sel.size ? 'Pick at least one intern' : !from || !to ? 'Pick the dates' : to < from ? 'The end date is before the start date' : ''

  if (result) {
    const byReason = result.skipped.reduce<Record<string, number>>((a, s) => ({ ...a, [s.reason]: (a[s.reason] ?? 0) + 1 }), {})
    return (
      <Modal title="Bulk attendance — result" onClose={onClose}>
        <div className="space-y-3">
          <p className="text-sm font-bold text-success">{result.created} day{result.created === 1 ? '' : 's'} created, {result.updated} updated.</p>
          {result.skipped.length > 0 && (
            <div className="rounded-lg p-3 text-xs space-y-2" style={{ border: '1px solid color-mix(in srgb, var(--erp-warning) 40%, transparent)' }}>
              <p className="font-bold text-white/85">{result.skipped.length} skipped</p>
              <ul className="space-y-0.5 text-white/75">
                {Object.entries(byReason).map(([r, n]) => <li key={r}>{n} × {SKIP_REASON[r] ?? r}</li>)}
              </ul>
              <details>
                <summary className="cursor-pointer font-bold text-white/75">Show each one</summary>
                <ul className="mt-1 max-h-48 overflow-y-auto space-y-0.5 text-white/70">
                  {result.skipped.slice(0, 200).map((s, k) => <li key={k}>{nameOf(s.internId)?.fullName ?? s.internId} · {shortDate(s.date)} — {SKIP_REASON[s.reason] ?? s.reason}</li>)}
                  {result.skipped.length > 200 && <li>…and {result.skipped.length - 200} more</li>}
                </ul>
              </details>
            </div>
          )}
          <div className="flex justify-end"><button type="button" className={btn} onClick={onClose}>Close</button></div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Mark attendance in bulk" wide onClose={onClose} dirty={sel.size > 0}>
      <form className="grid md:grid-cols-2 gap-5" noValidate onSubmit={(e) => { e.preventDefault(); if (!bad && !run.isPending) run.mutate() }}>
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <p className="text-[11px] font-black uppercase tracking-wider text-white/55">Interns ({sel.size} picked)</p>
            <span className="flex gap-3 text-xs font-bold">
              <button type="button" className="text-primary-ink" onClick={() => setSel(new Set([...sel, ...shown.map((i) => i.id)]))}>Select all</button>
              <button type="button" className="text-white/60" onClick={() => setSel(new Set())}>None</button>
            </span>
          </div>
          <input type="search" className={`${inp} mb-2`} placeholder="Find an intern" aria-label="Find an intern" value={find} onChange={(e) => setFind(e.target.value)} />
          <ul className="max-h-64 overflow-y-auto rounded-lg border border-white/10 divide-y divide-white/[0.05]">
            {shown.map((i) => (
              <li key={i.id}>
                <label className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer [@media(pointer:coarse)]:min-h-[44px]">
                  <input type="checkbox" className="h-4 w-4" checked={sel.has(i.id)} onChange={() => toggle(i.id)} />
                  <span className="min-w-0 break-words"><span className="font-bold text-white/90">{i.fullName}</span> <span className="text-xs text-white/50">{i.internCode}</span></span>
                </label>
              </li>
            ))}
            {shown.length === 0 && <li className="px-3 py-3 text-xs text-white/50">No intern matches.</li>}
          </ul>
        </div>
        <div className="space-y-3 min-w-0">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] font-bold text-white/55">From<input type="date" className={`${inp} mt-1`} value={from} max={today} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="text-[11px] font-bold text-white/55">To<input type="date" className={`${inp} mt-1`} value={to} max={today} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
          <label className="block text-[11px] font-bold text-white/55">Status
            <Select className={`${inp} mt-1`} value={status} onChange={(e) => setStatus(e.target.value as AttendanceStatus)}>
              {ATTENDANCE_STATUS_ORDER.map((s) => <option key={s} value={s}>{label(s)}</option>)}
            </Select>
          </label>
          <label className="block text-[11px] font-bold text-white/55">Note (optional)<input className={`${inp} mt-1`} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <label className="flex items-start gap-2 text-sm text-white/80 cursor-pointer"><input type="checkbox" className="h-4 w-4 mt-0.5" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
            <span>Replace marked days<span className="block text-[11px] text-white/50">Off: a day that already has a status is left alone.</span></span></label>
          <p className="text-[11px] text-white/55">Up to 62 days at a time. Days outside the internship, in the future, not working days (unless Weekly off) or in a stipend payroll that has left draft are skipped and listed after.</p>
          <ErrorBox message={err} />
          {bad && sel.size > 0 && <p className="text-xs" style={{ color: 'var(--erp-warning)' }}>{bad}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={btn} disabled={!!bad || run.isPending}>{run.isPending ? 'Marking…' : `Mark ${sel.size} intern${sel.size === 1 ? '' : 's'}`}</button>
            <button type="button" className={btnGhost} onClick={onClose}>Cancel</button>
          </div>
        </div>
      </form>
    </Modal>
  )
}
