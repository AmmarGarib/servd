'use client'
import { ArrowLeft } from 'lucide-react'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'

/**
 * Component matrix — read-only planning reference (owner decision 29).
 *
 * The hero / supporting / trim-waste utilisation matrix per base ingredient,
 * seeded from the GS Foods sourcing PDF, with shelf life and which of your
 * brands use each item. It is NOT the prep catalogue: what the kitchen preps
 * and costs is the recipe library's sub-recipes, which the par sheet lists.
 */

interface ComponentRow {
  id: string
  name: string
  type: 'hero' | 'supporting' | 'trim_waste'
  description: string | null
  preparation: string | null
  seasons: string[]
  yieldGrams: number | null
  shelfLifeHours: number | null
  baseIngredient: { id: string; name: string; unit: string } | null
  brands: Array<{ concept: { id: string; name: string } }>
}

const TYPE_LABEL: Record<ComponentRow['type'], string> = {
  hero: 'Hero', supporting: 'Supporting', trim_waste: 'Trim / waste',
}

export default function ComponentMatrixPage() {
  const [q, setQ] = useState('')
  const { data: rows = [], isLoading } = useQuery<ComponentRow[]>({
    queryKey: ['components', 'matrix'],
    queryFn: () => api.get<ComponentRow[]>('/components?activeOnly=true'),
  })

  const byIngredient = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const groups = new Map<string, ComponentRow[]>()
    for (const r of rows) {
      const key = r.baseIngredient?.name ?? 'No base ingredient'
      if (needle && !key.toLowerCase().includes(needle) && !r.name.toLowerCase().includes(needle)) continue
      groups.set(key, [...(groups.get(key) ?? []), r])
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [rows, q])

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-6 py-4 border-b" style={{ borderColor: 'rgb(var(--fg-rgb) / 0.05)' }}>
        <Link href="/par-sheet" className="inline-flex min-h-11 items-center gap-1.5 text-xs text-white/40 hover:text-white/70"><ArrowLeft size={14} aria-hidden="true" />Par sheet</Link>
        <h1 className="text-2xl font-black text-white/95 mt-1">Component matrix</h1>
        <p className="text-xs text-white/45 mt-0.5 max-w-2xl">
          Read-only planning reference: what each base ingredient can become (hero, supporting, trim and waste uses),
          shelf life and which brands use it. Prep is planned and logged from the recipe library&rsquo;s sub-recipes on the par sheet.
        </p>
      </header>

      <div className="px-6 py-4">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ingredient or component…"
          className="w-full max-w-sm rounded-xl px-4 py-2.5 text-sm font-semibold focus:outline-none"
          style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.08)', color: 'rgb(var(--fg-rgb) / 0.85)' }} />
      </div>

      <div className="px-6 pb-8 space-y-4">
        {isLoading && <p className="text-sm text-white/40">Loading…</p>}
        {!isLoading && byIngredient.length === 0 && <p className="text-sm text-white/40">No components match.</p>}
        {byIngredient.map(([ingredient, comps]) => (
          <section key={ingredient} className="rounded-2xl overflow-x-auto"
            style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
            <h2 className="px-4 py-2.5 text-xs font-black uppercase tracking-[0.18em] text-white/60"
              style={{ borderBottom: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>{ingredient}</h2>
            <table className="w-full text-sm min-w-[640px]">
              <tbody>
                {comps.map((c) => (
                  <tr key={c.id} style={{ borderBottom: '1px solid rgb(var(--fg-rgb) / 0.03)' }}>
                    <td className="px-4 py-2 w-28 text-xs font-bold uppercase tracking-wider text-white/50">{TYPE_LABEL[c.type]}</td>
                    <td className="px-3 py-2">
                      <p className="font-semibold text-white/90">{c.name}</p>
                      {c.description && <p className="text-xs text-white/45">{c.description}</p>}
                    </td>
                    <td className="px-3 py-2 w-28 text-xs text-white/50">
                      {c.shelfLifeHours != null ? `${c.shelfLifeHours} h shelf life` : ''}
                    </td>
                    <td className="px-3 py-2 w-48 text-xs text-white/60">
                      {c.brands.map((b) => b.concept.name).join(', ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  )
}
