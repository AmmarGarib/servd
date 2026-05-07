'use client'
import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../lib/api'

interface Concept { id: string; name: string; slug: string; primaryColor: string | null }
interface Ingredient { id: string; name: string; unit: string; notes: string | null }
interface BrandUse {
  componentId: string
  conceptId: string
  isPrimary: boolean
  concept: Concept
}

interface Component {
  id: string
  name: string
  type: 'hero' | 'supporting' | 'trim_waste'
  description: string | null
  preparation: string | null
  seasons: string[]
  yieldGrams: number | null
  shelfLifeHours: number | null
  laborMinutes: number | null
  isActive: boolean
  notes: string | null
  baseIngredientId: string | null
  baseIngredient: Ingredient | null
  brands: BrandUse[]
}

const TYPE_META: Record<Component['type'], { label: string; emoji: string; color: string; bg: string }> = {
  hero:        { label: 'Hero',        emoji: '🌟', color: '#F59E0B', bg: 'rgba(245,158,11,0.08)' },
  supporting:  { label: 'Supporting',  emoji: '🤝', color: '#6366F1', bg: 'rgba(99,102,241,0.08)' },
  trim_waste:  { label: 'Trim / Waste', emoji: '♻️', color: '#22C55E', bg: 'rgba(34,197,94,0.08)' },
}

const SEASONS = [
  { key: '',          label: 'All' },
  { key: 'current',   label: '★ Current' },
  { key: 'spring',    label: '🌱 Spring' },
  { key: 'summer',    label: '☀ Summer' },
  { key: 'monsoon',   label: '🌧 Monsoon' },
  { key: 'autumn',    label: '🍂 Autumn' },
  { key: 'winter',    label: '❄ Winter' },
  { key: 'ramadan',   label: '🌙 Ramadan' },
  { key: 'year-round', label: '⏳ Year-round' },
]

