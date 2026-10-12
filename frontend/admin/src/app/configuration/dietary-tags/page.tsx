'use client'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Taxonomy { dietaryTags: string[]; allergens: string[] }

export default function DietaryTagsPage() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<Taxonomy>({ queryKey: ['dietary-taxonomy'], queryFn: () => api.get('/setup/dietary-taxonomy') })
  const [dietary, setDietary] = useState<string[]>([])
  const [allergens, setAllergens] = useState<string[]>([])
  useEffect(() => { if (data) { setDietary(data.dietaryTags); setAllergens(data.allergens) } }, [data])

  const save = useMutation({
    mutationFn: () => api.put('/setup/dietary-taxonomy', { dietaryTags: dietary, allergens }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dietary-taxonomy'] }),
  })

  if (isLoading) return <div className="p-8 text-white/60">Loading…</div>

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">🥗 Dietary tags &amp; allergens</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          The taxonomy your menu items pick from. Defined once here, attached on each item in the menu editor.
        </p>
      </header>

      <div className="px-7 py-7 max-w-3xl mx-auto space-y-6">
        <ListEditor
          title="Dietary tags"
          desc="What customers filter by — Vegetarian, Halal, Gluten-free, etc."
          items={dietary}
          onChange={setDietary}
          placeholder="e.g. Pescatarian"
          accent="var(--erp-primary-ink)"
        />
        <ListEditor
          title="Allergens"
          desc="Things customers may need to avoid. Surfaced as warnings in checkout."
          items={allergens}
          onChange={setAllergens}
          placeholder="e.g. Sesame"
          accent="var(--erp-warning)"
        />

        <div className="flex justify-end gap-3 pt-4 border-t border-white/[0.05]">
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : 'Save taxonomy'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ListEditor({ title, desc, items, onChange, placeholder, accent }: {
  title: string; desc: string; items: string[]; onChange: (v: string[]) => void; placeholder: string; accent: string
}) {
  const [next, setNext] = useState('')
  function add() {
    const v = next.trim()
    if (!v || items.includes(v)) return
    onChange([...items, v])
    setNext('')
  }
  function remove(i: number) { onChange(items.filter((_, idx) => idx !== i)) }

  return (
    <div className="rounded-2xl p-5"
      style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <h2 className="text-sm font-black uppercase tracking-[0.18em] text-white/65">{title}</h2>
      <p className="text-xs text-white/35 mt-0.5">{desc}</p>

      <div className="flex flex-wrap gap-2 mt-4">
        {items.map((item, i) => (
          <span key={item} className="inline-flex items-center gap-2 rounded-full px-3 py-1.5"
            style={{ background: `color-mix(in srgb, ${accent} 8%, transparent)`, color: accent, border: `1px solid color-mix(in srgb, ${accent} 20%, transparent)` }}>
            <span className="text-xs font-bold">{item}</span>
            <button onClick={() => remove(i)} className="text-xs hover:text-white/100">✕</button>
          </span>
        ))}
        {items.length === 0 && <p className="text-xs text-white/35 italic">Empty.</p>}
      </div>

      <div className="flex gap-2 mt-4">
        <input value={next} onChange={(e) => setNext(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          placeholder={placeholder}
          className="flex-1 rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:outline-none"
          style={{ borderColor: 'rgb(var(--fg-rgb) / 0.08)' }}
        />
        <button onClick={add} disabled={!next.trim()}
          className="rounded-lg px-4 py-2 text-xs font-bold text-bone disabled:opacity-50"
          style={{ background: accent }}>
          + Add
        </button>
      </div>
    </div>
  )
}
