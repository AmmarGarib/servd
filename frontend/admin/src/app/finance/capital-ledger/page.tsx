'use client'
// ─── Investment Dashboard ────────────────────────────────────────────────────
//
// Previously a flat Excel-mirror ledger with its own table. Now a read-only
// roll-up sourced from Project Tracker — every CapexLine + CapexPayment in
// every CapexProject flattens into the dashboard. Project Tracker is the
// single entry point for data; this page is the executive summary.
//
// Route kept as /finance/capital-ledger so old bookmarks still work. Title +
// sidebar label both read "Investment".

import { useMemo } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'

// ─── Types — mirrors what /finance/capex returns from withRollups ───────────

interface Payment {
  id: string
  label: 'deposit' | 'midpoint' | 'balance' | 'extra'
  amountCents: number
  dueDate: string | null
  paidAt: string | null
  paidAmountCents: number | null
  paymentRef: string | null
}
interface Quote {
  id: string
  vendor: string
  totalCents: number
  isWinner: boolean
}
interface Line {
  id: string
  scope: string
  category: string | null
  item: string
  quantity: number
  unitCostCents: number
  vendor: string | null
  quotedCents: number | null
  negotiatedCents: number | null
  paidCents: number
  status: string
  quotes: Quote[]
  payments: Payment[]
}
interface Project {
  id: string
  name: string
  phase: 'planning' | 'quoting' | 'executing' | 'snagging' | 'live'
  projectType: string
  budgetEnvelopeCents: number
  consultantFeesCents: number
  taxCents: number
  contingencyPct: number
  targetOpeningDate: string | null
  actualOpeningDate: string | null
  lines: Line[]
  rollups: {
    budgetedCents: number
    quotedCents: number
    committedCents: number
    paidCents: number
    remainingCents: number
    contingencyCents: number
    totalAskCents: number
    varianceVsEnvelopeCents: number
  }
}

const SCOPE_META: Record<string, { emoji: string; label: string; color: string }> = {
  BOH:        { emoji: '🍳', label: 'Back of House',  color: '#F59E0B' },
  FOH:        { emoji: '🪑', label: 'Front of House', color: '#6366F1' },
  AG:         { emoji: '✨', label: 'AG / Finishing', color: '#EC4899' },
  Equipment:  { emoji: '🛠', label: 'Small wares',    color: '#A855F7' },
  MEP:        { emoji: '⚡', label: 'MEP',            color: '#FCD34D' },
  Civil:      { emoji: '🏗', label: 'Civil',          color: '#94A3B8' },
  Tech:       { emoji: '💻', label: 'Tech',           color: '#0EA5E9' },
  Branding:   { emoji: '🎨', label: 'Branding',       color: '#EF4444' },
  Permits:    { emoji: '📑', label: 'Permits',        color: '#22C55E' },
  SoftCosts:  { emoji: '📐', label: 'Soft costs',     color: '#5EEAD4' },
  Other:      { emoji: '📦', label: 'Other',          color: '#9CA3AF' },
}

const PHASE_META: Record<Project['phase'], { label: string; bg: string; fg: string }> = {
  planning:  { label: 'Planning',   bg: 'rgba(99,102,241,0.12)',  fg: '#A5B4FC' },
  quoting:   { label: 'Quoting',    bg: 'rgba(245,158,11,0.12)',  fg: '#FCD34D' },
  executing: { label: 'Executing',  bg: 'rgba(0,212,177,0.12)',   fg: '#00D4B1' },
  snagging:  { label: 'Snagging',   bg: 'rgba(168,85,247,0.12)',  fg: '#D8B4FE' },
  live:      { label: 'Live',       bg: 'rgba(34,197,94,0.15)',   fg: '#86EFAC' },
}