export default function ComponentLibraryPage() {
  const qc = useQueryClient()
  const [type, setType] = useState<string>('')
  const [season, setSeason] = useState<string>('')
  const [ingredientId, setIngredientId] = useState<string>('')
  const [brandConceptId, setBrandConceptId] = useState<string>('')
  const [searchQ, setSearchQ] = useState('')
  const [activeOnly, setActiveOnly] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState<Component | null>(null)

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    if (type)           params.set('type', type)
    if (season)         params.set('season', season)
    if (ingredientId)   params.set('ingredientId', ingredientId)
    if (brandConceptId) params.set('brandConceptId', brandConceptId)
    if (searchQ.trim()) params.set('q', searchQ.trim())
    if (activeOnly)     params.set('activeOnly', 'true')
    const qs = params.toString()
    return qs ? `?${qs}` : ''
  }, [type, season, ingredientId, brandConceptId, searchQ, activeOnly])

  const { data: components = [], isLoading } = useQuery<Component[]>({
    queryKey: ['components', queryString],
    queryFn: () => api.get(`/components${queryString}`),
  })
  const { data: ingredients = [] } = useQuery<Ingredient[]>({
    queryKey: ['inventory'],
    queryFn: () => api.get('/inventory'),
  })
  const { data: concepts = [] } = useQuery<Concept[]>({
    queryKey: ['concepts'],
    queryFn: () => api.get('/concepts'),
  })

  // Group by parent ingredient for the "master file" feel
  const grouped = useMemo(() => {
    const map = new Map<string, { ingredient: Ingredient | null; components: Component[] }>()
    for (const c of components) {
      const key = c.baseIngredient?.id ?? '_unlinked'
      if (!map.has(key)) map.set(key, { ingredient: c.baseIngredient, components: [] })
      map.get(key)!.components.push(c)
    }
    // Order: real ingredients alphabetical, _unlinked last
    return Array.from(map.entries()).sort((a, b) => {
      if (a[0] === '_unlinked') return 1
      if (b[0] === '_unlinked') return -1
      return (a[1].ingredient?.name ?? '').localeCompare(b[1].ingredient?.name ?? '')
    })
  }, [components])

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="sticky top-0 z-20 px-7 py-5 border-b border-white/[0.05]"
        style={{ background: 'rgba(9,10,14,0.92)', backdropFilter: 'blur(20px)' }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30">Master file</p>
            <h1 className="text-2xl font-black text-white/90 mt-1">Component Library</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Every prep, sauce, sub-recipe and trim utilization built from your ingredients. Plug-and-play seasonal additions — tag a component to a season and a brand, it shows up where it should.
            </p>
          </div>
          <button onClick={() => setShowAdd(true)}
            className="rounded-xl bg-kds-green px-4 py-2.5 text-sm font-black text-black hover:opacity-90">
            + Add component
          </button>
        </div>

        {/* Filter strip */}
        <div className="mt-4 flex items-center gap-2 flex-wrap">
          <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Search components, prep notes…"
            className="flex-1 min-w-[220px] rounded-lg px-3 py-1.5 text-sm focus:outline-none"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.85)' }} />

          {/* Type chips */}
          <div className="flex rounded-lg overflow-hidden text-xs font-bold border border-white/10">
            <button onClick={() => setType('')}
              className="px-2.5 py-1.5 transition-colors"
              style={{ background: type === '' ? '#fff' : 'transparent', color: type === '' ? '#000' : 'rgba(255,255,255,0.6)' }}>
              All
            </button>
            {(Object.keys(TYPE_META) as Array<Component['type']>).map((t) => (
              <button key={t} onClick={() => setType(type === t ? '' : t)}
                className="px-2.5 py-1.5 transition-colors border-l border-white/10"
                style={{
                  background: type === t ? TYPE_META[t].color : 'transparent',
                  color: type === t ? '#000' : 'rgba(255,255,255,0.6)',
                }}>
                {TYPE_META[t].emoji} {TYPE_META[t].label}
              </button>
            ))}
          </div>

          {/* Season select */}
          <select value={season} onChange={(e) => setSeason(e.target.value)}
            className="rounded-lg px-3 py-1.5 text-xs"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.85)' }}>
            {SEASONS.map((s) => <option key={s.key || 'all'} value={s.key}>{s.label}</option>)}
          </select>

          {/* Ingredient select */}
          <select value={ingredientId} onChange={(e) => setIngredientId(e.target.value)}
            className="rounded-lg px-3 py-1.5 text-xs"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.85)' }}>
            <option value="">All ingredients</option>
            {ingredients.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>

          {/* Brand select */}
          <select value={brandConceptId} onChange={(e) => setBrandConceptId(e.target.value)}
            className="rounded-lg px-3 py-1.5 text-xs"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.85)' }}>
            <option value="">All brands</option>
            {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>

          <label className="flex items-center gap-1.5 text-xs text-white/55 cursor-pointer px-2 py-1.5 rounded-lg border border-white/10">
            <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} className="accent-kds-green" />
            Active only
          </label>
        </div>
      </header>

      <div className="px-7 py-6 max-w-[1200px] space-y-5">
        {isLoading && <p className="text-sm text-white/40">Loading…</p>}
        {!isLoading && components.length === 0 && (
          <div className="rounded-2xl p-12 text-center"
            style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-4xl mb-3">📚</p>
            <p className="font-bold text-white/85">No components match these filters</p>
            <p className="text-sm text-white/45 mt-1">Try clearing filters or add a new component above.</p>
          </div>
        )}

        {grouped.map(([key, { ingredient, components }]) => (
          <IngredientGroup key={key}
            ingredient={ingredient}
            components={components}
            onEdit={(c) => setEditing(c)}
            onChange={() => qc.invalidateQueries({ queryKey: ['components'] })} />
        ))}
      </div>

      {(showAdd || editing) && (
        <ComponentModal
          existing={editing}
          ingredients={ingredients}
          concepts={concepts}
          onClose={() => { setShowAdd(false); setEditing(null) }}
          onSaved={() => {
            setShowAdd(false); setEditing(null)
            void qc.invalidateQueries({ queryKey: ['components'] })
          }} />
      )}
    </div>
  )
}

