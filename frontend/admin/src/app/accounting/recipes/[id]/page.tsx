'use client'
import { Button } from '@/components/finance/ui'
import { useQuery } from '@tanstack/react-query'
import { useParams, useRouter } from 'next/navigation'
import { api } from '../../../../lib/api'
import { RecipeForm, McBreakdown, CostWarningBanners, type RecipeFormInitial, type McFields, type CostWarnings } from '../RecipeForm'
import { KitchenRecipeView } from '../KitchenRecipe'
import { useKitchenView } from '../../../inventory/kitchenView'
import { fmtPkrWhole } from '../../../../lib/money'

interface ExistingRecipe {
  id: string
  kind: 'plate' | 'component' | 'modifier'
  status: 'iteration' | 'pending_approval' | 'production'
  rejectionReason: string | null
  pendingMenuItem: { conceptId: string; categoryId: string; name: string; description: string | null } | null
  name: string | null
  menuItemId: string | null
  modifierId: string | null
  servings: number
  yieldGrams: number | null
  yieldUnit?: 'g' | 'ml' | 'pcs'
  portionsPerBatch?: number | null
  portionLabel?: string | null
  portionSizeG: number | null
  category: string | null
  photoUrl: string | null
  steps: string | null
  stepsUrdu: string | null
  notes: string | null
  methodSteps: Array<{ station: string; instruction: string }> | null
  // Null for a kitchen floor role (costsHidden) — the read-only view never
  // reads them; the form only mounts for a role that gets them.
  qFactorPct: number
  targetProfitPct: number
  actualSellingPriceCents: number | null
  menuItem: { conceptId: string | null; name?: string; concept?: { name: string; serviceVessel?: string } | null } | null
  // kind 'modifier': the add-on, its group and dish.
  modifier: { id: string; name: string; groupId: string; group: { name: string; menuItemId: string; menuItem: { name: string; conceptId: string } } } | null
  ingredients: Array<{
    id: string
    inventoryItemId: string | null
    prepRecipeId: string | null
    quantity: number
    yieldPct: number | null
    notes: string | null
    section?: string | null
    inventoryItem: { name: string; unit: string } | null
  }>
  /** Set by the API for the kitchen floor (boh, kitchen, expediter). */
  costsHidden?: boolean
}

// GET /recipes/:id/costing — the recipe AS SAVED: what every sale is costed
// and taken from stock with today.
interface SavedCosting extends McFields {
  warnings: CostWarnings
  recipe: { serviceVessel: string | null }
  brand: { name: string } | null
  /** At servd's 90-day average ingredient prices (owner, 2026-10-29). */
  cost?: { avgStandardCents?: number }
}

export default function EditRecipePage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { data, isLoading, isError } = useQuery<ExistingRecipe>({
    queryKey: ['recipe', id],
    queryFn: () => api.get(`/recipes/${id}`),
  })
  // The line cook reads the recipe book but edits, costs and prices nothing
  // (the form's writes, test log and costing are managers only): read-only.
  const kitchenView = useKitchenView(data ? [data] : undefined)
  const { data: saved } = useQuery<SavedCosting>({
    queryKey: ['recipes', 'costing', id],
    queryFn: () => api.get(`/recipes/${id}/costing`),
    enabled: !!data && !data.costsHidden && !kitchenView && data.kind !== 'component',
  })

  if (isLoading) {
    return <div className="p-12 text-center text-sm text-s-muted">Loading recipe…</div>
  }
  if (isError || !data) {
    return (
      <div className="p-12 text-center">
        <p className="text-sm text-s-muted">Couldn't load that recipe.</p>
        <Button size="sm" type="submit" onClick={() => router.push('/accounting/recipes')}
          className="mt-3">Back to list</Button>
      </div>
    )
  }

  if (kitchenView) return <KitchenRecipeView recipe={data} />

  const initial: RecipeFormInitial = {
    id: data.id,
    kind: data.kind,
    status: data.status,
    rejectionReason: data.rejectionReason,
    name: data.name,
    menuItemId: data.menuItemId,
    servings: data.servings,
    yieldGrams: data.yieldGrams,
    yieldUnit: data.yieldUnit,
    portionsPerBatch: data.portionsPerBatch ?? null,
    portionLabel: data.portionLabel ?? null,
    category: (data.category as RecipeFormInitial['category']) ?? null,
    photoUrl: data.photoUrl,
    steps: data.steps,
    methodSteps: data.methodSteps,
    qFactorPct: data.qFactorPct,
    targetProfitPct: data.targetProfitPct,
    actualSellingPriceCents: data.actualSellingPriceCents,
    // Live plates get their brand from the menu item; a testing plate that
    // hasn't opened its item yet carries it in pendingMenuItem; an add-on
    // from its dish.
    brandId: data.menuItem?.conceptId ?? data.pendingMenuItem?.conceptId ?? data.modifier?.group.menuItem.conceptId ?? null,
    pendingMenuItem: data.pendingMenuItem,
    modifierId: data.modifierId,
    modifierPath: data.modifier
      ? { menuItemId: data.modifier.group.menuItemId, groupId: data.modifier.groupId, label: `${data.modifier.group.menuItem.name} — ${data.modifier.group.name} — ${data.modifier.name}` }
      : null,
    ingredients: data.ingredients,
  }

  return (
    <>
      {saved && (
        <div className="bg-s-bg">
          <section className="max-w-6xl mx-auto px-4 sm:px-6 pt-6">
            <div className="rounded-xl border border-s-border bg-s-surface p-4 space-y-3">
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-success">As saved</p>
                  <h2 className="text-base font-black">What every sale is costed with today</h2>
                </div>
                <p className="text-xs text-s-muted">
                  {data.kind === 'modifier' ? 'Per add-on' : 'Plate MC'}:{' '}
                  <span className="font-mono font-black text-s-text">{fmtPkrWhole(saved.standardCents)}</span>
                  {saved.cost?.avgStandardCents != null && (
                    <span className="ml-2">· 90-day average <span className="font-mono font-bold text-s-text">{fmtPkrWhole(saved.cost.avgStandardCents)}</span></span>
                  )}
                  {saved.recipe.serviceVessel === 'packaging' && <span className="ml-2 s-badge-purple">Serves in packaging</span>}
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <McBreakdown mc={saved} kind={data.kind} />
                <CostWarningBanners warnings={saved.warnings} brandName={saved.brand?.name} />
              </div>
            </div>
          </section>
        </div>
      )}
      <RecipeForm initial={initial} />
    </>
  )
}
