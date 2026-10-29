// Shared bits of the stock pages (Inventory, Count, Prep, Receiving,
// Procurement bills, Received-not-billed): the item categories with the stock
// account each one lands in, and the API's error codes in plain words.
//
// The category list mirrors backend/src/lib/inventoryClass.ts
// (INVENTORY_CATEGORIES + costClassOf + CLASS_ACCOUNTS): the server refuses a
// category outside it (400), and the category decides the item's cost class —
// Drinks (beverage) = 1220 / 5020, Packaging = 1230 / 5030, everything else
// food = 1210 / 5010. Keep it in step with that file.

import { ApiError } from './api'

export interface CategoryOption {
  value: string
  label: string
  /** Where the value of this category's stock sits on the balance sheet. */
  stock: string
}

const FOOD = '1210 Inventory – Food'
const DRINKS = '1220 Inventory – Beverage'
const PACKAGING = '1230 Inventory – Packaging'

export const INVENTORY_CATEGORY_OPTIONS: readonly CategoryOption[] = [
  { value: 'protein',   label: 'Protein',     stock: FOOD },
  { value: 'produce',   label: 'Produce',     stock: FOOD },
  { value: 'dairy',     label: 'Dairy',       stock: FOOD },
  { value: 'dry_goods', label: 'Dry goods',   stock: FOOD },
  { value: 'sauce',     label: 'Sauces',      stock: FOOD },
  { value: 'beverage',  label: 'Drinks',      stock: DRINKS },
  { value: 'packaging', label: 'Packaging',   stock: PACKAGING },
  { value: 'other',     label: 'Other food',  stock: FOOD },
]

/** "Drinks — 1220 Inventory – Beverage": the select's option text. */
export const categoryOptionText = (o: CategoryOption) => `${o.label} — ${o.stock}`

/** The category value a stored (possibly legacy free-text) category stands for, or '' when none. */
export function categoryValueOf(raw: string | null | undefined): string {
  if (raw == null) return ''
  const c = raw.trim().toLowerCase().replace(/[-\s]/g, '_')
  if (c === '') return ''
  if (INVENTORY_CATEGORY_OPTIONS.some((o) => o.value === c)) return c
  if (c === 'drink' || c === 'drinks' || c === 'beverages' || c === 'bev') return 'beverage'
  if (c === 'packing') return 'packaging'
  return 'other'
}

/** Staff-facing name of a stored category ('Uncategorised' when none). */
export function categoryLabel(raw: string | null | undefined): string {
  const v = categoryValueOf(raw)
  return INVENTORY_CATEGORY_OPTIONS.find((o) => o.value === v)?.label ?? 'Uncategorised'
}

// The server's message names the item and the figures, so it always leads. For
// the codes below we add the next step in plain words after it.
const NEXT_STEP: Record<string, string> = {
  COST_FROM_DELIVERIES: 'Its cost changes when stock is received, not by typing a number.',
  OPENING_NOT_ALLOWED: 'Use a spot count for stock that is already on the books.',
  OPENING_COST_REQUIRED: 'Type the unit cost for this line.',
  OPENING_COUNT_ROLE: 'Ask finance, the CEO or management to record it.',
  COUNT_REASON_REQUIRED: 'Type the reason on that line (at least 3 characters). Differences then wait for the CEO.',
  ITEM_HAS_NO_COMPANY: 'Give it a company on Inventory first.',
  BRAND_NOT_IN_COMPANY: 'Pick a brand of the item’s own company.',
  LOCATION_NOT_IN_COMPANY: 'Pick one of this company’s outlets.',
  INSUFFICIENT_STOCK: 'Count or receive stock first, or lower the quantities.',
  SHORTFALL_REASON_REQUIRED: 'Say why it came up short (at least 3 characters).',
  STOCK_LINE_NEEDS_RECEIPT: 'Use “Fill from receipt” or “Fill from PO” on that line.',
  EXPENSE_ACCOUNT_REQUIRED: 'Pick the expense account on that line.',
  NOT_AN_EXPENSE_CODE: 'Pick an expense account (6xxx) from the list.',
  ACCOUNT_NOT_FOUND: 'Pick an expense account that is active in this supplier’s company.',
  USE_CAPEX: 'Equipment is bought through Finance → CapEx → Quick buy so it lands on the fixed-asset register.',
  OVERRIDE_NOT_ALLOWED: 'Ask finance or the CEO to record this bill, or buy it through CapEx → Quick buy.',
  OVERRIDE_REASON_REQUIRED: 'Say why it is not equipment (at least 10 characters).',
  AMOUNT_TOO_LARGE: 'Capital spend (fit-out, equipment) goes through CapEx, not a bill.',
  RECEIPT_WRITTEN_OFF: 'Correct it with a credit note instead.',
  NOTHING_OPEN: 'It may already be billed or written off — refresh the list.',
  WRITE_OFF_PENDING: 'The CEO will approve or reject it.',
  NO_WRITE_OFF_REQUEST: 'The request may already have been answered — refresh the list.',
  PERIOD_LOCKED: 'Use a date in an open month.',
  RECLASS_NOT_POSTED: 'Nothing was changed — the ledger did not book the move. Try again, or ask finance to check the books.',
  BAD_STATE: 'Someone else changed it meanwhile — reload it and try again.',
  NO_ACTIVE_COMPANY: 'Pick a company in the header first.',
  INGREDIENT_NOT_IN_COMPANY: 'Use a sub-recipe of this dish’s own company (sub-recipes are never shared across companies).',
  ITEM_NOT_IN_COMPANY: 'Use stock of the company whose dishes use this recipe.',
  // Stock by site, prep as stock (2026-10-24).
  LOCATION_REQUIRED: 'Pick the outlet whose stock this is.',
  TRANSFER_CROSS_COMPANY: 'Transfers move stock between outlets of one company only.',
  COUNTER_ORDERS_ITEM: 'Someone who did not order it counts this item.',
  RECIPE_NOT_APPROVED: 'Approve the dish’s recipe first, then switch it on.',
  PREP_UNIT_LOCKED: 'The prep is already kept in stock in this unit.',
}

/** The API's error in words: the server's message, then the next step for the codes above. */
export function stockErrorText(e: unknown, fallback = 'That did not work'): string {
  if (e instanceof ApiError) {
    const hint = NEXT_STEP[e.code]
    const msg = (e.message || fallback).trim()
    if (!hint || msg.includes(hint)) return msg
    return `${msg}${/[.!?]$/.test(msg) ? '' : '.'} ${hint}`
  }
  return e instanceof Error ? e.message || fallback : fallback
}

/** An API error's code, or '' for anything else. */
export const errorCode = (e: unknown): string => (e instanceof ApiError ? e.code : '')
