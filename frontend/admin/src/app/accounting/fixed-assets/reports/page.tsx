'use client'
// Fixed-asset reports: the depreciation schedule, the roll-forward of cost and
// accumulated depreciation, net book value at a date, the tie-out of the
// register to the ledger (green = ties, red = a difference to chase), supplier
// advances still sitting on 1340, and the tax depreciation schedule. Every
// report downloads exactly the rows on screen as CSV.
//
// Tax view: smallwares are listed as "tax treatment to confirm" (accountant
// answer H23). There is no deferred-tax figure anywhere (H24).

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../../lib/api'
import {
  FA_BASE, FaFrame, Notice, Stat, card, inp, btnPrimary, btnGhost, money, moneyExact, fmtDay, fmtMonth, pct, todayIso, errorWords, useFaLookups,
} from '../../../../components/fixedAssets/shared'
import { Select } from '@/components/ui/Select'

type ReportKey = 'schedule' | 'roll' | 'nbv' | 'tie' | 'advances' | 'tax'
const REPORTS: Array<{ key: ReportKey; label: string; about: string }> = [
  { key: 'schedule', label: 'Depreciation schedule', about: 'What has been charged, month by month, and what is still to come.' },
  { key: 'roll', label: 'Roll-forward', about: 'Cost and accumulated depreciation from the start to the end of a period, tied to the ledger.' },
  { key: 'nbv', label: 'Book value at a date', about: 'What the register is worth on a day, by class, brand, outlet or pool.' },
  { key: 'tie', label: 'Tie-out to the ledger', about: 'The register against the ledger. Every difference is a mistake to chase.' },
  { key: 'advances', label: 'Supplier advances (1340)', about: 'Money paid to suppliers for equipment that is not on the register yet.' },
  { key: 'tax', label: 'Tax depreciation', about: 'The Third Schedule view for one tax year, for one company.' },
]

function csvButton(path: string, name: string, onError: (m: string) => void) {
  return (
    <button className={btnGhost} onClick={() => { void api.download(path, name).catch((e) => onError(errorWords(e))) }}>Download CSV</button>
  )
}

export default function ReportsPage() {
  const [which, setWhich] = useState<ReportKey>('schedule')
  const [err, setErr] = useState('')
  const current = REPORTS.find((r) => r.key === which)!
  return (
    <FaFrame title="Reports" subtitle="Every report shows the companies in view and downloads as CSV.">
      <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Reports">
        {REPORTS.map((r) => {
          const on = r.key === which
          return (
            <button key={r.key} role="tab" aria-selected={on} onClick={() => { setWhich(r.key); setErr('') }}
              className="rounded-full px-3 py-1.5 text-xs font-bold whitespace-nowrap"
              style={on
                ? { background: 'rgb(var(--erp-accent-rgb) / 0.2)', color: 'var(--erp-success)', border: '1px solid var(--erp-accent)' }
                : { color: 'rgb(var(--fg-rgb) / 0.6)', border: '1px solid rgb(var(--fg-rgb) / 0.12)' }}>{r.label}</button>
          )
        })}
      </div>
      <p className="text-sm text-white/50 -mt-2">{current.about}</p>
      {err && <Notice tone="bad" onClose={() => setErr('')}>{err}</Notice>}
      {which === 'schedule' && <ScheduleReport onError={setErr} />}
      {which === 'roll' && <RollForwardReport onError={setErr} />}
      {which === 'nbv' && <NbvReport onError={setErr} />}
      {which === 'tie' && <TieOutReport onError={setErr} />}
      {which === 'advances' && <AdvancesReport onError={setErr} />}
      {which === 'tax' && <TaxReport onError={setErr} />}
    </FaFrame>
  )
}

function DiffCell({ cents }: { cents: number }) {
  return cents === 0
    ? <span className="text-success font-bold">Ties</span>
    : <span className="text-s-red font-bold">{moneyExact(cents)}</span>
}

function Loading({ q }: { q: { isLoading: boolean; error: unknown } }) {
  if (q.isLoading) return <p className="text-sm text-white/40">Loading…</p>
  if (q.error) return <Notice tone="bad">{errorWords(q.error)}</Notice>
  return null
}

// ─── Schedule ───────────────────────────────────────────────────────────────

