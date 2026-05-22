'use client'
import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { RecipeForm } from '../RecipeForm'

function NewRecipeInner() {
  // The Menu Editor's "Add via Recipe" link passes brandId + categoryId so
  // the form pre-selects them. Falling back to empty strings is fine —
  // the operator picks them manually in that case.
  const params = useSearchParams()
  return (
    <RecipeForm
      prefillBrandId={params?.get('brandId') ?? undefined}
      prefillCategoryId={params?.get('categoryId') ?? undefined}
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
