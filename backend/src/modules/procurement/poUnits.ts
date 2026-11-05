// The unit a PO line is ORDERED in (owner, 2026-11-05: "give options to choose in Grams, KGs, MLs or other required
// UOM … and Rate per mentioned UOM").
//
// A line keeps its quantity and unit cost in the item's STOCK unit (quantityOrdered, unitCostCents — what receiving,
// stock lots, GRNI and bills read, unchanged), and beside them what was typed: orderUnit, orderUnitFactor (stock units
// per order unit) and orderUnitCostCents (the rate per order unit). The line's value is the typed one — order
// quantity × rate — never the rounded per-stock-unit cost × stock quantity, so 5 kg at PKR 1,234/kg is PKR 6,170 to
// the paisa even though PKR 1.234/g rounds. Receiving against the line values the lot the same exact way.
//
// Which units a line may be ordered in: the item's stock unit, any unit of the same family (g / kg / mg, ml / l, …
// — lib/recipeCost.ts toPurchaseUnits, the one conversion table), and the item's own buying unit (purchaseUnit, e.g.
// "bag" = 25,000 g) with its factor. The factor is always the SERVER's, never the client's.
import { AppError } from '../../lib/errors.js'
import { toPurchaseUnits } from '../../lib/recipeCost.js'

export interface UnitItem { name: string; unit: string; purchaseUnit: string | null; purchaseUnitFactor: number }

const norm = (u: string | null | undefined) => (u ?? '').trim().toLowerCase()

/** Stock units in one `orderUnit` of this item, or null when the unit cannot be converted. */
export function orderUnitFactor(item: UnitItem, orderUnit: string): number | null {
  const u = norm(orderUnit)
  if (!u) return null
  if (u === norm(item.unit)) return 1
  if (item.purchaseUnit && u === norm(item.purchaseUnit) && item.purchaseUnitFactor > 0) return item.purchaseUnitFactor
  const f = toPurchaseUnits(1, u, item.unit)
  return f != null && f > 0 ? f : null
}

/** The units offered for an item (stock unit first). */
export function orderUnitsFor(item: UnitItem): Array<{ unit: string; factor: number }> {
  const out: Array<{ unit: string; factor: number }> = [{ unit: item.unit, factor: 1 }]
  const family: Record<string, string[]> = { g: ['kg', 'mg'], kg: ['g'], mg: ['g', 'kg'], ml: ['l'], l: ['ml'], ltr: ['ml', 'l'], litre: ['ml'], liter: ['ml'], pcs: ['dozen'] }
  for (const u of family[norm(item.unit)] ?? []) {
    const f = orderUnitFactor(item, u)
    if (f != null && !out.some((o) => norm(o.unit) === u)) out.push({ unit: u, factor: f })
  }
  if (item.purchaseUnit && item.purchaseUnitFactor > 0 && !out.some((o) => norm(o.unit) === norm(item.purchaseUnit))) {
    out.push({ unit: item.purchaseUnit, factor: item.purchaseUnitFactor })
  }
  return out
}

export interface TypedLine {
  inventoryItemId: string; notes?: string | null
  quantityOrdered?: number; unitCostCents?: number
  orderUnit?: string | null; orderQuantity?: number; orderUnitCostCents?: number
}
export interface StoredLine {
  inventoryItemId: string; notes: string | null; quantityOrdered: number; unitCostCents: number
  orderUnit: string | null; orderUnitFactor: number; orderUnitCostCents: number | null
}

/** A typed line → what is stored (stock-unit quantity and cost + the order unit as typed). */
export function storedLine(item: UnitItem, l: TypedLine, index: number): StoredLine {
  if (l.orderUnit && norm(l.orderUnit) !== norm(item.unit)) {
    const factor = orderUnitFactor(item, l.orderUnit)
    if (factor == null) {
      throw new AppError('UNIT_MISMATCH', `Line ${index + 1}: ${item.name} is kept in ${item.unit} — ${l.orderUnit} cannot be converted to it`, 422)
    }
    const qty = l.orderQuantity
    const rate = l.orderUnitCostCents
    if (qty == null || !(qty > 0) || !Number.isFinite(qty)) throw new AppError('INVALID_QUANTITY', `Line ${index + 1}: enter the quantity in ${l.orderUnit}`, 400)
    if (rate == null || !Number.isInteger(rate) || rate < 0) throw new AppError('INVALID_AMOUNT', `Line ${index + 1}: enter the rate per ${l.orderUnit}`, 400)
    return {
      inventoryItemId: l.inventoryItemId, notes: l.notes ?? null,
      quantityOrdered: Math.round(qty * factor * 1e6) / 1e6, unitCostCents: Math.round(rate / factor),
      orderUnit: l.orderUnit.trim(), orderUnitFactor: factor, orderUnitCostCents: rate,
    }
  }
  // In the stock unit: the old shape (quantityOrdered / unitCostCents), or orderQuantity / orderUnitCostCents.
  const qty = l.orderUnit ? l.orderQuantity : l.quantityOrdered ?? l.orderQuantity
  const rate = l.orderUnit ? l.orderUnitCostCents : l.unitCostCents ?? l.orderUnitCostCents
  if (qty == null || !(qty > 0) || !Number.isFinite(qty)) throw new AppError('INVALID_QUANTITY', `Line ${index + 1}: enter the quantity`, 400)
  if (rate == null || !Number.isInteger(rate) || rate < 0) throw new AppError('INVALID_AMOUNT', `Line ${index + 1}: enter the rate`, 400)
  return { inventoryItemId: l.inventoryItemId, notes: l.notes ?? null, quantityOrdered: qty, unitCostCents: rate, orderUnit: null, orderUnitFactor: 1, orderUnitCostCents: null }
}

/** A line's value in paisa: the typed quantity × rate when ordered in another unit, else stock quantity × unit cost. */
export function lineValueCents(l: { quantityOrdered: number; unitCostCents: number; orderUnitFactor?: number | null; orderUnitCostCents?: number | null }): number {
  if (l.orderUnitCostCents != null && l.orderUnitFactor && l.orderUnitFactor > 0) return Math.round((l.quantityOrdered / l.orderUnitFactor) * l.orderUnitCostCents)
  return Math.round(l.quantityOrdered * l.unitCostCents)
}

/** How a line reads: "5 kg @ PKR 1,700.00/kg" in the unit it was ordered in. */
export function lineDisplay(l: { quantityOrdered: number; unitCostCents: number; orderUnit?: string | null; orderUnitFactor?: number | null; orderUnitCostCents?: number | null }, stockUnit: string) {
  const ordered = l.orderUnit && l.orderUnitCostCents != null && l.orderUnitFactor && l.orderUnitFactor > 0
  return {
    quantity: ordered ? Math.round((l.quantityOrdered / l.orderUnitFactor!) * 1e6) / 1e6 : l.quantityOrdered,
    unit: ordered ? l.orderUnit! : stockUnit,
    rateCents: ordered ? l.orderUnitCostCents! : l.unitCostCents,
  }
}
