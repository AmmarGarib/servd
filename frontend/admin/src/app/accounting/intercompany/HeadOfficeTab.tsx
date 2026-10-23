'use client'
// Accounting → Inter-company → Head office (D1; backend modules/headOffices).
//
// A head office carries cost the group shares (salaries, rent…). Each month
// finance prepares a RECHARGE RUN: the head office's cost for the month, split
// by the % table, charged to each company through the inter-company engine
// (so both books move together). Nothing here is a second ledger — the run
// posts transfers that also show on the Transfers tab.
//
//   Head-office members   recharge runs (preview, prepare, refresh, submit,
//                         withdraw) with their status, the run detail (cost
//                         basis by account, lines, warnings), a statement per
//                         company, and whether the month can be closed.
//   Company members       the charges each head office has put on them, the
//                         run basis behind each, the balance and the statement.
//
// What a click may do is decided by the server; `canPrepare` / `canDecide` /
// `canReverse` only choose which buttons to offer, and every refusal is shown
// as the API wrote it. The recharge switch itself is the CEO's, on CEO → Head
// offices — it stays OFF until the CEO turns it on, so this tab is read-only
// until then.

import { Button, Field, Input } from '@/components/finance/ui'
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'
import { Select } from '@/components/ui/Select'
import { addMonthsTo, currentMonthPkt, monthLabel } from '../../../lib/headOfficeApi'
import type { MyHeadOffice } from '../../../hooks/useWorkspaces'
import {
  RUN_BADGE, RechargeRunDetail, RunBody, runMonthLabel, type RechargeRun,
} from './RechargeRunDetail'
import { ExportMenu } from '@/components/ui/ExportMenu'
import { CompactEmptyState } from '@/components/ui/CompactEmptyState'

type Msg = { ok: boolean; text: string } | null

const labelCls = 'block mb-1'
const danger = 'var(--erp-danger)'

const errText = (err: unknown) => (err instanceof ApiError ? err.message : (err as Error)?.message ?? 'Something went wrong')

// ─── API shapes ──────────────────────────────────────────────────────────────

interface Summary {
  headOffice: { id: string; name: string; isActive: boolean }
  books: { rechargeEnabled: boolean; rechargeFromPeriod: string | null; requireLockedPayroll: boolean; accountsConfirmedAt: string | null } | null
  split: { effectiveFrom: string; lines: Array<{ companyTenantId: string; shareBps: number }> } | null
  companies: Array<{
    linkId: string; companyTenantId: string; companyName: string; startedAt: string; endedAt: string | null
    lastChargedPeriod: string | null; shareBps: number; owedByCompanyCents: number; mismatchCents: number
  }>
  lastMonth: string
  lastMonthReadiness: { ready: boolean; reasons: string[]; poolCents: number; postedBaseCents: number; driftCents: number; openRunId: string | null } | null
  runs: RechargeRun[]
}

interface Preview {
  headOfficeId: string; period: string; monthEnded: boolean; kind: string
  basis: unknown; poolCents: number; priorCents: number; baseCents: number; rechargedCents: number; retainedCents: number
  warnings: string[]
  lines: Array<{ companyTenantId: string; companyName: string | null; shareBps: number; amountCents: number }>
}

interface ReadinessProblem { headOfficeId: string; headOfficeName: string; period: string; reasons: string[]; driftCents: number }
interface CloseStatus { months: string[]; ready: boolean; tenantId: string; through: string; headOffice: ReadinessProblem[]; charges: ReadinessProblem[] }

interface Statement {
  headOfficeId: string; companyId: string; from: string; to: string
  openingCents: number; chargesCents: number; settlementsCents: number; adjustmentsCents: number; otherCents: number
  closingCents: number; companyClosingCents: number; differenceCents: number
  rows: Array<{ date: string; reference: string | null; transferId: string | null; category: string; reversal: boolean; description: string; cents: number }>
}

