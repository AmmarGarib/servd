'use client'
import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { RecipeForm } from '../RecipeForm'

function NewRecipeInner() {
  // The Menu Editor's "Add via Recipe" link passes brandId + categoryId so
  // the form pre-selects them. Falling back to empty strings is fine —
  // the operator picks them manually in that case.
  // Configuration → Modifiers' "Ingredients" action passes the add-on chain
  // (brandId + menuItemId + groupId + modifierId) for a new add-on recipe.
  const params = useSearchParams()
  const modifierId = params?.get('modifierId')
  const menuItemId = params?.get('menuItemId')
  const groupId = params?.get('groupId')
  return (
    <RecipeForm
      prefillBrandId={params?.get('brandId') ?? undefined}
      prefillCategoryId={params?.get('categoryId') ?? undefined}
      prefillModifier={modifierId && menuItemId && groupId ? { modifierId, menuItemId, groupId } : undefined}
    />
  )
}

export default function NewRecipePage() {
  return (
    <Suspense fallback={<div className="p-12 text-center text-sm text-s-muted">Loading…</div>}>
      <NewRecipeInner />
    </Suspense>
  )
}
