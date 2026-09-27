'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import Link from 'next/link'
import { RecipeStepsEditor } from '../../../components/recipe/RecipeStepsEditor'
import { TenantChip, useMyTenants } from '../../../components/ui/TenantPicker'
import { recipeStatusMeta } from './RecipeForm'
import { usePermissions } from '../../../hooks/useCan'
import { isExecutive } from '../../../lib/appRoles'
import { useBrandFilter } from '../../../store/brandFilter'
import { fmtPkr } from '../../../lib/money'

const Q_FACTOR = 0.05

// (Food-cost % helpers removed — pricing and margin health moved to /menu-engineering.)

interface Concept       { id: string; name: string }
interface MenuItem      { id: string; name: string; priceCents: number; concept: { name: string } }
interface InventoryItem { id: string; name: string; unit: string; unitCostCents: number | null }

interface RecipeIngredient {
  id: string
  // Disjoint: one of (inventoryItemId, prepRecipeId) is non-null. Backend
  // enforces this; the UI picker enforces it at the source.
  inventoryItemId: string | null
  prepRecipeId:    string | null
  quantity: number        // usable recipe qty (post-yield)
  yieldPct: number        // 0–1
  unit: string
  notes: string | null
  inventoryItem: { id: string; name: string; unit: string; unitCostCents: number | null } | null
  prepRecipe?:   { id: string; name: string | null } | null
  purchaseQty: number           // computed by API
  ingredientCostCents: number   // computed by API
}

interface ConceptWithTenant { name: string; tenantId?: string | null; tenant?: { id: string; name: string } | null }

interface Recipe {
  id: string
  kind: 'plate' | 'component'
  status: 'iteration' | 'pending_approval' | 'production'
  menuItemId: string | null
  name:       string | null
  yieldGrams: number | null
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
  qFactorPct: number
  menuItem: { id: string; name: string; priceCents: number; conceptId: string; concept: ConceptWithTenant } | null
  // Testing plates haven't opened their menu item yet — brand lives here.
  pendingMenuItem: { conceptId: string; name: string } | null
  ingredients: RecipeIngredient[]
  ingredientCostCents: number
  qFactorCents: number
  laborCostCents: number
  totalCostCents: number
  // Plate-only:
  costPerPortionCents: number | null
  grossMarginPct: number | null
  foodCostPct: number | null
  // Component-only:
  costPerGramCents: number | null     // sub-cent precision (e.g. 0.85)
  batchCostCents:   number | null
}

// Lightweight option for the prep-recipe picker on ingredient rows.
interface PrepOption {
  id: string
  name: string
  yieldGrams: number | null
  batchCostCents: number
  costPerGramCents: number
}

// Each ingredient row is one of two kinds — raw inventory item OR a prep
// sub-recipe. `source` is the UI discriminator; backend gets either
// inventoryItemId or prepRecipeId set based on it.
interface IngRow {
  source:          'raw' | 'prep'
  inventoryItemId: string
  prepRecipeId:    string
  quantity:        string
  yieldPct:        string
  unit:            string
  notes:           string
}

const BLANK_ING: IngRow = {
  source: 'raw', inventoryItemId: '', prepRecipeId: '',
  quantity: '', yieldPct: '100', unit: '', notes: '',
}