const PKR = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`
const PKR_LAKHS = (c: number) => {
  const lakhs = c / 100 / 100_000
  if (lakhs >= 1) return `PKR ${lakhs.toFixed(lakhs >= 10 ? 0 : 1)}L`
  return PKR(c)
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function InvestmentDashboardPage() {
  const { data: projects = [], isLoading } = useQuery<Project[]>({
    queryKey: ['capex-projects', 'dashboard'],
    queryFn:  () => api.get('/finance/capex'),
  })

  // ── Aggregate rollups across every project ────────────────────────────────
  const agg = useMemo(() => {
    let envelope = 0, committed = 0, paid = 0, totalAsk = 0, lineCount = 0
    const scopeSpend = new Map<string, number>()       // scope key → committed cents
    const vendorSpend = new Map<string, { paid: number; lines: number; projects: Set<string> }>()
    const recentPayments: Array<{ projectName: string; line: Line; payment: Payment }> = []

    for (const p of projects) {
      envelope  += p.budgetEnvelopeCents
      committed += p.rollups.committedCents
      paid      += p.rollups.paidCents
      totalAsk  += p.rollups.totalAskCents
      lineCount += p.lines.length

      for (const line of p.lines) {
        const lineCommitted = line.negotiatedCents ?? line.unitCostCents * line.quantity
        scopeSpend.set(line.scope, (scopeSpend.get(line.scope) ?? 0) + lineCommitted)

        if (line.vendor) {
          const v = vendorSpend.get(line.vendor) ?? { paid: 0, lines: 0, projects: new Set<string>() }
          v.paid += line.paidCents
          v.lines += 1
          v.projects.add(p.id)
          vendorSpend.set(line.vendor, v)
        }

        for (const pay of line.payments) {
          if (pay.paidAt) recentPayments.push({ projectName: p.name, line, payment: pay })
        }
      }
    }

    recentPayments.sort((a, b) => (b.payment.paidAt! > a.payment.paidAt! ? 1 : -1))

    // Burn rate: paid in last 90 days / 3 months
    const ninetyDaysAgo = Date.now() - 90 * 86_400_000
    const last90Paid = recentPayments
      .filter((r) => new Date(r.payment.paidAt!).getTime() >= ninetyDaysAgo)
      .reduce((s, r) => s + (r.payment.paidAmountCents ?? 0), 0)
    const burnPerMonth = Math.round(last90Paid / 3)

    // Monthly breakdown for the sparkline (last 6 months)
    const monthly = new Map<string, number>()
    for (const r of recentPayments) {
      const d = new Date(r.payment.paidAt!)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      monthly.set(key, (monthly.get(key) ?? 0) + (r.payment.paidAmountCents ?? 0))
    }
    const last6Months: Array<{ key: string; label: string; cents: number }> = []
    const now = new Date()
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      last6Months.push({
        key,
        label: d.toLocaleDateString('en-PK', { month: 'short' }),
        cents: monthly.get(key) ?? 0,
      })
    }

    const topVendors = Array.from(vendorSpend.entries())
      .map(([name, v]) => ({ name, paid: v.paid, lines: v.lines, projects: v.projects.size }))
      .sort((a, b) => b.paid - a.paid)
      .slice(0, 5)

    const topScopes = Array.from(scopeSpend.entries())
      .map(([scope, cents]) => ({ scope, cents }))
      .sort((a, b) => b.cents - a.cents)

    return {
      envelope, committed, paid, totalAsk, lineCount,
      burnPerMonth, last6Months, topVendors, topScopes,
      recentPayments: recentPayments.slice(0, 15),
      runwayMonths: burnPerMonth > 0 ? (envelope - paid) / burnPerMonth : null,
    }
  }, [projects])

  const pctPaid     = agg.totalAsk > 0 ? Math.round((agg.paid / agg.totalAsk) * 100) : 0
  const pctCmttd    = agg.totalAsk > 0 ? Math.round((agg.committed / agg.totalAsk) * 100) : 0
  const max6mo      = Math.max(1, ...agg.last6Months.map((m) => m.cents))
  const maxScope    = Math.max(1, ...agg.topScopes.map((s) => s.cents))

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <div className="flex items-center gap-2 text-xs text-white/40 mb-2">
          <Link href="/finance" className="hover:text-white/70">← Finance</Link>
        </div>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-black text-white/90">📊 Investment Dashboard</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Roll-up of every project in Project Tracker — total ask, paid, committed, burn rate,
              spend by scope, top vendors. Read-only by design: log every PKR out in
              {' '}
              <Link href="/finance/capex" className="text-kds-green font-bold hover:opacity-80">
                Project Tracker
              </Link>
              {' '}
              and it lands here.
            </p>
          </div>
          <Link href="/finance/capex"
            className="rounded-xl bg-kds-green px-4 py-2.5 text-sm font-black text-black hover:opacity-90">
            Open Project Tracker →
          </Link>
        </div>
      </header>

      <div className="px-7 py-6 max-w-6xl mx-auto space-y-6">
        {/* ── Empty state ───────────────────────────────────────────────── */}
        {!isLoading && projects.length === 0 && (
          <div className="rounded-2xl p-12 text-center"
            style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-4xl mb-2">📊</p>
            <p className="font-bold text-white/85">Nothing to roll up yet</p>
            <p className="text-sm text-white/45 mt-1 mb-4">
              Spin up a project — kitchen build, refurb, expansion — and every line + payment
              you log there shows up here.
            </p>
            <Link href="/finance/capex"
              className="inline-block rounded-xl bg-kds-green px-4 py-2.5 text-sm font-black text-black hover:opacity-90">
              + Start a project
            </Link>
          </div>
        )}

        {projects.length > 0 && (
          <>
            {/* ── KPI tiles ──────────────────────────────────────────────── */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <KpiTile
                label="Total ask"
                hint={`${projects.length} project${projects.length === 1 ? '' : 's'}`}
                value={PKR_LAKHS(agg.totalAsk)}
                subValue={PKR(agg.totalAsk)}
                bg="rgba(99,102,241,0.05)" border="rgba(99,102,241,0.22)" color="#A5B4FC"
              />
              <KpiTile
                label="Paid to date"
                hint={`${pctPaid}% of ask`}
                value={PKR_LAKHS(agg.paid)}
                subValue={PKR(agg.paid)}
                bg="rgba(245,158,11,0.05)" border="rgba(245,158,11,0.22)" color="#FCD34D"
              />
              <KpiTile
                label="Committed"
                hint={`${pctCmttd}% of ask`}
                value={PKR_LAKHS(agg.committed)}
                subValue={`${PKR_LAKHS(agg.committed - agg.paid)} unpaid`}
                bg="rgba(0,212,177,0.05)" border="rgba(0,212,177,0.22)" color="#00D4B1"
              />
              <KpiTile
                label="Burn rate / mo"
                hint={agg.runwayMonths ? `~${agg.runwayMonths.toFixed(1)} mo runway` : 'avg over 90 days'}
                value={PKR_LAKHS(agg.burnPerMonth)}
                subValue={`over last 90 days`}
                bg="rgba(236,72,153,0.05)" border="rgba(236,72,153,0.22)" color="#F9A8D4"
              />
            </div>

            {/* ── Progress bar against total ask ─────────────────────────── */}
            {agg.totalAsk > 0 && (
              <div className="rounded-2xl p-4"
                style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="flex justify-between items-baseline mb-2">
                  <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/45">Deployment vs total ask</p>
                  <p className="text-xs text-white/55">
                    <span className="text-amber-400 font-bold">{PKR_LAKHS(agg.paid)} paid</span> ·
                    <span className="text-kds-green font-bold ml-1.5">{PKR_LAKHS(agg.committed)} committed</span> ·
                    <span className="text-white/50 ml-1.5">{PKR_LAKHS(agg.totalAsk - agg.committed)} unallocated</span>
                  </p>
                </div>
                <div className="h-2.5 rounded-full overflow-hidden flex" style={{ background: 'rgba(255,255,255,0.06)' }}>
                  <div className="h-full" style={{ width: `${Math.min(100, pctPaid)}%`, background: '#F59E0B' }} />
                  <div className="h-full" style={{ width: `${Math.min(100, Math.max(0, pctCmttd - pctPaid))}%`, background: 'rgba(0,212,177,0.6)' }} />
                </div>
              </div>
            )}

            {/* ── 2-col: monthly burn + projects ─────────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.3fr] gap-3">
              {/* Monthly burn chart */}
              <div className="rounded-2xl p-5"
                style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/45 mb-4">Monthly paid · last 6 months</p>
                <div className="flex items-end gap-2 h-32">
                  {agg.last6Months.map((m) => {
                    const h = m.cents > 0 ? Math.max(4, Math.round((m.cents / max6mo) * 100)) : 0
                    return (
                      <div key={m.key} className="flex-1 flex flex-col items-center gap-1">
                        <div className="text-[9px] text-white/40 font-mono">
                          {m.cents > 0 ? PKR_LAKHS(m.cents) : '—'}
                        </div>
                        <div className="w-full rounded-t-md transition-all"
                          style={{
                            height: `${h}%`,
                            background: m.cents > 0
                              ? 'linear-gradient(180deg, #F59E0B 0%, rgba(245,158,11,0.4) 100%)'
                              : 'rgba(255,255,255,0.04)',
                          }} />
                        <div className="text-[10px] text-white/50 font-bold uppercase">{m.label}</div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Projects list */}
              <div className="rounded-2xl p-5"
                style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="flex justify-between items-baseline mb-3">
                  <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/45">Projects ({projects.length})</p>
                  <Link href="/finance/capex" className="text-[10px] text-kds-green font-bold hover:opacity-80">Manage →</Link>
                </div>
                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                  {projects.map((p) => {
                    const phaseM = PHASE_META[p.phase]
                    const pct = p.budgetEnvelopeCents > 0 ? Math.min(100, Math.round((p.rollups.paidCents / p.budgetEnvelopeCents) * 100)) : 0
                    const over = p.rollups.varianceVsEnvelopeCents > 0
                    return (
                      <Link key={p.id} href={`/finance/capex?project=${p.id}`}
                        className="block rounded-xl p-3 transition-colors hover:bg-white/[0.04]"
                        style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)' }}>
                        <div className="flex items-start justify-between gap-2">
                          <p className="font-bold text-sm text-white/90 truncate flex-1">{p.name}</p>
                          <span className="shrink-0 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded"
                            style={{ background: phaseM.bg, color: phaseM.fg }}>{phaseM.label}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-1.5">
                          <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                            <div className="h-full"
                              style={{ width: `${pct}%`, background: over ? '#FF4D4F' : pct > 70 ? '#F59E0B' : '#00D4B1' }} />
                          </div>
                          <p className="text-[10px] text-white/55 shrink-0 font-mono">
                            {PKR_LAKHS(p.rollups.paidCents)} / {PKR_LAKHS(p.budgetEnvelopeCents || p.rollups.totalAskCents)}
                          </p>
                        </div>
                        <p className="text-[10px] text-white/40 mt-1">
                          {p.lines.length} lines · {p.rollups.committedCents > 0 ? `${PKR_LAKHS(p.rollups.committedCents)} committed` : 'no commitments yet'}
                          {over && <span className="text-red-400 font-bold"> · over by {PKR_LAKHS(p.rollups.varianceVsEnvelopeCents)}</span>}
                        </p>
                      </Link>
                    )
                  })}
                </div>
              </div>
            </div>

            {/* ── Spend by scope ─────────────────────────────────────────── */}
            {agg.topScopes.length > 0 && (
              <div className="rounded-2xl p-5"
                style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/45 mb-3">Spend by scope (across all projects)</p>
                <div className="space-y-2">
                  {agg.topScopes.map((s) => {
                    const meta = SCOPE_META[s.scope] ?? { emoji: '·', label: s.scope, color: '#9CA3AF' }
                    const pct = (s.cents / maxScope) * 100
                    return (
                      <div key={s.scope} className="flex items-center gap-3">
                        <div className="w-32 shrink-0 flex items-center gap-1.5 text-xs text-white/70">
                          <span>{meta.emoji}</span>
                          <span className="font-bold">{meta.label}</span>
                        </div>
                        <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                          <div className="h-full transition-all"
                            style={{ width: `${pct}%`, background: meta.color, opacity: 0.85 }} />
                        </div>
                        <p className="w-24 shrink-0 text-right text-xs font-mono text-white/75">{PKR_LAKHS(s.cents)}</p>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* ── 2-col: top vendors + recent payments ───────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <div className="rounded-2xl p-5"
                style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/45 mb-3">Top vendors by spend</p>
                {agg.topVendors.length === 0 ? (
                  <p className="text-xs text-white/40">No vendor payments recorded yet.</p>
                ) : (
                  <div className="space-y-2">
                    {agg.topVendors.map((v) => (
                      <div key={v.name} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2"
                        style={{ background: 'rgba(255,255,255,0.025)' }}>
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-white/85 truncate">{v.name}</p>
                          <p className="text-[10px] text-white/45">
                            {v.lines} line{v.lines === 1 ? '' : 's'} · {v.projects} project{v.projects === 1 ? '' : 's'}
                          </p>
                        </div>
                        <p className="text-sm font-mono font-bold text-amber-400 shrink-0">{PKR_LAKHS(v.paid)}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-2xl p-5"
                style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/45 mb-3">Recent payments</p>
                {agg.recentPayments.length === 0 ? (
                  <p className="text-xs text-white/40">No payments logged yet. Add one from a line in Project Tracker.</p>
                ) : (
                  <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                    {agg.recentPayments.map((r) => (
                      <div key={r.payment.id} className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs"
                        style={{ background: 'rgba(255,255,255,0.02)' }}>
                        <span className="text-white/45 font-mono text-[10px] w-16 shrink-0">
                          {new Date(r.payment.paidAt!).toLocaleDateString('en-PK', { day: 'numeric', month: 'short' })}
                        </span>
                        <span className="font-mono font-bold text-amber-400 shrink-0 w-20 text-right">
                          {PKR_LAKHS(r.payment.paidAmountCents ?? 0)}
                        </span>
                        <span className="text-white/80 truncate flex-1">{r.line.item}</span>
                        <span className="text-white/35 text-[10px] shrink-0 hidden sm:inline">{r.projectName}</span>
                        <span className="text-[9px] uppercase tracking-wider font-bold rounded px-1.5 py-0.5 shrink-0"
                          style={{
                            background: r.payment.label === 'deposit' ? 'rgba(99,102,241,0.15)'
                                      : r.payment.label === 'balance' ? 'rgba(34,197,94,0.15)'
                                      : 'rgba(245,158,11,0.15)',
                            color:      r.payment.label === 'deposit' ? '#A5B4FC'
                                      : r.payment.label === 'balance' ? '#86EFAC'
                                      : '#FCD34D',
                          }}>
                          {r.payment.label}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {isLoading && (
          <p className="text-sm text-white/40 text-center py-12">Loading roll-up…</p>
        )}
      </div>
    </div>
  )
}

function KpiTile({
  label, hint, value, subValue, bg, border, color,
}: { label: string; hint: string; value: string; subValue: string; bg: string; border: string; color: string }) {
  return (
    <div className="rounded-2xl p-4" style={{ background: bg, border: `1px solid ${border}` }}>
      <p className="text-[10px] font-black uppercase tracking-[0.24em]" style={{ color }}>{label}</p>
      <p className="text-2xl font-black mt-1.5" style={{ color }}>{value}</p>
      <p className="text-[10px] text-white/45 mt-1">{subValue}</p>
      <p className="text-[9px] text-white/35 mt-0.5">{hint}</p>
    </div>
  )
}
