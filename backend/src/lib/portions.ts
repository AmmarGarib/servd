// Portions of a prep (sub-recipe) — kitchen flow, owner 2026-10-26 (K5 + amendment: "Portions per recipe").
//
// A sub-recipe stores how many portions ONE batch makes (Recipe.portionsPerBatch). Its portion size is DERIVED:
// batch yield (Recipe.yieldGrams, counted in Recipe.yieldUnit g / ml / pcs) ÷ portions per batch. The par board, the
// prep list and a prep batch logged in portions all read it from here — never a stored size.

export interface PortionRecipe { yieldGrams: number | null; portionsPerBatch: number | null }

/** One portion in the recipe's yield unit, or null when the batch yield or the portions are not set. */
export function portionSizeOf(r: PortionRecipe): number | null {
  if (!r.yieldGrams || r.yieldGrams <= 0 || !r.portionsPerBatch || r.portionsPerBatch < 1) return null
  return r.yieldGrams / r.portionsPerBatch
}

/** A quantity in the yield unit as portions (null without a portion size). */
export function toPortions(qty: number, r: PortionRecipe): number | null {
  const size = portionSizeOf(r)
  return size ? qty / size : null
}
