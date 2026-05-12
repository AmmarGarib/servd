'use client'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'

/**
 * Master par sheet — daily prep tracking.
 *
 * Every morning before service, expo (or any prep cook) opens this page to
 * see the master list of components: target par + current actual. As prep
 * cooks finish batches they bump the actual; orders fire on the line and
 * decrement it automatically. Red rows mean "make more, fast"; green means
 * we're on track. The CEO's workflow: walk in pre-service, glance at this
 * sheet, redirect labor where red shows up.
 */

interface ParRow {
  componentId: string
  name:        string
  type:        string
  target:      number
  actual:      number
  unit:        string | null
  notes:       string | null
  updatedAt:   string | null
  updatedById: string | null
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

const TYPE_COLORS: Record<string, string> = {
  sauce:      'rgba(245,158,11,0.12)',
  protein:    'rgba(239,68,68,0.12)',
  starch:     'rgba(132,204,22,0.12)',
  vegetable:  'rgba(34,197,94,0.12)',
  bread:      'rgba(168,85,247,0.12)',
  beverage:   'rgba(59,130,246,0.12)',
  dairy:      'rgba(236,72,153,0.12)',
  prepared:   'rgba(20,184,166,0.12)',
}

function ratioColor(ratio: number): { fg: string; bg: string; label: string } {
  if (ratio >= 1)   return { fg: '#22c55e', bg: 'rgba(34,197,94,0.08)',  label: 'On target' }
  if (ratio >= 0.5) return { fg: '#fcd34d', bg: 'rgba(245,158,11,0.08)', label: 'Half-prepped' }
  if (ratio > 0)    return { fg: '#fb923c', bg: 'rgba(251,146,60,0.08)', label: 'Low' }
  return                   { fg: '#ef4444', bg: 'rgba(239,68,68,0.08)',  label: 'Nothing made' }
}

export default function ParSheetPage() {
  const qc = useQueryClient()
  const [date, setDate]     = useState(todayISO())
  const [filter, setFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')

  const { data: rows = [], isLoading } = useQuery<ParRow[]>({
    queryKey: ['par-sheet', date],
    queryFn:  () => api.get<ParRow[]>(`/par-sheet?date=${date}`),
    refetchInterval: 10_000,
  })

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<ParRow> }) =>
      api.put(`/par-sheet/${id}`, { ...body, date }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['par-sheet', date] }),
  })
  const adjust = useMutation({
    mutationFn: ({ id, delta }: { id: string; delta: number }) =>
      api.post(`/par-sheet/${id}/adjust`, { delta, date }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['par-sheet', date] }),
  })
  const rollover = useMutation({
    mutationFn: () => api.post('/par-sheet/rollover', {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['par-sheet', date] }),
  })

  const types = useMemo(() => Array.from(new Set(rows.map((r) => r.type))).sort(), [rows])

  const filtered = rows.filter((r) => {
    if (typeFilter !== 'all' && r.type !== typeFilter) return false
    if (!filter) return true
    return r.name.toLowerCase().includes(filter.toLowerCase())
  })

  // Roll-up: how many are red?
  const lowCount = rows.filter((r) => r.target > 0 && r.actual / r.target < 0.5).length

  return (
    <div className="min-h-screen" style={{ background: '#0A0B0F' }}>
      <header className="px-6 py-4 border-b" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-black text-white/95">📋 Master Par Sheet</h1>
            <p className="text-xs text-white/45 mt-0.5">
              Daily prep targets vs actuals. Prep updates as you go; orders decrement live during service.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="rounded-xl px-3 py-2 text-xs font-bold focus:outline-none"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.85)' }} />
            <button onClick={() => rollover.mutate()} disabled={rollover.isPending}
              className="rounded-xl px-3 py-2 text-xs font-bold transition-colors disabled:opacity-40"
              style={{ background: 'rgba(99,102,241,0.1)', color: '#A5B4FC', border: '1px solid rgba(99,102,241,0.25)' }}
              title="Copy yesterday's targets into today's sheet">
              ↻ Rollover from yesterday
            </button>
            {lowCount > 0 && (
              <div className="rounded-xl px-3 py-2 text-center"
                style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' }}>
                <p className="text-[9px] uppercase tracking-wider font-black text-red-400">Below half</p>
                <p className="text-xl font-black text-red-400 leading-none mt-0.5">{lowCount}</p>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="px-6 py-4 flex items-center gap-3 flex-wrap">
        <input value={filter} onChange={(e) => setFilter(e.target.value)}
          placeholder="Search component…"
          className="flex-1 min-w-[200px] max-w-sm rounded-xl px-4 py-2.5 text-sm font-semibold focus:outline-none"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.85)' }} />
        <div className="flex gap-1 flex-wrap">
          <button onClick={() => setTypeFilter('all')}
            className="rounded-full px-3 py-1 text-[11px] font-bold transition-colors"
            style={typeFilter === 'all'
              ? { background: '#00D4B1', color: '#000' }
              : { background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.55)' }}>
            All ({rows.length})
          </button>
          {types.map((t) => (
            <button key={t} onClick={() => setTypeFilter(t)}
              className="rounded-full px-3 py-1 text-[11px] font-bold transition-colors capitalize"
              style={typeFilter === t
                ? { background: '#00D4B1', color: '#000' }
                : { background: TYPE_COLORS[t] ?? 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.7)' }}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 pb-8">
        {isLoading && <p className="text-sm text-white/40">Loading…</p>}

        {!isLoading && filtered.length === 0 && (
          <div className="rounded-2xl p-10 text-center"
            style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <p className="text-4xl mb-2">🍳</p>
            <p className="text-sm font-bold text-white/75">
              {rows.length === 0 ? 'No components defined yet' : 'Nothing matches the filter'}
            </p>
            {rows.length === 0 && (
              <p className="text-xs text-white/40 mt-1">
                Components live in <Link href="/components" className="text-indigo-300 underline">/components</Link> — define your sub-recipes there first.
              </p>
            )}
          </div>
        )}

        {filtered.length > 0 && (
          <div className="rounded-2xl overflow-x-auto"
            style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <table className="w-full text-sm border-collapse min-w-[700px]">
              <thead>
                <tr style={{ background: 'rgba(15,17,22,0.95)' }}>
                  <th className="text-left px-4 py-3 text-[10px] font-black uppercase tracking-[0.2em] text-white/45"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>Component</th>
                  <th className="text-center px-3 py-3 text-[10px] font-black uppercase tracking-[0.2em] text-white/45"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>Type</th>
                  <th className="text-center px-3 py-3 text-[10px] font-black uppercase tracking-[0.2em] text-white/45"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>Target</th>
                  <th className="text-center px-3 py-3 text-[10px] font-black uppercase tracking-[0.2em] text-white/45"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>Actual</th>
                  <th className="text-center px-3 py-3 text-[10px] font-black uppercase tracking-[0.2em] text-white/45"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>Status</th>
                  <th className="px-3 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const ratio = r.target > 0 ? r.actual / r.target : (r.actual > 0 ? 1 : 0)
                  const col = ratioColor(ratio)
                  return (
                    <tr key={r.componentId} className="hover:bg-white/[0.02] transition-colors"
                      style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                      <td className="px-4 py-2.5">
                        <p className="font-semibold text-white/90">{r.name}</p>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded capitalize"
                          style={{ background: TYPE_COLORS[r.type] ?? 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.7)' }}>
                          {r.type}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <ParCell value={r.target}
                          onChange={(v) => update.mutate({ id: r.componentId, body: { target: v } })} />
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-center gap-1.5">
                          <button onClick={() => adjust.mutate({ id: r.componentId, delta: -1 })}
                            disabled={r.actual <= 0}
                            className="h-7 w-7 rounded-md text-sm font-bold transition-colors disabled:opacity-25"
                            style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.55)' }}>
                            −
                          </button>
                          <ParCell value={r.actual}
                            onChange={(v) => update.mutate({ id: r.componentId, body: { actual: v } })} />
                          <button onClick={() => adjust.mutate({ id: r.componentId, delta: 1 })}
                            className="h-7 w-7 rounded-md text-sm font-bold transition-colors"
                            style={{ background: 'rgba(0,212,177,0.1)', color: '#00D4B1' }}>
                            +
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded"
                          style={{ background: col.bg, color: col.fg }}>
                          {col.label}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {r.updatedAt && (
                          <span className="text-[10px] text-white/30">
                            {new Date(r.updatedAt).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="rounded-xl p-4 mt-4 text-xs text-white/45 leading-relaxed"
          style={{ background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.15)' }}>
          💡 Tip: hit <strong className="text-white/75">↻ Rollover from yesterday</strong> first thing each morning to seed today&rsquo;s targets.
          Use <strong className="text-white/75">+/−</strong> as you finish batches; type directly into the target/actual fields for bulk corrections.
        </div>
      </div>
    </div>
  )
}

function ParCell({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [v, setV] = useState(value.toString())
  return (
    <input value={v}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => {
        const parsed = parseFloat(v)
        if (!isNaN(parsed) && parsed !== value) onChange(parsed)
        else setV(value.toString())
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      className="w-16 text-center rounded-md px-2 py-1 text-sm font-bold tabular-nums focus:outline-none"
      style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.9)' }} />
  )
}
