'use client'
import { useQuery } from '@tanstack/react-query'
import { useParams, useRouter } from 'next/navigation'
import { api } from '../../../../lib/api'
import { RecipeForm, type RecipeFormInitial } from '../RecipeForm'
import { KitchenRecipeView } from '../KitchenRecipe'
import { useKitchenView } from '../../../inventory/kitchenView'

interface ExistingRecipe {
  id: string
  kind: 'plate' | 'component'
  status: 'iteration' | 'pending_approval' | 'production'
  rejectionReason: string | null
  pendingMenuItem: { conceptId: string; categoryId: string; name: string; description: string | null } | null
  name: string | null
  menuItemId: string | null
  servings: number
  yieldGrams: number | null
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
  packagingPct: number
  actualSellingPriceCents: number | null
  menuItem: { conceptId: string | null; name?: string; concept?: { name: string } | null } | null
  ingredients: Array<{
    id: string
    inventoryItemId: string | null
    prepRecipeId: string | null
    quantity: number
    yieldPct: number | null
    notes: string | null
    inventoryItem: { name: string; unit: string } | null
  }>
  /** Set by the API for the kitchen floor (boh, kitchen, expediter). */
  costsHidden?: boolean
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

  if (isLoading) {
    return <div className="p-12 text-center text-sm text-s-muted">Loading recipe…</div>
  }
  if (isError || !data) {
    return (
      <div className="p-12 text-center">
        <p className="text-sm text-s-muted">Couldn't load that recipe.</p>
        <button onClick={() => router.push('/accounting/recipes')}
          className="mt-3 rounded-lg bg-primary text-primary-on px-4 py-2 text-xs font-black">Back to list</button>
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
    category: (data.category as RecipeFormInitial['category']) ?? null,
    photoUrl: data.photoUrl,
    steps: data.steps,
    methodSteps: data.methodSteps,
    qFactorPct: data.qFactorPct,
    targetProfitPct: data.targetProfitPct,
    packagingPct: data.packagingPct,
    actualSellingPriceCents: data.actualSellingPriceCents,
    // Live plates get their brand from the menu item; a testing plate that
    // hasn't opened its item yet carries it in pendingMenuItem.
    brandId: data.menuItem?.conceptId ?? data.pendingMenuItem?.conceptId ?? null,
    pendingMenuItem: data.pendingMenuItem,
    ingredients: data.ingredients,
  }

  return <RecipeForm initial={initial} />
}
