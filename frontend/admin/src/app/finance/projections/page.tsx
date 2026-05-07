'use client'
import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Channel {
  id: string
  name: string
  checkAvgCents: number
  ordersMon: number; ordersTue: number; ordersWed: number; ordersThu: number
  ordersFri: number; ordersSat: number; ordersSun: number
}
interface FixedCost {
  id: string
  category: string
  monthlyCents: number
  notes: string | null
}
interface Month {
  monthIndex: number
  rampPct: number
  revenueCents: number
  variableCents: number
  fixedCents: number
  opexCents: number
  profitCents: number
  cumulativeCashCents: number
}
interface ProForma {
  id: string
  name: string
  scenario: string
  totalAskCents: number
  capexCents: number
  workingCapitalCents: number
  brokerFeeCents: number
  rentAdvanceSecurityCents: number
  variableCostPct: number
  tradingDaysPerMonth: number
  notes: string | null
  channels: Channel[]
  fixedCosts: FixedCost[]
  months: Month[]
  steadyStateMonthlyCents: number
  totalFixedMonthlyCents: number
  paybackMonth: number | null
}

function fmtPKR(cents: number) {
  if (Math.abs(cents) >= 1_00_000_00) return `${cents < 0 ? '-' : ''}PKR ${(Math.abs(cents) / 1_00_000_00).toFixed(1)}L`
  if (Math.abs(cents) >= 1_000_00)    return `${cents < 0 ? '-' : ''}PKR ${(Math.abs(cents) / 1_000_00).toFixed(0)}K`
  return `${cents < 0 ? '-' : ''}PKR ${(Math.abs(cents) / 100).toFixed(0)}`
}

export default function ProjectionsPage() {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const { data: list = [] } = useQuery<ProForma[]>({
    queryKey: ['projections'],
    queryFn: () => api.get('/finance/projections'),
  })
  useEffect(() => { if (!selectedId && list.length > 0) setSelectedId(list[0]!.id) }, [list, selectedId])

  const { data: detail } = useQuery<ProForma>({
    queryKey: ['projection', selectedId],
    queryFn: () => api.get(`/finance/projections/${selectedId}`),
    enabled: !!selectedId,
  })

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <div className="flex items-center gap-2 text-xs text-white/40 mb-2">
          <Link href="/finance" className="hover:text-white/70">← Finance</Link>
        </div>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-black text-white/90">📈 Pro-Forma Projections</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Model a new unit. Enter capex, channels, fixed costs + ramp curve → see monthly P&L, cumulative cash flow, payback period. Replaces the &quot;Annual Projection&quot; tab in your Excel.
            </p>
          </div>
          <button onClick={() => setShowAdd(true)}
            className="rounded-xl bg-kds-green px-4 py-2.5 text-sm font-black text-black hover:opacity-90">
            + New scenario
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <aside className="w-72 shrink-0 border-r border-white/[0.05] overflow-y-auto p-3 space-y-1">
          {list.length === 0 && (
            <p className="text-sm text-white/40 p-4 text-center">No scenarios yet</p>
          )}
          {list.map((p) => (
            <button key={p.id} onClick={() => setSelectedId(p.id)}
              className="w-full text-left rounded-xl p-3"
              style={{
                background: p.id === selectedId ? 'rgba(0,212,177,0.08)' : 'rgba(255,255,255,0.025)',
                border: p.id === selectedId ? '1px solid rgba(0,212,177,0.35)' : '1px solid rgba(255,255,255,0.06)',
              }}>
              <p className="font-bold text-sm text-white/85 truncate">{p.name}</p>
              <p className="text-[10px] text-white/40 mt-0.5 uppercase tracking-wider">{p.scenario}</p>
            </button>
          ))}
        </aside>

        <main className="flex-1 overflow-y-auto p-6">
          {!detail && list.length === 0 && (
            <div className="text-center mt-20 text-white/40">Create a new scenario to start modelling</div>
          )}
          {detail && <ScenarioDetail proForma={detail} onChange={() => {
            void qc.invalidateQueries({ queryKey: ['projection', selectedId] })
            void qc.invalidateQueries({ queryKey: ['projections'] })
          }} />}
        </main>
      </div>

      {showAdd && (
        <AddScenarioModal onClose={() => setShowAdd(false)}
          onCreated={(id) => {
            setShowAdd(false); setSelectedId(id)
            void qc.invalidateQueries({ queryKey: ['projections'] })
          }} />
      )}
    </div>
  )
}

