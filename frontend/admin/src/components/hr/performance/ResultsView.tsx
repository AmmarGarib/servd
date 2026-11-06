'use client'
// HR's Results dashboard: filters, nine analytics blocks and the employee list.

import Link from 'next/link'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { card, day } from '../../../lib/hr'
import { Stat, useHrOrg } from '../HrShell'
import { Select } from '../../ui/Select'
import { ExportMenu } from '../../ui/ExportMenu'
import { ChartCard, HBars, LineChart, PairedBars } from './charts'
import { CATEGORY_TONE, Field, ProgressBar, StatusChip, bpOf, errMsg, inputCls, pctOf, ratingText, usePerfCycles } from './shared'

interface Results {
  cycles: Array<{ id: string; name: string; periodFrom: string; periodTo: string; status: string }>
  cycle: { id: string; name: string; periodFrom: string; periodTo: string; selfWeightBp: number } | null
  overview: { eligible: number; assigned: number; notAssigned: number; submitted: number; pendingEmployee: number; pendingManager: number; finalized: number; averageFinal: number | null; averageSelf: number | null; averageManager: number | null }
  distribution: Array<{ category: string; label: string; count: number; pct: number }>
  departments: Array<{ departmentId: string | null; name: string; count: number; averageFinal: number | null; averageSelf: number | null; averageManager: number | null }>
  selfVsManager: Array<{ evaluationId: string; employeeId: string; name: string; code: string; selfScore: number; managerScore: number; gap: number }>
  areas: Array<{ key: string; label: string; weightBp: number; averageSelf: number | null; averageManager: number | null }>
  strongest: Array<{ key: string; label: string; averageManager: number | null }>
  weakest: Array<{ key: string; label: string; averageManager: number | null }>
  development: { trainingRequests: Array<{ term: string; count: number }>; skillsToDevelop: Array<{ term: string; count: number }>; challenges: Array<{ term: string; count: number }>; responses: Array<{ name: string; department: string | null; training: string | null; develop: string | null; challenges: string | null; managerTraining: string | null }> }
  managers: Array<{ managerUserId: string; name: string; assigned: number; submitted: number; pendingReview: number; finalized: number }>
  history: Array<{ cycleId: string; name: string; periodTo: string; count: number; averageFinal: number | null; departments: Array<{ name: string; averageFinal: number | null }> }>
  employeeTrend: Array<{ cycleId: string; name: string; finalScore: number | null }> | null
  list: Array<{ evaluationId: string | null; employeeId: string; designationId?: string | null; code: string; name: string; department: string | null; designation: string | null; branch: string | null; manager: string | null; status: string; statusLabel: string; selfScore: number | null; managerScore: number | null; finalScore: number | null; category: string | null; categoryLabel: string | null }>
}
interface Filters { cycleId: string; departmentId: string; managerUserId: string; locationId: string; category: string; status: string; q: string; designation: string; employeeId: string }
const EMPTY: Filters = { cycleId: '', departmentId: '', managerUserId: '', locationId: '', category: '', status: '', q: '', designation: '', employeeId: '' }
const CATEGORY_ORDER = ['exceptional', 'exceeds', 'meets', 'needs_improvement', 'unsatisfactory']

