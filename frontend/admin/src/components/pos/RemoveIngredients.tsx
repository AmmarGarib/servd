'use client'
// "Remove" on a till line (owner, 2026-10-27: "removals = any item that is being deducted from stock will be adjusted
// if customer asks to remove"). Lists the dish's removable ingredients — its approved plate recipe's lines, never
// packaging (GET /menu/items/:id/removable) — as tick boxes. What is ticked rides on the line as removedIngredients;
// the server checks it (422 INGREDIENT_NOT_ON_RECIPE) and the sale draws none of it. The price never changes.
import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { AnchoredMenu } from '../ui/AnchoredMenu'
import type { LineRemoval } from './tillApi'

export function useRemovable(menuItemId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['menu', 'removable', menuItemId],
    queryFn: () => api.get<{ menuItemId: string; removable: LineRemoval[] }>(`/menu/items/${encodeURIComponent(menuItemId!)}/removable`),
    enabled: !!menuItemId && enabled,
    staleTime: 5 * 60_000,
    retry: false,
    meta: { inlineErrors: true },
  })
}

export function RemoveIngredientsButton({ menuItemId, itemName, value, onChange }: {
  menuItemId: string | null
  itemName: string
  value: LineRemoval[]
  onChange: (next: LineRemoval[]) => void
}) {
  const btn = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const q = useRemovable(menuItemId, open)
  const list = q.data?.removable ?? []
  const picked = new Set(value.map((r) => r.key))

  function toggle(r: LineRemoval) {
    onChange(picked.has(r.key) ? value.filter((v) => v.key !== r.key) : [...value, r])
  }

  if (!menuItemId) return null
  return (
    <>
      <button ref={btn} type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="true" aria-expanded={open}
        aria-label={`Remove ingredients from ${itemName}`}
        className={`h-11 shrink-0 rounded-lg px-3 text-xs font-semibold active:bg-kds-border/70 ${value.length > 0 ? 'bg-kds-amber/20 text-kds-amber' : 'bg-kds-border text-kds-text'}`}>
        Remove{value.length > 0 ? ` (${value.length})` : ''}
      </button>
      <AnchoredMenu anchor={btn} open={open} onClose={() => setOpen(false)} align="end" minWidth={240} role="group" maxHeight={420}
        className="!border-kds-border !bg-kds-card !py-2">
        <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-kds-subtext">Leave out of {itemName}</p>
        {q.isLoading && <p className="px-3 py-2 text-sm text-kds-subtext">Loading the recipe…</p>}
        {q.isError && <p className="px-3 py-2 text-sm text-kds-red" role="alert">Could not load the recipe. Try again.</p>}
        {q.isSuccess && list.length === 0 && (
          <p className="px-3 py-2 text-sm text-kds-subtext">This dish has no approved recipe, so nothing can be removed.</p>
        )}
        {list.map((r) => (
          <label key={r.key} className="flex min-h-11 cursor-pointer items-center gap-3 px-3 text-sm text-kds-text hover:bg-kds-border/50">
            <input type="checkbox" checked={picked.has(r.key)} onChange={() => toggle(r)} className="h-5 w-5 shrink-0 accent-kds-green" />
            <span className="min-w-0 flex-1 break-words">No {r.name}</span>
          </label>
        ))}
        {value.length > 0 && (
          <div className="mt-1 border-t border-kds-border px-3 pt-2">
            <button type="button" onClick={() => onChange([])} className="min-h-11 text-sm font-semibold text-kds-subtext underline">Clear all</button>
          </div>
        )}
      </AnchoredMenu>
    </>
  )
}
