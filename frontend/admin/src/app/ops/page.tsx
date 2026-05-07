'use client'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../lib/api'

interface Anomaly {
  severity: 'low' | 'medium' | 'high'
  category: 'kitchen' | 'cash' | 'customer' | 'inventory' | 'aggregator'
  title: string
  detail: string
  actionUrl?: string
}
interface AnomaliesResp { windowHours: number; generatedAt: string; flags: Anomaly[] }

interface PrepLine {
  ingredientId: string
  ingredientName: string
  unit: string
  requiredQty: number
  currentStock: number
  shortfall: number
}
interface PrepStation {
  stationId: string
  stationName: string
  forecastedItems: string[]
  lines: PrepLine[]
}
interface PrepResp {
  byStation: PrepStation[]
  unmappedItems: Array<{ menuItemId: string; name: string; qty: number; reason: string }>
  generatedAt: string
}

interface Concept { id: string; name: string }

const SEVERITY_COLOR: Record<string, string> = {
  high:   '#FF4D4F',
  medium: '#F59E0B',
  low:    '#94A3B8',
}
const CATEGORY_EMOJI: Record<string, string> = {
  kitchen: '🍳', cash: '💳', customer: '😞', inventory: '📦', aggregator: '🛵',
}

export default function OpsCenterPage() {
  const [days, setDays] = useState(1)
  const { data: concepts = [] } = useQuery<Concept[]>({
    queryKey: ['concepts'],
    queryFn: () => api.get('/concepts'),
  })
  const conceptId = concepts[0]?.id

  const { data: anomalies } = useQuery<AnomaliesResp>({
    queryKey: ['ops-anomalies'],
    queryFn: () => api.get('/ops/anomalies'),
    refetchInterval: 60_000,
  })
  const { data: prepList, isLoading: prepLoading } = useQuery<PrepResp>({
    queryKey: ['ops-prep', conceptId, days],
    queryFn: () => api.get(`/ops/prep-list?conceptId=${conceptId}&days=${days}`),
    enabled: !!conceptId,
  })

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-7 border-b border-white/[0.05]">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30">Operations</p>
        <h1 className="text-2xl font-black text-white/90 mt-1">Ops Center</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          The things a manager would otherwise compute by hand at 11pm — anomaly alerts, tomorrow's prep checklist, shift digests.
        </p>
      </header>

      <div className="px-7 py-7 max-w-[1200px] space-y-7">

        {/* ── Anomaly alerts ────────────────────────────────────────────── */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-black uppercase tracking-[0.24em] text-white/60">⚠ Anomalies (last {anomalies?.windowHours ?? 24}h)</h2>
            <span className="text-[10px] text-white/30">Auto-refresh every minute</span>
          </div>

          {!anomalies && <p className="text-sm text-white/40">Scanning…</p>}
          {anomalies && anomalies.flags.length === 0 && (
            <div className="rounded-2xl p-6 text-center"
              style={{ background: 'rgba(0,212,177,0.05)', border: '1px solid rgba(0,212,177,0.2)' }}>
              <p className="text-3xl mb-1">✅</p>
              <p className="font-bold text-kds-green">All systems running normally</p>
              <p className="text-xs text-white/40 mt-1">No anomalies detected in the last {anomalies.windowHours} hours.</p>
            </div>
          )}
          {anomalies && anomalies.flags.length > 0 && (
            <div className="space-y-2">
              {anomalies.flags.map((f, i) => (
                <div key={i}
                  className="rounded-xl p-4 flex items-start gap-3"
                  style={{
                    background: `${SEVERITY_COLOR[f.severity]}10`,
                    border: `1px solid ${SEVERITY_COLOR[f.severity]}55`,
                  }}>
                  <span className="text-2xl shrink-0">{CATEGORY_EMOJI[f.category] ?? '⚠'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-bold text-white/90">{f.title}</p>
                      <span className="text-[10px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded"
                        style={{ background: SEVERITY_COLOR[f.severity], color: '#000' }}>
                        {f.severity}
                      </span>
                    </div>
                    <p className="text-xs text-white/55 mt-1">{f.detail}</p>
                  </div>
                  {f.actionUrl && (
                    <Link href={f.actionUrl} className="shrink-0 text-xs font-bold text-white/85 hover:text-white">
                      Investigate →
                    </Link>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Prep list ──────────────────────────────────────────────────── */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-black uppercase tracking-[0.24em] text-white/60">📋 Auto Prep List</h2>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-white/40">For the next</span>
              {[1, 3, 7].map((d) => (
                <button key={d} onClick={() => setDays(d)}
                  className="rounded-md px-2.5 py-1 font-bold transition-colors"
                  style={{
                    background: days === d ? 'rgba(0,212,177,0.18)' : 'rgba(255,255,255,0.04)',
                    color: days === d ? '#00D4B1' : 'rgba(255,255,255,0.55)',
                    border: days === d ? '1px solid rgba(0,212,177,0.4)' : '1px solid rgba(255,255,255,0.06)',
                  }}>
                  {d === 1 ? 'tomorrow' : `${d} days`}
                </button>
              ))}
            </div>
          </div>

          {prepLoading && <p className="text-sm text-white/40">Computing forecast…</p>}
          {prepList && prepList.byStation.length === 0 && (
            <div className="rounded-2xl p-8 text-center"
              style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <p className="text-3xl mb-2">🍳</p>
              <p className="font-bold text-white/85">No prep computed</p>
              <p className="text-sm text-white/45 mt-1 max-w-md mx-auto">
                The demand forecast needs ~2 weeks of completed orders before it can suggest prep quantities. Check back once you have history.
              </p>
            </div>
          )}
          {prepList && prepList.byStation.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {prepList.byStation.map((s) => (
                <div key={s.stationId}
                  className="rounded-2xl overflow-hidden"
                  style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="px-4 py-3 border-b border-white/[0.05] flex items-center justify-between">
                    <p className="font-black text-white/90">🍳 {s.stationName}</p>
                    <span className="text-[10px] text-white/40">{s.lines.length} ingredients</span>
                  </div>
                  <div className="px-4 py-2 border-b border-white/[0.04]">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-white/40 mb-1">Forecasted items</p>
                    <p className="text-xs text-white/65">{s.forecastedItems.join(', ')}</p>
                  </div>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-white/40 border-b border-white/[0.04]">
                        <th className="px-4 py-2">Ingredient</th>
                        <th className="px-4 py-2 text-right">Need</th>
                        <th className="px-4 py-2 text-right">Have</th>
                        <th className="px-4 py-2 text-right">To prep / order</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.03]">
                      {s.lines.map((l) => {
                        const short = l.shortfall > 0
                        return (
                          <tr key={l.ingredientId}>
                            <td className="px-4 py-2 text-white/85">{l.ingredientName}</td>
                            <td className="px-4 py-2 text-right text-white/65 font-mono">{l.requiredQty} {l.unit}</td>
                            <td className="px-4 py-2 text-right text-white/45 font-mono">{l.currentStock} {l.unit}</td>
                            <td className="px-4 py-2 text-right font-mono font-bold"
                              style={{ color: short ? '#F59E0B' : '#00D4B1' }}>
                              {short ? `+${l.shortfall} ${l.unit}` : '✓'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
          {prepList && prepList.unmappedItems.length > 0 && (
            <div className="mt-3 rounded-xl p-3 text-xs"
              style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.2)' }}>
              <p className="font-bold text-amber-400">{prepList.unmappedItems.length} forecast item{prepList.unmappedItems.length === 1 ? '' : 's'} skipped</p>
              <ul className="text-white/55 mt-1 space-y-0.5">
                {prepList.unmappedItems.slice(0, 5).map((u) => (
                  <li key={u.menuItemId}>· {u.qty}× {u.name} — {u.reason}</li>
                ))}
              </ul>
              <p className="text-white/35 mt-1.5 text-[10px]">Add a recipe + station to unlock prep suggestions for these items.</p>
            </div>
          )}
        </section>

        {/* ── Pointer to shift digests ───────────────────────────────────── */}
        <section className="rounded-2xl p-5"
          style={{ background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.2)' }}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-black text-white/90">📰 Shift digests</p>
              <p className="text-sm text-white/55 mt-1 max-w-md">
                Auto-summary at end of each shift — orders, peak hour, voids, complaints, top items. Generated on shift close.
              </p>
            </div>
            <Link href="/pos/shift" className="shrink-0 rounded-xl bg-[#6366F1] text-white px-4 py-2 text-xs font-black hover:opacity-90">
              Open Shift Report →
            </Link>
          </div>
        </section>
      </div>
    </div>
  )
}
