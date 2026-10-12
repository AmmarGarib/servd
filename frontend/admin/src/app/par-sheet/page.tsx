'use client'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'

/**
 * Master par sheet — the day's prep, per company.
 *
 * Lists the recipe library's sub-recipes that this company's brands use (owner
 * decision 29, 2026-09-27) and what was made of each today. "Made" comes from
 * prep batches: logging a batch on Inventory → Prep deducts its ingredients,
 * records the yield and shows up here — prep is recorded once, not typed onto
 * this sheet as well. The Component library (hero / supporting / trim-waste
 * matrix) is a read-only planning reference, linked below.
 */

interface ParRow {
  recipeId:        string
  name:            string
  category:        string | null
  batchYieldGrams: number | null
  batches:         number
  madeGrams:       number
  lastBatchAt:     string | null
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function grams(g: number | null): string {
  if (g == null) return '—'
  return g >= 1000 ? `${(g / 1000).toLocaleString('en-PK', { maximumFractionDigits: 2 })} kg` : `${Math.round(g)} g`
}

export default function ParSheetPage() {
  const [date, setDate]     = useState(todayISO())
  const [filter, setFilter] = useState('')
  const [madeFilter, setMadeFilter] = useState<'all' | 'made' | 'not-made'>('all')

  const { data: rows = [], isLoading } = useQuery<ParRow[]>({
    queryKey: ['par-sheet', date],
    queryFn:  () => api.get<ParRow[]>(`/par-sheet?date=${date}`),
    refetchInterval: 30_000,
  })

  const filtered = useMemo(() => rows.filter((r) => {
    if (madeFilter === 'made' && r.batches === 0) return false
    if (madeFilter === 'not-made' && r.batches > 0) return false
    return !filter || r.name.toLowerCase().includes(filter.toLowerCase())
  }), [rows, filter, madeFilter])

  const notMade = rows.filter((r) => r.batches === 0).length

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-6 py-4 border-b" style={{ borderColor: 'rgb(var(--fg-rgb) / 0.05)' }}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-black text-white/95">Master Par Sheet</h1>
            <p className="text-xs text-white/45 mt-0.5 max-w-2xl">
              Sub-recipes your brands use and what was made today. Made comes from prep batches — log a batch on{' '}
              <Link href="/inventory/prep" className="text-indigo-700 underline">Prep</Link> and it shows here.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="rounded-xl px-3 py-2 text-xs font-bold focus:outline-none"
              style={{ background: 'rgb(var(--fg-rgb) / 0.04)', border: '1px solid rgb(var(--fg-rgb) / 0.08)', color: 'rgb(var(--fg-rgb) / 0.85)' }} />
            <Link href="/inventory/prep"
              className="rounded-xl px-3 py-2 text-xs font-bold"
              style={{ background: 'rgb(var(--erp-primary-rgb) / 0.1)', color: 'var(--erp-primary-ink)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.25)' }}>
              Log a batch
            </Link>
            {rows.length > 0 && (
              <div className="rounded-xl px-3 py-2 text-center"
                style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' }}>
                <p className="text-[9px] uppercase tracking-wider font-black text-red-700">Not made</p>
                <p className="text-xl font-black text-red-700 leading-none mt-0.5">{notMade}</p>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="px-6 py-4 flex items-center gap-3 flex-wrap">
        <input value={filter} onChange={(e) => setFilter(e.target.value)}
          placeholder="Search sub-recipe…"
          className="flex-1 min-w-[200px] max-w-sm rounded-xl px-4 py-2.5 text-sm font-semibold focus:outline-none"
          style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.08)', color: 'rgb(var(--fg-rgb) / 0.85)' }} />
        <div className="flex gap-1 flex-wrap">
          {([['all', `All (${rows.length})`], ['not-made', 'Not made'], ['made', 'Made']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setMadeFilter(k)}
              className="rounded-full px-3 py-1 text-[11px] font-bold transition-colors"
              style={madeFilter === k
                ? { background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }
                : { background: 'rgb(var(--fg-rgb) / 0.04)', color: 'rgb(var(--fg-rgb) / 0.55)' }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 pb-8">
        {isLoading && <p className="text-sm text-white/40">Loading…</p>}

        {!isLoading && filtered.length === 0 && (
          <div className="rounded-2xl p-10 text-center"
            style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
            <p className="text-sm font-bold text-white/75">
              {rows.length === 0 ? 'None of your brands’ plates use a sub-recipe yet' : 'Nothing matches the filter'}
            </p>
            {rows.length === 0 && (
              <p className="text-xs text-white/40 mt-1">
                Sub-recipes live in the <Link href="/accounting/recipes" className="text-indigo-700 underline">recipe library</Link>.
                They appear here once a plate of one of your brands uses them.
              </p>
            )}
          </div>
        )}

        {filtered.length > 0 && (
          <div className="rounded-2xl overflow-x-auto"
            style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
            <table className="w-full text-sm border-collapse min-w-[640px]">
              <thead>
                <tr style={{ background: 'rgba(15,17,22,0.95)' }}>
                  {['Sub-recipe', 'One batch', 'Made', 'Batches', 'Last batch', ''].map((h, i) => (
                    <th key={i} className={`${i === 0 ? 'text-left px-4' : 'text-center px-3'} py-3 text-[10px] font-black uppercase tracking-[0.2em] text-white/45`}
                      style={{ borderBottom: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.recipeId} className="hover:bg-white/[0.02] transition-colors"
                    style={{ borderBottom: '1px solid rgb(var(--fg-rgb) / 0.03)' }}>
                    <td className="px-4 py-2.5">
                      <p className="font-semibold text-white/90">{r.name}</p>
                      {r.category && <p className="text-[10px] text-white/40 capitalize">{r.category.replace('_', ' ')}</p>}
                    </td>
                    <td className="px-3 py-2.5 text-center text-white/60 tabular-nums">{grams(r.batchYieldGrams)}</td>
                    <td className="px-3 py-2.5 text-center font-bold tabular-nums"
                      style={{ color: r.batches > 0 ? '#3f7d20' : '#b42318' }}>
                      {r.batches > 0 ? grams(r.madeGrams) : 'Nothing made'}
                    </td>
                    <td className="px-3 py-2.5 text-center text-white/60 tabular-nums">{r.batches}</td>
                    <td className="px-3 py-2.5 text-center text-[11px] text-white/40">
                      {r.lastBatchAt ? new Date(r.lastBatchAt).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' }) : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Link href={`/inventory/prep?recipeId=${r.recipeId}`}
                        className="text-[11px] font-bold px-2 py-1 rounded"
                        style={{ background: 'rgb(var(--erp-primary-rgb) / 0.1)', color: 'var(--erp-primary-ink)' }}>
                        Log batch
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="rounded-xl p-4 mt-4 text-xs text-white/45 leading-relaxed"
          style={{ background: 'rgb(var(--ink-rgb) / 0.05)', border: '1px solid rgb(var(--ink-rgb) / 0.15)' }}>
          Planning which trims and by-products each base ingredient can feed? The{' '}
          <Link href="/par-sheet/components" className="text-indigo-700 underline">component matrix</Link>{' '}
          (hero / supporting / trim-waste per ingredient) is kept as a read-only reference.
        </div>
      </div>
    </div>
  )
}