function IngredientGroup({ ingredient, components, onEdit, onChange }: {
  ingredient: Ingredient | null
  components: Component[]
  onEdit: (c: Component) => void
  onChange: () => void
}) {
  // Sub-group by type for clean three-column layout
  const byType: Record<Component['type'], Component[]> = { hero: [], supporting: [], trim_waste: [] }
  for (const c of components) byType[c.type].push(c)

  return (
    <section className="rounded-2xl overflow-hidden"
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="px-5 py-3 flex items-center justify-between border-b border-white/[0.04]"
        style={{ background: 'rgba(255,255,255,0.015)' }}>
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/40">Base ingredient</p>
          <p className="font-black text-white/95 text-base mt-0.5">
            {ingredient ? `🌿 ${ingredient.name}` : '— Unlinked components'}
          </p>
          {ingredient?.notes && (
            <p className="text-[10px] text-white/35 mt-0.5">{ingredient.notes}</p>
          )}
        </div>
        <span className="text-xs text-white/35 font-mono">{components.length} component{components.length === 1 ? '' : 's'}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-px" style={{ background: 'rgba(255,255,255,0.04)' }}>
        {(Object.keys(TYPE_META) as Array<Component['type']>).map((type) => (
          <div key={type} className="p-4" style={{ background: '#0d0f15' }}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-black uppercase tracking-[0.22em]" style={{ color: TYPE_META[type].color }}>
                {TYPE_META[type].emoji} {TYPE_META[type].label}
              </p>
              <span className="text-[10px] text-white/30">{byType[type].length}</span>
            </div>
            <div className="space-y-1.5">
              {byType[type].map((c) => (
                <ComponentTile key={c.id} component={c} onEdit={onEdit} onChange={onChange} />
              ))}
              {byType[type].length === 0 && (
                <p className="text-[11px] text-white/25 italic">none yet</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function ComponentTile({ component, onEdit, onChange }: {
  component: Component
  onEdit: (c: Component) => void
  onChange: () => void
}) {
  const meta = TYPE_META[component.type]
  const remove = useMutation({
    mutationFn: () => api.delete(`/components/${component.id}`),
    onSuccess: () => onChange(),
  })

  return (
    <div className="rounded-lg p-2.5 group"
      style={{
        background: meta.bg,
        border: `1px solid ${meta.color}25`,
        opacity: component.isActive ? 1 : 0.55,
      }}>
      <div className="flex items-start justify-between gap-2">
        <button onClick={() => onEdit(component)}
          className="text-sm font-bold text-white/90 text-left hover:underline">
          {component.name}
        </button>
        <button onClick={() => { if (confirm(`Remove ${component.name}?`)) remove.mutate() }}
          className="text-white/30 hover:text-kds-red opacity-0 group-hover:opacity-100 transition-opacity text-xs shrink-0">
          ×
        </button>
      </div>
      {component.description && (
        <p className="text-[11px] text-white/55 mt-0.5 leading-relaxed line-clamp-2">{component.description}</p>
      )}
      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
        {component.seasons.map((s) => (
          <span key={s} className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider"
            style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.55)' }}>
            {s}
          </span>
        ))}
        {component.brands.map((b) => (
          <span key={b.conceptId} className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider"
            style={{ background: `${b.concept.primaryColor ?? '#6366F1'}20`, color: b.concept.primaryColor ?? '#6366F1' }}>
            {b.concept.name}
          </span>
        ))}
        {!component.isActive && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider bg-white/5 text-white/35">
            paused
          </span>
        )}
      </div>
    </div>
  )
}

function ComponentModal({ existing, ingredients, concepts, onClose, onSaved }: {
  existing: Component | null
  ingredients: Ingredient[]
  concepts: Concept[]
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName]                   = useState(existing?.name ?? '')
  const [type, setType]                   = useState<Component['type']>(existing?.type ?? 'hero')
  const [baseIngredientId, setBaseIng]    = useState<string>(existing?.baseIngredientId ?? '')
  const [description, setDescription]     = useState(existing?.description ?? '')
  const [preparation, setPreparation]     = useState(existing?.preparation ?? '')
  const [seasons, setSeasons]             = useState<string[]>(existing?.seasons ?? [])
  const [yieldGrams, setYieldGrams]       = useState(existing?.yieldGrams ? String(existing.yieldGrams) : '')
  const [shelfLifeHours, setShelfLife]    = useState(existing?.shelfLifeHours ? String(existing.shelfLifeHours) : '')
  const [laborMinutes, setLabor]          = useState(existing?.laborMinutes ? String(existing.laborMinutes) : '')
  const [isActive, setIsActive]           = useState(existing?.isActive ?? true)
  const [brandConceptIds, setBrands]      = useState<string[]>(existing?.brands.map((b) => b.conceptId) ?? [])
  const [error, setError]                 = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        type,
        baseIngredientId: baseIngredientId || null,
        description: description.trim() || null,
        preparation: preparation.trim() || null,
        seasons,
        yieldGrams: yieldGrams ? parseFloat(yieldGrams) : null,
        shelfLifeHours: shelfLifeHours ? parseInt(shelfLifeHours, 10) : null,
        laborMinutes: laborMinutes ? parseInt(laborMinutes, 10) : null,
        isActive,
        brandConceptIds,
      }
      return existing
        ? api.patch(`/components/${existing.id}`, body)
        : api.post('/components', body)
    },
    onSuccess: () => onSaved(),
    onError: (e: Error) => setError(e.message),
  })

  function toggleSeason(s: string) {
    setSeasons((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s])
  }
  function toggleBrand(id: string) {
    setBrands((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-xl rounded-2xl overflow-hidden"
        style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">{existing ? 'Edit component' : 'Add component'}</h2>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <Label>Name *</Label>
              <input value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Stuffed Dates / Lemon Curd / Date Coffee"
                className="cmp-input" autoFocus />
            </div>
            <div>
              <Label>Type *</Label>
              <select value={type} onChange={(e) => setType(e.target.value as Component['type'])}
                className="cmp-input">
                <option value="hero">🌟 Hero</option>
                <option value="supporting">🤝 Supporting</option>
                <option value="trim_waste">♻️ Trim / Waste</option>
              </select>
            </div>
          </div>

          <div>
            <Label>Base ingredient</Label>
            <select value={baseIngredientId} onChange={(e) => setBaseIng(e.target.value)}
              className="cmp-input">
              <option value="">— Unlinked (composite / no specific ingredient)</option>
              {ingredients.map((i) => (
                <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>
              ))}
            </select>
          </div>

          <div>
            <Label>Seasons</Label>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {['spring', 'summer', 'monsoon', 'autumn', 'winter', 'ramadan', 'year-round'].map((s) => (
                <button key={s} type="button" onClick={() => toggleSeason(s)}
                  className="rounded-full px-3 py-1 text-xs font-bold transition-colors capitalize"
                  style={seasons.includes(s)
                    ? { background: 'rgba(245,158,11,0.18)', border: '1px solid rgba(245,158,11,0.5)', color: '#F59E0B' }
                    : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.55)' }}>
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label>Description</Label>
            <input value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="One-line summary — what this is, where you'd use it"
              className="cmp-input" />
          </div>

          <div>
            <Label>Preparation notes</Label>
            <textarea value={preparation} onChange={(e) => setPreparation(e.target.value)}
              rows={4}
              placeholder="Step-by-step prep, measurements, technique notes — pull from R&D"
              className="cmp-input resize-none" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>Yield (g)</Label>
              <input value={yieldGrams} onChange={(e) => setYieldGrams(e.target.value)} type="number"
                placeholder="500" className="cmp-input" />
            </div>
            <div>
              <Label>Shelf life (h)</Label>
              <input value={shelfLifeHours} onChange={(e) => setShelfLife(e.target.value)} type="number"
                placeholder="48" className="cmp-input" />
            </div>
            <div>
              <Label>Labour (min)</Label>
              <input value={laborMinutes} onChange={(e) => setLabor(e.target.value)} type="number"
                placeholder="20" className="cmp-input" />
            </div>
          </div>

          <div>
            <Label>Used by brand(s)</Label>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {concepts.map((c) => (
                <button key={c.id} type="button" onClick={() => toggleBrand(c.id)}
                  className="rounded-full px-3 py-1 text-xs font-bold transition-colors"
                  style={brandConceptIds.includes(c.id)
                    ? { background: `${c.primaryColor ?? '#00D4B1'}25`, border: `1px solid ${c.primaryColor ?? '#00D4B1'}`, color: c.primaryColor ?? '#00D4B1' }
                    : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.55)' }}>
                  {c.name}
                </button>
              ))}
            </div>
          </div>

          {existing && (
            <label className="flex items-center gap-2 text-xs text-white/65 cursor-pointer">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="accent-kds-green" />
              Active (uncheck to pause this component)
            </label>
          )}

          {error && (
            <div className="rounded-lg px-3 py-2 text-xs text-kds-red"
              style={{ background: 'rgba(255,77,79,0.08)', border: '1px solid rgba(255,77,79,0.3)' }}>
              {error}
            </div>
          )}
        </div>
        <div className="flex justify-between gap-2 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55">Cancel</button>
          <button onClick={() => save.mutate()}
            disabled={!name.trim() || save.isPending}
            className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-40">
            {save.isPending ? 'Saving…' : existing ? 'Save changes' : 'Add component'}
          </button>
        </div>
      </div>
      <style jsx>{`
        .cmp-input {
          width: 100%;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08);
          color: rgba(255,255,255,0.9);
          border-radius: 0.5rem;
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          outline: none;
        }
        .cmp-input:focus { border-color: #00D4B1; }
      `}</style>
    </div>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="text-xs text-white/55 block mb-1">{children}</label>
}