export default function RecipesPage() {
  const qc = useQueryClient()
  const router = useRouter()
  const { data: tenants = [] } = useMyTenants()
  const { data: me } = usePermissions()
  // Executive tier: the CEO and co-owners can both act on approvals. The
  // backend still blocks an owner from approving their OWN submission.
  const isCeo = isExecutive(me?.role)
  const [conceptFilter, setConceptFilter] = useState<string>(() => useBrandFilter.getState().brandId ?? '')
  const [kindFilter,    setKindFilter]    = useState<'' | 'plate' | 'component'>('')
  const [search,        setSearch]        = useState('')
  const [expanded,      setExpanded]      = useState<string | null>(null)
  const [modal,         setModal]         = useState<'create' | Recipe | null>(null)

  // List filters
  const [seasonFilter, setSeasonFilter] = useState<string>('')   // '' = all, 'current' = auto-detect
  const [searchQ,      setSearchQ]      = useState('')
  const [activeOnly,   setActiveOnly]   = useState(false)

  // form
  const [kind,         setKind]         = useState<'plate' | 'component'>('plate')
  const [menuItemId,   setMenuItemId]   = useState('')
  const [prepName,     setPrepName]     = useState('')          // component recipe display name
  const [yieldGramsStr, setYieldGramsStr] = useState('')        // batch yield in grams (component only)
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
  // Component-recipe options for the ingredient picker. Plate recipes can pull
  // any active component; components don't pull other components (no nesting
  // for now — keeps the costing recursion bounded).
  const { data: prepOptions = [] } = useQuery<PrepOption[]>({
    queryKey: ['prep-recipes'],
    queryFn:  () => api.get<PrepOption[]>('/par-sheet/preps?for=recipe'),
    enabled:  modal !== null && kind === 'plate',
  })

  const createMut = useMutation({
    mutationFn: (body: unknown) => api.post<Recipe>('/recipes', body),
    // Re-open in edit mode after create so the operator can immediately
    // add bump-steps (the structured editor needs a recipeId, so it can't
    // mount during the initial create). The placeholder in the create
    // form points users at this flow; if you change one, change both.
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['recipes'] })
      if (created && typeof created === 'object' && 'id' in created) {
        setModal(created as Recipe)
      } else {
        closeModal()
      }
    },
    onError: (e: Error) => setFormErr(e.message),
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
  // Submit a testing (iteration) recipe for CEO sign-off — moves it to
  // pending_approval so it appears in /accounting/recipes/approvals. Saves the
  // operator from opening the editor just to hit "Submit for production".
  const submitMut = useMutation({
    mutationFn: (id: string) => api.post(`/recipes/${id}/submit`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recipes'] }),
    onError: (e: Error) => alert(e.message),
  })

  function openCreate() {
    setKind('plate')
    setMenuItemId(''); setPrepName(''); setYieldGramsStr('')
    setServings('1'); setPortionSizeG(''); setLaborMins('0')
    setNotes(''); setSteps(''); setStepsUrdu('')
    setSeasons([]); setSeasonStart(''); setSeasonEnd(''); setIsActive(true)
    setIngs([{ ...BLANK_ING }]); setFormErr(''); setModal('create')
  }
  function openEdit(r: Recipe) {
    // Edit now uses the dedicated pricing-spec page at /accounting/recipes/[id]
    // instead of the legacy modal. The form mirrors the create flow so the
    // operator gets the same live cost panel + verdict badge while editing.
    router.push(`/accounting/recipes/${r.id}`)
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
  function pickPrep(idx: number, prepId: string) {
    // Components are always measured in grams (that's how a component is
    // costed) — auto-fill the unit so the operator doesn't have to.
    setIngs((p) => p.map((row, i) =>
      i === idx ? { ...row, prepRecipeId: prepId, unit: row.unit || 'g' } : row
    ))
  }
  function toggleIngSource(idx: number, source: 'raw' | 'prep') {
    setIngs((p) => p.map((row, i) =>
      i === idx ? { ...row, source, inventoryItemId: '', prepRecipeId: '', unit: source === 'prep' ? 'g' : '' } : row
    ))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setFormErr('')

    // Kind-specific required-field check happens before we filter ingredient
    // rows so the operator sees the right error instead of "no ingredients".
    if (kind === 'plate' && !menuItemId) {
      setFormErr('Pick a menu item this plate recipe belongs to'); return
    }
    if (kind === 'component') {
      if (!prepName.trim()) { setFormErr('Give this component recipe a name (e.g. "Garlic mayo")'); return }
      if (!yieldGramsStr || parseFloat(yieldGramsStr) <= 0) {
        setFormErr('Set the batch yield in grams — drives cost-per-gram'); return
      }
    }

    const valid = ings.filter((i) =>
      (i.source === 'raw'  && i.inventoryItemId && i.quantity) ||
      (i.source === 'prep' && i.prepRecipeId    && i.quantity),
    )
    if (!valid.length) { setFormErr('Add at least one ingredient'); return }

    const body = {
      kind,
      ...(kind === 'plate' ? { menuItemId } : { name: prepName.trim(), yieldGrams: parseFloat(yieldGramsStr) }),
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
        ...(i.source === 'raw'
          ? { inventoryItemId: i.inventoryItemId }
          : { prepRecipeId: i.prepRecipeId }),
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
    if (kindFilter && r.kind !== kindFilter) return false
    if (conceptFilter) {
      // Components are cross-concept by design (one caramel serves every
      // brand) — keep them visible under a brand filter rather than blanking
      // the list. Plates match on their brand: a live plate carries it on the
      // menu item; a TESTING plate hasn't opened its item yet, so its brand
      // lives in pendingMenuItem.
      if (r.kind === 'plate') {
        const brandId = r.menuItem?.conceptId ?? r.pendingMenuItem?.conceptId ?? null
        if (brandId !== conceptFilter) return false
      }
    }
    if (search) {
      // Search across menuItem name (plate) AND recipe name (component) so the
      // operator can find either kind from one box.
      const hay = (r.menuItem?.name ?? r.name ?? '').toLowerCase()
      if (!hay.includes(search.toLowerCase())) return false
    }
    return true
  })
  const isEditing = typeof modal === 'object' && modal !== null && 'id' in modal

  // summary stats — pure cost (pricing/margins live in Menu Engineering)
  const plateCount     = (recipes ?? []).filter((r) => r.kind === 'plate').length
  const componentCount = (recipes ?? []).filter((r) => r.kind === 'component').length

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
            {isCeo && (
              <Link href="/accounting/recipes/approvals" className="text-xs text-s-teal hover:underline">Approvals</Link>
            )}
            <Link href="/accounting/recipes/new" className="s-btn-primary text-xs px-3 py-1.5">+ New Recipe</Link>
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

      <div className="p-6 space-y-4 max-w-7xl mx-auto">

        {/* Summary strip */}
        {(recipes?.length ?? 0) > 0 && (
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: 'Total Recipes', value: String(recipes!.length),  color: 'text-s-text' },
              { label: 'Plates',        value: String(plateCount),       color: 'text-s-teal' },
              { label: 'Components',    value: String(componentCount),   color: 'text-s-text' },
              { label: 'Q Factor Rate', value: 'per recipe',             color: 'text-s-muted' },
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
          {/* Kind filter — plates vs components, next to the brand filter. */}
          <div className="flex rounded-lg overflow-hidden text-xs font-bold border border-s-border">
            {([
              { key: '',          label: 'All' },
              { key: 'plate',     label: '🍽 Plates' },
              { key: 'component', label: '🧩 Components' },
            ] as const).map((k) => (
              <button key={k.key || 'all'} type="button"
                onClick={() => setKindFilter(k.key)}
                className={`px-2.5 py-1.5 transition-colors border-r border-s-border last:border-r-0 ${
                  kindFilter === k.key ? 'bg-s-teal text-black' : 'text-s-muted hover:text-s-text'
                }`}>
                {k.label}
              </button>
            ))}
          </div>
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
                      <div className="flex items-center gap-2 flex-wrap">
                        {/* Kind badge — quick visual differentiation between
                            plate vs component recipes in the mixed list. */}
                        {r.kind === 'component' ? (
                          <span className="text-[9px] font-black uppercase tracking-wider rounded-full px-2 py-0.5"
                            style={{ background: 'rgba(99,102,241,0.15)', color: '#A5B4FC', border: '1px solid rgba(99,102,241,0.3)' }}>
                            🧩 Component
                          </span>
                        ) : (
                          <span className="text-[9px] font-black uppercase tracking-wider rounded-full px-2 py-0.5"
                            style={{ background: 'rgba(0,212,177,0.12)', color: '#5EEAD4', border: '1px solid rgba(0,212,177,0.3)' }}>
                            🍽 Plate
                          </span>
                        )}
                        {/* Lifecycle status — only call out non-live recipes so
                            the list isn't littered with "Live" on everything. */}
                        {r.status !== 'production' && (
                          <span className="text-[9px] font-black uppercase tracking-wider rounded-full px-2 py-0.5"
                            style={{ background: recipeStatusMeta[r.status].bg, color: recipeStatusMeta[r.status].color }}>
                            {recipeStatusMeta[r.status].label}
                          </span>
                        )}
                        <p className="font-semibold text-s-text text-sm truncate">
                          {r.menuItem?.name ?? r.name ?? '—'}
                        </p>
                        {r.menuItem && (
                          <TenantChip tenant={r.menuItem.concept.tenant} tenantId={r.menuItem.concept.tenantId} tenants={tenants} />
                        )}
                      </div>
                      <p className="text-[10px] text-s-dim">
                        {r.kind === 'plate' ? (
                          <>
                            {r.menuItem?.concept.name}
                            {r.servings > 1 && ` · ${r.servings} portions`}
                            {r.portionSizeG  && ` · ${r.portionSizeG}g each`}
                            {recipeWeightG   && ` · ${recipeWeightG.toFixed(0)}g batch`}
                          </>
                        ) : (
                          <>
                            Component · batch yield {r.yieldGrams ? `${r.yieldGrams}g` : '—'}
                          </>
                        )}
                      </p>
                    </div>

                    <div className="flex items-center gap-5 shrink-0">
                      <Metric label="Ing. Cost"    value={fmtPkr(r.ingredientCostCents)} />
                      <Metric label="Q Factor"     value={fmtPkr(r.qFactorCents)}        dim />
                      <Metric label="Total Cost"   value={fmtPkr(r.totalCostCents)}       bold />
                      {/* The headline number — different per kind. Plate: the
                          per-portion cost. Component: cost per gram (drives
                          downstream plate costing). Margins live in Menu Engineering. */}
                      {r.kind === 'plate' ? (
                        <Metric label="Plate Cost"   value={fmtPkr(r.costPerPortionCents ?? 0)} teal />
                      ) : (
                        <Metric
                          label="Cost / Gram"
                          value={r.costPerGramCents != null ? `PKR ${(r.costPerGramCents / 100).toFixed(3)}/g` : '—'}
                          teal />
                      )}
                      <div className="flex gap-1 ml-1" onClick={(e) => e.stopPropagation()}>
                        {/* Testing recipes can be pushed straight to the CEO's
                            approval inbox from here — no need to open the editor. */}
                        {r.status === 'iteration' && (
                          <button onClick={() => submitMut.mutate(r.id)} disabled={submitMut.isPending}
                            className="text-xs px-2 py-1 rounded font-bold text-black bg-s-teal hover:opacity-90 disabled:opacity-50 transition-opacity"
                            title="Submit this testing recipe for CEO approval">
                            Submit
                          </button>
                        )}
                        <button onClick={() => openEdit(r)}
                          className="text-xs px-2 py-1 rounded text-s-muted hover:text-s-teal hover:bg-s-teal-dim transition-colors">
                          Edit
                        </button>
                        <button
                          onClick={() => {
                            const label = r.menuItem?.name ?? r.name ?? 'this recipe'
                            if (confirm(`Delete recipe for "${label}"?`)) deleteMut.mutate(r.id)
                          }}
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
                          // For plate recipes the "PORTIONS" + "PORTION COST"
                          // headers make sense. For prep we swap them out for
                          // batch yield + cost-per-gram so the spreadsheet
                          // strip reflects the kind. Total recipe cost and
                          // Q-factor stay relevant for both.
                          { label: 'RECIPE WEIGHT',     value: recipeWeightG ? `${recipeWeightG.toFixed(0)}g` : '—' },
                          ...(r.kind === 'plate'
                            ? [
                                { label: 'PORTION SIZE', value: r.portionSizeG ? `${r.portionSizeG}g` : '—' },
                                { label: 'PORTIONS',     value: String(r.servings)                          },
                              ]
                            : [
                                { label: 'BATCH YIELD',  value: r.yieldGrams ? `${r.yieldGrams}g` : '—' },
                              ]),
                          { label: `Q FACTOR (${r.qFactorPct ?? 10}%)`, value: fmtPkr(r.qFactorCents)                },
                          { label: 'TOTAL RECIPE COST', value: fmtPkr(r.totalCostCents)                              },
                          ...(r.kind === 'plate'
                            ? [{ label: 'PLATE COST',     value: fmtPkr(r.costPerPortionCents ?? 0) }]
                            : [{ label: 'COST / GRAM',    value: r.costPerGramCents != null ? `PKR ${(r.costPerGramCents / 100).toFixed(3)}/g` : '—' }]),
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
                              // Rows can be raw or a component sub-recipe — pick
                              // the right source object so we can show a meaningful
                              // name and unit-cost in either case.
                              const isPrep       = !!ing.prepRecipe
                              const sourceName   = ing.inventoryItem?.name ?? ing.prepRecipe?.name ?? '—'
                              const costPerUnit  = ((isPrep
                                ? (ing.ingredientCostCents / Math.max(1, ing.quantity))
                                : (ing.inventoryItem?.unitCostCents ?? 0))) / 100
                              const purchaseQty  = ing.purchaseQty
                              const usableQty    = purchaseQty * ing.yieldPct
                              const yieldWarn    = !isPrep && ing.yieldPct < 0.80

                              return (
                                <tr key={ing.id}
                                  style={{ borderTop: idx > 0 ? '1px solid rgba(255,255,255,0.04)' : undefined }}>
                                  <td className="px-4 py-2.5 font-semibold" style={{ color: 'rgba(255,255,255,0.8)' }}>
                                    {isPrep && <span className="mr-1 text-[9px] text-indigo-300">🧩</span>}
                                    {sourceName}
                                  </td>
                                  <td className="px-4 py-2.5 text-s-muted">
                                    {purchaseQty.toLocaleString('en', { maximumFractionDigits: 3 })} {ing.unit}
                                  </td>
                                  <td className="px-4 py-2.5 text-s-muted">
                                    PKR {(costPerUnit * purchaseQty).toFixed(2)}
                                  </td>
                                  <td className="px-4 py-2.5">
                                    {isPrep ? (
                                      <span className="text-s-dim italic text-[10px]">n/a</span>
                                    ) : (
                                      <span className={yieldWarn ? 'text-s-amber font-semibold' : 'text-s-muted'}>
                                        {(ing.yieldPct * 100).toFixed(0)}%
                                      </span>
                                    )}
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
                                {fmtPkr(r.ingredientCostCents)}
                              </td>
                            </tr>
                            <tr style={{ borderTop: '1px solid rgba(255,255,255,0.04)', background: 'rgba(255,255,255,0.01)' }}>
                              <td colSpan={7} className="px-4 py-1.5 text-right text-s-muted" style={{ fontSize: '10px' }}>
                                Q Factor — {r.qFactorPct ?? 10}% misc. (salt, oil, unmeasured items)
                              </td>
                              <td className="px-4 py-1.5 text-s-muted text-xs">{fmtPkr(r.qFactorCents)}</td>
                            </tr>
                            {r.laborCostCents > 0 && (
                              <tr style={{ borderTop: '1px solid rgba(255,255,255,0.04)', background: 'rgba(255,255,255,0.01)' }}>
                                <td colSpan={7} className="px-4 py-1.5 text-right text-s-muted" style={{ fontSize: '10px' }}>
                                  Labor — {r.laborMinutes} min @ PKR 50/hr
                                </td>
                                <td className="px-4 py-1.5 text-s-muted text-xs">{fmtPkr(r.laborCostCents)}</td>
                              </tr>
                            )}
                            <tr style={{ borderTop: '2px solid rgba(0,212,177,0.2)', background: 'rgba(0,212,177,0.04)' }}>
                              <td colSpan={7} className="px-4 py-3 text-right font-black uppercase text-s-teal"
                                style={{ fontSize: '8.5px', letterSpacing: '0.15em' }}>
                                Total Recipe Cost
                              </td>
                              <td className="px-4 py-3 font-black text-s-teal">{fmtPkr(r.totalCostCents)}</td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>

                      {/* Bottom metrics bar — pure cost. Pricing + margins for
                          plates moved to the Menu Engineering page. */}
                      <div className="px-5 py-3 flex flex-wrap items-center gap-6 border-t border-s-border/40"
                        style={{ background: 'rgba(255,255,255,0.01)' }}>
                        {r.kind === 'plate' ? (
                          <>
                            <span className="text-xs">
                              <span className="text-s-muted">Plate cost: </span>
                              <span className="font-bold text-s-text">{fmtPkr(r.costPerPortionCents ?? 0)}</span>
                            </span>
                            <span className="text-xs ml-auto text-s-dim italic">
                              Selling price &amp; margins live in{' '}
                              <Link href="/menu-engineering" className="text-s-teal hover:underline not-italic" onClick={(e) => e.stopPropagation()}>
                                Menu Engineering
                              </Link>.
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="text-xs">
                              <span className="text-s-muted">Batch cost: </span>
                              <span className="font-bold text-s-text">{fmtPkr(r.batchCostCents ?? r.totalCostCents)}</span>
                            </span>
                            <span className="text-xs">
                              <span className="text-s-muted">Batch yield: </span>
                              <span className="font-bold text-s-text">{r.yieldGrams ? `${r.yieldGrams}g` : '—'}</span>
                            </span>
                            <span className="text-xs">
                              <span className="text-s-muted">Cost per gram: </span>
                              <span className="font-bold text-s-teal">
                                {r.costPerGramCents != null ? `PKR ${(r.costPerGramCents / 100).toFixed(3)}/g` : '—'}
                              </span>
                            </span>
                            <span className="text-xs ml-auto text-s-dim italic">
                              Use this prep as an ingredient in plate recipes — cost-per-gram flows into plate cost automatically.
                            </span>
                          </>
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

              {/* Recipe kind toggle — drives every conditional below. Plate
                  recipes get a menu-item picker + portion math; prep recipes
                  get a name + yieldGrams + cost-per-gram preview. Kind is
                  fixed once a recipe is saved (changing it would orphan the
                  menu-item link or break downstream consumers). */}
              {!isEditing ? (
                <div className="space-y-1.5">
                  <label className="text-xs font-black text-s-muted uppercase tracking-wider">Recipe type</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => setKind('plate')}
                      className="rounded-lg px-3 py-3 text-left transition-colors"
                      style={kind === 'plate'
                        ? { background: 'rgba(0,212,177,0.10)', border: '1px solid rgba(0,212,177,0.4)' }
                        : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                      <p className="text-sm font-bold text-s-text">🍽 Finished plate</p>
                      <p className="text-[10px] text-s-dim mt-0.5">A menu item — costed as plate cost (margin vs. menu price).</p>
                    </button>
                    <button type="button" onClick={() => setKind('component')}
                      className="rounded-lg px-3 py-3 text-left transition-colors"
                      style={kind === 'component'
                        ? { background: 'rgba(99,102,241,0.10)', border: '1px solid rgba(99,102,241,0.4)' }
                        : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                      <p className="text-sm font-bold text-s-text">🧩 Component</p>
                      <p className="text-[10px] text-s-dim mt-0.5">A batch sub-recipe (sauce, marinade, dough) used inside plates — costed per gram.</p>
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-[11px] text-s-dim">
                  {kind === 'plate' ? '🍽 Plate recipe (linked to a menu item)' : '🧩 Component (cost-per-gram sub-recipe)'}
                </p>
              )}

              {kind === 'plate' ? (
                /* Plate: menu-item picker */
                <div className="space-y-1.5">
                  <label className="text-xs font-black text-s-muted uppercase tracking-wider">Menu Item</label>
                  {isEditing ? (
                    <p className="text-sm font-semibold text-s-text">{(modal as Recipe).menuItem?.name ?? '—'}</p>
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
              ) : (
                /* Component: name + yield in grams */
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-black text-s-muted uppercase tracking-wider">Component name</label>
                    <input value={prepName} onChange={(e) => setPrepName(e.target.value)}
                      required placeholder="e.g. Garlic mayo, Tandoori marinade"
                      className="s-input w-full" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-black text-s-muted uppercase tracking-wider">Batch yield (grams)</label>
                    <input type="number" min={0.001} step="any" value={yieldGramsStr}
                      onChange={(e) => setYieldGramsStr(e.target.value)}
                      required placeholder="e.g. 2000"
                      className="s-input w-full" />
                    <p className="text-[10px] text-s-dim">Total grams produced by one batch — divides batch cost into cost-per-gram.</p>
                  </div>
                </div>
              )}

              {/* Portions / size / labor — only meaningful on plate recipes.
                  Component recipes care about batch yield (above), not portions. */}
              {kind === 'plate' && (
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
              )}
              {kind === 'component' && (
                <div className="space-y-1.5">
                  <label className="text-xs font-black text-s-muted uppercase tracking-wider">Labor (min per batch)</label>
                  <input type="number" min={0} value={laborMins}
                    onChange={(e) => setLaborMins(e.target.value)}
                    className="s-input w-full max-w-[8rem]" />
                </div>
              )}

              {/* Notes */}
              <div className="space-y-1.5">
                <label className="text-xs font-black text-s-muted uppercase tracking-wider">Notes (internal)</label>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
                  placeholder="Preparation notes for managers…" className="s-input w-full resize-none" />
              </div>

              {/* Cook's-notes free-text — fallback method shown on the
                  KDS card when no structured bump-steps exist below. This
                  is NOT the same as bump-able routing — see the "Bump-able
                  steps (during service)" section further down for that. */}
              <div className="space-y-3 border border-s-border rounded-xl p-4"
                style={{ background: 'rgba(0,212,177,0.03)' }}>
                <div>
                  <p className="text-xs font-black text-s-teal uppercase tracking-wider mb-0.5">
                    Cook's notes (method)
                  </p>
                  <p className="text-[10px] text-s-dim">
                    Free-text recipe shown on the KDS card when a cook taps for instructions.
                    Used as a fallback when no structured bump-steps are configured below.
                    <span className="text-s-dim/70"> Not bump-able — for the cascade routing, use the section at the bottom.</span>
                  </p>
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

                {/* Each row now has a Raw/Component source toggle on the left.
                    Raw uses the inventory picker; Component uses the component-
                    recipe picker. Components are only relevant on plate
                    recipes — we hide the toggle for component-on-component nesting. */}
                <div className="grid gap-2 px-0.5" style={{ gridTemplateColumns: '60px 1fr 72px 60px 52px 20px' }}>
                  {['Source', 'Ingredient', 'Recipe Qty', 'Yield %', 'Unit', ''].map((h) => (
                    <p key={h} style={{ fontSize: '8.5px', letterSpacing: '0.12em' }}
                      className="font-black text-s-muted uppercase">{h}</p>
                  ))}
                </div>

                <div className="space-y-1.5">
                  {ings.map((ing, idx) => (
                    <div key={idx} className="grid gap-2 items-center"
                      style={{ gridTemplateColumns: '60px 1fr 72px 60px 52px 20px' }}>
                      {/* Source toggle — Raw ingredient vs Component recipe. Only
                          shown on plate recipes (components can't compose other
                          components to keep costing recursion bounded). */}
                      {kind === 'plate' ? (
                        <select value={ing.source}
                          onChange={(e) => toggleIngSource(idx, e.target.value as 'raw' | 'prep')}
                          className="s-select text-[10px]"
                          title="Raw inventory item, or a component recipe used as a sub-ingredient">
                          <option value="raw">Raw</option>
                          <option value="prep">Component</option>
                        </select>
                      ) : (
                        <span className="text-[10px] text-s-dim font-semibold px-2 py-1.5">Raw</span>
                      )}

                      {ing.source === 'prep' ? (
                        <select value={ing.prepRecipeId} onChange={(e) => pickPrep(idx, e.target.value)}
                          className="s-select text-xs" required={idx === 0}>
                          <option value="">Select component…</option>
                          {prepOptions.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} (PKR {(p.costPerGramCents / 100).toFixed(2)}/g)
                            </option>
                          ))}
                        </select>
                      ) : (
                        <select value={ing.inventoryItemId} onChange={(e) => pickIng(idx, e.target.value)}
                          className="s-select text-xs" required={idx === 0}>
                          <option value="">Select…</option>
                          {invItems?.map((i) => (
                            <option key={i.id} value={i.id}>
                              {i.name}{i.unitCostCents ? ` (PKR ${(i.unitCostCents / 100).toFixed(2)}/${i.unit})` : ''}
                            </option>
                          ))}
                        </select>
                      )}
                      <input type="number" min={0.001} step="any"
                        placeholder={ing.source === 'prep' ? 'g' : 'Qty'} value={ing.quantity}
                        onChange={(e) => updateIng(idx, 'quantity', e.target.value)}
                        className="s-input text-xs" required={idx === 0} />
                      <div className="relative">
                        <input type="number" min={1} max={100} step={1}
                          value={ing.yieldPct}
                          onChange={(e) => updateIng(idx, 'yieldPct', e.target.value)}
                          disabled={ing.source === 'prep'}
                          title={ing.source === 'prep' ? 'N/A — component yield already baked into cost-per-gram' : ''}
                          className="s-input text-xs w-full pr-5 disabled:opacity-40" />
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-s-dim pointer-events-none">
                          %
                        </span>
                      </div>
                      <input type="text" placeholder={ing.source === 'prep' ? 'g' : 'g'}
                        value={ing.unit}
                        onChange={(e) => updateIng(idx, 'unit', e.target.value)}
                        disabled={ing.source === 'prep'}
                        className="s-input text-xs disabled:opacity-40" required={idx === 0} />
                      <button type="button" onClick={() => removeIng(idx)}
                        disabled={ings.length === 1}
                        className="text-s-dim hover:text-s-red transition-colors disabled:opacity-20 text-center text-xs">
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                {/* Live cost preview */}
                {invItems && ings.some((i) => ((i.inventoryItemId || i.prepRecipeId) && i.quantity)) && (
                  <div className="rounded-xl bg-s-elevated border border-s-border p-4 mt-1">
                    <p style={{ fontSize: '8.5px', letterSpacing: '0.15em' }}
                      className="font-black text-s-muted uppercase mb-3">
                      Cost Preview (with Q Factor)
                    </p>
                    {(() => {
                      const ingCents = ings.reduce((sum, ing) => {
                        if (!ing.quantity) return sum
                        const qty = parseFloat(ing.quantity)
                        if (ing.source === 'prep') {
                          // Component sub-recipe — cost flows in at per-gram × quantity.
                          const prep = prepOptions.find((p) => p.id === ing.prepRecipeId)
                          if (!prep) return sum
                          return sum + Math.round(prep.costPerGramCents * qty)
                        }
                        const item = invItems.find((i) => i.id === ing.inventoryItemId)
                        if (!item?.unitCostCents) return sum
                        const yp = Math.min(1, Math.max(0.01, (parseFloat(ing.yieldPct) || 100) / 100))
                        return sum + Math.round(item.unitCostCents * (qty / yp))
                      }, 0)
                      const qCents      = Math.round(ingCents * Q_FACTOR)
                      const laborCents  = Math.round(((parseInt(laborMins) || 0) / 60) * 50_00)
                      const total       = ingCents + qCents + laborCents
                      // Per-kind headline preview. Plate → per-portion;
                      // component → cost-per-gram (sub-cent precision matters).
                      const portCents     = kind === 'plate' ? Math.round(total / (parseInt(servings) || 1)) : 0
                      const yieldG        = parseFloat(yieldGramsStr) || 0
                      const costPerGramP  = kind === 'component' && yieldG > 0 ? (total / yieldG) / 100 : null
                      return (
                        <div className="grid grid-cols-4 gap-4 text-xs">
                          <div>
                            <p className="text-s-muted mb-0.5">Ingredients</p>
                            <p className="font-bold text-s-text">{fmtPkr(ingCents)}</p>
                          </div>
                          <div>
                            <p className="text-s-muted mb-0.5">Q Factor (5%)</p>
                            <p className="font-bold text-s-dim">{fmtPkr(qCents)}</p>
                          </div>
                          <div>
                            <p className="text-s-muted mb-0.5">Batch Total</p>
                            <p className="font-bold text-s-text">{fmtPkr(total)}</p>
                          </div>
                          {kind === 'plate' ? (
                            <div>
                              <p className="text-s-muted mb-0.5">Plate cost</p>
                              <p className="font-bold text-s-teal">{fmtPkr(portCents)}</p>
                            </div>
                          ) : (
                            <div>
                              <p className="text-s-muted mb-0.5">Cost per gram</p>
                              <p className="font-bold text-s-teal">
                                {costPerGramP !== null ? `PKR ${costPerGramP.toFixed(3)}/g` : '—'}
                              </p>
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                )}
              </div>

              {formErr && <p className="text-xs text-s-red">{formErr}</p>}

              {/* Bump-able step graph — the structured editor needs a
                  recipeId, so for NEW recipes we show a placeholder telling
                  the operator to save first. On edit, the full editor
                  mounts and the operator can build the per-station cascade
                  that drives KDS bumping during service. */}
              <div className="space-y-2 pt-2 border-t border-s-border">
                <div>
                  <p className="text-xs font-black uppercase tracking-wider" style={{ color: '#A5B4FC' }}>
                    🍳 Bump-able steps (during service)
                  </p>
                  <p className="text-[11px] text-s-dim mt-0.5">
                    Break the cook + assembly into ordered steps. Each step picks a station and may depend on earlier steps.
                    Expo confirms an order → first-ready steps fire to their stations →
                    each cook bumps when done → downstream steps cascade. This is what powers the per-station KDS bump flow.
                  </p>
                </div>
                {isEditing ? (
                  <RecipeStepsEditor recipeId={(modal as Recipe).id} />
                ) : (
                  <div className="rounded-lg p-4 text-center"
                    style={{ background: 'rgba(99,102,241,0.05)', border: '1px dashed rgba(99,102,241,0.25)' }}>
                    <p className="text-xs font-bold text-white/70">
                      Save the recipe first to add bump-able steps
                    </p>
                    <p className="text-[10px] text-s-dim mt-1">
                      The step graph attaches to a saved recipe. Click <strong>Create Recipe</strong> below — the modal will
                      re-open in edit mode and this section will become an editor where you add per-station bump-steps.
                    </p>
                  </div>
                )}
              </div>

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
