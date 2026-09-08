// Ingredient cost normalisation — shared by the recipe costing screens and the
// accounting journal so a plate never costs one number on the Recipe page and a
// different one in the ledger.
//
// `InventoryItem.unitCostCents` is the price of ONE purchase unit, but recipe
// quantities are always in the measure unit (grams / millilitres / pieces). For
// an item bought by the kilo or the litre those differ by 1000×: 200 g of flour
// at PKR 300/kg is PKR 60, not PKR 60,000. Every place that multiplies a cost by
// a recipe quantity must go through this.

export function costPerMeasureCents(unit: string | null | undefined, unitCostCents: number | null | undefined): number {
  const u = (unit ?? '').toLowerCase()
  const c = unitCostCents ?? 0
  return (u === 'kg' || u === 'litres' || u === 'l') ? c / 1000 : c
}