function ScenarioDetail({ proForma, onChange }: { proForma: ProForma; onChange: () => void }) {
  const ssRevenue = proForma.steadyStateMonthlyCents
  const breakEven = proForma.totalFixedMonthlyCents / Math.max(0.01, 1 - proForma.variableCostPct)
  const breakEvenPctOfSS = ssRevenue > 0 ? Math.round((breakEven / ssRevenue) * 100) : 0

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-black text-white/95">{proForma.name}</h2>
          <p className="text-xs text-white/40 mt-1 capitalize">{proForma.scenario} scenario</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-white/40 uppercase tracking-wider">Payback period</p>
          <p className="text-2xl font-black"
            style={{ color: proForma.paybackMonth ? '#00D4B1' : '#F59E0B' }}>
            {proForma.paybackMonth ? `Month ${proForma.paybackMonth}` : '> 12 months'}
          </p>
        </div>
      </div>

      {/* Top KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KPI label="Total ask"        value={fmtPKR(proForma.totalAskCents)}              color="#94A3B8" />
        <KPI label="Steady-state rev/mo" value={fmtPKR(ssRevenue)}                        color="#00D4B1" />
        <KPI label="Break-even rev/mo" value={fmtPKR(Math.round(breakEven))}              color="#F59E0B" sub={`${breakEvenPctOfSS}% of SS`} />
        <KPI label="Fixed costs/mo"   value={fmtPKR(proForma.totalFixedMonthlyCents)}     color="#6366F1" />
      </div>

      {/* Channels */}
      <ChannelsSection proForma={proForma} onChange={onChange} />

      {/* Fixed costs */}
      <FixedCostsSection proForma={proForma} onChange={onChange} />

      {/* Monthly P&L table */}
      <MonthlyPL proForma={proForma} onChange={onChange} />
    </div>
  )
}

function KPI({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <div className="rounded-2xl p-4"
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/40">{label}</p>
      <p className="text-xl font-black mt-1.5" style={{ color }}>{value}</p>
      {sub && <p className="text-[10px] text-white/40 mt-1">{sub}</p>}
    </div>
  )
}

