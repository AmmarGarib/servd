'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import Link from 'next/link'
import { RecipeStepsEditor } from '../../../components/recipe/RecipeStepsEditor'

const Q_FACTOR = 0.05

function fmtPKR(cents: number) {
  return `PKR ${(cents / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtPct(n: number) { return `${n.toFixed(1)}%` }

function fcColor(pct: number | null) {
  if (pct === null) return 'text-s-muted'
  if (pct <= 28)    return 'text-s-teal'
  if (pct <= 35)    return 'text-s-amber'
  return 'text-s-red'
}
function fcLabel(pct: number | null) {
  if (pct === null) return null
  if (pct <= 28)    return { label: 'On Target',   dot: '🟢' }
  if (pct <= 35)    return { label: 'Acceptable',  dot: '🟡' }
  return              { label: 'Over Budget',  dot: '🔴' }
}

interface Concept       { id: string; name: string }
interface MenuItem      { id: string; name: string; priceCents: number; concept: { name: string } }
interface InventoryItem { id: string; name: string; unit: string; unitCostCents: number | null }

interface RecipeIngredient {
  id: string
  inventoryItemId: string
  quantity: number        // usable recipe qty (post-yield)
  yieldPct: number        // 0–1
  unit: string
  notes: string | null
  inventoryItem: { id: string; name: string; unit: string; unitCostCents: number | null }
  purchaseQty: number           // computed by API: quantity / yieldPct
  ingredientCostCents: number   // computed by API
}

interface Recipe {
  id: string
  menuItemId: string
  servings: number
  portionSizeG: number | null
  laborMinutes: number
  notes: string | null
  steps: string | null
  stepsUrdu: string | null
  seasons: string[]
  seasonStart: string | null
  seasonEnd: string | null
  isActive: boolean
  menuItem: { id: string; name: string; priceCents: number; conceptId: string; concept: { name: string } }
  ingredients: RecipeIngredient[]
  ingredientCostCents: number
  qFactorCents: number
  laborCostCents: number
  totalCostCents: number
  costPerPortionCents: number
  grossMarginPct: number | null
  foodCostPct: number | null
}

interface IngRow {
  inventoryItemId: string
  quantity: string  // usable qty in recipe
  yieldPct: string  // 1–100 (displayed as %)
  unit: string
  notes: string
}

const BLANK_ING: IngRow = { inventoryItemId: '', quantity: '', yieldPct: '100', unit: '', notes: '' }

export default function RecipesPage() {
  const qc = useQueryClient()
  const [conceptFilter, setConceptFilter] = useState('')
  const [search,        setSearch]        = useState('')
  const [expanded,      setExpanded]      = useState<string | null>(null)
  const [modal,         setModal]         = useState<'create' | Recipe | null>(null)

  // List filters
  const [seasonFilter, setSeasonFilter] = useState<string>('')   // '' = all, 'current' = auto-detect
  const [searchQ,      setSearchQ]      = useState('')
  const [activeOnly,   setActiveOnly]   = useState(false)

  // form
  const [menuItemId,   setMenuItemId]   = useState('')
  const [servings,     setServings]     = useState('1')
  const [portionSizeG, setPortionSizeG] = useState('')
  const [laborMins,    setLaborMins]    = useState('0')
  const [notes,        setNotes]        = useState('')
  const [steps,        setSteps]        = useState('')
  const [stepsUrdu,    setStepsUrdu]    = useState('')
  const [seasons,      setSeasons]      = useState<string[]>([])
  const [seasonStart,  setSeasonStart]  = useState('')
  const [seasonEnd,    setSeasonEnd]    = useState('')
  const [isActive,     setIsActive]     = useState(true)
  const [ings,         setIngs]         = useState<IngRow[]>([{ ...BLANK_ING }])
  const [formErr,      setFormErr]      = useState('')

  const { data: concepts } = useQuery({
    queryKey: ['concepts'],
    queryFn:  () => api.get<Concept[]>('/concepts'),
  })
  const queryString = (() => {
    const params = new URLSearchParams()
    if (seasonFilter) params.set('season', seasonFilter)
    if (searchQ.trim()) params.set('q', searchQ.trim())
    if (activeOnly) params.set('activeOnly', 'true')
    const qs = params.toString()
    return qs ? `?${qs}` : ''
  })()

  const { data: recipes, isLoading } = useQuery({
    queryKey: ['recipes', seasonFilter, searchQ, activeOnly],
    queryFn:  () => api.get<Recipe[]>(`/recipes${queryString}`),
  })
  const { data: menuItems } = useQuery({
    queryKey: ['menu-items-flat'],
    queryFn:  () => api.get<MenuItem[]>('/menu/items'),
    enabled:  modal !== null,
  })
  const { data: invItems } = useQuery({
    queryKey: ['inventory-items-flat'],
    queryFn:  () => api.get<InventoryItem[]>('/inventory'),
    enabled:  modal !== null,
  })

  const createMut = useMutation({
    mutationFn: (body: unknown) => api.post('/recipes', body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['recipes'] }); closeModal() },
    onError:   (e: Error) => setFormErr(e.message),
  })
  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) =>
      api.put(`/recipes/${id}`, body) as Promise<unknown>,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['recipes'] }); closeModal() },
    onError:   (e: Error) => setFormErr(e.message),
  })
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/recipes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recipes'] }),
  })

  function openCreate() {
    setMenuItemId(''); setServings('1'); setPortionSizeG(''); setLaborMins('0')
    setNotes(''); setSteps(''); setStepsUrdu('')
    setSeasons([]); setSeasonStart(''); setSeasonEnd(''); setIsActive(true)
    setIngs([{ ...BLANK_ING }]); setFormErr(''); setModal('create')
  }
  function openEdit(r: Recipe) {
    setMenuItemId(r.menuItemId)
    setServings(String(r.servings))
    setPortionSizeG(r.portionSizeG ? String(r.portionSizeG) : '')
    setLaborMins(String(r.laborMinutes))
    setNotes(r.notes ?? '')
    setSteps(r.steps ?? '')
    setStepsUrdu(r.stepsUrdu ?? '')
    setSeasons(r.seasons ?? [])
    setSeasonStart(r.seasonStart ?? '')
    setSeasonEnd(r.seasonEnd ?? '')
    setIsActive(r.isActive ?? true)
    setIngs(r.ingredients.map((i) => ({
      inventoryItemId: i.inventoryItemId,
      quantity:        String(i.quantity),
      yieldPct:        String(Math.round(i.yieldPct * 100)),
      unit:            i.unit,
      notes:           i.notes ?? '',
    })))
    setFormErr(''); setModal(r)
  }
  function closeModal() { setModal(null) }

  function addIng()               { setIngs((p) => [...p, { ...BLANK_ING }]) }
  function removeIng(idx: number) { setIngs((p) => p.filter((_, i) => i !== idx)) }
  function updateIng(idx: number, field: keyof IngRow, val: string) {
    setIngs((p) => p.map((row, i) => i === idx ? { ...row, [field]: val } : row))
  }
  function pickIng(idx: number, invId: string) {
    const item = invItems?.find((i) => i.id === invId)
    setIngs((p) => p.map((row, i) =>
      i === idx ? { ...row, inventoryItemId: invId, unit: item?.unit ?? row.unit } : row
    ))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setFormErr('')
    const valid = ings.filter((i) => i.inventoryItemId && i.quantity)
    if (!valid.length) { setFormErr('Add at least one ingredient'); return }
    const body = {
      menuItemId,
      servings:     parseInt(servings) || 1,
      portionSizeG: portionSizeG ? parseFloat(portionSizeG) : undefined,
      laborMinutes: parseInt(laborMins) || 0,
      notes:        notes || undefined,
      steps:        steps || undefined,
      stepsUrdu:    stepsUrdu || undefined,
      seasons:      seasons,
      seasonStart:  seasonStart || null,
      seasonEnd:    seasonEnd || null,
      isActive:     isActive,
      ingredients:  valid.map((i) => ({
        inventoryItemId: i.inventoryItemId,
        quantity:        parseFloat(i.quantity),
        yieldPct:        Math.min(1, Math.max(0.01, (parseFloat(i.yieldPct) || 100) / 100)),
        unit:            i.unit,
        notes:           i.notes || undefined,
      })),
    }
    if (typeof modal === 'object' && modal !== null && 'id' in modal) {
      updateMut.mutate({ id: modal.id, body })
    } else {
      createMut.mutate(body)
    }
  }

  const filtered = (recipes ?? []).filter((r) => {
    if (conceptFilter && r.menuItem.conceptId !== conceptFilter) return false
    if (search && !r.menuItem.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })
  const isEditing = typeof modal === 'object' && modal !== null && 'id' in modal

  // summary stats
  const withFc     = (recipes ?? []).filter((r) => r.foodCostPct !== null)
  const avgFc      = withFc.length ? withFc.reduce((s, r) => s + (r.foodCostPct ?? 0), 0) / withFc.length : null
  const overBudget = (recipes ?? []).filter((r) => (r.foodCostPct ?? 0) > 35).length

  return (
    <div className="min-h-screen bg-s-bg">

      {/* Header */}
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs text-s-muted">Accounting</p>
            <h1 className="text-xl font-bold text-s-text">Recipe Costing</h1>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/accounting" className="text-xs text-s-teal hover:underline">← Hub</Link>
            <button onClick={openCreate} className="s-btn-primary text-xs px-3 py-1.5">+ New Recipe</button>
          </div>
        </div>

        {/* Search + season filter strip */}
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <input
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Search recipes by name or notes…"
            className="flex-1 min-w-[220px] s-input text-sm px-3 py-1.5 rounded-lg"
          />
          <div className="flex rounded-lg overflow-hidden text-xs font-bold border border-s-border">
            {[
              { key: '',          label: 'All' },
              { key: 'current',   label: '★ Current season' },
              { key: 'spring',    label: '🌱 Spring' },
              { key: 'summer',    label: '☀️ Summer' },
              { key: 'monsoon',   label: '🌧 Monsoon' },
              { key: 'autumn',    label: '🍂 Autumn' },
              { key: 'winter',    label: '❄️ Winter' },
              { key: 'ramadan',   label: '🌙 Ramadan' },
              { key: 'year-round', label: 'Year-round' },
            ].map((s) => (
              <button
                key={s.key || 'all'}
                onClick={() => setSeasonFilter(s.key)}
                className={`px-2.5 py-1.5 transition-colors border-r border-s-border last:border-r-0 ${
                  seasonFilter === s.key ? 'bg-s-teal text-black' : 'text-s-muted hover:text-s-text'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-s-muted cursor-pointer px-2 py-1.5 rounded-lg border border-s-border">
            <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} className="accent-s-teal" />
            Active only
          </label>
        </div>
      </header>

      <div className="p-6 space-y-4 max-w-7xl">

        {/* Summary strip */}
        {(recipes?.length ?? 0) > 0 && (
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: 'Total Recipes', value: String(recipes!.length), color: 'text-s-text' },
              {
                label: 'Avg Food Cost',
                value: avgFc != null ? fmtPct(avgFc) : '—',
                color: avgFc == null ? 'text-s-muted' : avgFc <= 28 ? 'text-s-teal' : avgFc <= 35 ? 'text-s-amber' : 'text-s-red',
              },
              { label: 'Over 35% FC',   value: String(overBudget), color: overBudget ? 'text-s-red' : 'text-s-muted' },
              { label: 'Q Factor Rate', value: '5%',               color: 'text-s-muted' },
            ].map(({ label, value, color }) => (
              <div key={label} className="s-card px-4 py-3">
                <p className="text-[10px] text-s-muted uppercase tracking-wider">{label}</p>
                <p className={`text-xl font-black mt-0.5 ${color}`}>{value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-3 items-center">
          <input type="text" placeholder="Search recipes…"
            value={search} onChange={(e) => setSearch(e.target.value)}
            className="s-input text-sm h-9 w-56" />
          <select value={conceptFilter} onChange={(e) => setConceptFilter(e.target.value)}
            className="s-select text-sm h-9 w-44">
            <option value="">All Concepts</option>
            {concepts?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <span className="ml-auto text-xs text-s-muted">
            {filtered.length} recipe{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Recipe list */}
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-14 rounded-xl" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="s-card text-center py-16">
            <p className="text-s-dim text-sm">
              {(recipes?.length ?? 0) === 0
                ? 'No recipes yet — click "+ New Recipe" to start building your costing sheet'
                : 'No recipes match your filter'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((r) => {
              const isOpen       = expanded === r.id
              const fc           = r.foodCostPct
              const fcMeta       = fcLabel(fc)
              const recipeWeightG = r.portionSizeG && r.servings ? r.portionSizeG * r.servings : null

              return (
                <div key={r.id} className="s-card overflow-hidden">

                  {/* Summary row */}
                  <div
                    className="flex items-center gap-4 px-4 py-3 cursor-pointer select-none"
                    onClick={() => setExpanded(isOpen ? null : r.id)}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                    style={{ transition: 'background 0.12s' }}
                  >
                    <span className="text-[10px] text-s-dim shrink-0"
                      style={{ display: 'inline-block', transition: 'transform 0.2s', transform: isOpen ? 'rotate(90deg)' : 'none' }}>
                      ▶
                    </span>

                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-s-text text-sm truncate">{r.menuItem.name}</p>
                      <p className="text-[10px] text-s-dim">
                        {r.menuItem.concept.name}
                        {r.servings > 1 && ` · ${r.servings} portions`}
                        {r.portionSizeG  && ` · ${r.portionSizeG}g each`}
                        {recipeWeightG   && ` · ${recipeWeightG.toFixed(0)}g batch`}
                      </p>
                    </div>

                    <div className="flex items-center gap-5 shrink-0">
                      <Metric label="Ing. Cost"    value={fmtPKR(r.ingredientCostCents)} />
                      <Metric label="Q Factor"     value={fmtPKR(r.qFactorCents)}        dim />
                      <Metric label="Total Cost"   value={fmtPKR(r.totalCostCents)}       bold />
                      <Metric label="Per Portion"  value={fmtPKR(r.costPerPortionCents)}  teal />
                      <Metric label="Food Cost %"  value={fc !== null ? fmtPct(fc) : '—'} className={fcColor(fc)} bold />
                      {fcMeta && (
                        <div className="flex items-center gap-1 text-[10px] font-semibold" style={{ minWidth: 80 }}>
                          <span>{fcMeta.dot}</span>
                          <span className={fcColor(fc)}>{fcMeta.label}</span>
                        </div>
                      )}
                      <div className="flex gap-1 ml-1" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => openEdit(r)}
                          className="text-xs px-2 py-1 rounded text-s-muted hover:text-s-teal hover:bg-s-teal-dim transition-colors">
                          Edit
                        </button>
                        <button
                          onClick={() => { if (confirm(`Delete recipe for "${r.menuItem.name}"?`)) deleteMut.mutate(r.id) }}
                          className="text-xs px-2 py-1 rounded text-s-dim hover:text-s-red hover:bg-s-red-dim transition-colors">
                          Del
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Expanded costing sheet */}
                  {isOpen && (
                    <div className="border-t border-s-border">

                      {/* Spreadsheet header strip */}
                      <div className="grid grid-cols-6 gap-4 text-center px-6 py-3 border-b border-s-border/40"
                        style={{ background: 'rgba(0,212,177,0.04)' }}>
                        {[
                          { label: 'RECIPE WEIGHT',     value: recipeWeightG ? `${recipeWeightG.toFixed(0)}g` : '—' },
                          { label: 'PORTION SIZE',      value: r.portionSizeG ? `${r.portionSizeG}g` : '—'          },
                          { label: 'PORTIONS',          value: String(r.servings)                                    },
                          { label: 'Q FACTOR (5%)',     value: fmtPKR(r.qFactorCents)                                },
                          { label: 'TOTAL RECIPE COST', value: fmtPKR(r.totalCostCents)                              },
                          { label: 'PORTION COST',      value: fmtPKR(r.costPerPortionCents)                         },
                        ].map(({ label, value }) => (
                          <div key={label}>
                            <p style={{ fontSize: '8px', letterSpacing: '0.18em' }}
                              className="font-black text-s-muted uppercase">{label}</p>
                            <p className="text-sm font-bold text-s-text mt-0.5">{value}</p>
                          </div>
                        ))}
                      </div>

                      {/* Ingredient breakdown table */}
                      <div className="overflow-x-auto">
                        <table className="w-full" style={{ fontSize: '11px' }}>
                          <thead>
                            <tr style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                              {[
                                'INGREDIENT', 'PURCHASE QTY', 'PURCHASE COST',
                                'YIELD %', 'USABLE QTY', 'COST / UNIT', 'RECIPE QTY', 'RECIPE COST',
                              ].map((h) => (
                                <th key={h} style={{ fontSize: '8px', letterSpacing: '0.15em', color: 'rgba(255,255,255,0.28)' }}
                                  className="px-4 py-2 text-left font-black uppercase">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {r.ingredients.map((ing, idx) => {
                              const costPerUnit  = (ing.inventoryItem.unitCostCents ?? 0) / 100
                              const purchaseQty  = ing.purchaseQty
                              const usableQty    = purchaseQty * ing.yieldPct // = ing.quantity
                              const yieldWarn    = ing.yieldPct < 0.80

                              return (
                                <tr key={ing.id}
                                  style={{ borderTop: idx > 0 ? '1px solid rgba(255,255,255,0.04)' : undefined }}>
                                  <td className="px-4 py-2.5 font-semibold" style={{ color: 'rgba(255,255,255,0.8)' }}>
                                    {ing.inventoryItem.name}
                                  </td>
                                  <td className="px-4 py-2.5 text-s-muted">
                                    {purchaseQty.toLocaleString('en', { maximumFractionDigits: 3 })} {ing.unit}
                                  </td>
                                  <td className="px-4 py-2.5 text-s-muted">
                                    PKR {(costPerUnit * purchaseQty).toFixed(2)}
                                  </td>
                                  <td className="px-4 py-2.5">
                                    <span className={yieldWarn ? 'text-s-amber font-semibold' : 'text-s-muted'}>
                                      {(ing.yieldPct * 100).toFixed(0)}%
                                    </span>
                                  </td>
                                  <td className="px-4 py-2.5 text-s-muted">
                                    {usableQty.toLocaleString('en', { maximumFractionDigits: 3 })} {ing.unit}
                                  </td>
                                  <td className="px-4 py-2.5 text-s-muted">
                                    PKR {costPerUnit.toFixed(4)}/{ing.unit}
                                  </td>
                                  <td className="px-4 py-2.5 font-semibold" style={{ color: 'rgba(255,255,255,0.65)' }}>
                                    {ing.quantity.toLocaleString('en', { maximumFractionDigits: 3 })} {ing.unit}
                                  </td>
                                  <td className="px-4 py-2.5 font-bold text-s-teal">
                                    PKR {(ing.ingredientCostCents / 100).toFixed(2)}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                          <tfoot>
                            <tr style={{ borderTop: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.015)' }}>
                              <td colSpan={7} className="px-4 py-2 text-right font-black uppercase"
                                style={{ fontSize: '8px', letterSpacing: '0.15em', color: 'rgba(255,255,255,0.28)' }}>
                                Ingredient Subtotal
                              </td>
                              <td className="px-4 py-2 font-black" style={{ color: 'rgba(255,255,255,0.65)' }}>
                                {fmtPKR(r.ingredientCostCents)}
                              </td>
                            </tr>
                            <tr style={{ borderTop: '1px solid rgba(255,255,255,0.04)', background: 'rgba(255,255,255,0.01)' }}>
                              <td colSpan={7} className="px-4 py-1.5 text-right text-s-muted" style={{ fontSize: '10px' }}>
                                Q Factor — 5% misc. (salt, oil, unmeasured items)
                              </td>
                              <td className="px-4 py-1.5 text-s-muted text-xs">{fmtPKR(r.qFactorCents)}</td>
                            </tr>
                            {r.laborCostCents > 0 && (
                              <tr style={{ borderTop: '1px solid rgba(255,255,255,0.04)', background: 'rgba(255,255,255,0.01)' }}>
                                <td colSpan={7} className="px-4 py-1.5 text-right text-s-muted" style={{ fontSize: '10px' }}>
                                  Labor — {r.laborMinutes} min @ PKR 50/hr
                                </td>
                                <td className="px-4 py-1.5 text-s-muted text-xs">{fmtPKR(r.laborCostCents)}</td>
                              </tr>
                            )}
                            <tr style={{ borderTop: '2px solid rgba(0,212,177,0.2)', background: 'rgba(0,212,177,0.04)' }}>
                              <td colSpan={7} className="px-4 py-3 text-right font-black uppercase text-s-teal"
                                style={{ fontSize: '8.5px', letterSpacing: '0.15em' }}>
                                Total Recipe Cost
                              </td>
                              <td className="px-4 py-3 font-black text-s-teal">{fmtPKR(r.totalCostCents)}</td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>

                      {/* Bottom metrics bar */}
                      <div className="px-5 py-3 flex flex-wrap items-center gap-6 border-t border-s-border/40"
                        style={{ background: 'rgba(255,255,255,0.01)' }}>
                        <span className="text-xs">
                          <span className="text-s-muted">Portion cost: </span>
                          <span className="font-bold text-s-text">{fmtPKR(r.costPerPortionCents)}</span>
                        </span>
                        {r.menuItem.priceCents > 0 ? (
                          <>
                            <span className="text-xs">
                              <span className="text-s-muted">Sale price: </span>
                              <span className="font-bold text-s-text">{fmtPKR(r.menuItem.priceCents)}</span>
                            </span>
                            <span className="text-xs">
                              <span className="text-s-muted">Gross profit: </span>
                              <span className="font-bold text-s-teal">
                                {fmtPKR(r.menuItem.priceCents - r.costPerPortionCents)}
                              </span>
                            </span>
                            <span className="text-xs">
                              <span className="text-s-muted">Food cost %: </span>
                              <span className={`font-black ${fcColor(fc)}`}>
                                {fc !== null ? fmtPct(fc) : '—'}
                              </span>
                            </span>
                            <span className="text-xs">
                              <span className="text-s-muted">Gross margin: </span>
                              <span className={`font-bold ${(r.grossMarginPct ?? 0) >= 65 ? 'text-s-teal' : (r.grossMarginPct ?? 0) >= 50 ? 'text-s-amber' : 'text-s-red'}`}>
                                {r.grossMarginPct !== null ? fmtPct(r.grossMarginPct) : '—'}
                              </span>
                            </span>
                            {fcMeta && (
                              <div className="ml-auto flex items-center gap-1.5 text-xs font-bold">
                                <span>{fcMeta.dot}</span>
                                <span className={fcColor(fc)}>{fcMeta.label}</span>
                                {fc !== null && fc > 28 && (
                                  <span className="text-s-dim font-normal text-[10px]">
                                    ({(fc - 28).toFixed(1)}pp over target)
                                  </span>
                                )}
                              </div>
                            )}
                          </>
                        ) : (
                          <p className="text-xs text-s-dim">Set a menu price for this item to see food cost %</p>
                        )}
                        {r.notes && (
                          <p className="w-full text-[10px] text-s-dim italic mt-1">{r.notes}</p>
                        )}
                      </div>

                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Create / Edit Modal ─────────────────────────────────────────────── */}
      {modal !== null && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-10 px-4 bg-black/60 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) closeModal() }}
        >
          <div className="bg-s-surface border border-s-border rounded-2xl shadow-modal w-full max-w-2xl max-h-[calc(100vh-5rem)] overflow-y-auto animate-scale-in">

            <div className="px-6 py-4 border-b border-s-border flex items-center justify-between">
              <h2 className="font-bold text-s-text">{isEditing ? 'Edit Recipe' : 'New Recipe'}</h2>
              <button onClick={closeModal} className="text-s-dim hover:text-s-text transition-colors text-lg leading-none">✕</button>
            </div>

            <form onSubmit={handleSubmit} className="p-6 space-y-5">

              {/* Menu item */}
              <div className="space-y-1.5">
                <label className="text-xs font-black text-s-muted uppercase tracking-wider">Menu Item</label>
                {isEditing ? (
                  <p className="text-sm font-semibold text-s-text">{(modal as Recipe).menuItem.name}</p>
                ) : (
                  <select value={menuItemId} onChange={(e) => setMenuItemId(e.target.value)}
                    required className="s-select w-full">
                    <option value="">Select menu item…</option>
                    {menuItems?.map((m) => (
                      <option key={m.id} value={m.id}>{m.name} — {m.concept.name}</option>
                    ))}
                  </select>
                )}
              </div>

              {/* Portions / size / labor */}
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-black text-s-muted uppercase tracking-wider">Portions / Batch</label>
                  <input type="number" min={1} value={servings}
                    onChange={(e) => setServings(e.target.value)}
                    className="s-input w-full" required />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-black text-s-muted uppercase tracking-wider">Portion Size (g)</label>
                  <input type="number" min={0} step="any" value={portionSizeG}
                    onChange={(e) => setPortionSizeG(e.target.value)}
                    placeholder="Optional" className="s-input w-full" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-black text-s-muted uppercase tracking-wider">Labor (min)</label>
                  <input type="number" min={0} value={laborMins}
                    onChange={(e) => setLaborMins(e.target.value)}
                    className="s-input w-full" />
                </div>
              </div>

              {/* Notes */}
              <div className="space-y-1.5">
                <label className="text-xs font-black text-s-muted uppercase tracking-wider">Notes (internal)</label>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
                  placeholder="Preparation notes for managers…" className="s-input w-full resize-none" />
              </div>

              {/* Kitchen Steps — shown on KDS */}
              <div className="space-y-3 border border-s-border rounded-xl p-4"
                style={{ background: 'rgba(0,212,177,0.03)' }}>
                <div>
                  <p className="text-xs font-black text-s-teal uppercase tracking-wider mb-0.5">Kitchen Steps (KDS)</p>
                  <p className="text-[10px] text-s-dim">Shown to kitchen staff when they tap a dish on the KDS screen</p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-black text-s-muted uppercase tracking-wider">Steps (English)</label>
                  <textarea value={steps} onChange={(e) => setSteps(e.target.value)} rows={4}
                    placeholder={`e.g.\n1. Grill chicken breast 6 min each side\n2. Toast bun 2 min\n3. Add sauces, lettuce, tomato\n4. Plate immediately`}
                    className="s-input w-full resize-none text-sm" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-black text-s-muted uppercase tracking-wider">طریقہ کار — Steps (اردو)</label>
                  <textarea value={stepsUrdu} onChange={(e) => setStepsUrdu(e.target.value)} rows={4}
                    dir="rtl"
                    placeholder="مثلاً: ۱. چکن گرل کریں ۶ منٹ..."
                    className="s-input w-full resize-none text-sm"
                    style={{ fontFamily: 'sans-serif' }} />
                </div>
              </div>

              {/* Seasonality */}
              <div className="rounded-xl p-4" style={{ background: 'rgba(245,158,11,0.04)', border: '1px solid rgba(245,158,11,0.18)' }}>
                <div className="flex items-baseline justify-between mb-3">
                  <p className="text-xs font-black text-amber-400 uppercase tracking-wider">Seasonality</p>
                  <p className="text-[10px] text-s-muted">Tag the seasons this dish belongs to. Year-round = always available.</p>
                </div>

                <div className="flex flex-wrap gap-1.5 mb-4">
                  {[
                    { key: 'spring',    label: '🌱 Spring' },
                    { key: 'summer',    label: '☀️ Summer' },
                    { key: 'monsoon',   label: '🌧 Monsoon' },
                    { key: 'autumn',    label: '🍂 Autumn' },
                    { key: 'winter',    label: '❄️ Winter' },
                    { key: 'ramadan',   label: '🌙 Ramadan' },
                    { key: 'year-round', label: '⏳ Year-round' },
                  ].map((s) => {
                    const active = seasons.includes(s.key)
                    return (
                      <button key={s.key} type="button"
                        onClick={() => setSeasons((prev) => prev.includes(s.key) ? prev.filter((x) => x !== s.key) : [...prev, s.key])}
                        className={`rounded-full px-3 py-1 text-xs font-bold transition-colors ${
                          active ? 'bg-amber-400 text-black border border-amber-400' : 'border border-s-border text-s-muted hover:text-s-text'
                        }`}>
                        {s.label}
                      </button>
                    )
                  })}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
                  <div>
                    <label className="text-[10px] text-s-muted">Available from (MM-DD)</label>
                    <input value={seasonStart} onChange={(e) => setSeasonStart(e.target.value)}
                      placeholder="04-01" maxLength={5}
                      className="s-input w-full text-sm" />
                  </div>
                  <div>
                    <label className="text-[10px] text-s-muted">Available to (MM-DD)</label>
                    <input value={seasonEnd} onChange={(e) => setSeasonEnd(e.target.value)}
                      placeholder="09-30" maxLength={5}
                      className="s-input w-full text-sm" />
                  </div>
                  <label className="flex items-center gap-2 text-xs text-s-muted cursor-pointer pb-2">
                    <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="accent-s-teal" />
                    <span>Active <span className="text-[10px]">(uncheck to hide off-season)</span></span>
                  </label>
                </div>
              </div>

              {/* Ingredients */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-black text-s-muted uppercase tracking-wider">Ingredients</label>
                  <button type="button" onClick={addIng} className="text-xs text-s-teal hover:underline">+ Add Row</button>
                </div>

                <div className="grid gap-2 px-0.5" style={{ gridTemplateColumns: '1fr 72px 60px 52px 20px' }}>
                  {['Ingredient', 'Recipe Qty', 'Yield %', 'Unit', ''].map((h) => (
                    <p key={h} style={{ fontSize: '8.5px', letterSpacing: '0.12em' }}
                      className="font-black text-s-muted uppercase">{h}</p>
                  ))}
                </div>

                <div className="space-y-1.5">
                  {ings.map((ing, idx) => (
                    <div key={idx} className="grid gap-2 items-center"
                      style={{ gridTemplateColumns: '1fr 72px 60px 52px 20px' }}>
                      <select value={ing.inventoryItemId} onChange={(e) => pickIng(idx, e.target.value)}
                        className="s-select text-xs" required={idx === 0}>
                        <option value="">Select…</option>
                        {invItems?.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.name}{i.unitCostCents ? ` (PKR ${(i.unitCostCents / 100).toFixed(2)}/${i.unit})` : ''}
                          </option>
                        ))}
                      </select>
                      <input type="number" min={0.001} step="any"
                        placeholder="Qty" value={ing.quantity}
                        onChange={(e) => updateIng(idx, 'quantity', e.target.value)}
                        className="s-input text-xs" required={idx === 0} />
                      <div className="relative">
                        <input type="number" min={1} max={100} step={1}
                          value={ing.yieldPct}
                          onChange={(e) => updateIng(idx, 'yieldPct', e.target.value)}
                          className="s-input text-xs w-full pr-5" />
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-s-dim pointer-events-none">
                          %
                        </span>
                      </div>
                      <input type="text" placeholder="g"
                        value={ing.unit}
                        onChange={(e) => updateIng(idx, 'unit', e.target.value)}
                        className="s-input text-xs" required={idx === 0} />
                      <button type="button" onClick={() => removeIng(idx)}
                        disabled={ings.length === 1}
                        className="text-s-dim hover:text-s-red transition-colors disabled:opacity-20 text-center text-xs">
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                {/* Live cost preview */}
                {invItems && ings.some((i) => i.inventoryItemId && i.quantity) && (
                  <div className="rounded-xl bg-s-elevated border border-s-border p-4 mt-1">
                    <p style={{ fontSize: '8.5px', letterSpacing: '0.15em' }}
                      className="font-black text-s-muted uppercase mb-3">
                      Cost Preview (with Q Factor)
                    </p>
                    {(() => {
                      const ingCents = ings.reduce((sum, ing) => {
                        const item = invItems.find((i) => i.id === ing.inventoryItemId)
                        if (!item?.unitCostCents || !ing.quantity) return sum
                        const yp = Math.min(1, Math.max(0.01, (parseFloat(ing.yieldPct) || 100) / 100))
                        return sum + Math.round(item.unitCostCents * (parseFloat(ing.quantity) / yp))
                      }, 0)
                      const qCents    = Math.round(ingCents * Q_FACTOR)
                      const total     = ingCents + qCents
                      const portCents = Math.round(total / (parseInt(servings) || 1))
                      return (
                        <div className="grid grid-cols-4 gap-4 text-xs">
                          {[
                            { label: 'Ingredients',    value: fmtPKR(ingCents), teal: false },
                            { label: 'Q Factor (5%)',  value: fmtPKR(qCents),   teal: false, dim: true },
                            { label: 'Batch Total',    value: fmtPKR(total),     teal: false },
                            { label: 'Per Portion',    value: fmtPKR(portCents), teal: true  },
                          ].map(({ label, value, teal, dim }) => (
                            <div key={label}>
                              <p className="text-s-muted mb-0.5">{label}</p>
                              <p className={`font-bold ${teal ? 'text-s-teal' : dim ? 'text-s-dim' : 'text-s-text'}`}>{value}</p>
                            </div>
                          ))}
                        </div>
                      )
                    })()}
                  </div>
                )}
              </div>

              {formErr && <p className="text-xs text-s-red">{formErr}</p>}

              {/* Step graph editor — only on edit (needs a recipeId). New
                  recipes can add steps right after creation; the modal
                  re-opens automatically into edit mode. */}
              {isEditing && (
                <div className="space-y-2 pt-2 border-t border-s-border">
                  <div>
                    <p className="text-xs font-black text-s-muted uppercase tracking-wider">Kitchen routing</p>
                    <p className="text-[11px] text-s-dim mt-0.5">
                      Break the cook + assembly into ordered steps. Each step picks a station and may depend on earlier steps.
                      Expo confirms an order → the first-ready steps fire to their stations; downstream steps cascade as deps clear.
                    </p>
                  </div>
                  <RecipeStepsEditor recipeId={(modal as Recipe).id} />
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={closeModal} className="s-btn-ghost text-sm">Cancel</button>
                <button type="submit"
                  disabled={createMut.isPending || updateMut.isPending}
                  className="s-btn-primary text-sm">
                  {createMut.isPending || updateMut.isPending ? 'Saving…'
                    : isEditing ? 'Save Changes' : 'Create Recipe'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, bold, teal, dim, className }: {
  label: string; value: string
  bold?: boolean; teal?: boolean; dim?: boolean; className?: string
}) {
  return (
    <div className="text-right">
      <p style={{ fontSize: '9px', letterSpacing: '0.12em' }} className="text-s-muted uppercase">{label}</p>
      <p className={`text-xs ${bold ? 'font-bold' : 'font-semibold'} ${teal ? 'text-s-teal' : dim ? 'text-s-dim' : className ?? 'text-s-text'}`}>
        {value}
      </p>
    </div>
  )
}