interface Pair {
  a: { id: string; name: string | null }; b: { id: string; name: string | null }
  headOfficePair?: boolean
  netOwedByA: number | null; mismatchCents: number | null
}

const REASON_TEXT: Record<string, string> = {
  payroll_not_locked: "the head office's payroll for the month is not locked",
  open_run: 'a recharge run for the month is still open',
  drift: "the head office's cost for the month is not fully recharged",
}

function Money({ cents, bad }: { cents: number | null; bad?: boolean }) {
  if (cents === null) return <span className="text-white/35">—</span>
  return <span className="tabular-nums" style={bad && cents !== 0 ? { color: danger } : undefined}>{fmtPkr(cents)}</span>
}

function lastDayOfPrevMonthPkt(): string {
  const [y, m] = currentMonthPkt().split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10)
}

// ─── The tab ─────────────────────────────────────────────────────────────────

export function HeadOfficeTab({ headOffices, activeCompany, canPrepare, canDecide, canReverse, setMsg }: {
  /** The head offices the caller belongs to (from /permissions/me). */
  headOffices: MyHeadOffice[]
  /** The operator's active company: its close status shows even before any charge. */
  activeCompany: { id: string; name: string } | null
  canPrepare: boolean
  canDecide: boolean
  canReverse: boolean
  setMsg: (m: Msg) => void
}) {
  const mine = useMemo(() => new Set(headOffices.map((h) => h.id)), [headOffices])
  const runs = useQuery({
    queryKey: ['ic', 'recharge-runs', 'all'],
    queryFn: () => api.get<{ runs: RechargeRun[] }>('/accounting/intercompany/recharge-runs?limit=200'),
  })
  // Runs of head offices the caller does NOT belong to: this is the company's side.
  const charges = (runs.data?.runs ?? []).filter((r) => !mine.has(r.tenantId))

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-white/45">
        A head office&apos;s monthly cost is split by its % table and charged to each company. A run is prepared once the month is over, the CEO approves it,
        and it posts in the head office&apos;s and every company&apos;s books together. Until the CEO switches recharging on (CEO → Head offices) nothing here posts.
      </p>
      {runs.isError && <p className="text-sm" style={{ color: danger }}>{errText(runs.error)}</p>}

      {headOffices.map((h) => (
        <HeadOfficeSection key={h.id} ho={h} canPrepare={canPrepare} canDecide={canDecide} canReverse={canReverse} setMsg={setMsg} />
      ))}

      {charges.length > 0 && <ChargesSection runs={charges} setMsg={setMsg} />}

      {!runs.isLoading && headOffices.length === 0 && charges.length === 0 && (
        <>
          <CompactEmptyState message="No head office has charged your companies yet." />
          {/* A served company's first month: show why its close is held up. */}
          {activeCompany && <CompanyCloseStatus companies={[activeCompany]} />}
        </>
      )}
    </div>
  )
}

// ─── Head-office member view ─────────────────────────────────────────────────