function ChannelsSection({ proForma, onChange }: { proForma: ProForma; onChange: () => void }) {
  const [showAdd, setShowAdd] = useState(false)
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-black uppercase tracking-[0.22em] text-white/60">Revenue channels</h3>
        <button onClick={() => setShowAdd(true)} className="text-xs font-bold text-kds-green">+ Channel</button>
      </div>
      <div className="rounded-2xl overflow-hidden"
        style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
        {proForma.channels.length === 0 ? (
          <p className="p-4 text-sm text-white/40 text-center">No channels yet — add Ghost / Takeout / Restaurant / etc.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-white/[0.02]">
              <tr>
                <th className="px-3 py-2 text-left text-[10px] font-black uppercase tracking-wider text-white/40">Channel</th>
                <th className="px-3 py-2 text-right text-[10px] font-black uppercase tracking-wider text-white/40">Avg</th>
                {['Tue','Wed','Thu','Fri','Sat','Sun','Mon'].map((d) => (
                  <th key={d} className="px-2 py-2 text-center text-[10px] font-black uppercase tracking-wider text-white/40">{d}</th>
                ))}
                <th className="px-3 py-2 text-right text-[10px] font-black uppercase tracking-wider text-white/40">Mo. Rev</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.03]">
              {proForma.channels.map((c) => {
                const weeklyOrders = c.ordersMon + c.ordersTue + c.ordersWed + c.ordersThu + c.ordersFri + c.ordersSat + c.ordersSun
                const monthlyOrders = (weeklyOrders / 7) * proForma.tradingDaysPerMonth
                const monthlyRevenue = Math.round(monthlyOrders * c.checkAvgCents)
                return (
                  <tr key={c.id}>
                    <td className="px-3 py-2 font-bold text-white/85">{c.name}</td>
                    <td className="px-3 py-2 text-right font-mono text-white/65">{fmtPKR(c.checkAvgCents)}</td>
                    {[c.ordersTue, c.ordersWed, c.ordersThu, c.ordersFri, c.ordersSat, c.ordersSun, c.ordersMon].map((n, i) => (
                      <td key={i} className="px-2 py-2 text-center font-mono text-white/55">{n}</td>
                    ))}
                    <td className="px-3 py-2 text-right font-mono font-bold text-kds-green">{fmtPKR(monthlyRevenue)}</td>
                    <td className="px-3 py-2 text-right">
                      <DeleteChannel id={c.id} onDone={onChange} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      {showAdd && (
        <AddChannelModal proFormaId={proForma.id}
          onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); onChange() }} />
      )}
    </section>
  )
}

function FixedCostsSection({ proForma, onChange }: { proForma: ProForma; onChange: () => void }) {
  const [showAdd, setShowAdd] = useState(false)
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-black uppercase tracking-[0.22em] text-white/60">Monthly fixed costs</h3>
        <button onClick={() => setShowAdd(true)} className="text-xs font-bold text-kds-green">+ Cost</button>
      </div>
      <div className="rounded-2xl overflow-hidden"
        style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
        {proForma.fixedCosts.length === 0 ? (
          <p className="p-4 text-sm text-white/40 text-center">No fixed costs yet — add Rent, Utilities, Payroll, Marketing</p>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-white/[0.03]">
              {proForma.fixedCosts.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-2 text-white/85">{c.category}</td>
                  <td className="px-4 py-2 text-right font-mono font-bold text-white/85">{fmtPKR(c.monthlyCents)}</td>
                  <td className="px-4 py-2 text-right">
                    <DeleteCost id={c.id} onDone={onChange} />
                  </td>
                </tr>
              ))}
              <tr className="bg-white/[0.02] font-bold">
                <td className="px-4 py-2 text-white/85">Total fixed</td>
                <td className="px-4 py-2 text-right font-mono text-kds-green">{fmtPKR(proForma.totalFixedMonthlyCents)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
      {showAdd && (
        <AddCostModal proFormaId={proForma.id}
          onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); onChange() }} />
      )}
    </section>
  )
}