interface ScheduleData {
  from: string; to: string; months: string[]; lastCompletedPeriod: string
  rows: Array<{ tenantId: string; companyName: string; key: string; label: string; period: string; postedCents: number; forecastCents: number }>
  totals: { postedCents: number; forecastCents: number }
}

function ScheduleReport({ onError }: { onError: (m: string) => void }) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [by, setBy] = useState('class')
  const qs = useMemo(() => {
    const p = new URLSearchParams({ groupBy: by })
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    return p.toString()
  }, [from, to, by])
  const q = useQuery<ScheduleData>({ queryKey: ['fa-rep-schedule', qs], queryFn: () => api.get(`${FA_BASE}/reports/schedule?${qs}`) })
  const d = q.data

  const groups = useMemo(() => {
    const m = new Map<string, { label: string; company: string; cells: Map<string, { posted: number; forecast: number }> }>()
    for (const r of d?.rows ?? []) {
      const k = `${r.tenantId}|${r.key}`
      const g = m.get(k) ?? { label: r.label, company: r.companyName, cells: new Map() }
      g.cells.set(r.period, { posted: r.postedCents, forecast: r.forecastCents })
      m.set(k, g)
    }
    return [...m.values()]
  }, [d])
  const multi = new Set((d?.rows ?? []).map((r) => r.tenantId)).size > 1

  return (
    <div className="space-y-4">
      <div className="rounded-2xl p-4 grid grid-cols-2 md:grid-cols-4 gap-3 items-end" style={card}>
        <label className="block"><span className="text-[11px] font-bold text-white/50">From month</span><input type="month" className={inp} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="block"><span className="text-[11px] font-bold text-white/50">To month</span><input type="month" className={inp} value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="block"><span className="text-[11px] font-bold text-white/50">Group by</span>
          <Select className={inp} value={by} onChange={(e) => setBy(e.target.value)}>
            <option value="class">Class</option><option value="brand">Brand</option><option value="location">Outlet</option><option value="pool">Smallwares pool</option><option value="asset">Asset</option>
          </Select></label>
        <div>{csvButton(`${FA_BASE}/reports/schedule?${qs}&format=csv`, 'depreciation-schedule.csv', onError)}</div>
      </div>
      <Loading q={q} />
      {d && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Charged in this range" value={money(d.totals.postedCents)} tone="good" />
            <Stat label="Still to charge" value={money(d.totals.forecastCents)} sub="months not yet posted, including completed months owed" />
          </div>
          <div className="rounded-2xl overflow-x-auto" style={card}>
            <table className="text-sm min-w-full">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                  <th className="px-3 py-3 font-bold sticky left-0" style={{ background: 'var(--surface)' }}>{by === 'asset' ? 'Asset' : by === 'location' ? 'Outlet' : by === 'brand' ? 'Brand' : by === 'pool' ? 'Pool' : 'Class'}</th>
                  {d.months.map((m) => <th key={m} className="px-3 py-3 font-bold text-right whitespace-nowrap">{fmtMonth(m)}</th>)}
                </tr>
              </thead>
              <tbody>
                {groups.map((g, i) => (
                  <tr key={i} className="border-t border-white/[0.05]">
                    <td className="px-3 py-2 font-bold text-white/85 sticky left-0 whitespace-nowrap" style={{ background: 'var(--surface)' }}>
                      {g.label}{multi && <span className="block text-[10px] font-normal text-white/40">{g.company}</span>}
                    </td>
                    {d.months.map((m) => {
                      const c = g.cells.get(m)
                      return (
                        <td key={m} className="px-3 py-2 text-right font-mono whitespace-nowrap">
                          {c && c.posted > 0 && <span className="text-white/90">{money(c.posted)}</span>}
                          {c && c.forecast > 0 && (
                            <span className={`block text-[11px] ${m <= d.lastCompletedPeriod ? 'text-s-amber' : 'text-white/40'}`}>{m <= d.lastCompletedPeriod ? 'owed ' : ''}{money(c.forecast)}</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
                {groups.length === 0 && <tr><td className="px-3 py-6 text-white/45" colSpan={d.months.length + 1}>No depreciation in this range.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-white/40">Solid figures are posted. Grey figures are forecast; amber figures are completed months not yet charged (the nightly run catches them up).</p>
        </>
      )}
    </div>
  )
}

// ─── Roll-forward ───────────────────────────────────────────────────────────

type RollRow = Record<string, string | number | null> & { companyName: string; label: string }
interface RollData { from: string; to: string; rows: RollRow[]; ties: boolean }

const COST_COLS: Array<[string, string]> = [
  ['openingCostCents', 'Opening'], ['additionsCents', 'Added'], ['transfersInCents', 'Moved in'], ['transfersOutCents', 'Moved out'],
  ['writeOffsCents', 'Written off'], ['disposalsCents', 'Disposed'], ['voidsCents', 'Voided'], ['closingCostCents', 'Closing'],
]
const ACCUM_COLS: Array<[string, string]> = [
  ['openingAccumCents', 'Opening'], ['accumAddedCents', 'Brought in'], ['depreciationCents', 'Depreciation'], ['impairmentCents', 'Write-downs'],
  ['accumWrittenOffCents', 'Written off'], ['accumTransferredOutCents', 'Moved out'], ['accumDisposedCents', 'Disposed'], ['accumVoidedCents', 'Voided'],
  ['reclassCents', 'Reclassed'], ['closingAccumCents', 'Closing'],
]

function RollForwardReport({ onError }: { onError: (m: string) => void }) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const qs = useMemo(() => {
    const p = new URLSearchParams()
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    return p.toString()
  }, [from, to])
  const q = useQuery<RollData>({ queryKey: ['fa-rep-roll', qs], queryFn: () => api.get(`${FA_BASE}/reports/roll-forward${qs ? `?${qs}` : ''}`) })
  const d = q.data
  const n = (r: RollRow, k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0)
  const multi = new Set((d?.rows ?? []).map((r) => String(r['tenantId']))).size > 1

  function Table({ title, cols, glKey, diffKey, closeKey }: { title: string; cols: Array<[string, string]>; glKey: string; diffKey: string; closeKey: string }) {
    const used = cols.filter(([k]) => k === closeKey || k.startsWith('opening') || (d?.rows ?? []).some((r) => n(r, k) !== 0))
    return (
      <div className="rounded-2xl overflow-x-auto" style={card}>
        <p className="px-4 pt-4 text-sm font-black text-white/90">{title}</p>
        <table className="text-sm min-w-full mt-2">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
              <th className="px-3 py-3 font-bold sticky left-0" style={{ background: 'var(--surface)' }}>Class</th>
              {used.map(([k, l]) => <th key={k} className="px-3 py-3 font-bold text-right whitespace-nowrap">{l}</th>)}
              <th className="px-3 py-3 font-bold text-right whitespace-nowrap">In the ledger</th>
              <th className="px-3 py-3 font-bold text-right whitespace-nowrap">Difference</th>
            </tr>
          </thead>
          <tbody>
            {(d?.rows ?? []).map((r, i) => (
              <tr key={i} className="border-t border-white/[0.05]">
                <td className="px-3 py-2 font-bold text-white/85 sticky left-0 whitespace-nowrap" style={{ background: 'var(--surface)' }}>
                  {r.label}{multi && <span className="block text-[10px] font-normal text-white/40">{r.companyName}</span>}
                </td>
                {used.map(([k]) => <td key={k} className={`px-3 py-2 text-right font-mono whitespace-nowrap ${k === closeKey ? 'font-bold text-white/95' : 'text-white/70'}`}>{money(n(r, k))}</td>)}
                <td className="px-3 py-2 text-right font-mono text-white/70 whitespace-nowrap">{money(n(r, glKey))}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap"><DiffCell cents={n(r, diffKey)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl p-4 grid grid-cols-2 md:grid-cols-4 gap-3 items-end" style={card}>
        <label className="block"><span className="text-[11px] font-bold text-white/50">From</span><input type="date" className={inp} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="block"><span className="text-[11px] font-bold text-white/50">To</span><input type="date" className={inp} value={to} max={todayIso()} onChange={(e) => setTo(e.target.value)} /></label>
        <p className="text-[11px] text-white/40 col-span-2 md:col-span-1">Blank means the tax year so far.</p>
        <div>{csvButton(`${FA_BASE}/reports/roll-forward?${qs}${qs ? '&' : ''}format=csv`, 'fixed-asset-roll-forward.csv', onError)}</div>
      </div>
      <Loading q={q} />
      {d && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-white/60">{fmtDay(d.from)} to {fmtDay(d.to)}</p>
            {d.ties ? <span className="s-badge-green">Ties to the ledger</span> : <span className="s-badge-red">Does not tie to the ledger</span>}
          </div>
          {d.rows.length === 0 ? <p className="text-sm text-white/45">Nothing on the register in this period.</p> : (
            <>
              <Table title="Cost" cols={COST_COLS} glKey="glCostCents" diffKey="costDiffCents" closeKey="closingCostCents" />
              <Table title="Accumulated depreciation" cols={ACCUM_COLS} glKey="glAccumCents" diffKey="accumDiffCents" closeKey="closingAccumCents" />
            </>
          )}
        </>
      )}
    </div>
  )
}

// ─── Net book value ─────────────────────────────────────────────────────────

interface NbvData {
  asOf: string
  rows: Array<{ tenantId: string; companyName: string; key: string; label: string; assets: number; costCents: number; accumulatedCents: number; nbvCents: number }>
  totals: { costCents: number; accumulatedCents: number; nbvCents: number }
}

function NbvReport({ onError }: { onError: (m: string) => void }) {
  const [asOf, setAsOf] = useState('')
  const [by, setBy] = useState('class')
  const qs = useMemo(() => {
    const p = new URLSearchParams({ groupBy: by })
    if (asOf) p.set('asOf', asOf)
    return p.toString()
  }, [asOf, by])
  const q = useQuery<NbvData>({ queryKey: ['fa-rep-nbv', qs], queryFn: () => api.get(`${FA_BASE}/reports/nbv?${qs}`) })
  const d = q.data
  const multi = new Set((d?.rows ?? []).map((r) => r.tenantId)).size > 1
  return (
    <div className="space-y-4">
      <div className="rounded-2xl p-4 grid grid-cols-2 md:grid-cols-4 gap-3 items-end" style={card}>
        <label className="block"><span className="text-[11px] font-bold text-white/50">As of</span><input type="date" className={inp} value={asOf} max={todayIso()} onChange={(e) => setAsOf(e.target.value)} /></label>
        <label className="block"><span className="text-[11px] font-bold text-white/50">Group by</span>
          <Select className={inp} value={by} onChange={(e) => setBy(e.target.value)}>
            <option value="class">Class</option><option value="brand">Brand</option><option value="location">Outlet</option><option value="pool">Smallwares pool</option><option value="company">Company</option><option value="asset">Asset</option>
          </Select></label>
        <p className="text-[11px] text-white/40">Brand and outlet are where each asset was on that day.</p>
        <div>{csvButton(`${FA_BASE}/reports/nbv?${qs}&format=csv`, `fixed-asset-nbv.csv`, onError)}</div>
      </div>
      <Loading q={q} />
      {d && (
        <div className="rounded-2xl overflow-x-auto" style={card}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                <th className="px-4 py-3 font-bold">{fmtDay(d.asOf)}</th>
                {['Items', 'Cost', 'Depreciated', 'Book value'].map((h) => <th key={h} className="px-4 py-3 font-bold text-right">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={`${r.tenantId}|${r.key}`} className="border-t border-white/[0.05]">
                  <td className="px-4 py-2 font-bold text-white/85">{r.label}{multi && <span className="block text-[10px] font-normal text-white/40">{r.companyName}</span>}</td>
                  <td className="px-4 py-2 text-right text-white/60">{r.assets}</td>
                  <td className="px-4 py-2 text-right font-mono text-white/80 whitespace-nowrap">{money(r.costCents)}</td>
                  <td className="px-4 py-2 text-right font-mono text-white/60 whitespace-nowrap">{money(r.accumulatedCents)}</td>
                  <td className="px-4 py-2 text-right font-mono font-bold text-white/90 whitespace-nowrap">{money(r.nbvCents)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-white/10">
                <td className="px-4 py-3 font-black text-white/90">Total</td><td />
                <td className="px-4 py-3 text-right font-mono font-bold text-white/90 whitespace-nowrap">{money(d.totals.costCents)}</td>
                <td className="px-4 py-3 text-right font-mono font-bold text-white/90 whitespace-nowrap">{money(d.totals.accumulatedCents)}</td>
                <td className="px-4 py-3 text-right font-mono font-black text-white/95 whitespace-nowrap">{money(d.totals.nbvCents)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Tie-out ────────────────────────────────────────────────────────────────

interface TieCompany {
  tenantId: string; companyName: string; ok: boolean
  byClass: Array<{ classKey: string; label: string; costAccountCode: string; accumAccountCode: string | null; registerCostCents: number; glCostCents: number; costDiffCents: number; registerAccumCents: number; glAccumCents: number; accumDiffCents: number }>
  legacy1590Cents: number; legacy1590RegisterCents: number; legacy1590DiffCents: number
  capitalPayables: { code: string; capexOwedCents: number; glCents: number; diffCents: number }
  prepaid: { code: string; unreleasedCents: number; glCents: number; diffCents: number }
  deposits: { code: string; heldCents: number; glCents: number; diffCents: number }
}

function TieOutReport({ onError }: { onError: (m: string) => void }) {
  const [asOf, setAsOf] = useState('')
  const qs = asOf ? `asOf=${asOf}` : ''
  const q = useQuery<{ asOf: string | null; companies: TieCompany[] }>({ queryKey: ['fa-rep-tie', qs], queryFn: () => api.get(`${FA_BASE}/reports/tie-out${qs ? `?${qs}` : ''}`) })
  return (
    <div className="space-y-4">
      <div className="rounded-2xl p-4 grid grid-cols-2 md:grid-cols-4 gap-3 items-end" style={card}>
        <label className="block"><span className="text-[11px] font-bold text-white/50">As of</span><input type="date" className={inp} value={asOf} max={todayIso()} onChange={(e) => setAsOf(e.target.value)} /></label>
        <p className="text-[11px] text-white/40 col-span-2 md:col-span-2">Blank compares today&rsquo;s balances.</p>
        <div>{csvButton(`${FA_BASE}/reports/tie-out?${qs}${qs ? '&' : ''}format=csv`, 'fixed-asset-tie-out.csv', onError)}</div>
      </div>
      <Loading q={q} />
      {q.data?.companies.map((c) => {
        const allOk = c.ok && c.capitalPayables.diffCents === 0 && c.prepaid.diffCents === 0 && c.deposits.diffCents === 0
        const lines: Array<{ key: string; check: string; code: string; reg: number; gl: number; diff: number }> = [
          ...c.byClass.flatMap((k) => [
            ...((k.registerCostCents !== 0 || k.glCostCents !== 0) ? [{ key: `${k.classKey}-c`, check: `${k.label}, cost`, code: k.costAccountCode, reg: k.registerCostCents, gl: k.glCostCents, diff: k.costDiffCents }] : []),
            ...(k.accumAccountCode && (k.registerAccumCents !== 0 || k.glAccumCents !== 0) ? [{ key: `${k.classKey}-a`, check: `${k.label}, depreciation so far`, code: k.accumAccountCode, reg: k.registerAccumCents, gl: k.glAccumCents, diff: k.accumDiffCents }] : []),
          ]),
          { key: 'legacy', check: 'Old depreciation account still holding balances', code: '1590', reg: c.legacy1590RegisterCents, gl: c.legacy1590Cents, diff: c.legacy1590DiffCents },
          { key: 'owed', check: 'Equipment suppliers owed (CapEx)', code: c.capitalPayables.code, reg: c.capitalPayables.capexOwedCents, gl: c.capitalPayables.glCents, diff: c.capitalPayables.diffCents },
          { key: 'prepaid', check: 'Prepaid rent not yet released', code: c.prepaid.code, reg: c.prepaid.unreleasedCents, gl: c.prepaid.glCents, diff: c.prepaid.diffCents },
          { key: 'deposits', check: 'Security deposits held', code: c.deposits.code, reg: c.deposits.heldCents, gl: c.deposits.glCents, diff: c.deposits.diffCents },
        ]
        return (
          <section key={c.tenantId} className="rounded-2xl overflow-x-auto" style={{ ...card, borderColor: allOk ? undefined : 'color-mix(in srgb, var(--erp-danger) 45%, transparent)' }}>
            <div className="px-4 pt-4 flex flex-wrap items-center gap-3">
              <p className="font-black text-white/90">{c.companyName}</p>
              {allOk ? <span className="s-badge-green">Everything ties</span> : <span className="s-badge-red">Differences to chase</span>}
            </div>
            <table className="w-full text-sm mt-2">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                  <th className="px-4 py-2 font-bold">Check</th><th className="px-4 py-2 font-bold">Account</th>
                  <th className="px-4 py-2 font-bold text-right">Register</th><th className="px-4 py-2 font-bold text-right">Ledger</th><th className="px-4 py-2 font-bold text-right">Difference</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key} className="border-t border-white/[0.05]" style={l.diff !== 0 ? { background: 'color-mix(in srgb, var(--erp-danger) 8%, transparent)' } : undefined}>
                    <td className="px-4 py-2 text-white/85">{l.check}</td>
                    <td className="px-4 py-2 text-white/50">{l.code}</td>
                    <td className="px-4 py-2 text-right font-mono text-white/75 whitespace-nowrap">{moneyExact(l.reg)}</td>
                    <td className="px-4 py-2 text-right font-mono text-white/75 whitespace-nowrap">{moneyExact(l.gl)}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap"><DiffCell cents={l.diff} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )
      })}
      {q.data && q.data.companies.length === 0 && <p className="text-sm text-white/45">No company in view.</p>}
    </div>
  )
}

// ─── Supplier advances (1340) ───────────────────────────────────────────────

interface AdvanceRow {
  tenantId: string; companyName: string; lineId: string | null; paymentId: string | null; projectId: string | null; projectName: string; item: string | null
  expectedDeliveryDate: string | null; actualDeliveryDate: string | null; advancedCents: number; appliedCents: number; heldCents: number
  firstPaidAt: string | null; ageDays: number | null; flags: string
}
const FLAG_BADGE: Record<string, { cls: string; label: string }> = {
  capitalisation_pending: { cls: 's-badge-amber', label: 'Awaiting capitalisation' },
  delivered_uncapitalised: { cls: 's-badge-amber', label: 'Delivered, not capitalised' },
  overdue_delivery: { cls: 's-badge-red', label: 'Advance overdue' },
  orphan: { cls: 's-badge-red', label: 'Orphan entry' },
}

function AdvancesReport({ onError }: { onError: (m: string) => void }) {
  const [asOf, setAsOf] = useState('')
  const qs = asOf ? `asOf=${asOf}` : ''
  const q = useQuery<{ asOf: string; rows: AdvanceRow[]; byCompany: Array<{ tenantId: string; companyName: string; heldCents: number; glCents: number; diffCents: number }> }>({
    queryKey: ['fa-rep-adv', qs], queryFn: () => api.get(`${FA_BASE}/reports/advances${qs ? `?${qs}` : ''}`),
  })
  const d = q.data
  return (
    <div className="space-y-4">
      <div className="rounded-2xl p-4 grid grid-cols-2 md:grid-cols-4 gap-3 items-end" style={card}>
        <label className="block"><span className="text-[11px] font-bold text-white/50">As of</span><input type="date" className={inp} value={asOf} max={todayIso()} onChange={(e) => setAsOf(e.target.value)} /></label>
        <p className="text-[11px] text-white/40 col-span-2">An advance is money paid to a supplier before the item is capitalised.</p>
        <div>{csvButton(`${FA_BASE}/reports/advances?${qs}${qs ? '&' : ''}format=csv`, 'supplier-advances.csv', onError)}</div>
      </div>
      <Loading q={q} />
      {d && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {d.byCompany.map((c) => (
              <div key={c.tenantId} className="rounded-2xl p-4" style={card}>
                <p className="text-[10px] uppercase tracking-wider text-white/40 font-bold">{c.companyName}</p>
                <p className="text-lg font-black text-white/90 mt-1">{money(c.heldCents)}</p>
                <p className="text-xs mt-1">{c.diffCents === 0 ? <span className="text-success font-bold">Ties to the ledger</span> : <span className="text-s-red font-bold">Ledger differs by {moneyExact(c.diffCents)}</span>}</p>
              </div>
            ))}
          </div>
          <div className="rounded-2xl overflow-x-auto" style={card}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                  {['Project and item', 'First paid', 'Delivery', 'Advanced', 'Applied to assets', 'Still held', 'Flags'].map((h, i) => <th key={h} className={`px-4 py-3 font-bold whitespace-nowrap ${[3, 4, 5].includes(i) ? 'text-right' : ''}`}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {d.rows.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-white/45">No supplier advances are being held.</td></tr>}
                {d.rows.map((r, i) => (
                  <tr key={r.lineId ?? r.paymentId ?? i} className="border-t border-white/[0.05]">
                    <td className="px-4 py-2">
                      {r.projectId ? <Link href={`/finance/capex?project=${r.projectId}`} className="font-bold text-primary-ink hover:underline">{r.projectName}</Link> : <span className="font-bold text-white/85">{r.projectName}</span>}
                      <p className="text-[11px] text-white/45">{r.item ?? 'No item'}{d.byCompany.length > 1 ? ` · ${r.companyName}` : ''}</p>
                    </td>
                    <td className="px-4 py-2 text-white/60 whitespace-nowrap">{r.firstPaidAt ? `${fmtDay(r.firstPaidAt)}${r.ageDays !== null ? ` (${r.ageDays} days)` : ''}` : '—'}</td>
                    <td className="px-4 py-2 text-white/60 whitespace-nowrap">{r.actualDeliveryDate ? `Delivered ${fmtDay(r.actualDeliveryDate)}` : r.expectedDeliveryDate ? `Due ${fmtDay(r.expectedDeliveryDate)}` : '—'}</td>
                    <td className="px-4 py-2 text-right font-mono text-white/75 whitespace-nowrap">{money(r.advancedCents)}</td>
                    <td className="px-4 py-2 text-right font-mono text-white/60 whitespace-nowrap">{money(r.appliedCents)}</td>
                    <td className="px-4 py-2 text-right font-mono font-bold text-white/90 whitespace-nowrap">{money(r.heldCents)}</td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1">
                        {r.flags.split(';').map((f) => f.trim()).filter(Boolean).map((f) => <span key={f} className={FLAG_BADGE[f]?.cls ?? 's-badge-muted'}>{FLAG_BADGE[f]?.label ?? f}</span>)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Tax depreciation ───────────────────────────────────────────────────────

interface TaxData {
  companyName: string; taxYear: number; start: string; end: string; frozen: boolean
  rows: Array<{ assetId: string; assetTag: string | null; name: string; classKey: string; classLabel: string; rateBp: number; initialAllowanceBp: number; openingWdvCents: number; additionsCents: number; initialAllowanceCents: number; depreciationCents: number; disposalProceedsCents: number; closingWdvCents: number }>
  byClass: Array<{ classKey: string; label: string; openingWdvCents: number; additionsCents: number; initialAllowanceCents: number; depreciationCents: number; disposalProceedsCents: number; closingWdvCents: number }>
  totals: { openingWdvCents: number; additionsCents: number; initialAllowanceCents: number; depreciationCents: number; disposalProceedsCents: number; closingWdvCents: number }
  toConfirm: Array<{ assetId: string; assetTag: string | null; name: string; classLabel: string; costCents: number }>
  toConfirmNote: string | null
}

function TaxReport({ onError }: { onError: (m: string) => void }) {
  const qc = useQueryClient()
  const { data: lookups } = useFaLookups()
  const [year, setYear] = useState<number | null>(null)
  const [detail, setDetail] = useState(false)
  const [done, setDone] = useState('')
  const qs = year ? `taxYear=${year}` : ''
  const q = useQuery<TaxData>({ queryKey: ['fa-rep-tax', qs], queryFn: () => api.get(`${FA_BASE}/reports/tax${qs ? `?${qs}` : ''}`) })
  const d = q.data
  const shownYear = d?.taxYear ?? year

  const freeze = useMutation({
    mutationFn: () => api.post(`${FA_BASE}/reports/tax/${shownYear}/freeze`, {}),
    onSuccess: () => { setDone(`Tax year ${shownYear} is frozen. Its figures no longer move.`); void qc.invalidateQueries({ queryKey: ['fa-rep-tax'] }) },
    onError: (e) => onError(errorWords(e)),
  })

  const cols: Array<[string, keyof TaxData['totals']]> = [
    ['Opening', 'openingWdvCents'], ['Added', 'additionsCents'], ['Initial allowance', 'initialAllowanceCents'],
    ['Depreciation', 'depreciationCents'], ['Sale proceeds', 'disposalProceedsCents'], ['Closing', 'closingWdvCents'],
  ]

  return (
    <div className="space-y-4">
      <div className="rounded-2xl p-4 flex flex-wrap items-end gap-3" style={card}>
        <div className="flex items-center gap-2">
          <button className={btnGhost} disabled={!shownYear} onClick={() => shownYear && setYear(shownYear - 1)} aria-label="Previous tax year">&larr;</button>
          <div className="text-center min-w-[120px]">
            <p className="text-[11px] font-bold text-white/50">Tax year</p>
            <p className="font-black text-white/90">{shownYear ?? '…'}</p>
          </div>
          <button className={btnGhost} disabled={!shownYear} onClick={() => shownYear && setYear(shownYear + 1)} aria-label="Next tax year">&rarr;</button>
        </div>
        {d && <p className="text-xs text-white/50">{fmtDay(d.start)} to {fmtDay(d.end)} · {d.companyName}</p>}
        <div className="ml-auto flex flex-wrap gap-2">
          {d && (d.frozen ? <span className="s-badge-green self-center">Frozen</span> : lookups?.capabilities.canApprove && (
            <button className={btnPrimary} disabled={freeze.isPending} onClick={() => { if (window.confirm(`Freeze tax year ${d.taxYear} for ${d.companyName}? Its figures stop moving.`)) freeze.mutate() }}>
              {freeze.isPending ? 'Freezing…' : 'Freeze this year'}
            </button>
          ))}
          {csvButton(`${FA_BASE}/reports/tax?${qs}${qs ? '&' : ''}format=csv`, `tax-depreciation-${shownYear ?? ''}.csv`, onError)}
        </div>
      </div>
      <p className="text-[11px] text-white/40">Tax is filed per company, so this report shows the company picked in the top bar.</p>
      {done && <Notice tone="ok" onClose={() => setDone('')}>{done}</Notice>}
      <Loading q={q} />

      {d && (
        <>
          <div className="rounded-2xl overflow-x-auto" style={card}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                  <th className="px-4 py-3 font-bold">Class</th>
                  {cols.map(([h]) => <th key={h} className="px-4 py-3 font-bold text-right whitespace-nowrap">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {d.byClass.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-white/45">No assets with tax depreciation in this year.</td></tr>}
                {d.byClass.map((c) => (
                  <tr key={c.classKey} className="border-t border-white/[0.05]">
                    <td className="px-4 py-2 font-bold text-white/85">{c.label}</td>
                    {cols.map(([h, k]) => <td key={h} className="px-4 py-2 text-right font-mono text-white/75 whitespace-nowrap">{money(c[k])}</td>)}
                  </tr>
                ))}
                {d.byClass.length > 0 && (
                  <tr className="border-t-2 border-white/10">
                    <td className="px-4 py-3 font-black text-white/90">Total</td>
                    {cols.map(([h, k]) => <td key={h} className="px-4 py-3 text-right font-mono font-bold text-white/90 whitespace-nowrap">{money(d.totals[k])}</td>)}
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <button className="text-xs font-bold text-primary-ink hover:underline" onClick={() => setDetail((v) => !v)}>
            {detail ? 'Hide the asset-by-asset figures' : `Show the asset-by-asset figures (${d.rows.length})`}
          </button>
          {detail && (
            <div className="rounded-2xl overflow-x-auto" style={card}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                    <th className="px-4 py-3 font-bold">Asset</th><th className="px-4 py-3 font-bold">Rate</th>
                    {cols.map(([h]) => <th key={h} className="px-4 py-3 font-bold text-right whitespace-nowrap">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.assetId} className="border-t border-white/[0.05]">
                      <td className="px-4 py-2"><Link href={`${FA_BASE}/${r.assetId}`} className="font-bold text-primary-ink hover:underline">{r.assetTag ? `${r.assetTag} ` : ''}{r.name}</Link><p className="text-[11px] text-white/40">{r.classLabel}</p></td>
                      <td className="px-4 py-2 text-white/60 whitespace-nowrap">{pct(r.rateBp)}{r.initialAllowanceBp ? ` + ${pct(r.initialAllowanceBp)}` : ''}</td>
                      {cols.map(([h, k]) => <td key={h} className="px-4 py-2 text-right font-mono text-white/70 whitespace-nowrap">{money(r[k])}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {d.toConfirm.length > 0 && (
            <section className="rounded-2xl p-4" style={card}>
              <p className="text-sm font-black text-white/90">Tax treatment to confirm</p>
              <p className="text-sm text-white/60 mt-1">{d.toConfirmNote}</p>
              <ul className="mt-2 text-sm divide-y divide-white/[0.05]">
                {d.toConfirm.map((t) => (
                  <li key={t.assetId} className="py-1.5 flex justify-between gap-3">
                    <span className="text-white/80 min-w-0 break-words">{t.assetTag ? `${t.assetTag} ` : ''}{t.name} <span className="text-white/40">· {t.classLabel}</span></span>
                    <span className="font-mono text-white/60 whitespace-nowrap">{money(t.costCents)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}
