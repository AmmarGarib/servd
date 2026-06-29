'use client'
import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { api } from '../../../../lib/api'
import { RecipeForm, type RecipeFormInitial } from '../RecipeForm'

interface ExistingRecipe {
  id: string
  kind: 'plate' | 'component'
  status: 'iteration' | 'pending_approval' | 'production'
  rejectionReason: string | null
  name: string | null
  menuItemId: string | null
  servings: number
  yieldGrams: number | null
  category: string | null
  photoUrl: string | null
  steps: string | null
  qFactorPct: number
  targetProfitPct: number
  packagingPct: number
  actualSellingPriceCents: number | null
  menuItem: { conceptId: string | null } | null
  ingredients: Array<{
    id: string
    inventoryItemId: string | null
    quantity: number
    yieldPct: number | null
  }>
}

export default function EditRecipePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { data, isLoading, isError } = useQuery<ExistingRecipe>({
    queryKey: ['recipe', id],
    queryFn: () => api.get(`/recipes/${id}`),
  })

  if (isLoading) {
    return <div className="p-12 text-center text-sm text-s-muted">Loading recipe…</div>
  }
  if (isError || !data) {
    return (
      <div className="p-12 text-center">
        <p className="text-sm text-s-muted">Couldn't load that recipe.</p>
        <button onClick={() => router.push('/accounting/recipes')}
          className="mt-3 rounded-lg bg-s-teal text-black px-4 py-2 text-xs font-black">Back to list</button>
      </div>
    )
  }

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
    qFactorPct: data.qFactorPct,
    targetProfitPct: data.targetProfitPct,
    packagingPct: data.packagingPct,
    actualSellingPriceCents: data.actualSellingPriceCents,
    brandId: data.menuItem?.conceptId ?? null,
    ingredients: data.ingredients,
  }

  return <RecipeForm initial={initial} />
}