function MonthlyPL({ proForma, onChange }: { proForma: ProForma; onChange: () => void }) {
  return (
    <section>
      <h3 className="text-sm font-black uppercase tracking-[0.22em] text-white/60 mb-3">Monthly P&L (12-month projection)</h3>
      <div className="rounded-2xl overflow-x-auto"
        style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <table className="w-full text-xs" style={{ minWidth: '900px' }}>
          <thead className="bg-white/[0.02]">
            <tr>
              <th className="px-3 py-2 text-left text-[10px] font-black uppercase tracking-wider text-white/40">Month</th>
              <th className="px-3 py-2 text-right text-[10px] font-black uppercase tracking-wider text-white/40">Ramp</th>
              <th className="px-3 py-2 text-right text-[10px] font-black uppercase tracking-wider text-white/40">Revenue</th>
              <th className="px-3 py-2 text-right text-[10px] font-black uppercase tracking-wider text-white/40">Variable</th>
              <th className="px-3 py-2 text-right text-[10px] font-black uppercase tracking-wider text-white/40">Fixed</th>
              <th className="px-3 py-2 text-right text-[10px] font-black uppercase tracking-wider text-white/40">P/L</th>
              <th className="px-3 py-2 text-right text-[10px] font-black uppercase tracking-wider text-white/40">Cum. cash</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.03]">
            {proForma.months.map((m) => (
              <tr key={m.monthIndex}>
                <td className="px-3 py-2 font-bold text-white/85">M{m.monthIndex}</td>
                <td className="px-3 py-2 text-right">
                  <RampInput proFormaId={proForma.id} monthIndex={m.monthIndex} value={m.rampPct} onDone={onChange} />
                </td>
                <td className="px-3 py-2 text-right font-mono text-kds-green">{fmtPKR(m.revenueCents)}</td>
                <td className="px-3 py-2 text-right font-mono text-white/55">{fmtPKR(m.variableCents)}</td>
                <td className="px-3 py-2 text-right font-mono text-white/55">{fmtPKR(m.fixedCents)}</td>
                <td className="px-3 py-2 text-right font-mono font-bold"
                  style={{ color: m.profitCents >= 0 ? '#00D4B1' : '#FF4D4F' }}>
                  {fmtPKR(m.profitCents)}
                </td>
                <td className="px-3 py-2 text-right font-mono font-bold"
                  style={{ color: m.cumulativeCashCents >= 0 ? '#00D4B1' : '#FF4D4F' }}>
                  {fmtPKR(m.cumulativeCashCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function RampInput({ proFormaId, monthIndex, value, onDone }: {
  proFormaId: string; monthIndex: number; value: number; onDone: () => void
}) {
  const [val, setVal] = useState(String(Math.round(value * 100)))
  const save = useMutation({
    mutationFn: () => api.patch(`/finance/projections/${proFormaId}/months/${monthIndex}`, {
      rampPct: parseFloat(val) / 100,
    }),
    onSuccess: () => onDone(),
  })
  return (
    <input value={val}
      onChange={(e) => setVal(e.target.value.replace(/[^0-9]/g, ''))}
      onBlur={() => save.mutate()}
      type="text" inputMode="numeric"
      className="w-12 bg-white/[0.03] border border-white/[0.06] rounded px-1.5 py-0.5 text-right font-mono text-white/85 focus:outline-none focus:border-kds-green"
      style={{ fontSize: '11px' }} />
  )
}

function DeleteChannel({ id, onDone }: { id: string; onDone: () => void }) {
  const remove = useMutation({ mutationFn: () => api.delete(`/finance/projections/channels/${id}`), onSuccess: onDone })
  return <button onClick={() => remove.mutate()} className="text-xs text-white/40 hover:text-kds-red">×</button>
}
function DeleteCost({ id, onDone }: { id: string; onDone: () => void }) {
  const remove = useMutation({ mutationFn: () => api.delete(`/finance/projections/fixed-costs/${id}`), onSuccess: onDone })
  return <button onClick={() => remove.mutate()} className="text-xs text-white/40 hover:text-kds-red">×</button>
}

function AddScenarioModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const [totalAsk, setTotalAsk] = useState('')
  const [capex, setCapex] = useState('')
  const [workingCapital, setWorkingCapital] = useState('')
  const [scenario, setScenario] = useState<'base'|'aggressive'|'conservative'>('base')

  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/finance/projections', {
      name: name.trim(),
      scenario,
      totalAskCents: totalAsk ? Math.round(parseFloat(totalAsk) * 100) : 0,
      capexCents: capex ? Math.round(parseFloat(capex) * 100) : 0,
      workingCapitalCents: workingCapital ? Math.round(parseFloat(workingCapital) * 100) : 0,
    }),
    onSuccess: (data) => onCreated(data.id),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl overflow-hidden"
        style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">New projection scenario</h2>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-3">
          <Field label="Name *">
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Stax + Speakeasy v1"
              className="w-full bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-white/90 focus:outline-none focus:border-kds-green" autoFocus />
          </Field>
          <Field label="Scenario">
            <div className="flex gap-1.5">
              {(['base','aggressive','conservative'] as const).map((s) => (
                <button key={s} onClick={() => setScenario(s)}
                  className="flex-1 rounded-lg px-3 py-2 text-xs font-bold capitalize transition-colors"
                  style={scenario === s
                    ? { background: 'rgba(0,212,177,0.12)', border: '1px solid rgba(0,212,177,0.4)', color: '#00D4B1' }
                    : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.6)' }}>
                  {s}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Total ask (PKR)">
            <input value={totalAsk} onChange={(e) => setTotalAsk(e.target.value)} type="number"
              placeholder="20917700"
              className="w-full bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-white/90 focus:outline-none focus:border-kds-green" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="CapEx (PKR)">
              <input value={capex} onChange={(e) => setCapex(e.target.value)} type="number"
                placeholder="15000000"
                className="w-full bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/90 focus:outline-none focus:border-kds-green" />
            </Field>
            <Field label="Working capital (PKR)">
              <input value={workingCapital} onChange={(e) => setWorkingCapital(e.target.value)} type="number"
                placeholder="3117700"
                className="w-full bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/90 focus:outline-none focus:border-kds-green" />
            </Field>
          </div>
        </div>
        <div className="flex justify-between gap-2 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55">Cancel</button>
          <button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}
            className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-40">
            {create.isPending ? 'Creating…' : 'Create scenario'}
          </button>
        </div>
      </div>
    </div>
  )
}

function AddChannelModal({ proFormaId, onClose, onCreated }: { proFormaId: string; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [checkAvg, setCheckAvg] = useState('')
  const [orders, setOrders] = useState({ Mon: '', Tue: '', Wed: '', Thu: '', Fri: '', Sat: '', Sun: '' })

  const create = useMutation({
    mutationFn: () => api.post(`/finance/projections/${proFormaId}/channels`, {
      name: name.trim(),
      checkAvgCents: Math.round(parseFloat(checkAvg) * 100),
      ordersMon: parseInt(orders.Mon, 10) || 0,
      ordersTue: parseInt(orders.Tue, 10) || 0,
      ordersWed: parseInt(orders.Wed, 10) || 0,
      ordersThu: parseInt(orders.Thu, 10) || 0,
      ordersFri: parseInt(orders.Fri, 10) || 0,
      ordersSat: parseInt(orders.Sat, 10) || 0,
      ordersSun: parseInt(orders.Sun, 10) || 0,
    }),
    onSuccess: onCreated,
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl overflow-hidden"
        style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">+ Channel</h2>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-3">
          <Field label="Name *">
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Ghost / Takeout / Stax / Simmer"
              className="w-full bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-white/90 focus:outline-none focus:border-kds-green" autoFocus />
          </Field>
          <Field label="Check average (PKR) *">
            <input value={checkAvg} onChange={(e) => setCheckAvg(e.target.value)} type="number"
              placeholder="1500"
              className="w-full bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-white/90 focus:outline-none focus:border-kds-green" />
          </Field>
          <Field label="Daily orders by day">
            <div className="grid grid-cols-7 gap-1">
              {(Object.keys(orders) as Array<keyof typeof orders>).map((d) => (
                <div key={d}>
                  <p className="text-[9px] text-white/40 text-center mb-1">{d}</p>
                  <input value={orders[d]} onChange={(e) => setOrders({ ...orders, [d]: e.target.value })}
                    type="number" placeholder="0"
                    className="w-full bg-white/[0.03] border border-white/[0.08] rounded px-1 py-1 text-center text-xs text-white/90 focus:outline-none focus:border-kds-green" />
                </div>
              ))}
            </div>
          </Field>
        </div>
        <div className="flex justify-between gap-2 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55">Cancel</button>
          <button onClick={() => create.mutate()} disabled={!name.trim() || !checkAvg || create.isPending}
            className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-40">
            Add channel
          </button>
        </div>
      </div>
    </div>
  )
}

function AddCostModal({ proFormaId, onClose, onCreated }: { proFormaId: string; onClose: () => void; onCreated: () => void }) {
  const [category, setCategory] = useState('')
  const [monthly, setMonthly] = useState('')

  const create = useMutation({
    mutationFn: () => api.post(`/finance/projections/${proFormaId}/fixed-costs`, {
      category: category.trim(),
      monthlyCents: Math.round(parseFloat(monthly) * 100),
    }),
    onSuccess: onCreated,
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl overflow-hidden"
        style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">+ Fixed cost</h2>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-3">
          <Field label="Category *">
            <input value={category} onChange={(e) => setCategory(e.target.value)}
              placeholder="Rent / Utilities / Payroll / Marketing"
              className="w-full bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-white/90 focus:outline-none focus:border-kds-green" autoFocus />
          </Field>
          <Field label="Monthly amount (PKR) *">
            <input value={monthly} onChange={(e) => setMonthly(e.target.value)} type="number"
              placeholder="375000"
              className="w-full bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-white/90 focus:outline-none focus:border-kds-green" />
          </Field>
        </div>
        <div className="flex justify-between gap-2 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55">Cancel</button>
          <button onClick={() => create.mutate()} disabled={!category.trim() || !monthly || create.isPending}
            className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-40">
            Add
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-white/55 block mb-1">{label}</label>
      {children}
    </div>
  )
}
