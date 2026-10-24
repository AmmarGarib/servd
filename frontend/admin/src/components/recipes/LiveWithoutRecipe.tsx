'use client'
// Dishes on sale with no approved recipe (owner, 2026-10-24: the recipe gate).
// A dish is switched on only once its recipe is approved (422
// RECIPE_NOT_APPROVED); dishes that were already live stay live and are
// listed here until their recipe is approved. GET /menu/items/live-without-recipe.
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'

interface Row { id: string; name: string; conceptId: string; concept: { name: string }; recipe: { id: string; status: string } | null }

const STATUS_LABEL: Record<string, string> = { iteration: 'in testing', pending_approval: 'waiting for approval' }

export function LiveWithoutRecipe({ conceptId }: { conceptId?: string }) {
  const { data = [] } = useQuery<Row[]>({
    queryKey: ['menu', 'live-without-recipe', conceptId ?? ''],
    queryFn: () => api.get(`/menu/items/live-without-recipe${conceptId ? `?conceptId=${encodeURIComponent(conceptId)}` : ''}`),
    retry: false, meta: { background: true },
  })
  if (data.length === 0) return null
  return (
    <section className="s-card mx-6 mt-4 p-4">
      <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--erp-warning)' }}>Live without an approved recipe</p>
      <p className="mt-0.5 text-xs text-s-dim">
        {data.length} dish{data.length === 1 ? ' is' : 'es are'} on sale with no approved recipe — their stock is not taken out when they sell.
        They stay on sale; a dish switched off can only come back once its recipe is approved.
      </p>
      <ul className="mt-2 flex flex-wrap gap-2 text-xs">
        {data.map((r) => (
          <li key={r.id}>
            {r.recipe
              ? <Link href={`/accounting/recipes/${r.recipe.id}`} className="s-badge-amber hover:underline">{r.name} · {r.concept.name} · {STATUS_LABEL[r.recipe.status] ?? r.recipe.status}</Link>
              : <span className="s-badge-muted">{r.name} · {r.concept.name} · no recipe</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}
