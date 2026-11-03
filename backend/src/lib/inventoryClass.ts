// THE one inventory class map (finance wave B, food cost on FIFO lots).
//
// Every stock item has a category; the category decides its COST CLASS, and
// the class decides which pair of ledger accounts its value moves through:
//
//   food       1210 Inventory – Food       / 5010 Food Cost
//   beverage   1220 Inventory – Beverage   / 5020 Beverage Cost   (shown as "Drinks")
//   packaging  1230 Inventory – Packaging  / 5030 Packaging Cost
//
// NON-FOOD (owner, 2026-11-03: "want to use this system for non food purposes.
// create other categories like packaging and non food"; "Expense on receipt"):
// category 'non_food' (cleaning, stationery, gas…) is NOT a cost class. Its
// lots and movements carry lot class 'non_food' (LotClass below), the item is
// always issue-on-receipt, and the goods receipt debits 6045 Operating Supplies
// (NON_FOOD_EXPENSE_CODE) instead of a 12x0 — so it never holds stock value,
// never reaches cost of sales / food cost / recipe costing. COST_CLASSES stays
// the three stock classes; every reader that sees a lot's class goes through
// `isNonFoodClass` / `lotClassOf` first (receipt posting, issue posting, bill
// price differences, cash buys, the food-cost report). costClassOf('non_food')
// is NEVER a valid answer for a write: writers call lotClassOf.
//
// Receipts, bills, sales, waste, counts, transfers and the food-cost report
// all read the class from here — never keep a second map (no
// lib/stockAccounts.ts). The category list is enforced by the inventory
// routes (`z.enum(INVENTORY_CATEGORIES)`); migration 20261014090000 moved the
// legacy free-text values onto it with the same rule as
// `normalizeInventoryCategory` below.

import { ACCT } from '../modules/accounting/journal.js'

export const INVENTORY_CATEGORIES = [
  'protein', 'produce', 'dairy', 'dry_goods', 'sauce', 'beverage', 'packaging', 'other',
  // Added 2026-10-30 (owner: "spices, sweetener.. etc") — all food class.
  'spices', 'sweetener', 'oil_fat', 'flour_grain', 'bakery', 'frozen',
  // Added 2026-11-03 (owner): expensed on receipt — see the header.
  'non_food',
] as const
export type InventoryCategory = typeof INVENTORY_CATEGORIES[number]

export type CostClass = 'food' | 'beverage' | 'packaging'
export const COST_CLASSES: readonly CostClass[] = ['food', 'beverage', 'packaging'] as const

/**
 * A free-text category onto the list (the migration's rule): lower-case,
 * trimmed, '-' / ' ' → '_'; drink / drinks / beverages / bev → beverage;
 * packing → packaging; anything else → other. Null / blank stays null.
 */
export function normalizeInventoryCategory(raw: string | null | undefined): InventoryCategory | null {
  if (raw == null) return null
  const c = raw.trim().toLowerCase().replace(/[-\s]/g, '_')
  if (c === '') return null
  if ((INVENTORY_CATEGORIES as readonly string[]).includes(c)) return c as InventoryCategory
  if (c === 'drink' || c === 'drinks' || c === 'beverages' || c === 'bev') return 'beverage'
  if (c === 'packing') return 'packaging'
  if (c === 'spice') return 'spices'
  if (c === 'sweeteners' || c === 'sugar') return 'sweetener'
  if (c === 'nonfood' || c === 'non_foods' || c === 'non_food_supplies') return 'non_food'
  return 'other'
}

/**
 * The cost class of an item's category: beverage → beverage, packaging → packaging, anything else (or none) → food.
 * A NON-FOOD item has no cost class (see the header): writers use lotClassOf, readers skip non_food first. Answers
 * 'food' for it only so a read-only total keeps its shape — a non-food item never holds stock value.
 */
export function costClassOf(category: string | null | undefined): CostClass {
  const c = normalizeInventoryCategory(category)
  if (c === 'beverage') return 'beverage'
  if (c === 'packaging') return 'packaging'
  return 'food'
}

/** The lot class stored on a non-food item's lots and movements (stock_lots_class_chk / stock_movements_class_chk). */
export const NON_FOOD_CLASS = 'non_food' as const
/** What a lot / movement class column may hold: a stock cost class, or non-food (expensed on receipt). */
export type LotClass = CostClass | typeof NON_FOOD_CLASS

/** 6045 Operating Supplies (Non-food) — where a non-food receipt (and its later price differences) is expensed. */
export const NON_FOOD_EXPENSE_CODE = ACCT.OPERATING_SUPPLIES

/** True for the non-food category (expensed on receipt). */
export function isNonFoodCategory(category: string | null | undefined): boolean {
  return normalizeInventoryCategory(category) === 'non_food'
}

/** True for a lot / movement class of a non-food item. */
export function isNonFoodClass(v: string | null | undefined): boolean {
  return v === NON_FOOD_CLASS
}

/** The class a NEW lot / movement of an item carries: 'non_food' for a non-food item, else its cost class. */
export function lotClassOf(category: string | null | undefined): LotClass {
  return isNonFoodCategory(category) ? NON_FOOD_CLASS : costClassOf(category)
}

/** Inventory (balance sheet) and cost-of-sales (P&L) code of each class, in the company's own chart. */
export const CLASS_ACCOUNTS: Readonly<Record<CostClass, { inv: string; cogs: string }>> = {
  food:      { inv: ACCT.INVENTORY_FOOD,      cogs: ACCT.FOOD_COST },
  beverage:  { inv: ACCT.INVENTORY_BEVERAGE,  cogs: ACCT.BEVERAGE_COST },
  packaging: { inv: ACCT.INVENTORY_PACKAGING, cogs: ACCT.PACKAGING_COST },
}

/** What staff read: the food-cost report splits food / drinks / packaging. */
export const CLASS_LABEL: Readonly<Record<CostClass, string>> = {
  food: 'Food',
  beverage: 'Drinks',
  packaging: 'Packaging',
}

/** A zero amount per class — the starting point of every per-class total. */
export function zeroByClass(): Record<CostClass, number> {
  return { food: 0, beverage: 0, packaging: 0 }
}
