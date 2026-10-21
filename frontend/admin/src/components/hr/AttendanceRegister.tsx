'use client'
// Attendance register (owner, 2026-10-21): the attendance list in the owner's 16-column format. A view over the
// existing attendance records (GET /hr/attendance/register) — clicking a row opens the record, as the generic list did.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { card } from '../../lib/hr'
import { Select } from '@/components/ui/Select'
import { ExportMenu } from '@/components/ui/ExportMenu'

interface RegisterRow { id: string; manual: boolean; values: string[] }
interface Register { columns: string[]; rows: RegisterRow[] }

const STATUSES: Array<[string, string]> = [
  ['present', 'Present'], ['late', 'Late'], ['absent', 'Absent'], ['half_day', 'Half day'],
  ['missing_punch', 'Missing punch'], ['off_day', 'Off day'], ['holiday', 'Holiday'], ['early_departure', 'Early departure'],
]
/** Columns that hold times or hours: Time In, Time Out, Late In, Early Out, OT Hours. */
const NUMERIC = new Set([6, 7, 8, 9, 10])
const SOURCE = 11
const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export function AttendanceRegister({ onOpen, onExportError }: { onOpen: (id: string) => void; onExportError?: (m: string) => void }) {
  const now = new Date()
  const [from, setFrom] = useState(iso(new Date(now.getFullYear(), now.getMonth(), 1)))
  const [to, setTo] = useState(iso(now))
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const qs = new URLSearchParams({ from, to, ...(status && { status }) }).toString()
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['hr-attendance-register', from, to, status],
    queryFn: () => api.get<Register>(`/hr/attendance/register?${qs}`),
    enabled: !!from && !!to && to >= from,
  })
  const q = search.trim().toLowerCase()
  const rows = useMemo(
    () => (data?.rows ?? []).filter((r) => !q || r.values[3]!.toLowerCase().includes(q) || r.values[4]!.toLowerCase().includes(q)),
    [data, q],
  )
  const field = 'rounded-full px-3 py-1 text-xs bg-white/[0.04] border border-white/10 text-white/70'
  return (
    <>
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <label className="text-[10px] uppercase tracking-wider text-white/40 font-bold flex flex-col gap-1">From
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={field} />
        </label>
        <label className="text-[10px] uppercase tracking-wider text-white/40 font-bold flex flex-col gap-1">To
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={field} />
        </label>
        <label className="text-[10px] uppercase tracking-wider text-white/40 font-bold flex flex-col gap-1">Status
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className={field}>
            <option value="">All statuses</option>
            {STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </label>
        <label className="text-[10px] uppercase tracking-wider text-white/40 font-bold flex flex-col gap-1">Employee
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or ID" className={field} />
        </label>
        <div className="ml-auto">
          <ExportMenu className="s-btn-secondary text-sm" path={`/hr/attendance/register?${qs}`} filename={`attendance-register-${from}-${to}`} onError={onExportError} />
        </div>
      </div>
      {to < from && <p className="text-sm text-s-red mb-4" role="alert">“To” is before “From”.</p>}
      {error && <p className="text-sm text-s-red mb-4" role="alert">{(error as Error).message}{' '}<button type="button" className="underline font-bold" onClick={() => void refetch()}>Retry</button></p>}
      {isLoading && <p className="text-sm text-white/40 py-6 text-center" role="status">Loading…</p>}
      {data && rows.length === 0 && (
        <div className="rounded-2xl p-10 text-center" style={card}>
          <p className="font-bold text-white/85">No attendance in this period</p>
          <p className="text-sm text-white/45 mt-1">Change the dates or filters, or add a day with “+ New”.</p>
        </div>
      )}
      {data && rows.length > 0 && (
        <div className="rounded-2xl overflow-x-auto" style={card}>
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                {data.columns.map((c, i) => <th key={c} className={`px-3 py-3 font-bold ${NUMERIC.has(i) ? 'text-right' : ''}`}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => onOpen(r.id)} className="border-t border-white/[0.05] cursor-pointer hover:bg-white/[0.03]">
                  {r.values.map((v, i) => (
                    <td key={i} className={`px-3 py-3 ${i === 4 ? 'text-white/85 font-bold' : 'text-white/70'} ${NUMERIC.has(i) ? 'text-right tabular-nums' : ''}`}>
                      {v || '—'}
                      {i === SOURCE && r.manual && <span className="s-badge-amber ml-2 text-[10px]">Entered manually</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
