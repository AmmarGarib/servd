'use client'
// HR reports — Danish's four formats (Employee Master, Lifecycle & Dues,
// Attendance & Leaves, Payroll Report). The columns, their order and the
// Excel layout come from the API (backend hr/reports.ts), never from here.
// Month totals for attendance and payroll are read from the time clock and
// the payroll run — this page only shows them.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { card, inp, btn, btnGhost, localDate } from '../../../lib/hr'
import { HrShell } from '../../../components/hr/HrShell'
import { Select } from '@/components/ui/Select'

type Param = 'month' | 'status' | 'department' | 'location'
interface ReportDef { key: string; title: string; description: string; params: Param[]; columns?: string[] }
interface ReportTable { title: string; sheetTitle?: string; header: string[]; rows: unknown[][]; total: number; note?: string; totalsRow?: boolean; month?: string }
interface LocationLite { id: string; name: string }

const STATUSES = ['active', 'on_leave', 'resigned', 'terminated', 'separated', 'transferred']
const human = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

export default function HrReportsPage() {
  const { data: reports = [], error } = useQuery({ queryKey: ['hr-reports'], queryFn: () => api.get<ReportDef[]>('/hr/reports') })
  const { data: locations = [] } = useQuery({ queryKey: ['locations'], queryFn: () => api.get<LocationLite[]>('/locations') })
  const [key, setKey] = useState<string | null>(null)
  const [q, setQ] = useState({ month: localDate().slice(0, 7), status: '', location: '' })
  const def = reports.find((r) => r.key === key) ?? reports[0] ?? null

  const qs = useMemo(() => {
    if (!def) return ''
    const p = new URLSearchParams()
    if (def.params.includes('month') && q.month) p.set('month', q.month)
    if (def.params.includes('status') && q.status) p.set('status', q.status)
    if (def.params.includes('location') && q.location) p.set('location', q.location)
    const s = p.toString()
    return s ? `?${s}` : ''
  }, [def, q])

  const preview = useQuery({
    queryKey: ['hr-report', def?.key, qs],
    queryFn: () => api.get<ReportTable>(`/hr/reports/${def!.key}${qs}`),
    enabled: !!def,
  })
  const [dlErr, setDlErr] = useState<string | null>(null)

  return (
    <HrShell title="HR reports" subtitle="The four HR formats. Attendance comes from the time clock; payroll is read from the month's payroll run.">
      {error && <p className="text-sm text-s-red mb-4" role="alert">{(error as Error).message}</p>}
      <div className="flex flex-wrap gap-1 mb-5">
        {reports.map((r) => (
          <button key={r.key} type="button" aria-pressed={def?.key === r.key} onClick={() => setKey(r.key)}
            className={`rounded-full px-3 py-1.5 text-xs font-bold whitespace-nowrap [@media(pointer:coarse)]:min-h-[44px] ${def?.key === r.key ? 'bg-primary text-primary-on' : 'text-white/50 border border-white/10'}`}>
            {r.title}
          </button>
        ))}
      </div>

      {def && (
        <div className="space-y-4 min-w-0">
          <div className="rounded-2xl p-4" style={card}>
            <p className="text-lg font-black text-white/90">{def.title}</p>
            <p className="text-xs text-white/45 mt-0.5">{def.description}</p>
            <div className="flex flex-wrap items-end gap-3 mt-4">
              {def.params.includes('month') && (
                <Field label="Month"><input type="month" className={inp} value={q.month} placeholder="YYYY-MM" pattern="\d{4}-\d{2}" onChange={(e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) setQ({ ...q, month: e.target.value }) }} /></Field>
              )}
              {def.params.includes('status') && (
                <Field label="Status">
                  <Select className={inp} value={q.status} onChange={(e) => setQ({ ...q, status: e.target.value })} aria-label="Status">
                    <option value="">All statuses</option>
                    {STATUSES.map((s) => <option key={s} value={s}>{human(s)}</option>)}
                  </Select>
                </Field>
              )}
              {def.params.includes('location') && (
                <Field label="Location">
                  <Select className={inp} value={q.location} onChange={(e) => setQ({ ...q, location: e.target.value })} aria-label="Location">
                    <option value="">All locations</option>
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </Select>
                </Field>
              )}
              <button className={btn} onClick={() => {
                setDlErr(null)
                api.download(`/hr/reports/${def.key}.xlsx${qs}`, `hr-${def.key.replace(/_/g, '-')}${def.params.includes('month') ? `-${q.month}` : ''}.xlsx`).catch((e: Error) => setDlErr(e.message))
              }}>Download Excel</button>
              <button className={btnGhost} onClick={() => void preview.refetch()}>Refresh</button>
            </div>
            {dlErr && <p className="text-xs text-s-red mt-2">{dlErr}</p>}
          </div>

          {preview.error && <p className="text-sm text-s-red" role="alert">{(preview.error as Error).message}{' '}<button type="button" className="underline font-bold" onClick={() => void preview.refetch()}>Retry</button></p>}
          {preview.isLoading && <p className="text-sm text-white/40" role="status">Loading…</p>}
          {preview.data && <ReportView t={preview.data} />}
        </div>
      )}
    </HrShell>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block min-w-[150px]"><span className="block text-[11px] font-bold text-white/55 mb-1">{label}</span>{children}</label>
}

function ReportView({ t }: { t: ReportTable }) {
  const cell = (v: unknown) => (v == null || v === '' ? '' : Array.isArray(v) ? v.join(', ') : String(v))
  const lastIsTotals = !!t.totalsRow
  return (
    <div className="rounded-2xl overflow-hidden" style={card}>
      <div className="flex items-baseline justify-between gap-3 px-4 py-3 border-b border-white/[0.06]">
        <p className="text-sm font-black text-white/85">{t.sheetTitle ?? t.title}</p>
        <p className="text-xs text-white/40">{t.total} row{t.total === 1 ? '' : 's'}{t.total > t.rows.length ? ` · showing ${t.rows.length}, download for all` : ''}</p>
      </div>
      {t.note && <p className="px-4 py-2 text-xs text-s-amber border-b border-white/[0.06]">{t.note}</p>}
      {t.rows.length === 0
        ? <p className="p-8 text-center text-sm text-white/40">Nothing to show.</p>
        : (
          <div className="overflow-x-auto max-h-[65vh]">
            <table className="w-full text-xs">
              <thead className="sticky top-0" style={{ background: 'var(--surface)' }}>
                <tr>{t.header.map((h) => <th key={h} className="px-3 py-2 text-left font-bold text-white/45 whitespace-nowrap">{h}</th>)}</tr>
              </thead>
              <tbody>
                {t.rows.map((r, i) => (
                  <tr key={i} className={`border-t border-white/[0.04] ${lastIsTotals && i === t.rows.length - 1 ? 'font-black' : ''}`}>
                    {r.map((v, j) => <td key={j} className="px-3 py-1.5 text-white/75 whitespace-nowrap">{cell(v)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}
