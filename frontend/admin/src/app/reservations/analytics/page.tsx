'use client'

import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useState } from 'react'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { todayPktIso, startOfMonthPktIso } from '../../../lib/money'
import { useBrandFilter } from '../../../store/brandFilter'
import { Select } from '@/components/ui/Select'

interface Concept { id: string; name: string }
interface Analytics {
  period: { from: string; to: string }
  totals: { bookings: number; completed: number; noShow: number; cancelled: number; covers: number }
  rates: { noShowPct: number; completePct: number; occupancyPct: number; repeatGuestPct: number }
  bySource: Record<string, number>
}

export default function ReservationAnalyticsPage() {
  const [conceptId, setConceptId] = useState<string>(() => useBrandFilter.getState().brandId ?? '')
  const [from, setFrom] = useState(startOfMonthPktIso())
  const [to,   setTo]   = useState(todayPktIso())

  const concepts = useQuery({ queryKey: ['concepts'], queryFn: () => api.get<Concept[]>('/concepts') })
  if (!conceptId && concepts.data && concepts.data.length > 0) setConceptId(concepts.data[0]!.id)

  const a = useQuery({
    queryKey: ['res-analytics', conceptId, from, to],
    queryFn: () => api.get<Analytics>(`/reservations/analytics?conceptId=${conceptId}&from=${from}&to=${to}`),
    enabled: !!conceptId,
  })

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <Link href="/reservations" className="inline-flex min-h-11 items-center gap-1 text-xs text-s-muted hover:text-s-text"><ArrowLeft size={14} aria-hidden="true" /> Reservations</Link>
          <h1 className="text-xl font-bold text-s-text">Reservation analytics</h1>
        </div>
        <div className="flex items-center gap-2">
          <Select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className="min-h-11 bg-s-surface border border-s-border rounded px-2 py-1 text-sm">
            {concepts.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="min-h-11 bg-s-surface border border-s-border rounded px-2 py-1 text-sm" />
          <ArrowRight size={14} aria-hidden="true" className="text-s-muted" />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="min-h-11 bg-s-surface border border-s-border rounded px-2 py-1 text-sm" />
        </div>
      </header>

      <div className="p-6 max-w-5xl mx-auto space-y-4">
        {a.isLoading && <p className="text-s-muted text-sm">Loading…</p>}
        {a.data && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Kpi label="Bookings"    value={a.data.totals.bookings.toString()} sub="Total" />
              <Kpi label="Covers"      value={a.data.totals.covers.toString()}   sub="Guests served" />
              <Kpi label="No-show rate" value={`${a.data.rates.noShowPct}%`} sub={`${a.data.totals.noShow} no-shows`} tone={a.data.rates.noShowPct > 10 ? 'red' : 'ok'} />
              <Kpi label="Repeat guests" value={`${a.data.rates.repeatGuestPct}%`} sub="Returning" tone="ok" />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <section className="s-card p-4">
                <h2 className="text-sm font-bold mb-3">Funnel</h2>
                <div className="space-y-2">
                  <Bar label="Bookings"  value={a.data.totals.bookings} max={a.data.totals.bookings || 1} color="bg-blue-500" />
                  <Bar label="Completed" value={a.data.totals.completed} max={a.data.totals.bookings || 1} color="bg-s-teal" />
                  <Bar label="No-show"   value={a.data.totals.noShow}   max={a.data.totals.bookings || 1} color="bg-s-red" />
                  <Bar label="Cancelled" value={a.data.totals.cancelled} max={a.data.totals.bookings || 1} color="bg-gray-400" />
                </div>
                <p className="text-xs text-s-muted mt-3">
                  Completion rate: <strong>{a.data.rates.completePct}%</strong> · Occupancy estimate: <strong>{a.data.rates.occupancyPct}%</strong>
                </p>
              </section>

              <section className="s-card p-4">
                <h2 className="text-sm font-bold mb-3">By source</h2>
                <div className="space-y-2">
                  {Object.entries(a.data.bySource).map(([src, count]) => (
                    <Bar key={src} label={src} value={count} max={Math.max(1, ...Object.values(a.data.bySource))} color="bg-s-teal" />
                  ))}
                  {Object.keys(a.data.bySource).length === 0 && (
                    <p className="text-xs text-s-muted">No bookings in this period.</p>
                  )}
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'red' }) {
  return (
    <div className="s-card p-4">
      <p className="text-xs text-s-muted">{label}</p>
      <p className={`text-2xl font-bold ${tone === 'red' ? 'text-s-red' : tone === 'ok' ? 'text-primary-ink' : 'text-s-text'}`}>{value}</p>
      {sub && <p className="text-[11px] text-s-dim mt-0.5">{sub}</p>}
    </div>
  )
}

function Bar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = (value / max) * 100
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="font-semibold capitalize">{label}</span>
        <span className="text-s-muted">{value}</span>
      </div>
      <div className="h-2 rounded-full bg-s-bg-soft overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