export function ResultsView() {
  const [f, setF] = useState<Filters>(EMPTY)
  const q = useDeferredValue(f.q)
  const { data: cy } = usePerfCycles()
  const { data: org } = useHrOrg()
  const qs = useMemo(() => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({ cycleId: f.cycleId, departmentId: f.departmentId, designationId: f.designation, managerUserId: f.managerUserId, locationId: f.locationId, category: f.category, status: f.status, q, employeeId: f.employeeId })) if (v) p.set(k, v)
    return p.toString()
  }, [f, q])
  const { data, isLoading, error, isFetching } = useQuery({ queryKey: ['perf-results', qs], queryFn: () => api.get<Results>(`/hr/performance/admin/results${qs ? `?${qs}` : ''}`), placeholderData: (prev) => prev })
  // Designation options (id → name) are remembered from the rows, like the managers below.
  const [desOpts, setDesOpts] = useState<Record<string, string>>({})
  useEffect(() => { if (data) setDesOpts((m) => ({ ...m, ...Object.fromEntries(data.list.filter((r) => r.designationId && r.designation).map((r) => [r.designationId!, r.designation!])) })) }, [data])
  // Manager options come from the data; remember them so a manager filter doesn't empty its own drop-down.
  const [mgrOpts, setMgrOpts] = useState<Record<string, string>>({})
  useEffect(() => { if (data) setMgrOpts((m) => ({ ...m, ...Object.fromEntries(data.managers.map((x) => [x.managerUserId, x.name])) })) }, [data])
  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))
  const filtered = Object.entries(f).some(([k, v]) => v && k !== 'cycleId')

  if (error && !data) return <p className="text-sm text-s-red" role="alert">{errMsg(error)}</p>
  if (isLoading && !data) return <p className="text-sm text-white/50" role="status">Loading results…</p>
  if (!data) return null
  if (data.cycles.length === 0) return <div className="rounded-2xl p-8 text-center" style={card}><p className="text-sm text-white/75">No evaluation cycle exists yet. Create one on the Cycles tab, then managers can assign evaluations.</p></div>

  const designations = Object.entries(desOpts).sort((a, b) => a[1].localeCompare(b[1]))
  const list = data.list
  const o = data.overview
  const maxDept = 10000
  const gaps = data.selfVsManager.slice(0, 8)
  const maxGap = Math.max(1, ...gaps.map((g) => Math.abs(g.gap)))

  return (
    <div className="space-y-6" aria-busy={isFetching}>
      {/* Filters */}
      <div className="rounded-2xl p-4" style={card}>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Field label="Cycle"><Select className={inputCls} value={f.cycleId || data.cycle?.id || ''} onChange={set('cycleId')}>{data.cycles.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <Field label="Department"><Select className={inputCls} value={f.departmentId} onChange={set('departmentId')}><option value="">All</option>{(org?.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
          <Field label="Designation"><Select className={inputCls} value={f.designation} onChange={set('designation')}><option value="">All</option>{designations.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select></Field>
          <Field label="Reporting manager"><Select className={inputCls} value={f.managerUserId} onChange={set('managerUserId')}><option value="">All</option>{Object.entries(mgrOpts).sort((a, b) => a[1].localeCompare(b[1])).map(([id, n]) => <option key={id} value={id}>{n}</option>)}</Select></Field>
          <Field label="Branch"><Select className={inputCls} value={f.locationId} onChange={set('locationId')}><option value="">All</option>{(org?.locations ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
          <Field label="Category"><Select className={inputCls} value={f.category} onChange={set('category')}><option value="">All</option>{CATEGORY_ORDER.map((c) => <option key={c} value={c}>{cy?.categoryLabels[c] ?? c}</option>)}</Select></Field>
          <Field label="Status"><Select className={inputCls} value={f.status} onChange={set('status')}><option value="">All</option>{Object.entries(cy?.statusLabels ?? {}).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="Search"><input className={inputCls} placeholder="Name or ID" value={f.q} onChange={set('q')} /></Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
          <div className="flex items-center gap-3 text-xs text-white/65">
            {data.cycle && <span>{data.cycle.name} · {day(data.cycle.periodFrom)} – {day(data.cycle.periodTo)} · {bpOf(data.cycle.selfWeightBp)} self / {bpOf(10000 - data.cycle.selfWeightBp)} manager</span>}
            {(filtered || f.cycleId) && <button className="underline text-primary-ink font-bold min-h-[32px]" onClick={() => setF(EMPTY)}>Reset filters</button>}
          </div>
          <ExportMenu path={`/hr/performance/admin/results${qs ? `?${qs}` : ''}`} filename="evaluation-results" formats={['pdf', 'xlsx', 'csv']} />
        </div>
      </div>

      {/* A overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Eligible employees" value={o.eligible} /><Stat label="Assigned" value={o.assigned} /><Stat label="Not assigned" value={o.notAssigned} tone={o.notAssigned ? 'warn' : undefined} />
        <Stat label="Submitted" value={o.submitted} /><Stat label="Pending employee" value={o.pendingEmployee} tone={o.pendingEmployee ? 'warn' : undefined} /><Stat label="Pending manager" value={o.pendingManager} tone={o.pendingManager ? 'warn' : undefined} />
        <Stat label="Finalized" value={o.finalized} tone="good" /><Stat label="Average final" value={pctOf(o.averageFinal)} tone="good" />
        <Stat label="Average self" value={pctOf(o.averageSelf)} /><Stat label="Average manager" value={pctOf(o.averageManager)} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* B */}
        <ChartCard title="Performance categories" hint="Finalized evaluations">
          <HBars max={Math.max(1, ...data.distribution.map((d) => d.count))} rows={data.distribution.map((d) => ({ label: d.label, value: d.count, display: `${d.count} · ${d.pct}%`, tone: CATEGORY_TONE[d.category] }))} />
        </ChartCard>
        {/* C */}
        <ChartCard title="Department comparison" hint="Average final score">
          <HBars max={maxDept} empty="No finalized evaluations in these departments yet."
            rows={data.departments.filter((d) => d.averageFinal != null).sort((a, b) => (b.averageFinal ?? 0) - (a.averageFinal ?? 0)).map((d) => ({ label: d.name, sub: `${d.count} people`, value: d.averageFinal ?? 0, display: pctOf(d.averageFinal), tone: 'var(--erp-primary)' }))} />
        </ChartCard>
        {/* D */}
        <ChartCard title="Self vs manager" hint="Average scores by department">
          <PairedBars aLabel="Self" bLabel="Manager" max={maxDept} fmt={pctOf}
            rows={[{ label: 'Everyone', a: o.averageSelf, b: o.averageManager }, ...data.departments.filter((d) => d.averageSelf != null || d.averageManager != null).map((d) => ({ label: d.name, a: d.averageSelf, b: d.averageManager }))]} />
          <p className="text-xs font-black text-white/70 mt-4 mb-2">Biggest gaps (self − manager)</p>
          {gaps.length === 0 ? <p className="text-sm text-white/55">No finalized evaluations yet.</p> : (
            <ul className="space-y-2">
              {gaps.map((g) => {
                const over = g.gap > 0
                const tone = over ? 'var(--erp-danger)' : 'var(--erp-success)'
                return (
                  <li key={g.evaluationId}>
                    <div className="flex justify-between gap-2 text-xs"><Link href={`/hr/me/team-evaluations/${g.evaluationId}`} className="font-bold text-white/85 underline-offset-2 hover:underline break-words">{g.name}</Link><span className="font-black shrink-0" style={{ color: tone }}>{over ? 'Over-rated' : 'Under-rated'} {g.gap > 0 ? '+' : '−'}{(Math.abs(g.gap) / 100).toFixed(1)} pts</span></div>
                    <div className="mt-1"><ProgressBar value={Math.abs(g.gap)} max={maxGap} tone={tone} label={`Gap for ${g.name}`} /></div>
                  </li>
                )
              })}
            </ul>
          )}
        </ChartCard>
        {/* E */}
        <ChartCard title="Performance areas" hint="Average rating out of 5">
          <PairedBars aLabel="Self" bLabel="Manager" max={5} fmt={ratingText} rows={data.areas.map((a) => ({ label: `${a.label} (${bpOf(a.weightBp)})`, a: a.averageSelf, b: a.averageManager }))} />
          <div className="grid sm:grid-cols-2 gap-3 mt-4">
            <div className="rounded-xl p-3" style={{ background: 'rgb(var(--erp-accent-rgb) / 0.14)' }}>
              <p className="text-xs font-black text-success mb-1">Strongest</p>
              {data.strongest.length === 0 ? <p className="text-xs text-white/55">—</p> : <ul className="text-xs text-white/85 space-y-0.5">{data.strongest.map((a) => <li key={a.key}>{a.label} · {ratingText(a.averageManager)}</li>)}</ul>}
            </div>
            <div className="rounded-xl p-3" style={{ background: 'rgb(var(--fg-rgb) / 0.05)', border: '1px solid var(--erp-warning)' }}>
              <p className="text-xs font-black mb-1" style={{ color: 'var(--erp-warning)' }}>Needs attention</p>
              {data.weakest.length === 0 ? <p className="text-xs text-white/55">—</p> : <ul className="text-xs text-white/85 space-y-0.5">{data.weakest.map((a) => <li key={a.key}>{a.label} · {ratingText(a.averageManager)}</li>)}</ul>}
            </div>
          </div>
        </ChartCard>
      </div>

      {/* F */}
      <ChartCard title="Training & development" hint="Most common words across employee and manager answers">
        <div className="grid md:grid-cols-3 gap-4">
          {([['Training requests', data.development.trainingRequests], ['Skills to develop', data.development.skillsToDevelop], ['Challenges', data.development.challenges]] as const).map(([title, terms]) => (
            <div key={title}>
              <p className="text-xs font-black text-white/70 mb-2">{title}</p>
              {terms.length === 0 ? <p className="text-xs text-white/55">None yet.</p> : (
                <ul className="flex flex-wrap gap-1.5">{terms.map((t) => <li key={t.term} className="s-badge-purple">{t.term} · {t.count}</li>)}</ul>
              )}
            </div>
          ))}
        </div>
        {data.development.responses.length > 0 && (
          <details className="mt-4">
            <summary className="text-sm font-bold text-primary-ink cursor-pointer min-h-[32px]">All responses ({data.development.responses.length})</summary>
            <ul className="mt-2 space-y-2 max-h-96 overflow-y-auto">
              {data.development.responses.map((r, i) => (
                <li key={i} className="text-xs rounded-lg p-3 text-white/80" style={{ border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
                  <p className="font-black text-white/90">{r.name}{r.department ? ` · ${r.department}` : ''}</p>
                  {r.training && <p><b className="text-white/55">Training wanted: </b>{r.training}</p>}
                  {r.develop && <p><b className="text-white/55">To develop: </b>{r.develop}</p>}
                  {r.challenges && <p><b className="text-white/55">Challenges: </b>{r.challenges}</p>}
                  {r.managerTraining && <p><b className="text-white/55">Manager recommends: </b>{r.managerTraining}</p>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </ChartCard>

      {/* G */}
      <ChartCard title="Manager-wise progress">
        {data.managers.length === 0 ? <p className="text-sm text-white/55">No evaluations assigned in this cycle yet.</p> : (
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full text-sm min-w-[520px]">
              <thead><tr className="text-left text-[11px] uppercase tracking-wider text-white/55"><th className="py-1.5 pr-2">Manager</th><th className="pr-2">Assigned</th><th className="pr-2">Submitted</th><th className="pr-2">To review</th><th className="pr-2">Finalized</th><th className="w-32">Progress</th></tr></thead>
              <tbody>{data.managers.map((m) => (
                <tr key={m.managerUserId} className="border-t border-white/[0.05]">
                  <td className="py-2 pr-2 font-bold text-white/90">{m.name}</td><td className="pr-2">{m.assigned}</td><td className="pr-2">{m.submitted}</td>
                  <td className="pr-2" style={m.pendingReview ? { color: 'var(--erp-warning)', fontWeight: 800 } : undefined}>{m.pendingReview}</td><td className="pr-2">{m.finalized}</td>
                  <td><ProgressBar value={m.finalized} max={m.assigned} tone="var(--erp-accent)" label={`${m.name} finalized`} /></td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </ChartCard>

      {/* H */}
      <div className="grid lg:grid-cols-2 gap-4">
        <ChartCard title="History" hint="Average final score per cycle">
          <LineChart fmt={pctOf} points={data.history.map((h) => ({ label: h.name, value: h.averageFinal }))} />
          {data.history.some((h) => h.departments.length) && (
            <div className="overflow-x-auto -mx-4 px-4 mt-3">
              <table className="w-full text-xs min-w-[320px]">
                <thead><tr className="text-left text-[11px] uppercase tracking-wider text-white/55"><th className="py-1 pr-2">Department</th>{data.history.map((h) => <th key={h.cycleId} className="pr-2">{h.name}</th>)}</tr></thead>
                <tbody>{[...new Set(data.history.flatMap((h) => h.departments.map((d) => d.name)))].map((n) => (
                  <tr key={n} className="border-t border-white/[0.05]"><td className="py-1.5 pr-2 font-bold text-white/85">{n}</td>{data.history.map((h) => <td key={h.cycleId} className="pr-2">{pctOf(h.departments.find((d) => d.name === n)?.averageFinal)}</td>)}</tr>))}</tbody>
              </table>
            </div>
          )}
        </ChartCard>
        <ChartCard title="Employee trend" hint="Pick an employee from the list below">
          {data.employeeTrend ? (
            <>
              <p className="text-xs text-white/70 mb-2">{data.list.find((r) => r.employeeId === f.employeeId)?.name ?? 'Selected employee'} <button className="underline text-primary-ink font-bold ml-2" onClick={() => setF((x) => ({ ...x, employeeId: '' }))}>Clear</button></p>
              <LineChart fmt={pctOf} points={data.employeeTrend.map((t) => ({ label: t.name, value: t.finalScore }))} />
            </>
          ) : <p className="text-sm text-white/55">Choose “Trend” on an employee row to see their scores cycle by cycle.</p>}
        </ChartCard>
      </div>

      {/* Employee list */}
      <ChartCard title={`Employees (${list.length})`}>
        {list.length === 0 ? <p className="text-sm text-white/55">No employees match these filters.</p> : (
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full text-sm min-w-[860px]">
              <thead><tr className="text-left text-[11px] uppercase tracking-wider text-white/55"><th className="py-1.5 pr-2">Employee</th><th className="pr-2">Department</th><th className="pr-2">Manager</th><th className="pr-2">Status</th><th className="pr-2 text-right">Self</th><th className="pr-2 text-right">Manager</th><th className="pr-2 text-right">Final</th><th className="pr-2">Category</th><th /></tr></thead>
              <tbody>{list.map((r) => (
                <tr key={r.employeeId} className="border-t border-white/[0.05]">
                  <td className="py-2 pr-2">{r.evaluationId ? <Link href={`/hr/me/team-evaluations/${r.evaluationId}`} className="font-bold text-white/90 hover:underline">{r.name}</Link> : <span className="font-bold text-white/90">{r.name}</span>}<span className="block text-[11px] text-white/50">{r.code}{r.designation ? ` · ${r.designation}` : ''}</span></td>
                  <td className="pr-2 text-white/75">{r.department ?? '—'}</td><td className="pr-2 text-white/75">{r.manager ?? '—'}</td>
                  <td className="pr-2"><StatusChip status={r.status} label={r.statusLabel} /></td>
                  <td className="pr-2 text-right">{pctOf(r.selfScore)}</td><td className="pr-2 text-right">{pctOf(r.managerScore)}</td><td className="pr-2 text-right font-black">{pctOf(r.finalScore)}</td>
                  <td className="pr-2 font-bold" style={{ color: r.category ? CATEGORY_TONE[r.category] : undefined }}>{r.categoryLabel ?? '—'}</td>
                  <td><button className="text-xs font-bold text-primary-ink underline min-h-[32px]" onClick={() => { setF((x) => ({ ...x, employeeId: r.employeeId })); window.scrollTo?.({ top: 0 }) }}>Trend</button></td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </ChartCard>
    </div>
  )
}
