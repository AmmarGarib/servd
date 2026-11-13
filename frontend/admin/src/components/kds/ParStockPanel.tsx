'use client'
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Minus, Plus, Search } from 'lucide-react'
import { api, ApiError } from '../../lib/api'
import { formatBrandName } from '../../lib/brandName'
import { useActiveBrandId } from '../ui/BrandPicker'
import { CompactEmptyState } from '../ui/CompactEmptyState'

/**
 * Par stock today (owner, 2026-11-13: "Expo station should be able to manipulate par stock generally") —
 * expo sets how many portions of each dish are left; every sale (till and website) counts it down, at 0
 * the dish is sold out, a cancel / void puts portions back. GET / PUT /expo/par-stock
 * (backend/src/modules/expo/parStock.ts). A service counter only — never stock or the ledger.
 * Kitchen-dark: kds-* tokens only.
 */
interface ParRow {
  menuItemId: string
  name: string
  category: string | null
  portionsSet: number | null
  left: number | null
  isAvailable: boolean
}
interface PickerConcept { id: string; name: string }

export function ParStockPanel() {
  const active = useActiveBrandId()
  const { data: brands } = useQuery({
    queryKey: ['concepts', 'brand-picker'],
    queryFn: () => api.get<PickerConcept[]>('/concepts?view=picker'),
    staleTime: 60_000,
  })
  const [picked, setPicked] = useState<string | null>(null)
  const conceptId = picked ?? active ?? (brands && brands.length === 1 ? brands[0]!.id : null)
  const [q, setQ] = useState('')
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['expo', 'par-stock', conceptId],
    queryFn: () => api.get<{ items: ParRow[] }>(`/expo/par-stock?conceptId=${conceptId}`),
    enabled: !!conceptId,
    refetchInterval: 10_000,
  })

  const set = useMutation({
    mutationFn: (v: { menuItemId: string; portions: number | null }) => api.put<ParRow>('/expo/par-stock', v),
    onMutate: () => setError(null),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['expo', 'par-stock', conceptId] }),
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save the count'),
  })

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase()
    const all = data?.items ?? []
    const list = term ? all.filter((r) => r.name.toLowerCase().includes(term) || (r.category ?? '').toLowerCase().includes(term)) : all
    // Dishes with a count first, then the rest.
    return [...list].sort((a, b) => Number(b.portionsSet !== null) - Number(a.portionsSet !== null))
  }, [data, q])

  return (
    <section className="mx-4 sm:mx-6 mt-4 rounded-2xl border border-kds-border bg-kds-card p-3 sm:p-4" aria-label="Par stock today">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-kds-text">Par stock today</h2>
          <p className="text-xs text-kds-subtext">Portions left per dish. Every sale counts down; at 0 the dish is sold out. No limit = unlimited.</p>
        </div>
        {brands && brands.length > 1 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Brand">
            {brands.map((b) => (
              <button key={b.id} type="button" onClick={() => setPicked(b.id)} aria-pressed={conceptId === b.id}
                className={`min-h-11 rounded-lg border px-3 text-xs font-bold ${conceptId === b.id
                  ? 'border-kds-green bg-kds-green/15 text-kds-green' : 'border-kds-border text-kds-subtext hover:text-kds-text'}`}>
                {formatBrandName(b.name)}
              </button>
            ))}
          </div>
        )}
      </div>

      <label className="mt-3 flex min-h-11 items-center gap-2 rounded-lg border border-kds-border bg-kds-bg px-3">
        <Search size={16} aria-hidden="true" className="text-kds-subtext" />
        <span className="sr-only">Search dishes</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search dishes"
          className="w-full min-w-0 bg-transparent py-2 text-sm text-kds-text placeholder:text-kds-subtext focus:outline-none" />
      </label>

      {error && <p role="alert" className="mt-2 text-sm font-bold text-kds-red">{error}</p>}

      {!conceptId ? (
        <div className="mt-3"><CompactEmptyState tone="dark" message="Pick a brand" detail="Choose the brand whose dishes expo is counting." /></div>
      ) : isLoading ? (
        <p className="mt-3 text-sm text-kds-subtext">Loading dishes…</p>
      ) : rows.length === 0 ? (
        <div className="mt-3"><CompactEmptyState tone="dark" message={q ? 'No dish matches' : 'No dishes'} detail={q ? 'Try another name.' : 'This brand has no dishes on its menu.'} /></div>
      ) : (
        <ul className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => <ParRowItem key={r.menuItemId} row={r} busy={set.isPending && set.variables?.menuItemId === r.menuItemId}
            onSet={(portions) => set.mutate({ menuItemId: r.menuItemId, portions })} />)}
        </ul>
      )}
    </section>
  )
}

function ParRowItem({ row, busy, onSet }: { row: ParRow; busy: boolean; onSet: (portions: number | null) => void }) {
  const [draft, setDraft] = useState(row.left !== null ? String(row.left) : '')
  useEffect(() => { setDraft(row.left !== null ? String(row.left) : '') }, [row.left])
  const limited = row.portionsSet !== null
  const out = limited && (row.left ?? 0) <= 0
  const n = Number(draft)
  const valid = draft.trim() !== '' && Number.isInteger(n) && n >= 0
  const step = (d: number) => onSet(Math.max(0, (row.left ?? 0) + d))

  return (
    <li className={`rounded-xl border p-3 ${out ? 'border-kds-red/50 bg-kds-red/10' : 'border-kds-border bg-kds-bg'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-black text-kds-text" title={row.name}>{row.name}</p>
          {row.category && <p className="truncate text-xs text-kds-subtext">{row.category}</p>}
        </div>
        <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-black tabular-nums ${
          !limited ? 'bg-white/5 text-kds-subtext' : out ? 'bg-kds-red/20 text-kds-red' : 'bg-kds-green/15 text-kds-green'}`}>
          {!limited ? 'No limit' : out ? 'Sold out' : `${row.left} left`}
        </span>
      </div>
      {!row.isAvailable && !out && <p className="mt-1 text-xs text-kds-amber">Switched off (86&apos;d) — par stock does not switch it on.</p>}
      <form className="mt-2 flex flex-wrap items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (valid) onSet(n) }}>
        <button type="button" aria-label={`One less ${row.name}`} disabled={busy || !limited || (row.left ?? 0) <= 0} onClick={() => step(-1)}
          className="flex h-11 w-11 items-center justify-center rounded-lg border border-kds-border text-kds-text disabled:opacity-40"><Minus size={16} aria-hidden="true" /></button>
        <input inputMode="numeric" pattern="[0-9]*" value={draft} onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
          aria-label={`Portions left of ${row.name}`} placeholder="—"
          className="h-11 w-20 rounded-lg border border-kds-border bg-kds-card px-2 text-center text-sm font-bold tabular-nums text-kds-text focus:outline-none focus:ring-2 focus:ring-kds-green" />
        <button type="button" aria-label={`One more ${row.name}`} disabled={busy || !limited} onClick={() => step(1)}
          className="flex h-11 w-11 items-center justify-center rounded-lg border border-kds-border text-kds-text disabled:opacity-40"><Plus size={16} aria-hidden="true" /></button>
        <button type="submit" disabled={busy || !valid}
          className="h-11 rounded-lg bg-kds-green px-3 text-xs font-black text-primary-on disabled:opacity-40">Set</button>
        {limited && (
          <button type="button" disabled={busy} onClick={() => onSet(null)}
            className="h-11 rounded-lg border border-kds-border px-3 text-xs font-bold text-kds-subtext hover:text-kds-text disabled:opacity-40">No limit</button>
        )}
      </form>
    </li>
  )
}
