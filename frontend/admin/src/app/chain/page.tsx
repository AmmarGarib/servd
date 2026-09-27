'use client'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../lib/api'
import { fmtPkrShort } from '../../lib/money'

interface Concept {
  id: string
  name: string
  slug: string
  type: string
  isActive: boolean
}

interface SalesTotals {
  gross: number
  net: number
  orders: number
  tax: number
  commission: number
}

const PRESETS = [
  { label: 'Today', days: 1 },
  { label: '7d',    days: 7 },
  { label: '30d',   days: 30 },
  { label: '90d',   days: 90 },
]

export default function ChainRollupPage() {
  const [days, setDays] = useState(7)

  const dateFrom = new Date(Date.now() - days * 86_400_000).toISOString()
  const dateTo = new Date().toISOString()

  const { data: concepts = [] } = useQuery<Concept[]>({
    queryKey: ['concepts'],
    queryFn: () => api.get('/concepts'),
  })

  // Per-concept sales totals run in parallel via React Query
  const perConceptQueries = useQuery({
    queryKey: ['chain-sales', days, concepts.map((c) => c.id).join(',')],
    queryFn: async () => {
      const results = await Promise.all(
        concepts.map(async (c) => {
          try {
            const r = await api.get<{ totals: SalesTotals }>(
              `/reports/sales?conceptId=${c.id}&dateFrom=${dateFrom}&dateTo=${dateTo}`,
            )
            return { conceptId: c.id, totals: r.totals }
          } catch {
            return { conceptId: c.id, totals: { gross: 0, net: 0, orders: 0, tax: 0, commission: 0 } }
          }
        })
      )
      return Object.fromEntries(results.map((r) => [r.conceptId, r.totals]))
    },
    enabled: concepts.length > 0,
  })

  const perConcept = perConceptQueries.data ?? {}

  const totalGross    = Object.values(perConcept).reduce((s, t) => s + t.gross, 0)
  const totalNet      = Object.values(perConcept).reduce((s, t) => s + t.net, 0)
  const totalOrders   = Object.values(perConcept).reduce((s, t) => s + t.orders, 0)
  const avgTicket     = totalOrders > 0 ? totalGross / totalOrders : 0
  const activeBrands  = concepts.filter((c) => c.isActive).length

  // Sort concepts by gross desc for the leaderboard
  const sorted = [...concepts].sort((a, b) => (perConcept[b.id]?.gross ?? 0) - (perConcept[a.id]?.gross ?? 0))
  const maxGross = Math.max(...Object.values(perConcept).map((t) => t.gross), 1)

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-7 border-b border-white/[0.05]">
        <div className="flex items-start justify-between gap-4 flex-wrap max-w-[1200px] mx-auto">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30">Chain</p>
            <h1 className="text-2xl font-black text-white/90 mt-1">Multi-brand rollup</h1>
            <p className="text-sm text-white/40 mt-1.5">
              Side-by-side performance across all your concepts.
            </p>
          </div>

          {/* Date preset toggle */}
          <div className="flex rounded-lg overflow-hidden text-xs font-bold" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
            {PRESETS.map((p) => (
              <button
                key={p.days}
                onClick={() => setDays(p.days)}
                className={`px-4 py-2 transition-colors ${
                  days === p.days ? 'bg-kds-green text-black' : 'text-white/55 hover:text-white bg-transparent'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="px-7 py-7 max-w-[1200px] mx-auto space-y-7">
        {/* KPI grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            // Sales-register figures (what customers paid, incl. GST) — the
            // books' revenue is the ledger P&L.
            { label: 'Sales (incl. GST)', value: fmtPkrShort(totalGross), color: '#00D4B1' },
            { label: 'Register net',      value: fmtPkrShort(totalNet),   color: '#6366F1' },
            { label: 'Orders',      value: totalOrders.toLocaleString(), color: '#F59E0B' },
            { label: 'Avg ticket',  value: fmtPkrShort(avgTicket),  color: '#FFFFFF' },
          ].map((k) => (
            <div
              key={k.label}
              className="rounded-2xl p-4"
              style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/40">{k.label}</p>
              <p className="text-2xl font-black mt-1.5" style={{ color: k.color }}>{k.value}</p>
            </div>
          ))}
        </div>

        {/* Per-brand leaderboard */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-black uppercase tracking-[0.24em] text-white/60">Brand leaderboard</h2>
              <p className="text-xs text-white/35 mt-0.5">{activeBrands} active · {concepts.length} total</p>
            </div>
          </div>

          {concepts.length === 0 ? (
            <div className="rounded-2xl p-10 text-center"
              style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
              <p className="text-4xl mb-2">🏷</p>
              <p className="font-bold text-white/85">No concepts yet</p>
              <p className="text-sm text-white/45 mt-1">Add your first brand to see it here.</p>
              <Link
                href="/settings"
                className="inline-block mt-4 rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black"
              >
                Add a brand →
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              {sorted.map((c, i) => {
                const t = perConcept[c.id]
                const gross = t?.gross ?? 0
                const orders = t?.orders ?? 0
                const pct = maxGross > 0 ? Math.round((gross / maxGross) * 100) : 0
                return (
                  <Link
                    key={c.id}
                    href={`/dashboard?conceptId=${c.id}`}
                    className="block rounded-2xl p-4 transition-all hover:-translate-y-0.5"
                    style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}
                  >
                    <div className="flex items-center gap-4">
                      <span className="shrink-0 w-7 text-center text-xs font-mono font-bold text-white/35">#{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-bold text-white/85 truncate">{c.name}</p>
                          {!c.isActive && (
                            <span className="text-[10px] font-bold text-white/30 px-1.5 py-0.5 rounded bg-white/5">PAUSED</span>
                          )}
                        </div>
                        <p className="text-xs text-white/40 mt-0.5">
                          {orders} orders · avg {fmtPkrShort(orders > 0 ? gross / orders : 0)}
                        </p>
                        {/* Bar */}
                        <div className="mt-2 h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${pct}%`, background: 'linear-gradient(90deg, #00D4B1, #6366F1)' }}
                          />
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-xl font-black" style={{ color: '#00D4B1' }}>{fmtPkrShort(gross)}</p>
                        <p className="text-[10px] text-white/35">gross</p>
                      </div>
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </section>

        {/* Hint */}
        {concepts.length === 1 && (
          <div className="rounded-2xl p-4"
            style={{ background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.2)' }}>
            <p className="text-xs text-white/65">
              💡 Running multiple brands? Add another concept in <Link href="/settings" className="underline text-[#6366F1]">Settings → Brands</Link> and they&apos;ll show up here side-by-side.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
