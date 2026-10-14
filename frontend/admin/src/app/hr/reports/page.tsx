'use client'
// HR reports — spec §30. Pick a report, set its dates, preview, download CSV.
// Record-based reports take their columns from the section's current format,
// so they follow whatever the HR team has set up.

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { card, inp, btn, btnGhost, localDate } from '../../../lib/hr'
import { HrShell } from '../../../components/hr/HrShell'

type Param = 'range' | 'asOf' | 'days' | 'period'
interface ReportDef { key: string; title: string; group: string; description: string; params: Param[] }
interface ReportTable { title: string; header: string[]; rows: unknown[][]; total: number; note?: string; link?: { path: string; label: string } }

// Defaults in the local calendar — the UTC date is still yesterday (or last
// month) in Karachi until 05:00.
const today = () => localDate()
const monthStart = () => `${localDate().slice(0, 7)}-01`

export default function HrReportsPage() {
  const { data: reports = [], error } = useQuery({ queryKey: ['hr-reports'], queryFn: () => api.get<ReportDef[]>('/hr/reports') })
  const [key, setKey] = useState<string | null>(null)
  const [q, setQ] = useState({ from: monthStart(), to: today(), asOf: today(), days: '30', period: localDate().slice(0, 7) })
  const def = reports.find((r) => r.key === key) ?? null

  const groups = useMemo(() => {
    const m = new Map<string, ReportDef[]>()
    for (const r of reports) m.set(r.group, [...(m.get(r.group) ?? []), r])
    return Array.from(m.entries())
  }, [reports])

  const qs = useMemo(() => {
    if (!def) return ''
    const p = new URLSearchParams()
    if (def.params.includes('range')) { p.set('from', q.from); p.set('to', q.to) }
    if (def.params.includes('asOf')) p.set('asOf', q.asOf)
    if (def.params.includes('days')) p.set('days', q.days)
    if (def.params.includes('period')) p.set('period', q.period)
    const s = p.toString()
    return s ? `?${s}` : ''
  }, [def, q])

  const preview = useQuery({
    queryKey: ['hr-report', key, qs],
    queryFn: () => api.get<ReportTable>(`/hr/reports/${key}${qs}`),
    enabled: !!key,
  })
  const [dlErr, setDlErr] = useState<string | null>(null)

  return (
    <HrShell title="HR reports" subtitle="Every report in the HR spec. Record-based reports use each section's current format for their columns.">
      {error && <p className="text-sm text-red-700 mb-4">{(error as Error).message}</p>}
      <div className="grid lg:grid-cols-[280px_1fr] gap-5">
        <div className="space-y-4">
          {groups.map(([g, list]) => (
            <div key={g}>
              <p className="text-[11px] font-black uppercase tracking-wider text-white/40 mb-1.5">{g}</p>
              <div className="space-y-1">
                {list.map((r) => (
                  <button key={r.key} onClick={() => setKey(r.key)}
                    className="w-full text-left rounded-lg px-3 py-2 text-sm"
                    style={{ background: key === r.key ? 'rgb(var(--erp-primary-rgb) / 0.12)' : 'transparent', color: key === r.key ? 'var(--erp-primary)' : 'rgb(var(--fg-rgb) / 0.75)' }}>
                    {r.title}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="min-w-0">
          {!def && <div className="rounded-2xl p-10 text-center text-sm text-white/40" style={card}>Pick a report on the left.</div>}
          {def && (
            <div className="space-y-4">
              <div className="rounded-2xl p-4" style={card}>
                <p className="text-lg font-black text-white/90">{def.title}</p>
                <p className="text-xs text-white/45 mt-0.5">{def.description}</p>
                <div className="flex flex-wrap items-end gap-3 mt-4">
                  {def.params.includes('range') && (
                    <>
                      <Field label="From"><input type="date" className={inp} value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} /></Field>
                      <Field label="To"><input type="date" className={inp} value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} /></Field>
                    </>
                  )}
                  {def.params.includes('asOf') && <Field label="As of"><input type="date" className={inp} value={q.asOf} onChange={(e) => setQ({ ...q, asOf: e.target.value })} /></Field>}
                  {def.params.includes('days') && <Field label="Next (days)"><input type="number" min={0} className={inp} value={q.days} onChange={(e) => setQ({ ...q, days: e.target.value })} /></Field>}
                  {def.params.includes('period') && <Field label="Month"><input type="month" className={inp} value={q.period} onChange={(e) => setQ({ ...q, period: e.target.value })} /></Field>}
                  <button className={btn} onClick={() => {
                    setDlErr(null)
                    api.download(`/hr/reports/${def.key}.csv${qs}`, `hr-${def.key.replace(/_/g, '-')}.csv`).catch((e: Error) => setDlErr(e.message))
                  }}>Download CSV</button>
                  <button className={btnGhost} onClick={() => void preview.refetch()}>Refresh</button>
                </div>
                {dlErr && <p className="text-xs text-red-700 mt-2">{dlErr}</p>}
              </div>

              {preview.error && <p className="text-sm text-red-700">{(preview.error as Error).message}</p>}
              {preview.isLoading && <p className="text-sm text-white/40">Loading…</p>}
              {preview.data && <ReportView t={preview.data} />}
            </div>
          )}
        </div>
      </div>
    </HrShell>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block min-w-[150px]"><span className="block text-[11px] font-bold text-white/55 mb-1">{label}</span>{children}</label>
}

function ReportView({ t }: { t: ReportTable }) {
  const cell = (v: unknown) => (v == null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : String(v))
  return (
    <div className="rounded-2xl overflow-hidden" style={card}>
      <div className="flex items-baseline justify-between gap-3 px-4 py-3 border-b border-white/[0.06]">
        <p className="text-sm font-black text-white/85">{t.title}</p>
        <p className="text-xs text-white/40">{t.total} row{t.total === 1 ? '' : 's'}{t.total > t.rows.length ? ` · showing ${t.rows.length}, download for all` : ''}</p>
      </div>
      {t.note && <p className="px-4 py-2 text-xs text-amber-700/90 border-b border-white/[0.06]">{t.note}</p>}
      {t.link && (
        <p className="px-4 py-2 text-xs border-b border-white/[0.06]">
          <Link href={t.link.path} className="font-semibold" style={{ color: 'var(--erp-primary)' }}>{t.link.label} →</Link>
        </p>
      )}
      {t.rows.length === 0
        ? <p className="p-8 text-center text-sm text-white/40">Nothing for these dates.</p>
        : (
          <div className="overflow-x-auto max-h-[65vh]">
            <table className="w-full text-xs">
              <thead className="sticky top-0" style={{ background: 'var(--surface)' }}>
                <tr>{t.header.map((h) => <th key={h} className="px-3 py-2 text-left font-bold text-white/45 whitespace-nowrap">{h}</th>)}</tr>
              </thead>
              <tbody>
                {t.rows.map((r, i) => (
                  <tr key={i} className="border-t border-white/[0.04]">
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