function HeadOfficeSection({ ho, canPrepare, canDecide, canReverse, setMsg }: {
  ho: MyHeadOffice
  canPrepare: boolean
  canDecide: boolean
  canReverse: boolean
  setMsg: (m: Msg) => void
}) {
  const qc = useQueryClient()
  const cur = currentMonthPkt()
  const months = useMemo(() => Array.from({ length: 12 }, (_, i) => addMonthsTo(cur, -i - 1)), [cur])
  const [period, setPeriod] = useState(months[0]!)
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)

  const summary = useQuery({
    queryKey: ['ic', 'recharge-summary', ho.id],
    queryFn: () => api.get<Summary>(`/accounting/intercompany/recharge-runs/summary?headOfficeId=${encodeURIComponent(ho.id)}`),
  })
  const through = lastDayOfPrevMonthPkt()
  const close = useQuery({
    queryKey: ['ic', 'close-status', ho.id, through],
    queryFn: () => api.get<CloseStatus>(`/accounting/intercompany/recharge-runs/close-status?tenantId=${encodeURIComponent(ho.id)}&through=${through}`),
    retry: false,
  })
  const preview = useQuery({
    queryKey: ['ic', 'recharge-preview', ho.id, period],
    queryFn: () => api.get<Preview>(`/accounting/intercompany/recharge-runs/preview?headOfficeId=${encodeURIComponent(ho.id)}&period=${period}`),
    enabled: showPreview && canPrepare,
    retry: false,
  })
  const prepare = useMutation({
    mutationFn: () => api.post<RechargeRun>('/accounting/intercompany/recharge-runs', { headOfficeId: ho.id, period }),
    onSuccess: (r) => {
      setMsg({ ok: true, text: `Run for ${runMonthLabel(period)} prepared as a draft.` })
      setShowPreview(false); setOpenRun(r.id)
      void qc.invalidateQueries({ queryKey: ['ic'] })
    },
    onError: (err) => setMsg({ ok: false, text: errText(err) }),
  })

  const s = summary.data
  const books = s?.books ?? null

  return (
    <section className="space-y-4" aria-label={`${ho.name} recharge runs`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-white/90">{ho.name}</h2>
        {books && (
          <span className={books.rechargeEnabled ? 's-badge-green' : 's-badge-muted'}>
            {books.rechargeEnabled ? `Recharging from ${monthLabel(books.rechargeFromPeriod)}` : 'Recharging is off'}
          </span>
        )}
      </div>
      {summary.isError && <p className="text-sm" style={{ color: danger }}>{errText(summary.error)}</p>}

      {/* Close status */}
      <div className="s-card p-4 text-sm">
        <p className={labelCls}>Month close — through {through}</p>
        {close.isLoading ? <span className="text-white/40">Checking…</span>
          : close.isError ? <span className="text-white/45">{errText(close.error)}</span>
          : close.data!.ready ? <span className="text-success">Nothing here blocks closing.</span>
          : (
            <ul className="space-y-1" style={{ color: 'var(--erp-warning)' }}>
              {close.data!.headOffice.map((p) => (
                <li key={`${p.period}`}>{runMonthLabel(p.period)}: {p.reasons.map((r) => REASON_TEXT[r] ?? r).join('; ')}{p.driftCents !== 0 && <> ({fmtPkr(p.driftCents)} not yet recharged)</>}</li>
              ))}
            </ul>
          )}
      </div>

      {/* Companies and balances */}
      {s && s.companies.length > 0 && (
        <div className="s-card overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="text-xs text-s-muted">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Company</th>
                <th className="px-3 py-2 text-right font-medium">Share</th>
                <th className="px-3 py-2 text-right font-medium">Owes head office</th>
                <th className="px-3 py-2 text-right font-medium">Books differ by</th>
                <th className="px-3 py-2 text-left font-medium">Last charged</th>
              </tr>
            </thead>
            <tbody>
              {s.companies.map((c) => (
                <tr key={c.linkId} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-3 py-2 text-white/85">{c.companyName}{c.endedAt && <span className="s-badge-muted ml-2">Ended</span>}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{(c.shareBps / 100).toFixed(2)}%</td>
                  <td className="px-3 py-2 text-right"><Money cents={c.owedByCompanyCents} /></td>
                  <td className="px-3 py-2 text-right"><Money cents={c.mismatchCents} bad /></td>
                  <td className="px-3 py-2 text-white/55">{c.lastChargedPeriod ? monthLabel(c.lastChargedPeriod) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Prepare */}
      {canPrepare && (
        <div className="s-card space-y-3 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Month">
              <Select value={period} onChange={(e) => { setPeriod(e.target.value); setShowPreview(false) }} className="s-select">
                {months.map((m) => <option key={m} value={m}>{runMonthLabel(m)}</option>)}
              </Select>
            </Field>
            <Button variant="secondary" type="button"  onClick={() => setShowPreview(true)} disabled={preview.isFetching}>Preview</Button>
            <Button type="button"  onClick={() => prepare.mutate()} disabled={prepare.isPending}>
              {prepare.isPending ? 'Preparing…' : 'Prepare run'}
            </Button>
          </div>
          {showPreview && preview.isError && <p className="text-sm" style={{ color: danger }}>{errText(preview.error)}</p>}
          {showPreview && preview.data && (
            <div className="space-y-3">
              {!preview.data.monthEnded && <p className="text-xs" style={{ color: 'var(--erp-warning)' }}>This month is not over yet — a run can only be prepared after it ends.</p>}
              {preview.data.warnings.length > 0 && (
                <ul className="space-y-1 rounded-lg px-3 py-2 text-xs" style={{ color: 'var(--erp-warning)', background: 'color-mix(in srgb, var(--erp-warning) 10%, transparent)' }}>
                  {preview.data.warnings.map((w) => <li key={w}>{w}</li>)}
                </ul>
              )}
              <RunBody run={{
                basis: preview.data.basis, poolCents: preview.data.poolCents, priorCents: preview.data.priorCents, baseCents: preview.data.baseCents,
                rechargedCents: preview.data.rechargedCents, retainedCents: preview.data.retainedCents,
                lines: preview.data.lines.map((l) => ({ id: l.companyTenantId, companyTenantId: l.companyTenantId, companyName: l.companyName, shareBps: l.shareBps, amountCents: l.amountCents, transferId: null, entryDate: null, postedLate: false, memoNote: null })),
              }} />
            </div>
          )}
        </div>
      )}

      {/* Runs */}
      <div className="space-y-2">
        <p className={labelCls}>Recharge runs</p>
        {summary.isLoading ? <p className="s-card p-6 text-center text-sm text-white/40">Loading…</p>
          : (s?.runs ?? []).length === 0 ? <p className="s-card p-6 text-center text-sm text-white/45">No recharge runs yet.</p>
          : (
            <ul className="space-y-2">
              {s!.runs.map((r) => (
                <li key={r.id} className="s-card overflow-hidden">
                  <button type="button" className="flex w-full flex-wrap items-center justify-between gap-3 p-4 text-left" onClick={() => setOpenRun(openRun === r.id ? null : r.id)} aria-expanded={openRun === r.id}>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-white/85">{runMonthLabel(r.period)}</span>
                      <span className={RUN_BADGE[r.status].cls}>{RUN_BADGE[r.status].label}</span>
                      <span className="s-badge-purple">{r.kind === 'true_up' ? 'True-up' : 'Monthly'}</span>
                      {r.stale && <span className="s-badge-amber">Out of date</span>}
                    </span>
                    <span className="tabular-nums text-white/85">{fmtPkr(r.rechargedCents)}</span>
                  </button>
                  {openRun === r.id && (
                    <RechargeRunDetail runId={r.id} canPrepare={canPrepare} canDecide={canDecide} canReverse={canReverse} onClose={() => setOpenRun(null)} setMsg={setMsg} />
                  )}
                </li>
              ))}
            </ul>
          )}
      </div>

      {s && s.companies.length > 0 && (
        <StatementCard headOfficeId={ho.id} companies={s.companies.map((c) => ({ id: c.companyTenantId, name: c.companyName }))} />
      )}
    </section>
  )
}

// ─── Company member view ─────────────────────────────────────────────────────

function ChargesSection({ runs, setMsg }: { runs: RechargeRun[]; setMsg: (m: Msg) => void }) {
  const byHo = useMemo(() => {
    const m = new Map<string, { name: string; runs: RechargeRun[] }>()
    for (const r of runs) {
      const e = m.get(r.tenantId) ?? { name: r.headOfficeName ?? 'Head office', runs: [] }
      e.runs.push(r)
      m.set(r.tenantId, e)
    }
    return [...m.entries()]
  }, [runs])
  const [openRun, setOpenRun] = useState<string | null>(null)
  const balances = useQuery({
    queryKey: ['ic', 'balances', 'head-office-company-view'],
    queryFn: () => api.get<{ pairs: Pair[] }>('/accounting/intercompany/balances'),
  })

  return (
    <div className="space-y-6">
      {byHo.map(([hoId, g]) => {
        // The companies of mine this head office charges (a company viewer only sees its own lines).
        const myCompanies = new Map<string, string>()
        for (const r of g.runs) for (const l of r.lines) myCompanies.set(l.companyTenantId, l.companyName ?? 'Company')
        const pairs = (balances.data?.pairs ?? []).filter((p) => p.a.id === hoId || p.b.id === hoId)
        return (
          <section key={hoId} className="space-y-3" aria-label={`Charges from ${g.name}`}>
            <h2 className="text-lg font-bold text-white/90">Charged by {g.name}</h2>

            {pairs.length > 0 && (
              <div className="s-card divide-y text-sm" style={{ borderColor: 'var(--border)' }}>
                {pairs.map((p) => {
                  const hoIsA = p.a.id === hoId
                  const owedToHo = p.netOwedByA === null ? null : hoIsA ? -p.netOwedByA : p.netOwedByA
                  const other = hoIsA ? p.b : p.a
                  return (
                    <div key={`${p.a.id}:${p.b.id}`} className="flex flex-wrap items-center justify-between gap-2 p-3">
                      <span className="text-white/75">{other.name ?? 'Company'} owes {g.name}</span>
                      <span className="flex items-center gap-3">
                        <Money cents={owedToHo} />
                        {p.mismatchCents !== null && p.mismatchCents !== 0 && <span className="s-badge-red">Books differ by {fmtPkr(p.mismatchCents)}</span>}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}

            <ul className="space-y-2">
              {g.runs.map((r) => (
                <li key={r.id} className="s-card overflow-hidden">
                  <button type="button" className="flex w-full flex-wrap items-center justify-between gap-3 p-4 text-left" onClick={() => setOpenRun(openRun === r.id ? null : r.id)} aria-expanded={openRun === r.id}>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-white/85">{runMonthLabel(r.period)}</span>
                      <span className={RUN_BADGE[r.status].cls}>{RUN_BADGE[r.status].label}</span>
                      <span className="s-badge-purple">{r.kind === 'true_up' ? 'True-up' : 'Monthly'}</span>
                    </span>
                    <span className="tabular-nums text-white/85">{fmtPkr(r.rechargedCents)}</span>
                  </button>
                  {openRun === r.id && (
                    <RechargeRunDetail runId={r.id} canPrepare={false} canDecide={false} canReverse={false} onClose={() => setOpenRun(null)} setMsg={setMsg} />
                  )}
                </li>
              ))}
            </ul>

            {myCompanies.size > 0 && (
              <>
                <CompanyCloseStatus companies={[...myCompanies.entries()].map(([id, name]) => ({ id, name }))} />
                <StatementCard headOfficeId={hoId} companies={[...myCompanies.entries()].map(([id, name]) => ({ id, name }))} />
              </>
            )}
          </section>
        )
      })}
    </div>
  )
}

/** Would this company's close be held up by a head office that has not charged it yet? */
function CompanyCloseStatus({ companies }: { companies: Array<{ id: string; name: string }> }) {
  const through = lastDayOfPrevMonthPkt()
  const [id, setId] = useState(companies[0]!.id)
  const q = useQuery({
    queryKey: ['ic', 'close-status', id, through],
    queryFn: () => api.get<CloseStatus>(`/accounting/intercompany/recharge-runs/close-status?tenantId=${encodeURIComponent(id)}&through=${through}`),
    retry: false,
  })
  return (
    <div className="s-card space-y-2 p-4 text-sm">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className={labelCls}>Month close — through {through}</p>
        {companies.length > 1 && (
          <Select value={id} onChange={(e) => setId(e.target.value)} className="s-select" aria-label="Company">
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        )}
      </div>
      {q.isLoading ? <span className="text-white/40">Checking…</span>
        : q.isError ? <span className="text-white/45">{errText(q.error)}</span>
        : q.data!.charges.length === 0 ? <span className="text-success">No head-office charge is holding up the close.</span>
        : (
          <ul className="space-y-1" style={{ color: 'var(--erp-warning)' }}>
            {q.data!.charges.map((p) => (
              <li key={`${p.headOfficeId}:${p.period}`}>{p.headOfficeName}, {runMonthLabel(p.period)}: {p.reasons.map((r) => REASON_TEXT[r] ?? r).join('; ')}</li>
            ))}
          </ul>
        )}
    </div>
  )
}

// ─── Statement (both views) ──────────────────────────────────────────────────

const CATEGORY_LABEL: Record<string, string> = { charges: 'Charge', settlements: 'Settlement', adjustments: 'Adjustment', other: 'Other' }

function StatementCard({ headOfficeId, companies }: { headOfficeId: string; companies: Array<{ id: string; name: string }> }) {
  const cur = currentMonthPkt()
  const [companyId, setCompanyId] = useState(companies[0]!.id)
  const [from, setFrom] = useState(`${addMonthsTo(cur, -2)}-01`)
  const [to, setTo] = useState(new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10))
  const [asked, setAsked] = useState(0)

  const q = useQuery({
    queryKey: ['ic', 'statement', headOfficeId, companyId, from, to, asked],
    queryFn: () => api.get<Statement>(`/accounting/intercompany/recharge-runs/statement?headOfficeId=${encodeURIComponent(headOfficeId)}&companyId=${encodeURIComponent(companyId)}&from=${from}&to=${to}`),
    enabled: asked > 0,
    retry: false,
  })
  const st = q.data

  return (
    <div className="s-card space-y-3 p-4">
      <p className={labelCls}>Statement</p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Company">
          <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="s-select">
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Button variant="secondary" type="button"  disabled={!from || !to || from > to} onClick={() => setAsked((n) => n + 1)}>Show statement</Button>
        <ExportMenu disabled={!from || !to || from > to}
          path={`/accounting/intercompany/recharge-runs/statement?headOfficeId=${encodeURIComponent(headOfficeId)}&companyId=${encodeURIComponent(companyId)}&from=${from}&to=${to}`}
          filename={`head-office-statement-${from}-${to}`} />
      </div>
      {q.isError && <p className="text-sm" style={{ color: danger }}>{errText(q.error)}</p>}
      {st && (
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {([['Opening', st.openingCents], ['Charges', st.chargesCents], ['Settlements', st.settlementsCents], ['Adjustments', st.adjustmentsCents], ['Closing (head office books)', st.closingCents], ['Closing (company books)', st.companyClosingCents]] as Array<[string, number]>).map(([k, v]) => (
              <div key={k}><dt className={labelCls}>{k}</dt><dd><Money cents={v} /></dd></div>
            ))}
            <div><dt className={labelCls}>Difference</dt><dd><Money cents={st.differenceCents} bad /></dd></div>
          </dl>
          {st.rows.length === 0 ? <p className="text-sm text-white/45">No movements in this range.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <tbody>
                  {st.rows.map((r, i) => (
                    <tr key={`${r.transferId ?? r.reference ?? 'row'}:${i}`} className="border-t" style={{ borderColor: 'var(--border)' }}>
                      <td className="py-1.5 pr-2 text-white/55 tabular-nums">{r.date.slice(0, 10)}</td>
                      <td className="py-1.5 pr-2"><span className="s-badge-muted">{CATEGORY_LABEL[r.category] ?? r.category}</span>{r.reversal && <span className="s-badge-amber ml-1">Reversal</span>}</td>
                      <td className="py-1.5 pr-2 text-white/80">{r.description}</td>
                      <td className="py-1.5 text-right"><Money cents={r.cents} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
