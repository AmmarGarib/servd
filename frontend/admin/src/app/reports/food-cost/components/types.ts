// The shapes GET /reports/food-cost/* answer (backend reports/foodCost.ts —
// the ONE food-cost engine). Revenue and every % arrive only for the finance
// tier; everyone else gets `revenueHidden: true` and those fields are absent.

export type FoodCostStatus = 'no_data' | 'incomplete' | 'good' | 'warning' | 'critical'

export interface ClassCents { foodCents: number; drinksCents: number; packagingCents: number; totalCents: number }
export interface MeasuredAllocated { measuredCents: number; allocatedCents: number; totalCents: number }

export type WasteReason =
  | 'spoilage' | 'over_prep' | 'expired' | 'damaged' | 'other' | 'void_after_fire' | 'cancelled_after_fire' | 'returned_food' | 'transit_loss' | 'remake'

export interface Buckets {
  comps: ClassCents
  staffMeals: ClassCents
  waste: { byReason: Record<WasteReason, MeasuredAllocated>; total: MeasuredAllocated }
  prepDraws: MeasuredAllocated
  issueOnReceipt: MeasuredAllocated
  shortfallSettles: MeasuredAllocated
  priceAdjustments: number
  countVariance: MeasuredAllocated
  notOnBooks: number
  otherEntries: number
}

export interface Timing { salesCents: number; stockDocsCents: number; totalCents: number }

export interface McRow {
  fulfilmentType: 'dine_in' | 'takeout' | 'delivery'
  label: string
  orders: number
  targetMcCents: number
  actualMc: ClassCents
  itemSalesCents?: number
  targetMcPct?: number | null
  actualMcPct?: number | null
}

export interface Warning {
  code: string
  severity: 'incomplete' | 'warn' | 'timing'
  message: string
  count: number
  names?: string[]
  link?: string
}

export interface BrandBlock {
  conceptId: string | null
  name: string
  serviceVessel: string | null
  status: FoodCostStatus
  statusLabel: string
  revenueCents?: number
  targetPct?: number | null
  theoreticalPct?: number | null
  actualPct?: number | null
  avtPoints?: number | null
  theoretical: ClassCents
  actual: ClassCents | null
  buckets: Buckets
  explainedCents: number
  unexplainedCents: number
  alignmentCents: number
  timing: Timing | null
  qAllowanceCents: number
  mcByOrderType: McRow[]
  identityDiffCents: number | null
}

export interface ItemRow {
  menuItemId: string
  name: string
  conceptId: string
  qtySold: number
  hasRecipe: boolean
  costCents: number
  revenueCents?: number
  costPct?: number | null
  targetPct?: number | null
}

export interface CompanyBlock extends Omit<BrandBlock, 'conceptId' | 'name' | 'serviceVessel'> {
  tenantId: string
  companyName: string
  period: { from: string; to: string }
  revenueHidden: boolean
  cutoverAt: string | null
  conceptId: string | null
  locationId: string | null
  allowance: { qFactorCents: number; label: string }
  alignment: { preFifoOrdersCents: number; alignedAt: string | null; label: string }
  brands: BrandBlock[]
  items: ItemRow[]
  warnings: Warning[]
  openOrders: number
  openShifts: number
}

export interface SummaryResponse {
  period: { from: string; to: string; fromDate: string; toDate: string }
  revenueHidden: boolean
  wasteReasons: Array<{ key: WasteReason; label: string }>
  companies: CompanyBlock[]
}

export interface QtyCents { qty: number; cents: number }

export interface IngredientRow {
  inventoryItemId: string
  name: string
  unit: string
  costClass: 'food' | 'beverage' | 'packaging'
  classLabel: string
  opening: QtyCents
  received: QtyCents
  theoretical: QtyCents
  comps: QtyCents
  staffMeals: QtyCents
  waste: QtyCents
  wasteByReason: Partial<Record<WasteReason, QtyCents>>
  prep: QtyCents
  issueOnReceipt: QtyCents
  count: QtyCents
  shortfall: QtyCents
  settled: QtyCents
  other: QtyCents
  closing: QtyCents
  unexplained: QtyCents
  flags: { noCost: boolean; notOnAnyRecipe: boolean; shortfall: boolean; notCountedInPeriod: boolean }
}

export interface IngredientsResponse { tenantId: string; revenueHidden: boolean; rows: IngredientRow[] }

export interface MovementsResponse {
  item: { id: string; name: string; unit: string; classLabel: string; currentStock: number; unitCostCents: number | null }
  lots: Array<{ id: string; sourceType: string; receivedAt: string; qtyIn: number; remainingQty: number; unitCostCents: number; valueInCents: number; remainingValueCents: number }>
  movements: Array<{
    id: string; kind: string; lotId: string | null; qty: number; valueCents: number; unitCostCents: number; shortfallQty: number | null
    conceptId: string | null; orderId: string | null; sourceType: string; occurredAt: string; allocated: boolean
  }>
}

export interface ValuationResponse {
  tenantId: string
  asOf: string
  classes: Array<{ costClass: string; label: string; glCode: string; lotsCents: number; glCents: number; issuedNotBookedCents: number; preFifoDiffCents: number; unreconciledCents: number }>
  totals: { lotsCents: number; glCents: number; issuedNotBookedCents: number; preFifoDiffCents: number; unreconciledCents: number }
  ties: boolean
  failedPostings: { count: number; cents: number; rows: Array<{ id: string; title: string; amountCents: number | null; createdAt: string; sourceType: string | null }> }
  stockDifferencesSuspenseCents: number
  cutover: {
    at: string | null
    preFifoDiff: Record<string, number> | null
    aligned: boolean
    alignedAt: string | null
    catchupRefused: Array<Record<string, unknown>>
    untied: { bills: unknown[]; receiptLines: unknown[]; billedAhead: unknown[] } | null
  }
  grni: {
    glCode: string; glCreditCents: number; openReceiptCents: number; openReceiptLines: number; staleLines: number; staleCents: number
    pendingMatchCents: number; expectedCents: number; differenceCents: number
  }
}

export interface FlagRow {
  id: string; kind: string; severity: string; title: string; description: string; entityType: string | null; entityId: string | null
  conceptId: string | null; amountCents: number | null; status: string; createdAt: string; link: string
}
